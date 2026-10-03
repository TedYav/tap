// `tap admin rebuild-registry` (admin-r7 U5): the audit-write that re-anchors
// seat rows to panes actually observed in tmux. The plan is built from ONE
// machine-wide pane sweep; every mutation is gated on a server-generation
// recheck, a scratch-prefix guard, a full-plan validation, and a per-registry
// lock — and publishes through a complete-write+fsync+rename (amendment 3).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { ensureAscii } from "../fsatomic";
import { markerSelectedIndex } from "../index-home";
import { requireResolvedBus, resolveBus } from "../bushome";
import { pyReadUtf8 } from "../spool-publication";
import { isMap, loads, type JsonMap, type JsonValue } from "../watch-detect";
import { acquirePathLock } from "../panelock";
import { serverEpochNow } from "../spool-park-report";
import { serverEpochFromRaw, tmuxReadOnly } from "../tmux";
import { agentFamilies, classifyHarness, harnessFamily, harnessFallbackHandle, isPaneId, observeProcessHarness, parsePsTable } from "../observe";
import { ensureSeatInstance, type Seat } from "../registry";
import { HELP_HANDLE, USER_IDENTITY, WATCH_IDENTITY, validToken } from "../ids";
import { noMachineIndexError, TapError } from "../context";
import { errorText, readMachineIndex, serializeRegistryDocument } from "./admin";

const LABEL = "tap admin rebuild-registry";
const SWEEP_FORMAT = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pid}:#{start_time}\t#{pane_current_path}";

interface PlanItem {
  team: string; root: string; registry: string; handle: string; pane: string;
  paneId: string; paneCmd: string; harness: string; registeredAt: string; sweepEpoch: string;
  paneMatch: boolean;
}

const cmdSubst = (text: string): string => text.replace(/\0/g, "").replace(/\n+$/, "");
const isFileTwin = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/** registry_v20.resolve_team_registry_for_root: the acting path, resolved from
 * the ONE machine-index row the sweep already read — root and acting location
 * come back together, so an A-root/B-registry mix cannot be built. An empty or
 * non-file location is live_unreachable, never the bus decoy beneath it. */
function resolveTeamRegistryForRow(row: { name: string; root: string; registryLocation: string }): { state: string; path: string } {
  if (row.registryLocation && isFileTwin(row.registryLocation)) return { state: "live", path: row.registryLocation };
  return { state: "live_unreachable", path: row.registryLocation };
}

/** lib.sh tap_derive_handle: session → seat handle, '' when unusable. */
function deriveHandle(session: string, team: string, families: readonly string[]): string {
  if (!session) return "";
  let s = session;
  if (s.startsWith(`${team}/`)) {
    s = s.slice(team.length + 1);
    if (s.includes("/")) return "";
    if (/^[0-9]+$/.test(s)) return "";
    return validToken(s) ? s : "";
  }
  for (const prefix of [`${team}-`, `${team}_`]) {
    if (s.startsWith(prefix)) { s = s.slice(prefix.length); break; }
  }
  let keepIndex = "";
  const numbered = /^(.+)[-_]([0-9]+)$/.exec(s);
  if (numbered) {
    s = numbered[1]!;
    // 0/1 are legacy pane-numbering noise; 2+ is a deliberate sibling suffix.
    if (Number.parseInt(numbered[2]!, 10) >= 2) keepIndex = numbered[2]!;
  }
  if (!s) return "";
  if (s.includes("-")) {
    const head = s.slice(0, s.indexOf("-"));
    const rest = s.slice(s.indexOf("-") + 1);
    if (rest && classifyHarness(harnessFamily(head, families), families) !== "unsupported") s = rest;
  }
  if (/^[0-9]+$/.test(s)) return "";
  if (keepIndex) s = `${s}-${keepIndex}`;
  return validToken(s) ? s : "";
}

function reservedHandleReason(handle: string): string {
  if (handle === WATCH_IDENTITY) return "the reserved watcher identity";
  if (handle === HELP_HANDLE) return "the CLI help keyword (so 'tap <verb> help' is unambiguous for every verb)";
  if (handle === USER_IDENTITY) return "the reserved operator identity";
  return "";
}

