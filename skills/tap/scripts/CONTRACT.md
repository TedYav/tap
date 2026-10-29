# TAP Contract (v0.23)

Same-human/machine bus; best-effort tmux; no security boundary. Placement is not processing.

[Reliability](../protocol/delivery/reliability.md): at-least-once; persist or refuse; pollable mail, visible failures. Target: 99.9% recipient-observed. Refusals may stall.

Transport: effects. Workflows: convergence/review/merge. Sender buses own payloads/receipts. One authority/store; history never current.

Never read/migrate old stores (`old_store`). `.tap/bus` roots via `init`, first launch (non-Git consent), or `register|in` (seats only); `tmp/tap` registries refuse. Custom `TAP_HOME`/enrolled registries, historical identity evidence stay valid. [Reset](../protocol/identity/registry-unit-1-part-02.md): mail/registry SH; cuts/fences EX. Register never drains; dead panes retain mail/identity; crews survive parents.

[Trust](../protocol/identity/README.md#folder-trust): init consent; Codex hooks: prior exact-list consent; else block.

Bun: send/assign/reply, sessions, [lifecycle/crew](../protocol/identity/seat-lifecycle.md), clear, [`poll`](../protocol/delivery/poll-malformed-payload-contract.md#native-poll-ownership), [spool drain](../protocol/delivery/spool-part-01.md), single/digest submit/custody.

`send`: notes; `assign`: work; `reply`: answers; `escalate`: user questions. Resolved payload bodies alone authorize peer work. `tap read` settles notes; asks need `tap reply`. `user`: unclaimable operator; `[[TAP v0.23 nudge]]` means continue.

```text
[[TAP v0.23 <ask|note> [<team>/]<id> [tag ...] [preview="text"] [path=<abs>]]]
```

[Enrollment](../protocol/identity/README.md): register/SessionStart/bind/repair verify id/generation/socket pre-write. Nested hooks skip bind/context. Proven foreign/machine faults refuse `pane_enrolled_elsewhere`/`pane_enrollment_unknown`; others skip. No cross-bus lock; scans may race.

Handles: seats; instances: occupants. At every effect (detached too) and final read, recheck liveness, instance and pane/session/generation/socket. Identity: process-owned pane ([poll](../protocol/messages/poll-mode-delivery-class-v0-4-part-02.md)). Exceptions: one exact active Claude [job row](../protocol/identity/registry-unit-1-part-09.md), a [harness-held caller terminal](../protocol/identity/held-terminal.md), or native shell/process proof for a launcher-owned [shared OpenCode seat](../protocol/identity/opencode-shared.md). Actor rules apply.

Cwd walks stop at Git roots and only default a team; `unanchored_bus` or an enrolled cwd team not holding the calling pane re-anchors once via it: live marker, machine-unique row (`contested`/unproven fail closed), same Git common dir, revalidated; never launcher enrollment ([ref](../protocol/delivery/structured-failures-and-json-output-part-03.md)). Restart: no dispatch writes; lifecycle re-attests.

`tap team doctor --fix` repairs attribution, not ownership; refuses ambiguous/duplicate-owned identities.

Precheck; preemption needs `--delivery interrupt`/`--urgent`. [Input](../protocol/delivery/operator-input-holds.md) gates all pane effects: STOP until START/10m, across empty/views; WAIT per draft. [Prompt holds; update Skip](../protocol/delivery/default-deny.md). First effect requires atomic [attempt-id evidence](../protocol/delivery/submit-verify-helper-lib-sh-tap-submit-verify-part-01.md); no id, no receipt. Never combine attempts. Idle Enter (`.idle-submit`), [copy-mode cancel](../protocol/delivery/nudge.md) and exact START cleanup own byte-free licenses; same-ID resend owns `.retry-<uuid>`, no interrupt. Never collapse placement/submission/settlement/cancellation/uncertainty into "delivered."

[Monitors](../protocol/supervision/monitor.md) sample; leaders check age and recover.

[`error` vs `blocked`](../protocol/identity/agent-state.md).

After send/reply, work; never sleep/poll. Check obligations before yielding. Recovery observes first; never auto-retry possible effects. [Park expiry](../protocol/delivery/reliability.md#park-retention-tap-nzjvi) keeps evidence, records withdrawal; no pane effects. Daily upkeep needs no watcher.

All readers treat `suspended/incapable` as stopped-like. Only public re-registration from its recorded pane clears it, never repair/rebuild/attach/resume.

[Self](../protocol/delivery/command-mode-tap-compact-and-the-deprecated-tap-command-part-02.md): compact/rebrief (clear alias): authored brief before effects; same instance/obligations. Native proof; no effect replay. Notify: optional audience, no inference/transfer. Codex reset proof: post-input.

Versions track readers/controls; tests pin invariants. Reviews/gates are not transport receipts.

`--workdir` picks a team-repo checkout; relaunch keeps it or (one seat) repairs it; enrollment unchanged.

## Skill identity

`tap` floor: Claude/Codex plugin `tap:<name>` (`tap:tap`); flat `tap-<name>`;
optional `skills.full_kit`. Wrappers keep metadata/canonical source.
Register native before retiring legacy; failures repair owned names.
Cleanup requires recorded ownership; preserve foreign/edited state.
[Owner](../protocol/coordination/skill-identity.md).
