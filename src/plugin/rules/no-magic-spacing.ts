import type { Rule } from "eslint";

// Tailwind spacing scale values (default config)
const SPACING_SCALE: Record<number, string> = {
  0: "0",
  1: "0.25rem / 1px",
  2: "0.5rem / 2px",
  4: "1rem / 4px",
  8: "2rem / 8px",
  12: "3rem / 12px",
  16: "4rem / 16px",
  20: "5rem / 20px",
  24: "6rem / 24px",
  32: "8rem / 32px",
  40: "10rem / 40px",
  48: "12rem / 48px",
  64: "16rem / 64px",
  80: "20rem / 80px",
  96: "24rem / 96px",
};

// Matches Tailwind arbitrary spacing like p-[24px], m-[16px], gap-[32px], etc.
const ARBITRARY_SPACING_RE =
  /(?:^|\s)(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|min-h|max-w|max-h|inset|top|right|bottom|left)-\[(\d+)px\]/g;

export const noMagicSpacing: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Forbid Tailwind arbitrary spacing values like p-[24px] when a spacing scale value exists.",
    },
    messages: {
      noMagicSpacing:
        "Arbitrary spacing value '{{ value }}' has a Tailwind scale equivalent. Use the scale value instead ({{ px }}px = spacing {{ suggestion }}).",
    },
    schema: [],
  },
  create(context) {
    function checkString(node: Rule.Node, value: string) {
      let match: RegExpExecArray | null;
      ARBITRARY_SPACING_RE.lastIndex = 0;

      while ((match = ARBITRARY_SPACING_RE.exec(value)) !== null) {
        const px = parseInt(match[1], 10);
        if (px in SPACING_SCALE) {
          context.report({
            node,
            messageId: "noMagicSpacing",
            data: {
              value: match[0].trim(),
              px: String(px),
              suggestion: SPACING_SCALE[px],
            },
          });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          checkString(node, node.value);
        }
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          checkString(node, quasi.value.raw);
        }
      },
      JSXAttribute(node: Rule.Node & { value?: { type: string; value?: string } | null }) {
        if (node.value && node.value.type === "Literal" && typeof node.value.value === "string") {
          checkString(node, node.value.value);
        }
      },
    };
  },
};
