# Codex composer controls

Captured on 2026-09-06 from a disposable Codex v0.153.4 specimen, model gpt-6-astra medium, on a private tmux socket with isolated HOME and TAP state. These are fresh controls, not captures of the original 18:21Z stall in tap-7r3fn.115.

`codex-idle-empty` is the idle 80x24 composer. `codex-idle-staged-80` contains a manually staged sentinel after two successful sandbox sends. The same staged composer was resized to 40x24 for `codex-idle-staged-40`; clearing the specimen input yielded `codex-idle-empty-40`. Captures use `capture-pane -p -e -J`; `.txt` files remove ANSI sequences only. The narrow footer ends in `left…` without another separator.

`codex-status-wrapped-constructed` derives four hard rows from the existing `codex-status-2token.ansi` fixture. Those variants are constructed controls, not additional live captures. A complete footer followed by arbitrary text must remain ambiguous.

The original canonical payload was a delivery-failure notice, not a digest. Six later sends recorded unparseable-marker refusals and stopped retrying before the manual recovery. The original 80-column missing Enter remains unattributed because no contemporaneous frame survives.

`codex-terminal-context.ansi` is the exact idle-staged frame from the 2026-09-07 tap-h9czh live control at a05712531, with plain companion `.txt`. Its configured status line ends at `Context 99% left` without a following separator or ellipsis. Source: primary `tmp/lane-aspen-d1-codex/h9czh/retry/current.ansi`; the retry control and receipt chain are documented in `h9czh/RESULT.md`. The test derives an empty composer by removing only its active sentinel.

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step.
