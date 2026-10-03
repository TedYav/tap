---
name: context
description: "At task boundaries or before compact, clear, or restart, choose the least disruptive TAP context recovery."
role: choreographer
allowed-tools: 'Bash, Read, Grep, Glob'
---

# TAP Context Hygiene

Use the least disruptive recovery that restores reliable work. This is a judgment skill; `tap command` only transports the allowlisted command after you choose.

## Hard gates

- Never change a seat's context while it holds a **Writer Token** or is mid-lane. Wait for an explicit token return. The CLI cannot infer custody; this refusal belongs here.
- Before clear, ensure the standing assignment is recoverable from an unsettled TAP payload; if it is not, send a durable rebrief payload first. A cleared seat cannot recover a chat-only brief.
- A clear is incomplete until the same seat is re-registered, that registration is verified, and a standing-brief recovery prompt is submitted. Treat any later failure as partial, not success.
- A user's explicit directive overrides which rung you prefer, but never overrides Writer Token custody or the clear recovery requirements.

After recovery, run `tap poll <self>` and `tap read <id>` for each pending payload.
A v0.23 sentinel uses positional `ask` / `note` and `[<team>/]<id>` slots:
`ask` requires `tap reply`; a successful `tap read` settles a `note`. Keep the prefix for `read`, strip it for `reply`.
Use `tap read path=<file>` for an explicit pointer. Payload frontmatter still
uses `reply: expected` / `reply: settle-only`. A digest lists its items;
`tap read <id> --all` reads each body, settling notes while asks still need replies.
Skip settlement for `settled: true`; never settle the digest itself.
See `/tap` and [`protocol/delivery/`](../tap/protocol/delivery/README.md); ask the sender about an unknown
shape and reload `/tap` on version drift.

## Decision ladder

Choose in this order: **leave alone → compact → clear and rebrief → restart**.

| Signal | Action |
| --- | --- |
| Seat is on track and progressing | Leave alone. Context size by itself is not a fault. |
| A responsive seat is on track but context pressure threatens the next unit | Ask it over TAP to run `/tap:self compact` and compose its own keep-list. Use direct command mode only when it cannot respond or an explicit directive requires immediate execution. |
| Context is inconsistent, contaminated, repeatedly loses the brief, or benefits from a deliberate authored rebrief | Clear, re-register, verify, and rebrief; keep the charter and current commitments while leaving detailed history retrievable. |
| Harness/session is wedged or clear cannot restore a usable seat | Preserve any recoverable state, then use `tap session restart`. |

## Transport

For a healthy responsive seat, preserve its judgment and turn boundary with an ordinary message:

```bash
tap send <seat> --ask -m "At the next safe boundary, run /tap:self compact and preserve: <focus>"
```

Use direct command mode for a seat that cannot reliably answer, is too full to self-compose, or must follow an explicit immediate directive:

```bash
tap compact <seat> [-m "what must survive"]
tap compact --all [-m "shared focus"]
tap compact $(tap whoami) -m "what must survive"   # your own context (Claude/OpenCode; Codex refuses — see below)
tap clear <seat> [-m "first instruction"]
```

These reach only local active pane seats with a stable `pane_id`, and return `0` for all-success, `6` for degradation without hard failure, or `1` for any hard failure. Compact `--all` excludes the initiator; a self-target on Claude or OpenCode is compacted through the `/tap:self` injector rather than refused, and needs `-m`. **A Codex seat — peer, `--all` member, or self-target — refuses with exit 1 (tap-n27ug):** compaction there is handoff-gated self work, and the only supported move is asking the seat to checkpoint and run `tap self compact --handoff <file> -- '<focus>'` itself. Clear still refuses a self-target at any spelling: it cannot survive to verify its own result. Focus is plain context text, never another slash command or control input. Clear is prompt-gated and verifies exact active input; any preserved `reply_to` must still be deliverable before reset. Hermes bypasses `/queue` so `/clear` cannot become queued prose. Audit outcomes are prepared before pane input. A verified clear first publishes durable `command_status: cleared`, then a linked `success` after recovery or `partial` if recovery fails; failure to publish the terminal outcome stays nonzero and never erases the `cleared` provenance.

Compact `--all` skips address-only legacy rows that lack stable identity. Target one explicitly if you need a loud refusal and repair signal.

For your own context on Claude or OpenCode, `/tap:self compact` and `tap compact $(tap whoami) -m "..."` are the same path — the skill composes the focus, the CLI owns the harness matrix. On Codex that alias refuses: write the handoff and run `tap self compact --handoff <file> -- '<focus>'` yourself (tap-n27ug).

Claude and OpenCode support compact directly; **Codex supports compact only as handoff-gated self work** — its worker needs a handoff only the seat can author, so peers and `--all` refuse it. Cursor and Hermes are **clear-or-nothing**: compact degrades; write a manual keep-list when useful, then clear — and the two differ in how the keep-list survives. **Cursor** takes it as the clear's first instruction: `tap clear <seat> -m <keep-list>`, one command. **Hermes takes no initial prompt at all** — `-m` is accepted and SILENTLY DISCARDED (tap-boiq) — so a hermes keep-list has to be re-briefed over the bus after `tap clear <seat>`. Leaving the seat alone remains valid.

## Common mistakes

- Treating token count as authority to interrupt useful work.
- Clearing without preserving the standing assignment.
- Calling a degraded compact a success.
- Restarting first when a verified clear would recover the same session more cheaply.

## Handoff before reset or replacement

A leader, peer, or the seat itself may recommend an authored handoff before
compaction, clear, restart, or replacement. A recommendation to preserve context
does not authorize the reset. Use the current task's authority and the decision
ladder above to choose the action.

Have the outgoing seat write the record while it still has context. Reuse the
[handoff headings and source-file rules](../self/SKILL.md):
Objective, Where, Decisions, In flight, Evidence pins, and Next step. Include
standing constraints, pending reply obligations, worktree custody, and the exact
next action. Use absolute paths and full commit ids; mark unknowns explicitly.

For compaction, use `/tap:self compact --handoff` and its existing runtime copy and
resume prompt. Only Claude Code currently accepts custom summarization
instructions; opencode gets the focus in the post-compaction prompt, and Codex
requires the handoff file outright — its worker verifies a fresh compaction
record in the bound rollout before sending the focus-carrying resume, and a
receipt of `not-compacted` preserves the handoff for a human or supervisor
(tap-n27ug).
For clear or replacement, preserve the record in the successor's durable custody
before the outgoing worktree can be removed, then rebrief the verified recipient
through TAP after the authorized transition. For an experimental self rebrief on Claude/Codex, use `/tap:self rebrief` and its
authored handoff/optional charter plus named recovery owner. Its native observer
orders reset before delivery and reports the stages separately; see the self
skill. `tap refresh` has no authored-handoff flags in this first slice.

The receiver reads the handoff, inspects the current branch/head and dirty files,
reconciles its own identity with `tap whoami` (and `/tap:in` after clear), and polls
its own queue before taking custody. The leader confirms a response naming the
handoff and next action. Keep the source record until that response; a queued
message or a launched replacement alone is not completed transfer. A fresh seat
does not inherit another instance's unresolved obligations merely by reading a
file; route them through their existing senders and owners.
