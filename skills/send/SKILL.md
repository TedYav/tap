---
user-invocable: false
name: send
description: "When messaging a TAP seat: tap send is a note, tap send --ask is a question owed a reply, tap assign is a work order."
argument-hint: "<to> -f <path>"
allowed-tools: 'Bash, Write'
role: maker
---

# /tap:send — message a teammate

Use the harness's native file-writing tool to create the body at an explicit
repository-local path, for example `tmp/<seat>/<request-id>-send.md`. Replace
both placeholders; choose a fresh request id or unique suffix for each body,
and pass that same path:

```bash
tap send <to> -f tmp/<seat>/<request-id>-send.md
```

A question to a teammate is `tap send <to> --ask -f <path>`; `tap ask` is a
one-shot headless run that no seat receives.

Backticks and `$()` stay literal because the composing shell never sees the body
text. You choose the unique path: a file-writing tool does not allocate one or
inherit a shell's `mktemp` variable. A seat directory alone does not distinguish
concurrent requests.

For intentionally computed shell values, keep the values as separately quoted
arguments and the format literal:

```bash
body="$(mktemp)"
printf '%s at %s\n' "$summary" "$timestamp" > "$body"
tap send <to> -f "$body"
rm -f "$body"
```

For stdin without a draft file, use a **quoted** heredoc:

```bash
tap send <to> -f - <<'EOF'
your message here
EOF
```

The quotes on `EOF` are load-bearing — an unquoted delimiter expands backticks.
Double-quoted here-strings (`<<< "..."`) also expand backticks and `$()`; use the file-first or quoted-heredoc recipe for literal prose.
A positional file has a different contract: it is a complete payload
that may include frontmatter. `-m` remains available for short shell-safe text.

`--from` derives from your registered pane. The courier canonicalizes the payload and writes it to your bus. A plain send is `reply=settle-only`; `--ask` requests a reply (arrival follows the composer state). Cross-team teammate: address them `<team>/<handle>`. A pane-less sender adds `--from <handle> --team <team>` to the same `-f <path>` form.

**THE GOLDEN RULE:** after sending, continue any useful work that does not depend on the response. Never `sleep` or poll for it; the peer's reply auto-submits into your pane and wakes you. Yield only when the next useful step depends on that response or nothing else remains. Between chunks of your own work, run `tap outstanding <your-handle>` (a pane-less sender adds `--team <team>`).

**Plain notes are recipient-settled.** `tap read` settles a note; `--ask` requests a reply. Work orders use `tap assign <to> -f <path>`, which stamps `reply=expected` and `kind=order`. A plain send that reads like a work order is refused. `--fyi` and `--wake` remain accepted note spellings and do not bypass that guard.

A bare composer receives the message immediately without a flash. A human draft gets one 30-second grace: green at park, red with 10 seconds remaining, then the existing backup/clear/submit path; urgent drafts get zero grace and immediate red. A queued-followup list holds delivery without a flash until it clears. Existing queued siblings can still coalesce. The courier never marks messages read, including old queued notes. Reading a digest records its envelope separately; read the items individually or with `--all`.

`--delivery interrupt` explicitly permits aborting the recipient's current turn
or tool call; `--urgent` is its exact alias. Important content and `kind=escalate`
do not grant that permission. Interrupt receipts disclose possible cancellation
and goal pause through `tap read` and `tap show`; TAP cannot identify the cancelled
work. A visible draft snapshot cannot restore a running turn or tool call.

Flags & exit codes (`--kind`, `--id`, `--pane`, `--cross-worktree`; 0 accepted as injected or queued / 3 pane-gone / 5 submit-unverified / 1 refusal or usage; send rc4 is retired) are reference — `tap help send` or `skills/tap/SKILL.md`.
