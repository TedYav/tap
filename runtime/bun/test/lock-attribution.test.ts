import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lockHolders, type LockHolder } from "../src/lock-attribution";
import { paneLockPath } from "../src/panelock";
import { queueExplanation } from "../src/queue-explanation";
import { graceAttempted, type DeadlineContext } from "../src/spool-deadline";
import { removeScratchTree } from "./support/scratch";

const ROOT = join(import.meta.dir, "../../..");
const LIB = join(ROOT, "skills/tap/scripts/smoke/runtime-helpers.sh");

test("lock refusal is attributed, notifies once, and delivers after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "tap-lock-attribution."));
  const bin = join(root, "bin"), wt = join(root, "fixture"), bus = join(wt, ".tap/bus"), index = join(root, "index");
  const registry = join(wt, ".tap/team-registry.json");
  for (const dir of [bin, wt, index, ...["payloads", "receipts", "spool", "delivery"].map(name => join(bus, name))]) {
    mkdirSync(dir, { recursive: true });
  }
  // Other Bun files mutate process.env; this fixture owns its socket identity.
  const socket = `tapbun-lock-attribution-${crypto.randomUUID().slice(0, 8)}`;
  const realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("requires tmux");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' "$@"\n`, { mode: 0o755 });
  const bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash",
    ...(process.platform === "linux" ? [Bun.which("bash")!] : [])].find(existsSync);
  if (!bash) throw new Error("copyable bash required");
  copyFileSync(bash, join(bin, "codex"));
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_TMUX_SOCKET: socket, TAP_LOCK_DIR: join(root, "locks"), TAP_TUI_SETTLE_SCALE: ".1", TAP_SELF: undefined,
    TMUX: undefined, TMUX_PANE: undefined, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_PANE_SUBMIT_LOCK_TIMEOUT: ".2" };
  function run(args: string[]) {
    const result = Bun.spawnSync(args, { cwd: wt, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(JSON.stringify(args) + " " + result.stdout + " " + result.stderr);
    return result.stdout.toString().trim();
  }
  const tmux = (...args: string[]) => run([realTmux, "-L", socket, ...args]);
  const shell = (body: string, ...args: string[]) => run(["bash", "-c",
    '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; ' + body, "_", LIB, ...args]);
  const submissions = (seat: string) => readFileSync(join(root, seat + ".received"), "utf8").split("[[TAP").length - 1;
  try {
    run(["git", "init", "-q", wt]);
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20",
      teams: { fixture: { root: wt, registry_location: registry, state: "registered" } } }));
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: wt }, seats: {} }));
    for (const seat of ["peer", "sender"]) {
      const script = join(root, seat + ".sh");
      writeFileSync(script, `printf '\\n› '\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> '${root}/${seat}.received'; printf '\\n[submitted]\\n\\n› '; done\n`);
      tmux("new-session", "-d", "-s", seat, "-c", wt, `'${bin}/codex' '${script}'`);
      for (let probe = 0; probe < 200; probe++) {
        if (tmux("capture-pane", "-p", "-t", seat + ":0.0").includes("›")) break;
        await Bun.sleep(25);
      }
      run([ROOT + "/bin/tap", "register", seat, "--pane", seat + ":0.0"]);
    }
    const paneId = tmux("display-message", "-p", "-t", "peer:0.0", "#{pane_id}");
    expect(shell('. "${1%/smoke/runtime-helpers.sh}/smoke/spool-readiness-fixture.sh"; spool_pane_ready_fixture peer:0.0 "$2" peer fixture "$3" standard', paneId, registry)).toBe("ready");
    const id = "lock-attribution", canon = join(bus, "payloads", id + ".md");
    writeFileSync(canon, `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\npath: ${canon}\n---\nlock reproduction\n`);
    const lock = paneLockPath(paneId, env);
    const holder = Bun.spawn(["python3", "-u", "-c",
      'import fcntl,sys,time; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("held",flush=True); time.sleep(120)', lock, "PRIVATE_OTHER_SENDER_MESSAGE_897"],
      { env, stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
      reader.releaseLock();
      const refused = run([process.execPath, "-e", `
const {submitVerify} = await import(${JSON.stringify(join(ROOT, "runtime/bun/src/courier.ts"))});
const r = submitVerify("peer:0.0", "lock-attribution", "[[TAP v0.23 ask lock-attribution]]", { paneId: ${JSON.stringify(paneId)}, harness: "codex", handle: "peer" },
  { scriptsDir: ${JSON.stringify(join(ROOT, "skills/tap/scripts"))}, agentFamilies: new Set(["codex"]), busHome: ${JSON.stringify(bus)}, recipient: "peer", registryPath: ${JSON.stringify(registry)} },
  (await import(${JSON.stringify(join(ROOT, "runtime/bun/src/deliver.ts"))})).DARK_EFFECTS);
console.log(r.status);`]);
      expect(refused).toBe("lock_busy");
      // Keep the OS observation deterministic. A host lsof scan can exceed the
      // production diagnostic timeout under load; the actual flock refusal above
      // stays real, while these two platform doors supply its safe holder facts.
      writeFileSync(join(bin, "lsof"), `#!/bin/sh\nprintf 'p${holder.pid}\\ncPython\\nf3\\n'\n`, { mode: 0o755 });
      writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf '00:01 /usr/bin/python3\\n'\n", { mode: 0o755 });
      shell('tap_ensure_dirs; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-park-placed-fixture.sh"; spool_park_placed_fixture lock-attribution "$2" sender peer discuss expected peer:0.0 "$3" fixture "$4" no-input-prompt "" standard "" 0', canon, paneId, registry);
      const metaPath = join(bus, "spool", id + ".meta.json");
      const original = JSON.parse(readFileSync(metaPath, "utf8"));
      const redeliver = () => shell('rc=0; spool_engine_fixture redeliver lock-attribution peer peer:0.0 "$2" fixture "$3" || rc=$?; printf "%s" "$rc"', paneId, registry);
      expect(redeliver()).toBe("1");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      expect(meta.reason).toBe("lock-park");
      expect(JSON.stringify(meta.lock_park)).not.toContain("PRIVATE_OTHER_SENDER_MESSAGE_897");
      expect(JSON.stringify(meta.lock_park.holders)).not.toContain("time.sleep");
      expect(meta.lock_park.holders.some((row: any) => row.pid === holder.pid && row.age !== "unavailable" && row.command.toLowerCase().includes("python"))).toBe(true);
      for (const field of ["deadline_source", "deadline_epoch", "hold_until_epoch", "waiter_lifetime", "reason_class"]) {
        expect(meta[field]).toEqual(original[field]);
      }
      expect(meta.escalated_at).toBeUndefined();
      expect(queueExplanation(bus, id)).toContain("last recorded submit was refused by the pane lock");
      const notice = join(bus, "payloads", id + "-lock-park.md");
      const body = readFileSync(notice, "utf8");
      expect(body).toContain("existing delivery policy determines retry or disposition");
      expect(body).not.toContain("retries continue");
      expect(body).toContain(`pid=${holder.pid}`);
      expect(body).not.toContain("PRIVATE_OTHER_SENDER_MESSAGE_897");
      expect(body).not.toContain("time.sleep");
      expect(body).not.toContain("stopped trying");
      expect(body).not.toContain("no-input-prompt");
      expect(submissions("sender")).toBe(1);
      const attemptPath = notice.replace(/\.md$/, ".attempts"), attempt = readFileSync(attemptPath, "utf8");
      expect(redeliver()).toBe("1");
      expect(readFileSync(attemptPath, "utf8")).toBe(attempt);
      expect(submissions("sender")).toBe(1);
      expect(existsSync(join(root, "peer.received"))).toBe(false);
      // Both lock refusals happened before a pane effect, so the grace-window
      // entry remains retry-owned and carries no conservative attempt marker.
      const heldMeta = JSON.parse(readFileSync(metaPath, "utf8"));
      writeFileSync(metaPath, JSON.stringify({ ...heldMeta, waiter_lifetime: "grace-window" }));
      expect(graceAttempted({ home: bus, spoolDir: join(bus, "spool") } as DeadlineContext, id)).toBe(false);
      expect(body).toContain("retry or disposition");
      writeFileSync(metaPath, JSON.stringify(heldMeta));
      holder.kill();
      await holder.exited;
      const historical = queueExplanation(bus, id);
      expect(historical).toContain(`Lock refusal observed at ${JSON.parse(readFileSync(metaPath, "utf8")).lock_park.observed_at}`);
      expect(historical).toContain("current lock ownership has not been rechecked");
      expect(historical).not.toContain("another submit holds");
      expect(redeliver()).toBe("0");
      expect(existsSync(join(bus, "receipts", id + ".sent"))).toBe(true);
      expect(existsSync(metaPath)).toBe(false);
      expect(submissions("peer")).toBe(1);
    } finally { holder.kill(); await holder.exited; }
  } finally { tmux("kill-server"); removeScratchTree(root); }
}, 90000);

