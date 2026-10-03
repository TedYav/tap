#!/usr/bin/env bash
# install.sh — put the `tap` command on PATH and make the TAP skills + advisory
# available to every session on this machine. Re-running refreshes the native
# Claude/Codex plugin and prefixed skill wrappers for other supported harnesses.
# The marketplace points at the skill-only plugins/tap package in this checkout.
#
# Default install relinks. It does not update the checkout (tap-3ywn): a merged
# fix is not live until the persistent primary contains origin/main. After
# relinking, install reports that ancestor check (STALE / CANNOT-CHECK / live)
# and never calls a missing origin/main ref "live". `--sync` is the opt-in
# mutator: fetch + fast-forward/rebase the primary iff the tree is clean except
# unstaged drift of regenerable paths (restored to HEAD before the sync proceeds;
# staged drift of them still refuses) and unique local commits touch only
# regenerable paths, then relink from primary. Concurrent --sync runs on one
# primary serialize on a bounded lock (see "The primary sync lock" below).
#
# Repository-local install policy is declared with git attributes, so this file
# names no repository's private paths:
#   tap-sync-regenerable  a machine-generated file --sync may restore or rebase over
#   tap-hooks             tracked hook files; on the primary, install arms their one
#                         directory as core.hooksPath and --sync replays its
#                         post-checkout after rebasing
# A checkout that marks nothing gets neither behavior.
#
# Targets are overridable (so tests and non-standard setups don't touch real dirs):
#   TAP_INSTALL_BIN     where to link the `tap` command       (default: ~/.local/bin)
#   TAP_CLAUDE_HOME       Claude user dir                     (default: ~/.claude)
#   TAP_CODEX_HOME        Codex user dir                      (default: ~/.codex)
#   TAP_HERMES_HOME       Hermes user dir                     (default: ~/.hermes)
#   TAP_CURSOR_HOME       Cursor user dir                     (default: ~/.cursor)
#   TAP_OPENCODE_HOME     OpenCode user dir                   (default: ~/.config/opencode)
#   TAP_GEMINI_HOME       Antigravity/Gemini (agy) user dir   (default: ~/.gemini)
#   TAP_CURSOR_AGENT_HOME Cursor-agent user dir               (default: ~/.config/agents)
#   TAP_AGENTS_HOME       shared agents user dir              (default: ~/.agents)
#   TAP_INDEX_HOME        machine TAP state                   (default: ~/.tap)
#   TAP_INSTALL_HOOK=0  skip harness hook and plugin wiring
#   TAP_INSTALL_FORCE_NONPRIMARY=1  allow real targets from a linked worktree
#   TAP_INSTALL_SYNC_LOCK_WAIT  seconds a --sync waits for another's lock (default: 60)
set -euo pipefail

SYNC=0
SETUP=0
VERBOSE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sync) SYNC=1; shift ;;
    --setup) SETUP=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install.sh [--sync] [--setup] [--verbose]

  --verbose  Show each successful link and absent optional integration.
             The install manifest also records owned artifacts.

  default  Relink tap + skills from THIS checkout. Real/default targets are
           refused from a linked worktree (run from the persistent primary).
           After relink, reports whether origin/main is an ancestor of HEAD.
           A missing origin/main is CANNOT-CHECK, never live.

  --sync   Fetch origin main and fast-forward/rebase the persistent primary
           iff the working tree is clean except unstaged drift of regenerable
           paths — which is restored to the committed version before the sync
           proceeds — and unique local commits touch only regenerable paths,
           then relink from that primary. Invokable from a worktree; git
           writes and relinks target the primary. A concurrent --sync on
           the same primary waits for the first to finish (up to
           TAP_INSTALL_SYNC_LOCK_WAIT seconds, default 60) and says how
           long it waited; a lock left by a dead run is reclaimed with a
           note. A fast-forward interrupted after it updated the index
           (index at origin/main, main behind) is completed. Refusal
           classes, one per guard; each refusal line carries its tag:
           [artifact]  this is a release install, not a git checkout; rerun the bootstrap with a newer archive
           [sync-locked]  the primary sync lock was held past the wait bound, or this run could not record itself as its owner
           [no-primary]  the persistent primary checkout could not be derived
           [not-on-main]  primary is not on main, or a rebase is in progress
           [no-origin]  primary has no origin remote
           [fetch-failed]  git fetch origin main failed in the primary
           [in-flight]  files that are not regenerable are modified in the primary
           [staged-regenerable]  a regenerable path has staged changes (a deliberate act, not drift)
           [regenerable-restore]  unstaged regenerable drift could not be restored before proceeding
           [no-merge-base]  HEAD could not be compared to origin/main; the local pile cannot be proven regenerable-only
           [stranded-commits]  primary has unique commits that touch paths that are not regenerable
           [cannot-check]  the origin/main ancestor check could not run; install reports CANNOT-CHECK, never live
           [primary-moved]  primary moved during preparation; inspect it before retrying
           [pull-failed]  rebase onto origin/main failed; recovery either restored main or left the named state for inspection

Repository-local policy (git attributes; a checkout that sets none gets neither):
  tap-sync-regenerable  a machine-generated file --sync may restore or rebase over
  tap-hooks             tracked hook files; install on the primary arms their one
                        directory as core.hooksPath, and --sync replays its
                        post-checkout hook after rebasing

Installs TAP's pinned fzf in its private tools directory before relinking.
The initial install downloads and verifies a platform archive; later installs
can reuse its verified cache offline. User fzf installations are untouched.

Claude and Codex use the complete TAP skill plugin; other hosts use prefixed
skill links. Disabled plugins are not refreshed. Codex refresh uses native add,
which enables the plugin: keep its enabled setting unchanged during this command.

This is not a deploy system. It does not auto-pull or fetch on every tap.
EOF
      exit 0
      ;;
    --*)
      echo "install: unknown option '$1' (try --help)" >&2
      exit 1
      ;;
    *)
      echo "install: unexpected arg '$1' (try --help)" >&2
      exit 1
      ;;
  esac
done

# Inventory details are opt-in; warnings and next steps keep their normal streams.
install_detail() { if [ "$VERBOSE" = 1 ]; then echo "$@"; fi; }
SKILL_LINK_COUNT=0
SKILL_HOME_COUNT=0
ABSENT_SKILL_HOMES=()

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# A release artifact (tap-7r3fn.192) carries tap-release.json beside this file. It is not a
# git checkout and has no Bun on PATH: libexec/tap/bun runs the compiled router as Bun. Its
# links and hook commands name the logical directory (the bootstrap's stable
# ~/.local/share/tap/current link), so installing the next version replaces them in place.
ARTIFACT=0
if [ -f "$(dirname "${BASH_SOURCE[0]}")/tap-release.json" ]; then
  ARTIFACT=1
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
TAP_SHELL_BODY_GUARD="$REPO/hooks/tap-shell-body-guard.ts"
TAP_HOOK_BUN=bun
if [ "$ARTIFACT" = 1 ]; then
  TAP_SHELL_BODY_GUARD="$REPO/hooks/tap-shell-body-guard.sh"
  TAP_HOOK_BUN="\"$REPO/libexec/tap/bun\""
fi
# Every Bun step below: `bun` from PATH in a checkout, the artifact's own Bun in a release.
tap_bun() { if [ "$ARTIFACT" = 1 ]; then "$REPO/libexec/tap/bun" "$@"; else bun "$@"; fi; }
if [ "$ARTIFACT" = 1 ] && [ "$SYNC" = 1 ]; then
  echo "install: REFUSED --sync — [artifact] $REPO is a release install, not a git checkout; --sync updates a checkout" >&2
  echo "install: next: rerun tap-bootstrap.sh with a newer archive and its --sha256" >&2
  exit 1
fi

