import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bus } from "../src/bus";
import type { Context } from "../src/context";
import { envelopeField, stampEnvelope, validateEnvelope } from "../src/envelope";
import { idAgeSeconds } from "../src/ids";
import { advisoryEligible, overdueInbound } from "../src/overdue";
import { currentInstance } from "../src/registry";
import { removeScratchTree } from "./support/scratch";

const HANDLE = "rcv";
const LIVE = "rcv|live";
const DEAD = "rcv|dead";
const THRESHOLD = 3600;
/** Far enough past wall clock that Date.now() cannot satisfy these ages. */
const NOW = 4_000_000_000;

let root: string;
let bus: Bus;
let registryPath: string;
let ctx: Context;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tap-bun-overdue.")));
  bus = new Bus(join(root, "team", ".tap", "bus"));
  bus.ensureDirs();
  registryPath = join(root, "team", ".tap", "team-registry.json");
  mkdirSync(join(root, "team", ".tap"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    schema: "0.20",
    team: { name: "team", worktree_root: join(root, "team") },
    seats: { [HANDLE]: { status: "active", instance: LIVE } },
  }));
  ctx = { bus, busRule: "env", team: "team", registryPath, root: join(root, "team") };
});

afterEach(() => removeScratchTree(root));

function compactUtc(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function idAt(epoch: number, hex: string, sender = "snd"): string {
  return `${sender}-${compactUtc(epoch)}-${hex}`;
}

function seed(opts: {
  epoch: number;
  hex: string;
  to?: string;
  toTeam?: string;
  instance?: string | null;
  extraHead?: string;
  raw?: string;
  done?: boolean;
  cancelled?: boolean;
}): string {
  const id = idAt(opts.epoch, opts.hex);
  const path = bus.payloadPath(id);
  if (opts.raw !== undefined) {
    writeFileSync(path, opts.raw);
  } else {
    const routing: Parameters<typeof stampEnvelope>[1] = {
      id,
      from: "snd",
      to: opts.to ?? HANDLE,
      kind: "discuss",
      path,
      reply: "expected",
    };
    if (opts.toTeam) routing.to_team = opts.toTeam;
    if (opts.instance !== null && opts.instance !== undefined) {
      routing.recipient_instance = opts.instance;
    } else if (opts.instance === undefined) {
      routing.recipient_instance = LIVE;
    }
    const src = opts.extraHead ? `---\n${opts.extraHead}---\nbody\n` : "---\n---\nbody\n";
    writeFileSync(path, stampEnvelope(src, routing));
  }
  writeFileSync(bus.placedPath(id), "{}\n");
  if (opts.done) writeFileSync(bus.donePath(id), "done\n");
  if (opts.cancelled) writeFileSync(bus.cancelPath(id), "cancelled\n");
  return id;
}

function snapshot(): string {
  const files: string[] = [];
  for (const dir of [bus.payloadsDir, bus.receiptsDir]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const body = readFileSync(p);
      files.push(`${p}\t${body.length}\t${createHash("sha256").update(body).digest("hex")}`);
    }
  }
  const reg = existsSync(registryPath) ? readFileSync(registryPath) : Buffer.from("");
  files.push(`registry\t${reg.length}\t${createHash("sha256").update(reg).digest("hex")}`);
  return files.join("\n");
}

/**
 * Handle-only mutant of the reducer: same scan, no recipient_instance gate.
 * It proves the production instance gate is load-bearing without emitting an
 * unclearable warning for predecessor-bound mail.
 */
function withoutInstanceGate(
  c: Context,
  handle: string,
  thresholdSec: number,
  nowEpoch: number,
): { count: number; oldestSec: number } {
  let count = 0;
  let oldestSec = 0;
  for (const id of c.bus.canonicalIds()) {
    if (c.bus.isDone(id)) continue;
    let raw: string;
    try {
      raw = readFileSync(c.bus.payloadPath(id), "utf8");
    } catch {
      continue;
    }
    if (!validateEnvelope(raw).ok) continue;
    if (envelopeField(raw, "id") !== id) continue;
    if (envelopeField(raw, "to") !== handle) continue;
    const toTeam = envelopeField(raw, "to_team");
    if (toTeam && toTeam !== c.team) continue;
    const age = idAgeSeconds(id, nowEpoch, () => {});
    if (age === null || age < thresholdSec) continue;
    count += 1;
    if (age > oldestSec) oldestSec = age;
  }
  return { count, oldestSec };
}

function captureStderr(fn: () => void): string[] {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return writes;
}

describe("advisoryEligible", () => {
  test("the stateless done tombstone never triggers the verbose pre-dispatch advisory", () => {
    expect(advisoryEligible(["done", "x"], { TAP_VERBOSE: "1" })).toBe(false);
    expect(advisoryEligible(["poll"], {})).toBe(true);
    expect(advisoryEligible(["reply", "x"], { TAP_VERBOSE: "1" })).toBe(true);
  });
});

