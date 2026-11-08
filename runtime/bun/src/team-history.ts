// `tap team history` — every seat that has been on the team: the tombstones
// `tap out` writes under `<root>/.tap/team-history/`, plus the current roster.
// That directory is large (~10k entries live), so only history, restore and
// `refresh --stale` read it, never a hot path such as poll, send or roster.
// Read-only except `appendRestoreRecord`, which `tap restore <handle>@N` calls
// after it re-adds a row. Tombstones (`<handle>.<retired_by>.<ts>.json`) are
// never renamed or rewritten.
//
// THE INDEX IS STABLE BY CONSTRUCTION. `<handle>@N` counts that handle's
// departures oldest first, starting at 1. A new retirement always sorts last,
// so it takes the next number and no existing index moves. Restoring an entry
// never deletes or rewrites its tombstone; the restore is recorded beside it in
// `<handle>.restores.jsonl`, so `@N` keeps naming the same departure and history
// shows that it came back. `@` is outside the handle charset (`validToken`), so
// `opus@2` cannot be a handle.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TapError, resolveContext, type ResolvedContext } from "./context";
import { renderRefusals } from "./error-line";
import { validToken } from "./ids";
import { loadRegistry, seatMap } from "./registry";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Harnesses whose native id `tap session resume` can target exactly (transaction.ts exact revival set). */
export const RESUMABLE_HARNESSES = new Set(["claude", "codex", "opencode", "cursor", "agy"]);
export const DEFAULT_LIMIT = 50;

export interface RestoreRecord { tombstone: string; restored_as: string; restored_at: string }

export interface HistoryEntry {
  handle: string;
  /** `@N` for a departure; null for a seat on the team now. */
  index: number | null;
  onTeam: boolean;
  instance: string;
  harness: string;
  model: string;
  /** ISO timestamps as recorded; null when unknown. */
  created: string | null;
  retiredAt: string | null;
  lengthSeconds: number | null;
  nativeId: string;
  resumable: boolean;
  /** Tombstone file name (departures only). */
  tombstone: string;
  restored: RestoreRecord[];
  row: Row;
}

export interface TeamHistory { entries: HistoryEntry[]; unreadable: number }

export const historyDir = (root: string): string => join(root, ".tap", "team-history");

/** Parse a recorded timestamp to epoch seconds: ISO with any fraction or zone, or the compact `20261103T120000Z`. */
export function parseStamp(raw: unknown): number | null {
  const value = text(raw);
  if (!value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) / 1000;
  }
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!iso) return null;
  const ms = (iso[2] ?? "").slice(0, 3).padEnd(3, "0");
  const parsed = Date.parse(`${iso[1]}.${ms}${iso[3] ?? "Z"}`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/** A row can come back through `tap session resume` only with an exact native id on a pane-backed, non-crew seat. */
export function rowResumable(row: Row): boolean {
  return RESUMABLE_HARNESSES.has(text(row.harness)) && !!text(row.harness_session_id)
    && row.crew !== true && text(row.delivery) !== "poll";
}

function modelOf(row: Row): string {
  return record(row.launch_tuning) ? text(row.launch_tuning.model) || text(row.model) : text(row.model);
}

/** Earliest lineage `ts` per instance for one handle; an unreadable lineage file just contributes nothing. */
function lineageStarts(dir: string, handle: string): Map<string, number> {
  const out = new Map<string, number>();
  let body = "";
  try { body = readFileSync(join(dir, `${handle}.lineage.jsonl`), "utf8"); } catch { return out; }
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!record(event)) continue;
      const instance = text(event.instance), ts = parseStamp(event.ts);
      if (!instance || ts === null) continue;
      const prior = out.get(instance);
      if (prior === undefined || ts < prior) out.set(instance, ts);
    } catch { /* one bad line never hides the rest */ }
  }
  return out;
}

function restoreRecords(dir: string, handle: string): RestoreRecord[] {
  let body = "";
  try { body = readFileSync(join(dir, `${handle}.restores.jsonl`), "utf8"); } catch { return []; }
  const out: RestoreRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (record(event) && text(event.tombstone)) out.push({ tombstone: text(event.tombstone), restored_as: text(event.restored_as), restored_at: text(event.restored_at) });
    } catch { /* skip */ }
  }
  return out;
}

/** Record that a departure came back. Its tombstone stays exactly as written. */
export function appendRestoreRecord(root: string, entry: HistoryEntry, restoredAs: string, at = new Date()): void {
  const dir = historyDir(root);
  mkdirSync(dir, { recursive: true });
  // Keyed by tombstone file name, never by `@N`: a record can only ever name the departure it restored.
  const line = { handle: entry.handle, instance: entry.instance, tombstone: entry.tombstone,
    restored_as: restoredAs, restored_at: at.toISOString().replace(/\.\d{3}Z$/, "Z") };
  appendFileSync(join(dir, `${entry.handle}.restores.jsonl`), `${JSON.stringify(line)}\n`);
}

