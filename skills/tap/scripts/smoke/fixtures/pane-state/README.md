# pane-state fixture corpus

**Anonymization (tap-w7fv0).** For the public copy, seat handles, PR numbers, hosted-session link targets and one maintainer name inside the captured bytes were replaced with same-width synthetic stand-ins, applied consistently across each capture, its derived copies and the tests that read them; geometry, escape sequences and line counts are unchanged. Names in this document, including pointers into private evidence directories, use the same stand-ins, so such pointers no longer resolve by name. Checksums and any "verbatim", "unedited" or "byte-for-byte" wording describe the capture as recorded before this step. Every sha256 in this README is the original pin recorded when the fixture was harvested; for a fixture whose bytes were anonymized it no longer matches the committed file, and the committed hash is in the last table.

## B1 pins (2026-09-01, lane BunDetectorNight)

Pinned from parked U1 at `feat/courier-port-a` `af443aad7dd7d7697104cc1f4eaddda1b15e0161` (CourierPortA worktree). Not a new live capture. Copy-mode is `pane_in_mode=1`, not a capture file.

| Stem | Shape | Classification | Provenance (parked U1 README) | sha256 `.txt` / `.esc` |
|---|---|---|---|---|
| `claude/idle-current` | idle | `ready` | live `%419` (`tap/maple-8-29`) 2026-08-29T15:21:30Z | `e73ec1271371162dcdc58f025edac9f04c338fd23be983b2656714f93c614ebb` / `c21af0247ff4d563a3404a21bdd90af6faeb53ffe57bf0d0905dbb1d028f136a` |
| `claude/obibm-clear-hint` | idle-Claude chrome FP (AE4 / tap-obibm) | `ready` | live history extract `%0` (`tap/maple-8-29`) 2026-08-30T05:43:26Z; `/clear to save 347k tokens` | `79030b94124b7e454cfffe050fdb9023c90b701fe3494c2282395399702958a6` / `4e89a2e072b5ef4c4d3823b71571b611e39ccb77cf02c5fe53b4a9333030b301` |
| `claude/wrapped-draft` | draft | `draft` | constructed from idle-current | `779e5dff201d1816e32d314c066c0aa6b0a80f3e1b46a819526de33322a8dfe2` / `2e1329b766ae74ceb1af29d33a82f55b3512ce0ce94a163eb4eb941717f574ac` |
| `claude/no-prompt-surrogate` | dialog / no-band | `no-band` | constructed: deleted `❯` row from idle-current | `6cbccbd0e9abce6307291b563d74b845f8fed968a797bf4919b050996c2fafd3` / `fcd7344244498dc0f312cb280c165d02e43a22e8bdedb71fce3f171c709b616b` |
| `claude/mid-turn-queued-input` | mid-turn queued | `draft` (OQ1 ruling `maple-xhigh-architect-20260830T042044Z-dfcd82520fdb`) | live `%435` (`tap/courier-capture`) 2026-08-29T15:24:32Z | `294a869096a796fd082245694cafc5474a5025a439d45d5e98d9f479d976fb58` / `877b7aabb56abf0575d616d5f1e63146abd2b879a3863247781dfd41bc6e1e38` |
| `claude/mid-turn-human-draft` | mid-turn human falsifier | `draft` | derived from queued-input geometry | `795d4927c504a01286d09401577766ba17783934c8aca0a3c9fcd57e39e113f2` / `ef630faa56e15137c53a709d1af4cd0055246837dabb88d86c8aa56b53a46e6b` |

B1 does **not** pin the 18-stem Cartesian matrix (Codex/Cursor/OpenCode/Agy/Hermes). Those remain parked U1 inventory.

## Unit 1 surrogate (tap-g8sxk, still on this tree)

Harvested at BASE `b2d23d6b8343701c155c2815e3e4728d9c88e2f5`. Live pane captures were not taken. Capture command/pane for existing adapters is unknown.

The harvested Claude idle-band pair is a causal surrogate for incumbent bottom-border/footer false-busy (`bandState` leftover text after the last `❯`). The `/clear to save …` line is absent from this surrogate; AE4 uses `claude/obibm-clear-hint` above.

## Harvested this unit

