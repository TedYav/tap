# Spool — source part 1 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

**2026-09-20 retirement:** The dormant native owner, its spawn functions and
`migrateLegacySpool` have been removed. The future-startup statement in the
preserved source below is superseded. Public spool inspection/cancellation,
existing diagnostic records and the live pair/drain path keep their contracts.

**2026-09-30 publication guards (tap-ahpdi, tap-u708y):** `publishPair` refuses a
lock name the filesystem cannot hold (a 245-byte id) before writing the body, leaving
no orphan. A non-regular `<id>.meta.json` is absent: fresh mint, and the rename replaces
it; the incumbent hung on a FIFO, so this is a declared narrowing. A non-regular
canonical still refuses.

**2026-09-22 drain ownership:** `spool-drain.ts` owns the three drain phases,
retirement ordering, windows, capped visits and deadline dispatch. The existing
native waiter, watch spool pass, explicitly scoped registration recovery and Bash
compatibility names all reach this owner. `spool-drain-effects.ts` drives the existing
digest transaction and sender notices. Native `spool-readiness.ts` gathers lazy
paired captures; `observe-gather.ts` owns bound identity for spool, nudge, provenance
and retained shell entrances. Worker context stays on the selected bus. Reads honor
the same explicit tmux namespace as effects. Spool flash, orphan cleanup and watch
tint call the native pane-effect owner and tmux transport directly. The locked submit/custody unit
remains in Bash: the prevalidated native outcome table arrives before any effect,
and the same shell applies custody immediately after submit. This preserves the
incumbent failure window; it does not promise atomicity across arbitrary SIGKILL.
Missing callback evidence never certifies delivery. The Bash-drain ownership claims
in the preserved source below are superseded; queue schemas and inspection boundaries
are unchanged. The diagnostic `legacy_bash_parks` key remains compatible, with detail
`Shared spool parks; use tap cancel --spooled`.

