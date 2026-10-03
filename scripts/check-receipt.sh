#!/usr/bin/env bash
# check-receipt.sh — refuse a receipt claim that cannot be true (charter rule 76 class).
#
# A receipt is evidence only if it is internally consistent AND matches the claim
# being made about it. Tonight's fleet specimens: a PR body citing runs "at head"
# whose receipts read head=<other> worktree=dirty (tap-j7zi1 half 2);
# a fabricated 40-char dispatch ref; a tree quoted from before a
# branch split; a gate run whose receipt said tested-tree=uncommitted. Every one
# was well-formed and plausible. This tool owns that check so a reviewer's
# attention does not have to.
#
# Usage:
#   check-receipt.sh --claim <gitrev> --receipt <file|->      # smoke/regress receipt lines
#   check-receipt.sh --claim <gitrev> --gate-log <file>       # captured full-gate log
#   check-receipt.sh --claim <gitrev> --gate-run <id|url>     # live run via gh (network)
#       [--repo <owner/name>]                                 # default: this checkout's origin owner/name
#
# What it asserts, per cited receipt:
#   1. worktree=clean. A dirty-tree receipt cannot support an at-head claim, ever.
#   2. The receipt's head EQUALS the claimed head. Not "is an ancestor of"; equals.
#      The claim is resolved through `git rev-parse --verify` (charter rule 66:
#      derive, never type). EVERY claim must resolve to a commit in this
#      checkout — a fabricated 40-hex literal is the exact defect this tool
#      refuses, so there is no literal mode and no cross-clone support.
#   3. For a gate log: raw-exit and capture-exit must be PRESENT (read, not
#      inferred) and the differential VERDICT line must be present and say
#      PASS — the verdict line is the authority, so a baseline-covered failure
#      (raw-exit=1 under `Gate verdict: PASS`) is a pass, while a FAILing or
#      missing verdict refuses no matter what the exits say.
#   4. The tested tree is reported alongside the head and must equal the
#      claim's actual tree (the split-branch shape). The embedded smoke-all
#      suite receipt is parsed as a receipt and bound to the gate identity:
#      its worktree must be exactly "clean" (a near-miss spelling is not
#      clean) and its head/tree must agree with the summary fields and the
#      claim — a composite log whose summary and suite receipt disagree
#      refuses.
#
# Spoof resistance (the channel the subject under test can write to): a gate
# log mixes workflow-emitted lines with suite stdout, and the suite can print
# anything. Fields are therefore read POSITIONALLY — the revision fields from
# their first occurrence (emitted by Record revisions BEFORE the suite runs)
# and the exit/verdict fields from their LAST occurrence (emitted by the
# workflow AFTER the suite ends) — so a suite-echoed fake raw-exit or verdict
# cannot override the workflow's own values. The reported raw-exit is the
# workflow's line even when a fake precedes it.
#
# Snapshot honesty: --gate-log is a snapshot mode and must state the run's
# conclusion explicitly via --conclusion <word> (the checker refuses to guess
# whether the run finished); anything but "success" refuses. --gate-run
# derives status/conclusion from gh itself.
#
# Recognition boundary (the negative-pair contract): a LOCAL receipt is a line
# carrying ALL THREE of tested-tree=<40hex>, head=<40hex>, worktree=<word> —
# the smoke-all.sh / regress-all.sh terminal shape. A line carrying only some of
# them (prose that mentions head=, a summary line, a PR template fragment) is
# NOT a receipt: the tool refuses it as unparseable instead of validating it.
# Gate-log fields are the spellings the full-gate actually emits as of run
# 35174472570: requested-tested-ref=, tested-head=, tested-tree=, raw-exit=,
# capture-exit=, plus the embedded smoke-all receipt line for worktree=.
#
# Output contract: every refusal is "check-receipt: FAIL <field> — <reason>" on
# stderr with exit 1; success is "check-receipt: OK ..." on stdout with exit 0.
# The <field> token is the assertion's name — a red that cannot say which field
# fired has not been tested (charter rule 75 class).

set -uo pipefail

# Default to this script's checkout's origin owner/name, so a fork or a public
# mirror verifies against its own repository; --repo overrides.
REPO="$(git -C "$(dirname "$0")" remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^(git@github\.com:|https://github\.com/|ssh://git@github\.com/)##' || true)"
CLAIM=""
RECEIPT_FILE=""
GATE_LOG_FILE=""
GATE_RUN=""
CONCLUSION=""

fail() {
  echo "check-receipt: FAIL $1 — $2" >&2
  exit 1
}

