# Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 2 of 3

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Registration
> temporarily retains the AGY start-token helper and `agy_ls` descriptor until
> its native cutover. The source below is historical, not an activation guide.

<!-- tap-source id=source-0143 start=909044 end=917878 sha256=9df2f6a952dc7493e4676297d75b9102c4bde0f48842af4881278085aa9427fd fragment=2/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
`api-accepted` is emitted only when a response payload was actually seen. Exit 0
with empty output — a local CLI no-op, a flag that silently stopped doing anything
— records `stop-ambiguous`/`possible`/`none` instead: the tier is defined by having
received the door's success response, and claiming it without one is the ceiling's
own failure mode a level down.

An attestation requires a bound boot epoch: an ABSENT one is refused
(`no-bound-boot-epoch`) exactly as an unreadable current one is. Treating a missing
epoch as optional would leave a descriptor written during a boot-id outage
permanently exempt from freshness attestation, so a row surviving a reboot with a
recycled pid and port would attest as usable.

The deadline covers the attempt's process GROUP, not merely the process the driver
started: the attempt runs in its own group and the watchdog signals that group. A
surviving descendant keeps the inherited stdout open, so the command substitution
reading the driver blocks regardless of the rc returned — a timeout that reports
correctly and still hangs the courier is not a timeout.

**The group is the boundary, and a descendant can leave it.** One that calls
`setsid()` before the deadline is not reached by the group signal and keeps the
pipe open; the driver returns 124 on time and the call blocks anyway
(reproduced). A process group is the strongest boundary this driver can enforce
from inside itself — bounding an escaped descendant requires a deadline at the
dispatcher seam, which awaits the attempt synchronously and imposes none today.
Tracked in `tap-p55me`.

rc 10–14 (identity refused, class not claimed,
sentinel unreadable or empty, binary absent, malformed invocation) →
`retry-next-rung/none/none`; any unrecognised rc → `stop-ambiguous/possible/none`.

An unknown rc is classified **pessimistically** on purpose: the optimistic default
would let the router walk on after an effect may already have occurred, breaking
at-most-one-effect in exactly the case nobody anticipated. rc 126/127 is resolved
**structurally rather than numerically** — a shell reports 127 when it cannot
exec, and a program may exit 127 of its own accord, so the driver re-resolves the
binary: gone means nothing opened a socket and the attempt is retryable; still
present means agy itself exited 127 and an effect stays possible.

The driver never writes `tier` into `TAP_DRIVER_RESULT_FILE`; only `detail`. Its
static table already names every tier it is entitled to, so a refinement could
only contradict it — and a retryable row carrying a verified-submission tier would
be claiming both that nothing happened and that something was observed to land.

### Test seams

Three environment variables exist for the suite: `TAPDRV_AGY_BIN`,
`TAPDRV_AGY_TIMEOUT`, and `TAP_BOOT_ID_FORCE_EMPTY`. The first two substitute an
input — a fake binary, a shorter deadline — and the driver still reasons normally
about what it is given.

`TAP_BOOT_ID_FORCE_EMPTY` is a different kind and is called out for that reason: it
makes the driver **ignore a real system fact**, pretending a readable boot id is
unreadable, so that the refusal path is reachable on a box where `tap_boot_id`
works. It is admitted because the asymmetry is safe — the seam can only make
attestation **stricter**, never more permissive, so one left set by accident costs
availability rather than safety.

**A seam that could relax attestation would not be admissible on those terms**, and
any future seam of this kind should state which direction it can move before it
ships.

### Security

The agy language-server port carries **no authentication**: any local process can
speak to any agy seat's door. This is a machine-trust model, the same one TAP
itself assumes. Enforced rather than documented: non-loopback addresses are
refused, and no credential enters an argument, a result file, or an attempt-log
field.

### Digest and cross-bus views (tap-7r3fn.3.3)

`tap show <id>` and `tap read <id>` resolve an exact own-bus payload first, then
`spool/digests/<id>.json`, then enrolled buses from the global index. An explicit
`<team>/<id>` restricts lookup to that team's bus. Existing archive/quarantine
residency and ambiguous 12-hex suffix rules remain; exact own-bus live addresses
take precedence over other buses. A final `path=<absolute-path>` supplies a fallback
when the address cannot be found, or can be used alone. A miss lists attempted
locations. Explicit payload paths still pass read's envelope, filename/id, actor,
team, instance, reset, and receipt gates.

A digest view lists each item's id, from, kind, reply, settled flag, and path.
`--item <id>` reads one listed payload; `--all` reads all listed payloads. Each
selected item uses the ordinary verb: show writes nothing; read records each
ask's observation and settles each previously unsettled note. Existing settled
items remain settled. A bare digest read or `--all` records the envelope's
`.read` separately; either single-member form (`--item <id>` or `:n`) observes
only its member. Showing an index writes no receipt. A failure reading any
selected item makes the command fail after attempting the selected items.

### Digest item selectors (tap-7r3fn.107)

Use `tap read <digest-id>:<n>`, `tap show <digest-id>:<n>`, or
`tap reply <digest-id>:<n> -f <body-file>` for one numbered member.
Numbers start at 1; `<team>/<digest-id>:<n>` uses that team's index.
The colon is argument syntax, not part of a message id. Existing dotted ids
and explicit `path=` / `--payload` inputs keep their meaning.

