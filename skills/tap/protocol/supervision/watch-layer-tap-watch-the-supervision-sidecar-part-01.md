# Watch layer (`tap watch` — the supervision sidecar) — source part 1 of 4

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0063 start=393606 end=402426 sha256=a7d1611bacc90bbe26ac41d21aae67af25d9bacf7499b2c7bc72a64fe600a9cf fragment=1/4 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Watch layer (`tap watch` — the supervision sidecar)

Persistent sidecars (`tap watch run`, `tap goalie run` and the per-entry spool
deliverer) fingerprint their sources before loading them: the spool waiter
(`runtime/bun/src/spool-waiter.ts`) its `WAITER_SOURCES` plus `lib.sh` and `style.sh`; the
goalie (`goalie-run.ts`) `GOALIE_SIDECAR_SOURCES`, the watch loop's list plus its own modules;
the watch loop, Bun since W3 (`runtime/bun/src/watch-run.ts`), the whole import closure of
its own entry, the tick's and the reminder door's (the list is exported and checked against
the closure), plus `lib.sh` and `style.sh`. At the next iteration boundary they re-exec from those paths if the
fingerprint changed — the Bun loop through `process.execve` with its own argv. The PID and
watch lease stay in place; a spool waiter carries its ownership token and remaining retry
cadence through re-exec. A changed source is logged as `source-changed`. A source that
becomes unreadable after a good start is a landing that deleted or moved it: it re-execs
the same way, logged as `source-unreadable; re-exec`, and the new process stamps its own
list (tap-conft: a change deleted a stamped module and the old refusal ended every live
waiter with its entry still parked). A source unreadable at start, including just after
that re-exec, stops the sidecar before another iteration with `source-unreadable;
refusing another iteration`, lease kept. "Unreadable" means unreadable for a
bounded two-second settle window: each stamp read that finds a source missing re-reads
every 100 ms first, because git's checkout unlinks a modified file before writing its
replacement. An install that only edits stamped sources therefore reads as
`source-changed`, never as a deletion or a refusal (tap-conft M17, the 21:58Z install). The loop's
process signature is `watch-run.ts run`; `tap health`, `tap remind` and a concurrent
`tap watch on` match a recorded watcher command against that signature only, so no
other command names a live watcher. `tap watch on` (and the reminder queue's own
spawn) refuses a Bun below the loop's floor BEFORE the window is opened or the
watcher PID/signature fields are written, and the window runs the loop under that same Bun by absolute path — the
executable whose floor was checked, never a bare `bun` for the window's PATH to resolve.

An iteration already in progress may finish using its loaded functions. Installing
this guard does not retrofit an already-running pre-guard process: restart that
sidecar once after the first sync. Later source changes are detected by the loop.
All three persistent loops are Bun processes, and the stamp covers each one's own
module closure (plus `lib.sh` and `style.sh` for the spool waiter and the watch loop). The goalie
heartbeat checker is one-shot; each cron or LaunchAgent invocation loads fresh code.

`tap watch` is the per-team liveness sidecar: a zero-token loop that detects silent deadlock, probes a wedged team up an escalation chain, and (via the evaluator) judges completion — all from observable state on the bus. It is opt-in and above transport (§Transport/supervision boundary); the courier is untouched.

**Default escalation order.** The live chain is ordinary stopped seats by recency → the active stopped `goalie` seat → the terminal lead → human/machine escalation. The goalie is removed from the recency sort and inserted immediately before the terminal, so its cheap local judgment chance is deterministic rather than an accident of tmux activity. An explicit `--chain` remains an explicit authored order.

**The arm record IS the lease.** `tap watch on` writes `$TAP_HOME/watch/arm.json` under an exclusive lock; its **presence as a regular file means the team is armed** — a directory or a fifo at that name is read as "no lease" without being opened (a fifo would block the reader), every writer refuses to publish over it (`is not a regular file; refusing to read or publish it`, exit 1, under the lock) rather than creating past it, and `off`'s locked delete removes the stale publish temp before the lease so a "lease KEPT" report always has the lease on disk. Deleting it releases the lease, and the loop's next tick exits cleanly — so `tap watch off`, `tap team reset` (which archives `watch/`), team disband, and bus migration all reap the loop **by deleting state**. No separate stop signal, no orphan. 

Every `tap watch` and reminders-service writer of the record — the arming write, the tick's compare-and-set updates, pause/resume, `off`'s delete, and the minimal-arm writes — serializes on `watch/arm.json.lock`; the wait is bounded at 120 s and a lock path that is a symlink is refused rather than followed, both reported as an error distinct from "no lease" and "stale generation". `tap teardown`'s per-handle `blocked_map` prune and `tap restore`'s merge take that same lock through the lease module's `prune-handle`/`restore-handle` actions (the goalie record's `seats` slices ride the same mutator under `goalie/arm.json.lock`); a `blocked_map` stored as a JSON string — the shape every watcher-written record has — is pruned and restored as such, where the earlier in-place rewrite recognised only an object and so never fired on a real record. 

