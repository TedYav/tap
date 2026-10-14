#!/usr/bin/env bash
# D5: fixture-door — the runtime/bun/src copies (:46-48, :357-358, :399-407, :537-538) build install.sh's Bun-import closure inside fake install trees; every assertion is on installer/git output, none on a module's behavior.
# install-checkout-sync.test.sh — merged code is not live until the primary
# checkout contains origin/main. install.sh must say so (never call a missing
# ref "live"), and --sync may fast-forward/rebase only when the tree is clean
# and unique local commits touch only paths marked tap-sync-regenerable (the
# fixture marks gen/export.jsonl, standing in for any machine-generated export).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/harness-stubs.sh
. "$(dirname "${BASH_SOURCE[0]}")/harness-stubs.sh"
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
PRIMARY="$WORK/primary"
ORIGIN="$WORK/origin.git"
LANE="$WORK/lane"
SCRATCH="$WORK/scratch"

cleanup() {
  git -C "$PRIMARY" worktree remove --force "$LANE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# install.sh turns a broken recorder into a WARNING plus exit 0, so a green
# run is only evidence if the WARNING is asserted absent (tap-remind-lock gap).
recorder_ran() {
  case "$1" in
    *"manifest recording incomplete"*|*"manifest recording failed"*)
      echo "install-checkout-sync: fixture recorder did not run cleanly: $1" >&2; exit 1;;
  esac
}

run_install() {
  make_harness_stubs "$SCRATCH/harness-bin"   # a home is wired only when its command is on PATH
  PATH="$SCRATCH/bin:$SCRATCH/harness-bin:$PATH" TAP_INSTALL_BIN="$SCRATCH/bin" \
  TAP_CLAUDE_HOME="$SCRATCH/claude" \
  TAP_CODEX_HOME="$SCRATCH/codex" \
  TAP_HERMES_HOME="$SCRATCH/hermes" \
  TAP_CURSOR_HOME="$SCRATCH/cursor" \
  TAP_OPENCODE_HOME="$SCRATCH/opencode" \
  TAP_GEMINI_HOME="$SCRATCH/gemini" \
  TAP_CURSOR_AGENT_HOME="$SCRATCH/cursor-agent" \
  TAP_AGENTS_HOME="$SCRATCH/agents" \
  TAP_INDEX_HOME="$SCRATCH/tap-index" \
  TAP_INSTALL_HOOK="${FIXTURE_INSTALL_HOOK:-0}" \
    bash "$@"
}

git_ok() {
  git -C "$PRIMARY" -c user.name=TAP -c user.email=tap@example.invalid "$@"
}

seed_primary() {
  mkdir -p "$PRIMARY/skills/lead/references/ingest" "$PRIMARY/skills/tap/scripts" "$PRIMARY/bin" "$PRIMARY/gen"
  printf 'export.jsonl tap-sync-regenerable\n' > "$PRIMARY/gen/.gitattributes"
  printf '# repository attributes\n' > "$PRIMARY/.gitattributes"
  cp "$ROOT/install.sh" "$PRIMARY/install.sh"
  mkdir -p "$PRIMARY/runtime/bun/src"
  # install.sh's Bun import closure; Unicode decimals moved out of launcher/naming.ts.
  cp "$ROOT/runtime/bun/src/"{config-file,config-error,skill-policy,install-harness-state,install-skill-links,install-skill-plugin,install-roster-hook-cleanup,install-manifest,install-fzf,fzf-tool,install-hooks,install-history,watch-detect,lossless-json,pyint,spool-publication,fsatomic,panelock,remind-lock,unicode-decimal,codex-fence}.ts "$PRIMARY/runtime/bun/src/"
cp -R "$ROOT/skills/." "$PRIMARY/skills"
cp -R "$ROOT/vendor" "$PRIMARY/vendor"
  cp "$ROOT/skills/lead/references/ingest/README.md" \
    "$PRIMARY/skills/lead/references/ingest/README.md"
  printf '#!/bin/sh\necho tap-fixture\n' > "$PRIMARY/bin/tap"
  chmod +x "$PRIMARY/bin/tap"
  git -C "$PRIMARY" init -q -b main
  git -C "$PRIMARY" config user.name TAP
  git -C "$PRIMARY" config user.email tap@example.invalid
  git -C "$PRIMARY" add install.sh runtime vendor skills bin gen/.gitattributes .gitattributes
  git_ok commit -qm seed
}

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"

# (1) No origin/main → CANNOT-CHECK, never "live". Relink still proceeds (fail open).
seed_primary
mkdir -p "$SCRATCH/claude" "$SCRATCH/cursor"
cat > "$SCRATCH/claude/settings.json" <<'JSON'
{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"TAP_HOOK_MODE=roster bash /old.sh"}]}]}}
JSON
cat > "$SCRATCH/cursor/hooks.json" <<'JSON'
{"hooks":{"beforeSubmitPrompt":[{"command":"TAP_HOOK_MODE=roster bash /old.sh"}]}}
JSON
cp "$SCRATCH/cursor/hooks.json" "$WORK/cursor-before.json"
out="$(run_install "$PRIMARY/install.sh" 2>&1)"
recorder_ran "$out"
[[ "$out" == *"CANNOT-CHECK"* ]] \
  || { echo "install-checkout-sync: (1) missing origin/main did not report CANNOT-CHECK: $out" >&2; exit 1; }
