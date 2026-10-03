#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# whoami-caller-one-record.test.sh — tap-316wj.
#
# THE FORMER BOUNDARY: tap_resolve_self_handle called tap_calling_pane_id
# (TTY → pane id) and then tap_pane_observe (pane id → generation). A tmux
# server rebirth between those probes can recycle the numeric id onto a
# different TTY; the second record is internally current but is not the
# caller's. The no-arg path must take pane id, TTY, session, and generation
# from ONE tap_calling_pane_observe record.
#
# (a) happy: one targeted display-message, matching registry row, returns me
# (c) WORLD-PER-CALL: first display-message is our world, the second is a
#     recycled-id stranger. Pre-fix no-arg resolve issued two targeted
#     observations and would return the stranger. One observation never
#     sees world B, so this path must still return me.
# (b) WITNESS: TTY and generation have already moved in the one record —
#     no handle may resolve
# (d) malformed pane id + matching damaged registry row: refuse before lookup
# (e) empty session_name in the four-field record: refuse (discriminator is
#     three fields wide AND three fields deep)
# (f) no-arg whoami with no acting registry names that, not "unregistered pane"
# (g) three-field observe (generation in the session slot) must not resolve as SELF
#
# Run: bash skills/tap/scripts/smoke/whoami-caller-one-record.test.sh
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "tap-316wj/whoami-caller-one-record"

export TAP_HOME="$WORK/.tap/bus" TMUX="/fake/socket"
export COUNT_LOG="$WORK/display.log" DISPLAY_SEQ="$WORK/display.seq"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/.tap" "$WORK/bin"

# LIVE_MAP: pane_id TAB tty TAB session TAB pid:start_time (world A).
# LIVE_MAP_2: same shape, served from the second targeted display-message.
# SCAN_MAP: pane_id TAB tty (list-panes inventory).
# COUNT_LOG: one line per targeted display-message (the discriminator).
cat > "$WORK/bin/tmux" <<'FAKE'
#!/usr/bin/env bash
cmd="${1:-}"; shift || true
case "$cmd" in
  list-panes)
    printf '%s' "${SCAN_MAP:-}"
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    n=0
    if [ -n "$target" ] && [ -n "${COUNT_LOG:-}" ]; then
      printf 'target=%s\n' "$target" >> "$COUNT_LOG"
      if [ -n "${DISPLAY_SEQ:-}" ]; then
        n=$(cat "$DISPLAY_SEQ" 2>/dev/null || echo 0)
        n=$((n + 1))
        printf '%s\n' "$n" > "$DISPLAY_SEQ"
      fi
    fi
    map="${LIVE_MAP:-}"
    if [ -n "${LIVE_MAP_2:-}" ] && [ "$n" -ge 2 ]; then
      map="$LIVE_MAP_2"
    fi
    if [ -n "${DISPLAY_RAW:-}" ]; then
      printf '%s' "$DISPLAY_RAW"
      exit 0
    fi
    row=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      lid="${line%%	*}"
      [ "$lid" = "$target" ] || continue
      row="$line"; break
    done <<< "$map"
    [ -n "$row" ] || exit 0
    lid="${row%%	*}"; rest="${row#*	}"
    ltty="${rest%%	*}"; rest="${rest#*	}"
    lsess="${rest%%	*}"; lraw="${rest#*	}"
    out="$fmt"
    out="${out//'#{pane_id}'/$lid}"
    out="${out//'#{pane_tty}'/$ltty}"
    out="${out//'#{session_name}'/$lsess}"
    out="${out//'#{pid}:#{start_time}'/$lraw}"
    printf '%s' "$out"
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$WORK/bin/tmux"

cat > "$WORK/bin/ps" <<'FAKEPS'
#!/usr/bin/env bash
printf '%s %s\n' "1" "${FAKE_CALLER_TTY:-ttys001}"
FAKEPS
chmod +x "$WORK/bin/ps"
export PATH="$WORK/bin:$PATH" FAKE_CALLER_TTY="ttys001"

REG="$WORK/.tap/team-registry.json"
write_reg() { printf '%s\n' "$1" > "$REG"; }
# Born live: an absent marker opens no legacy door, so the team is enrolled.
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$WORK" "$REG" <<'PY'
import json, os, sys
gpath, root, loc = sys.argv[1:4]
json.dump({"schema": "0.20", "teams": {"T": {
    "root": os.path.realpath(root), "registry_location": os.path.realpath(root) + "/.tap/team-registry.json",
    "state": "registered",
}}}, open(gpath, "w"))
PY
ME_ONLY='{"schema": "0.20", "team":{"name":"T","worktree_root":"/tmp/T"},"seats":{"me":{"status":"active","delivery":"pane","pane":"%5","pane_id":"%5","server_epoch":"srv:4242:99"}}}'
ME_AND_STRANGER='{"schema": "0.20", "team":{"name":"T","worktree_root":"/tmp/T"},"seats":{"me":{"status":"active","delivery":"pane","pane":"%5","pane_id":"%5","server_epoch":"srv:4242:99"},"stranger":{"status":"active","delivery":"pane","pane":"%5","pane_id":"%5","server_epoch":"srv:9999:1"}}}'
write_reg "$ME_ONLY"

