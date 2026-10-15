# TAP

TAP allows agents to communicate! If this doesn't work with your [threat model](SECURITY.md), don't use it!

**Pre-release beta.** TAP is not yet a public, open-source release. Expect bugs. Send bug reports and
feature requests to ted@tedyav.com.

TAP lets Claude Code and Codex talk while you watch their terminals. If you like
agent swarms, tmux, and seeing what each agent is doing, this is for you.

TAP lets agents communicate by injecting keystrokes into one another's terminals
on one machine.
**Bypass mode grants the agents your permissions.**

TAP is duct tape, not fiber optic, **but it works!** Modern agents don't
need much to coordinate and get work done: a way to reach one another, a clear
task, and a few shared rules. TAP supplies the messages and wakes; the agents
bring the judgment.

## Get your first reply

Install TAP once, initialize your project, launch Claude and Codex, and ask
one to talk to the other.

Release archives bundle Bun. The [release artifact guide](docs/RELEASE-ARTIFACTS.md)
contains the build procedure and bootstrap one-liner for a future release;
downloadable assets are not published yet.

1. **Install once.** Copy the "Have your agent install it" prompt from the
   [landing page](https://tedyav.github.io/tap/#agent-install) into any agent you run; it
   follows the guide at [tedyav.github.io/tap/setup.md](https://tedyav.github.io/tap/setup.md).
   It is a pre-release preview. If cloning fails with a permission error, ask the maintainer
   for access. To install by hand, follow [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md).

2. **Initialize your project.** In a Git repository it creates `.tap/` and ignores it;
   elsewhere it asks first:

   ```bash
   cd /path/to/your/project
   tap init
   ```

3. **Launch two seats.** In your terminal:

   ```bash
   tap launch claude
   # After Claude opens, Ctrl-b then d returns to your terminal.
   tap launch codex
   ```

   TAP starts and registers each seat. From a foreground terminal, launch
   opens the agent; when launched by an agent or without a terminal, use
   `tap attach claude` or `tap attach codex` to visit it.
   Finish any sign-in, folder-trust or
   [hook-review prompt](docs/GETTING-STARTED.md#when-codex-asks-to-review-hooks)
   yourself. Launch uses your saved permission choice, or auto mode by
   default; [choose bypass mode](docs/GETTING-STARTED.md#choose-bypass-mode)
   before launching if you prefer it.

4. **Ask one to talk to the other:**

   > Run tap team to see the roster, then ask the other agent: should our
   > first tiny project start with a README or a test? One sentence of
   > reasoning. Show me its actual reply.

   Approve the `tap` command if your harness asks. Done means the **answer
   text in your asking pane**. If mail arrives while you type, type WAIT
   (in capitals) to hold deliveries for two minutes.

[Your first TAP team](docs/GETTING-STARTED.md) covers prompts and returning to
seats. [The five levels of TAP](docs/TAP-LEVELS.md) shows what you
can do with two agents and when a larger team helps. The
[skills guide](docs/SKILLS.md) separates skills you invoke from agent helpers.

## Visit the agents

Each agent runs in a named seat. You can leave one running and visit another.
From inside Claude, press **Ctrl-b**, then **d** to return to your terminal.

| What you want | Command or keys |
|---|---|
| Visit a seat | `tap attach <seat>` |
| See who needs attention | `tap team` from your project |
| Leave an agent running | **Ctrl-b**, then **d** |
| Scroll in a terminal | **Ctrl-b**, then **[**; **q** to leave scroll mode |

When the roster shows `needs you: tap attach ...`, visit that seat and inspect
its prompt. The human makes sign-in, trust and permission decisions. Then return
to the asking pane and have it check the original question before sending it
again.

![A TAP team spanning several agent harnesses](docs/assets/tap-team.png)

Give a real task after the first reply: "Make this change, have the other agent
check it, and show me what you agreed to fix." You can keep using normal language.
The [cheat sheets](docs/CHEATSHEET.md) collect the commands for visiting, stopping
and returning to your team.

TAP gives you direct access to each agent’s tmux pane: attach to its terminal,
read the conversation, and use the roster to see its state. TAP is for people
who want that terminal access while their agents work together. For a
dashboard, a hosted service or agents across machines,
[the tool comparison](docs/TAP-LEVELS.md#when-another-tool-fits)
points to tools built for that.

## Advanced

### Larger teams

The [collaboration sheet (web guide)](https://tedyav.github.io/tap/cheatsheet-collaboration.html) covers dividing work
among agents. The skills `tap:lead`, `tap:drive` and `tap:conduct`
cover team planning, lane ownership and delegated work. Run `tap help skill tap-lead`
(or the other skill name) to find its instructions. The
[agent task guide](skills/tap/GUIDE.md) links their contracts.

Claude and Codex load one TAP marketplace plugin. Its skills use names such as
`tap:lead`, `tap:drive` and `tap:config-wizard`; the all-seat entry is `tap:tap`.
The installer registers the plugin from the installed TAP checkout and refreshes
it during `./install.sh --sync`. The plugin requires the installed `tap` CLI.

Other harnesses use prefixed names such as `tap-lead`. They start with six skills:
`tap`, `tap-in`, `tap-send`, `tap-escalate`, `tap-config-wizard` and `tap-help`.
[Easy Mode](docs/EASY-MODE.md#2-save-simple-machine-settings) explains their full-kit
choice. `tap help skill lead`, `tap help skill tap:lead` and `tap help skill tap-lead`
resolve the same instructions. Start with the first exchange before adding these tools.

### Agent messages and tasks

Agents use a small command vocabulary when a task needs an explicit request:

```bash
tap assign reviewer -f ./review-request.md  # work with a reply owed
tap send reviewer --ask -f ./question.md    # a question with an answer owed
tap send reviewer -f ./status-note.md       # an informational note
tap reply <id> -f ./answer.md               # answer the received request
tap read <id>                              # read and settle a note
```

Put bodies in literal files, especially when they contain shell commands.
A review or fix request needs `assign` or `send --ask`; a plain note does not
create a reply obligation. See the [command reference](skills/tap/QUICK-REFERENCE.md)
for stateless questions, temporary helpers, context management and cross-team work.

### Saved settings and notifications

Use `tap models` to choose model and effort. It reads your personal calibration
when present; otherwise it shows qualified reference guidance, with access
unverified. Launch directly with `tap launch claude model-reviewer --model fable
--effort high`, using a model your account supports. OpenCode and Cursor accept
model only. `tap help launch` lists supported effort levels.

Presets save a combination you use often and are optional.
[Easy Mode](docs/EASY-MODE.md#after-the-first-answer)
covers saved choices and shell shortcuts. The installation runbook also covers
[human notifications](docs/AGENT-SETUP.md#human-notification-setup).

### How messages arrive

TAP writes a message to local files and types a short notification into the
receiving agent's tmux pane. That agent reads the message and decides what to do.
TAP's delivery receipt does not prove the agent processed it.

[Push, not poll](docs/PHILOSOPHY.md#push-not-poll): after sending, an agent keeps
doing useful work that does not depend on the reply. When it needs the answer,
it yields and lets the reply wake its pane. This avoids repeated model turns
spent checking for mail; it does not make coordination token-free. The
[protocol guide](skills/tap/protocol/README.md) documents delivery, drafts,
identity checks and reply obligations.

### Contributing

When changing TAP itself, read `AGENTS.md` in the source checkout for the current
test, review and delivery rules. Contributor instructions are not bundled in release archives.
Installing TAP does not require running the development suites.

Features we have scoped but are holding until users ask for them, such as tunable security levels,
are listed in [community features](docs/COMMUNITY-FEATURES.md). Open an issue or add a 👍 to vote.
