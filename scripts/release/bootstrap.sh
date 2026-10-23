#!/bin/bash
# tap-bootstrap.sh — install TAP from a release archive (tap-7r3fn.192 spike).
#
#   tap-bootstrap.sh --archive <file> --sha256 <hex> [--prefix <dir>] [--setup]
#   tap-bootstrap.sh --url <https://...|file://...> --sha256 <hex> [--prefix <dir>] [--setup]
#
# Integrity, not provenance. The only thing this script trusts is the SHA-256 you pass with
# --sha256; it never fetches a checksum from where the archive came from. It copies (or
# downloads) the archive into a private temporary directory and checks, lists and extracts
# that one copy. Before extracting it refuses any member that is not a regular file or a
# directory under one top-level directory. After extracting into a staging directory it
# checks every file against the archive's INVENTORY, and only then clears macOS quarantine,
# moves the tree to <prefix>/versions/<version>, points <prefix>/current at it and runs its
# install.sh. An archive built for another platform refuses before staging, and every refusal
# before staging writes nothing under the prefix. A version directory already present is
# reused only if it still verifies against this archive's INVENTORY; otherwise it is moved
# aside and replaced, so rerunning the bootstrap repairs a damaged install. One bootstrap at a
# time holds <prefix>/.bootstrap.lock from staging through install.sh.
#
# Refusals print `tap-bootstrap: <class>: <detail>; next: <step>` and exit 1 (usage exits 2).
# Classes: usage, install_path, prerequisite, checksum, member, platform, inventory, install.
#
# Runs under stock macOS /bin/bash 3.2: no associative arrays, no mapfile, no ${x,,}.
set -u

me="tap-bootstrap"
refuse() { # class, detail, next
  printf '%s: %s: %s; next: %s\n' "$me" "$1" "$2" "$3" >&2
  if [ "$1" = usage ]; then exit 2; fi
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: tap-bootstrap.sh (--archive <file> | --url <https-or-file-url>) --sha256 <hex> [--prefix <dir>] [--setup]

Installs a TAP release archive after checking it against the SHA-256 you supply.

Options:
  --archive <file>   a local tap-<version>-<os>-<arch>.tar.gz
  --url <url>        fetch the archive (https:// or file:// only)
  --sha256 <hex>     the archive's expected SHA-256 (64 hex digits), from a channel you trust
  --prefix <dir>     install root (default: ~/.local/share/tap)
                     prefix and HOME must use only A-Z a-z 0-9 / . _ + -
  --setup            run `tap setup --machine` even when a config already exists (needs a
                     terminal). Without it, install.sh still runs first-time setup when it
                     has a terminal and finds no config, as a clone install does.

Refusal classes: usage, install_path, prerequisite, checksum, member, platform, inventory, install.
USAGE
}

archive="" url="" expected="" prefix="${HOME:-}/.local/share/tap" setup=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --archive) [ $# -ge 2 ] || refuse usage "--archive needs a file" "tap-bootstrap.sh --help"; archive="$2"; shift 2 ;;
    --url) [ $# -ge 2 ] || refuse usage "--url needs a URL" "tap-bootstrap.sh --help"; url="$2"; shift 2 ;;
    --sha256) [ $# -ge 2 ] || refuse usage "--sha256 needs a value" "tap-bootstrap.sh --help"; expected="$2"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || refuse usage "--prefix needs a directory" "tap-bootstrap.sh --help"; prefix="$2"; shift 2 ;;
    --setup) setup=1; shift ;;
    *) refuse usage "unknown argument $1" "tap-bootstrap.sh --help" ;;
  esac
done

if [ -n "$archive" ] && [ -n "$url" ]; then refuse usage "pass --archive or --url, not both" "tap-bootstrap.sh --help"; fi
if [ -z "$archive" ] && [ -z "$url" ]; then refuse usage "no archive named" "pass --archive <file> or --url <url>"; fi
expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
case "$expected" in
  *[!0-9a-f]*|"") refuse usage "--sha256 must be 64 hex digits" "copy the checksum exactly as published" ;;
