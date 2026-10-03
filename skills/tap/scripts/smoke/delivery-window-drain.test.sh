#!/usr/bin/env bash
# delivery-window-drain.test.sh — tap-7r3fn.20 U1+2. What the DRAIN does with a
# window: a digest carries only due items, an in-window entry takes no solo
# injection, and a backward clock jump is due.
#
# This is the arm the bead exists for. Before this change the hold was
# `first_spooled_epoch + 300`: a note to a seat that had heard nothing for an
# hour still waited the full window, because the clock started when the SENDER
# acted. Measured on the live bus beforehand, mail delivered inside a digest had
# a p50 of 307s against 2.7s for mail injected directly.
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

fail() { echo "delivery-window-drain: FAIL — $*" >&2
  cat "$WORK/drain.log" >&2 2>/dev/null || true
  exit 1; }
ok()   { echo "  ok   $*"; }
meta() { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$BUS/spool/$1.meta.json" "$2"; }
set_hold() { python3 -B -c 'import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["hold_until_epoch"]=int(sys.argv[2])
json.dump(d,open(p,"w"),indent=2,sort_keys=True)' "$BUS/spool/$1.meta.json" "$2"; }
digest_ids() { python3 -B -c 'import glob,json,sys
out=[]
for f in glob.glob(sys.argv[1]+"/*.json"):
    try: d=json.load(open(f))
    except Exception: continue
    out += [i.get("id") for i in (d.get("items") or [])]
print(" ".join(sorted(x for x in out if x)))' "$BUS/spool/digests"; }
digest_n() { ls "$BUS/spool/digests"/*.json 2>/dev/null | wc -l | tr -d " "; }
drain() { TAP_SPOOL_NOW="${1:-}" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ \
            "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" > "$WORK/drain.log" 2>&1 || true; }
reset() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/* "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* \
         "$BUS/spool"/*.claim "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  : > "$WORK/tmux/send-keys.log"; rm -f "$WORK"/tmux/input.*
}
send() { TAP_AUTOSETTLE_HOLD_SECONDS="$1" bash "$TAPSH" send "${@:2}"; }

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



# --- 0. a future delivery reading makes NEW parks due at the next drain -----
# The recorded delivery stays an hour ahead of the send. Check the minted
# epoch against enqueue, then drain at that epoch: no wait can satisfy this.
# Plain and polite park before the standard direct-send gate.
(
  before_jump="$(date +%s)"
  for mode in note polite standard; do
    reset
    mkdir -p "$BUS/delivery"
    python3 -B -c 'import json,sys
json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' \
      "$BUS/delivery/peer.json" "$((before_jump + 3600))"
    args=()
    [ "$mode" = polite ] && args+=(--delivery polite)
    [ "$mode" = standard ] && args+=(--ask)
    send 10 peer -m "after backward clock change" --id "jump-$mode" --from alice "${args[@]}" \
      >/dev/null 2>&1 || fail "(0) $mode send failed"
    if [ "$mode" = polite ]; then
      [ "$(meta "jump-$mode" hold_until_epoch)" = "$(meta "jump-$mode" first_spooled_epoch)" ] \
        || fail "(0) polite armed a future window against a delivery reading ahead of now"
      drain "$(meta "jump-$mode" hold_until_epoch)"
    fi
    [ ! -f "$BUS/spool/jump-$mode.meta.json" ] || fail "(0) $mode stayed spooled"
    [ -f "$BUS/receipts/jump-$mode.sent" ] || fail "(0) $mode lacks verified delivery"
    [ ! -f "$BUS/receipts/jump-$mode.done" ] || fail "(0) delivery falsely settled recipient work"
  done
)
ok "new plain, polite and standard traffic delivers when the recipient clock is ahead"


# --- 0b. digit-only window overrides have decimal meaning in both consumers -
reset
mkdir -p "$BUS/delivery"
delivered="$(date +%s)"
python3 -B -c 'import json,sys
json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' \
  "$BUS/delivery/peer.json" "$delivered"
TAP_SPOOL_NOW="$delivered" legacy_park 0008 peer -m "decimal window" --id decimal --from alice --ask >"$WORK/decimal.out" 2>&1 \
  || { cat "$WORK/decimal.out" >&2; fail "(0b) leading-zero send failed"; }
[ "$(meta decimal reason_class)" = window ] \
  || { cat "$WORK/decimal.out" >&2; fail "(0b) leading-zero duration bypassed the window"; }
[ "$(meta decimal hold_until_epoch)" = "$((delivered + 8))" ] \
  || fail "(0b) the direct decision and spool writer disagree about decimal duration"
ok "leading-zero duration parks for the same decimal window in both paths"

# --- 0c. a window owner survives its deadline and delivers after recovery ----
# Ported to Bun: runtime/bun/test/waiter-lifetime.test.ts ("the leased window
# owner survives its deadline and delivers after pane recovery") drives the same
# runtime/bun/src/spool-waiter.ts exec against the leased-window fixture and
# asserts the probe presence, the unescaped escalated_at, the .reown lease, the
# post-recovery verified delivery and the absence of any delivery-failed notice.

# --- 1. a digest carries only DUE items: the ride-along is gone --------------
# Before this change an in-window entry was classified `auto-held` and could
# travel inside a doorbell some neighbour caused. Its window is its promise to
# the recipient, and a promise another sender's timing can cancel is not one.
reset
legacy_park 0 peer -m "due one"   --id r1 --from alice >/dev/null 2>&1 || fail "(1) send r1 failed"
legacy_park 0 peer -m "due two"   --id r2 --from alice >/dev/null 2>&1 || fail "(1) send r2 failed"
legacy_park 0 peer -m "in window" --id r3 --from alice >/dev/null 2>&1 || fail "(1) send r3 failed"
future=$(( $(date +%s) + 600 ))
set_hold r3 "$future"
[ "$(meta r3 hold_until_epoch)" = "$future" ] || fail "(1) fixture could not put r3 inside a window"
drain
[ "$(digest_n)" = "1" ] || fail "(1) expected exactly one doorbell, got $(digest_n)"
carried="$(digest_ids)"
case " $carried " in
  *" r1 "*) ;; *) fail "(1) the doorbell did not carry the due entry r1 (carried: $carried)" ;;
esac
case " $carried " in
  *" r3 "*) fail "(1) the doorbell carried r3, which is inside its window — the ride-along is still live (carried: $carried)" ;;
esac
[ -f "$BUS/spool/r3.meta.json" ] || fail "(1) r3 left the spool without being due"
ok "a doorbell carries only due items; an in-window entry does not ride along"

# --- 2. an in-window STANDARD entry takes no solo per-id injection ----------
# The Phase B half, and the policy matters. An `autosettle` entry has been barred
# from a solo injection since tap-31it by a guard three lines above the new one,
# so a held entry cannot distinguish them: deleting the new gate left an
# autosettle-only arm passing. `standard` is the class the new gate is FOR — it
# is what a reply: expected send parks as, it now carries a window, and nothing
# else suppresses it. It reaches Phase B's per-id path, which destructured
# `hold_until_epoch` and never compared it.
#
# Start with an unattempted standard window park. Sending into copy mode can
# attempt its cancellation and mint evidence that correctly forbids redelivery.
reset
legacy_park 600 peer -m "lonely" --id s1 --from alice --ask >/dev/null 2>&1
[ ! -f "$BUS/receipts/s1.attempted" ] || fail "(2) fixture already attempted s1"
[ -f "$BUS/spool/s1.meta.json" ] || fail "(2) the fixture did not park s1 at all"
[ "$(meta s1 policy)" = standard ] \
  || fail "(2) s1 parked as '$(meta s1 policy)'; this arm needs a standard entry or it tests the tap-31it guard instead"
future=$(( $(date +%s) + 600 ))
set_hold s1 "$future"
drain
[ -f "$BUS/spool/s1.meta.json" ] || fail "(2) an in-window standard entry was delivered by a drain"
[ "$(digest_n)" = "0" ] || fail "(2) an in-window entry alone rang a doorbell"
ok "an in-window STANDARD entry takes no injection and rings nothing"

# --- 3. once due, the same entry is delivered ------------------------------
# The companion to arm 2: proving it is HELD means nothing unless it also proves
# the hold ends. Same entry, same drain, one moved clock.
drain "$(( future + 1 ))"
[ ! -f "$BUS/spool/s1.meta.json" ] || fail "(3) the entry was still spooled after its window expired"
ok "the same entry is delivered once its window has expired"

# --- 3b. past its DELIVERY deadline, a window no longer holds it -------------
# The escape inside the Phase B gate, which arm 3 cannot see: arm 3 moves the
# clock past the WINDOW, so the gate opens for the ordinary reason. This entry
# keeps a window far in the future and moves the clock past its DEADLINE instead
# — the point at which it owes its sender a delivery-failed. Without the escape
# a misconfigured or very long window would hold an entry silently forever, and
# the gate would look correct in every other arm.
# A PENDING-INPUT park, not a copy-mode one: copy-mode maps to
# reason_class=safety_gate, which carries NO deadline (lib.sh:1866 gives one to
# the busy class), so a copy-mode entry cannot exercise a deadline escape at all.
# Human text in the band parks standard WITH a supervisor grace deadline.
reset
printf 'half-typed human text' > "$WORK/tmux/input.sess_0_0"
send 0 peer -m "overdue" --id o1 --from alice --ask >/dev/null 2>&1 || true
rm -f "$WORK/tmux/input.sess_0_0"
[ -f "$BUS/spool/o1.meta.json" ] || fail "(3b) the fixture did not park o1"
[ "$(meta o1 policy)" = standard ] || fail "(3b) o1 parked as '$(meta o1 policy)', need standard"
deadline="$(meta o1 deadline_epoch)"
[ -n "$deadline" ] || fail "(3b) o1 carries no deadline_epoch; this arm needs one"
# This arm starts with an already-stable empty composer. Seed the first empty
# observation explicitly: changing TAP_SPOOL_NOW does not advance the real-clock
# 250ms draft-protection debounce. A single immediate drain otherwise races it.
python3 - "$TAP_INDEX_HOME" "$BUS" o1 <<'PYFIX'
import json, pathlib, sys
records = [(p, json.loads(p.read_text())) for p in pathlib.Path(sys.argv[1], "input-protection").glob("*.json")]
matches = [(p, d) for p, d in records if any(m["home"] == sys.argv[2] and m["id"] == sys.argv[3] for m in d.get("pending", []))]
assert len(matches) == 1, matches
p, state = matches[0]
assert state["pane"] == "%401" and not state["consumed"], state
state["bareSince"] = 0
p.write_text(json.dumps(state))
PYFIX
set_hold o1 "$(( deadline + 100000 ))"
drain "$(( deadline + 1 ))"
[ ! -f "$BUS/spool/o1.meta.json" ] \
  || fail "(3b) an entry past its delivery deadline is still held by a window; it can never wake its sender"
ok "past its delivery deadline an entry escapes its window rather than waiting forever"

# --- 4. a backward clock jump is due ---------------------------------------
# A system clock that moves behind the moment an entry parked would otherwise
# strand it for the difference. `now < first_spooled_epoch` is the exact test and
# needs no window value.
reset
legacy_park 0 peer -m "clock jump" --id b1 --from alice >/dev/null 2>&1 || fail "(4) send failed"
first="$(meta b1 first_spooled_epoch)"
set_hold b1 "$(( $(date +%s) + 600 ))"
drain "$(( first - 60 ))"
[ ! -f "$BUS/spool/b1.meta.json" ] \
  || fail "(4) an entry whose clock moved behind its own park time is still spooled"
ok "a clock behind the entry's own park time makes it due"

# --- 5. a window-park keeps an owned deliverer, and wakes at the due time ----
# The expert's point 2. tap-spool-deliverer's `_deadline` returns 0 unless
# waiter_lifetime names an OWNED class, and with 0 the loop exits once its
# cadence is exhausted -- about 31s. Every class now carries a window, so a
# standard entry parked for longer than that would lose its only actor before it
# became due: the tap-13c8 shape in a new class.
# A COPY-MODE PARK, and the choice is the arm. A pending-input park already mints
# `grace-window` (tap-send.sh:155 passes SUPERVISOR_GRACE_SECONDS), so it can
# never exercise the new value -- an arm built on it accepts any owned class and
# cannot tell `window` from what the entry already had. Copy-mode maps to
# reason_class=safety_gate, which is the branch that mints NO lifetime at all:
# exactly the class that used to lose its deliverer at ~31s.
reset
touch "$WORK/tmux/copy_mode"
send 0 peer -m "owned" --id d1 --from alice --ask >/dev/null 2>&1 || true
rm -f "$WORK/tmux/copy_mode"
[ -f "$BUS/spool/d1.meta.json" ] || fail "(5) the fixture did not park d1"
[ "$(meta d1 policy)" = standard ] || fail "(5) d1 parked as '$(meta d1 policy)', need standard"
[ "$(meta d1 reason_class)" = safety_gate ] \
  || fail "(5) d1 parked reason_class='$(meta d1 reason_class)'; this arm needs the class that mints no lifetime of its own"
lifetime="$(meta d1 waiter_lifetime)"
[ "$lifetime" = window ] \
  || fail "(5) a window-park carries waiter_lifetime '$lifetime', expected 'window'; without it the deliverer exits after ~31s and nothing else wakes the entry"
# The native lifetime predicate that reads this park moved to Bun:
# runtime/bun/test/spool-waiter.test.ts pins waiterDeadline ("window" mints a
# deadline past cadence, unknown lifetimes refuse) and
# runtime/bun/test/spool-publication.test.ts pins the window minting itself.
ok "a window-park carries an owned deliverer lifetime"

# --- 5b. `window` is a FALLBACK and never overrides a class's own lifetime ---
# A class that minted a lifetime knows its own disposition at the deadline;
# `window` does not, so it must not replace one. A pending-input park is the
# available witness: it mints grace-window and carries a window too.
reset
printf 'human text' > "$WORK/tmux/input.sess_0_0"
send 0 peer -m "grace" --id d2 --from alice --ask >/dev/null 2>&1 || true
rm -f "$WORK/tmux/input.sess_0_0"
[ -f "$BUS/spool/d2.meta.json" ] || fail "(5b) the fixture did not park d2"
[ -n "$(meta d2 hold_until_epoch)" ] || fail "(5b) d2 carries no window, so this arm proves nothing"
[ "$(meta d2 waiter_lifetime)" = grace-window ] \
  || fail "(5b) a pending-input park carries waiter_lifetime '$(meta d2 waiter_lifetime)', expected grace-window; the window fallback overwrote a class that owns its own disposition"
ok "a class with its own lifetime keeps it; window is a fallback, not an override"

# The flush-epoch truncation itself moved to Bun: runtime/bun/test/spool-waiter.test.ts
# pins deliveryWait(15, {deadline_epoch:1000, hold_until_epoch:103}, 100) == 3 —
# the flush epoch as a wait boundary, asserted against the module directly.
# --- 7. an ordinary same-team park reaches its team-qualified override ------
# sol's R1 finding (1), end-to-end because that is the only level it shows at.
# `_to_team_stamp` is set only on the team-qualified REMOTE path
# (tap-send.sh:1048), so an ordinary local park arrives at the park writer with an
# empty to_team — and the override lookup would miss every
# [delivery.overrides."<team>/<handle>"] key and fall through to the bare
# shorthand. The window-config arms cannot see this: they call the reader with a
# team already in hand, so the mutation that drops the resolution survives them.
reset
CFG_DIR="$WORK/xdg/tap"; mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/config.toml" <<'TOML'
[delivery]
now_window_seconds = 11

[delivery.overrides."t/peer"]
now_window_seconds = 4242
TOML
mkdir -p "$BUS/delivery"
delivered=$(( $(date +%s) - 1 ))
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$delivered"
XDG_CONFIG_HOME="$WORK/xdg" legacy_park "" peer -m "override" --id ov1 --from alice >/dev/null 2>&1 || fail "(7) send failed"
[ -f "$BUS/spool/ov1.meta.json" ] || fail "(7) the send did not park"
hold="$(meta ov1 hold_until_epoch)"
[ "$hold" = "$(( delivered + 4242 ))" ] \
  || fail "(7) armed at $hold, expected last_delivered + 4242 (the t/peer override) = $(( delivered + 4242 )); a same-team park did not reach its team-qualified key"
ok "an ordinary same-team park resolves its own team and reaches the qualified override"

# --- 7b. a bare composer bypasses even a long configured window -----------
reset
mkdir -p "$BUS/delivery"
delivered=$(( $(date +%s) - 20 ))
python3 -B -c 'import json,sys; json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' "$BUS/delivery/peer.json" "$delivered"
XDG_CONFIG_HOME="$WORK/xdg" TAP_AUTOSETTLE_HOLD_SECONDS= \
  bash "$TAPSH" send peer --ask -m "decision" --id ov2 --from alice >/dev/null 2>&1 || fail "(7b) send failed"
[ -f "$BUS/receipts/ov2.sent" ] && [ ! -f "$BUS/spool/ov2.meta.json" ] || fail "(7b) bare composer was held by a configured window"
ok "bare delivery bypasses the window without changing existing parks"

# --- 8. Phase B's OWN backward-clock escape -------------------------------
# sol's R1 finding (4), and the gap the code comment already named. Arm 4
# exercises Phase A's clause; a standard entry is normally freed by that one too,
# so a mutant dropping Phase B's half survived.
#
# THE DISCRIMINATOR IS A LONE ENTRY, and finding it took one wrong guess worth
# recording. The first attempt used a copy-mode pane, reasoning that a not-ready
# pane keeps entries out of Phase A — true, but useless: Phase B checks readiness
# too, so the entry stays spooled whichever clause decided, and the arm could not
# tell a working gate from a broken one.
#
# What actually separates the phases is what Phase A is FOR. It plans DIGESTS, so
# the flush rule drops a single plain row (`not autos and len(rows) < 2`) and
# never makes it a digest member. Phase B then walks that same row and delivers
# it per-id — so for a lone standard entry on a READY pane, only Phase B's own
# clause can free it.
reset
legacy_park 600 peer -m "phase b jump" --id pb1 --from alice --ask >/dev/null 2>&1
[ ! -f "$BUS/receipts/pb1.attempted" ] || fail "(8) fixture already attempted pb1"
[ -f "$BUS/spool/pb1.meta.json" ] || fail "(8) the fixture did not park pb1"
[ "$(meta pb1 policy)" = standard ] || fail "(8) pb1 parked as '$(meta pb1 policy)', need standard"
first="$(meta pb1 first_spooled_epoch)"
set_hold pb1 "$(( $(date +%s) + 600 ))"
drain "$(( first - 60 ))"
[ "$(digest_n)" = "0" ] \
  || fail "(8) a doorbell rang, so this entry went through Phase A and the arm duplicates arm 4"
[ ! -f "$BUS/spool/pb1.meta.json" ] \
  || fail "(8) a lone entry whose clock moved behind its own park time is still held by Phase B; only Phase A honors the jump"
ok "Phase B's own backward-clock escape frees an entry Phase A never sees"

# --- 9. the DIGEST doorbell stamps the clock, rc 0 only ---------------------
# sol's R1 finding (5), and the gap eb0f4854f named: no fixture drove a digest
# through the clock, so a mutant stamping on rc 5 survived. A doorbell is one
# verified pane injection and resets the window like any other delivery.
reset
legacy_park 0 peer -m "one" --id g1 --from alice >/dev/null 2>&1 || fail "(9) send g1 failed"
legacy_park 0 peer -m "two" --id g2 --from alice >/dev/null 2>&1 || fail "(9) send g2 failed"
[ ! -e "$BUS/delivery/peer.json" ] || fail "(9) a clock existed before any delivery"
drain
[ "$(digest_n)" = "1" ] || fail "(9) expected one doorbell, got $(digest_n)"
[ -f "$BUS/delivery/peer.json" ] \
  || fail "(9) a verified digest doorbell did not stamp the recipient clock; the next batch would flush as if the seat had heard nothing"
stamped="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["last_delivered_at"])' "$BUS/delivery/peer.json")"
case "$stamped" in ''|*[!0-9]*) fail "(9) the doorbell stamped '$stamped', expected an epoch" ;; esac
ok "a verified digest doorbell stamps the recipient's clock"

# --- 9b. an UNVERIFIED doorbell (rc 5) stamps nothing -----------------------
# rc 5 is "ATTEMPTED, not confirmed ... the recipient may or may not have been
# woken" (lib.sh). A window started by an unobserved injection would hold the
# seat's next message for time nothing earned — the same cut U0's instrument
# makes when it refuses to count an epoch-less index.
#
# The mock reports the sentinel never left the band, which is exactly what
# submit-verify reads to decide rc 5.
reset
legacy_park 0 peer -m "one" --id u1 --from alice >/dev/null 2>&1 || fail "(9b) send u1 failed"
legacy_park 0 peer -m "two" --id u2 --from alice >/dev/null 2>&1 || fail "(9b) send u2 failed"
touch "$WORK/tmux/never_clears"
drain
rm -f "$WORK/tmux/never_clears"
[ ! -e "$BUS/delivery/peer.json" ] \
  || fail "(9b) an unverified doorbell stamped the clock; a possible effect must not start a real window"
ok "an unverified doorbell (rc 5) stamps no clock"

# --- 9c. individual redelivery stamps the clock ----------------------------
# The third stamp site, and the other half of finding (5). A lone standard entry
# takes the per-id path, which is a verified pane injection like any other.
reset
legacy_park 600 peer -m "solo" --id rd1 --from alice --ask >/dev/null 2>&1
[ ! -f "$BUS/receipts/rd1.attempted" ] || fail "(9c) fixture already attempted rd1"
[ -f "$BUS/spool/rd1.meta.json" ] || fail "(9c) the fixture did not park rd1"
[ ! -e "$BUS/delivery/peer.json" ] || fail "(9c) a parked send stamped the clock"
drain "$(( $(meta rd1 hold_until_epoch) + 1 ))"
[ ! -f "$BUS/spool/rd1.meta.json" ] || fail "(9c) the entry was not redelivered once due"
[ "$(digest_n)" = "0" ] || fail "(9c) a lone entry went out as a digest; this arm needs the per-id path"
[ -f "$BUS/delivery/peer.json" ] \
  || fail "(9c) individual redelivery did not stamp the recipient clock"
ok "individual redelivery stamps the recipient's clock"

# --- 10. new bare traffic bypasses a recent delivery clock ----------------
reset
mkdir -p "$BUS/delivery"
now="$(date +%s)"
python3 -B -c 'import json,sys; json.dump({"handle":"peer","last_delivered_at":int(sys.argv[2])},open(sys.argv[1],"w"))' "$BUS/delivery/peer.json" "$((now-2))"
send 600 peer -m "inside" --id wp1 --from alice --ask >/dev/null 2>&1 || fail "(10) send failed"
[ -f "$BUS/receipts/wp1.sent" ] && [ ! -f "$BUS/spool/wp1.meta.json" ] || fail "(10) bare send was held by clock"
ok "a bare composer receives immediately inside the old window"

# --- 10c. a quiet seat is NOT parked ---------------------------------------
# The first message after quiet is instant. An arm that only proved parking
# would pass for a courier that parked everything.
reset
TAP_AUTOSETTLE_HOLD_SECONDS=600 bash "$TAPSH" send peer -m "first" --id wp2 --from alice --ask \
  >/dev/null 2>&1 || fail "(10c) send failed"
[ ! -f "$BUS/spool/wp2.meta.json" ] \
  || fail "(10c) a send to a seat that has heard nothing was parked; the first message after quiet is instant"
ok "a send to a quiet seat is not parked"

# --- 10c2. a clock AHEAD of now delivers rather than parking ----------------
# The send side's backward-jump clause. If the recorded delivery is in the
# future, the system clock moved behind it — and an entry parked against that
# reading would wait for a window that already looks open to the drain. The two
# sides must not disagree about what a jumped clock means, so the send declines
# to park for exactly the reading the drain treats as due.
reset
mkdir -p "$BUS/delivery"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$(( $(date +%s) + 600 ))"
TAP_AUTOSETTLE_HOLD_SECONDS=600 bash "$TAPSH" send peer -m "jumped" --id wp4 --from alice --ask \
  >/dev/null 2>&1 || fail "(10c2) send failed"
[ ! -f "$BUS/spool/wp4.meta.json" ] \
  || fail "(10c2) a clock reading in the FUTURE parked the send; a backward clock jump must deliver, as the drain already treats it"
ok "a clock ahead of now delivers rather than parking"

# --- 10d. interrupt is the one exemption -----------------------------------
# Escape-and-inject is for the emergency that cannot wait for a window.
reset
mkdir -p "$BUS/delivery"
now="$(date +%s)"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(sys.argv[2])}))' \
  "$BUS/delivery/peer.json" "$(( now - 2 ))"
TAP_AUTOSETTLE_HOLD_SECONDS=600 bash "$TAPSH" send peer -m "emergency" --id wp3 --from alice \
  --delivery interrupt >/dev/null 2>&1 || fail "(10d) interrupt send failed"
[ ! -f "$BUS/spool/wp3.meta.json" ] \
  || fail "(10d) --delivery interrupt was held by a window; escape-and-inject is the one exemption"
ok "--delivery interrupt bypasses the window"

echo "delivery-window-drain: ok"
