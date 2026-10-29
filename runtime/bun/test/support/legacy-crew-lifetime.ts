// Frozen v1 supervisor contract for transition tests. Production never starts one.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { captureCrewProcess, captureParentHarnessLifetime, processGeneration, type CrewLifetimeBinding, type FamilyContext } from "../../src/crew-lifetime";
import { procStartEpoch } from "../../src/reset";
import { tmux, tmuxReadOnly } from "../../src/tmux";
import type { ResolvedContext } from "../../src/context";

export async function legacyCrewHelper(ctx: FamilyContext, owner: string, crew: string): Promise<CrewLifetimeBinding> {
  const rows = JSON.parse(readFileSync(ctx.registryPath, "utf8")).seats;
  const parent = captureParentHarnessLifetime(ctx as ResolvedContext, owner);
  const child = captureCrewProcess(ctx.team, crew, rows[crew]);
  if (!child) throw new Error("fixture crew is stopped");
  const binding: CrewLifetimeBinding = { version: 1, token: randomUUID(), team: ctx.team, owner,
    ownerInstance: parent.instance, ownerPane: parent.pane, ownerSession: parent.session,
    crew, crewInstance: child.crewInstance, crewPane: child.crewPane, crewSession: child.crewSession,
    serverSocket: child.serverSocket, serverEpoch: child.serverEpoch, parent: parent.process,
    parentFamily: parent.family, child: child.child, childFamily: child.childFamily,
    helper: { pid: "", start: "", boot: child.child.boot } };
  const childProcess = Bun.spawn([process.execPath, import.meta.path, "--helper", JSON.stringify(binding)], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  const reader = childProcess.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const item = await reader.read();
    if (item.done) throw new Error("legacy fixture exited before acknowledgement");
    text += new TextDecoder().decode(item.value);
  }
  await reader.cancel();
  childProcess.unref();
  return JSON.parse(text.split("\n")[0]!);
}

if (import.meta.main && process.argv[2] === "--helper") {
  const binding = JSON.parse(process.argv[3]!) as CrewLifetimeBinding;
  binding.helper = { pid: String(process.pid), start: procStartEpoch(String(process.pid)), boot: binding.child.boot };
  const option = "@tap_crew_lifetime_token";
  if (!binding.helper.start || tmux(["set-option", "-p", "-t", binding.crewPane, "@tap_crew_lifetime", JSON.stringify(binding)]).code !== 0
    || tmux(["set-option", "-p", "-t", binding.crewPane, option, binding.token]).code !== 0) process.exit(1);
  process.stdout.write(JSON.stringify(binding) + "\n");
  for (;;) {
    await Bun.sleep(100);
    if (processGeneration(binding.child) === "gone") break;
    const token = tmuxReadOnly(["show-option", "-p", "-v", "-t", binding.crewPane, option]);
    if (token.code !== 0 || token.stdout.trim() !== binding.token) break;
    if (processGeneration(binding.parent) !== "gone") continue;
    const condition = `#{&&:#{==:#{pane_id},${binding.crewPane}},#{&&:#{==:#{pane_pid},${binding.child.pid}},#{&&:#{==:#{pid}:#{start_time},${binding.serverEpoch.slice(4)}},#{==:#{${option}},${binding.token}}}}}`;
    tmux(["if-shell", "-F", "-t", binding.crewPane, condition, `kill-pane -t '${binding.crewPane}'`, "display-message -p 'changed'"]);
    break;
  }
}
