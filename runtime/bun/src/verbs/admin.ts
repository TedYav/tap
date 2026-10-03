// `tap admin` (admin-r7): checkpoints A/B brought the grammar, the dashboard,
// refresh, retire and rebuild-registry native; checkpoint C routed every
// public form to this engine and deleted the tap-admin.sh body in the same
// commit. The behavior map WAS that deleted Bash body; every refusal string,
// default and exit code here is carried
// from it, with the ruled repairs: the H1 authority check (an indexed acting
// registry that is specifically ENOENT is registry_missing, even over a bus
// decoy; an unprovable location is cannot-check) and the P2 join fix (a
// non-string seat field corrupts the team instead of normalizing to healthy).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureAscii } from "../fsatomic";
import { deenrollTeam, deenrollTeamWithCapture, markerSelectedIndex } from "../index-home";
import { writeIndexSnapshot } from "../index-snapshot";
import { pyDumpIndent } from "../lossless-json";
import { MIGRATE_REGISTRY_REMOVED, oldStoreAction, teamRegistryRefusal } from "../register-authority";
import { pyReadUtf8 } from "../spool-publication";
import { dumps, isMap, loads, pyTruthy, pyTypeName, type JsonMap, type JsonValue } from "../watch-detect";
import { seatState } from "../seat-state";
import { frontmatterFields, PY_STRIP } from "../payload-fields";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { shellQuote } from "../slices/message-construction";
import { spoolEntries } from "../slices/outstanding";
import { acquirePathLock, acquireRegistryLock } from "../panelock";
import { Bus } from "../bus";
import { deadLetterAuthority, disposeRetiredTeamInbound } from "../dead-letters";
import { spoolTeamName } from "../context";
import type { ObserveEngine } from "../observe";
import { observe, type RegistryRow } from "./team";
import { cmdAdminPs } from "./admin-ps";
import { cmdAdminRebuild } from "./admin-rebuild";
import { noMachineIndexError, TapError } from "../context";
import { oldBusRefusal, requireResolvedBus, resolveBus } from "../bushome";
import { tapScriptsDir } from "../scripts-dir";

export const ADMIN_SUBCOMMANDS = ["dashboard", "ps", "refresh", "retire", "rebuild-registry", "migrate-registry", "prune"];
const USAGE = "tap admin [dashboard]|refresh|retire|rebuild-registry";
const DASHBOARD_LABEL = "tap admin dashboard";
const MISSING_REASON = "no acting registry found under an enrolled root";

interface AdminOptions { json: boolean; full: boolean; verbose: boolean; staleAfter: number; staleAfterRaw: string }
interface Obligation { id: string; age: number | null }
interface SeatScan {
  team: string; handle: string; status: string; pane: string; paneId: string; harness: string; delivery: string;
  statusReason: string; registeredAt: string; session: string; serverEpoch: string; bootId: string;
  fingerprint: string; paneAlive: boolean | null; paneReason: string; seatState: string;
  inbound: Obligation[]; outstanding: Obligation[]; staleIds: string[];
}
interface TeamScan {
  index: { name: string; root: string; exists: boolean; rootPresence: "present" | "enoent" | "unprobeable"; registryLocation: string };
  bus: string; registry: string;
  unreadableKind: "" | "registry_missing" | "registry_corrupt" | "old_store";
  unreadableReason: string;
  seats: SeatScan[];
}
interface AttentionRow {
  team: string; handle: string; state: string; why: string;
  obligations: { inbound_unsettled: number; outstanding_unsettled: number; sample_ids: string[] };
}

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * H1 local semantics (checkpoint B ruling): an indexed acting registry whose
 * stat fails SPECIFICALLY ENOENT is data-gone — registry_missing, purgeable.
 * Every other unprobeable shape (an empty or non-string location, EACCES,
 * ENOTDIR through a file parent) is cannot-check: present-or-unproven data is
 * never auto-purged.
 */
function classifyLocation(path: string): "present" | "enoent" | "unprobeable" {
  if (!path) return "unprobeable";
  try { return statSync(path).isFile() ? "present" : "unprobeable"; }
  catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "enoent" : "unprobeable"; }
}

/** classifyLocation's shape for a team ROOT (tap-n72): only a positive ENOENT
 * is data-gone; an unstatable root (EACCES, ENOTDIR through a file parent) is
 * present-or-unproven and never purgeable. */
function classifyRoot(path: string): "present" | "enoent" | "unprobeable" {
  if (!path) return "unprobeable";
  try { return statSync(path).isDirectory() ? "present" : "unprobeable"; }
  catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "enoent" : "unprobeable"; }
}
// python's sorted() compares strings by CODE POINT (registry.ts's byCodePoint
// shape): the UTF-16 code-unit `<`/`>` sort puts an astral surrogate pair
// (0xD800…) BELOW U+E000, python puts it ABOVE — a fingerprint would differ.
const codePointOrder = (a: string, b: string): number => {
  const ca = Array.from(a, c => c.codePointAt(0)!);
  const cb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return ca[i]! - cb[i]!;
  }
  return ca.length - cb.length;
};

export function cmdAdmin(argv: string[], scriptsDir: string, engine?: ObserveEngine): number {
  const args = [...argv];
  let sub = "dashboard";
  // A leading --* selects the dashboard without a shift, exactly as the
  // incumbent's `case $1 in --*)` arm does.
  if (args.length && !args[0]!.startsWith("--")) sub = args.shift()!;
  if (!ADMIN_SUBCOMMANDS.includes(sub)) {
    throw new TapError(1, "unknown_subcommand", "tap help admin", `unknown subcommand '${sub}' (usage: ${USAGE})`, "tap");
  }
  if (sub === "prune") {
    // The prune pre-scan ORs --json starting from the AMBIENT value, before the
    // dispatcher's TAP_JSON clobber would ever run on this subcommand.
    if (args.includes("--json")) process.env.TAP_JSON = "1";
    throw new TapError(1, "renamed_verb", "tap admin refresh   # or: tap admin retire <team>",
      "tap admin prune is now: tap admin refresh plus tap admin retire <team>", "tap admin prune");
  }
  if (sub === "ps") return cmdAdminPs(args);
  if (sub === "refresh") return cmdAdminRefresh(args, scriptsDir, engine);
  if (sub === "retire") return cmdAdminRetire(args);
  if (sub === "rebuild-registry") return cmdAdminRebuild(args, scriptsDir);
  if (sub === "migrate-registry") return migrateRegistry(args);
  return cmdAdminDashboard(args, scriptsDir, engine);
}

// Removed-verb stub (one release): old registries are upgraded by hand, never by TAP.
function migrateRegistry(args: string[]): never {
  if (args.includes("--json")) process.env.TAP_JSON = "1";
  throw new TapError(1, "old_store", MIGRATE_REGISTRY_REMOVED.action, MIGRATE_REGISTRY_REMOVED.detail, "tap admin migrate-registry");
}

