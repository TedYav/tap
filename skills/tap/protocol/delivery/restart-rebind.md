# Parked mail after a seat restart (tap-03rfq, 2026-10-01)

Courier-owned; a sibling of the [spool](./spool-part-01.md) and of [instance retirement](./cancellation-tap-pe56-dead-obligations-to-vanished-seats-part-01.md).

`tap session restart` (and any rebind) keeps a seat's registry row and its `instance`, and moves the row to a new pane. A park records the pane it was made for (`pane`, `pane_id`), so after the restart its binding no longer matches the row: readiness reads it as `gone`, and instance retirement never fires because the instance did not change. Before this rule, such a park sat until a deadline, or forever once escalated.

Every drain pass settles such parks before Phase A plans digests by pane. A park is a candidate when it is not escalated and its target's current row on the park's `target_registry` is `active`, pane-delivered, not `launching`, carries a `pane` and `pane_id`, and differs from the park's binding in either field. A pending row (a restart in flight), an inactive or missing row, and a row on another team leave the park untouched. The lookup is keyed on the target's row, never on the old pane id, so another seat now holding that pane id is never a candidate.

| The park | Outcome |
| --- | --- |
| Payload `recipient_instance` differs from the row's `instance` | Untouched: a different seat on the reused handle. Instance retirement owns it. |
| Same instance, and the no-effect proof passes | **Re-bound**: `pane` and `pane_id` take the row's values, `rebound_from` records the old pair, and the force-authority probe counters (`busy_live_probes`, `busy_pending_probes`) are dropped because they counted looks at the old pane. Attempts, fence, deadline and window are unchanged. The event is `spool_rebound_restarted_seat`. Ordinary delivery follows, through the courier's bound-identity guard on the new pane. |
| The no-effect proof fails (any attempt count, attempt or delivery evidence, a missing fence, unreadable evidence, a native intent) | **Terminal**: promoted to `payloads/`, event `spool_terminal_seat_restarted`, and a `DELIVERY UNCONFIRMED` notice to the sender. No retry after a possible effect: the body is never typed into the new pane. |
| No `recipient_instance`, and the no-effect proof passes | **Terminal** with a `NOT DELIVERED … was never attempted` notice: nothing can prove the new pane is the same seat. |

The no-effect proof is the one `tap nudge` requeue uses: zero recorded attempts behind the pre-attempt fence (`attempt_fence: 1`), no native intent, and no `attempted`, `attempts`, `idle-submit`, `unconfirmed`, `sent`, `read`, `harness-queued`, `done`, `cancelled` or `resent` evidence under `receipts/`, `payloads/`, `spool/` or `archive/`.

Custody follows the requeue order: the obligation lock, the no-steal spool claim, reset custody, then the metadata lock. Every leg is re-read under custody before the write. A busy lock or claim leaves the park for the next pass.

A terminal park is settled in three steps, each of which can hold it for the next pass. First, a canonical `payloads/<id>.md` whose bytes differ from the parked body holds the park for a human, because promoting it would discard the only original. Second, the sender notice is published as durable custody under the deterministic id `<id>-seat-restarted`, so a poll or offline sender still receives it, and a retry finds it instead of waking the sender again. Only a published notice permits promotion; a courier notice or self-addressed mail has no one to tell. Third, the body is promoted, and the canonical comparison is repeated under reset custody.
