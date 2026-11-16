import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type InitChange = { path: string; action: "created" | "modified" };

function snapshot(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) return "directory";
  // Never follow a link or block on a non-file just to render a receipt.
  if (!stat.isFile()) return `special:${stat.mode}:${stat.ino}`;
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return `unreadable:${stat.size}:${stat.mtimeMs}`; }
}

/** Only resolved init targets are observed; this never enumerates HOME or a repository. */
export class InitEffects {
  private targets = new Map<string, { before: string | null; modifies: boolean }>();

  add(path: string, modifies = false): void {
    path = resolve(path);
    const previous = this.targets.get(path);
    if (previous) { previous.modifies ||= modifies; return; }
    const before = snapshot(path);
    this.targets.set(path, { before, modifies });
    if (before === null && dirname(path) !== path) this.add(dirname(path));
  }

  changes(dryRun: boolean): InitChange[] {
    const changes: InitChange[] = [];
    for (const [path, { before, modifies }] of this.targets) {
      const after = dryRun ? before : snapshot(path);
      if (dryRun ? before === null || modifies : after !== null && after !== before) {
        changes.push({ path, action: before === null ? "created" : "modified" });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
}
