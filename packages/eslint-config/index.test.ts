import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import tsparser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { layers } from "./index.mjs";

/**
 * A repo with three layers in a temp directory, so ESLint's cwd is the fixture
 * while `process.cwd()` stays the vigiles checkout: the situation #303 is about.
 */
const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "layers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const LAYOUT = {
  domain: "src/core",
  adapters: "src/adapters/*",
  cliRoot: "src/cli.ts",
  app: "src/*.ts",
  tests: "src/**/*.test.ts",
  io: "src/adapters/*/*.io.ts",
};

const ruleIds = async (
  root: string,
  file: string,
  withRoot: boolean,
): Promise<string[]> => {
  const block = layers({ files: ["src/**/*.ts"], root, ...LAYOUT });
  const settings = { ...block.settings };
  if (!withRoot) delete settings["boundaries/root-path"];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ["src/**/*.ts"], languageOptions: { parser: tsparser } },
      { ...block, settings },
    ],
  });
  const [result] = await eslint.lintFiles([join(root, file)]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? "fatal");
};

const DOMAIN_IMPORTS_ADAPTER = {
  "src/core/plan.ts":
    'import { layout } from "../adapters/acme/index";\nexport const plan = layout;\n',
  "src/adapters/acme/index.ts": 'export const layout = "acme";\n',
  "src/cli.ts": 'export { plan } from "./core/plan";\n',
};

describe("layers()", () => {
  it("refuses the domain importing an adapter, with ESLint run from another directory", async () => {
    const root = fixture(DOMAIN_IMPORTS_ADAPTER);
    expect(await ruleIds(root, "src/core/plan.ts", true)).toContain(
      "boundaries/dependencies",
    );
  });

  it("control: without root-path the same import passes, which is why layers() pins it", async () => {
    const root = fixture(DOMAIN_IMPORTS_ADAPTER);
    expect(await ruleIds(root, "src/core/plan.ts", false)).not.toContain(
      "boundaries/dependencies",
    );
  });

  it("refuses a file that belongs to no layer, so a new folder cannot sit outside the rules", async () => {
    const root = fixture({
      ...DOMAIN_IMPORTS_ADAPTER,
      "src/lib/helper.ts": "export const helper = 1;\n",
    });
    expect(await ruleIds(root, "src/lib/helper.ts", true)).toContain(
      "boundaries/no-unknown-files",
    );
  });
});
