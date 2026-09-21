/**
 * Pure decision logic for `vigiles init`.
 *
 * Turns CLI args + whether a human's at a TTY into a concrete setup PLAN, so the
 * IO-heavy `setup()` in cli.ts stays a thin shell and every choice is unit-tested.
 * Best-practice onboarding: **interactive** when a human runs it in a terminal,
 * **non-interactive** (sensible defaults) for agents / CI / piped input — so
 * "set up vigiles" from a Claude Code or Codex prompt Just Works without hanging
 * on a prompt. See docs/agent-setup.md.
 */

/** What `vigiles init` will set up. */
export interface SetupPlan {
  /** Lint pillar — verify instruction-file references (specs, types, compile, lint, hooks). */
  lint: boolean;
  /** Test pillar — test the harness (scaffold a starter harness test + CI job). */
  test: boolean;
  /** Wire CI (the `zernie/vigiles@v1` Action; creates a workflow if none). */
  gha: boolean;
  /** Install the Claude Code plugin (hooks + skills). */
  plugin: boolean;
  /**
   * Adopt/scaffold the instruction file(s) into typed `.spec.ts` (the compiled
   * `CLAUDE.md` + integrity hash). GATE-FIRST (see `gate-first-adoption`): the
   * INTEGRITY GATE (structural rules on your raw files + CI + devDep) is the
   * universal floor and needs NO spec — the `structural` rule group reads
   * skills/agents/hooks as-is, and `require-instructions-spec` is itself opt-in. So
   * scaffolding a spec (extra maintenance + a compiled artifact) is the INVITED
   * layer, gated on this flag (`setupPillar1` runs iff `lint && scaffoldSpecs`).
   * Default: TRACKS the lint pillar (`resolvePlan` sets it to `plan.lint`), so bare
   * `init` / `--lint` scaffold as before — non-interactive behaviour is unchanged.
   * The ONE thing that turns it off with lint on is the wizard's "gate" choice: a
   * pure lint gate on your raw files, nothing installed, no spec. No new CLI flag —
   * a non-interactive gate is a documented follow-up (research/adoption-design.md §1).
   */
  scaffoldSpecs: boolean;
  /** Strict rule severities in `.vigilesrc.json`. */
  strict: boolean;
  /** Rewrite an existing STALE CI workflow in place (instead of only warning). */
  force: boolean;
}

/** The explicit choices a user pinned via flags (undefined = "not specified"). */
export interface ParsedSetupArgs {
  target?: string;
  strict: boolean;
  /** `--report-only` — write the gating rules at "warn" (nothing fails CI). The
   * orthogonal severity dial; composes with `--strict` (which rules) by setting
   * their severity. */
  reportOnly: boolean;
  yes: boolean;
  /** `--force` — rewrite a stale CI workflow in place. */
  force: boolean;
  /** Lint pillar — `--lint` → true, `--no-lint` → false, absent → undefined. */
  lint?: boolean;
  /** Test pillar — `--test` → true, `--no-test` → false, absent → undefined. */
  test?: boolean;
  /** `--harness=claude,codex` override (empty = auto-detect). */
  harness?: string;
  gha?: boolean;
  plugin?: boolean;
  /**
   * `--ci-only` — the explicit CI-gate-only opt-in: the non-interactive equal of
   * the wizard's "gate" choice (the lint gate in CI + devDep, no plugin, no spec,
   * no test). Lets an agent/CI reach it without a TTY. Full stays the DEFAULT (bare
   * `init` is unchanged), so this is opt-IN — it never buries the richer layers
   * behind a default flip. (Named for what it sets up — the CI check — not the
   * internal "integrity gate" concept.)
   *
   * THE DISCOVERY FAILURE THIS FLAG IS THE WORKED EXAMPLE OF: it shipped in the
   * CLI and was invisible on the README, the site, the recommended agent prompt
   * and the internal doc, so an agent taking the full default never learned it
   * existed. Working code is not a delivered capability — a flag nobody can FIND
   * is not done. The fix was a pointer in the non-interactive summary, `--help`,
   * docs/agent-setup.md and the README; the standing rule it produced is the
   * DISCOVERY row of `cohesive-feature-delivery`.
   */
  ciOnly: boolean;
}

