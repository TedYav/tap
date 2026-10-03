#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# seat-refresh.test.sh — CONTRACT.md §Seat refresh (`tap refresh`).
#
# `tap refresh` is a FRONTEND over `tap clear` (peer) and `/tap-self clear`
# (self); those paths have their own coverage. What is new here, and what these
# cases pin, is `--fresh`: retiring the live instance before the rebind, and the
# obligation boundary that guards it.
#
# The boundary matters because a fresh instance begins with an EMPTY obligation
# set (CONTRACT §U3). Anything unsettled at retirement is therefore orphaned —
# the sender waits on a seat that no longer exists. Refusing by default surfaces
# that; --force proceeds and tells the waiting senders. Both halves are asserted,
# because a refusal nobody can override is useless in the messy states the verb
# exists for, and an override that notifies nobody is the silent orphaning again.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "seat-refresh: $*" >&2; exit 1; }

# A flip-live fixture: tombstones are a post-flip behavior, so a pre-flip
# fixture would silently skip the retirement record and prove nothing.
setup() { # -> fresh BUS with peggy registered
  RUN="$(mktemp -d "$WORK/run.XXXXXX")"
  BUS="$RUN/repo/.tap/bus"
  mkdir -p "$BUS/payloads" "$BUS/receipts" "$RUN/repo/.tap" "$RUN/index"
  # The team must be ENROLLED, not merely present: tap refresh rebinds to the
  # acting registry before reading it (acting-registry-reader-enum), and an
  # unenrolled team makes that rebind fail — correctly. An empty teams map here
  # would test the rebind refusal, not the obligation boundary.
  python3 -B -c '
import json, sys
json.dump({"schema": "0.20", "teams": {"t": {"root": sys.argv[1], "state": "registered",
          "registry_location": sys.argv[1] + "/.tap/team-registry.json"}}},
          open(sys.argv[2], "w"))
' "$RUN/repo" "$RUN/index/global-registry.json"
  # peggy carries a pane: `tap send` refuses a pane-less, non-poll --from, and
  # the --force notice is sent AS peggy. A pane-less fixture makes every notify
  # fail for a reason that has nothing to do with the behavior under test.
  printf '%s\n' '{"schema":"0.20","seats":{"peggy":{"status":"active","instance":"peggy|abc","pane":"pp:0.0","pane_id":"%pp","harness":"claude"}}}' \
    > "$RUN/repo/.tap/team-registry.json"
  printf '{"schema": "0.20", "team":{"name":"t","worktree_root":"%s"},"seats":{"peggy":{"status":"active","instance":"peggy|abc","pane":"pp:0.0","pane_id":"%%pp","harness":"claude"}}}\n' \
    "$RUN/repo" > "$BUS/registry.json"
  export TAP_HOME="$BUS" TAP_INDEX_HOME="$RUN/index"
}
mkpayload() { # <id> <from> <to>
  printf -- '---\nid: %s\nfrom: %s\nto: %s\nkind: discuss\n---\nbody\n' "$1" "$2" "$3" > "$BUS/payloads/$1.md"
}
# Read the ACTING registry, which is what the verb mutates after its rebind —
# not the bus copy. Checking the bus file would report "still registered" no
# matter what the verb did, i.e. a control that cannot observe the change under
# test. (The first draft did exactly that and turned case 4 red for the wrong
# reason, which is the cheap version of this mistake.)
registered() { python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); print("yes" if "peggy" in (d.get("seats") or d.get("agents") or {}) else "no")' "$RUN/repo/.tap/team-registry.json"; }
tombstones() { ls "$RUN/repo/.tap/team-history" 2>/dev/null | wc -l | tr -d ' '; }

# --- (1) --fresh REFUSES on an unsettled obligation, and names it -------------
# A bare count would say something is in the way without saying what, which is
# the shape that gets --force typed reflexively. The id makes it a decision.
setup
mkpayload owed-001 peer peggy
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(1) --fresh with an unsettled obligation must exit 1, got $rc"
grep -q "owed-001" "$RUN/err" || fail "(1) the refusal did not name the blocking id: $(cat "$RUN/err")"
grep -q -- "--force" "$RUN/err" || fail "(1) the refusal did not name the override"
echo "seat-refresh: (1) --fresh refuses on unsettled obligations and names them by id: ok"

