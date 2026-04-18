import { createHash } from "node:crypto";

const HASH_LENGTH = 16;

export function sha256short(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, HASH_LENGTH);
}
