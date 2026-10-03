#!/usr/bin/env bash
# wave-session-reap.test.sh — r3908057407 (ruling-670-unit-c-exit-reap.md): the
# runner's EXIT path reaps recorded worker sessions before it deletes their
# sandbox, keeps a foreign session, and keeps a session whose recorded leader
# is alive after the wave completed (pid reuse).
#
# Sources the production runner (functions only; the body lives in
# smoke_all_main) and drives smoke_wave_session_reap and the real
# smoke_all_cleanup against fixture sessions started through the runner's own
# session shim. Synthetic pids file only — no suite slot, no nested runner
# (R-C4), no tmux.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-wave-session-reap.XXXXXX")"
# Every helper this file starts records its pid here; the trap signals exactly
# those pids (never a name, pattern, or group) and nothing else. The ledger is
# scoped to ONE control: before the next control starts, every pid on it must be
# gone and the file is reset, so a later sweep can never signal a number that a
# stranger has since reused — the same class the production live-leader guard
# exists for.
OWN_PIDS="$WORK/own-pids"
: >"$OWN_PIDS"
trap '
  if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      kill -TERM "$p" 2>/dev/null || true
    done <"$OWN_PIDS"
    sleep 0.3
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      kill -KILL "$p" 2>/dev/null || true
    done <"$OWN_PIDS"
    rm -rf "$WORK"
  fi
' EXIT
fail() { echo "wave-session-reap: $1" >&2; exit 1; }
PASS=0
EXPECT=0
expect() { # <got> <want> <label>
  EXPECT=$((EXPECT + 1))
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
    return 0
  fi
  fail "$3 — got $(printf %q "$1") want $(printf %q "$2")"
}
expect_contains() { # <haystack> <needle> <label>
  EXPECT=$((EXPECT + 1))
  if [[ "$1" == *"$2"* ]]; then
    PASS=$((PASS + 1))
    return 0
  fi
  fail "$3 — missing $(printf %q "$2") in: $1"
}

wait_file() { # <path>
  local i
  for i in $(seq 1 50); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  return 1
}
wait_gone() { # <pid> — bounded; prints alive|gone
  local i
  for i in $(seq 1 50); do
    kill -0 "$1" 2>/dev/null || { echo gone; return 0; }
    sleep 0.1
  done
  echo alive
}
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo gone; }
own() { printf '%s\n' "$1" >>"$OWN_PIDS"; }

# Worker fixtures, run through the runner's shim (leader pid == sid).
# descendant: background a sleeper into the session, publish its pid, leader EXITS.
# held:       same, but the leader stays alive (wait) — the interrupted-wave shape.
# Env: REAP_SLEEPER_PID_FILE (pid out), REAP_SETPGID=1 (sleeper takes its own
# pgid), REAP_SANDBOX + REAP_TERM_SEEN (TERM handler records whether the sandbox
# path existed when TERM arrived).
SLEEPER_PY="$WORK/sleeper.py"
cat >"$SLEEPER_PY" <<'PYS'
import os, pathlib, signal, sys, time
if os.environ.get("REAP_SETPGID") == "1":
    os.setpgid(0, 0)
sandbox = os.environ.get("REAP_SANDBOX", "")
seen = os.environ.get("REAP_TERM_SEEN", "")
fork_on_term = os.environ.get("REAP_FORK_ON_TERM", "")
def on_term(signum, frame):
    if seen:
        pathlib.Path(seen + ".tmp").write_text("exists\n" if (sandbox and os.path.exists(sandbox)) else "missing\n", encoding="utf-8"); os.replace(seen + ".tmp", seen)
    if fork_on_term:
        # a "cleanup helper" forked into the same session, published, then left running
        if os.fork() == 0:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)  # the helper dies on TERM; never re-forks
            pathlib.Path(fork_on_term + ".tmp").write_text("%s\n" % os.getpid(), encoding="utf-8"); os.replace(fork_on_term + ".tmp", fork_on_term)
            while True:
                time.sleep(0.1)
    raise SystemExit(0)
