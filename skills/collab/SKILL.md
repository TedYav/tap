---
name: collab
description: "Collaborate with a named TAP peer on a task: agree on roles, challenge claims with evidence, and produce a bounded result."
argument-hint: '<peer> <task…>'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write, Skill'
---

# /tap:collab — work with a peer

Agree on who writes, who challenges, and who decides; then use `/tap:pair` to produce
an artifact or `/tap:discuss` to resolve a plan, review, or decision. Either seat can
initiate. The task may be code, prose, research, or a choice to make.

**From a human:** “Collab with astra on X” tells the receiving seat to run
`/tap:collab astra X`. Check `tap team` for a bare handle, or `tap team roster <team>`
for `<team>/<handle>`. Only a bare handle absent from the local roster calls for
choosing a preset with `tap presets` and `tap session launch <preset> <name>`.
Do not launch a local replacement for a qualified peer; ask which seat when unclear.

## Open

Both seats MUST load [/tap](../tap/SKILL.md) for transport, liveness,
and shared-worktree rules. Confirm your handle with `tap whoami`.

The opening work request MUST name `/tap:collab` in its first line so the peer loads
this contract. Send the request as a literal body with `tap assign <peer> -f <file>`.
The first request/reply exchange MUST record:

- The task, deliverable, scope, and the evidence that will show it is done.
- Each seat's handle and model family, or `unknown` when the family is unavailable.
  If both seats share a family, say so. A shared family, or two different families,
  does not by itself make the seats independent.
- The **writer**, **challenger**, and **decider** for ordinary ties, and who owns
  the findings ledger. One seat may hold several roles. The writer does not
  review their own changes.
- The work shape and the round cap. The default cap is three substantive exchanges.
  A request and its substantive reply are one exchange. Transport receipts and
  administrative acknowledgements do not count.

Propose the roles from the task; the initiator can be writer or challenger.
The decider MUST stay within the user's existing authority and external gates.
A tie does not authorize overriding a requirement or an unresolved correctness
blocker. The ledger owner and decider MUST stay fixed unless the opening
agreement is explicitly reopened.

## Accept

The receiving seat MUST read the payload and load this skill. In the first
substantive reply (`tap reply <id> --progress -f <file>`), accept or counterpropose the
roles, work shape, scope, and cap; fill in your actual model family.
Both seats MUST agree before joint writes.
An acceptance can include the first substantive assessment; no third
acknowledgement round is required.

For `/tap:discuss`, the driver MUST count a substantive accepting reply once with
`round-count.sh <thread> --increment --by <driver>` after opening the thread,
as its first cycle; keep the total cap unchanged and do not count setup-only replies.

If the request is only a factual question, answer it through an ordinary TAP
reply rather than strand it behind collaboration setup. If the work cannot be
taken on within the available context, capacity, or authority, reply with the
specific obstacle and a useful alternative; do not silently accept and disappear.

## Choose the work shape

Both seats MUST load the selected contract and its role-specific references:

- [/tap:pair](../pair/SKILL.md): produce and review successive artifacts. The current
  writer builds; the other seat reviews. Its unit reports and review findings
  are the issue ledger; keep their dispositions there rather than create another.
- [/tap:discuss](../discuss/SKILL.md): converge a plan, review, or decision. The ledger
  owner is its **driver**; the peer proposes dispositions and the driver folds
  them. Pass the agreed cap explicitly as `--round-cap N`.

Before the first substantive exchange, the ledger owner MUST open the selected
shape's records: the `/tap:discuss` thread and ledger under `COLLAB_DIR`, with the
agreed cap passed as `--round-cap N`, or the first `/tap:pair` unit report. Share
the record's path with the peer. Small deliverables do not waive this requirement.
A convergence claim with no shape record is a protocol violation the peer may bounce.

`/tap:collab` creates no ledger of its own; use the selected shape's existing records
and helpers. Its custody, evidence, and review obligations MUST survive.
`/tap:discuss` keeps `COLLAB_DIR` and its existing `collab` state.
The agreed cap bounds this collaboration; the selected skill's own limits still
apply. Reopen the agreement if the deliverable needs a different work shape.

