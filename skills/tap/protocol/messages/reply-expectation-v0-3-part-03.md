# Reply expectation (v0.3) — source part 3 of 4

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0045 start=287924 end=293613 sha256=606a80549be3771ecf390ab0815676838a2acb8d9c6d71fde2bbeaf79a9d65e6 fragment=3/4 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
Settlement records durable acceptance, not pane observation. If a spool-queued reply later encounters pane-gone or identity drift during redelivery, the courier keeps the spool entry; a deadline-bearing entry eventually escalates, while a deadline-free standard entry remains age-visible through `tap doctor`/`tap outstanding` and retries when ready. Neither path deletes or reopens the original inbound `.done`. The original sender must not interpret settlement as proof that the answer reached the recipient pane.

For exits 0/5, `tap reply` takes the outbound `id`, `path`, status, and disposition from `tap send --json`, then passes the path to the shared settlement writer. An injected, poll-queued, or exit-5 reply is read from canonical `payloads/`. A spool-queued reply is accepted only from `<bus>/spool/<id>.md` with a matching courier metadata sidecar; its envelope `path` must name `<bus>/payloads/<id>.md`, its metadata target must match envelope `to`, and a concurrent spool-to-canonical move is followed only to that exact sibling path. The writer then requires filename/envelope agreement and `in_reply_to == <inbound-id>`, derives `reply_sha256`/`reply_preview` from the disk body, and atomically writes `via: reply`. Missing, forged, malformed, or mismatched evidence leaves the inbound unsettled.

`reply` is path-aware: an `<id>` settles on the local bus; a path (positional or `--payload`) settles on the **sender's** bus (writes `.done` beside the foreign payload). A bare `<id>` that misses the local bus is first resolved across every enrolled team bus (payload filenames are globally unique — tap-akt4), so the universal `tap reply <id>` reflex settles a cross-worktree obligation on an enrolled peer's bus without the sentinel path; a miss on the local bus AND every enrolled bus then teaches the complete recovery `tap reply <id> --payload <abs-path-from-sentinel-path-field> -f <file>` (the authoritative override for an un-enrolled peer, tap-j20w) — the positional id and a message source are part of the taught command, since `reply` refuses without them, and an id resolving to more than one bus refuses (`ambiguous_payload`) to disambiguate with `--payload`. A team-qualified payload refuses unless its `to_team` matches the replier's local bus team and its `to` matches the actor. It reads recipient/sender/receipt-destination from the envelope — no `done`-only flags to recall — and refuses an already-settled inbound (`error_class=already_settled`, naming `tap send` for a fresh message) while reporting the receipt time and actor's open inbound ids on that bus. Exit codes mirror `send`: `0` replied+settled (injected or queued) · `3` pane-gone · `5` submit-unverified (inbound settled) · `1` refusal/usage/other.

**Cancellation of a running reply (tap-27grp):** INT, TERM, or HUP received while waiting for send stops the active send's private process group, reaps its leader, removes the reply wrapper's capture files, and exits130,143, or129 without entering settlement. The send starts in a new session; only that invocation's process group is signalled, never the operator's group or tmux server. Cancellation uses KILL within that owned group so a TERM-ignoring transport cannot continue through a grace interval. The leader stays unreaped until group signalling is complete. A signal during spawn is retained until the child PID is published. Send stdout/stderr use files during the interruptible wait; stdin body input and ordinary send-result settlement remain unchanged.

This stops active invocation work; it does not undo a delivery or durable spool acceptance that already happened, withdraw queued obligations, stop couriers outside that group, or retry an ambiguous effect. A background waiter that still shares the group is stopped; its durable queue entry remains available to the existing recovery machinery. SIGKILL of the wrapper cannot run a trap and is outside this signal-propagation contract.

### `tap reply --progress` obligation retention (tap-kb98)

`tap reply <id|path> --progress -f <path>` (or `-f - <<'EOF'`) uses the same sender, `reply_to`, cross-worktree, and
durable-send path as ordinary reply, but emits a **hard `reply=settle-only`** status and deliberately
does not write the inbound `.done`. The original sender's `tap outstanding` therefore keeps the
original id until a later ordinary `tap reply` settles it. `--progress --expect-reply` refuses rather
than creating a successor obligation; progress also refuses a `reply=settle-only` inbound and an
already-settled id. In a cross-worktree reply, declining settlement means neither the sender bus nor
the recipient's mirrored bus receives a `.done`.

**Staleness invariant.** Staleness of an outstanding send is computed from its **original send time**
and is never reset by progress. A future status surface may show `last_progress_at` alongside that
age as a separate fact; progress is human signal, not a compliance pulse.

### Reply routing (`reply_to`, tap-ywb, v0.5)

Self-directed explicit `tap send --reply-to` is refused: the flag names where the recipient's `tap reply` lands; replies already return to the sender, so omit the flag unless routing answers to another seat's inbox.

An ephemeral or rotating sender (a cron sweep seat, a crew member that gets torn down and re-launched) needs its replies to land on a DURABLE principal, not dead-end at a seat that may no longer exist by the time the answer comes back. `reply_to` is the address for that, and it is deliberately dumb: an address, never a reason — the courier never interprets WHY a sender wants its replies elsewhere (§Envelope, above, for the field's stamping rules).

