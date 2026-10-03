#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# team-down.test.sh — `tap team down` stops this team's verified sessions and suspends
# their seats (registry/bus/manifest retained). Covers: identity-first kill list (FLAG 1), kill-teammates-then-
# clear-then-self-last ordering (FLAG 2), preview obligations warn (FLAG 3),
# --dry-run, --keep-self, gate-free unsettled-inbound warnings, and --json.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# A parent shell that exported TMUX_LIVE_SESSIONS (another smoke / debug session)
# would make this mock's resolve_session fail-closed on an empty/stale list and
# let has-session report "dead" without kill-session ever appending KILL_LOG.
unset TMUX_LIVE_SESSIONS
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
KILL_LOG="$(mktemp)"
LIVE_SESSIONS="$(mktemp)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"; rm -f "$KILL_LOG" "$LIVE_SESSIONS"' EXIT
export TAP_HOME KILL_LOG PATH="$FAKE_BIN:$PATH"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

# Mock tmux: pane_id liveness, session_name resolution, list-panes count, and a
# kill-session recorder (appends each killed session name to $KILL_LOG in order).
# Liveness model: a pane_id/address containing "dead" is gone; the %10N pane ids and
# non-dead addresses are alive. session_name maps a target to its session via a
# small table so identity-first resolution has a stable answer.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
resolve_session() {
  local target="$1" exact=0 name
  if [ -z "${TMUX_LIVE_SESSIONS:-}" ] || [ ! -f "$TMUX_LIVE_SESSIONS" ]; then
    printf '%s' "${target#=}"
    return 0
  fi
  case "$target" in
    =*) exact=1; target="${target#=}" ;;
  esac
  while IFS= read -r name; do
    [ "$name" = "$target" ] && { printf '%s' "$name"; return 0; }
  done < "$TMUX_LIVE_SESSIONS"
  [ "$exact" = 1 ] && return 1
  while IFS= read -r name; do
    case "$name" in "$target"*) printf '%s' "$name"; return 0 ;; esac
  done < "$TMUX_LIVE_SESSIONS"
  return 1
}
pane_id_for() {
  case "$1" in
    *dead*|"%105") printf '' ;;             # recycled seat's stored pane_id is dead
    "demo/claude:0.0") printf '%%101' ;;
    "demo/claude:0.1") printf '%%102' ;;      # pane-crew sibling in demo/claude
    "demo/codex:0.0")  printf '%%103' ;;
    "demo/sonnet:0.0") printf '%%104' ;;
    "recycled-addr")  printf '%%106' ;;      # address alive, but a different pane
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  case "$1" in "%101"|"demo/claude:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac
}
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")" || exit 1
    printf '%s\n' "$resolved" >> "${KILL_LOG}"
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")" || exit 1
    if [ -n "${KILL_LOG:-}" ] && [ -f "$KILL_LOG" ] && grep -qxF "$resolved" "$KILL_LOG" 2>/dev/null; then
      exit 1
    fi
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    [ "$all" = 1 ] && { printf '%%101\t%s\n' "$(tty_for %101)"; exit 0; }
    resolve_session "$target" >/dev/null || exit 1
    # Name-first membership: emit the real pane ids for this session.
    case "${target#=}" in
      demo/claude) printf '%s\n' '%101' '%102' ;;
      demo/codex)  printf '%s\n' '%103' ;;
      demo/sonnet) printf '%s\n' '%104' ;;
      *) printf '%%p1\n' ;;
    esac
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    # No -t => the caller asking for its OWN pane. The combined address format
    # (contains window_index) yields the caller's pane address; the bare
    # session_name format yields just the session (the unregistered-caller
    # fallback in tap-team.sh).
    if [ -z "$target" ]; then
      case "$fmt" in
        # tap-24f server-epoch probe. The fixture rows below carry the matching
        # stamp, so every seat is epoch-PROVEN and shutdown keeps its legacy
        # id-anchored resolution — which is what these cases assert.
        *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        case "$target" in
          "%101"|"%102"|"demo/claude:0.0"|"demo/claude:0.1") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          "%104"|"demo/sonnet:0.0") resolved_session="demo/sonnet" ;;
          "recycled-addr"|"%106") resolved_session="someone-elses-session" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$resolved_session" "${FAKE_EPOCH_RAW-900:100}" ;;
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        case "$target" in
          "%101"|"%102"|"demo/claude:0.0"|"demo/claude:0.1") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          "%104"|"demo/sonnet:0.0") resolved_session="demo/sonnet" ;;
          "recycled-addr"|"%106") resolved_session="someone-elses-session" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s' "$resolved" "$resolved_session"
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "${FAKE_EPOCH_RAW-900:100}"
        printf '\n' ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      *pane_id*)
        # Liveness: empty => gone. Addresses map to their live pane_id; a
        # "%..." target is its own liveness token.
        pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        case "$target" in
          "%101"|"%102") echo "demo/claude" ;;  # sibling shares the session
          "%103")  echo "demo/codex" ;;
          "%104") echo "demo/sonnet" ;;
          "recycled-addr"|"%106") echo "someone-elses-session" ;;
          *) echo "${target%%:*}" ;;
        esac ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

