import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type Position = { dev: number; ino: number; offset: number; tail?: string[] };
export type Listing = { mtime: number; ino: number; paths: string[]; filtered: Map<string, string[]> };
type Update = { lines: string[]; gap: boolean; reason?: string };
const TAIL_LINES = 200;
import type { CaptureFidelity } from "./config-file";
type Stream = { bus: string; team: string; drainUntil?: number };
type BusListing = { payloads: string[]; receipts: string[]; active: Set<string> };
export type TraceWindow = { id: string; since: number };

/** Best effort follows live payloads and forgets their cursors after a short drain. */
export class StreamSet {
  private tick = 0;
  private buses = new Map<string, BusListing>();
  private hot = new Map<string, Stream>();
  private previousFidelity: CaptureFidelity = "best-effort";
  private traceId: string | undefined;
  private traceSeen = new Set<string>();
  private recent = new Map<string, Stream>();

  constructor(private positions: Map<string, Position>) {}

  select(buses: Record<string, string>, listings: Map<string, Listing>, fidelity: CaptureFidelity = "best-effort", stat = statSync, trace?: TraceWindow): Map<string, string> {
    this.tick++;
    const traceChanged = this.traceId !== trace?.id;
    if (traceChanged) { this.traceSeen.clear(); this.recent.clear(); this.traceId = trace?.id; }
    const selected = new Map<string, string>();
    for (const [bus, team] of Object.entries(buses)) {
      selected.set(join(bus, "registry-events.log"), team);
      selected.set(join(bus, "tap-deliver.log"), team);
      const payloads = listed(join(bus, "payloads"), "", listings, stat);
      const receipts = listed(join(bus, "receipts"), "", listings, stat);
      let cached = this.buses.get(bus);
      const payloadsChanged = cached?.payloads !== payloads;
      if (!cached || cached.payloads !== payloads || cached.receipts !== receipts) {
        const live = new Set(payloads.filter(p => p.endsWith(".md")).map(p => basename(p).slice(0, -3)));
        const terminal = new Set(receipts.filter(p => /\.(done|cancelled)$/.test(p)).map(p => basename(p).replace(/\.(done|cancelled)$/, "")));
        const active = new Set(payloads.filter(path => {
          if (!path.endsWith(".attempts")) return false;
          const id = basename(path).replace(/(?:\.debug)?\.attempts$/, "");
          return live.has(id) && !terminal.has(id);
        }));
        cached = { payloads, receipts, active }; this.buses.set(bus, cached);
      }
      for (const path of cached.active) this.hot.set(path, { bus, team });
      if (trace) {
        // One admission inventory per trace, then only newly discovered paths.
        // In-place writes to older cold files are intentionally not observed.
        if (traceChanged || payloadsChanged) for (const path of payloads) {
          if (!path.endsWith(".attempts") || this.traceSeen.has(path)) continue;
          this.traceSeen.add(path);
          try {
            const info = stat(path, { throwIfNoEntry: false });
            if (info?.isFile() && info.mtimeMs >= trace.since) this.recent.set(path, { bus, team });
          } catch {
            // Let the per-source reader report capture.gap and retry this path.
            this.recent.set(path, { bus, team });
          }
        }
      } else if (fidelity === "precise") for (const path of payloads) if (path.endsWith(".attempts")) selected.set(path, team);
    }
    for (const [path, stream] of this.hot) {
      if (!(stream.bus in buses)) {
        this.hot.delete(path); this.positions.delete(path); continue;
      }
      if (!this.buses.get(stream.bus)!.active.has(path)) stream.drainUntil ??= this.tick + 2;
      if (stream.drainUntil !== undefined && this.tick > stream.drainUntil) {
        this.hot.delete(path);
        if (fidelity === "best-effort") this.positions.delete(path);
      } else selected.set(path, stream.team);
    }
    for (const bus of this.buses.keys()) if (!(bus in buses)) this.buses.delete(bus);
    for (const [path, stream] of this.recent) {
      if (stream.bus in buses) selected.set(path, stream.team);
      else this.recent.delete(path);
    }
    // Returning from a precise trace also discards cursors for historical files.
    if (fidelity === "best-effort" && this.previousFidelity === "precise") {
      for (const path of this.positions.keys()) if (path.endsWith(".attempts") && !this.hot.has(path)) this.positions.delete(path);
    }
    this.previousFidelity = fidelity;
    return selected;
  }
}

