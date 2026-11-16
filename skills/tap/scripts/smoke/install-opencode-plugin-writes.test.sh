#!/usr/bin/env bash
# D5: public — every assertion is on install.sh's exit status, stderr/stdout and the plugin directory it leaves behind; the cp/mv shims only inject the disk failure.
# tap-mbn46: an OpenCode plugin write that fails must not stop the installer midway.
# OpenCode is optional, so a failed write warns loudly (target + one retry
# remedy), the rest of the install continues, the exit is 0 (tap-94co's rule for
# optional user-config writers), and a partial plugin set is never reported as
# installed.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
cleanup_work() {
  chmod -R u+rwx "${WORK:?}" 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup_work EXIT
if [ "$(id -u)" = 0 ]; then
  echo "install-opencode-plugin-writes: the mode-500 arm is inert as root; run as a normal user" >&2
  exit 1
fi

PLUGINS=(tap-opencode-session-start.ts tap-opencode-tmux-guard.ts
  tap-shell-body-guard tap-opencode-session-id tap-resolve-session-root tap-session-context tap)
fail() { echo "install-opencode-plugin-writes: $1" >&2; [ -z "${2:-}" ] || sed 's/^/  | /' "$2" >&2; exit 1; }

# A scratch install tree: every home is private, only OpenCode exists.
scratch() {
  local arm="$1"
  S="$WORK/$arm"
  mkdir -p "$S/opencode/plugins" "$S/bin" "$S/shims"
  printf '#!/bin/sh\necho 1.18.0\n' >"$S/shims/opencode"
  chmod +x "$S/shims/opencode"
  OUT="$S/out"
  ERR="$S/err"
}

run_install() {
  set +e
  PATH="$S/shims:$PATH" TAP_INSTALL_BIN="$S/bin" \
  TAP_CLAUDE_HOME="$S/claude" TAP_CODEX_HOME="$S/codex" TAP_HERMES_HOME="$S/hermes" \
  TAP_CURSOR_HOME="$S/cursor" TAP_OPENCODE_HOME="$S/opencode" TAP_GEMINI_HOME="$S/gemini" \
  TAP_CURSOR_AGENT_HOME="$S/cursor-agent" TAP_AGENTS_HOME="$S/agents" \
  TAP_INDEX_HOME="$S/index" TAP_INSTALL_HOOK=1 \
    bash "$ROOT/install.sh" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}

# A shim for one command that fails when its last argument ends in $2 and
# otherwise runs the real tool: a full disk or a refused rename on one file.
shim_failing() {
  local tool="$1" suffix="$2" real
  real="$(command -v "$tool")"
  cat >"$S/shims/$tool" <<EOF
#!/usr/bin/env bash
case "\${!#}" in
  *"$suffix") echo "$tool: injected failure for \${!#}" >&2; exit 1 ;;
esac
exec "$real" "\$@"
EOF
  chmod +x "$S/shims/$tool"
}

assert_continued() {
  # The installer reached its tail: links are in place and the summary printed.
  [ "$RC" = 0 ] || fail "$1: expected exit 0 after an OpenCode-only failure, got $RC" "$ERR"
  grep -q 'links installed; shell setup required' "$ERR" || fail "$1: install did not reach its summary" "$ERR"
  [ -e "$S/bin/tap" ] || fail "$1: bin link missing — the install stopped midway"
  if grep -q 'installed OpenCode plugins' "$OUT"; then
    fail "$1: a failed OpenCode write was reported as installed" "$OUT"
  fi
}

assert_no_residue() {
  local stray
  stray="$(find "$S/opencode/plugins" -name '.tap-stage.*' -o -name '*.tap-tmp' | head -1)"
  [ -z "$stray" ] || fail "$1: staging residue left behind: $stray"
}

# --- Arm 1: unwritable plugins directory --------------------------------------
scratch unwritable
chmod 500 "$S/opencode/plugins"
run_install
chmod 700 "$S/opencode/plugins"
assert_continued unwritable
grep -q "install: WARNING: skipped OpenCode session plugins — could not write $S/opencode/plugins" "$ERR" \
  || fail "unwritable: warning does not name the target" "$ERR"
grep -q "next: fix the error above (permissions or free space under $S/opencode/plugins) and rerun ./install.sh" "$ERR" \
  || fail "unwritable: warning gives no retry remedy" "$ERR"
[ -z "$(ls -A "$S/opencode/plugins")" ] || fail "unwritable: plugin dir is not empty: $(ls -A "$S/opencode/plugins")"

