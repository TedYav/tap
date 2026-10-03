// A send refused before placement leaves no `.placed` receipt, so the delivery
// reliability census cannot see it. The machine-scope refusal log is the trace
// (tap-i83d9). Every claim runs through the public router in a sandbox whose
// index home is the fixture's: the log must land there and nowhere else.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN, teamFixture, flushScratch, payloads } from "./support/send-reply-flip-fixture";
import { TapError } from "../src/context";
import { OldStoreError } from "../src/register-authority";
import { GENERATIONS_KEPT, recordSendRefusal, refusalErrorId, SEND_REFUSAL_LOG_CAP_BYTES } from "../src/send-refusal-log";

afterEach(() => flushScratch(), 40_000);

type Fx = ReturnType<typeof teamFixture>;
const logPath = (fx: Fx) => join(fx.env.TAP_INDEX_HOME as string, "send-refusals.log");
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

function run(fx: Fx, argv: string[], env: Record<string, string> = {}, timeout = 60_000) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: fx.wt, env: { ...fx.env, ...env }, stdout: "pipe", stderr: "pipe", timeout });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function fixture() {
  return teamFixture({ seats: { ub: { status: "active", delivery: "poll", instance: "ub|A" } } });
}

const BODY = "SECRET-BODY-MARKER do not log me";

