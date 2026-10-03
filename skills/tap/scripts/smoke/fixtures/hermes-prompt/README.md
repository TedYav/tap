# Hermes prompt capture fixtures

These retain `tmux capture-pane -e -p` captures from the authorized
`tap/hermes-smoke` seat at 80 columns on 2026-09-04. The pane identity was
`%100`, `/dev/ttys073`, PID 44782, command `python3.11`. The captures were
unedited when taken; the retained files have since been passed through the
same-length fixture map (see the 2026-09-26 note below).

- `placeholder.ansi`: untouched idle band. The placeholder is SGR 3 italic with
  foreground `38;5;136`, after the prompt glyph's `38;5;230` foreground.
- `typed.ansi`: the draft `TAP-HERMES-TYPED-CONTROL-7R3FN37`, inserted literally
  and captured without submitting. Its text is not italic and begins after SGR
  39 resets the prompt foreground.

The draft was cleared with `C-u`; a final capture confirmed the marker absent
and the placeholder restored.

2026-09-26: the retained rows were passed through the same-length fixture
map, so the files in this directory no longer match the original captures
byte for byte. The hashes below are of the retained, mapped files; the
original capture hashes were:

- `placeholder.ansi`: original `e7f51c97215446968f7797a4effa0886013d9c1ee3243beca98ee3928c257332`,
  retained (mapped) `abf7120ca7e5fbaae47bf8eac3ee07b225938fa762de02b73f8013be86f32326`
- `typed.ansi`: original `ea3924d51370b50fef67894b130dc6c42bb0538987a280e3403f79e86061b74e`,
  retained (mapped) `22f3da7edcbf811873b766ed8a8ae14e1ee3a8f188bb8f2f2a2c32fa7d592c9b`

The literal hint text is evidence only. Classification keys on the observed SGR
attribute split so a reworded hint stays chrome and typed text stays protected.
