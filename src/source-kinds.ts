/**
 * What a file in a vigiles-owned source directory IS — decided in ONE place.
 *
 * `.vigiles/hooks/` and `.vigiles/providers/` hold several kinds of file side by
 * side: the programs `vigiles compile` turns into wiring, the tests that exercise
 * them, type declarations, and the `.json` stamp `compile` writes next to each
 * hook. Discovery used to ask "does it end in a runnable extension?" and treat
 * every yes as a hook (#278): a `task-list-nudge.harness.mjs` beside its
 * `task-list-nudge.hook.ts` was compiled as a hook and failed the build. The
 * obvious patch — subtract the names that bit (`.harness.`, `.test.`) — is a list
 * of what a hook is NOT, and a list of that kind is open: the next helper file
 * somebody colocates is the next report.
 *
 * So a hook is defined by what it IS. A file's kind comes from ONE marker, the
 * LAST dot-separated segment before the extension (`guard.hook.mjs` → `hook`),
 * looked up in ONE table ({@link MARKERS}). Because exactly one segment decides,
 * a name has exactly one kind; because the table is closed, every consumer can
 * `switch` over {@link SourceKind} exhaustively and the compiler names the next
 * one that forgets a case. A runnable file whose marker is not in the table is
 * `unclaimed` — a kind of its own, not an absence — so a renamed-away hook is a
 * reported fact rather than a silent hole.
 *
 * The patterns test discovery uses (`vigiles test`, `vigiles eval`, the coverage
 * defaults, the browser twin) are DERIVED from the same table. They used to be
 * five hand-kept copies of one fact: `*.harness.*` and `*.eval.*` are tests.
 *
 * Pure and import-free on purpose. `hook-install.ts` imports this and is reached
 * from the hook runtime, where every module is a per-call cost, and the browser
 * twin of coverage detection needs it too — nothing here may touch `node:*`.
 */

/**
 * Every extension Node executes directly. `.mts`/`.cts` are real (TS 4.7+) and
 * Node 22 strips their types with no toolchain — measured, not assumed.
 */
export const RUNNABLE_EXTS = ["mjs", "cjs", "js", "mts", "cts", "ts"] as const;

/** Which vigiles test runner takes a file: `vigiles test` or `vigiles eval`. */
export type TestTier = "harness" | "eval";

/**
 * The closed union of what a file in a source directory can be. Exactly one per
 * name; see {@link classifySource}.
 */
export type SourceKind =
  /** A compiled-hook program: `guard.hook.mjs`. */
  | { readonly kind: "hook" }
  /** A registered context provider: `k8s.provider.mjs`. */
  | { readonly kind: "provider" }
  /** A vigiles test: `guard.harness.mjs` (`vigiles test`) or `guard.eval.mjs` (`vigiles eval`). */
  | { readonly kind: "vigiles-test"; readonly test: TestTier }
  /** A type declaration: `x.d.ts`, `x.d.mts`, `x.d.cts`. */
  | { readonly kind: "declaration" }
  /** The `.json` sidecar `compile` writes beside a source: `guard.hook.mjs.json`. */
  | { readonly kind: "stamp" }
  /** Not a runnable source at all: `README.md`, `.gitkeep`, a stray `.json`. */
  | { readonly kind: "non-source" }
  /**
   * A runnable file whose name carries no marker vigiles knows: `guard.mjs`
   * (a hook from before the marker), `util.ts`, `guard.test.ts`. Nobody's — and
   * therefore never compiled, and never silently ignored either.
   */
  | { readonly kind: "unclaimed" };

/**
 * The marker table: the LAST dot-segment before the extension → its kind.
 * Adding a kind of file means adding a row here and handling the new
 * {@link SourceKind} member in each consumer's `switch`.
 */
const MARKERS = [
  { infix: "hook", kind: { kind: "hook" } },
  { infix: "provider", kind: { kind: "provider" } },
  { infix: "harness", kind: { kind: "vigiles-test", test: "harness" } },
  { infix: "eval", kind: { kind: "vigiles-test", test: "eval" } },
] as const satisfies readonly {
  readonly infix: string;
  readonly kind: SourceKind;
}[];

/** The markers that name a file a vigiles consumer COMPILES (as opposed to runs or ignores). */
export type CompilableMarker = "hook" | "provider";

/**
 * The tiers a vigiles test can belong to, read off {@link MARKERS}. A tier is
 * also its own infix (`guard.eval.mjs` is tier `eval`): `source-kinds.test.ts`
 * asserts that for every tier, so a row that broke it fails there.
 */
const TEST_TIERS: readonly TestTier[] = MARKERS.flatMap((m) =>
  m.kind.kind === "vigiles-test" ? [m.kind.test] : [],
);

