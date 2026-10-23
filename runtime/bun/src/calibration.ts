// Explicitly read observations. No launcher, roster or preset path consumes this store.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireNoFollowLock } from "./digest-window";
export { collectCalibrationRoutes, resolveCalibrationRoute, calibrationCandidates } from "./calibration-routes";

export interface Observation {
  id: string;
  at: string;
  route: string;
  effort?: string | null;
  by: string;
  ref: string;
  note: string;
}
const day = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();

function validate(row: Omit<Observation, "id">): void {
  if (![row.at, row.route, row.by, row.ref, row.note].every(text)) throw new Error("empty calibration field or note");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.at) || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString().slice(0, 10) !== row.at) throw new Error("invalid calibration date");
  if (!/^[^\s/]+\/\S+$/.test(row.route)) throw new Error("invalid calibration route");
  if (row.effort != null && !text(row.effort)) throw new Error("invalid calibration effort");
}

/** Canonical tuple avoids property-order dependence; GC may retain an earlier ID. */
export function makeObservation(input: Omit<Observation, "id">): Observation {
  const row = { at: input.at, route: input.route, ...(input.effort ? { effort: input.effort } : {}), by: input.by, ref: input.ref, note: input.note.trim() };
  validate(row);
  const id = createHash("sha256").update(JSON.stringify([row.at, row.route, row.effort ?? null, row.by, row.ref, row.note])).digest("hex").slice(0, 8);
  return { id, ...row };
}

export function readObservations(path: string): { rows: Observation[]; bytes: number } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], bytes: 0 }; throw error; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("calibration store is not a regular file");
    const bytes = readFileSync(fd);
    return { rows: parseObservations(bytes), bytes: bytes.length };
  } finally { closeSync(fd); }
}

/** Validate the exact snapshot a GC helper will publish, without reopening it. */
export function parseObservations(bytes: Uint8Array): Observation[] {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source && !source.endsWith("\n")) throw new Error("calibration store has an incomplete final row; preserve and repair it before appending");
    const rows = source ? source.slice(0, -1).split("\n").map((line, i): Observation => {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !/^[a-f0-9]{8}$/.test(row.id) ||
            Object.keys(row).some(key => !["id", "at", "route", "effort", "by", "ref", "note"].includes(key))) throw new Error("invalid row shape");
        validate(row);
        return row;
      } catch (error) { throw new Error(`calibration row ${i + 1}: ${(error as Error).message}`); }
    }) : [];
    return rows;
}

/** GC must use this same sidecar for its compare-and-replace lost-append guard. */
export function appendObservation(path: string, row: Observation, timeoutMs = 2500): void {
  validate(row);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = acquireNoFollowLock(`${path}.lock`, timeoutMs);
  try {
    readObservations(path); // Never append behind a truncated or malformed row.
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("calibration store is not a regular file");
      appendFileSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } finally { closeSync(lock); }
}

export function noteHints(note: string): string[] {
  const hints: string[] = [];
  if (/\b(?:avoid|never)\b/i.test(note) && !/\b(?:because|since|when|after|due to)\b|[:;]|[—–]/i.test(note)) hints.push("name the cause: what you saw, under what conditions, then what you advise");
  if (note.length > 400) hints.push("note exceeds 400 characters; a shorter observation is easier to compare");
  return hints;
}

const age = (at: string, now: string) => Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / day));
export function gcHint(rows: Observation[], bytes: number, now = today()): string {
  const old = rows.filter(row => age(row.at, now) > 90).length;
  const reasons = [old ? `${old} ${old === 1 ? "note" : "notes"} older than 90 days` : "", bytes > 16384 ? "store exceeds 16 KB" : ""].filter(Boolean);
  return reasons.length ? `Consider tap help skill calibrate-gc (frontier seat): ${reasons.join("; ")}.` : "";
}

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const clip = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
function displayRef(ref: string): string {
  return clean(ref).replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, "session").replace(/\bses[_-][\w-]+\b/g, "session");
}
export function newestObservations(rows: Observation[]): Observation[] {
  // Stable sort keeps newest append first for observations recorded on the same day.
  return [...rows].reverse().sort((a, b) => b.at.localeCompare(a.at));
}

