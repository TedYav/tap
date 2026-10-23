# Decision packet (the escalation artifact)

A `decision_packet` is what `/tap:discuss` emits when it **cannot** converge on its own authority — either the round cap was hit with items still open, or the loop reached a bounded-authority wall (a schema/migration/assertion/merge decision, or an autonomous edit to a routing-bearing/shared surface). It is never a silent give-up (L8); it is a structured hand-off to a `human_decision`.

Send it to every peer over TAP as `tap send <peer> --wake <packet-file> --kind decision_packet` (or `tap reply <id> <packet-file>` if it answers an inbound); name any artifact it concerns in the packet body. The factual base (the open ledger items) is the driver's `skills/discuss/scripts/ledger.sh list <thread> --by <me>` output.

## Template

```
DECISION PACKET — <thread_id> (round <n>/<cap>)

Question: <the single decision the human must make>

Why it is escalated: <the round cap was hit | the decision is a schema, migration, assertion, or merge | the edit touches a shared routing surface>

Options:
  A. <option> — <each seat's position, by handle: where they agree, where they differ>
       evidence: <message ids, a file and line, or ledger item ids>
  B. <option> — <the same for this option>
       evidence: <...>

Recommendation: <the joint lean, or which seat favors which option>

Blocked until a human decides:
  - <ledger item id>: <what cannot proceed until the decision>

Open ledger (unresolved): <from skills/discuss/scripts/ledger.sh list>
```

## Rules

- **One question per packet.** If several decisions are entangled, send several packets.
- **Show where the seats differ, by handle.** Do not merge the views into one. A split recommendation is a legitimate result.
- **Evidence, not assertion.** Every option cites ledger items, message ids, or a file and line. Keep the evidence separate from the reason.
- The packet states what the seats found and where they landed. It is subordinate to the human's call. The human's answer is a `human_decision` ledger entry, which closes the escalated items.
