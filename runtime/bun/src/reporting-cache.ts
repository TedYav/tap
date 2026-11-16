import { join } from "node:path";
import { configDirectory, isRegularFile, readSecureBytes } from "./config-file";
import { observeCallerIdentity, reportingContext, resolveContext, type CallingPaneObservation } from "./context";
import { tryLoadCatalogForDisplay } from "./launcher/catalog-listing";
import { Notices } from "./launcher/catalog-notices";
import { rosterRegistryStamp } from "./roster-cache";
import { cacheDigest, runtimeCache } from "./runtime-cache";
import { physicalSocketPath } from "./tmux";
import { enrolledSeatForPane } from "./registry";

type Caller = Pick<Extract<CallingPaneObservation, { state: "inside" }>, "state" | "paneId" | "session" | "serverEpoch">;

function validCaller(value: unknown): value is Caller {
  if (!value || typeof value !== "object") return false;
  const seen = value as Caller;
  return seen.state === "inside" && typeof seen.paneId === "string" && /^%\d+$/.test(seen.paneId)
    && typeof seen.session === "string" && seen.session.length > 0
    && typeof seen.serverEpoch === "string" && seen.serverEpoch.length > 0;
}

/** A shortcut for implicit, ordinary pane reports; no cached bus selection. */
export function prepareReportingCache(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const observedAt = Date.now();
  const verb = argv[0] ?? "";
  if (!["whoami", "outstanding", "poll", "show"].includes(verb) || argv.includes("--pane") || argv.includes("--team")
    || env.TAP_VERBOSE === "1" || env.TAP_REPORTING_CACHE_TTL === "0" || env.OPENCODE_SESSION_ID !== undefined
    || env.CLAUDE_JOB_DIR || env.TAP_HOME || env.GIT_DIR || env.GIT_WORK_TREE || !env.TMUX || !env.TMUX_PANE) return null;
  try {
    // Resolve the bus from current enrollment on every call, before opening
    // a cache file. A linked worktree may need a pane-presence location hint.
    let ctx = reportingContext(process.cwd(), env);
    if (!ctx) {
      // Inherited pane presence locates a cache file; it supplies no output identity or effect authority.
      const hint = enrolledSeatForPane(env.TMUX_PANE, env.TAP_INDEX_HOME);
      if (hint) ctx = resolveContext(process.cwd(), env, { explicitTeam: hint.team, paneFallback: false });
    }
    if (!ctx) return null;
    const catalog = tryLoadCatalogForDisplay(new Notices(() => {}), env, readSecureBytes, configDirectory(env), isRegularFile);
    const configured = catalog?.advanced?.reporting_cache_ttl_seconds ?? 5;
    const override = env.TAP_REPORTING_CACHE_TTL?.trim();
    const ttl = override && Number.isFinite(Number(override)) && Number(override) >= 0 ? Number(override) : configured;
    if (ttl <= 0) return null;
    const registryStamp = rosterRegistryStamp(ctx.registryPath);
    if (registryStamp === null) return null;
    const callerKey = { cwd: process.cwd(), pane: env.TMUX_PANE, socket: physicalSocketPath(env) };
    const cache = runtimeCache(join(ctx.bus.home, "runtime-cache"), `reporting-${cacheDigest(callerKey)}`, {
      ...callerKey, team: ctx.team, root: ctx.root, registry: ctx.registryPath, registryStamp,
      path: env.PATH, tmux: env.TMUX, epochPin: env.TAP_SERVER_EPOCH,
    }, ttl, validCaller);
    return {
      ctx,
      read() {
        const hit = cache.read();
        return hit && hit.snapshot.paneId === env.TMUX_PANE ? hit.snapshot : null;
      },
      remember() {
        // show's forensic display creates no files. It can consume a sibling
        // report's observation but never publishes one of its own.
        if (verb === "show") return;
        try {
          const actual = resolveContext(process.cwd(), env), seen = observeCallerIdentity(env);
          if (actual.team !== ctx.team || actual.root !== ctx.root || actual.registryPath !== ctx.registryPath || actual.bus.home !== ctx.bus.home
            || seen.state !== "inside" || seen.paneId !== env.TMUX_PANE || seen.selectedHandle) return;
          cache.write({ state: "inside", paneId: seen.paneId, session: seen.session, serverEpoch: seen.serverEpoch }, observedAt);
        } catch { /* An unavailable observation leaves the next report on its live path. */ }
      },
    };
  } catch { return null; }
}
