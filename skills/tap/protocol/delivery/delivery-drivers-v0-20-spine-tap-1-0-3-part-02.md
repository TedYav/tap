# Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 2 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0115 start=750519 end=757405 sha256=2b14374803c29d30367bb29b53e2c21e7885db3f768cd20a733bb040e914a10d fragment=2/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
Native delivery owns the dispatch: `resolveConfiguredDriver` (`runtime/bun/src/verbs/send.ts`) resolves the family's driver preference before parking and refuses an unusable or unwired one as a *pre-attempt* failure, and the courier (`runtime/bun/src/courier.ts`) mints the one-shot attempt marker `receipts/<id>.attempted` (`delivery-attempt.ts`) immediately before its first pane effect. Only the one-shot sender-notice wake (`notice-submit.ts`) writes begin and outcome rows to `payloads/<id>.attempts`. The diagnostic attempt row (`payloads/<id>.debug.attempts`) is labeled by `debug-capture.ts`'s `_attempt` writer from the attempt's status: `injected` → `delivered`/`possible`/`left-input-band`, `unverified` → `stop-ambiguous`/`possible`/`none`, anything else → `retry-next-rung`/`none`/`none`. When the attempt marker cannot be written, native submission returns `attempt_evidence_unwritable`, a hard failure the router never queues as a busy pane.

### Outcome: disposition, effect, tier

Three fields, derived from the attempt's status by the mapping above.

- **Disposition** (closed): `delivered | retry-next-rung | stop-ambiguous`. `retry-next-rung` requires `effect: none`.
- **Effect**: `none | possible`. `possible` means retry-unsafe.
- **Evidence tier**: an **observation** name, never a verdict word. `none` is the reserved record-level tier for "nothing was positively observed", and is legal on every disposition **except** `delivered`.

**`delivered` requires positive evidence.** tmux records `delivered` only on rc 0, with tier `left-input-band`. A `delivered`/`none` record would be a delivery claim with nothing behind it, and the conformance suite pins that no row produces one. This is invariant I-1: **a driver's success is evidence, never a receipt.** (The evidence-ceiling cap that enforced this for native drivers is removed with them; on tmux it was an identity, because the table's only `delivered` row already carries tmux's own ceiling tier.)

**The tmux driver's whole tier vocabulary is three words:** `left-input-band` (rc 0 only — the minted id was observed leaving the band AND the band was observed clear; the only tier that may carry `delivered`), `in-input-band` (reserved, unused, named so the rc5 split has no vocabulary left to decide), and `none`. `rendered-in-pane`, `socket-acked` and `api-accepted` were native-driver words; the tmux driver never emits them.

The rc mapping:

| rc | disposition | effect | tier |
|---|---|---|---|
| 0 | `delivered` | possible | `left-input-band` |
| 3 (pane gone) | `stop-ambiguous` | possible | `none` |
| 4 (deferred) | `retry-next-rung` | none | `none` |
| 5 (inject-miss or submit-unverified) | `stop-ambiguous` | possible | `none` |
| 6 (identity drift) | `stop-ambiguous` | possible | `none` |

Three of these rows carry a reason worth keeping:

