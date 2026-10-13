// tap_serial_triggers "bin/tap" "skills/tap/scripts/lib.sh" "runtime/bun/main.ts" "runtime/bun/src/verbs/watch.ts" "runtime/bun/src/watch-sidecar.ts" "runtime/bun/test/fixtures/watch-verbs-oracle.json" "runtime/bun/test/support/watch-verbs-fixture.ts"
// `tap watch status` says whether the dispatcher the lease names is running, not only
// that a lease exists (tap-zpmvx). Three states stay distinct: alive, dead, unknown.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatcherLiveness } from "../src/watch-sidecar";
import { removeScratchTree } from "./support/scratch";
import { oracle, releaseScratch, replay, type OracleCase } from "./support/watch-verbs-fixture";

afterAll(() => releaseScratch(), 40_000);

const lease = (extra: Record<string, unknown>) => JSON.stringify({
  mode: "supervision", armed_by: "owner", armed_at: 1000, threshold_seconds: 1500, probe_timeout_seconds: 1500,
  tick_interval_seconds: 60, done_when: "ship it", ...extra,
});

const CLOCK_NEXT = "  next: the lease's heartbeat or arm time is unreadable or in the future (a clock or lease fault tap health does not check); check the system clock, then rearm with `tap watch off` (the armer, or --force) followed by `tap watch on`";

function status(name: string, arm: string, env: Record<string, string> = {}, ps_shim?: string, tmux_shim?: string) {
  const c: OracleCase = { case: name, argv: ["status"], env: { TAP_WATCH_NOW: "2000", ...env }, files: { "watch/arm.json": arm }, rc: 0, stdout: "", stderr: "", post: {}, tmux_log: "", ps_shim, tmux_shim };
  return replay(c, "bin/tap");
}

