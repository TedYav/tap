# Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0116 start=757405 end=764099 sha256=987d4b22ccb7ca4f05c1ea4494353d83fd845bb53bbd0c9e2c2ff9b8aea586e7 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
- **rc 3 takes its worst arm.** It fires from three places with different effects, and the worst is reached only after the bytes were provably in the band and Enter was pressed — so `stop-ambiguous` is the honest read, not merely the careful one.
- **rc 6 is NOT pre-effect, and an earlier draft of this table said it was.** The claim rested on the fresh-inject call passing `identity_rc=5`, so that a post-Enter identity failure would return 5. It is false: `tap_submit_existing_verify` re-runs the identity guard **inside** its Enter retry loop, and the two stuck-sentinel call sites pass `identity_rc=6` — composed, a `6` can be returned with an Enter already delivered. Reproduced rather than argued (`rc=6 effects=1 guard_calls=2` in an independent gate review). The row is therefore conservative; `retry-next-rung` would let a router retry an attempt that already pressed Enter. The Bash rc table (`tapdrv_tmux_outcome`) and its structural check (`driver_rc6_premise.py`) were deleted with the Bash dispatcher once nothing called them (B2). `driver-rc6-effect-probe.test.sh` still measures the behaviour: `tap_submit_existing_verify` can return rc 6 after an Enter. **The general lesson outlives the row: a structural argument for a safety-relevant claim is a hypothesis, and a check that asserts the premise rather than the behavior greens on a wrong premise.**
- **rc 5 collapses two arms with different effects onto the conservative one** — inject-miss (nothing left the shell, effect truly none) and submit-unverified (landed observed, clear unproven). The helper separates them only in the PROSE of its stderr, and **parsing stderr prose for a routing decision is the bug class this layer exists to end; reintroducing it takes a ruling, not a patch.** The split lands when the helper grows a typed output (tap-ko9p9), at which point inject-miss earns `retry-next-rung`/`none` and submit-unverified earns tier `in-input-band` — both derived, neither guessed.

### The per-attempt result channel

Removed 2026-09-23. `TAP_DRIVER_RESULT_FILE` existed so a native driver could refine `tier`, `detail` and `native_ref` from its subshell. Now that tmux is the only driver, all three come from its static table and the dispatcher. `disposition` and `effect` were never refinable, and they still are not.

### The attempt log

Append-only `payloads/<id>.attempts`, one JSON object per line, written by the **dispatcher** — never by a driver, which needs no sequence allocator. Fields: `payload_id`, `seq` (per-payload monotonic; the record key), `rung`, `op`, `driver`, `class`, `disposition`, `effect`, `tier`, `detail`, `native_ref` (always empty: tmux has no native id; the field is kept so the record shape is unchanged), `ts_start`, `ts_end`. The **descriptor fingerprint** design-tap1-v2 §3.7 mandates (type + v + identity fields, never credentials) is deliberately absent from that list: no descriptor registry exists yet, so there is nothing to fingerprint. The condition is named here because the absence would otherwise read as a conflict against §3.7 rather than as a not-yet — the field joins the list when descriptors land (TAP 1.0 M1).

It is written **before the caller acts on the status code, including when the attempt failed** — especially then. A system discharge must cite this log to demonstrate exhaustion, and its red case is an unattempted rung; a defer that recorded nothing would be indistinguishable from a rung nobody tried. **A defer IS an attempt record.**

`detail` is **human text**: recorded, displayed, and never parsed by any routing decision.

Writing the log is best-effort. A bus that cannot take the audit line says so on stderr rather than turning a delivered message into a failed one.

### What a driver may never do

Write a settlement. `.done`, `.sent` and `.cancelled` are the obligation layer's, and the conformance suite asserts that the dispatcher produced none. Settlement is the only delivery truth (I-1), and the obligation layer must audit every driver identically (I-2) — a driver trusted enough to settle on its own behalf removes the only smoke detector the transport has.

