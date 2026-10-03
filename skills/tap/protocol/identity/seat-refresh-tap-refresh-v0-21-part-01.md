# Seat refresh (`tap refresh`) (v0.21) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0053 start=334971 end=343187 sha256=f7e8f8774fe78b9a7f2ed236d9e284fb1ca037b575c53ad89e9082e991a0a6a9 fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Seat refresh (`tap refresh`) (v0.21)

`tap refresh [<seat>] [--fresh [--force]]` clears a seat's context, re-registers it, and lets the rebind recap re-point it at the obligations it inherited. A leader may refresh a **teammate** — the target pays only the injected recap, never the choreography, which is the point for API-rate seats — or a seat may refresh **itself**.

**It is a frontend, not a second implementation.** The peer path delegates to **`tap clear`** (process replacement in the occupied pane, nonce-verified rebind, the fence); the self path calls the same native observer as `/tap:self clear`. Nothing is re-derived: a parallel clear-and-re-register would be two half-specified contracts where one whole one already works. **The delegation is not `exec`** — see the exit surface below.

**The self path arms a detached native observer.** /tap:self clear and experimental
/tap:self rebrief return 8 (armed, reset unverified); tap refresh translates that to
9. The initiating return never authorizes instance retirement. **So
`tap refresh <self> --fresh` can never retire an instance, by construction, not
per run** (Phase C is reached only on engine exit 0, and the self path has none):
it re-briefs this instance, and its exit-9 receipt says re-running will not
change that. The route that can retire it is a peer running `tap refresh <seat>
--fresh` after the pending recovery completes, subject to the same obligation
checks (tap-pfkz). The observer
waits for idle, submits bare clear once, then requires a changed native session
id and matching new transcript on the same pane and TAP instance. Codex may use
the post-input witness below. Only registered
Claude Code and Codex seats with a bound transcript have this witness in the
first slice; unsupported/unbound seats refuse before effects.
Reset effects recheck the captured native session as well as the seat binding.
Idle waiting and post-submit reset observation each have a full bounded timeout.

Rebrief copies the authored handoff and optional charter into the existing durable
handoff directory before any pane effect. A named continuing owner receives
incomplete-recovery diagnostics when transport permits. Recovery is sent only
after native reset observation on Claude; acceptance/queuing is recorded separately from recipient
processing. The resumed seat reads the brief and reports its path and next action
to that owner. A timeout preserves the brief and never repeats a possible reset.
The worker's request, receipt and log remain beside the durable handoff.
Codex's native session can bind lazily on first input. Its observer may bootstrap
the authored recovery only after a positive fresh Codex header, reset context,
old-session clear acknowledgement and painted empty composer on the same bound
pane/instance/epoch. The old native session is rechecked before this placement.
The receipt's pre-delivery witness is `none`, `native-id-changed`, or
`codex-ui-transition`; UI evidence is not native reset proof. Codex then requires
the changed native id and matching transcript whose first substantive input is
that authored recovery. A different first input records `delivery-miss` and asks
the continuing owner to forward the brief. If unrelated first input is already
visible before recovery placement, refuse that placement immediately. Recipient
read remains a separate report; acceptance never claims it. Codex submits the exact staged reset command
at most once, including its matching autocomplete row. Uncertain submission is
observed without repeating Enter; timeout remains incomplete.
Its native recovery and owner-notification sends leave unrelated legacy spool
records untouched; that backlog cannot force recovery through a shell fallback.
The ordinary sender/recipient identity and reset-fence checks still apply.

Rebrief preserves the operational TAP instance and obligations; it must not be
composed with --fresh. It is an experimental continuing-role workflow, not an
automatic schedule or a proven improvement over native compaction. Peer rebrief
and authored-handoff refresh flags are not advertised in this slice.

**`--fresh` retires the current instance before rebinding**, composing the same tombstone machinery `tap out` uses: the instance row lands under `team-history/`, **payload files never move** (retirement is a pointer, not a sweep — the audit trail is what makes a refresh recoverable), and `tap in <handle> --restore <instance>` remains possible. This is deliberately NOT `tap in --fresh`, which refuses for a live seat and stays an intentional-retirement door (§U3): overloading it would make one flag mean "rejoin a retired seat" in one state and "retire a live seat" in another — inert in the first case, destructive in the second.

