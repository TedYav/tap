# Roster cache estimates

`tap team` keeps the token count and cap in `context`, then appends a Claude cache estimate when the transcript establishes a TTL. For example, the same token count can appear with a short estimate, a longer estimate, or an expired lifetime:

| Example `context` display | Cache estimate |
| --- | --- |
| `340k/420k ●4m` | Four minutes remaining |
| `340k/420k ●59m` | Fifty-nine minutes remaining |
| `340k/420k ●` | Recorded lifetime elapsed |

The token count and cap have no spaces around `/`. A cache dot with minutes shows estimated time remaining, rounded up to whole minutes (at least 1m); a bare dot means the recorded lifetime elapsed. The estimate comes from the assistant record timestamp. The [Claude cache lifetime](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) starts when the request starts, so response latency can overstate time left. A warm estimate does not prove server availability. An expired estimate means that the recorded lifetime elapsed, not that TAP observed eviction.

The reader uses the same session-bound, 2 MiB transcript tail as the context census. It skips synthetic, sidechain and other-session records. The newest cache-reading or cache-writing record dates activity. The newest preceding write establishes the TTL through `usage.cache_creation.ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`. A read-only record refreshes that TTL only when its write evidence remains in the tail, within the same model and after the latest compaction boundary. Mixed 1h/5m writes use 5m, the earliest expiry. A changed TTL takes effect at its write; no fixed per-seat default is assumed.

No cache marker appears when the harness is unsupported, no caching was observed, or the TTL cannot be established. These are distinct JSON states. Codex rollouts report cached tokens but do not establish a per-request TTL or expiry; TAP therefore leaves its cache field null. [OpenAI's cache lifetime controls](https://developers.openai.com/api/docs/guides/prompt-caching) describe request options, which do not establish which option a Codex session sent.

## Machine-wide seats

`tap teams --seats` groups active seats beneath team headings with the root path and active/total seat counts. Teams sort by their soonest warm expiry, then name. Within each team, warm estimates sort by earliest expiry, then cold, then unknown; ties use handle order. One indented header aligns every team's seats: handle, harness, state, context, family, model, preset. `--all` also includes dormant teams and inactive seats. `--wide` retains columns on a narrow terminal; otherwise preset, model, family and context drop first, preserving handle and state. Pipes retain all columns.

On color terminals, team names are bold cyan and state dots use the roster palette. Both roster views color cache dots and their minutes bright blue at 15m or more, yellow under 15m and red under 5m. The bare expired dot is dark red. Colors require TTY stdout, `NO_COLOR` absent (including an empty value) and `TERM` other than `dumb`; monochrome retains the same markers. After collecting all team rosters, the machine view refreshes cache state and remaining time against one clock before sorting and rendering, so a sample that expired during collection gets a bare dot.

This extends the existing machine-wide `teams` noun. `--all` keeps its inclusion meaning; `tap team --all` keeps its separate diagnostic table. `--details` remains a team-summary shape and cannot combine with `--seats`. `tap teams <name>` still selects one team and refuses `--seats`. `tap team list --seats` is the machine-view alias. If an enrolled team's roster cannot be observed, the view keeps healthy seats and names the missing teams in one stderr warning. JSON carries those team names in `unobserved_teams` (always present, empty when every team was observed). A report with gaps still exits 0; it never treats an unreadable team as empty.

## JSON

`tap teams --seats --json` returns `{ "ok": true, "scope": "machine", "agents": [...], "unobserved_teams": [...] }`. Agent records have the `tap team --json` fields plus `team` (string). Text and JSON select the same seats. JSON retains its flat ordering: warm expiry first, followed by cold and unknown entries in team/handle order. Failures return `{ "ok": false, "error_class": "...", "action": "...", "detail": "..." }` with exit 1 for invalid usage or an unavailable machine index.

Every team agent has `prompt_cache`, separate from the unchanged `context_tokens` schema. It is null without a sampled Claude cache record. Otherwise:

| Field | Meaning |
| --- | --- |
| `state` | `warm` / `cold` from the estimated deadline; `none` when valid usage reports no caching; `unknown` when TTL evidence is insufficient |
| `ttl_seconds` | `300`, `3600`, or null |
| `last_activity_at` | Newest observed cache-touching assistant timestamp (ISO string), or null |
| `expires_at` | Activity timestamp plus TTL (ISO string), or null |
| `remaining_seconds` | Floor of estimated deadline minus read time, clamped to zero, or null |
| `source` | `claude_transcript` |
| `basis` | `assistant_timestamp` |
| `unknown_reason` | `ttl_not_in_tail`, `ttl_not_reported`, `invalid_cache_usage`, `invalid_cache_timestamp`, or null |

Compaction clears pre-boundary cache evidence. Inactive and foreign-namespace seats are not sampled, so their cache is null. A model change that has not yet appeared in transcript usage cannot be detected. These estimates concern the observed prefix and do not predict whether the next request changes it.
