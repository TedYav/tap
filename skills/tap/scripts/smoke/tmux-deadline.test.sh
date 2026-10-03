#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo 'tmux-deadline: run this file; do not source it' >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'MOCK'
#!/usr/bin/env python3
import os, sys, time
with open(os.environ['CALLS'], 'a') as stream:
    stream.write(' '.join(sys.argv[1:]) + '\n')
if os.environ.get('FAST_FIRST') == '1' and 'send-keys' in sys.argv:
    if len(open(os.environ['CALLS']).readlines()) == 1:
        sys.exit(0)
if os.environ.get('ENXIO_ERROR'):
    print(os.environ['ENXIO_ERROR'], file=sys.stderr)
    sys.exit(1)
if os.environ.get('PARTIAL_ERROR'):
    print(os.environ['PARTIAL_ERROR'], file=sys.stderr, flush=True)
time.sleep(2)
MOCK
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH" CALLS="$WORK/calls" TAP_TMUX_TIMEOUT_SECONDS=0.5
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
rc=0
tmux capture-pane -t %999 -p >"$WORK/out" 2>"$WORK/error" || rc=$?
[ "$rc" = 124 ] || { echo "expected typed timeout exit 124, got $rc"; exit 1; }
rg -q server_unresponsive "$WORK/error"
# Text that happens to name an interactive verb is still a bounded send.
rc=0
tmux send-keys -t %999 -l attach >"$WORK/out" 2>"$WORK/error" || rc=$?
[ "$rc" = 124 ] || { echo 'literal attach text bypassed deadline'; exit 1; }
echo 'tmux-deadline: read and possible-effect timeout are typed; Enter is not retried'

export PARTIAL_ERROR='tmux diagnostic before timeout'
rc=0
tmux capture-pane -t %999 -p >"$WORK/out" 2>"$WORK/error" || rc=$?
[ "$rc" = 124 ] || { echo 'partial diagnostic changed timeout result'; exit 1; }
rg -qF "$PARTIAL_ERROR" "$WORK/error"
# The completed-client refusals below use the normal deadline. Keep the short
# deadline local to the timeout controls above and the native timeout arm.
unset PARTIAL_ERROR TAP_TMUX_TIMEOUT_SECONDS

# A completed tmux client can still report a server fork refusal.
export ENXIO_ERROR='respawn pane failed: fork failed: Device not configured'
: > "$CALLS"
rc=0
tmux respawn-pane -t %999 >"$WORK/out" 2>"$WORK/error" || rc=$?
[ "$rc" = 124 ] || { echo "ENXIO lost server refusal class: $rc"; exit 1; }
rg -q 'server_unresponsive.*load1m=' "$WORK/error"
[ "$(wc -l < "$CALLS" | tr -d ' ')" = 1 ] || { echo 'ENXIO retried spawn'; exit 1; }
export ENXIO_ERROR="can't find pane: missing"
rc=0
tmux has-session -t missing >"$WORK/out" 2>"$WORK/error" || rc=$?
[ "$rc" = 1 ] || { echo 'ordinary pane failure was reclassified'; exit 1; }
unset ENXIO_ERROR

bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/tmux-deadline.test.ts"
