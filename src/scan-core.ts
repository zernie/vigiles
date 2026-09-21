/**
 * scan-core — the PURE, NODE-FREE detector runtime behind `vigiles audit`.
 *
 * These are the deterministic surface detectors `scanPlugin` (disk, src/scan.ts)
 * and `scanFiles` (browser, src/scan-files.ts) BOTH run — one detector, no drift.
 * They were split out of `scan.ts` so the in-browser audit engine can import them
 * WITHOUT dragging `scan.ts`'s node-only runtime deps (plugin-loader/crypto,
 * core/mcp/child_process, test-coverage/glob, node:fs) into the bundle: every
 * import below is node-free (path ops from the node-free `./posix-path.js`; all
 * filesystem IO is INJECTED by the caller, never imported here). `scan.ts`
 * re-exports everything here (`export *`) so its public surface is unchanged.
 *
 * The only edge back to `scan.ts` is TYPE-ONLY (the report shapes), elided at
 * build, so there is no runtime cycle — `scan.ts` requires `scan-core.js`, never
 * the reverse.
 */
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "./posix-path.js";

import {
  verifyToolContract,
  scoredIssues,
  advisoryIssues,
  disallowedToolIssues,
} from "./core/tool-contract.js";
import type { HookEventIssue } from "./core/hook-events.js";
import { editDistance } from "./core/edit-distance.js";
import { readFrontmatter, frontmatterScalar } from "./core/frontmatter-read.js";
import {
  findDescriptionOverlaps,
  type DescribedSurface,
  type DescriptionOverlap,
} from "./core/description-overlap.js";
import {
  findDescriptionBudgetIssues,
  type DescriptionBudgetIssue,
} from "./core/skill-description-budget.js";
import { verifyMcpToolServers } from "./core/mcp-tool.js";
import {
  lethalTrifectaIssues,
  skillTrifectaIssue,
} from "./core/lethal-trifecta.js";
import { skillResourceIssues } from "./core/skill-resources.js";
import { commandWords } from "./core/bash-effects.js";
import { scriptWordPattern } from "./core/source-refs.js";
import { skillMissingFence } from "./core/skill-missing-fence.js";
import type { SkillRefSource } from "./skill-refs.js";
import {
  delegationTrifectaIssues,
  type CapabilityNode,
} from "./core/delegation-trifecta.js";
import { effectSurface } from "./core/effects.js";
import {
  parseAgentTools,
  parseAgentToolList,
} from "./adapters/claude-code/agent-tools.js";
import {
  AGENT_FILE_LEAF_RE,
  agentSurfaceName,
  type PluginLayout,
} from "./core/layout.js";
import type { HarnessDialect } from "./core/dialect.js";
import type { HookRegistration } from "./core/hook-normalize.js";
import type { HookScriptEntry } from "./core/hook-block-ineffective.js";
import type { HookMatcherEntry } from "./core/hook-matcher.js";
import type {
  ScanSkill,
  ScanAgent,
  ScanHook,
  FrontmatterIssue,
  FrontmatterValueIssue,
  FrontmatterParseIssue,
  ScanTrifectaFinding,
  ScanSkillResourceFinding,
  ScanSkillFenceFinding,
  ScanDelegationFinding,
  VocabularyNote,
} from "./scan.js";

// A script-path token, matched against a WHOLE shell WORD. The token class is
// `\S` MINUS the glob metacharacters `*` and `?` (dogfood D1): a real, resolvable
// hook path never contains them, but a command that merely MENTIONS a glob — e.g.
// `find . -name "*.js"` in a hook body — would otherwise have `"*.js"` grabbed as
// a "script" and reported MISSING (a false positive). Shell vars / braces /
// slashes ARE kept (`${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`), since resolveScript
// expands those. See core/source-refs.ts for the boundary rules.
const SCRIPT_WORD_RE = scriptWordPattern();

/**
 * The script-path operands a hook `command` names.
 *
 * 🔴 THE COMMAND IS SHELL, SO IT IS PARSED AS SHELL. This used to run
 * `SCRIPT_RE` over the raw command string, which cannot tell an operand from
 * the text of an inline program. Against the standard portable-plugin idiom
 * `node -e "…await import(…join(root,'hooks','always-on.mjs'))…"` it produced
 * the script name
 * `import(require(node:url).pathToFileURL(require(node:path).join(root,hooks,always-on.mjs`
 * and reported it MISSING, while `hooks/always-on.mjs` sat on disk. Nine such
 * findings across the 32-repo dogfood corpus (2026-08-17), contributing to two
 * `F/0` grades.
 *
 * `commandWords` returns the words a shell would resolve, with inline program
 * text subtracted, so the report cannot name a fragment of a JavaScript
 * expression. A command that does not parse as shell yields `null`, and the
 * caller treats it as an inline one-liner rather than guessing — abstaining is
 * the direction that cannot accuse.
 */
function scriptTokens(command: string): string[] | null {
  const words = commandWords(command);
  if (words === null) return null;
  return words.filter((w) => SCRIPT_WORD_RE.test(w));
}

// The scalar fields scan reads from a skill/agent `---` block, via the shared
// lenient reader (core/frontmatter-read.ts) — a real YAML parse with a regex
// salvage on malformed input, so block scalars / multi-line quoted values parse
// for free and a bad block still yields what it can. One reader, no drift.
function frontmatter(md: string): {
  name?: string;
  description?: string;
  model?: string;
  color?: string;
} {
  const fm = readFrontmatter(md);
  return {
    name: frontmatterScalar(fm, "name"),
    description: frontmatterScalar(fm, "description"),
    model: frontmatterScalar(fm, "model"),
    color: frontmatterScalar(fm, "color"),
  };
}

/**
 * Whether this unit's declared TOOL CONTRACT is unreadable — the frontmatter
 * block exists but is not valid YAML.
 *
 * 🔴 WHY SCORING MUST NOT USE THE SALVAGE. The shared reader is deliberately
 * lenient: on a block js-yaml rejects it falls back to a regex salvage, so the
 * live PreToolUse rail still has *something* to enforce and the other fields
 * keep working. That is right for a rail and wrong for a SCORE. Measured
 * 2026-08-08: `readFrontmatter(bad)` returns `{data: null, malformed: true}` —
 * the tool KNOWS the block is broken — while `frontmatterList(…, "allowed-tools")`
 * on the same block returns `["Read","Bash"]`, the narrow contract the author
 * MEANT. Strict js-yaml on it throws `bad indentation of a mapping entry`. So a
 * unit whose contract a strict loader rejects was graded as though it had
 * declared exactly that narrow contract: the Safety ring read BETTER than the
 * truth, on the optimistic branch, in the tool whose own thesis is that the
 * presence of a declaration is not the enforcement of it.
 *
 * The trifecta detector is therefore told the list is a SALVAGE, and reads it as
 * one: it can only make the verdict worse (a salvaged all-three still convicts),
 * and anything short of that falls back to what a strict loader really yields —
 * no contract, i.e. inherits-all. The finding says which happened, so the author
 * can tell a dropped grade from a real capability. Strictly one-directional, the
 * same shape as the inherits-all monotonicity fix (#119). `frontmatter-valid`
 * reports the broken block itself; this is the half that stops the SCORE
 * disagreeing with it.
 *
 * DELIBERATELY NOT WIDER. The typo / never-available / MCP-server /
 * disallowed-tools cross-references keep using the salvage: they are diagnostics,
 * and suppressing them on a malformed file DELETES findings, which moves the
 * grade the optimistic way — the direction this whole fix exists to close. A real
 * vendored plugin in `test/dogfood` proves the point: `madappgang-frontend`'s
 * `tester.md` has both a malformed description and an explicit all-three-legs
 * tool list, and its `AskUserQuestion` never-available finding is true whether or
 * not the block parses.
 */
