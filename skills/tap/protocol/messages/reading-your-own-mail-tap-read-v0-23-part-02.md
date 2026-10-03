# Reading your own mail (`tap read`) (v0.23) — source part 2 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0048 start=308928 end=316546 sha256=9077d86721ecd95c799d2faf99adb43694abdb7cc64b2ea4497f9488ac75bbc3 fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Residency precedence is `payloads` > `archive` > `quarantine`, and a quarantined name need not be a
live id.** One id can legitimately name a file in several residencies — `payloads/<id>.md`,
`archive/<id>.cancelled.md` and `.quarantine/<id>.md` are different names — so a re-send or a
corrected retry coexists with the older artifact. Resolution folds to the highest residency present
rather than refusing the set as ambiguous: refusing stranded a valid obligation the recipient could
neither read nor settle, because this resolver serves `tap read` and an unresolvable id is a stuck
message rather than an unhelpful `tap show`. Lower-ranked artifacts stay reachable through their own
residency, ambiguity WITHIN the winning residency still refuses (two live payloads are a real
question), and settlement semantics are untouched — a `.cancelled` receipt is still terminal, so
preferring the live file never resurrects a withdrawn obligation.

**An id is an address; residency is that address's STATE.** `payloads/<id>.md`,
`archive/<id>.cancelled.md`, and `payloads/.quarantine/<id>.md[.N]` are one id in three states, produced
only by verbs that MOVE a file (`tap cancel`, quarantine) and never by a second mint —
`canonicalPlace` (runtime/bun/src/courier.ts) refuses a duplicate id, so no two messages ever share one. Preferring the live
state therefore chooses the state a reader owes something on, not between messages. Two ids that share
a 12-hex suffix are two addresses, and a short name is an address only while it is unique (§IDs): they
refuse. (Architect ruling, 2026-09-04.) `tap show` discloses what the fold hides: after the winner it prints one
`also: <residency> ×N (<example path>)` line per lower-ranked residency that holds the same logical id on the resolved bus, in
rank order, with the newest numbered quarantine sibling as the example (e.g. `also: quarantine ×2
(payloads/.quarantine/<id>.md.1)`). It is a read-only sibling scan on that one bus, so the winner, ambiguity, and cross-bus
behavior are unchanged; `tap read` prints nothing about it, being the recipient's working surface (tap-vv7s3).

**The precedence is applied PER BUS, and per logical id within a bus.** The rank says what a reader owes on one bus, so it must not
reach across one: applied globally, another team's live payload silently suppressed the caller's own
quarantined evidence at the same id. Each bus folds to its own highest residency. Exact own-bus payload and digest
addresses take precedence (tap-7r3fn.3.3); otherwise ambiguity runs over the survivors.
A 12-hex suffix always searches all buses and refuses cross-bus collisions. Addressing an id as
`<team>/<id>` scopes the search to one bus and is how a suppressed lower-ranked artifact is reached
deliberately.

**A quarantined name is addressable whatever it is.** Re-quarantine collides to `<name>.md.N` for a
name that fails the live-id grammar exactly as for one that passes it, so the exact-basename door
collapses those siblings too and surfaces the newest — a base-only lookup returned the oldest
evidence, then nothing at all once the base was cleaned away. Because a malformed canonical may also
be named like a flag, `tap show` and `tap read` accept `--` as an end-of-options separator; an
unknown option BEFORE the separator still refuses.
Separately, the quarantine is addressable by **exact basename** even when that name fails the live-id
grammar: a malformed canonical may be named anything, and the quarantine notice prescribes `tap show`
on it. That widens what may be NAMED, never where the resolver looks — no suffix scan, no globbing,
and a path-separator or `..` argument refuses.

**`tap read` holds the exact-id obligation lock, and fences the bus it will write.** Reading is a
settling verb, so it shares `tap cancel`'s cross-runtime critical section: the lock is taken after
resolution, the payload is re-resolved under it (a lock proves nothing about state sampled before it
was held), and it is retained through the receipt write and the body read. Without it a read could
land `.done` after cancel's terminality check and leave two contradictory terminal receipts. The
reset fence is checked twice for a different reason: the ambient guard covers the CALLER's bus, where
the forced-read audit event lands, and a second guard covers the RESOLVED bus, which for a
cross-team read belongs to someone else and must not be written mid-reset.

**`--force` overrides verified mismatches only.** The two it overrides — the addressee handle and a
`recipient_instance` that was read and did not match — are facts about the caller that a recorded
override can sensibly contradict. It never overrides a fact about the mail (team ownership, envelope
validity, the id/filename agreement) and never overrides the *inability to check*: an invalid or
unreadable flip marker and an unreachable acting registry both refuse under force, as the private reply settlement primitive and
`tap reply` do, because overriding "I could not verify" is an unrecorded decision rather than a
recorded one.

**Gates that turn on facts no concurrent verb can change — envelope validity, id/filename agreement,
team ownership, a sanctioned reply expectation, the addressee — refuse before the obligation lock**, so
a refusal never waits on, or is turned into `obligation_busy` by, an unrelated verb. Gates that read
lock-protected state (terminality, residency, the instance binding) refuse after it. A lock file is
scratch, not bus or registry state; the writes-nothing promise is about the latter two. (Architect
ruling, 2026-09-04. `tap cancel` already satisfies this — its only pre-lock gates are id and actor
validity, and everything below its lock IS lock-protected state. `tap reply` takes no obligation lock,
so the rule is vacuous there.)

**Quarantining either protects the evidence or says it did not.** Marking the bus generation reused is
part of the move's success contract, not a best-effort afterthought: a generation left `pristine`
still admits `tap team restore` over bytes the quarantine just preserved. Three outcomes are distinguished rather than
two: moved-and-marked, nothing-to-move (the source was already gone — an ignorable race), and
FAILED — the directory could not be made, the move failed and the payload is still live, or the move
landed without its generation mark. Only the first is counted clean; the last is named separately on
stderr by every verb that quarantines, on every branch that quarantines. Collapsing the third into
the second is what let a real failure read as "somebody else handled it".

**A refused read writes nothing anywhere.** The refusal contract is about the whole call, not the
leaf script: dispatch skips restart reconciliation for `read` as it does for `show`, so a stale
server boot cannot clear pane coordinates before the verb's own gates refuse. A read that CREATES
a receipt consumes the reset generation (`tap_reset_generation_touch_bus`), so a post-reset read
cannot be replayed over by `tap restore`; a re-read of already-observed mail mints nothing and
touches nothing. Settlement receipts carry adoption provenance: an envelope stamped
`to_adopted_from` settles with `adopted_from` recorded beside `by`/`via`.

**Already settled is a designed case, not a refusal.** An item may already have a recipient receipt or a historical courier receipt; neither is rewritten. Ordinary `tap read` prints its compact `settled` header and the body, rewrites nothing, and exits 0.

**Ordinary output** is `tap read: ask|note <id> from=<sender> reply|settled`, then the body, with no discharge tail; `--force` retains its fuller recorded output. The envelope and the receipt chain are `tap show`'s.
Resolution and cross-worktree behavior are `tap show`'s too, through the same shared resolver: local
bus first, then every enrolled team bus, and the receipt lands beside the sender's canonical payload.

