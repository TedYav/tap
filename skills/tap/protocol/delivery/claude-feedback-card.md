# Claude feedback-draft card

TAP's courier delivers past Claude Code's feedback-draft card (tap-89a57). This page is the normative owner of that behavior; the [per-harness submit + verify table](./per-harness-submit-verify-table-courier-owned-documented-here.md) links here. Fixture provenance: `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-feedback-provenance.md`.

Claude Code's SendFeedback card (`✻ Bug report drafted: …`, with a hint row as its last line, drawn from column 0 directly above the composer region) is a notice, not a modal. On Claude Code 2.1.325 the composer keeps focus under it, the card's digit keys fire only while the whole composer is one `0`, `1` or `2`, and Enter is never the card's key. The card shows only on an idle seat at least 20 rows tall, mounts one second after the turn ends, ignores Escape for 600 ms after mounting, and hides when a turn starts. The card does not stop messages: a draft stays present and delivery goes on. The one exception is a hidden composer, where delivery dismisses the card or holds, according to `injection.feedback_card`.

The card's height pushes the composer down. Live 2.1.325 captures show the complete composer at 145x50, 119x45 and 100x30, only its prompt row at 80x24, and none of it at 71x22 or 58x24. The reader `claudeFeedbackCard` reports one of three states:

- `visible`: the complete composer sits below the card. Every reader reads that composer as usual and delivery needs no key.
- `hidden`: the composer is not completely in view, its visible rows hold nothing, and the hint row reads `1 to review · 2 to send · 0 to dismiss`. The hint is not evidence of an empty composer. The 2026-09-01 card, styled identically to 2.1.325's, drew that hint over a composer holding a sentinel (fixture `claude-feedback-legacy-hidden-text`).
- `text`: the composer is not completely in view, and the hint row reads `clear text to review, send, or dismiss`, or its visible rows hold typed text.

`hidden` and `text` hold in every reader: `feedback-draft` in the classifier and delivery band, `busy:feedback-draft` in spool readiness, and the `feedback-draft` park reason. Urgent, force, no-spool, queue-prefix and liveness authority do not override the hold. Card states the reader does not recognize (confirm send, sending, error) hold as an unreadable composer. A transcript box followed by prose is not a card, and neither is a box on indented rows: a draft's continuation rows are indented two columns.

## `injection.feedback_card`

The setting decides what delivery does at a `hidden` card. It lives in `config.toml` under `[injection]`, is read on each delivery, and is set with `tap config set injection.feedback_card hold`.

- `dismiss` (default): spool readiness answers `recover:feedback-card`, which admits one delivery attempt. The courier then:
  1. Requires the same `hidden` card on two samples 0.7 s apart.
  2. Authorizes the pane and checks the fences.
  3. Mints a one-shot license under the index home, keyed by the tmux socket, pane, pane process and the card's own rows.
  4. Re-checks the licensed observation after the mint: the same pane process, and the same card still hiding the composer. Then it sends one Escape. A changed process or card gets no key; the license stays spent.
  5. Looks again. If the card is gone, it reads the revealed composer the normal way: an empty composer takes ordinary delivery, and a draft there holds as any draft does. If the card is still up, it holds.

  The license allows at most one Escape per card from any sender. A spent license, a `text` card or a card that changed between samples gets no key.
- `hold`: no key; the payload holds with the notice below.

An unusable value reads as `hold`, and `tap doctor` reports it (`feedback_card`, `feedback_card_invalid`).

**Why Escape.** A live probe on 2.1.325 found that Escape with text in the composer changes no bytes and leaves the card up, while Escape on an empty composer dismisses the card. `0` with text in the composer types a byte (`probeA` became `probeA0`). Escape also never answers the turn-off prompt below with `0`.

**What dismissing does to the draft.** The draft is kept. It stays queued in Claude's `/feedback`, the footer still counts it (`· 1 feedback draft`), and the draft file is unchanged. The card does not come back for that draft. Claude then shows one line, `Turn off Claude-drafted feedback? 0 to turn off · Esc to keep`. The courier's typed sentinel declines it, which increments Claude's own decline count; after two declines Claude stops asking. Nothing the courier sends turns drafted feedback off.

An urgent send at a card sends no interrupt key. A card visible at its last read before the key means there is no turn to interrupt, and Escape on an empty composer would dismiss it. After a dismissal, the urgent interrupt is skipped entirely, as after a Codex update Skip.

## Landing evidence and the hold notice

When the last read before the paste saw a positively empty composer, a later frame whose card reads `text` is that paste's landing evidence. It stages the wire for one Enter, for the case where the card mounts during delivery. After that Enter the frame must show the wire gone; a card still reading `text` ends the attempt unverified with no second Enter. Nudge, the idle staged submit and stuck-wire recovery never get this evidence.

The first drain probe that observes the hold publishes one deterministic `DELIVERY HELD` notice per payload to the sender and, when a supervision watch is armed, to its armer (the supervising leader). The notice's first line is unchanged from the 2026-10-01 hold, so held rows keep their deduplication witness. The leader copy covers the common case where the blocked seat is its own sender, such as reminders. The leader notice is skipped when the armer is the sender or the blocked seat, and when the arm is reminders-only. Deduplication, retry and poll visibility follow the shell-mode notice in [OpenCode shell-mode containment](./per-harness-submit-verify-table-courier-owned-documented-here.md#opencode-shell-mode-containment-2026-09-25). Without an armed supervision watch, the sender notice is the only alarm. The watch is read from the drained bus, which is the sender's: for cross-team mail it names the sender team's leader, not the recipient team's. The cure is manual: a human or the seat's leader dismisses the card (Esc on an empty composer) or submits or clears any text under it, and held mail then drains on its own.
