// Evidence only: the opted-in entry journal is separate; this leaf never writes TAP state.
import { boundPaneIdentityState } from "../observe-gather";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { repoRoot, resolveBus } from "../bushome";
import { enrolledTeamNameForRoot, flipMarkerState, globalRegistryPath, resolveTeamFromGlobal } from "../index-home";
import { frontmatterFields, PY_STRIP } from "../payload-fields";
import { resolvePayloadAddress, resolutionLine } from "../payload-view";
import { pythonInt } from "../pyint";
import { teamRegistryRefusal } from "../register-authority";
import { busHomeForEnrolled } from "../selector";
import { pyReadUtf8, pyStrCompare } from "../spool-publication";
import { dumps, isMap, loads, pyStr, pyTruthy, type JsonMap, type JsonValue } from "../watch-detect";
import { listHandleHistory } from "./register";

const LIMITS = "TAP runs on one machine and is not a security boundary. These editable local records do not authenticate authorship or prove processing.";
const KINDS = ["placed", "sent", "read", "done", "cancelled"] as const;
const object = (fields: Record<string, JsonValue | undefined>): JsonMap => new Map(Object.entries(fields).map(([key, value]) => [key, value ?? null]));
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const strip = (text: string): string => text.replace(PY_STRIP, "");

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function readDoc(path: string): JsonMap {
  if (!isFile(path)) return new Map();
  const doc = loads(pyReadUtf8(path));
  if (!isMap(doc)) throw new Error(`registry state doc is not an object: ${path}`);
  return doc;
}

/** A present team registry must be current: an old format is reported, never read for seats. */
function readTeamDoc(path: string): JsonMap {
  const doc = readDoc(path);
  const refusal = isFile(path) ? teamRegistryRefusal(path, doc) : null;
  if (refusal) throw new Error(`old_store: ${refusal.detail}`);
  return doc;
}

function rootForBus(bus: string): string {
  return ["bus", "tap"].includes(basename(bus)) && [".tap", "tmp"].includes(basename(dirname(bus))) ? dirname(dirname(bus)) : bus;
}

// Provenance reports authority faults instead of applying the mutation selector's refusals.
function senderRegistry(root: string, home: string, team: string): { authority: string; path: string } {
  const marker = flipMarkerState(home);
  if (marker === "invalid") return { authority: "invalid", path: "" };
  if (marker === "live") {
    if (!team) {
      const enrollment = enrolledTeamNameForRoot(root, home);
      if (enrollment.status !== "ok") return { authority: enrollment.status === "invalid" ? "invalid" : enrollment.status === "missing" ? "live_unenrolled" : "live_unreachable", path: "" };
      team = enrollment.name;
    }
    const selected = resolveTeamFromGlobal(globalRegistryPath(home), team);
    if (selected.status === "invalid") return { authority: "invalid", path: "" };
    if (selected.status === "ok" || selected.status === "unreachable") {
      const path = selected.registryLocation;
      return { authority: path && isFile(path) ? "live" : "live_unreachable", path };
    }
    return { authority: "live_unreachable", path: "" };
  }
  // No machine index: no enrolled team, so no sender registry to read (F2b).
  return { authority: "absent", path: "" };
}

function validateTimestamp(raw: string): void {
  // Leader ruling: explicit calendar/offset grammar, independent of Python's version.
  // Date.parse would normalize impossible dates and 24:00 into corroborating evidence.
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-](\d{2}):?(\d{2}))$/.exec(raw);
  if (!match || match[0] !== raw) throw new Error("invalid receipt timestamp: use YYYY-MM-DDTHH:MM:SS with optional fractional seconds and Z or a signed HH:MM/HHMM offset");
  const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (!Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw new Error("invalid receipt timestamp: calendar date, time or timezone offset is out of range");
}

function receipt(path: string, id: string, kind: typeof KINDS[number], fields: JsonMap): JsonMap {
  try {
    try { statSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return object({ status: "missing" }); throw error; }
    const value = readDoc(path);
    if (value.get("id") !== id) throw new Error("receipt id mismatch");
    const required = { placed: ["via", "at"], sent: ["from", "to", "kind", "turn", "delivery"], read: ["by", "at"], done: ["by", "at", "via"], cancelled: ["by", "at", "via"] }[kind];
    if (required.some(key => typeof value.get(key) !== "string" || !value.get(key))) throw new Error("missing receipt fields");
    if (kind !== "sent") validateTimestamp(value.get("at") as string);
    if (kind === "sent" && (value.get("turn") !== "unconfirmed" || !["pane", "poll"].includes(value.get("delivery") as string) || ["from", "to", "kind"].some(key => value.get(key) !== fields.get(key)))) throw new Error("invalid submission marker");
    const result = object({ status: "present" });
    for (const key of ["id", "from", "to", "kind", "pane", "at", "by", "via", "delivery", "turn", "identity", "actor_instance", "instance", "recipient_instance", "sender_instance", "adopted_from", "epoch", "forced", "source", "reason"]) {
      if (value.has(key) && !(kind === "sent" && key === "at")) result.set(key, value.get(key)!);
    }
    return result;
  } catch (error) { return object({ status: "malformed", reason: reason(error) }); }
}

