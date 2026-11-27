import { CodeBlock } from "@/components/CodeBlock";
import { Term } from "@/components/Term";

const DOCS = "https://github.com/zernie/vigiles/blob/main/docs";

// Marker syntax: docs/verifying-instruction-files.md ("Markdown mode"). The
// marker is on line 4, which is the line number the output below reports.
const CLAUDE_MD = `# CLAUDE.md
## Logging
Never use console.log in src/.
<!-- vigiles:enforce eslint/no-console "Route output through logger.ts" -->`;

// Message format: src/cli-main.ts (`  ✗ line N: Rule "…" exists but is disabled
// in <linter> config`); exit 2 is the lint failure code.
const RULE_OUTPUT = `  ✗ line 4: Rule "eslint/no-console" exists but is disabled in eslint config
exit 2`;

// Real output of `vigiles lint`, captured 2026-11-27: a 64,813-char CLAUDE.md
// with a recorded baseline, then one line added. Do not hand-edit the numbers.
const CREEP_OUTPUT = `$ npx vigiles lint
✗ [context-creep] always-loaded context is over the harness's limit: instructions 64,874 chars, limit 40,000 (the harness's own) — 24,874 over
  Grew 64,813 → 64,874 chars (+61) over the recorded baseline. Changed: CLAUDE.md (instructions) +61.
1 finding(s): 1 error, 0 warning — exit 2`;

function DocLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-block text-[15px] font-medium text-accent no-underline hover:underline"
    >
      {children}
    </a>
  );
}

export function Lint() {
  return (
    <section id="lint" className="band mx-auto w-full max-w-[1180px] px-6">
      <h2 className="section-title">Lint what your instructions claim.</h2>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-[1000px]:gap-16">
        <div className="min-w-0">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
            A rule your linter switched off
          </h3>
          <p className="mb-5 mt-1.5 text-muted-foreground">
            Your CLAUDE.md names a rule. vigiles checks it exists and is on.
          </p>
          <Term copyText={`${CLAUDE_MD}\n\n$ npx vigiles lint\n${RULE_OUTPUT}`}>
            <CodeBlock
              code={CLAUDE_MD}
              language="markdown"
              className="rounded-none border-0 bg-transparent! p-0! text-[12px]"
            />
            <pre className="mt-5">
              <span className="t-mut">$</span> npx vigiles lint
            </pre>
            <pre className="mt-1">
              <span className="t-bad">
                {
                  '  ✗ line 4: Rule "eslint/no-console" exists but is disabled in eslint config'
                }
              </span>
              {"\n"}
              <span className="t-mut">exit 2</span>
            </pre>
          </Term>
          <DocLink href={`${DOCS}/verifying-instruction-files.md`}>
            How lint works ›
          </DocLink>
        </div>
        <div className="min-w-0">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
            A CLAUDE.md that keeps growing
          </h3>
          <p className="mb-5 mt-1.5 text-muted-foreground">
            Every session pays for it. lint fails when it grows past your
            baseline.
          </p>
          <Term copyText={CREEP_OUTPUT}>
            {CREEP_OUTPUT.split("\n").map((line, n) => (
              <pre key={n}>
                {line.startsWith("$ ") ? (
                  <>
                    <span className="t-mut">$</span>
                    {line.slice(1)}
                  </>
                ) : line.startsWith("✗") ? (
                  <span className="t-bad">{line}</span>
                ) : (
                  line
                )}
                {"\n"}
              </pre>
            ))}
          </Term>
          <DocLink href={`${DOCS}/rules/context-creep.md`}>
            How the context check works ›
          </DocLink>
        </div>
      </div>
      <p className="mt-14 text-[15px] text-muted-foreground">
        Experimental:{" "}
        <a
          href={`${DOCS}/compiled-hooks.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground"
        >
          compiled hooks
        </a>{" "}
        — write a hook as a typed function, get the exit codes right by
        construction.
      </p>
    </section>
  );
}
