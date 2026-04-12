# Agent Setup Guide

How to set up vigiles when an AI agent is doing the installation (non-interactive).

## What an Agent Can Do

| Action                    | Agent can do it? | How                                         |
| ------------------------- | ---------------- | ------------------------------------------- |
| Create spec file          | Yes              | `npx vigiles init` (non-interactive wizard) |
| Generate types            | Yes              | `npx vigiles generate-types`                |
| Compile specs             | Yes              | `npx vigiles compile`                       |
| Add CI step               | Yes              | Edit `.github/workflows/*.yml` directly     |
| Install hooks             | Yes              | Write to `.claude/settings.json` directly   |
| Install plugin via skills | **No**           | Requires user to run `npx skills add`       |

The `skills add` command requires user action — an agent can't install plugins for itself. But it CAN write the hook configuration directly to `.claude/settings.json`, which achieves the same result.

## Non-Interactive Setup

### Step 1: Run the wizard

```bash
npx vigiles init
```

This works non-interactively. It auto-detects the project, creates a spec, generates types, compiles, and adds a CI step. No prompts.

### Step 2: Install hooks directly

Instead of `npx skills add zernie/vigiles`, the agent can write the hooks to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "FILE=$(cat | jq -r '.tool_input.file_path // empty') && case \"$FILE\" in *.md) [ -f \"$FILE\" ] && head -1 \"$FILE\" | grep -q 'vigiles:sha256:' && { echo \"BLOCKED: Edit the .spec.ts source instead.\" >&2; exit 2; } ;; esac; exit 0"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "FILE=$(cat | jq -r '.tool_input.file_path // empty') && case \"$(basename \"$FILE\")\" in eslint.config.*|.eslintrc*|package.json|pyproject.toml|Cargo.toml) npx vigiles generate-types 2>&1 || true ;; esac && case \"$FILE\" in *.spec.ts) npx vigiles compile 2>&1 || true ;; esac"
      }
    ]
  }
}
```

This is equivalent to what the plugin installs, but written directly without the skills system.

### Step 3: Edit the spec

The agent should read the generated `.spec.ts` file and fill in the project's actual conventions — sections, key files, commands, and rules. Use the `edit-spec` skill instructions as a guide for the spec format.

### Step 4: Compile and verify

```bash
npx vigiles compile
npx vigiles audit
```

## Recommended Agent Prompt

If you want an agent to set up vigiles in a project, use this prompt:

```
Set up vigiles for this project:
1. Run `npx vigiles init`
2. Read the generated .spec.ts file
3. Fill in the project's actual conventions based on the codebase
4. Add hooks to .claude/settings.json for auto-compilation
5. Run `npx vigiles compile` to verify everything works
6. Commit the .spec.ts, compiled .md, .vigiles/generated.d.ts, and settings changes
```

## What the Agent Gets Wrong

Common issues when agents set up vigiles:

- **Editing CLAUDE.md directly** — the PreToolUse hook prevents this if installed
- **Using wrong rule names** — `enforce("no-console")` instead of `enforce("eslint/no-console")`. The compiler catches this.
- **Forgetting to compile** — the PostToolUse hook handles this automatically
- **Adding headers inside sections** — the compiler catches `#`/`##` headers in section content
