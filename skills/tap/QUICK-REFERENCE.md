# TAP quick reference

Exact options and current grammar: `tap help <verb>`. Literal body files are the safe default.

## Identity and inbox

```sh
tap whoami                 # registered handle
tap team                   # current roster
tap teams --details        # machine summary plus diagnostics
tap poll <me>              # unsettled inbound
tap outstanding <me>       # sends awaiting settlement
tap read <id>              # read an ask; read+settle a note
```

An `ask` needs `tap reply`; a `note` is settled by `tap read` and gets no got-it reply. Keep `<team>/` on a foreign id when reading or replying.

## Four speech acts

```sh
tap send <to> -f note.md       # note; no answer wanted
tap assign <to> -f order.md    # work; answer required
tap reply <id> -f answer.md    # answer and settle
tap escalate -f question.md    # question for the user
```

Cross-team targets are `<team>/<handle>`. Use `-f - <<'EOF'` for literal stdin. A placement, queued receipt, or pane submission does not prove recipient processing; settlement is separate.

Quoted-heredoc alternatives are pasteable when a draft file would add no value:

```sh
tap send <to> -f - <<'EOF'
literal note
EOF
tap reply <id> -f - <<'EOF'
literal answer
EOF
tap escalate -f - <<'EOF'
literal user question
EOF
```

## Choose a seat

```sh
tap ask <preset|harness> -f prompt.md          # one bounded fresh answer
tap crew add <model-bearing-preset> [name]     # short-lived consult via a preset
tap crew add <harness> [name] --model <model>  # or select the launch model directly
tap session launch <preset|harness> [name]     # durable restartable seat
tap presets                                    # available launch choices
```

## Reminders

```sh
tap remind me --in 8m -f wake.md
tap remind list --json
tap remind cancel <id>
```

Command completion:

```sh
tap remind me --when-done '<cmd>' \
  --circle-back 30m --fallback <seat> -f wake.md
```

`--to <seat>` redirects notifications. Fallback must be registered and different from that notification target. Exit 0 is done; nonzero or signal is failed; `--unobservable-exit N` maps only that exit to UNOBSERVABLE. Three consecutive unacknowledged or undeliverable circle-backs trigger one fallback notice and stop periodic wakes; the terminal wake goes to the original target and fallback. `cancel` stops notices but leaves the child running. `tap remind kill <id>` explicitly kills the still-owned child process group. There is no implicit timeout or cleanup.

## Recovery and inspection

```sh
tap show <id>              # read-only payload view
tap provenance <id>        # sender and receipt provenance
tap nudge <seat>           # retry one stuck sentinel
tap doctor                 # bus integrity
tap health --json          # liveness and attention state
tap draft --list           # retained clobbered drafts
```

Do not replay an action after an uncertain effect. Observe receipts and recipient state first.

## Team lifecycle

```sh
tap attach <handle|team/handle>   # bare handle: this team, else the one team that has it (several: pick <team>/<handle>)
tap team down [--only h1,h2]
tap team up [--only h1,h2]
tap team reset --dry-run
tap team restore --archive <id>
```

Reset checkpoints state before reinitializing. Restore returns rows suspended; `team up` resumes them. Use `tap help team` for exact selectors and boundaries.

## Keep work moving

After sending or replying, continue independent work. Never sleep or loop-poll. Before yielding, recheck inbound work and run `tap outstanding <me>`.
