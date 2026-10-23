# Seat relaunch (`tap session relaunch`) (v0.22) — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0059 start=379843 end=381576 sha256=bacc957367386ea91a5746944eaf5e637beb3b4908a7497047c9c3fac38100d6 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Cursor's never-persisted chat refuses on every resume door (tap-we6b).** A stopped cursor seat whose stored chat id has no conversation store under the workspace hash has nothing to resume, and `cursor-agent --resume` without an id opens a picker that can bind a different chat. `tap session resume`, `tap session restart` and `tap up` therefore refuse such a seat before any reservation, mutation or launch with `no_exact_resume_identity` and the action `tap session launch cursor <name> --fresh`. A seat whose session is still attachable (live, busy or unknown, as before its first turn) is not stale: `tap session resume` reattaches it before this gate, and the collision chooser keeps its reattach tier. The shared launch transaction applies the same refusal to every resume-family kind, `tap team up` included, and binds the answer once before any effect, so a store that disappears later cannot turn the launch into a fresh start. The builder never emits a bare `--resume`; the collision chooser labels that seat's revive tier `stale`.

**There is no soft-exit path, by decision.** A harness whose turn has just been refused is not reliably able to process `/exit`, so a graceful attempt would buy a per-seat timeout on exactly the path that matters and then take the in-place respawn anyway. Typing `/exit` is also a possible-effect mutation: once submitted, whether the TUI died, is dying, or ignored the keystroke is unknowable, and falling back afterwards is a retry after possible effect. The respawn is therefore the only path.

**`-m` rides the harness's own resume prompt as argv**, so the instruction is submitted with the resume and no keystroke is simulated. Per-harness channels are as §Seat clear specifies. Since tap-74h2l, the OpenCode instruction is addressed as `<team>/<handle>`: the qualified recipient selects the target team's registry and pane, the send consults the target clearing fence, and the canonical payload stays on the sender's bus. This is why a capped-fleet restart needs no separate wake verb: `tap nudge` re-submits a *visible unsubmitted sentinel* and is a reported no-op on a freshly resumed pane, so carrying continuation text there would make a deliberately narrow verb into a general keystroke injector. *Superseded (tap-xe42x):* [`tap nudge`](../delivery/nudge.md) now may type one fixed id-less doorbell under a narrow recovery license; it is still no keystroke injector, and resume text still rides `-m`.

**Relationship to `tap session restart`.** `restart` is session-scoped: it runs `tmux kill-session` and every seat in that session dies. `relaunch` is seat-scoped and in-place. Because `restart`'s busy-refusal set includes `rate-limited-error` — the cap state itself — an operator reaching for `restart` during a cap is refused *because the seats are capped* and would naturally add `--force`. That refusal therefore names `relaunch` for the capped seats specifically, and only when the team resolves (the recovery hint uses `team/handle` to keep its target explicit even if the operator changes teams). Seats busy for other reasons keep the original guidance: relaunch would discard a genuine in-flight turn.

**Native restart owner.** `launcher/restart.ts` selects one exact current stored recipe and invokes the shared session transaction. Working, blocked-on-approval, rate-limited-error, alert and unknown states refuse across all active sibling seats. `--force` bypasses only that busy check; authority, reset fences, membership, unique conversation ownership and invocation validation still precede teardown. Dry-run performs preflight without killing or writing a launch reservation.

After a proven session kill, a failed resume returns `restart_resume_failed` (exit 1), the killed session, a stored-record path, the retained recipe and an exact manual `tap session resume` command. A successful backup names its `launcher-session-record.json`; otherwise the receipt names the original registry and retains the recipe as data. The original failure remains in the detail, including rollback uncertainty. If rollback or creation authority is unverified, `recovery_required` is true and the immediate action is `tap doctor`; `resume_command` remains available after inspection. No failure retries the launch automatically.

All public resume/restart spellings, including unambiguous long-option abbreviations and `--` operands, are parsed natively. `tap team up` carries its only/except selection into the same in-process resume-all owner. The shell session entry is transport only; no Python session command remains.

