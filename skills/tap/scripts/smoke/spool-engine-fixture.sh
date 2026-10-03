#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/native-authority-fixture.sh"
# Test-only spool engine entrance. Production drains in-process (the spool waiter
# and the watch tick call spool-engine.ts directly); smokes that drive one pass
# from a shell call the same native engine here. This is the retired lib.sh
# adapter's body, kept verbatim: the completion token distinguishes a
# silent/broken runtime from a successful no-op. Source after lib.sh.
#
# spool_engine_fixture <op> [args...]   op: drain|redeliver|digest|retired|repair|watch
spool_engine_fixture() {
  local answer rc=0
  answer="$(tap_bun_call spool-drain "${2:--}" spool-engine.ts --receipt --facts \
    "$_TAP_SCRIPT_DIR" "$TAP_HOME" "$TAP_SPOOL" "$TAP_PAYLOADS" "$TAP_RECEIPTS" "$TAP_REGISTRY_EVENTS" \
    "$(spool_team_fixture)" "$(acting_registry_fixture 2>/dev/null || true)" "${TAP_VERB:-tap}" "${TAP_COURIER_IDENTITY:-courier}" \
    "${TAP_SPOOL_DRAIN_ACTIVE:-0}" "${TAP_SPOOL_HUMAN_ALERT:-}" \
    "${TAP_WATCH_TICK_QUEUED_PROBE_ID:-}" "${TAP_WATCH_TICK_PROBE_TIMEOUT:-}" "${TAP_BUS_RULE:-}" "$@")" || return 1
  case "$answer" in
    spool-engine$'\t'*) rc="${answer#*$'\t'}" ;;
    *) printf 'tap: slice_failed id=- slice=spool-drain: missing completion token\n' >&2; return 1 ;;
  esac
  case "$rc" in ''|*[!0-9]*) return 1 ;; esac
  [ "$rc" -le 255 ] || return 1
  return "$rc"
}

# spool_drain_fixture_once [now_epoch] [cap] [target] [target_registry]
spool_drain_fixture_once() {
  spool_engine_fixture drain "${1:-${TAP_SPOOL_NOW:-}}" "${2:-${TAP_SPOOL_DRAIN_CAP:-}}" "${3:-}" "${4:-}"
}