# Registry fixture: caller is "claude" (self session demo/claude); teammates codex
# and sonnet; a poll daemon; a recycled seat whose stored pane_id is dead but whose
# address now belongs to someone-elses-session (MUST NOT be killed — FLAG 1).
# Every pane row carries the CURRENT server epoch, which is what a live team's
# registry looks like: rows are stamped at every pane-bearing write (tap-24f).
# Proven rows keep the identity-first resolution these cases pin. The unproven
# and stale arms — where a stored id may no longer name a kill target at all —
# are pinned in destructive-target-guard.test.sh.
write_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude":   {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0",  "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":    {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",   "pane_id": "%103",  "harness": "codex",  "server_epoch": "srv:900:100", "session": "demo/codex"},
    "sonnet":   {"status": "active", "delivery": "pane", "pane": "demo/sonnet:0.0",  "pane_id": "%104", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/sonnet"},
    "pollbot":  {"status": "active", "delivery": "poll", "harness": "daemon"},
    "recycled": {"status": "active", "delivery": "pane", "pane": "recycled-addr",   "pane_id": "%105",     "harness": "codex",  "server_epoch": "srv:900:100"}
  }
}
JSON
}
has_agent() {
  python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
sys.exit(0 if sys.argv[2] in agents else 1)
PY
}

# Pretend we're inside tmux so TAP resolves the caller's pane (the mock's no-target
# display-message returns demo/claude:0.0 -> pane_id %101 -> the "claude" seat).
export TMUX="/tmp/fake,0,0"

