#!/usr/bin/env bash
# install-sync-lock.test.sh — two `install.sh --sync` runs on one primary must
# not race (tap-axo6o). --sync holds one bounded lock for the whole fetch,
# fast-forward and relink transaction, carried across its re-exec. A waiter says
# it waited and for how long; a dead owner's lock is reclaimed with a note; a live
# owner past the bound refuses with [sync-locked]. The interrupted fast-forward a
# racing sync used to leave (index at origin/main's tree, HEAD behind) completes;
# a different ambiguous index still refuses as [in-flight].
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
PRIMARY="$WORK/primary"
ORIGIN="$WORK/origin.git"
PUSHER="$WORK/pusher"
SCRATCH="$WORK/scratch"
SHIM="$WORK/shim"
LOCK="$PRIMARY/.git/tap-install-sync.lock"
REAL_GIT="$(command -v git)"
live_holder=""

cleanup() {
  if [ -n "$live_holder" ]; then kill "$live_holder" 2>/dev/null || true; fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

fail() { echo "install-sync-lock: $*" >&2; exit 1; }

run_install() {
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
    bash "$@"
}

git_ok() {
  git -C "$PRIMARY" -c user.name=TAP -c user.email=tap@example.invalid "$@"
}

seed_primary() {
  mkdir -p "$PRIMARY/skills/lead/references/ingest" "$PRIMARY/skills/tap/scripts" "$PRIMARY/bin" "$PRIMARY/gen"
  printf 'export.jsonl tap-sync-regenerable\n' > "$PRIMARY/gen/.gitattributes"
  cp "$ROOT/install.sh" "$PRIMARY/install.sh"
  mkdir -p "$PRIMARY/runtime/bun/src"
  cp "$ROOT/runtime/bun/src/"{config-file,config-error,skill-policy,install-skill-links,install-skill-plugin,install-roster-hook-cleanup,install-manifest,install-fzf,fzf-tool,install-hooks,install-history,watch-detect,lossless-json,pyint,spool-publication,fsatomic,panelock,remind-lock,unicode-decimal,codex-fence}.ts "$PRIMARY/runtime/bun/src/"
  cp -R "$ROOT/skills/." "$PRIMARY/skills"
  cp -R "$ROOT/vendor" "$PRIMARY/vendor"
  printf '#!/bin/sh\necho tap-fixture\n' > "$PRIMARY/bin/tap"
  chmod +x "$PRIMARY/bin/tap"
  git -C "$PRIMARY" init -q -b main
  git -C "$PRIMARY" config user.name TAP
  git -C "$PRIMARY" config user.email tap@example.invalid
  git -C "$PRIMARY" add install.sh runtime vendor skills bin gen/.gitattributes
  git_ok commit -qm seed
  git init -q --bare -b main "$ORIGIN"
  git -C "$PRIMARY" remote add origin "$ORIGIN"
  git_ok push -q -u origin main
  git clone -q "$ORIGIN" "$PUSHER"
  git -C "$PUSHER" config user.name TAP
  git -C "$PUSHER" config user.email tap@example.invalid
}

# Advance origin by one commit that changes a real file, so a fast-forward moves
# both the ref and the tree.
advance_origin() {
  printf '%s\n' "$1" > "$PUSHER/notes-$1.txt"
  git -C "$PUSHER" add "notes-$1.txt"
  git -C "$PUSHER" commit -qm "origin advances: $1"
  git -C "$PUSHER" push -q origin main
  git -C "$PUSHER" rev-parse HEAD
}

fresh_scratch() {
  rm -rf "${SCRATCH:?}"
  mkdir -p "$SCRATCH"
}

write_owner() {
  mkdir "$LOCK"
  printf 'pid=%s\nsince=%s\nrepo=%s\n' "$1" "$(date +%s)" "$PRIMARY" > "$LOCK/owner"
}

seed_primary

# (1) Two --sync runs started together both succeed, the primary ends at
# origin/main, and the run that queued says it waited and for how long. A git
# shim slows each fetch so the first holder is still inside its transaction when
# the second arrives; without a lock the two fetch and fast-forward at once.
target="$(advance_origin one)"
mkdir -p "$SHIM"
cat > "$SHIM/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [ "\$arg" = fetch ]; then sleep 4; break; fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$SHIM/git"
fresh_scratch
PATH="$SHIM:$PATH" run_install "$PRIMARY/install.sh" --sync > "$WORK/a.out" 2>&1 &
pid_a=$!
sleep 2
PATH="$SHIM:$PATH" run_install "$PRIMARY/install.sh" --sync > "$WORK/b.out" 2>&1 &
pid_b=$!
rc_a=0; wait "$pid_a" || rc_a=$?
rc_b=0; wait "$pid_b" || rc_b=$?
[ "$rc_a" -eq 0 ] || fail "(1) first concurrent --sync exited $rc_a: $(cat "$WORK/a.out")"
[ "$rc_b" -eq 0 ] || fail "(1) second concurrent --sync exited $rc_b: $(cat "$WORK/b.out")"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$target" ] \
  || fail "(1) primary did not end at origin/main: $(cat "$WORK/a.out" "$WORK/b.out")"
# Either run may win the race to the lock; exactly one queues behind the other.
if grep -q 'lock acquired after waiting' "$WORK/a.out"; then waiter=a; holder=b; else waiter=b; holder=a; fi
grep -q 'lock acquired after waiting [0-9][0-9]*s' "$WORK/$waiter.out" \
  || fail "(1) neither receipt says how long it waited: $(cat "$WORK/a.out" "$WORK/b.out")"
! grep -q 'lock acquired after waiting' "$WORK/$holder.out" \
  || fail "(1) both runs claim to have waited: $(cat "$WORK/a.out" "$WORK/b.out")"
holder_pid="$(sed -n 's/^install: --sync holding the primary sync lock (pid \([0-9][0-9]*\)).*/\1/p' "$WORK/$holder.out" | head -n 1)"
[ -n "$holder_pid" ] || fail "(1) the holder's receipt does not name its pid: $(cat "$WORK/$holder.out")"
grep -q "waiting up to [0-9][0-9]*s for the primary sync lock held by pid $holder_pid" "$WORK/$waiter.out" \
  || fail "(1) the queued run did not say whom it waited on (pid $holder_pid): $(cat "$WORK/$waiter.out")"
[ ! -e "$LOCK" ] || fail "(1) lock left behind after both runs: $(cat "$LOCK/owner" 2>&1)"
[ -L "$SCRATCH/bin/tap" ] || fail "(1) relink did not complete"
echo "install-sync-lock: (1) two concurrent --sync runs serialize; the waiter reports its wait: ok"

# (2) A lock whose recorded owner is dead is reclaimed with a note naming it.
"$REAL_GIT" --version >/dev/null &
dead_pid=$!
wait "$dead_pid"
kill -0 "$dead_pid" 2>/dev/null && fail "(2) setup: pid $dead_pid still alive"
write_owner "$dead_pid"
target="$(advance_origin two)"
fresh_scratch
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || fail "(2) --sync refused a dead owner's lock: $out"
[[ "$out" == *"reclaimed the primary sync lock from dead pid $dead_pid"* ]] \
  || fail "(2) reclaim was silent or did not name pid $dead_pid: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$target" ] || fail "(2) --sync did not fast-forward: $out"
