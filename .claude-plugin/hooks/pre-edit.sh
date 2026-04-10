#!/usr/bin/env bash
# PreToolUse hook — block edits to compiled instruction files.
#
# If a file has a vigiles hash comment, it's a build artifact.
# The agent should edit the .spec.ts source instead.
# Exit 2 = block the tool call in Claude Code.

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
  echo "This file is a compiled build artifact. Edit ${SPEC:-the .spec.ts file} instead." >&2
  exit 2
fi
