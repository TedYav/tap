// `tap whoami [--pane <target>] [--team <team>] [--verbose] [--json]`
//
// Resolution is OBSERVATIONAL: the pane's id is matched against the registry, so
// a seat auto-suffixed at registration learns its REAL handle instead of
// impersonating the incumbent in --from or in a settlement.
//
// Exit: 0 resolved | 1 usage / not in tmux | 2 pane not registered.

import { TapError, callerObservationReason, displayCwd, observeCallerIdentity, observeHarnessSessionPane, observeIdentityPane, resolveContext, resolveSelf, observeSelfPane, refuseUnanchoredPane, type ResolvedContext, type IdentityPaneObservation } from "../context";
import { missingLocalTeam } from "../onboarding";
import { LAUNCH_TEAM, noTeamMessage } from "../first-run";
import { NO_MACHINE_INDEX } from "../selector";
import { ensureAscii } from "../fsatomic";
import { isOldStoreRefusal } from "../register-authority";

export function cmdWhoami(argv: string[]): number {
  let pane: string | IdentityPaneObservation = "";
  let ctx: ResolvedContext | undefined;
  let verbose = false;
  let json = false;
  let team: string | undefined;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--pane") {
        // `--pane` REQUIRES a value. The incumbent enforced this with
        // `${2:?--pane needs a value}`, and until this closure the router's
        // VALUE_OPTIONS row kept the operand-less form on Bash -- so native
        // never had to. Removing that row makes this the only door, and
        // `argv[++i] ?? ""` would have read a missing operand as "no --pane at
        // all" and silently resolved the CALLER's pane instead of refusing.
        // Answering a different question than the one asked, with authority.
        const value = argv[++i];
        if (value === undefined || value === "") {
          throw new TapError(1, "usage_error", "tap help whoami", "--pane needs a value");
        }
        pane = value;
      }
      else if (a === "--team") {
        const value = argv[++i];
        if (!value || value.startsWith("--")) throw new TapError(1, "usage_error", "tap help whoami", "--team needs a value");
        team = value;
      }
      else if (a === "--verbose") verbose = true;
      else if (a === "--json") json = true;
      else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help whoami", `unknown option '${a}'`);
      else throw new TapError(1, "usage_error", "tap help whoami", `unexpected arg '${a}'`);
    }

    if (!pane) {
      // ONE observation, projected here rather than through `callingPane()`.
      //
      // The incumbent named WHY the caller pane could not be observed:
      // `caller pane is not observable (${TAP_CALLING_PANE_REFUSAL}; pass
      // --pane <tmux-target>)`. Native carried a fixed sentence instead, so
      // "no tmux server is running" and "your tty maps to two panes" arrived
      // as the same line -- and they have different remedies.
      // `observeCallerIdentity` was built to supply that string; this is its
      // first consumer.
      //
      // Projecting inline is deliberate: calling `callingPane()` and then
      // `observeCallerIdentity()` for the refusal would be a SECOND walk of the
      // process ancestry, and tap-316wj is the bead for exactly that -- two
      // observations of a racing world can disagree, and the second one would
      // be the one that names the reason for the first one's answer.
      const seen = observeCallerIdentity();
      if (seen.state === "inside") {
        pane = { status: "ok", ...seen };
      } else if (seen.state === "unobservable" && seen.unverifiable) {
        // Stays a pane observation: `observeSelfPane` turns it into the exit-2
        // `generation_unverifiable` refusal, which the incumbent also raised
        // BEFORE consulting its own refusal string.
        pane = { status: "unverifiable", paneId: seen.paneId ?? "" };
      } else if (seen.state === "unobservable" && !seen.shared && process.env.CLAUDE_JOB_DIR) {
        // A detached background tool can have no ambient/default tmux server
        // while its validated owner lives on a recorded private socket. The
        // job row may select that socket, but it grants no identity until the
        // caller's controlling terminal is positively outside THAT server.
        try { ctx = resolveContext(process.cwd(), process.env, { explicitTeam: team }); } catch (error) { if (isOldStoreRefusal(error)) throw error; /* Preserve the original observation refusal below. */ }
        const bySession = ctx ? observeHarnessSessionPane(ctx) : null;
        if (bySession?.status === "ok" && bySession.selectedSocket) {
          const socketEnv: NodeJS.ProcessEnv = { ...process.env, TAP_TMUX_SOCKET_PATH: bySession.selectedSocket };
          delete socketEnv.TAP_TMUX_SOCKET;
          const selectedSeen = observeCallerIdentity(socketEnv);
          if (selectedSeen.state === "outside") pane = bySession;
          else if (selectedSeen.state === "inside") {
            pane = { status: "ok", ...selectedSeen };
          }
        }
        if (!pane) {
          throw new TapError(1, "not_in_tmux", "tap session launch <preset|harness> [name]",
            `caller pane is not observable (${seen.refusal}; pass --pane <tmux-target>)`);
        }
      } else if (seen.state === "outside") {
        try { ctx = resolveContext(process.cwd(), process.env, { explicitTeam: team }); } catch (error) { if (isOldStoreRefusal(error)) throw error; /* Preserve the existing caller-observation refusal below. */ }
        const bySession = ctx ? observeHarnessSessionPane(ctx) : null;
        if (bySession) pane = bySession;
        else {
          throw new TapError(1, "not_in_tmux", "tap session launch <preset|harness> [name]",
            `caller pane is not observable (${callerObservationReason(seen)}; pass --pane <tmux-target>)`);
        }
      } else {
        throw new TapError(1, "not_in_tmux", "tap session launch <preset|harness> [name]",
          `caller pane is not observable (${seen.refusal}; pass --pane <tmux-target>)`);
      }
    }

    const observed = observeSelfPane(typeof pane === "string" ? observeIdentityPane(pane, process.env, "", true) : pane);
    try { ctx ??= resolveContext(process.cwd(), process.env, { explicitTeam: team, paneFallback: typeof pane === "string" ? false : undefined }); }
    catch (error) {
      if (error instanceof TapError && error.errorClass === "unanchored_bus") {
        refuseUnanchoredPane(observed.paneId, process.cwd(), 2,
          { session: observed.session, serverEpoch: observed.serverEpoch },
          process.env, typeof pane === "string" ? pane : observed.paneId);
      }
      throw error;
    }
    const self = resolveSelf(ctx, observed, 2, process.env, true);
    if (json) {
      process.stdout.write(`${ensureAscii(JSON.stringify({ handle: self.handle, team: self.team, pane: self.pane,
        pane_id: self.paneId, crew: self.crew, instance: self.instance, bus: ctx.bus.home, bus_rule: ctx.busRule }))}\n`);
    } else if (verbose) {
      process.stdout.write(
        `handle=${self.handle} team=${self.team} pane=${self.pane} pane_id=${self.paneId} ` +
        `bus=${ctx.bus.home} bus_rule=${ctx.busRule}\n`,
      );
    } else {
      process.stdout.write(`${self.handle}\n`);
    }
    return 0;
  } catch (error) {
    // Preserve a registered pane's cross-team cd remedy and all corrupt-state refusals.
    // The typed `unregistered` verdict (the authoritative pane resolver's
    // no-current-claimant arm) rewrites exactly as the generic one did: the
    // bash incumbent maps both to the launch door when no local team exists.
    // So does the no-machine-index refusal: a pristine machine's first whoami
    // gets the onboarding door, not the index diagnosis (F2b fallout).
    if (error instanceof TapError && missingLocalTeam() &&
        (error.errorClass === "not_in_tmux" ||
         (error.errorClass === "unanchored_bus" && (error.action === "tap register" || error.detail === NO_MACHINE_INDEX)) ||
         (error.errorClass === "unregistered" && error.action === "tap register"))) {
      // Inherited TAP_JSON is a JSON caller too: both modes get onboarding()'s `tap init`.
      const machine = json || process.env.TAP_JSON === "1";
      error = new TapError(error.code, error.errorClass, machine ? "tap init" : LAUNCH_TEAM, noTeamMessage(displayCwd(process.cwd())));
    }
    if (!json || !(error instanceof TapError)) throw error;
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: false, error_class: error.errorClass,
      action: error.action, ...(error.detail ? { detail: error.detail } : {}) }))}\n`);
    return error.code;
  }
}
