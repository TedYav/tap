import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { identityUnobservable, submitIdentityGuard, unboundPaneIdentityRecord, type IdentityDeps } from "../src/pane-identity";
import type { ObservePayload } from "../src/observe";
import { gather } from "../src/observe-gather";
import { ServerUnresponsive } from "../src/tmux";
import { installSpoolPane } from "./support/spool-pane";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "pane-identity-"));
  roots.push(root);
  return root;
}

const ENV = { TAP_BOOT_ID: "boot:1", TAP_BOOT_ID_LEGACY: "boot:1", TAP_WATCH_NOW: "100" };

/** A scoped tmux/ps snapshot for the rowless arm. */
function snap(over: Partial<{
  command: string; paneId: string; sessionsRc: number; panesRc: number; sessions: string; panes: string; psRc: number;
}> = {}): NonNullable<IdentityDeps["snapshot"]> {
  const paneId = over.paneId ?? "%7";
  const command = over.command ?? "codex";
  return (scope): ObservePayload => ({
    sessions_rc: over.sessionsRc ?? 0,
    sessions_text: over.sessions ?? "t/peer\t1:1\t1\n",
    panes_rc: over.panesRc ?? 0,
    panes_text: over.panes ?? `t/peer\tt/peer:0.0\t${paneId}\t${command}\t500\t1:1\t0\n`,
    ps_rc: over.psRc ?? 1, ps_text: "",
    session_scope: scope,
    now_boot: "boot:1", legacy_boot: "boot:1", now_ts: 100,
    tap_boot_id_set: true, tap_boot_id_legacy_set: true,
  });
}
const rowless = (over: Parameters<typeof snap>[0] = {}, pane = "t/peer:0.0", id = "%7", harness = "codex", session = "t/peer") =>
  unboundPaneIdentityRecord(session, pane, { paneId: id, harness }, ENV, snap(over)).state;

