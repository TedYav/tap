import { spawnSync } from "node:child_process";
import { LauncherError } from "./types";

/** Version probing starts no server and runs before any seat replacement. */
export function requireOpenCode2(env: NodeJS.ProcessEnv = process.env, cwd?: string): void {
  const result = spawnSync("opencode", ["--version"], { env, cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
  const version = /^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(result.stdout?.trim() ?? "");
  if (result.status === 0 && version?.[1] === "2") return;
  const detail = "OpenCode 2.x is required; the installed CLI is older, unsupported, or its version could not be read";
  throw new LauncherError(detail, "opencode_version_unsupported", "install or upgrade to OpenCode 2.x, confirm `opencode --version`, then retry", detail);
}
