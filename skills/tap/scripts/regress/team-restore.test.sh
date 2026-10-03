#!/usr/bin/env bash
# team-restore.test.sh — restore a team-reset checkpoint (tap-9tqt).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"

seed_bus() {
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" "$TAP_HOME/input-backups"
  printf 'payload\n' > "$TAP_HOME/payloads/p1.md"
  printf 'receipt\n' > "$TAP_HOME/receipts/p1.done"
  printf 'sensitive\n' > "$TAP_HOME/input-backups/keep.md"
  # poll seat: reset-stop hard-gate must not invent a kill target
  printf '%s\n' '{"schema": "0.20", "team":{"name":"demo"},"seats":{"codex":{"status":"active","delivery":"poll","harness":"codex","pane":"stale:0.0","pane_id":"%99"}}}' \
    > "$TAP_HOME/registry.json"
  # Born live (F2a): restore checks the checkpoint's team against the enrolled
  # team, so the bus under test is the one enrolled "demo" root.
  printf '{"schema":"0.20","teams":{"demo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
    "$(cd "$TAP_HOME/../.." && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)/registry.json" > "${TAP_INDEX_HOME:?}/global-registry.json"
}

archive_from_output() {
  printf '%s\n' "$1" | sed -n 's/^tap team reset:   archive=//p' | tail -1
}

