import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "../src/tmux";
import { captureParentHarnessLifetime, crewLifetimeHealth, processGeneration, rearmCrewLifetime, reconcileCrewLifetime, stopBoundCrewPane, stopCrewLifetimeHelper, validateCrewLifetimeBinding, validateParentHarnessLifetime } from "../src/crew-lifetime";
import { agentFamilies, observeProcessHarness, readProcessTable } from "../src/observe";
import type { ResolvedContext } from "../src/context";
import { Bus } from "../src/bus";
import { relaunchCrew } from "../src/crew-lifecycle";

function socketFixture() {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "lifetime-"));
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

test("crew helper survives both row retirements, ends last owned pane on parent exit, and preserves unrelated shell", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    expect(f.tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const { path, ctx } = registry(f, parentPane, crewPane);
    writeFileSync(path, readFileSync(path, "utf8").replace('"seats":', '"wide_extension":9007199254740993,"seats":'));
    const selected = captureParentHarnessLifetime(ctx, "parent");
    expect(validateParentHarnessLifetime(selected)).toBe(true);
    const binding = await reconcileCrewLifetime(ctx, "parent", "child");
    expect(validateCrewLifetimeBinding(binding)).toBe(true);
    expect(processGeneration(binding.helper)).toBe("same");
    const sample = spawnSync("ps", ["-p", binding.helper.pid, "-o", "rss=,%cpu="], { encoding: "utf8" });
    expect(sample.status).toBe(0);
    console.log(`crew lifetime helper sample (RSS KB, CPU percent): ${(sample.stdout ?? "").trim()}`);
    writeFileSync(path, JSON.stringify({ schema: "0.20", team: { name: "Lifetime" }, seats: {} }));
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    expect(validateParentHarnessLifetime(selected)).toBe(false);
    const ended = await waitFor(() => !f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(crewPane), 4000);
    expect(ended).toBe(true);
    expect(f.tmux("has-session", "-t", "operator").status).toBe(0);
    expect(await waitFor(() => processGeneration(binding.helper) === "gone")).toBe(true);
  } finally { f.close(); }
}, 30000);

test("unknown process evidence cannot become a death certificate", () => {
  expect(processGeneration({ pid: "", start: "", boot: "" })).toBe("unknown");
  expect(processGeneration({ pid: String(process.pid), start: "", boot: bootId() })).toBe("unknown");
});

test("a manually started foreground harness ends its crew while its shell remains", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", "/bin/bash -i").status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("send-keys", "-t", parentPane, "-l", `${f.bin}/codex 600`).status).toBe(0);
    expect(f.tmux("send-keys", "-t", parentPane, "Enter").status).toBe(0);
    expect(await waitFor(() => {
      const root = f.read("display-message", "-p", "-t", parentPane, "#{pane_pid}");
      const ps = readProcessTable();
      const observation = observeProcessHarness(root, ps.table, ps.ok, agentFamilies());
      return observation.family === "codex" && !!observation.pid && observation.pid !== root;
    })).toBe(true);
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    const binding = await reconcileCrewLifetime(ctx, "parent", "child");
    expect(binding.parent.pid).not.toBe(f.read("display-message", "-p", "-t", parentPane, "#{pane_pid}"));
    process.kill(Number(binding.parent.pid), "SIGTERM");
    expect(await waitFor(() => !f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(crewPane))).toBe(true);
    expect(f.read("display-message", "-p", "-t", parentPane, "#{pane_id}")).toBe(parentPane);
  } finally { f.close(); }
}, 30000);

