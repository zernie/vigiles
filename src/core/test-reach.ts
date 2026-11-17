/**
 * What one harness file can REACH — the files whose change can change its
 * outcome — for `vigiles test --changed` (`./test-selection.ts` decides with it).
 *
 * Three edges, followed from the harness through every code file it reaches:
 *
 * 1. IMPORTS — relative `import`/`export … from`/`require`/literal `import()`,
 *    found by TypeScript's `preProcessFile` and resolved by `resolveModuleName`.
 * 2. EFFECT CALLS — a call that runs, reads or copies a file: the `spawn`/`exec`
 *    family (the command and its argv array), `readFile*`/`createReadStream`,
 *    `cp*`/`copyFile*`, and `runHook(command)`. Only CALL ARGUMENTS count: a path
 *    inside an object literal (`tool_input.file_path` in a synthetic hook event)
 *    is a fixture, never a dependency. A script the call runs is followed like
 *    an import, so its own imports and calls count too.
 * 3. BUILD OUTPUT → SOURCE — a path inside the tsconfig's `outDir` is read as its
 *    `rootDir` counterpart (`dist/x.js` → `src/x.ts`), so a harness that imports
 *    the build is reached by a change to the source behind it.
 *
 * An effect path is EVALUATED, not matched as text: string literals, `+` and
 * template literals, `path.join`/`resolve`/`dirname`, `__dirname`,
 * `import.meta.{url,dirname,filename}`, `new URL(x, import.meta.url)`,
 * `fileURLToPath`, `process.cwd()`, and a `const` bound to any of those. A path
 * whose start is known and whose end is not (`join(ROOT, "data", name)`) is a
 * PREFIX: any change under `data/` reaches the harness. A path with nothing
 * known is UNRESOLVED and reported as such; what to do with it is the
 * selector's decision, not this module's.
 *
 * Pure: every read goes through {@link SourceHost}.
 */
import ts from "typescript";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/** The reads reach needs. Paths are absolute. */
export interface SourceHost {
  /** A file's text, or null when it is absent or unreadable. */
  readonly read: (path: string) => string | null;
  readonly isFile: (path: string) => boolean;
  /** tsc's own directory walk (`ts.sys.readDirectory`), for a tsconfig's inputs. */
  readonly readDirectory: ts.ParseConfigHost["readDirectory"];
}

/** Where a TypeScript build writes, and the source it writes from. Absolute. */
export interface OutputLayout {
  readonly outDir: string;
  readonly rootDir: string;
}

/** A file or folder an effect call names, cwd-relative and POSIX. */
export interface EffectDep {
  readonly path: string;
  /** True: any changed path STARTING with `path` (an unknown tail). */
  readonly prefix: boolean;
  readonly call: string;
}

/** An effect call whose path argument could not be evaluated at all. */
export interface Unresolved {
  readonly call: string;
  readonly file: string;
  readonly line: number;
}

export interface Reach {
  /** Code and data files reached by import, cwd-relative and POSIX. */
  readonly imports: ReadonlySet<string>;
  readonly effects: readonly EffectDep[];
  readonly unresolved: readonly Unresolved[];
}

export type ReachHit =
  | { readonly kind: "import" }
  | { readonly kind: "reads"; readonly call: string };

/** Does a change to `changed` (cwd-relative) reach through `r`, and how? */
export function reachMatch(r: Reach, changed: string): ReachHit | undefined {
  if (r.imports.has(changed)) return { kind: "import" };
  const dep = r.effects.find((d) =>
    d.prefix
      ? changed.startsWith(d.path)
      : changed === d.path || changed.startsWith(`${d.path}/`),
  );
  return dep === undefined ? undefined : { kind: "reads", call: dep.call };
}

// ---------------------------------------------------------------------------
// tsconfig — outDir → rootDir
// ---------------------------------------------------------------------------

