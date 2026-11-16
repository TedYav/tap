---
user-invocable: false
name: send
description: "When messaging a TAP seat: tap send is a note, tap send --ask is a question owed a reply, tap assign is a work order."
argument-hint: "<to> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

Before anything else, run `tap help skill send`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
