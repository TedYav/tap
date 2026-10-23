import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const OWNER = join(import.meta.dir, "../src/version-briefing.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "version-brief-"));
  const install = join(root, "installed ' TAP"), home = join(root, "home");
  const state = join(root, "state ' directory", "seen.json");
  const changelog = join(install, "skills/tap/VERSION-BRIEF.md");
  mkdirSync(join(install, "skills/tap/scripts"), { recursive: true });
  mkdirSync(home);
  writeFileSync(changelog, '## TAP v0.230\nwrong version\n## TAP v0.23\n\n One change.\n\n Another change.\n## Older\nnot this\n');
  const env = { ...process.env, HOME: home, TAP_VERSION_SEEN_PATH: state, TAP_VERSION_CHANGELOG_PATH: changelog, TAP_VERSION_RECORD_ONLY: "0" };
  const args = ["--root", install, "--team", "team", "--handle", "seat"];
  const run = (extra: NodeJS.ProcessEnv = {}, argv = args) => {
    const p = Bun.spawnSync([process.execPath, OWNER, ...argv], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const seed = (text = '{"schema_version":1,"seats":{"team/seat":{"last_seen_version":"old"}}}') => {
    mkdirSync(join(root, "state ' directory"), { recursive: true });
    writeFileSync(state, text);
    return text;
  };
  const read = () => readFileSync(state, "utf8");
  const call = `versionBriefing(${JSON.stringify(install)}, "team", "seat");`;
  let serial = 0;
  const child = (source: string) => {
    const path = join(root, `case-${serial++}.ts`);
    writeFileSync(path, source);
    const p = Bun.spawnSync([process.execPath, path], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  return { root, install, home, state, changelog, env, args, run, seed, read, child, call };
}

test("baseline, no-op, visible change, silent recording and changelog fallback", () => {
  const f = fixture();
  try {
    expect(f.run()).toEqual({ code: 0, out: "", err: "" });
    expect(statSync(f.state).mode & 0o777).toBe(0o600);
    const before = f.read(), stamp = statSync(f.state).mtimeMs;
    expect(f.run().out).toBe("");
    expect(f.read()).toBe(before);
    expect(statSync(f.state).mtimeMs).toBe(stamp);
    f.seed();
    expect(f.run()).toEqual({ code: 0, out: "TAP v0.23 — One change. Another change.\n", err: "" });
    expect(f.run().out).toBe("");
    f.seed();
    expect(f.run({ TAP_VERSION_RECORD_ONLY: "1" }).out).toBe("");
    expect(JSON.parse(f.read()).seats["team/seat"].last_seen_version).toBe("0.23");
    f.seed();
    writeFileSync(f.changelog, "## TAP v0.230\nnot this\n");
    expect(f.run().out).toBe("TAP v0.23 — protocol changed from vold to v0.23\n");
    f.seed();
    unlinkSync(f.changelog);
    const missing = f.run();
    expect(missing.out).toContain("protocol changed from vold to v0.23");
    expect(missing.err).toContain("could not read changelog");
    expect(existsSync(join(f.home, ".tap/version-seen.json"))).toBe(false);
  } finally { removeScratchTree(f.root); }
});

test("schema and unknown values survive; invalid state and malformed seats never repair", () => {
  const f = fixture();
  try {
    f.seed('{"extra":9007199254740993,"fraction":1.25,"seats":{"team/seat":{"last_seen_version":"old","extension":9007199254740995},"other/seat":{"last_seen_version":"old","label":"é"}}}');
    expect(f.run().code).toBe(0);
    expect(f.read()).toContain('"extra": 9007199254740993');
    expect(f.read()).toContain('"extension": 9007199254740995');
    expect(f.read()).toContain('"fraction": 1.25');
    expect(f.read()).not.toContain("schema_version");
    expect(JSON.parse(f.read()).seats["other/seat"]).toEqual({ last_seen_version: "old", label: "é" });
    for (const [text, reason] of [
      ['{"schema_version":2,"seats":{}}', "unsupported"],
      ['{"schema_version":1,"seats":[]}', "invalid"],
      ['{"schema_version":"1","seats":{}}', "unreadable"],
      ['[]', "invalid"], ['{', "unreadable"],
      ['{"schema_version":1,"seats":{"team/seat":null}}', "invalid seat"],
    ]) {
      f.seed(text);
      const result = f.run();
      expect(result.code).toBe(0);
      expect(result.err + result.out).toContain(reason!);
      expect(f.read()).toBe(text!);
      expect(f.run({ TAP_VERSION_RECORD_ONLY: "1" }).out).toBe("");
      expect(f.read()).toBe(text!);
    }
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
    writeFileSync(f.state, invalidUtf8);
    expect(f.run().out).toContain("version state unreadable");
    expect(readFileSync(f.state)).toEqual(invalidUtf8);
    const before = f.seed();
    writeFileSync(f.changelog, invalidUtf8);
    expect(f.run().code).toBe(0);
    expect(f.read()).toBe(before);
  } finally { removeScratchTree(f.root); }
});

test("Python sidecar contention is bounded, silent in record-only mode, and retried after release", async () => {
  const f = fixture();
  let holder: Bun.Subprocess<"pipe", "ignore", "pipe"> | undefined;
  try {
    const before = f.seed(), ready = join(f.root, "held");
    holder = Bun.spawn(["python3", "-B", "-c", 'import fcntl,sys\nf=open(sys.argv[1],"a+")\nfcntl.flock(f,fcntl.LOCK_EX)\nopen(sys.argv[2],"w").close()\nsys.stdin.read()\n', `${f.state}.lock`, ready], { env: f.env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const inode = statSync(`${f.state}.lock`).ino;
    const start = Date.now();
    const visible = f.run();
    expect(visible.code).toBe(0);
    expect(visible.out).toContain("protocol update pending (version state unavailable)");
    expect(visible.err).toContain("lock acquisition exceeded one second");
    expect(f.run({ TAP_VERSION_RECORD_ONLY: "1" }).out).toBe("");
    expect(Date.now() - start).toBeLessThan(8000);
    expect(f.read()).toBe(before);
    holder.stdin?.end();
    await holder.exited;
    expect(f.run().out).toContain("One change.");
    expect(statSync(`${f.state}.lock`).ino).toBe(inode);
    expect(f.run().out).toBe("");
  } finally {
    holder?.kill();
    if (holder) await holder.exited;
    removeScratchTree(f.root);
  }
}, 15000);

test("concurrent writers preserve both seats in the one store", async () => {
  const f = fixture();
  try {
    const run = (handle: string) => Bun.spawn([process.execPath, OWNER, ...f.args.slice(0, -1), handle], { env: f.env, stdout: "pipe", stderr: "pipe" });
    const first = run("first"), second = run("second");
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    expect(JSON.parse(f.read()).seats).toEqual({ "team/first": { last_seen_version: "0.23" }, "team/second": { last_seen_version: "0.23" } });
  } finally { removeScratchTree(f.root); }
});

test("unavailable lock leaves state untouched without failing the caller", () => {
  const f = fixture();
  try {
    const before = f.seed();
    mkdirSync(`${f.state}.lock`);
    expect(f.run().out).toContain("version state unavailable");
    const quiet = f.run({ TAP_VERSION_RECORD_ONLY: "1" });
    expect(quiet.code).toBe(0);
    expect(quiet.out).toBe("");
    expect(quiet.err).toContain("could not open lock");
    expect(f.read()).toBe(before);
  } finally { removeScratchTree(f.root); }
});

test("in-process stdout failure and fsync/rename failures preserve retry state", () => {
  const f = fixture();
  try {
    const before = f.seed();
    const returned = join(f.root, "returned");
    const closed = f.child(`import { closeSync, writeFileSync } from "node:fs";\nimport { versionBriefing } from ${JSON.stringify(OWNER)};\ncloseSync(1); ${f.call}\nwriteFileSync(${JSON.stringify(returned)}, "returned");\n`);
    expect(closed.code).toBe(0);
    expect(existsSync(returned)).toBe(true);
    expect(f.read()).toBe(before);
    for (const syscall of ["fsyncSync", "renameSync"]) {
      const failed = f.child(`import * as fs from "node:fs";\nimport { mock } from "bun:test";\nmock.module("node:fs", () => ({ ...fs, ${syscall}() { throw new Error("forced ${syscall} failure"); } }));\nconst { versionBriefing } = await import(${JSON.stringify(OWNER)});\n${f.call}\n`);
      expect(failed.code).toBe(0);
      expect(failed.out).toContain("One change.");
      expect(failed.err).toContain(`forced ${syscall} failure`);
      expect(f.read()).toBe(before);
      expect(readdirSync(join(f.root, "state ' directory")).filter(name => name.startsWith(".version-seen."))).toEqual([]);
    }
    expect(f.run().out).toContain("One change.");
    expect(f.run().out).toBe("");
  } finally { removeScratchTree(f.root); }
});

test("internal grammar and native version authority work without a shell library", () => {
  const f = fixture();
  try {
    expect(f.run({}, ["--team", "team"]).code).toBe(64);
    expect(f.run({}, [...f.args, "--other", "x"]).code).toBe(64);
    expect(f.run({ TAP_VERSION_SEEN_PATH: undefined }).code).toBe(0);
    expect(existsSync(join(f.home, ".tap/version-seen.json"))).toBe(true);
    expect(f.run()).toEqual({ code: 0, out: "", err: "" });
    expect(JSON.parse(f.read()).seats["team/seat"].last_seen_version).toBe("0.23");
  } finally { removeScratchTree(f.root); }
});
