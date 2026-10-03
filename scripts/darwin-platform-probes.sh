#!/usr/bin/env bash
# Bounded by the Bun gate's remaining deadline; only private scratch/socket paths.
set -euo pipefail
ROOT="$1"; WORK="$2"
if [ "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" != 3.2 ]; then
  echo 'INCOMPLETE: /bin/bash is not Bash 3.2'; exit 2
fi
if /bin/bash -n -c 'case x in x) : ;;& esac' >/dev/null 2>&1; then
  echo 'FAIL: Bash 3.2 accepted the unsupported ;;& syntax specimen'; exit 1
fi
if ! /bin/bash "$ROOT/skills/tap/scripts/smoke/bash32-parse.test.sh" >"$WORK/parse.log" 2>&1; then
  cat "$WORK/parse.log"; echo 'FAIL: Bash 3.2 repository parse'; exit 1
fi
printf 'bash32=%s parse=ok syntax-negative=ok\n' "$BASH_VERSION"

. "$ROOT/scripts/smoke-all.sh"
# Match the runner's trusted executable search, not an inherited shim directory.
real_tmux="$(PATH="$SMOKE_ALL_FIXED_PATH" command -v tmux || true)"
if [ -z "$real_tmux" ]; then echo 'INCOMPLETE: tmux unavailable for health guard probe'; exit 2; fi
. "$ROOT/skills/tap/scripts/smoke/health-fixture-env.sh"
mkdir -p "$WORK/bun-bin" "$WORK/s"
# Model the macOS Bun directory containing an adjacent tmux. A prepend must red
# without touching the operator server, even if the runner guard is bypassed.
printf '#!/bin/sh\nexit 0\n' >"$WORK/bun-bin/bun"
printf '#!/bin/sh\necho bypass > "$HEALTH_BYPASS"\nexit 88\n' >"$WORK/bun-bin/tmux"
chmod +x "$WORK/bun-bin/bun" "$WORK/bun-bin/tmux"
export HEALTH_BYPASS="$WORK/bypassed" TAP_SMOKE_BUN="$WORK/bun-bin/bun"
export TMUX_TMPDIR="$WORK/s"
unset TMUX TMUX_PANE
smoke_install_tmux_guard "$WORK/guard" "$real_tmux" "$TMUX_TMPDIR" "$WORK/escape"
PATH="$WORK/guard:$PATH"; export PATH
health_fixture_path
no_server="$(health_no_server_root)"
rc=0
tmux -S "$no_server/tmux-$(id -u)/default" list-sessions >"$WORK/allowed.log" 2>&1 || rc=$?
if [ "$rc" != 1 ] || [ -s "$WORK/escape" ] || [ -e "$HEALTH_BYPASS" ] || [ -S "$no_server/tmux-$(id -u)/default" ]; then
  cat "$WORK/allowed.log"; echo 'FAIL: health private no-server probe bypassed or hit the guard'; exit 1
fi
rc=0
tmux -S "$WORK/outside.sock" list-sessions >"$WORK/refused.log" 2>&1 || rc=$?
if [ "$rc" != 97 ] || [ ! -s "$WORK/escape" ] || [ -e "$HEALTH_BYPASS" ]; then
  cat "$WORK/refused.log"; echo 'FAIL: health PATH bypassed runner tmux guard'; exit 1
fi
printf 'health-path-guard=ok no-server=ok\n'
