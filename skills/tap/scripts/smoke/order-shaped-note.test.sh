#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# order-shaped-note.test.sh — tap-oglkh U2. Pins the body-shape guard in tap send.
#
# The incident: on 2026-09-03 five hopper work orders went out as PLAIN sends
# (settle-only) and three partners refused them as notes. The transport could not
# tell a work order from a note, because they are the same bytes to it.
#
# The AND is the design — a bead id ALONE is ordinary status prose and a
# `## Plan` heading ALONE is ordinary writing. Arms (3)-(5) are the negative
# polarities; without them a guard that fired on either half would pass every
# positive case here.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
FIX="$ROOT/skills/tap/scripts/smoke/fixtures/order-shaped"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
fail() { echo "order-shaped-note: $*" >&2; exit 1; }

new_repo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid
             git -C "$1" config user.name t; touch "$1/r"; git -C "$1" add r
             git -C "$1" commit -q -m i; }
new_repo "$WORK/TeamA"
BUS="$(cd "$WORK/TeamA" && git rev-parse --show-toplevel)/.tap/bus"
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in boss --delivery poll >/dev/null )
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hand --delivery poll >/dev/null )

send()   { ( cd "$WORK/TeamA" && bash "$TAP" send   "$@" ) ; }
assign() { ( cd "$WORK/TeamA" && bash "$TAP" assign "$@" ) ; }

# --- (1) THE REAL DISPATCH is refused, and nothing durable changed -------------
# The fixture is a verbatim copy of the 13:58Z W2 hopper row, not a sample I
# wrote: a guard tested only against prose its author invented tends to match
# that prose and nothing else.
# pipefail: `ls` on a directory the bus has not created yet fails, which makes
# the whole pipeline fail and set -e abort the file with NO message. Brace-group
# it so only the output matters.
count_in() { { ls -1 "$1" 2>/dev/null || true; } | wc -l | tr -d ' '; }
before_payloads="$(count_in "$BUS/payloads")"
before_spool="$(count_in "$BUS/spool")"
rc=0
send hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-1 >"$WORK/o1" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o1" >&2; fail "(1) the real hopper body should refuse with exit 2, got $rc"; }
grep -q 'tap assign hand' "$WORK/o1" || { cat "$WORK/o1" >&2; fail "(1) refusal did not name the assign door"; }
grep -q -- '--note' "$WORK/o1"       || { cat "$WORK/o1" >&2; fail "(1) refusal did not name the note door"; }
# Durable surfaces unchanged. NOT "no filesystem writes" — a -f - body is staged
# to $TAP_HOME/tmp before this point and cleaned; claiming zero writes would be
# false by construction.
[ ! -f "$BUS/payloads/os-1.md" ] || fail "(1) refused send wrote a canonical payload"
[ "$(count_in "$BUS/payloads")" = "$before_payloads" ] \
  || fail "(1) payloads/ changed under a refusal"
[ "$(count_in "$BUS/spool")" = "$before_spool" ] \
  || fail "(1) spool/ changed under a refusal"
[ -z "$(ls -1 "$BUS/receipts" 2>/dev/null || true)" ] || fail "(1) a receipt was written under a refusal"
# Assert the CLASS via --json. The human line is "<verb>: <detail>; next:
# <action>" and never carries error_class, so grepping the prose for it would
# fail on a correct refusal and, worse, a prose-only check would pass on ANY
# refusal from any cause.
rc=0
send hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-1j --json >"$WORK/o1j" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o1j" >&2; fail "(1) --json refusal should exit 2, got $rc"; }
python3 -B - "$WORK/o1j" <<'PY_J'
import json, sys
obj = None
for line in open(sys.argv[1]).read().splitlines():
    try: obj = json.loads(line)
    except Exception: continue
assert obj is not None, "no JSON in refusal output"
assert obj.get("ok") is False, obj
assert obj.get("error_class") == "order_shaped_note", obj
PY_J
[ ! -f "$BUS/payloads/os-1j.md" ] || fail "(1) refused --json send wrote a payload"
echo "order-shaped-note: (1) the real 13:58Z dispatch is refused, no durable effect: ok"

