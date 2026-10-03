# Identity and lifecycle

Normative TAP v0.23 protocol pages. Open only the page needed for the current question.

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

A seat the launcher places binds at SessionStart to the team that launched it,
whatever its working directory. The launcher plants two harness env keys:
`TAP_LAUNCH_ROOT`, the enrolled team root, and an incarnation token. That token
is `TAP_LAUNCH_ID` for a launch transaction, or the existing `TAP_CLEAR_ID` for
an in-place clear or relaunch. Every harness's SessionStart entry
(`session-start.ts`) checks this evidence before its cwd rule. It accepts the
evidence only when all of the following hold:

- the root resolves under the same rules as a cwd root (live index,
  non-historical entry, readable registry);
- the registry parses;
- exactly one active row is bound to the hook's own pane and server generation;
- that row's token matches (`launch-evidence.ts` `launchTokenMatches`).

When it accepts, the bind child runs with its cwd at that root, so `tap in`
cannot select a different team whose root contains the workdir. Any failed
check falls through to the cwd rule unchanged. A Claude session that merely sits
in a worktree, without launch evidence, is silent, as before. Launch evidence
never creates a row: it binds only a row the launcher already placed on this
exact pane (tap-9jfyl).

**Token precedence is exclusive:**

- A pending `launch_id` or `expected_clear_nonce` is the only token that counts.
- A row carrying both pending fields refuses.
- `launch_witness` counts only when neither is pending.

So an outgoing harness never satisfies a row whose replacement is already
starting.

**`launch_witness` lifecycle (an optional row field):**

- A launch reservation deletes it.
- The launcher's ready bind promotes it from `launch_id`.
- In clear and relaunch, the call site decides what happens to the token when
  the nonce retires:
  - a verified replacement promotes the nonce;
  - an unverified outcome after the respawn effect deletes the token;
  - a refusal before the effect keeps the live incarnation's token.
- A rebind that changes the row's harness deletes it.

A row without the field falls back to the cwd rule.

**Worktree guard.** `tap in` also accepts a pane outside the team's worktree
root, without `--override-worktree`, in one case: the pane lies inside an entry
of `git worktree list` for the team root, AND the row bound to this pane and
generation carries the caller's token. A pending `relaunch --workdir` therefore
binds before its new `launch_workdir` is recorded. `registered_from_worktree`
is unchanged.

Test runners and `sandbox-pins.sh` scrub `TAP_LAUNCH_ROOT`, `TAP_LAUNCH_ID` and
`TAP_CLEAR_ID`, so a probe started inside a live seat's pane cannot carry that
seat's token. The launcher unsets inherited `TAP_LAUNCH_ROOT` and `TAP_LAUNCH_ID`
unless it plants them itself.

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