interface RenderOptions { target?: string; all?: boolean; now?: string; hint?: string; width?: number }
export function renderCalibration(rows: Observation[], candidates: string[], options: RenderOptions = {}): string {
  const now = options.now ?? today();
  const digest = !options.target;
  const routes = options.target ? [options.target] : [...new Set(candidates)].sort();
  const result: string[] = [];
  const sorted = newestObservations(rows);
  const totalLines = digest ? 25 : Infinity;
  const reserve = options.hint ? 1 : 0;
  const width = options.width && Number.isFinite(options.width) && options.width >= 20 ? Math.floor(options.width) : 88;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index]!;
    const notes = sorted.filter(row => row.route === route);
    const block = renderRoute(route, notes, now, digest, !!options.all, options.hint ?? "", width);
    // Reserve an honest expansion pointer whenever later routes cannot fit.
    if (result.length + block.length + reserve + (index < routes.length - 1 ? 1 : 0) > totalLines) {
      result.push(`${routes.length - index} routes omitted: tap calibrate <route> [--all]`);
      break;
    }
    result.push(...block);
  }
  if (!routes.length) result.push("No candidate routes in the roster or presets.");
  if (options.hint) result.push(options.hint);
  return `${result.join("\n")}\n`;
}

function wrap(line: string, width = 88): string[] {
  const lines: string[] = [];
  while (line.length > width) {
    const space = line.lastIndexOf(" ", width);
    const end = space > 10 ? space : width;
    lines.push(line.slice(0, end));
    line = line.slice(end).trimStart();
  }
  if (line) lines.push(line);
  return lines;
}

// Stop before allocating wrapped output for a note that cannot fit. Normalize
// whitespace as clean() does, so a long whitespace run alone does not omit it.
function boundedNote(value: string, budget: number): string | null {
  let note = "";
  let space = "";
  for (const char of value) {
    if (/[\s\x00-\x1f\x7f-\x9f]/.test(char)) { space = note ? " " : ""; continue; }
    if (note.length + space.length + char.length > budget) return null;
    note += space + char;
    space = "";
  }
  return note;
}

function renderRoute(route: string, rows: Observation[], now: string, digest: boolean, all: boolean, hint: string, width: number): string[] {
  const noun = (count: number) => count === 1 ? "note" : "notes";
  let shown = 0;
  const bounded = digest || !all;
  const limit = 10 - (hint ? 1 : 0);
  const budget = 880 - (hint ? hint.length + 1 : 0);
  const visible = rows.slice(0, digest ? 2 : undefined);
  const footer = (count: number, oversized = false) => wrap(oversized
    ? `${count} ${noun(count)} exceed${count === 1 ? "s" : ""} default budget: rerun this route with --all`
    : `${count} older ${noun(count)}: rerun this route with --all`, width);
  const header = (routeLimit: number) => wrap(`${clip(clean(route), routeLimit)} (${rows.length ? `${rows.length} ${noun(rows.length)}, newest ${age(rows[0]!.at, now)}d` : "no notes"})  observations, not rankings`, width);
  let lines = header(100);
  // Even when no note fits, leave room for the complete expansion pointer.
  const fallback = rows.length ? footer(rows.length, true) : [];
  for (let routeLimit = 99; bounded && routeLimit > 0 &&
      (lines.length + fallback.length > limit || [...lines, ...fallback].join("\n").length + 1 > budget); routeLimit--) {
    lines = header(routeLimit);
  }
  for (const row of visible) {
    const note = bounded ? boundedNote(row.note, budget) : clean(row.note);
    if (note === null) break;
    const prefix = `- [${age(row.at, now)}d${row.effort ? `, ${clip(clean(row.effort), 16)}` : ""}] `;
    const reference = bounded ? displayRef(row.ref).split(/\s*[,;]\s*/, 1)[0]! : displayRef(row.ref);
    const attribution = ` (${clip(clean(row.by), 48)}, ${clip(reference, 64)})`;
    const bullet = bounded ? wrap(`${prefix}${note}`, width) : [`${prefix}${note}${attribution}`];
    if (bounded) {
      const last = bullet.length - 1;
      if (bullet[last]!.length + attribution.length <= width) bullet[last] += attribution;
      else bullet.push(...wrap(attribution.trimStart(), width));
    }
    // Spend the route budget on complete newest observations, with room for an
    // honest pointer if the next older observation cannot fit in full.
    const pointer = shown + 1 < rows.length ? footer(rows.length - shown - 1) : [];
    const candidate = [...lines, ...bullet, ...pointer];
    if (bounded && (candidate.length > limit || candidate.join("\n").length + 1 > budget)) break;
    lines.push(...bullet);
    shown++;
  }
  if (shown < rows.length) lines.push(...footer(rows.length - shown, shown === 0));
  return lines;
}
