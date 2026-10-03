#!/usr/bin/env bash
# D5: path-reference — the census ref :53-54 asserts the path string tap_bun_call builds for a selected Bun; the fake bun (:47-51) only echoes argv so that arm execs no module — :34 execs delivery-clock only as the wrapper's real-module payload, and the path computation it prints is owned by runtime/bun/test/delivery-clock.test.ts:40,42
# Runtime fixture setup must not load the production engine or replace a router.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${WORK:?}"' EXIT
trap 'printf "runtime-helpers: failed at line %s\n" "$LINENO" >&2' ERR

# Ordinary helper users do not opt into the runtime environment.
! declare -F tap_bun_call >/dev/null
! declare -F tap_ensure_dirs >/dev/null

tmux() { printf 'fixture-router\n'; }
export TAP_HOME="$WORK/bus" LC_ALL=C
saved_index="$TAP_INDEX_HOME"
saved_config="$XDG_CONFIG_HOME"
tap_smoke_runtime
[ "$(tmux display-message)" = fixture-router ]
[ "$TAP_INDEX_HOME" = "$saved_index" ]
[ "$XDG_CONFIG_HOME" = "$saved_config" ]
[ -z "${LC_ALL:-}" ]
case "$LC_CTYPE" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;; *) exit 1 ;; esac
! declare -F tap_acting_registry >/dev/null
! declare -F tap_require_bus_root >/dev/null
[ ! -e "$TAP_HOME" ]
tap_ensure_dirs
[ -d "$TAP_PAYLOADS" ] && [ -d "$TAP_RECEIPTS" ]
[ -s "$TAP_HOME/.tap-bus-authority" ]
printf 'preserved\n' > "$TAP_HOME/.tap-bus-authority"
tap_ensure_dirs
[ "$(cat "$TAP_HOME/.tap-bus-authority")" = preserved ]
[ "$(tap_bun_call delivery-clock fixture delivery-clock.ts path "$TAP_REGISTRY" peer)" = "$TAP_HOME/delivery/peer.json" ]

# A second fixture bus recomputes all derived paths without reapplying pins.
export TAP_HOME="$WORK/other-bus"
tap_smoke_runtime
tap_ensure_dirs
[ "$TAP_PAYLOADS" = "$TAP_HOME/payloads" ]
[ "$TAP_SPOOL" = "$TAP_HOME/spool" ]
[ -s "$TAP_HOME/.tap-bus-authority" ]
printf 'runtime-helpers: explicit setup, native calls, locale and router preservation: ok\n'

# The runner forwards an absolute Bun path even when PATH cannot find Bun.
fixture_bun="$WORK/selected bun"
cat > "$fixture_bun" <<'BUN'
#!/bin/sh
printf '%s\n' "$@"
BUN
chmod +x "$fixture_bun"
selected="$(PATH="$WORK/no-bin" TAP_SMOKE_BUN="$fixture_bun" tap_bun_call override fixture selected.ts payload)"
[ "$selected" = "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/selected.ts
payload" ]

# An explicit invalid override refuses; it must not silently choose another Bun.
printf 'not executable\n' > "$WORK/not-executable"
if TAP_SMOKE_BUN="$WORK/not-executable" tap_bun_call override fixture selected.ts 2>"$WORK/runtime-error"; then
  echo 'runtime-helpers: accepted an invalid Bun override' >&2
  exit 1
fi
grep -q 'runtime_missing id=fixture slice=override' "$WORK/runtime-error"
printf 'runtime-helpers: runner Bun override is authoritative: ok\n'
