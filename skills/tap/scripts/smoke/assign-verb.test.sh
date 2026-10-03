#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# assign-verb.test.sh — tap-oglkh. Pins `tap assign` as a SPEECH ACT verb.
#
# The defect this exists for is not a crash. On 2026-09-03 the leader dispatched
# five work orders with `tap send --wake` — settle-only — and three partners
# correctly refused them as notes. The flags name TRANSPORT while the author
# thinks in speech acts, so the obligation is a second decision they must
# remember. `tap assign` removes the second decision.
#
# The load-bearing property is INVARIANCE, not defaulting: the internal
# `--expect-reply --kind order` are appended AFTER the caller's argv precisely
# because the send parser is last-write-wins. Arm (2) is the one that pins that
# ordering; a version that prepends them passes every other arm here.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # never touch the real ~/.tap
fail() { echo "assign-verb: $*" >&2; exit 1; }

new_repo() { git init -q "$1"; git -C "$1" config user.email t@example.invalid
             git -C "$1" config user.name t; touch "$1/r"; git -C "$1" add r
             git -C "$1" commit -q -m i; }
new_repo "$WORK/TeamA"
BUS="$(cd "$WORK/TeamA" && git rev-parse --show-toplevel)/.tap/bus"

# Both seats are delivery:poll, so no arm here needs tmux and none can inject.
# A REGISTERED poll-mode --from may mint reply=expected (CONTRACT §Poll-mode
# delivery), which is exactly the obligation this verb is about.
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in boss --delivery poll >/dev/null )
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in hand --delivery poll >/dev/null )
printf 'Please take unit 3 and read it back.\n' > "$WORK/body.md"

assign() { ( cd "$WORK/TeamA" && bash "$TAP" assign "$@" ) ; }

# --- (1) the verb exists and stamps BOTH obligation and kind -------------------
# RED before tap-oglkh: `tap assign` is not a verb at all.
assign hand -f "$WORK/body.md" --from boss --id a-1 >"$WORK/o1" 2>&1 \
  || { cat "$WORK/o1" >&2; fail "(1) tap assign failed"; }
P="$BUS/payloads/a-1.md"
[ -f "$P" ] || fail "(1) no payload written"
grep -q '^reply: expected$' "$P" || fail "(1) assign did not stamp reply: expected — $(grep '^reply:' "$P")"
grep -q '^kind: order$'    "$P" || fail "(1) assign did not stamp kind: order — $(grep '^kind:' "$P")"
echo "assign-verb: (1) assign stamps reply=expected and kind=order: ok"

# --- (2) obligation and kind are INVARIANT, not overridable defaults -----------
# This is the ordering arm. If the internal flags were prepended instead of
# appended, last-write-wins would let the caller's --kind/--fyi win and this
# reds while (1) still passes.
assign hand -f "$WORK/body.md" --from boss --id a-2 --kind discuss >"$WORK/o2" 2>&1 \
  || { cat "$WORK/o2" >&2; fail "(2) assign with --kind discuss failed"; }
P2="$BUS/payloads/a-2.md"
grep -q '^kind: order$' "$P2" \
  || fail "(2) caller's --kind overrode the verb — got $(grep '^kind:' "$P2")"
grep -q '^reply: expected$' "$P2" || fail "(2) obligation lost when a kind was passed"
echo "assign-verb: (2) a caller's --kind cannot downgrade an assign: ok"

# --- (3) --fyi is refused, by the ASSIGN message, before any payload ------------
# A note and a work order are opposite intents. The refusal must name the verb
# the caller used; send's generic 'either --fyi or --ask' blames a flag they
# never typed.
rc=0; assign hand -f "$WORK/body.md" --from boss --id a-3 --fyi >"$WORK/o3" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "(3) --fyi on assign should exit 1, got $rc"
grep -q 'tap assign is a work order' "$WORK/o3" \
  || { cat "$WORK/o3" >&2; fail "(3) refusal did not name the assign verb"; }
[ ! -f "$BUS/payloads/a-3.md" ] || fail "(3) refused assign still wrote a payload"
# Assert the CLASS, not the prose: the human line is "<verb>: <detail>; next:
# <action>" and never carries the literal error_class, so a prose-only check
# would pass on any refusal at all — including one from a different cause.
rc=0; assign hand -f "$WORK/body.md" --from boss --id a-3j --fyi --json >"$WORK/o3j" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "(3) --fyi --json on assign should exit 1, got $rc"
python3 -B - "$WORK/o3j" <<'PY3'
import json, sys
raw = open(sys.argv[1]).read().strip().splitlines()
obj = None
for line in raw:
    try: obj = json.loads(line)
    except Exception: continue
