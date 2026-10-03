#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# courier-digest.test.sh — tap-ix63: courier coalesces N>=2 plain-redeliverable
# spool entries for one bound recipient into ONE kind=digest wake + a courier-owned
# index, WITHOUT collapsing the N per-payload obligations. Covers the eight
# acceptance smokes in tmp/design/ix63-courier-digest.md §7.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

export TAP_TUI_SETTLE_SCALE=0.1
export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/scripts/tap.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
while [[ "${1:-}" == -L || "${1:-}" == -S ]]; do shift 2; done
cmd="$1"; shift
# Native effects reach this executable directly, under the real digest claims.
before_paste() {
  [ -z "${FAKE_LATE_CANCEL:-}" ] || printf '{}' > "$TAP_HOME/receipts/$FAKE_LATE_CANCEL.cancelled"
  if [ -n "${FAKE_DIGEST_HOLDING:-}" ]; then
    : > "$FAKE_DIGEST_HOLDING"
    for _ in $(seq 1 150); do
      [ ! -e "$FAKE_DIGEST_RELEASE" ] || return 0
      sleep 0.05
    done
    echo 'digest fixture release timed out' >&2; exit 1
  fi
}
after_final_identity() {
  # The completion Enter is the second Enter. The ensuing native identity
  # read follows the verifier's final registry sample, still before claim release.
  if [ -n "${FAKE_DROP_PEER_REGISTRY:-}" ] && [ "$(cat "$state/enters" 2>/dev/null || echo 0)" -ge 2 ] \
     && [ ! -e "$state/peer-dropped" ]; then
    python3 -I -B - "$FAKE_DROP_PEER_REGISTRY" <<'DROP'
import json, sys
from pathlib import Path
path = Path(sys.argv[1]); doc = json.loads(path.read_text())
doc['seats'].pop('peer', None); path.write_text(json.dumps(doc))
DROP
    : > "$state/peer-dropped"
  fi
}
observed_command() {
  if [ "${FAKE_EXIT_AT_DIGEST:-0}" = 1 ] && compgen -G "$TAP_HOME/spool/digests/*.json" >/dev/null; then
    printf zsh
  else printf '%s' "${FAKE_TMUX_CMD:-codex}"
  fi
}
case "$cmd" in
  list-sessions)
    printf 'sess\t4242:100\n'
    ;;
  list-panes)
    count_file="$state/list-panes.count"
    count=0
    [ ! -f "$count_file" ] || count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
    pane_cmd="$(observed_command)"
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "$pane_cmd"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    case "$fmt" in
      # The native pane observer (tmux.ts observePaneResult): server identity, then the
      # four-field pane record — the pane-effect flash runs natively (spool-park-report.ts),
      # so a fixture that answers only the Bash formats sees no tint at all.
      # The Bash observer's 3-field fmt (tap_pane_observe) also matches
      # *pid*start_time*, so it is answered first: the server-identity hard gate reads
      # pane id + epoch from that one probe, and an epoch answer defers the
      # clobber as "pane generation unobservable".
      *pane_id*session_name*start_time*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pid*start_time*) echo "4242:100" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        printf '%s\tsess\t4242\t%s\t0\n' "${FAKE_PANE_ID:-%401}" "$(observed_command)"
        after_final_identity ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${FAKE_PANE_ID:-%401}" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "${FAKE_PANE_ID:-%401}" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) observed_command ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  select-pane) echo "$*" >> "$state/tint.log" ;;
  # The park/flash cue tints pane-scoped window styles (no select-pane: focus theft).
  set-option) case "$*" in *" -u "*) : ;; *) echo "$*" >> "$state/tint.log" ;; esac ;;
  capture-pane)
    if [ -f "$state/busy" ]; then printf 'model is generating a response...\n'
    elif [ -f "$state/input" ]; then printf '❯ %s\n' "$(cat "$state/input")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    [ "${1:-}" = "-t" ] && shift 2
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then rm -f "$state/copy_mode"; exit 0; fi
    case "${1:-}" in
      -l) before_paste; shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; exit 0 ;;
      C-u) rm -f "$state/input"; exit 0 ;;
      Enter)
        printf '%s\n' "$(( $(cat "$state/enters" 2>/dev/null || echo 0) + 1 ))" > "$state/enters"
        if [ "${FAKE_TMUX_STUCK_DIGEST_SUBMIT:-0}" = 1 ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input" 2>/dev/null; then
          exit 0
        fi
        rm -f "$state/input"
        exit 0
        ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo" FAKE_TMUX_CMD="codex" FAKE_PANE_ID="%401"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
mkdir -p "$WORK/tmux" "$WORK/repo"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/spool"; export TAP_HOME="$BUS"
tap_smoke_enroll_current "$WORK/repo" "$BUS" t
REG="$BUS/registry.json"
cat > "$REG" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "peer":   { "session": "sess", "pane": "sess:0.0", "pane_id": "%401", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "alice":  { "session": "sess", "pane": "sess:0.1", "pane_id": "%402", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" },
    "bob":    { "session": "sess", "pane": "sess:0.2", "pane_id": "%403", "harness": "codex", "status": "active", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

PANE="sess:0.0"; PANE_ID="%401"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"
. "$ROOT/skills/tap/scripts/smoke/spool-park-fixture.sh"
. "$ROOT/skills/tap/scripts/smoke/canonical-place-fixture.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
tap_ensure_dirs

digest_log()   { grep -cE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$WORK/tmux/send-keys.log" 2>/dev/null | tr -d ' ' || echo 0; }
spool_count()  { find "$BUS/spool" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' '; }
canon_count()  { find "$BUS/payloads" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' '; }
digest_index() { find "$BUS/spool/digests" -maxdepth 1 -name '*.json' 2>/dev/null; }
reset_bus() {
  rm -rf "$BUS/payloads"/*.md "$BUS/receipts"/*.done "$BUS/receipts"/*.cancelled \
         "$BUS/spool"/*.md "$BUS/spool"/*.meta.json* "$BUS/spool"/*.claim \
         "$BUS/spool/digests" 2>/dev/null || true
  : > "$WORK/tmux/send-keys.log"
  rm -f "${WORK:?}/tmux/list-panes.count" "${WORK:?}/tmux/enters" "${WORK:?}/tmux/peer-dropped"
}
mk_spool() { # <id> <from> <reply> <policy> [recipient_instance]
  local id="$1" from="$2" reply="$3" policy="$4" rinst="${5:-}" src canon
  src="$WORK/src-$id.md"
  printf '%s\n' '---' '---' "body of $id from $from" > "$src"
  canon="${TAP_PAYLOADS}/$id.md"
  canonical_place_fixture "$src" "$id" "$from" peer discuss "$canon" 0 "$reply" t t "" "" "" "$rinst" >/dev/null 2>&1
  spool_park_fixture "$id" "$canon" peer t no-input-prompt busy 600 "$PANE" "$PANE_ID" t "$policy" "" "$REG" >/dev/null
  rm -f "$canon"
}
drain() { bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB"; }

# ---- (0) identity drift at the effect boundary leaves the batch untouched ----
reset_bus
mk_spool d0-a alice expected standard
mk_spool d0-b bob   expected standard
export FAKE_EXIT_AT_DIGEST=1
RC0=0
spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" d0-a d0-b || RC0=$?
unset FAKE_EXIT_AT_DIGEST
[ "$RC0" = "1" ] || { echo "digest: (0) identity drift should refuse the digest, got $RC0" >&2; exit 1; }
[ -f "$BUS/spool/d0-a.md" ] && [ -f "$BUS/spool/d0-b.md" ] || { echo "digest: (0) identity drift lost a spooled payload" >&2; exit 1; }
[ "$(canon_count)" = "0" ] || { echo "digest: (0) identity drift canonicalized before a verified submit" >&2; exit 1; }
[ -z "$(digest_index)" ] || { echo "digest: (0) identity drift left an orphan digest index" >&2; exit 1; }
[ ! -s "$WORK/tmux/send-keys.log" ] || { echo "digest: (0) identity drift caused a tmux effect" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ -z "$(find "$BUS/spool" -name '*.claim' 2>/dev/null)" ] || { echo "digest: (0) identity drift leaked a claim" >&2; exit 1; }

# (0b)-(0d) moved with the native ownership boundary to
# runtime/bun/test/spool-drain-effects.test.ts: unavailable pre-effect observation,
# lost post-submit response for 0/5/124/7, and member admission failures. Those
# tests call the live native submit-plus-custody owner.

# ---- (0e) an unreadable sidecar drops its entry without leaking the transaction ----
# WHAT THIS ARM DOES NOT PROVE, stated first because it was written believing otherwise: it is
# NOT a control for the `|| true` on the adapter's `rm -f`. Two independent reasons, both
# established rather than reasoned — the mutation survived (dropping the guard leaves this file
# green), and a reviewer named the second: planting the directory BEFORE inject means
# revalidation's own `[ -f ]` on the metadata path drops the entry before any rm runs, so the
# custody loop is never reached. The guard stays as faithfulness to the incumbent's tolerance,
# with no reachable failure under any live calling shape (every caller invokes the transaction
# with errexit already suppressed for its whole body), and it is named that way in the PR body.
# Restaging the plant to manufacture a control for an unreachable failure was considered and
# refused by the reviewer who asked for the arm.
#
# What it DOES assert, which is worth its own arm: an entry whose sidecar cannot be read drops
# out of the batch the way the incumbent's `[ -f ]` dropped it, the transaction refuses
# cleanly, and it leaves behind neither a claim nor a ledger.
reset_bus
mk_spool d0e-a alice expected standard
mk_spool d0e-b bob   expected standard
rm -f "$BUS/spool/d0e-a.meta.json"; mkdir -p "$BUS/spool/d0e-a.meta.json/wedged"
RC0E=0
spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" d0e-a d0e-b || RC0E=$?
# rc 2 is the expected verdict and the reason is the point: the directory makes the entry
# unreadable, revalidation drops it, one ordinary survivor is not a digest, and the caller is
# handed it back for the per-id path. rc 0 is accepted only because an auto-settle batch would
# legitimately proceed with one member.
[ "$RC0E" = "2" ] || [ "$RC0E" = "0" ] || { echo "digest: (0e) an unreadable sidecar changed the verdict to $RC0E" >&2; exit 1; }
# Whatever the batch decided, the transaction must not leave its bookkeeping behind.
[ -z "$(find "$BUS/spool" -name '*.claim' 2>/dev/null)" ] || { echo "digest: (0e) an unreadable sidecar leaked a claim" >&2; exit 1; }
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'tap-digest-inject.*.claims' 2>/dev/null)" ] || { echo "digest: (0e) an unreadable sidecar stranded a claim ledger" >&2; exit 1; }

# ---- (0f) census rows 4 and 5: terminality arriving late changes NOTHING ----
# The rule-50 census lists two decisions that deliberately consult no terminality: admitting
# the attempt and submitting, and moving spool->canonical afterwards. Both match the incumbent.
# Rule 56 does not exempt an absence row (partner review) — an absence IS a decision, and a
# decision with no control decays into a claim about what was intended. So this arm plants the
# terminal receipt AFTER revalidation has passed, which is the window `tap cancel --spooled`
# actually races, and asserts the attempt is still admitted and custody still moves.
reset_bus
mk_spool d0f-a alice expected standard
mk_spool d0f-b bob   expected standard
# WHAT THIS ARM HAS TO CLEAN UP, AND HOW THAT WAS ESTABLISHED. It is the only new arm that
# completes a VERIFIED digest, so it is the only one whose outcome row has `stampClock=1` —
# and `tap_delivery_clock_stamp` writes `<bus>/delivery/<handle>.json`, which `reset_bus` does
# not clear. That clock gave arm (1)'s freshly spooled entries a ten-second hold
# (`hold_until_epoch` = `first_spooled_epoch` + 10 with this arm present, equal without it),
# so its drain ran inside the window and injected nothing.
#
# Two wrong guesses preceded that measurement — an exported `TAP_DELIVERY_NEW_ATTEMPT`, and a
# leaked function definition — and a subshell fixed neither, because neither was the cause.
# The diff that settled it dumps what the drain SEES, after `reset_bus` and `mk_spool`; an
# earlier dump placed before `reset_bus` showed only state that reset was about to clear.
# The subshell stays: containing an arm's shell effects is right regardless of which effect
# turned out to matter.
RC0F=0
FAKE_LATE_CANCEL=d0f-a spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" d0f-a d0f-b || RC0F=$?
[ "$RC0F" = "0" ] || { echo "digest: (0f) a late cancel changed the verdict to $RC0F" >&2; exit 1; }
# Row 5: the attempt was admitted despite the terminal receipt arriving.
[ -f "$BUS/receipts/d0f-a.attempted" ] || { echo "digest: (0f) a late cancel suppressed the attempt marker" >&2; exit 1; }
# Row 4: custody moved for BOTH members, the cancelled one included.
for id in d0f-a d0f-b; do
  [ -f "$BUS/payloads/$id.md" ] || { echo "digest: (0f) $id was not canonicalized" >&2; exit 1; }
  [ ! -f "$BUS/spool/$id.md" ] || { echo "digest: (0f) $id kept a retryable spool copy" >&2; exit 1; }
done
[ -z "$(find "$BUS/spool" -name '*.claim' 2>/dev/null)" ] || { echo "digest: (0f) a late cancel leaked a claim" >&2; exit 1; }
# The verified digest above stamped the recipient's delivery clock. Leaving it would hold the
# next arm's sends for the batching window — which is what it did.
rm -rf "$BUS/delivery"
rm -f "$BUS/receipts"/d0f-*.attempted "$BUS/receipts"/d0f-*.cancelled

# ── tap-52ys: 9 of 11 arms removed (ratified 2026-08-14) ────────────────────
# grok's call: burst-collapse and racing-CAS are optimization behavior, not a
# shipping invariant. What survives is the settlement seam — a digest id is not
# a settleable payload, and per-id settle still works — plus the burst that
# builds the index it refuses on, which is its setup.
#
# Accepted gap, named: index GC, urgent-solo ordering, racing drain CAS,
# inject-failure discard, oversized split, mixed reply= classes, and the
# foreign to_team poll gate.


# ---- (1) burst: 3 plain rows -> ONE digest, index count=3, 3 obligations remain --
reset_bus
mk_spool d1-a alice expected standard
mk_spool d1-b bob   expected standard
mk_spool d1-c alice settle-only standard
drain
[ "$(digest_log)" = "1" ] || { echo "digest: (1) expected exactly one kind=digest inject, got $(digest_log)" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
[ "$(spool_count)" = "0" ] || { echo "digest: (1) spool not fully drained into the digest" >&2; exit 1; }
[ "$(canon_count)" = "3" ] || { echo "digest: (1) 3 payloads should be canonical after the verified submit, got $(canon_count)" >&2; exit 1; }
IDX="$(digest_index)"; [ -n "$IDX" ] && [ -f "$IDX" ] || { echo "digest: (1) no index written" >&2; exit 1; }
python3 -B - "$IDX" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["count"] == 3, d
assert d["kind"] == "digest", d
assert d["from"] == "t/courier", d
assert {it["id"] for it in d["items"]} == {"d1-a", "d1-b", "d1-c"}, d
for it in d["items"]:
    assert it["path"].endswith("/payloads/" + it["id"] + ".md"), it
assert "records its own read separately" in d["instructions"] and "reply=" in d["instructions"], d
PY
# The digest sentinel carries the courier envelope shape, not the payload ids.
# v0.23: `from=`/`to=` left the wire entirely. What remains observable about the
# digest's identity is the id's own handle field, which is literally `courier`
# (an id minted off TAP_COURIER_IDENTITY) -- and the ABSENCE of a `<team>/` prefix,
# which is structural rather than incidental: the digest renders both halves off
# the same to_team, so it can never be cross-team and can never take a prefix.
grep -qE '\[\[TAP v[0-9.]+ note courier-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}( |$)' "$WORK/tmux/send-keys.log" || { echo "digest: (1) digest sentinel is not an unprefixed courier-minted note" >&2; cat "$WORK/tmux/send-keys.log" >&2; exit 1; }
# 3 obligations remain: three canonical payloads, none settled yet.
[ "$(find "$BUS/receipts" -name '*.done' | wc -l | tr -d ' ')" = "0" ] || { echo "digest: (1) nothing should be settled yet" >&2; exit 1; }
echo "digest: (1) burst of 3 plain rows -> one digest wake, index count=3, obligations intact: ok"


# ---- (2) tap reply <digest-id> REFUSES (teaching error); per-id read still works --
DIGEST_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["digest_id"])' "$IDX")"
# The retired tap done tombstone reads no payload, so it has no digest-specific answer.
set +e
REPLY_OUT="$(TAP_JSON=1 bash "$TAPSH" reply "$DIGEST_ID" -m "ack" --by peer 2>&1)"; REPLY_RC=$?
set -e
[ "$REPLY_RC" = "1" ] || { echo "digest: (2) replying to the digest id should refuse, got $REPLY_RC" >&2; echo "$REPLY_OUT" >&2; exit 1; }
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="not_obligation", d' "$REPLY_OUT" \
  || { echo "digest: (2) reply refusal class wrong" >&2; echo "$REPLY_OUT" >&2; exit 1; }
# .96: reading the envelope records it, without settling any member.
if bash "$TAPSH" read "$DIGEST_ID" --by alice >/dev/null 2>&1; then
  echo 'digest: wrong recipient read the envelope' >&2; exit 1
fi
[ ! -f "$BUS/receipts/$DIGEST_ID.read" ] || exit 1
bash "$TAPSH" read "$DIGEST_ID" --by peer >/dev/null || exit 1
[ -f "$BUS/receipts/$DIGEST_ID.read" ] || exit 1
[ ! -f "$BUS/receipts/d1-c.done" ] || { echo 'digest: envelope read settled a member' >&2; exit 1; }
cp "$BUS/receipts/$DIGEST_ID.read" "$WORK/digest-read-before"
bash "$TAPSH" read "$DIGEST_ID" --by peer >/dev/null || exit 1
cmp "$BUS/receipts/$DIGEST_ID.read" "$WORK/digest-read-before" || exit 1
# Per-id note settlement uses read; ASK rows remain open.
bash "$TAPSH" read d1-c --by peer >/dev/null 2>&1 || { echo "digest: (2) per-id tap read d1-c failed" >&2; exit 1; }
[ -f "$BUS/receipts/d1-c.done" ] || { echo "digest: (2) per-id read wrote no receipt" >&2; exit 1; }
echo "digest: (2) tap reply on the digest id refuses with a teaching error; per-id settle works: ok"

bash "$TAPSH" read "$DIGEST_ID" --by peer --all >/dev/null || exit 1
[ -f "$BUS/receipts/d1-a.read" ] && [ -f "$BUS/receipts/d1-b.read" ] || exit 1
[ ! -f "$BUS/receipts/d1-a.done" ] && [ ! -f "$BUS/receipts/d1-b.done" ] || exit 1
echo "courier-digest: ok"

# An unverified first submit can leave its doorbell in the composer. Per-item
# reads must not let another drain remove the envelope that doorbell names.
reset_bus
mk_spool retained-a alice settle-only standard
mk_spool retained-b bob settle-only standard
rc=0
FAKE_TMUX_STUCK_DIGEST_SUBMIT=1 spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" retained-a retained-b || rc=$?
[ "$rc" = 5 ] || { echo "digest: failed-first expected unverified submit, got $rc" >&2; exit 1; }
RIDX="$(digest_index)"
[ -f "$RIDX" ] && [ -s "$WORK/tmux/input" ] || { echo 'digest: failed-first did not preserve staged envelope' >&2; exit 1; }
for rid in retained-a retained-b; do
  bash "$TAPSH" read "$rid" --by peer >/dev/null || exit 1
done
tap_bun_call digest-index - digest-index.ts reap "$TAP_HOME/spool/digests" "$TAP_RECEIPTS"
[ -f "$RIDX" ] || { echo 'digest: reaper deleted envelope while failed-first doorbell remains staged' >&2; exit 1; }
echo 'digest: failed-first envelope survives item settlement: ok'
# A later user Enter succeeds without a new digest, and its original pointer stays
# readable for the same bounded window. Publication age never claims injection.
tmux send-keys -t "$PANE" Enter
[ ! -f "$WORK/tmux/input" ] || { echo 'digest: later submit did not clear staged doorbell' >&2; exit 1; }
tap_bun_call digest-index - digest-index.ts reap "$TAP_HOME/spool/digests" "$TAP_RECEIPTS"
[ -f "$RIDX" ] || { echo 'digest: later successful submit lost original envelope' >&2; exit 1; }
python3 - "$RIDX" <<'PYNOPROOF'
import json,sys
assert not json.load(open(sys.argv[1])).get("injected_at_epoch")
PYNOPROOF
# All-terminal plus an expired window still reaps; retention is bounded.
TAP_DIGEST_RETAIN_SECONDS=0 tap_bun_call digest-index - digest-index.ts reap "$TAP_HOME/spool/digests" "$TAP_RECEIPTS"
[ ! -f "$RIDX" ] || { echo 'digest: expired all-terminal envelope not reaped' >&2; exit 1; }
echo 'digest: failed-first then successful submit retains envelope until expiry: ok'

# ---- (0g) tap-4b7ib: a parked read beginning under the digest's REAL held
# member obligation lock waits through the transaction and settles the same id in ONE invocation
# after the digest canonicalizes it — no second read, no claim manufactured for
# an absent spool entry, nothing settled while another holder owns the claim.
reset_bus
mk_spool d0g-a alice settle-only standard
mk_spool d0g-b bob   settle-only standard
HOLDING="$WORK/d0g-holding"; RELEASE="$WORK/d0g-release"
RC0G=0
FAKE_DIGEST_HOLDING="$HOLDING" FAKE_DIGEST_RELEASE="$RELEASE" \
  spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" d0g-a d0g-b & DIGEST_PID=$!
for _ in $(seq 1 500); do [ -e "$HOLDING" ] && break; sleep 0.02; done
[ -e "$HOLDING" ] || { echo "digest: (0g) the digest never reached its pause point" >&2; kill "$DIGEST_PID" 2>/dev/null || true; exit 1; }
set +e
bash "$TAPSH" read d0g-a --by peer >"$WORK/d0g.out" 2>"$WORK/d0g.err" & READER_PID=$!
sleep 2
if ! kill -0 "$READER_PID" 2>/dev/null; then
  : > "$RELEASE"; wait "$DIGEST_PID" 2>/dev/null || true; wait "$READER_PID" 2>/dev/null || true
  echo "digest: (0g) parked read did not wait on the digest's held member lock:" >&2
  cat "$WORK/d0g.out" "$WORK/d0g.err" >&2
  exit 1
fi
[ ! -e "$BUS/receipts/d0g-a.done" ] || { echo "digest: (0g) settled while the digest held its claim" >&2; exit 1; }
: > "$RELEASE"
wait "$DIGEST_PID" || RC0G=$?
wait "$READER_PID" || RC0G=$?
set -e
[ "$RC0G" = "0" ] || { echo "digest: (0g) the interleave failed (rc=$RC0G):" >&2; cat "$WORK/d0g.out" "$WORK/d0g.err" >&2; exit 1; }
# The digest canonicalized the member; the SAME read invocation settled it once.
[ -f "$BUS/payloads/d0g-a.md" ] || { echo "digest: (0g) the digest did not canonicalize the waited member" >&2; exit 1; }
[ ! -e "$BUS/spool/d0g-a.md" ] || { echo "digest: (0g) a spool copy survived the handoff" >&2; exit 1; }
[ ! -e "$BUS/spool/d0g-a.claim" ] || { echo "digest: (0g) a claim leaked past settlement" >&2; exit 1; }
[ -f "$BUS/receipts/d0g-a.done" ] || { echo "digest: (0g) the read did not settle the canonical reappearance" >&2; exit 1; }
[ "$(find "$BUS/receipts" -name 'd0g-a.done' | wc -l | tr -d ' ')" = "1" ] || { echo "digest: (0g) more than one terminal receipt" >&2; exit 1; }
grep -q 'body of d0g-a from alice' "$BUS/payloads/d0g-a.md" || { echo "digest: (0g) canonical bytes changed in the handoff" >&2; exit 1; }
rm -rf "${BUS:?}/delivery"
rm -f "${BUS:?}/receipts"/d0g-*.attempted "${BUS:?}/receipts"/d0g-*.cancelled "${BUS:?}/receipts"/d0g-b.done
echo "digest: (0g) parked read waits out the digest member lock and settles the reappearance in one invocation: ok"

# ---- (0h) tap-4b7ib R2: the authority that settles a reappearance is the
# CURRENT registry, not the one sampled before the wait. While the digest holds
# its claims, the addressee's seat disappears; when the digest canonicalizes
# and frees, the SAME read must refuse on stale authority instead of settling —
# no terminal receipt of any kind, while the digest's own transaction completes.
reset_bus
mk_spool d0h-a alice settle-only standard 'peer|%401'
mk_spool d0h-b bob   settle-only standard
# Bind the reader's authority to the v0.20 ACTING registry (the file the grant
# check samples post-flip), with peer's current instance equal to the envelope
# binding. The fixture is enrolled in the production shape, so the acting file
# IS the digest's bus registry (registry.json links to it): stamp the instances
# onto the existing pane rows rather than replacing the roster. This arm is
# last, so the stamps cannot perturb the arms above.
ACTING_REG="$WORK/repo/.tap/team-registry.json"
[ "$REG" -ef "$ACTING_REG" ] || { echo "digest: (0h) fixture: bus registry is not the acting registry" >&2; exit 1; }
python3 -B - "$ACTING_REG" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
for handle, instance in (("peer", "peer|%401"), ("alice", "alice|%402"), ("bob", "bob|%403")):
    doc["seats"][handle].update({"instance": instance, "registered_at": "t"})
with open(path, "w") as fh:
    json.dump(doc, fh)
PY
cat > "${TAP_INDEX_HOME:?}/global-registry.json" <<JSON
{"schema":"0.20","teams":{"t":{"root":"$WORK/repo","registry_location":"$ACTING_REG","state":"registered"}}}
JSON
tap_registry_v20_state_load || { echo "digest: (0h) fixture: flip marker read failed" >&2; exit 1; }
[ "$_TAP_V20_STATE_VAL" = "live" ] || { echo "digest: (0h) fixture: flip marker not live" >&2; exit 1; }
HOLDING="$WORK/d0h-holding"; RELEASE="$WORK/d0h-release"
RC0H=0; READER_RC=0
FAKE_DIGEST_HOLDING="$HOLDING" FAKE_DIGEST_RELEASE="$RELEASE" FAKE_DROP_PEER_REGISTRY="$ACTING_REG" \
  spool_engine_fixture digest "$REG" t peer "$PANE" "$PANE_ID" d0h-a d0h-b & DIGEST_PID=$!
for _ in $(seq 1 500); do [ -e "$HOLDING" ] && break; sleep 0.02; done
[ -e "$HOLDING" ] || { echo "digest: (0h) the digest never reached its pause point" >&2; kill "$DIGEST_PID" 2>/dev/null || true; exit 1; }
set +e
TAP_JSON=1 bash "$TAPSH" read d0h-a --by peer >"$WORK/d0h.out" 2>"$WORK/d0h.err" & READER_PID=$!
sleep 2
if ! kill -0 "$READER_PID" 2>/dev/null; then
  : > "$RELEASE"; wait "$DIGEST_PID" 2>/dev/null || true; wait "$READER_PID" 2>/dev/null || true
  echo "digest: (0h) parked read did not wait on the digest's held member lock:" >&2
  cat "$WORK/d0h.out" "$WORK/d0h.err" >&2
  exit 1
fi
[ ! -e "$BUS/receipts/d0h-a.done" ] || { echo "digest: (0h) settled while the digest held its claim" >&2; exit 1; }
: > "$RELEASE"
wait "$DIGEST_PID" || RC0H=$?
wait "$READER_PID" || READER_RC=$?
set -e
[ "$RC0H" = "0" ] || { echo "digest: (0h) the digest failed (rc=$RC0H):" >&2; exit 1; }
[ "$READER_RC" != "0" ] || { echo "digest: (0h) the read settled on stale authority:" >&2; cat "$WORK/d0h.out" "$WORK/d0h.err" >&2; exit 1; }
python3 -B - "$WORK/d0h.out" <<'PY0H' || { echo "digest: (0h) refusal did not recheck current recipient authority" >&2; exit 1; }
import json, sys
result = json.load(open(sys.argv[1]))
assert result['error_class'] == 'instance_unresolved', result
PY0H
for _r in done cancelled read; do
  [ ! -e "$BUS/receipts/d0h-a.$_r" ] || { echo "digest: (0h) a stale-authority read wrote d0h-a.$_r" >&2; exit 1; }
done
# The digest itself was untouched by the authority loss: it canonicalized the
# member and released every claim.
[ -f "$BUS/payloads/d0h-a.md" ] || { echo "digest: (0h) the digest did not canonicalize the waited member" >&2; exit 1; }
[ ! -e "$BUS/spool/d0h-a.md" ] || { echo "digest: (0h) a spool copy survived the handoff" >&2; exit 1; }
[ ! -e "$BUS/spool/d0h-a.claim" ] || { echo "digest: (0h) a claim leaked past settlement" >&2; exit 1; }
grep -q 'body of d0h-a from alice' "$BUS/payloads/d0h-a.md" || { echo "digest: (0h) canonical bytes changed in the handoff" >&2; exit 1; }
rm -rf "${BUS:?}/delivery"
rm -f "${BUS:?}/receipts"/d0h-*.attempted "${BUS:?}/receipts"/d0h-*.cancelled "${BUS:?}/receipts"/d0h-b.done
echo "digest: (0h) a reappearance read revalidates authority against the current registry and refuses without a receipt: ok"
