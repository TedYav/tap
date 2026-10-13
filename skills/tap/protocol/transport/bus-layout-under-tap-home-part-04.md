# Bus layout (under `TAP_HOME`) — source part 4 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0024 start=143442 end=152188 sha256=33af878aed834049c158fc82a6fa7197494033a15ec68d5b809b72a915219acb fragment=4/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
  **The value is constant by design and is never upgraded on this path.** The courier's `submitVerify` verifies exactly that the minted id left the input band; a six-harness audit found post-submit turn-boundary tokens on **0 of 6** harnesses, so no code path in the fleet may assert that a turn began. The field exists to stop the receipt claiming more than the instrument can see, which is why an always-identical value is the point rather than a smell. It is telemetry and documentation: **no protocol logic reads it**, and adding it changes no exit code, retry, spool, or settlement behavior.

  **What it costs to omit it (tap-dnub).** Four sends to one seat carried `.placed` **and** `.sent`, `error_class` none on all four; `tmux capture-pane -S -3000` on the recipient's pane grepped for each sentinel id returned **zero matches, all four**. The receipts were true — the courier did place and did submit — and the messages were never read. Two of the four were review findings on the PR the recipient was building past. Both halves of the transport's own evidence pointed at success, and `.sent` was the strongest evidence available. The frozen PC14 exit-5 shape is untouched by all of the above.
- **Verified redelivery writes the same `.sent` (tap-dnub).** When the spool drain or a detached deliverer redelivers a parked entry and the courier's submit returns `injected`, native redelivery writes `receipts/<id>.sent` with exactly the direct pane path's fields — `id`, `from` and `kind` read from the promoted canonical's frontmatter, `to` and `pane` as the bound target the submit was verified against, `turn=unconfirmed`, `delivery=pane` — using shared `receiptBytes` serialization and `atomicWrite` (runtime/bun/src/fsatomic.ts), and appends a `courier redelivery_delivered` registry event (`handle=<to> pane=<pane> detail=id=<id>`) before removing the spool entry. **What this changes:** before it, a verified redelivery left `.placed` only, no `.sent`, no registry line, no deliver-log line, spool entry gone — byte-for-byte the trace of the specimens whose sentinels never rendered (joined re-grep, history intact), so success and disappearance were indistinguishable after the fact; a live reproduction (a parked send redelivered on idle that DID render as a submitted user message) left that same trace. After it, "`.placed` only and spool gone" is an anomaly signal, not the normal success trace. **What it does not change:** `.sent` still means the id left the input band and nothing more; `redelivery_delivered` is new observability, not symmetry — the direct path writes `.sent` and no success event. Both writes are best-effort: a failed receipt write warns and never alters the rc-0 disposition (the entry is still removed), because a deliverer aborting between a verified submit and native `removeEntry` would re-inject a sentinel that already left the band. **Recorded near miss (not built):** a `queued-in-harness` submit outcome that re-probes the transcript at turn end and re-injects when the sentinel is absent. No causal loss specimen exists — the codex queued chip (`tab to queue message`) survived a prose-only turn end in the control — and a re-inject whose pre-effect proof is a chip's absence rather than a transcript read would violate no-retry-after-possible-effect. **Digest receipt boundary:** a verified digest records its index `injected_at_epoch` and preserves canonical members; it creates neither per-item `.sent` nor `.done`. Recipient item reads/replies own settlement.
- **Exit 5 (submit-unverified — sentinel was attempted):** the canonical stays in `payloads/` as a queued item. Default stderr says `tap send: <id> is on the bus for <to>. Delivery not confirmed. Inspect with tap show <id>; if it is still unread, tap resend <id> rings it again under the same id.`; `tap send --json` carries the frozen PC14 `status=pending`, `error_class=submit_unverified`, id, path, and target fields for machine supervision. The `.sent` receipt is NOT written; the caller can inspect the unverified message or wait for recipient processing. Exit 5 stays nonzero and possible-effect evidence prohibits automatic retry; the sender's same-ID `tap resend <id>` may re-ring it until the recipient observes it ([reliability](../delivery/reliability.md#explicit-same-id-retry)).
- **Exit 1 (terminal refusal, usage, or validation failure):** denylisted and unsupported harnesses fail before canonicalization with `error_class=unsafe_target|unsupported_harness`; stamp/validation failures also leave no canonical. No exit-1 path creates a spool entry. `tap send` never exits 4 in v0.7 (the lower-level submit helper still uses rc4 internally to ask the courier to park).

