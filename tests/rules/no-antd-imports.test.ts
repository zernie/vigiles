import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { noAntdImports } from "../../src/plugin/rules/no-antd-imports.js";

const ruleTester = new RuleTester();

describe("no-antd-imports", () => {
  it("should pass rule tester", () => {
    ruleTester.run("no-antd-imports", noAntdImports, {
      valid: [
        // Non-antd imports are fine
        { code: "import { Button } from '@myapp/design-system'" },
        { code: "import React from 'react'" },
        // Allowed paths
        {
          code: "import { Button } from 'antd'",
          options: [{ allowedPaths: ["src/design-system/"] }],
          filename: "src/design-system/index.ts",
        },
        // Subpath in allowed path
        {
          code: "import { Button } from 'antd/es/button'",
          options: [{ allowedPaths: ["src/design-system/"] }],
          filename: "src/design-system/button.ts",
        },
      ],
      invalid: [
        {
          code: "import { Button } from 'antd'",
          errors: [{ messageId: "noAntdImport" }],
        },
        {
          code: "import { DatePicker } from 'antd/es/date-picker'",
          errors: [{ messageId: "noAntdImport" }],
        },
        {
          code: "export { Button } from 'antd'",
          errors: [{ messageId: "noAntdImport" }],
        },
        // Not in allowed path
        {
          code: "import { Button } from 'antd'",
          options: [{ allowedPaths: ["src/design-system/"] }],
          filename: "src/components/MyComponent.tsx",
          errors: [{ messageId: "noAntdImport" }],
        },
      ],
    });
  });
});
