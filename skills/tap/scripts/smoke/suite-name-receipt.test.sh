#!/usr/bin/env bash
# suite-name-receipt.test.sh — a REGRESS run can never emit a merge-gate receipt.
#
# tap-52ys / sol-ponytail P1. smoke-all.sh drives BOTH suites via TAP_SUITE_DIR,
# and the terminal green line is the string reviewers quote as gate evidence.
# Before this pin, a regress run executed only the optional files and still
# printed "smoke-all: ... ok — all N files passed" — a merge-gate green receipt
# for a suite that is explicitly not the merge gate.
#
# Bidirectional on purpose: it is not enough that regress says "regress-all".
# The gate must still say "smoke-all", or a future rename could satisfy half of
# this check by making both suites anonymous.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "suite-name-receipt: $1" >&2; exit 1; }

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
mkdir -p \
  "$FIXTURE/scripts" \
  "$FIXTURE/skills/tap/scripts/smoke" \
  "$FIXTURE/skills/tap/scripts/regress" \
  "$FIXTURE_HOME" \
  "$FIXTURE_LOCKS"
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"
cp "$ROOT/scripts/regress-all.sh" "$FIXTURE/scripts/regress-all.sh"
cp "$ROOT/scripts/suite-slot-run.py" "$FIXTURE/scripts/suite-slot-run.py"
cp "$ROOT/scripts/suite_slot.py" "$FIXTURE/scripts/suite_slot.py"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke-preflight.sh"
cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"

# One trivially-passing worker in EACH bucket, named so the logs are unambiguous.
for bucket in smoke regress; do
  cat >"$FIXTURE/skills/tap/scripts/$bucket/${bucket}-worker.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
echo "${bucket}-worker: ok"
WORKER
  chmod +x "$FIXTURE/skills/tap/scripts/$bucket/${bucket}-worker.test.sh"
done

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "tap@test"
git -C "$FIXTURE" config user.name "tap"
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -m main
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$(git -C "$FIXTURE" rev-parse HEAD)"

run_suite() { # <suite-dir> -> stdout+stderr of the run
  (
    cd "$FIXTURE"
    env -i \
      HOME="$FIXTURE_HOME" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
      TAP_PYTHON="$PY" \
      TAP_SUITE_SLOT="bypass" \
      TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
      TAP_SUITE_DIR="$1" \
      TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
      bash "$FIXTURE/scripts/smoke-all.sh" -j 1 2>&1
  )
}

gate_out="$(run_suite smoke)" || fail "gate fixture run failed: $gate_out"
regress_out="$(run_suite regress)" || fail "regress fixture run failed: $regress_out"

# (1) The gate still owns the canonical receipt.
grep -q '^smoke-all: .* — ok — all 1 files passed' <<<"$gate_out" \
  || fail "gate run did not emit the canonical 'smoke-all: ... ok — all N files passed' receipt: $gate_out"
grep -q 'ignored-state-roots: 1 checked, 0 new or changed' <<<"$gate_out" \
  || fail "gate receipt omitted the ignored-state success anchor: $gate_out"
grep -q 'smoke-worker' <<<"$gate_out" \
  || fail "gate run did not execute the smoke/ bucket"

# (2) The regress run names itself and executes the OTHER bucket.
grep -q '^regress-all: .* — ok — all 1 files passed' <<<"$regress_out" \
  || fail "regress run did not emit a 'regress-all:' receipt: $regress_out"
grep -q 'regress-worker' <<<"$regress_out" \
  || fail "regress run did not execute the regress/ bucket"

# (3) THE POINT: no regress line may carry the merge-gate success token. A
# reviewer greps for this string to certify a merge; a regress run must not be
# able to produce it, whatever else it prints.
if grep -q '^smoke-all: .* — ok — all' <<<"$regress_out"; then
  fail "REGRESS run emitted a merge-gate green receipt: $(grep '^smoke-all:' <<<"$regress_out")"
fi

# (4) An ignored checkout-state write is a post-wave red even though git calls
# the committed fixture clean. The runner names the path and parallel window;
# the test owns and removes only its probe marker afterward.
cat >"$FIXTURE/skills/tap/scripts/smoke/ignored-state-probe.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FIXTURE/.tap"
: > "$FIXTURE/.tap/probe-marker"
echo "ignored-state probe wrote its marker: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/ignored-state-probe.test.sh"
git -C "$FIXTURE" add skills/tap/scripts/smoke/ignored-state-probe.test.sh
git -C "$FIXTURE" commit -qm 'add ignored-state probe'
set +e
ignored_state_out="$({
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/ignored-state-probe.test.sh -j 1 2>&1
})"
ignored_state_rc=$?
set -e
rm -f "$FIXTURE/.tap/probe-marker"
rmdir "$FIXTURE/.tap" 2>/dev/null || true
[ "$ignored_state_rc" -ne 0 ] || fail "ignored checkout-state write produced a green run: $ignored_state_out"
grep -q "ignored-state mutation: root=$FIXTURE path=.tap/probe-marker change=new window=parallel:skills/tap/scripts/smoke/ignored-state-probe.test.sh" <<<"$ignored_state_out" \
  || fail "ignored-state red omitted path/window attribution: $ignored_state_out"
