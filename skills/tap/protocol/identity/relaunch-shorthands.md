# Relaunch shorthands (`--context`, `--ponytail`)

`tap session relaunch` takes two shorthands on the single-seat and `--harness` forms. Each expands to overrides the seat already accepts through `--env` and the `--` tail, so it [persists the same way](seat-relaunch-tap-session-relaunch-v0-22-part-03.md).

- `--context <size>` takes digits with an optional case-insensitive `k` or `m` decimal suffix (`850k`, `1M` = 1000000, `1.5M`). Zero, negatives, junk and any size that is not a whole number refuse. On claude it sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n>` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95`. On codex it sets `-c model_context_window=<n> -c model_auto_compact_token_limit=<floor(n*95/100)>`.
- `--ponytail off|lite|full|ultra` sets `PONYTAIL_DEFAULT_MODE=<value>` on claude and codex. TAP does not detect the plugin, so the flag has no effect if ponytail is not installed.

**Before any effect.** The expansion runs against the resolved target before the census exclusions. Any other harness refuses (`launch_context_unsupported`, `launch_ponytail_unsupported`) with nothing replaced, so a batch never replaces some seats and then fails. Naming a shorthand's setting in the same command through `--env`, `--unset-env` or the `--` tail refuses `launch_arg_invalid`. Every clap spelling counts: `-c K=V`, `-cK=V`, `-c=K=V`, `--config K=V` and `--config=K=V`. Repeating a shorthand follows the other single-value flags: the last one wins.

**Placement.** Codex's generated options are config, not tail text. They replace earlier stored assignments of their two keys in any of those spellings, so repeating `--context` never stacks pairs. They are inserted before the first native `--` of the composed tail, stored or typed, because codex reads anything after it as positional text. An ordinary `--` tail still only appends.

**Precedence.** The values beat preset and machine-policy values. On claude the seat's stored environment outranks policy. On codex the tail follows the resume id, after the stored passthrough, and codex keeps the last `-c` for a key (observed on codex-cli 0.166.0). A preset's own assignment stays on the row, shadowed.
