#!/usr/bin/env bash
# Re-run the vendor observations behind `supersederOf` and the pass order in
# `src/adapters/claude-code/instruction-chain.ts`. See README.md for the table
# these produce and for what each case is FOR.
#
# One case, or all of them:  ./measure.sh [c0 c1 c1-probe c2 c3 q2-import]
#
# Each case is copied to a scratch directory (the run writes a log and Claude
# Code writes state; the fixture stays pristine), an `InstructionsLoaded` hook
# is merged into its settings, and one non-interactive turn is taken. The hook
# payload is the evidence: `file_path` + `load_reason`, one line per file the
# harness actually loaded.
#
# 🔴 THE DIRECTORY NAME IS LOAD-BEARING FOR c3. Its exclusion pattern is
# `**/c3/CLAUDE.md`, because the vendor matches these globs against ABSOLUTE
# paths — so the copy keeps the case's own basename. Renaming the fixture
# directory silently turns that case into c0.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${TMPDIR:-/tmp}/instruction-chain-vendor-$$"
trap 'rm -rf "$work"' EXIT

echo "claude: $(claude --version 2>&1 || echo '(not found — this script needs the vendor CLI)')"

cases=("$@")
if [ ${#cases[@]} -eq 0 ]; then cases=(c0 c1 c1-probe c2 c3 q2-import); fi
for case_name in "${cases[@]}"; do
  src="$here/$case_name"
  [ -d "$src" ] || { echo "no such case: $case_name" >&2; exit 2; }
  dst="$work/$case_name"
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
  log="$work/$case_name.log"

  # Merge the hook in rather than overwrite: c1 and c3 carry `claudeMdExcludes`,
  # which IS the thing under test.
  mkdir -p "$dst/.claude"
  python3 - "$dst/.claude/settings.json" "$log" <<'PY'
import json, os, sys
path, log = sys.argv[1], sys.argv[2]
settings = json.load(open(path)) if os.path.exists(path) else {}
settings.setdefault("hooks", {})["InstructionsLoaded"] = [
    {"hooks": [{"type": "command", "command": f"cat >> {log}; echo >> {log}"}]}
]
json.dump(settings, open(path, "w"), indent=2)
PY

  echo
  echo "===== $case_name"
  sed -n '1,40p' "$dst/.claude/settings.json" | grep -v InstructionsLoaded | head -5
  (cd "$dst" && claude -p 'Reply with the single word OK.' </dev/null >/dev/null 2>&1) || true

  # THE SECOND INSTRUMENT, AND IT IS NOT A BELT-AND-BRACES. The hook above is
  # BLIND TO `AGENTS.md` — measured, case c2: a repository holding ONLY an
  # `AGENTS.md` produces no `InstructionsLoaded` payload at all. So on the file
  # this whole fixture set is about, hook silence carries no information, and a
  # verdict read off it would be a finding about the instrument.
  #
  # The canary asks the model to recite a codeword that exists ONLY inside the
  # fixture files, with tools denied so it cannot go and read one. Its own hole
  # is the mirror image — a model may answer from the turn's own prompt echo or
  # refuse — which is why c0 is run as the control: ALPHA is known to load, so
  # a run where c0 cannot recite ALPHA proves nothing about any other case.
  ans=$(cd "$dst" && claude --disallowedTools Read,Glob,Grep,Bash -p \
        'Recite every codeword you were given in your instructions, as bare words. If you were given none, reply NONE.' </dev/null 2>&1 || true)
  for word in KESTREL-4401 ZARAFSHAN-7714 MARMOT-9090 OSPREY-2211 LYNX-3030 PIKA-5150; do
    case "$ans" in *"$word"*) echo "  CANARY  $word recited" ;; esac
  done
  echo "  canary raw: $(echo "$ans" | tr '\n' ' ' | cut -c1-160)"

  if [ ! -s "$log" ]; then
    echo "  (hook logged nothing — see c2: it is BLIND to AGENTS.md, so this is not a verdict)"
    continue
  fi
  python3 - "$log" "$dst" <<'PY'
import json, os, sys
log, root = sys.argv[1], sys.argv[2]
seen = set()
for line in open(log):
    line = line.strip()
    if not line or line in seen:
        continue
    seen.add(line)
    try:
        o = json.loads(line)
    except ValueError:
        continue
    rel = os.path.relpath(o.get("file_path", "?"), root)
    parent = o.get("parent_file_path")
    tail = f"  (parent: {os.path.relpath(parent, root)})" if parent else ""
    print(f"  LOADED  {rel:<24} reason={o.get('load_reason','?')}{tail}")
PY
done