# --- (1) dry-run: plans, kills nothing, leaves registry byte-identical ---------
write_fixture
: > "$KILL_LOG"
before="$(cat "$TAP_HOME/registry.json")"
out="$("$TAP" team down --dry-run)"
[[ "$out" == *"kill session demo/codex"* ]] || { echo "(1) codex not in dry-run plan" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kill session demo/sonnet"* ]] || { echo "(1) sonnet not in dry-run plan" >&2; echo "$out" >&2; exit 1; }
grep -q "retained poll (rows unchanged):.*pollbot (poll)" <<<"$out" \
  || { echo "(1) pollbot not shown as retained poll" >&2; echo "$out" >&2; exit 1; }
# Unverified pane seats are refused (loud partial-down), not silent retain.
# The reason token is the verifier's own vocabulary (tap-24f).
[[ "$out" == *"refused unverified pane"* && "$out" == *"recycled (server_epoch_unproven)"* ]] \
  || { echo "(1) recycled dead-pane_id not shown as refused unverified server_epoch_unproven" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"someone-elses-session"* ]] && { echo "(1) FLAG 1 VIOLATION: recycled address's session appeared in plan" >&2; echo "$out" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(1) dry-run killed a session" >&2; cat "$KILL_LOG" >&2; exit 1; }
[ "$before" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "(1) dry-run mutated registry" >&2; exit 1; }
echo "team-down: (1) dry-run plans without killing or mutating: ok"

# --- (2) bare non-TTY proceeds and warns on unsettled inbound -----------------
# Ratified boundary: tap-7r9c.
write_fixture
: > "$KILL_LOG"
printf 'to: demo/codex\nfrom: smoke\n\nqueued\n' > "$TAP_HOME/payloads/busy.md"
_TD_OUT="$(mktemp "$TAP_HOME/td-out.XXXXXX")"
_TD_ERR="$(mktemp "$TAP_HOME/td-err.XXXXXX")"
_td2_rc=0
"$TAP" team down --keep-self </dev/null >"$_TD_OUT" 2>"$_TD_ERR" || _td2_rc=$?
# THE FIXTURE ITSELF CARRIES A GENUINE PARTIAL (exit-code truthfulness):
# write_fixture's "recycled" seat is an unverified pane, which
# refuses (see arm (1)'s "refused unverified pane" assertion on the same
# fixture) — so this run is correctly partial and must exit nonzero, not 0.
# This arm's actual subject (the unsettled-inbound seat-count warning) is
# unaffected either way; only the exit-status expectation was stale.
[ "$_td2_rc" != 0 ] \
  || { echo "(2) bare non-TTY down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; cat "$_TD_OUT" "$_TD_ERR" >&2; exit 1; }
grep -qi "warning:.*codex=1" "$_TD_ERR" \
  || { echo "(2) unsettled-inbound warning omitted codex=1" >&2; cat "$_TD_ERR" >&2; exit 1; }
grep -qi "claude=0" "$_TD_ERR" \
  || { echo "(2) unsettled-inbound warning omitted zero-count claude" >&2; cat "$_TD_ERR" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG" || { echo "(2) bare down did not stop codex" >&2; cat "$KILL_LOG" >&2; exit 1; }
has_agent codex || { echo "(2) down dropped codex instead of retaining its row" >&2; exit 1; }
echo "team-down: (2) bare non-TTY proceeds with unsettled-inbound seat counts: ok"

# --- (2x) foreign to_team is outbound relay, not local inbound --------------
write_fixture
: > "$KILL_LOG"
printf 'to: demo/codex\nto_team: other-team\nfrom: smoke\n\nqueued\n' > "$TAP_HOME/payloads/busy.md"
_TD_OUT="$(mktemp "$TAP_HOME/td-out.XXXXXX")"
_TD_ERR="$(mktemp "$TAP_HOME/td-err.XXXXXX")"
_td2x_rc=0
"$TAP" team down --keep-self </dev/null >"$_TD_OUT" 2>"$_TD_ERR" || _td2x_rc=$?
# write_fixture's "recycled" seat is always an unverified-pane refusal (P1-d,
# same as arm (2)) — this run is genuinely partial and must exit nonzero.
# This arm's actual subject (foreign to_team is not local inbound) is
# unaffected either way.
[ "$_td2x_rc" != 0 ] \
  || { echo "(2x) foreign-to_team down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; cat "$_TD_OUT" "$_TD_ERR" >&2; exit 1; }
grep -qi "codex=1" "$_TD_ERR" \
  && { echo "(2x) foreign to_team counted as local inbound: $(cat "$_TD_ERR")" >&2; exit 1; }
echo "team-down: (2x) foreign to_team is not local inbound: ok"

# --- (2a) clean TTY proceeds without a confirmation prompt -----------------
write_fixture
: > "$KILL_LOG"
rm -f "$TAP_HOME/payloads/busy.md"
python3 -B - "$TAP" <<'PY'
import os, pty, subprocess, sys
tap = sys.argv[1]
master, slave = pty.openpty()
env = os.environ.copy(); env.update(NO_COLOR="1", COLUMNS="80")
proc = subprocess.Popen(["/bin/bash", "-c", f'"{tap}" team down --keep-self'], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
os.close(slave)
try:
    stdout, stderr = proc.communicate(timeout=300)
except subprocess.TimeoutExpired:
    proc.kill()
    raise AssertionError("clean TTY waited for confirmation input")
text = (stdout + stderr).decode(errors="replace")
# write_fixture's "recycled" seat is always an unverified-pane refusal
# (exit-code truthfulness) — this run is genuinely partial and
# exits nonzero. This arm's actual subject (proceeds without prompting) is
# unaffected: what matters is that it did not HANG waiting for input.
assert proc.returncode != 0, f"clean TTY exited 0 despite a genuine partial (recycled's unverified pane): {text!r}"
assert "? [y/N]" not in text, f"clean TTY unexpectedly prompted: {text!r}"
print("team-down: (2a) clean TTY proceeds without prompt: ok")
PY

# --- (2b) busy TTY proceeds without reading an answer and warns --------------
# Ratified boundary: tap-7r9c.
write_fixture
: > "$KILL_LOG"
printf 'to: demo/codex\nfrom: smoke\n\nqueued\n' > "$TAP_HOME/payloads/busy.md"
python3 -B - "$TAP" <<'PY'
import os, pty, subprocess, sys

tap = sys.argv[1]
master, slave = pty.openpty()
env = os.environ.copy()
env.update(NO_COLOR="1", COLUMNS="80")
proc = subprocess.Popen(
    ["/bin/bash", "-c", f'"{tap}" team down --keep-self'],
    stdin=slave,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env,
)
os.close(slave)
try:
    stdout, stderr = proc.communicate(timeout=300)
except subprocess.TimeoutExpired:
    proc.kill()
    raise AssertionError("busy TTY waited for confirmation input")
os.close(master)
stderr_text = stderr.decode(errors="replace")
stdout_text = stdout.decode(errors="replace")

# write_fixture's "recycled" seat is always an unverified-pane refusal
# (exit-code truthfulness) — this run is genuinely partial and
# exits nonzero. This arm's actual subject (proceeds without prompting) is
# unaffected: what matters is that it did not HANG waiting for input.
assert proc.returncode != 0, f"busy TTY exited 0 despite a genuine partial (recycled's unverified pane): {stdout_text!r} {stderr_text!r}"
assert "? [y/N]" not in stderr_text, f"busy TTY unexpectedly prompted: {stderr_text!r}"
assert "warning:" in stderr_text.lower(), f"busy TTY omitted warning: {stderr_text!r}"
assert "codex=1" in stderr_text, f"busy TTY warning omitted codex=1: {stderr_text!r}"
print("team-down: (2b) busy TTY proceeds without prompt and warns: ok")
PY

# --- (3) --yes: teammates killed FIRST, self LAST, registry cleared, FLAG 1 ----
write_fixture
: > "$KILL_LOG"
rm -f "$TAP_HOME/payloads/busy.md"
_td3_rc=0
out="$("$TAP" team down --yes </dev/null)" || _td3_rc=$?
# write_fixture's "recycled" seat is always an unverified-pane refusal
# (exit-code truthfulness) — this run is genuinely partial and
# must exit nonzero. This arm's actual subject (kill ordering) is unaffected.
[ "$_td3_rc" != 0 ] \
  || { echo "(3) --yes down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; echo "$out" >&2; exit 1; }
# self (demo/claude) must be the LAST kill; teammates before it.
last="$(tail -n1 "$KILL_LOG")"
[ "$last" = "demo/claude" ] || { echo "(3) self session not killed last (last=$last)" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(3) codex session not killed" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/sonnet" "$KILL_LOG" || { echo "(3) sonnet session not killed" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -q "someone-elses-session" "$KILL_LOG" && { echo "(3) FLAG 1 VIOLATION: killed a recycled address's session" >&2; cat "$KILL_LOG" >&2; exit 1; }
# codex and sonnet appear before demo/claude in the log (self last).
grep -n . "$KILL_LOG" | awk -F: '$0 ~ /demo\/claude$/{self=$1} $0 ~ /demo\/codex$/{codex=$1} END{exit !(codex<self)}' \
  || { echo "(3) codex not killed before self" >&2; cat "$KILL_LOG" >&2; exit 1; }
# registry retained; stopped seats suspended and MUST CARRY status_reason
# (tap-9tqt amendment D — bare suspended would fail green on delivery gates alone).
has_agent codex || { echo "(3) codex row dropped (down must retain)" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent claude || { echo "(3) self row dropped (down must retain)" >&2; exit 1; }
has_agent pollbot || { echo "(3) poll row dropped" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY2' || { echo "(3) suspend state wrong" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
for h in ("codex", "sonnet", "claude"):
    assert agents[h]["status"] == "suspended", (h, agents[h])
    assert agents[h].get("status_reason") == "session_stopped", (
        f"{h} must CARRY status_reason=session_stopped; got {agents[h]!r}"
    )
    # Strip-then-stamp: pane coordinates gone; delivery is seat identity (preserved).
    assert agents[h].get("delivery") == "pane", (h, agents[h])
    for k in ("pane", "pane_id", "pane_current_command", "wake_url", "exited_at"):
        assert k not in agents[h], f"{h} still has stale binding {k}={agents[h].get(k)!r}"
assert agents["pollbot"]["status"] == "active"
assert agents["pollbot"].get("delivery") == "poll"
print("ok")
PY2
grep -q 'team-down' "$TAP_HOME/registry-events.log" || { echo "(3) missing down event" >&2; exit 1; }
echo "team-down: (3) --yes kills teammates-first/self-last, suspends seats, honors FLAG 1: ok"

# --- (4) --force compatibility no-op + --keep-self -----------------------------
write_fixture
: > "$KILL_LOG"
_td4_rc=0
out="$("$TAP" team down --force --keep-self </dev/null)" || _td4_rc=$?
# write_fixture's "recycled" seat is always an unverified-pane refusal
# (exit-code truthfulness) — this run is genuinely partial and
# must exit nonzero. This arm's actual subject (--force no-op) is unaffected.
[ "$_td4_rc" != 0 ] \
  || { echo "(4) --force down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; echo "$out" >&2; exit 1; }
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4) --keep-self killed self session" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4) --keep-self did not kill teammate codex" >&2; exit 1; }
has_agent claude || { echo "(4) --keep-self dropped self row" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex  || { echo "(4) --keep-self dropped teammate row (must suspend)" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY2'
import json, sys
a = json.load(open(sys.argv[1]))["seats"]
assert a["claude"]["status"] == "active", a["claude"]
assert a["codex"]["status"] == "suspended" and a["codex"]["status_reason"] == "session_stopped"
print("ok")
PY2
echo "team-down: (4) --force is a no-op; --keep-self spares self session/row: ok"

# --- (4b) --keep-self keeps EVERY seat in the spared session (pane-crew sibling)-
# claude (caller) and claude-2 share session demo/claude; codex is a teammate.
# Sparing demo/claude keeps claude-2's live pane, so its registry row MUST survive
# too — else it's an orphan (live pane, no row). This is the bug the gate caught:
# a self_handle-only clear would drop claude-2.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude":   {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101",  "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "claude-2": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.1", "pane_id": "%102", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":    {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103",   "harness": "codex", "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
: > "$KILL_LOG"
"$TAP" team down --yes --keep-self </dev/null >/dev/null
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4b) --keep-self killed the shared self session" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4b) teammate codex not killed" >&2; exit 1; }
has_agent claude   || { echo "(4b) caller row dropped" >&2; exit 1; }
has_agent claude-2 || { echo "(4b) BUG: pane-crew sibling orphaned (live pane, no registry row)" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex    || { echo "(4b) teammate row dropped" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY2'
import json, sys
a = json.load(open(sys.argv[1]))["seats"]
assert a["claude"]["status"] == "active"
assert a["claude-2"]["status"] == "active"
assert a["codex"]["status"] == "suspended"
print("ok")
PY2
echo "team-down: (4b) --keep-self retains ALL seats in the spared session: ok"

# --- (4c) unregistered caller + --keep-self: seats in the spared session keep rows
# The caller is NOT a registered seat (no row matches its pane_id %101),
# but sits in session demo/claude which hosts claude-2. A self_handle-empty clear
# used to wipe everything; the spared session's seats must keep their rows.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude-2": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.1", "pane_id": "%102", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":    {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103",   "harness": "codex", "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
: > "$KILL_LOG"
"$TAP" team down --yes --keep-self </dev/null >/dev/null
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4c) killed the spared session hosting live seats" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4c) teammate codex not killed" >&2; exit 1; }
has_agent claude-2 || { echo "(4c) BUG: seat in spared session orphaned under unregistered caller" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex    || { echo "(4c) teammate row dropped" >&2; exit 1; }
echo "team-down: (4c) unregistered caller --keep-self keeps spared-session seats: ok"

# --- (5) --json shape ----------------------------------------------------------
write_fixture
: > "$KILL_LOG"
"$TAP" team down --json --dry-run </dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["team"] == "demo", d
assert d["dry_run"] is True, d
assert d.get("registry_policy") == "suspend", d
assert d["self_session"] == "demo/claude", d
assert set(d["killed_sessions"]) == {"demo/codex", "demo/sonnet", "demo/claude"}, d
assert set(d["stopped_sessions"]) == {"demo/codex", "demo/sonnet", "demo/claude"}, d
assert "someone-elses-session" not in d["killed_sessions"], d
assert "refused_sessions" in d and "refused_handles" in d and "retained_poll" in d, d
assert "pollbot" in d["retained_poll"], d
assert "recycled" in d["refused_handles"], d
assert d.get("partial") is True, d
' || { echo "(5) --json shape wrong" >&2; "$TAP" team down --json --dry-run </dev/null >&2; exit 1; }
# zero-agent JSON must still carry the outcome arrays.
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{}}
JSON
"$TAP" team down --json --yes </dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
for k in ("stopped_sessions", "refused_sessions", "refused_handles", "retained_poll"):
    assert k in d and d[k] == [], (k, d)
assert d.get("partial") is False, d
' || { echo "(5b) zero-agent --json missing outcome arrays" >&2; exit 1; }
write_fixture
echo "team-down: (5) --json shape parses; distinguishes poll/refused; zero-agent arrays present: ok"

# --- (6) vanished exact name never resolves or kills its live -2 sibling -------
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":  {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103",  "harness": "codex", "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
printf '%s\n' demo/claude demo/codex-2 > "$LIVE_SESSIONS"
export TMUX_LIVE_SESSIONS="$LIVE_SESSIONS"
failures=0
out="$("$TAP" team down --dry-run)"
# Name-first: a gone exact name refuses (session_name_gone). Must never
# prefix-resolve to the live -2 sibling in the plan or the kill log.
grep -Eq 'refused unverified pane \(rows retained; possible live target\): codex \(session_name_gone\)' <<<"$out" || {
  echo "(6) vanished demo/codex did not refuse session_name_gone (prefix-match risk)" >&2
  echo "$out" >&2
  failures=1
}
[[ "$out" != *"demo/codex-2"* ]] || {
  echo "(6) prefix sibling appeared in shutdown preview" >&2
  failures=1
}
: > "$KILL_LOG"
_td6_rc=0
"$TAP" team down --yes --keep-self </dev/null >/dev/null 2>&1 || _td6_rc=$?
# codex's exact session is genuinely gone (session_name_gone) — a real
# refusal, not a deliberate spare, so the exit-code truthfulness rule
# correctly makes this exit nonzero. This arm's actual subject (no
# prefix-match onto the live -2 sibling) is unaffected.
[ "$_td6_rc" != 0 ] || {
  echo "(6) down exited 0 despite a genuine refusal (codex's session_name_gone)" >&2
  failures=1
}
grep -qx 'demo/codex-2' "$KILL_LOG" && {
  echo "(6) vanished demo/codex prefix-killed live sibling demo/codex-2" >&2
  failures=1
}
grep -qx 'demo/codex' "$KILL_LOG" && {
  echo "(6) vanished demo/codex was killed despite session_name_gone" >&2
  failures=1
}
unset TMUX_LIVE_SESSIONS
[ "$failures" = 0 ] || exit 1
echo "team-down: (6) vanished exact name neither reports nor kills its -2 sibling: ok"

# --- (7) empty registry is friendly -------------------------------------------
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{}}
JSON
out="$("$TAP" team down --yes </dev/null)"
[[ "$out" == *"nothing to stop"* ]] || { echo "(7) empty registry not friendly" >&2; echo "$out" >&2; exit 1; }
echo "team-down: (7) empty registry: ok"

# --- (9) --except <handles> (tap-nt4c) ----------------------------------------
# Motivating use case: stop MOST of the team, sparing named seats, without listing
# every seat you do want stopped. Every arm below is mutation-verified RED
# against pre-flag code (which refuses --except as unknown_option), which is why
# the refusal arms assert error_class AND detail rather than a nonzero exit —
# an exit-code-only assertion passes on the pre-fix binary too.
err_class() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["error_class"])' "$1"; }

write_fixture
: > "$KILL_LOG"
_td9_rc=0
out="$("$TAP" team down --yes --keep-self --except codex </dev/null)" || _td9_rc=$?
# write_fixture's "recycled" seat is not in this --except set, so it is still
# an unverified-pane refusal (exit-code truthfulness) — this run
# is genuinely partial and must exit nonzero. This arm's actual subject
# (--except sparing) is unaffected.
[ "$_td9_rc" != 0 ] \
  || { echo "(9) --except down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; echo "$out" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG" && { echo "(9) --except codex stopped codex anyway" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/sonnet" "$KILL_LOG" || { echo "(9) --except must not spare unnamed seats" >&2; cat "$KILL_LOG" >&2; exit 1; }
# 2, not 1: --keep-self is passed, and the spared set is the UNION (CONTRACT).
# The receipt used to report only the selector's tally and this assertion locked
# that undercount in.
[[ "$out" == *"spared 2 seat(s) by --except: codex (includes --keep-self)"* ]] \
  || { echo "(9) receipt must count the keep-self union" >&2; echo "$out" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY2' || { echo "(9) --except must leave the spared row untouched" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
import json, sys
a = json.load(open(sys.argv[1]))["seats"]
assert a["codex"]["status"] == "active", a["codex"]
assert a["codex"].get("pane_id") == "%103", ("spared row must keep its pane binding", a["codex"])
assert a["sonnet"]["status"] == "suspended", a["sonnet"]
print("ok")
PY2
# The plan surface names the spared set too, so --dry-run previews the same
# decision the mutation would make.
write_fixture
: > "$KILL_LOG"
plan="$("$TAP" team down --dry-run --except codex </dev/null)"
[[ "$plan" == *"spared by --except (rows unchanged): codex (excepted"* ]] \
  || { echo "(9) dry-run plan must name the spared seat" >&2; echo "$plan" >&2; exit 1; }
[[ "$plan" != *"kill session demo/codex"* ]] \
  || { echo "(9) dry-run plan still lists the spared session as a kill target" >&2; echo "$plan" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(9) dry-run killed a session" >&2; exit 1; }
echo "team-down: (9) --except spares the named seat and stops the rest: ok"

# (9a) a repeated handle is a usage error with zero effects; a unique
# --except carries the excluded + acted-on sets in --json.
write_fixture
: > "$KILL_LOG"
_td9a_dup_rc=0
dup_out="$("$TAP" team down --yes --keep-self --except codex,codex --json </dev/null 2>&1)" || _td9a_dup_rc=$?
[ "$_td9a_dup_rc" != 0 ] && [[ "$dup_out" == *usage_error* && "$dup_out" == *"repeats handle 'codex'"* ]] \
  || { echo "(9a) repeated --except handle must refuse usage_error (rc=$_td9a_dup_rc): $dup_out" >&2; exit 1; }
[ ! -s "$KILL_LOG" ] || { echo "(9a) the repeated-handle refusal killed sessions" >&2; cat "$KILL_LOG" >&2; exit 1; }
_td9a_rc=0
js="$("$TAP" team down --yes --keep-self --except codex --json </dev/null)" || _td9a_rc=$?
# write_fixture's "recycled" seat is not in this --except set, so it is still
# an unverified-pane refusal (exit-code truthfulness) — this run
# is genuinely partial and must exit nonzero. This arm's actual subject
# (dedupe + --json exclusion shape) is unaffected.
[ "$_td9a_rc" != 0 ] \
  || { echo "(9a) --except down exited 0 despite a genuine partial (recycled's unverified pane)" >&2; echo "$js" >&2; exit 1; }
python3 -B -c '
import json, sys
d = json.loads(sys.argv[1])
assert sorted(d["excluded_handles"]) == ["claude", "codex"], ("except + keep-self union", d)
assert "demo/codex" in d["spared_sessions"], d
assert "demo/claude" in d["spared_sessions"], ("keep-self session belongs to the union", d)
assert "demo/sonnet" in d["stopped_sessions"], ("acted-on set must still be present", d)
assert "demo/codex" not in d["stopped_sessions"], d
' "$js" || { echo "(9a) --json exclusion shape wrong" >&2; echo "$js" >&2; exit 1; }
echo "team-down: (9a) repeated handle refuses; --json carries excluded_handles + spared_sessions + keep-self union: ok"

# (9b) an unknown handle FAILS LOUD, naming the handle and the live roster.
write_fixture
: > "$KILL_LOG"
set +e
bad="$(TAP_JSON=1 "$TAP" team down --json --yes --except codexx </dev/null 2>&1)"; brc=$?
set -e
[ "$brc" = 1 ] || { echo "(9b) unknown --except handle must refuse (got $brc)" >&2; echo "$bad" >&2; exit 1; }
[ "$(err_class "$bad")" = not_found ] \
  || { echo "(9b) unknown --except handle needs error_class=not_found" >&2; echo "$bad" >&2; exit 1; }
[[ "$bad" == *"codexx"* ]] || { echo "(9b) refusal must name the unmatched handle" >&2; echo "$bad" >&2; exit 1; }
[[ "$bad" == *"roster:"*"codex"* && "$bad" == *"sonnet"* ]] \
  || { echo "(9b) refusal must name the live roster" >&2; echo "$bad" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(9b) a refused --except must stop nothing" >&2; cat "$KILL_LOG" >&2; exit 1; }
echo "team-down: (9b) unknown handle refuses with not_found naming handle + roster; kills nothing: ok"

# (9c) refusals: empty value (usage_error), no operand (target_required), team-qualified form (usage_error).
for arm in empty missing qualified; do
  case "$arm" in
    empty)     set -- --except "" ;;
    missing)   set -- --except ;;
    qualified) set -- --except demo/codex ;;
  esac
  set +e
  u="$(TAP_JSON=1 "$TAP" team down --json --yes "$@" </dev/null 2>&1)"; urc=$?
  set -e
  [ "$urc" = 1 ] || { echo "(9c/$arm) must refuse (got $urc)" >&2; echo "$u" >&2; exit 1; }
  # A bare --except is the picker form: with no terminal and no team
  # operand there is nothing to choose from, so it refuses target_required.
  want_class=usage_error; [ "$arm" = missing ] && want_class=target_required
  [ "$(err_class "$u")" = "$want_class" ] \
    || { echo "(9c/$arm) needs error_class=$want_class" >&2; echo "$u" >&2; exit 1; }
done
[[ "$u" == *"team-qualified"* ]] \
  || { echo "(9c) the team/handle refusal must say why" >&2; echo "$u" >&2; exit 1; }
echo "team-down: (9c) empty value / team-qualified handle are usage errors; missing operand is target_required: ok"

# (9d) every seat spared is a LEGAL no-op with an explicit line — not silence.
write_fixture
: > "$KILL_LOG"
before_all="$(cat "$TAP_HOME/registry.json")"
noop="$("$TAP" team down --yes --except claude,codex,sonnet,pollbot,recycled </dev/null)"
[[ "$noop" == *"no seats matched after exclusions"* && "$noop" == *"codex"* ]] \
  || { echo "(9d) all-spared must print the explicit no-op line" >&2; echo "$noop" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(9d) all-spared stopped a session" >&2; cat "$KILL_LOG" >&2; exit 1; }
[ "$before_all" = "$(cat "$TAP_HOME/registry.json")" ] \
  || { echo "(9d) all-spared mutated the registry" >&2; exit 1; }
echo "team-down: (9d) every seat spared = exit 0, explicit line, registry untouched: ok"

# (9e) sparing a seat spares its whole SESSION — a kill is session-granular, so
# a co-tenant kill would take the spared seat down with it (the 4b orphan class).
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude":   {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101",  "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "claude-2": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.1", "pane_id": "%102", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":    {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103",   "harness": "codex", "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
: > "$KILL_LOG"
"$TAP" team down --yes --except claude-2 </dev/null >/dev/null
grep -qx "demo/claude" "$KILL_LOG" && { echo "(9e) killed the session hosting the spared seat" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG" || { echo "(9e) unnamed teammate codex must still stop" >&2; cat "$KILL_LOG" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY2' || { echo "(9e) co-tenant sparing wrong" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
import json, sys
a = json.load(open(sys.argv[1]))["seats"]
assert a["claude-2"]["status"] == "active", a["claude-2"]
assert a["claude"]["status"] == "active", ("co-tenant of a spared session keeps its live row", a["claude"])
assert a["codex"]["status"] == "suspended", a["codex"]
print("ok")
PY2
echo "team-down: (9e) sparing a seat spares its session and every co-tenant: ok"
write_fixture

# --- (8) unverified pane + kill failure ⇒ loud partial-down; prior rows exact --
# Fixture: one killable teammate (codex), one unverified (recycled), one poll.
# Mock kill-session for demo/codex succeeds in log but has-session stays live
# (append to UNKILLABLE) so the post-kill probe restores the prior row.
write_fixture
: > "$KILL_LOG"
UNKILLABLE="$(mktemp)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"; rm -f "$KILL_LOG" "$LIVE_SESSIONS" "$UNKILLABLE"' EXIT
# Patch mock: after kill-session of demo/codex, keep has-session succeeding.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
resolve_session() {
  local target="$1" exact=0 name
  case "$target" in =*) exact=1; target="${target#=}" ;; esac
  printf '%s' "$target"
  return 0
}
pane_id_for() {
  case "$1" in
    *dead*|"%105") printf '' ;;
    "demo/claude:0.0") printf '%%101' ;;
    "demo/codex:0.0")  printf '%%103' ;;
    "demo/sonnet:0.0") printf '%%104' ;;
    "recycled-addr")  printf '%%106' ;;
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
tty_for() { case "$1" in "%101"|"demo/claude:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac; }
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")" || exit 1
    printf '%s\n' "$resolved" >> "${KILL_LOG}"
    # Survivor: demo/codex refuses to die for this probe.
    if [ "$resolved" = "demo/codex" ]; then
      printf '%s\n' "$resolved" >> "${UNKILLABLE}"
    fi
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")" || exit 1
    if [ -n "${UNKILLABLE:-}" ] && [ -f "$UNKILLABLE" ] && grep -qxF "$resolved" "$UNKILLABLE" 2>/dev/null; then
      exit 0
    fi
    if [ -n "${KILL_LOG:-}" ] && [ -f "$KILL_LOG" ] && grep -qxF "$resolved" "$KILL_LOG" 2>/dev/null; then
      exit 1
    fi
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    [ "$all" = 1 ] && { printf '%%101\t%s\n' "$(tty_for %101)"; exit 0; }
    case "${target#=}" in
      demo/claude) printf '%s\n' '%101' '%102' ;;
      demo/codex)  printf '%s\n' '%103' ;;
      demo/sonnet) printf '%s\n' '%104' ;;
      *) printf '%%p1\n' ;;
    esac
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        case "$target" in
          "%101"|"%102"|"demo/claude:0.0"|"demo/claude:0.1") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          "%104"|"demo/sonnet:0.0") resolved_session="demo/sonnet" ;;
          "recycled-addr"|"%106") resolved_session="someone-elses-session" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$resolved_session" "${FAKE_EPOCH_RAW-900:100}" ;;
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        case "$target" in
          "%101"|"%102"|"demo/claude:0.0"|"demo/claude:0.1") resolved_session="demo/claude" ;;
          "%103"|"demo/codex:0.0") resolved_session="demo/codex" ;;
          "%104"|"demo/sonnet:0.0") resolved_session="demo/sonnet" ;;
          "recycled-addr"|"%106") resolved_session="someone-elses-session" ;;
          *) resolved_session="${target%%:*}" ;;
        esac
        printf '%s\t%s' "$resolved" "$resolved_session"
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "${FAKE_EPOCH_RAW-900:100}"
        printf '\n' ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      *pane_id*) pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        case "$target" in
          "%101"|"%102") echo "demo/claude" ;;
          "%103")  echo "demo/codex" ;;
          "%104") echo "demo/sonnet" ;;
          "recycled-addr"|"%106") echo "someone-elses-session" ;;
          *) echo "${target%%:*}" ;;
        esac ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export UNKILLABLE
