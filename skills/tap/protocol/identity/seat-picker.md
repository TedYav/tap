# Seat selection for `tap out`

How `tap out --last` picks the most recently exited seat, and when a human on
a terminal chooses instead of receiving a refusal. Retirement itself is in
[seat lifecycle](seat-lifecycle.md).

## Most recently exited (`--last`)

`tap out --last` (`-` remains an alias) selects the unique latest `exited_at`
among active pane-backed rows or delivery-marked `suspended/pane_gone` rows
that the shared refresh classifier proves gone.
Live, launching, pending, poll, other suspended and foreign-team/socket rows are excluded.
Missing exit stamps are recorded only after readable observation. A tie
refuses with its candidates unless the caller owns a foreground terminal, is not
`--json`, and has the managed fzf; then a chooser offers only the rows sharing
the latest stamp, so the receipt's "most recently exited" stays true. The
chooser runs after the stamps publish and with registry and reset custody
released; each row's published bytes are pinned, so a row that changed during
the choice refuses. Cancel removes nothing.
The selected row and positive absence are revalidated under retirement custody.

## Missed name

A named `tap out <name>` with no key in the seats map keeps its idempotent no-op (or,
with `--team` or `tap shutdown`, its `not_found` refusal). When the caller owns a
foreground terminal, outside `--json` and with the managed fzf, when some row's handle fuzzy-matches the name, the chooser opens seeded with
that name instead. An existing key never opens it, whatever its value (a
scalar entry is retired by name). The chosen row's identity is
pinned at display time, and lifecycle disposition and crew handling run on it.

## No-server replies

For recognized no-server replies, `out --last` and `-` use the positive-empty
namespace authority shared with `team refresh --hard`. The query pins its physical
socket; any recorded server socket must match. Other failures and excluded row
statuses remain refusals. The namespace proof is refreshed under retirement
custody, so a server that starts meanwhile must pass the normal snapshot checks.
Plain refresh's no-server polarity stays unchanged.
