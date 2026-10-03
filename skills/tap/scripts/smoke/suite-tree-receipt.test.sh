#!/usr/bin/env bash
# suite-tree-receipt.test.sh — the merge-gate receipt identifies the checkout
# it exercised and makes checkout identity inseparable from terminal results.
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
trap 'rm -rf "$WORK"' EXIT
fail() { echo "suite-tree-receipt: $1" >&2; exit 1; }

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
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

cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "receipt-worker: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh"
printf 'base\n' >"$FIXTURE/shared.txt"

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "tap@test"
git -C "$FIXTURE" config user.name "tap"
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -m main
base="$(git -C "$FIXTURE" rev-parse HEAD)"

git -C "$FIXTURE" checkout -qb feature
printf 'feature\n' >"$FIXTURE/shared.txt"
git -C "$FIXTURE" add shared.txt
git -C "$FIXTURE" commit -qm feature
feature_head="$(git -C "$FIXTURE" rev-parse HEAD)"
feature_tree="$(git -C "$FIXTURE" rev-parse 'HEAD^{tree}')"

git -C "$FIXTURE" checkout -q main
printf 'main\n' >"$FIXTURE/shared.txt"
git -C "$FIXTURE" add shared.txt
git -C "$FIXTURE" commit -qm main-drift
main_head="$(git -C "$FIXTURE" rev-parse HEAD)"
main_tree="$(git -C "$FIXTURE" rev-parse 'HEAD^{tree}')"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$main_head"
git -C "$FIXTURE" checkout -q feature

[ "$(git -C "$FIXTURE" merge-base HEAD refs/remotes/origin/main)" = "$base" ] \
  || fail "fixture merge base is not the committed base"
[ "$(git -C "$FIXTURE" rev-list --count HEAD..refs/remotes/origin/main)" = 1 ] \
  || fail "fixture is not exactly one local-origin/main commit behind"
[ -z "$(git -C "$FIXTURE" status --porcelain --untracked-files=all)" ] \
  || fail "fixture must be clean before the gate run"

run_suite_command() {
  (
    cd "$FIXTURE"
    env -i \
      HOME="$FIXTURE_HOME" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM="dumb" \
      LANG="C" \
      LC_CTYPE="en_US.UTF-8" \
      TZ="UTC" \
      TAP_PYTHON="$PY" \
      TAP_SUITE_SLOT="bypass" \
      TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
      TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
      bash "$FIXTURE/scripts/smoke-all.sh" -j 1
  )
}

run_suite() {
  run_suite_command 2>&1
}

assert_one_summary() {
  local out="$1" summary_count
  summary_count="$(printf '%s\n' "$out" | awk '/^smoke-all: .* — ok — all /{count++} END{print count+0}')"
  [ "$summary_count" = 1 ] \
    || fail "expected exactly one quotable success receipt, found $summary_count: $out"
}

summary_from() {
  printf '%s\n' "$1" | awk '/^smoke-all: .* — ok — all /{print}'
}

assert_identity_precedes_ok() {
  local summary="$1"
  case "$summary" in
    "smoke-all: tested-tree="*" head="*" worktree="*"; declared-skips=0 skip-files=0 — ok — all "*) ;;
    *) fail "checkout identity did not precede the success token: $summary" ;;
  esac
}

# tap-1f45b bidirectional half: a run that did NOT straddle must not acquire the
# token. Without this, a comparison that fired unconditionally would still pass
# (red-3) and redden every honest run on the box.
#
# THIS IS red-3's NEGATIVE ARM, and the pair is the unit — do not delete one and
# keep the other. A positive arm passes in BOTH worlds (guard present, guard
# firing always); only an arm pinning the OTHER value can tell them apart. The
# same shape has bitten this runner's census fields three times: the
# typecheck marker, where a provisioned checkout must assert declared-skips=0
# and actually run the check, because a marker emitted unconditionally satisfies
# the positive arm and leaves a silent hole; the accounting mutants, where a
# fixture asserting `known-defect: 0` would have survived a composer that
# hardcoded zeros; and this one.
assert_not_straddled() {
  case "$1" in
    *STRADDLED*) fail "an unstraddled run reported STRADDLED: $1" ;;
  esac
}

run_summary() {
  local label="$1" out summary
  out="$(run_suite)" || fail "$label fixture suite failed: $out"
  assert_one_summary "$out"
  summary="$(summary_from "$out")"
  assert_identity_precedes_ok "$summary"
  assert_not_straddled "$out"
  printf '%s' "$summary"
}

# A worker failure is a completed suite result. Its stdout and stderr receipts
# must be the same captured fact, while stdout still carries the worker log.
git -C "$FIXTURE" checkout -qb worker-failure feature
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
touch "$TAP_SUITE_LOCK_HOME/worker-started"
deadline=$((SECONDS + 300))
while [ ! -e "$TAP_SUITE_LOCK_HOME/release-worker" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    echo "receipt-worker: exceeded the 300s release deadman" >&2
    exit 24
  }
  sleep 0.01
done
printf 'KNOWN-DEFECT\ttap-qwf96\t2026-09-30\tfailed workers count toward the census\n'
echo "receipt-worker: deliberate failure"
exit 23
WORKER
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'KNOWN-DEFECT\ttap-xk0yr\t2026-08-24\tdrain crossing reverted silently\n'
echo "SMOKE-SKIP: known defect fixture fired"
echo "receipt-known-defect: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$FIXTURE" add \
  skills/tap/scripts/smoke/receipt-known-defect.test.sh \
  skills/tap/scripts/smoke/receipt-worker.test.sh
git -C "$FIXTURE" commit -qm worker-failure
failure_head="$(git -C "$FIXTURE" rev-parse HEAD)"
failure_tree="$(git -C "$FIXTURE" rev-parse 'HEAD^{tree}')"
failure_stdout="$WORK/worker-failure.stdout"
failure_stderr="$WORK/worker-failure.stderr"
failure_rc_file="$WORK/worker-failure.rc"
(
  set +e
  run_suite_command >"$failure_stdout" 2>"$failure_stderr"
  printf '%s\n' "$?" >"$failure_rc_file"
) &
failure_pid=$!
failure_deadline=$((SECONDS + 300))
while [ ! -e "$FIXTURE_LOCKS/worker-started" ]; do
  kill -0 "$failure_pid" 2>/dev/null \
    || fail "worker failure fixture exited before entering its worker"
  [ "$SECONDS" -lt "$failure_deadline" ] \
    || fail "worker failure fixture exceeded the 300s start deadman"
  sleep 0.01
