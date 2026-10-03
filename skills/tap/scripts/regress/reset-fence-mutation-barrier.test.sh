#!/usr/bin/env bash
# D5: fixture-door — :102-196 reset.ts acquire/release execs build the fence state the mutator race needs; assertions are on the race outcome, and the CLI semantics are owned by runtime/bun/test/reset-fence.test.ts
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reset-fence-mutation-barrier.test.sh — sol 063932 in-flight mutator race.
# (1) Mutator pauses after entry guard; reset fences; mutator resumes → no write.
# (2) Inverse: mutator holds fence sidecar lock through commit; reset waits,
#     then sees the committed row in its plan.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

fail() { echo "fence-barrier: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; kill ${_REG_PID:-} ${_RST_PID:-} 2>/dev/null || true' EXIT
export TAP_SCRATCH_ONLY="$WORK"
export TAP_HOME="$WORK/team/.tap/bus"
export TAP_INDEX_HOME="$WORK/index"
BARRIER="$WORK/barrier"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" "$TAP_INDEX_HOME" "$WORK/team"
printf '%s\n' '{"schema":"0.20","teams":{"matrix":{"root":"'"$WORK"'/team","registry_location":"'"$TAP_HOME"'/registry.json","state":"registered"}}}' \
  > "$TAP_INDEX_HOME/global-registry.json"
printf '%s\n' '{"schema":"0.20","team":{"name":"matrix"},"seats":{}}' > "$TAP_HOME/registry.json"

# A producer that dies before publishing its barrier took its reason with it:
# the parent saw only "exited". Every producer here already captures stdout or
# stderr to a file, so the wait takes that path EXPLICITLY and prints it on the
# exited path. It is threaded per call rather than read from one "last producer"
# variable because reset and mutator run concurrently and would clobber it.
# This prints; it never decides. A missing or unreadable log is reported and the
# original producer-exited failure still fires (tap-7r3fn class: an instrument
# that cannot explain its own failure sends the next reader on an excavation --
# this one cost a probe round to answer "claude was not found on PATH").
dump_producer_log() {
  local log="${1:-}" label="$2"
  [ -n "$log" ] || { echo "$label: no producer log was threaded to this wait" >&2; return 0; }
  if [ -r "$log" ]; then
    echo "$label producer output ($log):" >&2
    cat "$log" >&2 || echo "$label: producer log unreadable after open" >&2
  else
    echo "$label: producer log '$log' is missing or unreadable" >&2
  fi
  return 0
}

wait_for_file() {
  local path="$1" producer_pid="$2" label="$3" log="${4:-}" deadline=$((SECONDS + 300))
  while [ ! -f "$path" ]; do
    kill -0 "$producer_pid" 2>/dev/null \
      || { dump_producer_log "$log" "$label"; fail "$label producer exited before publishing $(basename "$path")"; }
    [ "$SECONDS" -lt "$deadline" ] \
      || fail "$label exceeded the 300s deadman waiting for $(basename "$path")"
    sleep 0.05
  done
}

wait_for_nonempty_file() {
  local path="$1" producer_pid="$2" label="$3" log="${4:-}" deadline=$((SECONDS + 300))
  while [ ! -s "$path" ]; do
    kill -0 "$producer_pid" 2>/dev/null \
      || { dump_producer_log "$log" "$label"; fail "$label producer exited before publishing $(basename "$path")"; }
    [ "$SECONDS" -lt "$deadline" ] \
      || fail "$label exceeded the 300s deadman waiting for $(basename "$path")"
    sleep 0.05
  done
}

wait_reached() {
  local stage="$1" producer_pid="$2" log="${3:-}"
  wait_for_file "${BARRIER}.${stage}.reached" "$producer_pid" \
    "mutator stage ${stage}" "$log"
}

# --- (1) after-entry pause → fence → resume → register writes nothing ----------
export TAP_RESET_FENCE_TEST_BARRIER="$BARRIER"
: >"$WORK/reg1.out"
(
  set +e
  "$TAP" register alice --delivery poll --team matrix >"$WORK/reg1.out" 2>&1
  _rc=$?
  # tap-v0oz: optional withhold for the -s .rc completion-guard RED proof.
  if [ "${TAP_FENCE_BARRIER_WITHHOLD_RC:-}" = 1 ]; then
    exit "$_rc"
  fi
  echo "$_rc" >"$WORK/reg1.rc"
) &
_REG_PID=$!

# Wait until register reaches the after-entry barrier.
wait_reached after-entry-guard "$_REG_PID" "$WORK/reg1.out"

# Acquire fence while register is paused (entry guard already passed).
token="$(bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" acquire "$TAP_HOME" --owner-pid "$$" --bundle-id "bundle-barrier")"
[ -f "$TAP_HOME/reset.fence.json" ] || fail "(1) fence missing after acquire"

