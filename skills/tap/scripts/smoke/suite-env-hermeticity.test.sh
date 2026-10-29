#!/usr/bin/env bash
# D5: fixture-door — the runtime/bun/src touches (:47-48 copy the tree into the fixture; :261 mutates launcher/plan.ts) only build the mutation boundary the canary observes through the launch transaction; the fallback values it protects are pinned natively in runtime/bun/test/launcher-env-tiers.test.ts.
# suite-env-hermeticity.test.sh — the merge gate starts from a declared,
# reproducible environment rather than whatever the launching shell exported.
#
# The inner one-file suite is deliberate: it exercises the real smoke-all
# boundary without recursively running the full suite. Every nested call pins
# its worker with --only because smoke-all discovery also lists colocated
# runtime/bun tests, and this fixture stages runtime/bun/src without the
# runtime/bun/test runner those tests need. Its caller explicitly supplies
# every ambient override, so this smoke behaves the same standalone and as a
# worker of an already-sanitized smoke-all run.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
PY="${TAP_PYTHON:-python3}"
REAL_PY="$(command -v "$PY")"
REAL_BUN="${TAP_SMOKE_BUN:-$(command -v bun)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail () { echo "suite-env-hermeticity: $1" >&2; exit 1; }

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
INNER_TMP="${TMPDIR:-/tmp}"
FIXED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p \
  "$FIXTURE/scripts" \
  "$FIXTURE/skills/tap/scripts/smoke" \
  "$WORK/ambient-bin" \
  "$FIXTURE_HOME" \
  "$FIXTURE_LOCKS" \
  "$INNER_TMP"
cp "$SMOKE_ALL" "$FIXTURE/scripts/smoke-all.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"
cp "$ROOT/scripts/suite-slot-run.py" "$FIXTURE/scripts/suite-slot-run.py"
cp "$ROOT/scripts/suite_slot.py" "$FIXTURE/scripts/suite_slot.py"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke-preflight.sh"
cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"
# The child probes the native launch environment under the same suite boundary.
mkdir -p "$FIXTURE/runtime/bun/src"
cp -R "$ROOT/runtime/bun/src/." "$FIXTURE/runtime/bun/src/"
cat >"$FIXTURE/runtime/bun/check-env.ts" <<'TS'
import { applyLaunchEnv } from "./src/launcher/plan";
const result = applyLaunchEnv({ argv: ["claude"], env: {} },
  { name: "test", harness: "claude", cwd: "/fixture", base: "fixture" });
if (result.env.CLAUDE_CODE_SCROLL_SPEED !== "4")
  throw new Error(`native scroll fallback: ${result.env.CLAUDE_CODE_SCROLL_SPEED} != 4`);
if (result.env.CLAUDE_CODE_TMUX_TRUECOLOR !== "1") throw new Error("native truecolor fallback changed");
console.log("native launch defaults: ok");
TS

cat >"$WORK/ambient-bin/path-only-python" <<EOF
#!/usr/bin/env bash
exec "$REAL_PY" "\$@"
EOF
chmod +x "$WORK/ambient-bin/path-only-python"

# This forwarding binary is outside the runner's fixed PATH. Record real script
# execution so a bare bun cannot pass by finding a different host installation.
ADMITTED_BUN="$WORK/admitted-bun"
cat >"$ADMITTED_BUN" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "$FIXTURE/runtime/bun/check-env.ts" ]; then
  printf '%s\n' admitted > "$FIXTURE_HOME/worker-bun"
fi
exec "$REAL_BUN" "\$@"
EOF
chmod +x "$ADMITTED_BUN"

cat >"$WORK/ambient-bash-env.sh" <<'EOF'
export TAP_BASH_ENV_MARKER=from-bash-env
EOF

cat >"$FIXTURE/skills/tap/scripts/smoke/hermetic-worker.test.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
fail () { echo "hermetic-worker: \$1" >&2; exit 1; }

for name in CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE TAP_LAUNCH_ROOT TAP_LAUNCH_ID TAP_CLEAR_ID; do
  if printenv "\$name" >/dev/null; then fail "\$name crossed the worker boundary"; fi
done

