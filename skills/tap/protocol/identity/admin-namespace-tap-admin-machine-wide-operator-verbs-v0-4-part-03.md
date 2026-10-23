# Admin namespace (`tap admin` — machine-wide operator verbs) (v0.4) — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0072 start=460529 end=469392 sha256=7bf93d95ed0f32768ab03a35542802bf64c40d881baf04285c3e9b6c2e6a2969 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Team reset preserves bus state.** `tap team reset` now shares the hard family
retirement engine with `tap team out --hard`. There is no component copy, inventory
or live cut. Payloads, receipts, spool, supervision leases and archives remain
in place. Selected rows retire with per-seat history; the registry document and
machine enrollment remain initialized even when no seats remain. Historical
checkpoint bundles are never restored or deleted by the retired commands.

### Scratch-only interlock (`TAP_SCRATCH_ONLY`)

A caller may declare, once and in its own environment, the directory prefix every state root it clears must live under: `export TAP_SCRATCH_ONLY=<abs-dir>`. When that variable is non-empty, a state-clearing verb compares the **final resolved** state root — the exact value it is about to act on, read at its own resolution point, never an argument or an earlier copy — against the declared prefix, and refuses (`error_class=scratch_only_refused`) when the root is neither the prefix itself nor a path component-wise beneath it. The refusal names both the declared prefix and the resolved root, and nothing is archived, cleared, or deleted.

Guarded verbs and the root each one checks: `tap team reset` → the resolved bus (`TAP_HOME`) through the shared hard-retirement engine · `tap admin rebuild-registry --yes` → each acting registry the plan resolved (the non-writing bare preview is not gated) · `tap out --kill` → the resolved bus (`TAP_HOME`) whose seat row is being deleted and whose session is being stopped. Each shell-side refusal exits `1` with the ordinary structured failure and performs no archive, clear, delete, or session stop.

Two properties are load-bearing. **This interlock** (not the retention change above, which is a real behavior change stated on its own terms) is **purely additive**: with the variable unset, behavior is byte-identical to a build without it, and when set it can only ever refuse more — never permit more — so no sanctioned path can lose access. And it is **not defeatable by the failure it exists to catch**: its inputs are this process's own environment plus values assigned in the executing shell, and every call site runs in the current shell (never inside `$( )`, a pipeline segment, or a background job) so the refusal's exit ends the command rather than a subshell. The failure it defends against: a review harness set its scratch overrides inside a command substitution, those exports never reached the parent, and a machine-wide reset ran against the real state root: every sanctioned gate on the command held, and what was missing was any mechanical link between the declared scope and the resolved root.

**What the belt does not cover, and the doctrine that still does.** Being opt-in is exactly what makes it additive, and exactly what bounds it: a session that never exported `TAP_SCRATCH_ONLY` — including one whose *declaration* was itself lost to a subshell, the same way that failure lost its overrides — has no belt at all, and every verb behaves as it always did. The mechanism converts a declaration into a check; it cannot supply the declaration. So the operating doctrine is unchanged and still load-bearing: declare ONCE, at session top level, outside any subshell, and verify the declaration landed (`printenv TAP_SCRATCH_ONLY`) before invoking anything destructive. What the interlock removes is the *next* failure in that chain — a declaration that landed while the scratch overrides it was meant to describe did not.

### `tap team purge <archive> [--dry-run] [--yes]`

`tap team restore` and `tap team purge` are removed, non-mutating tombstones: exit `1`, `error_class=renamed_verb`, with
pointers to `tap team reset` and `tap team down`. They do not resolve a team,
acquire a fence or lock, or inspect archives. Historical bundles stay untouched.

### `tap admin retire <team> [--force] [--json]`

The **only** operation that de-enrolls a team from the machine index (`~/.tap/global-registry.json`; with no marker it refuses `unanchored_bus`, next `tap init`). Index-only — retire never archives a worktree's `.tap/` bus (payloads, receipts, archives stay; `tap team reset` owns archiving).

**Refusal without `--force`:** retire refuses (`error_class=retire_refused`) when the acting registry has poll-mode members. Current registry membership is the recovery boundary; archived journal rows are not blockers.

**With `--force`:** de-enrolls regardless of blockers; appends an audit event on the team's bus when its root still exists.

Success prints `tap admin retire: de-enrolled team '<team>'`; `--json` emits `{ok: true, team, root, forced}`.

### Tombstones (`tap roster`, `tap admin prune`)

Hard-renamed verbs exit `1` with `error_class=renamed_verb` and name the new spelling — no silent alias. `tap roster` → `tap team`. `tap admin prune` → `tap admin refresh` plus `tap admin retire <team>`.

