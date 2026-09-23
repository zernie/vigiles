/**
 * `local/frame-mint` — a branded path is MINTED in one file and nowhere else.
 *
 * One sentence: outside `src/core/frame.ts`, no expression may be asserted to a
 * path-frame brand (`x as RepoPath`, `<RepoPath>x`); get one from `Frame.repo`
 * or `Bundle.path` / `Bundle.scanned` instead.
 *
 * WHY (#281). `RepoPath` exists so that "relative to which directory" has ONE
 * owner. The type makes a bundle-relative or absolute string fail to compile
 * where a `RepoPath` is wanted — and a type assertion makes it compile again,
 * silently, with the wrong frame inside. The brand is only as strong as the
 * number of places allowed to forge it, so that number is one, and it is
 * checked rather than hoped for.
 *
 * WHAT IT SEES: `TSAsExpression` and `TSTypeAssertion` whose target type is a
 * plain reference to one of the configured names. It does not chase aliases
 * (`type P = RepoPath; x as P`) or a double assertion through `unknown`; both
 * are deliberate acts that a reviewer can see, while the single `as RepoPath`
 * is the one that reads as a harmless annotation.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid asserting a value to a path-frame brand outside the module that owns the frames.",
    },
    schema: [
      {
        type: "object",
        properties: {
          types: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["types"],
        additionalProperties: false,
      },
    ],
    messages: {
      forged:
        "Do not assert a value to `{{name}}` here — a cast keeps the old frame inside the new type. " +
        "Convert through src/core/frame.ts: `frame.repo(absolutePath)`, `bundle.path(bundlePath)` " +
        "or `bundle.scanned(pathFromScanCore)` (#281).",
    },
  },
  create(context) {
    const names = new Set(context.options[0]?.types ?? []);
    const check = (node) => {
      const t = node.typeAnnotation;
      if (
        t?.type === "TSTypeReference" &&
        t.typeName.type === "Identifier" &&
        names.has(t.typeName.name)
      )
        context.report({
          node,
          messageId: "forged",
          data: { name: t.typeName.name },
        });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
