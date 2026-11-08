# Model reference and launch tuning

**Absent-ledger model reference (.194).** Only genuine absence of the personal ledger enables the
checked-in config.v3 catalog projection for `tap team calibration`, including `--strongest`, labeled **reference; access unverified**.
`tap models` is retired; model guidance returns after the models/presets split (tap-qxq5l).
Malformed or unreadable existing ledgers refuse. The reference is keyed
by exact harness/model and distinct qualified variants (effort, service/context, environment);
conflicting prior fields are omitted, never first-preset-wins or a union of incompatible roles. It
writes no config or ledger and performs no provider query. Presets are optional recipes, not access
evidence. No-ledger `--strongest` selects only active roster seats with a known exact
reference-variant tier, including the shipped s-tier/frontier/advanced/medium/dumb vocabulary. No
known candidate means nonzero with no stdout handles; reference entries never become reachable
seats. Personal-ledger selection ranks the operator’s routing entries by handle/prefix and harness, retaining its legacy Agent-tool targets, unknown-tier/tie behavior and voice default. Free-form ledger labels that differ from stored model identifiers are unverified matches in the display; they do not replace recorded identity or become current model-specific priors.

**Recorded launch tuning.** The launcher snapshots named model/effort and non-secret
service/context/environment qualifiers from the final composed invocation, after explicit tail
precedence. Registry `launch_tuning` and roster JSON carry that snapshot; `model` and `effort` are
nullable. No current-config lookup reconstructs it, and no full argv/environment is projected. It
describes TAP's launch choices, not later in-harness settings or unknown harness defaults. Setup
effort changes use an exact qualified reference prior, otherwise a labeled unadjusted starter prior
without ranking evidence.

**Observed tuning.** The same bound-transcript tail read that supplies the context census also
yields the seat's current model/effort for Claude and Codex: the newest qualifying assistant record
(Claude: `message.model`, top-level `effort`, `<synthetic>` excluded) or `turn_context` payload
(Codex: `model`, `effort`) in the session-verified transcript, with that record's timestamp as
`observed_at`. There is no wall-clock staleness rule: the newest observed record is the seat's
current setting even after idle hours, and a setting survives a compact boundary. The roster
`model` column renders the observed pair when a sample exists and falls back to the recorded
launch snapshot with an explicit `(launch)` marker, else `?`; harnesses without transcript
observation (OpenCode and every other non-claude/codex family) carry that launch marker
permanently, which is scope, not a defect. JSON adds top-level `observed_model`, `observed_effort`
and `observed_at` beside the unchanged launch-provenance `model`/`effort`/`launch_tuning`; the
`context_tokens` object keeps its schema. Calibration continues to match on launch tuning, since
observed ids are full model names, not reference variants.

**Family label (tap-gp75).** `tap presets` (FAMILY column, `family` in `--json`) and `tap team` (family column, `family` on every `--json` agent row) show vendor lineage, so a panel composer groups seats by family without recalling mappings. The value is the preset's `metadata.model_family` (vocabulary and the claude/codex/agy harness fallback: part 06 §Preset `metadata`); opencode, cursor and hermes without the key show `-` / `null`. A seat's family comes from its recorded launch preset, kept for tuned and model-only seats; a preset matched from the handle text is not claimed, so that seat shows its harness's vendor. When the launch-reference metadata is substituted on a seat, its published `metadata.model_family` equals the resolved `family` (omitted when unknown); the reference's own lineage is never shown beside a different one. `tap team --json` labels the source as `family_source` (`preset` for the explicit key, `harness` for the fallback, null when unknown), and `tap team calibration` reads only `preset` lineage, never a harness inference. It is never derived from a model id and is not the preset `family` notes key.

**Prompt-cache estimate.** Claude's session-bound context tail also supplies
`prompt_cache`, separate from `context_tokens`. Newest cache read/write activity
plus the newest same-model write's 5m/1h TTL gives an estimated deadline. Mixed
writes use 5m; compaction fences the evidence. Missing TTL stays unknown. The
assistant timestamp can lag request start and overstate time left. Human
countdowns use `●<minutes>m`, or a bare `●` after estimated expiry, without a
`~` or TTL suffix; JSON retains the estimate basis. Neither warm nor expired is
an observation of server availability. Codex and unsupported
harnesses stay null. The full field schema and limits are in
[roster-cache.md](../../../../docs/roster-cache.md).

