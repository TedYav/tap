# Bus layout (under `TAP_HOME`) — source part 1 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0021 start=122488 end=126242 sha256=90fae295bf1fcb3797025e086894600483d7f5248a5de85f6f05495cad15a893 fragment=1/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Bus layout (under `TAP_HOME`)

**Bus resolution.** After any explicit team or selected-bus pin, the native resolver applies this order:

1. `TAP_HOME` env set → use it as the proposed bus (rule `env`; custom homes are unindexable). Its spelling does not confer a team root or select an old-layout fallback. The existing standalone-pin contract remains: poll, digest-window and withdraw honor the exact custom bus or refuse a conflicting binding.
2. `<root>/.tap/bus` is a directory → use it (rule `dotdir`). It wins even if stale `tmp/tap` contents remain.
3. `<root>/tmp/tap/registry.json` has a directory entry and no `.tap/bus` directory exists → report `old_store`. Selection and effect doors refuse before creating a bus or writing. Observers report the old store; no reader treats it as an empty roster. A dangling registry symlink also counts as an entry.
4. Otherwise → default to `<root>/.tap/bus` (rule `default`, created on demand). A `tmp/tap` directory holding only scratch or archives is ignored and left intact. Read-only `tap doctor` refuses an ungrounded default before creation; see part 4.

Before a bus write, a path that is provably a container is refused: `.tap` itself, a root already containing `.tap/bus`, or a git worktree root. Existing paths resolve physically and trailing separators are normalized. The refusal names the expected bus and asks the caller to unset or correct `TAP_HOME`. Arbitrary non-container custom homes remain supported, including a home explicitly named `tmp/tap`.

TAP never upgrades or moves an old bus. `old_store` asks the operator to move the old location aside by hand before running `tap init`. The former `legacy_bus` class and the Bun `TAP_MIGRATING` bypass are retired. `doctor` and `whoami --verbose` report the bus and resolution rule.

The `.tap/bus/` tree is self-ignored by a CLI-written `.tap/.gitignore`; `.tap/config` is committed. **That inner file is not the only ignore rule:** since v0.23 `tap init` also appends `.tap/` to the **Git-root** `.gitignore` when no existing rule covers it (§Repository ignore rule and the missing-local-team onboarding preflight). Two files, two jobs — the inner one keeps bus traffic out of git even where the outer rule is absent or removed, the outer one keeps the whole `.tap/` directory untracked. Every Bash and native writer also requires the bus root itself to accept the one-time `.tap-bus-authority` marker after its child directories exist; failure is the named `bus_authority_unwritable` refusal with the remedy to fix `TAP_HOME`'s own permissions, because accepting a send into writable children while leaving redelivery unauthorized is a silent-delivery trap.

```
payloads/<id>.md          # the message blob (YAML-ish frontmatter + body)
receipts/<id>.done        # AUTHORITATIVE: settled. idempotent. atomic.
receipts/<id>.placed      # AUTHORITATIVE place-time courier attribution (tap-ejpf)
receipts/<id>.sent        # post-submit telemetry — not the provenance mark (exit 5 has none)
registry.json             # team provenance + agent handle → pane mapping (see §Registry below)
input-backups/*.md        # local sensitive-by-content backups written before the clobber pipeline clears pending input
.tap-bus-authority        # written once by tap_ensure_dirs; pane-effect authority marker (see §Spool, tap-ncd4)
```

Reset checkpoints `input-backups/` with the cut while discarding the recipient delivery-clock cache. Sensitive backups remain governed by `tap doctor --prune-input-backups`.
