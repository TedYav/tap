#!/usr/bin/env bash
# install-artifact-mode.test.sh — tap-7r3fn.192 U4: install.sh in a release-artifact tree
# (tap-release.json beside it) installs with no Bun on PATH, registers links and hook commands
# through the logical `current` path, reports the release instead of checkout liveness,
# replaces a previous version's registrations in place, and refuses --sync. libexec/tap/bun is
# a stand-in that execs the runner's Bun; release-artifact-stranger.test.sh runs the compiled one.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/fzf-archive-pin.sh
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "install-artifact-mode: FAIL $*" >&2; exit 1; }
REAL_BUN="$(command -v bun)" || fail "the runner has no bun to stand in for the compiled router"

# The tools an artifact install needs, without Bun. Git is the system one (plan KD4).
TOOLS="$WORK/tools"; mkdir -p "$TOOLS"
for tool in bash jq tmux; do ln -s "$(command -v "$tool")" "$TOOLS/$tool"; done
NOBUN_PATH="$TOOLS:/usr/bin:/bin:/usr/sbin:/sbin"
PATH="$NOBUN_PATH" command -v bun >/dev/null 2>&1 && fail "the no-Bun PATH still finds bun"

# An artifact tree for version $1 at $WORK/prefix/versions/$1: the release build's selection of
# the working tree, a marker, and stand-in libexec/tap/{tap,bun}.
make_version() {
  local version="$1" dest="$WORK/prefix/versions/$1"
  mkdir -p "$dest/libexec/tap"
  (cd "$ROOT" && "$REAL_BUN" -e '
    const { selectArtifactPaths } = await import("./runtime/bun/src/release/artifact-paths.ts");
    const { skillLists } = await import("./runtime/bun/src/release/build.ts");
    const { readFileSync } = await import("node:fs");
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "-co", "--exclude-standard"]).stdout.toString().split("\0").filter(Boolean);
    const paths = selectArtifactPaths(listed, skillLists(readFileSync("runtime/bun/src/skill-policy.ts", "utf8")));
    process.stdout.write(paths.join("\0"));
  ' | tar -c --null -T - -f - | tar -x -C "$dest") || fail "could not stage the artifact tree for $version"
  printf '{\n  "schema": 1,\n  "version": "%s",\n  "commit": "%s",\n  "platform": "test",\n  "bun": "%s"\n}\n' \
    "$version" "abcdef0123456789abcdef0123456789abcdef01" "$("$REAL_BUN" --version)" > "$dest/tap-release.json"
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL_BUN" > "$dest/libexec/tap/bun"
  printf '#!/bin/sh\nexec "%s" "%s/runtime/bun/main.ts" "$@"\n' "$REAL_BUN" "$dest" > "$dest/libexec/tap/tap"
  chmod 755 "$dest/libexec/tap/bun" "$dest/libexec/tap/tap"
}
switch_current() { ln -sfn "versions/$1" "$WORK/prefix/current"; }

S="$WORK/scratch"
run_install() { # [extra args]; targets all in $S, Bun absent from PATH
  set +e
  out="$(env -u TAP_HOME HOME="$WORK/home" PATH="$S/bin:$NOBUN_PATH" TAP_INSTALL_BIN="$S/bin" \
    TAP_CLAUDE_HOME="$S/claude" TAP_CODEX_HOME="$S/codex" TAP_HERMES_HOME="$S/hermes" TAP_CURSOR_HOME="$S/cursor" \
    TAP_OPENCODE_HOME="$S/opencode" TAP_GEMINI_HOME="$S/gemini" TAP_CURSOR_AGENT_HOME="$S/cursor-agent" \
    TAP_AGENTS_HOME="$S/agents" TAP_INDEX_HOME="$S/tap-index" \
    bash "$WORK/prefix/current/install.sh" "$@" </dev/null 2>&1)"
  rc=$?
  set -e
}
mkdir -p "$WORK/home"
# The installer links skills and hooks only into harness homes that exist, as on a machine with
# those harnesses installed.
mkdir -p "$S/claude" "$S/codex" "$S/cursor" "$S/opencode"
CUR="$WORK/prefix/current"

