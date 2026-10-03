#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# worktree-gc-predicate.test.sh — tap-3hf6. Pins `tap worktree check`.
#
# Every arm here is a REPRODUCED INCIDENT or a non-negotiable from the bead, and
# each is written to fail if the predicate drifts back toward the shape that
# caused it. The two the helper exists for:
#
#   A squash-merged branch MUST reclaim. Its commits are orphaned by the squash,
#   so any ancestry- or reachability-keyed check calls it unmerged and the tree
#   never gets reaped (guidelines :43-57).
#
#   A zero-ahead live branch MUST NOT reclaim (tap-t7rk — reaped mid-work). And
#   per the reviewer's amendment, neither may a fresh tree with zero commits:
#   "nothing would be lost" is a PRESERVATION fact, and a checker that reads it
#   as completion reaps the same live tree for a new reason.
#
# The fixture drives the REAL helper, never a mirror of its git commands — that
# mirroring is the drift munder-difflin's own verifier shipped with.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "worktree-gc-predicate: $*" >&2; exit 1; }

export GIT_CONFIG_GLOBAL="$WORK/gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.email t@example.com
git config --file "$GIT_CONFIG_GLOBAL" user.name t
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

BIN="$WORK/bin"; mkdir -p "$BIN"
# gh stub: each arm writes state/merge/head and optional comma-joined commit oids to a file
# named for the ref, so no arm depends on the network or on a real PR. The oids
# are what let an arm distinguish "this tree holds that PR's work" from "the name
# happens to end in that number". Quoted heredoc (tap-psif class).
cat > "$BIN/gh" <<'GH'
#!/usr/bin/env bash
# args: -R <url> pr view <ref> --json state,mergeCommit,headRefOid -q '<expr>'
# Only return the fourth field when the caller actually requests commits.
ref=""
fields=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    pr) shift; [ "${1:-}" = view ] && shift; ref="${1:-}"; shift || true ;;
    --json) shift; fields="${1:-}"; shift || true ;;
    *) shift ;;
  esac
done
# Every call is recorded before any lookup, so an arm can assert that a route
# made NO GitHub query at all (tap-6a4ao: the containment route must not).
printf '%s\n' "$ref" >> "${GH_STUB_STATE_DIR:?}/.calls"
state="$(cat "${GH_STUB_STATE_DIR:?}/$ref" 2>/dev/null || true)"
[ -n "$state" ] || exit 1
# R12 ruling 1: a state file starting FAIL: prints the remainder (PARTIAL
# stdout) and then exits 3 — a failed query whose output must be discarded.
case "$state" in
  FAIL:*) printf '%s\n' "${state#FAIL:}"; exit 3 ;;
esac
case ",$fields," in
  *,commits,*) printf '%s\n' "$state" ;;
  *) printf '%s\n' "$state" | cut -f1-3 ;;
esac
GH
chmod +x "$BIN/gh"
export GH_STUB_STATE_DIR="$WORK/gh-states"; mkdir -p "$GH_STUB_STATE_DIR"
: > "$GH_STUB_STATE_DIR/.calls"
gh_calls() { wc -l < "$GH_STUB_STATE_DIR/.calls" | tr -d ' '; }
# Isolate the machine index: without this the helper reads the OPERATOR's real
# enrolled teams and every arm's verdict depends on live state (tap-3ywn class).
export TAP_INDEX_HOME="$WORK/index"; mkdir -p "$TAP_INDEX_HOME"

check() { PATH="$BIN:$PATH" bash "$TAP" worktree check "$@" 2>&1 || true; }
verdict() { check "$1" | awk -F'\t' 'NR==1 { print $1 }'; }

# --- fixture: an origin, a primary checkout, and lanes off it ------------------
ORIGIN="$WORK/origin.git"
git init -q --bare "$ORIGIN"
PRIMARY="$WORK/primary"
git init -q "$PRIMARY"
git -C "$PRIMARY" remote add origin "$ORIGIN"
printf 'base\n' > "$PRIMARY/file.txt"
git -C "$PRIMARY" add -A && git -C "$PRIMARY" commit -qm base
git -C "$PRIMARY" push -q origin main
git -C "$PRIMARY" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main

# (1) SQUASH-MERGED BRANCH -> reclaim.
# The lane commits its change; main then gets the SAME CONTENT under a different
# commit id, exactly as a squash-merge produces. The lane's own commit is now
# reachable from no remote ref — the condition that defeats ancestry checks.
SQUASHED="$WORK/Squashed"
git -C "$PRIMARY" worktree add -q -b lane/squashed "$SQUASHED" main
printf 'landed\n' > "$SQUASHED/file.txt"
git -C "$SQUASHED" add -A && git -C "$SQUASHED" commit -qm "lane work"
printf 'landed\n' > "$PRIMARY/file.txt"
git -C "$PRIMARY" add -A && git -C "$PRIMARY" commit -qm "squash of lane work"
git -C "$PRIMARY" push -q origin main
git -C "$SQUASHED" fetch -q origin
mkdir -p "$GH_STUB_STATE_DIR/lane"
# R3 (tap-dg8g): the stub now carries the PR head oid, so the corroboration
# clause is exercised — the tree's tip IS the merged PR's head here.
printf 'MERGED\t\t%s\n' "$(git -C "$SQUASHED" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/squashed"
[ "$(verdict "$SQUASHED")" = reclaim ] \
  || fail "(1) squash-merged branch must reclaim, got: $(check "$SQUASHED")"
# The whole point, stated as its own assertion: ancestry says UNMERGED here.
git -C "$SQUASHED" merge-base --is-ancestor HEAD origin/main 2>/dev/null \
  && fail "(1) fixture is not exercising the squash case — HEAD is an ancestor of main"

# (2) ZERO-AHEAD BRANCH WITH AN OPEN PR -> keep. An open PR is not completion.
OPENPR="$WORK/OpenPr"
git -C "$PRIMARY" worktree add -q -b lane/open "$OPENPR" main
mkdir -p "$GH_STUB_STATE_DIR/lane"; printf 'OPEN\t\t\n' > "$GH_STUB_STATE_DIR/lane/open"
[ "$(verdict "$OPENPR")" = keep ] \
  || fail "(2) open PR must not reclaim, got: $(check "$OPENPR")"

# (3) FRESH TREE, ZERO COMMITS, CLEAN, NO PR -> keep (the amendment fixture).
# Content is identical to base and nothing is ahead, so every PRESERVATION fact
# is true. Completion evidence is absent, and that alone must decide it. This is
# tap-t7rk's exact shape.
FRESH="$WORK/Fresh"
git -C "$PRIMARY" worktree add -q -b lane/fresh "$FRESH" main
[ "$(verdict "$FRESH")" = keep ] \
  || fail "(3) fresh zero-commit tree must NOT reclaim, got: $(check "$FRESH")"
git -C "$FRESH" diff --quiet origin/main HEAD \
  || fail "(3) fixture is not exercising the amendment — content already differs from base"

# (4) DIRTY TREE -> hold, even with a MERGED PR. State outranks evidence.
DIRTY="$WORK/Dirty"
git -C "$PRIMARY" worktree add -q -b lane/dirty "$DIRTY" main
printf 'uncommitted\n' > "$DIRTY/file.txt"
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/dirty"
[ "$(verdict "$DIRTY")" = hold ] \
  || fail "(4) dirty tree must hold, got: $(check "$DIRTY")"

# (5) PRIMARY CHECKOUT -> refuse. Identity outranks both state and evidence.
# The MERGED state is what makes this arm discriminating: without it the primary
# is on `main` with no PR and would read `keep` anyway, so a helper that had lost
# the refusal entirely would still pass a bare "not reclaim" assertion.
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/main"
[ "$(verdict "$PRIMARY")" = refuse ] \
  || fail "(5) primary checkout must refuse, got: $(check "$PRIMARY")"

# (6) GIT QUERY ERROR -> keep, fail-closed. `git status` fails while every other
# query still succeeds, so a helper that treated an unreadable tree as clean
# would fall through to the evidence branch and could reclaim it.
GITERR="$WORK/GitErr"
git -C "$PRIMARY" worktree add -q -b lane/giterr "$GITERR" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/giterr"
mkdir -p "$WORK/errbin"
cat > "$WORK/errbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = status ] && exit 128; done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/errbin/git"
got="$(PATH="$WORK/errbin:$BIN:$PATH" bash "$TAP" worktree check "$GITERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(6) a failed git query must keep (fail-closed), got: $got"

# (7) REGISTERED SEAT CWD -> refuse (tap-c0z6 constraint 2). A tree someone is
# working in is not a GC candidate whatever git says about it.
SEATED="$WORK/Seated"
git -C "$PRIMARY" worktree add -q -b lane/seated "$SEATED" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/seated"
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$SEATED" <<'PY'
import json, os, sys
index, work, seated = sys.argv[1:4]
reg = os.path.join(work, "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {"wolp": {
        "root": os.path.join(work, "some-other-root"),
        "registry_location": reg, "state": "registered"}}}, fh)
with open(reg, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "wolp"},
               "seats": {"peggy": {"registered_from_worktree": seated}}}, fh)
PY
[ "$(verdict "$SEATED")" = refuse ] \
  || fail "(7) a registered seat's worktree must refuse, got: $(check "$SEATED")"

# (7b) STRICTLY NESTED SEAT -> refuse (tap-urjdz). Arm 7 registers the seat at exactly
# the tree root, which is only the equality half of the containment clause. The half
# carrying the safety weight is a seat working in a SUBDIRECTORY of a tree about to be
# reaped. Assert the evidence string, not just `refuse`: a verdict word alone also
# matches an unrelated early exit. The reclaimable control is arm 1's squash-merged
# tree, now with a "seat" in a sibling that merely SHARES ITS NAME PREFIX; it must
# stay reclaimable, so the clause is proven to be path containment rather than a
# bare string prefix.
NESTED="$WORK/Nested"
git -C "$PRIMARY" worktree add -q -b lane/nested "$NESTED" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/nested"
mkdir -p "$NESTED/sub/dir"
mkdir -p "$SQUASHED-elsewhere/work"
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$NESTED/sub/dir" "$SQUASHED-elsewhere/work" <<'PY'
import json, os, sys
index, work, nested, sibling = sys.argv[1:5]
reg = os.path.join(work, "team-registry.json")
with open(reg, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "wolp"},
               "seats": {"peggy": {"registered_from_worktree": nested},
                         "quinn": {"registered_from_worktree": sibling}}}, fh)
PY
nested_out="$(check "$NESTED")"
[ "$(printf '%s' "$nested_out" | awk -F'\t' 'NR==1 { print $1 }')" = refuse ] \
  || fail "(7b) a seat registered from a subdirectory must refuse, got: $nested_out"
