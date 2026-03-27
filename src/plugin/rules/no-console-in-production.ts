import type { ESLint, Rule } from "eslint";

export const noConsoleInProduction: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid console.log/warn/error in production code. Use a structured logger instead.",
    },
    messages: {
      noConsole:
        "Unexpected console.{{ method }}(). Use a structured logger (e.g. logger.{{ method }}) instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedMethods: {
            type: "array",
            items: { type: "string" },
            description: "Console methods that are allowed (e.g. ['debug'] for development-only logging).",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] as { allowedMethods?: string[] } | undefined;
    const allowedMethods = new Set(options?.allowedMethods ?? []);

    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "console" &&
          node.property.type === "Identifier" &&
          !allowedMethods.has(node.property.name)
        ) {
          context.report({
            node,
            messageId: "noConsole",
            data: { method: node.property.name },
          });
        }
      },
    };
  },
};
