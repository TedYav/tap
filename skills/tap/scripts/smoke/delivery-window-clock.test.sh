#!/usr/bin/env bash
# delivery-window-clock.test.sh — tap-7r3fn.20 U1+2. The window runs from the
# recipient's last VERIFIED delivery, and it is stamped once when the entry parks.
#
# This is the arm the bead exists for. Before this change the hold was
# `first_spooled_epoch + 300`: a note to a seat that had heard nothing for an
# hour still waited the full window, because the clock started when the SENDER
# acted. Measured on the live bus beforehand, mail delivered inside a digest had
# a p50 of 307s against 2.7s for mail injected directly.
#
# Existing parks retain their stamped delivery window across the .96 cutover.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1
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
cmd="$1"; shift
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    if [[ "${*: -1}" == *pane_tty* ]]; then printf '%%401\t/dev/faketty\n'; exit 0; fi
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}" ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*pane_tty*) printf '%s\t/dev/faketty\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*) case " $* " in *' sess:0.1 '*) echo '%402' ;; *) echo "${FAKE_PANE_ID:-%401}" ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *pid*start_time*)       echo "4242:100" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input.$key"; exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input.$key"; exit 0; fi
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
{ "schema": "0.20",
  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
# Born live: registration needs team t enrolled at its bus registry.
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' "$(cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)" > "$TAP_INDEX_HOME/global-registry.json"

fail() { echo "delivery-window-clock: FAIL — $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }
meta() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$BUS/spool/$1.meta.json" "$2"; }
clock() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["last_delivered_at"])
except Exception: print("")' "$BUS/delivery/peer.json"; }
reset() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/* "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* \
         "$BUS/spool"/*.claim "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  : > "$WORK/tmux/send-keys.log"; rm -f "$WORK"/tmux/input.*
}

# Materialize a pre-.96 window park. New bare delivery is covered separately;
# these controls retain the clock, immutable deadline and drain custody contracts.
legacy_park() (
  export TAP_AUTOSETTLE_HOLD_SECONDS="$1"; shift
  local to="$1" id='' from='' body='' reply=settle-only policy=autosettle reason=auto-settle; shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id) id="$2"; shift 2 ;;
      --from) from="$2"; shift 2 ;;
      -m) body="$2"; shift 2 ;;
      --ask) reply=expected; policy=standard; reason=window; shift ;;
      --polite) policy=polite; reason=polite; shift ;;
      *) echo "unknown legacy fixture argument: $1" >&2; return 1 ;;
    esac
  done
  . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"; . "$ROOT/skills/tap/scripts/smoke/spool-park-fixture.sh"; . "$ROOT/skills/tap/scripts/smoke/canonical-place-fixture.sh"
  tap_ensure_dirs
  local source="$WORK/legacy-$id.md" canon
  printf '%s\n' '---' '---' "$body" > "$source"
  canon="${TAP_PAYLOADS}/$id.md"
  canonical_place_fixture "$source" "$id" "$from" "$to" discuss "$canon" 0 "$reply" t t >/dev/null
  spool_park_fixture "$id" "$canon" "$to" t "$reason" "$reason" "" sess:0.0 %401 t "$policy" "" "$BUS/registry.json" >/dev/null
  rm -f "$canon"
)


W=120

# --- 1. a seat that has heard nothing: the first note is due immediately ------
reset
legacy_park "$W" peer -m "first" --id w1 --from alice >/dev/null 2>&1 || fail "(1) send failed"
[ -f "$BUS/spool/w1.meta.json" ] || fail "(1) the send did not park"
[ -z "$(clock)" ] || fail "(1) a parked send stamped the recipient clock; only a verified delivery may"
h1="$(meta w1 hold_until_epoch)"
[ -n "$h1" ] || fail "(1) the park carries no hold_until_epoch"
now="$(date +%s)"
[ "$h1" -le "$now" ] || fail "(1) hold_until_epoch is $((h1 - now))s in the future for a seat that has heard nothing; the first message after quiet is instant"
ok "a note to a quiet seat is due immediately, not held for the window"

# --- 2. within the window of a real delivery, the next note is held ----------
# THE WHOLE POINT: the epoch is anchored to the DELIVERY, not to this send.
reset
delivered=$(( $(date +%s) - 30 ))
mkdir -p "$BUS/delivery"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$delivered"
legacy_park "$W" peer -m "second" --id w2 --from alice >/dev/null 2>&1 || fail "(2) send failed"
h2="$(meta w2 hold_until_epoch)"
[ -n "$h2" ] || fail "(2) the park carries no hold_until_epoch"
[ "$h2" = "$((delivered + W))" ] \
  || fail "(2) hold_until_epoch is $h2, expected last_delivered + W = $((delivered + W)); the window must run from the delivery, not from this send"
ok "a note inside the window is held to last_delivered + W, anchored to the delivery"

# --- 3. the enqueue-started clock is gone ------------------------------------
# The pre-change formula was first_spooled_epoch + W. With a delivery 30s ago and
# a 120s window those two answers differ by exactly 30s, which is what makes this
# arm able to tell them apart at all.
first="$(meta w2 first_spooled_epoch)"
[ -n "$first" ] || fail "(3) no first_spooled_epoch to compare against"
[ "$h2" != "$((first + W))" ] \
  || fail "(3) hold_until_epoch equals first_spooled_epoch + W — the clock still starts at enqueue"
ok "hold_until_epoch is not first_spooled_epoch + W; the enqueue-started clock is gone"

# --- 4. stamped once: a later delivery does not push an armed park out -------
# The starvation invariant. If a park re-derived its epoch from the newest
# delivery, every message arriving during a batch would postpone that batch and a
# busy seat's mail would never land.
#
# WHAT THIS ARM ACTUALLY PROVES, WHICH IS NOT WHAT IT FIRST APPEARED TO. Removing
# the carry-forward branch in the native pair writer does NOT red it: that branch runs only
# when the same id is re-added, which the CLI refuses as `spooled_id`, so nothing
# here reaches it. The invariant these lines observe is stronger and structural —
# one writer, one id, and a refusal to re-add — and it would hold with the branch
# deleted. The branch stays as a helper-level guard, exactly like the
# `deadline_epoch` carry beside it that the code already labels unreachable from
# the CLI; arm 4c exercises it directly rather than letting this arm imply it.
later=$(( $(date +%s) - 1 ))
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$later"
h2b="$(meta w2 hold_until_epoch)"
[ "$h2b" = "$h2" ] || fail "(4) the armed epoch moved from $h2 to $h2b after a later delivery"
legacy_park "$W" peer -m "third" --id w3 --from alice >/dev/null 2>&1 || fail "(4) third send failed"
h2c="$(meta w2 hold_until_epoch)"
[ "$h2c" = "$h2" ] \
  || fail "(4) a NEW send to the same seat moved the armed entry's epoch from $h2 to $h2c; a batch must not be pushed out by later traffic"
h3="$(meta w3 hold_until_epoch)"
[ "$h3" = "$((later + W))" ] \
  || fail "(4) the new entry armed at $h3, expected the newest delivery + W = $((later + W))"
ok "an armed epoch is stamped once; later traffic arms new entries without moving it"

# --- 4b. an elapsed window stamps NOW, never a past epoch --------------------
# hold_until_epoch means "the earliest moment this may flush, as of arming", and
# that is never behind the arming. Without the clamp a delivery well outside the
# window stamps an epoch in the past; the entry is due either way, so only this
# arm distinguishes the two — and the invariant is worth keeping because the
# backward-clock rule reads this stamp and needs it bounded.
reset
long_ago=$(( $(date +%s) - 1000 ))
mkdir -p "$BUS/delivery"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$long_ago"
before_send="$(date +%s)"
legacy_park "$W" peer -m "stale" --id w5 --from alice >/dev/null 2>&1 || fail "(4b) send failed"
h5="$(meta w5 hold_until_epoch)"
now="$(date +%s)"
[ "$h5" != "$((long_ago + W))" ] \
  || fail "(4b) armed at last_delivered + W = $h5, which is $((now - h5))s in the PAST; an elapsed window must stamp now"
[ "$h5" -ge "$before_send" ] && [ "$h5" -le "$now" ] \
  || fail "(4b) armed at $h5, expected within send interval [$before_send, $now] for a delivery $((now - long_ago))s ago"
ok "a delivery outside the window stamps now, not a past epoch"

# --- 5. a polite send takes the long window, from the same clock -------------
reset
delivered=$(( $(date +%s) - 5 ))
mkdir -p "$BUS/delivery"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$delivered"
legacy_park "" peer -m "polite" --id w4 --from alice --polite >/dev/null 2>&1 || fail "(5) polite send failed"
[ "$(meta w4 policy)" = polite ] || fail "(5) the polite send parked as $(meta w4 policy)"
h4="$(meta w4 hold_until_epoch)"
[ "$h4" = "$((delivered + 60))" ] \
  || fail "(5) polite armed at $h4, expected last_delivered + 60 (the built-in long window) = $((delivered + 60))"
ok "polite takes the long window from the same clock; the seam does not reach it"

# --- 4c. the carry-forward branch, exercised where it is reachable ----------
# The pair writer (spool-publication.ts add) is the only writer of hold_until_epoch, and re-adding a spooled
# id is refused at the CLI — so this calls the helper directly, which is the only
# place the carry can happen. An entry whose epoch is already armed keeps it even
# when the recipient's clock has since moved a long way forward.
(
  # shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
  . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"; . "$ROOT/skills/tap/scripts/smoke/spool-park-fixture.sh"
  tap_ensure_dirs
  canon="$WORK/carry.md"
  printf -- '---\nid: carry1\nfrom: alice\nto: peer\nkind: discuss\nreply: settle-only\n---\nbody\n' > "$canon"
  armed=$(( $(date +%s) - 10 ))
  python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
    "$BUS/delivery/peer.json" "$armed"
  TAP_AUTOSETTLE_HOLD_SECONDS=120 spool_park_fixture carry1 "$canon" peer t "auto-settle" "" "" \
    "sess:0.0" "%401" t autosettle "" "$BUS/registry.json" >/dev/null
  first_arm="$(meta carry1 hold_until_epoch)"
  [ "$first_arm" = "$((armed + 120))" ] \
    || { echo "delivery-window-clock: FAIL — (4c) first arm is $first_arm, expected $((armed + 120))" >&2; exit 1; }
  # The clock jumps far forward, then the same id is added again.
  moved=$(( $(date +%s) + 600 ))
  python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
    "$BUS/delivery/peer.json" "$moved"
  TAP_AUTOSETTLE_HOLD_SECONDS=120 spool_park_fixture carry1 "$canon" peer t "auto-settle" "" "" \
    "sess:0.0" "%401" t autosettle "" "$BUS/registry.json" >/dev/null
  second="$(meta carry1 hold_until_epoch)"
  [ "$second" = "$first_arm" ] \
    || { echo "delivery-window-clock: FAIL — (4c) a re-add moved the armed epoch from $first_arm to $second; an armed batch must not be pushed out" >&2; exit 1; }
) || exit 1
ok "an already-armed epoch survives a re-add even when the clock jumped forward"

# Recipient declaration reuses the same arming/clock path (tap-20ao).
reset
REAL_PS="$(command -v ps)"; export REAL_PS
cat > "$FAKE_BIN/ps" <<'FAKEPS'
#!/usr/bin/env bash
case "$*" in *'ppid='*'tty='*) echo '1 faketty' ;; *) exec "$REAL_PS" "$@" ;; esac
FAKEPS
chmod +x "$FAKE_BIN/ps"
python3 -B - "$BUS/registry.json" <<'DECLAREPEER'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['seats']['alice']['pane_id']='%402'; d['seats']['alice']['pane']='sess:0.1'
open(p,'w').write(json.dumps(d))
DECLAREPEER
bash "$TAPSH" digest-window 600 >/dev/null || fail "recipient cannot declare a digest window"
roster="$("$ROOT/bin/tap" team --json)" || fail "team failed"
python3 -B - "$roster" <<'WINDOWJSON' || fail "team does not show effective windows"
import json,sys
rows={r['handle']:r for r in json.loads(sys.argv[1])['agents']}
assert rows['peer']['digest_window_seconds']==600 and rows['peer']['ask_window_seconds']==10, rows
assert rows['alice']['digest_window_seconds']==10 and rows['alice']['ask_window_seconds']==10, rows
WINDOWJSON
mkdir -p "$BUS/delivery"
anchor="$(date +%s)"
python3 -B -c 'import json,sys; json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' "$BUS/delivery/peer.json" "$anchor"
legacy_park "" peer -m note-one --id declared1 --from alice >/dev/null
legacy_park "" peer -m note-two --id declared2 --from alice >/dev/null
[ "$(meta declared1 hold_until_epoch)" = "$((anchor + 600))" ] || fail "declared note did not use 600s"
[ "$(meta declared2 hold_until_epoch)" = "$(meta declared1 hold_until_epoch)" ] || fail "notes do not share the declared boundary"
TAP_SPOOL_NOW="$((anchor + 600))" bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" > "$WORK/digest-drain.log" 2>&1 || { cat "$WORK/digest-drain.log"; fail "declared digest drain failed"; }
[ -f "$BUS/payloads/declared1.md" ] && [ -f "$BUS/payloads/declared2.md" ] && [ ! -f "$BUS/receipts/declared1.done" ] && [ ! -f "$BUS/receipts/declared2.done" ] || { cat "$WORK/digest-drain.log"; fail "declared notes did not coalesce into a delivered digest"; }
python3 -B - "$BUS/spool/digests" <<'ONEBATCH' || fail "declared notes did not share one digest"
import json,pathlib,sys
indexes=list(pathlib.Path(sys.argv[1]).glob('*.json'))
assert len(indexes)==1, indexes
assert json.load(open(indexes[0])).get('injected_at_epoch'), indexes
assert {item['id'] for item in json.load(open(indexes[0]))['items']}=={'declared1','declared2'}
ONEBATCH
anchor="$(date +%s)"
# This block tests configuration, not how quickly the host runs its commands.
# The urgent verified send below restamps the clock; keep it on this same epoch.
export TAP_SPOOL_NOW="$anchor"
python3 -B -c 'import json,sys; json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' "$BUS/delivery/peer.json" "$anchor"
legacy_park "" peer --ask -m question --id declaredask --from alice >/dev/null
[ "$(meta declaredask hold_until_epoch)" = "$((anchor + 10))" ] || fail "asks inherited notes-only window"
bash "$TAPSH" digest-window 600 --include-asks >/dev/null
legacy_park "" peer --ask -m included --id includedask --from alice >/dev/null
[ "$(meta includedask hold_until_epoch)" = "$((anchor + 600))" ] || fail "ask opt-in not honored"
TAP_AUTOSETTLE_HOLD_SECONDS= bash "$TAPSH" send peer --urgent -m interrupt --id urgentdeclared --from alice >/dev/null || fail "urgent send failed"
[ ! -f "$BUS/spool/urgentdeclared.meta.json" ] || fail "urgent message used declared window"
bash "$TAPSH" digest-window off >/dev/null
# BRACKET THE PARK, DO NOT ASSUME IT IS INSTANT (tap-6qiti.2). `hold_until_epoch`
# is `max(now, last_delivered + window)`, so the old `== anchor + 10` equality was
# also asserting that everything between `anchor` and this park — two sends, a
# digest-window write and an urgent send — finished inside the 10s window. Under
# load it does not: measured `hold=anchor+28` on a box at load 71, and the arm
# then reported a wrong-looking WINDOW while the window was correct. Bracketing by
# the park's own observed interval states that premise instead of hiding it, and
# still fails a genuinely wrong window: with the 600s declaration left active the
# bracket reds here, because 600 puts the hold far above `after_park`.
# TWO ASSERTIONS, BECAUSE ONE CANNOT DO BOTH JOBS (chatgpt-codex-connector on
# this PR). The bracket below proves the CLOCK behaviour, and under load it
# stops proving the CONFIGURATION: once `before_park` passes `anchor + 10`, a
# hold of `max(park_now, anchor + W)` equals `park_now` for every W whose
# endpoint has already elapsed, so an under-restored window of 0 or 5 seconds
# lands inside the bracket and passes. The over-restored 600 is still caught,
# which is what made the gap easy to miss. Resolve the effective window
# directly — no clock in it at all — and the restored default is proved at any
# load.
_restored_window="$(
  . "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
  . "$ROOT/skills/tap/scripts/smoke/native-authority-fixture.sh"
  t="$(spool_team_fixture)" || exit 1
  [ -n "$t" ] || exit 1
  tap_bun_call digest-window peer ../test/support/delivery-window-cli.ts standard "$t" peer expected "$t"
)" || fail "could not resolve the enrolled team and its restored window"
[ "$_restored_window" = 10 ] || fail "off did not restore the default window: resolver returned ${_restored_window}s, expected 10s"
before_park="$(date +%s)"
legacy_park "" peer -m default --id undeclared --from alice >/dev/null
after_park="$(date +%s)"
hold="$(meta undeclared hold_until_epoch)"
window_end=$((anchor + 10))
lower="$before_park"; [ "$lower" -ge "$window_end" ] || lower="$window_end"
upper="$after_park"; [ "$upper" -ge "$window_end" ] || upper="$window_end"
[ "$hold" -ge "$lower" ] && [ "$hold" -le "$upper" ] \
  || fail "off did not restore default: hold=$hold expected=$lower..$upper anchor=$anchor clock=$(clock) now=${TAP_SPOOL_NOW:-unset}"
# register/in uses the registered recipient, not an arbitrary config target.
(cd "$WORK/repo" && bash "$TAPSH" in peer --pane sess:0.0 --digest-window 321 --json) > "$WORK/registered.json" || { cat "$WORK/registered.json"; fail "register window failed"; }
python3 -B - "$XDG_CONFIG_HOME/tap/config.toml" <<'REGISTERWINDOW' || fail "register did not persist declaration"
import sys,tomllib
row=tomllib.load(open(sys.argv[1],'rb'))['delivery']['overrides']['t/peer']
assert row['now_window_seconds']==321 and row['digest_include_asks'] is False, row
REGISTERWINDOW
cp "$BUS/registry.json" "$WORK/registry-before-refusal.json"
cp "$XDG_CONFIG_HOME/tap/config.toml" "$WORK/config-before-refusal.toml"
if (cd "$WORK/repo" && bash "$TAPSH" in alice --pane sess:0.1 --digest-window 999 --json) > "$WORK/refused.json"; then fail "registration changed another pane's window"; fi
cmp "$BUS/registry.json" "$WORK/registry-before-refusal.json" || fail "foreign declaration mutated registry"
cmp "$XDG_CONFIG_HOME/tap/config.toml" "$WORK/config-before-refusal.toml" || fail "foreign declaration mutated config"
ok "recipient notes coalesce, asks opt in, off restores default"

echo "delivery-window-clock: ok"
