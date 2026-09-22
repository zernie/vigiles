// P4 — a LIST-FREE selector census: `adapter.name ===/!== <literal>` and
// `harness ===/!== <literal>` over the whole tree, non-test. Measures the
// false-positive surface a widened ratchet would open.
import tsParser from "/home/user/vigiles/node_modules/@typescript-eslint/parser/dist/index.js";
export default [{
  files: ["src/**/*.ts"],
  ignores: ["src/**/*.test.ts"],
  languageOptions: { parser: tsParser },
  rules: { "no-restricted-syntax": ["error",
    { selector: 'BinaryExpression[operator=/^[!=]==$/][left.type="MemberExpression"][left.object.name="adapter"][left.property.name="name"][right.type="Literal"]', message: "ADAPTER_NAME_LITERAL" },
    { selector: 'BinaryExpression[operator=/^[!=]==$/][left.type="Identifier"][left.name="harness"][right.type="Literal"]', message: "HARNESS_VAR_LITERAL" },
    { selector: 'BinaryExpression[operator=/^[!=]==$/][left.type="MemberExpression"][left.property.name="name"][right.type="Literal"]', message: "ANY_NAME_LITERAL" },
  ]},
}];
