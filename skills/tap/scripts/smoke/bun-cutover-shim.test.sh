#!/usr/bin/env bash
# bun-cutover-shim.test.sh — the installed shim execs Bun with identical argv,
# and without a runnable Bun or main.ts it refuses rather than falling back.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
WORK="$(cd -P "$WORK" && pwd)"
FIXTURE="$WORK/repo"
HOME_FIXTURE="$WORK/home"
FAKE_BIN="$WORK/bin"
MAIN="$FIXTURE/runtime/bun/main.ts"
MAIN_ARG="$FIXTURE/bin/../runtime/bun/main.ts"
SHIM="$WORK/link/tap"
ARGS=("whoami" "arg with spaces" '--literal=$(not-executed)')

fail() { echo "bun-cutover-shim: $1" >&2; exit 1; }
cleanup() {
  case "$WORK" in /tmp/*|/private/tmp/*|/var/folders/*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

mkdir -p "$FIXTURE/bin" "$FIXTURE/skills/tap/scripts" "$(dirname "$MAIN")" \
  "$HOME_FIXTURE" "$FAKE_BIN" "$(dirname "$SHIM")"
cp "$ROOT/bin/tap" "$FIXTURE/bin/tap"
printf '// fixture main\n' > "$MAIN"

cat > "$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
printf 'bun\n'
printf '<%s>\n' "$@"
EOF
chmod +x "$FAKE_BIN/bun"
ln -s "$FIXTURE/bin/tap" "$SHIM"

capture() {
  local out="$1"
  shift
  (
    cd /
    env HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/bin:/usr/bin" \
      /bin/bash "$SHIM" "${ARGS[@]}"
  ) > "$out"
}

expect_bun() {
  local out="$1"
  {
    printf 'bun\n<%s>\n' "$MAIN_ARG"
    printf '<%s>\n' "${ARGS[@]}"
  } > "$out"
}

REFUSAL="tap: bun and runtime/bun/main.ts are required; next: brew install oven-sh/bun/bun, then rerun ./install.sh"
# An empty stdout proves the refusal never fell through to another runtime.
expect_refusal() {
  local label="$1" path="${2:-$FAKE_BIN:/bin:/usr/bin}" rc=0
  (
    cd /
    env HOME="$HOME_FIXTURE" PATH="$path" \
      /bin/bash "$SHIM" "${ARGS[@]}"
  ) > "$WORK/$label.out" 2> "$WORK/$label.err" || rc=$?
  [ "$rc" -eq 1 ] || fail "$label: expected exit 1, got $rc"
  [ ! -s "$WORK/$label.out" ] || fail "$label: reached a fallback: $(cat "$WORK/$label.out")"
  grep -qxF "$REFUSAL" "$WORK/$label.err" || fail "$label: missing the install refusal: $(cat "$WORK/$label.err")"
}

expect_bun "$WORK/expected-bun"

capture "$WORK/default"
cmp "$WORK/expected-bun" "$WORK/default" || fail "available Bun runtime was not preferred with identical argv"

cat > "$FAKE_BIN/bun" <<'EOF'
#!/no/such/interpreter
EOF
chmod +x "$FAKE_BIN/bun"
expect_refusal broken-bun

cat > "$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
printf 'bun\n'
printf '<%s>\n' "$@"
EOF
chmod +x "$FAKE_BIN/bun"

rm "$MAIN"
expect_refusal no-main
: > "$MAIN"
expect_refusal empty-main
printf '// fixture main\n' > "$MAIN"

expect_refusal no-bun /bin:/usr/bin

echo "bun-cutover-shim: ok"
