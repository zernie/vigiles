#!/usr/bin/env bash
# PostToolUse hook — keep generated types and compiled specs fresh.
#
# Reads stdin JSON from Claude Code to determine which file was edited,
# then conditionally runs generate-types or compile.

set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$FILE" ]; then
  exit 0
fi

BASENAME=$(basename "$FILE")

# Linter config or package.json changed → regenerate types
case "$BASENAME" in
  eslint.config.*|.eslintrc*|.stylelintrc*|.rubocop.yml|pyproject.toml|Cargo.toml|package.json)
    if command -v npx &>/dev/null && [ -f "package.json" ]; then
      npx vigiles generate-types 2>&1 || true
    fi
    ;;
esac

# Spec file changed → recompile
case "$FILE" in
  *.spec.ts)
    if command -v npx &>/dev/null && [ -f "package.json" ]; then
      npx vigiles compile 2>&1 || true
    fi
    ;;
esac
