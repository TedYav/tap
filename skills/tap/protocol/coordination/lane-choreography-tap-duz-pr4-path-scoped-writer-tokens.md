# Lane choreography (tap-duz PR4 — path-scoped writer tokens)

> Retired 2026-09-20: the `tap lane` CLI and scope-fold implementation were removed.
> Record active custody in explicit TAP work orders; see
> [worktrees and handoffs](../../../tap/references/worktrees-and-handoffs.md).
> The source below describes historical records only. Keep existing `lanes.json`
> and ledger evidence; no live-state conversion or deletion is required.

<!-- tap-source id=source-0134 start=860421 end=868430 sha256=a496bfed126f1ec7407974a9322573cc54d39fcd93f801cd0d6c6a0e4c1865d1 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Lane choreography (tap-duz PR4 — path-scoped writer tokens)

Path-scoped lane ownership over the existing collaboration ledger. The lead choreographs multiple concurrent drivers over disjoint path scopes; conflicts move from merge-time (discovered, late) to negotiation-time (prevented, early). One writer token per DRIVER over a lane (glob path scope), not per worktree.

### State homes

```
.tap/bus/lanes.json                                    # immutable run-open assignment/manifest
.tap/bus/collab/threads/<run-id>/ledger.ndjson         # append-only post-open negotiation state (§Collaboration ledger)
```

`lanes.json` is immutable run-open assignment state. The ledger (PR3) is append-only post-open negotiation state. `who` and `check` validate both and fold ledger events on every read. There is no mutable grant map, expiry sweeper, reconciliation daemon, or second run manifest.

### Immutable lanes.json

```json
{
  "schema_version": 1,
  "run_id": "example-run",
  "created_by": "lead",
  "created_at": "2026-07-18T10:31:06Z",
  "lead": "lead",
  "integration_branch": "run/example-run",
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "drivers": {
    "lead": {
      "branch": "run/example-run",
      "worktree": ".tap/.trees/lead",
      "scopes": [
        {"kind": "prefix", "path": "docs/"},
        {"kind": "exact", "path": "CONCEPTS.md"}
      ]
    }
  }
}
```

Rules:
- All paths are repo-relative and normalized. Reject absolute paths, `..`, empty components, NULs.
- Prefixes are directory-component prefixes (not arbitrary globs). Exact entries are explicit overrides.
- Exact match wins; otherwise the longest component prefix wins.
- The run-open validator rejects equally specific different-owner base assignments. Readers fail loud on ambiguity.
- No match means effective owner = lead (`source=unowned_to_lead`). There is no `shared/**` namespace.

### Ledger events with lane payloads

Lane requests and grants are ledger events (§Collaboration ledger) with an additional `lane` payload:

```json
{"seq": 17, "event": "add", ..., "status": "proposed", "evidence_class": "judgment", "source_msg_id": "req-001",
 "lane": {"op": "request", "requester": "driver", "owner": "lead", "scope": {"kind": "prefix", "path": "skills/tap/scripts/smoke/"}, "requested_ttl_seconds": 1800}}
```

```json
{"seq": 18, "event": "transition", ..., "status": "accepted", "source_msg_id": "grant-001",
 "lane": {"op": "grant", "grantor": "lead", "borrower": "driver", "scope": {"kind": "prefix", "path": "skills/tap/scripts/smoke/"}, "expires_at_epoch": 1784372591}}
```

Refusal uses `status=rejected_with_reason` and `lane.op=refuse`. Lane events are `judgment` class (anti-sycophancy guard exempt). The thread metadata declares `opened_by=<lead>`; only the lead writes the ledger. Peers propose through TAP payloads; the lead folds at checkpoints.

### Grant semantics

