---
name: crew
description: "For a consult, review, or discussion needing follow-up but no durable lane, manage a short-lived TAP crew seat in this tmux session."
argument-hint: 'add <preset|harness> [name] [--model <m>] [--assign <brief-file> [--reply-to <seat>]] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args] | list | shutdown [<crew>|--owner <handle>]'
allowed-tools: 'Bash'
role: maker
---

Run `tap help skill crew`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
