import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

export type WindowEnv = { state: "set"; value: string } | { state: "unset" | "unknown" };
type Run = (args: string[]) => string | null;
const runPs: Run = args => {
  const result = spawnSync("ps", args, {encoding:"utf8",timeout:1000,maxBuffer:1024*1024,stdio:["ignore","pipe","pipe"]});
  return result.status === 0 && result.stdout.trim() ? result.stdout : null;
};
export function parseWindowEnvironment(text: string | null): WindowEnv {
  if (text === null || !text.trim()) return {state:"unknown"};
  const values = [...text.matchAll(/(?:^|[\s\0])CLAUDE_CODE_AUTO_COMPACT_WINDOW=([^\s\0]*)/g)].map(m => m[1]!);
  if (!values.length) return /(?:^|[\s\0])(?:PATH|HOME|USER)=/.test(text) ? {state:"unset"} : {state:"unknown"};
  return new Set(values).size === 1 ? {state:"set",value:values[0]!} : {state:"unknown"};
}

/** A line must start with one requested PID, once. Continuations or duplicate
 * boundaries cannot attribute an environment, so the whole chunk stays unknown. */
function batchEnvironments(pids: string[], run: Run): Map<string, WindowEnv> {
  const result = new Map<string, WindowEnv>();
  // 64 environments of roughly 5–10 KiB fit runPs's 1 MiB bound. A larger
  // environment or failed read still fails to unknown, never partial output.
  for (let offset = 0; offset < pids.length; offset += 64) {
    const chunk = pids.slice(offset, offset + 64), requested = new Set(chunk);
    const text = run(["-E", "-ww", "-o", "pid=,command=", "-p", chunk.join(",")]);
    if (text === null) continue;
    const rows = new Map<string, WindowEnv>();
    let ambiguous = false;
    for (const line of text.replace(/\n$/, "").split("\n")) {
      const match = /^\s*(\d+)[ \t]+([^\r\n]+)$/.exec(line);
      if (!match || !requested.has(match[1]!) || rows.has(match[1]!)) { ambiguous = true; break; }
      rows.set(match[1]!, parseWindowEnvironment(match[2]!));
    }
    if (!ambiguous) for (const [pid, value] of rows) result.set(pid, value);
  }
  return result;
}

/** One process inventory, no command lines or unrelated environment values leave this reader. */
export function claudeWindows(panePids: string[], run: Run = runPs,
  environment?: (pid: string) => string | null, platform = process.platform): Map<string,WindowEnv> {
  const result = new Map<string,WindowEnv>();
  if (!panePids.length) return result;
  const table = run(["-axo","pid=,ppid=,comm="]);
  const rows = (table ?? "").split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return m ? [{pid:m[1]!,parent:m[2]!,command:basename(m[3]!)}] : [];
  });
  const candidatesByRoot = new Map<string, string[]>();
  for (const root of new Set(panePids)) {
    const tree = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (tree.has(row.parent) && !tree.has(row.pid)) {tree.add(row.pid);changed=true;}
    }
    const candidates = rows.filter(row => tree.has(row.pid) && /^(claude|node)$/.test(row.command));
    candidatesByRoot.set(root, candidates.map(row => row.pid));
  }
  const pids = [...new Set([...candidatesByRoot.values()].flat())];
  const readEnvironment = environment ?? (platform === "linux" ? (pid: string) => {
    try { return readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return null; }
  } : undefined);
  const windows = readEnvironment
    ? new Map(pids.map(pid => [pid, parseWindowEnvironment(readEnvironment(pid))]))
    : batchEnvironments(pids, run);
  for (const [root, candidates] of candidatesByRoot) {
    const values = candidates.map(pid => windows.get(pid) ?? {state:"unknown"} as WindowEnv);
    const first = values[0];
    result.set(root, first && values.every(v => JSON.stringify(v) === JSON.stringify(first)) ? first : {state:"unknown"});
  }
  return result;
}