function contractIsUnreadable(md: string): boolean {
  return readFrontmatter(md).malformed;
}

/**
 * Per-kind surface classifiers, built from the harness `PluginLayout`'s
 * `skillDir`/`agentDir`/`commandDir` — so adding a harness whose subagents live
 * somewhere other than `agents/` (OpenCode's `.opencode/agent`) needs no change
 * here. Each anchors on a real path boundary (start-of-path or a `/`), so a
 * directory whose NAME merely ends in the keyword isn't misclassified — e.g. the
 * skill `skills/dispatching-parallel-agents/SKILL.md` must NOT register as an
 * agent named "SKILL" (the `-agents/` substring), which real plugins like
 * obra/superpowers ship. See scan.test.ts for the regression cases.
 */
export interface SurfaceClassifier {
  readonly isSkill: (f: string) => boolean;
  readonly isAgent: (f: string) => boolean;
  readonly isCommand: (f: string) => boolean;
  /**
   * The subagent identity for a path `isAgent` accepts — the layout-scoped name
   * from {@link agentSurfaceName}. Lives here because the classifier is already
   * the one thing holding the layout's surface dirs; a caller deriving the name
   * itself would need the layout too, and would be free to derive a different
   * one. Null for a path this classifier does not call an agent.
   */
  readonly agentName: (f: string) => string | null;
  /**
   * A path-scoped RULES file (`<rulesDir>/<name>.md`) — an INSTRUCTION surface,
   * not an invocable one. Always false for a layout with no `rulesDir`.
   */
  readonly isRule: (f: string) => boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeClassifier(layout: PluginLayout): SurfaceClassifier {
  // An empty dir means "this harness has no such surface" → never matches.
  const at = (dir: string): string | null =>
    dir ? `(?:^|/)${escapeRe(dir)}/` : null;
  const skill = at(layout.skillDir);
  const agent = at(layout.agentDir);
  const command = at(layout.commandDir);
  const rules = at(layout.rulesDir ?? "");
  const skillRe = skill ? new RegExp(`${skill}[^/]+/SKILL\\.md$`) : null;
  const agentRe = agent ? new RegExp(`${agent}${AGENT_FILE_LEAF_RE}$`) : null;
  const commandRe = command ? new RegExp(`${command}.+\\.md$`) : null;
  // Flat `<rulesDir>/<name>.md`, like commands. A layout without a rules dir
  // yields null and every path below answers false — the additive default.
  const ruleRe = rules ? new RegExp(`${rules}[^/]+\\.md$`) : null;
  // A subagent lives under the plugin's `agents/` dir AT ANY DEPTH (the harness
  // reads it recursively — see AGENT_FILE_LEAF_RE for the vendor's wording and
  // the measurement), but never under ANOTHER surface dir. Two real-world
  // nesting traps are excluded as false positives:
  //   - `skills/<x>/agents/…` — skill-internal worker docs (Anthropic's skill-creator)
  //   - `commands/agents/…`   — a COMMAND namespaced `/agents:…` (ruvnet/claude-flow),
  //     incl. a `README.md`; these are commands, not dispatchable subagents.
  // Flagging either as a subagent missing frontmatter is a false positive (it
  // mis-graded a real plugin F). A genuine `agents/foo.md` — or `agents/x/foo.md`
  // — still matches. Both excluded dirs are read from the layout
  // (adapter-agnostic), and both patterns already tolerate depth on BOTH sides of
  // the `agents/` segment, so the recursion above does not leak through them.
  // See scan.test.ts for the regressions.
  const nestedUnder = [
    layout.skillDir &&
      `${escapeRe(layout.skillDir)}/.+/${escapeRe(layout.agentDir)}/`,
    layout.commandDir &&
      `${escapeRe(layout.commandDir)}/(?:.+/)?${escapeRe(layout.agentDir)}/`,
  ].filter((x): x is string => Boolean(x));
  const nestedAgentRe =
    layout.agentDir && nestedUnder.length
      ? new RegExp(`(?:^|/)(?:${nestedUnder.join("|")})`)
      : null;
  const isAgent = (f: string): boolean =>
    (agentRe?.test(f) ?? false) &&
    !f.endsWith(".spec.ts") &&
    !(nestedAgentRe?.test(f) ?? false);
  // The MIRROR of the rule above, and it exists because reading `agents/`
  // recursively made a new shape reachable: `agents/<x>/skills/<y>/SKILL.md` now
  // matches the agent pattern, and it always matched the skill pattern, so the
  // one file would be counted as BOTH — inflating two surface counts and grading
  // it twice. The harness resolves this the same way the existing exclusion
  // does: it reads skills from the plugin's OWN `skills/` dir, and reads every
  // `.md` under `agents/` recursively — so this file is a subagent, and is not a
  // skill. Excluding it here (rather than excluding it from agents) is what keeps
  // the two classifiers disjoint AND agreeing with the harness.
  const nestedSkillRe =
    layout.skillDir && layout.agentDir
      ? new RegExp(
          `(?:^|/)${escapeRe(layout.agentDir)}/(?:.+/)?${escapeRe(layout.skillDir)}/`,
        )
      : null;
  const isSkill = (f: string): boolean =>
    (skillRe?.test(f) ?? false) && !(nestedSkillRe?.test(f) ?? false);
  return {
    isSkill,
    isAgent,
    isCommand: (f) => commandRe?.test(f) ?? false,
    isRule: (f) => ruleRe?.test(f) ?? false,
    agentName: (f) =>
      isAgent(f) ? agentSurfaceName(f, layout.agentDir) : null,
  };
}

/**
 * ONE classifier over SEVERAL layouts — a path is a skill if ANY declared
 * harness would read it as one.
 *
 * 🔴 IT EXISTS BECAUSE A MERGED FILE MAP HAS NO SINGLE LAYOUT. A repo declaring
 * `{"harnesses": {"claude-code": {…}, "codex": {}}}` is read under BOTH layouts
 * and the two file maps merge into one, at which point classifying with one
 * layout drops the other's surfaces on the floor — Codex's `prompts/x.md` is not
 * a Claude Code command, and silently counting it as nothing is the same shape of
 * bug as reading no surfaces and grading A (100).
 *
 * `agentName` answers from the FIRST layout that calls the path an agent, so the
 * name is always the one the layout that claimed it would give — never a name
 * derived under a layout that would not have read the file at all.
 *
 * A single-layout list behaves byte-identically to {@link makeClassifier}, which
 * is what lets every existing caller keep passing one layout.
 */
export function makeUnionClassifier(
  layouts: readonly PluginLayout[],
): SurfaceClassifier {
  const cs = layouts.map(makeClassifier);
  const any =
    (pick: (c: SurfaceClassifier) => (f: string) => boolean) =>
    (f: string): boolean =>
      cs.some((c) => pick(c)(f));
  return {
    isSkill: any((c) => c.isSkill),
    isAgent: any((c) => c.isAgent),
    isCommand: any((c) => c.isCommand),
    isRule: any((c) => c.isRule),
    agentName: (f) => cs.find((c) => c.isAgent(f))?.agentName(f) ?? null,
  };
}

function skillName(path: string): string {
  return (
    path
      .replace(/\/SKILL\.md$/, "")
      .split("/")
      .pop() ?? path
  );
}

/**
 * The first prose paragraph of a SKILL.md body (after the frontmatter and any
 * leading `#` headings) — Claude Code's FALLBACK skill description when the
 * frontmatter omits `description`. Used so the trigger-surface check doesn't
 * overclaim "can't trigger" for a skill that has a usable body paragraph.
 */
function firstBodyParagraph(md: string): string | undefined {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const para: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      if (para.length > 0) break; // end of the first paragraph
      continue; // skip leading blanks / headings
    }
    para.push(t);
  }
  return para.join(" ").trim() || undefined;
}

