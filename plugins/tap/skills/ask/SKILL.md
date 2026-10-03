---
name: ask
description: "For one bounded prompt needing no TAP seat, follow-up, or lifecycle, run a stateless harness question and print the answer."
argument-hint: '<preset|harness> -f <prompt.md> | -m "..." [--model <tier>]'
allowed-tools: 'Bash'
role: maker
---

Run `tap help skill ask`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
