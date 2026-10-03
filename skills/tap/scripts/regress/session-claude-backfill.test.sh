#!/usr/bin/env bash
# session-claude-backfill.test.sh — transcript candidates and derived fields do
# not become current identity. List is read-only and id-less resume uses Claude's picker.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export TAP_INDEX_HOME="$WORK/index"
export TAP_CLAUDE_HOME="$WORK/claude-home"
REPO="$WORK/repo"
BUS="$REPO/.tap/bus"
ACTING="$REPO/.tap/team-registry.json"
mkdir -p "$BUS/payloads" "$BUS/receipts"
git -C "$REPO" init -q
SID="aaaaaaaa-1111-4222-8333-444444444444"
SLUG="$(REPO="$REPO" python3 -c 'import os,re; print(re.sub(r"[^A-Za-z0-9]","-",os.environ["REPO"]))')"
mkdir -p "$TAP_CLAUDE_HOME/projects/$SLUG"
printf '{"type":"attachment","sessionId":"%s","cwd":"%s","timestamp":"2026-07-10T00:17:46.000Z"}\n' "$SID" "$REPO" >"$TAP_CLAUDE_HOME/projects/$SLUG/$SID.jsonl"
cat >"$ACTING" <<JSON
{"schema": "0.20", "team":{"name":"repo","worktree_root":"$REPO"},"seats":{"opus":{"status":"suspended","status_reason":"session_stopped","delivery":"pane","session":"repo/opus","harness":"claude","cwd":"$REPO","base":"repo","tag":"opus","index":1,"last_launched":"2026-07-10T00:17:45Z","derived_harness_session_id":"$SID"}}}
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
row = next(r for r in json.load(sys.stdin)["sessions"] if r["name"] == "repo/opus")
assert row["revive"] == "picker", row
' || { echo "session-claude-backfill: list did not preserve picker tier" >&2; echo "$list_json" >&2; exit 1; }
resume_json="$(cd "$REPO" && "$TAP" session resume opus --dry-run --json)"
printf '%s' "$resume_json" | SID="$SID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
assert "--resume" in d["argv"], d
assert os.environ["SID"] not in d["argv"], d
' || { echo "session-claude-backfill: transcript candidate became resume identity" >&2; echo "$resume_json" >&2; exit 1; }
[ "$before" = "$(cksum "$ACTING")" ] || { echo "session-claude-backfill: list/resume wrote derived identity" >&2; exit 1; }

echo "session-claude-backfill: transcript candidate ignored; picker path is read-only: ok"