/** A bound seat whose tmux is a fake on PATH; `observe-gather`'s real owner reads it. */
function bound(command = "codex") {
  const root = scratch();
  const registry = join(root, "registry.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_VERBOSE: "0" };
  const { log, seat, writeSeat } = installSpoolPane(root, registry, env, command);
  const guard = (deps: IdentityDeps = {}, pane = seat.pane, id = seat.pane_id) =>
    submitIdentityGuard(registry, "peer", pane, id, "", "", { env, ...deps });
  return { root, registry, env, log, seat, writeSeat, guard };
}

describe("the rowless arm", () => {
  test("match when the session names the designated address and id", () => {
    expect(rowless()).toBe("match");
  });

  for (const [label, session, pane, expected] of [
    ["no session", "", "t/peer:0.0", "identity_incomplete"],
    ["no pane", "t/peer", "", "identity_incomplete"],
    ["a pane outside the session", "t/peer", "other:0.0", "pane_outside_session"],
    // A session-name PREFIX is not membership; the colon is required.
    ["a session-name prefix without the colon", "t/peer", "t/peerx:0.0", "pane_outside_session"],
  ] as const) {
    test(`${label} is ${expected}`, () => expect(rowless({}, pane, "%7", "codex", session)).toBe(expected));
  }

  test("a tmux that could not answer is unobservable, never absence", () => {
    expect(rowless({ sessionsRc: 1 })).toBe("session_unobservable");
    expect(rowless({ sessions: "t/peer\tmalformed\n" })).toBe("session_unobservable");
  });

  test("identityUnobservable names the could-not-look family for the readiness walk, and registry_missing stays a positive absence there", () => {
    for (const state of ["guard_deadline", "server_unresponsive", "session_unobservable", "harness_unobservable", "pane_set_unobservable", "boot_id_unobservable"]) {
      expect(identityUnobservable(state)).toBe(true);
    }
    for (const state of ["registry_missing", "pane_drift", "pane_id_drift", "handle_missing_or_inactive", "not_pane_delivery", "seat_exited", "match"]) {
      expect(identityUnobservable(state)).toBe(false);
    }
  });

  test("a readable snapshot that does not name the session is absence", () => {
    for (const sessions of ["", "other\t1:1\t1\n"]) expect(rowless({ sessions })).toBe("session_absent");
  });

  test("an unreadable, poisoned, or foreign pane set is pane_set_unobservable", () => {
    expect(rowless({ panesRc: 1 })).toBe("pane_set_unobservable");
    expect(rowless({ panes: "t/peer\tt/peer:0.0\t%7\tcodex\t500\t1:1\t0\nt/peer\tbroken\n" })).toBe("pane_set_unobservable");
    expect(rowless({ panes: "elsewhere\telsewhere:0.0\t%7\tcodex\t500\t1:1\t0\n" })).toBe("pane_set_unobservable");
  });

  test("the address missing, a recycled id, and a harness change each refuse", () => {
    expect(rowless({}, "t/peer:9.9")).toBe("designated_pane_missing");
    expect(rowless({}, "t/peer:0.0", "%9")).toBe("pane_recycled");
    expect(rowless({ command: "zsh" })).toBe("harness_exited");
    expect(rowless({ command: "claude" })).toBe("harness_mismatch");
    expect(rowless({ command: "mystery" })).toBe("harness_unobservable");
  });

  test("no expected harness means the harness is not checked", () => {
    expect(rowless({ command: "zsh" }, "t/peer:0.0", "%7", "")).toBe("match");
  });

  test("the record carries the live pane id and the session's epoch (send binds from them)", () => {
    const record = unboundPaneIdentityRecord("t/peer", "t/peer:0.0", {}, ENV, snap({}));
    expect(record.state).toBe("match");
    expect(record.paneId).toBe("%7");
    expect(record.epoch).not.toBe("");
    const recycled = unboundPaneIdentityRecord("t/peer", "t/peer:0.0", { paneId: "%9" }, ENV, snap({}));
    expect([recycled.state, recycled.paneId, recycled.epoch]).toEqual(["pane_recycled", "%7", record.epoch]);
    expect(unboundPaneIdentityRecord("t/peer", "t/peer:0.0", {}, ENV, snap({ sessionsRc: 1 })))
      .toEqual({ state: "session_unobservable", paneId: "", epoch: "" });
  });

  test("a sibling row without a session-qualified address poisons the whole pane set", () => {
    const valid = "t/peer\tt/peer:0.0\t%7\tcodex\t500\t1:1\t0\n";
    expect(rowless({ panes: valid })).toBe("match");
    expect(rowless({ panes: `${valid}t/peer\tnot-an-address\t%8\tcodex\t501\t1:1\t0\n` })).toBe("pane_set_unobservable");
  });

  // Send's relay passes its canonical families; an inherited
  // TAP_OBS_HARNESS_FAMILIES must not decide whether the gather reads ps.
  test("explicit families govern the process-table gather, not only the final evidence", () => {
    const record = (inherited: string) => {
      let psCalls = 0;
      const env = { ...ENV, TAP_OBS_HARNESS_FAMILIES: inherited };
      const out = unboundPaneIdentityRecord("t/peer", "t/peer:0.0", { paneId: "%7", harness: "codex", families: ["codex"] }, env,
        (scope, e, remainingMs) => ({
          ...gather({
            scope, env: e, remainingMs,
            run: args => ({ code: 0, stderr: "",
              stdout: args[0] === "list-sessions" ? "t/peer\t1:1\t1\n" : "t/peer\tt/peer:0.0\t%7\tnode\t500\t1:1\t0\n" }),
            ps: () => { psCalls++; return { status: 0, stdout: "500 500 500 node node /opt/codex\n" }; },
          }),
          session_scope: scope,
        }));
      return { state: out.state, psCalls };
    };
    expect(record("codex")).toEqual({ state: "match", psCalls: 1 });
    expect(record("node")).toEqual({ state: "match", psCalls: 1 });
  });

  // The relay's route-time record expects no harness, so an
  // unsupported shallow command in the session must not buy a system-wide ps.
  test("a record with no expected harness gathers no process table", () => {
    const psCalls = (expected: { harness?: string }) => {
      let calls = 0;
      const out = unboundPaneIdentityRecord("t/peer", "t/peer:0.0", { ...expected, families: ["codex"] }, ENV,
        (scope, e, remainingMs, processTable) => ({
          ...gather({
            scope, env: e, remainingMs, processTable,
            run: args => ({ code: 0, stderr: "",
              stdout: args[0] === "list-sessions" ? "t/peer\t1:1\t1\n" : "t/peer\tt/peer:0.0\t%7\tnode\t500\t1:1\t0\n" }),
            ps: () => { calls++; return { status: 0, stdout: "500 500 500 node node /opt/codex\n" }; },
          }),
          session_scope: scope,
        }));
      return { state: out.state, calls };
    };
    expect(psCalls({})).toEqual({ state: "match", calls: 0 });
    expect(psCalls({ harness: "codex" })).toEqual({ state: "match", calls: 1 });
  });
});

describe("submitIdentityGuard", () => {
  test("no registry and no rowless session is no guard, and proves nothing", () => {
    expect(submitIdentityGuard("", "", "t/peer:0.0", "%7")).toEqual(
      { outcome: "authorized", state: "unguarded", message: null, harnessAlive: false, permissions: "bypass" });
  });

  test("the rowless arm arms the harness flag only when a harness was carried", () => {
    const deps = { env: ENV, snapshot: snap() };
    expect(submitIdentityGuard("", "", "t/peer:0.0", "%7", "t/peer", "codex", deps))
      .toMatchObject({ outcome: "authorized", harnessAlive: true, permissions: "bypass" });
    expect(submitIdentityGuard("", "", "t/peer:0.0", "%7", "t/peer", "", deps))
      .toMatchObject({ outcome: "authorized", harnessAlive: false });
    expect(submitIdentityGuard("", "", "t/peer:0.0", "", "t/peer", "codex", deps)).toMatchObject(
      { outcome: "refused", message: "tap: incomplete rowless pane identity before pane effect" });
    expect(submitIdentityGuard("", "", "t/peer:0.0", "%7", "t/peer", "codex", { env: ENV, snapshot: snap({ command: "zsh" }) }))
      .toMatchObject({ outcome: "refused", message: "tap: rowless pane identity drifted before pane effect (harness_exited)" });
  });

  test("the real rowless path observes tmux without spawning the boot-id probes", () => {
    const f = bound();
    const marker = join(f.root, "sysctl-ran");
    writeFileSync(join(f.root, "pane-bin", "sysctl"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(f.root, "pane-bin", "sysctl"), 0o755);
    delete f.env.TAP_BOOT_ID; delete f.env.TAP_BOOT_ID_LEGACY;
    expect(submitIdentityGuard("", "", f.seat.pane, f.seat.pane_id, f.seat.session, "codex", { env: f.env }))
      .toMatchObject({ outcome: "authorized", state: "match", harnessAlive: true });
    expect(existsSync(marker)).toBe(false);
  });

  test("a tmux that will not answer is unobservable, not a drift", () => {
    const hung: IdentityDeps["snapshot"] = () => { throw new ServerUnresponsive("/sock", "unknown"); };
    expect(submitIdentityGuard("", "", "t/peer:0.0", "%7", "t/peer", "codex", { env: ENV, snapshot: hung }))
      .toMatchObject({ outcome: "unobservable", state: "server_unresponsive", harnessAlive: false });
  });

  test("a bound match arms both globals from the recorded permissions", () => {
    const f = bound();
    expect(f.guard()).toEqual({ outcome: "authorized", state: "match", message: null, harnessAlive: true, permissions: "bypass" });
    f.writeSeat({ permissions: "auto" });
    expect(f.guard()).toMatchObject({ outcome: "authorized", permissions: "auto" });
  });

  test("an unrecognized permissions value refuses silently and leaves `unknown` in the global", () => {
    const f = bound();
    f.writeSeat({ permissions: "something-else" });
    expect(f.guard()).toEqual({ outcome: "refused", state: "permissions_unknown", message: null, harnessAlive: false, permissions: "unknown" });
  });

  test("drift is refused, an instrument failure is unobservable, and both close the globals", () => {
    const f = bound();
    expect(f.guard({}, "fixture:0.9")).toMatchObject({ outcome: "refused", state: "pane_drift", harnessAlive: false, permissions: "bypass",
      message: "tap: bound recipient identity drifted before pane effect (pane_drift)" });
    expect(f.guard({}, f.seat.pane, "")).toMatchObject({ outcome: "refused", state: "identity_incomplete" });
    mkdirSync(join(f.root, "dir.json"));
    expect(submitIdentityGuard(join(f.root, "dir.json"), "peer", f.seat.pane, f.seat.pane_id, "", "", { env: f.env }))
      .toMatchObject({ outcome: "unobservable", state: "registry_missing" });
  });

  test("malformed registry bytes never authorize", () => {
    const f = bound();
    const doc = readFileSync(f.registry);
    for (const bytes of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), doc]),        // a BOM python's json.load refuses
      Buffer.concat([doc.subarray(0, -1), Buffer.from(',"note":"'), Buffer.from([0xff]), Buffer.from('"}')]), // raw 0xff in unread metadata
    ]) {
      writeFileSync(f.registry, bytes);
      expect(f.guard()).toMatchObject({ outcome: "refused", state: "handle_missing_or_inactive", harnessAlive: false });
    }
    for (const field of ["status", "pane", "pane_id"] as const) {
      f.writeSeat({ [field]: [f.seat[field]] });                    // Python's str() never unwraps a list
      expect(f.guard().outcome).not.toBe("authorized");
    }
  });
});

