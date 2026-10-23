import { existsSync } from "node:fs";
import { sameOpenCodeService, type OpenCodeService } from "../opencode-shared";
import { openCodeAPI, openCodeServicePath, readOpenCodeService } from "../opencode-service";
import { INHERITED_IDENTITY_ENV } from "../session-store";
import { LauncherError } from "./types";
import { launchCommand } from "./process";
export interface SharedLaunchIO {
  exists(env: NodeJS.ProcessEnv): boolean;
  read(env: NodeJS.ProcessEnv): OpenCodeService | null;
  start(env: NodeJS.ProcessEnv, directory: string, signal?: AbortSignal): Promise<void>;
  api(service: OpenCodeService, path: string): any;
}
export async function admitSharedOpenCode(directory: string, env: NodeJS.ProcessEnv, signal?: AbortSignal,
  io: SharedLaunchIO = nativeIO): Promise<OpenCodeService> {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of [...INHERITED_IDENTITY_ENV, "CLAUDE_JOB_DIR", "TMUX", "TMUX_PANE", "TAP_HOME", "TAP_REGISTRY", "TAP_TMUX_SOCKET", "TAP_TMUX_SOCKET_PATH", "TAP_STATELESS"])
    delete clean[key];
  try {
    if (!io.exists(clean)) await io.start(clean, directory, signal);
    signal?.throwIfAborted();
    const observed = io.read(clean);
    if (!observed) throw new Error("native service registration or process is not verifiable");
    const service = { ...observed };
    const query = new URLSearchParams({ "location[directory]": directory });
    // OpenCode 2 activates a cold location asynchronously. The model catalog
    // awaits that activation; plugin.list itself can otherwise return [].
    await io.api(service, `/api/model?${query}`);
    const plugins = await io.api(service, `/api/plugin?${query}`);
    if (plugins?.location?.directory !== directory || !Array.isArray(plugins.data) ||
      !["tap.tmux-guard", "tap.session-start"].every(id => plugins.data.some((p: any) => p?.id === id && p.state?.status === "active" && p.features?.server === true))) {
      throw new LauncherError("the shared service has not loaded TAP's session and tmux-guard plugins", "opencode_shared_plugins_missing",
        "install TAP's OpenCode plugins, then restart the OpenCode service at a safe interruption point and relaunch the seat");
    }
    const current = io.read(clean);
    if (!current || !sameOpenCodeService(service, current)) throw new Error("native service changed during plugin inspection");
    return service;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LauncherError) throw error;
    const detail = `OpenCode shared service admission failed: ${error instanceof Error ? error.message : String(error)}`;
    throw new LauncherError(detail, "opencode_shared_unavailable", "inspect the OpenCode service, then retry; TAP never restarts an existing service", detail);
  }
}

const nativeIO: SharedLaunchIO = {
  exists: env => existsSync(openCodeServicePath(env)), read: env => readOpenCodeService(env), api: openCodeAPI,
  start: async (env, directory, signal) => {
    const query = new URLSearchParams({ "location[directory]": directory });
    const result = await launchCommand(["opencode", "api", "GET", `/api/model?${query}`], { env, cwd: directory, signal, timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error("native service startup failed");
  },
};