**THE ORDERING INVARIANT: everything that resolves the seat's registry row happens BEFORE the instance is retired.** The clear delegation resolves the row (`tap clear` refuses an unknown seat), and the `--force` notice is sent *as* the seat (`tap send` requires an active sender), so both must precede retirement. The order is therefore: refuse-or-proceed under the lock → **clear, with the row intact** → retire → notify. A clear that fails leaves the seat completely unchanged — original instance, no tombstone, no notice, nothing to undo — because the destructive step is reached only after a verified clear. **"Verified" here is the engine's exit 0 and nothing else** — that is what makes the code an authorization rather than a report, and why the self path must not return it (see the delegation asymmetry above).

**Retirement is a MINT IN PLACE, not a deletion.** The row survives and its `instance` is replaced, with the old instance tombstoned. Obligations are bound to `(handle, instance)`, not to row existence, so a new instance is exactly what `--fresh` means; deleting the row is a strictly stronger action whose extra strength breaks the verb — the delegated clear cannot resolve a row that is gone, and at re-register time an absent row makes `prior_existing` false, which suppresses the very rebind recap a refresh exists to deliver. No consumer of row-absence requires the row to disappear; launcher fork-protection, teardown refusals, and watch/goalie liveness all read it as "this seat exists", which after a refresh is true.

**The obligation scan is atomic with the mint**, both inside one registry lock. This is stronger than re-reading before mutating: the bus cannot be frozen, so any newly placed payload that the scan does not see was written *after* the new instance existed — it carries the successor instance rather than being orphaned.

**Parked spool sends are obligations too.** `tap outstanding` counts them, so both the preflight and retirement-boundary guards do the same. A courier may move one payload `spool -> canonical -> spool` while the registry lock is held, so no finite ordering of payload-directory snapshots is sufficient. The shared scanner instead enumerates each `*.meta.json` sidecar, which survives promotion and failure demotion, and unions those ids with present spool `*.md` ids. The latter union is load-bearing: digest redelivery removes meta after a best-effort move, so a failed move can leave a still-parked payload without its sidecar. A sidecar whose payload cannot be classified in either residency fails closed (`error_class=spool_scan_unstable`): at preflight this is exit **3**, nothing changed, retry after the courier move; at the retirement boundary the clear already completed, so identity is retained and the verb exits **7**. Successful redelivery leaves canonical stable before removing meta, and a final canonical pass sees it. Nothing can be retired past silently because residency changes cannot erase the obligation identity.

**That in-lock scan also RE-DECIDES, it does not merely report.** Mail that lands between the preflight and the retirement lock refuses retirement again (`error_class=unsettled_obligations_at_retirement`, exit 7) unless `--force` was passed. A boundary scan that only collected the late ids would make the preflight refusal advisory — every payload arriving during the clear would be minted past without `--force`, and its sender would then be told a live request had been orphaned by a command that never asked to orphan anything.

**`tap refresh` OWNS ITS EXIT SURFACE; the engine's codes do not leak through it (tap-utpn).** Both verbs use **7**, for different partial states: `tap clear`'s 7 is *the process was replaced and its return was not confirmed*, refresh's 7 is *the clear completed and the RETIREMENT was refused*. Opposite next steps behind one number, so refresh **translates**: an engine 7 surfaces as refresh **8** — *the mechanism replaced the process and could not confirm it came back* — and its message says the seat WAS cleared, because the branch beside it reports the seat UNCHANGED and that would be false in the most expensive direction, sending an operator away from a pane that needs looking at. Retirement is still skipped there: an unconfirmed return is not a verified clear. Codes refresh has **not** claimed pass through unchanged, which is what keeps "anything else is the underlying verb passed through" true — notably the engine's **2** (`clear_in_progress`, nothing changed). A mechanism code leaking through a policy surface is the same defect as a mechanism name leaking through an API, and the whole premise of the delegation is that the mechanism is swappable underneath.