/** Share one directory listing across consumers of different filename suffixes. */
export function listed(directory: string, suffix: string, listings: Map<string, Listing>, stat = statSync): string[] {
  const info = stat(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory()) { listings.delete(directory); return []; }
  let cached = listings.get(directory);
  if (!cached || cached.mtime !== info.mtimeMs || cached.ino !== info.ino) {
    let paths: string[];
    try { paths = readdirSync(directory).map(p => join(directory, p)); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) throw error;
      listings.delete(directory); return [];
    }
    cached = { mtime: info.mtimeMs, ino: info.ino, paths, filtered: new Map() };
    listings.set(directory, cached);
  }
  if (!suffix) return cached.paths;
  let paths = cached.filtered.get(suffix);
  if (!paths) { paths = cached.paths.filter(p => p.endsWith(suffix)); cached.filtered.set(suffix, paths); }
  return paths;
}

function overlap(old: string[], lines: string[]): { count: number; ambiguous: boolean } {
  // A writer configured to retain more than our cursor window leaves the
  // complete anchor inside the new file, rather than at its first line.
  if (old.length && lines.length > TAIL_LINES) {
    let end: number | undefined;
    for (let start = 0; start <= lines.length - old.length; start++) {
      if (!old.every((line, i) => line === lines[start + i])) continue;
      if (end !== undefined) return { count: end, ambiguous: true };
      end = start + old.length;
    }
    if (end !== undefined) return { count: end, ambiguous: old.every(line => line === old[0]) };
  }
  let count = 0, matches = 0;
  for (let size = 1; size <= Math.min(old.length, lines.length); size++) {
    if (old.slice(-size).every((line, i) => line === lines[i])) { count = size; matches++; }
  }
  // A repeated window can represent several different append counts. Report a gap
  // in that case, including periodic windows with multiple anchors.
  return { count, ambiguous: matches > 1 || (count === 1 && lines.length === 1) };
}

export function streamUpdates(path: string, positions: Map<string, Position>, baseline: boolean, fidelity: CaptureFidelity = "best-effort", statPath = statSync): Update {
  const quick = statPath(path, { throwIfNoEntry: false }), old = positions.get(path);
  if (!quick?.isFile()) return { lines: [], gap: false };
  if (old && old.dev === quick.dev && old.ino === quick.ino && old.offset === quick.size) return { lines: [], gap: false };
  const bounded = basename(path) === "registry-events.log", fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const changed = !!old && (old.dev !== stat.dev || old.ino !== stat.ino || stat.size < old.offset);
    // Bounded logs need a baseline anchor even though startup emits no history.
    let offset = old && !changed ? old.offset : baseline && !bounded ? stat.size : 0;
    const chunks: Buffer[] = []; let count = offset;
    while (count < stat.size) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - count));
      const n = readSync(fd, buffer, 0, buffer.length, count);
      if (!n) break;
      chunks.push(buffer.subarray(0, n)); count += n;
    }
    const bytes = Buffer.concat(chunks), lines: string[] = []; let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      lines.push(bytes.subarray(start, end).toString("utf8").replace(/[\r\n]+$/, ""));
      start = end + 1;
    }
    offset += start;
    const tail = bounded ? [...(!changed ? old?.tail ?? [] : []), ...lines].slice(-TAIL_LINES) : undefined;
    positions.set(path, { dev: stat.dev, ino: stat.ino, offset: baseline ? stat.size : offset, ...(bounded ? { tail } : {}) });
    if (baseline) return { lines: [], gap: false };
    if (changed && bounded && fidelity === "best-effort") {
      const match = overlap(old?.tail ?? [], lines);
      if (!match.count || match.ambiguous) return { lines: [], gap: true,
        reason: match.count ? "bounded_log_rewritten_ambiguous" : "bounded_log_rewritten_no_overlap" };
      return { lines: lines.slice(match.count), gap: false };
    }
    return { lines, gap: changed };
  } finally { closeSync(fd); }
}
