import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, requestKill, commandWake, type CommandJob } from "../src/remind-job";
import { cancelReminder, fire } from "../src/remind";
import { removeScratchTree } from "./support/scratch";
import { clearCourier, standInCourier } from "./support/courier";
const roots: string[] = [];
afterEach(() => { clearCourier(); for (const root of roots.splice(0)) removeScratchTree(root); });
function fixture(command: string) {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "job.")); roots.push(root);
  mkdirSync(join(root, "watch")); mkdirSync(join(root, "receipts"));
  const state = join(root, "watch/reminders.json");
  const job: CommandJob = { command, cwd: root, fallback: "leader", circle_seconds: 1,
    started_at: 100, heartbeat_at: 100, phase: "starting", tail: "", pending: [] };
  writeFileSync(state, JSON.stringify({ test: { owner: "owner", to: "owner", body: "check", status: "scheduled", due_at: 101, every_seconds: 0, job } }));
  return { root, state, job, row: () => JSON.parse(readFileSync(state, "utf8")).test };
}
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error("condition deadline"); await Bun.sleep(10); }
}
test("real child reports all three outcomes and captures bounded output", async () => {
  for (const [code, phase] of [[0, "done"], [1, "failed"], [2, "UNOBSERVABLE"]] as const) {
    const f = fixture(`printf evidence; exit ${code}`);
    if (code === 2) { const rows = JSON.parse(readFileSync(f.state, "utf8")); rows.test.job.unobservable_exit = 2; writeFileSync(f.state, JSON.stringify(rows)); }
    await runCommand(f.state, "test");
    expect(f.row().job).toMatchObject({ phase, child_exit: code, tail: "evidence" });
    expect(f.row().due_at).toBeGreaterThan(100);
  }
  const f = fixture("head -c 20000 /dev/zero"); await runCommand(f.state, "test");
  expect(Buffer.byteLength(f.row().job.tail)).toBeLessThanOrEqual(8192);
});
test("cancel stops wakes but the real child finishes, and duplicate custody never respawns", async () => {
  const f = fixture("sleep 0.2; printf yes > survived");
  const run = runCommand(f.state, "test");
  await until(() => f.row().job.child_pid > 0);
  cancelReminder(f.state, "owner", "test");
  await runCommand(f.state, "test");
  await run;
  expect(f.row().status).toBe("cancelled");
  expect(readFileSync(join(f.root, "survived"), "utf8")).toBe("yes");
});
test("explicit kill works after cancel; a foreign owner and terminal custody refuse", async () => {
  const f = fixture("exec sleep 20"), run = runCommand(f.state, "test");
  await until(() => f.row().job.child_pid > 0);
  expect(() => requestKill(f.state, "stranger", "test")).toThrow("only the scheduling");
  cancelReminder(f.state, "owner", "test");
  requestKill(f.state, "owner", "test");
  await run;
  expect(f.row().job.child_signal).toBe("SIGKILL");
  expect(f.row().status).toBe("cancelled");
  expect(() => requestKill(f.state, "owner", "test")).toThrow("no longer observable");
});
test("only actual done receipts acknowledge circle backs; third outstanding escalates once", () => {
  const f = fixture("true"); f.job.phase = "running"; f.job.pending = ["one", "two", "three"];
  writeFileSync(join(f.root, "receipts/one.placed"), "");
  mkdirSync(join(f.root, "receipts/two.done")); // a directory is not a settlement receipt
  expect(commandWake(f.job, f.root, 110)).toMatchObject({ target: "leader", terminal: false });
  f.job.stopped = false; f.job.escalated = false;
  writeFileSync(join(f.root, "receipts/one.done"), "");
  expect(commandWake(f.job, f.root, 110)).toMatchObject({ terminal: false });
  expect(f.job.pending).toEqual([]);
  expect(commandWake(f.job, f.root, 300).text).toContain("UNOBSERVABLE");
});
test("real queue fire hands terminal output off once, not on each tick", () => {
  const f = fixture("true");
  const rows = JSON.parse(readFileSync(f.state, "utf8")); rows.test.job.phase = "done";
  writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  standInCourier(scripts, 'cat "$2" >> "$(dirname "$0")/sent"\nprintf "{}"\n');
  fire(f.state, scripts, "100", 101);
  const body = readFileSync(join(scripts, "sent"), "utf8");
  expect(body).toContain("Command done");
  fire(f.state, scripts, "100", 102);
  expect(readFileSync(join(scripts, "sent"), "utf8")).toBe(body);
  expect(f.row().status).toBe("accepted");
});