function parseDashboardOptions(args: string[]): AdminOptions {
  const options: AdminOptions = { json: false, full: false, verbose: false, staleAfter: 900, staleAfterRaw: "900" };
  const refuse = (errorClass: "unknown_option" | "usage_error", detail: string): never => {
    throw new TapError(1, errorClass, "tap help admin dashboard", detail, DASHBOARD_LABEL);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") { options.json = true; process.env.TAP_JSON = "1"; }
    else if (arg === "--full") options.full = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--stale-after") {
      // The incumbent's `${2:?--stale-after needs a value}`: unset or empty
      // value refuses here, exit 1, before any later flag is examined.
      const value = args[i + 1];
      if (value === undefined || value === "") refuse("usage_error", "--stale-after needs a value");
      options.staleAfterRaw = value!;
      options.staleAfter = Number(value);
      i++;
    }
    else if (arg.startsWith("--")) refuse("unknown_option", `unknown option '${arg}'`);
    else refuse("usage_error", `unexpected arg '${arg}'`);
  }
  if (!/^\d+$/.test(options.staleAfterRaw)) refuse("usage_error", `--stale-after needs a non-negative integer, got '${options.staleAfterRaw}'`);
  return options;
}

export function readMachineIndex(path: string): Array<{ name: string; root: string; exists: boolean; rootPresence: "present" | "enoent" | "unprobeable"; registryLocation: string }> {
  const refusal = (): TapError => new TapError(1, "registry_invalid", "tap admin dashboard",
    `machine index '${path}' could not be read — cannot check`, DASHBOARD_LABEL);
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = pyReadUtf8(path); } catch (error) {
    // Open/read failures (EACCES, a directory, an ENOENT race) surface the
    // reader's own message through the path-keyed detail — the refusal id and
    // path are the contract, not python's wording.
    process.stderr.write(`tap admin: machine index '${path}' is invalid JSON (${errorText(error)})\n`);
    throw refusal();
  }
  let doc: JsonValue;
  try { doc = loads(raw); } catch (error) {
    process.stderr.write(`tap admin: machine index '${path}' is invalid JSON (${errorText(error)})\n`);
    throw refusal();
  }
  if (!isMap(doc)) throw refusal();
  const teamsRaw = doc.get("teams");
  const entries: Array<[string, JsonValue]> = !pyTruthy(teamsRaw) ? [] : isMap(teamsRaw) ? [...teamsRaw] : (() => { throw refusal(); })();
  const rows: Array<{ name: string; root: string; exists: boolean; rootPresence: "present" | "enoent" | "unprobeable"; registryLocation: string }> = [];
  for (const [name, ent] of entries.sort(([a], [b]) => codePointOrder(a, b))) {
    if (!isMap(ent)) {
      process.stderr.write(`tap admin: machine index '${path}' entry '${name}' is invalid (expected object)\n`);
      throw refusal();
    }
    if ((typeof ent.get("state") === "string" && ent.get("state") ? ent.get("state") : "registered") === "historical") continue;
    const rootRaw = ent.get("root");
    // The incumbent applies ONLY the absent-key default (`ent.get("root", "")`):
    // an absent or empty-string root is the dangling shape, while any other
    // falsy value fails the row join and a truthy non-string fails isdir —
    // registry_invalid either way, with python's deterministic final line.
    if (rootRaw === undefined || rootRaw === "") {
      rows.push({ name, root: "", exists: false, rootPresence: "unprobeable", registryLocation: "" });
      continue;
    }
    if (typeof rootRaw !== "string") {
      // The incumbent's reader dies on a present non-string root either in
      // os.path.isdir (which accepts ints and bools as descriptors — they
      // reach the row join) or in that join; falsy roots short-circuit isdir
      // and reach the join too. The deterministic final line comes from
      // replaying exactly that split on the parsed entry; the traceback
      // frames are the ruled drop.
      process.stderr.write(`${entryRowError(ent)}\n`);
      throw refusal();
    }
    // One probe, one answer: exists derives from the same
    // tri-state stat, so a race between two stats cannot pair exists=false
    // with a present root.
    const rootPresence = classifyRoot(rootRaw);
    rows.push({
      name, root: rootRaw, exists: rootPresence === "present", rootPresence,
      registryLocation: typeof ent.get("registry_location") === "string" ? ent.get("registry_location") as string : "",
    });
  }
  return rows;
}

/** The corrupt-path stderr detail: JavaScript's own message for the failure
 * our reader raised. The contract the tests pin is the refusal id plus the
 * path, never python's wording — there is no python arm left to word it. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A present non-string index root kills the incumbent's reader either in
 * `os.path.isdir` (which accepts ints and bools as file descriptors — a truthy
 * one reaches the row join) or in that join; a FALSY root short-circuits the
 * isdir arm and reaches the join too. The deterministic final line replays
 * exactly that split natively — pyTruthy, then the descriptor admission —
 * never a synthesized guess and never a child process.
 */
function entryRowError(entry: JsonMap): string {
  const root = entry.has("root") ? entry.get("root")! : "";
  const joinsThenRefuses = !pyTruthy(root) || typeof root === "bigint" || typeof root === "boolean";
  return joinsThenRefuses
    ? `TypeError: sequence item 1: expected str instance, ${pyTypeName(root)} found`
    : `TypeError: stat: path should be string, bytes, os.PathLike or integer, not ${pyTypeName(root)}`;
}

export function busForRoot(root: string): string {
  const current = join(root, ".tap", "bus");
  return isDir(current) ? current : "";
}

/**
 * The incumbent publishes every registry rewrite through python's
 * `json.dump(reg, fh, indent=2, sort_keys=True)` + trailing newline. The
 * document (already decided, already mutated) is serialized by the shared
 * lossless emitter — pyDumpIndent keeps python's bytes exactly: code-point
 * sort_keys, float reprs, wide ints and ensure_ascii escaping (DEL included) —
 * while the write itself (temp file in the registry's directory, rename over
 * the target) stays local.
 */
export function serializeRegistryDocument(doc: JsonValue): string {
  return `${pyDumpIndent(doc, 0)}\n`;
}

