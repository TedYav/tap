import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { noMachineIndexError, TapError } from "../context";
import { loadGlobalRegistry } from "../index-home";
import { pyReadUtf8 } from "../spool-publication";
import { observe, table, type RegistryRow } from "./team";
import { teamRegistryRefusal } from "../register-authority";
import { oldBusRefusal, resolveBus } from "../bushome";

interface Diagnostic { team?: string; handle?: string; reason: string; detail?: string }
interface FastSeat { handle: string; harness: string; preset: string; pane: string; status: string; reason: string; attached: boolean }
interface FastTeam { name: string; root: string; active: number; seats: FastSeat[] }
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string => typeof x === "string" ? x : "";

/** Opt-in roster only: shared liveness observation, no transcript/payload/history scans. */
export function cmdAdminFast(argv: string[], scriptsDir: string): number {
  const args = argv[0] === "dashboard" ? argv.slice(1) : argv;
  const json = args.includes("--json");
  const diagnostics: Diagnostic[] = [];
  const teams: FastTeam[] = [];
  try {
    if (!args.includes("--fast") || args.some(arg => arg !== "--fast" && arg !== "--json")) {
      throw new TapError(1, "usage_error", "tap admin dashboard --fast [--json]", "--fast accepts only --json; full-detail and mutation options are incompatible");
    }
    const snapshot = loadGlobalRegistry();
    if (snapshot.marker === "invalid") throw new Error("machine registry is corrupt or unreadable");
    if (snapshot.marker === "absent") throw noMachineIndexError("tap admin");
    const index: unknown = snapshot.doc;
    if (!object(index) || (index.teams !== undefined && !object(index.teams))) throw new Error("machine registry teams must be an object");
    const indexed = (index.teams ?? {}) as Record<string, unknown>;
    const rows: RegistryRow[] = [];
    const byKey = new Map<string, { team: FastTeam; row: FastSeat; delivery: string }>();
    const roots = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const [name, entry] of Object.entries(indexed)) {
      if (!object(entry) || entry.state === "historical" || !str(entry.root)) continue;
      try {
        const root = realpathSync(str(entry.root));
        if (roots.has(root)) ambiguous.add(root);
        roots.set(root, name);
      } catch { /* The per-team reader reports an unreachable root. */ }
    }
    for (const name of Object.keys(indexed).sort()) {
      try {
        const entry = indexed[name];
        if (!object(entry)) throw new Error("team index entry is not an object");
        if (entry.state === "historical") continue;
        if (!str(entry.root) || !isAbsolute(str(entry.root))) throw new Error("team root is missing or not absolute");
        const root = realpathSync(str(entry.root));
        if (ambiguous.has(root)) throw new Error("root has ambiguous team enrollment");
        const bus = resolveBus(root, {});
        if (bus.rule === "old_store") { diagnostics.push({ team: name, reason: "old_store", detail: oldBusRefusal(bus.home).detail }); continue; }
        const registry = str(entry.registry_location);
        if (!registry || !isAbsolute(registry)) throw new Error("acting registry location is missing or not absolute");
        const doc: unknown = JSON.parse(pyReadUtf8(registry));
        if (!object(doc)) throw new Error("acting registry is not an object");
        const oldStore = teamRegistryRefusal(registry, doc);
        if (oldStore) { diagnostics.push({ team: name, reason: "old_store", detail: oldStore.detail }); continue; }
        if (doc.team !== undefined) {
          if (!object(doc.team)) throw new Error("acting team identity is not an object");
          if (doc.team.name !== undefined && doc.team.name !== name) throw new Error("acting team name does not match enrollment");
          if (doc.team.worktree_root !== undefined && realpathSync(str(doc.team.worktree_root)) !== root) throw new Error("acting team root does not match enrollment");
        }
        const seats = doc.seats;
        if (!object(seats)) throw new Error("acting seats must be an object");
        const team: FastTeam = { name, root, active: 0, seats: [] };
        for (const handle of Object.keys(seats).sort()) {
          const seat = seats[handle];
          if (!object(seat)) { diagnostics.push({ team: name, handle, reason: "seat_invalid" }); continue; }
          const textFields = ["status", "delivery", "pane", "pane_id", "session", "registered_at", "server_epoch", "boot_id", "harness", "status_reason"];
          if (textFields.some(field => field in seat && typeof seat[field] !== "string") ||
              (seat.delivery !== undefined && !["", "pane", "poll"].includes(str(seat.delivery)))) {
            diagnostics.push({ team: name, handle, reason: "seat_invalid", detail: "status and identity fields must be strings; delivery must be pane or poll" });
            continue;
          }
          const key = JSON.stringify([name, handle]);
          const row: FastSeat = { handle, harness: str(seat.harness), preset: object(seat.preset) ? str(seat.preset.name) : str(seat.preset), pane: str(seat.pane), status: "unknown", reason: "observation_missing", attached: false };
          team.seats.push(row);
          rows.push({ ...seat, team: name, handle: key } as RegistryRow);
          byKey.set(key, { team, row, delivery: str(seat.delivery) || "pane" });
        }
      } catch (error) { diagnostics.push({ team: name, reason: "registry_unobservable", detail: String(error) }); }
    }
    if (rows.length) {
      // One machine snapshot and one shared classifier for every team. Fast mode
      // reports incomplete observations instead of expanding into per-session probes.
      const observations = observe(rows, scriptsDir, true);
      for (const [key, { team, row, delivery }] of byKey) {
        const fields = observations.code === 0 ? observations.rows.get(key) : undefined;
        row.status = fields?.[0] || "unknown";
        row.reason = fields?.[1] || "observation_failed";
        row.attached = row.status === "active" && Number(fields?.[5] || 0) > 0;
        if (row.status === "active" && delivery === "poll") {
          row.status = "unknown"; row.reason = "poll_liveness_unobservable";
        }
        if (row.status === "active") team.active++;
        if (row.status === "unknown") diagnostics.push({ team: team.name, handle: row.handle, reason: row.reason });
      }
      for (const team of new Set([...byKey.values()].map(value => value.team))) if (team.active > 0) teams.push(team);
    }
  } catch (error) { diagnostics.push({ reason: error instanceof TapError ? error.errorClass : "registry_unobservable", detail: error instanceof Error ? error.message : String(error) }); }
  if (json) process.stdout.write(`${JSON.stringify({ ok: diagnostics.length === 0, fast: true, teams, diagnostics })}\n`);
  else {
    if (!teams.length) process.stdout.write("tap admin dashboard --fast: no verified active teams\n");
    for (const team of teams) {
      process.stdout.write(`tap team: ${team.name} (${team.active} active)\n`);
      process.stdout.write(table(["handle", "harness", "status", "attached", "preset", "pane"], team.seats.map(row => [row.handle, row.harness, row.status, row.attached ? "yes" : "no", row.preset || "-", row.pane || "-"])));
    }
  }
  for (const d of diagnostics) process.stderr.write(`tap admin --fast: ${d.team || "machine"}${d.handle ? `/${d.handle}` : ""}: ${d.reason}${d.detail ? ` (${d.detail})` : ""}\n`);
  return diagnostics.length ? 1 : 0;
}
