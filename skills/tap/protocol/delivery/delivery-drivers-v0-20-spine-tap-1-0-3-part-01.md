# Delivery drivers (v0.20 spine; TAP 1.0 §3) — source part 1 of 3

> Updated 2026-09-24 (R4): the Bash driver spine (`tap_driver_deliver` →
> `tapdrv_tmux_deliver`) and the Bash submitter `tap_submit_verify` are gone.
> Every pane delivery — direct send, redelivery, digest, `tap self`, and peer
> `tap compact` — calls the native courier `submitVerify` directly, and nudge
> runs its staged Enter loop. The v0.20 spine prose below is historical record;
> where it names a Bash hop, read the native courier.
> Updated 2026-09-20: only the tmux driver ships. The native AGY/Claude adapters
> are retired; parsed adapter preferences refuse with a tmux repair.
> Python 3.10 without a TOML parser still uses tmux with an advisory, and
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> The generic dispatcher still owns effect, attempt and evidence classification.
> Updated 2026-09-23: the non-tmux plugin loader, its load canary, the
> `drivers/` directory, the typed argument builder, the per-attempt result file
> and the evidence-ceiling cap are removed. The dispatcher calls tmux directly.

<!-- tap-source id=source-0114 start=741900 end=750519 sha256=0f188c9cd4c3663393e69b55a2befb4f8ca72688589e15449cdbe4e90bb42e97 fragment=1/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Delivery drivers (v0.20 spine; TAP 1.0 §3)

**One branch point (historical, superseded 2026-09-24).** Every DIRECT-SEND pane attempt left the Bash courier at exactly one hop — `tap-send.sh`'s call to `tap_driver_deliver` — and nowhere else; redelivery reached the Bash submitter directly. Both are deleted; the native courier's `submitVerify` is now the one submit entry for every pane delivery. Naming a driver in config selects a door that already exists — it does not create one. Only `tmux` is wired, and no plugin loader remains: adding a door would be a new call site in the dispatcher, reviewed as a wiring change. Parsed retired-driver preferences refuse; remove the key or set it to `tmux`. The parserless and emergency-override exceptions below remain in force. tmux forwarded to the Bash submitter verbatim, which is what made the unmodified smoke suite the behavior-identical proof of the original extraction.

**A retry may not carry verified-submission evidence.** tmux's static outcome table never pairs `retry-next-rung` with `left-input-band`, and nothing refines a tier after the table is read. The dispatcher still re-checks the pair and **fails it closed to `stop-ambiguous`/`possible`**, so an edit to the table cannot make an attempt both retryable and observed to land. Retry means "nothing happened, try the next rung"; `left-input-band` means "something was observed to land"; the courier must not act on both. The recorded tier is preserved and the disposition is corrected.

**A parseable driver name is not a selectable one.** Resolution applies two separate gates: the name must be syntactically legal, and it must be in the wired set (`tap_driver_wired_list`). The shipped set is exactly `tmux`. **Widening the wired set is a wiring change, not a config change** — the list is inline in a function, readable from no environment variable, so it cannot be widened at runtime. Any other configured name refuses at resolution, before the message can park; a parked message drains over tmux, so accepting an unwired name would deliver through a door the operator did not select, with no receipt saying so.

**Not routed through the dispatcher (historical):** `compact.ts`'s control injection and the redelivery / digest / nudge call sites called the Bash submitter directly. All of them now call the native courier (R4/R5, 2026-09-24).

### The per-harness preference

`[harness.<family>] driver = "<name>"` in `${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml`, over the six harness families (`claude codex opencode cursor hermes agy`). Semantics:

- **Read at DELIVERY time**, never persisted at launch — flipping a family back to `tmux` takes effect on the next message, not the next relaunch. That is the property that makes it usable as a per-family rollback.
- **An absent key, or no config file at all, is `tmux`.** `tmux` is the universal fallback and every family's shipped default. **A config that EXISTS but cannot be used is a refusal, not a fallback** — an unreadable, insecure, or malformed file returns the loud error, because the operator wrote something and silently ignoring it is the undetectable selection this preference exists to prevent. **One carve-out, and it is a protocol behavior: when the interpreter has no TOML parser at all (Python 3.10, no `tomllib`), an existing config is `tmux` plus an unconditional repeating diagnostic, not a refusal.** Refusing there cannot single out the operator who set a preference — parserless, the courier can only see that a file exists — so it would brick every operator who copied the reference instead. The documented 3.10 floor wins over a refusal that cannot identify its target, and the diagnostic is what keeps it from being silent. (An earlier draft of this line said "no readable config is tmux", which the code has never done: a mode-000 or world-writable config refuses. `TAP_DRIVER_FORCE_TMUX=1` is the emergency path for a file that cannot be used, and it is evaluated before the file is opened.)
- **The config is parsed as TOML, by a TOML parser.** Every spelling the format permits resolves identically — `[harness.claude]`, `[harness."claude"]`, `[harness . claude]`, `harness.claude.driver = "x"`, a dotted key under a bare `[harness]` header — because the resolving is done by `tomllib` rather than by a matcher that has to anticipate them. The courier reads the file through the same secure reader (`readSecureBytes`) the launcher uses and then parses the **whole document**, so a malformed line anywhere is a refusal here exactly as it is there: one file, one policy, two consumers.

  This replaced a hand-rolled reader that lost to valid TOML four times, each round patching the spelling just found. It is recorded because the lesson is not about dotted keys: **a partial parser for a real format will keep being wrong in ways nobody enumerated**, and the failure is always the silent direction — an unrecognized spelling reads as an absent key and selects `tmux` without a word.

- **An unrecognized or unusable value is a LOUD refusal** (courier exit 1, `error_class=driver_unavailable`), never a silent fallback. That covers an **explicitly empty** value (`driver = ""` is an operator who wrote something and meant something — only an *absent key* is the documented default), a non-string value, a NUL byte (which cannot survive shell capture, so the bytes used for dispatch would not be the bytes that were read), an insecure source, and a malformed document. A trailing `#` comment is ordinary TOML and parses. The whole value of the preference is that an operator can tell which door their mail went through; a misconfiguration that quietly works is the failure this rule exists to prevent. The same refusal covers a legal name that is not wired, and it happens before any parking exit.
- **`TAP_DRIVER_FORCE_TMUX=1` is the core-wide emergency deny**, and it is evaluated BEFORE the config is opened. A config too broken to read must not be able to disable the switch you reach for when the config is broken.
- The launcher does not read `driver` — the courier does — but the launcher VALIDATES the `[harness.*]` table, so `driver` is in its allowed-key set. Without that, every seat launch would warn about a key that is doing its job.

### The driver contract

The tmux driver is two lib.sh functions, called by name from the dispatcher:
