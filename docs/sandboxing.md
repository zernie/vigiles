# Sandboxing — what's isolated, what's recorded (honestly)

Testing a hook or a third-party plugin means **executing its code with your privileges**. vigiles confines that under [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Being precise about what confinement does and doesn't protect is important — so you don't trust a boundary that isn't there.

## Tiers (graceful degradation, no Docker)

**The sandbox protects the host from untrusted code.** The right question is: "is the host already disposable?" The answer differs by environment.

| Tier                    | Mechanism                                                                    | When                                                                           |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A — bubblewrap**      | a fresh user/net/pid/mount namespace: no egress, read-only host, cleared env | a dev machine where unprivileged user namespaces work                          |
| **B — outer container** | `sandbox: false`, trusting an already-ephemeral host                         | CI / cloud agents (the runner is thrown away — the inner sandbox is redundant) |
| **D — refuse**          | run nothing                                                                  | untrusted code, no confinement available, host not disposable                  |

bwrap is the only tier that actually confines. Docker/podman-rootless rely on the **same** unprivileged-user-namespace primitive, so they are not a way around its absence. The honest non-Docker alternative for hosts where user namespaces are hard-disabled is [Landlock](https://docs.kernel.org/userspace-api/landlock.html) (unprivileged FS, and network from kernel 6.7) — a future tier, not shipped.

**The eval container is not one of these tiers.** `runEval`'s `env: { kind: "docker" }` runs each attempt in Docker so that every process it started ends before scoring. It is not a confinement tier: its network stays open (the harness needs the model API) and the trial's own directories are mounted writable, so it guards the score, not your machine: [Ending every process an attempt started](measuring-skills.md#ending-every-process-an-attempt-started--docker).

> **macOS is coming via a native backend, not a VM.** bwrap is Linux-only by
> design (it _is_ Linux namespaces), so Mac confinement comes from a second backend
> — `sandbox-exec` (Seatbelt), built into every Mac — behind a `vigiles/os-isolation`
> port, with the safe-by-default rule unchanged.

> **`sandboxAvailable()` probes real capability, not just the binary.** `bwrap
--version` succeeding doesn't mean this host can create namespaces (many CI
> runners disable unprivileged user namespaces). We probe an actual `bwrap
--unshare-all … true`, so we never claim confinement we can't deliver. On
> Ubuntu 24.04 runners, unblock it with `sysctl -w
kernel.apparmor_restrict_unprivileged_userns=0` (see `.github/workflows/ci.yml`).

## Why confinement is opt-in, not always-on

**Untrusted code is confined; code you authored runs direct.** Forcing the sandbox on everything sounds safer — but it breaks more than it protects. Four concrete reasons, each load-bearing:

1. **It isn't always available.** Confinement requires Linux plus working unprivileged user namespaces. `sandboxAvailable()` probes the real capability — many CI runners ship `bwrap` but disable userns. Force it everywhere and a hook _you wrote_ turns red on every Mac and every hardened runner. `decideSandbox` returns `throw`, not a run. The unit tier is meant to run **anywhere**.
2. **The sandbox is deliberately hostile.** No egress, `--clearenv` (every host var dropped), a fresh empty `$HOME`, a read-only `/`. Exactly right for foreign code. But a hook you wrote that legitimately needs an env var, the network, or writes outside its work dir now fails for reasons unrelated to its logic — and you have to claw each var back via `setenvArgs`.
3. **Trust follows provenance.** Inline code you authored is trusted. Foreign `plugin`/`pluginDir` is not. Committing it to your repo is the same trust decision as taking on a dependency. You already made the call when you vendored it. The sandbox earns its keep on the code you _haven't_ linted.
4. **Cost.** A direct `spawnSync` is milliseconds — the whole point of the unit tier. The confined path stands up an IO dir, a fresh HOME, before/after tree snapshots, and a `bwrap` spawn. Paid on every _trusted_ hook, that defeats the cheap base of the pyramid.

`sandbox: "strict"` forces confinement even for trusted code when you _do_ want it (belt-and-suspenders on inline code). It's just not the default, because as a default it mostly punishes the code you trust on the platforms where it can't run.

## Filesystem (IO) — how good is it against `rm -rf`?

**Against destruction: strong.** Under bwrap the host root is mounted `--ro-bind / /` (read-only) and only a throwaway work dir is writable. So `rm -rf /`, `rm -rf ~`, `rm -rf /etc` all fail with `EROFS`. The worst a hook can delete is its own disposable scratch dir.

**Be honest about two gaps:**

1. ❌ **Reading is NOT isolated.** The whole host `/` is mounted read-only, so a hook can `cat /home/you/.ssh/id_rsa` or `cat /home/you/.aws/credentials`. Environment secrets are cleared (`--clearenv`, so `ANTHROPIC_API_KEY` isn't visible), but **secrets on disk are readable**. What saves you is that egress is blocked — it can read but can't send. (A future `strictFs` mode would bind a minimal rootfs instead of all of `/`, at the cost of compatibility.)
2. ⚠️ **Only Tier A.** With `sandbox: false` / trusted-inline, the hook runs with **full host access** — `rm -rf ~` really deletes your home. That's by design (it's code you wrote), but it means the protection above applies only to _confined_ runs.

**Record what it wrote.** A confined `runHook` / `runScript` also reports the files it touched in its work dir (`r.filesWritten`, relative paths) — so you can assert it stayed in its lane:

```ts
import { check, assertChecks } from "vigiles";

const r = runHook(thirdPartyHookCmd, event, { trusted: false });
// r.filesWritten → [".omc/state/ultrawork-state.json"]
assertChecks(r, [
  check.writes({
    only: [/^\.omc\//], // only its own state cache
    none: [/\.(env|pem|key)$/], // never a secret-shaped file
  }),
]);
```

🔴 **Recording requires confinement, and an unrecorded run refuses.** The write list comes from diffing the work dir before and after, which only happens under confinement. An **unconfined** run therefore leaves `filesWritten` as **`undefined`** — which is deliberately _not_ `[]`:

| Value       | Means                                      |
| ----------- | ------------------------------------------ |
| `undefined` | nobody looked — writes were never recorded |
| `[]`        | looked, and it wrote nothing               |

`check.writes` **fails** on `undefined` rather than pass, and the message tells you to pass `{ sandbox: "auto" }`. Collapsing the two would let a write assertion report success having inspected no evidence — a checker that passes while doing nothing is precisely what vigiles exists to catch elsewhere, so it must not be the default here.

Dogfood: `src/run-hook.test.ts` confines oh-my-claudecode's `keyword-detector` and asserts it writes **only** under `.omc/` — its keyword-state cache, nothing else.

## Network — block, and (optionally) record

**Default: deny-all, and it's a real wall.** Under bwrap the net namespace has loopback only and no external route. Nothing a hook does reaches the network. The scripted mock is co-launched _inside_ the namespace, so it stays reachable while real egress is blocked.

**`recordEgress` — record what it tried to reach, while still blocking it.** A deny-all wall tells you nothing about _what_ a hook wanted. For the supply-chain question — "what does this skill phone home to / which registry would its install hit?" — turn on recording:

```ts
import { runHook, check, assertChecks } from "vigiles";

const r = runHook(thirdPartyHookCmd, event, { recordEgress: true });
// r.egress → [{ host: "registry.npmjs.org", port: 443, ts }]   (recorded)
assertChecks(r, [check.egress({ none: true })]); // a hook that should phone home to nothing
// or: check.egress({ only: ["registry.npmjs.org", /\.pypi\.org$/] })
```

`recordEgress` confines the hook (it needs the namespace) and runs a recording proxy on the sandbox loopback. `HTTP(S)_PROXY` points proxy-honoring tools (npm, pip, curl, fetch) at it. The proxy **records each `host:port` and refuses it** — so the attempt is captured and nothing leaves.

**Honest limits of `recordEgress`:**

- ⚠️ **Proxy-honoring tools only.** Raw-socket egress bypasses the proxy. The netns still **blocks** it hard, so it can't get out. It just won't appear in the record. _The block is the boundary; the record is best-effort observability over it._
- ⚠️ **Node `fetch()` needs Node 22+.** `curl` / `npm` / `pip` honor the proxy on every Node version. Capturing Node's own **`fetch()`** needs `NODE_USE_ENV_PROXY`, which only takes effect on **Node 22+**. On older Node a `fetch()` is still blocked — just not recorded.
- ✅ **It still blocks.** So a skill that needs a _real_ `npm install` to succeed won't work in this mode — that's `egress: { allow }`, below.

## Network — allowlisted real egress (`egress: { allow }`)

**Let it actually reach the network, but only the hosts you list.** When the question is "does this skill install cleanly, and _only_ from the registries I expect?", a wall (record or not) can't answer it — the install has to succeed. `egress: { allow }` lets traffic out to an allowlist and **drops the rest at the packet layer**:

```ts
import { runHook } from "vigiles";

const r = runHook(installHookCmd, event, {
  egress: { allow: ["registry.npmjs.org"] },
});
// r.egress       → [{ host: "registry.npmjs.org", allowed: true, packets, bytes }]
// r.egressDropped → { packets: 0, bytes: 0 }   // nothing reached off the allowlist
```

How it works:
[`slirp4netns`](https://github.com/rootless-containers/slirp4netns) `--configure`
attaches a tap to the bwrap netns (rootless egress via a userspace TCP/IP stack);
an `nft` ruleset **inside** the netns is a `policy drop` output chain that accepts
only the allowlist's resolved IPs (plus loopback + DNS) and `log`+`drop`s the
rest; the per-rule `counter`s read back what was reached and what was dropped.

**Why the boundary is `nft`, not a proxy.** A `recordEgress`/`HTTP_PROXY` allowlist only constrains tools that _honor the proxy_ — a raw socket ignores the env and goes straight out. The `nft` wall is at the packet layer, so a raw `bash /dev/tcp` to an off-list host is **dropped too**. Needs Linux + bubblewrap + `slirp4netns` + `nft`; it **refuses** (rather than running unconfined) if they're absent.

**Honest limits:**

- ⚠️ **IPs resolved at launch.** The allowlist is resolved to IPs when the run starts. A host whose DNS rotates outside the run's window could hand the hook an IP that wasn't pre-resolved — and so gets dropped. The dynamic, resolver-pinned set (a DNS resolver in the netns that authorizes each answer's IPs just-in-time) is the next layer.
- ℹ️ **Dropped hosts are counted, not named.** The record names the allowlisted hosts that were reached and counts how much off-list traffic was dropped. It does not yet name the dropped hosts (that needs the in-netns DNS-query log). `r.egressDropped.packets > 0` tells you the hook tried to leave the allowlist; the DNS-log layer will say where to.

## Dogfood — a real finding about a real plugin

The egress recorder runs against the **real, vendored** `oh-my-claudecode` plugin in the gate (`src/run-hook.test.ts`, skips where bwrap can't confine):

- **`keyword-detector` (UserPromptSubmit)** → `check.egress({ none: true })` confirms it phones home to nothing, while still doing its job.
- **`session-start` (SessionStart)** → it `fetch()`es `registry.npmjs.org` for an **update check on every session start**. The recorder captures it (Node `fetch` via `NODE_USE_ENV_PROXY`), blocks it, and `check.egress({ only: ["registry.npmjs.org"] })` proves it phones the npm registry **and nowhere else**.

That second one isn't a toy curl — it's a genuine supply-chain/privacy property of a popular plugin, asserted from its actual code.

The same `session-start` hook is dogfooded a second time under `egress: { allow: ["registry.npmjs.org"] }`: this time the update-check `fetch()` **succeeds** to the registry (`r.egress` records it `allowed: true`) and `r.egressDropped.packets` stays `0` — proving, through the allowlist path, that it reaches the npm registry **and nothing else**.

## See also

- [Testing your harness](harness-testing.md) — the three tiers + the sandbox boundary.
- [Ending every process an attempt started](measuring-skills.md#ending-every-process-an-attempt-started--docker) — `runEval`'s per-attempt Docker container: what it ends, and why it is not a sandbox.
- [Testing API](testing-api.md) — `interceptTools` / `check.tool(name, { max: 0 })`:
  preventing a real model's tool side effects at the eval tier.
- [`src/sandbox.ts`](../src/sandbox.ts) — `decideSandbox` (the pure policy), `bwrapArgs`, `parseEgressLog`.
- [`src/egress.ts`](../src/egress.ts) — the `egress: { allow }` allowlist: ruleset builder, counter parser, the pure seams.
