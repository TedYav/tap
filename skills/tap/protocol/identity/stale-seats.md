# Stale-seat refresh

`tap team refresh --stale[=<duration>]` (default 7d) lists the seats a team no longer
uses and, once the operator confirms, retires them through `tap out`. Every
retirement leaves a tombstone in `team-history/`, so `tap restore <handle>@<n>`
([team history](./seat-lifecycle.md#team-history-and-history-restore)) can bring the
seat back.

## The list

The list comes from one observation pass: the roster `tap team` prints, plus one tmux
session listing for the run.

- **Offline** (the default scope). A seat is offline only when its session is
  positively absent from the run's session listing. It is listed when it has been
  unused past the cutoff.
- **Idle, still running** (only with `--include-idle`). Only seats the roster
  classifies `idle`, by the same rule `tap team` uses, idle past the cutoff by their
  dated turn end.

An offline seat is aged from its last real activity, never from when it was stopped.
That is the later of its transcript's newest dated record and `last_launched`,
falling back to `exited_at`, then `registered_at`. The transcript is read from a
bounded tail, and a dated record of any type counts, system and progress records
included. The file's mtime is never used, so a copied transcript does not look
fresh. `last_seen` is not activity evidence.

These seats are counted, not listed:

- Undated and unobservable seats.
- Foreign-namespace seats. A row whose recorded `server_socket` differs from the
  caller's resolved socket path is foreign even when no server runs on the caller's
  socket, so it is never listed Offline and retired with its process still running.
  Both paths are compared through the realpath of their nearest existing ancestor,
  so `/tmp/...` and `/private/tmp/...` match even after the socket directory is gone.
  A path with a `..` segment is not comparable, so its row counts as foreign.
  A row with no recorded socket is judged on its observation alone.
- A stored-offline row whose session still runs, such as a seat restored while its
  process kept going. The observer reported only its stored status, so nothing proves
  the seat idle. The count carries a note to check such seats with `tap team`.

The caller's own seat, crew rows (shown as their parent's crew count) and poll or
daemon seats are left out. The leader is tagged, not hidden.

## Retirement

After the operator confirms, or with `--yes` when there is no terminal, each listed
seat retires through `tap out` (offline) or `tap out --kill` (idle, still running).
The list and the action are not reconciled: nothing re-observes the seats or checks
their rows between the two. The confirmation prompt is the safeguard, so a seat that
changes between the list and your answer is retired anyway.

A seat on another team gets a restore hint that names its team:
`tap restore <handle>@<n> --team <name>`. That restore's next steps keep `--team`,
and because `tap session resume` resolves its team from the cwd, the resume it prints
runs from the restored team's root. Plain refresh's no-server polarity stays
unchanged.