One inherited path still writes outside the lock and is not covered by this sentence: `tap team reset`'s post-checkpoint cut removes the whole `watch/` directory — lock file included — with `rm -rf` (tap-nlxce's remaining half; the reset transaction owns it). Fields:

| Field | Meaning |
| --- | --- |
| `armed_by` | the arming handle (the terminal seat by default) |
| `armed_at` | arm epoch — the silence-clock **floor** (R8) and the re-arm nonce (re-read before every side-effect) |
| `silence_floor_at` | latest arm/resume/pause-expiry epoch used only as the silence-clock floor; resetting it starts a fresh probe window without changing `armed_at`'s lease nonce, but it is excluded from genuine activity used to recognize a delivered-probe response |
| `paused_by` / `paused_at` / `paused_until` / `pause_reason` | bounded armed-pause provenance; zero/empty means running. Pause suppresses only the silence escalation chain until `paused_until`; default duration is 4h and an explicit duration is capped at 7d with a stderr warning. |
| `done_when` | the run's completion test, checkable from observable state (R20) |
| `threshold_seconds` | silence threshold before wedge-suspect (default 1500 = 25 min) |
| `probe_timeout_seconds` | delivered-probe rung cadence and queued-probe delivery deadline (default = one threshold) — never the tick interval |
| `tick_interval_seconds` | loop sleep between ticks (default 60) |
| `evaluator` | `codex` \| `none` — the one-shot judgment rung (a `claude` headless branch is a deferred follow-up) |
| `chain_overrides` / `terminal_seat` | escalation chain overrides + terminal (the chain itself is computed live at tick, R7). Overrides constrain ORDER among **probe-worthy** seats — those with positive stopped-or-stuck evidence (idle-at-prompt, blocked-on-approval, rate-limited-error, wedged) — never eligibility; a working or unclassifiable (unknown) seat named in an override is skipped, not probed out of turn (tap-cqn). |
| `consent_transcript_egress` | recorded truthy when a non-`none` evaluator was armed (pane-transcript egress consent) |
| `current_rung` / `last_probe_at` / `evaluator_calls` / `episode_started_at` | live episode + budget cursors, advanced by tick (R9/R10/R13) |
| `probed_seats` / `queued_probe_id` / `queued_probe_seat` / `carried_probe_seat` / `carried_probe_at` | the escalation rung is keyed by seat IDENTITY, not position. A `0/queued, delivery=spool` probe is added to `probed_seats` once and its exact id/seat are retained while parked; no second probe is minted and `last_probe_at` remains zero until that id reaches canonical/settled state. The watcher acquires the entry's shared drain claim before resolving spool/canonical/settled state, so a failed submit must finish re-spooling before watcher ownership can clear. Queued-to-carried and later carry mutations are compare-and-set writes guarded by the snapshotted `armed_at` plus expected queued id or carried seat/timestamp; a stale tick cannot merge old courier state into a fresh arm, including a same-second rearm. The response clock begins at that stable observed transition. Genuine bus/repository activity resets the carried response, while pause/resume's administrative floor does not; delivery stores `carried_probe_seat`/`carried_probe_at` until fresh-episode initialization consumes them into `probed_seats`/`current_rung` and the original response timer. Explicit rearm/disarm clears the whole lease. Legacy `consecutive_defers`/`defer_seat` fields may remain in an older arm record but no longer drive a v0.7 ladder. |
| `watcher_pid` / `watcher_command` | the loop's process signature, so `tap health` reports a dead watcher on an armed team (AE10). With `heartbeat_at` they also feed `tap watch status`, which reports the dispatcher `alive`, `dead` or `unknown` beside the armed line (tap-zpmvx); `unknown` means the lease could not be read or is not a JSON object, the process table could not be read, the recorded command is missing or not a known watcher signature, or a heartbeat or arm time lies in the future, and is never reported as dead; a respawn stamps `heartbeat_at` with the spawn time so the replaced loop's heartbeat is not read as the new pid's silence |
| `blocked_map` / `blocked_exempt` | per-seat blocked-seat classification (see below): `blocked_map` is `{handle: {reason, since, reset_at}}` for seats currently blocked (`reason` is `session_limit` \| `api_error`); `blocked_exempt` is the array of handles that already used their one resume/retry nudge and must never be reclassified off the same stale evidence. `blocked_map` is stored as an opaque JSON-string value (not lib.sh's array-only `JSON_KEYS` — it is an object, not an array; `tap-watch.sh` owns its shape). Both cleared by `tap watch on`/`--rearm` and by a genuine (real-activity) episode reset — never by the per-seat timer pass itself (see below). |

