#!/usr/bin/env bash
# suite-load-disposition.test.sh — every red cites the load this run recorded,
# and a tmux fork-ENXIO refusal the RUNNER observed is offered as a rerun
# candidate rather than a verdict (tap-7r3fn.31 part (b)).
#
# WHERE THE CLASSIFICATION COMES FROM IS THE WHOLE DESIGN. A first version read
# the failing test's own combined output, which meant any file that printed
# tmux's wording — a fixture, a doc test, a quoted incident report — could ask
# to be rerun instead of fixed. The record now comes from the runner's tmux
# shim, which sees the real binary's stderr and keys the refusal to the file
# that was running. Arm (1) is that defect, kept as a standing control.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="${SMOKE_ALL_UNDER_TEST:-$ROOT/scripts/smoke-all.sh}"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "suite-load-disposition: $1" >&2; exit 1; }

[ -f "$SMOKE_ALL" ] || fail "runner under test not found: $SMOKE_ALL"

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
BASE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WORKER="$FIXTURE/skills/tap/scripts/smoke/load-worker.test.sh"
WORKER_REL="skills/tap/scripts/smoke/load-worker.test.sh"
mkdir -p \
  "$FIXTURE/scripts" \
  "$FIXTURE/skills/tap/scripts/smoke" \
  "$FIXTURE_HOME" \
  "$FIXTURE_LOCKS"
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"
cp "$ROOT/scripts/suite-slot-run.py" "$FIXTURE/scripts/suite-slot-run.py"
cp "$ROOT/scripts/suite_slot.py" "$FIXTURE/scripts/suite_slot.py"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke-preflight.sh"
cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"

# The kernel will not refuse to fork on demand, and the runner rebuilds its own
# PATH, so the refusal cannot be staged from outside. It is staged at the one
# seam a worker can reach: the shim's record of which binary is "the real tmux".
# The shim, its ledger and the classifier then all run for real, and only the
# binary is stood in for.
cat >"$WORK/stub-fork-refusal" <<'STUB'
#!/usr/bin/env bash
echo "respawn pane failed: fork failed: Device not configured" >&2
exit 1
STUB
cat >"$WORK/stub-other-device" <<'STUB'
#!/usr/bin/env bash
echo "can't create socket: /dev/ttys999: Device not configured" >&2
exit 1
STUB
chmod +x "$WORK/stub-fork-refusal" "$WORK/stub-other-device"

run_suite() {
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="$BASE_PATH" \
    TERM="dumb" \
    LANG="C" \
    LC_CTYPE="en_US.UTF-8" \
    TZ="UTC" \
    TAP_PYTHON="$PY" \
    TAP_SUITE_SLOT="bypass" \
    TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    bash "$FIXTURE/scripts/smoke-all.sh" -j 1 2>&1
}

# <exit-status> <line...> — each line is echoed verbatim by the fixture worker.
write_worker() {
  local status="$1"; shift
  {
    echo '#!/usr/bin/env bash'
    local line
    for line in "$@"; do printf 'echo %s\n' "$(printf '%q' "$line")"; done
    echo "exit $status"
  } >"$WORKER"
  chmod +x "$WORKER"
}

# <session-name> <stub> <exit-status> — the worker points the runner's tmux shim
# at <stub> for one spawn, then restores it. The shim's directory is the first
# entry of the PATH the runner handed this worker.
write_spawning_worker() {
  local session="$1" stub="$2" status="$3"
  cat >"$WORKER" <<WORKER
#!/usr/bin/env bash
guard_dir="\${PATH%%:*}"
saved="\$(cat "\$guard_dir/real-tmux")"
printf '%s\n' "$stub" >"\$guard_dir/real-tmux"
tmux -L ltprobe new-session -d -s "$session" true || true
printf '%s\n' "\$saved" >"\$guard_dir/real-tmux"
echo "load-worker: the spawn above did not succeed"
exit $status
WORKER
  chmod +x "$WORKER"
}

has() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

