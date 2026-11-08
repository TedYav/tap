# Identity and lifecycle

- [Agent state](./agent-state.md): failed turns, modal holds and usable composers.
- [Antigravity conversation capture](./agy-conversation-capture.md): native hook timing, identity and resume binding.
- [Relaunch shorthands](./relaunch-shorthands.md): `--context` and `--ponytail` on `tap session relaunch`.
- [Seat selection for `tap out`](./seat-picker.md): `--last`, and the terminal chooser for a tie or a missed name.
- [Seat observations](./calibration.md): the opt-in calibration store, explicit reads and append/GC boundary.
- [Seat roles](./roles.md): `tap role`, leader ordering and the removal notice; a role is a label, not a permission.
- [Seat lookup](./seat-lookup.md): `whoami --pane --team`, registry fields and typed absence.
- [Stale-seat refresh](./stale-seats.md): `tap team refresh --stale`, its one-pass list, activity age and confirmed retirement.
- [Team startup and latest restart cohort](./team-up-last.md): ordinary resume membership, generation selection, preview and pinned recovery.

Normative TAP v0.23 protocol pages. Open only the page needed for the current question.

## Folder trust

After successful enrollment, explicit `tap init` offers: `Trust current directory in installed harnesses Y/n`.
It names the canonical current directory and supported installed harnesses first.
A completed Enter or Yes grants native folder trust; No skips it. EOF or an invalid
answer refuses the trust step while retaining enrollment. `--yes` grants consent;
`--no-trust-folders` skips the step even with `--yes`. JSON and noninteractive calls
without `--yes` grant no trust. Existing teams may repeat explicit init to trust a folder.
Implicit onboarding, first launch and setup never grant folder trust.

The adapters update only Codex project `trust_level`, Antigravity CLI
`trustedWorkspaces`, Claude project `hasTrustDialogAccepted`, or Cursor's native
workspace marker. They preserve other settings and refuse malformed stores.
Each harness has its own outcome; partial failure returns nonzero and retains
successful updates. Discovery failures are reported per harness too.
Consent grants each harness's normal folder trust, including project hooks and
permission rules where the harness bundles them with that grant (as Claude does).
It never accepts a separate hook/tool approval dialog, changes permission mode,
invokes a model, or approves an unknown prompt. Declining leaves trust unchanged
and warns that some harnesses may require manual trust before use here.

TAP serializes its own writers and refuses observed concurrent file edits. Native
harness writers do not share that lock: a write between the final comparison and
rename can still race. Atomic replacement prevents a partial file, not that race.

## Pane-identity guard (point-of-effect, v0.23)

The submit-time identity guard is native: `runtime/bun/src/pane-identity.ts` composes the bound
check (`observe-gather.ts` `boundPaneIdentityState`, the owner every native caller shares) with
the rowless manual-relay check. Recovery calls `submitIdentityGuard` in-process through
`recovery/identity-guard.ts`. The retired Bash adapter and its shell globals are gone.
The native courier re-authorizes its recipient and pane at each effect through
`courier.ts` (`authorizePaneEffect` and its internal `authorize` check).

- The result carries `outcome` (`authorized | refused | unobservable | fault`), a state token
  (`match`, `pane_drift`, `guard_deadline`, …), the stderr message or none, and the values of
  `harnessAlive` and `permissions`. Every refusal leaves those at `false` /
  `bypass`, except `permissions_unknown`, which leaves `unknown`.
- Only `authorized` permits an effect. `unobservable` means the instrument could not look (`guard_deadline`,
  `server_unresponsive`, `registry_missing`, `*_unobservable`), not that the pane drifted.
- A tmux router the native runtime cannot represent refuses both arms before any observation.
- With a budget (recovery uses 10 s), every blocking spawn (tmux, ps, and the boot-id probes)
  is bounded by the time left, and an answer that arrives after the budget is spent refuses.

## Explicit pane registration

`register --pane` and `in --pane` require a running target. A retained
remain-on-exit pane (`pane_dead=1`) refuses before any registration write,
even when tmux still returns its pane id, process id and command. Registration
derives its repository root from the target pane's `pane_current_path`, not
the CLI working directory. Dead state and identity come from the same
targeted query. The shared observer reports `pane_dead` with the retained identity,
distinct from physical absence (`pane_gone`): cleanup must check its ownership
rather than treating a stopped process as an absent pane. Registration revalidates after its registry lock wait and before lineage/adoption effects. Once adoption starts, it publishes the matching successor row even if the process exits during that sweep, so rewritten mail retains a registered owner.

