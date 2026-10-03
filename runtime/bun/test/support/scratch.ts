import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export function removeScratchTree(path: string): void {
  if (!existsSync(path)) return;
  const open = spawnSync(Bun.which("lsof") ?? "/usr/sbin/lsof", ["+D", path], { encoding: "utf8" });
  if (open.status !== 1 || open.stdout.trim() !== "") {
    throw new Error(`refusing to remove scratch without an unowned lsof result:\n${open.stdout}${open.stderr}`);
  }
  rmSync(path, { recursive: true, force: true });
}
