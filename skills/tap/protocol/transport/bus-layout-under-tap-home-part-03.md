# Bus layout (under `TAP_HOME`) — source part 3 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0023 start=134488 end=143442 sha256=5138c275230352befc08d4dfd31a77b6c6aac4788cc080365b048f4b0a3790b9 fragment=3/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Which forms it intercepts.** Only local command forms: `team`, `poll`, `outstanding`, `send`,
`assign`, `peek`, `watch`, `goalie`, `escalate`, `remind`, `recap`, `refresh`, `compact`, `clear`,
`attach`, `nudge`, `lane`, `draft`, `digest-window`, `teardown`, `restore`, `unregister`, `out`,
`crew`, `session`, `register`, `in`. Every other verb — including `init`, `whoami`, `doctor`, `read`, `reply` and the
global/help surface — passes through untouched. Within those verbs the preflight also declines to
act, leaving the command's own authority path in place, when the argv carries: a `help`, `-h` or
`--help` token; any authority option (`--cwd`, `--machine`, `--dry-run`, `--team`, `--payload`,
`--remote-registry`, `--cross-worktree`, `--reply-to`, `--in-reply-to`, bare or `=`-joined); an
unrecognized flag; a positional containing `/` or `:` (payload references and cross-team addresses);
`team list` or `team roster <arg>`, or a `team`/`session` subcommand outside its known set; or
`send`/`assign` with other than exactly one positional.

**Absence must be positive evidence, and existing refusals win.** The preflight never fires when
`TAP_HOME` is set, and it treats only `ENOENT` on both the resolved acting registry and
`<root>/.tap/team-registry.json` as "no local team" — an unreadable or corrupt registry is not
absence, so a damaged bus keeps its own refusal and is never offered reinitialization. It also
defers whenever an identity is already known: `TAP_SELF`, a `--from`/`--by` value, or a
`poll`/`outstanding`/`peek` positional actor that names a seat in any enrolled team registry, or a
calling pane that is an enrolled seat. The registered-pane, wrong-cwd and identity remedies under
§Structured failures (`unanchored_bus`, `unregistered_sender`) are therefore reached unchanged; the
prompt is offered only where none of them applies.

**Interactive in a TTY: the default is YES.** The guidance
`No TAP team in <cwd>. Start one: tap session launch <harness|preset> <name> (for example: tap launch claude newcomer) — or tap init for an empty team.`
is written to **stderr**, followed by a newline and the prompt `Would you like to run tap init? [Y/n] `.
Exactly one line is read from stdin one byte at a time so that input belonging to the retried
command is never swallowed. A truly blank line, `y`, or `yes` (case-insensitive, trimmed) followed by a newline accepts; EOF,
`n`, whitespace-only input, or anything else declines and the command exits with the refusal code below, having created
nothing. On acceptance the preflight runs the existing `tap init` and, when init exits 0, dispatches
the original arguments once; a failing init returns init's own status and the original command does
not run. Initialization is never implicit — there is no path that creates a team without an
accepted answer.

**Noninteractive, `--json`, and stdin bodies never prompt or read stdin.** `register`/`in` retain their existing enrollment/refusal path in these forms and for callers without a TTY. Other local verbs retain the preflight refusal below. When the form carries
`--json`, or takes its body on stdin (`-f -` / `--body-file -`), or either stdin or stderr is not a
TTY, no prompt is written and stdin is not read. A `--json` form emits exactly one object on stdout:

```json
{"ok":false,"error_class":"unanchored_bus","detail":"No TAP team in <cwd>. Start one: tap session launch <harness|preset> <name> (for example: tap launch claude newcomer) — or tap init for an empty team.","action":"tap init"}
```

Every other such form writes the detail alone as one stderr line:
`No TAP team in <cwd>. Start one: tap session launch <harness|preset> <name> (for example: tap launch claude newcomer) — or tap init for an empty team.`
The exit code follows the established `unanchored_bus` split (§Structured failures): `4` for `poll`,
`outstanding` and `peek`, and `1` for every other intercepted verb.

### Failed-send atomicity (Unit 2)

`tap send` distinguishes durable acceptance from refusal. A higher-level caller must never see a nonzero terminal refusal while an untracked payload from that send remains outstanding.

Concretely:

- **Exit 3 (pane gone):** no canonical is ever written — the pane check runs before `canonicalPlace` (runtime/bun/src/courier.ts). After canonical placement, a native pre-effect park promotes durable evidence into the shared spool before retiring canonical residency; possible-effect failures preserve canonical evidence and return submit-unverified. Certified pre-effect `identity_mismatch` / `pane_gone` return exit 0 `status=queued, delivery=poll` with the real `reason`, `action`, and `detail` (identity keeps `tap register <to>   (the recorded pane is stale; re-register to rebind)`). Effect-ambiguous failures remain exit 5. **Native reset custody after placement (tap-0p7hx).** Send releases reset custody once the canonical is placed. The courier's per-stage fence read keeps any keystroke from landing under a reset fence. Each later bus write (park, pre-effect retraction, `.sent`, delivery clock, harness-queued and submit-unverified records) re-takes custody for its own duration. If a reset fence appears before the first keystroke, or custody stays busy past the bounded wait, the canonical is left where placement put it, since mutating during a checkpoint is the tap-g191v shape. The send then exits 5 with `status=placed, delivery=none`, `reason` `team_reset_fenced` or `reset_custody_busy`, and an `action` naming the payload's real fate. Under a reset fence the payload goes into the checkpoint and will not be delivered; re-send after the reset only if `tap outstanding` no longer lists it. A busy sidecar leaves it poll-visible with no automatic delivery. Once text has reached the composer, a late fence stays submit-unverified (possible effect). If a post-effect record cannot take custody, the record is skipped with a warning and the outcome stands, so a missing `.sent` during a team reset does not mean the message was never injected.

  **Native-route parks use the same engine as Bash.** Certified pre-effect `lock_busy`, `band_busy`, `rate_limited`, `copy_mode`, and `clearing` outcomes call `parkAndReport` in `runtime/bun/src/spool-park-report.ts`. That export publishes the existing spool body/metadata pair, removes canonical residency, and starts the existing deliverer. The receipt is `queued/spool`; `.placed` remains, `.sent` waits for verified redelivery, and the metadata retains the attempt proof used by `tap resend`. No native intent or native owner is created. A positively observed draft maps to `pending-input` with 30 seconds of grace; an unobservable band, lock contention, or rate limit maps to `no-input-prompt`. Native copy-mode remains a documented fork: it parks as `copy-mode` and never cancels copy mode itself. Identity mismatch and pane disappearance after placement retain the existing queued/poll carve-out. If parking fails, native preserves the available bus evidence and reports queued/poll with a warning that automatic redelivery is unconfirmed, without claiming resend eligibility.
- **Exit 0 (durably accepted):** `status=injected, delivery=pane` means pane submission verified. `status=queued, delivery=spool` means the fully stamped payload plus courier metadata are durable in `spool/` — this is also what a deferred auto-settled send returns, which ships **no new sender status**: it is queued in the spool, which is exactly what happened; `status=queued, delivery=poll` means the canonical is durable in `payloads/` for a poll-mode recipient. Exit 0 does not claim the recipient processed the message.
- **`turn=unconfirmed` (F4 §3.1, tap-dnub).** Every exit-0 send carries `turn=unconfirmed` in `tap send --json` — **all three dispositions**: `injected`/`pane`, `queued`/`poll`, and `queued`/`spool`. It is also written into the `.sent` receipt, which exists on the pane and poll paths only: the spool exit returns before the `.sent` write site, so a parked send has the machine stamp and no receipt to carry it **until redelivery verifies** (see the redelivery bullet below) (review finding — the earlier wording said "every exit-0 send" while enumerating two of the three, which is this section's own sin one bullet above its fix). `tap outstanding --json` marks each row that reached `.sent` with `"turn":"unconfirmed"`. **`tap reply` retains outbound fate and inbound settlement in its structured result**; ordinary human success is `tap reply: ok|queued <inbound-id>`, with warning/refusal paths still explicit. It never says only "replied to X and settled Y" when outbound delivery is queued or unverified. Bash reply still consumes send `--json` on injected branches (gate review). Queued output does not claim a pane submission. The pane-delivered human send receipt is `tap send: ok <id>`; the envelope retains the reply obligation. F4 §3.2's wording (`submitted to pane; recipient seat-side processing unverified`) is the `tap outstanding` legend and `/tap` copy, not a suffix on that send line; the poll receipt does not use a pane sentence, because no pane was touched and `queued` is already honest about what happened. **The legend is gated on a PANE row, not on the presence of a `.sent`** — poll delivery writes `.sent` at the same site and touched no pane, so the loose gate would have made a poll-only listing claim one. The `.sent` receipt therefore also carries `delivery=pane|poll`. A receipt predating that field is read as `pane` — a deliberate **fail-open heuristic, not a claim about history**: poll delivery has always written `.sent` at the same site, so some pre-field receipts are certainly poll. Fail-open is chosen because the errors are asymmetric — reading old receipts as poll would drop the legend from a pane board (the board the legend exists for), while reading them as pane only reprints the poll-only defect for a listing composed *entirely* of pre-field receipts, a population that shrinks to nothing as they settle. The poll path is stamped too: it had no line clearance at all, so it is at least as unconfirmed.

