/**
 * Tests for the generator → SKILL.md compiler: parsing a generator's source and
 * rendering steps / gates / branches / loops to markdown, plus verifying the
 * gate references it carries.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  compileGenerator,
  compileGeneratorSkill,
} from "./compile-generator.js";
import { compileSkill } from "./compile.js";
import { experimental_skill } from "./spec.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { readFrontmatter, frontmatterScalar } from "./frontmatter-read.js";

const SRC = `
import { skill, act, checkpoint, finish, cmd } from "vigiles";
export default skill(function* () {
  yield act("Detect the project language");
  const lang = yield act("Classify the task");
  if (lang === "python") {
    yield checkpoint(cmd("pytest"));
  } else {
    yield checkpoint(cmd("npm test"));
  }
  for (const f of failures) {
    yield act("Fix the failing test");
  }
  yield finish(cmd("npm run build"));
});
`;

test("compileGenerator renders steps, gates, branches and loops to markdown", () => {
  const { markdown, errors } = compileGenerator(SRC, {
    basePath: process.cwd(),
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.match(markdown, /Detect the project language/);
  assert.ok(markdown.includes('### If lang === "python"'));
  assert.ok(markdown.includes("### Otherwise"));
  assert.ok(markdown.includes("### Repeat (for each item in failures)"));
  assert.match(markdown, /<!-- vigiles:gate "pytest" -->/);
  assert.match(markdown, /<!-- vigiles:gate "npm test" -->/);
  assert.match(markdown, /## Result/);
  assert.match(markdown, /<!-- vigiles:result "npm run build" -->/);
});

test("compileGenerator verifies gate references (catches a missing script)", () => {
  const bad = `
    import { skill, checkpoint, cmd } from "vigiles";
    export default skill(function* () {
      yield checkpoint(cmd("npm run does-not-exist"));
    });
  `;
  const { errors } = compileGenerator(bad, { basePath: process.cwd() });
  assert.ok(errors.some((e) => e.type === "stale-command"));
});

test("compileGenerator catches a missing file gate", () => {
  const bad = `
    import { skill, finish, file } from "vigiles";
    export default skill(function* () {
      yield finish(file("does/not/exist.txt"));
    });
  `;
  const { errors } = compileGenerator(bad, { basePath: process.cwd() });
  assert.ok(errors.some((e) => e.type === "stale-file"));
});

test("compileGenerator prepends frontmatter when provided", () => {
  const src = `
    import { skill, finish, cmd } from "vigiles";
    export default skill(function* () { yield finish(cmd("npm test")); });
  `;
  const { markdown } = compileGenerator(src, {
    basePath: process.cwd(),
    frontmatter: "---\nname: demo\n---",
  });
  assert.ok(markdown.startsWith("---\nname: demo\n---"));
  assert.match(markdown, /## Result/);
});

test("compileGenerator reports when there is no generator", () => {
  const { errors } = compileGenerator("export const x = 1;");
  assert.ok(errors.some((e) => /No generator/.test(e.message)));
});

const GEN_SKILL = `
import { genSkill, act, finish } from "vigiles/skill";
import { cmd } from "vigiles/spec";
export default genSkill(
  { name: "ship-pr", description: "Open a PR once tests pass", disableModelInvocation: true },
  function* () {
    yield act("Make the change");
    yield finish(cmd("npm test"));
  },
);
`;

test("compileGeneratorSkill renders frontmatter + body + integrity hash", () => {
  const { markdown, errors } = compileGeneratorSkill(GEN_SKILL, {
    basePath: process.cwd(),
    specFile: "skills/x/SKILL.md.spec.ts",
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  // Frontmatter first, stamp below it — and asserted through a READER, because the
  // defect this encodes was invisible to a text match: every field was still present
  // in the file, just no longer in a block any parser would recognise.
  assert.match(markdown, /^---\r?\n/);
  const fm = readFrontmatter(markdown);
  assert.notEqual(
    fm.block,
    null,
    "a frontmatter reader must find a block here",
  );
  assert.equal(frontmatterScalar(fm, "name"), "ship-pr");
  assert.match(markdown, /\n<!-- vigiles:sha256:[a-f0-9]+ compiled from/);
  assert.match(markdown, /name: ship-pr/);
  assert.match(markdown, /description: Open a PR once tests pass/);
  assert.match(markdown, /disable-model-invocation: true/);
  assert.match(markdown, /Make the change/);
  assert.match(markdown, /<!-- vigiles:result "npm test" -->/);
});

test("compileGeneratorSkill verifies gate refs and errors clearly without genSkill", () => {
  const bad = compileGeneratorSkill(
    GEN_SKILL.replace('cmd("npm test")', 'cmd("npm run nope")'),
    { basePath: process.cwd() },
  );
  assert.ok(bad.errors.some((e) => e.type === "stale-command"));

  const none = compileGeneratorSkill("export default 1;");
  assert.ok(none.errors.some((e) => /genSkill/.test(e.message)));
});

test("a skill can declare a disallowed-tools FENCE, and it uses the skill's key", async () => {
  const { markdown, errors } = await compileSkill(
    experimental_skill({
      name: "fenced",
      description: "Has a fence.",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash", "WebFetch"],
      body: "b",
    }),
    { specFile: "skills/fenced/SKILL.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  // 🔴 HYPHENATED. `disallowedTools:` is the SUBAGENT key, read by a different
  // parser; emitting it on a skill produces a key nothing looks at — inert, in the
  // direction that reads as protection. This assertion is the whole point of the
  // test, so it checks the exact bytes rather than a loose /disallowed/i.
  assert.match(markdown, /\ndisallowed-tools: \[Bash, WebFetch\]\n/);
  assert.doesNotMatch(markdown, /\ndisallowedTools:/);
  // The fence does not replace the allowlist — both are present, because they
  // answer different questions (pre-approval vs removal).
  assert.match(markdown, /\nallowed-tools: \[Read, Grep\]\n/);
});

test("a disallowed-tools entry that is a typo of a real tool is an ERROR, not a fence", async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "typo-fence",
      description: "Fence with a typo.",
      // "Wrte" removes nothing: the real tool is still callable while the file
      // reads as though Write were blocked.
      disallowedTools: ["Wrte"],
      body: "b",
    }),
    {
      specFile: "skills/typo-fence/SKILL.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  assert.ok(
    errors.some((e) => /Wrte/.test(e.message) && /Write/.test(e.message)),
    `expected a typo report naming both the typo and the real tool, got ${JSON.stringify(errors)}`,
  );
});

// ── frontmatter scalars must survive YAML, and only be quoted when they must ──
// Both halves matter and for different reasons. If quoting never fires, `compile`
// keeps emitting frontmatter that `frontmatter-valid` then reports — the blessed
// path producing the defect the product hunts for. If quoting fires when it is not
// needed, every already-compiled file changes bytes and every integrity hash moves,
// which reads to users as "vigiles rewrote my whole repo".
test("compile quotes a description YAML would otherwise mis-read", async () => {
  // The real shape that broke two shipped skills: a colon-space inside prose.
  const withColon =
    "Узнать, сколько берут за услугу — ловит ошибки, где замер врёт: неаналоги в выборке.";
  const { markdown } = await compileSkill({
    name: "benchmark-price",
    description: withColon,
    tools: ["Read", "WebSearch"],
    body: "Body.",
  } as never);

  const fm = readFrontmatter(markdown);
  assert.equal(
    fm.malformed,
    false,
    "compiled frontmatter must be valid YAML — it is the input to every other check",
  );
  assert.equal(
    frontmatterScalar(fm, "description"),
    withColon,
    "and the value must round-trip unchanged, not merely parse",
  );
  // The tool contract is what silently vanishes when the block is malformed: the
  // file still LOOKS declarative while a strict parser reads nothing from it.
  assert.match(markdown, /allowed-tools: \[Read, WebSearch\]/);
});

// ── the same property, over the scalars YAML actually mis-reads ───────────────
// One example proves the colon-space case and nothing else. YAML has a dozen ways
// to read a bare scalar as something other than the string that was written, and a
// description is arbitrary human prose, so the guarantee has to be stated as a
// PROPERTY over the space rather than as a sample from it: whatever goes in comes
// back out identical, and quoting fires only when it must.
//
// This is the whole reason a downstream repo does not need its own check. Before
// this, a consumer proved the reader failed closed by hand-editing a compiled
// SKILL.md — text surgery that assumed how the corpus happened to be quoted, and
// that assumption stops holding the moment quoting became conditional (above).
// The emission side is provable here; the hand-edit side is what `frontmatter-valid`
// and the integrity hash are for.
const ADVERSARIAL_SCALARS: readonly (readonly [string, string])[] = [
  ["colon-space in prose", "Find the venue: rank it by fit, not prestige."],
  ["leading hash", "# not a comment, an actual description"],
  ["trailing hash", "Audit a channel # before buying ads"],
  ["leading dash-space", "- looks like a list item but is prose"],
  ["leading bracket", "[bracketed] opening that YAML reads as a flow sequence"],
  ["leading brace", "{braced} opening that YAML reads as a flow mapping"],
  ["leading percent", "%YAML-looking directive at the start"],
  ["leading at-sign", "@reserved indicator in YAML 1.2"],
  ["leading backtick", "`reserved indicator too"],
  ["leading ampersand", "&anchor-looking first character"],
  ["leading asterisk", "*alias-looking first character"],
  ["leading exclamation", "!tag-looking first character"],
  ["leading pipe", "|block scalar indicator"],
  ["leading gt", ">folded scalar indicator"],
  ["leading quote", '"opens with a quote it never closes'],
  ["bare yes", "yes"],
  ["bare no", "no"],
  ["bare on", "on"],
  ["bare off", "off"],
  ["bare null", "null"],
  ["bare true", "true"],
  ["numeric-looking", "1.0"],
  ["version-looking", "1.2.3"],
  ["sexagesimal-looking", "12:30:45"],
  ["trailing space", "ends with a space "],
  ["embedded double quote", 'says "hello" in the middle'],
  ["embedded single quote", "it's got an apostrophe"],
  ["embedded backslash", "a path-like C:\\Users\\x in prose"],
  ["non-ascii with colon", "Замер врёт: неаналоги в выборке."],
];

for (const [label, description] of ADVERSARIAL_SCALARS) {
  test(`compile round-trips a description: ${label}`, async () => {
    const { markdown } = await compileSkill({
      name: "probe-skill",
      description,
      body: "Body.",
    } as never);
    const fm = readFrontmatter(markdown);
    assert.equal(
      fm.malformed,
      false,
      `compiled frontmatter must parse — ${label} produced a block a strict loader rejects`,
    );
    // 🔴 The oracle is the RAW parsed value, not `frontmatterScalar`. That helper
    // trims by contract (a reader should not care about stray whitespace), so it
    // cannot witness a byte-exact round trip — the `trailing space` row is the one
    // that proved it, by going red against a compiler that had emitted the value
    // correctly. A red test is a finding about the test until the product is ruled
    // out; here the product was fine and the oracle was wrong.
    assert.equal(
      fm.data?.["description"],
      description,
      `and must round-trip UNCHANGED — ${label} came back as something else, which is worse ` +
        "than failing to parse: the file looks fine and the value is silently different",
    );
  });
}

// The other direction, as a property too: a scalar YAML reads back correctly must be
// left bare. Quoting that fires when it need not moves every integrity hash in every
// consumer repo, which reads as "vigiles rewrote my files".
const SAFE_SCALARS: readonly string[] = [
  "Search products on ozon.kz and return live listings.",
  "Разобрать выписки за месяц и пересчитать NW.",
  "Rank venues by fit — dashes and em-dashes are fine",
  "Parentheses (like these) and commas, too",
];

for (const description of SAFE_SCALARS) {
  test(`compile leaves a safe description bare: ${description.slice(0, 32)}…`, async () => {
    const { markdown } = await compileSkill({
      name: "probe-skill",
      description,
      body: "Body.",
    } as never);
    assert.ok(
      markdown.includes(`description: ${description}`),
      "a scalar that round-trips bare must stay bare, or every compiled file churns",
    );
  });
}

test("compile leaves an already-safe description bare — no hash churn", async () => {
  const plain = "Search products on ozon.kz and return live listings.";
  const { markdown } = await compileSkill({
    name: "ozon-search-kz",
    description: plain,
    body: "Body.",
  } as never);
  assert.ok(
    markdown.includes(`description: ${plain}`),
    "a safe scalar must stay unquoted, or every compiled file in every repo churns and every integrity hash moves",
  );
});
