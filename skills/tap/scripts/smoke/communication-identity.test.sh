#!/usr/bin/env bash
# communication-identity.test.sh — fail-closed (team, handle, pane_id) binding.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

export TAP_TUI_SETTLE_SCALE=0.1 TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
FAKE_BIN="$WORK/bin"
STATE="$WORK/tmux"
mkdir -p "$FAKE_BIN" "$STATE"
trap 'rm -rf "$WORK"' EXIT

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
cmd="${1:-}"; shift || true
target=""; fmt=""
key() { printf '%s' "${1//[^A-Za-z0-9_.-]/_}"; }
# Native observers address panes by id (%NNN); the Bash courier by address.
# Resolve either to the row's address first.
live_addr() { awk -F '\t' -v p="$1" '$1 == p || $2 == p { print $1; exit }' "$state/live.tsv" 2>/dev/null || true; }
live_id() {
  local wanted
  wanted="$(live_addr "$1")"
  awk -F '\t' -v p="$wanted" '$1 == p { print $2; exit }' "$state/live.tsv" 2>/dev/null || true
}
live_session() { awk -F '\t' -v p="$1" '$1 == p { print $3; exit }' "$state/live.tsv" 2>/dev/null || true; }
live_command() { awk -F '\t' -v p="$1" '$1 == p { print $4; exit }' "$state/live.tsv" 2>/dev/null || true; }
live_pid() { awk -F '\t' -v p="$1" '$1 == p { print $5; exit }' "$state/live.tsv" 2>/dev/null || true; }
mutate_registry_once() {
  [ ! -e "$state/mutated" ] || return 0
  : > "$state/mutated"
  python3 -B - "${FAKE_MUTATE_REGISTRY:?}" "${FAKE_MUTATE_HANDLE:?}" "${FAKE_MUTATE_PANE_ID:?}" <<'PY'
import json, sys
path, handle, pane_id = sys.argv[1:4]
data = json.load(open(path))
data["seats"][handle]["pane_id"] = pane_id
json.dump(data, open(path, "w"), indent=2, sort_keys=True)
PY
}
case "$cmd" in
  list-sessions)
    awk -F '\t' '!seen[$3]++ && $3 != "" { print $3 }' "$state/live.tsv" | while IFS= read -r session; do
      if [[ "$*" == *'start_time'* ]]; then printf '%s\t900:100\n' "$session"
      else printf '%s\n' "$session"
      fi
    done ;;
  list-panes)
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; -F) fmt="$2"; shift 2 ;; *) shift ;; esac
    done
    awk -F '\t' -v s="$target" -v override="${FAKE_LIST_PANES_COMMAND:-}" '
      $3 == s { cmd = override != "" ? override : $4; printf "%s\t%s\t%s\t%s\t%s\t900:100\t0\n", $3, $1, $2, cmd, $5 }
    ' "$state/live.tsv" ;;
  display-message)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    if [ -z "$target" ]; then target="${FAKE_CALLER_PANE:-caller-pane}"; fi
    _addr="$(live_addr "$target")"; target="${_addr:-$target}"
    case "$fmt" in
      # Native server identity (tmux.ts serverIdentity) and its one-record pane
      # observation (observePaneResult), reached by the live-marker courier.
      '#{pid}:#{start_time}') echo "900:100" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        [ -n "$(live_id "$target")" ] || exit 0
        printf '%s\t%s\t%s\t%s\t0\n' "$(live_id "$target")" "$(live_session "$target")" "$(live_pid "$target")" "$(live_command "$target")" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t900:100\n' "$(live_id "$target")" "$(live_session "$target")" ;;
      *pane_id*session_name*start_time*) printf '%s\t%s\t900:100\n' "$(live_id "$target")" "$(live_session "$target")" ;;
      *pane_id*)
        if [ -n "${FAKE_MUTATE_REGISTRY_ON:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON" ] \
           && [ ! -e "$state/mutated" ]; then
          mutate_registry_once
        fi
        live_id "$target" ;;
      *pane_pid*) live_pid "$target" ;;
      *pane_in_mode*)
        if [ -n "${FAKE_MUTATE_REGISTRY_ON_MODE:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON_MODE" ]; then
          mutate_registry_once
        fi
        [ -f "$state/copy-mode.$(key "$target")" ] && echo 1 || echo 0 ;;
      *pane_current_command*)
        if [ -n "${FAKE_MUTATE_REGISTRY_ON_COMMAND:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON_COMMAND" ]; then
          count_file="$state/command-count"
          count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
          printf '%s' "$count" > "$count_file"
          [ "$count" -eq "${FAKE_MUTATE_REGISTRY_COMMAND_N:-1}" ] && mutate_registry_once
        fi
        live_command "$target" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    _addr="$(live_addr "$target")"; target="${_addr:-$target}"
    if [ -n "${FAKE_MUTATE_REGISTRY_ON_CAPTURE:-}" ] && [ "$target" = "$FAKE_MUTATE_REGISTRY_ON_CAPTURE" ]; then
      count_file="$state/capture-count"
      count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
      printf '%s' "$count" > "$count_file"
      [ "$count" -eq "${FAKE_MUTATE_REGISTRY_CAPTURE_N:-1}" ] && mutate_registry_once
    fi
    input="$state/input.$(key "$target")"
    if [ -f "$input" ]; then printf '› %s\n' "$(cat "$input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="$(live_addr "${2:-}")"; target="${target:-${2:-}}"; shift 2; fi
    input="$state/input.$(key "$target")"
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = cancel ]; then
      printf 'cancel\t%s\n' "$target" >> "$state/events.log"
      rm -f "$state/copy-mode.$(key "$target")"
      exit 0
    fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$input"
      printf 'paste\t%s\t%s\n' "$target" "${1:-}" >> "$state/events.log"
      exit 0
    fi
    case "${1:-}" in
      Enter)
        printf 'enter\t%s\n' "$target" >> "$state/events.log"
        rm -f "$input" ;;
      Escape) : ;;
    esac ;;
  select-pane) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$STATE"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:1"

