import { useEffect, useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { Term, useCopy } from "@/components/Term";

const REPO = "https://github.com/zernie/vigiles";

// Real output of `node dist/cli.js audit .`, captured 2026-11-27 on a fixture
// repo: a subagent `reviewer` listing tools Read, Grep, Bassh (typo) and a skill
// `release` whose description is "Helps.". Re-capture it the same way; never
// hand-edit the numbers.
const AUDIT_OUTPUT = `$ npx vigiles audit
  ● Truthfulness   100  ██████████████████████
  ● Triggering      90  ████████████████████░░
       └ 1 skill with no usable description (can't trigger)
  ◑ Structure       89  ████████████████████░░
       └ 1 unavailable agent tool (typo / never-available)
  ● Safety          90  ████████████████████░░

Harness health: C (72/100)

✗ [FIX] reviewer
    why: Tool "Bassh" matches no known name — the subagent never gets it. Did you mean "Bash"?
    →    In "reviewer", change the tool "Bassh" to "Bash"`;

/** One output line, tinted by what it is. Colour is presentation only. */
function AuditLine({ line }: { line: string }): ReactNode {
  if (line.startsWith("$ ")) {
    return (
      <>
        <span className="t-mut">$</span>
        {line.slice(1)}
      </>
    );
  }
  if (line.includes("└")) return <span className="t-mut">{line}</span>;
  if (line.startsWith("Harness health"))
    return <b className="t-warn font-bold">{line}</b>;
  if (line.startsWith("✗")) return <span className="t-bad">{line}</span>;
  const glyph = line.match(/^ {2}([●◑])/);
  if (glyph) {
    return (
      <>
        {"  "}
        <span className={glyph[1] === "●" ? "t-ok" : "t-warn"}>{glyph[1]}</span>
        {line.slice(3)}
      </>
    );
  }
  return line;
}

const WORDS = ["Claude Code", "Codex"] as const;
const SWAP_MS = 2600;
const FADE_MS = 350;

/** The headline's harness name: cross-fades Claude Code ⇄ Codex, still when
 *  the visitor prefers reduced motion. */
function SwapWord() {
  const [i, setI] = useState(0);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let fade: number | undefined;
    const tick = window.setInterval(() => {
      setOut(true);
      fade = window.setTimeout(() => {
        setI((n) => (n + 1) % WORDS.length);
        setOut(false);
      }, FADE_MS);
    }, SWAP_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(fade);
    };
  }, []);
  return (
    <span
      className={`inline-block text-accent transition-[opacity,transform] duration-[350ms] motion-reduce:transition-none ${out ? "translate-y-[0.25em] opacity-0" : ""}`}
    >
      {WORDS[i]}
    </span>
  );
}

const NAV_LINK =
  "ml-[22px] text-sm text-muted-foreground no-underline transition-colors hover:text-foreground";

export function Hero() {
  const cmd = useCopy("npx vigiles audit");
  return (
    <header className="mx-auto w-full max-w-[1180px] px-6">
      <nav className="flex items-center justify-between py-[22px]">
        <a href="./" className="flex items-center gap-2 no-underline">
          <img
            src="./logo.png"
            alt=""
            className="h-7 w-7 rounded-md"
            width={28}
            height={28}
          />
          <span className="text-sm font-semibold">vigiles</span>
        </a>
        <span>
          <a
            href={`${REPO}/blob/main/docs/README.md`}
            target="_blank"
            rel="noopener noreferrer"
            className={NAV_LINK}
          >
            Docs
          </a>
          <a
            href={REPO}
            target="_blank"
            rel="noopener noreferrer"
            className={NAV_LINK}
          >
            GitHub
          </a>
        </span>
      </nav>

      <div className="mx-auto max-w-[860px] pt-8 text-center sm:pt-[104px]">
        <h1 className="mb-4 text-[clamp(36px,7vw,88px)] sm:mb-6 font-bold leading-[1.02] tracking-[-0.045em]">
          Lint and test your <br />
          <SwapWord /> setup.
        </h1>
        <p className="mx-auto mb-7 max-w-[560px] text-base sm:mb-9 sm:text-lg leading-[1.45] text-muted-foreground sm:text-[21px]">
          Skills that never fire. Hooks that never block. Rules that point at
          nothing.
        </p>
        <button
          type="button"
          onClick={cmd.copy}
          aria-label="Copy command: npx vigiles audit"
          className="inline-flex items-center gap-2.5 rounded-full border border-[#d9d3c5] bg-transparent px-[18px] py-3 font-mono text-[15px] text-foreground"
        >
          npx vigiles audit
          {cmd.copied ? (
            <Check className="h-3.5 w-3.5 opacity-70" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5 opacity-50" aria-hidden />
          )}
        </button>

        <div className="mx-auto mt-8 max-w-[860px] text-left sm:mt-[72px]">
          <Term copyText={AUDIT_OUTPUT}>
            {AUDIT_OUTPUT.split("\n").map((line, n) => (
              <pre key={n}>
                <AuditLine line={line} />
                {"\n"}
              </pre>
            ))}
          </Term>
        </div>
      </div>
    </header>
  );
}
