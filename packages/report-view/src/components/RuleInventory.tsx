import { useState } from "react";
import { Check, Copy, ChevronRight, Zap, Sparkles } from "lucide-react";
import type { RuleInventoryItem, RuleRouting, RuleCategory } from "../schema";
import { TEXT, BG } from "../lib/band";
import { cn } from "../lib/utils";

const BTN =
  "inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-left text-sm font-medium hover:border-foreground disabled:opacity-60";

/**
 * Copy a paste-ready agent prompt to the clipboard. vigiles users live in
 * Claude Code / Codex, so the actionable affordance is an instruction the agent
 * can execute — enable the rule in the real config — not a raw JSON snippet.
 */
function CopyPrompt({ item }: { item: RuleInventoryItem }) {
  const [copied, setCopied] = useState(false);
  // A contradiction needs a DECISION prompt (the rule is present but disabled),
  // not an "add this line" prompt — the config already mentions it.
  const prompt =
    item.configState === "contradiction"
      ? `In this repo, the ${item.linter} rule \`${item.rule}\` is set to "off" in the lint config, but the instructions document "${item.intent}" as a rule. Resolve the contradiction: either remove the override so \`${item.rule}\` is enforced (${item.configFix}), or drop the documented rule if it's intentionally off.`
      : `In this repo, enable the ${item.linter} rule \`${item.rule}\` (set it to "error") in the lint config, ` +
        `so the documented rule "${item.intent}" is actually enforced. Config to add: ${item.configFix}`;
  const copy = (): void => {
    void navigator.clipboard?.writeText(prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <button type="button" onClick={copy} title={prompt} className={BTN}>
      {copied ? (
        <Check size={14} className={TEXT.good} />
      ) : (
        <Copy size={14} className="text-muted-foreground" />
      )}
      <span className={cn(copied && TEXT.good)}>
        {copied ? "copied!" : "copy agent prompt"}
      </span>
    </button>
  );
}

/** One rule row. `tone` drives the leading dot/check + the trailing label. */
function RuleRow({
  item,
  tone,
  label,
  action,
}: {
  item: RuleInventoryItem;
  tone: "good" | "warn" | "bad" | "muted";
  label: string;
  action?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-3 text-base">
      {tone === "good" ? (
        <Check size={16} className={TEXT.good} />
      ) : (
        <span
          className={cn(
            "text-lg leading-none",
            tone === "warn"
              ? TEXT.warn
              : tone === "bad"
                ? TEXT.bad
                : "text-muted-foreground",
          )}
        >
          ●
        </span>
      )}
      <span className="min-w-[12rem] flex-1">{item.intent}</span>
      <code className="break-all font-mono text-sm text-foreground-soft">
        {item.rule}
      </code>
      <span
        className={cn(
          "text-sm",
          tone === "good"
            ? TEXT.good
            : tone === "warn"
              ? TEXT.warn
              : tone === "bad"
                ? TEXT.bad
                : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      {action && <CopyPrompt item={item} />}
    </li>
  );
}

/** A collapsed group whose count is always visible (green/preset rows fold away
 * so the actionable rows stay on top). */
function FoldedGroup({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "good" | "muted";
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 py-1 text-[15px] font-medium",
          tone === "good" ? TEXT.good : "text-muted-foreground",
        )}
      >
        <ChevronRight
          size={13}
          className="transition-transform group-open:rotate-90"
        />
        {title}
      </summary>
      <ul className="mt-2">{children}</ul>
    </details>
  );
}

/**
 * The Rules section — the report's hero for the "prose → enforced" story. Two
 * honest zones:
 *   1. Deterministic scan (no model) — documented rules that map to an
 *      off-the-shelf lint rule, grouped by state so the actionable ones lead.
 *   2. "Your rules, mapped" — the deterministic routing preview with an honest,
 *      opt-in next step per lane; never fabricated result rows.
 */
/** The five routing categories, in ladder order (enforceable-now → hook →
 * agent-note → prose → hard-to-codify), with the glyph + one-line meaning the
 * rule map lists. The HARD bucket is labelled so difficulty reads clearly. */
const ROUTE_META: Record<
  RuleCategory,
  { glyph: string; label: string; blurb: string }
> = {
  reuse: {
    glyph: "✓",
    label: "enforceable now",
    blurb: "an off-the-shelf rule already exists → one config line",
  },
  hook: {
    glyph: "⛓",
    label: "hook",
    blurb:
      "an action rule a linter can't see (git push, rm -rf) → a hook gates it",
  },
  meta: {
    glyph: "☰",
    label: "agent note",
    blurb: "an instruction to the agent, not a code rule → stays prose",
  },
  semantic: {
    glyph: "✎",
    label: "judgment call",
    blurb:
      "no checker can decide it (“readable”, “idiomatic”) → honestly stays prose",
  },
  // The synthesize lane is DOABLE, not a dead end: no off-the-shelf rule matches,
  // but a CUSTOM rule can enforce it ("wrap API calls in retry", "validate the
  // input schema"). Kept distinct from `semantic` so it never reads as generic
  // "hard prose" — it's the opt-in synthesis skill's target.
  unrouted: {
    glyph: "⚙",
    label: "custom rule",
    blurb:
      "no off-the-shelf rule fits, but a custom one CAN — the opt-in synthesis skill writes + gates it (abstains if it can't prove it sound)",
  },
};
// Ladder order: enforceable-now → hook → the two "stays prose" lanes → the
// SYNTHESIZE lane last (doable-but-opt-in), so a reader sees reuse first and the
// custom-rule candidates as a distinct, actionable tail — not generic "hard".
const ROUTE_ORDER: RuleCategory[] = [
  "reuse",
  "hook",
  "meta",
  "semantic",
  "unrouted",
];

/**
 * "Your rules, mapped" — the DETERMINISTIC routing preview (no model, nothing
 * executes): real per-category counts + an example per lane, so the reader sees
 * THEIR rules routed. Each lane's next step is honest and OPT-IN — enable a
 * config line / run the strengthen skill / author a compiled hook / stays prose.
 * NB this is NOT `vigiles compile` (that's the unrelated spec→markdown verb).
 */
function RuleMap({ routing }: { routing?: RuleRouting }) {
  // One representative example rule per non-reuse category (reuse is already the
  // detailed hero above), quote trimmed for the line.
  const exampleFor = (cat: RuleCategory): string | undefined =>
    routing?.rules.find((r) => r.category === cat)?.text;

  // The sharp catalog finding: a rule your docs NAME as reuse that your linter
  // actually has turned OFF ("documented but OFF"). Only present when the audit
  // enumerated the live catalog (own-repo, consented) — enabled === false.
  const off = (routing?.rules ?? []).filter(
    (r) => r.category === "reuse" && r.enabled === false,
  );

  return (
    <div className="mt-10">
      <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-display text-xl font-semibold">
        <Sparkles size={18} className="text-muted-foreground" aria-hidden />
        Your rules, mapped
        <span className="font-sans text-sm font-normal text-muted-foreground">
          deterministic · no model
        </span>
      </h3>
      {routing && routing.segmented > 0 ? (
        <>
          <p className="mt-2 text-[15px] text-foreground-soft">
            We segmented{" "}
            <span className="font-semibold text-foreground">
              {routing.segmented}
            </span>{" "}
            atomic {routing.segmented === 1 ? "rule" : "rules"} from your
            instructions and routed each one — deterministically, no model:
          </p>
          <ul className="mt-3 space-y-2.5 text-[15px] text-foreground-soft">
            {ROUTE_ORDER.filter((cat) => routing.counts[cat] > 0).map((cat) => {
              const ex = exampleFor(cat);
              return (
                <li key={cat}>
                  <span className="font-mono text-foreground">
                    {ROUTE_META[cat].glyph} {routing.counts[cat]}{" "}
                    {ROUTE_META[cat].label}
                  </span>{" "}
                  — {ROUTE_META[cat].blurb}
                  {cat === "reuse" && off.length > 0 && (
                    <span className={cn("ml-1 font-semibold", TEXT.bad)}>
                      ({off.length} documented but OFF)
                    </span>
                  )}
                  {ex && (
                    <span className="mt-0.5 block truncate pl-4 italic text-muted-foreground">
                      e.g. “{ex}”
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {/* The wow: your instructions NAME these rules, but your linter has
              them turned off — read straight off the live catalog, no model. */}
          {off.length > 0 && (
            <div className="mt-5">
              <p className={cn("text-[15px] font-semibold", TEXT.bad)}>
                ⛔ {off.length} documented but OFF
              </p>
              <p className="mt-0.5 text-[15px] text-foreground-soft">
                Your instructions name{" "}
                {off.length === 1 ? "this rule" : "these rules"} as enforced,
                but your linter config has {off.length === 1 ? "it" : "them"}{" "}
                disabled:
              </p>
              <ul className="mt-1 space-y-0.5">
                {off.slice(0, 6).map((r) => (
                  <li
                    key={r.rule}
                    className="break-all font-mono text-sm text-foreground-soft"
                  >
                    <code className={TEXT.bad}>{r.rule}</code>{" "}
                    <span className="text-muted-foreground">— {r.text}</span>
                  </li>
                ))}
                {off.length > 6 && (
                  <li className="text-sm text-muted-foreground">
                    +{off.length - 6} more
                  </li>
                )}
              </ul>
            </div>
          )}
          <RuleMapTiers routing={routing} />
          <RuleMapNextSteps />
        </>
      ) : (
        <>
          <RuleMapTiers routing={routing} />
          <p className="mt-2 text-[15px] text-foreground-soft">
            Segments your instruction file into atomic rules and routes each one
            — deterministically, no model:
          </p>
          <ul className="mt-3 space-y-1.5 text-[15px] text-foreground-soft">
            <li>
              <span className="font-mono text-foreground">
                ✓ enforceable now
              </span>{" "}
              — an off-the-shelf rule already exists → enable it
            </li>
            <li>
              <span className="font-mono text-foreground">⛓ hook</span> — action
              rules a linter can't see (git push, rm -rf)
            </li>
            <li>
              <span className="font-mono text-foreground">⚙ custom rule</span> —
              no off-the-shelf rule fits, but a custom one CAN (“wrap API calls
              in retry”) → the opt-in synthesis skill, gated
            </li>
            <li>
              <span className="font-mono text-foreground">✎ judgment call</span>{" "}
              — genuinely undecidable (“readable”), honestly left as prose
            </li>
          </ul>
          <RuleMapNextSteps />
        </>
      )}
    </div>
  );
}

/** The POSSIBLE (review) + SKIPPED tiers — detection is precision-first, so this
 * is where a rule-ish bullet below the confidence bar (possible) and the bullets
 * we set aside with a reason (skipped) surface, so nothing is silently dropped. */
function RuleMapTiers({ routing }: { routing?: RuleRouting }) {
  const possible = routing?.possible ?? [];
  const skipped = routing?.skipped ?? [];
  if (possible.length === 0 && skipped.length === 0) return null;
  const byReason: Record<string, number> = {};
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  return (
    <div className="mt-5 space-y-3">
      {possible.length > 0 && (
        <div>
          <p className="text-[15px] font-semibold text-foreground">
            ? {possible.length} possible — rule-ish, below the confidence bar
            (review)
          </p>
          <ul className="mt-1 space-y-0.5">
            {possible.slice(0, 6).map((r, i) => (
              <li
                key={`${r.lineStart}-${i}`}
                className="truncate text-sm italic text-muted-foreground"
              >
                “{r.text}”
              </li>
            ))}
            {possible.length > 6 && (
              <li className="text-sm text-muted-foreground">
                +{possible.length - 6} more
              </li>
            )}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <p className="text-[15px] text-foreground-soft">
          ⊘ {skipped.length} skipped — not treated as rules (
          {Object.entries(byReason)
            .map(([reason, n]) => `${n} ${reason}`)
            .join(" · ")}
          )
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Detection is a best-effort, precision-first filter — it won’t catch
        every rule. Full per-bullet lists are in the JSON report.
      </p>
    </div>
  );
}

/** The honest, opt-in next step per lane — no fabricated command. `vigiles
 * compile` appears ONLY for hooks (it genuinely compiles a hook to settings);
 * reuse is a config line / the strengthen skill; synthesis is a planned skill. */
function RuleMapNextSteps() {
  return (
    <div className="mt-5 max-w-[34rem] space-y-2 text-[15px] leading-relaxed text-foreground-soft">
      <p>
        <span className="font-medium text-foreground">Enforceable now</span> —
        enable each in your lint config (one line), or ask your agent to run the{" "}
        <code className="rounded-md bg-code px-1.5 font-mono">strengthen</code>{" "}
        skill.
      </p>
      <p>
        <span className="font-medium text-foreground">Hooks</span> — author a
        compiled hook in{" "}
        <code className="rounded-md bg-code px-1.5 font-mono">
          .vigiles/hooks/
        </code>
        , then{" "}
        <code className="rounded-md bg-code px-1.5 font-mono">
          npx vigiles compile
        </code>{" "}
        wires it into your settings.
      </p>
      <p>
        <span className="font-medium text-foreground">Custom rule (⚙)</span> —
        no off-the-shelf rule fits, but a custom one CAN enforce it (e.g. “wrap
        API calls in a retry”). Doable, not a dead end — the opt-in synthesis
        skill writes and gates it (with a bit of codebase context); it abstains
        rather than ship a checker it can’t prove sound. Nothing is generated
        for you automatically.
      </p>
      <p>
        <span className="font-medium text-foreground">Judgment call (✎)</span> —
        genuinely undecidable (“keep it readable”); no checker can decide it, so
        it honestly stays prose.
      </p>
    </div>
  );
}

export function RuleInventory({
  data,
  routing,
}: {
  data: RuleInventoryItem[];
  routing?: RuleRouting;
}) {
  const enforced = data.filter((r) => r.configState === "in-config");
  const preset = data.filter((r) => r.configState === "preset-maybe");
  const oneLine = data.filter((r) => r.configState === "not-in-config");
  const contradiction = data.filter((r) => r.configState === "contradiction");
  const total = data.length;

  // 100% stacked distribution bar — makes N rows read as a system, not a stub.
  const seg = (n: number, bg: string) =>
    n > 0 ? (
      <div className={cn(bg)} style={{ flexGrow: n }} aria-hidden />
    ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* A tool whose pitch is "your config lies about your rules" must not
            round a maybe up to a yes: `enforced` and `preset-maybe` are counted
            (and coloured) separately. */}
        <p className="text-base text-foreground-soft">
          <span className={cn("font-semibold", TEXT.good)}>
            {enforced.length}
          </span>{" "}
          of {total} enforced
          {preset.length > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-foreground">
                {preset.length}
              </span>{" "}
              likely via a preset
            </>
          )}
          {oneLine.length > 0 && (
            <>
              {" · "}
              <span className={cn("font-semibold", TEXT.warn)}>
                {oneLine.length}
              </span>{" "}
              {oneLine.length === 1 ? "is" : "are"} one config line away
            </>
          )}
          {contradiction.length > 0 && (
            <>
              {" · "}
              <span className={cn("font-semibold", TEXT.bad)}>
                {contradiction.length}
              </span>{" "}
              contradicted by config
            </>
          )}
          .
        </p>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Zap size={14} aria-hidden /> deterministic · no model
        </span>
      </div>

      <div className="flex h-2 overflow-hidden rounded-full bg-border">
        {seg(enforced.length, BG.good)}
        {seg(preset.length, BG.na)}
        {seg(oneLine.length, BG.warn)}
        {seg(contradiction.length, BG.bad)}
      </div>

      {/* Contradiction — the "your docs say enforce it, your config turns it off"
          row. Most interesting single finding; shown, never nudged on. */}
      {contradiction.length > 0 && (
        <ul>
          {contradiction.map((item) => (
            <RuleRow
              key={item.rule}
              item={item}
              tone="bad"
              label="⛔ set to off in your config — your call"
              action
            />
          ))}
        </ul>
      )}

      {/* One line away — the actionable group, open on top. */}
      {oneLine.length > 0 && (
        <ul>
          {oneLine.map((item) => (
            <RuleRow
              key={item.rule}
              item={item}
              tone="warn"
              label="enable in 1 line"
              action
            />
          ))}
        </ul>
      )}

      {enforced.length > 0 && (
        <FoldedGroup
          title={`✓ ${enforced.length} already enforced`}
          tone="good"
        >
          {enforced.map((item) => (
            <RuleRow key={item.rule} item={item} tone="good" label="enforced" />
          ))}
        </FoldedGroup>
      )}

      {preset.length > 0 && (
        <FoldedGroup
          title={`◦ ${preset.length} likely enforced via a preset`}
          tone="muted"
        >
          {preset.map((item) => (
            <RuleRow key={item.rule} item={item} tone="muted" label="preset?" />
          ))}
        </FoldedGroup>
      )}

      {/* Zone 2 — "your rules, mapped": the deterministic routing preview (real
          counts + examples) with an honest, opt-in next step per lane. */}
      <RuleMap routing={routing} />
    </div>
  );
}