function flagValue(
  args: readonly string[],
  prefix: string,
): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** `--name` → true, `--no-name` → false, neither present → undefined. */
function boolFlag(args: readonly string[], name: string): boolean | undefined {
  if (args.includes(`--${name}`)) return true;
  if (args.includes(`--no-${name}`)) return false;
  return undefined;
}

/** Parse `init` args into the choices the user pinned. The two pillars are
 * selected with `--lint` / `--test`. */
export function parseSetupArgs(args: readonly string[]): ParsedSetupArgs {
  return {
    target: flagValue(args, "--target="),
    strict: args.includes("--strict"),
    reportOnly: args.includes("--report-only"),
    yes: args.includes("--yes") || args.includes("-y"),
    force: args.includes("--force"),
    lint: boolFlag(args, "lint"),
    test: boolFlag(args, "test"),
    harness: flagValue(args, "--harness="),
    gha: args.includes("--no-gha") ? false : undefined,
    plugin: args.includes("--no-plugin") ? false : undefined,
    ciOnly: args.includes("--ci-only"),
  };
}

/** The non-interactive defaults: both pillars, CI, and the plugin. `scaffoldSpecs`
 * tracks the lint pillar (specs are created when the lint layer is set up) — the
 * ONE exception is the wizard's "gate" choice, which sets up the lint GATE on your
 * raw files WITHOUT scaffolding a spec (gate-first-adoption). Non-interactive
 * behaviour is unchanged: bare `init` (lint on) scaffolds as before. */
export function defaultPlan(strict = false): SetupPlan {
  return {
    lint: true,
    test: true,
    gha: true,
    plugin: true,
    scaffoldSpecs: true,
    strict,
    force: false,
  };
}

/**
 * Pure config-merge for what `vigiles init` writes to `.vigilesrc.json`: record
 * the `harness` if absent, add strict rule severities if `--strict`, NEVER
 * clobber an existing key. Returns the merged config, or `null` when nothing
 * changed (so the IO layer skips the write). The IO (read/parse/write + the
 * malformed-file guard) stays in cli.ts.
 */
/**
 * The structural rules `init` gates BY DEFAULT (severity `error`, so a broken
 * surface fails `vigiles lint`). Every one is HIGH-PRECISION / FP-safe — it fires
 * only on a genuine defect (a never-available/typo'd tool, a subagent missing
 * `name`/`description`, a typo'd hook event, a dead hook script, a broken MCP
 * ref, two skills that collide in the selector) — so a well-formed plugin stays
 * green and catching real breakage out of the box never cries wolf.
 *
 * Deliberately EXCLUDES `require-instructions-spec` and the workflow-forcing rules:
 * those make a CLEAN repo fail (you simply haven't written the spec/test yet), so
 * they stay opt-in under `--strict` (progressive adoption — see
 * `STRICT_EXTRA_RULES`).
 *
 * This is the **`structural`** rule group (see research/install-enforcement-dx.md).
 */
export const STRUCTURAL_RULES = [
  "subagent-tool-contract",
  "subagent-frontmatter",
  "hook-events",
  "hook-script-exists",
  "mcp-config",
  "mcp-tool-resolves",
  "mcp-hook-target-resolves",
  "disallowed-tools-contract",
  "description-overlap",
] as const;

/**
 * The **`workflow`** group — the WORKFLOW-FORCING / opinionated tier `--strict`
 * gates, which a clean repo can still fail because you haven't done the work yet:
 * a spec per instruction file (`require-instructions-spec`), a test/eval per
 * surface (`untested-*`). Opt-in by design (the smooth-adoption on-ramp). The
 * Clippy-`pedantic` / TS-`strict` analog — ONE opinionated opt-in.
 *
 * NB `frontmatter-valid` / `skill-frontmatter` live in the `nudge` group, not
 * here: they're acknowledged-noisy recommendations we never gate on (see
 * research/install-enforcement-dx.md).
 */
