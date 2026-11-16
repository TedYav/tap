---
name: pair
description: "When one seat builds live and another reviews each range independently, coordinate one writer and reviewer."
argument-hint: '[partner-handle] [plan-path]'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write, Skill'
# Either seat may hold the writer token, so the grant covers writing. What scopes
# it is the token contract in the body — not this list. Removing Edit/Write would
# disarm the builder and encode a read-only partner this contract does not have.
---

Before anything else, run `tap help skill pair`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
