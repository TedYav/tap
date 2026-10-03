# Message inspection (`tap show`) (v0.23)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0049 start=316546 end=321518 sha256=73534bed945e003003ae273d6ad46e6704ba601dd85ea30696f49f4b4d012721 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Message inspection (`tap show`) (v0.23)

`tap show <id|team/id|12hex>` is the human-forensics surface. It exists so that inspecting a message
and discharging one are different acts performed by different verbs, split on the side effect rather
than on a name: **`tap read` is the recipient's verb and writes a receipt; `tap show` is everyone's
and writes nothing.** That is what lets `tap read`'s `to≠me` refusal point somewhere useful, and what
keeps full message inspection off the wire. Explicit display previews are opt-in
(§Sentinel); a reader still opens the payload to learn what it says.

**Mechanically incapable of acking.** `tap show` takes no actor, requires no registration, and has no
flag that makes it write. The guarantee is about the whole call, not this verb's own body: `show` is
listed with the verbs that skip the pre-dispatch registry reconciliation, it is exempt from the
overdue-inbound advisory (which resolves a self-handle), and it never calls `Bus.ensureDirs`, the
opportunistic spool drain, the reset fence, or the reset-generation touch. It therefore does not
create a bus root that does not already exist. `show-verb.test.sh` holds this to a full manifest —
relative path, content hash, and sub-second mtime — of every writable state root, taken around the
FIRST invocation, because the writes worth catching here are one-time and idempotent and a later
snapshot pair brackets nothing.

**Output.** The payload's absolute path; its team, when the payload was reached through another team's
bus; its full frontmatter verbatim, instance stamps included (§Keep-list keeps those off the WIRE; this
surface is where a forensic reader comes to find them); the receipt chain; then the body.

**The receipt chain is `placed`, `read`, `done`, `cancelled`** — each rendered with the timestamp it
stored and whichever of `by`, `via`, `identity`, `forced`, and `reason` it carries. A payload with no
receipts says so rather than printing an empty block. `.cancelled` is in the chain because it is a
discharge (`tap_is_done` is `.done` OR `.cancelled`): a cancelled payload showing an empty chain would
read as "nothing ever happened here" for the one class where something conclusive did.

**`.sent` is deliberately NOT in the chain**, and this is a contract statement rather than a rendering
preference. `tap_write_sent_receipt` records no `at` field at all, so an entry for it could only
present file mtime as protocol time; and it carries `turn=unconfirmed`, which means the courier saw
the sentinel leave the input band and nothing more (§turn=unconfirmed). Rendering it beside receipts
that mean the recipient acted would assert delivery the transport explicitly refuses to assert.

**Resolution.** The local bus first, then every enrolled team bus from the machine index. A
`<team>/` prefix names one bus directly — the same address grammar `tap send <team>/<handle>` uses,
so a qualified id pastes in verbatim. An id resolving on two buses at once is a filename-collision
anomaly and refuses rather than picking one. Unknown id, unknown team, and an argument that is
neither a valid id nor a 12-hex suffix each refuse with their own error class.

**An EXACT id is validated against `TAP_ID_RE`, not against the minted grammar.** Those are different
questions. `tap send --id` accepts any `TAP_ID_RE` token, so a live bus carries ids the §13 minted
shape rejects, and checking the exact-id door against the minted shape makes `show` answer "no such
payload" for a file it is looking straight at. The minted grammar is the right rule for deciding what
a 12-hex SUFFIX may attach to, and the wrong rule for deciding whether an id exists. What makes a
suffix right-anchorable is the minted id's two fixed-width TRAILING fields — the 16-character UTC
stamp and the terminal 12 hex — not the charset of the handle in front of them: `mintId`
validates its sender against `TAP_ID_RE` and prints it verbatim, so `Mixed.Case-<stamp>-<hex>` is an
ordinary minted id and the suffix rule must accept the current handle grammar rather than §13's
future narrowing. A bare 12-hex argument is therefore matched **right-anchored** against that last
field and never against a hex run earlier in the name (§IDs); it also opens the exact-id door, because a file
may legitimately be named for that token, and the union of both refuses on ambiguity, naming every
candidate — a short name is an address only while it is unique.

**Canonical, spool, archive, and quarantine residencies are searched by `show`.** `tap cancel` MOVES the canonical payload to
`<bus>/archive/<id>.cancelled.md` rather than deleting it, so on a real bus a cancelled id is absent
from `payloads/`. `show` looks in both and labels an archived hit `residency: archive`. Without that,
the `cancelled` chain entry above would be unreachable in production and visible only in a fixture
that left the payload in place — a state the verb it documents never produces.

