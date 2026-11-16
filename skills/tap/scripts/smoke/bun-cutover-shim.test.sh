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
# The shim starts a checkout's Bun under TAP's own config with env-file loading
# off, by a path derived from its own location (never the caller's directory).
CONFIG_ARG="--config=$FIXTURE/bin/../runtime/bun/tap-bunfig.toml"
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
printf '# fixture config\n' > "$FIXTURE/runtime/bun/tap-bunfig.toml"

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
    env -u BUN_INSTALL HOME="$HOME_FIXTURE" PATH="$FAKE_BIN:/bin:/usr/bin" \
      /bin/bash "$SHIM" "${ARGS[@]}"
  ) > "$out"
}

expect_bun() {
  local out="$1"
  {
    printf 'bun\n<%s>\n<--no-env-file>\n<%s>\n' "$CONFIG_ARG" "$MAIN_ARG"
    printf '<%s>\n' "${ARGS[@]}"
  } > "$out"
}

# The install hint follows the platform: Homebrew on macOS, Bun's installer elsewhere.
case "$OSTYPE" in
  darwin*) BUN_HINT="brew install oven-sh/bun/bun" ;;
  *) BUN_HINT="curl -fsSL https://bun.sh/install | bash" ;;
esac
REFUSAL="tap: bun and runtime/bun/main.ts are required; next: $BUN_HINT, then rerun ./install.sh"
# An empty stdout proves the refusal never fell through to another runtime.
expect_refusal() {
  local label="$1" path="${2:-$FAKE_BIN:/bin:/usr/bin}" rc=0
  (
    cd /
    env -u BUN_INSTALL HOME="$HOME_FIXTURE" PATH="$path" \
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

# Bun's own installer leaves the binary off a non-interactive PATH. With no bun
# on PATH the shim looks in $BUN_INSTALL/bin, then ~/.bun/bin; a bun on PATH
# still wins, and a file that is not executable is not a runtime.
mkdir -p "$HOME_FIXTURE/.bun/bin" "$WORK/bun-install/bin"
printf '#!/bin/bash\nprintf "from-home-bun\\n"\n' > "$HOME_FIXTURE/.bun/bin/bun"
printf '#!/bin/bash\nprintf "from-bun-install\\n"\n' > "$WORK/bun-install/bin/bun"
chmod +x "$HOME_FIXTURE/.bun/bin/bun" "$WORK/bun-install/bin/bun"
off_path() {
  ( cd / && env "$@" HOME="$HOME_FIXTURE" PATH=/bin:/usr/bin /bin/bash "$SHIM" "${ARGS[@]}" )
}
got="$(off_path -u BUN_INSTALL)" || fail "home bun: the shim refused with ~/.bun/bin/bun present"
[ "$got" = from-home-bun ] || fail "home bun: expected ~/.bun/bin/bun to run, got: $got"
got="$(off_path BUN_INSTALL="$WORK/bun-install")" || fail "BUN_INSTALL: the shim refused with \$BUN_INSTALL/bin/bun present"
[ "$got" = from-bun-install ] || fail "BUN_INSTALL: expected \$BUN_INSTALL/bin/bun to win over ~/.bun, got: $got"
got="$(off_path BUN_INSTALL="$WORK/absent")" || fail "absent BUN_INSTALL: the shim refused with ~/.bun/bin/bun present"
[ "$got" = from-home-bun ] || fail "absent BUN_INSTALL: expected the ~/.bun fallback, got: $got"
capture "$WORK/path-wins"
cmp "$WORK/expected-bun" "$WORK/path-wins" || fail "a bun on PATH did not win over the installer location"
# The debug entrances run before the router and must use the same resolved Bun.
early() {
  ( cd / && env -u BUN_INSTALL HOME="$HOME_FIXTURE" PATH=/bin:/usr/bin /bin/bash "$SHIM" "$@" )
}
got="$(early help debug)" || fail "help debug: the early entrance did not run ~/.bun/bin/bun"
[ "$got" = from-home-bun ] || fail "help debug: expected ~/.bun/bin/bun to run, got: $got"
got="$(early debug recovery)" || fail "debug recovery: the early entrance did not run ~/.bun/bin/bun"
[ "$got" = from-home-bun ] || fail "debug recovery: expected ~/.bun/bin/bun to run, got: $got"
got="$(early debug _attempt 2>&1 >/dev/null)" || fail "debug _attempt: the capture entrance did not run ~/.bun/bin/bun"
[ "$got" = from-home-bun ] || fail "debug _attempt: expected ~/.bun/bin/bun to run, got: $got"
chmod -x "$HOME_FIXTURE/.bun/bin/bun"
expect_refusal unrunnable-home-bun /bin:/usr/bin

echo "bun-cutover-shim: ok"
