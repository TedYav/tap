#!/usr/bin/env bash
# hook-failsafe-contract.test.sh — a TAP hook never blocks or fails the host agent.
#
# The hooks are installed user-level, so they run in every agent session and on every shell
# command on the machine, including in projects that never used TAP. The contract this file
# pins, for every hook entry point a harness can be told to run: whatever is wrong with TAP, the hook exits 0
# within a bound, prints nothing a harness could read as a decision or as model context, and
# says at most one line that names TAP and how to repair it. A Bun stack trace is not that line.
#
# Faults, each run against every entry point:
#   (1) no Bun on the agent's PATH;
#   (2) a checkout whose Bun entry files carry a syntax error;
#   (3) a checkout whose Bun entry files are gone;
#   (4) TAP state the hook cannot read.
# Entry points are found by glob rather than listed, so a new adapter is covered on the day it
# is added. A helper that adapters source belongs outside that glob or without its exec bit.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
LOCKED="$WORK/locked-state"
cleanup() {
  # The unreadable-state fault leaves a mode-000 directory; open it so the removal can descend.
  if [ -d "$LOCKED" ]; then chmod 700 "$LOCKED" || true; fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "hook-failsafe-contract: FAIL $*" >&2; exit 1; }

BOUND_S=20        # generous: this is the fail-safe bound, not a latency budget
STDOUT_MAX=2048
# A Bun installer location must not rescue the no-Bun fault.
unset BUN_INSTALL
command -v bun >/dev/null 2>&1 || fail "this test needs bun on PATH to exercise the broken-checkout faults"

# --- entry points and the static half of the contract ---------------------------------------
HOOKS=()
for candidate in "$ROOT"/hooks/tap-*.sh; do
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then HOOKS+=("${candidate##*/}"); fi
done
[ "${#HOOKS[@]}" -gt 0 ] || fail "no executable hooks/tap-*.sh entry point found under $ROOT"

# A checkout registers the guard's .ts file itself as the hook command, so that file is an
# entry point too: run directly it must hand over to the shell door, never need Bun to start.
GUARD_ASSIGNED=0
while IFS= read -r registered; do
  [ -n "$registered" ] || continue
  GUARD_ASSIGNED=1
  [ -f "$ROOT/hooks/$registered" ] && [ -x "$ROOT/hooks/$registered" ] || fail "install.sh registers hooks/$registered, which is not an executable file"
  case " ${HOOKS[*]} " in *" $registered "*) ;; *) HOOKS+=("$registered") ;; esac
done < <(sed -n 's/^[[:space:]]*TAP_SHELL_BODY_GUARD="\$REPO\/hooks\/\([^"]*\)"$/\1/p' "$ROOT/install.sh")
[ "$GUARD_ASSIGNED" = 1 ] || fail "install.sh no longer assigns TAP_SHELL_BODY_GUARD from hooks/; update this check"
case " ${HOOKS[*]} " in *" tap-shell-body-guard.ts "*) ;; *) fail "the guard's directly registered .ts entry is not under test" ;; esac
if head -n 1 "$ROOT/hooks/tap-shell-body-guard.ts" | grep -q 'bun'; then
  fail "hooks/tap-shell-body-guard.ts starts with a Bun shebang; registered directly, it cannot start without Bun"
fi
# With a shell shebang the whole file is a shell script to any parse sweep, not only its first
# lines: it must parse as shell from top to bottom.
sh -n "$ROOT/hooks/tap-shell-body-guard.ts" || fail "hooks/tap-shell-body-guard.ts does not parse as shell (sh -n)"
echo "hook-failsafe-contract: ${#HOOKS[@]} entry points (${HOOKS[*]}), every guard command install.sh registers included: ok"

# --- fixtures -------------------------------------------------------------------------------
printf '%s\n' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' > "$WORK/payload-guard.json"
printf '%s\n' '{}' > "$WORK/payload-other.json"
CWD="$WORK/cwd"; NOBUN_HOME="$WORK/nobun-user"
mkdir -p "$CWD" "$NOBUN_HOME"

