capture_utc: 2026-08-19T23:28:11Z
pine-gate | tap_seat_state=idle-at-prompt | esc_to_interrupt_lines=1
pine-driver-D | tap_seat_state=idle-at-prompt | esc_to_interrupt_lines=1
pine-driver-C | tap_seat_state=idle-at-prompt | esc_to_interrupt_lines=0
---

## ROOT CAUSE (found in source, lib.sh)

`tap_seat_state`'s step (2) BUSY-FOOTER GATES is a `case "$harness"` with exactly TWO arms —
`opencode)` at lib.sh:8904 and `cursor)` at lib.sh:8910, `esac` at lib.sh:8916.

**There is no `claude)` arm.** A generating claude seat therefore falls through to idle-at-prompt.

The comment directly above that case block states the hazard the code then fails to cover:

    # (2) BUSY-FOOTER GATES — a generating seat that still shows an input band must
    # not fall through to idle-at-prompt. opencode and cursor keep (empty) bands
    # mid-turn; their busy markers are the readiness signal

The claude busy marker present in every captured pane is the literal string `esc to interrupt` in the
footer. It is exactly the readiness signal the comment describes, for the one harness the case omits.

## SPECIMENS (same-instant capture: tap_seat_state and the pane, one shell invocation)

    pine-gate      tap_seat_state=idle-at-prompt   esc_to_interrupt_lines=1   <- DIVERGENCE
    pine-driver-D  tap_seat_state=idle-at-prompt   esc_to_interrupt_lines=1   <- DIVERGENCE
    pine-driver-C  tap_seat_state=idle-at-prompt   esc_to_interrupt_lines=0   <- NEGATIVE CONTROL,
                                                                                genuinely idle at capture

The third row is a control obtained by luck of timing — driver-C's turn ended between the first
observation and this capture. A fixture built from this corpus should red on rows 1-2 and stay green on
row 3; a fix that simply reports `working` for every claude seat would pass the first two and fail the
third.

Full pane captures: pine-gate.pane.txt, pine-driver-D.pane.txt, pine-driver-C.pane.txt.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step. The three capture files were renamed with the same mapping, so the names above are the stand-ins.
