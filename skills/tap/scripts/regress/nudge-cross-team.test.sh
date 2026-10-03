#!/usr/bin/env bash
# nudge-cross-team.test.sh — tap-zvx: `tap nudge <team>/<handle>` resolves a foreign
# team's pane the same way `tap send` does (machine index → repo root → that
# worktree's registry → pane address), instead of only looking up bare handles in
# the LOCAL registry. A bare visible recipient inherits a qualified argv target's
# team; an explicit recipient stays authoritative. `--pane` may supply the
# candidate address but must agree with the visible sentinel's bound identity;
# bare-handle local behavior is unchanged; an unknown team or handle is a clean
# error, never a crash.
# Tests redirect TAP_INDEX_HOME — never the real ~/.tap. Pure fake-tmux.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap
export FAKE_TMUX_STATE="$WORK/fake-tmux"; mkdir -p "$FAKE_TMUX_STATE"

# Fake tmux: any live pane returns pane_id "%<target>", an agent command, and the
# stuck sentinel currently in $state/input; Enter clears it (submit). A target listed
# in FAKE_DEAD_PANES is gone. One shared input file is enough — each case resolves a
# single pane and we assert the re-submit cleared it.
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
case "$cmd" in
  # CONTRACT §Session-name authority: nudge re-authorizes exact-session pane
  # membership with current generation and expected-harness evidence.
  list-sessions) printf 'RemoteTeam/hermes\t900:100\nLocalTeam/localguy\t900:100\nLocalTeam/ghost\t900:100\nRemoteTeam/sleepy\t900:100\n' ;;
  list-panes)
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2:-}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      '=RemoteTeam/hermes') printf 'RemoteTeam/hermes\thermes:0.0\t%%1001\tcodex\t4242\t900:100\t0\n' ;;
      '=LocalTeam/localguy') printf 'LocalTeam/localguy\tlocalpane:0.0\t%%1002\tcodex\t4242\t900:100\t0\n' ;;
      '=LocalTeam/ghost') printf 'LocalTeam/ghost\tghost-local:0.0\t%%1003\tcodex\t4242\t900:100\t0\n' ;;
      '=RemoteTeam/sleepy') printf 'RemoteTeam/sleepy\tsleepy:0.0\t%%1004\tcodex\t4242\t900:100\t0\n' ;;
      *) exit 1 ;;
    esac ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    # The native submit loop's pane identity: the server identity (no target), then one combined read.
    [ "$fmt" != '#{pid}:#{start_time}' ] || { echo "900:100"; exit 0; }
    case " ${FAKE_DEAD_PANES:-} " in *" $target "*) exit 1 ;; esac
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in hermes:0.0) id="%1001" ;; localpane:0.0) id="%1002" ;; ghost-local:0.0) id="%1003" ;; sleepy:0.0) id="%1004" ;; *) id="%1005" ;; esac
        printf '%s\t%s\t4242\tcodex\t0\n' "$id" "${target%%:*}" ;;
      *pane_id*)              case "$target" in hermes:0.0) echo "%1001" ;; localpane:0.0) echo "%1002" ;; ghost-local:0.0) echo "%1003" ;; sleepy:0.0) echo "%1004" ;; *) echo "%1005" ;; esac ;;
      # nudge-start (recovery/cli.ts) requires a numeric #{pane_pid} for its target.
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"