test("a child relaunch invalidates the old helper; a missing helper can be rearmed", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    const first = await reconcileCrewLifetime(ctx, "parent", "child");
    expect(f.tmux("respawn-pane", "-k", "-t", crewPane, "sleep 600").status).toBe(0);
    expect(await waitFor(() => f.read("display-message", "-p", "-t", crewPane, "#{pane_pid}") !== first.child.pid)).toBe(true);
    expect(await waitFor(() => processGeneration(first.helper) === "gone")).toBe(true);
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_id}")).toBe(crewPane);
    const second = await rearmCrewLifetime(ctx, "child");
    expect(second.token).not.toBe(first.token);
    expect(second.parent).toEqual(first.parent);
    stopCrewLifetimeHelper(second);
    expect(await waitFor(() => crewLifetimeHealth(crewPane) === "unsupervised")).toBe(true);
    const third = await rearmCrewLifetime(ctx, "child");
    expect(third.token).not.toBe(second.token);
    expect(validateCrewLifetimeBinding(third)).toBe(true);
  } finally { f.close(); }
}, 30000);

test("a replacement parent process in the same pane cannot inherit the prior crew", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    const binding = await reconcileCrewLifetime(ctx, "parent", "child");
    expect(f.tmux("respawn-pane", "-k", "-t", parentPane, `${f.bin}/codex 600`).status).toBe(0);
    expect(await waitFor(() => f.read("display-message", "-p", "-t", parentPane, "#{pane_pid}") !== binding.parent.pid)).toBe(true);
    expect(await waitFor(() => !f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(crewPane))).toBe(true);
    expect(f.read("display-message", "-p", "-t", parentPane, "#{pane_id}")).toBe(parentPane);
  } finally { f.close(); }
}, 30000);

test("a parent lost before arming refuses without claiming or stopping a child", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    expect(reconcileCrewLifetime(ctx, "parent", "child")).rejects.toMatchObject({ errorClass: "crew_lifetime_unprovable" });
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_id}")).toBe(crewPane);
  } finally { f.close(); }
}, 30000);

test("bound child cleanup stops a process that ignores terminal hangup and TERM", async () => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child",
      "/bin/sh -c 'trap \"\" HUP TERM; exec sleep 600'").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    const binding = await reconcileCrewLifetime(ctx, "parent", "child");
    expect(stopBoundCrewPane(binding).outcome).toBe("stopped");
    expect(await waitFor(() => processGeneration(binding.child) === "gone")).toBe(true);
    expect(f.read("display-message", "-p", "-t", parentPane, "#{pane_id}")).toBe(parentPane);
  } finally { f.close(); }
}, 30000);

for (const failure of ["exit", "deadline"] as const) test(`transient tmux ${failure} preserves supervision until parent exit`, async () => {
  const f = socketFixture();
  const priorPath = process.env.PATH, priorTimeout = process.env.TAP_TMUX_TIMEOUT_SECONDS;
  let binding: Awaited<ReturnType<typeof reconcileCrewLifetime>> | undefined;
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    expect(f.tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const { ctx } = registry(f, parentPane, crewPane);
    const fail = join(f.root, "fail-observation"), attempted = join(f.root, "failed-observation-seen");
    const realTmux = Bun.which("tmux")!;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(f.bin, "tmux"), `#!/bin/sh\nif [ -e ${quote(fail)} ]; then : > ${quote(attempted)}; ${failure === "deadline" ? "exec sleep 2" : "exit 1"}; fi\nexec ${quote(realTmux)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${f.bin}:${priorPath}`;
    // The exit arm does not exercise a deadline. Give initial setup a normal
    // observation budget; only the deadline arm needs a short bound.
    if (failure === "deadline") process.env.TAP_TMUX_TIMEOUT_SECONDS = "1";
    else delete process.env.TAP_TMUX_TIMEOUT_SECONDS;
    binding = await reconcileCrewLifetime(ctx, "parent", "child");
    writeFileSync(fail, "fail the helper's next read");
    expect(await waitFor(() => { try { readFileSync(attempted); return true; } catch { return false; } }, 5000)).toBe(true);
    expect(processGeneration(binding.helper)).toBe("same");
    unlinkSync(fail);
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    expect(await waitFor(() => !f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(crewPane), 6000)).toBe(true);
    expect(await waitFor(() => processGeneration(binding!.helper) === "gone")).toBe(true);
  } finally {
    if (binding) stopCrewLifetimeHelper(binding);
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorTimeout === undefined) delete process.env.TAP_TMUX_TIMEOUT_SECONDS; else process.env.TAP_TMUX_TIMEOUT_SECONDS = priorTimeout;
    f.close();
  }
}, 30000);

