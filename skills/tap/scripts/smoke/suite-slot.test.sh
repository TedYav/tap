#!/usr/bin/env bash
# suite-slot.test.sh — tap-m8of: ordinary contention is advisory; probes exclude.
#
# Bidirectional (non-negotiable):
#   (1) lock held  -> ordinary child runs with advisory contention; probes FAIL
#   (2) lock free  -> acquire SUCCEEDS (probe)
#   (3) kill -9 holder -> next acquire SUCCEEDS (kernel frees flock)
#   (4) unlock refuses while holder alive; clears when dead
#       (4c) unknown argv refuses without touching the stale lease
#       (4d) --help exits 0 without mutation
#       (4e) bare invocation still clears a stale lease
#   (7) empty-lease window: bounded re-read names the landed holder;
#       no-lease fallback is labeled a search, not a holder (tap-agfo)
#   (5) TAP_SUITE_SEAT at acquire -> probe refusal names holder_seat
#   (6) seat is never inferred from cwd path fragments
#
# Never touches the real ~/.tap/locks path — TAP_SUITE_LOCK_HOME is under WORK.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
LOCK_HOME="$WORK/locks"
export TAP_SUITE_LOCK_HOME="$LOCK_HOME"
# SAFETY: refuse if isolation failed.
case "$TAP_SUITE_LOCK_HOME" in
  "$WORK"/*) ;;
  *) echo "suite-slot: REFUSING — TAP_SUITE_LOCK_HOME='$TAP_SUITE_LOCK_HOME' not under WORK" >&2; exit 1 ;;
esac

HOLDER_PID=""
RELEASE_PID=""
cleanup() {
  if [ -n "${RELEASE_PID}" ] && kill -0 "$RELEASE_PID" 2>/dev/null; then
    kill "$RELEASE_PID" 2>/dev/null || true
    wait "$RELEASE_PID" 2>/dev/null || true
  fi
  if [ -n "${HOLDER_PID}" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
    kill -9 "$HOLDER_PID" 2>/dev/null || true
    wait "$HOLDER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "suite-slot: $1" >&2; shift; [ "$#" = 0 ] || printf '%s\n' "$@" >&2; exit 1; }

# Absolute interpreter — scenario (6) scrubs PATH to /usr/bin:/bin to starve
# cwd/path inference; a bare TAP_PYTHON=python3.14 from an outer smoke-all
# is then unexecutable. Resolve once to an absolute path so the scrub stays
# intact (do not re-add the interpreter's directory to PATH).
PY="$(command -v "${TAP_PYTHON:-python3}")" \
  || fail "suite-slot: no python interpreter (${TAP_PYTHON:-python3})"
case "$PY" in
  /*) ;;
  *) fail "suite-slot: interpreter must resolve to an absolute path, got '$PY'" ;;
esac
SLOT_RUN=("$PY" -B "$ROOT/scripts/suite-slot-run.py")
SMOKE="$ROOT/scripts/smoke-all.sh"
UNLOCK="$ROOT/scripts/suite-slot-unlock.sh"

start_holder() {
  local seat="${1:-}"
  # Parent is suite-slot-run.py (holds flock); child sleeps.
  if [ -n "$seat" ]; then
    TAP_SUITE_SEAT="$seat" \
      "${SLOT_RUN[@]}" -- "$PY" -c 'import time; time.sleep(120)' >"$WORK/holder.out" 2>&1 &
  else
    env -u TAP_SUITE_SEAT -u TAP_SELF -u TAP_HANDLE \
      "${SLOT_RUN[@]}" -- "$PY" -c 'import time; time.sleep(120)' >"$WORK/holder.out" 2>&1 &
  fi
  HOLDER_PID=$!
  # Wait until lease names our holder (acquire completed).
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$LOCK_HOME/smoke-all.lease.json" ]; then
      local lpid
      lpid="$($PY -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' \
        "$LOCK_HOME/smoke-all.lease.json" 2>/dev/null || true)"
      if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
        HOLDER_PID="$lpid"
        return 0
      fi
    fi
    sleep 0.1
  done
  fail "(setup) holder never wrote lease" "$(cat "$WORK/holder.out" 2>/dev/null || true)"
}

# (2) FREE -> succeed (probe). Run before busy so we also cover cold start.
out="$WORK/free.out"
if ! TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1; then
  fail "(2) free probe must succeed" "$(cat "$out")"
fi
grep -q 'suite-slot: acquired (probe)' "$out" \
  || fail "(2) free probe must print acquired" "$(cat "$out")"
[ ! -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(2) probe must clear lease on exit"
# Fact, not prose: after normal release the flock TARGET remains and the lease
# is gone. If a refactor unlinks .lock on release, this fails — the doc claim
# "that file is permanent" must stay true of the world, not only of the refusal.
[ -f "$LOCK_HOME/smoke-all.lock" ] \
  || fail "(2) smoke-all.lock must still exist after release (permanent flock target)"
echo "suite-slot: (2) free -> acquire succeeds (probe); lock permanent, lease cleared: ok"

# (1) BUSY -> ordinary work continues; controlled probes still refuse.
start_holder
out="$WORK/busy-advisory.out"
if ! "${SLOT_RUN[@]}" -- "$PY" -c \
  'import os; print("child-ran=" + os.environ.get("TAP_SUITE_SLOT_CONTENDED", ""))' \
  >"$out" 2>&1; then
  fail "(1a) ordinary child must run while the advisory slot is held" "$(cat "$out")"
fi
grep -q 'suite-slot: advisory contention' "$out" \
  || fail "(1a) contended run must print the advisory receipt" "$(cat "$out")"
grep -q 'child-ran=1' "$out" \
  || fail "(1a) contended child must receive TAP_SUITE_SLOT_CONTENDED=1" "$(cat "$out")"
echo "suite-slot: (1a) busy -> ordinary child continues with advisory receipt: ok"

out="$WORK/busy-run.out"
set +e
TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(1b) controlled probe must fail while held" "$(cat "$out")"
grep -q 'error_class=suite_slot_busy' "$out" \
  || fail "(1b) refusal must name error_class=suite_slot_busy" "$(cat "$out")"
grep -q 'admission_blocker: suite_holder' "$out" \
  || fail "(1a) refusal must name admission_blocker" "$(cat "$out")"
grep -q "holder_pid: ${HOLDER_PID}" "$out" \
  || fail "(1a) refusal must name holder pid" "$(cat "$out")"
grep -q 'holder_started:' "$out" \
  || fail "(1a) refusal must name holder_started" "$(cat "$out")"
grep -q 'suite-slot-unlock.sh' "$out" \
  || fail "(1a) refusal must name unlock door" "$(cat "$out")"
grep -q 'do not poll smoke-all.lock' "$out" \
  || fail "(1a) refusal must warn against polling the permanent lock file" "$(cat "$out")"
echo "suite-slot: (1b) busy -> controlled probe refuses: ok"

out="$WORK/busy-smoke.out"
SANDBOX_TMP="$WORK/sandbox-tmp"
mkdir -p "$SANDBOX_TMP"
set +e
# Unset HELD: when this smoke runs inside an outer smoke-all, workers inherit
# TAP_SUITE_SLOT_HELD=1 and a naive nested smoke-all would skip the launcher
# and re-enter the full suite (observed hang under tap-ejpf gate).
TMPDIR="$SANDBOX_TMP" env -u TAP_SUITE_SLOT_HELD \
  TAP_RUNNER_ALLOW=1 TAP_SUITE_SLOT_PROBE=1 bash "$SMOKE" >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(1b) smoke-all must refuse while slot held" "$(cat "$out")"
grep -q 'error_class=suite_slot_busy' "$out" \
  || fail "(1b) smoke-all refusal must name suite_slot_busy" "$(cat "$out")"
grep -q 'tested-tree=' "$out" \
  && fail "(1b) admission refusal must not masquerade as a checkout red" "$(cat "$out")"
find "$SANDBOX_TMP" -mindepth 1 -maxdepth 1 -print -quit | grep -q . \
  && fail "(1b) probe refusal leaked its suite sandbox" "$(find "$SANDBOX_TMP" -mindepth 1 -maxdepth 1 -print)"
echo "suite-slot: (1c) busy -> smoke-all.sh probe refuses: ok"

# (1c) same refuse when an outer suite left HELD=1 in the environment
out="$WORK/busy-held.out"
set +e
TAP_SUITE_SLOT_HELD=1 TAP_RUNNER_ALLOW=1 TAP_SUITE_SLOT_PROBE=1 bash "$SMOKE" >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(1c) probe under HELD=1 must still refuse (not nest)" "$(cat "$out")"
grep -q 'error_class=suite_slot_busy' "$out" \
  || fail "(1c) HELD=1 probe must hit suite_slot_busy" "$(cat "$out")"
grep -q 'smoke-all: .*files' "$out" \
  && fail "(1c) must not enter suite body under probe" "$(cat "$out")"
echo "suite-slot: (1d) probe under inherited HELD=1 still refuses (no nest): ok"

# (4a) unlock refuses while holder alive
out="$WORK/unlock-live.out"
set +e
bash "$UNLOCK" >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(4a) unlock must refuse live holder" "$(cat "$out")"
grep -q 'refusing' "$out" || fail "(4a) unlock live message" "$(cat "$out")"
kill -0 "$HOLDER_PID" 2>/dev/null \
  || fail "(4a) unlock must not kill the holder"
[ -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(4a) unlock must leave lease intact while live"
echo "suite-slot: (4a) unlock refuses live holder: ok"

# (3) kill -9 holder -> next acquire succeeds (the property flock exists for)
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
out="$WORK/after-kill.out"
if ! TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1; then
  fail "(3) acquire after kill -9 must succeed" "$(cat "$out")"
fi
grep -q 'suite-slot: acquired (probe)' "$out" \
  || fail "(3) after-kill probe print" "$(cat "$out")"
echo "suite-slot: (3) kill -9 holder -> next acquire succeeds: ok"

# (4b) unlock clears stale sidecar after kill -9 (finally did not run)
start_holder
DEAD_HOLDER="$HOLDER_PID"
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
# kill -9 skips suite-slot-run's finally — lease file should still name the dead pid.
[ -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(4b) expected stale lease after kill -9 (tests unlock door)"
grep -q "\"pid\": ${DEAD_HOLDER}" "$LOCK_HOME/smoke-all.lease.json" \
  || fail "(4b) stale lease should name dead holder" "$(cat "$LOCK_HOME/smoke-all.lease.json")"

out="$WORK/unlock-dead.out"
if ! bash "$UNLOCK" >"$out" 2>&1; then
  fail "(4b) unlock must clear dead holder" "$(cat "$out")"
fi
grep -q 'cleared' "$out" || fail "(4b) unlock dead message" "$(cat "$out")"
[ ! -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(4b) lease must be gone after unlock"
echo "suite-slot: (4b) unlock clears dead holder: ok"

# (4c) unknown argument refuses WITHOUT touching a stale lease (tap-u6qop:
# an operator who typos a plausible read flag must get a refusal, not a clear)
start_holder
STALE_HOLDER="$HOLDER_PID"
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
[ -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(4c) expected stale lease fixture after kill -9"
grep -q "\"pid\": ${STALE_HOLDER}" "$LOCK_HOME/smoke-all.lease.json" \
  || fail "(4c) stale lease should name dead holder" \
  "$(cat "$LOCK_HOME/smoke-all.lease.json")"

out="$WORK/unlock-badarg.out"
set +e
bash "$UNLOCK" --status >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(4c) unknown argument must exit nonzero" "$(cat "$out")"
grep -q 'unknown argument: --status' "$out" \
  || fail "(4c) unknown-argument message must name the arg" "$(cat "$out")"
grep -q "\"pid\": ${STALE_HOLDER}" "$LOCK_HOME/smoke-all.lease.json" \
  || fail "(4c) unknown argument must leave the stale lease untouched"
echo "suite-slot: (4c) unknown arg refuses, stale lease untouched: ok"

# (4c2) every other argv shape refuses too: an explicit empty argument, and a
# help flag with trailing words, must not reach the unlock.
for shape in empty help-trailing; do
  out="$WORK/unlock-shape-$shape.out"
  set +e
  case "$shape" in
    empty) bash "$UNLOCK" "" >"$out" 2>&1 ;;
    help-trailing) bash "$UNLOCK" --help extra >"$out" 2>&1 ;;
  esac
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "(4c2) argv shape '$shape' must exit 2 (got $rc)" "$(cat "$out")"
  grep -q 'unknown argument' "$out" \
    || fail "(4c2) argv shape '$shape' must name the refusal" "$(cat "$out")"
  grep -q "\"pid\": ${STALE_HOLDER}" "$LOCK_HOME/smoke-all.lease.json" \
    || fail "(4c2) argv shape '$shape' must leave the stale lease untouched"
done
echo "suite-slot: (4c2) empty arg and help-with-trailing-words refuse, lease untouched: ok"

# (4d) --help exits 0 with no mutation
out="$WORK/unlock-help.out"
if ! bash "$UNLOCK" --help >"$out" 2>&1; then
  fail "(4d) --help must exit 0" "$(cat "$out")"
fi
grep -q 'suite-slot-unlock' "$out" \
  || fail "(4d) --help should name the tool" "$(cat "$out")"
grep -q 'smoke-all.lock' "$out" \
  || fail "(4d) --help should name the lock path" "$(cat "$out")"
grep -q "\"pid\": ${STALE_HOLDER}" "$LOCK_HOME/smoke-all.lease.json" \
  || fail "(4d) --help must leave the stale lease untouched"
echo "suite-slot: (4d) --help exits 0 without mutation: ok"

# (4e) bare invocation still clears the stale lease (named bare in the
# suite_slot_busy refusal text — must stay runnable as printed)
out="$WORK/unlock-bare.out"
if ! bash "$UNLOCK" >"$out" 2>&1; then
  fail "(4e) bare unlock must still clear the stale lease" "$(cat "$out")"
fi
[ ! -f "$LOCK_HOME/smoke-all.lease.json" ] \
  || fail "(4e) lease must be gone after bare unlock"
echo "suite-slot: (4e) bare invocation still clears stale lease: ok"

# (2b) smoke-all probe path when free (including under inherited HELD=1)
out="$WORK/free-smoke.out"
if ! TAP_SUITE_SLOT_HELD=1 TAP_RUNNER_ALLOW=1 TAP_SUITE_SLOT_PROBE=1 bash "$SMOKE" >"$out" 2>&1; then
  fail "(2b) smoke-all free probe must succeed" "$(cat "$out")"
fi
grep -q 'suite-slot: acquired (probe)' "$out" \
  || fail "(2b) smoke-all free probe print" "$(cat "$out")"
grep -q 'smoke-all: .*files' "$out" \
  && fail "(2b) probe must not enter suite body" "$(cat "$out")"
echo "suite-slot: (2b) free -> smoke-all probe succeeds (even under HELD=1): ok"

# (5) declared seat at acquire lands in lease and busy refusal.
start_holder "gate"
seat="$($PY -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("seat"))' \
  "$LOCK_HOME/smoke-all.lease.json")"
[ "$seat" = "gate" ] || fail "(5) lease seat must be declared gate, got '$seat'" \
  "$(cat "$LOCK_HOME/smoke-all.lease.json")"
out="$WORK/busy-seat.out"
set +e
TAP_SUITE_SEAT=grok TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(5) second acquire must fail while held" "$(cat "$out")"
grep -q 'holder_seat: gate' "$out" \
  || fail "(5) refusal must name declared holder_seat" "$(cat "$out")"
grep -q 'holder_seat_source: declared' "$out" \
  || fail "(5) refusal must label holder seat as declared" "$(cat "$out")"
grep -q 'requested_seat: grok' "$out" \
  || fail "(5) refusal must name requested_seat" "$(cat "$out")"
grep -q 'requested_seat_source: declared' "$out" \
  || fail "(5) refusal must label requested seat as declared" "$(cat "$out")"
grep -q 'admission_blocker: suite_holder' "$out" \
  || fail "(5) refusal must name admission_blocker" "$(cat "$out")"
src="$($PY -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("seat_source"))' \
  "$LOCK_HOME/smoke-all.lease.json")"
[ "$src" = "declared" ] || fail "(5) lease seat_source must be declared, got '$src'"
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
bash "$UNLOCK" >/dev/null 2>&1 || true
echo "suite-slot: (5) declared seat at acquire names both sides: ok"

# (6) cwd path fragments must not become seat — only explicit/observational identity.
# PATH scrub stays /usr/bin:/bin (starves tap-on-PATH). Interpreter is absolute.
FAKE_CWD="$WORK/trees/tap/WouldBeSeat"
mkdir -p "$FAKE_CWD"
out="$WORK/cwd-seat.out"
(
  cd "$FAKE_CWD" || exit 1
  env -u TAP_SUITE_SEAT -u TAP_SELF -u TAP_HANDLE -u TAP_PYTHON \
    PATH="/usr/bin:/bin" \
    TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true
) >"$out" 2>&1 || fail "(6) free probe under fake cwd must succeed" "$(cat "$out")"
# Probe clears lease; capture seat while a child waits on a release pipe.
CWD_RELEASE="$WORK/cwd-holder.release"
mkfifo "$CWD_RELEASE"
(
  cd "$FAKE_CWD" || exit 1
  env -u TAP_SUITE_SEAT -u TAP_SELF -u TAP_HANDLE -u TAP_PYTHON \
    CWD_RELEASE="$CWD_RELEASE" \
    PATH="/usr/bin:/bin" \
    "${SLOT_RUN[@]}" -- "$PY" -c 'import json,os; open(os.environ["CWD_RELEASE"]).read(); p=os.environ["TAP_SUITE_LOCK_HOME"]+"/smoke-all.lease.json"; print(json.load(open(p)).get("seat"))'
) >"$WORK/cwd-lease-seat.out" 2>"$WORK/cwd-lease-seat.err" &
CWD_HOLDER=$!
HOLDER_PID="$CWD_HOLDER"
seat_obs=""
lease_seen=0
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -f "$LOCK_HOME/smoke-all.lease.json" ]; then
    lease_seen=1
    seat_obs="$($PY -B -c 'import json,sys; print(json.load(open(sys.argv[1])).get("seat"))' \
      "$LOCK_HOME/smoke-all.lease.json" 2>/dev/null || true)"
    # null / None / empty are all "not invented from cwd"
    case "$seat_obs" in
      WouldBeSeat|*/WouldBeSeat*|trees/tap/WouldBeSeat*) fail "(6) seat must not come from cwd" "$seat_obs" ;;
    esac
    break
  fi
  sleep 0.1
