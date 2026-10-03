#!/usr/bin/env bash
# bash32-parse.test.sh — every TAP shell script must PARSE under /bin/bash.
#
# On macOS /bin/bash is 3.2 forever, and a seat with a minimal PATH resolves
# `env bash` to it — Hermes could not register because tap-register.sh used a
# heredoc-inside-$()-inside-double-quotes pattern that bash 3.2 cannot parse
# ("unexpected EOF looking for matching quote"). A script that does not parse
# fails at exec, before any of our error handling exists. The parse set is the
# whole shell surface: every .sh file plus every extensionless file whose first
# line is a bash/sh shebang (bin/tap, the tracker's hook scripts, …), so a script without
# a .sh name cannot silently drop out of the gate. Each file parses under its
# shebang's shell: bash ones under /bin/bash, pure-sh ones under sh.
#
# (On Linux CI /bin/bash is newer, so there the check is a plain parse gate;
# the 3.2 regression is caught on macOS dev machines, where the suite also runs.)
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

shopt -s nullglob

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

list="$(mktemp)"
gone="$(mktemp)"
trap 'rm -f "$list" "$gone"' EXIT

# Materialize the shell surface first so a legitimate staged-or-unstaged file
# deletion does not leave a vanished path in the parse set: git names the
# deleted-but-indexed paths, so no per-path existence poll is needed. The set is
# the union of every .sh with every tracked-or-untracked file whose first line is
# a bash/sh shebang; paths are read one per line, never word-split. An unreadable
# regular file stays in the set so the parse step reports it.
# Directories, submodules, FIFOs, sockets and devices are never parse candidates,
# and a writerless FIFO must not be opened: the open would block the gate.
special() { [ -d "$1" ] || [ -p "$1" ] || [ -S "$1" ] || [ -b "$1" ] || [ -c "$1" ]; }
git -C "$ROOT" ls-files --deleted >"$gone" ||
  { echo "bash32-parse: git ls-files --deleted failed" >&2; exit 1; }
git -C "$ROOT" ls-files --cached --others --exclude-standard |
  awk 'FILENAME == ARGV[1] { deleted[$0] = 1; next } !($0 in deleted)' "$gone" - |
  while IFS= read -r path; do
    special "$ROOT/$path" && continue
    case "$path" in
      *.sh) printf '%s\n' "$path" ;;
      *)
        # One read of a path git says exists; $first is reset so a failed read
        # cannot leave the previous path's first line behind.
        first=
        IFS= read -r first <"$ROOT/$path" 2>/dev/null || [ -n "$first" ] || continue
        case "$first" in
          '#!'*bash* | '#!'*'/sh'* | '#!'*'env sh'*) printf '%s\n' "$path" ;;
        esac
        ;;
    esac
  done >"$list" ||
    { echo "bash32-parse: git ls-files failed" >&2; exit 1; }

count=$(wc -l <"$list" | tr -d ' ')

# Floor assertion (150) guards against truncated file lists from partial reads or git errors.
if [ "$count" -lt 150 ]; then
  echo "bash32-parse: error: file count ($count) below minimum floor threshold (150)" >&2
  exit 1
fi

# Guard the gap that motivated the shebang union: an extensionless script like
# bin/tap must never silently leave the parse set again.
if ! grep -Fxq 'bin/tap' "$list"; then
  echo "bash32-parse: error: bin/tap not in the parse set — shebang discovery regressed" >&2
  exit 1
fi

fail=0
while IFS= read -r f; do
  case "$f" in
    *.sh) interp=/bin/bash ;;
    *)
      IFS= read -r first <"$ROOT/$f" || :
      case "$first" in
        '#!'*bash*) interp=/bin/bash ;;
        *) interp=/bin/sh ;;
      esac
      ;;
  esac
  "$interp" -n -- "$ROOT/$f" ||
    { echo "bash32-parse: $f does not parse under $interp" >&2; fail=1; }
done <"$list"

[ "$fail" = 0 ] || exit 1

echo "bash32-parse: ok ($count files checked)"