**A resumed native identity has one owner (tap-odt1d #4).** Relaunch uses the same
native-identity owner check as resume and restart, against the effective conversation
id and harness. Another seat holding that pair refuses with `duplicate_resume_identity`
before dry-run rendering or a nonce write. The existing nonce-stamp and pre-respawn
checks repeat it; a duplicate discovered after stamping consumes only this attempt's
nonce and performs no respawn. Distinct ids or harnesses do not collide. This is an
observation before the effect, not a machine-wide identity reservation.

Ownership includes both a seat's stored native-id claim and its effective resume
identity (including Claude transcript/quarantine fallback). Non-regular registry
locations are skipped before reading, so an unrelated FIFO cannot block the scan.
Self exclusion uses the selected team root, registry and handle, not the launch cwd
or depth of a relocated registry path;
missing root metadata cannot erase another seat's native-id claim.

**Enrolled-root agreement (tap-odt1d #13).** Durable and crew relaunch resolve
through the shared team context, which checks the acting registry's team name
and any recorded worktree root against the selected enrollment before acting.
A conflicting root refuses even in dry-run. Relocated registry files and
canonical root aliases remain valid; registry pathname depth is not authority.

## Relaunch progress and cancellation (tap-c27s2)

Human output reports target checks, replacement, and startup observation as they occur. `--json` emits one final receipt without progress lines. Both dry-run forms use the same active candidates and caller exclusions, with no replacement effects.

Codex relaunch observes startup blockers for five seconds after stable process confirmations, bounded by the existing 45-second readiness ceiling. A blocker, exit or identity change during that window refuses readiness. Explicit full-deadline observation callers retain their window. A late first sample gets one bounded confirmation; the final observation may finish after the deadline. Each pane read has a five-second subprocess timeout; a timed-out observation never establishes success.

Completed clear and relaunch readiness observations append timing to `.tap/clear-latency.jsonl`, with additive `operation: "clear" | "relaunch"`. Existing timing and outcome fields remain; older rows without `operation` describe clears. Dry runs append nothing.

SIGINT/SIGTERM use the shared launcher cancellation scope. Before respawn, the result says nothing was replaced. After a respawn attempt, it reports replacement state as unverified and directs the operator to inspect the pane before another relaunch. Cancellation retires only the operation's expectation and releases its clear fence; it never retries respawn. Exit codes 130 and 143 identify interrupted relaunch commands, including JSON receipts.

<!-- Addendum relocated verbatim from part 01, 2026-09-25, for the page budget. -->

## Session overrides (2026-09-19)

`tap session launch` and `tap session relaunch` accept explicit overrides without changing the preset:

```sh
tap session launch astra-fast -- -c model_context_window=250000 -c model_auto_compact_token_limit=200000
tap session launch fable --env CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000
tap session launch fable --unset-env CLAUDE_CODE_AUTO_COMPACT_WINDOW
tap session relaunch astra-fast -- -c model_context_window=250000
```

Harness arguments after `--` append after the stored recipe and generated arguments. The harness determines duplicate-option semantics. Preset parameters remain present; TAP's permission checks and record-owned OpenCode session identity still apply. `--model` and `--effort` remain incompatible with presets.

Repeatable `--env KEY=VALUE` replaces the stored value; the last assignment to a key wins. Repeatable `--unset-env KEY` removes a variable from the child environment after login startup, including preset, machine-policy, and inherited values. The existing environment-key fence applies to both flags. Setting and unsetting the same key in one command refuses; a later set clears an earlier persisted unset.

Overrides persist with the session. Relaunch retains the existing settings and conversation, appends new arguments, and saves environment changes at the guarded replacement boundary. A dry run changes nothing. A bare relaunch handle selects the current enrolled team; `team/handle` selects that explicit team. The same overrides apply to each selected seat in a batch, crew included.

This supersedes earlier preset exclusivity for `--env` and the earlier replacement/leading-position behavior for explicit launch arguments. Existing stored passthrough vectors retain their original interpretation; new explicit tails and unset keys use separate additive record fields.

## Repairing a seat's workdir (tap-p8xog)

**Grammar.** `tap session relaunch <[team/]handle> --workdir <path>` is single-seat only: batch (`--harness`) and crew relaunches refuse it, and the option is the one durable override of a seat's recorded `launch_workdir`. Without it the recorded value is used.

**Validation.** Launch's repository-membership check runs before active/self exclusions: an invalid worktree refuses `invalid_workdir` for inactive and caller-pane seats too, including dry runs. Before respawn, `resume_unavailable_in_workdir` refuses a missing Cursor workspace store or an OpenCode native session whose directory cannot be verified as the target ([store rules](resume-store.md)); dry runs apply both guards.

**Dry run.** It changes nothing and names the directory it would use: the JSON receipt's `results[].workdir` and the human plan line `would respawn in <dir> and record it as launch_workdir`. Both appear only when `--workdir` was given.

**Effect.** The harness respawns in the directory, and the row's `launch_workdir` is written when the clear expectation is consumed, after the last census-identity check. A seat interrupted after a successful respawn still records it, since the harness already runs there; an interruption before the respawn leaves the row alone. If that write fails, the result is `launch_workdir_unpersisted` and exit 7 (never retry), with the interruption as secondary detail.

**Exit 7.** For an explicit `--workdir` the write is required. If custody refuses it, the row or expectation changed, or the registry turned old-store, the relaunch is post-effect: `launch_workdir_unpersisted`, the harness runs in the new directory while the recorded one is unchanged, inspect the pane, never retry. An underlying old-store or unreadable-registry finding is reported beside it, not instead of it. The single-seat `--workdir` command exits 7 only when its member returned 7 after the respawn (`launch_workdir_unpersisted`, `post_respawn_error`, an unverified start, an observation timeout), never for a failed respawn (`tmux_error` passes tmux's raw status through and exits 1). Otherwise an OpenCode `instruction_undelivered` (member 6) exits 1, and an interruption 130/143 unless the `launch_workdir` write also failed (7). Every other relaunch, batches included, keeps exit 1 for any failed member. Without `--workdir` a failed nonce cleanup stays a warning.
