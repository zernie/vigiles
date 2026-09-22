// P1 — the name ceiling: does an OBJECT identity (not a branded string) make
// `adapter.id === "codex"` a compile error, while `--harness=`, JSON and
// template strings keep working?
declare const brand: unique symbol;
class HarnessId {
  readonly [brand] = true as const;
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
  toJSON(): string { return this.value; }
}
interface Adapter { readonly id: HarnessId; readonly name: string }
declare const a: Adapter;

// (1) the natural spelling of a name-check against the OBJECT:
// @ts-expect-error TS2367 — no overlap between HarnessId and "codex"
if (a.id === "codex") {}
// (2) but the string still exists one member deeper, and this compiles:
if (a.id.value === "codex") {}
// (3) the boundary uses the string exactly as before:
const flag: string = String(a.id);
const json = JSON.stringify({ harness: a.id });
const msg = `Detected harness: ${a.id}`;
// (4) a registry lookup, the ONE sanctioned comparison, still types:
declare const ADAPTERS: readonly Adapter[];
const found = ADAPTERS.find((x) => x.id.value === flag);
// (5) and today's `name: string` on the same object is comparable, as round 2 §5 measured:
if (a.name === "codex") {}
export { flag, json, msg, found };