grep -q 'ignored-state-roots: 1 checked, 1 new or changed, 0 observation failure(s)' <<<"$ignored_state_out" \
  || fail "ignored-state red omitted the receipt summary: $ignored_state_out"
grep -q '^smoke-one: .* — ok — all' <<<"$ignored_state_out" \
  && fail "ignored-state mutation emitted a green receipt: $ignored_state_out"

# The shared comparator also reds an mtime-only mutation of a pre-existing path.
mkdir -p "$FIXTURE/.tap"
: >"$FIXTURE/.tap/probe-marker"
"$PY" -B "$FIXTURE/scripts/ignored-state-tripwire.py" snapshot \
  "$FIXTURE" "$WORK/ignored-before.json"
"$PY" -B - "$FIXTURE/.tap/probe-marker" <<'PY'
import os, sys
path = sys.argv[1]
stamp = os.lstat(path).st_mtime_ns + 1_000_000_000
os.utime(path, ns=(stamp, stamp), follow_symlinks=False)
PY
set +e
mtime_out="$("$PY" -B "$FIXTURE/scripts/ignored-state-tripwire.py" compare \
  "$WORK/ignored-before.json" "$FIXTURE" direct-probe 2>&1)"
mtime_rc=$?
set -e
rm -f "$FIXTURE/.tap/probe-marker"
rmdir "$FIXTURE/.tap" 2>/dev/null || true
[ "$mtime_rc" -ne 0 ] || fail "mtime-only ignored-state mutation passed: $mtime_out"
grep -q 'path=.tap/probe-marker change=mtime-changed window=direct-probe' <<<"$mtime_out" \
  || fail "mtime-only mutation was not attributed: $mtime_out"

# An already-live bus is external concurrent state, while an unrelated escape
# in the same checkout remains attributable and must still red.
mkdir -p "$FIXTURE/.tap/bus/payloads"
: >"$FIXTURE/.tap/team-registry.json"
"$PY" -B "$FIXTURE/scripts/ignored-state-tripwire.py" snapshot \
  "$FIXTURE" "$WORK/live-before.json"
: >"$FIXTURE/.tap/bus/payloads/external-message"
: >"$FIXTURE/.tap/team-registry.json"
: >"$FIXTURE/.tap/probe-marker"
set +e
live_out="$("$PY" -B "$FIXTURE/scripts/ignored-state-tripwire.py" compare \
  "$WORK/live-before.json" "$FIXTURE" live-bus-probe 2>&1)"
live_rc=$?
set -e
rm -rf "$FIXTURE/.tap"
[ "$live_rc" -ne 0 ] || fail "unrelated mutation beside a live bus passed: $live_out"
grep -q 'path=.tap/probe-marker change=new window=live-bus-probe' <<<"$live_out" \
  || fail "live-bus comparison omitted the attributable probe: $live_out"
if grep -Eq 'path=.tap/(bus|team-registry\.json)' <<<"$live_out"; then
  fail "live-bus comparison blamed external TAP traffic: $live_out"
fi
echo "suite-name-receipt: (4) ignored checkout-state new-path and mtime tripwires red: ok"
echo "suite-name-receipt: (1) gate emits 'smoke-all' green; regress emits 'regress-all' and never the gate token: ok"

# (4) An unknown bucket is a usage error, not a silent fallback to the gate set.
REFUSAL_TMP="$WORK/refusal-tmp"
mkdir -p "$REFUSAL_TMP"
set +e
bad_out="$(cd "$FIXTURE" && TMPDIR="$REFUSAL_TMP" TAP_RUNNER_ALLOW=1 TAP_SUITE_DIR=nonsense bash "$FIXTURE/scripts/smoke-all.sh" -j 1 2>&1)"
bad_rc=$?
set -e
[ "$bad_rc" -eq 64 ] || fail "unknown TAP_SUITE_DIR should exit 64, got $bad_rc"
grep -qi "must be 'smoke' or 'regress'" <<<"$bad_out" \
  || fail "unknown TAP_SUITE_DIR refusal did not name the valid buckets: $bad_out"
find "$REFUSAL_TMP" -mindepth 1 -maxdepth 1 -print -quit | grep -q . \
  && fail "unknown-suite refusal leaked its suite sandbox: $(find "$REFUSAL_TMP" -mindepth 1 -maxdepth 1 -print)"
echo "suite-name-receipt: (2) an unknown TAP_SUITE_DIR refuses (64) instead of falling back to the gate set: ok"