[[ "$out" != *"checkout live"* ]] \
  || { echo "install-checkout-sync: (1) missing origin/main claimed live: $out" >&2; exit 1; }
[ -L "$SCRATCH/bin/tap" ] \
  || { echo "install-checkout-sync: (1) CANNOT-CHECK blocked relink (must fail open)" >&2; exit 1; }
echo "install-checkout-sync: (1) missing origin/main is CANNOT-CHECK, not live: ok"
# Existing gates differ: Claude cleans even with hook installation disabled;
# Cursor cleans only when hooks are enabled. Exercise the real fixture installer.
! grep -q 'TAP_HOOK_MODE=roster' "$SCRATCH/claude/settings.json" \
  || { echo "install-checkout-sync: Claude cleanup was gated on TAP_INSTALL_HOOK" >&2; exit 1; }
cmp "$WORK/cursor-before.json" "$SCRATCH/cursor/hooks.json" \
  || { echo "install-checkout-sync: disabled Cursor hooks changed" >&2; exit 1; }
enabled_out="$(FIXTURE_INSTALL_HOOK=1 run_install "$PRIMARY/install.sh" 2>&1)"
! grep -q 'TAP_HOOK_MODE=roster' "$SCRATCH/cursor/hooks.json" \
  || { echo "install-checkout-sync: enabled Cursor cleanup did not run: $enabled_out" >&2; exit 1; }
echo "install-checkout-sync: roster cleanup gate asymmetry: ok"

# (2) Behind origin/main → STALE on a plain install; --sync fast-forwards.
git init -q --bare -b main "$ORIGIN"
git -C "$PRIMARY" remote add origin "$ORIGIN"
git_ok push -q -u origin main
git_ok commit --allow-empty -qm origin-ahead
git_ok push -q origin main
git_ok reset --hard -q HEAD~1
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
stale_out="$(run_install "$PRIMARY/install.sh" 2>&1)"
[[ "$stale_out" == *"STALE"* ]] \
  || { echo "install-checkout-sync: (2) behind origin/main did not report STALE: $stale_out" >&2; exit 1; }
[[ "$stale_out" == *"--sync"* ]] \
  || { echo "install-checkout-sync: (2) STALE did not name --sync: $stale_out" >&2; exit 1; }
[ -L "$SCRATCH/bin/tap" ] \
  || { echo "install-checkout-sync: (2) STALE blocked relink (must fail open)" >&2; exit 1; }
behind_head="$(git -C "$PRIMARY" rev-parse HEAD)"
origin_head="$(git -C "$PRIMARY" rev-parse origin/main)"
[ "$behind_head" != "$origin_head" ] \
  || { echo "install-checkout-sync: (2) setup did not leave primary behind" >&2; exit 1; }
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
sync_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$origin_head" ] \
  || { echo "install-checkout-sync: (2) --sync did not fast-forward: $sync_out" >&2; exit 1; }
[[ "$sync_out" == *"checkout live"* ]] \
  || { echo "install-checkout-sync: (2) --sync did not report live after FF: $sync_out" >&2; exit 1; }
echo "install-checkout-sync: (2) STALE report + --sync fast-forward: ok"

# (3) Regenerable-only PATH + origin moved → rebase, then live.
# Subject is deliberately arbitrary: a subject-keyed gate would refuse.
#
# THE ORIGIN COMMIT MUST TOUCH A FILE (tap-feqg). This arm used `--allow-empty`
# here, and that is why it stayed green through three live refusals: with an
# empty origin commit the two-dot and three-dot diffs give identical answers, so
# the fixture could not tell a state diff from a merge-base diff. Writing a real
# file is the entire RED — revert install.sh to `origin/main..HEAD` and this arm
# fails, because the behind-side file reads as local work. A fixture that cannot
# distinguish the two forms is not covering the predicate it names.
printf 'export-a\n' > "$PRIMARY/gen/export.jsonl"
git -C "$PRIMARY" add gen/export.jsonl
git_ok commit -qm 'wip: arbitrary subject, regenerable path only'
git clone -q "$ORIGIN" "$WORK/pusher"
git -C "$WORK/pusher" config user.name TAP
git -C "$WORK/pusher" config user.email tap@example.invalid
printf 'merged-code\n' > "$WORK/pusher/origin-side.sh"
git -C "$WORK/pusher" add origin-side.sh
git -C "$WORK/pusher" commit -qm 'origin code commit touching a file'
git -C "$WORK/pusher" push -q origin main
git -C "$PRIMARY" fetch -q origin main
# Pin the fixture's own discriminating power: the two forms must DISAGREE here,
# or this arm is back to proving nothing.
two_dot="$(git -C "$PRIMARY" diff --name-only origin/main..HEAD | tr '\n' ' ')"
[[ "$two_dot" == *"origin-side.sh"* ]] \
  || { echo "install-checkout-sync: (3) fixture is not discriminating — a two-dot diff must see the behind-side file, got '$two_dot'" >&2; exit 1; }
unique_files="$(git -C "$PRIMARY" diff --name-only origin/main...HEAD)"
[ "$unique_files" = "gen/export.jsonl" ] \
  || { echo "install-checkout-sync: (3) setup unique files were '$unique_files'" >&2; exit 1; }
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
# Captured with rc, not bare: this is the arm tap-feqg reds, and a bare command
# substitution under `set -e` kills the script with NO message — an unattributed
# red that reads like a harness fault instead of naming the predicate.
set +e
rebase_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
rebase_rc=$?
set -e
[ "$rebase_rc" -eq 0 ] \
  || { echo "install-checkout-sync: (3) --sync REFUSED a regenerable-only pile while behind a code commit (tap-feqg: the predicate must diff the merge base, not the endpoints): $rebase_out" >&2; exit 1; }
