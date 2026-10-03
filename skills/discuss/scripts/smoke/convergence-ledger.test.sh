#!/usr/bin/env bash
# convergence-ledger.test.sh - collab single-writer, proposal fold, and convergence smoke.
#
# Run: bash skills/discuss/scripts/smoke/convergence-ledger.test.sh
# Exit: 0 on all-pass, 1 on any failure.
# shellcheck disable=SC2015

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (echo "collab/convergence-ledger: not in a git repo" >&2; exit 1))"
. "$REPO_ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "skills/discuss/scripts/"
SCRIPT_DIR="$REPO_ROOT/skills/discuss/scripts"
LEDGER="$SCRIPT_DIR/ledger.sh"
FOLD="$SCRIPT_DIR/fold.sh"
CONVERGED="$SCRIPT_DIR/is-converged.sh"
ROUND="$SCRIPT_DIR/round-count.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "collab/convergence-ledger test  (single-writer + payload-fold + convergence)"

for helper in "$LEDGER" "$FOLD" "$CONVERGED" "$ROUND"; do
  [ -f "$helper" ] || { echo "FAIL: $helper not found" >&2; exit 1; }
done

mkdir -p "$REPO_ROOT/tmp"
SMOKE_DIR="$(mktemp -d "$REPO_ROOT/tmp/discuss-convergence-ledger-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_DIR"' EXIT
export COLLAB_DIR="$SMOKE_DIR/discuss"
echo "  (COLLAB_DIR=$COLLAB_DIR)"

DRIVER=driver
SIDE=peer

create_thread() {
  local tid="$1" opened_by="${2:-$DRIVER}"
  local tdir="$COLLAB_DIR/threads/$tid"
  mkdir -p "$tdir/messages" "$tdir/proposals"
  python3 - "$tdir/metadata.json" "$opened_by" <<'PY'
import json, sys
path, opened_by = sys.argv[1], sys.argv[2]
with open(path, "w") as fh:
    json.dump({"opened_by": opened_by}, fh)
PY
}

write_message() {
  local tid="$1" mid="$2" from="${3:-$SIDE}"
  python3 - "$COLLAB_DIR" "$tid" "$mid" "$from" <<'PY'
import datetime, json, os, sys
root, tid, mid, from_handle = sys.argv[1:5]
tdir = os.path.join(root, "threads", tid, "messages")
os.makedirs(tdir, exist_ok=True)
payload = {
    "id": mid,
    "thread_id": tid,
    "trace": {"thread_id": tid},
    "kind": "reply",
    "from": from_handle,
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
}
with open(os.path.join(tdir, f"{mid}.json"), "w") as fh:
    json.dump(payload, fh)
PY
}

write_payload() {
  write_tap_payload "$@"
}

# A payload in the shape `tap send` ACTUALLY writes: the five routing fields the
# courier stamps (CONTRACT.md §Envelope) plus `reply`, and its authoritative
# place-time receipt. The proposal is a driver-owned copy whose `path` still names
# the canonical payload. A repair rewrites only that copy, as production does.
write_tap_payload() {
  local tid="$1" pid="$2" body="$3"
  local pdir="$COLLAB_DIR/threads/$tid/proposals"
  local bus="$SMOKE_DIR/bus-$tid"
  local canonical="$bus/payloads/$pid.md"
  local path="$pdir/$pid.md"
  mkdir -p "$pdir" "$bus/payloads" "$bus/receipts"
  {
    printf '%s\n' "---"
    printf 'id: %s\n' "$pid"
    printf 'from: %s\n' "$SIDE"
    printf 'to: %s\n' "$DRIVER"
    printf '%s\n' "kind: proposal"
    printf 'path: %s\n' "$canonical"
    printf '%s\n' "reply: expected"
    printf '%s\n' "---"
    printf '%s\n' "$body"
  } >"$path"
  if [ ! -f "$canonical" ]; then
    cp "$path" "$canonical"
    printf '{"id":"%s","via":"courier","at":"%s"}\n' \
      "$pid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$bus/receipts/$pid.placed"
  fi
  printf '%s\n' "$path"
}

write_raw_payload() {
  local tid="$1" pid="$2" body="$3"
  local pdir="$COLLAB_DIR/threads/$tid/proposals"
  local path="$pdir/$pid.md"
  mkdir -p "$pdir"
  printf '%s\n' "$body" >"$path"
  printf '%s\n' "$path"
}

tamper_payload_copy() { # <path> <body|frontmatter-key> <replacement>
  python3 - "$@" <<'PY'
import sys
from pathlib import Path

path, field, replacement = sys.argv[1:]
lines = Path(path).read_text().splitlines()
end = lines.index("---", 1)
if field == "body":
    lines[end + 1:] = [replacement]
else:
    prefix = f"{field}:"
    index = next(i for i, line in enumerate(lines[1:end], 1) if line.startswith(prefix))
    lines[index] = f"{field}: {replacement}"
Path(path).write_text("\n".join(lines) + "\n")
PY
}

ledger_status() {
  local tid="$1" item_id="$2"
  bash "$LEDGER" list "$tid" --by "$DRIVER" 2>/dev/null |
    python3 -c 'import json, sys
want = sys.argv[1]
for line in sys.stdin:
    if not line.strip():
        continue
    item = json.loads(line)
    if item.get("id") == want:
        print(item.get("status"))
        break' "$item_id"
}