Listings print each member's number and concrete next-step commands. A bare
digest read remains a listing; `--all` and `--item <id>` remain available.
Selecting a member, with either `:n` or `--item <id>`, uses its ordinary
authorization, residency and receipt rules. It does not record a read or settlement for the parent or siblings;
reply still requires a durable outbound before settling the selected ask.

Index writers preserve each member's `ordinal` when rewriting the index.
Legacy indices acquire numbers from their stored order; a rewrite carries
those numbers forward. A digest's membership may shrink but never expand.
Removed numbers are not reused. An invalid or absent number refuses with the
current member count instead of selecting another item; a non-digest parent
also refuses. These lookups do not change delivery or retention.

### Message provenance (tap-7r3fn.64)

`tap provenance <id|team/id|12hex|path=...>` (alias `tap who`) reports local corroboration without settlement, quarantine, drain or registry reconciliation. Its native leaf creates no state. The public entry retains the explicitly opted-in machine debug journal: with recording enabled, the invocation is recorded; with recording disabled, the command creates no state, including no Bun startup cache. Both shipped entry points use `cmdProvenance` and the shared payloads-mode resolver; stale rollback rows for either spelling are ignored with notice. `--team` anchors the caller and overrides its ambient local bus; `--json` carries the same facts as text. The marker-selected canonical registry and exact sender instance determine the current seat or matching historical instance; handle reuse and missing attribution cannot earn `record-match`. History comes from beside the selected registry, including a relocated registry. Receipt records remain distinct: placed is placement, sent is submission with `turn=unconfirmed` and no invented timestamp, read is observation, done is settlement, and cancellation is a sender action. Digest members keep their own evidence. Session age comes only from `session_created` bracketed by the retained bound-pane identity check and followed by a current-instance recheck, separately from last registration time; unavailable or future clocks remain unknown. Bound checks retain their 10-second timeout and the timestamp read its 5-second timeout. The bound-pane helper and its Bash/Python dependencies remain; command-owner retirement does not mean a Python-free process tree. Unknown or malformed optional evidence is reportable (exit 0), while usage/resolution/payload errors exit 1. Every output states that TAP runs on one machine, is not a security boundary, and editable local records neither authenticate authorship nor prove processing.

Receipt timestamps use an explicit calendar grammar: `YYYY-MM-DD`, `T` or space, `HH:MM:SS`, optional fractional seconds (dot or comma), and `Z` or a signed `HH:MM`/`HHMM` offset. Calendar dates, time fields and offsets must be in range; naive timestamps never acquire the local timezone. This intentionally narrows the former Python-version-dependent acceptance of hand-edited compact/week dates, other separators, offset seconds and `24:00:00`. Excluded or invalid values remain visible as `status=malformed` with a corrective reason, and optional malformed evidence keeps the report's successful exit. Raw files and valid receipt facts are preserved. A sent marker still ignores and omits `at`; it does not claim a receipt timestamp.

### Explicit sender resend (tap-7r3fn.22)

`tap resend <id> [--by <sender>] [--team <name>] [--json]` requests one explicit
successor send under a fresh id after affirmative no-attempt proof. Its frontmatter records `resend_of`;
the body bytes are unchanged, including line endings and a missing final newline.
Ordinary send resolves current recipient identity and preserves the reply obligation.

The existing JSON `delivery_semantics: at-least-once` and `.resent` delivery token
remain compatibility labels, not an at-least-once guarantee. They do not permit
retry after a possible effect or promise observation. The successor uses the
[ordinary reliability contract](../delivery/reliability.md).

The original is consumed (withdrawn, `receipts/<id>.resent`, successor prepared at
`archive/<newId>.resend.md`) before the successor send runs. A failed successor (nonzero exit, or
exit 0 with a JSON scalar, array or null receipt) is ONE error, status kept: one stderr line folding in the
child's stderr, the original, its receipt, the kept prepared file, one inspection
step, never a send: exit 5 may have taken effect, a signalled child proves
nothing absent, the envelope is no body. The step is `tap show <newId>`, anchored: `TAP_HOME='<bus>' tap show <newId>` under a pin,
`<team>/<newId>` under `--team`. `--json`: stderr empty; one `ok:false` envelope (`error_class` `resend_successor_failed` or
`resend_receipt_invalid`, `action`, `detail`) plus `recovery` (`original`, `receipt`, `prepared`,
`successor`, `next`).

Eligibility requires valid current registry authority, matching sender identity, a non-interrupt class, and affirmative no-attempt evidence:
new legacy-spool metadata carries `attempt_fence: 1` and integer `attempts: 0`.
The foreground driver, single redelivery and each digest member write a durable
`receipts/<id>.attempted` before attempting a pane effect; failure to write prevents
the attempt. Cleanup retains metadata under `archive/<id>.meta.json`, allowing
cancelled-spooled and terminal-unrouted messages to retain their evidence.
Any attempt log/marker, sent/read/done receipt, native intent, active claim,
missing/malformed proof or unfenced historical zero count refuses. An old
NOT DELIVERED notice alone is not evidence sufficient to bypass this guard.
