#!/usr/bin/env bash
# D5: public — the runtime/bun/src copies (:55-57, :217-218) are file dependencies so install.sh (the public entry) can run; all assertions are on install.sh's refusal/guard behavior.
# install-primary-guard.test.sh — real user targets may only be installed from
# the persistent primary checkout. Linked worktrees must redirect every target
# to scratch or use the explicit emergency override.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
PRIMARY="$WORK/primary"
LANE="$WORK/lane"

cleanup() {
  git -C "$PRIMARY" worktree remove --force "$LANE" >/dev/null 2>&1 || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

# A developer may have installer targets exported in their shell. Default-target
# cases must test HOME-derived paths, never inherit and mutate those live targets.
# install.sh turns a broken recorder into a WARNING plus exit 0, so a green
# run is only evidence if the WARNING is asserted absent (tap-remind-lock gap).
recorder_ran() {
  case "$1" in
    *"manifest recording incomplete"*|*"manifest recording failed"*)
      echo "install-primary-guard: fixture recorder did not run cleanly: $1" >&2; exit 1;;
  esac
}

run_install_without_inherited_targets() {
  env \
    -u TAP_INSTALL_BIN \
    -u TAP_CLAUDE_HOME \
    -u TAP_CODEX_HOME \
    -u TAP_HERMES_HOME \
    -u TAP_CURSOR_HOME \
    -u TAP_OPENCODE_HOME \
    -u TAP_CURSOR_AGENT_HOME \
    -u TAP_AGENTS_HOME \
    -u TAP_INDEX_HOME \
    "$@"
}

INHERITED_INDEX_HOME="$WORK/inherited-index"
export TAP_INDEX_HOME="$INHERITED_INDEX_HOME"

# Build a disposable repository so this smoke is valid whether the suite itself
# runs from the persistent checkout or a linked worktree.
mkdir -p "$PRIMARY/bin"
printf '#!/bin/sh\necho tap-fixture\n' > "$PRIMARY/bin/tap"
chmod +x "$PRIMARY/bin/tap"
cp "$ROOT/install.sh" "$PRIMARY/install.sh"
mkdir -p "$PRIMARY/runtime/bun/src"
# install.sh's Bun import closure; the manifest recorder runs at EXIT on every install.
cp "$ROOT/runtime/bun/src/"{config-file,config-error,skill-policy,install-harness-state,install-skill-links,install-skill-plugin,install-manifest,install-fzf,fzf-tool,install-hooks,install-history,watch-detect,lossless-json,pyint,spool-publication,fsatomic,panelock,remind-lock,unicode-decimal,codex-fence}.ts "$PRIMARY/runtime/bun/src/"
cp -R "$ROOT/skills/." "$PRIMARY/skills"
cp -R "$ROOT/vendor" "$PRIMARY/vendor"
mkdir -p "$PRIMARY/skills/lead/references/ingest"
cp "$ROOT/skills/lead/references/ingest/README.md" "$PRIMARY/skills/lead/references/ingest/README.md"
# A fixture main/master guard hook, marked with the attributes install.sh reads:
# tap-hooks names the hooks directory to arm, tap-hook-marker the token whose
# absence means an installer overwrote the hook.
write_guard_hook() {
  mkdir -p "$1/githooks"
  printf 'pre-push tap-hooks tap-hook-marker=fixture-guard\n' > "$1/githooks/.gitattributes"
  cat > "$1/githooks/pre-push" <<'HOOK'
#!/usr/bin/env sh
# fixture-guard: refuse any push that creates or updates main or master.
while read -r _local_ref _local_oid remote_ref _remote_oid; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master) echo "fixture-guard: NOT PERMITTED TO OVERRIDE $remote_ref" >&2; exit 1 ;;
  esac
done
exit 0
HOOK
  chmod +x "$1/githooks/pre-push"
}
write_guard_hook "$PRIMARY"
git -C "$PRIMARY" init -q
git -C "$PRIMARY" add install.sh runtime vendor bin skills/lead/references/ingest/README.md githooks
git -C "$PRIMARY" -c user.name=TAP -c user.email=tap@example.invalid commit -qm seed
git -C "$PRIMARY" worktree add -q --detach "$LANE" HEAD

