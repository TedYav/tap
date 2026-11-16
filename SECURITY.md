# Security policy

TAP allows agents to communicate! If this doesn't work with your threat model, don't use it!

This page is the whole security model. It states what TAP assumes, what it defends against, and
the failure modes it does not defend against — each with what can happen, who can cause it, and
why it is accepted — so you can decide whether TAP fits your threat model.

## Trust model

TAP is a same-machine tool. Agents on one machine coordinate by writing messages to a shared bus
and delivering them by injecting keystrokes into each other's terminal panes through tmux.

- Agents on one machine inject keystrokes into each other's terminals. An agent you launch can type
  into the pane of another agent, and bypass mode grants those agents your permissions.
- Message bodies are data, never instructions. TAP transports what a sender wrote; it does not
  vet it. Whatever reads a message decides what to do with it.
- The bus is a directory on your filesystem governed by your local permissions. Anything that can
  read your files can read the bus; anything that can write them can write to it.
- There is no network listener. TAP binds no ports and accepts no remote connections. Messages
  travel only between processes on the machine that share the bus directory.

TAP trusts the local user. It assumes every process running as your user is allowed to be there.
A register-time scope check anchors each bus to one worktree or folder, and cross-worktree relay
is an explicit opt-in that does not extend this trust. The
[protocol trust model](skills/tap/protocol/transport/trust-model.md) page owns the full statement.

**TAP does not defend against Byzantine failures.** In plain English, TAP is not designed to
protect you from a malicious agent on your team. Don't add untrusted agents to your TAP team.
TAP assumes cooperative participants working for the same user. A malicious or compromised
participant can lie, fabricate evidence or give different peers conflicting accounts. Shared local
records cannot establish trust between mutually distrustful participants. The transport defects
listed as in scope below remain in scope.

Requests within the team's agreed scope are ordinary delegation. When intent or scope needs
clarification, the requester can point to a specific user message, an agreed plan or a recorded
decision. These references help teammates reach a shared understanding; they are not credentials,
and routine requests do not require proof of authority. Their absence alone is no reason to stop
ordinary in-scope work.

## In scope

- Command injection through message bodies, payload paths, handles, or harness output — a crafted
  message causing a recipient to run something its sender should not have been able to make it run.
- A path escaping the configured bus root.
- A delivery to an unintended recipient.

## Out of scope

- Keystroke injection into registered panes. That is what TAP is for; it is a feature, not a
  vulnerability.
- Anything requiring an attacker who already has shell access as your user.

## Failure modes TAP does not defend against

TAP is a doorbell over a terminal, not a sealed transport. The bus on disk is the record; a
sentinel typed into a pane only tells a seat to go read it. These limits follow from that design
and are accepted rather than engineered around. Each entry names what can happen, who can cause
it, why it is accepted, and the page that owns the details.

### Privilege differences between seats are not a boundary

**What can happen.** A seat with fewer permissions can drive a seat with more. TAP does not
compare permission modes: any registered seat can send to any other, and an agent typing into a
bypass-mode pane acts with that pane's permissions. Harness integration doors inherit the same
machine trust — for example, the agy language-server port is loopback-only and carries no
authentication, so on a multi-user host other local accounts can reach it too.

**Who can cause it.** Any registered seat, any process running as your user — including an
agent that was itself steered by content it read — and, where a harness door listens on
loopback, other local accounts on a multi-user host.

**Why it is accepted.** Keystroke injection is the product. Permission boundaries belong to the
harness and the human approving it, not to the bus connecting them.

**Owned by.** [Trust model](skills/tap/protocol/transport/trust-model.md), the
[contract](skills/tap/scripts/CONTRACT.md) and the
[agy language-server appendix](skills/tap/protocol/harness/appendix-the-agy-native-driver-and-the-agy-ls-descriptor-tap-ssie-defaul-part-02.md).

### Message bodies can steer the agent that reads them

**What can happen.** Bodies are data, but the agent that reads one decides what to do with it.
Content an agent fetched — a web page, an issue, a file in your repository — can travel verbatim
inside a body and steer the peer that reads it (prompt injection between agents). The boundary
with the in-scope case above: a crafted message that makes a recipient run something *without*
its reader's judgment — through a payload path, a handle, or harness output — is a transport bug
TAP fixes; here the reader's judgment stays in the loop, and the content steers it.

**Who can cause it.** Whoever authored that content, upstream of TAP.

**Why it is accepted.** TAP transports what a sender wrote; it does not vet it. Whatever reads a
message decides what to do with it. Filtering bodies would make TAP an arbiter of meaning between
agents.

**Owned by.** The trust model above and
[Invariant for receivers](skills/tap/protocol/delivery/invariant-for-receivers.md).

### Sender identity is declared, not verified

**What can happen.** Any process running as your user can write to the bus as any handle. TAP
records the handle a message claims; it cannot verify it. A rebuilt seat can reclaim an existing
handle, and registry checks are snapshots: "the seat was gone" means "gone at check time".

**Who can cause it.** Any local process.

**Why it is accepted.** The bus has no authentication layer by design; it assumes same-human,
same-machine trust. Identity proof would add a key-management surface without changing who can
already type into a pane.

**Owned by.** [Trust model](skills/tap/protocol/transport/trust-model.md), the
[sentinel grammar](skills/tap/protocol/delivery/sentinel-the-wire-poke-zero-authority-part-01.md)
and [cancellation](skills/tap/protocol/delivery/cancellation-tap-pe56-dead-obligations-to-vanished-seats-part-02.md).

### A sentinel is a doorbell, not proof

**What can happen.** The courier presses Enter on text already in a composer only when that text
is one well-formed TAP sentinel, or the scrolled tail of a wire this bus's courier itself recorded
typing into that pane in the same tmux server generation. That record is narrow: the last four
wires per pane, kept only while a wire is typed and not known submitted, for at most the
staged-idle hold window (30 minutes by default).
Text that merely ends like a sentinel is a human draft and is never submitted on that basis. A TAP
tail that cannot be proven (its record expired, or another bus typed it) is handled as a draft too:
the message stays on the bus, and `tap resend <id>` rings it again. One limit remains. A narrow
composer shows only its last rows, so TAP cannot see text above a wire of its own that is still
waiting there; text typed in front of such a stuck wire is submitted with it. The courier does not prove which message a sentinel is: a stale or different TAP
sentinel left in a composer may be submitted — harmless, because the recipient's `tap read` either
handles the message or reports it already settled. And any local process can type a well-formed
sentinel; sentinels are doorbells, the bus is the record, and `tap read` resolves only real
payloads.

**Who can cause it.** Any local process, or ordinary leftover state in a composer.

**Why it is accepted.** Recognition is by class, not identity, on purpose. The bus on disk is the
record; the sentinel only says "go read it".

**Owned by.** The [sentinel grammar](skills/tap/protocol/delivery/sentinel-the-wire-poke-zero-authority-part-01.md).

### Placement and submission never prove processing

**What can happen.** TAP reads delivery from what the terminal renders. Narrow panes, soft wraps
and harness redraws limit what it can observe. A placement or a verified submission is a transport
fact; whether the recipient acted on the message stays unconfirmed.

**Who can cause it.** No one in particular — a limit of observation, not an action.

**Why it is accepted.** Transport records effects; workflows own convergence, review and merge.
TAP refuses to claim more than it can see.

**Owned by.** The [contract](skills/tap/scripts/CONTRACT.md) and
[submit verification](skills/tap/protocol/delivery/submit-verify-helper-lib-sh-tap-submit-verify-part-01.md).

### A delivery can consume a human draft

