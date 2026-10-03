import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireResetMutationLock } from "../src/reset";
import { KERNEL_LOCK, kernelLockArgs } from "../src/panelock";

const script = new URL("../src/reset.ts", import.meta.url).pathname;
const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "reset-fence-"));
let sequence = 0;
function fixture() {
  const bus = join(root, String(sequence++));
  mkdirSync(bus);
  const log = join(bus, "ps.calls");
  const bin = join(bus, "bin");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ "$1" = -p ] && [ "$3" = -o ] && [ "$4" = lstart= ]; then printf '%s\\n' "$2" >> '${log}'; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, TAP_BOOT_ID: "boot:100", TAP_SCRATCH_ONLY: "1", PATH: `${bin}:${process.env.PATH}` };
  const run = (mode: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script, mode, bus, ...args], { encoding: "utf8", env: { ...env, ...overrides } });
  const path = join(bus, "reset.fence.json");
  const acquire = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) =>
    run("acquire", ["--owner-pid", String(process.pid), ...args], overrides);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { bus, path, log, env, run, acquire, calls };
}

test("acquire stamps the long-lived owner and preserves the Python record bytes", () => {
  const f = fixture();
  for (const op of ["team-reset", "team-restore"]) {
    const result = f.acquire(["--bundle-id", "café", "--op", op]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const bytes = readFileSync(f.path, "utf8");
    const record = JSON.parse(bytes);
    expect(record.pid).toBe(process.pid);
    expect(record.token).toBe(result.stdout);
    expect(record.token).toMatch(new RegExp(`^${op}-[0-9]{8}T[0-9]{6}Z-${process.pid}-[0-9]+$`));
    expect(record.phase).toBe(op === "team-reset" ? "checkpointing" : "restoring");
    expect(record.owner_start).toMatch(/^[0-9]+$/);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const oracle = spawnSync("python3", ["-c", "import json,sys; print(json.dumps(json.load(sys.stdin), indent=2, sort_keys=True))"], { input: bytes, encoding: "utf8" });
    expect(oracle.status).toBe(0);
    expect(bytes).toBe(oracle.stdout);
    expect(f.calls()).toEqual([String(process.pid)]);
    expect(f.run("release", ["--token", result.stdout]).status).toBe(0);
    writeFileSync(f.log, "");
  }
});

test("live and moved fingerprints decide reclaim; ESRCH never probes the old dead PID", () => {
  const f = fixture();
  const first = f.acquire();
  expect(first.status).toBe(0);
  const original = readFileSync(f.path, "utf8");
  expect(JSON.parse(original).bundle_id).toBeUndefined();
  writeFileSync(f.log, "");
  const refusal = f.acquire();
  expect(refusal.status).toBe(1);
  expect(refusal.stdout).toBe("");
  expect(refusal.stderr).toContain("wait for the reset owner");
  expect(readFileSync(f.path, "utf8")).toBe(original);
  expect(f.calls()).toEqual([String(process.pid), String(process.pid)]);

  const record = JSON.parse(original);
  record.owner_start = String(Number(record.owner_start) - 1);
  writeFileSync(f.path, JSON.stringify(record));
  writeFileSync(f.log, "");
  const recycled = f.acquire();
  expect(recycled.status).toBe(0);
  expect(recycled.stdout).not.toBe(first.stdout);
  expect(f.calls()).toEqual([String(process.pid), String(process.pid)]);

  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(departed.status).toBe(0);
  record.pid = departed.pid;
  writeFileSync(f.path, JSON.stringify(record));
  writeFileSync(f.log, "");
  expect(f.acquire().status).toBe(0);
  expect(f.calls()).toEqual([String(process.pid)]);
  expect(readdirSync(f.bus).filter(name => name.includes(".reclaimed."))).toEqual([]);
});

test("unreadable new-owner identity creates no fence; guard keeps one JSON refusal", () => {
  const f = fixture();
  const refused = f.acquire([], { TAP_BOOT_ID: "", TAP_JSON: "1" });
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stdout).error_class).toBe("fence_identity_unreadable");
  expect(existsSync(f.path)).toBe(false);
  expect(f.acquire(["--op", "bad"]).status).toBe(1);
  expect(existsSync(f.path)).toBe(false);
  writeFileSync(f.path, "{}");
  const guard = f.run("guard", ["--what", "tap command", "--verb", "tap command"], { TAP_JSON: "1" });
  expect(guard.status).toBe(1);
  expect(guard.stderr).toBe("");
  expect(JSON.parse(guard.stdout).error_class).toBe("team_reset_fenced");
  expect(guard.stdout.trim().split("\n")).toHaveLength(1);
});

test("Python nonfinite metadata does not hide a dead owner; nonfinite identity remains unreadable", () => {
  const f = fixture();
  const initial = f.acquire();
  expect(initial.status).toBe(0);
  const record = readFileSync(f.path, "utf8");
  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(departed.status).toBe(0);
  for (const value of ["NaN", "Infinity", "-Infinity"]) {
    const live = record.replace(/\n}\n$/, `,\n  "extra": ${value}\n}\n`);
    expect(live).toContain(`"extra": ${value}`);
    writeFileSync(f.path, live);
    expect(f.run("owner-live").stdout).toBe("live\n");
    expect(f.acquire().status).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe(live);
    writeFileSync(f.path, live.replace(`"pid": ${process.pid}`, `"pid": ${departed.pid}`));
    const read = f.run("read"), owner = f.run("owner-live"), reclaimed = f.acquire();
    expect([read.status, owner.stdout, reclaimed.status]).toEqual([0, "stale\n", 0]);
    for (const field of ["pid", "owner_start"]) {
      const bad = record.replace(new RegExp(`"${field}": [^,\\n]+`), `"${field}": ${value}`);
      writeFileSync(f.path, bad);
      expect(f.run("owner-live").stdout).toBe("live\n");
      expect(f.acquire().status).toBe(1);
      expect(readFileSync(f.path, "utf8")).toBe(bad);
    }
  }
  for (const broken of ["not json", "[]", "null", "1.0", "NaN", "9007199254740993"]) {
    writeFileSync(f.path, broken);
    expect(f.run("read").status).toBe(1);
    expect(f.run("owner-live").stdout).toBe("live\n");
    expect(f.acquire().status).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe(broken);
  }
});

test("phase and release preserve status, unknown fields, and successor ownership", () => {
  const f = fixture();
  const acquired = f.acquire();
  expect(acquired.status).toBe(0);
  const token = acquired.stdout;
  const original = readFileSync(f.path, "utf8");
  expect(f.run("set-phase", ["--phase", "cutting", "--token", "wrong"]).status).toBe(3);
  expect(readFileSync(f.path, "utf8")).toBe(original);
  writeFileSync(f.path, original.replace('"phase": "checkpointing"', '"phase": "checkpointing", "extra": [1.5, 9007199254740993, NaN]'));
  const before = readFileSync(f.path, "utf8");
  const phase = f.run("set-phase", ["--phase", "cutting", "--token", token]);
  expect(phase.status).toBe(0);
  expect(phase.stdout).toBe("");
  const oracle = spawnSync("python3", ["-c", 'import json,sys; r=json.load(sys.stdin); r["phase"]="cutting"; print(json.dumps(r,indent=2,sort_keys=True))'], { input: before, encoding: "utf8" });
  expect(oracle.status).toBe(0);
  expect(readFileSync(f.path, "utf8")).toBe(oracle.stdout);
  // The incumbent Python writer can preserve NaN in unrelated metadata. The
  // token owner must still be able to release the record phase just published.
  expect(f.run("release", ["--token", token]).status).toBe(0);
  for (const [bytes, status, reason] of [
    ['{"token":"other"}', 3, "token mismatch"], ["not json", 4, "record unreadable"],
    ...["{}", "[]", "null", '"x"', '{"token":7}', '{"token":""}'].map(bytes => [bytes, 4, "record incomplete"]),
  ] as [string, number, string][]) {
    writeFileSync(f.path, bytes);
    const result = f.run("release", ["--token", token]);
    expect(result.status).toBe(status);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(reason);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  }
  writeFileSync(f.path, original);
  expect(f.run("release", ["--token", token]).status).toBe(0);
  expect(existsSync(f.path)).toBe(false);
  expect(f.run("release", ["--token", token]).status).toBe(0);
  expect(f.run("set-phase", ["--phase", "cutting", "--token", token]).status).toBe(1);
});

