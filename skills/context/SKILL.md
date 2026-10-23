---
name: context
description: "At task boundaries or before compact, clear, or restart, choose the least disruptive TAP context recovery."
role: choreographer
allowed-tools: 'Bash, Read, Grep, Glob'
---

# TAP Context Hygiene

Use the least disruptive recovery that restores reliable work. Context size
alone is not a fault. Preserve the seat's judgment and turn boundary when it can
respond; request the self skill over TAP with the desired keep-scope and Next step.

## Custody and recovery

- Before a context change, reconcile owned work and return any Writer Token
  explicitly. Preserve the standing assignment and current state durably.
- A reset or replacement needs its existing authorization. A recommendation to
  write a handoff does not authorize resetting a seat.
- Read the whole recovery brief before loading role guidance. Load the named
  skills without replaying initialization, reconcile live schedules and obligations,
  then follow the brief's Next step, including a hold or wait for orders.
- A queued note proves transport acceptance. Recovery is confirmed by the
  resumed seat reporting the brief it read, restored role and next action.

## Decision ladder

Choose in this order: **leave alone → compact → rebrief → replace/restart**.

| Signal | Action |
| --- | --- |
| Seat is on track and progressing | Leave alone. |
| Useful conversation should survive in summarized form | Ask the seat to run `/tap:self compact` with an additive keep-list. |
| Same role needs fresh context built from authored instructions and selected state | Ask the seat to run `/tap:self rebrief`, naming Keep scope and Next step. |
| A new workstream needs a new assignment | Requester owns replacement: peer `tap clear <seat> -m`, `tap refresh <seat> --fresh`, or a new seat. |
| Harness is wedged and cannot prepare its continuation | Preserve recoverable state; use the authorized peer clear or session restart lifecycle. |

`/tap:self clear` is a deprecated alias of rebrief. It authors the same brief
and invokes canonical rebrief; it does not silently drop the continuing role.
“Wait for my next assignment” is a valid Next step for a rebrief.

## Request a responsive seat's self recovery

Send a literal body file so the receiving seat gets intent, scope and next action:

```bash
tap send <seat> --ask -f <request-file>
```

The request names `/tap:self compact` or `/tap:self rebrief`. The skill writes
the required `tmp/<seat>/handoff-<UTC>.md` and passes `--handoff FILE` itself;
the operator need not supply plumbing. The brief carries charter and exact role
invocation, Keep scope, constraints, still-owned obligations, custody, scheduler
ids, decision reasons, source pointers and Next step. Narrowing scope requires
transferring an owned obligation or keeping its one-line pointer.

Optional `--notify SEAT` names an outcome audience only. A peer requesting the
outcome passes itself. Omission never infers another seat: successful recovery
reports in the resumed seat's own conversation, and an asynchronous failure is
recorded only in the receipt/log. Explicit invalid, self or inactive recipients
refuse before effects. The worker never reports that the brief was read.

## Peer controls

For a seat that cannot reliably compose its own continuation, or under an
explicit directive, the existing peer controls remain available:

```bash
tap compact <seat> [-m "what must survive"]
tap compact --all [-m "shared focus"]
tap clear <seat> [-m "first instruction"]
```

Peer compact supports Claude and OpenCode, observes native proof and sends a
resume note before returning. `resume-sent` is transport, not recipient reading.
Codex peers refuse (and `--all` skips them); ask them to run `/tap:self compact`.
Every `tap compact <self>` alias refuses and points to that skill.

Peer clear replaces the process in the occupied pane and verifies the rebind;
it is not the old slash-command injection path. Its `-m` instruction is delivery,
not evidence of processing. See `tap help clear` for supported harnesses and
partial outcomes. A self target refuses. Bare self `tap refresh` also refuses
before reset and points to `/tap:self rebrief`; peer refresh, including `--fresh`,
retains its lifecycle and obligation checks.

## Handoff before reset or replacement

Have the outgoing seat write the record while it still has context, using the
[brief sections and source-file rules](../self/SKILL.md). The CLI copies self
briefs durably before arming and preserves them on timeout. It never writes a
summary, guesses a role from the roster or launches a model.

For a replacement, copy the record into the receiver's durable custody before
removing the outgoing tree. Route obligations through their existing senders
and owners: a fresh instance does not inherit them merely by reading a file.
The receiver inspects current branch/head and dirty files, reconciles identity
with `tap whoami`, and runs `tap poll <self>` before taking custody. Preserve the
source until the receiver confirms reading it.

Read pending payloads with `tap read <id>`; answer asks with `tap reply`, while
successful reads settle notes. Preserve any team prefix for both read and reply.
A digest's `--all` reads each body; never settle the digest itself. See `/tap`
for transport details. Missing or uncertain recovery calls for inspecting the
receipt and forwarding the preserved brief, never replaying a possible reset.