expect_status() {
  local desc="$1" tid="$2" item_id="$3" want="$4"
  local got
  got="$(ledger_status "$tid" "$item_id")"
  [ "$got" = "$want" ] && ok "$desc" || bad "$desc (wanted $want, got ${got:-<missing>})"
}

expect_rc() {
  local desc="$1" want="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local got=$?
  [ "$got" -eq "$want" ] && ok "$desc" || bad "$desc (wanted rc=$want, got rc=$got)"
}

expect_rc_text() {
  local desc="$1" want="$2" needle="$3"
  shift 3
  local out
  out="$("$@" 2>&1)"
  local got=$?
  if [ "$got" -eq "$want" ] && echo "$out" | grep -qiE "$needle"; then
    ok "$desc"
  else
    bad "$desc (wanted rc=$want text=$needle; got rc=$got output=$out)"
  fi
}

expect_fail_text() {
  local desc="$1" needle="$2"
  shift 2
  local out
  out="$("$@" 2>&1)"
  local got=$?
  if [ "$got" -ne 0 ] && echo "$out" | grep -qiE "$needle"; then
    ok "$desc"
  else
    bad "$desc (rc=$got output=$out)"
  fi
}

ledger_source_count() {
  local tid="$1" pid="$2"
  bash "$LEDGER" source-ids "$tid" --by "$DRIVER" 2>/dev/null |
    awk -v pid="$pid" '$0 == pid { count += 1 } END { print count + 0 }'
}

append_forged_accept() {
  local tid="$1" item_id="$2" evref="$3"
  python3 - "$COLLAB_DIR" "$tid" "$item_id" "$evref" <<'PY'
import datetime, json, os, sys
root, tid, item_id, evref = sys.argv[1:5]
ledger_path = os.path.join(root, "threads", tid, "ledger.ndjson")
event = {
    "event": "transition",
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
    "thread_id": tid,
    "id": item_id,
    "status": "accepted",
    "evidence_class": "evidence_bearing",
    "evidence_ref": evref,
    "rationale": "forged direct ledger edit",
    "from": "rejected_with_reason",
}
with open(ledger_path, "a") as fh:
    fh.write(json.dumps(event) + "\n")
PY
}

TID=t-main
create_thread "$TID"

echo "-- (a) non-driver writes are rejected at every shared-state mutator --"
bash "$LEDGER" add "$TID" f1 proposed evidence_bearing "driver-note" "missing guard" --by "$DRIVER" >/dev/null 2>&1 \
  && ok "driver can seed the ledger" || bad "driver add rejected"

expect_fail_text "ledger add rejects a seventh positional argument" "usage: ledger.sh add" \
  bash "$LEDGER" add "$TID" too_many proposed judgment "x" "y" "extra" --by "$DRIVER"
before_status="$(ledger_status "$TID" f1)"
expect_fail_text "peer direct ledger transition is rejected" "driver|opened_by|single-writer|refused" \
  bash "$LEDGER" transition "$TID" f1 accepted "" "peer forces accept" --by "$SIDE"
expect_status "rejected peer transition does not change the ledger" "$TID" f1 "$before_status"
expect_fail_text "peer ledger add is rejected" "driver|opened_by|single-writer|refused" \
  bash "$LEDGER" add "$TID" illegal proposed judgment "x" "y" --by "$SIDE"
expect_fail_text "peer round increment is rejected" "driver|opened_by|single-writer|refused" \
  bash "$ROUND" "$TID" --increment --by "$SIDE"
side_payload="$(write_payload "$TID" p-side '{"op":"add","item_id":"from_side","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"x"}')"
expect_fail_text "peer fold is rejected" "driver|opened_by|single-writer|refused" \
  bash "$FOLD" "$TID" "$side_payload" --by "$SIDE"
bash "$CONVERGED" "$TID" 4 --by "$SIDE" >/dev/null 2>&1
[ "$?" -eq 3 ] && ok "non-driver convergence check exits 3" || bad "non-driver convergence check did not exit 3"

echo "-- (b) payload proposal folds through the ledger path --"
proposal="$(write_payload "$TID" p-add '{"op":"add","item_id":"p_added","status":"proposed","evidence_class":"judgment","evidence":"side-note","rationale":"peer proposes a naming item"}')"
[ -z "$(ledger_status "$TID" p_added)" ] && ok "proposal has not mutated the ledger before fold" || bad "proposal leaked into the ledger pre-fold"
fold_out="$(bash "$FOLD" "$TID" "$proposal" --by "$DRIVER" 2>&1)"
echo "$fold_out" | grep -q "p_added" && ok "fold reports the applied item" || bad "fold did not report p_added: $fold_out"
expect_status "folded proposal lands in the ledger" "$TID" p_added proposed

# tap-yegvg: the arm that would have caught the defect. A payload in the real
# `tap send` shape must fold. Before the fix this REDs on "missing at", which is
# the whole finding: the documented peer path could never apply a real payload.
tap_shaped="$(write_tap_payload "$TID" "$SIDE-20260902T081200Z-abc123def456" '{"op":"add","item_id":"tap_shaped_item","status":"proposed","evidence_class":"judgment","evidence":"real-envelope","rationale":"a payload in the shape tap send writes"}')"
tap_fold_out="$(bash "$FOLD" "$TID" "$tap_shaped" --by "$DRIVER" 2>&1)"
echo "$tap_fold_out" | grep -q "APPLIED" \
  && ok "a real tap-send-shaped payload (five routing fields, no at) folds" \
  || bad "real tap-send-shaped payload did not apply: $tap_fold_out"
