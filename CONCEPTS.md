# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Transport

### Bus
The file-backed message store for one Team: payloads, receipts, and the registry. Worktree-scoped and ephemeral — every liveness question about a team is answerable by reading its bus.

### Payload
One canonical message on a Bus: an Envelope plus a body. Only the Courier writes payloads, atomically, after validation; a payload is addressed to exactly one recipient.

### Envelope
The routing frontmatter of a Payload (sender, recipient, id, kind, path, Reply Expectation, Reply Routing). The Courier owns and stamps its fields; nothing above the transport interprets them.

### Sentinel
The one-line wake token the Courier injects into a recipient's terminal pane. A wake signal, not a record: it must stay minimal, its fields that feed tool calls must execute verbatim from any state, and nobody acts on the sentinel alone — the Payload is the message.

### Courier
The send-side pipeline: canonicalize the payload, resolve the recipient's pane, inject and submit the Sentinel, verify submission. Best-effort low-latency wake; the guarantee lives in the Bus, not the Courier.

### Delivery reliability
The target is 99.9% **recipient-observed** messages: a non-forced read, reply or manual settlement, among placed messages not explicitly cancelled. Submission confirmation is a separate transport fact; it does not prove observation or processing. TAP preserves the message before reporting success and never retries after a possible effect. The forward requirement is recoverable mail and visible unfinished work. A refused send that leaves no pending item or scheduled retry remains a known gap. See the [delivery reliability contract](skills/tap/protocol/delivery/reliability.md) and its [receipt measures](skills/tap/protocol/delivery/receipt-measures.md) for denominators and evidence limits.

### Composer
The recipient harness's active input region, where the Courier writes a Sentinel before submission. Rendering may wrap text, add chrome or collapse a large paste into an opaque chip. A successful write call, elapsed time or a chip alone does not prove that the complete expected text is visible.

### Composer Reader
The shared frame-reading functions used to locate and interpret the Composer. Their callers have distinct jobs: pre-inject draft protection preserves existing input; ordinary Sentinel Enter authorization checks for complete visible expected text; exact controls retain whole-input matching; post-Enter verification requires a positive transition.

The ordinary submit predicate is shared by native courier, Bash verification and nudge when its selected mode permits pane effects. Unknown footer rows, extra text and a missing bottom border do not veto a complete visible Sentinel. An apparent active dialog defers to affirmative current harness liveness, but neither liveness nor a chip supplies missing text. Keep the captured-frame controls and the post-Enter evidence separate: permission to send Enter is not verified submission. See `runtime/bun/src/submit-frame.ts` and the ordinary sentinel rule in `skills/tap/scripts/CONTRACT.md`.

### Probe Span
The reported interval from a witness Parked Send's parking time to its last recorded busy observation, paired with that witness's probe count. Parking time is not a first-probe timestamp. Queue age is a separate quantity: the age of the oldest queued entry for that recipient.

Both quantities describe history. The probe count and interval must come from the same witness payload; oldest queue age may come from a different payload and must be labelled separately. A span establishes neither continuous observation, an unchanged Composer nor its current state. Missing or inconsistent time inputs leave the interval unknown, and queue history alone does not authorize pane input.

### Residency
Which of the Bus's holding locations a Payload currently occupies: delivered to its recipient, or parked awaiting redelivery. Residency is not status — a parked Payload is exactly as outstanding as a delivered one, and moving between residencies changes nothing about the obligation it carries.

The Courier migrates payloads between residencies in both directions, promoting a parked Payload when it delivers and returning it when delivery fails. A Payload can therefore be in flight between residencies while something else is looking, so any enumeration that inspects one residency at a time can miss it. An enumeration that gates destructive work must key on an identity that survives the move, or read every residency, and must treat a residency it cannot read as a reason to refuse rather than a reason to proceed.

### Parked Send
A Payload whose recipient was not ready to receive it, held on the Bus for later redelivery rather than failed. The sender believes it sent and the recipient has never seen it, so it remains an unsettled obligation for as long as it waits — a check asking whether a Seat owes anything understates the answer if it reads only delivered payloads.

### Steer vs Queue
Two things a message arriving at a busy Seat can be for. A **steer** lands while the current work is still in flight, so the recipient can change course; it depends on liveness and is what every TAP delivery is. A **queue** is a backlog of next tasks, sequenced behind the work in progress — a user's tool, and on TAP's side the job of beads and the hopper rather than of the transport.

The distinction is about delivery timing, not about whether the keystroke is accepted: a harness that "queues typed input mid-turn" is saying the input is safe to send during a turn, not when the recipient reads it. A harness may offer both — Codex delivers an Entered composer at the next tool-call tick and a Tab-marked one at the end of the turn — and a turn has no upper bound, so routing transport through the queue path converts a steer into an unbounded park while the sender's receipt still reads accepted.

### Settlement
The receipt that marks a Payload handled. Settlement IS the acknowledgment — a message whose only content would be an acknowledgment is never sent, which is what makes handshake termination mechanical rather than judged.

Settlement is terminal and belongs to the Payload, not to whoever handled it: it discharges the sender's obligation permanently, and there is no reopen. The receipt names the settling Seat but not which Principal settled it, so an obligation discharged by the wrong or a since-replaced Principal never resurfaces for its successor — commitments are the Principal's, and when a Seat changes Principal, whatever the old one settled must be re-sent as a new Payload or it is simply lost.

### Effect
Whether a delivery attempt may already have changed the world it was acting on: `none` when the attempt provably did nothing, `possible` when it may have. A property of the attempt rather than of its success — an attempt can report failure and still carry a possible effect, because the failure may have arrived after the change landed.

Only `none` licenses a retry, a fallback, or a redelivery, so an attempt whose effect cannot be established is recorded as `possible` rather than assumed clean. A status code is not a reading of it: one code covering several operations, or an instrument reporting its answer and its own health through a single channel, leaves the effect unwitnessed, and it is then established by an instrument aimed at each operation — before the outcome is classified, never after. Neither is a refusal from the layer above the command: an operator declining a call at a permission prompt gates whether the harness proceeds, and gates nothing the call already did.

### Reply Expectation
The sender-declared obligation stamped on every Payload: a reply is expected, or settlement alone suffices. Recipients follow the stamp — no protocol step requires judgment. A reply's own outbound defaults to settle-only so two rule-following agents can never acknowledgment-loop. Because recipients comply mechanically, a settle-only payload must never carry a directive — its stamp invites zero further action.

### Reply Routing
The sender-declared address that redirects where a Reply lands, independent of Settlement. Lets an ephemeral or rotating Seat — one that may not exist by the time an answer comes back — name a durable Seat to receive replies instead of dead-ending at itself. Re-validated at the moment the reply is actually sent, never trusted from when it was originally declared, because the named Seat's own liveness can change in between. Settlement still discharges the original sender's obligation unchanged; routing only moves where the answer text arrives, never who is credited with having been answered.