usage_fail() {
  echo "check-receipt: FAIL usage — $1" >&2
  echo "usage: check-receipt.sh --claim <gitrev> (--receipt <file|-> | --gate-log <file> --conclusion <word> | --gate-run <id|url> [--repo owner/name])" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --claim) [ "$#" -ge 2 ] || usage_fail "--claim needs a value"; CLAIM="$2"; shift 2 ;;
    --receipt) [ "$#" -ge 2 ] || usage_fail "--receipt needs a value"; RECEIPT_FILE="$2"; shift 2 ;;
    --gate-log) [ "$#" -ge 2 ] || usage_fail "--gate-log needs a value"; GATE_LOG_FILE="$2"; shift 2 ;;
    --gate-run) [ "$#" -ge 2 ] || usage_fail "--gate-run needs a value"; GATE_RUN="$2"; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || usage_fail "--repo needs a value"; REPO="$2"; shift 2 ;;
    --conclusion) [ "$#" -ge 2 ] || usage_fail "--conclusion needs a value"; CONCLUSION="$2"; shift 2 ;;
    *) usage_fail "unknown argument '$1'" ;;
  esac
done

[ -n "$CLAIM" ] || usage_fail "--claim is required"
if [ -z "$RECEIPT_FILE" ] && [ -z "$GATE_LOG_FILE" ] && [ -z "$GATE_RUN" ]; then
  usage_fail "one of --receipt / --gate-log / --gate-run is required"
fi
if [ "$([ -n "$RECEIPT_FILE" ] && echo 1)$( [ -n "$GATE_LOG_FILE" ] && echo 1)$( [ -n "$GATE_RUN" ] && echo 1)" != "1" ]; then
  usage_fail "give exactly one of --receipt / --gate-log / --gate-run"
fi
[ -z "$CONCLUSION" ] || [ -n "$GATE_LOG_FILE" ] || usage_fail "--conclusion applies only to --gate-log snapshots (--gate-run derives it from gh; receipts have none)"

# Rule 66: derive the claim, never compare a hand-typed string. EVERY claim
# must resolve to a commit in this checkout — a fabricated 40-hex literal is
# the exact defect this tool exists to refuse (the rule-66 specimen), so there
# is no literal mode and no cross-clone support: run the checker inside the
# checkout that owns the claim.
CLAIM_FULL=""
CLAIM_FULL="$(git rev-parse --verify --quiet "${CLAIM}^{commit}" 2>/dev/null)" || CLAIM_FULL=""
[ -n "$CLAIM_FULL" ] || fail claim "claim '$CLAIM' does not resolve to a commit in this checkout — refuse rather than verify against nothing (rule 66: derive it, and run this checker where the claim's object exists)"

# resolve_field <receipt-value> — same literal/resolved treatment for receipt
# heads so a resolved claim is compared to a resolved receipt head.
resolve_sha() {
  if _s="$(git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null)" && [ -n "$_s" ]; then
    printf '%s' "$_s"
  else
    printf '%s' "$1"
  fi
}

# ---- local smoke/regress receipt kind --------------------------------------
# A receipt LINE carries all three fields; anything less is not a receipt.
check_local_receipt() {
  _file="$1"
  if [ "$_file" = "-" ]; then
    _text="$(cat)"
  else
    [ -f "$_file" ] || fail parse "receipt file not found: $_file"
    _text="$(cat "$_file")"
  fi
  _lines="$(printf '%s\n' "$_text" | grep -E 'tested-tree=[0-9a-f]{40}' | grep -E ' head=[0-9a-f]{40}' | grep -E 'worktree=' || true)"
  if [ -z "$_lines" ]; then
    # Distinguish "prose mentioned head= but is not a receipt" from "no head= at all".
    if printf '%s\n' "$_text" | grep -q 'head='; then
      fail parse "input mentions head= but is not a receipt line (needs tested-tree=<40hex>, head=<40hex> and worktree= on ONE line)"
    fi
    fail parse "no receipt line found (expected tested-tree=<40hex>, head=<40hex>, worktree=<word> on one line)"
  fi
  _ctree="$(git rev-parse --verify --quiet "${CLAIM_FULL}^{tree}" 2>/dev/null)" || _ctree=""
  _idx=0
  while IFS= read -r _line; do
    _idx=$((_idx + 1))
    _rtree="$(printf '%s\n' "$_line" | sed -E 's/.*tested-tree=([0-9a-f]{40}).*/\1/')"
    _rhead="$(printf '%s\n' "$_line" | sed -E 's/.*[^-]head=([0-9a-f]{40}).*/\1/')"
    _rwt="$(printf '%s\n' "$_line" | sed -E 's/.*worktree=([a-z-]+).*/\1/')"
    [ "$_rwt" = "clean" ] || fail worktree "receipt line $_idx says worktree=$_rwt — a dirty-tree receipt cannot support an at-head claim"
    [ "$(resolve_sha "$_rhead")" = "$CLAIM_FULL" ] || fail head "receipt line $_idx says head=$_rhead, claimed $CLAIM_FULL — a receipt from another head is not this head's evidence (equality, not ancestry)"
    [ -n "$_ctree" ] || fail tree "could not read $CLAIM_FULL's tree from git — refusing to verify a receipt without it"
    [ "$_rtree" = "$_ctree" ] || fail tree "receipt line $_idx says tested-tree=$_rtree but $CLAIM_FULL's tree is $_ctree — a head quoted with another commit's tree is the split-branch shape"
    echo "check-receipt: OK head=$_rhead tree=$_rtree(verified) worktree=clean claim=$CLAIM_FULL (receipt line $_idx)"
  done <<< "$_lines"
  return 0
}