# --- (2) the refusal is NON-DESTRUCTIVE ---------------------------------------
# The whole value of refusing first is that nothing happened. A refusal that had
# already retired the instance would be a worse outcome than proceeding.
[ "$(registered)" = "yes" ] || fail "(2) the refusal removed the seat anyway"
[ "$(tombstones)" = "0" ] || fail "(2) the refusal wrote a tombstone anyway"
echo "seat-refresh: (2) a refusal leaves the seat registered and writes no tombstone: ok"

# --- (3) the seat's OWN outstanding sends also block --------------------------
# Not just the inbox: if this seat is waiting on someone, a fresh instance will
# never recognize the answer when it arrives.
setup
mkpayload mine-001 peggy peer
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(3) an outstanding SEND must also block --fresh, got rc=$rc"
grep -q "mine-001" "$RUN/err" || fail "(3) the refusal did not name the outstanding send"
echo "seat-refresh: (3) the seat's own outstanding sends block --fresh too: ok"

# --- (4) A FAILED CLEAR IS FAIL-SAFE: nothing retired, nobody told ------------
# THE ORDERING INVARIANT, observed from the failure side. Everything that
# resolves the row happens before the instance is retired, so a clear that
# cannot run must leave the world untouched. The original code had this exactly
# backwards: it retired first and then delegated a clear that could only fail,
# because the clear engine resolves its target through the registry row that
# had just been deleted. The destructive half completed and the half the verb is
# named for did not — measured as seats [peggy] -> [], one tombstone, rc=1.
#
# This fixture has no pane machinery, so the delegated clear ALWAYS fails here.
# That makes it the right home for the failure side and the wrong home for the
# success side: retirement-happened assertions need a fixture where the clear
# can succeed. THEY LIVE NOWHERE — seat-refresh-atomicity.test.sh, which owned
# that fixture, was DELETED (not moved to regress/) in a cleanup, and this comment
# pointed at it for weeks afterwards. tap-3xj1 carries the debt and the reason;
# do not read the absence as a decision, because no verdict document records
# one.
# Splitting them this way is deliberate — a fixture that cannot produce the
# precondition cannot honestly assert the postcondition.
setup
mkpayload owed-002 peer peggy
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh --force >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" != 0 ] || fail "(4) the clear cannot succeed in this fixture, yet --force reported success"
[ "$(registered)" = "yes" ] \
  || fail "(4) a FAILED clear retired the seat anyway — the destructive half ran without the half it exists for"
[ "$(tombstones)" = "0" ] \
  || fail "(4) a failed clear wrote a tombstone; retirement must not survive a refresh that did not happen"
grep -q -i "unchanged" "$RUN/err" \
  || fail "(4) the failure did not tell the operator the seat is unchanged: $(cat "$RUN/err")"
echo "seat-refresh: (4) a clear that fails retires nothing and says the seat is unchanged: ok"

# --- (5) PAYLOADS NEVER MOVE --------------------------------------------------
# Retirement is a POINTER, not a sweep. The audit trail is the reason a refresh
# is recoverable at all, and deleting mail to "clean up" would destroy exactly
# the evidence a confused successor needs.
[ -f "$BUS/payloads/owed-002.md" ] \
  || fail "(5) --force removed a payload file; retirement must be a pointer, never a sweep"
echo "seat-refresh: (5) --force leaves payload files untouched: ok"

# --- (5b) a failed clear sends NO notice --------------------------------------
# The complement of case (4). A notice says "this seat was refreshed and will not
# settle your payloads"; sending it when the refresh did not happen is a lie that
# makes the sender give up on live work. Under the old ordering the notices went
# out BEFORE the retirement and therefore before the clear, so a failed clear
# left peers falsely told — the reason notification now happens last.
[ -z "$(grep -rl "refreshed fresh" "$BUS/payloads" 2>/dev/null || true)" ] \
  || fail "(5b) a failed clear told senders the seat was refreshed; nothing was refreshed"
echo "seat-refresh: (5b) a failed clear sends no notice: ok"

