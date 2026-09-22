/**
 * PluginLayout — the plugin/repo LAYOUT port (hexagonal format axis, the
 * filesystem half). A harness's plugin layout is where its instruction file,
 * skills, subagents, commands, hooks and settings live on disk, plus the env
 * token expanded to the plugin root. The loader (`loadPlugin`) reads those from
 * this descriptor instead of hard-coding Claude Code's `.claude-plugin/` /
 * `.claude/` conventions, so a second harness (Codex) supplies its own
 * `PluginLayout` and reuses the same loader.
 *
 * Paths are repo-relative (POSIX-style, `join`-friendly). The Claude Code
 * implementation is `claudeCodeLayout` in `src/adapters/claude-code/layout.ts`.
 */
import type { InstructionChain } from "./instruction-chain.js";
import type { SettingsCodec } from "./settings-codec.js";

/**
 * The three kinds of MODEL SURFACE — a thing a session can invoke by name.
 *
 * Instructions are deliberately not here: an instruction is READ, a surface is
 * CALLED. That is why {@link PluginLayout.rulesDir} is not a key — counted, not
 * felt: five of the seven consumers that range over the surfaces would have had
 * to grow a `kind !== "rules"` branch (the empty-machine decision, the per-kind
 * counts, the shape table, the known-homes map, `executableSourceDirs`), which
 * is the per-value branch this record exists to remove.
 */
export type SurfaceKind = "skill" | "agent" | "command";

/**
 * Where each model surface lives, keyed by kind — repo-relative and COMPLETE
 * (`.agents/skills`, never `skills` under a root the reader has to remember).
 *
 * A kind with no entry is a surface this harness does not have, and that is the
 * ONLY spelling of "none": there is no `""`.
 *
 * 🔴 A RECORD, NOT A LIST, AND NOT A SECOND FIELD BESIDE A LIST. What this
 * replaced was `surfaceDirs: readonly string[]` standing beside `skillDir`,
 * `agentDir` and `commandDir` — four places naming the same three directories,
 * with nothing relating them. `opencodeLayout` disagreed with itself in exactly
 * the way that invites: `skillDir: ".opencode/skill"` while `surfaceDirs` held
 * only the agent and command dirs, so OpenCode's skills were named by the port
 * and never read by anything. With one record there is no second place to
 * disagree with, `surfaceDirs()` is derived, and a duplicate kind is a
 * duplicate object key (TS1117) rather than a conformance finding.
 */
export type SurfaceDirs = Readonly<Partial<Record<SurfaceKind, string>>>;

/**
 * Where one harness keeps the files vigiles reads: its instruction file, its
 * model surfaces, its hook registrations and settings, plus the env token
 * expanded to the plugin root. The loader reads all of it from this descriptor
 * rather than hard-coding one harness's conventions, which is what lets a
 * second harness be a VALUE passed to the same loader instead of a fork of it.
 *
 * 🔴 EVERY FIELD HOLDS ITS FACT ONCE. Four of the fields this interface used to
 * have were second copies of a fact another field already held — `surfaceDirs`
 * beside `skillDir`/`agentDir`/`commandDir`, `intraRefDirs` beside both, and
 * `materializeRoot` beside `userSurfaceRoot` — and nothing related the copies,
 * so a layout could disagree with itself and no check would see it. One did:
 * `opencodeLayout` named a skill dir that `surfaceDirs` omitted, and OpenCode's
 * skills were read by nothing. The copies are now `surfaceDirs()`,
 * `executableSourceDirs()` and `materializePrefix()` — functions of what is
 * left, so there is no second place to disagree with.
 */