# (5) Single-file debugging uses the same environment boundary without minting
# a full-gate receipt or executing a sibling.
cat >"$FIXTURE/skills/tap/scripts/smoke/not-selected.test.sh" <<'WORKER'
#!/usr/bin/env bash
echo "not-selected ran" >&2
exit 42
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/not-selected.test.sh"
set +e
only_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/smoke-worker.test.sh -j 1 2>&1
)"
only_rc=$?
set -e
[ "$only_rc" -eq 0 ] || fail "--only run failed (rc=$only_rc): $only_out"
grep -q '^smoke-one: .* — ok — all 1 files passed' <<<"$only_out" \
  || fail "--only omitted its non-gate receipt: $only_out"
grep -q 'not-selected ran' <<<"$only_out" \
  && fail "--only executed an unselected sibling: $only_out"
grep -q '^smoke-all: .* — ok — all' <<<"$only_out" \
  && fail "--only emitted a merge-gate receipt: $only_out"
echo "suite-name-receipt: (3) --only runs one isolated smoke and cannot mint gate evidence: ok"

# (3d) tap-un76v: a selection that names no file refuses with 64 and names the
# selection, through both runners and both spellings. Drivers quote --only
# results as merge evidence, so a missing file must never read as a pass. The
# specimen that filed this bead printed the refusal yet reported 0 -- the exit
# status of a `| tail` behind the runner, not the runner's own. The rc here is
# the runner's, captured without a pipe.
for missing_runner in smoke-all regress-all; do
  for missing_sel in no-such-selection.test.sh skills/tap/scripts/smoke/no-such-selection.test.sh; do
    set +e
    missing_out="$(
      cd "$FIXTURE" &&
      env -i \
        HOME="$FIXTURE_HOME" \
        PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
        TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
        bash "$FIXTURE/scripts/$missing_runner.sh" --only "$missing_sel" -j 1 2>&1
    )"
    missing_rc=$?
    set -e
    [ "$missing_rc" -eq 64 ] \
      || fail "(3d) $missing_runner --only $missing_sel should exit 64, got $missing_rc: $missing_out"
    grep -qF "selected file not found: $missing_sel" <<<"$missing_out" \
      || fail "(3d) $missing_runner refusal did not name $missing_sel: $missing_out"
    grep -q ' — ok — all' <<<"$missing_out" \
      && fail "(3d) $missing_runner emitted a green receipt for a missing selection: $missing_out"
  done
done
echo "suite-name-receipt: (3d) a missing --only selection refuses 64 by name through smoke-all and regress-all: ok"

# (3c) tap-h37qp: a --only run takes NO machine-wide slot. Placed HERE, while the
# fixture holds only real, runnable workers -- the arms below deliberately plant
# escape-test sources, and smoke_escape_lint scans the whole tree before any
# wave regardless of --only, so a canary running after them refuses on the
# fixture's own contents rather than on anything this PR changed.
#
# The vehicle matters as much as the assertions. An earlier version ran before
# its worker existed: the runner exited 64 ("--only file not found"), `|| true`
# swallowed it, and the lease assertions were then satisfied by a run that never
# reached the slot. So rc 0 is asserted FIRST, and the run must show it executed
# the target -- only then do the lease assertions mean anything.
ONLY_LOCKS="$WORK/only-locks"; mkdir -p "$ONLY_LOCKS"
cat >"$FIXTURE/skills/tap/scripts/smoke/slot-canary.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "slot-canary: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/slot-canary.test.sh"
canary_rc=0
(
  cd "$FIXTURE"
  env -i HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_LOCK_HOME="$ONLY_LOCKS" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/slot-canary.test.sh -j 1 >"$WORK/slot-canary.out" 2>&1
) || canary_rc=$?
[ "$canary_rc" -eq 0 ] \
  || fail "(3c) the canary run did not succeed (rc=$canary_rc) -- the lease assertions would pass vacuously: $(cat "$WORK/slot-canary.out")"
# Passing worker logs are deleted before the aggregate is written, so the
# worker's own line is not in the output. The RECEIPT is the execution proof:
# "all 1 files passed" cannot be emitted by a run that found no file.
grep -Eq '^smoke-one: .* — ok — all 1 files passed' "$WORK/slot-canary.out" \
  || fail "(3c) the canary run did not execute its target file: $(cat "$WORK/slot-canary.out")"
[ ! -e "$ONLY_LOCKS/smoke-all.lease.json" ] \
  || fail "(3c) a --only run wrote a lease into the canary lock home"
grep -q 'suite-slot: advisory' "$WORK/slot-canary.out" \
  && fail "(3c) a --only run touched the machine-wide slot: $(grep -h 'suite-slot' "$WORK/slot-canary.out")"
rm -f "$FIXTURE/skills/tap/scripts/smoke/slot-canary.test.sh"
echo "suite-name-receipt: (3c) a --only run executes its target, writes no lease, and takes no slot: ok"

# Lint is repo-wide even when execution is bucket- or --only-scoped. Materialize
# the unsafe source at runtime so only the disposable fixture contains it.
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'export %s=%s\n' 'TMUX_TMPDIR' '/tmp/operator'
  printf '%s\n' 'tmux list-sessions'
} >"$FIXTURE/skills/tap/scripts/regress/unsafe-regress.test.sh"
chmod +x "$FIXTURE/skills/tap/scripts/regress/unsafe-regress.test.sh"
set +e
cross_bucket_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/smoke-worker.test.sh -j 1 2>&1
)"
cross_bucket_rc=$?
set -e
rm "$FIXTURE/skills/tap/scripts/regress/unsafe-regress.test.sh"
[ "$cross_bucket_rc" -ne 0 ] \
  || fail "unsafe regress source escaped smoke-bucket lint: $cross_bucket_out"
grep -q 'unsafe-regress.test.sh:.*:tmux-root-reset' <<<"$cross_bucket_out" \
  || fail "cross-bucket lint omitted the regress finding: $cross_bucket_out"
grep -q 'smoke-worker: ok' <<<"$cross_bucket_out" \
  && fail "worker started before cross-bucket lint refusal: $cross_bucket_out"
echo "suite-name-receipt: (3b) smoke execution lints both smoke and regress source buckets: ok"

# (6) A caller may swallow tmux's 97 or capture stderr. The file marker is the
# independent evidence channel, so the runner must still red the selected file
# and carry the guard's facts (rejected socket, root, limit, argv) into that
# file's FAIL block. The escaping call's argv holds a tab, a newline, a space and
# a forged record naming a DIFFERENT file; the marker must keep each field
# unambiguous and never charge the clean file for a record it did not write.
cat >"$FIXTURE/skills/tap/scripts/smoke/escape-swallowed.test.sh" <<'WORKER'
#!/usr/bin/env bash
outside="$HOME/../outside.sock"
forged=$'x\nTMUX-ESCAPE\tskills/tap/scripts/smoke/escape-decoy.test.sh\tforged'
tmux -S "$outside" list-sessions $'tab\targ' "two words" "$forged" >/dev/null 2>&1 || true
echo "escape was swallowed by the caller: ok"
WORKER
cat >"$FIXTURE/skills/tap/scripts/smoke/escape-decoy.test.sh" <<'WORKER'
#!/usr/bin/env bash
echo "escape-decoy: clean: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/escape-swallowed.test.sh" \
  "$FIXTURE/skills/tap/scripts/smoke/escape-decoy.test.sh"
printf '%s\n' \
  skills/tap/scripts/smoke/escape-swallowed.test.sh \
  skills/tap/scripts/smoke/escape-decoy.test.sh >"$WORK/escape.list"
set +e
escape_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_RUNNER_ALLOW=1 \
    bash "$FIXTURE/scripts/smoke-all.sh" --list "$WORK/escape.list" -j 1 2>&1
)"
escape_rc=$?
set -e
[ "$escape_rc" -ne 0 ] || fail "swallowed tmux escape produced a green run: $escape_out"
grep -q 'FAIL .*escape-swallowed.test.sh.*tmux-escape' <<<"$escape_out" \
  || fail "runtime marker did not classify the swallowed escape: $escape_out"
grep -q '^smoke-one: .* — ok — all' <<<"$escape_out" \
  && fail "swallowed escape emitted a green single-file receipt: $escape_out"
grep -q 'FAIL .*escape-decoy.test.sh' <<<"$escape_out" \
  && fail "a forged argv record charged the clean file: $escape_out"
escape_block="$(awk '
  /^=== SMOKE-FAIL-BEGIN .*path=.*escape-swallowed\.test\.sh ===$/ { inside = 1 }
  inside { print }
  /^=== SMOKE-FAIL-END .*path=.*escape-swallowed\.test\.sh ===$/ { inside = 0 }
' <<<"$escape_out")"
[ -n "$escape_block" ] || fail "the swallowed escape has no FAIL block: $escape_out"
facts="$(grep 'tmux guard record:' <<<"$escape_block" || true)"
[ "$(grep -c . <<<"$facts")" -eq 1 ] \
  || fail "the FAIL block must carry exactly one guard record for the one rejected call: $escape_block"
grep -q 'rejected effective socket .*outside\.sock' <<<"$facts" \
  || fail "guard record omits the rejected socket: $facts"
grep -q '(root=.* limit=[0-9][0-9]*)' <<<"$facts" \
  || fail "guard record omits the sandbox root or socket limit: $facts"
grep -qF 'list-sessions tab\targ two\x20words x\nTMUX-ESCAPE\tskills/tap/scripts/smoke/escape-decoy.test.sh\tforged' <<<"$facts" \
  || fail "guard record argv is ambiguous or lost: $facts"
[ "$(grep -c 'tmux guard record:' <<<"$escape_out")" -eq 1 ] \
  || fail "a guard record leaked outside the escaping file's FAIL block: $escape_out"
echo "suite-name-receipt: (4) swallowed tmux escape still reds by marker, with its guard facts and no misattribution: ok"

# (4b) The marker lookup must refuse rather than pass when it cannot read the
# marker: a helper error is not "no escape recorded".
cat >"$FIXTURE/skills/tap/scripts/smoke/escape-unreadable.test.sh" <<'WORKER'
#!/usr/bin/env bash
tmux -S "$HOME/../outside.sock" list-sessions >/dev/null 2>&1 || true
chmod 000 "$SMOKE_TMUX_ESCAPE_MARKER"
echo "escape then unreadable marker: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/escape-unreadable.test.sh"
set +e
unreadable_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/escape-unreadable.test.sh -j 1 2>&1
)"
unreadable_rc=$?
set -e
[ "$unreadable_rc" -ne 0 ] || fail "an unreadable escape marker produced a green run: $unreadable_out"
grep -q 'FAIL .*escape-unreadable.test.sh.*tmux-escape' <<<"$unreadable_out" \
  || fail "an unreadable escape marker did not red the file as tmux-escape: $unreadable_out"
echo "suite-name-receipt: (4b) an unreadable escape marker reds the file instead of passing it: ok"

# (7) A worker that reconstructs the original HOME and writes wave-attributable
# state must fail after the wave even though the worker itself exits zero.
rm -rf "$FIXTURE_HOME/.tap"
cat >"$FIXTURE/skills/tap/scripts/smoke/operator-state-escape.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
operator_tap="$FIXTURE_HOME/.tap"
mkdir -p "\$operator_tap"
cat >"\$operator_tap/global-registry.json" <<EOF
{"schema":"0.20","teams":{"escaped":{"root":"\$TAP_SUITE_SANDBOX/team","registry_location":"\$TAP_SUITE_SANDBOX/team/.tap/team-registry.json"}}}
EOF
printf '%s\n' 'KNOWN-DEFECT	tap-xk0yr	2026-08-24	drain crossing reverted silently'
echo 'SMOKE-SKIP: post-wave accounting fixture fired'
echo "operator state escape returned zero: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/operator-state-escape.test.sh"
set +e
operator_state_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/operator-state-escape.test.sh -j 1 2>&1
)"
operator_state_rc=$?
set -e
rm -rf "$FIXTURE_HOME/.tap"
[ "$operator_state_rc" -ne 0 ] || fail "operator TAP-home escape produced a green run: $operator_state_out"
grep -q 'global-registry wave-root' <<<"$operator_state_out" \
  || fail "operator-state failure omitted wave-root attribution: $operator_state_out"
grep -Eq '^smoke-one: .*; known-defect: 1 \(tap-xk0yr; observed across all files, not failure attribution\); declared-skips=1 skip-files=1 — 0/1 FAILED, 1 passed; post-wave failures=1 ' <<<"$operator_state_out" \
  || fail "operator-state red receipt corrupted file counts: $operator_state_out"
grep -Eq '^smoke-one: .*; failing: post-wave:operator-state; known-defect: ' <<<"$operator_state_out" \
  || fail "operator-state red receipt did not name its post-wave class (tap-kg3fb): $operator_state_out"
grep -q '^smoke-one: .* — ok — all' <<<"$operator_state_out" \
  && fail "operator-state escape emitted a green single-file receipt: $operator_state_out"
echo "suite-name-receipt: (5) post-wave operator TAP-home predicate blocks an attributable write: ok"

# Removing a protected operator-state file is itself attributable even though
# there are no after-bytes left to inspect.
mkdir -p "$FIXTURE_HOME/.tap"
printf '%s\n' '{"schema":"0.20","teams":{}}' >"$FIXTURE_HOME/.tap/global-registry.json"
cat >"$FIXTURE/skills/tap/scripts/smoke/operator-state-delete.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
rm "$FIXTURE_HOME/.tap/global-registry.json"
echo "operator state delete returned zero: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/operator-state-delete.test.sh"
set +e
operator_delete_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/operator-state-delete.test.sh -j 1 2>&1
)"
operator_delete_rc=$?
set -e
rm -rf "$FIXTURE_HOME/.tap"
[ "$operator_delete_rc" -ne 0 ] || fail "operator TAP-home deletion produced a green run: $operator_delete_out"
grep -q 'protected operator state deleted: global-registry.json' <<<"$operator_delete_out" \
  || fail "operator-state deletion omitted attribution: $operator_delete_out"
grep -Eq '^smoke-one: .* — 0/1 FAILED, 1 passed; post-wave failures=1 ' <<<"$operator_delete_out" \
  || fail "operator-state deletion corrupted file counts: $operator_delete_out"
grep -q '^smoke-one: .* — ok — all' <<<"$operator_delete_out" \
  && fail "operator-state deletion emitted a green single-file receipt: $operator_delete_out"
