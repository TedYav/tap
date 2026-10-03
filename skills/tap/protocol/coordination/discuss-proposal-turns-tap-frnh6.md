# Discuss proposal turns (tap-frnh6)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0132 start=850956 end=853094 sha256=c588305905761dfa84f58cd68ca37b5ef809a428bc7486261fe4809b032c30c9 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Discuss proposal turns (tap-frnh6)

The orchestration consumer in `skills/discuss/scripts/` accepts one proposal ask
per peer turn. Core transports its Markdown body unchanged. The body names the
thread and carries reasoning plus one fenced `json` object `{"ops": [...]}` with
a non-empty array of `add`/`transition` objects. The parser
(`skills/discuss/scripts/payload_meta.py`) also accepts a body that begins
with `{` as raw JSON, and a single op object (no `ops` key) in either place: raw,
or as the one fenced `json` block. A single op is bookmarked by the payload id;
batch op `i` is bookmarked `<payload-id>#<i>`. Multiple JSON blocks or empty
batches fail loud. `add` requires string `item_id` and `evidence_class`, with `status` defaulting
to `proposed`; `transition` requires string `item_id` and `new_status`. Optional
evidence/rationale fields are strings. The ledger owns valid statuses/classes and
reversal evidence. A turn with no ops is an ordinary reply, not an empty proposal.

An answering proposal uses `tap reply <id> --expect-reply --kind proposal -f <file>`:
it settles the previous ask and creates one new reply obligation. With no inbound
ask, use `tap send <driver> --ask --kind proposal -f <file>`. The driver's single
reply combines per-op fold results and the next turn or terminal. A continuing
turn requests a reply; a terminal does not. No per-op TAP receipts are owed.

`fold.sh` validates canonical body/from/kind and courier placement provenance,
then applies operations in order through `skills/discuss/scripts/ledger.sh`.
Batch op `i` uses `<payload-id>#<i>` (zero-based) as the successful event's
`source_msg_id` and its entry in `processed_payload_ids`; legacy single-op bodies
keep the payload ID. The original payload ID remains the message/evidence identity.
A malformed or rejected op stops that payload, leaves the unapplied tail pending,
and returns nonzero with per-op results. Successful prefix operations stay applied.
Only a fully applied batch earns a whole-payload bookmark. Re-fold and
`is-converged.sh` use validated ledger source IDs as well as saved bookmarks to
recover after a crash between append and bookmark save. Missing or malformed
operations never count as completion. Thread state and these semantics belong to
the discussion consumer; the separate TAP collaboration ledger below is unchanged.

