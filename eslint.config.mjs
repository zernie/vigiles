import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: ["dist/", "node_modules/"],
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs["strict-type-checked"]?.rules,
      // TypeScript handles these better than ESLint
      "no-undef": "off",
      "no-unused-vars": "off",
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // We use createRequire legitimately for linter detection
      "@typescript-eslint/no-require-imports": "off",
      // Relax some strict rules that are too noisy for this codebase
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Ban non-null assertions — use proper narrowing instead
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  // Test files: relax promise and type assertion rules
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // node:test describe/it return promises that don't need to be awaited
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
];
