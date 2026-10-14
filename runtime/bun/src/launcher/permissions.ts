import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lockRoot } from "../panelock";
import { physicalSocketPath } from "../tmux";
import { busHomeForRegistry, loadGlobalRegistry, resolveTeamFromDoc } from "../index-home";
import { LauncherError } from "./types";

export type PermissionMode = "bypass" | "auto";
export function permissionMode(value: unknown): PermissionMode {
  if (value === undefined) return "bypass";
  if (value === "bypass" || value === "auto") return value;
  throw new LauncherError('harness_permissions_invalid: permissions must be "bypass" or "auto"', "harness_permissions_invalid");
}

/** The launcher-owned flags per harness. AGY has no auto-approval mode, so its auto omits the bypass flag. */
const PERMISSION_ARGV: Record<string, Record<PermissionMode, string[]>> = {
  claude: { bypass: ["--dangerously-skip-permissions"], auto: ["--permission-mode", "auto"] },
  codex: { bypass: ["--dangerously-bypass-approvals-and-sandbox"], auto: ["--approve-for-me"] },
  cursor: { bypass: ["--force", "--sandbox", "disabled"], auto: ["--auto-review"] },
  agy: { bypass: ["--dangerously-skip-permissions"], auto: [] },
};
/** Harnesses whose permissions TAP owns; OpenCode and Hermes stay params-based. */
export const PERMISSION_HARNESSES = Object.keys(PERMISSION_ARGV);

/**
 * Codex's auto sandbox denies the tmux socket and TAP's state writes, so a seat has no pane identity
 * and cannot send, read or reply. TAP's own profile extends the built-in `:workspace` sandbox and adds
 * only: the exact tmux socket (reachable only through Codex's network proxy, which blocks every
 * destination because no domain is allowed) and write access to TAP's index home, lock root and enrolled receipt folders. Socket-only and proxy-off variants were measured and do not work (tap-21bdj).
 */
export const CODEX_AUTO_PROFILE = "tap_launcher_auto";
const PROFILE_NAME = /^tap_launcher_auto_[0-9a-f]{12}$/;
/**
 * Config merges recursively, key by key, and no `-c` value clears what a lower layer set (measured: `domains={}`
 * leaves an allowed domain in place). So every launch names its profile with fresh random bytes: user or project
 * config cannot already define the table these flags then fill. A name derived from stable paths would be
 * predictable, and a table under the predicted name would survive the merge (tap-21bdj).
 */
export function codexAutoProfileName(): string {
  return `${CODEX_AUTO_PROFILE}_${randomBytes(6).toString("hex")}`;
}
export function codexAutoProfileArgv(env: NodeJS.ProcessEnv, name: string = codexAutoProfileName()): string[] {
  const socket = physicalSocketPath(env);
  const indexHome = env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap");
  // Index home holds what a send/read/reply writes (locks/, runtime-cache/, send-refusals.log); a pinned lock dir may live elsewhere.
  const locks = lockRoot(env);
  const writable = locks === indexHome || locks.startsWith(`${indexHome}/`) ? [indexHome] : [indexHome, locks];
  // Cross-team reads and replies write receipts on the sender's bus.
  const index = loadGlobalRegistry(indexHome);
  if (index.marker === "live" && index.doc) {
    for (const team of Object.keys(index.doc.teams ?? {})) {
      const resolved = resolveTeamFromDoc(index.doc, team);
      if (resolved.status !== "ok") continue;
      const bus = busHomeForRegistry(resolved.registryLocation);
      if (!bus) continue;
      const receipts = join(bus, "receipts"), kind = lstatSync(receipts, { throwIfNoEntry: false });
      if (!kind?.isDirectory()) throw new LauncherError(`harness_permissions_conflict: ${receipts} receipts must be a real directory, not missing, a symlink or a file`, "harness_permissions_conflict");
      if (!writable.includes(receipts)) writable.push(receipts);
    }
  }
  const p = `permissions.${name}`;
  return [
    "-c", `default_permissions=${JSON.stringify(name)}`,
    "-c", `${p}.extends=":workspace"`,
    "-c", `${p}.network.enabled=true`,
    // The proxy feature table is shared by every profile, so a name cannot isolate it: deny every domain here
    // (a deny outranks an inherited allow) and pin its all-sockets escape hatch off.
    "-c", 'features.network_proxy={enabled=true,domains={"**"="deny"},dangerously_allow_all_unix_sockets=false}',
    // The random name is the defence against inherited profile keys; the escape hatch is also pinned off directly.
    "-c", `${p}.network.dangerously_allow_all_unix_sockets=false`,
    "-c", `${p}.network.unix_sockets={${JSON.stringify(socket)}="allow"}`,
    "-c", `${p}.filesystem={${writable.map(path => `${JSON.stringify(path)}="write"`).join(",")}}`,
  ];
}

