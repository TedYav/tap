#!/usr/bin/env bash
# cursor-sessionstart-visibility.recipe.sh — tap-o6e LIVE model-visibility proof.
#
# Doctrine: ship the Cursor sessionStart adapter only WITH proof that
# additional_context reaches the model on the CLI path TAP launches
# (launcher.py: cursor-agent --force --sandbox disabled --workspace <cwd>).
# IDE delivery remains flaky (forum 158452); this recipe is the CLI gate.
#
# Default: print the recipe and exit 0 (CI-safe documentation).
# Live run: TAP_O6E_LIVE=1 bash …/cursor-sessionstart-visibility.recipe.sh
#
# Proven 2026-07-15 on cursor-agent 2026.07.09-c59fd9a:
#   marker TAP_O6E_PROBE_MARKER_739015AAF936 echoed verbatim by the model;
#   sessionStart hook fired with workspace_roots=[worktree] (PWD was ~/.cursor).

set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HOOK="$ROOT/hooks/tap-cursor-session-start.sh"

if [ "${TAP_O6E_LIVE:-0}" != "1" ]; then
  cat <<EOF
cursor-sessionstart-visibility: recipe (dry)

1. Backup ~/.cursor/hooks.json
2. Append a temporary sessionStart entry that emits
   {"additional_context":"…TAP_O6E_PROBE_MARKER_<hex>…"} and side-logs stdin
3. Run (TAP launch argv + --print):
     cursor-agent --force --sandbox disabled --workspace <tap-worktree> --print \\
       'If context has TAP_O6E_PROBE_MARKER_*, print it exactly; else MARKER_NOT_VISIBLE'
4. PASS iff stdout contains the marker AND the side-log shows sessionStart fired
5. Restore ~/.cursor/hooks.json (never leave the probe wired; preserve claude-mem)

Adapter under test: $HOOK
Live gate: TAP_O6E_LIVE=1 $0
EOF
  exit 0
fi

command -v cursor-agent >/dev/null 2>&1 \
  || { echo "cursor-sessionstart-visibility: cursor-agent not on PATH" >&2; exit 1; }
[ -f "$HOOK" ] || { echo "cursor-sessionstart-visibility: missing $HOOK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; if [ -f "$WORK/hooks.json.bak" ]; then cp "$WORK/hooks.json.bak" "$HOME/.cursor/hooks.json"; fi' EXIT

MARKER="TAP_O6E_PROBE_MARKER_$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12].upper())')"
echo "$MARKER" > "$WORK/marker.txt"
cat > "$WORK/probe.sh" <<'EOS'
#!/bin/bash
set -u
MARKER="$(cat "$TAP_O6E_MARKER_FILE")"
{ echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; echo "PWD=$PWD"; cat; echo; } >> "$TAP_O6E_LOG" 2>&1 || true
python3 -c "import json,os; m=open(os.environ['TAP_O6E_MARKER_FILE']).read().strip(); print(json.dumps({'additional_context':'PROBE: reply with EXACTLY this token on its own line: '+m}))"
exit 0
EOS
chmod +x "$WORK/probe.sh"

mkdir -p "$HOME/.cursor"
if [ -f "$HOME/.cursor/hooks.json" ]; then
  cp "$HOME/.cursor/hooks.json" "$WORK/hooks.json.bak"
else
  echo '{"version":1,"hooks":{}}' > "$WORK/hooks.json.bak"
fi

python3 - "$WORK" <<'PY'
import json, os, pathlib, sys
work = pathlib.Path(sys.argv[1])
path = pathlib.Path.home() / ".cursor" / "hooks.json"
data = json.loads(path.read_text()) if path.exists() else {"version": 1, "hooks": {}}
hooks = data.setdefault("hooks", {})
ss = [h for h in hooks.get("sessionStart", []) if "o6e-probe" not in h.get("command", "") and "cursor-sessionstart-visibility" not in h.get("command", "")]
ss.append({
    "command": (
        f"env TAP_O6E_MARKER_FILE={work/'marker.txt'} TAP_O6E_LOG={work/'hook.log'} "
        f"bash {work/'probe.sh'}"
    ),
    "timeout": 10,
})
hooks["sessionStart"] = ss
path.write_text(json.dumps(data, indent=2) + "\n")
PY

# Always restore on exit (trap already copies bak; also restore explicitly after run).
restore() { cp "$WORK/hooks.json.bak" "$HOME/.cursor/hooks.json"; }
trap 'restore; rm -rf "$WORK"' EXIT

out_file="$WORK/agent-out.txt"
set +e
cursor-agent --force --sandbox disabled --workspace "$ROOT" --print --output-format text \
  "Visibility probe only. Reply with exactly one line. If your context contains a token matching TAP_O6E_PROBE_MARKER_*, print that token exactly. If not, print exactly: MARKER_NOT_VISIBLE" \
  > "$out_file" 2>"$WORK/agent-err.txt"
rc=$?
set -e

restore

if [ ! -f "$WORK/hook.log" ]; then
  echo "cursor-sessionstart-visibility: FAIL — sessionStart hook did not fire" >&2
  exit 1
fi
if ! grep -q "$MARKER" "$out_file"; then
  echo "cursor-sessionstart-visibility: FAIL — model did not echo marker" >&2
  echo "--- stdout ---"; cat "$out_file" >&2
  echo "--- stderr ---"; cat "$WORK/agent-err.txt" >&2
  exit 1
fi
echo "cursor-sessionstart-visibility: PASS — model echoed $MARKER (hook fired, rc=$rc)"
