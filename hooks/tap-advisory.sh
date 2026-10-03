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
# Safety: always exits 0.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A release artifact has no Bun on PATH; its libexec/tap/bun runs the compiled router as Bun.
if [ -x "$REPO/libexec/tap/bun" ]; then exec "$REPO/libexec/tap/bun" "$REPO/runtime/bun/src/session-start.ts" claude; fi
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$REPO/runtime/bun/src/session-start.ts" claude
