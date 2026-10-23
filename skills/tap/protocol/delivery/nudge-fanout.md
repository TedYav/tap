# `tap nudge --harness`: the fan-out

Normative page for the fan-out form of `tap nudge` (tap-s1k5j, tap-xe42x). The per-seat ladder,
doorbell wire and single-seat exits are on [the nudge page](./nudge.md); `tap help nudge` carries
usage and examples.

```text
tap nudge --harness <family> [--team <team>|'*'] [--active-within <duration>] [--message <text>]
  [--no-interrupt] [--dry-run] [--yes]
```

## Selection

Wakes every live seat of one harness family, for example after a usage limit resets. `--team`
defaults to the caller's team; `'*'` is every enrolled team. Seats are the ones `tap team` reports
active; poll, offline, suspended and gone seats and the caller's own seat are skipped and listed,
and a team whose registry cannot be read is reported and fails the run. Each target runs the
[nudge ladder](./nudge.md#the-ladder) with the same `--message` and `--no-interrupt`; `--to` and
`--pane` refuse.

## Recently active seats only

`--active-within <duration>` narrows the targets to seats whose harness shows activity inside
the window. The duration names its unit (`90s`, `30m`, `2h`, `1d`), like `tap bus archive
--older-than`; a bare number refuses with a hint, because `30` meant as minutes would silently
nudge nobody. Activity is the harness's own record: the transcript's last write for claude and
codex, the newest message for OpenCode (`harnessEvidence`, the clock readiness-stall uses).

The flag exists to leave long-idle seats alone: their prompt cache has likely expired, so a wake
re-reads the whole context at full price. Absent or future-dated evidence is never activity, so
a seat with no readable record (every cursor, hermes and agy seat) is skipped as `activity
unknown`, never woken on the benefit of the doubt. A seat skipped for age prints it, and so does
each target. Activity is judged once, at selection: the point-of-send recheck below guards identity
only and never re-reads it, so it cannot silently shrink a confirmed target set. Only the fan-out
form takes the flag; `tap nudge <peer>` names its seat and refuses it.

## Confirmation, recheck and exits

Each seat's `instance` is pinned at selection and its harness, delivery mode and active status
are rechecked just before its nudge (`target_changed`). More than one target, or `'*'`, needs a
y/N confirmation at a terminal or `--yes` without one (`confirmation_required`). `--dry-run`
previews the targets, skips, unreadable teams and the wire, and presses nothing. A held seat is
listed and never stops the others. Exit 5 when any seat ended with a possible effect (inspect it
with `tap peek`; do not re-run), else 1 when any was held or failed, else 0.
