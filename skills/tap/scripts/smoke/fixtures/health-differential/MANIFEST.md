# health-differential fixtures

Recorded output of `tap health`, one pair of files per case and route:
`<case>.text` / `<case>.json` hold normalized stdout, `<case>.<route>.rc` the raw
exit. Text usage and registry-invalid also record `<case>.text.err` (normalized
stderr): those routes print an empty stdout on purpose, so comparing stdout
alone cannot see a diagnostic change. deleted-cwd stderr is asserted non-empty
in the test and is NOT recorded here (Bun and Bash word it differently).
Consumed by `smoke/health-differential.test.sh`, which also owns the
recorder: `TAP_HEALTH_DIFF_RECORD=1 bash scripts/smoke-all.sh --only skills/tap/scripts/smoke/health-differential.test.sh`.
A bare `bash` of the test file is standalone: the test allocates a private
`TMUX_TMPDIR` so `new-session` cannot reach the operator default server.
Fixtures are captured, never edited by hand.

## Provenance

- Recorded 2026-09-01 for tap-ip5ko (native health cutover verifier, built ahead
  of the port) against the Bash runtime: `skills/tap/scripts/tap-health.sh` blob
  `b4b6b5fafebda5086cdcded2ba47a1d36a768d10`, `lib.sh` blob
  `d3798774543c5a12cccdfcc33059e821484a0598` (tree of `84b51c7d`).
- Entry: `bin/tap` with Bun on PATH, so every call went router → `bash health`
  (the route trace printed `32 bash health` for the `run_case` calls). The port
  flips that route; the fixtures do not change unless behavior does.
- Environment at capture: `TAP_WATCH_NOW=1788220890` (2026-09-01T00:01:30Z),
  `COLUMNS=400 TERM=dumb NO_COLOR=1 TZ=UTC LANG=C`; `HOME`, `TAP_INDEX_HOME`, the
  session manifest, opencode db, version-seen stamp, and `XDG_CONFIG_HOME` all relocated
  UNDER the hashed sandbox (so the zero-write instrument covers them); `TMUX_TMPDIR` sandboxed by the caller; live panes on the default server of that sandboxed
  tmux root showing the repo's pinned claude corpora
  (the pinned generating claude capture in `census-false-idle-20260819/`,
  `pane-state/claude/idle-current.txt` idle).

## Normalization tokens

| token    | replaces                                                        |
|----------|-----------------------------------------------------------------|
| `<WORK>` | the sandbox root (realpath form; the test resolves it with `pwd -P`) |
| `<S>`    | the per-run tmux session prefix `hd<pid>`                       |
| `<PID>`  | the live watcher pid in `watch-alive-paused` (both renderings)  |

Two environment pins are also part of determinism for the real-shape team C:
`TAP_SERVER_EPOCH` and `TAP_BOOT_ID` are set to the values the shape's own seats
carry (read from `source-shapes/team-registry.json` at run time), so lib.sh's
server-restart invalidation sees a team whose server never restarted. Only the
`real-shape-server-restart` case removes them.

Nothing else is normalized. Parser messages that health copies into a field
(`watch.error`, the sticky-notify `reason` for an unreadable notify file) are
pinned verbatim as Python's `json` wording; a runtime that words them
differently has changed a user-visible field and re-records under that ruling.
`registry-invalid.text.err` likewise pins the parser's own first line (CPython
`json.JSONDecodeError` for `{oops`) plus the `tap_fail` diagnostic.

## Cases

