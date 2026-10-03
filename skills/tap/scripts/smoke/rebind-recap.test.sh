#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# rebind-recap.test.sh — CONTRACT.md §Rebind recap (seat-refresh lane).
#
# A REBIND is a fresh instance of an existing seat: same handle, no memory. It is
# what `tap refresh` produces, and the recap is why refreshing is safe at all —
# the obligations survived on the bus, so the successor can be re-pointed at
# them. These cases pin what the recap must CONTAIN (ids it inherited) and, just
# as load-bearing, what it must NOT claim (any reconstruction of work state).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
RECAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "rebind-recap: $*" >&2; exit 1; }

BUS="$WORK/repo/.tap/bus"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
export TAP_HOME="$BUS" TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
printf '%s\n' '{ "schema": "0.20", "team": { "name": "t", "worktree_root": "'"$WORK/repo"'" }, "seats": {} }' > "$BUS/registry.json"

mkpayload() { # <id> <from> <to> <kind> <first-line> [settled]
  local id="$1" from="$2" to="$3" kind="$4" body="$5" settled="${6:-}"
  cat > "$BUS/payloads/$id.md" <<EOF
---
id: $id
from: $from
to: $to
kind: $kind
---
$body
EOF
  [ -z "$settled" ] || : > "$BUS/receipts/$id.done"
}

# Two obligations the successor INHERITS, one settled item it does not, and one
# send of its own still awaiting a reply.
mkpayload "peer-001" peer peggy discuss "First unsettled thing peggy owes an answer to"
mkpayload "peer-002" peer peggy assign "Second unsettled thing"
mkpayload "peer-003" peer peggy discuss "Already handled; must NOT appear as owed" settled
mkpayload "peggy-100" peggy peer discuss "Something peggy asked and is still waiting on"

OUT="$WORK/recap.out"
bash "$RECAP" recap peggy --limit 5 >"$OUT" 2>&1 || fail "(setup) recap exited nonzero: $(tail -3 "$OUT")"

# --- (1) inherited obligations appear, BY ID ----------------------------------
# The id is the whole point: it is what the successor can act on. A count alone
# ("you have 2 obligations") would be strictly worse than silence, since it
# tells a fresh instance it owes something without saying what.
# Scope the POSITIVE to the obligations section too, for the same reason the
# negative below is scoped: every id also appears under recent exchanges, so a
# whole-file grep passes even when the obligations list is empty. A first draft
# did exactly that and survived a mutation that deleted the inbox entirely —
# the assertion was reading history and calling it coverage.
_owed="$(awk '/^unsettled inbound/,/^your outstanding/' "$OUT")"
for id in peer-001 peer-002; do
  grep -q "$id" <<<"$_owed" \
    || fail "(1) recap omitted inherited obligation '$id' from the OBLIGATIONS section"
done
# The same scoping protects the negative: a settled payload SHOULD still appear
# under recent exchanges — that is history, and history is honest. The defect
# would be listing it as OWED.
grep -q "peer-003" <<<"$_owed" \
  && fail "(1) recap listed a SETTLED payload as OWED — a successor would chase a closed obligation"
grep -q "peer-003" "$OUT" \
  || fail "(1) recap dropped a settled payload from recent exchanges too; history should still show it"
echo "rebind-recap: (1) inherited unsettled obligations are listed by id; settled ones are not: ok"

# --- (2) the successor's own outstanding sends appear -------------------------
# Distinct from the inbox: these are things OTHERS owe the seat. A recap that
# showed only the inbox would leave the successor unaware it is waiting on
# anyone, and it would re-ask.
# Scoped to the OUTSTANDING section for the same reason case (1) is scoped:
# peggy-100 also appears under recent exchanges, so a whole-file grep passes
# with the outstanding list empty. This assertion was written unscoped and was
# therefore reading history and calling it coverage — the third instance of that
# shape in this lane, and the reason the scoping is now applied everywhere
# rather than only where a mutation happened to expose it.
_sent="$(awk '/^your outstanding/,/^recent exchanges/' "$OUT")"
grep -q "peggy-100" <<<"$_sent" \
  || fail "(2) recap omitted the seat's own outstanding send 'peggy-100' from the OUTSTANDING section"
echo "rebind-recap: (2) the seat's own outstanding sends are listed: ok"

# --- (3) PATHS are handed over, not just ids ----------------------------------
# A fresh instance cannot read what it cannot open. The path is the difference
# between a pointer and a rumour.
grep -q "$BUS/payloads/peer-001.md" "$OUT" \
  || fail "(3) recap named an obligation without its payload path"
echo "rebind-recap: (3) payload paths accompany the ids: ok"

# --- (4) an EMPTY recap is a real answer, not an error ------------------------
# "You owe nothing" is information a fresh instance needs. Exiting nonzero, or
# printing nothing, would read as breakage and invite a retry loop.
EMPTY="$WORK/empty.out"
rc=0; bash "$RECAP" recap nobody-here --limit 5 >"$EMPTY" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "(4) an empty recap must exit 0, got $rc"
grep -qi "none" "$EMPTY" || fail "(4) an empty recap must SAY it is empty, not print nothing"
echo "rebind-recap: (4) an empty recap exits 0 and says so: ok"

