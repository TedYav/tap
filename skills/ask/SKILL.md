---
name: ask
description: "For one bounded prompt needing no TAP seat, follow-up, or lifecycle, run a stateless harness question and print the answer."
argument-hint: '<preset|harness> -f <prompt.md> | -m "..." [--model <tier>]'
allowed-tools: 'Bash'
role: maker
---

# /tap:ask — one-shot harness invocation

```bash
tap ask <preset|harness> -f <prompt.md> | -m "..." [--model <tier>]
```

Pass the prompt exactly one way. `-f <prompt.md>` is preferred and is the literal UTF-8 contents of a regular file; a pipe or process substitution is not a file. `-m "..."` is for short bodies. The split matters because the composing shell evaluates backticks and `$(...)` inside `"..."` before TAP ever runs — TAP treats what arrives as data, but by then the substitution has already happened — so a prompt that quotes commands belongs in a file.

The positional is the door: it takes a preset name or a canonical harness, resolving preset-first. `--preset <name>` is the explicit form and differs in one way worth knowing — it never falls back to a harness, so a catalog typo is `preset_not_found` rather than a confusing harness miss. Reach for it when you want that strictness; otherwise the positional above is the shorter, documented path.

The call creates no TAP pane, registration, bus row, or lifecycle state. Each invocation starts fresh. The answer is stdout; harness diagnostics stay on stderr; the harness exit status passes through.

If the work needs a follow-up conversation, use `tap crew add`; if it needs a durable restartable address, use `tap session launch`.

`--model <tier>` passes that model or named tier to the harness. `--preset <name>` instead takes harness and tuning from the catalog (`tap presets` lists it) — a preset is complete, so it cannot be combined with `--model`. Ask's positional names a PRESET OR A HARNESS — the same grammar `tap crew add` and `tap session launch` take, so a preset needs no flag. `-m "..."` is for short bodies: the composing shell evaluates backticks and `$(...)` inside `"..."` before tap ever runs, so command-shaped prose wants `-f`. A named preset fails loud on a missing or malformed catalog rather than falling back to a default.

Harness names, timeout, absent-CLI refusal, and exit codes: `tap help ask`.
