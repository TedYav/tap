#!/usr/bin/env bash
# D5: fixture-door — :211 bootIdsMatch exec is a fixture-precondition gate (repair door must not begin at boot_id_stale); assertions are on tap session repair output
# session-recovery.test.sh — restart/resume-all/repair public session verbs.
#
# Contract restated 2026-09-17 (tap-jqgt9): since the born-live change the
# acting store is the post-flip team registry <root>/.tap/team-registry.json under
# the "seats" axis, bootstrapped by `tap init` and enrolled in the machine's
# global registry. The pre-born-live fixture seeded <root>/.tap/bus/registry.json
# under "agents"; on a born-live machine that store is retired — resume repairs
# re-attest the seat in the post-flip store, so every assertion moved there.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index" PATH="$FAKE_BIN:$PATH"
TEAM_ROOT="$WORK/repo"
FAKE_STATE="$WORK/tmux-sessions"
FAKE_EVENTS="$WORK/tmux-events"
export TEAM_ROOT FAKE_STATE FAKE_EVENTS
mkdir -p "$TEAM_ROOT/.tap/bus" "$FAKE_BIN"
git -C "$TEAM_ROOT" init -q
git -C "$TEAM_ROOT" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m fixture
# Born-live bootstrap: creates the post-flip team registry, the machine's global
# registry enrollment, and the bus authority marker.
( cd "$TEAM_ROOT" && env -u TAP_HOME "$TAP" init >/dev/null )

# tap-gc1n: exact --resume requires an on-disk transcript for the chosen id.
# Seed the native (and live) seat ids so dead-session recreate still proves
# verified exact-resume rather than falling through to the id-less picker.
export TAP_CLAUDE_HOME="$WORK/claude-home"
mkdir -p "$TAP_CLAUDE_HOME/projects/repo"
printf '{}\n' > "$TAP_CLAUDE_HOME/projects/repo/11111111-1111-4111-8111-111111111111.jsonl"
printf '{}\n' > "$TAP_CLAUDE_HOME/projects/repo/22222222-2222-4222-8222-222222222222.jsonl"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
# ensureTmuxServer() (launcher/tmux-bootstrap.ts) probes the SERVER, not a pane:
#   tmux -N -S <socket> display-message -p '#{pid}'
# The global options come first, so dispatching on "$1" landed on -N and fell
# through to the outer refusal with empty stderr. ensureTmuxServer reads that as
# "unobservable" rather than "absent" and throws, killing the create path before
# any arm could assert. Strip the global-option prefix, then answer only the
# untargeted #{pid} query with this fixture's own server identity -- the PID
# component of FAKE_EPOCH_RAW, which the pane formats below already report.
# ensureTmuxServer only checks that the identity is numeric: a successful probe
# means "a server is already here", so nothing is started and no signal is sent.
while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    -N) shift ;;
    -S|-L|-f) shift 2 ;;
    *) break ;;
  esac
done
if [ "${1:-}" = display-message ] && [ "${2:-}" = -p ] && [ "${3:-}" = '#{pid}' ] && [ "$#" -eq 3 ]; then
  _server_identity="${FAKE_EPOCH_RAW:-900:100}"
  printf '%s\n' "${_server_identity%%:*}"
  exit 0
fi
# The native pane observer first reads the server identity untargeted; answer it
# with the same generation the pane formats below report.
if [ "${1:-}" = display-message ] && [ "${2:-}" = -p ] && [ "${3:-}" = '#{pid}:#{start_time}' ] && [ "$#" -eq 3 ]; then
  printf '%s\n' "${FAKE_EPOCH_RAW:-900:100}"
  exit 0
fi
if [ "${1:-}" = display-message ] && [ "${2:-}" = -p ] && [ "${3:-}" = '#{socket_path}' ] && [ "$#" -eq 3 ]; then
  printf '/fake/socket\n'
  exit 0
