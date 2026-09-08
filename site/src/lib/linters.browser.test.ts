/**
 * The front page describes the engine's linter set in two ways — a list of
 * linter NAMES (the Wedge strip) and a list of LANGUAGES (the hero's "is this
 * for me?" chip). Both are derived, and this is what keeps the derivation
 * honest: adding a linter to the engine without deciding its language would
 * otherwise leave the hero silently describing the old set, which is the exact
 * failure a derived list exists to prevent.
 *
 * The language check runs in BOTH directions on purpose. Map-has-every-linter
 * catches the new linter nobody classified; order-lists-every-language catches
 * a language that is genuinely covered but missing from the fixed display order
 * — a one-way check would pass while the chip quietly dropped Ruby.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_LINTERS } from "@engine/spec";
import {
  LANGUAGE_OF,
  LANGUAGES,
  LANGUAGE_ORDER,
  LINTER_NAMES,
} from "@/lib/linters";

describe("the linter strip and the language chip are derived, not typed", () => {
  it("every shipped linter has a language decision (a value or an explicit null)", () => {
    const undecided = BUILTIN_LINTERS.filter(
      (l) => !Object.prototype.hasOwnProperty.call(LANGUAGE_OF, l),
    );
    expect(undecided).toEqual([]);
  });

  it("every language a shipped linter covers appears in the display order", () => {
    const covered = new Set(
      BUILTIN_LINTERS.map((l) => LANGUAGE_OF[l]).filter(
        (v): v is string => typeof v === "string",
      ),
    );
    const missing = [...covered].filter((v) => !LANGUAGE_ORDER.includes(v));
    expect(missing).toEqual([]);
  });

  it("names one linter per shipped linter, and no language twice", () => {
    expect(LINTER_NAMES).toHaveLength(BUILTIN_LINTERS.length);
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
  });

  it("the two linters whose subject is not a project language are excluded", () => {
    // Stylelint (CSS) and Cedar (authorization policies) answer "which
    // linters", never "which language do I write in" — asserted so the null is
    // read as the decision it is, not mistaken for an unfilled row.
    expect(LANGUAGE_OF.stylelint).toBeNull();
    expect(LANGUAGE_OF.cedar).toBeNull();
    expect(LANGUAGES).not.toContain("CSS");
  });
});
