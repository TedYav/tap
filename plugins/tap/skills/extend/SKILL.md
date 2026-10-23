---
name: extend
description: "When a person wants TAP to behave differently or do something it does not do yet (a launch default, a new harness, a new command, any changed behavior), customize their installed TAP: settings first, then its source."
argument-hint: '[what the person wants TAP to do]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

Run `tap help skill extend`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.