expect_status "real tap-send-shaped payload lands in the ledger" "$TID" tap_shaped_item proposed
# Assert the derived value, not merely that some at was produced.
tap_shaped_at="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("at",""))' "$COLLAB_DIR/threads/$TID/messages/$SIDE-20260902T081200Z-abc123def456.json" 2>/dev/null)"
tap_receipt_at="$(python3 -c 'import datetime,os,sys; ns=os.stat(sys.argv[1]).st_mtime_ns; sec,nano=divmod(ns,10**9); print(datetime.datetime.fromtimestamp(sec,datetime.timezone.utc).replace(microsecond=nano//1000).strftime("%Y-%m-%dT%H:%M:%S.%fZ"))' "$SMOKE_DIR/bus-$TID/receipts/$SIDE-20260902T081200Z-abc123def456.placed" 2>/dev/null)"
[ -n "$tap_receipt_at" ] && [ "$tap_shaped_at" = "$tap_receipt_at" ] \
  && ok "send time comes from the courier-owned placed receipt" \
  || bad "recorded at was $tap_shaped_at, placed receipt says $tap_receipt_at"

# A copied proposal may carry courier provenance only while its peer-authored
# body/from/kind still match the canonical payload. Each field gets its own arm so
# checking one cannot accidentally satisfy the class.
TID_COPY=t-copy-provenance
create_thread "$TID_COPY"

body_copy="$(write_tap_payload "$TID_COPY" p-copy-body '{"op":"add","item_id":"canonical_body_item","status":"proposed","evidence_class":"judgment","evidence":"canonical","rationale":"peer body"}')"
tamper_payload_copy "$body_copy" body '{"op":"add","item_id":"forged_body_item","status":"proposed","evidence_class":"judgment","evidence":"forged","rationale":"edited copy"}'
expect_rc_text "a copied body that differs from canonical fails provenance closed" 1 "provenance" \
  bash "$FOLD" "$TID_COPY" "$body_copy" --by "$DRIVER"
[ -z "$(ledger_status "$TID_COPY" forged_body_item)" ] && ok "a mismatched copied body cannot apply an operation the peer never sent" \
  || bad "mismatched copied body applied forged_body_item"

from_copy="$(write_tap_payload "$TID_COPY" p-copy-from '{"op":"add","item_id":"copy_from_item","status":"proposed","evidence_class":"judgment","evidence":"canonical","rationale":"peer sender"}')"
tamper_payload_copy "$from_copy" from other_peer
expect_rc_text "a copied from that differs from canonical fails provenance closed" 1 "provenance" \
  bash "$FOLD" "$TID_COPY" "$from_copy" --by "$DRIVER"
[ -z "$(ledger_status "$TID_COPY" copy_from_item)" ] && ok "a mismatched copied from cannot apply" \
  || bad "mismatched copied from applied copy_from_item"

kind_copy="$(write_tap_payload "$TID_COPY" p-copy-kind '{"op":"add","item_id":"copy_kind_item","status":"proposed","evidence_class":"judgment","evidence":"canonical","rationale":"peer kind"}')"
tamper_payload_copy "$kind_copy" kind reply
expect_rc_text "a copied kind that differs from canonical fails provenance closed" 1 "provenance" \
  bash "$FOLD" "$TID_COPY" "$kind_copy" --by "$DRIVER"
[ -z "$(ledger_status "$TID_COPY" copy_kind_item)" ] && ok "a mismatched copied kind cannot apply" \
  || bad "mismatched copied kind applied copy_kind_item"


echo "-- (c) anti-sycophancy guard fires at the fold boundary and on replay --"
bash "$LEDGER" transition "$TID" f1 rejected_with_reason "" "not actually a bug" --by "$DRIVER" >/dev/null 2>&1 \
  && ok "driver rejects evidence-bearing f1" || bad "driver reject failed"
no_evidence_payload="$(write_payload "$TID" p-noev '{"op":"transition","item_id":"f1","new_status":"accepted","rationale":"trust me"}')"
fold_noev="$(bash "$FOLD" "$TID" "$no_evidence_payload" --by "$DRIVER" 2>&1)"
expect_status "reversal without newer evidence remains rejected" "$TID" f1 rejected_with_reason
echo "$fold_noev" | grep -qiE "newer than|new evidence|anti-sycophancy|reversal" \
  && ok "fold output surfaces the missing-new-evidence reason" \
  || bad "fold output did not name the guard reason: $fold_noev"

python3 - <<'PY'
import time
time.sleep(0.02)
PY
write_message "$TID" e-new
with_evidence_payload="$(write_payload "$TID" p-ev '{"op":"transition","item_id":"f1","new_status":"accepted","evidence_ref":"e-new@src/a.ts:10","rationale":"new repro proves it"}')"
bash "$FOLD" "$TID" "$with_evidence_payload" --by "$DRIVER" >/dev/null 2>&1
expect_status "reversal with newer evidence is accepted" "$TID" f1 accepted