# --- (2) --wake does NOT buy a bypass -----------------------------------------
# Tonight's five were --wake sends. A guard that honored --wake would have
# refused none of them.
rc=0
send hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-2 --wake >"$WORK/o2" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o2" >&2; fail "(2) --wake bypassed the guard (exit $rc)"; }
# ...and neither does --fyi, the flag reached for by habit.
rc=0
send hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-2b --fyi >"$WORK/o2b" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o2b" >&2; fail "(2) --fyi bypassed the guard (exit $rc)"; }
echo "order-shaped-note: (2) neither --wake nor --fyi bypasses the guard: ok"

# --- (3) NEGATIVE: a bead id with no marker is ordinary status prose -----------
printf 'Status: tap-064xd is still parked, no news yet.\n' > "$WORK/n1.md"
send hand -f "$WORK/n1.md" --from boss --id os-3 >"$WORK/o3" 2>&1 \
  || { cat "$WORK/o3" >&2; fail "(3) a plain status note mentioning a bead was refused"; }
[ -f "$BUS/payloads/os-3.md" ] || fail "(3) status note did not send"
echo "order-shaped-note: (3) a bead id alone still sends: ok"

# --- (3b) AN INSTRUMENT THAT CANNOT ANSWER REFUSES THE SEND -------------------
# The guard's "not order-shaped" answer LICENSES an ordinary send, so a classifier
# that failed to run must not be read as that answer: a zero that licenses an
# action needs an instrument that can refuse. The incumbent's
# inline python exited 1 on an unreadable body, which is the same status as "no",
# so a broken instrument sent the message. Here the runtime is removed from PATH
# for one call: the send refuses, says so, and writes nothing.
before_3b="$(count_in "$BUS/payloads")"
rc=0
( cd "$WORK/TeamA" && PATH="/usr/bin:/bin" bash "$TAP" send hand \
    -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-3b ) >"$WORK/o3b" 2>&1 || rc=$?
# rc 1, NOT 2: the body IS order-shaped, so a working classifier refuses it with
# exit 2 and the order_shaped_note text. Asserting only "non-zero" would pass on
# that outcome too and prove nothing about the unanswerable case. Stripping the
# runtime also warns from an unrelated preflight, so the arm keys on the
# instrument's own sentence rather than on any failure having occurred.
# The Bash send body is retired (cut sprint E): with the runtime missing
# entirely, the tap-send.sh shim refuses before any send code runs, so this arm
# proves the whole-runtime-missing case.
[ "$rc" = 1 ] || { cat "$WORK/o3b" >&2; fail "(3b) expected exit 1 from the unanswerable instrument, got $rc"; }
grep -q "bun and runtime/bun/main.ts are required" "$WORK/o3b" \
  || { cat "$WORK/o3b" >&2; fail "(3b) refusal did not name the missing runtime"; }
grep -q 'order_shaped_note\|reads like a work order' "$WORK/o3b" \
  && { cat "$WORK/o3b" >&2; fail "(3b) an unanswerable classifier must not be reported as a shape verdict"; }
[ ! -f "$BUS/payloads/os-3b.md" ] || fail "(3b) unclassified send wrote a canonical payload"
[ "$(count_in "$BUS/payloads")" = "$before_3b" ] || fail "(3b) payloads/ changed under an unclassified send"
echo "order-shaped-note: (3b) a classifier that cannot answer refuses the send: ok"

# --- (4) NEGATIVE: a heading with no bead id ----------------------------------
printf '## Plan\nWe should refactor the courier one day.\n' > "$WORK/n2.md"
send hand -f "$WORK/n2.md" --from boss --id os-4 >"$WORK/o4" 2>&1 \
  || { cat "$WORK/o4" >&2; fail "(4) a heading without a bead id was refused"; }
[ -f "$BUS/payloads/os-4.md" ] || fail "(4) heading-only note did not send"
echo "order-shaped-note: (4) a marker alone still sends: ok"

# --- (5) NEGATIVE: the conjunct must come from the BODY, not the envelope ------
# A positional payload carries frontmatter. If the predicate read the whole file,
# an `id:` line would supply the bead-id half on EVERY positional send and the
# advertised AND would be half-satisfied by metadata the author never wrote.
cat > "$WORK/n3.md" <<'EOF'
---
id: tap-abcd
from: boss
to: hand
kind: discuss
---