export const WORKFLOW_RULES = [
  "require-instructions-spec",
  "untested-skill",
  "untested-subagent",
  "untested-hook",
] as const;

/**
 * The **`nudge`** group — recommendations / acknowledged-noisy checks that NEVER
 * gate (not even under `--strict`): `frontmatter-valid` (js-yaml is stricter than
 * CC's loader), `skill-frontmatter` (skills load without it) and `unmarked-refs`
 * (the undecidable-plaintext nudge) sit at `warn`; `prefer-compiled-hooks` defaults
 * OFF (a recommendation that shouldn't fire unasked — the shell lane stays
 * first-class). `lethal-trifecta` + `skill-resource-resolves` are here for now on a
 * don't-cry-wolf rollout (default `warn`; a team raises either to `error` by hand
 * once it's confirmed quiet on their corpus). `init` does not write these — they
 * keep their own default severities. Named for the group taxonomy
 * (research/install-enforcement-dx.md).
 */
export const NUDGE_RULES = [
  "skill-description-budget",
  "frontmatter-valid",
  "skill-frontmatter",
  "prefer-compiled-hooks",
  "unmarked-refs",
  "lethal-trifecta",
  "skill-resource-resolves",
  "skill-missing-fence",
  "plugin-dir-layout",
  "delegation-trifecta",
  "hook-block-ineffective",
  "hook-matcher",
  // Default OFF for a measured reason, not a rollout one: 0 true positives over
  // 2 582 markdown files, because a fence in prose is a drawing of config rather
  // than config. See docs/rules/doc-refs.md.
  "doc-refs",
] as const;

export function mergeProjectConfig(
  existing: Record<string, unknown>,
  opts: {
    /** Canonical harness names this repo targets, in the order to declare them. */
    harnesses: readonly string[];
    strict: boolean;
    reportOnly?: boolean;
    /** Whether the LINT pillar is on (default true). The rule gate is a lint-layer
     * concern, so a test-only setup (`init --test` / `--no-lint`) records the
     * harness but writes NO lint rules. */
    lint?: boolean;
  },
): Record<string, unknown> | null {
  const config = { ...existing };
  let changed = false;
  // The NESTED key (#240). `init` writes the declaration with no roots — a repo
  // whose surfaces sit where its harness reads them needs none, and a root is a
  // fact only the owner knows. Writing the flat `harness`/`surfaceRoots` pair
  // here would emit a config the loader now REFUSES, which is why this one line
  // moved with the shape even though the rest of `init` did not.
  if (config.harnesses === undefined) {
    config.harnesses = Object.fromEntries(
      opts.harnesses.map((h) => [h, {}]),
    ) as Record<string, Record<string, never>>;
    changed = true;
  }
  // The rule gate belongs to the LINT layer — a test-only setup records the
  // harness but writes no rules (honoring the positive-flag contract that
  // `--test` selects only the test pillar).
  if (opts.lint !== false) {
    // Gate the FP-safe `structural` group by default; `--strict` adds the
    // `workflow` group on top. `--report-only` is the orthogonal severity dial —
    // it writes the SAME rule set at "warn" (nothing fails CI; the
    // migration/observe mode). Never clobber a severity the user already set —
    // only fill the undefined ones.
    const severity = opts.reportOnly ? "warn" : "error";
    const gate = opts.strict
      ? [...STRUCTURAL_RULES, ...WORKFLOW_RULES]
      : [...STRUCTURAL_RULES];
    const rules = { ...(config.rules as Record<string, unknown> | undefined) };
    for (const r of gate) {
      if (rules[r] === undefined) {
        rules[r] = severity;
        changed = true;
      }
    }
    config.rules = rules;
  }
  return changed ? config : null;
}

/**
 * Whether to drop into interactive prompts: a human at a TTY who passed neither
 * `--yes` nor an explicit `--target`, and who hasn't already pinned every choice
 * via flags. Agents / CI / piped input (no TTY) never prompt.
 */