| File | Role | Provenance |
|---|---|---|
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-band.ansi` | byte-identical `-e` harvest | `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-idle-band.ansi` sha256 `a12cf6553a3fb0171f8176cadb2a11850ac29e37175095d1e55e9ddc3cf9a130` (1376 bytes) |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-band.txt` | plain `-p` bytes `bandState` consumes | deterministic transform of that `.ansi`: strip OSC `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` then CSI `\x1b\[[0-?]*[ -/]*[@-~]`; no other edits. sha256 `5da463c4c3b53235fd59c62741c03e94a40d5454cc58782e7bec05ff1433e261` (1277 bytes) |

Not harvested as this control's oracle: `peek-harness-adapters/claude-code-session-limit.ansi` (A2 PARKED), `peek-harness-adapters/claude-code-idle.ansi` (dim box text).

## Harvested tap-maavp U2 (2026-09-19)

Bounded dated rows for the queued-chrome classification. All three derive from fixtures already pinned in this repo; no new live capture.

| File | Role | Classification | Derivation | sha256 |
|---|---|---|---|---|
| `claude/20260906-queued-placeholder.ansi` | dim `Press up to edit queued messages` placeholder + real queued row | `ready` | byte-copy of `submit-verify/claude-queue-after.ansi` (gemini sentinel capture, 2026-09-06) with per-row trailing cell-pad spaces stripped; SGR and NBSP bytes otherwise untouched | `8bd546b4c8cdc26703262fdd8a5ce4ba19e5cb707fe6bf32db5d9bed7399ca99` |
| `claude/20260918-queued-live-draft.ansi` | live human draft `Com` above the fence + real queued row | `draft` | byte-copy of `submit-verify/claude-queued-live-draft-claudebar.ansi` (U1 specimen fixture) | `cee443993022e83eb18310ab4d6c9c93d8a46f3079a4582ae0d896e16e4ae861` |
| `claude/20260918-queued-empty.ansi` | emptied composer above the fence + real queued row | `ready` | same specimen with the composer text `Com` removed (`❯` + NBSP + SGR-reset tail retained) | `9a50c7915039ff1da79e2cbe5d7bd0383d96cd272aec61b01db103ce0bd9cb8c` |

## Live tap-ybz1s captures (2026-09-23)

Claude Code 2.1.280, fresh sandbox HOME, runner-private tmux, dummy key, never Enter; `capture-pane -p -e`. Before the fix, `paneState` read both empty frames as `busy`.

| File | Role | Classification | sha256 |
|---|---|---|---|
| `claude/20260923-try-empty-100.ansi` | empty composer, dim `Try "refactor <filepath>"`, 100 columns | `ready` | `1160199db52874ebf6e9855af600c54d974acfc6c66043a56d762960a81211d7` |
| `claude/20260923-try-empty-145.ansi` | empty composer, dim `Try "write a test for <filepath>"`, 145 columns | `ready` | `60975bbbe214a6ab78f00ca9a3cd868cde7567eea587b4479a9bfd456ed391e0` |
| `claude/20260923-try-typed-100.ansi` | typed `Try this plain draft of mine`, normal intensity | `draft` | `12d00d615a40a1093e45397b18addb032e9f2f6654eb19ea8ec4f811dbc3ca38` |

## Inventory — submit-verify (54)

