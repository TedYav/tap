---
name: self
description: "When invoking compact, rebrief, goal, loop, or clear on this seat, inject a supported harness control into its pane."
argument-hint: 'compact|rebrief|clear [--notify <seat>] [--model <name>] [--effort <level>]|goal|loop'
allowed-tools: 'Bash, Read, Grep, Glob, Write'
role: maker
---

# /tap:self — preserve context or author its continuation

The operator supplies intent. You prepare the text and any required brief;
`tap self` validates mechanics and submits the supported harness control.
Goal and loop set or strengthen only: no goal clearing/pausing, loop canceling,
slash injection or weakening language. Never bypass a refusal with raw keystrokes.

## Choose what survives

| Verb | What survives | Who writes the continuation |
| --- | --- | --- |
| compact | Same TAP instance and obligations; conversation summarized by the harness | Harness summary plus your authored checkpoint and additive focus |
| rebrief | Same TAP instance and obligations; fresh conversation with role, priming and selected state | You, constrained by the requester's Keep scope and Next step |
| clear | Deprecated alias of rebrief | Author the same brief and invoke canonical rebrief |

A new workstream belongs to the requester: use peer `tap clear <seat> -m`,
`tap refresh <seat> --fresh`, or a new seat under the existing lifecycle.
“Wait for my next assignment” is a valid rebrief Next step. History remains
retrievable; it need not be loaded into the new conversation.

| Verb | Claude Code | Codex CLI | OpenCode | Other |
| --- | --- | --- | --- | --- |
| compact | yes | yes | yes | exit 6 |
| rebrief / clear | bound transcript | bound transcript | exit 6 | exit 6 |
| goal | yes | yes | exit 6 | exit 6 |
| loop | yes | exit 6 | exit 6 | exit 6 |

All self context verbs require an authored brief. Only Claude supports inline
compact focus; Codex and OpenCode receive the focus in the recovery note.
`tap compact <self>` refuses on every harness and points to this skill.

## Prepare compact, rebrief or clear

Always author the handoff yourself at `tmp/<seat>/handoff-<UTC>.md` in the
worktree. The operator need not supply a filename. The former skill-level
`--handoff` boolean is a compatibility no-op: strip it and prepare the file
as usual. The CLI's `--handoff FILE` still takes a real file.

Read the current charter, original decision sources and live work state.
Reconcile custody before resetting. If essential role or priming sources are
unavailable, report failed preparation and the missing source; do not improvise
that role. Preserve any supplied keep-scope in the request and in the brief,
without inventing a keep-scope flag.

The brief contains these sections; use explicit `none` for empty state:

- **Charter** — role, mission, decision boundaries, standing rulings and the exact
  skill invocation that restores the role, such as `/tap:conduct` or
  `/consult prime ai-native-development`. Include durable source pointers for
  role and priming instructions; reload them as guidance rather than paste them.
  Also list every other behavior-shaping state active in the session, each with
  the invocation that restores it: primed expert roles, mode skills such as
  `/ponytail` (with its level), and working preferences the operator stated
  here. The resumed seat reapplies them as guidance without replaying their
  initialization.
- **Operator words** — text the operator wrote after the verb and flags (for
  example `rebrief when you come back, rerun the gate`) is an instruction, not
  plumbing. Carry it verbatim, labeled as the operator's words, and let it shape
  Keep scope, emphasis and Next step. If it conflicts with a live hold or
  obligation, say so in the brief; never silently drop either.
- **Keep scope** — the requester's selected work and boundaries. Narrowing scope
  never silently retires an ask, custody or monitor: transfer it or retain a
  one-line pointer and its owner.
- **Objective and Where** — repo, absolute worktree, branch, full HEAD and dirty files.
- **Decisions** — consequential choices, their reasons and source ids.
- **In flight** — still-owned payload ids, seats, PR heads, gate receipts, custody,
  and each live scheduler/watcher/job id with its output and done signal. Carry
  these forward, including parked work and explicit holds.
- **Evidence pins** — durable absolute paths, commits and source pointers.
- **Next step** — the ordered actions or wait, with the condition that resumes or
  stops each. Several steps are fine; contradictory ones are not. A brief that
  says wait names the resume condition and does not also say “and do X”: work
  that waits on that condition goes under a labeled **After resume** list. An
  update that supersedes an earlier instruction says what it supersedes.

Before resetting, resolve the source paths the first action needs (charter,
plan, handoff, tree) and confirm each exists. Fix a missing pointer or carry an
explicit fallback in the brief.

Write references that stand alone after context loss. Never use “the above” or
“what we were doing” as an anchor. Keep the source under the seat-owned worktree
scratch path, not `/tmp`, `.tap` or a bus directory; the runtime owns the durable
copy. A separate nonempty charter may be passed with `--charter FILE` on rebrief.

