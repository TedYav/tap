---
name: discuss
description: "When co-reviewing finished plans, reviews, or decisions, bound adversarial convergence in a driver-owned issue ledger."
argument-hint: '[plan|review|decide] [--thread ID] [--round-cap N] [CONTEXT...]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

Before anything else, run `tap help skill discuss`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
