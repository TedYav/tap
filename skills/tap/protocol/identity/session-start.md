# SessionStart identity capture

Automatic identity capture refuses a nested harness before binding or injecting
seat context. The shared process observer walks from the hook to the observed
pane's `pane_pid`, using the fixed executable-family classifier. A second
harness refuses, except a script-runtime shim directly forwarding the same
arguments to a native executable of the same family. Shell/tool intermediaries
and different invocations do not qualify as shims. Version-named Claude
executables count toward refusal only; they grant no identity authority.
Inherited launch tokens and tmux variables cannot bypass this check.

Claude, Codex and Cursor SessionStart and Antigravity's native invocation hook
share this guard. The existing independently validated Claude session/job-row
fallback remains available for a nonempty payload session id when the caller
does not physically descend from the pane. OpenCode's private/shared context
producers remain read-only and require their existing exact native-session binding.

Missing ancestry evidence skips automatic binding and seat context too.
`startup.jsonl` records `sessionstart_skipped` with `nested_harness`,
`ancestry_unobservable`, or `caller_unobservable`; ancestry failures include a
`tap in` repair pointer. A skipped fire leaves the registry unchanged: an old
binding stays old, and an unbound launch stays unbound. A later valid hook or
explicit `tap in` can bind; `tap team refresh` does not capture a new harness
session id. Explicit registration keeps its existing checks.

Codex SessionStart first requires a nonempty string `transcript_path` in its
payload. Otherwise it exits successfully with no output, before launch-evidence
resolution, registration, tracing or context injection. Internal memory workers
inherit the parent's pane and launch environment, so those signals cannot grant
them a seat. This is a persistence proxy, not a worker-type discriminator: user
`--ephemeral` sessions and non-local stores also skip automatic registration;
explicit `tap in` remains available. The path need not exist on disk. This
transcript requirement applies only to Codex.

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

