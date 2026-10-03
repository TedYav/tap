#!/usr/bin/env bash
# team-only-driven.test.sh — drive `tap team down` and read its REAL stdout
# (tap-sttl / tap-nymj).
#
# Why this exists, stated plainly because it is the whole point of the file:
# team-only-select.test.sh asserts helper contracts and refusals, and its receipt
# arm reconstructs the line inside the test. That leaves the CALL SITE — the
# third author of every receipt string, after the two helpers — unobserved, and
# the gap admitted two real defects in one PR:
#
#   1. a receipt separator ("by --except : codex") that only regress/ caught, and
#   2. The partner reviewer's P1, where attach keyed the selection set on a handle it
#      derived from the session name instead of the authoritative one.
#
# Both were escapes of the same shape: every helper correct, the composition or
# the key wrong, and nothing in the gating suite ever ran the command. So this
# fixture asserts what the operator would actually see and which seats actually
# died. A test that rebuilds the string under test can only prove the pieces
# compose the way the test thinks they do.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "team-only-driven: $*" >&2; exit 1; }

# A parent shell exporting this would make the mock's resolve_session fail closed.
unset TMUX_LIVE_SESSIONS
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"; KILL_LOG="$(mktemp)"; DETACH_LOG="$(mktemp)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"; rm -f "$KILL_LOG" "$DETACH_LOG"' EXIT
export TAP_HOME KILL_LOG DETACH_LOG PATH="$FAKE_BIN:$PATH"
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
LOCK_PROBE_LOG="$(mktemp)"; export LOCK_PROBE_LOG
INTERPOSE_ROW_JSON=""; export INTERPOSE_ROW_JSON
INTERPOSE_DETACH_LATE_JSON=""; export INTERPOSE_DETACH_LATE_JSON
INTERPOSE_DETACH_LATE_SESSION=""; export INTERPOSE_DETACH_LATE_SESSION
INTERPOSE_CORRUPT=""; export INTERPOSE_CORRUPT
INTERPOSE_CLEAR_FAIL=""; export INTERPOSE_CLEAR_FAIL
INTERPOSE_CORRUPT_AT_CLEAR=""; export INTERPOSE_CORRUPT_AT_CLEAR
EVENTLOG_SNAP=""; export EVENTLOG_SNAP
EVENTLOG_SNAP_SESSION=""; export EVENTLOG_SNAP_SESSION
SURVIVE_KILL=""; export SURVIVE_KILL
INTERPOSE_CRASH_TX=""; export INTERPOSE_CRASH_TX
# Allocation failure, injected rather than described. Both buffers the stop path
# allocates are supposed to REFUSE when they cannot be created, and the only
# honest way to test a refusal-on-failure is to make the thing fail. Matching on
# the template substring keeps the shim inert for every other mktemp in the run,
# including the harness's own.
INTERPOSE_MKTEMP_FAIL=""; export INTERPOSE_MKTEMP_FAIL
INTERPOSE_MKTEMP_UNWRITABLE_AFTER=""; export INTERPOSE_MKTEMP_UNWRITABLE_AFTER
INTERPOSE_JOURNAL_CORRUPT=""; export INTERPOSE_JOURNAL_CORRUPT
INTERPOSE_CORRUPT_AT_KILL=""; export INTERPOSE_CORRUPT_AT_KILL
INTERPOSE_UNWRITABLE_AT_KILL=""; export INTERPOSE_UNWRITABLE_AT_KILL
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# INTERPOSER for the final transaction (partner review #2). When the caller is
# about to run cotenant_kill, this inserts an unnamed co-tenant UNDER
# registry.lock and only then execs the real python3. That is the one place the
# row can land after the clear and before the transaction reads the registry —
# 8c cannot reach it, because its row arrives before authorize_only and is
# retained by the pre-clear keep set. This tests ROLLBACK WIRING, not the lock.
REAL_PYTHON3="$(command -v python3)"
export REAL_PYTHON3
cat > "$FAKE_BIN/python3" <<'PY3'
#!/usr/bin/env bash
# CRASH INJECTION at the top-level transaction (panel review):
# simulates an uncaught exception inside the 720-line _tap_team_stop_tx_
# suspend_kill python block, for ONE named session, by exiting nonzero WITHOUT
# execing real python3 at all — nothing is mutated, so this is purely about
# whether the BASH-side caller survives an unexpected nonzero exit with no
# "refused:" line, not about which half-mutation resulted. Argv shape is
# `-B - <registry> <want> <seat_blob>`; $4 is the session name the call is
# authorizing. Also keyed on TX_MODE=full (the teammate suspend loop's mode)
# so this cannot collide with an unrelated python3 -B - call elsewhere whose
# 4th argument happens to match the session string.
if [ "$1" = "-B" ] && [ "$2" = "-" ] && [ "${TAP_TEAM_STOP_TX_MODE:-}" = full ] \
   && [ -n "${INTERPOSE_CRASH_TX:-}" ] && [ "$4" = "${INTERPOSE_CRASH_TX}" ]; then
  echo "Traceback (most recent call last): simulated interpreter crash" >&2
  exit 1
fi
# Two INDEPENDENT effects at the cotenant_kill boundary: insert a co-tenant
# (drives the refusal path) and/or corrupt the registry (makes the survivor's
# restore fail). Round 2 of arm 15 needs the second WITHOUT the first, so that a
# survivor reaches the kill-failed outcome rather than a refusal.
if [ "${TAP_TEAM_STOP_TX_MODE:-}" = cotenant_kill ] && [ "${INTERPOSE_CORRUPT:-}" = file ]; then
  # Corrupt the registry: the TRANSACTION itself then refuses (it cannot read
  # what it must classify), which drives the refusal survivor path.
  printf '%s' '{ corrupted by the fixture' > "$TAP_HOME/registry.json"
fi
# JOURNAL CORRUPTION at the same boundary, and deliberately NOT registry
# corruption: this drives _tap_team_stop_rollback_self_snap to its rc=3
# fail-loud-and-retain path while everything else about the run stays healthy.
# The run id is supplied by the arm, so the journal's name is derivable here.
if [ "${TAP_TEAM_STOP_TX_MODE:-}" = cotenant_kill ] && [ -n "${INTERPOSE_JOURNAL_CORRUPT:-}" ]; then
  printf '%s' '{ journal corrupted by the fixture' \
    > "$TAP_HOME/registry.json.self-last-journal.${TAP_TEAM_STOP_RUN_ID:-$$}.json"
fi
if [ "${TAP_TEAM_STOP_TX_MODE:-}" = cotenant_kill ] && [ "${INTERPOSE_CORRUPT:-}" = dir ]; then
  # Make the bus dir unwritable INSTEAD. The transaction still reads fine (under
  # clear the registry is legitimately absent by now), so the kill is authorized
  # and can fail on its own; the later RESTORE is what cannot write. That is the
  # only way to reach kill-failed + failed-restore together.
  chmod 500 "$TAP_HOME" 2>/dev/null || true
fi
# CLEAR-HELPER FAILURE, with allocation already SUCCEEDED. Identified by argv
# shape: _tap_team_stop_clear_registry is the only caller passing EIGHT
# arguments (`-B - <registry> <keep> <home> <self_handles> <recovery_out>
# <late_out>`) — $7 is the recovery artifact and $8 the late-row output, which
# `late_out` added. The restore helper passes four, so `$7` is empty there and
# cannot match.
#
# The lever is the recovery DIRECTORY, not the artifact. capture_recovery writes
# through `mkstemp(dir=...)` + `os.replace`, and os.replace overwrites a
# read-only target happily — chmod'ing the artifact itself induces nothing. An
# unwritable directory makes mkstemp raise, which is what fails capture.
#
# It must fail BEFORE capture writes anything: an artifact that already holds
# rows is not an empty stub, so the stub-reap branch would be a no-op and
# "removed the stub cleanup" would stay green. The mode is restored immediately
# after, because the reaper needs a writable directory to unlink the stub.
# Corrupt the registry the locked clear is ABOUT to read — same argv-shape hook,
# different effect. Planning has already succeeded by this point, which is the
# window the finding is about: valid at plan time, unparseable at the clear.
# Keyed on the REGISTRY argument, not on the recovery artifact: a --keep-self run
# allocates no artifact (the caller is spared, so there is no caller row to
# capture), and keying on $7 meant this hook silently never fired for exactly the
# no-selector/keep-self case it needs to cover.
#
# NARROW on purpose: eight args, the last two being the recovery and late-row
# paths under $TAP_HOME. Matching "any call whose $3 ends in registry.json" would
# also catch future registry-writing helpers while the flag is set, and this hook
# CORRUPTS — a stray match would look like a product bug (partner review residual).
if [ "$#" -eq 8 ] && [ "$1" = "-B" ] && [ "$2" = "-" ] \
   && [ -n "${INTERPOSE_CORRUPT_AT_CLEAR:-}" ] && [ -n "$8" ]; then
  # $8 is the late-row out-file, which the caller mktemps for EVERY clear. $7 is
  # not usable as the discriminator: a --keep-self run allocates no recovery
  # artifact, so keying on it excludes the very case (8k) this hook exists for —
  # a mistake made once already and re-made while narrowing.
  case "$3" in
    */registry.json)
      printf '%s' '{ corrupted just before the locked clear' > "$3" ;;
  esac
