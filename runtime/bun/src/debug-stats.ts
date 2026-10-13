// `tap debug stats`: nightly delivery and same-id retry counts, joined by bus and
// message id (skills/tap/protocol/delivery/receipt-measures.md). Read-only: it
// never writes, locks or mutates a bus. Duplicates are the point: an extra ring
// is a second pane ring of one message, and a rising rate means retry needs tuning.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RETRY_MARKER_SUFFIX, retryHistory, rowRetry } from "./retry";
import { GENERATIONS_KEPT, sendRefusalLogPath } from "./send-refusal-log";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Provisional heuristic: above 1% extra rings over the last 1,000 pane messages, tune retry. */
export const ROLLING_WINDOW = 1000, TUNE_THRESHOLD = 0.01, LOOP_RETRIES = 3;

export type Ratio = { num: number; den: number; rate: number | null };
/** Retries with no recorded outcome or suppression, reconciled per retry uuid. */
/** consumed: requested, never licensed, its row gone, and the message since read, settled or cancelled
 *  (a read or a cancel took the row before the drain): a deliberate no-effect disposition. */
export type Unresolved = { pending: number; queued: number; unknown: number; interrupted: number; consumed: number };
export interface Counts {
  placed: number; cancelled: number; recipient_observed: number; observed_rate: Ratio;
  /** Send refusals by UTC date, outside `placed` and every rate; null when the refusal log is unavailable. */
  refused_pre: number | null; refused_withdrawn: number | null;
  initial_unverified: number; retry_requests: number; retries_suppressed: number; retry_outcomes: Record<string, number>;
  retry_unresolved: Unresolved;
  extra_rings: number; retry_first_rings: number; known_redundant: number; redundancy_unknown: number;
  first_observed_after_retry: number; extra_ring_rate: Ratio; redundant_rate: Ratio;
  unobserved: { under_1h: number; from_1h_to_24h: number; over_24h: number };
}
/** `refusals_incomplete`: rotation may have dropped this night's refusal lines. */
export type Night = Counts & { date: string; partial: boolean; refusals_incomplete: boolean };
export type BusRef = { team: string; bus: string };
export interface Stats {
  as_of: string; days: number; buses: number; nights: Night[]; total: Counts;
  rolling: { window: number; messages: number; since: string | null; extra_rings: number; rate: Ratio; threshold: number; tune: boolean };
  loops: (BusRef & { id: string; admitted_retries: number; date: string })[];
  invalid_placed: number;
  /** Placements dated after `as_of` (a sender clock later corrected): skipped, never a night or a rolling member. */
  future_placed: number;
  retry_records_unavailable: BusRef[]; buses_unreachable: (BusRef & { reason: string })[];
  /** Torn or foreign retry-history lines, or a history that exists but cannot be read: that id's retry counts are incomplete. */
  /** Per-id retry evidence that could not be fully used: torn or unreadable history, history missing
   *  beside retry markers or a retry row, or markers that do not parse or name another id. */
  retry_history_malformed: (BusRef & { id: string; malformed_lines: number; unreadable: boolean; missing?: true; invalid_markers?: number })[];
  /** Buses with in-window mail but no readable registry-events.log: their initial-unverified count is unknown, not zero. */
  initial_unverified_unavailable: BusRef[];
  /** The machine send-refusal log and its rotated generations. */
  refusals: { available: boolean; log: string; files: number; unreadable_files: number; malformed_lines: number;
    oldest: string | null; incomplete_before: string | null };
}

type Stamp = { ms: number; res: number };
type Marker = { name: string; uuid: string };
type Listing = {
  /** Receipt file name → the receipts directory holding it; the active `receipts/` overrides an archive month. */
  dir: Map<string, string>;
  placed: Set<string>; attempted: Set<string>; sent: Set<string>; retries: Set<string>; markers: Map<string, Marker[]>;
};
type Message = { bus: string; team: string; id: string; ms: number; listing: Listing };
type Context = { unverified: Set<string> | null; malformed: Stats["retry_history_malformed"]; now: number };

