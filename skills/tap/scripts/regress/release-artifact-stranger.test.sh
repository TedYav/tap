#!/usr/bin/env bash
# release-artifact-stranger.test.sh — tap-7r3fn.192 U7: a stranger with no clone and no Bun
# installs TAP from a release archive and its checksum, then uses it. The build runs on the
# runner's Bun; everything after it runs as the stranger: a fresh HOME, a cwd outside every
# checkout, and a PATH with no Bun (Git is the system one, through a recording shim that counts
# its calls, plan KD4). Native plugin CLIs use the shared captured-contract stand-ins;
# this verifies registration and package metadata, not a real harness's skill picker.
# Nothing is published and no real HOME is touched.
#
# REGRESS, NOT THE PR GATE: it compiles twice and installs twice. Run it through the runner:
#   compute exec --task tap/release-artifact --timeout 20m -- \
#     env TAP_SUITE_DIR=regress bash scripts/smoke-all.sh --only skills/tap/scripts/regress/release-artifact-stranger.test.sh
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/fzf-archive-pin.sh
. "$(dirname "${BASH_SOURCE[0]}")/../smoke/fzf-archive-pin.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
TMUX_NAME="tap-stranger-$$"
cleanup() {
  tmux -L "$TMUX_NAME" kill-server 2>/dev/null || true
  chmod -R u+w "${WORK:?}" 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
fail() { echo "release-artifact-stranger: FAIL $*" >&2; exit 1; }
say() { echo "release-artifact-stranger: $*"; }
REAL_BUN="$(command -v bun)" || fail "the runner has no bun for the build step"

# --- Build: a scratch clone carrying any uncommitted work, two commits, two archives ----------
SRC="$WORK/src"
git clone -q --no-hardlinks "$ROOT" "$SRC"
(cd "$ROOT" && git diff HEAD --binary) | (cd "$SRC" && git apply --allow-empty)
(cd "$ROOT" && git ls-files -z -o --exclude-standard | tar -c --null -T - -f -) | tar -x -C "$SRC"
gitc() { git -C "$SRC" -c user.name=tap-stranger -c user.email=tap-stranger@example.invalid "$@"; }
gitc add -A
gitc diff --cached --quiet || gitc commit -q -m "working tree under test"
FIRST="$(git -C "$SRC" rev-parse HEAD)"
gitc commit -q --allow-empty -m "second release for the upgrade arm"
SECOND="$(git -C "$SRC" rev-parse HEAD)"
build() { # commit out
  "$REAL_BUN" "$SRC/runtime/bun/src/release/build.ts" --repo "$SRC" --commit "$1" --out "$2" | tail -n 1
}
receipt1="$(build "$FIRST" "$WORK/out1")" || fail "build of $FIRST failed"
receipt2="$(build "$SECOND" "$WORK/out2")" || fail "build of $SECOND failed"
say "built: $receipt1"
ARCHIVE1="$(ls "$WORK"/out1/*.tar.gz)" ARCHIVE2="$(ls "$WORK"/out2/*.tar.gz)"
SHA1="$(cut -d' ' -f1 "$ARCHIVE1.sha256")" SHA2="$(cut -d' ' -f1 "$ARCHIVE2.sha256")"
V1="$(basename "$ARCHIVE1" | sed -E 's/^tap-(.*)-[a-z]+-[a-z0-9_]+\.tar\.gz$/\1/')"
V2="$(basename "$ARCHIVE2" | sed -E 's/^tap-(.*)-[a-z]+-[a-z0-9_]+\.tar\.gz$/\1/')"
[ "$V1" != "$V2" ] || fail "the two builds share version $V1"

# --- The stranger's machine ------------------------------------------------------------------
SHOME="$WORK/home"; ELSEWHERE="$WORK/elsewhere"; TOOLS="$WORK/tools"; GITSHIM="$WORK/gitshim"; GITLOG="$WORK/git-calls"
mkdir -p "$SHOME/.claude" "$SHOME/.codex" "$SHOME/.config/opencode" "$ELSEWHERE" "$TOOLS" "$GITSHIM"
printf '{"unrelatedSetting":"keep-me"}\n' > "$SHOME/.claude/settings.json"
printf 'unrelated_setting = "keep-me"\n' > "$SHOME/.codex/config.toml"
printf '{"unrelatedSetting":"keep-me"}\n' > "$SHOME/.config/opencode/opencode.json"
for tool in bash jq; do ln -s "$(command -v "$tool")" "$TOOLS/$tool"; done
# Only the CLI fixtures use the runner's Bun by absolute path. TAP itself must use
# the archive's bundled runtime; `bun` remains absent from the stranger's PATH.
for host in claude codex; do
  printf '#!/bin/sh\nexec "%s" "%s" "%s" "$@"\n' "$REAL_BUN" "$SRC/runtime/bun/test/fixtures/native-plugin-cli.ts" "$host" > "$TOOLS/$host"
  chmod 755 "$TOOLS/$host"
done
# The runner's tmux may be its namespace guard, which finds the real binary beside itself: exec it.
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v tmux)" > "$TOOLS/tmux"; chmod 755 "$TOOLS/tmux"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nexec /usr/bin/git "$@"\n' "$GITLOG" > "$GITSHIM/git"
chmod 755 "$GITSHIM/git"
SPATH="$GITSHIM:$TOOLS:/usr/bin:/bin:/usr/sbin:/sbin"
stranger() { # run as the stranger: their HOME and PATH, no install-target overrides
  env -u TAP_HOME -u TAP_INSTALL_BIN -u TAP_CLAUDE_HOME -u TAP_CODEX_HOME -u TAP_HERMES_HOME -u TAP_CURSOR_HOME \
    -u TAP_OPENCODE_HOME -u TAP_GEMINI_HOME -u TAP_CURSOR_AGENT_HOME -u TAP_AGENTS_HOME -u TAP_INSTALL_MANIFEST \
    -u BUN_INSTALL -u TAP_CHECKOUT_ROOT \
    HOME="$SHOME" CLAUDE_CONFIG_DIR="$SHOME/.claude" CODEX_HOME="$SHOME/.codex" \
    PATH="$SHOME/.local/bin:$SPATH" TAP_INDEX_HOME="$SHOME/.tap" "$@"
}
# Positive controls for the environment itself: no Bun for the stranger, Bun for the runner,
# and a Git log that records.
stranger sh -c 'command -v bun' >/dev/null 2>&1 && fail "the stranger's PATH finds bun"
command -v bun >/dev/null 2>&1 || fail "the absence check cannot find the runner's bun"
stranger git --version >/dev/null
[ "$(wc -l < "$GITLOG" | tr -d ' ')" = 1 ] || fail "the git shim did not record its control call"
: > "$GITLOG"
say "(0) stranger PATH has no bun (the same check finds the runner's), git calls are recorded: ok"

