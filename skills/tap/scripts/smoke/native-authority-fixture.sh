#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/runtime-primitives.sh"
# Shell tests use native authority directly after the production Bash adapters retire.
# Source after lib.sh; decisions remain in the imported Bun owners.
native_authority_fixture() {
  "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" "$@"
}
spool_team_fixture() { native_authority_fixture team; }
acting_registry_fixture() { native_authority_fixture registry "${1:-}"; }
# A shell-only fixture premise: native children cannot inherit an injected function.
# lib.sh records the deadline wrapper's body when it creates that transport.
fixture_router_representable() {
  [ -n "${_TAP_TMUX_BODY:-}" ] || return 1
  [ "$(declare -f tmux)" = "$_TAP_TMUX_BODY" ]
}
