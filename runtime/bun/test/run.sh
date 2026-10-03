#!/usr/bin/env bash
set -euo pipefail

# A bare invocation means the Bun suite, independent of the caller's cwd.
# Include colocated src tests; explicit paths/filters keep the caller's cwd.
if [ "$#" -eq 0 ]; then
  set -- "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
elif [[ "$1" == -* ]]; then
  echo 'bun test: put an explicit test path/filter before Bun options (for the full suite: runtime/bun/test/run.sh ./runtime/bun --timeout 20000)' >&2
  exit 64
fi

# `bun test` reads a positional as a substring FILTER, so a repo-relative test path
# also selects archived copies (tmp/<seat>/**/runtime/bun/test/x.test.ts). Spell every
# positional that names an existing file or directory as its absolute path, which Bun
# treats as exact (tap-pxc8d). Bun's grammar is `[flags] [<patterns>]`, so a path may
# follow an option and is still a pattern: every non-option argument that exists on disk
# is rewritten, EXCEPT the argument that follows a value-taking option in its separate
# `--opt value` spelling (`-t test` must not turn `test` into a directory). The list is
# the value-taking options of `bun test --help`; `--opt=value` forms are one argument.
# `--changed` and `--parallel` are absent on purpose: their optional values are same-token
# only (`--changed=ref`), so bare they do not consume the next argument.
# Names that are not on disk (patterns, `5000`) stay as given.
_value_opts=" -t --test-name-pattern --timeout --rerun-each --retry --seed --coverage-reporter --coverage-dir --reporter --reporter-outfile --max-concurrency --path-ignore-patterns --parallel-delay --shard --timings -r --preload --grep "
_args=()
_skip=0
for _arg in "$@"; do
  if [ "$_skip" = 1 ]; then
    _skip=0
  elif [[ "$_arg" == -* ]]; then
    [[ "$_value_opts" == *" $_arg "* ]] && _skip=1
  elif [ -d "$_arg" ]; then _arg="$(cd "$_arg" && pwd -P)"
  elif [ -e "$_arg" ]; then _arg="$(cd "$(dirname "$_arg")" && pwd -P)/$(basename "$_arg")"; fi
  _args+=("$_arg")
done
set -- "${_args[@]}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IGNORED_STATE_TRIPWIRE="$ROOT/scripts/ignored-state-tripwire.py"

# Nest under an inherited runner root while staying below macOS's 104-byte sun_path ceiling.
WORK="$(mktemp -d "${TMUX_TMPDIR:-/tmp}/tb.XXXXXX")"