if os.environ.get("REAP_IGNORE_TERM") == "1":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    signal.signal(signal.SIGTERM, on_term)
pathlib.Path(os.environ["REAP_SLEEPER_PID_FILE"] + ".tmp").write_text("%s\n" % os.getpid(), encoding="utf-8"); os.replace(os.environ["REAP_SLEEPER_PID_FILE"] + ".tmp", os.environ["REAP_SLEEPER_PID_FILE"])
while True:
    time.sleep(0.1)
PYS
DESCENDANT_SCRIPT="$WORK/descendant.sh"
cat >"$DESCENDANT_SCRIPT" <<'EOS'
#!/usr/bin/env bash
"${TAP_PYTHON:-python3}" -B "$REAP_SLEEPER_PY" &
exit 0
EOS
HELD_SCRIPT="$WORK/held.sh"
cat >"$HELD_SCRIPT" <<'EOS'
#!/usr/bin/env bash
"${TAP_PYTHON:-python3}" -B "$REAP_SLEEPER_PY" &
wait
EOS
chmod +x "$DESCENDANT_SCRIPT" "$HELD_SCRIPT"

ledger_live() { # prints the owned pids that are still alive
  local p out=""
  while IFS= read -r p; do
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && out="$out $p"
  done <"$OWN_PIDS"
  printf '%s' "${out# }"
}
ledger_bytes() { wc -c <"$OWN_PIDS" | tr -d ' '; }
ledger_settle() { # every pid the previous control started must be gone; then reset
  local i live=""
  for i in $(seq 1 50); do
    live="$(ledger_live)"
    [ -z "$live" ] && break
    sleep 0.1
  done
  if [ -n "$live" ]; then
    # Save the diagnostic, then drop the ledger BEFORE failing: the EXIT trap must
    # never signal a pid this file can no longer prove it owns (a stranger may hold it).
    : >"$OWN_PIDS"
    fail "ledger: pids still live from the previous control (ledger dropped, not signalled): $live"
  fi
  : >"$OWN_PIDS"
}

new_probe() {
  ledger_settle
  expect "$(ledger_bytes)" "0" "ledger reset before the next control"
  PROBE="$(mktemp -d "$WORK/probe.XXXXXX")"
  : >"$PROBE/pids"
  rm -f "$PROBE/wave-complete" "$PROBE/wave-done" "$PROBE/self.pid"
}
mark_complete() { : >"$PROBE/wave-complete"; }

start_session() { # <script> — sets $sid (leader) and $sleeper; extra env via caller's exports
  : >"$PROBE/sleeper.pid"
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    export SMOKE_WAVE_PIDS="$PROBE/pids"
    export SMOKE_WAVE_SELF="$PROBE/self.pid"
    export SMOKE_WAVE_DONE="$PROBE/wave-done"
    export REAP_SLEEPER_PY="$SLEEPER_PY"
    export REAP_SLEEPER_PID_FILE="$PROBE/sleeper.pid"
    export TAP_PYTHON="$PY"
    smoke_wave_session_exec "$1"
  ) &
  wait_file "$PROBE/sleeper.pid" || fail "sleeper pid file missing"
  wait_file "$PROBE/pids" || fail "shim did not record the leader pid"
  sid="$(head -n 1 "$PROBE/pids")"
  sleeper="$(tr -d '[:space:]' <"$PROBE/sleeper.pid")"
  own "$sid"; own "$sleeper"
}

start_recorded_undetached() { # sets $pending: recorded in pids, still in this test's session (record→setsid window); REAP_IGNORE_TERM=1 makes it ignore TERM
  "$PY" -B - "$PROBE/pids" "$1" <<'PY' &
import os, sys, time, pathlib, signal
if os.environ.get("REAP_IGNORE_TERM") == "1":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
pid = os.getpid()
open(sys.argv[1], "a", encoding="utf-8").write("%s\n" % pid)
pathlib.Path(sys.argv[2] + ".tmp").write_text("%s\n" % pid, encoding="utf-8"); os.replace(sys.argv[2] + ".tmp", sys.argv[2])
while True:
    time.sleep(0.1)
PY
  wait_file "$1" || fail "undetached fixture pid file missing"
  pending="$(tr -d '[:space:]' <"$1")"
  own "$pending"
}

