---
name: tap
description: "When coordinating TAP liveness, recipient discipline, shared-tree safety, or cross-tree handoffs, apply all-seat rules."
argument-hint: '[plan-path]'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write'
---

# Using TAP — all-seat rules

Use this card for ordinary TAP work. Read the linked topic before staffing,
reassignment, shared-tree coordination, delivery recovery or migration; those
references retain the detailed rules and their rationale. `/tap:lead` owns team
strategy, `/tap:drive` owns lane custody, and `tap help <verb>` owns command grammar.
The invariant core is [CONTRACT.md](scripts/CONTRACT.md); detailed protocol authority is the [bounded protocol index](protocol/README.md).

## Read, act and settle

A sentinel is a doorbell; its payload body is the task. Read it before acting:

- `[[TAP v0.23 ask <id>]]` → `tap read <id>`, then answer with
  `tap reply <id> -f <answer-file>`.
- `[[TAP v0.23 note <team>/<id>]]` → `tap read <team>/<id>`; success settles
  the note. Nothing further is owed and no got-it reply is needed.
- The prefix names the sender's bus. Keep it for read and reply.
  Do not derive the bus from cwd. For an explicit pointer, read
  `tap read path=<file>`; a foreign answer can use `tap reply <payload-path> -f <file>`.
- For a digest, `tap read <id> --all` reads every body. Follow each item's
  obligation; skip settlement for `settled: true`. Never settle the digest.
- `[[TAP v0.23 nudge]]` (optionally `message="..."`) has no id, sender or
  payload: nothing to read, settle or answer, and no new task. Continue your
  existing work and check `tap poll`.
- Payload frontmatter remains `reply: expected` / `reply: settle-only`.
  Reply to a note only to report a problem. Ask the sender about an unknown
  sentinel shape; reload this skill on version drift.

Triage arrivals before switching work. Routine notes and discussion defer to the
active mission; urgent escalations take priority. If an ask's work remains queued,
use `tap reply <id> --progress -f <file>` so its obligation stays open. An ordinary
reply completes it. Settlement never cancels work assigned in the body.

Content importance does not permit preemption. Use `--delivery interrupt` only
to explicitly authorize aborting the recipient's current turn or tool call;
`--urgent` is its exact alias. `kind=escalate` alone uses ordinary delivery.
Interrupt disclosure in `tap read` names possible disruption, not a proven
cancellation. Inspect in-flight work and any paused goal before continuing.
An "interrupted by user" followed by a sentinel tagged `agent-interrupt` was
another agent's keystroke, not a human stop: read the sentinel and continue.

