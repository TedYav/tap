#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/native-authority-fixture.sh"
# Test-only spool park seeding. Production parks through the native
# spool-park-report transaction (tap send, or tap_spool_park_placed); fixtures
# that need a bare pair with explicit facts call the same native pair writer
# (runtime/bun/src/spool-publication.ts `add`) here. Source after lib.sh.
#
# spool_park_fixture <id> <canonical-payload> <target> <team> <reason>
#   [<reason_class>] [<timeout_seconds>] [<pane>] [<pane_id>] [<to_team>]
#   [<policy>] [<grace_seconds>] [<target_registry>] [<cue_style>] [<cue_red_at>]
# The window and the recipient's last-delivered clock are resolved the way the
# native park resolves them (runtime/bun/test/support/delivery-window-cli.ts, delivery-clock.ts read).
spool_park_fixture() {
  local team="${4:-}" acting window last_delivered
  acting="$(spool_team_fixture 2>/dev/null || true)"
  [ -n "$team" ] || team="$acting"
  window="$(tap_bun_call digest-window "${3:-window}" ../test/support/delivery-window-cli.ts \
    "${11:-standard}" "${10:-$acting}" "$3" "$("${TAP_SMOKE_BUN:-bun}" "${BASH_SOURCE[0]%/*}/../../../../runtime/bun/test/support/envelope-field-cli.ts" "$2" reply)" "$acting")"
  last_delivered="$(tap_bun_call delivery-clock "$3" delivery-clock.ts read "${13:-}" "$3" 2>/dev/null || true)"
  tap_bun_call spool-publication "$1" spool-publication.ts add "$TAP_SPOOL" "$1" "$2" "$3" "$team" "$5" \
    "${6:-}" "${7:-}" "${8:-}" "${9:-}" "${10:-}" "${11:-standard}" "${12:-}" "${13:-}" \
    "$window" "$last_delivered" "${14:-}" "${15:-}"
}