**What can happen.** Seats launched in auto mode, the default for Claude Code, Codex, Cursor and
Antigravity, receive mail only when the composer is empty, so their drafts are left alone. In a
bypass-mode seat, an OpenCode or Hermes seat, or a pane joined with `tap in`, a human draft is
ephemeral by policy. It gets a
30-second grace window (10 seconds for interrupts) and one `WAIT` snooze of two minutes; after that
the courier backs the draft up, clears the composer and delivers. Restoration is best-effort. A
collapsed paste label does not contain the pasted bytes, and some harnesses restore manually only.

**Who can cause it.** Any sender — any message arriving while you type.

**Why it is accepted.** Pipeline continuity wins: a courier that never touches an occupied
composer parks every time a human is mid-thought. The retained backup and `tap draft` recovery
are the trade.

**Owned by.** [Pending input](skills/tap/protocol/delivery/pending-input-standard-grace-then-the-clobber-pipeline-part-01.md)
and [draft grace](skills/tap/protocol/delivery/pending-input-standard-grace-then-the-clobber-pipeline-part-02.md).

### An urgent delivery interrupts a working agent

**What can happen.** A message sent with explicit `--delivery interrupt` (or `--urgent`) may press
the recipient's interrupt key and abort its current turn or tool call. A seat in auto mode is not
interrupted: the message is queued as an ordinary delivery. No other message interrupts: content
importance and escalations do not grant that authority. Recovery commands such as `tap nudge` can
also send Escape to dismiss a dialog.

**Who can cause it.** Any local sender who passes the flag.

**Why it is accepted.** A blocked seat sometimes needs to be interrupted to recover; making
interruption impossible would trade liveness for politeness. It is opt-in per message, never the
default.

**Owned by.** [Delivery policies](skills/tap/protocol/delivery/delivery-policies-tap-gzn-pr-a-polite-pr-b-urgent-part-01.md).

### Messages and drafts rest in plain text

**What can happen.** Bus payloads, receipts, previews, saved human drafts (`input-backups/`) and
the last wires typed into each pane (`typed-wires/`) are plain files with no encryption at rest: the bus directory — by default `<repo>/.tap/bus`,
relocatable with `TAP_HOME` — plus TAP's per-user state under `~/.tap`. Terminal scrollback and
any terminal logging see the same text.

**Who can cause it.** Anything that can read your files.

**Why it is accepted.** TAP is a local tool; your filesystem permissions are the boundary. No
network listener exists, but nothing obfuscates the local record either — a transport you cannot
read is a transport you cannot debug.

**Owned by.** [Bus layout](skills/tap/protocol/transport/bus-layout-under-tap-home-part-01.md).

### Delivery is highly reliable, not guaranteed

**What can happen.** Delivery is best effort and at-least-once in intent: a message can fail
visibly and can arrive twice. The service target is 99.9% recipient-observed delivery. That is a
target, never a guarantee, and not proof an agent processed the message.
Persistence does not survive storage failure or power loss, and refusals can stall work until a
backstop notices.

**Who can cause it.** No one in particular — it is the reliability budget of a best-effort local
transport.

**Why it is accepted.** The courier never re-types a delivery that might have happened. The
sender's explicit `tap resend <id>` is the one retry, and it can produce a duplicate. Unconfirmed
mail stays pollable and failures stay visible.

**Owned by.** [Delivery reliability](skills/tap/protocol/delivery/reliability.md).

## What TAP stores and how to delete it

Everything TAP stores is a plain file on this machine. TAP has no telemetry and sends none of
it anywhere.

