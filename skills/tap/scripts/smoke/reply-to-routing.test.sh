#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reply-to-routing.test.sh — tap-ywb: the envelope's `reply_to` field routes a
# `tap reply` answer to a DURABLE principal instead of an ephemeral/unattended
# sender. Coverage (panel wave): deliverability (not mere existence) at
# both send and reply time so a pending/suspended reply_to can never
# route-then-fail; local happy path; cross-team; send-time refusal of an
# undeliverable --reply-to (unknown, pending, suspended); an
# undeliverable-at-reply-time reply_to falling back to `from`, including the
# both-targets-gone case where the fallback itself is then refused with a
# discoverable `tap done` exit; register --unattended --reply-to auto-stamp,
# soft-failing (not dying) when the stored default goes stale; replier
# contamination (the ACTOR's own registered reply_to must never ride onto a
# reply composed on someone else's behalf); the unattended+reply_to
# reply=expected grant; settlement staying keyed on `from` regardless of
# routing; and a writer-supplied reply_to spoof being dropped like from_team.
set -euo pipefail

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: pin machine-resolved state (session manifest, opencode db,
# version-seen) for directly invoked bodies — defense-in-depth. The bus sits
# at an enrolled root so both runtimes resolve it under the live marker.
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
TAP_HOME="$WORK/repo/.tap/bus"; mkdir -p "$TAP_HOME"
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
unset TAP_SELF || true
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_TMUX_STATE:?}"; mkdir -p "\$state"
cmd="\${1:-}"; shift || true
case "\$cmd" in
  # CONTRACT §Session-name authority: delivery fixtures prove the exact session,
  # numeric pane id, current generation, and expected harness together.
  list-sessions) printf 'sess\\t900:100\\n' ;;
  list-panes) printf 'sess\\tsonnet-pane\\t%%1001\\tcodex\\t4242\\t900:100\\t0\\nsess\\thermes-pane\\t%%1002\\tcodex\\t4242\\t900:100\\t0\\nsess\\tsuspended-pane\\t%%1003\\tcodex\\t4242\\t900:100\\t0\\nsess\\tsome-pane\\t%%1004\\tcodex\\t4242\\t900:100\\t0\\nsess\\tcodex-pane\\t%%1005\\tcodex\\t4242\\t900:100\\t0\\nsess\\tdurable-pane\\t%%1006\\tcodex\\t4242\\t900:100\\t0\\n' ;;
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p) shift ;;
        -t) target="\${2:-}"; shift 2 ;;
        *)  fmt="\$1"; shift ;;
      esac
    done
    if [ "\$fmt" = '#{pid}:#{start_time}' ]; then printf '900:100\\n'; exit 0; fi
    if [ -z "\$target" ]; then echo "self:0.0"; exit 0; fi
    case "\$target" in
      sonnet-pane|%1001) pane_id=%1001 ;; hermes-pane|%1002) pane_id=%1002 ;;
      suspended-pane|%1003) pane_id=%1003 ;; some-pane|%1004) pane_id=%1004 ;;
      codex-pane|%1005) pane_id=%1005 ;; durable-pane|%1006) pane_id=%1006 ;; *) pane_id=%1007 ;;
    esac
    case "\$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\\tsess\\t4242\\tcodex\\t0\\n' "\$pane_id" ;;
      *pane_id*)              echo "\$pane_id" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*)    echo "$ROOT" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "\$state/input" ]; then printf '› %s\n' "\$(cat "\$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "\${1:-}" = "-t" ]; then shift 2; fi
    if [ "\${1:-}" = "-l" ]; then shift; [ "\${1:-}" = "--" ] && shift
      printf '%s' "\${1:-}" > "\$state/input"; printf '%s' "\${1:-}" >> "\$state/sentinels"; exit 0; fi
    if [ "\${1:-}" = "Enter" ]; then rm -f "\$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "sonnet": { "pane": "sonnet-pane", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "hermes": { "pane": "hermes-pane", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "ghost": { "delivery": "poll", "unattended": true, "status": "active", "reply_to": "ghost" },
    "pendingseat": { "status": "pending", "session": "testteam/pendingseat", "registered_at": "2026-07-10T00:00:00Z" },
    "suspendedseat": { "pane": "suspended-pane", "pane_id": "%1003", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "suspended", "status_reason": "test" }
  } }
JSON
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" testteam

