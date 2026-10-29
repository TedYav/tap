#!/usr/bin/env bash
# tap-7r3fn.21 U2: refresh reconciles one observation into three outcomes:
# rebind an unbound durable seat, keep a relaunchable durable seat, and collect
# an ephemeral corpse. Both runtimes must agree, and doctor only delegates the
# write when --fix is explicit.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
RUNNER_INDEX_HOME="$TAP_INDEX_HOME"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-refresh-reconcile.XXXXXX")"
TEAM="reconcile-$$"
HEALTHY="$TEAM/healthy"
DEAD="$TEAM/dead"
GUARD="$TEAM/guard"
TRACE="$WORK/native.trace"
cleanup() {
  timeout 5 tmux kill-session -t "=$HEALTHY" >/dev/null 2>&1 || true
  timeout 5 tmux kill-session -t "=$DEAD" >/dev/null 2>&1 || true
  timeout 5 tmux kill-session -t "=$GUARD" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin"
# Born live, every git root is a candidate team, so the panes and the reconcile
# arms live in a scratch team root, never the checkout (a rebind writes events
# and lineage beneath the enrolled root).
TEAM_ROOT="$WORK/PostRestartRecovery"
mkdir -p "$TEAM_ROOT" && git -C "$TEAM_ROOT" init -q
TEAM_ROOT="$(cd "$TEAM_ROOT" && pwd -P)"
cat >"$WORK/codex.c" <<'C'
#include <unistd.h>
int main(void) { sleep(300); return 0; }
C
clang -O0 -o "$WORK/bin/codex" "$WORK/codex.c"
timeout 5 tmux new-session -d -s "$HEALTHY" -c "$TEAM_ROOT" "$WORK/bin/codex"
timeout 5 tmux new-session -d -s "$DEAD" -c "$TEAM_ROOT" "/bin/sleep 300"

# tap-zkyt1 / incident 60: an UNPINNED enroll from a system temporary root
# must refuse before touching the fallback ~/.tap index. HOME is itself a test
# sandbox here, so this reaches the production-path branch without any route to
# the operator's real index. The realpath check is load-bearing on macOS, where
# /var/folders resolves under /private/var/folders.
TEMP_REPO="$WORK/tmpe9ewp3lo"
PRODUCTION_HOME="$WORK/production-home"
PINNED_INDEX="$WORK/pinned-index"
mkdir -p "$TEMP_REPO/.tap/bus/payloads" "$TEMP_REPO/.tap/bus/receipts" \
  "$PRODUCTION_HOME/.tap" "$PINNED_INDEX"
git -C "$TEMP_REPO" init -q
python3 -B - "$TEMP_REPO/.tap/team-registry.json" "$TEMP_REPO" <<'PY'
import json, os, sys
path, root = sys.argv[1:3]
with open(path, "w") as fh:
    json.dump({
        "schema": "0.20",
        "team": {"name": os.path.basename(root), "worktree_root": root},
        "seats": {},
    }, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
python3 -B - "$PRODUCTION_HOME/.tap/global-registry.json" "$TEMP_REPO" <<'PY'
import json, os, sys
path, root = sys.argv[1:3]
with open(path, "w") as fh:
    json.dump({"schema": "0.20", "teams": {
        os.path.basename(root): {
            "root": root,
            "registry_location": root + "/.tap/team-registry.json",
            "state": "registered",
        },
    }}, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
printf '{"schema":"0.20","teams":{}}\n' >"$PINNED_INDEX/global-registry.json"
timeout 5 tmux new-session -d -s "$GUARD" -c "$TEMP_REPO" "$WORK/bin/codex"
production_before="$(shasum -a 256 "$PRODUCTION_HOME/.tap/global-registry.json")"
set +e
guard_err="$(cd "$TEMP_REPO" && env -u TAP_INDEX_HOME -u TAP_HOME HOME="$PRODUCTION_HOME" \
  TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:2" \
  "$ROOT/scripts/tap.sh" register guard --pane "$GUARD:0.0" 2>&1 >/dev/null)"
guard_rc=$?
set -e
[ "$guard_rc" -ne 0 ] && [[ "$guard_err" == *"TAP_INDEX_HOME"* ]] \
  || { echo "team-refresh-reconcile: unpinned temp-root enroll did not refuse with TAP_INDEX_HOME remedy" >&2; echo "$guard_err" >&2; exit 1; }
[ "$production_before" = "$(shasum -a 256 "$PRODUCTION_HOME/.tap/global-registry.json")" ] \
  || { echo "team-refresh-reconcile: refused temp-root enroll changed fallback production index" >&2; exit 1; }
python3 -B - "$TEMP_REPO/.tap/team-registry.json" <<'PY'
import json, sys
doc=json.load(open(sys.argv[1]))
seats=doc.get("seats") if isinstance(doc.get("seats"), dict) else doc.get("agents") or {}
assert not seats, seats
PY

# An empty variable is still unpinned because index resolution falls back to
# HOME for both unset and empty values.
set +e
empty_guard_err="$(cd "$TEMP_REPO" && env -u TAP_HOME HOME="$PRODUCTION_HOME" TAP_INDEX_HOME= \
  TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:2" \
  "$ROOT/scripts/tap.sh" register guard --pane "$GUARD:0.0" 2>&1 >/dev/null)"
empty_guard_rc=$?
set -e
[ "$empty_guard_rc" -ne 0 ] && [[ "$empty_guard_err" == *"TAP_INDEX_HOME"* ]] \
  || { echo "team-refresh-reconcile: empty temp-root pin did not refuse with TAP_INDEX_HOME remedy" >&2; echo "$empty_guard_err" >&2; exit 1; }
[ "$production_before" = "$(shasum -a 256 "$PRODUCTION_HOME/.tap/global-registry.json")" ] \
  || { echo "team-refresh-reconcile: empty temp-root pin changed fallback production index" >&2; exit 1; }
python3 -B - "$TEMP_REPO/.tap/team-registry.json" <<'PY'
import json, sys
doc=json.load(open(sys.argv[1]))
seats=doc.get("seats") if isinstance(doc.get("seats"), dict) else doc.get("agents") or {}
assert not seats, seats
PY

# The pin is an explicit sandbox authorization, not a blanket temp-root ban.
# It must enroll only in the pinned index and leave the fallback index byte-identical.
(cd "$TEMP_REPO" && env -u TAP_HOME HOME="$PRODUCTION_HOME" TAP_INDEX_HOME="$PINNED_INDEX" \
  TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:2" TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE=1 \
  "$ROOT/scripts/tap.sh" register guard --pane "$GUARD:0.0" >/dev/null)
[ "$production_before" = "$(shasum -a 256 "$PRODUCTION_HOME/.tap/global-registry.json")" ] \
  || { echo "team-refresh-reconcile: pinned enroll changed fallback production index" >&2; exit 1; }
python3 -B - "$PINNED_INDEX/global-registry.json" "$(basename "$TEMP_REPO")" <<'PY'
import json, sys
teams=json.load(open(sys.argv[1]))["teams"]
assert sys.argv[2] in teams, teams
PY

export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:2"
unset CODEX_SESSION_ID CODEX_THREAD_ID

seed() { # <label>: a fresh canonical bus for one arm; the previous arm's state moves aside
  local bus="$TEAM_ROOT/.tap/bus"
  if [ -e "$TEAM_ROOT/.tap" ]; then mv "$TEAM_ROOT/.tap" "$WORK/spent-$1"; fi
  mkdir -p "$bus/payloads" "$bus/receipts"
  python3 -B - "$bus/registry.json" "$TEAM_ROOT" "$HEALTHY" "$DEAD" <<'PY'
import json, sys
path, root, healthy, dead = sys.argv[1:5]
base = {
    "status": "suspended", "status_reason": "server_restarted",
    "delivery": "pane", "harness": "codex",
    "server_epoch": "srv:900:100", "boot_id": "boot:2",
}
agents = {
    "healthy": {**base, "session": healthy, "harness_session_id": "keep-me"},
    "missing": {**base, "session": healthy + "-missing"},
    "dead": {**base, "session": dead},
    "rebooted": {**base, "session": healthy, "boot_id": "boot:1"},
    "repair": {**base, "status_reason": "repair_failed",
               "session": healthy + "-repair", "server_epoch": "srv:1:1", "boot_id": "boot:1"},
    "crew-corpse": {**base, "session": healthy + "-crew", "crew": True},
    "retired": {**base, "status_reason": "user_removed", "session": healthy + "-retired"},
}
doc = {"schema": "0.20", "team": {"name": "PostRestartRecovery", "worktree_root": root}, "seats": agents}
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
  # Born live: the rebind registers through the enrolled acting registry.
  printf '{"schema":"0.20","teams":{"PostRestartRecovery":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' \
    "$TEAM_ROOT" "$bus" > "${TAP_INDEX_HOME:?}/global-registry.json"
}

assert_result() {
  local bus="$1" out="$2" label="$3"
  python3 -B - "$bus/registry.json" "$out" "$HEALTHY" "$label" <<'PY'
import json, sys
registry_path, raw, healthy_session, label = sys.argv[1:5]
receipt = json.loads(raw)
trimmed = {item["handle"]: item["reason"] for item in receipt["trimmed"]}
kept = {item["handle"]: item["reason"] for item in receipt["kept"]}
assert trimmed == {}, (label, receipt)
assert kept == {
    "crew-corpse": "crew_retained:server_restarted",
    "dead": "offline:server_restarted",
    "healthy": "rebound:server_revived",
    "missing": "offline:server_restarted",
    "rebooted": "offline:server_restarted",
    "repair": "no-pane",
    "retired": "no-pane",
}, (label, receipt)
agents = json.load(open(registry_path))["seats"]
assert set(agents) == {"healthy", "missing", "dead", "rebooted", "repair", "retired", "crew-corpse"}, (label, agents)
row = agents["healthy"]
assert row["status"] == "active" and row.get("status_reason", "") == "", (label, row)
assert row["session"] == healthy_session and row["pane"].startswith(healthy_session + ":"), (label, row)
assert row["pane_id"].startswith("%") and row["pane_current_command"] == "codex", (label, row)
assert row["harness_session_id"] == "keep-me", (label, row)
for handle in ("missing", "dead", "rebooted"):
    assert agents[handle]["status"] == "suspended", (label, agents[handle])
    assert agents[handle]["status_reason"] == "server_restarted", (label, agents[handle])
assert agents["repair"]["status_reason"] == "repair_failed", (label, agents["repair"])
assert agents["retired"]["status_reason"] == "user_removed", (label, agents["retired"])
PY
  grep -q 'actor=dispatcher action=server_revived handle=healthy' "$bus/registry-events.log" \
    || { echo "team-refresh-reconcile: $label omitted dispatcher/server_revived event" >&2; exit 1; }
}

cd "$TEAM_ROOT"
NATIVE_BUS="$TEAM_ROOT/.tap/bus"
seed native
export TAP_HOME="$NATIVE_BUS"
: >"$TRACE"
native_out="$(TAP_BUN_ROUTE_TRACE="$TRACE" "$ROOT/bin/tap" team refresh --json)"
grep -q '^native team$' "$TRACE" \
  || { echo "team-refresh-reconcile: native case did not use native team route" >&2; exit 1; }
assert_result "$NATIVE_BUS" "$native_out" native

# Human output is a supported surface too. Dry-run keeps the fixture intact
# while proving the prettifier names the repair opportunity.
HUMAN_NATIVE_BUS="$TEAM_ROOT/.tap/bus"
seed human-native
export TAP_HOME="$HUMAN_NATIVE_BUS"
human_native="$("$ROOT/bin/tap" team refresh --dry-run)"
[[ "$human_native" == *"kept 'healthy'; its binding can be restored after server revival"* ]] \
  || { echo "team-refresh-reconcile: native human receipt omitted rebind-ready prose" >&2; echo "$human_native" >&2; exit 1; }

# --hard owns the earlier lifecycle-cut branch. A live restart-suspended session
# is kept as hard_session_live and is not opportunistically rebound.
HARD_BUS="$TEAM_ROOT/.tap/bus"
seed hard
export TAP_HOME="$HARD_BUS"
hard_out="$("$ROOT/bin/tap" team refresh --hard --dry-run --json)"
python3 -B - "$hard_out" <<'PY'
import json, sys
d=json.loads(sys.argv[1])
kept={item["handle"]:item["reason"] for item in d["kept"]}
assert kept["healthy"] == "hard_session_live", d
PY
python3 -B - "$HARD_BUS/registry.json" <<'PY'
import json, sys
row=json.load(open(sys.argv[1]))["seats"]["healthy"]
assert row["status"] == "suspended" and "pane" not in row and "pane_id" not in row, row
PY

# Doctor's body reports the shared classifier result without writing. --fix
# delegates to the routed refresh and returns that reconciler's JSON receipt.
DOCTOR_BUS="$TEAM_ROOT/.tap/bus"
seed doctor
export TAP_HOME="$DOCTOR_BUS"
export TAP_INDEX_HOME="$RUNNER_INDEX_HOME"
before="$(cat "$DOCTOR_BUS/registry.json")"
set +e
doctor_out="$("$ROOT/bin/tap" doctor --json 2>"$WORK/doctor.err")"
doctor_rc=$?
set -e
[ "$doctor_rc" -eq 0 ] \
  || { echo "team-refresh-reconcile: doctor report failed rc=$doctor_rc" >&2; cat "$WORK/doctor.err" >&2; echo "$doctor_out" >&2; exit 1; }
[ "$before" = "$(cat "$DOCTOR_BUS/registry.json")" ] \
  || { echo "team-refresh-reconcile: doctor without --fix changed registry bytes" >&2; exit 1; }
python3 -B - "$doctor_out" <<'PY'
import json, sys
d=json.loads(sys.argv[1])
hits=[f for f in d["findings"] if f["name"] == "seats_unbound"]
assert len(hits) == 1 and hits[0]["detail"]["count"] == 1, d
PY
fixed="$("$ROOT/bin/tap" doctor --fix --json)"
assert_result "$DOCTOR_BUS" "$fixed" doctor-fix
after="$("$ROOT/bin/tap" doctor --json)"
python3 -B - "$after" <<'PY'
import json, sys
d=json.loads(sys.argv[1])
assert not [f for f in d["findings"] if f["name"] == "seats_unbound"], d
PY

# A live v0.20 marker needs a canonical enrolled root and acting registry. Keep
# that authority fixture separate from the custom-bus unbound case above: a
# relocated registry under a live marker should fail closed, not become a test
# shortcut. Doctor reports missing roots without mutation; --fix prunes exactly
# those rows through the guarded index writer before delegating to refresh.
cd "$ROOT"
DANGLING_ROOT="$WORK/DoctorReconcile"
DANGLING_BUS="$DANGLING_ROOT/.tap/bus"
DANGLING_REGISTRY="$DANGLING_ROOT/.tap/team-registry.json"
DANGLING_INDEX="$WORK/dangling-index"
mkdir -p "$DANGLING_BUS/payloads" "$DANGLING_BUS/receipts" "$DANGLING_INDEX"
git -C "$DANGLING_ROOT" init -q
python3 -B - "$DANGLING_REGISTRY" "$DANGLING_ROOT" <<'PY'
import json, os, sys
path, root = sys.argv[1:3]
with open(path, "w") as fh:
    json.dump({
        "schema": "0.20",
        "team": {"name": os.path.basename(root), "worktree_root": root},
        "seats": {},
    }, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
python3 -B - "$DANGLING_INDEX/global-registry.json" "$DANGLING_ROOT" "$DANGLING_REGISTRY" "$WORK" <<'PY'
import json, os, sys
path, root, registry, work = sys.argv[1:5]
teams = {
    os.path.basename(root): {"root": root, "registry_location": registry, "state": "registered"},
    "BunLauncherNight": {"root": work + "/gone-launcher", "registry_location": work + "/gone-launcher/.tap/team-registry.json", "state": "registered"},
    "BunSupervisionNight": {"root": work + "/gone-supervision", "registry_location": work + "/gone-supervision/.tap/team-registry.json", "state": "registered"},
    "BlackSmithCostCheck": {"root": work + "/gone-cost", "registry_location": work + "/gone-cost/.tap/team-registry.json", "state": "registered"},
}
with open(path, "w") as fh:
    json.dump({"schema": "0.20", "teams": teams}, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
index_before="$(shasum -a 256 "$DANGLING_INDEX/global-registry.json")"
set +e
dangling_out="$(cd "$DANGLING_ROOT" && HOME="$WORK/sandbox-home" TAP_HOME="$DANGLING_BUS" \
  TAP_INDEX_HOME="$DANGLING_INDEX" "$ROOT/bin/tap" doctor --json \
  2>"$WORK/dangling-doctor.err")"
dangling_rc=$?
set -e
[ "$dangling_rc" -eq 0 ] \
  || { echo "team-refresh-reconcile: dangling doctor report failed rc=$dangling_rc" >&2; cat "$WORK/dangling-doctor.err" >&2; echo "$dangling_out" >&2; exit 1; }
[ "$index_before" = "$(shasum -a 256 "$DANGLING_INDEX/global-registry.json")" ] \
  || { echo "team-refresh-reconcile: dangling report changed index bytes" >&2; exit 1; }
python3 -B - "$dangling_out" <<'PY'
import json, sys
d=json.loads(sys.argv[1])
hits=[f for f in d["findings"] if f["name"] == "dangling_index_teams"]
assert len(hits) == 1, d
assert hits[0]["detail"]["count"] == 3, d
assert hits[0]["detail"]["teams"] == ["BlackSmithCostCheck", "BunLauncherNight", "BunSupervisionNight"], d
PY
dangling_fixed="$(cd "$DANGLING_ROOT" && HOME="$WORK/sandbox-home" TAP_HOME="$DANGLING_BUS" \
  TAP_INDEX_HOME="$DANGLING_INDEX" "$ROOT/bin/tap" doctor --fix --json)"
[ "$dangling_fixed" = '{"trimmed":[],"skipped":[],"kept":[]}' ] \
  || { echo "team-refresh-reconcile: dangling doctor --fix did not return refresh receipt" >&2; echo "$dangling_fixed" >&2; exit 1; }
python3 -B - "$DANGLING_INDEX/global-registry.json" "$(basename "$DANGLING_ROOT")" <<'PY'
import json, sys
teams=json.load(open(sys.argv[1]))["teams"]
assert set(teams) == {sys.argv[2]}, teams
PY
dangling_after="$(cd "$DANGLING_ROOT" && HOME="$WORK/sandbox-home" TAP_HOME="$DANGLING_BUS" \
  TAP_INDEX_HOME="$DANGLING_INDEX" "$ROOT/bin/tap" doctor --json)"
python3 -B - "$dangling_after" <<'PY'
import json, sys
d=json.loads(sys.argv[1])
assert not [f for f in d["findings"] if f["name"] == "dangling_index_teams"], d
PY

echo "team-refresh-reconcile: native, Bash, doctor report/fix, dangling index, and --hard precedence: ok"