reset_probe() {
  : > "$COUNT_LOG"
  printf '0\n' > "$DISPLAY_SEQ"
  unset LIVE_MAP_2
}

targeted_count() {
  local n=0
  [ -s "$COUNT_LOG" ] && n=$(grep -c '^target=' "$COUNT_LOG" || true)
  printf '%s' "$n"
}

call_resolve() {
  bash "$ROOT/bin/tap" whoami 2>/dev/null
}

# (a) one record, current generation, TTY still ours --------------------------------
echo "-- (a) no-arg resolve returns the handle from exactly one targeted observation --"
reset_probe
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export LIVE_MAP=$'%5\t/dev/ttys001\tT/me\t4242:99\n'
GOT="$(call_resolve || true)"
N="$(targeted_count)"
if [ "$GOT" = "me" ]; then
  ok "(a) no-arg resolve returned me"
else
  bad "(a) got '${GOT:-<empty>}', expected me"
fi
if [ "$N" = "1" ]; then
  ok "(a) no-arg resolve issued exactly one targeted display-message"
else
  bad "(a) targeted display-message count was $N, expected 1 — this arm must red pre-fix (2)"
fi

# (c) WORLD-PER-CALL: second observation is a recycled-id stranger ----------------
# Pre-fix no-arg resolve: tap_calling_pane_id (world A) then tap_pane_observe
# (world B) → now_epoch srv:9999:1 matches the stranger row. One observation
# never issues world B, so the handle must stay me.
echo "-- (c) WORLD-PER-CALL: second observation is a stranger; one record still returns me --"
reset_probe
write_reg "$ME_AND_STRANGER"
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export LIVE_MAP=$'%5\t/dev/ttys001\tT/me\t4242:99\n'
export LIVE_MAP_2=$'%5\t/dev/ttys999\tT/stranger\t9999:1\n'
GOT="$(call_resolve || true)"
N="$(targeted_count)"
if [ "$GOT" = "me" ]; then
  ok "(c) one observation never mixed in the stranger world"
else
  bad "(c) got '${GOT:-<empty>}', expected me — mixed-world resolve leaked"
fi
if [ "$N" = "1" ]; then
  ok "(c) still exactly one targeted display-message"
else
  bad "(c) targeted display-message count was $N, expected 1"
fi
unset LIVE_MAP_2
write_reg "$ME_ONLY"

# (b) WITNESS: TTY moved AND generation changed in the final record ----------------
# The scan still binds ttys001 -> %5 (observation 1 of the old split). The
# targeted display-message now reports a stranger's TTY and a new server
# generation. Mixing those two probes would have authorized %5 against the
# new generation. One record must refuse.
echo "-- (b) WITNESS: TTY and generation move across the former boundary --"
reset_probe
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export LIVE_MAP=$'%5\t/dev/ttys999\tT/stranger\t9999:1\n'
GOT="$(call_resolve || true)"
if [ -z "$GOT" ]; then
  ok "(b) refused to resolve a handle when TTY and generation moved between probes"
else
  bad "(b) resolved '$GOT' after TTY and generation moved — the recycled id leaked"
fi

# (d) malformed pane id must not consult the registry as identity --------------
# list-panes and the targeted observation agree on a non-empty non-%N token;
# a damaged row carries that same token. Pre-fix tap_pane_observe refused it
# through tap_is_pane_id; the one-record path must refuse before lookup.
echo "-- (d) malformed caller pane id does not resolve a matching damaged row --"
reset_probe
write_reg '{"schema": "0.20", "team":{"name":"T","worktree_root":"/tmp/T"},"seats":{"forged":{"status":"active","delivery":"pane","pane":"not-a-pane","pane_id":"not-a-pane","server_epoch":"srv:4242:99"}}}'
export SCAN_MAP=$'not-a-pane\t/dev/ttys001\n'
export LIVE_MAP=$'not-a-pane\t/dev/ttys001\tT/forged\t4242:99\n'
GOT="$(call_resolve || true)"
if [ -z "$GOT" ]; then
  ok "(d) refused a malformed pane id before registry lookup"
else
  bad "(d) resolved '$GOT' from a malformed pane id — fail-closed boundary lost"
fi

