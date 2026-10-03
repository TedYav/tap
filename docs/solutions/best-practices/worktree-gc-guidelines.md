---
title: A worktree is reclaimed only after completion, and a failed query keeps it
date: 2026-07-28
updated: 2026-10-01
category: docs/solutions/best-practices
module: runtime/bun/src/verbs/worktree.ts
problem_type: practice
component: worktree-lifecycle
severity: medium
tags:
  - worktree
  - completion-evidence
applies_when:
  - "Deciding whether a worktree may be removed"
  - "A hand-rolled check is about to stand in for tap worktree check"
  - "A detached review tree has to be reclaimed after its branch is gone"
---

# A worktree is reclaimed only after completion, and a failed query keeps it

Accumulation is expected. A burst of disposable review trees is the failure.
After a PR merges, or an ephemeral tree has served its one run, reap that
tree as part of the same motion. Ask the checker. It never removes anything.

```bash
tap worktree check <path> && git worktree remove <path>
```

Every path `reclaim` exits 0. Any other verdict exits 2. A usage error exits 1.
The caller is who removes the tree. `reclaim` from `check` licenses that
checkout removal and nothing else. It does not license `git branch -D`.

## Branch deletion is a separate question

`tap worktree branch <path>` carries completion below, then a narrower
preservation rule: a corroborated merged or closed PR, and the PR's head
commit contains the branch tip, or the content is already on `origin/main`.
A local remote-tracking ref does not count. Its `reclaim` names the branch and
the commit that was checked. Ask it while the checkout still exists, remove
the checkout only when `check` says reclaim, then delete that commit with
`git update-ref -d refs/heads/<branch> <oid>`. If the branch has moved, the
delete fails and the new tip stays. `git branch -D` is not the license.
`main`, `master`, and the remote default branch refuse. A keep leaves the branch, including when the
checkout is later removed. A detached HEAD refuses: there is no branch to
delete, and a ref that merely contains that HEAD is not a deletion target.
Other verdicts leave the branch field empty.

```bash
tap worktree branch <path>
tap worktree check <path> && git worktree remove <path>
git update-ref -d refs/heads/<branch> <oid>
```

## What is not completion

A quiet diff, nothing ahead of the base, and identical content answer whether
anything would be lost. They do not answer whether the work is done. A new
lane with no commits satisfies all three and can still be mid-work.

A squash merge writes a new commit. The branch tip is not an ancestor of that
commit, so an ancestry test reports every squash-merged branch as unmerged
and reaps nothing. The merge commit is an equality check only. It does not
contain the branch tip.

## The order the checker uses

`runtime/bun/src/verbs/worktree.ts` asks these in order. After the first
probe, a failed query is `keep`. It is never read as an empty success.

1. Identity. A missing path, a path that is not a worktree top level, the
   primary checkout, an enrolled team root, an old-format acting registry, or
   a registered seat's checkout is `refuse`. The first probe, whether the
   path is inside a worktree, also refuses when it does not run. An unreadable
   index or an unresolvable git dir is `keep`.
2. State. Locked or dirty is `hold`. A status or lock query that does not run
   is `keep`. This runs before completion is asked.
3. Completion. No evidence is `keep`. A detached tree whose HEAD a ref
   already contains is the exception, and it reclaims before this step.
4. Preservation, and only after completion. For checkout removal, commits on
   a remote, or a quiet diff against `origin/main`, is `reclaim`. A diff that
   shows a difference is `keep`. A comparison that does not run is `keep`.
   Branch deletion does not use a remote-tracking ref. It reclaims when the
   PR's head commit contains the branch tip, or the content is already on
   `origin/main`. A tip with commits beyond that head stays `keep`.

Occupancy is not a softer form of completion. A merged PR does not say the
directory is empty of a seat.

## Branch-backed trees

Look up the PR by the branch the tree holds. A merged or closed row counts
only when HEAD equals the PR head or the merge commit, or the PR head contains
the branch tip. A tip ahead of that head, or a missing head, is `keep`, and
fetching does not change either. A head object that is not local is `keep`;
fetch and ask again. Do not remove on the row
alone: a reused branch name resolves to the older merged PR while the tree
holds new work.

## Detached trees

If a local or remote-tracking ref already contains HEAD, the tree holds
nothing that ref does not, and the verdict is `reclaim`. That containment is
the loss bound. It is not an identification. This is the one reclaim that
does not wait for completion evidence. A detached tree has no branch to hold
live work. A commit made in it would leave HEAD contained by no ref, which is
`keep`, and an uncommitted edit is `hold`. For a clean detached tree that a
ref contains, nothing can be lost.

If no ref contains HEAD, a directory name of letters, then digits, then
optional letters is only a candidate PR number. It counts when HEAD equals
that PR's merge commit, head, or a listed commit. Anything else is `keep`,
including a HEAD the PR no longer lists. Shared history cannot identify: the
merge base of a fresh tree satisfies a reachability test and would reclaim a
tree that was never used.

The two corroborations stay different. A branch can be contained by the PR
head. A name-derived candidate needs an exact commit. One rule for both
either cries wolf on branches or reclaims fresh trees.

## What the sweeper must refuse

Report a tree whose commits are on no ref and match no PR. Do not reap it and
do not skip it silently. The checker's value is the tree it keeps.

A whole-tree quiet diff against `origin/main` stops matching as soon as main
moves, so the squash catch is narrow. Record which PR a detached tree belongs
to at creation if a later rebase would otherwise leave its HEAD unlistable.
