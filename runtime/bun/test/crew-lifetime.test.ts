import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "../src/tmux";
import { authorizeNewCrew, assertCrewOwnerLink, captureCrewProcess, captureParentHarnessLifetime, crewLifetimeHealth, fenceCrewLifetime, processGeneration, stopCrewProcess, stopCrewLifetimeHelper, validateCrewProcess, validateParentHarnessLifetime } from "../src/crew-lifetime";
import { agentFamilies, observeProcessHarness, readProcessTable } from "../src/observe";
import type { ResolvedContext } from "../src/context";
import { Bus } from "../src/bus";
import { legacyCrewHelper } from "./support/legacy-crew-lifetime";

function socketFixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "lifetime-")));
  const socket = join(root, "s");
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sleep", join(bin, "codex"));
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  const read = (...args: string[]) => {
    const r = tmux(...args);
    expect(r.status).toBe(0);
    return (r.stdout ?? "").trim();
  };
  const prior = process.env.TMUX;
  const priorPath = process.env.TAP_TMUX_SOCKET_PATH;
  const priorName = process.env.TAP_TMUX_SOCKET;
  process.env.TMUX = `${socket},0,0`;
  process.env.TAP_TMUX_SOCKET_PATH = socket;
  delete process.env.TAP_TMUX_SOCKET;
  const close = () => {
    tmux("kill-server");
    if (prior === undefined) delete process.env.TMUX;
    else process.env.TMUX = prior;
    if (priorPath === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
    else process.env.TAP_TMUX_SOCKET_PATH = priorPath;
    if (priorName === undefined) delete process.env.TAP_TMUX_SOCKET;
    else process.env.TAP_TMUX_SOCKET = priorName;
  };
  return { root, socket, bin, tmux, read, close };
}

function registry(f: ReturnType<typeof socketFixture>, parentPane: string, crewPane: string) {
  const rawEpoch = f.read("display-message", "-p", "#{pid}:#{start_time}");
  const base = { delivery: "pane", status: "active", harness: "codex", session: "Lifetime/parent",
    server_epoch: `srv:${rawEpoch}`, server_socket: f.socket, boot_id: bootId() };
  const path = join(f.root, "registry.json");
  writeFileSync(path, JSON.stringify({ schema: "0.20", team: { name: "Lifetime" }, seats: {
    parent: { ...base, instance: "parent-one", pane_id: parentPane },
    child: { ...base, instance: "child-one", pane_id: crewPane, crew: true, crew_owner: "parent", crew_owner_instance: "parent-one" },
  } }));
  return { path, ctx: { registryPath: path, team: "Lifetime" } as ResolvedContext };
}

async function waitFor(predicate: () => boolean, max = 10000) {
  const until = Date.now() + max;
  while (Date.now() < until) {
    if (predicate()) return true;
    await Bun.sleep(100);
  }
  return false;
}

function family(f: ReturnType<typeof socketFixture>, command = "sleep 600") {
  expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
  const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
  expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", command).status).toBe(0);
  const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
  return { ...registry(f, parentPane, crewPane), parentPane, crewPane };
}

test("new crew proof remains valid after parent exit and starts no helper", () => {
  const f = socketFixture();
  try {
    const { ctx, parentPane, crewPane } = family(f);
    const parent = captureParentHarnessLifetime(ctx, "parent");
    expect(validateParentHarnessLifetime(parent)).toBe(true);
    const proof = authorizeNewCrew(ctx, parentPane, "child");
    expect(crewLifetimeHealth(crewPane)).toBe("independent");
    expect(f.tmux("show-option", "-p", "-v", "-t", crewPane, "@tap_crew_lifetime").stdout.trim()).toBe("");
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    expect(validateCrewProcess(proof)).toBe(true);
    expect(validateParentHarnessLifetime(parent)).toBe(false);
  } finally { f.close(); }
});

