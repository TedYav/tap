#!/usr/bin/env bash
# claude-live-guard.test.sh — optional compatibility check for the installed
# episodic-memory SessionStart guard. Deterministic test-child coverage lives in
# runtime/bun/test/claude-live-guard.test.ts.
#
# REGRESS, NEVER THE GATE. This does not launch Claude or spend a model call.
set -euo pipefail

PLUGIN="${EPISODIC_MEMORY_PLUGIN:-}"
[ -n "$PLUGIN" ] || { echo "SMOKE-SKIP: claude-live-guard: EPISODIC_MEMORY_PLUGIN unset; optional installed-plugin check not run"; exit 0; }
[ -f "$PLUGIN" ] || { echo "SMOKE-SKIP: claude-live-guard: plugin not found; optional installed-plugin check not run"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SMOKE-SKIP: claude-live-guard: node not installed; optional installed-plugin check not run"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-claude-live-guard.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
for dir in home xdg claude codex config personal archive source; do
  mkdir -p "$WORK/$dir"
done
root_before="$(find "$WORK" -mindepth 1 -prune -print | sort)"

# Pin every higher-priority source/destination override so a broken or ignored
# guard can only take the harmless help path or write inside this scratch tree.
run_help() {
  env -i \
    PATH="$PATH" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/xdg" \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" \
    EPISODIC_MEMORY_CONFIG_DIR="$WORK/config" PERSONAL_SUPERPOWERS_DIR="$WORK/personal" \
    TEST_ARCHIVE_DIR="$WORK/archive" TEST_PROJECTS_DIR="$WORK/source" \
    EPISODIC_MEMORY_DB_PATH="$WORK/db.sqlite" TEST_DB_PATH="$WORK/test-db.sqlite" \
    "$@" node "$PLUGIN" --background --help 2>&1
}

out="$(run_help EPISODIC_MEMORY_SUMMARIZER_GUARD=1)"

if printf '%s\n' "$out" | grep -qE 'episodic-memory: skipping sync inside summarizer-spawned subprocess \(#[0-9]+\)'; then
    result="internal guard diagnostic"
else
    echo "claude-live-guard: unexpected plugin output:" >&2
    printf '%s\n' "$out" >&2
    echo "claude-live-guard: supplied plugin must implement the internal guard" >&2
    exit 1
fi

# This arm is deliberately unguarded but still uses --help. If the installed
# plugin drops or ignores its internal guard, the fallback must remain inert:
# help exits before source/destination resolution and before --background can
# spawn a worker. This proves safety of the compatibility probe, not plugin
# suppression when the guard is absent.
fallback="$(run_help env -u EPISODIC_MEMORY_SUMMARIZER_GUARD)"
printf '%s\n' "$fallback" | grep -qF 'Usage: episodic-memory sync' || {
  echo "claude-live-guard: unguarded help fallback was not harmless:" >&2
  printf '%s\n' "$fallback" >&2
  exit 1
}

# Both the guard path and the help fallback precede destination resolution and
# background spawning. No nested scratch state is expected in either case.
root_after="$(find "$WORK" -mindepth 1 -prune -print | sort)"
[ "$root_after" = "$root_before" ] || {
  echo "claude-live-guard: optional control added root state:" >&2
  diff -u <(printf '%s\n' "$root_before") <(printf '%s\n' "$root_after") >&2 || true
  exit 1
}
unexpected="$(find "$WORK" -mindepth 2 -print)"
[ -z "$unexpected" ] || {
  echo "claude-live-guard: optional control created scratch state:" >&2
  printf '%s\n' "$unexpected" >&2
  exit 1
}

echo "claude-live-guard: $result; no archive/index or worker path: ok"
