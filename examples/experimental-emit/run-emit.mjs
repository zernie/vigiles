/**
 * 💵 PAID. The prototype measurement behind the `experimental_emitTool` channel:
 * can an UNFORKED skill emit a structured, observable result by calling a tool?
 *
 *   node examples/experimental-emit/run-emit.mjs <skill-dir> [trials] [maxCostUsd]
 *
 * `<skill-dir>` is a real skill directory (one containing `SKILL.md`) taken from
 * the operator's own corpus. Nothing from it is written back here — the copy is
 * built into a throwaway fixture at run time, so a private corpus stays private.
 *
 * What it does:
 *  1. reads `<skill-dir>/SKILL.md` and asserts it has NO `context: fork` — the
 *     whole question is about the skills that cannot carry an `output:` today;
 *  2. replaces exactly ONE section — the h2 whose heading reads "Record the verdict",
 *     numbered or not (which today shells out to a ledger script) — with
 *     `experimental_emitTool(contract).instruction`;
 *  3. serves `experimental_emitTool(contract).tool` from `emit-server.mjs` over a
 *     cwd `.mcp.json`, so no approval prompt and no global config are involved;
 *  4. runs the skill through the real CLI and reads the result back out of
 *     `ctx.toolCalls` with `experimental_parseEmitted`.
 *
 * Every trial is appended to `records/records-emit.jsonl` the moment it is
 * measured — a buffered write at the end loses the run when the container dies.
 *
 * ⚠️ Not named `*.eval.mjs` on purpose: that suffix makes a file discoverable by
 * `vigiles eval --all`, and a paid run must never be reachable from a CI sweep.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import MarkdownIt from "markdown-it";

import { experimental_agent } from "../../dist/core/spec.js";
const { result } = experimental_agent;
import {
  experimental_emitTool,
  experimental_parseEmitted,
} from "../../dist/experimental-emit.js";
import { runEval, formatEvalReport } from "../../dist/eval.js";

const skillDir = resolve(process.argv[2] ?? "");
const trials = Number(process.argv[3] ?? 3);
const maxCostUsd = Number(process.argv[4] ?? 0.6);
const MODEL = process.env.VIGILES_MODEL || "sonnet";

const HERE = new URL(".", import.meta.url).pathname;
const RECORDS_DIR = `${HERE}records`;
mkdirSync(RECORDS_DIR, { recursive: true });
const RECORDS = `${RECORDS_DIR}/records-emit.jsonl`;
const TOOL_JSON = `${RECORDS_DIR}/emit-tool.json`;
const EMITTED = `${RECORDS_DIR}/emitted.jsonl`;
const EMITS = `${RECORDS_DIR}/emits.jsonl`;

// --- 1. the skill, unmodified except for its output section -----------------

const skillName = basename(skillDir);
const original = readFileSync(`${skillDir}/SKILL.md`, "utf8");
if (/^context:\s*fork\s*$/m.test(original)) {
  throw new Error(
    `${skillName} declares context: fork — it can already carry an output: contract. ` +
      `This measurement is about the skills that cannot.`,
  );
}

/** The verdict vocabulary these skills record today: FINDING <count> <report> | ABSTAINED <reason> <line>. */
const CONTRACT = result(
  { verdict: "string", count: "number", report: "string" },
  { reason: "string", detail: "string" },
);
const emit = experimental_emitTool(CONTRACT);
writeFileSync(TOOL_JSON, JSON.stringify(emit.tool, null, 2));

// 🔴 The matcher used to be `original.includes("## Record the verdict")`, and it
// REFUSED 5 of the 22 recording skills in the dogfood corpus — 4 of them wrongly.
// Their heading is numbered or reworded, which is a formatting choice, not a
// different section:
//
//   ## 6. Record the verdict          (camera-ready, submit-paper, verify-citations)
//   ## 5. Record the verdict          (plan-paper-timeline)
//   ## Step 8 — record the verdict    (map-prior-work — and lowercase `record`)
//
// So the heading is read as a HEADING, through the parser, not as a substring of
// the file. A string search cannot tell a heading from the same words inside a
// fenced block or a sentence, and has no notion of heading LEVEL; markdown-it
// gives both. (Same call this repo's own linters make — see the four times a
// regex over markdown structure silently matched the wrong thing.)
const md = new MarkdownIt();

