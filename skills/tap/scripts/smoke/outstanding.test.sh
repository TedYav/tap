#!/usr/bin/env bash
# outstanding.test.sh — tap outstanding (rest-refusal sink signal, matrix #7).
# Lists MY un-answered sends (from==me, no .done); exit 2 when any, 0 when clean.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; TAP_HOME="$WORK/repo/.tap/bus"; trap 'rm -rf "$WORK"' EXIT; export TAP_HOME
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" team
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

mk() { # id from to
cat > "$TAP_HOME/payloads/$1.md" <<EOF
---
id: $1
from: $2
to: $3
kind: discuss
path: tmp/tap/payloads/$1.md
---

body
EOF
}
mk ask1 claude codex
mk other1 alice codex

# 1. claude has an outstanding send (ask1) → exit 2, lists it; does NOT leak other1
set +e
out="$("$TAP" outstanding claude --json)"
rc="$?"
set -e
[ "$rc" -eq 2 ] || { echo "outstanding: expected exit 2 while a send is unanswered, got $rc" >&2; exit 1; }
python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
items=d.get("outstanding",[])
assert any(i["id"]=="ask1" and i.get("to")=="codex" for i in items), d
' <<<"$out" || { echo "outstanding: did not list ask1: $out" >&2; exit 1; }
case "$out" in *other1*) echo "outstanding: leaked another sender's payload" >&2; exit 1 ;; esac

# 2. malformed outbound payloads from claude keep exit 2 and warn instead of hiding
cat > "$TAP_HOME/payloads/malformed-out.md" <<'EOF'
---
id: malformed-out
from: claude
kind: discuss
path: tmp/tap/payloads/malformed-out.md
---

missing to
EOF
set +e
"$TAP" outstanding claude >"$TAP_HOME/out-malformed.stdout" 2>"$TAP_HOME/out-malformed.stderr"
rc="$?"
set -e
[ "$rc" -eq 2 ] || { echo "outstanding: real outstanding sends remain on this bus, so exit stays 2, got $rc" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/.quarantine/malformed-out.md" ] || {
  echo "outstanding: the malformed outbound was not quarantined" >&2
  cat "$TAP_HOME/out-malformed.stdout" >&2; exit 1
}
grep -q 'missing to' "$TAP_HOME/payloads/.quarantine/malformed-out.md" || {
  echo "outstanding: quarantined bytes were not preserved" >&2; exit 1
}
grep -qE 'quarantin' "$TAP_HOME/out-malformed.stdout" || {
  echo "outstanding: malformed outbound quarantine pointer missing" >&2
  cat "$TAP_HOME/out-malformed.stderr" >&2
  exit 1
}
rm -f "$TAP_HOME/payloads/malformed-out.md" "$TAP_HOME/payloads/.quarantine/malformed-out.md"

# 3. recipient settles ask1 → claude is clean (exit 0)
printf '%s\n' '{"schema": "0.20", "team":{"name":"team"},"seats":{"codex":{"status":"active","delivery":"poll"},"claude":{"status":"active","delivery":"poll"}}}' > "$TAP_HOME/registry.json"
printf 'answer\n' > "$TAP_HOME/answer.txt"
"$TAP" reply ask1 --by codex -f "$TAP_HOME/answer.txt"
"$TAP" outstanding claude || { echo "outstanding: should be clean after recipient settled" >&2; exit 1; }

# 4. tap-9i8v item (1): the receipt ladder is VISIBLE to the sender ------------
# Ids carry a real timestamp because ids.ts idAgeSeconds parses age FROM the id —
# a synthetic id without one cannot exercise the age path, the same way a
# colourless mock could not exercise a colour rule.
# Two rows that are byte-identical today must become distinguishable: a payload
# whose ladder closed (.placed + .sent) and one whose did not (.placed only).
#
# THE WORDING IS THE HARD PART AND IT IS ASSERTED, not left to review. kimi's
# measurement: 33 of 774 placements never reached .sent, and ZERO of them are
# open — every one has .done. The majority were delivered within two minutes by
# recipient poll or the harness's own mid-turn queue; .sent is written in one
# place, on synchronous verify-success, and nothing ever closes it retroactively.
# So a placed-no-sent row is a statement about the RECEIPT LADDER, not about
# delivery. If this row ever reads as "your message never arrived", we have
# shipped a new false receipt inside the fix for false receipts.
mkdir -p "$TAP_HOME/receipts"
cat > "$TAP_HOME/payloads/claude-20260811T010203Z-ladderopen.md" <<'EOF'
---
id: claude-20260811T010203Z-ladderopen
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/claude-20260811T010203Z-ladderopen.md
---

