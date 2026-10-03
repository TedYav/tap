#!/usr/bin/env bash
# crew-not-sparable.test.sh — crew handles in --only/--except are a usage_error
# naming the parent and tap crew remove (tap-7ph7f). All five session verbs
# (down/up/shutdown/attach/detach) refuse the same way.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-crew-sparable.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/userhome/bus/payloads" "$WORK/userhome/bus/receipts" "$WORK/bin"

export TAP_HOME="$WORK/userhome" PATH="$WORK/bin:$PATH"
TAP_REGISTRY="$WORK/userhome/registry.json"
export TAP_REGISTRY

EPOCH="srv:1:1"
export TAP_SERVER_EPOCH="$EPOCH"

fail() { echo "crew-not-sparable: $1" >&2; exit 1; }

cat > "$TAP_REGISTRY" <<REGISTRY
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "driver": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:0.0", "pane_id": "%1", "session": "demo/seat",
      "server_epoch": "$EPOCH", "registered_at": "2026-09-03T00:00:00Z"
    },
    "helper": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "demo/seat:1.0", "pane_id": "%2", "session": "demo/seat",
      "server_epoch": "$EPOCH", "crew": true, "registered_at": "2026-09-03T00:00:00Z"
    }
  }
}
REGISTRY

# Mock tmux: session alive, both panes alive.
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
set -uo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  has-session) exit 0 ;;
  list-sessions) printf 'demo/seat\t%s\n' "$TAP_SERVER_EPOCH"; exit 0 ;;
  list-panes)
    shift; target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    printf 'demo/seat\tdemo/seat:0.0\t%%1\tcodex\t100\t%s\t0\n' "$TAP_SERVER_EPOCH"
    printf 'demo/seat\tdemo/seat:1.0\t%%2\tcodex\t101\t%s\t0\n' "$TAP_SERVER_EPOCH"
    exit 0 ;;
  display-message) printf '\n'; exit 0 ;;
esac
exit 0
TMUX
chmod +x "$WORK/bin/tmux"

# --- ARM 1: --only <crew> on down → usage_error ---
rc=0
out="$(bash "$ROOT/bin/tap" team down --only helper 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "ARM 1 (--only crew on down): exit $rc, expected 1"
echo "$out" | grep -qi 'crew' || fail "ARM 1: error message does not mention crew"
echo "$out" | grep -qi 'tap crew remove' || fail "ARM 1: error message does not mention tap crew remove"

# --- ARM 2: --only <teammate> on down → plans the session kill despite crew co-tenant ---
# The teammate hosts crew; before the fix, this said "no seats matched" because the
# crew co-tenant protected the session. Now the crew is transparent to session
# protection (tap-7ph7f).
rc=0
out="$(bash "$ROOT/bin/tap" team down --only driver --dry-run 2>&1)" || rc=$?
echo "$out" | grep -qi 'crew.*not.*independent' && fail "ARM 2 (--only teammate): got crew usage_error for teammate"
echo "$out" | grep -qi 'no seats matched' && fail "ARM 2 (--only teammate): crew co-tenant still protecting the session"
echo "$out" | grep -qi 'kill session' || echo "$out" | grep -qi 'plan for team' || fail "ARM 2 (--only teammate): plan does not name a session kill"

# --- ARM 3: --except <crew> on shutdown → usage_error ---
rc=0
out="$(bash "$ROOT/bin/tap" team shutdown --except helper 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "ARM 3 (--except crew on shutdown): exit $rc, expected 1"
echo "$out" | grep -qi 'crew' || fail "ARM 3: error message does not mention crew"

echo "crew-not-sparable: down/shutdown crew gate: ok"
