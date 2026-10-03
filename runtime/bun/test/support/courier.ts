import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plants a stand-in courier at `<dir>/courier` and routes this process's
 * courierArgv to it (TAP_COURIER_SCRIPT). bash runs it with the send arguments,
 * without the verb. Pair with `afterEach(clearCourier)`.
 */
export function standInCourier(dir: string, body: string): string {
  const path = join(dir, "courier");
  writeFileSync(path, body, { mode: 0o755 });
  process.env.TAP_COURIER_SCRIPT = path;
  return path;
}

export function clearCourier(): void { delete process.env.TAP_COURIER_SCRIPT; }
