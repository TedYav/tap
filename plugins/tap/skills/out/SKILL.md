---
name: out
description: "When leaving TAP or removing the last exited teammate, unregister and free the handle."
argument-hint: '[handle|--last|-] [--forward-to successor]'
allowed-tools: 'Bash'
role: maker
---

Before anything else, run `tap help skill out`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