fi
# The fixture's fixed session -> pane identity. The launcher's creation vessel
# (launcher/transaction.ts VESSEL_FORMAT) is six TAB fields: server generation,
# $session_id, @window_id, %pane_id, pane_pid, socket_path. Every id derives from
# the pane number, so the record a new-session prints is the same one a later
# display-message -t <pane> reports -- the launcher compares the two.
vessel_session_pane() { # <session> -> pane id, or non-zero
  case "$1" in
    repo/live) echo %40 ;; repo/orphan) echo %41 ;; repo/scout) echo %42 ;;
    repo/planner) echo %43 ;; repo/native) echo %44 ;; repo/picker) echo %45 ;;
    repo/unseated) echo %46 ;; repo/repairable) echo %47 ;; repo/ghost) echo %48 ;;
    *) return 1 ;;
  esac
}
vessel_pane_session() { # <pane id> -> session
  local s
  for s in repo/live repo/orphan repo/scout repo/planner repo/native repo/picker repo/unseated repo/repairable repo/ghost; do
    [ "$(vessel_session_pane "$s")" = "$1" ] && { echo "$s"; return 0; }
  done
  return 1
}
vessel_record() { # <pane id>
  local n="${1#%}"
  printf '%s\t$%s\t@%s\t%s\t4242\t/fake/socket\n' "${FAKE_EPOCH_RAW:-900:100}" "$n" "$n" "$1"
}
case "${1:-}" in
  list-sessions)
    # The roster snapshot asks for name, server generation and attached count;
    # the bare-name callers ask for '#S'.
    if [[ "$*" == *'#{pid}:#{start_time}'* ]]; then
      while IFS= read -r _name; do printf '%s\t%s\t0\n' "$_name" "${FAKE_EPOCH_RAW:-900:100}"; done <"$FAKE_STATE"
    else
      cat "$FAKE_STATE" 2>/dev/null || true
    fi ;;
  has-session)
    target="${3#=}"
    grep -Fxq "$target" "$FAKE_STATE" 2>/dev/null ;;
  display-message)
    target=""; format=""
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2#=}"; shift 2 ;;
        *) format="$1"; shift ;;
      esac
    done
    target="${target%:0.0}"
    case "$target" in
      repo/live|%40) session=repo/live; pane_id=%40; command=claude ;;
      repo/orphan|%41) session=repo/orphan; pane_id=%41; command=codex ;;
      repo/scout|%42) session=repo/scout; pane_id=%42; command=claude ;;
      repo/planner|%43) session=repo/planner; pane_id=%43; command=claude ;;
      repo/native|%44) session=repo/native; pane_id=%44; command=claude ;;
      repo/picker|%45) session=repo/picker; pane_id=%45; command=claude ;;
      repo/unseated|%46) session=repo/unseated; pane_id=%46; command=claude ;;
      repo/repairable|%47) session=repo/repairable; pane_id=%47; command=claude ;;
      repo/ghost|%48) session=repo/ghost; pane_id=%48; command=claude ;;
      *) echo "can't find pane: $target" >&2; exit 1 ;;
    esac
    case "$format" in
      '#{pane_id}') printf '%s\n' "$pane_id" ;;
      '#{pane_current_command}') printf '%s\n' "$command" ;;
      '#{pane_current_path}') printf '%s\n' "$TEAM_ROOT" ;;
      '#{socket_path}') printf '/fake/socket\n' ;;
      $'#{pane_id}\t#{session_name}') printf '%s\t%s\n' "$pane_id" "$session" ;;
      # The native pane observer's five-field identity record (id, session, pid, command, dead).
      $'#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}')
        printf '%s\t%s\t4242\t%s\t0\n' "$pane_id" "$session" "$command" ;;
      $'#{pid}:#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{socket_path}') vessel_record "$pane_id" ;;
      # tap-ua9l: the WRITER capture asks for the id, the session and the
      # generation in one record; real tmux answers all three at once.
      $'#{pane_id}\t#{session_name}\t#{pid}:#{start_time}')
        printf '%s\t%s\t%s\n' "$pane_id" "$session" "${FAKE_EPOCH_RAW:-900:100}" ;;
      # tap-ua9l: the pane-facts record is seven fields — address, pane_id,
      # command, server_epoch, pane_dead, pane_pid, path.
      *) printf '%s:0.0\t%s\t%s\t%s\t0\t4242\t%s\n' "$session" "$pane_id" "$command" "${FAKE_EPOCH_RAW:-900:100}" "$TEAM_ROOT" ;;
    esac ;;
  list-panes)
    target=""; format=""; all=0; _args=("$@")
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -a) all=1; shift ;;
        -s) shift ;;
        -t) target="${2#=}"; shift 2 ;;
        -F) format="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    # -a with no target: the whole-server pane snapshot is the per-session answer
    # for every live session, one line per pane.
    if [ "$all" = 1 ] && [ -z "$target" ]; then
      while IFS= read -r _name; do "$0" list-panes -t "=$_name" -F "$format" 2>/dev/null || true; done <"$FAKE_STATE"
      exit 0
    fi
    target="${target%:0.0}"
    case "$target" in
      repo/live|%40) session=repo/live; pane_id=%40; command=claude ;;
      repo/orphan|%41) session=repo/orphan; pane_id=%41; command=codex ;;
      repo/scout|%42) session=repo/scout; pane_id=%42; command=claude ;;
      repo/planner|%43) session=repo/planner; pane_id=%43; command=claude ;;
      repo/native|%44) session=repo/native; pane_id=%44; command=claude ;;
      repo/picker|%45) session=repo/picker; pane_id=%45; command=claude ;;
      repo/unseated|%46) session=repo/unseated; pane_id=%46; command=claude ;;
      repo/repairable|%47) session=repo/repairable; pane_id=%47; command=claude ;;
      repo/ghost|%48) session=repo/ghost; pane_id=%48; command=claude ;;
      *) exit 1 ;;
    esac
    grep -Fxq "$session" "$FAKE_STATE" 2>/dev/null || exit 1
    out="$format"
    out="${out//'#{session_name}:#{window_index}.#{pane_index}'/${session}:0.0}"
    out="${out//'#{pane_current_command}'/$command}"
    out="${out//'#{pane_dead}'/0}"
    out="${out//'#{pane_current_path}'/$TEAM_ROOT}"
    out="${out//'#{pid}:#{start_time}'/${FAKE_EPOCH_RAW:-900:100}}"
    out="${out//'#{pane_dead}'/0}"
    out="${out//'#{pane_pid}'/4242}"
    out="${out//'#{pane_id}'/$pane_id}"
    out="${out//'#{session_name}'/$session}"
    printf '%s\n' "$out"
    ;;
  attach-session|switch-client)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'attach %s\n' "$target" >> "$FAKE_EVENTS" ;;
  kill-session)
    target="${3#=}"
    printf 'kill %s\n' "$target" >> "$FAKE_EVENTS"
    grep -Fxv "$target" "$FAKE_STATE" > "$FAKE_STATE.tmp" 2>/dev/null || true
    mv "$FAKE_STATE.tmp" "$FAKE_STATE" ;;
  new-session)
    invocation="$*"; print_vessel=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -s) name="$2"; shift 2 ;;
        -P) print_vessel=1; shift ;;
        *) shift ;;
      esac
    done
    printf 'new %s %s\n' "$name" "$invocation" >> "$FAKE_EVENTS"
    grep -Fxq "$name" "$FAKE_STATE" 2>/dev/null || printf '%s\n' "$name" >> "$FAKE_STATE"
    if [ "$print_vessel" = 1 ]; then vessel_record "$(vessel_session_pane "$name")"; fi ;;
  show-options)
    # The creation transaction reads the pane's prior remain-on-exit before
    # arming it; an unset option prints nothing.
    : ;;
  if-shell)
    # ownedEffect: `if-shell -F -t <pane> <predicate> <then> <else>` is the
    # launcher's authorization-and-effect in one tmux command. Evaluate the
    # predicate's #{==:a,b} terms against this pane's own vessel identity, then
    # run <then> through this fixture (or print the moved sentinel from <else>).
    pane=""; _rest=()
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -F) shift ;;
        -t) pane="${2#=}"; shift 2 ;;
        *) _rest+=("$1"); shift ;;
      esac
    done
    predicate="${_rest[0]}"; then_cmd="${_rest[1]}"
    session="$(vessel_pane_session "$pane")" || { echo "can't find pane: $pane" >&2; exit 1; }
    n="${pane#%}"
    predicate="${predicate//'#{pid}:#{start_time}'/${FAKE_EPOCH_RAW:-900:100}}"
    predicate="${predicate//'#{session_id}'/\$$n}"
    predicate="${predicate//'#{window_id}'/@$n}"
    predicate="${predicate//'#{pane_id}'/$pane}"
    matched=1; _term='#\{==:([^,}]*),([^}]*)\}'
    while [[ "$predicate" =~ $_term ]]; do
      [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] || matched=0
      predicate="${predicate/"${BASH_REMATCH[0]}"/}"
    done
    if [ "$matched" = 1 ]; then eval "\"\$0\" $then_cmd"; else echo TAP_LAUNCH_IDENTITY_MOVED; fi ;;
  set-option|set-hook|run-shell)
    # Transactional launches arm a pane-died hook around a placeholder pane.
    # This fixture only needs to record the lifecycle, not execute the timer.
    : ;;
  respawn-pane)
    invocation="$*"; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        *) shift ;;
      esac
    done
    name="${target%:0.0}"
    name="$(vessel_pane_session "$name" 2>/dev/null || printf '%s' "$name")"
    printf 'new %s %s\n' "$name" "$invocation" >> "$FAKE_EVENTS" ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$TEAM_ROOT/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "repo", "worktree_root": "$TEAM_ROOT" },
  "seats": {
    "live": { "status": "active", "delivery": "pane", "session": "repo/live", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "live", "index": 1, "harness_session_id": "11111111-1111-4111-8111-111111111111", "pane": "repo/live:9.9", "pane_id": "%40", "server_epoch": "srv:900:100" },
    "orphan": { "status": "active", "delivery": "pane", "session": "repo/orphan", "harness": "codex", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "orphan", "index": 1, "pane": "repo/orphan:9.9", "pane_id": "%41", "server_epoch": "srv:900:100" },
    "scout": { "status": "pending", "delivery": "pane", "session": "repo/scout", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "scout", "index": 1 },
    "native": { "status": "pending", "delivery": "pane", "session": "repo/native", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "native", "index": 1, "harness_session_id": "22222222-2222-4222-8222-222222222222" },
    "ghost": { "status": "pending", "delivery": "pane", "session": "repo/ghost", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "ghost", "index": 1, "harness_session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    "picker": { "status": "pending", "delivery": "pane", "session": "repo/picker", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "picker", "index": 1 },
    "repairable": { "status": "active", "status_reason": "", "delivery": "pane", "session": "repo/repairable", "harness": "claude", "registered_from_worktree": "$TEAM_ROOT", "base": "repo", "tag": "repairable", "index": 1, "pane": "repo/repairable:0.0", "pane_id": "%47", "pane_current_command": "claude", "server_epoch": "srv:900:100", "boot_id": "boot:1785910737" },
    "old": { "status": "active", "pane": "missing:0.0", "harness": "codex" }
  }
}
JSON
printf 'repo/live\nrepo/orphan\nrepo/planner\nrepo/unseated\nrepo/repairable\n' > "$FAKE_STATE"