## Plan
No bead id anywhere in this body.
EOF
send hand "$WORK/n3.md" --from boss >"$WORK/o5" 2>&1 \
  || { cat "$WORK/o5" >&2; fail "(5) frontmatter metadata supplied the bead-id conjunct"; }
echo "order-shaped-note: (5) frontmatter cannot supply a conjunct: ok"

# --- (6) NEGATIVE: shouty markers are case-sensitive on purpose ---------------
# "dispatch" and "next item" are common in ordinary prose; "DISPATCH" and
# "NEXT ITEM" are how a hopper row shouts. Matching the lowercase forms would
# refuse everyday sentences about the dispatcher.
printf 'I will dispatch tap-064xd later, just thinking out loud.\n' > "$WORK/n4.md"
send hand -f "$WORK/n4.md" --from boss --id os-6 >"$WORK/o6" 2>&1 \
  || { cat "$WORK/o6" >&2; fail "(6) lowercase 'dispatch' prose was refused"; }
echo "order-shaped-note: (6) lowercase prose markers do not fire: ok"

# --- (7) the two doors both work ----------------------------------------------
# A refusal that names doors nobody can walk through is worse than none.
assign hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-7 >"$WORK/o7" 2>&1 \
  || { cat "$WORK/o7" >&2; fail "(7) the assign door does not open"; }
grep -q '^reply: expected$' "$BUS/payloads/os-7.md" || fail "(7) assign door did not mint the obligation"
send hand -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-8 --note >"$WORK/o8" 2>&1 \
  || { cat "$WORK/o8" >&2; fail "(7) the --note door does not open"; }
grep -q '^reply: settle-only$' "$BUS/payloads/os-8.md" || fail "(7) --note did not send settle-only"
echo "order-shaped-note: (7) both doors named in the refusal actually open: ok"

# --- (8) --note cannot be combined with an ask spelling ------------------------
# Otherwise --note becomes a guard bypass that still mints an obligation.
for spell in --ask --reply --expect-reply; do
  rc=0
  send hand -f "$WORK/n1.md" --from boss --id "os-9$spell" --note "$spell" >"$WORK/o9" 2>&1 || rc=$?
  [ "$rc" = 1 ] || { cat "$WORK/o9" >&2; fail "(8) --note $spell should be a usage error, got $rc"; }
done
rc=0; assign hand -f "$WORK/n1.md" --from boss --id os-10 --note >"$WORK/o10" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$WORK/o10" >&2; fail "(8) assign should refuse --note, got $rc"; }
# ...with the ASSIGN message. The generic note/ask check would blame an --ask the
# caller never typed (assign supplies it internally), so the ORDER of the two
# refusals is load-bearing and rc alone cannot see it.
grep -q 'tap assign is a work order' "$WORK/o10" \
  || { cat "$WORK/o10" >&2; fail "(8) assign --note got the generic message, blaming an --ask the caller never typed"; }
grep -q 'either --note or --ask' "$WORK/o10" \
  && { cat "$WORK/o10" >&2; fail "(8) assign --note fell through to the generic note/ask check"; }
echo "order-shaped-note: (8) --note is exclusive with every ask spelling: ok"

# --- (9) kind=lane-request keeps its OWN advisory and is not hijacked ----------
# Its repair is --ask, keeping the kind; the two-door message would tell the
# caller to run tap assign, which would change the kind to order.
printf 'Requesting tap-064xd scope; NEXT ITEM for the lane.\n' > "$WORK/n5.md"
send hand -f "$WORK/n5.md" --from boss --id os-11 --kind lane-request >"$WORK/o11" 2>&1 \
  || { cat "$WORK/o11" >&2; fail "(9) lane-request was captured by the order-shape guard"; }
grep -q 'did you mean --ask' "$WORK/o11" \
  || { cat "$WORK/o11" >&2; fail "(9) lane-request lost its own advisory"; }
grep -q 'order_shaped_note' "$WORK/o11" \
  && { cat "$WORK/o11" >&2; fail "(9) lane-request got the wrong verb prescribed"; }
echo "order-shaped-note: (9) lane-request keeps its own advisory: ok"

