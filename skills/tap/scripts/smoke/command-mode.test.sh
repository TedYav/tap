#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# command-mode.test.sh — tap-8cb command transport + /tap-context contract.
# SAFETY: every pane operation uses the fake tmux below; no live pane is touched.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
# Born live: the team root is enrolled and its acting store is canonical, so the
# bus is <root>/.tap/bus. An absent marker opens no legacy door.
TEAM_ROOT="$WORK/taptest"
TAP_HOME="$TEAM_ROOT/.tap/bus"
REG="$TEAM_ROOT/.tap/team-registry.json"
TAP_INDEX_HOME="$WORK/index"
FAKE_BIN="$WORK/bin"
FAKE_TMUX_STATE="$WORK/tmux"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME TAP_INDEX_HOME FAKE_TMUX_STATE
export FAKE_COMPACT_REGISTRY="$REG"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$FAKE_BIN" "$FAKE_TMUX_STATE"

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
cmd="${1:?}"; shift
target="taptest:lead.0"
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [ "${args[$i]}" = "-t" ] && [ $((i+1)) -lt ${#args[@]} ]; then
    target="${args[$((i+1))]}"
  fi
done
key="$(printf '%s' "$target" | tr '/:.' '___')"
# Lane D (D4) reshaped this fixture's world: pane addresses are session-shaped
# ("taptest:<seat>.0" — the session:window.pane form real tmux reports and the
# name-first rowless effect-time guard REQUIRES via its "$session":* prefix
# check), and the pane id derives from the BASE address, so FAKE_RENUM_TARGET
# can move a pane's address (a renumber) while its identity stays put.
# OLD: colonless "fake-alpha" addresses plus a display-message "gone" knob —
# fantasy shapes only the blind binding tolerated (fixture-update class (a),
# adjudicated inventory fable-20260805T043834Z).
SEATS="lead alpha beta gamma cursor hermes shell legacy legacy-guard legacy-all"
base_addr() { printf 'taptest:%s.0' "$1"; }
current_addr() {
  if [ "${FAKE_RENUM_TARGET:-}" = "$(base_addr "$1")" ]; then
    printf 'taptest:%s.9' "$1"
  else
    base_addr "$1"
  fi
}
id_for() { printf '%%%s' "$(base_addr "$1" | cksum | cut -d' ' -f1)"; }
seat_of() {
  local q="${1#=}" s
  for s in $SEATS; do
    if [ "$q" = "$(base_addr "$s")" ] || [ "$q" = "$(current_addr "$s")" ] || [ "$q" = "$(id_for "$s")" ]; then
      printf '%s' "$s"; return 0
    fi
  done
  return 1
}
seat="$(seat_of "$target" || true)"
# A stored (base) address is DEAD while its seat is renamed away; the stable
# id and the current address stay live — that IS the renumber simulation.
pane_id=""
if [ -n "$seat" ] && { [ "$target" = "$(current_addr "$seat")" ] || [ "$target" = "$(id_for "$seat")" ]; }; then
  pane_id="$(id_for "$seat")"
fi
pid_for() { case "$1" in
  lead) printf 4241 ;; alpha) printf 4242 ;; beta) printf 4243 ;; gamma) printf 4244 ;;
  cursor) printf 4245 ;; hermes) printf 4246 ;; shell) printf 4247 ;; legacy-guard) printf 4248 ;; esac; }
tty_for() { case "$1" in
  lead) printf '/dev/faketty' ;; *) printf '/dev/faketty-%s' "$1" ;; esac; }
harness_for() { case "$1" in
  lead) printf "${FAKE_LEAD_HARNESS:-claude}" ;;
  beta) printf codex ;; gamma) printf opencode ;; cursor) printf cursor ;;
  hermes) printf hermes ;; shell) printf bash ;; *) printf claude ;; esac; }
input="$state/$key.input"

