#!/usr/bin/env bash
# Partner review B5 U1: `tap incapable` is the manual door that persists
# exactly status=suspended + status_reason=incapable on a live pane seat, and
# the roster reads that pair back as a distinct present-but-incapable state.
# Outside-in through the Bash dispatcher: routing, receipts, refusals, help
# wiring and both roster renderers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-incapable.XXXXXX")"
trap 'rm -rf "${WORK:?}"' EXIT

TEAM_ROOT="$WORK/demo"
INDEX="$WORK/index"
BUS="$TEAM_ROOT/.tap/bus"
REGISTRY="$TEAM_ROOT/.tap/team-registry.json"
FAKE_BIN="$WORK/bin"
TRACE="$WORK/native.trace"
mkdir -p "$INDEX" "$BUS/payloads" "$BUS/receipts" "$FAKE_BIN"

export TAP_HOME="$BUS"
export TAP_INDEX_HOME="$INDEX"
export NO_COLOR=1
export COLUMNS=120
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "incapable-seat-routing: Bun unavailable" >&2; exit 1; }

cat >"$INDEX/global-registry.json" <<JSON
{"schema":"0.20","migrated":{},"teams":{"demo":{"root":"$TEAM_ROOT","registry_location":"$REGISTRY","state":"registered","enrolled_at":"2026-09-01T00:00:00Z"}}}
JSON

seed_registry() {
  cat >"$REGISTRY" <<JSON
{"schema":"0.20","team":{"name":"demo","worktree_root":"$TEAM_ROOT"},
 "seats":{
   "scout":{"pane":"demo-scout:0.0","pane_id":"%1","server_epoch":"srv:900:100","status":"active","status_reason":"","delivery":"pane","harness":"codex","session":"demo/scout","registered_at":"2026-09-01T00:00:00Z","instance":"seat|stable"},
   "peer":{"pane":"demo/peer","pane_id":"%2","server_epoch":"srv:900:100","status":"active","status_reason":"","delivery":"pane","harness":"claude","session":"demo/peer","registered_at":"2026-09-01T00:00:00Z","instance":"peer|stable"},
   "agent":{"pane":"demo/agent","pane_id":"%5","server_epoch":"srv:900:100","status":"active","status_reason":"","delivery":"pane","harness":"codex","session":"demo/agent","registered_at":"2026-09-01T00:00:00Z","instance":"agent|stable"}},
 "seat_forwardings":[{"source":"scout","source_instance":"seat|stable","destination":"scout-alias","destination_instance":"alias|stable","at":"2026-09-01T00:00:00Z","address_active":true}]}
JSON
}
seed_registry
TAPSH="$ROOT/bin/tap"
tap_in_team() { (cd "$TEAM_ROOT" && bash "$TAPSH" "$@"); }

die() { echo "incapable-seat-routing: $1" >&2; exit 1; }

# -- 1. The mark: exactly two values change, nothing else does. --
out="$(tap_in_team incapable scout)"
[ "$out" = "tap incapable: demo/scout marked (suspended/incapable)" ] \
  || die "unexpected mark receipt: $out"
python3 - "$REGISTRY" <<'PY' || die "registry after mark is wrong" >&2
import json, sys
doc = json.load(open(sys.argv[1]))
seat = doc["seats"]["scout"]
assert seat["status"] == "suspended" and seat["status_reason"] == "incapable", seat
assert seat["instance"] == "seat|stable" and seat["pane"] == "demo-scout:0.0", seat
assert doc["seats"]["peer"]["status"] == "active", doc["seats"]["peer"]
assert doc["seat_forwardings"] == [{"source": "scout", "source_instance": "seat|stable", "destination": "scout-alias", "destination_instance": "alias|stable", "at": "2026-09-01T00:00:00Z", "address_active": True}], doc["seat_forwardings"]
PY

