/**
 * Rule render policy (#355) — a rule stays whole in the SPEC, where lint,
 * coverage and audit read it, and is rendered SHORT in the always-loaded file.
 *
 * Before this, the only way to pay less for a rule in every request was to
 * delete it from the spec, which also removed it from everything vigiles can
 * check. The render policy separates the two: the model of the rule is
 * unchanged; only its markdown is shorter, and the long text lives in a file
 * whose existence `compile` verifies like any other `file()` reference.
 *
 * Deterministic, offline → the free unit tier. Both halves: the short forms
 * render what they promise, and the default (`full`) renders byte-for-byte what
 * it always did.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compileClaude, verifyHash } from "./compile.js";
import { enforce, file, guidance, instructionFile } from "./spec.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";

const WHY =
  "Use the structured logger. Console output is lost in CI and nobody reads it there.";

/**
 * `verifyLinters: false` keeps these tests offline; an unverified `enforce()`
 * renders "**Claimed (unverified):**" (#351), so that is the marker asserted.
 * What these tests pin is the Why line and the details link, not the marker.
 */
const compileIn = async (
  base: string,
  rules: Parameters<typeof instructionFile>[0]["rules"],
) =>
  await compileClaude(instructionFile({ rules }), {
    basePath: base,
    specFile: "CLAUDE.md.spec.ts",
    verifyLinters: false,
  });

/** The finding types, outside the test's own callbacks. */
const types = (errors: readonly { type: string }[]) =>
  errors.map((e) => e.type);

const withDocs = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "docs", "rules"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "rules", "logging.md"),
      '# Logging\n\n## Why not console\n\nThe long text.\n\n<a id="ci-output"></a>\nMore.\n',
    );
    return await fn(dir);
  } finally {
    cleanupTmpDir(dir);
  }
};

describe("enforce() render policy", () => {
  it("full (the default) renders exactly what it always did", async () => {
    await withDocs(async (dir) => {
      const { markdown, errors } = await compileIn(dir, {
        logging: enforce("eslint/no-console", WHY),
      });
      expect(errors).toHaveLength(0);
      expect(markdown).toContain(
        "**Claimed (unverified):** `eslint/no-console`\n**Why:** " + WHY,
      );
    });
  });

  it("line renders the rule id and the first sentence of why", async () => {
    await withDocs(async (dir) => {
      const { markdown } = await compileIn(dir, {
        logging: enforce("eslint/no-console", WHY, { render: "line" }),
      });
      expect(markdown).toContain(
        "**Claimed (unverified):** `eslint/no-console`",
      );
      expect(markdown).toContain("**Why:** Use the structured logger.");
      expect(markdown).not.toContain("nobody reads it");
    });
  });

  it("id renders only the rule id — the linter already holds the rule", async () => {
    await withDocs(async (dir) => {
      const { markdown } = await compileIn(dir, {
        logging: enforce("eslint/no-console", WHY, { render: "id" }),
      });
      expect(markdown).toContain(
        "### Logging\n\n**Claimed (unverified):** `eslint/no-console`",
      );
      expect(markdown).not.toContain("**Why:**");
      expect(markdown).not.toContain("structured logger");
    });
  });

  it("a short form with details links to the long text", async () => {
    await withDocs(async (dir) => {
      const { markdown, errors } = await compileIn(dir, {
        logging: enforce("eslint/no-console", WHY, {
          render: "id",
          details: file("docs/rules/logging.md"),
          anchor: "why-not-console",
        }),
      });
      expect(errors).toHaveLength(0);
      expect(markdown).toContain(
        "[Details](docs/rules/logging.md#why-not-console)",
      );
    });
  });
});

describe("guidance() details", () => {
  it("renders the statement and a link to the details", async () => {
    await withDocs(async (dir) => {
      const { markdown, errors } = await compileIn(dir, {
        "short-rule": guidance("Short statement of the rule.", {
          details: file("docs/rules/logging.md"),
        }),
      });
      expect(errors).toHaveLength(0);
      expect(markdown).toContain(
        "**Guidance only** — Short statement of the rule. [Details](docs/rules/logging.md)",
      );
    });
  });

  it("accepts an explicit <a id> anchor as well as a heading slug", async () => {
    await withDocs(async (dir) => {
      const { errors } = await compileIn(dir, {
        "short-rule": guidance("Short.", {
          details: file("docs/rules/logging.md"),
          anchor: "ci-output",
        }),
      });
      expect(errors).toHaveLength(0);
    });
  });
});

describe("details links are verified like any file() reference", () => {
  it("a details file that does not exist is a compile error", async () => {
    await withDocs(async (dir) => {
      const { errors } = await compileIn(dir, {
        "short-rule": guidance("Short.", {
          details: file("docs/rules/never-written.md"),
        }),
      });
      expect(types(errors)).toEqual(["stale-file"]);
      expect(errors[0].message).toContain("never-written.md");
    });
  });

  it("an anchor the details file does not define is a compile error", async () => {
    await withDocs(async (dir) => {
      const { errors } = await compileIn(dir, {
        "short-rule": guidance("Short.", {
          details: file("docs/rules/logging.md"),
          anchor: "no-such-section",
        }),
      });
      expect(types(errors)).toEqual(["stale-ref"]);
      expect(errors[0].message).toContain("no-such-section");
    });
  });

  it("the integrity hash covers the RENDERED text, so it stays a function of what the model sees", async () => {
    await withDocs(async (dir) => {
      const { markdown } = await compileIn(dir, {
        "short-rule": guidance("Short.", {
          details: file("docs/rules/logging.md"),
        }),
      });
      expect(verifyHash(markdown)?.valid).toBe(true);
      expect(verifyHash(markdown.replace("[Details]", "[More]"))?.valid).toBe(
        false,
      );
    });
  });
});

describe("render line: where the first sentence ends", () => {
  it("line does not end a sentence at a mark inside it", async () => {
    // Measured on this repo's own spec: "Use proper narrowing instead of !
    // assertions." rendered as "…instead of !" — a claim nobody wrote.
    await withDocs(async (dir) => {
      const { markdown } = await compileIn(dir, {
        bang: enforce(
          "eslint/no-console",
          "Use proper narrowing instead of ! assertions. The rest stays out.",
          { render: "line" },
        ),
        abbrev: enforce(
          "eslint/no-console",
          "Split it, e.g. into helpers. The rest stays out.",
          { render: "line" },
        ),
      });
      expect(markdown).toContain(
        "**Why:** Use proper narrowing instead of ! assertions.\n",
      );
      expect(markdown).toContain("**Why:** Split it, e.g. into helpers.\n");
      expect(markdown).not.toContain("The rest stays out");
    });
  });
});
