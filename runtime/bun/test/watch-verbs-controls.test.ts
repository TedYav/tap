// tap_serial_triggers "bin/tap" "skills/tap/scripts/lib.sh" "runtime/bun/main.ts" "runtime/bun/src/verbs/watch.ts" "runtime/bun/src/watch-run.ts" "runtime/bun/test/fixtures/watch-verbs-oracle.json" "runtime/bun/test/support/watch-verbs-fixture.ts"
// Fixture provenance, temp-name normalisation and router ownership controls,
// plus scratch recreation after cleanup. The replay components retain
// all 480 door/case pairs from watch-verbs.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expected, normaliseTemp, oracle, releaseScratch, replay, repo, stage } from "./support/watch-verbs-fixture";

afterAll(() => releaseScratch(), 40_000);

test("watch arms an explicit tmp/tap custom home through both public doors", () => {
  const basic = oracle.cases.find(c => c.case === "on-basic")!;
  const custom = { ...basic, case: "on-custom-legacy-shape", env: { ...basic.env, LEGACY_HOME: "1" } };
  for (const door of ["router", "bin/tap"] as const) {
    const got = replay(custom, door), want = expected(basic);
    expect(got.rc).toBe(0);
    expect(got.stdout).toBe(want.stdout);
    expect(got.stderr).toBe(want.stderr);
    expect(got.post).toEqual(want.post);
  }
});

describe("watch-verbs oracle provenance", () => {
  test("the fixture pins the blobs it was captured from", () => {
    expect(oracle.captured_from.head).toBe("2f4edfa27");
    expect(oracle.captured_from.blobs["skills/tap/scripts/tap-watch.sh"]).toBe("929ef2ccb855477f0c8dfbfab3576579af095720");
    expect(oracle.captured_from.blobs["skills/tap/scripts/lib.sh"]).toBe("5509bde90b1b84de672469b81fdd960547f871d3");
    expect(oracle.cases.length).toBe(240);
  });
  test("the corpus covers what rule 13 names", () => {
    const names = new Set(oracle.cases.map(c => c.case));
    for (const needed of ["status-bigint", "on-bigint-goal", "on-threshold-9007199254740993-16-x", "on-unicode-goal", "pause-reason-unicode",
      "status-null-done-when", "resume-null-fields", "resume-absent-fields", "status-corrupt", "status-list", "ack-invalid-json", "on-file-missing",
      "on-file-dir", "ack-none-unverifiable", "off-unarmed-unverifiable", "resume-running-unverifiable", "pause-no-reason-unverifiable",
      "on-spawn-foreign-window", "on-spawn-ours-dead", "on-spawn-mutex-held", "off-pending-other", "ack-unreadable", "on-multiline-arg",
      "off-arm-dir", "status-arm-fifo", "off-arm-fifo", "ack-notify-fifo", "on-arm-fifo"]) {
      expect(names.has(needed), needed).toBe(true);
    }
    // every required whitespace code point at a parser-consumed value (an --context-exempt handle and a pause reason)
    for (const cp of [0xfeff, 0xa0, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000]) {
      const ch = String.fromCodePoint(cp);
      expect(oracle.cases.some(c => c.argv.some(a => a.includes(ch))), `U+${cp.toString(16)}`).toBe(true);
    }
  });
});

describe("the temp-name normaliser is narrow", () => {
  test("only the ephemeral `.lease-<id>` token moves; a changed error class or destination still differs", () => {
    const a = "tap watch: EISDIR: illegal operation on a directory, rename '<WORK>/.tap/bus/watch/.lease-vlg38513585' -> '<WORK>/.tap/bus/watch/arm.json'; next: tap health\n";
    const b = a.replace(".lease-vlg38513585", ".lease-1wqe7e06da47");
    expect(normaliseTemp(a)).toBe(normaliseTemp(b));
    expect(normaliseTemp(a)).not.toBe(normaliseTemp(a.replace("EISDIR", "EACCES")));
    expect(normaliseTemp(a)).not.toBe(normaliseTemp(a.replace("arm.json'", "notify.json'")));
    expect(normaliseTemp(a)).toContain(".lease-*");
  });
});

describe("the router owns every arm of the verb (W3: the loop internals too)", () => {
  // Option-as-value: `-m run` / `-m tick` are values, not tokens with a meaning of their own.
  const routes: Array<[argv: string[], runtime: "native" | "bash"]> = [
    [["status"], "native"],
    [["on", "-m", "run", "--evaluator", "none", "--no-spawn", "--by", "owner"], "native"],
    [["pause", "-m", "tick", "--by", "owner"], "native"],
    [["ack", "--by", "owner"], "native"],
    [["tick"], "native"],
  ];
  for (const [argv, runtime] of routes) {
    test(`tap watch ${argv.join(" ")} -> ${runtime}`, () => {
      const { work, env } = stage({ case: `route-${argv.join("_")}`, argv, env: {}, files: {}, rc: 0, stdout: "", stderr: "", post: {}, tmux_log: "" }, "route");
      const trace = join(work, "route.trace");
      // `tick` evaluates an unarmed bus in-process and returns.
      spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), "watch", ...argv], { cwd: work, env: { ...env, TAP_BUN_ROUTE_TRACE: trace }, encoding: "utf8", timeout: 20_000 });
      expect(readFileSync(trace, "utf8")).toBe(`${runtime} watch\n`);
    }, 30_000);
  }
  test("tap watch run -> the router's process BECOMES the Bun loop (execve: same pid in the lease, no trace line survives the exec)", async () => {
    const { work, bus, env } = stage({ case: "route-run", argv: ["run"], env: {}, files: {}, rc: 0, stdout: "", stderr: "", post: {}, tmux_log: "" }, "route");
    const trace = join(work, "route.trace");
    const arm = join(bus, "watch", "arm.json");
    mkdirSync(join(bus, "watch"), { recursive: true });
    writeFileSync(arm, JSON.stringify({ mode: "supervision", armed_by: "owner", armed_at: 1000, tick_interval_seconds: 60, evaluator: "none" }) + "\n");
    const child = Bun.spawn([process.execPath, join(repo, "runtime/bun/main.ts"), "watch", "run"], { cwd: work, env: { ...env, TAP_BUN_ROUTE_TRACE: trace }, stdout: "ignore", stderr: "pipe" });
    try {
      const deadline = Date.now() + 20_000;
      let rec: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        try { rec = JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>; } catch { rec = {}; }
        if (rec.watcher_command === "watch-run.ts run") break;
        await Bun.sleep(50);
      }
      expect(rec.watcher_command).toBe("watch-run.ts run");
      expect(rec.watcher_pid).toBe(child.pid);   // the pid the router started is the pid the loop stamps
      expect(existsSync(trace)).toBe(false);     // the router never regained control to write it
    } finally {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);         // the incumbent's trap: a signal ends the loop with 0
    }
  }, 30_000);
});