# --- Arm 1b: an unwritable OpenCode home warns from the skill linker too --------
# With no plugins dir yet, mkdir fails, and so does the linker's own mkdir of
# <home>/skills; the linker warns and the install continues (tap-7io25).
scratch unwritable-home
rmdir "$S/opencode/plugins"
chmod 500 "$S/opencode"
run_install
chmod 700 "$S/opencode"
assert_continued unwritable-home
grep -q "install: WARNING: skipped OpenCode session plugins — could not write $S/opencode/plugins" "$ERR" \
  || fail "unwritable-home: warning does not name the target" "$ERR"
grep -q "install: WARNING: skipped OpenCode skill links — could not write $S/opencode/skills" "$ERR" \
  || fail "unwritable-home: the skill linker did not warn with the failing path" "$ERR"
[ -z "$(ls -A "$S/opencode")" ] || fail "unwritable-home: OpenCode home is not empty: $(ls -A "$S/opencode")"

# --- Arm 2: a disk failure on the third copy publishes nothing -----------------
scratch disk-full
shim_failing cp tap-opencode-tmux-guard.ts
run_install
assert_continued disk-full
grep -q "could not write .*tap-opencode-tmux-guard.ts" "$ERR" || fail "disk-full: warning does not name the failing target" "$ERR"
grep -q "skipped OpenCode session plugins" "$ERR" || fail "disk-full: no skip warning" "$ERR"
for name in "${PLUGINS[@]}"; do
  [ ! -e "$S/opencode/plugins/$name" ] || fail "disk-full: partial set published, found $name"
done
assert_no_residue disk-full

# --- Arm 3: a refused rename after staging says the set may be partial ---------
scratch rename
shim_failing mv tap-resolve-session-root
run_install
assert_continued rename
grep -q "install: WARNING: OpenCode session plugins may be partially updated — could not replace $S/opencode/plugins/tap-resolve-session-root" "$ERR" \
  || fail "rename: warning does not say partial and name the target" "$ERR"
grep -q 'rerun ./install.sh to complete the set' "$ERR" || fail "rename: warning gives no retry remedy" "$ERR"
assert_no_residue rename

# --- Arm 4: a directory squatting on a plugin name is refused, not misfiled -----
scratch squatter
mkdir "$S/opencode/plugins/tap-opencode-session-start.ts"
run_install
assert_continued squatter
grep -q "install: WARNING: skipped OpenCode session plugins — .*tap-opencode-session-start.ts (a directory is in the way)" "$ERR" \
  || fail "squatter: warning does not name the directory" "$ERR"
grep -q "next: move $S/opencode/plugins/tap-opencode-session-start.ts aside and rerun ./install.sh" "$ERR" \
  || fail "squatter: remedy does not tell the user to move the directory aside" "$ERR"
if grep -q "writable" "$ERR"; then fail "squatter: a directory in the way was blamed on permissions" "$ERR"; fi
[ -z "$(ls -A "$S/opencode/plugins/tap-opencode-session-start.ts")" ] || fail "squatter: a plugin was moved into the directory"
[ ! -e "$S/opencode/plugins/tap" ] || fail "squatter: partial set published"

# --- Arm 5: the writable path is unchanged ------------------------------------
scratch control
printf '%s\n' foreign >"$S/opencode/plugins/foreign.ts"
printf '%s\n' 'export default async () => ({})' >"$S/opencode/plugins/tap-opencode-session-env.ts"
run_install
[ "$RC" = 0 ] || fail "control: install failed ($RC)" "$ERR"
grep -q "install: installed OpenCode plugins at $S/opencode/plugins/" "$OUT" || fail "control: no installed line" "$OUT"
grep -q "TAP requires OpenCode 2.x" "$ERR" || fail "control: old OpenCode received no upgrade warning" "$ERR"
if grep -q 'OpenCode session plugins' "$ERR"; then fail "control: spurious OpenCode warning" "$ERR"; fi
for name in "${PLUGINS[@]}"; do
  [ -f "$S/opencode/plugins/$name" ] || fail "control: missing $name"
done
cmp -s "$ROOT/hooks/tap-opencode-session-start.ts" "$S/opencode/plugins/tap-opencode-session-start.ts" \
  || fail "control: copy differs from the checkout"
for name in tap-shell-body-guard tap-opencode-session-id tap-resolve-session-root tap-session-context tap; do
  [ -x "$S/opencode/plugins/$name" ] || fail "control: $name is not executable"
