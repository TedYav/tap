#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# smoke-source-guard-inventory.test.sh — P1-2 inventory: every smoke that
# exports TMUX (or carries the o4ae fixture-isolation preamble) must refuse
# `source` without mutating caller options/env. Guards live immediately under
# the shebang (before any `set -o`).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# tap-52ys: sweep BOTH suite directories. The source-refusal preamble is a
# property of every fixture, not of the merge-gate subset — a regress/ file
# that leaks exports into an interactive shell is the same defect it always
# was, and moving a file between buckets must never silently exempt it.
SUITE_DIRS=("$ROOT/skills/tap/scripts/smoke" "$ROOT/skills/tap/scripts/regress")
SELF="$(basename "${BASH_SOURCE[0]}")"

fail=0
count=0
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  # Never inventory-source this file (would recurse).
  [ "$base" = "$SELF" ] && continue
  # Target only TMUX-exporting smokes / o4ae-preamble carriers.
  if ! grep -qE 'export[[:space:]].*\bTMUX=|tap-o4ae: fixture env \(TMUX=' "$f"; then
    continue
  fi
  count=$((count + 1))
  # Probe inside one shell that actually sources the file — outer isolation
  # would hide option/env mutation.
  set +e
  result="$(
    bash -c '
      set +e
      opts_before="$(set +o)"
      tmux_before="${TMUX-__unset__}"
      export MARKER=caller-intact
      source "$1"
      rc=$?
      opts_after="$(set +o)"
      tmux_after="${TMUX-__unset__}"
      marker_after="${MARKER-__gone__}"
      if [ "$rc" -eq 0 ]; then
        echo "FAIL rc=0"
        exit 0
      fi
      if [ "$opts_before" != "$opts_after" ]; then
        echo "FAIL opts-mutated"
        exit 0
      fi
      if [ "$tmux_before" != "$tmux_after" ]; then
        echo "FAIL tmux-mutated:$tmux_before->$tmux_after"
        exit 0
      fi
      if [ "$marker_after" != "caller-intact" ]; then
        echo "FAIL env-mutated"
        exit 0
      fi
      echo "OK"
    ' _ "$f" 2>/dev/null
  )"
  set -e
  case "$result" in
    OK) ;;
    FAIL\ rc=0)
      echo "inventory: $base sourced successfully — guard missing" >&2
      fail=1
      ;;
    FAIL\ opts-mutated)
      echo "inventory: $base mutated caller set options (guard after set -o)" >&2
      fail=1
      ;;
    FAIL\ tmux-mutated:*)
      echo "inventory: $base mutated caller TMUX (${result#FAIL tmux-mutated:})" >&2
      fail=1
      ;;
    FAIL\ env-mutated)
      echo "inventory: $base mutated caller env" >&2
      fail=1
      ;;
    *)
      echo "inventory: $base unexpected probe result: ${result:-<empty>}" >&2
      fail=1
      ;;
  esac
done < <(find "${SUITE_DIRS[@]}" -maxdepth 1 -name '*.test.sh' -print0 2>/dev/null | sort -z)

[ "$count" -ge 40 ] || {
  echo "inventory: expected >=40 TMUX-exporting smokes, got $count" >&2
  exit 1
}
[ "$fail" -eq 0 ] || exit 1
echo "smoke-source-guard-inventory: $count smokes refuse source without mutating caller: ok"