esac
[ "${#expected}" -eq 64 ] || refuse usage "--sha256 must be 64 hex digits" "copy the checksum exactly as published"
case "$prefix" in /*) ;; *) refuse usage "--prefix must be an absolute path" "pass --prefix /absolute/dir" ;; esac
# Registered hooks and generated harness shims still embed paths as shell command text.
# Refuse these paths before downloading or staging, rather than reporting a broken install.
# HOME matters even with an explicit prefix: it is embedded in generated harness files too.
case "$prefix" in
  *[!A-Za-z0-9/._+-]*) refuse install_path "--prefix needs shell quoting, which the installer does not support" "choose an absolute prefix containing only A-Z a-z 0-9 / . _ + -" ;;
esac
case "${HOME:-}" in
  /*) ;;
  *) refuse install_path "HOME must be an absolute path" "run from an account with an absolute HOME" ;;
esac
case "$HOME" in
  *[!A-Za-z0-9/._+-]*) refuse install_path "HOME needs shell quoting, which the installer does not support" "install from an account whose HOME contains only A-Z a-z 0-9 / . _ + -" ;;
esac
if [ -n "$url" ]; then
  case "$url" in
    https://*|file://*) ;;
    *) refuse usage "only https:// and file:// URLs are accepted" "use an https URL or download the file and pass --archive" ;;
  esac
fi

# Tools this script needs, then what install.sh needs, all before any write.
if command -v shasum >/dev/null 2>&1; then sha_cmd=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then sha_cmd=(sha256sum)
else refuse prerequisite "no shasum or sha256sum" "install coreutils (brew install coreutils)"; fi
for tool in tar gzip mktemp find sort; do
  command -v "$tool" >/dev/null 2>&1 || refuse prerequisite "$tool is missing" "install $tool"
done
if [ -n "$url" ]; then command -v curl >/dev/null 2>&1 || refuse prerequisite "curl is missing" "install curl, or download the archive and pass --archive"; fi
command -v git >/dev/null 2>&1 || refuse prerequisite "git is missing" "xcode-select --install (or brew install git)"
command -v bash >/dev/null 2>&1 && bash -c 'test "${BASH_VERSINFO[0]}" -ge 5' 2>/dev/null \
  || refuse prerequisite "bash 5 or newer must be first on PATH" "brew install bash"
for tool in tmux jq; do
  command -v "$tool" >/dev/null 2>&1 || refuse prerequisite "$tool is missing" "brew install $tool"
done

work="$(mktemp -d "${TMPDIR:-/tmp}/tap-bootstrap.XXXXXX")" || refuse prerequisite "cannot create a private temporary directory" "check TMPDIR"
lock="" locked=0
cleanup() {
  if [ "$locked" = 1 ]; then rm -rf "${lock:?}"; fi
  rm -rf "${work:?}"
}
trap cleanup EXIT
copy="$work/archive.tar.gz"
if [ -n "$archive" ]; then
  [ -f "$archive" ] || refuse usage "no archive at $archive" "pass the path of the downloaded .tar.gz"
  cp -- "$archive" "$copy" || refuse prerequisite "cannot copy $archive" "check the file is readable"
else
  curl -fsSL --proto '=https,file' -o "$copy" "$url" || refuse prerequisite "could not fetch $url" "check the URL, or download the file and pass --archive"
fi

actual="$("${sha_cmd[@]}" -- "$copy" | cut -d' ' -f1)"
[ "$actual" = "$expected" ] || refuse checksum "archive sha256 is $actual, expected $expected" "get the archive and its checksum again from a channel you trust"

# Members: names first (no absolute paths, no .. components, one top-level directory),
# then types from the verbose listing (only regular files and directories).
names="$work/names" types="$work/types"
tar -tzf "$copy" > "$names" 2>/dev/null || refuse member "the archive does not list as a gzip tar" "get the archive again"
tar -tvzf "$copy" > "$types" 2>/dev/null || refuse member "the archive does not list as a gzip tar" "get the archive again"
top="$(head -n 1 "$names" | cut -d/ -f1)"
case "$top" in ""|.|..|*[!A-Za-z0-9._+-]*) refuse member "unexpected top-level entry '$top'" "use an archive built by the TAP release build" ;; esac
while IFS= read -r name; do
  case "$name" in
    /*) refuse member "absolute member path $name" "use an archive built by the TAP release build" ;;
    "$top"|"$top/"|"$top"/*) ;;
    *) refuse member "member $name is outside $top/" "use an archive built by the TAP release build" ;;
  esac
  case "/$name/" in */../*|*/./*) refuse member "member $name has a . or .. component" "use an archive built by the TAP release build" ;; esac
done < "$names"
while IFS= read -r line; do
  case "$line" in
    -*|d*) ;;
    *) refuse member "member is not a regular file or directory: $line" "use an archive built by the TAP release build" ;;
  esac
done < "$types"
[ "$(wc -l < "$names")" -eq "$(wc -l < "$types")" ] || refuse member "the name and type listings disagree" "use an archive built by the TAP release build"

# The platform the release marker names must be this machine's, before anything is written.
# The names follow the release build's `${process.platform}-${process.arch}`.
host_platform() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) os="$(uname -s | tr 'A-Z' 'a-z')" ;; esac
  arch="$(uname -m)"
  # A shell under Rosetta reports x86_64 on Apple silicon, where the arm64 build runs natively.
  if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; fi
  case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
  printf '%s-%s\n' "$os" "$arch"
}
marker="$(tar -xzOf "$copy" "$top/tap-release.json" 2>/dev/null)" || refuse member "the archive has no $top/tap-release.json" "use an archive built by the TAP release build"
platform="$(printf '%s\n' "$marker" | sed -n 's/^ *"platform": *"\([^"]*\)".*/\1/p' | head -n 1)"
host="$(host_platform)"
[ -n "$platform" ] || refuse platform "tap-release.json names no platform" "use an archive built by the TAP release build"
[ "$platform" = "$host" ] || refuse platform "the archive is built for $platform; this machine is $host" "get the $host archive of the same version"

