# Safety — vigiles runs untrusted code, and a real model that decides

> **Status: INTERNAL / WIP — not surfaced in the public docs yet.** The shipped,
> solid pieces are host **confinement** (bubblewrap + egress — see
> [`sandboxing.md`](sandboxing.md)) and the eval-tier **`interceptTools`**
> side-effect prevention. The deterministic _authoring-side_ safety model it ties
> together (the `purity` floor + the **parked** `effect()` sub-region)
> is still settling, so this "safety model" front door isn't linked from the README
> until it's coherent end-to-end. Read it as design intent, not a finished guarantee.

**Testing a harness means executing other people's code with your privileges** — and, at the eval tier, letting a real model decide which tools to call. Both are deliberate (that's the point: test what actually ships), and both are risks. This is the honest, end-to-end account of what vigiles protects, what it doesn't, and the one rule that makes it safe by default.

For the deep mechanics of host confinement, see [`sandboxing.md`](sandboxing.md). This doc is the front door that ties the whole model together — including the part `sandboxing.md` doesn't cover: preventing a **real model's tool side effects** during an eval.

## Does vigiles send my code anywhere?

The first question in a private monorepo, and it deserves a direct answer rather
than an inference from the confinement sections below. Those answer "how do I
safely run code I am TESTING"; this answers "what does the tool itself transmit".

