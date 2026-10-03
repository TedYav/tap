# Reading your own mail (`tap read`) (v0.23) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0047 start=300184 end=308928 sha256=1ac168f0f3e663a4bdd7dd55610a47f64c6dcc86d9402e9dab24ba9a0a0c5891 fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Reading your own mail (`tap read`) (v0.23)

`tap read <id|team/id|12hex> [--force] [--by <me>] [--team <name>]` is the RECIPIENT's verb and the
other half of the side-effect split. The discriminator is the side effect, not the name: an ack that
is not required is worse than useless, but if an agent reads its payloads through the CLI anyway the
ack is free — so the verb that acks is the one only its addressee may run, and everyone else is
pointed at `tap show`.

**Parked mail is readable before its doorbell.** `tap poll <me>` lists canonical
items first, then eligible parked items ordered by first spool time. Parked rows
say `queued`, include the existing queue explanation, and name `tap read` as the
next step. JSON parked rows add `residency: parked`, `reason`, and
`queue_explanation`. Eligibility uses the same local-team and recipient-instance
predicate as canonical inbox mail, plus the spool metadata's target. Poll does
not move or deliver queued bytes; malformed parked entries are warned past and
remain with the queue. `tap outstanding` retains its outbound-only semantics.

A recipient's `tap read` resolves a parked id, suffix, or explicit pointer and
passes the existing immutable envelope, team and addressee/instance gates before
creating a lock or claim. For parked mail, neither `--force` nor predecessor-note
retirement overrides those gates. Under the obligation lock, the queue observes
the entry claim. Broken claim evidence — malformed, non-regular, unreadable, or
stale — refuses immediately with `spool_busy`. A settle-only note waits, bounded
at the same lock-scale ceiling, for a valid live claim to hand off, then
acquires a non-stealing claim, revalidates authority, promotes without
overwriting canonical bytes, removes the spool entry, and holds the claim
through receipt publication; a claim that never hands off within the ceiling
refuses with `spool_busy` and nothing is settled. If the prior owner promotes
the entry to canonical custody during the wait, the same read continues on that
current residency and settles once — it never manufactures a claim for an
absent entry. The same narrow continuation applies if promotion completes while
read waits to acquire the obligation lock: the spool body must be gone, the
refreshed envelope and current recipient authority must pass again, and other
residency changes still refuse.
An ask (`reply: expected`) keeps the incumbent behavior: an
existing claim refuses immediately, with no wait and no receipt. The ordinary
reader then writes its normal note or ask receipt. There is no pane effect and
no `.attempted`,
`.placed`, or `.sent` receipt; the waiter observes the removed entry and exits.
The custody operation marks the reset generation reused independently of whether
the ordinary reader creates a receipt, so an existing receipt or a later receipt
write failure cannot leave newly promoted mail eligible for restore.
Canonical residency wins over an old spool sibling, and duplicate reads retain
the first observation receipt. Queue timing remains a schedule, not a delivery
promise. Both dispatchers use one Bun inbox row formatter; Bash retains custody.

**Two obligations, two outcomes.** A NOTE (`reply: settle-only`) settles on read: `.done` with
`via: read`, and no `.read` beside it — one receipt per discharge. An ASK (`reply: expected`) writes
`receipts/<id>.read` and stays OPEN, because an ask has exactly one discharge and it is `tap reply`.
**An envelope with no `reply` field reads as an ASK** (§Reply expectation), so a look never settles a
question that was never marked settle-only.

**`.read` is an observation, never a discharge.** `tap_is_done` stays `.done` OR `.cancelled`. If a
read counted as settlement, a sender's `tap outstanding` would fall quiet while the question it is
waiting on remains unanswered. The sender sees `read <age>, unanswered` instead — an observation, not
an obligation met.

**First observation wins.** A second read writes nothing, so the receipt records when a message was
first seen rather than how many times it was opened, and re-reading after a compaction or a restart
is never something an agent has to weigh.

**Identity, and how it was established.** Resolution is `--by` > `TAP_SELF` > pane-derived, the same
ladder the private reply settlement primitive uses; `--by` is the declared-identity convention §Poll-mode delivery class already
depends on, since a pane-less seat has no pane to resolve and its registration IS its identity claim.
The receipt records WHICH door was used — `identity: pane` with the observed pane, or
`identity: declared` with no pane field, because inventing one would make the receipt assert more
than the resolver knew. A reviewer can then tell an observation from an assertion.

