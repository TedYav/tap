#!/usr/bin/env bash
# D5: public — every assertion is on install.sh's exit status, stderr/stdout and the skill directories it leaves behind; chmod and planted files only inject the blockers.
# tap-7io25: one harness home the user cannot write must not stop skill linking
# for the rest. The blocked harness warns once (harness, failing path, a remedy
# that fits the blocker), is left with none of the new links, and the install
# continues to its summary with exit 0 (tap-94co's rule for optional writers).
# TAP_INSTALL_HOOK=0 throughout: skill linking is not behind that gate.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
cleanup_work() {
  chmod -R u+rwx "${WORK:?}" 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup_work EXIT
if [ "$(id -u)" = 0 ]; then
  echo "install-skill-link-writes: the mode-500 arm is inert as root; run as a normal user" >&2
  exit 1
fi

HOMES=(hermes opencode gemini cursor-agent)
fail() { echo "install-skill-link-writes: $1" >&2; [ -z "${2:-}" ] || sed 's/^/  | /' "$2" >&2; exit 1; }

scratch() {
  local arm="$1" h
  S="$WORK/$arm"
  mkdir -p "$S/bin"
  for h in "${HOMES[@]}"; do mkdir -p "$S/$h"; done
  OUT="$S/out"
  ERR="$S/err"
}

run_install() {
  set +e
  TAP_INSTALL_BIN="$S/bin" \
  TAP_CLAUDE_HOME="$S/claude" TAP_CODEX_HOME="$S/codex" TAP_HERMES_HOME="$S/hermes" \
  TAP_CURSOR_HOME="$S/cursor" TAP_OPENCODE_HOME="$S/opencode" TAP_GEMINI_HOME="$S/gemini" \
  TAP_CURSOR_AGENT_HOME="$S/cursor-agent" TAP_AGENTS_HOME="$S/agents" \
  TAP_INDEX_HOME="$S/index" TAP_INSTALL_HOOK=0 \
    bash "$ROOT/install.sh" --verbose >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}

# The warnings this change owns: one per blocked harness, never more.
skip_warnings() {
  mapfile -t WARNS < <(grep 'install: WARNING: skipped .* skill links' "$ERR" || true)
}

assert_continued() {
  local arm="$1" h
  shift
  [ "$RC" = 0 ] || fail "$arm: expected exit 0 after a one-harness failure, got $RC" "$ERR"
  grep -q 'links installed; shell setup required' "$ERR" || fail "$arm: install did not reach its summary" "$ERR"
  skip_warnings
  [ "${#WARNS[@]}" = 1 ] || fail "$arm: expected exactly one skill-link warning, got ${#WARNS[@]}" "$ERR"
  for h in "$@"; do
    [ -L "$S/$h/skills/tap" ] || fail "$arm: $h was left unlinked after an earlier harness failed" "$ERR"
  done
}

assert_untouched() {
  local arm="$1" dir="$2" stray
  stray="$(find "$dir" -type l | head -1)"
  [ -z "$stray" ] || fail "$arm: the blocked harness was left partly linked: $stray"
}

# --- Arm 1: an unwritable home in the middle of the order ----------------------
scratch unwritable
chmod 500 "$S/hermes"
run_install
chmod 700 "$S/hermes"
assert_continued unwritable opencode gemini cursor-agent
[ "${WARNS[0]}" = "install: WARNING: skipped Hermes skill links — could not write $S/hermes/skills (EACCES); next: make $S/hermes writable and rerun ./install.sh (Hermes skills NOT linked; the rest of the install continues)" ] \
  || fail "unwritable: warning does not name the harness, path and fitting remedy: ${WARNS[0]}" "$ERR"
if grep -q 'linked Hermes skill' "$OUT"; then fail "unwritable: a blocked harness was reported as linked" "$OUT"; fi
grep -q 'linked OpenCode skill' "$OUT" || fail "unwritable: the harness after the blocked one did not report success" "$OUT"
[ -z "$(ls -A "$S/hermes")" ] || fail "unwritable: Hermes home is not empty"

# --- Arm 1b: a later flat-host failure still leaves other hosts available ------
scratch unwritable-opencode
chmod 500 "$S/opencode"
run_install
chmod 700 "$S/opencode"
assert_continued unwritable-opencode hermes gemini cursor-agent
grep -q "install: WARNING: skipped OpenCode skill links — could not write $S/opencode/skills (EACCES)" "$ERR" \
  || fail "unwritable-opencode: skill-link warning does not name the path" "$ERR"

# --- Arm 2: a file where the skills directory belongs --------------------------
scratch file-in-the-way
printf '%s\n' personal >"$S/opencode/skills"
run_install
assert_continued file-in-the-way hermes gemini cursor-agent
grep -q "install: WARNING: skipped OpenCode skill links — could not write $S/opencode/skills (E[A-Z]*); next: move $S/opencode/skills aside and rerun ./install.sh" "$ERR" \
  || fail "file-in-the-way: warning does not tell the user to move the file aside" "$ERR"
if grep -q 'writable' "$ERR"; then fail "file-in-the-way: a file in the way was blamed on permissions" "$ERR"; fi
[ "$(cat "$S/opencode/skills")" = personal ] || fail "file-in-the-way: the user's file was changed"

# --- Arm 3: a foreign object on a required skill leaves no partial links --------
scratch foreign
mkdir -p "$S/gemini/skills/tap-help"
printf '%s\n' keep >"$S/gemini/skills/tap-help/sentinel"
run_install
assert_continued foreign hermes opencode cursor-agent
grep -q "install: WARNING: skipped Antigravity skill links — could not write $S/gemini/skills/tap-help" "$ERR" \
  || fail "foreign: warning does not name the blocking object" "$ERR"
[ "$(cat "$S/gemini/skills/tap-help/sentinel")" = keep ] || fail "foreign: the user's directory was changed"
assert_untouched foreign "$S/gemini/skills"

# --- Arm 4: the clean path is unchanged ----------------------------------------
scratch control
run_install
[ "$RC" = 0 ] || fail "control: install failed ($RC)" "$ERR"
skip_warnings
[ "${#WARNS[@]}" = 0 ] || fail "control: spurious skill-link warning" "$ERR"
for h in "${HOMES[@]}"; do
  [ -L "$S/$h/skills/tap" ] || fail "control: $h is not linked" "$ERR"
done
grep -q "install: linked Hermes skill $S/hermes/skills/tap -> $ROOT/skills/tap" "$OUT" || fail "control: no linked line for Hermes" "$OUT"

echo "install-skill-link-writes: a blocked harness warns once with a fitting remedy, is left unlinked, and the install links every other harness"
