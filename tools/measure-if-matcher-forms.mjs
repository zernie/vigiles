/**
 * What Claude Code's own hook `if:` matcher does and does not catch.
 *
 * Human-run, never CI (it spawns the real `claude`; free, the model is
 * scripted). Re-run it after a Claude Code minor — this measures someone
 * else's matcher, and prose in a doc cannot notice when that moves.
 *
 * WHY BOTH SPELLINGS. `if:` is written two ways in the wild and it was not
 * obvious they behave alike:
 *   prefix  Bash(git push:*)          anthropics/claude-code, plugins/security-guidance
 *   glob    Bash(git push *--force*)  davila7/claude-code-templates, security/force-push-blocker
 *
 * MEASURED 2026-09-08, Claude Code 2.1.263 — identical on all three inputs:
 *
 *   form     input                                     hook spawned
 *   prefix   git push --force origin main              YES
 *   prefix   /usr/bin/git push --force origin main     NO      <-- leaks
 *   prefix   cd /tmp && git push --force origin main   YES
 *   glob     git push --force origin main              YES
 *   glob     /usr/bin/git push --force origin main     NO      <-- leaks
 *   glob     cd /tmp && git push --force origin main   YES
 *
 * TWO FINDINGS, and the second corrects a claim of ours.
 *
 * 1. An ABSOLUTE program head is not matched by either spelling, so a guard
 *    written this way does not run on `/usr/bin/git push --force`. That is
 *    the whole guard for a hook whose body is unconditional. It holds for
 *    Anthropic's own plugin, which is written in the prefix form.
 *
 * 2. A COMPOUND command IS matched, by both. CLAUDE.md and docs/compiled-hooks.md
 *    say `runs()` catches `cd x && git push -f` "the native glob (#30519)
 *    misses" — on 2.1.263 the native matcher caught it. Either the issue was
 *    fixed, as #34692 was, or the claim was wrong when written. Not resolved
 *    here; do not repeat the claim until it is.
 *
 * The oracle is a marker file the hook body touches, so what is observed is
 * the SPAWN itself, not the hook's decision — the question is whether Claude
 * Code runs the hook at all.
 *
 * Run: node tools/measure-if-matcher-forms.mjs   (needs `claude` on PATH)
 */
import cc from "vigiles/claude-code";
import v from "vigiles";
const { scriptModel, claudeAvailable } = cc;
const { runHarnessTest } = v;
if (!claudeAvailable()) {
  console.log("SKIPPED — no claude");
  process.exit(77);
}

// The two spellings found in the wild, plus the WIDENED forms. The widening is
// the point: a native `if:` may only ever be emitted as a deliberate SUPERSET
// of the typed predicate, never as its natural translation — otherwise the
// filter is narrower than the body it guards and the guard silently stops
// firing. Measured 2026-09-08, Claude Code 2.1.263:
//
//   emitted if:                 plain   absolute   unrelated
//   Bash(git push *--force*)    fires   NO         no      <- natural, unsafe
//   Bash(git push:*)            fires   NO         no      <- natural, unsafe
//   Bash(*git*)                 fires   fires      no      <- widened, sound
//   Bash(*)                     fires   fires      fires   <- nothing filtered
//
// Widening to the PROGRAM NAME keeps every case the body would catch while
// still filtering unrelated commands. Flags and subcommand refinement are
// dropped on purpose: including them is exactly what makes the natural
// translation too narrow, and the body re-checks them anyway.
//
// NOT MEASURED, do not assume: the widening for `touches()` (paths) and
// `pipesToShell()`. Either may have none, and the honest answer for such a
// primitive is to emit nothing rather than something that looks like a filter.
const FORMS = {
  naturalPrefix: "Bash(git push:*)",
  naturalGlob: "Bash(git push *--force*)",
  widenedProgram: "Bash(*git*)",
  widenedAll: "Bash(*)",
};
const INPUTS = {
  plain: "git push --force origin main",
  absolute: "/usr/bin/git push --force origin main",
  compound: "cd /tmp && git push --force origin main",
  unrelated: "ls -la",
};

const rows = [];
for (const [fname, cond] of Object.entries(FORMS)) {
  for (const [iname, command] of Object.entries(INPUTS)) {
    const marker = `fired-${fname}-${iname}`;
    const r = await runHarnessTest({
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", if: cond, command: `touch {cwd}/${marker}` },
              ],
            },
          ],
        },
      },
      model: scriptModel([
        { tool: "Bash", input: { command } },
        { text: "done" },
      ]),
      task: "run it",
    });
    let fired = null;
    try {
      fired = r.file(marker) !== null;
    } finally {
      r.cleanup();
    }
    rows.push({ form: fname, input: iname, fired });
  }
}
console.log("\nif-форма        вход        хук запустился");
console.log("─".repeat(46));
for (const r of rows)
  console.log(
    `${r.form.padEnd(15)} ${r.input.padEnd(11)} ${r.fired === null ? "?" : r.fired ? "ДА" : "НЕТ"}`,
  );