const ratio = (num: number, den: number): Ratio => ({ num, den, rate: den ? num / den : null });
const named = (value: unknown) => typeof value === "string" && value !== "";
const nonAuthoritative = (r: Record<string, unknown>) => String(r.forced) === "true" || r.reason === "instance_retired";
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** `at` fields are mostly whole-second utcStamps (floored); `res` is the window the true instant lies in. */
function stamp(value: unknown): Stamp | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { ms, res: /:\d{2}\.\d/.test(value) ? 1 : 1000 } : null;
}

/** A receipt that parses and names the same id (receipt-measures' join rule), wherever the id's receipts live. */
function receipt(listing: Listing, id: string, suffix: string): Record<string, unknown> | null {
  const name = `${id}.${suffix}`, directory = listing.dir.get(name);
  if (!directory) return null;
  try {
    const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
    return value && typeof value === "object" && value.id === id ? value : null;
  } catch { return null; }
}

/** `tap bus archive` moves an id's receipts to `archive/<YYYY-MM>/receipts/`: every month's directory, newest first. */
function archiveDirectories(bus: string): string[] {
  let entries;
  try { entries = readdirSync(join(bus, "archive"), { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(errno(error)!)) return []; throw error; }
  return entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name)).map(e => e.name).sort().reverse()
    .map(month => join(bus, "archive", month, "receipts"));
}

/**
 * One readdir per receipts directory, active first, then each archive month;
 * never a per-id scan of a directory holding tens of thousands of entries. The
 * map is per file, so an archive interrupted between copy and unlink still
 * resolves each receipt to one complete copy.
 */
function listReceipts(bus: string): Listing {
  const listing: Listing = { dir: new Map(), placed: new Set(), attempted: new Set(), sent: new Set(), retries: new Set(), markers: new Map() };
  for (const directory of [join(bus, "receipts"), ...archiveDirectories(bus)]) {
    let names: string[];
    try { names = readdirSync(directory); }
    catch (error) { if (errno(error) === "ENOENT") continue; throw error; }
    for (const name of names) {
      if (listing.dir.has(name)) continue;
      listing.dir.set(name, directory);
      const marker = RETRY_MARKER_SUFFIX.exec(name);
      if (marker) {
        const id = name.slice(0, marker.index);
        listing.markers.set(id, [...listing.markers.get(id) ?? [], { name, uuid: marker[1]! }]);
        continue;
      }
      for (const [suffix, set] of [[".placed", listing.placed], [".attempted", listing.attempted], [".sent", listing.sent], [".retries.jsonl", listing.retries]] as const)
        if (name.endsWith(suffix)) { set.add(name.slice(0, -suffix.length)); break; }
    }
  }
  return listing;
}

/** The pane attempts that open a message's delivery: a direct send's or the spool drain's first ring. */
const INITIAL_UNVERIFIED = new Set(["action=send_submit_unverified", "action=redelivery_submit_unverified"]);

/**
 * Ids whose initial submit the bounded registry-events tail still logs as
 * unverified. A same-id retry logs `retry_submit_unverified`, which never
 * counts here. Null when the bus has no readable log: unknown, not zero.
 */
function unverifiedIds(bus: string): Set<string> | null {
  let text: string;
  try { text = readFileSync(join(bus, "registry-events.log"), "utf8"); } catch { return null; }
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    // Whole-field match, as tap outstanding does (tap-z63i): ids never contain `=`, so a
    // `_notice_id=` tail marks the one composite detail the courier writes.
    const fields = line.split(" ");
    if (!fields.some(field => INITIAL_UNVERIFIED.has(field))) continue;
    for (const field of fields) {
      if (!field.startsWith("detail=id=")) continue;
      const value = field.slice("detail=id=".length), tail = value.indexOf("_notice_id=");
      ids.add(tail < 0 ? value : value.slice(0, tail));
    }
  }
  return ids;
}

/** send-refusal-log.ts's generation name; mirrored because that module does not export it. */
const REFUSAL_GENERATION = /^send-refusals\.log\.\d{8}T\d{6}Z-\d+-[a-z0-9]{1,8}$/;
type Refusals = Stats["refusals"] & { byDate: Map<string, { pre: number; withdrawn: number }> };

