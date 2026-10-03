#!/usr/bin/env bash
# suite-skip-accounting.test.sh — green receipts retain declared skips and
# refuse exit-zero workers that emit undeclared skip-shaped output.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="${SMOKE_ALL_UNDER_TEST:-$ROOT/scripts/smoke-all.sh}"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "suite-skip-accounting: $1" >&2; exit 1; }

[ -f "$SMOKE_ALL" ] || fail "runner under test not found: $SMOKE_ALL"

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
WORKER="$FIXTURE/skills/tap/scripts/smoke/accounting-worker.test.sh"
WORKER_REL="skills/tap/scripts/smoke/accounting-worker.test.sh"
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

run_suite() {
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
    bash "$FIXTURE/scripts/smoke-all.sh" -j "${SUITE_JOBS:-1}" 2>&1
}

summary_from() {
  printf '%s\n' "$1" | awk '/^smoke-all: .* — ok — all /{print}'
}

assert_one_summary() {
  local out="$1" count
  count="$(printf '%s\n' "$out" | awk '/^smoke-all: .* — ok — all /{count++} END{print count+0}')"
  [ "$count" = 1 ] || fail "expected exactly one terminal green, found $count: $out"
}

assert_no_green() {
  case "$1" in
    *" — ok — all "*) fail "$2 left a quotable terminal green: $1" ;;
  esac
}

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP: fixture capability unavailable"
echo "SMOKE-SKIP: second fixture capability unavailable"
echo "accounting-worker: ok"
WORKER
chmod +x "$WORKER"

declared_out="$(run_suite)" || fail "declared fixture suite failed: $declared_out"
assert_one_summary "$declared_out"
declared_summary="$(summary_from "$declared_out")"
case "$declared_summary" in
  "smoke-all: tested-tree="*"; declared-skips=2 skip-files=1 — ok — all 1 files passed "*) ;;
  *) fail "declared census was absent or quotable before accounting: $declared_summary" ;;
esac
printf '%s\n' "$declared_out" | awk -v path="$WORKER_REL" '
  $0 == "=== DECLARED SKIP " path " ===" { header++; in_block=1; next }
  in_block && $0 == "SMOKE-SKIP: fixture capability unavailable" { first++ }
  in_block && $0 == "SMOKE-SKIP: second fixture capability unavailable" { second++ }
  END { exit !(header == 1 && first == 1 && second == 1) }
' || fail "declared receipt block was missing, duplicated, or detached from its marker: $declared_out"
echo "suite-skip-accounting: (1) declared skip survives aggregate cleanup and stays green: ok"

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
child_log="$(mktemp)"
trap 'rm -f "$child_log"' EXIT
bash -c 'echo "tap product: skipping an expected row" >&2' 2>"$child_log"
grep -Fqx "tap product: skipping an expected row" "$child_log"
echo "accounting-worker: unavailable row is skipped by policy: ok"
echo "accounting-worker: captured child narration is asserted: ok"
echo "PASS suite-skip-accounting"
echo "accounting-worker: ok"
WORKER

zero_out="$(run_suite)" || fail "zero-skip fixture suite failed: $zero_out"
assert_one_summary "$zero_out"
zero_summary="$(summary_from "$zero_out")"
case "$zero_summary" in
  "smoke-all: tested-tree="*"; declared-skips=0 skip-files=0 — ok — all 1 files passed "*) ;;
  *) fail "zero census was absent or misplaced: $zero_summary" ;;
esac
case "$zero_out" in
  *"=== DECLARED SKIP "*) fail "zero-skip run emitted a declared receipt block: $zero_out" ;;
esac
echo "suite-skip-accounting: (2) zero census is explicit without over-firing on success prose: ok"

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "accounting-worker: fixture capability unavailable — skipped"
echo "accounting-worker: should not count as a passing file"
WORKER

if undeclared_out="$(run_suite)"; then
  fail "undeclared skip-shaped output returned green: $undeclared_out"
fi
case "$undeclared_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "undeclared failure omitted its path and class: $undeclared_out" ;;
esac
case "$undeclared_out" in
  *"accounting-worker: fixture capability unavailable — skipped"*"accounting-worker: should not count as a passing file"*) ;;
  *) fail "undeclared failure did not replay the complete worker log: $undeclared_out" ;;
