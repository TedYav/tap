# Seat roles: `tap role`

A seat may hold one **role** on its team: a lowercase label such as `leader`, `driver` or
`reviewer`. A role describes a responsibility. It is not a permission: no verb checks it, and a
seat without a role can still ask a teammate for work. Agents treat a resolved TAP message as a
colleague's request whoever sends it; a leader's role is to coordinate, and teammates go with its
call once they have said their piece.

```text
tap role [--team <team>] [--json]                              # seats that hold a role
tap role <seat> [--team <team>] [--json]                       # one seat's role, or none
tap role <seat> <role> [--team <team>] [--dry-run] [--json]    # set
tap role <seat> --unset [--team <team>] [--dry-run] [--json]   # remove
```

## Storage

- **Where it lives.** The role is an optional `role` string on the seat's row in the team registry. The schema is unchanged: an absent field means no role. A value that is not a valid token reads as no role.
- **Lifetime.** Rows survive relaunch, refresh, clear and rebind, so the role does too. `tap out` and retirement delete the row and the role with it.
- **Writes.** A set or unset holds the registry lock for its read-modify-write. It works on an inactive row, because a former leader's pane is often already gone. A pane-less daemon row takes no role.
- **History.** Each change appends one registry event, action `role`, with detail `<old>-><new>` and the actor. There is no separate ledger.

## Leaders

Only `leader` changes presentation:
- **`tap team`:** leaders sort first; crews stay nested under their parent and daemons stay last. Every role shows beside the handle, as `opus (leader)`, and the leader handle is bold on a styled terminal (TTY, `NO_COLOR` unset, `TERM` not `dumb`). `--json` carries `role` (null when none); `--names` order is unchanged.
- **`tap attach --interactive`:** the same suffix. Leaders come first, and filtering keeps that order between equal matches. The picker shows no ANSI styling.

Several seats may hold `leader`; there is no election. `/tap:lead` takes the role when a seat starts leading. If another seat already leads, it asks the user whether to unset that seat or add a second leader.

## Removal notice

Removing another seat's `leader` role (by `--unset`, or by setting a different role) sends that
seat one settle-only `notice` from `watcher`, naming who removed it. The actor is:
- the calling pane's registered seat, compared as team plus handle; or
- the operator, for a terminal outside any seat.

A caller whose identity cannot be observed changes nothing. Self-removal and no-ops send nothing.

The registry write commits before the notice. A notice TAP cannot confirm is reported as
`delivery unconfirmed`, because it may already be placed. It is never rolled back or retried.