// ⚠️ Frontmatter must go before parsing. A `---` fence is SETEXT syntax: markdown-it
// reads the whole YAML block as an <h2> whose text is `name: … description: …`.
// Measured on this corpus — every skill produced one such phantom heading, and a
// description containing the words "record the verdict" would have matched it and
// spliced the emit into the frontmatter. Blank lines, not deletion, so every
// remaining heading keeps its original line number.
const fm = original.match(/^---\n[\s\S]*?\n---\n/);
const body = fm
  ? "\n".repeat(fm[0].split("\n").length - 1) + original.slice(fm[0].length)
  : original;
const tokens = md.parse(body, {});

/**
 * "## 6. Record the verdict" and "## Step 8 — record the verdict" are the same section.
 * The separator class includes WHITESPACE: without it `Step 8 — record` fails, because
 * the dash is a space away from the digit. Caught by running this over the real 22, not
 * over an example I made up — the invented case had no space.
 */
const isVerdictHeading = (text) =>
  /^(?:step\s*)?\d*[\s.)—–-]*record the verdict\b/i.test(text.trim());

const headings = tokens
  .map((t, i) => ({ t, inline: tokens[i + 1] }))
  .filter(({ t }) => t.type === "heading_open" && t.tag === "h2" && t.map)
  .map(({ t, inline }) => ({ line: t.map[0], text: inline?.content ?? "" }));

const target = headings.find((h) => isVerdictHeading(h.text));
if (!target) {
  throw new Error(
    `${skillName} has no "Record the verdict" section to swap for an emit. ` +
      `Its h2 headings are: ${headings.map((h) => JSON.stringify(h.text)).join(", ") || "none"}.`,
  );
}

// The section ends at the NEXT h2, not at end-of-file: in all 22 recorders this
// section is followed by `## Rules` / `## Compose` / `## Provenance`, so cutting
// to the end would silently delete the rest of the skill.
const lines = original.split("\n");
const nextH2 = headings.find((h) => h.line > target.line);
const before = lines.slice(0, target.line).join("\n");
const after = nextH2 === undefined ? "" : lines.slice(nextH2.line).join("\n");
const patched = `${before}\n${emit.instruction}\n\n${after}`;

// --- 2. the fixture: a tiny paper the skill has something real to say about --

const BUILD_SH = `#!/usr/bin/env bash
echo "body pages: 9 (limit 8)"
echo "VERDICT: BLOCKED — over the page limit by 1 page"
echo "Overfull \\\\hbox (12.3pt too wide) in paragraph at lines 88--90"
`;

const PIPELINE_STATUS = `# PIPELINE-STATUS

| stage | state | date | verdict |
|---|---|---|---|
| tighten-paper | ☑ | 2026-08-02 | 6 CUT actions applied |
| grade-paper-writing | ☑ | 2026-08-02 | 3.4 / 5 |
| pc-panel-review | ☑ | 2026-08-01 | Weak Accept (p=0.45) |
| verify-citations | ☐ | — | never run |

Submit-ready verdict: NOT READY.
`;

const SUBMIT_CHECKLIST = `# SUBMIT-CHECKLIST

- Page limit: 8 (hard)
- Template: ACM sigconf
- Blind model: double-blind
- Portal: HotCRP — **no account created yet**
- Supplementary upload field: none — the artifact needs external hosting
- Deadline: 2026-09-14 AoE
`;

const FIXTURE = {
  [`.claude/skills/${skillName}/SKILL.md`]: patched,
  ".mcp.json": JSON.stringify(
    {
      mcpServers: {
        emit: {
          command: "node",
          args: [`${HERE}emit-server.mjs`],
          env: { VIGILES_EMIT_TOOL_JSON: TOOL_JSON, VIGILES_EMIT_OUT: EMITTED },
        },
      },
    },
    null,
    2,
  ),
  "paper/repro/build-submission.sh": BUILD_SH,
  "paper/PIPELINE-STATUS.md": PIPELINE_STATUS,
  "paper/SUBMIT-CHECKLIST.md": SUBMIT_CHECKLIST,
  "paper/paper.md": "# A Measurement Paper\n\nBody elided for the fixture.\n",
};