# Check a tree against its own INVENTORY: every file's sha256 and executable bit, nothing
# missing and nothing extra. Prints the reason and returns 1 on any difference.
verify_tree() {
  local root="$1" line sum rest flag path
  local expected_sums="$work/expected" actual_sums="$work/actual" expected_x="$work/expected-x" actual_x="$work/actual-x"
  if [ ! -f "$root/INVENTORY" ] || [ -h "$root/INVENTORY" ]; then echo "no INVENTORY"; return 1; fi
  if [ -n "$(cd "$root" && find . ! -type f ! -type d | head -n 1)" ]; then echo "the tree holds something other than files and directories"; return 1; fi
  : > "$expected_x"
  while IFS= read -r line; do
    sum="${line%% *}"; rest="${line#* }"; flag="${rest%% *}"; path="${rest#* }"
    printf '%s  %s\n' "$sum" "$path"
    if [ "$flag" = x ]; then printf '%s\n' "$path" >> "$expected_x"; fi
  done < "$root/INVENTORY" | LC_ALL=C sort > "$expected_sums"
  LC_ALL=C sort -o "$expected_x" "$expected_x"
  (cd "$root" && find . -type f ! -path ./INVENTORY -print | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 "${sha_cmd[@]}" -- 2>/dev/null || true) | LC_ALL=C sort > "$actual_sums"
  (cd "$root" && find . -type f -perm -u+x ! -path ./INVENTORY -print | sed 's|^\./||' | LC_ALL=C sort) > "$actual_x"
  if ! cmp -s "$expected_sums" "$actual_sums"; then echo "files differ from INVENTORY (missing, extra or changed)"; return 1; fi
  if ! cmp -s "$expected_x" "$actual_x"; then echo "executable bits differ from INVENTORY"; return 1; fi
}

# One bootstrap at a time per prefix, from staging through install.sh. A lock whose holder is
# gone is reported, never removed here: only the user can know no other install is running.
mkdir -p "$prefix/versions" || refuse install "cannot create $prefix/versions" "check --prefix is writable"
lock="$prefix/.bootstrap.lock"
if ! mkdir "$lock" 2>/dev/null; then
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  case "$holder" in ""|*[!0-9]*) holder="" ;; esac
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    refuse install "another bootstrap (pid $holder) is installing into $prefix" "wait for it to finish, then rerun"
  fi
  refuse install "$lock is left from a bootstrap (pid ${holder:-unknown}) that is no longer running" "check no install is running, remove $lock, then rerun"
fi
locked=1
printf '%s\n' "$$" > "$lock/pid"

# Stage, then check every file against the inventory before anything else uses it.
stage="$(mktemp -d "$prefix/versions/.stage-XXXXXX")" || refuse install "cannot create a staging directory" "check --prefix is writable"
(umask 022 && tar -xzf "$copy" -C "$stage") || refuse inventory "extraction failed; staging left at $stage" "inspect $stage, then remove it"
root="$stage/$top"
inventory="$root/INVENTORY"
reason="$(verify_tree "$root")" || refuse inventory "$reason; staging left at $stage" "inspect $stage, then remove it"

