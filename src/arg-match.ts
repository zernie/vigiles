/**
 * `ArgMatcher` — a small, serializable matcher over a tool call's `input`.
 *
 * Shared by the check vocabulary (`toolWith` / `notTool` in `src/check.ts`) and
 * the tool-interception seam (`src/tool-intercept.ts`), so "did the agent call
 * this tool with these arguments?" means the same thing whether you're *asserting*
 * on a captured call or *intercepting* one before it runs. Pure + model-free.
 */

/**
 * A declarative matcher over a tool call's `input`, keyed by **dot-path** (e.g.
 * `"body.prompt"`). Each value is matched against the value at that path: a
 * `RegExp` is a pattern over the stringified value (use this for "contains"), and
 * a `string`/`number`/`boolean` is an **exact** match (use this for "equals", e.g.
 * a push target). All keys must match (AND). Serializable, so anything carrying
 * one still round-trips through `toJSON`.
 *
 * @public
 */
export type ArgMatcher = Record<string, string | number | boolean | RegExp>;

/** Render any tool-input value as a string for matching / messages. */
export function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v) ?? "[object]";
    } catch {
      return "[object]";
    }
  }
  return String(v as number | boolean | null | undefined);
}

/** Resolve a dot-path (`"a.b.c"`) within an arbitrary value, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Does `input` satisfy every entry of `matcher`? (RegExp = pattern, else exact.) */
export function matchesArgs(input: unknown, matcher: ArgMatcher): boolean {
  return Object.entries(matcher).every(([key, m]) => {
    const value = getPath(input, key);
    return m instanceof RegExp ? m.test(stringifyValue(value)) : value === m;
  });
}

/** A human-readable form of a matcher for failure messages. */
export function describeArgs(matcher: ArgMatcher): string {
  return Object.entries(matcher)
    .map(
      ([k, m]) => `${k}=${m instanceof RegExp ? String(m) : JSON.stringify(m)}`,
    )
    .join(", ");
}

/** Serialize a matcher for `toJSON` (RegExp → its string form). */
export function serializeArgs(
  matcher: ArgMatcher,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, m] of Object.entries(matcher)) {
    out[k] = m instanceof RegExp ? String(m) : m;
  }
  return out;
}
