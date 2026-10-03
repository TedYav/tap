#!/usr/bin/env bash
# tap-7r3fn.75.1: retirement cannot substitute for an adoption instance grant.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
FIX="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FIX" "$FAKE_BIN"' EXIT
export PATH="$FAKE_BIN:$PATH"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  display-message) echo "" ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

(
FLIP="$FIX/flip"; FBUS="$FLIP/.tap/bus"
mkdir -p "$FBUS/payloads" "$FBUS/receipts"
export TAP_INDEX_HOME="$FIX/index-flip"; mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME" "$FLIP" <<'PY2'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = team / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
seat = {"status": "active", "delivery": "poll", "harness": "claude",
        "instance": "worker|current", "registered_at": "t"}
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "flip"},
                           "seats": {"worker": seat}}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "teams": {"flip": {"root": str(team), "registry_location": str(reg)}}}) + "\n")
(team / ".tap" / "bus" / "registry.json").write_text(json.dumps({
    "schema": "0.20", "team": {"name": "flip", "worktree_root": str(team)},
    "seats": {"worker": {"status": "active", "delivery": "poll",
                          "harness": "claude", "instance": "worker|current"}}}) + "\n")
PY2

ID_BOUND="fable-20260903T120008Z-888888888888"
{ printf '%s\n' '---' "id: $ID_BOUND" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $FBUS/payloads/$ID_BOUND.md" \
    'recipient_instance: worker|predecessor' '---' '' 'mail bound to a dead instance'; \
} > "$FBUS/payloads/$ID_BOUND.md"

python3 -B - "$FLIP/.tap/team-registry.json" "$FBUS/payloads/$ID_BOUND.md" <<'GRANT'
import json,pathlib,sys
reg,payload=map(pathlib.Path,sys.argv[1:])
d=json.loads(reg.read_text()); d['seats']['worker']['adopted_handles']=['fork']
d['seats']['worker']['adopted_instances']={'fork':'fork|different'}
reg.write_text(json.dumps(d))
payload.write_text(payload.read_text().replace('recipient_instance: worker|predecessor','recipient_instance: fork|old\nto_adopted_from: fork'))
GRANT
rc=0
TAP_HOME="$FBUS" "$TAP" read "$ID_BOUND" --by worker || rc=$?
[ "$rc" != 0 ] && [ ! -e "$FBUS/receipts/$ID_BOUND.done" ] && [ ! -e "$FBUS/receipts/$ID_BOUND.read" ] || { cat "$FBUS/receipts/$ID_BOUND.done"; echo 'RED mismatched adoption grant bypassed by retirement'; exit 1; }
# A matching grant settles with adoption provenance, never retirement.
python3 -B - "$FLIP/.tap/team-registry.json" <<'GRANT'
import json,pathlib,sys
reg=pathlib.Path(sys.argv[1]);d=json.loads(reg.read_text())
d['seats']['worker']['adopted_instances']={'fork':'fork|old'}
reg.write_text(json.dumps(d))
GRANT
TAP_HOME="$FBUS" "$TAP" read "$ID_BOUND" --by worker
python3 -B - "$FBUS/receipts/$ID_BOUND.done" <<'CHECK'
import json,sys
r=json.load(open(sys.argv[1]))
assert r.get('adopted_from')=='fork',r
assert r.get('reason')!='instance_retired',r
assert not r.get('forced'),r
CHECK

# Removing adoption metadata must not turn a different handle's stamp into
# evidence that this worker's predecessor retired.
rm "$FBUS/receipts/$ID_BOUND.done"
python3 -B - "$FBUS/payloads/$ID_BOUND.md" <<'STAMP'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);p.write_text(p.read_text().replace('to_adopted_from: fork\n',''))
STAMP
rc=0
TAP_HOME="$FBUS" "$TAP" read "$ID_BOUND" --by worker || rc=$?
[ "$rc" != 0 ] && [ ! -e "$FBUS/receipts/$ID_BOUND.done" ] && [ ! -e "$FBUS/receipts/$ID_BOUND.read" ] || {
  echo 'different-handle stamp bypassed instance refusal'; exit 1;
}
)
echo 'read-adoption-grant: mismatched grant refused; valid grant preserved; foreign stamp refused'