case "$nested_out" in
  *"registered seat cwd (wolp/peggy)"*) : ;;
  *) fail "(7b) the refusal must name the nested seat, got: $nested_out" ;;
esac
[ "$(verdict "$SQUASHED")" = reclaim ] \
  || fail "(7b) a seat in a name-prefix sibling must not claim the tree, got: $(check "$SQUASHED")"

# (8) LOCKED TREE -> hold. Locked is STATE, not identity: the seat holding it can
# release it. (The bead spells this both ways; the driver's resolution is
# recorded in the helper header and the PR.)
LOCKED="$WORK/Locked"
git -C "$PRIMARY" worktree add -q -b lane/locked "$LOCKED" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/locked"
git -C "$PRIMARY" worktree lock "$LOCKED"
[ "$(verdict "$LOCKED")" = hold ] \
  || fail "(8) a locked tree must hold, got: $(check "$LOCKED")"
git -C "$PRIMARY" worktree unlock "$LOCKED"

# (9) EXIT CODE is the safe-idiom contract: 0 only when every path reclaims.
PATH="$BIN:$PATH" bash "$TAP" worktree check "$SQUASHED" >/dev/null 2>&1 \
  || fail "(9) an all-reclaim run must exit 0"
if PATH="$BIN:$PATH" bash "$TAP" worktree check "$SQUASHED" "$FRESH" >/dev/null 2>&1; then
  fail "(9) a run containing a non-reclaim verdict must exit non-zero"
fi

# (10) ORDINAL COLLISION -> keep. THE LIVE DEFECT (review gate).
# A detached tree named `Freeze3` is the third freeze tree; PR #3 is a real,
# merged, unrelated PR. The original argued a wrong guess "yields no evidence" —
# it yields evidence for a DIFFERENT PR, and low ordinals always resolve in a
# mature repo. Five live trees on this machine false-reclaimed this way, and the
# exit code then authorized removing them. The name gives a CANDIDATE; only the
# oids make it an identification.
# Since tap-6a4ao a detached HEAD reachable from any ref reclaims BEFORE name-recovery
# runs, so this tree commits an orphan: HEAD is reachable from nothing and the only
# path left to `reclaim` is the name-recovery guard under test. The fixture asserts
# that, so a future edit that drops the commit fails here and not on a wrong verdict.
FREEZE="$WORK/Freeze3"
git -C "$PRIMARY" worktree add -q --detach "$FREEZE" main
printf 'freeze\n' > "$FREEZE/file.txt"
git -C "$FREEZE" add -A && git -C "$FREEZE" commit -qm "orphan freeze commit"
[ -z "$(git -C "$FREEZE" for-each-ref --contains HEAD refs/heads/ refs/remotes/)" ] \
  || fail "(10) fixture is not exercising name-recovery — HEAD is reachable from a ref"
printf 'MERGED\tdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\tcafebabecafebabecafebabecafebabecafebabe\n' \
  > "$GH_STUB_STATE_DIR/3"
[ "$(verdict "$FREEZE")" = keep ] \
  || fail "(10) an ordinal tree name must not reclaim on an unrelated PR, got: $(check "$FREEZE")"

# (11) CORROBORATED REVIEW TREE -> reclaim. The intended case must SURVIVE the
# fix: a review tree checked out AT the PR's head, whose PR merged, is exactly
# what guidelines :74-114 describes. Without this arm the safe move would be to
# delete name-recovery entirely and quietly lose the class it exists for.
# Same orphan discipline as arm 10 (tap-6a4ao): detached at BASE, then the tree commits
# main's exact content itself, so HEAD is reachable from no ref (reachability cannot
# carry it) while the squash catch still can. That leaves corroboration as the only
# route to reclaim, which is what this arm exists to pin.
REVIEW="$WORK/Review9"
git -C "$PRIMARY" worktree add -q --detach "$REVIEW" main~1
printf 'landed\n' > "$REVIEW/file.txt"
git -C "$REVIEW" add -A && git -C "$REVIEW" commit -qm "orphan commit carrying landed content"
[ -z "$(git -C "$REVIEW" for-each-ref --contains HEAD refs/heads/ refs/remotes/)" ] \
  || fail "(11) fixture is not exercising corroboration — HEAD is reachable from a ref"
git -C "$REVIEW" diff --quiet origin/main HEAD \
  || fail "(11) fixture is not exercising the squash catch — content differs from origin/main"
REVIEW_HEAD="$(git -C "$REVIEW" rev-parse HEAD)"
printf 'MERGED\t\t%s\n' "$REVIEW_HEAD" > "$GH_STUB_STATE_DIR/9"
[ "$(verdict "$REVIEW")" = reclaim ] \
  || fail "(11) a corroborated review tree must still reclaim, got: $(check "$REVIEW")"

# (11b) tap-7t71: suffixes locate candidates; earlier LISTED PR commits identify
# them. Even an actual ancestor of the PR head is insufficient when unlisted.
LATER_HEAD="$(git -C "$REVIEW" commit-tree "$(git -C "$REVIEW" rev-parse HEAD^{tree})" -p "$REVIEW_HEAD" -m 'later PR tip')"
for name in Gate498b Gate245M Review498; do
  gate="$WORK/$name"
  git -C "$PRIMARY" worktree add -q --detach "$gate" "$REVIEW_HEAD"
  case "$name" in Gate245M) number=245 ;; *) number=498 ;; esac
  # Endpoint equality independently proves the suffix parser.
  printf 'MERGED\t\t%s\n' "$REVIEW_HEAD" > "$GH_STUB_STATE_DIR/$number"
  [ "$(verdict "$gate")" = reclaim ] || fail "(11b) $name suffix/head recovery failed: $(check "$gate")"
  # Neither endpoint equals HEAD; only the explicit earlier commit can carry it.
  printf 'MERGED\t\t%s\t%s,%s\n' "$LATER_HEAD" "$REVIEW_HEAD" "$LATER_HEAD" > "$GH_STUB_STATE_DIR/$number"
  [ "$(verdict "$gate")" = reclaim ] || fail "(11b) $name listed earlier commit failed: $(check "$gate")"
done
# Same candidate, same preserved content, actual ancestry, but no exact membership.
printf 'MERGED\t\t%s\t%s\n' "$LATER_HEAD" "$LATER_HEAD" > "$GH_STUB_STATE_DIR/498"
[ "$(verdict "$gate")" = keep ] || fail "(11b) an unlisted ancestor must keep: $(check "$gate")"
printf 'OPEN\t\t%s\t%s\n' "$LATER_HEAD" "$REVIEW_HEAD" > "$GH_STUB_STATE_DIR/498"
[ "$(verdict "$gate")" = keep ] || fail "(11b) an open PR must keep: $(check "$gate")"
printf 'FAIL:MERGED\t\t%s\t%s\n' "$LATER_HEAD" "$REVIEW_HEAD" > "$GH_STUB_STATE_DIR/498"
got="$(check "$gate")"
case "$got" in keep*"no usable PR answer"*) : ;; *) fail "(11b) failed commit-list answer must keep: $got" ;; esac
# A matching PR commit is completion evidence, never a preservation substitute.
UNPUBLISHED="$WORK/Gate499b"
git -C "$PRIMARY" worktree add -q --detach "$UNPUBLISHED" "$(git -C "$FREEZE" rev-parse HEAD)"
printf 'CLOSED\t\t%s\t%s\n' "$LATER_HEAD" "$(git -C "$UNPUBLISHED" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/499"
got="$(check "$UNPUBLISHED")"
case "$got" in keep*"HEAD corroborated, but the tree holds unpublished content"*) : ;; *) fail "(11b) listed unique content must keep: $got" ;; esac
echo "worktree-gc-predicate: (11b) suffix and explicit PR commit recovery retain state, identity and preservation gates: ok"

# (12) ERRORED BRANCH LOOKUP -> keep, never the heuristic. An empty branch means
# DETACHED and routes into tree-name recovery; a git FAILURE must not arrive
# there wearing the same empty answer. The tree is named to parse (`Verify12`)
# and PR 12's head is stubbed to corroborate, so if the error were read as
# "detached" the path would reclaim a tree whose real branch was never consulted.
BRANCHERR="$WORK/Verify12"
git -C "$PRIMARY" worktree add -q -b lane/brancherr "$BRANCHERR" main
printf 'MERGED\t\t%s\n' "$(git -C "$BRANCHERR" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/12"
mkdir -p "$WORK/brancherrbin"
cat > "$WORK/brancherrbin/git" <<'GITSTUB'
#!/usr/bin/env bash
# 128, not 1: rc 1 is git's legitimate "HEAD is not a symbolic ref" (detached).
for a in "$@"; do [ "$a" = symbolic-ref ] && exit 128; done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/brancherrbin/git"
got="$(PATH="$WORK/brancherrbin:$BIN:$PATH" bash "$TAP" worktree check "$BRANCHERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(12) an errored branch lookup must keep, not fall into name-recovery, got: $got"

# (12b) UNUSABLE symbolic-ref CHILD -> keep, same as the errored one above. A
# killed child carries NO status; if null status wore the detached answer, an
# unreadable HEAD would walk into ref containment and reclaim (this tree's own
# lane branch contains its HEAD). Only "could not read HEAD" discriminates the
# guard; a mutant that skips symbolic-ref entirely reclaims and fails here.
BRANCHERR2="$WORK/Verify12k"
git -C "$PRIMARY" worktree add -q -b lane/brancherr2 "$BRANCHERR2" main
mkdir -p "$WORK/branchkillbin"
cat > "$WORK/branchkillbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = symbolic-ref ]; then kill -9 $$; fi
done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/branchkillbin/git"
got="$(PATH="$WORK/branchkillbin:$BIN:$PATH" bash "$TAP" worktree check "$BRANCHERR2" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(12b) an unusable symbolic-ref child must keep, not wear the detached answer, got: $got"
case "$got" in
  *"could not read HEAD"*) : ;;
  *) fail "(12b) the keep must be the HEAD-read failure, got: $got" ;;
esac

# (13) UNRESOLVABLE GIT DIRS -> keep. The primary refusal is the file's most
# destructive-adjacent check, so its query failing must fail CLOSED. Without this
# arm nothing exercises that path: every other arm has a healthy repo, so the
# refusal always resolves and the polarity of its error case is never observed.
DIRERR="$WORK/DirErr"
git -C "$PRIMARY" worktree add -q -b lane/direrr "$DIRERR" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/direrr"
mkdir -p "$WORK/direrrbin"
cat > "$WORK/direrrbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = --absolute-git-dir ] && exit 128; done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/direrrbin/git"
got="$(PATH="$WORK/direrrbin:$BIN:$PATH" bash "$TAP" worktree check "$DIRERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(13) unresolvable git dirs must keep (the primary refusal fails closed), got: $got"

