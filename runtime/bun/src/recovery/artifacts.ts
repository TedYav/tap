import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWrite } from "../fsatomic";
import { readRun, recoveryRoot, runDirectory } from "./state";
import { copyRedactedFile, safeFields } from "../debug-capture";

export interface RecoveryArtifact {
  id: string; directory: string; payloads: Array<{ id: string; home: string }>;
  files: string[]; summary: string; error?: string;
}
/** Recovery artifacts are always recorded, even when the optional flight journal is off. */
export function recoveryArtifacts(query?: string, env = process.env): RecoveryArtifact[] {
  const root = recoveryRoot(env);
  if (!existsSync(root)) return [];
  const items: RecoveryArtifact[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^recovery-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const directory = runDirectory(entry.name, env);
    const files = readdirSync(directory, { withFileTypes: true }).filter(f => f.isFile()).map(f => join(directory, f.name));
    try {
      const run = readRun(entry.name, env);
      if (query && query !== run.id && !run.payloads.some(p => p.id === query || `${p.home}/payloads/${p.id}.md` === query)) continue;
      items.push({ id: run.id, directory, payloads: run.payloads, files, summary: run.summary || run.state });
    } catch (error) {
      // An unreadable run is evidence of a gap, not an empty successful recovery.
      if (!query || query === entry.name || !query.startsWith("recovery-")) items.push({ id: entry.name, directory, payloads: [], files,
        summary: "recovery metadata unreadable", error: String(error) });
    }
  }
  return items;
}
/** Thin bridge for the existing debug collector; all recovery discovery/copy rules live here. */
export function collectRecoveryArtifacts(directory: string, env = process.env): number {
  if (!existsSync(recoveryRoot(env))) return 0;
  const session = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
  const since = statSync(join(directory, "session.json")).mtimeMs;
  const indexPath = join(directory, "recovery-artifacts.json");
  let index: Record<string, string> = {};
  try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch { /* new collector index */ }
  let copied = 0;
  for (const item of recoveryArtifacts(undefined, env)) {
    const states = item.files.map(path => ({ path, stat: statSync(path) }));
    if (!states.some(f => f.stat.mtimeMs >= since)) continue;
    const signature = states.map(f => `${basename(f.path)}:${f.stat.size}:${f.stat.mtimeMs}`).sort().join("|");
    if (index[item.id] === signature) continue;
    const destination = join(directory, "artifacts", item.id);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const file of states) copyRedactedFile(file.path, join(destination, basename(file.path)), env);
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify(safeFields({ schema: 1, timestamp: new Date().toISOString(),
      capture_id: session.id, event: "tap.recovery", recovery_id: item.id, payloads: item.payloads,
      artifact: destination, summary: item.summary, error: item.error }, env)) + "\n", { mode: 0o600 });
    index[item.id] = signature;
    copied++;
  }
  if (copied) atomicWrite(indexPath, JSON.stringify(index));
  return copied;
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "_collect" && args.length === 2) {
      collectRecoveryArtifacts(args[1]!);
    } else {
      const json = args.includes("--json");
      const values = args.filter(a => a !== "--json");
      if (values.length > 1 || values[0]?.startsWith("--")) throw new Error("usage: tap debug recovery [recovery-id|payload-id] [--json]");
      const items = recoveryArtifacts(values[0]);
      if (json) console.log(JSON.stringify(items, null, 2));
      else if (!items.length) console.log("tap debug recovery: no matching recorded recovery");
      else for (const item of items) {
        console.log(`${item.id}: ${item.summary}\n  ${item.directory}`);
        for (const payload of item.payloads) console.log(`  payload: ${payload.home}/payloads/${payload.id}.md`);
        for (const file of item.files.filter(f => /events\.jsonl$|intent\.json$|proof\.json$|result\.json$/.test(f))) console.log(`  artifact: ${file}`);
        if (item.error) console.log(`  ERROR: ${item.error}`);
      }
    }
  } catch (error) { console.error(`tap debug recovery: ${error}`); process.exitCode = 1; }
}
