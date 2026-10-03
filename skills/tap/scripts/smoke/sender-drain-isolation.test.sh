#!/usr/bin/env bash
# D5: fixture-door — the only remaining runtime/bun/src touch (:176) spawns the real spool-waiter.ts to take a lease and is then KILLED, building the dead-owner precondition the recovery arms assert against; the detached-deliverer subject arm is ported to runtime/bun/test/waiter-lifetime.test.ts.
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# Sender commands never advance another recipient; recovery has named owners.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_TUI_SETTLE_SCALE=0.1
export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_AUTOSETTLE_HOLD_SECONDS=0 TAP_SKIP_VERSION_BRIEFING=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/scripts/tap.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
owner_pid=""
cleanup() {
  if [ -n "$owner_pid" ]; then kill "$owner_pid" 2>/dev/null || true; wait "$owner_pid" 2>/dev/null || true; fi
  rm -rf "$WORK" "$FAKE_BIN"
}
trap cleanup EXIT

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
target=""; previous=""
for arg in "$@"; do [ "$previous" != -t ] || target="$arg"; previous="$arg"; done
case "$target" in
  sess:0.0|%401) pid=%401 ;;
  sess:0.1|%402) pid=%402 ;;
  sess:0.2|%403) pid=%403 ;;
  *) pid="${FAKE_PANE_ID:-%401}" ;;
