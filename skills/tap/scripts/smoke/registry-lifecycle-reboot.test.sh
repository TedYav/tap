#!/usr/bin/env bash
# registry-lifecycle-reboot.test.sh — shutdown deletion and legacy doctor residue.
# Reset's retired checkpoint-cut assertions now live in the Bun reset contract.
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

echo "registry-lifecycle-reboot: ok"
