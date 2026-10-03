#!/usr/bin/env bash
# opencode-bind-child-no-tty.test.sh — the OpenCode plugin's init-time `tap in` bind
# child must not hold the pane tty on ANY std fd (tap-kq65d root cause, 2026-09-02).
#
# WHY: bin/tap execs a Bun runtime. Bun and Node snapshot the termios of every std fd
# that is a tty at startup and write the snapshot back at exit, whether or not they
# changed the mode (Node src/node.cc ResetStdio; Bun bun_restore_stdio, oven-sh/bun#29592,
# fixed for the stdout-not-a-tty shape only in bun v1.3.14). Under `--session` OpenCode
# runs plugin init before the TUI sets raw mode, and the plugin's timeout does not cancel
# the bind, so a slow `tap in` exits after the TUI went raw and puts the pane back into
# cooked mode: keys echo, Enter arrives as a newline, the seat is submit-dead from birth.
# The fix hands the bind child `< /dev/null`; this file pins that shape.
#
# THREE ARMS, each load-bearing:
#   control  — a child spawned through the same Bun `$` WITHOUT the redirect sees a tty on
#              fd 0. Proves the pty plumbing hands children a tty, so a "no tty" reading on
#              the plugin arm is the fix's effect and not a harness artifact.
#   plugin   — the shipped plugin's bind child reports fd 0 is NOT a tty.
#   mutant   — the same plugin with the redirect removed reports fd 0 IS a tty. The
#              instrument is shown able to fail on the defect it guards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

fail() { echo "opencode-bind-child-no-tty: $1" >&2; exit 1; }

BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
if [ -z "$BUN" ]; then
  echo "SMOKE-SKIP: bun not on PATH — the OpenCode plugin bind is a Bun-runtime behavior and is checked only where that runtime exists (the primary gate host provisions bun; see bun-router.test.sh)"
  exit 0
fi
command -v python3 >/dev/null || fail "python3 required for the pty harness"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-oc-bind-tty.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/root" "$WORK/plugin"

# Plugin under test, staged next to its sibling helper (the plugin resolves the
# helper relative to import.meta.url).
cp "$ROOT/hooks/tap-opencode-session-start.ts" "$WORK/plugin/shipped.ts"
cp "$ROOT/hooks/tap-opencode-session-id" "$WORK/plugin/tap-opencode-session-id"
chmod +x "$WORK/plugin/tap-opencode-session-id"
# Mutant: the redirect removed. Refuse to run if the spelling this file guards is gone.
sed 's| in < /dev/null`| in`|g' "$WORK/plugin/shipped.ts" > "$WORK/plugin/mutant.ts"
cmp -s "$WORK/plugin/shipped.ts" "$WORK/plugin/mutant.ts" \
  && fail "the shipped plugin no longer spells the bind as \`tap in < /dev/null\`; update this guard with the fix, not around it"

# `tap` stub: records whether any standard fd is a tty. The plugin finds it via `command -v tap`.
cat > "$WORK/bin/tap" <<'STUB'
#!/usr/bin/env bash
arm="${1:-in}"
s0=notty; s1=notty; s2=notty
[ -t 0 ] && s0=tty
[ -t 1 ] && s1=tty
[ -t 2 ] && s2=tty
printf '%s fd0=%s fd1=%s fd2=%s\n' "$arm" "$s0" "$s1" "$s2" >> "$TAP_TEST_RECORD"
exit 0
STUB
chmod +x "$WORK/bin/tap"
# Session-root resolver stub: any directory is a bus root for this probe.
cat > "$WORK/bin/resolver" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$TAP_TEST_ROOT"
STUB
chmod +x "$WORK/bin/resolver"

cat > "$WORK/harness.ts" <<'TS'
import { $ } from "bun"
const which = process.argv[2]
const mod = await import(process.env.TAP_TEST_PLUGIN!)
await mod.default({ directory: process.env.TAP_TEST_ROOT!, worktree: "", $ })
if (which === "control") {
  // Same `$`, same stub, no redirect: what the plugin's child inherits by default.
  await $`bash ${process.env.TAP_TEST_STUB!} control`.quiet().nothrow()
}
TS

# Run one arm inside a fresh pty so the harness has a real controlling tty.
run_arm() { # <plugin-file> <arm-label>
  local plugin="$1" label="$2"
  : > "$WORK/record"
  TAP_TEST_PLUGIN="$plugin" TAP_TEST_ROOT="$WORK/root" TAP_TEST_STUB="$WORK/bin/tap" \
  TAP_TEST_RECORD="$WORK/record" TAP_SESSION_ROOT_RESOLVER="$WORK/bin/resolver" \
  TAP_SMOKE_HARNESS="$WORK/harness.ts" TAP_SMOKE_BUN="$BUN" TAP_TEST_ARM="$label" \
  PATH="$WORK/bin:$PATH" TMUX="/nonexistent/tmux-smoke,1,0" TMUX_PANE="%1" \
  python3 - <<'PY'
import os, pty, sys, time, select, signal
bun = os.environ["TAP_SMOKE_BUN"]; harness = os.environ["TAP_SMOKE_HARNESS"]; arm = os.environ["TAP_TEST_ARM"]
pid, fd = pty.fork()
if pid == 0:
    # `--session <id>` on this pid's argv is what makes the plugin bind at init.
    os.execv(bun, [bun, harness, arm, "--session", "ses_smoke_bind_tty"])
deadline = time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        # On macOS a read on the master raises EIO once the child has exited; EOF or
        # EIO both mean "drain done, collect the status" — not a timeout.
        try:
            if not os.read(fd, 65536): break
        except OSError: break
    done, status = os.waitpid(pid, os.WNOHANG)
    if done: sys.exit(0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1)
else:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); sys.exit(2)
_, status = os.waitpid(pid, 0)
sys.exit(0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1)
PY
}

run_arm "$WORK/plugin/shipped.ts" control || fail "control arm: harness did not exit 0"
grep -qx 'control fd0=tty fd1=notty fd2=notty' "$WORK/record" \
  || fail "control arm: a redirect-free child through the same \`\$\` did not see a tty — the pty plumbing is not delivering one, so the plugin arm would be meaningless ($(tr '\n' ';' < "$WORK/record"))"
grep -qx 'in fd0=notty fd1=notty fd2=notty' "$WORK/record" \
  || fail "plugin arm: the bind child holds the tty on a standard fd ($(tr '\n' ';' < "$WORK/record"))"

run_arm "$WORK/plugin/mutant.ts" mutant || fail "mutant arm: harness did not exit 0"
grep -qx 'in fd0=tty fd1=notty fd2=notty' "$WORK/record" \
  || fail "mutant arm: removing the redirect did not hand the child a tty, so this check cannot detect the defect it guards ($(tr '\n' ';' < "$WORK/record"))"

echo "opencode-bind-child-no-tty: control tty / plugin notty / mutant tty: ok"
