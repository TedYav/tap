# Agent state and input readiness

`error` means the last turn stopped on an API/provider failure, usage/rate limit
or stream disconnect and the same frame proves a usable composer. It renders
`error`; ordinary delivery, nudge and compaction may use the composer
subject to their existing draft and identity checks. `blocked` retains its
input-holding meaning: an approval, trust or usage-limit modal. An error
without composer proof retains the existing unknown/booting classification. A usage-limit dialog is blocked;
a usage-limit banner above an available prompt is error. Newer working or
completed responses supersede older error text. Quoted errors and quota
warnings do not establish a failed turn. `detectAgentState` owns this distinction;
roster enrichment retains error, routing exposes it, and the watcher maps it to
its existing `rate-limited-error` alert rung without changing ladder order.

Roster, delivery and readiness read the same `detectAgentState` rules.
`agentAtRest` admits only idle or error; it does not prove the composer is empty.
Existing draft, exact-input, identity and effect checks still apply.

Claude Code usage-limit footer text yields to a newer live spinner or interrupt hint.
A terminal Codex error may outrank a pane title left spinning by the failed turn.
Unproven error text does not create a modal or grant input authority.

Claude Code usage-limit menus remain blocked when their choices wrap across
terminal rows. Automatic nudge can dismiss only the captured menu layouts it
recognizes; attach to the session to handle other layouts.

`tap team doctor` runs session-binding and seat-state checks; `--only seat-state`
selects this read-only explanation. It uses the roster's shared observation,
including lifecycle and activity enrichment. Error and blocked findings retain
`agent_state` and `agent_state_reason` and suggest nudge or attach respectively.
Unknown pane states remain unchecked; poll and positively inactive seats are
outside this check. Visible findings suppress the global clean line. JSON keeps
the `{ok, bus, findings, summary}` envelope: `summary.clean` describes binding
integrity and `summary.seat_attention` counts blocked/error seats. A completed
scan exits 0.
`--fix` repairs session bindings only; `--fix --only seat-state` changes nothing.
