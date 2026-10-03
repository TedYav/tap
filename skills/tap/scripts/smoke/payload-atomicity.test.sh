#!/usr/bin/env bash
# payload-atomicity.test.sh — Unit 2: canonical payload atomicity contract.
#
# Covers:
#   (a) tap doctor reports zero-byte canonical payloads (bus integrity)
#   (b) tap send never leaves payloads/<id>.md when envelope stamping fails
#   (c) tap send never leaves payloads/<id>.md when the recipient pane is gone (exit 3)
#   (d) an accepted pending-input queue leaves only its tracked spool pair
#   (e) fail-closed sends do not emit success telemetry (.sent)
#   (f) whitespace-bearing TAP_HOME/payload paths are rejected fail-closed
#   (g) duplicate ids / settled ids are refused before canonical rename
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# Born live: a canonical bus under an enrolled team root, so a pane-gone send
# may suspend its recipient (an unenrolled bus refuses the registry write).
TEAM_PARENT="$(mktemp -d)"
TEAM_ROOT="$(cd "$TEAM_PARENT" && pwd -P)/testteam"
TAP_HOME="$TEAM_ROOT/.tap/bus"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TEAM_PARENT" "$FAKE_BIN"' EXIT
export TAP_HOME
export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
printf '{"schema":"0.20","teams":{"testteam":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' \
  "$TEAM_ROOT" "$TAP_HOME" > "${TAP_INDEX_HOME:?}/global-registry.json"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "claude": { "session": "sender", "pane": "sender:0.0", "pane_id": "%601", "harness": "codex", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "status": "active" },
    "codex": { "session": "target", "pane": "target:0.0", "pane_id": "%602", "harness": "codex", "server_epoch": "srv:4242:100", "boot_id": "boot:1", "status": "active" }
  }
}
JSON

# --- fake tmux: same pattern as courier-injects.test.sh ----------------------
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    printf 'sender\t4242:100\n'
    [ "${FAKE_TMUX_GONE:-0}" = "1" ] || printf 'target\t4242:100\n'
    ;;
  list-panes)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -s) shift ;; -t) target="${2#=}"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac
    done
    if [ "$target" = "sender" ]; then
      printf 'sender\tsender:0.0\t%%601\tcodex\t5601\t4242:100\t0\n'
    elif [ "$target" = "target" ] && [ "${FAKE_TMUX_GONE:-0}" != "1" ]; then
      printf 'target\ttarget:0.0\t%%602\t%s\t5602\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}"
    else
      exit 1
    fi
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    # Gone means the recipient pane only: the server and the sender stay observable
    # (a dead server is a different refusal, not pane-gone).
    if [ "${FAKE_TMUX_GONE:-0}" = "1" ]; then
      case "$target" in target*|%602) echo "can't find pane: $target" >&2; exit 1 ;; esac
    fi
    case "$fmt" in
      # tap-goe3f: answer the identity gate's composite pane observation and the server
      # generation probe before the bare pane_id arm swallows them.
      *pane_id*session_name*pane_current_command*)
        if [ "$target" = "sender:0.0" ]; then
          printf '%%601\tsender\t5601\t%s\t0\n' "${FAKE_TMUX_CMD:-codex}"
        else
          printf '%%602\ttarget\t5602\t%s\t0\n' "${FAKE_TMUX_CMD:-codex}"
        fi ;;
      *pane_id*session_name*)
        [ "$target" = "sender:0.0" ] && printf '%%601\tsender\t4242:100\n' || printf '%%602\ttarget\t4242:100\n' ;;
      *start_time*)           echo "4242:100" ;;
      *pane_id*)              [ "$target" = "sender:0.0" ] && echo "%601" || echo "%602" ;;
      *pane_in_mode*)         echo "${FAKE_TMUX_IN_MODE:-0}" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    prompt="${FAKE_TMUX_PROMPT:-›}"
    if [ -f "$state/input" ]; then
      printf '%s %s\n' "$prompt" "$(cat "$state/input")"
    else
      printf '%s \n' "$prompt"
    fi ;;
  send-keys)
    [ "${FAKE_TMUX_GONE_ON_SEND:-0}" = "1" ] && exit 1
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift
      [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"
      exit 0
    fi
    [ "${1:-}" = "C-u" ] && rm -f "$state/input" || true
    [ "${1:-}" = "Enter" ] && rm -f "$state/input" || true ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

export PATH="$FAKE_BIN:$PATH"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"

# ── (a) tap doctor reports zero-byte canonical ───────────────────────────────
touch "$TAP_HOME/payloads/zero-byte.md"
doctor_out="$("$TAP" doctor 2>&1 || true)"
case "$doctor_out" in
  *zero-byte*) ;;
  *) echo "atomicity: (a) tap doctor did not report zero-byte canonical" >&2
     echo "--- doctor output ---" >&2; printf '%s\n' "$doctor_out" >&2
     exit 1 ;;
