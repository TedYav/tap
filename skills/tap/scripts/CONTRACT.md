# TAP Contract (v0.23)

Same-human/machine bus; best-effort tmux, no security boundary. Placement/submission never prove recipient processing.

[Reliability](../protocol/delivery/reliability.md): persist or refuse; pollable mail, visible failures. Target: 99.9% recipient-observed. Refusals may stall.

Transport records effects; workflows own convergence/review/merge. Sender buses own payloads/receipts. One authority/store; history never current.

Never read/migrate old stores (`old_store`). New `.tap/bus` roots via `init`, first launch (non-Git consent), or `register|in` (seats only); `tmp/tap` registries refuse. Custom `TAP_HOME`/enrolled registries, historical identity evidence stay valid. [Reset custody](../protocol/identity/registry-unit-1-part-02.md): mail/registry SH; cuts/fences EX. Register never drains; dead panes retain mail/identity.

Bun: send/assign/reply, sessions, [lifecycle](../protocol/identity/seat-lifecycle.md), clear, [`poll`](../protocol/delivery/poll-malformed-payload-contract.md#native-poll-ownership), [spool drain](../protocol/delivery/spool-part-01.md), single/digest submit/custody.

`send`: notes; `assign`: work; `reply`: answers; `escalate`: user questions. Resolved payload bodies alone authorize peer work. `tap read` settles notes; asks need `tap reply`. `user`: unclaimable operator; `[[TAP v0.23 nudge]]` means continue.

```text
[[TAP v0.23 <ask|note> [<team>/]<id> [tag ...] [preview="text"] [path=<abs>]]]
```

[Pane enrollment](../protocol/identity/README.md): register/SessionStart/bind/repair scan id/generation/socket before publishing. Proven foreign/machine faults refuse `pane_enrolled_elsewhere`/`pane_enrollment_unknown`; other defects skip. No cross-bus lock; concurrent scans may see absence.

Handles name seats; instances distinguish occupants. At every effect (detached too) and final registry read, recheck liveness, seat instance and pane/session/generation/socket binding; identity needs a process-owned pane ([poll exception](../protocol/messages/poll-mode-delivery-class-v0-4-part-02.md)). Outside ancestry: select at most one exact active Claude row per [native-session/declared background-job rules](../protocol/identity/registry-unit-1-part-09.md); background ownership replaces no identity or shared-actor rule.

Crew: [parent/child pane generations](../protocol/identity/seat-lifecycle.md).

Stage 0 bounds verb/hook cwd walks at Git roots. `unanchored_bus` re-anchors once via its pane: live marker, row unique across teams (`contested`/unproven fails closed), same Git common dir, revalidated; never launcher enrollment ([owner](../protocol/delivery/structured-failures-and-json-output-part-03.md)). Restart: no dispatch writes; lifecycle re-attests.

`tap team doctor --fix` repairs attribution, not ownership; refuses ambiguous/duplicate-owned identities.

Precheck; preemption needs `--delivery interrupt`/`--urgent`. [Input protection](../protocol/delivery/pending-input-standard-grace-then-the-clobber-pipeline-part-02.md) gates every pane effect, even interrupts. [Prompts get no key](../protocol/delivery/default-deny.md). At first effect, submit/native-effect owners atomically write [attempt-id evidence](../protocol/delivery/submit-verify-helper-lib-sh-tap-submit-verify-part-01.md); no id, no receipt. Never combine attempts. Idle Enter (`.idle-submit`), [copy-mode cancel](../protocol/delivery/nudge.md) (recovery run) own licenses; no bytes or reinjection. Never collapse placement/submission/settlement/cancellation/uncertainty into “delivered.”

[Monitors](../protocol/supervision/monitor.md) sample; leaders check age and recover.

After send/reply, work; never sleep/poll. Check obligations before yielding. Recovery observes first; never retry possible effects. [72h park expiry](../protocol/delivery/reliability.md#park-retention-tap-nzjvi) preserves evidence and records withdrawal; no pane effects. Detached daily upkeep needs no watcher.

All readers treat `suspended/incapable` as stopped-like. Only public re-registration from its recorded pane clears it, never repair/rebuild/attach/resume.

[Self compact](../protocol/delivery/command-mode-tap-compact-and-the-deprecated-tap-command-part-02.md): caller arms; worker queues before input, owns proof; timeout keeps handoff, no resume.

Rebrief replaces context, keeps instance/obligations; Codex reset proof is post-input; persist brief before effects.

Versions track readers/controls. Tests, not prose, pin invariants. Reviews/gates are not transport receipts.

Launch `--workdir` picks a team-repo checkout; relaunch keeps it or (one seat) repairs it; anchor/enrollment unchanged.

## Published skill identity

`tap` owns the floor. Claude/Codex use the full `tap:<name>` plugin (`tap:tap`);
flat hosts use `tap-<name>` with optional skills under `skills.full_kit`.
Wrappers retain metadata and resolve canonical source. Native registration
precedes legacy retirement; failure repairs owned names. Cleanup requires
matching recorded ownership and preserves foreign/edited state.
[Skill identity](../protocol/coordination/skill-identity.md) owns the details.
