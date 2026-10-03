#!/usr/bin/env bash
# release-bootstrap-refusals.test.sh — tap-7r3fn.192 U6: scripts/release/bootstrap.sh installs a
# good archive and refuses a wrong checksum, malformed input, a bad member, another platform's
# archive or an inventory mismatch, writing nothing under the prefix before staging. A rerun
# repairs a damaged version directory, and a held prefix lock refuses. Fixtures are small hand-built
# archives with an install.sh stub; the real archive's end-to-end install is the regress test
# release-artifact-stranger.test.sh.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BOOT="$ROOT/scripts/release/bootstrap.sh"
WORK="$(mktemp -d)"
trap 'chmod -R u+w "${WORK:?}" 2>/dev/null || true; rm -rf "${WORK:?}"' EXIT
export COPYFILE_DISABLE=1
VERSION="0.23-20261002-abcdefabcdef"
TOP="tap-$VERSION-test"
# The release build names platforms `${process.platform}-${process.arch}`; the fixtures use
# this host's, as Bun names it, so the bootstrap's own mapping is checked against the producer's.
HOST_PLATFORM="$("${TAP_SMOKE_BUN:-bun}" -e 'process.stdout.write(`${process.platform}-${process.arch}`)')"
[ -n "$HOST_PLATFORM" ] || { echo "release-bootstrap: FAIL could not read the host platform from bun" >&2; exit 1; }

fail() { echo "release-bootstrap: FAIL $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# A valid tree under $1/$TOP: an install.sh stub that records it ran, one executable, a
# release marker and an INVENTORY in the release build's format (`<sha256> <x|-> <path>`).
make_tree() { # src [platform, or "none" to omit it]
  local src="$1" platform="${2:-$HOST_PLATFORM}"
  local top="$src/$TOP"
  mkdir -p "$top/bin" "$top/docs"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$(cd "$(dirname "$0")" && pwd)" >> "$BOOT_MARK"\n' > "$top/install.sh"
  printf '#!/bin/sh\necho tap\n' > "$top/bin/tap"; chmod 755 "$top/bin/tap"
  printf 'hello\n' > "$top/docs/readme.md"
  if [ "$platform" = none ]; then
    printf '{\n  "schema": 1,\n  "version": "%s"\n}\n' "$VERSION" > "$top/tap-release.json"
  else
    printf '{\n  "schema": 1,\n  "version": "%s",\n  "platform": "%s"\n}\n' "$VERSION" "$platform" > "$top/tap-release.json"
  fi
  write_inventory "$top"
}
write_inventory() {
  local top="$1" path flag
  : > "$top/INVENTORY.new"
  while IFS= read -r path; do
    if [ -x "$top/$path" ]; then flag=x; else flag=-; fi
    printf '%s %s %s\n' "$(sha "$top/$path")" "$flag" "$path" >> "$top/INVENTORY.new"
  done < <(cd "$top" && find . -type f ! -name 'INVENTORY*' | sed 's|^\./||' | LC_ALL=C sort)
  mv "$top/INVENTORY.new" "$top/INVENTORY"
}
pack() { (cd "$1" && tar -czPf "$2" "${@:3}"); }

export BOOT_MARK="$WORK/install-ran"
run_boot() { set +e; out="$("$BOOT" "$@" 2>&1)"; rc=$?; set -e; }
expect_refusal() { # class rc prefix-must-stay-absent(0|1) args...
  local class="$1" want="$2" absent="$3"; shift 3
  run_boot "$@"
  [ "$rc" = "$want" ] || fail "$class: rc=$rc want $want: $out"
  case "$out" in *"tap-bootstrap: $class:"*) ;; *) fail "$class: no '$class' refusal line: $out" ;; esac
  if [ "$absent" = 1 ] && [ -e "$PREFIX" ]; then fail "$class: wrote under the prefix before staging"; fi
}

