// Historical queue observations, never a diagnosis of the current composer.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { envelopeField } from "./envelope";

type Meta = Record<string, unknown>;
type Row = { id: string; meta: Meta; first: number | null; probes: number };
const regular = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
function epoch(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000 ? n : null;
}
function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  if (m < 60) return `${m}m${s ? `${String(s).padStart(2, "0")}s` : ""}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
function rowsFor(spool: string, from: string): Row[] {
  let names: string[];
  try { names = readdirSync(spool); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  const rows: Row[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -10), payload = join(spool, `${id}.md`);
    if (!regular(payload) || ["done", "cancelled"].some(ext => regular(join(dirname(spool), "receipts", `${id}.${ext}`)))) continue;
    try {
      const meta = JSON.parse(readFileSync(join(spool, name), "utf8"));
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.policy === "autosettle") continue;
      if (from && envelopeField(readFileSync(payload, "utf8"), "from") !== from) continue;
      rows.push({ id, meta, first: epoch(meta.first_spooled_epoch), probes: epoch(meta.busy_pending_probes) ?? 0 });
    } catch { /* A malformed row supplies no observation. */ }
  }
  return rows;
}
function report(rows: Row[], target: string, now: number, countMin: number, probesMin: number) {
  rows.sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || a.id.localeCompare(b.id));
  const oldest = rows[0];
  // Count and every timestamp below come from this ONE witness, not the oldest row.
  const witness = [...rows].sort((a, b) => b.probes - a.probes || a.id.localeCompare(b.id))[0];
  const probes = witness?.probes ?? 0;
  const first = witness?.first ?? null;
  const last = epoch(witness?.meta.last_busy_probe_at);
  const span = first !== null && last !== null && first <= last && last <= now ? last - first : null;
  const age = oldest?.first !== null && oldest?.first !== undefined && oldest.first <= now ? now - oldest.first : null;
  const utc = oldest?.first !== null && oldest?.first !== undefined ? new Date(oldest.first * 1000).toISOString().slice(0, 16) + "Z" : null;
  const count = rows.length;
  const line = `${count} payload${count === 1 ? "" : "s"} to ${target} spooled${utc ? ` since ${utc}` : ""} (queue age ${duration(age)}); ` +
    `occupied input observed in ${probes} drain probes for ${witness?.id ?? "unknown"}; parking-to-last-busy-observation span ${duration(span)}; current composer and historical movement unknown`;
  return { condition: count >= countMin && probes >= probesMin, count, target,
    oldest_epoch: oldest?.first ?? null, oldest_utc: utc, age_seconds: age, age_human: duration(age),
    busy_pending_probes: probes, witness_id: witness?.id ?? null,
    witness_parked_epoch: first, last_busy_probe_at: last, parking_to_last_busy_seconds: span,
    ids: rows.map(row => row.id), pane: oldest?.meta.pane || null, pane_id: oldest?.meta.pane_id || null,
    line, remedy: "inspect these queued payloads and their current delivery receipts with tap show <id>; queue history does not authorize pane input" };
}
export function spoolBacklog(spool: string, target: string, from = "", now = Math.floor(Date.now() / 1000), countMin = 2, probesMin = 3) {
  return report(rowsFor(spool, from).filter(row => row.meta.target === target), target, now, countMin, probesMin);
}
export function spoolBacklogs(spool: string, now = Math.floor(Date.now() / 1000), countMin = 2, probesMin = 3) {
  const rows = rowsFor(spool, "");
  return [...new Set(rows.map(row => row.meta.target).filter((target): target is string => typeof target === "string" && !!target))].sort()
    .map(target => report(rows.filter(row => row.meta.target === target), target, now, countMin, probesMin));
}
export function backlogThresholds(env = process.env): [number, number] {
  const countMin = Number(env.TAP_SPOOL_BACKLOG_COUNT ?? 2);
  const probesMin = Number(env.TAP_SPOOL_BACKLOG_PENDING_PROBES ?? 3);
  if (![countMin, probesMin].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid backlog thresholds");
  return [countMin, probesMin];
}

if (import.meta.main) {
  try {
    const [spool, target, from = ""] = Bun.argv.slice(2);
    if (!spool || !target) throw new Error("spool and target required");
    const now = Math.floor(Date.now() / 1000);
    const [countMin, probesMin] = backlogThresholds();
    console.log(JSON.stringify(target === "--all" ? spoolBacklogs(spool, now, countMin, probesMin) : spoolBacklog(spool, target, from, now, countMin, probesMin)));
  } catch (error) { console.error(String(error)); process.exit(2); }
}