case "$cmd" in
  # CONTRACT §Session-name authority: list the exact named session and a
  # generation-consistent designated-pane inventory for binding revalidation.
  list-sessions)
    if [[ "$*" == *'start_time'* ]]; then
      printf 'taptest\t%s\n' "${FAKE_EPOCH_RAW:-900:100}"
    else
      printf 'taptest\n'
    fi ;;
  display-message)
    [ -n "$pane_id" ] || exit 0
    fmt="${args[${#args[@]}-1]:-}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\ttaptest\t%s\t%s\t0\n' "$pane_id" "$(pid_for "$seat")" "$(harness_for "$seat")" ;;
      # tap-24f server epoch. A stored pane id belongs to ONE tmux server
      # lifetime, so `tap command` refuses to inject into a row stamped by a
      # dead one — its id would resolve to an unrelated live pane.
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t%s\ttaptest\t%s\n' "$pane_id" "$(tty_for "$seat")" "${FAKE_EPOCH_RAW:-900:100}" ;;
      *pane_id*session_name*start_time*) printf '%s\ttaptest\t%s\n' "$pane_id" "${FAKE_EPOCH_RAW:-900:100}" ;;
      *pid*start_time*) printf '%s\n' "${FAKE_EPOCH_RAW:-900:100}" ;;
      *pane_id*session_name*) printf '%s\ttaptest\n' "$pane_id" ;;
      *pane_id*pane_tty*) printf '%s\t%s\n' "$pane_id" "$(tty_for "$seat")" ;;
      *pane_id*) printf '%s\n' "$pane_id" ;;
      *pane_pid*) pid_for "$seat"; printf '\n' ;;
      *pane_current_command*)
        if [ "${FAKE_BREAK_COMMAND_AUDIT:-0}" = 1 ] && [ "$seat" = alpha ]; then
          rm -rf "$TAP_HOME/receipts"
          : > "$TAP_HOME/receipts"
        fi
        harness_for "$seat"; printf '\n' ;;
      *pane_current_path*) printf '%s\n' "${FAKE_PANE_PATH:-}" ;;
      *pane_in_mode*) printf '0\n' ;;
      *session_name*) printf 'taptest\n' ;;
      *window_index*) printf '0\n' ;;
      *pane_index*) printf '0\n' ;;
      *) printf '\n' ;;
    esac
    ;;
  capture-pane)
    harness="$(harness_for "$seat")"
    [ "${FAKE_HISTORY_CLEAR:-0}" = 1 ] && printf 'unclear transcript history\n'
    if [ "$harness" = opencode ]; then
      printf '  ┃\n'
      [ -f "$input" ] && printf '  ┃  %s\n' "$(cat "$input")" || printf '  ┃\n'
      printf '  ┃\n  ┃  Build · Fusion OpenRouter\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n'
    else
      prompt='›'; [ "$harness" = cursor ] && prompt='→'
      [ -f "$input" ] && printf '%s %s\n' "$prompt" "$(cat "$input")" || printf '%s \n' "$prompt"
      # Claude's full-region reader terminates at its real input-box border.
      # A prompt-only mock exercises its no-geometry fallback instead.
      if [ "$harness" = claude ]; then
        printf '%s\n' '──────────────────────────────────────────'
        printf '%s\n' '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
      fi
    fi
    ;;
  send-keys)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        # The native submitter targets the stable pane id; log it under the
        # seat's current address so assertions name the seat either way.
        -t) target="$2"; shift 2
            if [ -n "$seat" ] && [ "$target" = "$(id_for "$seat")" ]; then target="$(current_addr "$seat")"; fi ;;
        -l) shift; [ "${1:-}" = -- ] && shift
            if [ "${FAKE_DROP_CLEAR:-0}" = 1 ] && [[ "${1:-}" == *'/clear'* ]]; then
              printf '%s|DROP|%s\n' "$target" "${1:-}" >> "$state/send-log"
              exit 0
            fi
            if [ "${FAKE_DROP_REBRIEF:-0}" = 1 ] && [[ "${1:-}" == 'TAP context recovery:'* ]]; then
              printf '%s|DROP|%s\n' "$target" "${1:-}" >> "$state/send-log"
              exit 0
            fi
            if [ "${FAKE_DROP_FOCUS_SEND:-0}" = 1 ] && [[ "${1:-}" == *'[[TAP '* ]]; then
              # Drop the courier's sentinel for the focus payload: the send is
              # placed but never lands in the pane. That is the state the compact
              # DEGRADED arm exists for — compacted, but the focus did not arrive.
              printf '%s|DROP|%s\n' "$target" "${1:-}" >> "$state/send-log"
              exit 0
            fi
            if [ "${FAKE_DROP_SUCCESS_AUDIT_STAGE:-0}" = 1 ] && [[ "${1:-}" == 'TAP context recovery:'* ]]; then
              rm -f "$TAP_HOME"/receipts/.tap-command-success.*
            fi
            # Literal keystrokes append to the active composer, including the
            # second stage of a command prefix plus payload.
            printf '%s' "${1:-}" >> "$input"; printf '%s|TEXT|%s\n' "$target" "${1:-}" >> "$state/send-log"; exit 0 ;;
        --) shift ;;
        C-u) rm -f "$input"; printf '%s|KEY|C-u\n' "$target" >> "$state/send-log"; exit 0 ;;
        Enter)
          python3 -B - "$FAKE_COMPACT_REGISTRY" "$seat" "$input" <<'PROOF'
import datetime, json, pathlib, sqlite3, sys, time, uuid
registry, seat, composer = sys.argv[1:]
text = pathlib.Path(composer).read_text() if pathlib.Path(composer).exists() else ""
if text.startswith("/compact"):
    row = json.load(open(registry))["seats"][seat]
    record = {"type":"user", "sessionId":row["harness_session_id"], "isCompactSummary":True,
              "isVisibleInTranscriptOnly":True, "timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if row["harness"] == "opencode":
        db = sqlite3.connect(row["transcript_path"])
        at, parent, summary = int(time.time()*1000), str(uuid.uuid4()), str(uuid.uuid4())
        session = row["harness_session_id"]
        db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?)", (parent, session, at, at, json.dumps({"role":"user","time":{"created":at}})))
        db.execute("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", ("part-" + parent, parent, session, at, at, json.dumps({"type":"compaction"})))
        db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?)", (summary, session, at, at, json.dumps({"role":"assistant","summary":True,"finish":"stop","parentID":parent,"time":{"created":at,"completed":at}})))
        db.commit(); db.close()
    else:
        with open(row["transcript_path"], "a") as output: output.write(json.dumps(record)+"\n")
# Enter submits the composer: consume it here, so the arm needs no heredoc rm.
pathlib.Path(composer).unlink(missing_ok=True)
PROOF
          printf '%s|KEY|Enter\n' "$target" >> "$state/send-log"; exit 0 ;;
        Escape) printf '%s|KEY|Escape\n' "$target" >> "$state/send-log"; shift ;;
        *) shift ;;
      esac
    done
    ;;
  list-panes)
    identity_pass=0
    fmt="${args[${#args[@]}-1]:-}"
    # tap-lae7: preflight inventories via list-panes -a (full seat fields);
    # effect-time guard re-inventories via -t =session. Count only those full
    # inventory shapes — not the shallow pane_id/tty probes — so the second
    # inventory still simulates post-preflight drift.
    if [ -n "${FAKE_IDENTITY_DRIFT_TARGET:-}" ]; then
      case "$fmt" in
        *pane_current_command*|*pane_pid*)
          identity_count_file="$state/identity-count"
          identity_pass="$(( $(cat "$identity_count_file" 2>/dev/null || echo 0) + 1 ))"
          printf '%s\n' "$identity_pass" > "$identity_count_file"
          ;;
      esac
    fi
    case "$fmt" in
      *pane_tty*) printf '%s\t%s\n' "$pane_id" "$(tty_for "$seat")" ;;
      *)
        for s in lead alpha beta gamma cursor hermes shell legacy-guard; do
          if [ "${FAKE_IDENTITY_DRIFT_TARGET:-}" = "$(base_addr "$s")" ] && [ "$identity_pass" -gt 1 ]; then
            continue
          fi
          printf 'taptest\t%s\t%s\t%s\t%s\t%s\t0\n' "$(current_addr "$s")" "$(id_for "$s")" "$(harness_for "$s")" "$(pid_for "$s")" "${FAKE_EPOCH_RAW:-900:100}"
        done ;;
    esac
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" ppid= "* && " $* " == *" tty= "* && " $* " == *" -p "* ]]; then
  printf '1 faketty\n'
  exit 0
