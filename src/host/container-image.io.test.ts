/**
 * The image recipe's Dockerfile and tag (vigiles#599), without Docker: with no
 * host CA both are the same bytes they were before the CA step existed, so no
 * user's cached image is rebuilt; with one, the CA is trusted before the first
 * npm step and its bytes are part of the tag. `hostCaOf` reads only the file
 * `NODE_EXTRA_CA_CERTS` names.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessImageRecipe } from "../core/container.js";
import { cleanupTmpDir, makeTmpDir } from "../core/tmp-root.js";
import {
  dockerfileFor,
  HOST_CA_IN_IMAGE,
  hostCaOf,
  imageTagFor,
} from "./container-image.io.js";

const RECIPE: HarnessImageRecipe = {
  base: "node:24-slim",
  npmPackages: ["acme-harness@1.2.3"],
  binary: "acme",
};
const TARBALL = Buffer.from("tarball");
const CA = Buffer.from(
  "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
);

/** The Dockerfile and tag of RECIPE + TARBALL as built before the CA step existed. */
const BEFORE_CA_DOCKERFILE = [
  "FROM node:24-slim",
  'RUN if command -v git >/dev/null 2>&1; then :; elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; elif command -v apk >/dev/null 2>&1; then apk add --no-cache git; else echo "no apt-get or apk to install git" >&2; exit 1; fi',
  'RUN ["npm","install","-g","--no-audit","--no-fund","acme-harness@1.2.3"]',
  "COPY vigiles.tgz /tmp/vigiles.tgz",
  'RUN ["npm","install","-g","--no-audit","--no-fund","--prefix","/opt/vigiles","/tmp/vigiles.tgz"]',
  "",
].join("\n");
const BEFORE_CA_TAG = "vigiles-harness:8855e8ee93e85d71";

describe("dockerfileFor / imageTagFor without a host CA", () => {
  it("are byte-identical to the image built before the CA step", () => {
    // Guards: no CA variable changes nothing in the Dockerfile.
    expect(dockerfileFor(RECIPE)).toBe(BEFORE_CA_DOCKERFILE);
    // Guards: nor the tag, so an image a user already built is reused, not rebuilt.
    expect(imageTagFor(RECIPE, TARBALL)).toBe(BEFORE_CA_TAG);
  });

  it("leave the egress probe URL out of the tag", () => {
    const probed = { ...RECIPE, egressProbe: "https://api.example.test" };
    // Guards: the probe is not an image input, so declaring one does not rebuild the image.
    expect(imageTagFor(probed, TARBALL)).toBe(BEFORE_CA_TAG);
  });
});

describe("dockerfileFor / imageTagFor with a host CA", () => {
  const lines = dockerfileFor(RECIPE, CA).split("\n");
  const firstNpm = lines.findIndex((l) => l.includes('"npm"'));
  const firstNetwork = lines.findIndex((l) => l.includes("apt-get update"));

  it("trust the CA in node before any step reaches the network", () => {
    const env = lines.indexOf(`ENV NODE_EXTRA_CA_CERTS=${HOST_CA_IN_IMAGE}`);
    // Guards: node (so npm, and every run in the image) trusts the copied CA.
    expect(env).toBeGreaterThan(0);
    // Guards: before the npm installs and the apt step, which a decrypting proxy would break.
    expect(env).toBeLessThan(firstNpm);
    expect(env).toBeLessThan(firstNetwork);
    // Guards: the file it names is copied in before it is named.
    expect(lines.indexOf(`COPY host-ca.crt ${HOST_CA_IN_IMAGE}`)).toBe(env - 1);
  });

  it("add the CA to the system store before the npm installs", () => {
    const system = lines.findIndex((l) => l.endsWith("update-ca-certificates"));
    // Guards: git and other non-node tools in the image trust it too.
    expect(system).toBeGreaterThan(0);
    expect(system).toBeLessThan(firstNpm);
  });

  it("put the CA's bytes in the tag", () => {
    const other = Buffer.from(`${CA.toString()}\n`);
    // Guards: trusting a CA is a different image from trusting none.
    expect(imageTagFor(RECIPE, TARBALL, CA)).not.toBe(BEFORE_CA_TAG);
    // Guards: a different CA is a different image, never a stale reuse.
    expect(imageTagFor(RECIPE, TARBALL, other)).not.toBe(
      imageTagFor(RECIPE, TARBALL, CA),
    );
    // Guards: the same CA is the same image.
    expect(imageTagFor(RECIPE, TARBALL, Buffer.from(CA))).toBe(
      imageTagFor(RECIPE, TARBALL, CA),
    );
  });
});

describe("hostCaOf", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = makeTmpDir("host-ca");
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    dirs.splice(0).forEach(cleanupTmpDir);
  });

  it("reads the file NODE_EXTRA_CA_CERTS names", () => {
    const file = join(tmp(), "ca.crt");
    writeFileSync(file, CA);
    // Guards: the bytes of that file are what the build copies in.
    expect(hostCaOf({ NODE_EXTRA_CA_CERTS: file })).toEqual(CA);
  });

  it("is undefined without the variable or a readable file", () => {
    // Guards: no variable, no CA step (the byte-identical path).
    expect(hostCaOf({})).toBeUndefined();
    expect(hostCaOf({ NODE_EXTRA_CA_CERTS: "" })).toBeUndefined();
    // Guards: a path that names nothing is no CA, not a crash.
    const missing = join(tmp(), "missing.crt");
    expect(hostCaOf({ NODE_EXTRA_CA_CERTS: missing })).toBeUndefined();
  });

  it("reads no other variable", () => {
    const file = join(tmp(), "ca.crt");
    writeFileSync(file, CA);
    // Guards: a CA-looking path under any other name never reaches the build.
    expect(
      hostCaOf({ SSL_CERT_FILE: file, CURL_CA_BUNDLE: file }),
    ).toBeUndefined();
  });
});
