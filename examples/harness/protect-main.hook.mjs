/**
 * A compiled hook, exactly as you'd author it — a pure `(event) => Decision`
 * against the closed `vigiles/hook` vocabulary. It is the SUBJECT of
 * `compiled-hook-inprocess.harness.mjs`, which loads this file by PATH and
 * asserts over its decisions in-process (no subprocess, no model).
 *
 * External users import from the package (`from "vigiles/hook"`); in-repo
 * examples point at the built dist so they run straight from a clone.
 */
import { experimental_defineHook, deny, allow } from "../../dist/hook.js";

export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true })
      ? deny("no force-push to a protected branch")
      : allow(),
});