fi
if [ "$#" -ge 7 ] && [ "$1" = "-B" ] && [ "$2" = "-" ] \
   && [ -n "${INTERPOSE_CLEAR_FAIL:-}" ]; then
  case "$7" in
    */recovery/self-row-*)
      _cf_dir="$(dirname "$7")"
      chmod 500 "$_cf_dir" 2>/dev/null || true
      "$REAL_PYTHON3" "$@"; _cf_rc=$?
      chmod 700 "$_cf_dir" 2>/dev/null || true
      exit "$_cf_rc" ;;
  esac
fi
if [ "${TAP_TEAM_STOP_TX_MODE:-}" = cotenant_kill ] && [ -n "${INTERPOSE_ROW_JSON:-}" ] \
   && [ -f "$INTERPOSE_ROW_JSON" ]; then
  "$REAL_PYTHON3" -B - "$TAP_HOME/registry.json" "$INTERPOSE_ROW_JSON" <<'INS'
import fcntl, json, os, sys
reg_path, row_path = sys.argv[1], sys.argv[2]
with open(reg_path + ".lock", "a+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        reg = json.load(open(reg_path))
    except Exception:
        reg = {"schema": "0.20", "team": {"name": "demo"}, "seats": {}}
    key = "seats" if isinstance(reg.get("seats"), dict) else "agents"
    reg.setdefault(key, {}).update(json.load(open(row_path)))
    json.dump(reg, open(reg_path, "w"), indent=2, sort_keys=True)
INS
  rm -f "$INTERPOSE_ROW_JSON"
fi
exec "$REAL_PYTHON3" "$@"
PY3
chmod +x "$FAKE_BIN/python3"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

# Minimal tmux mock: three seats, each its own session and pane. kill-session
# records the session name so the arms can assert WHICH seats died, not merely
# that the command exited 0.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
pane_id_for() {
  case "$1" in
    "demo/kimi:0.0")   printf '%%101' ;;
    "demo/grok:0.0")   printf '%%102' ;;
    "demo/sonnet:0.0") printf '%%103' ;;
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
tty_for() {
  case "$1" in "%101") printf '/dev/faketty' ;; *) printf '' ;; esac
}
session_for() {
  case "${1#=}" in
    %101|demo/kimi*)   printf 'demo/kimi' ;;
    %102|demo/grok*)   printf 'demo/grok' ;;
    %103|demo/sonnet*) printf 'demo/sonnet' ;;
    # %196 as a CO-TENANT pane id, not a session-stamped row's own address
    # (P1-a, panel review): tap_pane_observe now positively
    # resolves an unstamped spared row's pane_id, and arm (8f) is the one
    # fixture that omits "session" on a %196 row to exercise exactly that.
    # Every OTHER %196 usage in this file already carries an explicit
    # "session": "demo/grok" and never reaches this default case, so this
    # entry is scoped to (8f) alone and does not touch any other arm.
    %196) printf 'demo/grok' ;;
    *) printf '%s' "${1#=}" ;;
  esac
}
# LATE-REGISTRATION BARRIER, fired from kill-session. That is genuinely AFTER
# planning (the plan is built before any kill) and BEFORE both the next session's
# locked transaction and the final registry clear — the two windows the partner reviewer's
# P1s live in. An earlier attempt fired from display-message and landed during
# planning instead, which would have been green about a window it never entered.
maybe_register_late() {
  [ -n "${LATE_ROW_JSON:-}" ] || return 0
  [ -f "$LATE_ROW_JSON" ] || return 0
  # LOCK-AWARE, and that fidelity is the point (partner review). A real registrar
  # takes registry.lock before writing. A barrier that ignores the sidecar can
  # inject while production legitimately HOLDS the lock, which would make a
  # CORRECT lock-across-kill implementation look broken. Non-blocking: if the
  # lock is held the registrar is shut out and STAYS ARMED to retry, which is
  # exactly what a real one does.
  local _late_rc=0
  python3 -B - "$TAP_HOME/registry.json" "$LATE_ROW_JSON" <<'LATE' || _late_rc=$?
import fcntl, json, sys
reg_path, row_path = sys.argv[1], sys.argv[2]
try:
    lock = open(reg_path + ".lock", "a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    raise SystemExit(3)          # held: shut out, as intended
try:
    reg = json.load(open(reg_path))
except Exception:
    raise SystemExit(4)          # registry gone: nothing to join yet
key = "seats" if isinstance(reg.get("seats"), dict) else "agents"
reg.setdefault(key, {}).update(json.load(open(row_path)))
json.dump(reg, open(reg_path, "w"), indent=2, sort_keys=True)
fcntl.flock(lock, fcntl.LOCK_UN)
LATE
  # 0 = injected (disarm). 3 = lock held. 4 = no registry. Both stay armed, and
  # neither is allowed to abort the mock.
  if [ "$_late_rc" = 0 ]; then
    rm -f "$LATE_ROW_JSON"
  fi
  return 0
}
# The registrar becomes eligible once the first kill has happened — that is
# "after planning" — and then RETRIES on every subsequent tmux call until it gets
# in, exactly as a real one would. It cannot get in while production holds
# registry.lock, so where it lands is decided by the code under test rather than
# by the fixture guessing an unlocked moment.
[ -z "${LATE_ARMED_FLAG:-}" ] || [ ! -f "$LATE_ARMED_FLAG" ] || maybe_register_late
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    session_for "$target" >> "$KILL_LOG"; printf '\n' >> "$KILL_LOG"
    # BOUNDARY PROBE. Real tmux does not return from the caller's kill-session —
    # the process dies — while this mock does, so no arm can observe "what ran
    # after" faithfully. What IS observable either way is the state of the world
    # AT the kill. Snapshotting the durable log here turns an ordering claim into
    # a content claim, which the mock can answer honestly.
    if [ -n "${EVENTLOG_SNAP:-}" ] && [ "$(session_for "$target")" = "${EVENTLOG_SNAP_SESSION:-}" ]; then
      cp "${TAP_HOME}/registry-events.log" "$EVENTLOG_SNAP" 2>/dev/null || : > "$EVENTLOG_SNAP"
    fi
    # CORRUPTION IN THE ONE WINDOW THAT MATTERS: after the transaction has read
    # and written the registry, before its undo re-reads it. The python3
    # interposer cannot reach this window — it runs before the interpreter
    # starts, so corrupting there makes the transaction refuse at LOAD and the
    # undo is never entered at all (which is exactly how the first version of
    # arm 7z failed its own precondition).
    if [ -n "${INTERPOSE_CORRUPT_AT_KILL:-}" ]; then
      printf '%s' '{ corrupted at the kill boundary' > "${TAP_REGISTRY:-$TAP_HOME/registry.json}"
    fi
    # The other half of that window: the registry stays perfectly READABLE and
    # the WRITE fails. That separates "I declined to restore" from "I tried and
    # could not", which are different states with different disclosures.
    if [ -n "${INTERPOSE_UNWRITABLE_AT_KILL:-}" ]; then
      chmod 500 "$(dirname "${TAP_REGISTRY:-$TAP_HOME/registry.json}")" 2>/dev/null || true
    fi
    # Was registry.lock held while this kill ran? If the probe ACQUIRES it, the
    # kill is happening outside the critical section — the exact TOCTOU shape.
    if [ -n "${LOCK_PROBE_LOG:-}" ]; then
      _lp=0
      python3 -B -c "
import fcntl,sys
try:
    f=open(sys.argv[1]+'.lock','a+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except OSError:
    raise SystemExit(3)
raise SystemExit(0)
" "$TAP_HOME/registry.json" || _lp=$?
      if [ "$_lp" = 3 ]; then
        printf '%s HELD\n' "$(session_for "$target")" >> "$LOCK_PROBE_LOG"
      else
        printf '%s FREE\n' "$(session_for "$target")" >> "$LOCK_PROBE_LOG"
      fi
    fi
    [ -z "${LATE_ARMED_FLAG:-}" ] || : > "$LATE_ARMED_FLAG"
    maybe_register_late
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(session_for "$target")"
    # SURVIVE_KILL names a session that stays alive after kill-session, which is
    # how the fixture reaches the kill-failed outcome (authorized, attempted,
    # session survived) rather than a refusal.
    if [ -n "${SURVIVE_KILL:-}" ] && [ "$resolved" = "$SURVIVE_KILL" ]; then exit 0; fi
    grep -qxF "$resolved" "$KILL_LOG" 2>/dev/null && exit 1
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    [ "$all" = 1 ] && { printf '%%101\t/dev/faketty\n'; exit 0; }
    # Co-tenant panes are listed alongside the primary. Fixtures that inject a
    # second row into a session give it one of these ids, and a mock that did not
    # know them made every such seat "unverified pane" — so arms meant to drive a
    # co-tenant path were quietly testing a refusal instead (partner review's
    # fidelity note on 7e; 8o could not reach a failed self kill at all).
    case "$(session_for "$target")" in
      demo/kimi)   printf '%s\n' '%101' '%190' ;;
      demo/grok)   printf '%s\n' '%102' '%191' '%192' '%194' '%196' ;;
      demo/sonnet) printf '%s\n' '%103' ;;
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
        *pid*start_time*) echo "900:100" ;;
        *window_index*) echo "demo/kimi:0.0" ;;
        # A bare pane_id probe is how the caller asks for its OWN pane; without
        # this branch self is never identified and --keep-self silently spares
        # nothing, which would make the composition arm below vacuous.
        *pane_id*) echo "%101" ;;
        *pane_tty*) echo "/dev/faketty" ;;
        *session_name*) echo "demo/kimi" ;;
        # Same fail-loud rule as the targeted branch: an empty answer here is how
        # an unmodeled probe passes for a working one (partner review).
        *) echo "team-only-driven MOCK: unmodeled no-target display-message format: $fmt" >&2
           exit 97 ;;
      esac
      exit 0
    fi
    # A stamp-less spared row whose pane cannot be positively observed at all
    # (P1-a's OTHER branch: tap_pane_observe itself fails, not just returns an
    # unexpected session). Real tmux answers an empty #{pane_id} for a gone
    # target; this mirrors that shape for exactly the target the arm names,
    # scoped narrowly so no other arm's display-message calls are affected.
    if [ -n "${OBSERVE_UNRESOLVABLE_PANE:-}" ] && [ "$target" = "$OBSERVE_UNRESOLVABLE_PANE" ]; then
      printf '\n'
      exit 0
    fi
    resolved="$(pane_id_for "$target")"
    sess="$(session_for "$target")"
    case "$fmt" in
      # Four-field calling observe. *pane_id*pane_tty* also matches that
      # string; first match must not return two fields (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t%s\t%s\t900:100\n' "$resolved" "$(tty_for "$resolved")" "$sess" ;;
      # Caller-pane observability. The COMBINED pane_id+pane_tty format must be
      # matched before the bare pane_tty one, or the re-verify gets half an
      # answer and self is silently never identified — which would make the
      # keep-self composition arm vacuous rather than failing loudly.
      *pane_id*pane_tty*) printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      *pane_tty*) printf '%s\n' "$(tty_for "$resolved")" ;;
      # THREE tab-separated fields, matching the real probe exactly. An earlier
      # version answered two fields with the wrong separator; the caller was then
      # never identified as self, --keep-self silently spared nothing, and the
      # composition arm would have been vacuous instead of red.
      *pane_id*session_name*pid*) printf '%s\t%s\t%s\n' "$resolved" "$sess" "900:100" ;;
      *pane_id*session_name*) printf '%s\t%s\n' "$resolved" "$sess" ;;
      *pane_id*) printf '%s\n' "$resolved" ;;
      *session_name*) printf '%s\n' "$sess" ;;
      *pid*start_time*) echo "900:100" ;;
      # FAIL LOUD on a format this mock does not model (gate review's sweep).
      # Returning empty is how a fidelity gap becomes a VACUOUS PASS: the caller
      # reads a blank answer, degrades quietly, and the arm goes green about a
      # path it never exercised — which is exactly how the three-field identity
      # probe went unnoticed here. Every format production asks of this fixture
      # today has an explicit case above, so this branch is unreachable now and
      # turns the next unmodeled probe into a red test instead of a silent one.
      *) echo "team-only-driven MOCK: unmodeled display-message format: $fmt" >&2
         exit 97 ;;
    esac
    exit 0 ;;
  list-sessions) printf '%s\n' 'demo/kimi' 'demo/grok' 'demo/sonnet'; exit 0 ;;
  # detach's own tmux calls (tap-sttl, P1-b): has-session already exists above.
  # A KILLed session reports no clients, same "gone" signal has-session uses;
  # NO_CLIENTS names one session as live-but-already-detached (empty stdout).
  # Every other live session reports one fake client, so detach-client is
  # reachable and its call is observable via DETACH_LOG.
  list-clients)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    resolved="$(session_for "$target")"
    grep -qxF "$resolved" "$KILL_LOG" 2>/dev/null && exit 0
    [ -n "${NO_CLIENTS:-}" ] && [ "$resolved" = "${NO_CLIENTS}" ] && exit 0
    printf '/dev/fake-client-tty\n'
    exit 0 ;;
  detach-client)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -s) target="$2"; shift 2 ;; *) shift ;; esac; done
    printf '%s\n' "$(session_for "$target")" >> "$DETACH_LOG"
    exit 0 ;;
  # An unknown SUBCOMMAND exiting 0 is the same vacuous-success trap one level
  # up: production would read success from a command this mock never modeled.
  *) echo "team-only-driven MOCK: unmodeled tmux subcommand: $cmd" >&2; exit 97 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/mktemp" <<'MKT'
