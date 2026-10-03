# Cancellation (tap-pe56: dead obligations to vanished seats) — source part 2 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0130 start=842045 end=849419 sha256=66774fbc8ae8a37fbbd11d794dfd6fd641d8443e7d722766ca6ef8468ded9797 fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
- **Refuses canonical mail addressed to the current active instance.** Cancel checks the bound team registry's current state; if the target resolves as `active` or `launching`, the stamped recipient instance still matches, and the payload is canonical (`payloads/`), cancel refuses with `error_class=seat_active` or `seat_launching` — use `tap read`/`tap reply` to settle normally.
- **The retract window ends at DELIVERY, which an auto-settle hold does not shorten.** A `policy=autosettle` park is undelivered mail like any other, so the rule below applies to it verbatim: while it is held it is withdrawable with `--spooled`, and once its doorbell lands the spool copy is gone and `--spooled` no longer authorizes withdrawal. Settlement still requires the recipient; historical terminal receipts remain respected.
- **Undelivered (spooled) mail is withdrawable by its sender at any addressee liveness (tap-cm00).** A spool entry has not reached the recipient (§Crew unregister states this), so `tap read`/`tap reply` cannot discharge it *whatever* the seat's status: the private reply settlement primitive resolves ids against `payloads/`, and its `--payload` escape is shape-guarded to a `payloads/` parent. Applying the delivered-mail rule to undelivered mail left such entries with **no clearing path at all**. A parked entry addressed to a live/launching seat therefore refuses with `error_class=spooled_needs_flag` — a distinct class, never conflated with `seat_active` — naming `--spooled` as the remedy; passing `--spooled` withdraws it.
- **`--spooled` asserts residency and refuses `error_class=not_spooled` on a canonical payload.** This is load-bearing: without it the flag would be a blanket bypass of `seat_active` for delivered mail. The check runs before any registry lookup, so its answer never varies with seat state.
- **Only the sender may cancel.** The actor must match the payload's `from` field (`error_class=not_sender` otherwise). Under the v0.20 flip, the actor's CURRENT registered instance must also match the payload's stamped `sender_instance` when present — a handle match alone is not enough. When it does not match, the refusal's remedy is derived from TWO checked facts — does the handle hold a row now, and is the stamped instance still a tombstone in that handle's history — never from the row alone (tap-ye2n). Four answers: a live row **with** the instance in history means the path is closed rather than absent (`tap out <handle>` then `tap in <handle> --restore <instance>`); a live row **without** it means there is genuinely no remaining clearing path, and the refusal says so; **no row** means restore is available when the tombstone exists and unavailable when it does not, stated definitely rather than deferred to the reader as a lookup; and a history that could not be READ is its own answer (`tap in <handle> --list-history`), never folded into "not there". The refusal never repeats the exact command that produced it, and **never puts a destructive step in `next:`** — `tap out` removes whoever holds the handle at that moment, so the action field names the look (`tap team`) and the sequence rides the prose. The same resolver serves the handle check, so a remedy is never recommended that the instance gate will reject one refusal later; a non-sender receives the diagnosis, never the sender's door as a command.
- **Archives the payload** to `<TAP_HOME>/archive/<id>.cancelled.md`, from **either** residency — removed from `payloads/`, or from `spool/` along with its `.meta.json` and any `.claim` sidecar. Removal (not the receipt) prevents later drain delivery and lets the watch sidecar's parked-spool tint clear: that tint is reconciled from spool **file presence** each tick (§Supervision), so an entry left on disk keeps its pane tinted regardless of any receipt beside it.
- **Writes `receipts/<id>.cancelled`** with `via=cancelled`, `target`, `target_status`, `registry_checked=bound_team_registry`, and a `reason` distinguishing `seat_unresolvable` (the recipient is gone), `instance_retired` (the stamped recipient instance differs from its current row), or `spooled_withdrawn` (the sender withdrew undelivered spool mail). Provenance never claims the recipient settled — a `.cancelled` receipt is distinct from `.done` in every field.
- **`--json` structures refusals too.** `error_class` is emitted on the abort paths, not only on success, so a machine consumer can branch on `not_spooled` / `spooled_needs_flag` rather than parse prose.
- **`tap_is_done` treats `.cancelled` as terminal, without claiming recipient settlement** — the id drains from `tap outstanding` exactly as a `.done` would. The receipt's `via` field is the provenance distinction: `read` (addressee read a note; historical `done` receipts remain valid), `reply` (addressee replied), `courier-auto` (a historical settlement written by an earlier courier release), or `cancelled` (sender withdrew the obligation for the recorded cancellation reason).
- **An ABSENT recipient registry is an ANSWER; an UNREADABLE one is not (tap-fcd3).** When the payload carries `to_team`, cancel consults that team's registry. If the team resolves through the index but **nothing exists at its `registry_location`**, the recipient is treated as `gone` and cancel proceeds with `reason=seat_unresolvable` — a deleted authority file is the strongest available evidence that no seat can ever settle the mail. If the file is present but unparseable, or the location cannot be resolved at all, cancel still refuses (`unreachable_team` / `registry_error`), because that is genuinely unknown rather than an answer. Absence binds **no** registry, so it never becomes a path to the sibling-registry rescue that `tap_authority_context` refuses. The distinction lives in cancel rather than in `tap_authority_context` on purpose: `tap send` and `tap reply` consume the same helper and their polarity is correct as-is — an unobservable recipient team is a reason to refuse to send, however it became unobservable. Both refusals name a remedy runnable **from that state** (repair or remove the named file — removing it makes it absent, which cancels); `tap doctor` is not, since it cannot repair another team's registry.
- **Registry race note (tap-el5v coordination):** cancel snapshots the registry's current state. A rebuilt seat (via `tap admin rebuild-registry`) can reclaim a handle, so cancel does not guarantee the seat stays gone — it guarantees the sender observed it gone at cancel time. The `registry_checked` field names the source consulted.

