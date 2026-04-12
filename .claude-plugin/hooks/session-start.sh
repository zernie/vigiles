#!/usr/bin/env bash
# SessionStart hook — inject a one-line vigiles audit summary into
# Claude's context at session start and after compaction.
#
# Uses `vigiles audit --summary` which is designed for this: it
# silences all per-stage output and prints a single line like
#   vigiles: 3 stale / 2 validation errors / 1 duplicate
# (or "vigiles: clean") so the injection costs a handful of tokens.
#
# Hook runs on the `startup` and `compact` matchers — the latter is
# effectively free on token budget because it fires every time
# context is compacted, so the agent re-notices drift without any
# manual command.

set -euo pipefail

# Only run in projects that actually use vigiles — otherwise stay silent.
if [ ! -f "package.json" ]; then
  exit 0
fi
if ! grep -q '"vigiles"' package.json 2>/dev/null; then
  exit 0
fi

# Prefer local install, fall back to npx.
if command -v npx &>/dev/null; then
  SUMMARY=$(npx --no-install vigiles audit --summary 2>/dev/null || true)
else
  exit 0
fi

if [ -z "$SUMMARY" ]; then
  exit 0
fi

# Inject the summary line as hook output. Claude Code prepends hook
# stdout to the session context for SessionStart hooks.
echo "$SUMMARY"