/** mkstemp-in-dir + rename, the incumbent's atomic publish shape. */
function publishRegistryDocument(doc: JsonValue, path: string): void {
  const body = serializeRegistryDocument(doc);
  const dir = join(path, "..");
  // Node has no mkstemp; a private temp directory yields the same unique-name
  // guarantee, and the rename moves the file out before the directory goes.
  const scratch = mkdtempSync(join(dir, ".tap."));
  const tmp = join(scratch, "registry");
  try {
    // Explicit 0600: the temp is always freshly created, so the mode applies
    // regardless of the operator's umask, and the registry never widens.
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function scanUnsettled(bus: string, localTeam: string, now: number): { inbound: Map<string, Obligation[]>; outstanding: Map<string, Obligation[]> } {
  const inbound = new Map<string, Obligation[]>();
  const outstanding = new Map<string, Obligation[]>();
  const push = (map: Map<string, Obligation[]>, key: string, obligation: Obligation) => {
    const list = map.get(key);
    if (list) list.push(obligation); else map.set(key, [obligation]);
  };
  const payloads = join(bus, "payloads");
  const receipts = join(bus, "receipts");
  const local = localTeam.replace(PY_STRIP, "");
  const seen = new Set<string>();
  if (isDir(payloads)) {
    for (const name of readdirSync(payloads).sort()) {
      // tap_frontmatter.list_payload_paths's glob never matches dotfiles and the
      // scanner skips _-drafts: a hidden .ghost.md is not an obligation.
      if (!name.endsWith(".md") || name.startsWith("_") || name.startsWith(".")) continue;
      const id = name.slice(0, -".md".length);
      seen.add(id);
      if (existsSync(join(receipts, `${id}.done`))) continue;
      // The incumbent's scanner decodes with errors='replace' and treats any
      // read failure as an empty field map; only the mtime failure nulls the age.
      let fields: Record<string, string>;
      try { fields = frontmatterFields(readFileSync(join(payloads, name), "utf8")); } catch { fields = {}; }
      let age: number | null;
      try { age = Math.max(0, now - Math.floor(statSync(join(payloads, name)).mtimeMs / 1000)); } catch { age = null; }
      const from = fields.from ?? "";
      const to = fields.to ?? "";
      const toTeam = (fields.to_team ?? "").replace(PY_STRIP, "");
      if (to && (toTeam === "" || toTeam === local)) push(inbound, to, { id, age });
      if (from) push(outstanding, from, { id, age });
    }
  }
  // Spool-only sends are unsettled obligations too (tap-ktqz): a send parked in
  // the sender's spool never reaches payloads/, so the payload scan above cannot
  // see it. Same shared reader `tap outstanding` uses — one spool parser. A
  // parked send is outbound custody (the recipient has not received it), so it
  // buckets under its sender alone; ids the payload scan counted and ids the
  // recipient settled are skipped.
  for (const entry of spoolEntries(bus)) {
    if (seen.has(entry.id)) continue;
    // A cancelled send is terminal too (Bus.isDone, tap outstanding and the
    // spool readers all treat it so), even while its parked body lingers. A
    // directory named like the receipt is not one and hides nothing.
    if (existsSync(join(receipts, `${entry.id}.done`)) || isFile(join(receipts, `${entry.id}.cancelled`))) continue;
    let fields: Record<string, string>;
    try { fields = frontmatterFields(readFileSync(entry.path, "utf8")); } catch { fields = {}; }
    let age: number | null;
    try { age = Math.max(0, now - Math.floor(statSync(entry.path).mtimeMs / 1000)); } catch { age = null; }
    const from = fields.from ?? "";
    if (from) push(outstanding, from, { id: entry.id, age });
  }
  return { inbound, outstanding };
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value instanceof Map) return new Map([...value].sort(([a], [b]) => codePointOrder(a, b)).map(([k, x]) => [k, sortJson(x)] as [string, JsonValue]));
  return value;
}

/** python base64.urlsafe_b64encode(json.dumps(seat, sort_keys, compact)) — padded. */
export function fingerprintOf(seat: JsonMap): string {
  const encoded = Buffer.from(dumps(sortJson(seat), true), "utf8").toString("base64url");
  return encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
}

function scanTeam(row: { name: string; root: string; exists: boolean; rootPresence: "present" | "enoent" | "unprobeable"; registryLocation: string }, now: number, staleAfter: number, withObligations: boolean): TeamScan {
  const team: TeamScan = { index: row, bus: "", registry: "", unreadableKind: "", unreadableReason: "", seats: [] };
  const unreadable = (kind: "registry_missing" | "registry_corrupt" | "old_store", reason: string) => {
    team.unreadableKind = kind;
    team.unreadableReason = reason;
    return team;
  };
  // A dangling root is never probed: the enrollment itself is what is gone.
  if (!row.exists) return team;
  const resolution = resolveBus(row.root, {});
  if (resolution.rule === "old_store") return unreadable("old_store", oldBusRefusal(resolution.home).detail);
  const bus = busForRoot(row.root);
  // H1 repair: the indexed acting registry is the authority, so its exact
  // location is classified BEFORE any bus requirement. A location that is
  // SPECIFICALLY gone (ENOENT) makes the team registry_missing — data is
  // gone, purgeable — even though the legacy bus below still carries a decoy
  // the incumbent's soft rebind misread as the roster. An unprovable
  // location (empty/non-string, EACCES, ENOTDIR) is cannot-check instead:
  // present-or-unproven data is never auto-purged. A PRESENT registry parses
  // even when the bus is gone: the roster survives, but with no bus the
  // unsettled scan stays empty, seat state stays unknown (payloads are never
  // probed through a relative path), and no registry event is attempted.
  const registry = row.registryLocation;
  const verdict = classifyLocation(registry);
  if (verdict === "enoent") return unreadable("registry_missing", MISSING_REASON);
  if (verdict === "unprobeable") {
    return unreadable("registry_corrupt", registry
      ? `registry.json at ${registry} could not be parsed as JSON`
      : "no acting registry location is indexed for this team");
  }
  team.bus = bus;
  team.registry = registry;
  let raw: string;
  try { raw = pyReadUtf8(registry); } catch (error) {
    // The incumbent's reader wraps decode failures in the same line as parse
    // failures; the detail is the reader's own message of the bytes.
    process.stderr.write(`registry.json is invalid JSON (${errorText(error)})\n`);
    return unreadable("registry_corrupt", `registry.json at ${registry} could not be parsed as JSON`);
  }
  let doc: JsonValue;
  try { doc = loads(raw); } catch (error) {
    process.stderr.write(`registry.json is invalid JSON (${errorText(error)})\n`);
    return unreadable("registry_corrupt", `registry.json at ${registry} could not be parsed as JSON`);
  }
  if (!isMap(doc)) {
    // A readable non-dict registry dies in python inside `_seat_map`
    // (`data.get`); the exception line is deterministic, the <stdin> traceback
    // around it is not reproduced.
    process.stderr.write(`AttributeError: '${pyTypeName(doc)}' object has no attribute 'get'\n`);
    return unreadable("registry_corrupt", `registry.json at ${registry} could not be parsed as JSON`);
  }
  // An old-format registry is its own named state: never a roster, never purged.
  const oldStore = teamRegistryRefusal(registry, doc);
  if (oldStore) return unreadable("old_store", oldStore.detail);
  const seatsRaw = doc.get("seats");
  const seats = isMap(seatsRaw) ? seatsRaw : new Map();
  const partial: SeatScan[] = [];
  for (const handle of [...seats.keys()].sort(codePointOrder)) {
    const seat = seats.get(handle);
    if (!isMap(seat)) continue;
    const pick = (key: string, fallback: string): JsonValue => (seat.has(key) ? seat.get(key)! : fallback);
    // Incumbent defaults first (python .get semantics: the fallback applies
    // only when the key is ABSENT — a null value stays null), then the join
    // requires strings. Any non-string crashed the incumbent's reader with a
    // TypeError and left the whole team corrupt (P2: never normalize to healthy).
    const deliveryValue = pyTruthy(seat.get("delivery")) ? seat.get("delivery")! : "pane";
    const joined = [
      pick("status", "active"), pick("pane", ""), pick("pane_id", ""), pick("harness", ""),
      deliveryValue, pick("status_reason", ""), pick("registered_at", ""), pick("session", ""),
      pick("server_epoch", ""), pick("boot_id", ""),
    ];
    if (joined.some(value => typeof value !== "string")) {
      // The incumbent's reader dies here on python's str-join TypeError; the
      // deterministic exception line is kept, the <stdin> traceback is not.
      const bad = joined.findIndex(value => typeof value !== "string");
      process.stderr.write(`TypeError: sequence item ${bad}: expected str instance, ${pyTypeName(joined[bad]!)} found\n`);
      return unreadable("registry_corrupt", `registry.json at ${registry} could not be parsed as JSON`);
    }
    const [status = "", pane = "", paneId = "", harness = "", delivery = "", statusReason = "", registeredAt = "", session = "", serverEpoch = "", bootId = ""] = joined as string[];
    partial.push({
      team: row.name, handle, status, pane, paneId, harness, delivery, statusReason, registeredAt,
      session, serverEpoch, bootId, fingerprint: fingerprintOf(seat),
      paneAlive: null, paneReason: "", seatState: "", inbound: [], outstanding: [], staleIds: [],
    });
  }
  team.seats = partial;
  // Only the dashboard reads obligation history; refresh's registry work
  // never opens payloads or receipts.
  const unsettled = withObligations && bus
    ? scanUnsettled(bus, row.name, now)
    : { inbound: new Map<string, Obligation[]>(), outstanding: new Map<string, Obligation[]>() };
  for (const seat of team.seats) {
    seat.inbound = unsettled.inbound.get(seat.handle) ?? [];
    seat.outstanding = unsettled.outstanding.get(seat.handle) ?? [];
    // Strictly greater than the threshold; an unmeasurable age is never stale.
    seat.staleIds = seat.outstanding.filter(o => o.age !== null && o.age > staleAfter).map(o => o.id);
  }
  return team;
}

/**
 * ONE shared observation across every team, like the incumbent's single
 * classifier batch. The dashboard observes active pane seats; refresh observes
 * EVERY pane seat — a suspended row whose pane is gone is exactly what it
 * trims. Returns the classifier's failure code, never a half-roster.
 */
function observeTeams(teams: TeamScan[], scriptsDir: string, engine: ObserveEngine | undefined, refreshAll: boolean): number {
  const rows: RegistryRow[] = [];
  const byKey = new Map<string, SeatScan>();
  for (const team of teams) {
    for (const seat of team.seats) {
      if (seat.delivery === "poll") continue;
      if (!refreshAll && seat.status !== "active") continue;
      const key = JSON.stringify([seat.team, seat.handle]);
      rows.push({
        team: seat.team, handle: key, harness: seat.harness, pane: seat.pane, status: seat.status,
        status_reason: seat.statusReason, delivery: seat.delivery, pane_id: seat.paneId,
        unattended: "", session: seat.session, registered_at: seat.registeredAt, crew: "",
        server_epoch: seat.serverEpoch, boot_id: seat.bootId, preset: "",
      });
      byKey.set(key, seat);
    }
  }
  if (!rows.length) return 0;
  const observations = observe(rows, scriptsDir, false, undefined, engine);
  // A classifier that could not run is not a roster of unknowns: propagate
  // the failure instead of rendering "active" teams it never observed.
  if (observations.code !== 0) return observations.code;
  for (const [key, seat] of byKey) {
    const fields = observations.rows.get(key);
    seat.paneReason = fields?.[1] ?? "";
    const state = fields?.[0] ?? "";
    if (state === "active") seat.paneAlive = true;
    else if (state === "gone") seat.paneAlive = false;
  }
  return 0;
}

function classifyTeam(team: TeamScan): "active" | "dormant" | "dangling" | "unreadable" {
  if (!team.index.exists) return "dangling";
  if (team.unreadableKind) return "unreadable";
  const panes = team.seats.filter(seat => seat.delivery !== "poll");
  if (!panes.length) return "active";
  for (const seat of panes) {
    if (seat.status === "suspended") continue;
    if (seat.paneAlive !== false) return "active";
  }
  return "dormant";
}

const PURGE_REASON_TEXT: Record<string, string> = { root_gone: "worktree root gone", registry_missing: "registry file missing" };

/**
 * `tap admin refresh` (admin-r7 U3): report and trim dead panes whose captured
 * roster row is unchanged under the registry lock, purge data-gone teams
 * through retire's index writer, and surface dormant retire candidates. A
 * --dry-run renders byte-identical output and writes nothing at all.
 */
function cmdAdminRefresh(args: string[], scriptsDir: string, engine?: ObserveEngine): number {
  // The incumbent clobbers TAP_JSON=0 after sub dispatch, before the flag table.
  process.env.TAP_JSON = "0";
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--json") process.env.TAP_JSON = "1";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help admin refresh", `unknown option '${arg}'`, "tap admin refresh");
    else throw new TapError(1, "usage_error", "tap help admin refresh", `unexpected arg '${arg}'`, "tap admin refresh");
  }
  const json = process.env.TAP_JSON === "1";
  const selected = markerSelectedIndex();
  if (selected.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor",
      "global-registry.json is present but unreadable or wrong schema — refusing admin index ops", "tap admin refresh");
  }
  if (selected.marker === "absent") throw noMachineIndexError("tap admin refresh");
  const rawNow = process.env.TAP_WATCH_NOW;
  const now = rawNow ? Number(rawNow) : Math.floor(Date.now() / 1000);
  const teams = readMachineIndex(selected.path).map(row => scanTeam(row, now, 900, false));
  if (observeTeams(teams, scriptsDir, engine, true) !== 0) return 1;

  const classes = new Map(teams.map(team => [team.index.name, classifyTeam(team)]));
  const corruptReason = new Map<string, string>();
  const oldStoreReason = new Map<string, string>();
  for (const team of teams) {
    if (team.unreadableKind === "registry_corrupt") corruptReason.set(team.index.name, team.unreadableReason);
    if (team.unreadableKind === "old_store") oldStoreReason.set(team.index.name, team.unreadableReason);
  }
  const missing: Array<{ team: string; reason: string }> = [];
  for (const team of teams) {
    // A root that cannot be probed is present-or-unproven (tap-n72): it joins
    // cannot-check and is never purged, exactly like an unprobeable registry
    // location. Only a positive ENOENT is root_gone.
    if (team.index.rootPresence === "unprobeable") {
      corruptReason.set(team.index.name, `worktree root '${team.index.root}' could not be probed (permission denied or ambiguous) — present-or-unproven data is never purged`);
      continue;
    }
    // Purge keys on the explicit ENOENT answer, never on exists=false.
    if (team.index.rootPresence === "enoent") missing.push({ team: team.index.name, reason: "root_gone" });
    else if (team.unreadableKind === "registry_missing") missing.push({ team: team.index.name, reason: "registry_missing" });
  }
  // Data-gone teams are REPORTED in a dry run too (byte-consistent with a real
  // run); only the de-enrollment itself is a real-run side effect.
  const purged = missing.map(entry => ({ team: entry.team, reason: entry.reason }));
  const retireCandidates = teams
    .filter(team => classes.get(team.index.name) === "dormant")
    .map(team => {
      const pollMembers = team.seats.filter(seat => seat.delivery === "poll").map(seat => seat.handle).sort(codePointOrder);
      const blockedBy = pollMembers.length ? [`poll-mode members: ${pollMembers.join(",")}`] : [];
      return { team: team.index.name, classification: "dormant", blocked_by: blockedBy, recommended: blockedBy.length === 0 };
    });

  // TRIM: a registry that turned corrupt between the scan and the locked
  // reload joins cannot-check instead of mutating (present-but-broken data is
  // never trimmed or purged).
  const trimmed: Array<{ team: string; handle: string; pane: string; reason: string }> = [];
  for (const team of teams) {
    if (!team.index.exists || team.unreadableKind || !team.registry) continue;
    const candidates = team.seats
      .filter(seat => seat.delivery !== "poll" && seat.paneAlive === false)
      .sort((a, b) => codePointOrder(a.handle, b.handle));
    if (!candidates.length) continue;
    let trimmedHandles: string[] = [];
    if (!dryRun) {
      const lock = acquirePathLock(`${team.registry}.lock`);
      if (!lock) {
        corruptReason.set(team.index.name, `registry.json at ${team.registry} stayed locked during refresh`);
        continue;
      }
      try {
        let raw: string;
        try { raw = pyReadUtf8(team.registry); } catch (error) {
          corruptReason.set(team.index.name, `registry.json at ${team.registry} could not be parsed during refresh (${errorText(error)})`);
          continue;
        }
        let doc: JsonValue;
        try { doc = loads(raw); } catch (error) {
          corruptReason.set(team.index.name, `registry.json at ${team.registry} could not be parsed during refresh (${errorText(error)})`);
          continue;
        }
        if (!isMap(doc)) {
          corruptReason.set(team.index.name, `registry.json at ${team.registry} could not be parsed during refresh (AttributeError: '${pyTypeName(doc)}' object has no attribute 'get')`);
          continue;
        }
        const lockedOldStore = teamRegistryRefusal(team.registry, doc);
        if (lockedOldStore) {
          oldStoreReason.set(team.index.name, lockedOldStore.detail);
          continue;
        }
        // Only a seats map beside no `agents` key is writable: anything else trims nothing.
        const seatsRaw = doc.get("seats");
        const agents: JsonMap = isMap(seatsRaw) && !doc.has("agents") ? seatsRaw : new Map();
        // Effect-time authority: the scan's capture was only a plan. Before
        // the first mutation, re-resolve the team through a fresh marker-aware
        // snapshot and require the same live/absent marker, active team, root
        // and acting registry the scan saw — anything else joins cannot-check
        // instead of locking in a rewrite of a store that is no longer ours.
        const fresh = markerSelectedIndex();
        const freshRow = fresh.marker === "live"
          ? readMachineIndex(fresh.path).find(entry => entry.name === team.index.name)
          : undefined;
        if (!freshRow || !freshRow.exists || freshRow.root !== team.index.root || freshRow.registryLocation !== team.index.registryLocation) {
          corruptReason.set(team.index.name, `the machine-index authority for team '${team.index.name}' moved during refresh; nothing was trimmed`);
          continue;
        }
        // Pre-flip both indexed locations are empty, so the field compare
        // above is vacuous there; the ACTING store is derived from the root
        // through busForRoot's canonical .tap/bus mapping — exactly the
        // selection scanTeam used. A root promoted (or demoted) between the
        // layouts mid-race changes that derivation, so require the fresh
        // actual path to still name the captured store before any mutation.
        const freshRegistry = fresh.marker === "live"
          ? freshRow.registryLocation
          : (() => { const bus = busForRoot(freshRow.root); return bus ? join(bus, "registry.json") : ""; })();
        if (freshRegistry !== team.registry) {
          corruptReason.set(team.index.name, `the acting registry for team '${team.index.name}' moved during refresh; nothing was trimmed`);
          continue;
        }
        for (const seat of candidates) {
          const current = agents.get(seat.handle);
          // CAS on the COMPLETE captured row: any concurrent writer that
          // changed anything — an unknown field, a value between adjacent
          // wide ints — produces a different fingerprint and defeats the trim.
          const currentFingerprint = isMap(current) ? fingerprintOf(current) : "";
          if (currentFingerprint === seat.fingerprint) {
            agents.delete(seat.handle);
            trimmedHandles.push(seat.handle);
          }
        }
        if (trimmedHandles.length) publishRegistryDocument(doc, team.registry);
      } finally {
        lock.release();
      }
    } else {
      trimmedHandles = candidates.map(seat => seat.handle);
    }
    for (const seat of candidates) {
      if (!trimmedHandles.includes(seat.handle)) continue;
      trimmed.push({ team: team.index.name, handle: seat.handle, pane: seat.pane, reason: seat.paneReason || "pane_gone" });
    }
  }
  const cannotCheck = [...corruptReason.keys()].sort(codePointOrder);
  const oldStore = [...oldStoreReason.keys()].sort(codePointOrder).map(team => ({ team, detail: oldStoreReason.get(team)! }));

  // Reversibility (tap-k140): before a real run purges any index row,
  // snapshot the machine index beside it with a sha256 sidecar and print a
  // one-line restore command. A snapshot that cannot be written purges
  // nothing: the receipt below must not claim a purge that did not happen.
  // Trims above touch team registries, never the index.
  let snapshotPath = "";
  if (!dryRun && purged.length) {
    try {
      const { path: snap, sha256 } = writeIndexSnapshot(selected.path, "admin-refresh");
      snapshotPath = snap;
      process.stderr.write(`tap admin refresh: index snapshot '${snap}' (sha256 ${sha256}); restore: cp ${shellQuote(snap)} ${shellQuote(selected.path)}\n`);
    } catch {
      purged.length = 0;
      process.stderr.write("tap admin: warning: refresh; next: could not write an index snapshot; no teams were purged - retry 'tap admin refresh'\n");
    }
  }

  // A plain PURGED receipt is earned only by a successful de-enrollment
  // (tap-n72): a refused purge prints its warning and no PURGED line. The JSON
  // object's purged array keeps the gather decision (see below). Every plain
  // line renders after the de-enrollment, in one order for both modes, so a
  // dry run previews exactly the layout the real run prints.
  const purgedOk: Array<{ team: string; reason: string }> = [];
  const reportPurged = dryRun ? purged : purgedOk;
  if (!dryRun) {
    // One registry event per successful trim, on a real bus only.
    for (const item of trimmed) {
      const team = teams.find(entry => entry.index.name === item.team);
      if (!team?.bus || !team.registry) continue;
      appendRegistryEventOrWarn("tap admin refresh", {
        log: registryEventsPath(team.bus),
        actor: "admin-refresh",
        action: "trimmed",
        handle: item.handle,
        pane: item.pane,
        team: spoolTeamName(team.bus),
        detail: "",
      });
    }
    // De-enroll through retire's index writer; a failure warns (the incumbent
    // call passes the verb as two words, so the rendered line really is
    // `tap admin: warning: refresh; next: …`) and never changes the exit code.
    // Guarded capture re-checks the exact observed root/location and the
    // positive absence of the acting registry under the index lock, writing a
    // rollback witness first. An empty indexed location leaves nothing for it
    // to fence, so that shape (and root-gone, whose absence is itself the
    // observable fact) takes the plain writer.
    for (const item of snapshotPath ? purged : []) {
      const team = teams.find(entry => entry.index.name === item.team);
      if (item.reason === "registry_missing" && team?.index.root && team.index.registryLocation) {
        const recovery = join(dirname(selected.path), "recovery");
        let artifact = "";
        try {
          mkdirSync(recovery, { recursive: true });
          artifact = join(recovery, `team-admin-refresh.${randomBytes(6).toString("hex")}`);
          closeSync(openSync(artifact, "wx", 0o600));
        } catch {
          process.stderr.write(`tap admin: warning: refresh; next: could not allocate a purge capture artifact; team '${item.team}' was left enrolled — retry 'tap admin refresh'\n`);
          continue;
        }
        const result = deenrollTeamWithCapture({ team: item.team, artifact, expectRoot: team.index.root, expectRegistry: team.index.registryLocation });
        if (result.ok) {
          purgedOk.push(item);
          try { unlinkSync(artifact); } catch {
            process.stderr.write(`tap admin: warning: refresh; next: could not remove the consumed purge artifact '${artifact}'\n`);
          }
        } else {
          process.stderr.write(`tap admin: warning: refresh; next: purge of team '${item.team}' was refused (rc=${result.code}) and the index was left intact; the capture artifact is retained at '${artifact}' for inspection\n`);
        }
        continue;
      }
      if (!deenrollTeam(item.team).ok) {
        process.stderr.write(`tap admin: warning: refresh; next: could not purge team '${item.team}' from index\n`);
      } else {
        purgedOk.push(item);
      }
    }
  }
  // The earned receipt: after the de-enrollment it describes (tap-n72). The
  // JSON object's purged array stays the gather DECISION (the race contract):
  // a guarded refusal is carried by its own warning there, while the plain
  // PURGED line is only printed for a purge that really happened.
  if (json) {
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: true, dry_run: dryRun, trimmed, purged, retire_candidates: retireCandidates, cannot_check: cannotCheck, old_store: oldStore }))}\n`);
  } else {
    for (const item of trimmed) process.stdout.write(`tap admin refresh: trimmed '${item.team}/${item.handle}' (${item.reason})\n`);
    for (const item of reportPurged) process.stdout.write(`tap admin refresh: PURGED '${item.team}' from index (${PURGE_REASON_TEXT[item.reason] ?? item.reason})\n`);
    for (const item of retireCandidates) {
      if (item.recommended) process.stdout.write(`tap admin refresh: retire candidate '${item.team}' (${item.classification})\n`);
      else process.stdout.write(`tap admin refresh: retire blocked '${item.team}' (${item.classification}: ${item.blocked_by.join("; ")})\n`);
    }
    for (const name of cannotCheck) process.stdout.write(`tap admin refresh: warning: could not read team '${name}' (${corruptReason.get(name)}) - skipped, no mutation attempted\n`);
    for (const item of oldStore) process.stdout.write(`tap admin refresh: warning: team '${item.team}' is in an old format (${item.detail}) - skipped, no mutation attempted; next: ${oldStoreAction("agents_axis")}\n`);
    // A planned purge that failed printed its own warning: that is not
    // "nothing to do", so this keys on the plan, not the earned receipts.
    if (!trimmed.length && !purged.length && !retireCandidates.length && !cannotCheck.length && !oldStore.length) {
      process.stdout.write("tap admin refresh: nothing to do\n");
    }
  }
  // Exit 1 only on a genuine cannot-check; purging data-gone teams is normal,
  // successful work.
  return cannotCheck.length || oldStore.length ? 1 : 0;
}

function cmdAdminRetire(args: string[]): number {
  process.env.TAP_JSON = "0";
  const label = "tap admin retire";
  let force = false;
  let team = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") process.env.TAP_JSON = "1";
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help admin retire", `unknown option '${arg}'`, label);
    else if (!team) team = arg;
    else throw new TapError(1, "usage_error", "tap help admin retire", `unexpected arg '${arg}'`, label);
  }
  if (!team) throw new TapError(1, "usage_error", "tap help admin retire", "usage: tap admin retire <team> [--force]", label);

  const selected = markerSelectedIndex();
  if (selected.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor",
      "global-registry.json is present but unreadable or wrong schema — refusing admin index ops", label);
  }
  if (selected.marker === "absent") throw noMachineIndexError(label);
  const notEnrolled = (): TapError =>
    new TapError(1, "unknown_team", "tap admin dashboard", `team '${team}' is not enrolled in machine index '${selected.path}'`, label);
  const row = readMachineIndex(selected.path).find(entry => entry.name === team);
  if (!row) throw notEnrolled();

  // Poll-mode seats survive a retire: they are the blockers that force --force.
  // The resolution is H1-corrected like the dashboard's: the indexed acting
  // location is the authority, so a decoy under the bus can never manufacture
  // a blocker (or hide one). Retire extracts poll members ONLY — it does not
  // run the dashboard's string-join validation.
  let registry = "";
  if (row.exists) {
    requireResolvedBus(resolveBus(row.root, {}));
    const bus = busForRoot(row.root);
    if (selected.marker === "live") {
      const verdict = classifyLocation(row.registryLocation);
      if (verdict === "present") registry = row.registryLocation;
      else if (verdict === "enoent") registry = "";
      else {
        // An unprobeable authority means the poll roster cannot be proven
        // either way — retiring would bypass the blocker check on a guess.
        throw new TapError(1, "registry_invalid", "repair_registry",
          `the acting registry for team '${team}' at '${row.registryLocation}' could not be read`, label);
      }
    } else {
      registry = join(bus, "registry.json");
    }
    if (registry && isFile(registry)) {
      const pollMembers = pollHandlesOrRefuse(registry, label);
      if (pollMembers.length > 0 && !force) {
        throw new TapError(1, "retire_refused", `tap admin retire ${team} --force`,
          `refusing to retire team '${team}': poll-mode members: ${pollMembers.join(",")}`, label);
      }
    }
  }

  // Inbound disposal is fenced by identity (tap-bm4om): under the team's
  // registry sidecar, capture each row's instance, then de-enroll only the
  // entry inspected above (same root and registry). The sidecar precedes the
  // index ladder, as enrollment's own order.
  let captured: Record<string, string> = {};
  const registryLock = registry && isFile(registry) ? acquireRegistryLock(registry, 5000) : null;
  if (registry && isFile(registry) && !registryLock) {
    throw new TapError(1, "registry_busy", `tap admin retire ${team}`, `the registry for team '${team}' at '${registry}' is busy; nothing was retired`, label);
  }
  let result: ReturnType<typeof deenrollTeam>;
  try {
    if (registryLock) captured = capturedInstances(registry, team);
    result = deenrollTeam(team, undefined, { root: row.root, registryLocation: row.registryLocation });
  } finally { registryLock?.release(); }
  if (!result.ok) {
    switch (result.code) {
      case 2: throw notEnrolled();
      case 3: throw new TapError(1, "registry_invalid", "tap admin dashboard", result.detail || `machine index '${selected.path}' could not be read`, label);
      case 4: throw new TapError(1, "invalid_flip", "tap doctor", result.detail || "global-registry.json is present but unreadable or wrong schema", label);
      case 6: throw new TapError(1, "enrollment_changed", `tap admin retire ${team}`, result.detail, label);
      default: throw new TapError(1, "error", "tap admin dashboard", `could not retire team '${team}'`, label);
    }
  }
  const removedRoot = result.root;

  // The retired event is written only where a bus exists to hold it.
  if (row.root && row.exists) {
    const bus = busForRoot(row.root);
    if (bus) {
      appendRegistryEventOrWarn("tap admin retire", {
        log: registryEventsPath(bus),
        actor: "admin-retire",
        action: "retired",
        handle: team,
        pane: "",
        team: spoolTeamName(bus),
        detail: "",
      });
    }
  }

  const withdrawn = row.root && row.exists ? withdrawRetiredTeamInbound(row.root, team, registry, captured) : [];

  if (process.env.TAP_JSON === "1") {
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: true, team, root: removedRoot || row.root, forced: force,
      ...(withdrawn.length ? { withdrawn_inbound: withdrawn } : {}) }))}\n`);
  } else {
    process.stdout.write(`tap admin retire: de-enrolled team '${team}'\n`);
    if (withdrawn.length) {
      process.stdout.write(`tap admin retire: withdrew ${withdrawn.length} unsettled inbound to the retired team (${withdrawn.join(", ")}; payloads kept; receipts/<id>.cancelled reason=seat_unresolvable)\n`);
    }
  }
  return 0;
}