A="$WORK/A"
B="$WORK/B"
git init -q "$A"
git -C "$A" config user.email tap@example.invalid
git -C "$A" config user.name "TAP Smoke"
touch "$A/README.md"
git -C "$A" add README.md
git -C "$A" commit -q -m init
git -C "$A" worktree add -q "$B" -b team-b

ABUS="$A/.tap/bus"
BBUS="$B/.tap/bus"
mkdir -p "$ABUS/payloads" "$ABUS/receipts" "$BBUS/payloads" "$BBUS/receipts"
cat > "$ABUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "A", "worktree_root": "$A"},
  "seats": {
    "sender": {"session": "A/sender", "pane": "sender-pane", "pane_id": "%101", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "fable": {"session": "A/fable", "pane": "a-fable-pane", "pane_id": "%102", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "principal": {"session": "A/principal", "pane": "a-principal-pane", "pane_id": "%103", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"}
  }
}
JSON
cat > "$BBUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "B", "worktree_root": "$B"},
  "seats": {
    "fable": {"session": "B/fable", "pane": "b-fable-pane", "pane_id": "%104", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"},
    "principal": {"session": "B/principal", "pane": "b-principal-pane", "pane_id": "%105", "harness": "codex", "server_epoch": "srv:900:100", "boot_id": "boot:1", "status": "active"}
  }
}
JSON
cat > "$STATE/live.tsv" <<'EOF'
sender-pane	%101	A/sender	codex	101
a-fable-pane	%102	A/fable	codex	102
a-principal-pane	%103	A/principal	codex	103
b-fable-pane	%104	B/fable	codex	104
b-principal-pane	%105	B/principal	codex	105
caller-pane	%106	A/caller	codex	106
recycled-pane	%107	B/recycled	codex	107
foreign-pane	%999	B/foreign	codex	199
EOF
export TAP_HOME="$ABUS" TAP_INDEX_HOME="$WORK/index"
# Born live: both teams are enrolled (an absent marker opens no legacy door).
tap_smoke_enroll_current "$A" "$ABUS" A
tap_smoke_enroll_current "$B" "$BBUS" B
# This file pins the retained Bash send adapter's identity dispositions against a
# fake tmux that emulates only that courier. Enrolled, tap.sh would bridge into
# the native router; the internal guard keeps the Bash tree from bridging back.
export TAP_INTERNAL_OVERDUE_CHECKED=1

reset_bus() {
  rm -f "$ABUS/payloads"/*.md "$ABUS/receipts"/*.done "$ABUS/spool"/* \
        "$STATE"/events.log "$STATE"/mutated "$STATE"/command-count "$STATE"/capture-count "$STATE"/input.* "$STATE"/copy-mode.* 2>/dev/null || true
  mkdir -p "$ABUS/payloads" "$ABUS/receipts" "$ABUS/spool"
}

assert_only_entered() {
  local pane="$1"
  [ "$(awk -F '\t' '$1 == "enter" { seen[$2] = 1 } END { for (p in seen) print p }' "$STATE/events.log" 2>/dev/null)" = "$pane" ] || {
    echo "communication-identity: expected only $pane to receive Enter" >&2
    cat "$STATE/events.log" >&2 || true
    exit 1
  }
}

# ── tap-52ys: this file is the GATE tier of the identity family ─────────────
# Four cases, and only these four exist here — the other 19 live in
# skills/tap/scripts/regress/communication-identity-full.test.sh and run with
# the regress suite. An earlier revision kept all 23 functions here and cut
# only the for-loop; a reviewer's review called that correctly:
# "do not let a for-loop be the only thing keeping a 23-arm tour out of the
# gate." A bucket is a directory, not an env var.
#
# Kept: (1) a team-qualified send binds the named team, (3) a registry-vs-live
# pane_id mismatch fails closed — the stored-vs-live witness a reviewer
# identified by name — (4) duplicate worktree basenames refuse as ambiguous
# rather than guessing, and (5) a regenerated registry without the caller's
# pane rejects an implicit sender.
#
# Not paid for twice: point-of-effect drift is effect-guard-observes-fresh,
# and caller-side binding is caller-pane-tty-binding. Both stay in the gate.

case_remote_same_handle() {
  reset_bus
  "$TAP" send B/fable --ask -m remote --from sender --id ci-remote >/dev/null
  assert_only_entered b-fable-pane
  grep -q '^to_team: B$' "$ABUS/payloads/ci-remote.md"
  echo "communication-identity: (1) qualified same-handle send binds team B: ok"
}

case_registry_pane_mismatch() {
  reset_bus
  # E2 mutation: the stored id is alive, but only in a foreign named session;
  # the recipient's exact session still maps its address to a different pane.
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane_id"] = "%999"; json.dump(d, open(p, "w"), indent=2)
PY
  set +e
  out="$("$TAP" send B/fable -m mismatch --from sender --id ci-mismatch --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: mismatched registry pane_id injected" >&2; exit 1; }
  [[ "$out" == *identity_mismatch* || "$out" == *pane_recycled* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-mismatch.md" ]
  [ ! -s "$STATE/events.log" ]
  python3 -B - "$BBUS/registry.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["seats"]["fable"]["pane_id"] = "%104"; json.dump(d, open(p, "w"), indent=2)
PY
  echo "communication-identity: (3) registry/live pane_id mismatch fails closed: ok"
}

case_ambiguous_team() {
  reset_bus
  mkdir -p "$WORK/left" "$WORK/right"
  git -C "$A" worktree add -q "$WORK/left/Twin" -b twin-left
  git -C "$A" worktree add -q "$WORK/right/Twin" -b twin-right
  set +e
  out="$("$TAP" send Twin/fable -m ambiguous --from sender --id ci-ambiguous --json 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "communication-identity: duplicate team basename resolved arbitrarily" >&2; exit 1; }
  # The machine index is the only team authority: unenrolled twins are not
  # addressable, so the send refuses rather than scanning worktrees and guessing.
  [[ "$out" == *unknown_team* ]] || { echo "$out" >&2; exit 1; }
  [ ! -f "$ABUS/payloads/ci-ambiguous.md" ]
  [ ! -s "$STATE/events.log" ]
  echo "communication-identity: (4) unenrolled duplicate worktree basenames refuse, never guess: ok"
}

case_unregistered_sender() {
  reset_bus
  set +e
  out="$(TMUX=1 FAKE_CALLER_PANE=caller-pane TAP_SELF= "$TAP" send fable -m senderless --id ci-unregistered 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ]
  [[ "$out" == *"tap register"* && "$out" == *"pass --from"* ]]
  [ ! -f "$ABUS/payloads/ci-unregistered.md" ]
  [ ! -s "$STATE/events.log" ]
  echo "communication-identity: (5) regenerated registry without caller pane rejects implicit sender: ok"
}

run_case() {
  case "$1" in
    1) case_remote_same_handle ;;
    3) case_registry_pane_mismatch ;;
    4) case_ambiguous_team ;;
    5) case_unregistered_sender ;;
    *) echo "communication-identity: unknown case '$1'" >&2; exit 2 ;;
  esac
}

if [ -n "${COMM_ID_CASE:-}" ]; then
  run_case "$COMM_ID_CASE"
else
  for c in 1 3 4 5; do run_case "$c"; done
  echo "communication-identity: ok"
fi
