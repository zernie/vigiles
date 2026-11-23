/**
 * A zod step from a string to its JSON value, so a file read off disk goes
 * through ONE `safeParse` — `jsonText.pipe(schema)` — and "not JSON" is a parse
 * failure like any other, not a thrown exception at each call site.
 */
import { z } from "zod";

export const jsonText = z.string().transform((s, ctx): unknown => {
  try {
    const value: unknown = JSON.parse(s);
    return value;
  } catch {
    ctx.addIssue({ code: "custom", message: "not JSON" });
    return z.NEVER;
  }
});
