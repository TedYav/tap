#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# agy-polite-focus.test.sh — tap-92v3r. Antigravity's two questions, kept apart.
#
# TAP asks two different things about a busy pane, and lib.sh's tap_spool_pane_ready
# header says merging them is a bug:
#
#   INJECTION SAFETY — "is there a band to type into?" True or false regardless of
#     who is sending. Every policy obeys it.
#   FOCUS           — "would delivering now break this seat's concentration?" Only
#     --polite treats the answer as a reason to wait.
#
# agy had them fused. Its readiness gate refused every generating pane, so ordinary
# delivery got a five-minute deadline and a false "it will not arrive" for a seat
# that was one send-keys away (the tap-92v3r incident), while --polite got focus
# protection it never asked for and nobody had to write.
#
# Splitting them is what this file pins. Band geometry answers injection safety;
# the readiness walk's focus branch answers focus, and only under policy=polite.
#
# ARM (4) IS THE REGRESSION ARM. Same pane and same capture as arm (1) — only the
# policy differs, which is the whole point. Before tap-92v3r it returned
# busy:noprompt; a change that re-fuses the two questions turns it red on its own,
# without needing arm (1) to fail first. Structure and identity-stub rationale are
# taken from opencode-turnstate-defer.test.sh, which pins the same seam for the
# only other harness in this gate.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CAP="$ROOT/skills/tap/scripts/smoke/fixtures/agy-capture-20260903"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "agy-polite-focus: $*" >&2; exit 1; }

# Real capture bytes, not rebuilt geometry — see the directory's PROVENANCE.md.
for f in idle-243 tool-running-254 task-idle-footer-228; do
  [ -s "$CAP/$f.txt" ] || fail "missing capture fixture $CAP/$f.txt"
done
# The one CONSTRUCTED fixture in this file, and it is constructed because no live
# agy seat on the fleet renders a bandless pane (PROVENANCE.md records the survey).
# It carries a transcript '>' echo precisely so "no band" cannot be satisfied by
# "no '>' anywhere".
cat > "$WORK/noband.txt" <<'NOBAND'
  A full-screen view with no input band.
> a transcript echo, not the live band
  ...more text...
NOBAND

BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions) printf 'fixture\t123:456\t0\n' ;;
  list-panes) printf 'fixture\tfixture:0.0\t%%1\t%s\t4242\t123:456\t0\n' "${FAKE_PANE_CMD:-agy}" ;;
  display-message)
    for a in "$@"; do
      case "$a" in
        '#{pane_current_command}') printf '%s\n' "${FAKE_PANE_CMD:-agy}"; exit 0 ;;
        '#{pane_in_mode}')         printf '0\n'; exit 0 ;;
      esac
    done
    printf '%%1\n' ;;
  capture-pane) cat "${FAKE_CAPTURE:?fake tmux: FAKE_CAPTURE unset}" ;;
esac
exit 0
TMUX
chmod +x "$BIN/tmux"
export PATH="$BIN:$PATH" TAP_SERVER_EPOCH="srv:123:456" TAP_BOOT_ID="boot:1"

python3 -B - "$WORK/reg.json" <<'PY'
import json, sys
json.dump({"schema": "0.20", "team": {"name": "t"},
           "seats": {"gem": {"harness": "agy", "status": "active", "pane_id": "%1", "pane": "fixture:0.0", "session": "fixture", "server_epoch": "srv:123:456", "boot_id": "boot:1"}}},
          open(sys.argv[1], "w"))
PY

# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
export TAP_HOME="$WORK/bus"
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/spool-readiness-fixture.sh
. "$ROOT/skills/tap/scripts/smoke/spool-readiness-fixture.sh"

# Executable observations above make the native identity/readiness path real.

ready_for() { # <capture-file> <policy> [pane_cmd]
  FAKE_CAPTURE="$1" FAKE_PANE_CMD="${3:-agy}" \
    spool_pane_ready_fixture "fixture:0.0" "%1" "gem" "t" "$WORK/reg.json" "$2"
}

# --- (1) POLITE + MID-TURN -> busy:in-turn (the positive control) -------------
# Without this arm, a focus check that never fires would satisfy every other arm
# in the file.
got="$(ready_for "$CAP/tool-running-254.txt" polite)"
[ "$got" = "busy:in-turn" ] \
  || fail "(1) a --polite entry bound to a generating agy seat must classify busy:in-turn, got '$got'"

# --- (2) POLITE + IDLE must not claim in-turn ---------------------------------
# Keeps (1) from being satisfied by a check that answers busy unconditionally,
# which would park every polite agy message until its deadline.
got="$(ready_for "$CAP/idle-243.txt" polite)"
[ "$got" = "ready" ] \
  || fail "(2) an IDLE agy seat must classify ready, got '$got' — busy:in-turn here parks polite traffic that should flow"