# Stop before writes when the prerequisites are incomplete. Keep the current shell.
missing=()
TAP_BUN_MIN=1.4.0
for dep in git bash bun jq tmux tar; do
  if ! { [ "$dep" = bun ] && [ "$ARTIFACT" = 1 ]; } && ! command -v "$dep" >/dev/null 2>&1; then
    echo "install: $dep was not found on PATH" >&2
    missing+=("$dep")
  elif [ "$dep" = bash ] && ! bash -c 'test "${BASH_VERSINFO[0]}" -ge 5'; then
    echo "install: Bash 5 or newer is required" >&2
    missing+=(bash)
  elif [ "$dep" = bun ]; then
    bun_version=''
    rc=0
    bun_version="$(tap_bun --version)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "install: bun was found but 'bun --version' failed (rc $rc)" >&2
      missing+=(bun)
    elif ! [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "install: bun --version printed '$bun_version', which is not a supported X.Y.Z release version" >&2
      missing+=(bun)
    else
      IFS=. read -r maj min pat <<<"$bun_version"
      IFS=. read -r req_maj req_min req_pat <<<"$TAP_BUN_MIN"
      if [ "$maj" -lt "$req_maj" ] || { [ "$maj" -eq "$req_maj" ] && [ "$min" -lt "$req_min" ]; } || { [ "$maj" -eq "$req_maj" ] && [ "$min" -eq "$req_min" ] && [ "$pat" -lt "$req_pat" ]; }; then
        echo "install: Bun $TAP_BUN_MIN or newer is required (found $bun_version)" >&2
        missing+=(bun)
      fi
    fi
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "install: install the missing requirements, then rerun ./install.sh:" >&2
  while IFS= read -r hint; do printf '%s\n' "$hint" >&2; done <<'EOF'
  Install Homebrew if needed: https://brew.sh
  Apple Silicon Macs:
    eval "$(/opt/homebrew/bin/brew shellenv)"
    /opt/homebrew/bin/brew install git bash jq tmux oven-sh/bun/bun
  Intel Macs:
    eval "$(/usr/local/bin/brew shellenv)"
    /usr/local/bin/brew install git bash jq tmux oven-sh/bun/bun
  Run the commands for your Mac after Homebrew is installed, then rerun ./install.sh.
  On Linux, install the missing requirements with your package manager and Bun from https://bun.sh.
EOF
  exit 127
fi

echo "install: requirements OK: bash $(bash -c 'printf %s "$BASH_VERSION"'), bun $bun_version, jq, tmux, git"

# One source of truth drives both default resolution and the all-targets-
# redirected exception. Each entry is shell variable:environment variable:default;
# splitting only the first two colons preserves any colons in $HOME.
INSTALL_TARGET_SPECS=(
  "BIN_DIR:TAP_INSTALL_BIN:$HOME/.local/bin"
  "CLAUDE_HOME:TAP_CLAUDE_HOME:$HOME/.claude"
  "CODEX_HOME:TAP_CODEX_HOME:$HOME/.codex"
  "HERMES_HOME:TAP_HERMES_HOME:$HOME/.hermes"
  "CURSOR_HOME:TAP_CURSOR_HOME:$HOME/.cursor"
  "OPENCODE_HOME:TAP_OPENCODE_HOME:$HOME/.config/opencode"
  "GEMINI_HOME:TAP_GEMINI_HOME:$HOME/.gemini"
  "CURSOR_AGENT_HOME:TAP_CURSOR_AGENT_HOME:$HOME/.config/agents"
  "AGENTS_HOME:TAP_AGENTS_HOME:$HOME/.agents"
  "INDEX_HOME:TAP_INDEX_HOME:$HOME/.tap"
)
for target_spec in "${INSTALL_TARGET_SPECS[@]}"; do
  target_var="${target_spec%%:*}"
  target_env_and_default="${target_spec#*:}"
  target_env="${target_env_and_default%%:*}"
  target_default="${target_env_and_default#*:}"
  printf -v "$target_var" '%s' "${!target_env:-$target_default}"
done
unset target_spec target_var target_env_and_default target_env target_default

tap_install_primary_root() {
  local common_git_dir
  common_git_dir="$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$common_git_dir" in
    /*) ;;
    *) common_git_dir="$REPO/$common_git_dir" ;;
  esac
  [ -d "$common_git_dir" ] || return 1
  (cd "$common_git_dir/.." && pwd -P)
}

tap_install_all_targets_redirected() {
  local target_spec target_env_and_default target_env
  for target_spec in "${INSTALL_TARGET_SPECS[@]}"; do
    target_env_and_default="${target_spec#*:}"
    target_env="${target_env_and_default%%:*}"
    [ -n "${!target_env:-}" ] || return 1
  done
}

# Ancestor predicate (tap-3ywn): origin/main is live in this tree iff it is an
# ancestor of HEAD. "N commits behind" false-positives a regenerable-only ahead pile.
# A missing ref is CANNOT-CHECK, never live. Check fails open (informs); --sync
# refuses closed (mutates). Keep doctor wording in lockstep.
tap_install_classify_checkout() {
  local repo="$1" rc=0
  _co_status="cannot_check"
  _co_head=""
  _co_origin=""
  _co_problem=""
  _co_next=""
  if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    _co_problem="checkout CANNOT-CHECK — $repo is not a git checkout (absence is not live)"
    _co_next="run ./install.sh from the persistent primary git checkout"
    return 0
  fi
  _co_head="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || true)"
  if ! _co_origin="$(git -C "$repo" rev-parse --short origin/main 2>/dev/null)"; then
    _co_origin=""
    _co_problem="checkout CANNOT-CHECK — origin/main ref is missing in $repo (absence is not live)"
    _co_next="git -C $repo fetch origin main"
    return 0
  fi
  git -C "$repo" merge-base --is-ancestor origin/main HEAD >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    _co_status="live"
    _co_problem="checkout live — origin/main ($_co_origin) is an ancestor of HEAD ($_co_head)"
    return 0
  fi
  if [ "$rc" -eq 1 ]; then
    _co_status="stale"
    _co_problem="checkout STALE — origin/main ($_co_origin) is not an ancestor of HEAD (${_co_head:-unknown}); live tap still runs old code"
    _co_next="bash $repo/install.sh --sync"
    return 0
  fi
  _co_problem="checkout CANNOT-CHECK — could not compare HEAD to origin/main in $repo (absence is not live)"
  _co_next="retry; if a git lock is held, wait and re-run"
}

tap_install_report_checkout() {
  tap_install_classify_checkout "$1"
  echo "install: $_co_problem" >&2
  [ -z "${_co_next:-}" ] || echo "install: next: $_co_next" >&2
}

tap_install_porcelain_paths() {
  local line path
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line:3}"
    case "$line" in
      R*|C*) path="${path#* -> }" ;;
    esac
    printf '%s\n' "$path"
  done < <(git -C "$1" status --porcelain --untracked-files=all)
}

# The paths on stdin (one per line) that carry the tap-sync-regenerable attribute.
# A git failure prints nothing, so nothing is regenerable and --sync refuses with
# its ordinary message; `|| true` keeps set -e from exiting silently instead.
# An empty answer only ever refuses, so it can never license a restore. --cached
# reads policy from the index: an unstaged .gitattributes edit cannot authorize its
# own or another writer's restore, and a staged one is itself dirty and refuses.
tap_install_regenerable() {
  local path attr value
  { tr '\n' '\0' | git -C "$1" check-attr --cached -z --stdin tap-sync-regenerable 2>/dev/null \
    | while IFS= read -r -d '' path && IFS= read -r -d '' attr && IFS= read -r -d '' value; do
        [ "$value" != set ] || printf '%s\n' "$path"
      done; } || true
}

# The one directory holding the checkout's tracked tap-hooks files, as an absolute
# path. Empty when nothing is marked, git cannot answer, or the marks span directories.
tap_install_hooks_dir() {
  local files dir dirs=""
  files="$(git -C "$1" ls-files -- ':(attr:tap-hooks)' 2>/dev/null)" || return 0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    case "$dir" in */*) dir="${dir%/*}" ;; *) dir=. ;; esac
    case $'\n'"$dirs"$'\n' in *$'\n'"$dir"$'\n'*) ;; *) dirs="${dirs:+$dirs$'\n'}$dir" ;; esac
  done <<< "$files"
  [ -n "$dirs" ] || return 0
  case "$dirs" in
    *$'\n'*)
      echo "install: WARNING: tap-hooks files span several directories ($(printf '%s' "$dirs" | tr '\n' ' ')); no hooks directory armed" >&2
      return 0 ;;
  esac
  if [ "$dirs" = . ]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$1" "$dirs"; fi
}

# Whether $2 is one of the newline-separated paths in $1.
tap_install_listed() {
  case $'\n'"$1"$'\n' in *$'\n'"$2"$'\n'*) return 0 ;; esac
  return 1
}

# --- The primary sync lock (tap-axo6o) ----------------------------------------
# Two --sync runs on one shared primary used to race: one fast-forward stopped
# between writing the index and moving the ref (refused next time as in-flight),
# and concurrent fetches collided on the remote-tracking ref lock. --sync now
# holds one lock for the whole fetch, fast-forward and relink transaction.
#
# The primitive is an atomic mkdir: macOS ships no flock(1), and mkdir either
# creates the directory or fails on every POSIX filesystem, stock Mac and CI
# Linux alike. The directory lives in the primary's git dir, which neither git's
# index nor the issue tracker reads. Its owner record names the holding pid.
# exec keeps the pid, so the record stays true in the relink child after the
# re-exec; the child adopts the lock through TAP_INSTALL_SYNC_LOCK instead of
# taking it a second time, and releases it when the transaction ends.
#
# A waiter waits a bounded time (TAP_INSTALL_SYNC_LOCK_WAIT seconds, default 60),
# says whom it waits on, and its receipt says how long it waited. A lock whose
# owner is proven dead is reclaimed with a note. Proof takes two
# differently-shaped instruments that must agree, because the empty answer here
# licenses removing another process's lock; anything short of proof waits.
_sync_lock_held=""
_sync_lock_published=0

tap_install_sync_lock_owner_pid() {
  sed -n 's/^pid=\([0-9][0-9]*\)$/\1/p' "$1/owner" 2>/dev/null | head -n 1 || true
}

# Succeeds only when pid $1 is provably gone: kill -0 reports no such process
# AND ps, asked separately, lists nothing and exits 1. Permission errors, a
# missing ps or any other answer read as alive.
tap_install_pid_dead() {
  local pid="$1" err rc=0
  [ -n "$pid" ] || return 1
  # The C locale keeps the no-such-process diagnostic in the words matched below.
  err="$(LC_ALL=C; kill -0 "$pid" 2>&1)" && return 1
  case "$err" in *"No such process"*|*"no such process"*) ;; *) return 1 ;; esac
  ps -p "$pid" -o pid= >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ]
}

# Removes the lock this run holds. Before its owner record is published, a
# missing record is ours to clear; after, only a record naming this pid is.
tap_install_sync_lock_release() {
  local lock="$_sync_lock_held" owner_pid
  [ -n "$lock" ] || return 0
  _sync_lock_held=""
  rm -f -- "${lock:?}/owner.tmp.$$"
  owner_pid="$(tap_install_sync_lock_owner_pid "$lock")"
  if [ "$owner_pid" != "$$" ] && { [ "$_sync_lock_published" = 1 ] || [ -e "$lock/owner" ]; }; then
    echo "install: WARNING: the primary sync lock $lock no longer names pid $$; left in place" >&2
    return 0
  fi
  rm -f -- "${lock:?}/owner"
  rmdir -- "${lock:?}" 2>/dev/null || echo "install: WARNING: could not remove the primary sync lock $lock" >&2
}