# ---- full-gate log kind -----------------------------------------------------
# <text> <conclusion> — the conclusion is the caller's stated (or gh-derived)
# workflow conclusion; anything but "success" refuses before any field is read.
check_gate_text() {
  _text="$1"
  _conclusion="$2"
  [ "$_conclusion" = "success" ] || fail conclusion "workflow conclusion is '$_conclusion' — a run that did not complete successfully is not gate evidence, however complete its log looks"
  # Spoof resistance: a gate log mixes workflow-emitted lines with suite stdout,
  # and the suite can print anything. Fields are read POSITIONALLY — revision
  # fields from their FIRST occurrence (Record revisions runs before the suite)
  # and raw-exit / capture-exit / the verdict line from their LAST occurrence
  # (the workflow emits them after the suite ends) — so a suite-echoed fake
  # raw-exit or verdict cannot override the workflow's own values.
  _tref="$(printf '%s\n' "$_text" | sed -n -E 's/.*requested-tested-ref=([0-9a-f]{40}).*/\1/p' | head -1)"
  _thead="$(printf '%s\n' "$_text" | sed -n -E 's/.*tested-head=([0-9a-f]{40}).*/\1/p' | head -1)"
  _ttree="$(printf '%s\n' "$_text" | sed -n -E 's/.*tested-tree=([0-9a-f]{40}).*/\1/p' | head -1)"
  _raw="$(printf '%s\n' "$_text" | sed -n -E 's/.*raw-exit=([0-9]+).*/\1/p' | tail -1)"
  _cap="$(printf '%s\n' "$_text" | sed -n -E 's/.*capture-exit=([0-9]+).*/\1/p' | tail -1)"
  _verdict="$(printf '%s\n' "$_text" | sed -n -E 's/.*Gate verdict: *([A-Za-z]+).*/\1/p' | tail -1)"
  _embedded="$(printf '%s\n' "$_text" | grep -E 'smoke-all: tested-tree=' | head -1)"
  # The embedded suite receipt is parsed AS A RECEIPT and bound to the gate
  # identity — not consulted by substring. A composite log whose summary names
  # the claimed head while its suite receipt names another is internally
  # inconsistent and must refuse.
  [ -n "$_embedded" ] || fail worktree "gate log carries no embedded smoke-all receipt line — without it there is no worktree= evidence at all"
  _e_wt="$(printf '%s\n' "$_embedded" | sed -E 's/.*worktree=([a-z-]+).*/\1/')"
  [ "$_e_wt" = "clean" ] || fail worktree "embedded suite receipt says worktree=$_e_wt — a dirty-tree receipt cannot support an at-head claim (and a near-miss spelling is not clean)"
  [ -n "$_raw" ] || fail raw-exit "gate log never states raw-exit — the workflow's green tick is not a read exit status"
  [ -n "$_cap" ] || fail capture-exit "gate log never states capture-exit — the workflow's green tick is not a read exit status"
  [ -n "$_verdict" ] || fail verdict "gate log states no differential verdict — the workflow's green tick is not a read verdict, and a receipt that never compared against the baseline cannot support a passed-at-head claim"
  [ "$_verdict" = "PASS" ] || fail verdict "gate verdict is $_verdict — only a PASS differential verdict supports a passed-at-head claim (raw-exit=$_raw capture-exit=$_cap are reported, not decisive)"
  # Verdict authority has a boundary: the production comparator refuses every
  # nonzero capture BEFORE it can emit PASS (ci-gate-verdict.py), so
  # capture-exit nonzero under a PASS verdict is an internally impossible
  # receipt — admit it and the checker validates a run the gate never ran.
  # (raw-exit nonzero under PASS is different: that is the legitimate
  # baseline-covered differential pass.)
  [ "$_cap" = "0" ] || fail capture-exit "gate log states capture-exit=$_cap under a PASS verdict — the production comparator refuses every nonzero capture before it can emit PASS, so this receipt is internally impossible"
  [ -n "$_tref" ] || fail tested_ref "gate log states no requested-tested-ref — the dispatch target is unreadable"
  [ -n "$_thead" ] || fail head "gate log states no tested-head"
  [ "$(resolve_sha "$_tref")" = "$(resolve_sha "$_thead")" ] || fail tested_ref "gate log requested-tested-ref=$_tref but tested-head=$_thead — the dispatch asked for one head and certified another"
  [ "$(resolve_sha "$_thead")" = "$CLAIM_FULL" ] || fail head "gate log tested-head=$_thead, claimed $CLAIM_FULL — a gate run of another head is not this head's evidence (equality, not ancestry)"
  _e_head="$(printf '%s\n' "$_embedded" | sed -E 's/.*[^-]head=([0-9a-f]{40}).*/\1/')"
  [ -n "$_e_head" ] || fail head "embedded smoke-all receipt line carries no parseable head"
  [ "$(resolve_sha "$_e_head")" = "$CLAIM_FULL" ] || fail head "embedded suite receipt head=$_e_head, claimed $CLAIM_FULL — the summary and the suite receipt name different heads"
  [ -n "$_ttree" ] || fail tree "gate log states no tested-tree — a head without its tree is the split-branch blind spot"
  _e_tree="$(printf '%s\n' "$_embedded" | sed -E 's/.*tested-tree=([0-9a-f]{40}).*/\1/')"
  [ "$_e_tree" = "$_ttree" ] || fail tree "embedded suite receipt tree=$_e_tree but gate summary tested-tree=$_ttree — the summary and the suite receipt disagree on the tree"
  _ctree="$(git rev-parse --verify --quiet "${CLAIM_FULL}^{tree}" 2>/dev/null)" || _ctree=""
  [ -n "$_ctree" ] || fail tree "could not read $CLAIM_FULL's tree from git — refusing to verify a gate receipt without it"
  [ "$_ttree" = "$_ctree" ] || fail tree "gate log tested-tree=$_ttree but $CLAIM_FULL's tree is $_ctree — the split-branch shape"
  echo "check-receipt: OK tested-head=$_thead tested-tree=$_ttree(verified) requested-tested-ref=$_tref raw-exit=$_raw capture-exit=$_cap verdict=$_verdict worktree=clean claim=$CLAIM_FULL"
  return 0
}

