---
title: Native resume outside the launcher forks a seat's identity — the three-step reclaim
date: 2026-07-20
category: docs/solutions/integration-issues
module: tap register / session resume (SessionStart auto-register)
problem_type: integration_issue
component: tooling
symptoms:
  - "a lead seat resumed via the harness's NATIVE resume lands in a fresh tmux session and SessionStart mints a FORKED handle (seat -> seat-2) instead of rebinding the original"
  - "the original handle stays bound to a dead pane while the fork silently captures inbound routing"
  - "a teammate's report arrives addressed to the forked handle (to=seat-2), not the seat you think you are"
  - "`tap reply` on a fork-addressed payload is refused (only the addressee replies); `tap done` needs `--by <fork>`; the substantive answer has to go as a NEW send, breaking in_reply_to provenance"
root_cause: missing_tooling
resolution_type: recovery_procedure
severity: high
tags: [seat-identity, session-resume, native-resume, launcher-bypass, recovery-recipe, reply-provenance, fork-reclaim, tmux]
related_components: [development_workflow]
---

# Resuming outside the launcher opens a second registration

## Problem

Every harness (Claude, codex, ...) has a **native resume path that bypasses the TAP
launcher**. When a lead seat is resumed that way, it comes up in a *fresh tmux session*.
The SessionStart auto-register hook then derives a handle from the **new session name** and,
finding the canonical handle already in the registry (bound to the now-dead original pane),
mints a **forked** handle (`seat` → `seat-2`) instead of rebinding the original seat.

The original handle stays bound to the dead pane. Later messages arrive on the suffixed handle.

## Symptoms

- Auto-register on the resumed pane emits a suffixed handle (`seat-2`) rather than
  reclaiming `seat`.
- The canonical handle's registry entry still points at the *old* (dead) pane; the live
  conversation is registered under the fork.
- A diagnosis/report from a teammate arrives `to=seat-2` — inbound routing followed the
  fork, so work addressed to the seat is invisible to the reclaimed one until reconciled.
- After reclaim, the stranded fork-addressed payloads cannot be answered normally: `tap
  reply <id>` is refused ("addressed to 'seat-2', not 'seat' — only the addressee
  replies"), `tap done <id>` requires `--by seat-2`, and the real answer must be sent as a
  fresh message — losing the `in_reply_to` chain.

## Recovery recipe

Reclaim the original handle before answering anything that arrived on the suffix:

1. **`tap in <handle> --force`** — releases the stale fork ("released stale seat-2; reason:
   same pane") and reactivates the canonical handle on *this* pane. `--force` reclaims the
   EXACT handle even from a live entry, which is what you want here.
2. **`tmux rename-session -t '=<fork-session>' <canonical>`** — realign the tmux session
   name to the canonical (e.g. `tmux rename-session -t '=tap/seat-2' 'tap/seat'`). The
   `=` prefix is tmux's **exact-match anchor** — without it, `-t tap/seat-2` matches by
   prefix and can hit the wrong session. This makes future session-name derivations resolve
   to the canonical handle again.
3. **`tap in` (idempotent, bare)** — refresh the stored pane address under the reclaimed
   handle. This bare rebind is now *pane-first* (see below), so it resolves the
   pane's already-attached identity rather than re-deriving from the session name.

**Historical workaround (superseded):** when this was written, the reclaimed seat could not
settle fork-addressed inbound, so the recipe was to run the retired `tap done <id> --by <fork>`
and send the substantive answer as a new message with the broken provenance noted in the body.
`tap done` is now a tombstone that settles nothing. Current practice: with a valid pinned
adoption grant to the successor, settle fork-addressed mail normally under the successor
(`tap read <id>` for a note, `tap reply <id> -f <file>` for an ask); the grant and the actor
recorded as `adopted_from` are specified in
[registry-unit-1-part-13](../../../skills/tap/protocol/identity/registry-unit-1-part-13.md).

## What registration does now

Two mechanisms in `runtime/bun/src/verbs/register.ts` cover part of this class:

- **Pane-first nameless rebind.** A register with no handle first uses the handle already
  attached to this pane. It derives a handle from the session name only when the pane has
  no registered identity. Re-running it on a pane that already carries the canonical handle
  rebinds to that identity. That is what makes recovery step 3 reliable.
- **Same-session dead-identity reclaim.** When a derived handle collides with an incumbent
  whose pane is gone, and the new pane is in that same session, the handle is reclaimed
  with no suffix. A collision with a live incumbent takes a suffix instead.

Net: if native resume lands in a session whose name derives back to the canonical handle and
the original pane is truly dead, the auto-register can now reclaim cleanly. The residual
failure is the **dead-incumbent resume path** where the fresh pane is not yet registered
under the canonical handle and the new session name derives to a *different* handle (or a
different session), which is exactly what forks.

## What's still manual

The pane-first rebind only helps once a pane already carries the canonical identity. The
*first* auto-register of a brand-new resumed pane has nothing attached yet, so the fork can
still happen — and reclaiming it is still the three manual steps above. Two automation
mechanisms are agreed but unbuilt:

1. **Reconciliation on handle reclaim** — when the fork is released, its
   addressed-but-unsettled payloads and obligations should reconcile to the reclaiming seat
   (design fork still open: payload adoption vs. alias table vs. settle-by-either), so reply
   provenance survives instead of stranding.
2. **Resume-machinery robustness** — `tap session resume <handle>` with a stale/dead session
   id should *degrade to the harness's native picker* instead of refusing, then remind /
   auto-prompt `tap in` on entry so the fresh session id binds to the seat. A later specimen
   showed the picker path can select the wrong conversation: the resume machinery must
   **verify conversation identity at picker selection** — match the picked conversation
   against the manifest record (cwd, handle, harness session id when present), never
   auto-select, and surface a loud identity mismatch post-resume (the post-resume
   reminder should state who the seat is expected to be).

   A picked id captured onto the manifest is a different failure. Every later launch, resume,
   restart, or revive then brings back the wrong conversation. The handle is correct and the
   conversation is wrong, so the symptoms and recovery steps on this page do not apply.

## Prevention

- **Prefer `tap session resume <handle>` over the harness's native resume** for any seat that
  is on the bus — the launcher path binds identity correctly; native resume is what forks.
- **If a fork happens, run the three-step reclaim immediately.** The fork captures routing
  silently, so latency directly costs stranded payloads.
- **Settle fork-addressed payloads with `--by <fork>`** and send answers as new messages —
  don't fight `tap reply`'s addressee rule; note the provenance break in the body until
  reconciliation lands.

## Related Issues

- Reconciling a forked identity, and a resume that does not depend on the harness remembering
  who the seat was, are still manual.
- A live same-session incumbent blocks exact reclaim. That is the live-incumbent sibling of
  the dead-incumbent path this page describes.
- A pane-first rebind resolves the pane's existing registry handle before deriving a session
  name.
</content>