export function shouldPrompt(parsed: ParsedSetupArgs, isTTY: boolean): boolean {
  // `--ci-only` is an explicit setup-shape choice (the CLI equal of the wizard's
  // "gate" answer), so it settles the fork — never prompt over it.
  if (!isTTY || parsed.yes || parsed.target || parsed.ciOnly) return false;
  const pillarsPinned = parsed.lint !== undefined || parsed.test !== undefined;
  const allPinned =
    pillarsPinned && parsed.gha !== undefined && parsed.plugin !== undefined;
  return !allPinned;
}

/** Interactive answers (only the fields the prompts cover). */
export type SetupAnswers = Partial<
  Pick<
    SetupPlan,
    "lint" | "test" | "gha" | "plugin" | "strict" | "scaffoldSpecs"
  >
>;

/** Ask one question with a default — injected so the interactive Q&A is pure +
 *  unit-testable (a fake `ask` scripts answers; no TTY, no readline). */
export type AskFn = (question: string, def: string) => Promise<string>;

const isYesAnswer = (s: string): boolean => /^y(es)?$/i.test(s);

/**
 * The interactive setup Q&A as PURE logic over an injected `ask` — the prompts,
 * their defaults, and the answer→`SetupAnswers` mapping. The IO shell (readline)
 * lives in `cli.ts`'s `promptSetup`, which just supplies a real `ask`. Keeping
 * this here means the fragile interactive path is unit-tested deterministically
 * (the questions can't silently break) without a terminal.
 */
export async function collectSetupAnswers(ask: AskFn): Promise<SetupAnswers> {
  // GATE-FIRST fork (gate-first-adoption): the FIRST question is the shape of the
  // setup, not a pillar list — because the integrity GATE is the universal floor and
  // everything richer is invited. "gate" = lint your files in CI, nothing installed,
  // zero conflict (the existing-harness / non-JS path). "full" = also scaffold specs
  // + install the skills/hooks. Default "full" keeps the newcomer experience; an
  // existing-harness user picks "gate" (and its tradeoff is stated inline).
  const mode = (
    await ask(
      "Setup mode — [gate] lint your files in CI, nothing installed (best if you already have a harness) · [full] also scaffold specs + install skills/hooks? [gate/full] (full): ",
      "full",
    )
  ).toLowerCase();
  if (mode === "gate" || mode === "g") {
    // Pure gate: the structural rules on your raw files + CI + devDep. No spec, no
    // plugin, no test scaffold — nothing installed, nothing to maintain.
    return {
      lint: true,
      test: false,
      plugin: false,
      scaffoldSpecs: false,
      strict: false,
    };
  }
  const pillars = (
    await ask("Set up which pillars? [both/lint/test] (both): ", "both")
  ).toLowerCase();
  const gha = isYesAnswer(await ask("Wire CI (GitHub Action)? [Y/n]: ", "y"));
  const plugin = isYesAnswer(
    await ask("Install the Claude Code plugin (hooks + skills)? [Y/n]: ", "y"),
  );
  // Structural gating (broken tools/hooks/MCP/collisions) is always on. This asks
  // about the WORKFLOW tier — a spec per file + a test per surface — which a clean
  // repo can fail just for not having done the work yet, so it's the recommended
  // default a human opts OUT of (never forced on a silent run). "yes" also turns on
  // the spec scaffold (the workflow tier's `require-instructions-spec`).
  const strict = isYesAnswer(
    await ask(
      "Also enforce specs + a test per surface (recommended)? [Y/n]: ",
      "y",
    ),
  );
  return {
    lint: pillars !== "test",
    test: pillars !== "lint" && pillars !== "verify",
    gha,
    plugin,
    strict,
    // "full" scaffolds specs whenever the lint pillar is on (specs are how the full
    // setup works); `strict` is a separate axis (it gates the workflow RULES, not
    // whether a spec exists).
    scaffoldSpecs: pillars !== "test",
  };
}

/**
 * Apply the pillar flags. A positive flag (`--lint` and/or `--test`) is an
 * explicit SELECTION — enable exactly the named pillars. Otherwise default to
 * both and let a `--no-*` flag drop one.
 */
