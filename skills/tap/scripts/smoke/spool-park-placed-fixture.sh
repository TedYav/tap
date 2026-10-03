#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/native-authority-fixture.sh"
# Test-only park of an already-placed canonical through the full native park
# route: runtime/bun/src/spool-park-report.ts `park-report` (the A1b transaction,
# cue, deliverer spawn, backlog), then `park-receipt` (the send receipt). Native
# send calls the same exports in process. Source after lib.sh.
#
# spool_park_placed_fixture <id> <canonical> <from> <to> <kind> <reply> <pane>
#   <pane_id> <to_team> <registry> <reason> <timeout> <policy> <grace> <json>
#   [<cue_style>] [<cue_red_at>]
# The positional order is the retired tap_spool_park_placed's. A refusal verdict
# (spool_busy / spool_publish_failed) exits the calling shell through tap_fail.
# The retired tap_spool_display_state, verbatim: the park receipt's display state.
spool_display_state_fixture() { # <id>
  local router=0; fixture_router_representable || router=$?
  tap_bun_call spool-readiness "$1" spool-readiness.ts observe-display "$router" "$TAP_HOME" "$TAP_SPOOL/$1.meta.json" "${TAP_SPOOL_NOW:-$(date +%s)}"
}

spool_park_placed_fixture() {
  local report verdict detail state=""
  report="$(tap_bun_call spool-park-report "$1" spool-park-report.ts park-report "$TAP_SPOOL" "$TAP_HOME" "$1" "$2" \
    "$3" "$4" "$5" "$6" "$(spool_team_fixture)" "${11}" "${12}" "$7" "${8:-}" \
    "$9" "${10:-}" "${13}" "${14}" "${16:-}" "${17:-}" "$_TAP_SCRIPT_DIR")" \
    || tap_fail 1 spool_publish_failed "inspect with tap show $1" "spool park did not run"
  { IFS= read -r verdict; IFS= read -r detail || true; } <<<"$report"
  [ "$verdict" = ok ] || tap_fail 1 "${verdict:-spool_publish_failed}" "inspect with tap show $1" "$detail"
  [ "${15}" = 1 ] || state="$(spool_display_state_fixture "$1")"
  tap_bun_call spool-park-report "$1" spool-park-report.ts park-receipt "$TAP_HOME" "$detail" "$1" "$3" "$4" "$7" "$5" \
    "$6" "${11}" "${13}" "${15:-0}" "${TAP_VERBOSE:-0}" send "$state"
}