done
[ "$lease_seen" = 1 ] || fail "(6) holder never published its lease" "$(cat "$WORK/cwd-lease-seat.err" 2>/dev/null || true)"
printf '\n' >"$CWD_RELEASE" &
RELEASE_PID=$!
deadline=$((SECONDS + 300))
while kill -0 "$RELEASE_PID" 2>/dev/null; do
  kill -0 "$CWD_HOLDER" 2>/dev/null || {
    kill "$RELEASE_PID" 2>/dev/null || true
    wait "$RELEASE_PID" 2>/dev/null || true
    RELEASE_PID=""
    fail "(6) holder exited before opening the release pipe" "$(cat "$WORK/cwd-lease-seat.err" 2>/dev/null || true)"
  }
  if [ "$SECONDS" -ge "$deadline" ]; then
    kill "$RELEASE_PID" 2>/dev/null || true
    wait "$RELEASE_PID" 2>/dev/null || true
    RELEASE_PID=""
    fail "(6) holder never opened the release pipe"
  fi
  sleep 0.1
done
wait "$RELEASE_PID" || fail "(6) release pipe writer failed"
RELEASE_PID=""
deadline=$((SECONDS + 300))
while kill -0 "$CWD_HOLDER" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    kill -9 "$CWD_HOLDER" 2>/dev/null || true
    wait "$CWD_HOLDER" 2>/dev/null || true
    fail "(6) holder did not exit after release"
  fi
  sleep 0.1