/**
 * Every `<time>\t<from>\t<to>\t<team>\t<error id>\t<phase>` line in the active
 * log and its rotated generations. Rotation keeps the newest GENERATIONS_KEPT
 * generations, so once that many exist older lines may be gone: nights that
 * start before the oldest surviving line are possibly incomplete.
 */
function readRefusals(log: string, now: number): Refusals {
  let generations: string[] = [];
  try { generations = readdirSync(dirname(log)).filter(name => REFUSAL_GENERATION.test(name) && name.startsWith(`${basename(log)}.`)).sort(); }
  catch { /* no index home: no log either */ }
  const out: Refusals = { available: false, log, files: 0, unreadable_files: 0, malformed_lines: 0, oldest: null, incomplete_before: null, byDate: new Map() };
  let oldest: number | null = null;
  for (const path of [...generations.map(name => join(dirname(log), name)), log]) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if (errno(error) !== "ENOENT") out.unreadable_files++; continue; }
    out.files++;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const fields = line.split("\t"), ms = Date.parse(fields[0] ?? ""), phase = fields[5];
      if (fields.length !== 6 || !Number.isFinite(ms) || (phase !== "pre" && phase !== "withdrawn")) { out.malformed_lines++; continue; }
      if (oldest === null || ms < oldest) oldest = ms;
      const date = utc(ms).slice(0, 10), day = out.byDate.get(date) ?? { pre: 0, withdrawn: 0 };
      day[phase]++;
      out.byDate.set(date, day);
    }
  }
  out.available = out.files > 0;
  out.oldest = oldest === null ? null : utc(oldest);
  if (out.available && generations.length >= GENERATIONS_KEPT) out.incomplete_before = utc(oldest ?? now);
  return out;
}

/**
 * `observed`: recipient-observed evidence by receipt-measures' rule — a named,
 * non-forced, non-retired `.read`; `.done` via read, reply or manual done; the
 * `.authorized-read` carry; a harness-queue read. Courier-auto settlement never
 * counts. `settled`: any `.done` at all, which is also nothing-owed evidence for
 * the known-redundant lower bound (recipientState's suppression rule). A null
 * entry is evidence whose time is missing.
 */
function evidence(listing: Listing, id: string): { observed: (Stamp | null)[]; settled: (Stamp | null)[] } {
  const observed: (Stamp | null)[] = [], settled: (Stamp | null)[] = [];
  const read = receipt(listing, id, "read");
  if (read && named(read.by) && !nonAuthoritative(read)) observed.push(stamp(read.at));
  const done = receipt(listing, id, "done");
  if (done) {
    settled.push(stamp(done.at));
    if (named(done.by) && ["read", "reply", "done"].includes(String(done.via)) && !nonAuthoritative(done)) observed.push(stamp(done.at));
  } else if (listing.dir.has(`${id}.done`)) settled.push(null);
  const authorized = receipt(listing, id, "authorized-read");
  if (authorized && named(authorized.by)) observed.push(stamp(authorized.at));
  const sent = receipt(listing, id, "sent");
  if (sent?.via === "harness-queue-read" && named(sent.read_by)) observed.push(stamp(sent.read_at));
  return { observed, settled };
}

/** Order evidence against an instant; anything inside a stamp's resolution window is unknown. */
function order(stamps: (Stamp | null)[], at: number): "none" | "before" | "after" | "unknown" {
  if (!stamps.length) return "none";
  if (stamps.some(s => s && s.ms + s.res <= at)) return "before";
  return stamps.every(s => s && s.ms > at) ? "after" : "unknown";
}

/** When a retry license was admitted: its recorded `admitted_at`, else (older licenses) the file's mtime. */
/**
 * A license's admission time, or undefined when the marker is not valid evidence: it must
 * parse and name this id. Only a valid legacy license without `admitted_at` falls back to
 * the file time; a malformed or foreign marker never counts as a ring.
 */
function admittedAt(listing: Listing, id: string, marker: Marker): number | undefined {
  const path = join(listing.dir.get(marker.name)!, marker.name);
  let license: unknown;
  try { license = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!license || typeof license !== "object" || (license as { id?: unknown }).id !== id) return undefined;
  const at = stamp((license as { admitted_at?: unknown }).admitted_at as string | undefined);
  return at ? at.ms : statSync(path, { throwIfNoEntry: false })?.mtimeMs;
}

