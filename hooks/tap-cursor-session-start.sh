#!/bin/bash
# tap-cursor-session-start.sh — Cursor sessionStart adapter for TAP (tap-o6e).#
# A per-turn UserPromptSubmit roster line was never live here: a second
# registration on `beforeSubmitPrompt` was added and then removed again,
# because that event discards `additional_context` and so has no field a hook
# can inject through. `install.sh` de-wires any stray leftover, and
# `runtime/bun/test/roster-hook-cleanup.test.ts` fails if it is ever re-added. The
# same roster line was later removed from every harness that DID carry it
# (Claude, Codex) as tap-hx4r.
#
# Cursor (~/.cursor/hooks.json) has sessionStart with stdout JSON:
#   {"additional_context":"...","env":{...}}
# Proven model-visible on the CLI path TAP launches (`cursor-agent --force
# --sandbox disabled --workspace <cwd>`): see
# skills/tap/scripts/smoke/cursor-sessionstart-visibility.recipe.sh.
#
# Cursor's hook JSON supplies workspace_roots (not cwd). PWD at hook time is
# often ~/.cursor — NEVER use PWD when workspace_roots is set (PR-5 class).
# Root resolution (AUTHORITATIVE):
#   1. If workspace_roots is non-empty: walk UP from each listed root. If
#      none yields a session root → SILENCE (no PWD fall-through — a non-TAP workspace whose shell cwd sits inside a
#      TAP checkout must not inject that repo's identity).
#   2. If workspace_roots is absent/empty: walk up from PWD (only then).
#   3. No session root → silence.
#
# runtime/bun/src/session-start.ts implements this resolution, the bind and
# the context, and prints {"additional_context": ...}.
# Safety: always exits 0, whatever Bun or the checkout does. Without Bun it is
# silent; when TAP cannot run it says so in one stderr line and stays out of the way.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Bun runs as a child, never exec'd: a checkout that cannot load (a pull in
# progress, a syntax error, a missing module) fails before any catch in the
# entry, and the host agent must not inherit that failure. stdout passes through
# untouched; stderr is held back so a Bun stack trace never reaches the agent.
tap_hook_run() {
  local err rc
  { err="$("$@" 2>&1 >&3 3>&-)"; rc=$?; } 3>&1
  [ "$rc" = 0 ] || return "$rc"
  [ -z "$err" ] || printf '%s\n' "$err" >&2
}
# A release artifact has no Bun on PATH; its libexec/tap/bun runs the compiled router as Bun.
bun="$REPO/libexec/tap/bun"
[ -x "$bun" ] || bun="$(command -v bun 2>/dev/null)" || exit 0
# The session's directory is not TAP's project, but a bare Bun would load its
# bunfig.toml (preload scripts run before the entry file) and its .env. Name
# TAP's own config and turn the env file off; a release artifact's shim is left
# as it is. Bun exits on a config path it cannot read, so a missing file becomes
# the empty device.
bun_flags=()
if [ "$bun" != "$REPO/libexec/tap/bun" ]; then
  bun_config="$REPO/runtime/bun/tap-bunfig.toml"
  [ -f "$bun_config" ] || bun_config=/dev/null
  bun_flags=(--config="$bun_config" --no-env-file)
fi
tap_hook_run "$bun" ${bun_flags[@]+"${bun_flags[@]}"} "$REPO/runtime/bun/src/session-start.ts" cursor && exit 0
echo "tap: sessionStart hook skipped: TAP could not run from $REPO (your agent is unaffected). Fix: run 'tap doctor', or rerun $REPO/install.sh" >&2
exit 0
