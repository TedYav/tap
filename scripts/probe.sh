#!/usr/bin/env bash
# probe.sh — run one saved probe file under the smoke runner's boundary.
#
# Usage: bash scripts/probe.sh <tmp/seat/name.{sh,py,ts}> [-- args...]
#   file   a regular file saved under tmp/<seat>/ in this checkout; the
#          extension picks the interpreter (.sh bash, .py python, .ts bun)
#   args   passed to the probe as literal argv; never eval'd, never -c
#
# The file runs inside the same boundary as `smoke-all.sh --only`: a clean
# environment (env -i admission), private HOME, TAP state pins and tmux
# namespace, the tmux guard, recorded-process reaping and the post-run
# operator-state checks. Inherited HOME, TAP_HOME, TMUX, CLAUDE_CONFIG_DIR and
# session-id variables never reach the probe.
#
# The probe's cwd is a fresh scratch directory outside every checkout, removed
# with the runner's own roots. The reviewed checkout is TAP_PROBE_CHECKOUT.
# Write evidence you want to keep under $TAP_PROBE_CHECKOUT/tmp/<seat>/.
#
# Exit: an isolation or state-predicate failure wins (1), even when the probe
# exited 0; otherwise the probe's own exit status. Usage errors exit 64; each
# refusal prints `probe: error=<id>: <cause>` and one `probe: recovery:` line.
#
# This is a developer tool: no gate slot, no seat registration, and its output
# is not merge evidence. Run the suite's tests through scripts/smoke-all.sh.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
exec "$BASH" "$root/scripts/smoke-all.sh" --probe "$@"
