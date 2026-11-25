// Explicit mail custody is distinct from reclaim adoption and current membership.
// Both endpoints are instance pinned; retiring a name never authorizes its reuse.
import { parsePreservingBigint, pyJson, seatMap, supersedeForwardingAliases, type RegistryDoc, loadCurrentRegistry } from "./registry";
import { TapError } from "./context";
import { validToken } from "./ids";

export interface Forwarding {
  source: string;
  source_instance: string;
  destination: string;
  destination_instance: string;
  at: string;
  address_active: boolean;
  custody_revoked?: boolean;
}
export interface ForwardRoute {
  target: string;
  instance: string;
  adopted_from: string;
  source_instance: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
function refuse(detail: string): never {
  throw new TapError(1, "forwarding_unresolved", "inspect tap team and the explicit handoff; do not resend old mail", detail);
}

/** A redirect with unreadable custody must not fall back to another addressee. */
export function unsupportedForwardingDestination(error: unknown): boolean {
  return error instanceof TapError && error.errorClass === "forwarding_destination_unsupported";
}

function localDestination(edge: Forwarding): string {
  if (!validToken(edge.destination)) {
    throw new TapError(1, "forwarding_destination_unsupported", "inspect the forwarding record and TAP version",
      "forwarding destination is not a local seat handle");
  }
  return edge.destination;
}

export function forwardings(doc: RegistryDoc): Forwarding[] {
  if (doc.seat_forwardings === undefined) return [];
  if (!Array.isArray(doc.seat_forwardings)) refuse("seat_forwardings is not an array");
  return doc.seat_forwardings.map(row => {
    if (!object(row) || ["source", "source_instance", "destination", "destination_instance", "at"].some(k => !text(row[k]))) {
      refuse("invalid instance-pinned forwarding record");
    }
    return row as unknown as Forwarding;
  });
}

/** One bounded walk for future routing, historical replies and recipient grants.
 * A replacement source owns new address traffic, while a pinned historical route
 * follows its original edge even when that name has since been re-registered.
 */
export function forwardingRoute(doc: RegistryDoc, handle: string, instance = "", historical = false): ForwardRoute {
  const edges = forwardings(doc), seats = seatMap(doc);
  const current = seats[handle];
  // Forwarding changes return custody only for principals with an explicit
  // handoff history. Preserve the existing address-based reply outside it.
  if (historical && instance && !edges.some(e => e.source === handle)) {
    return { target: handle, instance: text(current?.instance), adopted_from: "", source_instance: "" };
  }
  if (!instance) {
    const candidates = edges.filter(e => e.source === handle);
    if (historical && candidates.length) refuse(`historical recipient '${handle}' has no instance stamp; custody is ambiguous`);
    if (object(current)) return { target: handle, instance: text(current.instance), adopted_from: "", source_instance: "" };
    const aliases = candidates.filter(e => e.address_active === true && !e.custody_revoked);
    if (!aliases.length) return { target: handle, instance: "", adopted_from: "", source_instance: "" };
    if (aliases.length !== 1) refuse(`address '${handle}' has ambiguous retired instances; name the original instance`);
    instance = aliases[0]!.source_instance;
  }
  const sourceInstance = instance;
  let target = handle, bound = instance, adopted = false;
  const visited = new Set<string>();
  for (let n = 0; n <= edges.length; n++) {
    const key = JSON.stringify([target, bound]);
    if (visited.has(key)) refuse(`forwarding cycle at '${target}' instance '${bound}'`);
    visited.add(key);
    const row = seats[target];
    const matches = edges.filter(e => e.source === target && e.source_instance === bound && !e.custody_revoked);
    if (matches.length > 1) refuse(`ambiguous forwarding custody for '${target}' instance '${bound}'`);
    // A source row and edge for one incarnation cannot coexist after publication.
    if (object(row) && row.instance === bound) {
      if (matches.length) refuse(`'${target}' instance '${bound}' is both registered and retired`);
      return { target, instance: bound, adopted_from: adopted ? handle : "", source_instance: adopted ? sourceInstance : "" };
    }
    if (!matches.length) refuse(`recipient '${target}' instance '${bound}' has no current seat or explicit successor`);
    const edge = matches[0]!;
    target = localDestination(edge); bound = edge.destination_instance; adopted = true;
  }
  return refuse(`forwarding chain for '${handle}' exceeds its registry bound`);
}

export function forwardingGrant(doc: RegistryDoc, actor: string, source: string, instance: string): string {
  if (!instance || actor === source) return "";
  try {
    const route = forwardingRoute(doc, source, instance, true);
    return route.adopted_from && route.target === actor ? source : "";
  } catch { return ""; }
}

/** Does the successor need a visible diagnosis for historical unstamped mail? */
export function ambiguousForwarding(doc: RegistryDoc, actor: string, source: string): boolean {
  return forwardings(doc).some(edge => edge.source === source && forwardingGrant(doc, actor, source, edge.source_instance));
}

/** Build the new document without mutating the caller's snapshot. The caller
 * holds the authoritative registry lock through the single saveRegistry rename.
 */
export function prepareForwarding(doc: RegistryDoc, source: string, destination: string, at: string): { doc: RegistryDoc; record: Forwarding } {
  if (source === destination) refuse("cannot forward a seat to itself");
  const seats = seatMap(doc), from = seats[source], to = seats[destination];
  if (!object(from) || !text(from.instance) || !["active", "suspended"].includes(text(from.status) || "active")) refuse(`source '${source}' has no current instance to retire`);
  if (!object(to) || !text(to.instance) || (to.status ?? "active") !== "active") refuse(`destination '${destination}' must be an active instance`);
  if (from.status_reason === "launching" || to.status_reason === "launching") refuse("cannot hand off a launching seat");
  const edges = forwardings(doc);
  if (edges.some(e => e.source === source)) refuse(`'${source}' already has historical forwarding custody; repeated name retirement is ambiguous`);
  // Reclaim grants are separate authority that this operation cannot drop.
  if (Array.isArray(from.adopted_handles) && from.adopted_handles.length) refuse(`'${source}' holds reclaim-adopted custody; transfer it explicitly before retiring`);
  // Refuse a name cycle even if one of the names was re-registered in between.
  const seen = new Set<string>();
  const pending = [destination];
  while (pending.length) {
    const name = pending.pop()!;
    if (name === source) refuse(`forwarding '${source}' to '${destination}' would create a cycle`);
    if (seen.has(name)) continue;
    seen.add(name);
    for (const edge of edges) if (edge.source === name) pending.push(localDestination(edge));
  }
  const record: Forwarding = { source, source_instance: text(from.instance), destination,
    destination_instance: text(to.instance), at, address_active: true };
  const next = structuredClone(doc);
  delete seatMap(next)[source];
  next.seat_forwardings = [...edges, record];
  // Every valid incoming route previously ended at this exact source row and
  // now follows its one new edge. Unrelated expired grants cannot block it.
  forwardingRoute(next, source, record.source_instance, true);
  return { doc: next, record };
}

if (import.meta.main) {
  try {
    const [mode, path, actor, source = "", instance = "", ...rest] = process.argv.slice(2);
    if (mode === "supersede") {
      // tap-kwjba: a plain JSON.parse/JSON.stringify round trip here silently
      // rounds an unrelated unknown-extension integer riding inside
      // seat_forwardings; supersedeForwardingAliases never reads or writes
      // that field, so widening it to bigint on the way in and spelling it
      // back out losslessly on the way out is sufficient.
      const result = supersedeForwardingAliases(parsePreservingBigint(await Bun.stdin.text()) as RegistryDoc);
      console.log(pyJson(result, 0));
      process.exit(0);
    }
    if (!path || !actor) throw new Error("forwarding arguments required");
    const doc = loadCurrentRegistry(path);
    if (mode === "grant") {
      const grant = forwardingGrant(doc, actor, source, instance);
      if (grant) console.log(rest.includes("--json") ? JSON.stringify({ adopted_from: grant, actor_instance: seatMap(doc)[actor]!.instance }) : grant); else process.exitCode = 1;
    } else if (mode === "route") {
      console.log(JSON.stringify(forwardingRoute(doc, actor, source === "--historical" ? "" : source,
        source === "--historical" || instance === "--historical" || rest.includes("--historical"))));
    } else throw new Error("unknown forwarding operation");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