#!/usr/bin/env bash
# Fails ONLY for a template naming the injected substring; everything else goes
# to the real mktemp untouched. The real binary is resolved by absolute path so
# this shim cannot recurse into itself through PATH.
if [ -n "${INTERPOSE_MKTEMP_FAIL:-}" ]; then
  for _a in "$@"; do
    case "$_a" in
      *"$INTERPOSE_MKTEMP_FAIL"*)
        echo "mktemp: injected allocation failure for $_a" >&2
        exit 1 ;;
    esac
  done
fi
# tap-sttl, gate review P2: allocation SUCCEEDING is not the same
# fact as the write afterward succeeding — TMPDIR can fill (or a byte quota can
# be hit) in the window between mktemp returning a path and the caller's first
# write to it. Stands in for that race deterministically: the real file is
# allocated normally, then made unwritable before its path is returned, so the
# caller's OWN subsequent `>>` is what fails, exactly as a real TOCTOU would.
if [ -n "${INTERPOSE_MKTEMP_UNWRITABLE_AFTER:-}" ]; then
  for _a in "$@"; do
    case "$_a" in
      *"$INTERPOSE_MKTEMP_UNWRITABLE_AFTER"*)
        for _c in /usr/bin/mktemp /bin/mktemp; do
          if [ -x "$_c" ]; then
            _p="$("$_c" "$@")"
            chmod 400 "$_p"
            printf '%s\n' "$_p"
            exit 0
          fi
        done
        exit 127 ;;
    esac
  done
fi
for _c in /usr/bin/mktemp /bin/mktemp; do
  [ -x "$_c" ] && exec "$_c" "$@"
done
echo "mktemp: no real mktemp found" >&2
exit 127
MKT
chmod +x "$FAKE_BIN/mktemp"

write_registry() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "kimi":   {"status": "active", "delivery": "pane", "pane": "demo/kimi:0.0",   "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/kimi"},
    "grok":   {"status": "active", "delivery": "pane", "pane": "demo/grok:0.0",   "pane_id": "%102", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/grok"},
    "sonnet": {"status": "active", "delivery": "pane", "pane": "demo/sonnet:0.0", "pane_id": "%103", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/sonnet"}
  }
}
JSON
}

# Pretend we are inside tmux so TAP resolves a caller pane: the mock's
# no-target display-message answers demo/kimi:0.0 -> %101 -> the kimi seat.
export TMUX="/tmp/fake,0,0"

# Every arm passes --keep-self. A self-inclusive down refuses here because the
# caller pane is not observable under a mock tmux, and that refusal would happen
# BEFORE any selection was applied — an arm that hit it would be green about a
# code path it never reached.
DOWN=("$TAP" team down --yes --keep-self)

# --- (1) --only stops ONLY the named seats -------------------------------------
# Not "did it exit 0" but WHICH sessions died — read from the kill log the mock
# records, so selection is observed as an effect rather than as a receipt claim.
write_registry
: > "$KILL_LOG"
rc=0
out="$("${DOWN[@]}" --only grok </dev/null 2>&1)" || rc=$?
# Gate the exit status. `|| true` discarded it here, so an arm could assert a
# receipt while the command had failed underneath it (partner review).
[ "$rc" = 0 ] || fail "(1) team down --only exited $rc; output: $out"
killed="$(tr '\n' ' ' <"$KILL_LOG")"
grep -qx "demo/grok" "$KILL_LOG" \
  || fail "(1) --only grok must stop grok; killed: $killed"
grep -qx "demo/kimi" "$KILL_LOG" \
  && fail "(1) --only grok must NOT stop kimi; killed: $killed"
grep -qx "demo/sonnet" "$KILL_LOG" \
  && fail "(1) --only grok must NOT stop sonnet; killed: $killed"
echo "team-only-driven: (1) --only stops exactly the named seat: ok"
# teamstop r5 U4B disposition: 13 further arms were deleted with the sourced
# engine (tap-team-stop.sh). Arms that called _tap_team_stop_tx_suspend_kill /
# _tap_team_stop_clear_registry / _tap_team_stop_restore_self_rows directly
# (7o, 7u, 7u4, 8m2, 10, 13e, 16) tested private helper contracts whose
# semantic coverage now lives in runtime/bun/test/team-stop.test.ts (tx modes,
# clear classes, restore/rollback tables) and team-stop-oracle.test.ts. Arms
# whose failure injection was the fake-python3 interposer for the DELETED
# engine's embedded python (7w, 7v, 7y3, 10b, 14b, 14c) can no longer fire:
# the native door runs no embedded python, so those runs were vacuous. Their
# refusal/recovery classes are covered natively in team-stop.test.ts
# (recovery_unavailable, registry_unreadable/invalid, rollback disclosure).

# --- (2) the RECEIPT the operator sees, from production stdout -----------------
# The assertion team-only-select.test.sh structurally cannot make: this line is
# read back from the command, so the CALL SITE is observed rather than rebuilt.
case "$out" in
  *"spared 2 seat(s) by --only grok — every other seat"*) ;;
  *) fail "(2) --only receipt must name the typed selection; stdout was: $out" ;;
esac
case "$out" in
  *"--except"*) fail "(2) an --only run must never mention --except; stdout was: $out" ;;
esac
# The plan header is a second call site with its own selector label. Assert the
# WHOLE line, rows included: an earlier version matched only the prefix, which
# accepted the complement being presented as if the operator had typed it
# (partner review). The qualifier is what makes the row list honest here.
case "$out" in
  *"spared by --only grok (rows unchanged, the complement — not a typed set): kimi (excepted: demo/kimi), sonnet (excepted: demo/sonnet)"*) ;;
  *) fail "(2) plan header must carry the typed selector AND mark the rows as the complement; stdout was: $out" ;;