git -C "$PRIMARY" merge-base --is-ancestor origin/main HEAD \
  || { echo "install-checkout-sync: (3) --sync rebase left origin/main not ancestor: $rebase_out" >&2; exit 1; }
[ "$(git -C "$PRIMARY" diff --name-only origin/main...HEAD)" = "gen/export.jsonl" ] \
  || { echo "install-checkout-sync: (3) regenerable commit did not survive rebase: $rebase_out" >&2; exit 1; }
[ -f "$PRIMARY/origin-side.sh" ] \
  || { echo "install-checkout-sync: (3) --sync did not bring the behind-side commit into the primary: $rebase_out" >&2; exit 1; }
echo "install-checkout-sync: (3) --sync rebases regenerable-only unique commits past a behind code commit: ok"

# (4) Regenerable UNSTAGED dirt → restore-and-proceed (the PR's new contract, asserted
# on the strings that exist ONLY on the fixed path — 'restoring' and
# 'proceeding' — never on '--sync', which survives on both sides and
# therefore discriminate nothing). The old arm asserted the refusal this PR
# removes; inverting it deliberately rather than deleting it.
printf 'dirty-export\n' >> "$PRIMARY/gen/export.jsonl"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
set +e
regen_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
regen_rc=$?
set -e
[ "$regen_rc" -eq 0 ] \
  || { echo "install-checkout-sync: (4) regenerable drift no longer syncs (expected restore-and-proceed rc 0): $regen_out" >&2; exit 1; }
[[ "$regen_out" == *"regenerable drift detected — restoring the committed version"* ]] \
  || { echo "install-checkout-sync: (4) proceeding path did not print the restore notice: $regen_out" >&2; exit 1; }
[[ "$regen_out" == *"and proceeding"* ]] \
  || { echo "install-checkout-sync: (4) proceeding path did not say proceeding: $regen_out" >&2; exit 1; }
git -C "$PRIMARY" diff --quiet -- gen/export.jsonl \
  || { echo "install-checkout-sync: (4) regenerable drift survived the sync (restore did not happen or did not stick)" >&2; exit 1; }
echo "install-checkout-sync: (4) unstaged regenerable drift restores and proceeds: ok"

# (4b) Regenerable STAGED drift → REFUSES. Staged is a deliberate act (the
# generator's commit pipeline mid-flight), not regenerable noise: discarding it
# would destroy staged work on a shared primary. The refusal carries its tag.
printf 'staged-export\n' >> "$PRIMARY/gen/export.jsonl"
git -C "$PRIMARY" add gen/export.jsonl
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
set +e
staged_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
staged_rc=$?
set -e
[ "$staged_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (4b) staged regenerable drift unexpectedly synced: $staged_out" >&2; exit 1; }
[[ "$staged_out" == *"STAGED"* ]] \
  || { echo "install-checkout-sync: (4b) staged refusal did not say STAGED: $staged_out" >&2; exit 1; }
[[ "$staged_out" == *"[staged-regenerable]"* ]] \
  || { echo "install-checkout-sync: (4b) staged refusal did not carry its [staged-regenerable] tag: $staged_out" >&2; exit 1; }
git -C "$PRIMARY" reset -q HEAD -- gen/export.jsonl
git -C "$PRIMARY" checkout -q -- gen/export.jsonl
echo "install-checkout-sync: (4b) staged regenerable drift refuses with its tag: ok"

# (5) Sibling dirt that is not regenerable → refuse, name wait + ask the bus (tap-hl8i).
printf 'in-flight\n' > "$PRIMARY/notes.md"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
set +e
sib_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
sib_rc=$?
set -e
[ "$sib_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (5) sibling dirt unexpectedly synced: $sib_out" >&2; exit 1; }
[[ "$sib_out" == *"ask the bus"* ]] \
  || { echo "install-checkout-sync: (5) sibling-dirt refusal did not name ask-the-bus: $sib_out" >&2; exit 1; }
[[ "$sib_out" == *"tap-hl8i"* ]] \
  || { echo "install-checkout-sync: (5) sibling-dirt refusal did not name tap-hl8i: $sib_out" >&2; exit 1; }
rm -f "$PRIMARY/notes.md"
echo "install-checkout-sync: (5) sibling dirt refuses with ask-the-bus remedy: ok"

# (5a) An UNSTAGED policy edit cannot license its own restore or another writer's.
# The edit marks itself and a modified tracked file regenerable; reading attributes
# from the working tree would restore both and discard the in-progress work.
printf 'bin/tap tap-sync-regenerable\n.gitattributes tap-sync-regenerable\n' >> "$PRIMARY/.gitattributes"
printf '# in-progress work\n' >> "$PRIMARY/bin/tap"
rm -rf "${SCRATCH:?}"
mkdir -p "$SCRATCH"
set +e
policy_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
policy_rc=$?
set -e
[ "$policy_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (5a) an unstaged attribute edit licensed a sync: $policy_out" >&2; exit 1; }
[[ "$policy_out" == *"[in-flight]"* ]] \
  || { echo "install-checkout-sync: (5a) refusal was not [in-flight]: $policy_out" >&2; exit 1; }
