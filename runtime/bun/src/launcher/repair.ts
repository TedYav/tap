import { paneEnrollmentRefusal } from "../pane-enrollment";
import { SESSION_REPAIR_HELP } from "../help";
// Live session repair owns no membership: reconcile only an existing selected row.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireResolvedBus, resolveBus } from "../bushome";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { isPaneId } from "../lifecycle-target";
import { lifecycleDiagnostic } from "../lifecycle-diagnostics";
import { pyDumpIndent } from "../lossless-json";
import { errorJson } from "../native-error";
import { agentFamilies, classifyHarness, harnessFamily, observeProcessHarness, readProcessTable } from "../observe";
import { acquireRegistryLock } from "../panelock";
import { pythonInt } from "../pyint";
import { ensureSeatInstance } from "../registry";
import { epochVoidedIds } from "../seat-verdict";
import { pyReadUtf8 } from "../spool-publication";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { bootId, ServerUnresponsive, serverEpochFromRaw, tmuxReadOnly, tmuxSessionNamespace } from "../tmux";
import { verbose } from "../verbose";
import { launcherFenceRefusal } from "../reset";
import { dumps, isMap, loads, pyRepr, pyStr, pyTruthy, type JsonMap, type JsonValue } from "../watch-detect";
import { HARNESSES } from "./catalog";
import { teamRegistryRefusal } from "../register-authority";
import { LauncherError } from "./types";
import { actingRegistryPath, NoMachineIndex, nonEmpty, pathIsUnder, payloadRecords, realOrSelf, rootForCwd, sessionHandle, SessionStateError, type SessionRecord } from "./records";
import { artifactBun, runtimeModule } from "../scripts-dir";
import { ownBun, ownBunFlags } from "../own-bun";

const USAGE = "usage: tap session repair (<handle|session> | --all) [--dry-run] [--json]\n";
export const PANE_FACTS_FORMAT = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pid}:#{start_time}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_path}";
export interface PaneFacts {
  pane: string; paneId: string; command: string; epoch: string; dead: boolean; pid: string; path: string;
}
export type RepairStatus = "already_current" | "repaired" | "would_repair" | "not_registered" | "pending_mismatch" | "user_removed" | "pane_mismatch" | "non_agent_pane" | "pane_owned" | "not_live";
interface Result { status: RepairStatus; line: string }
interface Options { key?: string; all: boolean; dryRun: boolean; json: boolean; help: boolean }
const field = (row: JsonMap, key: string, fallback: JsonValue = null): JsonValue => row.has(key) ? row.get(key)! : fallback;
const optionalInstance = (row: JsonMap): string | null => nonEmpty(row.get("instance")) ? row.get("instance") as string : null;
const ok = (status: RepairStatus) => ["already_current", "repaired", "would_repair"].includes(status);
const result = (status: RepairStatus, detail: string): Result => ({ status, line: "tap session repair: " + detail + "\n" });

function unavailable(target: string, detail: string): never {
  throw new SessionStateError("identity_unverified: pane observation is unobservable for " + pyRepr(target) + ": " + detail + "; refusing registry write; next: verify tmux and retry");
}

/** One seven-field tmux record; the final path can itself contain tabs. */
export function parseRepairPane(line: string): PaneFacts | null {
  const text = line.replace(/\n$/, "");
  if (text.includes("\n")) return null;
  const parts = text.split("\t");
  if (parts.length < 7 || !parts[0] || !parts[1] || !["0", "1"].includes(parts[4]!)) return null;
  if (!/^[0-9]+$/.test(parts[5]!) && !(parts[4] === "1" && parts[5] === "")) return null;
  if (!isPaneId(parts[1])) {
    throw new SessionStateError("identity_unverified: tmux returned invalid pane_id " + pyRepr(parts[1]!) + "; refusing registry write; next: verify tmux and retry");
  }
  return { pane: parts[0]!, paneId: parts[1]!, command: parts[2]!, epoch: serverEpochFromRaw(parts[3]!),
    dead: parts[4] === "1", pid: parts[5]!, path: parts.slice(6).join("\t") };
}

