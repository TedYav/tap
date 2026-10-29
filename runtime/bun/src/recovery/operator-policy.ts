export interface OperatorPolicy {
  mode: "off" | "ask" | "on";
  afterMs: number;
  source: "default" | "config";
  digest: string;
}
export function operatorPolicy(env = process.env): OperatorPolicy {
  let recovery: unknown, digest = "absent";
  try {
    const source = readCatalog(join(configDirectory(env), "config.toml"));
    recovery = source.data.recovery; digest = source.digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recovery !== undefined && !table(recovery)) throw new Error("recovery must be a TOML table");
  const section = (recovery ?? {}) as Record<string, unknown>;
  const mode = section.operator ?? "off";
  if (!["off", "ask", "on"].includes(mode as string)) throw new Error("recovery.operator must be off, ask, or on");
  const raw = section.operator_after ?? "20m";
  if (typeof raw !== "string" || !/^\d+[smh]$/.test(raw)) {
    throw new Error("recovery.operator_after needs a positive duration such as 20m (s, m or h; at most 24h)");
  }
  const seconds = BigInt(raw.slice(0, -1)) * ({ s: 1n, m: 60n, h: 3600n }[raw.at(-1)!] ?? 0n);
  if (seconds < 1n || seconds > 86400n) throw new Error("recovery.operator_after must be positive and at most 24h");
  return { mode: mode as OperatorPolicy["mode"], afterMs: Number(seconds) * 1000,
    source: section.operator === undefined ? "default" : "config", digest };
}
import { join } from "node:path";
import { configDirectory, readCatalog, table } from "../config-file";