esac
rm -f "$TAP_HOME/payloads/zero-byte.md"
echo "atomicity: (a) zero-byte canonical reported by tap doctor: ok"

# ── (g) duplicate ids / settled ids are refused before canonical rename ───────
dup1="$TAP_HOME/dup1.md"
dup2="$TAP_HOME/dup2.md"
cat > "$dup1" <<'EOF'
---
from: claude
to: codex
kind: discuss
---
original body
EOF
cat > "$dup2" <<'EOF'
---
from: claude
to: codex
kind: discuss
---
replacement body
EOF
"$TAP" send codex "$dup1" --from claude --ask --id dup-id --pane target:0.0 >/dev/null 2>&1 \
  || { echo "atomicity: (g) setup send failed" >&2; exit 1; }
if "$TAP" send codex "$dup2" --from claude --ask --id dup-id --pane target:0.0 >"$TAP_HOME/dup.out" 2>&1; then
  echo "atomicity: (g) duplicate payload id unexpectedly succeeded" >&2; exit 1
fi
grep -q "original body" "$TAP_HOME/payloads/dup-id.md" || {
  echo "atomicity: (g) duplicate send overwrote existing canonical payload" >&2; exit 1
}
printf '{"by":"codex","epoch":"1"}\n' > "$TAP_HOME/receipts/settled-id.done"
if "$TAP" send codex "$dup2" --from claude --ask --id settled-id --pane target:0.0 >"$TAP_HOME/settled.out" 2>&1; then
  echo "atomicity: (g) id with pre-existing .done unexpectedly succeeded" >&2; exit 1
fi
[ ! -f "$TAP_HOME/payloads/settled-id.md" ] || {
  echo "atomicity: (g) settled id wrote canonical payload" >&2; exit 1
}
rm -f "$TAP_HOME/payloads/dup-id.md" "$TAP_HOME/receipts/dup-id.sent" "$TAP_HOME/receipts/settled-id.done"
echo "atomicity: (g) duplicate/settled ids refused before rename: ok"

# ── (b) stamp failure leaves no canonical ────────────────────────────────────
# A payload that opens a frontmatter fence but never closes it causes
# tap_stamp_envelope to die. With the new atomic staging, tap send must exit
# non-zero and leave payloads/ empty.
bad_payload="$TAP_HOME/bad-fence.md"
cat > "$bad_payload" <<'EOF'
---
from: claude
to: codex
kind: discuss
body without a closing fence
EOF

_b_rc=0
"$TAP" send codex "$bad_payload" --from claude --pane target:0.0 \
  >"$TAP_HOME/b.out" 2>&1 || _b_rc="$?"
[ "$_b_rc" != "0" ] || {
  echo "atomicity: (b) stamp-fail send unexpectedly succeeded (exit 0)" >&2; exit 1
}
remaining="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$remaining" = "0" ] || {
  echo "atomicity: (b) stamp failure left $remaining canonical(s) in payloads/" >&2
  find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' >&2
  exit 1
}
sent_count="$(find "$TAP_HOME/receipts/" -maxdepth 1 -name '*.sent' | wc -l | tr -d ' ')"
[ "$sent_count" = "0" ] || {
  echo "atomicity: (b) stamp failure wrote .sent telemetry" >&2; exit 1
}
echo "atomicity: (b) stamp failure leaves no canonical: ok"

