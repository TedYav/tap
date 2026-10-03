// ONE owner of the resume/restart native-identity uniqueness decision.
// Python callers (single resume, restart, the backfill resolver) reach it as
// literal value transport through the launcher worker; resume --all calls it
// in-process. Scan order, owner spelling and refusal text are the incumbent
// launcher.py composite. transaction.ts assertUniqueResume is the seat-up
// guard: a different scan and message, deliberately not this decision.
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { globalRegistryPath } from "../index-home";
import { isMap, loads, type JsonValue } from "../watch-detect";
import { isDict, parseJsonPreserving, PyInt, pyReadUtf8 } from "../spool-publication";
import { actingRegistryPath, rootForCwd, sessionHandle, SessionStateError } from "./records";
import { InvocationError } from "./invocation";
import { LauncherError } from "./types";
import { teamRegistryRefusal } from "../register-authority";
import { resolvedResumeIdentity } from "./resume-identity";
import { recordFromRow } from "./transaction";

type Row = Record<string, unknown>;
/** The record fields this decision reads; every other field is ignored. */
export interface IdentityRecord {
  name: string; harness: string; cwd: string; base: string; tag?: string | null;
  index?: number | bigint | PyInt | null; harness_session_id?: string | null;
  transcript_path?: string | null; quarantined_harness_session_id?: string | null;
}

// pathlib.Path.resolve() (non-strict): a missing path still compares by its absolute spelling.
const resolved = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};
const indexOf = (value: IdentityRecord["index"]): bigint => {
  if (value instanceof PyInt) return BigInt(value.source);
  if (typeof value === "bigint") return value;
  return typeof value === "number" && Number.isInteger(value) ? BigInt(value) : 0n;
};
export const identityHandle = (record: IdentityRecord): string =>
  sessionHandle({ name: record.name, base: record.base, harness: record.harness, tag: record.tag ?? null, index: indexOf(record.index) });

export function sameSessionRecord(left: IdentityRecord, right: IdentityRecord): boolean {
  return left.harness === right.harness && left.name === right.name && resolved(left.cwd) === resolved(right.cwd);
}

/** Cohort scope only: another record in `records` already holding the native id. */
export function duplicateHarnessSessionOwner(records: IdentityRecord[], target: IdentityRecord, id?: string | null): IdentityRecord | null {
  const native = id || resolvedResumeIdentity(target) || target.harness_session_id;
  if (!native) return null;
  return records.find(record => record.harness === target.harness && (record.harness_session_id === native || resolvedResumeIdentity(record) === native)
    && !sameSessionRecord(record, target)) ?? null;
}

function registryPath(root: string): string | null {
  try { return actingRegistryPath(root); }
  catch (error) {
    if (error instanceof SessionStateError) return null;
    throw error;
  }
}
/** Parse for key order only; a document the Map parser refuses keeps JSON.parse order. */
export function orderedDoc(text: string): JsonValue | undefined {
  try { return loads(text); } catch { return undefined; }
}
// json.load keeps file order for every key; JSON.parse hoists integer-like keys
// ("2" before "10"). Values come from `value`, order from the Map parse of the same text.
export function pyEntries(value: Row, ordered: JsonValue | undefined): Array<[string, unknown]> {
  if (!isMap(ordered)) return Object.entries(value);
  return [...ordered.keys()].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]);
}
/** The `seats` map of a registry document, in file order. */
export function seatEntries(doc: Row, ordered: JsonValue | undefined): Array<[string, unknown]> {
  if (!isDict(doc.seats)) return [];
  return pyEntries(doc.seats as Row, isMap(ordered) ? ordered.get("seats") : undefined);
}

/** Registry scope: the caller's registry, then every enrolled team's acting registry, each once. */
type IdentityScope = { root: string; registryPath: string; handle: string };
export function duplicateRegistrySessionOwner(target: IdentityRecord, scope?: IdentityScope): string | null {
  const native = resolvedResumeIdentity(target) || target.harness_session_id;
  if (!native) return null;
  const targetRoot = scope?.root ?? rootForCwd(target.cwd), targetHandle = scope?.handle ?? identityHandle(target);
  const registries: Array<[string, string, string]> = [];
  const local = scope?.registryPath ?? registryPath(targetRoot);
  if (local !== null) registries.push([target.base, local, targetRoot]);
  // The global registry's enrollments in file order, never the pre-v0.20 ~/.tap/teams.json.
  let teams: unknown = {}, orderedTeams: JsonValue | undefined;
  try {
    const text = pyReadUtf8(globalRegistryPath()), index = parseJsonPreserving(text), ordered = orderedDoc(text);
    teams = isDict(index) ? index.teams ?? {} : {};
    orderedTeams = isMap(ordered) ? ordered.get("teams") : undefined;
  } catch { teams = {}; }
  if (isDict(teams)) {
    for (const [team, indexed] of pyEntries(teams, orderedTeams)) {
      if (!isDict(indexed) || String(indexed.state ?? "registered") === "historical") continue;
      const registry = typeof indexed.registry_location === "string" && indexed.registry_location ? indexed.registry_location
        : typeof indexed.root === "string" ? registryPath(indexed.root) : null;
      if (registry !== null) registries.push([team, registry, typeof indexed.root === "string" ? indexed.root : ""]);
    }
  }
  const seen = new Set<string>();
  for (const [fallbackTeam, registry, registryRoot] of registries) {
    const canonical = resolved(registry);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let payload: unknown, text: string;
    try {
      if (!statSync(registry).isFile()) continue;
      text = pyReadUtf8(registry);
      payload = parseJsonPreserving(text);
    } catch { continue; }
    // An old-format registry cannot prove the id is unowned: refuse the resume, never "no owner".
    const refusal = teamRegistryRefusal(registry, payload);
    if (refusal) throw new LauncherError(refusal.detail, refusal.errorClass, refusal.action, refusal.detail);
    if (!isDict(payload)) continue;
    const teamName = isDict(payload.team) ? payload.team.name : null;
    const team = (typeof teamName === "string" || typeof teamName === "number") && teamName ? String(teamName) : fallbackTeam;
    for (const [handle, entry] of seatEntries(payload, orderedDoc(text))) {
      if (!isDict(entry) || entry.harness !== target.harness) continue;
      if (registryRoot && resolved(registryRoot) === resolved(targetRoot) && handle === targetHandle) continue;
      if (entry.harness_session_id === native) return `${team}/${handle}`;
      // Missing root metadata cannot erase an owner or establish self identity.
      // The decoder's cwd fallback does not participate in the id comparison.
      const record = recordFromRow(handle, entry, isDict(payload.team) ? payload.team : { name: team }, registryRoot || dirname(registry));
      if (record && resolvedResumeIdentity(record) === native) return `${team}/${handle}`;
    }
  }
  return null;
}

export function assertUniqueHarnessSessionIdentity(records: IdentityRecord[], target: IdentityRecord, action: string, scope?: IdentityScope): void {
  const owner = duplicateHarnessSessionOwner(records, target);
  const ownerName = owner !== null ? identityHandle(owner) : duplicateRegistrySessionOwner(target, scope);
  if (ownerName === null) return;
  throw new InvocationError(`${action}: refusing resume for expected seat ${identityHandle(target)}: `
    + `native ${target.harness} session id ${target.harness_session_id} already belongs to expected seat ${ownerName}`);
}

/** Backfill resolver batch: names whose candidate id another cohort record already holds. */
export function cohortIdentityOwned(records: IdentityRecord[], assignments: Record<string, string>): string[] {
  const byName = new Map(records.map(record => [record.name, record] as const));
  return Object.entries(assignments).filter(([name, id]) => {
    const target = byName.get(name);
    return target !== undefined && duplicateHarnessSessionOwner(records, target, id) !== null;
  }).map(([name]) => name);
}
