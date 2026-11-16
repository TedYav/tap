#!/usr/bin/env bash
set -euo pipefail

# Remove inherited credentials before any runner child can print its env.
. "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/test-secret-env.sh"

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
_entries=()  # positional arguments that are files: the pin tripwire's file boundaries
_skip=0
for _arg in "$@"; do
  if [ "$_skip" = 1 ]; then
    _skip=0
  elif [[ "$_arg" == -* ]]; then
    [[ "$_value_opts" == *" $_arg "* ]] && _skip=1
  elif [ -d "$_arg" ]; then _arg="$(cd "$_arg" && pwd -P)"
  elif [ -e "$_arg" ]; then
    _arg="$(cd "$(dirname "$_arg")" && pwd -P)/$(basename "$_arg")"
    [ -f "$_arg" ] && _entries+=("$_arg")
  fi
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
# Native process startup varies with the host: macOS background scanning, and a
# loaded Linux container or CI runner, both push process-spawning tests past
# Bun's 5 s default. One budget for every platform. Explicit test deadlines and
# operation-level timing assertions retain their own budgets.
TEST_TIMEOUT_MS=30000
# Child tests invoke `bun` too. Expose only the selected executable, so a
# sibling tmux in its installation directory cannot bypass the caller's guard.
ln -s "$(command -v "$_BUN")" "$WORK/bin/bun"
# Every test that runs install.sh stages the pinned fzf, which downloads from GitHub: a stalled
# network cost one runner 3 x 30 s per install. Point them at the account's verified cache the
# way the install smokes do (fzf-archive-pin.sh); install-fzf.ts re-checks the sha256, and no
# cache leaves the variable unset so the download happens as before.
_fzf_archive="$(PATH="$WORK/bin:$PATH" bash -c '. "$1" && printf %s "${TAP_FZF_TEST_ARCHIVE:-}"' _ "$ROOT/skills/tap/scripts/smoke/fzf-archive-pin.sh" 2>/dev/null || true)"
[ -z "$_fzf_archive" ] || export TAP_FZF_TEST_ARCHIVE="$_fzf_archive"
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
# The same hook is the pin-leak tripwire (tap-jo3bz): every file in one `bun test` process shares
# process.env, so a test that unsets or rewrites a runner pin without restoring it starves every
# later file (an unset TAP_INDEX_HOME read as "this machine has no enrolled team" three files
# later). Bun loads and runs entries one at a time, so at each entry's resolve the previous entry's
# afterAll has run; a pin that differs from the runner's value then names the file that leaked it.
# The positional test files this run was given (the parser above already skipped option values
# such as `--preload x.ts`), by real path: the preload treats these as file boundaries whatever
# their names, alongside every test-shaped file Bun discovers through a directory or filter.
"$_PYTHON" -B -c 'import os, sys
for a in sys.argv[1:]: print(os.path.realpath(a))' ${_entries[@]+"${_entries[@]}"} > "$WORK/entries.txt"
cat > "$WORK/ran-files-preload.ts" <<'PRELOAD'
import { plugin } from "bun";
import { afterAll } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
// Observer paths are captured once: a test that rewrote them could not redirect the receipt.
const RAN_LOG = process.env.TAP_RUNNER_RAN_LOG!, LEAK_LOG = process.env.TAP_RUNNER_LEAK_LOG!;
const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);
const ENTRIES = new Set(lines(process.env.TAP_RUNNER_ENTRIES!));
// The baseline is what run.sh set, read from its own file, not from process.env: a caller's
// --preload runs before this one and could already have moved a pin. A null value is a
// variable the runner unset, which must stay absent.
const pinned: ReadonlyMap<string, string | undefined> = new Map(Object.entries(
  JSON.parse(readFileSync(process.env.TAP_RUNNER_PINS!, "utf8")) as Record<string, string | null>)
  .map(([k, v]) => [k, v ?? undefined]));