echo "suite-name-receipt: (6) post-wave operator TAP-home predicate blocks protected deletion: ok"

# The snapshot covers every operator-state file, so deletion attribution must
# not depend on a protected-filename list. Keep one named incident exemplar and
# one runtime-only name that production cannot learn from this source.
mkdir -p "$FIXTURE_HOME/.tap"
opaque_state="opaque-$RANDOM-$RANDOM.json"
printf '%s\n' '{"pending":[]}' >"$FIXTURE_HOME/.tap/escalation.json"
printf '%s\n' '{"opaque":true}' >"$FIXTURE_HOME/.tap/$opaque_state"
cat >"$FIXTURE/skills/tap/scripts/smoke/operator-state-arbitrary-delete.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
rm "$FIXTURE_HOME/.tap/escalation.json" "$FIXTURE_HOME/.tap/$opaque_state"
echo "arbitrary operator state delete returned zero: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/operator-state-arbitrary-delete.test.sh"
set +e
arbitrary_delete_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/operator-state-arbitrary-delete.test.sh -j 1 2>&1
)"
arbitrary_delete_rc=$?
set -e
rm -rf "$FIXTURE_HOME/.tap"
[ "$arbitrary_delete_rc" -ne 0 ] \
  || fail "arbitrary operator TAP-home deletion produced a green run: $arbitrary_delete_out"
grep -q 'protected operator state deleted: escalation.json' <<<"$arbitrary_delete_out" \
  || fail "named arbitrary deletion omitted attribution: $arbitrary_delete_out"
grep -q "protected operator state deleted: $opaque_state" <<<"$arbitrary_delete_out" \
  || fail "runtime-named arbitrary deletion omitted attribution: $arbitrary_delete_out"
grep -Eq '^smoke-one: .* — 0/1 FAILED, 1 passed; post-wave failures=1 ' <<<"$arbitrary_delete_out" \
  || fail "arbitrary operator-state deletion corrupted file counts: $arbitrary_delete_out"
echo "suite-name-receipt: (7) post-wave predicate attributes every operator-state deletion: ok"

# Fixture registrations use their own handles, panes, and worktree roots. The
# runner must discover those identities from suite-owned registries before it
# judges a copy that escaped into the operator registry.
fixture_identity_root="$WORK/fixture-identity-root"
mkdir -p "$fixture_identity_root"
cat >"$FIXTURE/skills/tap/scripts/smoke/operator-fixture-registration.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
fixture_registry="\$TAP_SUITE_SANDBOX/fixture/.tap/team-registry.json"
operator_registry="$FIXTURE_HOME/.tap/fixture-team-registry.json"
mkdir -p "\$(dirname "\$fixture_registry")" "\$(dirname "\$operator_registry")"
cat >"\$fixture_registry" <<EOF
{"schema":"0.20","seats":{"alice":{"pane":"fixture:0.0","pane_id":"%4242","registered_from_worktree":"$fixture_identity_root"}}}
EOF
cp "\$fixture_registry" "\$operator_registry"
echo "fixture registration escaped to operator registry: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/operator-fixture-registration.test.sh"
set +e
fixture_identity_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/operator-fixture-registration.test.sh -j 1 2>&1
)"
fixture_identity_rc=$?
set -e
rm -rf "$FIXTURE_HOME/.tap"
[ "$fixture_identity_rc" -ne 0 ] \
  || fail "fixture registration in operator registry produced a green run: $fixture_identity_out"
grep -q 'team-registry wave handle: alice ' <<<"$fixture_identity_out" \
  || fail "fixture handle attribution missing: $fixture_identity_out"
grep -q 'team-registry wave pane: %4242 ' <<<"$fixture_identity_out" \
  || fail "fixture pane attribution missing: $fixture_identity_out"
grep -q "team-registry wave-root: $fixture_identity_root " <<<"$fixture_identity_out" \
  || fail "fixture root attribution missing: $fixture_identity_out"
grep -Eq '^smoke-one: .* — 0/1 FAILED, 1 passed; post-wave failures=1 ' <<<"$fixture_identity_out" \
  || fail "fixture-identity red receipt corrupted file counts: $fixture_identity_out"
echo "suite-name-receipt: (8) post-wave predicate attributes fixture handle, pane, and root: ok"

# Reconstructing a clean PATH can bypass the guard. The guarded private call
# records its session name before cleanup, so the same operator-session birth
# remains attributable after the wave.
FIXED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TMUX_BIN="$(PATH="$FIXED_PATH" command -v tmux)"
OPERATOR_SOCKET="$WORK/operator-tmux.sock"
"$TMUX_BIN" -S "$OPERATOR_SOCKET" new-session -d -s operator-preserve
cat >"$FIXTURE/skills/tap/scripts/smoke/operator-tmux-escape.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
socket="$OPERATOR_SOCKET"
tmux new-session -ds wave-attributed
tmux kill-session -t wave-attributed
env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR \
  PATH="$FIXED_PATH" \
  tmux -S "\$socket" new-session -d -s wave-attributed
