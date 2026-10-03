---
name: self
description: "When invoking compact, rebrief, goal, loop, or clear on this seat, inject a supported harness control into its pane."
argument-hint: 'rebrief|compact [--handoff]|goal|loop|clear'
allowed-tools: 'Bash, Read, Grep, Glob'
role: maker
---

# /tap:self — harness self-control (rebrief | compact | goal | loop | clear)

The user types `/tap:self <verb>`; you compose a high-quality argument from the current workstream and `tap self` injects the built-in into your own pane. The division of labor is the whole design: **the human decides to fire the command, you supply the judgment in the argument text, the verb enforces the allowlist.** Set/strengthen only — the verb hard-rejects goal clearing/pausing, loop canceling, weakening language, and any other slash command; do not try to route around it.

This is the successor to `harness-self` (see the layer contract in `skills/tap/scripts/CONTRACT.md`): local harness control. Recovery uses ordinary TAP notes; the resumed seat settles them with tap read. It creates no collaboration thread.

**`compact` is now one verb with two doors (tap-thgv).** `tap compact <seat>` routes a self-target
here, so `/tap:self compact` and `tap compact $(tap whoami) -m "…"` run the same injector — which is the
point: the per-harness compact matrix has ONE owner. Composing the focus stays your job either way.
`/tap:self compact --handoff` is that same injector plus an authored recovery record (boolean on this
skill only; `tap self compact` takes `--handoff <file>`). Do not invent a peer `tap compact --handoff`.
**The consolidation is partial and says so:** `goal` and `loop` have no TAP analogue and keep their
own injection path in `tap self`. Anyone claiming this skill is now a thin wrapper is describing one
of its three verbs.

## Verb support by harness

| verb    | Claude Code | Codex CLI           | opencode            | other  |
| ------- | ----------- | ------------------- | ------------------- | ------ |
| compact | yes         | handoff-gated only* | yes (bare only)*    | exit 6 |
| goal    | yes         | yes                 | exit 6              | exit 6 |
| loop    | yes         | exit 6              | exit 6              | exit 6 |
| clear/rebrief | yes (bound transcript) | yes (bound transcript) | exit 6 | exit 6 |

\* **Only Claude Code currently supports custom summarization instructions on `/compact`.** Codex and opencode take bare `/compact` only; their focus text belongs to the post-compaction resume prompt, not the summarizer. Do not infer inline support from the model family. **Codex (tap-n27ug):** a compact there without `--handoff` refuses before any effect, and the supported move is the handoff-gated worker below.

**Compaction resumes through one detached Bun worker** (`runtime/bun/src/self-compact.ts`) on every supported harness. It sends a TAP note to your own seat only after fresh durable proof. **Claude:** `tap self` queues the request; the worker waits through pre-input holds, submits `/compact <focus>` once and captures the bound transcript's byte offset and time at Enter. The worker requires a new, complete `isCompactSummary` record for that session. **OpenCode:** the worker waits for two idle reads, submits bare `/compact` once, then requires a fresh completed summary linked to a compaction request in the bound SQLite store. **Codex:** the handoff is written first; the worker pins the seat, native session and rollout, holds the pane-submit lock, sends at most one authorized Escape if working, submits bare `/compact` once, and requires a fresh `compacted` record after the Enter offset and timestamp.

A missing or late witness records `not-compacted`: the handoff stays on disk, no resume is sent, and `/compact` is never retried. An unverified submit can still be followed by proof; submission alone never authorizes the resume. Both Claude and OpenCode require a bound native session and transcript/store before arming or submission; missing binding does not fall back to chrome. The receipt is `<bus>/handoff/<id>.compact.receipt.json`, with a terminal pointer in `self-helper.log`. Claude receipts label proof `transcript-proven`; OpenCode labels it `store-proven`, with `compactedAt` retained through the terminal receipt. **Exit 0 means ARMED**, not completed. Read the receipt before claiming compaction; `resume-sent` means transport accepted the note, not that the seat read it. The worker requires a registered seat.


**Peer compaction uses the same proof reader.** `tap compact <peer>` stages a durable resume body before submitting, then waits in its cancellable child for fresh completion proof. Both focus and no-focus follow-ups are TAP notes placed only after proof and a native-session check. Missing proof preserves the body and records `not-compacted`, with no wake and no retry. The peer receipt is `<bus>/handoff/<id>.peer-compact.receipt.json`; it distinguishes `compacted`, `resume-sent` and `resume-miss`. `--all` remains sequential, with the proof timeout applying to each peer. Codex peers still require the seat to checkpoint and self-trigger.

