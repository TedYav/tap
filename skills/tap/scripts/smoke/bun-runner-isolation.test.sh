#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
WORK="$(mktemp -d /tmp/tap-br.XXXXXX)"
WORK="$(cd "$WORK" && pwd -P)"
FIXTURE="$WORK/repo"
RUNNER="$FIXTURE/runtime/bun/test/run.sh"
FIXTURE_MARKER="$FIXTURE/.tap/probe-marker"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/engine" "$WORK/guard" "$WORK/caller-home" "$WORK/outer-tmux" \
  "$FIXTURE/runtime/bun/test" "$FIXTURE/scripts"
cp "$ROOT/runtime/bun/test/run.sh" "$RUNNER"
cp "$ROOT/scripts/test-secret-env.sh" "$FIXTURE/scripts/test-secret-env.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"

# Attribution inputs read by verbs/register.ts and session-store.ts.
identity_names='CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID'
identity_env=()
for name in $identity_names; do identity_env+=("$name=ambient-session"); done
# tap-lcuft: a sixth spelling of operator state — a sentinel PATH the runner
# must strip, so `${CLAUDE_CONFIG_DIR:-~/.claude}` fallbacks land in scratch.
identity_env+=("CLAUDE_CONFIG_DIR=$WORK/ambient-claude-config")
# Focused tests must receive the gate's terminal, language and time zone even
# when the developer's shell uses different values.
identity_env+=(TERM=xterm-256color LANG=ambient-language TZ=Pacific/Honolulu LC_ALL=C LC_CTYPE=C)

# The selected Bun's directory also contains a competing tmux. Only the
# caller's guard may receive a child lookup; no real tmux is used in this probe.
cat > "$WORK/engine/bun" <<'BUN'
#!/bin/bash
set -eu
[ "$TERM" = dumb ] && [ "$LANG" = C ] && [ "$TZ" = UTC ] \
  || { echo "ambient terminal/locale/time zone leaked: TERM=$TERM LANG=$LANG TZ=$TZ" >&2; exit 1; }
case "$(/usr/bin/locale charmap)" in
  [Uu][Tt][Ff]-8|[Uu][Tt][Ff]8) ;;
  *) echo 'runner character handling is not UTF-8' >&2; exit 1 ;;
esac
[ -z "${LC_ALL+x}" ] || { echo 'ambient LC_ALL overrides runner locale pins' >&2; exit 1; }
for name in CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID CLAUDE_CONFIG_DIR; do
  if [ "$1" = --child ]; then
    [ "$(printenv "$name")" = fixture-session ] || { echo "fixture identity lost: $name" >&2; exit 1; }
  elif printenv "$name" >/dev/null; then
    echo "ambient identity leaked: $name" >&2; exit 1
  fi
done
if [ "$1" = --child ]; then : > "$BUN_RUNNER_CHILD"; exit 0; fi
[ "$1" = test ]
# The runner reads its executed-file receipt from the loader hook; this stand-in opens one file.
echo "$PWD/fixture.test.ts" >> "$TAP_RUNNER_RAN_LOG"
if [ "${BUN_RUNNER_ESCAPE:-0}" = 1 ]; then
  mkdir -p "$BUN_RUNNER_REPO/.tap"
  : > "$BUN_RUNNER_REPO/.tap/probe-marker"
fi
printf '%s\n' "$HOME" > "$BUN_RUNNER_HOME"
[ -d "$TAP_HOME" ]
printf '%s\n' "$TAP_HOME" > "$BUN_RUNNER_TAP_HOME"
printf '%s\n' "$TAP_LOCK_DIR" > "$BUN_RUNNER_LOCKS"
mkdir -p "$TAP_LOCK_DIR"
: > "$TAP_LOCK_DIR/runner-lock"
: > "$HOME/runner-write"
tmux
for name in CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID CLAUDE_CONFIG_DIR; do export "$name=fixture-session"; done
bun --child
BUN
printf '#!/bin/sh\nprintf guard > "$BUN_RUNNER_TMUX"\n' > "$WORK/guard/tmux"
printf '#!/bin/sh\nprintf bypass > "$BUN_RUNNER_TMUX"\n' > "$WORK/engine/tmux"
chmod +x "$WORK/engine/bun" "$WORK/guard/tmux" "$WORK/engine/tmux"

set +e
normal_out="$(env "${identity_env[@]}" HOME="$WORK/caller-home" PATH="$WORK/guard:/usr/bin:/bin:/usr/sbin:/sbin" \
  TMUX_TMPDIR="$WORK/outer-tmux" TAP_SMOKE_BUN="$WORK/engine/bun" \
  BUN_RUNNER_HOME="$WORK/home-observed" BUN_RUNNER_TMUX="$WORK/tmux-observed" \
  BUN_RUNNER_TAP_HOME="$WORK/tap-home-observed" \
  TAP_LOCK_DIR="$WORK/caller-locks" BUN_RUNNER_LOCKS="$WORK/locks-observed" \
  BUN_RUNNER_CHILD="$WORK/child-ran" bash "$RUNNER" 2>&1)"
normal_rc=$?
set -e
[ "$normal_rc" = 0 ] \
  || { echo "bun-runner-isolation: clean inner runner failed rc=$normal_rc: $normal_out" >&2; exit 1; }

failures=0
case "$(cat "$WORK/locks-observed")" in
  "$WORK/outer-tmux"/tb.*/locks) ;;
  *) echo 'bun-runner-isolation: child locks are outside runner scratch' >&2; failures=1 ;;
esac
[ ! -e "$WORK/caller-locks/runner-lock" ] || { echo 'bun-runner-isolation: inherited lock root reached child' >&2; failures=1; }
if [ "$(cat "$WORK/home-observed")" = "$WORK/caller-home" ] || [ -e "$WORK/caller-home/runner-write" ]; then
  echo 'bun-runner-isolation: child wrote into caller HOME' >&2; failures=1
fi
case "$(cat "$WORK/tap-home-observed")" in
  "$WORK/outer-tmux"/tb.*/bus) ;;
  *) echo 'bun-runner-isolation: child TAP_HOME is outside runner scratch' >&2; failures=1 ;;
esac
if [ "$(cat "$WORK/tmux-observed")" != guard ]; then
  echo 'bun-runner-isolation: Bun directory bypassed caller tmux guard' >&2; failures=1
fi
[ -f "$WORK/child-ran" ] || { echo 'bun-runner-isolation: pinned Bun unavailable to child' >&2; failures=1; }
[ "$failures" = 0 ] || exit 1
case "$normal_out" in
  *"bun test: ignored-state-roots: 1 checked, 0 new or changed"*) ;;
  *) echo "bun-runner-isolation: clean receipt omitted ignored-state anchor: $normal_out" >&2; exit 1 ;;
esac

rm -f "$WORK/child-ran"
[ ! -e "$FIXTURE_MARKER" ] && [ ! -L "$FIXTURE_MARKER" ] \
  || { echo "bun-runner-isolation: refusing to overwrite pre-existing $FIXTURE_MARKER" >&2; exit 1; }
set +e
escape_out="$(env "${identity_env[@]}" HOME="$WORK/caller-home" PATH="$WORK/guard:/usr/bin:/bin:/usr/sbin:/sbin" \
  TMUX_TMPDIR="$WORK/outer-tmux" TAP_SMOKE_BUN="$WORK/engine/bun" \
  BUN_RUNNER_HOME="$WORK/home-observed" BUN_RUNNER_TMUX="$WORK/tmux-observed" \
  BUN_RUNNER_TAP_HOME="$WORK/tap-home-observed" \
  TAP_LOCK_DIR="$WORK/caller-locks" BUN_RUNNER_LOCKS="$WORK/locks-observed" \
  BUN_RUNNER_CHILD="$WORK/child-ran" BUN_RUNNER_ESCAPE=1 BUN_RUNNER_REPO="$FIXTURE" \
  bash "$RUNNER" 2>&1)"
escape_rc=$?
set -e
rm -f "$FIXTURE_MARKER"
rmdir "$FIXTURE/.tap" 2>/dev/null || true
[ "$escape_rc" -ne 0 ] || { echo "bun-runner-isolation: ignored-state escape returned green: $escape_out" >&2; exit 1; }
case "$escape_out" in
  *"ignored-state mutation: root=$FIXTURE path=.tap/probe-marker change=new window=bun:"*) ;;
  *) echo "bun-runner-isolation: ignored-state red omitted path/window: $escape_out" >&2; exit 1 ;;
esac
case "$escape_out" in
  *"bun test: ignored-state-roots: 1 checked, 1 new or changed, 0 observation failure(s)"*) ;;
  *) echo "bun-runner-isolation: ignored-state red omitted summary: $escape_out" >&2; exit 1 ;;
esac
echo 'bun-runner-isolation: private HOME, retained tmux guard and pinned child Bun: ok'

# The standalone pin carrier names every mutable state root, even if a caller
# retains HOME for another purpose. Empty lock pins must not select HOME fallback.
for mode in unset empty; do
  pin_env=(env -i "${identity_env[@]}" "HOME=$WORK/caller-home" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "TMPDIR=$WORK")
  [ "$mode" != empty ] || pin_env+=(TAP_LOCK_DIR=)
  "${pin_env[@]}" bash -c '
    . "$1"
    # CLAUDE_CONFIG_DIR is pinned, not unset: HOME here is the caller'"'"'s own.
    case "${CLAUDE_CONFIG_DIR:-}" in
      "$2"/ambient-claude-config|"") echo "shared pins left CLAUDE_CONFIG_DIR unpinned: ${CLAUDE_CONFIG_DIR:-}" >&2; exit 1 ;;
      "$XDG_CONFIG_HOME"/claude) ;;
      *) echo "shared pins put CLAUDE_CONFIG_DIR outside the private config root: $CLAUDE_CONFIG_DIR" >&2; exit 1 ;;
    esac
    for name in CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID CLAUDE_CONFIG_DIR; do
      if [ "$name" != CLAUDE_CONFIG_DIR ] && printenv "$name" >/dev/null; then echo "shared pins leaked $name" >&2; exit 1; fi
      export "$name=fixture-session"
      [ "$(printenv "$name")" = fixture-session ] || exit 1
    done
    for name in TAP_INDEX_HOME TAP_SESSION_MANIFEST OPENCODE_DB_PATH TAP_VERSION_SEEN_PATH TAP_LOCK_DIR; do
      case "${!name}" in "$2"/tap-smoke-sandbox.*/*) ;; *) echo "unisolated $name" >&2; exit 1 ;; esac
    done
  ' bash "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh" "$WORK"
done
