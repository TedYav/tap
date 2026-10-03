---
name: out
description: "When leaving TAP or removing the last exited teammate, unregister and free the handle."
argument-hint: '[handle|-] [--forward-to successor]'
allowed-tools: 'Bash'
role: maker
---

# /tap:out — leave the bus

Free your handle and remove your registry entry:

```bash
tap out
```

Bare form targets your own derived handle; pass a name to remove a specific one. **Idempotent** — removing an absent handle is a no-op.

**Most recently exited teammate:** `tap out -` (same as `tap unregister -`) picks a corpse on your team — pane-backed seats that are (`active` + probe-dead) or (`suspended` + `status_reason=pane_gone`). Exactly one → unregister; zero → refuse; multiple → prefer latest `exited_at` when stamps distinguish. Never live, pending, poll, `user_removed`, or cross-team.

Distinct from `tap register --offline`, which _suspends_ the entry (keeps it for provenance) rather than removing it. Rejoin any time with **/tap:in** (manual reconnect — TAP-launched seats are already registered).

To retire with a successor, use:

```bash
tap out [source] --forward-to successor
```

This atomically retires the source and delegates mail to the successor's current
instance on this team. The successor runs `tap poll successor` and
`tap outstanding successor`, reads and replies as itself, and receives
`adopted_from` attribution. Existing payloads, receipts and open obligations stay
intact; transfer never replays a message. Read parked asks before replying.

New registration of the source permanently supersedes its address alias. Replies
to the predecessor's instance-stamped asks still follow its handoff. Reusing the
destination name grants no custody. Explicit subsequent handoffs can carry a
chain; cycles, ambiguous histories and untransferred reclaim grants refuse before
retirement. Historical unstamped mail needs inspection with `tap show`.

Hand off lane ownership through an explicit TAP custody agreement and watcher ownership through
`tap watch off` / `tap watch on --by successor` separately. Resolve any other
leader or conductor duties before leaving. A failed handoff notification does not
undo the committed retirement: inspect the successor's live views instead of
repeating the command.

Reference: `tap help unregister` or `skills/tap/SKILL.md`.
