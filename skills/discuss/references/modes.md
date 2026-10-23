# /tap:discuss modes (mode-specific ledger rules)

Loaded just-in-time. All three modes share the deterministic loop (`loop-contract.md`) and the driver-owned issue ledger (`skills/discuss/scripts/ledger.sh`, single-writer — peers propose, the driver folds); they differ in what a ledger item _is_ and what convergence _means_.

## plan

Co-author or converge a plan/design with the peers.

- **Ledger items** = open questions, objections, and unresolved decisions. Seed first with the question, source material and current state for each peer's independent position; send the driver's draft candidates only after every reply lands (`loop-contract.md` § Round 0).
- **Disposition** = `accepted` (agreed answer, fold into the plan), `rejected_with_reason` (objection declined, reason recorded), `human_decision` (needs the human), `deferred` (out of scope for this pass).
- **Converged** = every item dispositioned and every `accepted` item folded into the artifact (`resolved_by_revision`). Send `converged` with `--ref <plan>` for the plan.
- Editing the artifact after `converged` is allowed — the terminal names the specific version it covered, and there is no re-attestation step; a later edit is simply outside what the terminal attested.

## review

Adversarial review of an artifact (code, plan, doc).

- **Ledger items** = findings. Each enters as `proposed` with an `evidence_class` (evidence_bearing | assertion_only | judgment), citation-shaped `evidence` (msg id + ref/file:line), and a `rationale` kept separate from the evidence (KD3/F3).
- **Co-triage via propose → fold (KD4/L13):** each peer sends all of its turn's dispositions in one `--kind proposal` TAP payload; the driver folds it (`fold.sh`) before anything is applied. Only the agreed set is applied.
- **Auto-pivot correctness → polish:** while any correctness finding is open, stay in correctness. Once correctness items drain, the loop pivots to polish (style/clarity/naming) findings. Deterministic: gate the pivot on "no open evidence_bearing correctness items", not on feel.
- **Anti-sycophancy guard (F2):** a `rejected_with_reason → accepted` reversal on an evidence_bearing finding fails loud without a newer `evidence_ref` — checked at the fold boundary and replayed at read time. Judgment items are exempt (F5).
- **Converged** = the ledger drains (all findings resolved/rejected/deferred/escalated).

## decide

Resolve a bounded question and return a verdict.

- **Ledger items** = the options/considerations.
- **Bounded authority (KD4):** the agents may recommend, but may NOT force a schema/migration/assertion/merge — those escalate.
- **Output** = a `decision_packet` (see `decision-packet.md`): the question, the options with the decorrelated take on each, the recommendation, and what's blocked pending a `human_decision`. Send it to every peer as `tap send <peer> --wake <packet-file> --kind decision_packet` (or `tap reply <id> <packet-file>` if it answers an inbound); name any artifact it concerns in the packet body.
- Use `decide` standalone, or it's where `plan`/`review` escalate when the round cap is hit with items still open.
