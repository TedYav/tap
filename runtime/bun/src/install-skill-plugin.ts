import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readManifestRecord, writeManifestAtomically, type ManifestEntry } from "./install-manifest";
import { skillManifestPath } from "./skill-policy";

export const TAP_MARKETPLACE = "tap-marketplace";
export const TAP_PLUGIN = `tap@${TAP_MARKETPLACE}`;
export type PluginHost = "claude" | "codex";
export type PluginCommand = (host: PluginHost, home: string, args: string[]) => unknown;

/** Native CLIs own their registries. TAP records only registrations it creates. */
export const pluginCommand: PluginCommand = (host, home, args) => {
  const path = [process.env.PATH || "", join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
  const executable = Bun.which(host, { PATH: path });
  if (!executable) throw new Error(`${host} CLI is unavailable; install it, then rerun ./install.sh`);
  const env = { ...process.env };
  if (host === "codex") env.CODEX_HOME = home;
  else if (physical(home) === physical(join(homedir(), ".claude"))) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = home;
  const result = spawnSync(executable, ["plugin", ...args, "--json"], {
    env,
    encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${host} plugin ${args.join(" ")} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim()}`);
  try { return JSON.parse(result.stdout); }
  catch {
    // Claude's inventory is pretty-printed JSON; mutation commands may prefix
    // a final JSON line with progress output.
    if (host === "claude") {
      try { return JSON.parse(result.stdout.trim().split("\n").at(-1)!); } catch {}
    }
    throw new Error(`${host} plugin returned invalid JSON for ${args.join(" ")}`);
  }
};

function state(host: PluginHost, home: string, run: PluginCommand) {
  const markets = run(host, home, ["marketplace", "list"]) as any;
  const plugins = run(host, home, ["list"]) as any;
  const marketRows = host === "claude" ? markets : markets?.marketplaces;
  const pluginRows = host === "claude" ? plugins : plugins?.installed;
  if (!Array.isArray(marketRows) || !Array.isArray(pluginRows)) throw new Error(`${host} returned an unsupported plugin inventory`);
  const matching = marketRows.filter((m: any) => m.name === TAP_MARKETPLACE);
  if (matching.length > 1) throw new Error(`${host} has ambiguous ${TAP_MARKETPLACE} registrations`);
  const market = matching[0];
  const source = host === "claude" ? (market?.source === "directory" ? market.path : undefined)
    : (market?.marketplaceSource?.sourceType === "local" ? market.marketplaceSource.source : undefined);
  const selected = pluginRows.filter((p: any) => (host === "claude" ? p.id : p.pluginId) === TAP_PLUGIN);
  // Project-scoped Claude registrations are a separate user's choice. Never adopt them.
  const plugin = selected.find((p: any) => host !== "claude" || p.scope === "user");
  if (plugin && typeof plugin.enabled !== "boolean") throw new Error(`${host} returned an unknown plugin enabled state`);
  return { market, source, plugin, plugins: pluginRows, otherScope: selected.length > (plugin ? 1 : 0) };
}
const physical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
const sameSource = (source: unknown, repo: string) => typeof source === "string" && physical(source) === physical(repo);
const recordedSource = (source: unknown, entry: ManifestEntry) => typeof source === "string"
  && [entry.nativeSource, entry.pendingSource].some(value => typeof value === "string" && resolve(source) === resolve(value));
/** The listing still names TAP's clone as its source, so the clone must outlive the uninstall. */
export const RETAINED_LISTING = "removed TAP's user-scope registration (marketplace still listed; left in place)";
const USER_SCOPE_GONE = /not declared in user settings/;
const scope = (host: PluginHost) => host === "claude" ? ["--scope", "user"] : [];

export function skillPluginReady(repo: string, host: PluginHost, home: string): boolean {
  try { const found = state(host, home, pluginCommand); return sameSource(found.source, repo) && !!found.plugin; }
  catch { return false; }
}

export function installSkillPlugin(repo: string, host: PluginHost, home: string, log: (line: string) => void, run: PluginCommand = pluginCommand): void {
  repo = resolve(repo); home = resolve(home);
  const manifestPath = skillManifestPath(), manifest = readManifestRecord(manifestPath);
  let current = state(host, home, run);
  const pathFor = (kind: string) => join(home, "plugins", kind === "native-plugin" ? TAP_PLUGIN : TAP_MARKETPLACE);
  const owned = (kind: string) => manifest.entries.find(e => e.kind === kind && e.path === pathFor(kind)
    && e.host === host && e.home === home && e.source === repo && e.plugin === TAP_PLUGIN && e.marketplace === TAP_MARKETPLACE);
  const marketOwner = owned("native-marketplace");
  const targetSource = host === "codex" ? physical(repo) : repo;
  const relocating = current.market && !sameSource(current.source, repo);
  if (relocating && (!marketOwner || !recordedSource(current.source, marketOwner))) throw new Error(`${host} ${TAP_MARKETPLACE} belongs to another source; preserved it and the existing skills`);
  if (!current.market && current.plugin && marketOwner?.pendingSource !== targetSource) throw new Error(`${host} ${TAP_PLUGIN} has no marketplace source; restore its marketplace before rerunning ./install.sh`);
  if (current.otherScope) throw new Error(`${host} has a project or local ${TAP_PLUGIN}; reconcile that registration before rerunning ./install.sh`);
  const record = (kind: string, nativeSource = targetSource, pendingSource?: string) => {
    const entry: ManifestEntry = { kind, path: pathFor(kind), host, home, source: repo, nativeSource, ...(pendingSource ? { pendingSource } : {}), plugin: TAP_PLUGIN, marketplace: TAP_MARKETPLACE };
    manifest.entries = manifest.entries.filter(e => !(e.kind === kind && e.path === entry.path));
    manifest.entries.push(entry); manifest.repo ??= repo;
    writeManifestAtomically(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  };
  if (relocating) {
    if (current.plugins.some((p: any) => String(p.id ?? p.pluginId).endsWith(`@${TAP_MARKETPLACE}`) && (p.id ?? p.pluginId) !== TAP_PLUGIN)) {
      throw new Error(`${host} ${TAP_MARKETPLACE} has unrelated plugins; preserved its source`);
    }
    // Keep both exact sources until the new registration is confirmed. A retry
    // can resume after remove or add fails without treating a release path as ownership.
    record("native-marketplace", current.source as string, targetSource);
    if (owned("native-plugin")) record("native-plugin", current.source as string, targetSource);
    run(host, home, ["marketplace", "remove", TAP_MARKETPLACE, ...scope(host)]);
    current = state(host, home, run);
    if (current.market) throw new Error(`${host} marketplace relocation was not confirmed; existing skills preserved`);
  }
  if (!current.market) {
    // Journal intent after proving absence, before a native command can leave partial state.
    if (!owned("native-marketplace")) record("native-marketplace");
    run(host, home, ["marketplace", "add", resolve(repo), ...scope(host)]);
  }
  // Codex hides installed rows while their marketplace is absent. Re-read after
  // add so an interrupted relocation cannot turn a disabled plugin back on.
  current = state(host, home, run);
  if (!sameSource(current.source, repo) || current.otherScope) throw new Error(`${host} marketplace registration was not confirmed; existing skills preserved`);
  for (const kind of ["native-marketplace", "native-plugin"]) if (owned(kind)) record(kind, current.source as string);
  if (!current.plugin) {
    record("native-plugin");
    run(host, home, [host === "claude" ? "install" : "add", TAP_PLUGIN, ...scope(host)]);
  } else if (current.plugin.enabled === false) {
    // Codex exposes no native enable/disable CLI. Refresh on the next install after
    // the user enables it; never let a reinstall override their disabled choice.
    log(`install: preserved disabled ${host} plugin ${TAP_PLUGIN}; not refreshed`);
  } else {
    if (host === "codex") log("install: refreshing Codex plugin with native add; keep its enabled setting unchanged until refresh completes (add enables the plugin)");
    run(host, home, [host === "claude" ? "update" : "add", TAP_PLUGIN, ...scope(host)]);
  }
  const confirmed = state(host, home, run);
  if (!sameSource(confirmed.source, repo) || !confirmed.plugin) throw new Error(`${host} plugin registration was not confirmed; existing skills preserved`);
  if (current.plugin?.enabled === false && confirmed.plugin.enabled !== false) throw new Error(`${host} changed the disabled plugin state; existing skills preserved`);
  log(`install: registered ${host} plugin ${TAP_PLUGIN}`);
}

/** Removal is conditional on both recorded ownership and the current native source. */
export function removeSkillPlugin(entry: ManifestEntry, dryRun = false, run: PluginCommand = pluginCommand, plannedRemovals = new Set<string>()): string {
  if ((entry.host !== "claude" && entry.host !== "codex") || typeof entry.home !== "string" || typeof entry.source !== "string"
    || !isAbsolute(entry.home) || !isAbsolute(entry.source) || typeof entry.nativeSource !== "string" || !isAbsolute(entry.nativeSource)
    || (entry.pendingSource !== undefined && (typeof entry.pendingSource !== "string" || !isAbsolute(entry.pendingSource)))
    || entry.plugin !== TAP_PLUGIN || entry.marketplace !== TAP_MARKETPLACE
    || entry.path !== join(entry.home, "plugins", entry.kind === "native-plugin" ? TAP_PLUGIN : TAP_MARKETPLACE)) return "preserved invalid plugin ownership record";
  try {
    const current = state(entry.host, entry.home, run);
    if (!current.market) return entry.kind === "native-plugin" ? "preserved plugin with missing marketplace source" : "already missing";
    if (!recordedSource(current.source, entry)) return "preserved changed plugin source";
    if (entry.kind === "native-plugin") {
      if (!current.plugin) return "already missing";
      if (!dryRun) run(entry.host, entry.home, [entry.host === "claude" ? "uninstall" : "remove", TAP_PLUGIN, ...scope(entry.host)]);
    } else {
      // A marketplace can acquire unrelated plugins after TAP creates it.
      const remaining = current.plugins.filter((p: any) => String(p.id ?? p.pluginId).endsWith(`@${TAP_MARKETPLACE}`)
        && !(dryRun && (p.id ?? p.pluginId) === TAP_PLUGIN && (entry.host !== "claude" || p.scope === "user") && plannedRemovals.has(join(entry.home as string, "plugins", TAP_PLUGIN))));
      if (remaining.length) return "preserved marketplace with installed plugins";
      if (!dryRun) {
        try { run(entry.host, entry.home, ["marketplace", "remove", TAP_MARKETPLACE, ...scope(entry.host)]); }
        // TAP records user-scope registrations only. A scoped remove consumes that declaration, so a
        // retry after a later failure finds it gone: already discharged, not a refusal.
        catch (error) { if (!(entry.host === "claude" && USER_SCOPE_GONE.test((error as Error).message))) throw error; }
      }
    }
    if (!dryRun) {
      const after = state(entry.host, entry.home, run);
      if (entry.kind === "native-plugin" ? after.plugin : after.market) {
        // Other scopes' declarations are not TAP's to remove (Claude's --scope omission would erase them).
        if (entry.kind === "native-marketplace" && entry.host === "claude") return RETAINED_LISTING;
        return "preserved unconfirmed plugin removal";
      }
    }
    return "removed";
  } catch (error) { return `preserved plugin registration (${(error as Error).message})`; }
}