# (1) A PATH with the system tools and no Bun.
NOBUN="/usr/bin:/bin:/usr/sbin:/sbin"
NOBUN_ARM=1
if PATH="$NOBUN" command -v bun >/dev/null 2>&1; then
  # Bun lives in a system directory here: mirror those directories without it.
  FARM="$WORK/nobun-bin"; mkdir -p "$FARM"
  ln -sf /usr/bin/* "$FARM/"
  ln -sf /bin/* "$FARM/"
  rm -f "${FARM:?}/bun"
  NOBUN="$FARM"
  if PATH="$NOBUN" command -v bun >/dev/null 2>&1; then NOBUN_ARM=0; fi
fi

# (2) A checkout whose entry files do not parse.
SYNTAX="$WORK/syntax-clone"
mkdir -p "$SYNTAX/runtime/bun/src"
cp -R "$ROOT/hooks" "$SYNTAX/hooks"
for entry in session-start shell-body-guard agy-identity-hook claude-permission-hook; do
  printf '%s\n' 'export const x = ;' > "$SYNTAX/runtime/bun/src/$entry.ts"
done

# (3) A checkout with its hooks and no runtime at all.
MISSING="$WORK/missing-clone"
mkdir -p "$MISSING"
cp -R "$ROOT/hooks" "$MISSING/hooks"

# (4) State roots the hook cannot read.
mkdir -p "$LOCKED"
chmod 000 "$LOCKED"

# --- one run, one verdict -------------------------------------------------------------------
# run_case <fault> <hooks dir> <hook name> [NAME=value ...]: starts the hook the way a harness
# does (the registered file, payload on stdin from a file, stdout and stderr captured apart),
# times that process alone, and checks the contract. Extra arguments are the fault's environment.
RUNS=0
run_case() {
  local fault="$1" dir="$2" name="$3"; shift 3
  local payload="$WORK/payload-other.json" start rc elapsed out err out_bytes
  if [ "${name%.*}" = tap-shell-body-guard ]; then payload="$WORK/payload-guard.json"; fi
  [ -x "$dir/$name" ] || fail "$fault $name: $dir/$name is not executable"
  start=$SECONDS
  set +e
  ( cd "$CWD" && exec env "$@" "$dir/$name" <"$payload" >"$WORK/out" 2>"$WORK/err" )
  rc=$?
  set -e
  elapsed=$((SECONDS - start))
  out="$(cat "$WORK/out")"; err="$(cat "$WORK/err")"
  out_bytes="$(wc -c <"$WORK/out")"; out_bytes=$((out_bytes))

  [ "$rc" = 0 ] || fail "$fault $name: exit $rc, want 0; stderr: $err"
  [ "$elapsed" -lt "$BOUND_S" ] || fail "$fault $name: took ${elapsed}s, bound ${BOUND_S}s"
  [ "$out_bytes" -lt "$STDOUT_MAX" ] || fail "$fault $name: $out_bytes bytes of stdout, bound $STDOUT_MAX"
  case "$err" in *$'\n'*) fail "$fault $name: more than one line of stderr: $err" ;; esac
  case "$err" in ''|'tap: '*) ;; *) fail "$fault $name: stderr does not name TAP: $err" ;; esac
  case "$err" in *'Bun v'*|*'error:'*) fail "$fault $name: stderr carries a Bun error: $err" ;; esac
  if [ "$fault" != unreadable-state ]; then
    # TAP could not run: nothing may reach the harness as a decision or as context.
    [ -z "$out" ] || [ "$out" = '{}' ] || fail "$fault $name: stdout while TAP is broken: $out"
  fi
  case "$fault" in
    syntax-error|missing-module)
      [ -n "$err" ] || fail "$fault $name: broken checkout and no line saying so"
      case "$err" in *install.sh*) ;; *) fail "$fault $name: the line names no repair (install.sh): $err" ;; esac ;;
    no-bun)
      if [ "${name%.*}" = tap-shell-body-guard ]; then
        [ -n "$err" ] || fail "$fault $name: the guard allowed without saying TAP is not running"
      fi ;;
  esac
  RUNS=$((RUNS + 1))
}

if [ "$NOBUN_ARM" = 1 ]; then
  for name in "${HOOKS[@]}"; do
    run_case no-bun "$ROOT/hooks" "$name" PATH="$NOBUN" HOME="$NOBUN_HOME"
  done
  echo "hook-failsafe-contract: (1) no Bun on PATH: every hook exits 0, quiet stdout, at most one TAP line: ok"
else
  echo "hook-failsafe-contract: (1) SKIP — NO-BUN ARM DID NOT RUN: bun is still reachable through $NOBUN" >&2
  echo "hook-failsafe-contract: (1) SKIP — NO-BUN ARM DID NOT RUN (see stderr)"
fi

for name in "${HOOKS[@]}"; do
  run_case syntax-error "$SYNTAX/hooks" "$name"
done
echo "hook-failsafe-contract: (2) syntax error in the checkout: exit 0, one TAP line naming install.sh, no stack: ok"

for name in "${HOOKS[@]}"; do
  run_case missing-module "$MISSING/hooks" "$name"
done
echo "hook-failsafe-contract: (3) entry files missing from the checkout: exit 0, one TAP line naming install.sh: ok"

for name in "${HOOKS[@]}"; do
  run_case unreadable-state "$ROOT/hooks" "$name" TAP_INDEX_HOME="$LOCKED" TAP_HOME="$LOCKED" CLAUDE_PROJECT_DIR="$CWD"
done
echo "hook-failsafe-contract: (4) unreadable state directory: exit 0, bounded output: ok"

if [ "$NOBUN_ARM" = 1 ]; then
  echo "hook-failsafe-contract: all checks passed ($RUNS runs: ${#HOOKS[@]} entry points x 4 faults)"
else
  echo "hook-failsafe-contract: checks passed with the no-Bun arm SKIPPED ($RUNS runs: ${#HOOKS[@]} entry points x 3 faults)"
fi
