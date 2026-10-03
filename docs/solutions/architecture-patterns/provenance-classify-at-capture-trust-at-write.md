---
title: Provenance-classify at capture, decide trust at write — quarantine untrusted identity instead of overwriting it
date: 2026-07-21
category: architecture-patterns
module: tap session launcher (manifest restamp + reservation classifier, skills/tap/scripts/session/launcher.py) and direct-register capture (skills/tap/scripts/tap-register.sh)
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "a system reads an id from a foreign system (harness conversation id, external session token, third-party job handle, cached account id) and later reuses it to revive or re-establish state"
  - "the same field is written by several code paths that obtained the value under different levels of certainty (a value your code minted vs. one a human picked blind from a chooser)"
  - "a capture boundary (a hook, a callback, a webhook) accepts a value and stores it as truth without recording how the value was obtained"
  - "designing a write path where a wrong-but-plausible value is more dangerous than a missing one, because the wrong value is trusted silently on every later read"
  - "documenting a defense-in-depth guard whose uniqueness/consistency check is not backed by a single atomic transaction"
tags: [provenance-not-identity, capture-classification, quarantine, fail-open-fail-closed, toctou-disclosure, seat-identity, session-launcher, defense-in-depth]
related_components: [development_workflow, documentation]
---

# Provenance-classify at capture, decide trust at write

## Context

TAP seats carry a native `harness_session_id` — the conversation id the harness (Claude, Codex, Cursor) reports at `SessionStart`. The launcher manifest and the registry stored that id and treated it as **identity truth**: the value a future `tap session resume` hands to `harness --resume` to bring the seat back. Capture was **provenance-blind**. A picker/latest/adopted resume — where the harness UI lets a session adopt *some* conversation, not necessarily this seat's — would silently overwrite the seat's durable id with whatever the chooser landed on. The next revive then resurrected the **wrong principal** (another seat's conversation) into the seat, with a clean receipt and no warning. The failure is a capture that trusts an unattested id. This doc is the pattern that fixed it.

The fix shipped in protocol v0.10 ("fix(session): prevent poisoned native identity revival"). This doc captures the four transferable design principles the fix embodies — the reusable pattern, not the one incident. The root cause generalizes past TAP: **`harness_session_id` is provenance data (where a capture came from) that was consumed as identity truth (who this seat is), with no classification of *how* the id was captured and no cross-record uniqueness check before revival.**

## Guidance

Four principles, each grounded in the TAP mechanism that implements it.

### 1. Provenance-classify at capture time; decide trust at write time

"Who wrote this, and under what claim" must ride *with* the data to the write path — because once provenance is discarded at capture, no later reader can reconstruct it. Split the two questions the old code conflated: *does a resumable conversation exist for this id* (a filesystem question) from *is this id trustworthy as this seat's identity* (a provenance question).

In TAP, the launch reservation classifies the **next** capture before it happens. `claim_pending_handle` (`launcher.py`) stamps an `identity_capture.mode` onto the pending registry reservation at claim time: `launcher_new` when the launcher minted the conversation, `exact_resume` when it is resuming an id it already recorded, or `untrusted_resume` when it is resuming with no recorded id to match against — carrying the `expected_harness_session_id` when one is known. The write path — `restamp_manifest_session` (`launcher.py`) — then trusts a capture *only* when it is launcher-created or an exact resume whose observed id matches the recorded expectation. The classification is the provenance channel the old bare-inequality writer lacked.

### 2. Quarantine, don't overwrite — keep suspect values visible

A capture that fails the trust test is neither trusted nor dropped. It is written to **dedicated quarantine fields** so an operator can inspect it, while the durable identity is left untouched. TAP stamps `quarantined_harness_session_id`, `quarantined_transcript_path`, and `identity_quarantine_reason` (`launcher.py` — `SessionRecord`; CONTRACT.md:150-152), and emits one loud stderr `WARNING` (`launcher.py` — `restamp_manifest_session`; register-side `tap-register.sh:942-943`). Overwriting would poison identity; silently dropping would erase the evidence an operator needs to tell a legitimate rotation from an attack or a bug. Quarantine keeps the fact and refuses the trust.

### 3. Fail-open for startup, fail-closed for durable identity

The suspect conversation is still allowed to **run** — harness startup must not wedge because a capture looked odd. What it may not do is **silently become the identity the next revive trusts**. Registration remains successful even when the capture is quarantined (CONTRACT.md:168: "harness startup stays fail-open while future revival stays guarded"). The two failure domains get opposite defaults: availability fails open, durable identity fails closed. This is what lets the guard ship without regressing the post-reboot recovery paths it sits inside.

### 4. Cross-check uniqueness at revival — and disclose the TOCTOU window instead of overclaiming

Two independent guards back the classification:

- **Duplicate-id scan at both writers.** Each writer independently scans readable machine rows/records for another owner of the same native id before trusting it. The launcher pairs `duplicateHarnessSessionOwner` (manifest records) with `duplicateRegistrySessionOwner` (enrolled registry rows), surfaced through `assertUniqueHarnessSessionIdentity` — one owner in `runtime/bun/src/launcher/identity-owner.ts`, which `launcher.py` reaches through the launcher worker; the register path mirrors this in `duplicate_identity_owner` (`tap-register.sh:683`). Crucially, **when `TAP_SESSION_MANIFEST` is unset both scans fall back to the default `~/.tap/launcher/sessions.json` manifest** (`tap-register.sh:732`) — without that default-path fallback the duplicate scan is blind in the normal production case (this was itself a review must-fix, caught by grok and locked with an A/B regression).
- **Revive-time assertion before any destructive step.** Every native revive calls `assert_unique_harness_session_identity` **before** claiming the handle or destroying the vessel — from `make_new_record`, `cmd_resume` and `cmd_restart` (`launcher.py`) and the native `resume --all` cohort (`resume-all.ts`) — and every revival prints `expected seat <handle>` before invoking the harness (via `state_expected_revive_identity`, plus the `resurrected`/`reseated` receipts in `make_new_record`). The receipt already named the id it resumed; the missing half was the *expected principal*, so the seat itself — the only party that can notice a lineage mismatch — has something to reconcile against.

Then **state the limits honestly in the contract rather than papering over them.** These are defense-in-depth checks, **not an atomic allocator**: revive validates before its launch transaction and does not revalidate under one cross-store lock, so a cross-store TOCTOU window remains and concurrent cross-registry first-fills can both pass (CONTRACT.md:168). And the checks **cannot** catch the original renamed-record specimen once the former owner's row is gone — there is no duplicate left to detect (CONTRACT.md:5). Disclosing both is part of the pattern: a guard documented as atomic when it is not is worse than one whose window is named.

## Why This Matters

A wrong-but-plausible value is more dangerous than a missing one, because it is trusted **silently on every later read**. A poisoned id is *more* likely to pass a naive "does a resumable transcript exist?" check than a legitimately stale one, precisely because it was copied from a live, healthy, recently-written conversation. The cheapest place to reject a bad value is where it arrives — while the writer still knows how it was obtained. After that, the provenance is gone and every downstream reader inherits the mistake as fact.

The startup-vs-identity split matters because the two concerns pull in opposite directions and a single default serves neither. Fail everything closed and a suspect capture wedges harness startup — the exact wedge the surrounding recovery ladder exists to prevent. Fail everything open and the poison writes through. Separating the domains lets the suspect conversation run while denying it the one power that does durable harm.

The honesty clause matters because defense-in-depth invites overclaiming. Layered guards are easy to describe as if they closed the hole. Naming the residual TOCTOU window and the undetectable renamed-record case keeps the next reader from trusting a guarantee the code does not make, and tells them which shapes still need an operator's eye.

## When to Apply

- **Any revival from a foreign system's id** — a harness conversation id, an external session token, a third-party job handle, a cached account id. Treat the stored id as a *claim to be verified*, not a fact.
- **Any field written by multiple paths under different certainty.** When one path mints a value and another adopts it from a chooser, they must not be written with identical trust. Route the certainty into the write.
- **Any capture boundary** (hook, callback, webhook) that stores an external value as truth. Classify how the value arrived at the boundary, not just what it is.
- **Any write where a wrong value is silently trusted forever.** If a bad write is invisible on every later read, validate at the write, quarantine the suspect, and make the expected value visible to the party that can detect a mismatch.
- **Any defense-in-depth guard without a single atomic transaction.** Document the TOCTOU window and the shapes the guard cannot see, in the contract, in the same change.

When the capturing process minted the value itself, under a lock so nothing else can write it first, there is nothing to classify.

## Examples

### Capture: from blind inequality to classified trust

Before (the poisoning writer, as documented in the sibling doc): `restamp_manifest_session` took an id and a path and wrote on a bare inequality check, its own docstring conceding *"the hook/register path supplies the identity; this writer never infers it."* An id the launcher minted and an id a human picked blind were written with identical trust.

After (`launcher.py` — `restamp_manifest_session`): the same verb takes `capture_mode`, `capture_decision`, and `expected_harness_session_id`. A `launcher_new` capture may establish or rotate identity; an `exact_resume` is downgraded to untrusted if it carries no expectation to match; a picker/latest/adopted or expectation-mismatched capture writes only the quarantine fields plus a reason, and never touches `harness_session_id` or `transcript_path`.

### Revive: assert identity before destroying anything

```python
# launcher.py — every native revive path, before claim/vessel destruction
assert_unique_harness_session_identity(records, target, action)   # raises if the id
                                                                  # belongs to another seat
# ...
print(f"tap session: reviving {record.name}; expected seat {session_handle(record)}")
```

The `expected seat <handle>` line (`launcher.py` — `state_expected_revive_identity`, and the `resurrected …`/`reseated …` receipts in `make_new_record`) is the cheapest safeguard in the stack: it enlists the one actor — the revived conversation — that can actually detect a lineage mismatch, which is what caught the original incident.

### The regression that locks the default-path fallback

`skills/tap/scripts/smoke/session-id-capture.test.sh` runs the A/B pair that proves the guard both fires and does not over-fire:

- With `TAP_SESSION_MANIFEST` unset, a bare direct capture whose id collides with the default `~/.tap/launcher/sessions.json` manifest is quarantined with `expected seat fable` in the reason and a warning emitted (`:108-128`) — the production default-path case the blind scan would have missed.
- A launcher-minted id is trusted into `harness_session_id`, while a `seat-picked-id` on the same seat is quarantined (`:280-291`) — trust and refusal on the same code path, so the guard cannot be satisfied by simply refusing everything.

## Related

- [`../integration-issues/native-resume-forks-seat-identity.md`](../integration-issues/native-resume-forks-seat-identity.md) — the handle-forking sibling in the same family (right conversation, wrong handle), where this doc is right handle, wrong conversation.
- `skills/tap/scripts/CONTRACT.md` — the harness-session identity capture and direct harness identity sections, including the fail-open/fail-closed and TOCTOU disclosures.