/**
 * The `outDir`/`rootDir` of `<cwd>/tsconfig.json`, read by TypeScript itself
 * (`extends` included). No tsconfig or no `outDir` → undefined, and paths are
 * taken as they are. An unset `rootDir` is taken as the tsconfig's folder.
 */
export function outputLayout(
  cwd: string,
  host: SourceHost,
): OutputLayout | undefined {
  const path = join(cwd, "tsconfig.json");
  if (!host.isFile(path)) return undefined;
  const readFile = (p: string): string | undefined => host.read(p) ?? undefined;
  const raw = ts.readConfigFile(path, readFile);
  if (raw.error !== undefined) return undefined;
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    {
      useCaseSensitiveFileNames: true,
      readDirectory: host.readDirectory,
      fileExists: host.isFile,
      readFile,
    },
    cwd,
  );
  const { outDir, rootDir, composite } = parsed.options;
  if (outDir === undefined) return undefined;
  return {
    outDir: resolve(cwd, outDir),
    rootDir:
      rootDir !== undefined || composite === true
        ? resolve(cwd, rootDir ?? ".")
        : commonSourceDir(parsed.fileNames, cwd),
  };
}

const DECLARATION = /\.d\.[cm]?ts$/;

/**
 * tsc's default `rootDir` without `composite`: the deepest folder holding every
 * non-declaration input (measured: `include: ["src/**\/*.ts"]` emits
 * `src/helper.ts` to `dist/helper.js`). No inputs → the tsconfig's folder.
 */
function commonSourceDir(files: readonly string[], cwd: string): string {
  const dirs = files
    .filter((f) => !DECLARATION.test(f))
    .map((f) => dirname(resolve(cwd, f)).split(sep));
  const [first, ...rest] = dirs;
  if (first === undefined) return cwd;
  const depth = first.findIndex((part, i) => rest.some((d) => d[i] !== part));
  return first.slice(0, depth < 0 ? first.length : depth).join(sep) || sep;
}

/** Output extension → the source extensions that compile to it. */
const SOURCE_EXTS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".js"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** `dist/x.js` → `src/x.ts` when that source exists; otherwise unchanged. */
function toSource(
  abs: string,
  layout: OutputLayout | undefined,
  host: SourceHost,
): string {
  if (layout === undefined || !isInside(abs, layout.outDir)) return abs;
  const rel = relative(layout.outDir, abs);
  const twin = join(layout.rootDir, rel);
  const dts = rel.endsWith(".d.ts");
  const ext = dts ? ".d.ts" : extname(rel);
  const stem = join(layout.rootDir, rel.slice(0, rel.length - ext.length));
  const exts = dts ? [".ts"] : (SOURCE_EXTS[ext] ?? []);
  return exts.map((e) => stem + e).find((p) => host.isFile(p)) ?? twin;
}

// ---------------------------------------------------------------------------
// Values — what a path expression evaluates to
// ---------------------------------------------------------------------------

/**
 * `str` known; `pre` known to START with `s`; `data` not a path; `tmp` a path
 * under a fresh temporary directory (never a repository file); `unk` unknown.
 */
type Val =
  | { readonly k: "str"; readonly s: string }
  | { readonly k: "pre"; readonly s: string }
  | { readonly k: "data" }
  | { readonly k: "tmp" }
  | { readonly k: "unk" };

const UNK: Val = { k: "unk" };
const DATA: Val = { k: "data" };
const TMP: Val = { k: "tmp" };

/** Calls that make or name a temporary directory. */
const TEMP_DIRS: ReadonlySet<string> = new Set([
  "mkdtemp",
  "mkdtempSync",
  "tmpdir",
  "makeTmpDir",
]);
const str = (s: string): Val => ({ k: "str", s });

interface Scope {
  readonly file: string;
  readonly cwd: string;
  /** Each variable's sources: its initializer and every plain assignment. */
  readonly consts: (name: string) => readonly ts.Expression[];
  /** Names being evaluated on the current path — a cycle guard. */
  readonly visiting: ReadonlySet<string>;
}

