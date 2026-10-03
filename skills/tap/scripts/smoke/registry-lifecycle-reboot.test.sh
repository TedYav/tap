#!/usr/bin/env bash
# registry-lifecycle-reboot.test.sh — tap-w3op reboot vs shutdown.
# CONTRACT §Registry lifecycle — reboot vs shutdown:
#   (1) post-reset acting registry is blank (seats PRESENT-as-{}) and resolve=live
#   (2) populated shutdown deletes registry + DE-ENROLS (H1, f4adce470), retains
#       sidecar lock; resolve answers live_unenrolled with no location
#   (2b) COMPOSITION reset→shutdown deletes blank registry + consumes generation
#        (doctor LOST door — not deliberate-reset)
#   (3) tap init with TMUX unset recreates at STORED location
#   (4) doctor discriminator both directions (pristine vs lost)
#   (5) COMPOSITION relocated registry_location: shutdown→init writes stored path
#   (5b) COMPOSITION relocated registry_location: reset checkpoints+blanks stored path
#   (5c) init live_unreachable preserves enrolled alias (≠ basename)
#   (6) accepted */tmp/tap layout gets blank reboot rewrite
#   (7) shutdown retains lock inode (queued-writer identity)
#   (8) overview discovery; detailed help names delete + tap init + --keep-self
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
SCRIPTS="$ROOT/skills/tap/scripts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "registry-lifecycle-reboot: $*" >&2; exit 1; }

TEAM="$WORK/ExpireStaleSessions"
ACTING="$TEAM/.tap/team-registry.json"
BUS="$TEAM/.tap/bus"
export HOME="$WORK"
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$BUS"
export TAP_SCRATCH_ONLY="$WORK"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$BUS/tmp" "$TAP_INDEX_HOME" "$TEAM"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"

plant_enrolled() {
  # plant_enrolled <root> <registry_location> [enrolled_team_key] [acting_name]
  # acting_name: when given, the ACTING + BUS registries carry that
  # name while the machine-index KEY stays <enrolled_team_key>. Without it all
  # three carry the same value, so a consumer reading the WRONG source is
  # indistinguishable from one reading the right source.
  local root="$1" loc="$2" team_key="${3:-}" acting_name="${4:-}" gpath="$TAP_INDEX_HOME/global-registry.json"
  [ -n "$team_key" ] || team_key="$(basename "$root")"
  [ -n "$acting_name" ] || acting_name="$team_key"
  python3 -B - "$gpath" "$loc" "$root" "$team_key" "$acting_name" <<'PY'
import json, os, sys, time
gpath, treg, root, team, acting = sys.argv[1:6]
os.makedirs(os.path.dirname(treg), exist_ok=True)
json.dump({
  "schema": "0.20",
  "team": {"name": acting, "worktree_root": root},
  "seats": {
    "fable": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "inst-KEEP-w3op",
    },
  },
}, open(treg, "w"), indent=2)
open(treg + ".lock", "a+").write("lock\n")
bus = os.path.join(root, ".tap", "bus", "registry.json")
os.makedirs(os.path.dirname(bus), exist_ok=True)
json.dump({"schema": "0.20", "team": {"name": acting}, "seats": {}}, open(bus, "w"), indent=2)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {
    team: {
      "root": root,
      "registry_location": treg,
      "state": "registered",
    },
  },
}, open(gpath, "w"), indent=2)
PY
}

plant_enrolled "$TEAM" "$ACTING"

resolve_status() {
  "${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/python-closure-cli.ts" registry-status "$TEAM"
}

FAKE_BIN="$WORK/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
exit 1
TMUX
chmod +x "$FAKE_BIN/tmux"

# --- (8) overview discovery and detailed shutdown semantics ---
help_out="$("$TAP" help 2>&1)" || fail "(8) overview help failed"
grep -qF 'tap team down · up · shutdown' <<<"$help_out" \
  || fail "(8) overview missing grouped team lifecycle"
help_shutdown="$("$TAP" help team shutdown 2>&1)" || fail "(8) shutdown help failed"
grep -qi 'DELETES its acting registry' <<<"$help_shutdown" \
  || fail "(8) shutdown help must describe registry deletion"
grep -qF 'requires `tap init`' <<<"$help_shutdown" \
  || fail "(8) shutdown help must require tap init"
