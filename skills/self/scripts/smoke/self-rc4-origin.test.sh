#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# self-rc4-origin.test.sh — tap-r49z: exit 4 out of `tap self` has TWO
# origins for synchronous goal/loop, and /self must not report one as the other.
# Claude compact now queues in its worker instead of returning these deferrals.
#
#   lock park   (courier.ts submitVerify wrapper, lock_busy): another submit
#               holds the pane-submit lock past TAP_PANE_SUBMIT_LOCK_TIMEOUT.
#               Transient contention — the remedy is to try again shortly.
#   no-prompt   (courier.ts submit body, band_busy): the pane shows no input
#               band to type into. The remedy is to wait for an idle prompt.
#
# self.sh (now `tap self`) translated EVERY rc 4 to the no-prompt sentence, so the sighting that
# opened the bead — a user-typed `/self compact` that parked twice under live
# subagent contention — told the operator to "retry when idle" about a pane that
# was idle. Wrong diagnosis, wrong remedy, and it sent the bead's first analysis
# down the deferred-arm branch for a path that may never have fired.
#
# WHAT THIS FILE ASSERTS, AND WHY IT ASSERTS THE MESSAGE: the fix carries a
# reason marker alongside rc 4 rather than a new exit code (rc 4 is the courier's
# documented defer -> spool contract). A test that asserted the marker VARIABLE
# would stay green if nothing ever consumed it — that is a rename, not a split.
# So every arm here asserts the operator-visible stderr sentence, which only a
# consumed marker can produce.
#
# SAFETY: mock tmux in a temp dir. This test NEVER targets a live agent pane.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
export TAP_TUI_SETTLE_SCALE=0.1
# The fixture registry binds `srv:fixture`; pin the observed generation to match.
export TAP_SERVER_EPOCH='srv:fixture'

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "self-rc4-origin: FAIL $*" >&2; exit 1; }

# `tap self` acts only for a registered seat: enroll one team whose seat is the mock pane.
TEAM_ROOT="$WORK/team"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
export TAP_REGISTRY="$TEAM_ROOT/.tap/team-registry.json"
export TAP_LOCK_DIR="$WORK/locks"
export TAP_PANE_SUBMIT_LOCK_TIMEOUT=1   # keep the park arm fast; production is 5
export FAKE_TMUX_STATE="$WORK/fake-tmux"
mkdir -p "$TAP_HOME" "$TAP_LOCK_DIR" "$FAKE_TMUX_STATE" "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$TEAM_ROOT" "$TAP_REGISTRY" <<'JSON'
import json, os, sys
global_path, root, registry = sys.argv[1:]
# Self-compaction now captures a durable witness before Enter, so the seat
# needs a bound native session and a transcript that names it; without them the
# refusal fires before either rc-4 origin is reachable.
transcript = os.path.join(root, "subject.jsonl")
with open(transcript, "w") as output:
    output.write(json.dumps({"type":"user", "sessionId":"subject-native"})+"\n")
json.dump({"schema":"0.20","teams":{"fixture":{"root":root,"registry_location":registry}}}, open(global_path,"w"))
json.dump({"schema":"0.20","team":{"name":"fixture","worktree_root":root},"seats":{"subject":{"status":"active","instance":"subject|1","pane":"fake-pane","pane_id":"%4242","session":"fixture","server_epoch":"srv:fixture","harness":"claude","harness_session_id":"subject-native","transcript_path":transcript}}}, open(registry,"w"))
JSON

# --- mock tmux ----------------------------------------------------------------
# Claude's box chrome is rendered deliberately: the band readers bound the input
# region on the bottom border, so a prompt-row-only mock exercises a different
# path than a real pane (tap-tx3s). FAKE_TMUX_NO_PROMPT paints the pane with no
# input band at all — that is the no-prompt arm's whole fixture.
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
cmd="$1"; shift
case "$cmd" in
  display-message)
    for arg in "$@"; do
      case "$arg" in
        # Composite observations first, before the bare pane_id pattern swallows them.
        *pane_id*session_name*pane_current_command*)
          printf '%%4242\tfixture\t4242\t%s\n' "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_id*session_name*) printf '%%4242\tfixture\t4242:100\n'; exit 0 ;;
        *start_time*) echo "4242:100"; exit 0 ;;
        *pane_id*) echo "%4242"; exit 0 ;;
        *pane_pid*) echo "4242"; exit 0 ;;
        *pane_current_command*) echo "${FAKE_TMUX_CMD:-claude}"; exit 0 ;;
        *pane_in_mode*) echo "0"; exit 0 ;;
      esac
    done
    echo ""
    ;;
  capture-pane)
    if [ "${FAKE_TMUX_NO_PROMPT:-}" = 1 ]; then
      # A modal pane: output, no input band. Nothing for a reader to find.
      printf 'Do you want to proceed?\n  1. Yes\n  2. No\n'
      exit 0
    fi
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "${FAKE_TMUX_PROMPT:-›}" "$(sed -n '1p' "$state/input")"
      sed -n '2,$p' "$state/input"
    else
      printf '%s \n' "${FAKE_TMUX_PROMPT:-›}"
    fi
    printf '%s\n' '──────────────────────────────────────────'
    printf '%s\n' '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0
    fi
    [ "${1:-}" = "C-u" ] && { rm -f "$state/input"; exit 0; }
    [ "${1:-}" = "Enter" ] && { rm -f "$state/input"; exit 0; }
    ;;
  run-shell) exit 0 ;;