esac
echo "team-only-driven: (2) production receipts name the typed selector: ok"

# --- (3) --except keeps its exact pre-existing wording -------------------------
# The separator regression lived at this call site and the gating suite could not
# see it. Byte-exact, including the colon that went missing behind a space.
write_registry
: > "$KILL_LOG"
rc=0
out="$("${DOWN[@]}" --except grok </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(3) team down --except exited $rc; output: $out"
killed="$(tr '\n' ' ' <"$KILL_LOG")"
# TWO, not one: this run passes --keep-self, and CONTRACT says the spared set is
# the UNION of the selector and keep-self, reported as one set. The receipt
# counted only the selector's own tally, so it announced one fewer seat than it
# spared — and this arm asserted the undercount, which is why it survived
# (codex bot). Pre-existing on the --except path; the line is shared.
case "$out" in
  *"spared 2 seat(s) by --except: grok (includes --keep-self)"*) ;;
  *) fail "(3) --except receipt must count the keep-self union; stdout was: $out" ;;
esac
case "$out" in
  *"--except :"*) fail "(3) the stray-separator regression is back; stdout was: $out" ;;
esac
case "$out" in
  *"spared by --except (rows unchanged):"*) ;;
  *) fail "(3) --except plan header must be unchanged; stdout was: $out" ;;
esac
grep -qx "demo/grok" "$KILL_LOG" && fail "(3) --except grok must spare grok; killed: $killed"
grep -qx "demo/sonnet" "$KILL_LOG" || fail "(3) --except grok must still stop sonnet; killed: $killed"
echo "team-only-driven: (3) --except receipt and behavior are unchanged: ok"

# --- (4) whole-roster --only keeps its selector visible ------------------------
# Nothing is spared here, so a receipt gated on a nonempty spared set would print
# nothing about the flag and a full-team stop would read as unselected.
# Deliberately WITHOUT --keep-self, so "none spared" is actually true.
write_registry
: > "$KILL_LOG"
rc=0
out="$("$TAP" team down --yes --only kimi,grok,sonnet </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(4) whole-roster team down --only exited $rc; output: $out"
case "$out" in
  *"--only kimi, grok, sonnet matched every seat — none spared"*) ;;
  *) fail "(4) whole-roster --only must report its selector; stdout was: $out" ;;
esac
echo "team-only-driven: (4) whole-roster --only still reports its selector: ok"

# --- (5) whole-roster --only COMPOSED with --keep-self -------------------------
# The composition the partner reviewer named: the fallback branched on selector
# exclusions, which whole-roster --only leaves at zero, so it announced "none
# spared" while --keep-self had in fact spared the caller. The receipt must
# report the effective UNION, and the caller must actually survive.
write_registry
: > "$KILL_LOG"
rc=0
out="$("${DOWN[@]}" --only kimi,grok,sonnet </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(5) whole-roster --only --keep-self exited $rc; output: $out"
case "$out" in
  *"--only kimi, grok, sonnet matched every seat; 1 spared by --keep-self"*) ;;
  *) fail "(5) receipt must report the keep-self union, not 'none spared'; stdout was: $out" ;;
esac
case "$out" in
  *"none spared"*) fail "(5) 'none spared' is false when keep-self spared the caller; stdout was: $out" ;;
esac
# The effect, not just the receipt: the caller session must survive.
grep -qx "demo/kimi" "$KILL_LOG" \
  && fail "(5) --keep-self must spare the caller session; killed: $(tr '\n' ' ' <"$KILL_LOG")"
grep -qx "demo/grok" "$KILL_LOG" \
  || fail "(5) non-caller named seats must still be stopped; killed: $(tr '\n' ' ' <"$KILL_LOG")"
echo "team-only-driven: (5) whole-roster --only composes with --keep-self: ok"

# --- (6) detach: selection applies, and whole-roster --only stays visible ------
# The third verb that gated its selector receipt on a nonempty spared set
# (partner review). Partial first, so the arm proves selection WORKS here before it
# asserts what the whole-roster receipt says.
write_registry
# Earlier arms killed sessions and the mock reports those as gone; clear the log
# so detach sees a whole, live team rather than inheriting their wreckage.
: > "$KILL_LOG"
rc=0
out="$("$TAP" team detach --only grok </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(6) team detach --only exited $rc; output: $out"
case "$out" in
  *"kimi"*excluded*) ;;
  *) fail "(6) --only grok must exclude kimi on detach; output: $out" ;;
esac
case "$out" in
  *"sonnet"*excluded*) ;;
  *) fail "(6) --only grok must exclude sonnet on detach; output: $out" ;;
esac
rc=0
out="$("$TAP" team detach --only kimi,grok,sonnet </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(6) whole-roster team detach --only exited $rc; output: $out"
case "$out" in
  *"--only kimi, grok, sonnet matched every seat — none spared"*) ;;
  *) fail "(6) whole-roster --only must name its selector on detach; output: $out" ;;
esac
echo "team-only-driven: (6) detach selection and whole-roster receipt: ok"

# --- (6b) --json carries shared-session collateral in the effective set -------
# A SELECTED row spared because its session hosts an unselected co-tenant is
# recorded only as shared_session, so excluded_handles omitted it and --json
# under-reported the effective spared set CONTRACT says it carries
# (partner review P2). Here `tenant` shares demo/grok with the selected `grok`.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "kimi":   {"status": "active", "delivery": "pane", "pane": "demo/kimi:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/kimi"},
    "grok":   {"status": "active", "delivery": "pane", "pane": "demo/grok:0.0", "pane_id": "%102", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/grok"},
    "tenant": {"status": "active", "delivery": "pane", "pane": "demo/grok:0.1", "pane_id": "%198", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/grok"}
  }
}
JSON
: > "$KILL_LOG"
rc=0
out="$("${DOWN[@]}" --json --only grok </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(6b) --json --only exited $rc; output: $out"
for h in kimi tenant grok; do
  case "$out" in
    *"\"$h\""*) ;;
    *) fail "(6b) excluded_handles must carry '$h' as effective spared set; output: $out" ;;
  esac
done
# grok is the SELECTED handle, spared only as shared-session collateral — it is
# the one the old build dropped.
case "$out" in
  *'"excluded_handles"'*'"grok"'*) ;;
  *) fail "(6b) shared-session collateral 'grok' missing from excluded_handles; output: $out" ;;
esac
echo "team-only-driven: (6b) --json effective set includes shared-session collateral: ok"

# Detach late-co-tenant race is now tested in team-detach-teardown.test.ts
# against the native registry reread; the retired Python argv shim cannot reach it.

# (7q2) WITHDRAWN, and the reason is recorded rather than the arm.
#
# The proposed instrument was: adopt a row during an EARLIER TEAMMATE transaction,
# then require its terminal event in the kill-time snapshot at the later caller
# self-kill. I built it. A vacuity guard on the same arm — "was hanger adopted by
# anything at all?" — says NO: this fixture's late-row injection fires on tmux
# calls whose ordering puts the row in AFTER the teammate transactions have run,
# so the arm asserted a property about a row that was never adopted.
#
# The other candidate hook cannot reach a teammate either: INTERPOSE_ROW_JSON
# fires at TAP_TEAM_STOP_TX_MODE=cotenant_kill, which is the SELF-LAST transaction
# only — teammate kills take kill_only (clear) or full (suspend).
#
# So the teammate-drain ordering remains unpinned by this fixture, and shipping
# the arm would have certified coverage the guard says it does not have. The claim
# is held by the boundary reasoning plus the external real-tmux probe until an
# arrangement that actually adopts during a teammate transaction exists.

# (7r) ...AND THE FAILED-KILL MIRROR. cotenant_kill stamps adopted rows before
# killing; when the session SURVIVES, the failed-kill branch restored only the
# prepare snapshot, which was taken before those rows were adopted and so can
# never contain them — the survivor was left marked suspended while its session
# was still alive (partner review #2). Rolling back what this branch wrote is this
# branch's own job.
write_registry
_fk_home="$(mktemp -d)"
mkdir -p "$_fk_home/payloads" "$_fk_home/receipts" "$_fk_home/recovery"
cp "$TAP_HOME/registry.json" "$_fk_home/registry.json"
: > "$KILL_LOG"
INTERPOSE_ROW_JSON="$(mktemp)"
cat > "$INTERPOSE_ROW_JSON" <<'JSON'
{"survivor": {"status":"active","delivery":"pane","pane":"demo/kimi:0.4","pane_id":"%190","harness":"claude","server_epoch":"srv:900:100","session":"demo/kimi"}}
JSON
export INTERPOSE_ROW_JSON
rc=0
SURVIVE_KILL="demo/kimi" TAP_HOME="$_fk_home"   "$TAP" team shutdown --yes --json </dev/null >/dev/null 2>&1 || rc=$?
INTERPOSE_ROW_JSON=""; export INTERPOSE_ROW_JSON
SURVIVE_KILL=""; export SURVIVE_KILL
python3 -B - "$_fk_home/registry.json" <<'CHK' || fail "(7r) a survivor was left marked stopped"
import json, os, sys
if not os.path.exists(sys.argv[1]):
    raise SystemExit("the registry is gone, so no survivor row can be checked")
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
row = agents.get("survivor")
if isinstance(row, dict) and row.get("status") == "suspended"    and row.get("status_reason") == "session_stopped":
    raise SystemExit("survivor is marked suspended/session_stopped while its session is ALIVE — "
                     "the failed-kill branch restored only the prepare snapshot, which cannot "
                     "contain a row adopted after it was taken")
