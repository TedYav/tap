# Staffing

Details for [/tap](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Scope

This is TAP's reference surface for behavior shared by every seat. LEADER-side choreography
(instrumenting the plan, standing briefs, gate disposition, and the final whole-diff gate) lives in
`skills/lead/references/routines/general-choreography.md` and the `/tap:lead` charter. DRIVER custody
(writer tokens, leased commits, and stacking) lives in `/tap:drive`; command grammar lives in the `tap`
skill. This document describes what the all-seat layer does and why its consequences matter.

## Staffing floor

Roles describe work, independently of the staffed form or model. A **monitor**
performs recurring checks under the [monitor protocol](../protocol/supervision/monitor.md).
Use `tap models` for personal calibration or qualified model reference guidance.
Record harness/model@effort and relevant qualifiers; reference access is unverified.
Presets save combinations you use often and are optional.

**Floor — know your form.** Every agent on a run takes one of four staffed forms, and the form fixes
what it owes. A **subagent** runs inside another seat's harness with no Seat handle and no bus address: it
returns one artifact to its spawner, and its writes stay read-only or confined to its own isolated
worktree (`isolation: worktree`). A **burst engine**'s workers are the parallel case of that same
shape — a harness-native runner one seat drives for ephemeral, schema'd fan-out inside its own lane,
holding no handle, no pane, and no writer token (`CONCEPTS.md`, *Burst Engine*). A **Crew Seat** is a
pane in the caller's tmux session carrying a full bus identity — it sends, receives, and settles like
any seat, and its working life ends with that pane; it is staffed for judgment, review, and consult
work, never as a parallel writer. A **launcher-managed Seat** holds a stable handle across restarts,
so its continuity truth is a durable on-disk handoff rather than conversation memory. A **poll seat**
is the one form nobody staffs: pane-less and transport-only, it is the stable sender identity a
daemon, cron job, or script registers for itself (`tap in <handle> --delivery poll --team <team>`) —
infrastructure enrollment, not a mission staffing choice. `CONCEPTS.md` defines each; choosing among
the four staffed forms is the LEADER's call (`skills/lead/references/choreography-best-practices.md`,
*the work lands in the right hands*).

**Floor — identity-gate a new Crew Seat before its first work dispatch.** Send one
`reply: expected` request asking the new seat to run `tap whoami` and return the exact handle; dispatch
work only after that handle matches the seat you addressed. A healthy registry row and successful
courier receipts show routing, not what identity the seat learned at SessionStart. Keep this gate as
defense-in-depth, not as an independent resolver check: the SessionStart banner and `tap whoami` now
share `tap_calling_pane_observe`, so the round trip cannot detect a defect in that resolver. It still catches
a mis-addressed dispatch, a silent seat, registry drift, or any stricter generation refusal surfaced by
the `tap whoami` command path because the addressed handle is an independent input.

**Floor — context boundary on reassignment.** Handing a seat a new
workstream unrelated to its previous one starts with a context reset: clear the seat first, with
the dispatch — never after it wanders. Carried context from the old workstream is not
free continuity; it is stale assumptions and crossed references delivered at token cost, and a
polluted lane pays for it in review rounds. Order of operations, each step for a reason: settle the
seat's lane state first (both queues drained — outstanding sends answered AND unsettled inbound
payloads settled or explicitly handed off, any Writer Token or lease returned, worktree custody
handed off — a reset must never orphan what the seat holds); then clear; then send the
assignment as a bus payload to the FRESH instance **with `tap assign`**. Sending the assignment before
the reset wakes the old context and starts the new work under exactly the stale assumptions this
floor exists to shed — the post-clear send is both the durable record and the wake, and on hermes
it is the only rebrief (the hermes launch argv discards the initial prompt). `tap assign` is what makes those
two things true of it now: an assignment is a work order, so item 2 above already owes it a tracked
reply, whereas a plain note carries no obligation — a freshly cleared seat could read it, have
nothing owed, and leave no trace on the bus that the work was ever expected. The clear's `-m` carries orientation only
("fresh start; assignment arrives by bus"), never the assignment: it is a submitted prompt, not a
durable record (exit 6 is precisely "cleared and rebound but the instruction did not land", and on
opencode it rides a settle-only send after rebind rather than argv). Within this floor's trigger the reset verb
is CLEAR, not compact: compaction deliberately summarizes and carries the prior intent forward,
which re-imports the contamination (and `/tap:self` already directs clear over compact for unrelated
switches). A transition where the old context still helps the new work is by that fact not fully
unrelated — compact belongs there, outside this floor, and even then keep the reassignment out of
`tap compact -m`; focus narrowing refuses exclusive phrasing by design.
`/tap:context` carries the recovery gates (re-register, verify, recover the standing brief — later
failure is partial, not success) as well as the judgment ladder for transitions outside this trigger. The floor triggers on genuinely
unrelated reassignment only — the next round of the same lane is continuity, not a boundary.