/** {handle: instance} for every row that carries one, read only from a registry
 * complete enough to be dead-letter authority for `team` (its own name, object
 * rows, valid forwardings); anything less captures nothing, so nothing is disposed. */
function capturedInstances(registry: string, team: string): Record<string, string> {
  const out: Record<string, string> = {};
  const authority = deadLetterAuthority(registry, team);
  if (!authority) return out;
  for (const [handle, seat] of Object.entries(authority.seats)) {
    const instance = (seat as Record<string, unknown>).instance;
    if (typeof instance === "string" && instance) out[handle] = instance;
  }
  return out;
}

/** Dispose the retired team's identity-fenced inbound. The retirement stands
 * whatever happens here: a failure is reported on stderr, never undone. */
function withdrawRetiredTeamInbound(root: string, team: string, registry: string, captured: Record<string, string>): string[] {
  if (!Object.keys(captured).length) return [];
  const busHome = busForRoot(root);
  if (!busHome) return [];
  const warn = (line: string) => process.stderr.write(`tap admin retire: team '${team}' is retired; ${line}\n`);
  try {
    const { disposed, skipped, failed } = disposeRetiredTeamInbound(new Bus(busHome), team, registry, captured);
    if (skipped.length) warn(`${skipped.length} inbound not withdrawn (${skipped.map((s) => `${s.id}: ${s.reason}`).join(", ")})`);
    for (const f of failed) warn(`inbound withdrawal stopped at ${f.id}: ${f.reason}`);
    return disposed;
  } catch (error) {
    warn(`inbound withdrawal failed before any receipt: ${errorText(error)}`);
    return [];
  }
}