# ── (c) pane-gone (exit 3) leaves no canonical ───────────────────────────────
valid_payload="$TAP_HOME/valid.md"
cat > "$valid_payload" <<'EOF'
---
from: claude
to: codex
kind: discuss
---

hello
EOF

_c_rc=0
FAKE_TMUX_GONE=1 "$TAP" send codex "$valid_payload" --from claude --ask --pane target:0.0 \
  >"$TAP_HOME/c.out" 2>&1 || _c_rc="$?"
[ "$_c_rc" = "3" ] || {
  echo "atomicity: (c) expected exit 3 from pane-gone, got $_c_rc" >&2; cat "$TAP_HOME/c.out" >&2; exit 1
}
remaining="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$remaining" = "0" ] || {
  echo "atomicity: (c) pane-gone left $remaining canonical(s) in payloads/" >&2
  exit 1
}
sent_count="$(find "$TAP_HOME/receipts/" -maxdepth 1 -name '*.sent' | wc -l | tr -d ' ')"
[ "$sent_count" = "0" ] || {
  echo "atomicity: (c) pane-gone wrote .sent telemetry" >&2; exit 1
}
echo "atomicity: (c) pane-gone leaves no canonical: ok"

# The pane-gone probe deliberately suspended the row. This next case models a
# valid re-registration before testing a different failure boundary.
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["seats"]["codex"].update(status="active", session="target", pane="target:0.0", pane_id="%602")
d["seats"]["codex"].pop("status_reason", None)
json.dump(d, open(p, "w"), indent=2, sort_keys=True)
PY

# ── (d) pending human input: standard grace queues durably without clobbering ──
# The pending text remains in place; the pending delivery is represented only by
# a standard-policy spool entry until its bounded grace expires.
mkdir -p "$FAKE_TMUX_STATE"
printf 'human typed text' > "$FAKE_TMUX_STATE/input"

_d_rc=0
"$TAP" send codex "$valid_payload" --from claude --ask --pane target:0.0 \
  >"$TAP_HOME/d.out" 2>&1 || _d_rc="$?"
[ "$_d_rc" = "0" ] || {
  echo "atomicity: (d) expected accepted standard grace queue on pending input, got $_d_rc" >&2
  cat "$TAP_HOME/d.out" >&2; exit 1
}
remaining="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$remaining" = "0" ] || {
  echo "atomicity: (d) grace queue should leave no canonical payload, found $remaining" >&2; exit 1
}
sent_count="$(find "$TAP_HOME/receipts/" -maxdepth 1 -name '*.sent' | wc -l | tr -d ' ')"
[ "$sent_count" = "0" ] || {
  echo "atomicity: (d) grace queue should not write .sent telemetry" >&2; exit 1
}
spool_count="$(find "$TAP_HOME/spool/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$spool_count" = "1" ] || { echo "atomicity: (d) expected one durable standard spool entry, found $spool_count" >&2; exit 1; }
[ "$(cat "$FAKE_TMUX_STATE/input")" = 'human typed text' ] || { echo "atomicity: (d) standard grace clobbered pending input" >&2; exit 1; }
meta="$(find "$TAP_HOME/spool/" -maxdepth 1 -name '*.meta.json' -print -quit)"
python3 - "$meta" <<'PY'
import json, sys, time
p = sys.argv[1]; m = json.load(open(p)); now = int(time.time())
m["first_spooled_epoch"] = now - 60; m["deadline_epoch"] = now
json.dump(m, open(p, "w"), indent=2, sort_keys=True)
PY
# The draft is still present, so production holds an EXPIRED pane record at
# the forced deadline (the park minted it on the wall clock); the fake clock
# cannot age it, so move the record deadlines into the past. Refused loudly
# when nothing aged: a vacuous age would let the drain mint a fresh grace
# and the arm would pin a hold instead of the delivery it exists to pin.
bash -c '. "$1"; tap_protection_age_all 1000' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" \
  || { echo "atomicity: (d) aged zero protection records — the expected park-time record is missing" >&2; exit 1; }
bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once "$2"' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$(date +%s)"
[ ! -e "${meta%.meta.json}" ] || { echo "atomicity: (d) deadline did not consume the spool entry" >&2; exit 1; }
remaining="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$remaining" = "1" ] || { echo "atomicity: (d) deadline clobber did not restore exactly one canonical payload" >&2; exit 1; }
backup="$(find "$TAP_HOME/input-backups/" -maxdepth 1 -name '*.md' -print -quit 2>/dev/null)"
[ -n "$backup" ] && grep -qF 'human typed text' "$backup" || { echo "atomicity: (d) deadline clobber did not retain the human draft" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/input"
# reset bus state for the following cases (they assert zero-counts)
find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' -delete
find "$TAP_HOME/receipts/" -maxdepth 1 -name '*.sent' -delete
find "$TAP_HOME/spool/" -maxdepth 1 -type f -delete
# tap-7r3fn.20: the recipient's delivery clock is bus state too, and the cases
# below are about PLACEMENT ATOMICITY — what exists on disk when a send fails
# partway. A delivery above opens this seat's window, so without this the next
# send parks inside it and never reaches the path being tested: arm (e) got a
# queued park where it expected the pane-loss exit 3.
rm -rf "$TAP_HOME/delivery"
echo "atomicity: (d) pending-input standard grace queues, then deadline-clobbers atomically: ok"

# ── (e) failed injection is possible effect: retain custody, never claim sent ─
_e_rc=0
FAKE_TMUX_GONE_ON_SEND=1 "$TAP" send codex "$valid_payload" --from claude --ask --pane target:0.0 \
  >"$TAP_HOME/e.out" 2>&1 || _e_rc="$?"
[ "$_e_rc" = "5" ] || {
  echo "atomicity: (e) expected unverified exit 5 from injection failure, got $_e_rc" >&2
  cat "$TAP_HOME/e.out" >&2
  exit 1
}
remaining="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$remaining" = "1" ] || {
  echo "atomicity: (e) injection failure must retain one canonical, got $remaining" >&2
  exit 1
}
failed_canon="$(find "$TAP_HOME/payloads/" -maxdepth 1 -name '*.md' -print -quit)"
failed_id="$(basename "$failed_canon" .md)"
grep -q '^hello$' "$failed_canon" || { echo "atomicity: (e) retained body changed" >&2; exit 1; }
[ -f "$TAP_HOME/receipts/$failed_id.placed" ] && [ -f "$TAP_HOME/receipts/$failed_id.attempted" ] \
  || { echo "atomicity: (e) possible-effect custody evidence missing" >&2; exit 1; }
sent_count="$(find "$TAP_HOME/receipts/" -maxdepth 1 -name '*.sent' | wc -l | tr -d ' ')"
[ "$sent_count" = "0" ] || {
  echo "atomicity: (e) pane-loss race wrote .sent telemetry" >&2; exit 1
}
echo "atomicity: (e) injection failure retains payload and attempt evidence without sent: ok"

# ── (f) whitespace-bearing TAP_HOME path is rejected before canonical placement ─
SPACE_BUS="$TAP_HOME/space bus"
_f_rc=0
TAP_HOME="$SPACE_BUS" "$TAP" send codex "$valid_payload" --from claude --pane target:0.0 \
  >"$TAP_HOME/f.out" 2>&1 || _f_rc="$?"
[ "$_f_rc" != "0" ] || {
  echo "atomicity: (f) whitespace TAP_HOME send unexpectedly succeeded" >&2; exit 1
}
space_remaining=0
if [ -d "$SPACE_BUS/payloads" ]; then
  space_remaining="$(find "$SPACE_BUS/payloads/" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
fi
[ "$space_remaining" = "0" ] || {
  echo "atomicity: (f) whitespace TAP_HOME left canonical payload" >&2
  find "$SPACE_BUS/payloads/" -maxdepth 1 -name '*.md' >&2
  exit 1
}
space_sent=0
if [ -d "$SPACE_BUS/receipts" ]; then
  space_sent="$(find "$SPACE_BUS/receipts/" -maxdepth 1 -name '*.sent' | wc -l | tr -d ' ')"
fi
[ "$space_sent" = "0" ] || {
  echo "atomicity: (f) whitespace TAP_HOME wrote .sent telemetry" >&2; exit 1
}
echo "atomicity: (f) whitespace path rejected fail-closed: ok"

echo "atomicity: ok"