function concat(a: Val, b: Val): Val {
  if (a.k === "tmp") return TMP;
  if (a.k === "str") return concatKnown(a.s, b);
  if (a.k === "pre") return a;
  return a.k === "data" && b.k === "data" ? DATA : UNK;
}

/** A known head followed by `b`. `${x}/y` starts with x, so an empty head is `b`. */
function concatKnown(head: string, b: Val): Val {
  if (head === "") return b;
  if (b.k === "str") return str(head + b.s);
  return { k: "pre", s: b.k === "pre" ? head + b.s : head };
}

function unwrap(e: Readonly<ts.Expression>): Readonly<ts.Expression> {
  return ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
    ? unwrap(e.expression)
    : e;
}

function evalExpr(raw: Readonly<ts.Expression>, sc: Scope): Val {
  const e = unwrap(raw);
  if (ts.isStringLiteralLike(e)) return str(e.text);
  if (ts.isNumericLiteral(e) || ts.isObjectLiteralExpression(e)) return DATA;
  if (ts.isTemplateExpression(e)) return evalTemplate(e, sc);
  if (ts.isBinaryExpression(e)) return evalBinary(e, sc);
  if (ts.isIdentifier(e)) return evalIdent(e.text, sc);
  if (ts.isPropertyAccessExpression(e)) return evalProp(e, sc);
  if (ts.isCallExpression(e)) return evalCall(e, sc);
  if (ts.isNewExpression(e)) return evalNewUrl(e, sc);
  return UNK;
}

const FALLBACK_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);

/**
 * `process.env.X ?? process.cwd()`: when the left side is not a known path the
 * fallback is taken. An override that points somewhere else is not modelled —
 * the folder rule and the full run on the default branch remain behind it.
 */
function evalBinary(e: Readonly<ts.BinaryExpression>, sc: Scope): Val {
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.PlusToken)
    return concat(evalExpr(e.left, sc), evalExpr(e.right, sc));
  return FALLBACK_OPS.has(op) ? evalFallback(e, sc) : UNK;
}

function evalFallback(e: Readonly<ts.BinaryExpression>, sc: Scope): Val {
  const left = evalExpr(e.left, sc);
  return left.k === "str" ? left : evalExpr(e.right, sc);
}

function evalTemplate(e: Readonly<ts.TemplateExpression>, sc: Scope): Val {
  return e.templateSpans.reduce(
    (acc, span) =>
      concat(
        concat(acc, evalExpr(span.expression, sc)),
        str(span.literal.text),
      ),
    str(e.head.text),
  );
}

function evalIdent(name: string, sc: Scope): Val {
  if (name === "__dirname") return str(dirname(sc.file));
  if (name === "__filename") return str(sc.file);
  if (name === "undefined") return DATA;
  // A name already being evaluated on this path is a cycle (`x = x + "/a"`):
  // unknown. Without this the sources fan out at every level — measured at 44 s
  // for one harness whose loop variable has several assignments.
  if (sc.visiting.has(name)) return UNK;
  const sources = sc.consts(name);
  if (sources.length === 0) return UNK;
  const inner = { ...sc, visiting: new Set([...sc.visiting, name]) };
  return merge(sources.map((e) => evalExpr(e, inner)));
}

/** A variable with several sources is known only when they all agree. */
function merge(vals: readonly Val[]): Val {
  const [first, ...rest] = vals;
  if (first === undefined) return UNK;
  const same = rest.every(
    (v) =>
      v.k === first.k &&
      (v.k === "str" || v.k === "pre"
        ? first.k === v.k && first.s === v.s
        : true),
  );
  return same ? first : UNK;
}

const META: Readonly<Record<string, (sc: Scope) => Val>> = {
  url: (sc) => str(sc.file),
  filename: (sc) => str(sc.file),
  dirname: (sc) => str(dirname(sc.file)),
};

