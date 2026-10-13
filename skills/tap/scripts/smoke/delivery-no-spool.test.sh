#!/usr/bin/env bash
# Explicit direct delivery bypasses windows, preserves positive holds, and never reparks.
# Run through smoke-all --only: all bus, registry, and pane state is isolated.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1 TAP_TUI_SETTLE_SCALE=0.1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(cd "$(mktemp -d)" && pwd -P)"; FAKE_BIN="$WORK/bin"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
export XDG_CONFIG_HOME="$WORK/config"   # absolute, and deliberately empty
mkdir -p "$FAKE_BIN" "$WORK/tmux" "$WORK/repo" "$XDG_CONFIG_HOME"

cat > "$FAKE_BIN/tmux" <<'TMUXMOCK'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
# tmux resolves numeric pane ids and session addresses to the same input band.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
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
    if [ -f "$state/late_draft" ]; then
      count=0; [ ! -f "$state/captures" ] || count="$(cat "$state/captures")"
      count=$((count + 1)); printf '%s' "$count" > "$state/captures"
      [ "$count" -lt 2 ] || printf 'late human draft' > "$state/input.$key"
    fi
    if [ -f "$state/splash" ]; then
      cat "${FAKE_OPENCODE_SPLASH:?}"
    elif [ -f "$state/modal" ]; then
      printf '────────────────────────────────────────
