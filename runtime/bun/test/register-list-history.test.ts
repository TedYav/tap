import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { listHandleHistory } from "../src/verbs/register";

const ROOT = join(import.meta.dir, "../../..");
const REGISTER_SH = join(ROOT, "scripts/tap.sh");

test("an explicit history directory follows the selected registry without changing the default", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.histA, "sol.relocated.json"), JSON.stringify({ handle: "sol", instance: "sol|relocated", retired_at: "2026-09-22T00:00:00Z" }));
    expect(listHandleHistory(f.busB, "sol", f.histA).map(row => row.get("instance"))).toEqual(["sol|relocated"]);
    expect(listHandleHistory(f.busB, "sol").map(row => row.get("instance"))).not.toContain("sol|relocated");
  } finally { removeScratchTree(f.root); }
});

interface Door { code: number; out: string; err: string; trace: string }

function fixture() {
  const root = join(tmpdir(), `tap-list-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const index = join(root, "index");
  const home = join(root, "home");
  const cwd = join(root, "a/repo");
  const busB = join(root, "b/repo/.tap/bus");
  const histA = join(root, "a/repo/.tap/team-history");
  const histB = join(root, "b/repo/.tap/team-history");
  for (const dir of [index, home, cwd, busB, histA, histB]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // live marker; history reads go through TAP_HOME, not enrollment
  const tomb = (name: string, row: Record<string, unknown>) => writeFileSync(join(histB, name), `${JSON.stringify(row)}\n`);
  tomb("sol.evt-b.20260101T000000Z.json", { handle: "sol", instance: "sol|newer", retired_by: "evt-b", retired_at: "2026-01-01T00:00:00Z" });
  tomb("sol.evt-a.20260101T000000Z.json", { handle: "sol", instance: "sol|shared", retired_by: "evt-a", retired_at: "2026-01-01T00:00:00Z" });
  tomb("sol.evt-c.20251231T000000Z.json", { handle: "sol", instance: "sol|older", retired_by: "evt-c\u007f", retired_at: "2025-12-31T00:00:00Z" });
  tomb("sol.evt-none.20260102T000000Z.json", { handle: "sol", instance: "sol|noinfo", retired_at: "2026-01-02T00:00:00Z" });
  writeFileSync(join(histB, "other.evt-x.20260101T000000Z.json"), JSON.stringify({ handle: "other", instance: "other|1", retired_by: "evt-x", retired_at: "2026-01-01T00:00:00Z" }));
  writeFileSync(join(histB, "sol.lineage.evt-y.20260101T000000Z.json"), JSON.stringify({ handle: "sol", instance: "sol|lineage", retired_by: "evt-y", retired_at: "2026-01-01T00:00:00Z" }));
  writeFileSync(join(histB, "sol.corrupt.20260101T000000Z.json"), "{oops");
  writeFileSync(join(histB, "sol.notobject.20260101T000000Z.json"), "[1,2]");
  writeFileSync(join(histB, "sol.badutf8.20260101T000000Z.json"), Buffer.from([0xff, 0xfe, 0x7b]));
  writeFileSync(join(histB, "sol.evt-w.20260103T000000Z.json"), '{"handle":"sol","instance":"sol|wide","retired_by":9007199254740993,"retired_at":"2026-01-03T00:00:00Z"}\n'); // wide-integer written verbatim (2^53+1 is not a double); matching-name dir below is skipped by isfile
  mkdirSync(join(histB, "sol.dir.20260101T000000Z.json"), { recursive: true });
  const env = (extra: NodeJS.ProcessEnv = {}, tracePath = join(root, "trace")) => ({
    ...process.env, HOME: home, TAP_HOME: busB, TAP_INDEX_HOME: index, TAP_BUN_ROUTE_TRACE: tracePath, TAP_SELF: "", TMUX: "", TMUX_PANE: "", ...extra,
  });
  return { root, index, home, cwd, busB, histA, histB, env };
}

// Python outputs captured at d9b94af16 before registry_v20 retirement.
import historyGolden from "./support/python-closure-history.json";

function door(f: ReturnType<typeof fixture>, kind: "default" | "direct", args: string[]): Door {
  const tracePath = join(f.root, `trace-${Math.random().toString(36).slice(2)}`);
  const env = f.env({}, tracePath);
  const rest = args[0] === "in" ? args.slice(1) : args; // the direct door receives argv without the verb (the root scripts/tap.sh door shifts it)
  const argv = kind === "direct" ? ["bash", REGISTER_SH, "in", ...rest] : [join(ROOT, "bin/tap"), ...args];
  const r = Bun.spawnSync(argv, { cwd: f.cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
  let trace = "";
  try { trace = readFileSync(tracePath, "utf8"); } catch { /* no line written */ }
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), trace };
}

test("native form serves a clean list-history argv byte-identically on both doors", () => {
  const f = fixture();
  try {
    const expectedJson = historyGolden.json;
    expect(expectedJson).not.toContain("decoy");
    expect(expectedJson).toContain("9007199254740993");
    expect(expectedJson).toContain("\\u007f"); // json.dumps escapes DEL; the native emitter must equal these bytes
    for (const kind of ["default", "direct"] as const) {
      const d = door(f, kind, ["in", "sol", "--list-history", "--json"]);
      expect(d.code, d.err).toBe(0); expect(d.out).toBe(expectedJson);
      expect(d.err).toBe("");
    }
    const expectedHuman = historyGolden.human;
    for (const kind of ["default", "direct"] as const) {
      const d = door(f, kind, ["in", "sol", "--list-history"]);
      expect(d.code, d.err).toBe(0);
      expect(d.out).toBe(expectedHuman);
    }
    const swallowed = door(f, "default", ["in", "--pane", "--list-history", "sol", "--list-history", "--json"]); // flag-shaped value is a value; argv stays clean
    expect(swallowed.code, swallowed.err).toBe(0);
    expect(swallowed.out).toBe(expectedJson);
  } finally { removeScratchTree(f.root); }
}, 30000);

test("history uses the default HOME index when TAP_INDEX_HOME is absent", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".tap"), { recursive: true });
    writeFileSync(join(f.home, ".tap", "global-registry.json"), readFileSync(join(f.index, "global-registry.json")));
    const env: NodeJS.ProcessEnv = f.env();
    delete env.TAP_INDEX_HOME;
    const d = Bun.spawnSync([join(ROOT, "bin/tap"), "in", "sol", "--list-history", "--json"], {
      cwd: f.cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    expect(d.exitCode, d.stderr.toString()).toBe(0);
    expect(d.stdout.toString()).toBe(historyGolden.json);
  } finally { removeScratchTree(f.root); }
}, 30000);

test("TAP_HOME's history wins over the cwd's, with no current seat row anywhere", () => {
  const f = fixture();
  try {
    const d = door(f, "default", ["in", "sol", "--list-history", "--json"]);
    expect(d.code, d.err).toBe(0);
    expect(d.out).toBe(historyGolden.json);
    expect(d.out).not.toContain("sol|decoy");
  } finally { removeScratchTree(f.root); }
}, 30000);

test("the native form owns the clean argv: every door traces the native line", () => {
  const f = fixture();
  try {
    const nativeTrace = "native register --list-history\nnative in\n";
    const traces: Record<string, string> = { "default": nativeTrace, "direct": nativeTrace };
    for (const [kind, expected] of Object.entries(traces)) {
      const d = door(f, kind as "default", ["in", "sol", "--list-history", "--json"]);
      expect(d.trace, `${kind} trace`).toBe(expected);
    }
  } finally { removeScratchTree(f.root); }
}, 30000);

test("refusable argv is answered legacy and refused by the incumbent with its exact bytes", () => {
  const f = fixture();
  try {
    const refusals: Array<{ args: string[]; status: number; stderr?: string; stdout?: string; stderrSuffix?: string }> = [
      { args: ["in", "--list-history"], status: 1, stderr: "tap register: --list-history requires a handle; next: tap help register\n" },
      { args: ["in", "", "--list-history"], status: 1, stderr: "tap register: --list-history requires a handle; next: tap help register\n" },
      { args: ["in", "sol", "other", "--list-history"], status: 1, stderr: "tap register: unexpected arg 'other'; next: tap help register\n" },
      { args: ["in", "sol", "--list-history", "--bogus"], status: 1, stderr: "tap register: unknown option '--bogus'; next: tap help register\n" },
      { args: ["in", "sol", "--list-history", "--pane"], status: 1, stderr: "tap register: --pane needs a value; next: tap help register\n" },
      { args: ["in", "sol", "--pane", "", "--list-history"], status: 1, stderr: "tap register: --pane needs a value; next: tap help register\n" },
      { args: ["in", "sol", "--digest-window", "30", "--list-history"], status: 1, stderr: "tap register: --digest-window requires an active pane registration of the CALLER'S OWN pane (no --offline, --delivery poll, --list-history or explicit --pane); next: tap help register\n" },
      { args: ["in", "sol", "--include-asks", "--list-history"], status: 1, stderr: "tap register: --include-asks requires --digest-window; next: tap help register\n" },
      { args: ["in", "sol", "--list-history", "--json", "--bogus"], status: 1, stdout: '{"ok":false,"error_class":"unknown_option","action":"tap help register","detail":"unknown option \'--bogus\'"}\n' },
    ];
    for (const c of refusals) {
      const d = door(f, "default", c.args);
      expect(d.code, `${c.args.join(" ")}: ${d.err}${d.out}`).toBe(c.status);
      if (c.stderr !== undefined) expect(d.err, c.args.join(" ")).toBe(c.stderr);
      if (c.stderrSuffix !== undefined) expect(d.err.endsWith(c.stderrSuffix), c.args.join(" ")).toBe(true);
      if (c.stdout !== undefined) { expect(d.out, c.args.join(" ")).toBe(c.stdout); expect(d.err).toBe(""); }
    }
    const direct = door(f, "direct", ["in", "--list-history"]); // the direct door refuses identically
    expect(direct.code).toBe(1);
    expect(direct.err).toBe("tap register: --list-history requires a handle; next: tap help register\n");
  } finally { removeScratchTree(f.root); }
}, 30000);

test("an unreadable history directory fails the command instead of reporting no history", () => {
  const f = fixture();
  try {
    chmodSync(f.histB, 0o000); // existing dir, stat succeeds, readdir may not: incumbent isdir→listdir shape
    const d = door(f, "default", ["in", "sol", "--list-history", "--json"]);
    expect(d.code, `${d.out}${d.err}`).not.toBe(0);
    expect(d.out).toBe("");
  } finally { chmodSync(f.histB, 0o755); removeScratchTree(f.root); }
}, 30000);

test("marker boundaries: absent is pre-flip output, invalid refuses invalid_flip", () => {
  const f = fixture();
  try {
    rmSync(join(f.index, "global-registry.json"));
    const absentJson = door(f, "default", ["in", "sol", "--list-history", "--json"]);
    expect(absentJson.code, absentJson.err).toBe(0); expect(absentJson.out).toBe("[]\n");
    const absentHuman = door(f, "direct", ["in", "sol", "--list-history"]);
    expect(absentHuman.code, absentHuman.err).toBe(0); expect(absentHuman.out).toBe("tap in: no history (pre-flip)\n");

    writeFileSync(join(f.index, "global-registry.json"), "{invalid");
    const invalidJson = door(f, "default", ["in", "sol", "--list-history", "--json"]);
    expect(invalidJson.code, invalidJson.out).toBe(1);
    expect(invalidJson.out).toBe('{"ok":false,"error_class":"invalid_flip","action":"tap doctor","detail":"registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation"}\n');
    const invalidHuman = door(f, "direct", ["in", "sol", "--list-history"]);
    expect(invalidHuman.code).toBe(1);
    expect(invalidHuman.err).toBe("tap register: registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation; next: tap doctor\n");
    expect(invalidHuman.out).toBe("");
  } finally { removeScratchTree(f.root); }
}, 30000);