TID_FORGE=t-forge
create_thread "$TID_FORGE"
bash "$LEDGER" add "$TID_FORGE" forged proposed evidence_bearing "driver-note" "needs evidence" --by "$DRIVER" >/dev/null 2>&1
bash "$LEDGER" transition "$TID_FORGE" forged rejected_with_reason "" "not enough" --by "$DRIVER" >/dev/null 2>&1
append_forged_accept "$TID_FORGE" forged "future-msg@src/a.ts:10"
expect_fail_text "read-time replay catches a forged accepted ledger line" "forged accept|anti-sycophancy|missing.*stamp" \
  bash "$LEDGER" list "$TID_FORGE" --by "$DRIVER"

# A caller may choose `tap send --id`. Its embedded timestamp is therefore not
# provenance: an id from 2099 must not make evidence placed before the rejection
# look newer than it. Create the carrier first, reject second, then fold both.
TID_FUTURE=t-caller-chosen-future-id
create_thread "$TID_FUTURE"
future_id="$SIDE-20990101T000000Z-abcdef123456"
future_carrier="$(write_tap_payload "$TID_FUTURE" "$future_id" '{"op":"add","item_id":"future_carrier","status":"proposed","evidence_class":"judgment","evidence":"old evidence","rationale":"placed before the rejection"}')"
python3 - <<'PY'
import time
time.sleep(0.02)
PY
bash "$LEDGER" add "$TID_FUTURE" future_guard proposed evidence_bearing "driver-note" "needs newer evidence" --by "$DRIVER" >/dev/null 2>&1
bash "$LEDGER" transition "$TID_FUTURE" future_guard rejected_with_reason "" "old evidence is insufficient" --by "$DRIVER" >/dev/null 2>&1
bash "$FOLD" "$TID_FUTURE" "$future_carrier" --by "$DRIVER" >/dev/null 2>&1
future_reversal="$(write_payload "$TID_FUTURE" p-future-reversal "{\"op\":\"transition\",\"item_id\":\"future_guard\",\"new_status\":\"accepted\",\"evidence_ref\":\"$future_id@src/a.ts:10\",\"rationale\":\"caller-chosen future id\"}")"
future_out="$(bash "$FOLD" "$TID_FUTURE" "$future_reversal" --by "$DRIVER" 2>&1)"
future_rc=$?
if [ "$future_rc" -ne 0 ] && [ "$(ledger_status "$TID_FUTURE" future_guard)" = "rejected_with_reason" ]; then
  ok "caller-chosen future id cannot bypass the newer-evidence guard"
else
  bad "caller-chosen future id bypassed the guard (rc=$future_rc output=$future_out status=$(ledger_status "$TID_FUTURE" future_guard))"
fi

# The courier receipt's JSON timestamp has whole-second precision, while ledger
# events carry microseconds. Preserve the receipt's subsecond filesystem time so
# legitimate evidence placed later in the same second is still newer.
TID_SUBSECOND=t-same-second-evidence
create_thread "$TID_SUBSECOND"
bash "$LEDGER" add "$TID_SUBSECOND" subsecond_guard proposed evidence_bearing "driver-note" "needs newer evidence" --by "$DRIVER" >/dev/null 2>&1
bash "$LEDGER" transition "$TID_SUBSECOND" subsecond_guard rejected_with_reason "" "old evidence is insufficient" --by "$DRIVER" >/dev/null 2>&1
subsecond_id="$SIDE-20990101T000000Z-fedcba654321"
subsecond_carrier="$(write_tap_payload "$TID_SUBSECOND" "$subsecond_id" '{"op":"add","item_id":"subsecond_carrier","status":"proposed","evidence_class":"judgment","evidence":"new evidence","rationale":"placed later in the rejection second"}')"
python3 - "$COLLAB_DIR/threads/$TID_SUBSECOND/ledger.ndjson" "$SMOKE_DIR/bus-$TID_SUBSECOND/receipts/$subsecond_id.placed" <<'PY'
import datetime, json, os, sys

ledger_path, receipt_path = sys.argv[1:]
with open(ledger_path) as fh:
    rejection = next(
        event["at"]
        for line in fh
        if (event := json.loads(line)).get("id") == "subsecond_guard"
        and event.get("status") == "rejected_with_reason"
    )
rejected_at = datetime.datetime.fromisoformat(rejection.replace("Z", "+00:00"))
assert rejected_at.microsecond < 999999, "test precondition: no later microsecond remains"
placed_at = rejected_at.replace(microsecond=rejected_at.microsecond + 1)
with open(receipt_path) as fh:
    receipt = json.load(fh)
receipt["at"] = rejected_at.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(receipt_path, "w") as fh:
    json.dump(receipt, fh)
epoch_ns = int(placed_at.timestamp()) * 1_000_000_000 + placed_at.microsecond * 1_000
os.utime(receipt_path, ns=(epoch_ns, epoch_ns))
PY
bash "$FOLD" "$TID_SUBSECOND" "$subsecond_carrier" --by "$DRIVER" >/dev/null 2>&1
subsecond_reversal="$(write_payload "$TID_SUBSECOND" p-subsecond-reversal "{\"op\":\"transition\",\"item_id\":\"subsecond_guard\",\"new_status\":\"accepted\",\"evidence_ref\":\"$subsecond_id@src/a.ts:10\",\"rationale\":\"new evidence in the same second\"}")"
subsecond_out="$(bash "$FOLD" "$TID_SUBSECOND" "$subsecond_reversal" --by "$DRIVER" 2>&1)"
subsecond_rc=$?
if [ "$subsecond_rc" -eq 0 ] && [ "$(ledger_status "$TID_SUBSECOND" subsecond_guard)" = "accepted" ]; then
  ok "later same-second courier placement counts as newer evidence"
