#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# server-epoch-guard.test.sh — tap-24f: tmux pane/session ids are unique only
# within ONE server lifetime. The keeper LaunchAgent rebirths the server after
# any death, so a stored id routinely resolves on the reborn server to a live
# but UNRELATED pane. The guard: pane-bearing registry writes stamp
# server_epoch ("srv:<pid>:<start>"); readers void a row's stored ids when the
# stamp names a PRIOR epoch and fall back to the session NAME.
#
# Pinned here:
#   1. fixture/native lockstep: tap_server_epoch_now and
#      seat_corpse.server_epoch_now emit the IDENTICAL string for one staged
#      server (same spirit as seat-corpse-lockstep — drift fails loud).
#   2. tap register stamps server_epoch beside pane/pane_id.
#   3. tap_bound_pane_identity_state refuses a stale-epoch binding even when
#      the recycled id resolves live (the injection seam), fail-closed string.
#   4. readers render stale bindings offline without rewriting provenance.
#   5. ordinary refusals do not rewrite rows; explicit recovery retains resume identity.
#   6. tap team refresh preserves durable offline rows.
set -euo pipefail

export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: this file pins TAP_INDEX_HOME alone; the unset-only defaults
# here add the other three machine paths (session manifest, opencode db,
# version-seen) for directly invoked bodies, preserving the scratch index above.
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
SCRIPTS_DIR="$ROOT/skills/tap/scripts"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
FIXTURE_ROOT="$WORK/team"
TAP_HOME="$FIXTURE_ROOT/.tap/bus"
trap 'rm -rf "${WORK:?}" "${FAKE_BIN:?}"' EXIT
export TAP_HOME TAP_INDEX_HOME="$TAP_HOME/index" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TAP_BOOT_ID="boot:1"
export FAKE_SESSION="tap-scout" FAKE_LIVE_SESSIONS="tap-scout"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_INDEX_HOME"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

# Fake tmux: register-collision's derivation (pane id for target T is '%' +
# first cksum field of T; %-target resolves to itself) EXTENDED with the
# server-epoch answer (no-target '#{pid}:#{start_time}' → FAKE_SERVER_EPOCH_RAW)
# and has-session (=NAME exact match against FAKE_LIVE_SESSIONS).
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-S" ]; then
  [ "${2:-}" = "${FAKE_SERVER_SOCKET:-/fake/socket}" ] || exit 1
  shift 2
fi
if [ "${1:-}" = "has-session" ]; then
  name="${3#=}"
  case " ${FAKE_LIVE_SESSIONS:-} " in
    *" $name "*) exit 0 ;;
    *) echo "can't find session: $name" >&2; exit 1 ;;
  esac
fi
if [ "${1:-}" = "list-sessions" ]; then
  for s in ${FAKE_LIVE_SESSIONS:-}; do
    if [[ "$*" == *'start_time'* ]]; then printf '%s\t%s\n' "$s" "${FAKE_SERVER_EPOCH_RAW:-900:100}"
    else printf '%s\n' "$s"
    fi
  done
  exit 0
fi
if [ "${1:-}" = "list-panes" ]; then
  target=""
  for ((i=1; i<=$#; i++)); do
    if [ "${!i}" = "-t" ]; then j=$((i + 1)); value="${!j}"; target="${value#=}"; fi
  done
  if [[ "$*" == *session_name* ]]; then
    address="$target:0.0"
    pane_id="%$(printf '%s' "$address" | cksum | cut -d' ' -f1)"
    printf '%s\t%s\t%s\tcodex\t5900\t%s\t0\n' "$target" "$address" "$pane_id" "${FAKE_SERVER_EPOCH_RAW:-900:100}"
  else
    caller_address="${FAKE_SESSION:-alpha}:0.0"
    printf '%s\t/dev/faketty\n' "%$(printf '%s' "$caller_address" | cksum | cut -d' ' -f1)"
  fi
  exit 0
fi
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *)  fmt="$1"; shift ;;
  esac
done
if [ -n "$target" ]; then
  case " ${FAKE_DEAD_PANES:-} " in *" $target "*) echo "can't find pane: $target" >&2; exit 1 ;; esac