cleanup() {
  set +e
  # Reap the ephemeral tmux server this runner owns: only sockets under this
  # run's own WORK/tmux dir (the case guard IS the ownership record — never a
  # name or pattern kill: cleanup stops only what it started; tap-7r3fn.19).
  # The scratch itself is still removed only after lsof proves it unowned.
  local socket tmux_bin
  tmux_bin="$(command -v tmux 2>/dev/null || true)"
  if [ -n "$tmux_bin" ] && [ -d "$WORK/tmux" ]; then
    while IFS= read -r socket; do
      case "$socket" in "$WORK"/tmux/*) "$tmux_bin" -S "$socket" kill-server 2>/dev/null || true ;; esac
    done < <(find "$WORK/tmux" -type s -print 2>/dev/null)
  fi
  local lsof_bin
  lsof_bin="$(command -v lsof 2>/dev/null || printf '%s' /usr/sbin/lsof)"
  "$lsof_bin" +D "$WORK" >/dev/null 2>&1
  local lsof_rc=$?
  set -e
  if [ "$lsof_rc" -ne 1 ]; then
    echo "bun test: refusing to remove scratch without an unowned lsof result: $WORK" >&2
    return 1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# Signals must route through EXIT so failure and interrupt paths reap too —
# the same shape smoke-all.sh uses at its top level.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mkdir -p "$WORK/index" "$WORK/tmux" "$WORK/tmp" "$WORK/home" "$WORK/bin" "$WORK/bus"
# Born live (F1): native verbs refuse an absent machine marker, so the shared
# index starts as an empty 0.20 marker. Fixtures that need their own mint it.
printf '{"schema":"0.20","teams":{}}\n' > "$WORK/index/global-registry.json"
chmod 700 "$WORK/tmux"
_PYTHON="$(command -v "${TAP_PYTHON:-python3}" 2>/dev/null || command -v python3 2>/dev/null || true)"
[ -n "$_PYTHON" ] || { echo "bun test: python3 not found for ignored-state snapshot" >&2; exit 1; }
[ -f "$IGNORED_STATE_TRIPWIRE" ] \
  && "$_PYTHON" -B "$IGNORED_STATE_TRIPWIRE" snapshot "$ROOT" "$WORK/ignored-state-before.json" \
  || { echo "bun test: could not snapshot ignored checkout state before tests: $ROOT/.tap" >&2; exit 1; }
_BUN="${TAP_SMOKE_BUN:-bun}"
# Native process startup varies with macOS background scanning. Explicit test
# deadlines and operation-level timing assertions retain their own budgets.
TEST_TIMEOUT_MS=5000
if [ "$(/usr/bin/uname -s)" = Darwin ]; then
  TEST_TIMEOUT_MS=30000
fi
# Child tests invoke `bun` too. Expose only the selected executable, so a
# sibling tmux in its installation directory cannot bypass the caller's guard.
ln -s "$(command -v "$_BUN")" "$WORK/bin/bun"
# TMPDIR joins the other pins: tmpdir() fixtures land inside the runner-owned
# WORK, so an interrupted run leaves nothing the lsof-guarded cleanup misses.
test_rc=0
# The receipt comes from an observer, not from Bun's console: an agent-mode Bun (it reads
# AI_AGENT, CLAUDECODE and the like) prints no per-file header for a passing file, and its
# junit report omits a file with no testcase (an empty file, a load or syntax error). A
# resolve hook sees every test entry Bun loads whatever happens next. An entry resolves
# with no importer; a module a test imports has one, so the receipt needs no filename
# classifier. The hook observes and falls through: it never supplies contents, so a
# caller's own --preload loader still applies. It is registered after the caller's
# arguments so every other preload (a caller's or a bunfig's, which also resolve with no
# importer) is resolved before it exists and never reaches the receipt.
cat > "$WORK/ran-files-preload.ts" <<'PRELOAD'
import { plugin } from "bun";
import { appendFileSync } from "node:fs";
plugin({
  name: "ran-files",
  setup(build) {
    build.onResolve({ filter: /^\// }, (args) => {
      if (!args.importer) appendFileSync(process.env.TAP_RUNNER_RAN_LOG!, args.path + "\n");
      return undefined;
    });
  },
});
PRELOAD
# Session identity is fixture input, never the harness that launched the runner.
# Derived from register.ts directSessionIdentity + transcript/source reads and
# session-store.ts sessionDerive, plus the launch evidence SessionStart binds
# through (launch-evidence.ts): a runner started inside a live seat's pane must
# never carry that seat's incarnation token into fixtures (tap-9jfyl). Keep in
# sync with sandbox-pins.sh.
# CLAUDE_CONFIG_DIR is operator state, not fixture input: code resolving
# `${CLAUDE_CONFIG_DIR:-~/.claude}` must land in the runner's scratch HOME,
# never the operator's real Claude config (tap-lcuft). FORCE_COLOR would colorize Bun's
# `(pass)`/`(fail)` rows, which ci-gate-verdict.py and smoke-all parse as plain text (tap-ied3q).
env -u TMUX -u TMUX_PANE -u TAP_SELF \
  -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u OPENCODE_SESSION_ID \
  -u CURSOR_CONVERSATION_ID -u ANTIGRAVITY_CONVERSATION_ID \
  -u TAP_HARNESS_SESSION_ID -u TAP_TRANSCRIPT_PATH -u TAP_SESSION_SOURCE \
  -u TAP_LAUNCH_ROOT -u TAP_LAUNCH_ID -u TAP_CLEAR_ID \
  -u CLAUDE_CONFIG_DIR \
  -u FORCE_COLOR \
  HOME="$WORK/home" \
  PATH="$WORK/bin:$PATH" \
  TMUX_TMPDIR="$WORK/tmux" \
  TMPDIR="$WORK/tmp" \
  TAP_HOME="$WORK/bus" \
  TAP_LOCK_DIR="$WORK/locks" \
  TAP_INDEX_HOME="$WORK/index" \
  TAP_SESSION_MANIFEST="$WORK/sessions.json" \
  OPENCODE_DB_PATH="$WORK/opencode.db" \
  TAP_VERSION_SEEN_PATH="$WORK/version-seen.json" \
  TAP_SETUP_OPEN_GUIDE=0 \
  EPISODIC_MEMORY_SUMMARIZER_GUARD=1 \
  TAP_NOTIFY_USER_BIN="/nonexistent/tap-smoke-must-stub-notify-user" \
  TAP_TMUX_SOCKET="tapbun-test-$$" \
  TAP_RUNNER_RAN_LOG="$WORK/ran-files.log" \
  "$_BUN" test --timeout "$TEST_TIMEOUT_MS" "$@" --preload "$WORK/ran-files-preload.ts" || test_rc=$?

# Name the test files Bun opened, from the resolve hook above (console output is unchanged).
# The filter arguments say what was asked for, not what ran. Zero files is an error
# even when Bun exits 0; Bun's own failing status wins over this check's. A hook that
# never fired (nothing matched, or Bun died first) leaves no log, which also reads as zero.
ran_rc=0
ran_line="$("$_PYTHON" -B - "$WORK/ran-files.log" <<'PY'
import os, sys
try:
    lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
except OSError:
    lines = []
cwd = os.getcwd()
seen = []
for path in lines:
    name = os.path.relpath(path, cwd) if path.startswith(cwd + os.sep) else path
    if name not in seen:
        seen.append(name)
if not seen:
    sys.exit(4)
print("run.sh: ran %d file%s: %s" % (len(seen), "" if len(seen) == 1 else "s", " ".join(seen)))
PY
)" || ran_rc=$?
report_ran() {
  if [ "$ran_rc" -eq 0 ]; then
    echo "$ran_line"
    return
  fi
  echo "run.sh: no test files ran" >&2
  [ "$test_rc" -ne 0 ] || test_rc=1
}

tripwire_rc=0
"$_PYTHON" -B "$IGNORED_STATE_TRIPWIRE" compare \
  "$WORK/ignored-state-before.json" "$ROOT" "bun:${*:-full-suite}" \
  >"$WORK/ignored-state.out" 2>&1 || tripwire_rc=$?
if [ "$tripwire_rc" -ne 0 ]; then
  cat "$WORK/ignored-state.out" >&2
  _ignored_mutations="$(grep -c '^ignored-state mutation:' "$WORK/ignored-state.out" 2>/dev/null || true)"
  _ignored_observation_failures="$(grep -c '^ignored-state observation failed:' "$WORK/ignored-state.out" 2>/dev/null || true)"
  echo "bun test: ignored-state-roots: 1 checked, ${_ignored_mutations:-0} new or changed, ${_ignored_observation_failures:-0} observation failure(s)" >&2
  report_ran
  exit 1
fi
echo "bun test: ignored-state-roots: 1 checked, 0 new or changed"
report_ran
exit "$test_rc"
