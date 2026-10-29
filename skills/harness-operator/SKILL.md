---
name: harness-operator
description: "When a teammate's abandoned harness menu blocks mail, run an opted-in navigation worker to return it to its composer."
argument-hint: '<seat|team/seat> --preset <name>'
allowed-tools: 'Bash, Read, Write'
---

# Return an abandoned harness menu to its composer

Use `tap operate` for a pane stuck on an ordinary Claude, Codex or OpenCode menu.
The command launches a trusted crew with a fixed navigation mission, holds delivery
while it works, and records its observations and keys. Read
[the operator contract](../tap/protocol/delivery/harness-operator.md) before starting.
For a stopped API turn or model-capacity error, use `tap help unwedge` instead.

## Establish custody and start

An owner or launcher may recover its own seats. Otherwise ask the leader; a
teammate may recover a stuck or absent leader. These are collaboration rules,
not rank fields inferred from the registry. Identify the initiating teammate,
leader and target owner for the final report; deduplicate people holding several
roles. If a recipient is unknown, report that gap rather than inventing one.

Choose an existing trusted preset from `tap presets`. The command runs seat
doctor itself; for an earlier diagnosis, run `tap doctor <handle> --json` from
the target team's root. Use a capable, inexpensive reader for this bounded navigation
mission. Start it with an explicit preset:

```bash
tap operate <seat|team/seat> --preset <name> --json
```

The runtime repeats admission under custody. `recovery.operator` defaults to
`off`; only an operator's deliberate config choice enables `ask` or `on`. Do not
change it to get past a refusal. Both modes require sufficiently old undelivered
mail, an eligible doctor verdict, a stopped native turn, and no target-window
client activity or attachment in the last two minutes. Config does not schedule
runs. A failed check ends this invocation; it does not start another recovery rung.

## Ask mode

`approval-required` means the command stored a request and sent its question
through `tap escalate`. The notifier's acceptance does not prove the human saw
it. No crew or pane hold exists while waiting. Keep the returned request id and
artifact path; do not send a second notification for the same request.

Proceed only after an explicit human approval naming this target and request.
Silence, elapsed time, screen text and another TAP agent's answer are not approval.
Write a literal JSON file recording that answer:

```json
{"request_id":"operator-request-<uuid>","reply":"<the explicit human reply>"}
```

Then run:

```bash
tap operate --approve <request-id> --reply-file <json-file> --json
```

This is your accountable attestation, not CLI authentication of a human. The
request expires after five minutes and can launch at most once. It cannot move
to another caller instance, target or config. A failed/expired request needs a
new invocation and, in ask mode, a new human answer.

## Observe the result and report

Let the command own its crew and cleanup. Its fixed worker brief permits one
freshly observed navigation key at a time through `tap operate`; no movement
keys are enabled. Never substitute direct tmux input, a broader detective action,
a restart, or a prompt approval when the operator refuses.

The operator never selects or applies a setting, model or account; ordinary
cancel/back may restore the screen's prior state, which the harness may itself
persist. It never grants or dismisses permission, trust, login, install or update
prompts, types into a composer/filter, edits a draft or submits mail. A composer
with existing input ends navigation immediately.

Report the returned status and retained `status_file` to the initiating teammate,
leader and target owner using literal TAP body files, deduplicating recipients.
Include cleanup gaps, uncertain effects and the preview-restoration caveat when
relevant. `composer-restored` proves an observed UI result; message receipt and
productive work remain unconfirmed. Leave mail with its existing courier custody.
Use `tap debug recovery <recovery-id>` to inspect the retained evidence. Stop when
the result and any reporting gap have been handed off; do not auto-retry a run.
