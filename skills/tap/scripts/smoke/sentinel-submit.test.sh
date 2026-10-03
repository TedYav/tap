#!/usr/bin/env bash
# File-backed terminal model; invoke through smoke-all --only.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index" TAP_TUI_SETTLE_SCALE=0.1
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
tap_ensure_dirs
id=gemini-20260101T000000Z-0123456789ab
sentinel="[[TAP v0.23 note ArchitectureAudit/$id]]"
width=140
accept_after=1
fixture_harness=codex
after_enter=clear
fixture_mode=idle
fixture_urgent=0
failures=0
bad() { echo "FAIL: $*"; failures=$((failures+1)); }
export WORK width fixture_harness fixture_mode after_enter accept_after
# The clobber door's Bun effects spawn the LITERAL tmux binary through PATH, so
# the mock is a PATH script, not a shell function (the shape other smokes use):
# every arm below exercises the same bytes whether the caller is lib.sh or the
# door. The exported fixture variables keep the per-row mutations visible.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'MOCK'
#!/usr/bin/env bash
set -u
WORK="${WORK:?}"
case "$1" in
  capture-pane)
    [ ! -f "$WORK/capture-fail" ] || exit 1
    if [ -f "$WORK/working-frame" ]; then
      printf '• Working (1s • esc to interrupt)\n'
      [ "$after_enter" != working-visible ] || cat "$WORK/input"
      exit 0
    fi
    python3 -B - "$WORK/input" "$width" "$fixture_harness" "$fixture_mode" <<'PY'
import sys
s=open(sys.argv[1]).read()
w=int(sys.argv[2])-2
agy=sys.argv[3]=='agy'
print('─'*int(sys.argv[2]) if agy else ('• Working (1s • esc to interrupt)\n' if sys.argv[4]=='mid-turn' else 'Worked for 1m 02s\n'))
# Codex renders continuation rows itself; these are hard lines even with -J.
print(('> ' if agy else '› ')+(s[:w] if s else ' '*w))
for i in range(w,len(s),w): print('  '+s[i:i+w])
if sys.argv[4]=='mid-turn': print('\n  tab to queue message')
print('─'*int(sys.argv[2])+'\n? for shortcuts' if agy else '\ngpt-6-astra high · Context 90% left · /tmp')
PY
    ;;
  display-message)
    case "${@: -1}" in
      *pane_in_mode*) echo 0 ;;
      *pane_width*) echo "$width" ;;
      # The Bun reader's 4-field compound (pane_id, session, pid, command).
      # Observed pane ids must satisfy the %digits grammar or the shell
      # registry-observation boundary refuses the record.
      *pane_id*pane_current_command*) printf '%%4242\tsess\t5242\t%s\t0\n' "$fixture_harness" ;;
      # lib.sh's own observe compound keeps its historical 3 fields.
      *pane_id*session_name*) printf '%%4242\tsess\t4242:100\n' ;;
      *pane_current_command*) echo "$fixture_harness" ;;
      *pane_id*) printf '%%4242\n' ;;
      # The server-identity probe (no target): pid:start_time.
      *'#{pid}:#{start_time}'*) printf '4242:100\n' ;;
      *) echo sess ;;
    esac ;;
  send-keys)
    case "${@: -1}" in
      Enter)
        n=$(( $(cat "$WORK/enters") + 1 )); echo "$n" > "$WORK/enters"
        if [ "$n" -ge "$accept_after" ]; then
          case "$after_enter" in
            clear) : > "$WORK/input" ;;
            draft) printf 'human draft' > "$WORK/input" ;;
            working-visible|working-empty) touch "$WORK/working-frame" ;;
            placeholder) printf '\033[2mAsk Codex to do anything\033[0m' > "$WORK/input" ;;
            plain-placeholder) printf 'Ask Codex to do anything' > "$WORK/input" ;;
            failed-capture) touch "$WORK/capture-fail" ;;
          esac
        fi ;;
      Tab) touch "$WORK/unexpected-tab" ;;
      C-u|BSpace) : > "$WORK/input" ;;
      *) case " $* " in *' -l '*) printf '%s' "${@: -1}" > "$WORK/input" ;; esac ;;
    esac ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"
# The wrapped-sentinel submit rows (codex/agy x note/digest/urgent/escalate x
# widths 140..50, Enter exhaustion, late draft, placeholder paint and Working
# frames) drove lib.sh tap_submit_verify, deleted with the Bash submitter; the
# native courier's staged loop is covered in runtime/bun/test.
# The empty Gemini composer still paints 67 spaces after submission. Its public
# pending-input probe must report empty so the next courier item is not held.
fixture_harness=agy; width=69; after_enter=clear
: > "$WORK/input"  # the composer a verified submission leaves behind
capture_pair_fixture() {
  local escaped plain
  escaped="$(tmux capture-pane -p -e -t %fixture; printf X)"; escaped="${escaped%X}"
  plain="$(tmux capture-pane -p -t %fixture; printf X)"; plain="${plain%X}"
  printf '%s\n%s%s' "$(printf '%s' "$escaped" | wc -c | tr -d ' ')" "$escaped" "$plain"
}
frame1="$( { capture_pair_fixture 2>/dev/null; rc=$?; printf 'X'; exit "$rc"; } )" || bad 'post-submit composer capture failed'
frame1="${frame1%X}"
frame2="$( { capture_pair_fixture 2>/dev/null; rc=$?; printf 'X'; exit "$rc"; } )" || bad 'post-submit composer second capture failed'
frame2="${frame2%X}"
record="$( { printf '%s' "$frame1" | TAP_PANE_FRAME2="$frame2" tap_bun_call pane-probe %fixture pane/cli.ts probe %fixture agy "$TAP_PENDING_INPUT_CAP_BYTES"; rc=$?; printf 'X'; exit "$rc"; } )" || bad 'native pane-probe failed'
record="${record%X}"
[ "${record%%$'\x1f'*}" = empty ] || bad 'padded post-submit composer was held as a draft'
[ "$failures" = 0 ]
