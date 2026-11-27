import type { CSSProperties } from "react";

/** One prompt's tally, as `vigiles eval --update` writes it into the lock. */
export interface PromptTally {
  prompt: string;
  fired: number;
  trials: number;
}

/**
 * An eval at a glance: one row per phrasing, one dot per try.
 *
 * Built for a reader who has never heard the word "eval". Two groups, each
 * answering one plain question:
 * - SHOULD fire: requests the skill exists for. A filled dot is a try where the
 *   model picked the skill; a hollow one is a try where it did not.
 * - Should STAY QUIET: ordinary requests the skill must not hijack. A dot lights
 *   up (in the warning colour) only on a false fire.
 *
 * Every number comes from the committed lock: nothing here is typed by hand.
 */
export function EvalGrid({
  should,
  quiet,
}: {
  should: readonly PromptTally[];
  quiet: readonly PromptTally[];
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-5">
      <Group
        title="Should use the skill"
        tallies={should}
        verdict={(hits, runs) => `${pct(hits, runs)} picked it`}
        lit="hit"
      />
      {quiet.length > 0 && (
        <Group
          title="Should leave it alone"
          tallies={quiet}
          verdict={(hits, runs) =>
            hits === 0 ? "never misfired" : `misfired ${pct(hits, runs)}`
          }
          lit="misfire"
          summaryOnly
        />
      )}
    </div>
  );
}

const pct = (hits: number, runs: number) =>
  `${String(Math.round((hits / runs) * 100))}%`;

const sum = (ts: readonly PromptTally[], k: "fired" | "trials") =>
  ts.reduce((n, t) => n + t[k], 0);

/** Lit dots are the event the group counts; the rest are hollow. */
function Dots({ lit, of, tone }: { lit: number; of: number; tone: Tone }) {
  return (
    <span className="inline-flex shrink-0 gap-1" aria-hidden>
      {Array.from({ length: of }, (_, k) => (
        <span key={k} style={dot(k < lit, tone)} />
      ))}
    </span>
  );
}

type Tone = "hit" | "misfire";

// Inline so the dots exist where no stylesheet loads (the browser tests).
const dot = (on: boolean, tone: Tone): CSSProperties => ({
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: 999,
  boxSizing: "border-box",
  border: `1.5px solid ${on ? colour[tone] : "#c9c3b6"}`,
  background: on ? colour[tone] : "transparent",
});

const colour: Record<Tone, string> = { hit: "#4f8a4c", misfire: "#c2553f" };

function Group({
  title,
  tallies,
  verdict,
  lit,
  summaryOnly = false,
}: {
  title: string;
  tallies: readonly PromptTally[];
  verdict: (hits: number, runs: number) => string;
  lit: Tone;
  summaryOnly?: boolean;
}) {
  const hits = sum(tallies, "fired");
  const runs = sum(tallies, "trials");
  return (
    <div className="mb-4 last:mb-0" data-testid={`eval-group-${lit}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="text-[14px] text-muted-foreground">
          {verdict(hits, runs)}
        </span>
      </div>
      {summaryOnly ? (
        <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
          <span>
            {String(tallies.length)} unrelated requests ×{" "}
            {String(tallies[0]?.trials ?? 0)} tries
          </span>
          <Dots lit={hits} of={runs} tone={lit} />
        </div>
      ) : (
        <ul className="m-0 list-none space-y-1.5 p-0">
          {tallies.map((t) => (
            <li
              key={t.prompt}
              data-testid="eval-row"
              className="flex items-center justify-between gap-3 text-[13px]"
            >
              <span
                className="min-w-0 text-muted-foreground"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={t.prompt}
              >
                “{t.prompt}”
              </span>
              <Dots lit={t.fired} of={t.trials} tone={lit} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