/** tap_pane_harness_command: pane command family, with the process fallback. */
function paneHarness(pane: string, paneCmd: string, families: readonly string[]): string {
  const family = harnessFamily(paneCmd, families);
  if (classifyHarness(family, families) !== "unsupported") return family;
  const pidRun = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_pid}"]);
  const pid = pidRun.code === 0 ? cmdSubst(pidRun.stdout) : "";
  if (!pid) return family;
  const ps = spawnSync("ps", ["-o", "pid=,pgid=,tpgid=,comm=,command=", "-p", pid], { encoding: "utf8" });
  const observation = observeProcessHarness(pid, ps.status === 0 ? parsePsTable(ps.stdout ?? "") : null, ps.status === 0, families);
  return observation.state === "observed" ? observation.family : family;
}

function malformedPaneId(paneId: string): TapError {
  return new TapError(1, "identity_unverified", "verify tmux and retry the registry write",
    `tmux returned invalid pane_id${paneId ? ` '${paneId}'` : ""}; refusing registry write`, LABEL);
}

function refuse(detail: string, action = "repair the named registry, then rerun tap admin rebuild-registry"): TapError {
  return new TapError(1, "registry_invalid", action, detail, LABEL);
}

function applyFailure(detail: string): TapError {
  return refuse(detail || "rebuild plan could not be applied");
}

function scratchCanon(path: string): string {
  let p = path;
  if (!p.startsWith("/")) p = join(process.cwd(), p);
  try {
    if (statSync(p).isDirectory()) p = realpathSync(p);
    else p = join(realpathSync(dirname(p)), basename(p));
  } catch { /* keep the lexical path when the leaf cannot be canonicalized */ }
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function scratchGuard(declared: string, what: string, root: string): void {
  const canonDeclared = scratchCanon(declared);
  const canonRoot = scratchCanon(root);
  if (canonDeclared === "/" || canonRoot === canonDeclared || canonRoot.startsWith(`${canonDeclared}/`)) return;
  throw new TapError(1, "scratch_only_refused", "unset TAP_SCRATCH_ONLY, or point it at the state root you actually meant to clear",
    `TAP_SCRATCH_ONLY declares '${declared}' but ${what} resolved to '${canonRoot}' — refusing to clear state outside the declared scratch prefix`, LABEL);
}

/** The acting registry a rebuild writes into: an existing current-format doc with a seats map. */
function loadRegistryTwin(path: string): JsonMap {
  if (!existsSync(path)) {
    throw refuse(`tap admin rebuild-registry: registry '${path}' does not exist; rebuild never creates a registry (run tap init)`);
  }
  let raw: string;
  try { raw = pyReadUtf8(path); } catch (error) {
    throw refuse(`tap admin rebuild-registry: registry '${path}' is invalid JSON (${errorText(error)})`);
  }
  let doc: JsonValue;
  try { doc = loads(raw); } catch (error) {
    throw refuse(`tap admin rebuild-registry: registry '${path}' is invalid JSON (${errorText(error)})`);
  }
  // A malformed, old or hybrid seat axis is evidence, never replaced or converted.
  if (!isMap(doc) || !isMap(doc.get("seats"))) throw refuse(`tap admin rebuild-registry: registry '${path}' has no seats object`);
  if (doc.has("agents")) throw refuse(`tap admin rebuild-registry: registry '${path}' carries an old agents axis`);
  return doc;
}

const seatsOf = (doc: JsonMap): JsonMap => doc.get("seats") as JsonMap;

const mapToRecord = (m: JsonMap): Record<string, JsonValue> => Object.fromEntries(m);
const recordToMap = (r: Record<string, JsonValue>): JsonMap => new Map(Object.entries(r));

function publishDurably(doc: JsonMap, registry: string): void {
  const body = serializeRegistryDocument(doc);
  const dir = dirname(registry);
  const tmp = join(dir, `.registry.${process.pid}.${randomBytes(6).toString("hex")}`);
  let fd = -1;
  let published = false;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const bytes = Buffer.from(body, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, registry);
    published = true;
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* already closed */ } }
    if (!published) { try { unlinkSync(tmp); } catch { /* best-effort reaping */ } }
  }
}