const EXT_ALT = RUNNABLE_EXTS.join("|");
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const STAMP = new RegExp(`\\.(?:${EXT_ALT})\\.json$`);
/**
 * `<stem>.<infix>.<ext>`, the infix being the LAST segment before the extension.
 * The stem may be empty (`.harness.mjs`): the runner's glob matches that, so the
 * classifier must too; {@link classifySource} decides which kinds may go without
 * one. `[\\s\\S]`, not `.`: `.` stops at a newline, and a name with one in it
 * used to fall out of every kind and be dropped without a word.
 */
const MARKED = new RegExp(`^([\\s\\S]*)\\.([^.]+)\\.(?:${EXT_ALT})$`);
const RUNNABLE = new RegExp(`^[\\s\\S]+\\.(?:${EXT_ALT})$`);

const UNCLAIMED: SourceKind = { kind: "unclaimed" };

/**
 * The kind of a file, from its BASENAME. Total: every string has an answer, and
 * the answer is one member of {@link SourceKind}.
 *
 * Order matters and is the whole algorithm: a declaration is a declaration even
 * when its infix says `hook` (`x.hook.d.ts`); a `.json` beside a source is its
 * stamp; then the last infix is looked up. Case-sensitive, like the file systems
 * these names mostly live on.
 */
export function classifySource(filename: string): SourceKind {
  if (DECLARATION.test(filename)) return { kind: "declaration" };
  if (STAMP.test(filename)) return { kind: "stamp" };
  if (!RUNNABLE.test(filename)) return { kind: "non-source" };
  const parts = MARKED.exec(filename);
  const row = MARKERS.find((m) => m.infix === parts?.[2]);
  if (row === undefined) return UNCLAIMED;
  // A test needs no name to be run (`vigiles test` finds `.harness.mjs`); a hook
  // or a provider must be nameable, so a stemless one is nobody's.
  return parts?.[1] === "" && row.kind.kind !== "vigiles-test"
    ? UNCLAIMED
    : row.kind;
}

/**
 * Is this basename an eval script — the PAID tier, the one that spends real
 * model calls? It decides which of two runners owns a test file, and has been
 * wrong in both directions:
 *
 * - As the full suffix `.eval.mjs`: `foo.eval.ts` fell into the free branch and
 *   would have spent real model calls on every push.
 * - As the bare INFIX `.eval.`: `parser.eval.test.ts`, an ordinary deterministic
 *   test, was credited to the paid tier and dropped from the free one — though
 *   `vigiles eval` cannot discover that name at all.
 *
 * The answer that is wrong in neither direction is the runner's own: `.eval.`
 * followed by a runnable extension AT THE END of the name, which is exactly what
 * the last-infix rule of {@link classifySource} says.
 *
 * @param filename a BASENAME — callers strip the directory with their own path
 * helper (`node:path` on disk, `posix-path` in the browser twin).
 */
export function isEvalScript(filename: string): boolean {
  const k = classifySource(filename);
  return k.kind === "vigiles-test" && k.test === "eval";
}

/** Is this basename a vigiles test of either tier? */
export function isVigilesTest(filename: string): boolean {
  return classifySource(filename).kind === "vigiles-test";
}

/** The glob `vigiles test` / `vigiles eval` discover a tier's scripts with. */
export function testGlob(tier: TestTier): string {
  return `**/*.${tier}.{${RUNNABLE_EXTS.join(",")}}`;
}

/** The patterns coverage credits tests with by default — one per tier, from the table. */
export const DEFAULT_TEST_GLOBS: readonly string[] = TEST_TIERS.map(testGlob);

/** Split at the last directory separator — either one, so a Windows path works too. */
const splitDir = (path: string): readonly [string, string] => {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return [path.slice(0, cut), path.slice(cut)];
};

/** The last path segment, whichever separator precedes it. */
export const baseName = (path: string): string => splitDir(path)[1];

/** Everything up to and including the last separator, or "" when there is none. */
export const dirName = (path: string): string => splitDir(path)[0];

/**
 * `guard.mjs` → `guard.hook.mjs`: the name a file must carry to be claimed as
 * `marker`. Keeps the directory. The inverse of {@link preMarkerName}.
 */
export function markedName(path: string, marker: CompilableMarker): string {
  const [dir, base] = splitDir(path);
  return dir + base.replace(/\.([^.]+)$/, `.${marker}.$1`);
}

/**
 * `guard.hook.mjs` → `guard.mjs`: the name a file carried before the marker
 * existed, or `undefined` when the name has no such marker. Used to recognise
 * the wiring an older vigiles wrote for the same file.
 */
export function preMarkerName(
  path: string,
  marker: CompilableMarker,
): string | undefined {
  const [dir, base] = splitDir(path);
  const m = new RegExp(`^([\\s\\S]+)\\.${marker}\\.(${EXT_ALT})$`).exec(base);
  return m === null ? undefined : `${dir}${m[1]}.${m[2]}`;
}