CHK
# ...and NO killed event may name it. The bridge wrote adopted handles at
# ADOPTION time, before any outcome was known, and the shell converts every line
# to action=killed — so a transaction that adopted and then failed its kill
# reported a LIVE seat as stopped in the durable log (partner review #1). The bridge
# carries a terminal fact and must be written where the fact is known.
if [ -f "$_fk_home/registry-events.log" ]; then
  grep "action=killed" "$_fk_home/registry-events.log" 2>/dev/null | grep -q "handle=survivor" \
    && fail "(7r) a live seat was recorded as killed after its kill FAILED: $(grep 'action=' "$_fk_home/registry-events.log" | tr '\n' '|')"
fi
rm -rf "$_fk_home"
write_registry
echo "team-only-driven: (7r) a failed kill un-stamps its adopted rows and claims no kill: ok"

# --- (8) PRODUCTION `tap team shutdown --only`, not the helper ----------------
# The partner reviewer: arm 7b called _tap_team_stop_tx_suspend_kill directly, which
# proved the helper while the shutdown/clear path BYPASSED it. These arms drive
# the real verb, which is the only thing that can show the path is wired.

# (8a) a co-tenant registering into a later target session must block its kill.
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"latecomer": {"status":"active","delivery":"pane","pane":"demo/sonnet:0.1","pane_id":"%199","harness":"claude","server_epoch":"srv:900:100","session":"demo/sonnet"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
rc=0
out="$("$TAP" team shutdown --yes --keep-self --json --only grok,sonnet </dev/null 2>&1)" || rc=$?
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
LOCK_PROBE_LOG="$(mktemp)"; export LOCK_PROBE_LOG
INTERPOSE_ROW_JSON=""; export INTERPOSE_ROW_JSON
INTERPOSE_CORRUPT=""; export INTERPOSE_CORRUPT
SURVIVE_KILL=""; export SURVIVE_KILL
[ "$rc" = 0 ] || fail "(8a) shutdown --only exited $rc; out: $out"
grep -qx "demo/sonnet" "$KILL_LOG" \
  && fail "(8a) shutdown killed demo/sonnet after 'latecomer' joined it unnamed; out: $out"
case "$out" in
  *latecomer*) ;;
  *) fail "(8a) the refusal must name the late co-tenant; out: $out" ;;
esac
# A refused session is still LIVE, so its selected row must survive the clear —
# deleting it is the live-pane-with-no-row orphan (partner review P1).
python3 -B - "$TAP_HOME/registry.json" <<'CHK' || fail "(8a) the refused selected row 'sonnet' was deleted; out: $out"
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
raise SystemExit(0 if "sonnet" in agents else 1)
CHK
# Re-review of P1-d (F1): a co-tenant safety spare is a LEGAL
# no-op (CONTRACT), not a refusal — the JSON surface must agree with that,
# not just the human warning text and the exit code.
agg="$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)"
python3 -B - "$agg" <<'CHK2' || fail "(8a) a co-tenant safety spare leaked into refused_sessions/partial; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
if agg.get("refused_sessions"):
    raise SystemExit("spared session showed up as refused: %r" % (agg.get("refused_sessions"),))
if agg.get("partial") is not False:
    raise SystemExit("partial must be false when nothing was genuinely refused: %r" % (agg.get("partial"),))
CHK2
echo "team-only-driven: (8a) refused session keeps its row and is not killed: ok"

# (8a2) re-review of P1-d (F1): the JSON refused_sessions surface
# must agree with the exit code on the spared/refused distinction, not just the
# human warning text. A genuine refusal (survives its kill, no selection
# collateral involved) must show up in refused_sessions with partial=true.
write_registry
: > "$KILL_LOG"
SURVIVE_KILL="demo/grok"; export SURVIVE_KILL
out="$("$TAP" team shutdown --yes --keep-self --json --only grok </dev/null 2>&1)" || true
SURVIVE_KILL=""; export SURVIVE_KILL
agg="$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)"
python3 -B - "$agg" <<'CHK' || fail "(8a2) a genuine kill-survived refusal is missing from refused_sessions or partial; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
if "demo/grok" not in (agg.get("refused_sessions") or []):
    raise SystemExit("refused_sessions missing the genuine refusal: %r" % (agg.get("refused_sessions"),))
if agg.get("partial") is not True:
    raise SystemExit("partial must be true for a genuine refusal: %r" % (agg.get("partial"),))
CHK
write_registry
echo "team-only-driven: (8a2) a genuine kill-survived refusal appears in refused_sessions and sets partial: ok"

# (8b) whole-roster --only spares nobody at PLAN time, so the keep set is empty
# and the clear path deleted the entire registry — including a row that arrived
# afterwards and was never named.
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"latecomer": {"status":"active","delivery":"pane","pane":"demo/late:0.0","pane_id":"%198","harness":"claude","server_epoch":"srv:900:100","session":"demo/late"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
rc=0
# --json so the RECEIPT is inspectable, not just the registry file: asserting
# only that the row survives is a half-check of the shape that let threads 19/25
# through — a correct action carrying an incorrect machine record.
out="$("$TAP" team shutdown --yes --json --only kimi,grok,sonnet </dev/null 2>&1)" || rc=$?
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
LOCK_PROBE_LOG="$(mktemp)"; export LOCK_PROBE_LOG
INTERPOSE_ROW_JSON=""; export INTERPOSE_ROW_JSON
INTERPOSE_CORRUPT=""; export INTERPOSE_CORRUPT
SURVIVE_KILL=""; export SURVIVE_KILL
[ "$rc" = 0 ] || fail "(8b) whole-roster shutdown --only exited $rc; out: $out"
[ -f "$TAP_HOME/registry.json" ] \
  || fail "(8b) shutdown deleted the whole registry, losing a row --only never named; out: $out"
python3 -B - "$TAP_HOME/registry.json" <<'CHK' || fail "(8b) the late unnamed row was deleted; out: $out"
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
raise SystemExit(0 if "latecomer" in agents else 1)
CHK
# ...and the RECEIPT must say so. Asserting only that the row survives is a
# half-check of exactly the shape that let threads 19/25 through: a correct
# action carrying an incorrect machine record. excluded_handles[] is defined as
# the EFFECTIVE spared set, and this seat was spared by the locked clear, which
# runs after the plan-time accumulation is already closed (codex bot, thread 17).
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8b) the receipt omits the late seat it spared; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
excluded = agg.get("excluded_handles") or []
if "latecomer" not in excluded:
    raise SystemExit("excluded_handles omits the retained late seat: %r" % (excluded,))
# Sessions are NOT symmetric with handles: a session belongs here only if it was
# genuinely left alone. This one was never a kill target, so it must appear —
# but a late row sharing a STOPPED session must not.
spared = agg.get("spared_sessions") or []
stopped = agg.get("stopped_sessions") or []
if "demo/late" not in spared:
    raise SystemExit("spared_sessions omits the untouched late session: %r" % (spared,))
overlap = sorted(set(spared) & set(stopped))
if overlap:
    raise SystemExit("a session is reported BOTH spared and stopped: %r" % (overlap,))
CHK
echo "team-only-driven: (8b) whole-roster shutdown --only keeps a late unnamed row AND reports it: ok"

# (8e) THE ASYMMETRY. (8b) covers a late row in its own untouched session, where
# handle and session are both spared. Here the late row claims a session this run
# already STOPPED. Its handle is still effectively spared — the clear retained the
# row — but its session was not left alone, it was killed, so reporting it under
# spared_sessions would announce a live session that is gone.
#
# Without this arm the stopped-list check is an unpinned guard: removing it left
# the whole suite green, because every other fixture gives the late row a session
# nobody touched.
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"straggler": {"status":"active","delivery":"pane","pane":"demo/grok:0.9","pane_id":"%197","harness":"claude","server_epoch":"srv:900:100","session":"demo/grok"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
rc=0
out="$("$TAP" team shutdown --yes --json --only kimi,grok,sonnet </dev/null 2>&1)" || rc=$?
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8e) a stopped session was reported as spared; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
spared = agg.get("spared_sessions") or []
stopped = agg.get("stopped_sessions") or []
overlap = sorted(set(spared) & set(stopped))
if overlap:
    raise SystemExit("reported BOTH spared and stopped: %r (spared=%r stopped=%r)"
                     % (overlap, spared, stopped))
if "demo/grok" in spared:
    raise SystemExit("a killed session was reported spared: %r" % (spared,))
CHK
echo "team-only-driven: (8e) a late row on a STOPPED session never reports that session spared: ok"

# (8f) A SPARED PANE ROW WITH NO SESSION STAMP must not invent one, and must not
# silently contribute NO session either. The row is reachable: registration
# writes `session` conditionally (tap-register.sh: `if pane_session:`) from a
# tmux probe allowed to fail, and regress's `recycled` seat is exactly this
# shape.
#
# P1-a (panel review): the OLD behavior contributed no session at
# all for this row, so the co-tenant protection below never saw it — `stampless`
# genuinely lives inside `demo/grok` (pane %196 is listed as a co-tenant of that
# session at list-panes above), so a plain `--only grok` would have killed
# `demo/grok` and taken the spared `stampless` down with it (thread 29). The FIX
# is a positive `tap_pane_observe` on the row's pane_id, which this arm now pins
# directly: the observed session must show up in spared_sessions, and because
# `grok`'s own session IS that co-tenant session, the run must spare `grok` too
# rather than kill it — nothing is killed at all.
write_registry
python3 -B - "$TAP_HOME/registry.json" <<'STAMPLESS'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["stampless"] = {"status": "active", "delivery": "pane",
                              "pane": "demo/grok:0.5", "pane_id": "%196",
                              "harness": "claude", "server_epoch": "srv:900:100"}
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
STAMPLESS
: > "$KILL_LOG"
out="$("$TAP" team shutdown --yes --json --only grok </dev/null 2>&1)" || true
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8f) a stamp-less spared row did not resolve its real co-tenant session; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
spared = agg.get("spared_sessions") or []
excluded = agg.get("excluded_handles") or []
if "demo/stampless" in spared:
    raise SystemExit("invented <team>/<handle> for a stamp-less pane row: %r" % (spared,))