done
printf 'mutated during run\n' >"$FIXTURE/mid-run-mutation.txt"
touch "$FIXTURE_LOCKS/release-worker"
wait "$failure_pid"
failure_rc="$(cat "$failure_rc_file")"
[ "$failure_rc" -eq 1 ] || fail "worker failure changed runner exit to $failure_rc"
failure_stdout_receipt="$(awk '/^smoke-all: .* — [0-9]+\/[0-9]+ FAILED, /{print}' "$failure_stdout")"
failure_stderr_receipt="$(awk '/^smoke-all: .* — [0-9]+\/[0-9]+ FAILED, /{print}' "$failure_stderr")"
[ -n "$failure_stdout_receipt" ] || fail "worker failure omitted the stdout red receipt"
[ "$failure_stdout_receipt" = "$failure_stderr_receipt" ] \
  || fail "stdout/stderr red receipts disagreed: stdout=$failure_stdout_receipt stderr=$failure_stderr_receipt"
case "$failure_stdout_receipt" in
  "smoke-all: tested-tree=uncommitted head=$failure_head worktree=dirty"*"; failure-receipt-id="*"; known-defect: 2 (tap-qwf96 tap-xk0yr; observed across all files, not failure attribution); declared-skips=1 skip-files=1 — 1/2 FAILED, 1 passed "*) ;;
  *) fail "worker failure receipt missed its checkout or accounting fields: $failure_stdout_receipt" ;;
esac
case "$failure_stdout_receipt" in
  *"tested-tree=$failure_tree"*) fail "worker failure cited the pre-run tree after a mid-run mutation: $failure_stdout_receipt" ;;
esac
# tap-kg3fb: a reader of just the summary line learns WHICH file failed, and the
# `— N/M FAILED, P passed (Ns, -j J)` tail that the gate parsers end-anchor is
# still the last thing on the line.
case "$failure_stdout_receipt" in
  *"; failing: skills/tap/scripts/smoke/receipt-worker.test.sh; known-defect: "*) ;;
  *) fail "worker failure receipt did not name the failing file before the census: $failure_stdout_receipt" ;;
esac
printf '%s\n' "$failure_stdout_receipt" | grep -Eq ' — [0-9]+/[0-9]+ FAILED, [0-9]+ passed \([0-9]+s, -j [0-9]+\)$' \
  || fail "worker failure receipt no longer ends in the end-anchored counts tail: $failure_stdout_receipt"
grep -q '^=== FAIL skills/tap/scripts/smoke/receipt-worker.test.sh (exit 23) ===$' "$failure_stdout" \
  || fail "worker failure receipt hid the failing-file header"
grep -q '^receipt-worker: deliberate failure$' "$failure_stdout" \
  || fail "worker failure receipt hid the failing-file log"
failure_receipt_id="$(printf '%s\n' "$failure_stdout_receipt" | sed -n 's/.*; failure-receipt-id=\([0-9a-f][0-9a-f]*\);.*/\1/p')"
printf '%s\n' "$failure_receipt_id" | grep -Eq '^[0-9a-f]{32}$' \
  || fail "worker failure receipt omitted its 32-hex failure namespace"
grep -q "^=== SMOKE-FAIL-BEGIN receipt-id=$failure_receipt_id path=skills/tap/scripts/smoke/receipt-worker.test.sh ===$" "$failure_stdout" \
  || fail "worker failure omitted its bound begin marker"
grep -q "^=== SMOKE-FAIL-END receipt-id=$failure_receipt_id path=skills/tap/scripts/smoke/receipt-worker.test.sh ===$" "$failure_stdout" \
  || fail "worker failure omitted its bound end marker"
failure_frame="$WORK/worker-failure.frame"
awk -v id="$failure_receipt_id" '
  $0 == "=== SMOKE-FAIL-BEGIN receipt-id=" id " path=skills/tap/scripts/smoke/receipt-worker.test.sh ===" { inside=1; next }
  $0 == "=== SMOKE-FAIL-END receipt-id=" id " path=skills/tap/scripts/smoke/receipt-worker.test.sh ===" { inside=0; exit }
  inside { print }
' "$failure_stdout" > "$failure_frame"
grep -q '^receipt-worker: deliberate failure$' "$failure_frame" \
  || fail "bound worker frame omitted the retained diagnostic"
if grep -q '^smoke-all: suite-load ' "$failure_frame"; then
  fail "bound worker frame swallowed the outer runner's load annotation"
fi
echo "suite-tree-receipt: (red-1) worker failure preserves exit, log, and its unforgeable outer namespace: ok"
rm -f \
  "$FIXTURE/mid-run-mutation.txt" \
  "$FIXTURE_LOCKS/worker-started" \
  "$FIXTURE_LOCKS/release-worker"

# (red-1b) A retained log without a trailing newline must not run its last byte
# into the bound end marker's own line — both markers are anchored at
# start-of-line, so a glued marker reads as an unterminated BEGIN and gets
# charged as "nested" against the NEXT failing file's begin
# (ci-gate-verdict.py: "nested or duplicate outer failure begin marker",
# observed live 2026-09-25 on reply-settles-after-send.test.sh's
# pretty-printed JSON dump, which ends in a bare `}` with no newline).
git -C "$FIXTURE" checkout -qb no-trailing-newline feature
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
printf '%s' 'receipt-worker: no trailing newline'
exit 23
WORKER
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'KNOWN-DEFECT\ttap-xk0yr\t2026-08-24\tdrain crossing reverted silently\n'
echo "SMOKE-SKIP: known defect fixture fired"
echo "receipt-known-defect: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$FIXTURE" add \
  skills/tap/scripts/smoke/receipt-known-defect.test.sh \
  skills/tap/scripts/smoke/receipt-worker.test.sh
git -C "$FIXTURE" commit -qm no-trailing-newline
notnewline_stdout="$WORK/no-trailing-newline.stdout"
notnewline_stderr="$WORK/no-trailing-newline.stderr"
set +e
run_suite_command >"$notnewline_stdout" 2>"$notnewline_stderr"
notnewline_rc=$?
set -e
[ "$notnewline_rc" -eq 1 ] || fail "(red-1b) no-trailing-newline fixture changed runner exit to $notnewline_rc"
notnewline_receipt="$(awk '/^smoke-all: .* — [0-9]+\/[0-9]+ FAILED, /{print}' "$notnewline_stdout")"
notnewline_receipt_id="$(printf '%s\n' "$notnewline_receipt" | sed -n 's/.*; failure-receipt-id=\([0-9a-f][0-9a-f]*\);.*/\1/p')"
printf '%s\n' "$notnewline_receipt_id" | grep -Eq '^[0-9a-f]{32}$' \
  || fail "(red-1b) no-trailing-newline receipt omitted its 32-hex failure namespace"
