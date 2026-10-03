# Appendix: the `ccnative` native driver (tap-lcdm — EXPERIMENTAL, default-off) — source part 1 of 2

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Registration
> temporarily retains the AGY start-token helper and `agy_ls` descriptor until
> its native cutover. The source below is historical, not an activation guide.

<!-- tap-source id=source-0140 start=889754 end=898317 sha256=40be0837833958af5f8696ce2297b59c34c33d58982daf36d18a5682d226b77e fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Appendix: the `ccnative` native driver (tap-lcdm — EXPERIMENTAL, default-off)

TAP's universal hop types the sentinel into the recipient's pane. A Claude Code
session also runs an inbox of its own — one unix socket per session — and `ccnative`
hands the sentinel to that inbox instead. **It was ACTIVATABLE as of tap-lcdm and
is now retired** (see **Current behavior** below).

This paragraph has now been wrong twice in opposite directions, which is why the
history is kept rather than replaced. It began as Lane-B staging — driver, probe
and conformance suite present, nothing reading a config, so there was no key an
operator could set. Then the router landed and the sentence became "reads the key
and REFUSES it," because `tap_driver_wired_list` did not contain ccnative. Both
were true when written; both shipped past the change that falsified them, because
prose a change invalidates without touching never appears in the diff a reviewer
reads.

**Behavior while ccnative was wired (historical), on a parser-capable runtime:** `driver = "ccnative"` under
`[harness.claude]` is read, resolves, and routes native. With no config file at
all the default is tmux. On a parserless Python 3.10 the key is not read; the
send uses tmux with a repeating diagnostic, which is the opposite of a refusal.
That exception is stated because "it is refused" would overclaim on a supported
runtime.

**Current behavior:** ccnative is retired. Native delivery wires only `tmux` and
refuses `driver = "ccnative"` as an unwired driver (`resolveConfiguredDriver` in
`runtime/bun/src/verbs/send.ts`, pinned by `send-driver-preflight.test.ts`). The
rest of this appendix records the default-off design history.

The parserless-runtime half is UNCHANGED and still both-halves-stated. On
a parserless Python 3.10 the key is never read: the send goes through tmux with a
repeating advisory. Both halves are stated every time this behavior is described,
because the unqualified version was written twice in this appendix -- once in the
paragraph above, and again here eight lines later, where correcting the first one
had already made it look handled.

Activating it took a wired-set entry AND a call site passing ccnative's own typed
tail — plus, per **tap-ze692**, an end-to-end router-to-drain check at the merge
gate. All three landed together in tap-lcdm. The check asserted that the attempt
record named `ccnative` at tier `api-accepted` AND that the recipient's inbox held
the frame, because either half alone could pass with the driver dead.

The drain half was gated by a separate crossing check. Its exact `tap-xk0yr` signature
(`rc=0`, empty stderr, spool present, canonical absent, no typed sentinel) emits one strict
`KNOWN-DEFECT` marker and leaves only the three linked assertions non-blocking. Any different
signature remains fatal. The runner validates and counts the marker in its terminal receipt;
removing the annotation restores ordinary blocking behavior.

**What a successful hop proves, and what it does not.** It proves the frame
reached the inbox of the session bound to the target pane. It does not prove
Claude saw it. The receiving session applies its own `crossSessionInbound` gate
afterwards, and a seat running with permission prompts bypassed HOLDS an
unattested peer message at a human approval prompt rather than delivering it.
There is no status frame on the ordinary accept path, so from the sending side
accepted and held are indistinguishable. This is invariant I-1 with a live
specimen: a driver's success is evidence, never a receipt. Accordingly `ccnative`
declares an `api-accepted` ceiling and maps rc 0 to `stop-ambiguous` **directly**,
rather than emitting `delivered` and relying on the dispatcher's cap — a driver
that never claims delivery is stating a fact about itself, where one that claims
it and is capped is only being caught.