grep -qF -- '--keep-self spares the' <<<"$help_shutdown" \
  || fail "(8) shutdown help must explain --keep-self"
grep -qF "caller's session and retains spared seats in-file" <<<"$help_shutdown" \
  || fail "(8) shutdown help must preserve spared caller seats"
grep -qi 'unregister seats' <<<"$help_shutdown" \
  && fail "(8) shutdown help must not say unregister seats"
echo "registry-lifecycle-reboot: (8) overview discovery and detailed shutdown help: ok"


# ── tap-52ys: 10 of 14 arms removed (ratified 2026-08-14) ───────────────────
# grok's ≤4, after the sweep priced this at 19.5s rather than free. The four
# are the distinct lifecycle states: reset leaves a BLANK acting registry while
# resolve stays live, populated shutdown DELETES it and retains the lock,
# doctor discriminates the two directions, and an illegal enrolled name fails
# closed rather than writing a broken registry.
#
# tap-9tqt (lifecycle verbs) is next in the build order and will bring its own
# coverage; this is deliberately the minimum that keeps reset/shutdown honest
# in the meantime.
#
# Accepted gap, named: top-level help, the reset→shutdown and relocated-location
# compositions, init-with-TMUX-unset, the enrolled-alias preservation, the
# legacy tmp/tap layout, the queued-writer lock-inode identity, and the legal
# basename complement.

# --- (1) reset leaves blank acting registry; resolve stays live ---
out="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)" \
  || { echo "$out" >&2; fail "(1) team reset failed"; }
[ -f "$ACTING" ] || fail "(1) acting registry missing after reset (CONTRACT reboot)"
python3 -B - "$ACTING" "$TEAM" <<'PY' || fail "(1) blank registry shape wrong"
import json, os, sys
reg = json.load(open(sys.argv[1]))
root = os.path.realpath(sys.argv[2])
assert reg.get("schema") == "0.20", reg
assert isinstance(reg.get("seats"), dict) and reg["seats"] == {}, reg
assert (reg.get("team") or {}).get("name") == "ExpireStaleSessions", reg
assert os.path.realpath((reg.get("team") or {}).get("worktree_root") or "") == root, reg
PY
read -r st loc < <(resolve_status | { read -r a; read -r b; printf '%s %s\n' "$a" "$b"; })
[ "$st" = "ok" ] || fail "(1) resolve expected ok after reset, got $st"
[ -f "$BUS/reset-generation.json" ] || fail "(1) reset-generation.json missing"
python3 -B - "$BUS/reset-generation.json" <<'PY' || fail "(1) generation not pristine"
import json, sys
assert json.load(open(sys.argv[1])).get("state") == "pristine"
PY
echo "registry-lifecycle-reboot: (1) post-reset blank + resolve live: ok"

# --- (2) populated shutdown deletes; retains lock ---
python3 -B - "$ACTING" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["seats"] = {"fable": {"status": "active", "delivery": "poll", "harness": "claude"}}
json.dump(reg, open(sys.argv[1], "w"), indent=2)
PY
PATH="$FAKE_BIN:$PATH" "$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 \
  || fail "(2) team shutdown failed"
[ ! -e "$ACTING" ] || fail "(2) acting registry survived shutdown"
[ -e "$ACTING.lock" ] || fail "(2) sidecar lock must be retained"
read -r st2 loc2 < <(resolve_status | { read -r a; read -r b; printf '%s %s\n' "$a" "$b"; })
# H1 (f4adce470): a successful full shutdown also de-enrolls the team from the
# machine index, so native resolution answers missing and returns NO location
# — the stored-location reply was the pre-H1 contract.
[ "$st2" = "missing" ] || fail "(2) resolve expected missing, got $st2"
[ -z "$loc2" ] || fail "(2) live_unenrolled must not return a registry location: '$loc2'"
echo "registry-lifecycle-reboot: (2) populated shutdown deletes + retains lock: ok"

# --- (4) doctor discriminator both directions ---
# (4a) lost: no generation
rm -f "$BUS/reset-generation.json"
set +e
lost_out="$(cd "$TEAM" && TAP_HOME="$BUS" "$TAP" doctor 2>&1)"
lost_rc=$?
set -e
[ "$lost_rc" -ne 0 ] || fail "(4a) doctor must exit non-zero when lost: $lost_out"
grep -q 'acting_registry_unreachable' <<<"$lost_out" \
  || fail "(4a) must name acting_registry_unreachable: $lost_out"