else
  bad "later same-second evidence was rejected (rc=$subsecond_rc output=$subsecond_out status=$(ledger_status "$TID_SUBSECOND" subsecond_guard))"
fi

echo "-- (d) judgment items may flip on argument alone --"
bash "$LEDGER" add "$TID" j1 proposed judgment "naming taste" "rename for clarity" --by "$DRIVER" >/dev/null 2>&1
bash "$LEDGER" transition "$TID" j1 rejected_with_reason "" "keep current name" --by "$DRIVER" >/dev/null 2>&1
judgment_payload="$(write_payload "$TID" p-judgment '{"op":"transition","item_id":"j1","new_status":"accepted","rationale":"better argument wins"}')"
bash "$FOLD" "$TID" "$judgment_payload" --by "$DRIVER" >/dev/null 2>&1
expect_status "judgment reversal without new evidence is allowed" "$TID" j1 accepted

echo "-- (e) malformed proposals are quarantined and convergence fails loud on torn files --"
TID_EMPTY=t-empty
create_thread "$TID_EMPTY"
expect_rc_text "unseeded ledger with no proposals stays open" 1 "COLLAB_OPEN.*open=0.*pending=0.*items=0" \
  bash "$CONVERGED" "$TID_EMPTY" 9 --by "$DRIVER"

TID_BAD=t-bad-payloads
create_thread "$TID_BAD"
bare_payload="$(write_raw_payload "$TID_BAD" p-bare '{"op":"add","item_id":"bare_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"bare"}')"
bare_out="$(bash "$FOLD" "$TID_BAD" "$bare_payload" --by "$DRIVER" 2>&1)"
if echo "$bare_out" | grep -qi "malformed" && [ -z "$(ledger_status "$TID_BAD" bare_item)" ]; then
  ok "bare-body payload is malformed and leaves ledger unchanged"
else
  bad "bare-body payload was not quarantined (output=$bare_out status=$(ledger_status "$TID_BAD" bare_item))"
fi

invalid_json_payload="$(write_payload "$TID_BAD" p-invalid-json '{"op":')"
expect_rc_text "invalid JSON payload is malformed, and the fold exits nonzero" 1 "malformed.*invalid JSON" \
  bash "$FOLD" "$TID_BAD" "$invalid_json_payload" --by "$DRIVER"

unknown_op_payload="$(write_payload "$TID_BAD" p-unknown-op '{"op":"wat","item_id":"u1"}')"
expect_rc_text "unknown proposal op is malformed, and the fold exits nonzero" 1 "malformed.*unknown op" \
  bash "$FOLD" "$TID_BAD" "$unknown_op_payload" --by "$DRIVER"

refold_payload="$(write_payload "$TID_BAD" p-refold '{"op":"add","item_id":"refold_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"one apply"}')"
bash "$FOLD" "$TID_BAD" "$refold_payload" --by "$DRIVER" >/dev/null 2>&1
refold_out="$(bash "$FOLD" "$TID_BAD" "$refold_payload" --by "$DRIVER" 2>&1)"
if echo "$refold_out" | grep -qi "skipped" && [ "$(ledger_source_count "$TID_BAD" p-refold)" -eq 1 ]; then
  ok "re-fold of an applied payload is a no-op, with no double-apply"
else
  bad "re-fold did not skip cleanly (output=$refold_out source_count=$(ledger_source_count "$TID_BAD" p-refold))"
fi

torn_payload="$(write_raw_payload "$TID_BAD" p-torn $'---\nid: p-torn\nfrom: peer\nat: 2026-01-01T00:00:00Z\n{"op":"add","item_id":"torn_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"torn"}')"
expect_rc_text "unterminated-frontmatter payload is malformed on fold, and the fold exits nonzero" 1 "malformed.*unterminated" \
  bash "$FOLD" "$TID_BAD" "$torn_payload" --by "$DRIVER"
# tap-yegvg inverts this. It previously asserted that a malformed payload was
# bookmarked and convergence then proceeded — which is precisely the silent
# content-loss path: a teammate's proposal was dropped and the thread converged over
# it. An unapplied proposal now stays unbookmarked, so convergence fails loud instead.
expect_rc_text "an unapplied malformed proposal keeps the thread from converging over it" 3 "unreadable|frontmatter|proposal" \
  bash "$CONVERGED" "$TID_BAD" 9 --by "$DRIVER"
