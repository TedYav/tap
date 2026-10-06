# Delivery and recovery

Normative TAP v0.23 protocol pages. Open only the page needed for the current question.

- [Delivery reliability](./reliability.md) — durability, recipient-observed target and recovery.
- [Delivery receipt measures](./receipt-measures.md) — nightly receipt joins, denominators and the initial evidence report.
- [Idle staged-submit](./idle-staged-submit.md) — the one licensed Enter on a staged sentinel (tap-9lqa7).
- [Default-deny](./default-deny.md) — no TAP key answers an approval prompt or trust dialog (tap-rlebf.1).
- [Approval timeout](./approval-timeout.md) — an opted-in team declines an unanswered approval request once, with a recovery-run Escape (tap-rlebf.2).

A retained exited pane (`pane_dead`) holds delivery and keeps canonical mail.
It does not establish physical absence or authorize cancellation. Before
placement, send refuses without suspending the recipient. After placement it
reports placed, not delivered; after a possible effect it reports unconfirmed.
The dead-pane cause survives input-band classification and takes precedence
over force, no-spool and no-prompt overrides. Cleanup still verifies the
retained pane's identity before removing it.

- [Sentinel (the wire poke — zero authority) — source part 1 of 2](./sentinel-the-wire-poke-zero-authority-part-01.md) — source bytes 469392–477281
- [Sentinel (the wire poke — zero authority) — source part 2 of 2](./sentinel-the-wire-poke-zero-authority-part-02.md) — source bytes 477281–482991
- [CLI surface (the whole thing) — source part 1 of 11](./cli-surface-the-whole-thing-part-01.md) — source bytes 482991–483437
- [CLI surface (the whole thing) — source part 2 of 11](./cli-surface-the-whole-thing-part-02.md) — source bytes 483437–492435
- [CLI surface (the whole thing) — source part 3 of 11](./cli-surface-the-whole-thing-part-03.md) — source bytes 492435–501434
- [CLI surface (the whole thing) — source part 4 of 11](./cli-surface-the-whole-thing-part-04.md) — source bytes 501434–510430
- [CLI surface (the whole thing) — source part 5 of 11](./cli-surface-the-whole-thing-part-05.md) — source bytes 510430–519422
- [CLI surface (the whole thing) — source part 6 of 11](./cli-surface-the-whole-thing-part-06.md) — source bytes 519422–528410
- [CLI surface (the whole thing) — source part 7 of 11](./cli-surface-the-whole-thing-part-07.md) — source bytes 528410–537406
- [CLI surface (the whole thing) — source part 8 of 11](./cli-surface-the-whole-thing-part-08.md) — source bytes 537406–546394
- [CLI surface (the whole thing) — source part 9 of 11](./cli-surface-the-whole-thing-part-09.md) — source bytes 546394–555387
- [CLI surface (the whole thing) — source part 10 of 11](./cli-surface-the-whole-thing-part-10.md) — source bytes 555387–562543
- [CLI surface (the whole thing) — source part 11 of 11](./cli-surface-the-whole-thing-part-11.md) — source bytes 562543–567002
- [Command mode (`tap compact`, and the deprecated `tap command`) — source part 1 of 3](./command-mode-tap-compact-and-the-deprecated-tap-command-part-01.md) — source bytes 567002–575494
- [Command mode (`tap compact`, and the deprecated `tap command`) — source part 2 of 3](./command-mode-tap-compact-and-the-deprecated-tap-command-part-02.md) — source bytes 575494–582263
- [Command mode (`tap compact`, and the deprecated `tap command`) — source part 3 of 3](./command-mode-tap-compact-and-the-deprecated-tap-command-part-03.md) — source bytes 582263–587619
- [Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 1 of 5](./delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-01.md) — source bytes 587619–596409
- [Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 2 of 5](./delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-02.md) — source bytes 596409–605309
- [Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 3 of 5](./delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-03.md) — source bytes 605309–613546
- [Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 4 of 5](./delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-04.md) — source bytes 613546–618652
- [Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 5 of 5](./delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-05.md) — source bytes 618652–625671
- [Spool — source part 1 of 3](./spool-part-01.md) — source bytes 625671–634636
- [Spool — source part 2 of 3](./spool-part-02.md) — source bytes 634636–643187
- [Spool — source part 3 of 3](./spool-part-03.md) — source bytes 643187–651209
- [Explicit sender withdrawal (tap-owanr)](./sender-withdrawal-tap-owanr.md) — sender-side retraction of delivered mail
- [Crew revival](./crew-revival.md) — reviving a seat beside crews that outlived it, and reclaiming them (tap-9rrat)
- [`tap nudge`: the unstick ladder and fan-out](./nudge.md) — blocker dismissal, staged-sentinel submit, interrupt plus the id-less doorbell, actor recording, outcomes (tap-xe42x)
- [Structured failures and JSON output — source part 1 of 7](./structured-failures-and-json-output-part-01.md) — source bytes 651209–652535
- [Structured failures and JSON output — source part 2 of 7](./structured-failures-and-json-output-part-02.md) — source bytes 652535–661532
- [Structured failures and JSON output — source part 3 of 7](./structured-failures-and-json-output-part-03.md) — source bytes 661532–670533
- [Structured failures and JSON output — source part 4 of 7](./structured-failures-and-json-output-part-04.md) — source bytes 670533–676835
- [Structured failures and JSON output — source part 5 of 7](./structured-failures-and-json-output-part-05.md) — source bytes 676835–677604
- [Structured failures and JSON output — source part 6 of 7](./structured-failures-and-json-output-part-06.md) — source bytes 677604–686586
- [Structured failures and JSON output — source part 7 of 7](./structured-failures-and-json-output-part-07.md) — source bytes 686586–692130
- [Pending input: standard grace, then the clobber pipeline — source part 1 of 2](./pending-input-standard-grace-then-the-clobber-pipeline-part-01.md) — source bytes 711037–719648
- [Pending input: standard grace, then the clobber pipeline — source part 2 of 2](./pending-input-standard-grace-then-the-clobber-pipeline-part-02.md) — source bytes 719648–721780
- [Cross-worktree relay (Unit 2b) — source part 1 of 2](./cross-worktree-relay-unit-2b-part-01.md) — source bytes 721780–730738
- [Cross-worktree relay (Unit 2b) — source part 2 of 2](./cross-worktree-relay-unit-2b-part-02.md) — source bytes 730738–738883
- [Wake tiers (transport, not progress)](./wake-tiers-transport-not-progress.md) — source bytes 738883–739982
- [Per-harness submit + verify table (courier-owned, documented here)](./per-harness-submit-verify-table-courier-owned-documented-here.md) — source bytes 739982–741354
- [Stuck-readiness alarm (tap-bprtg)](./stuck-readiness-alarm.md) — one `DELIVERY STALLED` notice per stuck episode
- [Parked mail after a seat restart (tap-03rfq)](./restart-rebind.md) — re-bind to the new pane, or terminalize with a notice
- [Point-of-use pane authority](./point-of-use-pane-authority.md) — source bytes 741354–741900
- [Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 1 of 3](./delivery-drivers-v0-20-spine-tap-1-0-3-part-01.md) — source bytes 741900–750519
- [Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 2 of 3](./delivery-drivers-v0-20-spine-tap-1-0-3-part-02.md) — source bytes 750519–757405
- [Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 3 of 3](./delivery-drivers-v0-20-spine-tap-1-0-3-part-03.md) — source bytes 757405–764099
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 1 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-01.md) — source bytes 764099–769460
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 2 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-02.md) — source bytes 769460–777878
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 3 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-03.md) — source bytes 777878–785993
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 4 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-04.md) — source bytes 785993–794280
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 5 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-05.md) — source bytes 794280–802954
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 6 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-06.md) — source bytes 802954–810856
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 7 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-07.md) — source bytes 810856–815326
- [Submit-verify helper (native courier `submitVerify`; formerly `lib.sh` `tap_submit_verify`) — source part 8 of 8](./submit-verify-helper-lib-sh-tap-submit-verify-part-08.md) — source bytes 815326–823339
- [Poll malformed-payload contract](./poll-malformed-payload-contract.md) — source bytes 823339–831115
- [Human success receipts](./human-success-receipts.md) — source bytes 831115–832918
- [Recipient pending-age warning](./recipient-pending-age-warning.md) — source bytes 832918–834761
- [Invariant for receivers](./invariant-for-receivers.md) — source bytes 834761–835709
- [Cancellation (tap-pe56: dead obligations to vanished seats) — source part 1 of 2](./cancellation-tap-pe56-dead-obligations-to-vanished-seats-part-01.md) — source bytes 835709–842045
- [Cancellation (tap-pe56: dead obligations to vanished seats) — source part 2 of 2](./cancellation-tap-pe56-dead-obligations-to-vanished-seats-part-02.md) — source bytes 842045–849419
