# Worktrees and handoffs

Details for [/tap](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Shared-worktree floor

**Floor — shared worktrees.** Multiple writers may share one worktree and parallel writes are
optimistic. Where a writer token IS in force, its scope has exactly one
editor at a time and the token transfers explicitly in a TAP message body — never inferred from a path
claim, an open editor, or a recent commit. A lane may hold several concurrently, one per scope. A held
token is a coordination record, not a safety boundary; see the disjointness caveat above.

**Announce tree-global operations before running them.** `git stash`/`checkout`, a broad regenerating
tool glob, and the test suite act on the whole tree, so no path scope protects a peer from them —
these are the operations that have actually collided. Suspect thrashing and escalate to the leader
rather than working around it silently. The canonical Writer Token definition is in `CONCEPTS.md`.

Avoid concurrent verification jobs that mutate the same checkout. Use isolated focused runners
locally and CI for the full gate. The DRIVER's leased-commit and `.beads`
boundaries are documented in `/tap:drive`. Coordinating reviews so readers and editors do not clobber
each other — the technique menu, and the signals that a round needs more coordination — is
`/tap:choreography`.

## Cross-tree handoff floor

**Floor — cross-tree handoffs.** A receiver needs copied artifacts in its own lane, not pointers into
the sender's tree. Source trees may rebase or be reaped independently, and `tmp/` plus unmerged-branch
files are not visible from another checkout. Handoff content therefore lives in a durable file; the
TAP message supplies a pointer and summary. Session-only context is captured to disk before transfer.

This prevents the risk that a source tree rebases or disappears before the receiver can retrieve its
artifact or reconstruct its context. Durable copies make that loss observable before work begins.

## Lane Scope (pointer)

Record each DRIVER's scope and ownership transfers explicitly in TAP work orders.
Ask the current owner or LEADER before crossing that scope. A DRIVER may hold
several scopes; none partitions the index, generated files, tests or Git state.
The `tap lane` CLI is retired. Keep existing `lanes.json` and ledger records as
historical evidence; they no longer determine active custody.
