# Custody

Details for the [drive skill](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Scope

You are the **DRIVER**: own the assigned lane through implementation, review, base updates, merge and closeout. Use AGENTS.md’s staffing defaults and Contributing rules. The leader owns mission design and unresolved cross-lane decisions; routine moves are yours. A solo lane needs no separate dispatcher. You may drive several isolated lanes when you can keep their work and evidence attributable.

## Writer-token custody (within the lane)

**Technique: the passable writer token.** Multiple writers may share one tree, and how to scope and
schedule that is yours to decide — weigh attributable gate evidence against
interactivity and speed, and don't bottleneck for exclusivity the work does not need. The writer token
is a technique you reach for when a stretch of work needs to stay legible — passed explicitly in a TAP
message, it turns "who changed this?" from an investigation into a lookup. A DRIVER may hold several
concurrently. Reach for it when scopes overlap or when thrashing is suspected. Do NOT treat declared
file-disjointness as a safety boundary — regenerated files cross-cut any glob claim, and a semantic
collision between disjoint files is reported CLEAN by git.

**The story that earned it.** Two lanes once claimed disjoint paths, then both regenerated the same
generated index file through a broad tool glob. The collision was reversible; the harder failure was an
unattributable gate result: did the evaluation pass because of, or despite, the other commit? The
token protects invariants under verification, not merely files.

Two DRIVERS on genuinely unrelated scopes may decide the token costs more than its coordination buys.
That judgment is available only with its failure signature and recovery moves visible:

- **Failure signatures:** unexplained diffs in an untouched file, a generated artifact flapping
  between commits, or a gate result that cannot be attributed to the lane's pinned HEAD.
- **Recovery moves:** roll back the clobber; split the work into worktrees; or mint a deliberate
  named-resource lease for the contended resource. Slow work staged outside the tree makes the
  stricter token nearly free.
- **Tools:** an explicit TAP pass/reclaim message; `git worktree add` and `git worktree lock`.
  The canonical Writer Token
  definition remains in `CONCEPTS.md`; `tap help skill tap` resolves the all-seat floor.

**Protect the checkout a check reads.** Pause concurrent writes to a mutable tree while producing evidence from it. A CI run pinned to an immutable commit uses its own checkout, so authoring can continue locally. Publish the tested head and tree. Pass or release a writer token explicitly when its protected work ends.

## Leased commits

- **Evidence contract:** stage only `git add <your unit's paths>`, never `-A`; one why-focused commit
  represents one unit. A broad stage can silently include another writer's change and poison the gate
  evidence that follows.
- Use isolated focused runners locally; avoid concurrent jobs that mutate the same checkout. Request the CI full gate on the candidate head; independent reviewers inspect its receipt.
- **Authority boundary:** never commit `.beads/` from a lane. The tracker is primary-worktree state;
  parallel lane commits race that shared authority and make its history untrustworthy.

## Stacking + `--update-refs` discipline

- **Stacks should follow real dependencies.** Work consuming an unmerged base benefits from stacking:
  its PR then shows only the lane's change. Independent work is clearer from `main` in its own lane;
  stacking it merely for tidiness obscures review and base motion. Choose the depth needed by the real dependency, and record each base before moving it.
- For deeper stacks, `git rebase --update-refs` can move intermediate branches. Check custody
  and resulting refs: Git excludes branches checked out in another worktree.

## Worktree lock

While your lane is live, `git worktree lock <path> --reason "<you> holds the writer token"` makes the
lease mechanical (no sweep reaps a live lane); unlock when the token returns. Parallel lanes contend
on `.git` internals — serialize `git worktree add`, and treat a failed git write
(`index.lock`/`config.lock`) as retry-with-backoff, not an error.

## Lane Scope (pointer)

Record each DRIVER's scope and ownership transfers explicitly in TAP work orders.
Ask the current owner or LEADER before crossing that scope. A DRIVER may hold
several scopes; none partitions the index, generated files, tests or Git state.
The `tap lane` CLI is retired. Keep existing `lanes.json` and ledger records as
historical evidence; they no longer determine active custody.