## Hold custody

One seat MUST write the shared work product at a time. Transfer custody
explicitly; the non-author MUST review each changed version. A review MUST name
immutable bytes: commit range, or artifact path and content hash. Send the brief
and evidence as content the peer can retain, not only a path into a disposable tree.

Verification that writes to a shared checkout MUST be isolated or serialized.
Tests, formatters, generated files, and Git state can cross file boundaries.

## Challenge claims

Open a substantive reply with the finding or the check performed, not with an
appraisal of the peer's work.

Each seat MUST inspect the task and relevant primary material, steelman the
peer's position, then test its strongest consequential assumption. Do not invent
an objection. An honest clean result is “no objection found after checking X,”
where X is a check relevant to the claim.

Every substantive agreement MUST name its supporting observation, source, or
explicit reasoning. Unsupported “I agree” or “looks good” is a protocol violation
the peer may bounce. A changed position MUST name what changed the assessment;
evidence-bearing reversals in `/tap:discuss` follow its new-evidence guard, while
judgment changes name the better argument.

### A clean assessment

For `/tap:discuss` with no objections, the challenger MUST propose one clean-result
item: “no objection found after checking X,” with the checked evidence. The driver
incorporates that result into the versioned assessment report; closing the item
as `resolved_by_revision` refers to that report, not a change to the reviewed work.
This records a completed assessment without inventing a defect or leaving an empty ledger.

Use `/tap:discuss`'s two proposal payloads, `add` then `transition`, and fold both in
one `fold.sh` invocation. The challenger proposes; only the driver writes the ledger.
With `discuss_scripts` pointing at the loaded `/tap:discuss` skill's `scripts/`, the
fold applies these exact ledger calls (do not repeat them outside the fold):

```bash
bash "$discuss_scripts/ledger.sh" add "$thread" clean proposed evidence_bearing \
  "$checked_ref" "$clean_result" --by "$driver" --source-msg-id "$add_payload_id"
bash "$discuss_scripts/ledger.sh" transition "$thread" clean resolved_by_revision \
  "$report_ref" "$clean_result" --by "$driver" --source-msg-id "$close_payload_id"
```

The `add` proposal uses `item_id: clean`, `status: proposed`,
`evidence_class: evidence_bearing`, `evidence: checked_ref`, and
`rationale: clean_result`; the `transition` proposal uses the same item,
`new_status: resolved_by_revision`, `evidence_ref: report_ref`, and
`rationale: clean_result`. References MUST name the checked material and the
assessment report's version. Then run the existing convergence helper; the
receipt must show one closed clean-result item and no pending proposal.

## Resolve and close

The ledger owner MUST record each material objection and its evidenced
disposition in the selected shape's records. Accepted corrections remain open
until reflected in the artifact. Unprocessed peer proposals or pending reviews
prevent convergence; silence does not close a finding.

At the cap, the ledger owner MUST return unresolved items and a recommendation to the decider.
A cap exit or pending human decision is not convergence. Report a constraint
that only the user or leader can resolve without guessing an answer for them.

A convergence claim MUST require both the agreed deliverable and a drained
issue ledger. For `/tap:pair`, check the unit findings and remaining review
obligations; for `/tap:discuss`, fold pending proposals and run its convergence
helper. A helper's success does not supply missing completion evidence.

The ledger owner MUST send the terminal result to the peer, naming the artifact
version, verification, and remaining limits. The receiving seat MUST keep the
original order open through negotiation and work, then close it with a plain
`tap reply <original-id> -f <terminal-file>` carrying that terminal evidence.
When a human started the collaboration,
the initiating seat MUST report back in its own words: the artifact, what was
disputed and how it resolved, and remaining limits. Stop when the agreed work is
complete; alignment does not grant publication or replace an independent gate.
Follow `/tap` for settlement and keep doing useful independent work while
a reply is pending.
