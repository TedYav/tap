#!/usr/bin/env bash
# cancel-absent-registry.test.sh — an ABSENT foreign registry is an ANSWER, not unknown.
#
# tap-fcd3. `tap cancel` exists to clear a send whose addressee can never settle it.
# A recipient team whose registry FILE HAS BEEN DELETED is the strongest available
# evidence of exactly that — the team is not merely down, its authority file is gone.
# Yet that was the one case cancel refused (`unreachable_team`), because
# tap_authority_context collapses "file absent" and "cannot observe" into one
# `unreachable` status. Live specimen: fable -> ImproveTestNoiseAndSpeed/sol-ponytail
# sat unclearable for ~28h while the same-team miss beside it cancelled in one command.
#
# The distinction this pins: UNREADABLE IS UNKNOWN, ABSENT IS AN ANSWER.
#
# Deliberately NOT fixed in tap_authority_context: `tap send` and `tap reply` consume
# the same helper and their polarity is correct as-is (an absent recipient registry is
# a reason to refuse to SEND, not to proceed). authority-context.test.sh (8) also pins
# `unreachable` for this state to guard a forbidden sibling-registry rescue. So the
# cost judgment lives in cancel, the one verb whose cost model wants it, and the shared
# helper keeps one meaning for every caller.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"

fail() { echo "cancel-absent-registry: $*" >&2; exit 1; }

SENDER="$WORK/SenderTeam"
REMOTE="$WORK/RemoteTeam"
mkdir -p "$SENDER/.tap/bus/payloads" "$SENDER/.tap/bus/receipts" "$REMOTE/.tap" "$SENDER/.tap"

cat >"$SENDER/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "SenderTeam" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "registered_at": "t", "pane": "", "pane_id": ""
    }
  }
}
JSON

export TAP_HOME="$SENDER/.tap/bus"
export TAP_REGISTRY="$TAP_HOME/registry.json"

FOREIGN_REG="$REMOTE/.tap/team-registry.json"

# Flip LIVE, with RemoteTeam enrolled and pointing at FOREIGN_REG. Each arm below
# decides only whether that file EXISTS and whether it PARSES.
SENDER_REG="$SENDER/.tap/team-registry.json"
# The SENDER team must be fully resolvable. cancel verifies the sender instance
# against its OWN acting registry first, so a sender-side refusal masks the
# recipient-side arm this file exists to test — which is exactly what happened on
# this test's first run, before SenderTeam was enrolled here.
cat >"$SENDER_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "SenderTeam" },
  "seats": {
    "alice": { "status": "active", "delivery": "poll", "harness": "claude",
               "instance": "alice|aaaabbbbccccdddd", "registered_at": "t" }
  }
}
JSON

write_index() {
  python3 -B - "$TAP_INDEX_HOME" "$REMOTE" "$FOREIGN_REG" "$SENDER" "$SENDER_REG" <<'PYIDX'
import json, pathlib, sys
idx = pathlib.Path(sys.argv[1])
remote, reg, sender, sreg = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {
    "RemoteTeam": {"root": remote, "registry_location": reg, "state": "registered"},
    "SenderTeam": {"root": sender, "registry_location": sreg, "state": "registered"},
  },
}) + "\n")
PYIDX
}
write_index

mk_payload() {
  local id="$1"
  cat >"$TAP_HOME/payloads/${id}.md" <<EOF
---
id: $id
from: alice
to: sol
kind: discuss
path: $TAP_HOME/payloads/${id}.md
reply: expected
cross_worktree: true
from_team: SenderTeam
to_team: RemoteTeam
recipient_instance: sol|deadbeefdeadbeef
sender_instance: alice|aaaabbbbccccdddd
---
body
EOF
  : >"$TAP_HOME/receipts/${id}.sent"
}

run_cancel() {
  local id="$1" errf="$2"
  ( cd "$SENDER" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
      "$TAP" cancel "$id" --by alice 2>"$errf" )
}

err="$(mktemp)"

