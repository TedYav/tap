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
export function permissionArgv(harness: string, mode: PermissionMode): string[] {
  const argv = PERMISSION_ARGV[harness];
  if (!argv) throw new LauncherError(`harness_permissions_unsupported: TAP does not own permissions for ${harness}`, "harness_permissions_unsupported");
  return [...argv[mode]];
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

/** Check each source before composition can hide an option behind a builder default. */
export function enforcePermissions(harness: string, mode: PermissionMode, args: string[]): void {
  if (mode !== "auto" || !PERMISSION_HARNESSES.includes(harness)) return;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    const at = token.indexOf("=");
    const attached = harness === "codex" && /^-[csa].+/.test(token);
    const raw = attached ? token.slice(0, 2) : at < 0 ? token : token.slice(0, at);
    // AGY parses flags Go-style, where -name and --name are the same long option.
    const key = harness === "agy" && /^-[^-]{2,}/.test(raw) ? `-${raw}` : raw;
    const value = attached ? token.slice(2).replace(/^=/, "") : at < 0 ? args[i + 1] : token.slice(at + 1);
    const bypass = key === "--dangerously-skip-permissions" || key === "--dangerously-bypass-approvals-and-sandbox" || key === "--yolo";
    const conflict = harness === "claude"
      ? key === "--permission-mode" && value !== "auto"
      : harness === "codex"
        ? (["--sandbox", "-s"].includes(key) && value !== "workspace-write") ||
          ["--ask-for-approval", "-a"].includes(key) ||
          (["--config", "-c"].includes(key) && /^(?:["\']?(?:sandbox_mode|approval_policy)["\']?)\s*=/.test((value ?? "").trim()))
        : harness === "cursor"
          ? ["--force", "-f"].includes(key) || (key === "--sandbox" && value !== "enabled") || cursorShortCluster(token).includes("f")
          : false;
    if (bypass || conflict) throw new LauncherError(`harness_permissions_conflict: ${key} contradicts [harness.${harness}] permissions = "auto"`, "harness_permissions_conflict");
  }
}