# .16: the public door teaches self-routing without placing an obligation.
for self in hermes testteam/hermes; do
  set +e
  self_out="$(TAP_BUN_ROUTE_TRACE="$FAKE_BIN/route-bun" "$ROOT/bin/tap" send sonnet -m hi --from hermes --reply-to "$self" --id rt-self 2>&1)"; self_rc=$?
  set -e
  [ "$self_rc" -eq 1 ] || { echo "reply-to self: unexpected exit $self_rc"; exit 1; }
  for phrase in "recipient's tap reply" "replies already return to you" "omit --reply-to" "another seat's inbox"; do
    [[ "$self_out" == *"$phrase"* ]] || { echo "reply-to self: missing $phrase: $self_out"; exit 1; }
  done
  [ ! -f "$TAP_HOME/payloads/rt-self.md" ] && [ ! -f "$TAP_HOME/receipts/rt-self.done" ]
done

grep -q "native send" "$FAKE_BIN/route-bun" || { echo "Bun router did not select native send"; exit 1; }

# --- (1) send-time refusal: --reply-to naming an absent/unknown local handle -
set +e
out1="$("$TAP" send sonnet -m "hi" --from hermes --reply-to nobody-here --id rt-refuse 2>&1)"; rc1=$?
set -e
[ "$rc1" -ne 0 ] || { echo "reply-to: (1) --reply-to nobody-here should have been refused" >&2; echo "$out1" >&2; exit 1; }
case "$out1" in *"not a deliverable seat"*) ;; *) echo "reply-to: (1) refusal should name the actual deliverability failure, not an unknown-option error" >&2; echo "$out1" >&2; exit 1 ;; esac
[ ! -f "$TAP_HOME/payloads/rt-refuse.md" ] || { echo "reply-to: (1) refused send should not place a canonical payload" >&2; exit 1; }

# ── tap-52ys: 14 of 18 arms removed (ratified 2026-08-14) ───────────────────
# reply_to routing is real, but 18 arms at 41s was a permutation tour of WHICH
# kind of undeliverable seat (unknown / pending / suspended / self / stale) was
# named. The four kept are the distinct behaviors: an undeliverable target is
# refused at SEND time; a reply routes to reply_to while settlement stays on the
# inbound id; an undeliverable reply_to falls back to `from` rather than
# bricking the sender; and a writer-supplied reply_to in the payload is never
# trusted (the only one with a trust boundary).
#
# Accepted gap, named: the per-status refusal variants (pending vs suspended vs
# self), the --unattended auto-stamp path, cross-team reply_to routing, and the
# next-hop stamping on `tap reply`.

echo "reply-to: (1) --reply-to naming an unknown seat is refused at send time: ok"


# --- (2) happy path: ghost (unattended) sends to sonnet, reply_to=hermes,
#     --expect-reply — this is the ACTUAL advertised cron/sweep use case
#     (MUST-FIX 4's grant), not the --fyi dodge: a deliverable reply_to lets
#     an unattended sender's send stamp reply=expected instead of
#     settle-only, and it must not print the unattended downgrade warning.
out_send2="$("$TAP" send sonnet -m "sweep result" --from ghost --reply-to hermes --expect-reply --id rt-1 2>&1)" \
  || { echo "reply-to: (2) send with valid --reply-to failed" >&2; echo "$out_send2" >&2; exit 1; }
case "$out_send2" in *"downgraded"*) echo "reply-to: (2) should NOT downgrade — a deliverable reply_to grants the reply-expectation" >&2; echo "$out_send2" >&2; exit 1 ;; esac
grep -q '^reply_to: testteam/hermes$' "$TAP_HOME/payloads/rt-1.md" || { echo "reply-to: (2) envelope missing sender-bound reply_to: testteam/hermes" >&2; cat "$TAP_HOME/payloads/rt-1.md" >&2; exit 1; }
grep -q '^reply: expected$' "$TAP_HOME/payloads/rt-1.md" || { echo "reply-to: (2) unattended sender with a deliverable reply_to + --expect-reply should stamp reply=expected (the actual cron/sweep use case, not the --fyi dodge)" >&2; cat "$TAP_HOME/payloads/rt-1.md" >&2; exit 1; }
echo "reply-to: (2) --reply-to stamps reply_to in the envelope; the unattended+deliverable-reply_to+--expect-reply grant stamps reply=expected: ok"

rm -f "$TAP_HOME/fake-tmux/sentinels"
"$TAP" reply rt-1 -m "ack" --by sonnet >"$TAP_HOME/reply1.out" 2>&1 \
  || { echo "reply-to: (2) tap reply failed" >&2; cat "$TAP_HOME/reply1.out" >&2; exit 1; }