# -- 2. The mark rides the native route. --
: >"$TRACE"
TAP_BUN_ROUTE_TRACE="$TRACE" tap_in_team incapable scout >/dev/null
grep -q '^native incapable$' "$TRACE" \
  || { echo "incapable-seat-routing: native route not exercised" >&2; cat "$TRACE" >&2; exit 1; }

# -- 3. A repeat is the acknowledged no-op. --
cp "$REGISTRY" "$WORK/before"
out="$(tap_in_team incapable scout)"
[ "$out" = "tap incapable: demo/scout already_incapable (suspended/incapable)" ] \
  || die "unexpected already receipt: $out"
cmp -s "$REGISTRY" "$WORK/before" || die "already_incapable rewrote the registry"

# -- 4. Refusals never write. --
cp "$REGISTRY" "$WORK/before"
if tap_in_team incapable ghost 2>"$WORK/err"; then die "unknown seat was marked"; fi
grep -q "unknown seat 'demo/ghost'" "$WORK/err" || die "unexpected unknown-seat refusal: $(cat "$WORK/err")"
if tap_in_team incapable demo/scout --team demo 2>"$WORK/err"; then die "selector conflict accepted"; fi
grep -q "not both" "$WORK/err" || die "unexpected selector refusal: $(cat "$WORK/err")"

python3 - "$REGISTRY" <<'PY' || die "crew/poll seeding failed" >&2
import json, sys
doc = json.load(open(sys.argv[1]))
crew = dict(doc["seats"]["peer"]); crew["crew"] = True; doc["seats"]["crewed"] = crew
doc["seats"]["polled"] = {"pane": "", "status": "active", "status_reason": "", "delivery": "poll", "harness": "codex", "instance": "poll|stable"}
json.dump(doc, open(sys.argv[1], "w"))
PY
cp "$REGISTRY" "$WORK/before"
if tap_in_team incapable crewed 2>"$WORK/err"; then die "crew seat was marked"; fi
grep -q "tap crew remove" "$WORK/err" || die "unexpected crew refusal: $(cat "$WORK/err")"
if tap_in_team incapable polled 2>"$WORK/err"; then die "poll seat was marked"; fi
grep -q "poll" "$WORK/err" || die "unexpected poll refusal: $(cat "$WORK/err")"
cmp -s "$REGISTRY" "$WORK/before" || die "a refusal rewrote the registry"

# -- 5. Internal lifecycle detail is discoverable on its dedicated help page. --
# Read to EOF (no grep -q): an early-exiting reader SIGPIPEs the help door's
# write, and pipefail turns that race into a flaky failure.
[[ "$(bash "$TAPSH" help incapable)" == *"status=suspended with status_reason=incapable"* ]] || die "help page missing"
[[ "$(bash "$TAPSH" help incapable)" == *"tap incapable <seat|team/seat>"* ]] || die "dedicated usage line missing"

# -- 6. The roster reads the pair back, straight from the acting team
#      registry this unit marked in section 1. The `●` state door is native. --
cat >"$FAKE_BIN/tmux" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions)
    printf 'demo/scout\t900:100\t0\ndemo/peer\t900:100\t0\n'
    ;;
  list-panes)
    printf 'demo/scout\tdemo/scout:0.0\t%%1\tcodex\t111\t900:100\t0\ndemo/peer\tdemo/peer:0.0\t%%2\tclaude\t112\t900:100\t0\n'
    ;;
  display-message)
    printf '\n'
    ;;
esac
SH
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "incapable-seat-routing: Bun unavailable" >&2; exit 1; }
native_team() { (cd "$ROOT" && "$BUN" "$ROOT/runtime/bun/main.ts" team "$@"); }

: >"$TRACE"
roster="$(TAP_BUN_ROUTE_TRACE="$TRACE" native_team)"
grep -q '^native team$' "$TRACE" || die "roster did not ride the native team route"
[[ "$roster" == *"scout"*"incapable"* ]] || die "narrow roster did not render incapable: $roster"
all_roster="$(native_team --all)"
[[ "$all_roster" == *"suspended"*"incapable"* ]] || die "wide roster did not show suspended+incapable: $all_roster"