# tap-yegvg control: a payload rejected BY THE LEDGER is not bookmarked, because a
# ledger refusal is state-dependent. A transition can arrive before its add; poisoning
# it would discard a proposal that becomes valid moments later.
TID_LATE=t-late-valid
create_thread "$TID_LATE"
late_payload="$(write_tap_payload "$TID_LATE" "$SIDE-20260902T101500Z-1a2b3c4d5e6f" '{"op":"transition","item_id":"not_yet","new_status":"accepted","rationale":"transition before its add"}')"
bash "$FOLD" "$TID_LATE" "$late_payload" --by "$DRIVER" >/dev/null 2>&1
late_rc=$?
[ "$late_rc" -ne 0 ] && ok "a ledger-rejected proposal exits nonzero" || bad "ledger-rejected proposal exited 0"
grep -q "$SIDE-20260902T101500Z-1a2b3c4d5e6f" "$COLLAB_DIR/threads/$TID_LATE/processed_payload_ids" 2>/dev/null \
  && bad "a ledger-rejected proposal was bookmarked, so it can never be retried" \
  || ok "a ledger-rejected proposal is not bookmarked"
bash "$LEDGER" add "$TID_LATE" not_yet proposed judgment "x" "the add finally lands" --by "$DRIVER" >/dev/null 2>&1
late_out="$(bash "$FOLD" "$TID_LATE" "$late_payload" --by "$DRIVER" 2>&1)"
echo "$late_out" | grep -q "APPLIED" \
  && ok "the same proposal applies once the ledger state makes it valid" \
  || bad "proposal did not apply after its add landed: $late_out"

# tap-yegvg control: repairing a damaged proposal in place lets it fold. This is the
# incident that produced the bead — a payload the parser wrongly rejected could never
# be re-folded afterwards, even unchanged, because the failure had bookmarked its id.
TID_REPAIR=t-repair
create_thread "$TID_REPAIR"
repair_id="$SIDE-20260902T102000Z-9f8e7d6c5b4a"
repair_payload="$(write_tap_payload "$TID_REPAIR" "$repair_id" '{"op":"add","item_id":"repaired_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"canonical body recopied"}')"
tamper_payload_copy "$repair_payload" body 'not json at all'
expect_rc_text "a damaged local copy fails provenance closed" 1 "provenance" \
  bash "$FOLD" "$TID_REPAIR" "$repair_payload" --by "$DRIVER"
grep -q "$repair_id" "$COLLAB_DIR/threads/$TID_REPAIR/processed_payload_ids" 2>/dev/null \
  && bad "a malformed payload was bookmarked, so repairing it could never help" \
  || ok "a malformed payload is not bookmarked"
cp "$SMOKE_DIR/bus-$TID_REPAIR/payloads/$repair_id.md" "$repair_payload"
repair_out="$(bash "$FOLD" "$TID_REPAIR" "$repair_payload" --by "$DRIVER" 2>&1)"
echo "$repair_out" | grep -q "APPLIED" \
  && ok "recopying the canonical payload repairs the same path and id" \
  || bad "recopied canonical payload did not apply: $repair_out"
expect_status "the recopied canonical payload lands in the ledger" "$TID_REPAIR" repaired_item proposed

TID_TORN=t-torn-converge
create_thread "$TID_TORN"
write_raw_payload "$TID_TORN" p-torn-converge $'---\nid: p-torn-converge\nfrom: peer\nat: 2026-01-01T00:00:00Z\n{"op":"add","item_id":"torn_pending","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"torn"}' >/dev/null
expect_rc_text "unterminated-frontmatter proposal makes convergence fail loud" 3 "unterminated|frontmatter|torn" \
  bash "$CONVERGED" "$TID_TORN" 9 --by "$DRIVER"

TID_SELF=t-self-citation
create_thread "$TID_SELF"
bash "$LEDGER" add "$TID_SELF" self1 proposed evidence_bearing "driver-note" "needs external evidence" --by "$DRIVER" >/dev/null 2>&1
bash "$LEDGER" transition "$TID_SELF" self1 rejected_with_reason "" "not enough" --by "$DRIVER" >/dev/null 2>&1
self_payload="$(write_payload "$TID_SELF" p-self '{"op":"transition","item_id":"self1","new_status":"accepted","evidence_ref":"p-self@src/a.ts:10","rationale":"cite myself"}')"
self_out="$(bash "$FOLD" "$TID_SELF" "$self_payload" --by "$DRIVER" 2>&1)"
if echo "$self_out" | grep -qiE "rejected|pre-exists|self" && [ "$(ledger_status "$TID_SELF" self1)" = "rejected_with_reason" ]; then
  ok "self-citing reversal proposal is rejected without changing status"
else
  bad "self-citing reversal was not rejected (output=$self_out status=$(ledger_status "$TID_SELF" self1))"
fi

missing_at_payload="$(write_raw_payload "$TID_BAD" p-missing-at $'---\nid: p-missing-at\nfrom: peer\nto: driver\nkind: proposal\n---\n{"op":"add","item_id":"missing_at_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"missing at"}')"
# A copied proposal without a courier-stamped canonical path and matching place
# receipt has no authority for its claimed time, regardless of its id.
expect_rc_text "payload with no courier place receipt fails closed, and the fold exits nonzero" 1 "malformed.*no courier-owned send-time provenance" \
  bash "$FOLD" "$TID_BAD" "$missing_at_payload" --by "$DRIVER"