| What you run                                | What leaves your machine                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vigiles lint`                              | **Nothing.** Reads files, resolves rule names against the linter configs and binaries already installed locally.                                                                                            |
| `vigiles audit` (default)                   | **Nothing.** A deterministic read — see [Audit is side-effect free](#the-one-rule-safe-by-default-never-silently-unconfined).                                                                               |
| `vigiles audit` + measure consent           | Starts **your own** MCP servers, and spends **your own** model quota. Both are opt-in, asked once at a TTY, and never taken headlessly.                                                                     |
| `vigiles test` (unit / deterministic tiers) | **Nothing.** No model, no key — the mock is co-launched locally.                                                                                                                                            |
| `vigiles eval`                              | Drives **your own** `claude` CLI, so your content reaches Anthropic exactly as it does when you use Claude Code yourself — under your session, your terms, your subscription. No third party is introduced. |

There is **no telemetry, no analytics, no usage reporting, and no license or
version check** — verified by construction, not by policy: vigiles ships no HTTP
client. Its runtime dependencies are parsers and matchers only (ast-grep, toml,
yaml, markdown-it, mvdan-sh, glob, minimatch, cosmiconfig, ci-info, typescript),
and there is no `fetch` in the shipped source.

The practical consequence: the free tier is usable inside an air-gapped or
egress-restricted network, and nothing you scan is ever sent to _us_, because
there is no _us_ to send it to — there is no service, only a CLI on your machine.

## Two distinct risks → two distinct mechanisms

| Risk                  | What can go wrong                                                                               | The mechanism                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Foreign code**      | A hook / plugin / skill you test runs with your privileges — it can read, write, phone home.    | **Confinement** — bubblewrap (`bwrap`): no egress, read-only `/`, cleared env.     |
| **A model's actions** | At the eval tier a _real_ model can **decide** to `git push`, hit a paid API, spawn a subagent. | **Interception** — a `PreToolUse` hook **denies** the matched call before it runs. |

These compose. An eval of an untrusted plugin gets **both** — the plugin code is confined, and the model's tool calls are intercepted.

## Running is itself a side effect — ephemerality (orthogonal to trust)

**Confinement answers "can this code touch my host?" — but that's only half the question.** The second, independent question is: does _running_ it change my state? A skill or agent is model-driven. Even a plugin _you wrote_, the model decides the actions — nondeterministically. "I trust the code" ≠ "running it is safe to do in my real working tree."

Two orthogonal questions govern this, not one:

| Question                                                | Governed by                                                               | Mechanism                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| **Host protection** — can it read my secrets/escape?    | **provenance** (yours → direct, foreign → confined)                       | bwrap (Linux); Seatbelt (macOS, planned) |
| **State protection** — does running it mutate my world? | **always ephemeral** (trust is irrelevant — the _model_ chose the action) | disposable env + interception            |

**Provenance lets you skip confinement. It does not let you skip ephemerality.** Side effects sort by reversibility, which decides the layer:

| Side effect            | Example                     | Layer                                               | Cross-platform?                                      |
| ---------------------- | --------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Local, reversible      | file edit, local commit     | **ephemeral CWD** (discard the temp dir)            | ✅ done (`mkdtemp` per run)                          |
| Local, escapes CWD     | write `~/.gitconfig`, `~/…` | **ephemeral HOME + scrubbed env**                   | ✅ cheap — **gap on the direct path today**          |
| External via network   | `git push`, paid API, exfil | **deny-all / allowlist net** (bwrap+nft / Seatbelt) | ⚠️ Linux today (bwrap+nft); macOS planned (Seatbelt) |
| Irreversible, specific | push to prod, charge a card | **`interceptTools` deny / `notTool` assert**        | ✅ harness-layer                                     |

**The last row is why ephemerality alone isn't enough.** You can throw away a temp dir. You **can't un-push or un-charge** — those escape any box and need interception or a network wall.

**Where vigiles is today:** every run already executes in a fresh `mkdtemp` temp dir (`cwd`), so local file writes are contained and discarded. But the **direct/non-confined path inherits the real `$HOME` and environment** (`eval.ts`: `env: { ...process.env }`), so a model-driven `git push` / write to `~` still escapes. Closing it requires an **ephemeral run environment** (throwaway HOME + scrubbed env) for every model-driven run, trusted or not — with one nuance: a real-model eval still needs the harness's _own_ auth (`~/.claude` / `ANTHROPIC_API_KEY`), so it's "fresh HOME with **only** the harness credential injected," not a blanket wipe. **Status: shipped, and a choice you must make.** `runEval` requires `env`: `{ kind: "ephemeral" }` (a throwaway HOME, optionally seeded with `home: { kind: "files", files }`) or `{ kind: "inherit", reason }` (your real HOME; the reason is printed with the report). There is no default, because each is wrong silently in one case: inheriting measures your machine, and an ephemeral run fails if your credential is not where the harness expects it — loudly, on trial 1, so it is the one to try first. The pure pieces (`scrubbedRunEnv` / `withoutSessionIdentity` in `src/core/run-env.ts`, `ephemeralRunEnv` / `seedEphemeralHome` in `eval.ts`) and the scrubbed-env wiring are unit-tested (`src/core/run-env.test.ts`, `eval.test.ts`, `src/adapters/claude-code/run-env.test.ts`). This needs **no kernel features**, so it lands on macOS immediately, independent of the Seatbelt backend.

### What a child run inherits, exactly

A run vigiles starts can itself be started from inside a live agent session (an eval launched by an agent, a harness test run from a hook). That session marks itself in the process environment, and a child that inherits those variables runs **as** the parent session: measured on Claude Code 2.1.292 (2026-10-07), a child `claude -p` started with them wrote into the parent's live task list. So **no child run inherits the harness's session identity, in any mode.** Which variables are identity and which are auth is declared by the adapter (`runtime.runEnv`, see [adapter-api.md](adapter-api.md)); for Claude Code the lists are in `src/adapters/claude-code/runtime.ts`.

| Run                                                                                                                         | HOME                                                                                                                             | Environment the child gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runEval` with `env: { kind: "ephemeral" }`                                                                                 | throwaway, under the trial's temp dir; the `home` seed written first, then `.claude/.credentials.json` copied in if you have one | `PATH`, `LANG`, `TERM`, `LC_*`; the harness's declared auth (`runEnv.keep`: for Claude Code the `ANTHROPIC_*` key/token/URL/model, `CLAUDE_CODE_OAUTH_TOKEN`, client certificates, the Bedrock/Vertex/Foundry switches and their region/profile vars); the eval's own `VIGILES_*` variables; `HOME`/`TMPDIR` set to the throwaway dir. **Nothing else** — not `CLAUDE_CONFIG_DIR` (it would point the run back at your real config), not proxy or CA variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`), not `GIT_*`, `GH_TOKEN`, `SSH_*` or AWS access keys. |
| `runEval` with `env: { kind: "inherit", reason }`; `measure`, `paid_measureArms`, `measureTriggerRate` (they have no `env`) | your real HOME                                                                                                                   | your whole environment **minus the session identity**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `runHarnessTest` (scripted model, direct path)                                                                              | your real HOME                                                                                                                   | your whole environment minus the session identity, plus the mock wiring (`ANTHROPIC_BASE_URL` → the local mock, a dummy key)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| the free preflight of `experimental_outputStyleArms`                                                                        | throwaway, empty                                                                                                                 | `PATH`, `LANG`, `TERM`, `LC_*` and the mock wiring — no auth (the mock needs none), no identity, nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| a confined run (bubblewrap)                                                                                                 | the sandbox's own                                                                                                                | a cleared env with the variables `src/sandbox.ts` sets back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