function applyPillarFlags(plan: SetupPlan, parsed: ParsedSetupArgs): void {
  if (parsed.lint === true || parsed.test === true) {
    plan.lint = parsed.lint === true;
    plan.test = parsed.test === true;
    return;
  }
  if (parsed.lint === false) plan.lint = false;
  if (parsed.test === false) plan.test = false;
}

function applyAnswers(plan: SetupPlan, answers: SetupAnswers): void {
  if (answers.lint !== undefined) plan.lint = answers.lint;
  if (answers.test !== undefined) plan.test = answers.test;
  if (answers.gha !== undefined) plan.gha = answers.gha;
  if (answers.plugin !== undefined) plan.plugin = answers.plugin;
  if (answers.strict !== undefined) plan.strict = answers.strict;
  if (answers.scaffoldSpecs !== undefined)
    plan.scaffoldSpecs = answers.scaffoldSpecs;
}

/**
 * The NON-EVIL invitation to graduate a gate-only setup to the full layer (skills
 * + typed specs) — `gate-first-adoption`'s "invite the rest". Pure: returns the
 * one-line invitation when the setup landed as a pure gate (no plugin, no specs),
 * else null. It's INFORMATIONAL — a printed line, never a second prompt (the TTY
 * wizard already asked; a headless run must never hang), and declining costs
 * nothing (the gate is fully functional). The IO (printing it, and the optional
 * later reminder on `audit`/`lint`) lives in cli.ts.
 */
export function gateOnlyInvitation(plan: SetupPlan): string | null {
  const gateOnly = !plan.plugin && !plan.scaffoldSpecs;
  if (!gateOnly) return null;
  return "→ Want your agent to maintain this + measure whether your skills fire? Run `npx vigiles init` and choose 'full' (installs the skills). Optional — the gate above already works.";
}

/**
 * How to install vigiles's skills/hooks for ONE harness — the deterministic
 * decision behind the IO in cli.ts, so a CI test asserts WHICH commands an
 * install runs without a network call or a real `claude`/`codex` binary.
 *
 * The method is genuinely harness-specific: Claude Code has a GLOBAL plugin
 * marketplace (installs to ~/.claude/plugins/, nothing in the repo); Codex has
 * no global store — its config is repo-committed (`.codex/`, AGENTS.md), so its
 * instructions are read directly and skills are an opt-in, repo-local concern.
 */
export interface InstallPlan {
  harness: string;
  /** Shell commands to auto-run (empty = nothing runnable here). */
  commands: string[];
  /** One-line success message printed after the commands run. */
  successMessage: string;
  /** The equivalent commands a user runs by hand (printed on failure / no-CLI). */
  manualSteps: string[];
  /** Always-printed informational lines (where it installs, caveats). */
  notes: string[];
  /** Whether this method writes files into the consumer's repo (vendoring). */
  vendors: boolean;
}

/** Per-harness install plan. `hasClaude` gates the auto-run `claude plugin` CLI
 * (else the same two steps are printed as `/plugin` slash commands).
 *
 * Both methods install GLOBALLY, never into the repo: Claude through its plugin
 * marketplace (~/.claude/plugins/), Codex through the cross-agent `skills` CLI
 * with `-g -y` (the global store ~/.agents/skills/, which Codex reads). Codex
 * gets the skills but NOT hooks — Codex hook wiring (.codex/config.toml [hooks])
 * is not automated yet. */
/**
 * The SHIPPED consumer skills (the `skills/` dir, published via `plugin.json`) —
 * the ONLY ones a user's install should get. The cross-agent `skills` CLI would
 * otherwise clone the whole repo and install EVERY skill dir it finds, including
 * this repo's CONTRIBUTOR-only `.claude/skills/` (generate-logo, landing-site,
 * pr-to-lint-rule, …) — internal tooling users never asked for. So the Codex
 * install is scoped with `-s`. Kept in lockstep with `skills/` on disk by the
 * dogfood test in `src/adapters/claude-code/skills-dogfood.test.ts`.
 */
export const SHIPPED_SKILLS = [
  "adopt-spec",
  "debug-my-harness",
  "edit-spec",
  "linter-docs",
  "strengthen",
  "test-harness",
] as const;

