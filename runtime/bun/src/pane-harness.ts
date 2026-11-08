import { agentFamilies, classifyHarness, harnessFamily, observeProcessHarness, readProcessTable, type PsTable } from "./observe";

/** A denylisted or agent name decides before any argv scan; `read` lets a caller reuse a table it already took. */
export function paneHarness(facts: { command: string; pane_pid: number }, env: NodeJS.ProcessEnv = process.env,
  read: (env: NodeJS.ProcessEnv) => { table: PsTable | null; ok: boolean } = readProcessTable): string {
  const families = agentFamilies(env), family = harnessFamily(facts.command, families);
  if (classifyHarness(family, families) !== "unsupported") return family;
  const ps = read(env);
  const observed = observeProcessHarness(String(facts.pane_pid), ps.table, ps.ok, families);
  return observed.state === "observed" && observed.family ? observed.family : family;
}