export interface PluginLayout {
  /** Stable identifier, e.g. "claude-code". */
  readonly name: string;
  /** Plugin manifest, e.g. `.claude-plugin/plugin.json`. */
  readonly manifestPath: string;
  /**
   * The conventional standalone hooks FILE a plugin may ship instead of inline
   * registrations, e.g. `hooks/hooks.json`. A file, never a directory.
   *
   * Optional because OpenCode has no such file — its `.opencode/plugin` is a
   * DIRECTORY of JS modules, and naming it here made every reader that treats
   * this as a file (dirname, parse, round-trip) wrong about it.
   */
  readonly hooksConventionPath?: string;
  /** Repo settings carrying hooks, e.g. `.claude/settings.json` or `.codex/config.toml`. */
  readonly settingsPath: string;
  /**
   * How {@link manifestPath} and {@link settingsPath} are ENCODED — a codec,
   * not a format name. It knows bytes-to-value and nothing about what the value
   * means; the hooks-entry SHAPE lives on `HookProtocol.registration`.
   *
   * 🔴 IT USED TO BE `settingsFormat: "json" | "toml"`, and nine call sites
   * branched on it. The type had exactly two inhabitants and both were ours, so
   * a third-party adapter whose settings are YAML could declare nothing the
   * core would honour — and the conformance kit re-checked the enum, which is
   * the tell: a data field whose legal values the core already knows is not
   * data, it is a hidden `switch`. Six of the nine branches were the encoding
   * and are now `settings.parse` / `settings.render`; three were the entry
   * shape and moved to the port that owns shapes.
   */
  readonly settings: SettingsCodec;
  /** Top-level instruction file, e.g. `CLAUDE.md`. */
  readonly instructionFile: string;
  /**
   * Where each model surface lives — see {@link SurfaceDirs}. At least one kind
   * is required (conformance); a kind this harness does not have is an absent
   * key, never `""`.
   */
  readonly surfaces: SurfaceDirs;
  /**
   * The dot-directory a plain END USER keeps the same surfaces under, when the
   * harness has such a second home (`.claude` → `.claude/skills`). When set,
   * every surface is read from BOTH `<surface>` and `<userSurfaceRoot>/<surface>`,
   * and this is ALSO the prefix a relocated scope is keyed under.
   *
   * 🔴 IT USED TO BE TWO FIELDS. `materializeRoot` sat beside this one and was
   * EQUAL to it in all three shipped layouts (`.claude`/`.claude`, `""`/absent,
   * `""`/absent) while having no defined meaning when they differed — the
   * scope-key guard existed precisely to catch a layout that named `.claude` as
   * both its materialize root and a second scope's base, and with one field that
   * state cannot be written. Absent means the surfaces have exactly one home and
   * file-map keys equal on-disk paths; see {@link materializePrefix}.
   */
  readonly userSurfaceRoot?: string;
  /**
   * Path-scoped RULES dir, holding flat `<dir>/<name>.md`, e.g. `rules`
   * (absent = this harness has no such layer; `""` is refused by conformance).
   *
   * Claude Code loads `.claude/rules/*.md` as project instructions, scoped by a
   * `paths:` frontmatter key. It is an INSTRUCTION surface — often where a
   * team's hardest policies actually live — and until now no layout named it, so
   * `frontmatter-valid` and the rule map simply never saw those files. An
   * adopter reported five such files arriving in a session labelled "project
   * instructions" while `lint` did not mention them at all (#175.3).
   *
   * Not a {@link SurfaceKind}: an instruction is read, not invoked — see the
   * docblock there for the count behind that.
   */
  readonly rulesDir?: string;
  /**
   * The WORD a per-machine settings sibling inserts before the extension, e.g.
   * `local` → `.claude/settings.local.json` (absent = this harness has no
   * per-machine settings layer that we have OBSERVED).
   *
   * 🔴 THE CORE USED TO SYNTHESIZE THIS FOR EVERYBODY, and the function it used
   * says on its own docblock why that cannot be right: "Both vendors name a
   * per-machine file by inserting a word before the extension, and they choose
   * DIFFERENT words — Claude Code `local`, Codex `override` — so the word is the
   * argument and the spelling is not." `settingsSourcePaths` passed `"local"`
   * unconditionally three lines below it, so a Codex repository holding
   * `.codex/config.local.toml` had that file read as a real settings layer, and
   * a `project_doc_fallback_filenames` in it could name an instruction file we
   * then scored — out of a file the harness never opens. `opencode.local.json`
   * the same.
   *
   * Absence is the honest default: only the adapter knows whether its vendor
   * has such a layer, and we model what has been observed rather than what is
   * plausible by analogy. Every other {@link siblingNamed} caller already lives
   * in an adapter for exactly this reason.
   */
  readonly settingsLocalInfix?: string;
  /**
   * Which of the instruction-shaped files the DOMAIN enumerated this harness
   * loads at a repo-root session, in load order — and for every one it does not
   * load, WHY. Pure: a function of `files` alone, with no root, no `node:`
   * module and no way to name a path the domain did not open.
   *
   * 🔴 IT REPLACED A GLOB MINI-LANGUAGE AND ITS PRIVATE INTERPRETER.
   * `HarnessDialect.instructionBudget.alwaysLoaded` was an array of globs an
   * ADAPTER wrote and the CORE walked the repository to expand, so shipping
   * `"**\/AGENTS.md"` made vigiles read every directory of somebody else's
   * project. See `./instruction-chain.ts` for the three defects that had, and
   * for why none of them is expressible as a better glob.
   *
   * {@link instructionFile} still names the PRIMARY root file — the one
   * `compile` writes, `init` scaffolds and `detect` scores. Whether it is in the
   * loaded chain, and what else is, is this method's answer and never that
   * field's.
   */
  instructionChain(files: Readonly<Record<string, string>>): InstructionChain;
  /**
   * The directory a plugin keeps its EXECUTABLE HOOK SCRIPTS in (`hooks`) —
   * distinct from where the hooks are REGISTERED ({@link hooksConventionPath},
   * {@link settingsPath}). Absent means the harness has no scripts directory to
   * scan (OpenCode's hooks are in-process code modules).
   *
   * 🔴 IT REPLACES TWO AD-HOC DERIVATIONS AND ONE HAND-WRITTEN LIST, which is
   * why it is a field rather than something computed at each site. The list was
   * `intraRefDirs`, written out per layout and therefore free to disagree with
   * the surfaces beside it (on `opencode` it did, dropping the skill dir). The
   * derivations were `hooksConventionPath.split("/")[0]`, copied into `scan.ts`
   * and `scan-files.ts` — which reads `hooks` from `hooks/hooks.json` but
   * `.codex` from `.codex/hooks.json`, i.e. it did not name a scripts directory
   * at all for Codex. Both are now {@link executableSourceDirs}.
   */
  readonly hookScriptsDir?: string;
  /** Env token expanded to the plugin's absolute root in hook commands. */
  readonly pluginRootToken: string;
  /**
   * Tokens that root a path at the PROJECT being scanned, braced form
   * (`${CLAUDE_PROJECT_DIR}`); the unbraced spelling is derived. Optional — a
   * harness with no such variable omits it.
   *
   * 🔴 SEPARATE FROM {@link pluginRootToken}, and its absence made a whole
   * surface kind invisible. `hookScripts` stripped only the plugin token, so a
   * project's own `"$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` — Claude Code's
   * DOCUMENTED spelling for a project hook, because hooks do not run with a
   * stable cwd — failed `existsSync` and was dropped. MEASURED on a real
   * consumer repo: `audit` listed sixteen hooks and the SURFACE list held zero.
   */
  readonly projectRootTokens?: readonly string[];
  /** Standalone MCP config file, e.g. `.mcp.json`. */
  readonly mcpConfigFile: string;
  /** Manifest key declaring MCP servers, e.g. `mcpServers`. */
  readonly mcpManifestKey: string;
}

