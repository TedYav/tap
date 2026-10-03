# Claude compact wrapping, September 22

The plain frame reconstructs the operator's 18:33:25 screenshot of maple-coach on
Claude Code 2.1.280, with the pane independently observed at 96 columns.
The full expected command comes from that seat's bound transcript tool call
and the visible self marker. This is a screenshot transcription, not a saved
raw ANSI capture; status colors and the token-bar decoration are omitted.

The 1,183-character command is unchanged when the displayed rows are joined.
Two content rows occupy 93 columns. Another row wraps before `gate` even
though that word would end at column 93. The old matcher allows only 92
content columns and therefore refuses before Enter. The busy variant in the
tests changes only status chrome; it is a constructed control, not another
live capture. Neither busy text nor a marker alone licenses submission.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