### Machine Index
The per-machine registry of Teams and their locations, letting any agent address any enrolled team from anywhere. Observable state maintained by enrollment; a row leaves the index only through a deliberate operator verb — `tap admin refresh` for data-gone teams, `tap admin retire` for live ones, `tap team shutdown` for a stopped team's own lifecycle, `tap doctor --fix` for dangling rows — never automatically on read. Enrolling a name already held by a different location fails loud rather than last-writer-wins.

## Identity

### Team
The namespace a Bus serves — the agents working in one worktree or folder. Team name derives from the folder; addressing within a team uses bare Seat handles, and across teams uses team-qualified handles. Ordinary, launcher-managed, and Crew Seats use the same routing grammar.

Because a bare handle omits the team, its meaning depends on where it was written, not on where it is later read. Such a handle belongs to the team of the verified context that produced it — the resolved target whose pane or record it was found in — never to the ambient team of whoever reads it later, and it is never resolved by searching every team for a matching handle. Where no such context exists, the bare form stays team-local and cross-team use must name the qualified form; an already-qualified handle is authoritative and is never reinterpreted. The one exception is a handle an operator types to `tap attach`: when the current team lacks it, attach looks on every enrolled team and goes ahead only if exactly one holds it and no registry went unread. That is a human choosing a seat to visit; it never rewrites or routes a handle found in a record or payload.

### Seat
The generic team-local routing identity teammates address (the CLI calls it a handle). Every registered row is a Seat for routing, collision, refresh, settlement, and expected-seat receipts. Three lifecycle forms matter: an **ordinary Seat** may be transport-only; a **launcher-managed Seat** adds a stable handle across conversation restarts, a launcher-owned Terminal, and registry-held native resume provenance; a **Crew Seat** is the explicit ephemeral pane-backed subtype defined below. The `tap team` kind column is a display distinction, not a type split: `KIND=SEAT` labels every non-Crew row, ordinary or launcher-managed, and `KIND=CREW` labels the Crew subtype, while Crew rows remain Seats everywhere else. Renaming a Seat mid-run stales every reference to it; rounds are tracked by epoch, not by name.
*Avoid:* handle-with-round-suffix (e.g. a `-r2` name)