| Path | Filename shape | Provenance |
|---|---|---|
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-draft-bracket-text.ansi` | `claude-draft-bracket-text` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-draft-cursor-at-start.ansi` | `claude-draft-cursor-at-start` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-draft-cursor-mid-line.ansi` | `claude-draft-cursor-mid-line` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-legacy-lines-paste-collapse.ansi` | `claude-legacy-lines-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-legacy-paste-collapse.ansi` | `claude-legacy-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-paste-collapse.ansi` | `claude-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-bare-hint-text.ansi` | `claude-slash-bare-hint-text` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-courier-residue.ansi` | `claude-slash-courier-residue` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-before-cursor.ansi` | `claude-slash-hint-before-cursor` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-clear.ansi` | `claude-slash-hint-clear` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact.ansi` | `claude-slash-hint-compact` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-unpainted.ansi` | `claude-slash-hint-compact-unpainted` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-full.ansi` | `claude-slash-hint-compact-full` | live recapture 2026-09-01T18:53:54Z private socket `grok-colour-2x2` cell A pane `%0`; Claude Code 2.1.252 (version not load-bearing); `CLAUDE_CODE_TMUX_TRUECOLOR=1` (required under tmux), `COLORTERM=truecolor`, no `NO_COLOR` / `FORCE_COLOR=0`; census `38;5=0` `38;2=7` on the banked last-4-row extract; pane_width 80, prompt row 56 cells, whole placeholder. Reproduction: set the truecolor variable in the pane command; census for `38;5` before banking. sha256 `b9698498a568ad3b6edbe490c15f85d3bc2d03838b3a86ad7c94fd83f3b745c9` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-full-256.ansi` | `claude-slash-hint-compact-full-256` | non-authoritative environment regression, HEAD-only, never BASE-vs-HEAD input, not the Bun parity target. Original `%185` (`tx3s-hint-capture`) 2026-09-01T17:54:03Z; hand-rolled tmux missing `CLAUDE_CODE_TMUX_TRUECOLOR` (sufficient for 256-colour under tmux even with `COLORTERM=truecolor`); that launch also inherited `FORCE_COLOR=0`/`NO_COLOR=1` from the Cursor client (second sufficient path). Hint `38;5;246` = rgbToAnsi256 of production `38;2;153;153;153`. sha256 `c63d3b588904a1dac36922ddb5fb2c7559db3b000e0d55899fb7b6440adda94e` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-truncated-53.ansi` | `claude-slash-hint-compact-truncated-53` | live recapture 2026-09-01T18:53:55Z private socket `grok-colour-2x2` cell A pane `%0`; Claude Code 2.1.252 (version not load-bearing); `CLAUDE_CODE_TMUX_TRUECOLOR=1`, `COLORTERM=truecolor`, no `NO_COLOR` / `FORCE_COLOR=0`; census `38;5=0` `38;2=6` on the banked last-4-row extract; pane_width 53, prompt row exactly 53 cells ending U+2026. sha256 `65736be275b6cc0a1dae46263454296596b91cae96cb479fc248e370d1250334` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-truncated-n2-custum.ansi` | `claude-slash-hint-compact-truncated-n2-custum` | constructed from the truecolor 53 recapture; hint `<optional custum…` is not a prefix of the table entry; census `38;5=0`; sha256 `e654fb3ba7675e350e146211835b18a0d0ee30251a224f97ae294476744cadca` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-truncated-n3-empty.ansi` | `claude-slash-hint-compact-truncated-n3-empty` | constructed from the truecolor 53 recapture; empty prefix plus U+2026; census `38;5=0`; sha256 `72bdab07567ebf59b59648975fff77f1c3f5670d539aa1b961b5c068cb5ec7ff` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-truncated-n4-wrong-command.ansi` | `claude-slash-hint-compact-truncated-n4-wrong-command` | constructed from the truecolor 53 recapture; `/goal` plus the truncated `/compact` placeholder; census `38;5=0`; sha256 `19cc8b955907ee888c7c278e79cd97924f72d18da0a421775d33a7c3e24c053b` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-cursor-blink.ansi` | `claude-slash-hint-cursor-blink` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-cursor-home.ansi` | `claude-slash-hint-cursor-home` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-cursor-left.ansi` | `claude-slash-hint-cursor-left` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-cursor-left2.ansi` | `claude-slash-hint-cursor-left2` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-goal-unpainted.ansi` | `claude-slash-hint-goal-unpainted` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-goal.ansi` | `claude-slash-hint-goal` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-loop.ansi` | `claude-slash-hint-loop` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-neargray.ansi` | `claude-slash-hint-neargray` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-theme-dark.ansi` | `claude-slash-hint-theme-dark` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-theme-light.ansi` | `claude-slash-hint-theme-light` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-three-blanks.ansi` | `claude-slash-hint-three-blanks` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-white.ansi` | `claude-slash-hint-white` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-wording-drift.ansi` | `claude-slash-hint-wording-drift` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-idle-band.ansi` | `claude-slash-idle-band` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-mismatched-command.ansi` | `claude-slash-mismatched-command` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-muted-real-draft.ansi` | `claude-slash-muted-real-draft` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-second-command.ansi` | `claude-slash-second-command` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-typed-angle-arg.ansi` | `claude-slash-typed-angle-arg` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-unknown-command.ansi` | `claude-slash-unknown-command` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-wrapped-draft.ansi` | `claude-slash-wrapped-draft` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/codex-paste-collapse.ansi` | `codex-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/codex-status-1token-constructed.ansi` | `codex-status-1token-constructed` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/codex-status-2token.ansi` | `codex-status-2token` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/codex-status-3token.ansi` | `codex-status-3token` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/codex-status-invalid-effort.ansi` | `codex-status-invalid-effort` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/cursor-paste-collapse.ansi` | `cursor-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-command-palette-nomatch.ansi` | `opencode-command-palette-nomatch` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-command-palette.ansi` | `opencode-command-palette` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-draft-alone-ends-with-border.ansi` | `opencode-draft-alone-ends-with-border` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-draft-ends-with-border.ansi` | `opencode-draft-ends-with-border` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-draft-fills-box-ends-with-border.ansi` | `opencode-draft-fills-box-ends-with-border` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-large-paste.ansi` | `opencode-large-paste` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-overlay-samerow.ansi` | `opencode-overlay-samerow` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-overlay-widespace-draft.ansi` | `opencode-overlay-widespace-draft` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-paste-collapse.ansi` | `opencode-paste-collapse` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/submit-verify/opencode-short-paste-collapse.ansi` | `opencode-short-paste-collapse` | checked-in fixture; live pane/command unknown |

## Inventory — peek-harness-adapters (24)

| Path | Filename shape | Provenance |
|---|---|---|
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-code-idle.ansi` | `claude-code-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-code-session-limit.ansi` | `claude-code-session-limit` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-code-working.ansi` | `claude-code-working` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/codex-idle.ansi` | `codex-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/codex-working.ansi` | `codex-working` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-firstload-idle.ansi` | `cursor-firstload-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-idle-placeholder-undimmed-firstload.ansi` | `cursor-idle-placeholder-undimmed-firstload` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-idle-placeholder-undimmed.ansi` | `cursor-idle-placeholder-undimmed` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-idle-stale-ctrlc.ansi` | `cursor-idle-stale-ctrlc` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-idle.ansi` | `cursor-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-midfill-idle.ansi` | `cursor-midfill-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-working-wrapped.ansi` | `cursor-working-wrapped` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/cursor-working.ansi` | `cursor-working` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-deepseek-idle-under-rule.ansi` | `hermes-deepseek-idle-under-rule` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-firstload-idle.ansi` | `hermes-firstload-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-idle.ansi` | `hermes-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-profile-prompt-idle.ansi` | `hermes-profile-prompt-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-working.ansi` | `hermes-working` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-firstload-idle.ansi` | `opencode-firstload-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-narrow-idle.ansi` | `opencode-narrow-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-narrow-sentinel.ansi` | `opencode-narrow-sentinel` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-narrow-working.ansi` | `opencode-narrow-working` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-idle.ansi` | `opencode-wide-idle` | checked-in fixture; live pane/command unknown |
| `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-working.ansi` | `opencode-wide-working` | checked-in fixture; live pane/command unknown |
| `runtime/bun/test/fixtures/opencode-capture/all-wrapped-160.plain.txt` | `opencode-all-wrapped-160-plain` | sanitized minimal reproduction derived from a live 2026-09-12 OpenCode 1.18.30 capture; private transcript/path and trailing cell padding removed, source was 160×63 and all 63 physical rows are retained; sha256 `6a89202762e93614a46953b4527d8c6b41bdf81d5845598151c995c84ded0848` |
| `runtime/bun/test/fixtures/opencode-capture/all-wrapped-160.joined.txt` | `opencode-all-wrapped-160-joined` | same sanitized specimen after `capture-pane -p -J`; every physical row carried tmux's wrap flag and collapsed to 1 line; trailing cell padding removed; sha256 `4c01a5e42a5aff5f93821d0c3e6a1f363138094c857ebe59e344cbaede75008d` |
| `runtime/bun/test/fixtures/opencode-capture/conversation-164.plain.txt` | `opencode-conversation-164-plain` | sanitized minimal reproduction derived from the live wide-start sibling; private transcript/path and trailing cell padding removed, source was 164×63 and all 63 rows are retained; sha256 `f8cb6de2b41744f616355666bd80a224ed7e53a7e5b0c23d4372dd05e0ae1ccb` |
| `runtime/bun/test/fixtures/opencode-capture/conversation-164.joined.txt` | `opencode-conversation-164-joined` | same sanitized sibling after `capture-pane -p -J`; retained 63 lines; sha256 `f8cb6de2b41744f616355666bd80a224ed7e53a7e5b0c23d4372dd05e0ae1ccb` |