native_team --json >"$WORK/team-json"
python3 - "$WORK/team-json" <<'PY' || die "roster json wrong" >&2
import json, sys
agents = {a["handle"]: a for a in json.load(open(sys.argv[1]))["agents"]}
scout = agents["scout"]
assert scout["status"] == "suspended" and scout["status_reason"] == "incapable", scout
assert scout["agent_state"] == "unknown" and scout["agent_state_reason"] == "lifecycle_inactive", scout
assert agents["peer"]["status"] == "active", agents["peer"]
PY

names="$(native_team --names)"
[[ "$names" == *"scout"* ]] || die "plain --names lost the incapable seat: $names"
active_names="$(native_team --names --online)"
if [[ "$active_names" == *"scout"* ]]; then die "active-only names kept the incapable seat: $active_names"; fi

# The Bash door agrees where its surfaces can speak: the wide table carries
# the stored pair verbatim, and both names views keep the same membership.
bash_all="$(tap_in_team team --all)"
[[ "$bash_all" == *"suspended"*"incapable"* ]] || die "bash wide roster lost the pair: $bash_all"
if [[ "$(tap_in_team team --names --online)" == *"scout"* ]]; then die "bash active-only names kept the incapable seat"; fi

# -- 7. Entry routes: the tap.sh entry and a direct Bun entry both land. --
out="$(tap_in_team incapable peer)"
[[ "$out" == *"peer"*"marked"*"suspended/incapable"* ]] || die "tap.sh entry failed: $out"
out="$(cd "$TEAM_ROOT" && "$BUN" "$ROOT/runtime/bun/main.ts" incapable peer)"
[[ "$out" == *"peer"*"already_incapable"*"suspended/incapable"* ]] || die "direct bun entry failed: $out"

# -- 8. Same-team send to a marked seat refuses and spills nothing. --
before_payloads="$(ls "$BUS/payloads" | wc -l | tr -d ' ')"
if tap_in_team send scout -m "anyone there?" --id incap-r1 --from agent 2>"$WORK/send.err"; then
  die "send to an incapable seat was delivered"
fi
grep -q "is suspended" "$WORK/send.err" || die "unexpected send refusal: $(cat "$WORK/send.err")"
# The reason-specific advice must point back at the seat's own pane — never a
# resume and never a manual relay for the operator's own mark.
grep -q "re-register 'scout' from its pane: run 'tap in' there, or 'tap register scout --pane <tmux-target>'" "$WORK/send.err" \
  || die "send refusal did not advertise re-registration: $(cat "$WORK/send.err")"
grep -q "'scout' is suspended (incapable)" "$WORK/send.err" || die "refusal lost the reason: $(cat "$WORK/send.err")"
if grep -q "tap session resume\|Fallback:" "$WORK/send.err"; then die "incapable refusal advertised a bypass: $(cat "$WORK/send.err")"; fi
after_payloads="$(ls "$BUS/payloads" | wc -l | tr -d ' ')"
[ "$before_payloads" = "$after_payloads" ] || die "refused send left a payload behind"

# -- 8b. A canonical obligation bound to the marked seat's exact instance is
#        still a dead obligation: its current sender cancels it through the
#        public door, and cancel never mutates the registry it read. --
SPAYLOAD_ID="agent-20260715T034400S-incapable"
cat >"$BUS/payloads/$SPAYLOAD_ID.md" <<MD
---
id: $SPAYLOAD_ID
from: agent
to: scout
kind: discuss
path: $BUS/payloads/$SPAYLOAD_ID.md
reply: expected
recipient_instance: seat|stable
---
still owe you a review
MD
cp "$REGISTRY" "$WORK/reg-before-cancel"
out="$(tap_in_team cancel "$SPAYLOAD_ID" --by agent)"
grep -q "$SPAYLOAD_ID" <<<"$out" || die "same-team cancel receipt missing the id: $out"
python3 - "$BUS/receipts/$SPAYLOAD_ID.cancelled" <<'PY' || die "same-team cancel receipt wrong" >&2
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "cancelled" and d["target_status"] == "suspended", d
assert d["registry_checked"] == "bound_team_registry", d
PY
[ -f "$BUS/archive/$SPAYLOAD_ID.cancelled.md" ] || die "same-team cancel did not archive the payload"
cmp -s "$REGISTRY" "$WORK/reg-before-cancel" || die "same-team cancel mutated the registry"
[ ! -e "$BUS/reset-generation.json" ] || die "cancel created a reset-generation record"