injection never confirmed
EOF
cat > "$TAP_HOME/payloads/claude-20260811T010203Z-ladderclosed.md" <<'EOF'
---
id: claude-20260811T010203Z-ladderclosed
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/claude-20260811T010203Z-ladderclosed.md
---

injection confirmed
EOF
: > "$TAP_HOME/receipts/claude-20260811T010203Z-ladderopen.placed"
: > "$TAP_HOME/receipts/claude-20260811T010203Z-ladderclosed.placed"
: > "$TAP_HOME/receipts/claude-20260811T010203Z-ladderclosed.sent"
"$TAP" outstanding claude >"$TAP_HOME/out-ladder.stdout" 2>&1 || true
_open_row="$(grep '^claude-20260811T010203Z-ladderopen' "$TAP_HOME/out-ladder.stdout" || true)"
_closed_row="$(grep '^claude-20260811T010203Z-ladderclosed' "$TAP_HOME/out-ladder.stdout" || true)"
[ -n "$_open_row" ] && [ -n "$_closed_row" ] || {
  echo "outstanding: ladder rows missing entirely" >&2; cat "$TAP_HOME/out-ladder.stdout" >&2; exit 1
}
[ "$_open_row" != "$_closed_row" ] || {
  echo "outstanding: placed-never-injected must not render identically to injected-awaiting-reply" >&2; exit 1
}
grep -q 'Delivery not confirmed.' <<<"$_open_row" || {
  echo "outstanding: the open-ladder row must say Delivery not confirmed; got: $_open_row" >&2; exit 1
}
# Explicit labeled resend is the ratified sender recovery; use the message id.
grep -q 'tap resend claude-20260811T010203Z-ladderopen requires proof that no attempt occurred.' <<<"$_open_row" || {
  echo "outstanding: sender recovery must name the original id; got: $_open_row" >&2; exit 1
}
grep -q 'Delivery not confirmed.' <<<"$_closed_row" && {
  echo "outstanding: a closed ladder must NOT be marked unconfirmed; got: $_closed_row" >&2; exit 1
}
# Never claim non-delivery: most unconfirmed rows WERE delivered.
# NOTE ON THIS DENYLIST: it is anchored to HISTORY, not intent. Each forbidden
# substring is a phrasing someone actually reached for — "never injected" is the
# BEAD's own first-draft wording. It cannot catch a future phrase that implies
# non-delivery without matching, e.g. "delivery uncertain"; that residual is
# known and accepted. Treat a pass as "no known-tempting wrong phrasing", never
# as "this wording is safe".
case "$_open_row$(cat "$TAP_HOME/out-ladder.stdout")" in
  *"never injected"*|*"not delivered"*|*"never arrived"*|*"undelivered"*)
    echo "outstanding: wording claims non-delivery, which the measurement contradicts: $_open_row" >&2; exit 1 ;;
esac
# Age on by default — age plus a quiet seat was the only signal available. The
# `age: ` label went with the row diet (tap-7r3fn.7); the datum did not.
grep -qE '[0-9]+s' <<<"$_closed_row" || {
  echo "outstanding: age must show by default, not only under --stale; got: $_closed_row" >&2; exit 1
}
rm -f "$TAP_HOME/payloads/claude-20260811T010203Z-ladderopen.md" "$TAP_HOME/payloads/claude-20260811T010203Z-ladderclosed.md" \
      "$TAP_HOME/receipts/claude-20260811T010203Z-ladderopen.placed" "$TAP_HOME/receipts/claude-20260811T010203Z-ladderclosed.placed" \
      "$TAP_HOME/receipts/claude-20260811T010203Z-ladderclosed.sent"