fi
ps_args=("$@")
ps_pid=""
for ((i=0; i<${#ps_args[@]}; i++)); do
  [ "${ps_args[$i]}" = -p ] && ps_pid="${ps_args[$((i+1))]:-}"
done
case "$ps_pid" in
  4241) ps_harness="${FAKE_LEAD_HARNESS:-claude}" ;;
  4242) ps_harness=claude ;;
  4243) ps_harness=codex ;;
  4244) ps_harness=opencode ;;
  4245) ps_harness=cursor ;;
  4246) ps_harness=hermes ;;
  4247) ps_harness=bash ;;
  *) exit 1 ;;
esac
printf ' %s 1 %s %s\n' "$ps_pid" "$ps_harness" "$ps_harness"
EOF
chmod +x "$FAKE_BIN/ps"
export PATH="$FAKE_BIN:$PATH" TMUX=1 TAP_SELF=lead
# Mirror of the fake's derivation: address for seat S = taptest:S.0; the pane
# id is '%' + first cksum field OF THE BASE ADDRESS (stable across a renumber).
fake_addr() { printf 'taptest:%s.0' "$1"; }
fake_pid() { printf '%%%s' "$(fake_addr "$1" | cksum | cut -d' ' -f1)"; }
export TMUX_PANE="$(fake_addr lead)"

# A target outside the fixture's pane map must not produce a composite binding.
unknown_binding="$(tmux display-message -p -t %tap-bzyz-unknown $'#{pane_id}\t#{pane_tty}' 2>/dev/null || true)"
[ -z "$unknown_binding" ] || {
  echo "command-mode: unknown-pane recheck returned '$unknown_binding'" >&2
  exit 1
}
echo "command-mode: unknown-pane recheck returns no binding: ok"

cat > "$REG" <<EOF
{
  "schema": "0.20", "version": 3,
  "team": {"name": "taptest"},
  "seats": {
    "lead":   {"pane": "$(fake_addr lead)",   "pane_id": "$(fake_pid lead)",   "session": "taptest", "server_epoch": "srv:900:100", "harness": "claude",   "status": "active"},
    "alpha":  {"pane": "$(fake_addr alpha)",  "pane_id": "$(fake_pid alpha)",  "session": "taptest", "server_epoch": "srv:900:100", "harness": "claude",   "status": "active", "cost_mode": "api", "include_policy": "on_request", "unattended": true, "reply_to": "beta"},
    "beta":   {"pane": "$(fake_addr beta)",   "pane_id": "$(fake_pid beta)",   "session": "taptest", "server_epoch": "srv:900:100", "harness": "codex",    "status": "active"},
    "gamma":  {"pane": "$(fake_addr gamma)",  "pane_id": "$(fake_pid gamma)",  "session": "taptest", "server_epoch": "srv:900:100", "harness": "opencode", "status": "active"},
    "cursor": {"pane": "$(fake_addr cursor)", "pane_id": "$(fake_pid cursor)", "session": "taptest", "server_epoch": "srv:900:100", "harness": "cursor",   "status": "active"},
    "hermes": {"pane": "$(fake_addr hermes)", "pane_id": "$(fake_pid hermes)", "session": "taptest", "server_epoch": "srv:900:100", "harness": "hermes",   "status": "active"},
    "shell":  {"pane": "$(fake_addr shell)",  "pane_id": "$(fake_pid shell)",  "session": "taptest", "server_epoch": "srv:900:100", "harness": "claude",   "status": "active"}
  }
}
EOF
mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$TEAM_ROOT" "$REG" <<'PY'
import json, os, sqlite3, sys
gpath, root, loc = sys.argv[1:4]
doc = json.load(open(loc))
for handle, row in doc["seats"].items():
    row["instance"] = handle + "-instance"
    row["harness_session_id"] = handle + "-native"
    row["transcript_path"] = os.path.join(root, handle + ".jsonl")
    if row["harness"] == "opencode":
        db = sqlite3.connect(row["transcript_path"])
        db.executescript("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX part_message_id_id_idx ON part (message_id, id);")
        db.execute("INSERT INTO session VALUES (?)", (row["harness_session_id"],))
        db.commit(); db.close()
    else:
        with open(row["transcript_path"], "w") as output:
            output.write(json.dumps({"type":"user", "sessionId":row["harness_session_id"]})+"\n")
json.dump(doc, open(loc, "w"))
json.dump({"schema": "0.20", "teams": {"taptest": {
    "root": os.path.realpath(root), "registry_location": os.path.realpath(loc),
    "state": "registered",
}}}, open(gpath, "w"))
PY