function paneQuery(args: string[], target: string): ReturnType<typeof tmuxReadOnly> {
  try { return tmuxReadOnly(args); }
  catch (error) {
    if (error instanceof ServerUnresponsive) unavailable(target, error.message);
    throw error;
  }
}

const MISSING = /^(?:can't find (?:pane|window|session)|no such pane)(?::| )/;
const NO_SERVER = /^(?:no server running on .+|error connecting to .+ \(No such file or directory\))$/;
// Real tmux keeps the server fields when the target pane has no expansion.
const EMPTY_PANE = /^:\.\t{3}[0-9]+:[0-9]+\t{3}\n?$/;
function missing(run: ReturnType<typeof tmuxReadOnly>): boolean {
  return (MISSING.test(run.stderr.trim()) || NO_SERVER.test(run.stderr.trim())) && (!run.stdout.trim() || EMPTY_PANE.test(run.stdout));
}

/** R1: only positive absence permits another target; opaque failure never does. */
function paneFacts(target: string): PaneFacts | null {
  const run = paneQuery(["display-message", "-p", "-t", target, PANE_FACTS_FORMAT], target);
  if (run.code !== 0) {
    if (missing(run)) return null;
    unavailable(target, run.stderr.trim() || "tmux did not answer");
  }
  // tmux can answer a missing target with an exact empty expansion and exit 0.
  if (EMPTY_PANE.test(run.stdout)) return null;
  const facts = parseRepairPane(run.stdout);
  if (!facts) unavailable(target, "malformed tmux pane record");
  return facts;
}

function paneHarness(facts: PaneFacts): string {
  const families = agentFamilies();
  const family = harnessFamily(facts.command, families);
  if (classifyHarness(family, families) !== "unsupported") return family;
  // Same native process owner used by tap_pane_harness_command. Use the pid
  // carried by this record; no second pane lookup can borrow a replacement pid.
  const ps = readProcessTable();
  const observation = observeProcessHarness(facts.pid, ps.table, ps.ok, families);
  return observation.state === "observed" && observation.family ? observation.family : family;
}

function matchingPane(record: SessionRecord): { facts: PaneFacts | null; harness: string | null } {
  const target = "=" + record.name;
  let active = paneFacts(target);
  if (active?.dead) active = null;
  const activeHarness = active ? paneHarness(active) : null;
  if (active && activeHarness === record.harness) return { facts: active, harness: activeHarness };
  const run = paneQuery(["list-panes", "-s", "-t", target, "-F", PANE_FACTS_FORMAT], target);
  if (run.code !== 0) {
    if (missing(run)) return { facts: active, harness: activeHarness };
    unavailable(target, run.stderr.trim() || "tmux did not answer");
  }
  const candidates = run.stdout.replace(/\n$/, "").split("\n").filter(Boolean).map(line => {
    const facts = parseRepairPane(line);
    if (!facts) unavailable(target, "malformed tmux pane record");
    return facts;
  });
  for (const facts of candidates) {
    if (facts.dead) continue;
    const harness = paneHarness(facts);
    if (harness === record.harness) return { facts, harness };
  }
  return { facts: active, harness: activeHarness };
}

function currentEpoch(): string | null {
  if (process.env.TAP_SERVER_EPOCH !== undefined) return process.env.TAP_SERVER_EPOCH || null;
  try {
    const run = tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}"]);
    return run.code === 0 ? serverEpochFromRaw(run.stdout.replace(/\n$/, "")) || null : null;
  } catch (error) {
    if (error instanceof ServerUnresponsive) return null;
    throw error;
  }
}