# (1) A linked worktree using default user targets refuses before the first write.
REAL_HOME="$WORK/real-home"
mkdir -p "$REAL_HOME"
set +e
refusal="$(run_install_without_inherited_targets PATH="$REAL_HOME/.local/bin:$PATH" HOME="$REAL_HOME" TAP_INSTALL_HOOK=0 bash "$LANE/install.sh" 2>&1)"
refusal_rc=$?
set -e
recorder_ran "$refusal"
[ "$refusal_rc" -ne 0 ] || { echo "install-primary-guard: (1) linked worktree real-target install unexpectedly succeeded" >&2; exit 1; }
[[ "$refusal" == *"$PRIMARY"* ]] || { echo "install-primary-guard: (1) refusal did not name primary checkout: $refusal" >&2; exit 1; }
[ ! -e "$REAL_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (1) refusal happened after mutating the binary target" >&2; exit 1; }
[ ! -e "$REAL_HOME/.tap" ] || { echo "install-primary-guard: (1) refusal happened after mutating the index target" >&2; exit 1; }
echo "install-primary-guard: (1) linked worktree real targets refuse before mutation: ok"

# (2) Every explicitly redirected target makes a linked-worktree test install safe.
SCRATCH="$WORK/scratch"
PATH="$SCRATCH/bin:$PATH" TAP_INSTALL_BIN="$SCRATCH/bin" \
TAP_CLAUDE_HOME="$SCRATCH/claude" \
TAP_CODEX_HOME="$SCRATCH/codex" \
TAP_HERMES_HOME="$SCRATCH/hermes" \
TAP_CURSOR_HOME="$SCRATCH/cursor" \
TAP_OPENCODE_HOME="$SCRATCH/opencode" \
TAP_GEMINI_HOME="$SCRATCH/gemini" \
TAP_CURSOR_AGENT_HOME="$SCRATCH/cursor-agent" \
TAP_AGENTS_HOME="$SCRATCH/agents" \
TAP_INDEX_HOME="$SCRATCH/tap-index" \
TAP_INSTALL_HOOK=0 \
  bash "$LANE/install.sh" >/dev/null
[ -L "$SCRATCH/bin/tap" ] || { echo "install-primary-guard: (2) all-scratch install did not create its binary link" >&2; exit 1; }
[ -L "$SCRATCH/tap-index/ingest/README.md" ] || { echo "install-primary-guard: (2) all-scratch install did not create the ingest contract link" >&2; exit 1; }
[ "$(readlink "$SCRATCH/tap-index/ingest/README.md")" = "$LANE/skills/lead/references/ingest/README.md" ] \
  || { echo "install-primary-guard: (2) ingest contract link points at the wrong canonical file" >&2; exit 1; }
echo "install-primary-guard: (2) all targets redirected from a worktree: ok"

# The exception is all-or-nothing: one default target keeps the guard armed.
PARTIAL="$WORK/partial"
set +e
PATH="$PARTIAL/bin:$PATH" TAP_INSTALL_BIN="$PARTIAL/bin" \
TAP_CLAUDE_HOME="$PARTIAL/claude" \
TAP_CODEX_HOME="$PARTIAL/codex" \
TAP_HERMES_HOME="$PARTIAL/hermes" \
TAP_CURSOR_HOME="$PARTIAL/cursor" \
TAP_OPENCODE_HOME="$PARTIAL/opencode" \
TAP_GEMINI_HOME="$PARTIAL/gemini" \
TAP_CURSOR_AGENT_HOME="$PARTIAL/cursor-agent" \
TAP_INDEX_HOME="$PARTIAL/tap-index" \
TAP_INSTALL_HOOK=0 \
  bash "$LANE/install.sh" >/dev/null 2>&1
partial_rc=$?
set -e
[ "$partial_rc" -ne 0 ] || { echo "install-primary-guard: (2b) partial redirect unexpectedly bypassed guard" >&2; exit 1; }
[ ! -e "$PARTIAL/bin/tap" ] || { echo "install-primary-guard: (2b) partial redirect mutated before refusal" >&2; exit 1; }
[ ! -e "$PARTIAL/tap-index" ] || { echo "install-primary-guard: (2b) partial redirect mutated the index before refusal" >&2; exit 1; }
echo "install-primary-guard: (2b) partial redirects still refuse: ok"

