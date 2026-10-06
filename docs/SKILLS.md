# TAP skills

TAP's skills are going to be overhauled. For now, start with the key skills
below: `tap:help` for help, `tap:config-wizard` for settings, and `tap:lead`
when you want an agent to lead a team.

## Skills you invoke

These are instructions you give an agent. The examples use native plugin names;
ask your agent to load the named skill if its harness uses another spelling.

| Skill | What you ask the agent to do |
|---|---|
| [tap:help](../skills/help/SKILL.md) | Get started, or diagnose something that seems off. Getting started gets two harnesses exchanging a real reply, then chooses the next useful capability. Diagnosis starts from your symptom (mail not arriving, a stuck seat, copy or Shift+Enter not working, odd colors), runs checks that leave your setup alone, and changes nothing without your yes. Type it as `/tap:help`; bare `/help` is the harness's own help. |
| [tap:config-wizard](../skills/config-wizard/SKILL.md) | Help you configure TAP, including advanced settings, presets, permissions and notifications. |
| [tap:lead](../skills/lead/SKILL.md) | Lead the team: choose a strategy, staff the work and ensure it gets an independent review. |
| [tap:self](../skills/self/SKILL.md) | Run a supported command in its own harness, with the agent composing the argument. For example: “Your context is getting full; /tap:self compact.” Compact, rebrief, goal, loop and clear support depends on the harness; the skill handles required handoffs. |
| [tap:collab](../skills/collab/SKILL.md) | Work with another agent on a task as equal collaborators. They agree who writes, challenges and decides, then use pair or discuss. |
| [tap:pair](../skills/pair/SKILL.md) | Pair program: one agent writes and the other independently reviews after each work turn, tied to the published unit or commit range. It also works for prose and research. |
| [tap:adapt](../skills/adapt/SKILL.md) | Give a modern frontier agent permission to use its judgment to simplify a legacy skill or make it useful across TAP teams. It records the proposed changes and preserves authority boundaries. Interactive mode waits for your go; `mode:agent` applies the changes and records its decisions. |
| [tap:escalate](../skills/escalate/SKILL.md) | Reach you out of band when it needs your decision, through your configured notifier. Notifier acceptance does not prove you saw the question. |
| [tap:discuss](../skills/discuss/SKILL.md) | Discuss a plan, review or decision with another agent using a defined protocol, and arrive at a recommendation. Exchanges are bounded and open issues are recorded. |

For larger teams, you can also ask for these roles or workflows:

| Skill | When it helps |
|---|---|
| [tap:crew](../skills/crew/SKILL.md) | Bring in a short-lived consult or review seat when the conversation needs follow-up. Crew seats share the current tmux session; they are not parallel implementation writers. |
| [tap:drive](../skills/drive/SKILL.md) | Give an agent ownership of one implementation lane, including custody, commits, checks and closeout. |
| [tap:conduct](../skills/conduct/SKILL.md) | Have an agent assist a leader with staffing, dispatch, review routing and escalation under the leader's charter. |
| [tap:context](../skills/context/SKILL.md) | Ask an agent to choose the least disruptive context recovery at a safe task boundary: leave alone, compact, clear and rebrief, or restart. It preserves assignments and writer custody. |

Agents may select these skills themselves when their assignment calls for them,
except `tap:help`, which is meant for you to start. Claude Code and Codex hide it
from agents entirely, so its onboarding and diagnosis text loads only when you
ask. Some other harnesses ignore that setting and still list its one-line
description to agents. Agents use `tap help` and `tap:tap`
instead. This split tells you which skills are useful to ask for, not who is
allowed to load a file.

## Run a shell command directly

For a simple TAP command, use your harness's shell shortcut, such as `!tap in`,
instead of the skill form (`/tap in` or `/tap:in`). It uses fewer tokens and is
simpler. Use the skill when you want the agent to manage a lifecycle or make
decisions.

## Skills an agent invokes

You normally describe the work and let the agent use these helpers. `send`,
`assign`, `reply`, `outstanding` and `team` are deliberately absent from the
user slash menu; the rest also work when you type them.

| Skill | Agent's use |
|---|---|
| [tap:tap](../skills/tap/SKILL.md) | Apply the shared messaging, liveness and tree-custody rules. |
| [tap:in](../skills/in/SKILL.md) | Register or reconnect the current pane when its binding changes or is uncertain. |
| [tap:out](../skills/out/SKILL.md) | Unregister a seat and free its handle, with a handoff when needed. |
| [tap:team](../skills/team/SKILL.md) | Inspect the roster and choose a recipient. |
| [tap:send](../skills/send/SKILL.md) | Send a note or a question; use assign for work orders. |
| [tap:assign](../skills/assign/SKILL.md) | Send a work order with a tracked reply obligation. |
| [tap:reply](../skills/reply/SKILL.md) | Answer an incoming request and settle it; a progress reply keeps unfinished work open. |
| [tap:outstanding](../skills/outstanding/SKILL.md) | Check sent messages that still await settlement before yielding. |
| [tap:ask](../skills/ask/SKILL.md) | Run one stateless harness question and print the answer, without a TAP seat or follow-up lifecycle. |
| [tap:choreography](../skills/choreography/SKILL.md) | Coordinate readers, writers, review evidence and supervision. |

## Find the canonical instructions

Claude and Codex use native plugin names such as `tap:lead`. Other harnesses
use flat names such as `tap-lead`; the all-seat entry is `tap`. To find the
canonical file for your installed version, run:

```bash
tap help skill lead
```

Open the returned file before using the skill. Namespaced and flat names resolve
there too. The native plugin exposes all 23 skills. Flat hosts start with `tap`,
`tap-in`, `tap-send`, `tap-escalate`, `tap-config-wizard` and `tap-help`; the
full-kit setting adds the rest. Skills guide agent behavior; TAP transports
messages rather than enforcing a fixed workflow.

Your team can write its own role skills, such as a coach, monitor or context
genie. See [the five levels of TAP](TAP-LEVELS.md) for roles and growing teams,
or browse this reference as a [web guide](https://tedyav.github.io/tap/cheatsheet-skills.html).
