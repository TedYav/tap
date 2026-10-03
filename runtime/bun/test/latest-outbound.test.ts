import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("one batched scan reads every candidate once across eleven seats", async () => {
  const work = fs.mkdtempSync(join(tmpdir(), "tap-read-once-"));
  const payloads = join(work, "payloads"), spool = join(work, "spool");
  fs.mkdirSync(payloads); fs.mkdirSync(spool);
  const paths = new Set<string>();
  for (let i = 0; i < 33; i++) {
    const path = join(i % 2 ? spool : payloads, `message-${i}.md`);
    fs.writeFileSync(path, `---\nfrom: seat-${i % 11}\nfrom_team: local\n---\n`);
    paths.add(path);
  }
  const reads = new Map<string, number>();
  const realRead = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) => {
    const key = String(path);
    if (paths.has(key)) reads.set(key, (reads.get(key) ?? 0) + 1);
    return (realRead as any)(path, ...args);
  }) as any);
  try {
    // Dynamic import ensures the module binds the instrumented fs export.
    const { latestOutbound } = await import("../src/latest-outbound");
    const batch = latestOutbound(payloads, spool, "local", 1700000000);
    expect(Object.keys(batch)).toHaveLength(11);
    expect(reads.size).toBe(paths.size);
    for (const path of paths) expect(reads.get(path)).toBe(1);
  } finally {
    spy.mockRestore();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Ported from skills/tap/scripts/smoke/context-batch-parity.test.sh (deleted):
// the malformed-control matrix is built and scored by the frozen legacy Python
// oracle (latest-outbound-parity.py) so the parity property stays independent
// of the module under test; this guard asserts latestOutbound's batch equals
// that oracle seat-by-seat, over every clock and missing-directory case.
test("outbound batch equals the legacy per-seat oracle on the malformed-control matrix", async () => {
  const work = fs.mkdtempSync(join(tmpdir(), "tap-context-parity-"));
  const { latestOutbound } = await import("../src/latest-outbound");
  try {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const script = join(import.meta.dir, "latest-outbound-parity.py");
    const proc = Bun.spawnSync(["python3", "-B", script, work], {
      env: { ...process.env, TAP_REPO_ROOT: repoRoot }, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    const document = JSON.parse(proc.stdout.toString()) as {
      seats: string[];
      cases: { payloads: string; spool: string; clock: number; expected: Record<string, [number, string]> }[];
    };
    // Compare the in-process record directly instead of round-tripping the
    // batch through JSON like the deleted smoke did with its serialization;
    // hazard rows ("__proto__", "constructor") stay own data properties of the
    // null-prototype record. Fold -0 onto 0: toEqual distinguishes -0 from 0,
    // and the deleted smoke compared the JSON/PYOUT text, where they are one
    // value.
    const rowOf = (batch: ReturnType<typeof latestOutbound>, seat: string) => {
      const row = Object.hasOwn(batch, seat) ? batch[seat]! : { epoch: 0, id: "" };
      return { epoch: row.epoch === 0 ? 0 : row.epoch, id: row.id };
    };
    for (const kase of document.cases) {
      const batch = latestOutbound(kase.payloads, kase.spool, "local", kase.clock);
      expect(Object.keys(batch).filter((seat) => !document.seats.includes(seat))).toEqual([]);
      for (const seat of document.seats) {
        const [epoch, id] = kase.expected[seat]!;
        expect([kase.clock, seat, rowOf(batch, seat)]).toEqual([kase.clock, seat, { epoch, id }]);
      }
    }
    const main = document.cases[0]!;
    const batch = latestOutbound(main.payloads, main.spool, "local", main.clock);
    expect(rowOf(batch, "unicode").id).toBe("tie-\u{10000}");
    expect(rowOf(batch, "seconds").id).toBe("z-first");
    expect(rowOf(batch, "clamped-tie")).toEqual({ epoch: 1700000000, id: "b-future" });
    expect(rowOf(batch, "id-mismatch").id).toBe("filename-id");
    expect(rowOf(batch, "negative-fraction")).toEqual({ epoch: 0, id: "negative-fraction" });
    } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
