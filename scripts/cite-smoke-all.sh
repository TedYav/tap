#!/usr/bin/env bash
# cite-smoke-all.sh — lane cite wrapper that propagates the suite's real exit.
#
# Do NOT `smoke-all | tee; echo $?` — tee's exit masks a red suite as 0.
# Receipt form: SMOKE_REAL_EXIT:<n> on stdout (and the process exit is <n>).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

LOG="${CITE_SMOKE_LOG:-/tmp/cite-smoke-all.log}"
# Write suite output to the log, mirror to stdout, keep rc. Append the receipt
# line to the log as well — monitors that only watch the file must see it
# (stdout-only SMOKE_REAL_EXIT left the first re-cite receipt pane-only).
set +e
bash "$ROOT/scripts/smoke-all.sh" "$@" >"$LOG" 2>&1
rc=$?
set -e
cat "$LOG"
printf 'SMOKE_REAL_EXIT:%s\n' "$rc" | tee -a "$LOG"
exit "$rc"
