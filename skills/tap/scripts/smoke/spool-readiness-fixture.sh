#!/usr/bin/env bash
. "${BASH_SOURCE[0]%/*}/native-authority-fixture.sh"
# Test-only readiness observation. Production reads readiness in-process
# (spool-drain-effects.ts `realDrainEffects` -> spool-readiness.ts `readPaneReady`);
# smokes that assert a pane's classification as a fixture premise, or as the
# end-to-end walk over a real capture, call the native reader through a test-only entry point here.
# Preserve the router bit: whether this shell's tmux is the one the native
# reader would ask still reaches the bound-identity check. Source after lib.sh.
#
# spool_pane_ready_fixture <pane> <pane_id> <handle> <to_team> <registry> [policy]
#   -> ready|unsafe|busy|busy:*|gone
spool_pane_ready_fixture() {
  local router=0; fixture_router_representable || router=$?
  tap_bun_call spool-readiness "$3" ../test/fixtures/readiness.ts "$router" "$TAP_HOME" "$@"
}

# Triple-check a previously bound pane identity, as the retired lib.sh adapter did.
# `match` means registry(handle).pane/pane_id still equal the bound values and
# tmux reports that same pane_id live. Every other result is fail-closed.
# Production reads it in-process (observe-gather.ts `boundPaneIdentityState`).
#
# bound_pane_identity_fixture <registry> <handle> <bound_pane> <bound_pane_id>
bound_pane_identity_fixture() {
  local router=0; fixture_router_representable || router=$?
  tap_bun_call bound-pane "$2" observe.ts --bound-pane "$router" "$@"
}
