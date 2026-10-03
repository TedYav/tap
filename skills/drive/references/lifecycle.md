# Lifecycle

Details for the [drive skill](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Executing the lane's waves

Run your lane's waves — dispatch to lane crew, request gate reviews, receive completion taps
yourself. For ephemeral, parallel work inside your lane, **use burst engines at your own tier** — see
`skills/lead/references/routines/dynamic-workflows.md`, which owns the placement rule and guardrails.

## Decisions and coordination

Resolve ordinary implementation and base conflicts within the assigned goal. Coordinate shared edits directly with the other writer; escalate unresolved semantic disputes, scope changes, incidents, human decisions and one-way doors under AGENTS.md. Never overwrite another lane’s in-flight intent. Use team-qualified addresses across worktrees; confirm a launched seat with `tap whoami`, and reconnect with `tap in` only when unregistered.

## Lane lifecycle

Start a specified bounded task directly. Plan first for a new role, new subsystem or one-way door. Rebase and retarget as needed using `skills/lead/references/base-motion.md`; post identity, impact and conflicts as evidence.

When the PR meets AGENTS.md’s merge-ready conditions, squash it, sync the installed primary, report the outcome and release custody. Send one line per pushed head with the PR, head and changed scope; closeout adds the CI receipt, review/thread census and installed provenance. Use the bounded bot loop in AGENTS.md when needed. Preserve work before abandoning a lane; escalate deletion of unique evidence.

Successors are announce-and-go. The lane queue published in the strategy IS the grant. When your
done-when satisfies, take the oldest ready item in your lane's queue that falls within your charter's
scope, meets the charter work class, requires no metered build, and has a partner available if needed:
If it is a ticket, mark it in progress from the primary checkout. In either case, send the seat you
report to ONE settle-only line naming the ticket or named work item and branch, then start; for a named
non-ticket item, that line is its durable claim record.
They order queues and may veto in the next digest; they do not issue grants. If a needed response is missing, inspect the actual dependency and delivery evidence. A working seat may reply once with status and continue; elapsed silence or unchanged HEAD alone does not establish a stall. Nudge a confirmed missed wake once without resending its tracked request. Escalate a blocker that needs a decision, and continue independent work. If no queued item is ready, report the concrete dependency.
