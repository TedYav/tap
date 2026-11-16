---
name: extend
description: "When a person wants TAP to behave differently or do something it does not do yet (a launch default, a new harness, a new command, any changed behavior), customize their installed TAP: settings first, then its source."
argument-hint: '[what the person wants TAP to do]'
allowed-tools: 'Bash, Read, Grep, Edit, Write'
---

Before anything else, run `tap help skill extend`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
