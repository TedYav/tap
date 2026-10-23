import { inheritedActor } from "../context";
import { TapError, observeCallerIdentity, refuseUnanchoredPane, requireActingRegistry } from "../context";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { assertResetUnfenced } from "../reset";
import { outstanding } from "../slices/outstanding";
import { exchangeSelf } from "../exchange-self";

export function cmdOutstanding(argv: string[]): number {
  let me = "", positional = false, machine = false, stale = "", team = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") { machine = true; process.env.TAP_JSON = "1"; }
    else if (a === "--team") {
      team = argv[++i] ?? "";
      if (!team) throw new TapError(1, "usage_error", "tap help outstanding", "--team needs a value");
    } else if (a === "--stale") {
      stale = argv[++i] ?? "";
      if (!stale) throw new TapError(1, "usage_error", "tap help outstanding", "--stale needs a value (seconds)");
    } else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help outstanding", `unknown option '${a}'`);
    else {
      if (positional) throw new TapError(1, "usage_error", "tap help outstanding", "usage: tap outstanding [me] [--json] [--stale <secs>] [--team <name>]");
      me = a; positional = true;
    }
  }
  if (stale && !/^\d+$/.test(stale)) throw new TapError(1, "usage_error", "tap help outstanding", `--stale must be a positive integer (seconds), got '${stale}'`);
  // Bash arithmetic caps at its signed integer maximum; the bound is checked
  // in BigInt because Number loses precision above 2^53 and the incumbent sh
  // script rejects anything its arithmetic cannot hold (pattern from
  // verbs/watch.ts, which keeps the same constant unexported).
  const BASH_INT_MAX = 9223372036854775807n;
  if (stale) {
    const seconds = BigInt(stale);
    if (seconds <= 0n) throw new TapError(1, "usage_error", "tap help outstanding", "--stale must be > 0");
    if (seconds > BASH_INT_MAX) {
      throw new TapError(1, "usage_error", "tap help outstanding", `--stale must not exceed 9223372036854775807, got '${stale}'`);
    }
  }
  // The caller pin is read BEFORE the team override, which sets TAP_HOME itself.
  const callerPin = process.env.TAP_HOME ?? "";
  try {
    applyTeamOverride(team);
    const ctx = resolveSelection(callerPin, team);
    if (ctx.busRule !== "env") requireActingRegistry(ctx, 4);
    assertResetUnfenced(ctx.bus.home, "tap outstanding");
    if (!me) me = inheritedActor() || exchangeSelf(ctx, "outstanding");
    ctx.bus.ensureDirs();
    // A live flip marker means this machine is the sending instance; older
    // sender instances' payloads are then another instance's obligations.
    const result = outstanding(ctx, me, machine, stale, ctx.marker === "live");
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  } catch (error) {
    // With an explicit --team the caller named their bus; the pane arm is only
    // for a cwd-derived scan that found no acting registry.
    if (team || !(error instanceof TapError) || error.errorClass !== "unanchored_bus") throw error;
    const seen = observeCallerIdentity();
    if (seen.state === "inside") {
      refuseUnanchoredPane(seen.paneId, process.cwd(), 4,
        { session: seen.session, serverEpoch: seen.serverEpoch }, process.env, seen.paneId, true);
    }
    // Only observations that name the MISSING stamp enter typed recovery:
    // targeted rate limiting and pane-id/tty drift keep the generic refusal
    // and never consult enrollment from a bare pane id. The missing-epoch
    // variant carries its real observed session; no fabricated sentinel.
    if (seen.state === "unobservable" && seen.paneId && seen.missing) {
      refuseUnanchoredPane(seen.paneId, process.cwd(), 4,
        { session: seen.missing === "epoch" ? seen.session ?? "" : "", serverEpoch: "" },
        process.env, seen.paneId, true);
    }
    const reason = seen.state === "outside" ? seen.detail : seen.refusal || "observation reason unavailable";
    throw new TapError(4, "unanchored_bus", "pass --team <team>  OR  set TAP_HOME to the bus directory",
      `cwd-derived bus has no acting registry and the caller pane is not observable (${reason})`);
  }
}
