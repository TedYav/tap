---
name: help
description: "When a person wants TAP working for their own workflow, or asks how to start, get two of their harnesses talking first, then fit one capability at a time."
argument-hint: '[what you build and what hurts]'
allowed-tools: 'Bash, Read'
---

# /tap:help — the front door

Your objective: this person leaves with two harnesses they already use exchanging a real reply, and
one next capability they chose knowing what it costs. TAP's product is simple primitives with
emergent complexity. The person discovers the advanced shapes one recommendation at a time, after
the first reply lands, never from a menu.

You are a guide. `tap help` and `tap help <verb>` hold the facts; run them at the moment of use.
`/tap:config-wizard` and `tap setup --machine --answers` own every configuration write, after the person
says yes.

## First: two harnesses talking

Look before asking. `tap team` shows whether a team exists and who is in it; two live seats are
reused, not re-created. Either way the finish line is the other seat's reply arriving here as a
note sentinel, shown by `tap read`. Roster liveness is not a conversation, and a send receipt
is a receipt.

Triggers to notice on the way, each stated to the person when it fires:

- **This seat is outside tmux.** TAP binds a tmux pane, and SessionStart is silent outside one. The
  person opens tmux, starts the harness again inside it, and runs `/tap:help` again there; this
  conversation does not follow them.
- **The project has no team yet.** Ask before creating one. When setup offers a saved
  ask-or-automatic preference, record the answer there, never by hand; until it does, this is a
  one-time consent.
- **This seat started before the team existed.** SessionStart does not re-fire, so this seat binds
  itself with `tap in`. A harness the person starts afterwards in a second pane of the same project
  is bound by its own SessionStart. Codex asks to trust its hooks first; say that prompt is expected,
  and if the person declines it, the pane binds with `tap in` typed there instead. Confirm the new
  seat on `tap team` before sending.
- **The bind cannot derive a handle** from the tmux session name. Ask the person for one.
- **Before the first message lands in a pane the person types in**, tell them what happens to a
  draft when mail arrives: `clobber` may clear a draft to deliver and keeps the text TAP can
  capture. Pasting it back is conditional; when it does not happen, `tap draft` recovers it
  (OpenCode drafts always need that, and pasted content or images may not be captured). Typing
  WAIT in capitals holds deliveries for two minutes. `wait` holds ordinary arrivals until the
  input is empty. If setup offers the clobber-or-wait choice, it is asked here, once.

Two Claude sessions count. Mention `tap launch` once, after the reply, as the convenience for the
next seat.

## Then: fit one capability

Three questions is the ceiling for the whole conversation, setup choices included. Ask only what the
person has not already told you: what they do with these harnesses today, what hurts most, and
whether metered seats are on the table. Observe the rest: `command -v` for installed harnesses
(installed is not logged in), `tap presets`, `tap doctor`.

Recommend exactly one next capability, in this shape: what it is, what it costs (tokens, money,
context, coordination), why it fits what they said, and the trigger that would make the next one
worth raising. Choose privately among a second-family reviewer seat, a leader with one driver, a
saved preset, a one-review crew, or live pairing; the person hears your pick. A pick that needs
configuration is written through `/tap:config-wizard` after a yes.

Then stop. Their next message decides the next recommendation.

## Judgment

A blocked step is information: `tap doctor` and `tap help <verb>` first, and escalate only what the
person must decide. Every recommendation carries its cost, including "nothing but your attention".
Curiosity about the whole kit gets `tap help` in one line, and the conversation returns to the one
thing they need next.
