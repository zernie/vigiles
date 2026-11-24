/**
 * A compiled REACT hook — it fires after the tool ran, so it can't block; it
 * emits a `notice(…)` instead. The subject of the react half of
 * `compiled-hook-inprocess.harness.mjs`.
 *
 * Why testing this in-process matters: a notice goes to **stderr**. A probe that
 * shells out and reads stdout sees nothing and concludes the hook is dead, when
 * it is working perfectly. `experimental_assertHookNotices` reads the reaction itself.
 */
import {
  experimental_defineReact,
  tools,
  notice,
  nothing,
} from "../../dist/entries/hook.js";

export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Bash"),
  react: (e) =>
    e.response.isError()
      ? notice("that command failed — read the error before retrying")
      : nothing(),
});