### Terminal
The globally-unique multiplexer session a launcher-managed Seat owns — its durable remote-control vessel. Named `team/seat` by derivation at launch (the Seat is chosen first — tag if given, else harness name — and the Terminal's name follows); harness is metadata, never part of the name. Machine-global singletons keep bare unique names. The owning Seat has one Terminal, but that tmux session may also contain ephemeral Crew panes: the live topology is one pane per pane-backed registry member, not one member per session.
tmux is TAP's terminal implementation, not conversation identity; resume uses an explicit registry-held native conversation id when present, otherwise the harness's own picker or latest behavior. A tmux/session name is never a native id.

### Crew
The ephemeral pane-backed Seat subtype, created only by explicit crew registration and rendered by `tap team` as `KIND=CREW`. A Crew Seat lives in its own pane/window inside the caller's tmux session; when that session is launcher-owned, it is the owning Seat's Terminal. Several Crew Seats may therefore share one session while each keeps a distinct pane identity and Bus address. While active it can send, receive, and settle Payloads like any Seat, but it owns no Terminal and has no independent native-resume lifecycle. Its live execution lifetime is its pane/window; ending the shared session ends every Crew pane in it, and explicit unregister or refresh removes the dead registry row.

### Acting Registry
The complete current record of a team's Seats. Launcher-managed rows carry the session name, harness, working directory, model, timestamps, passthrough arguments, and any explicitly captured native conversation id that resume may use. The global registry locates this team-owned file; it does not duplicate the row state. Removing a row removes TAP's current resume authority for that Seat. Departed lineage remains non-authoritative history, and legacy `sessions.json` exists only as explicit migration input.

The recorded native conversation id is **provenance, not identity**: it records which conversation was last observed on a Seat, not proof that the conversation belongs to that Principal — so the id governs what may be *passed* to resume, never *who the Seat is*. Only a launcher-minted or exactly-resumed capture may establish or rotate that recorded id; an unverified picker adoption is held as a Quarantine rather than trusted, precisely because a row that adopted another Seat's conversation would otherwise repeat that mistake on later resumes. The exception is a registration from the pane the row already owns, or for a row whose recorded pane is gone, that observes a different id: it is accepted as a matched update unless another Seat's record already carries that id or a standing launcher expectation names a different one, because a harness can move a live conversation to a new id without any resume.

### Content
The harness-native conversation currently running in a pane-backed Seat. Every Seat binds a routing handle; pane-backed Seats additionally bind a pane identity and Content, while a pane-less poll Seat has neither. A launcher-managed Seat further binds its Terminal, and its Content may change across Clear or relaunch while the Seat persists. Crew Content expires with the pane. These values are never synchronized into one name, because they have different lifetimes.

### Principal
Whose conversation a Content is — the agent identity whose lineage, memory, and prior commitments it carries. Distinct from the Seat (the name teammates address) and the Content (the conversation itself): a Seat can hold a Content belonging to a different Principal, and nothing in the name or the routing looks wrong when it does.

Only the Principal can reliably detect its own mismatch, since it is the sole party holding the context to notice the lineage is not its own — which is why resume should state which Principal it believes it is restoring, and why a Seat that finds itself under an ambiguous Principal discloses before acting, stays read-only, and declines duties that depend on being independent.

### Quarantine
The state of a captured native conversation id that is retained for inspection but refused as identity: written to dedicated quarantine fields with a stated reason and a loud warning, never overwriting the Seat's durable Principal. A capture is quarantined when its provenance is untrustworthy — a picker/latest/adopted resume, a resume whose observed id does not match what the launcher expected, or an id already carried by another Seat's record on the machine.

Quarantine splits its defaults by concern: fail-open for startup, fail-closed for identity. The suspect conversation may still run — registration succeeds — but it cannot silently become the id the next resume trusts. Distinct from a dropped capture (which erases the evidence an operator needs) and from a trusted one (which would poison identity): Quarantine keeps the fact and withholds the trust.

### Refresh
The explicit reconcile gesture: bring registry rows into line with observable reality without creating membership. Ordinary team-scope Refresh deletes observed-gone pane-backed Seats, including Crew. Machine-scope admin Refresh sweeps teams and automatically removes only data-gone index entries; a dormant team with a live root remains an explicit retire candidate. Refresh is never an ambient hook and always fails closed when reality cannot be observed.

### Clear
Replacing a pane-backed Seat's harness *process* inside the pane it already occupies, so it returns with fresh Content while the Seat, its address, and its obligations persist. The pane object is preserved deliberately, because Seat identity is bound to it: re-creating the pane hands the naming decision to the registration hook's collision-avoidance, which mints a suffixed handle before any rebind can run — a live incumbent therefore forks rather than rebinds. Preserving the pane also removes pane identity as evidence that a Clear happened, since it reads the same before, after, and when nothing happened at all; a Clear is confirmed instead by a per-operation freshness stamp that only a registration running after the operation began would carry — an operational witness, never a credential, and never treated as unforgeable. Also the recovery path for a harness that has stopped reading input, with no separate verb for that case. Distinct from Refresh (reconciles rows), from Restart (recreates the Terminal), and from Quarantine.

### Restart
The destructive launcher-session operation: recreate one registry-known Terminal under the same name, killing the incumbent first when one exists. The harness then uses the best available resume path — an exact trusted native id when present, otherwise its picker, latest-continuation, or fresh fallback — so Restart does not promise identical Content or Principal when no exact id exists. It is not a Crew lifecycle operation: Crew owns neither a Terminal nor an independent native-resume record. Restart touches nothing on the Bus — unsettled Payloads stay put and surface at re-registration. Named apart from Refresh and Clear because the three touch different objects: Restart recreates a launcher session, Refresh reconciles rows, and Clear replaces the process inside an existing pane.

### Shell session
A Terminal reduced to a name-only vessel: every pane is a bare login shell with no child processes. It is not current session authority. An *attached* shell session (a human sits in it) or a *busy vessel* (any non-shell, non-harness pane, including a shell with children) is never replaced without asking.

Fidelity ranks resume paths by *how much* is restored, never by how trustworthy the identity is: a recorded id resumes silently, so a wrong one is worse than none — it restores the wrong Principal with a clean receipt, where an absent id falls through to a path that either asks or restores nothing. Latest-continuation is the exception that proves the point: it neither asks nor abstains, and so carries the same wrong-Principal hazard with no one in the loop.

### Reset Fence
The temporary guard placed on a Team's Bus while a team reset is cutting over, refusing ordinary verbs so the cut cannot interleave with normal traffic. Every refusal names one of two next steps: wait while the fence's owner is live, or retry to complete the cut once the owner is proved stale.

Ownership is decided fail-closed by a multi-factor identity check — the recorded owner is treated as live unless its absence is positively proved, because "could not tell" must never license reclaiming a fence somebody still holds. A permission-denied answer from the host is deliberately not proof of life: it proves only that a process occupies the pid, so the check still compares the recorded start fingerprint before ruling. Only positive evidence of absence — no such process, or a fingerprint that disagrees — releases the fence for reclaim.

## Choreography

TAP is a choreography framework that helps agents work in sprints. Its mechanism
is a dumb file bus + tmux courier.

### Sprint
A unit of team work toward a shared goal. Seats carry implementation, review and
integration across lanes, so the scope can grow from one agent's ticket to a
team's sprint. Choreography describes how those agents work together; a sprint
names the unit of work they share.

### Orchestration vs Choreography
The two coordination styles. **Choreography**: autonomous peers
react to events and messages with no central conductor — TAP's transport and team layer is
choreographic by construction (push wakes, peer-to-peer gates, run-dark). **Orchestration**: a
central conductor advances a deterministic plan — harness-native Burst Engines and the
`tap-orchestrate` Run layer are orchestration. Choreography is the load-bearing strength of a good
TAP team over naive orchestration: heterogeneous agents actively improve each other's output
through adversarial peer pressure — implementer/reviewer pairs behave like a GAN's
generator/discriminator, and the fix-wave loop is the training step. An orchestration layer added
above TAP must conduct the schedule without flattening the adversarial choreography that produces
the quality (a conductor that merely fans out and collects would). Refinement:
**orchestration is a SUBSET of choreography** — any single routine execution is plan-then-execute
(orchestral), while the process above it stays choreographic: decide the next routine, conduct it,
reflect, decide again. The leader is delegated to per round; routines are structured, the process
is organic.

The `conductor` role is a seat in that optional orchestration layer, not a central conductor in TAP
core: it advances the leader's setlist while the team and transport remain choreographic.

### Choreography deadlock
The standing risk of a push-only choreography: when the messages stop,
the team grinds to a halt. Because a waking send is the only routine source of a turn — `--ask`, `--wake` or
`--urgent` auto-submits a Sentinel and starts the recipient's turn, while a plain send is held for
the digest — event-driven seats act when poked and yield when quiet;
so when the bus goes silent with work still remaining, every seat reads the silence as "nothing to
do" and the team stops. The silence is **ambiguous**: a deadlocked team and a finished one emit the
same quiet, so from outside they are indistinguishable (the same ambiguity *Watch State* names for
the supervision layer). Four observed variants — a driver idling granted runway after its named
queue empties, a harness rewind swallowing inbound Sentinels the Bus still holds, a wait-dependent
subagent whose completion cannot wake its spawner, and a provider request wedged silently
server-side. The countermeasure is always a **pull leg**: some clock, not just the bus, must be able
to put a turn into a seat (a scheduled runway heartbeat, a supervisor's idle-driver discriminator, a
post-rewind `tap poll <self>`). Unifying invariants: *the Bus is the durable truth, the Sentinel is
only the doorbell*, and *silence must be armed to mean one thing*.

### Primitive Levels (L1 autocomplete → L2 spec-driven → L3 orchestration + choreography)
The capability ladder agent primitives have climbed. **L1 autocomplete**: here is
a function interface, fill it in. **L2 spec-driven development**: here is a spec and a plan; follow
the instructions and build it. **L3 orchestration + choreography**: here is a goal, possibly a
plan, possibly a set of steps; help me assemble a team and propose the workflow. `/tap:lead` is the L3
primitive: aimed at frontier-tier lead seats, it composes over the L2 primitives (/ce-plan,
/brainstorming, /lfg, harness-native workflow engines) rather than reimplementing them — it
proposes a strategy whose phases are routines, skill invocations, or delegated work orders.

### TAP Orchestration
The optional opinionated layer distributed as `tap-orchestrate`. It composes TAP core facts and verbs into recoverable heterogeneous-agent Runs. The dependency is one-way: orchestration may read core; core never learns orchestration semantics. `tap-orchestrate` is the package name; its public slash prefix remains unratified, so new orchestration actions do not use the core-only `/tap-*` namespace by inference.

### Run
One bounded orchestration effort toward a goal. A Run groups the Lead, source pointers, work orders, Lanes, decisions, verification, and recovery state above the Team and Bus; TAP core has no Run concept.

### Setlist
The ordered/parallel phase list inside a strategy, with named stages and artifact handoffs. Plan-before-writing follows `/tap:lead`: new roles, new subsystems and one-way doors; a bounded spec starts directly.

### Run Stub
The minimal durable identity-and-pointers record created on day zero: Run id, goal/plan pointer, Lead handle, lifecycle status, current Run Context Capsule pointer, and a small append-only journal of underivable events. If a field can be wrong while the Bus is right, it does not belong here.

### Run Context Capsule
The one `tap-orchestrate`-owned Markdown recovery snapshot for a Run: objective and source pointers, ratified decisions, active work, outstanding obligations, verification state, and recovery next actions. The Run Stub selects the current capsule. Lead recovery, teammate replacement, cross-harness handoff, and compact hooks consume this same format; a harness adapter never defines a second capsule schema.

### LEADER / DRIVER / EXECUTOR
The team-role taxonomy — hats, not ranks: a **LEADER** choreographs one workstream and owns its run-level completeness; parallel **DRIVERS** each ensure one chunk or Lane completes and report to the LEADER; **EXECUTORS** perform specific dispatched tasks without run- or lane-level completeness ownership. Roles may overlap in one agent (a solo seat is all three). One leader per workstream is the best practice, not a law: two leaders sharing a tree on visibly distinct workstreams is valid — they recognize it, say so to each other, and escalate only on genuine collision. `/tap:lead` is the LEADER charter, `/tap:drive` is the DRIVER contract, and `/tap` plus each work order supplies the EXECUTOR floor; those skills own behavior, while this entry only fixes the names.

### Standing Brief
The single kickoff payload giving a teammate its role, lanes, protocol, and escalation rules, so every later work order can be a one-liner.

### Handoff Artifact
The durable record a seat writes BEFORE a state-discarding reset (clear, restart): the standing assignment, current state, next actions, and pointers to primary artifacts. It lives in the repo or on the Bus — never session-only storage, which does not survive the boundary event the artifact protects against. Bounded: pointers to the record, not a second copy of it. The one mechanized rail of context hygiene; the doctrine and its advisory companions live in `docs/solutions/best-practices/write-before-reset.md`.

### Writer Token
An optional, explicit exclusive claim on a shared worktree while custody needs to remain attributable. One holder at a time when used; pass or release it in a message. Its scope is the whole tree because generated outputs and semantic interactions cross file boundaries. Lanes may choose concurrent writers under `/tap:drive`; immutable CI checkouts do not freeze local authoring.

### Named-Resource Lease
An explicit, temporary exclusive claim on a named resource that a worktree cannot isolate (for example, a shared generated artifact or path). It supplements the Writer Token rather than weakening it; the holder names the resource and release condition in the handoff.

### Compute Slot
A reservation of local compute capacity for a test run whose expected duration exceeds the unreserved short-run allowance. A Compute Slot is an execution resource, not evidence that the run will finish within a budget; the receipt still records the measured duration and conditions. Distinct from the retired Suite Slot, which coordinated machine-wide local full-suite runs.

### Lane Scope
The paths a DRIVER agrees to own in a multi-driver run. Record ownership and transfers explicitly in TAP work orders; a scope is a coordination record, not isolation from other writers or tree-global Git state. The `tap lane` CLI and its automatic scope fold are retired. Existing `lanes.json` and ledger records remain historical evidence. See [worktrees and handoffs](skills/tap/references/worktrees-and-handoffs.md).

### Wave
One writer's batch of work units, ending in a Gate. Waves alternate writers so every wave is reviewed by someone who didn't write it.

### Gate
An independent review closing a work unit, with a named focus and pinned source. The reviewer verifies load-bearing claims against source and relevant evidence; focused probes resolve uncertainties. In this repo the CI full supplies execution evidence, and inspection by a non-author supplies independent judgment.

### Pre-flight
Verification a reviewer performs against source of truth *before* the reviewed change is written, covering the specific commands, flags, or capabilities a review's asks have already named, with the result routed to whoever currently holds the pen rather than to the change.

Pre-flight is available only when the asks name a checkable referent; a shapeless ask has nothing to check until the prose exists, and a finding that depends on the eventual wording is genuinely post-hoc. Its economy comes from where the correction lands: a pre-flight finding is absorbed into the authoring pass, while the same finding raised afterward moves the head and voids the Anchor in flight. It narrows what a Gate must catch but replaces none of it — behavior defects still require a fresh reviewer reading the finished change from source. At an intermediate revision nobody intends to ship, pre-flight inspects and deliberately does not anchor.

### Anchor
A full-suite verification run bound to a tested HEAD and TREE. In this repo the CI full supplies it, and a non-author inspects it where the risk tier requires. The receipt records run URL, workflow revision, tested head/tree, red set and baseline comparison, raw exit, tree state, timing/file count, skips and dispositions. A missing terminal result is not evidence. The final merge head needs its own CI receipt; computed replay identity can carry reviews of unchanged bytes.

An anchor cites its recorded result and actual execution conditions. Machine and operator-state observations belong to that run and never carry through a code identity alone.

Every anchor presumes the suite answers the same way for the same revision. That presumption is not itself an anchor and nothing in the set reports its failure: when the suite becomes order- or contention-sensitive, anchors keep passing while a pass stops meaning the revision is sound. A change that alters which tests run alongside which therefore needs repeated anchors agreeing on the same set of failures, not one pass — and a suite known to be non-deterministic is repaired before anchors taken through it are trusted, including anchors on the repair.

### Placebo Arm
A test assertion that cannot fail, because the state it constructs never reaches the code it names. Distinct from weak coverage: a weak arm reports too little, while a placebo arm reports a property it never examined, and its green retires the question that would otherwise have prompted a real arm.

The two reachability failures are entering a multi-condition branch with a value that satisfies none of its conditions, and naming a guard that sits below an early exit. Both leave an arm whose label and behavior have silently diverged, so neither is visible by reading the arm — only by re-introducing the exact defect the arm names and requiring that arm to fail. Mutating one field at a time is what establishes which assertion is load-bearing; mutating a whole behavior shows only that something noticed. A placebo arm found this way is relabelled to state what it actually pins and then re-proven, rather than deleted or left under its original claim. The detection has a bound worth stating: it tests only the arms someone thought to attack, so an unsuspected arm is found by reading the file rather than by mutating around it.

Unreachability is only the structural level of the class. An arm can reach every line it names and still be unable to fail, because the input it uses makes each plausible divergence a no-op — see Discrimination Claim. That level leaves nothing on the page to read, so a reachability trace clears it and only an attempted falsification aimed at the specific claim finds it. Deeper still, an arm can sit over a band no fixture in the corpus samples; that is a Held Axis rather than a property of the arm, and it bounds the detection a second time — an attacked arm yields only what mutation can reach from inside the corpus: a mutant landed in code the band would exercise survives and is the partial internal signal, while a dimension with no code locus leaves every attack silent.

The class is also bounded in what it *is*, and the boundary matters because the remedies differ. A placebo arm cannot fail; an arm that fails correctly against a Reference Implementation was never one, however wrong the property it turns out to pin. Filing that second case here routes it to mutation, which clears it; its detector is a Reference Implementation, and the class it belongs to is described under Arm Set.

### Discrimination Claim
An assertion that some behavior is one thing rather than another plausible thing — an "X not Y", an equality against a reference, or a precedence — as opposed to an assertion that merely records presence or that a process ran. Claims are what proof attaches to; a check is only their container.

Mutation is owed per claim, not per check: a check carrying several claims and one mutant has one proven claim and the rest wearing its green. Claim count is read off the assertions, never off the name, because a name mentions at most one of them. A claim can fail to discriminate in two ways that call for opposite repairs — structurally, when the second path is absent, and by value, when both paths run on an input under which every divergence collapses to the same result. So the first question about a surviving mutant is whether the fixture's value could ever have separated the cases — a claim with more candidate explanations than the fixture has separable values is undiscriminated however carefully the assertion is written. Three causes are possible there and their remedies differ: the value cannot separate the cases, so the input has to change and no rewrite of the assertion helps; the dimension is absent from the corpus entirely, so the remedy is an observer that can see it rather than another arm; or the behaviors are genuinely indistinguishable to every available observer, in which case the honest output is a stated indistinguishability rather than a test. The inverse guard matters equally — a claim a mutation was never on the path of is correctly green, so which claims a mutation can reach is stated before its verdict is read. A check set whose mutants red exactly their predicted claims and no others has a measured discrimination floor; one whose mutants red everything has only shown its claims are coupled. Reading any of those verdicts presumes the mutation actually landed in the tree under test, which is confirmed before the result is interpreted rather than after it is believed.

### Positive Control
A check run against a case known to trigger, establishing that a checker can report a finding at all before its silence is read as evidence of absence. Without one, an empty result is a claim about the query rather than about the thing queried.

A control validates only what it holds constant: it must differ from the real query in exactly one variable, or it exercises neither the path under suspicion nor the one it appears to clear. A control varying two things at once can pass truthfully while describing a query nobody ran. This is the instrument-level form of a held axis, and the reason a clean sweep is reported with the control that licenses it rather than on its own. A control need not be a varied case: where several implementations of one contract are being compared, the control is a whole second system — see Reference Implementation.

### Structural Verdict
A judgment about one reviewed object's design that is expressed only by the count of same-class findings against it, never by any single finding. Distinct from an ordinary finding, which names a defect and proposes a fix: a structural verdict names nothing, and the reviewer who produced it may not know they delivered one.

Because it lives in the aggregate, it is visible only to a reader counting findings by object and by class, and it is destroyed by dispositioning the findings one at a time — each individual fix is defensible while the sequence implements the opposite of what the findings jointly said. Findings arriving in small rounds over hours make this the default outcome rather than a lapse, since no round ever displays the aggregate. Two groupings carry it: several findings sharing one class against one object, and several findings that are one defect at several call sites, where fixing any one alone leaves the rest. Recording the grouping above the enumeration is what preserves it; a grouping written below the list has already lost to individual triage.

### Adjudicating Probe
A command run against the real input to settle whether a mechanism under review behaves as its description says, as opposed to a further reading of that description. Distinct from a Positive Control, which establishes that an instrument can report at all: an adjudicating probe decides a specific behavioral question already in dispute, and it is worth running precisely when the reading is clean, because a clean reading both raises the hypothesis and suppresses the appetite to test it.

It is an instrument like any other and inherits every instrument's failure modes, so its verdict opens a question rather than closing one: where a probe and a careful reading disagree, the disagreement licenses investigation, not a ruling, and the next move is to establish which of the two is blind. Its evidentiary form is two arms differing in one variable with both directions named — a single arm producing the expected output shows only that the output is producible. It settles adjudication, never discovery: choosing which pass finds unknown defects is a separate question on which reading and adversarial mutation are complements.

### Wall-Time Band
The range of elapsed times a verification run is expected to fall in, recorded for one pairing of a specific binary with a specific set of arms and valid for no other pairing. Two implementations that both satisfy the same contract can differ by an order of magnitude on identical arms, so a band stated for the harness rather than for a pair will call a conforming implementation broken.

A band is derived from repeated runs on an otherwise quiet box and is stated together with the conditions it was taken under. Its multipliers are deliberately loose: a band tight enough to catch a small regression fires on ordinary machine noise, and a check that cries wolf gets waved off. A run outside the band is unproven rather than red — the band prompts a re-run, it does not overrule the arm results — while a run inside it is affirmative evidence that work occurred, not merely the absence of an alarm. When conditions degrade, the box is quieted rather than the band widened; a band relaxed to admit a degraded box has stopped measuring what it exists to measure. Whether a band travels with the harness as a recorded constant or is re-measured per box is unsettled: a baked-in band mis-fires on other hardware, and a per-box re-measure can be taken on a degraded box and bless the degradation.

### Stub Floor
The elapsed time a run takes against a binary that exits successfully while doing nothing — a second red-flag threshold recorded beneath a Wall-Time Band, not that band's own lower edge, which sits well above it. Below the floor a passing verdict is evidence that the work did not happen. Recorded per arm set, alongside the band it accompanies.

The floor exists because success-shaped output is cheap: a no-op can satisfy the arms that inspect only the harness's own fixtures, and nothing in its output announces that no work occurred. Wall time is the cheapest discriminator for that case and the only one available before any result is parsed — but only where a floor has been recorded to compare against. A fast run is therefore a red flag rather than a win, and the asymmetry with the upper edge is deliberate: above the band the evidence is weak, at or below the floor the run may not have happened.

### Held Axis
The variable a fixture supplies or presupposes rather than varies, making the fixture incapable of failing on it. A fixture that mints the identity under dispute — a handle, a roster row, a registry shape — has answered the question it was built to ask.

The corrective is a negative control: a case in the corpus that must stay green, so that a change which simply asserts the desired answer everywhere fails it. Without one, capitulation and fix are indistinguishable. The review question that surfaces this class is which variable the fixture holds still that the live system varies, and it is why fixture agreement and live agreement are separate evidence: a model can be green while the world it models is broken.

An axis can be held by one fixture or by every fixture at once, and the difference decides which instruments can still see past it. Held in one place, a counterexample input reaches it. Held across the whole corpus — a dimension the live system varies that no test, arm, or reviewer's fixture ever samples — arm count and differential agreement report clean, and correctly so, because each measures a space that does not contain the case; a mutation score holds the one partial internal view: a surviving mutant in code the unsampled dimension would exercise is a signal, available from mechanical mutant generation without anyone imagining the input — but only when the dimension has a code locus for a mutant to occupy; a dimension with no code expression leaves the score silent too. Independent instruments agreeing under that condition is not corroboration: they share an input space rather than a method. For the no-code-locus case nothing internal to the corpus finds it, so the remedy is contact with a world that varies the dimension, and adding the dimension is not the same as sampling it.

The axis can be held in two directions, and they cost differently. Held so the fixture cannot fail, it is silent and wastes nothing until a real defect slips past. Held so the fixture builds a world the system under test can no longer read — the state after what a system observes has been changed — it goes red instead, and points at the code rather than at itself, because the setup step succeeds either way. Changing what a system observes therefore invalidates the setup of every test that staged the old observation, and several arms failing together after such a change is evidence about the fixtures before it is evidence about the predicate.

The axis can also be held by an author's implementation scope rather than by a fixture value — an absence rather than a supplied constant. Nothing in the fixture names it, so no amount of inspection surfaces it, and the corrective is a Reference Implementation rather than a negative control.

### Arm Set
The bounded collection of assertions an instrument comprises, considered as a whole rather than one arm at a time. Its soundness is a separate property from any arm's: every arm can be live, reachable and discriminating while the set still measures the wrong thing, because the set's boundary was drawn by someone who held a view about what needed measuring.

An arm set authored by a party to the comparison it judges encodes that party's scoping decisions as requirements, and encodes them in disguise — an exit code, an artifact list, or a directory can each demand the absence of a subsystem without naming it, so the same requirement appears several times without looking like one class. Such a defect is invisible against its author's own implementation, where every affected arm is green, and invisible to reading, because no arm mentions the missing thing. The detector is a second implementation: run the set against the Reference Implementation and require the same green. A set green against one implementation is a claim about that implementation, never about the contract.

### Reference Implementation
The existing production implementation of a contract, run under the same Arm Set as the candidates being compared against it. Distinct from *incumbent* as this project otherwise uses the word — there, the live seat being replaced by a restart.

It earns its cost twice, and the two purposes are independent. It is what makes an arm set testable at all, since nothing else can distinguish "the contract holds" from "the author's slice holds". And it is the control that separates an instrument's own artifacts from candidate defects: an arm that reds against every candidate and the reference implementation alike is reporting on the harness rather than on anything under test. A comparison that never ran it has no comparative verdict to state.

### Sync Check
A check that mechanically owns a written maintenance instruction of the form *when you add X, also update Y*, by asserting a correspondence between two artifacts in both directions. It exists because an honor-system correspondence drifts silently, and it succeeds at what it claims: every name present on both sides, no orphan on either.

Its bound is that a correspondence must be asserted at some surface — a token, a heading, a filename, a count — and the content that surface stands for is not part of the assertion. The resulting failure is not the check's but the reader's: a green sync check is routinely upgraded to "the artifact is in good shape", because it is the only mechanical thing in view. That upgrade is most costly where the surface and the content share one artifact and one editor, since the edit the check exists to police is then also the edit most likely to damage what the surface describes — the check is greenest exactly when it is most likely wrong. Distinct from a Placebo Arm, which cannot fail at all: a sync check fails correctly, about a smaller thing than its slot implies, so mutation clears it and reports nothing.

### Stated Limit
A bound a check declares in its own text — what it does not verify — placed there rather than in a review thread or a tracker, because its green is re-read by people who will never see either.

A stated limit makes a gap auditable; it does not make it safe, and writing one can feel like closing it. Two rules keep it honest. It is partitioned before it is accepted: the part a cheap mechanical arm can own becomes an arm in the same change as the declaration, and only the genuinely judgment-bound remainder stays declared. And that remainder names its owner — the run, review pass, or reader answerable for it — since a limit with no assignee is an unassigned risk wearing a disclaimer. An unrevisited limit erodes the way any recorded exemption does: it stops attracting the scrutiny its subject still needs, and a defect landing inside it is invisible to every pass that trusted the declaration.

### Moving Reference
A referent in a durable artifact — such as a fixture seed, detector, exemption, or written rule — that resolves from state which can change without anyone editing the artifact. Branch names, HEAD-relative revisions, merge-base relationships, and events such as "once the fix merges" are moving references; commit identities, tree hashes, and literal file text are not. A reference resolved and consumed within one command is not in this class, which covers references persisted and re-resolved later.

The failure is delayed: the artifact passes review on its branch and becomes wrong after the referent moves. Check at the point of writing. In order of strength, construct the referent from content, pin an immutable identity, or use a per-object predicate such as "does this tree contain the fix?" for a moving population.

### Re-scoping Edit
A change to a line that governs what the unchanged text beneath it refers to — a heading, a section lead-in, a subject noun, or a path inside a sentence — re-attributing every claim in that block without editing any of them. The complement of a Moving Reference, where the artifact's text stands still and the world moves: here the world stands still and the artifact's own edit changes what its surviving sentences are about.

Its cost falls on review rather than on authorship, because the instrument a reviewer reads reports changed lines while the claims that flipped are unchanged ones. Diff context is a rendering width, not a scope boundary, so re-attributed text routinely falls outside the hunks entirely and is absent from the review view rather than merely under-read. A retained claim also carries the credibility of a prior pass, and its truth value moves independently of its siblings — several claims under one re-scoped heading may hold against the new referent while one does not — so a blanket verdict on the block is wrong in both directions. What settles it is reading the block at the new revision and checking it claim by claim against the new referent; the cheaper authoring alternative is to replace the stale passage and leave the scope line where it was.

### Pinned Input Set
The complete set of inputs a check recorded before running, against which its verdict may later be shown to still hold. Membership is decided by what the check *reads* to reach its verdict — the artifact under review, and equally the rule corpus, the claim text, the config, or any state consulted on the way — never by what the check reports on. An input the checker read but the pin never recorded is silently declared constant.

Reuse of a prior verdict is authorized by a key stated universally over that set: every recorded member, re-derived fresh at citation time from the same derivation that produced it, equals what was recorded. A key written instead as a list of members encodes one author's inventory of what could change and fails one member at a time, each review round buying exactly one more; the inputs it misses most reliably are those that can move with no local change at all, such as text edited on a host. Re-deriving a member by re-reading the artifact already materialized on disk proves nothing, since that artifact can only ever match itself. Universality is worth exactly what the set contains, so the set's completeness is a separate question from the key's form — an Anchor keys its code inputs on the head alone because those inputs *are* the tree at that revision — while its machine-state and operator-state observations are re-observed per run, never carried by the key — and even that narrower license does not survive outside its scope.

### Suite Slot
Retired coordination for machine-wide local full-suite runs. The merge gate now runs in CI at each PR’s exact head, concurrently across PRs. There is no local slot to grant or census. Focused local checks use isolated runners and stay small.

### Operator State
Machine-scoped state belonging to the human operator rather than to any run — the Machine Index and the per-seat records that persist across sessions. Distinct from a run's own scratch: a verification run may create and destroy as much of its own state as it likes, but Operator State is expected to be byte-unchanged when the run ends.

Records written here are indistinguishable by name from ones a run's fixtures create, because fixtures use realistic seat and team names. That makes leaked entries unidentifiable after the fact and cleanup fundamentally unreliable, so the boundary is enforced at write time rather than repaired later.

### Hermetic Boundary
The isolation contract a verification run executes under: a literal allowlist of environment values admitted into the run, plus a per-run sandbox that every machine-state path is redirected into, so the run cannot read or write Operator State.

The allowlist is deliberately literal — a value not named in it cannot cross — and it is enforced at two layers, the run's entry and its individual workers. Admitting a value at one layer but not the other leaves the redirect silently inoperative while appearing applied, so both layers are part of the contract rather than one being a convenience. Isolation belongs to the boundary and not to each test remembering to redirect itself; a test that opts itself out is a fixture choice, while a path the boundary never covered is a defect.

Redirecting a value also puts that value's *default* resolution outside what the run witnesses: with the override set everywhere, the branch computing the default never runs, so a suite can be entirely green about a path no arm reached. That is a cost of the contract rather than an argument against it, and the answer is one arm per overridable default that leaves the override unset inside the sandbox. What that arm must assert is the resolved value itself — an arm that exercises the default while checking only properties which survive the value changing (that two callers agree, that a home is honored) is reached-but-silent, which reads as coverage and is not.

### Fix-wave
A filed-forward batch of corrections dispatched after review findings, carrying its own cross-review. Findings and amendments are always filed forward — a landed unit's spec is never retro-edited mid-run, because an executor may be working against the old text.

### Lane
One bounded piece of delegated work owned by a driver, with its branch, custody and evidence identified. Independent work usually starts from the trunk in its own worktree; real dependencies may stack. Drivers choose shared or isolated trees under `/tap:drive`, coordinating mutable checkout operations and any explicit writer token.

### Base Motion
The driver’s update of a lane to a new base: fetch, rebase or retarget, resolve in-scope conflicts, and publish the result. `skills/lead/references/base-motion.md` supplies the recipe. Base motion requires replay identity, impact and conflict evidence, review of changed bytes and CI at the final head. Routine base motion needs no leader permission.

### Burst Engine
A harness-native workflow runner a single Seat uses for ephemeral parallel fan-out (review panels, verify swarms, research sweeps). Its placement rule, guardrails, and tally contract live in `skills/lead/references/routines/dynamic-workflows.md`; this entry is vocabulary and a pointer, not a second procedure.

### Ask
The lightest ephemeral form: one stateless cross-harness invocation (`tap ask`) — no registration, no Bus address, no lifecycle, and every invocation starts fresh. The bottom rung of the Ephemeral Ladder. The command's help owns the executable contract; the doctrine (`docs/solutions/architecture-patterns/ephemeral-ladder-ask-crew-seat-driver-first.md`) owns when to reach for it. Its statelessness is deliberate: conversation is the Crew rung's job.

### Ephemeral Ladder
The three graduated forms for reaching another model or seat — **Ask** (stateless one-shot) → **Crew** (stateful ephemeral pane, bus-addressed) → **Seat** (launcher-managed, durable, restartable) — under one selection rule: the lowest rung that answers the need. A follow-up question outgrows ask; a lane or restartable address outgrows crew. Taught driver-first: drivers are the primary users of the lower rungs mid-lane, without escalating through the leader; the leader primarily coordinates durable teammates and may use all rungs. Subagents and Burst Engines are the same-harness sibling axis, not rungs.

### Run Dark
The operating mode between Standing Brief and checkpoint: peers coordinate peer-to-peer and the Lead is contacted only for enumerated reasons (genuine dispute, hard blocker, plan contradiction).

### Work Order
A payload assigning new work. Always travels `reply=expected` as its own payload — one obligation per payload — and the reply owed is completion evidence or an explicit progress report, so the work stays visible in `tap outstanding` until acknowledged done. Settlement tracks message obligations; the work-order convention is what makes work obligations observable too.

### Work Outcome Vocabulary
The M0 reason words used by Leads and Watchers without yet automating policy: `working` means active progress; `awaiting-input` means blocked on a known response or approval; `stopped` means no current processing; `errored` means execution ended in failure; `cancelled` means intentionally terminated; `exited` means the Seat or process is gone; `wedge-suspect` is an observable silence predicate requiring investigation. Awaiting input is not wedged, cancelled is not stopped, and none of these words alone chooses a retry, reroute, or escalation action.

## Supervision

### Monitor
A seat that samples a declared subject on a regular cadence, writes a timestamped reading with numbers each cycle, and reports findings to its charter recipient. Nightwatch, a goalie seat and a context genie are variants. The leader checks heartbeat age; silence is missing evidence, not an all-clear. The [monitor protocol](skills/tap/protocol/supervision/monitor.md) owns cadence, reporting and recovery. `monitor` replaces the former `watcher` role hint; the Watcher sidecar below keeps its name.

### Watcher
The per-team sidecar script loop that guards liveness. Zero tokens while healthy; spawned and stopped by arming and disarming, its own state observable on the bus. It detects silence and executes the escalation ladder — it never edits files or interprets payload content.

### Watch State
The arm record on a team's bus (armed by whom, when, the Done-When, silence threshold, optional bounded pause, chain overrides, evaluator choice). Armed means "work is in flight — silence is suspicious"; paused means "a known wait temporarily suppresses only the silence chain." Unarmed teams are never probed, because to a metadata-only observer a deadlocked team and a finished one look identical. The Lead arms at kickoff and owns disarm at Run close. The record is also the Watcher's lease: when it is gone, the loop exits.

### Done-When
The goal text recorded at arm time: one measurable end state, the command or artifact that proves it, invariants that must not change, and a hard bound. The Evaluator judges it clause by clause against observable evidence — a clause without cited evidence is not done.

### Probe
A `kind=probe` payload (always settle-only — a pane-less sender can mint no reply obligation) sent to a stopped seat when an armed team goes silent. The probe is itself the un-wedge: its delivery restarts the agent's turn, and settlement is the mechanical liveness signal. Routine status is forbidden; only a blocker or credible run-complete signal goes to the armer. Settlement records only "pinged at T, seen"; resumption is new non-supervision bus traffic, so a seat that settles without acting cannot reset its own escalation. The armer alone owns disarm.

### Notice
A `kind=notice` payload the Watcher sends the arming seat when supervision state changes under it, carrying the evidence. The recipient spot-checks briefly — if it agrees, no essay, end turn; if the run is NOT done, re-arm or re-pause the watch, wake teammates, and record the failure mode. One loud path per failure shape: self-disarm by the armer sends nothing; evaluator disarm, non-armer pause/resume, pause expiry, and forced non-armer disarm notify the armer; if delivery fails, the watcher falls back to sticky human NOTIFY.

### Escalation Chain
The Watcher's chain of command for probes, computed live at each tick: stopped seats first (a stopped agent is cheap to wake and can route work or raise the lead), ordered by recency of last activity among them, ending at the arm record's terminal seat and topping out at a human notification. The Watch State stores only overrides and the terminal seat — a frozen at-arm list would be stale by wedge time.

### Seat State
The Watcher's per-seat classification, derived from the strongest available signal for that seat's harness: working, idle-at-prompt, blocked-on-approval, rate-limited-error, wedged, or unknown. Probe eligibility keys on it — stopped seats are probed, working seats are suppressed, blocked or rate-limited seats route to notify — and wedged requires multiple signals to agree, never one heuristic alone.

### Quiet Window
A deliberate verification technique: the team goes silent on purpose so the silence threshold elapses and the supervision paths fire live. A zero-infrastructure integration test of behavior that otherwise only triggers in production — used to prove a Probe round-trip end-to-end before trusting a new Watcher.

### Evaluator
A one-shot headless model invocation (the plan also says "diagnoser") the Watcher uses when mechanical signals are ambiguous. Judges the Done-When against external observable evidence only — never the workers' self-reports — with per-clause citations, defaulting to not-done under uncertainty, and returns exactly one action from a strict allowlist; anything malformed is discarded and the chain advances mechanically. Deterministic pre-checks gate every invocation (unsettled payloads mean not-done for free). Ephemeral by design — judgment without a resident seat.

### Drift-Peek
The Lead's adaptive check-in heartbeat while a Run is live: estimate how long the current phase should take, schedule a native wake, re-evaluate on every wake or inbound tap. Guards direction ("is everyone building the right thing?") while the Watcher guards liveness — the two are complementary, not redundant. During a Watcher's bring-up it also serves as the independent backstop: it stays armed until the Watcher has handled its first real episode, because a supervisor has no supervisor until proven.

### Approval Timeout
A team's opt-in (`tap approval-timeout on`, off by default) under which the Watcher declines a seat's tool-approval request that no one answered within its harness's built-in timeout: one recovery-run Escape, gated on the same request and its deny label, never an approve key. The seat is told to route around it and ask the user later; the armer is told every outcome. A harness without captured evidence for its deny control gets no key: a recognized request is reported blocked and escalated. Hermes's real prompt is not yet recognized, so Hermes gets no timeout observation or escalation until its prompt is captured. Runs only while the watch is armed in full mode. The [approval-timeout protocol](skills/tap/protocol/delivery/approval-timeout.md) owns the rules.

### Wedge-Suspect
A watcher’s mechanical observation that an armed team has no bus or repo activity past a threshold. It is a reason to inspect context, never proof a seat stalled. A working seat can answer once with status and continue without repeated messages or head changes.

## Presets

### Preset
A named, complete tuning bundle an operator can launch a Seat from — harness, model, effort, environment, and briefing metadata under one name. Complete is the load-bearing word: a Preset names every tuning value it cares about, so combining one with ad-hoc tuning is refused rather than merged under an invented precedence order.

A Preset name is machine-global (it names a catalog entry) while a Seat's handle is team-scoped, and the two are deliberately independent: the name an operator passes becomes the handle unchanged, and which Preset a Seat runs is read from its record rather than decoded from its name.

### Preset Catalog
The operator-owned collection of Presets a machine can launch, plus the vocabularies its briefing metadata draws on. It is the operator's file to extend: a reader may not refuse it over content it does not recognize.

Presets resolve from it exactly once, at launch. Resume and restart replay what was recorded rather than re-reading the catalog, so editing or deleting an entry never retroactively changes a running Seat.

### Schema Tolerance
The reading contract for operator-owned configuration: understand what you can, ignore what you cannot, and emit one notice naming each thing ignored. Unknown sections, unknown or future schema versions, and unrecognized vocabulary references are all notices; the only hard failure is a document that will not parse at all.

Degradation is scoped to the smallest unit that still makes sense, and the scoping is what keeps tolerance honest — an entry the reader cannot make sense of is dropped and named while its siblings load, and a briefing-level problem costs only that field. The floor exists because "ignore what you do not understand" would otherwise become "advertise something that cannot launch". Two obligations follow and are easy to miss: a dropped entry must still answer truthfully when something asks for it by name, and a retired schema version must be diagnosed as a version rather than read under current rules, which would mis-resolve rather than under-resolve.

### Launch Provenance
The record of what a Seat was launched with, kept on the Seat's row rather than encoded in its name. It is why a roster can report a Seat's Preset without guessing from the handle.

When no record exists — a Seat predating the field, or one registered by hand — a name-based match may stand in, and it is marked as inferred wherever it is displayed. The distinction is not cosmetic: an unmarked guess once reported a Seat as running a different Preset than the one it was launched with.


## Flagged ambiguities

- "Anchor" carries two senses that are related but not interchangeable, and only the first is the entry above: the **merge-evidence** sense — a full-suite run bound to one revision — and a **citation** sense, the revision or observation time a stated fact names so it stays checkable after trees move. Both rest on the same idea that a claim belongs to a revision rather than a branch, which is why the word was reused; they differ in what is owed when the head moves. A stale merge anchor obliges a fresh run, while an unanchored citation obliges nothing of its author and instead silently misleads its reader. Say "anchor" for the run and "carry the anchor" for the citation habit when both are in play.
- "Provenance" carries two distinct senses and both are load-bearing: a Seat's **native resume provenance** is the harness conversation id that lets a Terminal resume the same context, while **Launch Provenance** is what the Seat was launched WITH (its Preset). One answers "how do I get this conversation back", the other "what is this Seat running". Neither substitutes for the other.
- "Handle" and "Seat" name the same generic routing identity — handle is the CLI/register term, while Seat is the identity-doctrine term distinguishing it from Terminal and Content. The `SEAT` / `CREW` kind labels distinguish non-Crew Seats (ordinary or launcher-managed) from Crew for display; they do not make Crew rows non-Seats.
- Rounds had been expressed as name suffixes; settled: rounds are epochs on the Seat's record, never part of its name.
- "Probe" also names a third thing on the transport side: a **drain probe**, a delivery-path readiness observation of a recipient's Composer. A `busy:pending` observation increments the counter reported with Probe Span; not every probe does. It is neither the supervision Probe payload nor an Adjudicating Probe — it mints no obligation and settles nothing. Qualify it as a drain probe wherever supervision vocabulary is also in play.
- The supervision and evidence senses of "Probe" remain distinct: a **Probe** is a settle-only supervision payload sent to a stopped seat when an armed team goes silent, whose delivery is itself the un-wedge, while an **Adjudicating Probe** is a command run to settle a behavioral question in review. One is transport, the other is evidence; neither is a specialization of the other, so the qualifier is not optional on the second.
- "Driver" names different ranks across the 2026-07-11 vocabulary swap (bead tap-kyo): since the swap it names the chunk/Lane tier, while pre-swap docs use it for the top orchestration role. New surfaces use the ratified **LEADER / DRIVER / EXECUTOR** taxonomy above; historical plans, handoffs, and field reports retain the pre-swap sense as records of their time and were not rewritten.
