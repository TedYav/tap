#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/runtime-primitives.sh"
# Test-only canonical placement. Production places through the native courier
# (runtime/bun/src/courier.ts canonicalPlace); fixtures that need a message on
# the bus call the same owner here. Source after lib.sh.
#
# canonical_place_fixture <src> <id> <from> <to> <kind> <dest> [xwt] [reply]
#   [from_team] [to_team] [urgency] [reply_to] [in_reply_to]
#   [recipient_instance] [sender_instance]
# <dest> must be <bus>/payloads/<id>.md (tap_payload_path). A refusal exits the
# calling shell through tap_fail, as the retired Bash placement did.
canonical_place_fixture() {
  "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/canonical-place-cli.ts" "$@" \
    || tap_fail 1 error fix_command "canonical_place_fixture: placement refused for ${2:-}"
}