**Floor — every agent is visible to the operator.** Agents a seat
dispatches run inside its own harness (subagents and their burst workers), in a window of the
operator's current tmux session (crews), or as launcher-managed Seats — whose session is named
`<team>/<handle>` and which appear on the bus roster and in `tmux ls` — never in an anonymous tmux
session: one on no bus roster and not a window in the operator's own session. All three stay one
switch away, though not the same switch: a subagent's work surfaces in its spawner's own pane, a crew
is one window switch, and a launcher-managed Seat is one `switch-client` away. Pane-less
infrastructure — cron watchers, `hermes-watch`, poll-delivery daemons — is exempt, because it is not
a seat anyone needs to watch. An unwatchable agent that stalls or loops shows nothing to anyone,
which turns each incident into a reconstruction exercise instead of a look at the screen. Outliving
the operator's session is fine for a named, rostered seat; a seat nobody can name, address, or find
is never a default.

**Parallel writers may share one tree.** Choose custody for attributable work and useful concurrency. A check reading a mutable checkout needs that checkout stable; CI reads an immutable commit in its own checkout and does not freeze local authoring. Regenerated files and semantic interactions cross file boundaries, so disjoint path claims alone do not protect peers.

**Growing the team — discover before you pick a door.** The forms above say what a seat *owes*; this
says how to get one. Start with `tap models` and the reachable seats in `tap team calibration`.
Choose exact model@effort with its service/context/environment qualifications, then use
`tap launch <harness> [name] --model <id> --effort <level>` where effort is supported.
`tap presets` lists optional saved combinations; it does not prove account access.
Choose the form by **how long the work needs the seat**:

- **One bounded question that closes the matter** → `tap ask <preset|harness> -f <prompt.md>`
  (or `-m "..."` for a short body). Stateless: no pane, no registration, no lifecycle.
- **Follow-up conversation, consult, or review** → `tap crew add <preset|harness> [name]`. A Crew
  Seat with a full bus identity in a window of your own tmux session, and **its working life ends
  with that pane** — never staff one as a parallel writer. A preset supplies *tuning only*: crew
  still owns the handle, the window, and the cwd.
- **A lane, a restartable address, or anything that must survive a restart** → `tap session launch
  <preset|harness> [name]`. A bare harness with model/effort needs no saved preset; its continuity truth is a durable on-disk
  handoff, never conversation memory.

All three doors take the SAME positional — `<preset|harness> [name]`. The name you pass is the
handle, as given; a bare positional defaults it to the preset (or harness) name. What a seat was
launched WITH is recorded, not encoded in its name — `tap team` shows it. (`tap ask` takes no name:
a one-shot has no seat to address.) A preset is **complete** — it names every tuning value — so
`--model` and `--effort` refuse over `--preset` on every door that takes them, `tap crew add` also
refuses `--env` over a preset, and `tap ask` refuses `--model`. `--env`/`--unset-env`
and the `--` harness tail compose over a preset on `tap launch` and on `tap session relaunch` of a
durable seat, and persist across resume, restart and relaunch — so one changed value no longer
mints another preset row. A crew seat still refuses those overrides on relaunch.

**Launch is for a seat that does not exist; resume is for one that does.** `tap session launch`
against a handle already on the roster offers resume, a suffixed name, or `--fresh` replacement
rather than silently creating a second seat — so reach for `tap session resume <handle>` when the
seat is merely down, and treat a launch collision prompt as the system telling you the seat already
exists. A preset name is machine-global (it names a catalog entry), while a handle is team-scoped:
launching preset `opus` as `reviewer` gives you a seat addressed `<team>/reviewer` — the name you
passed, unchanged. Which preset it runs is on the record and shown by `tap team`, so you never have
to read it back out of the handle.

**Never treat declared file-disjointness as the safety criterion**, whichever way you decide:
regenerated files cross-cut any glob claim, and a semantic collision between disjoint files is
reported CLEAN by git. Reach for the writer token below when scopes overlap or a stretch of work needs
to stay legible.