[ ! -e "$LOCK" ] || fail "(2) lock left behind"
echo "install-sync-lock: (2) a dead owner's lock is reclaimed with a note: ok"

# (3) A live owner past the bound refuses with a stable class naming the holder
# and exactly one recovery line; the primary is untouched.
sleep 60 &
live_holder=$!
write_owner "$live_holder"
before="$(git -C "$PRIMARY" rev-parse HEAD)"
advance_origin three >/dev/null
fresh_scratch
rc=0
out="$(TAP_INSTALL_SYNC_LOCK_WAIT=2 run_install "$PRIMARY/install.sh" --sync 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(3) --sync ran past a live owner: $out"
[[ "$out" == *"REFUSED --sync — [sync-locked]"*"pid $live_holder"* ]] \
  || fail "(3) refusal did not carry [sync-locked] and the holder pid: $out"
[ "$(printf '%s\n' "$out" | grep -c '^install: next:')" -eq 1 ] \
  || fail "(3) refusal must carry exactly one next: line: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$before" ] || fail "(3) primary moved under a refused --sync"
grep -q "^pid=$live_holder\$" "$LOCK/owner" || fail "(3) the refused run disturbed the live owner's lock"
kill "$live_holder"
wait "$live_holder" 2>/dev/null || true
live_holder=""
rm -f "${LOCK:?}/owner"
rmdir "${LOCK:?}"
echo "install-sync-lock: (3) a live owner past the bound refuses with [sync-locked]: ok"

# (4) The interrupted fast-forward shape from the specimens: index and worktree
# hold origin/main's tree, HEAD is behind it, no sync is live. --sync completes
# the fast-forward instead of refusing [in-flight].
git_ok fetch -q origin main
old="$(git -C "$PRIMARY" rev-parse HEAD)"
target="$(git -C "$PRIMARY" rev-parse origin/main)"
[ "$old" != "$target" ] || fail "(4) setup: primary is not behind"
git_ok reset -q --hard "$target"
git_ok update-ref refs/heads/main "$old"
[ -n "$(git -C "$PRIMARY" status --porcelain)" ] || fail "(4) setup did not reproduce the staged interrupted-ff shape"
fresh_scratch
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || fail "(4) interrupted fast-forward was refused: $out"
[[ "$out" == *"completing an interrupted fast-forward"* ]] || fail "(4) completion was not reported: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$target" ] || fail "(4) HEAD did not reach origin/main: $out"
[ -z "$(git -C "$PRIMARY" status --porcelain)" ] || fail "(4) tree not clean after completion: $(git -C "$PRIMARY" status --porcelain)"
echo "install-sync-lock: (4) the interrupted fast-forward shape completes: ok"

