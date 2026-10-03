# Per-harness submit + verify table (courier-owned, documented here)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0112 start=739982 end=741354 sha256=b33145137cf9e00a0406fbefe494ee759af168397c1d51caa23d6182bacc316e fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Per-harness submit + verify table (courier-owned, documented here)

Harness detection is rooted at tmux `#{pane_pid}` and walks the real process tree (`ps`) for known agent executables such as `claude`, `codex`, `opencode`, `cursor`, and `agy` (Antigravity/Gemini); `#{pane_current_command}` is only a fallback. This matters because Claude Code can expose its version string (for example `2.1.198`) as `pane_current_command`. After successful bound authorization, native composer readers use the attested harness family; the raw pane command remains identity evidence.

| Harness | Input mode | Submit | Verify submitted |
| --- | --- | --- | --- |
| claude-code / codex | `send-keys -l -- text` | ordinary wire: visible text → Enter, bounded retries below | known empty composer or corroborated working transition |
| hermes | `send-keys -l -- "/queue " + text` | `/queue text → Enter` | sentinel id left the input line: `❯` (or `<profile> ❯`) at rest, `⚕ ❯` mid-turn |
| opencode | bounded unique-buffer bracketed pastes (`paste-buffer -p`) | `text → Enter` | sentinel id left the bottom TUI input band |
| agy (Antigravity / Gemini) | `send-keys -l -- text` (urgent: `Escape` first) | `text → Enter → Enter` | sentinel id left the `>` band (bottom-anchored between `─` rules; readiness is band presence minus a recognized permission modal) |
| (other) | extend as discovered | extend as discovered | fail-closed (defer) until added |


### Hermes's working prompt (tap-rhajr)

Hermes paints its composer as `⚕ ❯` for the whole of a turn, typed text or
not, and as `❯` (or `<profile> ❯`) at rest. Every prompt-row reader accepts
both, so a `/queue` wire typed mid-turn is observed staged and verified like
any other. A readable row is not an idle verdict: the `⚕ ❯` row is Hermes's
working witness in agent state, and seat state reads it as `working` before
any empty-band rule. Hermes composers soft-wrap at the cell, so a row that
fills the pane continues on the next with no separator, and the italic
256-colour 136 hint, at rest or mid-turn, is an empty composer.

The idle staged submit (tap-9lqa7) still requires a positive idle agent state,
and Hermes's idle witness is an empty at-rest prompt row. A wire left staged in
an idle Hermes composer therefore stays for `tap nudge`.

### Codex staged wires (tap-2ajq8)

Codex paints a mid-turn paste progressively, so landing waits for the whole
wire (see the agy rule in the submit helper). Landing on the whole wire is what
writes `injected-text-confirmed`, the evidence a later staged-idle hold
requires; a send judged on a partial paint left no hold and no idle Enter.

Codex may paint a config-warning row (`⚠ N warning(s) · f2 to view`) directly
beneath its status footer. The composer reader treats it as footer chrome only
when a recognized status row sits directly above it; anywhere else it stays
composer input. Read as input, it made an idle composer holding only our wire
read `changed`, so `tap nudge` refused and the idle staged submit never passed
its whole-composer equality.

Codex 0.160 also paints a status row with no Context item: `<model> <reasoning
label> · <cwd> [· <thread title>]`, for example `GPT-6.1-Sol default · ~/project
· Run shell diagnostics` (tap-21bdj). It is footer chrome only as one physical row
whose cwd item starts with `~` or `/`; a wrapped or non-path row stays input.
An auto seat licenses Enter only when its composer is the sentinel and nothing
else, so while this row was read as input every auto send was withheld
(`enter_count 0`) and `tap nudge` refused. A bypass seat licenses Enter when the
wire is visible in its input tail, which tolerates the same footer.

### Completion Enter (tap-vclur)

An ordinary courier submit finishes with one additional Enter, including when
its verifier sent no Enter or returned unverified. This is a bounded part of
that submit phase, not a new delivery attempt: it never retypes the sentinel or
reopens automatic retry after a possible effect. Exact slash controls retain
their own single-Enter contract.

The native completion owner serves native sends and the retained Bash spool
submit adapter. It uses the captured recipient binding and pre-type/effect
facts. No typing attempt, a pre-type human draft, a fresh draft or unreadable
composer, copy mode, recovery custody, changed identity, or a reset/clear fence
withholds the completion key. The fresh composer must be empty or contain only
the courier's text. It records `completion-Enter-intent`, then `Enter-sent` only
when the key command succeeds, and a final `verify-result`. A fresh empty frame
can promote an unverified result only if the owned text was visible before this
key; queue acceptance needs the normal positive queue observation. The ordinary
attempt ledger still owns the no-retry boundary.
A pre-Enter withhold of the courier's own ordinary sentinel is finished by
this key when the band still holds exactly that wire, never taken back
(tap-cw7g1); clearing it first would turn a delivery into a non-delivery.

