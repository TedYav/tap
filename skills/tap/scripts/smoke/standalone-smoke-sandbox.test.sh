#!/usr/bin/env bash
# tap-bw8z: a smoke run directly from the shell receives the same four
# operator-state redirects as smoke-all. A deliberately unpinned control proves
# that the fixture can observe the real fallback writes this guard prevents.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
PIN_FILE="$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
HELPERS="$ROOT/skills/tap/scripts/smoke/helpers.sh"
PY="${TAP_PYTHON:-python3}"
# Unpinned HOME-write controls need a team outside system temporary roots.
# Keep scratch in the checkout's ignored tmp/ so enrollment reaches that effect.
mkdir -p "$ROOT/tmp"
WORK="$(mktemp -d "$ROOT/tmp/standalone-smoke-sandbox.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "standalone-smoke-sandbox: $*" >&2; exit 1; }

# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

[ -f "$PIN_FILE" ] || fail "missing sandbox pin carrier: $PIN_FILE"
[ -f "$HELPERS" ] || fail "missing helper carrier: $HELPERS"

FIXTURE_HOME="$WORK/home"
REAL_INDEX="$FIXTURE_HOME/.tap"
REAL_REG="$REAL_INDEX/global-registry.json"
REAL_SEEN="$REAL_INDEX/version-seen.json"
CLEAN_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$REAL_INDEX" "$WORK/tmp"

# Observe the fallback stores without creating them. ABSENT detects creation,
# while a before-image hash detects modification of an existing store.
canary_image() { if [ -e "$1" ]; then shasum -a 256 "$1" | awk '{print $1}'; else printf ABSENT; fi; }
REGISTRY_BEFORE="$(canary_image "$REAL_REG")"
SEEN_BEFORE="$(canary_image "$REAL_SEEN")"

[ ! -e "$REAL_REG" ] && [ ! -e "$REAL_SEEN" ] \
  || fail "reference canary pre-populated a HOME fallback store"

make_team() {
  local root="$1"
  mkdir -p "$root"
  git -C "$root" init -q
  git -C "$root" config user.email "tap@test"
  git -C "$root" config user.name "tap"
  git -C "$root" commit --allow-empty -qm init
}

# A representative direct carrier must redirect both machine-wide writes:
# enrollment and version-seen. It also records all four resolved paths so this
# is a behavioral check of the pin file, not merely a source-text inventory.
PINNED_TEAM="$WORK/standalone-pinned"
PINNED_STATE="$WORK/pinned-state"
make_team "$PINNED_TEAM"
cat >"$WORK/pinned-carrier.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=sandbox-pins.sh
. "$PIN_FILE"
pin_root="${TAP_INDEX_HOME%/index}"
[ "$TAP_SESSION_MANIFEST" = "$pin_root/sessions.json" ]
[ "$OPENCODE_DB_PATH" = "$pin_root/opencode.db" ]
[ "$TAP_VERSION_SEEN_PATH" = "$pin_root/version-seen.json" ]
printf '%s\n' \
  "$TAP_INDEX_HOME" \
  "$TAP_SESSION_MANIFEST" \
  "$OPENCODE_DB_PATH" \
  "$TAP_VERSION_SEEN_PATH" >"$PINNED_STATE"
cd "$PINNED_TEAM"
"$TAP" in pinned --delivery poll >/dev/null
SH
chmod +x "$WORK/pinned-carrier.sh"
env -i \
  HOME="$FIXTURE_HOME" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$WORK/tmp" \
  LANG=C \
  PIN_FILE="$PIN_FILE" \
  PINNED_STATE="$PINNED_STATE" \
  PINNED_TEAM="$PINNED_TEAM" \
  TAP="$TAP" \
  bash "$WORK/pinned-carrier.sh" \
  >"$WORK/pinned.out" 2>"$WORK/pinned.err" \
  || { cat "$WORK/pinned.err" >&2; fail "direct carrier did not run"; }
[ "$(canary_image "$REAL_REG")" = "$REGISTRY_BEFORE" ] \
  || fail "pinned carrier mutated the HOME global registry"
[ "$(canary_image "$REAL_SEEN")" = "$SEEN_BEFORE" ] \
  || fail "pinned carrier mutated the HOME version store"
[ "$(wc -l <"$PINNED_STATE" | tr -d ' ')" = 4 ] \
  || fail "pinned carrier did not resolve all four paths"
PINNED_INDEX="$(sed -n '1p' "$PINNED_STATE")"
# Born live: a pinned sandbox index home holds neither store, so first
# enrollment bootstraps global-registry.json rather than retired
# teams.json. The subject here is CONTAINMENT -- that the index landed in
# the sandbox and not the real HOME -- and the store it lands in is now
# the live one.
[ -f "$PINNED_INDEX/global-registry.json" ] \
  || fail "pinned carrier did not write its born-live sandbox index"