describe("overdueInbound", () => {
  test("age 3600 counts and 3599 does not (inclusive threshold, injected now)", () => {
    seed({ epoch: NOW - 3600, hex: "aaaaaaaaaaaa" });
    seed({ epoch: NOW - 3599, hex: "bbbbbbbbbbbb" });
    const before = snapshot();
    let result!: ReturnType<typeof overdueInbound>;
    const stderr = captureStderr(() => {
      result = overdueInbound(ctx, HANDLE, THRESHOLD, NOW);
    });
    expect(result).toEqual({ count: 1, oldestSec: 3600, warnings: [] });
    expect(stderr).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  test("injected time is used: a far-future stamp is overdue at injected NOW and young at wall clock", () => {
    const id = seed({ epoch: NOW - 3600, hex: "cccccccccccc" });
    const wall = Math.floor(Date.now() / 1000);
    expect(idAgeSeconds(id, wall, () => {})).toBe(0); // future vs wall clock
    expect(overdueInbound(ctx, HANDLE, THRESHOLD, NOW)).toEqual({ count: 1, oldestSec: 3600, warnings: [] });
    expect(overdueInbound(ctx, HANDLE, THRESHOLD, wall)).toEqual({
      count: 0,
      oldestSec: 0,
      warnings: [`tap: warning: payload id '${id}' is future-stamped (${NOW - 3600 - wall}s ahead of now); treating age as 0\n`],
    });
  });

  test("settled (.done and .cancelled), malformed, foreign-team, and wrong-instance items are excluded", () => {
    seed({ epoch: NOW - 7200, hex: "111111111111", done: true });
    seed({ epoch: NOW - 7200, hex: "222222222222", cancelled: true });
    // Closed frontmatter, missing kind — only validateEnvelope can exclude it
    // (to still reads as rcv, so a to-only filter would count it).
    const malformedId = idAt(NOW - 7200, "333333333333");
    writeFileSync(bus.payloadPath(malformedId),
      `---\nid: ${malformedId}\nfrom: snd\nto: ${HANDLE}\npath: ${bus.payloadPath(malformedId)}\n---\nbody\n`);
    writeFileSync(bus.placedPath(malformedId), "{}\n");
    const mismatchId = idAt(NOW - 7200, "777777777777");
    writeFileSync(bus.payloadPath(mismatchId), stampEnvelope("---\n---\nbody\n", {
      id: idAt(NOW - 7200, "888888888888"),
      from: "snd", to: HANDLE, kind: "discuss",
      path: bus.payloadPath(mismatchId), reply: "expected",
      recipient_instance: LIVE,
    }));
    writeFileSync(bus.placedPath(mismatchId), "{}\n");
    seed({ epoch: NOW - 7200, hex: "999999999999", to: "other" });
    seed({ epoch: NOW - 7200, hex: "444444444444", toTeam: "foreign" });
    seed({ epoch: NOW - 7200, hex: "555555555555", instance: DEAD });
    const live = seed({ epoch: NOW - 7200, hex: "666666666666", instance: LIVE });
    expect(overdueInbound(ctx, HANDLE, THRESHOLD, NOW)).toEqual({ count: 1, oldestSec: 7200, warnings: [] });
    expect(existsSync(bus.payloadPath(live))).toBe(true);
  });

  test("handle-only mutant is RED: it counts the dead-instance orphan poll hides (tap-xxq4)", () => {
    seed({ epoch: NOW - 5000, hex: "deaddeaddead", instance: DEAD });
    const real = overdueInbound(ctx, HANDLE, THRESHOLD, NOW);
    const mutant = withoutInstanceGate(ctx, HANDLE, THRESHOLD, NOW);
    // The mutant answers count=1; the shared dispatcher/poll instance gate
    // answers 0. Do not emit the unclearable warning the mutant would create.
    expect(mutant).toEqual({ count: 1, oldestSec: 5000 });
    expect(real).toEqual({ count: 0, oldestSec: 0, warnings: [] });
    expect(currentInstance(registryPath, HANDLE)).toBe(LIVE);
  });

  test("no bus writes; inert survivors keep their bytes", () => {
    const settled = seed({ epoch: NOW - 9000, hex: "settled00000", done: true });
    const young = seed({ epoch: NOW - 10, hex: "young0000000" });
    const foreign = seed({ epoch: NOW - 9000, hex: "foreign00000", toTeam: "other" });
    const live = seed({ epoch: NOW - 4000, hex: "live00000000" });
    const before = snapshot();
    const result = overdueInbound(ctx, HANDLE, THRESHOLD, NOW);
    expect(result).toEqual({ count: 1, oldestSec: 4000, warnings: [] });
    expect(snapshot()).toBe(before);
    expect(readFileSync(bus.payloadPath(settled), "utf8")).toContain("id: " + settled);
    expect(readFileSync(bus.payloadPath(young), "utf8")).toContain("id: " + young);
    expect(readFileSync(bus.payloadPath(foreign), "utf8")).toContain("to_team: other");
    expect(existsSync(bus.donePath(live))).toBe(false);
    expect(readdirSync(bus.receiptsDir).sort()).toEqual(
      [settled, young, foreign, live].flatMap((id) =>
        id === settled ? [`${id}.done`, `${id}.placed`] : [`${id}.placed`],
      ).sort(),
    );
  });

  test("reducer stays silent and returns a future-stamp warning to its renderer", () => {
    const id = seed({ epoch: NOW + 60, hex: "future000000" });
    const stderr = captureStderr(() => {
      expect(overdueInbound(ctx, HANDLE, THRESHOLD, NOW)).toEqual({
        count: 0,
        oldestSec: 0,
        warnings: [`tap: warning: payload id '${id}' is future-stamped (60s ahead of now); treating age as 0\n`],
      });
    });
    expect(stderr.filter((w) => w.includes("future-stamped"))).toEqual([]);
  });

  test("unbound (no recipient_instance) aged inbound still counts", () => {
    seed({ epoch: NOW - 3600, hex: "unbound000000", instance: null });
    expect(overdueInbound(ctx, HANDLE, THRESHOLD, NOW)).toEqual({ count: 1, oldestSec: 3600, warnings: [] });
  });

  test("oldestSec is the max counted age", () => {
    seed({ epoch: NOW - 3600, hex: "old3600000000" });
    seed({ epoch: NOW - 7200, hex: "old7200000000" });
    expect(overdueInbound(ctx, HANDLE, THRESHOLD, NOW)).toEqual({ count: 2, oldestSec: 7200, warnings: [] });
  });
});
