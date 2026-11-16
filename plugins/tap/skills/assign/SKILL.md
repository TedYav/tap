---
user-invocable: false
name: assign
description: "Hands a teammate a work order over TAP, with a tracked reply obligation. Use when assigning work rather than sharing a note."
argument-hint: "<to> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

Before anything else, run `tap help skill assign`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