# --- (3) POLITE + BACKGROUND TASK, IDLE AGENT -> ready ------------------------
# %228: a task card rendered BELOW the band, the same three-rule geometry as the
# generating fixture, and the IDLE footer. The agent is idle while its task runs.
# A focus check that read the task card instead of the footer would call this seat
# mid-turn and park polite mail behind a background job nobody is waiting on.
got="$(ready_for "$CAP/task-idle-footer-228.txt" polite)"
[ "$got" = "ready" ] \
  || fail "(3) an agy seat with a running background task but an idle footer must classify ready, got '$got' — the focus marker is the footer, not the task card"

# --- (4) DEFAULT POLICY + MID-TURN -> ready (THE tap-92v3r REGRESSION ARM) ----
# Same pane, same capture as (1); only the policy differs. Before this fix the
# answer was busy:noprompt, the payload was held for its 300s deadline, and the
# sender was told "It will not arrive on its own" about a seat that would have
# queued the keystrokes. Focus protection is what --polite BUYS; it must not leak
# into ordinary delivery.
got="$(ready_for "$CAP/tool-running-254.txt" "")"
[ "$got" = "ready" ] \
  || fail "(4) a DEFAULT-policy entry must classify ready against a generating agy seat, got '$got' — agy queues typed input mid-turn (operator, verified by hand 2026-09-03)"
got="$(ready_for "$CAP/tool-running-254.txt" urgent)"
[ "$got" = "ready" ] \
  || fail "(4) an urgent entry must classify ready against a generating agy seat, got '$got' — busy:in-turn is --polite only"

# --- (5) NO BAND still defers, under every policy -----------------------------
# Injection safety is not what the focus split relaxed. A pane with no rule-pair
# band has nothing to type into whoever is asking, and the polite gate must not
# mask that answer with a focus verdict either.
got="$(ready_for "$WORK/noband.txt" "")"
[ "$got" = "busy:noprompt" ] \
  || fail "(5) a bandless agy pane must classify busy:noprompt under default policy, got '$got'"
got="$(ready_for "$WORK/noband.txt" polite)"
[ "$got" = "busy:noprompt" ] \
  || fail "(5) a bandless agy pane must classify busy:noprompt under polite too, got '$got' — the focus gate must fall through, not answer"

# --- (6) THE DEGRADE: a polite park still DELIVERS at its own deadline ---------
# The arm that keeps arm (1) from being a hold nobody ever escapes. busy:in-turn is a
# FOCUS wait, and a focus wait must expire: lib.sh's own header promises "a polite
# entry degrades to delivery on its own deadline", and before tap-92v3r agy reached
# that promise through busy:noprompt, which no longer classifies a generating pane.
# So the promise now depends on a different code path for agy, and an unasserted
# promise is where a permanently-parked seat comes from.
#
# This arm needs a real park, a real drain and a real clock, so it runs against its
# own fixture rather than the classification stub above — `tap_spool_pane_ready` alone
# cannot show delivery. The tmux fake below is this arm's own, independent adaptation, NOT the shared
# fake-tmux-stub.sh that courier-busy-hold and the Bun waiter tests read (changes to
# that stub do not reach it); its capture-pane keeps the agy band on screen while busy
# (which is the whole point) and its identity answers survive the send path.
(
  set -euo pipefail
  export TAP_SPOOL_DISABLE_DELIVERER=1
  D="$(mktemp -d)"; DBIN="$D/bin"; mkdir -p "$DBIN" "$D/tmux" "$D/repo"
  # `|| true` on the same class courier-busy-hold's arm 7 hit under suite concurrency:
  # this arm runs a real drain, and a fork of it can still be writing into $D when the
  # trap fires, at which point `rm -rf` exits non-zero on a repopulated directory and
  # `set -euo pipefail` makes that teardown failure the file's exit status. This arm
  # disables the deliverer so it is less exposed than that one was, but the guard costs
  # nothing and the failure mode is a passing arm reporting FAIL.
  trap 'rm -rf "$D" 2>/dev/null || true' EXIT
cat > "$DBIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
# Numeric ids and session addresses name the same fake pane.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
  args+=("$arg")
done
set -- "${args[@]}"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    # Pane identity is per-TARGET: a fixture that answers one id for every pane
    # cannot exercise a send BACK to the sender (identity_mismatch on every reply).
    target=""; argv=("$@")
    for ((i=0; i<${#argv[@]}; i++)); do [ "${argv[$i]}" = "-t" ] && target="${argv[$((i+1))]}"; done
    case "$target" in
      sess:0.1) pid="%402" ;;
      sess:0.2) pid="%403" ;;
      *)        pid="${FAKE_PANE_ID:-%401}" ;;
    esac
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "$pid" "${FAKE_TMUX_CMD:-codex}" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$pid" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$pid" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "$pid" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  select-pane) echo "select-pane $*" >> "$state/send-keys.log" ;;
  capture-pane)
    # Busy AND the input band are per-PANE. A single shared input file is not a
    # fidelity detail: it makes one pane's stuck submit look like pending human
    # input on every OTHER pane, so a notice sent to a second seat refuses for a
    # reason no real tmux would produce.
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    # AGY GEOMETRY, not the codex shape this fake was adapted from. The band must stay
    # on screen while busy — that is the fact tap-92v3r turns on — and only the FOOTER
    # changes. Written with the codex 'model is generating a response...' body first,
    # and the arm below failed for the wrong reason: no rule pair meant no band, so the
    # redelivery deferred on geometry and never exercised the focus deadline at all.
    _r="$(printf '─%.0s' $(seq 1 100))"
    printf '  Standing by.\n%s\n' "$_r"
    if [ -f "$state/input.$key" ]; then printf '> %s\n' "$(cat "$state/input.$key")"; else printf '> \n'; fi
    printf '%s\n' "$_r"
    if [ -f "$state/busy" ] || { [ -n "$key" ] && [ -f "$state/busy.$key" ]; }; then
      printf 'esc to cancel                          Gemini 3.8 Flash · high\n'
    else
      printf '? for shortcuts                        Gemini 3.8 Flash · high\n'
    fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then rm -f "$state/copy_mode"; exit 0; fi
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input.$key"; exit 0 ;;
      C-u) rm -f "$state/input.$key"; exit 0 ;;
      Enter)
        # The transaction's own window, opened deliberately: this runs after the
        # digest revalidated its ids and before its post-submit bookkeeping, which
        # is the only place a racing cancel or a failing rewrite can be driven
        # DETERMINISTICALLY rather than hoped for.
        if [ -n "${FAKE_AT_DIGEST_SUBMIT:-}" ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          bash -c "$FAKE_AT_DIGEST_SUBMIT" || true
        fi
        # Arm (11): the digest doorbell submits but never verifies (rc 5).
        if [ "${FAKE_TMUX_STUCK_DIGEST_SUBMIT:-0}" = 1 ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          exit 0
        fi
        rm -f "$state/input.$key"
        exit 0
        ;;
    esac ;;
esac
TMUX
  chmod +x "$DBIN/tmux"
  export PATH="$DBIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$D/tmux" \
         FAKE_WORKTREE="$D/repo" FAKE_TMUX_CMD="agy" FAKE_PANE_ID="%401"
  export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
  DBUS="$D/repo/.tap/bus"; mkdir -p "$DBUS/payloads" "$DBUS/receipts" "$DBUS/spool"
  export TAP_HOME="$DBUS"
  cat > "$DBUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$D/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "agy", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$D/repo" },
    "alice": { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "agy", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$D/repo" }
  } }
