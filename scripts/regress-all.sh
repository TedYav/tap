#!/usr/bin/env bash
# regress-all.sh — run the OPTIONAL regression suite (tap-52ys).
#
# Usage: bash scripts/regress-all.sh [-j N]
#        bash scripts/regress-all.sh --last-run
#
# This is NOT the merge gate and never blocks a merge. It runs the tests that
# left the gate in tap-52ys: stable but expensive integration arcs (watch,
# goalie, team lifecycle, cross-worktree, harness-specific launch paths).
#
# A nonblocking scheduled CI workflow may also run this; it never blocks a merge. The shared runner still
# isolates state and reduces concurrency under load. A local last-run stamp records
# "did this ever run" is a file rather than a memory:
#
#   .tap/regress-last-run.json   {at, head, exit}
#
# `--last-run` prints the local stamp first. Without one, and with
# TAP_REGRESS_CI_REPO=<owner/repo> set, it downloads the latest completed
# regress-scheduled.yml run's regress-record artifact. It names the source; CI is
# not a local run.
# Nothing reads these records automatically, so a stale
# suite is visible when someone asks and not before. Wiring it into `tap doctor`
# is a deliberate non-goal — REGRESS can be invoked by an operator or the
# nonblocking daily GHA workflow, and a doctor warning is the first step back
# toward it nagging like a gate.
#
# Membership is a DIRECTORY, not a list: skills/*/scripts/regress/*.test.sh.
# A file's bucket is where it lives, so there is no manifest to drift and no
# per-file marker to forget. Moving a file between smoke/ and regress/ is the
# whole re-bucketing operation.
#
# Everything else — advisory load observation, hermetic entry, the per-file
# ledger, and the checkout receipt — is smoke-all.sh's and shared. This
# script sets TAP_SUITE_DIR=regress and hands off.
#
# A flake does not become coverage by living here. This suite is for tests
# that are stable and expensive. A test that reds on a quiet box gets deleted,
# not re-parked.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$ROOT/.tap/regress-last-run.json"

for _arg in "$@"; do
  case "$_arg" in
    -h|--help) sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --last-run)
      if [ -f "$STAMP" ]; then
        echo "regress-all: source=local stamp ($STAMP)"
        cat "$STAMP"
        exit 0
      fi
      record_dir="$(mktemp -d)"
      trap 'rm -rf "$record_dir"' EXIT
      # Pin the artifact to this workflow's latest completed run, not an
      # identically named artifact uploaded by another workflow.
      record_run=""
      [ -z "${TAP_REGRESS_CI_REPO:-}" ] || record_run="$(GH_PROMPT_DISABLED=1 gh run list --repo "$TAP_REGRESS_CI_REPO" \
        --workflow regress-scheduled.yml --status completed --limit 1 \
        --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
      if [[ "$record_run" =~ ^[0-9]+$ ]] && \
        GH_PROMPT_DISABLED=1 gh run download "$record_run" --repo "$TAP_REGRESS_CI_REPO" \
          --name regress-record --dir "$record_dir" >/dev/null 2>&1 && \
        [ -s "$record_dir/regress-baseline.md" ]; then
        echo "regress-all: source=CI artifact (run $record_run); no local stamp"
        cat "$record_dir/regress-baseline.md"
        exit 0
      fi
      echo "regress-all: no local stamp and no CI record available; this does not mean CI never ran" >&2
      exit 1
      ;;
  esac
done

# The stamp records the run that ACTUALLY happened, pass or fail, so a red
# regression run is as visible as a green one. Written after the suite exits;
# a killed run leaves the previous stamp rather than a lie about this one.
started_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
# Tee the run so the stamp guard below can look for a terminal-result line
# rather than trusting an exit code (see the note there).
capture_dir="$(mktemp -d)"
RUN_LOG="$capture_dir/regress.log"
trap 'rm -rf "$capture_dir"' EXIT
mkfifo "$capture_dir/output"
# Hold both ends until children open theirs, including early cancellation.
exec 9<> "$capture_dir/output"
set +e
tee "$RUN_LOG" < "$capture_dir/output" 9>&- &
capture_pid=$!
suite_pid=""
interrupted=0
trap 'interrupted=1; [[ -z "$suite_pid" ]] || kill -TERM "$suite_pid" 2>/dev/null || true' INT TERM HUP
TAP_SUITE_DIR=regress bash "$ROOT/scripts/smoke-all.sh" "$@" > "$capture_dir/output" 2>&1 9>&- &
suite_pid=$!
exec 9>&-
[[ "$interrupted" == 0 ]] || kill -TERM "$suite_pid" 2>/dev/null || true
regress_wait_child() {
  local child="$1" status
  while :; do
    wait "$child"; status=$?
    [[ " $(jobs -pr | tr '\n' ' ') " == *" $child "* ]] || return "$status"
  done
}
regress_wait_child "$suite_pid"; rc=$?
suite_pid=""
regress_wait_child "$capture_pid"; capture_exit=$?
trap - INT TERM HUP
set -e
[[ "$interrupted" == 0 ]] || exit 130
[[ "$capture_exit" == 0 ]] || exit "$capture_exit"