grep -q 'in-progress work' "$PRIMARY/bin/tap" \
  || { echo "install-checkout-sync: (5a) the unstaged policy edit destroyed another file's work" >&2; exit 1; }
git -C "$PRIMARY" checkout -q -- .gitattributes bin/tap
echo "install-checkout-sync: (5a) an unstaged policy edit cannot authorize a restore: ok"

# (6) Unique CODE path with a tracker-spelled subject → refuse as stranded work.
# A subject-keyed gate would pass this; the path predicate must refuse.
printf 'stranded\n' > "$PRIMARY/stranded.txt"
git -C "$PRIMARY" add stranded.txt
git_ok commit -qm 'chore(export): regenerate'
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
set +e
strand_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
strand_rc=$?
set -e
[ "$strand_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (6) unique commits that are not regenerable unexpectedly synced: $strand_out" >&2; exit 1; }
[[ "$strand_out" == *"stranded"* ]] \
  || { echo "install-checkout-sync: (6) unique-commit refusal did not say stranded: $strand_out" >&2; exit 1; }
[[ "$strand_out" == *"tap-hl8i"* ]] \
  || { echo "install-checkout-sync: (6) unique-commit refusal did not name tap-hl8i: $strand_out" >&2; exit 1; }
git_ok reset -q --hard HEAD~1
echo "install-checkout-sync: (6) unique commits that are not regenerable refuse as stranded work: ok"

# (6a) CODE THAT EXISTS ONLY IN A MERGE COMMIT'S OWN DIFF → must still refuse.
# This arm rules out the other obvious spelling of the fix, `git log --name-only
# --format=`. The distinction is narrower than "merges break log", which is the
# claim an earlier draft of this comment made and driving it disproved: for an
# ORDINARY merge the log range still names the file, because the side commit is
# itself in the range and is a normal commit. What log cannot see is content
# that exists ONLY in the merge commit's own diff — a conflict resolution, or
# the "evil merge" built here — because `git log` prints no names for a merge
# under its default. That content is genuinely stranded and would be rebased
# away, and failing OPEN is the one direction this refusal must never take.
git_ok checkout -q -b feqg-side
printf 'side-code\n' > "$PRIMARY/side.sh"
git_ok add side.sh
git_ok commit -qm 'side branch code'
git_ok checkout -q main
git_ok merge -q --no-ff --no-commit feqg-side >/dev/null 2>&1 || true
printf 'resolution-only\n' > "$PRIMARY/merge-only.sh"
git_ok add merge-only.sh
git_ok commit -qm 'merge side branch with a resolution file'
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
set +e
merge_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
merge_rc=$?
set -e
[ "$merge_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (6a) code living only in a MERGE COMMIT's diff synced instead of refusing — the predicate must not use git log --name-only: $merge_out" >&2; exit 1; }
[[ "$merge_out" == *"merge-only.sh"* ]] \
  || { echo "install-checkout-sync: (6a) refusal did not NAME the merge-only file (a log-based predicate cannot see it): $merge_out" >&2; exit 1; }
# HEAD~1, not HEAD~2: --no-ff adds exactly ONE commit to main (the merge); the
# side commit never lived on this branch's first-parent line.
git_ok reset -q --hard HEAD~1
git_ok branch -qD feqg-side
echo "install-checkout-sync: (6a) code living only in a merge commit's diff refuses as stranded: ok"

# (6b) CODE TOUCHED THEN REVERTED nets to nothing → must SYNC, not refuse.
# The complement of (6a), and the second reason the log spelling loses: log
# reports every file any commit touched, so a change with no net effect reads as
# stranded work forever. Nothing can be stranded by rebasing a commit whose
# content is already identical to the base.
printf 'temporarily-changed\n' > "$PRIMARY/install.sh.probe"
git_ok add install.sh.probe
git_ok commit -qm 'touch a code file'
git_ok rm -q install.sh.probe
git_ok commit -qm 'revert it — net effect is nothing'
printf 'export-net\n' > "$PRIMARY/gen/export.jsonl"
git_ok commit -qam 'regenerate export'
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
net_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" \
  || { echo "install-checkout-sync: (6b) a touched-then-reverted code file refused as stranded — the predicate must diff the merge base, not enumerate touched files: $net_out" >&2; exit 1; }
echo "install-checkout-sync: (6b) code touched then reverted nets to nothing and syncs: ok"

# (6c) The comparison FAILING must refuse, never sync (fail-closed).
# Three-dot needs a merge base; two-dot did not, so this direction is new risk
# introduced by the fix itself. `|| true` here would turn a git error into empty
# output, read as "no unique files", and let --sync mutate the shared primary on
# a failed read. install.sh:115 states the rule this pins: check fails open
# (informs), --sync refuses closed (mutates). Unrelated history has no merge
# base, so the diff exits nonzero.
# The unrelated root must be pushed into ORIGIN, not just fetched into a local
# remote-tracking ref: install.sh runs `git fetch origin main` before the
# predicate, which would restore a locally-forced ref and silently un-stage this
# fixture. Origin is the only place the condition survives its own fetch.
git clone -q "$ORIGIN" "$WORK/unrelated" 2>/dev/null
git -C "$WORK/unrelated" checkout -q --orphan detached-history
git -C "$WORK/unrelated" rm -rqf . >/dev/null 2>&1 || true
printf 'unrelated\n' > "$WORK/unrelated/unrelated.txt"
git -C "$WORK/unrelated" add unrelated.txt
git -C "$WORK/unrelated" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'unrelated root'
git -C "$WORK/unrelated" push -q -f origin detached-history:main
git_ok fetch -q origin main
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
set +e
norel_out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)"
norel_rc=$?
set -e
[ "$norel_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (6c) an unrelated-history comparison SYNCED instead of refusing — --sync must fail closed: $norel_out" >&2; exit 1; }
[[ "$norel_out" == *"cannot prove"* ]] \
  || { echo "install-checkout-sync: (6c) refusal did not say the pile could not be proven regenerable-only: $norel_out" >&2; exit 1; }
