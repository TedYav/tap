// Shared launcher record projection. Callers own parsing: list keeps its display
// parser; repair passes lossless Maps so an integer handle suffix cannot round.
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { repoRoot } from "../bushome";
import { enrollmentAtFromDoc, loadGlobalRegistry } from "../index-home";
import { NO_MACHINE_INDEX } from "../selector";
import { HARNESSES } from "./catalog";
import { seatIsRelaunchable } from "./complete";
import { PyInt } from "../spool-publication";

export type Row = Record<string, unknown>;
export interface SessionRecord {
  name: string; harness: string; cwd: string; launch_workdir?: string; base: string; tag: string | null; index: number | bigint;
  model: string | null; harnessSessionId: string | null; preset: Record<string, string> | null;
  lastSeen: string | null; lastLaunched: string | null; instance: string | null;
  /** The seat's declared launch env and removals: the artifact probe composes them with the catalog policy. */
  harnessEnv?: Record<string, string>; harnessUnsetEnv?: string[];
}

export class SessionStateError extends Error {}
/** No machine index: renders as unanchored_bus; still a SessionStateError for catch-by-type callers. */
export class NoMachineIndex extends SessionStateError {
  readonly errorClass = "unanchored_bus";
  readonly action = "tap init  OR  tap session launch";
  readonly detail = NO_MACHINE_INDEX;
  constructor() { super(`${NO_MACHINE_INDEX}; next: tap init  OR  tap session launch`); }
}
export const isDict = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Map);
export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const realOrSelf = (path: string): string => {
  try { return realpathSync(path); } catch { return path; }
};
export const rootForCwd = (cwd: string): string => realOrSelf(repoRoot(cwd));
const deriveBase = (cwd: string): string => sanitize(basename(rootForCwd(cwd)));
const fields = (value: unknown): Row => value instanceof Map ? Object.fromEntries(value) : isDict(value) ? value : {};

function sanitize(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function payloadRecords(payload: Row | Map<string, unknown>, root: string): SessionRecord[] {
  const doc = fields(payload), team = fields(doc.team);
  const seats = doc.seats instanceof Map || isDict(doc.seats) ? doc.seats : {};
  const entries = seats instanceof Map ? seats.entries() : Object.entries(seats);
  const records: SessionRecord[] = [];
  for (const [handle, value] of entries) {
    const entry = fields(value);
    // Python's crew == True includes integer/float 1, but not other truthy values.
    const crew = entry.crew;
    const cohort = value instanceof Map ? { ...entry, crew: crew === 1n || (isDict(crew) && Number(crew.float) === 1) ? true : crew } : entry;
    if (!seatIsRelaunchable(cohort) || !nonEmpty(entry.session)) continue;
    const harness = entry.harness;
    if (!nonEmpty(harness) || !HARNESSES.includes(harness)) continue;
    const cwd = nonEmpty(entry.registered_from_worktree) ? entry.registered_from_worktree
      : nonEmpty(team.worktree_root) ? team.worktree_root : root;
    const text = (key: string) => (nonEmpty(entry[key]) ? entry[key]! : null);
    const index = entry.index;
    records.push({
      name: entry.session, harness, cwd,
      ...(nonEmpty(entry.launch_workdir) ? { launch_workdir: entry.launch_workdir } : {}),
      base: nonEmpty(entry.base) ? entry.base : nonEmpty(team.name) ? team.name : deriveBase(cwd),
      tag: "tag" in entry ? (nonEmpty(entry.tag) ? entry.tag : null) : handle === harness ? null : handle,
      index: typeof index === "bigint" && index >= 1n ? index
        : typeof index === "number" && Number.isInteger(index) && index >= 1 ? index : 1,
      model: text("model"), harnessSessionId: text("harness_session_id"),
      preset: presetProvenance(entry.preset), instance: text("instance"),
      lastSeen: text("last_seen"), lastLaunched: text("last_launched"),
      harnessEnv: Object.fromEntries(Object.entries(isDict(entry.harness_env) ? entry.harness_env : {})
        .filter((pair): pair is [string, string] => typeof pair[1] === "string")),
      harnessUnsetEnv: Array.isArray(entry.harness_unset_env) ? entry.harness_unset_env.filter((key): key is string => typeof key === "string") : [],
    });
  }
  return records;
}

const PRESET_KEYS = ["name", "source_path", "config_digest"];
function presetProvenance(value: unknown): Record<string, string> | null {
  const row = fields(value);
  if (!PRESET_KEYS.every((key) => nonEmpty(row[key])) || Object.keys(row).length !== PRESET_KEYS.length) return null;
  return { name: row.name as string, source_path: row.source_path as string, config_digest: row.config_digest as string };
}

export function actingRegistryPath(root: string): string | null {
  const snapshot = loadGlobalRegistry();
  if (snapshot.marker === "invalid") throw new SessionStateError("acting registry is invalid; next: tap doctor");
  if (snapshot.marker === "live") {
    const enrollment = enrollmentAtFromDoc(snapshot.doc!, realOrSelf(root));
    if (enrollment.status === "ok") return enrollment.registryLocation;
    if (enrollment.status === "missing") throw new SessionStateError("worktree is not enrolled; next: tap session launch or tap in");
    throw new SessionStateError("acting team registry is unreachable; next: tap doctor");
  }
  throw new NoMachineIndex();
}

export function pathIsUnder(path: string, root: string): boolean {
  const rel = relative(realOrSelf(root), realOrSelf(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

type HandleRecord = Pick<SessionRecord, "name" | "base" | "harness" | "tag" | "index">;

export function sessionHandle(record: HandleRecord): string {
  if (record.tag) return record.index > 1 ? `${record.tag}-${record.index}` : record.tag;
  const prefix = `${sanitize(record.base)}/`;
  if (record.name.startsWith(prefix)) {
    const slash = record.name.slice(prefix.length);
    if (slash) return slash;
  }
  const handle = record.tag ?? record.harness;
  return record.index > 1 ? `${handle}-${record.index}` : handle;
}

export function recordKeySelection(records: unknown, key: unknown): number | null {
  if (typeof key !== "string" || !Array.isArray(records) || !records.every(row =>
    isDict(row) && [row.name, row.base, row.harness].every(value => typeof value === "string") &&
    (row.tag === null || typeof row.tag === "string") &&
    (row.index === null || row.index instanceof PyInt || Number.isSafeInteger(row.index)))) {
    throw new Error("invalid record key selection request");
  }
  const rows = records as (Omit<HandleRecord, "index"> & { index: number | PyInt | null })[];
  const exact = rows.findIndex(row => row.name === key);
  if (exact !== -1) return exact;
  // Python permits an empty tag and a nullable index; shared record readers
  // already normalize these. Keep that normalization local to this input door.
  const handle = rows.findIndex(row => sessionHandle({ ...row, tag: row.tag || null,
    index: row.index instanceof PyInt ? BigInt(row.index.source) : row.index ?? 1 }) === key);
  return handle === -1 ? null : handle;
}
