import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { shlexQuote } from "../src/launcher/invocation";
import { removeScratchTree } from "./support/scratch";

const REPO = resolve(import.meta.dir, "../../..");
const TMUX_BIN = Bun.which("tmux")!;
const q = shlexQuote;
// A plain `echo $? > flag` creates the file before it writes, so a poller can see
// it empty. Write beside it and rename: the flag appears whole or not at all.
const flagWrite = (path: string) => "echo $? > " + q(path + ".tmp") + " && mv " + q(path + ".tmp") + " " + q(path);
async function appeared(path: string): Promise<void> {
  const until = Date.now() + 25000;
  while (!existsSync(path) && Date.now() < until) await Bun.sleep(25);
  expect(existsSync(path), "missing completion flag " + path).toBe(true);
}

test("SessionStart crossing refuses a second team, then the surviving instance settles its pending note", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-enrollment-hook-")));
  const target = join(root, "target"), owner = join(root, "owner"), index = join(root, "index");
  const targetRegistry = join(target, ".tap/team-registry.json"), ownerRegistry = join(owner, ".tap/team-registry.json");
  const targetBus = join(target, ".tap/bus"), ownerBus = join(owner, ".tap/bus");
  const socket = join(process.env.TMUX_TMPDIR!, "enroll-" + process.pid + ".sock");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), TAP_INDEX_HOME: index,
    TAP_HOME: targetBus, TAP_TMUX_SOCKET_PATH: socket, TAP_SKIP_VERSION_BRIEFING: "1", TAP_SETUP_OPEN_GUIDE: "0" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET", "TAP_SELF", "TAP_SERVER_EPOCH", "TAP_BOOT_ID"]) delete env[key];
  const tmux = (args: string[]) => {
    const r = spawnSync(TMUX_BIN, ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  try {
    for (const dir of [index, env.HOME!, targetBus, join(ownerBus, "payloads"), join(ownerBus, "receipts")]) mkdirSync(dir, { recursive: true });
    for (const dir of [target, owner]) expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
    writeFileSync(targetRegistry, JSON.stringify({ schema: "0.20", team: { name: "target", worktree_root: target }, seats: {} }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      target: { root: target, registry_location: targetRegistry, state: "registered" },
      owner: { root: owner, registry_location: ownerRegistry, state: "registered" },
    } }));
    const script = join(root, "hook.sh");
    const hookDone = join(root, "hook.done"), readDone = join(root, "read.done");
    writeFileSync(script, [
      "#!/bin/bash",
      "for ((i=0;i<600;i++)); do [ -e " + q(join(root, "start")) + " ] && break; sleep 0.05; done",
      "printf '%s\\n' " + q(JSON.stringify({ source: "clear" })) + " | " + q(process.execPath) + " " + q(join(REPO, "runtime/bun/src/session-start.ts")) + " context " + q(target) + " >" + q(join(root, "hook.out")) + " 2>" + q(join(root, "hook.err")),
      flagWrite(hookDone),
      "for ((i=0;i<600;i++)); do [ -e " + q(join(root, "read.start")) + " ] && break; sleep 0.05; done",
      "cd " + q(owner),
      "TAP_HOME=" + q(ownerBus) + " " + q(join(REPO, "bin/tap")) + " read pending-note >" + q(join(root, "read.out")) + " 2>" + q(join(root, "read.err")),
      flagWrite(readDone),
      "sleep 60",
    ].join("\n") + "\n");
    const pane = tmux(["new-session", "-d", "-s", "owner/incumbent", "-c", target, "-P", "-F", "#{pane_id}", "/bin/bash " + q(script)]);
    const [rawEpoch, observedSocket] = tmux(["display-message", "-p", "-t", pane, "#{pid}:#{start_time}\t#{socket_path}"]).split("\t");
    const row = { status: "active", delivery: "pane", pane: "owner/incumbent:0.0", pane_id: pane,
      server_epoch: "srv:" + rawEpoch, server_socket: observedSocket, session: "owner/incumbent",
      harness: "bash", instance: "incumbent|kept" };
    writeFileSync(ownerRegistry, JSON.stringify({ schema: "0.20", team: { name: "owner", worktree_root: owner }, seats: { incumbent: row } }));
    const payload = join(ownerBus, "payloads/pending-note.md");
    writeFileSync(payload, ["---", "id: pending-note", "from: requester", "from_team: target", "to: incumbent", "to_team: owner",
      "kind: discuss", "reply: settle-only", "recipient_instance: incumbent|kept", "path: " + payload, "---", "retain custody", ""].join("\n"));
    const before = [readFileSync(targetRegistry, "utf8"), readFileSync(ownerRegistry, "utf8"), readFileSync(payload, "utf8")];
    writeFileSync(join(root, "start"), "");
    await appeared(hookDone);
    expect(readFileSync(hookDone, "utf8").trim()).toBe("0"); // Refusal never bricks SessionStart.
    const output = readFileSync(join(root, "hook.out"), "utf8") + readFileSync(join(root, "hook.err"), "utf8");
    expect(output).toContain("pane_enrolled_elsewhere");
    expect(output).toContain("tap out owner/incumbent");
    expect(output).not.toContain("until you run: tap in");
    expect([readFileSync(targetRegistry, "utf8"), readFileSync(ownerRegistry, "utf8"), readFileSync(payload, "utf8")]).toEqual(before);
    expect(Object.keys(JSON.parse(readFileSync(targetRegistry, "utf8")).seats)).toHaveLength(0);
    expect(Object.keys(JSON.parse(readFileSync(ownerRegistry, "utf8")).seats)).toHaveLength(1);
    writeFileSync(join(root, "read.start"), "");
    await appeared(readDone);
    expect({ code: readFileSync(readDone, "utf8").trim(), err: readFileSync(join(root, "read.err"), "utf8") }).toMatchObject({ code: "0" });
    expect(existsSync(join(ownerBus, "receipts/pending-note.done"))).toBe(true);
    expect(JSON.parse(readFileSync(ownerRegistry, "utf8")).seats.incumbent.instance).toBe("incumbent|kept");
    expect(readFileSync(targetRegistry, "utf8")).toBe(before[0]!);
  } finally {
    spawnSync(TMUX_BIN, ["-S", socket, "kill-server"], { env, stdio: "ignore" });
    removeScratchTree(root);
  }
}, 60000);