[[ "$norel_out" == *"no merge base"* ]] \
  || { echo "install-checkout-sync: (6c) refusal did not carry git's own reason: $norel_out" >&2; exit 1; }
[[ "$norel_out" == *"tap-hl8i"* ]] \
  || { echo "install-checkout-sync: (6c) unrelated-history refusal did not route to the bus: $norel_out" >&2; exit 1; }
# Hand the shared ORIGIN back to the history the later arms assume. This arm
# force-pushed an orphan root into it, and leaving it there breaks (7) with a
# non-fast-forward push that reads as an unrelated failure several arms away.
git_ok push -q -f origin main:main
git_ok fetch -q origin main
echo "install-checkout-sync: (6c) a failed comparison refuses rather than syncing: ok"

# (6d) THE REMEDY MUST RUN FROM THE STATE THAT TRIPS IT (tap-feqg, gate review).
# A shallow checkout whose origin advanced has no merge base, and the obvious
# remedy — `git fetch origin main` — does NOT clear it; only --unshallow does.
# Printing the plain fetch there is a door onto the same wall, so the refusal
# must detect the shallow state and name the verb that actually works. Driven
# rather than reasoned: plain fetch leaves rc=128, --unshallow returns rc=0.
#
# ISOLATED ORIGIN, deliberately. Advancing the shared $ORIGIN past the primary
# is what this arm needs, and doing it in place broke arm (7) several arms later
# with a non-fast-forward push — the same shared-state class 6c hit. A private
# bare repo costs one clone and leaves every later arm's world untouched.
SHALLOW_ORIGIN="$WORK/shallow-origin.git"
git clone -q --bare "$ORIGIN" "$SHALLOW_ORIGIN" 2>/dev/null
SHALLOW="$WORK/shallow"
git clone -q --depth 1 "file://$SHALLOW_ORIGIN" "$SHALLOW" 2>/dev/null
cp "$ROOT/install.sh" "$SHALLOW/install.sh"
mkdir -p "$SHALLOW/runtime/bun/src"
cp "$ROOT/runtime/bun/src/install-skill-links.ts" "$SHALLOW/runtime/bun/src/"
cp "$ROOT/runtime/bun/src/install-harness-state.ts" "$SHALLOW/runtime/bun/src/"
mkdir -p "$SHALLOW/skills/lead/references/ingest" "$SHALLOW/bin"
cp "$ROOT/skills/lead/references/ingest/README.md" "$SHALLOW/skills/lead/references/ingest/README.md" 2>/dev/null || printf 'ingest\n' > "$SHALLOW/skills/lead/references/ingest/README.md"
cp "$ROOT/bin/tap" "$SHALLOW/bin/tap" 2>/dev/null || printf '#!/bin/sh\n' > "$SHALLOW/bin/tap"
git -C "$SHALLOW" -c user.name=TAP -c user.email=tap@example.invalid add -A
git -C "$SHALLOW" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'shallow seed'
[ "$(git -C "$SHALLOW" rev-parse --is-shallow-repository)" = "true" ] \
  || { echo "install-checkout-sync: (6d) fixture is not shallow — the arm would prove nothing" >&2; exit 1; }
# Advance the ISOLATED origin, then re-fetch shallow so the merge base is gone.
git clone -q "$SHALLOW_ORIGIN" "$WORK/shallow-pusher" 2>/dev/null
printf 'advanced\n' > "$WORK/shallow-pusher/advance.sh"
git -C "$WORK/shallow-pusher" -c user.name=TAP -c user.email=tap@example.invalid add advance.sh
git -C "$WORK/shallow-pusher" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'origin advances past the shallow floor'
git -C "$WORK/shallow-pusher" push -q origin main
git -C "$SHALLOW" fetch -q --depth 1 origin main 2>/dev/null || true
if git -C "$SHALLOW" diff --name-only origin/main...HEAD >/dev/null 2>&1; then
  # DECLARED skip, in the suite's reserved spelling — not prose (gate review).
  # The word `skip` anywhere else in stderr is caught by smoke-all's undeclared-
  # skip scan and REDS the worker with failure_class=undeclared-skip: loud, but
  # it would name an accounting error rather than the environment difference
  # that caused it, and this branch is written to degrade gracefully. The
  # `SMOKE-SKIP: ` prefix at line start is counted at smoke-all.sh:706 and
  # explicitly passed over by the guard, so the anchor reports declared-skips=1
  # with a receipt instead of a red with a misleading class.
  echo "SMOKE-SKIP: (6d) this git resolves a merge base in the shallow fixture, so the no-merge-base remedy cannot be exercised" >&2