For compact, compose additive focus that names every live thread and concrete
anchors the generic summarizer may lose. Do not narrow it with “only on”,
“ignore”, “discard” or similar language. Keep it within 2,000 characters;
the detail belongs in the brief.

Run the prepared command:

```bash
tap self compact --handoff /ABS/tmp/seat/handoff-UTC.md -- 'Preserve: live review, branch, holds and next test'
tap self rebrief --handoff /ABS/tmp/seat/handoff-UTC.md
```

These show the two choices; run only the requested one. `/tap:self clear` runs
the rebrief form. Raw `tap self clear --handoff FILE` uses the same engine and
prints a migration line; bare clear refuses before any effect.

`--model NAME` and `--effort LEVEL` are optional on compact, rebrief and clear,
Claude Code only; pass them through when the operator names them. After the
reset is proven and before the resume note, the worker runs `/model NAME` then
`/effort LEVEL`, so a seat can compact or rebrief on a cheap model and resume
on the one it needs:

```bash
tap self compact --handoff /ABS/tmp/seat/handoff-UTC.md --model fable --effort medium -- 'Preserve: ...'
```

Each switch is proven from the transcript. An unproven switch never withholds
the resume; the note then opens with a warning. Tell the operator when you see
one. Claude Code also saves each switch as its default for new sessions.
Effort is `low|medium|high|xhigh|max`. Other harnesses refuse with `6` before
anything is armed.

`--notify SEAT` is optional on compact, rebrief and the CLI clear alias. Pass it
only when the requester explicitly names an outcome audience. It transfers no
supervision, recovery ownership or obligations. A requesting peer that wants
an outcome passes itself; an invalid, self or inactive recipient refuses before
effects. Omission never chooses a bystander. After recovery, report in your own
conversation for the operator. If asynchronous failure prevents recovery and
notify was omitted, the outcome exists only in the durable receipt and log.

The runtime validates a readable, nonempty regular file and copies it before
arming. Compact returns `0` queued/armed; rebrief and clear return `8` armed,
reset unverified. Report the receipt and end the turn immediately. Neither exit
proves completion or that the resumed seat read the brief. Other nonzero results
are refusals or uncertainty; inspect them without replaying a possible effect.

## Recover in this order

1. Read the **whole brief**, including charter, handoff, Keep scope, holds and live
   scheduler ids, before acting on a role instruction.
2. Load the named role skills as guidance **without replaying initialization**.
   Do not staff, dispatch or re-arm a schedule merely because the role's startup
   procedure says to do so. Missing essential priming is a stop, not a guessed role.
3. Run `tap whoami` and `tap poll <self>`; reconcile live state, custody and
   still-owned obligations. A recovery note is settled by `tap read`; transport
   acceptance is not evidence of this read.
4. Follow the brief's **Next step**, including a hold or “wait for orders”.
   Outstanding obligations stay recorded.
5. Report the absolute brief path read, restored role and next action to the
   explicit notify recipient, or in your own conversation when notify was omitted.

Only the resumed agent reports successful reading. The worker sends no second
success notice. On failure it sends a best-effort notice only to explicit notify,
with the receipt, preserved brief and next safe action. Notification failure is
recorded separately and never rewrites or replays the reset outcome. Inspect the
receipt and forward the preserved brief when needed; do not reset again to retry
recovery delivery.

Rebrief preserves the TAP instance and its obligations. It is an explicit
workflow, not a scheduled policy or a claim that fresh context outperforms
compaction. Native Claude identity must change before delivery. Codex may bind
its rollout lazily: the observer requires a same-process native thread start,
a held writer lock, bounded rollout absence and recovery-first input. Unknown
witness evidence stays pending. UI paint and queued delivery cannot prove the
brief was read. Scheduled-job survival across `/tap:self rebrief` remains
unverified; record live ids and reconcile them after recovery.

## Goal and loop invocation

Compose the text using the guidance below, then run
`tap self <goal|loop> [--interval 5m] -- '<text>'`. Exit `0` means submitted;
`4` means deferred, retry once when idle; `6` means unsupported, surface it.
Report other refusals or uncertainty without bypassing the courier.

## goal — evaluator-safe, or it will burn tokens forever

The goal evaluator is a small model with **no tools**: it judges the goal text against the transcript alone, after every turn. The verb enforces the structure; you supply substance that satisfies it honestly:

- **Explicit referent**: a real path (`docs/GETTING-STARTED.md`) or a quoted named objective — never "this plan" (deixis is rejected; the evaluator may never see this conversation).
- **Transcript-provable evidence**: "smoke exits 0", "PR URL posted" — things your own output will demonstrate.
- **Disjunctive Done-when**: `Done when EITHER (a) <full completion evidence> OR (b) <named boundary reached>`. A stop condition written as prose beside the predicate can be honored but never *satisfied* — the run then evaluates "not done" forever. Two learned corollaries: freeze the referenced artifact before goaling over it (a goal over "every checkbox in X" broke when finalize appended steps to X), and never put another principal's authorization inside branch (a).
- **A turn/time bound** (`or stop after 20 turns`) as the runaway guard — the evaluator judges this clause too. Max 4,000 chars.

## loop — self-contained prompt, set only

- With `--interval` (`5m`, `2h`) the loop fires on schedule; without it the harness self-paces. Claude Code only.
- The prompt must stand alone: every fire may land after compactions, so the deixis gate applies — name paths and objectives, not "continue the current work".
- `/tap:self` never cancels a loop. Stopping is the user's (Esc) or the harness's own call.

## Mechanics and exit codes

Goal and loop submit synchronously through TAP's native courier; Claude compact delegates that same typed-prefix submit to its detached worker, the one submitter that types the command token ahead of the payload (tap-lmbs) — input-band detection is never reimplemented. "Verified" means the command left the input line, **not** that the harness processed it. The queue-at-turn-end behavior is an observed harness property (field-tested on Claude Code; input submitted mid-turn is read when the turn ends), not a documented guarantee — if a harness update changes it, this skill's timing contract is the thing to re-verify. Those injected lines keep a visible `[[sv:<id>]]` marker; on the goal path the marker is inert text the evaluator re-reads every turn — accepted cost. Claude's composer is a viewport (pane height minus about fifteen rows); a `/compact` focus that wraps past it scrolls the command row out of frame, and the courier then proves the control from its visible marker-anchored suffix on that arm alone (tap-vho8h, [protocol](../tap/protocol/delivery/submit-verify-helper-lib-sh-tap-submit-verify-part-08.md)). The focus is capped at 2,000 characters before any pane effect: name the handoff path and a few anchors; the detail lives in the handoff file.

Codex and opencode `compact` cannot carry inline focus or markers (passing inline text converts `/compact` into an ordinary prompt or refusal). Their focus rides the **resume note** (`handoffPing`'s focus argument in `runtime/bun/src/compact-focus.ts`), verbatim. The arming function builds that ping from the durable copy and hands it to the detached worker, which owns every pane effect under the existing pane-submit lock and never resubmits. On opencode nothing is staged: an occupied composer is refused by the courier, never replaced. Claude likewise has one worker-owned path: it queues behind a human draft, copy-mode or a held pane-submit lock, without clearing or appending to the draft. A working turn alone does not block submission. Only a proven no-input refusal may be retried; any possible text or Enter effect ends retyping.

The verb-support table above is documentation; `focusMode` in `runtime/bun/src/compact-focus.ts` (peer compact), `checkHarness` in `runtime/bun/src/self-gate.ts`, and their tests are authoritative — update all three together when a harness gains or loses a verb or changes whether compact accepts inline focus.

For compact, exit `0` means queued/worker armed, not submitted or resumed.
The receipt is the later outcome. Claude no longer returns `4` for a transient
composer or lock hold; its worker waits for the existing courier checks. A
pre-submit timeout (default ten minutes, `TAP_SELF_COMPACT_TIMEOUT_SECONDS`)
records `not-submitted`, preserves the handoff and sends no resume. Receipts
retain `queuedAt`, `submittedAt` when verified, and `compactedAt` after proof.

Goal/loop retain `0` submitted, `4` deferred and `5` submit unverified. Common
failures are `1` validation/arming, `3` pane gone and `6` unsupported. Compact
arming failures happen before pane input; the old submitted-but-not-armed exit
`7` is no longer emitted. Clear/rebrief return `8` when their observer is armed;
their receipt reports the later outcome.

The detached worker writes its log beside the receipt and a pointer line for each terminal
state to `${TAP_INDEX_HOME:-~/.tap}/self-helper.log`. A successful arm means only that the worker
started. The compacting seat ends its turn immediately rather than waiting on its own wake.

Every family requires fresh bound transcript/store proof before sending the
resume. Missing proof records `not-compacted`, preserves the handoff and sends
nothing. A refused resume is `resume-miss`. The worker never repeats a possible
input effect, and note acceptance never proves recipient processing.

Tests: `runtime/bun/test/self-gate.test.ts` (the text and harness gates), `scripts/smoke/self.test.sh` (outside-in `tap self`), `scripts/smoke/self-rc4-origin.test.sh` (the synchronous goal/loop rc-4 deferral origins) and `scripts/regress/compact-wake.test.sh` (mock tmux — never touch a live pane); the resume worker's family modes, queued submission, proof gates and receipts are in `runtime/bun/test/self-compact.test.ts`.