- Only the base owner of the requested scope or the lead may grant.
- A borrower cannot re-grant. One-level, non-delegable — grant cycles impossible by construction.
- A grant must be contained within the grantor's base-owned scope. **Read-time enforcement** (availability-safe pattern): the read fold (`resolve_owner` in `lane_state.py`) IGNORES-WITH-LOUD-STDERR-WARNING any grant event that (a) is not contained within its grantor's base scope, (b) crosses a more-specific (or equal-path) other-owner base assignment, or (c) was issued by someone who is neither the effective base owner of that scope nor the lead. The warning names the offending seq. This is true at `who`/`check`, not only at the thin grant verb — the fold honors only the surviving (valid) set. **A crossing grant is dropped IN ITS ENTIRETY** including the parts the grantor legitimately owns — fail-safe against over-granting; a driver handing off part of its lane must grant the exact sub-paths instead.
- `expires_at_epoch <= now` means ignored at read time. No sweeper required.
- Equally specific conflicting live grants = fail loud. **At equal specificity, a grant overrides base** (same or different owner) — the natural "borrow my whole lane" case. Fail-loud ambiguity applies only to ≥2 distinct grant owners tied, or ≥2 distinct base owners tied.
- Specificity is measured by **component count** (path depth), not `len(path)` — so a trailing slash cannot flip the winner.
- Expired authority is not grandfathered silently at the gate.

### Verbs

```bash
tap lane who <path> [--json]                           # resolve effective owner
tap lane request <path> -m <why> [--for 30m]           # request access (thin: who + structured payload to owner)
tap lane grant <request-payload-id> [--refuse] [--for 30m] -m <why>   # grant or refuse
tap lane check --driver <handle> [--json]               # gate-check stdin paths (exit 0 clean / 2 violations / 1 invalid)
```

`who` validates base + ledger, folds non-expired grants, returns owner + source (base|grant|unowned_to_lead) + scope. `request` refuses without emitting when that fold already returns a live grant; grants are non-delegable, so another request cannot be honored until the grant expires or the ledger changes. Otherwise it emits a `kind=lane-request` payload via `tap send` to the effective owner with `from=requester` and no explicit `reply_to`; TAP's normal reply fallback therefore returns the answer to the requester. The lead folds at the next checkpoint. `grant` emits a structured `tap reply`, which reaches the requester even when the lead issued it. `check` reads newline-delimited paths from stdin — no git logic inside tap.

**Check path semantics:** a malformed path in the stdin stream (absolute, `..`, empty, NUL) is treated as a **violation** (exit 2, safe-blocks the gate) rather than invalid-input (exit 1). This is deliberate: a malformed path in a changed-paths list means the driver is trying to own something unparseable, which is a gate failure, not a config error. Exit 1 is reserved for invalid base/ledger state (corrupt `lanes.json`, unreadable ledger).

There is no automatic escalator. An unanswered request remains visible in `tap outstanding`; lead checkpoint adjudication is the liveness mechanism. Timeout never grants ownership.

### Worktree and merge lifecycle (tap-duz PR5)

**Run open:**

1. Record exact `base_sha`; create the integration branch in `.tap/.trees/<lead>` so the persistent primary checkout remains on `main`.
2. Create each non-lead lane with native `git worktree add -b <lane-branch> .tap/.trees/<handle> <base_sha>`.
3. Add `.trees/` to `.tap/.gitignore`, git-lock the live worktrees, and write their exact branch/path/scope records once into immutable `lanes.json`.
4. Open the collab thread metadata with the lead as the sole ledger writer.

**Driver return:**

1. Driver commits in its worktree and reports base/origin SHA, final tip SHA, verification tier/evidence, and any grant request IDs used.
2. Lead verifies those SHAs from live git before accepting completion.
3. Lead checks the returned diff paths against the driver.
4. Lead merges locally into the integration branch, sequentially.
5. Immediately after each merge, run the agreed verification tier. Record merge SHA, driver tip, first-parent range, and evidence in the ledger before accepting another merge.

**Final gate (integration-history attribution):**

1. For each recorded merge on the integration branch, derive that merge's first-parent path contribution (`merge^1..merge`) from the integration history, then pipe those paths to `tap lane check --driver <that driver>`.
2. Compare the union of recorded merge contributions with `base..integration-tip`; any unmatched side-branch/direct changes are attributed to and checked as lead changes.
3. Run a final global fold for ambiguity/expired grants and verify every changed path has exactly one effective owner.
4. Run the integrated full quality gate.
5. Open one integration PR and apply the normal heterogeneous review ladder. Never open per-lane PRs.

**Close:**

- Only after the integrated result is safely represented, unlock/remove lane worktrees and prune native worktree metadata.
- Doctor reports dirty, unmerged, missing-map, or orphan `.tap/.trees/<handle>` paths; it never auto-removes them.
- No second cleanup manifest: `lanes.json` already records every authorized worktree path.
