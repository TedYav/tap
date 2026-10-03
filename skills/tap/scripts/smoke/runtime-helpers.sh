#!/usr/bin/env bash
# D5: fixture-door — skills/tap/scripts/smoke/runtime-helpers.sh:35-43: pure execution-wrapper library — tap_bun_call there execs runtime/bun/src modules on behalf of the consumer test files, which own every assertion; this file has none of its own
# Explicit test-fixture runtime setup. Source after sandbox-pins and after
# choosing TAP_HOME. Production decisions are reached through native bridges.
# helpers.sh exposes this through tap_smoke_runtime; direct sourcing also works
# for child shells that must retain the fixture's existing environment pins.

_TAP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Preserve lib.sh's character-classification contract for captured pane text.
if [ -z "${TAP_SKIP_LOCALE_PIN:-}" ]; then
  # POSIX precedence is LC_ALL > LC_CTYPE > LANG, so a caller carrying LC_ALL=C
  # would silently defeat a bare LC_CTYPE pin — the same environment-coincidence
  # this block exists to end. Preserve what LC_ALL was expressing for every OTHER
  # category, then clear it so the ctype pin can take effect.
  if [ -n "${LC_ALL:-}" ]; then
    : "${LC_COLLATE:=$LC_ALL}" "${LC_MONETARY:=$LC_ALL}" "${LC_NUMERIC:=$LC_ALL}"
    : "${LC_TIME:=$LC_ALL}" "${LC_MESSAGES:=$LC_ALL}"
    export LC_COLLATE LC_MONETARY LC_NUMERIC LC_TIME LC_MESSAGES
    _tap_ctype="$LC_ALL"
    unset LC_ALL
  else
    _tap_ctype="${LC_CTYPE:-}"
  fi
  # ANY UTF-8 ctype already gives character-wise matching, which is all tap needs,
  # so a caller who chose ja_JP.UTF-8 keeps it. Only an absent or non-UTF-8 ctype
  # is replaced — pin the capability, never the caller's language.
  case "$_tap_ctype" in
    *[Uu][Tt][Ff]8*|*[Uu][Tt][Ff]-8*) export LC_CTYPE="$_tap_ctype" ;;
    *)                                export LC_CTYPE="${TAP_LC_CTYPE:-en_US.UTF-8}" ;;
  esac
  unset _tap_ctype
fi

if ! declare -F tap_bun_call >/dev/null; then
tap_bun_call() { # <slice> <id> <module-relative-to-runtime/bun/src> [<args>...]
  local slice="$1" id="$2" module="$3" bun_bin
  shift 3
  # smoke-all preserves this executable before sanitizing PATH.
  bun_bin="$(command -v "${TAP_SMOKE_BUN:-bun}")" && [ -x "$bun_bin" ] || {
    printf 'tap: runtime_missing id=%s slice=%s: install bun\n' "$id" "$slice" >&2
    return 1
  }
  "$bun_bin" "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/$module" "$@" || {
    printf 'tap: slice_failed id=%s slice=%s: classification failed\n' "$id" "$slice" >&2
    return 1
  }
}
fi

# Preserve a fixture-injected private tmux router.
if ! declare -F tmux >/dev/null; then
  tmux() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/tmux-cli.ts" "$@"; }
  _TAP_TMUX_BODY="$(declare -f tmux)"
fi

# Fixture buses are explicit. Never infer a bus from the checkout or run the
# production location/legacy-store guards while arranging test data.
if [ -n "${TAP_HOME:-}" ]; then
  case "$TAP_HOME" in
    /*) ;;
    *) printf 'tap smoke: fixture TAP_HOME must be absolute\n' >&2; return 1 ;;
  esac
  while [ "$TAP_HOME" != / ] && [ "${TAP_HOME%/}" != "$TAP_HOME" ]; do
    TAP_HOME="${TAP_HOME%/}"
  done
  TAP_HOME="$(cd "$TAP_HOME" 2>/dev/null && pwd -P || printf '%s' "$TAP_HOME")"
  TAP_PAYLOADS="$TAP_HOME/payloads"
  TAP_RECEIPTS="$TAP_HOME/receipts"
  TAP_REGISTRY="$TAP_HOME/registry.json"
  TAP_INPUT_BACKUPS="$TAP_HOME/input-backups"
  TAP_REGISTRY_EVENTS="$TAP_HOME/registry-events.log"
  TAP_SPOOL="$TAP_HOME/spool"
  TAP_WATCH_LOGS="$TAP_HOME/watch/evaluator-prompts"
  TAP_HANDOFF="$TAP_HOME/handoff"
fi

. "${BASH_SOURCE[0]%/*}/runtime-primitives.sh"

# Fixture-only adapters into the native owners, never a shell policy copy.
tap_registry_v20_state_load() { _TAP_V20_STATE_VAL="$("${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" marker)"; }
tap_registry_v20_live() { tap_registry_v20_state_load && [ "$_TAP_V20_STATE_VAL" = live ]; }
tap_server_epoch_now() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" epoch; }
tap_server_epoch_from_raw() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" epoch-raw "$1"; }
tap_harness_family() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" harness-family "$1"; }
tap_classify_harness() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" harness-class "$1"; }
tap_pane_harness_command() { "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/authority-cli.ts" pane-harness "$1"; }
TAP_PENDING_INPUT_CAP_BYTES="${TAP_PENDING_INPUT_CAP_BYTES:-4096}"

# Input-protection fixture adapters: records are the product's own
# bytes under "$TAP_INDEX_HOME/input-protection", minted on the REAL clock,
# while fixture drains run the fake clock — so fixtures simulate the waiter
# outcome instead of hand-rolling records (the file name is a socket+pane
# hash owned by input-protection.ts).
tap_protection_release_all() { # draft gone: the waiter's two bare samples >=250ms apart deleted the pane's records
  rm -rf "${TAP_INDEX_HOME:?}/input-protection"
}
tap_protection_age_all() { # draft still present: move every record's deadline into the past, as the real clock would between a park and a forced deadline
  local past="${1:?past epoch milliseconds}" dir="${TAP_INDEX_HOME:?}/input-protection" f n=0
  # Refusable instrument: aging ZERO records is not success — a caller whose
  # park never minted a record must fail loudly here, or its forced drain
  # silently mints a fresh real-clock grace and the arm pins the wrong world.
  [ -d "$dir" ] || return 1
  for f in "$dir"/*.json; do
    [ -e "$f" ] || break
    sed -i.bak -E "s/\"graceUntil\":[0-9]+/\"graceUntil\":$past/g; s/\"snoozeUntil\":[0-9]+/\"snoozeUntil\":0/g" "$f" || return 1
    rm -f "$f.bak"
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || return 1
}
tap_protection_seed_expired() { # forced deadline with no park-time record: seed the EXPIRED grace the real clock would have left, through the product's own writer (input-protection-seed.ts); exits nonzero when it writes nothing
  "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/test/support/input-protection-seed-cli.ts" "$@"
}