test("a refused send appends one line with time, sender, recipient, team and error id, and no body", () => {
  const fx = fixture();
  const before = Date.now();
  const r = run(fx, ["send", "nobody", "-m", BODY, "--from", "ua", "--preview", "SECRET-PREVIEW-MARKER"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is not an active seat");
  const rows = lines(logPath(fx));
  expect(rows).toHaveLength(1);
  const [at, from, to, team, id, phase, ...rest] = rows[0]!.split("\t");
  expect(rest).toEqual([]);
  expect(phase).toBe("pre");
  expect({ from, to, team, id }).toEqual({ from: "ua", to: "nobody", team: "flip", id: "unknown_recipient" });
  expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(Math.abs(Date.parse(at!) - before)).toBeLessThan(120_000);
  expect(readFileSync(logPath(fx), "utf8")).not.toMatch(/SECRET/);
  expect(payloads(fx.bus)).toHaveLength(0);
});

test("a refusal before the sender or recipient resolves still counts, with - for the unknown fields", () => {
  const fx = fixture();
  const r = run(fx, ["send", "ub", "--bogus-option", "-m", "x", "--from", "ua"]);
  expect(r.code).not.toBe(0);
  const rows = lines(logPath(fx)).map(row => row.split("\t"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.slice(1)).toEqual(["-", "-", "-", "unknown_option", "pre"]);
});

test("an assign refused before placement is counted once", () => {
  const fx = fixture();
  const r = run(fx, ["assign", "nobody", "-m", "do the thing", "--from", "ua"]);
  expect(r.code).toBe(1);
  expect(lines(logPath(fx)).map(row => row.split("\t")[4])).toEqual(["unknown_recipient"]);
});

test("a send that reaches placement appends nothing", () => {
  const fx = fixture();
  const r = run(fx, ["send", "ub", "-m", "hello", "--from", "ua"]);
  expect(r.code, r.err).toBe(0);
  expect(payloads(fx.bus)).toHaveLength(1);
  expect(existsSync(logPath(fx))).toBe(false);
});

test("the log lives under the pinned index home and nowhere in HOME", () => {
  const fx = fixture();
  run(fx, ["send", "nobody", "-m", "x", "--from", "ua"]);
  expect(logPath(fx).startsWith(fx.root)).toBe(true);
  expect(existsSync(logPath(fx))).toBe(true);
  expect(existsSync(join(fx.root, ".tap", "send-refusals.log"))).toBe(false);
});

test("an unwritable log leaves the refusal's exit, stdout and stderr unchanged", () => {
  const healthy = run(fixture(), ["send", "nobody", "-m", "x", "--from", "ua"]);
  const fx = fixture();
  mkdirSync(logPath(fx)); // an append to a directory fails
  const broken = run(fx, ["send", "nobody", "-m", "x", "--from", "ua"]);
  expect(broken).toEqual(healthy);
  expect(broken.code).toBe(1);
});

test("a machine with no TAP state gets no directory from a refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "refusal-log-"));
  try {
    const index = join(root, "no-such-index");
    recordSendRefusal("unknown_recipient", { from: "ua" }, "pre", { TAP_INDEX_HOME: index });
    expect(existsSync(index)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hostile field text cannot break the one-line format", () => {
  const root = mkdtempSync(join(tmpdir(), "refusal-log-"));
  try {
    recordSendRefusal("bad\tid\nx", { from: "a\tb", to: "x\ny", team: "ok-team" }, "pre", { TAP_INDEX_HOME: root });
    const rows = readFileSync(join(root, "send-refusals.log"), "utf8").split("\n").filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.split("\t").slice(1)).toEqual(["-", "-", "ok-team", "unknown", "pre"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Generations are `<log>.<UTC stamp>-<pid>-<rand>`: unique, so no rotator can
// replace another's, and the stamp leads so name order is time order.
const generationsOf = (dir: string) => readdirSync(dir).filter(n => /^send-refusals\.log\.\d{8}T\d{6}Z-\d+-[a-z0-9]+$/.test(n)).sort();

test("past the cap the log rotates to a unique generation and the active file restarts", () => {
  const fx = fixture();
  const dir = fx.env.TAP_INDEX_HOME as string;
  const filler = "2026-01-01T00:00:00Z\tua\tub\tflip\tfiller\n".repeat(Math.ceil(SEND_REFUSAL_LOG_CAP_BYTES / 38) + 1);
  writeFileSync(logPath(fx), filler);
  run(fx, ["send", "nobody", "-m", "x", "--from", "ua"]);
  const gens = generationsOf(dir);
  expect(gens).toHaveLength(1);
  expect(readFileSync(join(dir, gens[0]!), "utf8")).toBe(filler);
  const rows = lines(logPath(fx));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("unknown_recipient");
});

test("only the newest GENERATIONS_KEPT generations survive a rotation", () => withLog((root, path, env) => {
  const stamps = ["20260101T000001Z", "20260101T000002Z", "20260101T000003Z"];
  for (const st of stamps) writeFileSync(`${path}.${st}-1-aaaa`, `gen ${st}`);
  writeFileSync(path, FULL);
  recordSendRefusal("unknown_recipient", { from: "ua" }, "pre", env);
  const gens = generationsOf(root);
  expect(gens).toHaveLength(GENERATIONS_KEPT);
  // The oldest were pruned; the newest old one and the fresh rotation remain.
  expect(gens.some(n => n.includes("20260101T000003Z"))).toBe(true);
  expect(gens.some(n => n.includes("20260101T000001Z") || n.includes("20260101T000002Z"))).toBe(false);
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
}));

test("a FIFO squatting on the log path cannot hang the refusal", () => {
  const fx = fixture();
  expect(Bun.spawnSync(["mkfifo", logPath(fx)]).exitCode).toBe(0);
  const r = run(fx, ["send", "nobody", "-m", "x", "--from", "ua"], {}, 20_000);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is not an active seat");
});

test("a full log that cannot rotate is not appended to, and the send's exit and output are unchanged", () => {
  const healthy = run(fixture(), ["send", "nobody", "-m", "x", "--from", "ua"]);
  const fx = fixture();
  const dir = fx.env.TAP_INDEX_HOME as string;
  writeFileSync(logPath(fx), "x".repeat(SEND_REFUSAL_LOG_CAP_BYTES));
  chmodSync(dir, 0o555); // the log stays writable but nothing can be renamed or created in the directory
  try {
    const broken = run(fx, ["send", "nobody", "-m", "x", "--from", "ua"]);
    expect(broken).toEqual(healthy);
    expect(statSync(logPath(fx)).size).toBe(SEND_REFUSAL_LOG_CAP_BYTES);
  } finally { chmodSync(dir, 0o755); }
});

test("the next line's length counts against the cap", () => {
  const root = mkdtempSync(join(tmpdir(), "refusal-log-"));
  try {
    const path = join(root, "send-refusals.log");
    writeFileSync(path, "y".repeat(SEND_REFUSAL_LOG_CAP_BYTES - 5));
    recordSendRefusal("unknown_recipient", { from: "ua" }, "pre", { TAP_INDEX_HOME: root });
    const gens = generationsOf(root);
    expect(gens).toHaveLength(1);
    expect(statSync(join(root, gens[0]!)).size).toBe(SEND_REFUSAL_LOG_CAP_BYTES - 5);
    expect(statSync(path).size).toBeLessThan(200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refusal while the reply alias prepares is counted once, though cmdSendOutcome never ran", () => {
  const fx = fixture();
  const ask = run(fx, ["send", "ub", "--ask", "-m", "question", "--from", "ua", "--json"]);
  expect(ask.code, ask.err).toBe(0);
  const id = (JSON.parse(ask.out.trim().split("\n").pop()!) as { id: string }).id;
  expect(existsSync(logPath(fx))).toBe(false);
  const body = join(fx.root, "answer.md");
  writeFileSync(body, "answer");
  // ua is the asker, not the addressee, so the composed reply refuses before any send.
  const r = run(fx, ["send", "ua", "--reply-to", id, "-f", body], { TAP_SELF: "ua" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("is addressed to 'ub', not 'ua'");
  const rows = lines(logPath(fx)).map(row => row.split("\t"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.length).toBe(6);
  expect(rows[0]![4]).not.toBe("-");
  expect(rows[0]![5]).toBe("pre");
});

test("an old_store refusal raised below context.ts is a refused send and counts; a crash does not", () => {
  expect(refusalErrorId(new OldStoreError("tap doctor", "registry is the old store"))).toBe("old_store");
  expect(refusalErrorId(new TapError(1, "usage_error", "tap help", "x"))).toBe("usage_error");
  expect(refusalErrorId(new Error("boom"))).toBeNull();
  expect(refusalErrorId("old_store")).toBeNull();
});

test("a send into an old-store registry is counted as old_store", () => {
  const fx = fixture();
  const registry = join(fx.wt, ".tap", "team-registry.json");
  const doc = JSON.parse(readFileSync(registry, "utf8")) as Record<string, unknown>;
  doc.agents = {};
  writeFileSync(registry, JSON.stringify(doc));
  writeFileSync(join(fx.bus, "registry.json"), readFileSync(registry));
  const r = run(fx, ["send", "ub", "-m", "x", "--from", "ua"]);
  expect(r.code).not.toBe(0);
  const ids = lines(logPath(fx)).map(row => row.split("\t")[4]);
  expect(r.err).toContain("old TAP registry format");
  expect(ids).toEqual(["old_store"]);
});

function withLog<T>(body: (root: string, path: string, env: NodeJS.ProcessEnv) => T): T {
  const root = mkdtempSync(join(tmpdir(), "refusal-log-"));
  try { return body(root, join(root, "send-refusals.log"), { TAP_INDEX_HOME: root }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const FULL = "y".repeat(SEND_REFUSAL_LOG_CAP_BYTES);

test("racing rotators never replace each other's generation and lose no line", async () => {
  const module = join(import.meta.dir, "..", "src", "send-refusal-log.ts");
  for (let round = 0; round < 6; round++) {
    const root = mkdtempSync(join(tmpdir(), "refusal-log-"));
    try {
      const path = join(root, "send-refusals.log");
      writeFileSync(path, FULL);
      const kids = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e",
        `import { recordSendRefusal } from ${JSON.stringify(module)}; recordSendRefusal("unknown_recipient", { from: "ua" }, "pre");`],
        { env: { ...process.env, TAP_INDEX_HOME: root }, stdout: "pipe", stderr: "pipe" }));
      const codes = await Promise.all(kids.map(kid => kid.exited));
      expect(codes).toEqual(Array(8).fill(0));
      const gens = generationsOf(root);
      const all = gens.map(n => readFileSync(join(root, n), "utf8")).join("") + (existsSync(path) ? readFileSync(path, "utf8") : "");
      // The filler generation survives (it begins one generation), every line is somewhere, and K holds.
      expect({ round, filler: gens.some(n => readFileSync(join(root, n), "utf8").startsWith(FULL)), lines: all.match(/unknown_recipient/g)?.length,
        kept: gens.length <= GENERATIONS_KEPT }).toEqual({ round, filler: true, lines: 8, kept: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 120_000);
