#!/usr/bin/env bash
# Detached tmux jobs must not open a result view in any pane. Preserve the
# child's output and real status in the named log; the tmux-facing job succeeds.
log="${1:?log required}"
shift
mkdir -p "$(dirname "$log")" 2>/dev/null || exit 0
{
  "$@"
  rc=$?
  printf '%s\thelper=%s\trc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-${1:-unknown}}" "$rc"
} >>"$log" 2>&1
exit 0
