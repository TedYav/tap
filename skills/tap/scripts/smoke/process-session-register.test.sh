#!/usr/bin/env bash
# Fixture env (TMUX, PATH shims, HOME) must stay in this process. Refuse `source`.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# Process-held rollout recovery must reach the registry and exact resume argv.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"; FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN" "$FAKE_HOME"' EXIT
export TAP_HOME="$WORK/bus"; mkdir -p "$TAP_HOME"
export TAP_INDEX_HOME="$WORK/index" HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
# The registered pane must sit inside the worktree (register's same-tree guard); use the
# repo root for that. HOME stays fake so the session store path is hermetic + predictable.
export FAKE_ROOT="$WORK/team"
mkdir -p "$FAKE_ROOT"
FAKE_ROOT="$(cd "$FAKE_ROOT" && pwd -P)"
git -C "$FAKE_ROOT" init -q
tap_smoke_enroll_current "$FAKE_ROOT" "$TAP_HOME"
cd "$FAKE_ROOT"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  list-panes) printf '%%901\t/dev/faketty\n' ;;
  list-sessions) printf 'processteam/processseat\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%901\tprocessteam/processseat\t4242\tcodex\t0\n' ;;
      *pid*start_time*)          printf '4242:1000000000\n' ;;
      *socket_path*)             printf '%s\n' "${TMUX:-/tmp/tmux-$(id -u)/default}" ;;
      *pane_id*)                 printf '%%901\n' ;;
      *session_name*:*window_index*) printf 'processteam/processseat:0.0\n' ;;
      *session_name*)          printf 'processteam/processseat\n' ;;
      *pane_current_command*)  printf 'codex\n' ;;
      *pane_current_path*)     printf '%s\n' "${FAKE_ROOT:?}" ;;
      *pane_pid*)              printf '4242\n' ;;
      *pane_in_mode*)          printf '0\n' ;;
      *window_activity*)       printf '0\n' ;;
      *) printf '\n' ;;
    esac ;;
  capture-pane) printf '> \n' ;;
  send-keys) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
if [ "${1:-}" = -axo ]; then
  printf '4242 1 Fri Sep  5 01:00:00 2026 /bin/codex\n'
else
  exec /bin/ps "$@"
fi
PS
cat > "$FAKE_BIN/lsof" <<'LSOF'
#!/usr/bin/env bash
printf 'p4242\nfcwd\nn%s\nn%s\n' "$FAKE_ROOT" "$HELD_ROLLOUT"
LSOF
chmod +x "$FAKE_BIN/ps" "$FAKE_BIN/lsof"
export HELD_ROLLOUT="$HOME/.codex/sessions/2026/09/05/rollout-2026-09-05T01-00-00-11111111-1111-4111-8111-111111111111.jsonl"
python3 - "$FAKE_ROOT" <<'PYFIX'
import json, os, pathlib, sys
root = pathlib.Path(os.environ['HELD_ROLLOUT']).parent
root.mkdir(parents=True)
for sid in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'):
    (root / ('rollout-2026-09-05T01-00-00-' + sid + '.jsonl')).write_text(json.dumps(
        {'type': 'session_meta', 'payload': {'id': sid, 'cwd': sys.argv[1]}}) + '\n')
PYFIX
unset CODEX_THREAD_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH
"$TAP" register processseat --pane %901 >"$WORK/register.out" 2>&1 || {
  cat "$WORK/register.out"; exit 1;
}
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/launcher-fixture.ts" process-resume "$TAP_HOME/registry.json" "$ROOT"
echo 'process-session-register: registry process identity reaches exact resume argv'