start_decoy() { # <pid-file> — sets $decoy: a live setsid'd sleeper recorded nowhere the reap reads
  "$PY" -B - "$1" <<'PY' &
import os, sys, time, pathlib
os.setsid()
pathlib.Path(sys.argv[1] + ".tmp").write_text("%s\n" % os.getpid(), encoding="utf-8"); os.replace(sys.argv[1] + ".tmp", sys.argv[1])
time.sleep(120)
PY
  wait_file "$1" || fail "decoy pid file missing"
  decoy="$(tr -d '[:space:]' <"$1")"
  own "$decoy"
}

shim_order() { # recorded-first|setsid-first — the shim must record its pid before it leaves the session
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    printf '%s' "$SMOKE_WAVE_SESSION_EXEC_PY"
  ) | "$PY" -c 'import sys; t = sys.stdin.read(); print("recorded-first" if t.index("SMOKE_WAVE_PIDS") < t.index("os.setsid()") else "setsid-first")'
}

run_reap() { # <pids-file> <marker> — sourced runner, captures stdout and rc; done file is $PROBE/wave-done
  local tmp rcfile
  tmp="$(mktemp "$WORK/reap.XXXXXX")"
  rcfile="$(mktemp "$WORK/rc.XXXXXX")"
  (
    set +e
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    smoke_wave_session_reap "$1" "$2" "$PROBE/wave-done" >"$tmp" 2>&1
    echo "$?" >"$rcfile"
  )
  REAP_OUT="$(cat "$tmp")"
  REAP_RC="$(cat "$rcfile")"
}

run_cleanup() { # <outdir> <sandbox> — the real smoke_all_cleanup, sourced; no tmux root
  (
    set +e
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    smoke_all_cleanup "$1" "$2" "$WORK/no-tmux-root" >/dev/null 2>&1
  )
}

run_cleanup_wedged() { # <outdir> <sandbox> <tmux_root> — real cleanup in its own session,
  # bounded by a 25 s watchdog; prints done, or stuck after killing that session.
  # Only the session this test launched is killed (its own group); the wedged
  # fixture server lives in another session and stays on the OWN_PIDS ledger.
  local i
  perl -MPOSIX=setsid -e 'setsid; exec @ARGV' -- bash -c '
    set +e
    # shellcheck disable=SC1091
    . "$0" >/dev/null 2>&1
    smoke_all_cleanup "$1" "$2" "$3" >/dev/null 2>&1
  ' "$SMOKE_ALL" "$1" "$2" "$3" &
  local p=$!
  own "$p"
  for i in $(seq 1 50); do
    kill -0 "$p" 2>/dev/null || { wait "$p" 2>/dev/null; echo done; return 0; }
    sleep 0.5
  done
  kill -KILL -"$p" 2>/dev/null
  echo stuck
}

start_wedged_server() { # <socket> — a real tmux server, then SIGSTOPped so a client
  # connect is never answered (tap-4df9t). The pid is tmux's own server pid via
  # display-message, no pattern match; only that pid is recorded and only the
  # ledger signals.
  local sock="$1" spid
  tmux -S "$sock" new-session -d -s cw-wedge >/dev/null 2>&1 || fail "C-w could not start fixture server"
  spid="$(tmux -S "$sock" display-message -p '#{pid}')"
  [ -n "$spid" ] || fail "C-w could not identify fixture server pid"
  own "$spid"
  kill -STOP "$spid"
  WEDGED_PID="$spid"
}