describe("F1: an unrepresentable tmux router refuses on both arms, before observing", () => {
  test("bound and rowless", () => {
    const f = bound();
    expect(f.guard({ nativeRouter: false })).toMatchObject({ outcome: "unobservable", state: "harness_unobservable" });
    expect(readFileSync(f.log, "utf8")).toBe("");
    let looked = false;
    const r = submitIdentityGuard("", "", "t/peer:0.0", "%7", "t/peer", "codex",
      { env: ENV, nativeRouter: false, snapshot: (s, e) => { looked = true; return snap()(s, e); } });
    expect(r).toMatchObject({ outcome: "unobservable", state: "harness_unobservable" });
    expect(looked).toBe(false);
  });
});

describe("F2: the whole-guard budget", () => {
  test("a stalled boot probe is refused near the budget, not after it", () => {
    const f = bound();
    const stub = join(f.root, "pane-bin", "sysctl");
    writeFileSync(stub, "#!/bin/sh\nsleep 6\necho '{ sec = 1 }'\n");
    chmodSync(stub, 0o755);
    delete f.env.TAP_BOOT_ID; delete f.env.TAP_BOOT_ID_LEGACY;
    const started = performance.now();
    const r = f.guard({ budgetMs: 1500 });
    expect(r).toMatchObject({ outcome: "unobservable", state: "guard_deadline", harnessAlive: false, permissions: "bypass" });
    expect(performance.now() - started).toBeLessThan(4000);
  }, 15_000);

  test("a stalled tmux is bounded by the budget and refuses", () => {
    const f = bound();
    const tmux = join(f.root, "pane-bin", "tmux");
    writeFileSync(tmux, "#!/bin/sh\nsleep 8\n");
    chmodSync(tmux, 0o755);
    const started = performance.now();
    expect(f.guard({ budgetMs: 1500 }).outcome).not.toBe("authorized");
    expect(performance.now() - started).toBeLessThan(4000);
  }, 15_000);

  test("LATE authorization refuses: a match that returns after the budget is spent", () => {
    const f = bound();
    const late: IdentityDeps["bound"] = () => {
      const end = performance.now() + 150;
      while (performance.now() < end) { /* the last spawn returned just inside its own bound */ }
      return "match";
    };
    expect(f.guard({ budgetMs: 100, bound: late })).toMatchObject({ outcome: "unobservable", state: "guard_deadline", harnessAlive: false });
    expect(f.guard({ bound: late }).outcome).toBe("authorized");     // no budget, no deadline
  });
});