# --- the happy path, then the same archive again ---
SRC="$WORK/src"; make_tree "$SRC"; GOOD="$WORK/good.tar.gz"; pack "$SRC" "$GOOD" "$TOP"
PREFIX="$WORK/prefix-good"
run_boot --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "good archive: rc=$rc: $out"
[ "$(readlink "$PREFIX/current")" = "versions/$VERSION" ] || fail "current does not name versions/$VERSION"
[ "$(cat "$BOOT_MARK")" = "$PREFIX/current" ] || fail "install.sh did not run from the logical current path: $(cat "$BOOT_MARK")"
case "$out" in *"tap-bootstrap: installed $VERSION sha256=$(sha "$GOOD") at $PREFIX/current"*) ;; *) fail "no verdict line: $out" ;; esac
[ -x "$PREFIX/current/bin/tap" ] || fail "the executable bit did not survive"
run_boot --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "rerun of the same archive: rc=$rc: $out"
[ -z "$(find "$PREFIX/versions" -maxdepth 1 -name '.stage-*')" ] || fail "rerun left a staging directory"
case "$out" in *"tap-bootstrap: replaced"*) fail "a rerun over an intact version replaced it: $out" ;; esac
[ ! -e "$PREFIX/.bootstrap.lock" ] || fail "a finished bootstrap left its lock"
echo "release-bootstrap: (1) good archive installs, current switches, install.sh runs from current, rerun reuses, lock released: ok"

# --- a rerun repairs a damaged version directory, keeping the old copy aside ---
printf 'damaged\n' > "$PREFIX/versions/$VERSION/docs/readme.md"
run_boot --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "repair rerun: rc=$rc: $out"
case "$out" in *"tap-bootstrap: replaced $PREFIX/versions/$VERSION, which did not verify against this archive (files differ"*) ;; *) fail "repair rerun did not report the replacement: $out" ;; esac
[ "$(cat "$PREFIX/versions/$VERSION/docs/readme.md")" = hello ] || fail "the damaged file was not restored"
[ "$(readlink "$PREFIX/current")" = "versions/$VERSION" ] || fail "repair moved current"
aside="$(find "$PREFIX/versions" -maxdepth 1 -name '.replaced-*')"
[ "$(printf '%s\n' "$aside" | grep -c .)" = 1 ] && [ "$(cat "$aside/$VERSION/docs/readme.md")" = damaged ] || fail "the damaged copy was not kept aside: $aside"
chmod 644 "$PREFIX/versions/$VERSION/bin/tap"
run_boot --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
case "$out" in *"(executable bits differ"*) ;; *) fail "a lost executable bit was not repaired: rc=$rc $out" ;; esac
[ -x "$PREFIX/versions/$VERSION/bin/tap" ] || fail "the executable bit was not restored"
echo "release-bootstrap: (1b) a changed file and a lost executable bit are each repaired by a rerun, old copy kept aside: ok"

# --- switching versions prints one transition line; an older archive is labelled a rollback ---
case "$out" in *" -> "*) fail "a rerun of the same version printed a transition: $out" ;; esac
case "$out" in *"next: cd into a project (git init it if it is not a repository), run tap init, then tap doctor"*) ;; *) fail "the verdict does not name project initialization before doctor: $out" ;; esac
OLD_VERSION="0.23-20260901-0123456789ab"
VERSION="$OLD_VERSION" TOP="tap-$OLD_VERSION-test" make_tree "$WORK/src-old"
OLD="$WORK/old.tar.gz"; pack "$WORK/src-old" "$OLD" "tap-$OLD_VERSION-test"
run_boot --archive "$OLD" --sha256 "$(sha "$OLD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "rollback archive: rc=$rc: $out"
[ "$(readlink "$PREFIX/current")" = "versions/$OLD_VERSION" ] || fail "rollback did not switch current"
[ "$(printf '%s\n' "$out" | grep -c -- ' -> ')" = 1 ] || fail "rollback printed other than one transition line: $out"
case "$out" in *"tap-bootstrap: $VERSION -> $OLD_VERSION (rollback: this archive is older than the release it replaces)"*) ;; *) fail "rollback was not labelled: $out" ;; esac
run_boot --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "upgrade back: rc=$rc: $out"
[ "$(readlink "$PREFIX/current")" = "versions/$VERSION" ] || fail "upgrade back did not switch current"
case "$out" in *"tap-bootstrap: $OLD_VERSION -> $VERSION"$'\n'*) ;; *) fail "upgrade did not print its transition: $out" ;; esac
case "$out" in *rollback*) fail "an upgrade was labelled a rollback: $out" ;; esac
echo "release-bootstrap: (1c) the verdict names project init before doctor; a rollback and an upgrade each print one transition line: ok"