# --- (1) Bootstrap from --archive under stock /bin/bash ----------------------------------------
cp "$WORK/out1/tap-bootstrap.sh" "$WORK/tap-bootstrap.sh"
out="$(cd "$ELSEWHERE" && stranger /bin/bash "$WORK/tap-bootstrap.sh" --archive "$ARCHIVE1" --sha256 "$SHA1" 2>&1)" || fail "bootstrap failed: $out"
PREFIX="$SHOME/.local/share/tap"; CUR="$PREFIX/current"
case "$out" in *"tap-bootstrap: installed $V1 sha256=$SHA1 at $CUR"*) ;; *) fail "no bootstrap verdict line: $out" ;; esac
[ "$(readlink "$CUR")" = "versions/$V1" ] || fail "current names $(readlink "$CUR")"
[ "$(readlink "$SHOME/.local/bin/tap")" = "$CUR/bin/tap" ] || fail "tap link names $(readlink "$SHOME/.local/bin/tap")"
# Flat hosts get core links; Claude and Codex register the complete native plugin.
SKILLS_SHIPPED="$(sed -n 's/^export const CORE_SKILLS = \[\(.*\)\];$/\1/p' "$CUR/runtime/bun/src/skill-policy.ts" | tr ',' '\n' | grep -c '"')"
[ "$SKILLS_SHIPPED" -gt 0 ] || fail "could not count CORE_SKILLS in the installed skill-policy.ts"
skill_links() { find "$1/skills" -mindepth 1 -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' '; }
INVENTORY_ENTRIES="$(wc -l < "$CUR/INVENTORY" | tr -d ' ')"
say "expect: native Claude/Codex plugins, $SKILLS_SHIPPED OpenCode core links, 2 Claude hook commands, $INVENTORY_ENTRIES inventory entries"
for home in .claude .codex; do
  [ "$(skill_links "$SHOME/$home")" = 0 ] || fail "$home still has loose skill links after native plugin installation"
