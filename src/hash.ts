import { createHash } from "node:crypto";

const HASH_LENGTH = 16;

declare const __brand: unique symbol;
export type SHA256Hash = string & { readonly [__brand]: "SHA256Hash" };

export function sha256short(data: string | Buffer): SHA256Hash {
  return createHash("sha256")
    .update(data)
    .digest("hex")
    .slice(0, HASH_LENGTH) as SHA256Hash;
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}