# --- (6) --force alone is a usage error ---------------------------------------
# It clears obligations; without --fresh there is nothing to clear, and silently
# accepting it would teach the flag as a general-purpose override.
setup
rc=0; bash "$ROOT/bin/tap" refresh peggy --force >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(6) --force without --fresh must be a usage error, got $rc"
echo "seat-refresh: (6) --force without --fresh is refused: ok"

# --- (7) MOVED, NOT DELETED — read this before assuming it is covered ---------
# The property: --force notifies each waiting sender EXACTLY ONCE, per sender
# rather than per id, naming every orphaned payload, and stating what happened
# without instructing the sender to resend. It is the entire justification for
# --force; without it the flag is silent orphaning with extra steps.
#
# It cannot live here any more. Notification now happens AFTER a verified clear
# (the ordering invariant), and this fixture has no pane machinery, so the clear
# always fails and no notice is ever produced. Keeping the case here would leave
# it asserting against a path that can no longer run — the exact shape that made
# the original notice bug invisible, where everything around the notice was
# checked and the notice itself was not.
#
# Its home WAS seat-refresh-atomicity.test.sh, which owned a fixture where the
# clear succeeds. The original note is kept verbatim below because it turned out
# to be a receipt rather than a pointer, and deleting it would discharge the debt
# by erasing the evidence of it:
#
#   "Written down rather than assumed, because a property that moves between
#    files is a property that quietly stops being tested: if the per-sender-once
#    assertion is not present there, this comment is the record that it was
#    traded away knowingly and is owed."
#
# THE DESTINATION WAS THEN DELETED (in a cleanup), so the condition that note describes
# is the condition we are in: the per-sender-once assertion is present nowhere,
# and by its author's own terms it is OWED. It is tracked as tap-3xj1 and is not
# retirable without the human operator waiving it.
#
# Recorded because I walked into this myself: in tap-utpn I read these comments,
# believed the coverage lived where they said, and only a gate reviewer's
# independent check found otherwise. A pointer to a ghost is worse than no
# pointer, because it stops the search.
#
# What this file still pins about notices is the negative, at case (5b): a clear
# that fails tells nobody the seat was refreshed.

# --- (8) an EMPTY argv element is a usage error, never a silent parse stop -----
# `refresh "" --fresh --force` used to truncate parsing at the empty element:
# both flags were dropped and the NON-fresh arm ran with a self-resolved handle.
# The empty element itself must refuse, and nothing may clear or retire.
setup
rc=0; bash "$ROOT/bin/tap" refresh "" --fresh --force >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(8) an empty argv element must be a usage error, got rc=$rc"
grep -q "unexpected empty argument" "$RUN/err" \
  || fail "(8) the refusal did not name the empty argument: $(cat "$RUN/err")"
[ "$(registered)" = "yes" ] || fail "(8) the empty-argument refusal removed the seat"
[ "$(tombstones)" = "0" ] || fail "(8) the empty-argument refusal wrote a tombstone"
echo "seat-refresh: (8) an empty argv element refuses as usage without clearing or retiring: ok"

# --- (9) an INVALID BYTE in the acting registry blocks --fresh -----------------
# `--fresh` derives the seat's own instance by parsing the acting registry. The
# fixture stamps the obligation for an OLDER instance (peggy|older) than the
# registry's real one (peggy|abc). With a lax decode the derived scope is still
# peggy|abc, so mail stamped peggy|older is filtered as not this seat's, and
# the refresh walks past its obligations into the clear. A strict decode cannot
# derive a scope at all, so every obligation counts as the seat's own and the
# refresh refuses by name before any clear — the same boundary as case (1).
setup
printf '%s\n' '{"schema":"0.20","note":"caf'"$(printf '\xe9')"'r","seats":{"peggy":{"status":"active","instance":"peggy|abc","pane":"pp:0.0","pane_id":"%pp","harness":"claude"}}}' \
  > "$RUN/repo/.tap/team-registry.json"
printf -- '---\nid: utf8-owed-001\nfrom: peer\nto: peggy\nkind: discuss\nrecipient_instance: peggy|older\n---\nbody\n' \
  > "$BUS/payloads/utf8-owed-001.md"