# --- fixture validity: the flip marker must actually be live -------------------
# Without this, every arm below could be exercising the pre-flip path instead and
# would prove nothing about the flip-live refusal this bead is about.
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
marker="$( . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1; tap_registry_v20_state_load && printf '%s' "$_TAP_V20_STATE_VAL" )"
[ "$marker" = "live" ] || fail "fixture: expected a live flip marker, got '$marker'"
echo "  ok   fixture: flip marker is live"

# --- (1) ABSENT foreign registry -> cancel PROCEEDS ---------------------------
# THE LOAD-BEARING ARM. Reds before the fix with unreachable_team.
rm -f "${FOREIGN_REG:?}"
[ ! -e "$FOREIGN_REG" ] || fail "fixture: (1) needs the foreign registry absent"
ID1="alice-20260814T000000Z-absent01"
mk_payload "$ID1"
set +e
out1="$(run_cancel "$ID1" "$err")"; rc1=$?
set -e
if [ "$rc1" -eq 0 ] && [ -f "$TAP_HOME/receipts/${ID1}.cancelled" ]; then
  echo "  ok   absent foreign registry cancels (the recipient can never settle)"
else
  fail "(1) absent foreign registry must cancel; rc=$rc1 out=$out1 err=$(cat "$err")"
fi
grep -q "seat_unresolvable" "$TAP_HOME/receipts/${ID1}.cancelled" \
  || fail "(1) receipt must carry reason=seat_unresolvable; got: $(cat "$TAP_HOME/receipts/${ID1}.cancelled")"
echo "  ok   receipt reason is seat_unresolvable"
# `tap outstanding` quiets by TWO independent mechanisms and this arm pins the
# second one. `tap outstanding` settles an id once `tap_is_done` reads `.cancelled`
# (tap_cancel_path) as settled — so the receipt alone would quiet the listing.
# Removal is still load-bearing for a different reason: per CONTRACT §cancel it is
# what prevents later drain delivery and lets the watch sidecar's parked-spool
# tint clear, since that tint reconciles from spool FILE PRESENCE each tick. A
# receipt beside a surviving file would leave both of those wrong.
[ ! -f "$TAP_HOME/payloads/${ID1}.md" ] \
  || fail "(1) payload must be archived out of payloads/"
echo "  ok   payload archived out of payloads/ (not merely receipted)"
# --- (2) PRESENT but CORRUPT foreign registry -> cancel REFUSES ---------------
# SCOPE, HONESTLY: this arm exercises the LATER registry_error read, NOT the
# absence predicate. A present-but-corrupt file means tap_authority_context
# SUCCEEDS (the file exists), so the `*)` arm holding the absence predicate is
# never reached, and the refusal seen here comes from the seat-map read below it.
#
# That is worth covering and it is not the control it looks like. Its first
# version claimed to pin "the other direction" of the absence predicate; it
# cannot, because the mutation it is supposed to catch never applies to it —
# loosening the predicate to treat every unobservable state as gone leaves this
# arm green. Arm (5) is the real control for that; see there.
printf '{ this is not json' >"$FOREIGN_REG"
[ -s "$FOREIGN_REG" ] || fail "fixture: (2) needs a non-empty corrupt registry"
ID2="alice-20260814T000000Z-absent02"
mk_payload "$ID2"
set +e
out2="$(run_cancel "$ID2" "$err")"; rc2=$?
set -e
[ "$rc2" -ne 0 ] || fail "(2) a corrupt (present) foreign registry must still refuse; got: $out2"
[ ! -f "$TAP_HOME/receipts/${ID2}.cancelled" ] \
  || fail "(2) must not write .cancelled when the registry is merely unreadable"
[ -f "$TAP_HOME/payloads/${ID2}.md" ] \
  || fail "(2) must not archive the payload on a refusal"
echo "  ok   corrupt-but-present foreign registry still refuses"

# --- (3) the refusal must name something doable from the failure state --------
# The old remedy was `tap doctor`, which cannot repair ANOTHER team's registry —
# a recovery verb that does not run in the failure state.
refusal="$(cat "$err")"
grep -qi "doctor" <<<"$refusal" \
  && fail "(3) refusal still routes to 'tap doctor', which cannot repair a foreign team's registry: $refusal"