# 1. reset → restore: payloads back; rows strip-then-stamp restored_from_archive.
export TAP_HOME="$WORK/repo/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)" || { echo "team-restore: (1) reset failed" >&2; echo "$out" >&2; exit 1; }
arc="$(archive_from_output "$out")"
[ -n "$arc" ] || { echo "team-restore: (1) no archive" >&2; exit 1; }
rout="$("$TAP" team restore --archive "$(basename "$arc")" 2>&1)" \
  || { echo "team-restore: (1) restore failed" >&2; echo "$rout" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/p1.md" ] || { echo "team-restore: (1) payload not restored" >&2; exit 1; }
[ -f "$TAP_HOME/input-backups/keep.md" ] || { echo "team-restore: (1) input-backups not restored" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
ent = reg["seats"]["codex"]
assert ent.get("status") == "suspended", ent
assert ent.get("status_reason") == "restored_from_archive", ent
# delivery is a seat property — must survive restore (opus 101205 / WAVE 5).
assert ent.get("delivery") == "poll", ent
for k in ("pane", "pane_id", "wake_url", "exited_at"):
    assert k not in ent, f"stale pane binding {k} survived: {ent}"
PY
[[ "$rout" == *"tap team up"* ]] || { echo "team-restore: (1) receipt must name team up" >&2; echo "$rout" >&2; exit 1; }
echo "team-restore: 1/8 - restore strip-then-stamps and returns traffic: ok"

# 2. second restore refuses without --again (already_restored).
if out2="$("$TAP" team restore --archive "$(basename "$arc")" 2>&1)"; then
  echo "team-restore: (2) second restore should refuse" >&2; echo "$out2" >&2; exit 1
fi
[[ "$out2" == *"already restored"* || "$out2" == *"already_restored"* || "$out2" == *"generation"* ]] \
  || { echo "team-restore: (2) unexpected refusal" >&2; echo "$out2" >&2; exit 1; }
echo "team-restore: 2/8 - second restore refuses: ok"

# 3. dry-run mutates nothing on a fresh pristine bus.
export TAP_HOME="$WORK/dry/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
before="$(find "$TAP_HOME" -type f | LC_ALL=C sort | cksum)"
"$TAP" team restore --archive "$(basename "$arc")" --dry-run >/dev/null
after="$(find "$TAP_HOME" -type f | LC_ALL=C sort | cksum)"
[ "$before" = "$after" ] || { echo "team-restore: (3) dry-run mutated bus" >&2; exit 1; }
echo "team-restore: 3/8 - dry-run is zero-mutation: ok"

# 4. missing COMPLETE refuses; live agent rows refuse.
export TAP_HOME="$WORK/gates/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
rm -f "$arc/COMPLETE"
if outg="$("$TAP" team restore --archive "$(basename "$arc")" 2>&1)"; then
  echo "team-restore: (4a) incomplete should refuse" >&2; echo "$outg" >&2; exit 1
fi
# Recreate COMPLETE for live-state probe: fresh reset + inject live row.
export TAP_HOME="$WORK/gates2/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{"x":{"status":"active","delivery":"poll"}}}\n' > "$TAP_HOME/registry.json"
if outg="$("$TAP" team restore --archive "$(basename "$arc")" 2>&1)"; then
  echo "team-restore: (4b) live agents should refuse" >&2; echo "$outg" >&2; exit 1
fi
[[ "$outg" == *"live"* || "$outg" == *"pristine"* || "$outg" == *"agent"* ]] \
  || { echo "team-restore: (4b) unexpected refusal" >&2; echo "$outg" >&2; exit 1; }
echo "team-restore: 4/8 - incomplete/live-state gates refuse: ok"

# 5. archive selector: external same-basename COMPLETE-shaped dir + symlink escape.
export TAP_HOME="$WORK/escape/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
bid="$(basename "$arc")"
EXT="$WORK/external/$bid"
mkdir -p "$EXT/bus/payloads"
printf 'COMPLETE\n' > "$EXT/COMPLETE"
printf '{"kind":"team-reset","root":"%s"}\n' "$(cd "$WORK/escape" && pwd -P)" > "$EXT/meta.json"
printf '{"components":[]}\n' > "$EXT/inventory.json"
printf '{"root":"","sessions":[]}\n' > "$EXT/manifest-slice.json"
if oute="$("$TAP" team restore --archive "$EXT" 2>&1)"; then
  echo "team-restore: (5a) external path must refuse" >&2; echo "$oute" >&2; exit 1
fi
[[ "$oute" == *"escape"* || "$oute" == *"archive_escape"* || "$oute" == *"team-reset root"* ]] \
  || { echo "team-restore: (5a) expected archive_escape" >&2; echo "$oute" >&2; exit 1; }
# Symlink out of archive root with matching basename.
rm -rf "$TAP_HOME/archive/team-reset/$bid"
ln -s "$EXT" "$TAP_HOME/archive/team-reset/$bid"
if outs="$("$TAP" team restore --archive "$bid" 2>&1)"; then
  echo "team-restore: (5b) symlink escape must refuse" >&2; echo "$outs" >&2; exit 1
fi
[[ "$outs" == *"escape"* || "$outs" == *"archive_escape"* || "$outs" == *"team-reset root"* ]] \
  || { echo "team-restore: (5b) expected archive_escape on symlink" >&2; echo "$outs" >&2; exit 1; }
echo "team-restore: 5/8 - archive path escape/symlink refused: ok"

# 6. inventory set-equality: omit a classified zero-file component → refuse.
export TAP_HOME="$WORK/invomit/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
python3 -B - "$arc/inventory.json" <<'PY'
import json, sys
path = sys.argv[1]
inv = json.load(open(path))
# Drop one classified component (handoff is usually zero-file).
inv["components"] = [c for c in inv["components"] if c.get("name") != "handoff"]
open(path, "w").write(json.dumps(inv, indent=2) + "\n")
PY
# Fresh pristine bus for restore (generation still matches).
if outi="$("$TAP" team restore --archive "$(basename "$arc")" --json 2>&1)"; then
  echo "team-restore: (6) omit-one inventory must refuse" >&2; echo "$outi" >&2; exit 1
fi
# CLI part-10 requires complete inventory validation before publication.
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="inventory_mismatch", d' "$outi"
[ ! -e "$TAP_HOME/payloads/p1.md" ] || { echo "team-restore: refused inventory restored a payload" >&2; exit 1; }
echo "team-restore: 6/8 - inventory omit-one-member refuses: ok"

# 7. default selection: latest COMPLETE wrong-kind must not mask older team-reset.
export TAP_HOME="$WORK/latest/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
good="$(archive_from_output "$out")"
[ -n "$good" ] || { echo "team-restore: (7) no good archive" >&2; exit 1; }
# Lexically later basename with COMPLETE but wrong kind.
bad="$TAP_HOME/archive/team-reset/zzzz-wrong-kind-later"
mkdir -p "$bad/bus"
printf 'COMPLETE\n' > "$bad/COMPLETE"
printf '%s\n' '{"kind":"other","root":"x","source_bus":"y","team":"z"}' > "$bad/meta.json"
printf '{"components":[]}\n' > "$bad/inventory.json"
printf '{"root":"","sessions":[]}\n' > "$bad/manifest-slice.json"
# Default (no --archive) must pick the older team-reset, not the later wrong kind.
# Generation still names the good bundle — restore should accept that selection.
rout="$("$TAP" team restore 2>&1)" \
  || { echo "team-restore: (7) default restore failed (wrong-kind may have been selected)" >&2; echo "$rout" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/p1.md" ] \
  || { echo "team-restore: (7) traffic not restored — likely selected wrong-kind" >&2; echo "$rout" >&2; exit 1; }
echo "team-restore: 7/8 - default selection skips later wrong-kind COMPLETE: ok"

# 8. source_bus / team identity refusal (same forged root).
export TAP_HOME="$WORK/ident/.tap/bus"
seed_bus
out="$("$TAP" team reset --yes 2>&1)"
arc="$(archive_from_output "$out")"
root_real="$(cd "$WORK/ident" && pwd -P)"
# Forge: keep root matching live, but source_bus + team from another team.
python3 -B - "$arc/meta.json" "$root_real" <<'PY'
import json, sys
path, root = sys.argv[1], sys.argv[2]
meta = json.load(open(path))
meta["root"] = root
meta["source_bus"] = "/tmp/other-team/.tap/bus"
meta["team"] = "other-team"
open(path, "w").write(json.dumps(meta, indent=2) + "\n")
PY
if outi="$("$TAP" team restore --archive "$(basename "$arc")" --json 2>&1)"; then
  echo "team-restore: (8a) source_bus mismatch must refuse" >&2; echo "$outi" >&2; exit 1
fi
[[ "$outi" == *"source_bus"* || "$outi" == *"source_bus_mismatch"* ]] \
  || { echo "team-restore: (8a) expected source_bus_mismatch" >&2; echo "$outi" >&2; exit 1; }
# Team mismatch when a live registry still names the team (pre-restore inject).
python3 -B - "$arc/meta.json" "$TAP_HOME" "$root_real" <<'PY'
import json, sys
path, bus, root = sys.argv[1:4]
meta = json.load(open(path))
meta["root"] = root
meta["source_bus"] = bus
meta["team"] = "other-team"
open(path, "w").write(json.dumps(meta, indent=2) + "\n")
PY
printf '%s\n' '{"schema": "0.20", "team":{"name":"demo"},"seats":{}}' > "$TAP_HOME/registry.json"
# Empty agents satisfies live-state; generation still pristine for this bundle.
if outi="$("$TAP" team restore --archive "$(basename "$arc")" --json 2>&1)"; then
  echo "team-restore: (8b) team mismatch must refuse" >&2; echo "$outi" >&2; exit 1
fi
[[ "$outi" == *"team"* && ( "$outi" == *"mismatch"* || "$outi" == *"other-team"* ) ]] \
  || { echo "team-restore: (8b) expected team_mismatch" >&2; echo "$outi" >&2; exit 1; }
echo "team-restore: 8/8 - source_bus/team identity refuse: ok"

echo "team-restore: ok"