# (14) ENROLLED ROOT IS EQUALITY, NOT CONTAINMENT (tap-zp5zj). The refusal exists
# to protect a tree that IS an enrolled team root. Containment made one
# parent-shaped row disable GC for the whole machine: the operator's umbrella
# directory was enrolled at /Users/dev/work, the parent of every repo and worktree
# on the box, so all 34 live trees refused and `reclaim` was unreachable. This arm
# is the one that did not exist — the root check had NO coverage, which is why the
# defect shipped and why a driver hit it at a lane closeout instead of here.
#
# Both directions, because a guard that only refuses proves nothing:
#   a CHILD of a parent-shaped enrolled root must NOT refuse on that ground;
#   a tree that IS the enrolled root must still refuse.
# Three REAL linked worktrees, because the check refuses a non-worktree path as
# "not a git worktree" long before it ever reads the index — an arm pointed at a
# bare directory passes on that early exit and pins nothing. The first version of
# this arm did exactly that, and the partner reviewer proved it by deleting the
# equality clause outright and watching the file still pass.
PARENTSHAPED="$WORK/ParentShaped"
git -C "$PRIMARY" worktree add -q -b lane/parentshaped "$PARENTSHAPED" main
printf 'MERGED\t\t%s\n' "$(git -C "$PARENTSHAPED" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/parentshaped"
ROOTTREE="$WORK/RootTree"
git -C "$PRIMARY" worktree add -q -b lane/roottree "$ROOTTREE" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/roottree"
BOUNDTREE="$WORK/BoundTree"
git -C "$PRIMARY" worktree add -q -b lane/boundtree "$BOUNDTREE" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/boundtree"
# All three are otherwise RECLAIMABLE (merged PR, published). So any refusal below
# is caused by the index claim under test and not by leftover git state.
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$ROOTTREE" "$BOUNDTREE" <<'PY2'
import json, os, sys
index, work, roottree, boundtree = sys.argv[1:5]
bound_doc = os.path.join(work, "bound-registry.json")
with open(bound_doc, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "boundteam", "worktree_root": boundtree}, "seats": {}}, fh)
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {
        # PARENT-SHAPED: root is the parent of every fixture tree — the row shape
        # that made containment refuse all 34 live trees on the real machine.
        "parentteam": {"root": work,
                       "registry_location": os.path.join(work, "absent.json"),
                       "state": "registered"},
        # A row whose root IS a real worktree: the global-identity case.
        "rootteam": {"root": roottree,
                     "registry_location": os.path.join(work, "absent.json"),
                     "state": "registered"},
        # DRIFT: the global row is parent-shaped while the ACTING registry binds
        # the child. Only the acting clause can refuse this one.
        "boundteam": {"root": work, "registry_location": bound_doc,
                      "state": "registered"},
    }}, fh)
PY2

# (a) a CHILD of a parent-shaped enrolled root is an ordinary lane, not a root.
got="$(check "$PARENTSHAPED")"
case "$got" in
  *"enrolled team root"*)
    fail "(14a) a child of a parent-shaped enrolled root must not refuse as a root, got: $got" ;;
esac
[ "$(verdict "$PARENTSHAPED")" = reclaim ] \
  || fail "(14a) the child must reach a real verdict, not refuse for another reason, got: $got"
echo "worktree-gc-predicate: (14a) a child of a parent-shaped enrolled root reclaims: ok"

# (b) the GLOBAL root itself still refuses — asserted on its own evidence string,
# so it cannot pass on the "not a git worktree" exit or on another team's claim.
got="$(check "$ROOTTREE")"
case "$got" in
  *"enrolled team root (rootteam)"*) : ;;
  *) fail "(14b) a tree that IS an enrolled global root must refuse on that ground, got: $got" ;;
esac
echo "worktree-gc-predicate: (14b) the enrolled global root still refuses: ok"

# (c) the ACTING registry's bound root refuses even though the global row points
# at the parent. This is the drift case: index stale, acting document authoritative.
got="$(check "$BOUNDTREE")"
case "$got" in
  *"enrolled team root (boundteam via acting registry)"*) : ;;
  *) fail "(14c) the acting registry's bound worktree_root must refuse, got: $got" ;;
esac
echo "worktree-gc-predicate: (14c) the acting registry's bound root refuses: ok"

# (15) SUBDIRECTORY OF AN ENROLLED LINKED WORKTREE -> not a GC candidate (tap-zp5zj :140).
# `git ... --is-inside-work-tree` admits a subdir of a live enrolled worktree, but a
# subdir is not a worktree of its own — you cannot `git worktree remove` it, and it is
# part of a tree an agent may be working in. The equality check compared the SUBDIR
# path (not its worktree top) to the enrolled root and missed it, so
# `<enrolled-root>/subdir` reached `reclaim` for a merged branch. The fix refuses any
# path whose git worktree top-level is not itself. Both directions: the root itself
# still refuses; a genuine top-level worktree under an enrolled PARENT (arm 14a) still
# reclaims, so the refusal is not over-broad.
ENROLLEDWT="$WORK/EnrolledWt"
git -C "$PRIMARY" worktree add -q -b lane/enrolledwt "$ENROLLEDWT" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/enrolledwt"   # otherwise fully reclaimable
mkdir -p "$ENROLLEDWT/nested/deeper"
python3 -B - "$TAP_INDEX_HOME" "$ENROLLEDWT" <<'PY3'
import json, os, sys
index, enrolledwt = sys.argv[1:3]
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {
        "wtteam": {"root": enrolledwt,
                   "registry_location": os.path.join(enrolledwt, "absent.json"),
                   "state": "registered"},
    }}, fh)
PY3
# the enrolled root itself still refuses (top == self; equality holds)
case "$(check "$ENROLLEDWT")" in
  *"enrolled team root (wtteam)"*) : ;;
  *) fail "(15) the enrolled worktree root itself must refuse, got: $(check "$ENROLLEDWT")" ;;
esac
# a subdirectory must NOT reclaim — it is part of the live enrolled tree
[ "$(verdict "$ENROLLEDWT/nested")" = refuse ] \
  || fail "(15) a subdirectory of an enrolled linked worktree must refuse, got: $(check "$ENROLLEDWT/nested")"
[ "$(verdict "$ENROLLEDWT/nested/deeper")" = refuse ] \
  || fail "(15) a deeper subdirectory must refuse too, got: $(check "$ENROLLEDWT/nested/deeper")"
echo "worktree-gc-predicate: (15) a subdirectory of an enrolled linked worktree refuses; the root itself still refuses: ok"

# (16) HISTORICAL TEAMS NO LONGER BLOCK RECLAIM (tap-zp5zj :171). A `state: historical`
# team is not enrolled — registry_v20.py:590 and native admin both treat it as
# non-live — so its roots must not refuse a reclaimable worktree. The loop skipped only
# non-dict entries, so a historical team whose ACTING registry bound the target still
# refused it. Drift shape like 14c: global root is the parent, the acting registry binds
# the target, but state=historical.
HISTTREE="$WORK/HistTree"
git -C "$PRIMARY" worktree add -q -b lane/histtree "$HISTTREE" main
printf 'MERGED\t\t%s\n' "$(git -C "$HISTTREE" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/histtree"   # otherwise fully reclaimable
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$HISTTREE" <<'PY4'
import json, os, sys
index, work, histtree = sys.argv[1:4]
hist_doc = os.path.join(work, "hist-registry.json")
with open(hist_doc, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "histteam", "worktree_root": histtree}, "seats": {}}, fh)
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {
        "histteam": {"root": work, "registry_location": hist_doc, "state": "historical"},
    }}, fh)
PY4
case "$(check "$HISTTREE")" in
  *"enrolled team root"*)
    fail "(16) a historical team must not refuse a reclaimable worktree, got: $(check "$HISTTREE")" ;;
esac
[ "$(verdict "$HISTTREE")" = reclaim ] \
  || fail "(16) a historical team's bound worktree must reach a real verdict (reclaim), got: $(check "$HISTTREE")"
echo "worktree-gc-predicate: (16) a historical team no longer blocks reclaim: ok"

# (16b) TRUST-BOUNDARY control for 16: `state` as a malformed singleton array is
# NOT the historical string — python str() renders it "['historical']" — so the
# team's claims must stand. A wrong-typed state that suppressed claims would fail
# open toward reclaim: this tree IS the team's enrolled root and must refuse.
ARRTEAM="$WORK/ArrTeam"
git -C "$PRIMARY" worktree add -q -b lane/arrteam "$ARRTEAM" main
printf 'MERGED\t\t%s\n' "$(git -C "$ARRTEAM" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/arrteam"   # otherwise reclaimable
python3 -B - "$TAP_INDEX_HOME" "$ARRTEAM" <<'PY'
import json, os, sys
index, arrteam = sys.argv[1:3]
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {
        "arrteam": {"root": arrteam,
                    "registry_location": os.path.join(arrteam, "absent.json"),
                    "state": ["historical"]},
    }}, fh)
PY
case "$(check "$ARRTEAM")" in
  *"enrolled team root (arrteam)"*) : ;;
  *) fail "(16b) a malformed array state must not suppress the enrolled-root refusal, got: $(check "$ARRTEAM")" ;;
esac
echo "worktree-gc-predicate: (16b) a malformed array state does not suppress claims: ok"

