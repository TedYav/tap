# Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 1 of 3

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Native
> registration no longer captures the AGY start token or `agy_ls` descriptor.
> The source below is historical, not an activation guide.

<!-- tap-source id=source-0142 start=900325 end=909044 sha256=df8caf12fc274368ec749e7e33473ebd5989a629100107e3d2b29b12d1b4f160 fragment=1/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off)

Antigravity ships agent-to-agent messaging of its own: `agy agentapi send-message
--title=<summary> <conversation_id> <content>`, spoken to the seat's language
server. The `agy` driver hands the sentinel to that door instead of typing it into
a pane. **It is shipped inert.** Native delivery wires only `tmux`
(`resolveConfiguredDriver` in `runtime/bun/src/verbs/send.ts`), so `driver = "agy"`
under `[harness.agy]` refuses as an unwired driver; `send-driver-preflight.test.ts`
pins that refusal.

### Linux native identity boundary

The native agy adapter is unsupported on Linux: kernel start ticks are not a
microsecond-precision process-incarnation source. Probe returns
`not-usable / linux-native-identity-unsupported`; direct delivery refuses before
native I/O with rc 10 (`retry-next-rung`, `effect: none`). This also rejects old
Linux descriptors carrying whole-second `sec:` tokens. Re-registration does not
remove the platform boundary.

Ordinary agy delivery keeps its existing default tmux route. This change does not
wire the inert native adapter or make an explicit `driver = "agy"` preference
silently fall back: that unwired selection still refuses. The Linux native
conformance suite declares its platform gap; a separate control checks refusal
before I/O and default tmux selection on every host.

### Why every agy attempt is ambiguous

**The door's success payload is an RPC ACK and nothing more, and the proof it is
not a receipt is the silent drop: the same ACK comes back for a conversation id
the door does not own.** In a two-seat test, sending one seat's conversation id
through the other's port returned success without delivery, and neither log
recorded the message.

The driver therefore declares `evidence_ceiling = api-accepted`, which caps it at
`stop-ambiguous` (§3.2). There is no code path to `delivered`, and the conformance
suite asserts that by walking the whole static outcome table rather than by
exercising behaviour. Every agy send carries submit-unverified semantics: the
payload stays canonical-durable, no `.sent` is written, and the sender's
`outstanding` entry ages — I-2's alarm remains the detector, exactly as for any
other driver.

Consequently the driver reads **nothing** from the recipient. Confirming delivery
from a seat's own log or an echo obligation was considered and rejected: a seat's
report about its own input is not evidence of delivery, and agy message-attribution
visibility is UNVERIFIED — a seat asked from inside the harness could not confirm
that a natively delivered message is distinguishable from operator input.

### Capabilities

`classes = queue` only, and `interrupt = false`. Mid-generation delivery is
classified as **in-turn, non-disruptive arrival**: a seat running a 45-second
foreground loop received a native delivery mid-loop, saw it during generation, and
was not interrupted — the loop ran to completion. That is an availability fact,
not a class fact. `steer` means reaching a busy seat **and changing what it is
doing**; arriving without disturbing it is weaker, and claiming `steer` would let
the urgent composite pre-select a rung never shown to interrupt anything.

### The `agy-ls` descriptor

A registry row for an agy seat may carry `agy_ls`: `{v, address, pid,
conversation_id, started}`. It is **self-attested** (§2): written only by `tap register`
running inside that seat's own tool shell, never by the launcher.

**Known limit, tracked in `tap-o07f2`:** the descriptor is safe when the accepted identity
and the native one disagree — it simply is not published, and the seat routes tmux.
The ROW's `harness_session_id` is not: the identity ladder prefers a generic
`TAP_HARNESS_SESSION_ID` and only falls back to the native variable when that is
empty, so a stale generic id remains the row's identity and reaches the
exact-resume path. That is an identity-ladder question shared by four harnesses,
not an agy driver one.

The launcher cannot supply it, and this is a property of the harness rather than a
deferral. `ANTIGRAVITY_CONVERSATION_ID` and `ANTIGRAVITY_LS_ADDRESS` are exported
into agy's tool **child shells** and never into its own process environment, so a
launcher-born agy seat registers with no conversation id at all; and the language
server is not bound until after startup, so there is nothing to record at launch
in any case.

Four rules govern the write, each closing a way the descriptor could name a door
it does not own:

- **Whole or not at all, and removed when the capture is absent.** A stale
  descriptor is worse than none: the OS recycles ports within minutes of a seat
  exiting, so a leftover row eventually names a live listener belonging to an
  unrelated process.
- **The caller must BE the pane.** The environment belongs to whoever ran the
  command; the pid belongs to whatever `--pane` names. Registration requires the
  registering shell to be a descendant of the pane's process
  (`tap_pid_has_ancestor`), or no descriptor is written. Without this, one agy seat
  registering another pane mints seat A's identity against seat B's pid.
- **The accepted identity must BE the native one.** The identity ladder prefers
  `TAP_HARNESS_SESSION_ID` and falls back to `ANTIGRAVITY_CONVERSATION_ID` only
  when that is empty, so a stale generic id alongside a current native one yields
  two different answers. The descriptor is published only when they are the same
  string.
- **The bound pid is the door's owner, not necessarily the pane's root.** A
  launcher-born seat runs agy AS the pane command, so the two coincide; a seat
  started by hand leaves the pane root a shell with agy beneath it, and binding the
  shell would make the driver's ownership attestation refuse that seat forever.
  Registration therefore binds the nearest `agy` ancestor of the registering shell,
  falling back to the pane root when there is none. **The refinement runs only
  after the pane is proven to be the caller's own** — the reverse order lets a
  foreign `--pane` be silently rescued by the caller's own agy, defeating
  self-attestation while reporting success.
- **A refused identity re-observed unchanged keeps its refusal.** A repeat
  observation short-circuits before the quarantine verdict is recomputed, so the
  descriptor obeys the PRESERVED verdict there: anything other than `accepted`
  removes it. A descriptor is an authority field — it is the address routing would
  use — and refreshing one for a quarantined identity would hand the refused
  session that authority by the back door.
- **The descriptor is removed with the identity it names.** It is written before the
  identity ladder reaches its verdict, so a capture that is subsequently
  quarantined — conflicting with the launcher's expectation, duplicating another
  seat, or repeating a refused observation — has its descriptor removed with it. A
  descriptor is only ever as good as the identity the row accepted.
- **Loopback only.** A non-loopback address is refused rather than dialled.

The last two exist because the driver **cannot** catch that class of error: its
attestation asks whether the port belongs to the bound pid, and in both cases it
does. Both halves are locally valid and the combination is wrong.

### Probe and attestation

`probe` returns `usable` only when the bound conversation id is present, the bound
address is loopback, the boot epoch matches, the bound pid is alive, and **the
process listening on that port is that pid**. Port-up-only is `not-usable` — a live
door belonging to a different seat is precisely the silent-drop precondition.
`unknown` is never returned: agy has identity fields, so the attestation either
holds or it does not.

### Outcome table

rc 0 → `stop-ambiguous/possible/api-accepted`; rc 1 → `.../api-refused`; rc 2
(timeout: no response within the deadline — the observed class is a door that
accepted a connection and never answered) →
`stop-ambiguous/possible/none`; **A pid is not a process.** `boot_id` bounds pid reuse ACROSS reboots and says
nothing about a pid recycled within one — which is what happens when a manual seat
exits and a new agy starts in the same pane without re-registering. Every other
check passes there: the epoch is unchanged, the pid is alive, and the port is
owned by that number. Attestation therefore also compares the bound process START
TIME, which distinguishes incarnations of one pid; a descriptor without one is
refused (`no-bound-start-time`) on the same reasoning as an absent epoch.