# --- (1) printing the signature is not the same as hitting it ----------------
# The defect this file was rewritten around. A test's own output must never buy
# it a rerun: "rerun it" is the wrong disposition for a real failure, and the
# words are cheap to emit by accident.
write_worker 1 "load-worker: respawn pane failed: fork failed: Device not configured"
if echoed_out="$(run_suite)"; then fail "(1) the suite reported success on a failing worker: $echoed_out"; fi

if has " — ok — all " "$echoed_out"; then fail "(1) a red run left a quotable terminal green: $echoed_out"; fi
has "(at entry); load1m=" "$echoed_out" \
  || fail "(1) the failing file did not cite the recorded load beside it: $echoed_out"
if has "load-transient" "$echoed_out"; then
  fail "(1) a file that only PRINTED the signature was classed load-transient: $echoed_out"
fi
echo "suite-load-disposition: (1) printing the signature is cited but NOT classed: ok"

# --- (2) an ordinary red is cited too ----------------------------------------
write_worker 1 "load-worker: an ordinary assertion failed"
if plain_out="$(run_suite)"; then fail "(2) the suite reported success on a failing worker: $plain_out"; fi

has "(at entry); load1m=" "$plain_out" \
  || fail "(2) an ordinary red did not cite the recorded load: $plain_out"
if has "load-transient" "$plain_out"; then
  fail "(2) an ordinary red was classed as a load-transient candidate: $plain_out"
fi
echo "suite-load-disposition: (2) an ordinary red cites the load and is NOT classed: ok"

# --- (3) a real spawn refusal that is NOT the fork wording -------------------
# Observed by the runner, at the right file, and still not this class. Matching
# "Device not configured" alone would relabel it.
write_spawning_worker "lt-other-device-$$" "$WORK/stub-other-device" 1
if other_out="$(run_suite)"; then fail "(3) the suite reported success on a failing worker: $other_out"; fi

if has "load-transient" "$other_out"; then
  fail "(3) a device error that is not a fork refusal was classed: $other_out"
fi
echo "suite-load-disposition: (3) a runner-observed device error that is not a fork refusal is NOT classed: ok"

# --- (4) a real fork-ENXIO refusal, recorded by the runner -------------------
write_spawning_worker "lt-fork-refusal-$$" "$WORK/stub-fork-refusal" 1
if fork_out="$(run_suite)"; then fail "(4) the suite reported success on a failing worker: $fork_out"; fi

if has " — ok — all " "$fork_out"; then fail "(4) a red run left a quotable terminal green: $fork_out"; fi
has "1/1 FAILED" "$fork_out" \
  || fail "(4) the candidate was subtracted from the red count instead of printed beside it: $fork_out"
has "(at entry); load1m=" "$fork_out" \
  || fail "(4) the failing file did not cite the recorded load: $fork_out"
has "$WORKER_REL — load-transient candidate (rerun same head)" "$fork_out" \
  || fail "(4) a runner-observed fork refusal was not offered as a load-transient candidate: $fork_out"
has "load-transient candidates: 1 ($WORKER_REL)" "$fork_out" \
  || fail "(4) the receipt did not summarize the candidate: $fork_out"
echo "suite-load-disposition: (4) a runner-observed fork-ENXIO refusal is classed, summarized, and stays a failure: ok"

# --- (5) a green run says nothing about any of this --------------------------
write_worker 0 "load-worker: ok"
green_out="$(run_suite)" || fail "(5) the green fixture suite failed: $green_out"

has " — ok — all 1 files passed" "$green_out" \
  || fail "(5) the terminal green line was disturbed: $green_out"
if has "load-transient" "$green_out"; then
  fail "(5) a green run emitted the candidate vocabulary: $green_out"
fi
if has "(at entry); load1m=" "$green_out"; then
  fail "(5) a green run cited a per-file load line for a file that did not fail: $green_out"
fi
echo "suite-load-disposition: (5) a green run carries neither the citation nor the class: ok"