describe("tap watch status reports dispatcher liveness beside the armed line", () => {
  test("armed with a live watcher and a fresh heartbeat reads alive", () => {
    const got = status("liveness-alive", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }), { SHIM_ALIVE_PID: "4242", SHIM_ALIVE_COMMAND: "watch-run.ts run" });
    expect(got.rc).toBe(0);
    expect(got.stdout.split("\n").slice(0, 2)).toEqual(["tap watch: armed", "  dispatcher: alive (pid 4242, heartbeat 20s ago)"]);
    expect(got.stdout).not.toContain("  next:");
    expect(got.rc).toBe(0);
  });

  test("armed with a watcher pid that is gone reads dead and names the restart", () => {
    // ps's real no-match shape for a gone pid: exit 1, empty stdout, empty stderr.
    const got = status("liveness-dead-pid", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }), {}, "#!/bin/bash\nexit 1\n");
    expect(got.rc).toBe(0); // reported state, not failure (CLI-EXIT-0)
    expect(got.stdout.split("\n").slice(0, 2)).toEqual(["tap watch: armed", "  dispatcher: dead (pid 4242 is not running the watcher)"]);
    expect(got.stdout).toContain("  next: re-run the `tap watch on` that armed this");
  });

  test("a printed matching command stays positive evidence on a nonzero ps exit", () => {
    const got = status("liveness-ps-prints-exit-1", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }), {}, "#!/bin/bash\necho 'bash watch-run.ts run'\nexit 1\n");
    expect(got.stdout.split("\n").slice(0, 2)).toEqual(["tap watch: armed", "  dispatcher: alive (pid 4242, heartbeat 20s ago)"]);
  });

  test("a live pid whose heartbeat is past the bound reads dead, not armed-and-fine", () => {
    const got = status("liveness-stale-heartbeat", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1000 }), { SHIM_ALIVE_PID: "4242", SHIM_ALIVE_COMMAND: "watch-run.ts run" });
    expect(got.rc).toBe(0);
    expect(got.stdout.split("\n")[1]).toBe("  dispatcher: dead (pid 4242 is running but its last heartbeat was 1000s ago)");
    expect(got.stdout).toContain("  next: re-run");
  });

  test("a live pid that has never ticked reads alive inside the startup bound and dead past it", () => {
    const shim = { SHIM_ALIVE_PID: "4242", SHIM_ALIVE_COMMAND: "watch-run.ts run" };
    // now is 2000 and the bound is 180 s: armed at 1900 is inside it.
    const fresh = status("liveness-never-ticked-fresh", lease({ armed_at: 1900, watcher_pid: 4242, watcher_command: "watch-run.ts run" }), shim);
    expect(fresh.rc).toBe(0);
    expect(fresh.stdout.split("\n")[1]).toBe("  dispatcher: alive (pid 4242, no heartbeat yet)");
    // A watcher that hung or stopped before its first heartbeat keeps its pid and command; it must not read alive forever.
    for (const heartbeat_at of [undefined, 0, ""]) {
      const stuck = status(`liveness-never-ticked-${JSON.stringify(heartbeat_at)}`, lease({ armed_at: 1000, watcher_pid: 4242, watcher_command: "watch-run.ts run", ...(heartbeat_at === undefined ? {} : { heartbeat_at }) }), shim);
      expect([JSON.stringify(heartbeat_at), stuck.rc]).toEqual([JSON.stringify(heartbeat_at), 0]);
      expect(stuck.stdout.split("\n")[1]).toBe("  dispatcher: dead (pid 4242 is running but has not ticked in 1000s since arming)");
      // The usual "re-run tap watch on" hint would be a lie here: ensureSidecar reads an empty heartbeat as a
      // just-spawned loop and leaves the live matching watcher alone. The recovery that works is off, then on
      // (`off` deletes the lease and kills the recorded watch window: the oracle's off-window-ours row).
      expect(stuck.stdout).not.toContain("next: re-run");
      expect(stuck.stdout).toContain("  next: the watcher never ticked and re-running `tap watch on` will not replace it; inspect that pid and the `watch` window in the armer's tmux session, then run `tap watch off` (the armer, or --force) followed by `tap watch on`");
      expect(stuck.stdout.endsWith("followed by `tap watch on`\n")).toBe(true);
    }
    // Without a readable arm time the startup bound cannot be measured: unknown, never a guess either way.
    const unmeasured = status("liveness-never-ticked-no-armed-at", lease({ armed_at: "soon", watcher_pid: 4242, watcher_command: "watch-run.ts run" }), shim);
    expect(unmeasured.rc).toBe(1);
    expect(unmeasured.stdout.split("\n")[1]).toBe("  dispatcher: unknown (pid 4242 has not ticked and the arm time is unreadable)");
    expect(unmeasured.stdout).toContain(CLOCK_NEXT);
  });

  test("an unreadable lease reads unknown and does not collapse into dead", () => {
    const got = status("liveness-unreadable", "{not json");
    expect(got.rc).toBe(1); // could not be checked (CLI-EXIT-1, unsafe to check): distinct from dead, which is 2
    expect(got.stdout.split("\n").slice(0, 2)).toEqual(["tap watch: armed", "  dispatcher: unknown (the lease cannot be read)"]);
    expect(got.stdout).not.toContain("dead");
    expect(got.stdout).toContain("  next: tap health");
  });

  test("a lease that is JSON but not an object reads unknown, not dead (no watcher recorded)", () => {
    // A list, a scalar or null has no fields to read: no evidence either way, so it must not present as confirmed attention.
    for (const [label, arm] of [["list", "[1,2]"], ["scalar", "7"], ["string", '"armed"'], ["null", "null"]] as const) {
      const got = status(`liveness-non-object-${label}`, arm);
      expect([label, got.rc, got.stdout.split("\n").slice(0, 2)]).toEqual([label, 1, ["tap watch: armed", "  dispatcher: unknown (the lease is not a JSON object)"]]);
      expect(got.stdout).toContain("  next: tap health");
    }
  });
});

