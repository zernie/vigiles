/**
 * `SettingsCodec` — the BYTES-TO-VALUE half of a harness's settings file, and
 * the two encodings vigiles ships.
 *
 * 🔴 IT REPLACES A TWO-VALUED ENUM IN THE CORE. `PluginLayout.settingsFormat`
 * was `"json" | "toml"`, and nine call sites branched on it: six about the
 * ENCODING (parse a manifest, parse a settings file, serialize a merged
 * config) and three about the hooks-entry SHAPE, which is a different question
 * entirely and now lives on `HookProtocol`. Every one of those branches was a
 * per-value `if`, so a third-party adapter whose settings are YAML could
 * declare nothing the core would honour: the type had exactly two inhabitants
 * and they were both ours.
 *
 * A codec closes that by construction — there is no enum left to be outside
 * of. The grep that checks it is in the design: `'"json" | "toml"'` over
 * `src/` must return only the adapter files that NAME their encoding, never a
 * core module branching on one.
 *
 * ⚠️ WHAT A CODEC IS NOT: it does not know what the value MEANS. Whether a
 * hooks entry nests `{matcher, hooks: [{type, command}]}` or is flat
 * `{matcher, command}` is the harness's SHAPE, and it is `HookProtocol`'s —
 * see `registration` there. Reading and writing an encoding, and reading and
 * writing a shape, were the two halves `settingsFormat` was standing in for.
 */
/**
 * 🔴 `@iarna/toml` IS REQUIRED LAZILY, AND THAT IS A MEASUREMENT, NOT A STYLE.
 * The same wrapper exists in `hook-install.ts` and `core/hook-program.ts` with
 * the reason recorded: a top-level import puts the TOML parser into the graph
 * of every hook decision, because the hook runtime reaches those modules —
 * measured 2026-09-08 at 56 ms per spawn. A codec that every `PluginLayout`
 * now carries is reached from strictly MORE places than either of them, so a
 * top-level import here would undo that fix and widen it. `tsc` lowers these
 * to CommonJS, so the `require` genuinely does not run until a codec method is
 * called, and a layout that is only READ (the common case) costs nothing.
 */
const toml = (): typeof import("@iarna/toml") =>
  require("@iarna/toml") as typeof import("@iarna/toml");

export interface SettingsCodec {
  /**
   * For messages and the generated JSON Schema only. The core never branches
   * on it — that is the whole reason this is a codec and not an enum, so a
   * branch on this field would put the defect straight back.
   */
  readonly label: string;
  /** Throws on malformed text; every caller today already catches. */
  parse(text: string): Record<string, unknown>;
  /** The inverse, with the trailing newline the harness's own tooling writes. */
  render(value: Record<string, unknown>): string;
}

/** JSON settings (`.claude/settings.json`, `opencode.json`). */
export const jsonSettingsCodec: SettingsCodec = {
  label: "json",
  parse: (text) => JSON.parse(text) as Record<string, unknown>,
  render: (value) => JSON.stringify(value, null, 2) + "\n",
};

/** TOML settings (Codex's `.codex/config.toml`). */
export const tomlSettingsCodec: SettingsCodec = {
  label: "toml",
  parse: (text) => toml().parse(text) as Record<string, unknown>,
  // `trimEnd` before the newline: `stringifyToml` already ends with one, and
  // two would be a diff on every write against a file the harness itself wrote.
  render: (value) =>
    toml()
      .stringify(value as never)
      .trimEnd() + "\n",
};