# (e) empty session_name is not a three-field observation -----------------------
# list-panes and the targeted record agree on pane id, TTY, and generation, but
# session_name is empty. Four tab-fields still arrive, so arity cannot catch
# it. At 8d6f0aad this resolved `me`; the discriminator must refuse.
echo "-- (e) empty session_name does not resolve a matching row --"
reset_probe
write_reg "$ME_ONLY"
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export LIVE_MAP=$'%5\t/dev/ttys001\t\t4242:99\n'
GOT="$(call_resolve || true)"
if [ -z "$GOT" ]; then
  ok "(e) refused an observation with an empty session_name"
else
  bad "(e) resolved '$GOT' from an empty session_name — discriminator was two fields deep"
fi

# (f) no-arg whoami with no acting registry must name that, not "unregistered"
# pane. At 72857cc3 this said "pane %5 is not registered". Observe still
# succeeds; the --pane path already prints "no registry at cwd".
echo "-- (f) no-arg whoami names a missing acting registry, not an unregistered pane --"
reset_probe
write_reg "$ME_ONLY"
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export LIVE_MAP=$'%5\t/dev/ttys001\tT/me\t4242:99\n'
# The verb closure deleted tap-whoami.sh; this drives the PUBLIC ROUTE now, which
# is what the incumbent arm reached anyway. `bin/tap whoami` rather than
# `tap.sh whoami` because bin/tap is the door a caller actually has.
WHOAMI_DOOR=("$ROOT/bin/tap" whoami)
NOREG="$WORK/noreg"
mkdir -p "$NOREG"
# Red-first at 72857cc3: same observe, registry file gone.
rm -f "$REG"
# A live, empty machine index: the pane resolver walks its (empty) enrollments and
# answers its typed no-claimant verdict, never "is not registered".
export TAP_INDEX_HOME="$WORK/no-index"
mkdir -p "$TAP_INDEX_HOME"
printf '%s\n' '{"schema":"0.20","teams":{}}' >"$TAP_INDEX_HOME/global-registry.json"
whoami_out=""
whoami_rc=0
whoami_out="$(cd "$NOREG" && bash "${WHOAMI_DOOR[@]}" 2>&1)" || whoami_rc=$?
if [ "$whoami_rc" -ne 0 ] && grep -q 'no claimant rows' <<<"$whoami_out" \
  && ! grep -q 'is not registered' <<<"$whoami_out"; then
  ok "(f) no-arg whoami named the missing claimant"
else
  bad "(f) rc=$whoami_rc out='${whoami_out}' — expected 'no claimant rows', not 'is not registered'"
fi
# --pane control: the same cwd must keep the diagnosis the no-arg path just joined.
pane_out=""
pane_rc=0
pane_out="$(cd "$NOREG" && bash "${WHOAMI_DOOR[@]}" --pane %5 2>&1)" || pane_rc=$?
if [ "$pane_rc" -ne 0 ] && grep -q 'no claimant rows' <<<"$pane_out"; then
  ok "(f) --pane whoami still names the missing claimant"
else
  bad "(f) --pane rc=$pane_rc out='${pane_out}' — control lost the no-claimant diagnosis"
fi
# With no machine index at all, both paths name the missing index instead (F2b).
export TAP_INDEX_HOME="$WORK/absent-index"
mkdir -p "$TAP_INDEX_HOME"
for door_args in "" "--pane %5"; do
  absent_out=""
  absent_rc=0
  # shellcheck disable=SC2086 # door_args is a fixed literal word list
  absent_out="$(cd "$NOREG" && bash "${WHOAMI_DOOR[@]}" $door_args 2>&1)" || absent_rc=$?
  if [ "$absent_rc" -ne 0 ] && grep -q 'no machine index (global-registry.json)' <<<"$absent_out" \
    && ! grep -q 'is not registered' <<<"$absent_out"; then
    ok "(f) absent index: whoami ${door_args:-no-arg} named the missing machine index"
  else
    bad "(f) absent index: ${door_args:-no-arg} rc=$absent_rc out='${absent_out}' — expected 'no machine index'"
  fi
done
write_reg "$ME_ONLY"

# (g) three-field observe: generation sits in the session slot. At 8531f88d
# this resolved `forged`. The empty-session check cannot catch it — 4242:99
# is non-empty. Arity must.
echo "-- (g) three-field observe does not resolve a matching current-generation row --"
reset_probe
write_reg '{"schema": "0.20", "team":{"name":"T","worktree_root":"/tmp/T"},"seats":{"forged":{"status":"active","delivery":"pane","pane":"%5","pane_id":"%5","server_epoch":"srv:4242:99"}}}'
export SCAN_MAP=$'%5\t/dev/ttys001\n'
export DISPLAY_RAW=$'%5\t/dev/ttys001\t4242:99'
GOT="$(call_resolve || true)"
unset DISPLAY_RAW
if [ -z "$GOT" ]; then
  ok "(g) refused a three-field observation (generation in the session slot)"
else
  bad "(g) resolved '$GOT' from a three-field observe — truncated record forged identity"
fi
write_reg "$ME_ONLY"

echo
printf 'whoami-caller-one-record: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
