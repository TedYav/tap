import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { operationDiagnostics, setOperationDiagnostics, startupDiagnostic, startupTrace } from "./startup-trace";

function configured(env: NodeJS.ProcessEnv): boolean {
  try {
    const config = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "tap/config.toml");
    const doc = Bun.TOML.parse(readFileSync(config, "utf8")) as { diagnostics?: { level?: unknown } };
    return doc.diagnostics?.level === "verbose";
  } catch { return false; }
}

function write(event: string, fields: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const safe = event === "pane_failure" || event === "pane_output"
    ? Object.fromEntries(Object.entries(fields).filter(([key]) => ["target", "status", "command"].includes(key))) : fields;
  startupDiagnostic(event, safe, env);
}

/** Explicit lifecycle call sites only: no console output, no tmux tracing. */
export function lifecycleDiagnostic(event: string, fields: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (configured(env)) write(event, fields, env);
  } catch { /* Developer diagnostics must not change the operation result. */ }
}

/**
 * Resolve the machine's diagnostics level once for the current operation.
 * `announce` writes `diagnostics_start`; an operation joined from the Python
 * door was already announced there.
 */
export function joinLifecycleDiagnostics(env: NodeJS.ProcessEnv = process.env, announce = false): void {
  try {
    if (setOperationDiagnostics(configured(env)) && announce) write("diagnostics_start", { console: false, tmux_trace: false }, env);
  } catch { /* Developer diagnostics must not change the operation result. */ }
}

/** Open a traced lifecycle operation: its launch_start, then its diagnostics. */
export function beginLifecycleOperation(fields: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  startupTrace("launch_start", fields, true);
  joinLifecycleDiagnostics(env, true);
}

/** Command capture inside a diagnosed operation; nothing anywhere else. */
export function operationDiagnostic(event: string, fields: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (operationDiagnostics()) write(event, fields, env);
  } catch { /* Developer diagnostics must not change the operation result. */ }
}