function empty(): Counts {
  return { placed: 0, cancelled: 0, recipient_observed: 0, observed_rate: ratio(0, 0), refused_pre: 0, refused_withdrawn: 0,
    initial_unverified: 0, retry_requests: 0, retries_suppressed: 0, retry_outcomes: {},
    retry_unresolved: { pending: 0, queued: 0, unknown: 0, interrupted: 0, consumed: 0 }, extra_rings: 0, retry_first_rings: 0,
    known_redundant: 0, redundancy_unknown: 0, first_observed_after_retry: 0, extra_ring_rate: ratio(0, 0),
    redundant_rate: ratio(0, 0), unobserved: { under_1h: 0, from_1h_to_24h: 0, over_24h: 0 } };
}

function finish<T extends Counts>(c: T): T {
  c.observed_rate = ratio(c.recipient_observed, c.placed - c.cancelled);
  c.extra_ring_rate = ratio(c.extra_rings, c.placed);
  c.redundant_rate = ratio(c.known_redundant, c.extra_rings);
  return c;
}

function add(into: Counts, from: Counts): void {
  for (const key of ["placed", "cancelled", "recipient_observed", "initial_unverified", "retry_requests", "retries_suppressed", "extra_rings",
    "retry_first_rings", "known_redundant", "redundancy_unknown", "first_observed_after_retry"] as const) into[key] += from[key];
  for (const key of ["refused_pre", "refused_withdrawn"] as const) into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  for (const [outcome, n] of Object.entries(from.retry_outcomes)) into.retry_outcomes[outcome] = (into.retry_outcomes[outcome] ?? 0) + n;
  for (const key of ["pending", "queued", "unknown", "interrupted", "consumed"] as const) into.retry_unresolved[key] += from.retry_unresolved[key];
  for (const key of ["under_1h", "from_1h_to_24h", "over_24h"] as const) into.unobserved[key] += from.unobserved[key];
}

/** Count one cohort message into its night. Returns its admitted retry count. */
function count(n: Counts, m: Message, ctx: Context): number {
  const { bus, team, id, listing } = m;
  n.placed++;
  // Only a cancellation receipt that parses and names this id leaves the observed denominator.
  const cancelled = receipt(listing, id, "cancelled") !== null, seen = evidence(listing, id);
  if (cancelled) n.cancelled++;
  else if (seen.observed.length) n.recipient_observed++;
  else {
    const age = ctx.now - m.ms;
    if (age < HOUR) n.unobserved.under_1h++; else if (age <= DAY) n.unobserved.from_1h_to_24h++; else n.unobserved.over_24h++;
  }
  if (ctx.unverified?.has(id)) n.initial_unverified++;
  // Only a marker that parses and names this id is evidence of an admitted ring.
  const admitted = (listing.markers.get(id) ?? []).map(marker => ({ marker, at: admittedAt(listing, id, marker) }));
  const markers = admitted.filter(a => a.at !== undefined).map(a => a.marker);
  const invalidMarkers = admitted.length - markers.length;
  const spooled = rowRetry(join(bus, "spool"), id)?.retry;
  const requested = new Set<string>(), closed = new Set<string>();
  if (listing.retries.has(id)) {
    // retryHistory reads `<home>/receipts/<id>.retries.jsonl`: home is the parent of whichever receipts directory holds it.
    let history: ReturnType<typeof retryHistory>;
    try { history = retryHistory(dirname(listing.dir.get(`${id}.retries.jsonl`)!), id); }
    catch { history = { rows: [], malformed: 0, unreadable: true }; /* an id retry.ts refuses has no readable history */ }
    if (history.malformed || history.unreadable || invalidMarkers) ctx.malformed.push({ team, bus, id, malformed_lines: history.malformed,
      unreadable: history.unreadable, ...(invalidMarkers ? { invalid_markers: invalidMarkers } : {}) });
    for (const r of history.rows) {
      if (r.event === "request") { n.retry_requests++; requested.add(r.retry); }
      else if (r.event === "suppressed") { n.retries_suppressed++; closed.add(r.retry); }
      else if (r.event === "outcome" && typeof r.outcome === "string") { n.retry_outcomes[r.outcome] = (n.retry_outcomes[r.outcome] ?? 0) + 1; closed.add(r.retry); }
    }
  } else if (markers.length || spooled || invalidMarkers) {
    // Per message, never bus-wide: retry evidence without its own history leaves this id's counts incomplete.
    ctx.malformed.push({ team, bus, id, malformed_lines: 0, unreadable: false, missing: true, ...(invalidMarkers ? { invalid_markers: invalidMarkers } : {}) });
  }
  // An outcome missing after a crash is unknown, not completed: reconcile every requested or licensed uuid.
  const licensed = new Set(markers.map(marker => marker.uuid));
  const open = [...new Set([...requested, ...licensed])].filter(uuid => !closed.has(uuid));
  if (open.length) {
    for (const uuid of open)
      n.retry_unresolved[licensed.has(uuid) ? (spooled === uuid ? "pending" : "unknown")
        : spooled === uuid ? "queued" : cancelled || seen.observed.length || seen.settled.length ? "consumed" : "interrupted"]++;
  }
  const times = admitted.flatMap(a => a.at === undefined ? [] : [a.at]).sort((a, b) => a - b);
  // A ring is extra only after an evidenced pane attempt: the original's, or an earlier retry's.
  let prior = listing.attempted.has(id);
  for (const at of times) {
    if (!prior) { n.retry_first_rings++; prior = true; continue; }
    n.extra_rings++;
    const known = order([...seen.observed, ...seen.settled], at);
    if (known === "before") n.known_redundant++;
    else if (known === "unknown") n.redundancy_unknown++;
  }
  // Labelled for what it is: observation followed a ring, which is not proof the ring rescued it.
  if (times.length && order(seen.observed, times[0]!) === "after") n.first_observed_after_retry++;
  return times.length;
}