`tap doctor` flags torn canonicals (zero-byte, malformed frontmatter, wrong-id, missing required fields) as bus integrity failures (exit 1). Its normal and refusal paths are zero-write: a cwd-derived `default` bus refuses as `unanchored_bus` (exit 4) before creating `.tap`, while an explicit `TAP_HOME` remains a valid registry-less scratch-bus diagnostic target. The explicit bus never borrows an unrelated cwd team's acting registry. Operator mutation remains confined to `--fix` and the two `--prune-*` flags. Doctor performs no content scanning.

### Nudge recovery policy

`tap nudge` reads `[recovery] aggressiveness` from the launcher's `config.toml`
(default `aggressive`). `report-only` makes every nudge a dry run: it captures the
pane and presses nothing, with no recovery hold. `cautious` and `aggressive` both
run the unstick ladder; `--aggressiveness` is retired (use `--dry-run`). The ladder,
its recovery-run evidence and the doorbell are specified in
[nudge](../delivery/nudge.md). Broader UI interventions remain detective's scope.


### Detective recovery and post-mortem evidence

`tap detective <seat|team/seat> [--preset <name>] [--aggressiveness report-only|cautious|aggressive]`
starts one visible, tool-owned crew worker through the existing crew machinery.
The calling pane must be a registered TAP seat so its infrastructure assignments
and replies have an owner. The default preset is `luna-xhigh`; add the definition
from `skills/tap/config/config.v3.toml` to an existing catalog, or choose a configured
worker with `--preset`. The selected preset is validated before crew launch.

A restored empty composer with a complete empty pending scan is reported as an
observation, with submission flow explicitly unverified; it does not wait for
nonexistent receipts.

The worker starts in a fresh scratch directory under the caller's enrolled root;
retained evidence stays in the recovery debug directory. It verifies its own identity before receiving recovery work, and receives current
viewport and transport evidence rather than the target's product conversation.
The staged id is looked up directly; background evidence enumeration stops at
4,096 entries or one second and reports an explicit incomplete-evidence gap.
The initial all-queued shortcut requires at least one pending payload, every
observed payload queued in its harness, and no evidence gaps. A bounded or
unreadable scan cannot prove all work is queued; it continues through recovery
with the existing gap disclosures and no-replay rules.
This is a manual command, not automatic dispatch or a new supervision loop.
A known ordinary composer with complete empty pending evidence returns an
observation-only no-op; it does not claim to have repaired or delivered work.

Both nudge and detective default to **aggressive** when the shared setting is
absent. Report-only records inspection with no pane effects, recovery hold, or target effect mutex.
Cautious performs clear-cut recovery and stops on ambiguous intervention;
aggressive attempts ordinary harness dialogs without a peer-approval round.
An explicit operator pause, unrelated application, credible irreversible action,
or lost target harness/instance stops recovery. Target process kill/restart,
`tap clear`, and replacement agents are outside this command.

A detective run has one fixed five-minute deadline and at most six recorded
pane-effect interventions. The existing kernel-backed pane-submit mutex protects
recovery metadata updates and each effect cycle; thinking and reply waits do not
hold that mutex. All participating native/Bash courier calls use the bound pane
ID for the same sidecar. Live recovery ownership parks new courier effects with
a recovery reason, including pre-submit copy-mode cancellation. Expired, invalid,
or owner-gone metadata cannot authorize worker keys or retain an indefinite
courier hold. Deadline updates are rejected. A release cannot remove a successor's
ownership. Queue/read observations and normal cooldown policy remain separate.