/** Exact session target: the trailing colon keeps a slash-named `team/handle` a session target. */
export const sessionCreatedArgv = (session: string): string[] => ["display-message", "-p", "-t", `=${session}:`, "#{session_created}"];

function sessionAge(row: JsonMap, path: string, handle: string, exact: boolean): JsonMap {
  const result = object({ seconds: null, source: "tmux session_created", reason: "no exact current pane identity", pane_state: "unknown" });
  if (!exact || row.get("delivery") === "poll") return result;
  try {
    const observeIdentity = () => boundPaneIdentityState(path, handle, pyStr(row.get("pane") ?? ""), pyStr(row.get("pane_id") ?? ""));
    const state = observeIdentity();
    result.set("pane_state", state || "unknown");
    if (state !== "match") { result.set("reason", state || "pane observation unavailable"); return result; }
    const session = row.get("session");
    if (!pyTruthy(session)) return result;
    if (typeof session !== "string") throw new Error("invalid session");
    // Keep the incumbent's bounded read, bracketed by the shared identity owner.
    const observed = spawnSync("tmux", sessionCreatedArgv(session), { encoding: "utf8", timeout: 5000 });
    if (observed.error) throw observed.error;
    if (observed.status !== 0 || observeIdentity() !== "match") return result;
    let current: JsonValue | undefined;
    const oldStore = isFile(path) ? teamRegistryRefusal(path, readDoc(path)) : null;
    if (oldStore) { result.set("reason", "old_store"); return result; }
    try {
      const doc = readDoc(path), axis = doc.get("seats");
      const seat = isMap(axis) ? axis.get(handle) : undefined;
      current = isMap(seat) ? seat.get("instance") : undefined;
    } catch { current = undefined; }
    if (typeof current !== "string" || current !== row.get("instance")) return result;
    const created = pythonInt(strip(observed.stdout), true), now = BigInt(Math.floor(Date.now() / 1000));
    if (created === null) throw new Error("invalid session timestamp");
    if (created <= 0n || created > now) { result.set("reason", "missing or future session timestamp"); return result; }
    result.set("seconds", now - created); result.set("reason", null); result.set("pane_state", "live");
  } catch { result.set("reason", "session observation unavailable"); }
  return result;
}