grep -Eqi 'tap team|repair|re-?enrol|restore|--force|remove' <<<"$refusal" \
  || fail "(3) refusal must name an action doable from this state; got: $refusal"
echo "  ok   refusal names an action doable from the failure state"

# --- (4) an ACTIVE foreign seat still blocks (the guard did not disappear) ----
mkdir -p "$(dirname "$FOREIGN_REG")"
cat >"$FOREIGN_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "RemoteTeam" },
  "seats": {
    "sol": { "status": "active", "delivery": "poll", "harness": "codex",
             "instance": "sol|deadbeefdeadbeef", "registered_at": "t" }
  }
}
JSON
ID3="alice-20260814T000000Z-absent03"
mk_payload "$ID3"
set +e
out3="$(run_cancel "$ID3" "$err")"; rc3=$?
set -e
[ "$rc3" -ne 0 ] || fail "(4) an active foreign seat with a MATCHING instance must still block; got: $out3"
grep -qiE 'seat_active|still an active' <<<"$out3$(cat "$err")" \
  || fail "(4) expected seat_active; out=$out3 err=$(cat "$err")"
echo "  ok   active foreign seat with matching instance still blocks"
# ...and the refusal's next action must SETTLE the obligation it is about. This
# payload is an ASK, and `tap read` on an ask writes .read and leaves it open,
# so naming it routes the addressee onto a path that cannot discharge — the
# same defect the --spooled recovery fixed one branch earlier (tap-9pw8).
grep -q "tap reply $ID3" <<<"$out3$(cat "$err")" \
  || fail "(4) the seat_active refusal for an ASK does not name tap reply: out=$out3 err=$(cat "$err")"
grep -q "next: tap read $ID3" <<<"$out3$(cat "$err")" \
  && fail "(4) the seat_active refusal for an ASK names tap read as its action — reading an ask settles nothing: out=$out3 err=$(cat "$err")"
echo "  ok   an ASK's seat_active refusal names tap reply, not tap read"

# --- (4b) the NOTE half: a settle-only payload's seat_active refusal names read
ID3N="alice-20260814T000000Z-absent03n"
mk_payload "$ID3N"
python3 -c 'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_text(p.read_text().replace("reply: expected","reply: settle-only"))' \
  "$TAP_HOME/payloads/${ID3N}.md"
set +e
out3n="$(run_cancel "$ID3N" "$err")"; rc3n=$?
set -e
[ "$rc3n" -ne 0 ] || fail "(4b) an active foreign seat must still block a note; got: $out3n"
grep -q "tap read $ID3N" <<<"$out3n$(cat "$err")" \
  || fail "(4b) a NOTE's seat_active refusal omitted tap read — a note settles on read: out=$out3n err=$(cat "$err")"
echo "  ok   a NOTE's seat_active refusal names tap read"

# --- (5) UNRESOLVABLE location -> cancel REFUSES ------------------------------
# THE ACTUAL CONTROL ON THE ABSENCE PREDICATE, and the reason arm (2) could not
# be it. The predicate is "we RESOLVED a location and found nothing at it." The
# overreach it must refuse is "any state we cannot observe counts as gone."
#
# This arm reaches the `*)` arm — the team is not in the index at all, so
# tap_authority_context fails AND no location resolves — which is precisely the
# state arm (2) skips. Loosening the predicate to fire whenever the context call
# fails turns this into a cancel, so this arm reds under exactly the overreach
# the shipped code refuses. Validated in both directions before shipping.
python3 -B - "$TAP_INDEX_HOME" "$SENDER" "$SENDER_REG" <<'PYNOTEAM'
import json, pathlib, sys
idx = pathlib.Path(sys.argv[1])
sender, sreg = sys.argv[2], sys.argv[3]
# SenderTeam only — RemoteTeam is absent from the index entirely, so there is no
# registry_location to resolve and absence can never be "proven".
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {
    "SenderTeam": {"root": sender, "registry_location": sreg, "state": "registered"},
  },
}) + "\n")
PYNOTEAM
ID5="alice-20260814T000000Z-absent05"
mk_payload "$ID5"
set +e
out5="$(run_cancel "$ID5" "$err")"; rc5=$?
set -e
[ "$rc5" -ne 0 ] \
  || fail "(5) an UNRESOLVABLE location must refuse — 'cannot observe' is not 'provably absent'; got: $out5"
