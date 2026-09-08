/**
 * A COMPILED HOOK — a Bash safety gate authored as a pure typed function.
 *
 * This is the artifact behind the OSS dogfood (src/hook-dogfood.test.ts): it
 * expresses the SAME intent a widely-copied hand-written safety hook claims —
 * block destructive git, forced `rm`, verification bypass, secret reads, and
 * `curl | sh` — but as a pure function against the closed `vigiles/hook`
 * vocabulary. The matching is AST-backed, so it catches the cases a `grep`/glob
 * guard misses (a force-push hidden in `cd x && … && git push -f`).
 *
 * What you do NOT write here — and therefore cannot get wrong — is the protocol:
 * no `exit 2` vs `exit 1`, no `permissionDecision` JSON field, no `jq` path.
 * `vigiles compile` emits it (merged into your hooks config); the
 * `vigiles hook-runtime run-program` entrypoint runs it. The whole
 * FALSE-CONFIDENCE bug class (a guard that looks like it blocks but silently
 * doesn't) is unrepresentable.
 *
 * External users put the source in `.vigiles/hooks/` and compile it:
 *
 *   import { experimental_defineHook, deny, allow } from "vigiles/hook";
 *   npx vigiles compile   # discovers .vigiles/hooks/*, merges the block + a stamp
 *
 * `vigiles/hook` is the ONLY import a compiled hook may use (capability = API
 * surface). This in-repo copy imports the built `dist/` instead so it runs
 * without installing the package; the dogfood (src/hook-dogfood.test.ts) drives
 * it through `vigiles hook-runtime run-program`.
 */
import { experimental_defineHook, deny, allow } from "../../dist/hook.js";

export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => {
    const c = e.command;
    if (c.runs("git push", { force: true }))
      return deny("force-push to a protected branch is blocked");
    if (c.runs("git reset --hard"))
      return deny("`git reset --hard` discards committed work");
    if (c.runs("git commit --no-verify"))
      return deny("`--no-verify` skips your pre-commit gates");
    if (c.runs("rm", { force: true }))
      return deny(
        "a forced `rm` is blocked — delete deliberately, not with -rf",
      );
    if (c.touches(["~/.ssh", ".env", "id_rsa", "id_ed25519"]))
      return deny("reading a private key / secret file is blocked");
    if (c.pipesToShell())
      return deny("`curl | sh` (remote code execution) is blocked");
    return allow();
  },
});