else
  rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
  set +e
  shallow_out="$(run_install "$SHALLOW/install.sh" --sync 2>&1)"
  shallow_rc=$?
  set -e
  [ "$shallow_rc" -ne 0 ] \
    || { echo "install-checkout-sync: (6d) a shallow no-merge-base checkout synced instead of refusing: $shallow_out" >&2; exit 1; }
  [[ "$shallow_out" == *"--unshallow"* ]] \
    || { echo "install-checkout-sync: (6d) the refusal printed a remedy that cannot clear a shallow history (plain fetch leaves rc=128); it must name --unshallow: $shallow_out" >&2; exit 1; }
  echo "install-checkout-sync: (6d) a shallow checkout's refusal names --unshallow, not a plain fetch: ok"
fi

# (7) --sync from a linked worktree still updates PRIMARY and relinks from it.
git -C "$PRIMARY" worktree add -q --detach "$LANE" HEAD
cp "$ROOT/install.sh" "$LANE/install.sh"
mkdir -p "$LANE/runtime/bun/src"
cp "$ROOT/runtime/bun/src/install-skill-links.ts" "$LANE/runtime/bun/src/"
cp "$ROOT/runtime/bun/src/install-harness-state.ts" "$LANE/runtime/bun/src/"
git_ok commit --allow-empty -qm origin-ahead-2
git_ok push -q origin main
git_ok reset --hard -q HEAD~1
# Keep the worktree's copy of the new installer even after primary reset.
cp "$ROOT/install.sh" "$LANE/install.sh"
mkdir -p "$LANE/runtime/bun/src"
cp "$ROOT/runtime/bun/src/install-skill-links.ts" "$LANE/runtime/bun/src/"
cp "$ROOT/runtime/bun/src/install-harness-state.ts" "$LANE/runtime/bun/src/"
pre_lane_head="$(git -C "$PRIMARY" rev-parse HEAD)"
origin_head="$(git -C "$PRIMARY" rev-parse origin/main)"
[ "$pre_lane_head" != "$origin_head" ] \
  || { echo "install-checkout-sync: (7) setup did not leave primary behind" >&2; exit 1; }
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
lane_out="$(run_install "$LANE/install.sh" --sync 2>&1)"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$origin_head" ] \
  || { echo "install-checkout-sync: (7) worktree --sync did not update primary: $lane_out" >&2; exit 1; }
[ "$(readlink "$SCRATCH/bin/tap")" = "$PRIMARY/bin/tap" ] \
  || { echo "install-checkout-sync: (7) worktree --sync relinked at the worktree, not primary: $(readlink "$SCRATCH/bin/tap" 2>/dev/null) ($lane_out)" >&2; exit 1; }
echo "install-checkout-sync: (7) --sync from worktree updates and relinks primary: ok"

# (8) --help names --sync; unknown option refuses.
help_out="$(bash "$ROOT/install.sh" --help 2>&1)"
[[ "$help_out" == *"--sync"* ]] \
  || { echo "install-checkout-sync: (8) --help did not name --sync: $help_out" >&2; exit 1; }
set +e
unk_out="$(bash "$ROOT/install.sh" --nope 2>&1)"
unk_rc=$?
set -e
[ "$unk_rc" -ne 0 ] \
  || { echo "install-checkout-sync: (8) unknown option succeeded" >&2; exit 1; }
[[ "$unk_out" == *"unknown option"* ]] \
  || { echo "install-checkout-sync: (8) unknown option was not refused: $unk_out" >&2; exit 1; }
echo "install-checkout-sync: (8) --help and unknown option: ok"

# (10) --sync must apply the version it just pulled IN THE SAME RUN (tap-sge4).
# bash reads a script incrementally, so a --sync that pulls a commit CHANGING
# install.sh keeps executing this process's pre-pull in-memory text for the
# rest of the run — even when $REPO already IS the primary (the common case:
# AGENTS.md's mandated post-merge step runs FROM the primary). The acceptance
# shape is exactly as filed: a --sync across a commit that edits install.sh's
# own skill arrays, verifying the NEW array took effect in the SAME run —
# proven here by a sentinel skill that only the pulled install.sh knows to link.
old_head="$(git -C "$PRIMARY" rev-parse HEAD)"
sentinel_install="$WORK/install-sentinel.sh"
sed '/^link_user_skills Claude /a\
ln -s "$REPO/skills/zzz-sentinel" "$CLAUDE_HOME/skills/zzz-sentinel"
' "$ROOT/install.sh" > "$sentinel_install"
diff -q "$sentinel_install" "$ROOT/install.sh" >/dev/null \
  && { echo "install-checkout-sync: (10) sed did not add the sentinel to CORE_SKILLS — fixture cannot discriminate" >&2; exit 1; }
git clone -q "$ORIGIN" "$WORK/pusher-sentinel"
git -C "$WORK/pusher-sentinel" config user.name TAP
git -C "$WORK/pusher-sentinel" config user.email tap@example.invalid
cp "$sentinel_install" "$WORK/pusher-sentinel/install.sh"
mkdir -p "$WORK/pusher-sentinel/skills/zzz-sentinel"
printf '# sentinel fixture skill\n' > "$WORK/pusher-sentinel/skills/zzz-sentinel/SKILL.md"
git -C "$WORK/pusher-sentinel" add install.sh skills/zzz-sentinel/SKILL.md
git -C "$WORK/pusher-sentinel" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'add zzz-sentinel to CORE_SKILLS'
git -C "$WORK/pusher-sentinel" push -q origin main
git_ok fetch -q origin main
new_origin_head="$(git -C "$PRIMARY" rev-parse origin/main)"
[ "$new_origin_head" != "$old_head" ] \
  || { echo "install-checkout-sync: (10) setup did not advance origin/main" >&2; exit 1; }
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/claude"
sentinel_out="$(run_install "$PRIMARY/install.sh" --sync --verbose 2>&1)"
[[ "$sentinel_out" == *"install: linked ingest contract"* ]] \
  || { echo "install-checkout-sync: --verbose was lost during re-exec: $sentinel_out" >&2; exit 1; }
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$new_origin_head" ] \
  || { echo "install-checkout-sync: (10) --sync did not fast-forward to the sentinel commit: $sentinel_out" >&2; exit 1; }
