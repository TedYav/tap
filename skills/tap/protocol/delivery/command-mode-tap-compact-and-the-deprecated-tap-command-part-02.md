# Command mode (`tap compact`, and the deprecated `tap command`) — source part 2 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0087 start=575494 end=582263 sha256=d2281281e5693295faa4996bb6b94f9c3338413f43dfb22e13036dd03c7bbab1 fragment=2/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Compaction handoff and post-compaction wake (tap-joqz).** An explicit `/compact` consumes the turn that submitted it, so with no inbound traffic nothing starts the next one and the target silently stops; the initiator meanwhile holds a clean success receipt. Compact therefore always queues something **behind** the `/compact` — the focus payload on the peer path, a deixis-free resume ping otherwise (see the two rails above). The wake is armed **unconditionally**: the agent decides whether work remains, not the arming logic. **Ordering is necessary and not sufficient (tap-ieiy).** Claude reads queued plain messages at tool-call boundaries but queued slash commands at turn end. A ping submitted after `/compact` can therefore run before compaction (observed on Claude Code 2.1.233). On the `/tap:self` path one detached Bun worker (`runtime/bun/src/self-compact.ts`) owns the resume on every supported family, because `tap self` runs inside the very turn whose ending starts the compaction and an in-process wait would block the state it waits for. **The resume is a TAP note to the compacting seat** (`tap send <self> --note --wake`, body file-sourced), never a raw pane submit: the courier owns lock contention, spooling and the no-retry-after-effect rule, so the worker has no retry taxonomy of its own. The note body is the deixis-free resume ping (`handoffPing` in `runtime/bun/src/compact-focus.ts`), which never asks the target to recall (the post-compaction summary is precisely the unreliable artifact); it names the absolute brief path. Recovery reads the whole brief (holds, Keep scope and live scheduler ids included), loads role guidance without replaying initialization, reconciles live state and obligations, then follows Next step, including a wait. Per family: **Claude** — `tap self compact` validates and arms one detached worker before any pane input. The worker waits on the shared courier's draft, copy-mode and pane-lock checks, then submits `/compact <focus>` once, including mid-turn when the live composer permits it. A refusal is retryable only with explicit no-input-effect evidence; an unknown or possible effect is never retyped. The queued wait is bounded by `TAP_SELF_COMPACT_TIMEOUT_SECONDS` (default ten minutes from arming); expiry records `not-submitted`, retains the handoff and sends no resume. The worker captures the bound transcript offset, file identity and timestamp at Enter and requires a fresh complete user record with `isCompactSummary: true` and `isVisibleInTranscriptOnly: true`, matching the native session and excluding sidechains. Old already-submitted requests remain proof observers; a missing boundary without queued-request authority never becomes a new submit. **OpenCode** — the worker holds the pane-submit lock, waits for two consecutive idle reads, and submits bare `/compact` once through the locked courier seam. At Enter it captures the bound store and message boundary. Proof requires a `session_message` row in the bound session with type `compaction`, status `completed`, reason `manual` and no error. Its sequence must follow the Enter boundary, and both creation and update times must be later than Enter. Both families have durable witnesses; missing bindings or unreadable witnesses never downgrade to chrome. A missing witness records `not-compacted`, preserves the handoff and withholds the resume, with `compaction-never-observable` in `wake-unverified.log`. An unverified submit is never repeated and permits a resume only if fresh proof subsequently appears. Claude receipts carry `evidence: transcript-proven`; OpenCode receipts carry `evidence: store-proven`. Both retain `compactedAt` through the terminal receipt. Native session and transcript/store bindings must still match before resume. **Codex (tap-n27ug)** — the worker holds the pane-submit lock across one authorized Escape, one locked `/compact` submit, and proof — a fresh top-level `compacted` record (timestamp and byte offset captured at the real Enter) in the bound rollout — before settling and sending the note; missing proof records `not-compacted` with the handoff preserved and nothing sent. Every family settles `TAP_SELF_PING_SPACING_SECONDS` (default 2, tap-lmbs) before the note, rechecks the seat identity, and records each phase in `<bus>/handoff/<id>.compact.receipt.json`, with a pointer line in `self-helper.log` for the terminal state (`resume-sent`, `resume-miss`, `not-compacted`, `not-submitted`, `incomplete`). A refused or failed note is `resume-miss` plus a `resume-send-failed` line in `wake-unverified.log`. The worker needs a registered seat, so `tap self` refuses an unregistered pane with exit `1` before any pane effect. On the `/tap:self compact` path exit `0` means "queued, worker armed", never "submitted" or "wake delivered". Arming failures precede pane effects; the old submitted-but-unarmed exit `7` is no longer emitted. Claude receipts retain `queuedAt`, verified `submittedAt` and proof `compactedAt`. The peer focus is deliberately weaker than the self path's, where the agent composes its own, because the initiator knows less than the target would; the ladder still prefers `tap send <seat> "run /tap:self compact"` for a seat that can be asked nicely. A peer ping that fails to land makes compact return `6` DEGRADED, so a stopped seat is never reported as a clean success. Re-establish queue-behind behavior after harness updates with the [live probe](../../../../docs/solutions/architecture-patterns/compact-queue-behind-probe.md); mock ordering cannot prove native scheduling. Every self compact requires a readable, nonempty regular handoff, including direct arming and executable-entry callers on every family. The runtime copies it durably before arming; later source edits or removal do not change the copy. Missing or invalid sources refuse before any effect and point to `/tap:self compact`, which authors the brief from operator intent.

