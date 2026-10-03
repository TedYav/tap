#!/usr/bin/env bash
# admin-refresh-ghost-purge.test.sh — tap-gmj0i checkpoint A (H1 ghost-teams
# hotfix), public regression. `tap admin refresh` must purge an enrolled team
# whose INDEXED acting registry path is positively observed missing, even when
# a legacy bus decoy (<root>/.tap/bus/registry.json) exists that used to read
# as healthy (the ghost-team mechanism). Present-but-unreadable,
# present-but-corrupt, and healthy teams stay cannot-check/untouched; `tap
# admin prune` stays the renamed verb. Everything here drives the PUBLIC door
# (`scripts/tap.sh admin|teams ...`), never tap-admin.sh internals.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK:?}"
  rm -rf "${FAKE_BIN:?}"
}
trap cleanup EXIT
export HOME="$WORK/home" TAP_INDEX_HOME="$WORK/index" PATH="$FAKE_BIN:$PATH"
mkdir -p "$HOME" "$TAP_INDEX_HOME" "$WORK/unrelated"

fail() { echo "admin-refresh-ghost-purge: $*" >&2; exit 1; }

# Mock tmux: nothing is ever live. No probe may observe a pane, so the only
# purge authority exercised is the index/registry-path observation itself.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) exit 1 ;;
  has-session) exit 1 ;;
  list-panes) exit 1 ;;
  display-message)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) printf '' ;;
      esac
      shift
    done
    ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

# --- six-team fixture (plan rev-3 U1 table + first-review control) under a live
# --- v0.20 marker -------------------------------------------------------------
# gone       root absent                        → dangling, purged (root_gone)
# ghost      root present, indexed acting path  → confirmed missing; legacy
#            absent (FileNotFoundError)           decoy present with one stale
#                                                 seat row and must NOT read
#                                                 as healthy
# corrupt    acting path present, invalid JSON  → cannot-check, never purged
# unreadable acting path present, mode 000      → cannot-check, never purged
# healthy    acting path present, valid, one    → untouched
#            pane-less (poll) seat
# nobus      acting path present + valid, root  → first-review A1 RED control:
#            has NEITHER .tap/bus NOR tmp/tap     the parse must read the
#                                                 INDEXED path, so the team is
#                                                 retained — never mis-classified
#                                                 registry_missing and purged
#                                                 (pre-fix, the post-rebind
#                                                 absent-bus check purged it)
for t in ghost corrupt unreadable healthy; do
  mkdir -p "$WORK/$t/.tap/bus/payloads" "$WORK/$t/.tap/bus/receipts"
done
mkdir -p "$WORK/nobus/.tap"

cat > "$WORK/ghost/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"ghost","worktree_root":"$WORK/ghost"},
 "seats":{"stale":{"status":"active","delivery":"pane","harness":"codex",
  "session":"ghost/stale","pane":"ghost/stale:0.0","pane_id":"%9",
  "server_epoch":"srv:1:1"}}}
JSON

printf '{ this is definitely not json' > "$WORK/corrupt/.tap/team-registry.json"

cat > "$WORK/unreadable/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"unreadable"},"seats":{}}
JSON
cp "$WORK/unreadable/.tap/team-registry.json" "$WORK/before-unreadable.cmp"
chmod 000 "$WORK/unreadable/.tap/team-registry.json"

cat > "$WORK/healthy/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"healthy","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{"poll":{"status":"active","delivery":"poll","harness":"claude",
  "registered_at":"t","pane":"","pane_id":""}}}
JSON

seed_index() {
  cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"migrated":"t","schema":"0.20","teams":{
 "gone":{"enrolled_at":"t","registry_location":"$WORK/gone/.tap/team-registry.json","root":"$WORK/gone","state":"registered"},
 "ghost":{"enrolled_at":"t","registry_location":"$WORK/ghost/.tap/team-registry.json","root":"$WORK/ghost","state":"registered"},
 "corrupt":{"enrolled_at":"t","registry_location":"$WORK/corrupt/.tap/team-registry.json","root":"$WORK/corrupt","state":"registered"},
 "unreadable":{"enrolled_at":"t","registry_location":"$WORK/unreadable/.tap/team-registry.json","root":"$WORK/unreadable","state":"registered"},
 "healthy":{"enrolled_at":"t","registry_location":"$WORK/healthy/.tap/team-registry.json","root":"$WORK/healthy","state":"registered"},
 "nobus":{"enrolled_at":"t","registry_location":"$WORK/nobus/.tap/team-registry.json","root":"$WORK/nobus","state":"registered"}
}}
JSON
}