echo "outstanding: 4 (tap-9i8v) — open vs closed receipt ladder are distinguishable, age by default, no non-delivery claim: ok"

# 5. tap-9i8v item (3): surface the signal that already exists ------------------
# `courier redelivery_submit_unverified` is written durably at lib.sh:1398 when
# the drain gives up on automatic redelivery. It is consumed by `tap health`
# only — i.e. by teams that already run watch infrastructure — and the stderr
# that would tell everyone else is suppressed BY DESIGN in the very context that
# fires it (foreground opportunistic drains suppress their own output). So at the
# moment the ladder gives up, the transport goes deliberately quiet on exactly
# the teams with no other instrument. This is the consumption half of a producer
# that is already correct.
#
# WORDING IS ASSERTED, not left to review: the condition describes the LADDER
# GIVING UP, never non-delivery. The payload is canonical and may already have
# been read — kimi measured that most placed-no-sent rows WERE delivered — so a
# sender who reads it as "undelivered" re-sends what the peer already has and
# turns a receipt gap into a duplicate wake.
cat > "$TAP_HOME/payloads/claude-20260811T010203Z-gaveup.md" <<'EOF'
---
id: claude-20260811T010203Z-gaveup
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/claude-20260811T010203Z-gaveup.md
---

redelivery stopped
EOF
: > "$TAP_HOME/receipts/claude-20260811T010203Z-gaveup.placed"
printf 'ts=2026-08-11T01:02:03Z actor=courier action=redelivery_submit_unverified handle=codex pane=%%1 team=t detail=id=claude-20260811T010203Z-gaveup\n' \
  >> "$TAP_HOME/registry-events.log"
"$TAP" outstanding claude >"$TAP_HOME/out-gaveup.stdout" 2>&1 || true
grep -q 'automatic redelivery stopped' "$TAP_HOME/out-gaveup.stdout" || {
  echo "outstanding: the redelivery_submit_unverified condition must reach the sender" >&2
  cat "$TAP_HOME/out-gaveup.stdout" >&2; exit 1
}
grep -q 'claude-20260811T010203Z-gaveup' "$TAP_HOME/out-gaveup.stdout" || {
  echo "outstanding: the condition must name the id it applies to" >&2; exit 1
}
case "$(cat "$TAP_HOME/out-gaveup.stdout")" in
  *"not delivered"*|*"undelivered"*|*"never arrived"*|*"never injected"*|*"failed to deliver"*)
    echo "outstanding: condition wording claims non-delivery; the measurement says most such sends WERE delivered" >&2
    cat "$TAP_HOME/out-gaveup.stdout" >&2; exit 1 ;;
esac
# A send with no such event must not attract the condition.
grep -q 'automatic redelivery stopped.*ladderclosed' "$TAP_HOME/out-gaveup.stdout" && {
  echo "outstanding: condition fired for a send that had no redelivery event" >&2; exit 1
}
rm -f "$TAP_HOME/payloads/claude-20260811T010203Z-gaveup.md" \
      "$TAP_HOME/receipts/claude-20260811T010203Z-gaveup.placed" "$TAP_HOME/registry-events.log"
echo "outstanding: 5 (tap-9i8v) — redelivery-stopped condition reaches the sender without claiming non-delivery: ok"

# 6. tap-9i8v deltas from design-match review (kimi/fable) --------------------
# (a) The JSON surface must CONSUME the ladder field. A field written and never
#     read is a small false receipt of its own — the same shape this PR fixes one
#     layer up, so shipping it would be a joke at our own expense.
# (b) The headline count must NOT count conditions as sends. Conditions ride the
#     condition family and are counted by it; riding the row list made
#     "N outstanding send(s)" wrong by the number of conditions present, on the
#     first line a sender reads.
cat > "$TAP_HOME/payloads/claude-20260811T010203Z-deltas.md" <<'EOF'
---
id: claude-20260811T010203Z-deltas
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/claude-20260811T010203Z-deltas.md
---

