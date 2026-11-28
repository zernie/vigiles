/**
 * The image an eval attempt's container runs (vigiles#599), for
 * `./container.io.ts`: the harness adapter's recipe (base image + the npm
 * packages that put its binary in) plus vigiles itself, installed from
 * `npm pack` of the running package under `/opt/vigiles`, so the intercept
 * hook finds its dependencies and native modules (`dist/` alone does not run).
 *
 * The tag is a hash of the Dockerfile, the recipe's image fields, the
 * tarball's bytes and the host CA's bytes: built once, reused while it exists.
 * ONE thing from the host reaches the build: the CA file `NODE_EXTRA_CA_CERTS`
 * names, read by {@link hostCaOf} at the adapter edge and handed in as bytes,
 * so a build behind a proxy that decrypts HTTPS can run `npm install`, and so
 * can every run in the image. Nothing else does — no build args, no other env
 * value, no proxy variable, no API key. Without that variable the Dockerfile
 * and the tag are the same bytes as an image's that never had a CA step.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ContainerOptions,
  HarnessImageRecipe,
} from "../core/container.js";
import { makeTmpDir } from "../core/tmp-root.js";
import { messageOf, type Tc } from "./container-attempt.io.js";

/** Where the build context puts vigiles's own tarball. */
const VIGILES_TARBALL = "vigiles.tgz";
const NPM_GLOBAL = ["npm", "install", "-g", "--no-audit", "--no-fund"];

/** Installs `git` with whichever package manager the base has. */
const GIT_STEP =
  "RUN if command -v git >/dev/null 2>&1; then :; " +
  "elif command -v apt-get >/dev/null 2>&1; then apt-get update && " +
  "apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; " +
  "elif command -v apk >/dev/null 2>&1; then apk add --no-cache git; " +
  'else echo "no apt-get or apk to install git" >&2; exit 1; fi';

/** Where the build context puts the host CA. */
const HOST_CA_FILE = "host-ca.crt";
/** Where the image keeps the host CA: `update-ca-certificates` reads `*.crt` here. */
export const HOST_CA_IN_IMAGE =
  "/usr/local/share/ca-certificates/vigiles-host-ca.crt";

/** Adds the copied host CA to the system store, installing the tool when the base lacks it. */
const SYSTEM_CA_STEP =
  "RUN if ! command -v update-ca-certificates >/dev/null 2>&1; then " +
  "if command -v apt-get >/dev/null 2>&1; then apt-get update && " +
  "apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; " +
  "elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates; fi; fi; " +
  "update-ca-certificates";

/**
 * The host CA's steps: copied in and trusted by `node` (so by npm) before any
 * step reaches the network, then added to the system store (for `git` and
 * `curl`) once `git`'s step has installed `ca-certificates`.
 */
const caSteps = (
  ca: Readonly<Buffer> | undefined,
): { readonly node: readonly string[]; readonly system: readonly string[] } =>
  ca === undefined
    ? { node: [], system: [] }
    : {
        node: [
          `COPY ${HOST_CA_FILE} ${HOST_CA_IN_IMAGE}`,
          `ENV NODE_EXTRA_CA_CERTS=${HOST_CA_IN_IMAGE}`,
        ],
        system: [SYSTEM_CA_STEP],
      };

/**
 * The Dockerfile of a recipe, with the host CA's steps when `ca` is given.
 * Exec form for every argument that comes from the recipe, so none of them
 * reaches a shell.
 */
export function dockerfileFor(
  recipe: HarnessImageRecipe,
  ca?: Readonly<Buffer>,
): string {
  if (recipe.base.trim() !== recipe.base || recipe.base.includes(" "))
    throw new Error(`container image base is not one word: ${recipe.base}`);
  const tarball = `/tmp/${VIGILES_TARBALL}`;
  const packages =
    recipe.npmPackages.length === 0
      ? []
      : [`RUN ${JSON.stringify([...NPM_GLOBAL, ...recipe.npmPackages])}`];
  const vigiles = [...NPM_GLOBAL, "--prefix", "/opt/vigiles", tarball];
  const trust = caSteps(ca);
  return [
    `FROM ${recipe.base}`,
    ...trust.node,
    GIT_STEP,
    ...trust.system,
    ...packages,
    `COPY ${VIGILES_TARBALL} ${tarball}`,
    `RUN ${JSON.stringify(vigiles)}`,
    "",
  ].join("\n");
}

/** The recipe's fields that shape the image; `egressProbe` does not. */
const imageFieldsOf = (r: HarnessImageRecipe) => ({
  base: r.base,
  npmPackages: r.npmPackages,
  binary: r.binary,
});

