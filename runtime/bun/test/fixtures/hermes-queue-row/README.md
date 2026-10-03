# Hermes `/queue` row fixtures (tap-rhajr)

Two live 144-column captures of the `demo-app/hermes-agent` seat (pane
`demo-app/hermes-agent:0.0`, Hermes on `deepseek-v4.1-flash`) on 2026-10-01 UTC,
holding the same courier wire.

- `mid-turn-staged.ansi`: the courier's own `submit-unverified.frame` receipt
  for `aspen-ponytail-20261001T061307Z-823e7d31b544`, captured at
  06:13:09Z with `capture-pane -e`. The `/queue` wire sits in the working
  composer, whose `⚕ ❯ ` prompt is painted italic `38;5;136`; the wire splits
  mid-word across the 144-cell wrap. The courier read it unobservable and never
  pressed Enter.
- `idle-staged.ansi`: `tap nudge --aggressiveness report-only` of the same
  pane about 18 minutes later, after the turn ended. The same wire now sits behind
  the at-rest `❯ ` prompt, split at a space. Its three header lines (the nudge
  receipts) are dropped.

Both are trimmed to the band: the row above the status line, the status line,
the composer's top rule, the prompt and wrap rows, and the footer rule. The
transcript above them belonged to another team's seat and is not retained.
The wire's `preview` text was replaced letter for letter (`fixture…`), keeping
every space, punctuation mark and length, so each wrap point is unchanged. The
status line's session title became `Example session title......`, at the same
length. For the public copy (tap-w7fv0) the sending seat's handle in the stamped note id was
likewise replaced with a same-width stand-in in both captures and in the test's id constant; the
"Original sha256" column is unchanged and the "Retained sha256" column now describes the committed bytes. `publish/fixture-map/fxmap.py scan` reports zero hits on both files.

| File | Original sha256 | Retained sha256 |
| --- | --- | --- |
| `idle-staged.ansi` | `cf8f93d46657f4b4f98a4ec883c194dabcb68b5a0355d7dcae9f107ad483849e` | `9035744c97f6aec9dc4c90debc1c4baecae8b6d682a672b953ca591968d95f02` |
| `mid-turn-staged.ansi` | `458a4772da8ac346930d8b9db8442eaa5119088f3a531aa86ce94eadaf7a14c7` | `980c5b0606927de9385187964f3659244028757949b06a4245d20caece54b214` |

The empty working composer (`⚕ ❯ msg=interrupt · /queue · …`, all italic
136) is the existing `skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-working.ansi`.
