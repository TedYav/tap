---
name: config-wizard
description: "When a person wants TAP set up or reconfigured (presets, permissions, shell aliases, notifier), walk them through every knob; name one setting for a targeted change."
argument-hint: '[setting or preset]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

Run `tap help skill config-wizard`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