# (5) A different ambiguous index — origin/main's tree plus one extra staged
# file — is not that shape and refuses [in-flight] exactly as before.
target="$(advance_origin five)"
git_ok fetch -q origin main
old="$(git -C "$PRIMARY" rev-parse HEAD)"
git_ok reset -q --hard "$target"
git_ok update-ref refs/heads/main "$old"
printf 'not from origin\n' > "$PRIMARY/extra.txt"
git_ok add extra.txt
fresh_scratch
rc=0
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(5) an ambiguous index was not refused: $out"
[[ "$out" == *"REFUSED --sync — [in-flight]"* ]] || fail "(5) wrong refusal for an ambiguous index: $out"
[[ "$out" != *"completing an interrupted fast-forward"* ]] || fail "(5) completion fired on an ambiguous index: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$old" ] || fail "(5) HEAD moved on an ambiguous index"
[ ! -e "$LOCK" ] || fail "(5) a refusal left the lock behind"
echo "install-sync-lock: (5) another ambiguous index still refuses [in-flight]: ok"

# (6) The interrupted-ff index with non-regenerable worktree dirt beside it is
# not completable: --sync would refuse that dirt as in-flight afterwards, so it
# refuses first and main does not move under a refusal.
rm -f "${PRIMARY:?}/extra.txt"
git_ok reset -q --hard "$old"
target="$(advance_origin six)"
git_ok fetch -q origin main
old="$(git -C "$PRIMARY" rev-parse HEAD)"
git_ok reset -q --hard "$target"
git_ok update-ref refs/heads/main "$old"
printf 'local edit\n' >> "$PRIMARY/notes-one.txt"
fresh_scratch
rc=0
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(6) worktree dirt beside an interrupted ff was not refused: $out"
[[ "$out" == *"REFUSED --sync — [in-flight]"* ]] || fail "(6) wrong refusal: $out"
[[ "$out" != *"completing an interrupted fast-forward"* ]] || fail "(6) completion fired beside non-regenerable dirt: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$old" ] || fail "(6) main moved under a refusal"
echo "install-sync-lock: (6) interrupted ff beside non-regenerable dirt refuses before moving main: ok"

# (7) An UNTRACKED regenerable path beside the interrupted-ff index has no
# index entry to restore from, so it disqualifies completion too.
git_ok checkout -q -- notes-one.txt
git_ok reset -q --hard "$target"
git_ok update-ref refs/heads/main "$old"
printf '{}\n' > "$PRIMARY/gen/export.jsonl"
fresh_scratch
rc=0
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(7) untracked regenerable beside an interrupted ff was not refused: $out"
[[ "$out" != *"completing an interrupted fast-forward"* ]] || fail "(7) completion fired beside an untracked path: $out"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$old" ] || fail "(7) main moved under a refusal"
echo "install-sync-lock: (7) interrupted ff beside an untracked regenerable path refuses before moving main: ok"

# (8) Publishing the owner record fails after mkdir took the lock (a full disk,
# here an mv shim). The run refuses [sync-locked] and leaves no orphan lock that
# every later --sync would wait on, unattributed, until its bound.
rm -f "${PRIMARY:?}/gen/export.jsonl"
git_ok reset -q --hard "$old"
mkdir -p "$WORK/mvshim"
REAL_MV="$(command -v mv)"
cat > "$WORK/mvshim/mv" <<EOF
#!/usr/bin/env bash
case "\${*: -1}" in */tap-install-sync.lock/owner) echo "mv: simulated write failure" >&2; exit 1 ;; esac
exec "$REAL_MV" "\$@"
EOF
chmod +x "$WORK/mvshim/mv"
fresh_scratch
rc=0
out="$(PATH="$WORK/mvshim:$PATH" run_install "$PRIMARY/install.sh" --sync 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "(8) an unpublished owner record did not refuse: $out"
[[ "$out" == *"REFUSED --sync — [sync-locked] could not record this run as the owner"* ]] || fail "(8) wrong refusal: $out"
[ ! -e "$LOCK" ] || fail "(8) a failed owner publication left the lock behind: $(ls -la "$LOCK")"
[ "$(git -C "$PRIMARY" rev-parse HEAD)" = "$old" ] || fail "(8) main moved under a refusal"
fresh_scratch
out="$(run_install "$PRIMARY/install.sh" --sync 2>&1)" || fail "(8) the next --sync did not proceed: $out"
[[ "$out" != *"waiting up to"* ]] || fail "(8) the next --sync waited on an orphan: $out"
echo "install-sync-lock: (8) a failed owner publication releases the lock: ok"

echo "install-sync-lock: ok"
