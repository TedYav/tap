#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# roster-hook-removed.test.sh — tap-hx4r.
#
# The per-turn UserPromptSubmit TAP roster line (tap-he46) was removed from
# every harness that carried it (Claude, Codex — Cursor's attempt never
# worked at all; see the beforeSubmitPrompt arms of
# runtime/bun/test/roster-hook-cleanup.test.ts) per the standing ruling:
# per-turn injection needs a very strong reason, and this one caused the
# worst coordination failure of the night it was live (tap-w1hg).
#
# Same shape as the Cursor fixture, for the same reasons:
#   (1) the installer must never wire it again on Claude or Codex — checked
#       against install.sh text, since the installer is what would reintroduce it.
#   (2) Claude's de-wire must actually remove an entry an earlier version
#       wrote, and must not touch anyone else's — Claude's registration was
#       ADDITIVE (checked for presence, appended if absent), so simply
#       deleting the add-code stops NEW installs but leaves every existing
#       machine spammed forever without an active cleanup step.
#   (3) Codex's removal is verified differently: that block is REBUILT from
#       scratch every install (marker-owned), so the absence of
#       [[hooks.UserPromptSubmit]] from the builder IS the cleanup — proven
#       by driving the real Python block-builder against a fixture config.toml
#       that carries the old entry.
#   (4) the shared emitter (session-start.ts) has no roster mode left to
#       accidentally re-wire into.
set -euo pipefail
# D5: public — this trimmed shell keeps only the public doors: the install.sh
# no-rewire text checks (1), the Codex block-builder exec arm (5), and the
# emitter grep (6). The exec arms of install-roster-hook-cleanup.ts — the
# Claude de-wire byte/permission/idempotency/unwritable/malformed/fault
# behavior (retired lines 85-212) — moved to
# runtime/bun/test/roster-hook-cleanup.test.ts (D5 carve, tap-hx4r).

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DEWIRE="$ROOT/runtime/bun/src/install-roster-hook-cleanup.ts"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "roster-hook-removed: $*" >&2; exit 1; }

# --- (1) install.sh never WIRES UserPromptSubmit with TAP_HOOK_MODE=roster ----
# Not a spelling-specific grep for the old `hooks.append` idiom: `insert(0, …)`,
# `+= […]`, or a setdefault chain would re-wire it and sail past a narrower
# check (review gate — the written-is-not-binding shape, same lesson
# the Cursor fixture already learned). The tight assertion: TAP_HOOK_MODE=roster
# must not appear anywhere in install.sh outside a comment.
_wire_code="$(grep -n 'TAP_HOOK_MODE=roster' "$ROOT/install.sh" | grep -v ':[[:space:]]*#' || true)"
[ -z "$_wire_code" ] \
  || fail "(1) install.sh names TAP_HOOK_MODE=roster on a non-comment line — the retired hook may be getting re-wired: $_wire_code"
grep -q 'install-roster-hook-cleanup.ts" claude' "$ROOT/install.sh" \
  || fail "(1) install.sh no longer calls the Claude de-wire — machines carrying the old entry stay spammed"
grep -q '\[\[hooks\.UserPromptSubmit\]\]' "$ROOT/install.sh" \
  && fail "(1) install.sh's Codex TOML builder still emits [[hooks.UserPromptSubmit]] — the retired arm is back"

# --- (5) Codex's block-builder no longer emits UserPromptSubmit --------------
# Drive the real installer writer against a
# fixture config.toml that already carries the old, ADD-era block — the same
# shape a machine that ran a pre-tap-hx4r install.sh would have on disk.
CODEX_CFG="$WORK/config.toml"
cat > "$CODEX_CFG" <<'TOML'
[hooks]

# tap-managed:begin Codex SessionStart
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/old/path/hooks/tap-codex-session-start.sh"

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "TAP_HOOK_MODE=roster /old/path/hooks/tap-codex-session-start.sh"
# tap-managed:end Codex SessionStart
TOML

# The strict fence owns only current TAP arrays. It refuses retired/unknown
# events rather than treating the marker as permission to delete their bytes.
cp "$CODEX_CFG" "$WORK/codex-before-refusal"
if bun "$ROOT/runtime/bun/src/install-hooks.ts" codex-config "$CODEX_CFG" \
    "/new/path/hooks/tap-codex-session-start.sh" "/new/path/hooks/tap-shell-body-guard.ts"; then
  fail "(5) retired array inside the fence was silently deleted"
fi
cmp "$CODEX_CFG" "$WORK/codex-before-refusal" || fail "(5) refusal changed config"
# After the operator removes the retired array, the known legacy SessionStart
# slice still upgrades normally and never reintroduces UserPromptSubmit.
python3 - "$CODEX_CFG" <<'PYFIX'
from pathlib import Path
import sys
p=Path(sys.argv[1]); raw=p.read_bytes()
a=raw.index(b'[[hooks.UserPromptSubmit]]'); b=raw.index(b'# tap-managed:end',a)
p.write_bytes(raw[:a]+raw[b:])
PYFIX
bun "$ROOT/runtime/bun/src/install-hooks.ts" codex-config "$CODEX_CFG" \
  "/new/path/hooks/tap-codex-session-start.sh" "/new/path/hooks/tap-shell-body-guard.ts"
grep -q 'UserPromptSubmit' "$CODEX_CFG" \
  && fail "(5) the real block-builder still wrote [[hooks.UserPromptSubmit]] into an existing config.toml: $(cat "$CODEX_CFG")"
grep -q 'tap-managed:begin Codex SessionStart' "$CODEX_CFG" \
  || fail "(5) the block-builder damaged the SessionStart marker — that is the Codex wiring that WORKS"
grep -q '/new/path/hooks/tap-codex-session-start.sh' "$CODEX_CFG" \
  || fail "(5) the block-builder did not update the SessionStart command to the new hook_cmd"

# --- (6) the shared emitter has no roster mode left to re-wire into ----------
grep -qi 'roster' "$ROOT/runtime/bun/src/session-start.ts" \
  && fail "(6) runtime/bun/src/session-start.ts carries 'roster' text — the per-prompt roster mode must stay deleted: $(grep -ni 'roster' "$ROOT/runtime/bun/src/session-start.ts")"

echo "roster-hook-removed: ok"
