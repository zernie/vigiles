/**
 * DRIFT TEST for the always-loaded context on Codex: the skill-listing entries
 * `codexSkillListing` renders must appear in the first request real `codex`
 * sends to the scripted Responses mock, and the skills it refuses must not
 * (harness tier: no key, no cost; skipped where `codex` is absent, installed
 * in CI). The Claude Code twin is
 * `src/adapters/claude-code/skill-listing-delivery.test.ts`.
 *
 * The LOCATOR is the one part compared loosely: Codex prints either the
 * absolute path or an alias (`r1/<path under the skills folder>`), whichever
 * renders cheaper on that machine, and the entry deliberately writes the
 * repo-relative path instead (see `skill-listing.ts`). Everything before
 * `(file: ` must match exactly, and the path must end in the skill's path under
 * the folder.
 *
 * Reads the raw request body through `startCodexMock`'s `onBody`, because the
 * mock's parsed request keeps only the user prompt and Codex sends the listing
 * in its developer instructions.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { sessionSkills } from "../../core/always-loaded.js";
import { skillsHome } from "../../core/layout.js";
import { codexLayout } from "./layout.js";
import { startCodexMock } from "./mock-model.js";
import { codexMockArgs, codexMockEnv } from "./runtime.js";
import { codexSkillListing } from "./skill-listing.js";

const codexAvailable = (): boolean => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const maybe = codexAvailable() ? test : test.skip;

const skill = (fm: string): string => `---\n${fm}\n---\nbody`;

/** Listed: each rendering rule. Not listed: each refusal. */
const FILES: Record<string, string> = {
  ".agents/skills/plain/SKILL.md": skill(
    "name: plain\ndescription: Run <cmd> now",
  ),
  ".agents/skills/multi/SKILL.md": skill(
    "name: multi\ndescription: |\n  line one\n  line   two",
  ),
  ".agents/skills/emoji/SKILL.md": skill(
    `name: emoji\ndescription: ${"😀".repeat(1100)}`,
  ),
  ".agents/skills/group/nested/SKILL.md": skill(
    "name: nested\ndescription: Nested one",
  ),
  ".agents/skills/a/b/c/d/e/f/SKILL.md": skill(
    "name: deepsix\ndescription: six down",
  ),
  ".agents/skills/nofm/SKILL.md": "just a body",
  ".agents/skills/nodesc/SKILL.md": skill("name: nodesc"),
  ".agents/skills/longname/SKILL.md": skill(
    `name: ${"n".repeat(65)}\ndescription: too long`,
  ),
  ".agents/skills/.hidden/h/SKILL.md": skill("name: hid\ndescription: hidden"),
  ".agents/skills/a/b/c/d/e/f/g/SKILL.md": skill(
    "name: deepseven\ndescription: seven down",
  ),
};
const REFUSED = ["nofm", "nodesc", "n".repeat(65), "hid", "deepseven"];

/** Every string in a parsed JSON value, depth first. */
const strings = (v: unknown): readonly string[] => {
  if (typeof v === "string") return [v];
  if (typeof v !== "object" || v === null) return [];
  return Object.values(v).flatMap(strings);
};

/** Run real codex once in `cwd` and return the raw request bodies. */
async function requestBodies(cwd: string): Promise<readonly string[]> {
  const bodies: string[] = [];
  const mock = await startCodexMock([{ text: "done" }], {
    onBody: (b) => bodies.push(b),
  });
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  const devnull = openSync("/dev/null", "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--ephemeral",
          "--dangerously-bypass-approvals-and-sandbox",
          ...codexMockArgs(mock.url),
          "-c",
          'model="gpt-5-codex"',
          "hi",
        ],
        {
          cwd,
          stdio: [devnull, "ignore", "ignore"],
          env: { ...process.env, ...codexMockEnv(), CODEX_HOME: codexHome },
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("codex timed out"));
      }, 60_000);
      child.on("error", reject);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return bodies;
  } finally {
    closeSync(devnull);
    await mock.close();
    rmSync(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

describe("Codex skill listing, as the binary sends it", () => {
  maybe(
    "lists every rendered entry, and none of the skills Codex refuses",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "codex-listing-"));
      for (const [rel, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(cwd, rel)), { recursive: true });
        writeFileSync(join(cwd, rel), text);
      }
      try {
        const bodies = await requestBodies(cwd);
        const lines = strings(JSON.parse(bodies[0] ?? "null")).flatMap((s) =>
          s.split("\n"),
        );
        const home = skillsHome(codexLayout) ?? "";
        const rendered = sessionSkills(codexLayout, FILES).flatMap((s) => {
          const entry = codexSkillListing.entry(s, {});
          return entry === null ? [] : [{ path: s.path, entry }];
        });
        expect(rendered).toHaveLength(5);
        for (const { path, entry } of rendered) {
          const head = entry.slice(0, entry.lastIndexOf(" (file: ") + 8);
          const tail = `${path.slice(home.length + 1)})`;
          expect(
            lines.some((l) => l.startsWith(head) && l.endsWith(tail)),
            entry,
          ).toBe(true);
        }
        for (const name of REFUSED) {
          expect(
            lines.some((l) => l.startsWith(`- ${name}:`)),
            name,
          ).toBe(false);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
