#!/bin/bash
# tap-codex-session-start.sh — Codex SessionStart adapter for TAP.
#
# Codex (codex-cli >= 0.144) injects [[hooks.SessionStart]] stdout as developer
# context. runtime/bun/src/session-start.ts resolves the session root from the
# payload's `cwd` (the session's working directory, NOT this script's checkout)
# and wraps the context once in Codex's shape:
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
# Outside a TAP repo it emits nothing (accepted by Codex). The one-shot /tap-self
# compact focus capsule this hook once restored is gone (tap-thgv).
# Safety: always exits 0.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A release artifact has no Bun on PATH; its libexec/tap/bun runs the compiled router as Bun.
if [ -x "$REPO/libexec/tap/bun" ]; then exec "$REPO/libexec/tap/bun" "$REPO/runtime/bun/src/session-start.ts" codex; fi
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$REPO/runtime/bun/src/session-start.ts" codex
