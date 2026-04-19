# Architecture-Aware Agent Platform

## Vision

vigiles today is a spec linter — it compiles `.spec.ts` to markdown and cross-references linter rules. The vision: vigiles becomes a platform where project architecture, AI agent setup, skills, rules, and hooks form a validated, composable system. Ready-made presets for popular architectures (FSD, DDD, hexagonal, clean architecture) give teams everything at once.

The current tool becomes one piece of a larger toolkit:

| Package                   | What it does                                                     |
| ------------------------- | ---------------------------------------------------------------- |
| `vigiles` (core)          | Spec compiler + linter cross-referencing (exists today)          |
| `@vigiles/arch-fsd`       | FSD architecture preset: rules, skills, keyFiles template, hooks |
| `@vigiles/arch-ddd`       | DDD architecture preset                                          |
| `@vigiles/arch-hexagonal` | Hexagonal architecture preset                                    |
| `@vigiles/test`           | Skill testing, setup validation, meta-checks                     |
| `@vigiles/meta`           | Validates the whole setup works together                         |

## The Core Idea: Architecture as Configuration

Today architecture enforcement is fragmented:

- Layer boundaries → eslint-plugin-boundaries or dependency-cruiser
- File structure → steiger (FSD-specific) or custom scripts
- Import rules → eslint-plugin-import or oxlint
- Naming conventions → eslint rules or ast-grep patterns
- AI agent instructions → hand-written CLAUDE.md

These tools don't know about each other. You configure them separately, maintain them separately, and they can contradict. A spec that says "follow FSD" but doesn't enforce FSD layer boundaries via dependency-cruiser is a lie.

vigiles already bridges linter configs and agent instructions. Extending this to architecture enforcement is natural: the spec declares the architecture, vigiles generates and validates all the enforcement tooling.

```typescript
// CLAUDE.md.spec.ts
import { fsd } from "@vigiles/arch-fsd";

export default claude({
  architecture: fsd({
    layers: ["app", "pages", "widgets", "features", "entities", "shared"],
    strictImports: true,
    sliceIsolation: true,
  }),
  rules: {
    // Architecture rules are auto-generated from the preset
    ...fsd.rules(),
    // Project-specific rules layer on top
    "no-floating-promises": enforce(
      "@typescript-eslint/no-floating-promises",
      "Always await.",
    ),
  },
  keyFiles: {
    // Preset provides the standard FSD structure, you add project-specific files
    ...fsd.keyFiles(),
    "src/shared/api/client.ts": "API client — shared layer",
  },
  commands: fsd.commands(),
});
```

## What an Architecture Preset Contains

Each preset is a package that exports:

### 1. Architecture rules → `enforce()` mappings

```typescript
// @vigiles/arch-fsd/rules.ts
export function rules(): Record<string, Rule> {
  return {
    "fsd-layer-imports": enforce(
      "boundaries/element-types",
      "FSD layers can only import from layers below them",
    ),
    "fsd-slice-isolation": enforce(
      "boundaries/no-private",
      "Slices cannot import from other slices in the same layer",
    ),
    "fsd-public-api": enforce(
      "import/no-internal-modules",
      "Import from slice public API (index.ts), not internal files",
    ),
    "fsd-no-cross-feature": enforce(
      "boundaries/no-unknown",
      "Features cannot depend on other features",
    ),
  };
}
```

These are `enforce()` rules that reference real linter rules from eslint-plugin-boundaries, dependency-cruiser, or steiger. vigiles verifies at compile time that the rules exist AND are enabled. The preset doesn't replace the linter — it ensures the linter is configured to match the declared architecture.

### 2. Key files → architecture-aware file map

```typescript
// @vigiles/arch-fsd/keyFiles.ts
export function keyFiles(): Record<string, string> {
  return {
    "src/app/": "App layer — providers, routing, global styles",
    "src/pages/": "Pages layer — route-level components",
    "src/widgets/": "Widgets layer — composed UI blocks",
    "src/features/": "Features layer — user interactions",
    "src/entities/": "Entities layer — business objects",
    "src/shared/": "Shared layer — reusable utilities, UI kit, API client",
  };
}
```

### 3. Skills → architecture-aware agent workflows

```typescript
// @vigiles/arch-fsd/skills/create-feature/SKILL.md
// A skill that creates a new FSD feature slice with the correct structure:
// src/features/<name>/
//   index.ts       (public API)
//   model/         (state, effects)
//   ui/            (components)
//   api/           (data fetching)
//   lib/           (utilities)
```