# Remove a dead owner's lock. A reclaim guard (its own atomic mkdir) keeps two
# waiters that saw the same dead owner from both removing; under the guard the
# owner is re-read and re-proven dead, so a lock that changed hands survives.
tap_install_sync_lock_reclaim() {
  local lock="$1" dead_pid="$2" guard="$1.reclaim" stale="$1.stale.$$"
  mkdir "$guard" 2>/dev/null || return 1
  if [ "$(tap_install_sync_lock_owner_pid "$lock")" = "$dead_pid" ] && tap_install_pid_dead "$dead_pid" \
      && mv "$lock" "$stale"; then
    rm -f -- "${stale:?}/owner"
    rmdir -- "${stale:?}" 2>/dev/null || echo "install: WARNING: could not remove the reclaimed lock $stale" >&2
    echo "install: --sync reclaimed the primary sync lock from dead pid $dead_pid ($lock)" >&2
  fi
  rmdir -- "${guard:?}"
}

tap_install_sync_lock_acquire() {
  local lock="$1" primary="$2" bound="${TAP_INSTALL_SYNC_LOCK_WAIT:-60}" start="$SECONDS"
  local pid="" holder="" announced=0 vanished=0 tmp
  case "$bound" in ''|*[!0-9]*) bound=60 ;; esac
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      # Arm cleanup before publishing the owner record, so a failed write or a
      # signal in between never strands a lock no waiter can attribute.
      _sync_lock_held="$lock"
      _sync_lock_published=0
      trap 'tap_install_sync_lock_release' EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      tmp="$lock/owner.tmp.$$"
      if ! { printf 'pid=%s\nsince=%s\nrepo=%s\n' "$$" "$(date +%s)" "$REPO" > "$tmp" && mv "$tmp" "$lock/owner"; }; then
        echo "install: REFUSED --sync — [sync-locked] could not record this run as the owner of the primary sync lock ($lock); released it" >&2
        echo "install: next: check free space and permissions under $(dirname "$lock"), then bash $primary/install.sh --sync" >&2
        exit 1
      fi
      _sync_lock_published=1
      echo "install: --sync holding the primary sync lock (pid $$) at $lock" >&2
      if [ "$announced" = 1 ]; then
        echo "install: --sync lock acquired after waiting $((SECONDS - start))s (was held by $holder)" >&2
      fi
      return 0
    fi
    pid="$(tap_install_sync_lock_owner_pid "$lock")"
    if [ -n "$pid" ] && tap_install_pid_dead "$pid" && tap_install_sync_lock_reclaim "$lock" "$pid"; then
      continue
    fi
    if [ -n "$pid" ]; then
      holder="pid $pid"
    elif [ -d "$lock" ]; then
      holder="an owner that has not written its record"
    elif [ -e "$lock" ]; then
      holder="a path that is not a lock directory"
    elif [ "$vanished" = 0 ]; then
      # Released between our mkdir and this look: try again at once, but only
      # once, so an mkdir that cannot succeed still reaches the bound below.
      vanished=1
      continue
    else
      holder="nothing (mkdir cannot create it)"
    fi
    vanished=0
    if [ "$announced" = 0 ]; then
      announced=1
      echo "install: --sync waiting up to ${bound}s for the primary sync lock held by $holder ($lock)" >&2
    fi
    if [ $((SECONDS - start)) -ge "$bound" ]; then
      echo "install: REFUSED --sync — [sync-locked] the primary sync lock is still held after ${bound}s by $holder ($lock)" >&2
      if [ -n "$pid" ] && [ -d "$lock.reclaim" ]; then
        echo "install: next: pid $pid is gone but a reclaim guard remains; if no --sync is running, rmdir $lock.reclaim, then bash $primary/install.sh --sync" >&2
      elif [ -n "$pid" ]; then
        echo "install: next: wait for pid $pid to finish (ps -p $pid), then bash $primary/install.sh --sync" >&2
      else
        echo "install: next: if no --sync is running, inspect and remove $lock, then bash $primary/install.sh --sync" >&2
      fi
      exit 1
    fi
    sleep 1
  done
}

# Give the tap-hooks directory's post-checkout the final tree after --sync moved
# main without a checkout; retain its ordinary advisory error policy. Only the
# directory install arms, discovered from the moved tree: hooksPath may not be
# armed yet (a fresh clone), and a hook TAP did not arm is not ours to run.
tap_install_replay_post_checkout() {
  local hooks_dir
  hooks_dir="$(tap_install_hooks_dir "$1")"
  if [ -n "$hooks_dir" ] && [ -x "$hooks_dir/post-checkout" ]; then
    (cd "$1" && "$hooks_dir/post-checkout" "$2" "$3" 1)
  fi
}

