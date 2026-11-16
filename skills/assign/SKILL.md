---
user-invocable: false
name: assign
description: "Hands a teammate a work order over TAP, with a tracked reply obligation. Use when assigning work rather than sharing a note."
argument-hint: "<to> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

# /tap:assign — hand someone WORK

Use the harness's native file-writing tool to create the work order at an explicit
repository-local path, for example `tmp/<seat>/<request-id>-assign.md`, and pass
that same path. Choose a fresh request id for each order:

```bash
tap assign <to> -f tmp/<seat>/<request-id>-assign.md
```

Backticks and `$()` stay literal because the composing shell never sees the body.
Work orders quote commands, so never build one in a double-quoted shell string.
For stdin without a draft file, use a **quoted** heredoc:

```bash
tap assign <to> -f - <<'EOF'
your work order here
EOF
```

`tap assign` is exactly `tap send <to> --expect-reply --kind order` with the ordinary delivery
default. It exists because the flags name TRANSPORT while an author thinks in SPEECH ACTS: on
2026-09-03 five work orders went out as plain settle-only sends and three recipients correctly
refused them as notes, because nothing in the transport objected.

**The obligation and the kind are invariant, not defaults.** The internal flags are appended after
your argv and the parser is last-write-wins, so `tap assign x -f b --kind discuss` still stamps
`kind: order`.

**No `--wake`.** `reply=expected` already defeats the settle-only hold, so a wake flag would add
nothing and imply a property it does not supply.

**Refusals worth knowing before you hit them:**
- `--fyi` and `--note` name a note; assign refuses both and points you at `tap send`.
- An assign from a sender that cannot receive the answer — an unattended `--from` with no deliverable
  `reply_to` — is refused rather than downgraded. The downgrade would produce `kind: order` with
  `reply: settle-only`: a payload asserting it is work while nothing tracks it.

Related: `/tap:send` a note · `/tap:reply` an answer · `/tap:escalate` a question for the user ·
`tap ask` is unrelated (a one-shot headless question owning no TAP state).
