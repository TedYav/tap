# TAP cheat sheets

Choose the sheet for the next thing you want to do:

| Sheet | Use it for |
|---|---|
| [Set it up and get started](GETTING-STARTED.md) | Install, initialize your project, launch two seats and get an answer |
| [Install TAP (web guide)](https://tedyav.github.io/tap/cheatsheet-install.html) | Requirements, wizard, PATH, updates and uninstall |
| [Start your first team](GETTING-STARTED.md) | Launch, visit, exchange an answer, stop and return |
| [Harnesses and presets (web guide)](https://tedyav.github.io/tap/cheatsheet-harnesses.html) | Supported CLIs, permission modes, models and tuning |
| [How agents divide the work (web guide)](https://tedyav.github.io/tap/cheatsheet-collaboration.html) | Roles and how TAP carries messages |
| [TAP skills](SKILLS.md) | Skills you invoke and skills an agent invokes |

Markdown links open readable guides on GitHub. Links labeled “web guide” open
the rendered GitHub Pages sheets. Every web guide starts in dark mode; the
header's **Light theme** toggle remembers your choice when browser storage is
available. With JavaScript off, the guides stay dark.

For offline use, open the HTML sheets from
your permanent clone in a browser, for example:

```bash
open ~/tap/docs/cheatsheet-install.html
```

Use your clone’s actual path if it differs.

For the full walkthrough, read [Your first TAP team](GETTING-STARTED.md).
For command options, use the [command reference](../skills/tap/USAGE.md).
To have an agent help with installation, point it at [AGENT-SETUP.md](AGENT-SETUP.md).

Start a project with `tap init`, then `tap launch claude` and `tap launch codex`
([first-team steps](GETTING-STARTED.md)). Explore
[the five levels of TAP](TAP-LEVELS.md) when you want to see what comes
next. For machine choices,
use `tap config path`, `tap config get sentinel.preview`, and
`tap config set sentinel.preview true` (or `false`). The [guide](GETTING-STARTED.md)
explains initialization and derived message previews.