# (17) SUBDIR GUARD FAILS CLOSED AND NEEDS NO realpath(1) (tap-zp5zj :140, review F2).
# The guard was `[ "$(realpath "$_wt_top")" != "$(realpath "$p")" ]`: when realpath is missing
# or fails, BOTH substitutions expand to "" and "" != "" is false, so the guard was SKIPPED and
# a subdir reached reclaim — a delete guard silently disabled by a missing binary. The fix uses
# `git rev-parse --show-prefix` (empty IFF <path> is its worktree top), the git already invoked,
# so there is no realpath call left to fail.
# (a) a git that cannot answer --show-prefix must KEEP (fail-closed), like arm 6.
PREFIXERR="$WORK/PrefixErr"
git -C "$PRIMARY" worktree add -q -b lane/prefixerr "$PREFIXERR" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/prefixerr"   # otherwise fully reclaimable
mkdir -p "$WORK/prefixerrbin"
cat > "$WORK/prefixerrbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = --show-prefix ] && exit 128; done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/prefixerrbin/git"
got="$(PATH="$WORK/prefixerrbin:$BIN:$PATH" bash "$TAP" worktree check "$PREFIXERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(17) an unreadable --show-prefix must keep (fail-closed), got: $got"
# (b) the gate reviewer's own F2 falsifier, now closed: with realpath stubbed to exit 127, a subdir of an
# enrolled worktree (arm 15's ENROLLEDWT) STILL refuses — the guard no longer depends on realpath.
# On the old code both realpath substitutions expanded to "" and this subdir reached reclaim.
mkdir -p "$WORK/norealpathbin"
cat > "$WORK/norealpathbin/realpath" <<'RP'
#!/usr/bin/env bash
exit 127
RP
chmod +x "$WORK/norealpathbin/realpath"
got="$(PATH="$WORK/norealpathbin:$BIN:$PATH" bash "$TAP" worktree check "$ENROLLEDWT/nested" 2>&1 || true)"
case "$got" in
  *"not a worktree top level"*) : ;;
  *) fail "(17) with realpath unavailable a subdir must still refuse (no realpath dependency), got: $got" ;;
esac
echo "worktree-gc-predicate: (17) the subdir guard fails closed and needs no realpath: ok"

# (18) AN OLD-FORMAT ACTING REGISTRY CLAIMS THE TREE (tap-zp5zj :178, then C4). A document with an
# `agents` axis cannot say which seats occupy a tree, so it refuses reclaim as old_store instead of
# reading either axis. Before tap-zp5zj `acting.get("seats", {})` defaulted to {} for these documents
# and a tree with a live legacy-axis seat reclaimed. Mirrors arm 7 with the occupant on `agents`.
AGENTSEAT="$WORK/AgentSeat"
git -C "$PRIMARY" worktree add -q -b lane/agentseat "$AGENTSEAT" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/agentseat"
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$AGENTSEAT" <<'PY5'
import json, os, sys
index, work, seated = sys.argv[1:4]
reg = os.path.join(work, "agents-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {"aolp": {
        "root": os.path.join(work, "some-other-root"),
        "registry_location": reg, "state": "registered"}}}, fh)
with open(reg, "w") as fh:
    # old-shape fixture: occupant only on the legacy agents axis; asserts the delete guard refuses (18)
    json.dump({"schema": "0.20", "team": {"name": "aolp"},
               "agents": {"peggy": {"registered_from_worktree": seated}}}, fh)
PY5
case "$(check "$AGENTSEAT")" in
  refuse*"old_store acting registry (aolp)"*) : ;;
  *) fail "(18) an agents-axis registry must refuse as old_store, got: $(check "$AGENTSEAT")" ;;
esac
# A hybrid document (an empty `seats` beside an occupied `agents`) refuses too: reading only `seats`
# would MISS the occupant, and a delete guard protecting a running agent must not.
BOTHSEAT="$WORK/BothSeat"
git -C "$PRIMARY" worktree add -q -b lane/bothseat "$BOTHSEAT" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/bothseat"
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$BOTHSEAT" <<'PY6'
import json, os, sys
index, work, seated = sys.argv[1:4]
reg = os.path.join(work, "both-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {"bolp": {
        "root": os.path.join(work, "some-other-root"),
        "registry_location": reg, "state": "registered"}}}, fh)
with open(reg, "w") as fh:
    # old-shape fixture: hybrid seats+agents; asserts occupancy spans both axes (18)
    json.dump({"schema": "0.20", "team": {"name": "bolp"}, "seats": {},
               "agents": {"quinn": {"registered_from_worktree": seated}}}, fh)
PY6
case "$(check "$BOTHSEAT")" in
  refuse*"old_store acting registry (bolp)"*) : ;;
  *) fail "(18) a hybrid seats+agents registry must refuse as old_store, got: $(check "$BOTHSEAT")" ;;
esac
# The claim is machine-wide on purpose: an old registry's seats may have registered from any tree, so
# AgentSeat, which no bolp document names, refuses under bolp too.
case "$(check "$AGENTSEAT")" in
  refuse*"old_store acting registry (bolp)"*) : ;;
  *) fail "(18) an old-format registry must claim every tree, got: $(check "$AGENTSEAT")" ;;
esac
# Later arms run against a current, empty index.
printf '{"schema": "0.20", "teams": {}}\n' > "$TAP_INDEX_HOME/global-registry.json"
echo "worktree-gc-predicate: (18) an old-format acting registry refuses reclaim as old_store: ok"

# (19) EPHEMERAL REVIEW TREE (tap-6a4ao). A /tap-pair reviewer's tree is `git worktree add
# --detach <path> <range-head>`: detached, clean, no PR of its own. Before this arm the
# checker answered `keep` ("no completion evidence") for every such tree, so the sanctioned
# check-then-remove path could never reap one and /tap-pair carried a reviewer-side override.
# For a DETACHED tree, HEAD reachable from a local branch or remote-tracking ref is the
# whole proof: the tree holds nothing a ref does not. The two ways a detached tree can hold
# unique work are pinned in the same arm — a commit made in it makes HEAD reachable from
# nothing (c), and uncommitted edits make it dirty (d) — and a lock still holds (e).
# The two reclaim trees CARRY a trailing ordinal whose PR is stubbed OPEN: name-recovery
# would find nothing usable there, so the containment clause is still the only route to
# `reclaim` — but a checker that consulted GitHub first would record a call, and the
# no-lookup assertions below are what turn the brief's "no PR lookup on this route" into
# a control that fails on a reorder. The keep/hold trees carry no ordinal.

# (a) reachable from a LOCAL branch only — the live shape: a review tree at the head of a
# lane branch that has not been pushed. `branch -r --contains` is empty and the content
# differs from origin/main, so NEITHER step-4 preservation conjunct carries it; the local
# ref alone is the preservation. Both facts are asserted so the arm cannot pass on them.
REVIEWEDLANE="$WORK/ReviewedLane"
git -C "$PRIMARY" worktree add -q -b lane/reviewed "$REVIEWEDLANE" main
printf 'under review\n' > "$REVIEWEDLANE/file.txt"
git -C "$REVIEWEDLANE" add -A && git -C "$REVIEWEDLANE" commit -qm "lane commit under review"
REVIEWTREE="$WORK/ReviewTree7"
git -C "$PRIMARY" worktree add -q --detach "$REVIEWTREE" lane/reviewed
printf 'OPEN\t\t\n' > "$GH_STUB_STATE_DIR/7"   # recorded if consulted; never evidence
[ -z "$(git -C "$REVIEWTREE" branch -r --contains HEAD)" ] \
  || fail "(19a) fixture is not exercising the local-only case — a remote ref contains HEAD"
if git -C "$REVIEWTREE" diff --quiet origin/main HEAD; then
  fail "(19a) fixture is not exercising the local-only case — content already on origin/main"
fi
gh_before="$(gh_calls)"
got="$(check "$REVIEWTREE")"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = reclaim ] \
  || fail "(19a) a clean detached tree whose HEAD a local branch contains must reclaim, got: $got"
# The brief forbids a GitHub lookup on this route. The stub records every call, so
# this is causal: a reorder that put name-recovery first would bump the count.
[ "$(gh_calls)" = "$gh_before" ] \
  || fail "(19a) the containment route must make no GitHub PR lookup, calls: $(cat "$GH_STUB_STATE_DIR/.calls")"
case "$got" in
  *"refs/heads/lane/reviewed"*) : ;;
  *) fail "(19a) the evidence must name the containing ref, got: $got" ;;
esac
PATH="$BIN:$PATH" bash "$TAP" worktree check "$REVIEWTREE" >/dev/null 2>&1 \
  || fail "(19a) the reclaim verdict must exit 0 so check-then-remove can reap it"
echo "worktree-gc-predicate: (19a) a detached tree at a local-only branch head reclaims: ok"

# (b) reachable from a REMOTE-TRACKING ref only: the branch was pushed and its local ref
# deleted. `refs/heads/` contains nothing, so the arm proves the remote namespace is read.
PUSHEDLANE="$WORK/PushedLane"
git -C "$PRIMARY" worktree add -q -b lane/pushed "$PUSHEDLANE" main
printf 'pushed for review\n' > "$PUSHEDLANE/file.txt"
git -C "$PUSHEDLANE" add -A && git -C "$PUSHEDLANE" commit -qm "pushed lane commit"
git -C "$PUSHEDLANE" push -q origin lane/pushed
git -C "$PRIMARY" worktree remove "$PUSHEDLANE"
git -C "$PRIMARY" branch -q -D lane/pushed
REMOTETREE="$WORK/RemoteReviewTree8"
git -C "$PRIMARY" worktree add -q --detach "$REMOTETREE" origin/lane/pushed
printf 'OPEN\t\t\n' > "$GH_STUB_STATE_DIR/8"   # recorded if consulted; never evidence
[ -z "$(git -C "$REMOTETREE" for-each-ref --contains HEAD refs/heads/)" ] \
  || fail "(19b) fixture is not exercising the remote-only case — a local branch contains HEAD"
gh_before="$(gh_calls)"
got="$(check "$REMOTETREE")"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = reclaim ] \
  || fail "(19b) a clean detached tree whose HEAD a remote-tracking ref contains must reclaim, got: $got"
[ "$(gh_calls)" = "$gh_before" ] \
  || fail "(19b) the containment route must make no GitHub PR lookup, calls: $(cat "$GH_STUB_STATE_DIR/.calls")"
echo "worktree-gc-predicate: (19b) a detached tree at a remote-only ref reclaims: ok"

# (c) ORPHAN: a commit made in the detached tree is reachable from nothing. That is the
# one way a clean detached tree holds unique work, and it must keep.
ORPHAN="$WORK/ReviewOrphan"
git -C "$PRIMARY" worktree add -q --detach "$ORPHAN" main
printf 'only here\n' > "$ORPHAN/file.txt"
git -C "$ORPHAN" add -A && git -C "$ORPHAN" commit -qm "commit reachable from no ref"
[ -z "$(git -C "$ORPHAN" for-each-ref --contains HEAD refs/heads/ refs/remotes/)" ] \
  || fail "(19c) fixture is not exercising the orphan case — HEAD is reachable from a ref"
got="$(check "$ORPHAN")"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(19c) a detached tree holding a commit reachable from no ref must keep, got: $got"
case "$got" in
  *"no completion evidence"*) : ;;
  *) fail "(19c) the keep reason must be the evidence one, not a query failure, got: $got" ;;
esac
echo "worktree-gc-predicate: (19c) a detached tree with an unreachable commit keeps: ok"

