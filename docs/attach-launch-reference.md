# Attach and launch reference

Detailed selection, authority and launch rules. For everyday usage, run
`tap attach --help` or `tap launch --help`.

## Attach selection and authority

Attaches your terminal to the named seat's tmux session — `switch-client` when
you are already inside tmux, `attach-session` when you are not.

A bare handle means a seat on the team this directory resolves to. When that
team has no such seat (or this directory is on no team), attach looks on every
enrolled team: a handle held by exactly one team attaches directly and says
which team it resolved to; one held by several teams is refused as
error_class=ambiguous_handle, listing each `<team>/<handle>` to choose from. A
team whose registry cannot be read is skipped with a note; if it could hide a
second holder, a lone match is refused as error_class=unverifiable_handle
instead of attached. TAP_TEAM_SELECT is never widened. The qualified
team/handle form names its team and never scans.

tap attach --next picks the next unattached active seat on THIS team and hops
through the positional path with --no-resume. Eligible seats are pane-backed,
classifier-active, and currently unattached; poll members and every inactive
lifecycle are skipped. Handles are C-locale sorted. From an observable TAP
seat, scan strictly after the current handle and wrap once; from a genuine
outside terminal, or an observable in-tmux pane that is not a registered TAP
seat, start at the first eligible handle. An unobservable in-tmux caller is
refused, not treated as outside. The hop is --no-resume `<team>/<handle>` on the
acting team, never a bare handle. No eligible seat is error_class=
not_attachable (never launch or resume). --next takes no target and is mutually
exclusive with --interactive and with --no-resume (the hop is already
attach-only). Repeated --next advances through the ordered eligible ring
(a two-seat team, or a wrap onto the only remaining eligible seat, can
land back on the one just left).

"Human terminal" means stdin and stdout are TTYs, TERM is not dumb, output is
not JSON, and the caller owns the foreground terminal. With no target such a
terminal opens the team and seat pickers. With a target that is not found (an
unknown seat on a known team, an unknown team, or an unanchored directory) it
opens the picker seeded with what you typed instead of refusing. An unknown
seat on a known team opens only that team's live-seat picker; an unknown
qualified team seeds the team picker and then the seat picker. --no-resume
does not disable this (a picked seat is attach-only); it only turns an
inactive rostered seat into a refusal. Enter confirms a choice; Escape
cancels. Exact rostered seats keep their ordinary attach or resume offer.
Invalid syntax, unavailable authority, JSON output and any caller without a
foreground terminal never discover: they are refused, as the table below shows.
Picked seats recheck the chosen team, row and pane generation before moving a
client.

--interactive replaces the handle with two fuzzy selectors: team, then seat.
Type to search, use arrows to navigate, and Enter to select. Escape cancels;
Ctrl-C exits 130. The team step offers only teams holding at least one live attachable seat —
daemon and pane-less infrastructure rows never count — and an unobservable
team stays visible with its diagnosis. When nothing is live, attach refuses
instead of opening an empty picker.
Seat offers use the same active-seat classifier as the roster, and the final
attach checks identity again. The picker never launches or resumes a seat.

It uses TAP's pinned private fzf, installed with ./install.sh, and ignores user
fzf option/config environment. It works over SSH from outside tmux. A foreground
controlling terminal, stdin/stdout TTYs, human output and TERM other than dumb
are required. NO_COLOR is honored. --interactive takes no positional target.

--no-resume makes the verb attach-only for the positional form too: a seat that
is on the roster but not active is refused, naming `tap session resume`, instead
of prompting. This is what --interactive hops with.

Seat state comes from the same classifier `tap team` prints, so this verb and
the roster can never disagree about who is reachable:

```text
  active            attach
  on the roster,    offer to run `tap session resume <handle>` first. The
  not active        offer defaults to YES (Enter resumes; n declines) and
                    needs a terminal to answer it; a caller without one is
                    refused, naming that verb. --no-resume and
                    --interactive skip the offer and refuse outright.
  poll-mode member  refused — pane-less by construction, so there is no
                    session to attach to and none to resume either
  not on the roster human terminal: opens the picker, seeded with your
                    text (attach-only). Otherwise a genuine missing seat
                    is refused, naming `tap team` and `tap session
                    launch`; bad syntax and unavailable authority are
                    refused with their own next step.
```

## Launch policy and naming