# -- 9. A foreign team: qualified mark, remote-reader send refusal, then a
#        cross-team cancel that must read the foreign registry. --
OTHER_ROOT="$WORK/other"
OTHER_REGISTRY="$OTHER_ROOT/.tap/team-registry.json"
OTHER_BUS="$OTHER_ROOT/.tap/bus"
mkdir -p "$OTHER_BUS"
python3 - "$INDEX" "$OTHER_ROOT" "$OTHER_REGISTRY" <<'PY' || die "foreign enrollment seeding failed" >&2
import json, sys
index, root, registry = sys.argv[1:4]
doc = json.load(open(f"{index}/global-registry.json"))
doc["teams"]["other"] = {"root": root, "registry_location": registry, "state": "registered", "enrolled_at": "2026-09-01T00:00:00Z"}
json.dump(doc, open(f"{index}/global-registry.json", "w"))
json.dump({"schema": "0.20", "team": {"name": "other", "worktree_root": root},
           "seats": {"scout": {"pane": "other/scout", "pane_id": "%3", "server_epoch": "srv:900:100", "status": "active", "status_reason": "", "delivery": "pane", "harness": "codex", "session": "other/scout", "registered_at": "2026-09-01T00:00:00Z", "instance": "oscout|stable"},
                      "fable": {"pane": "other/fable", "pane_id": "%4", "server_epoch": "srv:900:100", "status": "active", "status_reason": "", "delivery": "pane", "harness": "claude", "session": "other/fable", "registered_at": "2026-09-01T00:00:00Z", "instance": "ofable|stable"}}}, open(registry, "w"))
PY
out="$(tap_in_team incapable other/scout)"
[[ "$out" == *"other/scout"*"marked"*"suspended/incapable"* ]] || die "qualified foreign mark failed: $out"
python3 - "$OTHER_REGISTRY" <<'PY' || die "foreign mark landed wrong" >&2
import json, sys
seat = json.load(open(sys.argv[1]))["seats"]["scout"]
assert seat["status"] == "suspended" and seat["status_reason"] == "incapable", seat
PY
if tap_in_team send other/scout -m "knock knock" --id incap-r2 --from agent 2>"$WORK/fsend.err"; then
  die "foreign send to an incapable seat was delivered"
fi
grep -q "is suspended (incapable)" "$WORK/fsend.err" || die "unexpected foreign send refusal: $(cat "$WORK/fsend.err")"
# Even across teams, the mark's advice stays re-registration at home — the
# manual relay is a bypass this reason never advertises.
grep -q "have 'scout' re-register from its pane in team 'other'" "$WORK/fsend.err" \
  || die "foreign refusal did not advertise home re-registration: $(cat "$WORK/fsend.err")"