ob1="$(grep -rl 'ack' "$TAP_HOME/payloads"/*.md | grep -v rt-1.md | head -1)"
[ -n "$ob1" ] || { echo "reply-to: (2) outbound reply not found" >&2; ls "$TAP_HOME/payloads" >&2; exit 1; }
grep -q '^to: hermes$' "$ob1" || { echo "reply-to: (2) reply should route to hermes (reply_to), not ghost (from)" >&2; cat "$ob1" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/rt-1.done" ] || { echo "reply-to: (2) inbound rt-1 should be settled" >&2; exit 1; }
grep -q '"by":"sonnet"' "$TAP_HOME/receipts/rt-1.done" || { echo "reply-to: (2) settlement actor wrong" >&2; cat "$TAP_HOME/receipts/rt-1.done" >&2; exit 1; }
echo "reply-to: (2) tap reply routes to reply_to (hermes), settlement stays on the inbound id: ok"


# --- (4) fallback: reply_to no longer deliverable at reply time ------------
# tap-31it: --wake keeps this send's reply=settle-only stamp while declining
# the courier's auto-settle hold, so the fixture still exercises DELIVERY. Without
# it an eligible settle-only send parks by design and no sentinel/canonical exists.
#
# tap-7r3fn.20 adds a second reason the same setup can fail to deliver: arm (2)
# already delivered to sonnet, and a delivery opens the recipient's window, so
# this send would park inside it and `tap reply rt-2` would have no canonical to
# answer. The clock is cleared because this arm is about REPLY ROUTING when a
# reply_to has gone away — the window is delivery timing and belongs to
# delivery-window-drain.
rm -rf "$TAP_HOME/delivery"
"$TAP" send sonnet -m "second sweep" --from ghost --reply-to hermes --fyi --wake --id rt-2 >/dev/null 2>&1 \
  || { echo "reply-to: (4) setup send failed" >&2; exit 1; }
# Simulate hermes leaving the team between send and reply.
python3 -B - <<PY
import json
p = "$TAP_HOME/registry.json"
reg = json.load(open(p))
del reg["seats"]["hermes"]
json.dump(reg, open(p, "w"))
PY
set +e
"$TAP" reply rt-2 -m "ack 2" --by sonnet >"$TAP_HOME/reply2.out" 2>&1; rc2=$?
set -e
[ "$rc2" -eq 0 ] || { echo "reply-to: (4) fallback reply should still succeed" >&2; cat "$TAP_HOME/reply2.out" >&2; exit 1; }
grep -qi 'falling back' "$TAP_HOME/reply2.out" || { echo "reply-to: (4) fallback should print a stderr note" >&2; cat "$TAP_HOME/reply2.out" >&2; exit 1; }
ob2="$(grep -rl 'ack 2' "$TAP_HOME/payloads"/*.md | grep -v rt-2.md | head -1)"
[ -n "$ob2" ] || { echo "reply-to: (4) fallback outbound not found" >&2; exit 1; }
grep -q '^to: ghost$' "$ob2" || { echo "reply-to: (4) fallback should route to from (ghost), not the dead reply_to" >&2; cat "$ob2" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/rt-2.done" ] || { echo "reply-to: (4) rt-2 should still settle on fallback" >&2; exit 1; }
echo "reply-to: (4) an undeliverable reply_to falls back to from with a stderr note: ok"

# Clear sonnet's reply_to so it doesn't leak into later scenarios.
python3 -B - <<PY
import json
p = "$TAP_HOME/registry.json"
reg = json.load(open(p))
reg["seats"]["sonnet"].pop("reply_to", None)
json.dump(reg, open(p, "w"))
PY

# (5d) the unattended+deliverable-reply_to+--expect-reply grant is exercised
# end-to-end by scenario (2) above (sol round-2: that scenario now uses
# --expect-reply instead of the --fyi dodge, so it IS the honest happy path
# for the grant — a standalone duplicate here was removed).

# --- (5e) courier spoof-strip: a writer-supplied reply_to is never trusted --
# (same class as the existing from_team spoof-strip discipline).
SPOOF_SRC="$TAP_HOME/spoof-src.md"
cat > "$SPOOF_SRC" <<'EOF'
---
reply_to: hermes
---
a writer trying to smuggle its own reply_to past the courier
EOF
rm -rf "$TAP_HOME/delivery"    # same window reason as arm (4)
"$TAP" send sonnet "$SPOOF_SRC" --from ghost --fyi --wake --id rt-spoof >/dev/null 2>&1 \
  || { echo "reply-to: (5e) spoof-strip setup send failed" >&2; exit 1; }
grep -q '^reply_to:' "$TAP_HOME/payloads/rt-spoof.md" && { echo "reply-to: (5e) a writer-supplied reply_to must be dropped, not trusted (spoof-strip regression)" >&2; cat "$TAP_HOME/payloads/rt-spoof.md" >&2; exit 1; }
echo "reply-to: (5e) a writer-supplied reply_to in the source payload is dropped, never trusted: ok"

echo "reply-to-routing: ok"