/**
 * `-c` can add to the proxy's socket map but cannot remove what a Codex config layer already allowed there
 * (measured on 0.160.0: a deny works only for a path named exactly), so an ambient entry would widen auto past
 * the disclosure. The launcher reads, read-only, the user layer and every project layer Codex would load for the
 * directory the seat starts in (that directory and its ancestors up to the repository root), and refuses the auto
 * launch naming the file and key. A user `--profile` is refused with auto instead (see enforcePermissions), so no
 * profile layer is scanned. Domain allows need no refusal: the argv denies every domain. An unreadable or unparsable file is Codex's own
 * error to report.
 */
type ProxyTable = { unix_sockets?: unknown; dangerously_allow_all_unix_sockets?: unknown };
function ambientSocketKey(file: string): string | null {
  let table: ProxyTable | undefined;
  try { table = (Bun.TOML.parse(readFileSync(file, "utf8")) as { features?: { network_proxy?: ProxyTable } }).features?.network_proxy; } catch { return null; }
  if (table?.dangerously_allow_all_unix_sockets === true) return "features.network_proxy.dangerously_allow_all_unix_sockets";
  const sockets = table?.unix_sockets;
  return sockets && typeof sockets === "object" && Object.keys(sockets).length ? "features.network_proxy.unix_sockets" : null;
}
/** The workdir and its ancestors up to (and including) the first directory holding `.git`; only the workdir when none does. */
function projectLayerDirs(workdir: string): string[] {
  const chain: string[] = [];
  for (let dir = resolve(workdir); ; dir = dirname(dir)) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) return chain;
    if (dirname(dir) === dir) return [chain[0]!];
  }
}
export function refuseAmbientCodexSockets(env: NodeJS.ProcessEnv, workdir?: string | null): void {
  const files = [join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml"),
    ...(workdir ? projectLayerDirs(workdir).map(dir => join(dir, ".codex", "config.toml")) : [])];
  for (const file of files) {
    const key = ambientSocketKey(file);
    if (key) throw new LauncherError(`harness_permissions_conflict: ${file} sets ${key}, which would let a Codex auto seat reach sockets beyond TAP's own; remove it, or set [harness.codex] permissions = "bypass"`, "harness_permissions_conflict");
  }
}

export function permissionArgv(harness: string, mode: PermissionMode, env: NodeJS.ProcessEnv = process.env): string[] {
  const argv = PERMISSION_ARGV[harness];
  if (!argv) throw new LauncherError(`harness_permissions_unsupported: TAP does not own permissions for ${harness}`, "harness_permissions_unsupported");
  return [...argv[mode], ...(harness === "codex" && mode === "auto" ? codexAutoProfileArgv(env) : [])];
}

/** Cursor bundles short booleans (-pf); a value-taking short option ends the bundle and keeps the rest as its value. */
function cursorShortCluster(token: string): string {
  if (!/^-[A-Za-z]./.test(token)) return "";
  let flags = "";
  for (const letter of token.slice(1)) {
    if (!/[A-Za-z]/.test(letter)) break;
    flags += letter;
    if ("Hew".includes(letter)) break;
  }
  return flags;
}

/** The dotted TOML key before the first `=` of a `-c` assignment, quotes and spacing removed; `[]` when it does not parse. */
function configKeyPath(assignment: string): string[] {
  const path: string[] = [];
  let at = 0;
  for (;;) {
    while (/\s/.test(assignment[at] ?? "")) at++;
    const quote = assignment[at];
    let segment: string;
    if (quote === '"' || quote === "'") {
      const end = assignment.indexOf(quote, at + 1);
      if (end < 0) return [];
      segment = assignment.slice(at + 1, end);
      at = end + 1;
    } else {
      const start = at;
      while (at < assignment.length && !/[.=\s]/.test(assignment[at]!)) at++;
      segment = assignment.slice(start, at);
    }
    if (!segment) return [];
    path.push(segment);
    while (/\s/.test(assignment[at] ?? "")) at++;
    if (assignment[at] === ".") { at++; continue; }
    return assignment[at] === "=" ? path : [];
  }
}

/** Codex settings that auto mode owns; an assignment to one, to a parent table or to a child is a conflict. */
const CODEX_OWNED_KEYS = [["sandbox_mode"], ["approval_policy"], ["default_permissions"], ["permissions"], ["features", "network_proxy"]];
function overlapsOwnedKey(path: string[]): boolean {
  return path.length > 0 && CODEX_OWNED_KEYS.some(owned => owned.every((part, i) => i >= path.length || path[i] === part));
}

/** Check each source before composition can hide an option behind a builder default. */
export function enforcePermissions(harness: string, mode: PermissionMode, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (mode !== "auto" || !PERMISSION_HARNESSES.includes(harness)) return;
  // TAP's own Codex profile is the one `-c` set allowed through; any other value for those keys conflicts.
  // The owned set is the one regenerated for the profile name this argv selects.
  const selected = harness === "codex" ? args.map(arg => /^default_permissions="(tap_launcher_auto_[0-9a-f]{12})"$/.exec(arg.trim())?.[1]).find(Boolean) : undefined;
  const owned = new Set(selected && PROFILE_NAME.test(selected) ? codexAutoProfileArgv(env, selected).filter((_, i) => i % 2 === 1) : []);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    const at = token.indexOf("=");
    const attached = harness === "codex" && /^-[csap].+/.test(token);
    const raw = attached ? token.slice(0, 2) : at < 0 ? token : token.slice(0, at);
    // AGY parses flags Go-style, where -name and --name are the same long option.
    const key = harness === "agy" && /^-[^-]{2,}/.test(raw) ? `-${raw}` : raw;
    const value = attached ? token.slice(2).replace(/^=/, "") : at < 0 ? args[i + 1] : token.slice(at + 1);
    if (["--config", "-c"].includes(key) && value !== undefined && owned.has(value.trim())) continue;
    const bypass = key === "--dangerously-skip-permissions" || key === "--dangerously-bypass-approvals-and-sandbox" || key === "--yolo";
    const conflict = harness === "claude"
      ? key === "--permission-mode" && value !== "auto"
      : harness === "codex"
        ? (["--sandbox", "-s"].includes(key) && value !== "workspace-write") ||
          ["--ask-for-approval", "-a"].includes(key) ||
          (["--config", "-c"].includes(key) && overlapsOwnedKey(configKeyPath(value ?? ""))) ||
          (["--enable", "--disable"].includes(key) && (value ?? "").trim() === "network_proxy")
        : harness === "cursor"
          ? ["--force", "-f"].includes(key) || (key === "--sandbox" && value !== "enabled") || cursorShortCluster(token).includes("f")
          : false;
    if (harness === "codex" && ["--profile", "-p"].includes(key)) {
      throw new LauncherError(`harness_permissions_conflict: ${key} contradicts [harness.codex] permissions = "auto": AUTO uses TAP's own Codex profile; drop ${key} or use bypass`, "harness_permissions_conflict");
    }
    if (bypass || conflict) throw new LauncherError(`harness_permissions_conflict: ${key} contradicts [harness.${harness}] permissions = "auto"`, "harness_permissions_conflict");
  }
}