**`--force` changes authorization, never identity.** The `to≠me` refusal is a helpful guard, not a
security boundary, so it teaches all three doors: inspect with `tap show <id>`, or read on their
behalf with `tap read <id> --force`, which is RECORDED — reader handle, identity, pane, `forced: true`,
plus a registry event. `--force` overrides exactly two checks: the addressee handle, and a stale
`recipient_instance` binding. It never lets a reader claim to BE the recipient: the receipt records
the reader. The instance binding changes only after a `--fresh` registration or a `tap out` +
`tap in` pair (a same-handle rebind KEEPS the instance, tap-register §rebind), so a mismatch on the
wire means predecessor-bound mail, not a race. `--force` never overrides team ownership, envelope
validity, envelope-id/filename agreement, quarantine residency, or **the v0.20 authority marker**:
`tap_v20_obligation_live` is evaluated unconditionally BEFORE the force decision, exactly as `tap
done` does, so a forced read over an absent, invalid or unreadable flip marker refuses
(`unanchored_bus` / `invalid_flip` / `marker_unreadable`) and writes nothing.

**Force on an ask is observation only.** A forced read of an ASK writes `.read` (reader, forced,
addressee) and the ask stays open — force confers no reply authority, so the discharge tail names
the DOORS instead of `tap reply` (which would be refused): the sender's `tap cancel <id> --by <from>`
always, and the actor-side clearing path only where the shared remedy helper computes it as free —
`tap in <h> --restore <inst>` only when the rejected instance is a tombstone under the ACTOR's own
handle and the handle holds no current seat, the LOOK (`tap team`) when one does, and never a
copyable `tap out`. Where the helper computes that NO actor-side door exists, the tail says so and
does not describe one — the common shape, since locally adopted mail binds to the released fork's
instance and reclaim adoption writes no tombstone for it under any handle, leaving the sender's
cancel as the only door. `tap reply`'s instance refusal names the same doors, appends a clearing
door only when one exists so `next:` stays one runnable command, and does not name `tap read
--force` (a forced read settles nothing, so that string is a loop). A forced read of a NOTE settles
as the READER — `.done via: read`, `by` the reader, `forced: true`, `to` the addressee — which is
the teammate-clearing case §read's force exists for, bounded to notes.

**An ARCHIVED payload is terminal, receipt or no receipt.** `tap cancel` archives the canonical and
writes its `.cancelled` receipt as two steps; interrupted between them the payload is in `archive/`
with no receipt, and `tap read` treats that residency as the settlement — it writes no new
observation and never tells the recipient to answer a withdrawn ask. The FILE's location is the
older fact and survives the crash that lost the receipt.

**A quarantine move consumes the reset generation**, exactly as a settlement receipt does: relocating
a malformed payload and appending to the quarantine `.log` are first mutations of that bus, so a
later `tap team restore` must not be admitted over them and discard the preserved evidence. For the
same reason `tap outstanding` — which quarantines malformed OUTBOUND payloads — refuses at the reset
fence like `tap poll` does. A verb's membership in the fenced set follows from whether it can write,
not from what its name suggests.

**Only `expected` and `settle-only` name an obligation.** An absent `reply` field is v0.2 traffic and
reads as EXPECTED; any other value is neither, and the rows that display it say so rather than
rendering it as a note: poll prints the raw value with a `reply_invalid:` marker and, instead of a
protocol next step, tells the reader to inspect the envelope. `tap read` refuses to guess. A "note"
label would tell the sender no answer is owed for mail the recipient's own verbs reject.

An unsanctioned `reply:` value is **not** a quarantine trigger on either door — `validateEnvelope`
checks `id`, `from`, `to`, `kind` and `path`, not `reply`, so such a payload is displayed rather than
moved. Quarantine has exactly two triggers, an invalid envelope and an envelope-id/filename mismatch,
and it is live through both runtime entry points for `tap poll` and `tap outstanding` (see §Row shape).

**A printed next step carries the context it was printed in.** `tap read`'s ask tail repeats the
effective `--by` and `--team` exactly when the caller declared them, as `tap poll`'s hint does; a
pane-less seat that pastes the printed command must not meet `no_actor` or a different bus. The
matching rule for refusals is that the named action must SETTLE the obligation it is about: `tap read`
for a note, `tap reply` for an ask, wherever a refusal names a recovery.