function evalProp(e: Readonly<ts.PropertyAccessExpression>, sc: Scope): Val {
  const name = e.name.text;
  if (ts.isMetaProperty(e.expression)) return META[name]?.(sc) ?? UNK;
  if (ts.isIdentifier(e.expression) && e.expression.text === "process")
    return name === "execPath" || name === "argv0" ? DATA : UNK;
  return name === "pathname" || name === "href"
    ? evalExpr(e.expression, sc)
    : UNK;
}

function calleeName(
  e: Readonly<ts.CallExpression> | Readonly<ts.NewExpression>,
): string {
  const c = e.expression;
  if (ts.isIdentifier(c)) return c.text;
  return ts.isPropertyAccessExpression(c) ? c.name.text : "";
}

function evalPathCall(name: string, args: readonly Val[], cwd: string): Val {
  if (args[0]?.k === "tmp") return TMP;
  const firstUnknown = args.findIndex((v) => v.k !== "str");
  const known = args
    .slice(0, firstUnknown < 0 ? args.length : firstUnknown)
    .flatMap((v) => (v.k === "str" ? [v.s] : []));
  const joined = name === "resolve" ? resolve(cwd, ...known) : join(...known);
  if (firstUnknown < 0) return str(joined);
  const tail = args[firstUnknown];
  if (tail?.k === "pre") return { k: "pre", s: join(joined, tail.s) };
  return known.length === 0 ? UNK : { k: "pre", s: joined + sep };
}

/** Methods taken to return the path they are called on (a trailing-slash trim, mostly). */
const SAME_PATH: ReadonlySet<string> = new Set([
  "toString",
  "replace",
  "trim",
  "normalize",
]);

/** Calls whose result is decided by their arguments alone. */
const ARG_CALLS: Readonly<
  Record<string, (args: readonly Val[], sc: Scope) => Val>
> = {
  join: (args, sc) => evalPathCall("join", args, sc.cwd),
  resolve: (args, sc) => evalPathCall("resolve", args, sc.cwd),
  dirname: ([v]) => (v?.k === "str" ? str(dirname(v.s)) : UNK),
  fileURLToPath: ([v]) => v ?? UNK,
  String: ([v]) => v ?? UNK,
  stringify: () => DATA,
  cwd: (_, sc) => str(sc.cwd),
};

function evalCall(e: Readonly<ts.CallExpression>, sc: Scope): Val {
  const name = calleeName(e);
  if (TEMP_DIRS.has(name)) return TMP;
  if (SAME_PATH.has(name) && ts.isPropertyAccessExpression(e.expression))
    return evalExpr(e.expression.expression, sc);
  const byArgs = ARG_CALLS[name];
  return byArgs === undefined
    ? UNK
    : byArgs(
        e.arguments.map((a) => evalExpr(a, sc)),
        sc,
      );
}