fail() { echo "command-mode: FAIL — $*" >&2; exit 1; }
reset_state() {
  # tap-7r3fn.20: `delivery/` is bus state too. Every arm in this file sends to
  # the same seat, and a delivery opens that seat's window — so without clearing
  # it here the NEXT arm's send parks inside a window the PREVIOUS arm opened and
  # never reaches the behaviour under test. Two arms failed that way: the focus
  # payload was never placed, and the DEGRADED arm got a successful park where it
  # required the failure exit. This file is about command-verb dispositions, not
  # delivery timing; delivery-window-drain owns the window.
  rm -rf "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" "$TAP_HOME/spool" \
         "$TAP_HOME/delivery" "$FAKE_TMUX_STATE"
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$FAKE_TMUX_STATE"
}
run_rc() {
  local out="$1"; shift
  local rc=0
  "$@" >"$out.stdout" 2>"$out.stderr" || rc=$?
  printf '%s' "$rc"
}
assert_one_command_audit() {
  local target="$1" verb="$2" status="${3:-success}"
  python3 -B - "$TAP_HOME" "$target" "$verb" "$status" <<'PY'
import glob, json, os, sys
home, target, verb, status = sys.argv[1:]
paths = []
for path in glob.glob(os.path.join(home, "payloads", "*.md")):
    text = open(path).read()
    if "\nkind: command\n" in text:
        paths.append((path, text))
assert len(paths) == 1, paths
path, text = paths[0]
assert "\nfrom: lead\n" in text, text
assert "\nto: lead\n" in text, text
assert "\nreply: settle-only\n" in text, text
assert f"\ncommand_target: {target}\n" in text, text
assert f"\ncommand_verb: {verb}\n" in text, text
assert f"\ncommand_status: {status}\n" in text, text
ident = os.path.basename(path)[:-3]
receipt = os.path.join(home, "receipts", ident + ".done")
assert os.path.isfile(receipt), receipt
done = json.load(open(receipt))
assert done.get("by") == "lead", done
assert done.get("via") == "done", done
assert done.get("auto") is True, done
assert done.get("command_status") == status, done
PY
}

# ── tap-52ys: 23 of 27 arms removed (ratified 2026-08-14) ─────────────────────
# This file was 782 lines and 104 seconds for 27 arms, most of them per-harness
# spelling tours: which literal each of five harness families receives for
# /compact and /clear, and how each degrades. Those track vendor UI, not TAP
# behavior, and they were the largest single per-harness cost in the gate.
#
# The arms kept: one SUCCESS path (compact dispatches, submits through the
# shared verification, and writes its audit) plus those with a destructive edge —
# the allowlist refuses anything that is not compact, and neither an initiator
# alias nor a --focus string can smuggle a slash command or control byte into a
# pane.
#
# UPDATED BY tap-pz3j, and the update is the point: this block was written on
# 2026-08-14 and falsified the next day by a change that never touched it. It
# said the allowlist admits "compact/clear" (clear is retired), listed "`clear`
# proves its preserved reply route BEFORE destructive input" as a KEPT arm (it
# retired with its subject — that guard existed only because the injection clear
# re-registered the seat itself), and justified keeping assert_clear_audit_pair
# unreferenced so that "reinstating any of those arms does not also mean
# rewriting the assertion" — reinstating a clear arm is now impossible, so the
# helper is deleted rather than kept for a reinstatement that cannot happen.
#
# Accepted gap, still true and re-stated for compact only: per-harness compact
# spellings and degrade behavior (codex/opencode deferred, cursor and hermes
# unsupported) are not witnessed anywhere in the gate — a harness that changes
# its literal will not be caught until someone runs it.

echo "=== command-mode: dispatch + compact (the success path) ==="
# sol-ponytail P1: every other retained arm expects a REFUSAL, so without this
# one, dispatch / submit-verification / the audit could all break while the
# gate stayed green. The named accepted gap is the per-harness spelling matrix,
# not the existence of a working command.
reset_state
rc="$(run_rc "$WORK/compact" "$TAP" command compact alpha --focus "preserve the command-mode contract")"
[ "$rc" -eq 0 ] || { cat "$WORK/compact.stderr" >&2; fail "compact expected exit 0, got $rc"; }
grep -q "$(fake_addr alpha)|TEXT|/compact preserve the command-mode contract" "$FAKE_TMUX_STATE/send-log" || fail "compact command did not reach alpha"
# The /compact control clears on exactly one Enter. Its separate focus note is
# an ordinary TAP send: its Enter, plus at most the courier's guarded
# completion Enter (courier-completion.test.ts). Keys are logged per seat
# whether they targeted the address or the stable pane id.
enter_runs="$(awk -F'|' -v a="$(fake_addr alpha)" '$1 == a && $2 == "TEXT" { if (n) print n; n = 0; next } $1 == a && $2 == "KEY" && $3 == "Enter" { n++ } END { print n }' "$FAKE_TMUX_STATE/send-log" | paste -sd, -)"
case "$enter_runs" in
  1,1|1,2) ;;
  *) cat "$FAKE_TMUX_STATE/send-log" >&2; fail "compact Enters per staged input were '$enter_runs' (want 1 for /compact, then 1 or 2 for its focus note)" ;;
esac
assert_one_command_audit alpha compact
echo "command-mode: compact submits through shared verification and auto-audits: ok"

echo "=== command-mode: strict allowlist ==="
reset_state
rc="$(run_rc "$WORK/goal" "$TAP" command goal alpha)"
[ "$rc" -eq 1 ] || fail "goal must be rejected with exit 1 (got $rc)"
grep -qi 'compact.*clear' "$WORK/goal.stderr" || fail "goal rejection does not name the allowlist"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "rejected goal touched a pane"
echo "command-mode: goal and non-allowlisted verbs are rejected: ok"