# (d) DIRTY detached tree, HEAD reachable -> hold. State outranks the new evidence exactly
# as it outranks a merged PR (arm 4); a review tree is never dirty, so a dirty one is a
# human's call.
DIRTYREVIEW="$WORK/DirtyReview"
git -C "$PRIMARY" worktree add -q --detach "$DIRTYREVIEW" main
printf 'stray edit\n' > "$DIRTYREVIEW/file.txt"
got="$(check "$DIRTYREVIEW")"
case "$got" in
  hold*"working tree dirty"*) : ;;
  *) fail "(19d) a dirty detached tree must hold on dirtiness, got: $got" ;;
esac
echo "worktree-gc-predicate: (19d) a dirty detached tree holds: ok"

# (e) LOCKED detached tree, HEAD reachable -> hold, on the lock (arm 8 for the detached shape).
LOCKEDREVIEW="$WORK/LockedReview"
git -C "$PRIMARY" worktree add -q --detach "$LOCKEDREVIEW" main
git -C "$PRIMARY" worktree lock "$LOCKEDREVIEW"
got="$(check "$LOCKEDREVIEW")"
case "$got" in
  hold*"worktree locked"*) : ;;
  *) fail "(19e) a locked detached tree must hold on the lock, got: $got" ;;
esac
git -C "$PRIMARY" worktree unlock "$LOCKEDREVIEW"
echo "worktree-gc-predicate: (19e) a locked detached tree holds: ok"

# (20)-(23) BRANCH-BACKED COMPLETION DEMANDS PR CORROBORATION (R12 ruling 3,
# closes tap-dg8g). A merged PR found BY BRANCH NAME is a locator, not an
# identification: the name is reusable, and the tree may hold NEW work the
# merged row knows nothing about. Before ruling 3, a reused branch whose tip
# was ahead of the PR head reclaimed on the old MERGED row plus preservation —
# exactly the false-reclaim shape tap-dg8g reported. Completion is corroborated
# only when HEAD equals the PR head, equals the merge commit (equality only: a
# squash commit never contains the branch tip), or is CONTAINED by the PR head.
# The git shim logs merge-base argv so each arm proves the exact ancestry query
# ran (and that arm 22 never reached it); the gh stub's .calls proves the route.
mkdir -p "$WORK/mbbin"
MB_LOG="$WORK/mb.log"
export MB_LOG
cat > "$WORK/mbbin/git" <<'GITSTUB'
#!/usr/bin/env bash
n=1
for a in "$@"; do
  if [ "$a" = merge-base ]; then
    printf '%s\n' "${*:n}" >> "$MB_LOG"
    break
  fi
  n=$((n+1))
done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/mbbin/git"
mbcheck() { PATH="$WORK/mbbin:$BIN:$PATH" bash "$TAP" worktree check "$@" 2>&1 || true; }
mbrow() { printf '%s' "$1" | awk -F'\t' 'NR==1 { print $1 }'; }

# (20) REUSED BRANCH, TIP AHEAD OF THE PR HEAD -> keep (the tap-dg8g repro, in
# both MERGED and CLOSED dress). c1 pushed, PR found by the branch name; c2
# pushed on the same name and the tree sits at c2. The stub names c1 as the PR
# head, so equality fails and ancestry must report the tip AHEAD.
REUSED="$WORK/Reused"
git -C "$PRIMARY" worktree add -q -b lane/reused "$REUSED" main
printf 'first\n' > "$REUSED/file.txt"
git -C "$REUSED" add -A && git -C "$REUSED" commit -qm "first round of work on this name"
git -C "$REUSED" push -q origin lane/reused
PRHEAD1="$(git -C "$REUSED" rev-parse HEAD)"
printf 'second\n' > "$REUSED/file.txt"
git -C "$REUSED" add -A && git -C "$REUSED" commit -qm "new live work, same reused branch"
git -C "$REUSED" push -q origin lane/reused
REUSED_TIP="$(git -C "$REUSED" rev-parse HEAD)"
git -C "$REUSED" merge-base --is-ancestor "$PRHEAD1" "$REUSED_TIP" \
  || fail "(20) fixture is not exercising the reuse case — the PR head is not an ancestor of the new tip"
for state in MERGED CLOSED; do
  printf '%s\t\t%s\n' "$state" "$PRHEAD1" > "$GH_STUB_STATE_DIR/lane/reused"
  : > "$MB_LOG"
  gh_before="$(gh_calls)"
  got="$(mbcheck "$REUSED")"
  [ "$(mbrow "$got")" = keep ] \
    || fail "(20) a reused branch whose tip is ahead of the PR head must keep, got: $got"
  case "$got" in
    *"ahead of or diverged"*) : ;;
    *) fail "(20) the keep must name the failed corroboration, got: $got" ;;
  esac
  [ "$(cat "$MB_LOG")" = "merge-base --is-ancestor $REUSED_TIP $PRHEAD1" ] \
    || fail "(20) corroboration must query exactly is-ancestor TIP PRHEAD, log: $(cat "$MB_LOG")"
  [ "$(( $(gh_calls) - gh_before ))" = 1 ] || fail "(20) expected exactly one gh query, got $(( $(gh_calls) - gh_before ))"
done
echo "worktree-gc-predicate: (20) a reused branch ahead of its PR head keeps: ok"

# (21) TIP CONTAINED BY THE PR HEAD -> reclaim, the safe direction must SURVIVE.
# The tree sits at c1; the PR head c2 is a pushed descendant, so equality fails
# but containment holds — and preservation carries it (origin/lane/behind
# contains the tip). Without this arm the safe move would be refusing every
# non-equal tip and quietly losing the legit case.
BEHIND="$WORK/Behind"
git -C "$PRIMARY" worktree add -q -b lane/behind "$BEHIND" main
printf 'landed behind\n' > "$BEHIND/file.txt"
git -C "$BEHIND" add -A && git -C "$BEHIND" commit -qm "work merged under a following head"
git -C "$BEHIND" push -q origin lane/behind
BEHIND_TIP="$(git -C "$BEHIND" rev-parse HEAD)"
PRHEADWT="$WORK/PrHead"
git -C "$PRIMARY" worktree add -q --detach "$PRHEADWT" "$BEHIND_TIP"
printf 'follow-up\n' > "$PRHEADWT/file.txt"
git -C "$PRHEADWT" add -A && git -C "$PRHEADWT" commit -qm "pr head follows the lane tip"
PRHEAD2="$(git -C "$PRHEADWT" rev-parse HEAD)"
git -C "$PRHEADWT" push -q origin HEAD:lane/behind
git -C "$BEHIND" merge-base --is-ancestor "$BEHIND_TIP" "$PRHEAD2" \
  || fail "(21) fixture is not exercising containment — the lane tip is not inside the PR head"
printf 'MERGED\t\t%s\n' "$PRHEAD2" > "$GH_STUB_STATE_DIR/lane/behind"
: > "$MB_LOG"
got="$(mbcheck "$BEHIND")"
[ "$(mbrow "$got")" = reclaim ] \
  || fail "(21) a tip contained by the PR head must reclaim, got: $got"
case "$got" in
  *"branch tip contained by PR head"*) : ;;
  *) fail "(21) the evidence must name the containment, got: $got" ;;
esac
[ "$(cat "$MB_LOG")" = "merge-base --is-ancestor $BEHIND_TIP $PRHEAD2" ] \
  || fail "(21) containment must query exactly is-ancestor TIP PRHEAD, log: $(cat "$MB_LOG")"
PATH="$WORK/mbbin:$BIN:$PATH" bash "$TAP" worktree check "$BEHIND" >/dev/null 2>&1 \
  || fail "(21) the contained-tip reclaim must exit 0"
echo "worktree-gc-predicate: (21) a tip contained by its PR head reclaims: ok"

# (22) PR ANSWER WITHOUT oids -> keep, and the ancestry query never runs. An
# answer naming no head cannot corroborate anything; running merge-base against
# an empty oid would be a command built from absent evidence.
NOOIDS="$WORK/NoOids"
git -C "$PRIMARY" worktree add -q -b lane/nooids "$NOOIDS" main
printf 'MERGED\t\t\n' > "$GH_STUB_STATE_DIR/lane/nooids"
: > "$MB_LOG"
got="$(mbcheck "$NOOIDS")"
[ "$(mbrow "$got")" = keep ] \
  || fail "(22) a PR answer without oids must keep, got: $got"
case "$got" in
  *"lacks head corroboration"*) : ;;
  *) fail "(22) the keep must name the missing corroboration, got: $got" ;;
esac
[ -s "$MB_LOG" ] && fail "(22) corroboration must not run without a head oid, log: $(cat "$MB_LOG")"
echo "worktree-gc-predicate: (22) a PR answer without oids keeps without an ancestry query: ok"

# (23) PR HEAD OBJECT ABSENT LOCALLY -> keep with fetch-and-recheck evidence.
# The stub names a well-formed oid git has never heard of; ancestry is then
# UNANSWERABLE, and an unanswerable query must not read as "not contained".
MISSOBJ="$WORK/MissObj"
git -C "$PRIMARY" worktree add -q -b lane/missobj "$MISSOBJ" main
GHOST="0123456789abcdef0123456789abcdef01234567"
printf 'MERGED\t\t%s\n' "$GHOST" > "$GH_STUB_STATE_DIR/lane/missobj"
: > "$MB_LOG"
got="$(mbcheck "$MISSOBJ")"
[ "$(mbrow "$got")" = keep ] \
  || fail "(23) an absent PR-head object must keep, got: $got"
case "$got" in
  *"object unavailable locally"*) : ;;
  *) fail "(23) the keep must name the unavailable PR head, got: $got" ;;
esac
[ "$(cat "$MB_LOG")" = "merge-base --is-ancestor $(git -C "$MISSOBJ" rev-parse HEAD) $GHOST" ] \
  || fail "(23) the ancestry query must have been attempted with the stubbed head, log: $(cat "$MB_LOG")"
echo "worktree-gc-predicate: (23) an absent PR-head object keeps with fetch-and-recheck evidence: ok"

# (24) LOCK-PROBE LOOKUP FAILURE -> keep (R12 ruling 1). The lock probe is its
# own git-dir lookup; folding its failure into "not locked" would let a tree
# whose lock state is UNANSWERABLE proceed toward reclaim. The counting shim
# fails the SECOND --absolute-git-dir call (the probe); the threshold-3 control
# proves the same lane reclaims when the shim does not fire, so the branch is
# reachable only through the failure it names.
LOCKERR="$WORK/LockErr"
git -C "$PRIMARY" worktree add -q -b lane/lockerr "$LOCKERR" main
printf 'MERGED\t\t%s\n' "$(git -C "$LOCKERR" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/lockerr"
mkdir -p "$WORK/lockerrbin"
LOCKERR_COUNT="$WORK/lockerr.count"
export LOCKERR_COUNT
cat > "$WORK/lockerrbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = --absolute-git-dir ]; then
    c="$(cat "$LOCKERR_COUNT" 2>/dev/null || printf '0')"
    c=$((c+1))
    printf '%s\n' "$c" > "$LOCKERR_COUNT"
    [ "$c" -ge "${LOCKERR_FAIL_AT:?}" ] && exit 128
  fi