if grep -q "Fallback:" "$WORK/fsend.err"; then die "foreign incapable refusal advertised the relay: $(cat "$WORK/fsend.err")"; fi
# The obligation itself lives on the CALLER's bus, stamped for the foreign
# team: cancel must resolve the separate foreign registry through the
# cross-team reader, not just look inside its own bus.
XPAYLOAD_ID="agent-20260715T034501X-incapable"
cat >"$BUS/payloads/$XPAYLOAD_ID.md" <<MD
---
id: $XPAYLOAD_ID
from: agent
to: scout
kind: discuss
path: $BUS/payloads/$XPAYLOAD_ID.md
reply: expected
to_team: other
cross_worktree: true
recipient_instance: oscout|stable
---
still owe you a review
MD
cp "$REGISTRY" "$WORK/reg-before-xcancel"
cp "$OTHER_REGISTRY" "$WORK/oreg-before-xcancel"
out="$(tap_in_team cancel "$XPAYLOAD_ID" --by agent)"
grep -q "$XPAYLOAD_ID" <<<"$out" || die "cross-team cancel receipt missing the id: $out"
python3 - "$BUS/receipts/$XPAYLOAD_ID.cancelled" <<'PY' || die "cross-team cancel receipt wrong" >&2
import json, sys
d = json.load(open(sys.argv[1]))
assert d["status"] == "cancelled" and d["target_status"] == "suspended", d
assert "other" in d["registry_checked"], d
PY
[ -f "$BUS/archive/$XPAYLOAD_ID.cancelled.md" ] || die "cross-team cancel did not archive the payload"
cmp -s "$REGISTRY" "$WORK/reg-before-xcancel" || die "cross-team cancel mutated the caller registry"
cmp -s "$OTHER_REGISTRY" "$WORK/oreg-before-xcancel" || die "cross-team cancel mutated the foreign registry"

# -- 10. Public recovery: a real `tap in` restores active/"" on the same
#        instance. The registerer needs its own tmux/ps stubs — distinct from
#        the roster's — and a worktree root whose basename is the team name. --
git -C "$TEAM_ROOT" init -q
MOCKBIN="$WORK/regbin"
mkdir -p "$MOCKBIN"
FIXTURE_PID=$$
cat >"$MOCKBIN/ps" <<'PS'
#!/usr/bin/env bash
if [ "$#" = 3 ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ] && [ "$3" = "-p" ]; then
  exec /bin/ps "$@"
fi
if [ "$#" = 4 ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ] && [ "$3" = "-p" ]; then
  exec /bin/ps "$@"
fi
printf '1 faketty\n'
PS
cat >"$MOCKBIN/tmux" <<TMUX
#!/usr/bin/env bash
FIXTURE_PID="$FIXTURE_PID"
TMUX
cat >>"$MOCKBIN/tmux" <<'TMUX'
set -euo pipefail
PANE="%1"
SESSION="demo-scout"
PANE_PID="${FAKE_PANE_PID:-$FIXTURE_PID}"
if [ "${1:-}" = list-sessions ]; then
  printf '%s\t4242:100\t0\n' "$SESSION"
  exit 0
fi
if [ "${1:-}" = list-panes ]; then
  panes_fmt=""
  args=("$@"); i=0
  while [ "$i" -lt "${#args[@]}" ]; do
    if [ "${args[$i]}" = "-F" ]; then panes_fmt="${args[$((i+1))]}"; fi
    i=$((i+1))
  done
  case "$panes_fmt" in
    *pane_current_command*) printf '%s\t%s:0.0\t%s\t%s\t%s\t4242:100\t0\n' "$SESSION" "$SESSION" "$PANE" "claude" "$PANE_PID" ;;
    *) printf '%s\t/dev/faketty\n' "$PANE" ;;
  esac
  exit 0
fi
[ "${1:-}" = display-message ] || exit 0
shift
fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) shift 2 ;;
    *) fmt="$1"; shift ;;
  esac
