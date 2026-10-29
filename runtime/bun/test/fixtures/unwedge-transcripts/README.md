# Transcript metadata projections

These fixtures preserve captured row types, message roles, content provenance and terminal-error fields. Conversation text, names, paths, IDs and request bodies are replaced or omitted. They exercise bookkeeping that the first minimal suffix tests missed.

`codex-metadata-stop.jsonl` projects the context and initial input rows of a real October 27–28 Codex session, plus its later capacity terminal event at October 28 06:52:04Z. It retains the actual `content_item_kinds` and `content_item_metadata.provenance` fields that distinguish injected context from `user.text`. Intervening productive work and other inputs are omitted; the stimulus is replaced with the test's canonical wire. This is a constructed repeated-failure sequence using captured schemas, not evidence that the captured turn had no progress.

`claude-metadata-stop.jsonl` projects a Claude Code 2.1.312 input/API-error span inspected October 28: input, history/title/mode bookkeeping, API requests, an API-request echo, terminal API error and turn duration. The original span also had a real tool-use and tool-result between the input and final error. Those productive rows are omitted to isolate the metadata-only failure case; negative tests put productive output back. The terminal `stop_sequence`, API-error marker and human origin are preserved. This is not an unmodified captured recovery attempt.

The positive tests model our own stimulus followed only by the same stop and identified bookkeeping. Negative tests add real work, another input, untrusted context-looking text, queued commands and unfamiliar records. No live recovery outcome is claimed from these projections.