test("new command admission launches one detached custodian and retains final state", async () => {
  const { addCommand } = await import("../src/remind");
  const f = fixture("true");
  const id = addCommand(f.state, "owner", "owner", "check", "printf admitted", 1, "leader", f.root, process.env);
  const row = () => JSON.parse(readFileSync(f.state, "utf8"))[id];
  await until(() => row().job.phase === "done");
  expect(row().job).toMatchObject({ tail: "admitted", child_exit: 0 });
  // Child stdout pipes and detached custodian must finish before scratch cleanup.
  const pid = row().job.custodian_pid;
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test("spawn failure and stale custody are UNOBSERVABLE; explicit kill never trusts stale pid", async () => {
  const f = fixture("true");
  const rows = JSON.parse(readFileSync(f.state, "utf8")); rows.test.job.cwd = join(f.root, "missing");
  writeFileSync(f.state, JSON.stringify(rows));
  await runCommand(f.state, "test");
  expect(f.row().job.phase).toBe("UNOBSERVABLE");
  rows.test.job.phase = "running"; rows.test.job.child_pid = process.pid;
  writeFileSync(f.state, JSON.stringify(rows));
  expect(() => requestKill(f.state, "owner", "test")).toThrow("no longer observable");
});

test("await-run uses terminal conclusion, tolerates API failure, refuses unknown observations", async () => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync } = await import("node:fs");
  const f = fixture("true"), bin = join(f.root, "bin"); mkdirSync(bin);
  const helper = join(import.meta.dir, "../../../scripts/await-run.sh");
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "sleep"), 0o755);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nif [ "$CASE" = transient ] && [ ! -f "$MARK" ]; then touch "$MARK"; exit 1; fi\ncase "$CASE" in transient|success) echo "completed success";; failure) echo "completed failure";; invalid) echo "completed mystery";; *) exit 1;; esac\n');
  chmodSync(join(bin, "gh"), 0o755);
  for (const [which, code] of [["success", 0], ["failure", 1], ["invalid", 2], ["outage", 2], ["transient", 0]] as const) {
    const result = spawnSync("bash", [helper, "123", "1"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CASE: which, MARK: join(f.root, "mark") }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(code);
    if (code === 2) expect(result.stdout).toContain("UNOBSERVABLE");
  }
});


test("generic exit2 is failed; declared exit2 carries provenance through the real wake payload", async () => {
  const f = fixture("exit 2"); await runCommand(f.state, "test");
  expect(f.row().job.phase).toBe("failed");
  const rows = JSON.parse(readFileSync(f.state, "utf8"));
  rows.test.job.phase = "UNOBSERVABLE"; rows.test.job.unobservable_exit = 2;
  rows.test.due_at = 101; writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  standInCourier(scripts, 'cat "$2" > "$(dirname "$0")/sent"\nprintf "{}"\n');
  fire(f.state, scripts, "100", 101);
  expect(readFileSync(join(scripts, "sent"), "utf8")).toContain("UNOBSERVABLE (child exit 2, declared by --unobservable-exit)");
});

test("dead seat gets three wakes, fallback gets one escalation; both seats get completion and no periodic fallback wakes", async () => {
  const f = fixture("true"), rows = JSON.parse(readFileSync(f.state, "utf8"));
  rows.test.job.phase = "running"; writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  standInCourier(scripts, 'printf "%s\\n" "$1" >> "$(dirname "$0")/targets"\ncat "$2" >> "$(dirname "$0")/sent"\nprintf "{}"\n');
  for (const tick of [101, 102, 103, 104, 105, 106]) fire(f.state, scripts, "100", tick);
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nowner\nowner\nleader\n");
  expect(f.row().status).toBe("scheduled");
  const done = JSON.parse(readFileSync(f.state, "utf8")); done.test.job.phase = "done"; done.test.due_at = 107;
  writeFileSync(f.state, JSON.stringify(done));
  fire(f.state, scripts, "100", 107); fire(f.state, scripts, "100", 108);
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nowner\nowner\nleader\nowner\nleader\n");
  expect(readFileSync(join(scripts, "sent"), "utf8")).toContain("Command done");
  expect(f.row().status).toBe("accepted");
  expect(f.row().job.terminal_deliveries.map((d: { to: string }) => d.to)).toEqual(["owner", "leader"]);
  expect(new Set(f.row().job.terminal_deliveries.map((d: { id: string }) => d.id)).size).toBe(2);
});

test("unavailable receipt directory cannot license escalation", () => {
  const f = fixture("true"); f.job.phase = "running"; f.job.pending = ["one", "two", "three"];
  rmdirSync(join(f.root, "receipts"));
  expect(() => commandWake(f.job, f.root, 110)).toThrow();
  expect(f.job.escalated).toBeUndefined();
  expect(f.job.pending).toHaveLength(3);
});