deltas
EOF
: > "$TAP_HOME/receipts/claude-20260811T010203Z-deltas.placed"
printf 'ts=2026-08-11T01:02:03Z actor=courier action=redelivery_submit_unverified handle=codex pane=%%1 team=t detail=id=claude-20260811T010203Z-deltas\n' \
  >> "$TAP_HOME/registry-events.log"
"$TAP" outstanding claude --json >"$TAP_HOME/out-deltas.json" 2>/dev/null || true
python3 -B - "$TAP_HOME/out-deltas.json" <<'PYCHK' || exit 1
import json, sys
doc = json.load(open(sys.argv[1]))
items = doc.get("outstanding") or doc.get("items") or []
match = [i for i in items if i.get("id") == "claude-20260811T010203Z-deltas"]
if not match:
    print("outstanding: test6 JSON lost the row entirely: %r" % (doc,), file=sys.stderr); sys.exit(1)
if not match[0].get("ladder"):
    print("outstanding: test6 JSON must CONSUME the ladder field, got %r" % (match[0],), file=sys.stderr); sys.exit(1)
conds = doc.get("spool_conditions") or []
if not any(c.get("kind") == "redelivery_stopped" for c in conds):
    print("outstanding: test6 the redelivery condition must reach --json, got %r" % (conds,), file=sys.stderr); sys.exit(1)
PYCHK
"$TAP" outstanding claude >"$TAP_HOME/out-deltas.txt" 2>&1 || true
_hdr="$(grep -o '[0-9]\+ outstanding send(s)' "$TAP_HOME/out-deltas.txt" | head -1 | awk '{print $1}')"
_rows="$(grep -cE '^[A-Za-z0-9][A-Za-z0-9._-]*  ' "$TAP_HOME/out-deltas.txt" || true)"
_conds="$(grep -c '^CONDITION' "$TAP_HOME/out-deltas.txt" || true)"
[ "$_hdr" = "$((_rows + _conds))" ] || {
  echo "outstanding: test6 headline count $_hdr != rows $_rows + conditions $_conds — conditions must not be counted as sends" >&2
  cat "$TAP_HOME/out-deltas.txt" >&2; exit 1
}
rm -f "$TAP_HOME/payloads/claude-20260811T010203Z-deltas.md" \
      "$TAP_HOME/receipts/claude-20260811T010203Z-deltas.placed" "$TAP_HOME/registry-events.log"
echo "outstanding: 6 (tap-9i8v) — ladder reaches --json, condition joins the family, headline counts sends and conditions separately: ok"

# 7. tap-xity: send_unverified condition (direct-send path's own submit-unverified,
#    sibling of arm 5's redelivery_stopped, same family). THIS ARM DRIVES:
#    tap outstanding's consumer block for `action=send_submit_unverified`
#    (the grep + condition-json emission added alongside the arm-5 block) — a
#    hand-crafted registry-events line, same shape arm 5 already uses to drive
#    the redelivery consumer, so this exercises the NEW grep/emit pair, not the
#    producer (that's exit-5-pending.test.sh's job).
cat > "$TAP_HOME/payloads/claude-20260811T010203Z-stuck.md" <<'EOF'
---
id: claude-20260811T010203Z-stuck
from: claude
to: codex
kind: discuss
path: tmp/tap/payloads/claude-20260811T010203Z-stuck.md
---

stuck sentinel
EOF
: > "$TAP_HOME/receipts/claude-20260811T010203Z-stuck.placed"
printf 'ts=2026-08-11T01:02:03Z actor=claude action=send_submit_unverified handle=codex pane=%%1 team=t detail=id=claude-20260811T010203Z-stuck\n' \
  >> "$TAP_HOME/registry-events.log"
