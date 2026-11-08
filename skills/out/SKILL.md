---
name: out
description: "When leaving TAP or removing the last exited teammate, unregister and free the handle."
argument-hint: '[handle|--last|-] [--forward-to successor]'
allowed-tools: 'Bash'
role: maker
---

# /tap:out — leave the bus

Free your handle and remove your registry entry:

```bash
tap out
```

Bare form targets your own derived handle; pass a name to remove a specific one. **Idempotent** — removing an absent handle is a no-op. On a terminal, a name that matches no seat but resembles one opens a chooser seeded with that name; Esc removes nothing.

**Most recently exited teammate:** `tap out --last` (`tap out -` is an alias)
uses the same absence classifier as `tap team refresh`. It considers active pane-backed rows and rows marked suspended/pane_gone by delivery whose session is positively absent, or whose recorded pane ID
is absent from a readable pane set in the same current server epoch. It excludes
live, launching, pending, poll, other suspended and foreign-team/socket rows. Missing `exited_at`
stamps are recorded on first observed absence; the unique latest stamp wins.
A tie opens an fzf chooser on a terminal; without a terminal (agents) or with
`--json` it refuses with the candidates. Unreadable snapshots refuse without
stamping. The selected row and its absence are checked again under retirement
custody. If the harness is still shutting down after `/exit`, wait and retry.
For the final session's exit, `--last` accepts the recognized-empty namespace
proof used by `team refresh --hard`; any recorded server socket must match the
queried physical socket. Plain refresh's no-server polarity is unchanged.
Other failures refuse. The empty proof is rechecked before retirement, so a
server started meanwhile cannot make a revived seat eligible.
Do not combine `--last` with a name, `--pane`, `--kill` or `--forward-to`.

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
