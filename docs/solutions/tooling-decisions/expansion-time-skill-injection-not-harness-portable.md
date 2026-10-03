---
title: "Expansion-time `!command` injection in SKILL.md is not harness-portable"
date: 2026-07-10
category: docs/solutions/tooling-decisions
module: skill authoring (cross-harness SKILL.md)
problem_type: tooling_decision
component: tooling
severity: high
applies_when:
  - "Optimizing a shim skill's invocation latency by moving a command out of prose and into the skill body"
  - "Considering Claude Code's `!command` expansion-time injection in a SKILL.md"
  - "The SKILL.md is a single shared file that multiple harnesses (Claude Code, Codex, OpenCode, Cursor, Grok) all read"
tags: [skills, cross-harness, latency, dynamic-injection, claude-code, codex, opencode, tap-in]
related_components: [development_workflow]
---

# Expansion-time `!command` injection in SKILL.md is not harness-portable

## Context

Claude Code supports `` !`command` `` syntax in a SKILL.md body: the shell command runs
**at expansion time — before the model ever sees the skill content** — and only its
output is substituted into the text the model reads. Per the Claude Code docs
(code.claude.com/docs/en/skills, "Inject dynamic context"): this is "preprocessing, not
something Claude executes. Claude only sees the final result."

That property is a real latency lever for a thin "shim" skill whose whole job is to run
one command and report the result. `/tap-in` (`skills/tap-in/SKILL.md`, an alias for
`tap register`) is the canonical case. In its shipped prose form it costs **two model
turns** around a ~0.1s command:

1. **Turn A** — the model reads "Run this: `tap in`" and decides to issue a `Bash`
   tool call.
2. tool round-trip — `tap in` executes.
3. **Turn B** — the model reads the tool result and narrates it.

Rewriting the body to `` !`tap in $ARGUMENTS` `` collapses turn A and the round-trip:
the command has already run at expansion time, so the model receives one skill blob that
already contains the registration output and only has to narrate it — a one-turn floor.
That looks like a free latency win. It is not portable. It is faster where the harness expands it and the model accepts the inlined output. It is slower where the harness expands it and the model repeats the work because the visible tool round-trip is gone. It breaks where the harness does not implement the syntax. Weigh that before putting it in a shared skill file.

## Guidance

**Treat `` !`command` `` expansion-time injection as a Claude-Code (and OpenCode) feature,
not a cross-harness one. Do not put it in a SKILL.md that other harnesses read from the
same file.**

The decisive constraint is that TAP skills are **one physical file consumed by every
harness**. `install.sh` links the core skill set, `tap-in` included, into each harness's
skills home from one source file, so `~/.claude/skills/tap-in` and `~/.codex/skills/tap-in`
both point at the *same* `skills/tap-in/` directory — one physical `SKILL.md` governs every
harness. There is no
per-harness variant to gate the syntax behind — a change to that one file lands verbatim
in Claude Code, Codex, OpenCode, Cursor, and Grok at once. So the injection syntax cannot
be "used where supported and hidden elsewhere" without first splitting the file per
harness, which the shim architecture deliberately does not do.

The same body produces three different behaviors:

| Harness | Result | Why |
|---|---|---|
| **Claude Code** | Faster, as predicted | Injected output landed inline; only one model turn fired (sonnet verified in-session — no separate `Bash` call). |
| **OpenCode** (GLM model) | Faster | The same expansion-time injection mechanism works. |
| **Grok** | **Slower** | Model expected a visible tool-call/tool-result exchange as the signal the action happened; seeing pre-inlined static text instead, it didn't trust it as "already done" and issued extra turns to confirm. |
| **Cursor** | **Slower** | Same failure mode as Grok. |
| **Codex** | **Completely broken** | Codex's SKILL.md handling does not implement the `` !`command` `` preprocessing at all; the syntax did not degrade to inert literal text — it broke the skill outright. |

The net effect on the harnesses that don't support the syntax is the **opposite** of the
intent: latency *increased* (Grok/Cursor) or the skill stopped working (Codex).

**The optimization is not wrong — its blast radius is.** Expansion-time injection is a
legitimate one-turn win for a shim in a Claude-Code-only (or Claude-Code + OpenCode) skill
surface. It becomes a net negative the moment the same file is also read by a harness that
expects the tool-call/tool-result exchange as its "the action happened" signal, or by one
that doesn't implement the preprocessing at all.

## Why This Matters

- **A shared file has no gate.** One file serves every harness, so a syntax only some of
  them expand cannot be scoped. A latency win on two harnesses is a broken skill on a
  harness that does not implement the preprocessing.
- **Do not assume the syntax degrades to literal text.** On a harness that does not
  implement it, the body can break instead of sitting there as prose.
- **Some harnesses treat the tool-call round-trip as the evidence the action happened.**
  Removing that visible exchange can make the model repeat the work, so the saved turn is
  spent twice.
- **Measure the change on every harness that reads the file.** A result on one harness
  does not predict the others.

## When to Apply

- **Reach for `` !`command` `` injection** only when the SKILL.md's consuming surface is
  Claude-Code-only (or verified Claude-Code + OpenCode) — e.g. a repo-private skill that no
  other harness installs.
- **Do not reach for it** in any skill file that is symlinked/shared across harnesses (all
  TAP shims: `tap-in`, `tap-out`, `tap-send`, `tap-reply`, `tap-done`, `tap-outstanding`,
  `tap-team`, etc.), unless you first split the file per harness — which the shim design
  avoids on purpose.
- **Before shipping any harness-specific control syntax in a shared file**, test it in
  *every* consuming harness, not just the one it helps — and specifically check that
  non-supporting harnesses render it as inert text rather than breaking. Assume nothing
  about graceful degradation.

## Examples

**Before — shipped prose, two turns:**

```markdown
Run this and stop — do **not** inspect the registry, read scripts, or check panes first:

​```bash
tap in
​```
```

**After — expansion-time injection:** the shell command has already run before the model reads the file, so there is no tool call left to narrate.

```markdown
!`tap in $ARGUMENTS`

The line above already ran `tap in` in your pane — do **not** re-run it, inspect the
registry, read scripts, or check panes first.
```

The shared file stays on the prose form. Splitting one file per harness would make the
syntax safe, and the shim layout does not do that.

**The generalizable rule.** For a single file consumed by N harnesses, the safe set of
authoring features is the *intersection* of what all N support — not the union. Any
feature in the union-but-not-intersection needs either a per-harness file or explicit,
tested confirmation that non-supporting harnesses treat it as inert prose.

## Related

- Claude Code docs — code.claude.com/docs/en/skills, "Inject dynamic context".
- `install.sh` links the core skill set, `tap-in` included, from one source file. It does not link retired or repo-local skills.
