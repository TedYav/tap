# Getting started with TAP

Run `./install.sh` once from TAP's persistent primary checkout. In another repository, `tap init` prepares the local team bus and adds the managed AGENTS signpost.

## Launch or reconnect

```sh
tap presets
tap session launch <preset|harness> [name]
tap whoami
tap team
```

Launcher-managed seats register before the harness starts. Use `tap in` only for a manual bare-pane join or reconnect.

## Choose the lightest staffing form

```sh
tap ask <preset|harness> -f prompt.md          # one answer, no TAP seat
tap crew add <model-bearing-preset> [name]     # short-lived consult
tap crew add <harness> [name] --model <model>  # or select the launch model directly
tap session launch <preset|harness> [name]     # durable lane
```

Crew requires an explicit model, supplied by the preset or `--model`; the harness default is insufficient.

The name you supply is the TAP handle. Confirm a new seat with `tap whoami` before assigning work.

## Send literal work

```sh
tap send <to> -f note.md
tap assign <to> -f order.md
tap reply <id> -f answer.md
```

Use a quoted heredoc for stdin:

```sh
tap send <to> -f - <<'EOF'
literal body with `backticks` and $(shell-shaped text)
EOF
```

Plain `send` is a note. `assign` is work and requires a reply. `reply` answers and settles an ask. A note is settled by `tap read` and needs no acknowledgement reply.

## Supervise without polling

`tap outstanding <me>` shows sends awaiting settlement. `tap poll <me>` shows unsettled inbound work. TAP wakes panes through the courier; never sleep or loop-poll for messages. Use `tap remind` for an explicit future wake.

## Go deeper

- [Quick reference](../QUICK-REFERENCE.md)
- [Task guide](../GUIDE.md)
- [Detailed protocol](../protocol/README.md)
- `tap help <verb>` for exact syntax