describe("the shared watch-verbs fixture survives a release", () => {
  test("stage() recreates a fresh scratch root after releaseScratch() (unit-2 lifecycle regression)", async () => {
    stage({ case: "lifecycle-warm", argv: ["status"], env: {}, files: {}, rc: 0, stdout: "", stderr: "", post: {}, tmux_log: "" }, "route");
    releaseScratch();
    const { work } = stage({ case: "lifecycle-recreated", argv: ["status"], env: {}, files: {}, rc: 0, stdout: "", stderr: "", post: {}, tmux_log: "" }, "route");
    expect(existsSync(work)).toBe(true);
  }, 60_000);
});

// tap-calo: `off` authority is the calling pane. `--by` and TAP_SELF are
// caller-supplied, so neither may grant (or withhold) the armer's authority.
describe("watch off authority is the calling pane, never --by or TAP_SELF (tap-calo)", () => {
  const base = (name: string) => oracle.cases.find(c => c.case === name)!;
  const asPane = (from: string, who: "owner" | "peer" | "none", argv: string[], env: Record<string, string> = {}) =>
    replay({ ...base(from), case: `calo-${who}-${argv.join("-")}`, argv, env: { ...base(from).env, ...env, SHIM_ACT_AS: who } }, "bin/tap");

  test("a peer's `off --by <armer>` is refused, offered --force, and the lease survives", () => {
    const got = asPane("off-other", "peer", ["off", "--by", "owner"]);
    expect(got.rc).toBe(1);
    expect(got.stderr).toContain("'peer' cannot disarm it");
    expect(got.stderr).toContain("or pass --force");
    expect(got.stderr).not.toContain("--by");
    expect(got.post["watch/arm.json"]).toBeDefined();
    // identical to the honest peer row: the flag changed nothing
    expect(got.post).toEqual(expected(base("off-other")).post);
    expect(got.stderr).toBe(expected(base("off-other")).stderr);
  });

  test("TAP_SELF naming the armer grants a peer pane nothing either", () => {
    const got = asPane("off-other", "peer", ["off"], { TAP_SELF: "owner" });
    expect(got.rc).toBe(1);
    expect(got.stderr).toContain("'peer' cannot disarm it");
    expect(got.post["watch/arm.json"]).toBeDefined();
  });

  test("the armer's own pane disarms even when --by names someone else", () => {
    const got = asPane("off-armer", "owner", ["off", "--by", "peer"]);
    const want = expected(base("off-armer"));
    expect([got.rc, got.stdout, got.post]).toEqual([want.rc, want.stdout, want.post]);
    expect(got.post["watch/arm.json"]).toBeUndefined();
  });

  // The already-armed door must not send a caller to a refusal: `off` is pane-only, so bare `off` is
  // offered only when the PANE is the armer -- not when --by (or TAP_SELF) merely says so.
  describe("the already-armed door offers bare `off` only to the armer's own pane", () => {
    const argv = base("on-diff-goal-armer").argv; // `on --by owner ...` with a different goal, armed by owner
    const doorOf = (who: "owner" | "peer" | "none") => asPane("on-diff-goal-armer", who, argv).stderr;
    test("the armer's own pane is offered bare `off`", () => {
      const err = doorOf("owner");
      expect(err).toContain("next: tap watch off   # or re-run with --rearm");
      expect(err).not.toContain("--force");
    });
    test("a peer pane naming the armer with --by is offered `off --force`", () => {
      const err = doorOf("peer");
      expect(err).toContain("next: tap watch off --force   # or ask 'owner' to disarm");
      expect(err).not.toContain("--rearm");
    });
    test("a pane-less caller naming the armer with --by is offered `off --force`", () => {
      const err = doorOf("none");
      expect(err).toContain("next: tap watch off --force   # or ask 'owner' to disarm");
      expect(err).not.toContain("--rearm");
    });
  });

  test("a peer's `--force` stays loud and is attributed to the pane, not to --by", () => {
    const got = asPane("off-other-force", "peer", ["off", "--by", "owner", "--force"]);
    const want = expected(base("off-other-force"));
    expect([got.rc, got.stdout, got.stderr, got.post]).toEqual([want.rc, want.stdout, want.stderr, want.post]);
    expect(got.post["watch/arm.json"]).toBeUndefined();
  });
});
