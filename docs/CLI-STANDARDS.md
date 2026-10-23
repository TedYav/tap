# TAP CLI standards

**Status:** ratified 2026-09-24 (`tap-zq2`); rules-file scope.
**Applies to:** `tap`, including session commands, help, output and tombstones.

When building or changing a CLI, follow the public guides this page adapts:
[Command Line Interface Guidelines](https://clig.dev/), the
[Heroku CLI Style Guide](https://devcenter.heroku.com/articles/cli-style-guide),
and [12 Factor CLI Apps](https://jdxcode.medium.com/12-factor-cli-apps-dd3c227a0e46).
This page records TAP's specific contracts, which take priority where those
guides differ. Explicit maintainer rulings and current protocol owners resolve
conflicts with older plans.
Ratification sets the standard for changed paths; it does not claim that every
legacy path already conforms or require unrelated repairs in a focused PR.

There is no conventions-reviewer agent or additional merge requirement.
[AGENTS.md](../AGENTS.md#contributing-pr-flow) owns checks and review.

## Scope follows the state being changed

**CLI-SCOPE-1/2:** Each stateful verb has one primary anchor, declared in help.
A flag must not promote a team command into machine administration. State stores
must be traceable to the anchor; declare composition in help or the contract.

| Surface | Primary anchor |
|---|---|
| Exchange verbs (`send`, `reply`, `poll`, `outstanding`) | One exchange on a resolved bus; qualified addresses may cross teams |
| Identity (`in`, `out`, `whoami`) | Pane/seat and resolved team |
| Calibration (`calibrate`) | Machine-local observation store under HOME; writes compose with registered caller identity |
| Supervision and diagnostics | Resolved team bus, seat or explicit target |
| Bootstrap (`init`, `setup`) | Repository/team |
| `tap team <verb>` | Resolved team |
| `tap session <verb>` | Launcher session/handle key |
| `tap admin <verb>` | Machine index/manifest, independent of cwd |
| Tombstones | No former mutation |

The split of one mixed-scope `reset` into separate `team reset` and `admin reset`
verbs is the scope precedent. `escalate` is declared composition: it reads a machine setting, then
sends on the resolved bus. Help and errors name the relevant scope and explain
team resolution or the accepted session key.

**CLI-SCOPE-3/4:** Core transport, session lifecycle and optional orchestration
remain distinct surfaces. `/tap:lead`, runs, waves, gates and writer tokens do not
become core transport verbs. Core help may point to orchestration in `SEE ALSO`.

**CLI-SCOPE-5:** Pane-less automation pins its bus with `--team` or `TAP_HOME`;
interactive pane-backed use may derive it from the pane/repository. Each
pane-less-capable verb documents its anchor.

## Canonical help

**CLI-HELP-1/2:** The general public help catalog is
[`runtime/bun/src/help.ts`](../runtime/bun/src/help.ts). Its routing deliberately
leaves `help ask`, `help skill` and `help debug` to their special handlers;
change the accepting handler's help for those forms. The July draft's general
Bash/launcher renderer ownership has been superseded by the native catalog.

- `tap help` is the overview; `tap help <verb>` is the canonical page.
- `tap <verb> --help` in its exact one-token help form returns that same page.
- Trailing `help` is an alias only where it cannot be data. New verbs default
  to data-bearing until their safe routing and focused assertion change together.
- Multi-token family help and ordinary operands retain their accepting route.

**CLI-HELP-3/4:** Pages use `NAME`, `USAGE`, `DESCRIPTION`, `OPTIONS`,
`EXAMPLES`, `EXIT CODES`, `SEE ALSO`, in that order where applicable. `NAME` and
`USAGE` are required; omit empty sections. Document public flags and branchable
nonzero exits with accepted examples. Keep the overview grouped and at most
40 lines, including operational top-level verbs, active tombstones and the
golden rule. Family details belong on their pages.

**CLI-HELP-5:** Change help and behavior together. Focused assertions protect
meaning and routing; whole-page snapshots are not the default.

## TAP flag meanings

| Rule | Flag or surface | TAP contract |
|---|---|---|
| CLI-FLAG-1 | `--dry-run` | Same resolution, validation, refusals and ordering; no durable writes or courier input. Compose with JSON where supported. |
| CLI-FLAG-2 | `--json` | Representation only; same selection and effects. Success emits one documented JSON value. Failure uses the envelope below. |
| CLI-FLAG-3/6 | `--force` / `--yes` | Force bypasses one named policy refusal; yes confirms the previewed destructive action. Neither bypasses parsing, identity, integrity, atomicity, durable-write ordering or a data-protection lock. |
| CLI-FLAG-4 | `--by <handle>` | Validated eligible actor for settlement/reply/supervision; omission derives the pane caller where possible. Sender remains `--from`. |
| CLI-FLAG-5 | Aliases | Same operands, flags, outputs, exits and effects as the canonical verb; errors name the canonical verb. |

Legacy team lifecycle exceptions are not precedents: `team down` and
`team shutdown` accept `--force` as a compatibility no-op. On their interactive
target-discovery path, `--yes` skips only the final confirmation after the
preview; on an explicit-target path it remains a no-op. `team reset` aliases
`team out --hard`: `--yes` confirms full-team or picker retirement; without
a terminal these paths require it. Supplied handle lists need no extra consent. The retired `--kill-self` and `--allow-nonstandard-bus-path` flags
refuse before team resolution.

Message bodies use `-f <path>` or `-f -` with literal stdin. Prose that contains a backtick or command substitution uses a file, never an inline body, because the shell expands backticks and command substitution before tap receives the body. A quoted heredoc is the accepted alternative to a file.

## One error renderer; stable exits

**CLI-ERR-1/2/3/4:** Default failures emit one human line on stderr:

```text
tap <verb>: <plain cause>; next: <recovery>
```

With `--json`, emit one object on stdout and nothing on stderr:

```json
{"ok":false,"error_class":"<token>","action":"<shell-safe value>","detail":"<shell-safe value>"}
```

`detail` is optional. Flatten newlines in cause/action/detail.
`error_class` is a stable lower-snake-case token; `action` is the next command or
stable action token. Preserve the JSON contract when changing presentation.
`error` / `fix_command` is a migration fallback, not a new public failure.
Unknown commands/options, missing help and renamed verbs use this same grammar
with the narrowest useful help or replacement. TTY and `NO_COLOR` do not change
JSON bytes.

`tap calibrate` v1 has one deliberate exception: when `calibration.enabled` is
false (the default), reads and writes, including `--json`, refuse with one stderr
line, no stdout and exit 1. The line names the setting and enable command. Once
enabled, it uses the ordinary envelope: `unknown_route` means no roster/launch
evidence for a target; `invalid_note` or `empty_note` means the body/reference
cannot be recorded; `calibration_unavailable` means the machine store or its lock
cannot be used. These refusals preserve the active bytes rather than repairing
them. See the [calibration owner](../skills/tap/protocol/identity/calibration.md).

**CLI-EXIT-0:** Non-zero means the command could not do its
job: bad input, a refusal, an unreadable bus or registry, unobservable tmux, a
failed action. The one other non-zero is a check verb (`doctor`, `health`)
reporting the problem it exists to find. A command that reports state exits 0
whatever the state is: open sends, pending mail, "not installed". Agent
harnesses render every non-zero exit as "Command exited with an error", which
sends readers investigating ordinary state. Scripts branch on the `--json`
fields, not the exit. This follows [clig.dev](https://clig.dev/#the-basics)
("Return zero exit code on success, non-zero on failure") and the precedent of
`git status`, which exits 0 whatever the state.

**CLI-EXIT-1/2:** Command pages may narrow these meanings, not contradict them
or CLI-EXIT-0.

| Exit | Meaning | Caller action |
|---:|---|---|
| 0 | Completed or durably accepted (send may be queued); a read or status command reported, whatever the state | Continue under the command's contract; acceptance is not recipient processing |
| 1 | Invalid input, refusal, integrity failure or unsafe-to-check state | Fix or follow `action` |
| 2 | A check verb found attention, or an existing page-specific alternate that is not ordinary state; no unsafe partial mutation | Branch using the page's contract |
| 3 | Delivery target unavailable before canonical placement | Repair/re-register target, then retry |
| 4 | Unanchored bus for `poll`, `outstanding`, `peek` and `doctor`; retired as a public send exit | Resolve/pin the bus for those read commands; current send accepts queued delivery with 0 |
| 5 | Delivery attempted; submission unverified; durable pending id/path emitted | Supervise pending id; do not assume absence |

Exits 3 and 5 are reserved for delivery atomicity. Exit 4 also retains the
[unanchored-bus split](../skills/tap/protocol/transport/bus-layout-under-tap-home-part-03.md)
and [doctor refusal](../skills/tap/protocol/transport/bus-layout-under-tap-home-part-04.md).
A new public exit meaning needs
a documented caller/composition use and focused assertion. See the
[protocol owners](../skills/tap/protocol/README.md) for delivery semantics.

## Receipts and presentation

**CLI-OUT-1/4:** A successful mutation emits at most one bounded receipt plus
only the finite action pointers its page names. Clean registration ends with
`registered <handle> on team <team>`; pending inbox state adds one `tap poll`
pointer, not a digest. Take-over guidance requires genuine ambiguity. Routine
success ends without an imperative menu or unbounded list.

Read-only commands may offer a command-specific quiet form for a named
consumer; there is no global `--quiet`. Quiet changes output, never the exit
(`poll --quiet` is the precedent).

**CLI-OUT-2/3/5:** Align columns for tabular read-only reports, not receipts or
errors. A shared table helper needs three actual implementations that drifted.
Add JSON for a checked-in consumer or concrete shell composition, with a stable
schema and focused assertion. Warnings go to stderr, results to stdout; the
JSON error envelope above is the deliberate exception. Select JSON explicitly,
not by TTY detection.

**CLI-TTY-1/2:** Ordinary help, errors, receipts and reports are monochrome and
contain no ANSI escapes; TTY, redirected, `TERM=dumb` and `NO_COLOR` views see
the same bytes. Managed fzf team/seat pickers are explicit exceptions for
screen/cursor control, not permission to decorate ordinary output. Pickers require
a foreground terminal, refuse `TERM=dumb` and JSON, and honor `NO_COLOR` even
when empty.
Redirected and machine output remain free of terminal controls. `tap team doctor` is an explicit exception: interactive
terminals show transient scan progress and color the clean check green and
repair findings red. Skipped checks are yellow and grouped under `not checked`;
their JSON severity remains `warning`. Color honors `NO_COLOR` (including an empty value) and
`TERM=dumb`; progress requires both output streams to be terminals and is
disabled for `TERM=dumb`. JSON and redirected output contain no terminal
controls. The human `tap team` roster also styles state dots, cache markers and daemon harness labels:
daemon labels are italic and ready dots light cyan. Cache dots and their minutes are bright blue at 15m or more, yellow under 15m and red under 5m; after expiry a bare dark-red dot remains. `tap teams --seats` uses the same cache and state colors beneath bold cyan team headings. Styling
requires a terminal, respects `NO_COLOR` and `TERM=dumb`, and never enters
redirected or JSON output. `tap admin ps` is also an explicit exception: status dots reuse the roster palette; qualifying top CPU/memory cells use bold amber plus an ASCII `*`. The mark and its conditional legend remain in uncolored human output. Color requires TTY stdout, absent `NO_COLOR`, and `TERM` other than `dumb`. JSON stays uncolored and numeric. `tap session launch` is also an explicit exception: when stderr is a terminal and `TERM` is not `dumb`, it shows a transient monochrome spinner line per real launch phase on stderr. Each phase settles to `✓`; a failure settles the phase it stopped in to `✗` before the error. Every effect-bearing phase (the ones named below) keeps its `✓` however briefly it ran, so a launch lists the same steps on a fast and a slow harness; other phases too brief to draw leave nothing. Redirected stderr, `--json`, `TAP_JSON=1` and dry runs see no spinner. In every mode, a failure inside an effect-bearing phase (reserving, tmux setup, harness start, readiness, marking ready) names that phase in its error, as `tap session: while <phase>: <cause>`; config-time refusals keep their bytes. `tap team refresh` is also an explicit exception, sharing the launcher's spinner: on a stderr terminal with `TERM` not `dumb` and `NO_COLOR` unset, a real refresh shows a transient line per slow phase (waiting for the registry lock, re-binding each seat), settling to `✓`, or `✗` on failure. Phases too brief to draw leave nothing. `--json`, `TAP_JSON=1`, `--dry-run`, `NO_COLOR` (even empty), `TERM=dumb` and redirected stderr see no spinner; the per-seat receipt stays on stdout, byte-identical. The launch collision chooser is also an explicit exception (tap-ibmoe): on a colour terminal (stderr a TTY, `NO_COLOR` absent, `TERM` set and not `dumb`), an unavailable `[f] fork` row and the name prompt's default suffix render grey (SGR 90); the name prompt redraws its line in place. Without colour the row reads `(unavailable: <reason>)`, and under `NO_COLOR` the name prompt is still edited key by key (tap-tl6rh): a plain line with the default in brackets, no escapes, each accepted key echoed. The editor never lets a character a handle cannot hold (space, `/`, a leading `-`) enter the line, pasted or typed; it rings the bell and names the allowed characters. `TERM=dumb` (or no `TERM`) keeps a cooked line, where the launcher's name check refuses and asks again, naming the allowed characters. Any interactive prompt under the launch spinner suspends it while it waits. Other commands still need an explicit ruling for color.

## Compatibility and change ownership

**CLI-RENAME-1/2:** A moved public spelling becomes a non-mutating tombstone:
exit 1, `error_class=renamed_verb`, canonical successors and the reason for a
scope split. Retain it in help; old flags do not run the old operation. Aliases
are suitable only for unchanged semantics and scope. Zero-adoption or
scope-changing verbs use tombstones. Removal is a deliberate compatibility
decision with a reference sweep, updated smoke contract and a protocol/version
note when the observable surface changes.

**CLI-CHANGE-1/2/3:** Coordinate changes sharing dispatcher/help files. Include
before/after output for presentation changes and identify the affected contract
in the PR. Use the focused checks and supported runners in AGENTS.md; shell
compatibility and Bun ownership follow its current migration policy. This page
adds no suite, panel or reviewer to the one-tier merge contract.

## Precedents

- The help, output and scope decisions date from July 2026.
- [CONTRACT](../skills/tap/scripts/CONTRACT.md) and
  [protocol pages](../skills/tap/protocol/README.md): normative protocol owners.
- [Architecture](ARCHITECTURE.md): core/session/orchestration boundaries.
- Human-first errors, later extended to the single-renderer contract retained here.
- `tap-tp2`: reset scope split.
- `tap-qqd`: terminal registration receipt and deferred inbox triage.
- `tap-zq2`: the rules file; reviewer tooling is out of its scope.