A zero-Enter pending re-probe additionally requires the exact owned wire before
completion; an empty band after a changed frame leaves that recovery pending.
Sending the completion key consumes zero-Enter authority even if acceptance
remains unverified. An unverified result after that key never retains
`reprobePending`.

### Claude feedback-draft hold (tap-89a57, 2026-10-01)

Claude Code's SendFeedback panel (`✻ Bug report drafted: …` closed by `1 to review · 2 to send · 0 to dismiss`, directly above the composer) is `feedback-draft` in the input classifier and delivery band, `busy:feedback-draft` in spool readiness, and the `feedback-draft` park reason. It was previously parked as a generic `no-input-prompt` and waited as `busy:modal` with no alarm; a seat once sat behind it for 20 minutes. Agent state is unchanged: `blocked` there means an approval prompt.

No key reaches the pane: not the sentinel, not Enter, not `0`. Urgent, force, no-spool, queue-prefix (`noPromptOk`) and attested-liveness authority do not override it: at the first band read, before urgent's interrupt key, at the final pre-paste read, and at each per-Enter read when the panel appears after the paste (the attempt then ends unverified with the wire possibly staged). The courier never sends, reviews or dismisses the draft.

The first drain probe that observes the panel publishes one deterministic `DELIVERY HELD` notice per payload to the sender and, when a supervision watch is armed, to its armer (the supervising leader). The leader copy covers the common case where the blocked seat is its own sender, such as reminders. The leader notice is skipped when the armer is the sender or the blocked seat, and when the arm is reminders-only. Deduplication, retry and poll visibility follow the shell-mode notice below. Without an armed supervision watch, the sender notice is the only alarm. The watch is read from the drained bus, which is the sender's: for cross-team mail it names the sender team's leader, not the recipient team's. The cure is manual: a human or the seat's leader reads the panel and dismisses it (`0`); held mail then drains on its own.

### Stuck-readiness alarm (tap-bprtg, 2026-10-01)

A seat held as booting or no-prompt past a bound, whose harness positively shows its turn ended with no activity since, gets one `DELIVERY STALLED` notice per stuck episode. See [Stuck-readiness alarm](./stuck-readiness-alarm.md).

### OpenCode shell-mode containment (2026-09-25)

OpenCode 1.18.31 can interpret an embedded `!` in a bulk literal-key injection as its shell-mode shortcut, dropping that byte even after a long text prefix. Courier sentinel injection therefore uses bracketed paste for OpenCode; literal keys remain the other harnesses' existing path. A private-terminal reproduction compares identical sentinel bytes through both methods without submitting either input.

A live `Shell` composer footer together with `esc exit shell mode` is `shell_mode` in agent state, `shell-mode` in the input classifier, and `busy:shell-mode` in spool readiness. It is not chat input. Force/no-prompt delivery does not authorize typing, clearing, or Enter into it. The detector is anchored to the current composer; quoted transcript text cannot establish this state.

The first drain probe that observes this state publishes a deterministic, per-payload `DELIVERY HELD` sender notice. Repeated probes do not repeat the notice's pane effect. The original payload stays queued, without an attempted/delivered claim or terminal escalation; ordinary delivery can resume when the composer returns to chat. A failed notice publication retries on a later probe. A published notice remains poll-visible when its sender has no available pane. This bound is the first authorized readiness observation, not a delivery guarantee while the courier is stopped or the pane is held by another recovery.

No automatic Escape is sent: the shell composer can contain a human command, and in the observed case the staged TAP text had already lost a byte. Leaving that input intact avoids treating a similar-looking marker as proof of exact ownership.

OpenCode 1.18.31 summarizes pastes longer than 150 characters or at least three lines as `[Pasted ~N lines]`. Courier text is pasted in pieces of at most 128 UTF-16 code units, ending each piece at a line break and preserving surrogate pairs and CRLF. This keeps the full wire visible for exact verification without reintroducing literal-key shortcuts. A refused piece stops the operation without replay. An opaque placeholder alone does not identify a staged sentinel.

Each bounded OpenCode piece requires the caller's live pane authorization, rechecked after its buffer load and client reservation immediately before admission and paste. Missing or changed authority stops the operation. A refusal or exception after an earlier piece succeeded is a possible partial injection, never a pre-effect rate-limit result; the caller records it unverified without replay.

For chunked courier insertion, durable attempt admission occurs only after the paste client reservation succeeds, immediately before the pane effect. A first-piece authorization or reservation refusal retains its typed denial and leaves no attempt marker; an earlier interrupt or pasted piece retains possible-effect custody. Cleanup of a uniquely owned, unconsumed paste buffer is socket-pinned and deadline-bounded but does not compete for the exhausted paste limiter.

When first-piece admission acquires reset mutation custody, it rechecks pane authorization after the lock wait and before writing attempt markers. Refusal at that point retains its typed result with no marker or paste. Spool singles and digests repark a rate refusal only when every member's attempt marker is absent; an existing, dangling, or unreadable marker retains conservative possible-effect custody and stops automatic replay.
