/**
 * Emit the JSON Schema for `.vigilesrc.json`, so an editor can complete it.
 *
 * DERIVED, NOT WRITTEN. `z.toJSONSchema` reads the SAME Zod schema the CLI
 * validates with (`src/core/config-schema.ts`), so the file an editor reads and
 * the rules the tool enforces cannot disagree — which is the whole reason this
 * is a build step and not a checked-in document. A hand-maintained twin would be
 * the third copy of the config's shape, after the type and the validator, and
 * the type is only stopped from being a second copy by `z.infer`.
 *
 * `io: "input"` on purpose: the schema an editor validates is the file as a
 * HUMAN WRITES it — `"exclude": "bench"` before the string is coerced to a list,
 * `"integrity": 0` before it becomes `false`. The OUTPUT type is what the code
 * receives afterwards and would reject perfectly good configs.
 *
 * Run from `npm run build`. It writes into `dist/`, which is what ships.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { vigilesConfigSchema } = await import(
  resolve(root, "dist/core/config-schema.js")
);

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://unpkg.com/vigiles/dist/vigilesrc.schema.json",
  title: "vigiles configuration (.vigilesrc.json)",
  ...z.toJSONSchema(vigilesConfigSchema, { io: "input" }),
};

const out = resolve(root, "dist/vigilesrc.schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(
  `[build-config-schema] → dist/vigilesrc.schema.json (${String(Object.keys(schema.properties ?? {}).length)} keys)`,
);
