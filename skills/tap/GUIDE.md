# TAP agent guide

Use this page to translate a task into the smallest authoritative read. Exact syntax is `tap help <verb>`; detailed semantics live under [`protocol/`](protocol/README.md).

## Find a topic

Resolve the installed directory:

```sh
tap help skill tap
```

Then search without loading the corpus:

```sh
rg -n -i -C 2 'term|alias' <tap-skill-dir>/GUIDE.md <tap-skill-dir>/protocol
```

## Common tasks

| Task or search words | Start here | Exact grammar |
| --- | --- | --- |
| ask sentinel, note, settle, got-it | [read mail](protocol/messages/reading-your-own-mail-tap-read-v0-23-part-01.md) | `tap help read`, `tap help reply` |
| send note, assign work, literal body | [quick reference](QUICK-REFERENCE.md) | `tap help send`, `tap help assign` |
| different worktree, foreign team, sender bus | [cross-worktree relay](protocol/delivery/cross-worktree-relay-unit-2b-part-01.md) | `tap help send`, `tap help reply` |
| did they receive it, queued, injected, processed | [delivery policies](protocol/delivery/delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-01.md) | `tap help outstanding` |
| wake later, remind, wake when CI finishes | [reminders](protocol/supervision/health-liveness-not-integrity-part-01.md) | `tap help remind` |
| cancel reminder, kill command, UNOBSERVABLE | [quick reference](QUICK-REFERENCE.md) then [reminders](protocol/supervision/health-liveness-not-integrity-part-01.md) | `tap help remind` |
| stuck message, nudge, uncertain delivery | [sentinel and recovery](protocol/delivery/sentinel-the-wire-poke-zero-authority-part-01.md) | `tap help nudge`, `tap help detective` |
| temporary reviewer, consult, durable lane | [getting started](guide/getting-started.md) | `tap help ask`, `tap help crew`, `tap help session` |
| roster, teams summary, status dots, `--details` | [team CLI](protocol/delivery/cli-surface-the-whole-thing-part-09.md) | `tap help team`, `tap help teams` |
| registry schema, identity authority | [registry](protocol/identity/registry-unit-1-part-01.md) | `tap help team`, `tap help whoami` |
| reset, historical checkpoints, shutdown | [admin and reset](protocol/identity/admin-namespace-tap-admin-machine-wide-operator-verbs-v0-4-part-01.md) | `tap help team` |
| shared worktree, writer token, lane custody | [worktrees and handoffs](../tap/references/worktrees-and-handoffs.md) | explicit TAP custody handoff |
| smoke isolation, full gate, sandbox | [gates and testing](protocol/gates/README.md) | repository `AGENTS.md` |
| driver behavior, pane effects, submit verify | [delivery and recovery index](protocol/delivery/README.md) | `tap help advisory` |
| skill that uses TAP, fallback, no tmux, cloud, CI, `.tap-fallback.md` | [writing TAP skills](guide/writing-tap-skills.md) | `tap help whoami` |
| customize TAP, launch default, new harness, new command, fork | [extend skill](../extend/SKILL.md) | `tap help skill extend` |

## Browse by area

- [Transport and trust](protocol/transport/README.md)
- [Messages and obligations](protocol/messages/README.md)
- [Identity and lifecycle](protocol/identity/README.md)
- [Delivery and recovery](protocol/delivery/README.md)
- [Supervision and reminders](protocol/supervision/README.md)
- [Coordination](protocol/coordination/README.md)
- [Gates and testing](protocol/gates/README.md)
- [Harness drivers and appendices](protocol/harness/README.md)
- [Protocol evolution](protocol/evolution/README.md)

## Reading rule

Open the routed page, not the whole corpus. Follow adjacent source parts only when the answer crosses the recorded byte boundary. When code or tests disagree with prose, stop and report the contradiction; do not silently choose one authority.