esac
case "$undeclared_out" in
  *"SMOKE-SKIP: <reason>"*) ;;
  *) fail "undeclared failure omitted the declaration remedy: $undeclared_out" ;;
esac
assert_no_green "$undeclared_out" "undeclared failure"
echo "suite-skip-accounting: (3) undeclared exit-zero skip output fails with retained evidence: ok"

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "  SMOKE-SKIP: indented declaration must not pass"
echo "accounting-worker: malformed marker fixture completed"
WORKER

if malformed_out="$(run_suite)"; then
  fail "indented marker returned green: $malformed_out"
fi
case "$malformed_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "indented marker omitted its path and policy class: $malformed_out" ;;
esac
assert_no_green "$malformed_out" "indented marker failure"
echo "suite-skip-accounting: (4) malformed reserved marker fails closed: ok"

# (4b) The reserved prefix WITHOUT a colon evaded every check. The valid-marker
# regex needs the colon, the malformed reserved-prefix rule needs the colon, and
# the general word scan cannot see it because that scan treats the hyphen as
# identifier syntax — `[^[:alnum:]_-]` excludes `-`, so `smoke-skip` has no word
# boundary before `skip`. A worker exiting zero with a malformed declaration
# therefore received a GREEN zero census, which is the one outcome this whole
# change exists to make impossible.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP fixture capability unavailable"
echo "accounting-worker: colon-free marker fixture completed"
WORKER

if nocolon_out="$(run_suite)"; then
  fail "reserved prefix without a colon returned green: $nocolon_out"
fi
case "$nocolon_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "colon-free marker omitted its path and policy class: $nocolon_out" ;;
esac
assert_no_green "$nocolon_out" "colon-free marker failure"

# (4c) Same hole with a detached colon. `SKIP :` does not match `SKIP:` either.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP : fixture capability unavailable"
echo "accounting-worker: detached-colon marker fixture completed"
WORKER

if spaced_out="$(run_suite)"; then
  fail "reserved prefix with a detached colon returned green: $spaced_out"
fi
case "$spaced_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "detached-colon marker omitted its path and policy class: $spaced_out" ;;
esac
assert_no_green "$spaced_out" "detached-colon marker failure"

# (4d) THE INVERSE, and it is what keeps the colon-free rule bounded. The new
# check is ANCHORED at line start, exactly like the valid-marker regex it
# complements, so a mid-line occurrence of the bare prefix must not fire it. A
# valid declaration alongside such a mention stays a GREEN single-skip file.
#
# A mid-line `SMOKE-SKIP:` WITH a colon is pinned below in (4e) (tap-q949).
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP: fixture capability unavailable"
echo "accounting-worker: the reserved SMOKE_SKIP prefix mid-line must not redden this file"
WORKER

mention_out="$(run_suite)" || fail "a mention of the marker reddened a validly declared skip: $mention_out"
case "$mention_out" in
  *"declared-skips=1"*) ;;
  *) fail "mention case did not count exactly one declared skip: $mention_out" ;;
esac
echo "suite-skip-accounting: (4b-4d) colon-free and detached-colon prefixes fail closed; mid-line mentions do not over-fire: ok"

# (4e) tap-q949: the colon form of the same inverse. A passing worker that merely
# MENTIONS `SMOKE-SKIP:` mid-line -- the suite's own remediation text does exactly
# this -- stays GREEN with a zero skip census; the line-start rules own declarations.
# The mention avoids the bare word "skip" on purpose: the general word scan flags
# that word independently, and this arm pins only the reserved-prefix rule.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "note: emit SMOKE-SKIP: <reason> when a dependency is absent"
echo "accounting-worker: mid-line reserved prefix with a colon must not redden this file"
WORKER

midline_out="$(run_suite)" || fail "a mid-line mention of SMOKE-SKIP: reddened a passing worker: $midline_out"
case "$midline_out" in
  *"declared-skips=0"*) ;;
  *) fail "mid-line mention case did not report a zero declared-skip census: $midline_out" ;;
esac
assert_one_summary "$midline_out"

# Its other polarity, in the same shape: a malformed declaration at LINE START
# (prefix, no colon) still reddens as undeclared skip output.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP fixture capability unavailable; note: emit SMOKE-SKIP: <reason> to declare one"
echo "accounting-worker: line-start malformed marker beside a mid-line mention completed"
WORKER

