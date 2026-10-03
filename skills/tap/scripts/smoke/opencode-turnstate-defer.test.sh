#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# OpenCode's composer accepts queued input during a turn. Polite delivery uses
# its longer window, not a second SQLite focus gate (L1 U4). Keep the real DB
# fixture to prove a known running turn no longer changes readiness, and exact
# classifications so an identity refusal cannot masquerade as a ready result.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "opencode-turnstate-defer: $*" >&2; exit 1; }

# A fake tmux that LOGS every call and answers display-message BY FORMAT, so a
# pane can be simultaneously "running opencode" and "not in copy-mode" — the
# ordinary shape this code sees in production.
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_TMUX_LOG:?}"
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions) printf 'fixture\t123:456\t0\n' ;;
  list-panes) printf 'fixture\tfixture:0.0\t%%1\t%s\t4242\t123:456\t0\n' "${FAKE_PANE_CMD:-opencode}" ;;
  display-message)
    for a in "$@"; do
      case "$a" in
        '#{pane_current_command}') printf '%s\n' "${FAKE_PANE_CMD:-opencode}"; exit 0 ;;
        '#{pane_in_mode}')         printf '0\n'; exit 0 ;;
      esac
    done
    printf '%%1\n' ;;
  capture-pane)
    if [ "${FAKE_PANE_CMD:-opencode}" = opencode ]; then
      if [ "${FAKE_OPENCODE_OVERPRINT:-0}" = 1 ]; then
        printf '  ┃  [claude-mem-capture] Worker POST failed: socket closed unexpectedly\n  ┃\n  ┃  Build · fixture\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
      else
        printf '  ┃\n  ┃  Build · fixture\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
      fi
    else
      printf '\n'
    fi ;;
esac
exit 0
TMUX
chmod +x "$BIN/tmux"
export PATH="$BIN:$PATH" TAP_SERVER_EPOCH="srv:123:456" TAP_BOOT_ID="boot:1"
export FAKE_TMUX_LOG="$WORK/tmux.log"; : > "$FAKE_TMUX_LOG"

# opencode's own state machine, with a realistic history depth so the query is
# not answering from a single row.
DB="$WORK/opencode.db"
python3 -B - "$DB" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id)")
# The real store keeps session and creation time in columns and omits sessionID from data.
rows = [(f"m{i}", "ses_busy", i, i, json.dumps({"role": "assistant",
                              "time": {"created": i, "completed": i + 1},
                              "finish": "stop"})) for i in range(200)]
# in-turn == time.completed IS NULL on the LATEST assistant message
rows.append(("m-live", "ses_busy", 9999, 9999, json.dumps({"role": "assistant",
                                   "time": {"created": 9999}})))
rows.append(("m-idle", "ses_idle", 5, 5, json.dumps({"role": "assistant",
                                   "time": {"created": 5, "completed": 6},
                                   "finish": "stop"})))
db.executemany("INSERT INTO message VALUES (?,?,?,?,?)", rows)
db.commit()
PY
export OPENCODE_DB_PATH="$DB"

mkreg() { # <path> <session-id-or-empty>
  python3 -B - "$1" "$2" <<'PY'
import json, sys
path, sid = sys.argv[1:3]
seat = {"harness": "opencode", "status": "active", "pane_id": "%1", "pane": "fixture:0.0", "session": "fixture", "server_epoch": "srv:123:456", "boot_id": "boot:1"}
if sid:
    seat["harness_session_id"] = sid
json.dump({"schema": "0.20", "team": {"name": "t"}, "seats": {"oc": seat}}, open(path, "w"))
PY
}
mkreg "$WORK/busy.json" ses_busy
mkreg "$WORK/idle.json" ses_idle
mkreg "$WORK/nosid.json" ""

# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
export TAP_HOME="$WORK/bus"
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/spool-readiness-fixture.sh
. "$ROOT/skills/tap/scripts/smoke/spool-readiness-fixture.sh"

