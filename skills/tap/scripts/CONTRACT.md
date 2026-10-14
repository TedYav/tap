# TAP Contract (v0.23)

Same-human/machine bus; best-effort tmux, no security boundary. Placement/submission never prove recipient processing.

[Reliability](../protocol/delivery/reliability.md): at-least-once; persist or refuse; pollable mail, visible failures. Target: 99.9% recipient-observed. Refusals may stall.

Transport records effects; workflows own convergence/review/merge. Sender buses own payloads/receipts. One authority/store; history never current.

Never read/migrate old stores (`old_store`). New `.tap/bus` roots via `init`, first launch (non-Git consent), or `register|in` (seats only); `tmp/tap` registries refuse. Custom `TAP_HOME`/enrolled registries, historical identity evidence stay valid. [Reset custody](../protocol/identity/registry-unit-1-part-02.md): mail/registry SH; cuts/fences EX. Register never drains; dead panes retain mail/identity.

[Trust](../protocol/identity/README.md#folder-trust): init consent; Codex hooks: prior exact-list consent; else block.

Bun: send/assign/reply, sessions, [lifecycle, crew generations](../protocol/identity/seat-lifecycle.md), clear, [`poll`](../protocol/delivery/poll-malformed-payload-contract.md#native-poll-ownership), [spool drain](../protocol/delivery/spool-part-01.md), single/digest submit/custody.

`send`: notes; `assign`: work; `reply`: answers; `escalate`: user questions. Resolved payload bodies alone authorize peer work. `tap read` settles notes; asks need `tap reply`. `user`: unclaimable operator; `[[TAP v0.23 nudge]]` means continue.

```text
[[TAP v0.23 <ask|note> [<team>/]<id> [tag ...] [preview="text"] [path=<abs>]]]
```

[Pane enrollment](../protocol/identity/README.md): register/SessionStart/bind/repair scan id/generation/socket before publishing. Proven foreign/machine faults refuse `pane_enrolled_elsewhere`/`pane_enrollment_unknown`; other defects skip. No cross-bus lock; concurrent scans may see absence.

Handles name seats; instances distinguish occupants. At every effect (detached too) and final registry read, recheck liveness, seat instance and pane/session/generation/socket binding; identity needs a process-owned pane ([poll exception](../protocol/messages/poll-mode-delivery-class-v0-4-part-02.md)). Outside ancestry: one exact active Claude row per [job rules](../protocol/identity/registry-unit-1-part-09.md), or the pane whose harness [holds the caller's terminal](../protocol/identity/held-terminal.md); neither replaces identity or shared-actor rules.

Cwd walks stop at Git roots and only default a team; `unanchored_bus` or an enrolled cwd team not holding the calling pane re-anchors once via it: live marker, machine-unique row (`contested`/unproven fail closed), same Git common dir, revalidated; never launcher enrollment ([ref](../protocol/delivery/structured-failures-and-json-output-part-03.md)). Restart: no dispatch writes; lifecycle re-attests.

`tap team doctor --fix` repairs attribution, not ownership; refuses ambiguous/duplicate-owned identities.

Precheck; preemption needs `--delivery interrupt`/`--urgent`. [Input protection](../protocol/delivery/pending-input-standard-grace-then-the-clobber-pipeline-part-02.md) gates every pane effect, even interrupts. [Prompts get no key](../protocol/delivery/default-deny.md). At first effect, owners atomically write [attempt-id evidence](../protocol/delivery/submit-verify-helper-lib-sh-tap-submit-verify-part-01.md); no id, no receipt. Never combine attempts. Idle Enter (`.idle-submit`), [copy-mode cancel](../protocol/delivery/nudge.md) own byte-free licenses; same-ID resend owns `.retry-<uuid>`, no interrupt. Never collapse placement/submission/settlement/cancellation/uncertainty into "delivered."

[Monitors](../protocol/supervision/monitor.md) sample; leaders check age and recover.

After send/reply, work; never sleep/poll. Check obligations before yielding. Recovery observes first; never auto-retry possible effects. [Park expiry](../protocol/delivery/reliability.md#park-retention-tap-nzjvi) keeps evidence, records withdrawal; no pane effects. Daily upkeep needs no watcher.

All readers treat `suspended/incapable` as stopped-like. Only public re-registration from its recorded pane clears it, never repair/rebuild/attach/resume.

[Self compact](../protocol/delivery/command-mode-tap-compact-and-the-deprecated-tap-command-part-02.md): caller arms; worker queues before input, owns proof; timeout keeps handoff, no resume.

Rebrief replaces context, keeps instance/obligations; Codex reset proof is post-input; persist brief before effects.

Versions track readers/controls. Tests, not prose, pin invariants. Reviews/gates are not transport receipts.

`--workdir` picks a team-repo checkout; relaunch keeps it or (one seat) repairs it; enrollment unchanged.

## Skill identity

`tap` floor: Claude/Codex plugin `tap:<name>` (`tap:tap`); flat `tap-<name>`;
optional `skills.full_kit`. Wrappers keep metadata/canonical source.
Register native before retiring legacy; failures repair owned names.
Cleanup requires recorded ownership; preserve foreign/edited state.
[Owner](../protocol/coordination/skill-identity.md).
