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

Codex's startup update menu is `blocked/codex-update-available`, including the
narrow picker that shows only one selected choice. Its heading, selected option
and closing key hint must be present; a composer after the menu supersedes it.
The menu outranks a stale spinning pane title. It is not an approval request:
approval-timeout has no deny key for it. Diagnosis and roster display do not
dismiss it or install an update. Launcher readiness and licensed courier
delivery may [choose Skip once](../delivery/default-deny.md#codex-update-skip)
and continue only after proving an empty composer on the same pane.

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

## Named-seat diagnosis

`tap doctor <handle> [--json]` observes one seat in the resolved team's acting
registry. It shares the roster's lifecycle observer, `detectAgentState` and
`rosterActivity`; it never repairs state, creates a bus or sends pane input.
Bare doctor retains its bus report and repair/prune grammar. A handle combined
with `--fix` or a prune option refuses before effects.

The report carries `scope: "seat"`, `handle`, `verdict`, `evidence` entries
(`source`, `fact`, `value`), `not_checked` strings, ISO `sampled_at` and `action`.
`ok` means exit 0; it does not assert that optional instruments all worked.
Input/authority refusals retain the standard error envelope. A failed pane or
lifecycle observation has a null verdict and exit 1. Successfully observed but
unrecognized state is `unknown`, exit 2. Positive lifecycle absence is `gone`,
exit 2. Captures are name-proven and checked against the server generation and
unchanged registry binding; a stored pane id alone is not authority.

Shared `blocked` maps to `parked-on-dialog` and `error` to `severed`, with the
specific rule in evidence, exit 2. `severed` includes provider/usage failures;
it does not claim a network cause. OpenCode shell mode retains its `shell_mode`
reason and asks the operator to leave shell mode, not answer a permission prompt.

For a usable or working seat, a current-instance, non-forced read/settlement
after an unconfirmed delivery refines the answer to `unverified-but-processing`.
It does not erase the courier's uncertainty or prove that the requested work
finished. Live background work or a harness write during observation yields
`thinking`. A working screen without observed progress is `busy-unproven`.
Both prohibit inferring that interruption is safe. A supported idle composer
without contradictory running-turn evidence is `healthy`.

Busy-unproven raises attention (exit 2) when its session-bound harness last-write
age reaches `stallBoundSeconds` (600 seconds by default). This is the borrowed
readiness attention bound, not a validated wedge threshold. Missing, mismatched
or future-dated file evidence stays not checked; it never becomes an old write.
OpenCode's last-activity reader includes in-place message updates as well as
creation/completion. Session-bound transcript reads verify the registered session;
a path alone does not establish that another session's activity belongs here.

There is no positive `wedged-mid-turn` verdict in this version. A silent long
tool call can have the same frozen counters, queued messages and unchanged
store as a hung request. The wedge discriminator remains explicitly not checked;
no age, missing receipt or animated spinner licenses an actuator.

The roster's external compute-queue command can initialize or migrate its own
database. Seat doctor does not invoke it: compute activity is explicitly not
checked, while pane-visible background shells and terminals still count as work.