echo "operator tmux escape returned zero: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/operator-tmux-escape.test.sh"
set +e
operator_tmux_out="$(
  cd "$FIXTURE" &&
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="$FIXED_PATH" \
    TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
    TMUX="$OPERATOR_SOCKET,1,0" \
    TAP_PYTHON="$PY" TAP_SUITE_SLOT="bypass" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    bash "$FIXTURE/scripts/smoke-all.sh" --only \
      skills/tap/scripts/smoke/operator-tmux-escape.test.sh -j 1 2>&1
)"
operator_tmux_rc=$?
set -e
"$TMUX_BIN" -S "$OPERATOR_SOCKET" kill-server 2>/dev/null || true
[ "$operator_tmux_rc" -ne 0 ] || fail "operator tmux escape produced a green run: $operator_tmux_out"
grep -q 'tmux fixture session appeared: wave-attributed' <<<"$operator_tmux_out" \
  || fail "tmux-state failure omitted the attributed session birth: $operator_tmux_out"
grep -Eq '^smoke-one: .* — 0/1 FAILED, 1 passed; post-wave failures=1 ' <<<"$operator_tmux_out" \
  || fail "operator-tmux red receipt corrupted file counts: $operator_tmux_out"
grep -q '^smoke-one: .* — ok — all' <<<"$operator_tmux_out" \
  && fail "operator tmux escape emitted a green single-file receipt: $operator_tmux_out"
echo "suite-name-receipt: (9) post-wave tmux predicate blocks an attributed operator-session birth: ok"

# (10b/10c) tap-h37qp. These arms drive the REAL predicate and the REAL runner.
#
# They exist because the first version of the straddle arms reimplemented the
# production logic inside the test file and asserted against the copy: deleting
# the production seam left the focused test exit 0, and the mutation "proof"
# had mutated the reimplementation. A test that reimplements the predicate
# proves the reimplementation works. So: source smoke-all.sh and call
# smoke_operator_state_predicate itself, and drive the runner for the slot arm.
#
# smoke-all.sh guards its entry (`[ "${BASH_SOURCE[0]}" = "$0" ]`), so sourcing
# defines the functions without running a suite.
peer_predicate() { # <peer-owned-contents> <deleted-relpath> -> predicate rc
  local peer="$1" deleted="$2" probe="$WORK/peer-probe"
  rm -rf "$probe"; mkdir -p "$probe/oproot" "$probe/runroot"
  "$PY" - "$probe/before.json" "$deleted" <<'PYSNAP'
import json, sys
out, deleted = sys.argv[1], sys.argv[2]
json.dump({deleted: "aaa", "keep": "bbb"}, open(out, "w"))
PYSNAP
  "$PY" - "$probe/after.json" <<'PYSNAP'
import json, sys
json.dump({"keep": "bbb"}, open(sys.argv[1], "w"))
PYSNAP
  : >"$probe/empty"
  printf '%s' "$peer" >"$probe/peer"
  (
    set +e
    . "$ROOT/scripts/smoke-all.sh" >/dev/null 2>&1
    smoke_operator_state_predicate \
      "$probe/before.json" "$probe/after.json" "$probe/oproot" "$probe/runroot" \
      "$probe/empty" "$probe/empty" "$probe/empty" "$probe/empty" "$probe/empty" \
      "$probe/peer" >/dev/null 2>&1
    echo "$?"
  )
}
# P1 — the behaviour this change exists to create: a peer's lease release is no longer
# attributed. This is the exact red the earlier versions carried, pinned green.
[ "$(peer_predicate 'locks/smoke-all.lease.json' 'locks/smoke-all.lease.json')" = "0" ] \
  || fail "(10c/P1) a peer's lease release is still attributed to this run"
# P2 — the narrowing direction. Without this, widening the list to `locks/` or
# forcing the match true would silence EVERY deletion violation and no arm reds.
[ "$(peer_predicate 'locks/smoke-all.lease.json' 'locks/smoke-all.lock')" = "1" ] \
  || fail "(10c/P2) the exemption is too wide: a self-owned deletion stopped redding"
# P2b — the control that proves P1 is not vacuous: same deletion, no exemption.
[ "$(peer_predicate '' 'locks/smoke-all.lease.json')" = "1" ] \
  || fail "(10c/P2b) the deletion arm no longer fires without the exemption"
# P2c — the BLINDING direction. A suffix match exempted any path ending in the
# canonical name, so a real deletion under a nested directory walked past the
# guard while the receipt stayed green. A peer can only own the canonical path;
# anything nested is this run's own doing and must still be attributed.
[ "$(peer_predicate 'locks/smoke-all.lease.json' 'archive/locks/smoke-all.lease.json')" = "1" ] \
  || fail "(10c/P2c) a NESTED lease-named deletion was exempted -- the match is a suffix, not exact"
