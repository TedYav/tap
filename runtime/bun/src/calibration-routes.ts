// Read existing identity evidence; calibration observations never feed model selection.
import { loadGlobalRegistry } from "./index-home";
import { loadCurrentRegistry, seatMap } from "./registry";
import { readContextTokens } from "./context-tokens";
import { createOpenCodeContextReader } from "./opencode-context";
import { payloadRecords, sessionHandle, isDict } from "./launcher/records";
import { configDirectory, isRegularFile, readSecureBytes } from "./config-file";
import { loadPresetCatalog } from "./launcher/catalog-listing";
import { TapError } from "./context";

export interface CalibrationRoutes {
  handles: Map<string, string[]>;
  observed: Set<string>;
  roster: Set<string>;
}
const string = (value: unknown) => typeof value === "string" ? value : "";
export function collectCalibrationRoutes(env: NodeJS.ProcessEnv = process.env): CalibrationRoutes {
  const found: CalibrationRoutes = { handles: new Map(), observed: new Set(), roster: new Set() };
  const snap = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (snap.marker === "invalid") throw new TapError(1, "registry_unreadable", "tap doctor", "machine registry is invalid");
  if (snap.marker === "absent") return found;
  const readOpenCode = createOpenCodeContextReader(() => null);
  const add = (handle: string, route: string) => found.handles.set(handle, [...new Set([...(found.handles.get(handle) ?? []), route])]);
  for (const [team, enrollment] of Object.entries(isDict(snap.doc?.teams) ? snap.doc.teams : {})) {
    if (!isDict(enrollment) || enrollment.state === "historical" || !string(enrollment.registry_location)) continue;
    const doc = loadCurrentRegistry(string(enrollment.registry_location));
    for (const [handle, seat] of Object.entries(seatMap(doc))) {
      const harness = string(seat.harness);
      const launch = isDict(seat.launch_tuning) ? string(seat.launch_tuning.model) : string(seat.model);
      if (!harness) continue;
      const session = string(seat.harness_session_id), path = string(seat.transcript_path);
      const sample = harness === "opencode" ? readOpenCode(session, path) : readContextTokens(harness, session, path);
      const model = sample.tuning?.model || launch;
      if (launch) found.observed.add(`${harness}/${launch}`);
      if (!model) continue;
      const route = `${harness}/${model}`;
      found.observed.add(route); found.roster.add(route);
      add(handle, route); add(`${team}/${handle}`, route);
    }
    // Durable launcher records remain route evidence after the current roster is quiet.
    for (const record of payloadRecords(doc, string(enrollment.root))) {
      if (!record.model) continue;
      const route = `${record.harness}/${record.model}`;
      found.observed.add(route);
      if (!found.handles.has(`${team}/${sessionHandle(record)}`)) add(`${team}/${sessionHandle(record)}`, route);
    }
  }
  return found;
}

export function resolveCalibrationRoute(target: string, routes: CalibrationRoutes, team?: string): string {
  if (routes.observed.has(target)) return target;
  const matches = (team ? routes.handles.get(`${team}/${target}`) : undefined) ?? routes.handles.get(target);
  if (matches?.length === 1) return matches[0]!;
  if (matches && matches.length > 1) throw new TapError(1, "ambiguous_target", "tap calibrate <team/handle>", `handle '${target}' has multiple routes; qualify the team`);
  throw new TapError(1, "unknown_route", "tap team", `unknown_route: '${target}' has no observed roster or launch route on this machine`);
}

export function calibrationCandidates(routes: CalibrationRoutes, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = new Set(routes.roster);
  try {
    const catalog = loadPresetCatalog(env, () => {}, readSecureBytes, configDirectory(env), isRegularFile);
    for (const preset of catalog.presets.values()) if (preset.model) candidates.add(`${preset.harness}/${preset.model}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return [...candidates];
}
