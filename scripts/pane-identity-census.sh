#!/usr/bin/env bash
# Read-only acceptance instrument; native registry and tmux owners make decisions.
exec bun "$(dirname "${BASH_SOURCE[0]}")/../runtime/bun/src/pane-census.ts" "$@"