test("a missing holder is reported as unavailable", () => {
  const result = lockHolders("/nonexistent/tap-lock-attribution");
  expect(result.holders).toEqual([]);
  expect(result.detail).toContain("holder unavailable");
});

test("many hung holders share one total budget, not one timeout apiece", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-lock-attribution-budget."));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const pids = [111, 222, 333, 444, 555];
  writeFileSync(join(bin, "lsof"),
    "#!/bin/sh\n" + pids.map(pid => `printf 'p${pid}\\ncbash\\nf3\\n'\n`).join(""), { mode: 0o755 });
  // Every ps call hangs past any single call's share of the budget. If each call still got its
  // own fixed timeout (the pre-fix shape), five holders would cost five timeouts; bounded to one
  // shared deadline, the whole observation should finish in roughly one deadline period.
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nsleep 10\nprintf '00:01 real\\n'\n", { mode: 0o755 });
  try {
    // A child process with an explicit PATH, not a mutation of this test file's own process.env,
    // matches how the fixture above (line 69) drives lockHolders through its real lsof/ps env.
    const started = Date.now();
    const out = Bun.spawnSync([process.execPath, "-e", `
const {lockHolders} = await import(${JSON.stringify(join(ROOT, "runtime/bun/src/lock-attribution.ts"))});
console.log(JSON.stringify(lockHolders(${JSON.stringify(join(root, "lock"))})));`],
      { env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const elapsed = Date.now() - started;
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    const result = JSON.parse(out.stdout.toString());
    expect(result.holders.map((holder: LockHolder) => holder.pid).sort((a: number, b: number) => a - b)).toEqual(pids);
    expect(result.holders.every((holder: LockHolder) => holder.command === "unavailable")).toBe(true);
    // Old per-call-timeout shape: 5 holders x a multi-second timeout each is ten-plus seconds.
    // The shared-deadline shape stays close to one deadline regardless of holder count.
    expect(elapsed).toBeLessThan(8000);
  } finally { removeScratchTree(root); }
}, 15000);