**Clear/rebrief now use a detached native Bun observer.** They return **8** when
armed, never 0: the initiating process cannot yet prove reset or recovery. Only
registered Claude Code and Codex seats with a verified bound transcript are
supported by this first native slice; other families refuse before effects.
The detached receipt separates submission, pre-delivery witness, native session
proof and recovery acceptance. Codex proof can be post-input; see step 4 below.
Same TAP instance and obligations survive. Do not use
refresh --fresh for rebrief: it retires the operational instance.

## rebrief — fresh context for a continuing role (experimental)

Use rebrief for persistent leaders, coaches, context genies or nightwatch seats.
Use compact to continue active work on one workstream; reset/replace when changing
workstreams. This is an experimental explicit workflow, not a scheduled policy
or a claim that fresh context always outperforms compaction.

The role skill explains how to be a coach or leader. The **charter** explains this
seat's role on this particular team: mission, decision boundaries, collaborators,
and standing rulings. Reference the role skill rather than copy it. The **handoff**
carries current state, unfinished commitments, consequential decisions with why
they still matter, uncertainty, and next action. Ledger/history is optional
retrieval material, not mandatory startup reading. Preserve originals and useful
links; omissions from the prompt do not delete evidence.

1. Reconcile custody and ongoing work before resetting. Write a nonempty handoff
   under tmp/self-<handle>/ using the existing headings below. Update against
   current/original evidence, not only an older summary. If supplied separately,
   keep the charter nonempty and current; startup-required references need durable
   custody. Current instructions override stale authored notes.
2. Name a different active teammate as the continuing recovery owner. Use the
   leader or the peer already supervising this transition, not the resetting seat.
3. Run the verb (no inline prompt argument):

   tap self rebrief --handoff /ABS/handoff.md --charter /ABS/charter.md --notify <owner>

   --charter is optional when the handoff includes the charter or a durable
   reference. Runtime copies supplied charter then handoff into ONE durable brief
   under the existing bus handoff directory before arming any pane effects.
4. Exit 8 means ARMED, reset UNVERIFIED: report the receipt path and end the turn
   immediately. The observer waits for idle, submits the bare reset once, then
   requires a changed native session id and matching new transcript on the same
   pane/TAP instance before sending the durable brief on Claude. Codex may bind its
   native session lazily: a positive fresh-header/context-reset transition can
   bootstrap the authored recovery as first input. The receipt labels that witness
   `codex-ui-transition`, distinct from `native-id-changed`; it then requires a new
   native id/transcript with authored recovery as its first substantive input.
   An unrelated first input records `delivery-miss` for owner recovery. Neither UI
   evidence nor delivery acceptance proves the brief was read. It does not regenerate a
   summary, retire obligations, delete history, or replay a possible reset.
5. Recovery asks the seat to read charter then current handoff, reconcile identity
   and its TAP queue, and report the absolute brief path and next action to the
   owner. Accepted/queued delivery is not proof of that read. On observer timeout,
   the brief stays on disk and the owner receives an incomplete-recovery note
   when transport permits. Inspect the receipt/log; do not reset again to retry
   delivery. A failed notification remains in the log.

/tap:self clear uses the same native path; optional --handoff, --charter and --notify
carry authored recovery. Without a handoff it asks the seat to recover its standing
bus brief. Neither self spelling accepts free text. A peer rebrief command and
an extra tap alias are not part of this first slice. tap refresh's self path uses
the same native observer and translates exit 8 to 9; its peer path is unchanged.

Record the transition that was used, whether the next action was correct or stale,
any constraint or commitment that was lost, what had to be retrieved, and the
cost to prepare and to recover. No fixed context threshold is implied, and
recovery is not tied to a second compaction.

Exit 6 means the harness cannot do this verb. Tell the user and name a fallback (Codex loop → goal-based persistence or an external scheduler). opencode's goal/loop are plugin-gated — if a goal/loop plugin gets installed, update the harness gate in `runtime/bun/src/self-gate.ts`, this table, and its tests together. Reporting a degraded verb as success is the one failure mode this table exists to prevent.

## Monitor schedules across clear/rebrief