test("durable ownership survives vessel loss but refuses a reused owner handle", () => {
  const f = socketFixture();
  try {
    const { ctx, path } = family(f), doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seats.parent.session = "old-session"; doc.seats.parent.server_epoch = "srv:1:1";
    writeFileSync(path, JSON.stringify(doc));
    expect(assertCrewOwnerLink(ctx, "child").owner).toBe("parent");
    doc.seats.parent.instance = "another-parent"; writeFileSync(path, JSON.stringify(doc));
    expect(() => assertCrewOwnerLink(ctx, "child")).toThrow("no matching retained owner");
    delete doc.seats.parent; writeFileSync(path, JSON.stringify(doc));
    expect(() => assertCrewOwnerLink(ctx, "child")).toThrow("no matching retained owner");
  } finally { f.close(); }
});

test("unknown process evidence never proves loss", () => {
  expect(processGeneration({ pid: "", start: "", boot: "" })).toBe("unknown");
});

test("explicit crew cleanup stops a process that ignores hangup and TERM", async () => {
  const f = socketFixture();
  try {
    const { ctx, parentPane } = family(f, "/bin/sh -c 'trap \"\" HUP TERM; exec sleep 600'");
    const proof = authorizeNewCrew(ctx, parentPane, "child");
    expect(stopCrewProcess(proof).outcome).toBe("stopped");
    expect(await waitFor(() => processGeneration(proof.child) === "gone")).toBe(true);
    expect(f.read("display-message", "-p", "-t", parentPane, "#{pane_id}")).toBe(parentPane);
  } finally { f.close(); }
});

test("the atomic pane guard preserves a crew process replaced after observation", () => {
  const f = socketFixture();
  try {
    const { ctx, parentPane, crewPane } = family(f), proof = authorizeNewCrew(ctx, parentPane, "child");
    const realTmux = Bun.which("tmux")!, quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(f.bin, "tmux"), `#!/bin/sh\ncase " $* " in *" if-shell "*) ${quote(realTmux)} -S ${quote(f.socket)} respawn-pane -k -t ${quote(crewPane)} 'sleep 600' ;; esac\nexec ${quote(realTmux)} "$@"\n`, { mode: 0o755 });
    const entry = join(f.root, "guard.ts");
    writeFileSync(entry, `import {stopCrewProcess} from ${JSON.stringify(join(import.meta.dir, "../src/crew-lifetime.ts"))};\nconsole.log(JSON.stringify(stopCrewProcess(JSON.parse(process.argv[2]!))));\n`);
    const result = spawnSync(process.execPath, [entry, JSON.stringify(proof)], { encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "changed" });
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_pid}")).not.toBe(proof.child.pid);
  } finally { f.close(); }
});

test("transition fences a frozen legacy helper before it can kill its crew and preserves the old evidence", async () => {
  const f = socketFixture();
  let old: Awaited<ReturnType<typeof legacyCrewHelper>> | undefined;
  try {
    const { ctx, parentPane, crewPane } = family(f);
    old = await legacyCrewHelper(ctx, "parent", "child");
    process.kill(Number(old.helper.pid), "SIGSTOP");
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    const raw = f.read("show-option", "-p", "-v", "-t", crewPane, "@tap_crew_lifetime");
    const entry = join(f.root, "fence.ts");
    writeFileSync(entry, `import {fenceCrewLifetime} from ${JSON.stringify(join(import.meta.dir, "../src/crew-lifetime.ts"))}; fenceCrewLifetime(JSON.parse(process.argv[2]!), 'child');`);
    const child = Bun.spawn([process.execPath, entry, JSON.stringify(ctx)], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status, stderr).toBe(0);
    expect(processGeneration(old.helper)).toBe("gone");
    expect(f.read("show-option", "-p", "-v", "-t", crewPane, "@tap_crew_lifetime")).toBe(raw);
    expect(f.read("show-option", "-p", "-v", "-t", crewPane, "@tap_crew_lifetime_token")).toBe(`retired:${old.token}`);
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_id}")).toBe(crewPane);
    expect(crewLifetimeHealth(crewPane)).toBe("independent");
    fenceCrewLifetime(ctx, "child"); // repeated touch is idempotent
  } finally { if (old) stopCrewLifetimeHelper(old); f.close(); }
}, 30000);
