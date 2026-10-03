# Goalie layer (`tap goalie` — belief-state sidecar) — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0069 start=438538 end=443738 sha256=9277771eadb7c37fccaddc05e74795d54fa48b727da820f3d9ff4149dc0f989b fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
On deadlock the sidecar sends ONE wake to the **feeder** — `--feeder` at arm time, defaulting to the
armer — carrying `OBJECTIVE`, `DEADLOCK · STALE <n>/<aged> (<pct>%) idle >=<M>m · READY <n>`, an `UNAGED <n>/<total> excluded from
the quorum: <handles>` line whenever any seat is unaged, `NEXT <id> <priority> <title>`,
`OWNER <handle|<vacant>>`, and a `TRIGGER OVERDUE:` line only when a declared trigger is actually
overdue. Unlike `kind=probe`/`kind=notice`, **this wake creates a reply obligation**: it is
`kind=discuss` sent `--from goalie` with `reply=expected`, because the feeder owes an answer, not a
settle. It is NOT sent from the pane-less `watcher` identity — an unregistered sender may send only
`--fyi`, which forces `reply=settle-only`, so a wake sent that way would be an FYI nobody owes an
answer to. The sidecar READS THE MINTED PAYLOAD BACK and requires `reply: expected` on the artifact;
anything else counts as "no obligation was minted" and escalates, so a `--fyi` added later or an
`unattended` registry field cannot silently downgrade the obligation.

**Observe the delivery seat before relying on it.** Before judge requests, pruning or wake
transitions, the tick reads the named goalie's state. The seat must be active, pane-backed,
and successfully observed as ready or in-turn. An idle seat with nothing owed is healthy;
registration or changing pane activity alone cannot establish health while work is overdue.

A reply-required local payload or current judge request becomes overdue at the configured
`TAP_GOALIE_STALE_SECONDS` window. If overdue work has neither recent self-authored session
progress nor a recent reply from the current seat, the tick emits `degraded-delivery` with
its reason. Incoming messages and supervisor-authored feeder wakes do not count as progress. Only envelope
headers are text; bodies stay opaque. Reply progress must match the current sender instance.
Canonical done/cancel/archive settlement retires payload duties. An unreadable observation
also degrades delivery; lazily absent inbox directories are empty, not read failures.

A degraded tick preserves wake ID, rung, exception and pending judge records, logs its result
and stamps its heartbeat, then returns without new delivery effects. Recovery requires a new
successful observation; an overdue duty still requires fresh progress or a reply.

**Ladder, and ACK means the reply landed.** Rung 1 is the wake. If no payload citing it by
`in_reply_to` has arrived by the next fire, rung 2 sends a fixed `watcher` notice with the price
attached and the original wake ID. The notice is settle-only and directs the feeder to answer
that original wake; it creates no second reply obligation. Still unanswered,
rung 3 wakes the human via `tap escalate`. A wake that cannot be delivered, or a `<vacant>` feeder role,
skips to rung 3 immediately — a delivery that cannot carry the obligation escalates and never degrades
into a silence the sidecar reads as "I warned him". A `pending`/`submit_unverified` result is NOT a
failure: the payload and its obligation exist, only arrival is unproven, so it is carried as a real
obligation that escalates if unanswered.

**Reply evidence is a snapshot, not a mutable path.** The reader opens spool before canonical
payloads, following the one-way publication move, and parses those same bytes. A reply receipt
must carry `reply_id` and `reply_sha256`; its digest must match the body bytes, excluding the envelope, as stamped by `tap reply`. Missing, unreadable
or mismatched evidence emits `answered-unreadable` and preserves the wake and exception state.
Before a receipt arrives, a payload's `in_reply_to` can identify the reply; that scan also keeps
the bytes it read. No failed read silently becomes a plain answer.

**Declines are checked mechanically, never for wisdom.** An acceptable decline is `EXCEPTION (a|b|c)`
plus `VALID-UNTIL <ISO-8601>` in the reply — any spelling `datetime.fromisoformat` accepts
(`2026-08-19T13:00:00Z`, `2026-08-19T13:00:00-07:00`, `2026-08-19`), and **a naive stamp with no offset
is read as UTC** rather than guessed at. It must be a TIME: a named event cannot expire mechanically and
would be a permanent mute. For tag `(a)` every enumerated ticket row must name what it waits on
(`<id> → <decision>`; `->` is accepted); an ungated row malforms the exception. A malformed decline is
refused **with its reason**, carried on the next wake as `YOUR LAST EXCEPTION WAS NOT ACCEPTED: …` — a
silent refusal would make the feeder's remedy do nothing without saying so. Expiry without renewal
re-arms deadlock on the next fire.