/**
 * The body of a SKILL.md with the leading `---` frontmatter block stripped, PLUS
 * how many lines that block consumed.
 *
 * 🔴 The count is returned rather than discarded because a downstream detector
 * emits LINE NUMBERS. `markdownRefs` counts from one over whatever string it is
 * given, so a coordinate computed over the body is short by exactly the stripped
 * frontmatter — on a 5-line block, the ref on file line 11 printed as 6 (#206).
 * A struct instead of a bare string so the offset is in the caller's hand at the
 * call site, not something to remember.
 */
function skillBody(md: string): { body: string; strippedLines: number } {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const consumed = md.slice(0, md.length - body.length);
  // Newlines in the consumed prefix == lines before the body starts. Counts a
  // CRLF file identically (the `\r` rides along inside the line).
  return { body, strippedLines: consumed.split("\n").length - 1 };
}

/**
 * The on-disk path for a materialized file key. `loadPlugin` prefixes each
 * surface file with the layout's `materializeRoot` (e.g. `.claude/`), but the file
 * lives on disk WITHOUT that prefix (under the real surface dir), so a
 * bundled-resource existence check must strip it back off. Mirrors how
 * `resolveScript` resolves a hook path against the real plugin root.
 */
function onDiskPath(materializedKey: string, materializeRoot: string): string {
  if (!materializeRoot) return materializedKey;
  const prefix = `${materializeRoot}/`;
  return materializedKey.startsWith(prefix)
    ? materializedKey.slice(prefix.length)
    : materializedKey;
}

/** The plugin-root + materialize-root + dialect context skill scanning needs. */
export interface SkillScanContext {
  readonly root: string;
  readonly materializeRoot: string;
  readonly dialect: HarnessDialect;
  /**
   * Materialized-key → real on-disk path (from `loadPlugin`). A surface can be
   * materialized under a canonical key while living at a different root (repo-root
   * `skills/` vs project-level `.claude/skills/`), so bundled-resource resolution
   * uses the true dir from here rather than reverse-guessing from the key.
   */
  readonly sources?: Record<string, string>;
  /** OPT-IN top-level shared-resource dirs (`.vigilesrc.json` `sharedDirs`). */
  readonly sharedDirs?: readonly string[];
  /**
   * The REPO root the `sharedDirs` are declared relative to (where `.vigilesrc.json`
   * lives) — distinct from the scan `root`, which may be a scoped SUBDIR (e.g.
   * `lint packages/foo`). A shared-dir ref resolves against THIS, not the subdir,
   * so a scoped scan doesn't false-flag the top-level shared tree. Defaults to
   * `root` (unchanged when scanning the repo root itself).
   */
  readonly sharedDirsRoot?: string;
  /**
   * REQUIRED existence check for bundled-resource resolution. The disk scan
   * (`scanPlugin`) injects `node:fs` `existsSync`; the browser file-map engine
   * (`scanFiles`) a map-backed impl — so the same `scanSkills` runs on disk OR
   * in the browser with no `node:` import in this node-free module.
   */
  readonly existsSync: (p: string) => boolean;
}

/**
 * The path to REPORT for a scanned surface (dogfood E1). A plugin skill/agent is
 * materialized under a SYNTHETIC canonical key (the layout's `materializeRoot`
 * prefix, e.g. `.claude/agents/x.md`) that does NOT exist on disk; `sources[key]`
 * holds the real absolute on-disk path. Report the real path made REPO-RELATIVE —
 * clickable in the terminal AND valid as a GitHub annotation `file=` — falling
 * back to the canonical key when no source is recorded (a repo-root surface whose
 * key already IS the real relative path). A source resolving OUTSIDE the scan root
 * (a `..`-escape, unusual) keeps its real absolute path rather than a phantom.
 */
function reportedSurfacePath(
  canonicalKey: string,
  onDisk: string | undefined,
  root: string,
): string {
  if (onDisk === undefined) return canonicalKey;
  const rel = relative(root, onDisk);
  return rel !== "" && !rel.startsWith("..") ? rel : onDisk;
}

/**
 * Remap a batch of path-tagged findings from the synthetic materialize key to the
 * real on-disk path (dogfood E1) — in BOTH the `path` field AND any embedded
 * `message` (the detectors interpolate the key into their message text). Applied
 * at report assembly to the frontmatter-family findings, which iterate the loaded
 * file map's canonical keys directly (unlike ScanAgent/ScanSkill, whose `.path`
 * is already remapped). No-op for a finding whose key IS the real path.
 */
export function remapFindingPaths<
  T extends { readonly path: string; readonly message?: string },