## Missing captures (not taken)

- Exact tap-obibm dogfood: **pinned in B1** as `claude/obibm-clear-hint` (see table above). The Unit 1 surrogate still lacks the `/clear` line.
- Remaining idle/mid-turn/draft/dialog per non-Claude harness, including Hermes. Copy-mode is a tmux mode flag, not a capture. The 18-stem parked U1 matrix is not copied into this tree.

## Committed hashes of anonymized fixtures

| File | Original pin | Committed sha256 |
|---|---|---|
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/20260906-queued-placeholder.ansi` | `8bd546b4c8cdc26703262fdd8a5ce4ba19e5cb707fe6bf32db5d9bed7399ca99` | `09b46e87a7cd52d5aaeb03fe41a1e109a513963f147960de5ff967bc2681f359` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/20260918-queued-empty.ansi` | `9a50c7915039ff1da79e2cbe5d7bd0383d96cd272aec61b01db103ce0bd9cb8c` | `e4aabee51c6213bde947e940a375e7a7661f5dbebe30ac764f3a40203c7b76c0` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-current.esc` | `c21af0247ff4d563a3404a21bdd90af6faeb53ffe57bf0d0905dbb1d028f136a` | `74892a94bec2f2030e9377f1fe0777f64640039fb6ee1c49371c456b3151a187` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/idle-current.txt` | `e73ec1271371162dcdc58f025edac9f04c338fd23be983b2656714f93c614ebb` | `78185fd7341ed3da7241d37c273c6a0238a3fc0ac1587fdd95786c161bc9d2bb` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/mid-turn-human-draft.esc` | `ef630faa56e15137c53a709d1af4cd0055246837dabb88d86c8aa56b53a46e6b` | `da1780f57b8e97066adb8e49242ae11232e62624e1ab35f485e32c4e066f92a6` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/mid-turn-queued-input.esc` | `877b7aabb56abf0575d616d5f1e63146abd2b879a3863247781dfd41bc6e1e38` | `a5031db57d30396d998e367c5375a89ea4cc2168900f72dbe882daa5c911c746` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/no-prompt-surrogate.esc` | `fcd7344244498dc0f312cb280c165d02e43a22e8bdedb71fce3f171c709b616b` | `c3ef3003a21f0487ebcf873a1488e33944d7b8801108bf01e5e96e728662981a` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/no-prompt-surrogate.txt` | `6cbccbd0e9abce6307291b563d74b845f8fed968a797bf4919b050996c2fafd3` | `4e01608f72669f992194d7693edccee60b7937f37996ec3c947d3ade62a31e98` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/obibm-clear-hint.esc` | `4e89a2e072b5ef4c4d3823b71571b611e39ccb77cf02c5fe53b4a9333030b301` | `a11d8b8922fe99d2b86b9261627f998313df6da560e2951f3636db9eac2ef423` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/obibm-clear-hint.txt` | `79030b94124b7e454cfffe050fdb9023c90b701fe3494c2282395399702958a6` | `90b16facbef37e8824a5b416a0faa0cb78bba7ae38c648edd118bb9d467967ac` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/wrapped-draft.esc` | `2e1329b766ae74ceb1af29d33a82f55b3512ce0ce94a163eb4eb941717f574ac` | `7f275f989cbf432fcf8f2922c8f41acbe6a3df2aac8c0b21838efa20d13fda1a` |
| `skills/tap/scripts/smoke/fixtures/pane-state/claude/wrapped-draft.txt` | `779e5dff201d1816e32d314c066c0aa6b0a80f3e1b46a819526de33322a8dfe2` | `b9be4847a45af5cc8ead1a7e76b2e0759bf8d8f2791ea174b3600dbbb5ec1318` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-queued-live-draft-claudebar.ansi` | `cee443993022e83eb18310ab4d6c9c93d8a46f3079a4582ae0d896e16e4ae861` | `c72274bc1035c693d196cddaac1af1b0d7e276bd7a96c8bb65899fa9cabd0f33` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-full-256.ansi` | `c63d3b588904a1dac36922ddb5fb2c7559db3b000e0d55899fb7b6440adda94e` | `b619f70a18e97427fd8e46060f1c45f6d9b76f2397e13bbd5d5114f74e550df0` |
| `skills/tap/scripts/smoke/fixtures/submit-verify/claude-slash-hint-compact-full.ansi` | `b9698498a568ad3b6edbe490c15f85d3bc2d03838b3a86ad7c94fd83f3b745c9` | `2b558faa29d552dfd1626775775bc6af96fbfffdb5735510f3b00c984415593a` |