# Excluded values are checked first. On a tree without the boundary this is the
# exact RED: the caller-supplied scroll override reaches this worker.
[ -z "\${CLAUDE_CODE_SCROLL_SPEED+x}" ] || fail "CLAUDE_CODE_SCROLL_SPEED crossed the worker boundary"
[ -z "\${CLAUDE_CODE_TMUX_TRUECOLOR+x}" ] || fail "CLAUDE_CODE_TMUX_TRUECOLOR crossed the worker boundary"
[ -z "\${TAP_FAKE_KNOB+x}" ] || fail "TAP_FAKE_KNOB crossed the worker boundary"
[ -z "\${TAP_BASH_ENV_MARKER+x}" ] || fail "BASH_ENV startup state crossed the worker boundary"
[ -z "\${BASH_ENV+x}" ] || fail "BASH_ENV crossed the worker boundary"
[ -z "\${PYTHONPATH+x}" ] || fail "PYTHONPATH crossed the worker boundary"
[ -z "\${TMUX+x}" ] || fail "TMUX crossed the worker boundary"
[ -z "\${TMUX_PANE+x}" ] || fail "TMUX_PANE crossed the worker boundary"
[ -z "\${DISPLAY+x}" ] || fail "DISPLAY crossed the worker boundary"
[ -z "\${CODEX_HOME+x}" ] || fail "CODEX_HOME crossed the worker boundary"

[ -n "\${TAP_SUITE_SANDBOX:-}" ] || fail "TAP_SUITE_SANDBOX was not admitted"
case "\$HOME" in
  "\$TAP_SUITE_SANDBOX"/f.*/home) ;;
  *) fail "HOME is not file-private: \$HOME" ;;
esac
[ "\${TAP_LOCK_DIR:-}" = "\${HOME%/home}/locks" ] || fail "TAP_LOCK_DIR is not file-private"
[ "\$PATH" = "\$TAP_SUITE_SANDBOX/tmux-guard:$FIXED_PATH" ] \
  || fail "PATH was not pinned behind the tmux guard: \$PATH"
[ "\$TERM" = "dumb" ] || fail "TERM was not pinned: \$TERM"
[ "\$LANG" = "C" ] || fail "LANG was not pinned: \$LANG"
[ -z "\${LC_ALL+x}" ] || fail "LC_ALL should be absent so it cannot outrank LC_CTYPE: \$LC_ALL"
case "\$LC_CTYPE" in
  *[Uu][Tt][Ff]8*|*[Uu][Tt][Ff]-8*) ;;
  *) fail "LC_CTYPE was not pinned to a UTF-8 locale: \$LC_CTYPE" ;;
esac
[ "\$(locale charmap)" = "UTF-8" ] || fail "LC_CTYPE is named UTF-8 but unavailable: \$LC_CTYPE"
[ "\$TZ" = "UTC" ] || fail "TZ was not pinned: \$TZ"
[ "\${EPISODIC_MEMORY_SUMMARIZER_GUARD:-}" = "1" ] \
  || fail "EPISODIC_MEMORY_SUMMARIZER_GUARD was not forwarded to the env-i worker"
case "\${TAP_SUITE_SLOT:-}" in
  ""|bypass) ;;
  *) fail "unexpected TAP_SUITE_SLOT value: \$TAP_SUITE_SLOT" ;;
esac
[ "\${TAP_SUITE_LOCK_HOME:-}" = "$FIXTURE_LOCKS" ] || fail "TAP_SUITE_LOCK_HOME was not admitted"
[ "\${TAP_SUITE_SEAT:-}" = "hermetic-seat" ] || fail "TAP_SUITE_SEAT was not admitted"
[ "\${SMOKE_ALL_MIN_FILES:-}" = "1" ] || fail "SMOKE_ALL_MIN_FILES was not admitted"
[ -n "\${TAP_PYTHON:-}" ] || fail "resolved TAP_PYTHON was not admitted"
printf '%s\n' "\$TAP_PYTHON" > "$FIXTURE_HOME/worker-python"
[ "\${RUNNER_TRACKING_ID:-}" = "hermetic-runner-tracking" ] \
  || fail "GitHub job cancellation tracking did not reach the worker"
case "\${TMUX_TMPDIR:-}" in
  /tmp/tap-tmux.*|/private/tmp/tap-tmux.*) ;;
  *) fail "TMUX_TMPDIR is not a short suite-private tmux root: \${TMUX_TMPDIR:-unset}" ;;
esac
[ "\${TMUX_TMPDIR:-}" != "\$TAP_SUITE_SANDBOX/tmux" ] \
  || fail "TMUX_TMPDIR still consumes the HOME sandbox's socket-path budget"

