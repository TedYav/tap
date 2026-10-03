#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# team-shutdown.test.sh — `tap team shutdown` ends this team's sessions + deletes
# the registry (tap-w3op; --keep-self retains spared seats in-file). Covers:
# identity-first kill list (FLAG 1), kill-teammates-then-delete-then-self-last
# ordering (FLAG 2), preview obligations warn (FLAG 3), --dry-run, --keep-self,
# gate-free unsettled-inbound warnings, and --json.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
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
    # Post-kill probe: a session recorded in KILL_LOG is gone.
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
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$resolved_session" "${FAKE_EPOCH_RAW:-900:100}" ;;
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
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "${FAKE_EPOCH_RAW:-900:100}"
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
import json, os, sys
path, handle = sys.argv[1], sys.argv[2]
if not os.path.isfile(path):
    sys.exit(1)  # deleted registry ⇒ no seats (tap-w3op shutdown)
agents = json.load(open(path)).get("seats") or {}
sys.exit(0 if handle in agents else 1)
PY
}

# Pretend we're inside tmux so TAP resolves the caller's pane (the mock's no-target
# display-message returns demo/claude:0.0 -> pane_id %101 -> the "claude" seat).
export TMUX="/tmp/fake,0,0"

# --- (1) dry-run: plans, kills nothing, leaves registry byte-identical ---------
write_fixture
: > "$KILL_LOG"
before="$(cat "$TAP_HOME/registry.json")"
out="$("$TAP" team shutdown --dry-run)"
[[ "$out" == *"kill session demo/codex"* ]] || { echo "(1) codex not in dry-run plan" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"kill session demo/sonnet"* ]] || { echo "(1) sonnet not in dry-run plan" >&2; echo "$out" >&2; exit 1; }
grep -Eq "retained poll \(unregister only\):.*pollbot \(poll\)|no tmux to kill \(unregister only\):.*pollbot \(poll\)" <<<"$out" \
  || { echo "(1) pollbot not shown as unregister-only" >&2; echo "$out" >&2; exit 1; }