/** Retire's poll-only extraction: no join validation, corrupt is a repair refusal. */
function pollHandlesOrRefuse(registry: string, label: string): string[] {
  let raw: string;
  try { raw = pyReadUtf8(registry); } catch (error) {
    throw new TapError(1, "registry_invalid", "repair_registry",
      `registry.json at ${registry} could not be parsed as JSON (${errorText(error)})`, label);
  }
  let doc: JsonValue;
  try { doc = loads(raw); } catch (error) {
    throw new TapError(1, "registry_invalid", "repair_registry",
      `registry.json at ${registry} could not be parsed as JSON (${errorText(error)})`, label);
  }
  if (!isMap(doc)) {
    throw new TapError(1, "registry_invalid", "repair_registry",
      `registry.json at ${registry} could not be parsed as JSON (AttributeError: '${pyTypeName(doc)}' object has no attribute 'get')`, label);
  }
  const oldStore = teamRegistryRefusal(registry, doc);
  if (oldStore) throw new TapError(1, oldStore.errorClass, oldStore.action, oldStore.detail, label);
  const seatsRaw = doc.get("seats");
  const seats = isMap(seatsRaw) ? seatsRaw : new Map();
  const poll: string[] = [];
  for (const handle of [...seats.keys()].sort(codePointOrder)) {
    const seat = seats.get(handle);
    if (!isMap(seat)) continue;
    const delivery = pyTruthy(seat.get("delivery")) ? seat.get("delivery")! : "pane";
    if (delivery === "poll") poll.push(handle);
  }
  return poll;
}