done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/lockerrbin/git"
rm -f "${LOCKERR_COUNT:?}"
got="$(LOCKERR_FAIL_AT=2 PATH="$WORK/lockerrbin:$BIN:$PATH" bash "$TAP" worktree check "$LOCKERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(24) a failed lock-probe lookup must keep, got: $got"
case "$got" in
  *"lock probe"*) : ;;
  *) fail "(24) the keep must name the lock probe, got: $got" ;;
esac
rm -f "${LOCKERR_COUNT:?}"
got="$(LOCKERR_FAIL_AT=3 PATH="$WORK/lockerrbin:$BIN:$PATH" bash "$TAP" worktree check "$LOCKERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = reclaim ] \
  || fail "(24) control: with the threshold past both lookups the lane must reclaim, got: $got"
echo "worktree-gc-predicate: (24) a failed lock-probe lookup keeps (fail-closed): ok"

# (25) FAILED gh WITH PARTIAL STDOUT -> keep (R12 ruling 1). The stub prints a
# MERGED triple and THEN exits 3; a reader that kept the partial answer would
# reclaim on output the tool itself disowned. The lane is otherwise reclaimable
# (MERGED row, zero-ahead), so the old stdout-keeping shape reads reclaim here.
GHFAIL="$WORK/GhFail"
git -C "$PRIMARY" worktree add -q -b lane/ghfail "$GHFAIL" main
printf 'FAIL:MERGED\t\t%s\n' "$(git -C "$GHFAIL" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/ghfail"
gh_before="$(gh_calls)"
got="$(check "$GHFAIL")"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(25) a failed gh query must keep even after partial stdout, got: $got"
case "$got" in
  *"no usable PR answer"*) : ;;
  *) fail "(25) the keep must name the unusable PR answer, got: $got" ;;
esac
[ "$(( $(gh_calls) - gh_before ))" = 1 ] || fail "(25) expected exactly one gh query"
echo "worktree-gc-predicate: (25) a failed gh query discards its partial stdout and keeps: ok"

# (25b) PRESERVATION COMPARISON FAILURE -> keep (R12 ruling 1, the fourth
# query). rc >= 2 from `git diff --quiet origin/main HEAD` is a broken query,
# not "content differs"; the incumbent folded both into the unpublished-content
# keep, so this control is what discriminates the fail-closed row.
DIFFERR="$WORK/DiffErr"
git -C "$PRIMARY" worktree add -q -b lane/differr "$DIFFERR" main
printf 'differr content\n' > "$DIFFERR/file.txt"
git -C "$DIFFERR" add -A && git -C "$DIFFERR" commit -qm "lane work whose preservation must be queried"
printf 'MERGED\t\t%s\n' "$(git -C "$DIFFERR" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/differr"
mkdir -p "$WORK/differrbin"
cat > "$WORK/differrbin/git" <<'GITSTUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = diff ] && exit 128; done
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/differrbin/git"
got="$(PATH="$WORK/differrbin:$BIN:$PATH" bash "$TAP" worktree check "$DIFFERR" 2>&1 || true)"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(25b) a failed origin/main comparison must keep, got: $got"
case "$got" in
  *"origin/main comparison failed (fail-closed)"*) : ;;
  *) fail "(25b) the keep must name the failed comparison, not unpublished content, got: $got" ;;
esac
# Control, unshimmed, same differing tree: a healthy rc 1 is the normal
# "content differs" answer and must keep the unpublished-content evidence —
# never the failed-comparison string.
got="$(check "$DIFFERR")"
[ "$(printf '%s' "$got" | awk -F'\t' 'NR==1 { print $1 }')" = keep ] \
  || fail "(25b) control: the differing tree must keep, got: $got"
case "$got" in
  *"holds unpublished content differing from origin/main"*) : ;;
  *) fail "(25b) control: a healthy rc1 must read unpublished content, not a failed comparison, got: $got" ;;
esac
echo "worktree-gc-predicate: (25b) rc>=2 keeps as a failed comparison; rc1 keeps as unpublished content: ok"

# (26) JSON BYTES [A1] (driver clarification of the ladder's arm 26). The
# compact JSON line must carry the em dash of the CLOSED evidence as the six
# ASCII characters backslash + u2014 — python ensure_ascii parity via
# ensureAscii — never as the three raw UTF-8 bytes, while the PARSED evidence
# is the em dash again and the row equals the human output byte for byte.
CLOSEDWT="$WORK/ClosedWt"
git -C "$PRIMARY" worktree add -q -b lane/closedwt "$CLOSEDWT" main
printf 'CLOSED\t\t%s\n' "$(git -C "$CLOSEDWT" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/closedwt"
human="$(check "$CLOSEDWT")"
json="$(PATH="$BIN:$PATH" bash "$TAP" worktree check --json "$CLOSEDWT" 2>&1 || true)"
[ "$(printf '%s\n' "$json" | wc -l | tr -d ' ')" = 1 ] \
  || fail "(26) --json must print exactly one line, got: $json"
case "$json" in
  '{"ok":true,"results":[{"verdict":"reclaim"'*) : ;;
  *) fail "(26) JSON must open with the compact reclaim row, got: $json" ;;
esac
printf '%s' "$json" | grep -F '\u2014' >/dev/null 2>&1 \
  || fail "(26) raw JSON must carry the escaped em dash, got: $json"
if printf '%s' "$json" | LC_ALL=C grep -F '—' >/dev/null 2>&1; then
  fail "(26) raw JSON must not carry a literal UTF-8 em dash, got: $json"
fi
parsed="$(printf '%s\n' "$json" | python3 -B -c 'import json,sys; r=json.load(sys.stdin)["results"][0]; assert "\u2014" in r["evidence"], r; print(r["verdict"]+"\t"+r["path"]+"\t"+r["evidence"])')"
[ "$parsed" = "$human" ] \
  || fail "(26) parsed JSON row must equal the human row, got: $parsed vs $human"
echo "worktree-gc-predicate: (26) JSON em dash is escaped ASCII, parsed value and row match: ok"

# (27) INDEX SCHEMA IS NOT POLICY [A2]. The checker reads `teams` and neither
# requires nor inspects `schema`: (a) a SCHEMA-LESS index whose seat sits inside
# the target still refuses on that seat; (b) a "0.19" index on a reclaimable
# lane still reclaims — a real verdict, not "machine index unreadable". Routing
# the read through loadGlobalRegistry's schema/marker verdicts would flip both.
SCHEMASEAT="$WORK/SchemaSeat"
git -C "$PRIMARY" worktree add -q -b lane/schemaseat "$SCHEMASEAT" main
printf 'MERGED\t\t%s\n' "$(git -C "$SCHEMASEAT" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/schemaseat"
python3 -B - "$TAP_INDEX_HOME" "$WORK" "$SCHEMASEAT" <<'PY'
import json, os, sys
index, work, seated = sys.argv[1:4]
reg = os.path.join(work, "schema-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"teams": {"slp": {
        "root": os.path.join(work, "some-other-root"),
        "registry_location": reg, "state": "registered"}}}, fh)
with open(reg, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "slp"},
               "seats": {"peggy": {"registered_from_worktree": seated}}}, fh)
PY
got="$(check "$SCHEMASEAT")"
case "$got" in
  *"registered seat cwd (slp/peggy)"*) : ;;
  *) fail "(27) a schema-less index must still refuse a seat inside the target, got: $got" ;;
esac
python3 -B - "$TAP_INDEX_HOME" <<'PY'
import json, sys
with open(sys.argv[1] + "/global-registry.json", "w") as fh:
    json.dump({"schema": "0.19", "teams": {}}, fh)
PY
[ "$(verdict "$SQUASHED")" = reclaim ] \
  || fail "(27) a '0.19' index on a reclaimable lane must still reclaim, got: $(check "$SQUASHED")"
echo "worktree-gc-predicate: (27) index schema is not policy; claims follow teams: ok"

# (28) BRANCH DELETION IS A SEPARATE QUESTION (tap-xw1tx). `check` reclaim licenses
# checkout removal only. `branch` keeps today's completion+preservation gate and is
# the only license for git branch -D. A detached checkout reclaim must not name a
# branch to delete, and a branch that merely contains its own HEAD must not reclaim
# while its commits are unpublished or its PR is not merged.
branchq() { PATH="$BIN:$PATH" bash "$TAP" worktree branch "$@" 2>&1 || true; }
bverdict() { branchq "$1" | awk -F'\t' 'NR==1 { print $1 }'; }
bfield() { branchq "$1" | awk -F'\t' -v n="$2" 'NR==1 { print $n }'; }

[ "$(awk -F'\t' 'NR==1 { print NF }' <<< "$(check "$SQUASHED")")" = 3 ] \
  || fail "(28) check stays three fields, got: $(check "$SQUASHED")"
case "$(check "$SQUASHED")" in
  *"may be deleted"*) fail "(28) check reclaim must not license branch deletion: $(check "$SQUASHED")" ;;
esac
[ "$(bverdict "$SQUASHED")" = reclaim ] \
  || fail "(28) a squash-merged corroborated branch must reclaim for deletion, got: $(branchq "$SQUASHED")"
[ "$(bfield "$SQUASHED" 3)" = lane/squashed ] \
  || fail "(28) deletion reclaim must name the branch, got: $(branchq "$SQUASHED")"
squashed_tip="$(git -C "$SQUASHED" rev-parse HEAD)"
case "$(bfield "$SQUASHED" 4)" in
  "branch lane/squashed may be deleted at ${squashed_tip}: "*) : ;;
  *) fail "(28) deletion evidence must name the branch and the checked commit, got: $(branchq "$SQUASHED")" ;;
esac
case "$(bfield "$SQUASHED" 4)" in
  *"the PR's head commit contains the branch tip"*) : ;;
  *) fail "(28) tip=head deletion must name the PR head, got: $(branchq "$SQUASHED")" ;;
esac
PATH="$BIN:$PATH" bash "$TAP" worktree branch "$SQUASHED" >/dev/null 2>&1 \
  || fail "(28) an all-reclaim branch run must exit 0"
