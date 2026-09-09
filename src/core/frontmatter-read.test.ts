/**
 * Lenient frontmatter-reader suite (vitest). Asserts the "real parser, regex
 * safety net" contract: valid YAML parses correctly (block scalars, quoted
 * multi-line, flow arrays), malformed YAML sets `malformed` AND still salvages
 * the requested field, and the list semantics the PreToolUse rail depends on
 * (absent → null, empty → []) hold.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  readFrontmatter,
  frontmatterScalar,
  frontmatterList,
} from "./frontmatter-read.js";

test("valid YAML parses; scalars and a flow array read back", () => {
  const fm = readFrontmatter(
    '---\nname: a\ndescription: does things\ntools: [Read, "Bash"]\n---\nbody\n',
  );
  assert.equal(fm.malformed, false);
  assert.equal(frontmatterScalar(fm, "name"), "a");
  assert.equal(frontmatterScalar(fm, "description"), "does things");
  assert.deepEqual(frontmatterList(fm, "tools"), ["Read", "Bash"]);
});

test("a comma-list tool value splits", () => {
  const fm = readFrontmatter("---\nname: a\ntools: Read, Grep, Bash\n---\n");
  assert.deepEqual(frontmatterList(fm, "tools"), ["Read", "Grep", "Bash"]);
});

test("every separator Claude Code documents splits the same way (#217)", () => {
  // Claude Code accepts a comma-separated string, a SPACE-separated string, or a
  // YAML list, and treats all three as equivalent. Until #217 only two of the
  // three worked here: a space-separated fence arrived as one token matching no
  // built-in, so a fence the harness really enforces audited as closing nothing.
  // Reported with this table by @vlad-ryzhkov, measured against a real harness.
  const read = (v: string): string[] | null =>
    frontmatterList(
      readFrontmatter(`---\nname: a\ndisallowed-tools: ${v}\n---\n`),
      "disallowed-tools",
    );
  assert.deepEqual(read("WebFetch, WebSearch"), ["WebFetch", "WebSearch"]);
  assert.deepEqual(read("WebFetch WebSearch"), ["WebFetch", "WebSearch"]);
  assert.deepEqual(read("WebFetch,  WebSearch ,Bash"), [
    "WebFetch",
    "WebSearch",
    "Bash",
  ]);
  // A YAML-quoted scalar whose VALUE is a space-separated list — common in the
  // wild, and the shape that made this bug invisible: the quotes are YAML syntax,
  // not token boundaries, so they are stripped and the value still splits.
  assert.deepEqual(read('"Read Write Glob"'), ["Read", "Write", "Glob"]);
});

test("whitespace splits ONLY outside parens, so a bounded grant survives (#217)", () => {
  // The half that makes the naive `split(/[,\s]+/)` wrong: `Bash(git push *)` must
  // stay ONE token. Shredded, it matches no grant, and `bashGrantIsUnbounded()`
  // answers "unbounded" when it cannot recognise one — so the fix for a
  // false-CLEAN verdict would have bought a false-EXPOSED one.
  const read = (v: string): string[] | null =>
    frontmatterList(
      readFrontmatter(`---\nname: a\nallowed-tools: ${v}\n---\n`),
      "allowed-tools",
    );
  assert.deepEqual(read("Bash(git add *) Bash(git commit *)"), [
    "Bash(git add *)",
    "Bash(git commit *)",
  ]);
  assert.deepEqual(read("Bash(git push *), WebFetch"), [
    "Bash(git push *)",
    "WebFetch",
  ]);
  assert.deepEqual(read("[Read, Grep]"), ["Read", "Grep"]);
  // An UNCLOSED paren keeps the rest as one token rather than fragmenting it into
  // garbage tool names — the conservative side of a shape we cannot parse.
  assert.deepEqual(read("Bash(git push Read"), ["Bash(git push Read"]);
});

test("a parenthesis INSIDE a quoted string is a character, not a bracket (#217)", () => {
  // Found by the Codex review bot on the first cut of this tokenizer. A literal
  // unmatched paren inside a grant's own command left depth at 1 after the grant
  // closed, so every following token was swallowed into it — and on a SUBAGENT
  // that denies a tool the author granted, the exact failure this function
  // exists to fix. Measured before the fix: one token, `Read` lost.
  const read = (v: string): string[] | null =>
    frontmatterList(
      readFrontmatter(`---\nname: a\ntools: ${v}\n---\n`),
      "tools",
    );
  assert.deepEqual(read("Bash(printf '( %s' foo) Read"), [
    "Bash(printf '( %s' foo)",
    "Read",
  ]);
  // Balanced parens inside quotes self-corrected even before the fix; pinned so
  // the common `git commit -m "feat(api): …"` shape cannot regress either.
  assert.deepEqual(read('Bash(git commit -m "feat(api): x") Read'), [
    'Bash(git commit -m "feat(api): x")',
    "Read",
  ]);
  // 🔴 THE COUNTERWEIGHT, and why quotes gate ONLY the depth counter: if being
  // inside quotes also suppressed SPLITTING, a quoted list would collapse back
  // to one token — reintroducing the very bug #217 reports.
  //
  // It must be asserted on a MALFORMED block, and that is the whole point. On
  // valid YAML js-yaml strips the quotes before `splitList` ever runs, so the
  // value arrives as bare `Read Write Glob` and NO quote character is present —
  // measured, after the first version of this assertion used a valid block and
  // stayed green under the widening mutation, carrying zero information. Quotes
  // reach the splitter only down the regex SALVAGE path, so that is where the
  // property lives. (`desc:` below carries an unescaped `: ` — invalid YAML.)
  const salvaged = frontmatterList(
    readFrontmatter(
      '---\nname: a\ndesc: Use the foo: bar tool\ntools: "Read Write Glob"\n---\n',
    ),
    "tools",
  );
  assert.deepEqual(salvaged, ["Read", "Write", "Glob"]);
  // …and the same value on the valid-YAML path, where the quotes are gone by then.
  assert.deepEqual(read('"Read Write Glob"'), ["Read", "Write", "Glob"]);
});

test("absent list key → null (inherits all); present-but-empty → [] (no tools)", () => {
  const none = readFrontmatter("---\nname: a\n---\n");
  assert.equal(frontmatterList(none, "tools"), null);
  const empty = readFrontmatter("---\nname: a\ntools:\n---\n");
  assert.deepEqual(frontmatterList(empty, "tools"), []);
});

test("a block scalar (>) and a next-line quoted scalar both read", () => {
  const folded = readFrontmatter(
    "---\nname: a\ndescription: >\n  a folded multi-line\n  description here\n---\n",
  );
  assert.match(
    frontmatterScalar(folded, "description") ?? "",
    /folded multi-line/,
  );
  const quoted = readFrontmatter(
    '---\nname: a\ndescription:\n  "value on the next line"\n---\n',
  );
  assert.equal(
    frontmatterScalar(quoted, "description"),
    "value on the next line",
  );
});

test("malformed YAML → malformed:true AND still salvages a column-0 field", () => {
  // An unescaped colon-space mid-value is invalid YAML ("mapping values not
  // allowed"), but the fields are still recoverable by the regex salvage.
  const fm = readFrontmatter(
    "---\nname: a\ndescription: Use the foo: bar tool\n---\n",
  );
  assert.equal(fm.malformed, true);
  assert.equal(frontmatterScalar(fm, "name"), "a");
  assert.equal(frontmatterScalar(fm, "description"), "Use the foo: bar tool");
});

test("a leading vigiles integrity comment before --- is tolerated", () => {
  const fm = readFrontmatter(
    "<!-- vigiles:sha256:abc compiled from x.spec.ts -->\n\n---\nname: a\n---\nbody\n",
  );
  assert.equal(frontmatterScalar(fm, "name"), "a");
});

test("a body --- horizontal rule is NOT read as frontmatter", () => {
  const fm = readFrontmatter("# Title\n\nsome text\n\n---\n\nmore\n\n---\n");
  assert.equal(fm.block, null);
  assert.equal(fm.malformed, false);
});

test("no frontmatter block at all", () => {
  const fm = readFrontmatter("# just a heading\n\nbody\n");
  assert.deepEqual(fm, { data: null, block: null, malformed: false });
});
