#!/usr/bin/env bash
# PreToolUse hook — redirect edits from compiled files to their specs.
#
# If a file has a vigiles hash comment, it's a build artifact.
# Exit 2 = block the tool call in Claude Code.
# The message tells the agent exactly what to do instead.

set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$FILE" ]; then
  exit 0
fi

# Only check .md files
case "$FILE" in
  *.md) ;;
  *) exit 0 ;;
esac

# Check if the file exists and has a vigiles hash
if [ -f "$FILE" ] && head -1 "$FILE" | grep -q "<!-- vigiles:sha256:"; then
  SPEC=$(head -1 "$FILE" | sed -n 's/.*compiled from \(.*\) -->/\1/p')
  SPEC_FILE="${SPEC:-$(basename "$FILE").spec.ts}"

  cat >&2 <<MSG
BLOCKED: ${FILE} is a compiled build artifact — do not edit it directly.

Instead:
1. Read ${SPEC_FILE} to understand the spec structure
2. Edit ${SPEC_FILE} to make your changes (add/modify rules, sections, keyFiles, commands)
3. Run: npx vigiles compile
4. The compiled ${FILE} will be regenerated automatically

Use the edit-spec skill if you need guidance on the spec format.
MSG
  exit 2
fi
