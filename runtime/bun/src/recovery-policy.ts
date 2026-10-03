import { join } from "node:path";
import { configDirectory, readCatalog, table } from "./config-file";

export const RECOVERY_MODES = ["report-only", "cautious", "aggressive"] as const;
export type RecoveryMode = typeof RECOVERY_MODES[number];
export type RecoveryPolicy = { mode: RecoveryMode; source: "override" | "config" | "default" };

function mode(value: unknown): RecoveryMode {
  if (!RECOVERY_MODES.includes(value as RecoveryMode)) {
    throw new Error("recovery.aggressiveness must be report-only, cautious, or aggressive");
  }
  return value as RecoveryMode;
}

/** Each verb supplies and reports its default; configuration grants no automatic dispatch. */
export function recoveryPolicy(
  fallback: RecoveryMode,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): RecoveryPolicy {
  if (override !== undefined) return { mode: mode(override), source: "override" };
  const path = join(configDirectory(env), "config.toml");
  let recovery: unknown;
  try {
    recovery = readCatalog(path).data.recovery;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: fallback, source: "default" };
    throw error;
  }
  if (recovery === undefined) return { mode: fallback, source: "default" };
  if (!table(recovery)) throw new Error("recovery must be a TOML table");
  if (recovery.aggressiveness === undefined) return { mode: fallback, source: "default" };
  return { mode: mode(recovery.aggressiveness), source: "config" };
}

if (import.meta.main) {
  try {
    const [fallback, override] = process.argv.slice(2);
    const policy = recoveryPolicy(mode(fallback), override);
    process.stdout.write(`${policy.mode}\t${policy.source}\n`);
  } catch (error) {
    process.stderr.write(`tap recovery: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
