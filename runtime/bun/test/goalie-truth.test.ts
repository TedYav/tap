import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { goalieTick, type GoalieDoors } from "../src/goalie-tick";

const oracle = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/goalie-oracle.json"), "utf8"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-truth-"));
  roots.push(root);
  const c = oracle.cases.find((c: any) => c.case === "fire-rung1" && c.shape === "loop");
  const write = (rel: string, text: string | Buffer) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof text === "string" ? text.replaceAll("<WORK>", root) : text);
  };
  write("bus/goalie/arm.json", c.world.arm);
  write("bus/registry.json", c.world.registry);
  write("ledger.md", c.world.ledger);
  for (const [rel, text] of Object.entries(c.world.files)) write(rel, text as string);
  for (const dir of ["payloads", "spool", "receipts"]) fs.mkdirSync(`${root}/bus/${dir}`, { recursive: true });
  const sends: string[][] = [];
  const doors: GoalieDoors = {
    lib: (_fn, args) => ({ status: 0, stdout: args[0] === "goalie-one" ? "idle-at-prompt" : "unknown", stderr: "" }),
    courier: (argv) => {
      sends.push(argv);
      return { status: 0, stdout: JSON.stringify({ status: "queued", delivery: "spool", id: "wake-1", path: `${root}/bus/payloads/wake-1.md` }), stderr: "" };
    },
    ready: () => ({ status: 0, stdout: "[]", stderr: "" }),
    escalate: () => ({ status: 0, stdout: "", stderr: "" }),
  };
  const run = () => goalieTick({ home: `${root}/bus`, registry: `${root}/bus/registry.json`,
    scriptsDir: path.resolve(import.meta.dir, "../../../skills/tap/scripts"), env: { ...c.env, TAP_GOALIE_READY_CMD: "fixture" }, doors });
  const arm = () => JSON.parse(fs.readFileSync(`${root}/bus/goalie/arm.json`, "utf8"));
  const reply = (dir = "payloads", digest = true) => {
    // The real reply writer hashes only these body bytes, excluding routing.
    const body = "EXCEPTION (b) blocked\nVALID-UNTIL 2026-08-20T05:26:40Z\n";
    const text = "---\nin_reply_to: wake-1\n---\n" + body;
    write(`bus/${dir}/r1.md`, text);
    if (digest) write("bus/receipts/wake-1.done", JSON.stringify({ via: "reply", reply_id: "r1", reply_sha256: createHash("sha256").update(body).digest("hex") }));
    return text;
  };
  return { root, write, run, arm, reply, sends, doors };
}

