# CLI surface (the whole thing) — source part 11 of 11

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0085 start=562543 end=567002 sha256=d266df56dc32288135de7a49389aa9b046437220b7109b62cff2d38f99de6f7e fragment=11/11 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
Human `team` and `roster` target misses, and target misses on team attach, detach, down, up, and shutdown, may use the installed fzf team picker. On those action doors, an omitted `--only` or `--except` value picks parent seats; an ordinary following token is always an exact comma-list. The picker needs a foreground terminal and human output. JSON, redirected input/output, `TERM=dumb`, corrupt or absent machine authority, and conflicting selectors refuse with an explicit-target remedy. Choice alone never authorizes a changed row: action owners receive a finite positive parent cohort and revalidate selected instances under their existing mutation custody. Parent stop actions bind the foreground harness process generation; crew selection follows durable owner handle and instance, while current process proofs guard stops. A changed crew row refuses instead of inheriting earlier consent. Preview precedes `[Y/n]`; `--yes` skips that confirmation only, and dry-run has no action effect. Existing supplied-list automation keeps its direct path.

Checkpoint inventory `files` counts regular files only, matching existing archives: symlinks are copied verbatim, never followed, and excluded from the count.

Restore validates checkpoint identity, inventory, registry format, pristine generation, destination state, and session-name collisions before acquiring its fence, then repeats the mutation-sensitive checks under that fence before copying. Unobservable session names refuse when the checkpoint contains named sessions. A checkpointed `team-registry.json` or `registry.json` that is not `{"schema":"0.20","team":{...},"seats":{...}}` refuses as `old_store` before anything is published; restore never converts it and never rewrites the archive. Only a dead-owner, same-bundle `team-restore` fence admits a partial-restore retry; `--again` never bypasses the other gates. Restored rows keep their delivery class, lose stale pane bindings, and remain suspended until explicit recovery.

**Stateless one-shot invocation (`tap ask`, tap-rjdi).** `tap ask` is the
driver-facing bottom rung for one heterogeneous opinion. The dispatcher routes
both the command and its exact help spellings before sourcing `lib.sh`; therefore
it cannot create, reconcile, or advise through a TAP bus as a side effect. It
creates no pane, registry row, payload, receipt, or lifecycle record. Every call
starts a fresh native harness invocation and supplies no resume or continuation
flag. Native conversations persist by default. After a successful answer, stderr
reports the exact native id and, when its artifact is verified, one
`tap crew add <harness> <name> --preset <preset> --resume <id> --cwd <original-cwd>`
command (or `--model <model>` for a bare harness). The cwd is canonical and all
values are shell-quoted. A missing launch model stays an explicit placeholder.
Missing, malformed, conflicting or unverifiable capture gets a limitation and
no adoption command. No newest-session inference is permitted. A follow-up uses
that crew command; a durable lane uses `tap session launch`.

The prompt is the literal UTF-8 contents of the required regular file passed to
`-f`. Non-regular paths refuse before reading, so a pipe or device cannot block
outside the invocation timeout. Claude and Hermes relay raw answer bytes. Codex
captures its id from `thread.started` and relays its final-message file verbatim;
Cursor and Antigravity extract their final result text; OpenCode relays native
text events. JSON event metadata never enters answer stdout. Diagnostics and the
receipt stay on stderr, also under `TAP_JSON=1`. Invocation-private capture files
are removed on success, error, timeout and signal. The harness exit status passes
through; an exit-0 harness that produced no answer bytes refuses as a TAP
validation failure rather than passing as a silent success. TAP validation
failures exit 1, a missing harness executable exits 127 while
naming it, and the outer timeout exits 124 while naming the harness and duration.
Each adapter has a 900-second cap; a positive `TAP_ASK_TIMEOUT_SECONDS` overrides
it for bounded automation. `SIGINT` or `SIGTERM` cancels and reaps the whole
harness process group, then exits 130 or 143 respectively. The outer deadline is
the only timeout TAP enforces; no harness-native timeout flag is forwarded.

