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

Exit `0` whether or not anything is outstanding: read the rows (or `--json` `outstanding` and `spool_conditions` (parked sends can collapse into a backlog condition); nothing is owed only when both are empty), not the exit. Non-zero means a usage error or a bus that could not be read, never an empty result. An outstanding item means the peer has not settled a message you sent — the sender still owes supervision or an explicit human handoff, so it is the signal **not** to go idle yet.

This is the flip side of the golden rule: after sending, continue any useful work that does not depend on the response. Between useful actions, inspect `tap outstanding` once and supervise what remains; never sleep or loop on it. Yield only when nothing outstanding, queued, or otherwise useful remains, or when the next useful step depends on an inbound result.

`--json` and reference: `tap help outstanding` or `skills/tap/SKILL.md`.
