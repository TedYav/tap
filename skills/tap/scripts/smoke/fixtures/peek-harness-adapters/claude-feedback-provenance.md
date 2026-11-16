# Claude feedback-card frames

Claude Code's SendFeedback card is a notice above the composer, not a modal. On Claude Code 2.1.325 the composer keeps focus under it, and on a short pane the card's height pushes the composer below the viewport. See the protocol section "Claude feedback-draft card" in `skills/tap/protocol/delivery/per-harness-submit-verify-table-courier-owned-documented-here.md`.

## Live, Claude Code 2.1.325, 2026-11-14 (58x24 pane)

A seat drafted feedback in its own pane, went idle, and a script captured the pane with `capture-pane -p -e`. The script then pasted a line with bracketed paste and pressed Enter once. The courier itself types literal keys into Claude; bracketed paste is its OpenCode path.

- `claude-feedback-card-empty-hidden.ansi`: the card with the hint `1 to review · 2 to send · 0 to dismiss`. The composer's top border is the last row; its prompt row is below the viewport.
- `claude-feedback-card-text-hidden.ansi`: one second after the paste. The pasted text went into the hidden composer, and the hint changed to `clear text to review, send, or dismiss`.
- `claude-feedback-card-after-enter.ansi`: 0.15 s after Enter. The line was submitted, the turn started, the card hid, and the empty composer is back in view. The draft stayed queued.

## Live shape sweep, Claude Code 2.1.325, 2026-11-15

With the card up, a script resized the seat's window and captured each shape. The composer was complete below the card at 145x50, 119x45 and 100x30, showed only its prompt row at 80x24, and was out of view at 71x22 and 58x24. At 119x45 and then at 71x22, the fixed courier delivered a real note into the pane while the card was up.

- `claude-feedback-card-visible.ansi`: 100x30, the complete empty composer and footer below the card.
- `claude-feedback-card-partial.ansi`: 80x24, the composer's empty prompt row is the viewport's last row; its bottom border is out of view.
- `claude-feedback-card-hidden-71x22.ansi`: 71x22, the frame read just before the courier's delivery. The composer's top border is the last row.

## Live dismiss probe, Claude Code 2.1.325, 2026-11-15

With the card up at 71x22, a script typed literal keys into the hidden composer and pressed one key per case. In three cases it found:

- With text in the composer, `0` typed a byte (`probeA` became `probeA0`).
- With text in the composer, Escape changed nothing and the card stayed up.
- With the composer empty, Escape dismissed the card. The composer came back into view, a one-line turn-off prompt appeared, and the draft stayed queued (footer `1 feedback draft`, draft files unchanged).

- `claude-feedback-card-dismissed-71x22.ansi`: the frame after that Escape, with the turn-off prompt above the visible empty composer.
- `claude-feedback-card-queued-tail.ansi`: 119x45, a later card with two drafts queued. Its hint row ends `· +1 more queued`, and the complete composer sits below it.

## 2026-09-01 (80x24 pane)

`claude-feedback-truncated.ansi` is the unchanged raw capture recorded at 2026-09-01 21:36Z from pane %214. Source: primary checkout `tmp/lane-lead-9-1/specimens/20260901T2136-truncated-digest-sentinel-claude-band.ansi`. The composer's prompt row is the viewport's last row and shows the head of a legacy 0.22 sentinel: its opener, version and sender fields. The wire's next field is 41 columns wide and only 37 were left, so it wrapped below the viewport. The paste was most likely whole and just out of view, not truncated.

`claude-feedback-legacy-hidden-text.ansi` derives from that capture by dropping its last row, the composer's prompt row holding the sentinel head. The card still reads `1 to review · 2 to send · 0 to dismiss` while typed text sits just below the viewport, so the hint proves nothing.

`claude-feedback-empty-constructed.ansi` also derives from that capture. It removes the active input text and adds a bottom composer border, which gives a complete empty composer below the card.

Plain `.txt` companions remove ANSI sequences only.