The context cell appends a Claude cache estimate when expiry is known: `329k/600k ●58m`. Warm markers carry whole minutes until expiry, rounded up with a minimum of 1m; an elapsed estimate is a bare `●`, and unknown expiry has no marker. The dot and minutes are bright blue (SGR 94) at 15m or more, yellow (33) under 15m and red (31) under 5m; the bare elapsed dot is dark red (38;5;88). Colors require TTY stdout, `NO_COLOR` absent (including an empty value) and `TERM` other than `dumb`. Monochrome keeps the same markers. The estimate is transcript-based, not observed server availability; JSON retains its source, basis and TTL.

**Seat filters.** Every seat list shares one parser and predicate
(`runtime/bun/src/seat-filter.ts`). `--harness <list>` takes families the way
`tap nudge --harness` does, plus `daemon`. `--model <list>` is a substring per item,
tested against the raw observed model, the launch model and the short name.
`--state <list>` takes any displayed state or the meta state `active`, and refuses
any other value, naming the valid ones. `active` is every live seat except one idle for
10 minutes or more by a dated turn end (the same 600 s as the `--stale-after`
default); an idle seat with no dated age stays active, because it cannot be shown
stale. Offline, incapable and unbound seats are not active; a daemon's `ready` is.
Values are comma lists in any case. Items within a flag OR; different flags AND,
with each other and with `--online`, `--offline` and `--all`. `--stalled` judges only
the seats the filters keep. JSON, `--names` and human output select identical seats.
`tap team --online` keeps lifecycle-active seats; `--active` is its migration alias,
adding one stderr line.

| List | `--harness` | `--model` | `--state` |
|---|---|---|---|
| `tap team`, `tap team roster`, `tap team calibration`, `tap crew list` | yes | observed, launch | yes |
| `tap teams --seats`, `tap teams roster`, `tap team list --seats` | yes | observed, launch | yes; replaces the default active-only scope |
| `tap admin ps` | yes | observed, launch | its own activity column; refuses states it never lists (offline, incapable, unbound, ready, waiting, unsubmitted) |
| `tap session list` | yes, supported harnesses only | launch only | refused: records store no observed state |

**Short model names.** Human model columns read names through
`runtime/bun/src/model-names.ts`: `claude-opus-5-5` shows `opus5.5`, `gpt-6-astra`
shows `astra6`, `gemini-4-argon-high` shows `argon4`. A launch alias drops `[1m]`
and gains no version; an unmapped model shows its full id. JSON keeps raw ids.

**Machine-wide seat view.** `tap teams --seats [--all] [--json] [--wide]` (also
`tap teams roster` and `tap team list --seats`; any seat filter implies it) groups active seats under team headings carrying
`<active>/<total> seats active` and the root path. One column header aligns the two-space
indented seat rows with the team roster columns: handle, harness, state, context,
family, model, preset. Headings are bold cyan (SGR 1;36) on a color terminal;
state and cache markers use the roster colors. Styling requires TTY stdout,
`NO_COLOR` absent and `TERM` other than `dumb`.
`--all` includes dormant teams and inactive seats, preserving its inclusion
meaning. Teams sort by name, ignoring case (codepoint order breaks ties), with a blank line
between teams. Within each team,
warm seats sort by earliest expiry, then cold, then unknown; ties use handle
order. Whole-column fitting accounts for the two-space indent. `--details` is a separate
summary shape; named-team forms refuse `--seats`. JSON is
`{ok:true,scope:"machine",agents:[...],unobserved_teams:[...]}`, with roster fields
plus `team` on each agent. JSON stays flat with its original ordering: warm
expiry first, then cold and unknown in team/handle order. Unreadable teams stay explicit in `unobserved_teams`
(team-name strings), or one human stderr warning; observed seats remain visible
and the report exits 0. The seat alias has no pointer footer.