**Peer completion barrier (tap-u937).** A peer target can finish its own turn while the initiator waits, so its existing cancellable child owns submission, proof and follow-up. It uses `compaction-proof.ts`, the same reader and Enter-boundary capture as self-compaction. Before any pane input the parent writes a durable resume body and initial receipt under `<bus>/handoff/`, and prepares the terminal command audit. The child attempts `/compact` once, waits for a fresh bound Claude transcript or OpenCode store witness, then sends the resume as a TAP note. Both focus and no-focus paths use this barrier; neither can spend a wake on the pre-compaction context merely because submission was accepted. The same native session is checked during proof and again at envelope placement. The existing OpenCode peer suffix remains unchanged (tap-usgng).

The peer receipt `<id>.peer-compact.receipt.json` carries `transcript-proven` or `store-proven` and `compactedAt`. No witness yields `not-compacted`, retained resume text and no follow-up. Cancellation stops the child and fan-out; it preserves the last receipt and body and authorizes no retry. The parent publishes its terminal success audit only after validating the child's completion receipt. A proven compact with an unaccepted resume is `resume-miss` and exit 6; accepted delivery is `resume-sent`, not proof of recipient read. Missing proof is exit 1. The default wait is ten minutes per target, controlled by `TAP_SELF_COMPACT_TIMEOUT_SECONDS`; `--all` remains sequential. A self target refuses before input and points to `/tap:self compact`.

**Per-harness clear spelling (tap-ywvb).** `clear-command.ts` is the single
native owner, reached as `self-rebrief.ts command`: OpenCode uses `/new`, other
supported families use `/clear`, and unknown harnesses refuse. Exact-match
verification uses the same spelling. On OpenCode 1.18.15 an unrecognized `/clear`
is ordinary model input, so successful submission proves no reset. Newer docs
list `/clear` as an alias, but `/new` works on both versions.



Codex self-compaction accepts the exact bare `/compact` input accompanied only by its matching autocomplete description. Extra input or a different menu row still refuses Enter. The final readiness check recognizes this exact worker-owned staged command on the same captured frame; ordinary readiness still requires an empty composer. Active-work chrome, queued follow-ups, a working title, changed turn and custody holds continue to refuse Enter. A refusal before the Enter proof boundary retains the courier reason in the terminal receipt; a missing boundary never authorizes transcript proof or another Enter.

**No-actor remedies stay local (tap-4suib).** When compact cannot identify its
initiator, it recommends registration in the selected team. It checks only the
already-resolved acting registry for an old-store refusal; it does not search
machine-wide enrollments for another seat or suggest a foreign team's root.
An unanchored caller gets the generic registration remedy without a registry scan.

**Claude in-turn control verification (tap-419qs).** The typed `/compact` path
recognizes complete, naturally wrapped controls containing known single-cell
Unicode characters, including arrows. Full-width hard wraps inside long tokens
also preserve equality; a matching tail alone is insufficient. Expected multi-space
separators hidden at a wrap cannot prove their byte count and refuse; visible spaces remain exact.
Self compact strips trailing ASCII spaces from its focus before adding the
marker's single separator, so it never creates that ambiguity at the join.
At a natural soft wrap the pane cannot reveal extra separator spaces, so the
single-separator rule compares rendering equivalence, not hidden byte counts.
Visible edits, broken token continuity, expected newlines and foreign drafts
remain guarded. Busy/idle chrome
does not change the decision: exact owned composer text permits one Enter.
A queued control is accepted only when its complete owned text is immediately
above Claude's `ctrl+x ctrl+s to send now` cue and the bounded active composer
shows `Press up to edit queued messages`. Neither transcript text nor the hint
alone establishes acceptance. This queue verdict advances the worker to proof observation; the resume still
waits for fresh bound transcript proof. The typed
compact path attempts Enter once. An uncertain frame, before or after Enter,
never authorizes taking the input back; it leaves the composer intact and
reports the uncertainty. A lingering echo never authorizes another Enter.
Tmux copy-mode refuses each worker attempt before typing; the worker waits
within its queued deadline for the live view. The caller has already returned
`0` with the receipt path and must not rerun compact to check progress.

**Self outcome audience.** Optional `--notify SEAT` names a different active
teammate to receive the outcome; invalid, self or inactive explicit recipients
refuse before effects. It transfers no supervision, recovery ownership or
obligations. Omission never infers a bystander. After reading the whole brief,
the resumed agent reports its path, restored role and next action to explicit
notify, or in its own conversation for the operator. The worker sends no success
notice. On failure it sends a best-effort notice only to explicit notify, with
the receipt, preserved brief and next safe action. A separate
`<receipt>.notify.json` records notification acceptance or failure; it never
rewrites or replays the operation. Without notify, asynchronous failure exists
only in the receipt and log. `resume-sent` remains transport evidence, never
proof of reading. Peer compact remains synchronous and has no notify flag.