# The recovery door named by a boot_id_stale refusal must open that exact
# state: re-attest the verified pane and stamp both current provenance axes.
row_boot="$(python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["seats"]["repairable"]["boot_id"])
PY
)"
if TAP_BOOT_ID=bootuuid:current bun -e 'const { bootIdsMatch } = await import(process.argv[1]);
process.exit(bootIdsMatch(process.argv[2], process.argv[3]) === "match" ? 0 : 1);' \
    "$ROOT/runtime/bun/src/tmux.ts" "$row_boot" bootuuid:current; then
  echo "session-recovery: repair-door fixture did not begin at boot_id_stale" >&2
  exit 1
fi
set +e
repair_boot_out="$(cd "$TEAM_ROOT" && TAP_BOOT_ID=bootuuid:current TAP_SERVER_EPOCH=srv:900:100 \
  "$TAP" session repair repairable 2>&1)"
repair_boot_rc=$?
set -e
[ "$repair_boot_rc" -eq 0 ] || {
  echo "session-recovery: named repair door failed rc=$repair_boot_rc" >&2
  echo "$repair_boot_out" >&2
  exit 1
}
[[ "$repair_boot_out" == *'repaired repairable'* ]] || {
  echo "session-recovery: named repair door did not report repair" >&2
  echo "$repair_boot_out" >&2
  exit 1
}
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))["seats"]["repairable"]
assert row["boot_id"] == "bootuuid:current", row
assert row["server_epoch"] == "srv:900:100", row
PY
echo "session-recovery: (0) boot_id_stale refusal's named repair door opens: ok"