function cmdAdminDashboard(args: string[], scriptsDir: string, engine?: ObserveEngine): number {
  // The incumbent clobbers TAP_JSON=0 after sub dispatch and BEFORE the flag
  // table, so an ambient TAP_JSON=1 cannot turn a flag refusal into JSON; the
  // sequential parse flips it back exactly when it reaches --json.
  process.env.TAP_JSON = "0";
  const options = parseDashboardOptions(args);
  const selected = markerSelectedIndex();
  if (selected.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor",
      "global-registry.json is present but unreadable or wrong schema — refusing admin index ops", DASHBOARD_LABEL);
  }
  if (selected.marker === "absent") throw noMachineIndexError(DASHBOARD_LABEL);
  const rawNow = process.env.TAP_WATCH_NOW;
  const now = rawNow ? Number(rawNow) : Math.floor(Date.now() / 1000);
  const teams = readMachineIndex(selected.path).map(row => scanTeam(row, now, options.staleAfter, true));

  if (observeTeams(teams, scriptsDir, engine, false) !== 0) return 1;
  // Seat state is read only where it can mean something: active registry rows
  // whose pane was just observed alive. Read-only, stderr dropped, and a
  // failed read is the incumbent's "unknown".
  for (const team of teams) {
    if (!team.bus) continue;
    for (const seat of team.seats) {
      if (seat.status !== "active" || seat.delivery === "poll" || seat.paneAlive !== true) continue;
      seat.seatState = seatState(seat.handle, {
        registry: team.registry, home: team.bus,
        env: { ...process.env, TAP_SEAT_STATE_READONLY: "1" },
      });
    }
  }

  const displayState = (seat: SeatScan): string => seat.seatState || (seat.delivery === "poll" ? "poll-mode (liveness unknown)" : "unknown");
  const classes = new Map(teams.map(team => [team.index.name, classifyTeam(team)]));
  const cannotCheck = teams.filter(team => team.unreadableKind === "registry_corrupt").map(team => team.index.name).sort();
  const oldStore = teams.filter(team => team.unreadableKind === "old_store")
    .map(team => ({ team: team.index.name, detail: team.unreadableReason })).sort((a, b) => codePointOrder(a.team, b.team));
  const missing: Array<{ team: string; reason: string }> = [];
  for (const team of teams) {
    if (!team.index.exists) missing.push({ team: team.index.name, reason: "root_gone" });
    else if (team.unreadableKind === "registry_missing") missing.push({ team: team.index.name, reason: "registry_missing" });
  }
  const attention: AttentionRow[] = [];
  for (const team of teams) {
    for (const seat of team.seats) {
      if (seat.status !== "active") continue;
      const reasons: string[] = [];
      if (seat.delivery !== "poll") {
        if (seat.paneAlive === false) {
          reasons.push(`pane dead while registry status is still active${registeredAge(seat.registeredAt, now)}`);
        } else if (seat.seatState === "blocked-on-approval") {
          reasons.push(`blocked on an approval prompt; needs you: tap attach ${team.index.name}/${seat.handle}`);
        } else if (seat.seatState === "wedged" || seat.seatState === "rate-limited-error") {
          reasons.push(`seat ${seat.seatState}`);
        } else if (seat.seatState === "idle-at-prompt" && seat.inbound.length > 0) {
          reasons.push(`idle-at-prompt with ${seat.inbound.length} unsettled inbound payload(s)`);
        }
      }
      if (seat.staleIds.length > 0) {
        reasons.push(`${seat.staleIds.length} stale outstanding send(s) with no .done after ${options.staleAfter}s`);
      }
      if (reasons.length === 0) continue;
      attention.push({
        team: team.index.name, handle: seat.handle, state: displayState(seat), why: reasons.join("; "),
        obligations: {
          inbound_unsettled: seat.inbound.length,
          outstanding_unsettled: seat.outstanding.length,
          sample_ids: [...seat.inbound, ...seat.outstanding].slice(0, 3).map(o => o.id),
        },
      });
    }
  }

  // A seat parked on a permission prompt waits on the operator alone: list it first.
  const blockedFirst = (row: AttentionRow) => row.state === "blocked-on-approval" ? 0 : 1;
  attention.sort((a, b) => blockedFirst(a) - blockedFirst(b));

  if (options.json) {
    const teamsJson = teams.map(team => {
      const out: Record<string, unknown> = { name: team.index.name, classification: classes.get(team.index.name)!, root: team.index.root };
      if (options.full) {
        out.seats = team.seats.map(seat => ({
          handle: seat.handle, status: seat.status, pane: seat.pane, harness: seat.harness,
          delivery: seat.delivery, state: displayState(seat),
        }));
      }
      return out;
    });
    process.stdout.write(`${ensureAscii(JSON.stringify({ teams: teamsJson, attention, cannot_check: cannotCheck, old_store: oldStore, missing }))}\n`);
  } else {
    const missingNames = new Set(missing.map(entry => entry.team));
    process.stdout.write(`tap admin dashboard: ${teams.length} team(s) indexed\n`);
    for (const team of teams) {
      if (!options.verbose && missingNames.has(team.index.name)) continue;
      process.stdout.write(`  ${team.index.name}  ${classes.get(team.index.name)}  root: ${team.index.root}\n`);
      if (options.full) {
        for (const seat of team.seats) {
          process.stdout.write(`    ${seat.handle}  status: ${seat.status}  delivery: ${seat.delivery}  pane: ${seat.pane || "-"}  harness: ${seat.harness || "-"}  state: ${displayState(seat)}\n`);
        }
      }
    }
    process.stdout.write(`${secondary("attention")}\n`);
    if (attention.length === 0) {
      process.stdout.write("  none\n");
    } else {
      for (const row of attention) {
        process.stdout.write(`  ${row.team}/${row.handle}  state: ${row.state}  inbound: ${row.obligations.inbound_unsettled}  outstanding: ${row.obligations.outstanding_unsettled}  sample: ${row.obligations.sample_ids.join(",") || "-"}  why: ${row.why}\n`);
      }
    }
    const reasonOf = new Map(teams.map(team => [team.index.name, team.unreadableReason]));
    const details = options.verbose
      ? teams.filter(team => team.unreadableKind && team.unreadableKind !== "old_store").map(team => ({ name: team.index.name, reason: team.unreadableReason })).sort((a, b) => codePointOrder(a.name, b.name))
      : cannotCheck.map(name => ({ name, reason: reasonOf.get(name) ?? "" }));
    if (details.length) {
      process.stdout.write(`${secondary("cannot-check")}\n`);
      for (const detail of details) process.stdout.write(`  ${detail.name}: ${detail.reason}\n`);
    }
    if (oldStore.length) {
      process.stdout.write(`${secondary("old-store")}\n`);
      for (const item of oldStore) process.stdout.write(`  ${item.team}: ${item.detail}\n`);
      process.stdout.write(`  next: ${oldStoreAction("agents_axis")}\n`);
    }
    if (missing.length) {
      process.stdout.write(`tap admin dashboard: ${missing.length} missing team(s) detected - run tap admin refresh to purge them\n`);
    }
  }
  return cannotCheck.length || oldStore.length ? 1 : attention.length ? 2 : 0;
}

