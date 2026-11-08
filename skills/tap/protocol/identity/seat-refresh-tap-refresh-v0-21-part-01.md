# Seat refresh (`tap refresh`) (v0.21) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0053 start=334971 end=343187 sha256=f7e8f8774fe78b9a7f2ed236d9e284fb1ca037b575c53ad89e9082e991a0a6a9 fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Seat refresh (`tap refresh`) (v0.21)

`tap refresh [<seat>] [--fresh [--force]]` refreshes a peer through the existing
`tap clear` process replacement, rebind and obligation recap. `--fresh` keeps its
retirement lifecycle and checks. Self refresh lacks a handoff input and refuses before reset; use `/tap:self rebrief`.

**One self engine.** `tap self rebrief --handoff FILE [--charter FILE]
[--notify SEAT]` replaces the conversation while preserving the TAP instance and
obligations. `tap self clear` is its deprecated alias: the handoff form runs the
same engine and prints a migration line, while the bare form refuses. Reports name the invoked verb. The shared `armSelfRecovery` requires a readable,
nonempty regular handoff, including direct refresh calls. The CLI copies
supplied sources durably before arming and never invents a summary or role.

**Arming is not proof.** Rebrief/clear return 8 (armed, reset unverified). The
reserved refresh translation remains 9; current self refresh refuses before
arming. Neither initiating return authorizes instance retirement. A requester
changing workstreams uses peer clear with an assignment, peer refresh `--fresh`,
or a new seat. The native observer waits for idle, submits bare clear once, then
requires a changed native session id and matching transcript on the same pane
and TAP instance. Claude Code and Codex support this witness; unsupported or
unbound seats refuse. Codex may use the post-input witness below.
Reset effects recheck the captured native session as well as the seat binding.
Idle waiting and post-submit observation each have a full bounded timeout.

The skill authors a charter (role, exact skill/priming invocation, modes with levels, experts and preferences, with restoring invocations) and handoff (Keep
scope, operator words verbatim, constraints, obligations, custody, live scheduler
ids, decision reasons, source pointers, Next step). Unavailable essential priming or a missing
first-action path (no fallback) fails preparation.
Narrowing scope never silently retires an owned obligation: transfer it or keep a
one-line pointer. History stays retrievable, not mandatory.

Recovery reads the whole brief, including holds and live scheduler ids, before
loading named role skills as guidance without replaying initialization. It then
reconciles live state and obligations and follows Next step: ordered, consistent,
a wait naming its resume condition.
Outstanding obligations stay recorded.

Optional `--notify` names an outcome audience, not a supervisor or recovery owner;
it transfers no obligation. An explicit invalid, self or inactive recipient refuses
before effects. Omission never infers a bystander: the resumed seat reports its
brief path, restored role and next action in its own conversation. Only that seat
reports successful reading; the worker sends no second success notice. On failure,
the worker sends a best-effort notice only to explicit notify, naming the receipt,
preserved brief and next safe action. The notice's result has its own
`<receipt>.notify.json`; failure never rewrites or replays the reset outcome.
Without notify, asynchronous failure exists only in the durable receipt and log.
Timeout keeps
the brief and never repeats a possible reset. Request, receipt and log remain
beside the durable handoff.
Codex's rollout can bind lazily on first input. Before reset submission, the
observer binds the old native thread to its logging pid/start time,
full logging process UUID and maximum log id in that seat's `logs_2.sqlite`.
Only one thread first logged after that boundary by the same process, with
a regular native writer lock held, can bootstrap authored recovery.
The observer takes the existing native coordination lock nonblocking, opens the
existing writer file without following symlinks, and accepts only a strict
`WouldBlock` result. It releases both descriptors on every path and never
creates, removes or truncates these files. A stale regular file is not a witness.
Each distinct candidate is probed once per observation. Unknown state on any
candidate leaves the whole set pending; it cannot remove an ambiguous candidate.
Lockless auxiliary threads and ambiguous locked candidates do not authorize it.
The process and old registry session are rechecked at placement. The receipt
retains the log boundary, process identity, witnessed thread, first log timestamp
and `would-block` lock observation;
the lock itself may disappear when the process exits.
The pre-delivery witness is `none`, `native-id-changed`, or `codex-thread-start`.
Codex then requires the witnessed native id and matching transcript whose first
substantive input is that authored recovery. A different native id or first input
records `delivery-miss` and asks
the continuing owner to forward the brief. If unrelated first input is already
visible before recovery placement, refuse that placement immediately. Recipient
read remains a separate report; acceptance never claims it. Codex submits the exact staged reset command
at most once, including its matching autocomplete row. Uncertain submission is
observed without repeating Enter; timeout remains incomplete.
The native thread witness is verified on Codex 0.163.0 in TAP's `--no-daemon`
launch mode. The logging pid must equal or descend from the pane pid within
the existing 64-step ancestry bound; native children of Node launchers qualify.
A missing/incompatible log store, disabled SQLite logging, pruned
old-thread rows or an unobservable foreground process cannot authorize reset.
Transient read contention leaves observation pending within the existing
timeout. More than 512 matching post-boundary rows cannot authorize recovery.
Before bootstrap placement, the witnessed thread's rollout must be absent in
the first log timestamp's UTC date and adjacent date directories (covering native
local dates), with a 10,000-entry limit per directory. Existing rollouts, read
errors or exceeded limits wait for native binding without placing recovery.
Lock contention and rollout absence are rechecked inside placement authorization.
Transient bootstrap refusals from that pre-publication, pre-effect check remain
pending within the deadline. A possible send effect never licenses repetition.
Unrelated input can still race those checks and keystrokes; the mandatory
post-input proof detects that race as `delivery-miss`.
Missing post-reset evidence preserves the brief; terminal
headers and context percentages are not a fallback witness.
Its native recovery and outcome-notification sends leave unrelated legacy spool
records untouched; that backlog cannot force recovery through a shell fallback.
The ordinary sender/recipient identity and reset-fence checks still apply.

