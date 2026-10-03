#!/usr/bin/env bash
# agy-launcher.test.sh — tap-8qj7: launcher support for agy (Antigravity/Gemini).
# Fixture-realism (no fantasy tmux): a scriptable fake tmux + registry rows drive
# the launcher's harness plumbing. Proves, at the CLI level:
#   1. launch -> agy --dangerously-skip-permissions (the load-bearing yolo flag);
#   2. bare-family resume -> --continue (agy's latest tier);
#   3. a gone roster row with an explicit native id enters the three-door picker;
#   4. an inferred-only id is ignored and gets the same picker, never adoption.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
REPO="$(cd "$WORK" && pwd -P)/repo"; mkdir -p "$REPO/.tap/bus"
export PATH="$FAKE_BIN:$PATH"

# Fake tmux: no live sessions, every stored pane id/address gone (dead rows).
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
case "${1:-}" in
  list-sessions) exit 0 ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

CONV="7fe99dee-01b7-4e1c-b5a3-816bd12511c3"

registry() {  # $1 = extra JSON fields for the gemini agent (trailing comma-free)
  cat > "$REPO/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"repo","worktree_root":"$REPO"},"seats":{
  "gemini":{"status":"active","harness":"agy","pane":"repo/gemini:0.0","pane_id":"%dead"${1:+,$1}}
}}
JSON
}

# Born live (F2a): launch resolves its team through the enrolled machine index,
# so the scratch root is enrolled with an empty acting registry first.
cat > "$REPO/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"repo","worktree_root":"$REPO"},"seats":{}}
JSON
mkdir -p "$TAP_INDEX_HOME"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema": "0.20", "teams":{"repo":{"root":"$REPO","registry_location":"$REPO/.tap/bus/registry.json","state":"registered"}}}
JSON

cd "$REPO"

# (1) launch: the yolo flag is present. Bare launch (no --model) emits none.
out="$(TMUX_FIXTURE=none "$TAP" session launch agy fresh --dry-run --json 2>&1 | tail -1)"
[[ "$out" == *'"agy","--dangerously-skip-permissions"'* ]] || { echo "agy-launcher: (1) launch missing yolo flag: $out" >&2; exit 1; }
[[ "$out" != *"--model"* ]] || { echo "agy-launcher: (1) bare launch must not invent --model: $out" >&2; exit 1; }
echo "agy-launcher: (1) launch -> agy --dangerously-skip-permissions: ok"

# (1b) --model translates onto argv (tap-ppo7); the old Gemini-only builder dropped it.
out="$(TMUX_FIXTURE=none "$TAP" session launch agy fresh --model gemini-3.6-flash-high --dry-run --json 2>&1 | tail -1)"
[[ "$out" == *'"--model","gemini-3.6-flash-high"'* ]] || { echo "agy-launcher: (1b) --model must reach argv: $out" >&2; exit 1; }
echo "agy-launcher: (1b) --model gemini-3.6-flash-high reaches argv: ok"

# (1c) --effort max refuses naming low|medium|high; does not clamp or pass through.
set +e
out="$(TMUX_FIXTURE=none "$TAP" session launch agy fresh --effort max --dry-run --json 2>&1)"; rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "agy-launcher: (1c) --effort max must refuse, got rc=0: $out" >&2; exit 1; }
[[ "$out" == *"low"* && "$out" == *"medium"* && "$out" == *"high"* ]] \
  || { echo "agy-launcher: (1c) refusal must name legal domain low|medium|high: $out" >&2; exit 1; }
[[ "$out" != *"--effort\",\"max"* ]] || { echo "agy-launcher: (1c) must not pass max through: $out" >&2; exit 1; }
echo "agy-launcher: (1c) --effort max refuses with domain: ok"

# (2) bare-family resume -> --continue (latest tier).
out="$("$TAP" session resume agy --dry-run --json 2>&1 | tail -1)"
[[ "$out" == *'"--dangerously-skip-permissions","--continue"'* ]] || { echo "agy-launcher: (2) bare resume should --continue: $out" >&2; exit 1; }
echo "agy-launcher: (2) bare-family resume -> --continue: ok"

# (3) A GONE roster row is not silently replaced. Without a terminal the launch
# refuses: human output names the resume, different-handle and
# explicit-fresh doors; --json never asks and carries one session_exists object
# whose action is the resume door.
registry "\"harness_session_id\":\"$CONV\",\"session_attribution_trust\":\"env\""
set +e
out="$("$TAP" session launch agy gemini --dry-run 2>&1)"; rc=$?
json_out="$("$TAP" session launch agy gemini --dry-run --json 2>&1)"; json_rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "agy-launcher: (3) GONE roster launch must refuse non-interactively, got rc=$rc: $out" >&2; exit 1; }
[[ "$out" == *"session resume gemini"* && "$out" == *"gemini-2"* && "$out" == *"--fresh"* ]] \
  || { echo "agy-launcher: (3) GONE roster refusal must expose all three doors: $out" >&2; exit 1; }
[[ "$out" != *"--conversation"* ]] || { echo "agy-launcher: (3) launch must not adopt via --conversation: $out" >&2; exit 1; }
[ "$json_rc" -eq 2 ] || { echo "agy-launcher: (3) --json GONE roster launch must refuse, got rc=$json_rc: $json_out" >&2; exit 1; }
[[ "$json_out" == *'"error_class":"session_exists"'* && "$json_out" == *'"action":"tap session resume gemini"'* ]] \
  || { echo "agy-launcher: (3) --json refusal must be session_exists with the resume door: $json_out" >&2; exit 1; }
[[ "$json_out" != *"--conversation"* ]] || { echo "agy-launcher: (3) --json launch must not adopt via --conversation: $json_out" >&2; exit 1; }
echo "agy-launcher: (3) GONE explicit-id row refuses with the three doors (human) and the resume door (--json): ok"

# (4) An inferred-only id has no identity authority and cannot bypass the same
# roster refusal.
registry "\"derived_harness_session_id\":\"guessed\",\"session_attribution_trust\":\"inferred\""
set +e
out="$("$TAP" session launch agy gemini --dry-run 2>&1)"; rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "agy-launcher: (4) inferred-id GONE row must refuse non-interactively, got rc=$rc: $out" >&2; exit 1; }
[[ "$out" != *"guessed"* ]] || { echo "agy-launcher: (4) an inferred id must NEVER become launch identity: $out" >&2; exit 1; }
[[ "$out" != *"--conversation"* ]] || { echo "agy-launcher: (4) launch must not carry --conversation: $out" >&2; exit 1; }
echo "agy-launcher: (4) GONE inferred-id row uses the same refusal without guessed identity: ok"

echo "agy-launcher: all checks passed"
