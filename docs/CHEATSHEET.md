# TAP cheat sheets

Choose the sheet for the next thing you want to do:

| Sheet | Use it for |
|---|---|
| [Set it up and get started](cheatsheet.html) | Install, initialize your project, launch two seats and get an answer |
| [Install TAP](cheatsheet-install.html) | Requirements, wizard, PATH, updates and uninstall |
| [Start your first team](cheatsheet-first-team.html) | Launch, visit, exchange an answer, stop and return |
| [Harnesses and presets](cheatsheet-harnesses.html) | Supported CLIs, permission modes, models and tuning |
| [How agents divide the work](cheatsheet-collaboration.html) | Roles and how TAP carries messages |

GitHub shows HTML source. To view a sheet, open the file from your permanent
clone in a browser. On macOS:

```bash
open ~/tap/docs/cheatsheet-install.html
```

Use your clone’s actual path if it differs. All five sheets work offline.

For the full walkthrough, read [Your first TAP team](GETTING-STARTED.md).
For command options, use the [command reference](../skills/tap/USAGE.md).
To have an agent help with installation, point it at [AGENT-SETUP.md](AGENT-SETUP.md).

Start a project with `tap init`, then `tap launch claude` and `tap launch codex`
([first-team steps](cheatsheet-first-team.html)). Explore
[the five levels of TAP](cheatsheet-level-1.html) when you want to see what comes
next. For machine choices,
use `tap config path`, `tap config get sentinel.preview`, and
`tap config set sentinel.preview true` (or `false`). The [guide](GETTING-STARTED.md)
explains initialization and derived message previews.
