---
name: escalate
description: "When only the user can unblock work, escalate the question."
argument-hint: "-f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

Before anything else, run `tap help skill escalate`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