Skills know the architecture. "Create a feature" in an FSD project means creating a slice with the right internal structure. In a DDD project it means creating an aggregate root with repository and service. The skill is architecture-specific.

### 4. Hooks → architecture-aware enforcement

```typescript
// @vigiles/arch-fsd/hooks.ts
export function hooks() {
  return {
    PreToolUse: [
      {
        matcher: "Write|Edit",
        // Block writes that violate FSD layer structure
        // e.g., creating a file in src/features/ that imports from src/pages/
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        // After agent creates a file, verify it follows the slice structure
      },
    ],
  };
}
```

### 5. Linter config generation → `vigiles init --arch fsd` bootstraps the linter config

```typescript
// When the user runs `vigiles init --arch fsd`, generate:
// - eslint-plugin-boundaries config (if ESLint project)
// - dependency-cruiser config (if using dependency-cruiser)
// - steiger config (if FSD-native tooling)
// - .vigilesrc.json with architecture preset reference
```

## Architecture Validation (meta-check)

Beyond checking individual rules, vigiles validates that the architecture declaration matches reality:

### Structure validation

```
vigiles audit --arch

Architecture: FSD (Feature-Sliced Design)
  ✓ src/app/ exists
  ✓ src/pages/ exists
  ✓ src/widgets/ exists
  ✓ src/features/ exists
  ✓ src/entities/ exists
  ✓ src/shared/ exists
  ✗ src/components/ exists — not an FSD layer (migrate to widgets/ or shared/ui/)
  ✗ src/utils/ exists — not an FSD layer (migrate to shared/lib/)

Layer boundaries:
  ✓ eslint-plugin-boundaries installed and configured
  ✓ 4 FSD rules enabled in eslint config
  ✗ "fsd-slice-isolation" rule is disabled — enable it or remove from spec

Slice structure:
  ✓ 12 features have public API (index.ts)
  ✗ 3 features missing public API: auth, checkout, notifications
```

This is deterministic — filesystem checks, linter config parsing, structure validation. vigiles already does this for linter rules; extending to architecture patterns is the same machinery applied to a higher-level concern.

### AI setup validation (meta-meta-check)

```
vigiles audit --setup

AI Agent Setup:
  ✓ CLAUDE.md exists and is compiled from spec
  ✓ Spec declares FSD architecture
  ✓ Architecture rules are enforced (4/4 enabled)
  ✓ Skills installed: create-feature, create-entity, migrate-to-fsd
  ✓ Hooks installed: compiled output protection, FSD structure validation
  ✗ Missing hook: PostToolUse linter check (run `vigiles compile --hooks` to generate)

Completeness:
  ✓ keyFiles covers 6/6 FSD layers
  ✗ keyFiles missing 3 feature slices (auth, checkout, notifications)
  ✓ Commands cover build, test, lint
  ✗ No deployment command documented

Freshness:
  ✓ Spec compiled within last commit
  ✓ Types generated within last commit
  ✗ eslint.config.mjs changed since last compile — run `vigiles compile`
```

This validates the ENTIRE setup: spec, architecture, skills, hooks, freshness. One command tells you if your AI agent is set up correctly for your project's architecture.

## Preset Lifecycle: Install → Customize → Eject

### Install

```bash
npx vigiles init --arch fsd
```

Creates a spec with the FSD preset, installs dependencies (eslint-plugin-boundaries), generates types, compiles. Zero config.

### Customize

Override specific rules or add project-specific ones:

```typescript
import { fsd } from "@vigiles/arch-fsd";

export default claude({
  architecture: fsd({
    layers: ["app", "processes", "pages", "features", "entities", "shared"],
    // Added "processes" layer — non-standard FSD extension
    customLayers: {
      processes: { allowImportFrom: ["features", "entities", "shared"] },
    },
  }),
  rules: {
    ...fsd.rules(),
    // Override: allow cross-feature imports in the "processes" layer
    "process-cross-feature": guidance(
      "Processes may orchestrate multiple features.",
    ),
  },
});
```

### Eject

```bash
npx vigiles eject
```

Copies the preset's rules, skills, hooks, and config into the project directly. The preset becomes regular project files. No more dependency on the preset package. Like `create-react-app eject` — full control, no abstraction.

## Architecture Presets to Build