| case                        | cwd | what it pins                                                        | rc text/json |
|-----------------------------|-----|---------------------------------------------------------------------|--------------|
| census                      | A   | every seat class at once: generating→`working`, idle→`idle-at-prompt`, pane gone→`unknown`, suspended→`unknown`, poll→`poll-mode (liveness unknown)`; unsettled cross-team task, settled notice + probe in supervision, dead-watcher arm, unacked sticky notify, 10-line events tail | 2/2 |
| busless                     | N   | a repo with no `.tap`: `rule: default`, no registry, disarmed, stays bus-less | 0/0 |
| ambient-home                | N   | `TAP_HOME` (rule `env`) selects team B's bus from a non-team cwd     | 0/0 |
| wrong-home                  | A   | `TAP_HOME` outranks the cwd's own team                              | 0/0 |
| ambient-registry-outside    | N   | `TAP_REGISTRY` is not a selector: ignored outside a team            | 0/0 |
| ambient-registry-inside     | A   | inside a team the acting-registry rebind replaces ambient `TAP_REGISTRY` (tap-n85k's passing arm) | 2/2 |
| marker-good-both-files      | C   | live marker, team with BOTH `.tap/team-registry.json` and pre-flip `.tap/bus/registry.json` (real shapes, see `source-shapes/README.md`): roster comes from the acting file | see `.rc` |
| marker-invalid              | A   | flip marker `{"schema":"9.99"}`, acting-file-only team              | 2/2 |
| marker-invalid-both-files   | C   | same marker, both-files team: the rebind fails and the ambient bus registry reaches the renderer (tap-n85k's failing arm) | see `.rc` |
| marker-unreadable           | A   | flip marker that is not JSON, acting-file-only team                 | 2/2 |
| marker-unreadable-both-files| C   | same marker, both-files team — **KNOWN-DEFECT, see below**          | see `.rc` |
| real-shape-server-restart   | C   | epoch/boot pins removed: health WRITES (registry rewritten, events appended) — **KNOWN-DEFECT**, asserted directly, no fixture (the appended lines carry a clock) | asserted, not recorded |
| registry-invalid            | A   | acting registry not JSON: `registry_invalid` / `repair_registry`; text-route stderr pinned in `.text.err` | 1/1 |
| watch-alive-paused          | A   | armed, pid alive with matching command, paused fields rendered      | 2/2 |
| watch-alive-wrong-command   | A   | same live pid, `watcher_command` not in its command line: `command in out` reads it dead → `armed-but-watcher-dead` | 2/2 |
| watch-alive-empty-command   | A   | same live pid, empty `watcher_command`: pid existence alone reads alive (the reused-pid exposure, pinned as current truth) | 2/2 |
| watch-unreadable            | A   | arm record present but not JSON: `watch-state-unreadable`, distinct from watcher-dead | 2/2 |
| notify-unreadable           | A   | notify record not JSON: sticky-notify carrying the parse error      | 2/2 |
| tmux-failing                | A   | a `tmux` on PATH that fails every call with stderr noise: pane seats degrade to `unknown`, JSON line stays clean | 2/2 |
| tmux-noisy-stdout           | A   | a `tmux` on PATH that succeeds but prints to stdout: junk stays inside classifier captures, JSON line stays one line (regression pin; the causal JSON-CLEAN proof is the classifier-site leak mutant in the driver report) | 2/2 |
| tmux-unreachable            | A   | `TMUX_TMPDIR` with no server: same degradation, and no server is started | 2/2 |
| deleted-cwd                 | A/sub (removed) | stdout empty, exit 1; stderr is the runtime's own message and is NOT pinned (Bun and Bash word it differently) | 1/1 |
| usage-bogus                 | A   | `--bogus`: `unknown_option`, `tap help health`; text-route stderr pinned in `.text.err` | 1/1 |
| usage-extra                 | A   | stray positional: `usage_error`; text-route stderr pinned in `.text.err` | 1/1 |

## Known defects this corpus exposes (rulings, not fixture decisions)

- **`tap health` writes on a server-epoch mismatch (T3 violated) — bead tap-uxac (tap-zekgc was filed first and folded into it).** On the real
  shape with the epoch/boot pins removed, the first health call rewrites the acting
  registry — every seat `suspended`, pane cleared — and appends
  `actor=dispatcher action=server_restarted … detail=cleared_stale_pane_binding`
  lines with wall-clock timestamps to `registry-events.log`. The write is lib.sh's
  server-restart reconciliation, run by the DISPATCHER (tap.sh) for every verb not on
  its `admin|init|setup|register|in` skip list, before the health body; not anything in
  `tap-health.sh`, which is why hand-written seats (no `server_epoch`) never showed
  it. Pinned by the `real-shape-server-restart` arm with inverted polarity. The
  cutover must decide on the record whether native health keeps that side effect or
  becomes read-only; either way the arm and its bead retire together.
- **Unreadable marker on a both-files team hides the roster silently.** With the
  pre-flip `.tap/bus/registry.json` present, the failed rebind leaves the ambient bus
  path in `registry_path`, whose ONLY consumer is `registry_present = os.path.exists(...)`.
  That boolean flips true, which suppresses the `no registry (run: tap register)` line —
  so the human route prints neither a registry section nor a roster, `status` is
  `healthy`, exit 0, and eleven real seats vanish (compare `marker-good-both-files`:
  same bytes, marker readable, eleven seats). Health never renders decoy CONTENT (the
  decoy's seat names appear in no fixture); the damage is the one boolean. This is
  tap-n85k's failing arm observed live, which makes that bead's "not observable
  today" stale (comment added to tap-n85k 2026-09-01). Passing the resolved registry fixes the boolean; making the verb SAY it
  could not resolve the registry is a second change. Recorded as observed, labeled
  here so the port is not verified against it as intended.

## Current truth worth knowing before re-recording

- **There is no watcher staleness computation.** `heartbeat_at` is read from the arm
  record and rendered; nothing in `tap-health.sh` compares it to the clock. The
  acceptance line "watcher armed/stale" is therefore covered here as pass-through of
  the field plus the dead-pid and wrong-command shapes, not by an aged-heartbeat
  case, because no such classification exists to pin.

- **marker-invalid / marker-unreadable fail soft.** With the flip marker
  invalid or unreadable, health renders the bus signals, prints
  `no registry (run: tap register)`, drops the roster, and exits on the bus
  signals alone. It does not say it could not resolve the registry. This is the
  same fail-soft class tap-n85k names for the rebind path. Pinned as-is because
  the differential's job is to say what the verb does today; a port that fails
  loud here is a behavior change that re-records these two cases under that
  ruling.
- **The unsettled-payloads table truncates its path column under width pressure**, to a
  prefix of the temp root that differs by host (`/priva...` on macOS, `/tmp/t...` on Linux)
  and is cut BEFORE normalization can see the full path. The test therefore pins
  `COLUMNS=400` so the path renders whole and normalizes to `<WORK>`; truncation itself
  is a rendering detail this corpus does not pin.
- **Ages are 90s** in every case whose artifacts exist: payload mtimes are set
  in UTC to 2026-09-01T00:00:00Z and the pinned clock is 90s later. The probe
  payload is one minute older (23:59:00Z, age 150s) so supervision ordering by
  mtime is deterministic.
