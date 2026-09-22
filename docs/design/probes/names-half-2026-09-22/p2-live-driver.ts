// P2 — the proposed shape: `liveDriver` in the `harnessTesting: true` arm (no
// new discriminant), and `firing` as a tagged union whose "event" arm is the
// only thing selection-collision will accept.
type SkillFiringSignal =
  | { readonly kind: "event" }
  | { readonly kind: "inferred"; readonly caveat: string };
type ModelAccess =
  | { readonly kind: "none"; readonly fix: string }
  | { readonly kind: "subscription" }
  | { readonly kind: "metered" };
interface HarnessLiveDriver {
  readonly firing: SkillFiringSignal;
  access(env: Readonly<Record<string, string | undefined>>): ModelAccess;
}
type EventFiringDriver = HarnessLiveDriver & { readonly firing: { readonly kind: "event" } };

interface Base { readonly name: string }
type TestingPorts =
  | { readonly harnessTesting: true; readonly runtime: object; readonly liveDriver: () => Promise<HarnessLiveDriver> }
  | { readonly harnessTesting: false; readonly runtime?: never; readonly liveDriver?: never };
type HarnessAdapter = Base & TestingPorts;

// (1) a testable adapter MUST carry liveDriver — the opencode-class defect is unwritable:
// @ts-expect-error TS2322 — harnessTesting true, no liveDriver
const missing = { name: "x", harnessTesting: true, runtime: {} } as const satisfies HarnessAdapter;
// (2) an untestable adapter MUST NOT carry one:
// @ts-expect-error TS2322 — liveDriver beside harnessTesting false
const extra = { name: "y", harnessTesting: false, liveDriver: async () => ({} as HarnessLiveDriver) } as const satisfies HarnessAdapter;
// (3) both legal shapes pass and narrow without a cast:
const cc = { name: "claude-code", harnessTesting: true, runtime: {}, liveDriver: async () => ({ firing: { kind: "event" }, access: () => ({ kind: "subscription" }) } as HarnessLiveDriver) } as const satisfies HarnessAdapter;
const oc = { name: "opencode", harnessTesting: false } as const satisfies HarnessAdapter;
declare const any: HarnessAdapter;
async function use(): Promise<void> {
  if (any.harnessTesting) { const d = await any.liveDriver(); void d.firing; }
}
// (4) selection-collision takes ONLY an event-firing driver:
declare function measureSelection(d: EventFiringDriver): void;
declare const live: HarnessLiveDriver;
// @ts-expect-error TS2345 — an inferred-firing driver is refused at compile time
measureSelection(live);
if (live.firing.kind === "event") measureSelection(live); // narrows, no cast
export { missing, extra, cc, oc, use };