assert obj is not None, f"no JSON in refusal output: {raw}"
assert obj.get("ok") is False, obj
assert obj.get("error_class") == "usage_error", obj
PY3
[ ! -f "$BUS/payloads/a-3j.md" ] || fail "(3) refused --json assign still wrote a payload"
echo "assign-verb: (3) --fyi refused with the assign message, no payload: ok"

# --- (4) the obligation is TRACKED on both sides -------------------------------
# The whole point of the verb: a forgotten task with no reply obligation is
# invisible to the bus. Assert it is visible from the sender AND the recipient.
# tap outstanding exits 2 WHEN OBLIGATIONS EXIST and 0 when none do
# (runtime/bun/src/slices/outstanding.ts). So rc=2 is the assertion here, not a
# tolerated failure: an assign that minted no obligation would exit 0 and this
# reds.
rc=0
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" outstanding boss ) >"$WORK/o4" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o4" >&2; fail "(4) outstanding should exit 2 with an open obligation, got $rc"; }
grep -q 'a-1' "$WORK/o4" || { cat "$WORK/o4" >&2; fail "(4) assign not listed in sender outstanding"; }
# The RECIPIENT side must prove ASK SEMANTICS, not mere presence. Greping for
# the id alone stays green even if poll renders every expected item as
# "next step: tap done" — the partner reviewer applied exactly that mutant to
# poll's obligation branch and this file still passed. So assert the
# branch a settle-only item could never reach.
rc=0
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" poll hand ) >"$WORK/o5" 2>&1 || rc=$?
[ "$rc" = 2 ] || { cat "$WORK/o5" >&2; fail "(4) poll should exit 2 with a pending payload, got $rc"; }
grep -q 'a-1' "$WORK/o5" || { cat "$WORK/o5" >&2; fail "(4) assign not visible in recipient poll"; }
grep -q 'next step: tap reply a-1' "$WORK/o5" \
  || { cat "$WORK/o5" >&2; fail "(4) poll did not present the assign as an ASK (expected a tap reply next step)"; }
grep -q 'next step: tap done a-1' "$WORK/o5" \
  && { cat "$WORK/o5" >&2; fail "(4) poll offered tap done for a work order — the obligation is untracked"; }
echo "assign-verb: (4) the obligation is tracked, and poll presents it as an ask: ok"

# --- (5) the verb is DISCOVERABLE ---------------------------------------------
# An intuitive verb nobody can find is the same defect in a different place.
bash "$TAP" help assign >"$WORK/o6" 2>&1 || fail "(5) tap help assign failed"
grep -q 'Hand someone work' "$WORK/o6" || fail "(5) help assign has no body"
bash "$TAP" help >"$WORK/o7" 2>&1 || fail "(5) tap help failed"
for v in send assign reply escalate; do
  grep -qE "^  tap $v " "$WORK/o7" || fail "(5) overview omits $v"
done
# The short overview names the verbs; detailed help owns their speech acts.
grep -qF -- '--expect-reply --kind order' "$WORK/o6" || fail "(5) help assign omits the tracked work-order contract"
bash "$TAP" help advisory >"$WORK/o7-advisory" 2>&1 || fail "(5) tap help advisory failed"
grep -qF 'Plain send = NOTE, settled by recipient tap read; --ask wants an answer' "$WORK/o7-advisory" \
  || fail "(5) advisory omits note/ask settlement semantics"
grep -qF 'ask -> tap reply' "$WORK/o7-advisory" || fail "(5) advisory omits answering asks"
echo "assign-verb: (5) assign is discoverable in help: ok"