function registeredAge(registeredAt: string, now: number): string {
  // python strptime("%Y-%m-%dT%H:%M:%SZ") parity: the exact shape, a real
  // calendar date, and no sub-second remainder.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(registeredAt)) return "";
  const stamp = Date.parse(registeredAt);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== `${registeredAt.slice(0, -1)}.000Z`) return "";
  const delta = Math.max(0, now - Math.floor(stamp / 1000));
  const age = delta < 60 ? `${delta}s`
    : delta < 3600 ? `${Math.floor(delta / 60)}m`
    : delta < 86400 ? `${Math.floor(delta / 3600)}h`
    : `${Math.floor(delta / 86400)}d`;
  return `; registered ${age} ago`;
}

function secondary(text: string): string {
  if (process.env.NO_COLOR !== undefined || !process.env.TERM || process.env.TERM === "dumb") return text;
  // style.sh polarity: CLICOLOR_FORCE forces unless it is "0"; an EMPTY value
  // is not a force. Without a force, a non-tty stdout stays plain.
  const forced = Boolean(process.env.CLICOLOR_FORCE && process.env.CLICOLOR_FORCE !== "0");
  if (!forced && !process.stdout.isTTY) return text;
  const tokens = [["setaf", "1"], ["setaf", "3"], ["bold"], ["dim"], ["sgr0"]].map(probe =>
    spawnSync("tput", probe as string[], { env: process.env, encoding: "utf8" }));
  if (tokens.some(result => result.status !== 0 || !result.stdout)) return text;
  return `${tokens[3]!.stdout}${text}${tokens[4]!.stdout}`;
}

if (import.meta.main) process.exitCode = cmdAdmin(process.argv.slice(2), tapScriptsDir());