if PATH="$BIN:$PATH" bash "$TAP" worktree branch "$SQUASHED" "$OPENPR" >/dev/null 2>&1; then
  fail "(28) a run containing a non-reclaim branch verdict must exit non-zero"
fi

[ "$(bverdict "$OPENPR")" = keep ] \
  || fail "(28) an open PR must not license branch deletion, got: $(branchq "$OPENPR")"
[ -z "$(bfield "$OPENPR" 3)" ] || fail "(28) a keep must leave the branch field empty, got: $(branchq "$OPENPR")"
case "$(branchq "$OPENPR")" in
  *"no completion evidence"*) : ;;
  *) fail "(28) open PR keep must be missing completion, got: $(branchq "$OPENPR")" ;;
esac
case "$(branchq "$OPENPR")" in
  *"may be deleted"*) fail "(28) open PR evidence must not license deletion: $(branchq "$OPENPR")" ;;
esac

[ "$(bverdict "$FRESH")" = keep ] \
  || fail "(28) a fresh zero-commit branch must not be deleted, got: $(branchq "$FRESH")"
[ "$(bverdict "$DIRTY")" = hold ] \
  || fail "(28) a dirty tree must hold before branch deletion, got: $(branchq "$DIRTY")"
[ -z "$(bfield "$DIRTY" 3)" ] || fail "(28) a hold must leave the branch field empty, got: $(branchq "$DIRTY")"
# A detached tree has no branch even when dirty or locked. check still holds.
[ "$(verdict "$DIRTYREVIEW")" = hold ] \
  || fail "(28) checkout check must still hold a dirty detached tree, got: $(check "$DIRTYREVIEW")"
[ "$(bverdict "$DIRTYREVIEW")" = refuse ] \
  || fail "(28) a dirty detached tree must refuse branch deletion, got: $(branchq "$DIRTYREVIEW")"
case "$(branchq "$DIRTYREVIEW")" in
  *"detached HEAD; no branch to delete"*) : ;;
  *) fail "(28) dirty detached refusal must name detached HEAD, got: $(branchq "$DIRTYREVIEW")" ;;
esac
git -C "$PRIMARY" worktree lock "$LOCKEDREVIEW"
[ "$(verdict "$LOCKEDREVIEW")" = hold ] \
  || fail "(28) checkout check must still hold a locked detached tree, got: $(check "$LOCKEDREVIEW")"
[ "$(bverdict "$LOCKEDREVIEW")" = refuse ] \
  || fail "(28) a locked detached tree must refuse branch deletion, got: $(branchq "$LOCKEDREVIEW")"
git -C "$PRIMARY" worktree unlock "$LOCKEDREVIEW"

[ "$(verdict "$DIFFERR")" = keep ] \
  || fail "(28) checkout removal must still keep unique content that no remote contains, got: $(check "$DIFFERR")"
[ "$(bverdict "$DIFFERR")" = reclaim ] \
  || fail "(28) a merged PR whose head is the branch tip must license deletion, got: $(branchq "$DIFFERR")"
case "$(branchq "$DIFFERR")" in
  *"the PR's head commit contains the branch tip"*) : ;;
  *) fail "(28) tip=head deletion evidence must name the PR head, got: $(branchq "$DIFFERR")" ;;
esac

[ "$(verdict "$REVIEWTREE")" = reclaim ] \
  || fail "(28) fixture: detached containment must still reclaim the checkout, got: $(check "$REVIEWTREE")"
[ "$(bverdict "$REVIEWTREE")" = refuse ] \
  || fail "(28) a detached checkout reclaim must not license branch deletion, got: $(branchq "$REVIEWTREE")"
case "$(branchq "$REVIEWTREE")" in
  *"detached HEAD; no branch to delete"*) : ;;
  *) fail "(28) detached refusal must say there is no branch, got: $(branchq "$REVIEWTREE")" ;;
esac
[ -z "$(bfield "$REVIEWTREE" 3)" ] || fail "(28) detached refusal must not name a branch, got: $(branchq "$REVIEWTREE")"
case "$(branchq "$REVIEWTREE")" in
  *lane/reviewed*) fail "(28) detached refusal must not name the containing branch: $(branchq "$REVIEWTREE")" ;;
esac
[ "$(bverdict "$REVIEWEDLANE")" = keep ] \
  || fail "(28) a branch that only contains its own unpublished HEAD must keep, got: $(branchq "$REVIEWEDLANE")"

bjson="$(PATH="$BIN:$PATH" bash "$TAP" worktree branch --json "$CLOSEDWT" 2>&1 || true)"
case "$bjson" in
  '{"ok":true,"results":[{"verdict":"reclaim","path":"'"$CLOSEDWT"'","branch":"lane/closedwt",'*) : ;;
  *) fail "(28) branch JSON must name the branch before evidence, got: $bjson" ;;
esac
printf '%s' "$bjson" | grep -F '\u2014' >/dev/null 2>&1 \
  || fail "(28) branch JSON must escape the em dash, got: $bjson"
bhuman="$(branchq "$CLOSEDWT")"
bparsed="$(printf '%s\n' "$bjson" | python3 -B -c 'import json,sys; r=json.load(sys.stdin)["results"][0]; assert r["branch"]=="lane/closedwt", r; print(r["verdict"]+"\t"+r["path"]+"\t"+r["branch"]+"\t"+r["evidence"])')"
[ "$bparsed" = "$bhuman" ] \
  || fail "(28) parsed branch JSON must equal the human row, got: $bparsed vs $bhuman"

rc=0
PATH="$BIN:$PATH" bash "$TAP" worktree branch >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "(28) branch with no path must exit 1, got: $rc"
# --json usage is the envelope on stdout, including a bad flag beside --json.
json_out="$WORK/branch-usage.json"
json_err="$WORK/branch-usage.err"
rc=0
PATH="$BIN:$PATH" bash "$TAP" worktree branch --json >"$json_out" 2>"$json_err" || rc=$?
[ "$rc" = 1 ] || fail "(28) branch --json with no path must exit 1, got: $rc"
[ ! -s "$json_err" ] || fail "(28) branch --json usage must not write stderr, got: $(cat "$json_err")"
python3 -B - "$json_out" <<'PY' || fail "(28) branch --json with no path must be a usage_error envelope"
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["ok"] is False and doc["error_class"] == "usage_error", doc
assert "need at least one path" in doc["detail"], doc
PY
rc=0
PATH="$BIN:$PATH" bash "$TAP" worktree branch --nope --json >"$json_out" 2>"$json_err" || rc=$?
[ "$rc" = 1 ] || fail "(28) branch --nope --json must exit 1, got: $rc"
[ ! -s "$json_err" ] || fail "(28) a bad flag beside --json must not write stderr, got: $(cat "$json_err")"
python3 -B - "$json_out" <<'PY' || fail "(28) a bad flag beside --json must be a usage_error envelope"
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["ok"] is False and doc["error_class"] == "usage_error", doc
assert "unknown flag" in doc["detail"], doc
PY
rc=0
PATH="$BIN:$PATH" bash "$TAP" worktree nosuch >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "(28) an unknown worktree subcommand must exit 1, got: $rc"
help="$(PATH="$BIN:$PATH" bash "$TAP" help worktree 2>&1 || true)"
case "$help" in
  *"tap worktree branch"*) : ;;
  *) fail "(28) help must document tap worktree branch, got: $help" ;;
esac
case "$help" in
  *"does not license git branch -D"*) : ;;
  *) fail "(28) help must say check does not license git branch -D, got: $help" ;;
esac
case "$help" in
  *"git update-ref -d refs/heads/<branch> <oid>"*) : ;;
  *) fail "(28) help must prescribe compare-and-delete, got: $help" ;;
esac
echo "worktree-gc-predicate: (28) branch deletion is a separate question from checkout removal: ok"

# (29) A stale remote-tracking ref is not preservation for branch deletion.
# Closed PR, server branch gone, local tracking ref still contains a tip that
# is one commit past the PR head: branch keeps and names the unpublished
# commits. Checkout keeps too, on the older ahead-or-diverged wording.
STALE="$WORK/StaleRemote"
git -C "$PRIMARY" worktree add -q -b lane/stale "$STALE" main
printf 'pr head\n' > "$STALE/file.txt"
git -C "$STALE" add -A && git -C "$STALE" commit -qm "pr head"
stale_pr="$(git -C "$STALE" rev-parse HEAD)"
printf 'one past\n' >> "$STALE/file.txt"
git -C "$STALE" add -A && git -C "$STALE" commit -qm "unpublished past the PR"
git -C "$STALE" update-ref refs/remotes/origin/lane/stale HEAD
[ -n "$(git -C "$STALE" branch -r --contains HEAD)" ] \
  || fail "(29) fixture must have a stale remote-tracking ref containing HEAD"
printf 'CLOSED\t\t%s\t%s\n' "$stale_pr" "$stale_pr" > "$GH_STUB_STATE_DIR/lane/stale"
[ "$(bverdict "$STALE")" = keep ] \
  || fail "(29) a tip past the PR head must not be deleted on a stale tracking ref, got: $(branchq "$STALE")"
case "$(branchq "$STALE")" in
  *"unpublished commits beyond PR head"*) : ;;
  *) fail "(29) the keep must name unpublished commits, got: $(branchq "$STALE")" ;;
esac
case "$(branchq "$STALE")" in
  *"may be deleted"*|*"published on a remote"*) fail "(29) stale ref must not license deletion: $(branchq "$STALE")" ;;
esac
case "$(check "$STALE")" in
  keep*"ahead of or diverged"*) : ;;
  *) fail "(29) checkout must keep the ahead tip with its own wording, got: $(check "$STALE")" ;;
esac
# tip equals the PR head, with no remote-tracking ref: branch reclaims, checkout keeps.
TIPHEAD="$WORK/TipHead"
git -C "$PRIMARY" worktree add -q -b lane/tiphead "$TIPHEAD" main
printf 'only on the pr head\n' > "$TIPHEAD/file.txt"
git -C "$TIPHEAD" add -A && git -C "$TIPHEAD" commit -qm "pr head itself"
printf 'CLOSED\t\t%s\t%s\n' "$(git -C "$TIPHEAD" rev-parse HEAD)" "$(git -C "$TIPHEAD" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/lane/tiphead"
[ -z "$(git -C "$TIPHEAD" branch -r --contains HEAD)" ] \
  || fail "(29) tip=head fixture must not be contained by a remote-tracking ref"
[ "$(bverdict "$TIPHEAD")" = reclaim ] \
  || fail "(29) tip=head must license deletion without a remote ref, got: $(branchq "$TIPHEAD")"