tap_install_sync_primary() {
  local primary="$1" dirty_paths unique_paths regenerable="" regen_dirty="" not_regen=""
  local git_dir start_head rebase_state reflog_action="tap-install-sync-$$" last_action
  if [ -z "$primary" ]; then
    echo "install: REFUSED --sync — [no-primary] persistent primary checkout could not be derived" >&2
    echo "install: next: run from a git checkout of this repo" >&2
    exit 1
  fi
  echo "install: --sync targeting primary $primary" >&2
  git_dir="$(git -C "$primary" rev-parse --absolute-git-dir)"
  # Before any read of HEAD: a holder may move it until we own the transaction.
  tap_install_sync_lock_acquire "$git_dir/tap-install-sync.lock" "$primary"
  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] \
      || [ "$(git -C "$primary" symbolic-ref --quiet HEAD || true)" != refs/heads/main ]; then
    echo "install: REFUSED --sync — [not-on-main] primary must be on main with no rebase in progress; existing state left untouched" >&2
    exit 1
  fi
  start_head="$(git -C "$primary" rev-parse HEAD)"
  if ! git -C "$primary" remote get-url origin >/dev/null 2>&1; then
    echo "install: REFUSED --sync — [no-origin] $primary has no origin remote" >&2
    echo "install: next: git -C $primary remote add origin <url> && git -C $primary fetch origin main && bash $primary/install.sh --sync" >&2
    exit 1
  fi
  if ! git -C "$primary" fetch origin main; then
    echo "install: REFUSED --sync — [fetch-failed] git fetch origin main failed in $primary" >&2
    echo "install: next: git -C $primary fetch origin main && bash $primary/install.sh --sync" >&2
    exit 1
  fi

  # An interrupted fast-forward (tap-axo6o): a fast-forward wrote origin/main's
  # tree into the index and stopped before moving main, so HEAD is behind and
  # every path it changed reads as staged. Only that exact shape completes, by
  # moving main to the commit whose tree the index already holds, compared and
  # swapped against the HEAD read above. The worktree is not touched, and its
  # remaining dirt must already be something --sync restores: none, or unstaged
  # edits to tracked regenerable paths. Any untracked path disqualifies, since
  # restoring needs an index entry. So a refusal never follows a moved main, and
  # every other state refuses exactly as before. Behind by any distance counts:
  # the specimens were one commit behind, but the safety rests on the index
  # matching origin/main.
  local origin_head ancestor_rc=0 vs_origin_rc=0 vs_head_rc=0 loose="" loose_regen="" loose_ok=0 untracked=""
  origin_head="$(git -C "$primary" rev-parse --verify --quiet 'origin/main^{commit}' || true)"
  if [ -n "$origin_head" ] && [ "$origin_head" != "$start_head" ]; then
    git -C "$primary" merge-base --is-ancestor "$start_head" "$origin_head" || ancestor_rc=$?
    git -C "$primary" diff --cached --quiet "$origin_head" -- || vs_origin_rc=$?
    git -C "$primary" diff --cached --quiet "$start_head" -- || vs_head_rc=$?
    # A git failure or any untracked path leaves loose_ok at 0 (refuse).
    if untracked="$(git -C "$primary" ls-files --others --exclude-standard)" && [ -z "$untracked" ] \
        && loose="$(git -C "$primary" diff --name-only)"; then
      if [ -z "$loose" ]; then
        loose_ok=1
      else
        loose_regen="$(printf '%s\n' "$loose" | tap_install_regenerable "$primary")"
        loose_ok=1
        while IFS= read -r path; do
          tap_install_listed "$loose_regen" "$path" || loose_ok=0
        done <<< "$loose"
      fi
    fi
    if [ "$ancestor_rc" -eq 0 ] && [ "$vs_origin_rc" -eq 0 ] && [ "$vs_head_rc" -eq 1 ] && [ "$loose_ok" = 1 ]; then
      echo "install: --sync completing an interrupted fast-forward: the index already holds origin/main's tree and main ($start_head) is behind it; moving main to $origin_head" >&2
      if ! git -C "$primary" update-ref -m "$reflog_action: complete interrupted fast-forward" \
          refs/heads/main "$origin_head" "$start_head"; then
        echo "install: REFUSED --sync — [primary-moved] main moved while completing an interrupted fast-forward; inspect it before retrying" >&2
        exit 1
      fi
      tap_install_replay_post_checkout "$primary" "$start_head" "$origin_head"
      start_head="$origin_head"
    fi
  fi

  dirty_paths="$(tap_install_porcelain_paths "$primary" || true)"
  if [ -n "$dirty_paths" ]; then
    regenerable="$(printf '%s\n' "$dirty_paths" | tap_install_regenerable "$primary")"
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if tap_install_listed "$regenerable" "$path"; then
        regen_dirty="${regen_dirty:+$regen_dirty$'\n'}$path"
      else
        not_regen="${not_regen:+$not_regen, }$path"
      fi
    done <<< "$dirty_paths"
    if [ -n "$not_regen" ]; then
      echo "install: REFUSED --sync — [in-flight] shared primary has in-flight files ($not_regen)" >&2
      echo "install: next: wait; ask the bus who owns those files before touching them (tap-hl8i)" >&2
      exit 1
    fi
    if [ -n "$regen_dirty" ]; then
      # A regenerable path is machine-generated and regenerated on demand (in
      # this repository, the issue tracker's export). Refusing --sync on it made this gate
      # answer "is anything dirty" for "would a sync destroy work" (the same
      # broader-question class this file documents at :210 and :113), and the
      # file is dirty not as a race but persistently: it is dirty because the
      # team is doing its tracker work continuously (measured: refusals at 11:50Z,
      # 12:53Z, 15:0xZ, and a fourth into a held box with every tracker writer
      # stood down — the dirty lines were that evening's own filed issues). A
      # file dirty BECAUSE the team works is precisely the file that must not
      # gate the predicate: a race has a workaround, this does not.
      #
      # STAGED drift still refuses, deliberately and for its own reason:
      # unstaged export drift is regenerable noise, but a STAGED export is a
      # deliberate act — the generator's commit pipeline mid-flight — and
      # discarding it (checkout HEAD --) would destroy staged work on a shared
      # primary. Chosen on that argument, NOT by symmetry with the unstaged
      # case; the narrower claim is the defensible one.
      local index_paths staged=""
      if ! index_paths="$(git -C "$primary" diff --cached --name-only)"; then
        echo "install: REFUSED --sync — [staged-regenerable] could not read the index in $primary" >&2
        exit 1
      fi
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        if tap_install_listed "$index_paths" "$path"; then staged="${staged:+$staged$'\n'}$path"; fi
      done <<< "$regen_dirty"
      if [ -n "$staged" ]; then
        echo "install: REFUSED --sync — [staged-regenerable] regenerable paths have STAGED changes in $primary ($(printf '%s' "$staged" | tr '\n' ' ')); a deliberate act, not drift" >&2
        echo "install: next: commit or unstage them with the tool that generates them, then bash $primary/install.sh --sync" >&2
        exit 1
      fi
      echo "install: --sync regenerable drift detected — restoring the committed version and proceeding ($(printf '%s' "$regen_dirty" | tr '\n' ' '))" >&2
      if ! printf '%s\n' "$regen_dirty" | tr '\n' '\0' | git -C "$primary" checkout --pathspec-from-file=- --pathspec-file-nul; then
        echo "install: REFUSED --sync — [regenerable-restore] could not restore regenerable drift in $primary" >&2
        echo "install: next: regenerate or commit those files, then bash $primary/install.sh --sync" >&2
        exit 1
      fi
    fi
  fi

  # THREE-DOT, AND THE THIRD DOT IS THE WHOLE FIX (tap-feqg, three live refusals).
  # The question here is "what do MY unique commits touch", and only the
  # merge-base diff answers it. `origin/main..HEAD` is a two-dot STATE diff
  # between two endpoints, so every file changed by commits the primary is
  # BEHIND on reads as local work: after a merge, --sync named the merged PR's
  # own file set as stranded and refused — at exactly the moment AGENTS.md tells
  # a lane to run it. This file already learned the class one check up (:113,
  # where "N commits behind" false-positived the same regenerable-only pile); this is
  # the same defect one check down.
  #
  # NOT `git log --name-only --format=` (the other obvious spelling). Two edges
  # decide it, both driven rather than reasoned. Content that exists ONLY in a
  # MERGE COMMIT's own diff — a conflict resolution — is invisible to log, which
  # prints no names for a merge by default, so it would be rebased away: FAILING
  # OPEN, the one direction this refusal must never take. (An ordinary merge is
  # fine under log, because the side commit is itself in the range — the narrower
  # statement is the true one.) And code touched then reverted nets to nothing,
  # which log reports as stranded forever while the merge-base diff correctly
  # ignores it: nothing can be stranded by rebasing a change with no net effect.
  #
  # NO `|| true` HERE, DELIBERATELY, and it is not the two-dot line's polarity.
  # Three-dot REQUIRES a merge-base; an unrelated-history or corrupt-object
  # failure prints nothing and exits nonzero, and swallowing that would read as
  # "no unique files" and let --sync mutate the shared primary on a git error.
  # That inverts this file's own rule at :115 — check fails open (informs),
  # --sync refuses closed (mutates).
  if ! unique_paths="$(git -C "$primary" diff --name-only origin/main...HEAD 2>&1)"; then
    echo "install: REFUSED --sync — [no-merge-base] could not compare HEAD to origin/main in $primary (${unique_paths:-no output}); cannot prove the local pile is regenerable-only" >&2
    # The remedy must RUN from the state that trips it. A shallow clone whose
    # origin advanced has no merge base, and `fetch origin main` does NOT clear
    # it — only --unshallow does, so printing the plain fetch there is a door
    # that opens onto the same wall. Name the state, then the verb for it.
    if [ "$(git -C "$primary" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      echo "install: next: this checkout is SHALLOW and a truncated history has no merge base — git -C $primary fetch --unshallow, then bash $primary/install.sh --sync" >&2
    else
      echo "install: next: git -C $primary fetch origin main, then bash $primary/install.sh --sync; if the histories are genuinely unrelated, do NOT reset — ask the bus who owns this checkout (tap-hl8i)" >&2
    fi
    exit 1
  fi
  if [ -n "$unique_paths" ]; then
    regenerable="$(printf '%s\n' "$unique_paths" | tap_install_regenerable "$primary")"
    not_regen=""
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      tap_install_listed "$regenerable" "$path" || not_regen="${not_regen:+$not_regen, }$path"
    done <<< "$unique_paths"
    if [ -n "$not_regen" ]; then
      echo "install: REFUSED --sync — [stranded-commits] primary has unique commits that touch paths that are not regenerable ($not_regen); that is stranded work, not a fast-forward" >&2
      echo "install: next: ask the bus who owns the in-flight files on the shared primary before resetting or pulling (tap-hl8i); do not git reset" >&2
      exit 1
    fi
  fi

  tap_install_classify_checkout "$primary"
  if [ "$_co_status" = "live" ]; then
    echo "install: --sync no-op — already live ($_co_problem)" >&2
    return 0
  fi
  if [ "$_co_status" = "cannot_check" ]; then
    echo "install: REFUSED --sync — [cannot-check] $_co_problem" >&2
    echo "install: next: $_co_next && bash $primary/install.sh --sync" >&2
    exit 1
  fi

  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] \
      || [ "$(git -C "$primary" symbolic-ref --quiet HEAD || true)" != refs/heads/main ] \
      || [ "$(git -C "$primary" rev-parse HEAD)" != "$start_head" ]; then
    echo "install: REFUSED --sync — [primary-moved] primary moved during preparation; inspect it before retrying" >&2
    exit 1
  fi
  echo "install: --sync rebasing onto origin/main in $primary" >&2
  # TOCTOU close (second restore): the first restore above leaves a window in
  # which the export can re-dirty before the pull — the pull then dies on a
  # dirty tree, which is the failure this predicate exists to prevent arriving
  # through the fix itself. The re-dirty needs no race story: the export is
  # persistently dirty because the team's tracker work is continuous (the
  # held-box experiment refuted during-the-sync contention as the cause of the
  # standing refusal; see the comment above for the corrected account), and
  # whatever writes in this window, the response is the same. Restore AGAIN
  # immediately before the pull; TWO attempts with refusal on failure,
  # deliberately NOT a loop — a retry-until-clean would be the possible-effect
  # retry pattern in a new costume. The safety mechanism is the checkout's
  # FORM: `git checkout -- <path>` restores from the INDEX, so staged content
  # survives this call even if a stage raced the earlier staged-drift check —
  # the wrong near-miss is `git checkout HEAD -- <path>`, which would discard
  # staged content; never spell this restore that way.
  # A dirty path that is not regenerable is left alone: the pull refuses it.
  regen_dirty="$(git -C "$primary" diff --name-only 2>/dev/null | tap_install_regenerable "$primary")"
  if [ -n "$regen_dirty" ]; then
    echo "install: --sync regenerable drift re-dirtied after classification — restoring again before the pull" >&2
    if ! printf '%s\n' "$regen_dirty" | tr '\n' '\0' | git -C "$primary" checkout --pathspec-from-file=- --pathspec-file-nul; then
      echo "install: REFUSED --sync — [regenerable-restore] could not restore regenerable drift before pull in $primary" >&2
      echo "install: next: regenerate or commit those files, then bash $primary/install.sh --sync" >&2
      exit 1
    fi
  fi
  # Rebase onto the remote-tracking ref the fetch above already updated, not
  # `pull --rebase`: pull runs a second fetch and then reads FETCH_HEAD, and the
  # shared primary is fetched by other writers at any moment. A concurrent
  # multi-branch fetch between pull's fetch and that read leaves several heads
  # there and the rebase refuses ("Cannot rebase onto multiple branches",
  # tap-ckef5). A ref named explicitly never consults FETCH_HEAD.
  # The merge backend publishes replay state before post-checkout; apply can
  # invoke that hook first, defeating both the branch guard and Beads deferral.
  if ! GIT_REFLOG_ACTION="$reflog_action" git -C "$primary" -c rebase.backend=merge rebase origin/main; then
    rebase_state="$git_dir/rebase-merge"
    [ ! -d "$git_dir/rebase-apply" ] || rebase_state="$git_dir/rebase-apply"
    last_action="$(git -C "$primary" reflog -1 --format=%gs 2>/dev/null || true)"
    # Abort only our replay: entry state was clean, Git names our original main,
    # and its most recent HEAD movement carries this invocation's reflog action.
    if [ "$(cat "$rebase_state/orig-head" 2>/dev/null || true)" = "$start_head" ] \
        && [ "$(cat "$rebase_state/head-name" 2>/dev/null || true)" = refs/heads/main ] \
        && [[ "$last_action" == "$reflog_action "* ]]; then
      if git -C "$primary" rebase --abort \
          && [ "$(git -C "$primary" symbolic-ref --quiet HEAD || true)" = refs/heads/main ] \
          && [ "$(git -C "$primary" rev-parse HEAD)" = "$start_head" ] \
          && [ ! -d "$git_dir/rebase-merge" ] && [ ! -d "$git_dir/rebase-apply" ]; then
        echo "install: REFUSED --sync — [pull-failed] failed replay aborted; restored main at $start_head" >&2
      else
        echo "install: REFUSED --sync — [pull-failed] replay recovery failed; inspect $primary (HEAD=$(git -C "$primary" rev-parse HEAD), branch=$(git -C "$primary" symbolic-ref --quiet --short HEAD || echo detached))" >&2
      fi
    else
      echo "install: REFUSED --sync — [pull-failed] rebase failed without an owned active rebase; state left for inspection in $primary" >&2
    fi
    exit 1
  fi
  # Replay skipped post-checkout; give the hook the final tree once it is safe.
  tap_install_replay_post_checkout "$primary" "$start_head" "$(git -C "$primary" rev-parse HEAD)"
}

