# Codex warning-footer and mid-turn progressive-paint controls (tap-2ajq8)

Specimens from 2026-10-01, when three idle Codex seats (gpt-6.1-sol, 200 columns) each held one complete staged TAP sentinel for 25-50 minutes. Every capture keeps its ANSI bytes, row geometry and footer rows exactly. Seat names, workspace names and preview text are replaced with same-length neutral text (letters cycled; spaces and punctuation kept), so wraps and widths are unchanged.

- `idle-staged.ansi`: the `tap nudge` before-frame (recovery `effect-1-….before.ansi`). The idle composer holds exactly one wire; under the status footer Codex paints a right-aligned `⚠ 1 warning · f2 to view` row.
- `idle-trailing-space.ansi`: a second seat's pane, from plain capture text. Two trailing spaces follow `]]`.
- `idle-wrapped.ansi`: a third seat's pane, from plain capture text. Codex word-wraps the wire after a hyphen (`ix-` / `neutral"]]`).
- `idle-digest-3row.ansi`: a fourth seat's `tap nudge` before-frame (10:44Z). A two-preview courier digest wraps over three composer rows: once at a word break, where the wire has a space, and once mid-path, where it has none. The same warning row sits under the footer.
- `midturn-partial.ansi` and `midturn-partial-midword.ansi`: the send-time `submit-unverified.frame` receipts for the first and third seats. Codex was mid-turn (`Working … esc to interrupt`, `tab to queue message`) and had painted only a prefix of the pasted wire. The second capture stops mid-word, which rules out wrapping and proves progressive paint.

Before the fix, the idle frames read as `changed`: the composer reader kept the status and warning rows as input. That made `tap nudge` refuse "expected staged sentinel changed" and the idle staged submit refuse its whole-composer equality. The mid-turn frames show why no staged-idle hold existed at all: the courier took an id-only sighting of the partial wire as landing, read `changed` before its first Enter, and stopped without `injected-text-confirmed`.