function report(path: string, residency: string, localBus: string, home: string, scripts: string): JsonMap {
  const bus = residency === "digest" ? dirname(dirname(dirname(path))) : dirname(dirname(path));
  const root = rootForBus(bus), marker = flipMarkerState(home);
  const enrollment = marker === "live" ? enrolledTeamNameForRoot(root, home) : { status: "unknown", name: "" };
  let fields: JsonMap, id: string;
  if (residency === "digest") {
    fields = readDoc(path); id = basename(path, ".json");
    if (fields.get("digest_id") !== id || !Array.isArray(fields.get("items"))) throw new Error("invalid digest or file-id mismatch");
    fields.set("id", id); fields.set("kind", "digest");
    if (!fields.has("from")) fields.set("from", "courier");
  } else {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch { /* The incumbent frontmatter reader returns no fields. */ }
    fields = object(frontmatterFields(raw)); id = basename(path).replace(/(?:\.cancelled)?\.md$/, "");
    if (fields.get("id") !== id || !pyTruthy(fields.get("from")) || !pyTruthy(fields.get("to"))) throw new Error("invalid payload or envelope/file-id mismatch");
  }
  let sender = fields.get("from") ?? "";
  if (typeof sender !== "string") throw new Error("invalid payload sender");
  let senderTeam = pyTruthy(fields.get("from_team")) ? fields.get("from_team")! : enrollment.name;
  if (sender.includes("/")) {
    const slash = sender.indexOf("/");
    senderTeam = pyTruthy(fields.get("from_team")) ? fields.get("from_team")! : sender.slice(0, slash);
    sender = sender.slice(slash + 1);
  }
  if (typeof senderTeam !== "string") throw new Error("invalid payload sender team");
  const caller = marker === "live" ? enrolledTeamNameForRoot(rootForBus(localBus), home) : { status: "unknown", name: "" };
  let authority: string = marker === "live" ? "live_unreachable" : marker, registry = "";
  let row: JsonMap = new Map(), doc: JsonMap = new Map(), history: JsonMap[] = [];
  const reasons: string[] = [];
  try {
    ({ authority, path: registry } = senderRegistry(root, home, senderTeam));
    if (authority !== "live" || !registry) throw new Error(`sender authority ${authority}`);
    doc = readTeamDoc(registry);
    const axis = doc.get("seats");
    if (!isMap(axis)) throw new Error("missing seat map");
    const candidate = axis.get(sender);
    if (pyTruthy(candidate)) { if (!isMap(candidate)) throw new Error("invalid sender row"); row = candidate; }
    history = listHandleHistory(bus, sender, join(dirname(registry), "team-history"));
  } catch (error) { reasons.push(reason(error)); row = new Map(); }
  const instance = fields.get("sender_instance"), exact = pyTruthy(instance) && instance === row.get("instance");
  const retired = history.find(entry => pyTruthy(instance) && entry.get("instance") === instance);
  const receipts = new Map(KINDS.map(kind => [kind, receipt(join(bus, "receipts", `${id}.${kind}`), id, kind, fields)]));
  const placed = receipts.get("placed")!, sent = receipts.get("sent")!;
  const attributed = placed.get("via") === "courier" && placed.get("status") === "present" || sent.get("status") === "present";
  const teamInfo = doc.get("team");
  const consistent = enrollment.status === "ok" && authority === "live" && isMap(teamInfo) && teamInfo.get("name") === senderTeam && reasons.length === 0;
  const verdict = enrollment.status === "missing" ? "unenrolled-bus" : exact && consistent ? attributed ? "record-match" : "unbound-sender" : exact ? "conflict" : retired ? "retired-instance" : row.size === 0 ? "unknown-sender" : !pyTruthy(instance) ? "unbound-sender" : "conflict";
  if (!attributed) reasons.push("no valid courier placement/submission attribution");
  if (!pyTruthy(instance)) reasons.push("payload sender instance is unbound");
  const senderInfo = object({ handle: sender, team: senderTeam || null, instance, current_instance: row.get("instance"), current_match: exact, same_team_as_caller: caller.status === "ok" && senderTeam ? senderTeam === caller.name : null });
  for (const key of ["harness", "preset", "model", "pane", "pane_id", "session", "status", "registered_at"]) senderInfo.set(key, row.get(key) ?? null);
  senderInfo.set("retired_at", retired && !exact ? retired.get("retired_at") ?? null : null);
  const age = sessionAge(row, registry, sender, exact && consistent);
  const result = object({ observed_at: new Date().toISOString().replace("Z", "000+00:00"), id, path, residency,
    bus: object({ path: bus, team: enrollment.name || null, enrollment: enrollment.status, authority }), sender: senderInfo,
    recipient: fields.get("to"), reply_to: fields.get("reply_to"), kind: fields.get("kind"), session_age: age,
    receipts, verdict, reasons, limits: LIMITS });
  if (residency === "digest") result.set("members", (fields.get("items") as JsonValue[]).filter(isMap).map(item => object({ id: item.get("id"), from: item.get("from"), path: item.get("path") })));
  return result;
}

// Preserve Python's lossless facts, sorted JSON keys, and non-ASCII text rendering.
function render(value: JsonValue, sorted: boolean, ascii: boolean): string {
  if (typeof value === "string" && !ascii) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => render(item, sorted, ascii)).join(", ")}]`;
  if (isMap(value)) {
    const entries = [...value];
    if (sorted) entries.sort(([a], [b]) => pyStrCompare(a, b));
    return `{${entries.map(([key, item]) => `${render(key, false, ascii)}: ${render(item, sorted, ascii)}`).join(", ")}}`;
  }
  return dumps(value, false);
}

export function cmdProvenance(argv: string[], scripts: string): number {
  const asJson = argv.includes("--json") || process.env.TAP_JSON === "1";
  try {
    let ref: string | undefined, team = "";
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--json") continue;
      if (arg === "--team") { if (++i === argv.length) throw new Error("list index out of range"); team = argv[i]!; }
      else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
      else if (ref === undefined) ref = arg;
      else throw new Error(`unexpected argument ${arg}`);
    }
    if (!ref) throw new Error("usage: tap provenance <id|team/id|suffix|path=...> [--team <team>] [--json]");
    const home = process.env.TAP_INDEX_HOME || join(homedir(), ".tap");
    const index = globalRegistryPath(home);
    let localBus = process.env.TAP_HOME ? resolveBus(repoRoot(), { ...process.env, TAP_HOME: resolve(process.env.TAP_HOME) }).home : busHomeForEnrolled(repoRoot());
    if (team) {
      const selected = resolveTeamFromGlobal(index, team);
      if (selected.status !== "ok") throw new Error(`team resolution ${selected.status}`);
      localBus = busHomeForEnrolled(selected.root);
    }
    const resolved = resolvePayloadAddress(ref, localBus, index, "payloads");
    if (resolved.status !== "found") throw new Error(`resolution ${strip(resolutionLine(resolved)).split("\x1f").join(": ")}`);
    const result = report(resolved.path, resolved.residency, localBus, home, scripts);
    process.stdout.write((asJson ? render(result, true, true) : [...result].map(([key, value]) => `${key}: ${render(value, false, false)}`).join("\n")) + "\n");
    return 0;
  } catch (error) {
    const detail = reason(error);
    process.stdout.write((asJson ? render(object({ error: detail, limits: LIMITS }), false, true) : `${detail}\n${LIMITS}`) + "\n");
    return 1;
  }
}
