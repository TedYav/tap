# Worktree gc

Details for the [drive skill](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Worktree GC

Once an agent opens a PR in a worktree and merges it, or merges an ephemeral
worktree back into the main team worktree, it must garbage-collect that worktree.
The goal is not zero worktrees — accumulation is expected and fine; **explosions** are the failure.
Reap your worktree when its work has landed. Do not reap aggressively; reap when the work is done.

### When to reap

- **After your PR merges.** The work is on `main`; the worktree is residue. Reap it.
- **After an ephemeral review/verify tree has served its purpose.** A review tree exists to host one
  exact-SHA run; reap it as part of the same motion, not a separate act of remembering.
- **When a lane is abandoned** (LEADER instruction to abandon, not merge). Push the branch first if
  the work has value; then reap.

### Ask the checker, not your memory

```bash
tap worktree check <path>...          # reclaim | keep | hold | refuse  (--json for machines)
tap worktree check "$p" && git worktree remove "$p"    # exit 0 only when every path reclaims
```

`tap worktree check` is the mechanical form of everything below — same rules, same refusals, pinned
by `worktree-gc-predicate.test.sh`. Prefer it over re-deriving the predicate by hand; the two
incidents this section exists to prevent both came from a hand-rolled check. It CHECKS and never
removes: the removal stays your act.

Verdicts: **reclaim** (safe to `git worktree remove`; not permission to delete a branch), **keep** (no completion evidence, or a query failed —
fail-closed), **hold** (dirty or locked; a human decides), **refuse** (not a candidate at all — the
primary checkout, an enrolled team root, or a tree a registered seat is working in).

**De-enroll before removing.** When the refusal names an enrolled team root, the order is: stop the
team's seats and de-enroll it with `tap team shutdown <team>` (the refusal names it; `tap admin
retire` alone de-enrolls without stopping pane seats), re-run the check, then remove.
Removing first leaves a stale enrollment behind. TAP survives it (other teams keep sending, and the
stale team's sends refuse `stale_enrollment`), and `tap doctor --fix` or `tap admin refresh` purges it.

### What "clean" means before removal

- **Working tree is clean** — `git status` shows no uncommitted changes. If it does not, commit or
  stash before reaping.
- **The work has landed or is pushed.** For a branch-backed worktree: the PR is merged (check
  `gh pr view <branch> --json state` — do NOT use `git merge-base --is-ancestor` against main,
  which reports "unmerged" for every squash-merged branch; this repo squash-merges). A merged/closed
  row found by branch name must also be CORROBORATED before it counts (tap-dg8g): the tree's HEAD
  must equal the PR head, equal the merge commit, or be contained by the PR head — a reused branch
  whose tip is ahead of the old PR head keeps. For a detached worktree
  (review trees): HEAD contained by any local branch or remote-tracking ref is enough — the tree
  holds nothing a ref does not, and the checker reclaims it without a PR (tap-6a4ao). When no ref
  contains HEAD (the lane branch was deleted after its squash), the PR it was created to review
  must be merged — record the PR at creation. A number
  recovered from the tree name (e.g., `Verify142` → PR 142, `Gate907b` → PR 907) is a **lookup key, never evidence**: in a
  mature repo every low ordinal resolves, so a wrong parse does not fail loudly — it succeeds against
  the wrong referent (a tree named for a single-digit ordinal resolved to the real, merged, unrelated PR with that number and produced a
  well-formed reclaim verdict for five live worktrees). A name-derived number counts only after
  **exact-SHA corroboration**: this tree's HEAD must equal that PR's merge commit, head ref, or an explicitly listed PR commit.
  An earlier listed tip qualifies; an unlisted ancestor or superseded rebase tip does not.
  Remote publication or content-equivalence must still establish preservation.
  Uncorroborated, the answer is keep, not reap. Then check `gh pr view <n> --json state`.
  **Do NOT use reachability-of-HEAD as a NEGATIVE** (`git branch -r --contains HEAD` empty):
  squash-merge orphans the exact commits, so HEAD is reachable from nowhere even when the work is
  safely on `main`. If the PR
  cannot be determined, check whether the tree's patch is already on `main` (content-equivalence).
  If neither resolves it, **refuse and report to the LEADER.**
- **No active worktree lock.** `git worktree lock` by another seat means the tree is in use; do not
  force-remove.

### The trap: name-matching vs reachability — and how it squares with the rule above

Read alone, this section and the one above appear to contradict each other: that one says do NOT use
reachability-of-HEAD, this one calls reachability the safe predicate. Both are right about different
directions of the same test, and the checker encodes the distinction:

**Reachability is sound as a POSITIVE signal and meaningless as a NEGATIVE one.** If a remote ref
contains HEAD, the commits are genuinely published — that is real evidence, and it is what makes
reachability better than name-matching. If no remote ref contains HEAD, that proves nothing after a
squash-merge, which orphans the exact commits. So the checker never DENIES on reachability: an
uncontained HEAD falls through to name-recovery and content-equivalence, whatever the tree's shape.

**For a branch-backed tree, neither one is completion evidence.** Published-ness and
content-equivalence are *preservation* facts — "nothing unique would be lost" — which a brand-new
lane with zero commits satisfies for free. That is tap-t7rk, where a zero-ahead live branch was reaped
mid-work. Completion (a merged or closed PR, corroborated against the PR's own head per tap-dg8g) is
asked first; preservation is the tiebreaker that lets a squash-merged branch through after it.

**For a DETACHED tree, ref containment is sufficient on its own** (tap-6a4ao). A detached tree whose
HEAD a local branch or remote-tracking ref contains holds nothing that ref does not: a commit made in
it leaves HEAD contained by nothing (keep), uncommitted edits make it dirty (hold), and a registered
seat inside it refuses before evidence is asked. So the checker returns `reclaim` there before any PR
question, with no GitHub lookup. What separates this from tap-t7rk is the branch: a lane says "live
work belongs here" by checking out a branch, and a detached tree makes no such claim. The residual is
a detached tree an unregistered process is actively using — indistinguishable from an abandoned one;
`git worktree lock` is the tool for that, and a pairing reviewer reaps only its own tree.

Against name-matching the original point stands: a branch reviewed under one name and pushed under
another (e.g., `review/tap-68lp` reviewed the PR whose branch was `tap-68lp-read-path`) fails a name-matching check
and produces a false refusal. False refusals sound safe and are not — they train the reader to
override the refusal, and then the one real refusal gets overridden too. **A refusal that cries wolf
is worse than no refusal.**

### How to reap

```bash
tap worktree branch <path>      # ask while the checkout exists; reclaim names the branch
git worktree remove <path>      # only after `tap worktree check` says reclaim
git update-ref -d refs/heads/<branch> <oid>  # only after branch says reclaim, the checkout is gone, and <oid> is still the tip
```

`tap worktree check` reclaim does not license `git branch -D`. The branch question
keeps completion, then asks whether the PR's head commit contains the branch tip
or the content is already on `origin/main`. A local remote-tracking ref does not
count. The delete is `git update-ref -d` of the commit the reclaim named.
`main`, `master`, and the remote default branch refuse. A detached HEAD
refuses, so a review tree reaped because a ref contains it does not delete that ref.
`git worktree remove` refuses a dirty tree — that is the mechanical check that prevents lost work.
If it refuses, find out why before forcing. If the tree is at the old root
(`trees/<Name>`, a `trees/` directory beside the repository, rather than `trees/tap/<Name>`), it still needs reaping
— the 2026-07-24 nesting migration moved new worktrees under `trees/tap/`, but old ones survive at
the old root and are invisible to a sweep that only enumerates `trees/tap/`.

### The refusal case

A tree holding commits reachable from nowhere — no remote branch, no tag, not on `main` — is
potential lost work. **Report it to the LEADER; never reap it; never silently skip it.** A
`scratch/`-prefixed branch reads as disposable and may hold ten commits of unlanded feature work;
do not let a naming convention stand in for a reachability check.

### The sweeper backstop

Self-GC will be missed — by crashed seats, by compacted seats, by seats that moved on. A sweeper
catches the residue. The sweeper enumerates both `trees/tap/` and the old `trees/` root (until the
nesting migration is complete), checks each tree against the predicates above, reaps the safe ones,
and reports the refusal cases to a human. It never reaps a tree holding unique commits. If you
design a sweeper, the refusal case is the bar — **the sweeper's value is in what it refuses to reap,
not what it reaps.**