test("refused sends escalate as undeliverable, never as missing seat acknowledgement", () => {
  const f = fixture("true"), rows = JSON.parse(readFileSync(f.state, "utf8"));
  rows.test.job.phase = "running"; writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  standInCourier(scripts, 'cat "$2" >> "$(dirname "$0")/sent"\necho recipient-suspended >&2\nexit 1\n');
  for (const tick of [101, 102, 103, 104]) fire(f.state, scripts, "100", tick);
  expect(f.row().job.pending).toEqual([]);
  expect(f.row().job.undeliverable).toBe(3);
  expect(readFileSync(join(scripts, "sent"), "utf8")).toContain("0 unacknowledged, 3 undeliverable");
  expect(readFileSync(join(scripts, "sent"), "utf8")).toContain("recipient-suspended");
});

test("lost custody persists UNOBSERVABLE through queue fire and list", async () => {
  const { listText } = await import("../src/remind");
  for (const phase of ["starting", "running"]) {
    const f = fixture("true"), rows = JSON.parse(readFileSync(f.state, "utf8"));
    rows.test.job.phase = phase; writeFileSync(f.state, JSON.stringify(rows));
    writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
    const scripts = join(f.root, "scripts"); mkdirSync(scripts);
    standInCourier(scripts, 'cat "$2" > "$(dirname "$0")/sent"\nprintf "{}"\n');
    fire(f.state, scripts, "100", 281);
    expect(JSON.parse(listText(f.state, true))[0].job.phase).toBe("UNOBSERVABLE");
    expect(readFileSync(join(scripts, "sent"), "utf8")).toContain("custodian observation lost");
    expect(f.row().status).toBe("accepted");
  }
});

test("decoded invalid UTF-8 and a split multibyte tail stay within the persisted byte bound", async () => {
  for (const bytes of [Buffer.alloc(8192, 0xff), Buffer.from("€".repeat(3000))]) {
    const f = fixture("cat output.bin"); writeFileSync(join(f.root, "output.bin"), bytes);
    await runCommand(f.state, "test");
    const tail: string = f.row().job.tail;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(8192);
    expect(tail.isWellFormed()).toBe(true);
    expect(tail.endsWith(bytes[0] === 0xff ? "�" : "€")).toBe(true);
  }
});

test("a refused terminal send to the original seat still delivers fallback once", () => {
  const f = fixture("true"), rows = JSON.parse(readFileSync(f.state, "utf8"));
  rows.test.job.phase = "done"; rows.test.job.escalated = true;
  writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  standInCourier(scripts, 'printf "%s\\n" "$1" >> "$(dirname "$0")/targets"\nif [ "$1" = owner ]; then echo recipient-gone >&2; exit 3; fi\ncat "$2" > "$(dirname "$0")/fallback"\nprintf "{}"\n');
  fire(f.state, scripts, "100", 101);
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nleader\n");
  expect(readFileSync(join(scripts, "fallback"), "utf8")).toContain("Command done");
  expect(f.row().job.terminal_deliveries.map((d: { to: string; exit_code: number }) => [d.to, d.exit_code])).toEqual([["owner", 3], ["leader", 0]]);
  expect(f.row().status).toBe("unresolved");
  fire(f.state, scripts, "100", 102);
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nleader\n");
});

test("a spawn error on the original seat's terminal send is recorded, and fallback still delivers once", () => {
  const f = fixture("true"), rows = JSON.parse(readFileSync(f.state, "utf8"));
  rows.test.job.phase = "done"; rows.test.job.escalated = true;
  writeFileSync(f.state, JSON.stringify(rows));
  writeFileSync(join(f.root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  const scripts = join(f.root, "scripts"); mkdirSync(scripts);
  // A stdout flood past spawnSync's maxBuffer makes spawnSync itself return `error` (ENOBUFS) with a
  // null status: the per-target spawn error, with no exit code, that exit 3 above cannot reach.
  standInCourier(scripts, 'printf "%s\\n" "$1" >> "$(dirname "$0")/targets"\nif [ "$1" = owner ]; then head -c 2000000 /dev/zero; exit 0; fi\ncat "$2" > "$(dirname "$0")/fallback"\nprintf "{}"\n');
  // A throw mutant escapes fire(); swallow it so the targets assertion below, not the exception, discriminates.
  try { fire(f.state, scripts, "100", 101); } catch { /* the assertions below own the verdict */ }
  // The targets list is what discriminates a `break` or a throw on the error path; status alone cannot.
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nleader\n");
  expect(readFileSync(join(scripts, "fallback"), "utf8")).toContain("Command done");
  const deliveries = f.row().job.terminal_deliveries as { to: string; exit_code: number; result: string }[];
  expect(deliveries.map(d => [d.to, d.exit_code])).toEqual([["owner", 1], ["leader", 0]]);
  expect(deliveries[0]!.result).toContain("ENOBUFS");
  expect(f.row().status).toBe("unresolved");
  fire(f.state, scripts, "100", 102);
  expect(readFileSync(join(scripts, "targets"), "utf8")).toBe("owner\nleader\n");
});