run_live_controls() {
  local sid sleeper decoy pending helper outdir sandbox tmux_root

  # C-a normal-exit descendant: leader returned, sleeper lives in the recorded session.
  new_probe
  start_session "$DESCENDANT_SCRIPT"
  [ "$(wait_gone "$sid")" = "gone" ] || fail "C-a leader $sid did not exit"
  mark_complete
  expect "$(alive "$sleeper")" "alive" "C-a sleeper live before reap"
  expect "$(tr -d '[:space:]' <"$PROBE/self.pid")" "$sid" "C-g shim published its own pid to SMOKE_WAVE_SELF"
  expect "$(shim_order)" "recorded-first" "C-g shim records the pid before setsid"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$REAP_RC" "0" "C-a reap rc"
  expect_contains "$REAP_OUT" "smoke-all: reaped 1 worker-session pid(s)" "C-a reap line"
  expect "$(wait_gone "$sleeper")" "gone" "C-a descendant gone after reap"

  # C-a' job-control member: the sleeper took its own pgid inside the session;
  # only a per-pid kill reaches it (R-C2).
  new_probe
  REAP_SETPGID=1 start_session "$DESCENDANT_SCRIPT"
  [ "$(wait_gone "$sid")" = "gone" ] || fail "C-a' leader $sid did not exit"
  mark_complete
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$sleeper")" "gone" "C-a' setpgid member gone after reap"

  # C-b interrupted wave: leader alive, marker absent → leader and member die.
  new_probe
  start_session "$HELD_SCRIPT"
  expect "$(alive "$sid")" "alive" "C-b leader live before reap"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$sleeper")" "gone" "C-b member gone after reap"
  expect "$(wait_gone "$sid")" "gone" "C-b leader gone after reap"

  # C-c KEEP foreign: a live session the pids file never named survives.
  new_probe
  start_decoy "$PROBE/foreign.pid"
  start_session "$DESCENDANT_SCRIPT"
  [ "$(wait_gone "$sid")" = "gone" ] || fail "C-c leader $sid did not exit"
  mark_complete
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$sleeper")" "gone" "C-c recorded descendant gone"
  expect "$(alive "$decoy")" "alive" "C-c foreign session survived"
  kill -TERM "$decoy" 2>/dev/null || true

  # C-d KEEP pid reuse: a live leader whose pid IS a recorded row, after the wave
  # completed, is a stranger who reused the number → whole session kept (R-C1).
  new_probe
  start_session "$DESCENDANT_SCRIPT"
  [ "$(wait_gone "$sid")" = "gone" ] || fail "C-d leader $sid did not exit"
  start_decoy "$PROBE/reuse.pid"
  printf '%s\n' "$decoy" >>"$PROBE/pids"
  mark_complete
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$sleeper")" "gone" "C-d recorded descendant gone"
  expect "$(alive "$decoy")" "alive" "C-d live recorded leader kept as pid reuse"
  kill -TERM "$decoy" 2>/dev/null || true

  # C-f interrupted wave with a FINISHED worker: the finished worker's leader pid was
  # reused by a stranger (decoy, live setsid leader) and is in wave-done; a second
  # worker is still running. Reap kills the running worker, keeps the stranger.
  new_probe
  start_session "$HELD_SCRIPT"
  start_decoy "$PROBE/reused.pid"
  printf '%s\n' "$decoy" >>"$PROBE/pids"
  printf '%s\n' "$decoy" >>"$PROBE/wave-done"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$sleeper")" "gone" "C-f running worker member gone"
  expect "$(wait_gone "$sid")" "gone" "C-f running worker leader gone"
  expect "$(alive "$decoy")" "alive" "C-f finished worker's reused pid kept during interrupted wave"
  kill -TERM "$decoy" 2>/dev/null || true

  # C-j record→setsid window: a worker that recorded its pid but has not yet left the
  # runner's session is invisible to a sid enumeration; on an interrupted wave the reap
  # must signal it by its recorded pid so it cannot detach after cleanup.
  new_probe
  start_recorded_undetached "$PROBE/pending.pid"
  expect "$("$PY" -c 'import os,sys; print("same" if os.getsid(int(sys.argv[1])) == os.getsid(0) else "own")' "$pending")" "same" "C-j fixture still in the caller's session"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$pending")" "gone" "C-j undetached recorded worker reaped on interrupted wave"
  # ... and on a completed wave the same shape is a reused pid: kept.
  new_probe
  start_recorded_undetached "$PROBE/pending.pid"
  mark_complete
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(alive "$pending")" "alive" "C-j recorded live pid kept after completion (reuse rule)"
  kill -TERM "$pending" 2>/dev/null || true

  # C-j′ the same undetached shape ignoring TERM: the KILL round must take it.
  new_probe
  REAP_IGNORE_TERM=1 start_recorded_undetached "$PROBE/pending.pid"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$(wait_gone "$pending")" "gone" "C-j' TERM-ignoring undetached worker gone after KILL"

  # C-k a worker whose TERM handler forks a same-session helper: the re-enumerated
  # poll must pick the helper up; a frozen initial list would leave it running.
  new_probe
  REAP_FORK_ON_TERM="$PROBE/helper.pid" start_session "$HELD_SCRIPT"
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  wait_file "$PROBE/helper.pid" || fail "C-k helper pid file missing (TERM handler never forked)"
  helper="$(tr -d '[:space:]' <"$PROBE/helper.pid")"
  own "$helper"
  expect "$(wait_gone "$sleeper")" "gone" "C-k original sleeper gone"
  expect "$(wait_gone "$helper")" "gone" "C-k helper forked by the TERM handler gone"

  # C-d' slot row: TAP_SUITE_SLOT_PID is membership, never a session (interrupted shape,
  # so the live-leader guard cannot be what saves it).
  new_probe
  start_decoy "$PROBE/slot.pid"
  printf '%s\n' "$decoy" >>"$PROBE/pids"
  TAP_SUITE_SLOT_PID="$decoy" run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$REAP_RC" "0" "C-d' slot-only reap rc"
  expect "$(alive "$decoy")" "alive" "C-d' slot-row session survived"
  kill -TERM "$decoy" 2>/dev/null || true

  # C-e ordering through the real cleanup: the sleeper's TERM handler must see the
  # sandbox still present, and cleanup must then remove sandbox and outdir.
  new_probe
  outdir="$PROBE/outdir"; sandbox="$PROBE/smoke-all-sandbox.fixture"
  mkdir -p "$outdir" "$sandbox"
  REAP_SANDBOX="$sandbox" REAP_TERM_SEEN="$PROBE/term-seen" start_session "$DESCENDANT_SCRIPT"
  [ "$(wait_gone "$sid")" = "gone" ] || fail "C-e leader $sid did not exit"
  cp "$PROBE/pids" "$outdir/wave-pids"
  : >"$outdir/wave-complete"
  run_cleanup "$outdir" "$sandbox"
  expect "$(wait_gone "$sleeper")" "gone" "C-e descendant gone after cleanup"
  wait_file "$PROBE/term-seen" || fail "C-e TERM handler never ran"
  expect "$(tr -d '[:space:]' <"$PROBE/term-seen")" "exists" "C-e sandbox present when TERM arrived"
  expect "$([ -e "$sandbox" ] && echo present || echo removed)" "removed" "C-e sandbox removed"
  expect "$([ -e "$outdir" ] && echo present || echo removed)" "removed" "C-e outdir removed"

  # C-w tap-4df9t: a wedged (stopped) tmux server inside the run's tmux root must
  # not park the EXIT trap. cleanup's kill-server is bounded; at the bound the
  # client dies, cleanup proceeds, and the retained root degrades exactly like an
  # lsof error. The fixture server is kept: cleanup may not kill a session no
  # ledger of this run recorded. Scope: C-w pins the kill-server bound only —
  # this root does not match /tmp/tap-tmux.*, so smoke_remove_tmux_root refuses
  # before its lsof runs, and the 30s lsof bound is untested here (deliberate:
  # a wedged-mount fixture is out of scope).
  new_probe
  tmux_root="$WORK/tmux-root-wedged"
  mkdir -p "$tmux_root" "$PROBE/outdir" "$PROBE/smoke-all-sandbox.wedged"
  start_wedged_server "$tmux_root/wedged.sock"
  expect "$(run_cleanup_wedged "$PROBE/outdir" "$PROBE/smoke-all-sandbox.wedged" "$tmux_root")" \
    "done" "C-w cleanup finished with a stopped server"
  expect "$([ -e "$PROBE/outdir" ] && echo present || echo removed)" "removed" "C-w outdir removed"
  expect "$([ -e "$PROBE/smoke-all-sandbox.wedged" ] && echo present || echo removed)" "removed" "C-w sandbox removed"
  expect "$(alive "$WEDGED_PID")" "alive" "C-w wedged fixture server kept"
  kill -CONT "$WEDGED_PID" 2>/dev/null || true

  # C-x tap-4df9t: the bound is hard at the wrapper itself. A slow child under a
  # 1s bound must exit 124 promptly; on the review-thread path (child stuck past
  # SIGKILL, e.g. lsof in uninterruptible I/O) the wrapper abandons it via
  # os._exit instead of waiting. Output re-emission through an unlinked temp file
  # is pinned so an abandoned child can never hold a $(...) pipe write end.
  new_probe
  bx="$WORK/bounded.out"
  t0=$(date +%s)
  brc=0
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    TAP_PYTHON="$PY"
    rc=0
    smoke_bounded 1 sleep 5 >"$bx" 2>/dev/null || rc=$?
    exit "$rc"
  ) || brc=$?
  t1=$(date +%s)
  expect "$brc" "124" "C-x bounded slow child exits 124"
  expect "$(( t1 - t0 <= 3 ))" "1" "C-x bound fired promptly, not the full sleep"
  bemit="$( 
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    TAP_PYTHON="$PY"
    smoke_bounded 5 echo bounded-emit
  )"
  expect "$bemit" "bounded-emit" "C-x stdout re-emitted after the wait"

  # Empty / absent file: nothing to do, rc 0, no output.
  new_probe
  run_reap "$PROBE/pids" "$PROBE/wave-complete"
  expect "$REAP_RC" "0" "empty pids rc"
  expect "$REAP_OUT" "" "empty pids output"

  # C-h r3916183747: after the smoke child exits, the session leader publishes
  # wave-done while still allocated, then blocks on a test-only FIFO so the
  # sampler can classify liveness at publication without racing SystemExit.
  # `|| rc=$?` keeps the post-exec cat reachable under set -e — that cat is
  # the old outer-wrapper path: harmless duplicate on the real shim, load-bearing
  # for m9 (publish after the leader has already exited).
  new_probe
  mkfifo "$PROBE/barrier"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 17' >"$PROBE/child.sh"
  chmod +x "$PROBE/child.sh"
  : >"$PROBE/wave-done"
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    export SMOKE_WAVE_PIDS="$PROBE/pids"
    export SMOKE_WAVE_SELF="$PROBE/self.pid"
    export SMOKE_WAVE_DONE="$PROBE/wave-done"
    export SMOKE_WAVE_DONE_BARRIER="$PROBE/barrier"
    export SMOKE_WAVE_LEADER_RC="$PROBE/leader.rc"
    export TAP_PYTHON="$PY"
    rc=0
    smoke_wave_session_exec "$PROBE/child.sh" || rc=$?
    echo "$rc" >"$PROBE/leader.rc.tmp" && mv -f "$PROBE/leader.rc.tmp" "$PROBE/leader.rc"
    if [ -s "$PROBE/self.pid" ]; then
      cat "$PROBE/self.pid" >>"$PROBE/wave-done"
    fi
  ) &
  wrap=$!
  wait_file "$PROBE/pids" || fail "C-h shim did not record the leader pid"
  sid="$(head -n 1 "$PROBE/pids")"
  own "$sid"
  expect "$(alive "$sid")" "alive" "C-h leader live after child exit (blocked on FIFO)"
  released=0 got=""
  i=0
  for i in $(seq 1 20); do
    got="$(tr -d '[:space:]' <"$PROBE/wave-done" 2>/dev/null)"
    [ -n "$got" ] && break
    sleep 0.05
  done
  if [ -z "$got" ]; then
    cat "$PROBE/barrier" >/dev/null &
    released=1
    for i in $(seq 1 50); do
      got="$(tr -d '[:space:]' <"$PROBE/wave-done" 2>/dev/null)"
      [ -n "$got" ] && break
      sleep 0.1
    done
  fi
  echo "$(alive "$sid") ${got:-missing}" >"$PROBE/pub_state"
  [ "$released" -eq 1 ] || cat "$PROBE/barrier" >/dev/null &
  expect "$(awk '{print $1}' "$PROBE/pub_state")" "alive" "C-h live-before-publication"
  expect "$(awk '{print $2}' "$PROBE/pub_state")" "$sid" "C-h published exact leader pid"
  expect "$(wait_gone "$sid")" "gone" "C-h leader exited after publication"
  wait "$wrap" 2>/dev/null || true
  wait_file "$PROBE/leader.rc" || fail "C-h leader.rc missing"
  expect "$(tr -d '[:space:]' <"$PROBE/leader.rc")" "17" "C-h leader exits with child status"
}

