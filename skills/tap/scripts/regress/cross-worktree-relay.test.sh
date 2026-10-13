#!/usr/bin/env bash
# cross-worktree-relay.test.sh — Unit 2b: explicit cross-worktree relay.
#
# Verifies (per CONTRACT §cross-worktree):
#   (cw-1) tap send --cross-worktree requires --pane and writes ONLY to the sender bus
#   (cw-2) tap done --payload writes .done to the sender bus, never the recipient bus
#   (cw-3) tap outstanding observes the cross-worktree item before settlement
#           and drains after recipient settles via --payload
#   (cw-4) tap doctor warns on an external-path payload
#   (cw-5) a normal same-team send (no --cross-worktree) is unchanged
#
# tmux-dependent paths: uses a minimal fake-tmux binary (mktemp -d). Tests that
# exercise real pane targets (e.g. real tmux inject-verify) are out of scope —
# this smoke covers the bus and receipt ownership invariants.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

# Two isolated bus homes simulate two worktrees
SENDER_BUS="$(mktemp -d)"
RECIPIENT_BUS="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
SENDER_BUS="$(cd "$SENDER_BUS" && pwd -P)"
RECIPIENT_BUS="$(cd "$RECIPIENT_BUS" && pwd -P)"
trap 'rm -rf "$SENDER_BUS" "$RECIPIENT_BUS" "$FAKE_BIN"' EXIT

# Minimal fake tmux (follows courier-injects.test.sh pattern).
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    if [[ "$*" == *'start_time'* ]]; then
      printf 'self\t900:100\n'
      printf 'xwt-fake\t900:100\n'
    else
      printf '%s\n' self xwt-fake
    fi ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; -F) fmt="$2"; shift 2 ;; *) shift ;; esac
    done
    pane_id=%201
    if [ -n "${FAKE_REBIND_WHEN_CANON:-}" ] && [ -f "$FAKE_REBIND_WHEN_CANON" ]; then
      pane_id=%299
      : > "$state/rebound"
    fi
    case "$target" in
      self) printf 'self\tself:0.0\t%%202\tcodex\t202\t900:100\t0\n' ;;
      xwt-fake) printf 'xwt-fake\txwt-fake:0.0\t%s\tcodex\t201\t900:100\t0\n' "$pane_id" ;;
      *) exit 1 ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') echo "900:100" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          self|self:0.0|%202)         printf '%%202\tself\t202\tcodex\t0\n' ;;
          xwt-fake|xwt-fake:0.0|%201)
            pane_id=%201
            if [ -n "${FAKE_REBIND_WHEN_CANON:-}" ] && [ -f "$FAKE_REBIND_WHEN_CANON" ]; then
              pane_id=%299
              : > "$state/rebound"
            fi
            printf '%s\txwt-fake\t201\tcodex\t0\n' "$pane_id" ;;
          *)                          printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              echo "%201" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$SENDER_BUS/fake-tmux"
export TAP_HOME="$SENDER_BUS"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:1"

write_sender_registry() {
  local bus="$1"
  mkdir -p "$bus/payloads" "$bus/receipts"
  cat > "$bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "session": "self", "pane": "self:0.0", "pane_id": "%202", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active" },
    "codex": { "session": "xwt-fake", "pane": "xwt-fake:0.0", "pane_id": "%201", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active" }
  }
}
JSON
}
write_sender_registry "$SENDER_BUS"

# --- shared source payload (sender writes this) --------------------------------
PAYLOAD="$SENDER_BUS/source.md"
cat > "$PAYLOAD" <<'EOF'
---
from: claude
to: codex
kind: discuss
---

cross-worktree test payload
EOF

# --- (cw-1) sender bus isolation ----------------------------------------------
# --cross-worktree requires --pane; payload lands ONLY on sender bus.
"$TAP" send codex "$PAYLOAD" --from claude --kind discuss \
  --pane xwt-fake:0.0 --id cw-smoke-1 \
  --cross-worktree >"$SENDER_BUS/cw1.out" 2>&1 || {
  echo "cross-worktree: (cw-1) send failed (exit $?)" >&2
  cat "$SENDER_BUS/cw1.out" >&2; exit 1
}

# Payload must be on SENDER bus
[ -f "$SENDER_BUS/payloads/cw-smoke-1.md" ] || {
  echo "cross-worktree: (cw-1) payload not on sender bus" >&2; exit 1
}
# Sent receipt on sender bus
[ -f "$SENDER_BUS/receipts/cw-smoke-1.sent" ] || {
  echo "cross-worktree: (cw-1) sent receipt not on sender bus" >&2; exit 1
}
# Recipient bus must be untouched (no payloads dir even created)
if [ -d "$RECIPIENT_BUS/payloads" ]; then
  _cnt="$(ls "$RECIPIENT_BUS/payloads/" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$_cnt" -eq 0 ] || {
    echo "cross-worktree: (cw-1) recipient bus was written to" >&2; exit 1
  }