# --- (10) a REPLY is never an undeclared work order --------------------------
# tap-reply.sh composes its outbound as `tap send ... --in-reply-to <id> --fyi
# --wake` — byte-for-byte the plain-note shape this guard catches. Before the
# exemption, replying with order-shaped prose exited 2 AND left the inbound
# unsettled, so the guard broke the very mechanism that discharges obligations.
( cd "$WORK/TeamA" && bash "$TAP" send boss -m "please look at this" --from hand --id inb-1 >/dev/null 2>&1 )
( cd "$WORK/TeamA" && bash "$TAP" reply inb-1 --by boss -f "$FIX/hopper-w2-2026-09-03T1358Z.md" ) >"$WORK/r1" 2>&1 \
  || { cat "$WORK/r1" >&2; fail "(10) an ordinary reply quoting a work order was refused"; }
[ -f "$BUS/receipts/inb-1.done" ] || { cat "$WORK/r1" >&2; fail "(10) the reply did not settle its inbound"; }
echo "order-shaped-note: (10) a reply carrying order-shaped prose sends and settles: ok"

# --- (11) ...and --progress keeps the inbound OPEN, as it must ----------------
# --ask, because --progress is only meaningful against a reply=expected inbound
# (it reports status while KEEPING the obligation open). A settle-only inbound
# has no obligation to keep, and tap reply refuses --progress on one.
( cd "$WORK/TeamA" && bash "$TAP" send boss -m "second one" --from hand --id inb-2 --ask >/dev/null 2>&1 )
( cd "$WORK/TeamA" && bash "$TAP" reply inb-2 --progress --by boss -f "$FIX/hopper-w2-2026-09-03T1358Z.md" ) >"$WORK/r2" 2>&1 \
  || { cat "$WORK/r2" >&2; fail "(11) a --progress reply quoting a work order was refused"; }
[ ! -f "$BUS/receipts/inb-2.done" ] || fail "(11) --progress settled the inbound; it must stay open"
echo "order-shaped-note: (11) --progress sends and leaves the obligation open: ok"

# --- (12) the lane-request exemption reads the EFFECTIVE kind -----------------
# Same message, two spellings. The flag form was exempt (arm 9) while the
# positional-frontmatter form was captured, because the guard read KIND before
# the envelope was resolved into it. Two spellings of one message must not get
# two verdicts.
cat > "$WORK/n6.md" <<'EOF'
---
id: os-12
from: boss
to: hand
kind: lane-request
---

Requesting tap-064xd scope; NEXT ITEM for the lane.
EOF
send hand "$WORK/n6.md" --from boss >"$WORK/o12" 2>&1 \
  || { cat "$WORK/o12" >&2; fail "(12) positional kind: lane-request was captured by the guard"; }
grep -q 'order_shaped_note' "$WORK/o12" \
  && { cat "$WORK/o12" >&2; fail "(12) positional lane-request got the wrong verb prescribed"; }
echo "order-shaped-note: (12) lane-request is exempt in BOTH spellings: ok"

# --- (13) --note cannot slip through the message-id --reply-to alias ----------
# That alias re-execs tap reply and rejects send-only options; NOTE was missing
# from the gate, so the flag was swallowed, the reply ran, and the inbound was
# SETTLED by a command the caller believed was a note.
#
# The gate also requires FROM_SET=0, so an arm that passes --from refuses on THAT
# term and survives deleting the --note term — my first attempt did exactly that
# and my own mutation run caught it. TAP_SELF supplies the identity instead, so
# --note is the only send-only option in play. (I had claimed this needed a
# pane-derived sender; the send reviewer showed it does not.)
( cd "$WORK/TeamA" && bash "$TAP" send boss -m "please look" --from hand --id inb-3 --ask >/dev/null 2>&1 )
rc=0
( cd "$WORK/TeamA" && TAP_SELF=boss bash "$TAP" send hand -f "$WORK/n1.md" --reply-to inb-3 --note ) >"$WORK/o13" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$WORK/o13" >&2; fail "(13) --note through the reply-to alias should be a usage error, got $rc"; }
[ ! -f "$BUS/receipts/inb-3.done" ] || fail "(13) the refused alias still settled the inbound"
# POSITIVE CONTROL: the identical command WITHOUT --note must be accepted and
# must settle the inbound. Without it, the arm cannot tell "--note was rejected"
# from "this fixture refuses the alias for some other reason".
( cd "$WORK/TeamA" && TAP_SELF=boss bash "$TAP" send hand -f "$WORK/n1.md" --reply-to inb-3 ) >"$WORK/o13b" 2>&1 \
  || { cat "$WORK/o13b" >&2; fail "(13) the same alias without --note was refused — --note is not the deciding term"; }