if midline_bad_out="$(run_suite)"; then
  fail "a line-start malformed marker beside a mid-line mention returned green: $midline_bad_out"
fi
case "$midline_bad_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "line-start malformed marker omitted its path and policy class: $midline_bad_out" ;;
esac
assert_no_green "$midline_bad_out" "line-start malformed marker"
echo "suite-skip-accounting: (4e) a mid-line SMOKE-SKIP: mention stays green; a line-start malformed marker still reds: ok"

# A failed worker still has a real declared skip. The receipt must retain that
# fact: a zero count would otherwise claim the relocated check never ran.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-SKIP: fixture capability unavailable before failure"
echo "accounting-worker: intentional failure after declared skip"
exit 1
WORKER

if failing_declared_out="$(run_suite)"; then
  fail "declared skip followed by worker failure returned green: $failing_declared_out"
fi
case "$failing_declared_out" in
  *"=== FAIL $WORKER_REL (exit 1) ==="*) ;;
  *) fail "failing declared worker omitted its failing-file evidence: $failing_declared_out" ;;
esac
case "$failing_declared_out" in
  *"=== DECLARED SKIP $WORKER_REL ==="*"SMOKE-SKIP: fixture capability unavailable before failure"*) ;;
  *) fail "failing declared worker dropped its declared-skip receipt: $failing_declared_out" ;;
esac
case "$failing_declared_out" in
  *"declared-skips=1 skip-files=1 — 1/1 FAILED, 0 passed"*) ;;
  *) fail "failing declared worker dropped its receipt accounting: $failing_declared_out" ;;
esac
echo "suite-skip-accounting: (5) declared skip survives a worker failure: ok"

# A recorder failure on a worker that already failed cannot safely claim a
# numeric census. It keeps the ordinary failure, but makes the census unknown.
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
"$PY" - "$FIXTURE/scripts/smoke-all.sh" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '''    record_declared_skip "$rel" "$log" || skip_accounting_incomplete=1'''
new = '''    false || skip_accounting_incomplete=1 # force only the failing-worker recorder to fail'''
if text.count(old) != 1:
    raise SystemExit("expected exactly one failing-worker recorder for mutation")
path.write_text(text.replace(old, new, 1))
PY
[ "$(grep -Fxc '    false || skip_accounting_incomplete=1 # force only the failing-worker recorder to fail' "$FIXTURE/scripts/smoke-all.sh")" = 1 ] \
  || fail "failing-worker recorder mutant was not injected into the executed runner"
if failing_scan_out="$(run_suite)"; then
  fail "failing-worker recorder error returned green: $failing_scan_out"
fi
case "$failing_scan_out" in
  *"=== FAIL $WORKER_REL (exit 1) ==="*) ;;
  *) fail "failing-worker recorder error changed its ordinary failure: $failing_scan_out" ;;
esac
case "$failing_scan_out" in
  *"declared-skips=unknown skip-files=unknown — 1/1 FAILED, 0 passed"*) ;;
  *) fail "failing-worker recorder error left a numeric skip census: $failing_scan_out" ;;
esac
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
echo "suite-skip-accounting: (6) failing-worker recorder errors make the census unknown: ok"

# Fault the copied runner's marker scanner directly. Input bytes and file modes
# vary across awk implementations and process privileges; command failure does
# not, and it exercises the same fail-closed accounting path.
"$PY" - "$FIXTURE/scripts/smoke-all.sh" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '''  if ! marker_count="$(awk '/^SMOKE-SKIP: [^[:space:]]/{count++} END{print count+0}' "$log")"; then'''
new = '''  if ! marker_count="$(false)"; then'''
if text.count(old) != 1:
    raise SystemExit("expected exactly one marker scanner for fault injection")
path.write_text(text.replace(old, new, 1))
PY

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "accounting-worker: scanner failure fixture completed"
WORKER

if scan_error_out="$(run_suite)"; then
  fail "skip-log scanner error returned green: $scan_error_out"
fi
case "$scan_error_out" in
  *"=== FAIL $WORKER_REL (skip accounting error) ==="*) ;;
  *) fail "scanner failure omitted its path and policy class: $scan_error_out" ;;