Before resetting a monitor, put its schedule inventory in the handoff: wake
mechanism, job/reminder IDs, cadence, standalone prompt, heartbeat path, recipient
and next due time. A handoff saying "armed" does not prove the job survived.

After recovery, inspect the actual scheduler before re-arming. Keep a matching
live job. Re-create it once only after confirmed cancellation or an authoritative
check covering its owning session proves it absent. An empty listing scoped to
the resumed session is ambiguous while cross-reset survival is unknown; it does
not prove the predecessor's job is gone. Report ambiguous ownership or presence
to the recovery owner instead of creating a duplicate.
Take a fresh sample and observe a scheduled fire before claiming periodic
coverage restored. Follow the [monitor protocol](../tap/protocol/supervision/monitor.md)
for sample age, intentional closure and reporting.

Cron survival across native `/clear`, `tap self clear` and `tap self rebrief` is
**unverified** — do not rely on it, and do not infer either survival or loss from any
single probe or observation. The existing harness support table still governs which
`/tap:self` verbs are available.

## Compact, goal and loop invocation

1. Compose the text per the verb guidance below. For compact, author a nonempty
   source handoff before any pane effect, on every supported harness.
2. Run tap self <verb> [--interval 5m] -- '<text>'.
   For compact use tap self compact --handoff <source> -- '<focus>'. The skill's
   boolean compact --handoff means author the file first; the verb needs its filename.
3. Report stderr and exit code. Compact exit 0 means queued/worker armed; goal
   and loop exit 0 means submitted. Neither proves completion or recipient read.
   End the turn immediately after arming compact. Goal/loop exit 4: retry once
   when idle. Exit 6: unsupported, surface it. Other nonzero: report the refusal
   or uncertainty; do not claim success. Never bypass with raw send-keys.

## compact — additive focus, never exclusive

**On Claude Code**, the focus supplied to `/tap:self compact` **supplements** the default summarizer (which already keeps intent, files touched, errors, pending tasks); it does not replace it. The known degradation risk is narrowing: "focus only on X" deprioritizes every live thread you didn't mention. `tap self` rejects exclusive/destructive phrasing (`only on`, `ignore`, `discard`, …); your job is the positive form:

- **Enumerate every live thread** — the main task, unresolved failures, pending decisions, in-flight subagents/loops.
- **Name concrete anchors** the generic summarizer loses: exact file paths, branch names, error strings, decision outcomes.
- Suggest `/clear` instead when the user is switching to unrelated work — compacting dead context just crowds out the new task.

Example: `preserve the /tap:self skill build in the checkout on branch SelfSkill: the tap self verb gates, the smoke-test port, the pending CONTRACT.md pointer fix, and the unresolved codex-glyph question`

## compact --handoff — author the recovery record first