done
case "$fmt" in
  # Bun's combined nine-field caller record — precedes the pane globs.
  *pane_id*pane_tty*session_name*socket_path*pane_current_path*) printf '%s\t/dev/faketty\t%s\t4242:100\t%s:0.0\t%s\tclaude\t\t%s\n' "$PANE" "$SESSION" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" "${FAKE_TMUX_PATH:?}" ;;
  # Bun's combined eight-field pane record.
  *pane_id*session_name*pane_pid*pane_current_command*socket_path*) printf '%s\t%s\t%s\tclaude\t0\t%s:0.0\t\t%s\n' "$PANE" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" "$SESSION" "${FAKE_TMUX_PATH:?}" ;;
  *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t4242:100\n' "$PANE" "$SESSION" ;;
  *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\t%s\t%s\tclaude\t0\n' "$PANE" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" ;;
  *pane_id*session_name*) printf '%s\t%s\t4242:100\n' "$PANE" "$SESSION" ;;
  *pane_id*pane_tty*) printf '%s\t/dev/faketty\n' "$PANE" ;;
  *window_index*) printf '%s:0.0\n' "$SESSION" ;;
  *session_name*) printf '%s\n' "$SESSION" ;;
  *pane_id*) printf '%s\n' "$PANE" ;;
  *pane_pid*) printf '%s\n' "${FAKE_PANE_PID:-$FIXTURE_PID}" ;;
  *pane_current_command*) printf 'claude\n' ;;
  *pane_current_path*) printf '%s\n' "${FAKE_TMUX_PATH:?}" ;;
  *pid*start_time*) printf '4242:100\n' ;;
  *) printf '\n' ;;
esac
TMUX
chmod +x "$MOCKBIN/ps" "$MOCKBIN/tmux"
if ! (cd "$TEAM_ROOT" && env -u TAP_CLEAR_ID -u TMUX_PANE \
    PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-incap,1,0" FAKE_TMUX_PATH="$TEAM_ROOT" \
    TAP_INDEX_HOME="$INDEX" TAP_HOME="$BUS" TAP_SKIP_VERSION_BRIEFING=1 \
    TAP_HARNESS_SESSION_ID=recovered-1111 TAP_SESSION_SOURCE=manual \
    bash "$TAPSH" in scout) >"$WORK/in.out" 2>"$WORK/in.err"; then
  die "tap in recovery failed: $(cat "$WORK/in.err")"
fi
python3 - "$REGISTRY" <<'PY' || die "recovery did not restore active/'' on the same instance" >&2
import json, sys
seat = json.load(open(sys.argv[1]))["seats"]["scout"]
assert seat["status"] == "active" and seat["status_reason"] == "", seat
assert seat["instance"] == "seat|stable", seat
PY
# -- 11. The Bash door must not reconcile before the mark. The verb promises
#        that refusals and no-ops write nothing and that success changes
#        exactly the two stored state fields, so the dispatcher's pre-dispatch
#        server-restart catch-up (which clears stale pane coordinates and
#        parks rows) is skipped for this verb. Seed prior-generation identity,
#        call the public Bash-selected door, and prove the stale fields — and
#        the bystander row's coordinates — survive the mark. --
RECBIN="$WORK/recbin"
mkdir -p "$RECBIN"
cat >"$RECBIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
case "${1:-}" in
  list-sessions|list-panes) exit 1 ;;
  display-message)
    case "${*-}" in
      *socket_path*) printf '/tmp/fake-incap-socket\n' ;;
      *pid*start_time*) printf '4242:100\n' ;;
      *) printf '\n' ;;
    esac ;;
  *) printf '\n' ;;
esac
TMUX
chmod +x "$RECBIN/tmux"
python3 - "$REGISTRY" <<'PY' || die "stale-generation seeding failed" >&2
import json, sys
doc = json.load(open(sys.argv[1]))
stale = {"server_socket": "/tmp/fake-incap-socket", "server_epoch": "srv:1:1"}
scout = doc["seats"]["scout"]
scout.update(stale)
scout.update({"status": "active", "status_reason": "", "pane": "demo/scout", "pane_id": "%1", "delivery": "pane"})
peer = doc["seats"]["peer"]
peer.update(stale)
json.dump(doc, open(sys.argv[1], "w"), indent=1)
PY
out="$(PATH="$RECBIN:$PATH" TAP_SERVER_EPOCH=srv:9:9 tap_in_team incapable scout)"
[ "$out" = "tap incapable: demo/scout marked (suspended/incapable)" ] \
  || die "stale-generation mark receipt: $out"