## Cross-team pane enrollment

Registration (including SessionStart's native `tap in`), launcher bind and
repair share a best-effort enrollment scan before publishing a pane claim.
A matching active foreign claim refuses `pane_enrolled_elsewhere`, naming its
team and row. Only a proven claim refuses: another team's defects never block
this one. A team whose absolute worktree root is gone (ENOENT) is gone —
deleting a worktree is an ordinary shutdown without the ceremony — so the scan
skips it, even if a registry outside the deleted root still names this pane,
and de-enrolls it best-effort. The purge takes the gone team's registry sidecar
lock (when its directory survives) and then the index writer locks, each as one
non-blocking attempt; re-verifies under them; writes a restore snapshot in
`recovery/`; and prints one stderr receipt. A busy lock skips the purge, never
the registration. Registration and `tap init` re-enroll through the index
writer locks after publishing a registry, so a root recreated during a purge
re-adds its own entry. A missing registry under a live root (a reset or restore
may be mid-cut), a present but unreadable foreign registry, a malformed foreign
entry, an empty or relative root, or a matching row with incomplete identity is
skipped and never purged; `tap admin refresh` remains the explicit purge. `pane_enrollment_unknown`
is reserved for machine-level authority: an unreadable index, an unobservable
pane id, or ambiguous enrollment for this root. Identity compares pane id, server
generation and physical socket; recycled ids in a different generation or
socket do not claim this pane. The selected registry keeps its existing local
validation, collision and reconnect rules.

The scan adds no lock domain. **Accepted race:** simultaneous registrations
through different buses may both observe absence and publish. This is not
atomic uniqueness. The read-side resolver reports matching current-generation
duplicates as contested, naming the claimants. Remove the wrong row with
`tap out <team>/<handle>`; no manual registry deletion is required. This
repair retains the surviving row and instance.

## Launch evidence at SessionStart (tap-bogkt, tap-7b9od)

[SessionStart identity capture](session-start.md) owns automatic hook ancestry,
launch tokens, bind/context refusals and recovery. Inherited launch environment
selects a team; it does not prove that a child harness owns its parent seat.

## Retained dead panes in roster observation

The shared pane inventory reads session, address, pane id, command, pane pid,
server epoch and `pane_dead` in one seven-field record. The dead field must be
`0` or `1`; missing or malformed evidence makes the session's pane set
unobservable. A retained dead pane keeps its physical identity, even when its
cached command is empty. The roster reports `offline/pane_dead` with its address
and pane id and no observed harness. Bound and rowless effect guards refuse it
before harness attestation. A recovering row stays `offline/server_restarted`
until a living pane can be attested. The registration chooser still sees the
physical pane; process exit alone supplies no absence or mail-cancellation
authority.

- [Public seat lifecycle](seat-lifecycle.md): out, hard removal, power state, crew dismissal and receipts.
- [Native-store evidence for resume identity](resume-store.md): when a harness store may gate a resume (`no_exact_resume_identity`) — never nominate another id; OpenCode's read-only store check.
- [Seat fork](seat-fork.md): `tap session fork` — a new seat carrying another seat's conversation through the harness's native fork.
- [Held terminal](held-terminal.md): a caller whose controlling TTY no pane owns resolves only through the harness that holds that terminal for its tool (Antigravity `run_command`); four conditions, no environment input.
- Picker launch: `tap launch --resume` mints no id and captures as `launcher_new` with no expectation, so the first SessionStart id, the picked conversation, binds as the seat identity; `--resume=<id>` captures as `exact_resume` and expects that id. The marker is consumed by the launch argv and never stored, so resume, restart and relaunch replay the bound conversation and never re-offer the picker. Harnesses without a picker refuse `launch_resume_unsupported` before any effect. An exact id refuses before any effect, including the lifecycle journal and any bootstrap, when another seat in this cohort or any enrolled registry holds it (`launch_resume_identity_owned`; the target's own incumbent, matched by the handle the launch registers under, is not another seat, and a target the collision ladder moves is rechecked before reservation) or when the store the seat's harness child reads (its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, declared or inherited, else the default under its HOME; TAP's `TAP_CLAUDE_HOME` / `TAP_CODEX_HOME` are never passed to the child and never choose the probe store) has no such conversation (`no_exact_resume_identity`); a replacement under `--fresh --resume` drops the outgoing incarnation's capture result so a re-picked conversation binds afresh instead of reading as an already-judged observation.

## Source parts

- [Registry (Unit 1) — source part 1 of 14](./registry-unit-1-part-01.md) — source bytes 159464–168389
- [Registry (Unit 1) — source part 2 of 14](./registry-unit-1-part-02.md) — source bytes 168389–175705
- [Registry (Unit 1) — source part 3 of 14](./registry-unit-1-part-03.md) — source bytes 175705–182509
- [Registry (Unit 1) — source part 4 of 14](./registry-unit-1-part-04.md) — source bytes 182509–187800
- [Registry (Unit 1) — source part 5 of 14](./registry-unit-1-part-05.md) — source bytes 187800–194798
- [Registry (Unit 1) — source part 6 of 14](./registry-unit-1-part-06.md) — source bytes 194798–203476
- [Registry (Unit 1) — source part 7 of 14](./registry-unit-1-part-07.md) — source bytes 203476–211636
- [Registry (Unit 1) — source part 8 of 14](./registry-unit-1-part-08.md) — source bytes 211636–219039
- [Registry (Unit 1) — source part 9 of 14](./registry-unit-1-part-09.md) — source bytes 219039–226511
- [Registry (Unit 1) — source part 10 of 14](./registry-unit-1-part-10.md) — source bytes 226511–233905
- [Registry (Unit 1) — source part 11 of 14](./registry-unit-1-part-11.md) — source bytes 233905–241727
- [Registry (Unit 1) — source part 12 of 14](./registry-unit-1-part-12.md) — source bytes 241727–250204
- [Registry (Unit 1) — source part 13 of 14](./registry-unit-1-part-13.md) — source bytes 250204–258801
- [Registry (Unit 1) — source part 14 of 14](./registry-unit-1-part-14.md) — source bytes 258801–265170
- [Seat refresh (`tap refresh`) (v0.21) — source part 1 of 2](./seat-refresh-tap-refresh-v0-21-part-01.md) — source bytes 334971–343187
- [Seat refresh (`tap refresh`) (v0.21) — source part 2 of 2](./seat-refresh-tap-refresh-v0-21-part-02.md) — source bytes 343187–347715
- [Seat clear (`tap clear`) (v0.21) — source part 1 of 2](./seat-clear-tap-clear-v0-21-part-01.md) — source bytes 347715–355048
- [Seat clear (`tap clear`) (v0.21) — source part 2 of 2](./seat-clear-tap-clear-v0-21-part-02.md) — source bytes 355048–362442
- [Seat relaunch (`tap session relaunch`) (v0.22) — source part 1 of 3](./seat-relaunch-tap-session-relaunch-v0-22-part-01.md) — source bytes 362442–371204
- [Seat relaunch (`tap session relaunch`) (v0.22) — source part 2 of 3](./seat-relaunch-tap-session-relaunch-v0-22-part-02.md) — source bytes 371204–379843
- [Seat relaunch (`tap session relaunch`) (v0.22) — source part 3 of 3](./seat-relaunch-tap-session-relaunch-v0-22-part-03.md) — source bytes 379843–381576
- [Rebind recap (`tap in` on an existing handle, `tap recap`) (v0.21)](./rebind-recap-tap-in-on-an-existing-handle-tap-recap-v0-21.md) — source bytes 382700–385156
- [Admin namespace (`tap admin` — machine-wide operator verbs) (v0.4) — source part 1 of 3](./admin-namespace-tap-admin-machine-wide-operator-verbs-v0-4-part-01.md) — source bytes 443738–452445
- [Admin namespace (`tap admin` — machine-wide operator verbs) (v0.4) — source part 2 of 3](./admin-namespace-tap-admin-machine-wide-operator-verbs-v0-4-part-02.md) — source bytes 452445–460529
- [Admin namespace (`tap admin` — machine-wide operator verbs) (v0.4) — source part 3 of 3](./admin-namespace-tap-admin-machine-wide-operator-verbs-v0-4-part-03.md) — source bytes 460529–469392
- [Initial-launch fork refusal — source part 1 of 2](./initial-launch-fork-refusal-part-01.md) — source bytes 919665–928281
- [Initial-launch fork refusal — source part 2 of 2](./initial-launch-fork-refusal-part-02.md) — source bytes 928281–934887
