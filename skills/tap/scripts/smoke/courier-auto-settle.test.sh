#!/usr/bin/env bash
# D5: public — the remaining runtime/bun/src touch (:733-761) builds the A24 probe package around the real spool-waiter.ts to observe the child that the public `tap send` path spawns at park time; the hold-clock acceptance arm (16) that execed the waiter as its own subject is ported to runtime/bun/test/waiter-lifetime.test.ts.
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# ARM NUMBERING IS STABLE, NOT DENSE: (8) and (15) were deleted with the
# direct-path ride-along they pinned (cut ratified 2026-08-18), and the survivors
# keep their original numbers so the PR's mutation table and every payload that
# cites "arm (11)" still names the same arm. A renumber would silently re-point
# every record written before the cut.
#
# courier-auto-settle.test.sh — tap-31it: an eligible reply=settle-only send takes
# NO recipient wake of its own. It parks (policy=autosettle), is delivered by a
# digest doorbell, and its `via: courier-auto` receipt is written AT that verified
# injection — never at send. Covers U1 (send gate, carve-outs, --wake, spooled-for-
# digest, delivery-failed tail), U2 (N>=1 for the class, pre-settled index rows,
# retention, rc-5) and R9's reply door.
#
# Every arm asserts an EFFECT — a sentinel that did or did not reach the pane, a
# receipt that does or does not exist — never an exit code standing in for one.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