grep -qi 'deliberate reset' <<<"$lost_out" \
  && fail "(4a) lost must NOT claim deliberate reset: $lost_out"
grep -q 'tap init' <<<"$lost_out" \
  || fail "(4a) LOST door must name tap init: $lost_out"
# Class (a) review item 3: lost/shutdown door must not advertise restore.
grep -qi 'restore' <<<"$lost_out" \
  && fail "(4a) LOST door must NOT advertise restore: $lost_out"

# (4b) deliberate reset residue: pristine generation + missing acting
printf '%s\n' '{"bundle_id":"demo-bundle","state":"pristine"}' > "$BUS/reset-generation.json"
set +e
reset_out="$(cd "$TEAM" && TAP_HOME="$BUS" "$TAP" doctor 2>&1)"
reset_rc=$?
set -e
[ "$reset_rc" -ne 0 ] || fail "(4b) doctor must exit non-zero on reset residue: $reset_out"
grep -qi 'deliberate reset' <<<"$reset_out" \
  || fail "(4b) must name deliberate reset: $reset_out"
grep -qiE 'do not restore|not restore' <<<"$reset_out" \
  || fail "(4b) must warn against restore: $reset_out"
echo "registry-lifecycle-reboot: (4) doctor discriminator both doors: ok"

# --- (9) reset fail-closed on a charset-illegal ENROLLED NAME (tap-kewz) ------
# The "Loud else" in tap_reset_finish_cut refuses rather than silently skipping
# the reboot write. A gate mutation reverted it to a no-op and the
# whole suite stayed green, so it was correct-but-unpinned.
#
# WHAT ACTUALLY REACHES IT — corrected during tap-kewz, because the original
# bead named the wrong route. The blank-write name comes from
# enrolled_team_name_for_root, with basename ONLY as a fallback, and that
# fallback is unreachable: reset requires resolve=live, which requires an "ok"
# enrolled entry, which by construction yields a non-empty enrolled name. A
# renamed worktree therefore does NOT trip this arm (pinned as 9b). The live
# route is a hand-edited / corrupted index carrying a charset-illegal team KEY,
# which resolves live and hands reset a name it cannot write.
BADK="$WORK/kewz-illegal-key"
mkdir -p "$BADK/.tap/bus/payloads" "$BADK/.tap/bus/receipts" "$BADK/.tap/bus/tmp"
# The machine-index KEY is the illegal one; acting + bus carry a
# LEGAL and DISTINCT name, so this guard can fire ONLY if reset read
# enrolled_team_name_for_root. With all three equal the case passed for the
# wrong reason: a regression to the pre-cut acting TEAM_NAME stayed green.
plant_enrolled "$BADK" "$BADK/.tap/team-registry.json" "bad name" "legalacting"
set +e
kewz_out="$(TAP_HOME="$BADK/.tap/bus" "$TAP" team reset --yes 2>&1)"; kewz_rc=$?
set -e
[ "$kewz_rc" -ne 0 ] || fail "(9) reset with a charset-illegal enrolled name must FAIL, got rc=0: $kewz_out"
grep -q 'reset_partial' <<<"$kewz_out" \
  || fail "(9) refusal must be classed reset_partial: $kewz_out"
grep -q 'fails charset' <<<"$kewz_out" \
  || fail "(9) refusal must name the charset that rejected the name: $kewz_out"
# Fail-closed means the blank write did NOT happen and the cut is NOT declared
# finished: a pristine stamp here would tell a later doctor this was a clean
# deliberate reset and route the operator to tap init on a team that has none.
[ ! -f "$BADK/.tap/team-registry.json" ] \
  || fail "(9) refusing reset must not leave an acting registry behind"
if [ -f "$BADK/.tap/bus/reset-generation.json" ]; then
  python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("state")!="pristine" else 1)' \
    "$BADK/.tap/bus/reset-generation.json" \
    || fail "(9) refusing reset must NOT stamp generation pristine"
fi
echo "registry-lifecycle-reboot: (9) illegal enrolled name fails closed (reset_partial, no blank, no pristine): ok"

echo "registry-lifecycle-reboot: ok"
