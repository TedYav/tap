---
name: in
description: "When the pane, tmux session, or harness session changes or registration is uncertain, register or reconnect the current pane on TAP."
argument-hint: '[handle]'
allowed-tools: 'Bash'
role: maker
---

# /tap:in — register, reconnect, or refresh the bind

```bash
tap in
```

**If this skill was invoked explicitly** — by the user, the lead, or a launcher hook —
treat the invocation itself as a signal: the caller suspects your registration is stale
in a way you may not be able to see from inside the conversation. Any of these can be
true without you knowing:

1. **tmux pane/window id changed** (window moved, pane recreated, tmux reopened manually);
2. **native harness session id changed** (session forks do this silently);
3. **new harness session** entirely (`/new`, `/clear`, native resume outside the launcher);
4. **"just in case"** — a refresh costs one idempotent command.

So never answer with "I was already registered as …" — just run it. `tap in` is
**idempotent when nothing changed** (a one-line reactivation receipt) and **rebinds
automatically when the pane or session did change**: it resolves THIS pane's existing
registry row first, before deriving a handle from the session name, so the same seat
follows you across pane and session churn.

Success is an action-first receipt: `tap register: registered <handle> on team <team>`
(or `reactivated …`). Registration is not a turn boundary — resume the current work.
Unsettled inbound adds one bounded pointer (`N messages waiting; next: tap poll <handle>`).
On a **rebind** — the handle already existed — you get the recap instead, and its counts line
states every bucket including the zeros. `0 unsettled inbound` means nothing is owed: recent
exchanges are history, not a queue, and there is no `tap poll` to run.

## Verify, then the escape hatch

After the bind, `tap whoami` should print the handle you are **supposed** to be (from
the argument, your session name, or your standing brief). On a mismatch — a suffix like
`<handle>-2`, the wrong handle, or unregistered:

```bash
tap in <handle> --force
```

`--force` reclaims your own stale/dead binding — that is its purpose. **Check
`tap team` first**: if the handle's pane is a LIVE teammate, stop — that seat is
occupied, and you may be the fork. Disclose to the lead instead of forcing; a refresh
binds a pane, it does not settle who you are.

- **Pane-less daemon or script:** `tap in <handle> --delivery poll --team <team> [--unattended]`, then send with `--from <handle> --team <team>`.
- **Leave:** `tap out`; use `tap help out` for the available options.

TAP-launched and launcher-resumed sessions are registered before the harness starts, so
an unprompted `tap in` on every session start is unnecessary — but an explicit
invocation always outranks that default.

Derivation/collision rules, the full verb set, and the protocol spec are reference —
load `skills/tap/SKILL.md` or run `tap help register` only if you actually need them.