# sol-ponytail P2 (and his re-review, which caught the first fix): only a run
# that ACTUALLY EXECUTED FILES may replace the stamp. A pre-run refusal runs
# zero files, so stamping it overwrites "the last time this box ran regress"
# with a run that never happened — worse than no stamp, since the file's whole
# job is answering "did this ever run" and a refusal would answer "yes, just
# now."
#
# The first fix gated on exit code (0|1) and was WRONG: suite_slot_busy also
# exits 1 (suite_slot.py returns 1 on a held lock), so a busy refusal was
# indistinguishable from an authored red. Exit codes cannot discriminate here.
#
# The discriminator is a POSITIVE marker that the suite reached its own
# terminal accounting: smoke-all prints "<suite>: <receipt> ... — ok — all N
# files passed" on green and "<suite>: <receipt> ... — N/M FAILED" on red, and
# emits neither before it has run files. Absence of both means no run happened,
# whatever the exit code says. (tap-0jwef: the red ellipsis is load-bearing —
# since tap-z6con both shapes carry a known-defect and declared-skip segment
# between the checkout receipt and the em-dash.)
# The marker must list EVERY terminal outcome smoke-all can author after
# running files, not just the two happy shapes. sol's re-review caught the
# third: "ledger mismatch" (smoke-all.sh — workers ran but the pass+fail count
# does not reconcile, i.e. a worker died). That IS a run that executed files,
# and its result is exactly what a stamp should record; omitting it meant a
# lost worker left the stamp claiming an older, healthier run.
# tap-1f45b adds the FOURTH shape, and it is the one that shows why this is an
# enumeration rather than a pattern. A straddled run executed files — it simply
# cannot say which tree they were read from — so it is a run the stamp should
# record. Left out, it matches none of the markers, and this guard's own
# documented failure returns: the stamp silently keeps the PREVIOUS run and
# claims an older, healthier one. A consumer that recognises "a run happened"
# by listing success shapes fails toward silence on every shape added later,
# and silence here is indistinguishable from a run that never started.
#
# WHAT STAMPING A STRADDLE DOES NOT MEAN: the stamp records that regress ran on
# this box and when, never that its result is citable. A straddled entry is a
# refusal that executed files; anyone reading the stamp as evidence of a PASS is
# misreading it for every shape here except the green one.
#
# tap-jnik4: a --only or --list run is a PARTIAL run. smoke-all names its
# receipt "regress-one" or "regress-selected" rather than "regress-all", so the
# full-suite marker below never matches it and a passing one-file run read as
# "no terminal result" — as if it had failed or never started. A partial run
# deliberately does NOT stamp: the stamp answers "did this box ever run the
# whole suite", and one file passing would overwrite a full run's record with a
# smaller claim. So the guard recognises the same four terminal shapes under the
# partial names, says plainly that the stamp is for full runs only, and exits
# with the suite's own code. Any other shape still falls through to the
# "no terminal result" refusal below, so an unrecognised outcome fails toward
# silence exactly as before.
_terminal_shapes='(— ok — all [0-9]+ files passed|[0-9]+/[0-9]+ FAILED|— ledger mismatch —|— STRADDLED —)'
# The full-suite receipt is checked FIRST: smoke-all replays failed-file logs
# verbatim, so a partial-shaped receipt can sit in the same log as an authored
# full one, and the full result is the one the stamp must record.
if ! grep -qE "^regress-all: .*$_terminal_shapes" "$RUN_LOG"; then
  if grep -qE "^regress-(one|selected): .*$_terminal_shapes" "$RUN_LOG"; then
    echo "regress-all: partial run (--only/--list) finished (exit $rc) — the last-run stamp records full runs only, left unchanged" >&2
    exit "$rc"
  fi
  echo "regress-all: the suite produced no terminal result (exit $rc) — last-run stamp left unchanged" >&2
  sed -n '1,20p' "$RUN_LOG" >&2
  exit "$rc"
fi

mkdir -p "$ROOT/.tap"
python3 -I - "$STAMP" "$started_head" "$rc" <<'PY'
import json, sys, time
stamp, head, rc = sys.argv[1], sys.argv[2], int(sys.argv[3])
json.dump(
    {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "head": head,
        "exit": rc,
    },
    open(stamp, "w"),
    indent=2,
    sort_keys=True,
)
open(stamp, "a").write("\n")
PY
echo "regress-all: stamp written to $STAMP (exit $rc)"
exit "$rc"