[ ! -f "$PINNED_INDEX/teams.json" ] \
  || fail "pinned carrier wrote retired teams.json into a fresh sandbox index"
echo "standalone-smoke-sandbox: direct carrier redirected all four paths: ok"

# The helper-only fleet must receive the same behavior, not merely match the
# source-text inventory. Enrollment exercises the two HOME stores after the
# helper indirection supplies all four exported paths.
HELPER_TEAM="$WORK/standalone-helper-pinned"
HELPER_STATE="$WORK/helper-state"
make_team "$HELPER_TEAM"
cat >"$WORK/helper-carrier.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=helpers.sh
. "$HELPERS"
pin_root="${TAP_INDEX_HOME%/index}"
[ "$TAP_SESSION_MANIFEST" = "$pin_root/sessions.json" ]
[ "$OPENCODE_DB_PATH" = "$pin_root/opencode.db" ]
[ "$TAP_VERSION_SEEN_PATH" = "$pin_root/version-seen.json" ]
printf '%s\n' \
  "$TAP_INDEX_HOME" \
  "$TAP_SESSION_MANIFEST" \
  "$OPENCODE_DB_PATH" \
  "$TAP_VERSION_SEEN_PATH" >"$HELPER_STATE"
cd "$HELPER_TEAM"
"$TAP" in helper-pinned --delivery poll >/dev/null
SH
chmod +x "$WORK/helper-carrier.sh"
env -i \
  HOME="$FIXTURE_HOME" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$WORK/tmp" \
  LANG=C \
  HELPERS="$HELPERS" \
  HELPER_STATE="$HELPER_STATE" \
  HELPER_TEAM="$HELPER_TEAM" \
  TAP="$TAP" \
  bash "$WORK/helper-carrier.sh" \
  >"$WORK/helper.out" 2>"$WORK/helper.err" \
  || { cat "$WORK/helper.err" >&2; fail "helper carrier did not run"; }
[ "$(canary_image "$REAL_REG")" = "$REGISTRY_BEFORE" ] \
  || fail "helper carrier mutated the HOME global registry"
[ "$(canary_image "$REAL_SEEN")" = "$SEEN_BEFORE" ] \
  || fail "helper carrier mutated the HOME version store"
[ "$(wc -l <"$HELPER_STATE" | tr -d ' ')" = 4 ] \
  || fail "helper carrier did not resolve all four paths"
HELPER_INDEX="$(sed -n '1p' "$HELPER_STATE")"
# Born live: a pinned sandbox index home holds neither store, so first
# enrollment bootstraps global-registry.json rather than retired
# teams.json. The subject here is CONTAINMENT -- that the index landed in
# the sandbox and not the real HOME -- and the store it lands in is now
# the live one.
[ -f "$HELPER_INDEX/global-registry.json" ] \
  || fail "helper carrier did not write its born-live sandbox index"
[ ! -f "$HELPER_INDEX/teams.json" ] \
  || fail "helper carrier wrote retired teams.json into a fresh sandbox index"
echo "standalone-smoke-sandbox: helper carrier redirected all four paths: ok"

# Explicit caller values remain authoritative, but an EMPTY value is not one for the
# four pins whose consumers fall back to the real HOME on empty (tap-zwh1): those are
# replaced by the sandbox. TAP_VERSION_SEEN_PATH has no such fallback and stays as given.
cat >"$WORK/explicit-overrides.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export TAP_INDEX_HOME="$WORK/explicit-index"
export OPENCODE_DB_PATH="$WORK/explicit-opencode.db"
export TAP_VERSION_SEEN_PATH="$WORK/explicit-seen.json"
# shellcheck source=sandbox-pins.sh
. "$PIN_FILE"
[ "$TAP_INDEX_HOME" = "$WORK/explicit-index" ]
[ "$OPENCODE_DB_PATH" = "$WORK/explicit-opencode.db" ]
[ "$TAP_VERSION_SEEN_PATH" = "$WORK/explicit-seen.json" ]
SH
chmod +x "$WORK/explicit-overrides.sh"
env -i \
  HOME="$FIXTURE_HOME" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$WORK/tmp" \
  PIN_FILE="$PIN_FILE" \
  WORK="$WORK" \
  bash "$WORK/explicit-overrides.sh" \
  || fail "pin defaults replaced explicit caller values"
echo "standalone-smoke-sandbox: explicit overrides preserved: ok"

