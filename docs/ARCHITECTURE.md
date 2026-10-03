# TAP three-layer architecture

**Status:** ratified 2026-07-11, updated for the v0.20 acting-registry cutover on 2026-08-04. This doc is the living package map.

## The three packages

| Package | Owns | State | Slash surface |
|---|---|---|---|
| **tap-core** | Protocol, envelope, courier/inject, bus, receipts, acting team registry + global locator, spool redelivery, pane/tmux liveness primitives, semantically-dumb watch machinery (timers, leases, probe sends, blocked-seat classification, `peek`/`health`), `escalate` as a direct notifier invocation (reaches the human, not a seat) | per-team `.tap/bus` + `.tap/team-registry.json`, `~/.tap/global-registry.json`, watch arm records on the team bus | `/tap-*` (ruled: transport-only) |
| **tap-launcher** | Harness wrapping, tmux session launch/resume/restart/repair, pending-reservation *creation*, and direct harness-session identity capture | no separate durable store; current launch/session fields live in the acting team-registry row | `tap session <verb>` CLI nouns |
| **tap-orchestrate** | done_when interpretation, evaluator-model invocation + verdict schema, escalation *policy* (who/why), gates, waves, writer tokens, lead/driver/peer doctrine | none durable today (M1 decides the Run manifest) | bare orchestration verbs (ruled: `/tap:lead`; `/tap`) |

**Dependency arrows (inviolable):** `tap-launcher → tap-core` and `tap-orchestrate → tap-core`. Core imports, invokes, and semantically knows NOTHING from the other two. Launcher and orchestrate never depend on each other.

**Landing test (constitution):** lead/run/wave/goal/convergence/writer-token ⇒ orchestrate · session/resume/harness-wrapping ⇒ launcher · payload/receipt/pane/handle/bus ⇒ core. If a feature needs two layers, split it at the seam; never add a policy flag to core.

**Diagnostics-read rule (D-arch-1, superseded in part by v0.20):** diagnostics and administration read the acting registry through core-owned helpers. There is no downstream launcher store to consult, and no launcher-history existence fact may gate a core operation. A new core verb that needs launcher-private state would therefore be a boundary decision and a proposed second authority, not a helper call.

**Pending-reservation ownership (D-arch-2):** `status=pending` and its expiry semantics are **core registry** concepts — expiry reads registry fields + tmux session existence, both core-observable facts. The launcher merely *creates* pending rows (launcher→core write via sanctioned path). `tap_pending_reservation_*` / `tap_registry_pending_expired` therefore stay in core's lib; `tap-send`/`tap-team` consuming them is core-internal, not a violation. Native implementations now live in `runtime/bun/src/pending-reservation.ts` (refresh/lib.sh clock) and `runtime/bun/src/reservation.ts` (launcher boot-aware expiry, consumed by `launcher/resume.ts`). Their clock contracts remain deliberately separate; the Python launcher implementation is retired.

**Watch templates (D-arch-3):** mechanical bodies (settle = seen; blocked-report to the armer; no run narrative) are core machinery. `evaluate-prompt.md` and `evaluator-verdict.schema.json` are orchestrate, because they judge done_when. Arm-time template override is the escape hatch. Default templates are core machinery. CONTRACT may cite D-arch-3.

**Harness identity capture seam (D-arch-4, tap-4hn + tap-3xw3):** direct native session identity enters through the harness-local SessionStart adapter. Core `tap register` / `tap in` may copy an attested harness-provided id into the acting registry because that is core-owned seat provenance; the hook performs no second-store restamp. OpenCode has no SessionStart-equivalent hook today, so plugin-provided identity from a manual bare `tap in` stamps the acting row when available and otherwise leaves native picker/latest behavior to the harness.

## File ownership map (operative surfaces)

- **core:** `skills/tap/scripts/` — dispatcher `tap.sh`; verb scripts `tap-send/reply/done/poll/outstanding/register/unregister/whoami/nudge/reset/roster/team/init/setup/doctor/peek/health/escalate.sh`; `lib.sh`; registry helpers; `tap_frontmatter.py`; watch machinery in `tap-watch.sh` (minus evaluator block); `watch-templates/{probe,continue,notice}.md`; `skills/tap/SKILL.md`, `GUIDE.md`, `QUICK-REFERENCE.md`, and compatibility `USAGE.md`; the `/tap-*` shim skills and `/tap:escalate`; the one-page CONTRACT plus detailed `skills/tap/protocol/`; transport/liveness/watch smokes.
- **launcher:** `runtime/bun/src/launcher/`, and the native session dispatcher in `runtime/bun/main.ts`. Coverage lives in `runtime/bun/test/launcher-*.test.ts`, the native session/completion suites, and session-* smokes. Surviving shared Python helper tests live in `skills/tap/scripts/tests/`. The launcher adapts acting-registry rows into its in-memory value object; it owns no shell-side state-reader library.
- **orchestrate:** `skills/tap/`, `skills/lead/` (repo skill, symlinked into agent homes by install.sh; was `/tap:drive`), evaluator block of `tap-watch.sh` (`_watch_evaluate`, `_watch_invoke_evaluator`, `_watch_write_evaluator_prompt`, `_watch_normalize_verdict`, `_watch_observable_state`, `_watch_transcripts`), `watch-templates/evaluate-prompt.md` + `evaluator-verdict.schema.json`, `watch-evaluator.test.sh`.
- **neither (meta/harness-local):** `bin/tap` + `scripts/tap.sh` shims, `install.sh` (single installer stays; skill list partitioned by layer), `.claude-plugin/`, `skills/self/` (harness-local; its `tap_submit_verify` use is a sanctioned neither→core call), beads hook + smoke README.

## Arrow violations found (tap-bfb inventory) and remedies

1. **`tap_watch_tick` (core) calls `_watch_evaluate` → evaluator model in-process** — the structural violation, and the evaluator's verdict path also *executes* `done:disarm`, so a JSON-only seam would leave that action unowned. **Parked,** with this recommendation: core keeps the mechanical pre-check + budget (unsettled-payload gate, ≤2 evaluations/episode) and executes an **allowlisted action opcode** returned in the verdict schema (`advance | notify_human | disarm`); orchestrate owns only prompt construction, model invocation, and verdict normalization, invoked as a subprocess/command resolved from the arm record. Absent evaluator ⇒ skip to the probe ladder (current `--evaluator none`). Explicitly rejected: sourcing an orchestrate `.inc` into the tick (packaging theater, not a seam); orchestrate deleting the lease or shelling into watch internals (wrong owner / arrow muddle).
2. **Historical core reads of the launcher store** — resolved by the v0.20 acting-registry cutover. Admin, doctor, lifecycle, and routing no longer consult a launcher-owned session file; the migration command is the sole legacy reader.
3. **Historical launcher helper group in `lib.sh`** — retired with the same cutover. Current state helpers are registry-owned, and the former shell library no longer exists.

## Current boundary status

The v0.20 acting-registry cutover discharged the launcher-store boundary debt: runtime has one current-seat authority, and old stores are refused as `old_store` rather than migrated. The evaluator seam (violation 1), dispatcher sub-dispatch, separate install targets, and any physical directory re-homing remain separate boundary decisions rather than incidental cleanup in session lifecycle work.

## Lane choreography (pointer)

Multi-driver runs record scope and custody transfers explicitly in TAP work orders. The `tap lane` CLI is retired; retain its old manifests and collaboration ledger as historical evidence. See [worktrees and handoffs](../skills/tap/references/worktrees-and-handoffs.md) for current coordination rules.