/** The kinds, in the order every derived list emits them. Iterating a record's
 *  own keys would make the output depend on literal order in each layout; this
 *  makes it depend on nothing. */
export const SURFACE_KINDS = ["skill", "agent", "command"] as const;

/**
 * Every surface dir a layout declares — what the `surfaceDirs` FIELD used to
 * be, minus the possibility of disagreeing with the per-kind fields, because
 * there are no per-kind fields left to disagree with.
 */
export function surfaceDirs(layout: PluginLayout): readonly string[] {
  return SURFACE_KINDS.map((k) => layout.surfaces[k]).filter(
    (d): d is string => d !== undefined,
  );
}

/**
 * Dirs whose non-prose files are scanned for intra-plugin references, and
 * checked for misplacement inside the manifest dir: the surfaces plus
 * {@link PluginLayout.hookScriptsDir}.
 *
 * Equal to the old hand-written `intraRefDirs` as a SET on Claude Code and
 * Codex; on `opencode` it gains `.opencode/skill`, which the hand list had left
 * out along with the rest of that layout's skill surface.
 */
export function executableSourceDirs(layout: PluginLayout): readonly string[] {
  const dirs = surfaceDirs(layout);
  return layout.hookScriptsDir === undefined
    ? dirs
    : [...dirs, layout.hookScriptsDir];
}

