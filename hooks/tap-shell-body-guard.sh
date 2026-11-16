#!/bin/bash
# tap-shell-body-guard.sh — the shell-body guard's door, registered for every
# harness in both a checkout and a release artifact. It keeps the hook payload on
# stdin and the decision JSON on stdout, the guard's launch contract.
#
# FAIL-OPEN, DELIBERATELY. This hook runs before every shell command of every
# agent on the machine, in every directory. The guard is a convenience for
# projects that use TAP, not a security boundary, so when TAP cannot run (no Bun
# on this agent's PATH, a checkout that does not load) the command is allowed:
# exit 0, one stderr line naming TAP and the fix. Every guard verdict is exit 0
# (an allow prints nothing, a denial prints JSON), so a non-zero status from Bun
# always means the guard itself broke.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/.." && pwd)"
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
if [ ! -x "$bun" ] && ! bun="$(command -v bun 2>/dev/null)"; then
  echo "tap: shell guard skipped: Bun is not on this agent's PATH, so the command ran unchecked. Fix: put Bun on that PATH, or rerun $REPO/install.sh" >&2
  exit 0
fi
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
tap_hook_run "$bun" ${bun_flags[@]+"${bun_flags[@]}"} "$here/tap-shell-body-guard.ts" "$@" && exit 0
echo "tap: shell guard skipped: TAP could not run from $REPO, so the command ran unchecked. Fix: run 'tap doctor', or rerun $REPO/install.sh" >&2
exit 0
