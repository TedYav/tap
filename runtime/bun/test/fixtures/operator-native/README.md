# Operator native evidence

`claude-model-cancel.jsonl` is a sanitized projection of three consecutive native
Claude transcript records observed on 2026-06-10, inspected on 2026-10-28. An
assistant `stop_sequence` at 11:30:59.520Z is followed by the `/model` command and
its `Kept model as …` stdout at 11:31:06.588Z. Both dismissal records have
`type: system`, `subtype: local_command`.

The row kinds, stop reason, timestamps and local-command content are retained.
The session id is replaced, assistant prose is a fixture sentence, and unrelated
metadata is omitted. This is not an unmodified transcript or a live navigation
result. The lifecycle test appends the two dismissal records and changes the
fixture file's mtime deterministically. It proves that the native reader still
reports an ended turn while activity advances, then checks final UI reporting.
Pre-key activity equality remains strict.