cp "$RUN/repo/.tap/team-registry.json" "$RUN/reg.before"
cp "$BUS/payloads/utf8-owed-001.md" "$RUN/payload.before"
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(9) --fresh over an undecodable acting registry must refuse, got rc=$rc: $(cat "$RUN/err")"
grep -q "utf8-owed-001" "$RUN/err" \
  || fail "(9) the refusal did not name the stamped obligation: $(cat "$RUN/err")"
cmp -s "$RUN/reg.before" "$RUN/repo/.tap/team-registry.json" \
  || fail "(9) the refusal mutated the acting registry"
cmp -s "$RUN/payload.before" "$BUS/payloads/utf8-owed-001.md" \
  || fail "(9) the refusal mutated the payload"
[ "$(tombstones)" = "0" ] || fail "(9) the refusal wrote a tombstone"
[ -z "$(grep -rl "refreshed fresh" "$BUS/payloads" 2>/dev/null || true)" ] \
  || fail "(9) the refusal notified senders of a refresh that did not happen"
echo "seat-refresh: (9) an undecodable acting registry refuses --fresh and names the obligation: ok"

# --- (9b) a VALID multibyte note does not block anything -----------------------
# The line is decodability, not ASCII: é in the same field behaves exactly like
# the healthy fixture — the stamped mail filters by the seat's real scope and
# the refresh reaches its clear, which cannot succeed in this fixture.
setup
printf '%s\n' '{"schema":"0.20","note":"caf'"$(printf '\xc3\xa9')"'r","seats":{"peggy":{"status":"active","instance":"peggy|abc","pane":"pp:0.0","pane_id":"%pp","harness":"claude"}}}' \
  > "$RUN/repo/.tap/team-registry.json"
printf -- '---\nid: utf8-owed-002\nfrom: peer\nto: peggy\nkind: discuss\nrecipient_instance: peggy|older\n---\nbody\n' \
  > "$BUS/payloads/utf8-owed-002.md"
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" != 0 ] || fail "(9b) the clear cannot succeed in this fixture, yet the refresh reported success"
grep -q -i "unchanged" "$RUN/err" \
  || fail "(9b) the failure did not say the seat is unchanged: $(cat "$RUN/err")"
[ "$(registered)" = "yes" ] || fail "(9b) the failed clear retired a decodable seat"
[ "$(tombstones)" = "0" ] || fail "(9b) the failed clear wrote a tombstone"
echo "seat-refresh: (9b) a valid multibyte registry keeps the ordinary behavior: ok"

# --- (9c) a BOM-prefixed acting registry refuses on BOTH decoders --------------
# The strict reader preserves a leading BOM, so JSON.parse refuses it just as
# the lax reader always did: no scope, every obligation blocking, refusal.
setup
{ printf '\xef\xbb\xbf'; printf '%s' '{"schema":"0.20","seats":{"peggy":{"status":"active","instance":"peggy|abc","pane":"pp:0.0","pane_id":"%pp","harness":"claude"}}}'; } \
  > "$RUN/repo/.tap/team-registry.json"
printf -- '---\nid: utf8-bom-001\nfrom: peer\nto: peggy\nkind: discuss\nrecipient_instance: peggy|older\n---\nbody\n' \
  > "$BUS/payloads/utf8-bom-001.md"
cp "$RUN/repo/.tap/team-registry.json" "$RUN/reg.before"
rc=0; bash "$ROOT/bin/tap" refresh peggy --fresh >"$RUN/out" 2>"$RUN/err" || rc=$?
[ "$rc" = 1 ] || fail "(9c) --fresh over a BOM-prefixed acting registry must refuse, got rc=$rc: $(cat "$RUN/err")"
grep -q "utf8-bom-001" "$RUN/err" \
  || fail "(9c) the refusal did not name the stamped obligation: $(cat "$RUN/err")"
cmp -s "$RUN/reg.before" "$RUN/repo/.tap/team-registry.json" \
  || fail "(9c) the refusal mutated the acting registry"
[ "$(tombstones)" = "0" ] || fail "(9c) the refusal wrote a tombstone"
echo "seat-refresh: (9c) a BOM-prefixed acting registry refuses --fresh like any unreadable one: ok"

echo "seat-refresh: ok"
