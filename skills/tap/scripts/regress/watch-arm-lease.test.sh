#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-arm-lease.test.sh — U4: `tap watch on|off|status` arm record = lease.
# Covers AE7 (reset reaps the lease), AE8 (legacy bus refused), reserved-token refusal,
# the consent print, and idempotent single-loop spawn under a mock tmux.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
# Redirect the machine index home: tap-watch.sh now invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"

# --- mock tmux: models sessions + a per-session window set in a state file ------
WINDOWS="$WORK/windows"; : > "$WINDOWS"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *ppid*|*tty=*)
    printf '1 faketty\n'
    exit 0
    ;;
esac
exec /bin/ps "$@"
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
WINDOWS="${FAKE_WINDOWS:?}"
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    # tap-calo: `watch off` takes its actor from the calling pane (never --by), so the fake must
    # answer the calling-pane observation: one atomic record — the lead's pane, tty and generation.
    # Ordered longest-first: the shorter globs also match the four-field format.
    case "$fmt" in
      *pane_id*pane_tty*session_name*) printf '%%101\t/dev/faketty\tteamsess\t%s\n' "${FAKE_EPOCH_RAW:-900:100}"; exit 0 ;;
      *pane_id*pane_tty*) printf '%%101\t/dev/faketty\n'; exit 0 ;;
      *pane_id*session_name*) printf '%%101\tteamsess\t%s\n' "${FAKE_EPOCH_RAW:-900:100}"; exit 0 ;;
    esac
    # No -t ⇒ caller pane (reset-stop self-last observability).
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
        *window_index*) echo "teamsess:0.0" ;;
        *session_name*) echo "teamsess" ;;
        *pane_id*) echo "%101" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
      *session_name*) echo "teamsess" ;;
      *pane_id*) echo "%101" ;;
      *) echo "" ;;
    esac ;;
  has-session|kill-session) exit 0 ;;
  list-panes)
    # Ancestry fallback / pane census.
    printf '%%101\t/dev/faketty\n'
    exit 0 ;;
  list-windows)
    # honor -F minimally: window_name, optionally with pane_pid (all spawned windows -> 99999)
    fmt=""; while [ "$#" -gt 0 ]; do case "$1" in -F) fmt="${2:-}"; shift 2 ;; *) shift ;; esac; done
    while IFS= read -r _w; do
      [ -n "$_w" ] || continue
      case "$fmt" in *pane_pid*) printf '%s %s\n' "$_w" "${FAKE_WATCH_WIN_PID:-99999}" ;; *) printf '%s\n' "$_w" ;; esac
    done < "$WINDOWS" 2>/dev/null || true ;;
  new-window)
    # record a "watch" window; print a fake pane pid
    echo watch >> "$WINDOWS"; echo "99999" ;;
  kill-window)
    grep -vx watch "$WINDOWS" > "$WINDOWS.tmp" 2>/dev/null || true; mv "$WINDOWS.tmp" "$WINDOWS" 2>/dev/null || true ;;
  *) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export FAKE_WINDOWS="$WINDOWS" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_EPOCH_RAW="900:100"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
# Numeric %N pane id — non-grammar %teamsess:0.0 aborts reset.
# Stay pane-backed for sidecar spawn/self-heal cases; reset case flips to poll.
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "tap", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "teamsess:0.0", "pane_id": "%101", "session": "teamsess", "harness": "claude", "status": "active", "delivery": "pane", "server_epoch": "srv:900:100", "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"tap":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

# tap_watch_set/tap_watch_disarm (Bash) are gone (the watch
# sidecar/tick moved to Bun); drive the lease fixture directly through its native owner
# (watch-lease.ts), same module the Bash functions used to shell out to.
watch_lease_set()    { TAP_HOME="$BUS" bash -c '. "$1"; shift; tap_bun_call watch set watch-lease.ts "$TAP_HOME/watch/arm.json" set "$@"' sh "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$@"; }
watch_lease_disarm() { TAP_HOME="$BUS" bash -c '. "$1"; tap_bun_call watch disarm watch-lease.ts "$TAP_HOME/watch/arm.json" disarm' sh "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"; }

# (1) arm writes the full lease record.
arm_out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "suite green; proof: run smokes; bound 2h" --evaluator none 2>&1)"
[[ "$arm_out" == *"tap watch: armed by 'lead'; checks after 1500s; probes after 1500s; evaluator none; terminal 'lead'"* ]] \
  || { echo "watch-arm: (1) arm receipt is not event prose: $arm_out" >&2; exit 1; }