Avoid long-running foreground commands: run builds and long checks in the
background so the harness can accept input between tool calls. In Codex, Enter
submits during a turn and input is delivered at the next tool-call tick; Tab
queues until the turn ends and must not be used for TAP submission. On Claude a
shell `&` child outlives its tool call, so give it an owner (a `trap`, or a kill
by recorded pid); on OpenCode never background inside a tool call (see
[background processes](references/liveness-and-recipients.md#background-processes-across-a-tool-call)).
If you poll
mid-turn, `tap poll <me>` also lists your parked mail. `tap read <id>` can take
an unclaimed parked item before its doorbell arrives, under the same team and
recipient-instance checks. A later duplicate sentinel is safe to read again;
the first observation receipt stays unchanged.

After any harness rewind/resume anomaly, immediately run `tap poll <self>` and
handle each payload's own obligation. Before idling, use `tap outstanding <you>`
to expose supervision or handoff duties.

## Send literal bodies; keep work observable

When `[sentinel] preview = true` in the machine config (the session advisory
reports it), previews derive from the first non-empty body line by default.
Use `--preview` on send, assign or reply to override that text, for example
`--preview "Status update on the pre-release build"`.
Use single quotes when the hint mentions shell syntax. A preview is a display
hint; always `tap read` the payload before acting.

Write a body file, then use `tap send <to> -f <path>`. `--from` normally derives
from the registered pane. Cross-team addresses are `<team>/<handle>`.
For stdin, quote the heredoc delimiter:

```bash
tap send glm --ask -f - <<'EOF'
{"op":"transition","item_id":"F1","new_status":"accepted"}
EOF
```

Unquoted delimiters expand backticks and `$()` before TAP sees the body. Change
`EOF` only when the body contains that terminator on its own line. `-m` is for
short shell-safe text; a positional file is a complete payload, not just a body.
After resolving a body-file conflict, re-read its marker boundaries.

- **Batch jointly-known content: one structured payload per recipient per turn.**
  Use numbered section headings for items the recipient acts on separately; a
  machine-parsed skill declares its own body schema. One ask creates one reply
  obligation, so combine its receipt and substantive answer. A second payload is
  appropriate when its content became known after the first was sent, or when the
  items deliberately carry different reply obligations (an ask and a settle-only
  note). The specimen was 28 jointly-known proposals and 28 separate receipts,
  which created 56 injections (tap-6laov). Sending multiple notes or asks on a
  turn to another agent, for things which could have been known together, is an
  antipattern. They belong in one payload with a defined schema, such as section
  headings.
- **Work orders use `tap assign`**,
  which stamps `reply: expected`, `kind: order`. A progress reply reports work;
  an acknowledgement alone does not complete it.
- Plain sends are notes settled by the recipient with `tap read`. `--ask`
  requests an answer. `--wake` remains a compatibility note spelling; it creates
  no work order and changes no delivery timing. Bare composers receive immediately;
  drafts and queued followups follow their documented holds.
- Ordinary settle-only messages carry no directive. Contract-defined `probe`
  and `notice` supervision messages are the exception.
- A promised future ping is not a tracked obligation. Send now or create a
  `reply: expected` obligation when someone must follow through.
- After sending, replying or settling, continue any useful work that does not depend on the response.
  Never sleep or loop-poll for TAP traffic. Yield only when the next useful step
  needs a response or nothing remains.

Read [liveness and recipient details](references/liveness-and-recipients.md)
when assigning, supervising or deferring work. A working seat replies once with
status, then works; milestones and one line per pushed head suffice. Silence,
unchanged HEAD or a process census alone does not prove a stall.

## Staff visible seats and preserve continuity

Before adding or reassigning a seat, read [staffing](references/staffing.md).

- Start with `tap models` and `tap team calibration`; presets are optional recipes. One bounded answer → `tap ask`; a consult needing
  follow-up → `tap crew add` in the operator's current tmux session; a durable
  lane → `tap session launch`. Use resume for an existing seat. Session launch presets accept `--env`, `--unset-env`, and trailing harness
  arguments; `--model`/`--effort` stay preset-owned. The supplied name is the handle.
  zsh keeps an unquoted variable as one word, so pass the preset (or harness) and the name as separate words.
- Subagents return artifacts; any writes stay in their own isolated
  worktree. Crew seats are judgment/review/consult peers, never
  parallel writers. Launcher-managed seats retain a durable handoff.
- Every agent is visible: harness subagent, current-session crew, or named,
  rostered launcher seat. No anonymous agent tmux sessions. Pane-less poll
  senders are transport infrastructure, not staffed agents.
- Identity-gate a new crew seat: ask it to run `tap whoami`; dispatch work only
  after its returned handle matches. Registry/courier receipts do not replace
  that answer, and the check is not independent of the shared resolver.
- For unrelated reassignment: drain or hand off both queues, return tokens and
  leases, hand off custody, then clear, then send the new work with `tap assign`.
  A clear's `-m` is orientation only. Compact is for useful continuity, not an
  unrelated workstream; never hide the assignment in `tap compact -m`.

## Staffing a seat

`tap models` provides personal calibration or qualified reference guidance (access unverified).
Choose harness/model@effort, then launch from the intended worktree. Presets optionally save a combination you use often; OpenCode and Cursor support model only.
```bash
tap models
tap launch claude reviewer --model fable --effort high
tap assign reviewer -f charter.md
tap team --context
```

## Coordinate trees and handoffs

Read [worktrees and handoffs](references/worktrees-and-handoffs.md) before
sharing a checkout or handing work across trees. [CONCEPTS.md](../../CONCEPTS.md)
defines writer tokens and named-resource leases; the working repository's
`AGENTS.md` supplies its contribution and gate policy.

Multiple writers may share a tree. Choose custody for attributable evidence;
file-disjoint paths are not a safety boundary. Pause writes while a check reads
a mutable checkout. CI reads an immutable commit and does not freeze authoring.
Where a writer token is in force, one editor holds its scope and transfers it
explicitly. Announce tree-global operations before running them; escalate
thrashing instead of silently working around it. Avoid concurrent verification
that mutates the same checkout.

Copy handoff artifacts into the receiver's lane. A pointer into another tree's
`tmp/` or unmerged files is not durable custody. Preserve session context on disk
before transferring it. Record scope and writer-token transfers explicitly in
TAP work orders; disjoint paths alone do not make concurrent writes safe.

## Cover liveness without adding idle wakes

A multi-seat run needs a mechanism that notices a silent board and a direction
check that asks whether the team is building the right thing. The default delegates the
investigative checking and keeps one infrequent LEADER wake as the
backstop for delivery itself failing. A probe's settlement is part of that floor.
Use the [liveness reference](references/liveness-and-recipients.md) and
`/tap:choreography` for coverage, ownership and termination.

For delivery recovery, shell/body edge cases or a live-bus migration, read
[transport and migration](references/transport-and-migration.md) before acting.
`.placed` and `.sent` describe sender/courier effects, not recipient processing.
`tap nudge <seat>` unsticks a seat once (a known blocker, a staged sentinel, or
an interrupt plus the doorbell). Nudge once: after exit 5, or no progress, inspect
with `tap peek` and escalate; re-nudge only after a refusal that sent nothing. Never reset or migrate the live bus during ordinary work. A planned
migration drains every seat, sends one freeze notice, migrates, then resumes
traffic with poll self-healing.