**2026-09-25 OpenCode shell mode:** the first observed `busy:shell-mode` readiness probe publishes one durable sender alert per payload and holds the queue without input effects. The alert is deduplicated by its deterministic notice ID; held mail can resume after the composer returns to chat. See [shell-mode containment](per-harness-submit-verify-table-courier-owned-documented-here.md#opencode-shell-mode-containment-2026-09-25).

<!-- tap-source id=source-0094 start=625671 end=634636 sha256=06457cd0e43510db4cf33b2b3a272f83721c7a03bb3a040aaa3aacf6c90eea71 fragment=1/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Spool

Retryable `tap send` parks are durable exit-0 acceptances. Metadata keeps its existing fields plus `policy` (`standard|polite|urgent|autosettle`), `deadline_epoch`, `hold_until_epoch`, and `target_registry` (the exact registry path bound by the originating send); it has no phase/warn state.

### Native `tap spool`

Native `tap spool` is an additive inspection and sender-cancel surface over CourierIntent records. It does not replace bash park/drain and does not start the owner. Native send/reply use the shared spool pair and native waiter over the retained Bash drain engine for deferred delivery. Public `done` is a retired tombstone. An earlier owner attempt is not part of this path.

**Dark boundary.** Spool stays non-draining: `list`/`status`/`cancel` never open `owner.lock` and never spawn an owner. The documented argument/authority fallbacks still apply. Dead-owner status points to `tap spool list --json` for inspection and states that no public owner restart command is available; it does not advertise `tap spool kick`, which is not a CLI verb.

**Inspection is effect-free on delivery state (Fable ruling, option B).** Public `tap spool` verbs never rename, adopt, or normalize live bash `spool/<id>.md` + `<id>.meta.json` pairs. Those parks stay on the bash drain and are withdrawn with `tap cancel --spooled`. Native verbs cover native intents (and malformed native slots) only. `migrateLegacySpool` runs only at future native-owner startup, never on a verb path. When live bash pairs exist, `list` emits one extra JSON row `{class: "legacy_bash_parks", count, detail: "Bash drain owns them; use tap cancel --spooled"}` so an empty native list is not a lie; `status` carries `legacy_bash_parks` / `legacy_bash_parks_note`. `cancel` of an exact bash pair refuses pre-effect: `Bash park — use tap cancel --spooled`.

**list** `[--json] [--from <handle>]` — JSONL of unsettled live intents (and malformed-mail report rows). `--from` filters live intents by sender; malformed rows are excluded by that filter. Does not drain.

**status** `[--json]` — counts live intents and malformed slots, the live bash-park census (`legacy_bash_parks` / `legacy_bash_parks_note`), plus diagnostic `owner.json` liveness. Never opens `owner.lock`.

**cancel** `<id> [--by <handle>] [--json]` — sender-only withdrawal of a live (or malformed) parked native intent. The calling actor must be the bound sender. Writes `receipts/<id>.cancelled` with `reason=spooled_withdrawn` (or `malformed` for a quarantined slot) and drops the intent. With `--json`, stdout is exactly one copy of that receipt object; without it, success is silent. Distinct refusals for `.done` (`already_settled`) and `.cancelled` (`already_cancelled`). An exact live bash pair refuses pre-effect (`legacy_bash_park` / `Bash park — use tap cancel --spooled`) and does not take the obligation lock. Does not inject. `tap cancel --spooled` remains the bash sender-side escape hatch on the bash drain; native `tap spool cancel` is the native-intent equivalent.

**`waiter_lifetime` is a SEPARATE field from `deadline_source`, and the separation is load-bearing (tap-w4f7).** They answer two orthogonal questions about the same deadline. `waiter_lifetime` says WHICH CLOCK KEEPS THE DETACHED WAITER ALIVE — the bounded `runtime/bun/src/spool-waiter.ts` retries to that deadline instead of expiring on its historical fixed cadence. `deadline_source` says WHAT HAPPENS WHEN THE DEADLINE ARRIVES — it, and only it, gates the sender-wake + terminalize pair. Values of `waiter_lifetime`: `readiness-gate`, `autosettle-hold`, `grace-window`, and `window`; an empty value keeps the fixed cadence, while a window-bearing polite park can acquire `window` lifetime. A **pending-input grace park carries `waiter_lifetime=grace-window` and NO `deadline_source`**, which is the whole reason the fields are separate: it needs the waiter to survive to its grace deadline, and it needs the OPPOSITE disposition there — force-deliver through backup/clear/submit, never give-up-and-terminalize. While the two facts shared one field the grace class could express neither, so it carried no marker at all and its waiter expired ~29s before the 60s deadline it existed to enforce; the entry was then neither delivered nor failed, which is the starvation tap-w4f7 records. **Compatibility:** an entry parked before this split has no `waiter_lifetime` key, and a reader that finds the key ABSENT falls back to the old `deadline_source` predicate — absent is not the same as present-and-empty, and treating it as such would shorten every in-flight waiter across an upgrade.

**`policy=autosettle` parks run on TWO clocks, because the two events mean opposite things.** `hold_until_epoch` (stamped once from the last verified recipient delivery plus the effective window, or due now without a usable clock) expiring means DELIVER NOW — the coalescing window is over. `deadline_epoch` (`hold_until_epoch +` the busy tail) expiring means GIVE UP: the sender is woken with `delivery-failed` and the entry is terminalized, exactly as a readiness-gate park is (`deadline_source=autosettle-hold`). A single clock would turn a merely-busy pane at the end of the hold window into a delivery failure for mail that had not yet been offered to it. An autosettle park never takes a solo per-id redelivery — the digest doorbell is its only delivery — and it is excluded from the persistent-backlog CONDITION, which names a wedged recipient and not a park made by policy against a healthy seat. JSON receipts use `status=queued`, `delivery=spool`, and include `policy`, `deadline_epoch`, and `action=deliver_when_clear_or_deadline`. Human receipts use `tap send: queued <id>`.

**Pane effects.** Best-effort presentation stores `.tap/bus/pane-effects/<pane-id>.json` before styling: `v`, `owner_id`, `pane`, `pane_id`, `server_epoch`, and `applied_style`. Effects on one pane reuse the machine-global pane-submit lock, so cues from different team buses cannot interleave. Restore unsets both temporary pane-style overrides and verifies their pane-level options are absent before deleting the token. Unknown identity or failed cleanup keeps the token for repair; a stale server generation may delete it without touching the recycled pane. Styling errors never alter delivery.

A sender holds the existing per-entry spool claim from before publishing the payload/metadata pair until it removes its pre-park canonical copy. The drain cannot move that published body back to canonical in the middle of sender cleanup. Publication errors propagate to the sender; a failed or incomplete pair never authorizes canonical removal. The sender reports `spool_publish_failed` with the canonical payload retained, or `spool_busy` if another actor already holds the claim. A canonical-cleanup failure reports the published spool state without claiming delivery. Handled failures release the claim; an interrupted holder uses the existing stale-claim recovery rule.

A spooled entry's filesystem lifecycle is `spooled -> redelivered | dead`; `spooled` is internal bus state, not a `tap send --json` status. Before an inject, a drain creates `spool/<id>.claim` with exclusive-create semantics; a competing drain skips it, and failed, completed, or stale claims are released/reaped. This prevents two watchers, deliverers, or foreground commands from injecting the same entry. `*.meta.json.lock` writer sidecars and stale claims are tolerated and reaped after the bounded critical-section threshold; PID information is diagnostic only. Every drain uses the stored `target_registry`; it never looks up a stripped target handle in the caller registry. Immediately before redelivery and again inside the shared submit helper at each pane effect, it re-reads that registry row and requires the full exact-session/designated-pane/boot/generation/harness conjunction plus equality with the spool's bound pane and pane id. A missing handle, changed row, restarted server, exited harness, or recycled pane stays spooled and releases the claim; no pane effect occurs. **Upgrade migration:** a pre-upgrade spool entry without `target_registry`, `pane`, or `pane_id` never takes a same-team grandfather fallback; it is parked with `reason=legacy_meta_no_binding`, which `tap outstanding` surfaces. It then ages out as `unrouted` after `deadline_epoch + TAP_SPOOL_UNROUTED_GRACE` (default 1800s), or `first_spooled_epoch + TAP_SPOOL_UNROUTED_GRACE` when it has no deadline; an entry with neither clock remains parked rather than notifying on a guess. Age-out promotes the body before removing the spool pair and truthfully tells the sender that no delivery was attempted. The shared drain redelivers when ready, force-degrades a timed-out `busy` entry, or escalates a timed-out `safety_gate`/currently-unsafe one. While an id exists in `spool/`, a fresh `tap send --id <id>` is refused before canonical placement with `error_class=spooled_id`, so a later drain cannot double-deliver. Terminal refusals (denylisted/unsupported pane commands) never enter the spool; they exit 1 with `error_class=unsafe_target|unsupported_harness action=escalate`.

**Failed OpenCode capture holds delivery (tap-kbv9y).** If either escaped or plain
capture fails, readiness treats the band as unavailable and returns `busy:booting`.
A failed capture never establishes an empty composer or admits a submit.