Launches and registers a seat, then attaches from a foreground plain terminal.
A fresh project offers tap init; noninteractive callers must initialize first.
From an agent or without a terminal, use tap attach `<team/seat>` to visit it.
A name already in use offers [r] resume, [n] new, [f] fork, [k] kill, [q]
quit; a harness running in tmux off the roster offers no [r]. [n] and [f]
ask for the name; [f] is greyed when the seat cannot fork.
Bare harnesses: claude, codex, opencode, cursor, agy, hermes.
Choose with tap models; presets optionally save a combination you use often.
Claude effort: low, medium, high, xhigh, max. AGY: low, medium, high.
Hermes: none, minimal, low, medium, high, xhigh, max, ultra.
Codex passes non-empty effort strings through to the harness. OpenCode and
Cursor support model only; no standalone effort flag. Unknown defaults stay unknown.
Top-level --effort cannot combine with a harness tail; qualified examples from
tap models use the native effort flag when a service/context tail is needed.

### Tuning and policy

With a preset, model and effort come from the preset and cannot be
overridden (preset_not_composable). With a bare harness, use --model and
--effort.
A requested preset resolves once from
${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml (a legacy presets.toml
still supplies [presets] for one release). Its effective harness, tuning,
environment and provenance persist for resume and restart, which never
reread the preset catalog.
A bare harness resolves no preset. It reads that file for the harness's
`[harness.<name>] machine policy` (environment, params and permissions), which
IS re-read on every launch, resume and restart. A missing file applies no
policy silently. An unreadable, malformed or insecure file degrades to no
policy with a notice rather than blocking the launch; an invalid value in the
requested harness's table refuses before launch.

### Resuming a conversation into a new seat

`tap launch <harness|preset> [name] --resume` starts the seat in the harness's
own conversation picker (Claude Code `claude --resume`, Codex `codex resume`)
and mints no session id; the picked conversation's SessionStart binds as the
seat's identity with no `tap in`. `--resume=<id>` resumes that id directly and
expects it exactly. Only the `=` form takes a value: `--resume <id>` reads
`<id>` as the seat name. Cursor, OpenCode, Antigravity and Hermes refuse
(`launch_resume_unsupported`): they have no picker. The marker is consumed by
the launch argv and never stored, so resume, restart and relaunch replay the
bound conversation and never re-offer the picker. The picker lists
conversations from the seat's start directory. As on `tap session resume`,
an axis the harness restores natively (the conversation's own model; on Codex
its effort too) is not re-passed from a preset or tail, and an exact Codex id
names its resume directory with `--cd`. `--resume=<id>` also requires the
conversation to exist in the store the seat's harness will read (its own
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, declared or inherited, else the default
under its home folder) and to belong to no other seat; the
seat's own incumbent under `--fresh` is not another seat. Either refusal
(`no_exact_resume_identity`, `launch_resume_identity_owned`) lands before the
incumbent is touched, so a mistyped id never stops it.

### Names and collisions

A name that is not on the roster launches fresh. With --json or without a
terminal, an on-roster collision refuses instead of asking: error_class
session_exists, or session_record_exists for a retained row whose session is
gone. --fresh replaces the seat without asking.
Naming is a CONVENTION, not a rule: a seat doing a named duty is commonly
launched as `<base>-<duty>` (opus-lieutenant, grok-fence), where <base> is its
preset or calibration name. The duty-suffixed handle joins its base row by
longest prefix in tap team calibration and in tap team --json metadata.
Nothing enforces it; an unconventional name still renders honestly as
seated-and-unjoined, and no role signal from a name ever gates work.

### Overrides and workdir

--env KEY=VALUE overrides preset environment; --unset-env KEY removes a
variable even if shell startup exports it. Both are repeatable; naming a key
with both flags refuses. Harness arguments after -- append last, preserving
preset defaults. These overrides persist for resume, restart and relaunch.
--preset belongs before harness passthrough and is never forwarded. Other
flags launch does not own forward verbatim to the harness and persist in the
registry across resume and restart. Implicit passthrough emits a warning;
use an explicit -- before intentional harness flags to avoid it. JSON
failures discard that warning so stderr stays empty.
`--workdir <path>` starts the harness in an existing worktree of the enrolled
team repository and records that directory for relaunch, resume, restart and
clear. Run launch from the enrolled team root; relative paths resolve from
the caller directory. The team identity and bus stay at that root; no new
team is enrolled. Missing paths, checkout subdirectories and unrelated
repositories refuse before launch. --cwd is not a TAP launch option; use
--workdir.
