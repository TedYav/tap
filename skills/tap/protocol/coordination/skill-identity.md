# Published skill identity and installation

Canonical instructions live at `skills/<name>/SKILL.md`, with short names such as
`lead`, `drive`, and `conduct`. The all-seat floor is `tap`; its runtime, scripts,
config, and protocol remain under `skills/tap`.

Claude and Codex load one `tap` plugin from the `tap-marketplace` marketplace in
the installed checkout. They expose the full public inventory as `tap:lead`,
`tap:drive`, and other namespaced skills. The all-seat entry is `tap:tap`.
The plugin contains skill entrypoints only; the existing installer owns the CLI
and hooks. Each entrypoint preserves its source's discovery metadata and resolves
its instructions through `tap help skill <name>`. Relative references resolve
from the canonical source directory.

Flat skill catalogs use `tap-<name>` wrappers, plus `tap` for the all-seat floor.
They start with `tap`, `tap-in`, `tap-send`, `tap-escalate`, `tap-config-wizard`,
and `tap-help`. The `skills.full_kit` boolean controls their optional skills.
Setup accepts `fullKit` in its JSON patch and asks a default-No terminal question.
Omission makes no change; candidate and dry-run decisions leave installation
untouched. This preference does not refresh or reduce the native plugin.

An upgrade without a full-kit preference retains only manifest-owned optional
flat entrypoints. Explicit No removes only unchanged owned optional links and
wrappers. Foreign symlinks, personal directories, and edited files survive.
The manifest's literal symlink targets and file hashes remain the ownership
proof for loose skills.

Native registration must succeed before retiring owned loose entrypoints in
that host. If registration fails, the installer repairs existing owned names
with canonical delegating wrappers, so the source-directory rename does not
leave them dangling. It adds no new legacy names. Shared-root entrypoints stay
until the native hosts are ready; normal flat-host installation uses each
host's own skills root.

Native registration uses the host's CLI. TAP records the host, home, marketplace,
plugin, requested source, and exact native source for registrations it creates.
Codex resolves a release's `current` symlink when adding its marketplace. On
upgrade, TAP moves that registration only if its live source matches the recorded
source and the marketplace has no unrelated plugins. It journals both sources
before native remove/add, then re-reads the plugin to preserve its enabled state.
A retry resumes an interrupted move. A foreign source is preserved. Uninstall
removes only recorded registrations whose native source still matches; an
unrelated plugin keeps its marketplace.
The harness owns its registry files and caches, including caches it retains
after removal. TAP does not edit those files directly.

Codex hides plugin rows when their marketplace is absent, even if its config and
cache remain. Installation re-reads after marketplace add before deciding to
refresh; uninstall retains a plugin ownership record when the marketplace is
missing because native inventory cannot prove that the plugin is gone.

An observed disabled plugin is left disabled and its cache unrefreshed. Claude updates an
installed enabled plugin; Codex refreshes its cached copy with native `plugin add`.
Codex has no atomic refresh that preserves a concurrent enable/disable change,
so a user disabling it during that command can race the refresh. Avoid changing
the toggle during `install.sh`; a disabled Codex plugin refreshes on the next
install after the user enables it.

`tap help skill lead`, `tap help skill tap:lead`, and `tap help skill tap-lead`
resolve the same source. Lookup also accepts `conductor`, `using-tap`, and
`tap-config`; these aliases are not separate discovery entries. `coach` and
`abandon-branch` stay repository-local and are excluded from the public plugin
and export. `tap-double-check`, `tap-done`, and `lieutenant` remain retired.
The existing `tap-coach`, `tap-abandon-branch`, and `tap-double-check` tombstones
remain non-mutating lookup explanations outside discovery roots.

Claude hides `send`, `reply`, `outstanding`, `assign`, and `team` from the slash
menu through their unchanged `user-invocable: false` metadata. Native fixture
inspection proves their menu absence; model invocation has not been exercised
by that fixture. No equivalent menu-only control is established for flat hosts.

`help` is the one user-only skill: only the person starts it. Its source carries
`disable-model-invocation: true`, which the plugin entrypoint and flat wrappers
copy. From that same flag the generator writes the plugin's
`agents/openai.yaml` with `policy.allow_implicit_invocation: false`, the Codex
control; Codex ignores the frontmatter flag. Observed 2026-10-06: Claude Code
2.1.291 and Codex 0.160.1 leave a skill so marked out of the model's skill
listing, and OpenCode 1.18.34 still lists it. Hermes, Antigravity and
Cursor-agent are unverified. Fallback wrappers kept after a failed native
registration carry the frontmatter flag but no `agents/openai.yaml`, so Codex
lists `tap-help` until registration succeeds. The description stays short
because some hosts still show it to the model. User-only also blocks agent and
sibling invocation, so a flow that needs the diagnosis checks reads
`references/diagnose.md` beside the path `tap help skill help` prints.

The policy table in `runtime/bun/src/skill-policy.ts` owns the public inventory.
From `runtime/bun`, run `bun run skills:generate` after changing skill metadata;
`bun run skills:check` checks the committed plugin entrypoints.
