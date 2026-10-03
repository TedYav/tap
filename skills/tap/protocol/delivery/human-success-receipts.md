# Human success receipts

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0126 start=831115 end=832918 sha256=56b3097d593c3bbf197fbce694b3c7e4b5e2c2fca3db8bdbe829b92436eebc9b fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Human success receipts

Default human output states the transport result once. `send`, `assign`, and `resend` print `tap <verb>: ok|queued <id>`; `reply` names the inbound id, and progress prints `tap reply: progress <id> (open)`. `ok` reports transport success, not recipient processing. `queued` reports durable acceptance. Existing `-v`/`--verbose` retains transport detail; JSON fields and durable receipts keep their existing meaning.

A routine read prints `tap read: ask|note <id> from=<team/handle> reply|settled` followed by the full body. The team qualifier appears when present. An open ask says `reply`; reading it does not settle it. Notes and previously terminal items say `settled`. Forced reads retain the force marker and recovery guidance. `show` remains the envelope and receipt inspection surface.

Empty poll prints exactly `tap poll: empty`. A digest index lists its id, item count, and each item's id, sender, obligation, and terminal state. `read --all` prints each item header and body once, without first repeating the manifest. Item failures remain visible and nonzero; the digest envelope is never settled. The retired public `done` command still refuses and names the repair.

Routine success stderr is empty. Actionable fallback, invalid authority, partial completion, audit failure, timeout, and submit uncertainty remain visible by default. A possible effect never earns an unconditional resend instruction.

Fixed metadata budgets, including newlines and both streams, are 32 bytes plus id for send/reply/assign/resend, 40 plus id for progress, 64 plus id/sender/body for read, 16 total for empty poll, and 224 plus ids/senders/bodies for a three-note digest. The fixed-fixture control measures full totals and metadata separately through both public runtime doors.

