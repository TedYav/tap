---
name: drive
description: "When driving a lane under a leader, own tree custody, writer tokens, commits, gates, and closeout."
argument-hint: '[plan-path]'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write'
---

# Drive — own the lane through closeout

Own the assigned lane through implementation, review, base updates, merge and
cleanup. The leader owns mission design and unresolved cross-lane decisions;
routine moves are yours. A solo lane needs no separate dispatcher. You may drive
several isolated lanes while keeping their work and evidence attributable.
Follow the working repository's `AGENTS.md`
for staffing, risk tiers, review, CI and merge policy. Run `tap help skill tap`
and read the returned file for all-seat liveness and recipient rules.

## Keep custody attributable

- Multiple writers may share a tree. Choose isolation and custody for the work;
  declared-disjoint paths do not partition Git state, generated files or tests.
- Where a writer token applies, keep one editor in its scope and transfer it
  explicitly. A token is a coordination record, not a safety boundary.
- Pause concurrent writes while a check reads the mutable checkout. CI tests
  an immutable commit and does not freeze authoring. Publish tested HEAD/TREE.
- Announce tree-global operations to active writers. Escalate thrashing,
  unexpected diffs or unattributable checks; re-scope, serialize or isolate.
- Stage only `git add <your unit's paths>`, never `-A`. Use one why-focused
  commit per unit. Never commit `.beads/` from a lane; primary owns tracker state.
- Use focused isolated checks during implementation and CI for the candidate
  gate. Avoid concurrent jobs that mutate the same checkout.
- Lock a live worktree with `git worktree lock <path> --reason "<you> holds the writer token"`;
  unlock when custody returns. Serialize worktree creation; a Git lock failure
  calls for retry with backoff, not an override.

Read [custody details](references/custody.md) when arranging shared writers,
named-resource leases or a stack. Stacks follow real dependencies; record each
base before moving it. `git rebase --update-refs` excludes branches checked out
in other worktrees, so check their custody and resulting refs. Record scope and
writer transfers explicitly in TAP work orders.

## Execute, report and take the next unit

Start a bounded task directly. Plan first for a new role, new subsystem or
one-way door. Choose implementation, rebases and sequencing within the goal;
coordinate shared-tree changes and preserve other lanes' intent. Escalate scope
changes, incidents, unresolved semantic disputes, human decisions and one-way
doors under AGENTS.md. Confirm a launched seat's identity and use team-qualified
addresses across worktrees; reconnect only when unregistered.

Dispatch lane work and review requests, receive their replies, and own the gate
evidence. Read [lifecycle details](references/lifecycle.md) when arranging a
wave, fan-out, succession or a blocked handoff. The repository's contribution
policy is the authority for merge readiness; do not duplicate or weaken it here.

When ready, squash, sync the persistent primary, report installed provenance
and release custody. Send one line per pushed head with PR, head and scope;
closeout includes the CI receipt, review/thread census and merge/sync result.
Preserve work before abandonment; unique evidence needs escalation before deletion.

Successors are announce-and-go within the published lane queue: take the oldest
ready in-scope item whose work class, build constraint and partner availability
fit the charter. Mark a ticket in progress from primary; send the reporting seat
one note naming the item and branch, then start. The leader may veto, but routine
queue succession needs no new grant. When blocked, inspect the actual dependency;
one progress reply is enough. Nudge a confirmed missed wake once without
resending its tracked request, then escalate the needed decision and continue
independent work. If no item is ready, report the dependency.

## Reap completed work

After a PR merges or an ephemeral review tree serves its purpose, reclaim your
own completed checkout. First use the checker:

```bash
tap worktree check <path>
```

Remove the checkout only after **reclaim**. That licenses `git worktree remove`
and nothing else. **keep** means completion or preservation is not
established; **hold** means dirty/locked state; **refuse** excludes primary,
enrolled roots and registered-seat working directories. Do not bypass a refusal.
An enrolled root's seats are stopped and the team de-enrolled first
(`tap team shutdown <team>`, as the refusal names), then checked again.
Read [worktree GC details](references/worktree-gc.md) for ambiguous provenance,
squash/reachability cases, abandonment or sweeper work.

A reclaimable tree is clean and unlocked, with completion and preservation
established. A pushed branch alone does not prove the work ended. A matching name
alone does not identify its PR. Squash merges can orphan commits; a failed
reachability check is not proof of loss. The checker owns these distinctions.

Ask branch deletion while the checkout still exists. **reclaim** names the
branch and the commit that was checked. Delete that commit only after the
checkout is gone, with `git update-ref -d refs/heads/<branch> <oid>`. If the
branch has moved, the delete fails and the new tip stays. It requires a
corroborated merged or closed PR, and the PR's head commit contains the
branch tip, or the content is already on `origin/main`. A local
remote-tracking ref does not count. **keep** leaves the branch. `main`,
`master`, and the remote default branch are **refuse**. A detached HEAD is **refuse**: no branch to delete.
Do not infer branch deletion from `tap worktree check`. `git branch -D` is
not the license.

```bash
tap worktree branch <path>
tap worktree check <path> && git worktree remove <path>
git update-ref -d refs/heads/<branch> <oid>
```

Preserve unrelated work. If removal refuses, find out why before forcing; if unique work cannot be
proved preserved, report it to the leader and retain the tree.