# --- checksum and usage refusals write nothing ---
PREFIX="$WORK/prefix-refused"
expect_refusal checksum 1 1 --archive "$GOOD" --sha256 "$(printf '0%.0s' {1..64})" --prefix "$PREFIX"
expect_refusal usage 2 1 --archive "$GOOD" --sha256 abc --prefix "$PREFIX"
expect_refusal usage 2 1 --url "http://example.invalid/x.tar.gz" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
expect_refusal usage 2 1 --url "ftp://example.invalid/x.tar.gz" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
expect_refusal usage 2 1 --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
echo "release-bootstrap: (2) wrong or malformed checksum and non-https URLs refuse before any write: ok"

# Paths become shell command text in harness hooks. Refuse before even reading the archive.
for suffix in 'with space' "with'quote" 'with"quote' 'with$dollar' 'with`tick' 'with;semi' 'with\\slash' $'with\ttab' $'with\nnewline'; do
  PREFIX="$WORK/$suffix"
  expect_refusal install_path 1 1 --archive "$WORK/absent.tar.gz" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
done
PREFIX="$WORK/prefix-safe"
out="$(env HOME="$WORK/home with space" /bin/bash "$BOOT" --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX" 2>&1)" && fail "unsafe HOME with explicit safe prefix was accepted"
case "$out" in *'tap-bootstrap: install_path: HOME needs shell quoting'*) ;; *) fail "unsafe HOME refusal: $out" ;; esac
[ ! -e "$PREFIX" ] && [ ! -e "$WORK/home with space" ] || fail "unsafe HOME wrote install state"
out="$(env HOME="$WORK/home with space" /bin/bash "$BOOT" --archive "$GOOD" --sha256 "$(sha "$GOOD")" 2>&1)" && fail "unsafe default prefix was accepted"
case "$out" in *'tap-bootstrap: install_path:'*) ;; *) fail "unsafe default prefix refusal: $out" ;; esac
[ ! -e "$WORK/home with space" ] || fail "unsafe default prefix wrote install state"
echo "release-bootstrap: (2a) 9 unsafe prefixes and unsafe HOME with explicit/default prefix refuse before writes: ok"

# --- another platform's archive, or one naming none, refuses before any write ---
for platform in plan9-mips none; do
  make_tree "$WORK/p-$platform" "$platform"; pack "$WORK/p-$platform" "$WORK/p-$platform.tar.gz" "$TOP"
  expect_refusal platform 1 1 --archive "$WORK/p-$platform.tar.gz" --sha256 "$(sha "$WORK/p-$platform.tar.gz")" --prefix "$PREFIX"
done
case "$out" in *"names no platform"*) ;; *) fail "the platform-less refusal does not say so: $out" ;; esac
echo "release-bootstrap: (2b) an archive for another platform, or naming none, refuses before any write (host $HOST_PLATFORM): ok"

# --- a held prefix lock refuses; a stale one is reported and left in place ---
PREFIX="$WORK/prefix-locked"; mkdir -p "$PREFIX/.bootstrap.lock"
printf '%s\n' "$$" > "$PREFIX/.bootstrap.lock/pid"
expect_refusal install 1 0 --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
case "$out" in *"another bootstrap (pid $$) is installing"*) ;; *) fail "a live lock holder was not named: $out" ;; esac
sh -c 'exit 0' & gone=$!; wait "$gone"
printf '%s\n' "$gone" > "$PREFIX/.bootstrap.lock/pid"
expect_refusal install 1 0 --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
case "$out" in *"(pid $gone) that is no longer running"*"remove $PREFIX/.bootstrap.lock"*) ;; *) fail "a stale lock was not reported with its fix: $out" ;; esac
[ -d "$PREFIX/.bootstrap.lock" ] || fail "the bootstrap removed a lock it did not take"
[ ! -e "$PREFIX/current" ] && [ -z "$(find "$PREFIX/versions" -mindepth 1 -maxdepth 1 2>/dev/null)" ] || fail "a locked prefix was written past the lock"
echo "release-bootstrap: (2c) a live lock holder refuses; a stale lock is reported, kept, and nothing is staged: ok"

