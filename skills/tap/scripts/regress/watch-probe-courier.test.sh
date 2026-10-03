#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-probe-courier.test.sh — U5: a wedge-suspect tick sends a conformant kind=probe
# to the current rung through the standard courier. Asserts probe payload conformance:
# kind=probe, reply=settle-only, from=the reserved watcher identity, and the canonical
# mechanical body (ARMER substituted, settlement-first, no status/disarm loop).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock tmux is synchronous — courier settle sleeps prove nothing here (CONTRACT §submit-verify).
export TAP_TUI_SETTLE_SCALE=0.1
export TAP_SPOOL_DISABLE_DELIVERER=1
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

# --- courier mock: a live pane whose submit-verify passes ----------------------
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  # CONTRACT §Session-name authority: both watcher fixtures share an exact
  # session but retain distinct designated numeric pane identities.
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    command=codex; [ -f "$state/unsafe" ] && command=zsh
    printf 'sess\tsess:0.0\t%%101\tcodex\t4242\t4242:100\t0\n'
    printf 'sess\tsess:0.1\t%%102\t%s\t4243\t4242:100\t0\n' "$command" ;;
  display-message)
    fmt="${@: -1}"
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        t=""; p=""; for a in "$@"; do [ "$p" = -t ] && t="${a#=}"; p="$a"; done
        case "$t" in
          sess:0.0|%101) printf '%%101\tsess\t4242\tcodex\t0\n' ;;
          sess:0.1|%102) cmd=codex; [ -f "$state/unsafe" ] && cmd=zsh; printf '%%102\tsess\t4243\t%s\t0\n' "$cmd" ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*) case " $* " in *'sess:0.0'*|*'%101'*) echo %101 ;; *) echo %102 ;; esac ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) [ -f "$state/unsafe" ] && echo "zsh" || echo "codex" ;;
      *window_activity*) echo "100" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/busy" ] && { compgen -G "$TAP_HOME/watch/.probe.*.md" >/dev/null || compgen -G "$TAP_HOME/spool/*.md" >/dev/null || [ -f "$state/redelivery-busy" ]; }; then printf 'model is still working\n'
    elif [ -f "$state/input" ]; then printf '%s %s\n' "❯" "$(cat "$state/input")"
    else printf '%s \n' "❯"; fi ;;
  send-keys)
    [ "${1:-}" = "-t" ] && shift 2
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; exit 0 ;;
      C-u|Enter) rm -f "$state/input"; exit 0 ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf ' 4242 1 codex codex --dangerously-bypass-approvals\n'
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/watch-send" <<'SEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${FAKE_WATCH_SEND_JSON:?}"
exit "${FAKE_WATCH_SEND_RC:?}"
SEND
chmod +x "$FAKE_BIN/watch-send"
export PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$WORK/fake-tmux" TMUX="/fake/socket"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead": { "pane": "sess:0.0", "pane_id": "%101", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "helper": { "pane": "sess:0.1", "pane_id": "%102", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

# Arm by lead but probe helper; the body must route exceptional status to the ARMER,
# not the probed rung or terminal override.
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1500 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
A="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
# The armer normally must be a valid handle at arm time. This fixture models a
# pre-existing record whose display name contains literal sed metacharacters;
# probe rendering must preserve it verbatim instead of parsing it as a sed
# replacement expression.
# A codex evaluator can carry an arbitrary not-done reason into the next probe.
# Keep an ampersand here to exercise Bash 5.2+'s patsub_replacement behavior.
python3 -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r["armed_by"]="lead|&owner"; r["not_done_reason"]="API & DB"; json.dump(r,open(p,"w"))' "$BUS/watch/arm.json"

# Wedge-suspect tick -> probe sent to lead through the courier.
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1

probe="$(ls "$BUS"/payloads/watcher-*.md 2>/dev/null | head -1)"
[ -n "$probe" ] || { echo "watch-probe-courier: no probe payload minted by the watcher" >&2; ls "$BUS/payloads" >&2; exit 1; }

grep -q '^kind: probe$'         "$probe" || { echo "watch-probe-courier: probe payload kind != probe" >&2; sed -n '1,8p' "$probe" >&2; exit 1; }
grep -q '^reply: settle-only$'  "$probe" || { echo "watch-probe-courier: probe payload reply != settle-only" >&2; sed -n '1,8p' "$probe" >&2; exit 1; }
grep -q '^from: watcher$'       "$probe" || { echo "watch-probe-courier: probe from != reserved watcher identity" >&2; sed -n '1,8p' "$probe" >&2; exit 1; }
grep -q '^to: helper$'          "$probe" || { echo "watch-probe-courier: probe not addressed to the rung (helper)" >&2; sed -n '1,8p' "$probe" >&2; exit 1; }
grep -qiF 'do NOT `tap reply`'  "$probe" || { echo "watch-probe-courier: probe body missing the do-not-reply instruction" >&2; exit 1; }
grep -qF 'tap read <id-from-the-sentinel>' "$probe" || { echo "watch-probe-courier: probe body missing settlement command" >&2; exit 1; }
grep -qF 'ONLY if you are blocked' "$probe" || { echo "watch-probe-courier: probe body missing conditional blocker/done routing" >&2; exit 1; }
grep -qF 'tap send lead'        "$probe" || { echo "watch-probe-courier: probe body did not route exceptions to the armer" >&2; exit 1; }
grep -qF 'tap send lead|&owner --wake' "$probe" || { echo "watch-probe-courier: probe body did not preserve literal armer characters with --wake" >&2; exit 1; }
grep -qF '{{ARMER}}'            "$probe" && { echo "watch-probe-courier: probe body left an unsubstituted {{ARMER}}" >&2; exit 1; }
grep -qF '> Carrying forward: API & DB' "$probe" || { echo "watch-probe-courier: probe body did not preserve literal nudge characters" >&2; exit 1; }
grep -qF '{{NUDGE}}'            "$probe" && { echo "watch-probe-courier: probe body left an unsubstituted {{NUDGE}}" >&2; exit 1; }
grep -qF 'send ONE status line' "$probe" && { echo "watch-probe-courier: probe still orders unconditional status" >&2; exit 1; }
grep -qF 'tap watch off'        "$probe" && { echo "watch-probe-courier: probe still invites non-armer disarm" >&2; exit 1; }
# tap-hhg regression pins: the probe must tell a mid-work seat to RESUME, and must
# NOT read as a stop order (the bug that harvested executors mid-lane).
grep -qiF 'RESUME whatever work order' "$probe" || { echo "watch-probe-courier: probe body missing the resume-your-work instruction (tap-hhg)" >&2; exit 1; }
grep -qiF 'then stop'           "$probe" && { echo "watch-probe-courier: probe body still reads as a stop order (tap-hhg regression)" >&2; exit 1; }
echo "watch-probe-courier: probe conformance (kind=probe, settle-only, watcher sender, mechanical body): ok"

# last_probe_at recorded (a delivered probe seeds probe_timeout, not the tick interval).
lpa="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("last_probe_at"))')"
[ "$lpa" = "$((A + 2000))" ] || { echo "watch-probe-courier: last_probe_at not recorded on delivery (got $lpa)" >&2; exit 1; }
echo "watch-probe-courier: delivered probe seeds last_probe_at: ok"

# A watcher probe that parks on visible human input uses the configured probe
# timeout, not the ordinary standard-send 60-second pending-input grace.
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
printf '%s' 'human draft' > "$FAKE_TMUX_STATE/input"
printf '%s\n' 'deadline probe' > "$WORK/pending-probe.md"
pending_out="$(TAP_SELF=watcher TAP_SEND_GRACE_SECONDS=17 bash "$TAPSH" send helper "$WORK/pending-probe.md" \
  --from watcher --kind probe --fyi --json)"
pending_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$pending_out")"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["reason"]=="pending-input" and d["deadline_epoch"]-d["first_spooled_epoch"]==17, d' \
  "$BUS/spool/$pending_id.meta.json" \
  || { echo "watch-probe-courier: pending-input probe ignored configured probe_timeout" >&2; cat "$BUS/spool/$pending_id.meta.json" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/input"
echo "watch-probe-courier: pending-input probe inherits configured delivery deadline: ok"

# A queued probe is accepted exactly once. Its response clock remains stopped
# until the courier moves that exact id from spool to the canonical bus.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/*.md "$BUS"/spool/*.meta.json 2>/dev/null || true
touch "$FAKE_TMUX_STATE/busy"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1500 --probe-timeout 10 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
Q="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((Q + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
queued_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
[ -n "$queued_id" ] && [ -f "$BUS/spool/$queued_id.md" ] \
  || { echo "watch-probe-courier: queued probe id/spool entry missing" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("deadline_epoch")-d["first_spooled_epoch"]==10, d' \
  "$BUS/spool/$queued_id.meta.json" \
  || { echo "watch-probe-courier: queued watcher probe deadline is not tied to probe_timeout" >&2; cat "$BUS/spool/$queued_id.meta.json" >&2; exit 1; }
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["first_spooled_epoch"]=int(sys.argv[2]); d["deadline_epoch"]=int(sys.argv[2])+10; json.dump(d,open(p,"w"))' \
  "$BUS/spool/$queued_id.meta.json" "$((Q + 2000))"
[ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["last_probe_at"])')" = 0 ] \
  || { echo "watch-probe-courier: queued probe started response clock before spool exit" >&2; exit 1; }
TAP_WATCH_NOW="$((Q + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(find "$BUS/spool" -maxdepth 1 -name 'watcher-*.md' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "watch-probe-courier: queued probe was minted more than once" >&2; exit 1; }
[ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["last_probe_at"])')" = 0 ] \
  || { echo "watch-probe-courier: parked probe response clock advanced" >&2; exit 1; }

# Real non-supervision activity wins over a parked probe. The queued marker must
# not short-circuit the ordinary activity reset and leave a stale wedge episode.
cat > "$BUS/payloads/activity-reset.md" <<EOF
---
id: activity-reset
from: lead
to: helper
kind: discuss
reply: settle-only
path: $BUS/payloads/activity-reset.md
---
real work resumed
EOF
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' \
  "$BUS/payloads/activity-reset.md" "$((Q + 2002))"
TAP_WATCH_NOW="$((Q + 2002))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("episode_started_at")==0 and d.get("queued_probe_id")==sys.argv[2], d' \
  "$BUS/watch/arm.json" "$queued_id" \
  || { echo "watch-probe-courier: activity reset lost exact queued ownership" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
TAP_WATCH_NOW="$((Q + 2003))" bash "$TAPSH" watch pause --by lead -m "maintenance" --for 1m >/dev/null 2>&1
TAP_WATCH_NOW="$((Q + 2004))" bash "$TAPSH" watch resume --by lead >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("queued_probe_id")==sys.argv[2], d' \
  "$BUS/watch/arm.json" "$queued_id" \
  || { echo "watch-probe-courier: pause/resume lost exact queued ownership" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
[ "$(find "$BUS/spool" -maxdepth 1 -name 'watcher-*.md' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "watch-probe-courier: reset/pause minted a second live probe" >&2; find "$BUS/spool" -maxdepth 1 -type f >&2; exit 1; }

# An acknowledged notification from this episode must not consume the queued
# probe's per-entry deadline alert.
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["episode_started_at"]=int(sys.argv[2]); d["notified_at"]=int(sys.argv[2]); json.dump(d,open(p,"w"))' \
  "$BUS/watch/arm.json" "$((Q + 2004))"
python3 -c 'import json,sys; json.dump({"type":"NOTIFY","at":int(sys.argv[2]),"reason":"earlier episode alert","acked":"0"},open(sys.argv[1],"w"))' \
  "$BUS/watch/notify.json" "$((Q + 2004))"
bash "$TAPSH" watch ack --by lead >/dev/null 2>&1
python3 -c 'import json,sys; assert str(json.load(open(sys.argv[1]))["acked"])=="1"' "$BUS/watch/notify.json"

# A permanently busy queued probe has one bounded deadline and one sticky human
# notification. Repeated ticks must not mint another probe or rewrite the alert.
touch "$FAKE_TMUX_STATE/redelivery-busy"
# The drain's effective deadline is the pane-shared protection record
# (draft grace / WAIT snooze), which counts the real wall clock, so the synthetic
# TAP_WATCH_NOW can never expire it. Age that clock too; the acknowledged-alert
# assertion below stays as it was. Refusable: the park must have minted a record
# naming the queued probe, and the shared aging helper fails when it ages none.
grep -qF "\"id\":\"$queued_id\"" "${TAP_INDEX_HOME:?}"/input-protection/*.json 2>/dev/null \
  || { echo "watch-probe-courier: queued probe parked without a pane-shared protection record naming it" >&2; exit 1; }
bash -c '. "$1"; tap_protection_age_all "$2"' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$(( $(date +%s) * 1000 - 1000 ))" \
  || { echo "watch-probe-courier: queued probe protection record could not be aged" >&2; exit 1; }
TAP_WATCH_NOW="$((Q + 4005))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -f "$BUS/watch/notify.json" ] \
  || { echo "watch-probe-courier: expired queued probe did not notify the human" >&2; exit 1; }
notify_at="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["at"])' "$BUS/watch/notify.json")"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert str(d["acked"])=="0" and str(d["at"])==sys.argv[2] and "watch probe" in d["reason"], d' \
  "$BUS/watch/notify.json" "$((Q + 4005))" \
  || { echo "watch-probe-courier: prior acknowledged episode alert suppressed queued-probe deadline" >&2; cat "$BUS/watch/notify.json" >&2; exit 1; }
TAP_WATCH_NOW="$((Q + 4006))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; assert str(json.load(open(sys.argv[1]))["at"])==sys.argv[2]' \
  "$BUS/watch/notify.json" "$notify_at" \
  || { echo "watch-probe-courier: expired queued probe rewrote its sticky notification" >&2; exit 1; }
[ "$(find "$BUS/spool" -maxdepth 1 -name 'watcher-*.md' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "watch-probe-courier: expected one expired probe still in spool" >&2; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("escalated_at"), d' \
  "$BUS/spool/$queued_id.meta.json" \
  || { echo "watch-probe-courier: expired queued probe did not record one-shot escalation" >&2; exit 1; }
# After escalation grace, the reserved sender still owns this exact queued id.
# Count across canonical and spool so retiring and replacing it cannot pass.
for offset in 8000 8001; do
  TAP_WATCH_NOW="$((Q + offset))" bash "$TAPSH" watch tick >/dev/null 2>&1
  python3 - "$BUS" "$queued_id" <<'PYPROBE'
import json, pathlib, sys
bus, expected = pathlib.Path(sys.argv[1]), sys.argv[2]
arm = json.loads((bus / "watch/arm.json").read_text())
assert arm.get("queued_probe_id") == expected, arm
ids = [p.stem for directory in ("spool", "payloads") for p in (bus / directory).glob("watcher-*.md")]
assert ids == [expected], ids
assert (bus / "spool" / (expected + ".md")).is_file()
PYPROBE
done
rm -f "$FAKE_TMUX_STATE/redelivery-busy"
echo "watch-probe-courier: queued ownership survives resets and expires into one sticky notification: ok"

# Re-arm a clean queued episode. The exact unlocked-observer race -- a drain that
# claims and moves canonical between the watcher's claim test and its canonical
# observation, then rolls back before the state write -- was staged here with a
# Bash DEBUG trap on the tick's own commands; the tick is native since W2c-2, so
# that interleaving is staged at its seams instead (runtime/bun/test/
# watch-tick-run.test.ts, "the observer claim fences the claim/canonical rollback
# race"), against the real spool claim and the real lease. What this arc still
# owns is the black-box outcome: a queued probe still in spool keeps its ownership
# and never starts the response clock.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/*.md "$BUS"/spool/*.meta.json "$BUS"/spool/*.claim 2>/dev/null || true
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1500 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
R="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((R + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
queued_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
[ -n "$queued_id" ] || { echo "watch-probe-courier: second queued probe missing" >&2; exit 1; }
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["first_spooled_epoch"]=int(sys.argv[2]); d["deadline_epoch"]=int(sys.argv[2])+1500; json.dump(d,open(p,"w"))' \
  "$BUS/spool/$queued_id.meta.json" "$((R + 2000))"
TAP_WATCH_NOW="$((R + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -f "$BUS/spool/$queued_id.md" ] && [ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')" = "$queued_id" ] \
  || { echo "watch-probe-courier: a parked probe lost queued ownership" >&2; exit 1; }
[ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["last_probe_at"])')" = 0 ] \
  || { echo "watch-probe-courier: a parked probe started the response clock" >&2; exit 1; }
[ ! -f "$BUS/spool/$queued_id.claim" ] \
  || { echo "watch-probe-courier: the observer left its claim behind" >&2; exit 1; }
echo "watch-probe-courier: a parked probe keeps queued ownership under the observer claim: ok"
# A later claimant crashes after moving canonical; once its claim is stale, the
# canonical payload wins and orphan sidecars reconcile.
mv "$BUS/spool/$queued_id.md" "$BUS/payloads/$queued_id.md"
printf '{"id":"%s"}\n' "$queued_id" > "$BUS/spool/$queued_id.claim"
python3 -c 'import os,sys; os.utime(sys.argv[1], (1, 1))' "$BUS/spool/$queued_id.claim"
# Sidecar cleanup runs only on the watch loop's bounded candidate batch;
# a bare tick gets an empty batch, so hand this tick the batch the loop would.
gc_batch="{\"sidecars\":[\"$queued_id.meta.json\",\"$queued_id.meta.json.lock\",\"$queued_id.claim\"],\"digests\":[],\"paneEffects\":[]}"
TAP_SPOOL_GC_BATCH="$gc_batch" TAP_SPOOL_CLAIM_STALE_SECONDS=0 TAP_WATCH_NOW="$((R + 2002))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["last_probe_at"])')" = "$((R + 2002))" ] \
  || { echo "watch-probe-courier: canonical crash recovery did not start the response clock" >&2; exit 1; }
[ -z "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')" ] \
  || { echo "watch-probe-courier: canonical crash recovery retained queued ownership" >&2; exit 1; }
[ -f "$BUS/payloads/$queued_id.md" ] && [ ! -f "$BUS/spool/$queued_id.meta.json" ] && [ ! -f "$BUS/spool/$queued_id.claim" ] \
  || { echo "watch-probe-courier: canonical crash recovery did not reconcile orphan sidecars" >&2; find "$BUS/payloads" "$BUS/spool" -maxdepth 1 -type f >&2; exit 1; }
echo "watch-probe-courier: canonical payload wins and orphan sidecars reconcile after drain crash: ok"

# Re-arm for the ordinary successful drain proof below.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/*.md "$BUS"/spool/*.meta.json "$BUS"/spool/*.claim 2>/dev/null || true
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1500 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
Q="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((Q + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
queued_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
rm -f "$FAKE_TMUX_STATE/busy"
# The busy pane's draft is gone, which the real waiter notices (two bare samples)
# and answers by deleting the pane's protection record; the fixture does the same
# so the held probe is released rather than waiting out a wall-clock grace.
grep -qF "\"id\":\"$queued_id\"" "${TAP_INDEX_HOME:?}"/input-protection/*.json 2>/dev/null \
  || { echo "watch-probe-courier: queued probe parked without a pane-shared protection record naming it" >&2; exit 1; }
bash -c '. "$1"; tap_protection_release_all' _ "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
TAP_WATCH_NOW="$((Q + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -f "$BUS/payloads/$queued_id.md" ] && [ ! -f "$BUS/spool/$queued_id.md" ] \
  || { echo "watch-probe-courier: queued probe did not leave spool" >&2; exit 1; }
[ "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["last_probe_at"])')" = "$((Q + 2001))" ] \
  || { echo "watch-probe-courier: response clock did not start at observed spool exit" >&2; exit 1; }
[ -z "$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')" ] \
  || { echo "watch-probe-courier: queued probe state did not clear after spool exit" >&2; exit 1; }
echo "watch-probe-courier: queued probe is single-mint and timer-free until spool exit: ok"

# A queued probe delivered after genuine activity seeds the new quiet episode
# with its carried rung/timer; fresh-episode initialization must not erase it.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
touch "$FAKE_TMUX_STATE/busy"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 10 --probe-timeout 100 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
C="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((C + 20))" bash "$TAPSH" watch tick >/dev/null 2>&1
carried_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
[ -n "$carried_id" ] || { echo "watch-probe-courier: carried-timer setup did not queue a probe" >&2; exit 1; }
cat > "$BUS/payloads/carried-activity.md" <<EOF
---
id: carried-activity
from: lead
to: helper
kind: discuss
reply: settle-only
path: $BUS/payloads/carried-activity.md
---
real work resumed
EOF
python3 -c 'import os,sys; t=int(sys.argv[2]); os.utime(sys.argv[1],(t,t))' "$BUS/payloads/carried-activity.md" "$((C + 21))"
TAP_WATCH_NOW="$((C + 21))" bash "$TAPSH" watch tick >/dev/null 2>&1
rm -f "$FAKE_TMUX_STATE/busy"
TAP_WATCH_NOW="$((C + 25))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("episode_started_at")==0 and d.get("last_probe_at")==int(sys.argv[2]) and not d.get("queued_probe_id"), d' \
  "$BUS/watch/arm.json" "$((C + 25))" \
  || { echo "watch-probe-courier: below-threshold delivery did not retain its original timestamp" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
TAP_WATCH_NOW="$((C + 40))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("episode_started_at")==int(sys.argv[2]) and d.get("last_probe_at")==int(sys.argv[3]) and d.get("current_rung")==1 and d.get("probed_seats")==["helper"] and not d.get("queued_probe_id"), d' \
  "$BUS/watch/arm.json" "$((C + 40))" "$((C + 25))" \
  || { echo "watch-probe-courier: fresh episode erased delivered queued-probe timer/rung" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
TAP_WATCH_NOW="$((C + 41))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(find "$BUS/payloads" "$BUS/spool" -type f -name 'watcher-*.md' | wc -l | tr -d ' ')" = 1 ] \
  || { echo "watch-probe-courier: carried response timer allowed a replacement probe" >&2; exit 1; }
echo "watch-probe-courier: delivered queued probe carries its timer/rung into a fresh episode: ok"

# Delivery during a run pause is still real delivery. Manual resume and automatic
# expiry advance only the administrative silence floor; neither may impersonate
# a recipient response and discard the durable carried seat/timestamp.
for pause_exit in resume expiry; do
  rm -rf "$BUS/watch" "$BUS/seat-state"
  rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
  touch "$FAKE_TMUX_STATE/busy"
  bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
    --threshold 10 --probe-timeout 100 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
  P="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
  TAP_WATCH_NOW="$((P + 20))" bash "$TAPSH" watch tick >/dev/null 2>&1
  paused_probe_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
  [ -n "$paused_probe_id" ] || { echo "watch-probe-courier: $pause_exit carry setup did not queue a probe" >&2; exit 1; }
  TAP_WATCH_NOW="$((P + 21))" bash "$TAPSH" watch pause --by lead -m "maintenance" --for 5s >/dev/null 2>&1
  rm -f "$FAKE_TMUX_STATE/busy"
  TAP_WATCH_NOW="$((P + 25))" bash "$TAPSH" watch tick >/dev/null 2>&1
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("carried_probe_seat")=="helper" and d.get("carried_probe_at")==int(sys.argv[2]) and not d.get("queued_probe_id"), d' \
    "$BUS/watch/arm.json" "$((P + 25))" \
    || { echo "watch-probe-courier: $pause_exit did not persist delivery during pause" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
  if [ "$pause_exit" = resume ]; then
    TAP_WATCH_NOW="$((P + 26))" bash "$TAPSH" watch resume --by lead >/dev/null 2>&1
  else
    TAP_WATCH_NOW="$((P + 26))" bash "$TAPSH" watch tick >/dev/null 2>&1
  fi
  TAP_WATCH_NOW="$((P + 27))" bash "$TAPSH" watch tick >/dev/null 2>&1
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("carried_probe_seat")=="helper" and d.get("carried_probe_at")==int(sys.argv[2]), d' \
    "$BUS/watch/arm.json" "$((P + 25))" \
    || { echo "watch-probe-courier: $pause_exit silence floor impersonated real activity" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
  TAP_WATCH_NOW="$((P + 40))" bash "$TAPSH" watch tick >/dev/null 2>&1
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("last_probe_at")==int(sys.argv[2]) and d.get("probed_seats")==["helper"] and d.get("current_rung")==1, d' \
    "$BUS/watch/arm.json" "$((P + 25))" \
    || { echo "watch-probe-courier: $pause_exit lost delivered probe at fresh episode" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
  [ "$(find "$BUS/payloads" "$BUS/spool" -type f -name 'watcher-*.md' -exec grep -l '^kind: probe$' {} + | wc -l | tr -d ' ')" = 1 ] \
    || { echo "watch-probe-courier: $pause_exit minted a replacement for the delivered probe" >&2; exit 1; }
done
echo "watch-probe-courier: pause resume/expiry preserve delivered probe ownership: ok"

# A queued-to-carried observer from an old tick must not merge into a fresh arm.
# Rearm in the same injected second to make armed_at collide: queued-id CAS, not
# timestamp luck, must reject the stale transition.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
touch "$FAKE_TMUX_STATE/busy"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 10 --probe-timeout 100 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
S="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((S + 20))" bash "$TAPSH" watch tick >/dev/null 2>&1
stale_id="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json")).get("queued_probe_id", ""))')"
[ -n "$stale_id" ] || { echo "watch-probe-courier: stale-rearm setup did not queue a probe" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/busy"
# The same-second re-arm BETWEEN the canonical observation and the guarded write was
# staged with a Bash DEBUG trap on the tick's `tap_watch_set`; native since W2c-2, that
# interleaving is staged at the tick's seams (runtime/bun/test/watch-tick-run.test.ts,
# "a same-second re-arm between the canonical observation and the guarded write is
# refused by the queued-id guard") against the real lease. This arc keeps the black-box
# half: after a re-arm in the same second BEFORE the tick, the tick runs a FRESH episode
# from the fresh record -- nothing of the stale queued probe (its id, a carried seat, a
# carried clock) survives into it.
BASH_ENV= TAP_WATCH_NOW="$S" bash "$TAPSH" watch on --by lead \
  -m "done; proof; bound" --evaluator none --threshold 10 --probe-timeout 100 \
  --chain '["helper"]' --terminal ghost --rearm --no-spawn >/dev/null 2>&1
mv "$BUS/spool/$stale_id.md" "$BUS/payloads/$stale_id.md" 2>/dev/null || true
rearm_tick_out=""
if ! rearm_tick_out="$(TAP_WATCH_NOW="$((S + 25))" bash "$TAPSH" watch tick 2>&1)"; then
  echo "watch-probe-courier: same-second rearm tick failed: $rearm_tick_out" >&2
  exit 1
fi
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("armed_at")==int(sys.argv[2]) and d.get("queued_probe_id","")!=sys.argv[3] and not d.get("carried_probe_seat") and d.get("carried_probe_at")==0 and d.get("episode_started_at")==int(sys.argv[2])+25, d' \
  "$BUS/watch/arm.json" "$S" "$stale_id" \
  || { echo "watch-probe-courier: stale queued observer contaminated fresh rearm" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
echo "watch-probe-courier: a same-second rearm before the tick starts a fresh episode with nothing of the stale probe: ok"

# D5 observer gate: a row registered as Codex but observed running zsh is not an
# eligible transport rung. The watcher selects __human__ without probing it;
# these receipts pin the preflight refusal separately from the transport-level
# unsupported_harness refusal below (ruling).
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
touch "$FAKE_TMUX_STATE/unsafe"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
W="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
TAP_WATCH_NOW="$((W + 2))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("probed_seats")==[] and d.get("current_rung")==0, d' \
  "$BUS/watch/arm.json" \
  || { echo "watch-probe-courier: observer-rejected seat entered the probe ladder" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
[ -f "$BUS/watch/notify.json" ] \
  || { echo "watch-probe-courier: observer-rejected seat did not select the human rung" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/unsafe"
echo "watch-probe-courier: observer-rejected harness selects human without probing: ok"

# Repairable rc1 classes remain retryable and quiet; rc5 pending is a durable
# accepted disposition that starts the response clock exactly like injection.
# D5 admits only observer-proven active seats before transport. Keep the fixture
# as a valid Codex pane here so these assertions reach the mocked watch-send
# refusal seam; the terminal transport-refusal behavior is covered independently
# by the case immediately below.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/* 2>/dev/null || true
rm -f "$FAKE_TMUX_STATE/unsafe"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1 --probe-timeout 10 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
V="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
for repairable_class in seat_pending tmux_unreachable identity_mismatch; do
  FAKE_WATCH_SEND_JSON="{\"status\":\"refused\",\"delivery\":\"\",\"error_class\":\"$repairable_class\",\"action\":\"tap doctor\",\"detail\":\"repairable refusal\"}" \
    FAKE_WATCH_SEND_RC=1 TAP_COURIER_SCRIPT="$FAKE_BIN/watch-send" TAP_WATCH_NOW="$((V + 2))" \
    bash "$TAPSH" watch tick >/dev/null 2>&1
done
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("probed_seats")==[] and d.get("current_rung")==0, d' \
  "$BUS/watch/arm.json" \
  || { echo "watch-probe-courier: repairable rc1 advanced the rung" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
[ ! -f "$BUS/watch/notify.json" ] \
  || { echo "watch-probe-courier: repairable rc1 emitted a sticky notification" >&2; exit 1; }
FAKE_WATCH_SEND_JSON='{"status":"pending","id":"watcher-pending","path":"/tmp/watcher-pending.md","delivery":""}' \
  FAKE_WATCH_SEND_RC=5 TAP_COURIER_SCRIPT="$FAKE_BIN/watch-send" TAP_WATCH_NOW="$((V + 3))" \
  bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("probed_seats")==["helper"] and d.get("current_rung")==1 and d.get("last_probe_at")==int(sys.argv[2]), d' \
  "$BUS/watch/arm.json" "$((V + 3))" \
  || { echo "watch-probe-courier: rc5 pending was not consumed as durable acceptance" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
rm -f "$FAKE_TMUX_STATE/unsafe"
echo "watch-probe-courier: repairable rc1 retries quietly; rc5 pending is accepted: ok"

# A terminal transport refusal (unsafe harness) is not retryable. It advances
# the rung once, creates no payload/spool artifact, and emits one sticky notice.
# Keep the pane observer-valid and induce refusal through the supported send
# seam: probed_seats=[helper] then proves the transport branch ran. This repath
# preserves the deliberate behavior after D5's observer gate, per the
# pre-edit ruling.
rm -rf "$BUS/watch" "$BUS/seat-state"
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done "$BUS"/spool/*.md "$BUS"/spool/*.meta.json "$BUS"/spool/*.claim 2>/dev/null || true
rm -f "$FAKE_TMUX_STATE/unsafe"
bash "$TAPSH" watch on --by lead -m "done; proof; bound" --evaluator none \
  --threshold 1500 --chain '["helper"]' --terminal ghost --no-spawn >/dev/null 2>&1
U="$(python3 -c 'import json;print(json.load(open("'"$BUS"'/watch/arm.json"))["armed_at"])')"
FAKE_WATCH_SEND_JSON='{"status":"refused","delivery":"","error_class":"unsupported_harness","action":"tap doctor","detail":"terminal refusal"}' \
  FAKE_WATCH_SEND_RC=1 TAP_COURIER_SCRIPT="$FAKE_BIN/watch-send" TAP_WATCH_NOW="$((U + 2000))" \
  bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("probed_seats")==["helper"] and d.get("current_rung")==1, d' \
  "$BUS/watch/arm.json" \
  || { echo "watch-probe-courier: terminal refusal remained retryable" >&2; cat "$BUS/watch/arm.json" >&2; exit 1; }
[ -f "$BUS/watch/notify.json" ] || { echo "watch-probe-courier: terminal refusal did not notify the human" >&2; exit 1; }
[ "$(find "$BUS/payloads" "$BUS/spool" -type f \( -name '*.md' -o -name '*.meta.json' \) | wc -l | tr -d ' ')" = 0 ] \
  || { echo "watch-probe-courier: terminal refusal left transport artifacts" >&2; find "$BUS/payloads" "$BUS/spool" -type f >&2; exit 1; }
TAP_WATCH_NOW="$((U + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("probed_seats")==["helper"], d' "$BUS/watch/arm.json"
rm -f "$FAKE_TMUX_STATE/unsafe"
echo "watch-probe-courier: terminal refusal advances once without artifacts or retry: ok"

echo "watch-probe-courier: ok"
