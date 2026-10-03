#!/usr/bin/env bash
# artifact-shell-doors.test.sh — tap-7r3fn.192 U3: in a release-artifact layout, bin/tap execs
# the compiled router (never the Bun CLI, even with BUN_BE_BUN exported), its debug routes and
# the session-start and guard hooks run libexec/tap/bun, and nothing needs Bun on PATH. In a
# checkout layout the hooks keep their silent no-Bun exit. The router and the shim are
# recorders here; compiled-artifact.test.ts runs the real ones.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${WORK:?}"' EXIT
NOBUN="/usr/bin:/bin:/usr/sbin:/sbin"
fail() { echo "artifact-shell-doors: FAIL $*" >&2; exit 1; }
PATH="$NOBUN" command -v bun >/dev/null 2>&1 && fail "the no-Bun PATH still finds bun"

# The artifact tree: the real doors, a recording router and a recording shim.
ART="$WORK/art"; LOG="$WORK/log"
mkdir -p "$ART/bin" "$ART/hooks" "$ART/libexec/tap" "$LOG"
cp "$ROOT/bin/tap" "$ART/bin/tap"
cp "$ROOT"/hooks/tap-advisory.sh "$ROOT"/hooks/tap-codex-session-start.sh "$ROOT"/hooks/tap-cursor-session-start.sh "$ROOT"/hooks/tap-shell-body-guard.sh "$ART/hooks/"
cat > "$ART/libexec/tap/tap" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$LOG/router-argv"
printf 'public=%s be_bun=%s\n' "\${TAP_INTERNAL_PUBLIC_COMMAND-unset}" "\${BUN_BE_BUN-unset}" > "$LOG/router-env"
EOF
cat > "$ART/libexec/tap/bun" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$LOG/shim-argv"
if [ "\${2:-}" = guard-echo ] || [ "\${1##*/}" = tap-shell-body-guard.ts ]; then cat; exit 3; fi
EOF
chmod 755 "$ART/libexec/tap/tap" "$ART/libexec/tap/bun" "$ART/bin/tap" "$ART"/hooks/*.sh

# (1) bin/tap execs the router with the public marker and without a leaked BUN_BE_BUN.
env PATH="$NOBUN" BUN_BE_BUN=1 "$ART/bin/tap" send peer -f body.md || fail "bin/tap send exited $?"
[ "$(cat "$LOG/router-argv")" = "$(printf 'send\npeer\n-f\nbody.md')" ] || fail "router argv: $(cat "$LOG/router-argv")"
[ "$(cat "$LOG/router-env")" = "public=1 be_bun=unset" ] || fail "router env: $(cat "$LOG/router-env")"
# Through the ~/.local/bin symlink shape too.
mkdir -p "$WORK/fake-home/.local/bin"; ln -s "$ART/bin/tap" "$WORK/fake-home/.local/bin/tap"
rm -f "${LOG:?}/router-argv"
env PATH="$NOBUN" "$WORK/fake-home/.local/bin/tap" help skill tap || fail "symlinked bin/tap exited $?"
[ "$(cat "$LOG/router-argv")" = "$(printf 'help\nskill\ntap')" ] || fail "symlinked router argv: $(cat "$LOG/router-argv")"
echo "artifact-shell-doors: (1) bin/tap execs the compiled router, public, BUN_BE_BUN removed, also via symlink: ok"

# (2) The debug routes that run a module directly go through the shim.
env PATH="$NOBUN" "$ART/bin/tap" debug recovery list || fail "debug recovery exited $?"
[ "$(head -n 1 "$LOG/shim-argv")" = "$ART/bin/../runtime/bun/src/recovery/artifacts.ts" ] || fail "debug recovery shim argv: $(cat "$LOG/shim-argv")"
[ "$(tail -n 1 "$LOG/shim-argv")" = list ] || fail "debug recovery lost its operand"
echo "artifact-shell-doors: (2) debug recovery runs through libexec/tap/bun: ok"

# (3) Each session-start wrapper runs session-start.ts through the shim.
for pair in tap-advisory.sh:claude tap-codex-session-start.sh:codex tap-cursor-session-start.sh:cursor; do
  hook="${pair%%:*}" harness="${pair##*:}"
  rm -f "${LOG:?}/shim-argv"
  env PATH="$NOBUN" "$ART/hooks/$hook" </dev/null || fail "$hook exited $?"
  [ "$(cat "$LOG/shim-argv")" = "$(printf '%s\n%s' "$ART/runtime/bun/src/session-start.ts" "$harness")" ] || fail "$hook shim argv: $(cat "$LOG/shim-argv" 2>/dev/null)"
done
echo "artifact-shell-doors: (3) the three session-start wrappers run through the shim: ok"

# (4) The guard door passes stdin through and returns the child's stdout and status.
set +e; out="$(printf '{"tool":"payload"}' | env PATH="$NOBUN" "$ART/hooks/tap-shell-body-guard.sh")"; rc=$?; set -e
[ "$rc" = 3 ] || fail "guard door exit $rc, want the child's 3"
[ "$out" = '{"tool":"payload"}' ] || fail "guard door stdout: $out"
[ "$(head -n 1 "$LOG/shim-argv")" = "$ART/hooks/tap-shell-body-guard.ts" ] || fail "guard door shim argv: $(cat "$LOG/shim-argv")"
echo "artifact-shell-doors: (4) the guard door keeps stdin, stdout and the exit status: ok"

# (5) A checkout layout (no libexec/) with no Bun on PATH: the session-start wrappers stay silent and exit 0.
CO="$WORK/checkout"; mkdir -p "$CO/hooks"
cp "$ROOT"/hooks/tap-advisory.sh "$ROOT"/hooks/tap-codex-session-start.sh "$ROOT"/hooks/tap-cursor-session-start.sh "$CO/hooks/"
for hook in tap-advisory.sh tap-codex-session-start.sh tap-cursor-session-start.sh; do
  out="$(env PATH="$NOBUN" bash "$CO/hooks/$hook" </dev/null 2>&1)" || fail "checkout $hook exited nonzero without Bun"
  [ -z "$out" ] || fail "checkout $hook printed without Bun: $out"
done
echo "artifact-shell-doors: (5) checkout-layout wrappers still exit 0 silently without Bun: ok"
echo "artifact-shell-doors: all checks passed (2 router, 1 debug, 3 session-start, 1 guard, 3 checkout no-op)"