grep -q "^=== SMOKE-FAIL-END receipt-id=$notnewline_receipt_id path=skills/tap/scripts/smoke/receipt-worker.test.sh ===\$" "$notnewline_stdout" \
  || fail "(red-1b) a retained log without a trailing newline ran its last byte into the end marker's own line"
grep -q 'receipt-worker: no trailing newline$' "$notnewline_stdout" \
  || fail "(red-1b) the no-trailing-newline diagnostic did not survive in the retained log"
echo "suite-tree-receipt: (red-1b) a retained log without a trailing newline still anchors its end marker at start-of-line: ok"

# (red-1c) tap#1795 Codex review. A retained log's last byte read through raw
# `$(...)` capture cannot represent a NUL byte — bash command substitution
# drops it, so a log ending in one misreads as "" (empty, already
# newline-terminated) and the guard skips, reglueing the marker exactly as
# in (red-1b) for that one byte value. The fix reads the last byte through
# `od` instead, which is binary-safe.
git -C "$FIXTURE" checkout -qb ends-in-nul feature
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
printf 'receipt-worker: ends in NUL\000'
exit 23
WORKER
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'KNOWN-DEFECT\ttap-xk0yr\t2026-08-24\tdrain crossing reverted silently\n'
echo "SMOKE-SKIP: known defect fixture fired"
echo "receipt-known-defect: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$FIXTURE" add \
  skills/tap/scripts/smoke/receipt-known-defect.test.sh \
  skills/tap/scripts/smoke/receipt-worker.test.sh
git -C "$FIXTURE" commit -qm ends-in-nul
nul_stdout="$WORK/ends-in-nul.stdout"
nul_stderr="$WORK/ends-in-nul.stderr"
set +e
run_suite_command >"$nul_stdout" 2>"$nul_stderr"
nul_rc=$?
set -e
[ "$nul_rc" -eq 1 ] || fail "(red-1c) ends-in-nul fixture changed runner exit to $nul_rc"
nul_receipt="$(awk '/^smoke-all: .* — [0-9]+\/[0-9]+ FAILED, /{print}' "$nul_stdout")"
nul_receipt_id="$(printf '%s\n' "$nul_receipt" | sed -n 's/.*; failure-receipt-id=\([0-9a-f][0-9a-f]*\);.*/\1/p')"
printf '%s\n' "$nul_receipt_id" | grep -Eq '^[0-9a-f]{32}$' \
  || fail "(red-1c) ends-in-nul receipt omitted its 32-hex failure namespace"
grep -q "^=== SMOKE-FAIL-END receipt-id=$nul_receipt_id path=skills/tap/scripts/smoke/receipt-worker.test.sh ===\$" "$nul_stdout" \
  || fail "(red-1c) a retained log ending in a NUL byte ran its last byte into the end marker's own line"
grep -q 'receipt-worker: ends in NUL' "$nul_stdout" \
  || fail "(red-1c) the NUL-terminated diagnostic did not survive in the retained log"
echo "suite-tree-receipt: (red-1c) a retained log ending in a NUL byte still anchors its end marker at start-of-line: ok"

# A worker process dying before it writes either ledger is a completed
# scheduler result too: the runner detects the mismatch and anchors that red.
# After r3916183747 the session-leader shim is PPID of the smoke child; killing
# that shim lets the outer xargs worker still write pass/fail. The ledger writer
# is the shim's parent.
git -C "$FIXTURE" checkout -qb ledger-mismatch feature
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
outer="$(ps -o ppid= -p "$PPID" | tr -d '[:space:]')"
kill -KILL "$outer"
exit 0
WORKER
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'KNOWN-DEFECT\ttap-xk0yr\t2026-08-24\tdrain crossing reverted silently\n'
echo "SMOKE-SKIP: known defect fixture fired"
echo "receipt-known-defect: ok"
WORKER
chmod +x "$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$FIXTURE" add \
  skills/tap/scripts/smoke/receipt-known-defect.test.sh \
  skills/tap/scripts/smoke/receipt-worker.test.sh
git -C "$FIXTURE" commit -qm ledger-mismatch
ledger_head="$(git -C "$FIXTURE" rev-parse HEAD)"
ledger_tree="$(git -C "$FIXTURE" rev-parse 'HEAD^{tree}')"
ledger_stdout="$WORK/ledger-mismatch.stdout"
ledger_stderr="$WORK/ledger-mismatch.stderr"
set +e
run_suite_command >"$ledger_stdout" 2>"$ledger_stderr"
ledger_rc=$?
set -e
[ "$ledger_rc" -eq 1 ] || fail "ledger mismatch changed runner exit to $ledger_rc"
ledger_receipt="$(awk '/^smoke-all: .* — ledger mismatch — /{print}' "$ledger_stderr")"
case "$ledger_receipt" in
  "smoke-all: tested-tree=$ledger_tree head=$ledger_head worktree=clean"*"; known-defect: 1 (tap-xk0yr; observed across all files, not failure attribution); declared-skips=1 skip-files=1 — ledger mismatch — 1 passed + 0 failed != 2 files (worker died?)"*) ;;
  *) fail "ledger mismatch receipt omitted its clean tested tree: $ledger_receipt" ;;
esac
echo "suite-tree-receipt: (red-2) ledger mismatch preserves exit and captured receipt: ok"

# (red-3) tap-1f45b. A run that STRADDLES two checkouts must refuse, not report
# the end-state anchors. The trap this pins is that every other anchor keeps
# passing through a straddle: the receipt names a real head, a real tree, and
# `worktree=clean`, so the run reads FRESHER than it was and nothing in the
# output hints that the workers read a tree that no longer exists.
#
# Deterministic by construction, no sleeps: the worker blocks on `release-worker`
# exactly as (red-1) does, so the commit lands strictly inside the worker window.
#
# Both pins are asserted with DISTINCT values on purpose. Asserting only that
# the token appears would survive a comparison that reported one side twice, or
# echoed the receipt head into both slots — presence is not discrimination.
#
# DO NOT normalize these two SHAs to one value in a later cleanup. They look
# like duplicable fixture noise and they are the whole discrimination: with one
# value the arm cannot distinguish "both pins reported correctly" from "one pin
# echoed into both slots", and it stops discriminating SILENTLY — still green,
# still named the same, testing less. The reason is written here because an
# editor who sees distinct values without it will tidy them.
git -C "$FIXTURE" checkout -qb straddle feature
cat >"$FIXTURE/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
touch "$TAP_SUITE_LOCK_HOME/worker-started"
deadline=$((SECONDS + 300))
while [ ! -e "$TAP_SUITE_LOCK_HOME/release-worker" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    echo "receipt-worker: exceeded the 300s release deadman" >&2
    exit 24
  }
  sleep 0.01
