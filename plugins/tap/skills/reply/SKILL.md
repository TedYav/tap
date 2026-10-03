---
user-invocable: false
name: reply
description: "When a payload says reply: expected, answer it and settle the inbound."
argument-hint: "<id> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

Run `tap help skill reply`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
