---
user-invocable: false
name: reply
description: "When a payload says reply: expected, answer it and settle the inbound."
argument-hint: "<id> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

# /tap:reply — answer the sender and settle, in one command

The canonical response to an `ask` sentinel (`[[TAP v0.23 ask <id>]]`; [`protocol/delivery/`](../tap/protocol/delivery/README.md)): send the answer to the payload's sender AND settle the inbound in one step, after the outbound is durably accepted as injected or queued. Queued spool replies are correlated against the courier-owned spool payload and metadata before settlement.

Use the harness's native file-writing tool to write the answer at an explicit
repository-local path. Replace `<seat>` and `<request-id>` with your seat and a
fresh request id or unique suffix for this body; pass the same path:

```bash
tap reply <id> -f tmp/<seat>/<request-id>-reply.md
```

Backticks and `$()` stay literal by construction. For stdin without a draft file:

```bash
tap reply <id> -f - <<'EOF'
your answer here
EOF
```

The quotes on `EOF` are load-bearing. `-m` remains available for short shell-safe
text. The positional file form remains a complete payload that may include
frontmatter. A body read or send refusal leaves the inbound unsettled.

When work remains queued, preserve the sender's original tracked obligation while reporting status:

```bash
tap reply <id> --progress -f - <<'EOF'
still working on the gate evidence
EOF
```

Progress reuses ordinary reply routing but emits hard `reply: settle-only` and does **not** settle the
inbound. A later ordinary `tap reply` completes it. Progress refuses `--expect-reply`, a
`reply: settle-only` inbound, and an already-settled id.

Read the payload before replying with `tap read <id>`; keep the `<team>/` prefix for both read and reply. Use `tap read path=<file>` for an explicit pointer. Reading an ask records the read but does not discharge the reply obligation.

Path-aware: a bare `<id>` resolves locally or through enrolled team buses; a payload **path** explicitly selects the sender's bus. Refuses an already-settled payload; replying to an unattended sender needs `--allow-unattended`.

- **`note`** sentinel (`reply: settle-only` in the payload) instead? A successful `tap read` already settled it. If you inspected it without `tap read` and it remains unsettled, run **`tap read <id>`** — never send a got-it. Use `tap reply` on a settle-only payload *only* to report a problem (missing file, wrong premise).
- After replying, continue any useful work that does not depend on the response. Never busy-wait; the sender's next message wakes you. Yield only when the next useful step depends on that response or nothing else remains.

Full flags (`--by`, `--expect-reply`, `--epoch`, `--payload`) and exit codes: `tap help reply` or `skills/tap/SKILL.md`.
