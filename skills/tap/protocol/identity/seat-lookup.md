# Seat lookup

`tap whoami --pane <tmux-target> --team <team> --json` selects one enrolled
team, including from outside its repository. Success returns:

| Field | Type | Meaning |
| --- | --- | --- |
| `handle` | string | Registered seat handle |
| `team` | string | Selected team |
| `pane` | string | Registry-recorded address, which may predate pane renumbering |
| `pane_id` | string | Observed stable tmux pane id |
| `crew` | boolean | Whether the registry marks this seat as crew |
| `instance` | string | Registry instance, or empty for a legacy row without one |
| `bus` | string | Selected bus path |
| `bus_rule` | string | Bus resolution rule |

The lookup observes the target's stable pane id, session and server generation
together, then requires one active matching registry row. It never binds a
positional `pane` address when `pane_id` is absent. Crew and instance come from
that same row, without pane capture, agent-state enrichment, compute queries or
transcript reads. `--json` changes representation only. Without `--team`, an
unanchored cwd keeps its executable `cd` remedy.

JSON failures retain `ok:false`, `error_class`, `action` and optional `detail`:

| `error_class` | Meaning |
| --- | --- |
| `unregistered` | No current claimant in the selected scope |
| `pane_gone` | Confirmed missing target or absent server |
| `generation_unverifiable` | Pane identity could not be observed reliably |
| `pane_unknown` | Registry identity could not be read reliably |
| `pane_contested` | Multiple current claimants |

The last three classes are not absence. Empty or denied tmux observations
cannot establish absence. Existing selection and usage errors retain their
typed envelopes. Consumers must parse the JSON even on a nonzero exit.

## Bounded identity probes

Process-table, per-pid ancestry and Git common-directory probes each have a
five-second subprocess bound and terminate timed-out children with SIGKILL.
Partial timed-out output never proves a process absent or a caller outside tmux.
The independent kernel fallback remains available when `ps` cannot be executed
or times out. Without a kernel answer, timeout evidence stays unobservable,
including through the held-terminal climb and its ancestry proof.

## Reporting observations

Implicit `whoami`, `outstanding`, `poll` and `show` reuse caller and team discovery
within one synchronous invocation. One process table supplies the ancestry
walk; one live-pane inventory supplies pane id, tty, session and generation.
The inventory record replaces the separate targeted query for these reports.
Pane precedence and registry matching remain unchanged. Machine-wide claim
uniqueness is checked once, after the repository probes.

The overdue-inbound advisory shares this observation with the command. The
memo ends on return or error; later invocations resolve the bus again.
Explicit `whoami --pane`, registration and delivery retain their live probes.
A reporting observation never licenses a pane effect.


Implicit reporting may reuse a positive caller observation for five seconds; a hit spawns no Git, tmux or ps children. Each call resolves enrollment and bus location and reads fresh registry/message data; in an unenrolled linked worktree, inherited `TMUX_PANE` only locates a cache file containing a prior full resolution for the same cwd, socket, observed pane, team and registry stamp. `whoami`, `outstanding` and `poll` populate entries under the acting bus's `runtime-cache/`; `show` only reads them, and hits never extend the TTL. Expired, damaged or unwritable entries, registry changes and invalid advanced settings use live discovery; explicit `--pane`/`--team`, verbose diagnostics, shared OpenCode callers and Claude background jobs keep their existing paths. In `[advanced]`, `reporting_cache_ttl_seconds` defaults to 5 and must be finite and nonnegative, with zero disabling reads and writes; `TAP_REPORTING_CACHE_TTL` overrides it, invalid overrides use the configured value, and absent or unreadable catalogs use the default. Pane/server changes or a competing claim in another team's registry may leave a report stale for up to five seconds; no negative observation is stored, and registration, delivery and explicit `whoami --pane` retain their existing live identity checks without reading this cache.