fi
tpid()  {
  local pair
  for pair in ${FAKE_PANE_REMAP:-}; do
    case "$pair" in "$target="*) printf '%s' "${pair#*=}"; return ;; esac
  done
  case "$target" in %*) printf '%s' "$target" ;; *) printf '%%%s' "$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;; esac
}
tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
case "$fmt" in
  # tap-ua9l: the WRITER capture asks for the pane id, the session name and the
  # generation in ONE record, and real tmux answers all three — so this arm has
  # to outrank the bare epoch probe below, or the composite would come back as
  # a lone generation string and the pane id would be that string.
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t/dev/faketty\t%s\t%s\n' "$(tpid)" "$(tsess)" "${FAKE_SERVER_EPOCH_RAW:-900:100}"; else printf '%%900\t/dev/faketty\t%s\t%s\n' "${FAKE_SESSION:-alpha}" "${FAKE_SERVER_EPOCH_RAW:-900:100}"; fi ;;
  *pane_id*session_name*start_time*)
    if [ -n "$target" ]; then printf '%s\t%s\t%s\n' "$(tpid)" "$(tsess)" "${FAKE_SERVER_EPOCH_RAW:-900:100}"
    else printf '%%900\t%s\t%s\n' "${FAKE_SESSION:-alpha}" "${FAKE_SERVER_EPOCH_RAW:-900:100}"; fi ;;
  # Observe-pane probe (tmux.ts observePaneResult): exactly four fields.
  *pane_id*session_name*pane_pid*pane_current_command*)
    if [ -n "$target" ]; then printf '%s\t%s\t5900\tcodex\t0\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\t5900\tcodex\t0\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *pid*start_time*)       printf 'srvfmt-misparse\n' ;; # placeholder: overridden below
  *pane_id*session_name*)
    if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *window_index*)         echo "${FAKE_SESSION:-alpha}:0.0" ;;
  *session_name*)         if [ -n "$target" ]; then tsess; echo; else echo "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*)              if [ -n "$target" ]; then tpid; echo; else echo "%900"; fi ;;
  *pane_current_command*) echo "codex" ;;
  *pane_current_path*)    echo "${FAKE_TMUX_PATH:-$PWD}" ;;
  *socket_path*)          echo "${FAKE_SERVER_SOCKET:-/fake/socket}" ;;
  *) echo "" ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
# The epoch answer needs to outrank the generic globs above; patch the case in
# place: the no-target pid:start_time probe answers FAKE_SERVER_EPOCH_RAW.
python3 - "$FAKE_BIN/tmux" <<'PY'
import sys
path = sys.argv[1]
body = open(path).read()
body = body.replace(
    "  *pid*start_time*)       printf 'srvfmt-misparse\\n' ;; # placeholder: overridden below",
    '  *pid*start_time*)       printf \'%s\\n\' "${FAKE_SERVER_EPOCH_RAW:-900:100}" ;;'
)
open(path, "w").write(body)
PY
fake_pid() { printf '%%%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
export FAKE_TMUX_PATH="$FIXTURE_ROOT"
mkdir -p "$FAKE_TMUX_PATH"
FAKE_TMUX_PATH="$(cd "$FAKE_TMUX_PATH" && pwd -P)"
git -C "$FAKE_TMUX_PATH" init -q
tap_smoke_enroll_current "$FAKE_TMUX_PATH" "$TAP_HOME"
cd "$FAKE_TMUX_PATH"

field() { python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit(0)
print(((reg.get("seats") or reg.get("agents") or {}).get(sys.argv[2]) or {}).get(sys.argv[3], ""))
PY
}
has_agent() { python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if sys.argv[2] in (reg.get("seats") or reg.get("agents") or {}) else 1)
PY
}

