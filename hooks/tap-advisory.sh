#!/bin/bash
# tap-advisory.sh — Claude SessionStart adapter for TAP.
#
# runtime/bun/src/session-start.ts owns root discovery, the bind and the
# context. The launcher's pane evidence (TAP_LAUNCH_ROOT plus a matching
# incarnation token) wins when it validates. Otherwise, for Claude,
# CLAUDE_PROJECT_DIR is AUTHORITATIVE when set (a session root there or
# silence, never a PWD walk-up that would inject another repo's bus); unset, it
# walks up from PWD. Raw stdout becomes SessionStart context.
#
# INSTALLED USER-LEVEL, BY ABSOLUTE PATH, DELIBERATELY (ruling tap-pkoq,
# 2026-08-14). TAP is machine-scoped: a seat can be launched in any tree, so a
# repo-level opt-in would strand every seat working outside a repo that opted in.
# This file therefore runs on EVERY Claude session on the machine, and the
# entry's silence outside a TAP session root is load-bearing. The absolute path
# pins it to the primary checkout: a $CLAUDE_PROJECT_DIR spelling would resolve
# to whichever worktree a session sits in, and a worktree can be reaped
# mid-session. Registering it a second time per repo used to register each seat
# twice (tap-wolp); keep one registration.
#
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
tap_hook_run "$bun" ${bun_flags[@]+"${bun_flags[@]}"} "$REPO/runtime/bun/src/session-start.ts" claude && exit 0
echo "tap: SessionStart hook skipped: TAP could not run from $REPO (your agent is unaffected). Fix: run 'tap doctor', or rerun $REPO/install.sh" >&2
exit 0