# --- member refusals, each before extraction ---
bad_member() { # name, then tar operands relative to $1-src
  local name="$1" src="$WORK/m-$1"; shift
  make_tree "$src"
  case "$name" in
    absolute) printf 'x\n' > "$WORK/abs-file"; pack "$src" "$WORK/$name.tar.gz" "$TOP" "$WORK/abs-file" ;;
    dotdot) printf 'x\n' > "$src/escape"; pack "$src" "$WORK/$name.tar.gz" "$TOP" "$TOP/../escape" ;;
    symlink) ln -s /etc/hosts "$src/$TOP/docs/link"; pack "$src" "$WORK/$name.tar.gz" "$TOP" ;;
    hardlink) ln "$src/$TOP/docs/readme.md" "$src/$TOP/docs/hard"; pack "$src" "$WORK/$name.tar.gz" "$TOP" ;;
    fifo) mkfifo "$src/$TOP/docs/pipe"; pack "$src" "$WORK/$name.tar.gz" "$TOP" ;;
    twotop) mkdir -p "$src/other"; printf 'x\n' > "$src/other/f"; pack "$src" "$WORK/$name.tar.gz" "$TOP" other ;;
  esac
  PREFIX="$WORK/prefix-$name"
  expect_refusal member 1 1 --archive "$WORK/$name.tar.gz" --sha256 "$(sha "$WORK/$name.tar.gz")" --prefix "$PREFIX"
}
for kind in absolute dotdot symlink hardlink fifo twotop; do bad_member "$kind"; done
# Positive control: the member listing really carries the shapes it refuses.
tar -tvzf "$WORK/symlink.tar.gz" | grep -q '^l' || fail "the symlink fixture has no symlink member"
tar -tzf "$WORK/dotdot.tar.gz" | grep -q '\.\./escape' || fail "the dotdot fixture has no .. member"
tar -tzf "$WORK/absolute.tar.gz" | grep -q '^/' || fail "the absolute fixture has no absolute member"
echo "release-bootstrap: (3) absolute, .., symlink, hard link, FIFO and second-top members refuse before extraction: ok"

# --- inventory refusals leave staging for inspection and current unchanged ---
inventory_case() { # name, mutation
  local name="$1" src="$WORK/i-$1"
  make_tree "$src"
  case "$name" in
    missing) printf '%s - docs/absent.md\n' "$(printf 'x' | shasum -a 256 | cut -d' ' -f1)" >> "$src/$TOP/INVENTORY" ;;
    extra) printf 'extra\n' > "$src/$TOP/docs/extra.md" ;;
    changed) printf 'tampered\n' > "$src/$TOP/docs/readme.md" ;;
    modebit) chmod 644 "$src/$TOP/bin/tap" ;;
  esac
  pack "$src" "$WORK/i-$name.tar.gz" "$TOP"
  PREFIX="$WORK/prefix-good"
  local before; before="$(readlink "$PREFIX/current")"
  expect_refusal inventory 1 0 --archive "$WORK/i-$name.tar.gz" --sha256 "$(sha "$WORK/i-$name.tar.gz")" --prefix "$PREFIX"
  local stage; stage="$(find "$PREFIX/versions" -maxdepth 1 -name '.stage-*')"
  [ -n "$stage" ] || fail "inventory $name: no staging left for inspection"
  [ "$(printf '%s\n' "$stage" | wc -l | tr -d ' ')" = 1 ] || fail "inventory $name: more than one staging directory: $stage"
  [ "$(readlink "$PREFIX/current")" = "$before" ] || fail "inventory $name: current moved"
  chmod -R u+w "$PREFIX/versions"
  rm -rf "${stage:?}"
}
for kind in missing extra changed modebit; do inventory_case "$kind"; done
echo "release-bootstrap: (4) missing, extra, changed and mode-changed files refuse after staging, staging kept, current unchanged: ok"

# --- file:// URLs and a strict umask install ---
PREFIX="$WORK/prefix-url"; : > "$BOOT_MARK"
run_boot --url "file://$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX"
[ "$rc" = 0 ] || fail "file:// install: rc=$rc: $out"
PREFIX="$WORK/prefix-umask"
set +e; out="$(umask 077 && "$BOOT" --archive "$GOOD" --sha256 "$(sha "$GOOD")" --prefix "$PREFIX" 2>&1)"; rc=$?; set -e
[ "$rc" = 0 ] || fail "umask 077 install: rc=$rc: $out"
echo "release-bootstrap: (5) file:// URL installs; umask 077 passes the inventory check: ok"

/bin/bash -n "$BOOT" || fail "bootstrap.sh does not parse under /bin/bash $(/bin/bash -c 'echo $BASH_VERSION')"
echo "release-bootstrap: (6) parses under /bin/bash $(/bin/bash -c 'echo $BASH_VERSION'): ok"
echo "release-bootstrap: all checks passed (1 install, 1 rerun, 2 repairs, 5 usage/checksum, 11 install_path, 2 platform, 2 lock, 6 member, 4 inventory, 2 install variants)"
