---
name: config-wizard
description: "When a person wants TAP set up or reconfigured (presets, permissions, shell aliases, notifier), walk them through every knob; name one setting for a targeted change."
argument-hint: '[setting or preset]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

Before anything else, run `tap help skill config-wizard`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
