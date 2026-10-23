# Seat observations (`tap calibrate`)

`tap calibrate` records dated, attributed observations for a leader to read before
staffing or briefing. Observations describe episodes and conditions; they are not
rankings or model eligibility rules. The CLI grammar lives in `tap help calibrate`.

## Machine scope and opt-in

The active store is `$HOME/.tap/calibration/observations.jsonl`. It is local to one
machine, independent of the current team. No observation data is synced or exported
to OSS. The config file resolved by `tap config path` controls `[calibration] enabled`;
its default is `false`. Enable it manually with
`tap config set calibration.enabled true`.

When disabled, every read and write returns exit 1, one stderr line naming
`calibration.enabled` and the enable command, no stdout and no store effects.
This applies to `--json` too: it is the explicit exception to the ordinary JSON
refusal envelope. Help reads no config or state.

## Row and append contract

Each UTF-8 JSON line has six required fields: `id`, `at`, `route`, `by`, `ref`,
`note`. Optional `effort` is set only for an effort-specific observation. `at` is
the recording date in UTC, `YYYY-MM-DD`. `by` is the registered writer's
`team/handle`. `ref` defaults to that writer's registered harness session ID;
`--ref` supplies a PR, bead or source path instead. `note` is literal text from
`-f <file>` or `-f -`, trimmed at its ends.

A new ID is the first eight lowercase hex digits of SHA256 over UTF-8
`JSON.stringify([at, route, effort ?? null, by, ref, note])`. It is a content
handle, not a uniqueness guarantee or a vote. Identical writes append identical
rows. GC may retain an earlier ID when consolidating observations.

The key is the exact `harness/model` route. A handle uses its bound transcript's
observed model, falling back to stored launch tuning. The native roster transcript
readers supply that observation; launch records supply additional known routes.
Literal routes require roster or launcher-record evidence on this machine.
Presets contribute candidates to a bare digest, never permission to write an
unobserved route. Qualify a handle as `team/handle` when necessary.

Writes require a registered caller and a nonempty note. They serialize on the
no-follow descriptor lock `observations.jsonl.lock` beside the store, validate the
active JSONL, append one complete row and flush before reporting success. A
malformed or incomplete file refuses without repairing or overwriting evidence.
Reads never create the store. Append failures report the cause; preserve the file
and inspect it before retrying when the write outcome is uncertain.

An avoid/never statement without a cause clause gets a hint to say what happened,
under what conditions and what the writer advises. Notes over 400 characters get
a brevity hint. These hints do not reject an observation.

## Human and JSON views

A route view shows newest first, breaking date ties by newest append. The default
budget is at most ten lines and about 220 tokens per route. Each bullet opens
with age and optional effort and closes with writer and reference. Complete
newest notes use the available budget, wrapping at terminal width (88 columns
when unobserved); older notes are omitted first. A note that exceeds the whole
budget gets an expansion pointer instead of a clipped observation. The header
says `observations, not rankings`. Omitted notes point to
`tap calibrate <route> --all`. Default references may use their first segment;
the stored reference is unchanged. Human views suppress session UUIDs and OpenCode
session IDs and strip terminal controls; `--json` preserves the stored fields.

Bare `tap calibrate` digests up to two newest notes for each roster/preset route,
at most 25 lines total. It reports omitted routes and prints one line for a route
with no notes. `--all` expands a targeted route; a bare digest keeps its budget.
`--json` reads return the full selected row array, without the human budget;
writes return the appended row. No age or vote hides a row from the full view.

One advisory footer suggests `tap help skill calibrate-gc (frontier seat)` when any active
row is more than 90 days old or the active file exceeds 16 KiB. The footer never
deletes, hides or rewrites anything. The separate GC skill must back up the exact
input, acquire the same write lock and compare active bytes with its backed-up
input before atomic replacement; changed bytes require rebuilding from new input.
The [GC skill](../../../calibrate-gc/SKILL.md) owns that model judgment and its
backup/replace helper. Flat hosts call it `/tap-calibrate-gc`; both names resolve
through `tap help skill tap-calibrate-gc`.

## Consumption boundary

Only an explicit `tap calibrate` invocation reads this store. Launch resolution,
`tap presets`, `tap team`, SessionStart and pane injection never read it. No skill
default uses observations to choose a model. The staffing references ask leaders
to read the explicit view; judgment remains with the leader and operator.
