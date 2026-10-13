# Explicit sender withdrawal (tap-owanr)

> Normative TAP v0.23 page. Not a source fragment — new normative prose.


`tap withdraw <id> [-m <reason>] [--superseded-by <id>] [--by <me>] [--json]`
retracts an obligation the recipient ALREADY HOLDS, because the sender
superseded it. It is the companion of rule 43's head-move cancellation, which
had no verb: `tap cancel` refuses a live addressee by design, so a delivered ask
the sender no longer wants answered aged in `tap outstanding` indistinguishable
from a real unanswered one while the recipient's queue held a dead head.

Withdrawal is not resend's withdrawal half under another name, despite sharing
the word. Resend withdraws only under affirmative proof that NO delivery attempt
occurred, because resend re-delivers. Withdraw never delivers, so that proof is
not merely unnecessary but wrong: it would refuse exactly the delivered case the
verb exists for. Withdraw reuses resend's authority checks and its obligation
lock, and none of its preconditions.

Eligibility requires the original sender's handle, and the original sender's
team when the envelope names one. It is deliberately NOT bound to
`sender_instance`, which resend does check: resend re-sends under the current
identity, while withdrawal only retracts, and a seat that has refreshed its
context (a manual `/clear` and re-register) is the ordinary holder of its
predecessor instance's aging asks. A payload still parked in the spool is
refused with `not_delivered` and directed to `tap cancel --spooled`, which owns
undelivered mail and its courier claim. A recipient `.done` refuses with
`already_settled`: a real settlement is never overwritten by the sender's
retraction. Withdrawal is not repeatable.

The receipt is `receipts/<id>.cancelled` with `status: cancelled` and
`via: withdrawn`, plus `by`, `at`, and the optional `reason` and
`superseded_by`. Reusing the `.cancelled` name is what keeps every existing
reader correct with no change: `tap_is_done` is already true for it, so the
obligation drains from `tap outstanding`, the drain's resurrection guard skips
the id, and redelivery eligibility already classifies it as
`cancelled-after-delivery-attempt`. Provenance never claims the recipient
settled. `via` distinguishes a sender's retraction of delivered mail from
cancellation of mail whose addressee is gone; readers of a `.cancelled` receipt
read that field rather than assuming `cancelled`.

**The payload stays in `payloads/`.** Cancellation archives it, and for a
delivered id that is the defect rather than the remedy: a `.cancelled` whose
payload moved to archive leaves the recipient's already-delivered doorbell
pointing at a path that no longer exists. Residency is also what keeps the
digest index and the archive-name strip correct without change, since both key
on where the payload is rather than on the receipt.

The recipient sees a tombstone rather than a dead head. `tap read <id>` answers
`superseded: <reason>`, names the successor when one was given, exits 0, owes
nothing, and writes no settlement of its own — the sender withdrew it and the
recipient did not settle it, so provenance keeps saying so. `tap reply <id>` is
refused with `withdrawn`, naming the successor as the next action when one was
given. `tap show <id>` renders `via`, `reason` and `superseded_by` on the
receipt row.

Withdrawal marks and does nothing else: no spool mutation, no pane effect, and
no re-delivery. The interrupt class is therefore permitted, unlike resend, which
excludes it — there is no second interrupt to fire. That property is mechanical
rather than promised, since the receipt alone is what stops the drain.
**Terminality is part of the residency decision, not separate from it.** Leaving
the payload resident is defensible only because every reply and settle door
treats `.cancelled` as terminal. Native `assertUnsettled` consults `.done` OR
`.cancelled`; the Bash reply doors that consulted the same record through
`tap_refuse_if_cancelled` are deleted (cut sprint D), so native reply is the
only reply door.
A withdrawn id refuses there under error class **`withdrawn`**, naming the
successor when one was recorded; any other `via` refuses `already_settled`.
Without that, a withdrawn-but-resident payload was ordinary-looking inbound mail
on the Bash-owned forms (`--pane`, `--reply-to`, `--kind escalate`,
`--delivery interrupt`, and the whole verb when the flip marker is absent): the
door would deliver an outbound and write `.done` beside the `.cancelled`, and
since readers prefer `.done`, the tombstone disappeared and provenance claimed
the recipient settled a retraction.

**Two shapes motivate the verb, not one.** The first is the superseded ask: a
head moved, or the sender corrected the question, and rule 43 says the asks it
supersedes are cancelled. The second is the obligation whose CONTENT was
delivered OUT OF BAND — the courier stopped at its grace deadline against an
unreadable pane and the sender said the thing another way (a PR comment, a
different channel), so the answer is no longer owed but the obligation has no
way to close. Without withdrawal that second shape has no verb: `tap resend` would
ring the same message again when the answer is no longer owed, `tap nudge` would
re-enter pane delivery on the same pane that could not take it, and the obligation ages — showing up in other
lanes' post-wave operator-state windows while it does. Both shapes are the same
act: **the sender declares the obligation retired, with a reason the recipient
can see, without any pane delivery.** That is what withdrawal is, and why it
neither re-delivers nor touches a pane.