# nobus: a valid acting store at the indexed path while the root has no bus
# directory at all — the indexed path is the only way this team can be read.
cat > "$WORK/nobus/.tap/team-registry.json" <<JSON
{"schema":"0.20","team":{"name":"nobus","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{"poll":{"status":"active","delivery":"poll","harness":"claude",
  "registered_at":"t","pane":"","pane_id":""}}}
JSON

for t in corrupt healthy nobus; do
  cp "$WORK/$t/.tap/team-registry.json" "$WORK/before-$t.cmp"
done
cp "$WORK/ghost/.tap/bus/registry.json" "$WORK/before-ghost-decoy.cmp"

# --- 1. dry-run JSON: purged[] names exactly gone and ghost ------------------
seed_index
set +e
dry_json="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin refresh --dry-run --json 2>"$WORK/dry.err")"
dry_rc=$?
set -e
python3 - "$dry_json" <<'PY' || fail "dry-run purged[] is wrong (see assertion above) — err: $(cat "$WORK/dry.err")"
import json, sys
d = json.loads(sys.argv[1])
purged = sorted(p["team"] for p in d["purged"])
assert purged == ["ghost", "gone"], d
assert not ({"corrupt", "unreadable", "healthy", "nobus"} & set(purged)), d
PY
echo "admin-refresh-ghost-purge: dry-run purges exactly gone and ghost, and none of corrupt/unreadable/healthy: ok"

# --- 2. real run: cannot-check for corrupt+unreadable (exit 1), index keeps
# exactly the three retained teams, present registry bytes unchanged ----------
set +e
real_json="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin refresh --json 2>"$WORK/real.err")"
real_rc=$?
set -e
[ "$real_rc" -eq 1 ] || fail "real refresh must exit 1 (cannot-check is the existing contract); got rc=$real_rc: $(cat "$WORK/real.err")"
python3 - "$real_json" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
assert sorted(d["cannot_check"]) == ["corrupt", "unreadable"], d
assert sorted(p["team"] for p in d["purged"]) == ["ghost", "gone"], d
# nobus: the A1 control — a present, valid, indexed acting store whose root has
# neither .tap/bus nor tmp/tap must be parsed/retained, never classified as
# unreadable (cannot_check) and never purged.
assert "nobus" not in d["cannot_check"], d
assert all(p["team"] != "nobus" for p in d["purged"]), d
PY
python3 - "$TAP_INDEX_HOME/global-registry.json" <<'PY'
import json, sys
teams = set((json.load(open(sys.argv[1])).get("teams") or {}))
assert teams == {"corrupt", "unreadable", "healthy", "nobus"}, sorted(teams)
PY
for t in corrupt healthy nobus; do
  cmp -s "$WORK/before-$t.cmp" "$WORK/$t/.tap/team-registry.json" \
    || fail "retained team '$t' acting registry bytes changed"
done
# unreadable is unobservable by design (mode 000): assert the mode and size are
# untouched rather than bytes — nothing readable may have been rewritten.
[ "$(stat -f '%Lp' "$WORK/unreadable/.tap/team-registry.json")" = "0" ] \
  || fail "retained team 'unreadable' acting registry mode changed"
[ "$(stat -f '%z' "$WORK/unreadable/.tap/team-registry.json")" = "$(stat -f '%z' "$WORK/before-unreadable.cmp")" ] \
  || fail "retained team 'unreadable' acting registry size changed"
cmp -s "$WORK/before-ghost-decoy.cmp" "$WORK/ghost/.tap/bus/registry.json" \
  || fail "ghost legacy bus decoy bytes changed"
echo "admin-refresh-ghost-purge: real run keeps corrupt/unreadable cannot-check (rc=1), trims the index to the three retained teams, and rewrites no registry bytes: ok"

# --- 3. tap teams --all: gone/ghost rows are gone, retained rows remain ------
set +e
teams_all="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" teams --all 2>&1)"
teams_rc=$?
set -e
[ "$teams_rc" -eq 0 ] || fail "'tap teams --all' failed (rc=$teams_rc): $teams_all"
for absent in gone ghost; do
  ! grep -q "^$absent " <<<"$teams_all" || fail "'tap teams --all' still renders purged team '$absent': $teams_all"
