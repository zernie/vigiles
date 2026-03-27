import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { noConsoleInProduction } from "../../src/plugin/rules/no-console-in-production.js";

const ruleTester = new RuleTester();

describe("no-console-in-production", () => {
  it("should pass rule tester", () => {
    ruleTester.run("no-console-in-production", noConsoleInProduction, {
      valid: [
        // Using a logger is fine
        { code: "logger.log('hello')" },
        { code: "logger.error('something went wrong')" },
        // Allowed methods
        {
          code: "console.debug('dev only')",
          options: [{ allowedMethods: ["debug"] }],
        },
        // Non-console member expressions
        { code: "window.alert('hi')" },
      ],
      invalid: [
        {
          code: "console.log('hello')",
          errors: [{ messageId: "noConsole" }],
        },
        {
          code: "console.warn('warning')",
          errors: [{ messageId: "noConsole" }],
        },
        {
          code: "console.error('error')",
          errors: [{ messageId: "noConsole" }],
        },
        {
          code: "console.info('info')",
          errors: [{ messageId: "noConsole" }],
        },
      ],
    });
  });
});
