#!/usr/bin/env bash
# Refuse `source` so this fixture cannot leak its isolated environment into a
# caller. Keep the guard before `set -o` as required by the inventory contract.

# tap-7r3fn.20: this fixture is about reply-to alias routing and sends repeatedly
# to one seat, so every send after the first would park in that seat's window
# instead of reaching the routing under test.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window), and it says so without knowing where the clock
# is stored — unlike deleting the clock directory by hand.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# send-reply-to-alias.test.sh — v0.22 item 14a
# `tap send <to> --reply-to <message-id> -f <path>` is the explicit-target
# spelling of `tap reply <message-id> -f <path>`.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

WORK="$(mktemp -d)"; TAP_HOME="$WORK/repo/.tap/bus"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX=/fake/socket
tap_smoke_enroll_current "$WORK/repo" "$TAP_HOME" testteam
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
export TAP_SELF=receiver
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_TMUX_STATE:?}"
mkdir -p "\$state"
cmd="\${1:-}"
shift || true
case "\$cmd" in
  list-sessions) printf 'sess\\t900:100\\n' ;;
  list-panes) printf 'sess\\treceiver-pane\\t%%1001\\tcodex\\t4242\\t900:100\\t0\\nsess\\tsender-pane\\t%%1002\\tcodex\\t4242\\t900:100\\t0\\nsess\\tother-pane\\t%%1003\\tcodex\\t4242\\t900:100\\t0\\n' ;;
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p) shift ;;
        -t) target="\${2:-}"; shift 2 ;;
        *) fmt="\$1"; shift ;;
      esac
    done
    if [ "\$fmt" = '#{pid}:#{start_time}' ]; then printf '900:100\\n'; exit 0; fi
    if [ -z "\$target" ]; then echo 'receiver-pane'; exit 0; fi
    case "\$target" in
      receiver-pane|%1001) pane_id=%1001 ;; sender-pane|%1002) pane_id=%1002 ;;
      other-pane|%1003) pane_id=%1003 ;; *) pane_id=%1004 ;;
    esac
    case "\$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\\tsess\\t4242\\tcodex\\t0\\n' "\$pane_id" ;;
      *pane_id*) echo "\$pane_id" ;;
      *pane_pid*) echo '4242' ;;
      *pane_in_mode*) echo '0' ;;
      *pane_current_command*) echo 'codex' ;;
      *pane_current_path*) echo "$ROOT" ;;
      *) echo '' ;;
    esac
    ;;
  capture-pane)
    if [ -f "\$state/input" ]; then printf '› %s\\n' "\$(cat "\$state/input")"; else printf '› \\n'; fi
    ;;
  send-keys)
    if [ "\${1:-}" = '-t' ]; then shift 2; fi
    if [ "\${1:-}" = '-l' ]; then
      shift
      [ "\${1:-}" = '--' ] && shift
      printf '%s' "\${1:-}" > "\$state/input"
      printf '%s' "\${1:-}" >> "\$state/sentinels"
      exit 0
    fi
    if [ "\${1:-}" = 'Enter' ]; then rm -f "\$state/input"; fi
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "receiver": { "pane": "receiver-pane", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "sender": { "pane": "sender-pane", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "other": { "pane": "other-pane", "pane_id": "%1003", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" }
  } }
JSON

make_inbound() {
  local id="$1"
  cat > "$TAP_HOME/payloads/$id.md" <<EOF
---
id: $id
from: sender
to: receiver
kind: discuss
reply: expected
path: $TAP_HOME/payloads/$id.md
---
original request
EOF
}

payload_for_in_reply_to() {
  local id="$1" payload
  for payload in "$TAP_HOME"/payloads/*.md; do
    [ -f "$payload" ] || continue
    grep -q "^in_reply_to: $id$" "$payload" && { printf '%s\n' "$payload"; return 0; }
  done
  return 1
}

# tap-zrp53: a refusal is complete only when the bus it declined is untouched.
# Snapshot every residency the alias can reach — payloads, receipts, the fake
# courier's sentinel/input state, spool and archive — names and bytes together,
# so "no .done marker" grows into "nothing moved at all".
bus_state() (
  cd "$TAP_HOME" || exit 0
  # `|| true` on each find: a residency that does not exist yet (spool, archive)
  # must read as absent, not kill the snapshot through pipefail.
  find payloads receipts fake-tmux spool archive -mindepth 1 2>/dev/null | LC_ALL=C sort || true
  find payloads receipts fake-tmux spool archive -type f 2>/dev/null | LC_ALL=C sort |
    while IFS= read -r f; do cksum < "$f" 2>/dev/null || true; done || true
)

assert_bus_unchanged() {
  local label="$1" before="$2" after
  after="$(bus_state)"
  if [ "$before" != "$after" ]; then
    echo "send-reply-to-alias: $label refusal mutated bus state" >&2
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    exit 1
  fi
}

BODY="$TAP_HOME/answer.md"
printf '%s\n' 'same literal answer' > "$BODY"

# A canonical reply's --reply-to is the outbound's next-hop metadata. It must
# not be reinterpreted as this alias while tap reply composes tap send.
make_inbound canonical-composition
make_inbound other
"$TAP" reply canonical-composition --reply-to other -f "$BODY" > "$TAP_HOME/composition.out" 2>&1
[ -f "$TAP_HOME/receipts/canonical-composition.done" ] || { echo 'send-reply-to-alias: canonical composition did not settle its inbound' >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/other.done" ] || { echo 'send-reply-to-alias: canonical composition settled the next-hop id' >&2; exit 1; }
composition_out="$(payload_for_in_reply_to canonical-composition)" || { echo 'send-reply-to-alias: canonical composition outbound missing' >&2; exit 1; }
grep -q '^to: sender$' "$composition_out" || { echo 'send-reply-to-alias: canonical composition target changed' >&2; cat "$composition_out" >&2; exit 1; }
grep -q '^reply_to: testteam/other$' "$composition_out" || { echo 'send-reply-to-alias: canonical composition next-hop metadata missing' >&2; cat "$composition_out" >&2; exit 1; }
echo 'send-reply-to-alias: (1) canonical reply does not alias its outbound next-hop: ok'

# Canonical reply establishes the body/target behavior the alias must preserve.
make_inbound canonical-reply
"$TAP" reply canonical-reply -f "$BODY" > "$TAP_HOME/canonical.out" 2>&1
[ -f "$TAP_HOME/receipts/canonical-reply.done" ] || { echo 'send-reply-to-alias: canonical reply did not settle' >&2; exit 1; }
canonical_out="$(payload_for_in_reply_to canonical-reply)" || true
[ -n "$canonical_out" ] || { echo 'send-reply-to-alias: canonical reply body missing' >&2; exit 1; }
grep -q '^to: sender$' "$canonical_out" || { echo 'send-reply-to-alias: canonical reply target changed' >&2; cat "$canonical_out" >&2; exit 1; }

# (2) The alias addresses the same message-id and must produce the same reply
# body/target plus the same inbound settlement.
make_inbound alias-reply
ALIAS_BODY="$TAP_HOME/alias-answer.md"
printf '%s\n' 'different literal alias answer' > "$ALIAS_BODY"
"$TAP" send sender --reply-to alias-reply -f "$ALIAS_BODY" > "$TAP_HOME/alias.out" 2>&1
[ -f "$TAP_HOME/receipts/alias-reply.done" ] || { echo 'send-reply-to-alias: alias did not settle the addressed id' >&2; exit 1; }
alias_out="$(payload_for_in_reply_to alias-reply)" || true
[ -n "$alias_out" ] || { echo 'send-reply-to-alias: alias reply body missing' >&2; exit 1; }
grep -q 'different literal alias answer' "$alias_out" || { echo 'send-reply-to-alias: alias selected the wrong outbound payload' >&2; cat "$alias_out" >&2; exit 1; }
grep -q '^to: sender$' "$alias_out" || { echo 'send-reply-to-alias: alias target differs from tap reply' >&2; cat "$alias_out" >&2; exit 1; }
echo 'send-reply-to-alias: (2) alias matches tap reply settlement and target: ok'

# (3) An explicit target other than the original sender refuses before any
# payload or settlement mutation, naming both handles in one reason line.
make_inbound alias-mismatch
mismatch_bus="$(bus_state)"
set +e
mismatch_out="$("$TAP" send other --reply-to alias-mismatch -f "$BODY" 2>&1)"
mismatch_rc=$?
set -e
[ "$mismatch_rc" -ne 0 ] || { echo 'send-reply-to-alias: mismatched recipient should refuse' >&2; exit 1; }
mismatch_line="$(printf '%s\n' "$mismatch_out" | grep -F "other" | grep -F "sender" | head -1 || true)"
[ -n "$mismatch_line" ] || { echo 'send-reply-to-alias: mismatch refusal must name both handles' >&2; printf '%s\n' "$mismatch_out" >&2; exit 1; }
[ "$(printf '%s\n' "$mismatch_line" | wc -l | tr -d ' ')" -eq 1 ] || { echo 'send-reply-to-alias: mismatch reason must be one line' >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/alias-mismatch.done" ] || { echo 'send-reply-to-alias: mismatch refusal settled inbound' >&2; exit 1; }
assert_bus_unchanged '(3) mismatch' "$mismatch_bus"
echo 'send-reply-to-alias: (3) mismatched recipient refusal names both handles: ok'

# (4) The alias requires the literal file-body form.
make_inbound alias-missing-file
missing_bus="$(bus_state)"
set +e
missing_out="$("$TAP" send sender --reply-to alias-missing-file 2>&1)"
missing_rc=$?
set -e
[ "$missing_rc" -ne 0 ] || { echo 'send-reply-to-alias: missing -f should refuse' >&2; exit 1; }
printf '%s\n' "$missing_out" | grep -Fq -- '-f' || { echo 'send-reply-to-alias: missing-file refusal must name -f' >&2; printf '%s\n' "$missing_out" >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/alias-missing-file.done" ] || { echo 'send-reply-to-alias: missing-file refusal settled inbound' >&2; exit 1; }
assert_bus_unchanged '(4) missing -f' "$missing_bus"
echo 'send-reply-to-alias: (4) missing -f refusal: ok'

# (5) Alias mode must not silently discard a second body source or an output
# flag that tap reply cannot honor.
make_inbound alias-dual-body
dual_bus="$(bus_state)"
set +e
dual_out="$("$TAP" send sender --reply-to alias-dual-body -m ignored -f "$ALIAS_BODY" 2>&1)"
dual_rc=$?
set -e
[ "$dual_rc" -ne 0 ] || { echo 'send-reply-to-alias: dual body sources should refuse' >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/alias-dual-body.done" ] || { echo 'send-reply-to-alias: dual-body refusal settled inbound' >&2; exit 1; }
assert_bus_unchanged '(5) dual body' "$dual_bus"

make_inbound alias-json
json_bus="$(bus_state)"
set +e
json_out="$("$TAP" send sender --reply-to alias-json -f "$ALIAS_BODY" --json 2>&1)"
json_rc=$?
set -e
[ "$json_rc" -ne 0 ] || { echo 'send-reply-to-alias: unsupported --json should refuse' >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/alias-json.done" ] || { echo 'send-reply-to-alias: unsupported-option refusal settled inbound' >&2; exit 1; }
assert_bus_unchanged '(5) --json' "$json_bus"
# --no-spool is a send-only direct-attempt contract. Delegating without it
# would silently turn the requested refusal policy into ordinary reply delivery.
make_inbound alias-no-spool
no_spool_bus="$(bus_state)"
no_spool_rc=0
"$TAP" send sender --reply-to alias-no-spool -f "$ALIAS_BODY" --no-spool > "$TAP_HOME/no-spool.out" 2>&1 || no_spool_rc=$?
[ "$no_spool_rc" -ne 0 ] || { echo 'send-reply-to-alias: --no-spool was silently discarded' >&2; exit 1; }
[ ! -f "$TAP_HOME/receipts/alias-no-spool.done" ] || { echo 'send-reply-to-alias: --no-spool refusal settled inbound' >&2; exit 1; }
assert_bus_unchanged '(5) --no-spool' "$no_spool_bus"
grep -F 'does not accept send-only options' "$TAP_HOME/no-spool.out" >/dev/null || { cat "$TAP_HOME/no-spool.out" >&2; exit 1; }
echo 'send-reply-to-alias: (5) unsupported alias inputs refuse without settlement: ok'

# (6) A foreign alias found through the machine index must still be refused at
# the caller's unanchored bus boundary. The alias branch must not delegate to
# tap-reply first, because tap-reply creates the cwd-derived bus before it can
# refuse the same unanchored caller.
FOREIGN_ROOT="$TAP_HOME/foreign-root"
FOREIGN_BUS="$FOREIGN_ROOT/.tap/bus"
FOREIGN_INDEX="$TAP_HOME/foreign-index"
WRONG_CWD="$TAP_HOME/unanchored-cwd"
WRONG_HOME="$TAP_HOME/unanchored-home"
FOREIGN_ID='foreign-sender-20260828T000000Z-k1x5u0abcdef'
mkdir -p "$FOREIGN_BUS/payloads" "$FOREIGN_BUS/receipts" "$FOREIGN_INDEX" "$WRONG_CWD" "$WRONG_HOME"
cat > "$FOREIGN_BUS/payloads/$FOREIGN_ID.md" <<EOF
---
id: $FOREIGN_ID
from: foreign-sender
to: receiver
kind: discuss
reply: expected
path: $FOREIGN_BUS/payloads/$FOREIGN_ID.md
---
foreign inbound
EOF
python3 -B - "$FOREIGN_INDEX/global-registry.json" "$FOREIGN_ROOT" <<'PY'
import json
import pathlib
import sys

marker, root = map(pathlib.Path, sys.argv[1:])
marker.write_text(json.dumps({
    "schema": "0.20",
    "teams": {
        "foreign-team": {
            "root": str(root),
            "registry_location": str(root / ".tap" / "team-registry.json"),
            "state": "registered",
        },
    },
}) + "\n")
PY
set +e
foreign_plain_out="$(cd "$WRONG_CWD" && env -u TAP_HOME -u TMUX -u TMUX_PANE \
  HOME="$WRONG_HOME" TAP_INDEX_HOME="$FOREIGN_INDEX" \
  "$TAP" send foreign-sender --reply-to "$FOREIGN_ID" -f "$BODY" 2>&1)"
foreign_plain_rc=$?
set -e
[ "$foreign_plain_rc" -ne 0 ] || { echo 'send-reply-to-alias: unanchored foreign alias should refuse' >&2; exit 1; }
[ ! -e "$WRONG_CWD/.tap/bus/payloads" ] || {
  echo 'send-reply-to-alias: supported foreign alias refusal created cwd payloads' >&2
  exit 1
}
[ ! -e "$WRONG_CWD/.tap/bus/receipts" ] || {
  echo 'send-reply-to-alias: supported foreign alias refusal created cwd receipts' >&2
  exit 1
}

# The JSON arm isolates the structured refusal class from the supported-input
# materialization control above.
set +e
foreign_out="$(cd "$WRONG_CWD" && env -u TAP_HOME -u TMUX -u TMUX_PANE \
  HOME="$WRONG_HOME" TAP_INDEX_HOME="$FOREIGN_INDEX" \
  "$TAP" send foreign-sender --reply-to "$FOREIGN_ID" -f "$BODY" --json 2>&1)"
foreign_rc=$?
set -e
[ "$foreign_rc" -ne 0 ] || { echo 'send-reply-to-alias: unanchored foreign alias JSON should refuse' >&2; exit 1; }
python3 -B -c 'import json, sys; value = json.loads(sys.argv[1]); assert value["error_class"] == "unanchored_bus", value' "$foreign_out" || {
  echo 'send-reply-to-alias: foreign alias refusal must identify unanchored_bus' >&2
  printf '%s\n' "$foreign_out" >&2
  exit 1
}
[ ! -e "$WRONG_CWD/.tap/bus/payloads" ] || {
  echo 'send-reply-to-alias: foreign alias refusal created cwd payloads' >&2
  exit 1
}
[ ! -e "$WRONG_CWD/.tap/bus/receipts" ] || {
  echo 'send-reply-to-alias: foreign alias refusal created cwd receipts' >&2
  exit 1
}
echo 'send-reply-to-alias: (6) foreign alias refuses before unanchored bus materialization: ok'

echo 'send-reply-to-alias: ok'