fi
# Sentinel path field must be absolute and point to sender bus
_path_field="$(awk 'NR>1 && /^path:[ \t]/{sub(/^path:[ \t]*/,""); print; exit}' \
  "$SENDER_BUS/payloads/cw-smoke-1.md")"
case "$_path_field" in
  "$SENDER_BUS/payloads/cw-smoke-1.md") ;;
  *) echo "cross-worktree: (cw-1) path field '$_path_field' not absolute sender-bus path" >&2; exit 1 ;;
esac
echo "cross-worktree: (cw-1) sender bus isolation: ok"

# --- guard: --cross-worktree without --pane must die -------------------------
_rc=0
"$TAP" send codex "$PAYLOAD" --from claude --cross-worktree \
  >"$SENDER_BUS/no-pane.out" 2>&1 || _rc=$?
[ "$_rc" -ne 0 ] || {
  echo "cross-worktree: (cw-1) --cross-worktree without --pane should have failed" >&2; exit 1
}
echo "cross-worktree: (cw-1) --cross-worktree requires --pane guard: ok"

# A rowless operator relay must name an exact session-qualified pane. A bare
# target depends on tmux's ambient resolver and therefore cannot prove exact
# session-name + designated-pane membership.
_rc=0
"$TAP" send codex "$PAYLOAD" --from claude --cross-worktree --pane xwt-fake \
  --id cw-bare-pane >"$SENDER_BUS/bare-pane.out" 2>&1 || _rc=$?
[ "$_rc" -ne 0 ] || {
  echo "cross-worktree: (cw-1) rowless bare pane target should have failed" >&2; exit 1
}
[ ! -f "$SENDER_BUS/payloads/cw-bare-pane.md" ] || {
  echo "cross-worktree: (cw-1) refused bare pane target wrote a payload" >&2; exit 1
}
echo "cross-worktree: (cw-1) rowless relay requires exact session-qualified membership: ok"

# Membership is re-authorized at the inject boundary, not only when argv is
# parsed. Simulate an address rebound after route/pre-copy/place checks but
# before the first send-keys; the canonical must be rolled back.
rm -f "${FAKE_TMUX_STATE:?}/rebound" "${FAKE_TMUX_STATE:?}/input"
_rc=0
FAKE_REBIND_WHEN_CANON="$SENDER_BUS/payloads/cw-rowless-race.md" "$TAP" send codex "$PAYLOAD" --from claude \
  --cross-worktree --pane xwt-fake:0.0 --id cw-rowless-race \
  >"$SENDER_BUS/rowless-race.out" 2>&1 || _rc=$?
[ -f "$FAKE_TMUX_STATE/rebound" ] || { echo "cross-worktree: rebound stimulus was never observed" >&2; exit 1; }
[ "$_rc" -ne 0 ] || {
  echo "cross-worktree: (cw-1) rowless address rebound crossed inject barrier" >&2; exit 1
}
[ ! -f "$SENDER_BUS/payloads/cw-rowless-race.md" ] || {
  echo "cross-worktree: (cw-1) rowless rebound left a canonical payload" >&2; exit 1
}
[ ! -f "$FAKE_TMUX_STATE/input" ] || {
  echo "cross-worktree: (cw-1) rowless rebound injected into the replacement pane" >&2; exit 1
}
echo "cross-worktree: (cw-1) rowless membership is rechecked at point of effect: ok"

# --- (cw-2) recipient settles via --payload; .done goes to sender bus --------
# Simulate recipient running with their own TAP_HOME.
mkdir -p "$RECIPIENT_BUS/payloads" "$RECIPIENT_BUS/receipts"
ABS_PAYLOAD="$SENDER_BUS/payloads/cw-smoke-1.md"
TAP_HOME="$RECIPIENT_BUS" "$TAP" read "path=$ABS_PAYLOAD" --by codex || {
  echo "cross-worktree: (cw-2) tap done --payload failed" >&2; exit 1
}
# .done must be on SENDER bus
[ -f "$SENDER_BUS/receipts/cw-smoke-1.done" ] || {
  echo "cross-worktree: (cw-2) .done not on sender bus" >&2; exit 1
}
# .done must NOT appear on recipient bus
[ ! -f "$RECIPIENT_BUS/receipts/cw-smoke-1.done" ] || {
  echo "cross-worktree: (cw-2) .done was written to recipient bus (isolation violation)" >&2; exit 1
}
# A stale cross-worktree settle fails on the sender bus and surfaces the actor's
# open obligations there; it never falls back to the recipient bus.
_rc=0
TAP_HOME="$RECIPIENT_BUS" "$TAP" done cw-smoke-1 --by codex --payload "$ABS_PAYLOAD" \
  >"$SENDER_BUS/replay.out" 2>&1 || _rc=$?
