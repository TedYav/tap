---
title: OpenCode 2 plugins run in a server process, not in the pane's TUI
date: 2026-10-21
category: integration-issues
module: hooks/tap-opencode-session-start.ts, runtime/bun/src/launcher (OpenCode 2 port)
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "every TAP plugin fails to load on OpenCode 2 with: Plugin must export a default definition with an id and an effect or setup function"
  - "a plugin that reads TMUX_PANE, process.argv or process.pid sees another process's values"
  - "TAP context reaches the model only on a later turn, or a model-only launch refuses because the session reports variant default"
  - "a launched seat's first model request says it is not registered, though tap whoami resolves it later"
root_cause: wrong_api
resolution_type: code_fix
framework_version: opencode 2.1.2
retire_when: "OpenCode ships a plugin context that names the client (pane, argv, pid) or runs plugins in the client process; check the release notes and packages/cli/src/services/server-connection.ts"
tags: [opencode, plugin, client-server, standalone, session-identity, tmux, model-variant]
related_components: [transport]
---

# OpenCode 2 plugins run in a server process, not in the pane's TUI

## Problem

OpenCode 2 moved plugins out of the terminal UI and into a server process. A plugin's
environment, arguments and process id now describe that server, and by default one server
serves every OpenCode window the user has open. Code that learned "which pane am I in"
from its own process breaks, and it can be wrong without failing.

## Symptoms

- On 2.x the 1.x plugins do not load at all: OpenCode reports `Plugin must export a default
  definition with an id and an effect or setup function.`
- After a mechanical port, a plugin that reads `TMUX_PANE` can bind the session to whichever
  pane first started the shared server.
- The session id is not in the plugin's `process.argv`, so binding at startup never fires.
- A context block posted at startup reaches the model a turn late.

## What didn't work

- **Porting the factory shape alone.** Switching the default export to `{ id, setup }`
  makes the plugin load, but the pane, argv and pid it reads still belong to a process that is
  not the pane's.
- **Carrying 1.x response habits.** The in-process `ctx.session.get()` returns the session
  itself, while the generated HTTP client's model listing returns `{ location, data }`. A port
  that destructured `{ data }` from `session.get` read `undefined` and silently skipped every
  bind. Stub tests passed because the stub returned the 1.x shape. The 2.x type definitions
  were right all along; hand-written casts hid the mismatch.
- **Session metadata as the dedupe store.** A metadata update replaces the whole metadata
  object, so a read-modify-write can erase keys other plugins own.
- **Setting the model with a TUI flag or a config override.** The 2.x root TUI has no
  `--model` or `--fork` flag. TAP prepares the requested model and variant through the native
  session API, then opens that session. Config defaults do not give the same per-launch
  control, and TAP does not edit the user's config to get it.

## Solution

**By default, pin a private server per window.**
- `opencode --standalone` starts its own `opencode serve --stdio --port 0` as a child, and
  that child inherits the window's environment (upstream OpenCode v2.1.2 source, `packages/cli/src/services/standalone.ts`, not a TAP path).
- The default, without the flag, connects to the user's background `opencode serve --service`.
- TAP adds `--standalone` to every private-mode OpenCode launch (`runtime/bun/src/launcher/invocation.ts:67`).
  Private mode is the default. The experimental shared mode below omits the flag.
- The plugin binds only when its own command line is `serve --stdio` without `--service`, and
  its parent is an OpenCode TUI (`hooks/tap-opencode-session-start.ts:50-62`).
- In the shared service the plugin never binds; a wrong-pane bind is worse than no bind.

**Read the session id from the parent.** The server child's argv has no `--session`; the TUI
that spawned it does. The plugin reads its parent's arguments and still checks the id through
`session.get`: it must be a root session in the plugin's own directory before it binds.

**Create the session before the TUI opens.** TAP calls `opencode api --standalone` to:
1. check the model and variant against `GET /api/model`;
2. create the session with `POST /api/session` (`runtime/bun/src/launcher/opencode-prepare.ts:48-68`);
3. open the TUI with `--session <id>`.

Facts the 2.1.2 API forced:
- the location goes in a nested query key, `location[directory]`;
- a model's `variants` is an array;
- a session created without a variant stores `"default"`, so compare `variant ?? "default"`.

**Read context only after the launcher activates the seat.** Admitting context before the first
request is not enough: the context must also describe a registered seat. The first port admitted
the TAP block on time, but the block in the captured 2.1.2 first request said the seat was not
registered. The plugin read context right after its bind, while the launcher still held the row as
launching. The launcher could not activate any sooner. Its OpenCode readiness signal was the
painted composer, and the TUI does not paint until plugin setup returns. So the launcher activated
only when its full startup window expired.

Two changes break that dependency:
- The launcher accepts this launch's bind as readiness, the same signal Claude seats use. The bind
  must carry this launch's token and the exact prepared session id, and the row's fingerprint must
  move from the snapshot taken before the pane respawned. The usual survival settle still runs
  before activation (`runtime/bun/src/launcher/transaction.ts:864-910`).
- The plugin's context producer, `session-start.ts context-private <session> <root>`, only reads.
  It waits up to 4 seconds for an active row with no pending launch or clear token, this launch's
  witness, the exact native session, and the caller's live pane, session and server generation
  (`runtime/bun/src/session-start.ts:366-395`). On timeout or rollback it emits nothing and never
  activates the row.

Captured 2.1.2 first requests now carry the registered block. Two paths can still deliver context
on a later model step or turn:
- a bind that outlives the 5-second startup guard, which releases startup but still surfaces
  context on late success (`hooks/tap-opencode-session-start.ts:428-449`);
