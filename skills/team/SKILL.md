---
user-invocable: false
name: team
description: "When choosing a TAP recipient or checking membership, list the roster and metadata."
argument-hint: ''
allowed-tools: 'Bash'
role: maker
---

# /tap:team — who is on your team

```bash
tap team
```

Lists the team name and each member. Default columns are handle / harness / state / context / family / model / preset (family: vendor lineage from the recorded preset's `metadata.model_family`, else the harness's own vendor; `-` when unknown). Default `state` is a lossy display projection, not JSON `status` / `status_reason` / `agent_state` and not `--all` lifecycle status. Native `state` is `● <label>`: `unbound` rows render `unbound` and other non-active lifecycle rows `offline`, both without capture; active rows are `working`, `blocked`, `idle`, `waiting` (the turn ended but its own background shells, terminals or a notify-done compute job will wake it: leave it alone), or fail-closed `unknown` from one bounded screen observation. An age follows when evidence dates it. Working counts from turn start; idle and waiting count from turn end, so a long `idle` is the stall signal and a long `waiting` is a hung job. Forced or fallback Bash cannot observe agent state: active -> `unknown`, any other lifecycle -> `offline`. An interactive TTY may color state dots and cache markers, and any presence of `NO_COLOR` disables ANSI. `context` is used tokens / cap (for example `145k/380k`), a bare count such as `340k` when the cap is unknown, and `—` when no count is available; `model` is the observed `model@effort` (a bare model name when the effort is unobserved), falling back to the launch snapshot, else `?`. The default table has no roles column. The preset cell carries the seat's recorded launch provenance, `n/a` when the row has none, and `<name>?` when the value was matched from the handle text rather than read from a record — a guess never prints with the authority of a record. `--all` does not widen this table or observe agent state: it switches to a zero-capture nine-column schema — handle / kind / harness / pane / status / attached / unattended / reason (classifier `status_reason`) / notes/asks — which omits preset and roles and keeps classifier lifecycle in `status`. Native Bun `--json` rows carry `agent_state` (`working|blocked|idle|waiting|booting|overprint|unknown`) and `agent_state_reason`, plus `waiting_on` (the background work behind `waiting`), `turn_started_at` (working) and `turn_ended_at`/`turn_ended_source` (idle/waiting; from the transcript's own turn-end record, else null), without changing lifecycle `status` or `status_reason`; forced or fallback Bash retains the legacy eight-key rows and does not capture panes. Agent state is separate from pane/injection safety; unsupported, pane-less, inactive, unreadable, failed-capture, and recognized no-match rows fail closed with a typed reason. JSON also returns `crew`, plus conditional preset-provenance fields whose conditions differ — `preset` whenever provenance resolves at all, `preset_inferred` only for a handle-derived match, `preset_absent_from_catalog` only when the record names a preset the catalog no longer defines (so that key appears precisely when the handle does NOT join an entry), `preset_catalog_unavailable` only when the catalog could not be read at all — a different fact with a different repair, never emitted alongside the previous key — and `metadata` only when a resolved entry carries it. Lifecycle fields remain **registry state — provenance, not agent work state**: a listed member may or may not be actively attached right now.

- **What was I working on:** `tap teams --recent -n 15` lists every enrolled team, dormant ones too, most recently active first, with a LAST ACTIVE column; `tap team --recent [-n <n>]` orders this team's seats the same way (flat, with a `last active` column; `--json` adds `last_active_at` and `last_active_source`). Last activity is the rule `tap team refresh --stale` ages by, and a working seat counts as now. Useful after a restart or a resume, when nothing is active.
- **Find stalled seats:** `tap team --stalled [--stale-after <secs>]` (default 600) lists the seats idle at least that long, by dated turn end, that still owe an unanswered inbound ask or assignment: the real "everyone waiting on everyone" signal. A seat with no dated turn end is never called stalled; it appears on a `not judged:` line (JSON `unjudged`). Exit is 0 either way; `--json` and `--names` work.
- **Open viewers:** `tap team attach [--dry-run]` opens one iTerm window with one ordered tab per initially unattached live durable seat from the current bus team's worktree. It is viewer-only: it skips already-viewed sessions and names their pre-existing client TTYs, reports unavailable seats with revive guidance, and never resumes or resurrects. After automation, success requires a new tmux client TTY relative to every planned seat's pre-image within a short bounded retry window; otherwise the named seats, exact commands, and disclosures are printed with a nonzero exit. If every live seat is already attached, it opens nothing and exits zero. The tab strip labels every planned seat handle. If iTerm cannot be automated it prints the exact tmux commands; dry-run previews the artifact but cannot prove attachment.
- **Trim dead seats:** `tap team refresh` probes pane-backed seats and deletes rows whose panes are gone (poll-mode seats are skipped and named).
- **Stop runtime, keep state:** `tap team down [--yes|--force] [--keep-self]` stops verified sessions and suspends seats; registry/bus/manifest retained.
- **Relaunch after down/restore:** `tap team up` (= `tap session resume --all`). Not `team resurrect` (that only primes undead seats).
- **Recover the latest restart cohort:** `tap team up --last --dry-run` previews the newest prior tmux generation on this team's socket; `-` is an alias. Run `tap team up --last` to confirm that cohort, or add `--yes` without a terminal. It excludes deliberate stops, retirement and all crews, and never falls back through a fully stopped generation to older seats. Unknown row generations are skipped; unobservable current boot/tmux evidence refuses. `--last` cannot combine with `--only` or `--except`. Same-server individual exits still need explicit handles.
- **Clear seats, keep the team initialized:** `tap team reset --yes` (same as `team out --hard`). Includes your own seat; spare it with `--except <your-handle>`. Existing archives stay untouched; team restore/purge are retired.
- **Reach a sibling worktree's agent:** address them `<team>/<handle>` on /tap:send.

`--json` and the machine-wide view (`tap admin ...`) are reference — `tap help team` or `skills/tap/SKILL.md`.

To narrow any seat list, add `--harness a,b`, `--model opus,fable` or `--state idle,active`.
For caches across the machine, use `tap teams --seats [--all] [--json] [--wide]`
(or `tap teams roster`, `tap team list --seats`). Team headings carry `<active>/<total> seats active` and roots, with blank lines between teams; indented
seats share the roster columns. Teams sort by name, ignoring case; within
each team, warm seats sort by expiry, then cold, then unknown. `--all` includes
inactive seats too. Claude's context marker `●4m` means estimated minutes until
expiry; a bare `●` means the recorded lifetime elapsed. Markers are bright blue
at 15m or more, yellow under 15m, red under 5m and dark red after expiry. Color
requires a TTY, NO_COLOR absent and TERM other than dumb. No marker means
unsupported or insufficient evidence, including Codex. Response timing can
overstate time left; a countdown does not prove server availability. JSON stays
flat with its original order; `prompt_cache` is separate from `context_tokens`.
See [timing and schema](../../docs/roster-cache.md). `tap team --all` keeps its
existing diagnostic columns.
