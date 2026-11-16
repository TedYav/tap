# Permission requests (Claude Code)

A Claude Code seat that stops for a human, on a tool approval or a question, reports what it stopped on. `tap team` shows it. TAP never answers the request.

## What records it

The installer adds one `PermissionRequest` entry to Claude Code's user settings. It runs `hooks/tap-claude-permission.sh`. Claude Code runs that hook when it is about to show an approval prompt or a question dialog. In `auto` and `bypassPermissions` mode that means a command under an `ask` rule, a question, and the few actions no mode approves. A command the mode approves runs no hook.

The hook observes only. It prints nothing, so it cannot allow or deny, and it exits 0 whatever happens: no Bun, a broken checkout, unreadable state. The terminal prompt behaves as it does without TAP.

The entry carries `timeout: 10`, in seconds. Claude Code cancels a hook that runs longer, discards it and carries on with the prompt. On Claude Code 2.1.323 the prompt is on screen and answerable while the hook runs, so the hook adds no wait; the bound covers a version that would wait for it.

It writes only for a registered seat's bound session. The calling pane and tmux server generation must match exactly one active Claude row whose `harness_session_id` equals the payload's `session_id`. Every other Claude session on the machine writes nothing, including a headless child a seat starts, which inherits the pane and not the session.

## The record

One file per request, `<bus>/permission-requests/<handle>.<epoch ms>-<8 hex>.json`, mode 0600. The hook never replaces a file. It writes a new name and then removes that seat's strictly older ones, so a seat normally has one. A reader shows the newest. A file's handle is the whole name before that fixed-shape tail, so `opus` never matches `opus.fixer`'s record.

| Field | Holds |
|---|---|
| `v`, `harness` | `1`, `claude` |
| `at` | Epoch milliseconds when the hook ran |
| `session`, `pane_id`, `server_epoch` | The session, pane and tmux server generation it ran in |
| `tool` | The tool's name |
| `summary` | One line, at most 160 characters |
| `permission_mode` | Claude Code's mode at the time |
| `session_file` | Claude Code's session file for that session |

Nothing is read, written or removed through a symlink at the directory's name or at a record's name.

`summary` depends on the tool. A shell tool gives the agent's own `description` of the command, never the command. A file tool gives the path. A question gives its first question. Any other tool gives nothing. The tool input itself is not stored.

## When it is shown

A request declined or cancelled at the terminal runs no hook. Neither does a killed pane. Both were observed on Claude Code 2.1.323. Nothing tells TAP the request closed, so the record is detail and never state.

A reader shows the record only while Claude Code's own session file says so. That file is `sessions/<pid>.json` under Claude Code's config directory. It must name the same session, report `status: waiting`, belong to a live process, and date the wait no later than the record.

The session file's format is undocumented. The reader takes `pid`, `sessionId`, `status`, `waitingFor` and `statusUpdatedAt` and treats each as optional. A missing, renamed, retyped or unparseable field shows nothing and raises no error. The hook writes no record when the file reports no `status`, so a Claude Code that writes none shows nothing.

## Removal

The reader removes a record that is no longer vouched for: the session is not waiting, its file is gone, its process is dead, the seat is bound to another session or pane, or the record predates the current wait. It removes only file names it listed, so a record the hook writes in the meantime, under its own new name, cannot be removed. A reader that listed a file the hook then removed shows nothing on that one read. A named read of another team (`tap team <team>`) judges the record and leaves it in place.

Records are also removed at the seat's next session start, when the seat is retired (`tap out`, `tap crew shutdown`), and by `tap uninstall` whatever the history choice and whether or not the install manifest still lists the hook. Between a request closing and the next of these, the record stays on disk.

## Roster output

`tap team --json` adds `permission_request` to every row. It is null, or `{tool, summary, since, waiting_for}`. `since` is ISO-8601 UTC. `waiting_for` is Claude Code's word for the wait: `permission prompt` or `input needed`.

The field is read for each request. It is never written into the roster's cached observation, so a cache hit shows the request as it is now and no second copy of the summary exists.

`agent_state` does not change. The screen classifier still owns the seat's state. The human state cell appends ` · needs approval (<tool>)` or ` · asks a question`.

## Installation

The entry needs Claude Code 2.0.45, which added the event. An older Claude Code stops each start on a settings warning for a hook event it does not know.

Every `./install.sh` and `./install.sh --sync` reads `claude --version`. At 2.0.45 or newer it wires the entry. Older, or unreadable, it removes TAP's entry and prints one line saying why. `./install.sh --report` states which applies. The removal is not behind `TAP_INSTALL_HOOK=0`. `tap uninstall` removes the entry through the install manifest.
