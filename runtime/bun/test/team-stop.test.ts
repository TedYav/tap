import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { TapError } from "../src/context";
import { resolveContext, type ResolvedContext } from "../src/context";
import { registryRoster } from "../src/team/selection";
import { deenrollTeamWithCapture, restoreTeamEnrollment } from "../src/index-home";
import { scanTeamOperand, cmdTeamShutdown } from "../src/verbs/team";
import { runTeamStop, type StopEffects } from "../src/team/stop";
import type { LifecycleTmux } from "../src/lifecycle-target";
import { writeLiveFence } from "./support/live-fence";

let seq = 0;
function work(): string {
  return mkdtempSync(join(tmpdir(), "u4-stop-"));
}
function seat(handle: string, session: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    handle, delivery: "pane", pane: `p${seq}`, pane_id: `%${seq}`, server_epoch: "srv:900:100",
    session, status: "active", status_reason: "", crew: false, ...extra,
  };
}
function bus(tapHome: string): Bus {
  const home = join(tapHome, "bus");
  mkdirSync(home, { recursive: true });
  return new Bus(home);
}
function ctx(tapHome: string): ResolvedContext {
  const root = join(tapHome, "root");
  const busHome = join(tapHome, "bus");
  mkdirSync(root, { recursive: true });
  mkdirSync(busHome, { recursive: true });
  // Born live (F1): an unenrolled TAP_HOME bus under an empty machine index.
  const indexHome = join(tapHome, "ctx-index");
  mkdirSync(indexHome, { recursive: true });
  writeFileSync(join(indexHome, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  return resolveContext(root, { TAP_HOME: busHome, TAP_INDEX_HOME: indexHome });
}
function seedRegistry(path: string, seats: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: "/w" }, seats }, null, 2)}\n`);
}
function liveTmuxOf(panes: Map<string, string>): LifecycleTmux {
  return {
    hasSession: (name) => panes.has(name),
    paneSession: (paneId) => {
      for (const [sess, pid] of panes) if (pid === paneId) return sess;
      return null;
    },
    sessionPaneIds: (name) => (panes.has(name) ? [panes.get(name)!] : []),
  };
}

function baseEffects(over: Partial<StopEffects> = {}, panesIn: Array<[string, string]> = []): StopEffects {
  const killed: string[] = [];
  const panes = new Map<string, string>(panesIn);
  const innerKill = over.killSession ?? ((s: string) => { killed.push(s); return true; });
  const defaults: StopEffects = {
    tmux: liveTmuxOf(panes),
    killSession: innerKill,
    hasSession: () => false,
    paneCount: () => 1,
    observeSpare: () => null,
    queueSummary: () => ({ unsettled: 0, counts: new Map() }),
    watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
    identity: {
      tmuxActive: true,
      callingPaneId: "%99",
      selfRefusal: "",
      resolveSelf: () => ({ handle: "boss", pane: "bossPane", paneId: "%99" }),
      displaySession: () => "",
    },
    runId: "424242",
    eventLog: "/nonexistent-events.log",
    io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
  };
  const merged: StopEffects = { ...defaults, ...over };
  // The wrapper re-applies AFTER the spread so an override kill still retires
  // the session's panes and the tx authorization sees a truly dead session.
  merged.killSession = (s) => {
    const ok = innerKill(s);
    if (ok) for (const [id, sess] of panes) if (sess === s) panes.delete(id);
    return ok;
  };
  return merged;
}
function expectTapError(fn: () => unknown, klass: string, action: string, detail: string): void {
  try {
    fn();
    throw new Error(`expected TapError ${klass}`);
  } catch (e) {
    expect(e).toBeInstanceOf(TapError);
    const err = e as TapError;
    expect(err.errorClass).toBe(klass);
    expect(err.action).toBe(action);
    expect(err.detail).toBe(detail);
  }
}

// --- orchestrator: caller identity and zero-row arms -------------------------

test("an unobservable caller pane refuses self-inclusive stops before any observation", () => {
  const t = work();
  try {
    const c = ctx(t);
    for (const [reason, expectedReason] of [["", "reason unavailable"], ["process observation unavailable", "process observation unavailable"]] as const) expectTapError(
      () =>
        runTeamStop({
          verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["bob"],
          effects: baseEffects({ identity: { tmuxActive: true, callingPaneId: "", callingPaneRefusal: reason, selfRefusal: "", resolveSelf: () => null, displaySession: () => "" } }),
        }),
      "caller_identity_unobservable",
      "run tap team down from an observable tmux pane",
      `refusing down because the caller pane is not observable (self-last ordering cannot be guaranteed; caller pane observation: ${expectedReason})`,
    );
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("zero-row clear with a registry that corrupts between dump and locked clear refuses and keeps the lease", () => {
  // Ported from regress/team-stop-watch-lease.test.sh arm 3c:
  // the clear is the commit boundary — until its locked re-read succeeds,
  // nothing past it may run, including the watcher disarm. Helper-level half
  // of the same race: team-stop-clear.test.ts locked-fresh-read rc 5.
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {});
    let accesses = 0;
    let tinted = 0;
    let disarmed = 0;
    const proxied = {
      ...c,
      get registryPath(): string {
        accesses += 1;
        // 1: crewSelectGate, 2: readRowDump (the dump must see clean zero
        // rows), 3: zeroRowArm's existsSync, 4: the locked clear's fresh read
        // — corrupt from the third access on, so the clear re-parses corrupt
        // bytes and refuses at the commit boundary.
        if (accesses >= 3) writeFileSync(c.registryPath, "{corrupt");
        return c.registryPath;
      },
    } as ResolvedContext;
    expectTapError(
      () => runTeamStop({
        verb: "shutdown", policy: "clear", argv: [], ctx: proxied, roster: [],
        effects: baseEffects({
          watch: { isArmed: () => true, clearTints: () => { tinted += 1; }, disarm: () => { disarmed += 1; } },
        }),
      }),
      "registry_unreadable",
      "tap team shutdown (repair or remove the unreadable registry, then re-run)",
      "the registry could not be parsed at the locked clear, so it was RETAINED as-is and nothing was cleared; no seats were registered — helper said: registry present but unreadable; retained without clearing",
    );
    expect(existsSync(c.registryPath)).toBe(true);
    // Retained exactly as the corruption left it — never rewritten or deleted.
    expect(readFileSync(c.registryPath, "utf8")).toBe("{corrupt");
    expect(tinted).toBe(0);
    expect(disarmed).toBe(0);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("an unverifiable tmux generation refuses before pane work", () => {
  const t = work();
  try {
    const c = ctx(t);
    expectTapError(
      () =>
        runTeamStop({
          verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["bob"],
          effects: baseEffects({ identity: { tmuxActive: true, callingPaneId: "%99", selfRefusal: "generation_unverifiable", resolveSelf: () => null, displaySession: () => "" } }),
        }),
      "generation_unverifiable",
      "wait for tmux to answer, then retry tap team down",
      "refusing destructive team lifecycle because the tmux server generation is unavailable and the caller identity cannot be verified",
    );
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("zero-row clear deletes the blank acting registry, disarms after, and captures the index entry", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {});
    const order: string[] = [];
    const artifacts: string[] = [];
    let disarmed = 0;
    const rc = runTeamStop({
      verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: [],
      effects: baseEffects({
        watch: { isArmed: () => true, clearTints: () => order.push("tints"), disarm: () => { disarmed += 1; order.push("disarm"); } },
      }),
    });
    expect(rc).toBe(0);
    expect(existsSync(c.registryPath)).toBe(false);
    expect(disarmed).toBe(1);
    // Capture evidence: the index was de-enrolled with a capture artifact that
    // the zero-row arm disposed of (no self-kill follows).
    expect(order).toContain("disarm");
    expect(artifacts).toEqual([]);
    expect(existsSync(join(c.bus.home, "reset-generation.json"))).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("zero-row non-clear policies keep the registry and say there is nothing to stop", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {});
    let disarmed = 0;
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: [], ctx: c, roster: [],
      effects: baseEffects({ watch: { isArmed: () => false, clearTints: () => {}, disarm: () => { disarmed += 1; } } }),
    });
    expect(rc).toBe(0);
    expect(existsSync(c.registryPath)).toBe(true);
    expect(disarmed).toBe(0);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the watch lease survives suspend and disarms only on committed clear at the mutation boundary", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob") });
    let disarmed = 0;
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["bob"],
      effects: baseEffects({
        identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
        watch: { isArmed: () => true, clearTints: () => {}, disarm: () => { disarmed += 1; } },
      }, [["alpha/bob", "%1"]]),
    });
    expect(rc).toBe(0);
    expect(disarmed).toBe(0);
    expect(existsSync(c.registryPath)).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- orchestrator: teammate loop outcomes ------------------------------------

test("suspend kills each teammate session through the full transaction and stamps the rows", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob", { pane_id: "%1", pane: "p1" }), carol: seat("carol", "alpha/carol", { pane_id: "%2", pane: "p2" }) });
    const killed: string[] = [];
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["bob", "carol"],
      effects: baseEffects({ killSession: (s) => { killed.push(s); return true; } }, [["alpha/bob", "%1"], ["alpha/carol", "%2"]]),
    });
    expect(rc).toBe(0);
    expect(killed).toEqual(["alpha/bob", "alpha/carol"]);
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, { status: string }> };
          expect(doc.seats.bob!.status).toBe("suspended");
          expect(doc.seats.carol!.status).toBe("suspended");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a spare refusal is reported but not counted; a hard refusal is counted", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob") });
    const warnings: string[] = [];
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--except", "bob"], ctx: c, roster: ["bob"],
      effects: baseEffects({
        identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
        io: { stdout: () => {}, stderr: () => {}, warn: (l) => warnings.push(l) },
      }),
    });
    expect(rc).toBe(0);
    expect(existsSync(c.registryPath)).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("clear policy kills via kill_only and post-probes every session", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob", { pane_id: "%1", pane: "p1" }) });
    const probed: string[] = [];
    const rc = runTeamStop({
      verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["bob"],
      effects: baseEffects({
        identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
        hasSession: (s) => { probed.push(s); return false; },
      }, [["alpha/bob", "%1"]]),
    });
    expect(rc).toBe(0);
    // The kill_only transaction probes once inside its own critical section and
    // the engine re-probes per the incumbent's exact post-probe (L2494).
    expect(probed).toEqual(["alpha/bob", "alpha/bob"]);
    expect(existsSync(c.registryPath)).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a session that survives the clear kill is its own counted outcome", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob", { pane_id: "%1", pane: "p1" }) });
    const warnings: string[] = [];
    const rc = runTeamStop({
      verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["bob"],
      effects: baseEffects({
        identity: { tmuxActive: false, callingPaneId: "", selfRefusal: "", resolveSelf: () => null, displaySession: () => "" },
        hasSession: () => true,
        io: { stdout: () => {}, stderr: () => {}, warn: (l) => warnings.push(l) },
      }, [["alpha/bob", "%1"]]),
    });
    expect(rc).toBe(1);
    expect(warnings.some((l) => l.includes("session 'alpha/bob' still live after kill"))).toBe(true);
    // tap-a3xt: the survivor is reported as its own counted outcome, never as a
    // generic refusal, whatever the transaction's detail text says.
    expect(warnings.filter((l) => l.includes("still live after kill"))).toEqual([
      "tap team shutdown: warning: session 'alpha/bob' still live after kill",
    ]);
    expect(warnings.some((l) => l.includes("not killing session"))).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("recovery allocation failure refuses the clear with already-stopped names and keeps the caller alive", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob"), carol: seat("carol", "alpha/carol") });
    const killed: string[] = [];
    const locked = join(t, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    expectTapError(
      () =>
        runTeamStop({
          verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["bob", "carol"],
          effects: baseEffects({
            identity: { tmuxActive: true, callingPaneId: "%99", selfRefusal: "", resolveSelf: () => ({ handle: "boss", pane: "bossPane", paneId: "%99" }), displaySession: () => "alpha/boss" },
            killSession: (s) => { killed.push(s); return true; },
            bufferDir: locked,
          }),
        }),
      "recovery_unavailable",
      "tap team shutdown (retry once a temporary directory is writable)",
      "cannot allocate the adopted-seat terminal bridge; refusing before any session is stopped, because a seat adopted under the lock would be stopped with no durable record",
    );
    expect(killed).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- public fence vs internal reset ------------------------------------------

test("the public shutdown entry fences a mid-reset bus; the internal reset-stop does not", () => {
  const t = work();
  try {
    const c = ctx(t);
    writeLiveFence(join(c.bus.home, "reset.fence.json"));
    seedRegistry(c.registryPath, {});
    expectTapError(
      () => runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: [], fenced: true, effects: baseEffects() }),
      "team_reset_fenced",
      "wait for the reset owner (or until identity is readable)",
      "refusing shutdown — team bus is mid-reset (fence at " + join(c.bus.home, "reset.fence.json") + ")",
    );
    const rc = runTeamStop({
      verb: "reset-stop", policy: "none", argv: [], ctx: c, roster: [],
      effects: baseEffects({ watch: { isArmed: () => true, clearTints: () => {}, disarm: () => { throw new Error("must not disarm"); } } }),
    });
    expect(rc).toBe(0);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- named team operand: the caller's own pane (tap-lg1a5) --------------------

function crewInCallerSession(t: string, namedTeam: string | undefined): { rc: number; killed: string[] } {
  const c = ctx(t);
  const host = seat("host", "ops/main");
  const worker = seat("worker", "alpha/worker");
  seedRegistry(c.registryPath, { host, worker });
  const killed: string[] = [];
  const effects = baseEffects({
    killSession: (s) => { killed.push(s); return true; },
    // The caller is not a seat of the named team, but its pane lives in the
    // session one of that team's rows was registered into.
    identity: { tmuxActive: true, callingPaneId: "%99", selfRefusal: "", resolveSelf: () => null, displaySession: () => "ops/main" },
  }, [["ops/main", String(host.pane_id)], ["alpha/worker", String(worker.pane_id)]]);
  const rc = runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["host", "worker"], effects, namedTeam });
  return { rc, killed };
}

test("a named foreign team never stops the caller's own session", () => {
  const t = work();
  try {
    const { rc, killed } = crewInCallerSession(t, "alpha");
    expect(rc).toBe(0);
    expect(killed).toEqual(["alpha/worker"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("without a named team the caller's session keeps today's self-last stop", () => {
  const t = work();
  try {
    const { killed } = crewInCallerSession(t, undefined);
    expect(killed).toEqual(["alpha/worker", "ops/main"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- lifecycle operand scan (team.ts) ---------------------------------------

test("the positional scan takes the first bare word as target and refuses a second", () => {
  expect(scanTeamOperand(["--json", "beta"])).toEqual({ target: "beta", extra: false, rest: ["--json"] });
  expect(scanTeamOperand(["--except", "bob", "beta"])).toEqual({
    target: "beta",
    extra: false,
    rest: ["--except", "bob"],
  });
  expect(scanTeamOperand(["beta", "gamma"])).toEqual({ target: "beta", extra: true, rest: ["gamma"] });
  expect(scanTeamOperand(["--dry-run"])).toEqual({ target: undefined, extra: false, rest: ["--dry-run"] });
  expect(scanTeamOperand(["--only", "--yes", "alpha"])).toEqual({ target: undefined, extra: true, rest: ["--only", "--yes", "alpha"] });
});

// --- index-home capture and restore -------------------------------------------

function indexFixture(t: string): { indexHome: string; gpath: string; team: string; entry: Record<string, unknown> } {
  const indexHome = join(t, "index");
  mkdirSync(indexHome, { recursive: true });
  const gpath = join(indexHome, "global-registry.json");
  const entry = { root: join(t, "root"), registry_location: join(t, "bus", "registry.json"), registered_at: "2026-01-01T00:00:00Z" };
  writeFileSync(gpath, `${JSON.stringify({ schema: "0.20", teams: { alpha: entry } }, null, 2)}\n`);
  return { indexHome, gpath, team: "alpha", entry };
}

test("deenrollTeamWithCapture refuses when the acting registry still exists and captures when absent", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    const artifact = join(t, "capture.json");
    mkdirSync(join(t, "bus"), { recursive: true });
    writeFileSync(f.entry.registry_location as string, "{}\n");
    const refused = deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(6);
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams.alpha).toBeDefined();
    rmSync(f.entry.registry_location as string);
    const done = deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome });
    expect(done.ok).toBe(true);
    const env = JSON.parse(readFileSync(artifact, "utf8")) as Record<string, unknown>;
    expect(env.authority).toBe("live");
    expect(env.team).toBe("alpha");
    expect((env.entry as Record<string, unknown>).registry_location).toBe(f.entry.registry_location);
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams.alpha).toBeUndefined();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("restoreTeamEnrollment refuses a recreated key and a wrong team, retaining the artifact", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    const artifact = join(t, "capture.json");
    rmSync(f.entry.registry_location as string, { force: true });
    expect(deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome }).ok).toBe(true);
    // The restore door checks the acting registry BEFORE the recreated key
    // (H1-faithful order), so the file must be back on disk for this arm.
    writeFileSync(f.entry.registry_location as string, "{}\n");
    // Key recreated -> refusal class 2, artifact retained.
    const doc = JSON.parse(readFileSync(f.gpath, "utf8"));
    doc.teams.alpha = { root: "/elsewhere", registry_location: "/elsewhere/registry.json" };
    writeFileSync(f.gpath, `${JSON.stringify(doc, null, 2)}\n`);
    const recreated = restoreTeamEnrollment({ team: f.team, artifact, indexHome: f.indexHome });
    expect(recreated.ok).toBe(false);
    if (!recreated.ok) expect(recreated.code).toBe(2);
    expect(existsSync(artifact)).toBe(true);
    // Wrong team in the envelope -> class 4.
    const wrong = restoreTeamEnrollment({ team: "other", artifact, indexHome: f.indexHome });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe(4);
    // Success: registry back on disk, key removed again.
    rmSync(f.entry.registry_location as string, { force: true });
    const doc2 = JSON.parse(readFileSync(f.gpath, "utf8"));
    delete doc2.teams.alpha;
    writeFileSync(f.gpath, `${JSON.stringify(doc2, null, 2)}\n`);
    writeFileSync(f.entry.registry_location as string, "{}\n");
    const restored = restoreTeamEnrollment({ team: f.team, artifact, indexHome: f.indexHome });
    expect(restored.ok).toBe(true);
    const after = JSON.parse(readFileSync(f.gpath, "utf8"));
    expect(after.teams.alpha).toEqual(f.entry);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("restoreTeamEnrollment refuses a foreign index without touching its bytes", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    const artifact = join(t, "capture.json");
    rmSync(f.entry.registry_location as string, { force: true });
    expect(deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome }).ok).toBe(true);
    // A different index home that happens to carry the same schema must not
    // be written by a restore addressed at the capturing index's coordinates.
    const foreign = join(t, "index-b");
    mkdirSync(foreign, { recursive: true });
    const gpathB = join(foreign, "global-registry.json");
    writeFileSync(gpathB, `${JSON.stringify({ schema: "0.20", teams: {} }, null, 2)}\n`);
    const before = readFileSync(gpathB, "utf8");
    const refused = restoreTeamEnrollment({ team: f.team, artifact, indexHome: foreign });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(4);
    expect(readFileSync(gpathB, "utf8")).toBe(before);
    expect(existsSync(artifact)).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("restoreTeamEnrollment refuses a tampered envelope witness before touching the index", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    const artifact = join(t, "capture.json");
    rmSync(f.entry.registry_location as string, { force: true });
    expect(deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome }).ok).toBe(true);
    const afterCapture = readFileSync(f.gpath, "utf8");
    const pristine = readFileSync(artifact, "utf8");
    // A root that no longer matches the captured witness is an artifact
    // defect (class 3): the envelope fails verification before any lock.
    const tamperedRoot = join(t, "capture-root.json");
    const envRoot = JSON.parse(pristine) as Record<string, unknown>;
    (envRoot.entry as Record<string, unknown>).root = join(t, "elsewhere");
    writeFileSync(tamperedRoot, `${JSON.stringify(envRoot, null, 2)}\n`);
    const refusedRoot = restoreTeamEnrollment({ team: f.team, artifact: tamperedRoot, indexHome: f.indexHome });
    expect(refusedRoot.ok).toBe(false);
    if (!refusedRoot.ok) expect(refusedRoot.code).toBe(3);
    // Same for a registry_location witness rewritten to a foreign path.
    const tamperedRegistry = join(t, "capture-registry.json");
    const envRegistry = JSON.parse(pristine) as Record<string, unknown>;
    (envRegistry.entry as Record<string, unknown>).registry_location = "/elsewhere/registry.json";
    writeFileSync(tamperedRegistry, `${JSON.stringify(envRegistry, null, 2)}\n`);
    const refusedRegistry = restoreTeamEnrollment({ team: f.team, artifact: tamperedRegistry, indexHome: f.indexHome });
    expect(refusedRegistry.ok).toBe(false);
    if (!refusedRegistry.ok) expect(refusedRegistry.code).toBe(3);
    expect(readFileSync(f.gpath, "utf8")).toBe(afterCapture);
    expect(existsSync(tamperedRoot)).toBe(true);
    expect(existsSync(tamperedRegistry)).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("deenrollTeamWithCapture refuses an unprobeable registry path and keeps the key", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    // A self-referential symlink makes every stat of the registry path fail
    // with ELOOP: deenroll must refuse (class 6) without removing the key or
    // publishing an artifact.
    const loop = join(t, "loop");
    symlinkSync(loop, loop);
    const entry = { ...(f.entry as Record<string, unknown>), registry_location: loop };
    writeFileSync(f.gpath, `${JSON.stringify({ schema: "0.20", teams: { alpha: entry } }, null, 2)}\n`);
    const artifact = join(t, "capture.json");
    const refused = deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: loop, indexHome: f.indexHome });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(6);
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams.alpha).toEqual(entry);
    expect(existsSync(artifact)).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("deenrollTeamWithCapture returns a best-effort failure when the capture artifact cannot be written", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    // atomicWrite mints its temp file in the destination directory and renames
    // onto the artifact, so an artifact path that is a DIRECTORY fails the
    // rename (EISDIR) while the directory itself is writable.
    const artifact = join(t, "capture-blocked");
    mkdirSync(artifact);
    rmSync(f.entry.registry_location as string, { force: true });
    const refused = deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(3);
    // The key survives: a capture that cannot publish must not de-enroll.
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams.alpha).toBeDefined();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("deenrollTeamWithCapture keeps the capture artifact when the index write fails", () => {
  // Directory permissions cannot isolate the final write: the flock handshake
  // mints its grant marker next to each lock, so a read-only index home fails
  // acquisition ("legacy index lock busy") before any write is attempted. The
  // portable-ish equivalent is the macOS immutable flag on the index itself:
  // locks, marker probe and reads all succeed, only the final rename fails.
  if (process.platform !== "darwin") return;
  const t = work();
  const f = indexFixture(t);
  const flag = (on: boolean) => spawnSync("chflags", [on ? "uchg" : "nouchg", f.gpath]);
  try {
    const artifact = join(t, "capture.json");
    rmSync(f.entry.registry_location as string, { force: true });
    expect(flag(true).status).toBe(0);
    const refused = deenrollTeamWithCapture({ team: f.team, artifact, expectRoot: f.entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe(3);
      expect(refused.detail).toContain("could not be written");
      // The envelope is the only copy of the pending key removal: retained.
      expect(refused.artifact).toBe(artifact);
    }
    expect(existsSync(artifact)).toBe(true);
    expect(JSON.parse(readFileSync(artifact, "utf8")).team).toBe("alpha");
    expect(JSON.parse(readFileSync(f.gpath, "utf8")).teams.alpha).toBeDefined();
  } finally {
    flag(false);
    rmSync(t, { recursive: true, force: true });
  }
});

test("restoreTeamEnrollment tests team membership with own-property semantics", () => {
  const t = work();
  try {
    const f = indexFixture(t);
    const entry = { root: f.entry.root, registry_location: f.entry.registry_location, registered_at: "2026-01-01T00:00:00Z" };
    writeFileSync(f.gpath, `${JSON.stringify({ schema: "0.20", teams: { constructor: entry } }, null, 2)}\n`);
    const artifact = join(t, "capture.json");
    rmSync(f.entry.registry_location as string, { force: true });
    expect(deenrollTeamWithCapture({ team: "constructor", artifact, expectRoot: entry.root as string, expectRegistry: f.entry.registry_location as string, indexHome: f.indexHome }).ok).toBe(true);
    // The own key is gone, but a bare read still resolves "constructor"
    // through Object.prototype: only an own-property probe proves absence.
    const doc = JSON.parse(readFileSync(f.gpath, "utf8"));
    expect(Object.hasOwn(doc.teams, "constructor")).toBe(false);
    writeFileSync(f.gpath, `${JSON.stringify({ schema: "0.20", teams: {} }, null, 2)}\n`);
    writeFileSync(f.entry.registry_location as string, "{}\n");
    const back = restoreTeamEnrollment({ team: "constructor", artifact, indexHome: f.indexHome });
    expect(back.ok).toBe(true);
    const after = JSON.parse(readFileSync(f.gpath, "utf8"));
    expect(Object.hasOwn(after.teams, "constructor")).toBe(true);
    expect(after.teams.constructor).toEqual(entry);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- review round 1: driver probe arms + output/pin/lock controls ------------

const io = (over: Partial<StopEffects["io"]> = {}): { io: StopEffects["io"]; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l), warn: (l) => err.push(l), ...over } as StopEffects["io"],
  };
};

function withEnv(over: Record<string, string | undefined>, fn: () => unknown): void {
  const keys = ["TAP_INDEX_HOME", "TAP_HOME", "TAP_BUS_RULE", "TAP_REGISTRY", "TAP_JSON", "TAP_TEAM_SELECT", "TMUX_TMPDIR"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (k in over) {
      if (over[k] === undefined) delete process.env[k];
      else process.env[k] = over[k]!;
    }
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test("ordinary JSON dry-run emits its plan receipt", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob") });
    const capture = io();
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--json", "--dry-run"], ctx: c, roster: ["bob"],
      effects: baseEffects({ io: capture.io }, [["alpha/bob", "%1"]]),
    });
    expect(rc).toBe(0);
    expect(capture.out).toHaveLength(1);
    expect(JSON.parse(capture.out[0]!).dry_run).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("JSON dry-run still emits the inbound advisory on stderr", () => {
  // tap-7r9c regression arm: the advisory is computed outside the !wantJson
  // guard, so a --json --dry-run caller still sees the unprocessed inbound
  // payload warning (exactly one stderr line, one stdout receipt line).
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob") });
    const capture = io();
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--json", "--dry-run"], ctx: c, roster: ["bob"],
      effects: baseEffects({
        io: capture.io,
        queueSummary: () => ({ unsettled: 3, counts: new Map([["bob", 2], ["carol", 1]]) }),
      }, [["alpha/bob", "%1"]]),
    });
    expect(rc).toBe(0);
    expect(capture.out).toHaveLength(1);
    expect(JSON.parse(capture.out[0]!).dry_run).toBe(true);
    expect(capture.err).toHaveLength(1);
    expect(capture.err[0]).toContain("3 unprocessed inbound payload(s)");
    expect(capture.err[0]).toContain("seat counts: bob=2; carol=1");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a clear self-auth refusal is counted and warned, not silent", () => {
  // Plan-time self classification succeeds, but the teammate kill mutates the
  // caller's registered pane identity, so the locked authorize_only re-read
  // refuses the self kill: rc 1 (refusedCount) plus the suspend-arm warning.
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss", { pane_id: "%9" }), carol: seat("carol", "alpha/carol") });
    const capture = io();
    const effects = baseEffects({
      io: capture.io,
      killSession: (s) => {
        if (s === "alpha/carol") {
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, { pane_id: string }> };
          doc.seats.boss!.pane_id = "%999";
          writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
        }
        return true;
      },
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]);
    const rc = runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["boss", "carol"], effects });
    expect(rc).toBe(1);
    const warned = capture.err.filter((l) => l.includes("not killing own session 'alpha/boss'"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("pane identity changed before kill");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("self authorization pins its crew through final clear after a same-handle replacement", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {
      boss: seat("boss", "alpha/boss", { pane_id: "%9", pane: "p9", instance: "parent-one" }),
      child: seat("child", "alpha/boss", { pane_id: "%10", pane: "p10", instance: "child-one", crew: true }),
    });
    let authorized = false, kills = 0;
    const effects = baseEffects({
      stopTx: input => {
        expect(input.mode).toBe("authorize_only");
        authorized = true;
        const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, { instance: string }> };
        doc.seats.child!.instance = "child-replacement";
        writeFileSync(c.registryPath, `${JSON.stringify(doc)}\n`);
        return { outcome: { kind: "authorized" }, adopted: [], retained: [], unrecorded: [], warnings: [],
          approvedCrew: ["child"], approvedCrewInstances: [["child", "child-one"]] };
      },
      killSession: () => { kills++; return true; },
      identity: { tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "p9", paneId: "%9" }), displaySession: () => "alpha/boss" },
    }, [["alpha/boss", "%9"]]);
    const bound = { team: { team: c.team, root: c.root, registryPath: c.registryPath, context: c },
      seats: new Map([["boss", { handle: "boss", instance: "parent-one", session: "alpha/boss", paneId: "%9", serverEpoch: "srv:900:100" }]]),
      selection: { mode: "--only" as const, only: ["boss"], except: [] },
      original: { mode: "--only" as const, only: ["boss"], except: [] },
      approvedCrewAtConsent: new Map([["child", { instance: "child-one", session: "alpha/boss" }]]),
    };
    expect(() => runTeamStop({ verb: "shutdown", policy: "clear", argv: ["--only", "boss"], ctx: c,
      roster: ["boss", "child"], effects, bound })).toThrow(TapError);
    expect(authorized).toBe(true);
    expect(kills).toBe(0);
    expect((JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, { instance: string }> }).seats.child?.instance).toBe("child-replacement");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("clear retains a --keep-self row when another teammate is stopped", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss"), carol: seat("carol", "alpha/carol") });
    const rc = runTeamStop({
      verb: "shutdown", policy: "clear", argv: ["--keep-self"], ctx: c, roster: ["boss", "carol"],
      effects: baseEffects({
        identity: {
          tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
          resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
          displaySession: () => "alpha/boss",
        },
      }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]),
    });
    expect(rc).toBe(0);
    expect(existsSync(c.registryPath)).toBe(true);
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
    expect(Object.keys(doc.seats)).toEqual(["boss"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("an excepted caller is not misclassified as a pending self kill", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss"), carol: seat("carol", "alpha/carol") });
    const effects = baseEffects({
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]);
    expect(() => runTeamStop({ verb: "shutdown", policy: "clear", argv: ["--except", "boss"], ctx: c, roster: ["boss", "carol"], effects })).not.toThrow();
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
    expect(Object.keys(doc.seats)).toEqual(["boss"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("failed self kill rolls the prepared caller row back and consumes its journal", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss") });
    const effects = baseEffects({
      killSession: () => true,
      hasSession: () => true,
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"]]);
    expect(runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["boss"], effects })).toBe(1);
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, { status: string }> };
    expect(doc.seats.boss?.status).toBe("active");
    expect(existsSync(`${c.registryPath}.self-last-journal.424242.json`)).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a non-string session field refuses before any destructive target is used", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: { ...seat("bob", "unused"), session: 123 } });
    const killed: string[] = [];
    let thrown: unknown;
    try {
      runTeamStop({
        verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["bob"],
        effects: baseEffects({ killSession: (s) => { killed.push(s); return true; } }, [["123", "%1"]]),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TapError);
    expect((thrown as TapError).errorClass).toBe("registry_invalid");
    expect(killed).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("argument and engine refusals carry the subcommand verb label", () => {
  const t = work();
  try {
    const c = ctx(t);
    try {
      runTeamStop({ verb: "down", policy: "suspend", argv: ["--bogus"], ctx: c, roster: ["bob"], effects: baseEffects() });
      throw new Error("expected TapError");
    } catch (e) {
      expect(e).toBeInstanceOf(TapError);
      expect((e as TapError).verbLabel).toBe("tap team down");
    }
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a correction receipt does not re-emit the spare receipt lines", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss"), carol: seat("carol", "alpha/carol") });
    const capture = io();
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--except", "carol"], ctx: c, roster: ["boss", "carol"],
      effects: baseEffects({
        io: capture.io,
        killSession: () => true,
        hasSession: () => true,
        identity: {
          tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
          resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
          displaySession: () => "alpha/boss",
        },
      }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]),
    });
    expect(rc).toBe(1);
    // The PLAN prints an indented `spared by --except ...` line; the receipt's
    // spare line (`tap team down: spared ...`) must appear exactly once — the
    // correction receipt does not re-emit it.
    const spareLines = capture.out.filter((l) => /^tap team down: spared /.test(l));
    expect(spareLines.length).toBe(1);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the live receipt names a co-tenant spared with the typed --except seat", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {
      alice: seat("alice", "alpha/alice"),
      bob: seat("bob", "alpha/shared"),
      carol: seat("carol", "alpha/shared"),
    });
    const capture = io();
    const killed: string[] = [];
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--except", "bob"], ctx: c, roster: ["alice", "bob", "carol"],
      effects: baseEffects({
        io: capture.io,
        killSession: (s) => { killed.push(s); return true; },
        hasSession: () => false,
        identity: {
          tmuxActive: true, callingPaneId: "%99", selfRefusal: "",
          resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%99" }),
          displaySession: () => "other/boss",
        },
      }, [["alpha/alice", "%1"], ["alpha/shared", "%2"]]),
    });
    expect(rc).toBe(0);
    expect(killed).toEqual(["alpha/alice"]);
    expect(capture.out.filter((l) => /^tap team down: spared /.test(l))).toEqual([
      "tap team down: spared 2 seat(s) by --except: bob (spared: bob, carol)",
    ]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("deenrollBestEffort is silent for an unindexed bus team under a live index", () => {
  const t = work();
  try {
    const c = ctx(t);
    expect(c.selection?.authority).toBe("bus");
    const indexHome = join(t, "index");
    mkdirSync(indexHome, { recursive: true });
    writeFileSync(join(indexHome, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    const capture = io();
    withEnv({ TAP_INDEX_HOME: indexHome }, () => {
      const rc = runTeamStop({
        verb: "shutdown", policy: "clear", argv: ["--json"], ctx: c, roster: [],
        effects: baseEffects({ io: capture.io }),
      });
      expect(rc).toBe(0);
    });
    expect(capture.err.filter((l) => l.toLowerCase().includes("index"))).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- review round 1: door-level pin precedence and composition controls ------

test("the invalid-flip gate refuses before any target handling, with the door label", () => {
  const t = work();
  try {
    const indexHome = join(t, "index");
    mkdirSync(indexHome, { recursive: true });
    writeFileSync(join(indexHome, "global-registry.json"), "{ not json");
    let thrown: unknown;
    withEnv({ TAP_INDEX_HOME: indexHome }, () => {
      try {
        cmdTeamShutdown(["alpha"], t);
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBeInstanceOf(TapError);
    expect((thrown as TapError).errorClass).toBe("invalid_flip");
    expect((thrown as TapError).verbLabel).toBe("tap team");
    expect((thrown as TapError).detail).toContain("global-registry.json is present but unreadable or wrong schema");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("door pin precedence: a named team with --only composes; conflicting pins refuse", () => {
  const t = work();
  try {
    const root = join(t, "root");
    const busHome = join(root, ".tap", "bus");
    const indexHome = join(t, "index");
    mkdirSync(busHome, { recursive: true });
    mkdirSync(indexHome, { recursive: true });
    mkdirSync(root, { recursive: true });
    const registryLocation = join(busHome, "registry.json");
    writeFileSync(join(indexHome, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: { alpha: { root, registry_location: registryLocation } },
    })}\n`);
    // The enrollment verdict requires the acting registry to be on disk.
    writeFileSync(registryLocation, "{}\n");
    const acting = join(busHome, "registry.json");

    // Fable composition pin (Range A), CAUSAL form: from outside the checkout,
    // `shutdown alpha --only bob` composes — the selector value is not an
    // extra positional, the agreeing default TAP_REGISTRY is not a caller pin,
    // and the run carries through to real state: bob's session is stopped,
    // carol's session and registry row are retained, and the named positional
    // became TAP_TEAM_SELECT for downstream helpers.
    const tmuxDir = join(t, "tmux");
    mkdirSync(tmuxDir, { recursive: true });
    mkdirSync(join(busHome, "payloads"), { recursive: true });
    mkdirSync(join(busHome, "receipts"), { recursive: true });
    const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
    const tm = (args: string[]) => spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv });
    const paneIdOf = (session: string): string => {
      const out = tm(["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"]).stdout?.trim() ?? "";
      expect(out).toMatch(/^%/);
      return out;
    };
    try {
      expect(tm(["new-session", "-d", "-s", "alpha/bob", "cat"]).status).toBe(0);
      expect(tm(["new-session", "-d", "-s", "alpha/carol", "cat"]).status).toBe(0);
      seedRegistry(registryLocation, {
        bob: { ...seat("bob", "alpha/bob"), pane: "bob-pane", pane_id: paneIdOf("alpha/bob") },
        carol: { ...seat("carol", "alpha/carol"), pane: "carol-pane", pane_id: paneIdOf("alpha/carol") },
      });
      let rc: number | Promise<number> = -1;
      withEnv({
        TAP_INDEX_HOME: indexHome, TAP_HOME: busHome, TAP_BUS_RULE: "env",
        TAP_REGISTRY: undefined, TAP_JSON: undefined, TAP_TEAM_SELECT: undefined,
        TMUX_TMPDIR: tmuxDir,
      }, () => {
        rc = cmdTeamShutdown(["alpha", "--only", "bob"], t);
        expect(process.env.TAP_TEAM_SELECT).toBe("alpha");
      });
      expect(rc).toBe(0);
      expect(tm(["has-session", "-t", "=alpha/bob"]).status).not.toBe(0);
      expect(tm(["has-session", "-t", "=alpha/carol"]).status).toBe(0);
      const doc = JSON.parse(readFileSync(registryLocation, "utf8")) as { seats: Record<string, unknown> };
      expect(Object.keys(doc.seats)).toEqual(["carol"]);
    } finally {
      tm(["kill-server"]);
    }

    // A genuine acting-registry pin that disagrees refuses.
    withEnv({
      TAP_INDEX_HOME: indexHome, TAP_HOME: busHome, TAP_BUS_RULE: "env",
      TAP_REGISTRY: join(t, "elsewhere", "registry.json"),
    }, () => {
      let thrown: unknown;
      try {
        cmdTeamShutdown(["alpha"], t);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TapError);
      expect((thrown as TapError).errorClass).toBe("usage_error");
      expect((thrown as TapError).verbLabel).toBe("tap team");
      expect((thrown as TapError).detail).toContain(`is not team 'alpha' acting registry ('${acting}')`);
    });

    // A conflicting TAP_HOME pin refuses before the registry pin is consulted.
    const otherBus = join(t, "other", ".tap", "bus");
    mkdirSync(otherBus, { recursive: true });
    withEnv({
      TAP_INDEX_HOME: indexHome, TAP_HOME: otherBus, TAP_BUS_RULE: "env",
      TAP_REGISTRY: undefined,
    }, () => {
      let thrown: unknown;
      try {
        cmdTeamShutdown(["alpha"], t);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TapError);
      expect((thrown as TapError).detail).toContain("refusing to override a caller pin");
      expect((thrown as TapError).detail).toContain("pinned TAP_HOME");
    });

    // --json is exported before ANY refusal, so pin refusals render as JSON.
    withEnv({
      TAP_INDEX_HOME: indexHome, TAP_HOME: otherBus, TAP_BUS_RULE: "env",
      TAP_JSON: undefined,
    }, () => {
      expect(() => cmdTeamShutdown(["--json", "alpha"], t)).toThrow(TapError);
      expect(process.env.TAP_JSON).toBe("1");
    });
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- review round 2: adoption bridge, keep-self sessions, dump envelope ------

