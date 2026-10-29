#!/usr/bin/env bash
# crew-refresh-collection.test.sh — stopped crews retain their conversation.
# Both plain and --hard refresh keep crew rows across pane and server loss.
# A non-crew row from an earlier boot remains a retained offline control.
# Counterexamples: address_rebound and harness_exited keep live crew panes.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-crew-refresh.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/userhome/bus/payloads" "$WORK/userhome/bus/receipts"

export TAP_HOME="$WORK/userhome" PATH="$WORK/bin:$PATH"
TAP_REGISTRY="$WORK/userhome/registry.json"
export TAP_REGISTRY

EPOCH="srv:1:1"
export TAP_SERVER_EPOCH="$EPOCH" TAP_BOOT_ID="boot:2"

fail() { echo "crew-refresh-collection: $1" >&2; exit 1; }

write_registry() {
  cat > "$TAP_REGISTRY" <<REGISTRY
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "driver": {
      "status": "active",
      "delivery": "pane",
      "harness": "codex",
      "pane": "demo/seat:0.0",
      "pane_id": "%1",
      "session": "demo/seat",
      "server_epoch": "$EPOCH",
      "registered_at": "2026-09-03T00:00:00Z"
    },
    "crew-alive": {
      "status": "active",
      "delivery": "pane",
      "harness": "codex",
      "pane": "demo/seat:1.0",
      "pane_id": "%2",
      "session": "demo/seat",
      "server_epoch": "$EPOCH",
      "crew": true,
      "registered_at": "2026-09-03T00:00:00Z"
    },
    "crew-dead-pane": {
      "status": "active",
      "delivery": "pane",
      "harness": "codex",
      "pane": "demo/seat:2.0",
      "pane_id": "%3",
      "session": "demo/seat",
      "server_epoch": "$EPOCH",
      "crew": true,
      "registered_at": "2026-09-03T00:00:00Z"
    },
    "crew-h660": {
      "status": "suspended",
      "status_reason": "server_restarted",
      "delivery": "pane",
      "harness": "codex",
      "pane": "",
      "pane_id": "",
      "session": "demo/seat",
      "server_epoch": "$EPOCH",
      "crew": true,
      "registered_at": "2026-09-03T00:00:00Z"
    },
    "teammate-offline": {
      "status": "suspended",
      "status_reason": "server_restarted",
      "delivery": "pane",
      "harness": "codex",
      "pane": "",
      "pane_id": "",
      "session": "demo/other",
      "server_epoch": "$EPOCH",
      "boot_id": "boot:1",
      "registered_at": "2026-09-03T00:00:00Z"
    }
  }
}
REGISTRY
}

# Mock tmux: parent session alive, crew-alive pane %2 alive, crew-dead-pane %3 NOT listed.
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
set -uo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions)
    printf 'demo/seat\t%s\n' "$TAP_SERVER_EPOCH"
    printf 'demo/other\t%s\n' "$TAP_SERVER_EPOCH"
    exit 0 ;;
  list-panes)
    shift
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/seat)
        printf 'demo/seat\tdemo/seat:0.0\t%%1\tcodex\t100\t%s\t0\n' "$TAP_SERVER_EPOCH"
        printf 'demo/seat\tdemo/seat:1.0\t%%2\tcodex\t101\t%s\t0\n' "$TAP_SERVER_EPOCH"
        ;;
      demo/other)
        printf 'demo/other\tdemo/other:0.0\t%%4\tcodex\t200\t%s\t0\n' "$TAP_SERVER_EPOCH"
        ;;
    esac
    exit 0 ;;
  display-message) printf '\n'; exit 0 ;;
esac
exit 0
TMUX
chmod +x "$WORK/bin/tmux"

event_log="$WORK/userhome/registry-events.log"

# --- ARM 1: plain refresh retains dead crew, keeps live crew and offline teammate ---
write_registry
: > "$event_log" 2>/dev/null || true
out="$(bash "$ROOT/bin/tap" team refresh --json 2>/dev/null)"
bash_rc=$?

echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle']: r['reason'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-dead-pane' in kept, f'crew-dead-pane not trimmed: trimmed={list(trimmed)}'
assert 'crew-h660' in kept, f'crew-h660 not trimmed: trimmed={list(trimmed)}'
assert 'crew-alive' in kept, f'crew-alive not kept: kept={kept}'
assert 'driver' in kept, f'driver not kept: kept={kept}'
assert 'teammate-offline' in kept, f'teammate-offline not kept: kept={kept}'
assert len(d['trimmed']) == 0, f'expected no trimmed rows, got {len(d[\"trimmed\"])}'
" || fail "ARM 1 (plain): wrong classification"
[ "$bash_rc" -eq 0 ] || fail "ARM 1 (plain): exit $bash_rc"