done
echo "receipt-worker: ok"
WORKER
rm -f "$FIXTURE/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$FIXTURE" add -A skills/tap/scripts/smoke
git -C "$FIXTURE" commit -qm straddle-base
straddle_start_head="$(git -C "$FIXTURE" rev-parse HEAD)"
straddle_stdout="$WORK/straddle.stdout"
straddle_stderr="$WORK/straddle.stderr"
straddle_rc_file="$WORK/straddle.rc"
(
  set +e
  run_suite_command >"$straddle_stdout" 2>"$straddle_stderr"
  printf '%s\n' "$?" >"$straddle_rc_file"
) &
straddle_pid=$!
straddle_deadline=$((SECONDS + 300))
while [ ! -e "$FIXTURE_LOCKS/worker-started" ]; do
  kill -0 "$straddle_pid" 2>/dev/null \
    || fail "straddle fixture exited before entering its worker"
  [ "$SECONDS" -lt "$straddle_deadline" ] \
    || fail "straddle fixture exceeded the 300s start deadman"
  sleep 0.01
done
# A tracked commit moves HEAD and the tree together — the real shape of the
# incident, an author landing a review fix while a reviewer's suite runs.
printf 'landed mid-run\n' >"$FIXTURE/shared.txt"
git -C "$FIXTURE" add shared.txt
git -C "$FIXTURE" commit -qm landed-during-the-run
straddle_end_head="$(git -C "$FIXTURE" rev-parse HEAD)"
straddle_end_tree="$(git -C "$FIXTURE" rev-parse "${straddle_end_head}^{tree}")"
[ "$straddle_start_head" != "$straddle_end_head" ] \
  || fail "straddle fixture failed to move HEAD; the arm would pass vacuously"
touch "$FIXTURE_LOCKS/release-worker"
wait "$straddle_pid"
straddle_rc="$(cat "$straddle_rc_file")"
[ "$straddle_rc" -ne 0 ] || fail "a straddled run exited 0"
grep -q -- '— ok — all' "$straddle_stdout" \
  && fail "a straddled run emitted a green ok-line: $(cat "$straddle_stdout")"
straddle_receipt="$(awk '/^smoke-all: .* — STRADDLED — /{print}' "$straddle_stderr")"
[ -n "$straddle_receipt" ] || fail "straddled run omitted the STRADDLED refusal: $(cat "$straddle_stderr")"
case "$straddle_receipt" in
  *"start-head=$straddle_start_head"*) ;;
  *) fail "straddle refusal did not name the pinned start head: $straddle_receipt" ;;
esac
case "$straddle_receipt" in
  *"receipt-head=$straddle_end_head"*) ;;
  *) fail "straddle refusal did not name the observed receipt head: $straddle_receipt" ;;
esac
# tap-1f45b (review): receipt-tree must be the observed ending TREE, not a
# second commit id. Pre-fix, receipt-tree carried head_after (a commit OID), so this
# arm reds; the fix reports the observed ${tree}.
case "$straddle_receipt" in
  *"receipt-tree=$straddle_end_tree"*) ;;
  *) fail "straddle refusal did not name the observed receipt tree: $straddle_receipt" ;;
esac
rm -f "$FIXTURE_LOCKS/worker-started" "$FIXTURE_LOCKS/release-worker"
git -C "$FIXTURE" checkout -q feature
echo "suite-tree-receipt: (red-3) a straddled run refuses and names both checkouts: ok"

# (red-4) tap-1f45b (review, two P1s). The first straddle comparison
# ENUMERATED the cases it had thought of and left two:
#
#   * the head moves between smoke_gate_receipt's OWN two rev-parse samples.
#     git_observation became head-moved -- the runner OBSERVED it -- and the
#     comparison still used the first sample, which equals the pin, so nothing
#     straddled and the run proceeded toward green. A detector that sees the
#     condition and discards the observation is worse than an absent one,
#     because the receipt then carries the runner's authority behind it.
#   * the head does not resolve at all. smoke_gate_receipt returned before the
#     comparison ran, so a run that began from a resolvable pin could emit
#     `head=unavailable` and stay green -- affirmative evidence the checkout
#     moved, reading as an absence of information.
#
# Both now derive from ONE invariant rather than being patched by name: a
# receipt may be green only if the head the suite STARTED from is the head it
# ENDED on, and both resolve. That also closes a third case neither review
# named -- an unborn/empty second sample -- which is the point of fixing from
# the invariant instead of from the witnesses.
#
# SCOPE: these arms drive the comparison logic directly. red-3 above owns the
# end-to-end mid-run-commit case; do not read red-4 as end-to-end evidence.
straddle_logic() { # pinned head head_after -> reason, empty when the invariant holds
  local pinned="$1" head="$2" head_after="$3" tree worktree_state reason=""
  if [ -z "$head" ]; then
    if [ -n "$pinned" ] && [ "$pinned" != unpinnable ]; then printf 'unresolvable'; fi
    return
  fi
  if [ "$head_after" != "$head" ]; then tree=unverified; worktree_state=unknown
  else tree="tree-of-$head"; worktree_state=clean; fi
  if [ "$pinned" = unpinnable ]; then reason="unpinnable-start"
  elif [ -n "$pinned" ]; then
    if [ "$pinned" != "$head" ]; then reason="start!=receipt"
    elif [ -z "$head_after" ]; then reason="receipt-head-unreadable"
    elif [ "$head_after" != "$head" ]; then reason="moved-inside-receipt"
    elif [ "tree-of-$pinned" != "$tree" ]; then reason="tree-moved"; fi
  fi
  printf '%s' "$reason"
}
[ "$(straddle_logic A A B)" = "moved-inside-receipt" ] \
  || fail "(red-4) a head moving between the receipt's own two samples did not straddle"
[ "$(straddle_logic A '' '')" = "unresolvable" ] \
  || fail "(red-4) an unresolvable head on a pinned run did not straddle"
[ "$(straddle_logic A A '')" = "receipt-head-unreadable" ] \
  || fail "(red-4) an unreadable second sample did not straddle as receipt-head-unreadable"
[ "$(straddle_logic A B B)" = "start!=receipt" ] \
  || fail "(red-4) the ordinary straddle stopped firing"