# (3) The persistent primary checkout remains the normal real-target install path.
PRIMARY_HOME="$WORK/primary-home"
mkdir -p "$PRIMARY_HOME"
run_install_without_inherited_targets PATH="$PRIMARY_HOME/.local/bin:$PATH" HOME="$PRIMARY_HOME" TAP_INSTALL_HOOK=0 bash "$PRIMARY/install.sh" >/dev/null
[ -L "$PRIMARY_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (3) primary install did not create its binary link" >&2; exit 1; }
[ -L "$PRIMARY_HOME/.tap/ingest/README.md" ] || { echo "install-primary-guard: (3) primary install did not create its ingest contract link" >&2; exit 1; }
echo "install-primary-guard: (3) primary checkout real targets allowed: ok"

# Reinstall refreshes an existing stale or dangling contract symlink in place.
ln -sfn "$WORK/stale-ingest-contract" "$PRIMARY_HOME/.tap/ingest/README.md"
run_install_without_inherited_targets PATH="$PRIMARY_HOME/.local/bin:$PATH" HOME="$PRIMARY_HOME" TAP_INSTALL_HOOK=0 bash "$PRIMARY/install.sh" >/dev/null
[ "$(readlink "$PRIMARY_HOME/.tap/ingest/README.md")" = "$PRIMARY/skills/lead/references/ingest/README.md" ] \
  || { echo "install-primary-guard: (3a) reinstall did not refresh a stale ingest contract link" >&2; exit 1; }
echo "install-primary-guard: (3a) stale ingest contract link refreshed: ok"

# A user-owned README is evidence, not an installer target. Refuse to replace it.
rm "$PRIMARY_HOME/.tap/ingest/README.md"
printf 'keep me\n' > "$PRIMARY_HOME/.tap/ingest/README.md"
owned_notice="$(run_install_without_inherited_targets PATH="$PRIMARY_HOME/.local/bin:$PATH" HOME="$PRIMARY_HOME" TAP_INSTALL_HOOK=0 bash "$PRIMARY/install.sh" 2>&1 >/dev/null)"
[ "$(cat "$PRIMARY_HOME/.tap/ingest/README.md")" = 'keep me' ] \
  || { echo "install-primary-guard: (3b) install replaced a user-owned ingest README" >&2; exit 1; }
[[ "$owned_notice" == *'exists and is not a symlink'* ]] \
  || { echo "install-primary-guard: (3b) refusal left no warning: $owned_notice" >&2; exit 1; }
echo "install-primary-guard: (3b) user-owned ingest README preserved: ok"

# (4) The named override is explicit and narrow enough for emergency recovery.
FORCED_HOME="$WORK/forced-home"
mkdir -p "$FORCED_HOME"
forced_notice="$(run_install_without_inherited_targets PATH="$FORCED_HOME/.local/bin:$PATH" HOME="$FORCED_HOME" TAP_INSTALL_HOOK=0 TAP_INSTALL_FORCE_NONPRIMARY=1 \
  bash "$LANE/install.sh" 2>&1 >/dev/null)"
[ -L "$FORCED_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (4) force override did not permit install" >&2; exit 1; }
[[ "$forced_notice" == *"FORCE non-primary install from $LANE (primary: $PRIMARY)"* ]] \
  || { echo "install-primary-guard: (4) force override did not leave a stderr breadcrumb: $forced_notice" >&2; exit 1; }
echo "install-primary-guard: (4) explicit non-primary override allowed with warning: ok"

# (5) A non-git source copy cannot prove that it is the persistent primary, so
# default real targets refuse before mutation under the same fail-closed rule.
NONGIT="$WORK/non-git"
mkdir -p "$NONGIT/skills/lead/references/ingest"
cp "$PRIMARY/install.sh" "$NONGIT/install.sh"
cp -R "$PRIMARY/runtime" "$NONGIT/runtime"
cp -R "$PRIMARY/vendor" "$NONGIT/vendor"
cp -R "$PRIMARY/bin" "$NONGIT/bin"
cp -R "$PRIMARY/skills/." "$NONGIT/skills"
NONGIT_HOME="$WORK/non-git-home"
mkdir -p "$NONGIT_HOME"
set +e
nongit_refusal="$(run_install_without_inherited_targets PATH="$NONGIT_HOME/.local/bin:$PATH" HOME="$NONGIT_HOME" TAP_INSTALL_HOOK=0 bash "$NONGIT/install.sh" 2>&1)"
nongit_rc=$?
set -e
[ "$nongit_rc" -ne 0 ] || { echo "install-primary-guard: (5) non-git real-target install unexpectedly succeeded" >&2; exit 1; }
[[ "$nongit_refusal" == *"not a git checkout"* ]] \
  || { echo "install-primary-guard: (5) non-git refusal did not explain why checkout identity is unverified: $nongit_refusal" >&2; exit 1; }
