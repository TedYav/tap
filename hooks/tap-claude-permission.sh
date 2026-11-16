#!/bin/bash
# tap-claude-permission.sh — Claude PermissionRequest adapter for TAP, observe only.
#
# Claude Code runs this when it is about to ask a human to approve a tool call
# or answer a question. runtime/bun/src/claude-permission-hook.ts records what
# a registered TAP seat is waiting on, so `tap team` can say so. It never
# answers: the terminal prompt appears and behaves exactly as it does without TAP.
#
# INSTALLED USER-LEVEL, BY ABSOLUTE PATH, like tap-advisory.sh, so it runs in
# EVERY Claude session on the machine. Outside a registered seat's bound
# session the entry writes nothing.
#
# Safety: always exits 0 and never writes to stdout, whatever Bun or the
# checkout does. Claude reads a decision only from stdout, so an adapter with
# no stdout cannot allow or deny anything. Without Bun it is silent; when TAP
# cannot run it says so in one stderr line and stays out of the way.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Bun runs as a child, never exec'd: a checkout that cannot load (a pull in
# progress, a syntax error, a missing module) fails before any catch in the
# entry, and the host agent must not inherit that failure. stdout is discarded;
# stderr is held back so a Bun stack trace never reaches the agent.
tap_hook_run() {
  local err rc
  err="$("$@" 2>&1 >/dev/null)"; rc=$?
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
tap_hook_run "$bun" ${bun_flags[@]+"${bun_flags[@]}"} "$REPO/runtime/bun/src/claude-permission-hook.ts" && exit 0
echo "tap: PermissionRequest hook skipped: TAP could not run from $REPO (your agent is unaffected). Fix: run 'tap doctor', or rerun $REPO/install.sh" >&2
exit 0
