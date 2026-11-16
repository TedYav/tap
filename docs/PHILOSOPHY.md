# TAP Philosophy

TAP = TAP Agent Protocol. The goal: **stupidly easy cross-agent orchestration using tmux.** Everything below is in service of that sentence. When a design question comes up, these are the tiebreakers.

## The transport is intentionally dumb

One sharp knife in a sheath: TAP moves bytes and wakes a pane. It does not act on what a message says. Semantics (convergence, review verdicts, goals, phases) live in skills *above* the transport. If a feature idea adds interpretation to the transport, it belongs one layer up. Timers, leases and background processes do exist, in separately named parts: the redelivery waiter that delivers parked mail once its recipient is ready, `tap watch` and the goalie. They decide when to try again or whom to wake, never what a message means. Core contract: `skills/tap/scripts/CONTRACT.md`; detailed authority: `skills/tap/protocol/`.

## Push, not poll

The sentinel wake model is the whole magic: after sending, continue any useful work that does not depend on the response; when the next useful step does depend on it, yield and let the peer's reply wake your pane. Zero polling anywhere. Any feature that tempts an agent to poll-sleep (or a supervisor to heartbeat a model) is wrong by construction — a dumb shell loop can watch files for free; a model wakes only when a predicate fires.

## Observable state is the only truth

Every liveness question must be answerable from files on the bus: `payloads/`, `receipts/*.done`, `.tap/team-registry.json`, `tap outstanding`, `tap doctor`. No component may claim knowledge that isn't observable. Corollary: fail loud. A guard rejects the unexpected; it never silently copes. A degraded outcome is human-visible, never silent success.

## Heterogeneity is the point

Agents in different harnesses have different strengths, so a team should be able to mix them. TAP supports six harnesses today: Claude Code, Codex, OpenCode, Cursor, Antigravity (`agy`) and Hermes. The list is closed in the code: launch and delivery refuse any other program, so a new harness is a source change (`tap help skill extend` maps it). The aim is to keep that change small: prompt detection and a submit/verify shape, not an SDK integration. The wire format is the same for every harness, but support is uneven: Claude Code and Codex alone get the full TAP plugin, conversation fork and the resume picker.

This cuts deeper than peer diversity: **the same model will appear through different harnesses as compute economics shift** (API resellers, cheap-compute deals), so even the team-lead role must be harness-portable. No documented flow — driving, reviewing, onboarding — may depend on a capability only one harness has. Where a lead needs harness-specific operational knowledge, that knowledge belongs in written docs the agent can read, not in ambient familiarity with one harness.

## No protocol step requires judgment

Every obligation an agent has must be mechanically decidable from what's in front of it — the sentinel, the payload, the command output. The canonical case: handshake termination. Settlement IS the acknowledgment — a `.done` receipt already tells the sender "received"; a payload whose only content is an acknowledgment is forbidden, because deciding when to stop acking requires judgment and non-frontier agents will loop. The sender declares whether a reply is expected; the recipient follows the stamp. If a protocol rule needs a frontier model to apply correctly, the rule is wrong — TAP must work for the dumbest agent that can hold a tmux pane.

## Layering — a TCP/IP-shaped stack, shipped together, never fused

```
wire layer      (like IP)   addressing + delivery + wake: registry, handles,
                            team-as-namespace, payload write, sentinel inject
exchange layer  (like TCP)  reliable exchange: receipts, settlement-as-ack,
                            reply expectation, outstanding, retry/hardening
application     (the stack) conversations, team dynamics (driver/sidekick),
                            convergence, goals, supervision
```

Per-edge roles — sender/receiver, initiator/responder — are wire facts. Team-dynamics roles are application concerns; richer team notions will arrive as the product grows, but always as layers over the exchange contract, never compiled into it. The membership test for the lower layers: would the dumbest agent on a temporary conversation need it? Acks pass; roles fail.

Where the TCP analogy deliberately breaks: no connection state, no sessions, no sequence numbers. Every layer is files on the bus plus one-line sentinels, and first contact is data — there is no handshake setup phase. TCP names which concerns group together, not an architecture to imitate.

Each layer only trusts the observable state of the layer below. The supervisor watches *between* teams at the layer choreography intentionally leaves uncovered; it wakes the right party but never reassigns work, settles someone else's payload, or edits protocol state.

## Stupidly easy, for humans and agents

The human experience is: `tap init`, `tap launch` each agent, ask the driver in plain English. The agent experience is: one command surface (`tap <verb>`), a one-line sentinel, three obligations (read the payload, reply, settle). A capable model should grok TAP from one screenful of advisory text and immediately orchestrate a heterogeneous swarm with it. Every ergonomic footgun (fence requirements, second-Enter quirks, cwd-dependent paths) is a bug against this principle, even when the underlying contract is sound.