done
for present in corrupt unreadable healthy nobus; do
  grep -q "^$present " <<<"$teams_all" || fail "'tap teams --all' lost retained team '$present': $teams_all"
done
echo "admin-refresh-ghost-purge: 'tap teams --all' renders no purged row and keeps the retained teams (unknown cells allowed): ok"

# --- 4. text mode: the loud PURGED receipts ----------------------------------
seed_index
set +e
text_out="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin refresh --dry-run 2>&1)"
text_rc=$?
set -e
grep -qF "PURGED 'ghost'" <<<"$text_out" || fail "text mode lost the ghost PURGED receipt (rc=$text_rc): $text_out"
grep -qF "PURGED 'gone'" <<<"$text_out" || fail "text mode lost the gone PURGED receipt (rc=$text_rc): $text_out"
echo "admin-refresh-ghost-purge: text mode prints PURGED 'ghost' and PURGED 'gone': ok"

# --- 5. the Admin boundary: prune stays a renamed verb -----------------------
set +e
prune_out="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin prune 2>&1)"
prune_rc=$?
set -e
[ "$prune_rc" -ne 0 ] || fail "'tap admin prune' must stay non-zero (renamed_verb), got rc=0: $prune_out"
grep -qF "tap admin prune is now: tap admin refresh plus tap admin retire <team>" <<<"$prune_out" \
  || fail "'tap admin prune' output lost the renamed_verb hint: $prune_out"
echo "admin-refresh-ghost-purge: 'tap admin prune' still refuses as renamed_verb: ok"

# --- 6. `tap teams refresh` is a pure alias of `tap admin refresh` -----------
# Same seed, same purge set, same index trim — routed through the public Admin
# dispatch so the later Admin body cutover keeps one door (plan rev-3 U3).
seed_index
set +e
alias_json="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" teams refresh --json 2>"$WORK/alias.err")"
alias_rc=$?
set -e
[ "$alias_rc" -eq 1 ] || fail "'tap teams refresh' must inherit the admin refresh exit contract (1 on cannot-check); got rc=$alias_rc: $(cat "$WORK/alias.err")"
python3 - "$alias_json" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
assert sorted(p["team"] for p in d["purged"]) == ["ghost", "gone"], d
assert sorted(d["cannot_check"]) == ["corrupt", "unreadable"], d
assert "nobus" not in d["cannot_check"] and all(p["team"] != "nobus" for p in d["purged"]), d
PY
python3 - "$TAP_INDEX_HOME/global-registry.json" <<'PY'
import json, sys
teams = set((json.load(open(sys.argv[1])).get("teams") or {}))
assert teams == {"corrupt", "unreadable", "healthy", "nobus"}, sorted(teams)
PY
for t in corrupt healthy nobus; do
  cmp -s "$WORK/before-$t.cmp" "$WORK/$t/.tap/team-registry.json" \
    || fail "alias run rewrote retained team '$t' acting registry bytes"
done
echo "admin-refresh-ghost-purge: 'tap teams refresh --json' purges and trims identically to 'tap admin refresh --json': ok"

# --- 7/8. in-run race windows (first-review item 1) -----------------------------
# Cases 8 and 8b injected the gather-to-apply race through a python3 PATH shim
# keyed to the Bash de-enroll writer's argv. That writer is gone (B7c): refresh
# de-enrolls in process through index-home.ts, so there is no child process to
# intercept. The same two races (registry recreated; enrollment replaced) are
# controls in runtime/bun/test/admin.test.ts "refresh race: …", where a second
# process holds teams.json.lock until the writer has taken its sidecar lock.

# --- 9. successful guarded purge removes its capture artifact -----------------
seed_index
set +e
clean_json="$(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin refresh --json 2>"$WORK/clean.err")"
clean_rc=$?
set -e
[ "$clean_rc" -eq 1 ] || fail "clean refresh rc=$clean_rc (cannot-check contract): $(cat "$WORK/clean.err")"
python3 - "$clean_json" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
assert sorted(p["team"] for p in d["purged"]) == ["ghost", "gone"], d
PY
leftovers="$(ls "$TAP_INDEX_HOME/recovery/team-admin-refresh."* 2>/dev/null || true)"
[ -z "$leftovers" ] || fail "successful purge left capture artifacts behind: $leftovers"
echo "admin-refresh-ghost-purge: successful purge consumes its capture artifact: ok"

echo "admin-refresh-ghost-purge: ok"
