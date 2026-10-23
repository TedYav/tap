# Experimental shared OpenCode service

Private OpenCode 2 servers remain the default. To opt new durable seats into the native local service, set this in TAP's `config.toml`:

```toml
[experimental]
opencode_shared_server = true
```

The launch recipe records the mode. Existing private seats stay private after a config change; shared seats stay shared on resume. Shared crews are deferred (tap-yej55); use private crews. Explicit `--server` and `--standalone` settings conflict with shared mode and refuse.

The launcher adopts an existing service only after verifying its local registration, process birth, version and active `tap.session-start` and `tap.tmux-guard` plugins for the launch directory. If no registration exists, native OpenCode starts the service with inherited harness, pane and TAP identity pins removed. TAP never restarts an existing service to load plugins. Missing plugins require an operator-chosen service restart before launch.

Session preparation validates requested model/variant and creates the exact native session. Shared preparation failure refuses, including untuned launches. Native resumes retain their model and variant. The launcher opens the TUI with the prepared `--session` and activates the row only after observing that TUI under the recorded pane, verifying the same service generation and installing its per-session environment. Both initial binding and in-pane replacement use this proof under their existing registry/nonce custody. Activation needs no model prompt. The shared plugin waits boundedly for activation and emits context through native synthetic messages, deduped per root session. It never invokes `tap in` or writes approval-timeout evidence using the service's inherited pane.

## Caller identity

Every OpenCode server stops the physical pane ancestry walk, except a proven private `serve --stdio` child of its TUI. A shared caller cannot borrow the service's launching terminal.

The separate identity resolver requires the registered service in the caller's process ancestry. It matches the direct child below that service to exactly one running native shell record by PID, birth time and session metadata, then follows native parent session IDs to the root. It rechecks service and process generations. A short process-local cache may retain the native shell relationship for 250 ms; live process/service evidence and registry/pane checks still run on every resolution.

Exactly one active, non-launching pane row across the machine index must claim that native root and service generation. The resolver verifies its seat instance, pane, session, tmux generation and socket before returning. Root tools must carry their TUI's matching pane/socket environment. Native child sessions lack that environment; their attested parent chain permits deriving the root row's pins. Missing or ambiguous evidence refuses; cwd and session environment variables alone never establish identity. An inherited `TAP_SELF` must agree with the verified seat when used; explicit actor flags retain their declared semantics.

Activation and derived child environments pin the existing lock root alongside the seat's bus, so parent and child operations share the same locks. The compatibility pane projection omits the identity resolver's `state` tag; verified shared callers retain seat-selection claims so a successor instance cannot inherit an earlier observation.

MCP, LSP, plugin and persistent-PTY subprocesses have no native shell witness and gain no implicit identity. Use OpenCode's shell tool. Shared `tap in` refuses: restore the binding with a launcher relaunch from another pane. Attach still uses physical terminal observation. Poll seats gain no new identity route.

This is a same-user coordination contract, not a security sandbox. A process with the native service credential can address another session's API, just as a same-user process can send input to another tmux pane. Native API records and process ancestry are explicit identity authorities; the session environment is only a hint.

## Stop, replacement and recovery

Before a TAP-owned destructive pane operation, TAP interrupts the recorded native root and descendants with resume disabled, removes their remaining background shells through the native API and confirms quiescence. Another seat's native work and the service remain running. Unobservable work refuses the pane operation. A positively absent old service process, or a different birth at its old PID, proves that generation is gone.

Only `tap down <seat> --skip-quiesce` can stop a shared pane without confirmed native quiescence. It first records the native session/service generation and recovery action under `.tap/opencode-unquiesced/`, retains the suspended row and holds its worktree against reaping. Retirement and replacement refuse while that receipt remains. After the session is idle or the service has been deliberately restarted, repeat ordinary `tap down <seat>` to recheck and clear the receipt. The escape is invalid for private seats and is not inherited by team operations.

A shared seat cannot stop or replace itself from its running shell tool: native interruption would kill the TAP command before it completes. Run the operation from another pane. A team operation that includes its shared caller refuses before changing any selected member; exclude that caller where supported. Detached shared self-stop is deferred (tap-3svxg).

Team stops validate caller identity and the registry before the shared self-stop guard. Existing identity and registry refusal classes retain their remedies; an absent registry still takes the empty-roster path. The guard uses that validated registry snapshot and runs before queue, watch or pane effects.

If launch rollback cannot quiesce a prepared session, it retires the launch token, parks its own row as suspended/unquiesced and retains the pane. The failure names the remaining native session, the worktree hold and the same explicit `down` recovery. Rollback does not inherit permission to skip quiescence. A failure before native preparation completes needs no native stop and uses ordinary cleanup.

Quiescence holds the existing registry lock for up to its eight-second observation budget, plus bounded API calls. Shared context waits up to four seconds for activation; if activation takes longer, that first turn can lack TAP context and a later prompt retries admission. Neither timeout can activate a row.

Installer sync never restarts a service. After upgrading OpenCode or its TAP plugins, restart the service at a chosen interruption point and relaunch affected shared seats to re-attest their bindings. Service restart invalidates old identity until that explicit operation succeeds. Manual tmux kills are outside TAP's stop transaction and may leave native work running.