# THE POSITIVE case: the row's pane really lives in demo/grok, and the fix must
# observe that rather than contribute nothing.
if "demo/grok" not in spared:
    raise SystemExit("the stamp-less row's real co-tenant session was never observed: %r" % (spared,))
if "stampless" not in excluded:
    raise SystemExit("the spared stamp-less seat lost its handle: %r" % (excluded,))
# Co-tenant protection: since demo/grok now correctly shows as hosting a spared
# seat, grok's OWN session must be spared too, not killed alongside it.
if "grok" not in excluded:
    raise SystemExit("grok was not spared despite sharing a session with a spared co-tenant: %r" % (excluded,))
if agg.get("killed_sessions") or agg.get("stopped_sessions"):
    raise SystemExit("something was killed despite the target session hosting a spared co-tenant: %r" % (agg,))
CHK
if [ -s "$KILL_LOG" ]; then
  fail "(8f) tmux kill-session was invoked despite the co-tenant spare: $(cat "$KILL_LOG")"
fi
write_registry
echo "team-only-driven: (8f) a stamp-less spared pane row positively resolves its real session and spares its co-tenant: ok"

# (8f2) The OTHER half of P1-a: when the stamp-less row's pane cannot be
# positively observed at all (tap_pane_observe itself fails — the pane is truly
# gone, not just differently named), the fix refuses the whole destructive
# selection rather than guess or silently proceed. This is the branch the OLD
# "contribute no session" behavior took by default; P1-a makes it an explicit,
# loud refusal instead.
write_registry
python3 -B - "$TAP_HOME/registry.json" <<'STAMPLESS2'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["stampless"] = {"status": "active", "delivery": "pane",
                              "pane": "demo/grok:0.5", "pane_id": "%196",
                              "harness": "claude", "server_epoch": "srv:900:100"}
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
STAMPLESS2
: > "$KILL_LOG"
rc=0
out="$(OBSERVE_UNRESOLVABLE_PANE="%196" "$TAP" team shutdown --yes --json --only grok </dev/null 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(8f2) an unobservable spared pane row did not refuse the run; out: $out"
case "$out" in
  *unobservable_spare*) : ;;
  *) fail "(8f2) the refusal did not name unobservable_spare; out: $out" ;;
esac
if [ -s "$KILL_LOG" ]; then
  fail "(8f2) tmux kill-session was invoked despite the unobservable spare refusal: $(cat "$KILL_LOG")"
fi
write_registry
echo "team-only-driven: (8f2) an unobservable spared pane row refuses the whole selection rather than guess: ok"

# (8f3) A THIRD half of P1-a, found while fixing regress arm (9d): when the
# operator's OWN selection already spares EVERY seat (here, --except names
# all four handles), this run kills nothing no matter what any row's session
# turns out to be. It must stay the pre-existing legal no-op — exit 0, the
# explicit "no seats matched" line — even though `stampless`'s pane is the
# SAME unobservable one that made (8f2) refuse under --only. Reusing
# OBSERVE_UNRESOLVABLE_PANE here is the point: if pass 1's observation ran at
# all for this row, this would refuse exactly like (8f2) did; it must not,
# because there is no non-spared row left for that observation to protect.
write_registry
python3 -B - "$TAP_HOME/registry.json" <<'STAMPLESS3'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["stampless"] = {"status": "active", "delivery": "pane",
                              "pane": "demo/grok:0.5", "pane_id": "%196",
                              "harness": "claude", "server_epoch": "srv:900:100"}
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
STAMPLESS3
: > "$KILL_LOG"
out="$(OBSERVE_UNRESOLVABLE_PANE="%196" "$TAP" team shutdown --yes --except kimi,grok,sonnet,stampless </dev/null 2>&1)" \
  || fail "(8f3) an all-spared selection refused instead of taking the legal no-op; out: $out"
case "$out" in
  *"no seats matched after"*) : ;;
  *) fail "(8f3) an all-spared selection did not print the explicit no-op line; out: $out" ;;
esac
case "$out" in
  *unobservable_spare*) fail "(8f3) an all-spared selection still tried to observe an unobservable co-tenant pane; out: $out" ;;
esac
if [ -s "$KILL_LOG" ]; then
  fail "(8f3) tmux kill-session was invoked despite every seat being spared: $(cat "$KILL_LOG")"
fi
write_registry
echo "team-only-driven: (8f3) sparing every seat is a legal no-op even when a spared co-tenant's pane is unobservable: ok"

# (8g) The pane-LESS half of the same rule: a spared POLL seat contributes NO
# session. It used to contribute the invented `<team>/<handle>`, which could
# collide with a real noncanonical session name belonging to a SELECTED seat and
# spare a session the operator asked to act on (codex bot, thread 12).
#
# The collision is built explicitly: poll seat `late` synthesizes `demo/late`,
# and a selected pane seat really lives in a session of that name.
write_registry
python3 -B - "$TAP_HOME/registry.json" <<'COLLIDE'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["late"] = {"status": "active", "delivery": "poll",
                         "registered_at": "2026-07-10T00:00:00Z"}
reg["seats"]["grok"]["session"] = "demo/late"
reg["seats"]["grok"]["pane"] = "demo/late:0.0"
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
COLLIDE
: > "$KILL_LOG"
out="$("$TAP" team shutdown --yes --json --only grok </dev/null 2>&1)" || true
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8g) the poll seat's invented session spared a SELECTED one; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
spared = agg.get("spared_sessions") or []
if "demo/late" in spared:
    raise SystemExit("a pane-less seat synthesized a session that spared a SELECTED seat: %r" % (spared,))
excluded = agg.get("excluded_handles") or []
# ...and the SELECTED seat is never moved to the spared side by that name.
if "grok" in excluded:
    raise SystemExit("the SELECTED seat was spared by a pane-less row's invented name: %r" % (excluded,))
# The poll seat is still spared as a HANDLE — it just brings no session with it.
if "late" not in excluded:
    raise SystemExit("the spared poll seat lost its handle from the receipt: %r" % (excluded,))
CHK
# Deliberately NOT asserting on KILL_LOG: moving grok into a session the tmux
# mock does not know makes its pane unverifiable, so the run refuses that seat
# rather than killing it — a property of the FIXTURE, not of the code under
# test. The receipt above is what discriminates.
write_registry
echo "team-only-driven: (8g) a pane-less spared seat contributes no session: ok"

# (8h) ATTRIBUTION. Once the locked clear can add late rows to the effective
# spared set, the plan-time count and the effective one disagree, and the receipt
# has to say WHY a seat was spared, not just how many. Reporting a late --only
# spare as "spared by --keep-self" is wrong twice: the flag may not have been
# passed at all, and it hides that the selection did the sparing, late.
#
# This is a defect the late-row receipt fix introduced, caught in review before
# it shipped (codex bot).
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"latecomer": {"status":"active","delivery":"pane","pane":"demo/late:0.0","pane_id":"%195","harness":"claude","server_epoch":"srv:900:100","session":"demo/late"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
out="$("$TAP" team shutdown --yes --only kimi,grok,sonnet </dev/null 2>&1)" || true
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
case "$out" in
  *"--keep-self"*) fail "(8h) a late --only spare was attributed to --keep-self, which was never passed; out: $out" ;;
esac
case "$out" in
  *"matched every seat at plan time"*"1 registered late"*) ;;
  *) fail "(8h) the receipt does not attribute the late spare to the selection, with its own count; out: $out" ;;
esac
write_registry
echo "team-only-driven: (8h) a late spare is attributed to the selector, not to --keep-self: ok"

# (8i) BOTH CAUSES AT ONCE — the interaction the flag-based receipt could not
# express. Whole-roster --only, --keep-self sparing the caller, AND a late row.
# The union is two, from two different causes, and attributing all of it to
# either one is a false explanation (partner review #1).
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"latecomer": {"status":"active","delivery":"pane","pane":"demo/late:0.0","pane_id":"%193","harness":"claude","server_epoch":"srv:900:100","session":"demo/late"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
out="$("$TAP" team shutdown --yes --keep-self --only kimi,grok,sonnet </dev/null 2>&1)" || true
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
# EXACT counts, not just both labels. Matching labels alone is satisfied by any
# numbers at all — a hardcoded "9 by --keep-self, 9 registered late" passed the
# first version of this arm (partner review #3). The two causes contribute ONE seat
# each here and the numbers must differ from the union, or the arm cannot tell a
# real split from a copied total.
case "$out" in
  *"1 by --keep-self, 1 registered late"*) ;;
  *) fail "(8i) the receipt must give each cause its OWN count (expected 1 and 1); out: $out" ;;
esac
case "$out" in
  *"2 spared"*) ;;
  *) fail "(8i) the union must be 2, distinct from either cause; out: $out" ;;
