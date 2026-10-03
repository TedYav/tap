# Transport and migration

Details for [/tap](../SKILL.md). Paths beginning `skills/` or `docs/` are relative to the TAP checkout.

## Transport mechanics

- **Independent work follows delivery.** Replies auto-submit and wake the recipient. The transport
  therefore leaves useful independent work running rather than polling or sleeping; after settlement,
  the payload body is re-read and its assigned work is completed or status-reported.
- **Settlement is the acknowledgement.** An acknowledgement-only payload creates a second mechanical
  receipt loop; `tap read` already records note settlement.
- **Nudge once, then escalate.** `tap nudge <peer>` recovers a stuck sentinel. One nudge and one
  retry without progress indicate the LEADER or human needs the situation, since a dark agent can be
  wedged for cause.
- **`tap outstanding <you>` exposes owed supervision or handoff** before a seat idles.
- **`accepted, injected` means the sentinel left the input band — not that a turn began.** `.placed`
  and `.sent` are claims the SENDING process makes about what it did, and `.sent` is the stronger of
  the two. `.done` is not one of them: **settlement is recipient-gated** — `tap read <id> --by <me>`
  writes `.done` only if the payload's `to == me` (`skills/tap/protocol/transport/bus-layout-under-tap-home-part-02.md`), so it is the one receipt a
  sender cannot write about their own message, and the only one whose existence is evidence about the
  recipient rather than about the courier. So an injected send is stamped `turn=unconfirmed`, always,
  on every harness:
  *submitted to pane; recipient seat-side processing unverified.* No harness in the fleet exposes a
  post-submit turn-boundary token, so nothing weaker than a reply proves the peer read anything.
  Read a silent peer as unproven rather than delivered, and recover the way TAP already expects —
  `tap nudge`, a follow-up send, or telling them to `cat` the payload path, which bypasses injection
  entirely. On 2026-08-19 four sends to one seat carried `.placed` AND `.sent` while a pane capture
  found no trace of any of them; both halves of the transport's evidence said success, and the
  reviewers' silence read as "he is busy," which he demonstrably was.
- **Slash commands injected into a peer pane need a second Enter.** One Enter leaves `/clear`,
  `/compact`, or `/goal` sitting in the input box: the two-Enter trap.
- **Write the body to a file, then pass `-f <path>`.** SHOULD: use the harness Write tool (or
  `printf`/python) to create the file, then `tap send <to> -f <path>`. Backticks and `$()` stay
  literal by construction — the composing shell never sees the body text. `-m` remains available
  for short shell-safe text. The positional file form is different: it represents a complete
  payload that may include frontmatter.
- **For stdin without a draft file**, use a **quoted** heredoc through `-f -`:

```bash
tap send glm --ask -f - <<'EOF'
{"op":"transition","item_id":"F1","new_status":"accepted"}
EOF
```

- **The protection is the QUOTING, not the token.** `<<'EOF'` — quoted, as `CONTRACT.md` presents it
  — is the reliable protection for the heredoc path. An *unquoted* `<<EOF`
  expands backticks and `$()` in the body before `tap` sees a byte, which is the tap-9sjp / tap-psif
  class arriving through the heredoc instead of through `-m`.

- **Change the terminator only when the body itself contains a bare `EOF` line.** That is a narrow
  case and not the general rule: a quoted heredoc is terminated by its delimiter appearing alone on a
  line whatever the quoting, so a body *about* heredocs can close its own — one did on 2026-08-27, and
  the shell then read the remaining prose as commands. When you are writing that kind of body, pick a
  terminator the text cannot contain; otherwise keep `<<'EOF'` and stay consistent with the contract.

- **The `-` spelling is per-tool, and two of ours disagree.** `bd create --body-file -` reads stdin;
  `bd comments add -f -` treats `-` as **a literal path**, so stdin is not read. (`bd comments add`'s
  own help documents `-f` only as "Read comment text from file".) What that produces was not observed
  here and is not asserted: it depends on whether a file named `-` exists in the working directory —
  an open error if not, that file's contents if so. Either way it is not your piped text. Pass a real
  path.

- **After resolving a conflict in a body file, re-read the marker boundaries.** Taking one side of a
  conflict hunk can swallow the newline at the boundary and silently join two lines — which, in a
  file whose whole purpose is to be sent literally, ships as a malformed body rather than as a
  rejected patch.

  *(These are the 2026-09-02 compost harvest of an unmerged PR (head `dac6c5148`); bead
  `tap-4eyx5` holds its runtime residue.)*

## Live-bus migration sequence

**Hard sequence — live-bus migration.** A TAP-changing run treats its live bus as the communication
channel, while tests use temporary `TAP_HOME`; ordinary work never resets or migrates that bus
mid-run. When migration itself is the deliverable, the sequence is fixed:

1. Schedule it after every wave has settled.
2. Quiesce on observable state: `outstanding` and `poll` are empty for every handle.
3. Send one freeze notice. It is the sole permitted pre-migration send; its own unsettled receipt is
   the accepted exception.
4. Migrate.
5. Let poll self-healing catch anything that raced the move, then resume traffic.