mutate_copy() { # <path> <before> <after> — the anchor must occur exactly once
  BEFORE="$2" AFTER="$3" "$PY" -B - "$1" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
before, after = os.environ["BEFORE"], os.environ["AFTER"]
if text.count(before) != 1:
    raise SystemExit(f"mutation anchor count={text.count(before)} for {before!r}")
path.write_text(text.replace(before, after), encoding="utf-8")
PY
}

stop_own() { # whatever a failed arm left alive is ours (current control only): TERM, bounded wait, KILL, prove gone, reset
  local p i live=""
  while IFS= read -r p; do [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true; done <"$OWN_PIDS"
  for i in $(seq 1 20); do
    live="$(ledger_live)"
    [ -z "$live" ] && break
    sleep 0.1
  done
  # a fixture that ignores TERM (C-j′) is still ours: KILL it by recorded pid
  for p in $live; do kill -KILL "$p" 2>/dev/null || true; done
  for i in $(seq 1 30); do
    live="$(ledger_live)"
    [ -z "$live" ] && break
    sleep 0.1
  done
  if [ -n "$live" ]; then
    : >"$OWN_PIDS"
    fail "stop_own: owned pids still live after TERM (ledger dropped, not signalled): $live"
  fi
  : >"$OWN_PIDS"
}

run_mutant() { # <name> <before> <after> — every mutant NARROWS or reorders the reap;
  local name="$1" before="$2" after="$3" tree out rc=0   # a widening mutant is never run.
  tree="$WORK/mutant-$name"
  mkdir -p "$tree/scripts"
  cp "$ROOT/scripts/smoke-all.sh" "$tree/scripts/smoke-all.sh"
  mutate_copy "$tree/scripts/smoke-all.sh" "$before" "$after"
  out="$WORK/mutant-$name.out"
  set +e
  (
    SMOKE_ALL="$tree/scripts/smoke-all.sh"
    run_live_controls
  ) >"$out" 2>&1
  rc=$?
  set -e
  stop_own
  expect "$(ledger_bytes)" "0" "mutant $name ledger drained"
  if [ "$rc" -eq 0 ]; then
    echo "wave-session-reap: mutant $name SURVIVED" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "wave-session-reap: mutant $name proven RED — $(grep -m1 '^wave-session-reap:' "$out" | sed 's/^wave-session-reap: //')"
}

# Unmodified scratch must stay green so a copy error cannot mint fake REDs.
BASE="$WORK/base"
mkdir -p "$BASE/scripts"
cp "$SMOKE_ALL" "$BASE/scripts/smoke-all.sh"
(
  SMOKE_ALL="$BASE/scripts/smoke-all.sh"
  run_live_controls
) || {
  echo "wave-session-reap: unmodified scratch failed (not a mutant)" >&2
  exit 1
}
echo "wave-session-reap: scratch baseline green"

PASS=0
EXPECT=0
run_live_controls

# M-1 drop the reap from cleanup → C-e sleeper never signalled.
run_mutant m1-drop-reap \
  '  smoke_wave_session_reap "$outdir/wave-pids" "$outdir/wave-complete" "$outdir/wave-done"
' \
  '  :
'
# M-2 pgid-only kill → the setpgid member (C-a') survives.
run_mutant m2-pgid-only \
  '            os.kill(pid, sig)
' \
  '            os.kill(-os.getsid(pid), sig)
'
# M-3 drop the live-leader guard (every exit treated as interrupted) → C-d decoy dies.
run_mutant m3-drop-live-leader-guard \
  'reused = {sid for sid in sids if sid in alive and (complete or sid in done)}' \
  'reused = set()'
# M-4 reap AFTER the sandbox is removed (one anchor, whole body reordered) →
# C-e's TERM handler sees the sandbox missing.
run_mutant m4-reap-after-rm \
  '  smoke_wave_session_reap "$outdir/wave-pids" "$outdir/wave-complete" "$outdir/wave-done"
  if [ -d "$tmux_root" ]; then
    while IFS= read -r socket; do
      case "$socket" in "$tmux_root"/*) smoke_bounded 10 tmux -S "$socket" kill-server 2>/dev/null || true ;; esac
    done < <(find "$tmux_root" -type s -print 2>/dev/null)
  fi
  smoke_remove_tmux_root "$tmux_root" || true
  rm -rf "$outdir"
  case "$sandbox" in */smoke-all-sandbox.*) rm -rf "$sandbox" ;; esac
}' \
  '  if [ -d "$tmux_root" ]; then
    while IFS= read -r socket; do
      case "$socket" in "$tmux_root"/*) smoke_bounded 10 tmux -S "$socket" kill-server 2>/dev/null || true ;; esac
    done < <(find "$tmux_root" -type s -print 2>/dev/null)
  fi
  smoke_remove_tmux_root "$tmux_root" || true
  case "$sandbox" in */smoke-all-sandbox.*) rm -rf "$sandbox" ;; esac
  smoke_wave_session_reap "$outdir/wave-pids" "$outdir/wave-complete" "$outdir/wave-done"
  rm -rf "$outdir"
}'

