---
name: crew
description: "For a consult, review, or discussion needing follow-up but no durable lane, manage a short-lived TAP crew seat in this tmux session."
argument-hint: 'add <preset|harness> [name] [--model <m>] [--assign <brief-file> [--reply-to <seat>]] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args] | list | shutdown [<crew>|--owner <handle>]'
allowed-tools: 'Bash'
role: maker
---

Before anything else, run `tap help skill crew`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
