---
name: ask
description: "Run one stateless headless harness prompt and print the answer; no TAP seat or follow-up. To ask a teammate, use tap send --ask."
argument-hint: '<preset|harness> -f <prompt.md> | -m "..." [--model <tier>]'
allowed-tools: 'Bash'
role: maker
---

Before anything else, run `tap help skill ask`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
