#!/usr/bin/env bash
# D5: fixture-door — arm (7)'s fixture stub only; the owned waiter path is runtime/bun/test/courier-busy-hold.test.ts (native Bun port)
# tap-o4ae: fixture env (TMUX=/fake/socket, a fake tmux on PATH) must stay in this
# process. Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# courier-busy-hold.test.sh — tap-92v3r U2. A placed payload to a seat that is
# demonstrably THERE is never reported as undeliverable.
#
# THE INCIDENT. 2026-09-03 07:11:20Z, a payload to a roster driver seat — a live
# seat, mid-tool-loop, doing exactly what a working driver does. One deferred attempt,
# then five minutes of silence, then at 07:16:24Z a courier notice to the sender:
#
#     DELIVERY FAILED ... the courier stopped trying.
#     Re-send, route it another way, or drop it. It will not arrive on its own.
#
# It arrived on its own at 07:23:27Z and the recipient acted on it. The sentence was
# false, and it is worse than false: it instructs the sender to re-send, and a sender
# who obeys manufactures a duplicate for a recipient who will read the original. That
# is the retry-after-possible-effect class, produced by the courier's own notice.
#
# WHAT THIS FILE PINS: a busy live pane holds instead of terminalizing, the SAME
# untouched entry delivers exactly once when the band frees, and none of the
# neighbouring lifetimes moved.
#
# WHAT MOVED TO BUN (T1): the held-class predicate table (retired arm 10 ->
# spool-grace.test.ts), the lease-lifecycle module halves (arm 13a/b/c ->
# spool-reown.test.ts and spool-sidecar.test.ts), the held-waiter lease
# freshness and the autosettle-hold call-site gate (arms 8's freshness half and
# 12 -> spool-waiter.test.ts), the hard-drain exit (14 -> spool-waiter.test.ts),
# the readiness-class table (17 -> spool-readiness.test.ts), the live-probe
# serialization (22 -> spool-state.test.ts), the agy/modal class tables (16/23
# -> agy-band-characterization.test.ts), arm 8's termination half
# (-> spool-waiter.test.ts "hard refusal stops before another tick" and the
# escalated-exit row), arm 21's row 2 (-> spool-waiter.test.ts "missing
# payload release inherited lease"), and arm 9's held-waiter drain cadence
# (-> spool-waiter.test.ts "held entry survives expiry with a cadence floor" —
# the waiter's own pacing; the wall-clock window only re-proved it on a live
# process). What stays is the public bus behavior and arm 7, which spawns the
# real spool-waiter.ts as a fixture so the arm owns the deliverer pid — it
# observes process lifecycle through the loop's public doors and asserts no
# TypeScript internals.
#
# THREE FALSE-GREENS THIS FILE IS BUILT AGAINST, because each one would let a broken
# hold look like a working one:
#
#  (a) Proving the hold by observing a surviving spool file. `tap_spool_mark_escalated`
#      is one-way and later drains skip escalated entries, so "the file is still there"
#      is equally true of a working hold and of a zombie nothing will ever touch again.
#      Arm 2 therefore requires DELIVERY from the held entry, not survival of it.
#  (b) Proving delivery with a fresh entry. A hold that dropped the original and
#      re-parked a copy would pass a delivery check; arm 2 asserts the body arrives
#      canonical at the ORIGINAL id with no `.cancelled` receipt anywhere.
#  (c) Reading a green run as "the hold fired" when the deadline never elapsed. Arm 1
#      drives time past `deadline_epoch` explicitly and arm 5 shows the same fixture
#      DOES terminalize when the pane is gone — so a hold that simply never
#      terminalizes anything cannot pass this file.
set -euo pipefail
export TAP_TUI_SETTLE_SCALE=0.1
# The drain must be the only flush this fixture cannot see coming: no opportunistic
# drain riding a send, no detached deliverer racing an assertion. Without this, arm 2
# passed on two runs in three — a park-time deliverer was sometimes delivering h1
# before the arm looked, and sometimes holding its claim while the arm's own drain
# tried to. An intermittently-green hold arm is worse than a red one: it reads as
# "the hold works" on the run you happen to look at.
export TAP_SPOOL_DISABLE_DELIVERER=1
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

# The fake tmux is the shared stub (fake-tmux-stub.sh), also read by the Bun waiter
# tests. It began as a verbatim copy of courier-auto-settle.test.sh's: a hand-rolled
# version refused every send with server_epoch_unobservable (no `list-sessions`, no
# format-glob discriminators), so keep it whole rather than rewriting it here.
cp "$ROOT/skills/tap/scripts/smoke/fake-tmux-stub.sh" "$FAKE_BIN/tmux"
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" \
       FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
mkdir -p "$WORK/tmux" "$WORK/repo"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"; export TAP_HOME="$BUS"
write_registry() { cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
}
write_registry

# The registry's harness must AGREE with what the live pane reports, or the bound-identity
# check drifts to `gone` before any readiness question is asked — which reads as "the seat
# left" and hides whatever the arm was actually testing. Arms that switch FAKE_TMUX_CMD
# call this straight after `reset_bus`, which restores the codex default.
set_peer_harness() { # <harness>
  python3 -B - "$BUS/registry.json" "$1" <<'PY'
import json, sys
path, harness = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d["seats"]["peer"]["harness"] = harness
json.dump(d, open(path, "w"))
PY
}

LOG="$WORK/tmux/send-keys.log"; : > "$LOG"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"
# The native agy modal predicate (submit-frame.ts): 0 overlay, 1 none; a broken
# answer fails closed as an overlay, as the retired lib adapter did.
agy_overlay() {
  local r
  r="$(tap_bun_call agy-permission-overlay frame submit-frame.ts agy-permission-overlay)" || return 0
  [ "$r" != no ]
}
# shellcheck source=skills/tap/scripts/smoke/spool-readiness-fixture.sh
. "$ROOT/skills/tap/scripts/smoke/spool-readiness-fixture.sh"
tap_ensure_dirs