# M-5 slot row treated as a session → C-d' decoy dies.
run_mutant m5-drop-slot-exclusion \
  'if raw and raw != slot and raw.isdigit():' \
  'if raw and raw.isdigit():'

# M-6 drop the completion ledger from the reuse rule → C-f decoy dies.
run_mutant m6-drop-done-ledger \
  'reused = {sid for sid in sids if sid in alive and (complete or sid in done)}' \
  'reused = {sid for sid in sids if sid in alive and complete}'
# M-7 shim leaves the session before recording its pid (the r3909244230 order) → C-g order check reds.
run_mutant m7-setsid-before-record \
  'open(os.environ["SMOKE_WAVE_PIDS"], "a", encoding="utf-8").write("%s\n" % pid)
self_path = os.environ.get("SMOKE_WAVE_SELF")
if self_path:
    open(self_path, "w", encoding="utf-8").write("%s\n" % pid)
os.setsid()' \
  'os.setsid()
open(os.environ["SMOKE_WAVE_PIDS"], "a", encoding="utf-8").write("%s\n" % pid)
self_path = os.environ.get("SMOKE_WAVE_SELF")
if self_path:
    open(self_path, "w", encoding="utf-8").write("%s\n" % pid)'
# M-8 shim stops publishing its pid → C-g self-file check reds (and production could never record completion).
run_mutant m8-drop-self-publish \
  '    open(self_path, "w", encoding="utf-8").write("%s\n" % pid)' \
  '    pass'