# ── 1. two-language lockstep: one staged server, one epoch string ────────────
shell_epoch="$(bash -c ". '$LIB'; tap_server_epoch_now" 2>/dev/null || true)"
native_epoch="$("${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/launcher-fixture.ts" epoch)"
[ -n "$shell_epoch" ] || { echo "epoch: tap_server_epoch_now emitted nothing" >&2; exit 1; }
[ "$shell_epoch" = "srv:900:100" ] || { echo "epoch: shell epoch '$shell_epoch' != srv:900:100" >&2; exit 1; }
[ "$shell_epoch" = "$native_epoch" ] || { echo "epoch: two-language drift — shell '$shell_epoch' vs Bun '$native_epoch'" >&2; exit 1; }
echo "server-epoch: 1/7 — shell and Bun emit one identical epoch string: ok"

# ── 2. tap register stamps server_epoch beside pane/pane_id, and persists the
#       session NAME so name-first resolution has provenance on manual rows ──
tap_smoke_quiet "$TAP" register scout --pane tap-scout:0.0
has_agent scout || { echo "epoch: register scout failed" >&2; exit 1; }
[ "$(field scout server_epoch)" = "srv:900:100" ] || {
  echo "epoch: active-seat write did not stamp server_epoch (got '$(field scout server_epoch)')" >&2; exit 1; }
[ -n "$(field scout session)" ] || {
  echo "epoch: active-seat write did not persist a session name (name-first has no fallback)" >&2; exit 1; }
echo "server-epoch: 2/7 — register stamps server_epoch + session on the active row: ok"

# A private-socket caller cannot join or invalidate this team's other namespace.
[ "$(field scout server_socket)" = /fake/socket ] || { echo 'FAIL: server socket not stamped'; exit 1; }
cp "$TAP_HOME/registry.json" "$TAP_HOME/before-crossing.json"
cross_rc=0
cross_out="$(FAKE_SERVER_SOCKET=/fake/private FAKE_SERVER_EPOCH_RAW=902:300 "$TAP" register private-seat --pane private:0.0 2>&1)" || cross_rc=$?
[ "$cross_rc" != 0 ] && [[ "$cross_out" == *namespace* ]] || { echo "FAIL: cross-namespace registration not refused: $cross_out"; exit 1; }
cmp "$TAP_HOME/registry.json" "$TAP_HOME/before-crossing.json" || { echo 'FAIL: crossing refusal mutated roster'; exit 1; }
FAKE_SERVER_SOCKET=/fake/private FAKE_SERVER_EPOCH_RAW=902:300 tap_smoke_quiet "$TAP" register private-seat --pane private:0.0 --namespace-crossing
[ "$(field private-seat server_socket)" = /fake/private ] || { echo 'FAIL: explicit crossing socket absent'; exit 1; }
[ "$(field scout pane)" = tap-scout:0.0 ] || { echo 'FAIL: explicit crossing erased foreign seat'; exit 1; }
cp "$TAP_HOME/before-crossing.json" "$TAP_HOME/registry.json"
# Poll and offline writers exit before pane namespace admission.
tap_smoke_quiet "$TAP" register poll-probe --delivery poll
[ "$(field poll-probe delivery)" = poll ] || { echo 'FAIL: poll registration entered namespace gate'; exit 1; }
tap_smoke_quiet "$TAP" register scout --offline
[ "$(field scout status)" = suspended ] || { echo 'FAIL: offline registration entered namespace gate'; exit 1; }
cp "$TAP_HOME/before-crossing.json" "$TAP_HOME/registry.json"

# ── 3. identity binding refuses a stale-epoch row even when the id resolves ──
scout_pane="$(field scout pane)"; scout_id="$(field scout pane_id)"
FIXTURE="$ROOT/skills/tap/scripts/smoke/spool-readiness-fixture.sh"
state="$(bash -c ". '$LIB'; . '$FIXTURE'; bound_pane_identity_fixture '$TAP_HOME/registry.json' scout '$scout_pane' '$scout_id'")"
[ "$state" = match ] || { echo "epoch: same-epoch binding should match (got '$state')" >&2; exit 1; }
state="$(FAKE_SERVER_EPOCH_RAW=901:200 bash -c ". '$LIB'; . '$FIXTURE'; bound_pane_identity_fixture '$TAP_HOME/registry.json' scout '$scout_pane' '$scout_id'")"
[ "$state" = server_epoch_stale ] || {
  echo "epoch: stale-epoch binding must refuse with server_epoch_stale (got '$state')" >&2; exit 1; }
echo "server-epoch: 3/7 — injection seam fail-closed on a stale epoch: ok"

# ── 4. readers judge stale stamps; no dispatch-time rewrite ───────────────────
# Add a second active row whose server stamp is current but boot stamp is stale.
# One ordinary roster read after the simulated restart must render BOTH rows
# offline without rewriting either stored row (registry-unit-1-part-08). The
# current row is the control and must remain byte-semantically unchanged.
python3 -B - "$TAP_HOME/registry.json" "$FAKE_TMUX_PATH" <<'PY'
import json, sys
path, root = sys.argv[1:3]
reg = json.load(open(path))
agents = reg["seats"]
agents["scout"].update({
    "harness_session_id": "native-scout", "cwd": root,
    "base": "NameAuthorityB", "tag": "scout", "index": 1,
})
agents["boot-old"] = {
    "status": "active", "delivery": "pane", "harness": "codex",
    "session": "tap-boot", "pane": "tap-boot:0.0", "pane_id": "%boot-old",
    "server_epoch": "srv:901:200", "boot_id": "boot:0",
    "harness_session_id": "native-boot",
}
agents["current"] = {
    "status": "active", "delivery": "pane", "harness": "codex",
    "session": "tap-current", "pane": "tap-current:0.0", "pane_id": "%current",
    "server_epoch": "srv:901:200", "boot_id": "boot:1",
}
agents["removed"] = {
    "status": "suspended", "status_reason": "user_removed", "delivery": "pane",
    "harness": "codex", "session": "tap-removed",
    "pane": "tap-removed:0.0", "pane_id": "%removed",
    "server_epoch": "srv:900:100", "boot_id": "boot:1",
}
for row in agents.values():
    if isinstance(row, dict) and row.get("delivery") != "poll": row["server_socket"] = "/fake/socket"
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

roster_out="$(FAKE_SERVER_EPOCH_RAW=901:200 FAKE_LIVE_SESSIONS='tap-current other/live' "$TAP" team --json)"
python3 -B - "$TAP_HOME/registry.json" "$roster_out" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
rows = reg["seats"]
display = {row["handle"]: row for row in json.loads(sys.argv[2])["agents"]}
for handle, native in (("scout", "native-scout"), ("boot-old", "native-boot")):
    row = rows[handle]
    assert row.get("status") == "active" and row.get("pane_id"), (handle, row)
    assert row.get("harness_session_id") == native, (handle, row)
    assert row.get("session"), (handle, row)
    assert display[handle]["status"] == "offline", (handle, display[handle])
current = rows["current"]
assert current.get("pane") == "tap-current:0.0" and current.get("pane_id") == "%current", current
assert current.get("status") == "active" and not current.get("status_reason"), current
removed = rows["removed"]
assert removed.get("status") == "suspended" and removed.get("status_reason") == "user_removed", removed
PY
echo "server-epoch: 4/7 — readers render stale epoch/boot rows offline and leave the store untouched: ok"

# ── 5. an ordinary refusal never rewrites restart provenance ────────────────
# Rows above include an old epoch and boot. Even a real generation mismatch
# grants no pre-dispatch write; explicit lifecycle recovery owns rebinding.
before_refusal="$(shasum "$TAP_HOME/registry.json")"
if FAKE_SERVER_EPOCH_RAW=901:200 "$TAP" cancel --bogus >"$WORK/refusal.out" 2>"$WORK/refusal.err"; then
  echo "server-epoch: invalid cancel unexpectedly succeeded" >&2
  exit 1
fi
[ "$(shasum "$TAP_HOME/registry.json")" = "$before_refusal" ] || {
  echo "server-epoch: ordinary refusal rewrote the registry" >&2; exit 1;
}
echo "server-epoch: 5/7 — refused command leaves restart provenance untouched: ok"

# ── 6. restart-invalidated rows remain relaunchable ──────────────────────────
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/python-closure-cli.ts" relaunchable "$TAP_HOME/registry.json" scout native-scout
echo "server-epoch: 6/7 — restart-invalidated row retains native resume authority: ok"

# ── 7. team refresh: durable OFFLINE is recovery provenance, not trim authority ──
refresh_out="$(FAKE_SERVER_EPOCH_RAW=901:200 FAKE_LIVE_SESSIONS='tap-current other/live' "$TAP" team refresh 2>&1 || true)"
grep -q "kept 'scout'; offline:server_epoch_stale" <<<"$refresh_out" || {
  echo "epoch: refresh did not preserve the restart-invalidated row (output: $refresh_out)" >&2; exit 1; }
has_agent scout || { echo "epoch: refresh destroyed the stale row's recovery pointer" >&2; exit 1; }
echo "server-epoch: 7/7 — refresh preserves restart-invalidated rows as offline: ok"

# ── 8. a stale active membership does not license cancelling its mail ────────
# Read-time delivery refusal and cancellation authority are separate. A restart
# does not retire the member or let cancel manufacture a suspended row.
ID_MAIL="alice-20260920T000000Z-epoch08"
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
doc["seats"]["alice"] = {
    "status": "active", "delivery": "poll", "harness": "codex",
    "instance": "alice|aaaabbbbccccdddd",
}
doc["seats"]["mail-target"] = {
    "status": "active", "delivery": "pane", "harness": "codex",
    "session": "tap-mail", "pane": "tap-mail:0.0", "pane_id": "%mail",
    "server_epoch": "srv:900:100", "boot_id": "boot:1", "server_socket": "/fake/socket",
    "instance": "mail|deadbeefdeadbeef",
}
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
cat > "$TAP_HOME/payloads/${ID_MAIL}.md" <<EOF
---
id: $ID_MAIL
from: alice
to: mail-target
kind: discuss
path: $TAP_HOME/payloads/${ID_MAIL}.md
reply: settle-only
recipient_instance: mail|deadbeefdeadbeef
sender_instance: alice|aaaabbbbccccdddd
---
mail remains bound to the active member through a server restart
EOF
: > "$TAP_HOME/receipts/${ID_MAIL}.sent"
mail_registry_before="$(shasum "$TAP_HOME/registry.json")"
mail_payload_before="$(shasum "$TAP_HOME/payloads/${ID_MAIL}.md")"
trace="$TAP_HOME/cancel-route-trace"
set +e
FAKE_SERVER_EPOCH_RAW=902:300 TAP_BUN_ROUTE_TRACE="$trace" \
  "${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/main.ts" cancel "$ID_MAIL" --by alice \
  > "$TAP_HOME/cancel-out" 2> "$TAP_HOME/cancel-err"
mail_rc=$?
set -e
printf 'native cancel\n' > "$TAP_HOME/expected-cancel-trace"
cmp -s "$trace" "$TAP_HOME/expected-cancel-trace" \
  || { echo "epoch: (8) route trace must be exactly one native cancel dispatch (got: $(cat "$trace" 2>/dev/null))" >&2; exit 1; }
[ "$mail_rc" -eq 1 ] || { echo "epoch: (8) active membership must refuse cancel" >&2; exit 1; }
grep -q "still an active registered seat" "$TAP_HOME/cancel-err" || {
  echo "epoch: (8) refusal must name active membership" >&2; cat "$TAP_HOME/cancel-err" >&2; exit 1;
}
[ ! -e "$TAP_HOME/receipts/${ID_MAIL}.cancelled" ] || { echo "epoch: (8) refusal wrote a cancellation receipt" >&2; exit 1; }
[ "$(shasum "$TAP_HOME/registry.json")" = "$mail_registry_before" ] || { echo "epoch: (8) refusal rewrote the registry" >&2; exit 1; }
[ "$(shasum "$TAP_HOME/payloads/${ID_MAIL}.md")" = "$mail_payload_before" ] || { echo "epoch: (8) refusal changed the payload" >&2; exit 1; }
echo "server-epoch: 8/8 — direct-door cancel keeps active membership and its mail: ok"

echo "server-epoch-guard: all green"
