# Model reference and launch tuning

**Absent-ledger model reference (.194).** Only genuine absence of the personal ledger enables the
checked-in config.v3 catalog projection in both views, labeled **reference; access unverified**.
Malformed or unreadable existing ledgers refuse; `--full` stays ledger-only. The reference is keyed
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
