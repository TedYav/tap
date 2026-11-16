#!/usr/bin/env bash
# bun-cwd-autoload.test.sh — TAP's entry points never let Bun treat the caller's
# directory as its project. Bun's default config is $PWD/bunfig.toml, whose
# preload scripts run before the entry file, and it loads $PWD/.env. bin/tap and
# the hook adapters run in whatever directory the user or an agent is working
# in, so a project's files must not run code in, or set variables for, TAP.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
WORK="$(cd -P "$WORK" && pwd)"
FIXTURE="$WORK/repo"
PROJECT="$WORK/project"
HOME_FIXTURE="$WORK/home"
MARK="$WORK/preload-ran"

fail() { echo "bun-cwd-autoload: $1" >&2; exit 1; }
cleanup() {
  case "$WORK" in
    /tmp/*|/private/tmp/*|/var/folders/*)
      rm -rf "${WORK:?}"
      ;;
  esac
}
trap cleanup EXIT

BUN="$(command -v bun)" || fail "bun is required on PATH"
RUN_PATH="$(dirname "$BUN"):/bin:/usr/bin"

# The real shell doors, over entry files that only report what reached them.
mkdir -p "$FIXTURE/bin" "$FIXTURE/hooks" "$FIXTURE/runtime/bun/src/recovery" "$PROJECT" "$HOME_FIXTURE"
cp "$ROOT/bin/tap" "$FIXTURE/bin/tap"
cp "$ROOT"/hooks/tap-advisory.sh "$ROOT"/hooks/tap-codex-session-start.sh "$ROOT"/hooks/tap-cursor-session-start.sh \
  "$ROOT"/hooks/tap-agy-identity.sh "$ROOT"/hooks/tap-shell-body-guard.sh "$ROOT"/hooks/tap-claude-permission.sh "$FIXTURE/hooks/"
[ ! -f "$ROOT/runtime/bun/tap-bunfig.toml" ] || cp "$ROOT/runtime/bun/tap-bunfig.toml" "$FIXTURE/runtime/bun/tap-bunfig.toml"
ENTRY='process.stdout.write("entry-ran probe=" + (process.env.TAP_AUTOLOAD_PROBE ?? "unset") + "\n");'
for entry in runtime/bun/main.ts runtime/bun/src/session-start.ts runtime/bun/src/agy-identity-hook.ts \
  runtime/bun/src/debug.ts runtime/bun/src/debug-capture.ts runtime/bun/src/recovery/artifacts.ts hooks/tap-shell-body-guard.ts; do
  printf '%s\n' "$ENTRY" > "$FIXTURE/$entry"
done
# The PermissionRequest adapter discards its entry's stdout, because Claude reads a
# decision there. Its entry reports on stderr, which the adapter passes on.
printf '%s\n' "${ENTRY/process.stdout/process.stderr}" > "$FIXTURE/runtime/bun/src/claude-permission-hook.ts"

# A project as a stranger could ship it: a preload that leaves a marker, and a
# .env that sets a TAP_* variable the user never exported.
printf 'import { writeFileSync } from "node:fs";\nwriteFileSync(%s, "preload executed\\n");\n' "\"$MARK\"" > "$PROJECT/preload.ts"
# The relative path is spelled in two parts: the publish closure scan reads a
# literal relative path in a test as a file the test needs.
printf 'preload = ["./%s"]\n' preload.ts > "$PROJECT/bunfig.toml"
printf 'TAP_AUTOLOAD_PROBE=from-project-dotenv\n' > "$PROJECT/.env"

in_project() {
  ( cd "$PROJECT" && env -u BUN_INSTALL -u TAP_AUTOLOAD_PROBE -u TAP_STATELESS HOME="$HOME_FIXTURE" PATH="$RUN_PATH" "$@" )
}

# Control: the instrument can see the hazard. A bare Bun started in the project
# runs the preload and receives the variable; without this, the absence checks
# below would pass on a fixture that could never fail.
control="$(in_project "$BUN" "$FIXTURE/runtime/bun/main.ts" 2>&1)" || fail "control: bare bun failed: $control"
[ -f "$MARK" ] || fail "control: a bare bun in the project did not run the bunfig preload; this fixture cannot detect the hazard"
case "$control" in *"probe=from-project-dotenv"*) ;; *) fail "control: a bare bun in the project did not load .env: $control" ;; esac
rm -f "${MARK:?}"

check() {
  local label="$1" out rc=0
  shift
  out="$(in_project "$@" 2>&1 </dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || fail "$label: exit $rc: $out"
  [ ! -e "$MARK" ] || fail "$label: the project's bunfig.toml preload ran"
  case "$out" in
    *"probe=unset"*) ;;
    *"probe=from-project-dotenv"*) fail "$label: the project's .env reached TAP: $out" ;;
    *) fail "$label: the entry file did not run: $out" ;;
  esac
}

check "tap --version"            /bin/bash "$FIXTURE/bin/tap" --version
check "tap help debug"           /bin/bash "$FIXTURE/bin/tap" help debug
check "tap debug recovery"       /bin/bash "$FIXTURE/bin/tap" debug recovery
check "tap debug _attempt"       /bin/bash "$FIXTURE/bin/tap" debug _attempt
check "claude session-start"     /bin/bash "$FIXTURE/hooks/tap-advisory.sh"
check "codex session-start"      /bin/bash "$FIXTURE/hooks/tap-codex-session-start.sh"
check "cursor session-start"     /bin/bash "$FIXTURE/hooks/tap-cursor-session-start.sh"
check "antigravity identity"     /bin/bash "$FIXTURE/hooks/tap-agy-identity.sh"
check "shell-body guard"         /bin/bash "$FIXTURE/hooks/tap-shell-body-guard.sh"
check "claude permission-request" /bin/bash "$FIXTURE/hooks/tap-claude-permission.sh"

# Bun exits on a config path it cannot read: a checkout without the shipped
# config must still run tap, and still without the project's files.
rm -f "${FIXTURE:?}/runtime/bun/tap-bunfig.toml"
check "tap --version, config file absent" /bin/bash "$FIXTURE/bin/tap" --version

# The shipped doors themselves, end to end, from the same project: the real
# command, and the PreToolUse guard exactly as hooks/hooks.json registers it (the
# shell-first .ts entry, which hands over to the .sh adapter). Only the marker is
# observable here; the fixture runs above cover the variable.
real_door() {
  local label="$1" rc=0
  shift
  in_project "$@" >/dev/null 2>&1 </dev/null || rc=$?
  [ ! -e "$MARK" ] || fail "$label: the project's bunfig.toml preload ran"
  printf '%s' "$rc"
}
rc="$(real_door "real tap --version" /bin/bash "$ROOT/bin/tap" --version)"
[ "$rc" = 0 ] || fail "real tap --version: exit $rc"
real_door "real PreToolUse guard entry" "$ROOT/hooks/tap-shell-body-guard.ts" >/dev/null

echo "bun-cwd-autoload: ok"