export function cmdAdminRebuild(argv: string[], scriptsDir: string): number {
  void scriptsDir;
  process.env.TAP_JSON = "0";
  let yes = false;
  for (const arg of argv) {
    if (arg === "--yes") yes = true;
    else if (arg === "--json") process.env.TAP_JSON = "1";
    else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help admin rebuild-registry", `unknown option '${arg}'`, LABEL);
    else throw new TapError(1, "usage_error", "tap help admin rebuild-registry", `unexpected arg '${arg}'`, LABEL);
  }
  const selected = markerSelectedIndex();
  if (selected.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor",
      "global-registry.json is present but unreadable or wrong schema — refusing admin index ops", LABEL);
  }
  if (selected.marker === "absent") throw noMachineIndexError(LABEL);
  const indexedTeams = readMachineIndex(selected.path);
  for (const row of indexedTeams) if (row.exists) requireResolvedBus(resolveBus(row.root, {}));

  // ONE machine-wide sweep feeds every team: pane, pane_id, command, epoch raw, path.
  const sweep = tmuxReadOnly(["list-panes", "-a", "-F", SWEEP_FORMAT]);
  const paneRows = (sweep.code === 0 ? sweep.stdout : "").split("\n").filter(line => line.length > 0);
  const rebuildNow = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const families = agentFamilies();

  const plan: PlanItem[] = [];
  const skippedTeams: string[] = [];
  for (const row of indexedTeams) {
    if (!row.exists) continue;
    const resolved = resolveTeamRegistryForRow(row);
    const registry = resolved.path;
    // live_unreachable / no path mean "no acting registry to trust" — never
    // the bus decoy beneath it.
    if (resolved.state === "live_unreachable" || !registry) {
      process.stderr.write(`tap admin rebuild-registry: skipping team '${row.name}' — acting registry unreachable/invalid (refuse bus decoy)\n`);
      skippedTeams.push(row.name);
      continue;
    }
    for (const line of paneRows) {
      const [pane = "", paneId = "", paneCmd = "", paneEpoch = "", panePath = ""] = line.split("\t");
      if (!pane || !paneId) continue;
      if (!isPaneId(paneId)) throw malformedPaneId(paneId);
      if (!(panePath === row.root || panePath.startsWith(`${row.root}/`))) continue;
      const session = pane.slice(0, pane.indexOf(":"));
      // tap-2al3d: when the session name yields no handle (a bare numeric
      // `tmux` session), fall back to the pane's positively observed harness
      // family; the per-team suffixing below keeps same-family siblings
      // deterministic. Unclassifiable panes are skipped as before.
      let handle = deriveHandle(session, row.name, families);
      if (!handle) handle = harnessFallbackHandle(paneHarness(pane, paneCmd, families), families);
      if (!handle) continue;
      const reserved = reservedHandleReason(handle);
      if (reserved) {
        process.stderr.write(`tap admin rebuild-registry: skipping pane '${pane}' — derived handle '${handle}' is ${reserved} and cannot be a seat handle\n`);
        continue;
      }
      const harness = paneHarness(pane, paneCmd, families);
      if (classifyHarness(harness, families) === "unsupported") continue;
      let sweepEpoch = "";
      try { sweepEpoch = serverEpochFromRaw(paneEpoch, process.env); } catch { sweepEpoch = ""; }
      plan.push({
        team: row.name, root: row.root, registry, handle, pane, paneId, paneCmd,
        harness, registeredAt: rebuildNow, sweepEpoch, paneMatch: false,
      });
    }
  }

  // The scratch interlock gates the APPLY, never the preview.
  if (yes && process.env.TAP_SCRATCH_ONLY) {
    const seen: string[] = [];
    for (const item of plan) {
      if (!seen.includes(item.registry)) seen.push(item.registry);
    }
    for (const registry of seen) {
      scratchGuard(process.env.TAP_SCRATCH_ONLY, "a registry tap admin rebuild-registry would rewrite", registry);
    }
  }

  const sweepEpochs = [...new Set(plan.map(item => item.sweepEpoch).filter(epoch => epoch))];
  if (sweepEpochs.length > 1) {
    const [a, b] = [...sweepEpochs].sort();
    throw applyFailure(`tap admin rebuild-registry: pane sweep reported two server generations (${a} and ${b}); rerun`);
  }
  const sweepEpoch = sweepEpochs[0] ?? "";
  const recheckEpoch = process.env.TAP_REBUILD_SERVER_EPOCH !== undefined ? process.env.TAP_REBUILD_SERVER_EPOCH : serverEpochNow();
  if (sweepEpoch && recheckEpoch && sweepEpoch !== recheckEpoch) {
    throw new TapError(1, "server_epoch_moved", LABEL,
      `tmux server generation moved during the sweep (${sweepEpoch} -> ${recheckEpoch}); nothing was written`, LABEL);
  }

  // tap-zk1w: every rebuilt row is pane-backed and must carry the sweep's
  // generation; an unstamped one could neither resolve as self nor receive.
  if (plan.some(item => !item.sweepEpoch)) {
    throw new TapError(1, "generation_unverifiable", "wait for tmux to answer, then retry",
      "the tmux server generation was not observable during the pane sweep, so rebuilt rows could not be stamped; nothing was written", LABEL);
  }

  // VALIDATE THE WHOLE PLAN BEFORE THE FIRST WRITE.
  const registryOrder: string[] = [];
  for (const item of plan) if (!registryOrder.includes(item.registry)) registryOrder.push(item.registry);
  const registryTeams = new Map(registryOrder.map(registry => [registry, plan.find(item => item.registry === registry)!.team]));
  const paneHandles = new Map<string, { handle: string; proven: boolean }>();
  for (const registry of registryOrder) {
    const team = registryTeams.get(registry)!;
    const seats = seatsOf(loadRegistryTwin(registry));
    for (const [handle, seat] of seats) {
      if (!isMap(seat)) continue;
      const storedPaneId = seat.get("pane_id");
      if (typeof storedPaneId !== "string" || !storedPaneId) continue;
      const item = plan.find(candidate => candidate.registry === registry && candidate.paneId === storedPaneId);
      const proven = Boolean(item?.sweepEpoch && typeof seat.get("server_epoch") === "string" && seat.get("server_epoch") === item.sweepEpoch);
      const key = `${team}\u0000${storedPaneId}`;
      const known = paneHandles.get(key);
      if (known && known.handle !== handle) {
        throw applyFailure(`tap admin rebuild-registry: registry '${registry}' maps pane ${storedPaneId} to multiple handles`);
      }
      paneHandles.set(key, { handle, proven });
    }
  }
  for (const item of plan) {
    const known = paneHandles.get(`${item.team}\u0000${item.paneId}`);
    if (known && (known.proven || known.handle === item.handle)) {
      item.handle = known.handle;
      item.paneMatch = true;
    }
  }

  // Suffixing keeps sibling panes that derive the same base handle distinct.
  const usedByTeam = new Map<string, Set<string>>();
  for (const registry of registryOrder) {
    const team = registryTeams.get(registry)!;
    const used = usedByTeam.get(team) ?? new Set<string>();
    for (const handle of seatsOf(loadRegistryTwin(registry)).keys()) used.add(handle);
    usedByTeam.set(team, used);
  }
  for (const item of plan) {
    const used = usedByTeam.get(item.team) ?? new Set<string>();
    used.add(item.handle);
    usedByTeam.set(item.team, used);
  }
  const groups = new Map<string, PlanItem[]>();
  for (const item of plan) {
    const key = `${item.team}\u0000${item.handle}`;
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // A proven pane match keeps its stored handle first; the rest get -2, -3, …
    group.sort((a, b) => Number(b.paneMatch) - Number(a.paneMatch) || (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
    const used = usedByTeam.get(group[0]!.team)!;
    for (const sibling of group.slice(1)) {
      let suffix = 2;
      while (used.has(`${sibling.handle}-${suffix}`)) suffix++;
      sibling.handle = `${sibling.handle}-${suffix}`;
      used.add(sibling.handle);
    }
  }

  // Report decisions that a pane observation cannot replace. On apply this
  // must inspect the fresh locked row, not the earlier planning snapshot.
  const preserved: Array<Record<string, string>> = [];
  const reportPreserved = (item: PlanItem, existing: JsonValue | undefined): void => {
    if (!isMap(existing)) return;
    if (existing.get("delivery") !== "poll" && existing.get("status") !== "suspended") return;
    const entry: Record<string, string> = { team: item.team, handle: item.handle, pane: item.pane };
    for (const key of ["delivery", "status", "status_reason"]) {
      const value = existing.get(key);
      if (typeof value === "string") entry[key] = value;
    }
    preserved.push(entry);
  };
  if (!yes) {
    for (const registry of registryOrder) {
      const seats = seatsOf(loadRegistryTwin(registry));
      for (const item of plan.filter(item => item.registry === registry)) reportPreserved(item, seats.get(item.handle));
    }
  }
  const applied: PlanItem[] = [];
  if (yes) {
    for (const registry of registryOrder) {
      const items = plan.filter(item => item.registry === registry);
      mkdirSync(dirname(registry), { recursive: true });
      const lock = acquirePathLock(`${registry}.lock`);
      if (!lock) throw applyFailure(`tap admin rebuild-registry: could not lock registry '${registry}'`);
      try {
        const team = registryTeams.get(registry)!;
        const doc = loadRegistryTwin(registry);
        const seats = seatsOf(doc);
        for (const item of items) {
          const existing = seats.get(item.handle);
          // A JSON null row is the incumbent's `existing is None` / `dict(
          // existing or {})`: treated as empty, not as corrupt evidence.
          // String/number/list rows stay refusals.
          if (existing !== undefined && existing !== null && !isMap(existing)) {
            throw applyFailure(`tap admin rebuild-registry: registry '${registry}' entry '${item.handle}' is not an object`);
          }
          // Plain-object world for ensureSeatInstance; lossless values survive
          // the Map↔Record round trip untouched.
          const record = mapToRecord(isMap(existing) ? existing : new Map());
          reportPreserved(item, existing);
          if (!isMap(existing)) {
            record.delivery = "pane";
            record.status = "active";
            record.status_reason = "";
            record.registered_at = item.registeredAt;
          }
          // Existing decisions and provenance (including absent keys) survive.
          // Only pane-observable fields belong in this update list; justify
          // additions against tap-q7ec's DECIDED/OBSERVABLE classification.
          record.harness = item.harness;
          record.pane = item.pane;
          record.pane_current_command = item.paneCmd;
          record.pane_id = item.paneId;
          if (!record.registered_from_worktree) record.registered_from_worktree = item.root;
          record.server_epoch = item.sweepEpoch;
          ensureSeatInstance(record as unknown as Seat, item.handle);
          seats.set(item.handle, recordToMap(record));
          applied.push(item);
        }
        publishDurably(doc, registry);
      } finally {
        lock.release();
      }
    }
  }

  const receipt = {
    ok: skippedTeams.length === 0,
    dry_run: !yes,
    planned: plan.map(item => ({ team: item.team, handle: item.handle, pane: item.pane, pane_id: item.paneId, harness: item.harness })),
    applied: applied.map(item => ({ team: item.team, handle: item.handle, pane: item.pane, pane_id: item.paneId, harness: item.harness })),
    ...(preserved.length ? { preserved } : {}),
    ...(skippedTeams.length ? { skipped: skippedTeams, skipped_reason: "acting_registry_unreachable_or_invalid" } : {}),
  };
  if (process.env.TAP_JSON === "1") {
    process.stdout.write(`${ensureAscii(JSON.stringify(receipt))}\n`);
    if (skippedTeams.length) return 1;
    return 0;
  }
  const verb = yes ? "rebuilt" : "would rebuild";
  for (const item of yes ? applied : plan) {
    process.stdout.write(`tap admin rebuild-registry: ${verb} ${item.team}/${item.handle} from ${item.pane}\n`);
  }
  for (const entry of preserved) {
    const decisions = ["delivery", "status", "status_reason"].filter(key => key in entry).map(key => `${key}=${entry[key]}`).join(" ");
    process.stdout.write(`${LABEL}: kept ${entry.team}/${entry.handle} ${decisions}; observed pane ${entry.pane}\n`);
  }
  if (skippedTeams.length) {
    for (const name of skippedTeams) {
      process.stderr.write(`tap admin rebuild-registry: skipped team '${name}' — acting registry unreachable/invalid (refuse bus decoy)\n`);
    }
    throw new TapError(1, "acting_registry_unreachable", "repair acting team-registry (or tap doctor), then rerun tap admin rebuild-registry",
      `skipped ${skippedTeams.length} enrolled team(s) with unreachable/invalid acting registry: ${skippedTeams.join(" ")}`, LABEL);
  }
  return 0;
}
