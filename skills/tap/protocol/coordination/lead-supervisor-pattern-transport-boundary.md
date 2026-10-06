# Lead-supervisor pattern (transport boundary)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0131 start=849419 end=850956 sha256=3620282894d97e3d53acbdbafa10dd89433853c2394cc4a93e5e8216aa5e3a80 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Lead-supervisor pattern (transport boundary)

TAP transport does not prescribe a Lead role, persistence mechanism, cadence, or supervisory loop. Its coordinator-facing invariants are transport-only:

- Sent payloads remain observable until settlement through `tap outstanding`; receivers drain inbound work with `tap poll`, `tap read`, or `tap reply` before stopping.
- `tap nudge` runs one unstick ladder ([nudge](../delivery/nudge.md)): dismiss one allowlisted blocker, give a complete staged sentinel that is alone in the composer exactly one Enter after recipient and pane-identity checks, or interrupt a registered seat's bound pane and submit the id-less `[[TAP v0.23 nudge]]` doorbell once. A draft or unreadable composer holds it with no key. Inspect a stopped peer’s pending message with `tap show <id>`; `tap resend <id>` permits a fresh labeled delivery only with affirmative no-attempt proof, and `--wake` does not bypass the delivery window.
- Nudge addressing mirrors `tap send`: bare peers resolve locally and team-qualified peers resolve through the machine index. For a staged v0.23 ask or note sentinel, nudge corroborates the visible id against its payload and the argv target’s resolved team; a team-qualified id retains that team scope. `--pane` may supply the candidate address but supplies no cross-team identity on its own and never bypasses the sentinel-bound checks or reaches the doorbell rung; an unresolved or disagreeing target is a clean error.

For the orchestration procedure, including attended and unattended/backburner supervision modes, load `/tap:lead` and `skills/lead/references/supervision.md`. §Supervision kinds owns `tap watch` CLI and lease semantics. This boundary is documentation-only: courier, CLI, and settlement behavior do not change.