# Verify registry mutation
python3 -c "
import json
reg = json.load(open('$TAP_REGISTRY'))
seats = reg.get('seats', reg.get('agents', {}))
assert 'crew-dead-pane' in seats, 'crew-dead-pane still in registry'
assert 'crew-h660' in seats, 'crew-h660 still in registry'
assert 'crew-alive' in seats, 'crew-alive missing from registry'
assert 'driver' in seats, 'driver missing'
assert 'teammate-offline' in seats, 'teammate-offline missing'
" || fail "ARM 1 (plain): registry not updated correctly"

# Verify no crew collection event
python3 -c "
import sys
events = open('$event_log').readlines()
crew_events = [l for l in events if 'crew_collected' in l]
assert len(crew_events) == 0, f'expected no crew_collected events, got {len(crew_events)}: {crew_events}'
trimmed_events = [l for l in events if 'action=trimmed' in l]
assert len(trimmed_events) == 0, f'unexpected trimmed events for crew: {trimmed_events}'
" || fail "ARM 1 (plain): event log incorrect"

# --- ARM 2: --hard retains dead crew (same as plain for crew) ---
write_registry
out="$(bash "$ROOT/bin/tap" team refresh --hard --json 2>/dev/null)"
echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-dead-pane' in kept, f'crew-dead-pane not trimmed: trimmed={trimmed}'
assert 'crew-h660' in kept, f'crew-h660 not trimmed: trimmed={trimmed}'
assert 'crew-alive' in kept, f'crew-alive not kept: kept={kept}'
assert 'driver' in kept, f'driver not kept: kept={kept}'
" || fail "ARM 2 (--hard): crew classification wrong"

# --- ARM 3: dry-run does not modify the registry or emit events ---
write_registry
: > "$event_log" 2>/dev/null || true
out="$(bash "$ROOT/bin/tap" team refresh --dry-run --json 2>/dev/null)"
echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-dead-pane' in kept, f'dry-run: crew-dead-pane not trimmed'
assert 'crew-h660' in kept, f'dry-run: crew-h660 not trimmed'
" || fail "ARM 3 (dry-run): wrong classification"
python3 -c "
import json
reg = json.load(open('$TAP_REGISTRY'))
seats = reg.get('seats', reg.get('agents', {}))
assert 'crew-dead-pane' in seats, 'dry-run deleted crew-dead-pane!'
assert 'crew-h660' in seats, 'dry-run deleted crew-h660!'
" || fail "ARM 3 (dry-run): registry modified during dry-run"
if [ -s "$event_log" ]; then
  fail "ARM 3 (dry-run): event log written during dry-run"
fi

# --- ARM 4: non-crew row kept in same shapes (regression guard) ---
write_registry
out="$(bash "$ROOT/bin/tap" team refresh --json 2>/dev/null)"
echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
kept = {r['handle']: r['reason'] for r in d['kept']}
assert 'teammate-offline' in kept, f'teammate-offline not kept'
assert kept['teammate-offline'] == 'offline:server_restarted', f'wrong reason: {kept[\"teammate-offline\"]}'
" || fail "ARM 4 (regression): teammate-offline not kept as offline:server_restarted"

# --- ARM 5: native (bun) path ---
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
MAIN="$ROOT/runtime/bun/main.ts"
if [ -n "$BUN" ] && [ -x "$BUN" ] && [ -s "$MAIN" ]; then
  write_registry
  : > "$event_log" 2>/dev/null || true
  native_rc=0
  native_out="$("$BUN" "$MAIN" team refresh --json 2>/dev/null)" || native_rc=$?
  [ "$native_rc" -eq 0 ] || fail "ARM 5 (native): exit $native_rc"
  echo "$native_out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle']: r['reason'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-dead-pane' in kept, f'native: crew-dead-pane not trimmed: trimmed={list(trimmed)}'
assert 'crew-h660' in kept, f'native: crew-h660 not trimmed: trimmed={list(trimmed)}'
assert 'crew-alive' in kept, f'native: crew-alive not kept: kept={kept}'
assert 'driver' in kept, f'native: driver not kept: kept={kept}'
assert 'teammate-offline' in kept, f'native: teammate-offline not kept: kept={kept}'
assert len(d['trimmed']) == 0, f'native: expected no trimmed rows, got {len(d[\"trimmed\"])}'
" || fail "ARM 5 (native): wrong classification"
  echo "crew-refresh-collection: native parity: ok"
