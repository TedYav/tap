# Poll-mode delivery class (v0.4) — source part 2 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0051 start=330398 end=332205 sha256=a0b38834c02c46ce9986402ed4c2fd8d2b56e3f1ceabaa6437019924e491c1f1 fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Wake hint (optional, strictly best-effort).** If the member's registry entry carries `wake_url`, the courier — after the durable write, after the exit code is already decided — fires one POST at it: body `{"id":"<id>","path":"<canonical-payload-path>"}` (a **pointer**, never payload content), HMAC-SHA256 of the exact raw body with header `X-Hub-Signature-256: sha256=<hex>` (the installed hermes GitHub scheme), secret read from `~/.tap/wake/<team>-<handle>.secret` (mode 0600). **Any wake failure — no secret file, connection refused, timeout, non-2xx — is swallowed and at most logged to stderr as a warning; it can never change the send's exit code or un-deliver the write.** A missed wake degrades to the member's next poll, never to a lost message. One wake may cover many payloads: the woken consumer polls the whole queue.

**Liveness: unknown by design.** Poll members have no pane to observe. `tap health` reports them as `poll-mode (liveness unknown)` — never `wedged`/`stopped`; the watch layer's escalation chain **skips** `delivery: poll` seats (they cannot be probed by injection); `tap nudge <poll-member>` is a structured refusal (`error_class=poll_mode_member`), not a silent no-op. `tap whoami` cannot resolve a poll member (no `pane_id`); poll members always pass explicit `--from`/`--by` — their registration IS their identity claim, consistent with the trust model (§Trust model): the bus is not a security boundary.

**Settlement is unchanged.** Poll members settle with `tap read`/`tap reply` like any member; `outstanding`/`poll` semantics are identical. The supervision kinds' reserved-sender rule (§Supervision kinds) is untouched: the `watcher` identity remains reserved and settle-only — a poll member is a *registered* first-class member, not a supervisor.