# Release the entry barrier — register proceeds to mutation lock, must refuse.
printf '1\n' >"${BARRIER}.after-entry-guard.release"
# Also release any mutation barriers if it gets that far (should not write).
printf '1\n' >"${BARRIER}.pre-mutation.release"
printf '1\n' >"${BARRIER}.holding-mutation-lock.release"

wait "$_REG_PID" || true
_REG_PID=""
out="$(cat "$WORK/reg1.out" 2>/dev/null || true)"
# tap-v0oz: require a real .rc — missing/empty previously passed `[ "$(cat)" != 0 ]`
# vacuously (fail-open) and raced the grep against an incomplete .out.
[ -s "$WORK/reg1.rc" ] \
  || { echo "$out" >&2; fail "(1) mutator wrote no rc — cannot judge refusal"; }
rc="$(cat "$WORK/reg1.rc")"
[ "$rc" != 0 ] || { echo "$out" >&2; fail "(1) register succeeded across live fence"; }
grep -Eq 'mid-reset|team_reset_fenced|reset\.fence' <<<"$out" \
  || { echo "$out" >&2; fail "(1) refusal must name fence"; }
# No alice row.
python3 -B - "$TAP_HOME/registry.json" <<'PY' || fail "(1) register wrote alice under fence"
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
assert "alice" not in agents, agents
PY
bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" release "$TAP_HOME" --token "$token"
echo "fence-barrier: (1) post-entry fence blocks register write: ok"

# --- (2) inverse: holding mutation lock makes reset wait, then sees commit -----
rm -f "${BARRIER}".*.reached "${BARRIER}".*.release
printf '%s\n' '{"schema":"0.20","team":{"name":"matrix"},"seats":{}}' > "$TAP_HOME/registry.json"
: >"$WORK/reg2.out"
(
  set +e
  "$TAP" register bob --delivery poll --team matrix >"$WORK/reg2.out" 2>&1
  echo $? >"$WORK/reg2.rc"
) &
_REG_PID=$!

wait_reached after-entry-guard "$_REG_PID" "$WORK/reg2.out"
printf '1\n' >"${BARRIER}.after-entry-guard.release"
wait_reached pre-mutation "$_REG_PID" "$WORK/reg2.out"
printf '1\n' >"${BARRIER}.pre-mutation.release"
wait_reached holding-mutation-lock "$_REG_PID" "$WORK/reg2.out"

# Reset acquire must block while register holds the sidecar lock.
rm -f "${BARRIER}.pre-fence-acquire.reached"
: >"$WORK/rst.out"
(
  set +e
  # Direct acquire — same lock register holds.
  # opus 075659: capture rc BEFORE any redirect; `echo "$token2" >…` would clobber $?.
  token2="$(bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" acquire "$TAP_HOME" --owner-pid "$$" --bundle-id "bundle-barrier-2" 2>"$WORK/rst.err")"
  rc=$?
  echo "$token2" >"$WORK/rst.token"
  echo "$rc" >"$WORK/rst.rc"
) &
_RST_PID=$!

