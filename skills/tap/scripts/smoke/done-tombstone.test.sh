#!/usr/bin/env bash
# Public `tap done` is a non-mutating tombstone: it settles nothing, writes no
# receipt and no audit row, names its replacement, and exits 1 with the stable
# error class done_retired. It touches no bus, registry or pane, so every
# argument shape (and a live reset fence) answers identically.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT
export TAP_HOME="$WORK/team/.tap/bus" TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_INDEX_HOME"
printf '%s\n' '{"schema": "0.20", "team":{"name":"team"},"seats":{"worker":{"status":"active","delivery":"poll","instance":"worker|current"},"peer":{"status":"active","delivery":"poll","instance":"peer|current"}}}' > "$TAP_HOME/registry.json"
tap_smoke_enroll_current "$WORK/team" "$TAP_HOME" team
fail() { echo "done-tombstone: $*" >&2; exit 1; }
for reply in expected settle-only; do
  id="tomb-$reply"
  cat > "$TAP_HOME/payloads/$id.md" <<PAYLOAD
---
id: $id
from: peer
to: worker
kind: discuss
reply: $reply
path: $TAP_HOME/payloads/$id.md
---
work remains open
PAYLOAD
done
printf 'malformed remains untouched\n' > "$TAP_HOME/payloads/broken.md"
printf 'answer\n' > "$WORK/answer.md"
# Every file under the bus, hashed; nothing is excluded, so an audit row or a
# receipt anywhere is a difference.
snapshot() {
  python3 - "$TAP_HOME" "$WORK/team" <<'PY'
import hashlib,pathlib,sys
for root in map(pathlib.Path, sys.argv[1:]):
  for p in sorted(root.rglob('*')):
    if p.is_file(): print(p,hashlib.sha256(p.read_bytes()).hexdigest())
PY
}
before="$(snapshot)"
# Each shape: no actor, a bare id, --by/--team/--payload/--epoch, a smuggled
# --reply-payload, an unknown flag, a missing id, an invalid id.
shapes=(
  "tomb-expected --by worker"
  "tomb-settle-only --by worker"
  "tomb-expected"
  "tomb-expected --team team"
  "tomb-expected --by worker --payload $TAP_HOME/payloads/tomb-expected.md --epoch 7"
  "tomb-expected --by worker --reply-payload $WORK/answer.md"
  "--unrecognized"
  ""
  "bad/id"
  "no-such-id --by nobody"
)
check_refusal() { # <label>
  [ "$rc" = 1 ] || { cat "$WORK/out" >&2; fail "$1: exit=$rc, want 1"; }
  grep -q 'tap done is retired' "$WORK/out" || { cat "$WORK/out" >&2; fail "$1: retirement not named"; }
  grep -qF 'tap reply <id> --by <you> -f <file>' "$WORK/out" || { cat "$WORK/out" >&2; fail "$1: replacement missing"; }
  grep -qF 'tap read <id>' "$WORK/out" || { cat "$WORK/out" >&2; fail "$1: note replacement missing"; }
}
for shape in "${shapes[@]}"; do
  rc=0; env -u TAP_SELF bash -c 'exec "$0" done "$@"' "$TAP" $shape >"$WORK/out" 2>&1 || rc=$?
  check_refusal "tap done $shape"