if [ -n "$RECEIPT_FILE" ]; then
  check_local_receipt "$RECEIPT_FILE"
  exit 0
fi

if [ -n "$GATE_LOG_FILE" ]; then
  [ -n "$CONCLUSION" ] || usage_fail "a gate-log snapshot must state the run's conclusion: --conclusion success (the checker refuses to guess whether the run finished)"
  if [ "$GATE_LOG_FILE" = "-" ]; then
    check_gate_text "$(cat)" "$CONCLUSION"
  else
    [ -f "$GATE_LOG_FILE" ] || fail parse "gate log file not found: $GATE_LOG_FILE"
    check_gate_text "$(cat "$GATE_LOG_FILE")" "$CONCLUSION"
  fi
  exit 0
fi

if [ -n "$GATE_RUN" ]; then
  _run_id="$(printf '%s' "$GATE_RUN" | sed -n -E 's#^.*/runs/([0-9]+).*#\1#p')"
  [ -n "$_run_id" ] || _run_id="$(printf '%s' "$GATE_RUN" | sed -n -E 's/^([0-9]+)$/\1/p')"
  [ -n "$_run_id" ] || fail parse "gate run must be a numeric id or a .../runs/<id> URL: $GATE_RUN"
  command -v gh >/dev/null 2>&1 || fail gh "gh is required for --gate-run and was not found"
  _state="$(gh run view "$_run_id" --repo "$REPO" --json status,conclusion 2>/dev/null)" || fail gh "could not read run $_run_id in $REPO"
  _status="$(printf '%s' "$_state" | sed -n -E 's/.*"status" *: *"([^"]*)".*/\1/p')"
  _conc="$(printf '%s' "$_state" | sed -n -E 's/.*"conclusion" *: *"(null|[^"]*)".*/\1/p')"
  [ "$_status" = "completed" ] || fail conclusion "run $_run_id is not completed (status=$_status) — an in-flight or queued run has no receipt yet"
  [ "$_conc" = "success" ] || fail conclusion "run $_run_id concluded '$_conc' — a run that did not complete successfully is not gate evidence, however complete its log looks"
  _log="$(gh run view "$_run_id" --repo "$REPO" --log 2>/dev/null)" || fail gh "could not read the log of run $_run_id in $REPO"
  [ -n "$_log" ] || fail gh "run $_run_id log is empty"
  check_gate_text "$_log" "success"
  exit 0
fi

usage_fail "unreachable input state"