esac
case "$scan_error_out" in
  *"could not classify its retained log"*) ;;
  *) fail "scanner failure omitted its diagnostic: $scan_error_out" ;;
esac
assert_no_green "$scan_error_out" "scanner failure"
echo "suite-skip-accounting: (7) skip-log scanner errors fail closed: ok"

# Causal control for the failing-file path: removing only its marker recorder
# must make this fixture's new arm red rather than leave a passing control.
FAIL_SCAN_MUTANT="$WORK/failure-scan-disabled.sh"
cp "$SMOKE_ALL" "$FAIL_SCAN_MUTANT"
"$PY" - "$FAIL_SCAN_MUTANT" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '''    record_declared_skip "$rel" "$log" || skip_accounting_incomplete=1'''
new = '''    : # failure-ledger marker scan disabled by control mutant'''
if text.count(old) != 1:
    raise SystemExit("expected exactly one failing-file marker recorder for mutation")
path.write_text(text.replace(old, new, 1))
PY
[ "$(grep -Fxc '    : # failure-ledger marker scan disabled by control mutant' "$FAIL_SCAN_MUTANT")" = 1 ] \
  || fail "failure-ledger marker-scan mutant was not injected into the runner under test"

if failure_scan_mutant_out="$(SMOKE_ALL_UNDER_TEST="$FAIL_SCAN_MUTANT" bash "${BASH_SOURCE[0]}" 2>&1)"; then
  fail "failure-ledger marker-scan mutant passed the accounting fixture: $failure_scan_mutant_out"
fi
case "$failure_scan_mutant_out" in
  *"failing declared worker dropped its declared-skip receipt"*) ;;
  *) fail "failure-ledger marker-scan mutant did not red through the new arm: $failure_scan_mutant_out" ;;
esac
echo "suite-skip-accounting: (8) failure-ledger marker scan mutation is detected: ok"

# (9) SMOKE-RECEIPT: a passing file's declared proof line outlives its log, with
# its source file; the rest of its stdout does not, and the census line CI parses
# keeps its format.
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
WORKER_B_REL="skills/tap/scripts/smoke/accounting-worker-b.test.sh"
WORKER_B="$FIXTURE/$WORKER_B_REL"
receipt_block() { # <output> <relative path>: the lines under that file's receipt header
  printf '%s\n' "$1" | awk -v header="=== SMOKE RECEIPT $2 ===" '
    $0 == header { in_block=1; next }
    in_block && ($0 == "" || /^=== /) { in_block=0 }
    in_block'
}
# Worker A's receipt carries a tab and payloads shaped like other runner
# vocabulary; none may be read as that vocabulary. Its unprefixed continuation
# and indented or mid-line mentions are ordinary stdout.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "accounting-worker: ordinary chatter that must not be retained"
printf 'SMOKE-RECEIPT: accounting-worker: tab\there; SMOKE-SKIP: embedded; smoke-all: tested-tree=x — ok — all 9 files passed (0s, -j 1)\n'
echo "continuation without a prefix must not be retained"
echo "  SMOKE-RECEIPT: indented lines are not declarations"
echo "note: emit SMOKE-RECEIPT: <proof> to retain a line"
echo "accounting-worker: ok"
WORKER
cat >"$WORKER_B" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-RECEIPT: accounting-worker-b: second file's proof"
echo "accounting-worker-b: ok"
WORKER
chmod +x "$WORKER_B"

SUITE_JOBS=2
receipt_out="$(run_suite)" || fail "receipt fixture suite failed: $receipt_out"
SUITE_JOBS=1
assert_one_summary "$receipt_out"
case "$(summary_from "$receipt_out")" in
  "smoke-all: tested-tree="*"; declared-skips=0 skip-files=0 — ok — all 2 files passed "*", -j 2)") ;;
  *) fail "a receipt changed the terminal census format: $receipt_out" ;;
esac
[ "$(receipt_block "$receipt_out" "$WORKER_REL")" = "$(printf 'SMOKE-RECEIPT: accounting-worker: tab\there; SMOKE-SKIP: embedded; smoke-all: tested-tree=x — ok — all 9 files passed (0s, -j 1)')" ] \
  || fail "worker A's receipt block was wrong or carried other lines: $receipt_out"
