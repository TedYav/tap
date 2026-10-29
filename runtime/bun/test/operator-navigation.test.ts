import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Bus } from "../src/bus";
import type { ResolvedContext } from "../src/context";
import { appendRegistryEvent, registryEventsPath } from "../src/events";
import { createRun, live, recoveryHold, releaseRun, updateRun } from "../src/recovery/state";
import { operatorSurface } from "../src/recovery/operator-screen";
import { executeOperate, operateOptions, type OperateIO } from "../src/verbs/operate";

// Constructed TUI applications on a private tmux server. These prove key bytes,
// hold lifetime and action enforcement; they are not live harness recoveries.
const box = (title: string) => `╭────────────────────────────────────╮\n│ ${title}\n│ ❯ Close\n│ Esc to cancel\n╰────────────────────────────────────╯\n`;
const fixtures = [
  { harness: "claude", menu: box("Settings"), composer: "────────────────────────────────────\n❯ \n────────────────────────────────────\n ? for shortcuts\n" },
  { harness: "codex", menu: "  Keymap\n   All   Common   Customized (3)             ›\n  Type to search shortcuts\n› Action 00  Ctrl+0\n  left/right group · enter edit · esc close\n", composer: "› \n\n  gpt-6-astra high · Context 99% left\n" },
  { harness: "opencode", menu: box("Themes"), composer: readFileSync(resolve(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/opencode-wide-idle.ansi"), "utf8").replaceAll("\\u001b", "\x1b") },
];
async function world(specimen: typeof fixtures[number], check: (f: { io: OperateIO; observe(): Promise<any>; key(sample: string): Promise<any>;
  held(): boolean; release(): void; bytes(): string; frame(): string; audits(): string; recent(): void }) => Promise<void>) {
  const original = { ...process.env }, root = realpathSync(mkdtempSync("/tmp/tap-operator-navigation-"));
  const socket = `operator-${process.pid}-${Math.random().toString(16).slice(2, 8)}`, realTmux = Bun.which("tmux")!;
  const T = (...args: string[]) => spawnSync(realTmux, ["-L", socket, ...args], { encoding: "utf8", env: process.env });
  try {
    Object.assign(process.env, { TAP_TMUX_SOCKET: socket, TAP_INDEX_HOME: join(root, "index"), TAP_LOCK_DIR: join(root, "locks") });
    for (const key of ["TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID"]) delete process.env[key];
    mkdirSync(join(root, "bus"));
    const owner = T("new-session", "-d", "-s", "operator-fixture", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 120");
    expect(owner.status).toBe(0); const ownerPane = owner.stdout.trim();
    const script = join(root, "fixture.js"), bytes = join(root, "keys.hex");
    writeFileSync(script, `import {appendFileSync} from 'node:fs';\nprocess.stdin.setRawMode(true); process.stdin.resume();\nconst draw = s => process.stdout.write('\\x1b[2J\\x1b[H' + s.replaceAll('\\n','\\r\\n'));\ndraw(${JSON.stringify(specimen.menu)});\nprocess.stdin.on('data', b => { appendFileSync(${JSON.stringify(bytes)}, b.toString('hex')); if(b.length===1 && b[0]===27) draw(${JSON.stringify(specimen.composer)}); });\n`);
    const child = T("new-window", "-d", "-t", "=operator-fixture", "-P", "-F", "#{pane_id}", process.execPath, script);
    expect(child.status).toBe(0); const pane = child.stdout.trim();
    const frame = () => { const r = T("capture-pane", "-p", "-e", "-J", "-t", pane); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
    for (let i = 0; i < 100 && !frame().includes(specimen.harness === "codex" ? "Keymap" : specimen.harness === "opencode" ? "Themes" : "Settings"); i++) await Bun.sleep(10);
    const binding = { team: "fixture", handle: "target", registry: join(root, "registry"), pane, paneId: pane,
      session: "operator-fixture", instance: "target|fixture", harness: specimen.harness,
      processPid: T("display-message", "-p", "-t", pane, "#{pane_pid}").stdout.trim(), serverSocket: T("display-message", "-p", "#{socket_path}").stdout.trim(), serverEpoch: "fixture" };
    const caller = { handle: "owner", instance: "owner|fixture", paneId: ownerPane, team: "fixture" };
    const ctx = { team: "fixture", root, registryPath: binding.registry, bus: new Bus(join(root, "bus")) } as ResolvedContext;
    const policy = { mode: "on" as const, afterMs: 1_200_000, source: "config" as const, digest: "sha256:" + "a".repeat(64) };
    const record = { v: 1 as const, binding, caller, authority: "on" as const, policyDigest: policy.digest,
      admittedAt: Date.now(), nativeActivity: 1000, mail: { id: "mail", home: ctx.bus.home }, clients: [] };
    const run = createRun(binding, "cautious", [record.mail], ownerPane, process.pid, process.env, live(), true, record);
    updateRun(run.id, current => { current.caller = { actor: caller.handle, team: ctx.team, root, registry: binding.registry, home: ctx.bus.home }; });
    let recent = false;
    const io: OperateIO = {
      env: process.env, now: Date.now, liveness: live, caller: () => caller, policy: () => policy, preset: () => {}, workerCurrent: () => true,
      notify: async () => { throw new Error("not used"); }, worker: async () => { throw new Error("not used"); },
      read: () => { const text = frame(); return { frame: text, nativeActivity: 1000, facts: { binding, callerPane: ownerPane,
        captured: true, verdict: "parked-on-dialog", turnEnded: true, progress: false, screen: operatorSurface(binding.harness, text).kind,
        protection: "clear", recoveryOwned: false, scriptedCure: false, clients: recent ? [{ id: "human", session: binding.session, activity: Date.now(), created: 1 }] : [],
        mail: [{ ...record.mail, instance: binding.instance, firstSpooled: 1, disposition: "undelivered", valid: true }] } }; },
      audit: (_r, action, detail) => { const r = appendRegistryEvent({ log: registryEventsPath(ctx.bus.home), actor: caller.handle, action,
        handle: binding.handle, pane, team: ctx.team, detail }); if (!r.ok) throw new Error(r.reason); },
      effect: { capture: frame, authorize: () => T("display-message", "-p", "-t", pane, "#{pane_pid}").stdout.trim() === binding.processPid ? null : "fixture process changed",
        snapshot: () => ({ dead: "0", command: binding.harness, windowCount: "2", paneId: pane, instance: binding.instance, pid: binding.processPid }),
        effect: args => { const r = T(...args); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; }, settle: () => Bun.sleepSync(100) },
    };
    const reason = join(root, "reason.txt"); writeFileSync(reason, "Cancel this observed benign menu.");
    await check({ io, frame, observe: () => executeOperate(ctx, operateOptions(["--run", run.id, "--observe"]), io),
      key: sample => executeOperate(ctx, operateOptions(["--run", run.id, "--key", "Escape", "--sample", sample, "--reason-file", reason]), io),
      held: () => recoveryHold(pane), release: () => releaseRun(run.id), bytes: () => existsSync(bytes) ? readFileSync(bytes, "utf8") : "",
      audits: () => readFileSync(registryEventsPath(ctx.bus.home), "utf8"), recent: () => { recent = true; } });
  } finally {
    T("kill-server");
    process.env = original;
    rmSync(root, { recursive: true, force: true });
  }
}
for (const specimen of fixtures) test(`${specimen.harness}: private constructed menu closes with exactly one Escape; composer ends navigation`, async () => {
  await world(specimen, async f => {
    const initial = await f.observe(); expect(initial.surface.kind).toBe("menu"); expect(f.held()).toBe(true);
    await Bun.sleep(30); expect(f.held()).toBe(true);
    expect((await f.key(initial.sample)).status).toBe("key-recorded"); expect(f.bytes()).toBe("1b");
    const after = await f.observe(); expect(after.surface.kind, f.frame()).toBe("composer"); expect(f.held()).toBe(true);
    expect((await f.key(after.sample)).status).toBe("held"); expect(f.bytes()).toBe("1b");
    f.release(); expect(f.held()).toBe(false);
    expect(f.audits()).toContain("action=operator_observation"); expect(f.audits()).toContain("action=operator_key_result");
  });
}, 30000);
test("private navigation sends no Escape on a protected prompt or after new client activity", async () => {
  await world({ ...fixtures[0]!, menu: box("Permission required") }, async f => {
    const sample = await f.observe(); expect((await f.key(sample.sample)).status).toBe("held"); expect(f.bytes()).toBe(""); f.release();
  });
  await world(fixtures[0]!, async f => {
    const sample = await f.observe(); f.recent(); expect((await f.key(sample.sample)).status).toBe("held"); expect(f.bytes()).toBe(""); f.release();
  });
}, 30000);
