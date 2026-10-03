#!/usr/bin/env bash
# tap-7r3fn.21 U1 (roster half): the shared classifier's unbound verdict and
# both roster renderers agree through the public doors, without requiring a
# ps table. The classifier's own arms -- the env-file payload contract and the
# recovery ladder -- moved to runtime/bun/test/team-unbound-state.test.ts;
# this file keeps only what a public verb can reach.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-unbound.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BUS="$WORK/bus"
FAKE_BIN="$WORK/bin"
TRACE="$WORK/native.trace"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$FAKE_BIN"

export TAP_SERVER_EPOCH="srv:900:100"
export TAP_BOOT_ID="boot:2"
export TAP_OBS_SESSION_SCOPE="demo/scout"

cat >"$BUS/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{"scout":{"status":"suspended","status_reason":"server_restarted","delivery":"pane","session":"demo/scout","harness":"codex","server_epoch":"srv:900:100","boot_id":"boot:2"}}}
JSON

cat >"$FAKE_BIN/tmux" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions)
    printf 'demo/scout\t900:100\t0\n'
    ;;
  list-panes)
    printf 'demo/scout\tdemo/scout:0.0\t%%11\tcodex\t111\t900:100\t0\n'
    ;;
  display-message)
    printf '\n'
    ;;
esac
SH
chmod +x "$FAKE_BIN/tmux"

export TAP_HOME="$BUS"
export PATH="$FAKE_BIN:$PATH"
export NO_COLOR=1
export COLUMNS=120
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "team-unbound: Bun unavailable" >&2; exit 1; }

: >"$TRACE"
native="$(TAP_BUN_ROUTE_TRACE="$TRACE" "$BUN" "$ROOT/runtime/bun/main.ts" team)"
grep -q '^native team$' "$TRACE" \
  || { echo "team-unbound: native roster did not exercise native team route" >&2; cat "$TRACE" >&2; exit 1; }
[[ "$native" == *"scout"*"unbound"* ]] \
  || { echo "team-unbound: native narrow roster did not render unbound" >&2; echo "$native" >&2; exit 1; }

bash_roster="$(bash "$ROOT/bin/tap" team)"
[[ "$bash_roster" == *"scout"*"unbound"* ]] \
  || { echo "team-unbound: Bash narrow roster did not render unbound" >&2; echo "$bash_roster" >&2; exit 1; }

echo "team-unbound-state: classifier and both roster renderers agree: ok"