[ ! -f "$TAP_HOME/receipts/${ID5}.cancelled" ] \
  || fail "(5) must not write .cancelled when no location could be resolved"
[ -f "$TAP_HOME/payloads/${ID5}.md" ] \
  || fail "(5) must not archive the payload on a refusal"
echo "  ok   unresolvable location refuses (absence must be PROVEN, not assumed)"

# --- (6) a FIFO at the foreign registry path -> refusal WITHOUT opening -------
# readFileSync on a writerless FIFO blocks forever, so this arm runs cancel
# under a watchdog: a hang is the RED, a prompt regular-file-guard refusal is
# the green. `exec` inside the subshell makes $! the tap process itself, so the
# watchdog's kill lands on the blocked client, not a wrapper.
write_index
rm -rf "${FOREIGN_REG:?}"
mkfifo "$FOREIGN_REG"
[ -p "$FOREIGN_REG" ] || fail "fixture: (6) needs a FIFO at the foreign registry path"
ID7="alice-20260814T000000Z-absent07"
mk_payload "$ID7"
: >"$err"
out7="$(mktemp)"
hung="$WORK/.fifo-hang"
rm -f "${hung:?}"
( cd "$SENDER" && exec env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
    "$TAP" cancel "$ID7" --by alice >"$out7" 2>"$err" ) & cpid=$!
( sleep 20; if kill -0 "$cpid" 2>/dev/null; then kill -9 "$cpid" 2>/dev/null; touch "$hung"; fi ) & wpid=$!
set +e
wait "$cpid"; rc7=$?
set -e
kill "$wpid" 2>/dev/null || true
wait "$wpid" 2>/dev/null || true
[ ! -e "$hung" ] || fail "(6) reading the FIFO registry hung — cancel must refuse from metadata without opening it; err=$(cat "$err")"
[ "$rc7" -ne 0 ] || fail "(6) a FIFO at the foreign registry path must refuse; got: $(cat "$out7")"
grep -q "not a regular file" <<<"$(cat "$err")" \
  || fail "(6) refusal must come from the regular-file guard; err=$(cat "$err")"
[ ! -f "$TAP_HOME/receipts/${ID7}.cancelled" ] \
  || fail "(6) must not write .cancelled for a non-regular registry"
[ -f "$TAP_HOME/payloads/${ID7}.md" ] \
  || fail "(6) must not archive the payload on a refusal"
echo "  ok   FIFO at the foreign registry path refuses without being opened"
# --- (7) a DIRECTORY at the foreign registry path -> uncertainty refusal ------
# Astra classification repair: the native loader's soft catch turns an EISDIR
# into "unreadable" by accident. The guard must fire BEFORE any load, from file
# metadata, so a directory is refused as the uncertainty it is — and the
# refusal must say which fact fired.
write_index
rm -rf "${FOREIGN_REG:?}"
mkdir -p "$FOREIGN_REG"
[ -d "$FOREIGN_REG" ] || fail "fixture: (7) needs a directory at the foreign registry path"
ID6="alice-20260814T000000Z-absent06"
mk_payload "$ID6"
set +e
out6="$(run_cancel "$ID6" "$err")"; rc6=$?
set -e
[ "$rc6" -ne 0 ] || fail "(7) a directory at the foreign registry path must refuse; got: $out6"
grep -q "not a regular file" <<<"$(cat "$err")" \
  || fail "(7) refusal must come from the regular-file guard, not a loader accident; err=$(cat "$err")"
[ ! -f "$TAP_HOME/receipts/${ID6}.cancelled" ] \
  || fail "(7) must not write .cancelled for a non-regular registry"
[ -f "$TAP_HOME/payloads/${ID6}.md" ] \
  || fail "(7) must not archive the payload on a refusal"
