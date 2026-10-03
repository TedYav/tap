#!/usr/bin/env bash
# inputline-locale.test.sh — tap-bg19: lib.sh pins a UTF-8 character locale
# without discarding what the caller's locale expressed.
#
# Field failure (2026-07-24, fleet-wide): a launchd-started tmux server inherits no
# interactive shell environment, so panes ran with LANG unset. In the C locale sed
# bracket expressions match bytes, so the prompt-glyph strip removed 1 of the
# glyph's 3 UTF-8 bytes and left 2 bytes of residue, and the readiness gate parked
# every delivery as `pending-input`.
#
# The prompt readers are native now (runtime/bun/src/pane/geometry.ts spells the
# accepted separators as explicit code points), so no locale can reproduce that
# residue; pane-reader.test.ts pins the per-separator reads. What stays Bash is
# lib.sh's own ctype pin, which the arms below hold to its contract.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
fail() { echo "inputline-locale: $1" >&2; exit 1; }

# (1) The field case: a caller with NO locale gets a UTF-8 ctype.
got="$(env -u LANG -u LC_ALL -u LC_CTYPE bash -c 'source "$1" >/dev/null 2>&1; printf "%s|%s" "${LC_ALL:-}" "$LC_CTYPE"' _ "$LIB")"
[ "$got" = "|en_US.UTF-8" ] || fail "(1) unset-locale caller was not pinned: got '$got'"
echo "inputline-locale: (1) unset-locale caller -> UTF-8 ctype: ok"

# (2) LC_ALL outranks LC_CTYPE in POSIX, so a caller carrying LC_ALL=C must not be
# able to defeat the pin; a bare `export LC_CTYPE=...` does NOT survive it.
got="$(env -u LANG -u LC_CTYPE LC_ALL=C bash -c 'source "$1" >/dev/null 2>&1; printf "%s|%s" "${LC_ALL:-}" "$LC_CTYPE"' _ "$LIB")"
[ "$got" = "|en_US.UTF-8" ] || fail "(2) LC_ALL=C caller defeated the ctype pin: got '$got'"
echo "inputline-locale: (2) LC_ALL=C caller cannot defeat the pin: ok"

# (4) The pin buys a CAPABILITY (character-wise matching), so it must not overwrite
# a caller who already has one. Deliberately a NON-en_US value: asserting that
# en_US.UTF-8 survives would pass even against unconditional clobbering.
got="$(env -u LANG -u LC_ALL LC_CTYPE=ja_JP.UTF-8 bash -c 'source "$1" >/dev/null 2>&1; printf "%s" "$LC_CTYPE"' _ "$LIB")"
[ "$got" = "ja_JP.UTF-8" ] || fail "(4) caller's own UTF-8 locale was clobbered: expected ja_JP.UTF-8, got '$got'"
echo "inputline-locale: (4) caller's non-en_US UTF-8 locale preserved: ok"

# (5) Exploding LC_ALL must not silently discard what it expressed for the other
# categories — the caller's language stays theirs everywhere tap does not need UTF-8.
got="$(env -u LANG -u LC_CTYPE LC_ALL=ja_JP.UTF-8 bash -c 'source "$1" >/dev/null 2>&1; printf "%s|%s" "$LC_TIME" "$LC_COLLATE"' _ "$LIB")"
[ "$got" = "ja_JP.UTF-8|ja_JP.UTF-8" ] || fail "(5) LC_ALL categories lost on explode: got '$got'"
echo "inputline-locale: (5) LC_ALL exploded into other categories, not discarded: ok"

echo "inputline-locale: ok"
