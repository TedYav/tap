---
title: /new reverts a codex seat's reasoning effort to its profile default
date: 2026-07-23
category: integration-issues
module: TAP seat lifecycle / codex harness
problem_type: integration_issue
tags: ["codex", "reasoning-effort", "seat-reset", "new-command", "eval-integrity", "harness"]
applies_when:
  - "resetting a codex seat with /new to get a fresh conversation on the same pane"
  - "running a matched-effort-tier comparison or budget-sensitive lane on codex seats"
  - "a per-session reasoning-effort override was set and the seat was later reset"
---

## Context

To get a fresh conversation on an existing seat, do not tear the seat down and
relaunch. Send the pane the harness-native new-conversation command
`/new <session name>`, then `/tap-in`. The `/tap-in` rebinds the fresh
conversation id to the seat. This is lighter than tearing the seat down and
launching again.

That recipe is the right default. But on codex it carries a silent side effect
that this doc exists to flag.

## Guidance

**The footgun: `/new` reverts a codex seat to its PROFILE-DEFAULT reasoning
effort.** A per-session effort override — one you set explicitly during the
conversation — does NOT survive the reset. The new conversation starts at
whatever the seat's profile defines, not at the override you were running under.

**The fix, two parts:**

1. **After any seat reset, re-set the intended effort explicitly.** Do not
   assume the override carried over. Treat effort as reset-to-default the moment
   `/new` fires.

2. **Read `reasoning_effort` from the rollout file, not from the launcher
   manifest.** The manifest stores the model and has no effort field. Rollouts
   are at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. The preflight is
   `grep -o '"reasoning_effort":"[a-z]*"' ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`.

## Why This Matters

`/new` returns the profile default for effort. Nothing in the launcher manifest
shows that. Read the rollout field before relying on an override from the
previous conversation. A comparison is only as trustworthy as the per-seat
parameters you can prove from the record.

## When to Apply

- After `/new` when the previous conversation had set an effort override.
- Before trusting a comparison where seats must run at the same effort.
- After a resume or relaunch that was supposed to keep a lower effort than the
  profile default.