echo "  ok   directory at the foreign registry path refuses as uncertainty"


# --- (8) inherited seat names on an EMPTY registry are GONE -------------------
# seatMap returns an ordinary object, so `seats[handle]` inherits
# constructor/toString and a bracket read mistakes a prototype member for a
# live seat. The addressee names here are valid handles; an empty seats map
# must classify them gone and cancel.
write_index
rm -rf "${FOREIGN_REG:?}"
cat >"$FOREIGN_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "RemoteTeam" },
  "seats": {}
}
JSON
for seat_name in constructor toString; do
  ID8="alice-20260814T000000Z-absent08-$seat_name"
  mk_payload "$ID8"
  python3 -c 'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_text(p.read_text().replace("to: sol","to: "+sys.argv[2]))' \
    "$TAP_HOME/payloads/${ID8}.md" "$seat_name"
  set +e
  out8="$(run_cancel "$ID8" "$err")"; rc8=$?
  set -e
  [ "$rc8" -eq 0 ] || fail "(8) addressee '$seat_name' on an EMPTY seats map must cancel as gone; got: $out8 err=$(cat "$err")"
  grep -q "seat_unresolvable" "$TAP_HOME/receipts/${ID8}.cancelled" \
    || fail "(8) '$seat_name' receipt must carry reason=seat_unresolvable; got: $(cat "$TAP_HOME/receipts/${ID8}.cancelled")"
done
echo "  ok   constructor/toString addressees on an empty seats map cancel as gone"

# --- (9) CONTROL: an OWN active row of the same name still blocks -------------
cat >"$FOREIGN_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "RemoteTeam" },
  "seats": {
    "constructor": { "status": "active", "delivery": "poll", "harness": "codex",
                     "instance": "sol|deadbeefdeadbeef", "registered_at": "t" }
  }
}
JSON
ID9="alice-20260814T000000Z-absent09"
mk_payload "$ID9"
python3 -c 'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_text(p.read_text().replace("to: sol","to: constructor"))' \
  "$TAP_HOME/payloads/${ID9}.md"
set +e
out9="$(run_cancel "$ID9" "$err")"; rc9=$?
set -e
[ "$rc9" -ne 0 ] || fail "(9) an OWN active 'constructor' row must still block; got: $out9"
grep -qiE 'seat_active|still an active' <<<"$out9$(cat "$err")" \
  || fail "(9) expected seat_active for the own active row; out=$out9 err=$(cat "$err")"
[ -f "$TAP_HOME/payloads/${ID9}.md" ] \
  || fail "(9) must not archive the payload on a refusal"
echo "  ok   an OWN active row named constructor still blocks"

# --- (10) SUPPLIED-EMPTY --team / --by are usage refusals, not fallbacks ------
# `--team ""` must not silently mean "no override" and cancel against the local
# bus, and `--by ""` must not fall through to identity resolution or the
# not_sender machinery. Empty-string operands are the same usage refusal as a
# missing value, fired before any selection or identity fallback.
ID10="alice-20260814T000000Z-absent10"
mk_payload "$ID10"
set +e
out10="$( cd "$SENDER" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
    "$TAP" cancel "$ID10" --by alice --team "" 2>"$err" )"; rc10=$?
set -e
[ "$rc10" -ne 0 ] \
  || fail "(10) --team '' must refuse as usage, not cancel against the local bus; got: $out10"
grep -q -- "--team needs a value" <<<"$out10$(cat "$err")" \
  || fail "(10) --team '' refusal must be the '--team needs a value' usage line; out=$out10 err=$(cat "$err")"
[ -f "$TAP_HOME/payloads/${ID10}.md" ] \
  || fail "(10) must not archive the payload on a supplied-empty --team"
[ ! -f "$TAP_HOME/receipts/${ID10}.cancelled" ] \
  || fail "(10) must not write .cancelled on a supplied-empty --team"
echo "  ok   supplied-empty --team is the usage refusal, no local fallback"

