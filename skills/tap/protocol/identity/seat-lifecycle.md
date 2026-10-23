# Public seat lifecycle

The caller's cwd selects the default team. A qualified `team/handle` (also
`team:handle`) or `--team team` selects that team before any read or effect.
Combining these two selectors refuses, even when they name the same team.
An unresolved explicit target never reports successful retirement. Nameless
`out --team` requires the caller pane's membership on that team.

| Public action | Durable membership | Process | Owned crew |
| --- | --- | --- | --- |
| `out` / `unregister` | Retire row with history | Preserve | Preserve |
| `down` | Suspend row; keep instance and recipe | Stop exact session | Remove rows; stop with owner |
| `up` | Resume retained row through launcher | Resume stored conversation | Never recreate |
| `shutdown` | Retire row with history | Stop exact session | Retire rows with history; stop with owner |
| `out --hard` / `out --kill` | Same hard-removal mechanism as shutdown | Same exact stop | Same retirement |
| `team out` | Retire selected parent families with per-seat history; keep team initialized | Preserve every process | Retire owned crew rows; preserve processes under their parent lifetime |
| `team reset` / `team out --hard` / `--kill` | Same family retirement | Stop exact parent and bound child processes | Stop owned crew panes before the parent session |

`team reset [TEAM]` is an alias of `team out --hard [TEAM]`, with the same
receipts, refusals and family engine. It selects every seat by default, including
the caller, whose family stops last. Hard retirement of pane-backed families refuses before any retirement when the caller cannot be observed. `--except <your-handle>` spares the caller.
Full-team and picker retirement requires confirmation (`--yes` without a
terminal); explicit handle lists need no extra consent. Dry-run needs none.
Reset preserves the registry envelope, enrollment, bus, mail, watch state and
all historical archives. The checkpoint cut is retired; `team restore` and
`team purge` are non-mutating `renamed_verb` tombstones. The removed reset flags
`--kill-self` and `--allow-nonstandard-bus-path` refuse before team resolution.
Shared reset fence/generation plumbing remains pending separate retirement.

`team out [TEAM]` selects parent seats as family units; `--only` names parents
to act on and `--except` names parents to spare. Crew handles cannot be named
independently. The action binds selected parent instances and foreground
harness generations. A late crew bound to the same parent generation follows
that parent's fate; a new parent or changed crew owner does not. Poll
registrations are singleton units. An empty roster is an idempotent success;
an unbound orphan crew remains registered and makes a full-team result
partial. A named missing handle refuses.

For full-team out, a crew whose parent registration is absent may still be
retired when its existing pane-local lifetime binding proves the captured
parent process and exact child. An unbound or ambiguous row stays registered
with a nonzero partial result; registry absence alone never proves parent
death or authorizes dismissal.

Plain team out prepares and validates process-lifetime supervision before
retiring a family. Its registry-only transaction writes history for every
removed row and retains the initialized registry document even when `seats`
becomes empty. Enrollment, bus, mail, watch lease and prior history are left
in place. The helper binding stays with the child pane after both rows retire,
so the captured parent harness exit still ends that child. A replaced process
in the same pane does not inherit the prior binding. Hard team out checks the
canonical session, socket and all panes before stopping an exact child or
parent; an unrelated pane or ambiguous owner refuses. It validates current
family rows, publishes retirement and history, then holds the registry lock
through each exact stop. On partial failure, only members whose original
process and pane identities are positively alive may be restored; stopped or
unobservable members stay retired with history. Families run independently
with a nonzero partial result when one refuses. The caller's family runs last;
its `stop_requested` receipt precedes its own stop, and a surviving caller
gets a final failure receipt after any safe restoration. Dry-run applies the
same read-only identity and hard-stop preflight without arming a crew helper
or publishing retirement.

A crew target uses D's recorded-pane dismissal for out, shutdown and either hard
spelling. It never stops the containing operator session or sibling split panes.
The existing caller/last-pane/foreign-server protections remain; an unverified
crew pane is retained with an explicit reason. Crew up/down refuse.

