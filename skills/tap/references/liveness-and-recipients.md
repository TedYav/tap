# Liveness and recipients

Details for [/tap](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Liveness floors

**Floor — liveness.** Every work obligation has a visible, tracked completion path.

After any harness rewind/resume anomaly, immediately run `tap poll <self>`; sentinels are doorbells,
the bus is the truth. Compact `poll+settle` means polling, reading and processing each payload
according to its payload `reply:` obligation, then settling only after handling that obligation; settlement
never substitutes for assigned work.

A work order bundled onto a settle-only acknowledgement can be settled without the work starting, and a
promised ping is not a tracked obligation. Settlement tracks message obligations, not work
obligations; to a metadata-only observer that looks finished. The following floors make the missing
work observable.

A working seat replies once with status, then works. Milestone notes and one line per pushed head
are sufficient; repeated acknowledgements are not a liveness requirement. Silence, unchanged HEADs
or a process census alone cannot establish a stall. Inspect the assigned work and actual dependency
before treating a watcher’s quiet-activity signal as a problem.

1. **One obligation per payload.** A payload represents one tracked request. Combining a work order
   with a review request or acknowledgement lets its recipient discharge one obligation while the
   other silently evaporates.
2. **Work orders use `tap assign` (`reply: expected`, `kind: order`).** The resulting reply carries completion
   evidence or an explicit progress report, rather than a bare acknowledgement. A forgotten task
   with no tracked reply obligation is invisible to the bus. **A new work order never travels on a
   plain note or `--wake`** — both stay `reply: settle-only`, so neither creates the obligation,
   which is the lost-work shape this floor exists to prevent. A plain note is settled when the
   recipient reads it. `--wake` is a compatibility spelling of that same note: it changes neither
   settlement nor delivery timing and sets no fixed delivery window. Delivery follows the
   recipient's composer: a bare composer receives at once, while a draft or queued followup
   follows its documented hold. Three intents, three spellings: an answer is wanted, `--ask`;
   aborting the recipient's current turn or tool call is explicitly authorized,
   `--delivery interrupt`, which promises no arrival timing; none of those, a plain send. Delivery,
   read and reply settlement are separate events; a delivered note is not yet read.
3. **Ordinary `reply: settle-only` messages carry no directive.** That is a sender contract rather
   than a transport prohibition: an ordinary `tap reply` may still report a problem. The
   contract-defined supervision kinds `probe` and `notice` are the exception: their bodies are
   mechanical and self-contained (`skills/tap/protocol/messages/supervision-kinds-probe-notice.md`).
4. **A promised future ping is unobservable state.** Sending now, or making the other party owe a
   `reply: expected`, preserves the obligation on the bus. The missing scheduled ping was the final
   failure in the incident above.
5. **The golden rule forbids busy-waiting, not follow-through.** After a send, reply, or settlement,
   independent useful work continues. Yield occurs only when the next useful step needs a response
   or nothing remains. Settlement does not cancel work assigned in a payload body.
6. **A multi-seat run has something that will notice a silent board.** The floor is the coverage, not
   a particular mechanism or seat: a delegated sentinel (`tap watch`, a crew seat, a cheap team seat)
   or, when the run's shape warrants it, the LEADER's own supervise step. The default delegates the
   investigative checking and keeps one infrequent LEADER wake as the
   backstop for delivery itself failing. A `probe` can wake a seat, and settlement of that probe is
   part of the floor. Choice and cost model are in `skills/lead/plays/cover-liveness.md`; the recipes are
   in `skills/lead/references/supervision.md`.
7. **A live run also has a direction check, not only a liveness one.** The drift-peek asks whether the
   team is building the right thing — judgment no watcher supplies. It can run on a briefed sentinel
   seat or on the LEADER; its mechanics are in `supervision.md`.

### Background processes across a tool call

Whether a process backgrounded with a shell `&` outlives the tool call that started it depends on
the harness. Measured 2026-08-24 with the same sleeper probe on each harness (tap-9jldo):

| Harness  | Plain `&` child after the call ends | What the seat does |
|----------|-------------------------------------|--------------------|
| Claude   | **Survives**, reparented to launchd | Give it a named owner: a `trap` that ends it with its experiment, or a kill by recorded pid that the seat itself runs. |
| Codex    | Gone (tested, does not reproduce)   | Nothing extra, but do not rely on the child persisting. |
| OpenCode | Gone, and the call does not return while the child lives | Do not background inside a tool call at all; the call hangs until it times out. |

An unowned Claude child is a leak: on 2026-08-24, 24 orphaned synthetic-load loops at about 29% CPU
each pushed the load average to 47. A process that must persist on any harness goes in a named tmux
window (the visibility rule), never behind an `&` in a tool call. The harness's own background-task
facility (for example Claude's `run_in_background`) is owned by the harness and is not this case.

Untested edges: whether a `setsid` or `nohup` child escapes the reaping on Codex or OpenCode, and any
harness not in the table.

## Recipient discipline

**Floor — triage before switching.** Default-policy delivery injects into the turn already in
progress. TAP does not wait for “done” (which transport cannot know) and does not interrupt by
default. A sentinel that arrives mid-mission is read and settled or acknowledged in one line, while
its work remains queued unless it outranks the active mission. `discuss` and FYI traffic normally
defers; escalation content is triaged by importance, while preemption requires explicit `--delivery interrupt` (alias `--urgent`). Switching context for each arrival is the
failure mode this policy avoids: a routine LEADER status check does not derail a DRIVER or EXECUTOR
lane. Triage may defer work, but ordinary `tap reply` discharges its inbound obligation; when work
remains queued, `tap reply <id> --progress -f - <<'EOF'` sends hard settle-only status without discharging
it, and a later ordinary reply completes the thread.

A v0.23 sentinel is `[[TAP v0.23 ask <id>]]` or
`[[TAP v0.23 note <team>/<id>]]` (`skills/tap/protocol/delivery/sentinel-the-wire-poke-zero-authority-part-01.md`).
The id-less `[[TAP v0.23 nudge]]` doorbell from `tap nudge` is neither: nothing to
read or settle and no new task; continue your work and check `tap poll`.
Read the body before acting with `tap read <id>`, including digest ids and
`<team>/<id>`. The prefix names the sender's bus; keep it for both `read` and
`reply`. A bare id resolves on the local bus first, so stripping the prefix can
answer and settle a different copy. Use `tap read path=<file>` for an explicit pointer. Never
derive the bus from cwd: TAP_HOME and legacy buses can use a different root.

`ask` means answer with `tap reply <id> -f <answer-file>`; `note` is settled by a successful `tap read <id>`, with nothing further to settle and no got-it. For a foreign payload, use
`tap reply <payload-path> -f <answer-file>` or `tap read path=<payload-path>` for a note. Payload frontmatter remains
`reply: expected` or `reply: settle-only`; those values are not sentinel slots.

A `digest` lists its items: use `tap read <id> --all` to read every body, then follow each item's reply obligation.
Skip settlement for `settled: true` items; never settle the digest itself.
`path=` remains for manual relays, and unindexed sender teams. Ask the
sender about a shape you cannot interpret. On version drift, reload `/tap`.