"$TAP" outstanding claude >"$TAP_HOME/out-stuck.stdout" 2>&1 || true
# The verb ALSO emits a pre-existing `[injection unconfirmed;
# if it persists: tap nudge <to>]` ladder suffix for any .placed-without-.sent
# id, independent of this arm's consumer block — it already names the id and
# already says "tap nudge". So the id/remedy greps below are anchored to the
# CONDITION line specifically, not the whole output: unanchored, they'd stay
# green even if the new condition's wording silently lost its id or its
# remedy, satisfied by the neighbouring ladder line instead (review
# finding F1).
_cond_line="$(grep 'could not confirm submission' "$TAP_HOME/out-stuck.stdout" || true)"
[ -n "$_cond_line" ] || {
  echo "outstanding: the send_submit_unverified condition must reach the sender" >&2
  cat "$TAP_HOME/out-stuck.stdout" >&2; exit 1
}
printf '%s' "$_cond_line" | grep -q 'claude-20260811T010203Z-stuck' || {
  echo "outstanding: the send_unverified CONDITION line must name the id it applies to (not just the ladder suffix)" >&2
  printf '%s\n' "$_cond_line" >&2; exit 1
}
printf '%s' "$_cond_line" | grep -q 'tap nudge' || {
  echo "outstanding: the send_unverified CONDITION line must point at the verified remedy (tap nudge), not just the ladder suffix" >&2
  exit 1
}
case "$(cat "$TAP_HOME/out-stuck.stdout")" in
  *"not delivered"*|*"undelivered"*|*"never arrived"*|*"never injected"*|*"failed to deliver"*)
    echo "outstanding: send_unverified wording claims non-delivery, same trap arm 5 guards against" >&2
    cat "$TAP_HOME/out-stuck.stdout" >&2; exit 1 ;;
esac
"$TAP" outstanding claude --json >"$TAP_HOME/out-stuck.json" 2>/dev/null || true
python3 -B - "$TAP_HOME/out-stuck.json" <<'PYCHK' || exit 1
import json, sys
doc = json.load(open(sys.argv[1]))
conds = doc.get("spool_conditions") or []
if not any(c.get("kind") == "send_unverified" and c.get("id") == "claude-20260811T010203Z-stuck" for c in conds):
    print("outstanding: test7 send_unverified condition missing from --json, got %r" % (conds,), file=sys.stderr); sys.exit(1)
PYCHK
rm -f "$TAP_HOME/payloads/claude-20260811T010203Z-stuck.md" \
      "$TAP_HOME/receipts/claude-20260811T010203Z-stuck.placed" "$TAP_HOME/registry-events.log"
echo "outstanding: 7 (tap-xity) — send_unverified condition reaches the sender with the verified remedy, no non-delivery claim, and joins --json: ok"

# 8. tap-7r3fn.25: settled receipts are read from a ONE-TIME snapshot set, not a
# fork-per-file tap_is_done over the whole bus. This arm pins the SEMANTICS the
# snapshot must preserve — .done AND .cancelled both count as settled — at a
# populated receipts dir, so a snapshot that forgets .cancelled or mangles the
# basename strip reds here. Both directions: exactly the unsettled sends of mine
# appear; every settled or foreign one is excluded. (The 20k-payload speedup is
# PR evidence, not a gate wall-clock; this arm is the deterministic half.)
PARITY_HOME="$(mktemp -d)"
mkdir -p "$PARITY_HOME/payloads" "$PARITY_HOME/receipts"
pmk() { # <id> <from> — write a payload under PARITY_HOME
cat > "$PARITY_HOME/payloads/$1.md" <<EOF
---
id: $1
from: $2
to: codex
kind: discuss
path: tmp/tap/payloads/$1.md
---

body
EOF
}
# 3 unsettled sends of mine — the ONLY rows that may appear.
pmk parityme-20260904T010203Z-open00000001 parityme
pmk parityme-20260904T010203Z-open00000002 parityme
pmk parityme-20260904T010203Z-open00000003 parityme
# 2 settled sends of mine: one via .done, one via .cancelled — both excluded.
pmk parityme-20260904T010203Z-donesettled1 parityme
: > "$PARITY_HOME/receipts/parityme-20260904T010203Z-donesettled1.done"
pmk parityme-20260904T010203Z-cancsettled1 parityme
: > "$PARITY_HOME/receipts/parityme-20260904T010203Z-cancsettled1.cancelled"
# A populated receipts dir with both suffixes from a foreign sender — none may
# leak (foreign AND settled), and the bulk exercises the snapshot at some scale.
for _i in $(seq 1 50); do
  _n="$(printf '%08d' "$_i")"
  pmk "foreign-20260904T010203Z-done$_n" alice
  : > "$PARITY_HOME/receipts/foreign-20260904T010203Z-done$_n.done"
  pmk "foreign-20260904T010203Z-canc$_n" alice
  : > "$PARITY_HOME/receipts/foreign-20260904T010203Z-canc$_n.cancelled"