# --- drain-side arms ---------------------------------------------------------
# Executable observations above make the native identity/readiness path real.

ready_for() { # <registry> <policy> [pane_cmd]
  FAKE_PANE_CMD="${3:-opencode}" spool_pane_ready_fixture "fixture:0.0" "%1" "oc" "t" "$1" "$2"
}

# --- (2) POLITE + MID-TURN -> ready: the window supplies focus spacing --------
got="$(ready_for "$WORK/busy.json" polite)"
[ "$got" = "ready" ] \
  || fail "(2) a --polite entry bound to a mid-turn opencode seat with a composer must classify ready, got '$got'"

# --- (3) POLITE + IDLE must not claim in-turn ---------------------------------
# Without this, a check that answered "busy" unconditionally would pass (2) and
# park every polite opencode message until its deadline.
got="$(ready_for "$WORK/idle.json" polite)"
[ "$got" = "ready" ] \
  || fail "(3) an IDLE opencode seat must classify ready, got '$got' — busy:in-turn here parks polite traffic that should flow"

# --- (4) DEFAULT POLICY + MID-TURN must not claim in-turn ---------------------
# All delivery policies consult the same composer readiness for OpenCode.
got="$(ready_for "$WORK/busy.json" "")"
[ "$got" = "ready" ] \
  || fail "(4) a DEFAULT-policy entry must classify ready against a mid-turn seat, got '$got' — busy:in-turn is --polite only"
got="$(ready_for "$WORK/busy.json" urgent)"
[ "$got" = "ready" ] \
  || fail "(4) an urgent entry must classify ready against a mid-turn seat, got '$got' — busy:in-turn is --polite only"

# --- (5) FAIL-OPEN when the state is unknowable ------------------------------
# Opposite polarity to the rest of this file, deliberately: a wrong "busy" parks
# real traffic, while a wrong "idle" only delivers into a turn that queues it. An
# absent session id or an unreadable DB must never start parking polite mail.
got="$(ready_for "$WORK/nosid.json" polite)"
[ "$got" = "ready" ] \
  || fail "(5) a seat with no harness_session_id must classify ready, got '$got' — the check must fail OPEN"
got="$(OPENCODE_DB_PATH="$WORK/does-not-exist.db" ready_for "$WORK/busy.json" polite)"
[ "$got" = "ready" ] \
  || fail "(5) an unreadable opencode DB must classify ready, got '$got' — the check must fail OPEN"

# --- (6) OVERPRINT is the detector's verdict, never parked as no-band -------
# The walk names the debris (busy:overprint) instead of parking it as no-band, which
# would bypass the courier's submit. The bounded-healing disposition (tap-cl1es)
# lives at the drain: withOverprintRetry maps a DUE episode to ready so the attempt
# reaches the locked submit/repaint owner (runtime/bun/test/overprint-heal.test.ts).
export FAKE_OPENCODE_OVERPRINT=1
got="$(ready_for "$WORK/idle.json" polite)"
unset FAKE_OPENCODE_OVERPRINT
[ "$got" = "busy:overprint" ] \
  || fail "(6) an OpenCode terminal overprint must read busy:overprint at the walk (the drain maps a due episode to ready), got '$got'"

# --- (7) other harnesses are untouched ---------------------------------------
# Must not become an idle-only gate for anyone else: codex against the SAME
# mid-turn registry and the SAME polite policy takes the ordinary band read.
# Keep the registry identity consistent with this control's observed harness.
python3 -B - "$WORK/busy.json" <<'PY_CONTROL'
import json, sys
path = sys.argv[1]
data = json.load(open(path)); data["seats"]["oc"]["harness"] = "codex"
with open(path, "w") as out: json.dump(data, out)
PY_CONTROL
got="$(ready_for "$WORK/busy.json" polite codex)"
[ "$got" = "busy:noprompt" ] \
  || fail "(7) a codex target must take the ordinary band read (busy:noprompt here), got '$got' — the opencode DB check must not reach it"

echo "opencode-turnstate-defer: ok"
