# Debug capture sources and fidelity

All diagnostic settings live in the machine config's `[debug]` block:

```toml
[debug]
always_on = false
capture = ["tmux", "tap-events"]
fidelity = "best-effort"
max_mb = 1024
retain_mb = 2048
archive_mb = 10240
```

These are defaults. `capture` is a set of sources; `fidelity` is how aggressively
TAP events are collected. Unknown sources, unsupported fidelity values, malformed
TOML and invalid caps produce a typed `debug_config_invalid` error. The shared
reader prints nothing and changes no state. Trace is manual, never a config value.

`tap debug config --capture tmux,tap-events --fidelity precise` updates the block.
Either source alone, or `--capture none`, is valid. Removing `tmux` stops its
owned automatic sampler immediately; other capture/fidelity changes apply to
the next capture. `--max-mb` and `--retain-mb` retain their existing bounds.
The first block written by `tap debug config`, `on` or `trace` imports the old
`debug/config.json` storage caps; after that, TOML is authoritative and the old
file is inert. Edits preserve unrelated TOML and comments under the config lock.

`on`/`off` controls both owned sources. A legacy tmux scheduler remains
`unmanaged` until the operator runs `tap debug tmux-migrate`; installation and
ordinary debug controls never adopt it. With `always_on = true`, the next public command that finds no live
tap-events recorder starts `tap debug on` in the background, at most once a
minute, and only when `capture` includes `tap-events`; `tap debug off` clears
it. `archive_mb` caps the [archive](#archive).

## Independent tmux source

`tap debug tmux-migrate` adopts the existing `local.tmux-flight` LaunchAgent
or prepares a new one. New installations remain disabled unless `always_on`
is set and `capture` includes `tmux`. Migration preserves existing enabled or
disabled intent, supported environment overrides, log destinations and sample
interval. Unsupported overrides refuse before changing the registration.
Explicit `[advanced]` values override an inherited timing setting. Later `on`
reconciles that validated snapshot; ordinary commands never call launchctl.

The LaunchAgent calls `scripts/tap-debug-tmux-tick.sh` directly through an
absolute Bash 5 executable. Failure-domain independence from Bun is the reason
for shell here: the tick reads no TAP config, runtime, bus or control lock. One
bounded tmux command chain and one awk pass collect server, pane and client
counts; one jq call escapes the observation. A recorder-local claim excludes
overlapping invocations. Child stdout is file-backed, with TERM then KILL at
the deadline; a hung server cannot retain a caller's output pipe. Capture
never restarts or kills the server.

Defaults under the shared `[advanced]` descriptor:

| Key | Default | Accepted values |
| --- | ---: | --- |
| `debug_tmux_sample_seconds` | 5 | Integer 1–3600 |
| `debug_tmux_inventory_seconds` | 60 | Integer 1–86400, at least the sample interval |
| `debug_tmux_timeout_seconds` | 3 | Finite number 0.1–30 |
| `debug_tmux_incident_gap_seconds` | 600 | Integer 0–86400; zero disables cooldown |

Slow inventory is null on fast ticks and carries its own last-sample timestamp.
Hang, alive-to-gone and loss of at least half of six or more panes trigger an
incident before inventory or maintenance. Unknown probe failures remain unknown.
Incident process inspection requires a live socket answer or a previous PID
still holding the exact socket; unresolved identity is explicit.

History stays in `~/Library/Logs/tmux-flight/`. An atomic, versioned scalar
`.state` holds the latest observation and timestamps. Missing or torn state
recovers the newest valid matching record from today's or yesterday's JSONL,
including legacy records; incomplete JSONL lines are ignored. Status reads
this source independently and reports stale samples without certifying the
TAP event collector. The live-log cap runs every tick (2 GiB with a 256 MiB
saved tail by default). Compression and retention run hourly. Daily samples,
server logs and saved tails stay 14 days. TAP-marked incident bundles stay
30 days within 512 MiB, always retaining at least the newest five. Unmarked
pre-migration incidents are never pruned. Status reports any budget overage
protected by that floor and when retention was last sampled.

Migration validates a private incident capture, backs up the plist and legacy
entry, stops the old label, and observes its invocation exit before swapping
files under recorder exclusion. It verifies a first durable sample; failure
restores the old files and registration, or reports an incomplete rollback.
Owned plist and forwarding entries are hashed in the install manifest.
`install.sh --sync` never migrates an existing label. The explicit migration
verb is the only adoption path. `off` and removing the source stop automatic
sampling; router-free `incident`, `start-server`, `ensure` and `print-hook`
remain available. Server birth uses `-vv`, a stable log directory, a keepalive
session and `exit-empty off`; answering, wedged or unobservable servers are
never replaced to enable logging.

## TAP event fidelity

- `best-effort` (default): collect active payload sidecars every five seconds.
  A sidecar is active while its `<id>.md` exists without a `.done` or `.cancelled`
  receipt. Both `<id>.attempts` and `<id>.debug.attempts` belong to that payload.
  Settlement or removal starts a drain: read on that observation and for two
  more ticks, then forget the cursor. Later writes and new orphan sidecars are
  omitted. There is no cold sweep; adding one would require retained cursors to
  avoid replaying history. Bus files remain available for post-mortems.
- `precise`: visit every sidecar every five seconds, including settled/archived
  payloads. Keep cursors and replay rewritten or truncated sources in full,
  with `capture.gap` reason `source_rotated_or_truncated`. Replays can duplicate
  earlier records.
- `tap debug trace <seconds>`: sample active, draining and recent sidecars every
  half-second plus raw tmux logging. One entry inventory admits sidecars modified
  in the preceding five seconds; later directory changes check only new paths
  against that cutoff. Admitted paths stay selected for the window. Older cold
  files appended in place afterward are omitted. Previously unwatched files are
  baselined on entry; rewrites replay in full. Return to the configured fidelity
  afterward, including exhaustive reads for `precise`. If `tap-events` is not
  selected, trace captures raw tmux only and its temporary collector stops at the
  deadline.

Best effort keeps the last 200 complete registry-log lines as an overlap anchor.
After replacement or truncation, emit only the tail after the longest
unambiguous old-suffix/new-prefix match. In a larger configured log window, the
complete retained anchor can match inside the new file. Multiple possible anchors or an
indistinguishable repeated window emit one `capture.gap` with reason
`bounded_log_rewritten_ambiguous`; no overlap emits
`bounded_log_rewritten_no_overlap`. Those gaps skip the rewritten window and
resume at its end. There is no multiplicity guarantee and no writer change.

`status.json` retains `pid`, `heartbeat`, `mode` (`basic`, `trace`, `off`) and the
manual `trace` state. `fidelity` names the configured event policy. `sources`
reports `tap-events` and `tmux`, each with `state`, `last_sample_at`, `alive` and
`incident_count`; unavailable observations are null. Status refreshes every five
seconds outside traces and every half-second during a trace. Startup baselines
selected streams; partial lines wait for completion. All capture is diagnostic:
a source removed or rewritten between observations can lose evidence. The
collector never removes source sidecars or receipts, and journal entries do not
prove recipient processing.

## Archive

Rotation (`max_mb`) and retention (`retain_mb`) compress history into
`debug/archive/<capture-id>/` instead of deleting it; neither budget counts the
archive. Every archived file is zstd, one frame per 8 MiB of input, streamed to a
staging name, fsynced and linked into place under a name that replaces nothing (a
taken name gets `.<n>` before `.zst`); its directory, and the parent of each
directory the write created, are fsynced before the source is deleted. Segment numbers continue past archived ones. Between frames the
recorder refreshes its heartbeat about every two seconds and abandons the file,
keeping the source, when the capture is stopping. Rotation writes closed segments as
`events.NNNNNN.jsonl.zst` and artifact copies as `artifacts/<name>.zst`; a bundle
keeps its tree with one `.zst` per file. Retention writes the pruned capture's
journal and metadata, then its artifact copies and published `trace-<id>/` files
in the same layout. Raw tmux logs under `debug/.raw/` are never archived, and a
capture recorded before the sanitizer archives only its journal and metadata.

Past `archive_mb`, whole capture archives are removed oldest first by capture id,
never the newest or the recording capture's own; the recorder journals each
removal as `capture.archive_pruned`. The cap runs after every archive attempt,
including a failed one, and does not consult recovery post-mortems. If any
archive step fails, including an fsync or link, rotation and retention still
delete to stay within budget: rotation journals `capture.archive_failed`, and
retention prints the reason and reports `archive_error`. The source is deleted
before the failure is reported; a failed journal write falls back to stderr
(`recorder.log`) and never stops rotation, retention or the cap. Status reports
`archive_bytes` beside `config.archive_mb`.
