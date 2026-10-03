# Codex compact menu specimen

`codex-compact-menu.txt` transcribes the composer and autocomplete text in the operator's
2026-09-23 04:06:47 screenshot of `tap/aspen-ponytail`. It is a transcription,
not an ANSI capture. The screenshot shows `/compact` staged after interruption,
with the matching description below it and no model footer. Unrelated receipt
paths and the tmux status bar are omitted.

A separate disposable offline Codex 0.156.1 capture placed the same description
above the composer. That layout does not reproduce the below-composer menu bug;
it is not evidence of the incident's original frame.

## Claude Unicode staging and queue specimens

`claude-unicode-staged.json` and `claude-unicode-queued.json` encode joined, escaped captures (unedited apart from the anonymization below) as JSON strings (preserving terminal padding without
introducing source-file trailing whitespace) from Claude Code 2.1.282 on 2026-09-25, at 238x61. The companion
`.expected.txt` files contain the exact typed control. A real Claude TUI ran
under the Bun runner's sandbox HOME and a private tmux socket, with a dummy API
key and a loopback mock Messages API holding an active response open. The
focus is the incident's supplied text, including its arrow-separated PR chain.
No production pane was read or changed by the probe.

The staging frame incorrectly classified `changed, idle, width 238` before any
Enter. All six Unicode trials failed that check; all six ASCII controls passed
(three idle and three active per variant). The queued frame followed one manual
Enter during the active response. Claude moved the control above its send-now
cue and displayed the queue-edit hint; the old reader still classified changed.
Both exact frames failed their regression assertions before the fix. Full
25ms capture sequences and probe scripts are retained under
`tmp/aspen-fast-fixer-2/419qs-frames/` in the driver evidence copy.

## Claude narrow ASCII specimens

`claude-narrow-{idle,active,queued}.json` preserve joined, escaped captures
from the same isolated Claude 2.1.282 rig at 77x61 on 2026-09-25. The focus
uses the coach handoff's ASCII path and prose shape. Claude wraps the path
inside `handoff-20260925T0944Z.md`, with no space at the row boundary.
All three frames classified `changed` before the hard-wrap repair.

The initial 30-case sweep crossed widths 60/77/100/160/238, focus lengths
160/420/1100, and idle/active responses. The eight long-focus cases at 60 and
77 columns failed; the other 22 passed. Both actual Bash-tool self-compactions
at 77 columns also returned exit 5 before the repair, with and without a tray.
The lossless 25ms sequences and probe scripts live in the driver's retained
`tmp/aspen-fast-fixer-2/narrow/` evidence directory. Scroll probes are separate
from these unscrolled specimens; these captures alone do not establish scroll
behavior.

`claude-narrow-scroll-app.json` captures Claude's PageUp view; the transcript
shows its jump-to-bottom hint while the composer stays visible.
`claude-narrow-scroll-copy.json` is a normal tmux capture taken after entering
copy-mode, so it records the live screen, not the copy-mode viewport. The live
probe separately checks `pane_in_mode`. Neither empty frame proves a staged
control.

`claude-narrow-scroll-staged.json` captures the complete command after typing
into the PageUp view. Its focus ends with a space and the marker adds another;
Claude hides that two-space separator at the visual row boundary. This frame
cannot prove whether one, two or three separator spaces were typed. The matcher
therefore refuses expected multi-space runs hidden at a wrap, preserving the
composer without Enter or take-back. Visible interior spaces still match by
exact count. The tests also reject short
inserted newlines, changed interior spaces, missing markers and mixed drafts.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