[ "$(receipt_block "$receipt_out" "$WORKER_B_REL")" = "SMOKE-RECEIPT: accounting-worker-b: second file's proof" ] \
  || fail "worker B's receipt block was wrong or crossed files: $receipt_out"
[ "$(printf '%s\n' "$receipt_out" | grep -c '^=== SMOKE RECEIPT ')" = 2 ] \
  || fail "expected exactly one receipt block per declaring file: $receipt_out"
case "$receipt_out" in
  *"ordinary chatter that must not be retained"* | *"continuation without a prefix"* | *"indented lines are not declarations"* | *"to retain a line"*)
    fail "a receipt run retained undeclared stdout: $receipt_out" ;;
esac

# An unprefixed continuation that reads as a skip still reds under the existing
# policy, and the receipt above it is not ledgered beside the replayed log.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-RECEIPT: accounting-worker: proof with a bad continuation"
echo "continuation: fixture capability unavailable — skipped"
WORKER
rm -f "${WORKER_B:?}"
if continuation_out="$(run_suite)"; then
  fail "a skip-shaped continuation after a receipt returned green: $continuation_out"
fi
case "$continuation_out" in
  *"=== FAIL $WORKER_REL (undeclared skip output) ==="*) ;;
  *) fail "a skip-shaped continuation lost its undeclared-skip failure: $continuation_out" ;;
esac
case "$continuation_out" in
  *"=== SMOKE RECEIPT "*) fail "a red file's receipt was ledgered beside its replayed log: $continuation_out" ;;
esac
assert_no_green "$continuation_out" "skip-shaped continuation"

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "accounting-worker: ordinary chatter only: ok"
WORKER
bare_out="$(run_suite)" || fail "no-receipt fixture suite failed: $bare_out"
case "$bare_out" in
  *"=== SMOKE RECEIPT "*) fail "a file with no receipt added a receipt block: $bare_out" ;;
esac

cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-RECEIPT: accounting-worker: proof before failure"
echo "accounting-worker: intentional failure after a receipt"
exit 1
WORKER
if failing_receipt_out="$(run_suite)"; then
  fail "failing receipt fixture returned green: $failing_receipt_out"
fi
case "$failing_receipt_out" in
  *"=== FAIL $WORKER_REL (exit 1) ==="*"SMOKE-RECEIPT: accounting-worker: proof before failure"*"accounting-worker: intentional failure after a receipt"*) ;;
  *) fail "a failing file's FAIL block changed: $failing_receipt_out" ;;
esac
case "$failing_receipt_out" in
  *"=== SMOKE RECEIPT "*) fail "a failing file's receipt was ledgered beside its replayed log: $failing_receipt_out" ;;
esac
[ "$(printf '%s\n' "$failing_receipt_out" | grep -Fc 'SMOKE-RECEIPT: accounting-worker: proof before failure')" = 1 ] \
  || fail "a failing file's receipt line was duplicated: $failing_receipt_out"

# Causal control: dropping only the ledger replay must lose the line the arm
# above requires. The mutant runs through the same fixture, not the whole file.
cat >"$WORKER" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
echo "SMOKE-RECEIPT: accounting-worker: mutant detected (baseline exit 0, mutant exit 1)"
echo "accounting-worker: ok"
WORKER
"$PY" - "$FIXTURE/scripts/smoke-all.sh" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '''  cat "$PROOF_RECEIPTS"
'''
new = '''  : # proof-receipt replay disabled by control mutant
'''
if text.count(old) != 1:
    raise SystemExit("expected exactly one proof-receipt replay for mutation")
path.write_text(text.replace(old, new, 1))
PY
[ "$(grep -Fc '# proof-receipt replay disabled by control mutant' "$FIXTURE/scripts/smoke-all.sh")" = 1 ] \
  || fail "proof-receipt replay mutant was not injected into the executed runner"
dropped_out="$(run_suite)" || fail "proof-receipt replay mutant fixture failed: $dropped_out"
case "$dropped_out" in
  *"SMOKE-RECEIPT: accounting-worker: mutant detected"*) fail "dropping the receipt replay left the line in the output; the arm above cannot see it: $dropped_out" ;;
esac
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
echo "suite-skip-accounting: (9) a passing file's SMOKE-RECEIPT line is retained with its file; chatter is not; a failing file's block is unchanged: ok"

echo "PASS suite-skip-accounting"