[ ! -e "$NONGIT_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (5) non-git refusal happened after mutating the binary target" >&2; exit 1; }
[ ! -e "$NONGIT_HOME/.tap" ] || { echo "install-primary-guard: (5) non-git refusal happened after mutating the index target" >&2; exit 1; }
echo "install-primary-guard: (5) non-git real targets refuse before mutation: ok"

# Fully redirected non-git execution remains a safe scratch-install exception.
NONGIT_SCRATCH="$WORK/non-git-scratch"
PATH="$NONGIT_SCRATCH/bin:$PATH" TAP_INSTALL_BIN="$NONGIT_SCRATCH/bin" \
  TAP_CLAUDE_HOME="$NONGIT_SCRATCH/claude" \
  TAP_CODEX_HOME="$NONGIT_SCRATCH/codex" \
  TAP_HERMES_HOME="$NONGIT_SCRATCH/hermes" \
  TAP_CURSOR_HOME="$NONGIT_SCRATCH/cursor" \
  TAP_OPENCODE_HOME="$NONGIT_SCRATCH/opencode" \
  TAP_GEMINI_HOME="$NONGIT_SCRATCH/gemini" \
  TAP_CURSOR_AGENT_HOME="$NONGIT_SCRATCH/cursor-agent" \
  TAP_AGENTS_HOME="$NONGIT_SCRATCH/agents" \
  TAP_INDEX_HOME="$NONGIT_SCRATCH/tap-index" \
  TAP_INSTALL_HOOK=0 \
  bash "$NONGIT/install.sh" >/dev/null
[ -L "$NONGIT_SCRATCH/bin/tap" ] || { echo "install-primary-guard: (5b) all-scratch non-git install did not proceed" >&2; exit 1; }
[ -L "$NONGIT_SCRATCH/tap-index/ingest/README.md" ] || { echo "install-primary-guard: (5b) all-scratch non-git install did not link the ingest contract" >&2; exit 1; }
echo "install-primary-guard: (5b) all-targets-redirected non-git install allowed: ok"

# (5f)/(5g) THE TWO CAUSAL CONTROLS FOR THE PRE-PUSH GUARD (tap-xmuwz).
#
# Scope is deliberately narrow: the guard activates only on the
# supported primary-install path. Forced/non-primary runs, source archives,
# hand-written hook paths and hook development from a lane are outside its
# acceptance surface, so they get no arms here — an arm for an unsupported
# topology asserts a promise nobody made.
#
# A REAL PRIMARY IS REQUIRED, because that is the only path that activates. The
# fixture is a standalone clone whose install.sh runs against itself, which is
# what `primary_root == REPO` means.
INSTALL_REPO="$WORK/install-arms-guard"
rm -rf "${INSTALL_REPO:?}"
git init -q "$INSTALL_REPO"
mkdir -p "$INSTALL_REPO/skills/lead/references/ingest" "$INSTALL_REPO/githooks"
cp "$ROOT/install.sh" "$INSTALL_REPO/install.sh"
mkdir -p "$INSTALL_REPO/runtime/bun/src"
cp "$ROOT/runtime/bun/src/"{config-file,config-error,skill-policy,install-harness-state,install-skill-links,install-skill-plugin,install-manifest,install-fzf,fzf-tool,install-hooks,install-history,watch-detect,lossless-json,pyint,spool-publication,fsatomic,panelock,remind-lock,unicode-decimal,codex-fence}.ts "$INSTALL_REPO/runtime/bun/src/"
cp -R "$ROOT/skills/." "$INSTALL_REPO/skills"
cp -R "$ROOT/vendor" "$INSTALL_REPO/vendor"
cp -R "$PRIMARY/bin" "$INSTALL_REPO/bin"
cp "$ROOT/skills/lead/references/ingest/README.md" "$INSTALL_REPO/skills/lead/references/ingest/README.md"
# An UNGUARDED predecessor commit first: (5g) needs a stale worktree whose own
# bytes carry no guard, and seeding straight from $ROOT would make the "stale"
# tree guarded and refuse the push for the wrong reason. That version of this
# fixture passed while discriminating nothing.
printf 'pre-push tap-hooks tap-hook-marker=fixture-guard\n' > "$INSTALL_REPO/githooks/.gitattributes"
printf '#!/usr/bin/env sh\n# UNGUARDED predecessor\nexit 0\n' > "$INSTALL_REPO/githooks/pre-push"
chmod +x "$INSTALL_REPO/githooks/pre-push"
git -C "$INSTALL_REPO" add -A
git -C "$INSTALL_REPO" -c user.name=TAP -c user.email=tap@example.invalid commit -qm "unguarded predecessor"
OLD_SHA="$(git -C "$INSTALL_REPO" rev-parse HEAD)"
write_guard_hook "$INSTALL_REPO"
git -C "$INSTALL_REPO" add -A
git -C "$INSTALL_REPO" -c user.name=TAP -c user.email=tap@example.invalid commit -qm "guarded hook"
[ -z "$(git -C "$INSTALL_REPO" config --local core.hooksPath || true)" ] \
  || { echo "install-primary-guard: (5f) fixture setup: core.hooksPath should start unset" >&2; exit 1; }

