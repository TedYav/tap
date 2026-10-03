#!/usr/bin/env bash
# D5: fixture-door — skills/tap/scripts/smoke/reply-settles-after-send.test.sh:440: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reply-settles-after-send.test.sh — U4 (R6, R22, AE6): `tap reply` answers the sender
# AND settles the inbound in one command, but ONLY after the outbound is durable:
#   - send exit 0/injected or exit 0/queued -> outbound accepted, inbound settled;
#   - send exit 5  -> outbound canonical queued, inbound settled, pending line
#                     re-surfaced, reply exits 5, outbound still in `outstanding`;
#   - send exit 3  -> outbound NOT durable, inbound LEFT UNSETTLED, action named (AE6);
#   - already-settled inbound -> refused with current open obligations, no outbound;
#   - outbound is reply=settle-only by default, --expect-reply flips it.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# The bus sits at an enrolled root so reply resolves it under the live marker.
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"; rm -rf "${FAKE_BIN:?}"' EXIT
TAP_HOME="$WORK/repo/.tap/bus"; mkdir -p "$TAP_HOME"
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TAP_SPOOL_DISABLE_DELIVERER=1
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"
unset TAP_SELF || true
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    printf 'self\t4242:100\npeer\t4242:100\n'
    ;;
  list-panes)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -s) shift ;; -t) target="${2#=}"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      self) printf 'self\tself:0.0\t%%701\tcodex\t5701\t4242:100\t0\n' ;;
      peer) printf 'peer\tpeer:0.0\t%%702\tcodex\t5702\t4242:100\t0\n' ;;
      *) exit 1 ;;
    esac
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
        *pane_id*pane_tty*session_name*) printf '%%701\t/dev/faketty\tself\t4242:100\n' ;;
        *pane_id*session_name*) printf '%%701\tself\t4242:100\n' ;;
        *pid*start_time*) echo '4242:100' ;;
        *window_index*) echo 'self:0.0' ;;
        *session_name*) echo 'self' ;;
        *pane_id*) echo '%701' ;;
        *) echo 'self:0.0' ;;
      esac
      exit 0
    fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          self:0.0|%701) printf '%%701\tself\t4242\tcodex\t0\n' ;;
          peer:0.0|%702) printf '%%702\tpeer\t4242\tcodex\t0\n' ;;
        esac ;;
      *pane_id*session_name*)
        case "$target" in
          self:0.0) printf '%%701\tself\t4242:100\n' ;;
          peer:0.0) printf '%%702\tpeer\t4242:100\n' ;;
          *) echo '' ;;
        esac ;;
      *pane_id*)
        case "$target" in self:0.0) echo '%701' ;; peer:0.0) echo '%702' ;; *) echo '' ;; esac ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/no-prompt" ]; then printf 'model is still working\n'
    elif [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then
      target=""
      if [ -n "${FAKE_TMUX_MATCH:-}" ]; then
        target="$(grep -lF -- "$FAKE_TMUX_MATCH" "$TAP_HOME"/payloads/*.md 2>/dev/null | head -1 || true)"
      fi
      if [ -n "$target" ] && [ -n "${FAKE_TMUX_REWRITE_BODY_FILE:-}" ]; then
        python3 -B - "$target" "$FAKE_TMUX_REWRITE_BODY_FILE" <<'PY'
from pathlib import Path
import sys

payload, body = map(Path, sys.argv[1:3])
lines = payload.read_bytes().splitlines(keepends=True)
end = next(i for i, line in enumerate(lines[1:], 1) if line.rstrip(b"\r\n") == b"---")
payload.write_bytes(b"".join(lines[: end + 1]) + body.read_bytes())
PY
      fi
      if [ -n "$target" ] && [ -n "${FAKE_TMUX_IN_REPLY_TO:-}" ]; then
        python3 -B - "$target" "$FAKE_TMUX_IN_REPLY_TO" <<'PY'
from pathlib import Path
import re, sys

payload, value = Path(sys.argv[1]), sys.argv[2]
payload.write_text(re.sub(r"(?m)^in_reply_to:.*$", f"in_reply_to: {value}", payload.read_text()))
PY
      fi
      [ "${FAKE_TMUX_STUCK_SUBMIT:-0}" = "1" ] || rm -f "$state/input"
      exit 0
    fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "t" },
  "seats": {
    "codex":  { "session": "self", "pane": "self:0.0", "pane_id": "%701", "harness": "codex", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "status": "active" },
    "claude": { "session": "peer", "pane": "peer:0.0", "pane_id": "%702", "harness": "codex", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "status": "active" },
    "ghost":  { "session": "gone", "pane": "gone:0.0", "pane_id": "%703", "harness": "codex", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "status": "active" }
  } }
