import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deenrollTeam, deenrollTeamWithCapture } from "../src/index-home";

// The plain de-enroll writer that replaced lib.sh tap_index_deenroll_team for
// `tap admin retire` and `tap admin refresh`: live-marker only, returns the
// former root, and never resolves a team key through Object.prototype.

function fixture(teams: Record<string, unknown>): { t: string; indexHome: string; gpath: string } {
  const t = mkdtempSync(join(tmpdir(), "admin-deenroll-"));
  const indexHome = join(t, "index");
  mkdirSync(indexHome, { recursive: true });
  const gpath = join(indexHome, "global-registry.json");
  writeFileSync(gpath, `${JSON.stringify({ schema: "0.20", teams, extra: { kept: 1 } }, null, 2)}\n`);
  return { t, indexHome, gpath };
}

test("deenrollTeam removes only the named key and returns its former root", () => {
  const f = fixture({
    alpha: { root: "/r/alpha", registry_location: "/r/alpha/.tap/bus/registry.json", note: "x" },
    beta: { root: "/r/beta", registry_location: "/r/beta/.tap/bus/registry.json" },
  });
  try {
    const done = deenrollTeam("alpha", f.indexHome);
    expect(done).toEqual({ ok: true, root: "/r/alpha" });
    const doc = JSON.parse(readFileSync(f.gpath, "utf8"));
    expect(Object.keys(doc.teams)).toEqual(["beta"]);
    expect(doc.teams.beta.root).toBe("/r/beta");
    expect(doc.schema).toBe("0.20");
    expect(doc.extra).toEqual({ kept: 1 });
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

test("deenrollTeam refuses an unknown or null team as class 2 without writing", () => {
  const f = fixture({ alpha: { root: "/r/alpha" }, nulled: null });
  try {
    const before = readFileSync(f.gpath);
    for (const team of ["no-such-key", "nulled", "constructor", "__proto__", "toString"]) {
      const refused = deenrollTeam(team, f.indexHome);
      expect(refused).toEqual({ ok: false, code: 2, detail: "" });
      // The capture writer shares the own-property lookup.
      const captured = deenrollTeamWithCapture({ team, artifact: join(f.t, "a.json"), expectRoot: "/r", expectRegistry: join(f.t, "gone.json"), indexHome: f.indexHome });
      expect(captured.ok).toBe(false);
      if (!captured.ok) expect(captured.code).toBe(2);
    }
    expect(readFileSync(f.gpath).equals(before)).toBe(true);
    expect(existsSync(join(f.t, "a.json"))).toBe(false);
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

test("deenrollTeam removes an own 'constructor' key that is really enrolled", () => {
  const f = fixture({ constructor: { root: "/r/c" } });
  try {
    expect(deenrollTeam("constructor", f.indexHome)).toEqual({ ok: true, root: "/r/c" });
    expect(Object.hasOwn(JSON.parse(readFileSync(f.gpath, "utf8")).teams, "constructor")).toBe(false);
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

test("deenrollTeam removes a non-object entry and reports an empty root", () => {
  const f = fixture({ odd: "not-an-object", num: 7, rootless: { registry_location: "/x" }, badroot: { root: 5 } });
  try {
    for (const team of ["odd", "num", "rootless", "badroot"]) {
      expect(deenrollTeam(team, f.indexHome)).toEqual({ ok: true, root: "" });
    }
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams).toEqual({});
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

test("deenrollTeam mutates only a live marker: absent and invalid refuse as class 4", () => {
  const t = mkdtempSync(join(tmpdir(), "admin-deenroll-"));
  try {
    const absent = join(t, "absent");
    mkdirSync(absent, { recursive: true });
    // A pre-flip teams.json is never the writer's target any more.
    writeFileSync(join(absent, "teams.json"), `${JSON.stringify({ teams: { alpha: { root: "/r" } } })}\n`);
    const legacyBefore = readFileSync(join(absent, "teams.json"));
    const a = deenrollTeam("alpha", absent);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe(4);
    expect(existsSync(join(absent, "global-registry.json"))).toBe(false);
    expect(readFileSync(join(absent, "teams.json")).equals(legacyBefore)).toBe(true);

    const invalid = join(t, "invalid");
    mkdirSync(invalid, { recursive: true });
    const gpath = join(invalid, "global-registry.json");
    writeFileSync(gpath, `${JSON.stringify({ schema: "0.19", teams: { alpha: { root: "/r" } } })}\n`);
    const before = readFileSync(gpath);
    const i = deenrollTeam("alpha", invalid);
    expect(i.ok).toBe(false);
    if (!i.ok) {
      expect(i.code).toBe(4);
      expect(i.detail).toContain("unreadable or wrong schema");
    }
    expect(readFileSync(gpath).equals(before)).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("an unopenable index lock is a typed failure, not a throw, and leaves the index intact", () => {
  // A DIRECTORY at the lock path cannot be opened read-write by anyone, root
  // included (EISDIR), unlike a chmod-ed parent, which root writes through.
  const f = fixture({ alpha: { root: "/r/alpha" } });
  try {
    const before = readFileSync(f.gpath);
    mkdirSync(join(f.indexHome, "teams.json.lock"));
    const refused = deenrollTeam("alpha", f.indexHome);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe(1);
      expect(refused.detail).toContain("could not be opened");
    }
    // The capture writer's acting-registry sidecar lock refuses as 3.
    const sidecarDir = join(f.t, "bus");
    mkdirSync(join(sidecarDir, "registry.json.lock"), { recursive: true });
    const captured = deenrollTeamWithCapture({ team: "alpha", artifact: join(f.t, "a.json"), expectRoot: "/r/alpha", expectRegistry: join(sidecarDir, "registry.json"), indexHome: f.indexHome });
    expect(captured.ok).toBe(false);
    if (!captured.ok) {
      expect(captured.code).toBe(3);
      expect(captured.detail).toContain("could not be opened");
    }
    expect(readFileSync(f.gpath).equals(before)).toBe(true);
    expect(existsSync(join(f.t, "a.json"))).toBe(false);
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

test("the plain writer carries no root guard: a present and an absent root are both removed", () => {
  // The retired --if-root-missing arm had no production caller left: doctor's
  // dangling prune rechecks the root under its own lock (doctor.ts), refresh
  // purges root_gone rows it has already observed, and retire removes a live
  // team on purpose. So the plain writer removes regardless of the root.
  const f = fixture({});
  try {
    const present = join(f.t, "present-root");
    mkdirSync(present, { recursive: true });
    const absent = join(f.t, "absent-root");
    writeFileSync(f.gpath, `${JSON.stringify({ schema: "0.20", teams: { live: { root: present }, gone: { root: absent } } }, null, 2)}\n`);
    expect(deenrollTeam("gone", f.indexHome)).toEqual({ ok: true, root: absent });
    expect(deenrollTeam("live", f.indexHome)).toEqual({ ok: true, root: present });
    expect(existsSync(present)).toBe(true);
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams).toEqual({});
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
});

// A second process holds one index lock; the writer must wait for it and must
// take teams.json.lock BEFORE global-registry.json.lock (the H1 enroll order).
function holdLock(f: { t: string; indexHome: string }, which: "legacy" | "global", probeGlobal: boolean): { held: string; probe: string; done: Promise<number> } {
  const held = join(f.t, `${which}.held`);
  const probe = join(f.t, `${which}.probe`);
  const src = join(import.meta.dir, "..", "src");
  const script = `
    const { acquirePathLock } = require(${JSON.stringify(join(src, "panelock.ts"))});
    const { writeFileSync } = require("node:fs");
    const legacy = ${JSON.stringify(join(f.indexHome, "teams.json.lock"))};
    const global = ${JSON.stringify(join(f.indexHome, "global-registry.json.lock"))};
    const lock = acquirePathLock(${which === "legacy" ? "legacy" : "global"}, 5000);
    if (!lock) process.exit(3);
    writeFileSync(${JSON.stringify(held)}, "1");
    Bun.sleepSync(600);
    if (${probeGlobal}) {
      const g = acquirePathLock(global, 0);
      writeFileSync(${JSON.stringify(probe)}, g ? "free" : "busy");
      g?.release();
    }
    Bun.sleepSync(600);
    lock.release();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 10000;
  while (!existsSync(held) && Date.now() < deadline) Bun.sleepSync(20);
  expect(existsSync(held)).toBe(true);
  return { held, probe, done: child.exited };
}

test("the writer waits on a held teams.json.lock without first taking the global lock", async () => {
  const f = fixture({ alpha: { root: "/r/alpha" } });
  try {
    const h = holdLock(f, "legacy", true);
    const started = Date.now();
    expect(deenrollTeam("alpha", f.indexHome)).toEqual({ ok: true, root: "/r/alpha" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await h.done).toBe(0);
    // While the writer was blocked on teams.json.lock, the global lock stayed free.
    expect(readFileSync(h.probe, "utf8")).toBe("free");
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams).toEqual({});
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
}, 20000);

test("the writer waits on a held global-registry.json.lock and then publishes", async () => {
  const f = fixture({ alpha: { root: "/r/alpha" }, beta: { root: "/r/beta" } });
  try {
    const h = holdLock(f, "global", false);
    const started = Date.now();
    expect(deenrollTeam("alpha", f.indexHome)).toEqual({ ok: true, root: "/r/alpha" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await h.done).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(f.gpath, "utf8")).teams)).toEqual(["beta"]);
  } finally {
    rmSync(f.t, { recursive: true, force: true });
  }
}, 20000);

test("deenrollTeam with an expectation refuses an entry re-pointed since inspection (class 6) and writes nothing", () => {
  const { t, indexHome, gpath } = fixture({ a: { root: "/r/a", registry_location: "/r/a/reg2.json" } });
  try {
    const before = readFileSync(gpath, "utf8");
    const result = deenrollTeam("a", indexHome, { root: "/r/a", registryLocation: "/r/a/reg1.json" });
    expect(result).toMatchObject({ ok: false, code: 6 });
    expect(readFileSync(gpath, "utf8")).toBe(before);
    expect(deenrollTeam("a", indexHome, { root: "/r/a", registryLocation: "/r/a/reg2.json" })).toEqual({ ok: true, root: "/r/a" });
  } finally { rmSync(t, { recursive: true, force: true }); }
});