test("generation and field transport preserve canonical numeric factors", () => {
  const f = fixture();
  expect(f.run("stamp-pristine", ["--bundle-id", "bundle"]).status).toBe(0);
  const generation = join(f.bus, "reset-generation.json");
  expect(readFileSync(generation, "utf8")).toBe('{\n  "bundle_id": "bundle",\n  "state": "pristine"\n}\n');
  expect(f.run("mark-reused", ["--why", "first"]).status).toBe(0);
  const reused = readFileSync(generation, "utf8");
  expect(JSON.parse(reused).first_mutation).toBe("first");
  expect(f.run("mark-reused", ["--why", "second"]).status).toBe(0);
  expect(readFileSync(generation, "utf8")).toBe(reused);
  writeFileSync(f.path, '{"pid":99999999.0,"owner_start":0.0,"token":"t"}');
  expect(f.run("read").stdout).toBe("99999999\n\n0\nt\n\n\n");
  writeFileSync(f.path, '{"pid":1.5}');
  expect(f.run("read").stdout).toBe("\n\n\n\n\n\n");
});

async function reached(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`missing handshake ${path}`);
    await Bun.sleep(10);
  }
}

test("acquire announces arrival while the kernel sidecar is held and proceeds only after release", async () => {
  const f = fixture();
  const held = join(f.bus, "held"), go = join(f.bus, "go"), barrier = join(f.bus, "barrier");
  const holder = Bun.spawn([KERNEL_LOCK, ...kernelLockArgs(join(f.bus, "reset.fence.json.lock"), Infinity,
    ["sh", "-c", 'printf 1 > "$1"; while [ ! -f "$2" ]; do sleep 0.01; done', "holder", held, go])], { env: f.env });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await reached(held);
    child = Bun.spawn([process.execPath, script, "acquire", f.bus, "--owner-pid", String(process.pid)],
      { env: { ...f.env, TAP_RESET_FENCE_TEST_BARRIER: barrier }, stdout: "pipe", stderr: "pipe" });
    await reached(`${barrier}.pre-fence-acquire.reached`);
    expect(existsSync(f.path)).toBe(false);
    writeFileSync(go, "1");
    expect(await holder.exited).toBe(0);
    expect(await child.exited).toBe(0);
    expect(existsSync(f.path)).toBe(true);
  } finally {
    writeFileSync(go, "1");
    holder.kill();
    child?.kill();
    await holder.exited;
    if (child) await child.exited;
  }
}, 10000);

async function marker(path: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path), path).toBe(true);
}

test("reset drains shared admission before fencing and then refuses new mail", async () => {
  const f = fixture(), barrier = join(f.bus, "admission");
  const mail = acquireResetMutationLock(f.bus, "first mail", 0, "shared");
  const child = Bun.spawn([process.execPath, script, "acquire", f.bus, "--owner-pid", String(process.pid)], {
    env: { ...f.env, TAP_RESET_FENCE_TEST_BARRIER: barrier }, stdout: "pipe", stderr: "pipe",
  });
  try {
    await marker(`${barrier}.pre-fence-acquire.reached`, child);
    expect(existsSync(f.path)).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally { mail.release(); }
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  expect(await child.exited, await error).toBe(0);
  const token = await output;
  try {
    expect(() => acquireResetMutationLock(f.bus, "late mail", 0, "shared")).toThrow("mid-reset");
  } finally { expect(f.run("release", ["--token", token]).status).toBe(0); }
}, 20_000);

for (const replacing of [false, true]) test(`crash before fence publication exposes no partial record (replace=${replacing})`, async () => {
  const f = fixture(), barrier = join(f.bus, "publish");
  const token = replacing ? f.acquire().stdout : "";
  const original = replacing ? readFileSync(f.path, "utf8") : null;
  const args = replacing ? ["set-phase", f.bus, "--phase", "cutting", "--token", token]
    : ["acquire", f.bus, "--owner-pid", String(process.pid)];
  const child = Bun.spawn([process.execPath, script, ...args], { env: { ...f.env,
    TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_RESET_FENCE_TEST_PAUSE_PUBLISH: "1" }, stdout: "pipe", stderr: "pipe" });
  try {
    await marker(`${barrier}.fence-before-publish.reached`, child);
    if (replacing) expect(readFileSync(f.path, "utf8")).toBe(original!);
    else expect(existsSync(f.path)).toBe(false);
    const staged = readdirSync(join(f.bus, "tmp")).filter(name => name.startsWith(".tap-fence."));
    expect(staged).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.bus, "tmp", staged[0]!), "utf8")).token).toBeTruthy();
    expect(readdirSync(f.bus).some(name => name.startsWith(".tap-fence."))).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; }
  if (replacing) expect(f.run("release", ["--token", token]).status).toBe(0);
  const next = f.acquire();
  expect(next.status, next.stderr).toBe(0);
  expect(f.run("release", ["--token", next.stdout]).status).toBe(0);
}, 20_000);