done
[ "$(skill_links "$SHOME/.config/opencode")" = "$SKILLS_SHIPPED" ] || fail "OpenCode core link count differs"
check_plugins() {
  local physical
  physical="$(cd "$CUR" && pwd -P)"
  stranger claude plugin marketplace list --json | jq -e --arg source "$CUR" \
    '[.[] | select(.name == "tap-marketplace" and .source == "directory" and .path == $source)] | length == 1' >/dev/null || fail "Claude marketplace does not name current"
  stranger claude plugin list --json | jq -e \
    '[.[] | select(.id == "tap@tap-marketplace" and .scope == "user" and .enabled == true)] | length == 1' >/dev/null || fail "Claude TAP plugin is not enabled"
  stranger codex plugin marketplace list --json | jq -e --arg source "$physical" \
    '[.marketplaces[] | select(.name == "tap-marketplace" and .marketplaceSource.sourceType == "local" and .marketplaceSource.source == $source)] | length == 1' >/dev/null || fail "Codex marketplace does not name the current release"
  stranger codex plugin list --json | jq -e \
    '[.installed[] | select(.pluginId == "tap@tap-marketplace" and .installed == true and .enabled == true)] | length == 1' >/dev/null || fail "Codex TAP plugin is not enabled"
}
check_plugins
jq -e '.name == "tap-marketplace" and (.plugins | length == 1) and .plugins[0].name == "tap" and .plugins[0].source == "./plugins/tap"' "$CUR/.claude-plugin/marketplace.json" >/dev/null || fail "marketplace package metadata differs"
jq -e '.name == "tap"' "$CUR/plugins/tap/.claude-plugin/plugin.json" >/dev/null || fail "plugin manifest does not name tap"
PLUGIN_SKILLS="$(sed -nE 's/^export const (CORE_SKILLS|OPTIONAL_SKILLS) = \[(.*)\];$/\2/p' "$CUR/runtime/bun/src/skill-policy.ts" | tr ',' '\n' | sed -n 's/.*"\([^"]*\)".*/\1/p' | sort)"
ACTUAL_SKILLS="$(find "$CUR/plugins/tap/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
[ -n "$PLUGIN_SKILLS" ] && [ "$ACTUAL_SKILLS" = "$PLUGIN_SKILLS" ] || fail "plugin skill inventory differs from the public skill policy"
for skill in $PLUGIN_SKILLS; do
  grep -qx "name: $skill" "$CUR/plugins/tap/skills/$skill/SKILL.md" || fail "plugin card has the wrong name: $skill"
done
HIDDEN_SKILLS="$(grep -l '^user-invocable: false$' "$CUR/plugins/tap/skills/"*/SKILL.md | sed 's|/SKILL.md$||; s|.*/||' | sort)"
[ "$HIDDEN_SKILLS" = "$(printf '%s\n' assign outstanding reply send team)" ] || fail "plugin hidden-skill inventory differs: $HIDDEN_SKILLS"
USER_ONLY_SKILLS="$(grep -l '^disable-model-invocation: true$' "$CUR/plugins/tap/skills/"*/SKILL.md | sed 's|/SKILL.md$||; s|.*/||' | sort)"
[ "$USER_ONLY_SKILLS" = help ] || fail "plugin user-only skill inventory differs: $USER_ONLY_SKILLS"
grep -qx '  allow_implicit_invocation: false' "$CUR/plugins/tap/skills/help/agents/openai.yaml" || fail "Codex user-only policy missing for help"
PLUGIN_SKILL_COUNT="$(printf '%s\n' "$PLUGIN_SKILLS" | wc -l | tr -d ' ')"
say "(1) bootstrap from --archive under /bin/bash $(/bin/bash -c 'echo $BASH_VERSION') installed $V1: ok"

# --- (2) The installed tap, from an unrelated directory ----------------------------------------
PROJ="$ELSEWHERE/project"; mkdir -p "$PROJ"
help="$(cd "$ELSEWHERE" && stranger tap help skill tap 2>&1)" || fail "help skill: $help"
[ "$(cd "$(dirname "$help")" && pwd -P)/$(basename "$help")" = "$(cd "$CUR/skills/tap" && pwd -P)/SKILL.md" ] || fail "help skill printed $help"
init="$(cd "$PROJ" && stranger tap init --yes --json 2>&1)" || fail "init: $init"
case "$init" in *'"ok":true'*) ;; *) fail "init did not report ok: $init" ;; esac
[ -d "$PROJ/.tap/bus" ] || fail "init created no bus"
doctor="$(cd "$PROJ" && stranger tap doctor --json 2>/dev/null)" || true
release="$(printf '%s' "$doctor" | jq -c '.findings[] | select(.name == "release") | .detail')"
[ "$(printf '%s' "$release" | jq -r .version)" = "$V1" ] && [ "$(printf '%s' "$release" | jq -r .commit)" = "$FIRST" ] || fail "doctor release: $release"
say "(2) help skill resolves into current, init creates the bus, doctor names $V1 from $(printf '%s' "$FIRST" | cut -c1-12): ok"

