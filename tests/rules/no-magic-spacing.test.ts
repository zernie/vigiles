import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { noMagicSpacing } from "../../src/plugin/rules/no-magic-spacing.js";

const ruleTester = new RuleTester();

describe("no-magic-spacing", () => {
  it("should pass rule tester", () => {
    ruleTester.run("no-magic-spacing", noMagicSpacing, {
      valid: [
        // Standard Tailwind classes (no arbitrary values)
        { code: "const cls = 'p-4 m-8 gap-2'" },
        // Arbitrary values not on the spacing scale
        { code: "const cls = 'p-[13px]'" },
        { code: "const cls = 'p-[7px]'" },
        // Non-spacing arbitrary values
        { code: "const cls = 'text-[14px]'" },
        { code: "const cls = 'bg-[#ff0000]'" },
      ],
      invalid: [
        {
          code: "const cls = 'p-[24px]'",
          errors: [{ messageId: "noMagicSpacing" }],
        },
        {
          code: "const cls = 'm-[16px]'",
          errors: [{ messageId: "noMagicSpacing" }],
        },
        {
          code: "const cls = 'gap-[32px]'",
          errors: [{ messageId: "noMagicSpacing" }],
        },
        {
          code: "const cls = 'p-[24px] m-[16px]'",
          errors: [
            { messageId: "noMagicSpacing" },
            { messageId: "noMagicSpacing" },
          ],
        },
      ],
    });
  });
});
