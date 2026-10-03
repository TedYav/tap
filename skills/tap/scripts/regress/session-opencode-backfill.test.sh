#!/usr/bin/env bash
# session-opencode-backfill.test.sh — CLI-discovered candidates and derived
# fields never become exact OpenCode resume authority.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export TAP_INDEX_HOME="$WORK/index"
REPO="$WORK/repo"
BUS="$REPO/.tap/bus"
ACTING="$REPO/.tap/team-registry.json"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/bin"
git -C "$REPO" init -q
SID="ses_captured"
cat >"$WORK/bin/opencode" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = session ] && [ "\${2:-}" = list ]; then
  printf '[{"id":"$SID","directory":"$REPO","created":1785658666000}]\n'
  exit 0
fi
exit 1
SH
chmod +x "$WORK/bin/opencode"
export PATH="$WORK/bin:$PATH"
cat >"$ACTING" <<JSON
{"schema": "0.20", "team":{"name":"repo","worktree_root":"$REPO"},"seats":{"glm":{"status":"suspended","status_reason":"session_stopped","delivery":"pane","session":"repo/glm","harness":"opencode","cwd":"$REPO","base":"repo","tag":"glm","index":1,"last_launched":"2026-07-10T00:17:45Z","derived_harness_session_id":"$SID"}}}
JSON
printf '{"schema": "0.20", "team":{"name":"repo","worktree_root":"%s"},"seats":{}}\n' "$REPO" >"$BUS/registry.json"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$REPO" "$ACTING" <<'PY'
import json, os, sys
path, root, acting = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({"schema":"0.20","migrated":{"at":"2026-08-04T00:00:00Z","backups":{}},
           "teams":{"repo":{"root":root,"registry_location":acting,"state":"registered"}}}, open(path,"w"), indent=2)
PY

before="$(cksum "$ACTING")"
list_json="$(cd "$REPO" && "$TAP" session list --json)"
printf '%s' "$list_json" | python3 -c '
import json, sys
row = next(r for r in json.load(sys.stdin)["sessions"] if r["name"] == "repo/glm")
assert row["revive"] == "fresh", row
' || { echo "session-opencode-backfill: list did not report fresh revive" >&2; echo "$list_json" >&2; exit 1; }
set +e
(cd "$REPO" && "$TAP" session resume glm --dry-run --json) >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "session-opencode-backfill: id-less resume exited $rc" >&2; cat "$WORK/err" >&2; exit 1; }
python3 -B - "$WORK/out" "$WORK/err" "$SID" <<'PY'
import json, sys
out, err, derived = open(sys.argv[1]).read(), open(sys.argv[2]).read(), sys.argv[3]
plan = json.loads(out.strip())
assert plan["argv"] == ["opencode"], plan
assert err.count("starting a fresh conversation") == 1, err
assert derived not in out and derived not in err, (out, err)
PY
[ "$before" = "$(cksum "$ACTING")" ] || { echo "session-opencode-backfill: list/resume wrote derived identity" >&2; exit 1; }

echo "session-opencode-backfill: CLI candidate ignored; id-less resume stayed fresh without writes: ok"