# NEGATIVE ARMS. Without these an always-straddle mutation passes every arm
# above -- the positive-arm-passes-in-both-worlds shape this file already
# documents for red-3 and assert_not_straddled.
[ -z "$(straddle_logic A A A)" ] \
  || fail "(red-4) a clean run was reported straddled"
[ -z "$(straddle_logic '' X X)" ] \
  || fail "(red-4) a run with no pin was reported straddled"
# Review, third P1: `unpinnable` is an ENDPOINT STATE, not an exemption.
# A start that could not be pinned and a finish that resolves is a commit
# landing inside the worker window -- exactly what this refusal is for -- and
# the earlier sentinel made that start exempt from every later comparison.
[ "$(straddle_logic unpinnable X X)" = "unpinnable-start" ] \
  || fail "(red-4) an unpinnable start with a resolvable finish did not straddle"
# Its negative half: two ends agreeing on "no commit" is silent, not straddled.
# Production reaches that through the unresolvable-head early return, which
# consults the pin and writes nothing when the pin is unpinnable.
[ -z "$(straddle_logic unpinnable '' '')" ] \
  || fail "(red-4) an unpinnable start with an unresolvable finish was reported straddled"
echo "suite-tree-receipt: (red-4) straddle derives from the invariant, not an enumeration: ok"

# (red-5) tap-1f45b (review, third P1). red-4 above drives a REPLICA of the
# comparison; this arm drives the runner itself, because a replica agrees with
# whatever it was written next to. An unborn checkout is pinned `unpinnable`,
# a commit lands inside the worker window, and the finish resolves: the run
# must refuse rather than stamp the commit it did not read from.
#
# Deterministic by construction, no sleeps: the worker blocks on
# `release-worker` exactly as (red-1) and (red-3) do, so the commit lands
# strictly inside the worker window.
UNBORN="$WORK/repo-unborn"
UNBORN_LOCKS="$WORK/locks-unborn"
mkdir -p "$UNBORN" "$UNBORN_LOCKS"
(cd "$FIXTURE" && git ls-files -z | xargs -0 tar cf - ) | (cd "$UNBORN" && tar xf -)
cat >"$UNBORN/skills/tap/scripts/smoke/receipt-worker.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
touch "$TAP_SUITE_LOCK_HOME/worker-started"
deadline=$((SECONDS + 300))
while [ ! -e "$TAP_SUITE_LOCK_HOME/release-worker" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    echo "receipt-worker: exceeded the 300s release deadman" >&2
    exit 24
  }
  sleep 0.01
done
echo "receipt-worker: ok"
WORKER
chmod +x "$UNBORN/skills/tap/scripts/smoke/receipt-worker.test.sh"
rm -f "$UNBORN/skills/tap/scripts/smoke/receipt-known-defect.test.sh"
git -C "$UNBORN" init -q
git -C "$UNBORN" config user.email "tap@test"
git -C "$UNBORN" config user.name "tap"
git -C "$UNBORN" rev-parse --verify HEAD >/dev/null 2>&1 \
  && fail "(red-5) fixture HEAD resolved before the run; the arm would not be unpinnable"

unborn_stdout="$WORK/unborn.stdout"
unborn_stderr="$WORK/unborn.stderr"
unborn_rc_file="$WORK/unborn.rc"
(
  set +e
  (
    cd "$UNBORN"
    env -i \
      HOME="$FIXTURE_HOME" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM="dumb" \
      LANG="C" \
      LC_CTYPE="en_US.UTF-8" \
      TZ="UTC" \
      TAP_PYTHON="$PY" \
      TAP_SUITE_SLOT="bypass" \
      TAP_SUITE_LOCK_HOME="$UNBORN_LOCKS" \
      TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
      bash "$UNBORN/scripts/smoke-all.sh" -j 1
  ) >"$unborn_stdout" 2>"$unborn_stderr"
  printf '%s\n' "$?" >"$unborn_rc_file"
) &
unborn_pid=$!
unborn_deadline=$((SECONDS + 300))
while [ ! -e "$UNBORN_LOCKS/worker-started" ]; do
  kill -0 "$unborn_pid" 2>/dev/null \
    || fail "(red-5) unborn fixture exited before entering its worker: $(cat "$unborn_stderr")"
  [ "$SECONDS" -lt "$unborn_deadline" ] \
    || fail "(red-5) unborn fixture exceeded the 300s start deadman"
  sleep 0.01
done
git -C "$UNBORN" add -A
git -C "$UNBORN" commit -qm landed-during-an-unborn-run
unborn_end_head="$(git -C "$UNBORN" rev-parse HEAD)"
[ -n "$unborn_end_head" ] \
  || fail "(red-5) fixture failed to resolve a finish head; the arm would pass vacuously"
touch "$UNBORN_LOCKS/release-worker"
wait "$unborn_pid"
unborn_rc="$(cat "$unborn_rc_file")"
[ "$unborn_rc" -ne 0 ] || fail "(red-5) a run that began unborn and ended resolvable exited 0"
grep -q -- '— ok — all' "$unborn_stdout" \
  && fail "(red-5) a run that began unborn and ended resolvable emitted a green ok-line: $(cat "$unborn_stdout")"
unborn_receipt="$(awk '/^smoke-all: .* — STRADDLED — /{print}' "$unborn_stderr")"
[ -n "$unborn_receipt" ] \
  || fail "(red-5) unborn-to-resolvable run omitted the STRADDLED refusal: $(cat "$unborn_stderr")"
case "$unborn_receipt" in
  *"start-head=unpinnable"*) ;;
  *) fail "(red-5) refusal did not name the unpinnable start: $unborn_receipt" ;;
esac
case "$unborn_receipt" in
  *"receipt-head=$unborn_end_head"*) ;;
  *) fail "(red-5) refusal did not name the resolved finish head: $unborn_receipt" ;;
esac
case "$unborn_receipt" in
  *"reason=unpinnable-start"*) ;;
  *) fail "(red-5) refusal did not name the unpinnable-start reason: $unborn_receipt" ;;
esac
rm -f "$UNBORN_LOCKS/worker-started" "$UNBORN_LOCKS/release-worker"
echo "suite-tree-receipt: (red-5) an unpinnable start with a resolvable finish refuses: ok"