describe("a recorded watcher pid that is present but not a pid", () => {
  test("nonnumeric or negative reads unknown (identity unverifiable); missing, empty or 0 is no watcher, dead", () => {
    for (const bad of ["abc", "-5", "12x", "4.2"]) {
      const got = status(`liveness-bad-pid-${bad}`, lease({ watcher_pid: bad, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }));
      expect([bad, got.rc, got.stdout.split("\n")[1]]).toEqual([bad, 1, `  dispatcher: unknown (the recorded watcher pid '${bad}' is not a valid pid)`]);
      expect(got.stdout).toContain("  next: tap health");
    }
    for (const missing of [undefined, "", 0, "0"]) {
      const got = status(`liveness-missing-pid-${JSON.stringify(missing)}`, lease(missing === undefined ? {} : { watcher_pid: missing }));
      expect([JSON.stringify(missing), got.rc, got.stdout.split("\n")[1]]).toEqual([JSON.stringify(missing), 0, "  dispatcher: dead (no watcher recorded)"]);
    }
  });
});

describe("a running pid is not evidence of the watcher unless the lease names a known signature or a sane clock", () => {
  const shim = (command: string) => ({ SHIM_ALIVE_PID: "4242", SHIM_ALIVE_COMMAND: command });
  test("a live pid with a fresh heartbeat but a missing or unknown recorded command reads unknown, not alive", () => {
    for (const [label, recorded, running] of [["bash", "bash", "bash"], ["missing", undefined, "bash"], ["empty", "", "bash"]] as const) {
      const got = status(`liveness-signature-${label}`, lease({ watcher_pid: 4242, heartbeat_at: 1980, ...(recorded === undefined ? {} : { watcher_command: recorded }) }), shim(running));
      expect([label, got.rc]).toEqual([label, 1]);
      expect(got.stdout.split("\n")[1]).toContain("  dispatcher: unknown (pid 4242's recorded watcher command ");
      // The cause-specific next: `tap health` would not corroborate this (it matches the recorded text against the process).
      expect(got.stdout).not.toContain("  next: tap health");
      expect(got.stdout).toContain(recorded ? `  next: the lease records an unrecognized watcher command '${recorded}'; inspect pid 4242, then rearm with \`tap watch off\` (the armer, or --force) followed by \`tap watch on\`` : "  next: the lease records no watcher command; inspect pid 4242, then rearm with `tap watch off`");
      expect(got.stdout).not.toContain("alive");
    }
    // The retired Bash loop's signature is no longer a known one, even against a process that still shows it.
    const retired = status("liveness-signature-retired", lease({ watcher_pid: 4242, watcher_command: "tap-watch.sh run", heartbeat_at: 1980 }), shim("tap-watch.sh run"));
    expect([retired.rc, retired.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (pid 4242's recorded watcher command 'tap-watch.sh run' is not a known watcher signature)"]);
    // A pid no process holds is dead whatever the record names: no dispatcher runs there, and `tap watch on` recovers.
    const gone = status("liveness-signature-gone", lease({ watcher_pid: 4242, watcher_command: "bash", heartbeat_at: 1980 }), {}, "#!/bin/bash\nexit 1\n");
    expect([gone.rc, gone.stdout.split("\n")[1]]).toEqual([0, "  dispatcher: dead (pid 4242 is not running the watcher)"]);
    const goneMissing = status("liveness-signature-gone-missing", lease({ watcher_pid: 4242, heartbeat_at: 1980 }), {}, "#!/bin/bash\nexit 1\n");
    expect([goneMissing.rc, goneMissing.stdout.split("\n")[1]]).toEqual([0, "  dispatcher: dead (pid 4242 is not running the watcher)"]);
    // A probe that cannot tell stays unknown, whatever the record names.
    const blind = status("liveness-signature-blind", lease({ watcher_pid: 4242, watcher_command: "bash", heartbeat_at: 1980 }), {}, "#!/bin/bash\necho 'ps: cannot read process table' >&2\nexit 2\n");
    expect([blind.rc, blind.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (cannot inspect pid 4242)"]);
    // ...and the opposite branch: an unknown command that is NOT a substring of the real watcher's command line
    // (a substring match would have read dead, exit 2) while the pid is LIVE and runs watch-run.ts is unknown, without comparing it to the process.
    const bogus = status("liveness-signature-bogus", lease({ watcher_pid: 4242, watcher_command: "bogus", heartbeat_at: 1980 }), shim("watch-run.ts run"));
    expect([bogus.rc, bogus.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (pid 4242's recorded watcher command 'bogus' is not a known watcher signature)"]);
  });

  test("a heartbeat or arm time from the future reads unknown, not healthy", () => {
    const future = status("liveness-future-heartbeat", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 2500 }), shim("watch-run.ts run"));
    expect([future.rc, future.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (pid 4242 is running but its heartbeat is 500s in the future)"]);
    // `tap health` never reads either timestamp and would call this live pid alive: the next line names the clock fault.
    expect(future.stdout).not.toContain("  next: tap health");
    expect(future.stdout).toContain(CLOCK_NEXT);
    const futureArm = status("liveness-future-armed-at", lease({ armed_at: 2500, watcher_pid: 4242, watcher_command: "watch-run.ts run" }), shim("watch-run.ts run"));
    expect([futureArm.rc, futureArm.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (pid 4242 has not ticked and the arm time is in the future)"]);
    expect(futureArm.stdout).toContain(CLOCK_NEXT);
  });
});

describe("the ps timeout is a hard bound", () => {
  test("a ps that ignores SIGTERM reads unknown within the bound, not after its own sleep", () => {
    // `trap '' TERM` then exec: the ignored disposition survives the exec, so only a force-kill ends it before 30 s.
    const began = Date.now();
    const got = status("liveness-ps-ignores-term", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }), {}, "#!/bin/bash\ntrap '' TERM\nexec sleep 30\n");
    const elapsed = Date.now() - began;
    expect([got.rc, got.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (cannot inspect pid 4242)"]);
    expect(elapsed).toBeLessThan(15_000);
  }, 40_000);
});

describe("an armed lease with no watcher where a watch window already exists", () => {
  const windowed = (name: string, extra: Record<string, string>) => status(name, lease({}), extra);
  test("status names the window collision and its remediation, not the re-run that cannot recover", () => {
    const got = windowed("liveness-no-watcher-window", { SHIM_WINDOW: "777" });
    expect(got.rc).toBe(0);
    expect(got.stdout.split("\n")[1]).toBe("  dispatcher: dead (no watcher recorded)");
    expect(got.stdout).toContain("  next: a `watch` window already exists in '");
    expect(got.stdout).toContain("but the lease records no watcher, so re-running `tap watch on` leaves it untouched and cannot recover");
    expect(got.stdout).not.toContain("  next: re-run the `tap watch on`");
    // The window may be this watch's own sidecar whose pid was never published; leaving it would repeat the refusal.
    expect(got.stdout).toContain("inspect it (tap health); close it if it is this watch's unrecorded sidecar, or rename it if it belongs to something else, then run `tap watch on`");
  });
  test("a tmux that cannot be inspected keeps the dead verdict and falls back to the re-run hint, noting the limit", () => {
    // `fork failed: Device not configured` is the ServerUnresponsive shape; the optional window lookup must not turn it into a generic failure.
    const got = status("liveness-no-watcher-tmux-blind", lease({}), {}, undefined, "#!/bin/bash\necho 'fork failed: Device not configured' >&2\nexit 1\n");
    expect(got.rc).toBe(0);
    expect(got.stdout.split("\n")[1]).toBe("  dispatcher: dead (no watcher recorded)");
    expect(got.stdout).toContain("  next: re-run the `tap watch on` that armed this (or any `tap remind me`) to respawn the sidecar (tmux could not be inspected for an existing `watch` window; if the re-run leaves it untouched, see tap health)");
  });
  test("with no such window the re-run hint stands (ensureSidecar can spawn)", () => {
    const got = windowed("liveness-no-watcher-nowindow", {});
    expect(got.rc).toBe(0);
    expect(got.stdout).toContain("  next: re-run the `tap watch on` that armed this");
  });
});

describe("a process table that cannot be read", () => {
  const unknownCases: Array<[string, string]> = [
    ["killed by a signal", "#!/bin/bash\nkill -9 $$\n"],
    ["exits 2 with a diagnostic on stderr", "#!/bin/bash\necho 'ps: cannot read process table' >&2\nexit 2\n"],
    ["exits 1 but explains itself on stderr", "#!/bin/bash\necho 'ps: Invalid process id: 4242' >&2\nexit 1\n"],
    ["exits 0 having printed nothing", "#!/bin/bash\nexit 0\n"],
    ["hangs past the bound", "#!/bin/bash\nexec sleep 30\n"],
  ];
  for (const [label, shim] of unknownCases) {
    test(`a \`ps\` ${label} reads unknown, not dead`, () => {
      const got = status(`liveness-ps-${label.replace(/\W+/g, "-")}`, lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 }), {}, shim);
      expect(got.rc).toBe(1); // unsafe to check, not attention
      expect(got.stdout.split("\n").slice(0, 2)).toEqual(["tap watch: armed", "  dispatcher: unknown (cannot inspect pid 4242)"]);
      expect(got.stdout).not.toContain("dead");
      expect(got.stdout).toContain("  next: tap health");
    });
  }
});

describe("dispatcherLiveness", () => {
  test("a lease with no watcher recorded is dead; an unparseable heartbeat on a live pid is unknown", () => {
    expect(dispatcherLiveness({ mode: "reminders" }, 2000).state).toBe("dead");
    // A KNOWN signature plus a ps shim printing a matching command line, so the pid passes the signature gate and the process
    // match and the verdict comes from the heartbeat branch itself (an unrecognized command would exit at the gate first).
    const live = status("liveness-heartbeat-unparseable", lease({ watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: "soon" }), { SHIM_ALIVE_PID: "4242", SHIM_ALIVE_COMMAND: "watch-run.ts run" });
    expect([live.rc, live.stdout.split("\n")[1]]).toEqual([1, "  dispatcher: unknown (pid 4242 is running but its heartbeat is unreadable)"]);
    expect(live.stdout).toContain(CLOCK_NEXT);
    expect(live.stdout).not.toContain("  next: tap health");
  });
});

describe("acting callers keep positive ps evidence", () => {
  test("a ps that prints the watcher and then dies by signal leaves a live sidecar alone (no respawn)", () => {
    // spawnSync reports status null for a signal-terminated ps; the printed command line is still the process, so
    // ensureSidecar must take its already-running path, not kill and respawn a genuine watcher window.
    const c = oracle.cases.find(c => c.case === "on-spawn-ours-alive-fresh")!;
    const printed = 'echo "bash ${SHIM_ALIVE_COMMAND:-tap-watch.sh run}"';
    expect(oracle.shims.ps).toContain(printed);
    // A function replacer: in a replacement string `$$` would collapse to `$` and the shim would never signal itself.
    const got = replay({ ...c, case: "liveness-ps-prints-then-signalled", ps_shim: oracle.shims.ps.replace(printed, () => `${printed}; kill -9 $$`) }, "bin/tap");
    expect([got.rc, got.stdout, got.stderr]).toEqual([0, "tap watch: already armed; keeping current episode since 1000\ntap watch: sidecar already running in session 'sess'\n", ""]);
    expect(got.tmux_log).not.toContain("kill-window");
  }, 30_000);
});

describe("the ps bound belongs to the status surface only", () => {
  test("a slow ps reads unknown from dispatcherLiveness but pidAlive still waits and answers alive", () => {
    // pidAlive's callers act on "not alive" (respawn, reap); a bounded probe there would replace a live watcher on a loaded box.
    const shim = mkdtempSync(join(tmpdir(), "liveness-slow-ps."));
    try {
      writeFileSync(join(shim, "ps"), "#!/bin/bash\nsleep 2.5\necho 'bash watch-run.ts run'\n"); chmodSync(join(shim, "ps"), 0o755);
      const src = join(import.meta.dir, "../src/watch-sidecar.ts");
      const probe = `import { dispatcherLiveness, pidAlive } from ${JSON.stringify(src)};
        const lease = { watcher_pid: 4242, watcher_command: "watch-run.ts run", heartbeat_at: 1980 };
        console.log(JSON.stringify({ status: dispatcherLiveness(lease, 2000).state, alive: pidAlive("4242", "watch-run.ts run") }));`;
      const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: "unknown", alive: true });
    } finally { removeScratchTree(shim); }
  }, 20_000);
});