version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/tap-release.json" 2>/dev/null | head -n 1)"
case "$version" in ""|*[!A-Za-z0-9._+-]*) refuse inventory "tap-release.json names no usable version; staging left at $stage" "use an archive built by the TAP release build" ;; esac
dest="$prefix/versions/$version"
if [ -e "$dest" ] || [ -h "$dest" ]; then
  # Reuse only a copy that still verifies against this archive; otherwise the verified stage
  # replaces it and the old copy is kept aside for inspection.
  damage="a different INVENTORY"
  if [ ! -h "$dest" ] && cmp -s "$inventory" "$dest/INVENTORY" && damage="$(verify_tree "$dest")"; then
    rm -rf "${stage:?}"
  else
    aside="$(mktemp -d "$prefix/versions/.replaced-XXXXXX")" || refuse install "cannot set $dest aside; staging left at $stage" "check --prefix is writable"
    mv "$dest" "$aside/$version" || refuse install "cannot move $dest aside; staging left at $stage" "check --prefix is writable"
    mv "$root" "$dest" || refuse install "cannot move the verified tree to $dest (the old copy is at $aside/$version); staging left at $stage" "check --prefix is writable"
    rmdir "$stage"
    printf '%s: replaced %s, which did not verify against this archive (%s); the old copy is at %s\n' "$me" "$dest" "$damage" "$aside/$version" >&2
  fi
else
  mv "$root" "$dest" || refuse install "cannot move the verified tree to $dest; staging left at $stage" "check --prefix is writable"
  rmdir "$stage"
fi
if [ "$(uname -s)" = Darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
fi

# Name the version current leaves. Compare release components, then the development
# commit count. Unknown legacy formats and same-count parallel builds are unordered.
previous="$(readlink "$prefix/current" 2>/dev/null || true)"
previous="${previous#versions/}"
older_than() {
  local a="$1" b="$2" a_base b_base a_count=0 b_count=0 i x y
  local a_parts=() b_parts=()
  a_base="${a%%+*}"; b_base="${b%%+*}"
  [[ "$a_base" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || return 1
  a_parts=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
  [[ "$b_base" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || return 1
  b_parts=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
  if [ "$a" != "$a_base" ]; then
    [[ "${a#*+}" =~ ^(0|[1-9][0-9]*)\.g[0-9a-f]+$ ]] || return 1
    a_count="${BASH_REMATCH[1]}"
  fi
  if [ "$b" != "$b_base" ]; then
    [[ "${b#*+}" =~ ^(0|[1-9][0-9]*)\.g[0-9a-f]+$ ]] || return 1
    b_count="${BASH_REMATCH[1]}"
  fi
  a_parts+=("$a_count"); b_parts+=("$b_count")
  for i in 0 1 2 3; do
    x="${a_parts[$i]}"; y="${b_parts[$i]}"
    [ "$x" != "$y" ] || continue
    if [ "${#x}" -ne "${#y}" ]; then [ "${#x}" -lt "${#y}" ]; return; fi
    [[ "$x" < "$y" ]]; return
  done
  return 1
}

# Switch current atomically: a new link renamed over the old one.
next_link="$prefix/.current.$$"
ln -s "versions/$version" "$next_link" || refuse install "cannot create $next_link" "check --prefix is writable"
if [ "$(uname -s)" = Darwin ]; then mv -h "$next_link" "$prefix/current"; else mv -T "$next_link" "$prefix/current"; fi \
  || refuse install "cannot switch $prefix/current" "check --prefix is writable"
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  if older_than "$version" "$previous"; then
    printf '%s: %s -> %s (rollback: this archive is older than the release it replaces)\n' "$me" "$previous" "$version"
  else
    printf '%s: %s -> %s\n' "$me" "$previous" "$version"
  fi
fi

install_args=()
if [ "$setup" = 1 ]; then install_args+=(--setup); fi
bash "$prefix/current/install.sh" ${install_args[@]+"${install_args[@]}"}
rc=$?
if [ "$rc" -ne 0 ]; then
  refuse install "$prefix/current/install.sh exited $rc (current now names $version)" "fix the reported problem, then rerun bash $prefix/current/install.sh"
fi
printf '%s: installed %s sha256=%s at %s/current; next: cd into a project (git init it if it is not a repository), run tap init, then tap doctor\n' "$me" "$version" "$actual" "$prefix"