arm="$BUS/watch/arm.json"
[ -f "$arm" ] || { echo "watch-arm: (1) no arm record written" >&2; exit 1; }
for k in armed_by armed_at done_when threshold_seconds probe_timeout_seconds evaluator terminal_seat current_rung; do
  grep -q "\"$k\"" "$arm" || { echo "watch-arm: (1) arm record missing field '$k'" >&2; cat "$arm" >&2; exit 1; }
done
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["armed_by"]=="lead" and r["threshold_seconds"]==1500 and r["terminal_seat"]=="lead", r' "$arm" \
  || { echo "watch-arm: (1) arm record field values wrong" >&2; exit 1; }
# spawn happened: exactly one watch window recorded
[ "$(grep -cx watch "$WINDOWS")" = "1" ] || { echo "watch-arm: (1) expected exactly one sidecar window" >&2; exit 1; }
echo "watch-arm: (1) arm record + single sidecar spawn: ok"

# (2) idempotent re-arm (T0): a second `on` with the SAME done_when is a no-op — it does
# not spawn a second loop AND does not reset the live episode's ladder/floor. Advance the
# ladder first, then re-`on` and confirm the cursor survived.
watch_lease_set current_rung 3 episode_started_at 111 >/dev/null 2>&1
reout="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "suite green; proof: run smokes; bound 2h" --evaluator none 2>&1)"
grep -q "tap watch: already armed; keeping current episode since" <<<"$reout" || { echo "watch-arm: (2) same-goal re-arm did not report concise no-op prose: $reout" >&2; exit 1; }
[[ "$reout" != *"(idempotent)"* ]] || { echo "watch-arm: (2) same-goal re-arm leaked the old idempotent tag: $reout" >&2; exit 1; }
[ "$(grep -cx watch "$WINDOWS")" = "1" ] || { echo "watch-arm: (2) second on spawned a second loop" >&2; exit 1; }
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["current_rung"]==3 and r["episode_started_at"]==111, r' "$arm" \
  || { echo "watch-arm: (2) same-goal re-arm reset the live episode (should be a no-op)" >&2; exit 1; }
echo "watch-arm: (2) same-goal re-arm -> one loop, episode preserved (idempotent): ok"

# (2b) re-arm with a DIFFERENT done_when REFUSES, naming off / --rearm. --rearm forces a
# full reset. Neither resets the episode silently.
diff_err="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "different goal now" --evaluator none 2>&1 1>/dev/null)" && {
  echo "watch-arm: (2b) re-arm with a different done_when should refuse" >&2; exit 1; }
[[ "$diff_err" == *"--rearm"* ]] || { echo "watch-arm: (2b) refusal does not name --rearm escape hatch: $diff_err" >&2; exit 1; }
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["current_rung"]==3 and r["done_when"]=="suite green; proof: run smokes; bound 2h", r' "$arm" \
  || { echo "watch-arm: (2b) refused re-arm still mutated the lease" >&2; exit 1; }
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "different goal now" --evaluator none --rearm >/dev/null 2>&1
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["current_rung"]==0 and r["episode_started_at"]==0 and r["done_when"]=="different goal now", r' "$arm" \
  || { echo "watch-arm: (2b) --rearm did not reset the episode to the new goal" >&2; exit 1; }
echo "watch-arm: (2b) different-goal re-arm refuses; --rearm resets to the new goal: ok"

# Restore the original goal so later steps (status/reset/consent) read as before.
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "suite green; proof: run smokes; bound 2h" --evaluator none --rearm >/dev/null 2>&1

# (3) status prints the armed record. (Capture first — piping a multi-line producer
# into `grep -q` under pipefail would SIGPIPE the producer and fail spuriously.)
# The fixture spawns no real watcher (the tmux stub answers the fake pid 99999, which the lease
# records as watcher_pid), so `status` reports the dispatcher dead and exits 2 (attention, CLI-EXIT-2):
# capture that exit rather than let `set -e` kill the run, and assert it.
st_rc=0
st="$(TAP_HOME="$BUS" bash "$TAPSH" watch status 2>&1)" || st_rc=$?
[[ "$st" == *"armed by: lead"* ]] || { echo "watch-arm: (3) status did not report armed: $st" >&2; exit 1; }
[[ "$st" == *"dispatcher: dead (pid 99999 is not running the watcher)"* ]] || { echo "watch-arm: (3) status did not report the missing dispatcher: $st" >&2; exit 1; }
[ "$st_rc" = "2" ] || { echo "watch-arm: (3) a dead dispatcher should exit 2, got $st_rc: $st" >&2; exit 1; }
echo "watch-arm: (3) status reports the arm record and exits 2 for the dead dispatcher: ok"