INSTALL_SCRATCH="$WORK/install-arms-scratch"
set +e
arm_out="$(PATH="$INSTALL_SCRATCH/bin:$PATH" TAP_INSTALL_BIN="$INSTALL_SCRATCH/bin" TAP_CLAUDE_HOME="$INSTALL_SCRATCH/claude" \
  TAP_CODEX_HOME="$INSTALL_SCRATCH/codex" TAP_HERMES_HOME="$INSTALL_SCRATCH/hermes" \
  TAP_CURSOR_HOME="$INSTALL_SCRATCH/cursor" TAP_OPENCODE_HOME="$INSTALL_SCRATCH/opencode" \
  TAP_GEMINI_HOME="$INSTALL_SCRATCH/gemini" TAP_CURSOR_AGENT_HOME="$INSTALL_SCRATCH/cursor-agent" \
  TAP_AGENTS_HOME="$INSTALL_SCRATCH/agents" TAP_INDEX_HOME="$INSTALL_SCRATCH/tap-index" \
  TAP_INSTALL_HOOK=0 bash "$INSTALL_REPO/install.sh" 2>&1)"
arm_rc=$?
set -e
recorder_ran "$arm_out"
[ "$arm_rc" -eq 0 ] || { echo "install-primary-guard: (5f) installer exited $arm_rc: $arm_out" >&2; exit 1; }
INSTALL_EXPECT="$(cd "$INSTALL_REPO" && pwd -P)/githooks"
armed_hp="$(git -C "$INSTALL_REPO" config --local core.hooksPath || true)"
[ "$armed_hp" = "$INSTALL_EXPECT" ] \
  || { echo "install-primary-guard: (5f) the installer did NOT arm the pre-push guard — core.hooksPath is [$armed_hp], expected [$INSTALL_EXPECT]. The activation wiring is missing or inert." >&2; exit 1; }
[[ "$arm_out" != *"tap-hook-marker"* ]] \
  || { echo "install-primary-guard: (5f) the marker warning fired on an intact guard: $arm_out" >&2; exit 1; }
echo "install-primary-guard: (5f) the real primary installer arms the absolute hook path: ok"