# (red-6) tap-fxcqb. The receipt reads HEAD, then `status`, then HEAD again. Two
# things can happen to that second read, and the receipt must tell them apart:
# it FAILS (an observation failure: the run cannot show the checkout stayed put)
# or it returns a DIFFERENT head (an observed move). Both refuse with STRADDLED;
# only the reason and the wording differ. Driven end to end through the runner.
# The fault seam is a `git` shell function injected into the fixture's COPY of
# smoke-all.sh (the runner re-execs under `env -i` with a fixed PATH, so a PATH
# shim cannot survive, and this is the seam suite-skip-accounting already uses:
# mutate the copy, never the real script). It acts only on the
# `rev-parse --verify HEAD` that immediately follows the receipt's own
# `status --porcelain --untracked-files=all`, and only once the test has armed it
# after the worker started, so the start pin and every earlier read are real.
# Mode `fail` makes that read exit 128; mode `move` first lands a real commit.
# (red-3 above is the start!=receipt shape: the commit lands before the receipt's
# first read. red-4 replicates the comparison; this is the end-to-end proof.)
run_shimmed_receipt() { # mode -> sets shim_stdout shim_stderr shim_rc shim_receipt
  local mode="$1" tag="red6-$1"
  local repo="$WORK/repo-$tag" locks="$WORK/locks-$tag" state="$WORK/git-shim-state-$tag" rc_file="$WORK/$tag.rc"
  shim_stdout="$WORK/$tag.stdout"
  shim_stderr="$WORK/$tag.stderr"
  mkdir -p "$repo" "$locks" "$state"
  (cd "$UNBORN" && git ls-files -z | xargs -0 tar cf - ) | (cd "$repo" && tar xf -)
  {
    sed -n '1,/^SMOKE_ALL_FIXED_PATH=/p' "$repo/scripts/smoke-all.sh"
    cat <<SHIM
git() {
  case " \$* " in
    *" status --porcelain --untracked-files=all "*)
      [ ! -e "$state/armed" ] || : >"$state/after-status" ;;
    *" rev-parse --verify HEAD "*)
      if [ -e "$state/after-status" ] && [ ! -e "$state/second-read-hit" ]; then
        : >"$state/second-read-hit"
        [ "$mode" != fail ] || return 128
        command git "\$1" "\$2" -c user.name=tap -c user.email=tap@test commit -q --allow-empty -m moved-inside-receipt
      fi ;;
  esac
  command git "\$@"
}
SHIM
    sed -n '/^SMOKE_ALL_FIXED_PATH=/,$p' "$repo/scripts/smoke-all.sh" | tail -n +2
  } >"$repo/scripts/smoke-all.sh.shimmed"
  mv "$repo/scripts/smoke-all.sh.shimmed" "$repo/scripts/smoke-all.sh"
  grep -q "^git() {" "$repo/scripts/smoke-all.sh" \
    || fail "(red-6 $mode) the fault seam was not injected into the fixture copy"
  git -C "$repo" init -q
  git -C "$repo" config user.email "tap@test"
  git -C "$repo" config user.name "tap"
  git -C "$repo" add -A
  git -C "$repo" commit -qm "$tag-base"
  (
    set +e
    (
      cd "$repo"
      env -i \
        HOME="$FIXTURE_HOME" \
        PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        TERM="dumb" \
        LANG="C" \
        LC_CTYPE="en_US.UTF-8" \
        TZ="UTC" \
        TAP_PYTHON="$PY" \
        TAP_SUITE_SLOT="bypass" \
        TAP_SUITE_LOCK_HOME="$locks" \
        TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
        bash "$repo/scripts/smoke-all.sh" -j 1
    ) >"$shim_stdout" 2>"$shim_stderr"
    printf '%s\n' "$?" >"$rc_file"
  ) &
  local pid=$! deadline=$((SECONDS + 300))
  while [ ! -e "$locks/worker-started" ]; do
    kill -0 "$pid" 2>/dev/null \
      || fail "(red-6 $mode) fixture exited before entering its worker: $(cat "$shim_stderr")"
    [ "$SECONDS" -lt "$deadline" ] || fail "(red-6 $mode) fixture exceeded the 300s start deadman"
    sleep 0.01
  done
  : >"$state/armed"
  touch "$locks/release-worker"
  wait "$pid"
  [ -e "$state/second-read-hit" ] \
    || fail "(red-6 $mode) the seam never intercepted the receipt's second HEAD read; the arm would pass vacuously: $(cat "$shim_stderr")"
  shim_rc="$(cat "$rc_file")"
  [ "$shim_rc" -ne 0 ] || fail "(red-6 $mode) the run exited 0"
  grep -q -- '— ok — all' "$shim_stdout" \
    && fail "(red-6 $mode) the run emitted a green ok-line: $(cat "$shim_stdout")"
  shim_receipt="$(awk '/^smoke-all: .* — STRADDLED — /{print}' "$shim_stderr")"
  [ -n "$shim_receipt" ] || fail "(red-6 $mode) the run omitted the STRADDLED refusal: $(cat "$shim_stderr")"
}

# fail: the second read is unavailable, not a move.
run_shimmed_receipt fail
case "$shim_receipt" in
  *"reason=receipt-head-unreadable"*) ;;
  *) fail "(red-6 fail) refusal did not name reason=receipt-head-unreadable: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"git-observation=head-unavailable"*) ;;
  *) fail "(red-6 fail) receipt did not carry git-observation=head-unavailable: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"the checkout could not be re-read at receipt"*) ;;
  *) fail "(red-6 fail) refusal did not say the checkout could not be re-read: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"moved-inside-receipt"*|*"the checkout moved"*|*"git-observation=head-moved"*)
    fail "(red-6 fail) an unreadable re-read was reported as a move: $shim_receipt" ;;
esac
echo "suite-tree-receipt: (red-6) an unreadable receipt HEAD refuses as receipt-head-unreadable, not as a move: ok"

# move: the second read returns a different head, which stays a move.
run_shimmed_receipt move
case "$shim_receipt" in
  *"reason=moved-inside-receipt"*) ;;
  *) fail "(red-6 move) refusal did not name reason=moved-inside-receipt: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"git-observation=head-moved"*) ;;
  *) fail "(red-6 move) receipt did not carry git-observation=head-moved: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"the checkout moved between suite start and receipt"*) ;;
  *) fail "(red-6 move) refusal lost its moved wording: $shim_receipt" ;;
esac
case "$shim_receipt" in
  *"receipt-head-unreadable"*|*"could not be re-read"*)
    fail "(red-6 move) an observed move was reported as unreadable: $shim_receipt" ;;
esac
echo "suite-tree-receipt: (red-6) a second read that returns a different head still refuses as moved-inside-receipt: ok"

git -C "$FIXTURE" checkout -q feature

