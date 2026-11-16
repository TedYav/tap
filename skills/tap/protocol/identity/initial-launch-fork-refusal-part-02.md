# Initial-launch fork refusal — source part 2 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0146 start=928281 end=934887 sha256=71f56a293b3a10d06e2407a7f877637ffff0b6edbc8a565b0155d6a7df8112c7 fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Project setup (`tap init`, tap-7r3fn.139.1; native since F1):** `initArgv` runs
init in a separate Bun process. Before writing, new enrollment refuses an invalid
index (`invalid_flip`), unobservable git (`git_unobservable`), invalid team name
(`invalid_team_name`), or missing non-git consent. On markerless machines, old
`teams.json`, non-current bus registries, launcher manifests or `agents` keys
refuse `old_store`; seated current bus registries refuse `unenrolled_seats`.
`<root>/tmp/tap/registry.json` without `.tap/bus` also refuses `old_store`, preserving
bytes. Init creates the bus, publishes the born-live marker, writes
`{"schema":"0.20","team":{...},"seats":{}}` to `<root>/.tap/team-registry.json`, and
enrolls the root. Lost registries are recreated at their stored `registry_location`
and name; non-current enrolled registries refuse. Fresh init prints
`successfully initialized team: <team>` then `bus: <path>`; usable existing
teams print `already initialized: team <team>` plus a no-changes receipt,
with no setup writes; harness trust remains a separate offer.

**Team name (tap-rt1h2, `teamNameForRoot`):** a current registry keeps its name;
a different `--team` refuses `team_name_conflict`. Otherwise: `--team` (a token
without `.`), then a valid-token folder name verbatim, then a lowercase slug
(runs outside `[a-z0-9_-]` become `-`, edges trimmed: `My Project` → `my-project`).
Print `team name: <slug> (derived from folder '<folder>'; override with --team
<name>)` (stderr for `--json`/`--for-launch`). Invalid `--team` or empty slugs
refuse `invalid_team_name`, naming `--team`. `--for-launch --dry-run` prints
`{ok,team:{name,root}}`. Fresh `tap register` shares this rule. Linked worktrees
own separate teams and buses; discovery stops at their Git root, never inherits
primary enrollment, and retains explicit-selector precedence.

Shared init completes instructions after successful registry creation or
recreation, including direct launch. A terminal asks before creating missing
`AGENTS.md` or appending a missing TAP signpost to an existing file, default `[Y/n]`.
`--yes` accepts; noninteractive/JSON writes without prompting. Complete blocks
stay intact; partial blocks and unsafe files remain advisory. `--no-instructions`
skips the file entirely. Dry runs, refusals and usable teams neither offer nor
write instructions. `TAP_SETUP_REPO_PENDING=1` leaves both to setup. Declining
names `tap setup --repo`; EOF or an incomplete/invalid answer never accepts.

Explicit init receipts, previews and harness trust are specified in
[Project initialization](./project-initialization.md).

**Non-git roots and first launch (2026-09-23):** outside Git, init asks
`<root> is not a git repository — initialize TAP here anyway? [y/N]`. Scripts
use `--yes`; noninteractive/JSON without it refuses `confirmation_required`,
next: `run tap init --yes in <root>, or cd into a git repository`. The consented
folder enrolls under its derived name; init beneath an enrolled non-git root
reports that team. Non-Git init reports skipped .gitignore setup. JSON stdout
is one object with `already_initialized`; prompts/notices stay on stderr.

Public launch offers normal init to fresh unregistered terminal callers;
fresh noninteractive callers must init first. Callers bypassing that offer
(such as registered actors) reach shared init in-process with `forLaunch`,
which refuses linked worktrees and folders beneath enrolled non-git roots.
Both creation paths complete instructions before harness startup.

**Startup evidence (tap-7r3fn.149):** Session lifecycle operations write quiet,
best-effort JSONL to `<TAP_INDEX_HOME>/logs/startup.jsonl` (default `~/.tap/logs`).
The active file and one rotated file each have a 300 KiB limit; each event is
under 4 KiB. Only operation startup rotates, under the appenders' nonblocking
flock. Contention, a full log between starts, or storage failure may
omit evidence and never changes the operation result. Courier traffic writes no
startup events. Events name the operation, boot, session, phase and tmux result;
they omit harness commands, prompts and environment values and redact secret
fields. Bun owns the writer. A native operation streams events to one writer
child (own process group, 1 MiB cap, up to 100 ms lock wait); at its end the
caller closes the pipe and kills a writer alive after 500 ms. Events outside an
operation and Python callers (context via a bridge) use a one-shot child:
200 ms budget, hard kill, no retry. A failed Python context call discards its
capsule, so subsequent events may lose operation correlation, or be omitted
until the next begin. Python context observations pay the child call even when
native policy suppresses the event; observations without context start no child.
Symlinked lock paths and unavailable locking primitives omit evidence without an unlocked write.

A launch rollback also appends before/after lifecycle and identity snapshots to
`registry-events.jsonl` beside the acting registry, under its own nonblocking
append lock. This journal is independent of startup-log rotation and preserves
native conversation identity and the bulk-relaunch predicate at the transition;
it omits prompt, environment and passthrough fields. A journal write failure does
not reverse the completed registry mutation.

`tap doctor` reads the current registry and tmux state as authority. Retained
operational failures get a named-resume command; no server is an ordinary offline
state. Missing server cwd and `exit-empty on` are informational. Diagnostic-only
warnings: `exit-unattached on`, and an offline or empty resolved socket while
seat sessions answer on another (names `TAP_TMUX_SOCKET_PATH`; replaces the
offline note); a failed probe is unknown. The startup
trace path is context; an old event never creates a current-state finding.