export function planPluginInstall(
  harnesses: readonly string[],
  opts: { hasClaude: boolean },
): InstallPlan[] {
  return harnesses.map((harness) => {
    if (harness === "claude") {
      return {
        harness,
        commands: opts.hasClaude
          ? [
              "claude plugin marketplace add zernie/vigiles",
              "claude plugin install vigiles@vigiles",
            ]
          : [],
        successMessage:
          "✓ Installed the vigiles plugin (hooks + skills) into ~/.claude/plugins/",
        manualSteps: [
          "/plugin marketplace add zernie/vigiles",
          "/plugin install vigiles@vigiles",
        ],
        notes: [
          "Installs globally to ~/.claude/plugins/ — nothing is added to your repo.",
        ],
        vendors: false,
      };
    }
    if (harness === "codex") {
      // The cross-agent `skills` CLI with `-g -y` installs to the global store
      // ~/.agents/skills/ (NOT the repo, and NOT ~/.codex/ — verified against
      // the real CLI). Skills install globally; the proactive NUDGE hooks
      // (eval-lock + refs) are wired into the repo's .codex/config.toml by
      // `init` (see codexPluginHooks / wireCodexHooks) — Codex config is
      // repo-committed, so that's the idiomatic place.
      // Scope to the SHIPPED skills with `-s` — without it the `skills` CLI
      // installs EVERY SKILL.md in the repo, leaking the contributor-only
      // .claude/skills/ into the user's global store (#dogfood-I2; confirmed —
      // the CLI's `-l` list shows 17 skills for this repo, incl. .claude/skills).
      // The `-s` parser is SPACE-separated (it consumes consecutive non-dash
      // args), NOT comma-separated — a comma list is read as one literal skill
      // name, matches nothing, and the install exits 1 (verified against the
      // real `skills@1.5.20` arg parser).
      const skillScope = `-s ${SHIPPED_SKILLS.join(" ")}`;
      return {
        harness,
        commands: [
          `npx --yes skills add zernie/vigiles -a codex ${skillScope} -g -y`,
        ],
        successMessage:
          "✓ Installed the vigiles skills into ~/.agents/skills/ (global, not vendored)",
        manualSteps: [
          `npx skills add zernie/vigiles -a codex ${skillScope} -g -y`,
        ],
        notes: [
          "Codex reads AGENTS.md directly; the skills install globally to ~/.agents/skills/ (not the repo).",
          "The eval-lock + refs NUDGE hooks are wired into .codex/config.toml (repo-committed, the Codex norm).",
          "Still manual on Codex: the SessionStart lint summary + compile-on-edit/pre-edit guards (no harness-neutral entrypoint yet).",
        ],
        vendors: true,
      };
    }
    return {
      harness,
      commands: [],
      successMessage: "",
      manualSteps: [],
      notes: [`No plugin install path for harness '${harness}'.`],
      vendors: false,
    };
  });
}

/** One vigiles-managed Codex hook: a `[[hooks.<event>]]` entry. */
export interface CodexPluginHook {
  readonly event: string;
  /** Codex matcher (anchored regex, the dialect convention). */
  readonly matcher: string;
  /** The shell command Codex runs (a direct `npx vigiles …`, no plugin root). */
  readonly command: string;
  /** A unique command substring → idempotent re-merge (replaces in place). */
  readonly key: string;
}

/**
 * vigiles's proactive nudges, wired into a Codex repo's `.codex/config.toml`.
 *
 * Codex has no global plugin store (unlike Claude Code's marketplace), so its
 * config is repo-committed — the idiomatic place for these. They run as DIRECT
 * `npx vigiles hook-runtime …` commands (NOT vendored bash scripts): the runtime
 * entrypoints read the event JSON on stdin and emit the `hookSpecificOutput.
 * additionalContext` shape Codex honors on `PostToolUse` (confirmed against the
 * official hooks docs + encoded in `HookProtocol.injectableEvents`). Safety: only
 * an INTENTIONAL `exit 2` blocks an edit (the refs nudge, when `unmarked-refs` is
 * `error`); an npx-resolution failure exits non-2, so a missing dep never blocks.
 *
 * Deliberately NOT here (a loud, documented deferral — no-silent-skips): the
 * SessionStart lint summary (CC delivers it as plain stdout, whose SessionStart
 * prepend is unconfirmed on Codex — vs the JSON `additionalContext` these use) and
 * the compile-on-edit / pre-edit-block guards (filename-gated bash with no
 * harness-neutral `hook-runtime` entrypoint yet). Those stay manual on Codex.
 */
