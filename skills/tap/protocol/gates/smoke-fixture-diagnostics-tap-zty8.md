# Smoke fixture diagnostics (tap-zty8)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0138 start=886635 end=887857 sha256=bd6840f10a756c015c726e5ee419aafeed7c813eca81fd2de4f72cce09d990af fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Smoke fixture diagnostics (tap-zty8)

Fixture setup may suppress stdout and successful stderr for noise control, but an unexpected non-zero identity command that stops a smoke routes through `tap_smoke_quiet`: the helper captures stderr in a private temporary file, replays it before returning the command's exact status, and removes the capture on both outcomes. Expected-failure and explicitly best-effort probes remain direct calls and are enumerated exemptions rather than hidden by an exclusion filter. `tap_calling_pane_id` likewise stays fail-closed while publishing each of its eight internal refusal points through the additive `TAP_CALLING_PANE_REFUSAL` channel: unavailable process observation, ambiguous TTY mapping, changed pane/TTY binding, invalid parent PID, ancestry end, the 64-step bound, a response that is not exactly four fields, and an empty `session_name` on the four-field observation. The same channel also publishes `malformed pane id` from the no-arg self-resolver after it consumes the one-record observation. Hard-fail callers fold that reason into their existing single renderer, so default view remains one human line and JSON remains stdout-only; best-effort callers can remain quiet.