ID10B="alice-20260814T000000Z-absent10b"
mk_payload "$ID10B"
set +e
out10b="$( cd "$SENDER" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" \
    "$TAP" cancel "$ID10B" --by "" 2>"$err" )"; rc10b=$?
set -e
[ "$rc10b" -ne 0 ] \
  || fail "(10b) --by '' must refuse as usage; got: $out10b"
grep -q -- "--by needs a value" <<<"$out10b$(cat "$err")" \
  || fail "(10b) --by '' refusal must be the '--by needs a value' usage line, not a fallback; out=$out10b err=$(cat "$err")"
[ -f "$TAP_HOME/payloads/${ID10B}.md" ] \
  || fail "(10b) must not archive the payload on a supplied-empty --by"
echo "  ok   supplied-empty --by is the usage refusal, no identity fallback"

# --- (11) an existing NON-REGULAR terminal receipt path is terminal ------------
# A directory squatting on receipts/<id>.cancelled exists; the terminality check
# must treat every existing path as settled-before-archive, so cancel refuses
# the already-cancelled way instead of colliding with the path mid-effect.
write_index
rm -rf "${FOREIGN_REG:?}"
cat >"$FOREIGN_REG" <<'JSON'
{
  "schema": "0.20",
  "team": { "name": "RemoteTeam" },
  "seats": {}
}
JSON
ID11="alice-20260814T000000Z-absent11"
mk_payload "$ID11"
mkdir -p "$TAP_HOME/receipts/${ID11}.cancelled"
[ -d "$TAP_HOME/receipts/${ID11}.cancelled" ] \
  || fail "fixture: (11) needs a directory at the terminal receipt path"
set +e
out11="$(run_cancel "$ID11" "$err")"; rc11=$?
set -e
[ "$rc11" -ne 0 ] \
  || fail "(11) an existing non-regular terminal receipt path must refuse before any effect; got: $out11"
grep -qi "already cancelled" <<<"$out11$(cat "$err")" \
  || fail "(11) refusal must be the terminal already-cancelled answer, not a write collision; out=$out11 err=$(cat "$err")"
[ -f "$TAP_HOME/payloads/${ID11}.md" ] \
  || fail "(11) must not archive the payload when the terminal path is squatted"
echo "  ok   a directory at the terminal receipt path answers already-cancelled"

# --- (12) an unreadable REGULAR payload refuses STRUCTURED under --json --------
# A permission-locked payload is uncertainty about content, not absence: one
# structured refusal, the --json caller gets its error envelope, and the payload
# stays exactly where it is.
rm -f "${FOREIGN_REG:?}"
ID12="alice-20260814T000000Z-absent12"
mk_payload "$ID12"
chmod 000 "$TAP_HOME/payloads/${ID12}.md"
set +e
out12="$( cd "$SENDER" && env TAP_HOME="$TAP_HOME" TAP_INDEX_HOME="$TAP_INDEX_HOME" TAP_JSON=1 \
    "$TAP" cancel "$ID12" --by alice 2>"$err" )"; rc12=$?
set -e
chmod 644 "$TAP_HOME/payloads/${ID12}.md"
[ "$rc12" -ne 0 ] \
  || fail "(12) an unreadable payload must refuse; got: $out12"
if ! python3 -B - "$out12" <<'PYJSON'
import json, sys
lines = [line for line in sys.argv[1].splitlines() if line.strip()]
assert len(lines) == 1, f"(12) expected exactly one JSON line on stdout, got: {sys.argv[1]!r}"
doc = json.loads(lines[0])
assert doc.get("ok") is False, doc
assert doc.get("error_class"), doc
PYJSON
then
  fail "(12) --json refusal must be one structured error envelope; got: $out12"
fi
[ -f "$TAP_HOME/payloads/${ID12}.md" ] \
  || fail "(12) must not archive the payload on an unreadable-payload refusal"
[ ! -f "$TAP_HOME/receipts/${ID12}.cancelled" ] \
  || fail "(12) must not write .cancelled on an unreadable-payload refusal"
echo "  ok   unreadable regular payload refuses structured and stays put"

echo "cancel-absent-registry: ok"