function storedTargets(row: JsonMap, now: string | null): [string, string] {
  const stamp = row.get("server_epoch");
  // A malformed truthy stamp cannot equal a string epoch in Python.
  if (now && pyTruthy(stamp) && typeof stamp !== "string") return ["", ""];
  const projected = new Map(row);
  if (!pyTruthy(stamp)) projected.delete("server_epoch");
  for (const key of ["pane_id", "pane"]) projected.set(key, pyTruthy(row.get(key)) ? pyStr(row.get(key)) : "");
  return epochVoidedIds(projected, now);
}

function activeOwner(rows: JsonMap, handle: string, facts: PaneFacts): string | null {
  const now = currentEpoch();
  for (const [other, row] of rows) {
    if (other === handle || !isMap(row) || field(row, "status", "active") !== "active") continue;
    const [id, pane] = storedTargets(row, now);
    if ((id && id === facts.paneId) || (pane && pane === facts.pane)) return other;
  }
  return null;
}

function currentSocket(epoch: string): string {
  try {
    const run = tmuxReadOnly(["display-message", "-p", "#{pid}:#{start_time}\t#{socket_path}"]);
    const [raw, socket] = run.stdout.trim().split("\t");
    return run.code === 0 && socket?.startsWith("/") && serverEpochFromRaw(raw ?? "") === epoch ? socket : "";
  } catch (error) {
    if (error instanceof ServerUnresponsive) return "";
    throw error;
  }
}

function readRegistry(path: string, initial: boolean): JsonMap {
  let doc: JsonValue;
  try {
    verbose("state_read", { path });
    doc = loads(pyReadUtf8(path));
  } catch (error) {
    throw new SessionStateError((initial ? "acting registry unreadable: " : "registry unreadable: ") + (error as Error).message + (initial ? "; next: tap doctor" : ""));
  }
  if (!isMap(doc)) throw new SessionStateError(initial ? "acting registry root is not an object; next: tap doctor" : "registry root is not an object");
  const refusal = teamRegistryRefusal(path, doc);
  if (refusal) throw new LauncherError(refusal.detail, refusal.errorClass, refusal.action, refusal.detail);
  return doc;
}

/** Repair writes only a seats map beside no `agents` key; anything else has no rows to touch. */
function seats(doc: JsonMap): JsonMap {
  const rows = doc.get("seats");
  return isMap(rows) && !doc.has("agents") ? rows : new Map();
}

class ChildFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function publish(path: string, doc: JsonMap, rows: JsonMap): void {
  const aliases = doc.get("seat_forwardings");
  if (Array.isArray(aliases) && aliases.length) {
    const instances = new Map<string, JsonValue>();
    for (const [handle, row] of rows) instances.set(handle, new Map([["instance", isMap(row) ? row.get("instance") ?? null : null]]));
    const door = runtimeModule("src/forwarding.ts");
    const child = spawnSync(ownBun(), [...ownBunFlags(), door, "supersede"], {
      input: dumps(new Map<string, JsonValue>([["seats", instances], ["seat_forwardings", aliases]]), true),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new ChildFailure(child.status ?? 1, "command failed (exit " + (child.status ?? 1) + "): bun " + door + " supersede");
    const projected = loads(child.stdout);
    if (!isMap(projected) || !Array.isArray(projected.get("seat_forwardings"))) throw new SessionStateError("invalid forwarding supersede response");
    doc.set("seat_forwardings", projected.get("seat_forwardings")!);
  }
  verbose("state_write", { path });
  lifecycleDiagnostic("state_write", { path });
  atomicWrite(path, pyDumpIndent(doc, 0) + "\n");
}

export function timestamp(): string {
  const seconds = pythonInt(process.env.TAP_WATCH_NOW ?? "", true);
  return new Date(seconds === null ? Date.now() : Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Caller selection is immutable evidence; all decisions use a fresh locked row. */
export function repairRecord(record: SessionRecord, dryRun: boolean): Result {
  const root = rootForCwd(record.cwd), handle = sessionHandle(record);
  const notRegistered = () => result("not_registered", handle + " not registered; run tap in " + handle + " from session " + record.name);
  let path: string | null;
  try { path = actingRegistryPath(root); }
  catch (error) {
    if (!(error instanceof SessionStateError)) throw error;
    if (error instanceof NoMachineIndex) throw error;
    const state = error.message.startsWith("acting registry is invalid") ? "invalid"
      : error.message.startsWith("worktree is not enrolled") ? "live_unenrolled" : "live_unreachable";
    throw new SessionStateError("tap session repair refused — registry authority " + state + "; next: tap doctor");
  }
  if (!path || !existsSync(path)) return notRegistered();
  const lock = acquireRegistryLock(path, Infinity);
  if (!lock) throw new SessionStateError("could not obtain repair registry lock");
  try {
    const doc = readRegistry(path, false), rows = seats(doc), row = rows.get(handle);
    if (!isMap(row)) return notRegistered();
    if (row.get("status") === "pending" && pyTruthy(row.get("session")) && row.get("session") !== record.name) {
      return result("pending_mismatch", handle + " pending for session " + pyStr(row.get("session")) + ", not " + record.name);
    }
    if (row.get("status") === "suspended" && row.get("status_reason") === "user_removed") {
      return result("user_removed", handle + " parked by user; run tap in " + handle + " to reactivate");
    }
    // R2: the observed pane cannot authorize overwriting a newly attested row.
    if (optionalInstance(row) !== record.instance || row.get("session") !== record.name || row.get("harness") !== record.harness) {
      throw new SessionStateError("repair target changed while waiting for registry lock: " + handle + "; reselect and retry");
    }
    const preservePair = row.get("status") === "suspended" && row.get("status_reason") === "incapable";
    const targets = storedTargets(row, currentEpoch());
    let observed: PaneFacts | null = null;
    for (const target of [...new Set(targets.filter(Boolean))]) {
      if (target === targets[0] && !isPaneId(target)) continue;
      const facts = paneFacts(target);
      if (!facts) continue;
      const session = facts.pane.split(":", 1)[0]!;
      if (session !== record.name) return result("pane_mismatch", "stored pane for " + handle + " belongs to " + session + ", not " + record.name);
      if (facts.dead) return result("not_live", "session " + record.name + " is not live");
      const harness = paneHarness(facts);
      if (harness !== record.harness) return result("non_agent_pane", "stored pane for " + handle + " is " + harness + ", not " + record.harness);
      observed = facts;
      break;
    }
    const fromStored = observed !== null;
    if (!observed) {
      const matched = matchingPane(record);
      if (!matched.facts) return result("not_live", "session " + record.name + " is not live");
      if (matched.harness !== record.harness) return result("non_agent_pane", "session " + record.name + " active pane is " + matched.harness + ", not " + record.harness);
      observed = matched.facts;
    }
    // tap-zk1w: an unstamped pane row can neither resolve as self nor receive,
    // so no repair outcome may leave or promise one. Checked before the
    // enrollment refusal, which may purge a gone enrollment.
    if (!observed.epoch) {
      const detail = "the tmux server generation is not observable, so " + handle + " could not be stamped; nothing was written";
      throw new LauncherError("generation_unverifiable: " + detail, "generation_unverifiable", "wait for tmux to answer, then retry", detail);
    }
    const enrollment = paneEnrollmentRefusal({ paneId: observed.paneId, epoch: observed.epoch,
      socket: currentSocket(observed.epoch) }, root, process.env.TAP_INDEX_HOME);
    if (enrollment) throw new LauncherError(enrollment.errorClass + ": " + enrollment.detail, enrollment.errorClass, enrollment.action, enrollment.detail);
    const owner = activeOwner(rows, handle, observed);
    if (owner) return result("pane_owned", "pane " + observed.pane + " already registered to " + owner);
    if (fromStored) {
      const socket = currentSocket(observed.epoch), boot = bootId() || null;
      const refresh = row.get("pane") !== observed.pane || row.get("pane_id") !== observed.paneId
        || row.get("pane_current_command") !== observed.command || row.get("delivery") !== "pane"
        || (!preservePair && (field(row, "status", "active") !== "active" || field(row, "status_reason", "") !== ""))
        || row.has("launch_id") || row.has("wake_url") || row.has("unattended")
        || (!!socket && row.get("server_socket") !== socket) || field(row, "server_epoch") !== observed.epoch
        || field(row, "boot_id") !== boot || !pyTruthy(row.get("registered_from_worktree"))
        || optionalInstance(row) === null;
      if (!refresh) return result("already_current", handle + " already current at " + observed.pane);
    }
    if (dryRun) return result("would_repair", "would repair " + handle + " -> " + observed.pane);
    const now = currentEpoch();
    if (observed.epoch && now && observed.epoch !== now) {
      throw new SessionStateError("tmux server generation moved between observing the pane and recording it (" + observed.epoch + " -> " + now + "); re-observe and retry");
    }
    for (const [key, value] of Object.entries({
      delivery: "pane", status: preservePair ? "suspended" : "active", status_reason: preservePair ? "incapable" : "",
      harness: record.harness, session: record.name, pane: observed.pane, pane_id: observed.paneId,
      pane_current_command: observed.command, registered_at: timestamp(),
    })) row.set(key, value);
    if (!pyTruthy(row.get("registered_from_worktree"))) row.set("registered_from_worktree", root);
    for (const [key, value] of [["server_epoch", observed.epoch], ["server_socket", currentSocket(observed.epoch)], ["boot_id", bootId()]] as const) {
      if (value) row.set(key, value); else row.delete(key);
    }
    for (const key of ["wake_url", "unattended", "launch_id"]) row.delete(key);
    row.set("instance", ensureSeatInstance({ instance: row.get("instance") }, handle));
    publish(path, doc, rows);
    return result("repaired", "repaired " + handle + " -> " + observed.pane);
  } finally { lock.release(); }
}

function parseOptions(argv: string[]): Options {
  const out: Options = { all: false, dryRun: false, json: false, help: false };
  let positional = false;
  for (const arg of argv) {
    if (!positional && arg === "--") { positional = true; continue; }
    if (!positional && arg.startsWith("-") && arg !== "-") {
      const flags = ["--all", "--dry-run", "--json", "--help"];
      const matches = arg === "-h" ? ["--help"] : flags.filter(flag => flag.startsWith(arg));
      if (matches.length !== 1 || arg === "--") throw new Error("usage");
      const key = matches[0]!;
      if (key === "--all") out.all = true;
      if (key === "--dry-run") out.dryRun = true;
      if (key === "--json") out.json = true;
      if (key === "--help") out.help = true;
    } else {
      if (out.key !== undefined) throw new Error("usage");
      out.key = arg;
    }
  }
  return out;
}

function repair(options: Options): number {
  const cwd = realOrSelf(process.cwd()), root = rootForCwd(cwd);
  // Explicit custom homes remain valid; root-derived effects require a current bus.
  const bus = requireResolvedBus(resolveBus(root, process.env));
  if (bus) {
    const fence = join(bus, "reset.fence.json");
    let fenced = false;
    try { fenced = statSync(fence).isFile(); } catch { /* absent */ }
    if (fenced) throw new SessionStateError(launcherFenceRefusal(fence, "session repair"));
  }
  const path = actingRegistryPath(root), all = path ? payloadRecords(readRegistry(path, true), root) : [];
  const namespace = tmuxSessionNamespace();
  if (!namespace.observable) throw new SessionStateError("tmux session-name snapshot is unobservable; refusing to treat the session namespace as empty");
  if (options.all && options.key) throw new SessionStateError("usage: tap session repair (<handle|session> | --all) [--dry-run]");
  const scoped = all.filter(record => pathIsUnder(record.cwd, root));
  let records: SessionRecord[];
  if (options.all) records = scoped.filter(record => namespace.names.has(record.name));
  else {
    const key = options.key;
    if (!key) throw new SessionStateError("usage: tap session repair <handle|session> [--dry-run]");
    const record = scoped.find(record => record.name === key) ?? scoped.find(record => sessionHandle(record) === key);
    if (!record) {
      const matches = HARNESSES.includes(key) ? scoped.filter(record => record.harness === key) : [];
      if (matches.length) {
        const detail = key + " matches: " + matches.map(record => record.name).sort().join(", ");
        const action = "tap session list --harness " + key;
        if (process.env.TAP_JSON === "1") process.stdout.write(errorJson("session_ambiguous", action, detail));
        else process.stderr.write("tap session repair: " + detail.replace(/[\n\r]/g, " ") + "; next: " + action + "\n");
        return 2;
      }
      throw new SessionStateError("repair key not found: " + key);
    }
    if (!namespace.names.has(record.name) && tmuxReadOnly(["has-session", "-t", "=" + record.name]).code !== 0) {
      throw new SessionStateError("repair target is not live: " + record.name);
    }
    records = [record];
  }
  const repaired: { name: string; harness: string; handle: string; status: RepairStatus; dry_run: boolean }[] = [];
  const failures: { name: string; status: RepairStatus }[] = [];
  for (const record of records) {
    const outcome = repairRecord(record, options.dryRun);
    repaired.push({ name: record.name, harness: record.harness, handle: sessionHandle(record), status: outcome.status, dry_run: options.dryRun });
    if (!options.json) process.stdout.write(outcome.line);
    if (!ok(outcome.status) && !(options.all && outcome.status === "not_registered")) failures.push({ name: record.name, status: outcome.status });
  }
  if (options.json) process.stdout.write(ensureAscii(JSON.stringify({ ok: true, repaired, failures, dry_run: options.dryRun })) + "\n");
  else if (!records.length) process.stdout.write("tap session repair: no live sessions\n");
  else if (options.all && failures.length) process.stdout.write("tap session repair: failed " + failures.map(row => row.name + ":" + row.status).join(", ") + "\n");
  return failures.length ? 2 : 0;
}

export function cmdSessionRepair(argv: string[]): number {
  let options: Options;
  try { options = parseOptions(argv); }
  catch { process.stderr.write(USAGE); return 2; }
  if (options.help) { process.stdout.write(SESSION_REPAIR_HELP); return 0; }
  const jsonRequested = options.json || process.env.TAP_JSON === "1";
  return withStartupTrace(() => {
    const traced = !options.dryRun;
    if (traced) startupTrace("launch_start", { verb: "repair", cwd: process.cwd(), target: options.key ?? null, boot_id: bootId() || null }, true);
    let code = 2;
    try { code = repair(options); }
    catch (error) {
      if (error instanceof NoMachineIndex) {
        if (jsonRequested) process.stdout.write(errorJson(error.errorClass, error.action, error.detail));
        else process.stderr.write("tap session: " + error.message + "\n");
      } else if (error instanceof SessionStateError || error instanceof ServerUnresponsive) {
        if (jsonRequested) process.stdout.write(errorJson("session_error", "tap help session", error.message));
        else process.stderr.write("tap session: " + error.message + "\n");
      } else if (error instanceof LauncherError && error.errorClass) {
        code = error.errorClass === "old_store" || error.errorClass === "generation_unverifiable" ? 1 : 2;
        if (jsonRequested) process.stdout.write(errorJson(error.errorClass, error.action ?? "", error.detail ?? error.message));
        else process.stderr.write("tap session: " + error.message + "; next: " + error.action + "\n");
      } else if (error instanceof ChildFailure) {
        code = error.status;
        process.stderr.write("tap session: " + error.message + "\n");
      } else throw error;
    } finally {
      if (traced) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code });
    }
    return code;
  });
}

if (import.meta.main) process.exitCode = cmdSessionRepair(process.argv.slice(2));