>(findings: readonly T[], sources: Record<string, string>, root: string): T[] {
  return findings.map((f) => {
    const real = reportedSurfacePath(f.path, sources[f.path], root);
    if (real === f.path) return f;
    return {
      ...f,
      path: real,
      ...(typeof f.message === "string"
        ? { message: f.message.split(f.path).join(real) }
        : {}),
    };
  });
}

/**
 * Does the repo already ship its OWN test setup — a real `package.json` `test`
 * script, or a conventional test dir? Used by `audit` to credit an existing
 * testing story as OPTIONAL (a repo isn't scolded for surfaces with no vigiles
 * test when it clearly tests some other way). Node-free + injectable so the same
 * detector runs on disk (`node:fs`) AND in the browser (map-backed), keeping the
 * disk report and the demo report byte-identical (the OUTPUT-PARITY the
 * scanFiles-vs-scanPlugin gate enforces).
 */
export function detectOwnTestSignal(
  root: string,
  io: {
    readonly readFile: (p: string) => string;
    readonly existsSync: (p: string) => boolean;
  },
): boolean {
  const pkg = io.readFile(join(root, "package.json"));
  if (pkg !== "") {
    try {
      const { scripts } = JSON.parse(pkg) as {
        scripts?: Record<string, string>;
      };
      const t = scripts?.test?.trim();
      if (t !== undefined && t !== "" && !/no test specified/i.test(t))
        return true;
    } catch {
      /* malformed package.json — ignore */
    }
  }
  return ["test", "tests", "__tests__", "spec", join("src", "test")].some((d) =>
    io.existsSync(join(root, d)),
  );
}

