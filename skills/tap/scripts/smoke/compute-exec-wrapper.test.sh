#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# compute-exec-wrapper.test.sh — the two things scripts/compute-exec.sh promises.
#
# It promises (1) it invokes from the PRIMARY checkout, so a `cd` in the caller
# cannot break `compute exec`'s seat resolution, and (2) it converts compute's
# exit-0-shaped refusal into a real nonzero. Arm 1 proves the actual fix; arm 2
# proves the belt. Arms 3-5 are the controls that stop arm 2 from being a blanket
# failure: a pass-through status, a clean success, and stdout integrity must all
# survive. Without those, a wrapper that simply always failed would pass arm 2.
#
# `compute` is stubbed on PATH per the established pattern in this suite (see the
# nobun arms in watch-context-pressure): the stub is the only way to produce a
# refusal on demand, since a real one needs an unenrolled cwd.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "scripts/compute-exec.sh"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

WRAPPER="$ROOT/scripts/compute-exec.sh"
[ -f "$WRAPPER" ] || { echo "compute-exec-wrapper: $WRAPPER missing" >&2; exit 1; }

WORK="$(mktemp -d)"
# The probe worktree in arm 5 registers itself in the REAL checkout's common .git.
# A failure under `set -e` before arm 5's explicit cleanup would delete the
# directory with $WORK and leave the registration behind, so repeated failing runs
# would accumulate `.git/worktrees/*` entries in repository-global state. Removing
# it is therefore the trap's job, not the happy path's (review P2).
PROBE_WT=""
cleanup() {
  if [ -n "$PROBE_WT" ]; then
    git -C "$ROOT" worktree remove --force "$PROBE_WT" >/dev/null 2>&1 || true
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"

fail() { echo "compute-exec-wrapper: $1" >&2; exit 1; }

# Write a `compute` stub. $1 = the body it runs for `exec`.
stub() {
  cat > "$BIN/compute" <<EOF
#!/usr/bin/env bash
[ "\${1:-}" = exec ] || { echo "stub: unexpected verb '\${1:-}'" >&2; exit 64; }
shift
$1
EOF
  chmod +x "$BIN/compute"
}

run_wrapper() { # runs the wrapper with the stub first on PATH; echoes stdout, returns its rc
  ( PATH="$BIN:$PATH"; bash "$WRAPPER" --task t/x --timeout 1m -- true ) 2>"$WORK/err"
}

# --- arm 1: the refusal becomes a real nonzero -------------------------------
# The whole point. The stub reproduces compute's own shape: the message on stderr
# and EXIT 0.
stub 'echo "compute: Register with TAP before requesting compute" >&2; exit 0'
rc=0; run_wrapper >/dev/null || rc=$?
[ "$rc" != 0 ] || fail "arm 1: an exit-0 refusal passed through as success — the wrapper's only job"
[ "$rc" = 70 ] || fail "arm 1: expected 70 for a refusal, got $rc"
grep -q 'nothing ran' "$WORK/err" || fail "arm 1: the refusal must say nothing ran (the stale-log trap), got: $(cat "$WORK/err")"

# --- arm 2 (control): a REAL failure status passes through unchanged ----------
# If this reported 70 too, arm 1 would prove nothing: a wrapper that always failed
# would satisfy it.
stub 'echo "boom" >&2; exit 7'
rc=0; run_wrapper >/dev/null || rc=$?
[ "$rc" = 7 ] || fail "arm 2: a genuine exit 7 must pass through, got $rc (a blanket failure would make arm 1 meaningless)"

# --- arm 3 (control): success stays success ----------------------------------
stub 'exit 0'
rc=0; run_wrapper >/dev/null || rc=$?
[ "$rc" = 0 ] || fail "arm 3: a clean run must stay 0, got $rc"

# --- arm 4 (control): the command's stdout reaches the caller ----------------
stub 'echo PAYLOAD-STDOUT; exit 0'
got="$(run_wrapper)" || fail "arm 4: wrapper failed on a succeeding stub"
[ "$got" = "PAYLOAD-STDOUT" ] || fail "arm 4: stdout not passed through verbatim, got '$got'"

# --- arm 5: it really does invoke from the PRIMARY ---------------------------
# The refusal-detection above is a belt; THIS is the fix. Invoke the wrapper from a
# linked worktree and assert the stub observes the primary as its cwd. A hardcoded
# path would also pass here, so the arm additionally checks the derivation is not
# this machine's literal string but the common-git-dir parent.
stub 'echo "CWD=$PWD"; exit 0'
PRIMARY="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
[ -n "$PRIMARY" ] || fail "arm 5: could not derive the primary for the assertion"

probe_wt="$WORK/linked"
git -C "$ROOT" worktree add --detach -q "$probe_wt" HEAD 2>/dev/null \
  || fail "arm 5: could not create a linked worktree to invoke from"
PROBE_WT="$probe_wt"   # hand it to the trap BEFORE the call that can fail
observed="$( cd "$probe_wt" && PATH="$BIN:$PATH" bash "$WRAPPER" --task t/x --timeout 1m -- true 2>/dev/null )"

[ "$observed" = "CWD=$PRIMARY" ] \
  || fail "arm 5: invoked from a linked worktree, compute saw '$observed' but the primary is '$PRIMARY'"

# and the negative half of arm 5: the worktree is NOT the primary, so the arm above
# would have failed had the wrapper simply inherited the caller's directory.
[ "$probe_wt" != "$PRIMARY" ] || fail "arm 5: the probe worktree equals the primary — the arm cannot discriminate"

# --- arm 6: a stderr-HEAVY refusal is still detected (the race shape) ----------
# The first version captured stderr with `2> >(tee "$err" >&2)`. A reviewer
# measured that pattern losing 1 of 300 iterations when 64KB of stderr preceded the
# marker: bash does not wait for a process substitution, so tee could still owe
# bytes when the grep ran, and the refusal passed through as exit 0 -- this
# wrapper's own motivating bug, intermittently. Capture-and-relay closes it. This
# arm is the fixture for that shape: filler first, marker last, so a detection that
# reads an incomplete file misses it.
stub 'head -c 65536 /dev/zero | tr "\0" "x" >&2; echo >&2; echo "compute: Register with TAP before requesting compute" >&2; exit 0'
rc=0; run_wrapper >/dev/null || rc=$?
[ "$rc" = 70 ] || fail "arm 6: a refusal behind 64KB of stderr was missed (got $rc) — the detection is racing the capture"
grep -q 'nothing ran' "$WORK/err" || fail "arm 6: detected but did not report nothing-ran"
# and the caller must still SEE that stderr, not have it swallowed by the capture
[ "$(wc -c < "$WORK/err" | tr -d ' ')" -gt 60000 ] \
  || fail "arm 6: the command's stderr did not reach the caller ($(wc -c < "$WORK/err") bytes) — capture must relay, not swallow"

# --- arm 7: the TASK's own stderr must not be mistaken for a refusal ------------
# compute relays task output, so an unanchored match also saw the job's stderr. A
# job whose output legitimately contains that sentence -- running this very smoke
# file under the wrapper is the canonical case -- would be reported as a refusal
# that never happened, and its real status discarded. The `^compute: ` anchor is
# what makes this arm pass; without it the wrapper reports 70 here.
stub 'echo "test log: the string compute: Register with TAP before requesting compute appears in my output" >&2; exit 3'
rc=0; run_wrapper >/dev/null || rc=$?
[ "$rc" = 3 ] || fail "arm 7: a task echoing the refusal text was misread as a refusal (got $rc, want its real 3)"

# --- arm 8: the capture MECHANISM, because arm 6 cannot prove the race is closed --
# Arm 6 exercises the heavy-stderr shape, and it is worth having, but it must not be
# mistaken for a race detector: a reviewer measured the racy form losing 1 of
# 300 iterations, so a single run passes ~99.7% of the time WITH the defect present
# (verified — restoring the process substitution left arm 6 green). A probabilistic
# defect is not provable by one iteration, and looping 300 times here would buy a
# deterministic answer at a cost the gate should not pay.
#
# So assert the mechanism instead. This is deterministic, cheap, and honest about
# what it proves: that the wrapper captures stderr with the shell's own redirect --
# which completes before the next command by construction -- and not through a
# process substitution, which bash does not wait for.
grep -qE '^compute exec "\$@" 2>"\$err"$' "$WRAPPER" \
  || fail "arm 8: the stderr capture is not the plain redirect — a process substitution here races the detection (1/300 measured)"
# The negative half must read CODE, not prose about code. The wrapper's header
# explains the racy form it replaced, and that explanation contains the pattern
# verbatim — so an unfiltered grep matched the comment and reddened this arm on a
# correct baseline (it did, on the first run). Strip comment lines first.
if sed 's/[[:space:]]*#.*$//' "$WRAPPER" | grep -q '2> *>('; then
  fail "arm 8: a process substitution captures stderr in CODE; bash does not wait for it, so the refusal grep can read an incomplete file"
fi

# and the relay must still exist, or arm 6's stderr assertion is the only thing
# standing between this and silently swallowing the command's stderr
grep -qE '^cat "\$err" >&2$' "$WRAPPER" \
  || fail "arm 8: stderr is captured but never relayed to the caller"

# --- arm 9: an UNENROLLED checkout, which is what the gate actually provides ------
# This is the arm that was missing, and its absence was not theoretical: the first
# version of the wrapper refused with 78 when `<primary>/.tap` was absent, so this
# file reded on every CI gate while passing locally in an already-enrolled tree.
# Deterministic, and invisible to every arm above because they all ran in this
# repository (review P1, confirmed by a local reproduction).
#
# Two reasons the precondition is gone rather than fixtured: a checkout with no
# `.tap` can be perfectly enrolled (lib.sh:261-280 takes an explicit TAP_HOME
# first, then the legacy `<root>/tmp/tap`), and `compute` owns that resolution
# anyway — an unresolved seat now arrives as a loud 70.
solo="$WORK/unenrolled"
mkdir -p "$solo"
git -C "$solo" init -q 2>/dev/null || fail "arm 9: could not init a scratch checkout"
git -C "$solo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init 2>/dev/null \
  || fail "arm 9: could not commit in the scratch checkout"
[ ! -e "$solo/.tap" ] || fail "arm 9: the scratch checkout must NOT be enrolled for this arm to mean anything"

stub 'echo "compute: Register with TAP before requesting compute" >&2; exit 0'
rc=0
( cd "$solo" && PATH="$BIN:$PATH" bash "$WRAPPER" --task t/x --timeout 1m -- true ) >/dev/null 2>"$WORK/solo.err" || rc=$?
[ "$rc" != 78 ] || fail "arm 9: refused with 78 in an unenrolled checkout — this is the CI failure, and the gate's tree is always unenrolled"
[ "$rc" = 70 ] || fail "arm 9: expected 70 in an unenrolled checkout, got $rc"
grep -q 'nothing ran' "$WORK/solo.err" || fail "arm 9: detected but did not report nothing-ran"

# and a real status still passes through from there, so arm 9 is not just "always fails"
stub 'exit 5'
rc=0
( cd "$solo" && PATH="$BIN:$PATH" bash "$WRAPPER" --task t/x --timeout 1m -- true ) >/dev/null 2>&1 || rc=$?
[ "$rc" = 5 ] || fail "arm 9 control: a genuine exit 5 from an unenrolled checkout must pass through, got $rc"

echo "compute-exec-wrapper: ok (refusal->70, pass-through, success, stdout, primary-cwd, heavy-stderr, anchored match, capture mechanism, unenrolled checkout)"
