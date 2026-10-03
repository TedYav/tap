#!/usr/bin/env bash
# darwin-residue-gate.sh — the driver-run macOS residue gate (tap-1bus0 piece 2).
# Thin entry only: it pins TAP state and a scratch HOME the way sandbox-pins.sh
# does for smokes (that file is Bash, and AGENTS.md needs one stable command), then
# runs the Bun body, which owns the deadline and receipt. The platform probe uses
# only private no-server tmux sockets; no live bus or slot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-darwin-residue-home.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/index"
export HOME="$WORK/home" TAP_INDEX_HOME="$WORK/index" TAP_HOME="$WORK/bus" \
  TAP_SESSION_MANIFEST="$WORK/sessions.json" OPENCODE_DB_PATH="$WORK/opencode.db" \
  TAP_VERSION_SEEN_PATH="$WORK/version-seen.json" EPISODIC_MEMORY_SUMMARIZER_GUARD=1
unset TAP_SELF TAP_TEAM
bun "$ROOT/runtime/bun/src/darwin-residue-gate.ts" "$ROOT"
