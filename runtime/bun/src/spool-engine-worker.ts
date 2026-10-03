import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { drainOnce, withdrawRetiredEntry, type DrainContext, type SpoolBinding } from "./spool-drain";
import { injectDigest, notifyDigestSenders, realDrainEffects, redeliver } from "./spool-drain-effects";
import { processWatchSpool } from "./spool-watch";
import { spoolTeamName } from "./context";
import { repoRoot, requireResolvedBus, resolveBus } from "./bushome";
import { loadGlobalRegistry, resolveTeamFromDoc, busHomeForRegistry } from "./index-home";
import { statSync } from "node:fs";
import { emptyGcBatch, parseGcBatch } from "./spool-gc";

/** The retained worker's bus is already selected; cwd enrollment cannot replace it. */
export function spoolContextFacts(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const root = repoRoot(cwd);
  const pin = env.TAP_HOME;
  const bus = resolveBus(root, pin && !isAbsolute(pin) ? { ...env, TAP_HOME: join(cwd, pin) } : env);
  const home = requireResolvedBus(bus), index = loadGlobalRegistry(env.TAP_INDEX_HOME);
  const team = index.marker === "live" ? spoolTeamName(home, env.TAP_INDEX_HOME) : "";
  const resolved = index.marker === "live" ? resolveTeamFromDoc(index.doc ?? {}, team) : null;
  const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
  const registry = resolved?.status === "ok" && (busHomeForRegistry(resolved.registryLocation)
    || isDir(join(resolved.root, ".tap/bus"))) ? resolved.registryLocation : "";
  return [home, join(home, "spool"), join(home, "payloads"), join(home, "receipts"),
    join(home, "registry-events.log"), team, registry, env.TAP_VERB || "tap", "courier",
    env.TAP_SPOOL_DRAIN_ACTIVE || "0", env.TAP_SPOOL_HUMAN_ALERT || "",
    env.TAP_WATCH_TICK_QUEUED_PROBE_ID || "", env.TAP_WATCH_TICK_PROBE_TIMEOUT || "", bus.rule];
}

export async function spoolEngineMain(argv: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const args = [...argv];
  let facts: string[];
  const explicit = args[0] === "--facts";
  if (explicit) args.shift();
  const scriptsDir = args.shift();
  if (!scriptsDir) throw new Error("spool engine needs the companion scripts directory");
  if (explicit) facts = args.splice(0, 14);
  else facts = spoolContextFacts(process.cwd(), env);
  const [home, spoolDir, payloadsDir, receiptsDir, eventLog, team, actingRegistry, verbLabel, courierIdentity, active, alert, queued, timeout, busRule] = facts;
  if (!home || !spoolDir || !payloadsDir || !receiptsDir || !eventLog) throw new Error("incomplete spool context");
  const [op, ...a] = args;
  signal?.throwIfAborted();
  const nowText = op === "watch" ? a[1] : op === "drain" ? a[0] : "";
  const cleanEnv: NodeJS.ProcessEnv = { ...env, TAP_HOME: home };
  // Transporting the selected bus does not turn a source-derived bus into a
  // caller pin. Preserve the Bash parent's literal pane/obligation lock root.
  if (!env.TAP_LOCK_DIR && !env.TAP_INDEX_HOME && busRule !== "env") cleanEnv.TAP_LOCK_DIR = join(env.HOME || homedir(), ".tap/locks");
  // Caller facts are data, never inherited authority for a reowned waiter.
  delete cleanEnv.TAP_SPOOL_HUMAN_ALERT;
  delete cleanEnv.TAP_WATCH_TICK_ACTIVE;
  delete cleanEnv.TAP_WATCH_TICK_QUEUED_PROBE_ID;
  delete cleanEnv.TAP_WATCH_TICK_PROBE_TIMEOUT;
  // This is a dedicated worker. Existing native helpers that default to its
  // environment must observe the same scrubbed authority as explicit callbacks.
  process.env = cleanEnv;
  const ctx: DrainContext = { home, spoolDir, payloadsDir, receiptsDir, eventLog, team: team || "", actingRegistry: actingRegistry || "",
    verbLabel: verbLabel || "tap", courierIdentity: courierIdentity || "courier", scriptsDir, active: active === "1", signal,
    now: Number(nowText || env.TAP_SPOOL_NOW || Math.floor(Date.now() / 1000)),
    unroutedGrace: Number(env.TAP_SPOOL_UNROUTED_GRACE || 1800), env: cleanEnv,
    alert: alert === "watcher" ? { mode: "tick", queuedProbeId: queued || "", probeTimeout: timeout || "" } : { mode: "none" } };
  const effects = realDrainEffects(ctx);
  if (op === "watch") {
    try { ctx.gcBatch = parseGcBatch(env.TAP_SPOOL_GC_BATCH); }
    catch (error) { process.stderr.write(`tap spool cleanup: ${String(error)}\n`); ctx.gcBatch = emptyGcBatch(); }
  }
  if (op === "drain") return drainOnce(ctx, effects, { cap: a[1], target: a[2], registry: a[3] });
  if (op === "watch") {
    ctx.alert = { mode: "tick", queuedProbeId: a[2] || "", probeTimeout: a[3] || "" };
    return processWatchSpool(ctx, effects, a[0] || "");
  }
  if (op === "retired") return withdrawRetiredEntry(ctx, a[0] || "", a[1] || "");
  if (op === "repair") { await effects.repairOrphans(); return 0; }
  if (op === "redeliver" || op === "redeliver-locked") {
    const [id = "", target = "", pane = "", paneId = "", toTeam = "", targetRegistry = ""] = a;
    return redeliver(ctx, id, { target, pane, paneId, toTeam, targetRegistry },
      { locked: op === "redeliver-locked", force: env.TAP_SUBMIT_FORCE_NO_PROMPT === "1" });
  }
  if (op === "digest") {
    const [targetRegistry = "", toTeam = "", target = "", pane = "", paneId = "", ...ids] = a;
    return injectDigest(ctx, { targetRegistry, toTeam, target, pane, paneId }, ids);
  }
  if (op === "digest-notices") {
    const [digest = "", target = "", targetRegistry = "", ...ids] = a;
    return notifyDigestSenders(ctx, digest, { target, targetRegistry, pane: "", paneId: "", toTeam: "" }, ids);
  }
  throw new Error(`unknown spool engine operation '${op}'`);
}