explicit_at_payload="$(write_raw_payload "$TID_BAD" p-explicit-at $'---\nid: peer-20260902T090000Z-aaaabbbbcccc\nfrom: peer\nto: driver\nkind: proposal\nat: 2001-02-03T04:05:06Z\n---\n{"op":"add","item_id":"explicit_at_item","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"explicit at outranks the id"}')"
expect_rc_text "a caller-supplied at cannot replace courier provenance" 1 "malformed.*no courier-owned send-time provenance" \
  bash "$FOLD" "$TID_BAD" "$explicit_at_payload" --by "$DRIVER"

echo "-- (f) convergence uses drained ledger, pending payloads, round cap, and driver gate --"
TID_CONV=t-converge
create_thread "$TID_CONV"
bash "$LEDGER" add "$TID_CONV" open1 proposed judgment "x" "still open" --by "$DRIVER" >/dev/null 2>&1
expect_rc "open ledger item keeps the loop open" 1 bash "$CONVERGED" "$TID_CONV" 2 --by "$DRIVER"
bash "$ROUND" "$TID_CONV" --increment --by "$DRIVER" >/dev/null 2>&1
bash "$ROUND" "$TID_CONV" --increment --by "$DRIVER" >/dev/null 2>&1
expect_rc "round cap with open work exits 2" 2 bash "$CONVERGED" "$TID_CONV" 2 --by "$DRIVER"
bash "$LEDGER" transition "$TID_CONV" open1 resolved_by_revision "" "fixed" --by "$DRIVER" >/dev/null 2>&1
pending_payload="$(write_payload "$TID_CONV" p-pending '{"op":"add","item_id":"from_pending","status":"proposed","evidence_class":"judgment","evidence":"x","rationale":"pending proposal"}')"
expect_rc "unprocessed proposal file keeps the loop open" 1 bash "$CONVERGED" "$TID_CONV" 9 --by "$DRIVER"
bash "$FOLD" "$TID_CONV" "$pending_payload" --by "$DRIVER" >/dev/null 2>&1
expect_rc "processed proposal with open ledger work still stays open" 1 bash "$CONVERGED" "$TID_CONV" 9 --by "$DRIVER"
bash "$LEDGER" transition "$TID_CONV" from_pending resolved_by_revision "" "folded and fixed" --by "$DRIVER" >/dev/null 2>&1
expect_rc "drained ledger and no unprocessed proposals converges" 0 bash "$CONVERGED" "$TID_CONV" 9 --by "$DRIVER"

echo "-- (g) one turn carries ordered ops with per-op recovery --"
TID_BATCH=t-batch
create_thread "$TID_BATCH"
batch_body=$(cat <<'EOF'
## Position
One payload contains the whole turn.

```json
{"ops":[
  {"op":"add","item_id":"batch_item","evidence_class":"judgment","evidence":"source","rationale":"create"},
  {"op":"transition","item_id":"batch_item","new_status":"resolved_by_revision","rationale":"close"}
]}
```
EOF
)
batch_payload="$(write_payload "$TID_BATCH" p-batch "$batch_body")"
expect_rc_text "multi-op Markdown payload applies both operations in order" 0 "applied=2 rejected=0 malformed=0" \
  bash "$FOLD" "$TID_BATCH" "$batch_payload" --by "$DRIVER"
expect_status "second batch operation consumes the first operation's result" "$TID_BATCH" batch_item resolved_by_revision
expect_rc_text "completed batch converges" 0 "pending=0" bash "$CONVERGED" "$TID_BATCH" 4 --by "$DRIVER"
expect_rc_text "completed batch re-fold does not reapply" 0 "applied=0" bash "$FOLD" "$TID_BATCH" "$batch_payload" --by "$DRIVER"
# Model a crash after ledger append and before the fold's bookmark-file save.
rm -f "$COLLAB_DIR/threads/$TID_BATCH/processed_payload_ids"
expect_rc_text "convergence recovers completed per-op ledger bookmarks" 0 "pending=0" \
  bash "$CONVERGED" "$TID_BATCH" 4 --by "$DRIVER"
expect_rc_text "re-fold recovers completed per-op ledger bookmarks" 0 "applied=0" \
  bash "$FOLD" "$TID_BATCH" "$batch_payload" --by "$DRIVER"

TID_PARTIAL=t-batch-partial
create_thread "$TID_PARTIAL"
partial_payload="$(write_payload "$TID_PARTIAL" p-partial '{"ops":[{"op":"add","item_id":"first","status":"resolved_by_revision","evidence_class":"judgment"},{"op":"transition","item_id":"later","new_status":"resolved_by_revision"},{"op":"add","item_id":"tail","status":"resolved_by_revision","evidence_class":"judgment"}]}')"
expect_rc_text "mid-batch ledger rejection reports its operation" 1 "REJECTED.*op\[1\]" \
  bash "$FOLD" "$TID_PARTIAL" "$partial_payload" --by "$DRIVER"
expect_status "successful prefix remains applied" "$TID_PARTIAL" first resolved_by_revision
[ -z "$(ledger_status "$TID_PARTIAL" tail)" ] && ok "rejected op stops the dependent tail" || bad "tail ran past a rejected op"
grep -qx p-partial "$COLLAB_DIR/threads/$TID_PARTIAL/processed_payload_ids" 2>/dev/null \
  && bad "partial batch was bookmarked as complete" || ok "partial batch has no whole-payload bookmark"
expect_rc_text "closed prefix does not hide pending batch tail" 1 "pending=1" \
  bash "$CONVERGED" "$TID_PARTIAL" 4 --by "$DRIVER"