const iso = (seconds: number | null): string | null => seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Every departure in the history directory, indexed, plus the current seats.
 * An unreadable or malformed tombstone is skipped and counted; it never fails
 * the read. A history directory that exists but cannot be listed is a failure.
 */
export function readTeamHistory(root: string, current: Record<string, Row>, now = Date.now() / 1000, only = ""): TeamHistory {
  const dir = historyDir(root);
  let names: string[] = [];
  let exists = false;
  try { exists = statSync(dir).isDirectory(); } catch { exists = false; }
  if (exists) names = readdirSync(dir);
  let unreadable = 0;
  const departures = new Map<string, Array<{ name: string; data: Row }>>();
  // One readdir; with a handle, the filename prefix filters before any JSON is parsed.
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || (only && !name.startsWith(`${only}.`))) continue;
    let data: unknown;
    try { data = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { unreadable++; continue; }
    if (!record(data) || !validToken(text(data.handle)) || !name.startsWith(`${text(data.handle)}.`)) { unreadable++; continue; }
    const handle = text(data.handle);
    // `opus.` also prefixes a dotted neighbour such as `opus.x`; that file is someone else's, not unreadable.
    if (only && handle !== only) continue;
    if (!departures.has(handle)) departures.set(handle, []);
    departures.get(handle)!.push({ name, data });
  }
  const entries: HistoryEntry[] = [];
  const handles = new Set([...departures.keys(), ...Object.keys(current).filter(handle => !only || handle === only)]);
  for (const handle of handles) {
    const starts = lineageStarts(dir, handle);
    const restores = restoreRecords(dir, handle);
    const createdOf = (row: Row, instance: string): number | null => starts.get(instance) ?? parseStamp(row.registered_at);
    // Oldest first; a missing retired_at sorts first, so every new retirement takes the next number.
    // retired_at has one-second resolution and the filename carries a random suffix, so a same-second
    // tie falls to the file's birth time (when it was written), and only then to the name.
    const born = new Map<string, number>();
    const birth = (name: string): number => {
      if (!born.has(name)) {
        let ms = 0;
        try { ms = statSync(join(dir, name)).birthtimeMs; } catch { ms = 0; }
        born.set(name, Number.isFinite(ms) ? ms : 0);
      }
      return born.get(name)!;
    };
    const list = (departures.get(handle) ?? []).sort((a, b) => {
      const ka = text(a.data.retired_at), kb = text(b.data.retired_at);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const ba = birth(a.name), bb = birth(b.name);
      if (ba !== bb) return ba - bb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    list.forEach(({ name, data }, i) => {
      const row = record(data.row) ? data.row : {};
      const instance = text(data.instance) || text(row.instance);
      const created = createdOf(row, instance), retired = parseStamp(data.retired_at);
      entries.push({
        handle, index: i + 1, onTeam: false, instance, harness: text(row.harness), model: modelOf(row),
        created: iso(created), retiredAt: text(data.retired_at) || null,
        lengthSeconds: created !== null && retired !== null && retired >= created ? retired - created : null,
        nativeId: text(row.harness_session_id), resumable: rowResumable(row) && !!text(row.session), tombstone: name,
        restored: restores.filter(r => r.tombstone === name), row,
      });
    });
    const live = current[handle];
    if (record(live)) {
      const instance = text(live.instance), created = createdOf(live, instance);
      entries.push({
        handle, index: null, onTeam: true, instance, harness: text(live.harness), model: modelOf(live),
        created: iso(created), retiredAt: null, lengthSeconds: created !== null && now >= created ? Math.floor(now - created) : null,
        nativeId: text(live.harness_session_id), resumable: rowResumable(live), tombstone: "", restored: [], row: live,
      });
    }
  }
  // Current seats first, then newest departure first.
  entries.sort((a, b) => {
    if (a.onTeam !== b.onTeam) return a.onTeam ? -1 : 1;
    if (a.onTeam) return a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0;
    const ka = a.retiredAt ?? "", kb = b.retiredAt ?? "";
    return ka > kb ? -1 : ka < kb ? 1 : a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : (b.index ?? 0) - (a.index ?? 0);
  });
  return { entries, unreadable };
}

export const entryRef = (entry: HistoryEntry): string => entry.index === null ? entry.handle : `${entry.handle}@${entry.index}`;

/** `opus@2` → {handle, index}; a bare handle → index null; anything else is refused by the caller. */
export function parseRef(raw: string): { handle: string; index: number | null } | null {
  const at = raw.lastIndexOf("@");
  if (at < 0) return validToken(raw) ? { handle: raw, index: null } : null;
  const handle = raw.slice(0, at), digits = raw.slice(at + 1);
  if (!validToken(handle) || !/^[1-9]\d*$/.test(digits)) return null;
  return { handle, index: Number(digits) };
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(seconds / 86400)}d${String(Math.floor((seconds % 86400) / 3600)).padStart(2, "0")}h`;
}

const shortStamp = (value: string | null): string => {
  if (!value) return "-";
  const seconds = parseStamp(value);
  return seconds === null ? value : new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
};

export function entryJson(entry: HistoryEntry): Record<string, unknown> {
  return {
    ref: entryRef(entry), handle: entry.handle, index: entry.index, on_team: entry.onTeam, instance: entry.instance || null,
    harness: entry.harness || null, model: entry.model || null, session_created: entry.created, retired_at: entry.retiredAt,
    session_length_seconds: entry.lengthSeconds, harness_session_id: entry.nativeId || null, resumable: entry.resumable,
    tombstone: entry.tombstone || null, restored: entry.restored.map(r => ({ restored_as: r.restored_as, restored_at: r.restored_at })),
  };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n") + "\n";
}

export function renderHistory(entries: HistoryEntry[]): string {
  const rows = entries.map(entry => [
    entryRef(entry), entry.harness || "-", entry.model || "-", shortStamp(entry.created),
    entry.onTeam ? "on team" : shortStamp(entry.retiredAt), formatDuration(entry.lengthSeconds),
    entry.nativeId ? entry.nativeId.slice(0, 8) : "-",
    (entry.resumable ? "yes" : "no") + (entry.restored.length ? ` (restored as ${entry.restored.at(-1)!.restored_as})` : ""),
  ]);
  return table(["SEAT", "HARNESS", "MODEL", "CREATED", "TAPPED OUT", "LENGTH", "NATIVE ID", "RESUMABLE"], rows);
}

interface HistoryOptions { handle: string; all: boolean; json: boolean; team?: string }

function parseHistoryOptions(argv: string[]): HistoryOptions {
  const out: HistoryOptions = { handle: "", all: false, json: false };
  const fail = (cls: string, detail: string): never => { throw new TapError(1, cls, "tap help team history", detail, "tap team history"); };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--team") { const v = argv[++i]; if (!v || v.startsWith("-")) fail("usage_error", "--team needs a team name"); out.team = v; }
    else if (arg.startsWith("--team=")) out.team = arg.slice(7);
    else if (arg.startsWith("-")) fail("unknown_option", `unknown option '${arg}'`);
    else if (!out.handle) {
      if (!validToken(arg)) fail("invalid_handle", `invalid handle '${arg}' (history lists one handle; use tap team history ${arg.split("@")[0]})`);
      out.handle = arg;
    } else fail("usage_error", `unexpected argument '${arg}'`);
  }
  return out;
}

export function currentSeats(ctx: ResolvedContext): Record<string, Row> {
  try { statSync(ctx.registryPath); } catch { return {}; }
  return seatMap(loadRegistry(ctx.registryPath)) as Record<string, Row>;
}

export function cmdTeamHistory(argv: string[]): number {
  const json = argv.includes("--json") || process.env.TAP_JSON === "1";
  return renderRefusals("tap team history", () => {
    const opts = parseHistoryOptions(argv);
    const ctx = resolveContext(process.cwd(), process.env, opts.team ? { explicitTeam: opts.team } : undefined);
    const history = readTeamHistory(ctx.root, currentSeats(ctx), Date.now() / 1000, opts.handle);
    const matching = history.entries.filter(entry => !opts.handle || entry.handle === opts.handle);
    const departed = matching.filter(entry => !entry.onTeam);
    const shown = opts.all ? matching : [...matching.filter(entry => entry.onTeam), ...departed.slice(0, DEFAULT_LIMIT)];
    const hidden = matching.length - shown.length;
    if (history.unreadable) process.stderr.write(`tap team history: skipped ${history.unreadable} unreadable tombstone(s) under ${historyDir(ctx.root)}\n`);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, team: ctx.team, entries: shown.map(entryJson), hidden, unreadable: history.unreadable })}\n`);
      return 0;
    }
    if (!shown.length) {
      process.stdout.write(opts.handle ? `tap team history: no seat named '${opts.handle}' has been on team '${ctx.team}'\n` : `tap team history: no seats recorded on team '${ctx.team}'\n`);
      return 0;
    }
    process.stdout.write(renderHistory(shown));
    if (hidden) process.stdout.write(`${hidden} older departure(s) hidden; tap team history${opts.handle ? ` ${opts.handle}` : ""} --all shows everything\n`);
    if (departed.some(entry => entry.resumable)) process.stdout.write("restore one: tap restore <seat>@<n>\n");
    return 0;
  }, { ...process.env, TAP_JSON: json ? "1" : "0" });
}