# (4) AE7: tap team reset archives watch/ -> lease gone.
# tap-9tqt: --keep-registry removed (use team down to retain roster). Reset archives
# the registry — restore it so later steps can still resolve the team session
# (main's old --keep-registry reason; delivery-polite exemplar in-repo).
# Poll for the stop plan so unverified pane seats do not hard-gate reset; keep_self
# default means unobservable fake-TMUX caller is no longer a reset refusal (opus 070009).
python3 -B - "$BUS/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
for ent in (reg.get("seats") or {}).values():
    if isinstance(ent, dict):
        ent["delivery"] = "poll"
json.dump(reg, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
set +e
reset_out="$(TAP_HOME="$BUS" bash "$TAPSH" team reset --yes 2>&1)"
reset_rc=$?
set -e
[ "$reset_rc" = 0 ] || { echo "watch-arm: (4/AE7) team reset failed rc=$reset_rc" >&2; echo "$reset_out" >&2; exit 1; }
[ ! -f "$arm" ] || { echo "watch-arm: (4/AE7) reset did not reap the lease" >&2; exit 1; }
ls "$BUS"/archive/team-reset/*/bus/watch/arm.json >/dev/null 2>&1 \
  || ls "$BUS"/archive/*/watch/arm.json >/dev/null 2>&1 \
  || { echo "watch-arm: (4/AE7) watch state not archived by reset" >&2; exit 1; }
: > "$WINDOWS"   # model the real world: lease gone -> the loop exits on its next tick -> its window closes
# Restore registry so later steps can resolve the team session (not just re-arm).
mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "tap", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "teamsess:0.0", "pane_id": "%101", "session": "teamsess", "harness": "claude", "status": "active", "delivery": "pane", "server_epoch": "srv:900:100", "registered_from_worktree": "$WORK/repo" } } }
JSON
echo "watch-arm: (4/AE7) reset archives watch/ and reaps the lease: ok"

# (5) consent line prints + is recorded on a non-'none' evaluator.
out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "x" --evaluator codex 2>&1)"
grep -qi "consent" <<<"$out" || { echo "watch-arm: (5) no consent line for non-none evaluator" >&2; exit 1; }
python3 -c 'import json,sys; assert str(json.load(open(sys.argv[1]))["consent_transcript_egress"]) in ("1","True"), "consent not recorded"' "$arm" \
  || { echo "watch-arm: (5) consent not recorded in arm record" >&2; exit 1; }
echo "watch-arm: (5) consent printed + recorded on non-none evaluator: ok"

# (6) off deletes the lease (idempotent) and reaps the window.
TAP_HOME="$BUS" bash "$TAPSH" watch off --by lead >/dev/null 2>&1
[ ! -f "$arm" ] || { echo "watch-arm: (6) off did not delete the lease" >&2; exit 1; }
[ "$(grep -cx watch "$WINDOWS")" = "0" ] || { echo "watch-arm: (6) off did not reap the window" >&2; exit 1; }
off_again_out="$(TAP_HOME="$BUS" bash "$TAPSH" watch off --by lead 2>&1)"
[[ "$off_again_out" == *"already disarmed"* ]] || { echo "watch-arm: (6) double off not a clean no-op" >&2; exit 1; }
echo "watch-arm: (6) off reaps lease + window, idempotent: ok"

# (7) reserved watcher token refused as a seat handle (R6).
if TAP_HOME="$BUS" bash "$TAPSH" register watcher --pane teamsess:0.0 >/dev/null 2>/dev/null; then
  echo "watch-arm: (7) register accepted the reserved watcher token" >&2; exit 1
fi
echo "watch-arm: (7) tap register refuses the reserved watcher token: ok"

# (8) AE8: legacy tmp/tap bus refuses `watch on`, naming tap init.
LEG="$WORK/legacyrepo"; mkdir -p "$LEG/tmp/tap/payloads" "$LEG/tmp/tap/receipts"
echo '{"schema": "0.20", "team":{"name":"leg"},"seats":{}}' > "$LEG/tmp/tap/registry.json"
err="$( cd "$LEG" && env -u TAP_HOME bash "$TAPSH" watch on --by lead -m x --no-spawn 2>&1 1>/dev/null )" && {
  echo "watch-arm: (8/AE8) legacy bus should refuse watch on" >&2; exit 1; }