# (1) First install from version one, through the logical current path, with no Bun on PATH.
make_version 0.23-20261001-aaaaaaaaaaaa; switch_current 0.23-20261001-aaaaaaaaaaaa
run_install
[ "$rc" = 0 ] || fail "artifact install rc=$rc: $out"
case "$out" in *"install: done — release 0.23-20261001-aaaaaaaaaaaa (source abcdef012345) at $CUR"*) ;; *) fail "no release done line: $out" ;; esac
case "$out" in *"CANNOT-CHECK"*|*"not a git checkout"*) fail "artifact install reported checkout liveness: $out" ;; esac
[ "$(readlink "$S/bin/tap")" = "$CUR/bin/tap" ] || fail "tap link names $(readlink "$S/bin/tap"), not $CUR/bin/tap"
# Claude and Codex take their skills from the native plugin; the loose link through
# current belongs to a flat host, here OpenCode.
[ "$(readlink "$S/opencode/skills/tap")" = "$CUR/skills/tap" ] || fail "opencode skill link names '$(readlink "$S/opencode/skills/tap" 2>&1)'; skills: $(ls -la "$S/opencode/skills" 2>&1 | head -5); lines: $(printf '%s\n' "$out" | grep -i skill | head -5)"
claude_hooks() { jq -r '[.hooks[][].hooks[]?.command] | .[]' "$S/claude/settings.json"; }
claude_hooks | grep -qx "$CUR/hooks/tap-advisory.sh" || fail "SessionStart not registered through current: $(claude_hooks)"
claude_hooks | grep -qx "$CUR/hooks/tap-shell-body-guard.sh" || fail "guard door not registered through current: $(claude_hooks)"
grep -q "tap-shell-body-guard.sh" "$S/codex/config.toml" || fail "codex config lacks the guard door"
[ "$(cat "$S/opencode/plugins/tap-session-context")" = "$(printf '#!/usr/bin/env bash\nexec "%s/libexec/tap/bun" "%s/runtime/bun/src/session-start.ts" "$@"' "$CUR" "$CUR")" ] \
  || fail "opencode shim bytes: $(cat "$S/opencode/plugins/tap-session-context")"
echo "install-artifact-mode: (1) installs without Bun, registers through current, reports the release: ok"

# (2) Nothing registered names the build checkout; the search is shown able to match.
printf '%s\n' "$ROOT/planted" > "$WORK/control"
grep -rqF "$ROOT" "$WORK/control" || fail "the checkout-path search cannot match"
if grep -rlF "$ROOT" "$S" 2>/dev/null | grep -q .; then fail "registrations name the checkout: $(grep -rlF "$ROOT" "$S")"; fi
echo "install-artifact-mode: (2) no registration names the build checkout: ok"

# (3) Rerun, then a second version through the same current path: replaced in place.
count() { claude_hooks | grep -cx "$CUR/hooks/$1" || true; }
run_install
[ "$rc" = 0 ] || fail "rerun rc=$rc: $out"
[ "$(count tap-advisory.sh)" = 1 ] && [ "$(count tap-shell-body-guard.sh)" = 1 ] || fail "rerun duplicated hooks: $(claude_hooks)"
make_version 0.23-20261002-bbbbbbbbbbbb; switch_current 0.23-20261002-bbbbbbbbbbbb
run_install
[ "$rc" = 0 ] || fail "second version rc=$rc: $out"
case "$out" in *"release 0.23-20261002-bbbbbbbbbbbb"*) ;; *) fail "second version done line: $out" ;; esac
[ "$(count tap-advisory.sh)" = 1 ] && [ "$(count tap-shell-body-guard.sh)" = 1 ] || fail "second version duplicated hooks: $(claude_hooks)"
[ "$(jq '[.hooks[][].hooks[]?.command] | length' "$S/claude/settings.json")" = 2 ] || fail "unexpected claude hook count: $(claude_hooks)"
echo "install-artifact-mode: (3) rerun and a second version keep one entry per hook: ok"

# (4) --sync refuses with [artifact] before any write; a missing tmux names its fix before any write.
S="$WORK/scratch-sync"
run_install --sync
[ "$rc" = 1 ] || fail "--sync rc=$rc: $out"
case "$out" in *"[artifact]"*"rerun tap-bootstrap.sh"*) ;; *) fail "--sync refusal: $out" ;; esac
[ ! -e "$S" ] || fail "--sync wrote under the targets"
S="$WORK/scratch-notmux"
rm "${TOOLS:?}/tmux"
run_install
[ "$rc" != 0 ] || fail "missing tmux still installed"
case "$out" in *"tmux was not found"*"brew install"*) ;; *) fail "missing-tmux message: $out" ;; esac
[ ! -e "$S" ] || fail "a missing prerequisite still wrote under the targets"
echo "install-artifact-mode: (4) --sync refuses [artifact]; a missing tmux stops before writes: ok"
echo "install-artifact-mode: all checks passed (1 install, 1 checkout-path search, 2 reinstalls, 2 refusals)"
