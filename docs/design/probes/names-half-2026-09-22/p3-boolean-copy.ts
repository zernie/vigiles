// P3 — the round-2 doc's `AdoptabilityPorts` / `SkillFiringPorts`: show that the
// flag is a FREE CHOICE the type cannot relate to the ports that make it true,
// i.e. a second copy of a fact (the A-class defect), not a capability.
interface EvalDriver { readonly runner: (task: string) => Promise<string> }
type TestingPorts =
  | { readonly harnessTesting: true; readonly evalDriver: EvalDriver }
  | { readonly harnessTesting: false; readonly evalDriver?: never };
type AdoptabilityPorts =
  | { readonly adoptability: true; readonly adoptabilityDrafter: () => Promise<(c: string) => Promise<string[]>> }
  | { readonly adoptability: false; readonly adoptabilityDrafter?: never };
type Adapter = { readonly name: string } & TestingPorts & AdoptabilityPorts;

// A Codex-shaped adapter: it HAS the eval driver the drafter is built from,
// and declares adoptability false anyway. The type accepts it — nothing relates
// the two arms, so the flag encodes "nobody wired it", which is a TODO wearing
// a capability's coat:
const codexLike = { name: "codex", harnessTesting: true, evalDriver: { runner: async () => "" }, adoptability: false } as const satisfies Adapter;
// And the converse — adoptability true on an adapter with NO way to reach a model:
const nonsense = { name: "z", harnessTesting: false, adoptability: true, adoptabilityDrafter: async () => async () => [] } as const satisfies Adapter;
export { codexLike, nonsense };