export function codexPluginHooks(): CodexPluginHook[] {
  // Codex's file-edit tool is `apply_patch` (its dialect vocabulary —
  // src/adapters/codex/dialect.ts), NOT Claude's `Edit`/`Write`. A PostToolUse
  // matcher keyed on CC tool names would never fire on Codex, so the nudges must
  // match the Codex tool name. (Both nudge entrypoints also self-gate on the
  // edited file, so a non-edit event no-ops regardless.)
  return [
    {
      event: "PostToolUse",
      matcher: "^apply_patch$",
      command: "npx --no-install vigiles hook-runtime eval-lock-nudge",
      key: "hook-runtime eval-lock-nudge",
    },
    {
      event: "PostToolUse",
      matcher: "^apply_patch$",
      command: "npx --no-install vigiles hook-runtime refs",
      key: "hook-runtime refs",
    },
  ];
}

/** A Codex `config.toml` shape, narrowed to the `[hooks]` table we manage. */
interface CodexConfig {
  hooks?: Record<string, { matcher?: string; command: string }[]>;
  [k: string]: unknown;
}

/**
 * Idempotently merge {@link codexPluginHooks} into a parsed `.codex/config.toml`
 * object. Pure — the IO (read/parse/serialize/write) stays in cli.ts's
 * `wireCodexHooks`. Each vigiles hook is keyed by a unique command substring, so
 * a re-run REPLACES its own entry in place and leaves the user's own Codex hooks
 * (and every other config key) untouched. Returns a new object.
 */
export function applyCodexPluginHooks(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const config = existing as CodexConfig;
  const hooks: Record<string, { matcher?: string; command: string }[]> = {
    ...(config.hooks ?? {}),
  };
  for (const h of codexPluginHooks()) {
    const kept = (hooks[h.event] ?? []).filter(
      (e) => !e.command.includes(h.key),
    );
    hooks[h.event] = [...kept, { matcher: h.matcher, command: h.command }];
  }
  return { ...existing, hooks };
}

/**
 * Resolve the final plan: defaults, then flags, then interactive answers (each
 * layer overrides the previous only where it has an opinion). `--target` pins a
 * bare lint-pillar spec (no harness scaffold).
 */
export function resolvePlan(
  parsed: ParsedSetupArgs,
  answers?: SetupAnswers,
): SetupPlan {
  const plan = defaultPlan(parsed.strict);
  applyPillarFlags(plan, parsed);
  if (parsed.gha === false) plan.gha = false;
  if (parsed.plugin === false) plan.plugin = false;
  if (parsed.force) plan.force = true;
  if (parsed.target) plan.test = false;
  // Specs track the lint pillar (created when the lint layer is set up); the wizard's
  // "gate" answer is the one thing that overrides this to false (a lint gate with no
  // spec). So `--no-lint` also stops the scaffold, and everything else is unchanged.
  plan.scaffoldSpecs = plan.lint;
  // `--ci-only`: the explicit CI-gate-only opt-in — the lint gate in CI + devDep,
  // but no plugin, no spec scaffold, no test (the same shape as the wizard's "gate"
  // choice). Full stays the DEFAULT, so this never flips bare `init`'s behaviour;
  // it just lets a headless agent/CI request the non-invasive gate. Applied after
  // the pillar flags so it wins over `plan.scaffoldSpecs = plan.lint`.
  if (parsed.ciOnly) {
    plan.lint = true;
    plan.test = false;
    plan.plugin = false;
    plan.scaffoldSpecs = false;
    plan.strict = false;
  }
  if (answers) applyAnswers(plan, answers);
  return plan;
}
