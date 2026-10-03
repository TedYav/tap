# Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 3 of 3

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Registration
> temporarily retains the AGY start-token helper and `agy_ls` descriptor until
> its native cutover. The source below is historical, not an activation guide.

<!-- tap-source id=source-0144 start=917878 end=919665 sha256=bae7b55efd2a400d5375dfdc511be82276c91f4ae4f330a9e54d7cef150cf8e2 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
The operation holds the existing obligation lock, a non-stealing spool claim,
and the metadata lock while checking evidence and withdrawing the old spool.
It archives the original and exclusively records `.resent` with the successor id
before invoking ordinary send once. A crash or failed successor send never reopens
the original: inspect `.resent` and its retained prepared payload rather than
repeating the old id. The cancellation receipt withdraws the old obligation; it
does not claim recipient processing. Delivery policy uses ordinary send defaults.

Every public `resend` form uses the native eligibility, preparation and withdrawal
owner, including `--team` and implicit actors. The Bash
bootstrap and Python owner are deleted. No public option selects preparation alone.

Argument, context and actor validation precede reset mutation custody, then the
obligation lock, non-stealing claim and metadata lock. Reset custody spans
preparation; the metadata lock retains its unbounded wait. Immediately after
durable `.resent` publication, resend marks the reset generation reused. A marking
failure retains the consumed and partial artifacts and prevents successor
invocation. A prepared-only artifact remains in `archive`, whose reset fate is
`preserve`; it does not mark successful consumption.

The parent releases reset custody before invoking ordinary send, which takes its
own reset custody. The original obligation lock remains held through that one
attempt and its output. Reset may intervene in this handoff and the child may
refuse; the consumed original stays consumed. This does not make preparation and
delivery one atomic transaction or guarantee redelivery. All doors now give reset
custody/fence refusal precedence over obligation-busy and guarded eligibility,
replacing the former native lock-first and Bash precondition-first split.

Every prepared argv runs native send, including team-qualified targets, `--note`,
`--reply-to` and `--in-reply-to` originals. Only pre-effect send
delegation invokes the prepared Bash send, exactly once. Such
delegation never restarts the consumed resend. Other successor failures are reported
without retry. The successor retains its existing send delegation rules.

Guard refusals retain their `status: refused` JSON on stdout even without `--json`.
Receipt, output and body bytes are preserved. Native parser and OS exception tails
may differ for malformed/unreadable evidence and incidental filesystem failures;
error class, stream, exit, fixed prefix and evidence filename stay unchanged. The
authored non-object diagnostic remains `expected an object`. JSON byte encodings,
BOM handling and numeric eligibility retain their existing meaning.
Missing or empty `--by`/`--team` operands retain exit 1 and stderr-only output,
even after `--json`; their diagnostic now starts with `tap resend: ` instead of
the deleted Bash script's path and line number.

| Verb | Runtime boundary |
| --- | --- |
| `resend` | Native preparation and guard on every public form; one existing successor send. |
| `withdraw` | Native on every form; the verb has no Bash door. |
| `nudge` | Native (`cmdNudge`); the recorded submit boundary runs the courier's `submitStagedLocked` in-process, each Enter through the recovery effect owner. |
