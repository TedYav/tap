---
title: A Bun or Node child restores the tty mode it saw at startup
date: 2026-09-02
category: integration-issues
module: hooks/tap-opencode-session-start.ts
problem_type: integration_issue
component: tooling
severity: high
applies_when:
  - "a TUI accepts typed text and Enter never submits"
  - "a Bun or Node child is spawned with a tty on stdin, stdout, or stderr while a TUI is switching to raw mode"
tags:
  - tty
  - termios
  - bun
  - node
---

# A Bun or Node child restores the tty mode it saw at startup

## The symptom

Typed text appears, and Enter never arrives as a key. Control characters show
up as themselves (`^P`, `^[`) and a typed line ends in a newline. That is the
kernel echoing input because the terminal is in cooked mode. The TUI never
received the keystrokes. Sampling the tty's mode, from a process that shares
it, locates this before any keymap code is worth reading.

## What restores the mode

Bun and Node snapshot the termios of every standard fd that is a tty when the
process starts, and write that snapshot back at exit, whether or not the
process changed the mode. bash and python leave whatever mode is live at exit.

If the TUI enters raw mode while that child is still running, the child's exit
puts the terminal back to the cooked snapshot from the child's startup. The
race is which event is last. A timeout that lets startup continue and leaves
the child running can land the exit after raw mode.

A child that starts after the TUI is already raw snapshots raw mode, so
writing that snapshot back is harmless. A control that never straddles the
transition stays green for that reason, not because the TUI is fine.

From Bun 1.3.14, Bun skips the restore when stdout is not a tty and the
process did not change the mode. Earlier versions always restore. A child
whose only tty is stdin, or only stderr, still restores.

## The redirect

Give the child no tty to snapshot. `hooks/tap-opencode-session-start.ts`
runs the bind as `tap in < /dev/null`. With `--session`, plugin init runs
before the TUI sets raw mode, and the bind's timeout does not cancel the
child. The redirect is what keeps that late exit from touching the pane.

`skills/tap/scripts/smoke/opencode-bind-child-no-tty.test.sh` has three arms.
A child spawned the same way without the redirect sees a tty. The shipped
plugin's bind child does not. The same plugin with the redirect removed sees
a tty again.

## When to apply

- A Bun or Node child inside a TUI gets no tty on any standard fd:
  `< /dev/null` for stdin, and a pipe or `/dev/null` for stdout and stderr.
  Bun's `$` under `.quiet()` already pipes stdout and stderr, which is why
  the plugin needed only the stdin redirect. `Bun.spawn` inherits stderr
  unless told otherwise.
- "Enter does nothing" starts with a termios sample, not the keymap.
- A load-dependent failure that every isolated copy misses is a child racing
  a mode change, not the path the isolated copy exercised.
