import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, effects, listed, main, parse, streamUpdates, type Run } from "../src/debug";
import { StreamSet } from "../src/debug-streams";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-streams-"));
  const path = join(root, "registry-events.log"), positions = new Map();
  const rewrite = (lines: string[]) => {
    writeFileSync(join(root, "replacement"), lines.join("\n") + "\n");
    renameSync(join(root, "replacement"), path);
  };
  return { root, path, positions, rewrite };
}

test("bounded rewrites emit only appended lines, including a legitimate identical consecutive line", () => {
  const f = fixture();
  try {
    f.rewrite(["a", "b"]);
    expect(streamUpdates(f.path, f.positions, false).lines).toEqual(["a", "b"]);
    f.rewrite(["a", "b", "b"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: ["b"], gap: false });
    f.rewrite(["b", "b", "c"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({
      lines: [], gap: true, reason: "bounded_log_rewritten_ambiguous",
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("initial EOF retains a bounded log anchor and a rolling 200-line window emits one new line", () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 200 }, (_, i) => `event ${i}`);
    f.rewrite(lines);
    expect(streamUpdates(f.path, f.positions, true)).toEqual({ lines: [], gap: false });
    f.rewrite([...lines.slice(1), "event 200"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: ["event 200"], gap: false });
    appendFileSync(f.path, "partial");
    expect(streamUpdates(f.path, f.positions, false).lines).toEqual([]);
    appendFileSync(f.path, " completed\n");
    expect(streamUpdates(f.path, f.positions, false).lines).toEqual(["partial completed"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a single overlapping line can anchor a distinct appended tail", () => {
  const f = fixture();
  try {
    f.rewrite(["a", "b"]); streamUpdates(f.path, f.positions, true);
    f.rewrite(["b", "c"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: ["c"], gap: false });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a registry retention limit above 200 still emits new records after an interior anchor", () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 1000 }, (_, i) => `event ${i}`);
    f.rewrite(lines); streamUpdates(f.path, f.positions, true);
    f.rewrite([...lines.slice(1), "event 1000"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: ["event 1000"], gap: false });
    f.rewrite([...lines.slice(2), "event 1000", "event 1000"]);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: ["event 1000"], gap: false });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("repeated interior anchors in a larger registry window remain uncertain", () => {
  const f = fixture();
  try {
    f.rewrite(Array(1000).fill("same")); streamUpdates(f.path, f.positions, true);
    f.rewrite(Array(1000).fill("same"));
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: [], gap: true, reason: "bounded_log_rewritten_ambiguous" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const appends of [1, 2]) test(`an all-identical window cannot prove ${appends} appended records`, () => {
  const f = fixture();
  try {
    const lines = Array(200).fill("same");
    f.rewrite(lines); streamUpdates(f.path, f.positions, true);
    f.rewrite([...lines, ...Array(appends).fill("same")].slice(-200));
    expect(streamUpdates(f.path, f.positions, false)).toEqual({
      lines: [], gap: true, reason: "bounded_log_rewritten_ambiguous",
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("more than a window of turnover emits a gap and resumes from the new boundary", () => {
  const f = fixture();
  try {
    f.rewrite(Array.from({ length: 200 }, (_, i) => `old ${i}`));
    streamUpdates(f.path, f.positions, false);
    const lines = Array.from({ length: 200 }, (_, i) => `new ${i + 201}`);
    f.rewrite(lines);
    expect(streamUpdates(f.path, f.positions, false)).toEqual({
      lines: [], gap: true, reason: "bounded_log_rewritten_no_overlap",
    });
    expect(streamUpdates(f.path, f.positions, false)).toEqual({ lines: [], gap: false });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function busFixture(mode: "best-effort" | "precise" = "best-effort") {
  const f = fixture(), payloads = join(f.root, "payloads"), receipts = join(f.root, "receipts");
  mkdirSync(payloads); mkdirSync(receipts);
  const streams = new StreamSet(f.positions), listings = new Map();
  let stats = 0;
  const stat = ((...args: Parameters<typeof statSync>) => { stats++; return statSync(...args); }) as typeof statSync;
  const sample = (baseline = false, trace?: { id: string; since: number }) => {
    stats = 0;
    const fidelity = trace ? "precise" : mode;
    const selected = streams.select({ [f.root]: "test" }, listings, fidelity, stat, trace);
    const lines: string[] = [];
    for (const path of selected.keys()) {
      lines.push(...streamUpdates(path, f.positions, baseline, fidelity, stat).lines);
    }
    return { selected, lines, stats };
  };
  return { ...f, payloads, receipts, streams, listings, sample };
}

test("trace inventories history once, then stats active and recent streams plus new paths only", () => {
  const f = busFixture(), trace = { id: "first", since: Date.now() - 5000 };
  const cold = join(f.payloads, "cold-0.attempts"), recent = join(f.payloads, "recent.debug.attempts");
  try {
    for (let i = 0; i < 50; i++) {
      const path = join(f.payloads, `cold-${i}.attempts`);
      writeFileSync(path, "old\n"); utimesSync(path, 0, 0);
    }
    writeFileSync(join(f.payloads, "live.md"), "");
    for (const suffix of [".attempts", ".debug.attempts"]) {
      const live = join(f.payloads, "live" + suffix);
      writeFileSync(live, "old\n"); utimesSync(live, 0, 0);
      writeFileSync(join(f.payloads, "recent" + suffix), "recent history\n");
    }
    f.sample(true);
    expect(f.sample(true, trace).stats).toBe(62); // 54 admission stats, then 2 directories + 2 logs + 4 streams
    expect(f.sample(false, trace).stats).toBe(8);
    appendFileSync(cold, "late cold\n"); appendFileSync(recent, "recent late\n");
    appendFileSync(join(f.payloads, "live.attempts"), "live late\n");
    expect(f.sample(false, trace).lines.sort()).toEqual(["live late", "recent late"]);
    writeFileSync(join(f.payloads, "new.debug.attempts"), "new during trace\n");
    const added = f.sample(false, trace);
    expect(added.lines).toEqual(["new during trace"]); expect(added.stats).toBe(10);
    expect(f.sample(false, trace).stats).toBe(9);
    expect(f.sample().stats).toBe(6); expect(f.positions.size).toBe(2);
    const next = { id: "second", since: Date.now() - 5000 };
    expect(f.sample(true, next).lines).toEqual([]);
    appendFileSync(cold, "new window\n");
    expect(f.sample(false, next).lines).toEqual(["new window"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("precise outside a trace resumes exhaustive reads from its retained cursors", () => {
  const f = busFixture("precise"), path = join(f.payloads, "old.attempts");
  const trace = { id: "precise-window", since: Date.now() - 5000 };
  try {
    writeFileSync(path, "history\n"); utimesSync(path, 0, 0);
    f.sample(true); f.sample(true, trace);
    appendFileSync(path, "during bounded trace\n");
    expect(f.sample(false, trace).lines).toEqual([]);
    expect(f.sample().lines).toEqual(["during bounded trace"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("different suffix consumers share a listing without hiding payloads or terminal receipts", () => {
  const f = busFixture();
  try {
    writeFileSync(join(f.payloads, "one.md"), "");
    writeFileSync(join(f.payloads, "one.attempts"), "old\n");
    expect(listed(f.payloads, ".attempts", f.listings)).toEqual([join(f.payloads, "one.attempts")]);
    expect(listed(f.payloads, ".md", f.listings)).toEqual([join(f.payloads, "one.md")]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a bus directory removed between stat and listing does not stop collection", () => {
  const f = busFixture();
  try {
    const stat = ((...args: Parameters<typeof statSync>) => {
      const found = statSync(...args);
      rmSync(f.payloads, { recursive: true });
      return found;
    }) as typeof statSync;
    expect(listed(f.payloads, ".attempts", f.listings, stat)).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ["best-effort", "precise"] as const) test(`${mode} stats only the streams its policy promises`, () => {
  const f = busFixture(mode);
  try {
    for (let i = 0; i < 30; i++) writeFileSync(join(f.payloads, `cold-${i}.attempts`), "history\n");
    for (const suffix of [".attempts", ".debug.attempts"]) writeFileSync(join(f.payloads, "live" + suffix), "history\n");
    writeFileSync(join(f.payloads, "live.md"), "");
    expect(f.sample(true).lines).toEqual([]);
    const sample = f.sample();
    expect(sample.stats).toBe(mode === "precise" ? 36 : 6);
    expect(sample.selected.has(join(f.payloads, "live.debug.attempts"))).toBe(true);
    appendFileSync(join(f.payloads, "cold-29.attempts"), "late cold\n");
    appendFileSync(join(f.payloads, "live.attempts"), "active\n");
    expect(f.sample().lines.sort()).toEqual(mode === "precise" ? ["active", "late cold"] : ["active"]);
    expect(f.positions.size).toBe(mode === "precise" ? 32 : 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const terminal of ["done", "cancelled", "removed"]) test(`${terminal} drains both suffixes then intentionally omits later writes and forgets cursors`, () => {
  const f = busFixture();
  try {
    const paths = [join(f.payloads, "one.attempts"), join(f.payloads, "one.debug.attempts")];
    writeFileSync(join(f.payloads, "one.md"), "");
    for (const path of paths) writeFileSync(path, "history\n");
    f.sample(true);
    if (terminal === "removed") unlinkSync(join(f.payloads, "one.md"));
    else writeFileSync(join(f.receipts, "one." + terminal), "");
    appendFileSync(paths[0]!, "same tick\n");
    expect(f.sample().lines).toEqual(["same tick"]);
    f.sample();
    appendFileSync(paths[1]!, "grace tick\n");
    expect(f.sample().lines).toEqual(["grace tick"]);
    expect(f.sample().selected.size).toBe(2); // only the fixed logs
    expect(f.positions.size).toBe(0);
    appendFileSync(paths[1]!, "after cold\n");
    expect([...f.sample().lines, ...f.sample().lines]).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("best effort ignores new orphan diagnostics even when another file refreshes the listing", () => {
  const f = busFixture();
  try {
    f.sample(true);
    const path = join(f.payloads, "orphan.debug.attempts");
    writeFileSync(path, "new orphan\n");
    expect(f.sample().lines).toEqual([]);
    writeFileSync(join(f.payloads, "another.md"), "");
    appendFileSync(path, "still orphan\n");
    expect(f.sample().lines).toEqual([]);
    expect(f.positions.has(path)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("precise preserves exhaustive rewrite replay", () => {
  const f = fixture();
  try {
    f.rewrite(["a", "b"]); streamUpdates(f.path, f.positions, true, "precise");
    f.rewrite(["a", "b", "b"]);
    expect(streamUpdates(f.path, f.positions, false, "precise")).toEqual({ lines: ["a", "b", "b"], gap: true });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("config selects best-effort or precise for the next capture and rejects other modes", async () => {
  expect(parse(["config", "--fidelity", "precise"])?.fidelity).toBe("precise");
  expect(parse(["config", "--fidelity=best-effort"])?.fidelity).toBe("best-effort");
  for (const args of [["config", "--fidelity", "trace"], ["on", "--fidelity", "precise"], ["config", "--fidelity"]]) expect(() => parse(args)).toThrow();
  const f = fixture(), output: string[] = [], log = console.log;
  const env = { ...process.env, TAP_INDEX_HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") };
  console.log = (...args) => { output.push(args.join(" ")); };
  try {
    await main(["config", "--json"], env);
    expect(JSON.parse(output.pop()!).fidelity).toBe("best-effort");
    await main(["config", "--fidelity", "precise", "--json"], env);
    expect(JSON.parse(output.pop()!)).toMatchObject({ fidelity: "precise", applies: "next capture" });
    await main(["config", "--json"], env);
    expect(JSON.parse(output.pop()!).fidelity).toBe("precise");
  } finally { console.log = log; rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ["best-effort", "precise"] as const) test(`collector publishes ${mode}, trace, then ${mode} and uses each stream policy`, async () => {
  const f = busFixture(mode), directory = join(f.root, "capture"), trace = join(directory, "trace");
  mkdirSync(trace, { recursive: true }); mkdirSync(join(f.root, "debug"));
  const run: Run = { id: "modes", directory, socket: "/unused.sock", config: { max_mb: 10, fidelity: mode } };
  writeFileSync(join(f.root, "debug/enabled.json"), JSON.stringify(run));
  const orphan = join(f.payloads, "old.debug.attempts");
  writeFileSync(orphan, '{"stage":"before capture"}\n');
  f.rewrite(["same", "same"]);
  const modes: string[] = [], events: { event: string; [key: string]: any }[] = [];
  const identity = { pid: process.pid, start: "test", socket: run.socket };
  let tick = 0, traceFinished = false;
  try {
    await collect(run, { ...effects, server: async () => identity, teamBuses: () => ({ [f.root]: "test" }),
      startLog: async () => ({ identity, owned: true }), stopLog: async () => {},
      appendEvent: (run, event, fields) => {
        if (event === "trace.finished") traceFinished = true;
        events.push({ event, ...fields }); effects.appendEvent(run, event, fields);
      },
      collectArtifacts: async () => {
        const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
        modes.push(status.mode);
        expect(status.pid).toBe(process.pid); expect(status.heartbeat).toBeGreaterThan(0);
        expect(status.fidelity).toBe(mode);
        expect(status.sources["tap-events"].state).toBe("recording");
        expect(status.sources["tap-events"].last_sample_at).toBeString();
        expect(status.sources.tmux.state).toBe("unmanaged");
        if (traceFinished) expect(status.mode).toBe("basic");
        tick++;
        if (tick === 1) {
          f.rewrite(["same", "same"]);
          writeFileSync(join(directory, "trace-request.json"), JSON.stringify({ id: "window", directory: trace, seconds: 1.5 }));
        } else if (tick === 2) {
          appendFileSync(orphan, '{"stage":"during trace"}\n');
          f.rewrite(["same", "same"]);
        }
        if (tick > 2 && modes.at(-1) === "basic") writeFileSync(join(directory, "stop"), "");
      },
    }, { ...process.env, TAP_INDEX_HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") });
    expect(modes.slice(0, 2)).toEqual(["basic", "trace"]); expect(modes.at(-1)).toBe("basic");
    expect(events.filter(e => e.event === "tap.attempt").map(e => e.fields.stage)).toEqual(["during trace"]);
    expect(events.some(e => e.event === "capture.gap" && e.reason === "source_rotated_or_truncated")).toBe(true);
    expect(events.filter(e => e.event === "tap.registry").length).toBeGreaterThanOrEqual(2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

test("trace admission isolates a sidecar stat failure and continues collecting healthy streams", async () => {
  const f = busFixture(), directory = join(f.root, "capture"), trace = join(directory, "trace");
  mkdirSync(trace, { recursive: true }); mkdirSync(join(f.root, "debug"));
  const run: Run = { id: "faulty-trace", directory, socket: "/unused.sock", config: { max_mb: 10 } };
  writeFileSync(join(f.root, "debug/enabled.json"), JSON.stringify(run));
  const faulty = join(f.payloads, "loop.debug.attempts"), healthy = join(f.payloads, "healthy.attempts");
  symlinkSync(faulty, faulty); writeFileSync(healthy, '{"stage":"before trace"}\n');
  const identity = { pid: process.pid, start: "test", socket: run.socket };
  const events: { event: string; [key: string]: any }[] = [];
  let tick = 0;
  try {
    await collect(run, { ...effects, server: async () => identity, teamBuses: () => ({ [f.root]: "test" }),
      startLog: async () => ({ identity, owned: true }), stopLog: async () => {},
      appendEvent: (run, event, fields) => { events.push({ event, ...fields }); effects.appendEvent(run, event, fields); },
      collectArtifacts: async () => {
        tick++;
        if (tick === 1) writeFileSync(join(directory, "trace-request.json"), JSON.stringify({ id: "window", directory: trace, seconds: 2 }));
        if (tick === 2) appendFileSync(healthy, '{"stage":"after faulty admission"}\n');
        if (tick === 3) writeFileSync(join(directory, "stop"), "");
      },
    }, { ...process.env, TAP_INDEX_HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") });
    expect(events.some(e => e.event === "capture.gap" && e.source === faulty && /ELOOP/.test(e.reason))).toBe(true);
    expect(events.filter(e => e.event === "tap.attempt").map(e => e.fields.stage)).toEqual(["after faulty admission"]);
    expect(tick).toBe(3);
    expect(events.some(e => e.event === "capture.error")).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

test("trace admission baselines both old orphan and previously drained sidecars", async () => {
  const f = busFixture(), directory = join(f.root, "capture"), trace = join(directory, "trace");
  mkdirSync(trace, { recursive: true }); mkdirSync(join(f.root, "debug"));
  const run: Run = { id: "drained-trace", directory, socket: "/unused.sock", config: { max_mb: 10, fidelity: "best-effort" } };
  writeFileSync(join(f.root, "debug/enabled.json"), JSON.stringify(run));
  const drained = join(f.payloads, "drained.attempts"), orphan = join(f.payloads, "old.debug.attempts");
  writeFileSync(join(f.payloads, "drained.md"), "");
  writeFileSync(drained, '{"stage":"before drain"}\n'); writeFileSync(orphan, '{"stage":"old orphan"}\n');
  utimesSync(orphan, 0, 0);
  const identity = { pid: process.pid, start: "test", socket: run.socket }, stages: string[] = [];
  let tick = 0;
  try {
    await collect(run, { ...effects, server: async () => identity, teamBuses: () => ({ [f.root]: "test" }),
      startLog: async () => ({ identity, owned: true }), stopLog: async () => {},
      appendEvent: (run, event, fields) => {
        if (event === "tap.attempt") stages.push((fields!.fields as { stage: string }).stage);
        if (event === "trace.finished") writeFileSync(join(directory, "stop"), "");
        effects.appendEvent(run, event, fields);
      },
      collectArtifacts: async () => {
        tick++;
        if (tick === 1) writeFileSync(join(f.receipts, "drained.done"), "");
        if (tick === 5) {
          appendFileSync(drained, '{"stage":"after drain before trace"}\n');
          writeFileSync(join(directory, "trace-request.json"), JSON.stringify({ id: "window", directory: trace, seconds: 1.5 }));
        }
        if (tick === 6) {
          appendFileSync(drained, '{"stage":"during trace"}\n');
          appendFileSync(orphan, '{"stage":"late cold write"}\n');
        }
      },
    }, { ...process.env, TAP_INDEX_HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") });
    expect(stages).toEqual(["during trace"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 35000);