[ -L "$SCRATCH/claude/skills/zzz-sentinel" ] \
  || { echo "install-checkout-sync: (10) SAME-RUN CORE_SKILLS from the pulled install.sh was not applied — --sync executed stale (pre-pull) script text: $sentinel_out" >&2; exit 1; }
echo "install-checkout-sync: (10) --sync applies a pulled install.sh link-instruction change in the same run: ok"

# (11) THE TRANSITION ITSELF (review finding). Arm (10)
# seeds PRIMARY from $ROOT/install.sh, which already HAS the fix — so it can
# only prove "fixed syncs to fixed", never the thing anyone actually doubted: a
# machine still running the PRE-FIX installer, syncing across the commit that
# fixes it. Structurally, that first sync CANNOT be self-healing — the process
# already executing is the pre-fix script, and no pull can rewrite bytes bash
# already read into this run. Prove what actually happens instead of asserting
# around it: HEAD moves (git succeeded), but the bundled link-instruction change does
# NOT take effect until a second invocation reads the fixed file off disk.
# Isolated fixture (own origin/primary): this seeds from repo HISTORY, not from
# $ROOT's current working tree, so the shared PRIMARY/ORIGIN above do not apply.
MIG_ORIGIN="$WORK/migration-origin.git"
MIG_PRIMARY="$WORK/migration-primary"
git init -q --bare -b main "$MIG_ORIGIN"
mkdir -p "$MIG_PRIMARY/skills/lead/references/ingest" "$MIG_PRIMARY/skills/tap/scripts" "$MIG_PRIMARY/bin"
# NEITHER HEAD~1 NOR A MERGE-BASE (gate review CodeRabbit, second and third P1s
# on this arm). Both derive "pre-fix" from a position in history, and both
# broke for the same underlying reason on a different axis: HEAD~1 drifts as
# this branch grows commits; merge-base(HEAD, origin/main) drifts the moment
# origin/main CONTAINS the fix — which is exactly what happens once this PR
# merges, breaking the guard below for every branch cut afterward, forever.
# A test that needs a pre-fix installer needs a reference that CANNOT stop
# being pre-fix. So construct one: take this branch's own current (fixed)
# install.sh and mechanically invert the exact text this fix changed, via
# Python string replacement rather than a git ref. This has zero dependency
# on history in either direction — it cannot be broken by a future commit,
# a rebase, or this very PR merging. If a later change edits the fixed
# block's wording, this substitution correctly fails loud (FIXED block not
# found) rather than silently constructing something that is not the bug.
python3 - "$ROOT/install.sh" "$MIG_PRIMARY/install.sh" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
FIXED = '''  # Re-exec unconditionally (tap-sge4), even when $REPO already IS $primary_root
  # (the common case: AGENTS.md's mandated post-merge step runs FROM the
  # primary). bash reads a script incrementally, so without this, a --sync that
  # pulls a commit CHANGING install.sh keeps running this process's pre-pull
  # in-memory text for the rest of the run — half-old on the exact run whose
  # contract is "the merged fix is now live". tap_install_sync_primary exits
  # nonzero before returning on every refusal path, so reaching here means
  # $primary_root is non-empty and the fresh exec below re-reads the pulled file.
  echo "install: --sync updated primary; relinking from $primary_root" >&2
  setup_args=()
  if [ "$SETUP" = 1 ]; then setup_args+=(--setup); fi
  if [ "$VERBOSE" = 1 ]; then setup_args+=(--verbose); fi
  TAP_INSTALL_SYNC_REEXEC=1 exec bash "$primary_root/install.sh" "${setup_args[@]}"
'''
PRE_FIX = '''  if [ -n "$primary_root" ] && [ "$REPO" != "$primary_root" ]; then
    echo "install: --sync updated primary; relinking from $primary_root" >&2
    exec bash "$primary_root/install.sh"
  fi
'''
if FIXED not in text:
    print("install-checkout-sync: (11) FIXED block not found in install.sh — "
          "the tap-sge4 fix text has changed; update this fixture's inverse "
          "patch to match", file=sys.stderr)
    sys.exit(1)
open(dst, "w").write(text.replace(FIXED, PRE_FIX, 1))
PY
[ -s "$MIG_PRIMARY/install.sh" ] \
  || { echo "install-checkout-sync: (11) could not construct the pre-fix install.sh" >&2; exit 1; }
# Confirm it really is pre-fix (the exec is still gated on REPO!=primary_root)
# and does NOT carry the fix's own marker comment — belt and suspenders on a
# fixture this load-bearing.
grep -q 'if \[ -n "\$primary_root" \] && \[ "\$REPO" != "\$primary_root" \]; then' "$MIG_PRIMARY/install.sh" \
  || { echo "install-checkout-sync: (11) constructed install.sh is not the pre-fix version — fixture cannot discriminate" >&2; exit 1; }
