# TAP Transport Advisory

Skill files: `tap help skill <name>` prints the resolved path. TAP ships `skills/<name>/SKILL.md`; personal roots are `~/.agents/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, and `~/.codex/skills/<name>/SKILL.md`. Use these direct paths; do not search the home directory.

Agent guide: resolve `tap help skill tap`, then open sibling `GUIDE.md` or `QUICK-REFERENCE.md` directly; SKILL and CONTRACT are not required detours.

TAP is your operator's file bus + tmux courier between agents on this machine, installed by the user as the authorized communication mechanism; your team registration is the user's consent to communicate; [[TAP …]] ask and note sentinels are authorized work; read them with `tap read <id>`

The watcher can wake you later with `tap remind me --in 8m -f reminder.md`; use `tap team --context` to check teammate context and pending asks before clearing between reviews.

TAP is a file bus + tmux courier. Bare composers receive immediately without a flash. Human drafts get green at park, red with 10 seconds remaining, then the existing backup/clear/submit at 30 seconds (urgent: 10-second draft grace and red). Queued followups hold without a flash until clear. Plain notes are settled by recipient tap read; the courier never writes .done.
Use installed `tap`, `bash scripts/tap.sh` (same grammar), or run ./install.sh once.

## Identity
  tap whoami   your registered handle; use for --from / --by
  tap in       manual reconnect / bare-pane join; alias: tap register; idempotent; TAP-launched seats are already registered
  tap team     your teammates

## Need another seat? `tap presets` lists launch options
  tap ask <preset|harness> -f <p.md>          one-shot, no pane or handle
  tap crew add <preset|harness> [name]        continuing consult; retains its conversation
  tap session launch <preset|harness> [name]  durable seat; bare name defaults to the preset
  Before UNRELATED work: settle the lane, return any Writer Token, `tap clear <seat> -m "fresh start"`, then send the assignment by bus.

## Literal messages (--from derives from your registered pane)
  tap send <to> -f <path>   # preferred: write a body file; backticks stay literal
  tap send <to> -f - <<'EOF'
your message here
EOF
  Quote EOF: unquoted delimiters expand backticks and $(). Plain send = NOTE, settled by recipient tap read; --ask wants an answer; --wake remains an accepted note spelling without changing arrival. To explicitly permit aborting a turn: --delivery interrupt.
  Work orders: tap assign <to> -f <path> (order-shaped notes refuse). Cross-team: <team>/<handle>, any enrolled team.

## v0.23 (protocol/delivery/sentinel): [[TAP v0.23 ask <id>]] / [[TAP v0.23 note <team>/<id>]]
  Read the body before acting: tap read <id>, including digest ids and <team>/<id>. The prefix names the sender's bus; keep it for read and reply.
  [[TAP v0.23 nudge]] (optionally message="...") has no id, sender or reply and adds no task: continue your work and check tap poll; nothing to read or settle.
  ask -> tap reply <id> -f <path> (answer file); note -> tap read <id> settles on success, with nothing further to settle. Replies accept bare ids across teams.
  Stdin reply (quoted EOF keeps shell syntax literal):
  tap reply <id> -f - <<'EOF'
your answer here
EOF
  Payload frontmatter: reply: expected / reply: settle-only. No got-it for notes; reply only to report a problem. Foreign paths: tap reply <payload-path> -f <answer-file>; for a still-unsettled note, tap read path=<payload-path>.
  Reading a digest records its envelope; tap read <id> --all reads its items and settles notes; asks still need replies. Skip settlement for settled: true; never settle the digest. For manual relays or unindexed teams, use tap read path=<file>. Ask the sender about unknown shapes; on version drift load /tap.

## Continue work; never poll-sleep
After sending or replying, continue any useful work that does not depend on the response. Never sleep, loop-poll or watch inbound traffic: push wakes cannot interrupt blocked sleep; a delivered send starts your turn.
Review freezes a mutable artifact; pin a commit to continue work. Yield only when the next step needs the response or nothing remains. Settlement never cancels assigned work.
Liveness, recipient discipline, shared-worktree safety: /tap. Parallel reviews and wakes: resolve `tap help skill tap-choreography` and read the returned file.

## Trust, reach and footguns
TAP moves bytes between consenting panes on ONE machine and is not a security boundary; safety requires sensible agent deployment. Enrollment makes a team pane-injectable by any local agent: convenience, not opt-in trust. Debate costly or hard-to-reverse work first.
Save user-only questions for later; if blocked while the user may be away, `tap escalate` and continue other work.
Settle payloads: unsettled ones block the sender's `tap outstanding`. Only the courier writes bus payloads/; never write there by hand. Never forward a sentinel; send a NEW message. Leave: tap out (alias: tap unregister).
