---
name: escalate
description: "When only the user can unblock work, escalate the question."
argument-hint: "-f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

# /tap:escalate — ask the user directly

`tap escalate` asks the configured notifier to alert the user. The default is a
desktop notification; phone delivery requires a configured command. A successful
receipt confirms the notifier accepted the alert, not that the user saw it. The
question goes to the notifier, not to another agent or a queue someone has to notice.

Use the harness's native file-writing tool to write the question at an explicit
repository-local path. Replace `<seat>` and `<request-id>` with your seat and a
fresh request id or unique suffix for this body; pass the same path:

```bash
tap escalate -f tmp/<seat>/<request-id>-question.md
```

Or use a quoted heredoc:

```bash
tap escalate -f - <<'EOF'
Ship tonight or hold for the design review?
EOF
```

The notification content is the question followed by your team and seat:

```
Ship tonight or hold for the design review? — tap/opus-debugger
```

How that text appears depends on the notifier. The seat name is the point: it tells them which pane to attach to, so they can
answer you **in your own pane** rather than relaying an answer back through
someone else.

## When it helps

Not duties — situations where reaching for this beats the alternative:

- A step needs input only the user can give, and they may be away from the keyboard.
- A fork you'd rather they saw before you commit to one side.
- Extra confirmation before something destructive or hard to reverse, especially
  when the instruction reached you second-hand.
- Lifting a pause the user set personally — only they can lift it.

**Not escalating is never a violation.** If the question can wait for their next
message, save it and keep going. Judgment about which is which is yours.

## Escalating is not stopping

Send it, then **keep working on whatever doesn't depend on the answer.** A
pending escalation never parks a lane. This is the same rule as every other TAP
send: don't `sleep`, don't poll — the answer arrives when it arrives, and you
have other work in the meantime.

## How to write one

The **first non-empty line of your body is the question** — that single line is
what is sent to the notifier, so make it answerable at a glance. Everything after
it stays local as depth for when they attach.

For a question with commands or backticks, write it to a file first — backticks
stay literal by construction. The quoted heredoc is the alternative:

```bash
tap escalate -f - <<'EOF'
Retarget onto origin/main, or wait for the base PR to land?
Base squash-merged under me; `git rebase --onto origin/main <sha>` is ready to run.
Meanwhile I'm finishing the smoke rework, which doesn't depend on the answer.
EOF
```

The quotes on `EOF` are load-bearing: an unquoted delimiter or double-quoted
`-m "..."` lets the shell **execute** backticks and `$(...)` before `tap` runs.
`-m` remains available for short shell-safe questions.

## Priority: normal or urgent

Two priorities. **Normal** is the default. **`--urgent`** renders `🚨` first and
means drop everything.

Urgent fits when waiting produces a worse outcome than interrupting:

- A hard blocker is parking a lane — work has stopped, not slowed.
- A critical or hard-to-reverse decision is about to be made on doubt.
- Something is going wrong now and the window to catch it is short.

Which of those you're in is your call. There is no quota and no rationing rule
here on purpose — the user's stated preference is explicit:

> I prefer escalations rather than bad decisions or blockers.

So the failure mode to avoid is not interrupting too often; it's guessing at a
fork you could have asked about, or sitting on a blocker quietly. If you're
weighing whether something clears the bar, that hesitation is usually itself the
signal that it does.

## One open escalation per question

Before sending, check whether the same fork is already in flight: your leader may
have escalated it, or you may have already asked. **Never re-fire an unanswered
escalation** — a second copy of a question the user has already seen doesn't make
them answer faster, it just costs them the read.

## If you have no pane

The notification names *you*, so `--from` must be a registered seat — that's what
makes the label truthful. If you're a pane-less script or daemon, pass
`--from <handle> --team <team>` explicitly; the notifier is asked to alert the user, but as a
**one-way** message, since there's no pane for them to answer into. Say so in the
question when it matters. A subagent should route through its parent seat rather
than escalating on its own.

## Exit codes

`0` means the notifier accepted the alert; human receipt is unconfirmed. On failure,
read the explanation and add `--json` for the `error_class`; the status alone is not
enough, because a notifier's own exit status can be 1 or 2 too:

- `notify_user_missing` — no notifier executable was available and nothing was
  attempted. Say so rather than treating it as sent.
- `notify_timeout` — delivery unknown. TAP makes one attempt and never retries or
  falls back, so decide deliberately before asking again.
- `notify_failed` — the notifier exited nonzero, was cancelled, or could not start;
  the exit status is the notifier's own and delivery is unconfirmed (the message says
  when nothing was attempted).
- Usage, identity and notifier-configuration refusals (such as `unregistered_from`
  or `notify_config_invalid`) exit 1 before any notifier runs.

Reference: `tap help escalate`; the notifier table and exit evidence live in
[the escalation protocol page](../tap/protocol/messages/escalation-tap-escalate-v0-21.md).
