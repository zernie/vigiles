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
  // A quoted list splits on BOTH paths, valid and salvaged.
  //
  // 🔴 THIS ROW NO LONGER CARRIES THE "quotes gate depth, not splitting"
  // COUNTERWEIGHT, and the comment that claimed it did was left standing for one
  // commit after it stopped being true. It was written when the salvage path
  // handed `splitList` the YAML wrapper quotes; that WAS the regression the next
  // commit fixed (`stripWrapperQuotes`), so no quote character reaches the
  // splitter here any more and the widening mutation cannot bite on this input.
  // The live counterweight is the UNBALANCED-quote row in the salvage test above,
  // where a lone `"` genuinely does reach the tokenizer. Kept here as a
  // both-paths-agree assertion, which is what it actually proves.
  // (`desc:` below carries an unescaped `: ` — invalid YAML.)
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

test("the SALVAGE path strips YAML wrapper quotes before tokenizing (#217)", () => {
  // A REGRESSION this suite did not catch, found by the Codex review bot after
  // the quote-aware depth counter landed. On valid YAML js-yaml removes a
  // scalar's surrounding quotes; only the regex salvage handed them through, so
  // the opening YAML quote was read as a SHELL quote, the grant's parens stopped
  // counting as structure, and its own spaces split it. Measured before the fix:
  //
  //   tools: "Bash(git status *), Read"  ->  ["Bash(git","status","*)","Read"]
  //
  // Three phantom tool names — the exact shape #217 argued against, and in the
  // false-EXPOSED direction. The older comma-only parser got this input right,
  // which is what makes it a regression rather than a gap.
  const salvaged = (v: string): string[] | null =>
    frontmatterList(
      // The unescaped `: ` in `description` is what makes the block invalid YAML.
      readFrontmatter(
        `---\nname: a\ndescription: use foo: bar\ntools: ${v}\n---\n`,
      ),
      "tools",
    );
  assert.deepEqual(salvaged('"Bash(git status *), Read"'), [
    "Bash(git status *)",
    "Read",
  ]);
  // The two paths must agree — that is the property, not just "the grant survives".
  const viaYaml = frontmatterList(
    readFrontmatter('---\nname: a\ntools: "Bash(git status *), Read"\n---\n'),
    "tools",
  );
  assert.deepEqual(salvaged('"Bash(git status *), Read"'), viaYaml);
  // An UNBALANCED leading quote is left alone rather than guessed at; the value
  // still tokenizes, and the stray quote comes off per token as it always did.
  assert.deepEqual(salvaged('"Read Write'), ["Read", "Write"]);
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