// --- 3. run it, recording each trial as it lands ----------------------------

// $0 rehearsal: print what the model would be given and stop. Everything above
// this line is free, and a broken section swap must not be discovered by paying
// for three trials.
if (process.env.VIGILES_EMIT_DRY) {
  console.log(patched);
  console.log(
    `\n--- dry run: ${skillName}, ${String(patched.split("\n").length)} lines, ` +
      `tool ${emit.tool.name}, fixture ${String(Object.keys(FIXTURE).length)} files ---`,
  );
  process.exit(0);
}

writeFileSync(RECORDS, "");
writeFileSync(EMITTED, "");
writeFileSync(EMITS, "");
let seq = 0;
let emitSeq = 0;

const report = await runEval({
  name: `emit from an UNFORKED skill (${skillName})`,
  env: { kind: "ephemeral" }, // a throwaway HOME and a scrubbed environment
  fixture: FIXTURE,
  arms: { emit: {} },
  task:
    `Use the ${skillName} skill on the paper directory \`paper\`. ` +
    `Follow the skill exactly, including its Output contract section.`,
  measure: (ctx) => {
    const parsed = experimental_parseEmitted(ctx.toolCalls, CONTRACT);
    const emitCalls = ctx.toolCalls.filter((c) => /emit_result$/.test(c.name));
    const skillCalls = ctx.toolCalls.filter((c) => c.name === "Skill");
    // The scorer's input: the tool call exactly as the runtime delivered it, so
    // `score-emits.mjs` re-runs the parse for free after any change to it.
    for (const c of emitCalls) {
      appendFileSync(
        EMITS,
        JSON.stringify({
          run: ++emitSeq,
          cwd: `trial-${String(seq)}`,
          at: new Date().toISOString(),
          name: c.name,
          input: c.input,
        }) + "\n",
      );
    }
    appendFileSync(
      RECORDS,
      JSON.stringify({
        seq: seq++,
        skill: skillName,
        model: MODEL,
        kind: parsed.kind,
        reason: parsed.kind === "malformed" ? parsed.reason : undefined,
        value: parsed.kind === "ok" ? parsed.value : undefined,
        error: parsed.kind === "err" ? parsed.error : undefined,
        emitCalls: emitCalls.length,
        emitArgs: emitCalls.map((c) => c.input),
        skillActivations: skillCalls.map((c) => c.input),
        toolNames: ctx.toolCalls.map((c) => c.name),
        costUsd: ctx.usage.costUsd,
      }) + "\n",
    );
    return {
      emitted: emitCalls.length > 0,
      exactly_one: emitCalls.length === 1,
      parsed_ok: parsed.kind === "ok",
      skill_activated: skillCalls.length > 0,
    };
  },
  trials,
  model: MODEL,
  allowedTools: [
    "Skill",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "mcp__emit__emit_result",
  ],
  maxCostUsd,
  spacingSec: 3,
  // 🔴 NOT the default 3. Measured 2026-08-13: the CLI emits an informational
  // `rate_limit_event` line on every run, `isRateLimited` matched it, and every
  // trial silently ran `retries + 1` = 4 times — 8 model runs for 2 trials, with
  // only the LAST attempt's cost reaching `maxCostUsd`, so a $0.60 cap was crossed
  // at roughly $3. The pattern is fixed in `src/eval.ts`; this stays at 0 anyway,
  // because on a PAID script a silent re-run is the expensive failure and a real
  // rate limit is a visible one.
  rateLimitRetries: 0,
});

console.log(formatEvalReport(report));
console.log(
  `\nmodel=${MODEL} totalCostUsd=${report.totalCostUsd} aborted=${report.aborted}`,
);
console.log(`records → ${RECORDS}`);
console.log(`server-side record → ${EMITTED}`);