describe("supervision observation and wake custody", () => {
  for (const [name, bytes] of [
    ["missing", null], ["malformed", "{"], ["wrong shape", "[]"],
    ["missing seats", "{}"], ["invalid seat", '{"seats":{"broken":null}}'],
    ["invalid UTF-8", Buffer.from([0xff])],
  ] as const) {
    test(`registry ${name} is an observer failure, preserving episode and seats`, () => {
      const w = world();
      w.run();
      const prior = w.arm();
      prior.seats = { known: { episode: "retained" } };
      w.write("bus/goalie/arm.json", JSON.stringify(prior));
      if (bytes === null) fs.unlinkSync(`${w.root}/bus/registry.json`);
      else w.write("bus/registry.json", bytes);
      const r = w.run();
      expect(r.stdout).toContain("verdict=unreadable-for-cause");
      expect(r.stdout).toContain("working=?");
      expect(w.arm().wake_id).toBe("wake-1");
      expect(w.arm().seats).toEqual(prior.seats);
      expect(w.sends).toHaveLength(1);
    });
  }
  test("a readable empty census is quiet", () => {
    const w = world();
    w.write("bus/registry.json", '{"seats":{"goalie-one":{"pane":"%1"}}}');
    expect(w.run().stdout).toContain("verdict=quiet");
  });
  test("deadlock -> quiet -> stale retains one ask, its rung, and a late W1 reply", () => {
    const w = world();
    expect(w.run().stdout).toContain("verdict=deadlock");
    const before = w.arm();
    const stale = fs.readFileSync(`${w.root}/stores/s1.jsonl`, "utf8");
    for (let i = 1; i <= 5; i++) w.write(`stores/s${i}.jsonl`, stale.replace("03:36:40", "04:25:40"));
    expect(w.run().stdout).toContain("verdict=quiet");
    for (const key of ["wake_id", "wake_at", "wake_rung", "deadlock_since"]) expect(w.arm()[key]).toEqual(before[key]);
    for (let i = 1; i <= 5; i++) w.write(`stores/s${i}.jsonl`, stale);
    expect(w.run().stdout).toContain("verdict=rung2");
    expect(w.sends.filter(a => a.includes("--expect-reply"))).toHaveLength(1);
    expect(w.sends[1]).toContain("--fyi");
    expect(w.sends[1]).toContain("notice");
    expect(w.sends[1]).toContain("watcher");
    expect(w.arm().wake_id).toBe("wake-1");
    w.reply();
    expect(w.run().stdout).toContain("verdict=answered-exception");
    expect(w.arm().wake_id).toBe("");
    expect(w.arm().exception_tag).toBe("b");
  });
  test("degraded delivery preserves W1 and judge obligations before per-seat reset", () => {
    const w = world(); w.run();
    const prior = w.arm();
    prior.seats = { s1: { request_status: "queued", episode_started_at: 1787190000, verdict_at: 0 } };
    w.write("bus/goalie/arm.json", JSON.stringify(prior));
    expect(w.run().stdout).toContain("verdict=degraded-delivery");
    const after = w.arm();
    for (const key of ["wake_id", "wake_at", "wake_rung", "exception_tag", "exception_until", "seats"]) {
      expect(after[key]).toEqual(prior[key]);
    }
    expect(w.sends).toHaveLength(1);
  });
  for (const literal of [[1, 2], [], 5, "s", null, 0.0]) {
    test(`a malformed seats (${JSON.stringify(literal)}) reads as empty: the tick is not degraded and publishes a mapping`, () => {
      const w = world(); w.run();
      const prior = w.arm();
      prior.seats = literal;
      w.write("bus/goalie/arm.json", JSON.stringify(prior));
      const r = w.run();
      expect(r.stdout).not.toContain("verdict=degraded-delivery");
      const seats = w.arm().seats;
      expect(typeof seats).toBe("object");
      expect(seats).not.toBeNull();
      expect(Array.isArray(seats)).toBe(false);
      expect(Object.keys(seats).length).toBeGreaterThan(0);
    });
  }
  for (const receipt of [true, false]) {
    test(`reply snapshot survives a move after read (receipt=${receipt})`, () => {
      const w = world(); w.run(); w.reply("spool", receipt);
      const spool = `${w.root}/bus/spool/r1.md`, canonical = `${w.root}/bus/payloads/r1.md`;
      const original = fs.readFileSync;
      let reads = 0;
      const spy = spyOn(fs, "readFileSync").mockImplementation(((p: any, ...args: any[]) => {
        const bytes = (original as any)(p, ...args);
        if (p === spool) { reads++; fs.renameSync(spool, canonical); }
        return bytes;
      }) as typeof fs.readFileSync);
      try { expect(w.run().stdout).toContain("verdict=answered-exception"); }
      finally { spy.mockRestore(); }
      expect(reads).toBe(1);
    });
  }
  test("move before spool open resolves the canonical reply", () => {
    const w = world(); w.run(); w.reply("spool");
    const spool = `${w.root}/bus/spool/r1.md`, canonical = `${w.root}/bus/payloads/r1.md`;
    const original = fs.readFileSync;
    let moved = false;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((p: any, ...args: any[]) => {
      if (p === spool && !moved) { moved = true; fs.renameSync(spool, canonical); }
      return (original as any)(p, ...args);
    }) as typeof fs.readFileSync);
    try { expect(w.run().stdout).toContain("verdict=answered-exception"); }
    finally { spy.mockRestore(); }
    expect(moved).toBe(true);
  });
  for (const defect of ["missing body", "wrong digest", "missing digest"]) {
    test(`receipt with ${defect} preserves wake as answered-unreadable`, () => {
      const w = world(); w.run(); w.reply();
      if (defect === "missing body") fs.unlinkSync(`${w.root}/bus/payloads/r1.md`);
      if (defect === "wrong digest") w.write("bus/payloads/r1.md", "---\nin_reply_to: wake-1\n---\nchanged\n");
      if (defect === "missing digest") w.write("bus/receipts/wake-1.done", '{"via":"reply","reply_id":"r1"}');
      expect(w.run().stdout).toContain("verdict=answered-unreadable");
      expect(w.arm().wake_id).toBe("wake-1");
      expect(w.sends).toHaveLength(1);
    });
  }
});
