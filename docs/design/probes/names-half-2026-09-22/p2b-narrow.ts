// P2b — nested-discriminant narrowing does NOT narrow the parent; a type guard does.
type SkillFiringSignal = { readonly kind: "event" } | { readonly kind: "inferred"; readonly caveat: string };
interface HarnessLiveDriver { readonly firing: SkillFiringSignal }
type EventFiringDriver = HarnessLiveDriver & { readonly firing: { readonly kind: "event" } };
declare function measureSelection(d: EventFiringDriver): void;
declare const live: HarnessLiveDriver;
// @ts-expect-error TS2345 — `live.firing.kind === "event"` narrows `live.firing`, not `live`
if (live.firing.kind === "event") measureSelection(live);
// the guard is the construction that narrows the driver itself:
function isEventFiring(d: HarnessLiveDriver): d is EventFiringDriver { return d.firing.kind === "event"; }
if (isEventFiring(live)) measureSelection(live);
// and the negative arm still carries the caveat for the n/a note:
if (!isEventFiring(live)) { const c: string = live.firing.kind === "inferred" ? live.firing.caveat : ""; void c; }
export {};
