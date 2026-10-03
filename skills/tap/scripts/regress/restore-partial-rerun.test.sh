#!/usr/bin/env bash
# restore-partial-rerun.test.sh — sol 055309 #3: mid-restore fault leaves a
# dead-owner fence; the same restore command converges on rerun.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"
export TAP_HOME="$WORK/team/.tap/bus"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"
printf '{"schema": "0.20", "team":{"name":"r"},"seats":{"a":{"status":"active","delivery":"poll"}}}\n' \
  > "$TAP_HOME/registry.json"
# Born live (F2a): reset and restore bind the enrolled team's acting registry.
printf '{"schema":"0.20","teams":{"r":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$WORK/team" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)/registry.json" > "${TAP_INDEX_HOME:?}/global-registry.json"
printf 'payload\n' > "$TAP_HOME/payloads/p1.md"

"$TAP" team reset --yes >/dev/null
BUNDLE="$(ls "$TAP_HOME/archive/team-reset" | head -1)"
[ -n "$BUNDLE" ] || { echo "restore-partial: no checkpoint" >&2; exit 1; }
# Bus is pristine post-reset. Simulate a crashed restore: partial component copy
# + dead-owner team-restore fence for this bundle (validation would refuse fresh).
python3 -B - "$TAP_HOME" "$BUNDLE" "$TAP_HOME/archive/team-reset/$BUNDLE" <<'PY'
import json, os, shutil, sys
bus, bundle, bdir = sys.argv[1:4]
# Partial copy: payloads only (registry still absent / empty dirs).
src = os.path.join(bdir, "bus", "payloads")
if os.path.isdir(src):
    shutil.copytree(src, os.path.join(bus, "payloads"), dirs_exist_ok=True)
# Non-pristine generation + leftover agent-shaped registry would block fresh restore.
open(os.path.join(bus, "reset-generation.json"), "w").write(
    json.dumps({"bundle_id": bundle, "state": "reused", "first_mutation": "fault"}) + "\n"
)
open(os.path.join(bus, "registry.json"), "w").write(
    json.dumps({"schema": "0.20", "team": {"name": "r"}, "seats": {"a": {"status": "active", "delivery": "poll"}}}) + "\n"
)
fence = {
    "op": "team-restore",
    "pid": 99999,
    "started_at": "1970-01-01T00:00:00Z",
    "token": "dead-restore-token",
    "boot_id": "boot:1",
    "owner_start": "1",
    "phase": "restoring",
    "bundle_id": bundle,
}
open(os.path.join(bus, "reset.fence.json"), "w").write(json.dumps(fence, indent=2) + "\n")
PY
export TAP_BOOT_ID=boot:1

# CLI part-10: only a dead-owner same-bundle fence permits partial retry.
# Prove that ordinary restore refuses this reused generation before resuming it.
mv "$TAP_HOME/reset.fence.json" "$WORK/interrupted-restore.json"
if fresh_out="$("$TAP" team restore --archive "$BUNDLE" --json 2>&1)"; then
  echo "restore-partial: fresh restore accepted a reused generation" >&2; exit 1
fi
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="generation_reused", d' "$fresh_out"
mv "$WORK/interrupted-restore.json" "$TAP_HOME/reset.fence.json"
out="$("$TAP" team restore --archive "$BUNDLE" 2>&1)" || {
  echo "restore-partial: resume restore failed" >&2
  echo "$out" >&2
  exit 1
}
[ ! -f "$TAP_HOME/reset.fence.json" ] || { echo "restore-partial: fence not released" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
ent = (reg.get("seats") or {}).get("a") or {}
assert ent.get("status") == "suspended", ent
assert ent.get("status_reason") == "restored_from_archive", ent
print("ok")
PY
[ -f "$TAP_HOME/payloads/p1.md" ] || { echo "restore-partial: payload missing" >&2; exit 1; }
echo "restore-partial-rerun: (1) early partial + dead fence: ok"

# --- (2) sol 063858: restored_at written, fence still held, generation/release unfinished ---
# Fresh reset → restore almost completes: stamp restored_at + leave dead fence.
"$TAP" team reset --yes >/dev/null
BUNDLE="$(ls "$TAP_HOME/archive/team-reset" | sort | tail -1)"
"$TAP" team restore --archive "$BUNDLE" >/dev/null
# Simulate crash after restored_at, before fence release: re-plant dead fence + wipe generation mark.
python3 -B - "$TAP_HOME" "$BUNDLE" "$TAP_HOME/archive/team-reset/$BUNDLE" <<'PY'
import json, os, sys, time
bus, bundle, bdir = sys.argv[1:4]
meta_path = os.path.join(bdir, "meta.json")
meta = json.load(open(meta_path))
assert meta.get("restored_at"), "fixture expects restored_at from completed restore"
# Leave restored_at; plant dead-owner resume fence; generation may already be reused.
fence = {
    "op": "team-restore",
    "pid": 99999,
    "started_at": "1970-01-01T00:00:00Z",
    "token": "dead-restore-tail-token",
    "boot_id": "boot:1",
    "owner_start": "1",
    "phase": "restoring",
    "bundle_id": bundle,
}
open(os.path.join(bus, "reset.fence.json"), "w").write(json.dumps(fence, indent=2) + "\n")
PY
export TAP_BOOT_ID=boot:1
# Ordinary second restore without --again would refuse already_restored; resume must not.
set +e
out2="$("$TAP" team restore --archive "$BUNDLE" 2>&1)"
rc2=$?
set -e
[ "$rc2" = 0 ] || { echo "restore-partial: (2) resume after restored_at failed rc=$rc2" >&2; echo "$out2" >&2; exit 1; }
[[ "$out2" == *already_restored* ]] \
  && { echo "restore-partial: (2) resume hit already_restored" >&2; echo "$out2" >&2; exit 1; }
[ ! -f "$TAP_HOME/reset.fence.json" ] || { echo "restore-partial: (2) fence not released" >&2; exit 1; }
# Without --again, a third bare restore (no fence) must still refuse already_restored.
set +e
out3="$("$TAP" team restore --archive "$BUNDLE" 2>&1)"
rc3=$?
set -e
[ "$rc3" != 0 ] || { echo "restore-partial: (3) second restore should need --again" >&2; echo "$out3" >&2; exit 1; }
[[ "$out3" == *already_restored* || "$out3" == *"already restored"* ]] \
  || { echo "restore-partial: (3) expected already_restored" >&2; echo "$out3" >&2; exit 1; }
unset TAP_BOOT_ID
echo "restore-partial-rerun: (2) post-restored_at resume + (3) --again still required: ok"
echo "restore-partial-rerun: ok"
