---
name: context
description: "At task boundaries or before compact, clear, or restart, choose the least disruptive TAP context recovery."
role: choreographer
allowed-tools: 'Bash, Read, Grep, Glob'
---

Before anything else, run `tap help skill context`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
