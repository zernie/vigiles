import type { Rule } from "eslint";

export const noAntdImports: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid direct imports from 'antd' outside allowed paths. Use your design system barrel file instead.",
    },
    messages: {
      noAntdImport:
        "Direct import from 'antd' is not allowed. Import from your design system barrel file instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob-like path prefixes where direct antd imports are allowed (e.g. ['src/design-system/']).",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] as { allowedPaths?: string[] } | undefined;
    const allowedPaths = options?.allowedPaths ?? [];
    const filename = context.filename;

    function isAllowed(): boolean {
      return allowedPaths.some((p) => filename.includes(p));
    }

    function checkSource(node: Rule.Node & { source?: { type: string; value: unknown } | null }) {
      if (
        node.source &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string" &&
        (node.source.value === "antd" || node.source.value.startsWith("antd/"))
      ) {
        if (!isAllowed()) {
          context.report({ node, messageId: "noAntdImport" });
        }
      }
    }

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
    };
  },
};
