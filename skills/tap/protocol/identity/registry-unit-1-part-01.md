# Registry (Unit 1) — source part 1 of 14

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0027 start=159464 end=168389 sha256=da564181324c5300bf0f523a2caee05a9da933f5bb7facf274a9d476c418f642 fragment=1/14 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Registry (Unit 1)

The acting `<team-root>/.tap/team-registry.json` maps handles to the team's complete current Seat and launcher state. It is **authority, not observed liveness**: the row decides current membership, routing, collision ownership, and which session configuration lifecycle verbs may use, while tmux probes decide whether its recorded pane or session is live now. `~/.tap/global-registry.json` only locates each team's acting file. The bus `registry.json`, team history, and archived launcher journal are not runtime fallback authority.

**Reserved handles (tap-7af).** `help` can never be claimed as a seat handle, so that `tap <verb> help` is unambiguous for every verb — including those whose first operand is a handle (`poll`, `peek`, `nudge`, `outstanding`, `register`, `unregister`), where a sole `help` would otherwise be valid user data. The ambiguity is removed where the name could be CREATED, never disambiguated at dispatch: a runtime "is a seat called `help` registered right now?" test would make what a command *means* depend on ambient state. The reservation lives in `lib.sh`'s `tap_handle_reserved`, deliberately **separate from `tap_valid_token`** — that is a pure charset predicate applied to envelope `from`/`to`/`kind`, team names, and *existing* actors in `tap read --by` and `tap reply --by`, so reserving inside it would refuse to settle a payload on behalf of an actor. Both claim chokepoints enforce it: `tap register` (covering `in`, a handle DERIVED from the tmux session name, and `tap crew add`, which shells out to it) and the launcher's `claim_pending_handle`, which writes `agents[handle]` directly and takes the handle from `tag or harness` — so `tap session launch <harness> --tag help` is a real path, not a contrived one. The two implementations are pinned in lockstep by `reserved-handle.test.sh`, the same doctrine as the server epoch's bash/python mirror. Scope is coupled to what the dispatcher intercepts (exact lowercase `help`), so a seat may still be named `HELP`; widen the reservation only together with interception. Payload ids (`<sender>-<UTC>-<hash>`) can never be the literal `help`, so id-taking verbs were never at risk, and alias renames preserve `tag`/`harness` while rewriting only `base`, so they cannot introduce the name either. `courier` and the watcher identity remain reserved on their own grounds (above).

**Schema:**

```json
{
  "team": {
    "schema_version": "1",
    "name": "<worktree-basename>",
    "worktree_root": "<abs-path>",
    "branch_at_bootstrap": "<branch>",
    "created_at": "<ISO-8601-UTC>"
  },
  "seats": {
    "<handle>": {
      "pane": "<tmux-target>",
      "status": "active | pending | suspended",
      "status_reason": "incapable | pane_gone | non_agent_pane | repair_failed | restart_failed | server_restarted | session_replaced | session_restarted | session_stopped | user_removed | restored_from_archive | <empty>",
      "cost_mode": "subscription | api",
      "include_policy": "always | on_request",
      "registered_at": "<ISO-8601-UTC>",
      "registered_from_worktree": "<abs-path>",
      "harness": "<normalized-harness-label>",
      "session": "<launcher-tmux-session-name>",
      "cwd": "<launcher-working-directory>",
      "model": "<optional-model>",
      "passthrough": ["<forwarded-harness-argument>"],
      "harness_session_id": "<optional-direct-native-session-id>",
      "transcript_path": "<optional-direct-conversation-artifact-path>",
      "quarantined_harness_session_id": "<optional-suspect-native-session-id>",
      "quarantined_transcript_path": "<optional-suspect-artifact-path>",
      "identity_quarantine_reason": "<optional-loud-capture-reason>",
      "pane_id": "<tmux-%N>",
      "pane_current_command": "<raw-tmux-pane_current_command>",
      "server_epoch": "srv:<tmux-server-pid>:<tmux-server-start-time>",
      "server_socket": "/absolute/tmux/socket",
      "boot_id": "bootuuid:<boot-session-uuid> | boot:<machine-boot-epoch>",
      "delivery": "pane | poll",
      "wake_url": "<optional-loopback-webhook-url>",
      "unattended": true,
      "crew": true,
      "instance": "<opaque-row-incarnation>"
    }
  }
}
```

**Manual incapable mark (`tap incapable`).** `incapable` is the only operator-set reason: every other value records what a lifecycle verb or probe observed, while this one records a human judgment that a seat's operator is present but cannot work. The verb persists exactly `status: "suspended"` and `status_reason: "incapable"` on the row; the pane, session, mail, `instance` and every unrelated JSON value stay untouched, because the write is a plain atomic document write rather than the alias-superseding save path. The verb holds `down`'s full mutation custody — reset-mutation fence, registry lock, selection revalidation — and reuses `down`'s team-selection authority, because its routing consequence is `down`'s: a suspended row is refused like a stopped seat and its pending mail stays cancellable. It takes no stricter gate than `down`: re-registration of the same handle restores `active` with an empty reason on the existing instance. Refusals name the stored state: unknown handles, crew seats (ephemeral by contract), poll-delivery rows, seats mid-launch, rows already carrying the pair (an acknowledged no-op that writes nothing), and any row not plainly active — a different status, or an active row still carrying an operational reason. The mark is manual and non-sticky; the roster reads the pair back as a distinct present-but-incapable state (`● incapable` by default; `--all` and JSON carry `suspended` / `incapable`). Send refusals for a suspended row carry reason-specific recovery advice, and for an `incapable` row that advice advertises only re-registration from the target pane — never a delivery bypass such as `--cross-worktree --pane` or session resume. `tap session repair` and `tap admin rebuild-registry` may refresh the attested pane facts of an `incapable`-marked row but preserve the exact pair; public re-registration remains the only door that clears it.