# (1) Intersecting drift is part of the only successful receipt.
summary="$(run_summary drifted)"
case "$summary" in
  *"tested-tree=$feature_tree head=$feature_head worktree=clean"*) ;;
  *) fail "receipt omitted the clean tested tree: $summary" ;;
esac
case "$summary" in
  *"BASE DRIFT vs local origin/main@$main_head (freshness caller-owned): behind=1"*) ;;
  *) fail "receipt omitted local base drift: $summary" ;;
esac
case "$summary" in
  *"overlap=[\"shared.txt\"] (prioritization only; disjoint files may still interact)"*) ;;
  *) fail "receipt omitted the concrete non-exhaustive overlap: $summary" ;;
esac
echo "suite-tree-receipt: (1) intersecting local base drift is inseparable from the tree receipt: ok"

# (2) An up-to-date checkout keeps the one-line shape and identifies both refs.
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$feature_head"
summary="$(run_summary current)"
case "$summary" in
  *"tested-tree=$feature_tree head=$feature_head worktree=clean"*) ;;
  *) fail "current receipt omitted its tested-tree identity: $summary" ;;
esac
case "$summary" in
  *"local origin/main@$feature_head (freshness caller-owned): behind=0"*) ;;
  *) fail "current receipt omitted its local-base identity: $summary" ;;
esac
case "$summary" in
  *"BASE DRIFT"*) fail "current receipt falsely reported base drift: $summary" ;;
esac
echo "suite-tree-receipt: (2) current checkout retains one receipt with exact identity: ok"

# (2b) A missing local tracking ref cannot produce a defaulted zero.
git -C "$FIXTURE" update-ref -d refs/remotes/origin/main
summary="$(run_summary missing-ref)"
case "$summary" in
  *"local origin/main unavailable (freshness caller-owned): drift=unknown"*) ;;
  *) fail "missing local base did not stay explicitly unknown: $summary" ;;
esac
case "$summary" in
  *"behind=0"*) fail "missing local base defaulted to zero: $summary" ;;
esac
echo "suite-tree-receipt: (2b) missing local base cannot masquerade as behind zero: ok"

# (3) Empty path overlap never erases behind-ness or claims safety.
git -C "$FIXTURE" checkout -qb main-disjoint "$base"
printf 'main only\n' >"$FIXTURE/main-only.txt"
git -C "$FIXTURE" add main-only.txt
git -C "$FIXTURE" commit -qm main-disjoint
disjoint_main="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$disjoint_main"
git -C "$FIXTURE" checkout -q feature
summary="$(run_summary disjoint-drift)"
case "$summary" in
  *"BASE DRIFT vs local origin/main@$disjoint_main (freshness caller-owned): behind=1"*) ;;
  *) fail "empty overlap hid behind-ness: $summary" ;;
esac
case "$summary" in
  *"overlap=[] (prioritization only; disjoint files may still interact)"*) ;;
  *) fail "empty overlap implied safety: $summary" ;;
esac
echo "suite-tree-receipt: (3) empty overlap remains an explicit non-exhaustive drift advisory: ok"

# (4) A dirty checkout must not present HEAD's immutable tree as the tested tree.
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$feature_head"
printf 'untracked\n' >"$FIXTURE/test-artifact.txt"
summary="$(run_summary dirty)"
case "$summary" in
  *"tested-tree=uncommitted head=$feature_head worktree=dirty"*) ;;
  *) fail "dirty checkout overclaimed an immutable tested tree: $summary" ;;
esac
case "$summary" in
  *"tested-tree=$feature_tree"*) fail "dirty receipt cited HEAD's tree as exercised: $summary" ;;
esac
echo "suite-tree-receipt: (4) dirty checkout is visible and never overclaims HEAD tree: ok"

# (4b) tap-8sez: "worktree=dirty" alone sends the reader to `git status` —
# name the offending path so a stray captured-output file is diagnosable
# from the anchor line itself, in the common case (a smoke-all run's own
# `> gate.log` landing inside the tree it is testing).
case "$summary" in
  *'worktree=dirty dirty-paths=["test-artifact.txt"]'*) ;;
  *) fail "dirty receipt did not name the offending path: $summary" ;;
esac
echo "suite-tree-receipt: (4b) dirty receipt names the offending path (tap-8sez): ok"
rm -f "$FIXTURE/test-artifact.txt"

# (4c) A pile of untracked files must not blow up the anchor line — cap and
# say how many more, rather than either truncating silently or dumping N.
for _n in 1 2 3 4 5 6 7; do printf 'x\n' >"$FIXTURE/pile-$_n.txt"; done
summary="$(run_summary dirty-pile)"
case "$summary" in
  *'dirty-paths=["pile-1.txt","pile-2.txt","pile-3.txt","pile-4.txt","pile-5.txt","+2 more"]'*) ;;
  *) fail "dirty receipt did not cap a large untracked pile with a remainder count: $summary" ;;
esac
echo "suite-tree-receipt: (4c) dirty receipt caps a large pile with a remainder count (tap-8sez): ok"
rm -f "$FIXTURE"/pile-*.txt

# (5) Valid path names must not collide with empty or multi-path displays.
rm -f "$FIXTURE/test-artifact.txt"
git -C "$FIXTURE" checkout -qb feature-paths "$base"
printf 'feature comma\n' >"$FIXTURE/a,b"
printf 'feature none\n' >"$FIXTURE/none"
git -C "$FIXTURE" add 'a,b' none
git -C "$FIXTURE" commit -qm feature-paths
path_feature_head="$(git -C "$FIXTURE" rev-parse HEAD)"

git -C "$FIXTURE" checkout -qb main-paths "$base"
printf 'main comma\n' >"$FIXTURE/a,b"
printf 'main none\n' >"$FIXTURE/none"
git -C "$FIXTURE" add 'a,b' none
git -C "$FIXTURE" commit -qm main-paths
path_main_head="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$path_main_head"
git -C "$FIXTURE" checkout -q feature-paths

summary="$(run_summary path-encoding)"
case "$summary" in
  *"tested-tree="*" head=$path_feature_head worktree=clean"*) ;;
  *) fail "path-encoding receipt omitted its checkout identity: $summary" ;;
esac
case "$summary" in
  *"BASE DRIFT vs local origin/main@$path_main_head (freshness caller-owned): behind=1 overlap=[\"a,b\",\"none\"]"*) ;;
  *) fail "valid path names did not receive an unambiguous overlap encoding: $summary" ;;
esac
echo "suite-tree-receipt: (5) path overlap encoding distinguishes commas and literal none: ok"