echo "suite-name-receipt: (10c) peer-owned lease exempted; other deletions and the no-exemption control still red: ok"

# (10d) THE OTHER HALF OF THE SEAM, and the reason it needs its own arm.
#
# (10c) proves the predicate CONSUMES a peer-owned list correctly -- because it
# hands one in. It does not prove the runner POPULATES that list. Deleting the
# producing line in smoke-all.sh left (10c) green: the arm drove real production
# code and still missed the seam, because it supplied the very input the seam
# exists to build. That is the reimplementation trap in a subtler shape, and it
# is why "drives production code" is necessary but not sufficient.
#
# Asserted on the runner's own source rather than through a test-only env seam:
# adding a variable to the hermetic-entry allowlist so a control can observe an
# internal file would widen the production surface for the test's convenience,
# and the entry allowlist is a security boundary this suite exists to protect.
# WHAT THIS NARROWS: a source assertion proves the producing line is present and
# names the lease, not that it executed. (10c) covers the consuming half; the
# live pair receipts cover the end-to-end. Stated so nobody reads (10d) as
# runtime evidence.
peer_producer_src="$(grep -c 'locks/smoke-all.lease.json" >>"\$SMOKE_PEER_OWNED_PATHS"' "$FIXTURE/scripts/smoke-all.sh" || true)"
[ "$peer_producer_src" = "1" ] \
  || fail "(10d) the runner no longer populates the peer-owned list with the lease path (found $peer_producer_src producing lines)"
echo "suite-name-receipt: (10d) the runner's own source populates the peer-owned list: ok"



# (10) Two worktree-shaped invocations may overlap and own distinct HOME/tmux
# roots, tearing their sockets down cleanly.
#
# tap-h37qp: this arm ALSO asserted that one run keeps the advisory lease and
# the other downshifts. That assertion is deleted, not relocated, because the
# `--only` runs it used as its vehicle no longer take the machine-wide lease --
# so there is no lease for a second run to downshift from, and the assertion
# tests a contract this change deliberately ended.
#
# The ROOT-ISOLATION and socket-teardown assertions below are untouched by that
# change and stay: they never depended on contention, only on the two runs
# overlapping, which is now easier to arrange rather than harder. Deleting them
# too would have discarded coverage this change did not break.
#
# WHAT IS NOW UNCOVERED: the downshift contract for FULL suites -- one holds,
# one continues at reduced concurrency -- has no arm. tap-h37qp carries the
# replacement (a dedicated single-worker fixture so a full-suite pair can
# overlap without executing this fixture's accumulated files). Stated here, not
# only in the PR body, because a reader of this arm should not infer the
# downshift is still pinned somewhere.
cat >"$FIXTURE/skills/tap/scripts/smoke/overlap-worker.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
tmux new-session -d -s same-name-in-both-suites
socket="\$(tmux display-message -p '#{socket_path}')"
printf '%s\n%s\n' "\$TAP_SUITE_SANDBOX" "\$socket" >"$FIXTURE_HOME/root.\$TAP_SUITE_SEAT"
sleep 2
echo "overlap-worker: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/overlap-worker.test.sh"

run_overlap() {
  local seat="$1" output="$2"
  (
    cd "$FIXTURE"
    env -i \
      HOME="$FIXTURE_HOME" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
      TAP_PYTHON="$PY" TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" TAP_SUITE_SEAT="$seat" \
      bash "$FIXTURE/scripts/smoke-all.sh" --only \
        skills/tap/scripts/smoke/overlap-worker.test.sh -j 1 >"$output" 2>&1
  )
}
run_overlap first "$WORK/overlap-first.out" & first_pid=$!
run_overlap second "$WORK/overlap-second.out" & second_pid=$!
first_rc=0; wait "$first_pid" || first_rc=$?
second_rc=0; wait "$second_pid" || second_rc=$?
[ "$first_rc" -eq 0 ] || fail "first overlap run failed: $(cat "$WORK/overlap-first.out")"
[ "$second_rc" -eq 0 ] || fail "second overlap run failed: $(cat "$WORK/overlap-second.out")"
first_root="$(sed -n '1p' "$FIXTURE_HOME/root.first")"
second_root="$(sed -n '1p' "$FIXTURE_HOME/root.second")"
[ -n "$first_root" ] && [ -n "$second_root" ] && [ "$first_root" != "$second_root" ] \
  || fail "overlapping runs did not own distinct roots: '$first_root' '$second_root'"
while IFS= read -r socket; do
  [ ! -S "$socket" ] || fail "overlap teardown left socket alive: $socket"
done < <(sed -n '2p' "$FIXTURE_HOME/root.first"; sed -n '2p' "$FIXTURE_HOME/root.second")
echo "suite-name-receipt: (10) overlapping single-file runs stay isolated and green: ok"

echo "suite-name-receipt: ok"