Cancellation also holds the existing per-ID spool claim, acquired without stale
claim takeover before terminality or residency checks. The obligation lock stays
held as well. Contention with an in-flight redelivery or reader makes cancel
refuse with `obligation_busy`, including a digest publisher holding its members
through submission. A bare competing claim without an obligation holder instead
refuses with `spool_busy`. Cancellation never releases another writer's claim. After
acquisition, cancel retains the claim through archive, spool cleanup and the
`.cancelled` receipt, and releases it on success, refusal or error. This prevents
a live withdrawal from racing promotion and reporting `spooled_withdrawn` for a
message concurrently delivered by the drain. Historical delivery receipts remain
valid evidence; cancellation does not erase them or authorize resend.


**Dead-letter withdrawal (tap-s1dqn, tap-sr6da, tap-bm4om).** Three callers withdraw canonical mail no seat can settle, using health's classifier and classes: seat_gone, team_gone, instance_retired (§Health).
- **Ordinary seat retirement.** `tap out` and `tap out --kill` withdraw the departed seat's unsettled local inbound once the retirement stands. It runs after publication with no lock held, and for `--kill` only after a successful stop (a failed stop restores the row). Crew unregister, `--forward-to` and team out do not withdraw.
- **Operator sweep.** `tap cancel --dead-letters [--dry-run] [--team <name>] [--json]` withdraws every dead letter on the selected bus. Each row names its `class`; the JSON carries `by_class` counts, and the text output prints a `by class:` line. `--dry-run` resolves the same targets and fence and writes nothing. An incomplete bus registry refuses `registry_error` (team selection refuses an absent or old-format one first).
- **Team retirement.** `tap admin retire <team>` withdraws only the retired team's identity-fenced inbound. Under the team's registry sidecar lock it captures each row's `instance`, but only from a registry complete enough to be dead-letter authority for that team (its own `team.name`, object rows, valid forwardings; otherwise nothing is captured or withdrawn), then de-enrolls only the entry it inspected. A busy sidecar refuses `registry_busy`, and a changed root or `registry_location` refuses `enrollment_changed`; both remove nothing. It then withdraws only payloads on that team's bus that meet all of these conditions:
  - `to_team` is empty or the team itself;
  - the payload is not a manual relay;
  - its `recipient_instance` equals the captured instance of `to`.
  Unstamped or mismatched mail stays. A failure is reported on stderr and never undoes the retirement; JSON carries `withdrawn_inbound` when nonzero.

**Withdrawal locks.** Each withdrawal takes these locks in order:
1. its obligation lock;
2. shared reset custody;
3. the registry lock(s): the bus registry, plus the addressed team's registry file when it differs and its directory exists;
4. the index writer ladder, in one attempt without waiting.

Under them it re-proves team selection and re-decides terminality and the verdict from fresh reads. A seat registered meanwhile, or a team re-enrolled meanwhile, keeps its mail (`recipient_not_gone`). A verdict that now reads a registry the withdrawal did not lock keeps the mail (`registry_moved`). Both are benign skips: `ok:true`, exit 0. A busy lock (`obligation_busy`, `registry_lock_busy`, `index_lock_busy`) or an unavailable index ladder (`index_unavailable`) is a skip that exits 1. An unreadable `payloads/` refuses `payloads_unreadable`. A failing step stops the batch; the result names every receipt that landed.

**Receipt.** The receipt is the existing `.cancelled` shape: `via=cancelled`, `source=payloads`, and `by` naming the verb (`tap out`, `tap cancel --dead-letters` or `tap admin retire`). The class sets the remaining fields:

| Class | `reason` | `target_status` |
| --- | --- | --- |
| seat_gone, team_gone | `seat_unresolvable` | `gone` |
| instance_retired | `instance_retired` | `replaced` |

`registry_checked` names the evidence: `bound_team_registry`, `foreign_team_registry (<team>)`, `machine_index (<team>): not enrolled|historical`, `foreign_team_registry (<team>): absent at <path>`, or `machine_index (<team>): retired by tap admin retire`. The payload stays in `payloads/`; no notice, delivery or pane effect.

**Unverified canonical custody (tap-43l9n).** A canonical body with orphaned spool
metadata, no spool body, no marked pending repark, and no sent/read/settled or
harness-queue receipt is not proven delivered. The same is true after the reaper
records its `.unconfirmed` disposition and retires that metadata. Outstanding
reports `status: unverified`, `effect: possible`; show and cancel use the same
classification. The matching sender may explicitly withdraw it with `--spooled`;
archive-before-remove and sender-instance checks still apply. The receipt reason
is `unconfirmed_withdrawn`, and prior recipient effect remains unknown. This
exception does not make ordinary canonical mail withdrawable with `--spooled`.
Positive delivery/read receipts keep that refusal. Cancellation preserves prior
attempt, phase and unconfirmed receipts and never authorizes a retry.
