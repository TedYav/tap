#!/usr/bin/env bash
# A window park survives caller process-group cleanup and delivers without watch.
# Real park/spawn/waiter/drain, with only the recipient tmux surface simulated.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=0
export TAP_SPOOL_DISABLE_OPPORTUNISTIC=1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(cd "$(mktemp -d)" && pwd -P)"; FAKE_BIN="$WORK/bin"
owner_pid=""
trap '[ -z "$owner_pid" ] || { kill "$owner_pid" 2>/dev/null || true; wait "$owner_pid" 2>/dev/null || true; }; rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export XDG_CONFIG_HOME="$WORK/config"   # absolute, and deliberately empty
mkdir -p "$FAKE_BIN" "$WORK/tmux" "$WORK/repo" "$XDG_CONFIG_HOME" "$TAP_INDEX_HOME"
# File-pinned fixture: a live empty index proves the target is not enrolled.
printf '%s\n' '{"schema":"0.20","teams":{}}' > "$TAP_INDEX_HOME/global-registry.json"

cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
while [[ "${1:-}" == -L || "${1:-}" == -S ]]; do shift 2; done
# Stable ids and session addresses name the same composer.
args=()
for arg in "$@"; do
  [ "$arg" != %401 ] || arg=sess:0.0
  args+=("$arg")
done
set -- "${args[@]}"
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo probe >> "$state/mode-probes"; [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '› %s\n' "$(cat "$state/input.$key")"
    else printf '› \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"; exit 0
    fi
    # `never_clears` makes Enter leave the typed sentinel in the band, which is
    # precisely what tap_submit_verify reads to decide rc 5: it saw the text go
    # in and never saw it leave. Without this the mock always verifies and no arm
    # can reach the unverified path.
    if [ "${1:-}" = "Enter" ]; then
      [ -f "$state/never_clears" ] || rm -f "$state/input.$key"
      exit 0
    fi
    ;;
esac
TMUXMOCK
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" \
       FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

fail() { echo "delivery-window-drain: FAIL — $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }
export TAP_AUTOSETTLE_HOLD_SECONDS=4 TAP_SPOOL_DELIVERER_DELAYS="0.1 0.2 0.5"
python3 -B - "$ROOT" "$WORK" "$BUS" <<'PY2'
import json,os,pathlib,signal,subprocess,sys,time
root,work,bus=map(pathlib.Path,sys.argv[1:])
script=r'''set -euo pipefail
. "$1/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$1/skills/tap/scripts/smoke/canonical-place-fixture.sh"
. "$1/skills/tap/scripts/smoke/spool-park-placed-fixture.sh"
tap_ensure_dirs
mkdir -p "$TAP_HOME/delivery"
python3 -B - "$TAP_HOME/delivery/peer.json" <<'STAMP'
import json,sys,time
json.dump({"handle":"peer","last_delivered_at":int(time.time())},open(sys.argv[1],"w"))
STAMP
printf '%s\n' '---' '---' 'window owner control' > "$2/body.md"
canon="$TAP_HOME/payloads/window-owner.md"
canonical_place_fixture "$2/body.md" window-owner alice peer discuss "$canon" 0 expected t t >/dev/null
spool_park_placed_fixture window-owner "$canon" alice peer discuss expected sess:0.0 %401 t "$TAP_HOME/registry.json" window '' standard '' 0
: > "$2/parent-ready"
while :; do sleep .1; done
'''
with (work/'parent.log').open('w') as out:
 producer=subprocess.Popen(['bash','-c',script,'fixture',str(root),str(work)],env=os.environ,stdout=out,stderr=out,start_new_session=True)
 try:
  deadline=time.monotonic()+10
  while not (work/'parent-ready').exists() and producer.poll() is None and time.monotonic()<deadline: time.sleep(.02)
  assert (work/'parent-ready').exists(), (work/'parent.log').read_text()
  # Parent remains alive, reserving this private group ID. Simulate harness
  # cleanup after the command has published a park and reported acceptance.
  meta=json.loads((bus/'spool/window-owner.meta.json').read_text())
  due=float(meta['hold_until_epoch'])
  assert due>time.time(), ('fixture missed cooldown',meta,(bus/'delivery/peer.json').read_text(),time.time(),(work/'parent.log').read_text())
  os.killpg(producer.pid,signal.SIGTERM)
  producer.wait(timeout=5)
  deadline=time.monotonic()+max(0,due+30-time.time())
  while not (bus/'receipts/window-owner.sent').exists() and time.monotonic()<deadline: time.sleep(.05)
  assert (bus/'receipts/window-owner.sent').exists(), ('park did not deliver', (bus/'spool/window-owner.meta.json').read_text() if (bus/'spool/window-owner.meta.json').exists() else 'no meta', (bus/'tap-deliver.log').read_text(), list((bus/'spool').iterdir()), (work/'tmux/send-keys.log').read_text() if (work/'tmux/send-keys.log').exists() else 'no keys')
  print('verified seconds after cooldown:',round(time.time()-due,3))
  assert not (bus/'receipts/window-owner.done').exists(), 'delivery settled recipient work'
 finally:
  if producer.poll() is None:
   os.killpg(producer.pid,signal.SIGKILL); producer.wait(timeout=5)
  # End any surviving isolated waiter before scratch cleanup.
  (bus/'spool/window-owner.md').unlink(missing_ok=True)
  end=time.monotonic()+3
  while (bus/'spool/window-owner.meta.json.reown').exists() and time.monotonic()<end: time.sleep(.05)
print('window-park-owner: no watch, caller group ended, cooldown delivered')
PY2