- the untuned preparation fallback, which launches without a prepared session
  (`runtime/bun/src/launcher/opencode-prepare.ts:79`).

**Admit context through the session inbox, and dedupe in plugin storage.**
`ctx.session.synthetic({ resume: false, delivery: "steer" })` queues the text. It joins the
conversation at the next model step and never starts a turn of its own. Title generation keys
on the first `user` message, so a synthetic message cannot suppress the title.
- Dedupe lives in `ctx.storage` under a per-session key, so one plugin cannot erase another's state.
- A deterministic message id derived from the session id, the previous admission and the text
  makes a retry after a failed storage write a no-op (`hooks/tap-opencode-session-start.ts:357-360`).

**Treat a session as bound to its directory.** The plugin binds only a session in its own
directory, so moving a seat with `relaunch --workdir` would replace a working seat with one
that can never register. The relaunch now refuses unless the stored session's directory
matches the target (`runtime/bun/src/launcher/relaunch-durable.ts:120`).

**Opt-in shared service: attest the shell, not its environment.** An experimental mode lets
durable seats share the user's native service. This page once said that a shared service offers
no client-specific identity channel. That holds for plugins, but not for shell tools:
- Each TUI sends its terminal environment to the session it is showing, with
  `PUT /api/session/:sessionID/environment`.
  - The service keeps that environment in an in-memory per-session map.
  - The shell tool starts its commands with it instead of the service's environment (upstream
    `packages/core/src/session/environment.ts` and `packages/core/src/shell.ts`).
- That environment is still only a hint, for three reasons:
  - the TUI sends it again whenever it opens a session, so opening another session overwrites
    that session's copy;
  - native child sessions do not inherit their parent's per-session environment, so unless a
    client sets one for the child itself, their shells run with the service's environment;
  - a command can rewrite its own environment with `exec env`.
- TAP takes identity from records the service itself reports
  (`runtime/bun/src/opencode-shared.ts:45-99`).
  - It finds the service in the caller's process ancestry and takes the process directly below it.
  - It then requires exactly one running native shell record with that process id, a start time
    inside a short window around the process's birth, and session metadata equal to the hint.
  - It follows the parent ids the service reports up to the root session.
  - A registered pane row must still claim that root, and a root shell's pane environment must
    match the row.
- In shared mode the plugin never binds. It only reads context for a seat the launcher has
  already activated.
- A cold location activates its plugins asynchronously, and until then `GET /api/plugin` can
  return an empty list. Before it checks plugins, the launcher requests the model catalog, which
  waits for activation. It then requires both TAP plugins to be active
  (`runtime/bun/src/launcher/opencode-shared-service.ts:25-33`).

The normative contract, including stop and recovery, is in
`skills/tap/protocol/identity/opencode-shared.md`.

## Why this works

Plugins execute in the server. A shared service's process state cannot identify each connected
pane. TAP therefore supplies pane identity through two sources:
- a private child's inherited environment, for `TMUX_PANE`;
- the TUI parent's selected session, for the session id.

In private mode, refusing the shared service turns "possibly another pane's identity" into "no identity," which
TAP already handles. Creating the session through the API makes it possible to admit context
before the first prompt, instead of racing it.

## Prevention

- **Use live-binary probes alongside typed fixtures and review.** No single method found every
  defect:
  - sandboxed probes on OpenCode 2.1.2 exposed the response envelope, the nested location key,
    the variant-array shape and the default-variant behavior;
  - code review then found the relaunch directory mismatch, and a regression test proved that it
    refuses before any process or registry effect.
- **Assert what the context says, not only that it arrived.** The first port's probe showed a
  TAP block in the first request and passed while that block said "not registered". The
  regression probe asserts that the first request carries the registered line and lacks the
  unregistered one.
- **Keep "bound" separate from "context delivered".** One draft of the fix marked a session bound
  only after its context landed. Any delivery failure would then re-run `tap in`: a producer
  timeout, a failed synthetic post, or a missing producer. The seat's registry row would be
  rewritten once a minute although it had already registered. The plugin records the bind when
  `tap in` succeeds, and a later prompt retries only the read-only context step
  (`hooks/tap-opencode-session-start.ts:336`, `:374-378`, `:432`).
- **Type plugins against the published package.** Pin `@opencode/plugin` as a dev dependency
  and include the hook files in a checked tsconfig. Casts are how 1.x shapes survived.
- **Read the store by sequence, and end turns on the idle marker.** OpenCode 2 stores sessions
  in `session_v2` and messages in `session_message`, ordered by `seq`. A finished turn ends
  with a row of type `idle`, not with the last assistant message
  (`runtime/bun/src/readiness-stall.ts:171`).
- **Isolate probes from the shared service.** A probe that keeps a real `HOME` and omits
  `--standalone` attaches to the user's running service and loads their plugins. Use
  `--standalone` and a private `XDG_DATA_HOME`, and show the sandboxed database path in the
  evidence.
- **Budget memory for private servers.** Measured on 2.1.2, with no MCP or LSP servers configured:
  - one idle seat, the TUI plus its server, measured 461 MiB;
  - two seats measured 1.0 GiB in total, both idle and after one turn each.
  RSS varies run to run.
  A later same-workload comparison included shared mode:
  - one idle shared seat cost more than one private seat, 694 MiB against 568 MiB;
  - a second idle seat added about 207 MiB in shared mode and about 562 MiB in private mode;
  - samples taken after tool use showed no general memory or CPU advantage.

  Shared mode therefore stays an experimental opt-in.