test("rearm cannot adopt a surviving crew into a replacement parent generation", async () => {
  const f = socketFixture();
  let binding: Awaited<ReturnType<typeof reconcileCrewLifetime>> | undefined;
  let unexpected: typeof binding;
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    binding = await reconcileCrewLifetime(ctx, "parent", "child");
    stopCrewLifetimeHelper(binding);
    expect(await waitFor(() => processGeneration(binding!.helper) === "gone")).toBe(true);
    expect(f.tmux("respawn-pane", "-k", "-t", parentPane, `${f.bin}/codex 600`).status).toBe(0);
    let error: unknown;
    try { unexpected = await rearmCrewLifetime(ctx, "child"); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ errorClass: "crew_lifetime_unprovable", detail: expect.stringContaining("different parent generation") });
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_id}")).toBe(crewPane);
  } finally {
    if (binding) stopCrewLifetimeHelper(binding);
    if (unexpected) stopCrewLifetimeHelper(unexpected);
    f.close();
  }
}, 30000);

test("the atomic pane guard preserves a child replaced after observation", async () => {
  const f = socketFixture();
  let binding: Awaited<ReturnType<typeof reconcileCrewLifetime>> | undefined;
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    const { ctx } = registry(f, parentPane, crewPane);
    binding = await reconcileCrewLifetime(ctx, "parent", "child");
    const realTmux = Bun.which("tmux")!;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(f.bin, "tmux"), `#!/bin/sh\ncase " $* " in *" if-shell "*) ${quote(realTmux)} -S ${quote(f.socket)} respawn-pane -k -t ${quote(crewPane)} 'sleep 600' ;; esac\nexec ${quote(realTmux)} "$@"\n`, { mode: 0o755 });
    const entry = join(f.root, "guard.ts");
    writeFileSync(entry, `import {stopBoundCrewPane} from ${JSON.stringify(join(import.meta.dir, "../src/crew-lifetime.ts"))};\nconsole.log(JSON.stringify(stopBoundCrewPane(JSON.parse(process.argv[2]!))));\n`);
    const result = spawnSync(process.execPath, [entry, JSON.stringify(binding)], {
      encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "changed" });
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_id}")).toBe(crewPane);
    expect(f.read("display-message", "-p", "-t", crewPane, "#{pane_pid}")).not.toBe(binding.child.pid);
  } finally {
    if (binding) stopCrewLifetimeHelper(binding);
    f.close();
  }
}, 30000);