/** The tag a recipe, a vigiles tarball and a host CA build: same inputs, same tag. */
export function imageTagFor(
  recipe: HarnessImageRecipe,
  tarball: Readonly<Buffer>,
  ca?: Readonly<Buffer>,
): string {
  const hash = createHash("sha256")
    .update(dockerfileFor(recipe, ca))
    .update(JSON.stringify(imageFieldsOf(recipe)))
    .update(tarball);
  const hex = (ca === undefined ? hash : hash.update(ca)).digest("hex");
  return `vigiles-harness:${hex.slice(0, 16)}`;
}

/**
 * The bytes of the CA file the host's `NODE_EXTRA_CA_CERTS` names; undefined
 * when the variable is unset or empty or the file cannot be read (the image
 * then trusts only its own store, and the egress probe reports what fails).
 */
export function hostCaOf(
  env: Readonly<Record<string, string | undefined>>,
): Buffer | undefined {
  const path = env.NODE_EXTRA_CA_CERTS ?? "";
  if (path === "") return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

const pexecFile = promisify(execFile);

/** The tarball's file name in `npm pack --json` output. */
function packedName(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const name: unknown =
    typeof first === "object" && first !== null && "filename" in first
      ? first.filename
      : undefined;
  if (typeof name !== "string") throw new Error("npm pack wrote no tarball");
  return name;
}

/** `npm pack` of the vigiles package this module belongs to, as bytes. */
export async function packRunningVigiles(): Promise<Buffer> {
  const root = resolve(import.meta.dirname, "..", "..");
  const pkg: unknown = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  if (typeof pkg !== "object" || pkg === null || !("name" in pkg))
    throw new Error(`no package.json name at ${root}`);
  if (pkg.name !== "vigiles")
    throw new Error(`not the vigiles package root: ${root}`);
  const dest = makeTmpDir("container-pack");
  try {
    const { stdout } = await pexecFile(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", dest],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    return readFileSync(join(dest, packedName(stdout)));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

/** What an image is built from, besides its recipe: read at the adapter edge. */
export interface ImageSources {
  /** The bytes of `npm pack` of the running vigiles package. */
  readonly pack: () => Promise<Buffer>;
  /** The host CA to trust in the image (see {@link hostCaOf}); undefined for none. */
  readonly hostCa: () => Readonly<Buffer> | undefined;
}

interface Build {
  readonly tc: Readonly<Tc>;
  readonly recipe: HarnessImageRecipe;
  readonly tarball: Readonly<Buffer>;
  readonly ca: Readonly<Buffer> | undefined;
}

/** Build the recipe's image under `tag`; a failure names how to see the build log. */
async function buildImage(b: Build, tag: string): Promise<void> {
  const context = makeTmpDir("container-image");
  try {
    writeFileSync(join(context, "Dockerfile"), dockerfileFor(b.recipe, b.ca));
    writeFileSync(join(context, VIGILES_TARBALL), b.tarball);
    if (b.ca !== undefined) writeFileSync(join(context, HOST_CA_FILE), b.ca);
    await b.tc.GenericContainer.fromDockerfile(context).build(tag, {
      deleteOnExit: false,
    });
  } catch (e) {
    throw new Error(
      `image build failed: ${messageOf(e)} (DEBUG=testcontainers:build prints the build log)`,
      { cause: e },
    );
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** The recipe's image: reused when its tag exists, else built. */
async function ensureImage(
  tc: Readonly<Tc>,
  recipe: HarnessImageRecipe,
  sources: ImageSources,
): Promise<string> {
  const tarball = await sources.pack();
  const ca = sources.hostCa();
  const tag = imageTagFor(recipe, tarball, ca);
  const client = await tc.getContainerRuntimeClient();
  const exists = await client.image.exists(tc.ImageName.fromString(tag));
  if (!exists) await buildImage({ tc, recipe, tarball, ca }, tag);
  return tag;
}

/** Picks the image of one attempt. */
export type ImageFor = (
  tc: Readonly<Tc>,
  recipe: HarnessImageRecipe,
  options: ContainerOptions,
) => Promise<string>;

/**
 * `options.image` as-is, else the recipe's image, resolved once per recipe in
 * this process (a failure is retried on the next call).
 */
export function imageResolver(sources: ImageSources): ImageFor {
  const known = new Map<string, Promise<string>>();
  const forget = (key: string): void => {
    // eslint-disable-next-line functional/immutable-data -- the one memo: a failed build is not remembered.
    known.delete(key);
  };
  return (tc, recipe, options) => {
    if (options.image !== undefined) return Promise.resolve(options.image);
    const key = JSON.stringify(recipe);
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const made = ensureImage(tc, recipe, sources);
    // eslint-disable-next-line functional/immutable-data -- the one memo: concurrent trials share one build.
    known.set(key, made);
    made.catch(() => {
      forget(key);
    });
    return made;
  };
}
