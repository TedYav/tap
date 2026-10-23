# Error-screen corpus

These are tails of real terminal captures. Conversation above the last error was
removed. Personal paths, seat labels and account/status lines were
replaced with `example` labels; their row positions are retained. Plain fixtures strip SGR sequences and trailing
padding; Codex retains SGR because its dim placeholder proves the composer is
empty. Error words and their order relative to the composer are preserved.
All fixtures keep the full tail from the last error onward; only preceding
conversation is omitted.

| Fixture | Harness version | Source |
| --- | --- | --- |
| `claude-api-overloaded.txt` | Unrecorded | Last error and composer from `../claude/idle-real.txt`, captured September 3. Despite its old name, that frame ends in API 529. |
| `claude-api-disconnected.txt` | Claude Code 2.1.302 | Captured October 17, 2026. The stream-disconnect error appears above an available composer. |
| `claude-quota-footer.txt` | Claude Code 2.1.302 | Captured October 18, 2026. Includes the live auto-continue footer below an available composer. |
| `codex-usage-limit.ansi` | Unrecorded | Captured October 18, 2026. The usage-limit error appears above an empty composer. |
| `codex-capacity.ansi` | Unrecorded | Captured October 19, 2026. The model-capacity error appears above an empty composer. |
| `opencode-rate-limit.txt` | Unrecorded | Captured October 14, 2026. The provider's error box precedes a separate empty composer. |

`agent-state-errors.test.ts` also reads the existing Claude Code 2.1.282 weekly
usage-limit **modal** under `../../usage-limit-modal/`, plus the approval,
working and idle fixtures for Claude, Codex, OpenCode, Cursor and agy. A modal
is `blocked`; an error with a proven usable composer is `error`. Missing
composer evidence does not establish error or a modal: existing unknown/booting
behavior and the exact-staged-input checks remain in force.

No captured Cursor or agy provider-error frame is included. Their approval
fixtures cover blocked behavior; provider-error layouts for those harnesses
remain untested. Harness versions are listed only when recorded with the capture.

Negative controls in the test are explicitly constructed from these captures:
newer normal responses and working rows, prose and indented quotations of
error strings, low-quota warnings, and Codex's ordinary interruption notice.
These controls test boundaries; they are not additional live observations.