**Door (proven on this box, Claude Code 2.1.239, `peerProtocol` 1).** Newline-
delimited JSON over `AF_UNIX`. An optional first line
`{"type":"auth","token":...}` classifies the sender as peer or child by a
timing-safe compare. The delivery frame is
`{"type":"user","message":{"role":"user","content":<sentinel>},"priority":"next",
"session_id":...,"msg_id":...,"from":...}`. The peer token lives in
`<config>/sessions/<pid>.<sha256(socket path)>.key`.

Three properties of that door drive the implementation and are easy to get wrong:

- `session_id` is enforced by the RECEIVER, which drops a present-and-wrong value
  — but ACCEPTS an absent one. The protocol fails open; the guarantee is the
  driver's to make. The frame therefore always carries it.
- `msg_id` must be unique per WRITE, not per payload. A repeated id is dropped
  silently, so a retry reusing the TAP payload id would succeed into a black hole.
- On macOS the inbox does not require auth at all (`authRequired` is
  Windows-only): unauthenticated and wrong-token frames are both accepted. The
  0600 socket mode is the entire access boundary, so the token affects how the
  receiver labels provenance, not whether the frame is admitted.

**Identity bind.** Because a write to the wrong session is indistinguishable from
a write to the right one, the driver proves the seat rather than looking it up. It
never searches by name, session id, cwd, or peer directory — each of those is
many-to-one, mutable, or machine-global. The chain is: pane → live `pane_pid` →
the ONE registry row claiming that pane (two rows claiming one pane is a refusal,
never a choice) → connect → the pid read off the CONNECTED socket via
`getsockopt(LOCAL_PEERPID)` → a re-read of the row for the pid that actually
answered → a `proc_pidinfo` start-time pin at microsecond grain, since the
registry's one-second `procStart` string cannot separate a pid from one recycled
inside the same second. That pin is two live samples taken during one attempt: it
proves the pid was not recycled between them, and does **not** prove a row written
a second earlier had not already survived a same-second recycle before the first
sample — there is no durable microsecond creation stamp in the row to compare
against. That residue is caught on the recipient's side by the `session_id` drop.

After connecting, the whole bind is RE-RUN — not a membership test. The pane is
re-observed (pane id and pane pid in one tmux call, so the pair cannot straddle a
change), the pane-root-to-one-row bind is repeated over the live root, and the
single row claiming that pane must belong to the pid actually connected to and
name the session that was resolved. Asking only "is the peer still somewhere under
this pane?" is satisfied by a retired session sitting beside its successor under a
wrapper that never died, and asking only about the pid misses a conversation reset
in place, which keeps the pane, the process and the socket and swaps the session
underneath all three.

**A residue remains, and it is worse than non-delivery.** Between the final bind
and `sendall()` there is an interval no synchronization covers. If the pane is
respawned inside it, the socket is ALREADY CONNECTED to the retired process and
the frame carries that retired session's own `session_id` — which matches. The
receiver-side drop does not fire: it only refuses when the endpoint's session has
changed, as with a successor or an in-place reset. A retired process that is still
alive enough to read its socket will therefore ACCEPT the frame, and the sentinel
lands in a conversation that no longer owns the pane.

That is a wrong-conversation delivery, not a missing one, and `outstanding` does
not detect it: `outstanding` catches the no-accept/no-settle case, and this case
settles. The revalidation is placed as the last operation before the write to make
the window as small as it can be made without a hook inside `sendall()` — it
narrows an irreducible TOCTOU and closes nothing. Nothing in this appendix should
be read as claiming the pane is proven to have held through the write.

A delivery additionally requires the caller's acting TAP `harness_session_id` and
refuses without it. That id can diverge from the live row's `sessionId` when a
seat carries a quarantined id — TAP has already refused that conversation as the
seat's principal, and delivering anyway would hand the sentinel to a conversation
TAP itself will not address. A probe may omit the id; a write may not.
