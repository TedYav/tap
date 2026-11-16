---
name: help
description: "Get started with TAP, or diagnose something that seems off."
argument-hint: '[get started | what looks weird]'
allowed-tools: 'Bash, Read'
disable-model-invocation: true
---

Before anything else, run `tap help skill help`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