A handoff is the default for explicit compaction on every supported harness, including Claude Code. It is also useful before an authorized seat reset or replacement; see [context recovery](../context/SKILL.md#handoff-before-reset-or-replacement).

`/tap:self compact --handoff` is a **boolean** on this skill. `tap self compact` already takes `--handoff <file>`; do not add another flag, a peer `tap compact` flag, or a second storage rail. Strip the boolean. Never forward it.

Before any pane effect:

1. Author a **nonempty** source handoff at a **seat-owned scratch path** in this worktree. Example: `tmp/self-<handle>/handoff-<UTC timestamp>.md` (`tmp/` is gitignored). Never `/tmp`, never bare `.tap/`, never any `.tap` subtree or bus path, and never `$TAP_HOME/handoff/` (that copy is the runtime's).
2. Compose the required focus. Claude Code receives supplemental summarization instructions; Codex and opencode receive that text in the recovery prompt. The handoff is the durable record on all three.

Then:

```bash
tap self compact --handoff <source> -- '<focus>'
```

`tap self` copies `<source>` to `$TAP_HOME/handoff/` **before** any pane effect. The resume ping names that durable copy, not the scratch file. `scripts/regress/compact-wake.test.sh` already binds that contract: w1/h1/h2 copy-before-submit, h7/h8/h9 missing/empty refusal, h3 ping names the durable path. This surface adds no tests.

Write **deixis-free durable references** — absolute paths, commit ids, bead ids, payload ids — never "this", "the above", or "what we were doing". Required headings and values (every heading is nonempty **or** explicit `none`):

- **Objective** — the work the resumed seat continues.
- **Where** — repo, worktree path, branch, short HEAD, dirty-file count.
- **Decisions** — each with a durable id, such as an issue, a pull request, or a commit.
- **In flight** — payload ids, seat names, pull request numbers and heads, gate receipts.
- **Evidence pins** — absolute paths and commit ids.
- **Next step** — and the condition that stops the work, or resumes it when parked.

**On Claude Code, the auto-summary and the handoff split the work.** `/compact` writes its own summary next to your handoff; the summary keeps code-level detail (hunks, return codes) and a reviewer's ruling, but loses the seat's live handles, and it re-states policy that reloads anyway. So the handoff carries what the summary cannot:

- The headings above ARE the document; no separate narrative beside them.
- What changed since the last handoff, plus every still-live handle carried forward from earlier handoffs. Durable seat lore belongs in a persistent seat-notes file the handoff links.
- **Live handles, when they exist**, under **In flight**: each scheduler, cron, watcher or background task with its id, output file and done signal; each open ask or reply id you must match; the next report number; the last-verified head. Add the cause of any reviewer rejection this window, not only "restored in `<sha>`", so the resumed seat does not repeat it.
- Point to repo policy (AGENTS.md, the role skill); never restate it.

This is judgment, not a form. The fields matter when work is live: open reviews, running jobs, pending replies. A seat handing off with nothing in flight writes `none` and invents no ids. The failure to prevent is exact in-flight ids missing from both the summary and the handoff, such as an idle-poll cron id a resumed seat never learns it owns.

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

Codex and opencode `compact` cannot carry inline focus or markers (passing inline text converts `/compact` into an ordinary prompt or refusal). Their focus rides the **resume note** (`handoffPing`'s focus argument in `runtime/bun/src/compact-focus.ts`), verbatim. `tap self` precomputes that ping and hands it to the detached worker, which owns every pane effect under the existing pane-submit lock and never resubmits. On opencode nothing is staged: an occupied composer is refused by the courier, never replaced. Claude likewise has one worker-owned path: it queues behind a human draft, copy-mode or a held pane-submit lock, without clearing or appending to the draft. A working turn alone does not block submission. Only a proven no-input refusal may be retried; any possible text or Enter effect ends retyping.

The focus used to live in a one-shot capsule under `~/.tap/self`, consumed by the Codex SessionStart hook. That rail is deleted (tap-thgv), and its deletion **fixed a live bug rather than costing coverage**: the capsule had exactly one consumer — the Codex hook — while the deferred branch wrote one for opencode too, where nothing ever read it. `/tap:self compact <focus>` on opencode reported success naming a focus it had silently dropped. The ping has a consumer on every harness, because it is just the next turn. One thing was genuinely lost: a capsule written for a scheduled compact could also be consumed by an unscheduled auto-compaction that happened first, inside its one-hour TTL — codex-only, and narrow, but real (tap-thgv PR 2).

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
started. Before compaction, name the supervising leader or peer when continuity needs confirmation;
that seat checks the receipt and the resumed seat's response. The compacting seat ends its turn
immediately rather than waiting on its own wake.

Every family requires fresh bound transcript/store proof before sending the
resume. Missing proof records `not-compacted`, preserves the handoff and sends
nothing. A refused resume is `resume-miss`. The worker never repeats a possible
input effect, and note acceptance never proves recipient processing.

Tests: `runtime/bun/test/self-gate.test.ts` (the text and harness gates), `scripts/smoke/self.test.sh` (outside-in `tap self`), `scripts/smoke/self-rc4-origin.test.sh` (the synchronous goal/loop rc-4 deferral origins) and `scripts/regress/compact-wake.test.sh` (mock tmux — never touch a live pane); the resume worker's family modes, queued submission, proof gates and receipts are in `runtime/bun/test/self-compact.test.ts`.

After recovery, read the handoff before resuming work and report its absolute path
and next action to the supervising seat when one was named. If recovery arrived as
a TAP note, `tap read` settles that note; a resumed-seat reply confirms the handoff
was actually read. A helper log or queued-send receipt alone does not establish
receipt. A supervisor observing a failed or uncertain wake sends the preserved
handoff through TAP and checks the response; never compact again merely to retry
the wake. Without a supervisor or resumed-seat response, report recovery as
unverified rather than claiming delivery.
