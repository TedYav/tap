#!/usr/bin/env bash
# watch-tick-ladder.test.sh — U5: `tap watch tick` silence predicate + episode ladder.
# State-machine only (KTD3): seeded bus + injected clock (TAP_WATCH_NOW), no real tmux.
# Mock courier path (if any tick probes) — settle sleeps prove nothing against sync mock.
export TAP_TUI_SETTLE_SCALE=0.1
# Covers R8 (clamps, porcelain hash, armed_at floor, empty-bus/zero-commit), episode
# resumption reset, AE11 (settled-without-acting advances, never resets), AE9 (the
# deterministic pre-check gates the evaluator).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# Redirect the machine index home: tap-watch.sh now invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "none:0.0", "harness": "claude", "status": "active", "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2],""); print(v)' "$BUS/watch/arm.json" "$1"; }
setf()  { python3 -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r[sys.argv[2]]=int(sys.argv[3]) if sys.argv[3].lstrip("-").isdigit() else sys.argv[3]; json.dump(r,open(p,"w"))' "$BUS/watch/arm.json" "$1" "$2"; }
arm()   { bash "$TAPSH" watch on --rearm --by lead -m "done; proof; bound" --evaluator none --threshold 1500 --probe-timeout 1500 --no-spawn >/dev/null 2>&1; }
tick()  { TAP_WATCH_NOW="$1" bash "$TAPSH" watch tick >/dev/null 2>&1; }

# (1) armed_at floor: a freshly-armed team is never wedge-suspect for one threshold.
arm; A="$(field armed_at)"
tick "$((A + 100))"
[ "$(field episode_started_at)" = 0 ] || { echo "tick-ladder: (1) fresh team went wedge-suspect inside one threshold" >&2; exit 1; }
echo "tick-ladder: (1) armed_at floor — fresh team not wedge-suspect: ok"

# (2) empty bus + zero-commit repo: no crash; silence falls back to the armed_at floor.
tick "$((A + 2000))"                                   # past threshold -> episode starts
[ "$(field episode_started_at)" != 0 ] || { echo "tick-ladder: (2) empty-bus/zero-commit did not reach wedge-suspect" >&2; exit 1; }
echo "tick-ladder: (2) empty bus + zero-commit -> armed_at floor, wedge-suspect: ok"

# (3) future mtime is clamped, not counted as far-future activity.
arm; A="$(field armed_at)"
touch -t 203801190000 "$BUS/payloads/future.md" 2>/dev/null || touch "$BUS/payloads/future.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (9999999999, 9999999999))' "$BUS/payloads/future.md"
printf -- '---\nid: future\nfrom: lead\nto: x\nkind: discuss\n---\nbody\n' > "$BUS/payloads/future.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (9999999999, 9999999999))' "$BUS/payloads/future.md"
tick "$((A + 2000))"    # future payload clamps to now -> last_activity=now -> silence 0 -> no episode
[ "$(field episode_started_at)" = 0 ] || { echo "tick-ladder: (3) future mtime not clamped (spuriously wedge-suspect avoided? inverse)" >&2; exit 1; }
rm -f "$BUS/payloads/future.md"
echo "tick-ladder: (3) future mtime clamped to now: ok"

# (4) porcelain-hash change counts as repo activity (never raw index mtime).
GITREPO="$WORK/gitrepo"; mkdir -p "$GITREPO"; git -C "$GITREPO" init -q
git -C "$GITREPO" config user.email t@t; git -C "$GITREPO" config user.name t
echo one > "$GITREPO/a"; git -C "$GITREPO" add -A; git -C "$GITREPO" commit -qm one
GBUS="$GITREPO/.tap/bus"; mkdir -p "$GBUS/payloads" "$GBUS/receipts"
cat > "$GBUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "g", "worktree_root": "$GITREPO" }, "seats": { "lead": { "pane": "none:0.0", "harness": "claude", "status": "active", "registered_from_worktree": "$GITREPO" } } }
JSON
TAP_HOME="$GBUS" bash "$TAPSH" watch on --rearm --by lead -m x --evaluator none --threshold 1500 --no-spawn >/dev/null 2>&1
GA="$(python3 -c 'import json;print(json.load(open("'"$GBUS"'/watch/arm.json"))["armed_at"])')"
TAP_HOME="$GBUS" TAP_WATCH_NOW="$((GA + 10))" bash "$TAPSH" watch tick >/dev/null 2>&1   # seed porcelain hash
echo dirty > "$GITREPO/b"                                                                # change the worktree
TAP_HOME="$GBUS" TAP_WATCH_NOW="$((GA + 3000))" bash "$TAPSH" watch tick >/dev/null 2>&1  # porcelain change -> activity now
gep="$(python3 -c 'import json;print(json.load(open("'"$GBUS"'/watch/arm.json")).get("episode_started_at"))')"
[ "$gep" = "0" ] || { echo "tick-ladder: (4) porcelain change did not reset silence (episode=$gep)" >&2; exit 1; }
echo "tick-ladder: (4) porcelain-hash change counts as repo activity: ok"

# (5) resumption: a new NON-supervision payload after the episode began resets it.
arm; A="$(field armed_at)"
tick "$((A + 2000))"; [ "$(field episode_started_at)" != 0 ] || { echo "tick-ladder: (5) precondition: episode not started" >&2; exit 1; }
printf -- '---\nid: work-1\nfrom: lead\nto: peer\nkind: discuss\n---\nreal work\n' > "$BUS/payloads/work-1.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/work-1.md" "$((A + 2100))"
tick "$((A + 2200))"
[ "$(field episode_started_at)" = 0 ] || { echo "tick-ladder: (5) new work traffic did not reset the episode" >&2; exit 1; }
rm -f "$BUS/payloads/work-1.md"
echo "tick-ladder: (5) resumption (real bus traffic) resets the episode: ok"

# (6) AE11: a probe settled with NO follow-on activity does not reset escalation; the
# escalation advances at probe_timeout. Probe payload + its .done are supervision -> excluded
# from the silence clock, so silence stays high. Under the identity-based rung, a seat is
# recorded in probed_seats when probed; "advance at probe_timeout" clears the wait
# (last_probe_at -> 0) so the next tick selects the next UNprobed seat, and the probed seat is
# never reselected. (current_rung is now the probed-count, incremented at probe time.)
arm; A="$(field armed_at)"
tick "$((A + 2000))"                              # episode starts
setf last_probe_at "$((A + 2000))"; setf probed_seats '["lead"]'   # simulate: 'lead' probed, waiting
printf -- '---\nid: probe-x\nfrom: watcher\nto: lead\nkind: probe\nreply: settle-only\n---\nprobe body\n' > "$BUS/payloads/probe-x.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/probe-x.md" "$((A + 2050))"
printf '{"id":"probe-x","status":"done","by":"lead"}' > "$BUS/receipts/probe-x.done"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/receipts/probe-x.done" "$((A + 2060))"
tick "$((A + 2000 + 1500))"                       # exactly probe_timeout after the probe
[ "$(field episode_started_at)" != 0 ] || { echo "tick-ladder: (6/AE11) probe .done spuriously reset the episode (settled==acted)" >&2; exit 1; }
[ "$(field last_probe_at)" = 0 ] || { echo "tick-ladder: (6/AE11) probe_timeout did not advance the escalation (last_probe_at still $(field last_probe_at))" >&2; exit 1; }
rm -f "$BUS/payloads/probe-x.md" "$BUS/receipts/probe-x.done"
echo "tick-ladder: (6/AE11) settled-without-acting: no reset, escalation advances at probe_timeout: ok"

# (7) AE9: an unsettled NON-supervision payload gates the evaluator (mechanically
# not_done, no model). With evaluator=codex, driving to chain exhaustion must NOT
# increment evaluator_calls while an unsettled work payload exists.
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done
bash "$TAPSH" watch on --rearm --by lead -m x --evaluator codex --threshold 1500 --no-spawn >/dev/null 2>&1
A="$(field armed_at)"
printf -- '---\nid: unsettled-1\nfrom: peer\nto: lead\nkind: discuss\n---\nwork owed\n' > "$BUS/payloads/unsettled-1.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/unsettled-1.md" "$A"
# drive several ticks to exhaust the chain (lead pane is dead -> pane-gone -> advance -> human)
for n in 2000 2001 2002 2003; do tick "$((A + n))"; done
[ "$(field evaluator_calls)" = "0" ] || { echo "tick-ladder: (7/AE9) evaluator ran despite an unsettled payload (calls=$(field evaluator_calls))" >&2; exit 1; }
# and with the payload settled, the evaluator seam IS reached (calls increments).
printf '{"id":"unsettled-1","status":"done","by":"lead"}' > "$BUS/receipts/unsettled-1.done"
bash "$TAPSH" watch on --rearm --by lead -m x --evaluator codex --threshold 1500 --no-spawn >/dev/null 2>&1
A="$(field armed_at)"
for n in 2000 2001 2002 2003; do tick "$((A + n))"; done
[ "$(field evaluator_calls)" -ge 1 ] || { echo "tick-ladder: (7/AE9) evaluator seam not reached when bus is clean (calls=$(field evaluator_calls))" >&2; exit 1; }
echo "tick-ladder: (7/AE9) deterministic pre-check gates the evaluator: ok"

# (8) DN3: the evaluator budget is PER EPISODE — a second independent wedge episode
# (after real activity) gets a fresh budget, not a permanently-spent one.
rm -f "$BUS"/payloads/*.md "$BUS"/receipts/*.done
bash "$TAPSH" watch on --rearm --by lead -m x --evaluator codex --threshold 1500 --no-spawn >/dev/null 2>&1
A="$(field armed_at)"
for n in 2000 2001 2002; do tick "$((A + n))"; done          # episode 1 -> exhaust the budget
[ "$(field evaluator_calls)" = "2" ] || { echo "tick-ladder: (8) episode 1 did not spend the full budget (got $(field evaluator_calls))" >&2; exit 1; }
printf -- '---\nid: work-2\nfrom: lead\nto: peer\nkind: discuss\n---\nreal work\n' > "$BUS/payloads/work-2.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/work-2.md" "$((A + 2500))"
tick "$((A + 2600))"                                          # resumption -> episode + budget reset
[ "$(field evaluator_calls)" = "0" ] || { echo "tick-ladder: (8) resumption did not reset the evaluator budget (got $(field evaluator_calls))" >&2; exit 1; }
rm -f "$BUS/payloads/work-2.md"
tick "$((A + 5000))"                                          # episode 2 -> fresh budget, seam reached
[ "$(field evaluator_calls)" = "1" ] || { echo "tick-ladder: (8) episode 2 did not get a fresh evaluator budget (got $(field evaluator_calls))" >&2; exit 1; }
echo "tick-ladder: (8/DN3) evaluator budget is per-episode (second episode gets a fresh budget): ok"

# (9) AE2: an UNARMED team is never probed — a tick with no arm record is a clean no-op,
# no matter how long it has been silent.
rm -rf "$BUS/watch"; rm -f "$BUS"/payloads/*.md 2>/dev/null || true
TAP_WATCH_NOW="$((A + 9999999))" bash "$TAPSH" watch tick >/dev/null 2>&1 || { echo "tick-ladder: (9/AE2) unarmed tick should exit 0" >&2; exit 1; }
[ ! -f "$BUS/watch/arm.json" ] || { echo "tick-ladder: (9/AE2) unarmed tick created an arm record" >&2; exit 1; }
[ -z "$(ls "$BUS"/payloads/watcher-*.md 2>/dev/null)" ] || { echo "tick-ladder: (9/AE2) unarmed team was probed" >&2; exit 1; }
echo "tick-ladder: (9/AE2) unarmed team is never probed: ok"

echo "watch-tick-ladder: ok"