# (6) No local merge base is an observed state, not a guessed history claim.
git -C "$FIXTURE" checkout -q --orphan unrelated-main
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm unrelated-main
unrelated_main="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$unrelated_main"
git -C "$FIXTURE" checkout -q feature
summary="$(run_summary no-local-merge-base)"
case "$summary" in
  *"local origin/main@$unrelated_main (freshness caller-owned): drift=no-local-merge-base"*) ;;
  *) fail "no-local-merge-base state was overclaimed or hidden: $summary" ;;
esac
echo "suite-tree-receipt: (6) no local merge base remains a bounded observation: ok"

# (7) A failed path observation must not masquerade as a measured empty set.
git -C "$FIXTURE" checkout -q feature
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$main_head"
main_tree_object="$FIXTURE/.git/objects/${main_tree:0:2}/${main_tree:2}"
[ -f "$main_tree_object" ] || fail "main tree object is not loose for failure injection"
rm -f "$main_tree_object"
if git -C "$FIXTURE" cat-file -e "$main_tree" 2>/dev/null; then
  fail "failure injection did not make the main tree unreadable"
fi
summary="$(run_summary path-observation-failure)"
case "$summary" in
  *"BASE DRIFT vs local origin/main@$main_head (freshness caller-owned): behind=1"*) ;;
  *) fail "path-observation failure hid known behind-ness: $summary" ;;
esac
case "$summary" in
  *"overlap=unknown (path observation failed; disjoint files may still interact)"*) ;;
  *) fail "failed path observation emitted a confident overlap: $summary" ;;
esac
case "$summary" in
  *"overlap=[]"*) fail "failed path observation masqueraded as empty: $summary" ;;
esac
echo "suite-tree-receipt: (7) failed path observation stays visibly unknown: ok"

# (8) A merge-base command error is distinct from an observed missing base.
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$unrelated_main"
unrelated_commit_object="$FIXTURE/.git/objects/${unrelated_main:0:2}/${unrelated_main:2}"
[ -f "$unrelated_commit_object" ] || fail "unrelated commit object is not loose for failure injection"
rm -f "$unrelated_commit_object"
if git -C "$FIXTURE" cat-file -e "$unrelated_main" 2>/dev/null; then
  fail "failure injection did not make the remote commit unreadable"
fi
summary="$(run_summary merge-base-observation-failure)"
case "$summary" in
  *"local origin/main@$unrelated_main (freshness caller-owned): drift=unknown git-observation=failed"*) ;;
  *) fail "merge-base failure masqueraded as a history observation: $summary" ;;
esac
echo "suite-tree-receipt: (8) merge-base command failure stays explicitly unknown: ok"

# (9) A versioned checkout whose HEAD cannot be resolved is not unversioned.
git -C "$FIXTURE" checkout -q --orphan receipt-unborn
summary="$(run_summary unborn-HEAD)"
case "$summary" in
  "smoke-all: tested-tree=unverified head=unavailable worktree=unknown git-observation=failed; local origin/main unavailable (freshness caller-owned): drift=unknown; ignored-state-roots: 1 checked, 0 new or changed; known-defect: 0; declared-skips=0 skip-files=0 — ok — all "*) ;;
  *) fail "versioned HEAD observation failure was mislabeled: $summary" ;;
esac
case "$summary" in
  *"tested-tree=unversioned"*) fail "versioned checkout was called unversioned: $summary" ;;
esac
echo "suite-tree-receipt: (9) versioned HEAD observation failure stays explicit: ok"

# (10) A copied runner with no Git metadata remains explicitly unversioned.
mv "$FIXTURE/.git" "$WORK/fixture-git-metadata"
summary="$(run_summary unversioned)"
case "$summary" in
  "smoke-all: tested-tree=unversioned head=unavailable worktree=unknown; local origin/main unavailable (freshness caller-owned): drift=unknown; ignored-state-roots: 1 checked, 0 new or changed; known-defect: 0; declared-skips=0 skip-files=0 — ok — all "*) ;;
  *) fail "non-Git fixture did not report unversioned state: $summary" ;;
esac
echo "suite-tree-receipt: (10) non-Git runner remains explicitly unversioned: ok"

# (11) tap-kg3fb: the failing-files segment is deduped, in ledger order, capped at
# 20 with a count of the rest, names post-wave classes after the files, and is
# empty when nothing failed. Drives the real function, extracted from the runner.
eval "$(sed -n '/^red_failing_segment() {/,/^}/p' "$SMOKE_ALL")"
declare -F red_failing_segment >/dev/null || fail "(11) could not extract red_failing_segment from the runner"
cap_fail="$WORK/cap-fail.ledger"
cap_post="$WORK/cap-post.ledger"
: >"$cap_fail"
for i in $(seq 1 22); do
  printf '1\tskills/x/smoke/f%02d.test.sh\t/log/f%02d\n' "$i" "$i" >>"$cap_fail"
done
printf '1\tskills/x/smoke/f01.test.sh\t/log/dup\n' >>"$cap_fail"
printf 'operator-state\t/out\n' >"$cap_post"
cap_seg="$(red_failing_segment "$cap_fail" "$cap_post")"
case "$cap_seg" in
  "; failing: skills/x/smoke/f01.test.sh skills/x/smoke/f02.test.sh "*" skills/x/smoke/f20.test.sh (+3 more)") ;;
  *) fail "(11) capped failing segment has the wrong shape: $cap_seg" ;;
esac
case "$cap_seg" in
  *f21.test.sh*|*"post-wave:"*) fail "(11) the cap let entries past 20 through: $cap_seg" ;;
esac
[ "$(printf '%s' "$cap_seg" | grep -o 'f01.test.sh' | wc -l | tr -d ' ')" = 1 ] \
  || fail "(11) a duplicate ledger row was listed twice: $cap_seg"
few_seg="$(red_failing_segment "$cap_post" "$cap_post")"
[ "$few_seg" = "; failing: /out post-wave:operator-state" ] \
  || fail "(11) small mixed ledger shape wrong (files then post-wave classes): $few_seg"
post_only="$(red_failing_segment "$WORK/no-such-ledger" "$cap_post")"
[ "$post_only" = "; failing: post-wave:operator-state" ] \
  || fail "(11) post-wave-only failure was not named: $post_only"
[ -z "$(red_failing_segment "$WORK/no-such-ledger" "$WORK/no-such-ledger")" ] \
  || fail "(11) an empty ledger produced a failing segment"
echo "suite-tree-receipt: (11) the failing-files segment is deduped, ordered, capped, and empty when nothing failed: ok"

echo "PASS suite-tree-receipt"
