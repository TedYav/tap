#!/usr/bin/env bash
# ci-sanity.sh — fast syntax and contract checks, separate from the full gate.
# The dedicated native quick-check runner may overlap full/regress on the Mac.
# The owner approved a 60s wall budget for that load on 2026-09-16. The workflow
# has a separate 2m job ceiling for checkout and cleanup. CI_SANITY_BUDGET_SECS
# remains overridable for controlled measurements.
#
# This subset excludes live-pane submit verification, registration lifecycle,
# watch/goalie supervision, cross-worktree relay, and session launch/resume.
# The full gate remains explicitly dispatched through its own workflow.
# bash 3.2 safe.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUDGET_SECS="${CI_SANITY_BUDGET_SECS:-60}"
START="$(date +%s)"
FAILED=0
ci_sanity_scratch="$(mktemp -d "${TMPDIR:-/tmp}/ci-sanity.XXXXXX")" || exit 1
trap 'rm -rf "$ci_sanity_scratch"' EXIT

elapsed() { echo "$(( $(date +%s) - START ))"; }
budget_check() {  # <phase-label>
  e="$(elapsed)"
  echo "ci-sanity: [${e}s] $1 done"
  if [ "$e" -gt "$BUDGET_SECS" ]; then
    echo "ci-sanity: BUDGET EXCEEDED — ${e}s elapsed after '$1' (budget ${BUDGET_SECS}s)." >&2
    echo "ci-sanity: do NOT raise the budget casually: trim a check or re-ratify the 60s budget." >&2
    exit 1
  fi
}

cd "$ROOT"

# --- tier A: every tracked shell script must parse -----------------------------
# The sweep set is the union of every tracked .sh with every tracked
# extensionless file whose first line is a bash/sh shebang (bin/tap,
# the tracker's hook scripts, …). Each file parses under its shebang's shell: bash ones
# with bash -n, pure-sh ones with sh -n. Paths are read one per line.
shell_list="$ci_sanity_scratch/shell-files.txt"
{
  git ls-files |
    while IFS= read -r f; do
      case "$f" in
        *.sh) printf '%s\n' "$f" ;;
        *)
          [ -f "$f" ] || continue
          IFS= read -r first <"$f" || :
          case "$first" in
            '#!'*bash* | '#!'*'/sh'* | '#!'*'env sh'*) printf '%s\n' "$f" ;;
          esac
          ;;
      esac
    done
} >"$shell_list"

n=0
while IFS= read -r f; do
  case "$f" in
    *.sh) interp=bash ;;
    *)
      IFS= read -r first <"$f" || :
      case "$first" in
        '#!'*bash*) interp=bash ;;
        *) interp=sh ;;
      esac
      ;;
  esac
  if ! "$interp" -n "$f" 2>"$ci_sanity_scratch/parse.err"; then
    echo "ci-sanity: PARSE FAIL ($interp -n) $f" >&2
    cat "$ci_sanity_scratch/parse.err" >&2
    FAILED=1
  fi
  n=$((n + 1))
done <"$shell_list"
[ "$n" -ge 100 ] || { echo "ci-sanity: discovery shrink — only $n shell files (expected >=100)" >&2; exit 1; }
budget_check "shell parse sweep ($n files)"

# --- tier B: every tracked python file must compile -----------------------------
# (E4 retired the S1 transition shim and this exception together; the sweep
# below still compiles whatever tracked .py remains, all plan-exempt.)
pys="$(git ls-files '*.py')"
pyn="$(printf '%s\n' "$pys" | grep -c .)"
if [ "$pyn" -gt 0 ]; then
  if ! printf '%s\n' "$pys" | xargs python3 -B -m py_compile; then
    echo "ci-sanity: PY COMPILE FAIL (see above)" >&2
    FAILED=1
  fi
fi
budget_check "py_compile sweep ($pyn files)"

# --- tier C: load-bearing fast smokes (sub-second each, measured) ---------------
# Curation rationale + per-check timings: PR body. A missing file is a HARD
# fail, never a skip — a renamed smoke must not silently shrink sanity coverage.
SMOKES="
bus-roundtrip
read-integrity
outstanding
poll-exit-codes
token-safety
derive-handle
unit-2b-f2-payloads-guard
qualified-token
"
for name in $SMOKES; do
  found=""
  for p in "$ROOT"/skills/*/scripts/smoke/"$name".test.sh; do
    [ -f "$p" ] && found="$p"
  done
  if [ -z "$found" ]; then
    echo "ci-sanity: MISSING SMOKE $name.test.sh — renamed? update scripts/ci-sanity.sh in the same PR" >&2
    exit 1
  fi
  if ! bash "$found" > "$ci_sanity_scratch/$name.out" 2>&1; then
    echo "ci-sanity: SMOKE FAIL $name (output follows)" >&2
    cat "$ci_sanity_scratch/$name.out" >&2
    FAILED=1
  fi
done
budget_check "fast smokes"

e="$(elapsed)"
if [ "$FAILED" -ne 0 ]; then
  echo "ci-sanity: FAILED in ${e}s (budget ${BUDGET_SECS}s)" >&2
  exit 1
fi
echo "ci-sanity: ok — all checks passed in ${e}s (budget ${BUDGET_SECS}s; full gate: bash scripts/smoke-all.sh)"
