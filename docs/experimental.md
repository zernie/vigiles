# What `experimental_` means

If a name you import from vigiles starts with `experimental_`, we ship it but do
not promise to keep it. It can change shape, be renamed, or disappear in any
release, including a patch release. Renaming it is **not** a breaking change and
does not bump the major version.

Everything so named has a stable alternative. The feature's own docs page says
what it is.

## Contents

- [The rule](#the-rule) · [What is experimental today](#what-is-experimental-today)
- [When the prefix comes off](#when-the-prefix-comes-off) · [How we learned this](#how-we-learned-this)

## The rule

**If we export it and it is not stable, its name starts with `experimental_`.**

Why the name, and not a note in the docs or the changelog: the name is in every
call site, every diff, every review and every autocomplete for as long as the
thing is unstable. An import line scrolls out of view. A changelog is read once.
A doc note is read never.

Two checks keep the rule honest:

- **The tag and the name cannot disagree.** Every experimental export is declared
  once with the `@experimental` TSDoc tag. An ESLint rule
  (`local/experimental-name`) fails the build if a tagged export lacks the prefix.
- **One experimental root per feature.** The prefix says whether _this_ name is
  stable. It cannot say whether the names it depends on are. So a feature's whole
  vocabulary hangs off one prefixed root: `experimental_agent.result()`, never a
  plain `result()` that only works with `experimental_agent()`. The root's name
  also survives destructuring — `const { result } = experimental_agent` still
  names the root at the binding site — which an import path does not.

## What is experimental today

| Symbol                                                                                                                                                                                                   | Since      | Why it is not stable yet                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `experimental_defineHook` and its five siblings (`experimental_defineFileGate`, `experimental_definePromptGate`, `experimental_defineStopGate`, `experimental_defineInject`, `experimental_defineReact`) | 2026-08-20 | The named-state API (`record` / `state`) has one author and no outside user. There is no supported way to seed that state in a test other than `runHook`. `vigiles compile` appends a duplicate wiring block when re-run. Details: [compiled hooks](compiled-hooks.md#status--pending).                                                                                                                                                                      |
| `experimental_alternateSpellings`                                                                                                                                                                        | 2026-09-02 | Days old. Its only user is this repo's own test. The set of rewrite rules and the id format of the generated cases are the parts most likely to change. Details: [the disaster battery](compiled-hooks.md#one-command-many-spellings--experimental_alternatespellings).                                                                                                                                                                                      |
| `experimental_verifyPluginGuards`                                                                                                                                                                        | 2026-09-07 | Days old, with no user outside this repository. The REPORT SHAPE is what is most likely to move — whether `not-applicable` stays one status or splits by cause, and whether the per-hook counts stay arrays of event ids. The prefix comes off when that shape survives sweeping several real third-party repos unchanged. Details: [sweep every hook a repo declares](harness-testing.md#sweep-every-hook-a-repo-declares-experimental_verifypluginguards). |
| `experimental_formatPluginGuardReport`                                                                                                                                                                   | 2026-09-07 | It renders `PluginGuardReport`, so it inherits that shape's instability exactly — a stable name here would promise more than its only input can. The prefix comes off with the same change that takes it off the sweep. Details: [sweep every hook a repo declares](harness-testing.md#sweep-every-hook-a-repo-declares-experimental_verifypluginguards).                                                                                                    |

## When the prefix comes off

All four of these must hold. They are about other people on purpose: everything
else we could judge ourselves, and we would be generous.

1. **Someone outside this repository uses it**, and we know what for. Our own
   in-repo test does not count: same author, same assumptions.
2. **Nothing about its shape has moved for a full release cycle.** No signature,
   no return type, no option name.
3. **Every gap in the table above is closed**, or written down as a permanent
   limitation with its reason.
4. **Testing it needs no private knowledge.** If the only way to test it is to
   hard-code a path the runtime computes internally, it is not finished: a user
   cannot test their own use of it.

Dropping the prefix is a rename, so it ships as a `feat!` with a major bump.

## How we learned this

`skill()` shipped under a stable name while `docs/skills.md` opened with
"`skill()` is experimental". Nothing caught the contradiction, because the rule
was a habit rather than a check.

We also tried a `vigiles/experimental` import path. It marked the import line,
which is out of view by the time anyone reads the call. It was retired.

## See also

- [Compiled hooks](compiled-hooks.md) — the largest experimental surface, and the
  guide that explains what each entry point does.
- [Stability](../STABILITY.md) — the stability promise for everything that is
  _not_ prefixed.