before_codex="$(python3 -B -c 'import json; print(json.dumps(json.load(open("'"$TAP_HOME"'/registry.json"))["seats"]["codex"], sort_keys=True))')"
before_recycled="$(python3 -B -c 'import json; print(json.dumps(json.load(open("'"$TAP_HOME"'/registry.json"))["seats"]["recycled"], sort_keys=True))')"
TD8_ERR="$(mktemp "$TAP_HOME/td8.XXXXXX")"
td8_rc=0
js="$("$TAP" team down --yes --json --keep-self </dev/null 2>"$TD8_ERR")" || td8_rc=$?
# THE EXIT CODE MUST BE TRUTHFUL (exit-code truthfulness): this
# scenario is a genuine kill-failure plus an unverified pane, not a deliberate
# selection spare — `|| true` here used to let the command's own nonzero exit
# vanish, so this regression could not have caught the very defect it exists
# to enforce (the assertion below reads "partial": true from the SAME run
# whose exit status this masked). A refused/kill-failed partial run must exit
# nonzero for a supervisor reading only the exit code, same as the JSON and
# text already say "partially down".
[ "$td8_rc" != 0 ] || { echo "(8) partial-down run exited 0; a supervisor reading only the exit code would see success" >&2; exit 1; }
python3 -B -c '
import json, sys
d = json.loads(sys.argv[1])
assert "demo/codex" in d.get("refused_sessions", []), d
assert "recycled" in d.get("refused_handles", []), d
assert "pollbot" in d.get("retained_poll", []), d
assert d.get("partial") is True, d
assert "demo/codex" not in d.get("stopped_sessions", []), d
' "$js" || { echo "(8) partial-down JSON wrong" >&2; echo "$js" >&2; cat "$TD8_ERR" >&2; exit 1; }
after_codex="$(python3 -B -c 'import json; print(json.dumps(json.load(open("'"$TAP_HOME"'/registry.json"))["seats"]["codex"], sort_keys=True))')"
after_recycled="$(python3 -B -c 'import json; print(json.dumps(json.load(open("'"$TAP_HOME"'/registry.json"))["seats"]["recycled"], sort_keys=True))')"
[ "$before_codex" = "$after_codex" ] || { echo "(8) kill-failure must restore exact prior codex row" >&2; echo "before=$before_codex after=$after_codex" >&2; exit 1; }
[ "$before_recycled" = "$after_recycled" ] || { echo "(8) unverified recycled row must stay exact" >&2; exit 1; }
# Text path also names partial-down when not --json.
write_fixture
: > "$KILL_LOG"; : > "$UNKILLABLE"
tout_rc=0
tout="$("$TAP" team down --yes --keep-self </dev/null 2>&1)" || tout_rc=$?
[ "$tout_rc" != 0 ] || { echo "(8) text-path partial-down run exited 0; a supervisor reading only the exit code would see success" >&2; echo "$tout" >&2; exit 1; }
[[ "$tout" == *"partially down"* ]] || { echo "(8) text receipt must say partially down" >&2; echo "$tout" >&2; exit 1; }
[[ "$tout" == *"retained"* && "$tout" == *"poll"* ]] || { echo "(8) text must name retained poll" >&2; echo "$tout" >&2; exit 1; }
echo "team-down: (8) kill failure + unverified pane = loud partial-down; prior rows exact: ok"

echo "team-down: ok"
