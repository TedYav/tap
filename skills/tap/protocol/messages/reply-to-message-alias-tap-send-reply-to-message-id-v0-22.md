# Reply-to message alias (`tap send --reply-to <message-id>`) (v0.22)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0060 start=381576 end=382700 sha256=767c98e9b807ba84311b05c60965711d9c7cdb0d0411f68a1cda38729c13c680 fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Reply-to message alias (`tap send --reply-to <message-id>`) (v0.22)

When the value of `tap send`'s existing `--reply-to` option resolves to an
existing message id, `tap send <original-sender> --reply-to <message-id> -f
<body-file>` is a pure alias of `tap reply <message-id> -f <body-file>`. The
destination must equal the inbound message's original sender (`from`, qualified
with `from_team` when present); a mismatch refuses before any payload or
settlement mutation and names both handles. A message-id alias requires `-f
<body-file>` and refuses without it. The delegated `tap reply` owns the normal
literal file-body, delivery, outbound durability, and inbound settlement
semantics, so the alias cannot create a second settlement path. Reply-compatible
options (`--team`, `--pane`, `--kind`, and `--expect-reply`) are forwarded; other
send-only options are refused rather than silently discarded. Values that do
not resolve to an existing message id retain the established `--reply-to
<handle|team/handle>` routing behavior. Recipient self-settlement of its own
outbound remains outside v0.22 item 14a (item 14b).

