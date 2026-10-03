# Features we'll build on community demand

TAP ships with a small default surface. The features below are designed or scoped, but we are
holding them until users ask. If you want one, open an issue naming the feature and the workflow
it would unblock for you, or add a 👍 reaction to an existing issue for it. Demand decides the order.

**The default today:** TAP lets any agent running in tmux talk to any other, and you install it
per user rather than per repository.

| Feature | What it would add | Tracker |
|---|---|---|
| Per-repository opt-in mode | TAP stays silent in repositories you haven't allowed. The allowlist of canonical repositories lives in your own config, never in the repository, so committed content can't switch on its own channel. | tap-nkuhn |
| Tunable security levels | Choose how strict agents must be, the way some databases let you tune consistency. A stricter level adds prohibitions to TAP's hooks and agent instructions: for example, no input typed into another agent's pane outside standard TAP messages unless you explicitly asked for it. This makes aligned agents more likely to avoid unsafe actions. It cannot stop a misbehaving agent, which can always type text that looks like yours, so it is probabilistic rather than a security boundary. Stricter levels also deadlock more often, because recovery steps that type into panes need you instead. You pick the point that fits your trade-off between safety and liveness. | tap-7wh3l |
| Model-assisted input detection | Jev, an optional fast decision model (bring your own key), reads a pane before delivery and judges whether it is idle, busy, blocked or waiting for you, and whether the composer holds your draft. Today these calls are rule-based. The model stays advisory until its accuracy is measured, and TAP never requires it. A later step could hold an exclusive input lock while a delivery is judged and typed. | tap-nnrzx, tap-zmegh |

**What TAP is not.** TAP is not a secure agent-to-agent messaging system, and none of the features
above would make it one. Anyone who needs that needs a different design: a pull model in which every
message is cryptographically signed and each agent runs a loop that reads new messages only from an
approved source. See [SECURITY.md](../SECURITY.md) for the trust model.