rm -f "$COLLAB_DIR/threads/$TID_PARTIAL/processed_payload_ids"
bash "$LEDGER" add "$TID_PARTIAL" later proposed judgment "x" "prerequisite arrives" --by "$DRIVER" >/dev/null 2>&1
expect_rc_text "partial crash re-fold applies only the remaining tail" 0 "applied=2 rejected=0 malformed=0 skipped=1" \
  bash "$FOLD" "$TID_PARTIAL" "$partial_payload" --by "$DRIVER"
expect_status "recovered tail lands" "$TID_PARTIAL" tail resolved_by_revision
expect_rc "recovered batch converges" 0 bash "$CONVERGED" "$TID_PARTIAL" 4 --by "$DRIVER"
event_count="$(wc -l < "$COLLAB_DIR/threads/$TID_PARTIAL/ledger.ndjson" | tr -d ' ')"
[ "$event_count" = 4 ] && ok "partial replay creates exactly three batch events plus the prerequisite" || bad "partial replay event count was $event_count"

TID_MIDBAD=t-batch-malformed
create_thread "$TID_MIDBAD"
midbad_payload="$(write_payload "$TID_MIDBAD" p-midbad '{"ops":[{"op":"add","item_id":"first","status":"resolved_by_revision","evidence_class":"judgment"},null,{"op":"add","item_id":"tail","status":"resolved_by_revision","evidence_class":"judgment"}]}')"
expect_rc_text "mid-batch malformed op fails loud at its index" 1 "malformed.*op\[1\].*object" \
  bash "$FOLD" "$TID_MIDBAD" "$midbad_payload" --by "$DRIVER"
expect_status "malformed middle preserves valid prefix" "$TID_MIDBAD" first resolved_by_revision
[ -z "$(ledger_status "$TID_MIDBAD" tail)" ] && ok "malformed op stops the dependent tail" || bad "tail ran past malformed op"
expect_rc_text "malformed batch remains pending" 1 "pending=1" bash "$CONVERGED" "$TID_MIDBAD" 4 --by "$DRIVER"
expect_rc_text "re-fold never bookmarks malformed op" 1 "applied=0 rejected=0 malformed=1" \
  bash "$FOLD" "$TID_MIDBAD" "$midbad_payload" --by "$DRIVER"
empty_payload="$(write_payload "$TID_MIDBAD" p-empty '{"ops":[]}')"
expect_rc_text "empty ops is explicitly refused" 1 "non-empty.*ops|ops.*non-empty" bash "$FOLD" "$TID_MIDBAD" "$empty_payload" --by "$DRIVER"
ambiguous_payload="$(write_payload "$TID_MIDBAD" p-ambiguous "$batch_body
$batch_body")"
expect_rc_text "multiple JSON blocks are refused without selecting one" 1 "one.*fenced json block" \
  bash "$FOLD" "$TID_MIDBAD" "$ambiguous_payload" --by "$DRIVER"
typed_payload="$(write_payload "$TID_MIDBAD" p-typed '{"ops":[{"op":"add","item_id":42,"evidence_class":"judgment"}]}')"
expect_rc_text "wrong-type op field is reported instead of coerced" 1 "item_id must be a string" \
  bash "$FOLD" "$TID_MIDBAD" "$typed_payload" --by "$DRIVER"

TID_BATCH_GUARD=t-batch-guard
create_thread "$TID_BATCH_GUARD"
guard_payload="$(write_payload "$TID_BATCH_GUARD" p-batch-guard '{"ops":[{"op":"add","item_id":"guarded","status":"rejected_with_reason","evidence_class":"evidence_bearing","evidence":"old"},{"op":"transition","item_id":"guarded","new_status":"accepted","evidence_ref":"p-batch-guard@source:1"}]}')"
expect_rc_text "batch cannot use its own payload as reversal evidence" 1 "REJECTED.*op\[1\].*pre-exists" \
  bash "$FOLD" "$TID_BATCH_GUARD" "$guard_payload" --by "$DRIVER"
expect_status "batch self-citation leaves the item rejected" "$TID_BATCH_GUARD" guarded rejected_with_reason

# The same self-citation spelled as the batch's own OP KEY (`<payload-id>#<i>`, the
# bookmark proposal_ops() mints). The fold guard matches the bare id and `id@...`
# only, so this form reaches the ledger, which must still refuse it: an op key is
# not a message id in the thread, so it can never be visible new evidence.
TID_BATCH_OPKEY=t-batch-opkey
create_thread "$TID_BATCH_OPKEY"
opkey_payload="$(write_payload "$TID_BATCH_OPKEY" p-batch-opkey '{"ops":[{"op":"add","item_id":"guarded","status":"rejected_with_reason","evidence_class":"evidence_bearing","evidence":"old"},{"op":"transition","item_id":"guarded","new_status":"accepted","evidence_ref":"p-batch-opkey#0"}]}')"
expect_rc_text "batch cannot cite its own op key as reversal evidence" 1 "REJECTED.*op\[1\]" \
  bash "$FOLD" "$TID_BATCH_OPKEY" "$opkey_payload" --by "$DRIVER"
expect_status "op-key self-citation leaves the item rejected" "$TID_BATCH_OPKEY" guarded rejected_with_reason

echo "collab/convergence-ledger test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