JSON
  DLOG="$D/tmux/send-keys.log"; : > "$DLOG"
  # The seat is mid-turn: its band is on screen, its footer says esc to cancel.
  touch "$D/tmux/busy.sess_0_0"
  bash "$ROOT/bin/tap" send peer -m "polite note" --id p1 --from alice \
    --polite --polite-timeout 600 >/dev/null 2>&1 || true
  [ -f "$DBUS/spool/p1.md" ] \
    || fail "(6) a --polite send to a mid-turn agy seat did not park — this arm has nothing to degrade"
  grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?p1( |:|\\]\\])" "$DLOG" 2>/dev/null \
    && fail "(6) a --polite send interrupted a mid-turn agy seat instead of parking"

  DL="$(python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("deadline_epoch") or "")
except Exception: print("")' "$DBUS/spool/p1.meta.json")"
  [ -n "$DL" ] || fail "(6) the polite park carries no deadline — it would wait forever"

  # Time passes and the seat is STILL mid-turn. This is the discriminating detail:
  # the focus wait must end because its clock ran out, not because the pane freed.
  TAP_SPOOL_NOW="$(( DL + 1 ))" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" >/dev/null 2>&1 || true
  grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?p1( |:|\\]\\])" "$DLOG" 2>/dev/null \
    || { echo "(6) LOG:"; cat "$DLOG"; fail "(6) a polite agy park never degraded to delivery at its own deadline — a focus wait that does not expire is a parked seat"; }
  [ -f "$DBUS/payloads/p1.md" ] || fail "(6) the degraded delivery did not canonicalize the body"
  [ ! -f "$DBUS/spool/p1.md" ] || fail "(6) retry state survived a completed delivery"
) || exit 1
echo "agy-polite-focus: (6) a polite park degrades to delivery at its own deadline, pane still mid-turn: ok"

# --- (7) other harnesses are untouched ---------------------------------------
# The agy focus arm must not become a gate for anyone else: codex against the SAME
# generating capture and the SAME polite policy takes the ordinary band read.
# Discriminating despite naming the pre-fix value: if the agy focus arm reached a
# codex target it would answer busy:in-turn (this capture's footer says "esc to
# cancel"), and busy:in-turn is not busy:noprompt. codex finds no ›/❯ glyph in an
# agy capture, so the ordinary band read is what busy:noprompt reports here.
# Keep the registry identity consistent with this control's observed harness.
python3 -B - "$WORK/reg.json" <<'PY_CONTROL'
import json, sys
path = sys.argv[1]
data = json.load(open(path)); data["seats"]["gem"]["harness"] = "codex"
with open(path, "w") as out: json.dump(data, out)
PY_CONTROL
got="$(ready_for "$CAP/tool-running-254.txt" polite codex)"
[ "$got" = "busy:noprompt" ] \
  || fail "(7) a codex target must take the ordinary band read (busy:noprompt on an agy capture), got '$got' — the agy focus check must not reach it"

echo "agy-polite-focus: ok"
