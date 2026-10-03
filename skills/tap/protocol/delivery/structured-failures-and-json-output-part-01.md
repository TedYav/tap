# Structured failures and JSON output — source part 1 of 7

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0097 start=651209 end=652535 sha256=3447c3041e92f5731bafb3286ec7d7e797a718e009487d3333dd2cc1956d532c fragment=1/7 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Structured failures and JSON output

Numeric exit codes remain the branch contract (R16). A structured failure emits exactly ONE renderer, selected by mode — never both:

- Default view (no `--json`): one human line on stderr.
- JSON mode (`--json`/`TAP_JSON=1`): one JSON object on stdout; nothing on stderr, except failed batch seat-classifier subprocess diagnostics from `tap team --json` and `tap team refresh --json` (see Failed seat classification, tap-30knu).

```
tap <verb>: <plain cause>; next: <plain recovery>
```

```
{"ok":false,"error_class":"<token>","action":"<action>","detail":"<detail>"}
```

`error_class` distinguishes wording variants without minting new exit codes. `action` is the recovery a caller can surface or execute. `detail` is optional context for humans (omitted from the JSON object when empty). An optional trailing `"effect":"none"` states that the command was refused before any bus or pane effect, so it may be repeated as-is; absence states nothing. Today only `tap send`'s `server_unresponsive` refusal before placement carries it (tap-yk8it), and the reminder watcher re-attempts on that field, never on `action` text. The JSON shape is the parser contract and MUST remain byte-stable when presentation changes; the default-view human line is not byte-stable (wording may evolve). The `error_class` vocabulary survives as JSON fields, not as default-view bytes. Inline `` `error_class=<token>` `` references throughout this document name that JSON field's value, not a default-view stderr line. No ANSI styling is added, so `NO_COLOR` leaves output byte-identical. The current agent-facing catalog includes:

