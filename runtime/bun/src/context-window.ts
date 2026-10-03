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

/** One process inventory, no command lines or unrelated environment values leave this reader. */
export function claudeWindows(panePids: string[], run: Run = runPs,
  environment: (pid: string) => string | null = pid => {
    if (process.platform === "linux") {
      try { return readFileSync(`/proc/${pid}/environ`,"utf8"); } catch { return null; }
    }
    return run(["-E","-ww","-o","command=","-p",pid]);
  }): Map<string,WindowEnv> {
  const result = new Map<string,WindowEnv>();
  if (!panePids.length) return result;
  const table = run(["-axo","pid=,ppid=,comm="]);
  const rows = (table ?? "").split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return m ? [{pid:m[1]!,parent:m[2]!,command:basename(m[3]!)}] : [];
  });
  for (const root of panePids) {
    const tree = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (tree.has(row.parent) && !tree.has(row.pid)) {tree.add(row.pid);changed=true;}
    }
    const candidates = rows.filter(row => tree.has(row.pid) && /^(claude|node)$/.test(row.command));
    const values = candidates.map(row => parseWindowEnvironment(environment(row.pid)));
    const first = values[0];
    result.set(root, first && values.every(v => JSON.stringify(v) === JSON.stringify(first)) ? first : {state:"unknown"});
  }
  return result;
}