# --- causal controls ---------------------------------------------------------
# Each re-invokes THIS file against a mutated copy of the runner and asserts
# WHICH arm the child died on, not merely that it died. The recursion
# terminates because every mutant reds at an arm that runs before this section.
mutate_runner() {  # <dest> <old> <new>
  cp "$SMOKE_ALL" "$1"
  MUT_OLD="$2" MUT_NEW="$3" "$PY" - "$1" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old, new = os.environ["MUT_OLD"], os.environ["MUT_NEW"]
if text.count(old) != 1:
    raise SystemExit("expected exactly one site to mutate, found %d" % text.count(old))
path.write_text(text.replace(old, new, 1))
PY
}

run_mutant() {  # <name> <dest> <old> <new> <expected-arm-text> <arm-label>
  local out
  mutate_runner "$2" "$3" "$4"
  if out="$(SMOKE_ALL_UNDER_TEST="$2" bash "${BASH_SOURCE[0]}" 2>&1)"; then
    fail "$1: the mutated runner still passed this file: $out"
  fi
  if ! has "$5" "$out"; then
    fail "$1: reddened somewhere other than arm $6: $out"
  fi
}

# (6) the original defect, reintroduced: classify from the failing file's log.
run_mutant "(6)" "$WORK/reads-the-log.sh" \
  'if smoke_load_transient_refusal "$rel"; then' \
  'if grep -qF "fork failed: Device not configured" "$log" 2>/dev/null; then' \
  "(1) a file that only PRINTED the signature was classed load-transient" "(1)"
echo "suite-load-disposition: (6) classifying from the failing file's own log is caught by arm (1): ok"

# (7) the runner stops recording what its shim saw.
run_mutant "(7)" "$WORK/no-record.sh" \
  "    printf 'TMUX-FORK-REFUSAL\\t%s\\t%s\\n' \"\${SMOKE_SUITE_FILE:--}\" \"\${args[*]}\" >>\"\$guard_dir/fork-refusals\"" \
  '    : # refusal record removed by control mutant' \
  "(4) a runner-observed fork refusal was not offered as a load-transient candidate" "(4)"
echo "suite-load-disposition: (7) dropping the shim's refusal record is caught by arm (4): ok"

# (8) the shim widens what it calls a fork refusal.
run_mutant "(8)" "$WORK/wide-signature.sh" \
  "  if [ \"\$rc\" -ne 0 ] && grep -qF 'fork failed: Device not configured' \"\$err\"; then" \
  "  if [ \"\$rc\" -ne 0 ] && grep -qF 'Device not configured' \"\$err\"; then" \
  "(3) a device error that is not a fork refusal was classed" "(3)"
echo "suite-load-disposition: (8) widening the shim's signature to any device error is caught by arm (3): ok"

# (9)(10) the two emitted labels. Relabelled rather than deleted: the class is a
# string a human acts on, so a control proving only "some line was printed"
# would survive renaming it to anything.
run_mutant "(9)" "$WORK/class-relabelled.sh" \
  '$rel — load-transient candidate (rerun same head):' \
  '$rel — mutant relabelled the candidate class:' \
  "(4) a runner-observed fork refusal was not offered as a load-transient candidate" "(4)"
echo "suite-load-disposition: (9) relabelling the per-file candidate class is caught by arm (4): ok"

run_mutant "(10)" "$WORK/summary-relabelled.sh" \
  'load-transient candidates: $_load_transient_n' \
  'mutant relabelled the candidate summary: $_load_transient_n' \
  "(4) the receipt did not summarize the candidate" "(4)"
echo "suite-load-disposition: (10) relabelling the candidate summary is caught by arm (4): ok"

run_mutant "(11)" "$WORK/citation-removed.sh" \
  '    echo "$_suite_load_line (at entry); load1m=$_receipt_load at receipt"' \
  '    : # per-file load citation removed by control mutant' \
  "(1) the failing file did not cite the recorded load beside it" "(1)"
echo "suite-load-disposition: (11) removing the per-file load citation is caught by arm (1): ok"

echo "suite-load-disposition: ok"