esac
# ...and the run must actually have done what the receipt describes.
grep -qx "demo/grok" "$KILL_LOG" \
  || fail "(8i) the selected teammate was never killed: $(tr '\n' ' ' <"$KILL_LOG")"
grep -qx "demo/kimi" "$KILL_LOG" \
  && fail "(8i) --keep-self did not spare the caller: $(tr '\n' ' ' <"$KILL_LOG")"
python3 -B - "$TAP_HOME/registry.json" <<'CHK' || fail "(8i) the late row it claims to have spared is gone"
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
if "latecomer" not in agents:
    raise SystemExit("the late row the receipt counted was not retained: %r" % (sorted(agents),))
CHK
write_registry
echo "team-only-driven: (8i) a keep-self spare and a late spare are reported as distinct causes: ok"

# (8j) --keep-self FROM AN UNREGISTERED TERMINAL contributes no handle, so the
# receipt must not credit it. It keyed on the flag rather than on the selfmap,
# so a flag that spared nobody still claimed credit (partner review #6).
write_registry
: > "$KILL_LOG"
rc=0
out="$(TMUX="" "$TAP" team down --yes --keep-self --only grok </dev/null 2>&1)" || rc=$?
# STATUS AND EFFECT FIRST. `|| true` plus a negative text match is green for any
# failure at all — sol showed a `--bogus` invocation passing this arm, because a
# usage error prints no keep-self note either. A negative assertion is only
# meaningful once the positive path is known to have run.
[ "$rc" = 0 ] || fail "(8j) the probe run itself failed (rc=$rc), so the absence below proves nothing; out: $out"
grep -qx "demo/grok" "$KILL_LOG" \
  || fail "(8j) the selected seat was never stopped, so this run did not exercise the receipt: $(tr '\n' ' ' <"$KILL_LOG")"
# The FINAL aggregate receipt, not any line containing the word. The dry-run PLAN
# also prints "spared", so a bare match could be satisfied by output that never
# reached the receipt this arm is about (partner review).
case "$out" in
  *"tap team down: spared "*) ;;
  *) fail "(8j) no aggregate spared receipt was emitted; out: $out" ;;
esac
case "$out" in
  *"includes --keep-self"*) fail "(8j) --keep-self claimed credit from a terminal with no caller row; out: $out" ;;
esac
write_registry
echo "team-only-driven: (8j) --keep-self with an empty selfmap claims no credit: ok"

# (8n) THE THIRD SITE for delivery-before-stamp. The planner and the locked gate
# both stopped trusting a poll row's session; the LOCKED CLEAR's late-row report
# still copied it, so a pane-less seat spared at the clear contributed a session
# it does not occupy straight into the receipt. Same rule, third place it is owed
# — and it was the one site with no arm until this one (found unpinned by my own
# mutation matrix, not by review).
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"pollghost": {"status":"active","delivery":"poll","registered_at":"2026-07-10T00:00:00Z","session":"demo/nowhere"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
out="$("$TAP" team shutdown --yes --json --only kimi,grok,sonnet </dev/null 2>&1)" || true
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8n) a pane-less late row contributed a session to the receipt; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
spared = agg.get("spared_sessions") or []
if "demo/nowhere" in spared:
    raise SystemExit("a poll row's stale stamp reached spared_sessions: %r" % (spared,))
if "pollghost" not in (agg.get("excluded_handles") or []):
    raise SystemExit("the spared poll seat lost its handle: %r" % (agg.get("excluded_handles"),))
CHK
write_registry
echo "team-only-driven: (8n) a late pane-less row contributes no session to the receipt: ok"

# (8o) CAPTURE COVERS THE CALLER SESSION'S CURRENT MEMBERS, not just the
# plan-time caller. A row that becomes a co-tenant of the caller session after
# planning is deleted by the clear like any other, but capture saved only the
# plan-time caller — so a FAILED self kill restored the caller and nothing else,
# and the late row was gone from the registry AND from the recovery artifact
# (partner review #2). This drives the whole sequence: late co-tenant, clear,
# failed self kill, restore.
write_registry
_cap_home="$(mktemp -d)"
mkdir -p "$_cap_home/payloads" "$_cap_home/receipts" "$_cap_home/recovery"
cp "$TAP_HOME/registry.json" "$_cap_home/registry.json"
: > "$KILL_LOG"
# sidecar arrives DURING the run, not before it, and the run carries NO SELECTOR.
# Both details are load-bearing, and I got each wrong once:
#   - a co-tenant present at PLANNING is already in the plan-time selfmap, so it
#     is captured either way and the arm cannot discriminate;
#   - under a whole-roster --only, an unnamed late row is SPARED and the clear
#     retains it in-file, so it survives without ever being captured.
# Only a row the plan never saw AND which the clear deletes exercises the widened
# capture, which is exactly the case sol described.
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"sidecar": {"status":"active","delivery":"pane","pane":"demo/kimi:0.3","pane_id":"%190","harness":"claude","server_epoch":"srv:900:100","session":"demo/kimi"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
_o8o="$(mktemp)"; rc=0
# SURVIVE_KILL makes the caller session outlive its kill, which is the only
# outcome where the restore runs at all.
SURVIVE_KILL="demo/kimi" TAP_HOME="$_cap_home" \
  "$TAP" team shutdown --yes --json </dev/null >"$_o8o" 2>/dev/null || rc=$?
SURVIVE_KILL=""; export SURVIVE_KILL
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
# NOT asserting a nonzero exit here: the self kill is refused and the restore then
# SUCCEEDS, so nothing is left pending and exit 0 is the truthful outcome. Pinning
# the status would be asserting an incidental property of the fixture rather than
# this arm's claim, which is entirely about WHAT THE RESTORE BRINGS BACK.
case "$(cat "$_o8o")" in
  *'"refused_sessions":["demo/kimi"]'*|*'"recovery_pending":true'*) ;;
  *) fail "(8o) the caller session neither refused nor failed, so no restore ran; out: $(cat "$_o8o")" ;;
esac
[ -f "$_cap_home/registry.json" ] \
  || fail "(8o) the restore did not recreate the registry after a survivor outcome"
python3 -B - "$_cap_home/registry.json" <<'CHK' || fail "(8o) the restore lost a caller-session co-tenant; out: $(cat "$_o8o")"
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
missing = [h for h in ("kimi", "sidecar") if h not in agents]
if missing:
    raise SystemExit("restored rows are missing %r — capture saved only the plan-time caller, "
                     "so everything else in that session is gone from the registry AND the "
                     "recovery artifact" % (missing,))
CHK
rm -f "$_o8o"; rm -rf "$_cap_home"
write_registry
echo "team-only-driven: (8o) a failed self kill restores every row of the caller session: ok"