[ -f "$BUS/receipts/inb-3.done" ] \
  || { cat "$WORK/o13b" >&2; fail "(13) the accepted alias did not settle the inbound, so the refusal above proves nothing"; }
echo "order-shaped-note: (13) --note is rejected by the reply-to alias gate: ok"

# (14) retired with L1 U5: send no longer drains on either acceptance or refusal.
# sender-drain-isolation.test.sh covers that boundary with actual queued mail;
# arm (1) above retains the refusal's no-durable-effect assertions.

# --- (15) a valid THREE-char bead id still counts toward the shape ------------
# tap-oglkh :487 (codex P1). The bead predicate required 4-6 chars after `tap-`;
# the issue store holds 166 valid three-char ids (the tap-04n class). An
# order-shaped body citing one slipped through as a settle-only note, recreating
# the exact untracked-work shape this guard exists to prevent. The marker AND
# still gates, so arm (3)'s polarity is re-asserted: a 3-char id ALONE still sends.
printf '## Plan\nStart on tap-04n now; NEXT ITEM after.\n' > "$WORK/n7.md"
rc=0
send hand -f "$WORK/n7.md" --from boss --id os-15 >"$WORK/o15" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o15" >&2; fail "(15) an order-shaped body citing a 3-char bead (tap-04n) was not refused, got $rc"; }
printf 'Status: tap-04n is still parked, no news yet.\n' > "$WORK/n7b.md"
send hand -f "$WORK/n7b.md" --from boss --id os-15b >"$WORK/o15b" 2>&1 \
  || { cat "$WORK/o15b" >&2; fail "(15) a 3-char bead id alone (no marker) was refused"; }
echo "order-shaped-note: (15) a valid 3-char bead id counts toward the shape: ok"

# --- (16) the supervision kinds (probe/notice) are exempt from the guard ------
# tap-oglkh :469 (codex P1). watch-templates/probe.md carries the marker
# "work order", and _watch_send_probe interpolates the evaluator's
# not_done_reason — which can carry a bead id — into {{NUDGE}}. That makes a
# `--kind probe --fyi` supervision send order-shaped, so the guard refused it with
# exit 2; tap-watch.sh dispatches rc 0/1/3/5 but has no case for 2, so it retried
# the same refused probe every tick and stalled liveness supervision. This guard
# is the ONLY tap_fail 2 in tap-send.sh, so exempting the kind fully removes the
# reachable break. Built from the REAL template so an edit dropping the marker
# re-reds the positive control.
probe_body="$WORK/probe-body.md"
sed 's/{{NUDGE}}/blocked on tap-064xd — see the plan/; s/{{ARMER}}/boss/' \
  "$ROOT/skills/tap/scripts/watch-templates/probe.md" > "$probe_body"
# POSITIVE CONTROL: the identical body as a PLAIN send IS order-shaped and refused.
# If probe.md ever loses its marker this stops refusing and the arm reds here.
rc=0
send hand -f "$probe_body" --from boss --id os-16pc >"$WORK/o16pc" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o16pc" >&2; fail "(16) the probe body is not order-shaped as a plain send (marker gone from probe.md?), got $rc"; }
# The SAME body as a kind=probe supervision send is exempt and delivers.
send hand -f "$probe_body" --from boss --kind probe --fyi --id os-16 >"$WORK/o16" 2>&1 \
  || { cat "$WORK/o16" >&2; fail "(16) a kind=probe supervision send was refused by the order-shape guard"; }
[ -f "$BUS/payloads/os-16.md" ] || fail "(16) the exempt probe send did not deliver"
# ...and kind=notice too (the other reserved supervision kind).
send hand -f "$probe_body" --from boss --kind notice --fyi --id os-16n >"$WORK/o16n" 2>&1 \
  || { cat "$WORK/o16n" >&2; fail "(16) a kind=notice supervision send was refused"; }
