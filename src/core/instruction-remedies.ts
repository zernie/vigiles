/**
 * What a finding about an instruction file tells the reader to DO — the one
 * owner of that wording, so lint, audit and compile cannot drift apart.
 *
 * Where always-loaded text can go instead of being deleted.
 *
 * Every finding that says "too much is loaded on every request" — the weight
 * ceiling, the ratchet's growth, the refusal to record a heavier baseline, a
 * section or the whole Rules section over its `compile-budget` — ends with
 * this list. Without it the one move the message offers is "cut content", and
 * the reader deletes rules that still matter instead of moving each one to the
 * carrier that loads it only when it applies. The order is the order to try: the cheapest carrier that
 * still fires at the right moment first, deletion last.
 */
export const MOVE_OUT_OF_ALWAYS_LOADED = [
  "Move what does not apply to every request:",
  "  - a rule for one folder → that folder's nested CLAUDE.md or AGENTS.md (loads only there)",
  "  - a step tied to one action → a hook",
  "  - a procedure for one kind of task → a skill",
  "  - a fact a machine can check → a lint rule or a test, then delete the prose",
  "  - history → git: link the commit, do not copy its text",
  "  - a measurement → next to the check that measures it",
  "  - text another file already says → delete it",
].join("\n");

/**
 * The two ways to put a hand-written instruction file under a spec, each said
 * for what it does. They are not interchangeable: `init --target` is the
 * deterministic floor (`adoptMarkdown` — every heading becomes a verbatim prose
 * section, only backticked paths that resolve become checked `file()` refs, no
 * rule is inferred), while the `adopt-spec` skill is an agent reading the file
 * and mapping rules, commands and paths to typed calls. The skill is
 * user-invoked (`disable-model-invocation`), so it has to be asked for.
 * Neither edits the markdown: switching it to spec-managed is a `compile` the
 * user runs after reviewing.
 */
export function adoptInstructionFileRemedy(path: string): string {
  return [
    `Adopt it into a spec, one of two ways:`,
    `  - the \`adopt-spec\` skill — ask your agent to run it on ${path} (it never fires by itself): the agent maps rules to guidance()/enforce(), commands to cmd() and paths to file(), and shows you the spec before writing it`,
    `  - \`npx vigiles init --target=${path}\` — no agent, immediate: copies every section verbatim as prose; only paths that resolve become checked file() refs, rules stay prose`,
    `  Neither edits ${path}. Review the spec, then run \`npx vigiles compile\`.`,
  ].join("\n");
}

/** The folder of a repository-relative path, as a root-relative glob. */
function folderGlob(path: string): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return dir === "" ? "<folder>/**" : `${dir}/**`;
}

/**
 * For a file the repository does not own — vendored, a corpus, a fixture: drop
 * its folder from what vigiles reads. `exclude` is top-level in
 * `.vigilesrc.json`, and its globs are relative to the repository root.
 */
export function excludeFolderRemedy(path: string): string {
  return [
    `Not your file (vendored, a corpus, a fixture)? Exclude its folder in .vigilesrc.json:`,
    `    { "exclude": ["${folderGlob(path)}"] }`,
  ].join("\n");
}

/**
 * For instruction files kept hand-written on purpose (a notes or
 * knowledge-base folder): turn the rule off for those folders with an
 * `overrides` entry — the rule keeps guarding every other folder. Off for the
 * whole repository is the last resort, named last.
 */
export function keepHandWrittenRemedy(path: string): string {
  return [
    `Keeping instruction files hand-written on purpose (a notes or knowledge-base folder)? Turn the rule off for those folders in .vigilesrc.json:`,
    `    { "overrides": [{ "files": ["${folderGlob(path)}"], "rules": { "require-instructions-spec": "off" } }] }`,
    `  Only if no instruction file in the repository should have a spec: { "rules": { "require-instructions-spec": "off" } }`,
  ].join("\n");
}

/**
 * Everything a `require-instructions-spec` finding says to do, in the order to
 * try it: adopt, else exclude what is not yours, else turn the rule off for the
 * folders that stay hand-written. It is the first finding a new adopter sees,
 * so it names commands and config, not concepts.
 */
export function handWrittenInstructionRemedy(path: string): string {
  return [
    `1. ${adoptInstructionFileRemedy(path)}`,
    `2. ${excludeFolderRemedy(path)}`,
    `3. ${keepHandWrittenRemedy(path)}`,
  ].join("\n");
}
