---
name: self
description: "When invoking compact, rebrief, goal, loop, or clear on this seat, inject a supported harness control into its pane."
argument-hint: 'rebrief|compact [--handoff]|goal|loop|clear'
allowed-tools: 'Bash, Read, Grep, Glob'
role: maker
---

Run `tap help skill self`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