In every eval-tier row `CLAUDE_CODE_EFFORT_LEVEL` is set to the declared `effort`, or removed when none is declared. The identity list is a list of names: a variable the harness adds to mark its session in a later version passes through the rows that inherit your environment until the adapter lists it. The ephemeral row does not have that gap — it is an allowlist. A run with `stubs` also gets the stub bin dir first on `PATH`, in either row; the stubs live in a temp dir beside the working dir, not in it.

## The one rule: safe by default, never silently unconfined

**`decideSandbox` ([`src/sandbox.ts`](../src/sandbox.ts)) is the whole policy, and it is fail-closed:**

- ✅ **Untrusted** code — anything with a `plugin`/`pluginDir`, or `runHook` with `trusted: false` — is **confined, or the run refuses**. If no sandbox is available (non-Linux, hardened userns), `decideSandbox` _throws_; it never falls back to running foreign code in the open.
- ✅ **Trusted** code — inline `settings`/`files` you authored — runs direct, because committing it was already a trust decision (the same one you make taking on a dependency).
- ⚠️ `sandbox: false` is the **only** way foreign code runs unconfined. It is an explicit opt-out (e.g. you're already inside a disposable CI container — see the tier table in [`sandboxing.md`](sandboxing.md)).
- ℹ️ `sandbox: "strict"` forces confinement even on trusted code, when you want belt-and-suspenders.

> **Why not just confine _everything_?** Because it would break more than it
> protects: confinement is Linux-+-userns only (forcing it turns a hook _you wrote_
> red on every Mac and hardened runner), the sandbox is deliberately hostile (no
> env, no net, read-only — a trusted hook that needs any of those now fails for
> reasons unrelated to its logic), and it's not free (the unit tier's whole value
> is a millisecond `spawnSync`). The full four-reason argument is in
> [`sandboxing.md` § "Why confinement is opt-in"](sandboxing.md#why-confinement-is-opt-in-not-always-on).

## What confinement actually prevents (and doesn't)

**Under `bwrap`, a confined run gets a fresh user/net/pid/mount namespace, `--ro-bind / /` (read-only host), a throwaway writable work dir, and `--clearenv`.** In plain terms:

- ✅ **Destruction: strong.** `rm -rf ~`, `rm -rf /etc` → `EROFS`. The worst it can delete is its own scratch dir.
- ✅ **Env secrets: cleared.** `ANTHROPIC_API_KEY` and friends aren't visible.
- ✅ **Network: a real wall.** Deny-all by default; the scripted mock is co-launched _inside_ the namespace so it stays reachable while egress is blocked. `recordEgress` records what proxy-honoring tools _try_ to reach (while still blocking); `egress: { allow }` lets traffic out to an allowlist and drops the rest **at the packet layer** (`nft`, so even a raw socket off-list is dropped).

**Honest gaps** (also flagged in `sandboxing.md`):

- ❌ **Reading the host FS is _not_ isolated** — the read-only `/` mount means a hook can `cat ~/.ssh/id_rsa`. What saves you is egress being blocked: it can read but can't send. (A future `strictFs` minimal-rootfs mode closes this, at a compatibility cost.)
- ⚠️ **DNS rotation** in the `egress` allowlist (IPs resolved at launch) — the resolver-pinned layer is the next step.
- ℹ️ **Not a kernel sandbox.** This defends against careless/malicious _plugin_ code, not a kernel or unprivileged-userns exploit — `bwrap` leans on the same userns primitive Docker-rootless does. Out of scope.

## Preventing a model's side effects — `interceptTools` / `notTool`

**At the eval tier, the model — not you — chooses what to do.** To test "the agent **didn't** push to `main` / call a paid API / spawn a paid subagent" safely, vigiles intercepts the tool before it runs:

```ts
import { defineEval, notTool } from "vigiles";

export default defineEval({
  measure: {
    ...spec,
    trials: 5,
    // Intercept the dangerous tool: the model can DECIDE to call it; it never runs.
    interceptTools: [
      {
        tool: "Bash",
        when: { command: /git push/ },
        denyReason: "blocked in test",
      },
    ],
    checks: [notTool("Bash", { command: /git push/ })], // assert it never (successfully) pushed
  },
});
```

**This is intercept-and-_prevent_, not a faithful mock.** A `PreToolUse` hook denies the matched call (exit 2). The `tool_use` — with its arguments — still lands in the `Trace`, so `notTool`/`toolWith` can assert on the **attempt**. The model is told the call was _blocked_, not that it _succeeded_.

- ✅ **Sound for:** "did the agent _attempt_ X?" — safety gates, approval checks, "no paid call", "no push to the wrong branch". `notTool` is the **negative safety assertion** a completion-grading eval structurally can't make: it sees the agent's _decision to act_, not just its final text.
- ⚠️ **Not for:** stubbing a tool to return a fake success and letting a multi-step flow continue. The model sees a block, so a sequence that needs the real result breaks. (Claude Code has no "skip-but-return-success" primitive for arbitrary tools; deny is the closest safe thing.)

**Testing that an enforcement gate actually holds** — including under an adversarial prompt that asks the agent to skip it — is done with `notTool` + `output` checks in `measure`. The worked dogfood is [`examples/harness/dogfood/adversarial-gate.eval.mjs`](../examples/harness/dogfood/adversarial-gate.eval.mjs). When that eval shows a prose gate can be talked out of, the deterministic `PreToolUse` hook is the fix.

## At a glance — what's confined, per tier

| Tier             | Foreign code       | Model's tool calls    | Default                                          |
| ---------------- | ------------------ | --------------------- | ------------------------------------------------ |
| `runHook`        | confine-or-refuse¹ | — (no model)          | trusted → direct; `trusted:false` → confined     |
| `runHarnessTest` | confine-or-refuse¹ | — (scripted mock)     | inline → direct; `plugin`/`pluginDir` → confined |
| `runEval`        | confine-or-refuse¹ | `interceptTools` deny | plugin confined; interception is opt-in          |

¹ via `decideSandbox` — `sandbox: false` is the explicit unconfined opt-out;
`sandbox: "strict"` forces it on trusted code too.

## FAQ

**Is it safe to run an eval (or harness test) repeatedly?**
Yes for your working tree: every run gets a fresh ephemeral working dir (running is itself a side effect — see above), so a run can't see or corrupt your real tree and re-running is clean. The environment is scrubbed only where the table above says so — `runEval` with `env: { kind: "ephemeral" }` — and otherwise inherits yours minus the session identity. Network is blocked by default, and the model's irreversible tool calls are caught by `interceptTools`.

**What about side effects that reach _past_ the sandbox dir — a real DB, redis, or the network?**
Three answers, by kind:

- **Network** — blocked by default. If a hook or skill genuinely needs a host (a package registry, an API), allow exactly that host with `egress: { allow }` (a packet-layer allowlist, not a proxy); everything off-list is dropped. See [`sandboxing.md`](sandboxing.md) for `egress: { allow }`.
- **A real service the behaviour under test depends on** (a database, redis, a headless browser) — run against a **disposable container you stand up** (e.g. `docker compose`), never your real instance. vigiles **composes** with that container rather than reinventing a sandbox. Honest status: the deterministic tiers (nothing executes; or a real result **recorded once and replayed** by shadowing the binary on `PATH`) need **no** container and cover the large majority of plugin surface; the turnkey disposable-dependency provisioning is a committed next step — today you point the run at a container you provision.
- **An irreversible external** (a `git push`, a paid API, a paid subagent) — you usually don't want it to run at all in a test; `interceptTools` catches the _attempt_ and prevents it (see the section above).

**Does any of this need Docker?**
No for the deterministic tiers (nothing runs) and record-replay (a real result captured once, replayed without the real tool). Only a real service whose semantics _is_ what you're testing needs a container.

**Can I just turn confinement off?**
Yes — `sandbox: false` is the explicit, greppable opt-out for code you trust, and `sandbox: "strict"` forces confinement on even trusted code. It is never _silently_ unconfined (see "the one rule" above).

## See also

- [`sandboxing.md`](sandboxing.md) — the confinement deep dive: tiers, the
  opt-in-not-always-on argument, `recordEgress`, `egress: { allow }`, dogfood findings.
- [`harness-testing.md`](harness-testing.md) — the three tiers and where the
  boundary sits.
- [`testing-api.md`](testing-api.md) — `interceptTools`/`notTool` in the
  testing API, with the intercept-≠-mock trade-off.
- [`src/sandbox.ts`](../src/sandbox.ts) · [`src/egress.ts`](../src/egress.ts) ·
  [`src/tool-intercept.ts`](../src/tool-intercept.ts) — the pure, tested seams.