esac
case "$cmd" in
  list-sessions)
    printf 'sess\t4242:100\n'
    ;;
  list-panes)
    count_file="$state/list-panes.count"
    count=0
    [ ! -f "$count_file" ] || count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
    pane_cmd="${FAKE_TMUX_CMD:-codex}"
    if [ -n "${FAKE_LIST_PANES_FLIP_AFTER:-}" ] \
       && [ "$count" -gt "$FAKE_LIST_PANES_FLIP_AFTER" ]; then
      pane_cmd="zsh"
    fi
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "$pane_cmd"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${pid}" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${pid}" "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${pid}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${pid}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *pid*start_time*)       echo "4242:100" ;;
      *)                      echo "" ;;
    esac ;;
  select-pane) echo "$*" >> "$state/tint.log" ;;
  capture-pane)
    echo "$target" >> "$state/probes.log"
    if [ -f "$state/busy.$pid" ]; then printf 'model is generating a response...\n'
    elif [ -f "$state/input.$pid" ]; then printf '❯ %s\n' "$(cat "$state/input.$pid")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    [ "${1:-}" = "-t" ] && shift 2
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then rm -f "$state/copy_mode"; exit 0; fi
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input.$pid"; exit 0 ;;
      C-u) rm -f "$state/input.$pid"; exit 0 ;;
      Enter)
        if [ "${FAKE_TMUX_STUCK_DIGEST_SUBMIT:-0}" = 1 ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$pid" 2>/dev/null; then
          exit 0
        fi
        rm -f "$state/input.$pid"
        exit 0
        ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
mkdir -p "$WORK/tmux" "$WORK/repo"

export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"; export TAP_HOME="$BUS"
REG="$BUS/registry.json"
cat > "$REG" <<JSON
{ "schema": "0.20",
  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":   { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice":  { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "bob":    { "session": "sess", "pane": "sess:0.2", "pane_id": "%403", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
# Born live: team t is enrolled at its bus registry, so registration has an acting store.
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' \
  "$(cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)" > "$WORK/index.live"
cp "$WORK/index.live" "$TAP_INDEX_HOME/global-registry.json"

PANE="sess:0.0"; PANE_ID="%401"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"; . "${LIB%/smoke/runtime-helpers.sh}/smoke/spool-park-fixture.sh"; . "${LIB%/smoke/runtime-helpers.sh}/smoke/canonical-place-fixture.sh"
tap_ensure_dirs

fail() { echo "sender-drain-isolation: $*" >&2; exit 1; }
park() { # <id> <target> <pane> <pane_id> [target_registry] [to_team]
  local canon src
  src="$WORK/$1.src"
  printf '%s\n' '---' '---' "body $1" > "$src"
  canon="${TAP_PAYLOADS}/$1.md"
  canonical_place_fixture "$src" "$1" bob "$2" discuss "$canon" 0 expected t "${6:-t}" >/dev/null
  spool_park_fixture "$1" "$canon" "$2" t no-input-prompt busy 600 "$3" "$4" "${6:-t}" standard "" "${5:-$REG}" >/dev/null
  rm -f "$canon"
}

# B is ready and has deliverable mail. A stranger's successful send to A must
# neither probe B's composer nor submit B's queued payload.
park peer-queued peer sess:0.0 %401
: > "$WORK/tmux/send-keys.log"; : > "$WORK/tmux/probes.log"
FAKE_PANE_ID=%402 "$TAPSH" send alice -m "for A" --from bob --id to-alice --ask >"$WORK/send.out" 2>&1 || { cat "$WORK/send.out" >&2; fail "send to A failed"; }
[ -f "$BUS/receipts/to-alice.sent" ] || fail "send to A did not submit"
[ -f "$BUS/spool/peer-queued.md" ] && [ ! -f "$BUS/receipts/peer-queued.sent" ] || fail "send to A advanced B's queued message"
! grep -Eq 'sess:0\.0|%401' "$WORK/tmux/probes.log" || fail "send to A probed B's composer"
echo 'sender-drain-isolation: stranger send leaves B untouched'

# Unrelated parked mail must not force the ordinary send back through Bash.
: > "$WORK/bun.trace"; : > "$WORK/tmux/probes.log"
TAP_BUN_ROUTE_TRACE="$WORK/bun.trace" bun "$ROOT/runtime/bun/main.ts" send alice -m "Bun door to A" --from bob --ask >"$WORK/bun-send.out" 2>&1 || { cat "$WORK/bun-send.out" >&2; fail 'Bun send failed'; }
[ "$(cat "$WORK/bun.trace")" = 'native send' ] || fail 'ordinary send delegated because of unrelated spool'
[ -f "$BUS/spool/peer-queued.md" ] && [ ! -f "$BUS/receipts/peer-queued.sent" ] || fail "Bun send advanced B's queued message"
! grep -Eq 'sess:0\.0|%401' "$WORK/tmux/probes.log" || fail "Bun send probed B's composer"


# An absent machine index refuses reply by name: it settles nothing and
# leaves B untouched. The enrolled marker comes back after the arm.
rm "${TAP_INDEX_HOME:?}/global-registry.json"
src="$WORK/inbound.src"; printf '%s\n' '---' '---' 'answer requested' > "$src"
canonical_place_fixture "$src" inbound-for-bob alice bob discuss "${TAP_PAYLOADS}/inbound-for-bob.md" 0 expected t t >/dev/null
: > "$WORK/tmux/probes.log"
rc=0; bun "$ROOT/runtime/bun/main.ts" reply inbound-for-bob -m "answer for A" --by bob >"$WORK/reply.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$WORK/reply.out" >&2; fail "absent-marker reply exited $rc, expected the named refusal"; }
grep -q 'this machine has no enrolled team' "$WORK/reply.out" || { cat "$WORK/reply.out" >&2; fail 'absent-marker reply did not name its refusal'; }
[ ! -f "$BUS/receipts/inbound-for-bob.done" ] || fail 'refused reply settled its inbound'
[ -f "$BUS/spool/peer-queued.md" ] && [ ! -f "$BUS/receipts/peer-queued.sent" ] || fail "refused reply advanced B"
! grep -Eq 'sess:0\.0|%401' "$WORK/tmux/probes.log" || fail "refused reply probed B's composer"
cp "$WORK/index.live" "$TAP_INDEX_HOME/global-registry.json"

# Registration leaves mail with delivery owners; explicit poll/read recovers
# a recipient's parked mail when its waiter is dead and watch is off.
# Simulate a dead recovery owner using its exact child PID, not a process census.
touch "$WORK/tmux/busy.%401"
TAP_SPOOL_DELIVERER_DELAYS=0.1 bun "$ROOT/runtime/bun/src/spool-waiter.ts" peer-queued >"$WORK/dead-owner.log" 2>&1 &
owner_pid=$!
for _ in $(seq 100); do [ -f "$BUS/spool/peer-queued.meta.json.reown" ] && break; sleep 0.05; done
[ -f "$BUS/spool/peer-queued.meta.json.reown" ] || { cat "$WORK/dead-owner.log" >&2; fail 'detached owner did not take its lease'; }
kill "$owner_pid"; wait "$owner_pid" 2>/dev/null || true; owner_pid=""
rm -f "$WORK/tmux/busy.%401"
[ -f "$BUS/spool/peer-queued.md" ] || fail 'held owner consumed B before recovery'
park alice-queued alice sess:0.1 %402
# The same handle on another target registry is a different recipient.
mkdir -p "$WORK/foreign"
python3 -B - "$REG" "$WORK/foreign/registry.json" "$WORK/foreign" <<'FOREIGN'
import json,sys
old=json.load(open(sys.argv[1])); seat=old['seats']['bob']
seat['registered_from_worktree']=sys.argv[3]
json.dump({'schema':'0.20','team':{'name':'foreign','worktree_root':sys.argv[3]},'seats':{'peer':seat}},open(sys.argv[2],'w'))
FOREIGN
park peer-foreign peer sess:0.2 %403 "$WORK/foreign/registry.json" foreign
cp "$BUS/spool/peer-foreign.meta.json" "$WORK/foreign-before.json"
: > "$WORK/tmux/probes.log"
(cd "$WORK/repo"; TMUX_PANE=%401 FAKE_PANE_ID=%401 "$TAPSH" register peer --pane sess:0.0) >"$WORK/register.out" 2>&1 || { cat "$WORK/register.out" >&2; fail 'register B failed'; }
[ -f "$BUS/spool/peer-queued.md" ] && [ ! -f "$BUS/receipts/peer-queued.sent" ] || { cat "$WORK/register.out" >&2; fail 'register B drained mail inline'; }
[ -f "$BUS/spool/alice-queued.md" ] && [ ! -f "$BUS/receipts/alice-queued.sent" ] || fail "register B advanced A's backlog"
! grep -Eq 'sess:0\.1|%402' "$WORK/tmux/probes.log" || fail "register B probed A's composer"
[ -f "$BUS/spool/peer-foreign.md" ] && [ ! -f "$BUS/receipts/peer-foreign.sent" ] || fail 'register B advanced a same-named foreign recipient'
cmp -s "$WORK/foreign-before.json" "$BUS/spool/peer-foreign.meta.json" || fail 'register B changed foreign metadata'
! grep -Eq 'sess:0\.2|%403' "$WORK/tmux/probes.log" || fail 'register B probed the same-named foreign recipient'
set +e
TMUX_PANE=%401 FAKE_PANE_ID=%401 "$TAPSH" poll peer >"$WORK/peer-poll.out" 2>&1
poll_rc=$?
set -e
[ "$poll_rc" -eq 2 ] && grep -q 'peer-queued' "$WORK/peer-poll.out" || { cat "$WORK/peer-poll.out" >&2; fail 'recipient poll did not expose parked mail'; }
TMUX_PANE=%401 FAKE_PANE_ID=%401 "$TAPSH" read peer-queued --by peer >"$WORK/peer-read.out" 2>&1 || { cat "$WORK/peer-read.out" >&2; fail 'recipient read did not recover parked mail'; }
[ -f "$BUS/payloads/peer-queued.md" ] && [ ! -f "$BUS/spool/peer-queued.md" ] || fail 'recipient read did not transfer parked custody'
echo 'sender-drain-isolation: send/reply/register leave mail untouched; recipient poll/read recovers it'

# The detached owner moved to Bun: runtime/bun/test/waiter-lifetime.test.ts
# ("the detached deliverer alone advances a ready entry to verified delivery")
# spawns and joins the same production spool-waiter.ts over a plain ready park
# with an empty band — no sender verb, no register, no drain call.

# With neither owner nor registration, the existing watch tick is the fallback.
park peer-watch peer sess:0.0 %401
"$TAPSH" watch on --by bob -m "fixture done when peer-watch is sent" --evaluator none --threshold 1500 --no-spawn >"$WORK/watch-arm.out" 2>&1 || { cat "$WORK/watch-arm.out" >&2; fail 'watch arm failed'; }
"$TAPSH" watch tick >"$WORK/watch-tick.out" 2>&1 || { cat "$WORK/watch-tick.out" >&2; fail 'watch tick failed'; }
[ -f "$BUS/receipts/peer-watch.sent" ] && [ ! -f "$BUS/spool/peer-watch.md" ] || { cat "$WORK/watch-tick.out" >&2; fail 'watch tick did not advance B'; }
# Disarm authority is the calling pane, and this fixture has no pane for 'bob': the loud escape is the way out.
"$TAPSH" watch off --force >"$WORK/watch-off.out" 2>&1 || { cat "$WORK/watch-off.out" >&2; fail 'watch disarm failed'; }
echo 'sender-drain-isolation: recipient poll/read and watch tick recover mail'
