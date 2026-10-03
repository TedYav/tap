import { agentFamilies, classifyHarness, harnessFamily, observeProcessHarness, readProcessTable } from "./observe";

export function paneHarness(facts: { command: string; pane_pid: number }, env: NodeJS.ProcessEnv = process.env): string {
  const families = agentFamilies(env), family = harnessFamily(facts.command, families);
  if (classifyHarness(family, families) !== "unsupported") return family;
  const ps = readProcessTable(env);
  const observed = observeProcessHarness(String(facts.pane_pid), ps.table, ps.ok, families);
  return observed.state === "observed" && observed.family ? observed.family : family;
}