# ya2e-for-resume: the smoke runs TTY-less (piped stdout), so every
# resume path now REPAIRS/RECREATES the seat and leaves it running DETACHED with a
# receipt — it never runs a doomed attach, and (the actual defect) an attach-only miss
# never rolls back / orphans the seat. Under a real TTY these still reattach (the
# human path is byte-identical); the fake tmux would log `attach` on that path.
: > "$FAKE_EVENTS"
set +e
live_out="$(cd "$TEAM_ROOT" && "$TAP" session resume repo/live 2>&1)"
live_rc=$?
set -e
[ "$live_rc" -eq 0 ] || {
  echo "session-recovery: TTY-less live resume failed rc=$live_rc" >&2
  echo "$live_out" >&2
  exit 1
}
! grep -q '^attach repo/live$' "$FAKE_EVENTS" || { echo "session-recovery: TTY-less resume must not attach (ya2e)" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$live_out" == *'repo/live is running detached'* ]] || { echo "session-recovery: TTY-less live resume should repair + report running detached" >&2; echo "$live_out" >&2; exit 1; }
! grep -q '^new repo/live ' "$FAKE_EVENTS" || { echo "session-recovery: live registry session must not native-resume" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
_seats = json.load(open(sys.argv[1]))["seats"]
live = _seats["live"]
assert live["pane"] == "repo/live:0.0", (live, {k: v.get("pane") for k, v in _seats.items()})
assert live["pane_id"] == "%40", live
PY
echo "session-recovery: (1) TTY-less named resume repairs live seat + detaches (ya2e): ok"

: > "$FAKE_EVENTS"
orphan_out="$(cd "$TEAM_ROOT" && "$TAP" session resume orphan 2>&1)"
! grep -q '^attach repo/orphan$' "$FAKE_EVENTS" || { echo "session-recovery: TTY-less resume must not attach (ya2e)" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$orphan_out" == *'repo/orphan is running detached'* ]] || { echo "session-recovery: TTY-less record-less resume should repair + report running detached" >&2; echo "$orphan_out" >&2; exit 1; }
! grep -q '^new repo/orphan ' "$FAKE_EVENTS" || { echo "session-recovery: record-less live session must not be recreated" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
orphan = json.load(open(sys.argv[1]))["seats"]["orphan"]
assert orphan["pane"] == "repo/orphan:0.0", orphan
assert orphan["pane_id"] == "%41", orphan
PY
echo "session-recovery: (2) TTY-less record-less registry resume repairs + detaches: ok"

: > "$FAKE_EVENTS"
# Resume-adoption is retired: an off-roster live session is not a resume key and
# must never mint a registry row from tmux liveness.
set +e
unseated_out="$(cd "$TEAM_ROOT" && "$TAP" session resume unseated 2>&1)"
unseated_rc=$?
set -e
[ "$unseated_rc" -ne 0 ] || { echo "session-recovery: (3) unseated resume must refuse (got rc=0)" >&2; echo "$unseated_out" >&2; exit 1; }
[[ "$unseated_out" == *'resume key not found: unseated'* ]] \
  || { echo "session-recovery: (3) refusal message shape wrong" >&2; echo "$unseated_out" >&2; exit 1; }
! grep -q '^attach repo/unseated$' "$FAKE_EVENTS" || { echo "session-recovery: (3) refused resume must not attach" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
! grep -q '"unseated"' "$TEAM_ROOT/.tap/team-registry.json" \
  || { echo "session-recovery: (3) refusal must not mint a registry row" >&2; cat "$TEAM_ROOT/.tap/team-registry.json" >&2; exit 1; }
# Named door runnable (dry-run; bare `launch --help` aliases to `new` needing harness).
set +e
launch_door="$(cd "$TEAM_ROOT" && "$TAP" session launch claude unseated-door --dry-run 2>&1)"
launch_rc=$?
set -e
[ "$launch_rc" -eq 0 ] || { echo "session-recovery: (3) tap session launch door not runnable: $launch_door" >&2; exit 1; }
echo "session-recovery: (3) unseated live session refuses resume-adoption (membership gate): ok"

: > "$FAKE_EVENTS"
# This assignment is unguarded under `set -euo pipefail`: a non-zero resume
# killed the file with the command's status and none of its output, which is why
# the bootstrap refusal above surfaced only as a bare `exit 2`. Keep the status,
# print what the command said, and fail with the arm's own context.
set +e
native_out="$(cd "$TEAM_ROOT" && "$TAP" session resume native 2>&1)"; native_rc=$?
set -e
[ "$native_rc" -eq 0 ] || {
  echo "session-recovery: (4) 'tap session resume native' exited $native_rc; its output:" >&2
  printf '%s\n' "$native_out" >&2
  exit "$native_rc"
}
grep -q '^new repo/native .*22222222-2222-4222-8222-222222222222' "$FAKE_EVENTS" || { echo "session-recovery: dead session should recreate with native id" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
! grep -q '^attach repo/native$' "$FAKE_EVENTS" || { echo "session-recovery: TTY-less resume must not attach (ya2e)" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$native_out" == *'repo/native is running detached'* ]] || { echo "session-recovery: TTY-less recreated resume should report running detached" >&2; echo "$native_out" >&2; exit 1; }
echo "session-recovery: (4) dead session recreates with native resume target + detaches: ok"

# tap-gc1n negative arm: acting hsid set, but no on-disk transcript → id-less
# --resume (never exact-target the ghost uuid). Distinct from (5), which has no hsid.
: > "$FAKE_EVENTS"
ghost_out="$(cd "$TEAM_ROOT" && "$TAP" session resume ghost 2>&1)"
ghost_line="$(grep '^new repo/ghost ' "$FAKE_EVENTS" || true)"
[[ -n "$ghost_line" ]] || { echo "session-recovery: ghost hsid should recreate same tmux name" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$ghost_line" == *'--resume'* ]] || { echo "session-recovery: ghost hsid recreate must keep --resume" >&2; echo "$ghost_line" >&2; exit 1; }
! grep -q 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' <<<"$ghost_line" \
  || { echo "session-recovery: ghost hsid must not appear in argv (id-less picker)" >&2; echo "$ghost_line" >&2; exit 1; }
[[ "$ghost_line" == *'--resume' ]] || { echo "session-recovery: ghost fallback argv should end at bare --resume" >&2; echo "$ghost_line" >&2; exit 1; }
! grep -q '^attach repo/ghost$' "$FAKE_EVENTS" || { echo "session-recovery: TTY-less resume must not attach (ya2e)" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$ghost_out" == *'repo/ghost is running detached'* ]] || { echo "session-recovery: TTY-less ghost resume should report running detached" >&2; echo "$ghost_out" >&2; exit 1; }
echo "session-recovery: (4b) ghost hsid with no transcript falls to id-less --resume: ok"

: > "$FAKE_EVENTS"
picker_out="$(cd "$TEAM_ROOT" && "$TAP" session resume picker 2>&1)"
[[ "$picker_out" == *'WARNING'* && "$picker_out" == *'native picker'* ]] || { echo "session-recovery: picker fallback should warn" >&2; echo "$picker_out" >&2; exit 1; }
grep -q '^new repo/picker ' "$FAKE_EVENTS" || { echo "session-recovery: picker fallback should recreate same tmux name" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
! grep -q '^attach repo/picker$' "$FAKE_EVENTS" || { echo "session-recovery: TTY-less resume must not attach (ya2e)" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
[[ "$picker_out" == *'repo/picker is running detached'* ]] || { echo "session-recovery: TTY-less picker resume should report running detached" >&2; echo "$picker_out" >&2; exit 1; }
echo "session-recovery: (5) missing native id warns and falls back to picker + detaches: ok"

resume_out="$(cd "$TEAM_ROOT" && "$TAP" session resume --all)"
[[ "$resume_out" == *'resumed repo/scout'* ]] || { echo "session-recovery: resume --all should resume stopped scout" >&2; echo "$resume_out" >&2; exit 1; }
[[ "$resume_out" == *'[1/1] resumed repo/scout'* && "$resume_out" == *'resumed 1 session'* ]] \
  || { echo "session-recovery: resume --all should show durable progress and a final total" >&2; echo "$resume_out" >&2; exit 1; }
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
scout = payload["seats"]["scout"]
assert scout["status"] == "active", scout
assert scout["pane"] == "repo/scout:0.0", scout
assert scout["pane_id"] == "%42", scout
assert "old" in payload["seats"], payload["seats"]
PY
# (6b) resume --all --dry-run --json: JSON per record on stdout, no prose contamination
# Stop scout first so resume --all has a non-empty set of stopped sessions
sed -i.bak '/repo\/scout/d' "$FAKE_STATE" 2>/dev/null || true
rm -f "$FAKE_STATE.bak"
resume_all_json="$(cd "$TEAM_ROOT" && "$TAP" session resume --all --dry-run --json 2>/dev/null)" || true
python3 -c '
import json, sys
raw = sys.stdin.read().strip()
assert raw, "expected JSON output, got empty"
for line in raw.split("\n"):
    if not line.strip():
        continue
    d = json.loads(line)  # each line must be valid JSON
    assert "name" in d, f"missing name: {d}"
    assert "harness" in d, f"missing harness: {d}"
    assert "cwd" in d, f"missing cwd: {d}"
    assert "argv" in d, f"missing argv: {d}"
' <<<"$resume_all_json" \
  || { echo "session-recovery: (6b) resume --all --dry-run --json should emit only JSON invocation objects on stdout" >&2; echo "$resume_all_json" >&2; exit 1; }
! grep -q 'would resume' <<<"$resume_all_json" \
  || { echo "session-recovery: (6b) resume --all --dry-run --json must not emit prose on stdout" >&2; echo "$resume_all_json" >&2; exit 1; }
echo "session-recovery: (6b) resume --all --dry-run --json emits JSON objects without prose: ok"

# (6c) bare resume --all --dry-run: durable progress and final total, no JSON
resume_all_human="$(cd "$TEAM_ROOT" && "$TAP" session resume --all --dry-run 2>/dev/null)" || true
line_count=$(printf '%s\n' "$resume_all_human" | wc -l | tr -d ' ')
[ "$line_count" = "3" ] \
  || { echo "session-recovery: (6c) bare resume --all --dry-run should emit launch receipt, durable progress, and total, got $line_count: $resume_all_human" >&2; exit 1; }
[[ "$resume_all_human" == *'[1/1] would resume repo/scout'* && "$resume_all_human" == *'would resume 1 session'* ]] \
  || { echo "session-recovery: (6c) bare resume --all --dry-run should show durable progress and total: $resume_all_human" >&2; exit 1; }
! grep -q '"ok"' <<<"$resume_all_human" \
  || { echo "session-recovery: (6c) bare resume --all --dry-run must not emit JSON" >&2; echo "$resume_all_human" >&2; exit 1; }
echo "session-recovery: (6c) bare resume --all --dry-run emits durable progress and total: ok"
grep -Fxq "repo/scout" "$FAKE_STATE" 2>/dev/null || printf "repo/scout\n" >> "$FAKE_STATE"


echo "session-recovery: (6) resume --all repairs pending seat without trimming others: ok"


set +e
ambiguous_err="$(cd "$TEAM_ROOT" && "$TAP" session restart claude 2>&1)"
ambiguous_rc=$?
set -e
[ "$ambiguous_rc" -ne 0 ] || { echo "session-recovery: restart claude should fail as ambiguous" >&2; exit 1; }
ambiguous_json="$(cd "$TEAM_ROOT" && TAP_JSON=1 "$TAP" session restart claude 2>/dev/null)" || true
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["error_class"]=="session_ambiguous", d' <<<"$ambiguous_json" \
  || { echo "session-recovery: ambiguous restart should be structured" >&2; echo "$ambiguous_json" >&2; exit 1; }
[[ "$ambiguous_err" == *'repo/scout'* ]] || { echo "session-recovery: ambiguous restart should name matches" >&2; echo "$ambiguous_err" >&2; exit 1; }
[[ "$ambiguous_err" == *'repo/native'* ]] || { echo "session-recovery: ambiguous restart should name every current match" >&2; echo "$ambiguous_err" >&2; exit 1; }
[[ "$ambiguous_err" != *'repo/planner'* ]] || { echo "session-recovery: off-roster tmux session leaked into registry restart choices" >&2; echo "$ambiguous_err" >&2; exit 1; }
echo "session-recovery: (7) restart refuses harness-family key: ok"

restart_out="$(cd "$TEAM_ROOT" && "$TAP" session restart scout --force)"
[[ "$restart_out" == *'restarted repo/scout'* ]] || { echo "session-recovery: restart scout should report restart" >&2; echo "$restart_out" >&2; exit 1; }
grep -q '^kill repo/scout$' "$FAKE_EVENTS" || { echo "session-recovery: restart should kill old scout session" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
grep -q '^new repo/scout ' "$FAKE_EVENTS" || { echo "session-recovery: restart should recreate scout session" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
python3 -B - "$FAKE_EVENTS" <<'PY' \
  || { echo "session-recovery: restart did not recreate through a login shell" >&2; cat "$FAKE_EVENTS" >&2; exit 1; }
import pathlib, re, sys
events = pathlib.Path(sys.argv[1]).read_text().splitlines()
launches = [line for line in events if line.startswith("new repo/scout ")]
assert launches, events
assert re.search(r"\S+ -lic 'exec \"\$0\" \"\$@\"'", launches[-1]), launches[-1]
PY
grep -Fxq 'repo/scout' "$FAKE_STATE" || { echo "session-recovery: restarted scout should be live" >&2; cat "$FAKE_STATE" >&2; exit 1; }
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
scout = json.load(open(sys.argv[1]))["seats"]["scout"]
assert scout["status"] == "active", scout
assert scout["delivery"] == "pane", scout
assert scout["pane_id"] == "%42", scout
PY
echo "session-recovery: (8) restart exact key kills, recreates, and repairs: ok"

# (8b) restart --dry-run --json: single JSON invocation object on stdout, no prose
restart_json="$(cd "$TEAM_ROOT" && "$TAP" session restart scout --force --dry-run --json 2>/dev/null)" || true
python3 -c '
import json, sys
raw = sys.stdin.read().strip()
assert raw, "expected JSON output, got empty"
d = json.loads(raw)
assert "name" in d, f"missing name: {d}"
assert "harness" in d, f"missing harness: {d}"
assert "cwd" in d, f"missing cwd: {d}"
assert "argv" in d, f"missing argv: {d}"
' <<<"$restart_json" \
  || { echo "session-recovery: (8b) restart --dry-run --json should emit single JSON invocation object" >&2; echo "$restart_json" >&2; exit 1; }
! grep -q 'would restart' <<<"$restart_json" \
  || { echo "session-recovery: (8b) restart --dry-run --json must not emit prose on stdout" >&2; echo "$restart_json" >&2; exit 1; }
! grep -q 'inbox' <<<"$restart_json" \
  || { echo "session-recovery: (8b) restart --dry-run --json must not emit inbox digest on stdout" >&2; echo "$restart_json" >&2; exit 1; }
echo "session-recovery: (8b) restart --dry-run --json emits single JSON without prose: ok"

# (8c) bare restart --dry-run: human prose, no JSON
restart_human="$(cd "$TEAM_ROOT" && "$TAP" session restart scout --force --dry-run 2>/dev/null)" || true
! grep -q '"name"' <<<"$restart_human" \
  || { echo "session-recovery: (8c) bare restart --dry-run must not emit JSON" >&2; echo "$restart_human" >&2; exit 1; }
echo "session-recovery: (8c) bare restart --dry-run emits human prose: ok"

python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
path = sys.argv[1]
payload = json.load(open(path))
payload["seats"].pop("scout")
open(path, "w").write(json.dumps(payload) + "\n")
PY
set +e
repair_out="$(cd "$TEAM_ROOT" && "$TAP" session repair scout 2>&1)"
repair_rc=$?
set -e
[ "$repair_rc" -eq 2 ] || { echo "session-recovery: explicit repair should fail when it cannot reconcile" >&2; echo "$repair_out" >&2; exit 1; }
[[ "$repair_out" == *'repair key not found: scout'* ]] || { echo "session-recovery: repair should not create membership" >&2; echo "$repair_out" >&2; exit 1; }
python3 - "$TEAM_ROOT/.tap/team-registry.json" <<'PY'
import json, sys
assert "scout" not in json.load(open(sys.argv[1]))["seats"]
PY
echo "session-recovery: (9) repair reports unregistered without creating membership: ok"

echo "session-recovery: ok"
