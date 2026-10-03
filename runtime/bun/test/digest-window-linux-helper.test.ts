// The Linux arm of `acquireNoFollowLock` locks the inherited descriptor by
// running the transport's PINNED helper (`KERNEL_LOCK`, `/usr/bin/flock`).
// It must never be a PATH lookup: exit 0 from the helper is taken as proof
// that fd 3 is locked, so a PATH program that exits 0 without locking would
// let the update write through a real holder. The arm is
// selected by `process.platform`, so a child process pins that to "linux"
// before the module loads — on Darwin the pinned helper is absent and the
// refusal is the execution-failure path; on Linux the real helper runs and
// reports the holder. One arm, no platform skip (the suite runner reds any
// undeclared `(skip)` row): each host exercises its own refusal path and both
// assert the same three things plus the descriptor accounting.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePathLock } from "../src/panelock";

const PINNED = "/usr/bin/flock";
const ORIGINAL = "[delivery]\nnow_window_seconds = 10\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

interface Outcome { ok: boolean; message?: string; fdBefore: number; fdAfter: number }
/** Run one `updateConfig` under the Linux arm in a child; `fdBefore/fdAfter` are the lowest free descriptor around the call. */
function linuxArm(root: string, cfg: string, pathPrefix?: string): Outcome {
  const entry = join(root, "entry.ts");
  fs.writeFileSync(entry, [
    `Object.defineProperty(process, "platform", { value: "linux" });`,
    `import * as fs from "node:fs";`,
    `const { updateConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/digest-window.ts"))});`,
    `const lowestFree = () => { const f = fs.openSync("/dev/null", "r"); fs.closeSync(f); return f; };`,
    `const out = { fdBefore: lowestFree() };`,
    `try { updateConfig(${JSON.stringify(cfg)}, "tap/peer", 600, true, process.env, 100); Object.assign(out, { ok: true }); }`,
    `catch (e) { Object.assign(out, { ok: false, message: e.message }); }`,
    `console.log(JSON.stringify({ ...out, fdAfter: lowestFree() }));`,
  ].join("\n"));
  const env = { PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "cfg") };
  const r = Bun.spawnSync(["bun", entry], { env, stdout: "pipe", stderr: "pipe" });
  expect({ rc: r.exitCode, err: r.stderr.toString() }).toEqual({ rc: 0, err: "" });
  return JSON.parse(r.stdout.toString()) as Outcome;
}
function seed(): { root: string; cfg: string } {
  const root = fs.mkdtempSync(join(tmpdir(), "dw-linux-")); roots.push(root);
  const cfg = join(root, "cfg", "tap", "config.toml");
  fs.mkdirSync(join(root, "cfg", "tap"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfg, ORIGINAL); fs.chmodSync(cfg, 0o600);
  return { root, cfg };
}

test("impostor: a PATH `flock` that exits 0 without locking is never run, and a real holder of the lock still refuses the update", () => {
  const { root, cfg } = seed();
  const bin = join(root, "bin"); fs.mkdirSync(bin);
  const marker = join(root, "impostor-ran");
  fs.writeFileSync(join(bin, "flock"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o700 });
  const holder = acquirePathLock(`${cfg}.lock`, 5000, { PATH: process.env.PATH, HOME: root });
  expect(holder).not.toBeNull();
  try {
    const out = linuxArm(root, cfg, bin);
    expect(out.ok).toBe(false);
    // Linux: the pinned helper reports the holder within the 100 ms bound. Darwin: the pinned helper does not exist.
    expect(out.message).toBe(fs.existsSync(PINNED) ? "config lock busy; retry" : `config lock: ${PINNED} could not run: ENOENT`);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(cfg, "utf8")).toBe(ORIGINAL);
    // The no-follow open's descriptor was closed on every refusal path — Linux: once per contention
    // try until the bound; Darwin: on the helper's execution failure — never leaked: the lowest free
    // descriptor is the same number after the call as before it.
    expect(out.fdAfter).toBe(out.fdBefore);
  } finally { holder!.release(); }
});
