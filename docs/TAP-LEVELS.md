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

Levels 2 and 3 are covered by the linked pages in the table above. The
advanced sections below add configuration and role examples.

## Level 4: Roles and presets

A role describes the job; a preset saves a harness, model and tuning. These
quoted excerpts from one operator’s configuration show how to record
strengths and staffing preferences. They are examples, not defaults or model
benchmarks. Check the models available to your account and revise the notes as
you learn. Ask `tap:config-wizard` to help adapt them to your configuration;
do not replace your config with this excerpt. Only a private skill reference,
a TODO comment and two typos have been removed or corrected. The quoted
`/drive` and `/lead` shorthand refers to `tap:drive` and `tap:lead`.

```toml
[roles]
driver = "Drives an implementation lane. May also implement code, or delegate its lane to an implementer. See /drive"
implementer = "Implements code from a prompt or a spec"
reviewer = "Reviews code, plans, proposals, etc, either as itself, or as a particular reviewer agent definition provided to it"
partner = "A situational role for pair programming, pair research, or other tasks. Partners are agents that are strong implementers and reviewers, and can offer a turn by turn perspective on a task before escalating to a driver/conductor/leader. Generally, the partner should be a stronger model than the implementer or researcher in the pair."
debugger = "Debugs issues in code or on the machine"
leader = "Leads a TAP team, responsible for choreographing other agents, adding and removing teammates, managing teammate context. Delegates most or all of actual implementation work to other agents. May write plans, or review important parts of plans written by other agents. Pair with a conductor to save tokens! See /lead"
conductor = "A conductor assists the leader with the variety of messages received from an active TAP team. Drivers, implementers, reviewers, etc send agents to the conductor, who will selectively relay questions to the leader as needed."
planner = "Comes up with ideas, and pressure tests ideas with other agents."
researcher = "Researches a given problem space, using internet research"
prose_writer = "Writes or edits prose, such as comments, design documents, ADRs, and so forth."
architect = "Designs and refines the architecture of a system, including the codebase, the data model, the API, the UI, and the overall system design."
approver = "Approves a design or code change after other agents have reviewed it. The leader will assign an approver to various gates in the development process. (Or the leader may designate themselves as the approver). Approvers are generally a distinct seat from reviewers, to avoid rubber stamping something they've already seen."
goalie = "Acts as the team goalie, keeping it on track, blocking deadlocks, failures, and other issues. Can maintain a /goal for the team as a whole. Goalie's job is to let the leader rest and avoid using frontier tokens for micromanaging the team and herding cats."
tasker = "Runs tasks, such as running scripts, executing simple operations, gathering data from the machine, and other tasks that don't require a lot of intelligence."
prototyper = "Prototypes code, designs, and other artifacts quickly, to get a sense of what is possible. Generally top tier frontier models on lower effort settings are useful for this - to see if an idea is feasible before handing robust implementation to cheaper seats."
monitor = "Samples a declared subject on a regular cadence, writes a timestamped heartbeat with numbers each cycle, and reports crossings or errors to its charter recipient. Nightwatch, goalie and context genie are monitor variants. See skills/tap/protocol/supervision/monitor.md."

[intelligences]
s-tier = "Absolute top of the line frontier models to be used for situations requiring exceptional intelligence and capabilities."
frontier = "Frontier model with top of the line intelligence and capabilities, that is strong for executing agentic tasks, doing code reviews, and producing quality software"
advanced = "An advanced model which is useful for general execution tasks, implementation, and research."
medium = "A model useful for basic implementation, data analysis, quick scripting, and other tasks where the goal is very well defined and a more advanced model will check its work."
dumb = "A model which is generally fast and cheap, and useful for offloading more mechanical tasks from more expensive agents, such as detecting team deadlocks, running mechanical gates, data collecting and parsing, etc."
```

`metadata.summary` describes strengths and limitations. `intelligence`,
`cost_level` and `speed` are the operator’s qualitative notes; the quoted
`[intelligences]` table defines those intelligence labels. `primary_roles`
lists preferred jobs, `secondary_roles` lists other suitable jobs, and
`avoid_roles` records jobs to steer away from. These fields brief the agents;
they do not enforce assignments or prove model access. All role names used
below are defined in the `[roles]` excerpt. The preset excerpts keep only
the effort entry from `params.config`; other tuning entries are omitted.

```toml
[presets.astra]
harness = "codex"
params.model = "gpt-6-astra"
params.config = ["model_reasoning_effort=high"]
metadata.intelligence = "s-tier"
metadata.cost_level = "high"
metadata.speed = "medium fast"
metadata.summary = "Top tier frontier model from OpenAI on high effort. Use for implementation, prototyping, writing, and partnering, when high intelligence is needed."
metadata.primary_roles = ["prototyper", "partner", "prose_writer", "implementer", "architect", "approver", "reviewer"]
metadata.secondary_roles = ["driver", "leader", "researcher"]
metadata.avoid_roles = ["tasker"]

[presets.luna]
harness = "codex"
params.model = "gpt-6-luna"
params.config = ["model_reasoning_effort=high"]
metadata.intelligence = "medium"
metadata.cost_level = "very low"
metadata.speed = "very fast"
metadata.summary = "Cheap agent that is still a lot smarter than many other models. Great for automation tasks, running scripts, and executing simple operations. Less good for heavy coding."
metadata.primary_roles = ["tasker"]
metadata.secondary_roles = ["implementer", "researcher"]
metadata.avoid_roles = ["leader", "architect", "approver", "reviewer", "debugger", "prose_writer"]
```

Use `tap models` for model guidance and `tap presets` for saved recipes.
After adapting and saving these presets, `tap launch astra builder` or
`tap launch luna tasker` uses that recipe for a new seat. Both examples use
the same model family; choose a different family when the work calls for
cross-family review.

## Level 5: Create the roles your team needs

A team with a coach, a nights watch and a context genie feels like working
with a crew, and it makes development fun.

Add a role when you repeatedly do its job by hand. A **context genie** can
watch context pressure and ask seats to write handoffs. A **nights watch** can
check new commits and report test failures. A **coach** can record lessons and
recognize useful work. A **monitor** samples a declared subject and reports
threshold crossings or errors.

These are examples of role skills you can write, not additional skills shipped
in the TAP plugin. Give each a `SKILL.md` with its inputs, actions, recipient,
evidence, cadence when needed, and stop condition. A role description in TOML
helps choose a seat; it does not create the skill or schedule it. Keep monitoring
bounded and event-driven where possible; avoid waking a model just to check
whether a peer replied.

The [factory-skills reference](cheatsheet-skills.html) lists every shipped TAP
skill and when to use it. Start with those, then add your own instructions for
repeated needs. [Level 5](cheatsheet-level-5.html) covers bounded supervision
and handoffs.

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