# --- (3) Every registered hook runs with a real payload ----------------------------------------
claude_cmds="$(jq -r '[.hooks[][].hooks[]?.command] | .[]' "$SHOME/.claude/settings.json")"
[ "$(printf '%s\n' "$claude_cmds" | grep -c .)" = 2 ] || fail "Claude hook commands: $claude_cmds"
advisory="$(printf '%s\n' "$claude_cmds" | grep 'tap-advisory.sh$')" guard="$(printf '%s\n' "$claude_cmds" | grep 'tap-shell-body-guard.sh$')"
ctx="$(cd "$PROJ" && printf '{}\n' | stranger env CLAUDE_PROJECT_DIR="$PROJ" "$advisory" 2>&1)" || fail "SessionStart hook: $ctx"
[ -n "$ctx" ] || fail "the SessionStart hook printed no context in an initialized project"
deny="$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"tap send peer -m \"$(date)\""}}' | stranger "$guard" 2>&1)" || true
case "$deny" in *'"deny"'*) ;; *) fail "the guard did not deny an inline command substitution: $deny" ;; esac
allow="$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | stranger "$guard" 2>&1)" || true
case "$allow" in *'"deny"'*) fail "the guard denied a plain ls: $allow" ;; esac
codex_hook="$(sed -n 's/.*command = "\(.*tap-codex-session-start.sh\)".*/\1/p' "$SHOME/.codex/config.toml" | head -n 1)"
[ -n "$codex_hook" ] || codex_hook="$CUR/hooks/tap-codex-session-start.sh"
codex="$(printf '{"cwd":"%s","transcript_path":"%s/codex-rollout.jsonl"}\n' "$PROJ" "$WORK" | (cd "$PROJ" && stranger "$codex_hook") 2>&1)" || fail "Codex SessionStart: $codex"
case "$codex" in *hookSpecificOutput*) ;; *) fail "the Codex SessionStart hook printed no context: $codex" ;; esac
resolved="$(stranger "$SHOME/.config/opencode/plugins/tap-resolve-session-root" exact "$PROJ" 2>&1)" || fail "OpenCode resolve shim: $resolved"
[ "$resolved" = "$PROJ" ] || fail "the OpenCode resolve shim printed '$resolved'"
say "(3) Claude SessionStart and guard (deny and allow), Codex SessionStart and the OpenCode shim all run without Bun: ok"

# --- (4) A bus round trip between two poll seats ------------------------------------------------
(cd "$PROJ" && stranger tap register alice --delivery poll >/dev/null 2>&1) || fail "register alice"
(cd "$PROJ" && stranger tap register bob --delivery poll >/dev/null 2>&1) || fail "register bob"
printf 'round trip %s\n' "$SHA1" > "$WORK/body.md"
sent="$(cd "$PROJ" && stranger tap send bob --from alice -f "$WORK/body.md" 2>&1)" || fail "send: $sent"
id="$(printf '%s\n' "$sent" | sed -E -n 's/^tap send: (ok|queued) ([^ ;]+).*/\2/p' | head -n 1)"
[ -n "$id" ] || fail "no message id in: $sent"
read="$(cd "$PROJ" && stranger tap read "$id" --by bob 2>&1)" || fail "read: $read"
case "$read" in *"round trip $SHA1"*) ;; *) fail "bob read a different body: $read" ;; esac
say "(4) alice -> bob poll round trip ($id) reads back the sent body: ok"