python3 - "$REGISTRY" <<'PY' || die "pre-dispatch rewrite moved fields beyond the mark" >&2
import json, sys
seats = json.load(open(sys.argv[1]))["seats"]
scout, peer = seats["scout"], seats["peer"]
assert scout["status"] == "suspended" and scout["status_reason"] == "incapable", scout
assert scout.get("pane") == "demo/scout" and scout.get("pane_id") == "%1", scout
assert scout.get("server_epoch") == "srv:1:1" and scout.get("server_socket") == "/tmp/fake-incap-socket", scout
assert peer["status"] == "suspended" and peer["status_reason"] == "incapable", peer
assert peer.get("pane") == "demo/peer" and peer.get("pane_id") == "%2", peer
assert peer.get("server_epoch") == "srv:1:1", peer
PY

# -- 12. Attach must not offer resume for an incapable seat: its pane is
#        still live, so the only way out is re-registration from that pane. --
seed_registry
tap_in_team incapable scout >/dev/null
if tap_in_team attach scout --no-resume 2>"$WORK/attach.err"; then
  die "attach offered something for an incapable seat"
fi
grep -q "re-register 'scout' from its pane" "$WORK/attach.err" \
  || die "attach refusal lacks re-registration advice: $(cat "$WORK/attach.err")"
grep -q "suspended (incapable)" "$WORK/attach.err" \
  || die "attach refusal does not name the mark: $(cat "$WORK/attach.err")"
if grep -q "tap session resume" "$WORK/attach.err"; then
  die "attach refusal still advertises resume: $(cat "$WORK/attach.err")"
fi

# -- 13. The mark clears only from the pane it was made on. A different pane
#        must not take the instance by re-registering over it. --
seed_registry
tap_in_team incapable scout >/dev/null
register_as() {
  (cd "$TEAM_ROOT" && env -u TAP_CLEAR_ID -u TMUX_PANE \
    PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-incap,1,0" FAKE_TMUX_PATH="$TEAM_ROOT" \
    TAP_INDEX_HOME="$INDEX" TAP_HOME="$BUS" TAP_SKIP_VERSION_BRIEFING=1 \
    TAP_HARNESS_SESSION_ID="$1" TAP_SESSION_SOURCE=manual \
    bash "$TAPSH" register scout --pane "$2")
}
cp "$REGISTRY" "$WORK/mark-before"
if register_as foreign-13a "demo/other:0.9" 2>"$WORK/reg13a.err"; then
  die "a foreign pane cleared the mark"
fi
grep -q "cannot be cleared from pane demo/other:0.9" "$WORK/reg13a.err" \
  || die "gate refusal names the wrong pane: $(cat "$WORK/reg13a.err")"
grep -q "re-register from that seat's own pane" "$WORK/reg13a.err" \
  || die "gate refusal lacks the clearing door: $(cat "$WORK/reg13a.err")"
register_as foreign-13b "demo/other:0.9" 2>"$WORK/reg13b.err" || true
cmp -s "$WORK/reg13a.err" "$WORK/reg13b.err" || die "gate refusal is not byte-stable"
python3 - "$REGISTRY" <<'PY' || die "a refused registration rewrote the mark" >&2
import json, sys
seat = json.load(open(sys.argv[1]))["seats"]["scout"]
assert seat["status"] == "suspended" and seat["status_reason"] == "incapable", seat
assert seat["pane"] == "demo-scout:0.0" and seat["pane_id"] == "%1", seat
PY
if ! register_as own-13c "demo-scout:0.0" >"$WORK/reg13c.out" 2>"$WORK/reg13c.err"; then
  die "the seat's own pane could not re-register: $(cat "$WORK/reg13c.err")"
fi
python3 - "$REGISTRY" <<'PY' || die "own-pane registration did not clear the mark" >&2
import json, sys
seat = json.load(open(sys.argv[1]))["seats"]["scout"]
assert seat["status"] == "active" and seat["status_reason"] == "", seat
assert seat["instance"] == "seat|stable", seat
PY

echo "incapable-seat-routing: mark, no-op, refusals, help, roster, boundaries, recovery, attach and the clearing gate agree: ok"