JSON
# Production shape: the acting registry is <root>/.tap/team-registry.json (native
# derives the team root from it); the bus path this file edits links to it.
mv "$TAP_HOME/registry.json" "$WORK/repo/.tap/team-registry.json"
ln -s ../team-registry.json "$TAP_HOME/registry.json"
mkdir -p "$TAP_INDEX_HOME"
python3 -B -c 'import json,sys; json.dump({"schema":"0.20","teams":{"t":{"root":sys.argv[1],"registry_location":sys.argv[2],"state":"registered"}}},open(sys.argv[3],"w"))' \
  "$(cd "$WORK/repo" && pwd -P)" "$(cd "$WORK/repo/.tap" && pwd -P)/team-registry.json" "$TAP_INDEX_HOME/global-registry.json"

inbound() {  # <id> <from> [reply-value]
  local rv="${3:-expected}"
  cat > "$TAP_HOME/payloads/$1.md" <<EOF
---
id: $1
from: $2
to: codex
kind: discuss
reply: $rv
path: $TAP_HOME/payloads/$1.md
---
inbound $1
EOF
}

outbound_to_claude() { grep -rl '^to: claude$' "$TAP_HOME/payloads"/*.md 2>/dev/null | while read -r f; do grep -q '^from: codex$' "$f" && echo "$f"; done; }

# (1) Happy path: reply delivers + settles; --by derived from... explicit here.

# ── tap-52ys: 15 of 21 arms removed (ratified 2026-08-14) ────────────────────
# Settlement is a non-negotiable gate class, so this file stays — but 21 arms
# at 69s was mostly permutation. The six kept are the distinct settlement
# outcomes: it works; a settled inbound refuses; a pending send still settles
# the inbound (exit 5); a dead pane does NOT settle it (exit 3); a non-courier
# spool path cannot forge settlement; and progress keeps the obligation open.
#
# Accepted gap, named: the receipt-provenance arms (1b disk-true hash/preview,
# 1c queued settlement surviving identity drift), the symlinked-spool variant
# of 4bb, and the five remaining `progress` refusal permutations (5d-5g).
# done-integrity remains the settlement-authority witness in the gate.

inbound in-1 claude
"$TAP" reply in-1 -m "my answer" --by codex >"$TAP_HOME/r1.out" 2>&1 \
  || { echo "reply: (1) happy-path reply failed" >&2; cat "$TAP_HOME/r1.out" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/in-1.done" ] || { echo "reply: (1) inbound not settled" >&2; exit 1; }
grep -q '"by":"codex"' "$TAP_HOME/receipts/in-1.done" || { echo "reply: (1) settle actor wrong" >&2; cat "$TAP_HOME/receipts/in-1.done" >&2; exit 1; }
ob="$(outbound_to_claude | head -1)"
[ -n "$ob" ] || { echo "reply: (1) no outbound to claude" >&2; ls "$TAP_HOME/payloads" >&2; exit 1; }
grep -q '^reply: settle-only$' "$ob" || { echo "reply: (1) outbound should default to settle-only" >&2; cat "$ob" >&2; exit 1; }
grep -q '^in_reply_to: in-1$' "$ob" || { echo "reply: (1) outbound correlation missing" >&2; cat "$ob" >&2; exit 1; }
python3 - "$TAP_HOME/receipts/in-1.done" "$ob" <<'PY' \
  || { echo "reply: (1) reply audit fields wrong" >&2; cat "$TAP_HOME/receipts/in-1.done" >&2; exit 1; }
from pathlib import Path
import hashlib, json, sys

receipt = json.load(open(sys.argv[1]))
payload = Path(sys.argv[2])
lines = payload.read_bytes().splitlines(keepends=True)
end = next(i for i, line in enumerate(lines[1:], 1) if line.rstrip(b"\r\n") == b"---")
body = b"".join(lines[end + 1:])
text = body.decode("utf-8", "replace")
preview = " ".join("".join(c if c.isprintable() or c.isspace() else " " for c in text).split())[:160]
assert receipt["via"] == "reply", receipt
assert receipt["reply_id"] == payload.stem, receipt
assert receipt["reply_sha256"] == hashlib.sha256(body).hexdigest(), receipt
assert receipt["reply_preview"] == preview, receipt
assert {k for k in receipt if k.startswith("reply_")} == {"reply_id", "reply_sha256", "reply_preview"}, receipt
PY
echo "reply: (1) happy path — delivers, settles inbound, outbound is settle-only: ok"


# (2) already-settled inbound → refused with its settle time + the actor's open
# obligations; no new outbound.
inbound in-open claude
before="$(outbound_to_claude | wc -l | tr -d ' ')"
set +e; TAP_JSON=1 "$TAP" reply in-1 -m "again" --by codex >"$TAP_HOME/r2.out" 2>"$TAP_HOME/r2.err"; rc=$?; set -e
[ "$rc" != 0 ] || { echo "reply: (2) replying to a settled payload should fail" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="already_settled", d' "$TAP_HOME/r2.out" \
  || { echo "reply: (2) missing already_settled class" >&2; cat "$TAP_HOME/r2.out" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["action"]=="tap send", d' "$TAP_HOME/r2.out" \
  || { echo "reply: (2) should name tap send" >&2; cat "$TAP_HOME/r2.out" >&2; exit 1; }
python3 - "$TAP_HOME/r2.out" "$TAP_HOME/receipts/in-1.done" <<'PY' \
  || { echo "reply: (2) should name settle time and current open obligations" >&2; cat "$TAP_HOME/r2.out" >&2; exit 1; }
import json, sys
error = json.load(open(sys.argv[1]))
receipt = json.load(open(sys.argv[2]))
assert error["detail"] == f'id in-1 already settled at {receipt["at"]}; you have 1 open: in-open', error
PY
after="$(outbound_to_claude | wc -l | tr -d ' ')"
[ "$before" = "$after" ] || { echo "reply: (2) refused reply still sent an outbound" >&2; exit 1; }
echo "reply: (2) already-settled inbound refused, surfaces open obligations, no outbound: ok"


# (3) A real draft parks the reply; durable custody settles the inbound.
inbound in-5 claude
printf human-draft > "$FAKE_TMUX_STATE/input"
set +e; "$TAP" reply in-5 -m "queued answer" --by codex >"$TAP_HOME/r5.out" 2>"$TAP_HOME/r5.err"; rc=$?; set -e
[ "$rc" -eq 0 ] || { echo "reply: (3) a reply behind a human draft must PARK (rc 0), got $rc" >&2; cat "$TAP_HOME/r5.out" "$TAP_HOME/r5.err" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/in-5.done" ] || { echo "reply: (3) inbound should be settled on a parked reply — settlement is orthogonal to delivery timing" >&2; exit 1; }

sp5="$(grep -l '^in_reply_to: in-5$' "$TAP_HOME/spool"/*.md 2>/dev/null | head -1 || true)"
[ -n "$sp5" ] || { echo "reply: (3) no spool payload carries in_reply_to: in-5 — the reply did not park as a reply" >&2; ls -la "$TAP_HOME/spool" >&2; exit 1; }
id5="$(basename "$sp5" .md)"
python3 - "$TAP_HOME/spool/$id5.meta.json" <<'PY' \
  || { echo "reply: (3) parked reply row is not standard/pending-input" >&2; cat "$TAP_HOME/spool/$id5.meta.json" >&2; exit 1; }
import json, sys
m = json.load(open(sys.argv[1]))
assert m["policy"] == "standard", m
assert m["reason"] == "pending-input", m
assert m.get("hold_until_epoch"), m
PY
[ ! -e "$TAP_HOME/receipts/$id5.sent" ] \
  || { echo "reply: (3) a parked reply must not write .sent — nothing was submitted yet" >&2; exit 1; }
# The park's stdout is the reply's OWN operator line, and asserting it positively
# is what keeps the old `[ ! -s r5.out ]` honest: that check was written for the
# exit-5 path, where stdout is genuinely empty, and inheriting it here would have
# demanded silence from a success path that has something true to say. What must
# not appear is the internal send JSON — the contract the original arm defended.
grep -q "tap reply: queued in-5" "$TAP_HOME/r5.out" \
  || { echo "reply: (3) parked reply must render its own operator-facing queued line" >&2; cat "$TAP_HOME/r5.out" >&2; exit 1; }
grep -qE '^\{|"ok"[[:space:]]*:' "$TAP_HOME/r5.out" \
  && { echo "reply: (3) send JSON must not leak through reply stdout" >&2; cat "$TAP_HOME/r5.out" >&2; exit 1; }
echo "reply: (3) a reply behind a draft parks as standard/pending-input, settles its inbound, writes no .sent: ok"

# (3b) …and it is DELIVERED, once, when its window comes due. A park that never
# drains is not a delivery mode, it is a drop; and the original ask's settlement
# must be unchanged by the second half of the journey.
rm -f "$FAKE_TMUX_STATE/input"
# Draft gone: production's waiter releases the pane hold (two bare samples
# >=250 ms apart delete the record under "$TAP_INDEX_HOME/input-protection")
# before the due drain; the fake clock cannot expire the real-clock grace, so
# simulate that release outcome.
rm -rf "${TAP_INDEX_HOME:?}/input-protection"
python3 - "$TAP_HOME/spool/$id5.meta.json" "$(( $(date +%s) - 1 ))" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["hold_until_epoch"] = int(sys.argv[2])
json.dump(d, open(p, "w"), indent=2, sort_keys=True)
PY
bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" \
  >"$TAP_HOME/drain5.out" 2>"$TAP_HOME/drain5.err" || { echo "reply: (3b) drain failed: $(cat "$TAP_HOME/drain5.err")" >&2; exit 1; }
# ASSERT TAP'S OWN DELIVERY EVIDENCE, NOT THE MOCK'S LOG FORMAT. The first draft
# grepped send-keys.log for the id and read zero — while the entry had in fact
# been delivered and reaped. Whether a mock's log happens to echo a full id is a
# property of the mock; the spool row disappearing and `.sent` appearing are what
# the courier itself records, and they cannot be satisfied by a drain that did
# nothing.
[ ! -e "$TAP_HOME/spool/$id5.meta.json" ] \
  || { echo "reply: (3b) the due reply is still parked — the drain did not deliver it" >&2; cat "$TAP_HOME/spool/$id5.meta.json" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/$id5.sent" ] \
  || { echo "reply: (3b) no .sent receipt — the entry left the spool without a recorded delivery" >&2; ls -la "$TAP_HOME/receipts" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/in-5.done" ] \
  || { echo "reply: (3b) draining the reply must not disturb the original ask's settlement" >&2; exit 1; }
echo "reply: (3b) the parked reply drains and is delivered once when due, ask settlement unchanged: ok"

# (3-RED) A bare composer attempts immediately. A deliberately stuck submit
# remains unconfirmed (5); neither a clock nor reply correlation implies delivery.
inbound in-5r claude
set +e; TAP_AUTOSETTLE_HOLD_SECONDS=0 FAKE_TMUX_STUCK_SUBMIT=1 \
  "$TAP" reply in-5r -m "old behaviour" --by codex >"$TAP_HOME/r5r.out" 2>"$TAP_HOME/r5r.err"; rc=$?; set -e
[ "$rc" -eq 5 ] \
  || { echo "reply: (3-RED) with the window off the reply must still attempt and report unconfirmed (5), got $rc — this control no longer discriminates" >&2; cat "$TAP_HOME/r5r.out" "$TAP_HOME/r5r.err" >&2; exit 1; }
grep -q "tap reply: outbound submit unverified (canonical remains on the bus); inbound in-5r settled" "$TAP_HOME/r5r.out" \
  || { echo "reply: (3-RED) reply-owned pending result missing" >&2; cat "$TAP_HOME/r5r.out" "$TAP_HOME/r5r.err" >&2; exit 1; }
set +e; "$TAP" outstanding codex --json >"$TAP_HOME/out5.out" 2>/dev/null; set -e
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(i["to"]=="claude" for i in d["outstanding"]), d' "$TAP_HOME/out5.out" \
  || { echo "reply: (3-RED) unconfirmed outbound not visible in outstanding" >&2; cat "$TAP_HOME/out5.out" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/input"
echo "reply: (3-RED) window off — the reply attempts, reports unconfirmed, stays outstanding: ok"

# (3d) `tap reply --delivery interrupt` BYPASSES the window ------------------
# The partner reviewer's Important 1: ruling 83 promises the override on the PUBLIC reply
# surface, and CONTRACT states it. Before this, tap-reply.sh parsed no --delivery
# at all, so the documented escape did not exist and
# `tap reply <id> -m x --delivery interrupt` exited 1 with "unknown option".
#
# A `tap send --in-reply-to` control is NOT equivalent and is why this arm lives
# on the reply surface: send does not compose inbound settlement, so it cannot
# show that the override leaves the settle half alone.
inbound in-5i claude
delivered_now="$(date +%s)"
mkdir -p "$TAP_HOME/delivery"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"claude","last_delivered_at":int(sys.argv[2])}))' \
  "$TAP_HOME/delivery/claude.json" "$delivered_now"
set +e; "$TAP" reply in-5i -m "urgent answer" --by codex --delivery interrupt >"$TAP_HOME/r5i.out" 2>"$TAP_HOME/r5i.err"; rc=$?; set -e
[ "$rc" -eq 0 ] || { echo "reply: (3d) --delivery interrupt should be accepted and delivered, got $rc" >&2; cat "$TAP_HOME/r5i.out" "$TAP_HOME/r5i.err" >&2; exit 1; }
grep -q "unknown option" "$TAP_HOME/r5i.err" \
  && { echo "reply: (3d) the reply parser refused --delivery — the documented override does not exist" >&2; cat "$TAP_HOME/r5i.err" >&2; exit 1; }
# `|| true` is load-bearing and is the whole point of this arm: NO match is the
# PASSING outcome here, and grep exits 1 on no-match, so under `set -euo pipefail`
# the script would die before the assertion that wants the emptiness could read it.
sp5i="$(grep -l '^in_reply_to: in-5i$' "$TAP_HOME/spool"/*.md 2>/dev/null | head -1 || true)"
[ -z "$sp5i" ] \
  || { echo "reply: (3d) interrupt PARKED inside the window — the override did not bypass it" >&2; cat "${sp5i%.md}.meta.json" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/in-5i.done" ] || { echo "reply: (3d) interrupt reply must still settle its inbound" >&2; exit 1; }
echo "reply: (3d) tap reply --delivery interrupt bypasses the window and still settles the inbound: ok"

# (3e) `tap reply --delivery polite` takes the LONG window -------------------
# The third behaviour ruling 83 names. `polite` must not merely park — it must
# park on the polite POLICY, which is what gives it the long window; a reply that
# parked as `standard` would look identical here at the 10s default and diverge
# only at the 60s one, so the arm asserts the policy rather than the park.
inbound in-5p claude
delivered_now="$(date +%s)"
python3 -B -c 'import json,sys
open(sys.argv[1],"w").write(json.dumps({"handle":"claude","last_delivered_at":int(sys.argv[2])}))' \
  "$TAP_HOME/delivery/claude.json" "$delivered_now"
set +e; "$TAP" reply in-5p -m "polite answer" --by codex --delivery polite >"$TAP_HOME/r5p.out" 2>"$TAP_HOME/r5p.err"; rc=$?; set -e
[ "$rc" -eq 0 ] || { echo "reply: (3e) --delivery polite should be accepted, got $rc" >&2; cat "$TAP_HOME/r5p.out" "$TAP_HOME/r5p.err" >&2; exit 1; }
sp5p="$(grep -l '^in_reply_to: in-5p$' "$TAP_HOME/spool"/*.md 2>/dev/null | head -1 || true)"
[ -n "$sp5p" ] || { echo "reply: (3e) polite reply did not park" >&2; exit 1; }
python3 - "${sp5p%.md}.meta.json" "$delivered_now" <<'PY' \
  || { echo "reply: (3e) polite reply did not take the polite policy/window" >&2; cat "${sp5p%.md}.meta.json" >&2; exit 1; }
import json, sys
m = json.load(open(sys.argv[1])); last = int(sys.argv[2])
assert m["policy"] == "polite", m
# the built-in polite window is 60s, so a polite park arms far past the 10s `now`
# window a standard reply would have taken from the same clock reading.
assert int(m["hold_until_epoch"]) >= last + 60, (m, last)
PY
echo "reply: (3e) tap reply --delivery polite parks on the polite policy and its long window: ok"
# Later submit controls must not inherit this deliberately parked sibling.
rm -f "$sp5p" "${sp5p%.md}.meta.json"


# (3c) direct send keeps its pending identifiers in PC14 JSON: default stdout is
# empty and stderr carries the durable-state/uncertainty diagnostic.  The prior
# stuck-submit case intentionally left its sentinel text in the mock pane; clear
# that fixture artifact so this case exercises submit verification, not standard
# human-input grace.
rm -f "$FAKE_TMUX_STATE/input"
# The window is off for this arm, inline, exactly as arm (3-RED) does it: this
# case is about the direct-send PENDING receipt, and reaching that receipt
# requires actually attempting a submit. Arms (3)/(3b)/(3-RED) above each
# delivered to `claude`, so its window is open and an ordinary --ask send would
# park here — a park is a different, already-covered path, and asserting exit 5
# against it would only be asserting that the window works.
set +e; TAP_AUTOSETTLE_HOLD_SECONDS=0 FAKE_TMUX_STUCK_SUBMIT=1 "$TAP" send claude -m "direct pending" --from codex --id direct-5 --ask >"$TAP_HOME/direct5.out" 2>"$TAP_HOME/direct5.err"; rc=$?; set -e
[ "$rc" -eq 5 ] || { echo "reply: (3c) direct pending send should exit 5, got $rc" >&2; cat "$TAP_HOME/direct5.out" "$TAP_HOME/direct5.err" >&2; exit 1; }
[ ! -s "$TAP_HOME/direct5.out" ] || { echo "reply: (3c) default send must not print a pending k=v line" >&2; cat "$TAP_HOME/direct5.out" >&2; exit 1; }
grep -Fq 'Delivery not confirmed. Inspect with tap show direct-5; tap resend direct-5 requires proof that no attempt occurred.' "$TAP_HOME/direct5.err" || { echo "reply: (3c) pending diagnostic must name the actual-id retry" >&2; cat "$TAP_HOME/direct5.err" >&2; exit 1; }
grep -Fq "tap send: direct-5 is on the bus for claude. Delivery not confirmed." "$TAP_HOME/direct5.err" \
  || { echo "reply: (3c) pending diagnostic must name the durable payload state" >&2; cat "$TAP_HOME/direct5.err" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/input"

# (4) exit-3 (pane gone): inbound LEFT UNSETTLED; outstanding of the sender still lists it (AE6).
inbound in-4 ghost
set +e; "$TAP" reply in-4 -m "to a dead pane" --by codex >"$TAP_HOME/r4.out" 2>"$TAP_HOME/r4.err"; rc=$?; set -e
[ "$rc" -eq 3 ] || { echo "reply: (4) expected exit 3 (pane gone), got $rc" >&2; cat "$TAP_HOME/r4.out" "$TAP_HOME/r4.err" >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/in-4.done" ] || { echo "reply: (4) inbound must stay unsettled when the outbound never left" >&2; exit 1; }
# F1: tap reply forces send's --json mode, then renders the failure as its own
# human prose line; the PC14 JSON never leaks through reply stdout.
grep -q 'pane.*gone' "$TAP_HOME/r4.err" || { echo "reply: (4) send's pane_gone detail was not surfaced (F1)" >&2; cat "$TAP_HOME/r4.err" >&2; exit 1; }
grep -q 'next:' "$TAP_HOME/r4.err" || { echo "reply: (4) error line missing next-step" >&2; cat "$TAP_HOME/r4.err" >&2; exit 1; }
grep -q 'left unsettled' "$TAP_HOME/r4.err" || { echo "reply: (4) reply should note the inbound is left unsettled" >&2; cat "$TAP_HOME/r4.err" >&2; exit 1; }
set +e; "$TAP" outstanding ghost --json >"$TAP_HOME/out4.out" 2>/dev/null; set -e
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(i["id"]=="in-4" for i in d["outstanding"]), d' "$TAP_HOME/out4.out" \
  || { echo "reply: (4) sender's outstanding should still list the unsettled inbound" >&2; cat "$TAP_HOME/out4.out" >&2; exit 1; }
echo "reply: (4) exit-3 surfaces send's error_class=pane_gone, leaves inbound unsettled, sender still sees it: ok"


# (4bb) A path merely named spool/ is not courier-owned. Even a complete-looking
# metadata sidecar cannot make an arbitrary directory authoritative: correlation
# accepts only this bus's exact spool/<id>.md or payloads/<id>.md sibling.
inbound in-fake-spool claude
mkdir -p "$TAP_HOME/forged/spool" "$TAP_HOME/forged/payloads"
cat > "$TAP_HOME/forged/spool/forged-reply.md" <<EOF
---
id: forged-reply
from: codex
to: claude
kind: discuss
reply: settle-only
in_reply_to: in-fake-spool
path: $TAP_HOME/forged/payloads/forged-reply.md
---
forged correlation
EOF
cat > "$TAP_HOME/forged/spool/forged-reply.meta.json" <<EOF
{
  "id": "forged-reply",
  "target": "claude",
  "team": "t",
  "first_spooled_epoch": 1
}
EOF
set +e
"$TAP" done in-fake-spool --by codex --reply-payload "$TAP_HOME/forged/spool/forged-reply.md" \
  >"$TAP_HOME/forged.out" 2>"$TAP_HOME/forged.err"
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "reply: (4bb) public forged spool correlation should fail 2 (retired alias), got $rc" >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/in-fake-spool.done" ] || { echo "reply: (4bb) forged spool correlation settled inbound" >&2; exit 1; }
grep -q 'tap done is retired' "$TAP_HOME/forged.err" \
  || { echo "reply: (4bb) forged flag did not land in the retirement alias" >&2; cat "$TAP_HOME/forged.err" >&2; exit 1; }
echo "reply: (4bb) public done cannot carry the private settlement flag: ok"


# (5b) Progress is a durable status message, not a discharge: its outbound is
# settle-only while the original sender still sees the inbound in outstanding.
inbound progress-open claude
# Make the recent-delivery premise explicit and freeze the clock for this call.
# Previous arms left the window open on CI but let it expire on slower runs.
_progress_now="$(date +%s)"
TAP_SPOOL_NOW="$_progress_now" bash -c '. "$1"; "${TAP_SMOKE_BUN:-bun}" "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/delivery-clock.ts" stamp "$TAP_HOME/registry.json" claude' \
  _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# This arm isolates progress settlement, so bypass the window at its public
# test seam. Arms (3)/(3b) above cover parking and draining with the window on.
TAP_SPOOL_NOW="$_progress_now" TAP_AUTOSETTLE_HOLD_SECONDS=0 \
  "$TAP" reply progress-open --progress -m "still implementing" --by codex >"$TAP_HOME/progress-open.out" 2>&1 \
  || { echo "reply: (5b) progress reply failed" >&2; cat "$TAP_HOME/progress-open.out" >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/progress-open.done" ] \
  || { echo "reply: (5b) progress must not settle the inbound" >&2; exit 1; }
progress_outbound="$(grep -rl 'still implementing' "$TAP_HOME/payloads"/*.md | head -1 || true)"
[ -n "$progress_outbound" ] || { echo "reply: (5b) progress outbound missing from canonical payloads" >&2; cat "$TAP_HOME/progress-open.out" >&2; exit 1; }
grep -q '^reply: settle-only$' "$progress_outbound" \
  || { echo "reply: (5b) progress outbound must be settle-only" >&2; cat "$progress_outbound" >&2; exit 1; }
set +e; "$TAP" outstanding claude --json >"$TAP_HOME/progress-open.outstanding" 2>/dev/null; set -e
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(i["id"]=="progress-open" for i in d["outstanding"]), d' "$TAP_HOME/progress-open.outstanding" \
  || { echo "reply: (5b) original sender must retain progress obligation" >&2; cat "$TAP_HOME/progress-open.outstanding" >&2; exit 1; }
echo "reply: (5b) progress delivers settle-only status and retains original obligation: ok"

echo "reply-settles-after-send: ok"
