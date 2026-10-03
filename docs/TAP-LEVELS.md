# The five levels of TAP

Start with two agents and a real answer. Grow the team when the work needs it.
Each short page shows what you can do, a runnable example, what the level adds
and where to go deeper.

| Level | What you can do |
|---|---|
| [1. Two agents, one conversation](cheatsheet-level-1.html) | Claude talks to Codex. That alone can take a change from an idea to a reviewed implementation. |
| [2. A team in one project](cheatsheet-level-2.html) | Give seats names and jobs. You can hand off work, track answers and let several writers move at once. |
| [3. Teams across projects](cheatsheet-level-3.html) | A team in one project can ask another team about the code it owns. |
| [4. Teams that organize themselves](cheatsheet-level-4.html) | Give a lead a goal. It can split the work, staff lanes and bring their results through review. |
| [5. Teams that run and evolve](cheatsheet-level-5.html) | Keep a team working through a long backlog, with supervision, handoffs and roles that grow from repeated needs. |

## Level 1: Two agents, one conversation

After [installing TAP](../README.md#get-your-first-reply), run these in your
project terminal, one at a time:

```bash
tap init
tap launch claude
# After Claude opens, Ctrl-b then d returns to your terminal.
tap launch codex
```

TAP starts and registers each seat. From a foreground terminal, launch opens
the agent; otherwise use `tap attach claude` or `tap attach codex` to visit it.
Finish trust and sign-in prompts yourself. Launch uses your saved permission
choice, or bypass mode by default; [choose auto mode](GETTING-STARTED.md#run-without-bypass-mode)
before launching if you prefer it.

Ask either agent:

> Run tap team to see the roster, then ask the other agent whether our first
> tiny project should start with a README or a test. Show me its actual reply.

Done means the **answer text in the asking pane**. Two seats can plan and build,
review across model families, compare designs or investigate a bug together.
This is often all you need.

[Start the five-page guide](cheatsheet-level-1.html) or follow the
[first-team walkthrough](GETTING-STARTED.md).

## When another tool fits

TAP is a file bus and a tmux courier on one machine. There is no server to run,
no workflow it imposes, and you stay in the panes. Its agents share your
machine and your permissions; read [SECURITY.md](../SECURITY.md) to decide
whether that fits your threat model. You have outgrown TAP, or want something
different, when you want one of these.

**A server that agents connect through.** A broker or runtime can carry agents
across machines, keep their terminals alive when you disconnect, or run as a
hosted service.

- [Agent Relay](https://github.com/AgentWorkforce/relay#readme) is an
  open-source toolkit for running coding agents together. Agents talk through
  shared channels, threads and direct messages, and can run on different
  machines in the same workspace. It offers a hosted cloud or self-hosting.
- [Herdr](https://github.com/herdrdev/herdr#readme) describes itself as "the
  runtime your coding agents live on". A background server keeps terminals
  running when you close the client or lose SSH, local and saved remote
  machines share one window, and each pane is marked working, blocked or idle.
  Agents can spawn panes and prompt each other through its CLI and socket API.

**Orchestration with strong opinions.** TAP hands you simple primitives (send,
ask, assign, roles) and lets the team organize itself. Use a tool with a
built-in process when you want the rules enforced in code rather than
suggested in a skill. Agent Relay's Flows, for example, define multi-step
workflows in TypeScript with deterministic checks, required steps and human
gates.

**A factory that runs without you in the panes.** TAP keeps you watching and
steering. Use a management layer when you would rather set goals and check in
from a dashboard.
[Paperclip](https://github.com/paperclipai/paperclip#readme) is an open-source
Node.js server and React UI for managing AI agents at work. You assign goals
and track work and costs from one dashboard, with org charts, budgets and
approvals, while agents run around the clock.
