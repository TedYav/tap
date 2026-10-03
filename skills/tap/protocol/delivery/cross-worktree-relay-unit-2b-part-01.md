# Cross-worktree relay (Unit 2b) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0109 start=721780 end=730738 sha256=ff5ffebab6dabc7f887b42593f27b5ff04c002d49c49bc4e1c41bbcdac22b6e6 fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Cross-worktree relay (Unit 2b)

TAP is a **worktree-local bus** by default: `.tap/bus/` lives inside the current git worktree and registration is worktree-scoped (Unit 1's same-tree guard). Cross-worktree relay is an **explicit opt-in** through either a team-qualified target or the manual relay flag. It never reads, writes, or scans another worktree's payloads or receipts; the team-qualified path reads only the bound sibling registry (`.tap/bus/registry.json`, with legacy `tmp/tap/registry.json` fallback) to resolve and revalidate the destination identity.

**Primary address form:** `tap send <team>/<handle> -f <path>` (or `-f - <<'EOF'`).

`-m "text"` and a positional `<payload-file>` remain valid alternate inputs.

`tap send` splits the target on the first `/`. If `<team>` equals the local `team.name`, the send is ordinary same-team delivery to `<handle>` and does not stamp cross-worktree fields. If `<team>` differs, TAP first consults the machine index; its deprecation fallback collects every sibling git worktree whose basename matches `<team>`. Zero matches is `unknown_team`; more than one is `ambiguous_team` (never first-match-wins); exactly one binds that worktree's registry. TAP then resolves `<handle>` and its stored pane identity from that bound registry and applies the registry/stored/live triple-check before relay.

**Legacy input alias:** `<team>:<handle>` remains accepted as compatibility input wherever `<team>/<handle>` is accepted — validated via `tap_valid_qualified_token` (exactly one `:`, both halves charset-valid) and rewritten to the canonical `/` form before any other parsing runs. `/` stays the canonical CLI grammar and the only emitted form. A malformed colon address (more than one `:`, or either half empty) is rejected (`tap send: address '<addr>' is not a valid <team>:<handle> token`). A mixed `':'` + `'/'` address (e.g. `a:b/c`) is NOT treated as the colon alias — the alias only fires when there is no `/` — so it falls through to slash parsing, where the strict team-token check rejects the colon-bearing team half.

Team-qualified sends fail loud when the team is unknown, the sibling has no TAP registry, the handle is not registered, or the pane is dead. An operator who deliberately accepts an unbound recipient may instead use the manual escape:

```bash
tap send <handle> <payload> --cross-worktree --pane <session>:<window>.<pane>
```

**Manual operator-authority escape:** `tap send <handle> <payload> --cross-worktree --pane <session>:<window>.<pane>`

Manual `--cross-worktree` requires an exact session-qualified pane and skips recipient-registry lookup. It is a human operator's deliberate escape for an unavailable registry or otherwise unresolvable sibling; agents should use a team-qualified registered target. The escape never derives seat `active`, cannot verify row status/epoch/boot/harness, and stamps no recipient instance or `to_team`. Its narrower authority is rechecked before placement and every pane effect: the exact session-name snapshot must be observable and alive, and the exact pane address must still be a member of that session with the same pane id. A bare/ambient tmux target refuses. Because no registry owns redelivery, the escape may attempt an immediate relay only; a path that would park in the registry-bound spool fails `identity_unverified` and removes the canonical payload. This remains an operator-risk tradeoff: exact membership prevents session/pane drift, but it cannot prove which logical agent owns the pane.

**Nudge identity:** `tap nudge` uses argv only to locate a candidate pane. **Since v0.23 the wire carries no `to=`**, so it resolves the recipient from the payload the sentinel's id names — a bare id on the argv target's own bus, a `<team>/`-prefixed id through the machine index — and compares that payload's courier-written `to:`/`to_team:` against argv (§Sentinel, recipient corroboration). A payload ABSENT from that bus is its own error class pointing at `tap show <id>`, never an identity mismatch: a missing file is not evidence of a wrong target. **A pre-0.23 sentinel still sitting in a band keeps its own path** — the parser gives it a distinct verdict and its `to=` is read directly, because it is an independent witness and it is free. The witness argv does not choose is unchanged and still decisive: the observed candidate pane must be that handle's registry-bound pane. A pane-only call supplies no team provenance and does not trigger a machine-wide registry scan, so cross-team recovery must also name `<team>/<handle>`. Nudge then requires argv and sentinel identities to agree when argv was supplied and applies the full exact-session/designated-pane/harness authorizer before copy-mode cancellation and again before each Enter. `--pane` selects a candidate pane but never bypasses this sentinel-bound check.

**Sender-bus-owned invariant:** The canonical payload (`payloads/<id>.md`), the `.sent` receipt, and the `.done` receipt all live on the **sender's bus** (`TAP_HOME` of the sending worktree). Delivery injects into the recipient’s pane and, when verified, advances its bound recipient delivery clock; read/reply resolve and write the sender-bus receipt under their ordinary authority gates. Cross-worktree payloads stamp `cross_worktree: true` and `from_team: <local-team>`, plus `to_team: <target-team>` when team-qualified addressing resolved it. The manual operator-authority escape omits `to_team` because it performs no recipient-registry lookup (§Envelope). The canonical envelope `from`/`to` remain the bare team-local handles.

**Sender pane binding on a manual relay (decision 4, 2026-09-23):** `tap send <h> --cross-worktree --pane <t>` binds the relay TARGET by its own observation; the sender's pane only names who is asking. When a pane-backed sender's stored binding no longer matches its live pane (pane id, server epoch or boot drifted, or the pane is unobservable), the send warns `tap: warning: your seat's pane binding is stale; run tap in to rebind` on stderr and delivers natively. A pane-less poll sender has no binding and skips the check silently. The relay no longer delegates to the Bash send body for this.

**Sentinel path field:** Since v0.23 `path=` is NOT on every sentinel (§Sentinel): it survives for the bare-recipient manual relay and for a send whose sender team the machine index cannot resolve. A registry-resolved cross-team relay therefore carries **no** pointer — its `<team>/` id prefix is the bus locator, and that prefix is what a reader splits to find the sender's bus. The manual relay, which never learns the recipient's team, keeps the pointer precisely because nothing a reader looks up would find that bus. The return-route concern this paragraph used to carry is answered at §v0.16 above: post-flip the machine index is the reply route, made dependable by enrollment at register (R13, tap-nvtx), and the path-derived route is the pre-flip branch. Shape:

```
[[TAP v0.23 <ask|note> teamb/<id> path=<abs-sender-bus>/payloads/<id>.md]]
```

**v0.23 INVERTED WHAT CARRIES THE TEAM, and this sentence used to say the opposite.** tap-cnfm qualified the sentinel's `from=`/`to=` keys and left the id bare; §13 deletes those keys and moves the team ONTO the id slot as a `<team>/` prefix. So on the wire it is now the id that may be qualified, and only ever with the **sender's** team — the prefix is a bus locator (the canonical lives on the sender's bus), not a label naming the recipient, whose team never appears on the wire at all. Same-team traffic takes no prefix anywhere, which is tap-yv3's property restated in the new grammar. **Ids on disk are never qualified**: the prefix is wire-only, and a reader splits it off before opening `payloads/<id>.md`. The manual operator relay carries `path=` instead, because no target team is known and no index lookup would resolve it.

The recipient reads and settles a note from that absolute path with:

```bash
tap read path=<abs-sender-bus>/payloads/<id>.md --by <me>
```

The private reply settlement primitive validates (1) absolute path, (2) basename = `<id>.md`, (3) envelope id matches, (4) when `to_team` is present, it equals the recipient bus's `team.name`, and (5) `to` == actor, then writes `.done` to `<abs-sender-bus>/receipts/<id>.done`. The recipient's `TAP_HOME` supplies identity only; receipt placement always derives from the payload path. Read and reply apply the same team gate to a local canonical, so a sender-side same-name seat cannot settle a foreign-team relay. A team mismatch is `not_addressee` and its recovery names the absolute `--payload` form.

Sentinel fields are unquoted tokens. The **id on disk** uses `^[A-Za-z0-9][A-Za-z0-9._-]*$` (`tap_valid_token`, lib.sh — STRICT, always; the same gate the envelope's `from`/`to`/`kind` and every team/handle half use, and it never accepts `/` or `:`, codex P1). **The v0.23 WIRE id slot is `[<team>/]<id>`** — one optional `/` separating a team prefix from that same strict id, validated as two halves the way `tap_valid_qualified_token` validates a qualified identity; the prefix is stripped before any on-disk use, so no path is ever assembled from a qualified token. `kind` is no longer on the wire at all (it stays in the envelope); its closed-set replacements are the bare tags. Legacy `<team>:<handle>` remains compatibility INPUT only and is never rendered. `path` must contain no whitespace or `]`. A TAP home or payload path with whitespace is rejected fail-closed rather than encoded in v0.2.