/**
 * Nightly cohorts by `.placed.at` UTC date over the last `days` nights, plus the
 * rolling extra-ring rate. `env` locates the machine send-refusal log.
 */
export function deliveryStats(buses: Record<string, string>, options: { days: number; now?: Date; env?: NodeJS.ProcessEnv }): Stats {
  const now = (options.now ?? new Date()).getTime(), today = utc(now).slice(0, 10);
  const first = utc(now - (options.days - 1) * DAY).slice(0, 10);
  const all: Message[] = [], nights = new Map<string, Night>(), loops: Stats["loops"] = [];
  const unavailable: BusRef[] = [], unreachable: Stats["buses_unreachable"] = [], noEvents: BusRef[] = [];
  const malformed: Stats["retry_history_malformed"] = [];
  const night = (date: string) => {
    let n = nights.get(date);
    if (!n) nights.set(date, n = { date, partial: date === today, refusals_incomplete: false, ...empty() });
    return n;
  };
  let invalid = 0, future = 0;
  for (const [bus, team] of Object.entries(buses).sort(([a], [b]) => a.localeCompare(b))) {
    let listing: Listing;
    try {
      if (!statSync(bus).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      listing = listReceipts(bus);
    } catch (error) { unreachable.push({ team, bus, reason: errno(error) ?? "unreadable" }); continue; }
    const ctx: Context = { unverified: unverifiedIds(bus), malformed, now };
    let inWindow = 0;
    for (const id of listing.placed) {
      const placed = stamp(receipt(listing, id, "placed")?.at);
      if (!placed) { invalid++; continue; }
      if (placed.ms > now) { future++; continue; }
      const message = { bus, team, id, ms: placed.ms, listing };
      all.push(message);
      const date = utc(placed.ms).slice(0, 10);
      if (date < first) continue;
      inWindow++;
      const admitted = count(night(date), message, ctx);
      if (admitted >= LOOP_RETRIES) loops.push({ team, bus, id, admitted_retries: admitted, date });
    }
    // Missing history is unavailable, never zero.
    if (inWindow && !listing.retries.size) unavailable.push({ team, bus });
    if (inWindow && !ctx.unverified) noEvents.push({ team, bus });
  }
  // Refusals sit beside the denominator: a night with only refusals still gets a row, with placed 0.
  const { byDate, ...refusals } = readRefusals(sendRefusalLogPath(options.env ?? process.env), now);
  for (const date of byDate.keys()) if (date >= first && date <= today) night(date);
  const incompleteBefore = refusals.incomplete_before === null ? null : Date.parse(refusals.incomplete_before);
  for (const n of nights.values()) {
    const day = byDate.get(n.date);
    n.refused_pre = refusals.available ? day?.pre ?? 0 : null;
    n.refused_withdrawn = refusals.available ? day?.withdrawn ?? 0 : null;
    n.refusals_incomplete = incompleteBefore !== null && Date.parse(`${n.date}T00:00:00Z`) < incompleteBefore;
  }
  const sorted = [...nights.values()].sort((a, b) => a.date.localeCompare(b.date)).map(finish);
  const total = empty();
  for (const n of sorted) add(total, n);
  if (!refusals.available) total.refused_pre = total.refused_withdrawn = null;
  // Rolling window: distinct original pane messages, newest first, across every bus and any date.
  all.sort((a, b) => b.ms - a.ms);
  let messages = 0, rings = 0, since: number | null = null;
  for (const m of all) {
    if (messages >= ROLLING_WINDOW) break;
    if (m.listing.sent.has(m.id) && receipt(m.listing, m.id, "sent")?.delivery === "poll") continue;
    messages++; since = m.ms;
    // The same validity rule as the nightly count: a marker that does not parse or names another id is no ring.
    const admitted = (m.listing.markers.get(m.id) ?? []).filter(marker => admittedAt(m.listing, m.id, marker) !== undefined).length;
    rings += m.listing.attempted.has(m.id) ? admitted : Math.max(0, admitted - 1);
  }
  const rate = ratio(rings, messages);
  return {
    as_of: utc(now), days: options.days, buses: Object.keys(buses).length, nights: sorted, total: finish(total),
    rolling: { window: ROLLING_WINDOW, messages, since: since === null ? null : utc(since), extra_rings: rings, rate,
      threshold: TUNE_THRESHOLD, tune: rate.rate !== null && rate.rate > TUNE_THRESHOLD },
    loops, invalid_placed: invalid, future_placed: future, retry_records_unavailable: unavailable, buses_unreachable: unreachable,
    retry_history_malformed: malformed, initial_unverified_unavailable: noEvents, refusals,
  };
}

const percent = (r: Ratio, digits = 2) => r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(digits)}%`;
const fraction = (r: Ratio, digits = 2) => `${r.num}/${r.den} ${percent(r, digits)}`;

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => row[i]!.length)));
  return rows.map(row => row.map((cell, i) => i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)).join("  ").trimEnd());
}

export function renderStats(s: Stats): string {
  const refused = (c: Counts, incomplete: boolean) => c.refused_pre === null ? "n/a" : `${c.refused_pre}/${c.refused_withdrawn}${incomplete ? "?" : ""}`;
  const row = (label: string, c: Counts, incomplete = false) => [label, String(c.placed), String(c.cancelled), refused(c, incomplete),
    fraction(c.observed_rate, 3), String(c.initial_unverified), String(c.retry_requests), String(c.retries_suppressed), String(c.extra_rings),
    String(c.retry_first_rings), String(c.known_redundant), String(c.redundancy_unknown), String(c.first_observed_after_retry),
    `${c.unobserved.under_1h}/${c.unobserved.from_1h_to_24h}/${c.unobserved.over_24h}`];
  const out = [`tap debug stats: as of ${s.as_of}; last ${s.days} night(s) by .placed UTC date; ${s.buses} bus(es)`, ...table([
    ["night", "placed", "cxl", "refused", "observed", "unverif", "req", "supp", "extra", "first", "redund", "unk", "after", "unobs <1h/1-24h/>24h"],
    ...s.nights.map(n => row(n.date + (n.partial ? "*" : ""), n, n.refusals_incomplete)),
    row("total", s.total, s.nights.some(n => n.refusals_incomplete))])];
  const t = s.total, outcomes = Object.entries(t.retry_outcomes).sort(([a], [b]) => a.localeCompare(b)), u = t.retry_unresolved;
  out.push(`retry outcomes: ${outcomes.length ? outcomes.map(([k, n]) => `${k} ${n}`).join(", ") : "none"}; `
    + `without an outcome: pending ${u.pending}, queued ${u.queued}, unknown ${u.unknown}, interrupted ${u.interrupted}, consumed ${u.consumed}`);
  out.push(`extra rings / placed: ${t.extra_ring_rate.num}/${t.extra_ring_rate.den} = ${percent(t.extra_ring_rate)}; `
    + `known redundant / extra rings: ${t.redundant_rate.num}/${t.redundant_rate.den} = ${percent(t.redundant_rate)} (lower bound; ${t.redundancy_unknown} unknown)`);
  const r = s.rolling, last = r.messages < r.window ? `last ${r.messages.toLocaleString("en-US")} pane messages (fewer than ${r.window.toLocaleString("en-US")})` : `last ${r.window.toLocaleString("en-US")} pane messages`;
  out.push(`rolling ${last}${r.since ? ` since ${r.since}` : ""}: extra rings ${r.extra_rings}/${r.messages} = ${percent(r.rate)} `
    + (r.tune ? `TUNE (above ${r.threshold * 100}%, provisional heuristic)` : "ok"));
  const f = s.refusals;
  if (!f.available) out.push(`send refusals: unavailable (no readable ${f.log} or rotated generation; the log starts at the first refusal)`);
  else out.push(`send refusals: ${t.refused_pre} before placement, ${t.refused_withdrawn} withdrawn after placement; never in placed or any rate`
    + ` (${f.files} file(s)${f.unreadable_files ? `, ${f.unreadable_files} unreadable` : ""}${f.malformed_lines ? `, ${f.malformed_lines} malformed line(s) skipped` : ""})`
    + (f.incomplete_before ? `; ? = night starts before the oldest surviving line ${f.incomplete_before}, so rotation may have dropped refusals` : ""));
  for (const loop of s.loops) out.push(`LOOP ${loop.team}/${loop.id}: ${loop.admitted_retries} admitted retries (placed ${loop.date})`);
  if (s.invalid_placed) out.push(`skipped ${s.invalid_placed} .placed receipt(s) that do not parse, name their id, or carry a time`);
  if (s.future_placed) out.push(`skipped ${s.future_placed} .placed receipt(s) dated after ${s.as_of} (a sender clock ahead); not counted`);
  for (const b of s.buses_unreachable) out.push(`${b.team} ${b.bus}: unreachable (${b.reason}); not counted`);
  for (const b of s.retry_records_unavailable) out.push(`${b.team} ${b.bus}: retry records: none on this bus (unavailable before same-id retry)`);
  for (const h of s.retry_history_malformed) {
    const what = h.unreadable ? "retry history unreadable"
      : h.missing ? "retry history missing beside its retry evidence"
      : h.malformed_lines ? `retry history: ${h.malformed_lines} malformed line(s) skipped` : "";
    const markers = h.invalid_markers ? `${h.invalid_markers} invalid retry marker(s) not counted` : "";
    out.push(`${h.team} ${h.bus}: ${h.id} ${[what, markers].filter(Boolean).join("; ")}; its retry counts are ${h.unreadable ? "unavailable" : "incomplete"}`);
  }
  for (const b of s.initial_unverified_unavailable) out.push(`${b.team} ${b.bus}: initial unverified: unavailable (no readable registry-events.log)`);
  out.push("* night in progress; later receipts can change any night. extra = second pane rings; first = a retry that rang first;",
    "  redund = an extra ring after the recipient had observed or settled (lower bound); after = first observed after a retry (not proof of rescue).",
    "  unverif = initial direct or spool submits the bounded registry-events tail still logs as unverified (lower bound).",
    "  refused = send refusals before placement/withdrawn after placement, by UTC date, outside placed and every rate.",
    "  without an outcome: pending/queued = a spool row still carries the retry, licensed/not yet; unknown = licensed, no outcome;",
    "  consumed = never licensed and since read, settled or cancelled (a read or cancel took the row); interrupted = none of these.");
  return out.join("\n") + "\n";
}