esac
exit 0
TMUX
chmod +x "$BIN/tmux"
cat > "$BIN/ps" <<'PS'
#!/usr/bin/env bash
printf ' 4242 4242 4242 %s\n' "${FAKE_PS_ROOT:-claude}"
exit 0
PS
chmod +x "$BIN/ps"
export PATH="$BIN:$PATH"

PANE="fake-pane"
FOCUS='preserve the rc-4 origin split in runtime/bun/src/verbs/self.ts and its smoke'

run_self() { # -> RC, stderr in $WORK/err
  RC=0
  rm -f "$FAKE_TMUX_STATE/input"
  (cd "$TEAM_ROOT" && FAKE_TMUX_CMD=claude "$TAP" self loop --pane "$PANE" "$FOCUS") \
    >/dev/null 2>"$WORK/err" || RC="$?"
}

# --- (1) LOCK PARK is reported as lock contention, never as no-prompt ---------
# An external holder in its own process: same-process re-entry is granted by
# flock, so a fixture that "held" the lock in this shell would test nothing.
# tap self submits to the resolved pane id, which keys the pane-submit lock.
LOCKFILE="$(bun -e 'const { paneLockPath } = await import(process.argv[1]); process.stdout.write(paneLockPath("%4242"));' \
  "$ROOT/runtime/bun/src/panelock.ts")"
cat > "$WORK/holder.sh" <<'HOLDER'
exec 7>"$1"
python3 -B -c 'import fcntl; fcntl.flock(7, fcntl.LOCK_EX | fcntl.LOCK_NB)' || exit 9
printf 'held\n' > "$2"
exec sleep 30
HOLDER
: > "$LOCKFILE"
bash "$WORK/holder.sh" "$LOCKFILE" "$WORK/held.flag" & HOLDER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$WORK/held.flag" ] && break; sleep 0.2; done
[ -f "$WORK/held.flag" ] || fail "(1) fixture invalid: the external holder never took the lock"

run_self
[ "$RC" = 4 ] || fail "(1) expected exit 4 under a held pane-submit lock, got $RC ($(cat "$WORK/err"))"
grep -qi 'pane-submit lock' "$WORK/err" \
  || fail "(1) lock park is not named as a lock in self's own message: $(cat "$WORK/err")"
grep -qi 'no visible input prompt' "$WORK/err" \
  && fail "(1) lock park still reported as a no-prompt defer — rc 4 is still overloaded: $(cat "$WORK/err")"
grep -qi 'retry when idle' "$WORK/err" \
  && fail "(1) lock park still carries the no-prompt remedy 'retry when idle': $(cat "$WORK/err")"
# The remedies are the spec, not the nouns: a message that named the lock and then
# told the operator to wait for idle would satisfy every assertion above.
grep -qi 'retry shortly' "$WORK/err" \
  || fail "(1) lock park names the lock but never gives its remedy ('retry shortly'): $(cat "$WORK/err")"
echo "  (1) held lock -> self reports lock contention, not a no-prompt defer ok"

kill "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true

# --- (2) NO-PROMPT still reports no-prompt, with the idle remedy --------------
# The other half of the split: fixing arm (1) by deleting the no-prompt sentence
# would pass (1) and lose the true no-prompt diagnosis. This arm holds it.
RC=0
rm -f "$FAKE_TMUX_STATE/input"
(cd "$TEAM_ROOT" && FAKE_TMUX_NO_PROMPT=1 FAKE_TMUX_CMD=claude "$TAP" self loop --pane "$PANE" "$FOCUS") \
  >/dev/null 2>"$WORK/err2" || RC="$?"
[ "$RC" = 4 ] || fail "(2) expected exit 4 with no input band, got $RC ($(cat "$WORK/err2"))"
grep -qi 'no visible input prompt' "$WORK/err2" \
  || fail "(2) genuine no-prompt defer lost its diagnosis: $(cat "$WORK/err2")"
grep -qi 'pane-submit lock' "$WORK/err2" \
  && fail "(2) no-prompt defer misreported as lock contention: $(cat "$WORK/err2")"
# Symmetric to arm (1): the diagnosis without the matching remedy is half a split.
grep -qi 'retry when idle' "$WORK/err2" \
  || fail "(2) no-prompt defer lost its remedy ('retry when idle'): $(cat "$WORK/err2")"
grep -qi 'retry shortly' "$WORK/err2" \
  && fail "(2) no-prompt defer carries the LOCK remedy 'retry shortly' — the remedies crossed: $(cat "$WORK/err2")"
echo "  (2) no input band -> self still reports the no-prompt defer ok"

echo "self-rc4-origin: ok"