# tap-zwh1: an empty pin is not a pin. With each of these exported EMPTY, the consumers
# fall back to the real HOME (~/.tap), so the carrier must replace it with a path inside
# its private sandbox root, never under the fixture's HOME. TAP_VERSION_SEEN_PATH is the
# documented exception: its consumer takes empty literally, so it stays as given.
cat >"$WORK/empty-pins.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export "$EMPTY_VAR="
# shellcheck source=sandbox-pins.sh
. "$PIN_FILE"
value="${!EMPTY_VAR}"
if [ "$EMPTY_VAR" = TAP_VERSION_SEEN_PATH ]; then
  [ -z "$value" ]
else
  [ -n "$value" ]
  case "$value" in "$TMPDIR"/tap-smoke-sandbox.*) : ;; *) exit 3 ;; esac
  case "$value" in "$HOME"/*) exit 4 ;; esac
fi
SH
for EMPTY_VAR in TAP_INDEX_HOME TAP_SESSION_MANIFEST OPENCODE_DB_PATH TAP_LOCK_DIR TAP_VERSION_SEEN_PATH; do
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="$CLEAN_PATH" \
    TMPDIR="$WORK/tmp" \
    PIN_FILE="$PIN_FILE" \
    EMPTY_VAR="$EMPTY_VAR" \
    bash "$WORK/empty-pins.sh" \
    || fail "an empty $EMPTY_VAR was not handled as specified (pinned into the sandbox, or left empty for VERSION_SEEN)"
done
echo "standalone-smoke-sandbox: empty pins replaced by the sandbox (VERSION_SEEN excepted): ok"

# A caller without set -e must terminate on failed sandbox allocation. A
# non-zero source status is insufficient: an ordinary caller can ignore it and
# continue into the HOME fallbacks this carrier exists to prevent.
FAIL_BIN="$WORK/failing-mktemp"
mkdir -p "$FAIL_BIN"
printf '%s\n' '#!/usr/bin/env bash' 'exit 23' >"$FAIL_BIN/mktemp"
chmod +x "$FAIL_BIN/mktemp"
for CARRIER_NAME in direct helpers; do
  case "$CARRIER_NAME" in
    direct) SOURCE_FILE="$PIN_FILE" ;;
    helpers) SOURCE_FILE="$HELPERS" ;;
  esac
  CONTINUED="$WORK/$CARRIER_NAME-continued"
  if env -i \
    HOME="$FIXTURE_HOME" \
    PATH="$FAIL_BIN:$CLEAN_PATH" \
    TMPDIR="$WORK/tmp" \
    SOURCE_FILE="$SOURCE_FILE" \
    CONTINUED="$CONTINUED" \
    bash -c '
      set -uo pipefail
      . "$SOURCE_FILE"
      : >"$CONTINUED"
    '
  then
    fail "$CARRIER_NAME carrier continued after failed sandbox allocation"
  fi
  [ ! -e "$CONTINUED" ] \
    || fail "$CARRIER_NAME carrier reached its post-source continuation"
done
echo "standalone-smoke-sandbox: failed allocation terminated both carriers: ok"

# Negative control: without either carrier, production fallbacks really do
# write both fixture HOME stores. This makes the no-write assertions above
# discriminating rather than vacuously green.
CONTROL_TEAM="$WORK/standalone-control"
make_team "$CONTROL_TEAM"
env -i \
  HOME="$FIXTURE_HOME" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$WORK/tmp" \
  LANG=C \
  TAP_PYTHON="$PY" \
  bash -c 'cd "$1"; "$2" in unpinned --delivery poll >/dev/null' \
  bash "$CONTROL_TEAM" "$TAP" \
  >"$WORK/control.out" 2>"$WORK/control.err" \
  || { cat "$WORK/control.err" >&2; fail "deliberately unpinned control failed"; }
! [ "$(canary_image "$REAL_REG")" = "$REGISTRY_BEFORE" ] \
  || fail "unpinned control did not mutate the HOME global registry"
! [ "$(canary_image "$REAL_SEEN")" = "$SEEN_BEFORE" ] \
  || fail "unpinned control did not mutate the HOME version store"
"$PY" -B - "$REAL_REG" "$REAL_SEEN" <<'PY' \
  || fail "unpinned control writes did not have the expected shape"
import json
import sys

registry = json.load(open(sys.argv[1], encoding="utf-8"))
seen = json.load(open(sys.argv[2], encoding="utf-8"))
assert "standalone-control" in registry["teams"], registry
assert "standalone-control/unpinned" in seen["seats"], seen
PY
echo "standalone-smoke-sandbox: unpinned control created HOME stores from ABSENT: ok"
# Existing-file mutation must also change the read-only image.
created_image="$(canary_image "$REAL_REG")"
printf '\n' >>"$REAL_REG"
[ "$(canary_image "$REAL_REG")" != "$created_image" ] || fail "canary missed existing-file modification"
echo "standalone-smoke-sandbox: ok"