primary_root=""
[ "$ARTIFACT" = 1 ] || primary_root="$(tap_install_primary_root || true)"
# The relink child of a --sync re-exec adopts the lock its parent took: exec kept
# the pid, so the owner record already names this process. Any other run drops an
# inherited name so it never releases a lock it does not hold.
if [ "$SYNC" = 0 ] && [ "${TAP_INSTALL_SYNC_REEXEC:-0}" = 1 ] && [ -n "${TAP_INSTALL_SYNC_LOCK:-}" ]; then
  if [ "$(tap_install_sync_lock_owner_pid "$TAP_INSTALL_SYNC_LOCK")" = "$$" ]; then
    _sync_lock_held="$TAP_INSTALL_SYNC_LOCK"
    _sync_lock_published=1
    trap 'tap_install_sync_lock_release' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
  else
    echo "install: WARNING: the primary sync lock $TAP_INSTALL_SYNC_LOCK does not name pid $$; relinking without it" >&2
  fi
fi
unset TAP_INSTALL_SYNC_LOCK
if [ "$SYNC" = 1 ]; then
  tap_install_sync_primary "$primary_root"
  # The lock travels across the exec below: the child keeps this pid and adopts
  # it from TAP_INSTALL_SYNC_LOCK. Bash runs no EXIT trap on a successful exec,
  # so the lock is not released early.
  export TAP_INSTALL_SYNC_LOCK="$_sync_lock_held"
  # Re-exec unconditionally (tap-sge4), even when $REPO already IS $primary_root
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
elif [ "$ARTIFACT" = 0 ] && { [ -z "$primary_root" ] || [ "$REPO" != "$primary_root" ]; }; then
  if [ "${TAP_INSTALL_FORCE_NONPRIMARY:-0}" = 1 ]; then
    if [ -n "$primary_root" ]; then
      echo "install: FORCE non-primary install from $REPO (primary: $primary_root)" >&2
    else
      echo "install: FORCE unverified install from $REPO (not a git checkout)" >&2
    fi
  elif ! tap_install_all_targets_redirected; then
    if [ -n "$primary_root" ]; then
      echo "install: REFUSED real-target install from non-primary checkout: $REPO" >&2
      echo "install: persistent primary checkout: $primary_root" >&2
    else
      echo "install: REFUSED real-target install from unverified checkout: $REPO (not a git checkout)" >&2
      echo "install: persistent primary checkout could not be derived" >&2
    fi
    echo "install: run there, redirect every TAP_* install target to scratch, or set TAP_INSTALL_FORCE_NONPRIMARY=1" >&2
    exit 1
  fi
fi

# --- The home install lock (tap-7r3fn.207) ------------------------------------
# Two overlapping plain installs sharing install destinations both exited 0 while
# one left partial-failure warnings (skipped skill links, inert hooks). Every
# shared destination lives under HOME — command links, harness homes, skill
# links, the tools dir — and the audit specimen shared the checkout too, so
# ordinary installs serialize on one lock there. The --sync lock above stays
# checkout-scoped and is untouched: this lock is taken after the sync block's
# re-exec decision, so no run ever holds both in the opposite order (sync, then
# home), and the sync re-exec child takes the home lock exactly once, fresh.
# Scope: the lock keys on the effective HOME — the root the audited overlapping
# installs shared, and the default root of every destination. Runs that redirect
# individual destinations (TAP_*_HOME) into shared paths from DIFFERENT homes
# are outside this key and are not serialized against each other; they must
# target disjoint destinations.
_home_lock=""
tap_install_home_lock_release() {
  local lock="$_home_lock" owner_pid
  [ -n "$lock" ] || return 0
  _home_lock=""
  rm -f -- "${lock:?}/owner.tmp.$$"
  rm -f -- "${lock:?}/owner.pending"
  owner_pid="$(tap_install_sync_lock_owner_pid "$lock")"
  if [ -n "$owner_pid" ] && [ "$owner_pid" != "$$" ]; then
    echo "install: WARNING: the home install lock $lock no longer names pid $$; left in place" >&2
    return 0
  fi
  rm -f -- "${lock:?}/owner"
  rmdir -- "${lock:?}" 2>/dev/null || echo "install: WARNING: could not remove the home install lock $lock" >&2
}

# Remove a dead owner's lock. The shared reclaim guard (its own atomic mkdir)
# keeps two waiters that saw the same dead owner from both removing; under the
# guard the owner is re-read and re-proven dead, so a lock that changed hands
# survives. Returns nonzero unless this call actually removed the dead lock, so
# a failed rename sends the caller back to the bounded wait instead of an
# unbounded retry loop.
tap_install_home_lock_reclaim() { # <lock> <dead_pid>
  local lock="$1" dead_pid="$2" guard="$1.reclaim" stale="$1.stale.$$" moved=0
  mkdir "$guard" 2>/dev/null || return 1
  if [ "$(tap_install_sync_lock_owner_pid "$lock")" = "$dead_pid" ] && tap_install_pid_dead "$dead_pid" \
      && mv "$lock" "$stale"; then
    moved=1
    rm -f -- "${stale:?}/owner"
    rmdir -- "${stale:?}" 2>/dev/null || echo "install: WARNING: could not remove the reclaimed lock $stale" >&2
    echo "install: reclaimed the home install lock from dead pid $dead_pid ($lock)" >&2
  fi
  rmdir -- "${guard:?}" 2>/dev/null || echo "install: next: remove the stale guard $guard, then rerun ./install.sh" >&2
  [ "$moved" = 1 ]
}

# --- Source-package validation (tap-7r3fn.207 fix-forward) --------------------
# Repository-owned inputs are checked before the home-lock section creates
# anything beneath $HOME, so a bad source package is refused without leaving
# state in the user's home (install-primary-guard arm 6).
INGEST_CONTRACT_SOURCE="$REPO/skills/lead/references/ingest/README.md"
[ -f "$INGEST_CONTRACT_SOURCE" ] || {
  echo "install: missing ingest contract source: $INGEST_CONTRACT_SOURCE" >&2
  exit 1
}

_home_lock_wait="${TAP_INSTALL_LOCK_WAIT:-60}"
case "$_home_lock_wait" in ''|*[!0-9]*) _home_lock_wait=60 ;; esac
_home_lock_start="$SECONDS"
_home_lock_held_dir="$HOME/.tap/install.lock"
_home_lock_announced=0
_home_lock_holder=""
mkdir -p "$HOME/.tap" 2>/dev/null || true
while :; do
  if mkdir "$_home_lock_held_dir" 2>/dev/null; then
    _home_lock="$_home_lock_held_dir"
    # Arm cleanup before publishing the owner record, mirroring the sync lock:
    # a failed write or a signal in the ownerless window must never strand a
    # lock no waiter can attribute. Release-only here — tap_install_record is
    # not defined yet, and a trap referencing it would abort on a not-found
    # error before releasing.
    trap 'tap_install_home_lock_release; tap_install_sync_lock_release' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Test-only seam: holds the window between lock-directory creation and
    # owner publication open, so signal-injection regressions can interrupt
    # here deterministically instead of racing a microsecond gap. The marker
    # file appears only after the traps above are armed, so a regression that
    # waits for it always interrupts a protected window; armed traps make the
    # interruption release the lock.
    if [ -n "${TAP_INSTALL_HOME_LOCK_STALL:-}" ]; then
      : > "$_home_lock/owner.pending"
      sleep "$TAP_INSTALL_HOME_LOCK_STALL"
    fi
    if ! { printf 'pid=%s\nsince=%s\nrepo=%s\n' "$$" "$(date +%s)" "$REPO" > "$_home_lock/owner.tmp.$$" \
        && mv "$_home_lock/owner.tmp.$$" "$_home_lock/owner"; }; then
      tap_install_home_lock_release
      echo "install: REFUSED — could not record this run as the owner of the home install lock ($_home_lock)" >&2
      echo "install: next: check free space and permissions under $HOME/.tap, then rerun ./install.sh" >&2
      exit 1
    fi
    break
  fi
  _home_lock_holder_pid="$(sed -n 's/^pid=\([0-9][0-9]*\)$/\1/p' "$_home_lock_held_dir/owner" 2>/dev/null | head -n 1 || true)"
  if [ -n "$_home_lock_holder_pid" ]; then
    _home_lock_holder="pid $_home_lock_holder_pid"
  elif [ -d "$_home_lock_held_dir" ]; then
    _home_lock_holder="an owner that has not written its record"
  elif [ -e "$_home_lock_held_dir" ]; then
    _home_lock_holder="a path that is not a lock directory"
  else
    _home_lock_holder="nothing (mkdir cannot create it)"
  fi
  # The bound is checked on every iteration before any retry shortcut, so no
  # reclaim outcome — including a persistent failure — can loop unbounded.
  if [ $((SECONDS - _home_lock_start)) -ge "$_home_lock_wait" ]; then
    echo "install: REFUSED — another install ($_home_lock_holder) is installing into $HOME" >&2
    case "$_home_lock_holder" in
      "pid "*)
        echo "install: next: wait for it to finish, then rerun ./install.sh" >&2 ;;
      *)
        # An ownerless lock or a path in the way names no live holder to wait
        # for; mirror the release bootstrap's removal guidance.
        echo "install: next: check no install is running, remove $_home_lock_held_dir, then rerun ./install.sh" >&2 ;;
    esac
    if [ -e "$_home_lock_held_dir.reclaim" ]; then
      echo "install: next: remove the stale guard $_home_lock_held_dir.reclaim, then rerun ./install.sh" >&2
    fi
    exit 1
  fi
  if [ -n "$_home_lock_holder_pid" ] && tap_install_pid_dead "$_home_lock_holder_pid" \
      && tap_install_home_lock_reclaim "$_home_lock_held_dir" "$_home_lock_holder_pid"; then
    continue
  fi
  if [ "$_home_lock_announced" = 0 ]; then
    _home_lock_announced=1
    echo "install: waiting up to ${_home_lock_wait}s for the home install lock held by $_home_lock_holder ($_home_lock_held_dir)" >&2
  fi
  sleep 1
done

# The recorder reconciles only TAP-owned artifacts at these explicit install targets.
# EXIT also records completed writes when a later section fails or is interrupted.
export TAP_INSTALL_MANIFEST="${TAP_INDEX_HOME:-$HOME/.tap}/install-manifest.json"
export TAP_INSTALL_REPO="$REPO"
# Preserve prior ownership before --init changes the manifest's repo field.
COMPLETION_DIR="$(dirname "$BIN_DIR")/share/zsh/site-functions"
old_completion_target="$(tap_bun "$REPO/runtime/bun/src/install-manifest.ts" --owned-completion "$COMPLETION_DIR/_tap" 2>/dev/null || true)"
for target_spec in "${INSTALL_TARGET_SPECS[@]}"; do
  target_var="${target_spec%%:*}"
  export "TAP_RECORD_$target_var=${!target_var}"
done
tap_install_record() {
  if ! tap_bun "$REPO/runtime/bun/src/install-manifest.ts" "$@"; then
    echo "install: WARNING: manifest recording incomplete at $TAP_INSTALL_MANIFEST; preserve it and inspect before rerunning ./install.sh" >&2
  fi
  return 0
}

# --- Machine ingest contract -------------------------------------------------
# The repository copy is canonical. Link it so contract fixes land everywhere
# after one primary-checkout install, while preserving a user-owned regular
# file. The source existence check runs in the source-validation section above
# the home lock; only the target side is handled here.
INGEST_DIR="$INDEX_HOME/ingest"
INGEST_CONTRACT_TARGET="$INGEST_DIR/README.md"
# Release the install locks (if this run holds them) after the manifest is recorded.
trap 'tap_install_record; tap_install_home_lock_release; tap_install_sync_lock_release' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Stage the verified private picker before relinking any public command.
tap_bun "$REPO/runtime/bun/src/install-fzf.ts"
tap_install_record --init
tap_install_record
mkdir -p "$INGEST_DIR"
if [ -e "$INGEST_CONTRACT_TARGET" ] && [ ! -L "$INGEST_CONTRACT_TARGET" ]; then
  echo "install: skipped ingest contract — $INGEST_CONTRACT_TARGET exists and is not a symlink (refusing to replace)" >&2
else
  [ "$(readlink "$INGEST_CONTRACT_TARGET" 2>/dev/null || true)" = "$INGEST_CONTRACT_SOURCE" ] || ln -sfn "$INGEST_CONTRACT_SOURCE" "$INGEST_CONTRACT_TARGET"
  install_detail "install: linked ingest contract $INGEST_CONTRACT_TARGET -> $INGEST_CONTRACT_SOURCE"
fi

# Static classifications come from the same policy used by setup and linking.
eval "$(tap_bun "$REPO/runtime/bun/src/skill-policy.ts" classifications)"

shipped_count=0
mw_count=0
local_count=0
retired_count=0
unclassified_count=0
for skill_manifest in "$REPO"/skills/*/SKILL.md; do
  [ -e "$skill_manifest" ] || continue
  skill_manifest=${skill_manifest%/SKILL.md}; skill_name=${skill_manifest##*/}
  shipped_count=$((shipped_count + 1))
  case " ${CORE_SKILLS[*]} ${OPTIONAL_SKILLS[*]} " in
    *" $skill_name "*)
      mw_count=$((mw_count + 1))
      ;;
    *)
      case " ${REPO_LOCAL_SKILLS[*]} " in
        *" $skill_name "*)
          local_count=$((local_count + 1))
          ;;
        *)
          case " ${RETIRED_SKILLS[*]} " in
            *" $skill_name "*)
              retired_count=$((retired_count + 1))
              ;;
            *)
              unclassified_count=$((unclassified_count + 1))
              echo "install: WARNING: skills/$skill_name/SKILL.md is absent from install.sh skill classifications — add $skill_name to skill-policy.ts classifications" >&2
              ;;
          esac
          ;;
      esac
      ;;
  esac
done
install_detail "install: skills: $shipped_count shipped — $mw_count classified machine-wide, $local_count classified repo-local, $retired_count classified retired, $unclassified_count unclassified"

# One harness at a time. The linker links a harness completely or not at all; a
# blocker the user can fix (unwritable home, full disk, a file in the way) prints
# its own warning and exits 0, so the harnesses after it still get linked.
link_user_skills() {
  local output line linked=0 rc
  # Keep stderr live and preserve the linker's exit status. Only known inventory
  # lines are condensed; preservation notices and unexpected output stay visible.
  if output="$(tap_bun "$REPO/runtime/bun/src/install-skill-links.ts" install "$REPO" "$1" "$2")"; then
    while IFS= read -r line; do
      case "$line" in
        "install: linked $1 skill "*)
          SKILL_LINK_COUNT=$((SKILL_LINK_COUNT + 1)); linked=1
          install_detail "$line" ;;
        "install: skipped $1 — "*"does not exist (no $1 install detected)")
          ABSENT_SKILL_HOMES+=("$1"); install_detail "$line" ;;
        "") ;;
        *) echo "$line" ;;
      esac
    done <<< "$output"
    SKILL_HOME_COUNT=$((SKILL_HOME_COUNT + linked))
  else
    rc=$?
    if [ -n "$output" ]; then printf '%s\n' "$output"; fi
    return "$rc"
  fi
}

mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/tap" ] && [ ! -L "$BIN_DIR/tap" ]; then
  echo "install: refusing to replace user-owned $BIN_DIR/tap; next: choose TAP_INSTALL_BIN or move that file" >&2
  exit 1
fi
[ "$(readlink "$BIN_DIR/tap" 2>/dev/null || true)" = "$REPO/bin/tap" ] || ln -sfn "$REPO/bin/tap" "$BIN_DIR/tap"
if [ -z "${TAP_INSTALL_BIN:-}" ]; then tap_install_record --migrate-bin; fi
echo "install: linked $BIN_DIR/tap -> $REPO/bin/tap"

# Zsh discovers the owned adapter when this directory is added to fpath.
mkdir -p "$COMPLETION_DIR"
if [ -e "$COMPLETION_DIR/_tap" ] || [ -L "$COMPLETION_DIR/_tap" ]; then
  completion_target="$(readlink "$COMPLETION_DIR/_tap" 2>/dev/null || true)"
  if [ "$completion_target" = "$REPO/completions/_tap" ]; then
    :
  elif [ -n "$old_completion_target" ] && [ "$completion_target" = "$old_completion_target" ]; then
    ln -sfn "$REPO/completions/_tap" "$COMPLETION_DIR/_tap"
    install_detail "install: relinked zsh completion $COMPLETION_DIR/_tap"
  else
    echo "install: preserving user-owned $COMPLETION_DIR/_tap" >&2
  fi
else
  ln -s "$REPO/completions/_tap" "$COMPLETION_DIR/_tap"
  install_detail "install: linked zsh completion $COMPLETION_DIR/_tap"
fi
tap_install_record


# --- Claude: user-level skills (discovered globally by every session) ----------
link_user_skills Claude "$CLAUDE_HOME"
if [ -d "$CLAUDE_HOME" ]; then
  # Claude hooks: the SessionStart advisory self-silences outside TAP projects;
  # the PreToolUse guard blocks shell-expanded inline TAP bodies. Merged
  # idempotently; opt out with TAP_INSTALL_HOOK=0.
  if [ "${TAP_INSTALL_HOOK:-1}" = 1 ]; then
    tap_bun "$REPO/runtime/bun/src/install-hooks.ts" claude "$CLAUDE_HOME/settings.json" "$REPO/hooks/tap-advisory.sh" "$TAP_SHELL_BODY_GUARD"
  fi
  # Retired UserPromptSubmit roster line (tap-hx4r): runs unconditionally, not
  # gated on TAP_INSTALL_HOOK, so an existing stale registration is cleaned up
  # even on a run that opts out of installing NEW hooks (tap-pkoq precedent —
  # "stop adding" leaves every already-installed seat still spammed until
  # something actively removes it).
  tap_bun "$REPO/runtime/bun/src/install-roster-hook-cleanup.ts" claude "$CLAUDE_HOME/settings.json"
fi

# --- Hermes: user-level skills ------------------------------------------------
link_user_skills Hermes "$HERMES_HOME"