/** `new URL(rel, base)` → a path; a URL is carried as the path it names. */
function evalNewUrl(e: Readonly<ts.NewExpression>, sc: Scope): Val {
  if (calleeName(e) !== "URL") return UNK;
  const [rel, base] = (e.arguments ?? []).map((a) => evalExpr(a, sc));
  const r = rel?.k === "str" ? str(rel.s.replace(/^file:\/\//, "")) : UNK;
  if (base === undefined || r.k !== "str") return r;
  if (base.k !== "str") return UNK;
  const dir = base.s.endsWith("/") ? base.s : dirname(base.s);
  return str(resolve(dir, r.s) + (r.s.endsWith("/") ? "/" : ""));
}

// ---------------------------------------------------------------------------
// Effect calls — which arguments are paths
// ---------------------------------------------------------------------------

const READS = new Set([
  "readFile",
  "readFileSync",
  "createReadStream",
  "readdir",
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "cp",
  "cpSync",
  "copyFile",
  "copyFileSync",
]);
const SPAWNS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const SHELLS = new Set(["exec", "execSync", "runHook"]);

/** A path value plus the folder a relative one is resolved against. */
interface PathArg {
  readonly val: Val;
  /** undefined: relative to a folder nobody can name — not a repo path. */
  readonly base: string | undefined;
}

function argvOf(
  e: Readonly<ts.Expression> | undefined,
  sc: Scope,
): readonly Val[] {
  if (e === undefined || ts.isObjectLiteralExpression(e)) return [];
  const arr = ts.isIdentifier(e) ? sc.consts(e.text)[0] : e;
  if (arr === undefined || !ts.isArrayLiteralExpression(arr)) return [UNK];
  return arr.elements.map((el) =>
    ts.isSpreadElement(el) ? UNK : evalExpr(el, sc),
  );
}

function tokensOf(v: Val): readonly Val[] {
  if (v.k === "unk") return [UNK];
  if (v.k === "data" || v.k === "tmp") return [];
  const words = v.s
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => str(w.replace(/^["']|["']$/g, "")));
  if (v.k === "str") return words;
  if (/\s$/.test(v.s) || words.length === 0) return [...words, UNK];
  const last = words[words.length - 1];
  return [
    ...words.slice(0, -1),
    { k: "pre", s: last?.k === "str" ? last.s : "" },
  ];
}

/** The `cwd` option: run cwd when absent, its value when known, else unnameable. */
function cwdOption(
  opts: Readonly<ts.Expression> | undefined,
  sc: Scope,
): string | undefined {
  if (opts === undefined || !ts.isObjectLiteralExpression(opts)) return sc.cwd;
  const prop = opts.properties.find(
    (p) =>
      p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "cwd",
  );
  if (prop === undefined) return sc.cwd;
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const v = evalExpr(prop.initializer, sc);
  return v.k === "str" ? resolve(sc.cwd, v.s) : undefined;
}

function effectArgs(
  e: Readonly<ts.CallExpression>,
  name: string,
  sc: Scope,
): readonly PathArg[] {
  const [a0, a1, a2] = e.arguments;
  const first = a0 === undefined ? DATA : evalExpr(a0, sc);
  if (READS.has(name)) return [{ val: first, base: sc.cwd }];
  if (SPAWNS.has(name)) {
    const opts = a1 !== undefined && ts.isObjectLiteralExpression(a1) ? a1 : a2;
    const base = cwdOption(opts, sc);
    return [first, ...argvOf(a1, sc)].map((val) => ({ val, base }));
  }
  const base = name === "runHook" ? sc.cwd : cwdOption(a1, sc);
  return tokensOf(first).map((val) => ({ val, base }));
}

// ---------------------------------------------------------------------------
// One file's facts, and the walk
// ---------------------------------------------------------------------------

interface AbsDep {
  readonly abs: string;
  readonly prefix: boolean;
  readonly call: string;
}

interface Facts {
  readonly next: readonly Visit[];
  readonly deps: readonly AbsDep[];
  readonly unresolved: readonly Unresolved[];
}

interface Ctx {
  readonly cwd: string;
  readonly host: SourceHost;
  readonly layout: OutputLayout | undefined;
}

function allNodes(
  n: Readonly<ts.Node>,
  sf: Readonly<ts.SourceFile>,
): readonly ts.Node[] {
  return [n, ...n.getChildren(sf).flatMap((c) => allNodes(c, sf))];
}

/**
 * Every variable's sources: the initializer of each declaration of the name and
 * the right side of each `name = …`. Function parameters have none, so they
 * stay unknown. Shadowed names merge, which can only make a value unknown.
 */
function bindingsOf(
  nodes: readonly ts.Node[],
): (name: string) => readonly ts.Expression[] {
  const pairs = nodes.flatMap(
    (n): readonly (readonly [string, ts.Expression])[] => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer
      )
        return [[n.name.text, n.initializer]];
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left)
      )
        return [[n.left.text, n.right]];
      return [];
    },
  );
  // Looked up on demand: only the names an effect argument mentions are ever
  // asked for, and grouping every binding of a 3,000-line harness up front was
  // quadratic (measured: a minute over 155 harnesses).
  return (name) => pairs.flatMap(([n, e]) => (n === name ? [e] : []));
}

function depOf(arg: PathArg, call: string): AbsDep | "unresolved" | undefined {
  const { val, base } = arg;
  // Under a `cwd` option nobody can name (a temp sandbox), the call works on
  // files the harness made: an unknown argument there names no repo file.
  if (val.k === "unk") return base === undefined ? undefined : "unresolved";
  if (val.k === "data" || val.k === "tmp") return undefined;
  return pathDep(val.s, val.k === "pre", base, call);
}

/** A flag (`-x`) or an empty string names nothing; a relative path needs a base. */
function pathDep(
  s: string,
  prefix: boolean,
  base: string | undefined,
  call: string,
): AbsDep | undefined {
  const raw = s.replace(/^file:\/\//, "");
  if (raw === "" || raw.startsWith("-")) return undefined;
  if (!isAbsolute(raw) && base === undefined) return undefined;
  const abs = resolve(base ?? "/", raw);
  return { abs: prefix && raw.endsWith(sep) ? abs + sep : abs, prefix, call };
}

/** Local names bound to `child_process`: whole-module and per-function. */
interface ChildProcessNames {
  readonly modules: ReadonlySet<string>;
  readonly functions: ReadonlySet<string>;
}

const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);

function importNames(d: Readonly<ts.ImportDeclaration>): ChildProcessNames {
  const clause = d.importClause;
  const nb = clause?.namedBindings;
  return {
    modules: new Set([
      ...(clause?.name ? [clause.name.text] : []),
      ...(nb && ts.isNamespaceImport(nb) ? [nb.name.text] : []),
    ]),
    functions: new Set(
      nb && ts.isNamedImports(nb) ? nb.elements.map((el) => el.name.text) : [],
    ),
  };
}

function requireNames(d: Readonly<ts.VariableDeclaration>): ChildProcessNames {
  if (ts.isIdentifier(d.name))
    return { modules: new Set([d.name.text]), functions: new Set() };
  const els = ts.isObjectBindingPattern(d.name) ? d.name.elements : [];
  return {
    modules: new Set(),
    functions: new Set(
      els.flatMap((el) => (ts.isIdentifier(el.name) ? [el.name.text] : [])),
    ),
  };
}

function isChildProcessRequire(n: ts.Node): n is ts.VariableDeclaration {
  if (!ts.isVariableDeclaration(n) || n.initializer === undefined) return false;
  const init = n.initializer;
  return (
    ts.isCallExpression(init) &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === "require" &&
    init.arguments.some(
      (a) => ts.isStringLiteralLike(a) && CHILD_PROCESS.has(a.text),
    )
  );
}

function childProcessBindings(nodes: readonly ts.Node[]): ChildProcessNames {
  const all = [
    ...nodes
      .filter(ts.isImportDeclaration)
      .filter(
        (d) =>
          ts.isStringLiteral(d.moduleSpecifier) &&
          CHILD_PROCESS.has(d.moduleSpecifier.text),
      )
      .map(importNames),
    ...nodes.filter(isChildProcessRequire).map(requireNames),
  ];
  return {
    modules: new Set(all.flatMap((n) => [...n.modules])),
    functions: new Set(all.flatMap((n) => [...n.functions])),
  };
}

/**
 * Is this call one that runs, reads or copies a file? `exec` alone is checked
 * against its binding, because `RegExp.prototype.exec` shares the name; every
 * other name is taken as it is (an extra dependency costs a run, not a miss).
 */
function isEffectCall(
  call: Readonly<ts.CallExpression>,
  name: string,
  cp: ChildProcessNames,
): boolean {
  if (name !== "exec")
    return READS.has(name) || SPAWNS.has(name) || SHELLS.has(name);
  const c = call.expression;
  if (ts.isIdentifier(c)) return cp.functions.has(c.text);
  return (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    cp.modules.has(c.expression.text)
  );
}

function effectsIn(
  abs: string,
  sf: Readonly<ts.SourceFile>,
  ctx: Ctx,
): Pick<Facts, "deps" | "unresolved"> {
  const nodes = allNodes(sf, sf);
  const sc: Scope = {
    file: abs,
    cwd: ctx.cwd,
    consts: bindingsOf(nodes),
    visiting: new Set(),
  };
  const cp = childProcessBindings(nodes);
  const found = nodes.filter(ts.isCallExpression).flatMap((call) => {
    const name = calleeName(call);
    if (!isEffectCall(call, name, cp)) return [];
    const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
    const at = (a: PathArg) => ({ d: depOf(a, name), name, line });
    return effectArgs(call, name, sc).map(at);
  });
  const rel = posixRelative(ctx.cwd, abs);
  return {
    deps: found.flatMap((f) => (typeof f.d === "object" ? [f.d] : [])),
    unresolved: found
      .filter((f) => f.d === "unresolved")
      .map((f) => ({ call: f.name, file: rel, line: f.line })),
  };
}

/**
 * `typescript` is already a runtime dependency, and `preProcessFile` is its
 * import scanner. Resolution goes through `resolveModuleName` in Bundler mode,
 * so `./x.js` finds `x.ts` the way a NodeNext project writes it, and an
 * extensionless specifier resolves. The literal path is kept too.
 */
const RESOLVE_OPTIONS: Readonly<ts.CompilerOptions> = {
  allowJs: true,
  resolveJsonModule: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** A file to visit, and whether it is the SOURCE of a build the harness runs. */
interface Visit {
  readonly abs: string;
  readonly built: boolean;
}

/** `p` read through the build mapping, flagged when the mapping moved it. */
function viaBuild(p: string, built: boolean, ctx: Ctx): Visit {
  const abs = toSource(p, ctx.layout, ctx.host);
  return { abs, built: built || abs !== p };
}

function importsIn(at: Visit, text: string, ctx: Ctx): readonly Visit[] {
  const resolver = {
    fileExists: ctx.host.isFile,
    readFile: (p: string) => ctx.host.read(p) ?? undefined,
  };
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map((i) => i.fileName)
    .filter((s) => s.startsWith("./") || s.startsWith("../"))
    .flatMap((spec) => {
      const literal = viaBuild(resolve(dirname(at.abs), spec), at.built, ctx);
      const viaTs = ts.resolveModuleName(
        spec,
        at.abs,
        RESOLVE_OPTIONS,
        resolver,
      ).resolvedModule?.resolvedFileName;
      const resolved =
        viaTs === undefined ? [] : [{ abs: resolve(viaTs), built: at.built }];
      const found = [literal, ...resolved].filter((v) =>
        ctx.host.isFile(v.abs),
      );
      return found.length > 0
        ? found
        : candidatesOf(literal.abs).map((abs) => ({ abs, built: at.built }));
    });
}

const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const TRIED_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Every file the resolver would have tried for an import that resolves to
 * nothing: the literal path, its TypeScript twins, and for an extensionless
 * specifier each extension and `index` file. 🔴 A MISSING TARGET IS STILL A
 * DEPENDENCY. A change that deletes or renames it is exactly the change that
 * breaks the harness; dropping the edge skipped the harness and passed green.
 * The paths are kept for matching and never visited.
 */
function candidatesOf(abs: string): readonly string[] {
  const ext = extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  const twins = (JS_TO_TS[ext] ?? []).map((e) => stem + e);
  const bare =
    TRIED_EXTS.includes(ext) || ext === ".jsx"
      ? []
      : TRIED_EXTS.flatMap((e) => [abs + e, join(abs, "index" + e)]);
  return [abs, ...twins, ...bare];
}

const NO_FACTS: Facts = { next: [], deps: [], unresolved: [] };

/**
 * One file's edges. 🔴 A BUILD'S SOURCE CONTRIBUTES IMPORTS ONLY. Code reached
 * through `outDir` → `rootDir` is the program under test, and its file reads
 * take their paths from the harness at run time (`join(cwd, name)` over a
 * sandbox); scanning them made every harness of a library repository depend on
 * the whole tree, a docs edit included (measured: 14 of 16). Its source files
 * are dependencies through the import edge, which is the part that is known.
 */
function factsOf(at: Visit, ctx: Ctx): Facts {
  const text = CODE_EXT.test(at.abs) ? ctx.host.read(at.abs) : null;
  if (text === null) return NO_FACTS;
  const imports = importsIn(at, text, ctx);
  if (at.built) return { ...NO_FACTS, next: imports };
  const sf = ts.createSourceFile(at.abs, text, ts.ScriptTarget.Latest, true);
  const { deps: raw, unresolved } = effectsIn(at.abs, sf, ctx);
  const scripts = raw
    .filter((d) => !d.prefix && CODE_EXT.test(d.abs))
    .map((d) => viaBuild(d.abs, false, ctx))
    .filter((v) => ctx.host.isFile(v.abs));
  const deps = raw.map((d) =>
    d.prefix ? d : { ...d, abs: toSource(d.abs, ctx.layout, ctx.host) },
  );
  return { next: [...imports, ...scripts], deps, unresolved };
}

interface Walk {
  readonly seen: ReadonlySet<string>;
  readonly deps: readonly AbsDep[];
  readonly unresolved: readonly Unresolved[];
}

function walk(frontier: readonly Visit[], acc: Walk, ctx: Ctx): Walk {
  if (frontier.length === 0) return acc;
  const facts = frontier.map((f) => factsOf(f, ctx));
  const fresh = facts
    .flatMap((f) => f.next)
    .filter((v) => !acc.seen.has(v.abs));
  const next = [...new Map(fresh.map((v) => [v.abs, v])).values()];
  return walk(
    next,
    {
      seen: new Set([...acc.seen, ...next.map((v) => v.abs)]),
      deps: [...acc.deps, ...facts.flatMap((f) => f.deps)],
      unresolved: [...acc.unresolved, ...facts.flatMap((f) => f.unresolved)],
    },
    ctx,
  );
}

/** `relative`, in POSIX separators. */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** A dependency as a cwd-relative match; the cwd or a folder above it is "". */
function toEffectDep(d: AbsDep, cwd: string): EffectDep {
  const bare = d.abs.endsWith(sep) ? d.abs.slice(0, -1) : d.abs;
  const covers = cwd === bare || cwd.startsWith(bare + sep);
  if (covers) return { path: "", prefix: true, call: d.call };
  const rel = posixRelative(cwd, d.abs);
  return {
    path: d.prefix && d.abs.endsWith(sep) ? `${rel}/` : rel,
    prefix: d.prefix,
    call: d.call,
  };
}

export interface ReachInput {
  readonly cwd: string;
  /** The harness file, relative to `cwd`. */
  readonly file: string;
  readonly host: SourceHost;
  readonly layout: OutputLayout | undefined;
}

/** Everything `file` reaches. See the module header for the three edges. */
export function harnessReach(input: ReachInput): Reach {
  const ctx: Ctx = { cwd: input.cwd, host: input.host, layout: input.layout };
  const start = resolve(input.cwd, input.file);
  const w = walk(
    [{ abs: start, built: false }],
    { seen: new Set([start]), deps: [], unresolved: [] },
    ctx,
  );
  return {
    imports: new Set(
      [...w.seen]
        .filter((p) => p !== start)
        .map((p) => posixRelative(input.cwd, p)),
    ),
    effects: w.deps.map((d) => toEffectDep(d, input.cwd)),
    unresolved: w.unresolved,
  };
}