else
  echo "crew-refresh-collection: native arm skipped (bun unavailable)"
fi

# --- ARM 6: address_rebound keeps live crew (counterexample) ---
# Crew pane %2 registered at demo/seat:1.0 but now live at demo/seat:3.0.
# The observer returns unknown:address_rebound. This must NOT collect.
cat > "$TAP_REGISTRY" <<REGISTRY
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "driver": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:0.0", "pane_id": "%1", "session": "demo/seat",
      "server_epoch": "$EPOCH", "registered_at": "2026-09-03T00:00:00Z"
    },
    "crew-rebound": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:1.0", "pane_id": "%2", "session": "demo/seat",
      "server_epoch": "$EPOCH", "crew": true, "registered_at": "2026-09-03T00:00:00Z"
    }
  }
}
REGISTRY
# Mock tmux: %2 alive but at demo/seat:3.0 (different from registered :1.0)
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
set -uo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions)
    printf 'demo/seat\t%s\n' "$TAP_SERVER_EPOCH"
    exit 0 ;;
  list-panes)
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/seat)
        printf 'demo/seat\tdemo/seat:0.0\t%%1\tcodex\t100\t%s\t0\n' "$TAP_SERVER_EPOCH"
        printf 'demo/seat\tdemo/seat:3.0\t%%2\tcodex\t101\t%s\t0\n' "$TAP_SERVER_EPOCH"
        ;;
    esac
    exit 0 ;;
  display-message) printf '\n'; exit 0 ;;
esac
exit 0
TMUX
chmod +x "$WORK/bin/tmux"
out="$(bash "$ROOT/bin/tap" team refresh --json 2>/dev/null)"
echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-rebound' in kept, f'address_rebound: crew-rebound wrongly trimmed! kept={kept} trimmed={trimmed}'
assert 'crew-rebound' not in trimmed, f'address_rebound: crew-rebound should NOT be trimmed'
" || fail "ARM 6 (address_rebound): live crew pane was collected"

# --- ARM 7: harness_exited keeps live crew (counterexample) ---
# Crew pane %2 is alive (tmux reports it) but the harness process has exited.
# The observer returns offline:harness_exited. This must NOT collect.
cat > "$TAP_REGISTRY" <<REGISTRY
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "driver": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:0.0", "pane_id": "%1", "session": "demo/seat",
      "server_epoch": "$EPOCH", "registered_at": "2026-09-03T00:00:00Z"
    },
    "crew-harness-exited": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:1.0", "pane_id": "%2", "session": "demo/seat",
      "server_epoch": "$EPOCH", "crew": true, "registered_at": "2026-09-03T00:00:00Z"
    }
  }
}
REGISTRY
# Mock tmux: %2 alive but running zsh (harness exited, shell remains)
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
set -uo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions)
    printf 'demo/seat\t%s\n' "$TAP_SERVER_EPOCH"
    exit 0 ;;
  list-panes)
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/seat)
        printf 'demo/seat\tdemo/seat:0.0\t%%1\tcodex\t100\t%s\t0\n' "$TAP_SERVER_EPOCH"
        printf 'demo/seat\tdemo/seat:1.0\t%%2\tzsh\t101\t%s\t0\n' "$TAP_SERVER_EPOCH"
        ;;
    esac
    exit 0 ;;
  display-message) printf '\n'; exit 0 ;;
esac
exit 0
TMUX
chmod +x "$WORK/bin/tmux"
# ps mock: harness pid not running codex
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
printf ' 100 100 100 codex node /opt/cursor-agent/index.js\n'
PS
chmod +x "$WORK/bin/ps"
out="$(bash "$ROOT/bin/tap" team refresh --json 2>/dev/null)"
echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
trimmed = {r['handle'] for r in d['trimmed']}
kept = {r['handle'] for r in d['kept']}
assert 'crew-harness-exited' in kept, f'harness_exited: crew wrongly trimmed! kept={kept} trimmed={trimmed}'
assert 'crew-harness-exited' not in trimmed, f'harness_exited: crew should NOT be trimmed'
" || fail "ARM 7 (harness_exited): live crew pane was collected"
rm -f "$WORK/bin/ps"

echo "crew-refresh-collection: retained offline, dead, rebound and exited crew: ok"