[ "$_rc" -eq 1 ] || {
  echo "cross-worktree: (cw-2) settled replay should fail, got $_rc" >&2; cat "$SENDER_BUS/replay.out" >&2; exit 1
}
grep -q 'id cw-smoke-1 already settled at .*; you have 0 open: none' "$SENDER_BUS/replay.out" || {
  echo "cross-worktree: (cw-2) settled replay omitted sender-bus obligations" >&2; cat "$SENDER_BUS/replay.out" >&2; exit 1
}
echo "cross-worktree: (cw-2) recipient settlement via --payload on sender bus: ok"

# Security: --payload basename must match the id
_rc=0
TAP_HOME="$RECIPIENT_BUS" "$TAP" done cw-smoke-1 --by codex \
  --payload "$SENDER_BUS/payloads/cw-smoke-99.md" \
  >/dev/null 2>&1 || _rc=$?
[ "$_rc" -ne 0 ] || {
  echo "cross-worktree: (cw-2) mismatched --payload basename should have failed" >&2; exit 1
}
echo "cross-worktree: (cw-2) --payload basename mismatch guard: ok"

# --- (cw-3) tap outstanding drains after settlement ---------------------------
# cw-smoke-1 is already settled. Send an unsettled one.
"$TAP" send codex "$PAYLOAD" --from claude --kind discuss \
  --pane xwt-fake:0.0 --id cw-smoke-2 --cross-worktree >/dev/null 2>&1 || {
  echo "cross-worktree: (cw-3) second send failed" >&2; exit 1
}
# outstanding exits 0 whether or not sends are open; the listing proves cw-smoke-2 is open
_out=""
_rc=0
TAP_HOME="$SENDER_BUS" "$TAP" outstanding claude >"$SENDER_BUS/out.tmp" 2>&1 || _rc=$?
[ "$_rc" -eq 0 ] || {
  echo "cross-worktree: (cw-3) outstanding should exit 0 and list the pending item, got $_rc" >&2; cat "$SENDER_BUS/out.tmp" >&2; exit 1
}
_out="$(cat "$SENDER_BUS/out.tmp")"
case "$_out" in
  *"cw-smoke-2"*) ;;
  *) echo "cross-worktree: (cw-3) outstanding did not list unsettled cw-smoke-2: $_out" >&2; exit 1 ;;
esac
# cw-smoke-1 (settled) must NOT appear
case "$_out" in
  *"cw-smoke-1"*) echo "cross-worktree: (cw-3) settled cw-smoke-1 still listed in outstanding" >&2; exit 1 ;;
esac

# Settle the second item
TAP_HOME="$RECIPIENT_BUS" "$TAP" read "path=$SENDER_BUS/payloads/cw-smoke-2.md" --by codex || {
  echo "cross-worktree: (cw-3) settle cw-smoke-2 failed" >&2; exit 1
}
# Now outstanding must be clean: exit 0, the empty-state line, and no cw-smoke-2 row
_out="$(TAP_HOME="$SENDER_BUS" "$TAP" outstanding claude 2>&1)" || {
  echo "cross-worktree: (cw-3) outstanding failed after all settled: $_out" >&2; exit 1
}
case "$_out" in
  *"cw-smoke-2"*) echo "cross-worktree: (cw-3) settled cw-smoke-2 still listed in outstanding: $_out" >&2; exit 1 ;;
  *"no outstanding"*) ;;
  *) echo "cross-worktree: (cw-3) outstanding not clean after all settled: $_out" >&2; exit 1 ;;
esac
echo "cross-worktree: (cw-3) tap outstanding drains after settlement: ok"

# --- (cw-4) tap doctor warns on external-path payload -------------------------
# Plant a payload whose path field points to a different bus (shouldn't happen in
# production, but doctor should flag it as a warning).
mkdir -p "$SENDER_BUS/payloads"
cat > "$SENDER_BUS/payloads/xp-test.md" <<EOF
---
id: xp-test
from: claude
to: codex
kind: discuss
path: /some/other/worktree/tmp/tap/payloads/xp-test.md
---