**Output on every fire, and the stamp follows the line.** Each tick appends one line to
`$TAP_HOME/goalie/tick.log` (`working=`, `ready=`, `verdict=` ∈ `quiet|unreadable-for-cause|deadlock|rung2|rung3|
rung3-standing|held|answered|answered-unreadable|answered-exception|answered-malformed|lease-unresolved|degraded-delivery`), then writes `$TAP_HOME/goalie/heartbeat`. A silent
all-clear is indistinguishable from a dead detector, so a healthy fire still logs — while pushing
NOTHING to any seat, keeping reader cost at zero. **Order is load-bearing:** the run loop no longer
stamps before the tick, and a fire that cannot append its line does not stamp; otherwise a hung tick
refreshes its own proof of life. That stamp is `heartbeat_at` and the heartbeat file, not process
identity. `tap goalie run` — native since R6 U3 (`runtime/bun/src/goalie-run.ts`, reached through the native verb, which stamps the loop's source closure before loading it and re-execs with the lease carried on a source change) — publishes `watcher_pid` as its process id once at loop entry so `on`'s lease/takeover
and `_goalie_stop_owned` can act on a direct no-spawn loop; a hung first tick must not look like an
absent sidecar. Spawn still records `#{pane_pid}` from `on`.
`runtime/bun/src/watchers/goalie-heartbeat.ts` ages the heartbeat file from cron or a LaunchAgent
and notifies the human directly. It reads `goalie/arm.json` and `goalie/heartbeat` and reads/writes
`goalie/heartbeat-alarm.json`, its atomic publication temporary files and
`goalie/heartbeat-alarm.json.lock`. The watchdog needs read/write access to the goalie
directory, but no TAP context, transport, registry, tmux, lease machinery or model. The standalone reader requires
Bun and cannot diagnose a missing or broken Bun interpreter; there is no shell fallback.
Installation and reload remain the operator's actions. The first stale observation attempts one
notification; continued staleness permits one reminder per hour. A completed healthy tick
clears `goalie/heartbeat-alarm.json`; a new arm generation also starts a new alarm edge. `tap goalie on` mints an
`alarm_generation` nonce whenever it creates or replaces an arm, including same-second
rearms. Idempotent `on` keeps the nonce. Already-running arms without a nonce remain one
unversioned alarm episode until rearmed.
The record stores the attempt time and an unconfirmed status before invoking the notifier,
so a crash, failure or timeout cannot cause an immediate retry. A confirmed attempt returns
1; an unconfirmed/failed attempt returns 2. Suppressed invocations retain that status and
report the remaining reminder interval. The notifier keeps its fixed 20-second hard deadline.

A nonblocking kernel lock beside the alarm record serializes scheduler invocations without
using the detector or transport. Busy, unreadable or unwritable alarm state returns 2 and
attempts no notification; a backwards clock likewise preserves the record. This leaf lock
is released by the kernel on process exit. There is no automatic notification retry and no test
notification. An armed invocation first resolves the notifier without sending anything; when none
is usable (missing executable, invalid config, unsupported platform) it writes
`notifier-unavailable: <detail>; alarms cannot reach the human` to stderr, even under `--quiet`,
and returns 2 before taking the lock, touching alarm state or checking staleness. Disarmed returns
0 first, even with a broken notifier. The checked-in LaunchAgent plist pins `HOME` (beside `PATH` and `TAP_HOME`) so the notifier config resolves; without `HOME` or `XDG_CONFIG_HOME` every armed tick would refuse.

Heartbeat times use checked decimal integer seconds; leading zeros are decimal. Malformed or
unsafe stamp content and unsafe age subtraction alarm. Invalid/unsafe explicit clock or max-age
overrides return 64 without notifying; a disarmed goalie still returns 0 first. Signed max-age
values remain valid. Interval conversion retains Python's boolean, numeric truncation, string and
default behavior; an unsafe converted interval or multiplication by three falls back to 60.
This intentionally replaces Bash's octal/expression evaluation and integer wrapping, which could
turn a huge malformed stamp into a healthy result.

`OBJECTIVE` and `TRIGGER OVERDUE` come from DECLARED lines in the `--ledger` file only —
`OBJECTIVE: <text>` and `TRIGGER: <text> | due <ISO-8601>` (same acceptance and same naive-means-UTC
rule as `VALID-UNTIL`). Freeform prose is not detector input, because
a parser guessing at narrative renders a confident wrong objective. The failure direction is the design
test: guessing fails toward confident-wrong, declared forms fail toward visibly-empty. So `OBJECTIVE`
has five distinct renderings — declared text, `<declared empty>`, `<undeclared; …prose…invisible here>`,
`<no ledger configured>`, and `<ledger configured but unreadable>` — and none of them says "none". Each
states only what was OBSERVED: `<undeclared>` means no declared line was found, so whether an objective
exists at all is unknown; `<declared empty>` means the line exists and its value is blank. Collapsing
them would move confident-wrong from the parser into the renderer.

**Escalation composition.** Mechanical watch → local goalie → lead → configured machine hermes/phone. An obvious goalie verdict wakes exactly one stopped teammate. `unsure` wakes only the armed lead. A judge-request delivery failure also wakes the lead with a fixed notice; if that cannot land, the sidecar best-effort calls `tap escalate`. The ordinary watch chain remains the final timeout/backstop and its sticky NOTIFY/machine escalation semantics are unchanged.

