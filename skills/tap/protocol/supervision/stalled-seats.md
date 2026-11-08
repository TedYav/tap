# Stalled seats (`tap team --stalled`)

Normative TAP v0.23 protocol page. The roster's activity fields (`agent_state`, `turn_ended_at`, `turn_ended_source`) are owned by the roster JSON bullet in [structured failures and JSON output, part 6](../delivery/structured-failures-and-json-output-part-06.md); this page owns the stalled view built on them (tap-vl8cp).

`tap team [roster [<team>]] --stalled [--stale-after <secs>] [--json | --names]` lists the seats that show "everyone waiting on everyone". A seat is **stalled** when all hold:

1. `agent_state` is `idle`: not `waiting`, not `working`, nothing else.
2. `turn_ended_at` is dated by the transcript witness (`turn_ended_source: transcript`), not in the future, and at least N seconds old. N is `--stale-after`, a positive integer, default 600, inclusive.
3. The seat still owes an unanswered inbound ask or assignment.

## What a seat owes

Owed work is the INBOUND side, read by `pendingInboundAsks` (`runtime/bun/src/context-census.ts`), the reader behind `tap team --context`'s `pending_inbound_ask`. `tap outstanding` lists what a seat SENT and awaits; it is the other half of the same stall and is not read here. Asks and assignments (`reply: expected`, including `kind: order`) count. Settle-only notes, settled (`.done`) and cancelled asks, and asks for another team owe nothing. Who owes an ask is decided by the same addressee grant `tap poll` and `tap read` use (`addresseeGrant`), per idle seat: an ask stamped `recipient_instance` for a retired instance of the seat is its predecessor's, while mail an adopted or forwarded predecessor owned (addressed to the predecessor, or rewritten to the successor with `to_adopted_from`) is owed by the successor. A `reply` other than `expected` or `settle-only` is unsanctioned custody and no positive claim. Callers that pass no grant (`--context`, the watch stand-down reader) keep the plain `to`-seat reading.

## Unjudged is uncertainty, never a claim

No dated turn end is no stall claim. An idle seat that the evidence cannot decide is named in `not judged:` (JSON `unjudged: [{handle, reason}]`), never in the stalled list: reason `no_turn_end_date` (no transcript witness, null or future date, and the seat may owe) or `inbound_unknown` (dated and past N, but the inbound answer was unreadable: a registry the poll grant cannot read, unreadable custody, or an unsanctioned `reply` value). A positive "owes nothing" removes a seat from both lists, and a dated seat under N is decided already.

## Output

- Human: the roster table for the stalled seats, then `stalled: <n> seat(s) idle >= <N>s with an unanswered ask (of <m>)`, or `tap team: no stalled seats (idle >= <N>s with an unanswered ask)`; then the `not judged:` line when it applies.
- `--json`: the roster shape for the listed seats, plus per row `stalled: true`, `stalled_for_seconds` and `pending_inbound_ask: true`, and top-level `stalled_after_seconds` and `unjudged`. Without the flag none of these keys appear. `--names` prints the stalled handles only.
- Exit is 0 whether or not any seat is listed.
- Composes with a roster `<team>`, `--online`, `--offline`, the seat filters, `--json`, `--names` and `--context`. The filters narrow first, so only the seats they keep are judged, and `of <m>` and `not judged:` count only those. Refuses `--all` (it skips the state pass), `--stale-after` without `--stalled`, and bare `team list` (which enumerates teams, not seats).
