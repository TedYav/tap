import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { enrollmentAtFromDoc, globalRegistryPath, loadGlobalRegistry, purgeGoneEnrollment, teamRootGone } from "./index-home";
import { validToken } from "./ids";
import { teamRegistryDefect } from "./register-authority";
import { pyReadUtf8 } from "./spool-publication";
import { shellQuote } from "./shell-quote";
import { isMap, loads, type JsonMap } from "./watch-detect";

export interface EnrollmentPane { paneId: string; epoch: string; socket: string }
interface Claim { team: string; handle: string; registry: string }
export interface GoneTeam { team: string; root: string; registryLocation: string }
export type PaneEnrollment = (
  | { kind: "none" }
  | { kind: "same_team" | "elsewhere"; claims: Claim[] }
  | { kind: "unknown"; registry: string; detail: string }
) & { gone: GoneTeam[] };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Best-effort admission, not an atomic cross-bus uniqueness claim. Each
 * publisher calls this before writing; simultaneous publishers may both see
 * absence. Existing reset and registry locks retain their own scope.
 *
 * Only a proven active claim on this pane refuses. Another team's defects
 * never block this one: a team whose worktree root is gone is reported in
 * `gone` for self-heal, and a missing or unreadable foreign registry is
 * skipped (tap doctor reports it). Only machine-level authority — the index
 * itself, this pane's identity, this root's enrollment — can answer unknown. */
export function paneEnrollment(pane: EnrollmentPane, root: string, indexHome?: string): PaneEnrollment {
  const snapshot = loadGlobalRegistry(indexHome);
  if (snapshot.marker === "absent") return { kind: "none", gone: [] };
  const unknown = (registry: string, detail: string): PaneEnrollment => ({ kind: "unknown", registry, detail, gone: [] });
  if (snapshot.marker !== "live" || !snapshot.doc) return unknown(snapshot.path, "machine index is unreadable");
  if (!/^%\d+$/.test(pane.paneId)) return unknown(snapshot.path, "pane id is unobservable");
  const target = enrollmentAtFromDoc(snapshot.doc, root);
  if (target.status === "ambiguous" || target.status === "invalid") {
    return unknown(snapshot.path, "target registry authority is ambiguous");
  }
  const targetRegistry = target.status === "ok" || target.status === "unreachable"
    ? canonical(target.registryLocation) : "";
  const teams = snapshot.doc.teams ?? {};
  if (!object(teams)) return unknown(snapshot.path, "enrolled teams are malformed");
  const local: Claim[] = [], foreign: Claim[] = [], gone: GoneTeam[] = [];
  for (const [team, entry] of Object.entries(teams).sort(([a], [b]) => a.localeCompare(b))) {
    // A malformed, unknown-state, or unlocated entry cannot be this root's
    // enrollment (enrollmentAtFromDoc resolved that above), so it is foreign.
    if (!object(entry) || entry.state === "historical") continue;
    if ((entry.state || "registered") !== "registered") continue;
    const registry = text(entry.registry_location);
    if (!registry || !isAbsolute(registry)) continue;
    const localAuthority = canonical(registry) === targetRegistry;
    // A team whose worktree root is gone is gone, even when a registry
    // outside that root is still readable: its claims died with it.
    if (!localAuthority && teamRootGone(text(entry.root), registry)) {
      gone.push({ team, root: text(entry.root), registryLocation: registry });
      continue;
    }
    // Each publisher already validates its own registry under its existing
    // authority/lock contract. This scan must not replace its refusal or
    // legacy reconnect policy with a foreign-enrollment diagnostic.
    let doc: JsonMap;
    try {
      if (!statSync(registry).isFile()) throw new Error("not a regular file");
      const parsed = loads(pyReadUtf8(registry));
      if (!isMap(parsed) || teamRegistryDefect(parsed) !== null) throw new Error("malformed registry");
      doc = parsed;
    } catch {
      continue;
    }
    const seats = doc.get("seats");
    if (!isMap(seats)) continue;
    for (const [handle, row] of seats) {
      if (!isMap(row) || (row.get("status") ?? "active") !== "active" || row.get("delivery") === "poll") continue;
      if (row.get("pane_id") !== pane.paneId) continue;
      const epoch = text(row.get("server_epoch")), socket = text(row.get("server_socket"));
      if (epoch && pane.epoch && epoch !== pane.epoch) continue;
      if (isAbsolute(socket) && isAbsolute(pane.socket) && canonical(socket) !== canonical(pane.socket)) continue;
      // An unprovable claim (missing generation or socket, or a handle that
      // could not name a repair) is not proof this pane is taken.
      if (!epoch || !pane.epoch || !isAbsolute(socket) || !isAbsolute(pane.socket)) continue;
      if (!validToken(team) || !validToken(handle)) continue;
      const claim = { team, handle, registry };
      (localAuthority ? local : foreign).push(claim);
    }
  }
  if (foreign.length) return { kind: "elsewhere", claims: foreign, gone };
  return local.length ? { kind: "same_team", claims: local, gone } : { kind: "none", gone };
}

export function paneEnrollmentRefusal(pane: EnrollmentPane, root: string, indexHome?: string):
  { errorClass: "pane_enrolled_elsewhere" | "pane_enrollment_unknown"; detail: string; action: string } | null {
  const state = paneEnrollment(pane, root, indexHome);
  for (const team of state.gone) {
    const purged = purgeGoneEnrollment(team.team, team, indexHome);
    if (purged.ok) {
      process.stderr.write(`tap: de-enrolled gone team '${team.team}' (worktree root gone); `
        + `restore: cp ${shellQuote(purged.snapshot!)} ${shellQuote(globalRegistryPath(indexHome))}\n`);
    }
  }
  if (state.kind === "elsewhere") {
    const names = state.claims.map(c => `${c.team}/${c.handle}`).join(", ");
    return { errorClass: "pane_enrolled_elsewhere", detail: `pane '${pane.paneId}' is already active in ${names}; no registration was written`,
      action: `keep the existing enrollment, or remove the wrong row with tap out ${state.claims[0]!.team}/${state.claims[0]!.handle}` };
  }
  if (state.kind === "unknown") return { errorClass: "pane_enrollment_unknown",
    detail: `${state.detail}: ${state.registry}; no registration was written`, action: "tap doctor; restore readable enrollment authority and retry" };
  return null;
}