test("parent exit after crew respawn stops the exact verified replacement", async () => {
  const f = socketFixture();
  const saved = new Map(["PATH", "TAP_INDEX_HOME", "TAP_HOME", "TAP_LAUNCH_SHELL"].map(key => [key, process.env[key]]));
  let binding: Awaited<ReturnType<typeof reconcileCrewLifetime>> | undefined;
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    expect(f.tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const { path, ctx: partial } = registry(f, parentPane, crewPane);
    const root = realpathSync(f.root), index = join(root, "index");
    mkdirSync(index);
    process.env.TAP_INDEX_HOME = index;
    delete process.env.TAP_HOME;
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      Lifetime: { root, registry_location: realpathSync(path), state: "registered" },
    } }));
    const document = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(document.seats.child, { cwd: root, model: "gpt-test", permissions: "bypass",
      harness_env: {}, passthrough: [], passthrough_from_config: false, preset: null });
    writeFileSync(path, JSON.stringify(document));
    const ctx = { ...partial, root, registryPath: realpathSync(path), bus: new Bus(join(root, ".tap", "bus")) } as ResolvedContext;
    binding = await reconcileCrewLifetime(ctx, "parent", "child");
    // The existing parent already runs the executable; the new fake CLI accepts
    // the launcher's normal arguments and keeps the replacement process alive.
    unlinkSync(join(f.bin, "codex"));
    writeFileSync(join(f.bin, "codex"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
    const shell = join(f.bin, "sh");
    writeFileSync(shell, '#!/bin/sh\nif [ "$1" = -lic ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
    process.env.PATH = `${f.bin}:${process.env.PATH}`;
    process.env.TAP_LAUNCH_SHELL = shell;
    let parentEnded = false, error: unknown;
    try {
      await relaunchCrew(ctx, document.seats, "child", "", { progress: line => {
        if (line.startsWith("respawn attempted")) {
          expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
          parentEnded = true;
        }
      } });
    } catch (caught) { error = caught; }
    expect(parentEnded).toBe(true);
    expect(error).toMatchObject({ errorClass: "crew_parent_exited" });
    expect(f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n")).not.toContain(crewPane);
    expect(f.tmux("has-session", "-t", "operator").status).toBe(0);
  } finally {
    if (binding) stopCrewLifetimeHelper(binding);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.close();
  }
}, 30000);

test("an override relaunch whose recipe save fails still verifies and supervises the replacement, then reports it", async () => {
  const f = socketFixture();
  const saved = new Map(["PATH", "TAP_INDEX_HOME", "TAP_HOME", "TAP_LAUNCH_SHELL"].map(key => [key, process.env[key]]));
  let binding: Awaited<ReturnType<typeof reconcileCrewLifetime>> | undefined;
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", "-n", "parent", `${f.bin}/codex 600`).status).toBe(0);
    const parentPane = f.read("display-message", "-p", "-t", "Lifetime/parent:0.0", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "-n", "child", "sleep 600").status).toBe(0);
    const crewPane = f.read("display-message", "-p", "-t", "Lifetime/parent:1.0", "#{pane_id}");
    expect(f.tmux("new-session", "-d", "-s", "operator", "sleep 600").status).toBe(0);
    const { path, ctx: partial } = registry(f, parentPane, crewPane);
    const root = realpathSync(f.root), index = join(root, "index");
    mkdirSync(index);
    process.env.TAP_INDEX_HOME = index;
    delete process.env.TAP_HOME;
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      Lifetime: { root, registry_location: realpathSync(path), state: "registered" },
    } }));
    const document = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(document.seats.child, { cwd: root, model: "gpt-test", permissions: "bypass",
      harness_env: {}, passthrough: [], passthrough_from_config: false, preset: null });
    writeFileSync(path, JSON.stringify(document));
    const ctx = { ...partial, root, registryPath: realpathSync(path), bus: new Bus(join(root, ".tap", "bus")) } as ResolvedContext;
    binding = await reconcileCrewLifetime(ctx, "parent", "child");
    const dump = join(root, "override-seen");
    unlinkSync(join(f.bin, "codex"));
    writeFileSync(join(f.bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "\${CREW_NEW-absent}" > '${dump}'\nexec sleep 600\n`, { mode: 0o755 });
    const shell = join(f.bin, "sh");
    writeFileSync(shell, '#!/bin/sh\nif [ "$1" = -lic ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
    process.env.PATH = `${f.bin}:${process.env.PATH}`;
    process.env.TAP_LAUNCH_SHELL = shell;
    const oldPid = f.read("display-message", "-p", "-t", crewPane, "#{pane_pid}");
    let error = null as { code?: number; errorClass?: string; action?: string } | null;
    try {
      await relaunchCrew(ctx, document.seats, "child", "", { overrides: { env: ["CREW_NEW=typed"] }, progress: line => {
        // Only the post-respawn save fails: another writer changes the recipe right before the effect.
        if (!line.startsWith("replacing crew process")) return;
        const now = JSON.parse(readFileSync(path, "utf8"));
        now.seats.child.harness_env = { CREW_OTHER: "1" };
        writeFileSync(path, JSON.stringify(now));
      } });
    } catch (caught) { error = caught as typeof error; }
    expect(error).toMatchObject({ code: 1, errorClass: "crew_recipe_unpersisted" });
    expect(error?.action).toContain("tap session relaunch Lifetime/child");
    expect(error?.action).not.toContain("tap crew relaunch");
    const replacement = f.read("display-message", "-p", "-t", crewPane, "#{pane_pid}");
    expect(replacement).not.toBe(oldPid);
    expect(await waitFor(() => { try { return readFileSync(dump, "utf8").trim() === "typed"; } catch { return false; } })).toBe(true);
    // The recipe on disk is the other writer's, not this relaunch's.
    expect(JSON.parse(readFileSync(path, "utf8")).seats.child.harness_env).toEqual({ CREW_OTHER: "1" });
    // The replacement is supervised: parent exit stops exactly it.
    expect(f.tmux("kill-pane", "-t", parentPane).status).toBe(0);
    expect(await waitFor(() => !f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(crewPane))).toBe(true);
    expect(f.tmux("has-session", "-t", "operator").status).toBe(0);
  } finally {
    if (binding) stopCrewLifetimeHelper(binding);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.close();
  }
}, 30000);

test.each([undefined, "wrong-instance"])("an unbound crew cannot be adopted by a same-session parent with link %j", async ownerInstance => {
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", `${f.bin}/codex 600`).status).toBe(0);
    const parent = f.read("display-message", "-p", "-t", "Lifetime/parent", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "sleep 600").status).toBe(0);
    const child = f.read("display-message", "-p", "-t", "Lifetime/parent:1", "#{pane_id}");
    const { path, ctx } = registry(f, parent, child);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    delete doc.seats.child.crew_owner; delete doc.seats.child.crew_owner_instance;
    if (ownerInstance) { doc.seats.child.crew_owner = "parent"; doc.seats.child.crew_owner_instance = ownerInstance; }
    writeFileSync(path, JSON.stringify(doc));
    const before = readFileSync(path, "utf8");
    await expect(rearmCrewLifetime(ctx, "child")).rejects.toThrow("recreate");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(f.read("display-message", "-p", "-t", child, "#{pane_id}")).toBe(child);
  } finally { f.close(); }
}, 30000);

test("revival cannot reclaim an unbound crew after its parent handle is reused", async () => {
  const { survivingCrews, reclaimRevivedCrew } = await import("../src/crew-lifetime");
  const f = socketFixture();
  try {
    expect(f.tmux("new-session", "-d", "-s", "Lifetime/parent", `${f.bin}/codex 600`).status).toBe(0);
    const parent = f.read("display-message", "-p", "-t", "Lifetime/parent", "#{pane_id}");
    expect(f.tmux("new-window", "-d", "-t", "Lifetime/parent", "sleep 600").status).toBe(0);
    const child = f.read("display-message", "-p", "-t", "Lifetime/parent:1", "#{pane_id}");
    const { path, ctx } = registry(f, parent, child);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seats.child.crew_owner = "parent";
    doc.seats.child.crew_owner_instance = "original-parent";
    // Reused handle, same session, no pane-local binding after a restart.
    doc.seats.parent.instance = "replacement-parent";
    writeFileSync(path, JSON.stringify(doc));
    expect(survivingCrews(ctx, "parent")).toEqual([]);
    const before = readFileSync(path, "utf8");
    const pid = f.read("display-message", "-p", "-t", child, "#{pane_pid}");
    const { procStartEpoch } = await import("../src/reset");
    await expect(reclaimRevivedCrew(ctx, "parent", { crew: "child", crewInstance: "child-one", crewPane: child,
      ownerInstance: "replacement-parent", child: { pid, start: procStartEpoch(pid), boot: bootId() }, binding: null })).rejects.toThrow("recreate");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(f.read("display-message", "-p", "-t", child, "#{pane_id}")).toBe(child);
  } finally { f.close(); }
}, 30000);
