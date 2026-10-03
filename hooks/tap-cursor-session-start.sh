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
# Safety: always exits 0.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A release artifact has no Bun on PATH; its libexec/tap/bun runs the compiled router as Bun.
if [ -x "$REPO/libexec/tap/bun" ]; then exec "$REPO/libexec/tap/bun" "$REPO/runtime/bun/src/session-start.ts" cursor; fi
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$REPO/runtime/bun/src/session-start.ts" cursor