/**
 * The prefix a relocated surface is keyed under — `userSurfaceRoot` when the
 * harness has a second home for its surfaces, `""` when the surfaces carry
 * their own prefix and a file-map key equals the on-disk path.
 *
 * One line, named, because it used to be a FIELD (`materializeRoot`) and the
 * only thing that kept it equal to `userSurfaceRoot` was that nobody had
 * written a layout where they differed.
 */
export function materializePrefix(layout: PluginLayout): string {
  return layout.userSurfaceRoot ?? "";
}

/**
 * How DEEP a harness reads its {@link PluginLayout.agentDir} — the one statement
 * of that rule, as a RegExp source fragment matching the part of a path AFTER
 * `<agentDir>/`. Anchor-free on purpose, so each caller can bound it its own way
 * (`(?:^|/)agents/` + this + `$` in the scan classifier; `^<prefix>/` + this +
 * `$` in the coverage discoverers).
 *
 * 🔴 IT USED TO SAY `[^/]+`, in THREE independent places, and the vendor
 * documents the opposite. Verbatim from `https://code.claude.com/docs/en/sub-agents`:
 *
 * > Claude Code scans `.claude/agents/` and `~/.claude/agents/` **recursively**,
 * > so you can organize definitions into subfolders such as `agents/review/` or
 * > `agents/research/`.
 *
 * > **Plugin `agents/` directories are also scanned recursively.** Unlike project
 * > and user scopes, a subfolder inside a plugin's `agents/` directory becomes
 * > part of the scoped identifier: a file at `agents/review/security.md` in
 * > plugin `my-plugin` registers as `my-plugin:review:security`.
 *
 * Measured 2026-08-18 on `rsmdt/the-startup` @ `88d447c7`: 16 agent files under
 * `plugins/team/agents/`, 2 read. The plugin was still GRADED — B (80/100) over
 * 12.5% of its subagents — so the number was not merely incomplete, it was
 * flattering. Twelve real malformed-frontmatter defects sat in the unread 87.5%.
 *
 * The three readers are the scan classifier (`makeClassifier`, scan-core.ts) and
 * the two coverage discoverers (`test-coverage.ts`, `test-coverage-files.ts`).
 * They disagreed silently because each spelled the rule itself; they now quote
 * this. A fourth reader that hard-codes a depth is the defect coming back.
 */
export const AGENT_FILE_LEAF_RE = "(?:.+/)?[^/]+\\.md";

/**
 * How DEEP a harness reads its {@link PluginLayout.rulesDir} — the one statement
 * of that rule, as a RegExp source fragment matching the part of a path AFTER
 * `<rulesDir>/`. Same shape and same reason as {@link AGENT_FILE_LEAF_RE}.
 *
 * 🔴 IT USED TO SAY `[^/]+`, in the scan classifier, while the loader walked the
 * directory recursively — so a rule in a subdirectory was READ and never
 * CLASSIFIED, which means it was never frontmatter-checked, never counted and
 * never weighed. Verbatim from the vendor page (`code.claude.com/docs/en/memory`,
 * quoted in zernie/vigiles#262): rules directories are read recursively, "all
 * `.md` files are discovered recursively".
 *
 * The two readers are the scan classifier (`makeClassifier`, scan-core.ts) and
 * the instruction chain (`core/instruction-chain.ts` implementations). They
 * quote this instead of each spelling the rule, for the reason the agent
 * constant above records: two readers that each spell it disagree silently.
 */
export const RULE_FILE_LEAF_RE = "(?:.+/)?[^/]+\\.md";

