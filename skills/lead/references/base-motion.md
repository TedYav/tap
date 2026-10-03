# Base motion — driver-owned updates

The driver fetches, rebases, retargets and resolves in-scope conflicts when the lane needs a new base. Report the move; routine base motion needs no leader clearance. Coordinate with active writers before changing a shared checkout, and escalate unresolved semantic disputes or a scope change.

1. Fetch `origin`; record the old head, old base and target base.
2. Choose the replay range. For a merge-free stack, use `git rebase --onto origin/<target> <last-base-commit>`. If the range contains merges, preserve their intended topology with an appropriate merge or rebase strategy.
3. Resolve conflicts from source and the affected contracts; record each resolution and run focused controls for it.
4. Publish with `--force-with-lease` when rewriting a published branch; inspect an unexpected lease failure before retrying. Retarget the PR with `gh pr edit <pr> --base <target>`.
5. Post the replay identity, PR-owned blob comparison, base impact and conflicts required by AGENTS.md. Byte-identical reviews carry only when that identity succeeds. Obtain the CI full receipt at the final merge head.

Retarget dependents before deleting their base branch: deletion can auto-close stacked PRs on GitHub. Preserve the old base tip until every dependent is retargeted. `gh pr merge --delete-branch` also removes the local bookkeeping ref, so defer deletion while it is needed.

For deeper stacks, `git rebase --update-refs` can move the intermediate branches. Check their custody first: Git excludes branches checked out in other worktrees. Record their resulting refs rather than assuming the whole chain moved. A branch’s upstream may name its base for useful ahead/behind and fork-point behavior.
