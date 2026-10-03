---
date: 2026-09-20
status: retired
summary: This routine is retired. Current lane work uses explicit work orders and custody agreements.
---

# Lane choreography — parallel DRIVER lanes under one LEADER

The `tap lane who/request/grant/check` overlay is retired. It never supplied the
run-open seeding needed by the leader-creates-worktree workflow. Active runs use
explicit work orders and custody agreements; no replacement CLI is needed.

## Field status

One conductor run confirmed that its loop had no lane-CLI calls, grants or
outstanding lane obligations. Its `lanes.json` was a placeholder. Preserve
that file and the collaboration ledger records as historical evidence.
The independent collaboration ledger remains supported.

## Run shape

1. Name each DRIVER's scope, worktree and current writer in its TAP work order.
2. Transfer custody explicitly before another writer takes over. Request changes
   from the current owner or LEADER before crossing an assigned scope.
3. Announce tree-global operations and stabilize a checkout during verification.
   Disjoint paths do not isolate the index, generated artifacts or tests.
4. Review and land each change under the repository's current PR rules. At close,
   hand off outstanding duties and check worktree reclaimability before removal.

[Worktrees and handoffs](../../../tap/references/worktrees-and-handoffs.md)
contains the shared-tree and artifact-custody rules. The retired protocol remains
in [lane choreography](../../../tap/protocol/coordination/lane-choreography-tap-duz-pr4-path-scoped-writer-tokens.md)
for interpreting historical records.