| Where | What it holds | How long |
|---|---|---|
| `<project>/.tap/bus/payloads/`, `receipts/` | Message bodies and delivery records | Until archived |
| `<project>/.tap/bus/archive/<YYYY-MM>/` | The same messages, moved once they have been settled for 7 days | No expiry |
| `<project>/.tap/bus/input-backups/` | Text you were typing that a delivery cleared (see [above](#a-delivery-can-consume-a-human-draft)) | No expiry |
| `<project>/.tap/bus/permission-requests/<seat>.<time>-<id>.json` | For a Claude Code seat stopped on an approval or a question: the tool's name, the permission mode, the session, the pane, the time and a one-line summary of at most 160 characters (the agent's description of a shell command, a file tool's path, or a question's first question; never a command line, a file body or the tool's input) | Until TAP next observes that seat no longer waiting, or the seat's next request or session start |
| `<project>/.tap/` otherwise | The team roster, its history and delivery queue state | No expiry |
| `~/.tap/debug/recovery/` | Pane contents captured by `tap nudge` and other recovery commands, as shown on screen, without redaction | No expiry |
| `~/.tap/debug/` otherwise | Command and pane recordings, only once debug recording is turned on: by `tap debug on`, by `tap debug trace`, or by the `[debug] always_on` setting | Size-capped; see `tap debug --help` |
| `~/.tap/crew-launch/` | Pending crew launch commands, including configured environment values; private directories (0700) and files (0600) | Unlinked before the harness starts; after a five-minute startup grace, a later crew command reaps exited creators' files, or any pending files older than one day; unsafe or unreadable storage is left untouched |
| `~/Library/Logs/tmux-flight/` (macOS) | Samples of the tmux server, its server logs and incident bundles, only when the optional tmux recorder is enabled. Incident bundles can include process command lines and open-file paths | Samples and logs 14 days, incident bundles 30 days; see the [tmux recorder page](skills/tap/protocol/transport/debug-journal.md#independent-tmux-source) |
| `~/.tap/` otherwise | The index of enrolled projects, the install record, logs and a pinned copy of fzf | No expiry |
| `~/.config/tap/` | Your settings | No expiry |

A background job runs about once a day and moves settled messages into the archive. It moves
them; it does not delete them. Message history, saved drafts and recovery captures have no
expiry today, so anything an agent put in a message, or that was on screen during a recovery,
stays on disk until you remove it.

Message files, delivery records, saved drafts and recovery captures are written readable by
your user only (mode 0600). TAP creates its directories with your default permissions,
usually 0755, so on a shared machine other local users can list file names, which include
seat names and timestamps, but cannot read those files.

To delete:

- `tap doctor --prune-input-backups` deletes every saved draft in the current project.
- `tap out <seat>` deletes that seat's permission-request record, and `tap uninstall` deletes
  every enrolled project's, whichever history choice you make.
- `tap uninstall --history delete` removes TAP and deletes `~/.tap`, `~/.config/tap` and the
  `.tap/` directory of every enrolled project. `--history archive` packs them into a
  `tap-history-<timestamp>.tar.gz` in your home directory instead, and `--history keep`, the
  default, leaves them. If uninstall has to leave an install artifact in place it keeps the
  history too and says so. A project that is no longer enrolled keeps its `.tap/` either way,
  and `~/Library/Logs/tmux-flight/` is not removed.
- No command deletes archived messages, recovery captures or the tmux recorder's logs alone.

## If you need a stronger design

TAP's model is push: a courier types into panes that already trust their local machine. If you
need agent-to-agent communication that does not assume that trust, the design that provides it is
pull-based: every message cryptographically signed, each agent running its own loop that reads new
messages only from an approved source. Signatures carry their weight only when the signing
credentials sit outside the reach of the processes you do not trust: a writer sharing the same
OS account can read or replace keys and configuration alike, so that design also needs separate
accounts or isolated credential storage. That is not what TAP is, and it is not what TAP intends
to become — if your threat model needs it, use a signed, pull-based transport instead.

The [community features page](docs/COMMUNITY-FEATURES.md) lists held additions such as tunable
security levels; it also states plainly that none of them would make TAP a secure messaging
system.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting (Security Advisories) on this repository. Do not open
a public issue and do not email anyone. Include a reproduction with your report: the message or
payload, the command that was run, and what you expected to happen instead.