done
set +e
pout="$(TAP_HOME="$PARITY_HOME" "$TAP" outstanding parityme --json 2>/dev/null)"
prc="$?"
set -e
[ "$prc" -eq 2 ] || { echo "outstanding: parity expected exit 2 (3 unsettled mine), got $prc" >&2; exit 1; }
POUT="$pout" python3 -B - <<'PY' || { echo "outstanding: parity set mismatch" >&2; printf '%s\n' "$pout" >&2; exit 1; }
import json, os
d = json.loads(os.environ["POUT"])
items = d.get("outstanding") or d.get("items") or []
ids = sorted(i.get("id") for i in items)
want = sorted([
    "parityme-20260904T010203Z-open00000001",
    "parityme-20260904T010203Z-open00000002",
    "parityme-20260904T010203Z-open00000003",
])
assert ids == want, "parity: outstanding must be exactly the 3 unsettled mine, got %r" % (ids,)
PY
rm -rf "$PARITY_HOME"
echo "outstanding: 8 (tap-7r3fn.25) — settled snapshot excludes .done AND .cancelled at a populated receipts dir; exactly the unsettled sends remain: ok"

# 9. thread 3 (bot): an ordinary .read renders as an OBSERVATION with an age --
# STRENGTHENED ARM, per the fix-round plan: the defect below survived three
# partner review rounds because NO existing arm renders a .read receipt at all
# (the ladder arms in 4-7 fingerprint receipts/ and parse --json; none exercise
# the human row's read-state suffix), so the existing suite was structurally
# blind to it — nothing could red. This arm is the one that does.
# The Python helper emits by<TAB><TAB>at for a receipt with no `forced`, and
# Bash IFS-whitespace collapses the adjacent tabs, so _rf ate the timestamp and
# _rat went empty: an ordinary recipient read rendered as "read by <x> (forced)"
# with NO age — the sender's own row lying about both the force and the timing.
cat > "$TAP_HOME/payloads/claude-20260904T010203Z-readobs.md" <<'EOF'
---
id: claude-20260904T010203Z-readobs
from: claude
to: codex
kind: discuss
reply: expected
path: tmp/tap/payloads/claude-20260904T010203Z-readobs.md
---

an ask the recipient read but has not answered
EOF
printf '{"id":"claude-20260904T010203Z-readobs","at":"2026-09-04T01:02:03Z","by":"codex"}\n' \
  > "$TAP_HOME/receipts/claude-20260904T010203Z-readobs.read"
"$TAP" outstanding claude >"$TAP_HOME/out-readobs.txt" 2>&1 || true
_obs_row="$(grep '^claude-20260904T010203Z-readobs' "$TAP_HOME/out-readobs.txt" || true)"
[ -n "$_obs_row" ] || { echo "outstanding: 9 read-observed row missing entirely" >&2; cat "$TAP_HOME/out-readobs.txt" >&2; exit 1; }
case "$_obs_row" in *'(forced)'*)
  echo "outstanding: 9 an ORDINARY read rendered as forced — tab-IFS collapse ate the empty forced field: $_obs_row" >&2; exit 1 ;; esac
grep -qE 'read [0-9]+s, unanswered' <<<"$_obs_row" || {
  echo "outstanding: 9 the row must render 'read <age>, unanswered' (an observation, not an obligation): $_obs_row" >&2; exit 1; }
rm -f "$TAP_HOME/payloads/claude-20260904T010203Z-readobs.md" "$TAP_HOME/receipts/claude-20260904T010203Z-readobs.read"
echo "outstanding: 9 — an ordinary .read renders 'read <age>, unanswered', never '(forced)': ok"