# --- Codex: user-level skills + global AGENTS.md section -----------------------
link_user_skills Codex "$CODEX_HOME"
if [ -d "$CODEX_HOME" ]; then
  tap_bun "$REPO/runtime/bun/src/install-hooks.ts" agents "$CODEX_HOME/AGENTS.md"
  if grep -q '<!-- tap:begin -->' "$CODEX_HOME/AGENTS.md" 2>/dev/null; then
    export TAP_RECORD_AGENTS_DONE=1
  fi
  tap_install_record
  # Codex hooks: keep TAP in the same config.toml hook layer as
  # other user hooks so Codex does not warn about dual hook sources. The TAP
  # fence owns only the canonical TAP arrays. Existing-fence reconciliation
  # preserves every outside byte, including features.hooks. Legacy hooks.json entries are migrated
  # after the inline block is durable.
  if [ "${TAP_INSTALL_HOOK:-1}" = 1 ]; then
    # Validate the owned slice before any config write, then publish atomically.
    _codex_rc=0
    tap_bun "$REPO/runtime/bun/src/install-hooks.ts" codex-config "$CODEX_HOME/config.toml" \
      "$REPO/hooks/tap-codex-session-start.sh" "$TAP_SHELL_BODY_GUARD" || _codex_rc=$?
    case "$_codex_rc" in
      0) : ;;
      3) echo "install: WARNING: skipped Codex legacy hooks.json cleanup — config.toml hooks were not reconciled" >&2 ;;
      *) exit "$_codex_rc" ;;
    esac
    if [ "$_codex_rc" = 0 ]; then
    tap_bun "$REPO/runtime/bun/src/install-hooks.ts" codex-legacy "$CODEX_HOME/hooks.json"
    fi
  fi
else
  install_detail "install: skipped Codex — $CODEX_HOME does not exist (no Codex install detected)"
fi

# --- Cursor sessionStart hook (tap-o6e) --------------------------------------
# Wire identity + advisory into ~/.cursor/hooks.json. Idempotent: updates the
# TAP command path in place; never removes or rewrites claude-mem (or any other)
# entries. Cursor hook schema is flat {command} under camelCase sessionStart
# (not Codex's matcher/hooks nesting). Self-silences outside TAP repos.
if [ "${TAP_INSTALL_HOOK:-1}" = 1 ] && [ -d "$CURSOR_HOME" ]; then
  tap_bun "$REPO/runtime/bun/src/install-hooks.ts" cursor "$CURSOR_HOME/hooks.json" "$REPO/hooks/tap-cursor-session-start.sh" "$TAP_SHELL_BODY_GUARD"
  # DE-WIRE what an earlier release added here. Cursor's beforeSubmitPrompt has no
  # context-injection field (only sessionStart and postToolUse accept
  # additional_context), so that entry was discarded on every prompt while
  # looking installed. Runs when Cursor hooks are enabled so an older install is
  # repaired by ./install.sh --sync; idempotent when there is nothing
  # to remove. Logic lives in its own script so a smoke test can drive it
  # without running this installer.
  tap_bun "$REPO/runtime/bun/src/install-roster-hook-cleanup.ts" cursor "$CURSOR_HOME/hooks.json"
elif [ "${TAP_INSTALL_HOOK:-1}" = 1 ]; then
  install_detail "install: skipped Cursor hooks — $CURSOR_HOME does not exist"
fi

# --- OpenCode session plugins ------------------------------------------------
# Global local plugins are auto-loaded from ~/.config/opencode/plugins. Three
# small plugins, one concern each, plus the session-id helper the session-start
# plugin shells out to at init (tap-cpfu):
#   - session-env:   shell.env -> OPENCODE_SESSION_ID (per-tool-shell identity)
#   - session-start: event() -> bare `tap in` ensure-bound (SessionStart-equivalent,
#                    tap-9kvd) plus the shared session-start context posted into
#                    new root sessions as one noReply message (tap-sh9g).
#   - tmux-guard:    tool.execute.before -> shared native command classifier
#
# This block OVERWRITES ~/.config/opencode/plugins/tap-opencode-session-start.ts
# (and its siblings) from THIS checkout every install. A live probe of an
# unmerged plugin edit is clobbered the next time anyone runs ./install.sh from
# the persistent primary checkout — that overwrite killed the first tap-cpfu
# argv-bind verify. Install from the persistent primary checkout only, and only
# after the hook change has landed there. Never install from a disposable
# worktree (it would publish that worktree's hooks as the machine-wide plugin).
#
# OpenCode is optional, so a failed write here never stops the install (the rule
# every optional user-config writer follows). Plugins are staged in a scratch
# directory beside the target and renamed into place only after every file is
# written, so a full or unwritable disk leaves the previous plugin set untouched
# rather than half-replaced. A failure warns with the target and one retry
# remedy and skips the rest of the block; the "installed" line prints only when
# every step succeeded. This runs in an `if`, where errexit is suspended, so every
# step is checked explicitly.
tap_install_opencode_plugins() {
  local plugins="$OPENCODE_HOME/plugins" stage="" name
  local -a names=(tap-opencode-session-env.ts tap-opencode-session-start.ts tap-opencode-tmux-guard.ts
    tap-shell-body-guard tap-opencode-session-id tap-resolve-session-root tap-session-context tap)
  OPENCODE_FAIL_TARGET="$plugins"
  OPENCODE_REMEDY="fix the error above (permissions or free space under $plugins) and rerun ./install.sh"
  mkdir -p "$plugins" || return 1
  stage="$(mktemp -d "$plugins/.tap-stage.XXXXXX")" || return 1
  tap_install_opencode_stage "$stage" || { rm -rf "${stage:?}"; return 1; }
  # A directory squatting on a plugin name would swallow the rename (mv moves a
  # file INTO a directory), so refuse it before anything is published.
  for name in "${names[@]}"; do
    if [ -d "$plugins/$name" ]; then
      OPENCODE_FAIL_TARGET="$plugins/$name (a directory is in the way)"
      OPENCODE_REMEDY="move $plugins/$name aside and rerun ./install.sh"
      rm -rf "${stage:?}"
      return 1
    fi
  done
  for name in "${names[@]}"; do
    if ! mv -f "$stage/$name" "$plugins/$name"; then
      OPENCODE_FAIL_TARGET="$plugins/$name"
      OPENCODE_REMEDY="fix the error above (permissions or free space under $plugins) and rerun ./install.sh to complete the set"
      OPENCODE_PARTIAL=1
      rm -rf "${stage:?}"
      return 1
    fi
  done
  rm -rf "${stage:?}"
}

tap_install_opencode_stage() {
  local stage="$1"
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-opencode-session-env.ts"
  cp "$REPO/hooks/tap-opencode-session-env.ts" "$stage/tap-opencode-session-env.ts" || return 1
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-opencode-session-start.ts"
  cp "$REPO/hooks/tap-opencode-session-start.ts" "$stage/tap-opencode-session-start.ts" || return 1
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-opencode-tmux-guard.ts"
  cp "$REPO/hooks/tap-opencode-tmux-guard.ts" "$stage/tap-opencode-tmux-guard.ts" || return 1
  # Sibling guard shim — the tmux-guard plugin spawns tap-shell-body-guard
  # (extensionless), which execs the checkout's Bun hook directly (absolute
  # quoted path) so nothing imports runtime/ relatively from the installed
  # copy. Stale tap-shell-body-guard.py copies left by older installs are
  # retired below by the manifest recorder's hash-matched cleanup.
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-shell-body-guard"
  cat >"$stage/tap-shell-body-guard" <<EOF || return 1
#!/usr/bin/env bash
exec $TAP_HOOK_BUN "$REPO/hooks/tap-shell-body-guard.ts" "\$@"
EOF
  chmod +x "$stage/tap-shell-body-guard" || return 1
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-opencode-session-id"
  cp "$REPO/hooks/tap-opencode-session-id" "$stage/tap-opencode-session-id" || return 1
  chmod +x "$stage/tap-opencode-session-id" || return 1
  # Sibling resolver wrapper — OpenCode plugins are copied out of the checkout;
  # the session-start plugin shells out here for the native session-root rule
  # without requiring `tap` on PATH (install bin may be off PATH).
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-resolve-session-root"
  cat >"$stage/tap-resolve-session-root" <<EOF || return 1
#!/usr/bin/env bash
exec $TAP_HOOK_BUN "$REPO/runtime/bun/src/session-start.ts" resolve "\$@"
EOF
  chmod +x "$stage/tap-resolve-session-root" || return 1
  # Sibling context shim — the session-start plugin posts the ONE shared context
  # (session-start.ts `context <root>` mode, tap-sh9g) into new sessions without
  # requiring `tap` on PATH or a second content producer.
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap-session-context"
  cat >"$stage/tap-session-context" <<EOF || return 1
#!/usr/bin/env bash
exec $TAP_HOOK_BUN "$REPO/runtime/bun/src/session-start.ts" "\$@"
EOF
  chmod +x "$stage/tap-session-context" || return 1
  # Sibling `tap` — install-owned bind authority for no-PATH seats. Points at the
  # persistent checkout's bin/tap, never at <team>/scripts/tap.sh.
  OPENCODE_FAIL_TARGET="$OPENCODE_HOME/plugins/tap"
  cat >"$stage/tap" <<EOF || return 1
#!/usr/bin/env bash
exec "$REPO/bin/tap" "\$@"
EOF
  chmod +x "$stage/tap" || return 1
}

if [ "${TAP_INSTALL_HOOK:-1}" = 1 ] && [ -d "$OPENCODE_HOME" ]; then
  OPENCODE_FAIL_TARGET="" OPENCODE_REMEDY="" OPENCODE_PARTIAL=0
  if tap_install_opencode_plugins; then
    echo "install: installed OpenCode plugins at $OPENCODE_HOME/plugins/ (session-env + session-start + tmux-guard + helpers)"
  elif [ "$OPENCODE_PARTIAL" = 1 ]; then
    echo "install: WARNING: OpenCode session plugins may be partially updated — could not replace $OPENCODE_FAIL_TARGET; next: $OPENCODE_REMEDY (OpenCode integration NOT confirmed installed)" >&2
  else
    echo "install: WARNING: skipped OpenCode session plugins — could not write $OPENCODE_FAIL_TARGET; next: $OPENCODE_REMEDY (OpenCode integration NOT installed; the rest of the install continues)" >&2
  fi
