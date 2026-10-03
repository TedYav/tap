#!/usr/bin/env bash
# qualified-token.test.sh — plain tokens stay STRICT (codex P1 —
# envelope from/to/kind, ids, and team/handle halves must never accept a slash or
# colon); the separate sentinel/compat validation for canonical <team>/<handle>
# plus legacy input-only <team>:<handle> now lives natively in
# runtime/bun/src/remote-target.ts (splitSendTarget/normalizeSendTarget) behind
# the live `tap send` CLI exercised in part 2 below.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

# --- part 1: the strict token gate --------------------------------------------
# The Bash units (tap_valid_token, tap_valid_qualified_token) are gone: nothing
# in production called them once send/reply went native. The strict gate
# (slash/colon NEVER valid in a plain token; codex P1) is validToken in
# runtime/bun/src/ids.ts, unit-tested in runtime/bun/test/unit1-bus.test.ts; the
# qualified split is splitSendTarget/normalizeSendTarget in remote-target.ts,
# unit-tested in runtime/bun/test/send-remote.test.ts. Part 2 exercises the
# acceptance/rejection surface end-to-end through the live `tap send` CLI.
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

# --- part 2: tap send colon-input alias ('<team>:<handle>' == '<team>/<handle>') ---
# Cheap proof the alias reaches the SAME resolution code path: an unknown team
# produces the identical structured failure for both forms (split-and-rewrite
# happens before any team/handle resolution).
WORK="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"; rm -rf "${FAKE_BIN:?}"' EXIT
# Enrolled (a live marker): the send body is native only, and an absent marker
# refuses a team-qualified send before team resolution could name GhostTeam.
TAP_HOME="$WORK/repo/.tap/bus"
export TAP_HOME
export TAP_INDEX_HOME="$WORK/index"   # never touch the real machine index
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "LocalTeam" }, "seats": { "claude": { "pane": "self:0.0", "status": "active" } } }
JSON
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" LocalTeam

slash_out="$TAP_HOME/slash.out"; colon_out="$TAP_HOME/colon.out"
slash_rc=0; colon_rc=0
"$TAP" send GhostTeam/codex -m body --from claude --id qt-slash >"$slash_out" 2>&1 || slash_rc=$?
"$TAP" send GhostTeam:codex -m body --from claude --id qt-colon >"$colon_out" 2>&1 || colon_rc=$?
[ "$slash_rc" -ne 0 ] || { echo "qualified-token: slash-form unknown-team send should have failed" >&2; exit 1; }
[ "$colon_rc" -eq "$slash_rc" ] || { echo "qualified-token: colon-alias exit ($colon_rc) differs from slash-form exit ($slash_rc)" >&2; exit 1; }
grep -q "unknown team 'GhostTeam'" "$slash_out" || { echo "qualified-token: slash-form error missing" >&2; cat "$slash_out" >&2; exit 1; }
grep -q "unknown team 'GhostTeam'" "$colon_out" || { echo "qualified-token: colon-alias error missing (alias did not reach team resolution)" >&2; cat "$colon_out" >&2; exit 1; }
echo "qualified-token: colon-input alias reaches the same resolution path as '/': ok"

# Multiple colons rejected outright by normalizeSendTarget (remote-target.ts),
# before any team resolution.
rc=0
"$TAP" send a:b:c -m body --from claude --id qt-multi >"$TAP_HOME/multi.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "qualified-token: multi-colon address should have failed" >&2; exit 1; }
grep -q "not a valid <team>:<handle> token" "$TAP_HOME/multi.out" || { echo "qualified-token: multi-colon address did not name the reason" >&2; cat "$TAP_HOME/multi.out" >&2; exit 1; }
echo "qualified-token: multi-colon address rejected: ok"

# Empty halves rejected by the same normalizeSendTarget check at the alias
# split point (before the address is ever rewritten to slash form).
rc=0
"$TAP" send :codex -m body --from claude --id qt-empty-team >"$TAP_HOME/empty-team.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "qualified-token: empty team half should have failed" >&2; exit 1; }
grep -q "not a valid <team>:<handle> token" "$TAP_HOME/empty-team.out" || { echo "qualified-token: empty team half did not name the reason" >&2; cat "$TAP_HOME/empty-team.out" >&2; exit 1; }
echo "qualified-token: empty team half rejected: ok"

rc=0
"$TAP" send GhostTeam: -m body --from claude --id qt-empty-handle >"$TAP_HOME/empty-handle.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "qualified-token: empty handle half should have failed" >&2; exit 1; }
grep -q "not a valid <team>:<handle> token" "$TAP_HOME/empty-handle.out" || { echo "qualified-token: empty handle half did not name the reason" >&2; cat "$TAP_HOME/empty-handle.out" >&2; exit 1; }
echo "qualified-token: empty handle half rejected: ok"

# codex P1 repro: a mixed ':' + '/' address must NOT be treated as the colon
# alias (the alias only fires when there is no '/'); it falls through to slash
# parsing, where the (now strict again) team-token check rejects the colon.
rc=0
"$TAP" send a:b/c -m body --from claude --id qt-mixed >"$TAP_HOME/mixed.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || { echo "qualified-token: mixed ':' + '/' address should have failed" >&2; exit 1; }
grep -q "team 'a:b' is not a valid token" "$TAP_HOME/mixed.out" || { echo "qualified-token: mixed ':' + '/' address did not fail on the team half as expected" >&2; cat "$TAP_HOME/mixed.out" >&2; exit 1; }
echo "qualified-token: mixed ':' + '/' address rejected (fails as malformed team, not resolved as a team): ok"

echo "qualified-token: ok"
