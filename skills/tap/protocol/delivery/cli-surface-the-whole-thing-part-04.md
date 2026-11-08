# CLI surface (the whole thing) — source part 4 of 11

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

## Exact handle/session resume may retry retained pane seats suspended as pane_gone, session_replaced, repair_failed, or restart_failed; it reports that prior state. A live occupant of that name refuses before registration and names an inspection command. This never expands harness-family matching or bulk resume, nor revives user_removed, poll, crew, or absent membership.

The preserved source text for this locator appears inside the fenced CLI fragment below.

## Session launch presets

The preserved source text for this topic appears inside the fenced CLI fragment below.

<!-- tap-source id=source-0078 start=501434 end=510430 sha256=1492883f7f3db385986d52ed940c8618852092b39c42175cab063b3a89fce32d fragment=4/11 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
```text
**Seat naming and launch provenance.** A provided name IS the handle, on every arm: `tap session launch opus reviewer` and `tap crew add opus reviewer` both seat `reviewer`. A BARE positional still defaults the handle to the preset name (`launch kimi` seats `kimi`), including a dotted one — `launch sol.max` seats `sol.max` literally, because `allocate_name` would otherwise sanitize the dot away and the handle would no longer match its catalog entry.

The withdrawn rule derived `<preset>-<name>`. It was removed because it re-encoded launch provenance into the NAME, and every surface that keys on names collided with it: the resume/suffix/fresh picker stopped recognising existing seats (a second seat was created silently instead of the chooser being offered), remediation strings across the repo named handles that would never exist, `sanitize_component` mangled dotted preset names out of their own catalog match, and a derived handle could land squarely on a DIFFERENT preset's name — on the shipped catalog, `launch fable xhigh` produced `fable-xhigh`, a real entry.

**Provenance is READ FROM THE RECORD, never inferred from the handle.** The seat record already persists `preset: {name, source_path, config_digest}` at launch (resolve-once, §Session launch presets), so `tap team` and `tap session list` display the preset a seat was launched with by reading it. `--json` carries `preset` accordingly. Where a row has NO recorded provenance — seats predating the field, or manually registered ones — the catalog's name-based match (`PresetCatalog.for_handle`: exact name, else longest `<name>-…` prefix) is a fallback, and it is MARKED: `preset_inferred: true` in `--json`. An inferred value must never print with a record's authority; unmarked, the two were indistinguishable, and a seat launched with `cursor-grok` reported `grok` because a catalog entry of that name existed. A recorded preset the catalog no longer defines reports the recorded name with `preset_absent_from_catalog: true` rather than substituting a handle match. A catalog that cannot be READ is a different fact and carries its own key, `preset_catalog_unavailable: true`: the record still reports, but nothing is known about whether the entry survives, and the repair is the file rather than the preset. One flag for both would have made "the operator deleted it" and "the config will not parse" indistinguishable to a consumer that acts on the difference. Calibration keys on the recorded preset, which is strictly stronger than the prefix convention that motivated derivation.
tap session resume <handle|session|harness> [legacy-name] [--dry-run] [--json]   # resolve exact current acting-registry membership before harness-family fallback; live rows reattach, stopped relaunchable rows recreate the same tmux name, an explicit native id requests exact resume, and a missing id delegates to the harness picker/latest behavior; never creates missing membership and never promotes a derived id
# Exact handle/session resume may retry retained pane seats suspended as pane_gone, session_replaced, repair_failed, or restart_failed; it reports that prior state. A live occupant of that name refuses before registration and names an inspection command. This never expands harness-family matching or bulk resume, nor revives user_removed, poll, crew, or absent membership.

tap session resume --all [--dry-run] [--json]   # recreate this team's relaunchable stopped seats whose exact tmux names are absent, including retained operational failures with positively stale boot/server stamps from a readable same-socket observation (see On-demand tmux bootstrap below); crew, poll, user_removed, same-boot pane_gone, and incomparable stamps stay excluded; name skipped unverified live occupants; failures park the affected row as suspended/repair_failed, continue, then return nonzero

### Session launch presets

TAP-owned options may appear between the harness (or positional preset) and the optional seat name. The launcher keeps the recognized name beside the harness before parsing, including on older supported Python 3.12 patch versions. This does not change the passthrough boundary: an unknown flag or `--` starts the harness argument tail. An implicit unknown flag emits a warning naming the boundary (buffered and discarded on JSON failure to keep stderr empty); `--` makes intentional harness passthrough explicit and emits no warning. `--cwd` is not a TAP launch option: launch from the enrolled team root, then have the seat change into its worktree. An unenrolled linked worktree still refuses implicit team enrollment.

**Retired tuning spellings.** `--teams` on `launch`, and `--model` and `--teams` on `resume` and
`restart`, no longer parse. Agent teams is ordinary environment now: spell it in a preset, in
`--env`, or in `[harness.claude.env]`. Model and effort are chosen at launch, then belong to the
harness session; change them inside the harness (`/model`, `/effort`) or relaunch the seat with a
`--` tail. The launcher's argparse rejects these spellings with exit 2. The
launch passthrough splitter (`launcher/overrides.ts`) still claims `--teams` as a TAP flag, so it is
refused rather than forwarded to claude's own CLI. The native launch port (`launcher/new.ts`)
refuses them with the launcher's own argparse exit 2; `launcher/resume-all.ts` keeps its named
`retired_flag` refusal for callers that reach it directly. Tuning typed on a launch that DELEGATES to resume refuses
`launch_tuning_not_resumable` instead — a different class, because there the flag is still live, just not applicable to the path it took.

**What a resume re-passes (tap-j5k1b).** A resume (`session resume`, `restart`, `resume --all`,
`seat up`, the crew-held revive, and `session relaunch`) does not re-pass a tuning axis that the
harness restores from its own session, so an in-session `/model` or `/effort` survives. The axis
table is `NATIVE_RESUME_RESTORES` in `launcher/resume-tuning.ts`, set from live resume probes:
claude restores model, codex (the `codex resume` TUI path) restores model and effort, and opencode
restores model. For those axes the resume drops the stored launch value from every replayed source:
the record's model, stored passthrough, `[harness.*]` params, and the stored `--` tail, in every
spelling (`--flag value`, `--flag=value`, `-m`, Codex `-c`/`--config` assignments). It stops at a
literal `--` and leaves every other flag in place. Claude does not restore effort; a resume passes
the newest assistant turn's observed `effort` from the bound transcript (the roster's reader) and
replays the recorded effort when nothing was observed. Cursor and agy restore neither axis and
expose no observation, so their resume replays the stored launch model and effort: an in-session
change there reverts on resume. Tokens typed on the current invocation (a relaunch's `--` tail)
always win and are never dropped. One edge follows from observation: a relaunch that types an
effort and dies before its first assistant turn resumes at the older observed effort. Stored rows
keep their launch tuning; `launch_tuning` keeps the launched value for an axis a resume left to the
harness. New launches and forks still apply presets and launch tuning in full. Environment is
different: harnesses do not keep it, so every resume re-passes the seat's stored `harness_env` and
`harness_unset_env` (the latest a launch or relaunch wrote) over machine policy and over any
conflicting ambient value; a fork inherits its source's latest env.

Presets are a durable-session launch input, not a second lifecycle system. Their source is `${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml`, selected from an absolute `XDG_CONFIG_HOME` or an absolute `HOME`; there is no repo-local overlay, CLI path option, include, inheritance, or merge. The checked-in reference is `skills/tap/config/config.v3.toml`; the machine file is a copy (`cp` that reference over `config.toml` after backing up the previous file). The reference is gate-parsed by the real parser. `config.toml` is authoritative per SECTION: `[harness.*]` reads from it, and `[presets]` reads from it when defined and non-empty there, else falls back to `${XDG_CONFIG_HOME:-$HOME/.config}/tap/presets.toml` for one release with a deprecation notice. Fallback is never per file: an operator who seeds a `config.toml` holding only a harness table — or a vacant `[presets]` header they intend to fill later — must not thereby empty their preset catalog.

**Schema tolerance: the config is the owner's to extend.** The reader never refuses over CONTENT — it understands what it can, ignores what it cannot, and emits one 
```


**Launch readiness and stopped records (tap-zi01z).** A new launch observes its harness through a bounded readiness window before printing `running detached`; two quick process observations do not prove startup survival. The login shell has up to the start ceiling to show the harness: 60 seconds, or a finite positive `TAP_LAUNCH_START_TIMEOUT_SECONDS`, whose other values refuse before any launch effect. Past the first five seconds the launch keeps waiting only while the pane's own process (`pane_pid`) is still the login shell or the `env` it execs (a slow rc shows its child commands as the pane command while that root stays the shell), and only while the pane tail is blank or changing. Text unchanged for five seconds reads as a blocked prompt. A dead pane, a root that exec'd some other program, or another agent harness in the foreground ends the wait. A failed capture or process read is no evidence either way. The five-second survival window starts at the harness's first observation, whenever that lands. It ends early on a positive survival signal — the seat's SessionStart bind landing in the registry (Claude) or the harness input composer painting (Codex, OpenCode) — followed by a short settle interval that the same survival checks cover; without a signal the full five-second window stands. After the initial process identity is confirmed, an exit, unavailable observation or identity change during the window or the settle fails the launch, even if a replacement later stabilizes. This is bounded startup evidence, not a promise of future process liveness. A positively gone seat row with no live tmux session is reported as `session_record_exists`, with `tap session launch <target> <handle> --fresh` as the next action. A session that vanishes after the initial namespace snapshot receives the same diagnosis only after a fresh observable namespace confirms its absence. Both argv `--json` and `TAP_JSON=1` select the structured stopped-record response. The record is preserved until explicit replacement; unobservable or live incumbents retain their existing collision guards.