export TAP_TUI_SETTLE_SCALE=0.1
# The drain must be the only flush this fixture cannot see coming: no opportunistic
# drain riding a send, no detached deliverer racing an assertion.
export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
cleanup() {
  if [ "${A24_ACTIVE:-0}" = 1 ] && [ ! -s "$A24_STATE/status" ]; then
    # On an assertion failure, release this fixture's entry and still join the
    # actor. Never remove its directories while completion is unobservable.
    rm -f "$BUS/spool/$_probe_id.md"
    local deadline="${A24_JOIN_DEADLINE:-$((SECONDS + 120))}"
    while [ ! -s "$A24_STATE/status" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.2; done
    if [ ! -s "$A24_STATE/status" ]; then
      echo "courier-auto-settle: cleanup refused: missing deliverer exit status; retained $WORK and $FAKE_BIN" >&2
      return 1
    fi
  fi
  rm -rf "$WORK" "$FAKE_BIN"
}
trap 'rc=$?; cleanup || rc=1; exit "$rc"' EXIT
export TAP_INDEX_HOME="$WORK/index"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
# The fixture owns creation; a late helper must not recreate it during cleanup.
[ -d "$state" ] || exit 1
cmd="$1"; shift
# Native submit targets immutable pane ids; resolve them to the same fake pane.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
  args+=("$arg")
done
set -- "${args[@]}"
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    # Pane identity is per-TARGET: a fixture that answers one id for every pane
    # cannot exercise a send BACK to the sender (identity_mismatch on every reply).
    target=""; argv=("$@")
    for ((i=0; i<${#argv[@]}; i++)); do [ "${argv[$i]}" = "-t" ] && target="${argv[$((i+1))]}"; done
    case "$target" in
      sess:0.1) pid="%402" ;;
      sess:0.2) pid="%403" ;;
      *)        pid="${FAKE_PANE_ID:-%401}" ;;
    esac
    case "$fmt" in
      *pid*start_time*) echo "4242:100" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "$pid" "$([ "$pid" = "%402" ] && printf codex || printf '%s' "${FAKE_TMUX_CMD:-codex}")" ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$pid" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$pid" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "$pid" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  select-pane) echo "select-pane $*" >> "$state/send-keys.log" ;;
  capture-pane)
    # Busy AND the input band are per-PANE. A single shared input file is not a
    # fidelity detail: it makes one pane's stuck submit look like pending human
    # input on every OTHER pane, so a notice sent to a second seat refuses for a
    # reason no real tmux would produce.
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    if [ -f "$state/busy" ] || { [ -n "$key" ] && [ -f "$state/busy.$key" ]; }; then
      printf 'model is generating a response...\n'
    elif [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then rm -f "$state/copy_mode"; exit 0; fi
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input.$key"; exit 0 ;;
      C-u) rm -f "$state/input.$key"; exit 0 ;;
      Enter)
        # The transaction's own window, opened deliberately: this runs after the
        # digest revalidated its ids and before its post-submit bookkeeping, which
        # is the only place a racing cancel or a failing rewrite can be driven
        # DETERMINISTICALLY rather than hoped for.
        if [ -n "${FAKE_AT_DIGEST_SUBMIT:-}" ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          bash -c "$FAKE_AT_DIGEST_SUBMIT" || true
        fi
        # Arm (11): the digest doorbell submits but never verifies (rc 5).
        if [ "${FAKE_TMUX_STUCK_DIGEST_SUBMIT:-0}" = 1 ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          exit 0
        fi
        rm -f "$state/input.$key"
        exit 0
        ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" \
       FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
mkdir -p "$WORK/tmux" "$WORK/repo"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"; export TAP_HOME="$BUS"
tap_smoke_enroll_current "$WORK/repo" "$BUS" t
REG="$BUS/registry.json"
cat > "$REG" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":  { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice": { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "bob":   { "session": "sess", "pane": "sess:0.2", "pane_id": "%403", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

PANE="sess:0.0"; PANE_ID="%401"      # peer's bound pane, for fixtures that build a spool entry directly
LOG="$WORK/tmux/send-keys.log"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"; . "${LIB%/smoke/runtime-helpers.sh}/smoke/spool-park-fixture.sh"; . "${LIB%/smoke/runtime-helpers.sh}/smoke/canonical-place-fixture.sh"
tap_ensure_dirs

fail() { echo "courier-auto-settle: $*" >&2; [ -f "$LOG" ] && cat "$LOG" >&2; exit 1; }
# v0.23 (tap-7r3fn.8): the id is SLOT 3, positional, not an `id=` key -- and it may
# carry a `<team>/` bus-locator prefix. Anchored on the sentinel head and bounded on
# the right so `c-probe` cannot be satisfied by `c-probe-2`, which a bare substring
# match would have accepted.
# v0.23 (tap-7r3fn.8): every `kind=` except escalate and digest left the wire, so
# a sentinel no longer says WHY it woke anyone -- `delivery-failed` is an ENVELOPE
# field now (spec section 3 keeps `kind:` at rest). This reads the ids out of slot
# 3 and asks the payloads, which is a stronger question than the old wire grep: it
# confirms the notice that reached the pane IS the delivery-failed one, rather than
# that some sentinel carrying the string exists.
woke_with_kind() { # <envelope kind>
  local ids id
  ids="$(grep -oE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+' "$LOG" | awk '{print $NF}' | sed 's/\]\]$//;s/:$//;s#.*/##')"
  [ -n "$ids" ] || return 1
  for id in $ids; do
    grep -q "^kind: $1\$" "$BUS/payloads/${id}.md" 2>/dev/null && return 0
  done
  return 1
}
injected()      { grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?$1( |:|\\]\\])" "$LOG" 2>/dev/null; }
# `grep -c` PRINTS 0 and EXITS 1 on no-match, and this fixture runs under
# pipefail — piping it swallows the count and appends a fallback, so "no
# doorbell" renders as "0\n0" and every zero-assertion silently fails.
# COUNT PASTE EVENTS, AND DO NOT DEDUPLICATE THEM (tap-1hsj, sol P2). A dedup by
# digest id was tried here and reverted: `tap_submit_existing_verify` retries Enter
# rather than the paste, so a re-paste of the SAME id is not a retry artifact — it
# is a second pane mutation and potentially a second wake. `sort -u` would score
# that 1 and let the acceptance arm pass through exactly the defect it exists to
# catch. The flake this bead fixes was a setup race, not a miscount, so the
# instrument stays as strong as it was.
#
# `grep -c` PRINTS 0 and EXITS 1 on no-match, and this fixture runs under
# pipefail — piping it swallows the count and appends a fallback, so "no
# doorbell" renders as "0\n0" and every zero-assertion silently fails.
digest_count()  { local n; n="$(grep -cE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$LOG" 2>/dev/null || true)"; printf '%s' "${n:-0}"; }
# Cleanup belongs to the watch loop; retention controls call its native reaper.
reap_digests() { tap_bun_call digest-index - digest-index.ts reap "$TAP_HOME/spool/digests" "$TAP_RECEIPTS"; }
digest_index()  { find "$BUS/spool/digests" -maxdepth 1 -name '*.json' 2>/dev/null | head -1; }
meta_field()    { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")
except Exception: print("")' "$BUS/spool/$1.meta.json" "$2" 2>/dev/null || true; }
receipt_via()   { python3 -B -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("via",""))
except Exception: print("")' "$BUS/receipts/$1.done" 2>/dev/null || true; }
send_line_no()  { grep -n "id=$1 " "$LOG" | head -1 | cut -d: -f1; }
reset_bus() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/*.done "$BUS/receipts"/*.cancelled \
         "$BUS/receipts"/*.sent "$BUS/receipts"/*.placed \
         "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* "$BUS/spool"/*.claim \
         "$BUS/spool/digests" "$BUS/delivery" 2>/dev/null || true
  : > "$LOG"
  rm -f "$WORK"/tmux/input.* "$WORK/tmux/busy" "$WORK"/tmux/busy.* "$WORK/tmux/copy_mode"
  # tap-7r3fn.20: this file is about the HOLD MACHINERY — what a park does, when
  # a doorbell rings, what a receipt means — and every one of those arms presumes
  # an OPEN window. Since the window now runs from the recipient's last verified
  # delivery, "open" is a precondition that has to be established rather than
  # assumed: a seat that has heard nothing takes its next note instantly, which is
  # the whole point of the change and is owned by delivery-window-clock.test.sh.
  #
  # Stating it here rather than inheriting it. Before the clock existed, the line
  # above did not clear `$BUS/delivery`, so each arm silently ran on whatever
  # delivery an EARLIER arm happened to leave behind — the arms passed, but on a
  # premise no one had written down. Clearing without stamping makes arm (5) red
  # ("an unrelated drain flushed items inside their hold window") because with a
  # quiet clock there is no window to be inside.
  mkdir -p "$BUS/delivery"
  python3 -B -c 'import json,sys,time
open(sys.argv[1],"w").write(json.dumps({"handle":"peer","last_delivered_at":int(time.time())}))'     "$BUS/delivery/peer.json"
}
# The drain runs in its own process so TAP_SPOOL_NOW can move time per call.
drain() { TAP_SPOOL_NOW="${1:-}" bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" >/dev/null 2>&1 || true; }
# Same drain, keeping stderr: a courier-side warning is an effect too, and the
# default helper discards it along with the ordinary noise.
drain_err() { # <errfile> [now]
  TAP_SPOOL_NOW="${2:-}" bash -c 'set -euo pipefail; . "$2"; . "${2%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$1" "$LIB" >/dev/null 2>"$1" || true
}
send() { bash "$TAPSH" send "$@"; }

# Construct an already-parked pre-.96 note without exercising new-send policy.
# Custody/expiry/recovery below remain production paths; new-send semantics are
# covered in delivery-disposition.test.sh.
legacy_note() { # <id> <from> <body>
  local id="$1" from="$2" body="$3" source="$WORK/legacy-$1.md" canon
  printf '%s\n' '---' '---' "$body" > "$source"
  canon="${TAP_PAYLOADS}/$id.md"
  canonical_place_fixture "$source" "$id" "$from" peer discuss "$canon" 0 settle-only t t >/dev/null
  spool_park_fixture "$id" "$canon" peer t auto-settle busy "" "$PANE" "$PANE_ID" t autosettle "" "$REG" >/dev/null
  rm -f "$canon"
}

HOLD_LONG=99999

# ---- (1) a pre-change parked note remains held until its existing window ----
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG legacy_note a1 alice 'held body' >/dev/null 2>&1
injected a1 && fail "(1) an eligible settle-only send injected a sentinel"
[ -f "$BUS/spool/a1.md" ] || fail "(1) eligible send did not park in the spool"
[ "$(meta_field a1 policy)" = "autosettle" ] || fail "(1) park is not marked policy=autosettle"
[ -n "$(meta_field a1 hold_until_epoch)" ] || fail "(1) park carries no hold_until_epoch"
[ ! -f "$BUS/receipts/a1.done" ] || fail "(1) a receipt exists before the doorbell landed — .done must mean the seat RECEIVED it"
[ ! -f "$BUS/payloads/a1.md" ] || fail "(1) canonical left behind by a parked send"
# outstanding exits 0 whether or not sends are open; the a1 row below is the proof.
OUT="$(bash "$TAPSH" outstanding alice --json 2>/dev/null || true)"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
row = [i for i in d["outstanding"] if i["id"] == "a1"]
assert row, d
assert row[0]["status"] == "spooled-for-digest", row
' "$OUT" || fail "(1) sender outstanding does not show the distinct spooled-for-digest state"
# The refuted plan line, pinned honestly (see PR): a held body is NOT in payloads/,
# so `tap poll` cannot see it. The sender's outstanding + the delivery deadline are
# what carry R2's no-silent-loss property, not poll.
POLL="$(bash "$TAPSH" poll --by peer 2>/dev/null || true)"
printf '%s' "$POLL" | grep -q 'a1' && fail "(1) tap poll surfaced a spooled body — fixture premise changed, update CONTRACT with it"
echo "courier-auto-settle: (1) eligible send parks silently, receipt withheld until delivery, sender sees spooled-for-digest: ok"

# ---- (2) carve-out kinds are still INJECTED (grok's witness) ------------------
reset_bus
# `|| true` here used to swallow the send's exit, so a red said only "no paste in
# the log" — which is equally consistent with the send REFUSING and with the send
# succeeding but PARKING. The 2026-09-04 gate red was exactly that: probe pasted,
# notice produced no tmux call at all, and the fixture could not say which of the
# two had happened. Capture the outcome and separate the three states, so the next
# occurrence classifies itself instead of needing a forensic pass over a mock log.
#
# What this does NOT do: it does not explain the 2026-09-04 red retroactively.
# That run is over, its log holds only what the old fixture recorded, and no
# assertion added here can reach back into it. The cause of that red remains
# INDETERMINATE. This arm is prospective only — it classifies the NEXT
# occurrence into refusal, park, or accepted-without-injection. Saying so here
# matters because a strengthened instrument reads, months later, like a diagnosis
# of the failure that prompted it.
for k in probe notice escalate; do
  set +e
  _cout="$(TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "carve $k" --id "c-$k" --from alice --kind "$k" --fyi 2>&1)"
  _crc=$?
  set -e
  [ "$_crc" = 0 ] || fail "(2) kind=$k: the send itself REFUSED (rc=$_crc) — this is not a hold, and a park assertion below would misname it:
$_cout"
  [ ! -f "$BUS/spool/c-$k.md" ] || fail "(2) kind=$k was PARKED in the spool — its whole value is the wake it causes, and a carve-out kind must never coalesce:
$_cout"
  injected "c-$k" || fail "(2) kind=$k: the send reported success and did not park, yet no paste reached the pane log — the wake was lost between acceptance and injection:
$_cout"
done
echo "courier-auto-settle: (2) probe/notice/escalate still take their own wake: ok"

# ---- (3) --urgent settle-only injects AND writes no courier-auto receipt ------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "urgent fyi" --id u1 --from alice --fyi --urgent >/dev/null 2>&1
injected u1 || fail "(3) --urgent settle-only did not inject"
[ ! -f "$BUS/receipts/u1.done" ] || fail "(3) an urgent send was auto-settled — only a delivered digest may write that receipt"
echo "courier-auto-settle: (3) --urgent bypasses the hold and is never auto-settled: ok"

# ---- (4) --wake declines PRE-SETTLEMENT, not the window ----------------------
# NARROWED BY RULING 51 (tap-7r3fn.20). This arm used to read `--wake` as one
# fact — "not eligible for a hold" — because auto-settle was the only hold there
# was. It is two facts, and the ruling separates them: `--wake` is inert on the
# DELIVERY axis (`now` is already the default, so it changes nothing about when a
# note arrives) while it still declines courier pre-settlement, so the recipient
# still owes a `tap done`. The settlement half is what this arm keeps.
#
# reset_bus STAMPS the clock — this file's arms are about the hold machinery and
# presume an open window, so that is its default. This arm needs the opposite for
# its first half, so it clears what reset_bus just wrote: a quiet seat takes its
# next note instantly, and the injection below then means the flag's own
# behaviour rather than the seat's silence.
reset_bus
rm -rf "$BUS/delivery"
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "answer" --id w1 --from alice --fyi --wake >/dev/null 2>&1
injected w1 || fail "(4) --wake settle-only to a QUIET seat was held; the first message after quiet is instant"
[ ! -f "$BUS/spool/w1.md" ] || fail "(4) --wake send to a quiet seat parked"
grep -q 'Escape' "$LOG" && fail "(4) --wake interrupted the pane — that is --urgent's job, not this flag's"
[ ! -f "$BUS/receipts/w1.done" ] || fail "(4) --wake send was auto-settled"
# The delivery above opened peer's window. A second --wake send rides it like any
# other class: inert on delivery means inert, not exempt.
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG send peer -m "again" --id w2 --from alice --fyi --wake >/dev/null 2>&1
[ -f "$BUS/receipts/w2.sent" ] && [ ! -f "$BUS/spool/w2.meta.json" ] \
  || fail "(4) a bare composer did not receive the second note immediately"
[ ! -f "$BUS/receipts/w2.done" ] || fail "(4) the parked --wake send was auto-settled"
echo "courier-auto-settle: (4) --wake declines pre-settlement, rides the window, and never interrupts: ok"

# ---- (5) two eligible sends -> zero wakes, then ONE doorbell at expiry --------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG legacy_note d1 alice first >/dev/null 2>&1
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG legacy_note d2 alice second >/dev/null 2>&1
{ injected d1 || injected d2; } && fail "(5) a second eligible send woke the seat"
[ "$(digest_count)" = "0" ] || fail "(5) a doorbell rang while both items were still inside their hold window"
drain                       # an ordinary drain must NOT flush held items
[ "$(digest_count)" = "0" ] || fail "(5) an unrelated drain flushed items inside their hold window"
[ -f "$BUS/spool/d1.md" ] && [ -f "$BUS/spool/d2.md" ] || fail "(5) a drain consumed a held item without a doorbell"
HOLD_END="$(( $(meta_field d1 hold_until_epoch) + 1 ))"
drain "$HOLD_END"
[ "$(digest_count)" = "1" ] || fail "(5) expected exactly one doorbell at hold expiry, got $(digest_count)"
# v0.23: `from=`/`to=` left the wire. The digest's identity survives as its id's
# own handle field -- literally `courier` -- and its UNPREFIXED id slot, which is
# structural: the digest renders both route halves off the same to_team, so it can
# never be cross-team and can never take a `<team>/` locator prefix.
grep -qE '\[\[TAP v[0-9.]+ note courier-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}( |$)' "$LOG" || fail "(5) digest sentinel is not an unprefixed courier-minted note"
[ ! -f "$BUS/receipts/d1.done" ] || fail "(5) d1 has no via=courier-auto receipt after the doorbell"
[ ! -f "$BUS/receipts/d2.done" ] || fail "(5) d2 has no via=courier-auto receipt after the doorbell"
[ -f "$BUS/payloads/d1.md" ] && [ -f "$BUS/payloads/d2.md" ] || fail "(5) delivered bodies were not canonicalized"
[ ! -f "$BUS/spool/d1.md" ] && [ ! -f "$BUS/spool/d2.md" ] || fail "(5) delivered bodies left in the spool"
IDX="$(digest_index)"; [ -n "$IDX" ] || fail "(5) no digest index written"
python3 -B - "$IDX" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["count"] == 2, d
for it in d["items"]:
    assert not it.get("settled"), it
    assert it["reply"] == "settle-only", it
assert "tap read" in d["instructions"], d["instructions"]
assert d.get("injected_at_epoch"), d
# The index carries the team too, and an empty half here is the same defect the
# sentinel had — one fix per carrier, so both are pinned.
assert d["from"] == "t/courier", d
assert d["to_team"] == "t", d
PY
echo "courier-auto-settle: (5) two held bodies, zero wakes, one doorbell, both awaiting recipient read: ok"

# Older releases did create these receipts; readers still preserve them.
printf '%s\n' '{"id":"d1","by":"peer","via":"courier-auto","status":"done"}' > "$BUS/receipts/d1.done"
# ---- (6) tap done on an auto-settled id is the retired tombstone, receipt untouched --
d1_before="$(cat "$BUS/receipts/d1.done")"
set +e
DONE_OUT="$(TAP_JSON=1 bash "$TAPSH" done d1 --by peer 2>&1)"; DONE_RC=$?
set -e
[ "$DONE_RC" = "1" ] || fail "(6) tap done should refuse as retired (exit 1), got $DONE_RC"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="done_retired", d' "$DONE_OUT" \
  || fail "(6) refusal class is not done_retired"
[ "$(cat "$BUS/receipts/d1.done")" = "$d1_before" ] || fail "(6) the tombstone rewrote a settlement receipt"
echo "courier-auto-settle: (6) tap done on a pre-settled id refuses as retired and leaves the receipt: ok"

# ---- (7) R9: tap reply on a pre-settled id DELIVERS instead of refusing -------
: > "$LOG"
set +e
REPLY_OUT="$(bash "$TAPSH" reply d1 -m "wrong premise" --by peer 2>&1)"; REPLY_RC=$?
set -e
[ "$REPLY_RC" = "0" ] || fail "(7) reply on a courier-auto-settled inbound refused (rc $REPLY_RC): $REPLY_OUT"
# v0.23: no route keys and no `id=` key on the wire, so what this arm can still
# observe is that SOMETHING was injected -- a sentinel head. That is all it ever
# really asserted: the `to=`/`id=` alternation above was already a two-way fallback
# where the second branch matched any sentinel at all.
grep -qE '\[\[TAP v[0-9.]+ (ask|note) ' "$LOG" || fail "(7) the problem report never reached the sender's pane"
[ "$(receipt_via d1)" = "courier-auto" ] || fail "(7) the reply overwrote the courier-auto receipt provenance"
echo "courier-auto-settle: (7) the problem-report door stays open on a pre-settled payload: ok"

# ---- (9) NO ride-along: an in-window body stays behind a neighbour's doorbell -
# INVERTED BY tap-7r3fn.20, and the inversion is the feature rather than fallout.
# This arm used to assert that a held body RODE ALONG with any doorbell ringing
# for the same pane — arriving early through no rule of its own, on a neighbour's
# timing. A window is a promise to the recipient, and a promise another sender
# can cancel is not one, so Phase A now drops a not-due row before the grouper
# sees it and the digest carries only due items.
#
# The arm is kept rather than deleted because the SHAPE is still worth pinning:
# one held body, one ordinary park, one drain to the same pane. Only the expected
# outcome moved, and it moved in the direction the bead asked for.
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG legacy_note m1 alice held >/dev/null 2>&1
touch "$WORK/tmux/busy.sess_0_0"          # peer is mid-turn: an ordinary send parks
send peer -m "polite one" --id m2 --from alice --polite --polite-timeout 600 >/dev/null 2>&1
[ -f "$BUS/spool/m2.md" ] || fail "(9) the polite send did not park"
rm -f "$WORK/tmux/busy.sess_0_0"          # …and the seat frees up
: > "$LOG"
drain
[ "$(digest_count)" = "0" ] \
  || fail "(9) a doorbell rang while every candidate was inside its window — the ride-along is back"
[ -f "$BUS/spool/m1.md" ] \
  || fail "(9) the held body left the spool without being due"
[ ! -f "$BUS/receipts/m1.done" ] \
  || fail "(9) the held body was pre-settled before its window closed"
# …and the hold still ENDS. Asserting only that it is held would pass for an
# entry that never arrives, which is the failure this bead exists to remove.
drain "$(( $(meta_field m1 hold_until_epoch) + 1 ))"
[ "$(digest_count)" = "1" ] || fail "(9) no doorbell at hold expiry, got $(digest_count)"
[ ! -f "$BUS/receipts/m1.done" ] || fail "(9) the held body was not pre-settled once its window closed"
[ ! -f "$BUS/receipts/m2.done" ] || fail "(9) the ordinary park was auto-settled — only the eligible class is"
echo "courier-auto-settle: (9) an in-window body does NOT ride a neighbour's doorbell, and still lands when due: ok"

# ---- (10) ordinary spool still needs N>=2 (no digest for a lone park) ---------
# tap-7r3fn.20 adds a SECOND condition this arm has to carry. A polite park now
# rides the long window like every other class, and reset_bus stamps the clock a
# moment ago, so a lone polite entry is legitimately not due at the first drain —
# per-id delivery waits for its window rather than happening immediately. That is
# the feature, not a break, so the arm asserts both halves: no digest either way,
# and per-id delivery once the window closes.
reset_bus
touch "$WORK/tmux/busy.sess_0_0"
send peer -m "lone park" --id s1 --from alice --polite --polite-timeout 600 >/dev/null 2>&1
rm -f "$WORK/tmux/busy.sess_0_0"
: > "$LOG"
drain
[ "$(digest_count)" = "0" ] || fail "(10) a lone ordinary park was wrapped in a digest envelope"
injected s1 && fail "(10) a lone polite park was delivered inside its own window"
drain "$(( $(meta_field s1 hold_until_epoch) + 1 ))"
[ "$(digest_count)" = "0" ] || fail "(10) a lone ordinary park was wrapped in a digest envelope once due"
injected s1 || fail "(10) the lone ordinary park was not redelivered per-id once its window closed"
echo "courier-auto-settle: (10) N>=1 is legal for the auto-settle class only; a lone ordinary park waits its window then goes per-id: ok"

# ---- (11) unverified doorbell: no receipt, and the sender is told ------------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note x1 alice unverifiable >/dev/null 2>&1
: > "$LOG"
FAKE_TMUX_STUCK_DIGEST_SUBMIT=1 drain
[ ! -f "$BUS/receipts/x1.done" ] || fail "(11) a receipt was written for an UNVERIFIED doorbell — .done would be lying"
woke_with_kind delivery-failed || fail "(11) nobody was woken: the spool meta is dropped at rc 5, so the deadline cannot fire and the sender must be told now"
# The index must not claim a settlement no receipt supports: exit 5 is attempted,
# not confirmed, so a recipient who DID get the doorbell has to be able to settle
# these bodies normally.
IDX5="$(digest_index)"; [ -n "$IDX5" ] || fail "(11) no index to inspect"
python3 -B - "$IDX5" <<'PY' || fail "(11) an unverified doorbell left the index claiming settled: true"
import json, sys
d = json.load(open(sys.argv[1]))
for it in d["items"]:
    assert not it.get("settled"), it
    assert it["reply"] == "settle-only", it
assert "settle NOTHING" not in d["instructions"], d["instructions"]
PY
grep -q 'DELIVERY UNCONFIRMED' "$BUS/payloads"/*.md 2>/dev/null \
  || fail "(11) the notice claimed a failure the courier cannot observe (expected UNCONFIRMED wording)"
echo "courier-auto-settle: (11) an unverified doorbell writes no receipt and wakes the sender instead: ok"

# ---- (12) the delivery deadline still fires delivery-failed (R3) -------------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note f1 alice 'never lands' >/dev/null 2>&1
touch "$WORK/tmux/busy.sess_0_0"          # the recipient never becomes ready
: > "$LOG"
drain "$(( $(meta_field f1 deadline_epoch) + 1 ))"
rm -f "$WORK/tmux/busy.sess_0_0"
woke_with_kind delivery-failed || fail "(12) the delivery deadline did not wake the sender"
[ ! -f "$BUS/receipts/f1.done" ] || fail "(12) an undelivered body was settled"
# …and the sender must be able to ACT on that notice. Terminalize promotes the body
# and drops the spool entry, so without a terminal receipt the id is listed by
# `tap outstanding` forever and clearable by nothing: `tap done` is the addressee's
# verb, plain `tap cancel` refuses a live recipient, and `--spooled` refuses a
# canonical payload. The courier announced it stopped trying; the queue has to be
# able to reflect that.
[ -f "$BUS/receipts/f1.cancelled" ] || fail "(12) expiry left no terminal receipt — the sender's outstanding can never clear"
python3 -B - "$BUS/receipts/f1.cancelled" <<'PY12' || fail "(12) the terminal receipt claims the wrong thing"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["via"] == "cancelled", d          # NOT done: the seat never saw this body
assert d["reason"] == "deadline_reached", d
assert d["status"] == "cancelled", d
PY12
[ ! -f "$BUS/receipts/f1.done" ] || fail "(12) an undelivered body was recorded as received"
[ -f "$BUS/payloads/f1.md" ] || fail "(12) the payload the notice pointed at is gone"
# ABSENCE IS EVIDENCE ONLY IF THE READ SUCCEEDED. `$(… || true)` turns any failure
# into an empty string, and empty does not contain the id — so this assertion
# passed with the command replaced by `false`. The read is now checked first: exit
# 0 (outstanding exits 0 whether or not sends are open; non-zero means the read
# failed), parseable JSON, and the right agent — and only then is the id's absence
# meaningful.
set +e
OUT12="$(bash "$TAPSH" outstanding alice --json 2>/dev/null)"; RC12=$?
set -e
[ "$RC12" -eq 0 ] || fail "(12) could not read the sender's outstanding (rc $RC12) — absence proves nothing"
python3 -B - "$OUT12" <<'PY12B' || fail "(12) the id is still outstanding after the courier gave up on it, or its queue could not be read"
import json, sys
d = json.loads(sys.argv[1])          # unparseable => the read failed => assertion void
assert d.get("ok") is True, d
assert d.get("agent") == "alice", d
assert "f1" not in {i.get("id") for i in d.get("outstanding", [])}, d
PY12B
echo "courier-auto-settle: (12) an auto-settle park that never lands fires delivery-failed AND records a clearable terminal state: ok"

# (23) retired with the courier .done writer; recipient-read immutability has its own controls.

# ---- (13) retention: a pre-settled index outlives its own terminality --------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note t1 alice retained >/dev/null 2>&1
drain
IDX="$(digest_index)"; [ -n "$IDX" ] || fail "(13) no index written"
bash "$TAPSH" read t1 --by peer >/dev/null 2>&1 || fail "(13) recipient could not settle item"
reap_digests; reap_digests
[ -f "$IDX" ] || fail "(13) the index the recipient was just pointed at was reaped as all-terminal"
# One-shot drains leave cleanup to watch; exercise the native retention owner.
TAP_DIGEST_RETAIN_SECONDS=0 reap_digests
[ ! -f "$IDX" ] || fail "(13) the index survived past its retention window"
echo "courier-auto-settle: (13) a pre-settled index is retained past all-terminal until its window elapses: ok"

# ---- (14) tap cancel withdraws a held body -----------------------------------
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG legacy_note k1 alice recalled >/dev/null 2>&1
# The retract window ends at DELIVERY, and a held body has not been delivered —
# so the existing undelivered-withdrawal verb applies unchanged. Plain `cancel`
# still refuses against a live seat (tap-cm00's rule, untouched by this class);
# `--spooled` is the assertion of undelivered residency that unlocks it.
set +e
CANCEL_PLAIN="$(TAP_JSON=1 bash "$TAPSH" cancel k1 --by alice 2>&1)"; CANCEL_RC=$?
set -e
[ "$CANCEL_RC" = "1" ] || fail "(14) plain cancel against a live seat should still refuse, got $CANCEL_RC"
bash "$TAPSH" cancel k1 --by alice --spooled >/dev/null 2>&1 || fail "(14) --spooled cancel refused a spooled-undelivered body"
[ -f "$BUS/receipts/k1.cancelled" ] || fail "(14) cancel wrote no .cancelled receipt"
: > "$LOG"
drain "$HOLD_LONG$HOLD_LONG"
[ "$(digest_count)" = "0" ] || fail "(14) a cancelled body was still delivered"
echo "courier-auto-settle: (14) the retract window runs to delivery: a held body can be cancelled: ok"

# ---- (21) a held digest member lock excludes sender withdrawal -------------------
# The real cancel competes after digest revalidation and before post-submit
# bookkeeping. It must refuse the member lock before taking a spool claim,
# preserving both members.
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note wd1 alice 'claimed mid-flight' >/dev/null 2>&1
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note wd2 alice stays >/dev/null 2>&1
FAKE_AT_DIGEST_SUBMIT="bash '$TAPSH' cancel wd1 --by alice --spooled --json > '$WORK/claimed-cancel.out' 2>&1; printf '%s' \"\$?\" > '$WORK/claimed-cancel.rc'" drain
[ "$(cat "$WORK/claimed-cancel.rc")" = 1 ] || fail "(21) cancel acquired custody inside a claimed digest"
python3 -B - "$WORK/claimed-cancel.out" <<'PY21LOCK' || fail "(21) cancel did not name the held member obligation"
import json, sys
result = json.load(open(sys.argv[1]))
assert result['error_class'] == 'obligation_busy', result
PY21LOCK
[ ! -f "$BUS/receipts/wd1.cancelled" ] || fail "(21) competing cancel wrote withdrawal"
[ ! -f "$BUS/receipts/wd1.done" ] || fail "(21) courier settled an unread member"
IDXWD="$(digest_index)"; [ -n "$IDXWD" ] || fail "(21) no index written"
python3 -B - "$IDXWD" <<'PY21' || fail "(21) digest claim did not preserve both members"
import json, os, sys
d = json.load(open(sys.argv[1]))
assert {it['id'] for it in d['items']} == {'wd1', 'wd2'}, d
for it in d['items']:
    assert os.path.exists(it['path']), it
    assert not it.get('settled'), it
PY21
[ ! -f "$BUS/receipts/wd2.done" ] || fail "(21) courier marked the surviving item read"
[ ! -f "$BUS/spool/wd1.claim" ] && [ ! -f "$BUS/spool/wd2.claim" ] \
  || fail "(21) digest leaked a member claim"
echo "courier-auto-settle: (21) a digest member lock excludes cancellation and preserves unread members: ok"

# Synthetic receipt control: terminality alone must never claim settlement.
# This plants a cancellation receipt while canonical bytes remain; public
# cancel cannot enter this claimed transaction window (arm 21 above).
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note wd3 alice 'cancelled but present' >/dev/null 2>&1
FAKE_AT_DIGEST_SUBMIT="mkdir -p '$BUS/receipts' && printf '%s' '{\"id\":\"wd3\",\"via\":\"cancelled\"}' > '$BUS/receipts/wd3.cancelled'" drain
[ -f "$BUS/receipts/wd3.cancelled" ] || fail "(21b) fixture premise: no .cancelled receipt was planted"
[ ! -f "$BUS/receipts/wd3.done" ] || fail "(21b) a cancelled id was given a courier-auto receipt"
IDXWD3="$(digest_index)"; [ -n "$IDXWD3" ] || fail "(21b) no index written"
python3 -B - "$IDXWD3" <<'PY21B' || fail "(21b) a cancelled id was published as settled — terminality was read as delivery"
import json, sys
d = json.load(open(sys.argv[1]))
for it in d["items"]:
    if it["id"] == "wd3":
        assert not it.get("settled"), it
        assert it["reply"] == "settle-only", it
PY21B
echo "courier-auto-settle: (21b) a cancelled-but-present id is not published as settled: ok"

# ---- (22) a failed index rewrite is loud, and never costs the pointer ---------
# The doorbell has landed and the seat holds the pre-delivery instructions. That is
# recoverable — `tap done` on a settled id names its receipt — but two things must
# not happen: silence, and losing the file the sentinel points at. The old index
# carries no `settled` rows while every receipt is terminal, so a retention rule
# keyed on those rows would have reaped it on the very next cleanup.
reset_bus
TAP_AUTOSETTLE_HOLD_SECONDS=0 legacy_note rf1 alice 'rewrite will fail' >/dev/null 2>&1
: > "$LOG"
FAKE_AT_DIGEST_SUBMIT="chmod a-w '$BUS/spool/digests'" drain_err "$WORK/rewrite.err"
chmod u+w "$BUS/spool/digests"
[ ! -f "$BUS/receipts/rf1.done" ] || fail "(22) courier created a settlement receipt"
bash "$TAPSH" read rf1 --by peer >/dev/null 2>&1 || fail "(22) recipient could not read the delivered item"
grep -q 'index could not be rewritten' "$WORK/rewrite.err" || fail "(22) the rewrite failure was discarded — the drain reported a clean success"
IDXRF="$(digest_index)"; [ -n "$IDXRF" ] || fail "(22) the index was lost outright"
reap_digests; reap_digests
[ -f "$IDXRF" ] || fail "(22) the delivered doorbell's index was reaped — the woken seat is pointed at a missing file"
echo "courier-auto-settle: (22) a failed index rewrite keeps its retention window: ok"

# (20) retired: the courier has no settlement write to fail.

# ---- (19) an early park keeps the class: mid-clear recipient ------------------
# Three gates park a send BEFORE the eligibility block is reached, and each used
# to hand it `standard`. That silently demotes an eligible send: the drain then
# redelivers it individually — the wake this feature exists to remove — and writes
# no receipt, so the sender stays outstanding until the recipient settles by hand.
# The clearing fence is the reachable one: a seat mid-`tap clear` is routine.
reset_bus
mkdir -p "$BUS/clear-fence"
python3 -B - "$BUS" peer <<'PY'
import json, os, sys, time
bus, handle = sys.argv[1], sys.argv[2]
path = os.path.join(bus, "clear-fence", handle + ".json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({"nonce": "fence-nonce", "since": "2099-01-01T00:00:00Z",
           "since_epoch": time.time(), "pid": 2147483646, "handle": handle,
           "harness": "codex", "ceiling_seconds": 45}, open(path, "w"))
PY
TAP_AUTOSETTLE_HOLD_SECONDS=0 send peer -m "arrived mid-clear" --id cf1 --from alice --fyi >/dev/null 2>&1
rm -f "$BUS/clear-fence/peer.json"
[ -f "$BUS/spool/cf1.md" ] || fail "(19) the mid-clear send did not park"
[ "$(meta_field cf1 reason)" = "clearing" ] || fail "(19) fixture premise: expected a clearing park, got '$(meta_field cf1 reason)'"
[ "$(meta_field cf1 policy)" = "standard" ] || fail "(19) the clearing park demoted an eligible send to '$(meta_field cf1 policy)' — it will take its own wake and settle by hand"
: > "$LOG"
drain
injected cf1 || fail "(19) clearing park was not delivered when the fence lifted"
[ ! -f "$BUS/receipts/cf1.done" ] || fail "(19) delivered without the courier-auto receipt"
echo "courier-auto-settle: (19) a send parked by the clearing fence keeps its auto-settle class: ok"

# ---- (18) an unbound manual relay still injects (no new hard failure) --------
# `--cross-worktree --pane` is the operator's exact-session escape: no registry
# row, and the spool refuses every unbound park by design. An eligible settle-only
# send that reached the park would therefore turn a supported immediate-only path
# into a hard error — a regression on a path that worked before this feature, paid
# for by a class this feature does not even apply to.
reset_bus
set +e
UNBOUND_OUT="$(send peer -m "manual relay" --id ub1 --from alice --fyi \
  --cross-worktree --pane "$PANE" 2>&1)"; UNBOUND_RC=$?
set -e
[ "$UNBOUND_RC" = "0" ] || fail "(18) an unbound manual relay now fails (rc $UNBOUND_RC): $UNBOUND_OUT"
injected ub1 || fail "(18) the unbound relay did not inject — it has no park to fall back to"
[ ! -f "$BUS/spool/ub1.md" ] || fail "(18) an unbound send reached the spool, which refuses unbound parks"
echo "courier-auto-settle: (18) an unbound manual relay keeps its inject-or-fail path: ok"

# ---- (17) cross-team: the sender is woken AND the entry is terminalized -------
# The failure this must catch is not "no notice" — it is a PERMANENTLY STUCK
# entry. the escalation notice used to look the sender up in the
# registry the send BOUND (the recipient's), which cross-team does not contain
# them; it returned 1, and because the deadline call site has the terminalize
# inside the `&&`, the entry stayed escalated and every later drain skipped it.
#
# A same-team arm cannot fail on this — the two registries are the same file — so
# this one gives the recipient its own team registry, which knows nothing of the
# sender. Both halves are asserted: the wake, and the terminal state.
reset_bus
FOREIGN="$WORK/foreign-registry.json"
cat > "$FOREIGN" <<JSON
{ "schema": "0.20", "team": { "name": "u", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer": { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
XSRC="$WORK/src-x2.md"; printf '%s
' '---' '---' "cross-team body" > "$XSRC"
XCANON="${TAP_PAYLOADS}/x2.md"
canonical_place_fixture "$XSRC" x2 alice peer discuss "$XCANON" 1 settle-only t u >/dev/null 2>&1
TAP_AUTOSETTLE_HOLD_SECONDS=0 spool_park_fixture x2 "$XCANON" peer t auto-settle "" "" "$PANE" "$PANE_ID" u autosettle "" "$FOREIGN" >/dev/null
rm -f "$XCANON"
[ -f "$BUS/spool/x2.md" ] || fail "(17) setup: cross-team entry not parked"
touch "$WORK/tmux/busy.sess_0_0"          # never deliverable, so the deadline path runs
: > "$LOG"
drain "$(( $(meta_field x2 deadline_epoch) + 1 ))"
rm -f "$WORK/tmux/busy.sess_0_0"
woke_with_kind delivery-failed || fail "(17) the sender was never woken — the notice resolved the sender through the recipient's registry"
[ -f "$BUS/spool/x2.md" ] && fail "(17) the entry was never terminalized: it stays escalated and every later drain skips it (permanent limbo)"
echo "courier-auto-settle: (17) a cross-team park wakes its sender and terminalizes: ok"

# ---- (16) THE ACCEPTANCE ARM: the hold clock alone delivers ------------------
# Ported to Bun: runtime/bun/test/waiter-lifetime.test.ts ("an autosettle hold's
# owned deliverer rings one doorbell for both rows at the hold's expiry") parks
# through the production mintMeta shape and asserts the single courier-minted
# doorbell, the unmarked receipts, the emptied spool and the claim-free teardown.
# The retired control half (a bus with no actor) was dropped — a sandbox with no
# process cannot fail; the owned-lifetime shape plus the owned-list RED
# (spool-waiter-loop.ts:49, "autosettle-hold" removed from waiterDeadline) now
# carry what the control used to claim.

# ---- (24) A PARK SPAWNS ITS OWN DELIVERER ------------------------------------
# The other half of what (16) used to prove, split out by tap-1hsj so neither half
# needs a race to reach the other. (16) proves the deliverer DELIVERS on the hold
# clock; this proves a park actually starts one. Without it, tap-send.sh could stop
# calling tap_spool_spawn_deliverer and (16) — which now launches its own — would
# stay green while the feature had no scheduled actor at all and delivery fell back
# to whichever seat happened to run a verb next.
#
# Capture the production waiter's child and join it through a copied entry shim.
# The send/park/spawn code is unchanged; scriptsDir locates this copied package.
export A24_DELIVERER="$ROOT/runtime/bun/src/spool-waiter.ts" A24_STATE="$WORK/a24"
mkdir -p "$A24_STATE/package/bin" "$A24_STATE/package/runtime/bun" "$A24_STATE/package/skills/tap"
cp "$ROOT/bin/tap" "$A24_STATE/package/bin/tap"
cp -R "$ROOT/runtime/bun/src" "$A24_STATE/package/runtime/bun/src"
# fzf-tool.ts imports ../../../vendor/fzf/manifest.json relative to the copied src.
mkdir -p "$A24_STATE/package/vendor/fzf"; cp "$ROOT/vendor/fzf/manifest.json" "$A24_STATE/package/vendor/fzf/manifest.json"
cp "$ROOT/runtime/bun/main.ts" "$A24_STATE/package/runtime/bun/main.ts"
cp -R "$ROOT/skills/tap/scripts" "$A24_STATE/package/skills/tap/scripts"
cat > "$A24_STATE/package/runtime/bun/src/spool-waiter.ts" <<'BUN_PROBE'
import {writeFileSync,renameSync} from "node:fs";
const state=process.env.A24_STATE!;
const child=Bun.spawn([process.execPath,process.env.A24_DELIVERER!,...process.argv.slice(2)],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});
writeFileSync(state+"/id",process.argv[2]+"\n");
writeFileSync(state+"/pid.tmp",child.pid+"\n"); renameSync(state+"/pid.tmp",state+"/pid");
const rc=await child.exited;
writeFileSync(state+"/status.tmp",rc+"\n"); renameSync(state+"/status.tmp",state+"/status");
process.exitCode=rc;
BUN_PROBE
reset_bus
rm -f "$BUS/tap-deliver.log"
_probe_id="a24s$$"
A24_ACTIVE=1
unset TAP_SPOOL_DISABLE_DELIVERER
touch "$WORK/tmux/busy.sess_0_0"
TAP_AUTOSETTLE_HOLD_SECONDS=$HOLD_LONG bash "$A24_STATE/package/bin/tap" send peer -m "spawn probe" --id "$_probe_id" --from alice --fyi >/dev/null 2>&1
export TAP_SPOOL_DISABLE_DELIVERER=1
_deadline=$((SECONDS + 15))
while [ ! -s "$A24_STATE/pid" ] && [ "$SECONDS" -lt "$_deadline" ]; do sleep 0.2; done
[ -s "$A24_STATE/pid" ] || fail "(24) spawn observation refused: missing recorded deliverer pid"
_spid="$(cat "$A24_STATE/pid")"
[[ "$_spid" =~ ^[1-9][0-9]*$ ]] || fail "(24) spawn observation refused: invalid deliverer pid '$_spid'"
_sid="$(cat "$A24_STATE/id")" || fail "(24) spawn observation refused: missing deliverer id"
[ "$_sid" = "$_probe_id" ] || fail "(24) spawned deliverer id '$_sid' does not match probe '$_probe_id'"
# Withdraw the still-held entry through the real verb, then let its owner finish
# normally. Its join covers the drain's children and final bookkeeping too.
bash "$TAPSH" cancel "$_probe_id" --by alice --spooled >"$WORK/a24-cancel.log" 2>&1 \
  || fail "(24) could not withdraw probe before joining deliverer"
A24_JOIN_DEADLINE=$((SECONDS + 120))
while [ ! -s "$A24_STATE/status" ] && [ "$SECONDS" -lt "$A24_JOIN_DEADLINE" ]; do sleep 0.2; done
[ -s "$A24_STATE/status" ] || fail "(24) join refused: missing exit status for recorded deliverer $_spid"
_src="$(cat "$A24_STATE/status")"
[ "$_src" = 0 ] || fail "(24) recorded deliverer $_spid exited with status $_src"
echo "courier-auto-settle: (24) an eligible park spawns its own bounded deliverer: ok"

echo "courier-auto-settle: ok"
