#!/usr/bin/env bash
# receipt-preflight.test.sh — proves scripts/check-receipt.sh discriminates.
#
# The checker refuses a receipt claim that cannot be true (charter rule 76
# class: the fleet shipped a dirty receipt cited as "at head", a fabricated
# 40-char dispatch ref, a tree from before a branch split). This file is the
# guard on the guard. Discipline:
#   - Every RED fixture carries exactly ONE defect against the GREEN baseline
#     built in this file, and its arm pins BOTH nonzero exit AND the output
#     naming the failing FIELD (rule 75: a red that cannot say which field
#     fired has not been tested).
#   - Every recognition boundary has negatives on BOTH sides: prose mentioning
#     head= and a partial receipt line must be refused as unparseable (rule 73:
#     with only positives, "recognises every valid receipt" and "matches any
#     line mentioning head=" are indistinguishable).
#   - Every gate-log refusal path gets its own one-defect arm: missing
#     capture-exit (with raw present), missing raw-exit (with capture present),
#     FAILing verdict, missing verdict line, non-success conclusion, mismatched
#     requested-tested-ref, mismatched tested-head, near-miss worktree
#     ("cleaned"), embedded-receipt head mismatch, embedded-receipt tree
#     mismatch, nonzero capture-exit under a PASS verdict (impossible receipt:
#     the production comparator refuses nonzero capture before emitting PASS),
#     and the claim-refusal itself (a fabricated 40-hex claim must fail as a
#     claim, never verify against nothing — the rule-66 specimen).
#     Baseline-covered raw-exit=1 under a PASS verdict is a GREEN arm, not a
#     refusal: that is the legitimate differential pass the verdict authority
#     exists to admit.
#
# All fixtures derive from THIS checkout's own rev-parse values, so the suite
# is deterministic in any checkout and every claim resolves (the checker
# refuses unresolvable claims by design). The real-run evidence (run
# 35174472570, live --gate-run) lives in the PR body, not here: the suite must
# not depend on network or on objects a fresh clone may not have.
#
# Arms (name = body; this list is the rule-75 read pass):
#   green_local_receipt_from_this_checkouts_head_passes
#   red_dirty_receipt_names_worktree
#   red_mismatched_head_names_head
#   red_mismatched_tree_names_tree
#   red_fabricated_claim_names_claim
#   negative_prose_mentioning_head_is_not_a_receipt
#   negative_partial_receipt_line_is_not_a_receipt
#   green_gate_log_built_from_this_checkouts_head_passes
#   green_baseline_covered_gate_failure_passes_when_verdict_passes
#   spoofed_suite_exit_line_is_reported_from_the_workflow_not_the_suite
#   red_gate_log_without_capture_exit_names_capture_exit
#   red_gate_log_with_nonzero_capture_exit_names_capture_exit
#   red_gate_log_without_raw_exit_names_raw_exit
#   red_gate_log_with_failing_verdict_names_verdict
#   red_gate_log_without_a_verdict_line_names_verdict
#   red_gate_log_with_cancelled_conclusion_names_conclusion
#   red_gate_log_with_mismatched_requested_ref_names_tested_ref
#   red_gate_log_of_other_head_names_head
#   red_gate_log_with_cleaned_worktree_names_worktree
#   red_gate_log_with_embedded_receipt_of_other_head_names_head
#   red_gate_log_with_embedded_tree_mismatch_names_tree
#
# Gate-exit authority (review round 1): the differential verdict line
# is the authority — raw-exit=1 under `Gate verdict: PASS` is a legitimate
# baseline-covered pass, while a FAILing or missing verdict refuses however
# green the exits look. Exit/verdict fields are read from their LAST
# occurrence (the workflow emits them after the suite ends), so the spoof arm
# — a suite-echoed fake raw-exit=0 preceding the workflow's raw-exit=1 — must
# be REPORTED from the workflow's line, never the suite's.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CHECKER="$ROOT/scripts/check-receipt.sh"
[ -x "$CHECKER" ] || { echo "receipt-preflight: checker missing or not executable: $CHECKER" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CLAIM="$(git -C "$ROOT" rev-parse HEAD)"
TREE="$(git -C "$ROOT" rev-parse HEAD^{tree})"
OTHER="0000000000000000000000000000000000000000"  # deterministic non-claim 40-hex

# baseline local receipt: this checkout's real values, worktree=clean.
receipt_line() { # [worktree] [head] [tree]
  printf 'regress-one: tested-tree=%s head=%s worktree=%s; known-defect: 0; declared-skips=0 skip-files=0 — ok — all 1 files passed (18s, -j 8)\n' \
    "${3:-$TREE}" "${2:-$CLAIM}" "${1:-clean}"
}

# baseline gate log: production field spellings, this checkout's real values.
gate_log() { # [tested-head] [tested-tree] [requested-ref] [raw] [capture] [embedded-head] [embedded-tree] [embedded-worktree] [verdict]
  cat <<EOF
requested-tested-ref=${3:-${1:-$CLAIM}}
tested-head=${1:-$CLAIM}
tested-tree=${2:-$TREE}
raw-exit=${4:-0}
capture-exit=${5:-0}
smoke-all: tested-tree=${7:-$TREE} head=${6:-${1:-$CLAIM}} worktree=${8:-clean}; local origin/main (freshness caller-owned): behind=0; known-defect: 0; declared-skips=0 skip-files=0 — ok — all 1 files passed (18s, -j 8)
Gate verdict: ${9:-PASS}
EOF
}

expect_red() { # <field> <file> <args...>: nonzero exit AND output names the field
  _field="$1"; shift
  _stdin_file="$1"; shift
  _out="$WORK/out.$$"
  set +e
  _rc=0
  "$CHECKER" "$@" < "$_stdin_file" > "$_out" 2>&1 || _rc=$?
  set -e
  [ "$_rc" -ne 0 ] || { echo "receipt-preflight: expected nonzero exit (red field=$_field) but checker exited 0:" >&2; cat "$_out" >&2; exit 1; }
  grep -q "FAIL $_field" "$_out" || { echo "receipt-preflight: expected the failure to name FIELD=$_field; output was:" >&2; cat "$_out" >&2; exit 1; }
  rm -f "$_out"
}

expect_green() { # <file> <args...>: exit 0 AND an OK line
  _stdin_file="$1"; shift
  _out="$WORK/out.$$"
  set +e
  "$CHECKER" "$@" < "$_stdin_file" > "$_out" 2>&1
  _rc=$?
  set -e
  [ "$_rc" -eq 0 ] || { echo "receipt-preflight: expected exit 0 (green) but checker exited $_rc:" >&2; cat "$_out" >&2; exit 1; }
  grep -q 'check-receipt: OK' "$_out" || { echo "receipt-preflight: green run did not print an OK line:" >&2; cat "$_out" >&2; exit 1; }
  rm -f "$_out"
}

# --- green: local receipt built from this checkout's own values ---------------
echo "receipt-preflight: arm green_local_receipt_from_this_checkouts_head_passes"
receipt_line > "$WORK/green.txt"
expect_green "$WORK/green.txt" --claim "$CLAIM" --receipt "$WORK/green.txt"

# --- red: dirty receipt names worktree ----------------------------------------
echo "receipt-preflight: arm red_dirty_receipt_names_worktree"
receipt_line dirty > "$WORK/dirty.txt"
expect_red worktree "$WORK/dirty.txt" --claim "$CLAIM" --receipt "$WORK/dirty.txt"

# --- red: mismatched head names head ------------------------------------------
echo "receipt-preflight: arm red_mismatched_head_names_head"
receipt_line clean "$OTHER" > "$WORK/otherhead.txt"
expect_red head "$WORK/otherhead.txt" --claim "$CLAIM" --receipt "$WORK/otherhead.txt"

# --- red: mismatched tree names tree -------------------------------------------
echo "receipt-preflight: arm red_mismatched_tree_names_tree"
receipt_line clean "$CLAIM" "$OTHER" > "$WORK/othertree.txt"
expect_red tree "$WORK/othertree.txt" --claim "$CLAIM" --receipt "$WORK/othertree.txt"

# --- red: fabricated 40-hex claim fails as a claim (rule 66 specimen) ----------
echo "receipt-preflight: arm red_fabricated_claim_names_claim"
receipt_line > "$WORK/goodclaim.txt"
expect_red claim "$WORK/goodclaim.txt" --claim "$OTHER" --receipt "$WORK/goodclaim.txt"

# --- negative: prose mentioning head= is not a receipt --------------------------
echo "receipt-preflight: arm negative_prose_mentioning_head_is_not_a_receipt"
printf 'the head=%s was fine per the receipt discussion\n' "$CLAIM" > "$WORK/prose.txt"
expect_red parse "$WORK/prose.txt" --claim "$CLAIM" --receipt "$WORK/prose.txt"

# --- negative: partial receipt line is not a receipt ----------------------------
echo "receipt-preflight: arm negative_partial_receipt_line_is_not_a_receipt"
printf 'regress-one: head=%s worktree=clean; — ok\n' "$CLAIM" > "$WORK/partial.txt"
expect_red parse "$WORK/partial.txt" --claim "$CLAIM" --receipt "$WORK/partial.txt"

# --- green: gate log built from this checkout's own values ----------------------
echo "receipt-preflight: arm green_gate_log_built_from_this_checkouts_head_passes"
gate_log > "$WORK/gate-green.txt"
expect_green "$WORK/gate-green.txt" --claim "$CLAIM" --gate-log "$WORK/gate-green.txt" --conclusion success

# --- green: baseline-covered failure passes when the verdict says PASS ----------
echo "receipt-preflight: arm green_baseline_covered_gate_failure_passes_when_verdict_passes"
gate_log "$CLAIM" "$TREE" "$CLAIM" 1 0 "" "" "" PASS > "$WORK/gate-baseline.txt"
expect_green "$WORK/gate-baseline.txt" --claim "$CLAIM" --gate-log "$WORK/gate-baseline.txt" --conclusion success

# --- spoof: suite-echoed fake raw-exit must not override the workflow's value ---
echo "receipt-preflight: arm spoofed_suite_exit_line_is_reported_from_the_workflow_not_the_suite"
{ printf 'raw-exit=0\n'; gate_log "$CLAIM" "$TREE" "$CLAIM" 1 0 "" "" "" PASS; } > "$WORK/gate-spoof.txt"
_out="$WORK/spoof-out.txt"
set +e
"$CHECKER" --claim "$CLAIM" --gate-log "$WORK/gate-spoof.txt" --conclusion success > "$_out" 2>&1
_rc=$?
set -e
[ "$_rc" -eq 0 ] || { echo "receipt-preflight: baseline-covered spoof arm should pass on the workflow's values:" >&2; cat "$_out" >&2; exit 1; }
grep -q 'raw-exit=1' "$_out" || { echo "receipt-preflight: the reported raw-exit must be the workflow's (1), not the suite-echoed fake (0):" >&2; cat "$_out" >&2; exit 1; }
grep -q 'raw-exit=0' "$_out" && { echo "receipt-preflight: the OK line echoed the suite-echoed fake raw-exit=0:" >&2; cat "$_out" >&2; exit 1; }
rm -f "$_out"

# --- red: gate log without capture-exit (raw present) names capture-exit --------
echo "receipt-preflight: arm red_gate_log_without_capture_exit_names_capture_exit"
gate_log | grep -v '^capture-exit=' > "$WORK/gate-nocap.txt"
expect_red capture-exit "$WORK/gate-nocap.txt" --claim "$CLAIM" --gate-log "$WORK/gate-nocap.txt" --conclusion success

# --- red: nonzero capture under a PASS verdict names capture-exit ---------------
# Internally impossible receipt: the production comparator refuses every
# nonzero capture before it can emit PASS. The baseline-covered raw-exit=1
# arm above stays green — raw and capture have opposite polarities here.
echo "receipt-preflight: arm red_gate_log_with_nonzero_capture_exit_names_capture_exit"
gate_log "$CLAIM" "$TREE" "$CLAIM" 0 1 "" "" "" PASS > "$WORK/gate-capfail.txt"
expect_red capture-exit "$WORK/gate-capfail.txt" --claim "$CLAIM" --gate-log "$WORK/gate-capfail.txt" --conclusion success

# --- red: gate log without raw-exit names raw-exit -------------------------------
echo "receipt-preflight: arm red_gate_log_without_raw_exit_names_raw_exit"
gate_log | grep -v '^raw-exit=' > "$WORK/gate-noraw.txt"
expect_red raw-exit "$WORK/gate-noraw.txt" --claim "$CLAIM" --gate-log "$WORK/gate-noraw.txt" --conclusion success

# --- red: FAILing verdict names verdict ------------------------------------------
echo "receipt-preflight: arm red_gate_log_with_failing_verdict_names_verdict"
gate_log "$CLAIM" "$TREE" "$CLAIM" 1 0 "" "" "" FAIL > "$WORK/gate-vfail.txt"
expect_red verdict "$WORK/gate-vfail.txt" --claim "$CLAIM" --gate-log "$WORK/gate-vfail.txt" --conclusion success

# --- red: missing verdict line names verdict --------------------------------------
echo "receipt-preflight: arm red_gate_log_without_a_verdict_line_names_verdict"
gate_log | grep -v '^Gate verdict:' > "$WORK/gate-noverdict.txt"
expect_red verdict "$WORK/gate-noverdict.txt" --claim "$CLAIM" --gate-log "$WORK/gate-noverdict.txt" --conclusion success

# --- red: non-success conclusion names conclusion (the cancelled-run shape) -------
echo "receipt-preflight: arm red_gate_log_with_cancelled_conclusion_names_conclusion"
gate_log > "$WORK/gate-cancelled.txt"
expect_red conclusion "$WORK/gate-cancelled.txt" --claim "$CLAIM" --gate-log "$WORK/gate-cancelled.txt" --conclusion cancelled

# --- red: mismatched requested-tested-ref names tested_ref ----------------------
echo "receipt-preflight: arm red_gate_log_with_mismatched_requested_ref_names_tested_ref"
gate_log "$CLAIM" "$TREE" "$OTHER" > "$WORK/gate-ref.txt"
expect_red tested_ref "$WORK/gate-ref.txt" --claim "$CLAIM" --gate-log "$WORK/gate-ref.txt" --conclusion success

# --- red: gate log of another head names head -----------------------------------
echo "receipt-preflight: arm red_gate_log_of_other_head_names_head"
gate_log "$OTHER" > "$WORK/gate-otherhead.txt"
expect_red head "$WORK/gate-otherhead.txt" --claim "$CLAIM" --gate-log "$WORK/gate-otherhead.txt" --conclusion success

# --- red: near-miss worktree spelling ("cleaned") names worktree ----------------
echo "receipt-preflight: arm red_gate_log_with_cleaned_worktree_names_worktree"
gate_log "$CLAIM" "$TREE" "$CLAIM" 0 0 "$CLAIM" "$TREE" cleaned PASS > "$WORK/gate-cleaned.txt"
expect_red worktree "$WORK/gate-cleaned.txt" --claim "$CLAIM" --gate-log "$WORK/gate-cleaned.txt" --conclusion success

# --- red: embedded suite receipt of another head names head ---------------------
echo "receipt-preflight: arm red_gate_log_with_embedded_receipt_of_other_head_names_head"
gate_log "$CLAIM" "$TREE" "$CLAIM" 0 0 "$OTHER" "$TREE" > "$WORK/gate-embedhead.txt"
expect_red head "$WORK/gate-embedhead.txt" --claim "$CLAIM" --gate-log "$WORK/gate-embedhead.txt" --conclusion success

# --- red: embedded receipt tree disagreeing with the summary names tree ---------
echo "receipt-preflight: arm red_gate_log_with_embedded_tree_mismatch_names_tree"
gate_log "$CLAIM" "$TREE" "$CLAIM" 0 0 "$CLAIM" "$OTHER" > "$WORK/gate-embedtree.txt"
expect_red tree "$WORK/gate-embedtree.txt" --claim "$CLAIM" --gate-log "$WORK/gate-embedtree.txt" --conclusion success

echo "receipt-preflight: ok"