# 10. thread 4 (bot): the backlog collapse still drops LOCAL per-id spooled rows --
# The dieted spool row (id · to · obligation · age · spooled…) dropped the old
# `to: <target>` marker, but the collapse filter still greps that literal, so a
# local target's rows survived beside the aggregate CONDITION and inflated the
# headline count — exactly the pile the collapse exists to prevent. Cross-team
# rows (`team/handle `) still matched by accident; local ones are the bug.
mkdir -p "$TAP_HOME/spool"
for _n in 1 2; do
  cat > "$TAP_HOME/spool/claude-20260904T01020${_n}Z-backlog${_n}.md" <<EOF
---
id: claude-20260904T01020${_n}Z-backlog${_n}
from: claude
to: codex
kind: discuss
reply: settle-only
path: $TAP_HOME/spool/claude-20260904T01020${_n}Z-backlog${_n}.md
---

spooled send ${_n} to a wedged recipient
EOF
  printf '{"target":"codex","reason":"busy","busy_pending_probes":3,"pane":"x:0.1","pane_id":"%%1","first_spooled":"2026-09-04T01:02:03Z","first_spooled_epoch":1788500000}\n' \
    > "$TAP_HOME/spool/claude-20260904T01020${_n}Z-backlog${_n}.meta.json"
done
"$TAP" outstanding claude >"$TAP_HOME/out-backlog.txt" 2>&1 || true
grep -q '^CONDITION' "$TAP_HOME/out-backlog.txt" || {
  echo "outstanding: 9 the backlog CONDITION never fired — fixture broken, not the fix" >&2
  cat "$TAP_HOME/out-backlog.txt" >&2; exit 1; }
grep -qE '^claude-20260904T01020[12]Z-backlog[12] ' "$TAP_HOME/out-backlog.txt" && {
  echo "outstanding: 9 a LOCAL-target spooled row survived beside its aggregate CONDITION — the collapse filter greps the dropped 'to: ' marker" >&2
  cat "$TAP_HOME/out-backlog.txt" >&2; exit 1; }
rm -rf "$TAP_HOME/spool"
echo "outstanding: 10 — local per-id spooled rows collapse under their CONDITION: ok"

# --- 11 — an unsanctioned reply value is named, never rendered as a note -----
# `reply: optional` passes envelope validation but is neither sanctioned value —
# and passing validation is exactly why it is NOT quarantined: tap_validate_envelope
# checks id/from/to/kind/path, not reply, so poll displays it with a reply_invalid:
# marker rather than moving it. `tap read` refuses to guess an obligation, so
# labelling it "note" here told the SENDER no answer was owed while the
# recipient's own verbs called the payload unreadable.
cat > "$TAP_HOME/payloads/claude-20260901T090000Z-unsanction01.md" <<'EOF'
---
id: claude-20260901T090000Z-unsanction01
from: claude
to: worker
kind: discuss
reply: optional
path: tmp/tap/payloads/claude-20260901T090000Z-unsanction01.md
---

body
EOF
"$TAP" outstanding claude >"$TAP_HOME/out-unsanctioned.txt" 2>&1 || true
grep -q 'unsanction01' "$TAP_HOME/out-unsanctioned.txt" || {
  echo "outstanding: 11 fixture — the row never rendered" >&2
  cat "$TAP_HOME/out-unsanctioned.txt" >&2; exit 1; }
grep -E 'unsanction01 +[^ ]+ +note ' "$TAP_HOME/out-unsanctioned.txt" >/dev/null && {
  echo "outstanding: 11 an unsanctioned reply value rendered as 'note' — the sender is told no answer is owed for a payload tap read refuses" >&2
  cat "$TAP_HOME/out-unsanctioned.txt" >&2; exit 1; }
grep -q 'unsanctioned' "$TAP_HOME/out-unsanctioned.txt" || {
  echo "outstanding: 11 the unsanctioned value is neither labelled nor diagnosed" >&2
  cat "$TAP_HOME/out-unsanctioned.txt" >&2; exit 1; }
rm -f "$TAP_HOME/payloads/claude-20260901T090000Z-unsanction01.md"
echo "outstanding: 11 — an unsanctioned reply value is named, not silently a note: ok"

echo "outstanding: ok"
