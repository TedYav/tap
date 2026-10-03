# Cancellation (tap-pe56: dead obligations to vanished seats) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0129 start=835709 end=842045 sha256=9fbaeeee607f6401e179d404bcf9969f9c5053fc22a7c839999e61bfa49d975c fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Cancellation (tap-pe56: dead obligations to vanished seats)

**Courier withdrawal of replaced-instance spool custody (tap-x2vuk).** Before
planning either drain phase, the courier may withdraw an entry whose bound
registry now has a newer `registered_at` than the entry's `first_spooled_epoch`
and a nonempty instance different from the envelope recipient-instance stamp.
Matching instances and explicit adoption grants remain eligible under their existing policy. Adopted-forward envelopes
are excluded: their stamp and first-spool clock belong to the predecessor, so
the available chronology cannot establish replacement of the successor instance.
Unstamped entries are excluded: idempotent re-registration refreshes
`registered_at` while preserving the instance, so chronology alone cannot prove
replacement. Missing, malformed or future timestamps, missing rows, uncertain team binding, and
already delivered or harness-queued entries do not authorize withdrawal.

The decision is rechecked under the existing registry and metadata locks while
the caller holds the obligation lock and a non-stealing spool claim. The body is
retained at its canonical path and an existing-format `.cancelled` receipt records
`by=courier`, `reason=instance_retired`, and the checked registry. Only then may
native `removeEntry` retire queue custody. A conflicting canonical or failed receipt
write keeps the spool intact. Before notice publication, the cancellation receipt
records a durable `notice_id`. Use `<id>-recipient-retired` unless that path holds
conflicting bytes and has neither notice attempt nor delivered/settled evidence;
in that case use `recipient-retired-<sha256(original envelope)>`. The fallback has
a fixed length regardless of the original ID. If the legacy payload filename
exceeds the 255-byte component limit, select the bounded fallback before probing
any legacy-derived path. Cross-runtime obligation locks preserve the existing
`obligation-<sanitized-id>.lock` path for IDs up to 239 characters; longer IDs use
`obligation-long/<sha256(sanitized-id)>.lock` under the same lock root in Bash and
Bun. The separate directory prevents short literal IDs from aliasing hashed keys,
and Bun uses a short handshake-marker name when appending it would exceed the
component limit, without changing the lock inode. Preserve every existing receipt
field when adding `notice_id` to an older cancellation receipt.

Retries reuse the recorded ID, even if the initial conflict disappears or the
selected notice payload is removed. Existing legacy notice attempt or delivery
evidence pins the legacy ID: uncertainty cannot authorize a new wake identity.
Publish complete bytes without replacing existing paths. A conflict at the
selected ID retains spool custody and reports incomplete retirement until that
conflict is resolved; unrelated bytes are never overwritten or submitted as the
notice. A successfully published fallback allows custody removal despite the
original conflict. The cancellation receipt already removes the original
obligation from outstanding. Candidate entries are excluded from readiness probes
for that drain pass even when custody or publication is unavailable.

A durable courier notice on the sender bus records the withdrawal without
claiming that earlier possible delivery did not happen. It preserves the original
sender's instance stamp; the existing one-shot notice submit may wake only a
still-matching sender instance. With no original sender-instance stamp, no
addressed notice is published; the cancellation receipt and original body remain
on the sender bus. A missing or replaced sender is not substituted
with the current occupant of its handle. No `.done` is written and prior delivery
evidence is preserved. This is not missing-row cleanup, a registry migration,
or a new operator bulk-delete verb.

Candidate discovery replies start with an explicit `ok` marker, including a
valid empty list. Exit zero with empty stdout is not evidence of zero candidates.
With an acting registry resolved, an unavailable runtime, failed discovery or
invalid response aborts the drain before ordinary planning; failures before
discovery create no per-entry attempt record. The diagnostic names the
`spool-retired` slice. Only valid candidate IDs reach withdrawal. Per-entry
withdrawal failures remain tolerant and preserve custody. If the acting registry
cannot be resolved, retirement is skipped and the existing drain path is retained.

`tap cancel <id> [--by <me>] [--team <name>] [--spooled] [--json]` is a sender-side escape hatch for a send the addressee cannot settle — because the seat is gone (suspended or unregistered), the stamped recipient instance has retired, or the send is still PARKED IN THE SPOOL and has not reached them. It archives the payload and writes a `.cancelled` receipt **distinct from `.done`**:

**Cancellation and native placement share one exact-ID critical section.** Bash `cancel` and Bun canonical placement, reply, and done acquire a kernel flock at `<lock-root>/obligation-<sanitized-id>.lock`; `<lock-root>` is the pane and obligation lock root resolved as `evolution/protocol-evolution-part-18.md` ("Pane and obligation lock roots") defines it, and the sanitizer maps every character outside `[A-Za-z0-9_.-]` to `_`. Acquisition failure or timeout refuses the operation; no path proceeds unlocked. Cancel acquires before its first `.done`, `.cancelled`, payload, or spool observation and holds through archive/spool effects plus the `.cancelled` receipt. Native placement acquires before duplicate and terminal checks and holds through canonical rename plus `.placed`; read and reply settlement hold the same lock across eligibility, reply effects where applicable, and `.done`; the public done alias is refusal-only. A placement therefore cannot land between cancel's payload move and terminal receipt.

Bun uses `/usr/bin/lockf` on macOS and util-linux `/usr/bin/flock --exclusive --no-fork` on Linux for pane, obligation, registry, path, and spool-owner serialization. Both use kernel `flock(2)`, sharing sidecars with Bash/Python `fcntl.flock`. Helper waits are bounded; acquisition requires the existing command handshake, release terminates the held child, and spool owners run under the same helper without a pre-probe. Missing helpers refuse operation; sidecars are retained and no unlocked fallback is allowed.


