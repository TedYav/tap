# Wake tiers (transport, not progress)

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0111 start=738883 end=739982 sha256=3787414504666cbf5dec028b0702682e4fc6b935eeb6ca62143f1ed983cd3b8e fragment=1/1 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Wake tiers (transport, not progress)

- **Tier 1 (tmux):** `tap send` injects the sentinel → recipient's pane wakes. The courier owns pane-resolve (from registry, prints the resolved pane), the inject-safety predicate (a usable input band / not-copy-mode / pane-alive — the one sanctioned, fail-closed, per-harness heuristic; **mid-turn is not universally a refusal**, because every family except hermes queues typed input natively, so what the predicate asks is whether a band exists to type into rather than whether a turn is running — see the agy paragraph below, where reading a mid-turn pane as unusable cost a live false delivery failure), the per-harness submit+verify table, and verify+retry. "Verify" means **tmux accepted the paste / the sentinel id left the input line** — NEVER "the agent processed the message."
- **Tier 2 (no tmux):** the bus alone. TAP guarantees pending work is **discoverable by `tap poll`**; it does NOT guarantee autonomous progress without a harness self-wake (Claude `ScheduleWakeup`) or human relay. Stated honestly, not papered over with a timer.

