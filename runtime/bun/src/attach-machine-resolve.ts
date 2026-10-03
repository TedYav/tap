// Machine-wide lookup for a bare `tap attach <handle>` that the current team cannot answer.
// Read-only: one snapshot of the machine index, one parse per team registry, no tmux.
import { statSync } from "node:fs";
import { loadGlobalRegistry, resolveTeamFromDoc, teamRootGone } from "./index-home";
import { teamRegistryRefusal } from "./register-authority";
import { pyReadUtf8 } from "./spool-publication";
import { validToken } from "./ids";
import { TapError } from "./context";

export interface MachineHit { team: string; root: string; registry: string }
/** `hides`: the registry could not be read, so it may hold the handle. A dead enrollment cannot. */
export interface MachineSkip { team: string; reason: string; hides: boolean }
export interface MachineScan { hits: MachineHit[]; skipped: MachineSkip[] }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Every live enrolled team that holds `handle`, and every team that could not be asked.
 * Returns null when there is no usable machine index (callers keep their own refusal).
 * Reads the registry document directly: the roster projection drops malformed rows,
 * which would read a hidden duplicate as absence.
 */
export function scanMachineForHandle(handle: string, indexHome?: string): MachineScan | null {
  const snapshot = loadGlobalRegistry(indexHome);
  if (snapshot.marker !== "live" || !snapshot.doc) return null;
  const members = object(snapshot.doc.teams) ? snapshot.doc.teams : {};
  const scan: MachineScan = { hits: [], skipped: [] };
  for (const team of Object.keys(members).sort()) {
    if (!validToken(team)) continue;
    const entry = members[team];
    if (!object(entry)) { scan.skipped.push({ team, reason: "its index entry is malformed", hides: true }); continue; }
    // Historical teams have no addressable seats; a bare entry names no registry to hold one.
    if (String(entry.state ?? "registered") === "historical") continue;
    const location = String(entry.registry_location ?? "");
    if (!location) continue;
    const found = resolveTeamFromDoc(snapshot.doc, team);
    const root = String(entry.root ?? "");
    // Classify the path before opening it: reading a FIFO at the registry path would block.
    let kind: "file" | "missing" | "other" = "file";
    try { kind = statSync(location).isFile() ? "file" : "other"; }
    catch (error) { kind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other"; }
    if (kind === "missing") {
      scan.skipped.push(teamRootGone(root, location)
        ? { team, reason: "its worktree is gone (dead enrollment)", hides: false }
        : { team, reason: "its registry file is missing", hides: true });
      continue;
    }
    if (kind === "other") { scan.skipped.push({ team, reason: "its registry path is not a readable file", hides: true }); continue; }
    let document: unknown;
    try { document = JSON.parse(pyReadUtf8(location)); }
    catch (error) {
      scan.skipped.push({ team, reason: error instanceof SyntaxError ? "its registry is not valid JSON" : "its registry cannot be read", hides: true });
      continue;
    }
    if (teamRegistryRefusal(location, document)) { scan.skipped.push({ team, reason: "its registry is an old store format", hides: true }); continue; }
    const seats = object(document) ? document.seats : undefined;
    if (!object(document) || !object(seats)) { scan.skipped.push({ team, reason: "its registry has no usable seat map", hides: true }); continue; }
    if (!Object.hasOwn(seats, handle)) continue;
    if (!object(seats[handle])) { scan.skipped.push({ team, reason: `its row for '${handle}' is malformed`, hides: true }); continue; }
    scan.hits.push({ team, root: found.root || root, registry: found.registryLocation || location });
  }
  return scan;
}

export type MachineVerdict =
  | { kind: "none" }
  | { kind: "unique"; hit: MachineHit }
  | { kind: "ambiguous"; hits: MachineHit[] }
  | { kind: "unverifiable"; hit: MachineHit; hiding: MachineSkip[] };

/** A skipped registry that could hold the handle never turns "several" or "unknown" into "unique". */
export function machineVerdict(scan: MachineScan): MachineVerdict {
  if (scan.hits.length > 1) return { kind: "ambiguous", hits: scan.hits };
  if (!scan.hits.length) return { kind: "none" };
  const hiding = scan.skipped.filter(skip => skip.hides);
  return hiding.length ? { kind: "unverifiable", hit: scan.hits[0]!, hiding } : { kind: "unique", hit: scan.hits[0]! };
}

export function skipNotes(scan: MachineScan): string {
  return scan.skipped.map(skip => `tap attach: skipped team '${skip.team}': ${skip.reason}\n`).join("");
}

/** The refusal a non-unique verdict maps to; null when attach may proceed or the handle is unknown. */
export function machineRefusal(handle: string, verdict: MachineVerdict): TapError | null {
  if (verdict.kind === "ambiguous") {
    const names = verdict.hits.map(hit => `${hit.team}/${handle}`);
    return new TapError(1, "ambiguous_handle", `tap attach <team>/<handle>   (one of: ${names.join(", ")})`,
      `handle '${handle}' exists on ${names.length} teams: ${names.join(", ")} — name the team`);
  }
  if (verdict.kind === "unverifiable") {
    const target = `${verdict.hit.team}/${handle}`;
    const hiding = verdict.hiding.map(skip => `${skip.team} (${skip.reason})`).join("; ");
    return new TapError(1, "unverifiable_handle", `tap attach ${target}   (if that is the seat)   ·   tap doctor   (repair the skipped registries)`,
      `handle '${handle}' is on ${target}, but ${verdict.hiding.length} registr${verdict.hiding.length === 1 ? "y" : "ies"} could not be read, so it cannot be shown to be the only one — skipped: ${hiding}`);
  }
  return null;
}