# --- (6) an assign that cannot be answered is REFUSED, not downgraded ----------
# tap-send.sh downgrades --ask to settle-only for an unattended sender with no
# deliverable reply_to. For `tap send` that is a warning and the send still means
# something. For `tap assign` it produced the exact shape the verb exists to
# prevent — kind: order (this IS work) with reply: settle-only (nobody tracks it)
# — while help promised "always expects a reply". Found by the partner reviewer with
# a production-path probe, not by reading.
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in robot --delivery poll --unattended >/dev/null )
rc=0
assign hand -f "$WORK/body.md" --from robot --id a-6 >"$WORK/o8" 2>&1 || rc=$?
[ "$rc" != 0 ] || { cat "$WORK/o8" >&2; fail "(6) assign from an unanswerable sender should refuse, exited 0"; }
[ ! -f "$BUS/payloads/a-6.md" ] || fail "(6) refused assign still wrote a canonical payload"
grep -q 'tap assign needs a sender that can receive the reply' "$WORK/o8" \
  || { cat "$WORK/o8" >&2; fail "(6) refusal did not explain the sender problem"; }
# ...and it must not ALSO claim the send was downgraded. The send path warns
# "--ask downgraded to reply=settle-only" in this state, which is true for
# `tap send --ask` and false here: nothing was downgraded because nothing was
# sent. Printing both lines tells the operator two contradictory things about
# one command.
grep -q 'downgraded' "$WORK/o8" \
  && { cat "$WORK/o8" >&2; fail "(6) refusal also printed the downgrade warning — contradictory diagnostics"; }
echo "assign-verb: (6) an unanswerable assign is refused before placement: ok"

# --- (7) ...and the grant still works, so (6) is a refusal and not a ban -------
# The positive half matters: without it, hard-refusing EVERY unattended sender
# would also pass (6). An unattended seat WITH a deliverable reply_to owns a
# response channel, so its assign must still mint the obligation.
( cd "$WORK/TeamA" && bash "$ROOT/bin/tap" in robot2 --delivery poll --unattended --reply-to hand >/dev/null )
assign hand -f "$WORK/body.md" --from robot2 --id a-7 >"$WORK/o9" 2>&1 \
  || { cat "$WORK/o9" >&2; fail "(7) assign from an unattended sender WITH a deliverable reply_to should succeed"; }
grep -q '^reply: expected$' "$BUS/payloads/a-7.md" \
  || fail "(7) the reply_to grant was lost — got $(grep '^reply:' "$BUS/payloads/a-7.md")"
echo "assign-verb: (7) an unattended sender with a deliverable reply_to still assigns: ok"

# --- (8) the SEAM: tap assign composed through the message-id reply alias ------
# `tap help assign` promises "every other option is tap send's", and CONTRACT
# says the message-id alias forwards reply-compatible --expect-reply. Both were
# false at the seam: tap-reply.sh PARSED --expect-reply and never appended it to
# its outbound, so the nested send computed reply=settle-only and assign's own
# invariant refused it — the composition failed AND left the inbound unsettled.
#
# Nothing depended on that flag until this verb reached the composition, which is
# why a defect older than W7 surfaces here. Found by the partner reviewer's
# end-of-plan seam pass; no unit arm crossed it, because each unit was correct
# alone.
( cd "$WORK/TeamA" && bash "$TAP" send boss -m "please take this" --from hand --id a-seam --ask >/dev/null 2>&1 )
# TAP_SELF, not --from: the alias gate also requires FROM_SET=0, so passing
# --from refuses on that term and would test the wrong conjunct.
( cd "$WORK/TeamA" && TAP_SELF=boss bash "$TAP" assign hand -f "$WORK/body.md" --reply-to a-seam ) >"$WORK/o11" 2>&1 \
  || { cat "$WORK/o11" >&2; fail "(8) assign through the message-id reply alias failed"; }
[ -f "$BUS/receipts/a-seam.done" ] \
  || { cat "$WORK/o11" >&2; fail "(8) the composed assign did not settle its inbound"; }
# The outbound must carry all three: it is a reply (in_reply_to), it is work
# (kind), and it is tracked (reply). Any one alone would pass a weaker arm.
OUT="$(grep -rl '^in_reply_to: a-seam$' "$BUS/payloads" | head -1)"
[ -n "$OUT" ] || fail "(8) no outbound payload carries in_reply_to: a-seam"
grep -q '^kind: order$'     "$OUT" || fail "(8) composed outbound lost kind: order — $(grep '^kind:' "$OUT")"
grep -q '^reply: expected$' "$OUT" || fail "(8) composed outbound lost the obligation — $(grep '^reply:' "$OUT")"
echo "assign-verb: (8) assign composes through the message-id reply alias: ok"

echo "assign-verb: ok"
