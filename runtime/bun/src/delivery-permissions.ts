import { injectionBehavior } from "./injection-behavior";
import { seatMap, loadCurrentRegistry } from "./registry";

/** Legacy/unbound callers keep bypass behavior; unreadable bound policy holds. */
export function recordedPermissions(registry?: string, handle?: string): "auto" | "bypass" | "unknown" {
  if (!registry || !handle) return "bypass";
  try {
    const row = seatMap(loadCurrentRegistry(registry))[handle.split("/").at(-1)!];
    if (!row) return "unknown";
    const mode = row.permissions;
    return mode === undefined || mode === "bypass" ? "bypass" : mode === "auto" ? "auto" : "unknown";
  } catch { return "unknown"; }
}
if (import.meta.main) {
  try {
    const permissions = recordedPermissions(process.argv[2], process.argv[3]);
    const preserve = process.argv[4];
    if (preserve === undefined) process.stdout.write(permissions);
    else {
      const mode = injectionBehavior();
      process.stdout.write(`${permissions}\x1f${preserve === "1" || mode === "wait" ? "1" : "0"}`);
    }
  } catch (error) { console.error(`tap injection: ${String(error)}`); process.exitCode = 1; }
}