body
EOF
# doctor should warn but still exit 0 (no regulated identifiers, no torn state — external-path is a warning)
TAP_HOME="$SENDER_BUS" "$TAP" doctor >"$SENDER_BUS/doctor.out" 2>"$SENDER_BUS/doctor.err" || {
  _drc=$?
  echo "cross-worktree: (cw-4) doctor exited $?; expected 0 for external-path warning" >&2
  cat "$SENDER_BUS/doctor.out" >&2; cat "$SENDER_BUS/doctor.err" >&2; exit 1
}
grep -qi "external-path\|EXTERNAL-PATH\|outside.*bus\|differs.*canonical" \
  "$SENDER_BUS/doctor.out" "$SENDER_BUS/doctor.err" 2>/dev/null || {
  echo "cross-worktree: (cw-4) doctor did not warn on external-path payload" >&2
  echo "--- stdout ---" >&2; cat "$SENDER_BUS/doctor.out" >&2
  echo "--- stderr ---" >&2; cat "$SENDER_BUS/doctor.err" >&2
  exit 1
}
echo "cross-worktree: (cw-4) doctor warns on external-path payload: ok"

# --- (cw-5) normal same-team send (no --cross-worktree) is unchanged ----------
NORMAL_BUS="$(mktemp -d)"
trap 'rm -rf "$SENDER_BUS" "$RECIPIENT_BUS" "$FAKE_BIN" "$NORMAL_BUS"' EXIT
export FAKE_TMUX_STATE="$NORMAL_BUS/fake-tmux"
write_sender_registry "$NORMAL_BUS"
# Request the immediate path: default notes intentionally queue on the sender bus.
TAP_HOME="$NORMAL_BUS" "$TAP" send codex "$PAYLOAD" --no-spool \
  --from claude --kind discuss --pane xwt-fake:0.0 --id cw-same-team \
  >"$NORMAL_BUS/normal.out" 2>&1 || {
  echo "cross-worktree: (cw-5) normal send failed" >&2
  cat "$NORMAL_BUS/normal.out" >&2; exit 1
}
[ -f "$NORMAL_BUS/payloads/cw-same-team.md" ] || {
  echo "cross-worktree: (cw-5) normal send payload missing" >&2; exit 1
}
[ -f "$NORMAL_BUS/receipts/cw-same-team.sent" ] || {
  echo "cross-worktree: (cw-5) normal send receipt missing" >&2; exit 1
}
echo "cross-worktree: (cw-5) normal same-team send unchanged: ok"

# --- (cw-6, codex P1 tap-yv3 review) manual --cross-worktree never learns the
# recipient's team, so it must stamp NO to_team -- a writer-supplied to_team in
# the source payload must be dropped, not surfaced as a fake destination team.
SPOOF_BUS="$(mktemp -d)"
trap 'rm -rf "$SENDER_BUS" "$RECIPIENT_BUS" "$FAKE_BIN" "$NORMAL_BUS" "$SPOOF_BUS"' EXIT
export FAKE_TMUX_STATE="$SPOOF_BUS/fake-tmux"
write_sender_registry "$SPOOF_BUS"
SPOOF_PAYLOAD="$SPOOF_BUS/spoof-source.md"
cat > "$SPOOF_PAYLOAD" <<'EOF'
---
from: claude
to: codex
kind: discuss
to_team: BogusTeam
---

manual cross-worktree spoof test
EOF
TAP_HOME="$SPOOF_BUS" "$TAP" send codex "$SPOOF_PAYLOAD" --from claude --kind discuss \
  --pane xwt-fake:0.0 --id cw-spoof-manual --cross-worktree \
  >"$SPOOF_BUS/spoof.out" 2>&1 || {
  echo "cross-worktree: (cw-6) manual cross-worktree spoof send failed" >&2
  cat "$SPOOF_BUS/spoof.out" >&2; exit 1
}
SPOOF_CANON="$SPOOF_BUS/payloads/cw-spoof-manual.md"
[ -f "$SPOOF_CANON" ] || { echo "cross-worktree: (cw-6) spoof canonical missing" >&2; exit 1; }
! grep -q 'BogusTeam' "$SPOOF_CANON" || {
  echo "cross-worktree: (cw-6) manual --cross-worktree let a writer-supplied to_team survive (spoofable)" >&2
  cat "$SPOOF_CANON" >&2; exit 1
}
! grep -q '^to_team:' "$SPOOF_CANON" || {
  echo "cross-worktree: (cw-6) manual --cross-worktree should stamp no to_team at all (target team unknowable on this path)" >&2
  cat "$SPOOF_CANON" >&2; exit 1
}
echo "cross-worktree: (cw-6) manual --cross-worktree drops a writer-supplied to_team (not spoofable): ok"

echo "cross-worktree-relay: ok"
