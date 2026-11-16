---
user-invocable: false
name: outstanding
description: "When checking yield or supervision duties, list the TAP sender's unsettled outbound messages."
argument-hint: '[me]'
allowed-tools: 'Bash'
role: maker
---

# /tap:outstanding — sends still awaiting a `.done`

Before yielding after TAP work, check what you still owe supervision on:

```bash
tap outstanding <me>
```

Exit `0` whether or not anything is outstanding: read the rows (or `--json` `outstanding` and `spool_conditions` (parked sends can collapse into a backlog condition); no send is open only when both are empty), not the exit. Non-zero means a usage error or a bus that could not be read, never an empty result. An outstanding item means the peer has not settled a message you sent. What a row asks of you depends on where the message is:

- **Delivery did not complete:** a `CONDITION:` line, a row that says `spooled (reason: …)`, shows a delivery ladder, or reads `Delivery unverified` or `injected; Enter unconfirmed`. Supervise it: follow the row's own `next:` or explanation, `tap nudge`, `tap resend <id>`, or an explicit human handoff. Do not go idle on these.
- **Waiting on the recipient:** the row says `queued in harness` (the harness accepted it) or `read` (with `unanswered` for an ask), or it shows none of the markers above and was submitted. The `turn unconfirmed` footer alone means only that TAP cannot see the recipient start work. A reply or note you sent that is not yet read is the same case. Nothing to do now: if no other useful work remains, yield; the answer wakes your pane. If an ask has waited far longer than its work should take, check `tap team` and nudge once.
- **Anything you cannot place:** read the row's explanation before yielding; treat it as the first case.

This is the flip side of the golden rule: after sending, continue any useful work that does not depend on the response. Between useful actions, inspect `tap outstanding` once; never sleep or loop on it.

`--json` and reference: `tap help outstanding` or `skills/tap/SKILL.md`.