# (8p) RESTORE-NOT-RUN IS NOT RESTORE-SUCCESS. `_self_restore_rc` defaults to 0
# and only a restore that RAN can move it, so every path that skipped the restore
# was indistinguishable from one that succeeded — and the reaper deleted a
# NONEMPTY artifact nobody had restored from. Once capture widened, the pre-clear
# refusal became exactly that path: the late caller-session co-tenant is
# captured, the filter deletes its row, no restore runs, and the reap took the
# evidence too. The seat loses its row AND the means to get it back.
#
# LABEL CORRECTED: this arm does NOT drive a pre-clear refusal, whatever the
# sentence above once claimed — it drives a no-selector shutdown with a late
# caller-session co-tenant and asserts the invariant that outlives the specific
# path: a captured artifact still holding rows, with nothing restored from it,
# must survive. The reviewer rejected the pre-clear-refusal defect itself and
# flagged the label; the invariant is the part worth keeping.
write_registry
_pr_home="$(mktemp -d)"
mkdir -p "$_pr_home/payloads" "$_pr_home/receipts" "$_pr_home/recovery"
cp "$TAP_HOME/registry.json" "$_pr_home/registry.json"
: > "$KILL_LOG"
# A late co-tenant of the CALLER session, arriving during the run, plus an
# interposed unnamed co-tenant so the pre-clear self check REFUSES.
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"tagalong2": {"status":"active","delivery":"pane","pane":"demo/kimi:0.3","pane_id":"%190","harness":"claude","server_epoch":"srv:900:100","session":"demo/kimi"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
_o8p="$(mktemp)"; rc=0
TAP_HOME="$_pr_home" "$TAP" team shutdown --yes --json </dev/null >"$_o8p" 2>/dev/null || rc=$?
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
# Whatever the outcome, the invariant is the same: if a captured artifact still
# holds rows and NOTHING restored them, it must survive for the operator.
_left="$(find "$_pr_home/recovery" -type f -name 'self-row-*' -size +0 2>/dev/null | head -1)"
_rows_present="$(python3 -B -c '
import json,sys
reg=json.load(open(sys.argv[1])) if len(sys.argv)>1 else {}
a=reg.get("agents") or reg.get("seats") or {}
print("tagalong2" if "tagalong2" in a else "")
' "$_pr_home/registry.json" 2>/dev/null || true)"
if [ -z "$_rows_present" ] && [ -z "$_left" ]; then
  fail "(8p) the late caller-session co-tenant is gone from the registry AND no recovery artifact survives — its row and its evidence were both destroyed; out: $(cat "$_o8p")"
fi
rm -f "$_o8p"; rm -rf "$_pr_home"
write_registry
echo "team-only-driven: (8p) a captured artifact nobody restored from is not reaped: ok"

# (8l) A STAMPED POLL ROW. Poll re-registration does not clear a session left by
# an earlier pane registration, so the row can carry a stale name — and reading
# the stamp before the delivery let that dead name spare the REAL session of a
# SELECTED seat (partner review #4). Delivery is asked first now.
write_registry
python3 -B - "$TAP_HOME/registry.json" <<'STAMPED'
import json, sys
reg = json.load(open(sys.argv[1]))
# A poll seat still carrying `demo/grok` from a previous life as a pane seat.
reg["seats"]["ghost"] = {"status": "active", "delivery": "poll",
                          "registered_at": "2026-07-10T00:00:00Z",
                          "session": "demo/grok"}
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
STAMPED
: > "$KILL_LOG"
out="$("$TAP" team down --yes --json --only grok </dev/null 2>&1)" || true
python3 -B - "$(printf '%s' "$out" | grep -o '{"team".*}' | tail -1)" <<'CHK' || fail "(8l) a stamped poll row spared a SELECTED session; out: $out"
import json, sys
agg = json.loads(sys.argv[1])
spared = agg.get("spared_sessions") or []
if "demo/grok" in spared:
    raise SystemExit("a poll row's STALE session stamp spared the selected seat's real session: %r" % (spared,))
if "ghost" not in (agg.get("excluded_handles") or []):
    raise SystemExit("the spared poll seat lost its handle: %r" % (agg.get("excluded_handles"),))
CHK
grep -qx "demo/grok" "$KILL_LOG"   || fail "(8l) the selected session was not killed — a stale poll stamp protected it: $(tr '\n' ' ' <"$KILL_LOG")"
write_registry
echo "team-only-driven: (8l) a stale poll session stamp cannot spare a selected session: ok"

# (8c) self-last: a late unselected seat joining the CALLER's session must block
# the self kill. This is the arm whose absence let me conclude the self path was
# already safe — the earlier probe held the latecomer in a TEAMMATE session, so
# the defect on the other axis was never constructed (partner review).
write_registry
: > "$KILL_LOG"
LATE_ROW_JSON="$(mktemp)"
cat > "$LATE_ROW_JSON" <<'JSON'
{"latecomer": {"status":"active","delivery":"pane","pane":"demo/kimi:0.1","pane_id":"%197","harness":"claude","server_epoch":"srv:900:100","session":"demo/kimi"}}
JSON
rm -f "$LATE_ARMED_FLAG"
export LATE_ROW_JSON
rc=0
out="$("$TAP" team shutdown --yes --only grok,kimi </dev/null 2>&1)" || rc=$?
LATE_ROW_JSON=""; export LATE_ROW_JSON
LATE_ARMED_FLAG="$(mktemp)"; rm -f "$LATE_ARMED_FLAG"; export LATE_ARMED_FLAG
LOCK_PROBE_LOG="$(mktemp)"; export LOCK_PROBE_LOG
INTERPOSE_ROW_JSON=""; export INTERPOSE_ROW_JSON
INTERPOSE_CORRUPT=""; export INTERPOSE_CORRUPT
SURVIVE_KILL=""; export SURVIVE_KILL
[ "$rc" = 0 ] || fail "(8c) shutdown --only exited $rc; out: $out"
grep -qx "demo/kimi" "$KILL_LOG" \
  && fail "(8c) killed the CALLER session after an unnamed seat joined it; out: $out"
case "$out" in
  *latecomer*) ;;
  *) fail "(8c) the self refusal must name the late co-tenant; out: $out" ;;
esac
python3 -B - "$TAP_HOME/registry.json" <<'CHK' || fail "(8c) the late unnamed row or the refused caller row was deleted; out: $out"
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("agents") or reg.get("seats") or {}
raise SystemExit(0 if ("latecomer" in agents and "kimi" in agents) else 1)
CHK
echo "team-only-driven: (8c) self-last refuses on a late co-tenant and keeps both rows: ok"

# (11) EVERY kill happens with registry.lock HELD.
# This is the deterministic replacement for a post-receipt race arm: rather than
# trying to inject into a window, assert the window does not exist. The mock
# probes the sidecar non-blocking at each kill — if it can ACQUIRE the lock, the
# kill is running outside the critical section, which is the TOCTOU shape itself
# (partner review asked for exactly this assertion).
write_registry
: > "$KILL_LOG"; : > "$LOCK_PROBE_LOG"
rc=0
out="$("$TAP" team down --yes --only grok,kimi </dev/null 2>&1)" || rc=$?
[ "$rc" = 0 ] || fail "(11) team down --only exited $rc; out: $out"
[ -s "$LOCK_PROBE_LOG" ] || fail "(11) no kill was probed — the arm would be vacuous"
if grep -q "FREE" "$LOCK_PROBE_LOG"; then
  fail "(11) a kill ran with registry.lock FREE (outside the critical section): $(tr '\n' ' ' <"$LOCK_PROBE_LOG")"
fi
# The caller's own session must be among the probed kills, or this arm would
# prove the property only for teammates.
grep -q "demo/kimi HELD" "$LOCK_PROBE_LOG" \
  || fail "(11) the SELF kill was not observed holding the lock: $(tr '\n' ' ' <"$LOCK_PROBE_LOG")"
echo "team-only-driven: (11) every kill, including self, runs with the lock held: ok"

# (14) END-TO-END capture failure through the real verb. 13a calls the clear
# helper directly, so mutating the CALL SITE's error handling to `|| true` left
# it green — it proved the helper, not the parent's response (partner review). This
# drives `tap team shutdown` with an unwritable recovery directory and asserts
# what the operator actually gets.
write_registry
: > "$KILL_LOG"
_ro_home="$(mktemp -d)"
mkdir -p "$_ro_home/payloads" "$_ro_home/receipts"
cp "$TAP_HOME/registry.json" "$_ro_home/registry.json"
mkdir -p "$_ro_home/recovery"
# tap-g7nt: a permission fault does not fail under UID 0 (CAP_DAC_OVERRIDE),
# so the required capture failure is induced STRUCTURALLY: recovery becomes a
# regular FILE, and every allocation/write beneath that path raises ENOTDIR
# for root and non-root alike. Restored to a directory after the run — the
# structural analog of the chmod 700 this replaced.
rmdir "${_ro_home:?}/recovery"; : > "${_ro_home:?}/recovery"
rc=0
out="$(TAP_HOME="$_ro_home" "$TAP" team shutdown --yes --json --only grok,kimi </dev/null 2>&1)" || rc=$?
rm -f "${_ro_home:?}/recovery"; mkdir -p "${_ro_home:?}/recovery"
[ "$rc" != 0 ] || fail "(14) a capture failure must exit nonzero; out: $out"
grep -qx "demo/kimi" "$KILL_LOG" \
  && fail "(14) the caller was killed despite having no recovery state; out: $out"
[ -f "$_ro_home/registry.json" ] \
  || fail "(14) the registry was DELETED though capture failed; out: $out"
# Under --json this is a FAILURE and must obey the failure contract: one
# ok:false object on stdout with an error_class and an action, nothing on stderr
# (CONTRACT). A warning plus a success-shaped aggregate broke it both ways.
_o14="$(mktemp)"; _e14="$(mktemp)"
cp "$TAP_HOME/registry.json" "$_ro_home/registry.json"
# Re-arm the KILL LOG too, not just the registry. The mock reports a session
# named in the log as already gone, so on this second invocation demo/grok was
# classified REFUSED rather than stopped — which is why the detail read
# "already stopped: [none]" and the identities promise below could never have
# been exercised. Restoring one piece of fixture state and not the other makes
# the second run a different scenario than the first.
: > "$KILL_LOG"
rmdir "${_ro_home:?}/recovery"; : > "${_ro_home:?}/recovery"   # re-arm: the first probe restored it
rc=0
TAP_HOME="$_ro_home" "$TAP" team shutdown --yes --json --only grok,kimi </dev/null >"$_o14" 2>"$_e14" || rc=$?
rm -f "${_ro_home:?}/recovery"; mkdir -p "${_ro_home:?}/recovery"
[ "$rc" != 0 ] || fail "(14) the JSON failure path must exit nonzero"
[ ! -s "$_e14" ] || fail "(14) stderr must be empty under --json; got: $(cat "$_e14")"
python3 -B - "$(cat "$_o14")" <<'CHK' || fail "(14) not one ok:false object; stdout: $(cat "$_o14")"
import json, sys
obj = json.loads(sys.argv[1])
if obj.get("ok") is not False:
    raise SystemExit("ok is not false: %r" % (obj.get("ok"),))
if obj.get("error_class") != "recovery_unavailable":
    raise SystemExit("error_class: %r" % (obj.get("error_class"),))
if not obj.get("action"):
    raise SystemExit("no action given")
# CONTRACT promises the already-stopped seats by NAME. There are TWO
# recovery_unavailable sites — this one (allocation failed) and the clear-abort
# in (14b) — and a mutation reverting both to a bare count was caught by
# neither, because each arm asserted only the envelope. A number cannot be
# acted on: the operator has to know demo/grok is already down.
if "demo/grok" not in (obj.get("detail") or ""):
    raise SystemExit("detail names no stopped session: %r" % (obj.get("detail"),))
CHK
grep -qi "traceback" "$_o14" "$_e14" && fail "(14) a raw traceback reached the operator"
rm -f "$_o14" "$_e14"
rm -rf "$_ro_home"
echo "team-only-driven: (14) end-to-end capture failure: nonzero, partial receipt, registry kept: ok"
# (17b) deleted (U4B): same vacuous-hook class as (17) — its failed-restore
# injection was INTERPOSE_CORRUPT=file against the deleted engine's embedded
# python. Restore-failure semantics are pinned in team-stop.test.ts and the
# oracle's recovery cases.

echo "team-only-driven: ok"