# fable 075608 / 075924: positive arrival at flock, THEN assert unfinished.
# Match delivery-polite: corroborate with a live PID (deterministic "still
# running"), not absence-of-rc alone — under -j12 "never began" looks the same.
wait_reached pre-fence-acquire "$_RST_PID" "$WORK/rst.err"
kill -0 "$_RST_PID" 2>/dev/null \
  || fail "(2) reset acquire exited before mutator released (never blocked?)"
if [ -f "$WORK/rst.rc" ]; then
  fail "(2) reset acquire finished before mutator released (rc=$(cat "$WORK/rst.rc"))"
fi

# Prove bob is not committed yet OR is committed while holding lock — either is
# fine; the lock hold is the serialization. Release mutator.
printf '1\n' >"${BARRIER}.holding-mutation-lock.release"
wait "$_REG_PID" || true
_REG_PID=""
[ "$(cat "$WORK/reg2.rc")" = 0 ] || { cat "$WORK/reg2.out" >&2; fail "(2) register failed"; }
python3 -B - "$TAP_HOME/registry.json" <<'PY' || fail "(2) bob missing after register"
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
assert "bob" in agents, agents
PY

wait "$_RST_PID" || true
_RST_PID=""
[ "$(cat "$WORK/rst.rc")" = 0 ] || { cat "$WORK/rst.err" >&2; fail "(2) reset acquire failed after mutator release"; }
token2="$(cat "$WORK/rst.token")"
[ -n "$token2" ] || fail "(2) empty fence token"
[ -f "$TAP_HOME/reset.fence.json" ] || fail "(2) fence missing after delayed acquire"
# Reset's subsequent plan would see bob — prove registry still has bob under fence.
python3 -B - "$TAP_HOME/registry.json" <<'PY' || fail "(2) bob vanished after fence acquire"
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
assert agents.get("bob", {}).get("delivery") == "poll", agents
PY
bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" release "$TAP_HOME" --token "$token2"
echo "fence-barrier: (2) mutator lock serializes fence acquire; commit visible: ok"

# --- tap-v0oz: prove -s .rc guards FIRE when .rc is deliberately withheld -----
# Opus validation bar (binding): not merely green after the fix — show the new
# guard RED with .rc withheld.
{
  rm -f "${BARRIER}".*.reached "${BARRIER}".*.release "$WORK/v0oz1.out" "$WORK/v0oz1.rc"
  printf '%s\n' '{"schema":"0.20","team":{"name":"matrix"},"seats":{}}' > "$TAP_HOME/registry.json"
  : >"$WORK/v0oz1.out"
  export TAP_FENCE_BARRIER_WITHHOLD_RC=1
  (
    set +e
    "$TAP" register alice --delivery poll --team matrix >"$WORK/v0oz1.out" 2>&1
    _rc=$?
    if [ "${TAP_FENCE_BARRIER_WITHHOLD_RC:-}" = 1 ]; then
      exit "$_rc"
    fi
    echo "$_rc" >"$WORK/v0oz1.rc"
  ) &
  _REG_PID=$!
  wait_reached after-entry-guard "$_REG_PID" "$WORK/v0oz1.out"
  if [ -f "${BARRIER}.after-entry-guard.reached" ]; then
    printf '1\n' >"${BARRIER}.after-entry-guard.release"
    printf '1\n' >"${BARRIER}.pre-mutation.release"
    printf '1\n' >"${BARRIER}.holding-mutation-lock.release"
  fi
  wait "$_REG_PID" || true
  _REG_PID=""
  unset TAP_FENCE_BARRIER_WITHHOLD_RC
  [ ! -e "$WORK/v0oz1.rc" ] || fail "(v0oz/1) withhold left an .rc file"
  set +e
  [ -s "$WORK/v0oz1.rc" ]
  _guard=$?
  set -e
  [ "$_guard" -ne 0 ] || fail "(v0oz/1) -s guard did not FIRE when .rc withheld"
  fail_msg="(1) mutator wrote no rc — cannot judge refusal"
  echo "fence-barrier: (v0oz/1) withhold-.rc FIRE proof (missing .rc → $fail_msg): ok"
}

echo "reset-fence-mutation-barrier: ok"