grep -q 'Re-exec unconditionally (tap-sge4)' "$MIG_PRIMARY/install.sh" \
  && { echo "install-checkout-sync: (11) constructed install.sh still carries the fix's marker comment — inversion did not take" >&2; exit 1; }
mkdir -p "$MIG_PRIMARY/runtime/bun/src"
cp "$ROOT/runtime/bun/src/"{config-file,config-error,skill-policy,install-harness-state,install-skill-links,install-skill-plugin,install-roster-hook-cleanup,install-manifest,install-fzf,fzf-tool,install-hooks,install-history,watch-detect,lossless-json,pyint,spool-publication,fsatomic,panelock,remind-lock,unicode-decimal,codex-fence}.ts "$MIG_PRIMARY/runtime/bun/src/"
cp -R "$ROOT/skills/." "$MIG_PRIMARY/skills"
cp -R "$ROOT/vendor" "$MIG_PRIMARY/vendor"
cp "$ROOT/skills/lead/references/ingest/README.md" "$MIG_PRIMARY/skills/lead/references/ingest/README.md"
printf '#!/bin/sh\necho tap-fixture\n' > "$MIG_PRIMARY/bin/tap"
chmod +x "$MIG_PRIMARY/bin/tap"
git -C "$MIG_PRIMARY" init -q -b main
git -C "$MIG_PRIMARY" config user.name TAP
git -C "$MIG_PRIMARY" config user.email tap@example.invalid
git -C "$MIG_PRIMARY" add install.sh runtime vendor skills bin
git -C "$MIG_PRIMARY" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'pre-fix installer (seed)'
git -C "$MIG_PRIMARY" remote add origin "$MIG_ORIGIN"
git -C "$MIG_PRIMARY" push -q -u origin main
pre_fix_head="$(git -C "$MIG_PRIMARY" rev-parse HEAD)"

# Advance origin with the FIX (this branch's current install.sh) bundled with a
# link-instruction change — the exact shape the bug is about: a commit that changes
# install.sh's own link instructions, pulled by --sync.
git clone -q "$MIG_ORIGIN" "$WORK/migration-pusher"
git -C "$WORK/migration-pusher" config user.name TAP
git -C "$WORK/migration-pusher" config user.email tap@example.invalid
sed '/^link_user_skills Claude /a\
ln -s "$REPO/skills/zzz-migration-sentinel" "$CLAUDE_HOME/skills/zzz-migration-sentinel"
' "$ROOT/install.sh" > "$WORK/migration-pusher/install.sh"
diff -q "$WORK/migration-pusher/install.sh" "$ROOT/install.sh" >/dev/null \
  && { echo "install-checkout-sync: (11) sed did not add the migration sentinel — fixture cannot discriminate" >&2; exit 1; }
mkdir -p "$WORK/migration-pusher/skills/zzz-migration-sentinel"
printf '# migration sentinel fixture skill\n' > "$WORK/migration-pusher/skills/zzz-migration-sentinel/SKILL.md"
git -C "$WORK/migration-pusher" add install.sh skills/zzz-migration-sentinel/SKILL.md
git -C "$WORK/migration-pusher" -c user.name=TAP -c user.email=tap@example.invalid commit -qm 'ship the fix + a link-instruction change'
git -C "$WORK/migration-pusher" push -q origin main
git -C "$MIG_PRIMARY" fetch -q origin main
fixed_head="$(git -C "$MIG_PRIMARY" rev-parse origin/main)"
[ "$fixed_head" != "$pre_fix_head" ] \
  || { echo "install-checkout-sync: (11) setup did not advance origin/main" >&2; exit 1; }

MIG_SCRATCH="$WORK/migration-scratch"
mkdir -p "$MIG_SCRATCH/claude"
_orig_scratch="$SCRATCH"
SCRATCH="$MIG_SCRATCH"

# FIRST --sync: run by the PRE-FIX script that is still on disk in MIG_PRIMARY
# at the moment this invocation starts.
first_out="$(run_install "$MIG_PRIMARY/install.sh" --sync 2>&1)"
[ "$(git -C "$MIG_PRIMARY" rev-parse HEAD)" = "$fixed_head" ] \
  || { echo "install-checkout-sync: (11a) first --sync (pre-fix script) did not fast-forward: $first_out" >&2; exit 1; }
[ ! -e "$MIG_SCRATCH/claude/skills/zzz-migration-sentinel" ] \
  || { echo "install-checkout-sync: (11a) UNEXPECTED — the pre-fix script self-applied the bundled skill change; the reproduction no longer holds, re-check HEAD~1: $first_out" >&2; exit 1; }
echo "install-checkout-sync: (11a) first --sync (still running the pre-fix script) pulls the fix but does NOT self-apply the bundled skill change — HEAD moved, the link did not: ok"

# SECOND run: plain install.sh, now reading the FIXED script off disk. This is
# the two-invocation requirement AGENTS.md documents for this one transition.
second_out="$(run_install "$MIG_PRIMARY/install.sh" 2>&1)"
[ -L "$MIG_SCRATCH/claude/skills/zzz-migration-sentinel" ] \
  || { echo "install-checkout-sync: (11b) second run (now reading the fixed script) did not link the bundled skill: $second_out" >&2; exit 1; }
echo "install-checkout-sync: (11b) a second install.sh run (reading the now-fixed file) completes the transition: ok"

SCRATCH="$_orig_scratch"

echo "install-checkout-sync: ok"