# --- (5) BUN_BE_BUN never reaches a TAP child or a tmux server a TAP child starts ---------------
probe="$(stranger env BUN_BE_BUN=1 "$CUR/libexec/tap/bun" -e 'console.log(process.env.BUN_BE_BUN ?? "unset")' 2>&1)"
[ "$probe" = unset ] || fail "a shim child saw BUN_BE_BUN=$probe"
started="$(stranger env BUN_BE_BUN=1 "$CUR/libexec/tap/bun" -e "const r = Bun.spawnSync(['tmux','-L','$TMUX_NAME','new-session','-d','-s','s','/usr/bin/env > $WORK/pane-env; sleep 30']); console.log('rc=' + r.exitCode + ' ' + r.stderr.toString().trim())" 2>&1)" || true
for _ in $(seq 1 50); do [ -s "$WORK/pane-env" ] && break; sleep 0.1; done
[ -s "$WORK/pane-env" ] || fail "the TAP-started tmux pane wrote no environment ($started)"
grep -q '^BUN_BE_BUN=' "$WORK/pane-env" && fail "a tmux pane started by a TAP child inherited BUN_BE_BUN"
stranger tmux -L "$TMUX_NAME" show-environment -g 2>/dev/null | grep -q '^BUN_BE_BUN=' && fail "the tmux server's global environment holds BUN_BE_BUN"
say "(5) BUN_BE_BUN absent from a shim child, a TAP-started tmux pane and that server's global environment: ok"

# --- (6) Nothing registered names a checkout; unrelated settings survive ------------------------
printf '%s\n' "$ROOT/planted" > "$WORK/control"
grep -qF "$ROOT" "$WORK/control" || fail "the checkout-path search cannot match"
for path in "$ROOT" "$SRC"; do
  hits="$(grep -rlF "$path" "$SHOME/.claude" "$SHOME/.codex" "$SHOME/.config/opencode" "$SHOME/.local/bin" 2>/dev/null || true)"
  [ -z "$hits" ] || fail "harness config names $path: $hits"
done
jq -e '.unrelatedSetting == "keep-me"' "$SHOME/.claude/settings.json" >/dev/null || fail "the Claude setting was lost"
grep -q 'unrelated_setting = "keep-me"' "$SHOME/.codex/config.toml" || fail "the Codex setting was lost"
jq -e '.unrelatedSetting == "keep-me"' "$SHOME/.config/opencode/opencode.json" >/dev/null || fail "the OpenCode setting was lost"
say "(6) no harness config names the build checkout or clone; seeded settings survive: ok"

# Git calls so far, before anything arms a watch: plan KD4's stranger path without a loop.
git_breakdown() { # first N lines of the log -> "N (sub=count,...)"
  head -n "$1" "$GITLOG" | awk '{ for (i = 1; i <= NF; i++) { if ($i == "-C") { i++; continue } if ($i !~ /^-/) { print $i; break } } }' \
    | sort | uniq -c | awk -v n="$1" 'BEGIN { printf "%s (", n } { printf "%s%s=%s", sep, $2, $1; sep="," } END { printf ")" }'
}
GIT_BEFORE_WATCH="$(git_breakdown "$(wc -l < "$GITLOG" | tr -d ' ')")"

# --- (7a) A watch sidecar armed before the upgrade (plan KTD5) ---------------------------------
# A pane seat on the private server arms `tap watch`, whose sidecar window runs the loop. TAP's own
# tmux calls reach that server through TMUX, which names its socket.
stranger tmux -L "$TMUX_NAME" new-session -d -s lead -c "$PROJ"
SOCK="$(stranger tmux -L "$TMUX_NAME" display-message -p -t lead '#{socket_path}')"
SPID="$(stranger tmux -L "$TMUX_NAME" display-message -p -t lead '#{pid}')"
LEAD_PANE="$(stranger tmux -L "$TMUX_NAME" display-message -p -t lead '#{pane_id}')"
in_tmux() { stranger env TMUX="$SOCK,$SPID,0" TMUX_PANE="$LEAD_PANE" "$@"; }
reg="$(cd "$PROJ" && in_tmux tap register lead --pane "$LEAD_PANE" 2>&1)" || fail "register lead on $LEAD_PANE: $reg"
armed="$(cd "$PROJ" && in_tmux tap watch on --by lead -m 'stranger sidecar' --evaluator none --interval 1 2>&1)" || fail "watch on: $armed"
SIDECAR_PID=""
for _ in $(seq 1 100); do
  SIDECAR_PID="$(stranger tmux -L "$TMUX_NAME" list-panes -t lead:watch -F '#{pane_pid}' 2>/dev/null | head -n 1)" || true
  [ -n "$SIDECAR_PID" ] && break; sleep 0.1