**v0.20 registry stores.** `~/.tap/global-registry.json` with `schema: "0.20"` is the machine marker. TAP never converts an older store: an old file refuses as `old_store` (see structured-failures for the per-store action). The former migrator is gone.

- **Global registry** `~/.tap/global-registry.json` — a state document: top-level sections `schema`, `teams` (plus unknown sections that round-trip). **Born live:** a machine that holds NEITHER this file NOR a legacy `teams.json` is not pre-flip, it is new, and its FIRST enrollment bootstraps this file at `schema: "0.20"` and enrolls into it — it never creates the retired `teams.json`. The bootstrap happens inside enrollment under `teams.json.lock` (the machine-wide polarity lock) and is deliberately NOT performed by de-enrollment, which carries the same polarity check but must not create machine state while removing it. **Both first-entry doors are born-live doors:** `tap init` and `tap register`/`tap in`. Register is a supported first entry on a fresh canonical repo — the teamless-cwd onboarding preflight DEFERS whenever an actor positional, `TAP_SELF`, `--from`/`--by`, or an enrolled pane already names an identity — so a machine whose first command is `tap register <handle>` is born live exactly as one that ran `tap init`. **Born-live fires only where the root is INDEXABLE**, which is the same eligibility enrollment itself uses: the root is positively observed to be a git worktree TOP-LEVEL, and `TAP_HOME` equals the resolved `<root>/.tap/bus`. The git half is the machine-index boundary — git worktree top levels enroll; a non-git folder enrolls only through `tap init` or a first launch, which authorize that exact root after the operator's consent and only when git positively answers "not a git repository" (an unobservable git is never read as non-git), with `TAP_HOME` equal to `<root>/.tap/bus`. Every other non-git folder keeps its local bus without appearing in the index. A path nested inside a worktree is not the team root and is not indexable either. A custom or non-canonical `TAP_HOME` is unindexable by design, has no post-flip existence (post-flip authority resolves only through the machine index), and is NOT APPLICABLE to born-live: the bootstrap returns not-applicable, no marker and no `teams.json` are written, and `register|in` refuses with `born_live_unavailable`. Such a machine has still never held TAP state, so the next indexable entry is born live — ordering poisons nothing. A root that cannot be resolved is not-applicable too, never indexable: the predicate answers no on failure rather than comparing an unresolved path (rule 19). Each `teams.<name>` carries `root`, `registry_location`, and `state: registered|historical`. Resolve uses the stored location; **no prune-on-read** (a vanished root is observed evidence — `tap doctor` surfaces it). The `git worktree list` basename fallback is deleted. Enrollment refuses a root inside the realpath of the system temporary directory (including `/tmp` and `TMPDIR` aliases) when `TAP_INDEX_HOME` is unset, naming that pin as the sandbox remedy; an explicit index pin authorizes test/scratch enrollment and never writes the fallback `~/.tap` index.
- **Team registry** `<team_dir>/.tap/team-registry.json` — complete current state with sections `schema`, `team`, `seats` (unknown sections round-trip). Launcher-owned Seat rows carry their session configuration and explicit native resume provenance. The hidden `instance` field is one row lifetime, never a handle encoding. History is **never** current registry state.
- **Team history** `<team_dir>/.tap/team-history/` — append-only tombstones (`retired_by` + full last row + instance) and per-handle pane/session lineage logs. Global teardown records live at `~/.tap/global-history/`.
- **Envelope fields (schema defined here; stamping lands in U3):** `recipient_instance` and `sender_instance` on payload/receipt/spool records. Pre-flip traffic has neither.

Runtime v0.20 consumers never choose an old store when the marker is live. An absent marker opens no legacy door either: the shell authority sample answers `unresolved`, SessionStart root discovery finds no root, shell team-name and pane lookups answer nothing, v0.20 obligations refuse (`unanchored_bus`), and launcher resume, restart, list, repair and clear-nonce writers refuse without walking the bus registry; completion offers nothing. Only `tap init` and first launch act on an absent marker, and they bootstrap born-live; a seated bus `registry.json` refuses every born-live door (`unenrolled_seats`). No runtime reader opens legacy `teams.json`: with no marker the index readers name no path, and native entries that read the index before any selector (`tap admin`, `tap teams`, `tap attach`, `--team`, the unanchored pane arm) refuse `unanchored_bus` (next `tap init  OR  tap session launch`). Only `old_store` evidence names the file.

**Registration bootstrap and refusal.** Native `tap register` / `tap in` writes only current `seats` authority. With no global marker, it bootstraps only a pristine, indexable canonical git worktree. A legacy `teams.json`, bus `registry.json`, launcher manifest (including `TAP_SESSION_MANIFEST`), or agents-axis acting store refuses as `old_store` before any write; registration preserves the store and never folds it. The refusal's action matches the store: a team or bus registry is upgraded by hand or moved aside before `tap init`; a machine index or launcher manifest is moved aside. An absent-marker custom bus refuses as `born_live_unavailable`. A live machine uses its enrolled `registry_location`, including valid custom locations, and retains historical evidence without consulting it as authority. Enrolled-unreachable and ambiguous roots refuse instead of creating an empty replacement.
