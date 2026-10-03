# Claude queued row, live draft, Claude Bar

Bounded bottom-region fixture captured 2026-09-18 from a live Claude Code session (`claude` harness command) during the unverified submit recorded in `~/.tap/debug/20260917T203524Z-cb1dd4ee/artifacts/c96d9295f929d92c144b/` (specimen `lime-conductor-20260918T085028Z-f75f1bd3af66.submit-unverified.frame`). The committed file is exactly the specimen's last nine rows, derived deterministically: before anonymization, all ANSI escapes and row content were preserved byte-for-byte, and only each row's trailing terminal cell-padding spaces (the run of ASCII spaces that pads a row to the capture width) are stripped. No synthetic rows were added; the file has no trailing newline, matching the specimen.

Region contents, top to bottom: a working spinner row (`Flambéing… (2m 36s · ↓ 8.8k tokens · thinking with xhigh effort)`); a blank row; the queued message row — a two-space-indented `❯` glyph with the full `[[TAP v0.23 note lime-conductor-20260918T085028Z-f75f1bd3af66 preview=…]]` wire and background paint; a blank row; a labeled top fence (`fable leader handoff`); the composer prompt holding a live human draft (`❯ Com`, column-0 glyph); the pure bottom border; the Claude Bar status line (`[Fable 5.1 xhigh] … 11% (113k) ctx …`); the `⏵⏵ bypass permissions on (shift+tab to cycle) · PR !3354` footer. The footer carries no `esc to interrupt` hint: the Claude Bar status line replaces it, so this frame shows no working grammar at all — acceptance must come from the queued-row geometry.

Transcript prompt rows in the full specimen sit at column 0, while the queued row is indented two spaces; that indent is the geometry discriminator between a queued message and an ordinary transcript row.

Original SHA-256 (pre-anonymization pin): `cee443993022e83eb18310ab4d6c9c93d8a46f3079a4582ae0d896e16e4ae861`

Committed SHA-256 (anonymized bytes): `c72274bc1035c693d196cddaac1af1b0d7e276bd7a96c8bb65899fa9cabd0f33`

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