Rebrief must not be composed with --fresh. It is an explicit
continuing-role workflow, not an automatic schedule or a proven improvement over native compaction. Peer rebrief
and authored-handoff refresh flags are not advertised.

**`--fresh` retires the current instance before rebinding**, composing the same tombstone machinery `tap out` uses: the instance row lands under `team-history/`, **payload files never move** (retirement is a pointer, not a sweep — the audit trail is what makes a refresh recoverable), and `tap in <handle> --restore <instance>` remains possible. This is deliberately NOT `tap in --fresh`, which refuses for a live seat and stays an intentional-retirement door (§U3): overloading it would make one flag mean "rejoin a retired seat" in one state and "retire a live seat" in another — inert in the first case, destructive in the second.

**Resolve the seat before retiring its instance.** Clear resolves the row, and
forced notices are sent as the active seat. Order: refuse or proceed under the
lock → clear with the row intact → retire → notify. Failed clear leaves the
original instance, no tombstone and no notice. “Verified” means the engine's
exit 0; only that permits retirement. Self reset cannot supply that proof at
return and never returns 0.


**Retirement is a MINT IN PLACE, not a deletion.** The row survives and its `instance` is replaced, with the old instance tombstoned. Obligations are bound to `(handle, instance)`, not to row existence, so a new instance is exactly what `--fresh` means; deleting the row is a strictly stronger action whose extra strength breaks the verb — the delegated clear cannot resolve a row that is gone, and at re-register time an absent row makes `prior_existing` false, which suppresses the very rebind recap a refresh exists to deliver. No consumer of row-absence requires the row to disappear; launcher fork-protection, teardown refusals, and watch/goalie liveness all read it as "this seat exists", which after a refresh is true.

**The obligation scan is atomic with the mint**, both inside one registry lock. This is stronger than re-reading before mutating: the bus cannot be frozen, so any newly placed payload that the scan does not see was written *after* the new instance existed — it carries the successor instance rather than being orphaned.

**Parked spool sends are obligations too.** `tap outstanding` counts them, so both the preflight and retirement-boundary guards do the same. A courier may move one payload `spool -> canonical -> spool` while the registry lock is held, so no finite ordering of payload-directory snapshots is sufficient. The shared scanner instead enumerates each `*.meta.json` sidecar, which survives promotion and failure demotion, and unions those ids with present spool `*.md` ids. The latter union is load-bearing: digest redelivery removes meta after a best-effort move, so a failed move can leave a still-parked payload without its sidecar. A sidecar whose payload cannot be classified in either residency fails closed (`error_class=spool_scan_unstable`): at preflight this is exit **3**, nothing changed, retry after the courier move; at the retirement boundary the clear already completed, so identity is retained and the verb exits **7**. Successful redelivery leaves canonical stable before removing meta, and a final canonical pass sees it. Nothing can be retired past silently because residency changes cannot erase the obligation identity.

**That in-lock scan also RE-DECIDES, it does not merely report.** Mail that lands between the preflight and the retirement lock refuses retirement again (`error_class=unsettled_obligations_at_retirement`, exit 7) unless `--force` was passed. A boundary scan that only collected the late ids would make the preflight refusal advisory — every payload arriving during the clear would be minted past without `--force`, and its sender would then be told a live request had been orphaned by a command that never asked to orphan anything.

**`tap refresh` OWNS ITS EXIT SURFACE; the engine's codes do not leak through it (tap-utpn).** Both verbs use **7**, for different partial states: `tap clear`'s 7 is *the process was replaced and its return was not confirmed*, refresh's 7 is *the clear completed and the RETIREMENT was refused*. Opposite next steps behind one number, so refresh **translates**: an engine 7 surfaces as refresh **8** — *the mechanism replaced the process and could not confirm it came back* — and its message says the seat WAS cleared, because the branch beside it reports the seat UNCHANGED and that would be false in the most expensive direction, sending an operator away from a pane that needs looking at. Retirement is still skipped there: an unconfirmed return is not a verified clear. Codes refresh has **not** claimed pass through unchanged, which is what keeps "anything else is the underlying verb passed through" true — notably the engine's **2** (`clear_in_progress`, nothing changed). A mechanism code leaking through a policy surface is the same defect as a mechanism name leaking through an API, and the whole premise of the delegation is that the mechanism is swappable underneath.