elif [ "${TAP_INSTALL_HOOK:-1}" = 1 ]; then
  install_detail "install: skipped OpenCode session plugins — $OPENCODE_HOME does not exist"
fi

# --- OpenCode / Antigravity / Cursor-agent shared skill homes -----------------
# An unwritable OpenCode home is warned about by the skill linker itself, like
# every other harness, so no separate skip is needed here.
link_user_skills OpenCode "$OPENCODE_HOME"

# Antigravity (agy/Gemini) loads global skills from ~/.gemini/skills/<name>/SKILL.md
# (YAML frontmatter + Markdown) — same shape as the others, so the shared linker
# applies unchanged (tap-luae). agy also offers a native `agy plugin import claude`;
# we deliberately do NOT use it — one install mechanism, symmetric with every harness.
link_user_skills Antigravity "$GEMINI_HOME"
if [ "${TAP_INSTALL_HOOK:-1}" = 1 ] && [ -d "$GEMINI_HOME" ]; then
  mkdir -p "$GEMINI_HOME/config"
  tap_bun "$REPO/runtime/bun/src/install-hooks.ts" gemini "$GEMINI_HOME/config/hooks.json" "$TAP_SHELL_BODY_GUARD"
fi

link_user_skills Cursor-agent "$CURSOR_AGENT_HOME"

link_user_skills "shared agents" "$AGENTS_HOME"

echo "install: $SKILL_LINK_COUNT skill links refreshed across $SKILL_HOME_COUNT homes"
if [ "${#ABSENT_SKILL_HOMES[@]}" -gt 0 ]; then
  echo "install: optional skill homes absent: ${ABSENT_SKILL_HOMES[*]}"
fi
echo "install: inventory: $TAP_INSTALL_MANIFEST (per-link output: ./install.sh --verbose)"

# TRACKED HOOKS ONLY RUN IF core.hooksPath POINTS AT THEM (tap-xmuwz).
# `core.hooksPath` is LOCAL config, not tracked content, so a fresh clone has it
# unset and runs `.git/hooks` — where nothing lives. A guard hook would be present
# in the tree and inert. Setting this is what makes a checkout protected. The
# checkout names its hook files with the `tap-hooks` attribute; a checkout that
# marks none is left alone.
#
# Hook installers that set this config for you commonly OVERWRITE a hook file
# in whatever directory it names (measured with one tracker's installer on every
# hooks directory tried). So a hook may also declare `tap-hook-marker=<token>`,
# and install warns whenever that file no longer contains the token — clean or
# dirty, because a committed overwrite is clean.
#
# ABSOLUTE, not relative. `git config --local` is ONE file shared by every linked
# worktree while a relative value resolves per checkout, so arming the primary
# would propagate the setting everywhere and the BYTES nowhere: a worktree on a
# pre-change commit runs its own old hook and can still create `main`. Measured
# — config inherited, old hook executed, push rc=0.
#
# ONLY ON THE PRIMARY. `$REPO` is dirname(install.sh) and may be a linked
# worktree or an extracted archive; writing from one of those would pin the whole
# clone at that tree's hook file. `primary_root` is already resolved above for
# the sync/force logic, so this reuses it rather than deriving the same answer a
# second way. A non-primary run leaves the config alone — forced installs, source
# archives, and hook development from a lane are outside this guard's acceptance
# surface by design, not by oversight.
_hookdir=""
if [ -n "$primary_root" ] && [ "$REPO" = "$primary_root" ]; then
  _hookdir="$(tap_install_hooks_dir "$primary_root")"
fi
if [ -n "$_hookdir" ]; then
  _hp="$(git -C "$REPO" config --local core.hooksPath 2>/dev/null || true)"
  if [ "$_hp" != "$_hookdir" ]; then
    if git -C "$REPO" config --local core.hooksPath "$_hookdir" 2>/dev/null; then
      echo "install: set core.hooksPath=$_hookdir (tracked hooks now active in every worktree of this clone)"
    else
      echo "install: WARNING: could not set core.hooksPath; the tracked hooks in $_hookdir are INERT here." >&2
      echo "install:   set it manually: git -C \"$REPO\" config --local core.hooksPath \"$_hookdir\"" >&2
    fi
  fi
  # install-manifest.ts records the config only while it still holds this value.
  export TAP_INSTALL_HOOKS_PATH="$_hookdir"
  while IFS= read -r -d '' _hook && IFS= read -r -d '' _attr && IFS= read -r -d '' _marker; do
    case "$_marker" in unspecified|set|unset) continue ;; esac
    if ! grep -qF -- "$_marker" "$REPO/$_hook" 2>/dev/null; then
      echo "install: WARNING: $REPO/$_hook no longer contains its tap-hook-marker ($_marker); a hook installer may have overwritten it." >&2
      echo "install:   inspect it, then restore the tracked version: git -C \"$REPO\" checkout <commit> -- \"$_hook\"" >&2
    fi
  done < <(git -C "$REPO" ls-files -z -- ':(attr:tap-hooks)' 2>/dev/null | git -C "$REPO" check-attr --cached -z --stdin tap-hook-marker 2>/dev/null)
  if ! git -C "$REPO" diff --quiet -- "$_hookdir" 2>/dev/null; then
    echo "install: WARNING: tracked hooks in $_hookdir differ from HEAD; restore: git -C \"$REPO\" checkout -- \"$_hookdir\"" >&2
  fi
fi

if [ "$ARTIFACT" = 1 ]; then
  tap_release="$(jq -r '"release \(.version) (source \(.commit[0:12]))"' "$REPO/tap-release.json" 2>/dev/null)" || tap_release="release (tap-release.json unreadable)"
  echo "install: $tap_release at $REPO" >&2
else
  tap_install_report_checkout "$REPO"
fi
# Explicit setup may be rerun; an ordinary sync never prompts.
SETUP_RAN=0
config_path="${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml"
if [ "$SETUP" = 1 ] || { [ "$SYNC" = 0 ] && [ "${TAP_INSTALL_SYNC_REEXEC:-0}" != 1 ] && [ -t 0 ] && [ -t 1 ] && [ ! -e "$config_path" ]; }; then
  tap_install_record
  if bash "$REPO/bin/tap" setup --machine; then SETUP_RAN=1; else SETUP_RAN=2; echo "install: setup incomplete: rerun tap setup --machine" >&2; fi
  # Offered with the same first-run setup, never on an ordinary sync; one source line in tmux.conf, removable with `tap keybinding remove`.
  if [ -t 0 ] && [ -t 1 ] && command -v tmux >/dev/null 2>&1; then
    printf 'Install the TAP agent lookup keybinding (prefix @)? [Y/n] '
    read -r _kb_answer || _kb_answer=n
    case "${_kb_answer:-Y}" in
      [Yy]*) bash "$REPO/bin/tap" keybinding install --tap "$BIN_DIR/tap" || echo "install: keybinding not installed; retry: tap keybinding install" >&2 ;;
      *) echo "install: skipped; later: tap keybinding install" ;;
    esac
  fi
else
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "install: interactive machine setup skipped (no terminal). next: tap setup --machine --answers <file> (see docs/EASY-MODE.md); use --dry-run to preview."
    echo "install: presets are optional; bare launch: tap session launch <harness> <name>"
    echo "install: optional tmux lookup key (prefix @ fuzzy-picks a teammate): tap keybinding install"
  else
    echo "install: next: tap setup --machine (configure this machine interactively)"
  fi
fi

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    if [ "$SETUP_RAN" = 1 ] && [ -f "$config_path" ]; then
      echo "install: setup completed; config written at $config_path. $BIN_DIR is not on the current shell PATH." >&2
    elif [ "$SETUP_RAN" = 1 ] && [ -f "${config_path%/*}/config.candidate.toml" ]; then
      echo "install: setup completed; candidate config written at ${config_path%/*}/config.candidate.toml. $BIN_DIR is not on the current shell PATH." >&2
    else
      echo "install: links installed; shell setup required — $BIN_DIR is not on PATH." >&2
      echo "install: after fixing PATH, configure with tap setup --machine --answers <file>, or run tap setup --machine in a terminal." >&2
    fi
    printf 'install: open a new terminal if you enabled shell integration, or run in this terminal: export PATH=%q:"$PATH"\n' "$BIN_DIR" >&2
    [ "$SETUP_RAN" != 2 ] || exit 2
    echo "install: completed; add $BIN_DIR to PATH, then run tap help" >&2
    exit 0
    ;;
esac
if [ ! -x "$BIN_DIR/tap" ] || ! command -v tap >/dev/null 2>&1; then
  echo "install: shell setup incomplete — $BIN_DIR/tap is not executable. Restore bin/tap in this checkout and rerun install.sh." >&2
  exit 1
fi
[ "$SETUP_RAN" != 2 ] || exit 2
if [ "$ARTIFACT" = 1 ]; then
  echo "install: done — $tap_release at $REPO; try: tap help  (agent sessions pick up the skills on next start)"
  exit 0
fi
case "${_co_status:-cannot_check}" in
  live)
    echo "install: done — try: tap help  (agent sessions pick up the skills on next start)"
    ;;
  stale)
    echo "install: done — links refreshed; checkout STALE (code not live). next: ${_co_next}"
    ;;
  *)
    echo "install: done — links refreshed; checkout CANNOT-CHECK (did not verify live). next: ${_co_next}"
    ;;
esac
