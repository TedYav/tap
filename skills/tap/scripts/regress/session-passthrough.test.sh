#!/usr/bin/env bash
# session-passthrough.test.sh — tap-9zwt: pnpm-style harness-flag passthrough,
# persisted and replayed across resume. Exercises the FULL wrapper path
# (tap.sh -> launcher.py), which the Python unit suite bypasses. Proves at the
# CLI level:
#   1. launch: an unknown flag after the seat spec forwards VERBATIM, spliced
#      harness-global (right after the binary), no `--` required;
#   2. own-flags-before-passthrough: `--dry-run` before the harness flag stays
#      tap's (dry-run engages); the harness flag still forwards;
#   3. `--` disambiguates a genuine collision: `-- --model X` forwards `--model X`
#      to the harness instead of consuming it as tap's own --model;
#   4. PERSIST+REPLAY: an acting registry row carrying harness_passthrough replays it
#      on `resume` (the effort-reversion footgun this bead root-fixes).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
REPO="$WORK/repo"; mkdir -p "$REPO/.tap/bus"
printf '{"schema": "0.20", "team":{"name":"repo","worktree_root":"%s"},"seats":{}}\n' "$REPO" >"$REPO/.tap/bus/registry.json"
export PATH="$FAKE_BIN:$PATH"

# Fake tmux: no live sessions, every stored address dead.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
case "${1:-}" in
  list-sessions) exit 0 ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cd "$REPO"

# (1a) With no saved permission choice the launch uses auto: the passthrough
#      still forwards, and no bypass flag appears.
out="$("$TAP" session launch codex worker --dry-run --json -c reasoning_effort=high 2>/dev/null | tail -1)"
[[ "$out" == *'"--approve-for-me"'* && "$out" == *'"-c","reasoning_effort=high"'* && "$out" != *'--dangerously-bypass-approvals-and-sandbox'* ]] \
  || { echo "session-passthrough: (1a) unsaved choice must launch auto with the passthrough: $out" >&2; exit 1; }
echo "session-passthrough: (1a) unsaved permission choice launches auto: ok"

# The remaining arms save bypass so the permission argv is one deterministic
# token (Codex auto adds a per-launch profile) and splice order stays legible.
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tap"; mkdir -p "$CONFIG_DIR"
printf 'version = 3\n[harness.codex]\npermissions = "bypass"\n' > "$CONFIG_DIR/config.toml"

# (1) launch: -c forwards verbatim, spliced right after the codex binary.
out="$("$TAP" session launch codex worker --dry-run --json -c reasoning_effort=high 2>/dev/null | tail -1)"
# A fresh launch puts the saved permission mode first;
# resume (4) below still splices passthrough right after codex.
# Every local Codex launch also passes --no-daemon first (tap-21bdj).
[[ "$out" == *'"codex","--no-daemon","--dangerously-bypass-approvals-and-sandbox","-c","reasoning_effort=high"'* ]] || { echo "session-passthrough: (1) -c not spliced harness-global: $out" >&2; exit 1; }
echo "session-passthrough: (1) unknown flag forwards verbatim, harness-global: ok"

# (2) own-flags-before-passthrough: --dry-run stays tap's (a real launch would not
#     print 'would'), while the harness flag still forwards.
out="$("$TAP" session launch codex worker --dry-run --json -c reasoning_effort=high 2>/dev/null | tail -1)"
[[ "$out" == *'"-c","reasoning_effort=high"'* ]] || { echo "session-passthrough: (2) passthrough lost when own flag precedes it: $out" >&2; exit 1; }
echo "session-passthrough: (2) own flags before passthrough both honored: ok"

# (3) `--` disambiguates a collision with tap's own --model.
out="$("$TAP" session launch claude scribe --dry-run --json -- --model gpt-foo 2>&1 | tail -1)"
[[ "$out" == *'"--model","gpt-foo"'* ]] || { echo "session-passthrough: (3) -- did not forward the colliding flag: $out" >&2; exit 1; }
echo "session-passthrough: (3) -- forwards a colliding flag to the harness: ok"

# (4) PERSIST+REPLAY: seed a registry row carrying the registry's `passthrough`
#     field; resume
#     must replay it (survives restart instead of reverting to the profile default).
cat > "$REPO/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"repo","worktree_root":"$REPO"},"seats":{"worker":{"status":"suspended","status_reason":"session_stopped","delivery":"pane","session":"repo/worker","harness":"codex","cwd":"$REPO","base":"repo","tag":"worker","index":1,"harness_session_id":"sid-123","passthrough":["-c","reasoning_effort=high"]}}}
JSON
# Born live (F2a): resume's entry guard refuses an unenrolled worktree.
printf '{"schema":"0.20","teams":{"repo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$REPO" && pwd -P)" "$(cd "$REPO/.tap/bus" && pwd -P)/registry.json" > "${TAP_INDEX_HOME:?}/global-registry.json"
out="$("$TAP" session resume worker --dry-run --json 2>&1 | tail -1)"
[[ "$out" == *'"codex","-c","reasoning_effort=high"'* ]] || { echo "session-passthrough: (4) resume did not replay persisted passthrough: $out" >&2; exit 1; }
[[ "$out" == *'"resume"'* && "$out" == *"sid-123"* ]] || { echo "session-passthrough: (4) resume lost its own resume argv: $out" >&2; exit 1; }
echo "session-passthrough: (4) persisted passthrough replays on resume: ok"

# (5) bare passthrough token is REFUSED (would land in harness prompt position);
#     implicit passthrough is flag-shaped only. Non-zero exit + guidance.
if "$TAP" session launch claude scout extrabare --dry-run --json >/tmp/sp5.out 2>&1; then
  echo "session-passthrough: (5) bare token should have been refused: $(cat /tmp/sp5.out)" >&2; rm -f /tmp/sp5.out; exit 1
fi
grep -q "use -- before bare harness arguments" /tmp/sp5.out || { echo "session-passthrough: (5) refusal missing guidance: $(cat /tmp/sp5.out)" >&2; rm -f /tmp/sp5.out; exit 1; }
rm -f /tmp/sp5.out
echo "session-passthrough: (5) bare passthrough token refused with guidance: ok"

echo "session-passthrough: all ok"