| Architecture                 | Enforcement tool                             | Maturity | Notes                                |
| ---------------------------- | -------------------------------------------- | -------- | ------------------------------------ |
| FSD (Feature-Sliced Design)  | steiger, eslint-plugin-boundaries            | High     | Most structured, easiest to validate |
| DDD (Domain-Driven Design)   | dependency-cruiser, custom rules             | Medium   | Aggregate roots, bounded contexts    |
| Hexagonal / Ports & Adapters | dependency-cruiser                           | Medium   | Core/adapter boundary enforcement    |
| Clean Architecture           | dependency-cruiser, eslint-plugin-boundaries | Medium   | Layer rings, dependency rule         |
| Modular monolith             | eslint-plugin-boundaries                     | Medium   | Module boundaries, public APIs       |
| Monorepo (Nx/Turborepo)      | nx enforce-module-boundaries                 | High     | Package boundaries, dep graph        |

FSD is the best starting point: most structured, active community (steiger exists), clear layer rules, and popular in the React/Vue ecosystem. DDD second — broader audience but harder to enforce mechanically (aggregate boundaries are design decisions, not file structure).

## What This Means for the Product

### Before (vigiles as a linter)

```
User writes CLAUDE.md.spec.ts → vigiles compiles → CLAUDE.md
                                  vigiles audits → "hash OK, 2 rules enforced"
```

### After (vigiles as an architecture-aware agent platform)

```
User runs `vigiles init --arch fsd`
  → Spec with FSD architecture declaration
  → Linter config for FSD boundaries
  → Skills for creating FSD slices
  → Hooks for runtime FSD enforcement
  → Meta-validation of the whole setup

User writes code (or agent writes code)
  → Hooks enforce FSD layer boundaries in real time
  → Skills create features with correct structure
  → Compile time: linter rules verified against architecture
  → Audit time: architecture matches filesystem, setup is complete
  → Session end: agent behavior cross-referenced against architecture
```

The spec is no longer just "instructions for the agent." It's a **complete, validated, enforceable architecture declaration** that the agent, the linter, the hooks, and CI all enforce together.

## Implementation Strategy

### Phase 1: Architecture field in specs (no presets yet)

Add an `architecture` field to `ClaudeSpec`:

```typescript
interface ClaudeSpec {
  architecture?: {
    name: string;
    layers?: string[];
    rules?: Record<string, Rule>;
    keyFiles?: Record<string, string>;
  };
  // ... existing fields
}
```

Compile-time: merge architecture rules/keyFiles with spec-level ones. Audit-time: validate filesystem matches declared layers. This is just data — no preset packages needed.

### Phase 2: First preset (`@vigiles/arch-fsd`)

Extract the FSD-specific logic into a package. Publish. Users install it alongside vigiles. The preset is a function that returns architecture config.

### Phase 3: Meta-validation (`vigiles audit --setup`)

Cross-check everything: spec exists, architecture declared, linter rules enabled, skills installed, hooks configured, freshness OK. One command, one report, complete picture.

### Phase 4: More presets + eject

DDD, hexagonal, clean architecture, monorepo presets. Each with architecture-specific skills, rules, and hooks. Eject support for full customization.

## Open Questions

1. **Should presets be npm packages or built into vigiles?** Recommendation: npm packages. Keeps core small. Each architecture community can maintain their own preset.
2. **How opinionated should presets be?** They should enforce structure (layers, boundaries) but not style (tabs vs spaces, naming conventions). Structure is architecture; style is the linter's job.
3. **How to handle architecture migrations?** A "migrate-to-fsd" skill that gradually restructures a project. This is ambitious but high-value for adoption.
4. **Should vigiles generate linter configs or just validate them?** Both. `vigiles init --arch fsd` generates a starter config. `vigiles audit --arch` validates the config matches the architecture. Generation is for setup, validation is for maintenance.
5. **Relationship to steiger?** steiger is FSD-specific. vigiles is architecture-agnostic. The FSD preset wraps steiger's rules via `enforce()`. If steiger covers everything, the preset is thin. If it doesn't, the preset adds rules via eslint-plugin-boundaries or dependency-cruiser.
6. **Does architecture validation belong in vigiles or in a separate tool?** vigiles already validates linter configs (6 linters). Architecture enforcement is just more linter configs (dependency-cruiser, eslint-plugin-boundaries). Same machinery, higher abstraction.