# M-9 completion published only after the leader has exited (old outer wrapper) →
# C-h live-before-publication reds.
run_mutant m9-outer-wrapper-publication \
  '    open(done_path, "a", encoding="utf-8").write("%s\n" % pid)' \
  '    pass'

# M-10 drop the recorded-live targets → C-j undetached worker survives.
run_mutant m10-drop-direct-recorded \
  '        if sid in alive and sid != os.getpid() and sid not in found:
            found.append(sid)' \
  '        pass'
# M-11 freeze the survivor filter to the initial list → C-k helper survives.
run_mutant m11-frozen-survivor-filter \
  '    current = targets(live_pids())  # re-enumerate: arrivals join, the dead drop out' \
  '    current = [pid for pid in signalled if pid in targets(live_pids())]'

# M-12 drop the kill-server bound → C-w cleanup parks against the stopped server
# and the watchdog reds.
run_mutant m12-drop-kill-server-bound \
  'case "$socket" in "$tmux_root"/*) smoke_bounded 10 tmux -S "$socket" kill-server 2>/dev/null || true ;; esac' \
  'case "$socket" in "$tmux_root"/*) tmux -S "$socket" kill-server 2>/dev/null || true ;; esac'

# M-13 drop the bound wait in the wrapper (Popen.wait() unbounded — the review-
# thread trap: a child stuck past SIGKILL parks the wrapper) → C-x reds.
run_mutant m13-drop-bound-wait \
  'rc = p.wait(timeout=bound)' \
  'rc = p.wait()'

echo "wave-session-reap: $PASS pass / 0 fail / $EXPECT expect() — live controls green; 13 mutants proven RED"