[ -f "$BUS/payloads/os-16n.md" ] || fail "(16) the exempt notice send did not deliver"
echo "order-shaped-note: (16) probe/notice supervision kinds are exempt: ok"

# --- (17) a cross-team refusal preserves the QUALIFIED target -----------------
# tap-oglkh :501 (codex P1). Team resolution reduces `TeamB/hand` to bare `hand`
# before the refusal is rendered, so the remedy said `tap assign hand`. TeamA also
# has a `hand`, so following that advertised repair delivers to the WRONG team's
# seat. The refusal must name ORIGINAL_TO (the pre-resolution target).
# A cross-team send resolves the caller's OWN pane (tap_resolve_self_handle). Under
# the suite runner the tmux server is the isolated empty one, so that resolves to
# nothing and --from carries the identity; a bare single-file run instead hits the
# live operator tmux and stops before the guard — the documented tmux-socket-pin
# limitation (debug through the runner). Both teams are enrolled so TeamB/hand
# resolves from TeamA and the send reaches the guard.
TEAMA_ABS="$(cd "$WORK/TeamA" && pwd -P)"
new_repo "$WORK/TeamB"
TEAMB_ABS="$(cd "$WORK/TeamB" && pwd -P)"
mkdir -p "$TEAMB_ABS/.tap/bus/payloads" "$TEAMB_ABS/.tap/bus/receipts"
cat > "$TEAMB_ABS/.tap/bus/registry.json" <<JSON
{"schema":"0.20","team":{"name":"TeamB"},"seats":{"hand":{"delivery":"poll","status":"active"}}}
JSON
# TeamA's location is RESOLVED, not assumed. The primer registrations above run
# on a machine whose index is now per-file and marker-absent, so they are born
# live and create the canonical team-registry.json; the retired bus file they
# used to leave behind is never written. Naming it here seeded an enrollment
# pointing at a nonexistent store, and the send then failed at bus derivation
# ("cwd-derived bus has no acting registry", exit 1) instead of reaching the
# order-shape guard this arm is about (exit 2) — a refusal for the wrong reason,
# which is the failure mode this fixture exists to distinguish.
#
# TeamB stays on its bus path deliberately: it is hand-built above as a foreign
# team with no registration, and that path is the store that actually exists.
if [ -f "$TEAMA_ABS/.tap/team-registry.json" ]; then
  TEAMA_LOC="$TEAMA_ABS/.tap/team-registry.json"
else
  TEAMA_LOC="$TEAMA_ABS/.tap/bus/registry.json"
fi
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{
 "TeamA":{"enrolled_at":"t","registry_location":"$TEAMA_LOC","root":"$TEAMA_ABS","state":"registered"},
 "TeamB":{"enrolled_at":"t","registry_location":"$TEAMB_ABS/.tap/bus/registry.json","root":"$TEAMB_ABS","state":"registered"}
}}
JSON
rc=0
send "TeamB/hand" -f "$FIX/hopper-w2-2026-09-03T1358Z.md" --from boss --id os-17 >"$WORK/o17" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o17" >&2; fail "(17) a cross-team order-shaped send should refuse with exit 2, got $rc"; }
grep -q 'tap assign TeamB/hand' "$WORK/o17" \
  || { cat "$WORK/o17" >&2; fail "(17) the refusal dropped the team qualifier from the assign door (a bare handle would hit the wrong team's seat)"; }
grep -q 'tap send TeamB/hand --note' "$WORK/o17" \
  || { cat "$WORK/o17" >&2; fail "(17) the --note door dropped the team qualifier"; }
# NEGATIVE control: a bare 'tap assign hand' (unqualified) must NOT appear — that
# is the exact defect, and asserting only the presence above could pass if both
# strings were printed.
grep -qE 'tap assign hand( |$)' "$WORK/o17" \
  && { cat "$WORK/o17" >&2; fail "(17) the refusal still emitted the bare-handle remedy"; }
echo "order-shaped-note: (17) a cross-team refusal preserves the qualified target: ok"

echo "order-shaped-note: ok"
