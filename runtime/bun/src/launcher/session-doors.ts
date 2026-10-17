// Public resume/restart spelling. The command owners receive canonical typed options.
import { cmdSessionResume } from "./resume";
import { cmdSessionResumeAll, type CohortObserver } from "./resume-all";
import { cmdSessionRestart, type RestartOptions } from "./restart";
import { errorLine, SCRIPTS } from "./resume-prelude";
import { SESSION_RESTART_HELP, SESSION_RESUME_HELP } from "../help";
import { exitKeepingTerminal } from "./prompt";
import type { LifecycleReceipt } from "../lifecycle-target";
import type { BoundCohort } from "../team/discovery";

export type SessionDoor = "resume" | "restart";
export type DoorOptions = RestartOptions & { all: boolean; legacyName: string | null; help: boolean };
const usage = (door: SessionDoor) => `usage: tap session ${door} ${door === "restart" ? "[--force] [--dry-run] [--json] [key]" : "[--dry-run] [--json] [--all] [key] [legacy_name]"}`;

/** Preserve argparse's unambiguous long abbreviations and literal operands after --. */
export function parseSessionDoor(door: SessionDoor, argv: string[]): DoorOptions {
  const flags = door === "restart" ? ["--help", "--force", "--dry-run", "--json"] : ["--help", "--dry-run", "--json", "--all"];
  const result: DoorOptions = { key: "", legacyName: null, force: false, dryRun: false, json: process.env.TAP_JSON === "1", all: false, help: false };
  const positional: string[] = [];
  let literal = false;
  for (const arg of argv) {
    if (literal || arg === "-" || !arg.startsWith("-")) { positional.push(arg); continue; }
    if (arg === "--") { literal = true; continue; }
    const matches = arg === "-h" ? ["--help"] : arg.startsWith("--") ? flags.filter(flag => flag.startsWith(arg)) : [];
    if (matches.length !== 1) throw new Error(`${usage(door)}\n${matches.length ? "ambiguous option" : "unrecognized argument"}: ${arg}`);
    switch (matches[0]) {
      case "--help": result.help = true; return result;
      case "--force": result.force = true; break;
      case "--dry-run": result.dryRun = true; break;
      case "--json": result.json = true; break;
      case "--all": result.all = true; break;
    }
  }
  if (positional.length > (door === "restart" ? 1 : 2)) throw new Error(`${usage(door)}\nunrecognized arguments: ${positional.slice(door === "restart" ? 1 : 2).join(" ")}`);
  result.key = positional[0] ?? ""; result.legacyName = positional[1] ?? null;
  return result;
}

/** `root` is set only by `tap team up <team>`: the named team's enrolled checkout, in place of cwd. */
export async function cmdSessionDoor(door: SessionDoor, argv: string[], scripts = SCRIPTS, lifecycle?: LifecycleReceipt, root?: string, bound?: BoundCohort,
  observer?: CohortObserver): Promise<number> {
  let options: DoorOptions;
  try { options = parseSessionDoor(door, argv); }
  catch (error) {
    if (process.env.TAP_JSON === "1" || argv.includes("--json")) process.stdout.write(errorLine("usage_error", "tap help session", String((error as Error).message)));
    else process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  if (options.help) { process.stdout.write(door === "restart" ? SESSION_RESTART_HELP : SESSION_RESUME_HELP); return 0; }
  if (door === "restart") {
    if (!options.key) {
      if (options.json) process.stdout.write(errorLine("usage_error", "tap help session", usage(door)));
      else process.stderr.write(`${usage(door)}\n`);
      return 2;
    }
    return cmdSessionRestart(options, scripts);
  }
  const args = [...(options.all ? ["--all"] : []), ...(options.dryRun ? ["--dry-run"] : []), ...(options.json ? ["--json"] : []),
    ...(options.key || options.legacyName !== null ? ["--", options.key, ...(options.legacyName !== null ? [options.legacyName] : [])] : [])];
  return options.all ? cmdSessionResumeAll(args, scripts, lifecycle, root, bound, observer) : cmdSessionResume(args, scripts, argv);
}

if (import.meta.main) {
  const door = process.argv[2];
  if (door !== "resume" && door !== "restart") { process.stderr.write("tap session: expected resume or restart\n"); await exitKeepingTerminal(2); }
  else await exitKeepingTerminal(await cmdSessionDoor(door, process.argv.slice(3)));
}
