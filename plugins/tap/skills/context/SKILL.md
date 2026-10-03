---
name: context
description: "At task boundaries or before compact, clear, or restart, choose the least disruptive TAP context recovery."
role: choreographer
allowed-tools: 'Bash, Read, Grep, Glob'
---

Run `tap help skill context`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