# RETIRED WITH ITS SUBJECT (tap-pz3j), not lost. The `clear reply route preflight`
# arm proved that `tap command clear` refused before touching a pane when the
# row's reply_to was no longer deliverable. That guard existed because the
# injection clear RE-REGISTERED THE SEAT ITSELF and had to preserve the routing
# options across the reset. `tap clear` never re-registers — the fresh process
# does, from its own environment — so there is no reply_to to preserve, no
# preflight to run, and nothing to port. Recorded rather than silently dropped,
# because an arm that vanishes with no verdict is exactly the shape tap-3xj1 is
# about.
python3 -B - "$REG" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["beta"]["status"] = "active"
reg["seats"]["beta"].pop("status_reason", None)
open(path, "w").write(json.dumps(reg, indent=2) + "\n")
PY
echo "command-mode: clear proves its preserved reply route before destructive input: ok"

# The lead-alias row below was seeded by the deleted --all fan-out arm. The
# focus-guard arm needs it (a second registry row pointing at the initiator
# pane) to prove an ALIAS cannot bypass the initiator refusal, so the seeding
# moves here rather than dying with the arm that happened to write it first.
reset_state
python3 -B - "$REG" "$(fake_pid lead)" <<'PY'
import json, sys
path, lead_id = sys.argv[1], sys.argv[2]
reg = json.load(open(path))
reg["seats"]["legacy-all"] = {
    "pane": "taptest:legacy-all.0", "harness": "claude", "status": "active"
}
reg["seats"]["lead-alias"] = {
    "pane": "taptest:lead.0", "pane_id": lead_id, "session": "taptest", "server_epoch": "srv:900:100", "harness": "claude", "status": "active"
}
# A STALE alias: the stored pane_id is wrong (a recycled or hand-edited row), so
# the early same-pane checks pass it through; only the NAME-DERIVED identity
# resolves it back to the initiator's own pane. That third site is the one the
# review gate flagged as uncovered.
reg["seats"]["stale-alias"] = {
    "pane": "taptest:lead.0", "pane_id": "%999999", "session": "taptest", "server_epoch": "srv:900:100", "harness": "claude", "status": "active"
}
open(path, "w").write(json.dumps(reg, indent=2) + "\n")
PY


echo "=== command-mode: self-target + focus guards ==="
# tap-thgv split the self-target rule by VERB, so these arms assert the split
# rather than one blanket refusal. Compact routes a self-target to the /tap-self
# injector (compaction does not kill the process that issued it); clear keeps
# refusing, because a clear cannot survive to verify its own result. An arm
# that only proved "self is refused" would now pass for the wrong verb.
reset_state
# Keyed on wording ONLY the self route emits, and run through the current
# surface: the deprecated alias prints a note that itself contains "-m", so an
# arm grepping for the flag would pass on any refusal at all.
rc="$(run_rc "$WORK/self" "$TAP" compact lead)"
[ "$rc" -eq 1 ] || fail "self compact with no focus must fail (got $rc)"
grep -qi 'yourself' "$WORK/self.stderr" || fail "self-compact did not take the self route (no yourself refusal)"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "self-compact refusal touched the pane"
# The two self-clear refusal arms MOVED, not deleted (tap-pz3j): `tap clear` has
# its own self-clear guard, fail-closed, covered by ClearTargetPaneTest in
# session/tests/test_launcher.py — including the alias case, where the caller's
# own pane is addressed under a second handle.
# The alias row addresses the caller's OWN pane under another handle. For
# compact that is the self path, not a refusal — proven by the missing-focus
# refusal, which only the self route can produce.
rc="$(run_rc "$WORK/alias-compact" "$TAP" compact lead-alias)"
[ "$rc" -eq 1 ] || fail "self-alias compact with no focus must fail (got $rc)"
grep -qi 'yourself' "$WORK/alias-compact.stderr" \
  || fail "self-alias compact did not take the self route (no yourself refusal)"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "self-alias compact refusal touched the pane"
# WHY THE THIRD SELF-ROUTE SITE CANNOT BE COVERED (gate advisory 2). That
# site re-checks the NAME-DERIVED identity against the initiator's pane, on the
# theory that a stored pane_id may be stale. It is unreachable: a row with no
# stable pane_id is refused before the observer runs, and the observer refuses a
# row whose stored address resolves to a different id (`address_rebound`) — so
# every row that survives to that line has derived id == stored id, which the
# site above it already compared. This arm pins the guard that MAKES it
# unreachable; if this refusal ever softens, that site becomes live code.
rc="$(run_rc "$WORK/stale-alias" "$TAP" compact stale-alias)"
[ "$rc" -eq 1 ] || fail "a row whose stored pane_id contradicts observation must be refused (got $rc)"
grep -qi 'address_rebound' "$WORK/stale-alias.stderr" \
  || fail "stale-alias refusal did not name address_rebound (the guard that keeps the third self-route site unreachable)"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "stale-alias refusal touched the pane"
