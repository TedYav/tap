#!/usr/bin/env bash
# delivery-clock.test.sh — the public face of the recipient's delivery clock.
# The module's internal arms (path resolution, the one-field key set,
# monotonicity, corruption tolerance, unbound containment, concurrency) live in
# runtime/bun/test/delivery-clock.test.ts, and the wiring parity arms live in
# runtime/bun/test/send-cutover-spool.test.ts. This file keeps only what must go
# through bin/tap: a real `tap send` against a fake tmux advances the
# RECIPIENT's clock, and a poll delivery does not.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# Physical path: bus_for_registry() calls Path.resolve(), and on macOS /var is a
# symlink to /private/var — a logical mktemp path would make every comparison
# below fail on the symlink rather than on the behavior.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

export TAP_HOME="$WORK/sender-bus"
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
mkdir -p "$TAP_HOME"

fail() { echo "delivery-clock: FAIL — $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }

# =============================================================================
# END TO END: a real `tap send` advances the clock; a poll delivery does not.
# A verified pane delivery stamps the recipient's clock; a poll queue-up writes
# the same .sent receipt and stamps nothing — the stamp is gated on `delivery`,
# not on reaching the receipt line.
# =============================================================================
(
  E2E="$WORK/e2e"
  FAKE_BIN="$E2E/bin"
  mkdir -p "$FAKE_BIN" "$E2E/tmux" "$E2E/repo"
  cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
# tmux resolves numeric pane ids and session addresses to the same input band.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
  args+=("$arg")
done
set -- "${args[@]}"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input.$key"; exit 0; fi
    ;;
esac
TMUXMOCK
  chmod +x "$FAKE_BIN/tmux"
  export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$E2E/tmux" \
         FAKE_WORKTREE="$E2E/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
  export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
  BUS="$E2E/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
  export TAP_HOME="$BUS"
  cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$E2E/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$E2E/repo" },
    "ghost": { "delivery": "poll", "unattended": true, "status": "active", "harness": "codex" }
  } }
JSON
  CLOCK_DIR="$BUS/delivery"

  # A --wake send injects (it declines the hold), so it is a verified pane delivery.
  [ ! -e "$CLOCK_DIR/peer.json" ] || fail "e2e: a clock existed before any delivery"
  TAP_AUTOSETTLE_HOLD_SECONDS=99999 bash "$ROOT/bin/tap" \
    send peer -m "hello" --id e2e1 --from alice --wake >/dev/null 2>&1 \
    || fail "e2e: --wake send failed"
  [ -f "$BUS/receipts/e2e1.sent" ] || fail "e2e: the send wrote no .sent receipt"
  [ -f "$CLOCK_DIR/peer.json" ] \
    || fail "e2e: a verified pane delivery did not stamp the recipient clock"
  stamped="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["last_delivered_at"])' "$CLOCK_DIR/peer.json")"
  case "$stamped" in ''|*[!0-9]*) fail "e2e: clock holds '$stamped', expected an epoch" ;; esac
  ok "a verified pane send stamps the recipient's clock"

  # A poll recipient never has its pane touched. The SAME `.sent` writer runs for
  # it, which is why the stamp is gated on `delivery`, not on reaching that line.
  TAP_AUTOSETTLE_HOLD_SECONDS=99999 bash "$ROOT/bin/tap" \
    send ghost -m "queued" --id e2e2 --from alice --wake >/dev/null 2>&1 \
    || fail "e2e: poll send failed"
  [ -f "$BUS/receipts/e2e2.sent" ] || fail "e2e: the poll send wrote no .sent receipt"
  [ ! -e "$CLOCK_DIR/ghost.json" ] \
    || fail "e2e: a poll queue-up stamped a clock — a recipient reading its own mail is not a wake"
  ok "a poll delivery writes .sent but stamps no clock"
) || exit 1

echo "delivery-clock: ok"