done
[ "$(snapshot)" = "$before" ] || fail 'tap done changed a payload, receipt, registry, audit or generation'
# The stable error class rides the JSON error object.
rc=0; TAP_JSON=1 "$TAP" done tomb-expected --by worker >"$WORK/out" 2>"$WORK/err" || rc=$?
[ "$rc" = 1 ] || fail "JSON refusal exit=$rc, want 1"
grep -q '"error_class": *"done_retired"' "$WORK/out" "$WORK/err" || { cat "$WORK/out" "$WORK/err" >&2; fail 'stable error class done_retired missing from the JSON error'; }
[ "$(snapshot)" = "$before" ] || fail 'JSON refusal changed the bus'
[ ! -e "$TAP_HOME/receipts/done-alias-hits.jsonl" ] || fail 'tap done appended an audit row'
# No bus at all (unset pins, scratch HOME with no machine index): the tombstone
# reads nothing, so it answers the same.
rc=0; env -u TAP_HOME -u TAP_INDEX_HOME -u TAP_SELF HOME="$WORK/nohome" "$TAP" done tomb-expected --by worker >"$WORK/out" 2>&1 || rc=$?
check_refusal 'tap done with no bus'
[ ! -e "$WORK/nohome/.tap" ] || fail 'tap done created TAP state under HOME'
# A live reset fence changes nothing: the verb never reads the bus.
printf '{}\n' > "$TAP_HOME/reset.fence.json"
before_fence="$(snapshot)"
rc=0; "$TAP" done tomb-expected --by worker >"$WORK/out" 2>&1 || rc=$?
check_refusal 'tap done under a reset fence'
[ "$(snapshot)" = "$before_fence" ] || fail 'tap done wrote under a reset fence'
rm -f "${TAP_HOME:?}/reset.fence.json"
# Verbose mode (global flag and env) never reads the bus for the tombstone.
rc=0; TAP_VERBOSE=1 "$TAP" done tomb-expected --by worker >"$WORK/out" 2>&1 || rc=$?
check_refusal 'tap done under TAP_VERBOSE'
rc=0; "$TAP" -v done tomb-expected --by worker >"$WORK/out" 2>&1 || rc=$?
check_refusal 'tap -v done'
[ "$(snapshot)" = "$before" ] || fail 'verbose tap done changed the bus'
# Every trailing help spelling is the same request as tap help done.
"$TAP" help done >"$WORK/help-ref" 2>&1 || true
for spelling in --help -h help; do
  "$TAP" done "$spelling" >"$WORK/help-out" 2>&1 || true
  cmp -s "$WORK/help-ref" "$WORK/help-out" || { cat "$WORK/help-out" >&2; fail "tap done $spelling differs from tap help done"; }
done
# The counter script treats the (never created) log as unavailable evidence.
rc=0; python3 "$ROOT/skills/tap/scripts/tap-done-alias-count.py" "$TAP_HOME/receipts/done-alias-hits.jsonl" >"$WORK/count.out" 2>&1 || rc=$?
[ "$rc" = 2 ] || fail 'missing audit evidence reported zero use'
# Help: the tombstone's explanation survives; the verb is not a live listing.
rc=0; "$TAP" help done >"$WORK/out" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "tap help done exit=$rc, want 1"
grep -qF 'tap reply <id> --by <you> -f <file>' "$WORK/out" || fail 'tap help done lost the replacement'
"$TAP" help >"$WORK/overview" 2>&1 || fail 'tap help overview failed'
if grep -qE '^  tap done ' "$WORK/overview"; then fail 'overview still lists tap done as a live verb'; fi
# Replacement path still settles: reply answers and settles the ask, read
# settles the note, each with its own receipt.
"$TAP" reply tomb-expected --by worker -f "$WORK/answer.md" >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail 'tap reply no longer settles an ask'; }
[ -f "$TAP_HOME/receipts/tomb-expected.done" ] || fail 'tap reply wrote no settlement receipt'
grep -q '"via":"reply"' "$TAP_HOME/receipts/tomb-expected.done" || grep -q '"via": "reply"' "$TAP_HOME/receipts/tomb-expected.done" || fail 'reply receipt lost via=reply'
"$TAP" read tomb-settle-only --by worker >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail 'tap read no longer settles a note'; }
[ -f "$TAP_HOME/receipts/tomb-settle-only.done" ] || fail 'tap read wrote no settlement receipt'
echo 'done-tombstone: tap done refuses with its replacement and writes nothing; reply and read still settle'