# (5f-neg) A clone that marks no tap-hooks files (an exported or end-user clone,
# which carries no contributor hook directory) is left alone: core.hooksPath stays unset.
# tap-yrgg6: the contributor guard must not reach an end user's install clone.
NOHOOKS_REPO="$WORK/install-no-hooks"
rm -rf "${NOHOOKS_REPO:?}"
git clone -q "$INSTALL_REPO" "$NOHOOKS_REPO"
git -C "$NOHOOKS_REPO" -c user.name=TAP -c user.email=tap@example.invalid rm -q -r githooks
git -C "$NOHOOKS_REPO" -c user.name=TAP -c user.email=tap@example.invalid commit -qm "no tap-hooks files"
NOHOOKS_SCRATCH="$WORK/install-no-hooks-scratch"
nohooks_out="$(PATH="$NOHOOKS_SCRATCH/bin:$PATH" TAP_INSTALL_BIN="$NOHOOKS_SCRATCH/bin" TAP_CLAUDE_HOME="$NOHOOKS_SCRATCH/claude" \
  TAP_CODEX_HOME="$NOHOOKS_SCRATCH/codex" TAP_HERMES_HOME="$NOHOOKS_SCRATCH/hermes" \
  TAP_CURSOR_HOME="$NOHOOKS_SCRATCH/cursor" TAP_OPENCODE_HOME="$NOHOOKS_SCRATCH/opencode" \
  TAP_GEMINI_HOME="$NOHOOKS_SCRATCH/gemini" TAP_CURSOR_AGENT_HOME="$NOHOOKS_SCRATCH/cursor-agent" \
  TAP_AGENTS_HOME="$NOHOOKS_SCRATCH/agents" TAP_INDEX_HOME="$NOHOOKS_SCRATCH/tap-index" \
  TAP_INSTALL_HOOK=0 bash "$NOHOOKS_REPO/install.sh" 2>&1)" \
  || { echo "install-primary-guard: (5f-neg) installer failed: $nohooks_out" >&2; exit 1; }
[ -z "$(git -C "$NOHOOKS_REPO" config --local core.hooksPath || true)" ] \
  || { echo "install-primary-guard: (5f-neg) the installer set core.hooksPath on a clone that marks no tap-hooks files" >&2; exit 1; }
[[ "$nohooks_out" != *"core.hooksPath"* ]] \
  || { echo "install-primary-guard: (5f-neg) the installer mentioned core.hooksPath on a clone with no hooks: $nohooks_out" >&2; exit 1; }
echo "install-primary-guard: (5f-neg) a clone with no tap-hooks files keeps core.hooksPath unset: ok"

# (5g) A STALE LINKED WORKTREE CANNOT CREATE main AFTERWARDS.
#
# The property the absolute value buys. `git config --local` is one shared file;
# a relative value resolved per checkout let a worktree on a pre-change commit
# run its own old hook and push to main at rc 0 (review;
# reproduced). Mutant: write the relative form instead, and this reds alone.
STALE_WT="$WORK/stale-linked-worktree"
git -C "$INSTALL_REPO" worktree add -q --detach "$STALE_WT" "$OLD_SHA"
# Match the MARKER, not the word: "UNGUARDED" contains "GUARDED".
grep -q 'fixture-guard' "$STALE_WT/githooks/pre-push" \
  && { echo "install-primary-guard: (5g) fixture setup: the stale worktree should carry the OLD unguarded hook" >&2; exit 1; }
STALE_REMOTE="$WORK/stale-remote.git"
git init -q --bare "$STALE_REMOTE"
git -C "$STALE_WT" config user.email t@example.invalid
git -C "$STALE_WT" config user.name  t
git -C "$STALE_WT" config commit.gpgsign false
git -C "$STALE_WT" remote add origin "$STALE_REMOTE"
git -C "$STALE_WT" checkout -qb stale-feature
set +e
stale_out="$(git -C "$STALE_WT" push origin HEAD:main 2>&1)"
stale_rc=$?
set -e
[ "$stale_rc" -ne 0 ] \
  || { echo "install-primary-guard: (5g) a STALE linked worktree created main — the shared config points at per-checkout bytes: $stale_out" >&2; exit 1; }
case "$stale_out" in
  *"NOT PERMITTED TO OVERRIDE"*) ;;
  *) echo "install-primary-guard: (5g) the stale worktree's push failed, but not from the guard: $stale_out" >&2; exit 1 ;;
esac
git -C "$STALE_REMOTE" show-ref --verify --quiet refs/heads/main \
  && { echo "install-primary-guard: (5g) main appeared on the remote despite the refusal" >&2; exit 1; }
echo "install-primary-guard: (5g) a stale linked worktree cannot create main: ok"

# (5h) A COMMITTED overwrite that drops the guard still warns. The worktree is
# clean, so only the tap-hook-marker content check can see it.
printf '#!/usr/bin/env sh\n# installer shim\nexit 0\n' > "$INSTALL_REPO/githooks/pre-push"
git -C "$INSTALL_REPO" add -A
git -C "$INSTALL_REPO" -c user.name=TAP -c user.email=tap@example.invalid commit -qm "installer overwrote the hook"
[ -z "$(git -C "$INSTALL_REPO" status --porcelain)" ] \
  || { echo "install-primary-guard: (5h) fixture setup: the overwrite must be committed and clean" >&2; exit 1; }