>
────────────────────────────────────────
Requesting permission for: command
Do you want to proceed?
'
    elif [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    elif [ -f "$state/no_band" ]; then printf 'model is generating a response...\n'
    else printf '❯ \n'; fi ;;
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

fail() { echo "delivery-no-spool: FAIL — $*" >&2; exit 1; }
reset() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/* "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* \
         "$BUS/spool"/*.claim "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  : > "$WORK/tmux/send-keys.log"
  rm -f "$WORK"/tmux/input.* "$WORK/tmux/no_band" "$WORK/tmux/never_clears" "$WORK/tmux/copy_mode" "$WORK/tmux/modal" "$WORK/tmux/late_draft" "$WORK/tmux/captures" "$BUS/clear-fence/peer.json"
  cp "$WORK/registry.initial.json" "$BUS/registry.json"
  rm -f "$WORK/tmux/splash"
  export FAKE_TMUX_CMD=codex FAKE_PANE_ID=%401
}
send() { TAP_AUTOSETTLE_HOLD_SECONDS="$1" bash "$TAPSH" send "${@:2}"; }

cp "$BUS/registry.json" "$WORK/registry.initial.json"

reset
send 600 peer -m "direct quiet note" --id direct --from alice --no-spool >"$WORK/out" 2>&1 \
  || { cat "$WORK/out" >&2; fail "--no-spool must parse and deliver to a ready pane"; }
[ -f "$BUS/receipts/direct.sent" ] || fail "direct note has no verified receipt"
[ ! -f "$BUS/spool/direct.meta.json" ] || fail "direct note was spooled"
[ ! -f "$BUS/receipts/direct.done" ] || fail "direct note falsely courier-settled without a digest"
grep -F '[[TAP v0.23 note direct]]' "$WORK/tmux/send-keys.log" >/dev/null || fail "direct settle-only sentinel is not a note"
rc=0; bash "$TAPSH" outstanding alice > "$WORK/outstanding-direct" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "outstanding exited $rc reading the direct note's settlement obligation"
grep -F 'recipient-settled note; tap read by the recipient settles it' "$WORK/outstanding-direct" >/dev/null || fail "direct note missing its settlement hint"
bash "$TAPSH" read direct --by peer > "$WORK/read-direct" 2>&1 || { cat "$WORK/read-direct" >&2; fail "recipient could not read direct note"; }
[ -f "$BUS/receipts/direct.done" ] || fail "recipient read did not settle direct note"

echo 'delivery-no-spool: ready direct note delivered without a spool or false settlement'

# A ready arrival can overtake a parked sibling without draining or settling it.
printf human-draft > "$WORK/tmux/input.sess_0_0"
send 600 peer -m "queued sibling" --id batch-sibling --from alice --ask >/dev/null 2>&1 || fail "sibling park failed"
cp "$BUS/spool/batch-sibling.md" "$WORK/sibling-before.md"
cp "$BUS/spool/batch-sibling.meta.json" "$WORK/sibling-before.meta.json"
rm -f "$WORK/tmux/input.sess_0_0"
# Draft gone: production's waiter releases the pane hold before the next
# arrival (two bare samples >=250 ms apart delete the record under
# "$TAP_INDEX_HOME/input-protection"); the fake clock cannot expire the
# real-clock grace, so simulate that release outcome. The parked sibling's
# custody bytes are untouched.
rm -rf "${TAP_INDEX_HOME:?}/input-protection"
TAP_VERBOSE=1 send 600 peer -m "ready arrival" --id ready-arrival --from alice --ask >"$WORK/arrival-out" 2>&1 || fail "ready arrival was not accepted"
[ -f "$BUS/receipts/ready-arrival.sent" ] || fail "ready arrival was not verified"
[ -f "$BUS/payloads/ready-arrival.md" ] || fail "ready arrival lost its canonical body"
[ ! -f "$BUS/spool/ready-arrival.md" ] && [ ! -f "$BUS/spool/ready-arrival.meta.json" ] || fail "older sibling delayed the ready arrival"
grep -F 'ready-arrival' "$WORK/tmux/send-keys.log" >/dev/null || fail "ready arrival was not injected"
cmp -s "$BUS/spool/batch-sibling.md" "$WORK/sibling-before.md" || fail "ready send changed the parked body"
cmp -s "$BUS/spool/batch-sibling.meta.json" "$WORK/sibling-before.meta.json" || fail "ready send changed parked custody"
[ ! -f "$BUS/receipts/batch-sibling.sent" ] && [ ! -f "$BUS/receipts/batch-sibling.done" ] || fail "ready send delivered or settled the older sibling"
rc=0; bash "$TAPSH" outstanding alice >"$WORK/arrival-outstanding" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "outstanding exited $rc reading the ready arrival's reply obligation"
grep -F 'ready-arrival' "$WORK/arrival-outstanding" >/dev/null || fail "ready arrival not outstanding"
grep -F 'batch-sibling' "$WORK/arrival-outstanding" >/dev/null || fail "older parked sibling not outstanding"


# A delivery inside the shared window still attempts directly and resets the clock.
send 600 peer -m "second direct" --id direct-window --from alice --no-spool >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail "recent window blocked direct delivery"; }
[ -f "$BUS/receipts/direct-window.sent" ] || fail "in-window direct send not verified"
[ ! -f "$BUS/spool/direct-window.meta.json" ] || fail "in-window direct send parked"
if grep -Eq 'Escape|C-u|-X cancel' "$WORK/tmux/send-keys.log"; then fail "direct delivery used cancellation keys"; fi

# AMBIGUOUS no-band is the escape hatch; the ordinary class still parks there.
reset
touch "$WORK/tmux/no_band"
TAP_VERBOSE=1 send 0 peer -m "ordinary no band" --id normal-no-band --from alice --ask >"$WORK/out" 2>&1 || fail "ordinary no-band send was not accepted"
[ -f "$BUS/spool/normal-no-band.meta.json" ] || fail "ordinary no-band control did not park"
grep -F 'Delivery not confirmed. Inspect with tap show normal-no-band; if it is still unread, tap resend normal-no-band rings it again under the same id.' "$WORK/out" >/dev/null || fail "queued send lacks ratified sender status"
rc=0; bash "$TAPSH" outstanding alice > "$WORK/outstanding" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "outstanding exited $rc reading the parked send"
grep -F 'Delivery not confirmed. Inspect with tap show normal-no-band; if it is still unread, tap resend normal-no-band rings it again under the same id.' "$WORK/outstanding" >/dev/null || fail "outstanding lacks actual-id sender recovery"
grep -F '[hold]' "$WORK/out" >/dev/null || fail "send did not name the no-band hold"
grep -F '[hold]' "$WORK/outstanding" >/dev/null || fail "outstanding did not name the no-band hold"
# Auto-settlement is orthogonal to readiness: a note can be held before its digest.
TAP_VERBOSE=1 send 600 peer -m "held digest note" --id held-note --from alice >"$WORK/held-note-out" 2>&1 || fail "held note was refused"
grep -F '[hold]' "$WORK/held-note-out" >/dev/null || fail "send confused a held note with a batch"
rc=0; bash "$TAPSH" outstanding alice >"$WORK/held-note-outstanding" 2>&1 || rc=$?
grep -F 'if it is still unread, tap resend held-note rings it again under the same id. [hold]' "$WORK/held-note-outstanding" >/dev/null || fail "outstanding confused settlement policy with readiness"

if grep -F 'will not arrive' "$WORK/outstanding" "$WORK/out"; then fail "held send claimed permanent non-delivery"; fi
direct_rc=0
send 600 peer -m "direct no band" --id direct-no-band --from alice --no-spool >"$WORK/out" 2>&1 || direct_rc=$?
# Default-deny (tap-rlebf.1): no rule classifies this frame, so it may be a prompt
# TAP cannot see. The explicit attempt holds: refused, nothing typed, nothing queued.
# (A classified frame whose band is unreadable still takes the one attempt; the Bun
# send-delivery-no-spool rows cover that arm.)
[ "$direct_rc" = 1 ] || { cat "$WORK/out" >&2; fail "unclassified no-band frame did not refuse the direct attempt"; }
grep -F 'direct-no-band' "$WORK/tmux/send-keys.log" >/dev/null && fail "unclassified frame was typed into"
[ ! -f "$BUS/payloads/direct-no-band.md" ] || fail "refused direct attempt kept a canonical payload"
[ ! -f "$BUS/receipts/direct-no-band.sent" ] || fail "refused direct attempt claimed delivery"
[ ! -f "$BUS/spool/direct-no-band.meta.json" ] || fail "refused direct send parked"
[ -f "$BUS/spool/normal-no-band.meta.json" ] || fail "direct send drained unrelated queued mail"
# Make the older message ready. Sender commands leave it to the recovery
# owners, while this direct attempt still delivers its own message.
rm -f "$WORK/tmux/no_band"
send 600 peer -m "direct with ready backlog" --id direct-backlog --from alice --no-spool >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail "direct backlog attempt failed"; }
[ -f "$BUS/spool/normal-no-band.meta.json" ] && [ ! -f "$BUS/receipts/normal-no-band.sent" ] || fail "--no-spool advanced ready backlog through opportunistic drain"
[ -f "$BUS/receipts/direct-backlog.sent" ] || fail "direct send did not bypass the ready backlog"


refused() {
  local ident="$1"; shift
  local rc=0
  send 0 peer -m "refusal control" --id "$ident" --from alice --no-spool "$@" >"$WORK/out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || { cat "$WORK/out" >&2; fail "$ident unexpectedly accepted"; }
  [ ! -f "$BUS/spool/$ident.meta.json" ] && [ ! -f "$BUS/spool/$ident.md" ] || fail "$ident created a deferred retry"
  [ ! -f "$BUS/payloads/$ident.md" ] && [ ! -f "$BUS/receipts/$ident.sent" ] || fail "$ident left a deliverable payload"
  [ ! -s "$WORK/tmux/send-keys.log" ] || { cat "$WORK/tmux/send-keys.log" >&2; fail "$ident touched the pane"; }
}
reset
printf 'human draft' > "$WORK/tmux/input.sess_0_0"
refused human-draft
[ "$(cat "$WORK/tmux/input.sess_0_0")" = 'human draft' ] || fail "human draft changed"
reset
touch "$WORK/tmux/late_draft"
refused late-human-draft
grep -F -- "draft-preserving delivery refuses pending human input" "$WORK/out" >/dev/null || fail "late draft did not reach the shared submit refusal"
[ "$(cat "$WORK/tmux/input.sess_0_0")" = 'late human draft' ] || fail "late human draft changed"
reset
touch "$WORK/tmux/copy_mode"
refused copy-mode
[ -f "$WORK/tmux/copy_mode" ] || fail "copy mode cancelled"
reset
mkdir -p "$BUS/clear-fence"
python3 -B - "$BUS/clear-fence/peer.json" <<'FENCE'
import json,sys,time
json.dump({"nonce":"direct-fence","since_epoch":time.time(),"since":"2099-01-01T00:00:00Z","pid":2147483646,"handle":"peer","harness":"codex","ceiling_seconds":45},open(sys.argv[1],"w"))
FENCE
refused clear-fence
reset
export FAKE_PANE_ID=%999
refused wrong-pane-identity
reset
export FAKE_TMUX_CMD=zsh
refused unsupported-shell
reset
export FAKE_TMUX_CMD=agy
python3 -B - "$BUS/registry.json" <<'AGY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for row in d['seats'].values(): row['harness']='agy'
json.dump(d,open(p,'w'))
AGY
touch "$WORK/tmux/modal"
refused permission-modal

# A positively named OpenCode startup hold wins over the ambiguous-band escape.
reset
export FAKE_TMUX_CMD=opencode
export FAKE_OPENCODE_SPLASH="$ROOT/skills/tap/scripts/smoke/fixtures/opencode-splash/constructed-splash.txt"
python3 -B - "$BUS/registry.json" <<'OPENCODE'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for row in d['seats'].values(): row['harness']='opencode'
json.dump(d,open(p,'w'))
OPENCODE
touch "$WORK/tmux/splash"
# Both renderings share the public refusal; neither may leave a pane effect or owner.
for render in human json; do
  direct_rc=0
  render_args=()
  [ "$render" != json ] || render_args=(--json)
  send 0 peer -m "booting direct control" --id "booting-$render" --from alice --no-spool "${render_args[@]}" >"$WORK/out" 2>&1 || direct_rc=$?
  [ "$direct_rc" = 1 ] || { cat "$WORK/out" >&2; fail "OpenCode startup must refuse publicly with exit1, got$direct_rc"; }
  grep -F 'booting' "$WORK/out" >/dev/null || fail "startup refusal did not name booting"
  grep -F 're-send when the recipient is ready' "$WORK/out" >/dev/null || fail "startup refusal did not tell the sender to retry when ready"
  if [ "$render" = json ]; then
    python3 -B - "$WORK/out" <<'REFUSAL'
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1]) if line.startswith('{')]
assert len(rows)==1, rows
assert rows[0]['ok'] is False and rows[0]['error_class']=='delivery_refused', rows
REFUSAL
  fi
  [ ! -s "$WORK/tmux/send-keys.log" ] || fail "startup direct send touched the pane"
  [ ! -f "$BUS/spool/booting-$render.md" ] && [ ! -f "$BUS/spool/booting-$render.meta.json" ] || fail "startup direct send was parked"
  [ ! -f "$BUS/payloads/booting-$render.md" ] && [ ! -f "$BUS/receipts/booting-$render.placed" ] && [ ! -f "$BUS/receipts/booting-$render.sent" ] || fail "startup refusal left a deliverable message or receipt"
done

# All contradictory spellings refuse before a pane effect.
for flag in --urgent --polite; do reset; refused conflict "$flag"; done
for delivery in interrupt polite; do reset; refused conflict --delivery "$delivery"; done

# A possible submit effect retains its canonical message for reading, never a retry.
reset
touch "$WORK/tmux/never_clears"
rc=0
send 0 peer -m "ambiguous submission" --id possible-effect --from alice --no-spool >"$WORK/out" 2>&1 || rc=$?
[ "$rc" = 5 ] || { cat "$WORK/out" >&2; fail "possible effect expected5, got$rc"; }
[ -f "$BUS/payloads/possible-effect.md" ] || fail "possible effect lost canonical message"
[ ! -f "$BUS/spool/possible-effect.md" ] && [ ! -f "$BUS/spool/possible-effect.meta.json" ] || fail "possible effect was reparked"
[ ! -f "$BUS/receipts/possible-effect.sent" ] || fail "ambiguous submit claimed verified"
[ "$(grep -c -- '-l --' "$WORK/tmux/send-keys.log")" = 1 ] || fail "possible effect retried its payload"
if grep -Eq 'Escape|C-u|-X cancel' "$WORK/tmux/send-keys.log"; then fail "ambiguous direct delivery used cancellation keys"; fi

grep -F 'injected; Enter unconfirmed (possible effect). If the sentinel is still staged, run tap nudge peer.' "$WORK/out" >/dev/null || fail "possible-effect sender status missing"
rc=0; bash "$TAPSH" outstanding alice > "$WORK/outstanding" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "outstanding exited $rc reading the possible-effect send"
grep -F 'possible-effect' "$WORK/outstanding" >/dev/null || fail "possible-effect send not outstanding"
grep -F 'injected; Enter unconfirmed (possible effect). If the sentinel is still staged, run tap nudge peer.' "$WORK/outstanding" >/dev/null || fail "canonical sender hint missing"
rc=0; bash "$TAPSH" poll peer > "$WORK/poll" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "poll exited $rc reading the possible-effect canonical"
grep -F 'possible-effect' "$WORK/poll" >/dev/null || fail "possible-effect canonical unavailable to recipient"
grep -F 'unconfirmed to your pane — reading it here counts' "$WORK/poll" >/dev/null || fail "recipient hint missing"
if grep -F 'tap resend' "$WORK/poll"; then fail "recipient told to execute sender verb"; fi

echo 'delivery-no-spool: direct windows/no-band, positive holds, conflicts, possible-effect retention and sender/recipient hints passed'