test("a successfully killed late adopted row is not retained by clear", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/shared") });
    let injected = false;
    const effects = baseEffects({
      tmux: {
        hasSession: (s) => s === "alpha/shared",
        paneSession: (p) => (p === "%1" || p === "%2" ? "alpha/shared" : null),
        sessionPaneIds: () => ["%1", "%2"],
      },
      hasSession: () => false,
      queueSummary: () => {
        if (!injected) {
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.late = { ...seat("late", "alpha/shared"), pane: "late-pane", pane_id: "%2" };
          writeFileSync(c.registryPath, `${JSON.stringify(doc)}\n`);
          injected = true;
        }
        return { unsettled: 0, counts: new Map() };
      },
    });
    // Fix 3 discloses a failed killed-event append through the unrecorded
    // contract: the seat was stopped, so the run exits 1 even though the
    // retention effect (registry cleared) still holds.
    expect(runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["bob"], effects })).toBe(1);
    expect(existsSync(c.registryPath)).toBe(false);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a refused session retains its rows and its late adopted row", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/x") });
    let injected = false;
    const effects = baseEffects({
      tmux: {
        hasSession: (s) => s === "alpha/x",
        paneSession: (p) => (p === "%1" || p === "%2" ? "alpha/x" : null),
        sessionPaneIds: () => ["%1", "%2"],
      },
      killSession: () => true,
      hasSession: () => true,
      queueSummary: () => {
        if (!injected) {
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.late = { ...seat("late", "alpha/x"), pane: "late-pane", pane_id: "%2" };
          writeFileSync(c.registryPath, `${JSON.stringify(doc)}\n`);
          injected = true;
        }
        return { unsettled: 0, counts: new Map() };
      },
    });
    expect(runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["bob"], effects })).toBe(1);
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
    expect(Object.keys(doc.seats).sort()).toEqual(["bob", "late"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("keep-self without a classified caller row reports no spared self session", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob") });
    const capture = io();
    const effects = baseEffects({
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => null,
        displaySession: () => "alpha/outside",
      },
      io: capture.io,
    }, [["alpha/bob", "%1"], ["alpha/outside", "%9"]]);
    const rc = runTeamStop({
      verb: "down", policy: "suspend", argv: ["--json", "--dry-run", "--keep-self"], ctx: c, roster: ["bob"], effects,
    });
    expect(rc).toBe(0);
    expect(JSON.parse(capture.out[0]!).spared_sessions).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a truthy non-object team envelope refuses like the incumbent dump", () => {
  const t = work();
  try {
    const c = ctx(t);
    writeFileSync(c.registryPath, `${JSON.stringify({ schema: 20, team: 7, seats: { bob: seat("bob", "alpha/bob") } })}\n`);
    let thrown: unknown;
    try {
      runTeamStop({
        verb: "down", policy: "suspend", argv: ["--dry-run"], ctx: c, roster: ["bob"],
        effects: baseEffects({}, [["alpha/bob", "%1"]]),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TapError);
    expect((thrown as TapError).errorClass).toBe("registry_invalid");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a non-boolean crew value is ordinary, not a registry refusal", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/bob", { crew: "yes" }) });
    expect(() =>
      runTeamStop({
        verb: "down", policy: "suspend", argv: ["--dry-run"], ctx: c, roster: ["bob"],
        effects: baseEffects({}, [["alpha/bob", "%1"]]),
      }),
    ).not.toThrow();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- review round 3: terminal adoption vs retention adoption -----------------

test("a refused transaction never emits killed for a row it merely adopted for retention", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { bob: seat("bob", "alpha/shared") });
    let injected = false;
    const capture = io();
    const effects = baseEffects({
      tmux: {
        hasSession: (s) => s === "alpha/shared",
        paneSession: (p) => (p === "%1" || p === "%2" || p === "%3" ? "alpha/shared" : null),
        sessionPaneIds: () => ["%1", "%2", "%3"],
      },
      io: capture.io,
      queueSummary: () => {
        if (!injected) {
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.late1 = { ...seat("late1", "alpha/shared"), pane: "late1-pane", pane_id: "%2" };
          doc.seats.late2 = { ...seat("late2", "alpha/shared"), pane: "late2-pane", pane_id: "%3" };
          writeFileSync(c.registryPath, `${JSON.stringify(doc)}\n`);
          injected = true;
        }
        return { unsettled: 0, counts: new Map() };
      },
    });
    const rc = runTeamStop({
      verb: "shutdown", policy: "clear", argv: ["--only", "bob,late1"], ctx: c, roster: ["bob", "late1"], effects,
    });
    expect(rc).toBe(0);
    const events = existsSync(effects.eventLog) ? readFileSync(effects.eventLog, "utf8") : "";
    expect(events).not.toContain("action=killed handle=late1");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("authorized self adoption does not postpone index de-enrollment past the self kill", () => {
  const t = work();
  try {
    const root = join(t, "root");
    const home = join(root, ".tap", "bus");
    const indexHome = join(t, "index");
    mkdirSync(home, { recursive: true });
    mkdirSync(indexHome, { recursive: true });
    const registry = join(home, "registry.json");
    writeFileSync(join(indexHome, "global-registry.json"), `${JSON.stringify({ schema: "0.20", teams: { alpha: { root, registry_location: registry } } })}\n`);
    seedRegistry(registry, { boss: seat("boss", "alpha/boss") });
    const c = resolveContext(root, { TAP_HOME: home, TAP_INDEX_HOME: indexHome });
    let injected = false;
    const effects = baseEffects({
      tmux: {
        hasSession: (s) => s === "alpha/boss",
        paneSession: (p) => (p === "%9" || p === "%2" ? "alpha/boss" : null),
        sessionPaneIds: () => ["%9", "%2"],
      },
      queueSummary: () => {
        if (!injected) {
          const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.late = { ...seat("late", "alpha/boss"), pane: "late-pane", pane_id: "%2" };
          writeFileSync(registry, `${JSON.stringify(doc)}\n`);
          injected = true;
        }
        return { unsettled: 0, counts: new Map() };
      },
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"]]);
    let rc = -1;
    withEnv({ TAP_INDEX_HOME: indexHome }, () => {
      rc = runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["boss"], effects });
    });
    expect(rc).toBe(0);
    const index = JSON.parse(readFileSync(join(indexHome, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
    expect(index.teams.alpha).toBeUndefined();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// Late-crew integration cases (U4B, ported from the retired
// crew-late-collection.test.sh interposer arms): the row lands AFTER
// prepare/clear and BEFORE the self cotenant_kill — the retired fixture's
// exact timing — via a one-shot io.stdout callback on the PRE-KILL receipt
// line (the one containing "next)").

const CREW_SEED: Record<string, unknown> = {
  driver: { status: "active", delivery: "pane", pane: "alpha/driver:0.0", pane_id: "%1", server_epoch: "srv:900:100", session: "alpha/driver" },
  other: { status: "active", delivery: "pane", pane: "alpha/other:0.0", pane_id: "%3", server_epoch: "srv:900:100", session: "alpha/other" },
};

function crewEffects(t: string, opts: {
  survive?: boolean;
  onKill?: (session: string) => void;
}): { effects: StopEffects; eventLog: string; panes: Map<string, string> } {
  const eventLog = join(t, "events.log");
  const panes = new Map<string, string>([["%1", "alpha/driver"], ["%2", "alpha/driver"], ["%3", "alpha/other"]]);
  const effects: StopEffects = {
    tmux: {
      hasSession: (name) => [...panes.values()].includes(name),
      paneSession: (paneId) => panes.get(paneId) ?? null,
      sessionPaneIds: (name) => [...panes.entries()].filter(([, sess]) => sess === name).map(([id]) => id),
    },
    killSession: (session) => {
      opts.onKill?.(session);
      if (!opts.survive) for (const [id, sess] of panes) if (sess === session) panes.delete(id);
      return true;
    },
    hasSession: () => opts.survive === true,
    paneCount: (name) => [...panes.values()].filter((sess) => sess === name).length,
    observeSpare: () => null,
    queueSummary: () => ({ unsettled: 0, counts: new Map() }),
    watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
    identity: {
      tmuxActive: true, callingPaneId: "%1", selfRefusal: "",
      resolveSelf: () => ({ handle: "driver", pane: "alpha/driver:0.0", paneId: "%1" }),
      displaySession: () => "alpha/driver",
    },
    runId: "crewlate",
    eventLog,
    io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
  };
  return { effects, eventLog, panes };
}

function crewInjector(c: ResolvedContext): (line: string) => void {
  let injected = false;
  const crewRow = {
    status: "active", delivery: "pane", pane: "alpha/driver:1.0", pane_id: "%2",
    server_epoch: "srv:900:100", session: "alpha/driver", crew: true, harness: "claude",
  };
  return (line) => {
    if (injected || !line.includes("next)")) return;
    injected = true;
    // Under clear the locked clear has already DELETED the file by receipt
    // time (the retired interposer fired in exactly that state too): the
    // row arrives in a fresh minimal registry, as a genuinely late write.
    const doc = existsSync(c.registryPath)
      ? (JSON.parse(readFileSync(c.registryPath, "utf8")) as Record<string, unknown>)
      : { schema: 20, team: { name: "alpha", worktree_root: "/w" }, seats: {} };
    (doc.seats as Record<string, unknown>)["late-crew"] = crewRow;
    writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
  };
}

function eventAtoms(path: string): Array<Record<string, string>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    const atoms: Record<string, string> = {};
    for (const part of line.split(" ")) if (part.includes("=")) { const [k, ...rest] = part.split("="); atoms[k!] = rest.join("="); }
    return atoms;
  });
}

function seedCrewCase(t: string): ResolvedContext {
  const c = ctx(t);
  seedRegistry(c.registryPath, CREW_SEED);
  return c;
}

test("late crew row (post-prepare) is named pre-kill and collected under suspend", () => {
  const t = work();
  try {
    const c = seedCrewCase(t);
    const inject = crewInjector(c);
    let snap: Array<Record<string, string>> = [];
    const { effects } = crewEffects(t, {
      onKill: (session) => { if (session === "alpha/driver") snap = eventAtoms(join(t, "events.log")); },
    });
    effects.io = { stdout: inject, stderr: () => {}, warn: () => {} };
    const rc = runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["driver", "other"], effects });
    expect(rc).toBe(0);
    const requested = snap.filter((a) => a.action === "kill-requested" && a.handle === "driver" && (a.detail ?? "").includes("crew=late-crew"));
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(snap.some((a) => a.handle === "late-crew" && ["crew_collected", "killed"].includes(a.action ?? ""))).toBe(false);
    const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
    expect(doc.seats["late-crew"]).toBeUndefined();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("late crew row (post-clear) is named pre-kill and collected under clear", () => {
  const t = work();
  try {
    const c = seedCrewCase(t);
    const inject = crewInjector(c);
    let snap: Array<Record<string, string>> = [];
    const { effects } = crewEffects(t, {
      onKill: (session) => { if (session === "alpha/driver") snap = eventAtoms(join(t, "events.log")); },
    });
    effects.io = { stdout: inject, stderr: () => {}, warn: () => {} };
    const rc = runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["driver", "other"], effects });
    expect(rc).toBe(0);
    const requested = snap.filter((a) => a.action === "kill-requested" && a.handle === "driver" && (a.detail ?? "").includes("crew=late-crew"));
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(snap.some((a) => a.handle === "late-crew" && ["crew_collected", "killed"].includes(a.action ?? ""))).toBe(false);
    if (existsSync(c.registryPath)) {
      const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
      expect(doc.seats["late-crew"]).toBeUndefined();
    }
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("late crew row is restored byte-equal with one crew_restored event when the self kill survives", () => {
  const t = work();
  try {
    const c = seedCrewCase(t);
    const inject = crewInjector(c);
    let injectedBytes = "";
    const rawInject = inject;
    const { effects, eventLog } = crewEffects(t, { survive: true });
    effects.io = {
      stdout: (line) => {
        rawInject(line);
        if (injectedBytes === "" && existsSync(c.registryPath) && readFileSync(c.registryPath, "utf8").includes("late-crew")) {
          injectedBytes = readFileSync(c.registryPath, "utf8");
        }
      },
      stderr: () => {}, warn: () => {},
    };
    const rc = runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["driver", "other"], effects });
    expect(rc).toBe(1);
    expect(injectedBytes).not.toBe("");
    // The adopted crew row is restored with its original values (the restore
    // rewrite re-serializes, so bytes are JSON-compared, not string-compared).
    const after = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
    expect(after.seats["late-crew"]).toEqual(JSON.parse(injectedBytes).seats["late-crew"]);
    expect((after.seats.driver as Record<string, unknown>).status).toBe("active");
    const restored = eventAtoms(eventLog).filter((a) => a.action === "crew_restored" && a.handle === "late-crew");
    expect(restored.length).toBe(1);
    expect(restored[0]!.detail).toContain("reason=self_kill_failed");
    expect(restored[0]!.detail).toContain("parent=driver");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a scalar seat key is not a roster target: gate refuses before any mutation", () => {
  // U4B review C2: the roster must come from selection.ts registryRoster,
  // which filters non-row entries — a scalar seat value must not pass the
  // gate and fall through to the zero-row mutation arm.
  const t = work();
  try {
    const c = ctx(t);
    const doc = { schema: 20, team: { name: "alpha", worktree_root: "/w" }, seats: { ghost: 7 } };
    writeFileSync(c.registryPath, `${JSON.stringify(doc)}\n`);
    const before = readFileSync(c.registryPath, "utf8");
    expectTapError(
      () => runTeamStop({
        verb: "down", policy: "suspend", argv: ["--only", "ghost"], ctx: c,
        roster: registryRoster(c.registryPath),
        effects: baseEffects(),
      }),
      "not_found",
      "tap team",
      "tap team down --only names no seat on this team: ghost; roster: (none)",
    );
    expect(readFileSync(c.registryPath, "utf8")).toBe(before);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- review round 2: adopted facts, warnings, unrecorded, durable bridge ------

test("a handle re-registered into a second session is a second (handle, session) adoption fact", () => {
  // Concurrency stand-in: dup joins boss's session after the plan dump (so
  // boss's transaction adopts it), then re-registers into carol's session
  // before carol's transaction runs. Handle-only deduplication would drop the
  // second fact and the drain would under-report the stop.
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {
      boss: seat("boss", "alpha/boss", { pane_id: "%1" }),
      carol: seat("carol", "alpha/carol", { pane_id: "%2" }),
    });
    // liveTmuxOf maps session -> pane id: boss's session carries boss (%1);
    // dup's %9 is registry-only until a transaction adopts it.
    const panes = new Map<string, string>([["alpha/boss", "%1"], ["alpha/carol", "%2"]]);
    const eventLog = join(t, "events.log");
    let dupPlaced = false;
    const placeDup = (session: string) => {
      const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
      doc.seats.dup = {
        handle: "dup", delivery: "pane", pane: "dupPane", pane_id: "%9",
        server_epoch: "srv:900:100", session, status: "active", status_reason: "", crew: false,
      };
      writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
    };
    const effects: StopEffects = {
      tmux: liveTmuxOf(panes),
      killSession: (s) => {
        if (s === "alpha/boss") placeDup("alpha/carol");
        panes.delete(s);
        return true;
      },
      hasSession: () => false,
      paneCount: () => 1,
      observeSpare: () => null,
      queueSummary: () => {
        if (!dupPlaced) {
          dupPlaced = true;
          placeDup("alpha/boss");
        }
        return { unsettled: 0, counts: new Map() };
      },
      bufferDir: t,
      watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
      identity: {
        tmuxActive: true, callingPaneId: "%77", selfRefusal: "",
        resolveSelf: () => null, displaySession: () => "",
      },
      runId: "424242",
      eventLog,
      io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
    };
    const rc = runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["boss", "carol"], effects });
    expect(rc).toBe(0);
    const killedDup = readFileSync(eventLog, "utf8")
      .split("\n")
      .filter((l) => l.includes("action=killed") && l.includes("handle=dup"));
    expect(killedDup).toHaveLength(2);
    expect(killedDup.some((l) => l.includes("pane=alpha/boss"))).toBe(true);
    expect(killedDup.some((l) => l.includes("pane=alpha/carol"))).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a late seat adopted in a teammate transaction is logged killed before the self-last kill", () => {
  // Pins the ordering at the drain before self-last: moving that drain past
  // the caller's own kill would still pass every end-state assertion, so the
  // event log is read INSIDE killSession(selfSession).
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, {
      boss: seat("boss", "alpha/boss", { pane_id: "%9" }),
      carol: seat("carol", "alpha/carol", { pane_id: "%2" }),
    });
    const sessions = new Map<string, string[]>([["alpha/boss", ["%9"]], ["alpha/carol", ["%2", "%5"]]]);
    const eventLog = join(t, "events.log");
    let injected = false;
    let selfKillSeen = false;
    let loggedAtSelfKill = "";
    const effects: StopEffects = {
      tmux: {
        hasSession: (name) => sessions.has(name),
        paneSession: (paneId) => {
          for (const [sess, ids] of sessions) if (ids.includes(paneId)) return sess;
          return null;
        },
        sessionPaneIds: (name) => sessions.get(name) ?? [],
      },
      killSession: (s) => {
        if (s === "alpha/boss") {
          selfKillSeen = true;
          loggedAtSelfKill = existsSync(eventLog) ? readFileSync(eventLog, "utf8") : "";
        }
        sessions.delete(s);
        return true;
      },
      hasSession: () => false,
      paneCount: () => 1,
      observeSpare: () => null,
      queueSummary: () => {
        if (!injected) {
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.late = { ...seat("late", "alpha/carol"), pane: "late-pane", pane_id: "%5" };
          writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
          injected = true;
        }
        return { unsettled: 0, counts: new Map() };
      },
      bufferDir: t,
      watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
      runId: "424242",
      eventLog,
      io: { stdout: () => {}, stderr: () => {}, warn: () => {} },
    };
    expect(runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["boss", "carol"], effects })).toBe(0);
    // Vacuity guards: the late seat was really adopted and the self kill really ran.
    expect(injected).toBe(true);
    expect(selfKillSeen).toBe(true);
    expect(loggedAtSelfKill).toContain("action=killed handle=late");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("an adopted killed event whose append fails is disclosed as unrecorded and exits 1", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss", { pane_id: "%1" }) });
    const panes = new Map<string, string>([["alpha/boss", "%1"]]);
    const capture = io();
    const dupPlaced = { value: false };
    const effects: StopEffects = {
      tmux: liveTmuxOf(panes),
      killSession: (s) => {
        panes.delete(s);
        return true;
      },
      hasSession: () => false,
      paneCount: () => 1,
      observeSpare: () => null,
      queueSummary: () => {
        if (!dupPlaced.value) {
          dupPlaced.value = true;
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.dup = {
            handle: "dup", delivery: "pane", pane: "dupPane", pane_id: "%9",
            server_epoch: "srv:900:100", session: "alpha/boss", status: "active", status_reason: "", crew: false,
          };
          writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
        }
        return { unsettled: 0, counts: new Map() };
      },
      bufferDir: t,
      watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
      identity: {
        tmuxActive: true, callingPaneId: "%77", selfRefusal: "",
        resolveSelf: () => null, displaySession: () => "",
      },
      runId: "424242",
      eventLog: "/nonexistent-events.log",
      io: capture.io,
    };
    const rc = runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["boss"], effects });
    // The message surfaces captured stderr: an event-log flock timeout under
    // load looks exactly like a real unrecorded disclosure from the outside.
    expect(rc, `stderr: ${capture.err.join(" | ")}`).toBe(1);
    const warned = capture.err.filter((l) => l.includes("adopted seat(s) were stopped with no durable killed event"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("dup");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the adopted-seat terminal bridge is removed by the drain and leaves no files behind", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss", { pane_id: "%1" }) });
    const panes = new Map<string, string>([["alpha/boss", "%1"]]);
    const bufferDir = join(t, "buffers");
    mkdirSync(bufferDir, { recursive: true });
    const capture = io();
    const dupPlaced = { value: false };
    const effects: StopEffects = {
      tmux: liveTmuxOf(panes),
      killSession: (s) => {
        panes.delete(s);
        return true;
      },
      hasSession: () => false,
      paneCount: () => 1,
      observeSpare: () => null,
      queueSummary: () => {
        if (!dupPlaced.value) {
          dupPlaced.value = true;
          const doc = JSON.parse(readFileSync(c.registryPath, "utf8")) as { seats: Record<string, unknown> };
          doc.seats.dup = {
            handle: "dup", delivery: "pane", pane: "dupPane", pane_id: "%9",
            server_epoch: "srv:900:100", session: "alpha/boss", status: "active", status_reason: "", crew: false,
          };
          writeFileSync(c.registryPath, `${JSON.stringify(doc, null, 2)}\n`);
        }
        return { unsettled: 0, counts: new Map() };
      },
      bufferDir,
      watch: { isArmed: () => true, clearTints: () => {}, disarm: () => {} },
      identity: {
        tmuxActive: true, callingPaneId: "%77", selfRefusal: "",
        resolveSelf: () => null, displaySession: () => "",
      },
      runId: "424242",
      eventLog: join(t, "events.log"),
      io: capture.io,
    };
    // The message surfaces captured stderr: an event-log flock timeout under
    // load would show up here as a spurious unrecorded disclosure.
    expect(runTeamStop({ verb: "down", policy: "suspend", argv: [], ctx: c, roster: ["boss"], effects }), `stderr: ${capture.err.join(" | ")}`).toBe(0);
    expect(readdirSync(bufferDir).filter((f) => f.startsWith("tap-team-"))).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a failed caller-row restore warns with its detail and retained artifact in text mode, not JSON", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss", { pane_id: "%9" }), carol: seat("carol", "alpha/carol") });
    const capture = io();
    const effects = baseEffects({
      io: capture.io,
      killSession: (s) => {
        if (s === "alpha/boss") {
          // The kill fails AND the registry turns corrupt, so the post-failure
          // caller-row restore refuses (rc 3) with the artifact retained.
          writeFileSync(c.registryPath, "not json at all\n");
          return true;
        }
        return true;
      },
      hasSession: (s) => s === "alpha/boss",
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]);
    const rc = runTeamStop({ verb: "shutdown", policy: "clear", argv: [], ctx: c, roster: ["boss", "carol"], effects });
    expect(rc).toBe(1);
    const warned = capture.err.filter((l) => l.includes("caller-row restore failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("retained at");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("a failed caller-row restore keeps the JSON receipt silent about the text warning", () => {
  const t = work();
  try {
    const c = ctx(t);
    seedRegistry(c.registryPath, { boss: seat("boss", "alpha/boss", { pane_id: "%9" }), carol: seat("carol", "alpha/carol") });
    const capture = io();
    const effects = baseEffects({
      io: capture.io,
      killSession: (s) => {
        if (s === "alpha/boss") writeFileSync(c.registryPath, "not json at all\n");
        return true;
      },
      hasSession: (s) => s === "alpha/boss",
      identity: {
        tmuxActive: true, callingPaneId: "%9", selfRefusal: "",
        resolveSelf: () => ({ handle: "boss", pane: "boss-pane", paneId: "%9" }),
        displaySession: () => "alpha/boss",
      },
    }, [["alpha/boss", "%9"], ["alpha/carol", "%2"]]);
    expect(runTeamStop({ verb: "shutdown", policy: "clear", argv: ["--json"], ctx: c, roster: ["boss", "carol"], effects })).toBe(1);
    expect(capture.err.filter((l) => l.includes("caller-row restore failed"))).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