set +e
clobber_out="$(PATH="$INSTALL_SCRATCH/bin:$PATH" TAP_INSTALL_BIN="$INSTALL_SCRATCH/bin" TAP_CLAUDE_HOME="$INSTALL_SCRATCH/claude" \
  TAP_CODEX_HOME="$INSTALL_SCRATCH/codex" TAP_HERMES_HOME="$INSTALL_SCRATCH/hermes" \
  TAP_CURSOR_HOME="$INSTALL_SCRATCH/cursor" TAP_OPENCODE_HOME="$INSTALL_SCRATCH/opencode" \
  TAP_GEMINI_HOME="$INSTALL_SCRATCH/gemini" TAP_CURSOR_AGENT_HOME="$INSTALL_SCRATCH/cursor-agent" \
  TAP_AGENTS_HOME="$INSTALL_SCRATCH/agents" TAP_INDEX_HOME="$INSTALL_SCRATCH/tap-index" \
  TAP_INSTALL_HOOK=0 bash "$INSTALL_REPO/install.sh" 2>&1)"
clobber_rc=$?
set -e
[ "$clobber_rc" -eq 0 ] || { echo "install-primary-guard: (5h) installer exited $clobber_rc: $clobber_out" >&2; exit 1; }
[[ "$clobber_out" == *"no longer contains its tap-hook-marker (fixture-guard)"* ]] \
  || { echo "install-primary-guard: (5h) a committed overwrite of the guard hook did not warn: $clobber_out" >&2; exit 1; }
echo "install-primary-guard: (5h) a committed guard overwrite warns by content: ok"

# The explicit emergency override is equally loud for a non-git source copy.
NONGIT_FORCED_HOME="$WORK/non-git-forced-home"
mkdir -p "$NONGIT_FORCED_HOME"
nongit_force_notice="$(run_install_without_inherited_targets PATH="$NONGIT_FORCED_HOME/.local/bin:$PATH" HOME="$NONGIT_FORCED_HOME" TAP_INSTALL_HOOK=0 TAP_INSTALL_FORCE_NONPRIMARY=1 \
  bash "$NONGIT/install.sh" 2>&1 >/dev/null)"
[ -L "$NONGIT_FORCED_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (5c) force did not permit non-git install" >&2; exit 1; }
[[ "$nongit_force_notice" == *"FORCE"* && "$nongit_force_notice" == *"not a git checkout"* ]] \
  || { echo "install-primary-guard: (5c) forced non-git install did not leave a breadcrumb: $nongit_force_notice" >&2; exit 1; }
echo "install-primary-guard: (5c) forced non-git install allowed with warning: ok"

# (6) A bad source package fails before creating any user target.
MISSING_HOME="$WORK/missing-source-home"
mkdir -p "$MISSING_HOME"
mv "$PRIMARY/skills/lead/references/ingest/README.md" "$WORK/ingest-contract.saved"
set +e
missing_notice="$(run_install_without_inherited_targets PATH="$MISSING_HOME/.local/bin:$PATH" HOME="$MISSING_HOME" TAP_INSTALL_HOOK=0 bash "$PRIMARY/install.sh" 2>&1)"
missing_rc=$?
set -e
[ "$missing_rc" -ne 0 ] || { echo "install-primary-guard: (6) missing ingest contract source unexpectedly succeeded" >&2; exit 1; }
[[ "$missing_notice" == *'missing ingest contract source'* ]] \
  || { echo "install-primary-guard: (6) missing source diagnostic absent: $missing_notice" >&2; exit 1; }
[ ! -e "$MISSING_HOME/.local/bin/tap" ] || { echo "install-primary-guard: (6) missing source mutated the binary target" >&2; exit 1; }
[ ! -e "$MISSING_HOME/.tap" ] || { echo "install-primary-guard: (6) missing source mutated the index target" >&2; exit 1; }
echo "install-primary-guard: (6) missing source refuses before mutation: ok"

[ ! -e "$INHERITED_INDEX_HOME" ] \
  || { echo "install-primary-guard: inherited TAP_INDEX_HOME escaped test isolation" >&2; exit 1; }

echo "install-primary-guard: ok"