done
wait "$CWD_HOLDER" || fail "(6) holder failed after release" "$(cat "$WORK/cwd-lease-seat.err" 2>/dev/null || true)"
HOLDER_PID=""
bash "$UNLOCK" >/dev/null 2>&1 || true
# Explicit: if a seat was written, it must not equal the cwd basename.
[ "$seat_obs" != "WouldBeSeat" ] \
  || fail "(6) seat equalled cwd basename" "$seat_obs"
echo "suite-slot: (6) seat not inferred from cwd: ok"

# (7) tap-agfo: the lease is legitimately empty in two held-flock windows
# (acquire→write_lease gap; clear before close). The busy refusal must give
# the writer a bounded moment to land the identity, and its no-lease
# fallback must be LABELED a search, not presented as the holder.
cat > "$WORK/lease-fixture-holder.py" <<'PY'
import fcntl, json, os, sys, time
late, lease_pid, hold = float(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
f = open(os.path.join(os.environ["TAP_SUITE_LOCK_HOME"], "smoke-all.lock"), "a+")
fcntl.flock(f.fileno(), fcntl.LOCK_EX)
open(sys.argv[4], "w").close()  # ready: the flock is held
if late < hold:
    time.sleep(late)
    home = os.environ["TAP_SUITE_LOCK_HOME"]
    tmp = os.path.join(home, "smoke-all.lease.json.tmp")
    with open(tmp, "w") as g:
        json.dump({"pid": lease_pid, "started_at": "fixture", "cwd": "(fixture)"}, g)
    os.replace(tmp, os.path.join(home, "smoke-all.lease.json"))
time.sleep(hold)
PY

# The holder signals once it holds the flock, so a slow start on a loaded box
# cannot let the probe find the slot free.
wait_ready() {
  _w=0
  while [ ! -e "$1" ]; do
    _w=$((_w + 1)); [ "$_w" -le 100 ] || fail "(7) fixture holder never took the flock"
    sleep 0.05
  done
}

# (7a) lease lands shortly after acquire: the refusal names ITS holder
"$PY" -B "$WORK/lease-fixture-holder.py" 0.5 424242 6 "$WORK/late-ready" >/dev/null 2>&1 &
LATE_HOLDER=$!
wait_ready "$WORK/late-ready"
out="$WORK/late-lease.out"
set +e
TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(7a) probe must refuse while the raw flock is held" "$(cat "$out")"
grep -q 'holder_pid: 424242' "$out" \
  || fail "(7a) refusal must wait out the lease window and name the landed holder" "$(cat "$out")"
grep -q 'lease not yet written' "$out" \
  && fail "(7a) a landed lease must not be called unwritten" "$(cat "$out")"
kill "$LATE_HOLDER" 2>/dev/null || true
wait "$LATE_HOLDER" 2>/dev/null || true
rm -f "${LOCK_HOME:?}/smoke-all.lease.json"
echo "suite-slot: (7a) refusal waits out the lease window and names the landed holder: ok"

# (7b) no lease at all: the fallback is LABELED a search, not a holder
"$PY" -B "$WORK/lease-fixture-holder.py" 99 424242 3 "$WORK/bare-ready" >/dev/null 2>&1 &
BARE_HOLDER=$!
wait_ready "$WORK/bare-ready"
out="$WORK/no-lease.out"
set +e
TAP_SUITE_SLOT_PROBE=1 "${SLOT_RUN[@]}" -- true >"$out" 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(7b) probe must refuse while the raw flock is held" "$(cat "$out")"
grep -q 'lease not yet written' "$out" \
  || fail "(7b) no-lease refusal must label the fallback as a search" "$(cat "$out")"
grep -Eq 'holder_pid: [0-9]' "$out" \
  && fail "(7b) a search must not be presented as a holder pid" "$(cat "$out")"
kill "$BARE_HOLDER" 2>/dev/null || true
wait "$BARE_HOLDER" 2>/dev/null || true
echo "suite-slot: (7) empty-lease patience and labeled search fallback: ok"

echo "suite-slot: ok"