/**
 * The WHOLE rule-file matcher for a layout — the prefix as well as the leaf.
 *
 * 🔴 THE LEAF WAS SHARED AND THE PREFIX WAS NOT, so the two readers the constant
 * above names went on disagreeing about the half it did not cover. Both spelled
 * it `(?:^|/)<rulesDir>/`, which is deliberately loose for SURFACES — Claude
 * Code reads `skills/` at a published plugin's root AND at `.claude/skills`, two
 * legitimate homes — and wrong for RULES, which have exactly one home. Measured
 * on the instruction chain at 2026-09-22:
 *
 *   loaded: CLAUDE.md · .claude/rules/mine.md · .github/rules/policy.md
 *                                             · .agents/rules/policy.md
 *
 * The bound walks every depth-1 dot-directory's `rules` tree, so ANY of them
 * matched — 8,000 characters of somebody else's policy charged to the
 * always-loaded budget and able to push the report over it. Not one foreign
 * directory, as the review that found it supposed: all of them.
 *
 * Anchoring is what {@link PluginLayout.rulesDir} already says in prose —
 * "Claude Code loads `.claude/rules/*.md`" — and the prefix is built from
 * `userSurfaceRoot` so that moving either field moves both readers at once.
 * `null` when the layout declares no rules layer.
 */
export function rulesHome(
  layout: Pick<PluginLayout, "rulesDir" | "userSurfaceRoot">,
): string | null {
  const dir = layout.rulesDir;
  if (dir === undefined || dir === "") return null;
  const root = layout.userSurfaceRoot;
  return root === undefined || root === "" ? dir : `${root}/${dir}`;
}

export function ruleFileRe(
  layout: Pick<PluginLayout, "rulesDir" | "userSurfaceRoot">,
): RegExp | null {
  // 🔴 THREE READERS, ONE SPELLING. The regexp here, the disk walk in
  // `surface-discovery-fs.ts` and the bound in `core/instruction-chain.ts` all
  // need "where does this layout keep its rules"; each one spelling it
  // separately is how #271 happened — the walk joined `<base>/<rulesDir>` for
  // EVERY dot-directory while this anchored to one, so the pair disagreed about
  // a repository they were both handed. `rulesHome` is that answer, once.
  const under = rulesHome(layout);
  return under === null
    ? null
    : new RegExp(`^${escapeRe(under)}/${RULE_FILE_LEAF_RE}$`);
}

/**
 * ⚠️ The fourth copy of this three-liner in `src/` (`core/linters.ts`,
 * `rule-inventory.ts`, `tool-intercept.ts`, `test-coverage-files.ts` hold the
 * others). Consolidating them is its own change with its own callers to walk;
 * duplicating it here is the smaller of two wrongs while the subject is a
 * measured over-report.
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A subagent's identity, per the same docs paragraph: the path under
 * `<agentDir>/` with `/` → `:` and the `.md` dropped, so plugin
 * `agents/review/security.md` is `review:security` (the scoped identifier minus
 * its plugin prefix, which the scan of a single plugin dir does not know).
 *
 * 🔴 NOT COSMETIC — it is what keeps recursion from introducing a defect of its
 * own. A basename cannot be unique once the dir is read recursively:
 * `agents/a/review.md` and `agents/b/review.md` would both be "review", and the
 * delegation graph keys agents BY NAME (`pathByName`, `delegatesTo`), so one
 * would silently swallow the other's path and neither would delegate to its
 * namesake. A path-derived name is unique by construction, so that collision has
 * nowhere to live. Degenerates to today's basename for a top-level agent, which
 * is why no existing report changes.
 *
 * Returns null when `path` holds no `<agentDir>/` segment (not an agent file).
 */
export function agentSurfaceName(
  path: string,
  agentDir: string,
): string | null {
  if (!agentDir) return null;
  const marker = `${agentDir}/`;
  // The FIRST occurrence sitting at a real path boundary — start-of-path or just
  // after a `/`. Both halves matter and one of them is easy to get wrong:
  // requiring the boundary stops `my-agents/x.md` being read as `agents/x.md`,
  // and CONTINUING the search past a non-boundary hit is what keeps this
  // agreeing with the classifier, whose `(?:^|/)agents/` skips the same way.
  // Taking `indexOf` once and rejecting it would return null for
  // `myagents/x/agents/y.md` — a path the classifier calls an agent — so the two
  // would disagree about the very file they are both looking at.
  let at = -1;
  for (
    let i = path.indexOf(marker);
    i !== -1;
    i = path.indexOf(marker, i + 1)
  ) {
    if (i === 0 || path[i - 1] === "/") {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const tail = path.slice(at + marker.length);
  if (tail === "" || !tail.endsWith(".md")) return null;
  return tail.slice(0, -".md".length).split("/").join(":");
}
