# Registry (Unit 1) — source part 13 of 14

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0039 start=250204 end=258801 sha256=dc71e82d44f8907c4d643a883f226d257c7a3e53ac739620994f51b97c4029f2 fragment=13/14 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Explicit mail handoff (`tap out [source] --forward-to successor`).** Both seats
belong to the acting team. The native transaction holds the reset and acting
registry locks, revalidates registry selection, and publishes source removal plus
one `seat_forwardings` edge in the same atomic registry replacement. Each edge
pins `source`, `source_instance`, `destination`, `destination_instance`, `at`, and
`address_active`. Normal `team-history` tombstones preserve `--list-history` and
`--restore`. Restoring a source instance revokes that edge
(`custody_revoked: true`) in the same registry save, returning recipient and
sender authority to the restored row; the edge remains history. Grant publication cannot succeed without retirement, or vice
versa. Plain unregister retains its existing meaning.

A current source registration owns new address traffic. Registration permanently
clears prior edges' `address_active`, so later plain removal cannot revive an older
address alias. Historical edges remain: a reply to A1's ask follows A1's
`sender_instance` even after A2 registers. A replacement B2 never inherits B1's
custody. An explicit `reply_to` retains its existing address-based precedence and
fallback; it is a separate principal and never borrows the original sender's
instance stamp. Replies to a sender with no explicit forwarding history retain
the existing address-based behavior, including after that sender rejoins with a
new instance. Historical unbound sender routing with a forwarding history refuses
as ambiguous.

Routing and recipient authority share a finite, cycle-checked traversal of
explicit edges. A1→B1→C1 transfers A1's custody to C1 after B1's explicit handoff.
Self/cyclic links, duplicate source-instance grants, repeated retirement of a
reused source name, and a source carrying untransferred reclaim-adoption grants
refuse before mutation. Reclaim adoption alone never creates an address alias.

Successor poll includes delegated canonical and parked inbound on enrolled sender
buses, including custom IDs. Successor outstanding includes predecessor-instance
outbound with its original authorship and distinct delegated-visibility label;
this grants no sender cancellation or impersonation authority. Read and reply
accept the explicit pinned recipient grant and record the successor as actor with
`adopted_from`. Successor reply payloads also carry `adopted_from`. New forwarded
mail records `to_adopted_from` and `original_recipient_instance` while binding its
actual destination through `recipient_instance`.

Ordinary send resolves the forwarding route and places the canonical under one
held acting-registry lock (both registries on a team-qualified route), so a
lock-honoring handoff lands wholly before or after it. Before its first registry
or pane effect, send re-reads the registry and recomputes the same route. A
changed target, instance, `adopted_from` or `original_recipient_instance`, or a
changed destination row instance, `pane_id`, status, status reason or delivery
class, refuses `forwarding_changed` (`retry the send`) with no payload placed
and no pane touched. Send does not re-resolve to the new successor:
that row has not passed the recipient verdicts, and new custody is the sender's
to address. The manual relay reads no registry and is not rechecked.

New team registries use schema `0.20`. Readers also accept team schema `0.21`;
the machine index remains `0.20`. A reader that cannot resolve a forwarding
destination as a local handle refuses to follow that edge or use it as a reply
redirect. An unresolved forwarding route preserves stamped parked mail after
source reuse. A non-revoked edge also protects canonical mail from dead-letter
withdrawal. Existing IDs, bodies, headers, recipient history and receipts remain unchanged.
Handoff never settles, cancels or replays work, including sent, harness-queued or
possibly attempted mail. Parked custody remains discoverable for explicit read;
a live delegation excludes obsolete-instance withdrawal. Unstamped predecessor
mail is diagnosed for inspection, not silently assigned. The separate one-shot
handoff notice points to the successor's live views; failure reports committed
custody separately and does not authorize repeating retirement. Lane ownership,
watch leases and leader/conductor roles each require their own explicit handoff.

**Permanent per-handle teardown (tap-wn9w).** Light `tap unregister` frees a handle while leaving bus traffic untouched. `tap teardown <handle>` archives TAP-visible bus residue and the acting-registry row into `.tap/bus/archive/teardown/<utc>-<handle>/`, then deletes the row. Reopening the same handle is TAP-indistinguishable from first registration. `tap restore <handle> [--archive <id>]` restores that archived row and bus residue and refuses with `handle_live` before any archive moves when any registry row already holds the handle, including suspended, offline and empty rows. Run `tap teardown <handle> --yes` to free the row before restoring the selected archive. Harness-owned transcripts remain outside TAP authority and are never deleted. `TAP_TEARDOWN_SKIP` exists only for bidirectional no-residue smokes.

The native per-handle transaction holds reset-mutation and acting-registry custody and revalidates registry selection. It snapshots the row and recovery metadata before moving files, then removes the row last. Ownership matches exact handle fields, their team qualification, and the stores' handle filename shapes; `ann` never matches `joanne`. Selected payloads carry their exact-ID sidecars, including inbound receipts. Symlinks move verbatim without following their targets. A failed teardown retains its archive and registry row and names the recovery path.

