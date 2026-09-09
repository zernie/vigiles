/**
 * Every code snippet on the website must import names that REALLY EXIST.
 *
 * The snippets are hand-written strings inside .tsx files. Nothing type-checks a
 * string, so a snippet can name an export that was renamed or never existed and
 * every gate stays green — the reader copies it and gets a crash. That is the exact
 * defect class this product sells against, on the page selling it.
 *
 * MEASURED 2026-09-09, which is why this test exists: the eval snippet shipped as
 * `import { defineEval, skillResolved } from "vigiles/eval"`. Neither name is
 * exported from that entry point. Build, lint, prettier, the browser suite and the
 * e2e suite were all green.
 *
 * It resolves each name against the REAL BUILT PACKAGE via its `exports` map, so a
 * renamed export fails here rather than in a reader's terminal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SITE = resolve(ROOT, "site/src");

/** `exports` maps a subpath to the built file the runtime would load. */
const entryFile = (spec: string): string | null => {
  const pkg = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, unknown> };
  const key = spec === "vigiles" ? "." : `./${spec.slice("vigiles/".length)}`;
  const e = pkg.exports[key];
  const rel = typeof e === "string" ? e : (e as { default?: string })?.default;
  return rel ? resolve(ROOT, rel) : null;
};

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = resolve(dir, n);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

/** `import { a, b } from "vigiles…"` as it appears INSIDE a snippet string. */
const IMPORT =
  /import\s*\{([^}]+)\}\s*from\s*\\?["'](vigiles(?:\/[a-z-]+)?)\\?["']/g;

interface Claim {
  file: string;
  spec: string;
  name: string;
}
const claims: Claim[] = [];
for (const file of tsxFiles(SITE)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT)) {
    for (const raw of m[1].split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name)
        claims.push({ file: file.slice(ROOT.length + 1), spec: m[2], name });
    }
  }
}

describe("website code snippets", () => {
  it("import at least one name (the scanner still matches)", () => {
    // Guards the regex itself: if a refactor makes it match nothing, the suite
    // would pass vacuously and stop protecting anything.
    expect(claims.length).toBeGreaterThan(0);
  });

  it.each(claims.map((c) => [`${c.spec} → ${c.name} (${c.file})`, c] as const))(
    "%s is really exported",
    (_label, claim) => {
      const file = entryFile(claim.spec);
      expect(
        file,
        `"${claim.spec}" is not a declared entry point`,
      ).toBeTruthy();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file as string) as Record<string, unknown>;
      expect(
        typeof mod[claim.name],
        `The site shows \`import { ${claim.name} } from "${claim.spec}"\`, but that entry point does not export it. Fix the snippet in ${claim.file}, or the export.`,
      ).not.toBe("undefined");
    },
  );
});