export function scanSkills(
  files: Record<string, string>,
  cls: SurfaceClassifier,
  ctx: SkillScanContext,
): ScanSkill[] {
  const { root, materializeRoot, sharedDirs } = ctx;
  // `sharedDirs` are declared relative to the REPO root (config location), which
  // is `root` for a whole-repo scan but a PARENT when the scan is scoped to a
  // subdir. Resolve them against that, not the scoped subdir.
  const sharedDirsRoot = ctx.sharedDirsRoot ?? root;
  const out: ScanSkill[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isSkill(path)) continue;
    // Prefer the real on-disk dir (a `.claude/skills/…` skill materializes under
    // the same canonical key as a repo-root one, but lives elsewhere on disk).
    const onDiskDir = ctx.sources?.[path];
    const fm = frontmatter(md);
    // A skill's trigger surface is its frontmatter `description` OR — when that's
    // absent — Claude Code's fallback to the first body paragraph. Only when
    // NEITHER exists is the skill genuinely undescribed (can't be selected). The
    // explicit-frontmatter best-practice is the separate `skill-frontmatter` rule.
    const effectiveDesc = fm.description ?? firstBodyParagraph(md);
    const userInvoked = /^\s*disable-model-invocation:\s*true\s*$/m.test(md);
    // Bundled-resource refs resolve against the skill's OWN dir (resources ship
    // beside the SKILL.md), built from the plugin root + the file's ON-DISK dir
    // (the materialize-root prefix the loader added is stripped back off).
    const skillDir = onDiskDir
      ? dirname(onDiskDir)
      : resolve(root, dirname(onDiskPath(path, materializeRoot)));
    // Bundled refs resolve against the skill's OWN dir. A repo that shares a
    // top-level tree across skills (`sharedDirs` in .vigilesrc.json) ALSO resolves
    // a ref under one of those declared dirs against the repo root — OPT-IN, so a
    // repo that doesn't set it is byte-identical to before (no masking of a real
    // missing bundled resource). See feedback P1-4.
    const { body: bodyMd, strippedLines } = skillBody(md);
    const resourceIssues = skillResourceIssues(bodyMd, skillDir, {
      repoRoot: sharedDirsRoot,
      sharedDirs,
      existsSync: ctx.existsSync,
      // Findings carry a line number the author is meant to OPEN, so give the
      // detector back the frontmatter it never saw (#206).
      lineOffset: strippedLines,
    });
    // The lethal trifecta is a property of what a unit CAN do. For a SKILL that is
    // NOT its `allowed-tools:` — measured 2026-08-11, and documented by Claude Code
    // itself: that field PRE-APPROVES the tools it lists ("It does not restrict which
    // tools are available: every tool remains callable"), so a narrow list bounds
    // nothing. The one skill field measured to remove a tool from the pool is
    // `disallowed-tools:` (9 runs; it holds through the subagent boundary too). Read
    // that, and only that — see `skillTrifectaIssue` for the full measurement and for
    // why the two fence states are presented differently but graded the same.
    // Only a model-invocable skill can be hijacked by attacker content, so a
    // user-invoked one is excluded.
    const skillFence = parseAgentToolList(md, "disallowed-tools");
    // Whether that list came out of a block a strict loader REJECTS — a fence inside
    // frontmatter that does not parse is no fence. See `contractIsUnreadable`.
    const contractUnreadable = contractIsUnreadable(md);
    const trifecta = userInvoked
      ? null
      : skillTrifectaIssue(skillFence, ctx.dialect, { contractUnreadable });
    out.push({
      name: fm.name ?? skillName(path),
      // Report the real on-disk path, not the synthetic materialize key (E1).
      path: reportedSurfacePath(path, onDiskDir, root),
      hasDescription: Boolean(effectiveDesc && effectiveDesc.length >= 20),
      description: effectiveDesc?.trim(),
      userInvoked,
      resourceIssues,
      trifecta,
      // A SKILL.md opening with `name:`/`description:` but no `---` fence loads
      // as plain body → the skill is invisible. Inspect the RAW md (not the
      // frontmatter-stripped body) so the unfenced keys are visible.
      fenceIssue: skillMissingFence(md),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `(name, reported path, content)` triples `brokenSkillRefs` reads.
 *
 * 🔴 Built from the loaded file map's CANONICAL keys, NOT from `ScanSkill.path`.
 * That field is the REAL on-disk path (the E1 remap), and in the ordinary
 * published-plugin layout — `skills/foo/SKILL.md` — it is not a key of `files`
 * at all: the loader materializes those under `.claude/skills/foo/SKILL.md`.
 * Reading `files[skill.path]` therefore returned `undefined` for EVERY skill and
 * dropped it, so the check reported nothing on the layout plugins actually ship
 * in — including this repo's own. Measured 2026-08-11 on a two-skill fixture:
 * byte-identical content found 2 broken refs under `.claude/skills/` and 0 under
 * `skills/`. A silent no-op, which is the failure class this tool exists to
 * catch in other people's harnesses.
 *
 * The path is still remapped for the MESSAGE — a finding must name a file the
 * reader can open.
 */
export function skillRefSources(
  files: Record<string, string>,
  cls: SurfaceClassifier,
  ctx: { readonly root: string; readonly sources?: Record<string, string> },
): SkillRefSource[] {
  const out: SkillRefSource[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!cls.isSkill(path)) continue;
    out.push({
      name: frontmatter(content).name ?? skillName(path),
      path: reportedSurfacePath(path, ctx.sources?.[path], ctx.root),
      content,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Near-duplicate description pairs among the MODEL-INVOCABLE skills — the ones
 * that actually compete for auto-selection (a user-invoked skill is picked by
 * explicit command, so it can't collide). Uses the same effective-description
 * logic as `scanSkills` (frontmatter `description` ← first body paragraph), then
 * the NCD precision-proxy. See description-overlap.ts.
 */
function modelInvocableSkillSurfaces(
  files: Record<string, string>,
  cls: SurfaceClassifier,
  where?: SurfacePathContext,
): DescribedSurface[] {
  const surfaces: DescribedSurface[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isSkill(path)) continue;
    if (/^\s*disable-model-invocation:\s*true\s*$/m.test(md)) continue;
    const fm = frontmatter(md);
    const description = fm.description ?? firstBodyParagraph(md);
    if (!description || description.length < 20) continue;
    surfaces.push({
      name: fm.name ?? skillName(path),
      description,
      // The NAME alone stopped identifying a surface once the loader began
      // reading both discovery levels: a repo carrying `skills/x` AND
      // `.claude/skills/x` has two skills called `x`. Report the real path
      // (never the synthetic key) so the pair is actionable.
      ...(where
        ? {
            where: reportedSurfacePath(path, where.sources?.[path], where.root),
          }
        : {}),
    });
  }
  return surfaces;
}

/** Where a materialized key really lives — for reporting a surface by path. */
export interface SurfacePathContext {
  readonly root: string;
  readonly sources?: Record<string, string>;
}

export function descriptionOverlapsFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
  where?: SurfacePathContext,
): DescriptionOverlap[] {
  return findDescriptionOverlaps(
    modelInvocableSkillSurfaces(files, cls, where),
  );
}

/**
 * Model-invocable skills whose description is so long the trigger signal is
 * buried (heuristic proxy; degrades recall + precision). Same surfaces as the
 * overlap check. See skill-description-budget.ts.
 */
export function descriptionBudgetFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
): DescriptionBudgetIssue[] {
  return findDescriptionBudgetIssues(modelInvocableSkillSurfaces(files, cls));
}

export function scanAgents(
  files: Record<string, string>,
  dialect: HarnessDialect,
  declaredServers: readonly string[],
  cls: SurfaceClassifier,
  // Source-mapping context (dogfood E1): the scan `root` + the loader's canonical
  // key → real on-disk path map, so a materialized agent reports its REAL path
  // instead of the synthetic `.claude/agents/…` key. Optional so a caller that
  // doesn't materialize (no sources) is unchanged — the canonical key is used.
  ctx?: { root: string; sources?: Record<string, string> },
): ScanAgent[] {
  const out: ScanAgent[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isAgent(path)) continue;
    const tools = parseAgentTools(md);
    // Whether that list came out of a block a strict loader REJECTS — see
    // `contractIsUnreadable`. Scoped to the trifecta (the Safety ring) on
    // purpose: the typo / MCP / disallowed-tools cross-references below are
    // DIAGNOSTICS, and dropping them on a malformed file would delete real
    // findings — moving the grade in the optimistic direction this fix exists to
    // stop. A salvage is too weak to earn a unit a clean bill of health; it is
    // plenty strong enough to convict.
    const contractUnreadable = contractIsUnreadable(md);
    // An inherits-all agent (no `tools:` line) grants access to every tool
    // including every side-effecting one — pass the wildcard sentinel so
    // effectSurface correctly classifies it as `"unrestricted"`.
    const surface = effectSurface(tools ?? ["*"], dialect);
    // Classify ONCE; the scored and advisory halves are two views of one result,
    // so they cannot disagree about what the vocabulary said.
    const vocabIssues = tools ? verifyToolContract(tools, dialect) : [];
    out.push({
      // The layout-scoped identity, NOT the basename — see `agentSurfaceName`
      // for why recursion makes a basename unsafe here. Identical to the
      // basename for a top-level agent, so no existing report moves.
      name: cls.agentName(path) ?? basename(path, ".md"),
      path: ctx
        ? reportedSurfacePath(path, ctx.sources?.[path], ctx.root)
        : path,
      tools,
      // Cross-reference the declared rail against the dialect catalog — the moat.
      // The SCORED half only: a tool the platform withholds unconditionally, or a
      // name one edit from a real one (no two real names are that close, so that
      // is a typo). Everything else the vocabulary has an opinion about goes to
      // `toolNotes` — surfaced, never graded. See core/vocabulary.ts.
      toolIssues: tools ? scoredIssues(vocabIssues) : [],
      // Advisory: a real tool the platform withholds only under a condition
      // vigiles cannot see (`Agent` at the depth limit), and a name that is
      // simply not in our capture — which may mean the catalog is stale, not
      // that the contract is wrong.
      toolNotes: tools ? advisoryIssues(vocabIssues) : [],
      // The MCP half of the moat: an `mcp__server__tool` whose server isn't in the
      // plugin's declared set can't resolve. High-precision (gated on a declared
      // set, built-ins allowlisted, plugin-namespaced form skipped). See mcp-tool.ts.
      mcpToolIssues: tools
        ? verifyMcpToolServers(tools, declaredServers, dialect)
        : [],
      // The block-list mirror: a `disallowedTools:` entry that's a typo of a real
      // tool blocks nothing (close-typo only — high-precision). See tool-contract.ts.
      disallowedToolIssues: disallowedToolIssues(
        parseAgentToolList(md, "disallowedTools") ?? [],
        dialect,
      ),
      purity: surface.purity,
      effectBuckets: {
        readOnly: surface.readOnly,
        sideEffecting: surface.sideEffecting,
        unknown: surface.unknown,
      },
      // The lethal trifecta: a subagent whose contract grants all three legs. An
      // inherits-all agent (no `tools:` line → tools === null) is the advisory
      // case — pass the wildcard sentinel so it's distinguished from an EXPLICIT
      // empty `tools: []` (zero tools → no trifecta). One detector, no drift.
      trifecta: lethalTrifectaIssues(tools ?? ["*"], dialect, {
        contractUnreadable,
      }),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a hook script token to a checkable path. `loadPlugin` expands the
 * braced plugin-root token (`${CLAUDE_PLUGIN_ROOT}`, Codex `${PLUGIN_ROOT}`, …);
 * the unbraced shell form survives, so resolve BOTH forms of the HARNESS's token
 * (from the layout, not hard-coded) against the plugin root and strip shell
 * quotes. A token that still carries any `$VAR` after that is genuinely
 * uncheckable.
 */
function resolveScript(
  token: string,
  root: string,
  pluginRootToken: string,
  fullCommand: string,
  exists: (p: string) => boolean,
): ScanHook {
  // "${CLAUDE_PLUGIN_ROOT}" → unbraced "$CLAUDE_PLUGIN_ROOT".
  const unbraced = pluginRootToken.replace(/^\$\{(.+)\}$/, "$$$1");
  const cleaned = token
    .replace(/["']/g, "")
    .replaceAll(pluginRootToken, root)
    .replaceAll(unbraced, root);
  if (cleaned.includes("$"))
    return { command: fullCommand, script: token, status: "unresolved" };
  // A relative hook path (`./hooks/x.sh`, `scripts/x.py`) is the plugin's own —
  // resolve it against the PLUGIN ROOT, not the scanner's cwd. Without this, a
  // plugin that references `./hooks/x.sh` (the file IS present) was reported
  // MISSING because existsSync() checked cwd-relative (a false positive caught on
  // ananddtyagi/cc-marketplace). The displayed `script` stays as the author wrote it.
  const abs = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned);
  // Resolve the full command the same way we resolve the script token (expand
  // plugin-root, strip outer quotes) so the CLI can pass it to verifyGuardrail.
  const resolvedCommand = fullCommand
    .replaceAll(pluginRootToken, root)
    .replaceAll(unbraced, root);
  return {
    command: resolvedCommand,
    script: cleaned,
    status: exists(abs) ? "ok" : "missing",
  };
}

// A shell existence guard around a command — `[ ! -f x ] || x`, `[ -f x ] && x`,
// `test -f x && …`. Authors use it to make a hook OPTIONAL (run the script only
// if present; a no-op otherwise — e.g. a runtime-generated guard), so a missing
// target is INTENTIONAL, not a broken reference. Don't flag scripts in such a
// command as MISSING (a false positive caught on gmickel/flow-next's ralph-guard).
const EXISTENCE_GUARD =
  /(?:\[\[?\s*!?\s*-[efsx]\s)|(?:\btest\s+!?\s*-[efsx]\s)/;

/**
 * A compiled `vigiles/hook` artifact runs through the `hook-runtime run-program`
 * runtime entrypoint; any other hook command is hand-written (a shell script or
 * an inline one-liner) the author maintains directly. The basis for the
 * `prefer-compiled-hooks` nudge.
 */
export function isManagedHookCommand(command: string): boolean {
  return /\bhook-runtime\b/.test(command);
}

/** The `prefer-compiled-hooks` recommendation message (shared by `lint` + `scan`). */
export function preferCompiledHooksMessage(count: number): string {
  return (
    `${String(count)} hand-written hook command(s) — if any gate the agent ` +
    `(a block/deny decision), compiled hooks (\`vigiles/hook\`) make whole hook ` +
    `bug classes unrepresentable at authoring time, and \`guardrail-check\` proves ` +
    `an existing one blocks. See docs/compiled-hooks.md.`
  );
}

/** Pull script-file hook commands out of the resolved settings; count inline ones. */
/**
 * Best-effort map of each script token → the hook EVENT it's registered under,
 * by walking the canonical object-keyed-by-event settings shape
 * (`{ PreToolUse: [{ hooks: [{ command }] }], … }`). Lets the safety battery
 * scope itself to `PreToolUse` (the only event that can block a tool call), so a
 * `SessionStart`/`PostToolUse`/`Stop` hook isn't tested against the disaster
 * catalog. Returns an empty map for a non-object/array config (event → unknown).
 */
function eventsByScript(
  regs: readonly HookRegistration[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const reg of regs) {
    for (const tok of scriptTokens(reg.command) ?? []) {
      if (!map.has(tok)) map.set(tok, reg.event);
    }
  }
  return map;
}

export function scanHooks(
  regs: readonly HookRegistration[],
  root: string,
  pluginRootToken: string,
  exists: (p: string) => boolean,
): { hooks: ScanHook[]; inline: number; manual: number } {
  const commands = regs.map((r) => r.command);
  const evMap = eventsByScript(regs);
  // A hand-written hook is any non-empty command that isn't a vigiles-managed
  // (compiled) hook-runtime invocation — the basis for the prefer-compiled-hooks nudge.
  const manual = commands.filter((c) => {
    const u = c.trim();
    return u !== "" && !isManagedHookCommand(u);
  }).length;
  const byScript = new Map<string, ScanHook>();
  let inline = 0;
  for (const cmd of commands) {
    const found = scriptTokens(cmd);
    if (!found || found.length === 0) {
      inline++;
      continue;
    }
    // A guarded command runs its script only if it exists — an optional hook, not
    // a broken one. Treat it as a conditional one-liner (inline), don't path-check.
    if (EXISTENCE_GUARD.test(cmd)) {
      inline++;
      continue;
    }
    for (const tok of found) {
      const hook = resolveScript(tok, root, pluginRootToken, cmd, exists);
      const event = evMap.get(tok);
      byScript.set(hook.script, event ? { ...hook, event } : hook);
    }
  }
  const hooks = [...byScript.values()].sort((a, b) =>
    a.script.localeCompare(b.script),
  );
  return { hooks, inline, manual };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Frontmatter-schema check — **subagents only**. Per the Claude Code docs, a
 * subagent (`agents/*.md`) REQUIRES `name` + `description` (no fallback) or it
 * won't register. A SKILL.md requires NOTHING: `name` falls back to the directory
 * name and `description` to the first body paragraph, so a frontmatter-less skill
 * still loads — flagging it would be a false positive (skill description QUALITY
 * is a separate, behavioral concern). See https://code.claude.com/docs/en/skills
 * and …/sub-agents.
 */
export function frontmatterIssuesFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
): FrontmatterIssue[] {
  const out: FrontmatterIssue[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isAgent(path)) continue; // skills require no frontmatter (dir/body fallbacks)
    const fm = frontmatter(md);
    const missing: ("name" | "description")[] = [];
    if (!fm.name) missing.push("name");
    if (!fm.description) missing.push("description");
    if (missing.length === 0) continue;
    out.push({
      path,
      kind: "agent",
      missing,
      message: `agent ${path} is missing required frontmatter: ${missing.join(", ")} — it won't register.`,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The canonical subagent `model:` aliases and `color:` enum (Claude Code). The
// model check skips a full/dated id (`claude-sonnet-4-5`) — that's a valid
// explicit form, not a typo — so only an alias misspelling is caught.
const MODEL_ALIASES = ["inherit", "sonnet", "opus", "haiku"];
const AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
];

/**
 * Closest candidate by edit distance, ONLY when it's a high-confidence typo: the
 * value isn't already a candidate, and the nearest is within 2 edits. Returns
 * null otherwise — a far-off value is more likely an unknown-we-don't-know than a
 * typo (the high-precision discipline), so it's suppressed, not flagged.
 */
function closeCandidate(
  value: string,
  candidates: readonly string[],
): string | null {
  const v = value.toLowerCase();
  if (candidates.includes(v)) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const dist = editDistance(v, c);
    if (dist < bestDistance) {
      bestDistance = dist;
      best = c;
    }
  }
  return bestDistance > 0 && bestDistance <= 2 ? best : null;
}

/**
 * Agent frontmatter VALUE validity — a `model:` or `color:` that's a close typo
 * of a real one. A bad `model:` silently falls back; a bad `color:` is ignored.
 * High-precision (close-typo only); a full/dated model id is left alone. Folded
 * into the `subagent-frontmatter` rule. Agents only (skills have no model/color).
 */
export function frontmatterValueIssuesFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
): FrontmatterValueIssue[] {
  const out: FrontmatterValueIssue[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isAgent(path)) continue;
    const fm = frontmatter(md);
    // A model id with a digit/hyphen is an explicit form, not an alias typo.
    if (fm.model && !/[0-9-]/.test(fm.model)) {
      const near = closeCandidate(fm.model, MODEL_ALIASES);
      if (near) {
        out.push({
          path,
          field: "model",
          value: fm.model,
          suggestion: near,
          message: `agent ${path} has model "${fm.model}", not a known alias — it silently falls back. Did you mean "${near}"?`,
        });
      }
    }
    if (fm.color) {
      const near = closeCandidate(fm.color, AGENT_COLORS);
      if (near) {
        out.push({
          path,
          field: "color",
          value: fm.color,
          suggestion: near,
          message: `agent ${path} has color "${fm.color}", not a valid color — it's ignored. Did you mean "${near}"?`,
        });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Frontmatter that EXISTS but isn't valid YAML — the `frontmatter-valid` signal.
 * Reported for skills + agents via the shared reader's `malformed` flag. Honest
 * caveat (see docs/rules/frontmatter-valid.md): js-yaml is stricter than some
 * loaders, so a one-line `description:` containing a `: ` colon or an `<example>`
 * block is flagged even though it may still load — which is why scan surfaces it
 * as an informational note (NOT a structural defect) and the lint rule is a
 * warn, not an error. The file's other fields are still salvaged.
 */
export function malformedFrontmatterFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
): FrontmatterParseIssue[] {
  const out: FrontmatterParseIssue[] = [];
  for (const [path, md] of Object.entries(files)) {
    // Rules join skills + agents here: `.claude/rules/*.md` carries a `paths:`
    // frontmatter key that SCOPES the instruction, so unparseable YAML there
    // silently changes which files the rule applies to — the same defect this
    // check exists for, on a surface no layout named until now (#175.3).
    if (!cls.isSkill(path) && !cls.isAgent(path) && !cls.isRule(path)) continue;
    if (!readFrontmatter(md).malformed) continue;
    out.push({
      path,
      message: `${path}: frontmatter is not valid YAML — fields may not parse as intended (a colon, quote, or bracket likely needs escaping/quoting).`,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Skill-metadata RECOMMENDATION (not a correctness check): a `SKILL.md` loads
 * fine without frontmatter (`name` ← dir, `description` ← first body paragraph),
 * but relying on those fallbacks is fragile — the dir name may be unclear and the
 * first paragraph is often a heading or boilerplate, making a weak trigger
 * surface. Best practice is an EXPLICIT `name` + `description`. Flags skills
 * missing either; surfaced as a soft note in scan (NOT a structural defect, NOT
 * scored) and gated by the `skill-frontmatter` lint rule (warn by default).
 */
export function skillMetaIssuesFor(
  files: Record<string, string>,
  cls: SurfaceClassifier,
): FrontmatterIssue[] {
  const out: FrontmatterIssue[] = [];
  for (const [path, md] of Object.entries(files)) {
    if (!cls.isSkill(path)) continue;
    const fm = frontmatter(md);
    const missing: ("name" | "description")[] = [];
    if (!fm.name) missing.push("name");
    if (!fm.description) missing.push("description");
    if (missing.length === 0) continue;
    out.push({
      path,
      kind: "skill",
      missing,
      message: `skill ${path} has no explicit frontmatter ${missing.join(" / ")} — recommended for a reliable trigger surface (it still loads via the dir-name / first-paragraph fallback).`,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Flatten the per-surface lethal-trifecta + skill-resource findings into the
 * path-tagged report lists the `audit` report AND the `lethal-trifecta` /
 * `skill-resource-resolves` lint rules both consume (one detector, no drift).
 */
export function collectSurfaceFindings(
  agents: readonly ScanAgent[],
  skills: readonly ScanSkill[],
): {
  trifectaFindings: ScanTrifectaFinding[];
  skillResourceFindings: ScanSkillResourceFinding[];
  skillFenceFindings: ScanSkillFenceFinding[];
} {
  const trifectaFindings: ScanTrifectaFinding[] = [];
  for (const a of agents) {
    if (a.trifecta) {
      trifectaFindings.push({
        path: a.path,
        kind: "subagent",
        name: a.name,
        finding: a.trifecta,
      });
    }
  }
  for (const s of skills) {
    if (s.trifecta) {
      trifectaFindings.push({
        path: s.path,
        kind: "skill",
        name: s.name,
        finding: s.trifecta,
      });
    }
  }
  const skillResourceFindings: ScanSkillResourceFinding[] = skills.flatMap(
    (s) =>
      s.resourceIssues.map((finding) => ({
        path: s.path,
        name: s.name,
        finding,
      })),
  );
  const skillFenceFindings: ScanSkillFenceFinding[] = skills.flatMap((s) =>
    s.fenceIssue ? [{ path: s.path, name: s.name, finding: s.fenceIssue }] : [],
  );
  return { trifectaFindings, skillResourceFindings, skillFenceFindings };
}

/**
 * Build the subagent delegation graph and flag a lethal trifecta that EMERGES
 * across an edge (own ∪ delegated-to capability) though no single unit trips it.
 *
 * Edge source (deterministic, audit-available): a subagent that lists the `Task`
 * tool can dispatch any sibling subagent, so it `delegatesTo` every OTHER agent.
 * An inherits-all agent (`tools === null`) carries the wildcard, which the
 * detector's FP-safe guard skips (that maximal-blast case is the per-unit
 * advisory's job). One detector, no drift. (Richer edge sources — a typed
 * railway's `delegate()` chain, a Flue subagent inheritance tree — plug in here.)
 */
export function collectDelegationTrifecta(
  agents: readonly ScanAgent[],
  dialect: HarnessDialect,
): ScanDelegationFinding[] {
  const allNames = agents.map((a) => a.name);
  const nodes: CapabilityNode[] = agents.map((a) => {
    const canDispatch =
      a.tools === null ||
      a.tools.some((t) => t === "Task" || t.startsWith("Task("));
    return {
      name: a.name,
      kind: "agent",
      tools: a.tools ?? ["*"],
      delegatesTo: canDispatch ? allNames.filter((n) => n !== a.name) : [],
    };
  });
  // 🔴 A NAME IS NOT AN IDENTITY HERE, and this map used to assume it was.
  // `new Map(agents.map((a) => [a.name, a.path]))` keeps the LAST entry for a
  // repeated key, so when the same agent name exists in two discovery scopes —
  // `agents/foo.md` and `.claude/agents/foo.md`, which Claude registers in
  // DIFFERENT namespaces — a finding about the first was reported against the
  // second's file. A lethal-trifecta finding that names the wrong file is worse
  // than one that names none: it sends the reader to audit innocent code and
  // leaves the real surface unexamined.
  //
  // Until identity is scope-qualified through the whole delegation pipeline (the
  // proper fix, and a larger one — `finding.name` itself carries only the bare
  // name), an ambiguous name resolves to NO path rather than to an arbitrary one.
  // Nothing changes for the overwhelmingly common case of distinct names.
  const pathByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const a of agents) {
    if (pathByName.has(a.name)) ambiguous.add(a.name);
    else pathByName.set(a.name, a.path);
  }
  return delegationTrifectaIssues(nodes, dialect).map((finding) => ({
    path: ambiguous.has(finding.name)
      ? ""
      : (pathByName.get(finding.name) ?? ""),
    finding,
  }));
}

/**
 * Build `hookBlockIssues` entries by walking the canonical object-keyed-by-event
 * settings shape PER REGISTRATION — so a script registered under several events
 * is inspected under EACH (no de-dup by script path), inline one-liners are
 * included (script token → null, inspect the command), and a script token is
 * resolved to its ABSOLUTE on-disk path against the plugin root (not the caller's
 * cwd). Addresses the gaps a de-duplicated `ScanHook[]` would miss.
 */
export function collectHookBlockEntries(
  regs: readonly HookRegistration[],
  root: string,
  pluginRootToken: string,
  exists: (p: string) => boolean,
): HookScriptEntry[] {
  const out: HookScriptEntry[] = [];
  for (const { event, command: cmd } of regs) {
    // A wrapper command runs MORE than one script (`node run.cjs guard.mjs`),
    // so resolve EVERY candidate and inspect each — reading only the first
    // (the wrapper) would miss the guard's block logic. Candidates: extensioned
    // script-shaped words PLUS path-like words with NO extension
    // (`bash hooks/guard`, `${ROOT}/hooks/session-start`) that resolve to a file.
    // Words the SHELL would resolve — not a split on whitespace, which cannot
    // see quoting and cannot tell `node -e '<program>'` from an operand.
    const words = commandWords(cmd) ?? [];
    const candidates = new Set<string>(
      words.filter((w) => SCRIPT_WORD_RE.test(w)),
    );
    for (const w of words) {
      if (w.includes("/") || w.includes(pluginRootToken)) candidates.add(w);
    }
    const resolvedPaths: string[] = [];
    for (const tok of candidates) {
      const r = resolveScript(tok, root, pluginRootToken, cmd, exists);
      if (r.status === "ok") {
        const abs = isAbsolute(r.script) ? r.script : resolve(root, r.script);
        if (!resolvedPaths.includes(abs)) resolvedPaths.push(abs);
      }
    }
    if (resolvedPaths.length > 0) {
      // One entry per resolvable script (each is inspected on its own).
      for (const sp of resolvedPaths) {
        out.push({ event, command: cmd, scriptPath: sp });
      }
    } else {
      // No script file resolved → inline one-liner; inspect the command text.
      out.push({ event, command: cmd, scriptPath: null });
    }
  }
  return out;
}

/** Extract (event, matcher) pairs from the normalized hook registrations. */
export function collectHookMatchers(
  regs: readonly HookRegistration[],
): HookMatcherEntry[] {
  const seen = new Set<string>();
  const out: HookMatcherEntry[] = [];
  for (const { event, matcher } of regs) {
    if (matcher === null) continue;
    const key = `${event}\u0000${matcher}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ event, matcher });
  }
  return out;
}

/** Tally how many scanned agents fall into each purity rung (effectSurface). */
export function summarizePurity(agents: readonly ScanAgent[]): {
  pure: number;
  bounded: number;
  unrestricted: number;
} {
  return agents.reduce(
    (acc, a) => {
      acc[a.purity]++;
      return acc;
    },
    { pure: 0, bounded: 0, unrestricted: 0 },
  );
}

// ---------------------------------------------------------------------------
// Vocabulary notes — the advisory half of the findings
// ---------------------------------------------------------------------------
// These live HERE, not in scan.ts, because both engines produce them and only
// this module is node-free. Importing them from scan.ts pulled the node-only
// graph (down to `@ast-grep/napi`'s native .node binding) into the browser
// bundle and broke the site build — the gate that owns this invariant.

/**
 * Gather the advisory half of the vocabulary findings for the report. Kept in
 * one place so hook events and subagent tools present identically — the two used
 * to answer the same question with different policies.
 */
export function collectVocabularyNotes(
  hookEventIssues: readonly HookEventIssue[],
  agents: readonly ScanAgent[],
): VocabularyNote[] {
  return [
    ...advisoryIssues(hookEventIssues).map((i) => ({
      where: `hook event "${i.event}"`,
      message: i.message,
    })),
    ...agents.flatMap((a) => groupAgentToolNotes(a)),
  ];
}

/**
 * One agent's advisory tool notes, with the `conditional` ones GROUPED by the
 * condition they share. A delegating subagent legitimately declares eight
 * foreground-only tools; printing the same sentence eight times is noise, and
 * noise is what this whole change exists to stop producing. Unrecognised names
 * stay one-per-tool — each carries its own did-you-mean.
 */
function groupAgentToolNotes(agent: ScanAgent): VocabularyNote[] {
  const notes = advisoryIssues(agent.toolNotes ?? []);
  const byCondition = new Map<string, string[]>();
  const out: VocabularyNote[] = [];
  for (const i of notes) {
    if (i.verdict === "conditional" && i.condition !== undefined) {
      const at = byCondition.get(i.condition) ?? [];
      at.push(i.tool);
      byCondition.set(i.condition, at);
      continue;
    }
    out.push({ where: agent.path, message: i.message });
  }
  for (const [condition, tools] of byCondition)
    out.push({
      where: agent.path,
      message:
        `${tools.join(", ")} ${tools.length === 1 ? "is a real tool" : "are real tools"}, ` +
        `but the platform removes ${tools.length === 1 ? "it" : "them"} ${condition}. ` +
        `vigiles cannot see that condition from the file, so this is a note, not a defect.`,
    });
  return out;
}