Per-handle restore is separate from `tap team restore`. It validates the archive kind, handle, row and store members under the acting-registry lock before consuming files, refuses existing destination files, and restores the same incarnation as suspended. Explicit session-kill backup paths remain supported, require COMPLETE and valid recovery records, and refuse forensic-only backups with no seat row. Failed restores retain recovery records and return moved files where possible; any additional retained live paths are named for inspection.

**Unregister authority:** deleting a current acting-registry row deletes TAP's current native resume pointer with it. `tap unregister` does not consult or preserve a second launcher store and offers no journal-backed recovery promise. Use `tap register <handle> --offline` when the intent is to park the Seat while retaining its row; use teardown/restore when a reversible removal is required.

**Out target selection:** ordinary `tap out` / `tap unregister` accept
`<team>/<handle>` (also `<team>:<handle>`) or `--team <team>`. These select the
acting team before retirement reads, locks, history, events or process effects;
the explicit team wins over cwd and ambient bus pins, including on revalidation.
Combining a qualified target with `--team` refuses as `selector_conflict`, even
when they name the same team. An unresolved explicit team or absent handle in
that team refuses without mutation; it cannot report success with nothing
removed. Bare absent handles retain their idempotent no-op behavior. The same
selection applies to `--kill`; forwarding remains a separate same-team form.



Before a plain crew unregister mutates the registry, it performs a **BEST-EFFORT local obligation scan**. An unsettled canonical inbound (`payloads/<id>.md`, `to=<crew>`, and `to_team` absent or equal to this bus team) blocks and prints the exact `tap reply <id> -f <file>` or `tap read <id>` action from `reply=`. A sender-bus canonical whose bare `to` matches the crew handle but whose `to_team` is foreign is outbound relay, not local inbound, and does not block (the prescribed `tap read`/`tap reply` would then refuse as `not_addressee`). An unsettled canonical or spooled outbound (`from=<crew>`) blocks and prints the id/source plus `tap outstanding <crew>` — `from=` remains sender-owned even when `to_team` is foreign. The row and tmux remain untouched on either refusal. Unregister never writes `.done`, `.cancelled`, or a transfer record: transport provenance is immutable. A local inbound spool (`spool/<id>.md`, `to=<crew>`, `to_team` absent or local, another sender) has not reached the crew member and therefore does **not** block; successful removal leaves it intact and surfaces its id, sender, and existing sender-side `tap cancel <id> --by <sender>` escape.

The v1 boundary is explicit: the scan and registry deletion are separate operations, with no transient `dismissing` state and no claim of mechanical concurrent-send race closure. The driver must first establish that the helper's current turn is complete. Cross-worktree inbound is the other named residual: its canonical payload lives on the foreign sender's bus and is not locally enumerable, so the foreign sender retains supervision through `tap outstanding` and can cancel after the crew seat disappears. Operators still poll the locally visible crew inbox and drain `tap outstanding <crew>` before dismissal.

**Register seat history + reflex output (tap-fja, reshaped by tap-qqd):** `tap register` / `tap in` success output is a **terminal reflex, not an interrogation** — the command re-opens no decision surface. It scans a bounded recent mtime window of `payloads/` (currently 20 payload files), matches frontmatter where `from` is the handle (sent) or `addressed_to_local` is true (received; foreign `to_team` is not local received history), and skips unsettled inbound (the deferred inbox pointer already covers those). Text mode leads with one action-first receipt, `tap register: registered <handle> on team <team>` (or `reactivated <handle> on team <team>`), never a menu:
- Unsettled inbound adds one **bounded deferred pointer** — `tap register: N messages waiting; next: tap poll <handle>` — never a per-message enumeration (the full digest lives in `tap poll`). A courier auto-settled payload is settled on arrival, so it never appears here (nor in the recipient pending-age warning, which counts unsettled inbound): its discovery surface is the digest index its doorbell named, retained for that purpose (§Courier digest).
- The seat-history line is **gated by ambiguity** (tap-qqd C4): a *first* registration that inherits prior traffic under the handle name gets the take-over guidance, and never a routine reconnect. A *routine reconnect* is a rebind, and its whole seat-history report is the recap below — there is no second passive note. (One existed, and was reachable only on a rebind: `seat_history` is set when `prior_existing or history`, so `not prior_existing and history` is exactly the ambiguity condition and consumed that case. It restated traffic the recap had already reported **with** its settlement state, and pointed at `tap poll`, which shows an empty queue whenever that traffic is settled.) Fresh handles with no history print no seat-history line.
- The take-over guidance **never names a dead-end command**: when there is unsettled inbound to review it points at `tap poll` (`prior traffic for <handle>; next: review with tap poll <handle> before taking over`), but when the inherited traffic is all settled — the common inheritance shape, where `tap poll` would show an empty queue — it carries the context **inline** instead (`N prior messages on record for <handle>, latest <id> from <peer> (<age>); next: review before taking over <handle>`).

Public shutdown and hard-removal process effects, ordering and receipts follow [public seat lifecycle](seat-lifecycle.md).
