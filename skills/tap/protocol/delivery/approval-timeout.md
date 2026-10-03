# Approval timeout: decline a request no one answers (tap-rlebf.2)

A seat that stops at a tool-approval prompt stalls until a person answers. When
a team opts in, TAP declines a request that has waited its harness's timeout.
It then tells the seat to route around the request and ask the user later, tells
the watch armer, and records the outcome. TAP never sends an approve key. This
is the one caller, besides dismissal recovery, that may send a key to a
recognized prompt, and it sends only the lone Escape that
[default-deny](default-deny.md) already allows from a recovery run.

## Policy

- `tap approval-timeout on|off|status [--json] [--team <name>]` writes and reads
  `approval-timeout/policy.json` on the team bus. Missing or unreadable reads as
  off. The policy survives a watch disarm and rearm. `tap team reset`
  checkpoints `approval-timeout/` beside `watch/`.
- Each harness has one built-in timeout: Claude, Codex, Cursor, OpenCode and AGY
  600 s; Hermes 120 s. There is no team or seat duration. Revisit only when an
  operator asks for a different duration on a real team.
- The pass runs inside the watch tick, after the blocked-seat pass. **No timeout
  runs unless the team's watch is armed in full mode.** An unarmed team and a
  `reminders-only` arm run none, and `on` and `status` warn about it.

## The request and its episode

`approvalRequest` (`runtime/bun/src/agent-state.ts`) is narrower than the
delivery hold `approvalPrompt`. It returns a value only for a tool-approval
request. Trust dialogs, Codex question prompts and `[y/n]` lines, OpenCode shell
mode, and anything unclassified return nothing and never open an episode. The
value carries:

- a fingerprint: a hash of the harness, the rule, and the request's own rows,
  whitespace-normalized, with selection glyphs and Claude's rotating `Tip:`
  block removed, so a moved highlight is the same request;
- an excerpt of at most 200 characters;
- `denyLabel`: whether this same frame labels Escape as deny or cancel.

An episode is one seat's request, keyed by handle and bound to the seat's
registered instance and pane id. Its clock starts when a tick first sees it.

- A tick that sees a different fingerprint, no request, or a rebound seat ends
  the episode without a notice. A tick that cannot read the pane keeps it.
- **Residual.** If a request is answered and the identical request reappears
  before the next tick sees it gone, both read as one episode. The second
  inherits the first's start and can be declined seconds after it appears.
- When the deadline passes, the pass records exactly one outcome. Every outcome
  except a sibling refusal leaves the episode as a **tombstone**. A tombstone
  never gets a key or a second notice, and it ends only when a tick sees its
  request gone. Turning the policy off and on again while the request stays on
  screen starts no new timeout.
- The pass stamps a claim before the key. A claim with no recorded outcome (a
  crash mid-effect) is reported `unverified` and never retried.

## Per-harness rows

A row may send its key only after its real before/after capture and its
rejection marker are committed. Until then, an expired request that
`approvalRequest` positively recognizes is reported blocked and escalated, with
no key sent. A frame it does not recognize opens no episode, so nothing is
observed or escalated. Today no row is live.

| Harness | Request shape | Deny control | Attestation on the frame | Row |
|---|---|---|---|---|
| Claude | `permission_prompt` with a `No` option | Escape | `Esc to cancel` footer | pending capture |
| Codex | closing `press enter to confirm or esc to cancel` | Escape | `No, and tell Codex what to do differently (esc)` | pending capture; the post-Escape frame is unknown |
| Cursor | `Run this command?` | Escape | `Skip & tell the agent what to do instead (esc or n)` | pending capture; the post-Escape frame is unknown |
| OpenCode | `△ Permission required` with `Allow once  Allow always  Reject` | Escape | none on the frame; `escapeKey="reject"` in the 1.18 TUI source, plus the sibling proof below | pending capture |
| AGY | `Requesting permission for:` with `No, cancel` | Escape | `esc to cancel` footer | pending capture |
| Hermes | synthetic only; the real prompt is not recognized | none until a real capture proves one | none | Hermes has no automatic timeout observation or escalation until its prompt is captured (follow-up). |

Hermes denies by itself after its own 300 s `approvals.timeout`. The 120 s
default is the intended timing once the follow-up capture lets TAP recognize
the real prompt: it is shorter so that TAP observes the expiry first, allowing
two 60 s ticks of lag. `status` already warns when the tick interval is above
90 s. Enter is never sent, even where Hermes shows deny as the default choice.

**OpenCode siblings.** OpenCode's Reject fails every pending permission in the
session. TAP's OpenCode plugin records, per pane under the index home, the
pending requests of the session that asked, whether that session is a known root
session, the OpenCode version, and its process ids. While anything is pending it
heartbeats every 30 s. The key may go only when all of these hold:

- the heartbeat is no older than 60 s;
- the plugin is bound to the seat pane's process or its parent;
- OpenCode is 1.18.x;
- the request is in a root session, with no other session pending;
- exactly one request is pending, and its pattern appears in the frame's excerpt.

Otherwise the request is escalated rather than rejected. A sibling refusal keeps
the episode open, and each tick re-checks it. It is told once per reason.

## The key

The key goes through the recovery door (`recoveryEffect`), as a pane-less run
owned by the watcher process, like the copy-mode cancel. The door takes the pane
lock, re-proves the seat's registry binding and pane process, records the frames
and the intent before the key, and never replays after a possible effect. The
pass supplies:

- **gate**, the last read before the key: the policy is still on; a fresh capture
  shows the same fingerprint; and the deny label is still on the frame (for
  OpenCode, the sibling proof still holds);
- **verify**, after the key: the request is gone, the seat reads idle or working,
  and the row's rejection marker is on the frame.

Without the marker the outcome is `unverified`. That covers a person approving
between the gate and the key: the Escape then interrupts the approved command,
and the frame shows no rejection. The window runs from the gate through the
door's last identity read to the key. It is accepted, and it is reported.

## Outcomes and notices

| Outcome | Seat notice | Armer notice | Human escalation |
|---|---|---|---|
| `verified` | route around it, ask the user later | yes | no |
| `unverified` | no | yes: could not confirm, no retry | no |
| `no_action` (`mapping_unproven`, `label_missing`, `version_unproven`, `gate_refused`, `sibling_pending`, `sibling_unproven`) | no | yes: still blocked, a person must answer | yes |
| `cancelled_policy_off` | no | yes, when a tick finds the policy off at the gate; `tap approval-timeout off` reports its cancellations to its caller instead | no |

Notices go out as `watcher`, using `kind=notice`, from fixed templates
(`approval-reject-seat.md`, `approval-reject-lead.md`). The request excerpt
travels as data in the body file. When the armer notice cannot be sent, an
`approval`-kind human NOTIFY replaces it; that kind never reads or stamps the
watch's silence-episode fields. A notice failure never re-enters the pane path.
Every outcome appends one line to `approval-timeout/events.jsonl`, which records
the seat, instance, harness, rule, fingerprint, excerpt, times, outcome, reason,
recovery run and notice dispositions. A disposition records transport acceptance,
never that the recipient processed the notice.

## Not built

Harness-native request responses (Codex app-server, OpenCode `permission.reply`,
Hermes transports) and pre-execution hooks were not built. TAP drives TUIs, so
those APIs do not address the seat, and OpenCode's reply is session-wide anyway.