new_team() {  # <name> <root>  — bootstrap a .tap/bus team registry with one pane seat
  local name="$1" root="$2" handle="$3" pane="$4"
  local pane_id
  case "$handle" in hermes) pane_id='%1001' ;; localguy) pane_id='%1002' ;; *) return 1 ;; esac
  mkdir -p "$root/.tap/bus/payloads" "$root/.tap/bus/receipts"
  cat > "$root/.tap/bus/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "$name" },
  "seats": { "$handle": { "pane": "$pane", "pane_id": "$pane_id", "session": "$name/$handle", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" } } }
JSON
  # Born live (F2a): enroll in the global-registry marker, never legacy teams.json.
  python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$name" "$root" <<'PY'
import json, os, sys
idx, name, root = sys.argv[1:4]
os.makedirs(os.path.dirname(idx), exist_ok=True)
root = os.path.realpath(root)
data = json.load(open(idx)) if os.path.exists(idx) else {"schema": "0.20"}
data.setdefault("teams", {})[name] = {"root": root, "registry_location": os.path.join(root, ".tap/bus/registry.json"), "state": "registered", "enrolled_at": "x"}
json.dump(data, open(idx, "w"), indent=2, sort_keys=True)
PY
}

# LocalTeam is where nudge runs from (its bus is our TAP_HOME); RemoteTeam is the
# foreign team we address as RemoteTeam/hermes.
new_team LocalTeam  "$WORK/LocalTeam"  localguy localpane:0.0
new_team RemoteTeam "$WORK/RemoteTeam" hermes   hermes:0.0
# The local team also has the name used by the missing-remote refusal case. This
# pins the incident's dangerous collision shape: RemoteTeam/ghost must not fall
# through to an otherwise valid LocalTeam/ghost binding.
python3 -B - "$WORK/LocalTeam/.tap/bus/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["ghost"] = {"pane": "ghost-local:0.0", "pane_id": "%1003", "session": "LocalTeam/ghost", "server_epoch": "srv:900:100", "harness": "codex", "status": "active"}
json.dump(reg, open(path, "w"), indent=2, sort_keys=True)
PY
# RemoteTeam also has a pane-less poll-mode member (a daemon seat).
python3 -B - "$WORK/RemoteTeam/.tap/bus/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"]["pollbot"] = {"status": "active", "delivery": "poll", "harness": "hermes"}
# ...and a SUSPENDED pane seat (a parked entry — not a delivery target).
reg["seats"]["sleepy"] = {"pane": "sleepy:0.0", "pane_id": "%1004", "session": "RemoteTeam/sleepy", "server_epoch": "srv:900:100", "harness": "codex", "status": "suspended", "status_reason": "user_removed"}
json.dump(reg, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
export TAP_HOME="$WORK/LocalTeam/.tap/bus"

seed_sentinel() { printf '[[TAP v=0.6 from=fable to=%s id=%s kind=discuss reply=expected path=/tmp/%s.md]]' "$2" "$1" "$1" > "$FAKE_TMUX_STATE/input"; }

# ── 1. team-qualified target resolves the FOREIGN team's pane and re-submits ──────
seed_sentinel nudge-xteam-1 RemoteTeam/hermes
"$TAP" nudge RemoteTeam/hermes >"$WORK/x1.out" 2>&1 || { echo "nudge-xteam: (1) team-qualified nudge failed" >&2; cat "$WORK/x1.out" >&2; exit 1; }
grep -q 're-submitted' "$WORK/x1.out" || { echo "nudge-xteam: (1) should re-submit the foreign stuck sentinel" >&2; cat "$WORK/x1.out" >&2; exit 1; }
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (1) foreign sentinel did not clear" >&2; exit 1; }
echo "nudge-xteam: (1) <team>/<handle> resolves the foreign registry pane and re-submits: ok"

# ── 1a. a bare sentinel recipient inherits the candidate pane's team ─────────────
# Same-team wire sentinels carry a bare to= handle. When a qualified cross-team
# argv target located this pane, nudge must interpret that bare handle in the
# located pane's team rather than the invoker's local team.
seed_sentinel nudge-xteam-1a hermes
"$TAP" nudge RemoteTeam/hermes >"$WORK/x1a.out" 2>&1 || {
  echo "nudge-xteam: (1a) bare foreign sentinel recipient failed from another team" >&2
  cat "$WORK/x1a.out" >&2
  exit 1
}
grep -q 're-submitted' "$WORK/x1a.out" || {
  echo "nudge-xteam: (1a) bare foreign sentinel recipient should bind to RemoteTeam" >&2
  cat "$WORK/x1a.out" >&2
  exit 1
}
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (1a) bare foreign sentinel did not clear" >&2; exit 1; }
echo "nudge-xteam: (1a) bare sentinel recipient binds to the qualified candidate pane's team: ok"

# ── 1b. a missing recipient in that team refuses without local fallback ──────────
# An explicit pane lets nudge inspect the sentinel even though RemoteTeam/ghost has
# no registry row. The inferred team remains authoritative: absence must refuse
# rather than retrying the bare handle in LocalTeam.
seed_sentinel nudge-xteam-1b ghost
set +e
missing_remote="$("$TAP" nudge RemoteTeam/ghost --pane hermes:0.0 2>&1)"; rc_missing_remote=$?
set -e
[ "$rc_missing_remote" -eq 1 ] || {
  echo "nudge-xteam: (1b) missing inferred recipient should refuse with exit 1" >&2
  echo "$missing_remote" >&2
  exit 1
}
[[ "$missing_remote" == *"RemoteTeam/ghost"* && "$missing_remote" != *"LocalTeam/ghost"* ]] || {
  echo "nudge-xteam: (1b) missing inferred recipient must not fall back to the invoker team" >&2
  echo "$missing_remote" >&2
  exit 1
}
[[ "$missing_remote" == *"recipient is missing, inactive, or not pane-backed"* ]] || {
  echo "nudge-xteam: (1b) missing inferred recipient should name the binding failure" >&2
  echo "$missing_remote" >&2
  exit 1
}
[ -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (1b) missing inferred recipient must not submit" >&2; exit 1; }
echo "nudge-xteam: (1b) missing inferred recipient refuses without local-team fallback: ok"

# ── 1c. the resolution reads the FOREIGN registry, not the local one ─────────────
# 'hermes' exists ONLY in RemoteTeam; a bare local lookup would miss it. That the
# nudge above succeeded already proves cross-registry resolution — assert the
# negative too: a bare (unqualified) 'hermes' from LocalTeam has no local pane.
seed_sentinel nudge-xteam-1c RemoteTeam/hermes
set +e
bare_hermes="$("$TAP" nudge hermes 2>&1)"; rc_bare=$?
set -e
[ "$rc_bare" -ne 0 ] || { echo "nudge-xteam: (1c) bare 'hermes' should NOT resolve from LocalTeam (it's a RemoteTeam handle)" >&2; echo "$bare_hermes" >&2; exit 1; }
[[ "$bare_hermes" == *"no registered pane for 'hermes'"* ]] || { echo "nudge-xteam: (1c) bare unknown handle should be the clean local registration error" >&2; echo "$bare_hermes" >&2; exit 1; }
echo "nudge-xteam: (1c) team-qualification is what reaches the foreign registry (bare stays local): ok"

# ── 2. bare-handle LOCAL behavior unchanged ──────────────────────────────────────
seed_sentinel nudge-xteam-2 LocalTeam/localguy
"$TAP" nudge localguy >"$WORK/x2.out" 2>&1 || { echo "nudge-xteam: (2) bare local nudge failed" >&2; cat "$WORK/x2.out" >&2; exit 1; }
grep -q 're-submitted' "$WORK/x2.out" || { echo "nudge-xteam: (2) bare local nudge should still re-submit via the local registry" >&2; cat "$WORK/x2.out" >&2; exit 1; }
echo "nudge-xteam: (2) bare-handle local resolution unchanged: ok"

# ── 2a. pane-only + bare recipient retains local-team resolution ─────────────────
# With no argv target there is no ARGV_TEAM provenance to add. The visible bare
# recipient must continue through the local registry and the explicit pane must
# still agree with that registry binding.
seed_sentinel nudge-xteam-2a localguy
"$TAP" nudge --pane localpane:0.0 >"$WORK/x2a.out" 2>&1 || {
  echo "nudge-xteam: (2a) pane-only local nudge failed" >&2
  cat "$WORK/x2a.out" >&2
  exit 1
}
grep -q 're-submitted' "$WORK/x2a.out" || {
  echo "nudge-xteam: (2a) pane-only bare recipient should re-submit via the local registry" >&2
  cat "$WORK/x2a.out" >&2
  exit 1
}
[ ! -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (2a) pane-only local sentinel did not clear" >&2; exit 1; }
echo "nudge-xteam: (2a) pane-only bare recipient retains local-team resolution: ok"

# ── 2b. explicit --pane confirms (never overrides) the sentinel binding ────────────
seed_sentinel nudge-xteam-2b RemoteTeam/hermes
"$TAP" nudge RemoteTeam/hermes --pane hermes:0.0 >"$WORK/x2b.out" 2>&1 || { echo "nudge-xteam: (2b) --pane override failed" >&2; cat "$WORK/x2b.out" >&2; exit 1; }
grep -q 're-submitted' "$WORK/x2b.out" || { echo "nudge-xteam: (2b) --pane override should re-submit" >&2; cat "$WORK/x2b.out" >&2; exit 1; }
echo "nudge-xteam: (2b) explicit --pane agrees with sentinel-bound identity: ok"

# ── 2c. explicit --pane cannot redirect a bare recipient to a same-named seat ────
seed_sentinel nudge-xteam-2c hermes
set +e
wrong_pane="$("$TAP" nudge RemoteTeam/hermes --pane localpane:0.0 2>&1)"; rc_wrong_pane=$?
set -e
[ "$rc_wrong_pane" -eq 1 ] || { echo "nudge-xteam: (2c) wrong explicit pane should refuse with exit 1" >&2; echo "$wrong_pane" >&2; exit 1; }
[[ "$wrong_pane" == *"candidate pane 'localpane:0.0' is not the sentinel recipient's bound pane 'hermes:0.0'"* ]] || {
  echo "nudge-xteam: (2c) wrong explicit pane should fail the registry binding" >&2
  echo "$wrong_pane" >&2
  exit 1
}
[ -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (2c) wrong explicit pane must not submit" >&2; exit 1; }
echo "nudge-xteam: (2c) explicit pane disagreement remains fail-closed for a bare recipient: ok"

# ── 3. unknown TEAM → clean enrollment guidance, not an ineffective --pane retry ──
set +e
unknown_team="$("$TAP" nudge NoSuchTeam/hermes 2>&1)"; rc_ut=$?
set -e
[ "$rc_ut" -eq 1 ] || { echo "nudge-xteam: (3) unknown team should exit 1, got $rc_ut" >&2; echo "$unknown_team" >&2; exit 1; }
[[ "$unknown_team" == *"unknown team 'NoSuchTeam'"* ]] || { echo "nudge-xteam: (3) should name the unknown team" >&2; echo "$unknown_team" >&2; exit 1; }
[[ "$unknown_team" == *'enroll team'* && "$unknown_team" != *'--pane'* ]] || { echo "nudge-xteam: (3) should name team enrollment, not an ineffective --pane retry" >&2; echo "$unknown_team" >&2; exit 1; }
echo "nudge-xteam: (3) unknown team is a clean error naming enrollment recovery: ok"

# ── 4. unknown HANDLE in a known team → clean error, not a crash ──────────────────
set +e
unknown_handle="$("$TAP" nudge RemoteTeam/ghost 2>&1)"; rc_uh=$?
set -e
[ "$rc_uh" -eq 1 ] || { echo "nudge-xteam: (4) unknown handle should exit 1, got $rc_uh" >&2; echo "$unknown_handle" >&2; exit 1; }
# The message keeps the team qualification the caller typed (RemoteTeam/ghost).
[[ "$unknown_handle" == *"no registered pane for 'RemoteTeam/ghost'"* ]] || { echo "nudge-xteam: (4) unknown handle error should keep team qualification in the handle name" >&2; echo "$unknown_handle" >&2; exit 1; }
echo "nudge-xteam: (4) unknown handle in a known team is a clean, team-qualified error: ok"

# ── 5. malformed team-qualified address → clean error ─────────────────────────────
set +e
malformed="$("$TAP" nudge RemoteTeam/hermes/extra 2>&1)"; rc_mf=$?
set -e
[ "$rc_mf" -eq 1 ] || { echo "nudge-xteam: (5) malformed address should exit 1, got $rc_mf" >&2; echo "$malformed" >&2; exit 1; }
[[ "$malformed" == *"one slash"* ]] || { echo "nudge-xteam: (5) malformed address should explain <team>/<handle> shape" >&2; echo "$malformed" >&2; exit 1; }
echo "nudge-xteam: (5) malformed <team>/<handle> address is a clean error: ok"

# ── 6. same-team QUALIFIED address routes through the LOCAL branch ────────────────
# LocalTeam/localguy names our OWN team — the shared resolver returns scope=local, so
# it's an ordinary local registry lookup, not a cross-team resolution.
seed_sentinel nudge-xteam-6 LocalTeam/localguy
"$TAP" nudge LocalTeam/localguy >"$WORK/x6.out" 2>&1 || { echo "nudge-xteam: (6) same-team qualified nudge failed" >&2; cat "$WORK/x6.out" >&2; exit 1; }
grep -q 're-submitted' "$WORK/x6.out" || { echo "nudge-xteam: (6) same-team qualified should resolve locally and re-submit" >&2; cat "$WORK/x6.out" >&2; exit 1; }
echo "nudge-xteam: (6) same-team qualified <LocalTeam/handle> resolves via the local branch: ok"

# ── 7. a foreign POLL seat is a structured poll_mode_member refusal ───────────────
# pollbot in RemoteTeam has no pane to nudge (delivery:poll) — nudge must refuse with
# error_class=poll_mode_member (same as a local poll seat), team qualification kept.
seed_sentinel nudge-xteam-7 RemoteTeam/pollbot
set +e
TAP_JSON=1 "$TAP" nudge RemoteTeam/pollbot >"$WORK/x7.out" 2>"$WORK/x7.err"; rc_poll=$?
set -e
[ "$rc_poll" -eq 1 ] || { echo "nudge-xteam: (7) foreign poll nudge should exit 1, got $rc_poll" >&2; cat "$WORK/x7.out" "$WORK/x7.err" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="poll_mode_member", d' "$WORK/x7.out" \
  || { echo "nudge-xteam: (7) foreign poll seat should refuse with poll_mode_member" >&2; cat "$WORK/x7.out" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "RemoteTeam/pollbot" in d["detail"], d' "$WORK/x7.out" \
  || { echo "nudge-xteam: (7) poll refusal should keep the team qualification" >&2; cat "$WORK/x7.out" >&2; exit 1; }
echo "nudge-xteam: (7) a foreign poll seat is a structured poll_mode_member refusal: ok"

# ── 8. a foreign SUSPENDED seat is a structured refusal, not a bare-Enter attempt ─
# tap-zvx foreign-status parity with tap send: a suspended remote seat is not a
# delivery target, so nudge refuses (exit 1) instead of probing/pressing Enter. The
# refusal keeps the team qualification the caller typed. (Local-nudge status behavior
# is deliberately unchanged — a separate question, out of scope here.)
seed_sentinel nudge-xteam-8 RemoteTeam/sleepy
set +e
susp_out="$("$TAP" nudge RemoteTeam/sleepy 2>&1)"; rc_susp=$?
set -e
[ "$rc_susp" -eq 1 ] || { echo "nudge-xteam: (8) foreign suspended nudge should exit 1, got $rc_susp" >&2; echo "$susp_out" >&2; exit 1; }
[[ "$susp_out" == *'is suspended'* ]] || { echo "nudge-xteam: (8) foreign suspended seat should be a structured 'is suspended' refusal" >&2; echo "$susp_out" >&2; exit 1; }
[[ "$susp_out" == *"RemoteTeam/sleepy"* ]] || { echo "nudge-xteam: (8) suspended refusal should keep the team qualification" >&2; echo "$susp_out" >&2; exit 1; }
# And it must NOT have pressed Enter — the seeded sentinel is still sitting in the box.
[ -f "$FAKE_TMUX_STATE/input" ] || { echo "nudge-xteam: (8) suspended refusal must not submit/clear the pane" >&2; exit 1; }
echo "nudge-xteam: (8) a foreign suspended seat is a structured, qualified refusal (no bare Enter): ok"

echo "nudge-cross-team: ok"