// Each distinct leaked value is reported once; a later file that restores the baseline is not a
// leaker, and the baseline itself never moves.
const reported = new Map<string, string | undefined>();
// Only a test FILE is a boundary where the previous file's afterAll has run. A dynamic import
// (`x.ts?swap`, a fixture-written module) also resolves with no importer, mid-file, possibly
// inside a deliberate temporary pin; it joins the receipt but never the comparison. A boundary
// is an explicit entry (any name) or a test-shaped file, which is what Bun discovers through a
// directory or a text filter: a name containing `.test.`, `_test.`, `.spec.`, `_spec.`, `_test_`
// or `_spec_` with a script extension (Bun's own discovery shapes).
const TEST_SHAPE = /(?:^|\/)[^/]*[._](?:test|spec)(?:[._][^/]*)?\.[cm]?[jt]sx?$/;
const isEntry = (path: string): boolean => ENTRIES.has(path) || TEST_SHAPE.test(path);
let previous = "";
const compare = (seenAt: string): void => {
  for (const [key, want] of pinned) {
    const have = process.env[key];
    if (have === want) { reported.delete(key); continue; }
    if (reported.has(key) && reported.get(key) === have) continue;
    appendFileSync(LEAK_LOG,
      `${key}\t${previous || "(before the first entry)"}\t${seenAt}\t${have === undefined ? "(unset)" : have}\n`);
    reported.set(key, have);
  }
};
plugin({
  name: "ran-files",
  setup(build) {
    build.onResolve({ filter: /^\// }, (args) => {
      if (args.importer) return undefined;
      appendFileSync(RAN_LOG, args.path + "\n");
      if (!isEntry(args.path)) return undefined;
      compare(args.path);
      previous = args.path;
      return undefined;
    });
  },
});
// A preload afterAll runs after the last file's own afterAll, so that file is compared too.
afterAll(() => compare("(end of run)"));
PRELOAD
# Match the gate's C locale with UTF-8 character handling. A plain LANG=C
# makes tmux format output replace tabs with underscores; an inherited LC_ALL
# would override both LANG and LC_CTYPE, so it is scrubbed below.
_utf8_locale=""
for _candidate in en_US.UTF-8 UTF-8 C.UTF-8 C.utf8; do
  _charmap="$(LC_ALL='' LANG=C LC_CTYPE="$_candidate" /usr/bin/locale charmap 2>/dev/null || true)"
  case "$_charmap" in
    [Uu][Tt][Ff]-8|[Uu][Tt][Ff]8) _utf8_locale="$_candidate"; break ;;
  esac
done
[ -n "$_utf8_locale" ] || {
  echo 'bun test: no UTF-8 locale (tried en_US.UTF-8, UTF-8, C.UTF-8, C.utf8)' >&2
  exit 1
}
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
# The runner pins, in one place: the same lists are what Bun runs under and what the tripwire
# compares against, written to disk here so a caller's own --preload (which Bun loads before
# the runner's) cannot move the baseline by mutating process.env first. `_unset` names the
# variables that must stay ABSENT: a test that sets one (TAP_TMUX_SOCKET_PATH outranks the
# pinned TAP_TMUX_SOCKET in tmux.ts) and never deletes it leaks just as surely.
_unset=(TMUX TMUX_PANE TAP_SELF
  CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID
  CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID
  TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE
  TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID
  CLAUDE_CONFIG_DIR
  FORCE_COLOR LC_ALL
  TAP_TMUX_SOCKET_PATH TAP_REGISTRY TAP_SERVER_EPOCH)
_unset_args=()
for _name in "${_unset[@]}"; do _unset_args+=(-u "$_name"); done
_pins=(
  # Match the gate so terminal, language and time-zone-sensitive tests cannot
  # pass only because the focused run inherited a developer's shell settings.
  TERM=dumb
  LANG=C
  LC_CTYPE="$_utf8_locale"
  TZ=UTC
  HOME="$WORK/home"
  PATH="$WORK/bin:$PATH"
  TMUX_TMPDIR="$WORK/tmux"
  TMPDIR="$WORK/tmp"
  TAP_HOME="$WORK/bus"
  TAP_LOCK_DIR="$WORK/locks"
  TAP_INDEX_HOME="$WORK/index"
  TAP_SESSION_MANIFEST="$WORK/sessions.json"
  OPENCODE_DB_PATH="$WORK/opencode.db"
  TAP_VERSION_SEEN_PATH="$WORK/version-seen.json"
  TAP_SETUP_OPEN_GUIDE=0
  EPISODIC_MEMORY_SUMMARIZER_GUARD=1
  TAP_NOTIFY_USER_BIN="/nonexistent/tap-smoke-must-stub-notify-user"
  TAP_TMUX_SOCKET="tapbun-test-$$"
)
"$_PYTHON" -B -c 'import json, sys
pins = {}
for a in sys.argv[1:]:
    k, sep, v = a.partition("=")
    pins[k] = v if sep else None
print(json.dumps(pins))' "${_pins[@]}" "${_unset[@]}" > "$WORK/pins.json"
env "${_unset_args[@]}" \
  "${_pins[@]}" \
  TAP_RUNNER_RAN_LOG="$WORK/ran-files.log" \
  TAP_RUNNER_LEAK_LOG="$WORK/pin-leaks.log" \
  TAP_RUNNER_ENTRIES="$WORK/entries.txt" \
  TAP_RUNNER_PINS="$WORK/pins.json" \
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
  # A leaked pin fails the run even when every test passed: the next file in a larger batch
  # would have inherited it, and that failure would carry the wrong file's name (tap-jo3bz).
  # Diagnostics come first so the ran-files receipt stays the last line.
  if [ -s "$WORK/pin-leaks.log" ]; then
    while IFS=$'\t' read -r key culprit seen_at value; do
      echo "run.sh: pinned env leaked: $key is $value after $culprit (seen at $seen_at); restore the inherited value, or delete it when the runner left it unset" >&2
    done < "$WORK/pin-leaks.log"
    [ "$test_rc" -ne 0 ] || test_rc=1
  fi
  if [ "$ran_rc" -eq 0 ]; then
    echo "$ran_line"
  else
    echo "run.sh: no test files ran" >&2
    [ "$test_rc" -ne 0 ] || test_rc=1
  fi
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