A supervised crew also ends when its original parent harness generation ends,
even after either or both roster rows retire. A replacement parent cannot adopt
that crew; only a resume reviving the same seat instance into its surviving
session reclaims it, under the guards in [crew revival](../delivery/crew-revival.md). Harness identity includes the observed command family, so an in-place
exec into a different command family ends the captured harness lifetime. A child
relaunch retains the original parent binding; if that parent ends during a
verified replacement, TAP stops that exact replacement child. Unknown process or
tmux observations retain the crew and retry supervision. The finite helper and
repair contract is in [crew lifetime supervision](../delivery/cli-surface-the-whole-thing-part-03.md).

`lifecycleDisposition` supplies the fate that selects each existing effect
owner. The shared fate names a mechanism; receipts retain the requested action.
`shutdown` and `out --hard` share `hard-removal`, while crew out/shutdown share
`crew-dismiss`. `--kill` is a spelling of `out-hard`. Up/team-up use
`registry_fate=resume-rows`, because launcher reservation/publication mutates the
retained rows. An already-live or empty cohort outcome still reports that no
resume was needed. Team down/shutdown retain their cohort stop owner; the matrix
selects suspend versus clear. Team shutdown remains the separate no-tombstone
team operation. Team out has distinct plain and hard family fates: both retire
selected rows with history while preserving team initialization; only hard out
stops exact selected families.

The registry-only retirement leaf owns reset then registry custody, validates
the selected authority and exact incarnation, and releases both before returning.
Callers hold no lock. D calls this leaf directly, never a public out command.
Hard removal owns its reset/registry transaction and shares the inner lossless
row/history codec; it never reacquires the leaf's locks.

Per-seat hard removal validates the selected socket, canonical session, pane identity,
server generation and crew ownership under the registry lock. Other durable
co-tenants refuse. Publication always precedes the guarded tmux effect: history,
registry retirement, generation stamp, then requested-action event. The shared
stop helper guards immutable session/pane identities at the effect. A positively
stopped seat can be retired without a kill; an unreadable tmux server does not
prove it stopped.

After an attempted stop, a positive surviving identity restores the registry and
records `registry_restored`. Failed restoration retains its history and names
the recovery path. A failed observation records `stop_unverified`, retains the
published retirement/history, and requires inspection; it never retries a
possible effect. Only a positive empty answer counts as observed: no server, or a
server kept up with no session (`exit-empty off`: stderr exactly
`no current target`, or on older tmux a successful read with no rows) means the seat's session is gone and the stop reports
`stopped`. The generation stamp remains reused after rollback, since a
restore is also a mutation.

JSON retirement receipts carry `lifecycle_action`, `mechanism`, `registry_fate`
and `outcome`. A self-removal writes one `stop_requested` receipt before its
process can end; a surviving caller receives one final result. Registry events
keep their fixed top-level fields. Ordinary out retains `action=unregistered`;
hard removal and crew shutdown retain their requested actions. Detail uses
`lifecycle_action=<action>;mechanism=<id>` and hard-removal events append
`;outcome=<stop_requested|already_stopped|registry_restored|restore_failed|stop_unverified>`.
A requested stop event is process-effect intent, not confirmation that the
process stopped.

Bus mail and historical evidence are not rewritten by seat retirement.
Historical team-reset bundles remain on disk for manual inspection; the retired
checkpoint commands never inspect, restore or delete them.

`tap out --last` (`-` remains an alias) selects the unique latest `exited_at`
among active pane-backed rows or delivery-marked `suspended/pane_gone` rows
that the shared refresh classifier proves gone.
Live, launching, pending, poll, other suspended and foreign-team/socket rows are excluded.
Missing exit stamps are recorded only after readable observation; ties refuse.
The selected row and positive absence are revalidated under retirement custody.

The shared classifier also reports `gone/pane_absent` when a valid recorded
pane ID is missing from a readable global pane inventory in its still-present
session and its explicit server epoch matches. A session-scoped scan cannot
exclude a pane moved elsewhere and keeps `unknown/designated_pane_missing`.
This widens ordinary `team refresh` to
shared-session exits. Rebound addresses, panes visible in another session, poisoned pane records, launching markers,
missing or stale epochs, and unreadable pane sets remain conservative; an exited harness in a surviving pane is offline.

For recognized no-server replies, `out --last` and `-` use the positive-empty
namespace authority shared with `team refresh --hard`. The query pins its physical
socket; any recorded server socket must match. Other failures and excluded row
statuses remain refusals. The namespace proof is refreshed under retirement
custody, so a server that starts meanwhile must pass the normal snapshot checks.
Plain refresh's no-server polarity stays unchanged.