# Refuse before the first real tmux call unless the runner established its
# private namespace. This keeps the RED control incapable of reaching the
# operator server on old code.
tmux new-session -d -s suite-env-private-server
socket="\$(tmux display-message -p '#{socket_path}')"
tmux_root="\$(cd "\$TMUX_TMPDIR" && pwd -P)"
case "\$socket" in
  "\$tmux_root"/*) ;;
  *) fail "bare tmux escaped the suite root: \$socket" ;;
esac
printf '%s\n' "\$socket" >"$FIXTURE_HOME/suite-tmux-socket"
printf '%s\n' "\$TMUX_TMPDIR" >"$FIXTURE_HOME/suite-tmux-root"

# The suite root must leave enough Unix-socket path budget for established
# fixture server names. This is the exact shape used by self-stop-tombstone.
long_name="tap-selfstop-123456"
tmux -L "\$long_name" new-session -d -s suite-env-long-name
long_socket="\$(TMUX= tmux -L "\$long_name" display-message -p '#{socket_path}')"
case "\$long_socket" in
  "\$tmux_root"/*) ;;
  *) fail "named tmux escaped the suite root: \$long_socket" ;;
esac
tmux -L "\$long_name" kill-server

exec "\${TAP_SMOKE_BUN:-bun}" "$FIXTURE/runtime/bun/check-env.ts"
EOF
chmod +x "$FIXTURE/skills/tap/scripts/smoke/hermetic-worker.test.sh"

run_inner () {
  env -i \
    HOME="$FIXTURE_HOME" \
    TMPDIR="$INNER_TMP" \
    PATH="/tmp/ambient-bin:$PATH" \
    TERM="xterm-256color" \
    LANG="C" \
    LC_ALL="C" \
    TZ="Pacific/Honolulu" \
    BASH_ENV="$WORK/ambient-bash-env.sh" \
    PYTHONPATH="/tmp/ambient-python" \
    TMUX="/tmp/ambient-tmux,1,0" \
    DISPLAY=":99" \
    CODEX_HOME="/tmp/ambient-codex" \
    CLAUDE_CODE_SESSION_ID="ambient-session" \
    CODEX_THREAD_ID="ambient-session" \
    OPENCODE_SESSION_ID="ambient-session" \
    CURSOR_CONVERSATION_ID="ambient-session" \
    ANTIGRAVITY_CONVERSATION_ID="ambient-session" \
    TAP_HARNESS_SESSION_ID="ambient-session" \
    TAP_TRANSCRIPT_PATH="ambient-session" \
    TAP_SESSION_SOURCE="ambient-session" \
    CLAUDE_CODE_TMUX_TRUECOLOR="9" \
    CLAUDE_CODE_SCROLL_SPEED="6" \
    TAP_FAKE_KNOB="sentinel-value" \
    TAP_PYTHON="$PY" \
    TAP_SMOKE_BUN="$ADMITTED_BUN" \
    RUNNER_TRACKING_ID="hermetic-runner-tracking" \
    TAP_SUITE_SLOT="bypass" \
    TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_SUITE_SEAT="hermetic-seat" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    bash "$FIXTURE/scripts/smoke-all.sh" -j 1 --only skills/tap/scripts/smoke/hermetic-worker.test.sh 2>&1
}

# --- (1) an admitted PATH-only python survives the fixed-PATH boundary -------
run_with_path_only_python () {
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="$WORK/ambient-bin:$PATH" \
    TERM="xterm-256color" \
    LANG="C" \
    LC_ALL="C" \
    TZ="Pacific/Honolulu" \
    TAP_PYTHON="path-only-python" \
    TAP_SMOKE_BUN="$ADMITTED_BUN" \
    RUNNER_TRACKING_ID="hermetic-runner-tracking" \
    TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_SUITE_SEAT="hermetic-seat" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    bash "$FIXTURE/scripts/smoke-all.sh" -j 1 --only skills/tap/scripts/smoke/hermetic-worker.test.sh 2>&1
}

set +e
out="$(run_with_path_only_python)"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "(1) caller-PATH-only TAP_PYTHON run failed (rc=$rc): $out"
[ -s "$FIXTURE_HOME/worker-bun" ] || fail "(1) native worker bypassed admitted TAP_SMOKE_BUN"
[ "$(cat "$FIXTURE_HOME/worker-python")" = "$WORK/ambient-bin/path-only-python" ] \
  || fail "(1) worker discarded the admitted interpreter (and its virtualenv dependencies)"
case "$out" in
  *"admitted entry env:"*"TAP_PYTHON=$WORK/ambient-bin/path-only-python"*) ;;
  *) fail "(1) admitted TAP_PYTHON was not resolved to its executable path: $out" ;;
esac
echo "suite-env-hermeticity: (1) caller-PATH-only TAP_PYTHON resolved before fixed-PATH re-exec: ok"

# --- (2) real boundary: explicit ambient values do not reach the worker -------
set +e
out="$(run_inner)"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "(2) sanitized inner suite failed (rc=$rc): $out"
[ -s "$FIXTURE_HOME/suite-tmux-socket" ] || fail "(2) worker omitted private socket receipt"
worker_socket="$(cat "$FIXTURE_HOME/suite-tmux-socket")"
[ ! -S "$worker_socket" ] || fail "(2) runner left its ephemeral tmux socket alive: $worker_socket"
worker_tmux_root="$(cat "$FIXTURE_HOME/suite-tmux-root")"
[ ! -e "$worker_tmux_root" ] || fail "(2) runner left its recorded tmux root behind: $worker_tmux_root"
case "$out" in
  *"inherited TAP_* from the launching shell:"*"TAP_BASH_ENV_MARKER"*"TAP_FAKE_KNOB"*) ;;
  *) fail "(2) pre-boundary TAP_* report was not preserved: $out" ;;
esac
case "$out" in
  *"excluded asserted-default env:"*"CLAUDE_CODE_SCROLL_SPEED=6"*"CLAUDE_CODE_TMUX_TRUECOLOR=9"*) ;;
  *) fail "(2) excluded asserted-default inputs were not reported: $out" ;;
esac
case "$out" in
  *"admitted entry env:"*"TAP_PYTHON="*"TAP_SUITE_LOCK_HOME=$FIXTURE_LOCKS"*"TAP_SUITE_SEAT=hermetic-seat"*"TAP_SUITE_SLOT=bypass"*) ;;
  *) fail "(2) admitted configuration was not reported: $out" ;;
esac
case "$out" in
  *"admitted entry env:"*"EPISODIC_MEMORY_SUMMARIZER_GUARD=1"*) ;;
  *) fail "(2) test-child guard was not admitted at clean entry: $out" ;;
esac
case "$out" in
  *"resolved worker env: TAP_PYTHON="*) ;;
  *) fail "(2) resolved worker interpreter was not reported: $out" ;;
esac
echo "suite-env-hermeticity: (2) explicit ambient overrides excluded; declared controls admitted + reported; test-child guard=1: ok"

# --- (3) false-green control: the fallback assertion must see a bad default ---
# Without the boundary, ambient scroll=6 would replace the mutated fallback and
# the assertion would read 6, not 7. Under the boundary, the existing assertion observes the native launch transaction's
# bad fallback (the default now lives in runtime/bun/src/launcher/plan.ts,
# the native applyLaunchEnv owner).
"$PY" - "$FIXTURE/runtime/bun/src/launcher/plan.ts" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
old = 'env.CLAUDE_CODE_SCROLL_SPEED ?? "4"'
new = 'env.CLAUDE_CODE_SCROLL_SPEED ?? "7"'
if source.count(old) != 1:
    raise SystemExit(f"expected exactly one fallback mutation site, found {source.count(old)}")
path.write_text(source.replace(old, new))
PY

set +e
out="$(run_inner)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(3) ambient scroll=6 masked the mutated fallback; inner suite false-greened"
case "$out" in
  *"native scroll fallback: 7 != 4"*) ;;
  *) fail "(3) mutation did not red through the existing fallback assertion: $out" ;;
esac
echo "suite-env-hermeticity: (3) fallback 4->7 mutation reds the existing assertion despite ambient scroll=6: ok"

# --- (4) TAP_SMOKE_BUN survives entry AND the per-smoke worker allowlist --------
# clean_env admitted it, worker_env omitted it → opencode-bind SKIP green.
BUN_DIR="$WORK/outside-fixed-path"
mkdir -p "$BUN_DIR"
SENTINEL_BUN="$BUN_DIR/bun"
cat >"$SENTINEL_BUN" <<'EOF'
#!/usr/bin/env bash
# Sentinel "bun" outside SMOKE_ALL_FIXED_PATH — proves admission, not PATH luck.
if [ "${1:-}" = "--version" ]; then
  echo "sentinel-bun-1.0.0"
  exit 0
fi
echo "sentinel-bun: unexpected args: $*" >&2
exit 2
EOF
chmod +x "$SENTINEL_BUN"

# Swap the native-default worker for a Bun-runtime worker (same one-file MIN_FILES=1 shape).
rm -f "$FIXTURE/skills/tap/scripts/smoke/hermetic-worker.test.sh"
BUN_RAN="$FIXTURE_HOME/bun-runtime-ran"
rm -f "$BUN_RAN"
cat >"$FIXTURE/skills/tap/scripts/smoke/bun-runtime-worker.test.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
fail () { echo "bun-runtime-worker: \$1" >&2; exit 1; }
[ -n "\${TAP_SMOKE_BUN:-}" ] || fail "TAP_SMOKE_BUN missing at worker (allowlist drop)"
[ "\${TAP_SMOKE_BUN}" = "$SENTINEL_BUN" ] || fail "TAP_SMOKE_BUN mismatch: \${TAP_SMOKE_BUN}"
[ -x "\${TAP_SMOKE_BUN}" ] || fail "TAP_SMOKE_BUN not executable"
out="\$("\${TAP_SMOKE_BUN}" --version 2>&1)" || fail "TAP_SMOKE_BUN failed to execute: \$out"
case "\$out" in
  *sentinel-bun-1.0.0*) ;;
  *) fail "executed wrong bun: \$out" ;;
esac
# Marker outside smoke-all's buffered stdout — suite ok-line does not replay passes.
printf '%s\n' "\$out" > "$BUN_RAN"
echo "bun-runtime-worker: runtime arms execute via admitted TAP_SMOKE_BUN: ok"
EOF
chmod +x "$FIXTURE/skills/tap/scripts/smoke/bun-runtime-worker.test.sh"

# Invoke via absolute bash>=4 — PATH stays bun-free so admission cannot hide
# behind FIXED_PATH's /opt/homebrew/bin/bun on this host.
SUITE_BASH="$(command -v bash)"
run_bun_admit () {
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/usr/bin:/bin" \
    TERM="dumb" \
    LANG="C" \
    LC_CTYPE="C.UTF-8" \
    TZ="UTC" \
    TAP_PYTHON="$REAL_PY" \
    TAP_SMOKE_BUN="$SENTINEL_BUN" \
    TAP_SUITE_SLOT="bypass" \
    TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
    TAP_SUITE_SEAT="hermetic-seat" \
    TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES="1" \
    "$SUITE_BASH" "$FIXTURE/scripts/smoke-all.sh" -j 1 --only skills/tap/scripts/smoke/bun-runtime-worker.test.sh 2>&1
}

rm -f "$BUN_RAN"
set +e
out="$(run_bun_admit)"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "(4) TAP_SMOKE_BUN worker admission failed (rc=$rc): $out"
case "$out" in
  *"admitted entry env:"*"TAP_SMOKE_BUN=$SENTINEL_BUN"*) ;;
  *) fail "(4) entry did not admit TAP_SMOKE_BUN: $out" ;;
esac
[ -f "$BUN_RAN" ] || fail "(4) worker did not execute TAP_SMOKE_BUN (no marker)"
grep -q 'sentinel-bun-1.0.0' "$BUN_RAN" \
  || fail "(4) marker missing sentinel output: $(cat "$BUN_RAN" 2>/dev/null || true)"
echo "suite-env-hermeticity: (4) TAP_SMOKE_BUN admitted through worker allowlist + executed: ok"

# False-green control: drop TAP_SMOKE_BUN from the copied worker allowlist → RED.
"$PY" - "$FIXTURE/scripts/smoke-all.sh" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "    TAP_SMOKE_BUN \\\n"
if old not in text:
    raise SystemExit("expected TAP_SMOKE_BUN in worker allowlist for mutation")
path.write_text(text.replace(old, "", 1))
PY

rm -f "$BUN_RAN"
set +e
out="$(run_bun_admit)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(4b) allowlist drop false-greened; worker still saw TAP_SMOKE_BUN"
[ ! -f "$BUN_RAN" ] || fail "(4b) marker written despite allowlist drop"
case "$out" in
  *"TAP_SMOKE_BUN missing at worker"*|*"bun-runtime-worker: TAP_SMOKE_BUN missing"*) ;;
  *) fail "(4b) mutation did not red on allowlist drop: $out" ;;
esac
echo "suite-env-hermeticity: (4b) worker allowlist drop reds (no false-green skip): ok"

echo "PASS suite-env-hermeticity"
