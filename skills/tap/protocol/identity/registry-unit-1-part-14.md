# Registry (Unit 1) — source part 14 of 14

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0040 start=258801 end=265170 sha256=76d1114ca35300b850fd147a5ed88d07876f2fb52c803ba32b61ca4ea9dc3223 fragment=14/14 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
The three-line usage primer prints only on a **first** registration or with `--verbose`; a routine reconnect never reprints it. **`--offline`/`--remove` is a removal, not a registration:** it prints only its own `marked <handle> offline (suspended/user_removed)` receipt and emits no success briefing and no primer (text mode); `--json` still emits the object with `action=offline`. The re-entry/take-over capability is preserved — the decision moves to `tap poll` (or inline context when the queue is empty), it does not disappear. `--json` is unchanged: `{receipt, inbox[], seat_history}` (`seat_history` `null` when absent), carrying the full seat-history and inbox data regardless of the text gating.

**Failed seat classification (tap-30knu):** A failed batch classifier's partial
output is a diagnostic on stderr, never classification rows or JSON receipt
bytes. `tap team --json` refuses with a nonzero exit and one existing-format
JSON refusal carrying `error_class=classifier_failed`.
`tap team refresh --json` retains affected seats as `unknown:harness_unobservable`
and emits its normal JSON receipt; failed classification is never deletion authority.

**The two doors no longer fail the same way, and neither may invent a roster.**
The retired Bash door reached the classifier as a child (`tap_bun_call` →
`bun observe.ts --from-env`; both since deleted) and could observe that child
exit nonzero, while the native door calls it in-process and can observe only a
thrown error. There is no longer an injection that reaches both, so nothing in
this contract asserts that the two produce identical bytes under a classifier
failure — only that each refuses. They do agree on the reported code (`tap_bun_call`
reports 1, and so does a throw), but that is agreement, not a shared mechanism.
In practice the native door's failure branch has no input-driven reach at all:
its classifier is a pure function over a payload the verb builds itself, so the
branch is retained as a defensive mapping rather than a reachable state.

**Seat trimming (explicit reconcile — deletes, not suspends):** bare `tap team refresh` consumes the shared exact-session classifier and deletes only rows observed `gone` because their stored session name is positively absent from a readable current-generation tmux snapshot. It preserves recoverable `offline` rows and indeterminate `unknown` rows without mutation. Poll rows are skipped. Pending reservations trim only after grace when their reserved session is also gone. `tap team refresh --hard` composes that default with a separate parked-row rule: a stored `suspended` or `offline` row is deleted only when the exact stored session name is not present in the launcher's authoritative session-name namespace snapshot. This rule applies equally to pane and poll delivery; after a readable snapshot, a row with no stored session name is independently unable to name a live session and trims with `reason=hard_session_missing`. The launcher's one no-server recognizer makes canonical no-server positive empty-namespace evidence; every other failed or malformed snapshot is unobservable and keeps all hard candidates, including rows with no stored session name. A hard deletion receipt names handle, harness, last stored status, and reason. `--dry-run` computes the identical candidates and receipts without mutation. `tap team up` may resurrect a relaunchable suspended row only before that row is hard-trimmed; afterward a launch or `tap in` must establish current membership. Each deletion appends a registry-event line and can warn about stranded unsettled inbound. Rejoining after trim is explicit `tap in` or a fresh launch; no archived session record is consulted.

**Back-compat:** A `{pane}`-only entry (no `pane_id`, `team` block, or `status`) remains diagnosable: `tap doctor` warns about it and `tap register` upgrades it in place on re-registration by adding `pane_id`, but `tap send` fails it closed with `identity_unverified`; it is no longer a valid delivery target.

**A pane-backed row confers identity only with a generation claim (tap-zk1w):** pane ids are unique only within one tmux server lifetime, so a pane-backed row (`delivery` other than `poll`) must carry the `server_epoch` observed in the same tmux record as its `pane_id`. Self-resolution, SessionStart's pane lookup and targetless `tap crew shutdown` owner inference skip a row whose stamp is absent exactly as they skip one stamped under a prior generation; the caller reads as `unregistered` and the remedy is `tap register`. `tap register`, named or nameless, refuses a pane registration whose generation is unobservable with `generation_unverifiable` (exit 1, action `wait for tmux to answer, then retry`) before enrollment bootstrap, any lock, or any write, rather than writing the row unstamped. The launcher's bind, `tap session repair`, and `tap admin rebuild-registry` refuse the same way; its same-pane sweep never releases an unstamped row or adopts that row's mail. `tap send` treats an unstamped pane-backed sender as not dischargeable (`unregistered_sender`) and refuses an unstamped pane-backed recipient as `identity_mismatch` with action `tap register <to>`; every point-of-effect pane authorization (the courier's locked submission, whose registry reread also requires the row's current stamp to equal the captured one, the delivery authorizer, and the bound-pane identity check that recovery, nudge and spool redelivery use, which answers `server_epoch_missing`) refuses a bound pane with no generation. Pane-less `delivery: "poll"` seats carry no stamp and are unaffected: they never pane-match, and they send with `--from <handle> --team <team>`. Status classification (`tap team`, health) still reports an unstamped pane row by pane agreement; that is observation, not identity.

**tap register flags:**

- `--mode subscription|api` — cost posture for the session (default: `subscription`)
- `--include always|on_request` — when to include this peer as a review audience (default: `always` for subscription, `on_request` for api)
- `--offline` / `--remove` — suspend an existing entry with `status_reason: user_removed` (no tmux needed)
- `--override-worktree` — allow registering a pane whose `pane_current_path` is outside the caller's current git worktree root. A launcher-placed seat in a worktree of the team's repository needs no override (see the identity README's launch evidence section)
- `--force` — reclaim the exact handle from a different live pane instead of auto-suffixing, and bypass a pending reservation when the operator intentionally rebinds it
- `--delivery poll` — register a pane-less poll-mode member (§Poll-mode delivery class). Requires an explicit handle (nothing to derive from) and an explicit team anchor: `--team <name>`, resolved to the team's bus via the marker-selected machine index (`~/.tap/global-registry.json` after the flip) — a daemon's cwd is never a bus anchor (the launchd-cwd-lands-on-the-wrong-bus failure). A poll registration from inside the team worktree may omit `--team`. `--wake-url <loopback-url>` optionally records the wake hint.
- `--accept-observed-identity` — WITHDRAW a standing launcher identity expectation for this seat and accept the id the pane actually reports (tap-zqcd). Scoped to the launcher's question alone: every other quarantine reason still fires, because ownership of a native id by another seat is not something an operator statement can change. Requires an observed id and a mismatching standing expectation; otherwise it says on stderr that it changed nothing and why. Records `identity_capture_result.retired_expectation` and `mode: operator_accepted`, so a later reader can tell an attested identity from one a human waved through.
- `--unattended` — mark the seat as no-reply automation. Sends from this handle auto-stamp `reply=settle-only`, UNLESS a validated deliverable `reply_to` owns the response channel and the send passes `--expect-reply` (tap-ywb v0.5, panel MUST-FIX 4 — see §Reply routing); inbound replies to this handle are refused by default. `--reply-to <handle|team/handle>` (optionally paired with `--unattended`, but not restricted to it) stores an address this seat's future plain sends auto-stamp `reply_to` from.