**On-demand tmux bootstrap (tap-7r3fn.149):** Session-creating commands start a
confirmed-absent selected server from `$HOME`, with `exit-empty off`, under a
socket-keyed machine lock. Existing servers are never replaced or reconfigured.
`[tmux] bootstrap = false` disables this behavior. `tap init`, setup and dry runs
never bootstrap. Daemon startup strips harness, TAP and Git identity variables
and uses a stable system PATH. Unknown socket state refuses with `tap doctor`.
Seat recipes load a POSIX login shell, then append caller PATH as fallback,
keeping first occurrences. Login-selected CLIs win; caller-only CLIs and
env-shebang runtimes remain. The server environment is unchanged. Fresh crew add
types a short private-file reference; the invocation unlinks itself before exec.
Unsupported shells fall back to zsh, bash or sh, named in startup failures.

Team startup and restart cohort recovery are specified in [team up](./team-up-last.md).

**Developer lifecycle diagnostics:** `[diagnostics] level = "verbose"` in machine
config enables file-only lifecycle details in `<TAP_INDEX_HOME>/logs/launch-debug.jsonl`.
Default is off. The file is capped at 5 MiB with three rotations, using the shared
redacting, nonblocking writer. Enabling it adds config reads, command capture and
disk I/O to lifecycle operations; it never instruments courier traffic. Console
verbosity still requires explicit `-v`/`TAP_VERBOSE`. Neither diagnostics tier
starts tmux server tracing; that remains a manual `tap debug trace <seconds>`
operation.
Native launch and resume read it once per operation, then log
`diagnostics_start` and each command; dry runs log none.

### Shared launch transaction

One native owner runs fresh/replacement launch, adopted/named/cohort resume and restart. The native `resume --all` cohort (`tap team up`) owns selection, reboot recovery, the per-seat loop, summary and fresh-start prompt. Every other resume form runs in `launcher/resume.ts`; `tap register` stays a subprocess. Python keeps the argparse surface and execs the native entry with typed values: `--all` before any trace begins, other forms passing their open trace operation, which the entry joins and finishes with its real exit code. `launcher/attach-policy.ts` owns attach: typed refusals for callers inside tmux or with unverified tmux/foreground state; otherwise `attach-session` from the caller's terminal. Attach reads tty and pane_dead together. Dead panes cannot claim the tty; malformed evidence stays ambiguous; live tty and foreground checks apply. Native launch and both resume entries own the terminal, decide in-process, run child `tmux`, and exit without Bun's termios write-back, preserving terminal mode. Each caller re-reads foreground ownership immediately before that spawn and refuses with the ownership receipt if it moved; an interrupt stops the policy's pane probe and exits as the interrupt. Launch (`launcher/new.ts`) uses native resume's attach tail. One native owner decides native-identity uniqueness for every resume caller, including the backfill resolver's batched check. All six harness adapters use this owner. Clear/relaunch process replacement, fences, nonce, rebind, history and delivery retain their existing owners. Their shared Cursor pre-mint helper is native: clear wipes identity then mints before its replacement fence; fresh launch refuses a pre-existing Cursor ID before mint. `cursor-agent create-chat` keeps its cwd, ten-second bound, case-preserving UUID extraction and failure/no-ID continuation. Existing-ID and non-Cursor records never mint.

The native coordinator holds reset custody from claim through readiness or unwind. Registry custody covers sibling suspension and incumbent stop, and is released during readiness. Lock waits are unbounded and remain cancellable. Root, team and registry authority are pinned; every write refuses drift. This path has no parent Python reset lock or child reacquisition.

New delayed failure payloads carry the claim token, observed instance (including explicit absence in a pre-flip store), and the created server/session/window/pane/socket identity. Rollback checks registry ownership, writes the restored/deleted row, and performs cleanup while retaining the same registry lock. Cleanup uses tmux `if-shell -F` to check the identity at the effect; it does not recheck a token its own rollback removed. A stale token, ready successor, changed incarnation or reused name does not authorize cleanup or foreign-pane capture. Old callbacks without this evidence retain residue with a diagnostic. No exit-hook completion is awaited while holding the registry lock.

Before stopping an incumbent, preserve the locked original row in the existing four-JSON-file, COMPLETE-last session-kill backup format. Explicit-fresh/picker-`[k]` refuses destruction if backup fails. Conversation-preserving restart/resume/up attempts the same backup, warns when unavailable, and may proceed under the same identity and claim guards. No incumbent means no new backup. A verified reusable bundle is not duplicated. Bundles accumulate without automatic retention or pruning. Recovery names the original authority and a validated bundle when available; otherwise it says no durable bundle exists and gives diagnostics, never a fabricated restore path.

SIGINT, SIGTERM and parent request-pipe EOF request guarded unwind; interrupts never become cohort misses. The Python bridge keeps that pipe open until the worker completes custody, and normal completion cannot trigger EOF cancellation afterward. Worker stdio is piped. Native resume owns the caller's terminal only for its prompts and attach child; each prompt reads one key through a shell child that restores the terminal state it saved. Spawned transaction commands do not inherit the caller's TTY or kernel-lock control descriptors. Cancellation observes process-group termination, including descendants. SIGKILL provides no transaction rollback guarantee; kernel custody still ends when its holder loses the coordinator.
