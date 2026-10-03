# Appendix: the `ccnative` native driver (tap-lcdm — EXPERIMENTAL, default-off) — source part 2 of 2

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Registration
> temporarily retains the AGY start-token helper and `agy_ls` descriptor until
> its native cutover. The source below is historical, not an activation guide.

<!-- tap-source id=source-0141 start=898317 end=900325 sha256=66f97fd68c705cdae060eca4f76ff216599378e15b8158f9f3bf86dda23108ea fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Refusals are typed, from a closed enum** — `pane_drift`, `no_json`,
`config_root_unprovable`, `ambiguous_rows`, `pid_mismatch`, `peerpid_mismatch`,
`session_id_split`, `sdk_cli`, `no_socket`, `peer_protocol_unsupported`,
`version_unallowlisted`, `version_fingerprint_mismatch`,
`version_entry_unmeasured`, `start_time_mismatch`, `tap_ownership_drift`,
`tap_delivery_mode_changed`, `tap_registry_unreadable`, `class_unsupported`,
`connect_failed`, `write_failed`, `usage`. A default-off driver whose log says only "native failed" cannot tell an
operator whether the experimental path was skipped or missed on identity, which is
most of the reason to ship it default-off at all. The driver contains no fallback
path: choosing the next rung is the router's job, and a driver that falls back is
a second router.

**Urgent is refused (`class_unsupported`), not downgraded.** The door's `now`
priority jumps the receiver's queue but does not interrupt a running turn, so
`ccnative` claims no interrupt class; accepting a steer and sending it as a normal
message would be the silent urgent-as-normal reinterpretation the design forbids.

A `steer` the selected driver refuses as an unservable CLASS does not park. The router falls
through to the tmux floor in the SAME send — the refusal is pre-effect by construction, so nothing
crossed — takes the floor's own outcome from tmux's table, and records the floor as a second
attempt with detail `class_unsupported_fallthrough`, so the log shows both rungs. It takes
submit-unverified semantics (exit 5) rather than a retry whenever the floor's effect is not `none`.

Outcome table (`tapdrv_ccnative_outcome`): rc 0 → `stop-ambiguous/possible/
api-accepted`; rc 10, 11, 12, 13, 14 → `retry-next-rung/none/none`; rc 15 (write
failed after a clean bind, so bytes may have crossed) → `stop-ambiguous/possible/
none`. rc 13 and rc 15 are split deliberately: a failed connect wrote nothing and
is safely retryable, a failed write may already have delivered.