| harness | executable | fresh headless argv (prompt placement) | explicit model | timeout |
| --- | --- | --- | --- | --- |
| Claude | `claude` | `--print --session-id <uuid>` (stdin) | `--model <tier>` | 900s outer |
| Codex | `codex` | `exec --color never --json --output-last-message <private-file> -` (stdin) | `--model <tier>` before `-` | 900s outer |
| OpenCode | `opencode` | `run --format json -- <prompt>` | `--model <tier>` | 900s outer |
| Cursor | `cursor-agent` | `--print --mode ask --output-format json -- <prompt>` | `--model <tier>` | 900s outer |
| Hermes | `hermes` | `--usage-file <private-file> --oneshot=<prompt>` | `--model <tier>` before `--oneshot=` | 900s outer |
| Antigravity | `agy` | `--output-format json --print=<prompt>` | `--model <tier>` before `--print=` | 900s outer |

`--ephemeral` opts out on Claude and Codex: Claude uses
`--no-session-persistence` without an assigned id; Codex uses `--ephemeral`
without JSON/final-file capture. Other harnesses refuse before execution because
they expose no verified no-persistence switch. Presets cannot override the
adapter's persistence, conversation-selection or capture flags. Persistent
native history uses disk and can be selected by enabled memory jobs that use
model quota. Third-party memory hooks may capture prompts regardless of native
persistence; `TAP_STATELESS` prevents TAP binding, not those hooks.

The native artifact check reads the child's effective store environment. Claude
requires transcript metadata with the exact id and cwd; Codex resolves exact ids
across its rollout store; OpenCode requires its exact session_v2 row and directory;
Cursor uses its cwd-hashed chat store; Antigravity uses the exact conversation
database; Hermes requires its exact sessions.id in the native state database.
An unavailable reader is not proof of resumability.

When `--model` is present its value is always forwarded through the named
adapter flag; it is never silently replaced by a TAP default. When absent, the
harness's configured default remains authoritative. Output is the deliverable:
callers that receive a large response apply the ordinary compact-return floor by
writing it to a file and quoting the pointer.

**Message source contract.** `tap send` and `tap reply` accept exactly one of
`-m`, `-f|--body-file`, or a positional payload file; combinations refuse with
exit 1 / `usage_error`. `-f -` reads stdin as literal message-body bytes. For any
other body-file argument, the source must be a readable regular file: a missing
path is exit 1 / `not_found`, while a non-regular or unreadable path is exit 1 /
`usage_error`. Send creates an unpredictable mode-600 temporary payload (`mktemp`'s
`body-file.XXXXXX` shape, `O_CREAT|O_EXCL`; the shared construction module does
this for the inline and wrap temps too), writes
empty frontmatter, then copies the source bytes without examining the first
line. Leading fences, YAML-looking fields, backticks, and dollar-parentheses
therefore remain message body. The existing send cleanup owner removes the
temporary on success and refusal. The positional form remains a complete payload
whose existing frontmatter and fenceless-auto-wrap behavior are unchanged. Reply
forwards stdin or a named body file through send and settles the inbound only
after the outbound is durably accepted; a read or send refusal leaves the
inbound unsettled. `tap escalate -f -` reads stdin directly and selects the first
non-empty line after removing carriage returns, matching its named-file behavior.

`tap send` exit codes (so callers/smokes branch deterministically): `0` durably accepted (`status=injected|queued`) · `3` pane-gone (→ human-relay; entry suspended when registry-sourced) · `5` submit-unverified · `1` terminal refusal/usage/other. Retryable no-input-prompt, pending-draft, stuck-copy-mode, and deliberate `--polite` parks return `0/queued` with `delivery=spool` through the shared spool engine; poll delivery returns `0/queued` with `delivery=poll`; verified pane submission returns `0/injected` with `delivery=pane`. Denylisted/unsupported panes return exit 1 with no artifacts. Exit 4 is not a `tap send` outcome in v0.7.

<!-- The tap nudge grammar lives on its owning page, nudge.md; --interrupt, --from, --reason, -m and -f retired in tap-xe42x. -->

```text
tap nudge --harness <family> [--team <team|*>] [--recently-working[=<duration>] | --all | --active-within <duration>] [--message <text>] [--no-interrupt] [--dry-run] [--yes]   # fleet wake: each seat runs the ladder; see [nudge-fanout.md](./nudge-fanout.md)
```