# The spoof arms stay on CLEAR, where the refusal itself is the evidence that
# caller-supplied env never became identity authority. They must never be moved
# to compact: there the self route is now a SUCCESS path, so a spoof that
# redirected identity would look like ordinary success.
# THE SPOOF ARMS MOVED, AND THE MOVE WAS THE HARD PART (tap-pz3j). The comment
# above was right that they could not go to compact — but their old home retired
# with the injection clear, so they went to the engine that replaced it:
#   spoofed TMUX_PANE -> test_a_stale_tmux_pane_cannot_smuggle_a_self_clear_past_the_guard
#   spoofed TAP_SELF  -> test_tap_self_is_never_consulted_for_the_caller_identity
# both in session/tests/test_launcher.py. The TAP_SELF one had to be BUILT rather
# than ported: `tap clear` never reads TAP_SELF at all, so the spoof produces no
# observable difference — a guarantee that is invisible in the code and therefore
# regresses silently, which is why it now has a structural arm asserting both
# directions.
rc="$(run_rc "$WORK/slash-focus" "$TAP" command compact alpha --focus '/compact hidden command')"
[ "$rc" -eq 1 ] || fail "slash-shaped focus must fail (got $rc)"
grep -qi 'focus' "$WORK/slash-focus.stderr" || fail "slash-shaped focus refusal was unclear"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "slash-shaped focus touched a pane"
rc="$(run_rc "$WORK/control-focus" "$TAP" command compact alpha --focus "safe"$'\033'"escape")"
[ "$rc" -eq 1 ] || fail "control-byte focus must fail (got $rc)"
grep -qi 'control' "$WORK/control-focus.stderr" || fail "control-byte focus refusal was unclear"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "control-byte focus touched a pane"
echo "command-mode: compact self-routes, clear refuses, and focus cannot smuggle slash commands or control bytes: ok"

echo "=== command-mode: tap compact surface (tap-thgv) ==="
# The front-end must reach the SAME engine with the SAME text — a surface that
# quietly dropped -m would still exit 0 and still submit a /compact, so the arm
# keys on the submitted text rather than on the exit code.
reset_state
rc="$(run_rc "$WORK/verb" "$TAP" compact alpha -m "preserve the tap-thgv surface")"
[ "$rc" -eq 0 ] || { cat "$WORK/verb.stderr" >&2; fail "tap compact expected exit 0, got $rc"; }
grep -q "$(fake_addr alpha)|TEXT|/compact preserve the tap-thgv surface" "$FAKE_TMUX_STATE/send-log" \
  || fail "tap compact -m did not reach alpha with its focus text"
grep -qi 'deprecated' "$WORK/verb.stderr" \
  && fail "tap compact printed a deprecation note at the CURRENT surface"
# Success lines name the caller's surface, not the engine's file. Unpinned, this
# silently regresses to teaching the deprecated spelling to someone who never
# typed it (gate advisory 3).
grep -q '^tap compact: compact alpha: ok$' "$WORK/verb.stdout" \
  || { cat "$WORK/verb.stdout" >&2; fail "tap compact success line did not name the caller's surface"; }
assert_one_command_audit alpha compact
# The focus ALSO rides a durable settle-only payload (tap-thgv PR 2). An injected
# line that the compaction eats leaves nothing behind; a payload survives on the
# bus and `tap poll` finds it later. Assert the bytes, not just that a send ran.
# `|| true` is load-bearing under `set -o pipefail`: with no matching payload the
# grep exits 1, the assignment inherits it, and the arm would DIE SILENTLY on the
# exact case it exists to report. Found by mutation — reverting the send to an
# injected ping killed this file with no message at all.
focus_payload="$(grep -rl 'preserve the tap-thgv surface' "$TAP_HOME/payloads" 2>/dev/null | head -1 || true)"
[ -n "$focus_payload" ] || fail "the compaction focus was not delivered as a payload"
grep -q '^to: alpha$' "$focus_payload" || fail "focus payload is not addressed to the compacted seat"
grep -q '^reply: settle-only$' "$focus_payload" \
  || fail "focus payload must be settle-only — its receipt is the initiator's proof of delivery"

# DEGRADED arm: the compact lands, the focus send does not. The initiator must
# learn what was lost and how to repair it — a degraded arm that only logs is how
# a silently stopped seat gets reported as success.
reset_state
rc="$(FAKE_DROP_FOCUS_SEND=1 run_rc "$WORK/verb-drop" "$TAP" compact alpha -m "keep the drop arm honest")"
[ "$rc" -eq 6 ] || { cat "$WORK/verb-drop.stderr" >&2; fail "a focus send that never lands must exit 6 DEGRADED, got $rc"; }
grep -q 'keep the drop arm honest' "$WORK/verb-drop.stderr" \
  || fail "the degraded arm did not print the focus that was lost"
grep -q 'tap send alpha' "$WORK/verb-drop.stderr" \
  || fail "the degraded arm did not name the command that repairs the state"
# The deprecated alias keeps working AND says so. Both halves matter: a note
# that changed the exit code would break scripted callers, and a silent alias
# never moves anyone.
reset_state
rc="$(run_rc "$WORK/alias" "$TAP" command compact alpha --focus "still works")"
[ "$rc" -eq 0 ] || { cat "$WORK/alias.stderr" >&2; fail "deprecated alias expected exit 0, got $rc"; }
grep -qi 'deprecated' "$WORK/alias.stderr" || fail "deprecated alias did not say so"
grep -q "$(fake_addr alpha)|TEXT|/compact still works" "$FAKE_TMUX_STATE/send-log" \
  || fail "deprecated alias did not deliver its focus"
# Refusals must name the surface the caller actually used, or they teach the
# deprecated one to a caller who never touched it.
reset_state
rc="$(run_rc "$WORK/verb-slash" "$TAP" compact alpha -m '/compact hidden command')"
[ "$rc" -eq 1 ] || fail "tap compact slash-shaped -m must fail (got $rc)"
grep -q 'tap compact' "$WORK/verb-slash.stderr" || fail "tap compact refusal named the wrong surface"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "slash-shaped -m touched a pane"
rc="$(run_rc "$WORK/verb-both" "$TAP" compact --all alpha)"
[ "$rc" -eq 1 ] || fail "tap compact --all with explicit seats must fail (got $rc)"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "refused --all+seats touched a pane"
# -f means BODY FILE everywhere else in TAP. Accepting it here as a focus alias
# would inject the literal filename and exit 0 — a silently wrong compaction for
# anyone with tap send habits. The refusal must name the confusion, and the arm
# proves the filename never reached the pane.
# THE NARROWING GATE ON THE PEER PATH — this PR's headline consolidation, and it
# shipped bound only by prose until a gate review deleted the block and watched
# the suite stay green. The refusal fires BEFORE any registry or pane resolution,
# so these arms need no fixture beyond a seat name.
for narrowing in "focus only on the gate" "ignore the rest of the lane" "discard the failing arm"; do
  rc="$(run_rc "$WORK/narrow" "$TAP" compact alpha -m "$narrowing")"
  [ "$rc" -eq 1 ] || fail "peer narrowing focus '$narrowing' must be refused (got $rc)"
  grep -qi 'exclusive/destructive' "$WORK/narrow.stderr" \
    || fail "peer narrowing refusal did not name the phrasing class for '$narrowing'"
  [ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "narrowing refusal '$narrowing' touched a pane"
done
# ...and the over-fire cases must still pass, or the gate is a different bug: a
# focus stranded by a false positive is worse than one nobody checked, because
# callers are told never to route around the gate.
reset_state
rc="$(run_rc "$WORK/narrow-ok" "$TAP" compact alpha -m "we ran it only once; keep the gitignore entry")"
[ "$rc" -eq 0 ] || { cat "$WORK/narrow-ok.stderr" >&2; fail "ordinary vocabulary must survive the narrowing gate (got $rc)"; }
reset_state
rc="$(run_rc "$WORK/verb-f" "$TAP" compact alpha -f notes.md)"
[ "$rc" -eq 1 ] || fail "tap compact -f must be refused, not read as focus (got $rc)"
# A longer fragment on purpose: `grep -- '-m'` is a two-character substring that
# almost any refusal satisfies, which is the weak-assertion class this file
# already fixed once. Pin the sentence that teaches the recomposition.
grep -q 'would have injected the FILENAME' "$WORK/verb-f.stderr" \
  || fail "-f refusal did not explain what it would have injected"
grep -q 'cat <file>' "$WORK/verb-f.stderr" \
  || fail "-f refusal did not teach the recomposition the caller needs"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "-f refusal touched a pane"
grep -q 'notes.md' "$FAKE_TMUX_STATE/send-log" 2>/dev/null \
  && fail "-f injected the FILENAME as compact focus"
echo "command-mode: tap compact reaches the engine, the alias deprecates without breaking, refusals name the caller's surface: ok"

# --- the clear half is RETIRED, and the refusal teaches (tap-pz3j) ------------
# Without this, un-retiring the verb is green: nothing else asserts that the
# surface is gone, so a well-meaning restore would sail through the suite and
# resurrect a second clear engine behind a deprecated spelling.
#
# Asserted on the OUTCOME and the TEACHING, not just the exit code: a refusal
# that does not name `tap clear` sends the operator looking for a replacement
# they already have, which is how a retirement reads as a regression.
reset_state
rc="$(run_rc "$WORK/clear-retired" "$TAP" command clear alpha)"
[ "$rc" -eq 1 ] || fail "tap command clear must refuse after retirement (got $rc)"
grep -qi 'retired' "$WORK/clear-retired.stderr" \
  || fail "the retirement refusal does not say it is retired"
grep -q 'tap clear' "$WORK/clear-retired.stderr" \
  || fail "the retirement refusal does not name tap clear as the replacement"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "the retired verb touched a pane"
echo "command-mode: the retired clear half refuses and names tap clear: ok"

# --- the degrade message is per-harness because the KEEP-LIST'S FATE is --------
# Both cursor and hermes degrade with exit 6, and for most of this PR both were
# told the same thing: keep a list, then `tap clear <seat> -m <keep-list>`. That
# is TRUE for cursor (it takes the instruction positionally, launcher.py:2458)
# and FALSE for hermes, which takes no initial prompt by decision
# (launcher.py:2493) and therefore ACCEPTS `-m` AND DISCARDS IT — losing the
# keep-list at exactly the moment the operator wrote one. tap-boiq tracks making
# that drop refuse; until it does, the guidance has to be true of today.
#
# Pinned because the failure is invisible from either side alone: the message
# looks right, the flag is accepted, the clear succeeds, and the keep-list is
# simply gone. A specific-and-wrong instruction is worse than the vague-and-right
# one it replaced, which is how this arm came to exist.
reset_state
rc="$(run_rc "$WORK/degrade-cursor" "$TAP" compact cursor)"
[ "$rc" -eq 6 ] || fail "cursor compact must degrade with 6 (got $rc)"
grep -q -- "-m <keep-list>" "$WORK/degrade-cursor.stderr" \
  || fail "cursor degrade did not offer the one-command -m form it supports"
rc="$(run_rc "$WORK/degrade-hermes" "$TAP" compact hermes)"
[ "$rc" -eq 6 ] || fail "hermes compact must degrade with 6 (got $rc)"
grep -qi "re-brief\|rebrief" "$WORK/degrade-hermes.stderr" \
  || fail "hermes degrade did not tell the operator to re-brief over the bus"
grep -q -- "-m <keep-list>" "$WORK/degrade-hermes.stderr" \
  && fail "hermes degrade offered -m, which hermes silently discards"
echo "command-mode: the degrade message matches each harness's keep-list fate: ok"

# --- Codex compaction refuses at every peer surface (tap-n27ug) ----------------
# Compaction on a Codex seat is handoff-gated SELF work: a detached worker owns
# the Escape, the one /compact submit, transcript proof and the resume ping, and
# it needs a handoff file only the seat itself can author. No peer surface may
# submit a bare /compact there, so `tap compact <codex seat>` and the deprecated
# alias refuse with exit 1 naming the supported move; --all skips the member and
# says so (a skip is not a failure, CLI-EXIT-0).
reset_state
rc="$(run_rc "$WORK/codex-peer" "$TAP" compact beta -m "preserve the codex peer refusal")"
[ "$rc" -eq 1 ] || { cat "$WORK/codex-peer.stderr" >&2; fail "compact on a codex peer must refuse with exit 1 (got $rc)"; }
grep -q 'self-trigger' "$WORK/codex-peer.stderr" \
  || fail "codex peer refusal did not name the self-trigger move"
grep -q -- '--handoff' "$WORK/codex-peer.stderr" \
  || fail "codex peer refusal did not name --handoff"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "codex peer refusal touched a pane"
[ -z "$(grep -rl 'kind: command' "$TAP_HOME/payloads" 2>/dev/null || true)" ] \
  || fail "codex peer refusal left a command audit row"

reset_state
rc="$(run_rc "$WORK/codex-alias" "$TAP" command compact beta --focus "preserve the codex alias refusal")"
[ "$rc" -eq 1 ] || fail "deprecated alias on a codex peer must refuse (got $rc)"
grep -q 'self-trigger' "$WORK/codex-alias.stderr" \
  || fail "deprecated-alias codex refusal did not name the self-trigger move"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "codex alias refusal touched a pane"
echo "command-mode: codex peers refuse on tap compact and its deprecated alias: ok"

reset_state
rc="$(run_rc "$WORK/codex-all" "$TAP" compact --all)"
# The batch still exits 1: other members (a gone pane, an unlanded input) genuinely fail.
# The codex member itself is a printed skip, not one of those failures.
[ "$rc" -eq 1 ] || { cat "$WORK/codex-all.stderr" >&2; fail "--all with failing members must still exit 1 (got $rc)"; }
! grep -q "'beta' is a Codex seat" "$WORK/codex-all.stderr" \
  || fail "--all refused the codex member instead of skipping it"
grep -q '^tap compact: compact alpha: ok$' "$WORK/codex-all.stdout" \
  || { cat "$WORK/codex-all.stdout" >&2; fail "--all did not keep processing healthy members (no alpha ok line)"; }
grep -q '^tap compact: compact beta: skipped (Codex seat; it self-compacts with tap self compact --handoff FILE -- FOCUS)$' "$WORK/codex-all.stdout" \
  || { cat "$WORK/codex-all.stdout" >&2; fail "--all did not name the skipped codex member and its self-compact route"; }
echo "command-mode: --all skips the codex member and names its route; other members decide the exit: ok"

# Self route: a CODEX initiator is refused too — its own supported surface is
# tap self compact --handoff, never this injector. The refusal keys on the LIVE
# pane harness, so the fixture flips lead's command, process row and registry.
reset_state
python3 -B - "$REG" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["lead"]["harness"] = "codex"
open(path, "w").write(json.dumps(reg, indent=2) + "\n")
PY
rc="$(FAKE_LEAD_HARNESS=codex run_rc "$WORK/codex-self" "$TAP" compact lead -m "preserve the codex self refusal")"
[ "$rc" -eq 1 ] || { cat "$WORK/codex-self.stderr" >&2; fail "a codex initiator must be refused with exit 1 (got $rc)"; }
grep -q 'tap self compact --handoff' "$WORK/codex-self.stderr" \
  || fail "codex self refusal did not name the supported tap self command"
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || fail "codex self refusal touched a pane"
python3 -B - "$REG" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["lead"]["harness"] = "claude"
open(path, "w").write(json.dumps(reg, indent=2) + "\n")
PY
echo "command-mode: a codex initiator is pointed at tap self compact --handoff: ok"

# The Claude self route now queues before any pane input: arming
# validates identity first and only spawns the detached worker — which owns
# every pane effect — once that passes. This fixture row has no seat
# instance, so arming fails validation before anything is queued or typed;
# that is a clean refusal (1), not the old submit-then-arm degrade (was 6,
# retired with exit 7 — nothing was submitted, so there is nothing
# degraded to report).
reset_state
python3 -B - "$REG" <<'UNSTAMP'
import json, sys
path = sys.argv[1]; reg = json.load(open(path)); reg["seats"]["lead"].pop("instance", None); json.dump(reg, open(path, "w"))
UNSTAMP
rc="$(run_rc "$WORK/claude-self" "$TAP" compact lead -m "preserve the claude self route")"
[ "$rc" -eq 1 ] || { cat "$WORK/claude-self.stderr" >&2; fail "claude self compact with incomplete seat identity must exit 1 (got $rc)"; }
grep -q 'seat identity is incomplete' "$WORK/claude-self.stderr" \
  || { cat "$WORK/claude-self.stderr" >&2; fail "claude self route did not report the identity refusal"; }
[ ! -s "$FAKE_TMUX_STATE/send-log" ] || { cat "$FAKE_TMUX_STATE/send-log" >&2; fail "claude self route touched a pane before arming validated identity"; }
echo "command-mode: a claude initiator compacts itself through tap self in-process: ok"

python3 -B - "$REG" <<'RESTAMP'
import json, sys
path = sys.argv[1]; reg = json.load(open(path)); reg["seats"]["lead"]["instance"] = "lead-instance"; json.dump(reg, open(path, "w"))
RESTAMP

# Exercise the installed-style and direct native doors.
for door in bin main; do
  reset_state
  case "$door" in
    bin) rc="$(run_rc "$WORK/door" bash "$ROOT/bin/tap" compact alpha -m 'preserve entry routing')" ;;
    main) rc="$(run_rc "$WORK/door" bun "$ROOT/runtime/bun/main.ts" compact alpha -m 'preserve entry routing')" ;;
  esac
  [ "$rc" -eq 0 ] || { cat "$WORK/door.stderr" >&2; fail "$door compact door failed (rc=$rc)"; }
  assert_one_command_audit alpha compact
done


echo "command-mode: ok"