done
# The generated shims run in whatever directory the agent works in. A project's
# bunfig.toml preload must not run in them, and each passes --no-env-file so
# that directory's .env is not loaded either.
HOSTILE="$S/project"
mkdir -p "$HOSTILE"
# The name is passed as an argument so this file holds no relative path to a
# file the repository does not track; the bunfig.toml bytes are unchanged.
printf 'preload = ["./%s"]\n' preload.ts >"$HOSTILE/bunfig.toml"
printf 'require("node:fs").appendFileSync(process.env.TAP_TEST_PRELOAD_MARKER, "ran\\n");\n' >"$HOSTILE/preload.ts"
for name in tap-resolve-session-root tap-shell-body-guard; do
  ( cd "$HOSTILE" && TAP_TEST_PRELOAD_MARKER="$S/preload-marker" "$S/opencode/plugins/$name" </dev/null >"$S/shim.out" 2>&1 ) || true
  [ ! -e "$S/preload-marker" ] || fail "control: $name ran the working directory's bunfig.toml preload" "$S/shim.out"
done
for name in tap-resolve-session-root tap-shell-body-guard tap-session-context; do
  grep -qF -- '--no-env-file' "$S/opencode/plugins/$name" || fail "control: $name does not pass --no-env-file"
done
cat >"$S/want-guard-shim" <<EOF
#!/usr/bin/env bash
c="$ROOT/runtime/bun/tap-bunfig.toml"; [ -f "\$c" ] || c=/dev/null
exec bun --config="\$c" --no-env-file "$ROOT/hooks/tap-shell-body-guard.ts" "\$@"
EOF
cmp -s "$S/want-guard-shim" "$S/opencode/plugins/tap-shell-body-guard" || fail "control: guard shim bytes changed"
# The shim text is also the ownership record: each generated shim must be in the
# manifest with the hash of the bytes on disk, or uninstall would leave it behind.
shim_recorded() { # shim_recorded <name>: prints the number of matching file entries
  python3 - "$S/index/install-manifest.json" "$S/opencode/plugins/$1" <<'PY2'
import hashlib, json, sys
entries = json.load(open(sys.argv[1]))["entries"]
digest = hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
print(sum(1 for e in entries if e.get("kind") == "file" and e.get("path") == sys.argv[2] and e.get("sha256") == digest),
      sum(1 for e in entries if e.get("kind") == "file" and e.get("path") == sys.argv[2]))
PY2
}
for name in tap-shell-body-guard tap-resolve-session-root tap-session-context tap; do
  [ "$(shim_recorded "$name")" = "1 1" ] || fail "control: $name is not recorded once with its on-disk hash: $(shim_recorded "$name")"
done
# An install made before the shim text changed holds the previous bytes and
# their hash. It must still uninstall, and a re-run must rewrite and re-record.
for name in tap-shell-body-guard tap-resolve-session-root tap-session-context; do
  printf '#!/usr/bin/env bash\nexec bun "%s/previous/%s.ts" "$@"\n' "$ROOT" "$name" >"$S/opencode/plugins/$name"
done
python3 - "$S/index/install-manifest.json" "$S/opencode/plugins" <<'PY2'
import hashlib, json, os, sys
path, plugins = sys.argv[1], sys.argv[2]
manifest = json.load(open(path))
for entry in manifest["entries"]:
    if entry.get("kind") == "file" and os.path.dirname(entry["path"]) == plugins and os.path.basename(entry["path"]) in ("tap-shell-body-guard", "tap-resolve-session-root", "tap-session-context"):
        entry["sha256"] = hashlib.sha256(open(entry["path"], "rb").read()).hexdigest()
json.dump(manifest, open(path, "w"))
PY2
# The dry run applies the same ownership check as a removal and leaves this
# checkout's own git configuration alone.
HOME="$S/home" TAP_INDEX_HOME="$S/index" XDG_CONFIG_HOME="$S/xdg" bash "$S/bin/tap" uninstall --dry-run >"$S/dry.out" 2>&1 || fail "control: uninstall --dry-run failed with previous shim bytes" "$S/dry.out"
for name in tap-shell-body-guard tap-resolve-session-root tap-session-context; do
  grep -qF "would remove: $S/opencode/plugins/$name" "$S/dry.out" || fail "control: uninstall would not remove a previous-text $name" "$S/dry.out"
done
run_install
[ "$RC" = 0 ] || fail "control: reinstall over previous shim bytes failed ($RC)" "$ERR"
cmp -s "$S/want-guard-shim" "$S/opencode/plugins/tap-shell-body-guard" || fail "control: reinstall did not rewrite the previous guard shim"
for name in tap-shell-body-guard tap-resolve-session-root tap-session-context; do
  [ "$(shim_recorded "$name")" = "1 1" ] || fail "control: after reinstall $name is not recorded once with its new hash: $(shim_recorded "$name")"
done
[ -f "$S/opencode/plugins/foreign.ts" ] || fail "control: a foreign plugin was removed"
[ ! -e "$S/opencode/plugins/tap-opencode-session-env.ts" ] || fail "control: retired v1 environment plugin remains loadable"
assert_no_residue control

echo "install-opencode-plugin-writes: OpenCode write failures warn with target + remedy, never leave a partial set, and the install continues"