[[ "$err" == *"tap init"* ]] || { echo "watch-arm: (8/AE8) legacy refusal does not name tap init: $err" >&2; exit 1; }
echo "watch-arm: (8/AE8) legacy bus refused, names tap init: ok"

# (9) DN1: disarm is lock-synchronized and cannot be resurrected by a later lease update.
# It keeps the stable lock file (a shared inode) and a post-disarm lease update (the
# in-flight-tick shape, ALLOW_CREATE unset) must NOT recreate the arm record.
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "x" --evaluator none --no-spawn >/dev/null 2>&1
watch_lease_disarm
[ ! -f "$arm" ] || { echo "watch-arm: (9/DN1) disarm did not delete the arm record" >&2; exit 1; }
[ -f "$arm.lock" ] || { echo "watch-arm: (9/DN1) disarm deleted the stable lock file (breaks future lockers)" >&2; exit 1; }
watch_lease_set current_rung 7 2>/dev/null || true
[ ! -f "$arm" ] || { echo "watch-arm: (9/DN1) a post-disarm lease update resurrected the arm record" >&2; exit 1; }
echo "watch-arm: (9/DN1) disarm is locked, keeps the lock file, resists resurrection: ok"

# (10) DN1 race: many concurrent lease updates interleaved with a disarm still end with
# the lease REAPED (the locked delete wins; no update recreates it after off).
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "x" --evaluator none --no-spawn >/dev/null 2>&1
for i in $(seq 1 20); do
  watch_lease_set current_rung "$i" 2>/dev/null &
done
watch_lease_disarm &
wait
# A straggler update that STARTED before disarm may or may not have written; run one more
# update after the dust settles — with the lease gone it must not recreate it.
watch_lease_set current_rung 99 2>/dev/null || true
[ ! -f "$arm" ] || { echo "watch-arm: (10/DN1) concurrent updates resurrected the lease past disarm" >&2; exit 1; }
echo "watch-arm: (10/DN1) disarm wins the race — lease stays reaped: ok"

# (11) self-heal NEVER kills a 'watch' window it cannot confirm is this bus's sidecar (a user
# window or another team's sidecar can share the name). Simulate a 'watch' window whose pane
# pid does not match our recorded watcher_pid; a re-'on' must leave it untouched and not spawn.
: > "$WINDOWS"; echo watch >> "$WINDOWS"                      # a foreign 'watch' window exists
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "guard" --evaluator none --no-spawn >/dev/null 2>&1
watch_lease_set watcher_pid 55555 >/dev/null 2>&1   # ours != the window (99999)
before="$(grep -cx watch "$WINDOWS")"
if msg="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "guard" --evaluator none 2>&1)"; then
  echo "watch-arm: (11) foreign window refusal returned success" >&2; exit 1
fi
grep -qi "belongs to another process" <<<"$msg" || { echo "watch-arm: (11) self-heal did not refuse a foreign 'watch' window: $msg" >&2; exit 1; }
[ "$(grep -cx watch "$WINDOWS")" = "$before" ] || { echo "watch-arm: (11) self-heal killed/spawned against a foreign 'watch' window" >&2; exit 1; }
echo "watch-arm: (11) self-heal never touches an unconfirmed 'watch' window: ok"

# (12) `tap watch off` also never reaps a 'watch' window it cannot confirm is ours — the
# disarm-path kill is ownership-gated exactly like the spawn path.
: > "$WINDOWS"; echo watch >> "$WINDOWS"                      # a foreign 'watch' window
TAP_HOME="$BUS" bash "$TAPSH" watch on --rearm --by lead -m "g2" --evaluator none --no-spawn >/dev/null 2>&1
watch_lease_set watcher_pid 55555 >/dev/null 2>&1   # ours (55555) != window (99999)
TAP_HOME="$BUS" bash "$TAPSH" watch off --by lead >/dev/null 2>&1
[ "$(grep -cx watch "$WINDOWS")" = "1" ] || { echo "watch-arm: (12) off reaped a foreign 'watch' window" >&2; exit 1; }
echo "watch-arm: (12) off never reaps an unconfirmed 'watch' window: ok"

echo "watch-arm-lease: ok"
