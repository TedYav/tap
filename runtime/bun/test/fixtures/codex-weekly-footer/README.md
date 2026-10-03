# Codex weekly-footer incident controls

`captured.ansi` preserves the frame from the 2026-09-09 Example-Workspace-1 empty-composer red-flash incident (tap-7r3fn.129, duplicate tap-17xj3). Source: primary `tmp/lane-lead-9-8/incident-ponytail-flash/captured-frame.txt`, from the submit-unverified receipt for payload `Maple-Designer-20260909T013448Z-946febf62c78`. ANSI bytes and footer layout are retained.

`idle.ansi` and `nofooter.ansi` preserve the leader's supplied variants: the former removes the transcript sentinel/Working rows, and the latter removes only the footer. `typed.ansi` derives from the idle variant by replacing only the dim placeholder with unstyled `Please keep this draft.`. It is a constructed draft control, not a live typed capture.

Before the fix, captured/idle classify as drafts containing the placeholder and footer; typed includes the footer in its draft. Nofooter is ready. Tests require ready for the three placeholder frames, typed-only draft preservation, and parity through the public Bash composer reader. That Bash function delegates to the shared native reader; parity checks the integration seam, not an independent parser.

`goal-paused.ansi` is a constructed variant of `idle.ansi`: it adds `Goal paused (/goal resume)` to the weekly footer without a dot separator. The unknown-footer control appends an unfamiliar row to the idle specimen in the test. Both require empty readiness from the exact dim placeholder, while an unstyled placeholder remains a draft.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