done
[ -n "$SIDECAR_PID" ] || fail "no watch sidecar window after watch on: $armed"
sidecar_args() { ps -o args= -p "$1" 2>/dev/null || true; }
SIDECAR_BEFORE="$(sidecar_args "$SIDECAR_PID")"
case "$SIDECAR_BEFORE" in *watch-run.ts*) ;; *) fail "sidecar pid $SIDECAR_PID is not the watch loop: $SIDECAR_BEFORE" ;; esac
say "(7a) a watch sidecar (pid $SIDECAR_PID) runs under $V1: $SIDECAR_BEFORE"

# --- (7) file:// install, a tampered archive, then an upgrade -----------------------------------
out="$(stranger /bin/bash "$WORK/tap-bootstrap.sh" --url "file://$ARCHIVE1" --sha256 "$SHA1" 2>&1)" || fail "file:// reinstall: $out"
check_plugins
# Reuse, not repair: a real install.sh and use since step (1) left the version tree verifying.
case "$out" in *"tap-bootstrap: replaced"*) fail "the reinstall found $V1 changed since its install: $out" ;; esac
cp "$ARCHIVE1" "$WORK/tampered.tar.gz"; printf 'x' >> "$WORK/tampered.tar.gz"
set +e; out="$(stranger /bin/bash "$WORK/tap-bootstrap.sh" --archive "$WORK/tampered.tar.gz" --sha256 "$SHA1" 2>&1)"; rc=$?; set -e
[ "$rc" = 1 ] && case "$out" in *"tap-bootstrap: checksum:"*) true ;; *) false ;; esac || fail "tampered archive: rc=$rc $out"
[ "$(readlink "$CUR")" = "versions/$V1" ] || fail "the tampered archive moved current"
out="$(stranger /bin/bash "$WORK/out2/tap-bootstrap.sh" --archive "$ARCHIVE2" --sha256 "$SHA2" 2>&1)" || fail "upgrade: $out"
[ "$(readlink "$CUR")" = "versions/$V2" ] || fail "upgrade left current at $(readlink "$CUR")"
check_plugins
claude_cmds="$(jq -r '[.hooks[][].hooks[]?.command] | .[]' "$SHOME/.claude/settings.json")"
[ "$(printf '%s\n' "$claude_cmds" | grep -c .)" = 2 ] || fail "after the upgrade, Claude hook commands: $claude_cmds"
[ "$(grep -c 'tap-codex-session-start.sh' "$SHOME/.codex/config.toml")" = 1 ] || fail "after the upgrade, Codex SessionStart entries: $(grep -c 'tap-codex-session-start.sh' "$SHOME/.codex/config.toml")"
doctor="$(cd "$PROJ" && stranger tap doctor --json 2>/dev/null)" || true
[ "$(printf '%s' "$doctor" | jq -r '.findings[] | select(.name == "release") | .detail.version')" = "$V2" ] || fail "doctor after the upgrade does not name $V2"
say "(7) file:// reinstall reuses $V1, a tampered archive is refused with current unchanged, $V2 replaces it in place: ok"

# --- (7b) The same compiled sidecar moves to the new release on its next refresh ---------------
SIDECAR_VERDICT=""
for _ in $(seq 1 200); do
  SIDECAR_AFTER="$(sidecar_args "$SIDECAR_PID")"
  case "$SIDECAR_AFTER" in
    *"$PREFIX/versions/$V2/"*watch-run.ts*) SIDECAR_VERDICT="same pid, running $V2"; break ;;
  esac
  sleep 0.1
done
[ -n "$SIDECAR_VERDICT" ] || fail "sidecar did not adopt $V2: ${SIDECAR_AFTER:-exited}"
say "(7b) upgrade verified: $SIDECAR_VERDICT; args now: $SIDECAR_AFTER"
(cd "$PROJ" && in_tmux tap watch off --by lead --force >/dev/null 2>&1) || true

GIT_CALLS="$(wc -l < "$GITLOG" | tr -d ' ')"
say "git calls through (6), before any watch: $GIT_BEFORE_WATCH; whole run, adding the watch arm, its loop's ticks, the reinstall and the upgrade: $(git_breakdown "$GIT_CALLS") — recorded for plan KD4, not asserted"
echo "SMOKE-RECEIPT: release-artifact-stranger: all checks passed: 2 native plugin registrations (CLI fixtures), $PLUGIN_SKILL_COUNT plugin cards (5 hidden), $SKILLS_SHIPPED OpenCode links, 2 Claude hooks, $INVENTORY_ENTRIES inventory entries, versions $V1 -> $V2, bun absent, git calls $GIT_CALLS, sidecar $SIDECAR_VERDICT"