# --- (5) the recap must NOT claim to restore work state -----------------------
# THE LOAD-BEARING NEGATIVE. Coordination state is recoverable from the bus;
# what the predecessor was building and why is not. A recap that implied
# otherwise would hand a fresh instance a plausible reconstruction it has no way
# to verify — worse than an honest pointer, and worst for the reader least able
# to notice. The close must name where that state actually lives.
grep -qi "beads and PRs" "$OUT" \
  || fail "(5) the recap does not name where work-state rationale lives; a successor may assume this output is complete"
grep -qi "coordination state" "$OUT" \
  || fail "(5) the recap does not scope itself to coordination state"
echo "rebind-recap: (5) the recap scopes itself and names where work-state rationale lives: ok"

# --- (6) --json is machine-shaped and carries the same three sets -------------
JOUT="$WORK/recap.json"
bash "$RECAP" recap peggy --json >"$JOUT" 2>/dev/null || fail "(6) --json recap failed"
python3 -B -c '
import json, sys
d = json.load(open(sys.argv[1]))
assert d["ok"] is True, d
assert {m["id"] for m in d["inbox"]} == {"peer-001", "peer-002"}, d["inbox"]
assert {m["id"] for m in d["outstanding"]} == {"peggy-100"}, d["outstanding"]
assert d["history"], "history must not be empty"
' "$JOUT" || fail "(6) --json shape wrong: $(cat "$JOUT")"
echo "rebind-recap: (6) --json carries inbox, outstanding, and history as data: ok"

# --- (7) INSTANCE SCOPING: a fresh instance never inherits predecessor mail ---
# KTD-16, and the reason `--fresh` is safe at all. `tap done` filters settlement
# by (handle, recipient_instance), so naming a predecessor's id here would hand
# the successor an obligation it CANNOT settle — it would chase the id, get a
# refusal, and read that as breakage. The recap's whole promise is "these are
# yours"; a stale id breaks that promise while looking exactly like keeping it.
IWORK="$WORK/inst"
IBUS="$IWORK/repo/.tap/bus"
mkdir -p "$IBUS/payloads" "$IBUS/receipts" "$IWORK/repo/.tap" "$IWORK/index"
python3 -B -c '
import json, sys
root = sys.argv[1]
json.dump({"schema": "0.20", "teams": {"t": {"root": root, "state": "registered",
          "registry_location": root + "/.tap/team-registry.json"}}}, open(sys.argv[2], "w"))
' "$IWORK/repo" "$IWORK/index/global-registry.json"
printf '%s\n' '{"schema":"0.20","seats":{"peggy":{"status":"active","instance":"peggy|NEW"}}}' \
  > "$IWORK/repo/.tap/team-registry.json"
printf '{"schema": "0.20", "team":{"name":"t","worktree_root":"%s"},"seats":{"peggy":{"status":"active","instance":"peggy|NEW"}}}\n' \
  "$IWORK/repo" > "$IBUS/registry.json"
printf -- '---\nid: stale-001\nfrom: peer\nto: peggy\nkind: discuss\nrecipient_instance: peggy|OLD\n---\npre-fresh\n' > "$IBUS/payloads/stale-001.md"
printf -- '---\nid: mine-002\nfrom: peer\nto: peggy\nkind: discuss\nrecipient_instance: peggy|NEW\n---\nmine\n' > "$IBUS/payloads/mine-002.md"
printf -- '---\nid: unbound-003\nfrom: peer\nto: peggy\nkind: discuss\n---\nunbound\n' > "$IBUS/payloads/unbound-003.md"

IOUT="$IWORK/recap.out"
TAP_HOME="$IBUS" TAP_INDEX_HOME="$IWORK/index" bash "$RECAP" recap peggy >"$IOUT" 2>&1 \
  || fail "(7) instance-scoped recap exited nonzero: $(tail -3 "$IOUT")"
_iowed="$(awk '/^unsettled inbound/,/^your outstanding/' "$IOUT")"
grep -q "stale-001" <<<"$_iowed" \
  && fail "(7) recap named a PREDECESSOR-bound obligation the successor cannot settle (KTD-16)"
grep -q "mine-002" <<<"$_iowed" \
  || fail "(7) recap dropped an obligation bound to the CURRENT instance"
# Unstamped payloads (pre-flip, or a deliberately unbound --pane send) carry no
# binding to check and must still be admitted — same polarity as tap poll. A
# filter that swallowed them would silently hide real mail.
grep -q "unbound-003" <<<"$_iowed" \
  || fail "(7) recap dropped an UNBOUND payload; the filter must not swallow unstamped mail"
echo "rebind-recap: (7) instance-scoped — predecessor mail excluded, current and unbound admitted: ok"

echo "rebind-recap: ok"
