---
user-invocable: false
name: reply
description: "When a payload says reply: expected, answer it and settle the inbound."
argument-hint: "<id> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

Before anything else, run `tap help skill reply`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
