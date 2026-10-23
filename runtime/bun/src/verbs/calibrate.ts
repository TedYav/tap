import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configDirectory, table } from "../config-file";
import { callerPaneObservation, observeCallerPaneChain, resolveContext, resolveSelf, TapError } from "../context";
import { loadCurrentRegistry, seatMap } from "../registry";
import { appendObservation, calibrationCandidates, collectCalibrationRoutes, gcHint, makeObservation, newestObservations, noteHints, readObservations, renderCalibration, resolveCalibrationRoute } from "../calibration";
import { errorJson, humanAction, humanLine } from "../native-error";
import { lookupHelp } from "../help";

export function calibrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = join(configDirectory(env), "config.toml");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    const doc = Bun.TOML.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd))) as Record<string, unknown>;
    if (doc.calibration === undefined) return false;
    if (!table(doc.calibration) || (doc.calibration.enabled !== undefined && typeof doc.calibration.enabled !== "boolean")) {
      throw new Error("calibration.enabled must be a boolean in a [calibration] table");
    }
    return doc.calibration.enabled === true;
  } finally { closeSync(fd); }
}

/** Shared machine-store location for explicit reads, appends and the GC helper. */
export function calibrationStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new TapError(1, "calibration_unavailable", "set an absolute HOME", "HOME must name the machine home for the calibration store");
  return join(env.HOME, ".tap/calibration/observations.jsonl");
}

interface Options { target?: string; file?: string; ref?: string; effort?: string; all: boolean; json: boolean }
function parse(argv: string[]): Options {
  const options: Options = { all: false, json: argv.includes("--json") };
  let operands = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!operands && arg === "--") { operands = true; continue; }
    if (!operands && arg === "--all") options.all = true;
    else if (!operands && arg === "--json") options.json = true;
    else if (!operands && ["-f", "--ref", "--effort"].includes(arg)) {
      const value = argv[++i];
      if (!value || (value.startsWith("-") && value !== "-")) throw new TapError(1, "usage_error", "tap help calibrate", `${arg} needs a value`);
      const key = arg === "-f" ? "file" : arg === "--ref" ? "ref" : "effort";
      if (options[key] !== undefined) throw new TapError(1, "usage_error", "tap help calibrate", `duplicate ${arg}`);
      options[key] = value;
    } else if (!operands && arg.startsWith("-")) throw new TapError(1, "unknown_option", "tap help calibrate", `unknown option '${arg}'`);
    else if (!options.target) options.target = arg;
    else throw new TapError(1, "usage_error", "tap help calibrate", `unexpected operand '${arg}'`);
  }
  if ((options.ref || options.effort) && !options.file) throw new TapError(1, "usage_error", "tap help calibrate", "--ref and --effort apply only with -f");
  if (options.file && (!options.target || options.all)) throw new TapError(1, "usage_error", "tap help calibrate", "writes require one handle or route and cannot combine with --all");
  return options;
}

function noteFile(path: string): string {
  let fd: number | undefined;
  try {
    if (path === "-") return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0)).trim();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error("note is not a regular file");
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd)).trim();
  } catch (error) { throw new TapError(1, "invalid_note", "tap calibrate <handle|route> -f <note.md>", `cannot read note '${path}': ${(error as Error).message}`); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function cmdCalibrate(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    process.stdout.write(lookupHelp(["calibrate"]).stdout); return 0;
  }
  const json = argv.includes("--json");
  try {
    let enabled: boolean;
    try { enabled = calibrationEnabled(env); }
    catch (error) { throw new TapError(1, "preset_config_invalid", "tap config path", `cannot read calibration.enabled: ${(error as Error).message}`); }
    // Explicit v1 contract: this refusal is stderr-only even when --json was requested.
    if (!enabled) {
      process.stderr.write("tap calibrate: calibration.enabled is false; next: tap config set calibration.enabled true\n");
      return 1;
    }
    const options = parse(argv);
    const path = calibrationStorePath(env);
    const routes = collectCalibrationRoutes(env);
    // Machine reads need no team. An ambiguous bare handle uses the caller's team when available.
    let team: string | undefined;
    if (options.target && !routes.observed.has(options.target) && (routes.handles.get(options.target)?.length ?? 0) > 1) {
      team = resolveContext(process.cwd(), env, { readOnly: true }).team;
    }
    const route = options.target ? resolveCalibrationRoute(options.target, routes, team) : undefined;
    if (options.file) {
      const note = noteFile(options.file);
      if (!note) throw new TapError(1, "empty_note", "tap calibrate <handle|route> -f <note.md>", "note is empty");
      const ctx = resolveContext(process.cwd(), env, { readOnly: true });
      const chain = observeCallerPaneChain(env, ctx);
      const pane = callerPaneObservation(chain);
      if (!pane) throw new TapError(1, "unregistered", "tap in", chain.ok ? "writer pane is not observable" : chain.reason);
      const self = resolveSelf(ctx, pane, 1, env);
      const writer = seatMap(loadCurrentRegistry(ctx.registryPath))[self.handle];
      const ref = options.ref ?? (typeof writer?.harness_session_id === "string" ? writer.harness_session_id : "");
      if (!ref.trim()) throw new TapError(1, "invalid_note", "tap calibrate <handle|route> -f <note.md> --ref <source>", "writer has no registered harness session; supply --ref");
      const row = makeObservation({ at: new Date().toISOString().slice(0, 10), route: route!, ...(options.effort ? { effort: options.effort } : {}), by: `${self.team}/${self.handle}`, ref, note });
      appendObservation(path, row);
      for (const hint of noteHints(note)) process.stderr.write(`tap calibrate: hint: ${hint}\n`);
      process.stdout.write(options.json ? `${JSON.stringify(row)}\n` : `Recorded ${row.id} for ${row.route}.\n`);
      return 0;
    }
    const store = readObservations(path);
    const candidates = route ? [route] : calibrationCandidates(routes, env);
    const selected = newestObservations(store.rows.filter(row => candidates.includes(row.route)));
    process.stdout.write(options.json ? `${JSON.stringify(selected)}\n` : renderCalibration(store.rows, candidates, {
      target: route, all: options.all, hint: gcHint(store.rows, store.bytes), width: process.stdout.columns,
    }));
    return 0;
  } catch (error) {
    const refusal = error instanceof TapError ? error : new TapError(1, "calibration_unavailable", "inspect ~/.tap/calibration/observations.jsonl and its lock", (error as Error).message);
    if (json) process.stdout.write(errorJson(refusal.errorClass, refusal.action, refusal.detail));
    else process.stderr.write(`tap calibrate: ${humanLine(refusal.detail)}; next: ${humanAction(refusal.action)}\n`);
    return 1;
  }
}