test("a stalled process-start observation has a deadline and publishes no fence", () => {
  const f = fixture();
  writeFileSync(join(f.bus, "bin", "ps"), "#!/bin/sh\nexec sleep 30\n", {mode:0o755});
  const start = Date.now(), result = f.acquire();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("owner_start unreadable");
  expect(Date.now() - start).toBeLessThan(5000);
  expect(existsSync(f.path)).toBe(false);
}, 10_000);

// The acquire-door and producer arms of the retired action-text smoke
// (skills/tap/scripts/smoke/reset-fence-action-text.test.sh): they drove the
// internal `reset.ts acquire` CLI because no public verb reaches the
// acquire-level verdict — `tap team reset` masks it one word earlier. Ported
// verbatim; the smoke's both-door poll text arms are pinned in
// reset-fence-unowned.test.ts (the dead-owner retry advice landed with the
// file's deletion).
describe("planted-fence acquire verdicts and the proc-start-epoch producer", () => {
  // The planted owner is this test process (alive); the acquirer runs as pid 1
  // exactly as the smoke's acquire ran as its own subshell child, so a reclaim
  // provably names a DIFFERENT owner than the planted one.
  const acquirer = (f: ReturnType<typeof fixture>, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) =>
    f.run("acquire", ["--owner-pid", "1", ...args], overrides);
  const plant = (f: ReturnType<typeof fixture>, fields: Record<string, unknown>) => {
    const bytes = JSON.stringify({ op: "team-reset", pid: process.pid, started_at: "2026-09-24T00:00:00Z",
      token: "t", boot_id: "boot:100", phase: "checkpointing", ...fields }, null, 2) + "\n";
    writeFileSync(f.path, bytes);
    return bytes;
  };
  const plantRaw = (f: ReturnType<typeof fixture>, bytes: string) => { writeFileSync(f.path, bytes); return bytes; };
  const liveStart = (f: ReturnType<typeof fixture>) => {
    const first = f.acquire();
    expect(first.status, first.stderr).toBe(0);
    return String(JSON.parse(readFileSync(f.path, "utf8")).owner_start);
  };
  const expectRefusal = (label: string, r: { status: number | null; stderr: string }) => {
    expect(r.status, label).toBe(1);
    expect(r.stderr, label).toContain("refusing reset — fence held by live/unreadable-identity owner");
    expect(r.stderr, label).not.toMatch(/Traceback|OverflowError/);
  };
  const CUR_23 = "bootuuid:11111111-1111-4111-8111-111111111111";
  const LEGACY = "boot:1785910738";

  test("(6e-match) a live owner on the matching boot refuses; the fence stays byte-identical", () => {
    const f = fixture();
    const start = liveStart(f);
    const bytes = plant(f, { owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-6e"], { TAP_BOOT_ID_LEGACY: "not-a-boot-stamp" });
    expectRefusal("(6e-match)", r);
    expect(r.stderr).toContain(`owner pid ${process.pid}`);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(6e-unknown) a live owner with an unresolvable boot relation refuses fail-closed", () => {
    const f = fixture();
    const start = liveStart(f);
    const bytes = plant(f, { boot_id: "boot:1", owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-6e"], { TAP_BOOT_ID_LEGACY: "not-a-boot-stamp" });
    expectRefusal("(6e-unknown)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(6e-mismatch) the same fence reclaims once the legacy oracle proves a prior boot", () => {
    const f = fixture();
    const start = liveStart(f);
    plant(f, { boot_id: "boot:1", owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-6e"], { TAP_BOOT_ID_LEGACY: LEGACY });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe("");
    const rec = JSON.parse(readFileSync(f.path, "utf8"));
    expect(rec.token).toBe(r.stdout);
    expect(rec.pid).not.toBe(process.pid);
  });

  test("(6e-badpid) a pid that is not a pid refuses as a verdict, not a crash", () => {
    const f = fixture();
    liveStart(f);
    const bytes = plantRaw(f, `{"op":"team-reset","pid":"garbage","boot_id":"boot:100","owner_start":1}\n`);
    const r = acquirer(f);
    expectRefusal("(6e-badpid)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(jm19m) an owner pid that is not a positive integer is LIVE, never reclaimable", () => {
    for (const pid of [0, "0", -1]) {
      const f = fixture();
      plant(f, { pid, owner_start: "1" });
      // BOTH boot oracles are pinned, in the child's env, to a readable boot
      // that MISMATCHES the planted boot:100. A pid that slipped past the
      // shape gate would read PROVED STALE here, so the runner's ambient boot
      // can no longer decide the row — only the pid gate keeps it LIVE.
      const r = f.run("owner-live", [], { TAP_BOOT_ID: "boot:200", TAP_BOOT_ID_LEGACY: "boot:200" });
      expect(r.stdout, `pid ${JSON.stringify(pid)} must read LIVE`).toBe("live\n");
    }
  });

  test("(6e-badstamp) an unparseable boot stamp is UNKNOWN, not a proved prior boot", () => {
    for (const bad of ["garbage", "bootuuid:-0000000-0000-0000-0000-000000000000"]) {
      const f = fixture();
      const start = liveStart(f);
      const bytes = plant(f, { boot_id: bad, owner_start: start });
      // UUID-shaped current identity: with the fixture's legacy-shaped
      // boot:100 the legacy fallback resolves these rows UNKNOWN even without
      // the readable-stamp guard, and the assertion would pin nothing. (The
      // removed smoke used the same discriminator.)
      const r = acquirer(f, ["--bundle-id", "bundle-6e"], { TAP_BOOT_ID: CUR_23, TAP_BOOT_ID_LEGACY: "not-a-boot-stamp" });
      expectRefusal(`(6e-badstamp) ${bad}`, r);
      expect(readFileSync(f.path, "utf8")).toBe(bytes);
    }
  });

  const paddedPs = `#!/bin/sh\nif [ "$1" = -p ] && [ "$3" = -o ] && [ "$4" = lstart= ]; then printf 'Sat Aug  5 10:00:00 2026\\n'; exit 0; fi\nexec /bin/ps "$@"\n`;

  test("(7) the padded %e day parses to exactly one epoch in the producer", () => {
    const f = fixture();
    writeFileSync(join(f.bus, "bin", "ps"), paddedPs, { mode: 0o755 });
    const r = f.run("proc-start-epoch", ["--owner-pid", String(process.pid)]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("1785924000");
  });

  test("(7c) the acquire door parses the padded day too: a match refuses, one second off reclaims", () => {
    const f = fixture();
    writeFileSync(join(f.bus, "bin", "ps"), paddedPs, { mode: 0o755 });
    plant(f, { owner_start: 1785924000 });
    expectRefusal("(7c) match", acquirer(f, ["--bundle-id", "bundle-7c"]));
    plant(f, { owner_start: 1785924001 });
    const moved = acquirer(f, ["--bundle-id", "bundle-7c"]);
    expect(moved.status, moved.stderr).toBe(0);
  });

  test("(21)(22) owner_start JSON-number shapes decide the acquire verdict", () => {
    const f = fixture();
    const start = liveStart(f);
    // [raw owner_start JSON, expected verdict]; "refuse" rows must also leave
    // the fence byte-identical. Matching rows are (21); the rest are the (22)
    // matrix, acquire path only.
    const rows: [string, "refuse" | "reclaim"][] = [
      [`${start}`, "refuse"],
      [`${Number(start) + 1}`, "reclaim"],
      [`${Number(start) + 1}.0`, "reclaim"],
      ["0", "reclaim"],
      [`${start}.0`, "refuse"],
      ["-1", "refuse"],
      ["1.5", "refuse"],
      [`"garbage"`, "refuse"],
    ];
    for (const [raw, want] of rows) {
      const bytes = plantRaw(f, `{"op":"team-reset","pid":${process.pid},"boot_id":"boot:100","owner_start":${raw}}\n`);
      const r = acquirer(f, ["--bundle-id", "bundle-22"]);
      if (want === "reclaim") expect(r.status, `owner_start ${raw}: ${r.stderr}`).toBe(0);
      else {
        expect(r.status, `owner_start ${raw}`).toBe(1);
        expect(r.stderr, `owner_start ${raw}`).toContain("refusing reset");
        expect(r.stderr, `owner_start ${raw}`).not.toMatch(/Traceback|OverflowError/);
        expect(readFileSync(f.path, "utf8"), `owner_start ${raw}`).toBe(bytes);
      }
    }
  });

  test("(23a) an owner_start of 400 digits is unreadable rather than a fingerprint that moved", () => {
    const f = fixture();
    liveStart(f);
    const bytes = plantRaw(f, `{"op":"team-reset","pid":${process.pid},"boot_id":"boot:100","owner_start":${"9".repeat(400)}}\n`);
    const r = acquirer(f, ["--bundle-id", "bundle-23a"]);
    expectRefusal("(23a)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(23b) a legacy boot stamp of 400 digits is UNKNOWN, so it cannot authorize a reclaim", () => {
    const f = fixture();
    const start = liveStart(f);
    const bytes = plant(f, { boot_id: `boot:${"9".repeat(400)}`, owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-23b"], { TAP_BOOT_ID: CUR_23, TAP_BOOT_ID_LEGACY: LEGACY });
    expectRefusal("(23b)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(24b)(24d) leading-zero legacy boot stamps are UNKNOWN on both window sides", () => {
    for (const [boot, label] of [["boot:01785910738", "(24b) same number"], ["boot:01785910000", "(24d) outside window"]] as [string, string][]) {
      const f = fixture();
      const start = liveStart(f);
      const bytes = plant(f, { boot_id: boot, owner_start: start });
      const r = acquirer(f, ["--bundle-id", "bundle-24"], { TAP_BOOT_ID: CUR_23, TAP_BOOT_ID_LEGACY: LEGACY });
      expectRefusal(label, r);
      expect(readFileSync(f.path, "utf8")).toBe(bytes);
    }
  });

  test("(25a) a pid outside any platform range is unreadable and refuses with a verdict", () => {
    const f = fixture();
    liveStart(f);
    const bytes = plantRaw(f, `{"op":"team-reset","pid":${"9".repeat(400)},"boot_id":"boot:100","owner_start":1}\n`);
    const r = acquirer(f, ["--bundle-id", "bundle-25a"]);
    expectRefusal("(25a)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(25b) the pid edge is the process API range: INT32_MAX reclaims, one past refuses", () => {
    const f = fixture();
    const start = liveStart(f);
    plant(f, { pid: 2147483647, owner_start: start });
    const probed = acquirer(f, ["--bundle-id", "bundle-25b"]);
    expect(probed.status, probed.stderr).toBe(0);
    const bytes = plant(f, { pid: 2147483648, owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-25b"]);
    expectRefusal("(25b) out of range", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(26a) an unvalidated leading-zero ORACLE cannot authorize a reclaim", () => {
    const f = fixture();
    const start = liveStart(f);
    const bytes = plant(f, { boot_id: LEGACY, owner_start: start });
    const r = acquirer(f, ["--bundle-id", "bundle-26a"], { TAP_BOOT_ID: CUR_23, TAP_BOOT_ID_LEGACY: "boot:01785910000" });
    expectRefusal("(26a)", r);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("(15b) the recorded epoch is writer-timezone-free while real renderings differ", () => {
    const f = fixture();
    const epoch = (tz: string) => {
      const r = f.run("proc-start-epoch", ["--owner-pid", String(process.pid)], { TZ: tz });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    const utc = epoch("UTC"), la = epoch("America/Los_Angeles"), tk = epoch("Asia/Tokyo");
    expect(utc).not.toBe("");
    expect(new Set([utc, la, tk]).size, `utc=${utc} la=${la} tk=${tk}`).toBe(1);
    const render = (tz: string) =>
      spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: tz } }).stdout.trim();
    expect(render("UTC")).not.toBe(render("Asia/Tokyo"));
  });
});