# The no-kill reason is the verifier's own token (tap-24f): one vocabulary
# across every terminating path, so `pane_gone` here reads the same as
# `server_epoch_stale` / `server_epoch_unproven` elsewhere.
[[ "$out" == *"recycled (server_epoch_unproven)"* ]] || { echo "(1) recycled dead-pane_id not shown as server_epoch_unproven" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"someone-elses-session"* ]] && { echo "(1) FLAG 1 VIOLATION: recycled address's session appeared in plan" >&2; echo "$out" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(1) dry-run killed a session" >&2; cat "$KILL_LOG" >&2; exit 1; }
[ "$before" = "$(cat "$TAP_HOME/registry.json")" ] || { echo "(1) dry-run mutated registry" >&2; exit 1; }
echo "team-shutdown: (1) dry-run plans without killing or mutating: ok"

# --- (2) bare non-TTY proceeds and warns on unsettled inbound -----------------
# Ratified boundary: tap-7r9c.
write_fixture
: > "$KILL_LOG"
printf 'to: demo/codex\nfrom: smoke\n\nqueued\n' > "$TAP_HOME/payloads/busy.md"
SHUTDOWN_OUT="$(mktemp "$TAP_HOME/shutdown-out.XXXXXX")"
SHUTDOWN_ERR="$(mktemp "$TAP_HOME/shutdown-err.XXXXXX")"
"$TAP" team shutdown --keep-self </dev/null >"$SHUTDOWN_OUT" 2>"$SHUTDOWN_ERR" \
  || { echo "(2) bare non-TTY shutdown should proceed" >&2; cat "$SHUTDOWN_OUT" "$SHUTDOWN_ERR" >&2; exit 1; }
grep -qi "warning:.*codex=1" "$SHUTDOWN_ERR" \
  || { echo "(2) unsettled-inbound warning omitted codex=1" >&2; cat "$SHUTDOWN_ERR" >&2; exit 1; }
grep -qi "claude=0" "$SHUTDOWN_ERR" \
  || { echo "(2) unsettled-inbound warning omitted zero-count claude" >&2; cat "$SHUTDOWN_ERR" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG" || { echo "(2) bare shutdown did not stop codex" >&2; cat "$KILL_LOG" >&2; exit 1; }
has_agent codex && { echo "(2) bare shutdown retained codex row" >&2; exit 1; }
has_agent claude || { echo "(2) --keep-self did not retain caller row" >&2; exit 1; }
echo "team-shutdown: (2) bare non-TTY proceeds with unsettled-inbound seat counts: ok"

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
    ["/bin/bash", "-c", f'"{tap}" team shutdown --keep-self'],
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

assert proc.returncode == 0, f"busy TTY should proceed, got {proc.returncode}: {stdout_text!r} {stderr_text!r}"
assert "? [y/N]" not in stderr_text, f"busy TTY unexpectedly prompted: {stderr_text!r}"
assert "warning:" in stderr_text.lower(), f"busy TTY omitted warning: {stderr_text!r}"
assert "codex=1" in stderr_text, f"busy TTY warning omitted codex=1: {stderr_text!r}"
print("team-shutdown: (2b) busy TTY proceeds without prompt and warns: ok")
PY

# --- (3) --yes: teammates killed FIRST, self LAST, registry deleted, FLAG 1 ----
write_fixture
: > "$KILL_LOG"
rm -f "$TAP_HOME/payloads/busy.md"
out="$("$TAP" team shutdown --yes </dev/null)"
# self (demo/claude) must be the LAST kill; teammates before it.
last="$(tail -n1 "$KILL_LOG")"
[ "$last" = "demo/claude" ] || { echo "(3) self session not killed last (last=$last)" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(3) codex session not killed" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/sonnet" "$KILL_LOG" || { echo "(3) sonnet session not killed" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -q "someone-elses-session" "$KILL_LOG" && { echo "(3) FLAG 1 VIOLATION: killed a recycled address's session" >&2; cat "$KILL_LOG" >&2; exit 1; }
# codex and sonnet appear before demo/claude in the log (self last).
grep -n . "$KILL_LOG" | awk -F: '$0 ~ /demo\/claude$/{self=$1} $0 ~ /demo\/codex$/{codex=$1} END{exit !(codex<self)}' \
  || { echo "(3) codex not killed before self" >&2; cat "$KILL_LOG" >&2; exit 1; }
# registry deleted (tap-w3op shutdown); event log is preserve-fated beside the bus.
[ ! -e "$TAP_HOME/registry.json" ] || { echo "(3) registry file survived shutdown" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex && { echo "(3) registry not deleted" >&2; exit 1; }
has_agent claude && { echo "(3) self row survived (no --keep-self)" >&2; exit 1; }
grep -q 'team-shutdown' "$TAP_HOME/registry-events.log" || { echo "(3) missing shutdown event" >&2; exit 1; }
echo "team-shutdown: (3) --yes kills teammates-first/self-last, deletes registry, honors FLAG 1: ok"

# --- (4) --force compatibility no-op + --keep-self -----------------------------
write_fixture
: > "$KILL_LOG"
out="$("$TAP" team shutdown --force --keep-self </dev/null)"
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4) --keep-self killed self session" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4) --keep-self did not kill teammate codex" >&2; exit 1; }
has_agent claude || { echo "(4) --keep-self dropped self row" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex  && { echo "(4) --keep-self kept a teammate row" >&2; exit 1; }
echo "team-shutdown: (4) --force is a no-op; --keep-self spares self session and row: ok"

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
"$TAP" team shutdown --yes --keep-self </dev/null >/dev/null
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4b) --keep-self killed the shared self session" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4b) teammate codex not killed" >&2; exit 1; }
has_agent claude   || { echo "(4b) caller row dropped" >&2; exit 1; }
has_agent claude-2 || { echo "(4b) BUG: pane-crew sibling orphaned (live pane, no registry row)" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex    && { echo "(4b) teammate row survived" >&2; exit 1; }
echo "team-shutdown: (4b) --keep-self retains ALL seats in the spared session: ok"

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
"$TAP" team shutdown --yes --keep-self </dev/null >/dev/null
grep -qx "demo/claude" "$KILL_LOG" && { echo "(4c) killed the spared session hosting live seats" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/codex" "$KILL_LOG"  || { echo "(4c) teammate codex not killed" >&2; exit 1; }
has_agent claude-2 || { echo "(4c) BUG: seat in spared session orphaned under unregistered caller" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex    && { echo "(4c) teammate row survived" >&2; exit 1; }
echo "team-shutdown: (4c) unregistered caller --keep-self keeps spared-session seats: ok"

# --- (5) --json shape ----------------------------------------------------------
write_fixture
: > "$KILL_LOG"
"$TAP" team shutdown --json --dry-run </dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["team"] == "demo", d
assert d["dry_run"] is True, d
assert d["self_session"] == "demo/claude", d
assert set(d["killed_sessions"]) == {"demo/codex", "demo/sonnet", "demo/claude"}, d
assert "someone-elses-session" not in d["killed_sessions"], d
' || { echo "(5) --json shape wrong" >&2; "$TAP" team shutdown --json --dry-run </dev/null >&2; exit 1; }
echo "team-shutdown: (5) --json shape parses and excludes recycled session: ok"

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
out="$("$TAP" team shutdown --dry-run)"
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
"$TAP" team shutdown --yes --keep-self </dev/null >/dev/null 2>&1
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
echo "team-shutdown: (6) vanished exact name neither reports nor kills its -2 sibling: ok"

# --- (8) --except (tap-nt4c): shutdown is the DELETING policy -----------------
# down suspends a spared row; shutdown deletes the registry file, so a spared
# seat whose row is not written into keep_file becomes the 4b orphan — a live
# pane with no registry row, and here it is the very seat the operator named.
# The co-tenant arm matters for the same reason: sparing codex spares session
# demo/codex, and any seat sharing it must keep its row too.
write_fixture
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["codex-2"] = {
    "status": "active", "delivery": "pane", "pane": "demo/codex:0.1",
    "pane_id": "%107", "harness": "codex", "server_epoch": "srv:900:100",
    "session": "demo/codex",
}
json.dump(reg, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
: > "$KILL_LOG"
sd="$("$TAP" team shutdown --yes --keep-self --except codex </dev/null)"
grep -qx "demo/codex" "$KILL_LOG" && { echo "(8) --except codex killed its session" >&2; cat "$KILL_LOG" >&2; exit 1; }
grep -qx "demo/sonnet" "$KILL_LOG" || { echo "(8) unnamed seat sonnet must still be ended" >&2; cat "$KILL_LOG" >&2; exit 1; }
[ -f "$TAP_HOME/registry.json" ] \
  || { echo "(8) BUG: spared seats must filter the registry in place, not delete it" >&2; exit 1; }
has_agent codex   || { echo "(8) BUG: the seat named in --except lost its row" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent codex-2 || { echo "(8) BUG: co-tenant of a spared session orphaned (live pane, no row)" >&2; cat "$TAP_HOME/registry.json" >&2; exit 1; }
has_agent claude  || { echo "(8) --keep-self row dropped alongside --except" >&2; exit 1; }
has_agent sonnet  && { echo "(8) an unnamed teammate row survived shutdown" >&2; exit 1; }
[[ "$sd" == *"spared"*"--except: codex"* ]] \
  || { echo "(8) receipt must name the spared set" >&2; echo "$sd" >&2; exit 1; }
echo "team-shutdown: (8) --except retains the spared row AND its session co-tenant instead of deleting: ok"

# --- (7) blank/empty registry still deletes (tap-w3op) ---------
# Class (a) CONTRACT §Registry lifecycle: seats PRESENT-as-{} takes the
# shutdown deletion arm (not the pre-w3op "nothing to shut down" early return).
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{}}
JSON
out="$("$TAP" team shutdown --yes </dev/null)"
[[ "$out" == *"deleted blank acting registry"* || "$out" == *"next: tap init"* ]] \
  || { echo "(7) blank registry must delete (not early-return friendly): $out" >&2; exit 1; }
[ ! -e "$TAP_HOME/registry.json" ] || { echo "(7) blank registry file survived" >&2; exit 1; }
echo "team-shutdown: (7) blank registry deletes: ok"

echo "team-shutdown: ok"
