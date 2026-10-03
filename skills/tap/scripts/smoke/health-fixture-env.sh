#!/usr/bin/env bash
# Shared by the health smoke and the bounded Darwin parity probe.
health_fixture_path() {
  if [ -n "${TAP_SMOKE_BUN:-}" ] && [ -x "$TAP_SMOKE_BUN" ]; then
    PATH="$PATH:$(dirname "$TAP_SMOKE_BUN")"; export PATH
  fi
}
health_no_server_root() {
  mktemp -d "$TMUX_TMPDIR/health.XXXXXX"
}
