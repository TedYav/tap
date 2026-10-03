// Read-only forensic display: no actor resolution, registry reconcile, mkdir or receipts.
import { existsSync } from "node:fs";
import { queueExplanation } from "../queue-explanation";
import { unresolvedInjection } from "../submit-phase";
import { alsoLines, renderShow } from "../show-render";
import { join } from "node:path";
import { resolveContext, TapError, type Context } from "../context";
import { lowerRankedCopies, renderDigest, resolveView, type PayloadView } from "../payload-view";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { humanAction, humanLine } from "../native-error";
import { Bus } from "../bus";
import { unverifiedCanonical } from "../delivery-custody";
import { repoRoot, requireResolvedBus, resolveBus } from "../bushome";

const USAGE = "usage: tap show <id|team/id|12hex> [--team <name>]";

function emitView(view: PayloadView): void {
  const explanation = unverifiedCanonical(view.busHome, view.id) ? queueExplanation(view.busHome, view.id)
    : unresolvedInjection(view.busHome, view.id) ?? (existsSync(join(view.busHome, "spool", `${view.id}.meta.json`)) ? queueExplanation(view.busHome, view.id) : "");
  process.stdout.write(renderShow(view.path, view.busHome, view.id, view.team, view.residency, explanation, lowerRankedCopies(view)));
}

export function cmdShow(argv: string[]): number {
  let all = false, item = "", team = "", arg = "", explicit = "", afterDash = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (afterDash) {
      if (arg) throw new TapError(1, "usage_error", "tap help show", `unexpected arg '${value}'`);
      arg = value;
    } else if (value === "--all") all = true;
    else if (value === "--item") {
      item = argv[++i] ?? ""; if (!item) throw new TapError(1, "usage_error", "tap help show", "--item needs an id");
    } else if (value === "--team") {
      team = argv[++i] ?? ""; if (!team) throw new TapError(1, "usage_error", "tap help show", "--team needs a value");
    } else if (value === "--") afterDash = true;
    else if (value.startsWith("path=")) explicit = value.slice(5);
    else if (value.startsWith("--")) throw new TapError(1, "unknown_option", "tap help show", `unknown option '${value}'`);
    else {
      if (arg) throw new TapError(1, "usage_error", "tap help show", `unexpected arg '${value}'`);
      arg = value;
    }
  }
  if (!arg) arg = explicit ? `path=${explicit}` : "";
  if (!arg || arg === "path=") throw new TapError(1, "usage_error", "tap help show", USAGE);
  // Caller pin > --team > cwd walk (poll.ts pattern); the pin is read BEFORE the override.
  const callerPin = process.env.TAP_HOME ?? ""; applyTeamOverride(team);
  const selfAnchored = Boolean(explicit) || arg.includes("/");
  let ctx: Context & { marker: "absent" | "live" };
  try {
    ctx = resolveSelection(callerPin, team);
  } catch (error) {
    // A deleted/unreadable pin must not veto an answer the ARGUMENT anchors
    // (team/id via the index, path= via the file); an explicit --team keeps strict precedence.
    if (!selfAnchored || team || !(error instanceof TapError)) throw error;
    if (explicit || arg.startsWith("path=")) {
      // A `path=` selector anchors through the FILE: the incumbent resolved it
      // against a default local bus, never reading the path prefix as a team.
      ctx = unanchoredContext();
    } else {
      const slash = arg.indexOf("/"), argTeam = slash > 0 ? arg.slice(0, slash) : "";
      ctx = resolveContext(process.cwd(), process.env, argTeam ? { explicitTeam: argTeam } : undefined);
    }
  }
  let view: ReturnType<typeof resolveView>;
  try {
    view = resolveView(ctx, arg, "show", "", explicit);
  } catch (error) {
    // Bash adorned the resolver's noteam refusal with the teams hint; keep the bytes.
    if (error instanceof TapError && error.errorClass === "not_found" && error.action === "tap teams" && error.detail.endsWith("on this machine"))
      throw new TapError(error.code, error.errorClass, error.action, `${error.detail} — 'tap teams' lists them`);
    throw error;
  }
  if (view.residency === "digest") {
    // Members render IN PROCESS via the callback: a member's refusal renders,
    // marks the aggregate failed, and the siblings still dispatch.
    const status = renderDigest("show", view.path, all, item, [], (view.team ? view.team + "/" : "") + view.id, (memberPath, _forward) => {
      try {
        emitView(resolveView(ctx, `path=${memberPath}`, "show"));
        return 0;
      } catch (error) {
        // Anything unexpected rethrows to digest dispatch's boundary.
        if (!(error instanceof TapError)) throw error;
        process.stderr.write(`tap show: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
        return 1;
      }
    });
    // A digest winner discloses its lower-ranked copies after the listing, like any other winner.
    const also = alsoLines(lowerRankedCopies(view));
    if (also.length) process.stdout.write(also.join("\n") + "\n");
    return status;
  }
  if (all || item) throw new TapError(1, "usage_error", "tap show <digest-id> --all", "--all/--item require a digest");
  emitView(view);
  return 0;
}

/** The incumbent's `<root>/.tap/bus` default with no acting context: enough
 *  for a self-anchoring `path=` selector, which reads only `ctx.bus.home`. */
function unanchoredContext(): Context & { marker: "absent" } {
  const root = repoRoot(process.cwd());
  const bus = resolveBus(root, process.env);
  requireResolvedBus(bus);
  return { bus: new Bus(bus.home), busRule: bus.rule, marker: "absent", team: "", registryPath: "", root };
}
