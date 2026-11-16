---
name: self
description: "When invoking compact, rebrief, goal, loop, or clear on this seat, inject a supported harness control into its pane. Free text after compact or rebrief guides the summary and tells the resumed seat where to pick up; it is not work to do first."
argument-hint: 'compact|rebrief|clear [--notify <seat>] [--model <name>] [--effort <level>] [<what to keep, and what to do after the reset>]|goal|loop'
allowed-tools: 'Bash, Read, Grep, Glob, Write'
role: maker
---

Before anything else, run `tap help skill self`, read the returned SKILL.md and follow it. Everything that came with this invocation, flags and free text alike, is that skill's input: do not act on any of it until its instructions say how and when. Resolve all relative references from that canonical file's directory, never from this wrapper.