case "$(branchq "$TIPHEAD")" in
  *"the PR's head commit contains the branch tip"*) : ;;
  *) fail "(29) tip=head evidence must name the PR head, got: $(branchq "$TIPHEAD")" ;;
esac
[ "$(verdict "$TIPHEAD")" = keep ] \
  || fail "(29) checkout must still keep a tip no remote contains, got: $(check "$TIPHEAD")"
# Empty headRefOid fails closed for branch deletion.
NOHEAD="$WORK/NoHead"
git -C "$PRIMARY" worktree add -q -b lane/nohead "$NOHEAD" main
printf 'CLOSED\t\t\n' > "$GH_STUB_STATE_DIR/lane/nohead"
[ "$(bverdict "$NOHEAD")" = keep ] \
  || fail "(29) a missing headRefOid must keep, got: $(branchq "$NOHEAD")"
case "$(branchq "$NOHEAD")" in
  *"lacks head corroboration"*) : ;;
  *) fail "(29) missing headRefOid must fail closed, got: $(branchq "$NOHEAD")" ;;
esac
# Squash catch: tip is an ancestor of the PR head, not the head and not listed,
# and the content is already on origin/main. Branch reclaims on that catch,
# not on a remote-tracking ref.
CATCH="$WORK/SquashCatch"
git -C "$PRIMARY" worktree add -q -b lane/squashcatch "$CATCH" main
catch_tip="$(git -C "$CATCH" rev-parse HEAD)"
catch_head="$(git -C "$CATCH" commit-tree "$(git -C "$CATCH" rev-parse 'HEAD^{tree}')" -p "$catch_tip" -m 'pr head past the tip')"
printf 'MERGED\t\t%s\t%s\n' "$catch_head" "$catch_head" > "$GH_STUB_STATE_DIR/lane/squashcatch"
[ "$(bverdict "$CATCH")" = reclaim ] \
  || fail "(29) content already on origin/main must still license deletion, got: $(branchq "$CATCH")"
case "$(branchq "$CATCH")" in
  *"content already on origin/main (squash catch)"*) : ;;
  *) fail "(29) the reclaim must name the squash catch, got: $(branchq "$CATCH")" ;;
esac
# Listed tip, different headRefOid, head object not in this repo. Ancestry
# cannot run. Branch deletion still reclaims from the commit list. Checkout
# keeps on the missing object.
LISTED="$WORK/ListedMissing"
git -C "$PRIMARY" worktree add -q -b lane/listedmiss "$LISTED" main
printf 'listed tip\n' > "$LISTED/file.txt"
git -C "$LISTED" add -A && git -C "$LISTED" commit -qm "listed tip"
listed_tip="$(git -C "$LISTED" rev-parse HEAD)"
listed_head="0000000000000000000000000000000000000001"
git -C "$LISTED" cat-file -e "$listed_head" 2>/dev/null \
  && fail "(29) fixture head oid must be absent locally"
printf 'CLOSED\t\t%s\t%s\n' "$listed_head" "$listed_tip" > "$GH_STUB_STATE_DIR/lane/listedmiss"
[ "$(bverdict "$LISTED")" = reclaim ] \
  || fail "(29) a listed tip must license deletion when the PR head object is absent, got: $(branchq "$LISTED")"
case "$(branchq "$LISTED")" in
  *"the PR's head commit contains the branch tip"*) : ;;
  *) fail "(29) listed-tip evidence must name the PR head, got: $(branchq "$LISTED")" ;;
esac
case "$(check "$LISTED")" in
  keep*"object unavailable locally"*) : ;;
  *) fail "(29) checkout must still keep when the PR head object is absent, got: $(check "$LISTED")" ;;
esac
echo "worktree-gc-predicate: (29) branch deletion ignores a stale remote-tracking ref: ok"

# (30) main and master are never a deletion license, including from a linked
# worktree, and a dirty one refuses rather than holding.
git -C "$PRIMARY" checkout -q -b lane/primary-aside
MAINWT="$WORK/MainLinked"
git -C "$PRIMARY" worktree add -q "$MAINWT" main
printf 'dirty\n' >> "$MAINWT/uncommitted"
[ "$(bverdict "$MAINWT")" = refuse ] \
  || fail "(30) a linked main must refuse deletion, got: $(branchq "$MAINWT")"
case "$(branchq "$MAINWT")" in
  *"refusing to license deletion of main, master, or the remote default branch"*) : ;;
  *) fail "(30) main must not be held or licensed: $(branchq "$MAINWT")" ;;
esac
MASTERWT="$WORK/MasterLinked"
git -C "$PRIMARY" branch master main
git -C "$PRIMARY" worktree add -q "$MASTERWT" master
[ "$(bverdict "$MASTERWT")" = refuse ] \
  || fail "(30) a linked master must refuse deletion, got: $(branchq "$MASTERWT")"
case "$(branchq "$MASTERWT")" in
  *"may be deleted"*) fail "(30) master must not be licensed: $(branchq "$MASTERWT")" ;;
esac
# A remote default that is neither main nor master still refuses.
git -C "$PRIMARY" branch trunk main
git -C "$PRIMARY" update-ref refs/remotes/origin/trunk "$(git -C "$PRIMARY" rev-parse main)"
git -C "$PRIMARY" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk
TRUNKWT="$WORK/TrunkLinked"
git -C "$PRIMARY" worktree add -q "$TRUNKWT" trunk
[ "$(bverdict "$TRUNKWT")" = refuse ] \
  || fail "(30) the remote default branch must refuse deletion, got: $(branchq "$TRUNKWT")"
case "$(branchq "$TRUNKWT")" in
  *"remote default branch"*) : ;;
  *) fail "(30) trunk must be refused as the remote default, got: $(branchq "$TRUNKWT")" ;;
esac
# An absent origin/HEAD is an unknown remote default, so a lane keeps even
# when the PR row would otherwise license deletion. main still refused above.
git -C "$PRIMARY" symbolic-ref --delete refs/remotes/origin/HEAD
[ "$(bverdict "$SQUASHED")" = keep ] \
  || fail "(30) a lane must keep when the remote default is unrecorded, got: $(branchq "$SQUASHED")"
case "$(branchq "$SQUASHED")" in
  *"could not read the remote default branch"*) : ;;
  *) fail "(30) the keep must name the missing remote default, got: $(branchq "$SQUASHED")" ;;
esac
git -C "$PRIMARY" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
# The licensed delete is compare-and-delete. Advance the branch after the
# verdict, remove the checkout, and the old oid must not delete the new tip.
checked="$(git -C "$SQUASHED" rev-parse HEAD)"
case "$(bfield "$SQUASHED" 4)" in
  *"may be deleted at ${checked}: "*) : ;;
  *) fail "(30) the verdict must carry the checked commit, got: $(branchq "$SQUASHED")" ;;
esac
printf 'advanced after the verdict\n' >> "$SQUASHED/file.txt"
git -C "$SQUASHED" add -A && git -C "$SQUASHED" commit -qm "advance after verdict"
advanced="$(git -C "$SQUASHED" rev-parse HEAD)"
git -C "$PRIMARY" worktree remove "$SQUASHED"
if git -C "$PRIMARY" update-ref -d refs/heads/lane/squashed "$checked"; then
  fail "(30) update-ref -d of the checked commit must refuse after the branch advances"
fi
[ "$(git -C "$PRIMARY" rev-parse refs/heads/lane/squashed)" = "$advanced" ] \
  || fail "(30) the advanced tip must survive the refused delete"
git -C "$PRIMARY" update-ref -d refs/heads/lane/squashed "$advanced" \
  || fail "(30) update-ref -d of the current tip must succeed"
git -C "$PRIMARY" rev-parse --verify --quiet refs/heads/lane/squashed \
  && fail "(30) the matched delete must remove the branch"
echo "worktree-gc-predicate: (30) main and master refuse branch deletion: ok"

# (31) Deletion must not license a branch that is live in another worktree,
# a numeric name gh would read as a PR number, or a name that changed between
# the protection read and the deletion target.
SHARED="$WORK/SharedA"
SHAREDB="$WORK/SharedB"
git -C "$PRIMARY" worktree add -q -b lane/shared "$SHARED" main
git -C "$PRIMARY" worktree add -q --force "$SHAREDB" lane/shared
[ "$(bverdict "$SHARED")" = refuse ] \
  || fail "(31) a branch checked out elsewhere must refuse, got: $(branchq "$SHARED")"
case "$(branchq "$SHARED")" in
  *"checked out in another worktree"*) : ;;
  *) fail "(31) the refusal must name the other checkout, got: $(branchq "$SHARED")" ;;
esac
NUM="$WORK/NumBranch"
git -C "$PRIMARY" worktree add -q -b 123 "$NUM" main
printf 'MERGED\t\t%s\t%s\n' "$(git -C "$NUM" rev-parse HEAD)" "$(git -C "$NUM" rev-parse HEAD)" > "$GH_STUB_STATE_DIR/123"
[ "$(bverdict "$NUM")" = keep ] \
  || fail "(31) a numeric branch must keep, got: $(branchq "$NUM")"
case "$(branchq "$NUM")" in
  *"ambiguous with a PR number"*) : ;;
  *"may be deleted"*) fail "(31) a numeric branch must not be licensed: $(branchq "$NUM")" ;;
esac
SWITCH="$WORK/Switch"
git -C "$PRIMARY" branch lane/other main
git -C "$PRIMARY" worktree add -q -b lane/switch "$SWITCH" main
mkdir -p "$WORK/switchbin"
printf '0' > "$WORK/switch-count"
cat > "$WORK/switchbin/git" <<'GITSTUB'
#!/usr/bin/env bash
wt=""
[ "$1" = "-C" ] && wt="$2"
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "HEAD" ]; then
  n=$(cat "${SWITCH_COUNT:?}")
  n=$((n + 1))
  printf '%s' "$n" > "$SWITCH_COUNT"
  if [ "$n" = 2 ] && [ -n "$wt" ]; then
    /usr/bin/git -C "$wt" checkout -q lane/other
  fi
fi
exec /usr/bin/git "$@"
GITSTUB
chmod +x "$WORK/switchbin/git"
got="$(SWITCH_COUNT="$WORK/switch-count" PATH="$WORK/switchbin:$BIN:$PATH" bash "$TAP" worktree branch "$SWITCH" 2>&1 || true)"
case "$got" in
  keep*"branch changed during the check"*) : ;;
  *) fail "(31) a branch that moves between the two reads must keep, got: $got" ;;
esac
echo "worktree-gc-predicate: (31) live, numeric, and switched branches are not deletion licenses: ok"

echo "worktree-gc-predicate: ok"