fail() { echo "courier-busy-hold: $*" >&2; [ -f "$LOG" ] && cat "$LOG" >&2; exit 1; }
# v0.23 (tap-7r3fn.8): the id is SLOT 3, positional, not an `id=` key, and it may
# carry a `<team>/` bus-locator prefix. Bounded on the right so one id cannot be
# satisfied by a longer id that starts with it.
injected()   { grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?$1( |:|\\]\\])" "$LOG" 2>/dev/null; }
meta_field() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$BUS/spool/$1.meta.json" "$2" 2>/dev/null || true; }
drain() { TAP_SPOOL_NOW="${1:-}" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" >/dev/null 2>&1 || true; }
reset_bus() {
  # Prior verified deliveries must not rate-limit the next arm into a window park.
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/*.done "$BUS/receipts"/*.cancelled \
         "$BUS/receipts"/*.sent "$BUS/receipts"/*.placed \
         "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* "$BUS/spool"/*.claim \
         "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  # Pane protection records are courier state the same way spool residency is:
  # a parked arm's record (or its unseeded leak) survives reset_bus's other
  # cleaning, and a live one would hold the next arm's park on the real clock
  # instead of the class this file tests. Arms that need an EXPIRED record seed
  # one after this reset (tap_protection_seed_expired).
  rm -rf "${TAP_INDEX_HOME:?}/input-protection" 2>/dev/null || true
  : > "$LOG"
  # The registry is per-arm state too. Arm 5 retires the recipient to prove a departed
  # seat still terminalizes; without this line the next arm parks against a dead row and
  # fails at setup for a reason that has nothing to do with what it tests.
  write_registry
  rm -f "$WORK"/tmux/input.* "$WORK/tmux/busy" "$WORK"/tmux/busy.* "$WORK/tmux/copy_mode" \
        "$WORK/tmux/copy_mode_stuck" "$WORK/tmux/refuse_send" "$WORK"/clear-fence/*.json 2>/dev/null || true
}
# A park of the incident's own class: an ordinary send that found the band busy, which
# is what mints deadline_source=readiness-gate.
park_busy() { # <id>
  touch "$WORK/tmux/busy.sess_0_0"
  # `--wake` IS LOAD-BEARING, and it became so after this file was written. An earlier change made a
  # plain `tap send` settle-only by default, which makes it eligible for the courier's
  # auto-settle HOLD — so the same command that used to mint `deadline_source=readiness-gate`
  # started minting `autosettle-hold`, a different lifetime with a different owner and a
  # different terminal rule. `--wake` opts the send out of that hold (§Courier deferred
  # auto-settlement) without interrupting, which is exactly the class this file is about:
  # a message someone is waiting on, parked because the band was busy.
  #
  # The premise assertion below is what caught it. It was written as ordinary
  # setup hygiene and turned out to be the thing that stopped a base change silently
  # re-pointing every arm in this file at a class it does not test — the arms would have
  # kept passing while measuring the wrong lifetime.
  bash "$TAPSH" send peer -m "held body $1" --id "$1" --from alice --wake >"$WORK/send.out" 2>&1 || true
  [ -f "$BUS/spool/$1.md" ] || fail "setup: $1 did not park (fixture premise changed); send said: $(cat "$WORK/send.out")"
  [ "$(meta_field "$1" deadline_source)" = "readiness-gate" ] \
    || { cat "$WORK/send.out" >&2; cat "$BUS/spool/$1.meta.json" >&2;
         fail "setup: $1 did not park as readiness-gate — this file is about that class"; }
}
past_deadline() { echo "$(( $(meta_field "$1" deadline_epoch) + 1 ))"; }

# ---- (1) THE INCIDENT: a busy LIVE pane past its deadline is held, not failed ----
reset_bus
park_busy h1
DEAD="$(past_deadline h1)"
drain "$DEAD"
# v0.23 (tap-7r3fn.8): `kind=` left the wire; delivery-failed is an ENVELOPE field
# now. Read the ids out of slot 3 and ask the payloads -- a stronger question than
# the wire grep, because it confirms the notice that reached the pane IS the
# delivery-failed one rather than that some sentinel carried the string.
_cbh_failed=0
for _cbh_id in $(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" 2>/dev/null | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##'); do
  grep -q '^kind: delivery-failed$' "$BUS/payloads/${_cbh_id}.md" 2>/dev/null && { _cbh_failed=1; break; }
done
[ "$_cbh_failed" = 1 ] \
  && fail "(1) the sender was told a payload to a LIVE, busy seat would never arrive — the tap-92v3r incident, reproduced"
[ ! -f "$BUS/receipts/h1.cancelled" ] \
  || fail "(1) a held entry got a terminal receipt — the sender's queue was cleared for a message still on its way"
[ -f "$BUS/spool/h1.md" ] || fail "(1) the held body left the spool without being delivered"
[ "$(meta_field h1 escalated_at)" = "" ] \
  || fail "(1) the entry was marked escalated — that mark is one-way and later drains skip it, so this is a zombie, not a hold"
echo "courier-busy-hold: (1) a busy live pane past its deadline holds instead of failing: ok"

# ---- (2) …AND THE SAME ENTRY DELIVERS ONCE WHEN THE BAND FREES ------------------
# The arm that makes arm 1 mean something. A surviving spool file proves nothing on
# its own (false-green (a)); this proves the held entry is still WORKED.
rm -f "$WORK/tmux/busy.sess_0_0"
drain "$(( DEAD + 60 ))"
injected h1 || fail "(2) the held entry never delivered after the band freed — arm 1 was holding a zombie"
[ -f "$BUS/payloads/h1.md" ] || fail "(2) delivered body was not canonicalized at its original id"
[ ! -f "$BUS/spool/h1.md" ] || fail "(2) delivered body left in the spool — retry state was not retired"
[ ! -f "$BUS/spool/h1.meta.json" ] || fail "(2) retry metadata survived delivery"
[ ! -f "$BUS/receipts/h1.cancelled" ] \
  || fail "(2) a .cancelled receipt exists for a message that was DELIVERED (false-green (b): a fresh entry delivered while the original was dropped)"
[ "$(grep -cE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?h1( |:|\\]\\])" "$LOG")" = "1" ] \
  || fail "(2) the held entry was injected $(grep -cE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?h1( |:|\\]\\])" "$LOG") times — a hold must not turn into a duplicate wake"
echo "courier-busy-hold: (2) the same held entry delivers exactly once when the band frees: ok"

# ---- (3) NO SENDER NOTICE IS MINTED WHILE AN ENTRY IS HELD ----------------------
# Option (a), and it is a correctness constraint rather than a style choice.
# The sender notice (spool-deadline.ts `notifySenderOnEscalate`) names payloads/<id>.md, and that path exists
# only because terminalize promotes the body immediately after. A "still queued"
# notice followed by a hold hands the sender a pointer to a file that is not there.
reset_bus
park_busy h2
drain "$(past_deadline h2)"
grep -qE 'kind=(delivery-failed|notice)' "$LOG" \
  && fail "(3) a notice was sent about a held entry — no honest notice exists while the body is spool-only"
[ ! -f "$BUS/payloads/h2.md" ] \
  || fail "(3) the held body was promoted to canonical without being delivered"
if grep -rF 'will not arrive' "$BUS/payloads" "$BUS/spool" --include='*.md'; then
  fail "(3) a live held recipient was described as permanent non-delivery"
fi
echo "courier-busy-hold: (3) a held entry mints no sender notice and promotes nothing: ok"

# ---- (4) BUSY-WITH-A-DRAFT: the forced deadline attempt DELIVERS, and backs up ----
# ONE OBSERVABLE CONTRACT, asserted unconditionally. The first version of this arm
# accepted "injected OR still spooled" and only checked the draft backup if injection
# happened, which the partner reviewer correctly held as hiding the behaviour rather
# than describing it: a build that skipped the overdue attempt entirely passed, and so
# did a build that dropped busy:pending from the presence predicate.
#
# The contract this arm now pins, chosen because it is what the code does and what the
# existing deadline design intends: at the deadline `due=1` forces one real redelivery
# even against a busy pane, and for busy:pending that attempt takes the clobber
# pipeline — back up the human's draft, clear the band, inject — and succeeds. So the
# entry DELIVERS. The tap-92v3r property still holds and is asserted beside it: the
# sender is never told a live seat's message will not arrive.
#
# The input-protection hold design parks a draft ONCE, for its visible grace — it does not hold
# forever. The drain is built to deliver once the grace is over (draftGraceSatisfied
# converts the pending-input park into an inject), so this arm runs the forced attempt
# against an EXISTING, EXPIRED record, exactly the state a production park leaves when
# the countdown lapses. The fixture's park mints no record, so the seed below writes
# the expired one through the product's own writer; without it the drain's first look
# mints a FRESH 30 s grace and the arm silently pins a hold instead of a delivery.
reset_bus
park_busy h3
# The draft replaces the busy marker BEFORE the drain, so the pane the drain probes is
# live-with-a-draft rather than generating. Written the other way round first — draft
# added but busy cleared only after the deadline was computed — and the entry simply
# delivered, because for one probe the pane was neither busy nor drafted. The arm was
# describing a state the fixture never entered.
printf 'a human is mid-sentence' > "$WORK/tmux/input.sess_0_0"
rm -f "$WORK/tmux/busy.sess_0_0"
[ "$(spool_pane_ready_fixture "sess:0.0" "%401" peer t "$BUS/registry.json" "")" = "busy:pending" ] \
  || fail "(4) fixture premise: the pane is not busy:pending, so this arm would not be about a human draft"
bash -c 'set -euo pipefail; . "$1"; tap_protection_seed_expired --pane %401 --epoch srv:4242:100 --harness codex --home "$2" --id h3 --draft "a human is mid-sentence"' _ "$LIB" "$BUS" \
  || fail "(4) could not seed the expired park-time record — the drain would mint a fresh grace instead of facing the expired one"
drain "$(past_deadline h3)"
# v0.23 (tap-7r3fn.8): `kind=` left the wire; delivery-failed is an ENVELOPE field
# now. Read the ids out of slot 3 and ask the payloads -- a stronger question than
# the wire grep, because it confirms the notice that reached the pane IS the
# delivery-failed one rather than that some sentinel carried the string.
_cbh_failed=0
for _cbh_id in $(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" 2>/dev/null | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##'); do
  grep -q '^kind: delivery-failed$' "$BUS/payloads/${_cbh_id}.md" 2>/dev/null && { _cbh_failed=1; break; }
done
[ "$_cbh_failed" = 1 ] \
  && fail "(4) a seat holding a human draft was reported undeliverable — it is present, just protected"
[ ! -f "$BUS/receipts/h3.cancelled" ] \
  || fail "(4) a terminal receipt was written for a seat that is present"
injected h3 \
  || fail "(4) the forced deadline attempt did not run against a busy:pending pane — the due gate is what makes this class deliver rather than hold"
[ -f "$BUS/payloads/h3.md" ] || fail "(4) the delivered body was not canonicalized"
[ ! -f "$BUS/spool/h3.md" ] || fail "(4) retry state survived a completed delivery"
# The human's draft is what the clobber pipeline exists to protect, so the retained
# backup is not optional. Asserted as a FILE, not as restored band text: the in-band
# restore goes through tmux load-buffer/paste-buffer, which this fixture's fake does
# not implement, so a band assertion here would be measuring the fake. The retained
# file is the recovery authority the pipeline itself names (`tap draft`).
grep -rq 'a human is mid-sentence' "$BUS/input-backups" 2>/dev/null \
  || fail "(4) the forced deadline attempt clobbered a human draft with no retained backup — the pipeline's whole purpose"
echo "courier-busy-hold: (4) a busy:pending pane takes the forced deadline attempt, delivers, and retains the human's draft: ok"

# ---- (5) A SEAT THAT IS ACTUALLY GONE STILL TERMINALIZES (the discriminator) -----
# Without this, a hold that never terminalizes ANYTHING would pass every arm above
# (false-green (c)). Same fixture, same class, same elapsed deadline — only the
# recipient's presence differs, which is the fact the whole change turns on.
reset_bus
park_busy h4
python3 -B - "$BUS/registry.json" <<'PY' || fail "(5) could not retire the recipient"
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["peer"]["status"] = "inactive"
json.dump(reg, open(sys.argv[1], "w"))
PY
drain "$(past_deadline h4)"
# v0.23 (tap-7r3fn.8): `kind=` left the wire; delivery-failed is an ENVELOPE field
# now. Read the ids out of slot 3 and ask the payloads -- a stronger question than
# the wire grep, because it confirms the notice that reached the pane IS the
# delivery-failed one rather than that some sentinel carried the string.
_cbh_failed=0
for _cbh_id in $(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" 2>/dev/null | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##'); do
  grep -q '^kind: delivery-failed$' "$BUS/payloads/${_cbh_id}.md" 2>/dev/null && { _cbh_failed=1; break; }
done
[ "$_cbh_failed" = 1 ] \
  || fail "(5) a payload to a seat that LEFT THE ROSTER was held instead of failing — the hold must not swallow real non-delivery"
grep -F 'It will not arrive on its own.' "$BUS/payloads/${_cbh_id}.md" >/dev/null \
  || fail "(5) the gone-seat notice lost its reserved terminal wording"
echo "courier-busy-hold: (5) a departed recipient still terminalizes: ok"

# ---- (6) A LIVE PANE IN ANY NON-TERMINAL STATE HOLDS, not just busy:noprompt ----
# The state-transition case, and the one that broke the first version of this fix.
# readiness (spool-readiness.ts `readinessWalk`) returns `gone`/`unsafe` BEFORE its bound-identity check and
# every other value AFTER it — so plain `busy` (copy-mode, or a blocked/exempt seat)
# is emitted about a pane whose identity just matched. It is a live seat.
#
# The first predicate was an ALLOWLIST of busy:noprompt and busy:pending, and
# The partner reviewer refuted it with this shape: park an entry while the pane is
# generating, then put the still-bound pane into a copy-mode whose cancel refuses, then
# advance past the deadline. The probe reads `busy`, which the allowlist did not
# contain, and a live pane was told undeliverable. An allowlist has to be re-derived
# every time a busy:* value is added and its failure mode is a false delivery failure;
# the predicate now names the terminal states instead.
#
# THE PANE'S STATE CHANGES BETWEEN PARK AND DEADLINE, deliberately. A fixture that was
# in copy-mode the whole time would park for a different reason and never exercise the
# transition this arm is about.
reset_bus
park_busy h5
rm -f "$WORK/tmux/busy.sess_0_0"
: > "$WORK/tmux/copy_mode"; : > "$WORK/tmux/copy_mode_stuck"
[ "$(spool_pane_ready_fixture "sess:0.0" "%401" peer t "$BUS/registry.json" "")" = "busy" ] \
  || fail "(6) fixture premise: the pane does not classify plain 'busy', so this arm is not about the state it claims"
drain "$(past_deadline h5)"
# v0.23 (tap-7r3fn.8): `kind=` left the wire; delivery-failed is an ENVELOPE field
# now. Read the ids out of slot 3 and ask the payloads -- a stronger question than
# the wire grep, because it confirms the notice that reached the pane IS the
# delivery-failed one rather than that some sentinel carried the string.
_cbh_failed=0
for _cbh_id in $(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" 2>/dev/null | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##'); do
  grep -q '^kind: delivery-failed$' "$BUS/payloads/${_cbh_id}.md" 2>/dev/null && { _cbh_failed=1; break; }
done
[ "$_cbh_failed" = 1 ] \
  && fail "(6) a LIVE pane in copy-mode was told its message would never arrive — the allowlist defect"
[ ! -f "$BUS/receipts/h5.cancelled" ] \
  || fail "(6) a terminal receipt was written for a live pane in copy-mode"
[ -f "$BUS/spool/h5.md" ] || fail "(6) the entry left the spool"
rm -f "$WORK/tmux/copy_mode" "$WORK/tmux/copy_mode_stuck"
echo "courier-busy-hold: (6) a live pane in copy-mode holds, not fails (the allowlist-vs-denylist case): ok"

# ---- (6b) A READY PANE WHOSE ATTEMPT FAILED PRE-EFFECT IS NOT TERMINAL ----------
# The fall-through the partner reviewer found, and the reason the first inversion still
# carved out `ready`. Its justification was "a ready pane is delivered to, so the
# caller never reaches here with ready" — and the caller does: the attempt runs, the
# redelivery returns a PRE-EFFECT rc 1 (identity drift, a copy-mode transition, a
# failed sentinel reconstruction, an rc-4 submit defer), and the deadline decision is
# reached with `ready` still in hand. His probe terminalized a positively live pane
# after a failure that had no effect at all.
#
# The fixture drives it the way production does: the pane classifies ready, and the
# submit loses its pane identity observation after promotion but before a key.
# A failed send-keys would instead be a possible effect and could not prove this case.
reset_bus
park_busy h7
rm -f "$WORK/tmux/busy.sess_0_0"
: > "$WORK/tmux/refuse_identity"
[ "$(spool_pane_ready_fixture "sess:0.0" "%401" peer t "$BUS/registry.json" "")" = "ready" ] \
  || fail "(6b) fixture premise: the pane is not ready, so this arm is not about the ready fall-through"
drain "$(past_deadline h7)"
# v0.23 (tap-7r3fn.8): `kind=` left the wire; delivery-failed is an ENVELOPE field
# now. Read the ids out of slot 3 and ask the payloads -- a stronger question than
# the wire grep, because it confirms the notice that reached the pane IS the
# delivery-failed one rather than that some sentinel carried the string.
_cbh_failed=0
for _cbh_id in $(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" 2>/dev/null | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##'); do
  grep -q '^kind: delivery-failed$' "$BUS/payloads/${_cbh_id}.md" 2>/dev/null && { _cbh_failed=1; break; }
done
[ "$_cbh_failed" = 1 ] \
  && fail "(6b) a READY pane was told its message would never arrive after a pre-effect failure — the ready carve-out"
[ ! -f "$BUS/receipts/h7.cancelled" ] \
  || fail "(6b) a terminal receipt was written after a failure with no effect"
[ -f "$BUS/spool/h7.md" ] || fail "(6b) the entry left the spool"
[ -f "$WORK/tmux/identity-refused" ] || fail '(6b) the armed pre-effect refusal did not occur'
[ ! -e "$BUS/receipts/h7.attempted" ] || fail '(6b) pre-effect refusal minted attempt evidence'
rm -f "${WORK:?}/tmux/refuse_identity" "${WORK:?}/tmux/identity-refused"
echo "courier-busy-hold: (6b) a ready pane whose attempt failed pre-effect stays retryable: ok"

# The lifetime controls below hold below an explicit force-probe threshold.
# Default force-after-three behavior is exercised separately in arms 18–20.
# Prove the held state itself so a slower drain cannot make mere PID survival pass.
assert_held_waiter_fixture() { # <id> <private trace directory>
  # A due attempt moves the body to canonical before a busy submit reparks it.
  # Inspect under that attempt's claim so residency is a stable observation.
  # The arms change TAP_HOME after sourcing lib.sh; bind its claim helper locally.
  local TAP_SPOOL="$TAP_HOME/spool" _tries=0 _proof_rc=0
  # A loaded runner may not have completed the waiter's first drain after the
  # fixed sleep. Wait for the asserted state, releasing custody between looks.
  while [ "$_tries" -lt 100 ]; do
    if [ "$(tap_bun_call spool-sidecar "$1" spool-sidecar.ts claim "$TAP_SPOOL" "$1" "")" = acquired ]; then
      _proof_rc=0
      python3 -B - "$TAP_HOME" "$1" "$TAP_SPOOL_FORCE_PROBES" > "$2/held-proof.log" 2>&1 <<'HELD_FIXTURE' \
        || _proof_rc=$?
import json, pathlib, sys, time
bus, ident, threshold = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
meta = json.loads((bus / "spool" / f"{ident}.meta.json").read_text())
assert meta["deadline_source"] == "readiness-gate", meta
assert meta["deadline_epoch"] < time.time(), meta
assert 0 < meta.get("busy_live_probes", 0) < threshold, meta
assert (bus / "spool" / f"{ident}.md").is_file(), meta
assert not (bus / "payloads" / f"{ident}.md").exists(), meta
HELD_FIXTURE
      rm -f "${TAP_SPOOL:?}/$1.claim"
      [ "$_proof_rc" -ne 0 ] || return 0
    fi
    _tries=$((_tries + 1)); command sleep 0.05
  done
  [ ! -f "$2/held-proof.log" ] || cat "$2/held-proof.log" >&2
  [ ! -f "$2/deliver.log" ] || cat "$2/deliver.log" >&2
  fail "held-waiter fixture $1 did not reach its post-deadline, below-force state"
}

# ---- (7) THE REAL DELIVERER DELIVERS A HELD ENTRY, with no test-authored drain ----
# Every arm above disables the deliverer for determinism and drains by hand. That is
# right for testing the POLICY and wrong for testing who carries it out — and the gap
# between those two is where the partner reviewer found this defect. The deliverer's
# deadline branch exists so a park that reached its end terminalizes while a waiter is
# alive to escalate; tap-92v3r changed what "reached its end" means for this class, so
# a waiter that still exits at the deadline retires the only process scheduled to look
# again. His probe ran the real deliverer, let it exit, freed the band, drained
# nothing, and the entry never arrived.
#
# THIS ARM CALLS NO DRAIN AFTER FREEING THE BAND. That absence is the assertion. It
# runs in its own subshell with its own bus so the deliverer it enables cannot outlive
# the arm and race the others.
(
  set -euo pipefail
  unset TAP_SPOOL_DISABLE_DELIVERER
  # A short deadline and a fast cadence: the arm is about ownership across the
  # deadline, not about the 300s production value.
  export TAP_SPOOL_FORCE_PROBES=1000 TAP_SPOOL_BUSY_DEADLINE_SECONDS=1 TAP_SPOOL_DELIVERER_DELAYS="0.2"
  D2="$(mktemp -d)"; mkdir -p "$D2/tmux" "$D2/repo"
  # KILL AUTHORITY COMES FROM THE SPAWN, NEVER FROM A PATTERN (no-pattern-kills).
  #
  # The first version of this arm let the park spawn its own deliverer and then found
  # the pid with `pgrep -f "tap-spool-deliverer.sh h6"`. The partner reviewer held that
  # Critical and he is right: a sandboxed HOME and TAP_HOME do not partition the
  # process table, so that pattern can select — and kill — a deliverer belonging to
  # another focused run, another checkout, or a real user whose payload id happens to
  # be `h6`. It is exactly the incident tap-jptfa records, written by someone who had
  # read the rule and checked their own diff against it an hour earlier.
  #
  # So the park runs with the automatic spawn DISABLED, this arm calls the production
  # spawn helper itself, and `$!` is the only pid it will ever signal.
  _d2pid=""
  cleanup7() {
    if [ -n "$_d2pid" ]; then kill "$_d2pid" 2>/dev/null || true; wait "$_d2pid" 2>/dev/null || true; fi
    # `|| true`, for the same reason every owned-waiter teardown here carries it: the owned waiter is
    # signalled above, but a drain it had already forked can still be writing into
    # $D2 when this runs, and `rm -rf` then exits non-zero on a directory that
    # repopulated under it. Under `set -euo pipefail` that teardown failure IS the
    # file's exit status, so a passing arm reports FAIL.
    #
    # I fixed exactly this in the ownership arm when I saw it once under a mutation, and did not
    # grep for the class — so arm 7 kept the bare form and reded the whole file under
    # suite concurrency, after eight green focused runs. Both teardowns now tolerate
    # the race; neither hunts the extra pids by pattern, and they exit on their own
    # when the scratch bus disappears.
    rm -rf "$D2" 2>/dev/null || true
  }
  trap cleanup7 EXIT
  export FAKE_TMUX_STATE="$D2/tmux" FAKE_WORKTREE="$D2/repo"
  BUS2="$D2/repo/.tap/bus"; mkdir -p "$BUS2/payloads" "$BUS2/receipts" "$BUS2/spool"
  export TAP_HOME="$BUS2"
  sed "s|$WORK/repo|$D2/repo|g" "$BUS/registry.json" > "$BUS2/registry.json"
  LOG2="$D2/tmux/send-keys.log"; : > "$LOG2"

  touch "$D2/tmux/busy.sess_0_0"
  # Park with no automatic waiter, so the ONLY deliverer in this arm is the one spawned
  # on the next line and held in $!.
  TAP_SPOOL_DISABLE_DELIVERER=1 bash "$TAPSH" send peer -m "owned hold" --id h6 --from alice --wake >/dev/null 2>&1 || true
  [ -f "$BUS2/spool/h6.md" ] || fail "(7) h6 did not park"

  # The production waiter, started by this arm and owned by it. Spawned through the
  # same script the production helper execs, so the behaviour under test is the real
  # one; what differs is only that we hold its pid.
  nohup env -u TAP_SPOOL_DRAIN_ACTIVE \
    bun "$ROOT/runtime/bun/src/spool-waiter.ts" h6 >>"$D2/deliver.log" 2>&1 &
  _d2pid=$!

  # Let the deadline pass with the pane still busy. Under the pre-fix code the waiter
  # exits here; under the fix it stays because the entry is held rather than terminal.
  _t=0
  while [ "$_t" -lt 60 ]; do
    [ -f "$BUS2/receipts/h6.cancelled" ] && fail "(7) the held entry was terminalized while its recipient was live"
    _t=$((_t + 1))
    command sleep 0.1
  done
  if ! kill -0 "$_d2pid" 2>/dev/null; then
    _waiter_rc=0
    wait "$_d2pid" || _waiter_rc=$?
    printf 'courier-busy-hold: (7) waiter pid=%s exit=%s observed_at=%s\n' \
      "$_d2pid" "$_waiter_rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    cat "$D2/deliver.log" >&2
    for _state in "$BUS2/spool/h6.meta.json" "$BUS2/spool/h6.meta.json.reown"; do
      if [ -f "$_state" ]; then printf '%s\n' "$_state" >&2; cat "$_state" >&2; fi
    done
    fail "(7) the owned waiter exited while the entry remained held"
  fi
  assert_held_waiter_fixture h6 "$D2"

  # Free the band. NOTHING below drains — if the entry arrives, a production owner
  # delivered it.
  rm -f "$D2/tmux/busy.sess_0_0"
  _t=0
  while [ "$_t" -lt 100 ]; do
    grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?h6( |:|\\]\\])" "$LOG2" 2>/dev/null && break
    _t=$((_t + 1))
    command sleep 0.1
  done
  grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?h6( |:|\\]\\])" "$LOG2" 2>/dev/null \
    || fail "(7) the band freed and no production owner delivered the held entry — the deliverer exited at the deadline the hold decided to outlive"
  [ -f "$BUS2/payloads/h6.md" ] || fail "(7) delivered body was not canonicalized"
) || exit 1
echo "courier-busy-hold: (7) a production deliverer carries a held entry across its deadline and delivers when the band frees: ok"

# ---- (11) A HELD ENTRY DOES NOT STARVE YOUNGER READY MAIL -------------------------
# The effect the drain-cap refund exists to produce, asserted as an effect rather than
# the mechanism. This loop is oldest-first under TAP_SPOOL_DRAIN_CAP and already exempts
# two classes for exactly this reason, each saying so in its own comment (lib.sh
# 3423-3425, escalated: "attempts stayed 0 for days behind escalated junk"; 3528-3533,
# auto-settle hold). tap-92v3r added a third entry that leaves the loop having delivered
# nothing, and it took a slot per tick per held entry.
#
# TWO RECIPIENTS, AND THAT IS THE WHOLE FIXTURE. The first version of this arm parked
# both entries against ONE pane and then freed the band — which cannot produce the
# state it claims, because freeing the band un-holds the older entry too. It reddened,
# and reading it as "the refund is broken" would have been wrong: the fixture could not
# create starvation at all. Starvation needs an entry that STAYS held (a busy
# recipient) and a younger entry that is deliverable NOW (a different, free recipient).
#
# CAP=1 is what makes it discriminating: at the default 8 a single held entry is
# invisible, and the starvation only shows when the held entry can consume the whole
# budget — the shape a busy seat with several parked messages produces in production.
(
  set -euo pipefail
  export TAP_SPOOL_DISABLE_DELIVERER=1
  export TAP_SPOOL_DRAIN_CAP=1
  D6="$(mktemp -d)"; mkdir -p "$D6/tmux" "$D6/repo"
  trap 'rm -rf "$D6" 2>/dev/null || true' EXIT
  export FAKE_TMUX_STATE="$D6/tmux" FAKE_WORKTREE="$D6/repo"
  BUS6="$D6/repo/.tap/bus"; mkdir -p "$BUS6/payloads" "$BUS6/receipts" "$BUS6/spool"
  export TAP_HOME="$BUS6"
  # bob is the second recipient: his pane is never busy, so his mail is deliverable the
  # moment the drain reaches it.
  python3 -B - "$BUS6/registry.json" "$D6/repo" <<'PY'
import json, sys
path, root = sys.argv[1:3]
seat = lambda pane, pid: {"session": "sess", "pane": pane, "pane_id": pid, "harness": "codex",
                          "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1",
                          "registered_from_worktree": root}
json.dump({"schema": "0.20", "team": {"name": "t", "worktree_root": root},
           "seats": {"peer": seat("sess:0.0", "%401"), "alice": seat("sess:0.1", "%402"),
                      "bob": seat("sess:0.2", "%403")}}, open(path, "w"))
PY
  LOG6="$D6/tmux/send-keys.log"; : > "$LOG6"

  # OLDER, and held: peer's pane is busy and stays busy for the whole arm.
  touch "$D6/tmux/busy.sess_0_0"
  bash "$TAPSH" send peer -m "older held" --id s1 --from alice --wake >"$D6/send1.out" 2>&1 || true
  [ -f "$BUS6/spool/s1.md" ] || fail "(11) s1 did not park; send said: $(cat "$D6/send1.out")"
  _dl="$(python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("deadline_epoch") or "")
except Exception: print("")' "$BUS6/spool/s1.meta.json")"
  [ -n "$_dl" ] || fail "(11) s1 carries no deadline, so it can never reach the held branch"

  # YOUNGER, and deliverable: parked only because bob's pane is briefly busy, then freed.
  touch "$D6/tmux/busy.sess_0_2"
  bash "$TAPSH" send bob -m "younger ready" --id s2 --from alice --wake >"$D6/send2.out" 2>&1 || true
  [ -f "$BUS6/spool/s2.md" ] || fail "(11) s2 did not park; send said: $(cat "$D6/send2.out")"
  rm -f "$D6/tmux/busy.sess_0_2"
  : > "$LOG6"

  # One tick past s1's deadline, cap=1. s1 is older so the loop reaches it first.
  TAP_SPOOL_NOW="$(( _dl + 1 ))" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
    _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1 || true

  # Fixture premise: s1 must still be held, or this proves nothing about starvation.
  [ -f "$BUS6/spool/s1.md" ] \
    || fail "(11) the older entry left the spool — it was not held during the tick, so the cap was never contended"
  grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?s2( |:|\\]\\])" "$LOG6" \
    || fail "(11) the younger, deliverable entry did not deliver in a tick where an older HELD entry was present at cap=1 — the held entry consumed the only slot, which is the starvation lib.sh exempts two other classes to avoid"
) || exit 1
echo "courier-busy-hold: (11) a held entry does not consume the drain slot younger ready mail needs: ok"

# ---- (13) THE .reown LEASE HAS A LIFECYCLE (tap-nj22m U1) --------------------------
# Codex thread `tap-spool-deliverer.sh:214`: the lease is created before every
# readiness-gate waiter's first drain and deleted by NOTHING. `tap_spool_remove`
# (lib.sh) unlinks payload and meta only; the stale-sidecar reaper (spool-sidecar.ts `reap`) scans
# `*.meta.json.lock` and `*.claim`. So every send that ever parks leaks one inode
# permanently, on a bus that runs for weeks.
#
# THE LEASE IS OWNER-QUALIFIED. Its first landing armed three effects together;
# (a) own-exit removal and (b) successor survival now live in the Bun suite
# (spool-reown.test.ts: release unlinks only on token match, and a successor's
# lease survives a stale release), and (c) terminalization removal is pinned by
# spool-sidecar.test.ts ("removal takes payload, metadata and lease together").
# What stays here is the door the Bun suite cannot own:
#
# (b) is why the lease carries an owner token rather than being an empty mtime file: an
# exiting waiter cannot otherwise tell its own stale lease from a successor's fresh one,
# and deleting the successor's reopens the multi-owner defect the lease token exists to close.
(
  set -euo pipefail
  export TAP_SPOOL_DISABLE_DELIVERER=1
  D8="$(mktemp -d)"; mkdir -p "$D8/tmux" "$D8/repo"
  trap 'rm -rf "$D8" 2>/dev/null || true' EXIT
  export FAKE_TMUX_STATE="$D8/tmux" FAKE_WORKTREE="$D8/repo"
  BUS8="$D8/repo/.tap/bus"; mkdir -p "$BUS8/payloads" "$BUS8/receipts" "$BUS8/spool"
  export TAP_HOME="$BUS8"
  sed "s|$WORK/repo|$D8/repo|g" "$BUS/registry.json" > "$BUS8/registry.json"
  : > "$D8/tmux/send-keys.log"

  # (d) CANCEL IS A TERMINALIZATION TOO (tap-92v3r U2d). Codex thread
  # `lib.sh:1809`: `tap cancel --spooled` removed `$spool_meta` and
  # `$spool_payload.claim` and nothing else, so a cancelled entry left its
  # `.reown` behind — the same permanent leak (c) closes for the drain path,
  # reached through a second door.
  #
  # THE FIX IS THE ROUTING, NOT THE UNLINK, but routing is NOT mutation-armed here.
  # A partner replaced `tap_spool_remove` with inline unlinks of every asserted file
  # and this arm stayed green, as it must: file absence cannot prove which lock guarded
  # the removal. The routing rests on the design argument in lib.sh:1756-1763.
  # `tap_spool_reown_after_repark` can otherwise observe a payload being terminalized,
  # mint a successor owner for an entry about to stop existing, and write a FRESH
  # `.reown` after the inline unlink. Keep this warning even though the assertions
  # below cannot stage that interleaving.
  #
  # THE ARCHIVE ASSERTION IS THE ORDER CONTROL, and it is not decoration. For a
  # spooled entry `payload` IS `$spool_payload` (tap-cancel.sh:84), the same path
  # `tap_spool_remove` unlinks. The routed call must therefore stay AFTER the `mv`
  # at tap-cancel.sh:447-449: the archive renames that inode first, so the unlink
  # finds nothing and the evidence survives. Move the call above the `mv` and the
  # body is destroyed — the exact incident tap-cancel.sh:440-443 records. Without
  # this line the arm is green on that edit.
  touch "$D8/tmux/busy.sess_0_0"
  bash "$TAPSH" send peer -m "cancel me" --id L3 --from alice >"$D8/s3.out" 2>&1 || true
  [ -f "$BUS8/spool/L3.md" ] || fail "(13d) L3 did not park; send said: $(cat "$D8/s3.out")"
  _t3="$(bash -c 'set -euo pipefail; . "$1"; tap_bun_call spool-reown L3 spool-reown.ts claim "$TAP_SPOOL" L3 20' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh")"
  [ -n "$_t3" ] && [ -f "$BUS8/spool/L3.meta.json.reown" ] \
    || fail "(13d) precondition: the reown claim minted no lease, so this arm would pass on an entry that never had one to leak"
  bash "$TAPSH" cancel L3 --spooled --by alice >"$D8/c3.out" 2>&1 \
    || fail "(13d) tap cancel --spooled failed: $(cat "$D8/c3.out")"
  [ ! -f "$BUS8/spool/L3.meta.json.reown" ] \
    || fail "(13d) tap cancel --spooled left <id>.meta.json.reown behind — cancel is a second door onto the leak (c) closes for the drain"
  [ ! -f "$BUS8/spool/L3.meta.json" ] \
    || fail "(13d) cancel left the meta behind — the routing dropped work cancel already did, and a drain can rebuild the entry"
  [ ! -f "$BUS8/spool/L3.claim" ] \
    || fail "(13d) cancel left its acquired queue claim behind"
  [ -f "$BUS8/archive/L3.cancelled.md" ] \
    || fail "(13d) the withdrawn body was not archived — the routed removal ran BEFORE the mv at tap-cancel.sh:447-449 and destroyed the only copy (the incident :440-443 records)"
) || exit 1
echo "courier-busy-hold: (13) cancel is a terminalization too: the routed removal reaps the .reown lease and archives the body: ok"

# ---- (15) rc 5 DOES NOT REFUND THE DRAIN SLOT (tap-nj22m U3) -----------------------
# Codex thread `lib.sh:3622`: my refund tests `_held_slot`, `delivered` and `ready` —
# none of which changes at terminal rc 5 — once a staged-idle hold has expired,
# `_tap_spool_native redeliver` has removed the spool payload and metadata. So
# the slot is refunded for an entry that no longer exists, and a backlog of overdue entries all going rc 5 processes the
# whole set in one invocation instead of the bounded cap.
#
# THE SAME-ID RACE, asked by the partner and answered rather than guarded against:
# `tap_canonical_place` (lib.sh:4244, 4248) dies on a duplicate id while the payload
# exists or a `.done` receipt is present, and rc 5 PRESERVES the canonical. So a fresh
# same-id park in that window is not reachable through the supported send path — the
# duplicate-ID refusal IS the answer, and binding residency to an entry identity would
# be machinery for a race that cannot occur. What the refund must still stop doing is
# keying on a STALE `ready`: the predicate becomes redeliver_rc != 5 AND both spool
# payload and meta still resident AND current readiness proves presence.
(
  set -euo pipefail
  export TAP_SPOOL_DISABLE_DELIVERER=1
  export TAP_SPOOL_DRAIN_CAP=1
  DA="$(mktemp -d)"; mkdir -p "$DA/tmux" "$DA/repo"
  trap 'rm -rf "$DA" 2>/dev/null || true' EXIT
  export FAKE_TMUX_STATE="$DA/tmux" FAKE_WORKTREE="$DA/repo"
  BUSA="$DA/repo/.tap/bus"; mkdir -p "$BUSA/payloads" "$BUSA/receipts" "$BUSA/spool"
  export TAP_HOME="$BUSA"
  python3 -B - "$BUSA/registry.json" "$DA/repo" <<'PY'
import json, sys
path, root = sys.argv[1:3]
seat = lambda pane, pid: {"session": "sess", "pane": pane, "pane_id": pid, "harness": "codex",
                          "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1",
                          "registered_from_worktree": root}
json.dump({"schema": "0.20", "team": {"name": "t", "worktree_root": root},
           "seats": {"peer": seat("sess:0.0", "%401"), "alice": seat("sess:0.1", "%402"),
                      "bob": seat("sess:0.2", "%403")}}, open(path, "w"))
PY
  LOGA="$DA/tmux/send-keys.log"; : > "$LOGA"

  # An older entry that will go submit-unverified at its forced deadline attempt: the
  # pane accepts the paste but never clears the id, which is what rc 5 means.
  touch "$DA/tmux/busy.sess_0_0"
  bash "$TAPSH" send peer -m "goes rc5" --id R1 --from alice --wake >"$DA/s1.out" 2>&1 || true
  [ -f "$BUSA/spool/R1.md" ] || fail "(15) R1 did not park; send said: $(cat "$DA/s1.out")"
  _dl="$(python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("deadline_epoch") or "")
except Exception: print("")' "$BUSA/spool/R1.meta.json")"
  [ -n "$_dl" ] || fail "(15) R1 carries no deadline"

  # A younger entry to a DIFFERENT, free recipient, so cap contention is real.
  touch "$DA/tmux/busy.sess_0_2"
  bash "$TAPSH" send bob -m "younger" --id R2 --from alice --wake >/dev/null 2>&1 || true
  [ -f "$BUSA/spool/R2.md" ] || fail "(15) R2 did not park"
  rm -f "$DA/tmux/busy.sess_0_2"

  # Make R1's redelivery land but never clear. The first rc 5 now holds a
  # possibly staged wire for one bounded idle window; expire that hold to
  # exercise the terminal rc-5 slot accounting this arm owns.
  rm -f "$DA/tmux/busy.sess_0_0"
  : > "$DA/tmux/stuck_submit"
  : > "$LOGA"
  TAP_SPOOL_NOW="$(( _dl + 1 ))" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
    _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1 || true
  [ -f "$BUSA/spool/R1.md" ] || fail "(15) first unverified pass did not retain the staged-idle hold"
  _staged_dl="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["deadline_epoch"])' "$BUSA/spool/R1.meta.json")"
  : > "$LOGA"
  TAP_SPOOL_NOW="$(( _staged_dl + 1 ))" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
    _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1 || true

  # FIXTURE PREMISE: R1 must actually have gone rc 5 — its spool payload and meta gone.
  # Without this the arm could pass on a run where rc 5 never happened.
  [ ! -f "$BUSA/spool/R1.md" ] \
    || fail "(15) fixture premise: R1 is still spooled, so it did not go submit-unverified and this arm is not about rc 5"
  # THE ASSERTION: the slot R1 consumed must NOT have been refunded, so at cap=1 the
  # younger entry does not also deliver in that same tick.
  # `if`-form, not `A && fail`: this assertion is the LAST statement in its subshell, and
  # there a trailing AND-list exits with A's status — so the PASSING branch (grep finds
  # nothing) would exit 1 and read as RED. Written that way, this arm could never go green
  # no matter what the fix did. Position is what makes the difference, so the idiom used by
  # the mid-arm assertions above is correct there and wrong here.
  if grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?R2( |:|\\]\\])" "$LOGA"; then
    fail "(15) both entries delivered in one tick at cap=1 — the rc-5 entry refunded a slot after its payload and metadata were already removed, so a backlog of submit-unverified entries drains without bound"
  fi
) || exit 1
echo "courier-busy-hold: (15) an rc-5 submit-unverified entry does not refund the drain slot: ok"

# ---- (18) N=3 POST-DEADLINE LIVE OBSERVATIONS (ruling 15 item 2; injection side open in tap-bjiii) ----
# An operator watched the courier flash its warn at a seat repeatedly while it
# was mid-turn. It was not wedged, it was working. A readiness-gate park never sets
# `due` — that requires reason_class=busy — so it holds for as long as the band stays
# unreadable, which for a working seat is indefinitely. The hold was the tap-92v3r fix
# and it is only half an answer: not lying to the sender is not the same as delivering.
#
# THE BOUND IS 3 AND THE ARM PROVES THE COUNTING SIDE OF IT. Each post-deadline look
# banks exactly one live observation (probes 1 -> 2 -> 3); nothing durably counting
# the looks would leave the bound unreachable or unauditable.
#
# INJECTION SIDE — CURRENT BEHAVIOR, PENDING tap-bjiii. The generating band is a
# READABLE, UN-CLEARABLE band: the third look's force still runs the submit path, but
# The input-protection clearDraft withhold currently refuses it — the clobber pipeline ends failed
# over model output it could not clear ("input remains after bounded clear attempts;
# sentinel withheld, backup retained", deliver.ts:458) and the submit returns
# unverified (courier.ts:1441). Whether ruling 15's force SHOULD key over uncleared
# model output is an open product question (tap-bjiii); this arm records what the
# code does today, it does not rule it. The bound's force remains the delivery door
# for UNREADABLE bands, where no clobber runs and forceNoPrompt admits the inject
# (courier.ts:1465, detail in NO_SPOOL_ATTEMPTS_ON). For this class the mail is not
# lost: the entry stays queued and spool-resident, and delivery lands when the turn
# ends and the band clears — the band-frees delivery pinned by (2) and the waiter
# carry in (7). The fixture's park mints no record and the seed below writes the
# EXPIRED record the real clock would have left, so the hold pinned here is the
# clobber's verdict, not a protection grace (the gate passes: no live record exists).
(
  set -euo pipefail
  reset_bus
  park_busy F1
  bash -c 'set -euo pipefail; . "$1"; tap_protection_seed_expired --pane %401 --epoch srv:4242:100 --harness codex --home "$2" --id F1 --draft "model is generating a response..."' _ "$LIB" "$BUS" \
    || fail "(18) could not seed the expired park-time record — the first look would mint a fresh grace and the arm would pin a protection hold, not the clobber verdict"
  _dl="$(meta_field F1 deadline_epoch)"
  [ -n "$_dl" ] || fail "(18) fixture premise: F1 has no deadline_epoch, so there is no post-deadline observation to count"
  _past=$(( _dl + 60 ))
  drain "$_past"
  injected F1 && fail "(18) F1 delivered on the FIRST post-deadline look — the bound is 3 observations, and forcing on one is not a bound"
  [ "$(meta_field F1 busy_live_probes)" = 1 ] \
    || fail "(18) after one post-deadline live observation busy_live_probes is '$(meta_field F1 busy_live_probes)', not 1 — nothing durable is counting the looks, so the bound cannot be reached or audited"
  drain "$_past"
  injected F1 && fail "(18) F1 delivered on the SECOND look — N=3 is the ruling's number"
  [ "$(meta_field F1 busy_live_probes)" = 2 ] \
    || fail "(18) after two post-deadline live observations busy_live_probes is '$(meta_field F1 busy_live_probes)', not 2 — the count must track every look"
  drain "$_past"
  [ "$(meta_field F1 busy_live_probes)" = 3 ] \
    || fail "(18) after three post-deadline live observations busy_live_probes is '$(meta_field F1 busy_live_probes)', not 3 — the bound is reached and the count shows it"
  injected F1 && fail "(18) F1 injected while the generating band stayed readable — the input-protection clearDraft withhold currently refuses the force over output it could not clear (current behavior, pending tap-bjiii)"
  [ -f "$BUS/spool/F1.md" ] \
    || fail "(18) F1 left the spool — the refusal must keep the entry queued for the turn's end, not drop it"
  [ ! -f "$BUS/receipts/F1.cancelled" ] \
    || fail "(18) F1 was terminalized rather than queued — the sender is still being told a live seat is unreachable"
) || exit 1
echo "courier-busy-hold: (18) three post-deadline live observations bank 1-2-3 and, under the input-protection clearDraft withhold, the force currently refuses over the readable generating band, keeping F1 queued for the turn's end (open question: tap-bjiii): ok"

# ---- (19) A RECOGNIZED MODAL IS NEVER FORCED, AT ANY N -----------------------------
# The one hold ruling 15 leaves standing. Without this arm "be more aggressive" has no
# floor and the next change types over a human's pending decision.
#
# HONEST ABOUT WHAT IT PROVES: this property is trivially true before the force path
# exists, because nothing forces at all. Its value is entirely as a guard on the change
# in arm 18, so it is mutation-proven against that path rather than against BASE.
#
# AND ONE MUTATION RESULT WORTH CARRYING, because it says what this arm does NOT show.
# Three places refuse to force on a modal — the probe counter, the drain's second look,
# and the submit gate. Removing the counter exclusion reds this arm's busy_live_probes
# assertion. Removing EITHER of the other two alone reds nothing, because the remaining
# two still refuse; removing all three reds the injection assertion below with its own
# message. So this arm covers the property and does not pin the individual guards, and a
# reader who mutates one of them and sees green has found redundancy rather than dead
# code. lib.sh records the same fact at the re-validation site.
(
  set -euo pipefail
  reset_bus
  export FAKE_TMUX_CMD=agy
  set_peer_harness agy
  park_busy M1
  _rule="$(printf '─%.0s' $(seq 1 60))"
  printf '%s\n' "  working" "$_rule" "> " "$_rule" \
                "Requesting permission for: run_shell_command" \
                "Do you want to proceed?" "Yes · No · Tab amend" > "$WORK/tmux/capture.sess_0_0"
  _dl="$(meta_field M1 deadline_epoch)"; _past=$(( _dl + 60 ))
  for _i in 1 2 3 4 5; do drain "$_past"; done
  injected M1 \
    && fail "(19) a payload was typed into a pane showing a permission dialog, after five post-deadline looks — the modal is the only hold the ruling leaves, and the bound swallowed it"
  [ ! -f "$BUS/receipts/M1.cancelled" ] \
    || fail "(19) a held modal entry was terminalized — a modal holds WITH A REASON and is retried; it is never a delivery-failed"
  [ "$(meta_field M1 busy_live_probes)" = "" ] || [ "$(meta_field M1 busy_live_probes)" = 0 ] \
    || fail "(19) modal observations accumulated busy_live_probes='$(meta_field M1 busy_live_probes)' — a class that can never force must not bank credit toward forcing, or removing the modal at look four forces immediately"
  rm -f "$WORK/tmux/capture.sess_0_0"
) || exit 1
echo "courier-busy-hold: (19) a recognized modal holds at every N and is never terminalized: ok"

# ---- (20) THE COUNTER MEANS WHAT ITS NAME SAYS -------------------------------------
# `busy_live_probes` authorizes forcing, so every way of inflating it is a way of
# forcing early. Three inflations are refused here, and each one was reachable:
#   (a) a PRE-deadline look. The entry is inside its normal wait; counting those spends
#       the bound before the deadline the bound is measured from.
#   (b) `busy_pending_probes` is NOT widened. It counts typed-text wedges and feeds the
#       backlog CONDITION; merging the two would make a wedge report fire on ordinary
#       mid-suite traffic, and make a wedge authorize a force.
#   (c) a departed seat. `gone` is terminal — forcing at a pane that is not there is
#       typing into whatever took the pane id.
#
# THIS ARM IS GREEN BEFORE THE COUNTER EXISTS, and that is worth stating rather than
# leaving for a reader to discover. Every assertion here is a negative — "this did not
# move" — and an absent field satisfies all three for free. So a RED->GREEN transition
# proves nothing about it, and its three halves are mutation-proven individually against
# the increment site instead: each mutation that widens the counter must red the half
# that names that widening, and a mutation that reds a DIFFERENT half means the arm is
# not measuring what its message says.
(
  set -euo pipefail
  reset_bus
  park_busy C1
  _dl="$(meta_field C1 deadline_epoch)"
  drain "$(( _dl - 30 ))"
  [ "$(meta_field C1 busy_live_probes)" = "" ] || [ "$(meta_field C1 busy_live_probes)" = 0 ] \
    || fail "(20a) a PRE-deadline look incremented busy_live_probes to '$(meta_field C1 busy_live_probes)' — the bound is three POST-deadline observations, and counting the ordinary wait spends it before the clock starts"

  # (b) the wedge counter is a different question and must not have moved.
  _past=$(( _dl + 60 )); drain "$_past"
  [ "$(meta_field C1 busy_pending_probes)" = "" ] || [ "$(meta_field C1 busy_pending_probes)" = 0 ] \
    || fail "(20b) busy_pending_probes moved to '$(meta_field C1 busy_pending_probes)' on a busy:noprompt look — the wedge counter deliberately ignores that class, and widening it makes the backlog condition fire on healthy mid-suite traffic"

  # (c) a departed seat never accumulates, however many times it is looked at.
  reset_bus
  park_busy G1
  _dl="$(meta_field G1 deadline_epoch)"; _past=$(( _dl + 60 ))
  python3 -B - "$BUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["seats"]["peer"]["status"] = "retired"
json.dump(d, open(p, "w"))
PY
  drain "$_past"; drain "$_past"; drain "$_past"; drain "$_past"
  injected G1 \
    && fail "(20c) a payload was typed at a pane whose seat has left the roster — 'gone' is terminal, and forcing there types into whatever now holds that pane id"
  [ "$(meta_field G1 busy_live_probes)" = "" ] || [ "$(meta_field G1 busy_live_probes)" = 0 ] \
    || fail "(20c) a departed seat accumulated busy_live_probes='$(meta_field G1 busy_live_probes)' — only a LIVE observation may pay toward the bound"
) || exit 1
echo "courier-busy-hold: (20) busy_live_probes counts only post-deadline live looks, and does not widen the wedge counter: ok"

# ---- (24) THE HELD-ENTRY REFUND IS BOUNDED (tap-92v3r U2a) --------------------------
# A drain has two readiness passes: Phase A necessarily probes every spooled entry,
# while Phase B is the cap-governed work pass. A fixed probe ceiling would therefore
# measure the backlog as much as the refund. Calibrate that irreducible term with a
# pre-deadline pass, where Phase B is capped, then compare the same 6-to-12 backlog
# growth after every entry is held. A bounded refund leaves the two deltas equal; an
# unconditional refund makes Phase B scale too.
(
  set -euo pipefail
  # Keep the force threshold above every measured pass so held entries cannot turn
  # into deliveries midway through the probe relation.
  export TAP_SPOOL_DRAIN_CAP=2 TAP_SPOOL_FORCE_PROBES=1000

  measure_backlog() { # <entry-count>
    local count="$1" i id now first_deadline=0 last_deadline=0 probes=0 held=0 live
    reset_bus
    for i in $(seq 1 "$count"); do
      id="u2a-${count}-${i}"
      park_busy "$id"
      now="$(meta_field "$id" deadline_epoch)"
      { [ "$first_deadline" -eq 0 ] || [ "$now" -lt "$first_deadline" ]; } && first_deadline="$now"
      [ "$now" -gt "$last_deadline" ] && last_deadline="$now"
    done

    # Before every deadline, no entry can refund. This measures Phase A's unavoidable
    # backlog scaling plus the constant cap-governed Phase B work.
    FAKE_TMUX_PROBE_LOG="$WORK/u2a-${count}.early.probes"; export FAKE_TMUX_PROBE_LOG
    : > "$FAKE_TMUX_PROBE_LOG"
    TAP_SPOOL_NOW="$((first_deadline - 1))" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
      _ "$LIB" >/dev/null 2>&1 || true
    U2A_EARLY_PROBES="$(wc -l < "$FAKE_TMUX_PROBE_LOG" | tr -d ' ')"

    now=$((last_deadline + 1))
    U2A_NOW="$now"

    FAKE_TMUX_PROBE_LOG="$WORK/u2a-${count}.held.probes"; export FAKE_TMUX_PROBE_LOG
    : > "$FAKE_TMUX_PROBE_LOG"
    TAP_SPOOL_NOW="$now" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
      _ "$LIB" >/dev/null 2>&1 || true
    probes="$(wc -l < "$FAKE_TMUX_PROBE_LOG" | tr -d ' ')"
    unset FAKE_TMUX_PROBE_LOG

    for i in $(seq 1 "$count"); do
      id="u2a-${count}-${i}"
      live="$(meta_field "$id" busy_live_probes)"
      [ -n "$live" ] || live=0
      if [ -f "$BUS/spool/$id.md" ] && [ "$(meta_field "$id" deadline_source)" = readiness-gate ] \
         && [ "$(meta_field "$id" deadline_epoch)" -le "$now" ] && [ "$live" -ge 1 ]; then
        held=$((held + 1))
      fi
    done
    U2A_HELD_PROBES="$probes"
    U2A_HELD="$held"
  }

  measure_backlog 6
  early6="$U2A_EARLY_PROBES"; probes6="$U2A_HELD_PROBES"; held6="$U2A_HELD"
  [ "$held6" -gt 1 ] \
    || fail "(24) premise: only $held6 of 6 entries reached the post-deadline held path — the refund bound is not exercised"

  measure_backlog 12
  early12="$U2A_EARLY_PROBES"; probes12="$U2A_HELD_PROBES"; held12="$U2A_HELD"
  [ "$held12" -gt 1 ] \
    || fail "(24) premise: only $held12 of 12 entries reached the post-deadline held path — the refund bound is not exercised"

  baseline_delta=$((early12 - early6))
  held_delta=$((probes12 - probes6))
  [ "$baseline_delta" -gt 0 ] \
    || fail "(24) premise: pre-deadline backlog growth produced no readiness-probe delta ($early6 -> $early12), so the Phase-A calibration is vacuous"
  [ "$held_delta" -eq "$baseline_delta" ] \
    || fail "(24) growing the backlog 6 -> 12 added $held_delta probes once fully held ($probes6 -> $probes12), versus the calibrated pre-deadline delta $baseline_delta ($early6 -> $early12) — the refund made Phase B scale beyond its cap"

  # Bounded work must rotate, not pin every later drain to the same oldest prefix.
  # Find one entry the first held pass did not reach, then require the next pass to
  # reach it. Otherwise the bound trades an expensive drain for permanent starvation.
  missed=""
  for i in $(seq 1 12); do
    id="u2a-12-${i}"
    live="$(meta_field "$id" busy_live_probes)"; [ -n "$live" ] || live=0
    if [ "$live" -eq 0 ]; then missed="$id"; break; fi
  done
  [ -n "$missed" ] \
    || fail "(24) premise: the bounded held pass left no deferred entry, so next-drain fairness is not exercised"
  marked=0
  for i in $(seq 1 12); do
    visits="$(meta_field "u2a-12-${i}" held_drain_visits)"; [ -n "$visits" ] || visits=0
    [ "$visits" -gt 0 ] && { marked=1; break; }
  done
  [ "$marked" -eq 1 ] \
    || fail "(24) fairness mark never advanced for a visited held entry — the ordering has no durable round to read"
  before="$(meta_field "$missed" busy_live_probes)"; [ -n "$before" ] || before=0
  TAP_SPOOL_NOW="$U2A_NOW" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' \
    _ "$LIB" >/dev/null 2>&1 || true
  after="$(meta_field "$missed" busy_live_probes)"; [ -n "$after" ] || after=0
  [ "$after" -gt "$before" ] \
    || fail "(24) $missed missed the bounded first pass and still was not retried on the next drain — the refund budget starves the backlog behind the oldest prefix"

  # A fairness mark belongs to the HELD state, not to the entry forever. Make the
  # oldest entry accumulate a mark, then free its pane and put exactly `cap` fresh
  # ready entries ahead of it under the visit-count sort. The Phase A readiness pass
  # sees the whole spool, so it must clear the stale mark before Phase B applies its
  # cap; otherwise sustained cap-sized arrivals can starve the now-deliverable old id.
  reset_bus
  park_busy u2a-mixed-0-old
  old_now="$(past_deadline u2a-mixed-0-old)"
  drain "$old_now"
  old_visits="$(meta_field u2a-mixed-0-old held_drain_visits)"; [ -n "$old_visits" ] || old_visits=0
  [ "$old_visits" -gt 0 ] \
    || fail "(24) mixed-state premise: the old held entry acquired no visit mark, so a permanent penalty is not exercised"

  park_busy u2a-mixed-1-fresh
  park_busy u2a-mixed-2-fresh
  # Keep the two fresh entries out of digest planning. The old standard entry remains
  # Phase A's sole ready candidate, which is exactly where its stale mark is cleared.
  python3 -B - "$BUS/spool/u2a-mixed-1-fresh.meta.json" "$BUS/spool/u2a-mixed-2-fresh.meta.json" <<'PY'
import json, os, sys, tempfile
for path in sys.argv[1:]:
    meta = json.load(open(path, encoding="utf-8"))
    meta["policy"] = "urgent"
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tap-u2a-policy-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)
PY
  rm -f "$WORK/tmux/busy.sess_0_0"
  : > "$LOG"
  drain "$old_now"
  [ ! -f "$BUS/spool/u2a-mixed-0-old.md" ] && injected u2a-mixed-0-old \
    || fail "(24) a formerly-held old entry stayed behind a full cap of fresh ready mail — its visit mark became a permanent starvation penalty"
  echo "courier-busy-hold: (24 evidence) bounded refund: early $early6->$early12, held $probes6->$probes12"
) || exit 1
echo "courier-busy-hold: (24) deferred held mail rotates, and a freed old entry sheds its mark before fresh mail can starve it: ok"
echo "courier-busy-hold: ok"
