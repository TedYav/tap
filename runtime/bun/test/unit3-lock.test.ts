// The pane submit lock — its exclusivity properties, as BEHAVIOR rather than as
// a claim in a commit message.
//
// This file is much shorter than it was, and the deletions are the finding.
//
// Six tests were removed in the lockf switch, and none of them were removed
// because they were weak — two of them were the partner reviewer's own probes,
// requested as permanent arms. They are gone because the failure classes they
// covered no longer exist. "A malformed owner record must not be classified
// dead" has no meaning once there is no owner record; "a lock must never be
// visible before its metadata is readable" has no meaning once the lock is a
// kernel flock rather than a file's contents; "an abandoned staging file must
// not wedge acquisition" has no meaning once nothing is staged. Deleting a
// whole representation deletes the tests that guarded its seams, and keeping
// them as reassurance would be keeping tests that can no longer fail.
//
// What replaces them is the property the reviewer asked for directly: prove by
// BEHAVIOR that a live holder cannot lose ownership and overlap a contender.
// A test that inspects what a reaper reports is exactly what we no longer have
// to write, because there is no reaper.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";
import { renderSentinel } from "../src/sentinel";
import { join, resolve } from "node:path";

import { observeHarnessPid, evaluateHarnessEvidence, submitVerifyLocked } from "../src/courier";
import { envelopeField } from "../src/envelope";
import { acquireFlock, flockFailureRetryable } from "../src/remind-lock";
import { acquireObligationLock, acquirePaneLock, acquirePathLock, acquirePathLockAsync, lockRoot, kernelLockAvailable, KERNEL_LOCK, kernelLockArgs, paneLockPath } from "../src/panelock";
import { AGENT_FAMILIES } from "../src/verbs/team";

const deliveryWire = (id: string) => renderSentinel({ from: "probe", to: "peer", id,
  kind: "discuss", reply: "expected", path: "/fixture/payload.md" });

const NATIVE_SEND = join(import.meta.dir, "support", "native-send-entry.ts");
const NATIVE_REPLY = join(import.meta.dir, "support", "native-reply-entry.ts");

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tap-lock."));
  env = { ...process.env, TAP_LOCK_DIR: dir };
});
afterEach(() => removeScratchTree(dir));

/** Source for a child that acquires, marks a shared timeline, and releases. */
function childSrc(body: string): string {
  return `
    import { acquirePaneLock } from "${join(import.meta.dir, "..", "src", "panelock")}";
    const env = { ...process.env, TAP_LOCK_DIR: "${dir}" };
    ${body}
  `;
}

describe("exclusivity", () => {
  for (const ending of ["exit", "SIGKILL"] as const) {
    test(`an owner that ends by ${ending} without release leaves only the sidecar`, async () => {
      const path = join(dir, `ended-${ending}.lock`);
      const ready = join(dir, `ended-${ending}-ready`);
      const source = `
        import { writeFileSync } from "node:fs";
        import { acquirePathLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "panelock.ts"))};
        if (!acquirePathLock(${JSON.stringify(path)}, 2000, process.env)) process.exit(2);
        writeFileSync(${JSON.stringify(ready)}, "held");
        ${ending === "exit" ? "process.exit(0);" : "Bun.sleepSync(20_000);"}
      `;
      const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "ignore", stderr: "pipe" });
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      if (ending === "SIGKILL") child.kill("SIGKILL");
      await child.exited;
      // The next acquirer waits on the kernel, which proves the hold ended.
      const next = acquirePathLock(path, 3000, env);
      expect(next).not.toBeNull();
      next!.release();
      const markers = () => readdirSync(dir).filter(name => name.startsWith(`ended-${ending}.lock.held.`));
      while (markers().length && Date.now() < deadline) await Bun.sleep(10);
      expect(markers()).toEqual([]);
    }, 15_000);
  }

  test("a nonwaiting release does not wait for the next holder's critical section", async () => {
    const path = join(dir, "queued.lock");
    const ready = join(dir, "queued-ready");
    const acquired = join(dir, "queued-acquired");
    const first = acquirePathLock(path, 5000, env)!;
    const source = `
      import { writeFileSync } from "node:fs";
      import { acquirePathLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "panelock.ts"))};
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const held = acquirePathLock(${JSON.stringify(path)}, 5000, process.env);
      if (!held) process.exit(2);
      writeFileSync(${JSON.stringify(acquired)}, "held");
      Bun.sleepSync(1500);
      held.release();
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "pipe", stderr: "pipe" });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(ready)).toBe(true);
      await Bun.sleep(100);
      const start = performance.now();
      first.release(0);
      expect(performance.now() - start).toBeLessThan(1000);
      while (!existsSync(acquired) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(acquired)).toBe(true);
      const overlap = acquirePathLock(path, 0, env);
      try { expect(overlap).toBeNull(); } finally { overlap?.release(); }
      expect(await child.exited).toBe(0);
    } finally {
      first.release();
      child.kill();
      await child.exited;
    }
  }, 15_000);

  test("owner process-group SIGINT cannot release a held lock before its owner", () => {
    const ready = join(dir, "group-ready");
    const release = join(dir, "group-release");
    const holder = spawn(process.execPath, ["-e", childSrc(`
      const { existsSync, writeFileSync } = await import("node:fs");
      process.on("SIGINT", () => {});
      const held = acquirePaneLock("signal:0.0", 500, env);
      if (!held) process.exit(2);
      writeFileSync(${JSON.stringify(ready)}, "held");
      const deadline = Date.now() + 20_000;
      while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Bun.sleepSync(10);
      held.release();
      process.exit(0);
    `)], { detached: true, env, stdio: "ignore" });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(10);
      expect(existsSync(ready)).toBe(true);
      // This negative PID is the private process group created by detached spawn above.
      process.kill(-holder.pid!, "SIGINT");
      Bun.sleepSync(100);
      const contender = acquirePaneLock("signal:0.0", 0, env);
      try { expect(contender).toBeNull(); }
      finally { contender?.release(); }
    } finally {
      writeFileSync(release, "release");
      // Kill only this test's detached group if it did not exit after release.
      try { process.kill(-holder.pid!, "SIGKILL"); } catch { /* already exited */ }
    }
    const after = acquirePaneLock("signal:0.0", 3000, env);
    expect(after).not.toBeNull();
    after?.release();
  }, 30_000);

  test("a second acquire is refused while the first is held", () => {
    const a = acquirePaneLock("p:0.0", 200, env);
    expect(a).not.toBeNull();
    expect(acquirePaneLock("p:0.0", 200, env)).toBeNull();
    a!.release();
  });

  test("release makes it available again", () => {
    const a = acquirePaneLock("p:0.0", 200, env)!;
    a.release();
    const b = acquirePaneLock("p:0.0", 200, env);
    expect(b).not.toBeNull();
    b!.release();
  });

  test("different panes do not contend", () => {
    const a = acquirePaneLock("p:0.0", 200, env)!;
    const b = acquirePaneLock("q:0.0", 200, env);
    expect(b).not.toBeNull();
    a.release();
    b!.release();
  });

  test("a double release cannot free a LATER holder's lock", () => {
    // The theft shape that survived three custom representations. Here it is
    // structurally impossible — release() ends THIS process's own child, and a
    // child can only be ended once — but the arm stays, because "impossible by
    // construction" is a claim about the construction and this is the test that
    // the construction is what I think it is.
    const a = acquirePaneLock("p:0.0", 200, env)!;
    a.release();
    const b = acquirePaneLock("p:0.0", 200, env)!;
    a.release(); // the stale holder tries again
    expect(acquirePaneLock("p:0.0", 200, env)).toBeNull(); // b still holds it
    b.release();
  });
});

describe("obligation settlement serialization", () => {
  test("long obligation keys distinguish suffixes and cannot alias short digest-shaped ids", () => {
    const key = "x".repeat(244) + "a";
    const first = acquireObligationLock(key, 0, env);
    expect(first).not.toBeNull();
    try {
      const suffix = acquireObligationLock("x".repeat(244) + "b", 0, env);
      try { expect(suffix).not.toBeNull(); } finally { suffix?.release(); }
      const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
      const literal = acquireObligationLock(hash, 0, env);
      try { expect(literal).not.toBeNull(); } finally { literal?.release(); }
    } finally { first?.release(); }
  });

  test("the same obligation contends while different ids do not", () => {
    const first = acquireObligationLock("sender-20260825T040000Z-aaaaaaaaaaaa", 200, env);
    expect(first).not.toBeNull();
    expect(acquireObligationLock("sender-20260825T040000Z-aaaaaaaaaaaa", 0, env)).toBeNull();

    const other = acquireObligationLock("sender-20260825T040000Z-bbbbbbbbbbbb", 200, env);
    expect(other).not.toBeNull();
    other!.release();
    first!.release();
  });
});
describe("the kernel owns liveness — the property the custom versions kept getting wrong", () => {
  test("a SIGKILLED holder's lock is dropped, with no reaper and no staleness rule", () => {
    // Three custom representations existed to answer "is the holder still
    // alive?" from the filesystem, and each leaked a different theft path
    // answering it. The kernel answers it for free: kill -9 drops the flock.
    const holder = Bun.spawn(["bun", "-e", childSrc(`
      const l = acquirePaneLock("k:0.0", 500, env);
      console.log(l ? "HELD" : "REFUSED");
      Bun.sleepSync(30_000); // never releases; it will be killed mid-hold
    `)], { stdout: "pipe", stderr: "ignore" });

    // Wait for it to actually hold before killing it, or the test proves nothing.
    const deadline = Date.now() + 10_000;
    for (;;) {
      // If we CAN acquire, the child has not got it yet — give it straight back.
      // ONE call per iteration: an earlier version acquired twice and released
      // once, leaking a holder that then wedged the very lock under test.
      const probe = acquirePaneLock("k:0.0", 0, env);
      if (!probe) break;
      probe.release();
      if (Date.now() > deadline) break;
      Bun.sleepSync(20);
    }
    expect(acquirePaneLock("k:0.0", 0, env)).toBeNull(); // positively held by the child

    holder.kill(9);
    // No grace period, no age horizon, no owner record: the lock is free as
    // soon as the process is.
    const after = acquirePaneLock("k:0.0", 3000, env);
    expect(after).not.toBeNull();
    after!.release();
  }, 30_000);

  test("a LIVE holder is never displaced, at any age", () => {
    // The other half, and the one the reviewer's closing addendum names: age
    // alone must never free a lock. The custom versions had a 10s and then a
    // 30s horizon and both stole live locks. There is no horizon to test now,
    // so the test is behavioral — hold across one, keep holding.
    const a = acquirePaneLock("age:0.0", 200, env)!;
    Bun.sleepSync(1200);
    expect(acquirePaneLock("age:0.0", 0, env)).toBeNull();
    a.release();
  }, 15_000);
});

describe("the hold is this process's own descriptor (verb-prelude row F)", () => {
  test("a child spawned inside the critical section never extends the hold", () => {
    const path = join(dir, "inherit.lock");
    const held = acquirePathLock(path, 1000, env)!;
    // A long-lived child started while holding: with an inherited descriptor
    // the flock would outlive release() for as long as this child runs.
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      held.release();
      const contender = spawnSync(KERNEL_LOCK, kernelLockArgs(path, 0, ["true"]));
      expect(contender.status).toBe(0);
    } finally { child.kill("SIGKILL"); }
  });

  test("acquire and release cost no process: 50 cycles finish far inside one helper round trip each", () => {
    // The spawned helper cost ~40 ms per cycle (grant + release fence), so 50
    // cycles took ~2 s. In-process they take a few milliseconds; the bound
    // leaves ample room for a loaded host while still refusing a helper.
    const path = join(dir, "cost.lock");
    const start = performance.now();
    for (let i = 0; i < 50; i++) acquirePathLock(path, 1000, env)!.release();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("mutual exclusion under a REAL race, proven by overlap and not by return values", () => {
  test("EIGHT concurrent contenders: exactly one holds, and nobody overlaps", async () => {
    // The reviewer's closing gate: a test that only inspects what acquire RETURNS
    // is insufficient, because a broken lock can hand out one "true" and still
    // let two processes into the critical section. So each winner writes its
    // own ENTER and EXIT into a shared timeline with real time between them,
    // and the assertion is on the SHAPE of that timeline: no other process's
    // mark may appear between an ENTER and its EXIT.
    const timeline = join(dir, "timeline.txt");
    const kids = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", "-e", childSrc(`
        // 5s timeout, so contenders QUEUE rather than fail fast: a serialized
        // queue is a much stronger test of the critical section than a race
        // where seven give up immediately.
        const l = acquirePaneLock("z:0.0", 5000, env);
        if (!l) { console.log("REFUSED"); process.exit(0); }
        const fs = await import("node:fs");
        fs.appendFileSync("${timeline}", "ENTER ${i}" + String.fromCharCode(10));
        Bun.sleepSync(120);                       // a critical section with real width
        fs.appendFileSync("${timeline}", "EXIT ${i}" + String.fromCharCode(10));
        console.log("HELD");
        l.release();
      `)], { stdout: "pipe", stderr: "pipe" }));

    const out = await Promise.all(kids.map((k) => new Response(k.stdout).text()));
    const errs = await Promise.all(kids.map((k) => new Response(k.stderr).text()));
    expect(errs.filter((e) => e.trim() !== "")).toEqual([]);
    // Every child must have REPORTED. A crashed child is a missing vote, and a
    // missing vote reads as "no overlap" — the failure would hide itself.
    expect(out.filter((t) => /HELD|REFUSED/.test(t))).toHaveLength(8);

    const marks = readFileSync(timeline, "utf8").trim().split("\n").filter(Boolean);
    // THE OVERLAP ASSERTION. Walk the timeline; at most one process may be
    // inside at a time, and the ENTER/EXIT pairs must nest perfectly.
    let inside: string | null = null;
    for (const m of marks) {
      const [kind, who] = m.split(" ") as [string, string];
      if (kind === "ENTER") {
        expect(inside).toBeNull();   // someone was already in the critical section
        inside = who;
      } else {
        expect(inside).toBe(who);    // an exit that does not match the occupant
        inside = null;
      }
    }
    expect(inside).toBeNull();
    // And the queue really ran: every winner produced a matched pair.
    expect(marks).toHaveLength(out.filter((t) => t.includes("HELD")).length * 2);
    expect(out.filter((t) => t.includes("HELD")).length).toBeGreaterThan(1);
  }, 60_000);
});

describe("the platform premise, checked rather than assumed", () => {
  test("the kernel primitive is present and refuses a contender", () => {
    // The comment this file used to carry — \"macOS ships no flock, therefore
    // custom stale-owner rules\" — was a false premise that cost three
    // representations. It is now an assertion, so it cannot rot back into prose.
    expect(kernelLockAvailable()).toBe(true);
    const a = acquirePaneLock("probe:0.0", 200, env)!;
    const contender = spawnSync(KERNEL_LOCK, kernelLockArgs(join(dir, "pane-submit-probe_0.0.lock"), 0, ["true"]));
    expect(contender.status).toBe(process.platform === "linux" ? 1 : 75);
    a.release();
  });

  // DELETED: "acquire FAILS CLOSED if the primitive is missing" (partner review).
  // It was named for a guard it did not exercise — PATH is irrelevant because
  // KERNEL_LOCK is an absolute path, and the arm expected `not.toThrow`. Its own
  // comment admitted this, which made it a placebo that documented itself as
  // one. The guard (acquirePaneLock throws when kernelLockAvailable() is false)
  // cannot be exercised on a host that HAS the binary without faking the
  // check, so the honest state is no arm rather than an arm that cannot fail.

});

describe("the lock root respects the isolation authority", () => {
  test("TAP_LOCK_DIR wins", () => {
    expect(lockRoot({ TAP_LOCK_DIR: "/x", TAP_INDEX_HOME: "/y", TAP_HOME: "/z" } as NodeJS.ProcessEnv)).toBe("/x");
  });

  test("a scratch TAP_INDEX_HOME keeps locks OUT of production", () => {
    expect(lockRoot({ TAP_INDEX_HOME: "/scratch", TAP_HOME: "/bus" } as NodeJS.ProcessEnv)).toBe("/scratch/locks");
  });

  test("a TAP_HOME-only pin keeps locks with the bus, out of ~/.tap (tap-7r3fn.66)", () => {
    expect(lockRoot({ TAP_HOME: "/bus" } as NodeJS.ProcessEnv)).toBe("/bus/locks");
  });

  test("a --team override bus keeps the incumbent default (derived, not pinned)", () => {
    expect(lockRoot({ TAP_HOME: "/bus", TAP_TEAM_OVERRIDE_BUS: "/bus" } as NodeJS.ProcessEnv))
      .toMatch(/\/\.tap\/locks$/);
  });

  test("an empty TAP_HOME pin falls through like unset", () => {
    expect(lockRoot({ TAP_HOME: "" } as NodeJS.ProcessEnv)).toMatch(/\/\.tap\/locks$/);
  });

  test("production is the LAST resort, not the default", () => {
    expect(lockRoot({} as NodeJS.ProcessEnv)).toMatch(/\/\.tap\/locks$/);
  });
});

describe("the pane key sanitizes into one lock-name namespace", () => {
  // The charset is the production regex in panelock's lockPath: everything
  // outside [A-Za-z0-9_.-] becomes "_". The dot and dash cells catch a loosened
  // class (the retired smoke's k10-sanitizer-loosen mutant).
  test("pane-target separators collapse; dot and dash survive", () => {
    expect(paneLockPath("tap/x:0.0", env)).toBe(join(dir, "pane-submit-tap_x_0.0.lock"));
    expect(paneLockPath("%115", env)).toBe(join(dir, "pane-submit-_115.lock"));
    expect(paneLockPath("a b/c:1.2", env)).toBe(join(dir, "pane-submit-a_b_c_1.2.lock"));
    expect(paneLockPath("tap-dev:0.1", env)).toBe(join(dir, "pane-submit-tap-dev_0.1.lock"));
  });
});

describe("send registry snapshot revalidation", () => {
  test.each([false, true])("registry readers do not block writers and preserve pinned identity (late rewrite: %s)", async (forcePark) => {
    const root = mkdtempSync(join(tmpdir(), "tap-send-registry-race."));
    const wt = join(root, "team");
    const bus = join(wt, ".tap", "bus");
    const registry = join(wt, ".tap", "team-registry.json");
    const index = join(root, "index");
    const bin = join(root, "bin");
    const reached = join(root, "observe-reached");
    const release = join(root, "observe-release");
    const once = join(root, "observe-once");
    const band = join(root, "band");
    const submitted = join(root, "submitted");
    const mutatorMarker = join(root, "mutator-acquired");
    const captured = join(root, "readiness-captured");
    const replacement = join(root, "registry-b.json");
    for (const path of [join(bus, "payloads"), join(bus, "receipts"), index, bin]) {
      mkdirSync(path, { recursive: true });
    }
    spawnSync("git", ["init", "-q", wt]);

    const registryDoc = (suffix: string) => JSON.stringify({
      schema: "0.20",
      team: { name: "race", worktree_root: wt },
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: `ua|${suffix}`, harness: "claude" },
        ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: `ub|${suffix}`, harness: "claude" },
      },
    });
    writeFileSync(registry, registryDoc("A"));
    writeFileSync(replacement, registryDoc("B"));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: { race: { root: wt, registry_location: registry, state: "registered" } },
    }));

    // The first identity observation is an exact barrier inside cmdSend's
    // immutable snapshot window. The remaining branches are just enough tmux
    // behavior for submit-verify to finish after the barrier is released.
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *" -t ua:0.0 "*|*" -t %6 "*) fake_pane=6; fake_session=ua ;;
  *) fake_pane=7; fake_session=ub ;;
esac
case " $* " in
  *"#{pane_id}"*"#{session_name}"*)
    if mkdir "$FAKE_ONCE" 2>/dev/null; then
      : > "$FAKE_REACHED"
      while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.01; done
    fi
    printf '%%%s\\t%s\\t4242\\tclaude\\t0\\n' "$fake_pane" "$fake_session"
    ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_id}"*)
    if mkdir "$FAKE_ONCE" 2>/dev/null; then
      : > "$FAKE_REACHED"
      while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.01; done
    fi
    printf '%%%s\\t%s\\t123:456\\n' "$fake_pane" "$fake_session"
    ;;
  *"capture-pane"*)
    : > "$FAKE_CAPTURED"
    if [ "$FAKE_FORCE_READINESS_PARK" = 1 ]; then printf 'no recognizable composer\\n'; exit 0; fi
    if [ -e "$FAKE_SUBMITTED" ]; then printf '› \\n──────────\\n'
    elif [ -e "$FAKE_BAND" ]; then printf '› '; cat "$FAKE_BAND"; printf '\\n──────────\\n'
    else printf '› \\n──────────\\n'; fi
    ;;
  *"send-keys"*)
    case " $* " in
      *" -l -- "*) for last do :; done; printf '%s' "$last" > "$FAKE_BAND" ;;
      *" Enter "*) : > "$FAKE_SUBMITTED" ;;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });

    const childEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TAP_HOME: bus,
      TAP_INDEX_HOME: index,
      TAP_SESSION_MANIFEST: join(root, "sessions.json"),
      OPENCODE_DB_PATH: join(root, "opencode.db"),
      TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
      TAP_LOCK_DIR: join(root, "locks"),
      TAP_SELF: "ua",
      TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
      TMUX: undefined,
      TMUX_PANE: undefined,
      FAKE_ONCE: once,
      FAKE_REACHED: reached,
      FAKE_RELEASE: release,
      FAKE_BAND: band,
      FAKE_SUBMITTED: submitted,
      FAKE_CAPTURED: captured,
      FAKE_FORCE_READINESS_PARK: forcePark ? "1" : "0",
      TAP_SPOOL_DISABLE_DELIVERER: "1",
    } as NodeJS.ProcessEnv;
    const send = Bun.spawn([process.execPath, NATIVE_SEND, "ub", "-m", "snapshot", "--from", "ua", "--ask"], {
      cwd: wt, env: childEnv, stdout: "pipe", stderr: "pipe",
    });

    const deadline = Date.now() + 10_000;
    while (!existsSync(reached) && Date.now() < deadline) Bun.sleepSync(10);
    expect(existsSync(reached)).toBe(true);

    // Reading an atomic snapshot must not hold the writer sidecar.
    const heldBySend = spawnSync(KERNEL_LOCK, kernelLockArgs(`${registry}.lock`, 0, ["true"])).status !== 0;
    const mutation = [KERNEL_LOCK, ...kernelLockArgs(`${registry}.lock`, 10000, ["sh", "-c",
      ': > "$1"; cp "$2" "$3"', "sh", mutatorMarker, replacement, registry])];
    // The late writer starts after publication, without owning the ledger while
    // waiting for pane I/O; the early writer still races the initial snapshot.
    const mutator = Bun.spawn(forcePark
      ? ["sh", "-c", 'while [ ! -e "$1" ]; do sleep 0.01; done; shift; exec "$@"', "sh", captured, ...mutation]
      : mutation, { env: childEnv, stdout: "pipe", stderr: "pipe" });
    const writerDeadline = Date.now() + 5000;
    while (!forcePark && !existsSync(mutatorMarker) && Date.now() < writerDeadline) await Bun.sleep(10);
    const mutatorBlockedBeforeRelease = !existsSync(mutatorMarker);
    if (!forcePark) await mutator.exited;

    writeFileSync(release, "go\n");
    const [sendCode, mutatorCode] = await Promise.all([send.exited, mutator.exited]);
    const sendOut = await new Response(send.stdout).text();
    const sendErr = await new Response(send.stderr).text();
    const mutatorErr = await new Response(mutator.stderr).text();

    expect(heldBySend).toBe(false);
    expect(mutatorBlockedBeforeRelease).toBe(forcePark);
    if (!forcePark) {
      expect(sendCode).toBe(1);
      expect(sendErr).toContain("sender registration changed");
      expect(readdirSync(join(bus, "payloads"))).toEqual([]);
      expect(existsSync(submitted)).toBe(false);
      expect(mutatorCode, mutatorErr).toBe(0);
      return;
    }
    expect(sendCode, sendErr).toBe(0);
    // The later B rewrite can make delivery queue after the A placement.
    // The lock and canonical instance stamps below prove the snapshot.
    expect(sendOut).toMatch(/^tap send: (ok|queued) /);
    // A readonly readiness park can win before the B rewrite reaches the
    // courier's effect check. Its durable envelope remains the captured A.
    // Delay the rewrite until that observation in the second arm to reproduce
    // the historical queued/empty-stderr outcome without faking send output.
    const locations = ["payloads", "spool"].flatMap(dir => {
      const path = join(bus, dir);
      return existsSync(path) ? readdirSync(path).filter(name => name.endsWith(".md")).map(name => join(path, name)) : [];
    });
    expect(locations).toHaveLength(1);
    const canonical = readFileSync(locations[0]!, "utf8");
    expect(envelopeField(canonical, "sender_instance")).toBe("ua|A");
    expect(envelopeField(canonical, "recipient_instance")).toBe("ub|A");
    const parked = locations[0]!.startsWith(join(bus, "spool") + "/");
    if (forcePark) expect(parked).toBe(true);
    if (parked) {
      expect(sendOut).toContain("Queue: busy/no-input-prompt");
      expect(sendErr).toBe("");
      const meta = JSON.parse(readFileSync(locations[0]!.replace(/\.md$/, ".meta.json"), "utf8"));
      expect(meta.reason).toBe("no-input-prompt");
      expect(existsSync(band)).toBe(false);
      console.error("TAP_UNIT3_SNAPSHOT_DISCRIMINATOR " + JSON.stringify({
        forcePark, heldBySend, mutatorBlockedBeforeRelease, sendOut, sendErr,
        payloadCount: locations.length, location: "spool", reason: meta.reason,
        sender_instance: envelopeField(canonical, "sender_instance"),
        recipient_instance: envelopeField(canonical, "recipient_instance"),
        submitted: existsSync(submitted), registryIsB: readFileSync(registry, "utf8") === registryDoc("B"),
      }));
      expect(existsSync(submitted)).toBe(false);
    } else if (sendOut.startsWith("tap send: queued ")) {
      expect(sendErr).toBe("tap send: identity_mismatch; 'ub' is instance 'ub|B', not the captured 'ub|A' — refusing to deliver to a pane that is not the addressed seat; action: tap register ub   (the recorded pane is stale; re-register to rebind)\n");
      expect(existsSync(submitted)).toBe(false);
    } else {
      expect(sendErr).toBe("");
    }
    expect(mutatorCode).toBe(0);
    expect(mutatorErr).toBe("");
    expect(readFileSync(registry, "utf8")).toBe(registryDoc("B"));

    removeScratchTree(root);
  }, 30_000);
});

describe("re-authorization before every pane effect — blocker 3", () => {
  // The partner reviewer rejected the previous source-regex version of these tests,
  // correctly: a regex passes if authorize always returns null, or validates
  // the wrong identity, or the helper targets the wrong pane. It proves the
  // code was written, not that it works.
  //
  // This drives a deterministic fake through the injected effect seam. No
  // sleeps, no timing race: the replacement happens BETWEEN effects because the
  // fake makes it happen there.
  const bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

  /** A fake tmux whose pane can be swapped at a chosen moment. */
  function fakeEffects(swapAfterEnters: number) {
    const received: Record<string, string[]> = {};
    const replacementReceived: string[] = [];
    let enters = 0;
    let livePaneId = "%7";
    let liveEpoch = "srv:1:2";
    const record = (t: string, what: string) => {
      (received[t] ??= []).push(what);
    };
    return {
      received,
      replacementReceived,
      replaceServer() { liveEpoch = "srv:9:9"; },
      get enters() { return enters; },
      fx: {
        observePane: (_t: string) => ({
          paneId: livePaneId, session: "s", serverEpoch: liveEpoch,
          panePid: "4242", currentCommand: "claude",
        }),
        // After acceptance the harness is mid-turn, with no visible composer.
        paneState: () => enters > 0
          ? { state: "unobservable" as const, reason: "no input prompt is visible (harness mid-turn)" }
          : { state: "ready" as const },
        injectText: (t: string, text: string) => {
          if (liveEpoch === bound.serverEpoch) record(t, `inject:${text.slice(0, 12)}`);
          else replacementReceived.push(text);
          return true;
        },
        // The band clears once Enter has been pressed, so the loop terminates.
        inputHasId: () => enters === 0,
        pressEnter: (t: string) => {
          record(t, "enter");
          enters++;
          // THE REPLACEMENT, at the exact moment under test.
          if (enters === swapAfterEnters) livePaneId = "%99";
          return true;
        },
        settle: () => {},
        harnessEvidence: () => "alive" as const,
      },
    };
  }

  test("a pane replaced before the FIRST Enter receives nothing either", () => {
    const f = fakeEffects(0);
    // Swap before any effect by pre-poisoning the observation.
    let calls = 0;
    const fx = {
      ...f.fx,
      observePane: (_t: string) => {
        calls++;
        return {
          paneId: calls > 1 ? "%99" : "%7", session: "s", serverEpoch: "srv:1:2",
          panePid: "4242", currentCommand: "claude",
        };
      },
    };
    const r = submitVerifyLocked("sess:0.0", "id-2", deliveryWire("id-2"), bound, fx);
    expect(r.status).toBe("identity_mismatch");
    expect(f.received["%99"]).toBeUndefined();
  });

  test("a server rebirth after band inspection receives no sentinel text", () => {
    const f = fakeEffects(99);
    const fx = {
      ...f.fx,
      paneState: () => {
        f.replaceServer();
        return { state: "ready" as const };
      },
    };

    const r = submitVerifyLocked("sess:0.0", "id-preinject", deliveryWire("id-preinject"), bound, fx);

    expect(r.status).toBe("identity_mismatch");
    expect(f.replacementReceived).toEqual([]);
  });

  test("rate exhaustion before injection is typed and has no pane effect", () => {
    const f = fakeEffects(99);
    const r = submitVerifyLocked("sess:0.0", "id-rate-pre", deliveryWire("id-rate-pre"), bound, {
      ...f.fx,
      paneState: () => ({ state: "rate_limited" as const, reason: "tmux client budget exhausted" }),
    });

    expect(r.status).toBe("rate_limited");
    expect(f.received).toEqual({});
    expect(f.replacementReceived).toEqual([]);
  });

  test("rate exhaustion after injection is unverified, never pane-gone", () => {
    const f = fakeEffects(99);
    let pressCalls = 0;
    const r = submitVerifyLocked("sess:0.0", "id-rate-post", deliveryWire("id-rate-post"), bound, {
      ...f.fx,
      pressEnter: () => { pressCalls++; return "rate_limited" as const; },
      paneState: () => pressCalls > 0
        ? { state: "rate_limited" as const, reason: "tmux client budget exhausted" }
        : { state: "ready" as const },
    });

    expect(r.status).toBe("unverified");
    expect(r.status).not.toBe("pane_gone");
    expect(f.received["%7"]).toEqual([`inject:${deliveryWire("id-rate-post").slice(0, 12)}`]);
    expect(pressCalls).toBe(1);
  });

  test("with no replacement, effects target the BOUND ID and the submit succeeds", () => {
    // The positive control. Without it, a courier that refused everything —
    // or targeted nothing at all — would satisfy both tests above.
    const f = fakeEffects(99);
    const r = submitVerifyLocked("sess:0.0", "id-3", deliveryWire("id-3"), bound, f.fx);

    expect(r.status).toBe("injected");
    // Addressed by pane id, not by the positional "sess:0.0".
    expect(Object.keys(f.received)).toEqual(["%7"]);
    expect(f.received["%7"]).toContain("enter");
    expect(f.enters).toBe(1);
    expect(f.received["sess:0.0"]).toBeUndefined();
  });

  // tap-wudl2: the final readiness read is itself a tmux round-trip, and the
  // registry can rebind the handle while it runs. The pane never changes here;
  // only the acting row moves, so only a row reread AFTER that read can refuse.
  for (const rebind of [false, true]) {
    test(`a registry rebind during the final band read ${rebind ? "refuses before paste, admission, or Enter" : "is absent: the same fixture pastes and admits (control)"}`, () => {
      const registry = join(dir, "registry.json");
      const rowFor = (paneId: string) => JSON.stringify({ schema: "0.20", seats: { peer: {
        status: "active", harness: "claude", permissions: "bypass", pane_id: paneId, pane: "s:0.0",
        instance: "peer|A", server_epoch: "srv:1:2" } } });
      writeFileSync(registry, rowFor("%7"));
      mkdirSync(join(dir, "receipts"));
      const f = fakeEffects(99);
      let bandReads = 0;
      const fx = {
        ...f.fx,
        paneState: () => {
          bandReads++;
          // Read 1 is the pre-disposition band; read 2 is the final sample
          // immediately before the paste boundary.
          if (rebind && bandReads === 2) writeFileSync(registry, rowFor("%8"));
          return f.fx.paneState();
        },
      };
      const r = submitVerifyLocked("s:0.0", "id-final-rebind", deliveryWire("id-final-rebind"),
        { ...bound, handle: "peer", instance: "peer|A" }, fx, {
          scriptsDir: resolve(import.meta.dir, "../../../skills/tap/scripts"), agentFamilies: AGENT_FAMILIES,
          busHome: dir, recipient: "peer", registryPath: registry,
          deliveryFacts: { urgent: false, noSpool: false, recipientBound: true, harness: "claude" },
        });
      if (rebind) {
        expect(bandReads).toBe(2);
        expect(r.status).toBe("identity_mismatch");
        expect(f.received).toEqual({});
        expect(f.enters).toBe(0);
        expect(existsSync(join(dir, "receipts", "id-final-rebind.attempted"))).toBe(false);
      } else {
        expect(r.status).toBe("injected");
        expect(f.received["%7"]).toEqual([`inject:${deliveryWire("id-final-rebind").slice(0, 12)}`, "enter"]);
        expect(existsSync(join(dir, "receipts", "id-final-rebind.attempted"))).toBe(true);
      }
    });
  }

  test("a pane replaced after Enter with an absent clear sample is unverified, not injected", () => {
    const f = fakeEffects(1);
    const r = submitVerifyLocked("sess:0.0", "id-post-enter", deliveryWire("id-post-enter"), bound, f.fx);
    expect(r.status).toBe("unverified");
    expect(r.status).not.toBe("injected");
    expect(r.status).not.toBe("identity_mismatch");
    expect(f.received["%7"]).toContain("enter");
  });
});

describe("Unit I — positive harness reauthorization (dgbNN)", () => {
  const bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

  function baseFx(overrides: Record<string, unknown> = {}) {
    const received: Record<string, string[]> = {};
    let paneCmdCalls = 0;
    const fx = {
      observePane: () => ({
        paneId: "%7", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: "claude",
      }),
      paneCurrentCommand: () => {
        paneCmdCalls++;
        throw new Error("independent paneCurrentCommand must not be called");
      },
      paneState: (_t: string, harness: string, cmd: string) => {
        received.bandCmd = [harness, cmd];
        return { state: "ready" as const };
      },
      injectText: (t: string, text: string) => {
        (received[t] ??= []).push(`inject:${text.slice(0, 12)}`);
        return true;
      },
      inputHasId: () => false,
      pressEnter: (t: string) => {
        (received[t] ??= []).push("enter");
        return true;
      },
      settle: () => {},
      harnessEvidence: () => "alive" as const,
      ...overrides,
    };
    return { fx, received, paneCmdCalls: () => paneCmdCalls };
  }

  test("known-family mismatch is identity_mismatch with zero effects", () => {
    const { fx, received } = baseFx({
      observePane: () => ({
        paneId: "%7", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: "codex",
      }),
      harnessEvidence: () => "mismatch" as const,
    });
    const r = submitVerifyLocked("sess:0.0", "id-mm", deliveryWire("id-mm"), bound, fx as never);
    expect(r.status).toBe("identity_mismatch");
    expect(received["%7"]).toBeUndefined();
  });

  test("shell after stale Claude with HUMAN-DRAFT refuses with zero effects", () => {
    const { fx, received } = baseFx({
      observePane: () => ({
        paneId: "%7", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: "zsh",
      }),
      harnessEvidence: () => "exited" as const,
      paneState: () => ({ state: "busy" as const, text: "HUMAN-DRAFT" }),
    });
    const r = submitVerifyLocked("sess:0.0", "id-shell", deliveryWire("id-shell"), bound, fx as never);
    expect(r.status).toBe("identity_mismatch");
    expect(received["%7"]).toBeUndefined();
  });

  test("bound Cursor with positively observed node is allowed", () => {
    const { fx, received } = baseFx({
      observePane: () => ({
        paneId: "%7", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: "node",
      }),
      harnessEvidence: () => "alive" as const,
      inputHasId: (_t: string, _cmd: string, _id: string) => {
        const n = (received.lands ??= []);
        n.push("1");
        return n.length === 1;
      },
    });
    const r = submitVerifyLocked("sess:0.0", "id-node", deliveryWire("id-node"), { ...bound, harness: "cursor" }, fx as never);
    expect(r.status).toBe("injected");
    expect(received["%7"]?.some((x) => x.startsWith("inject:"))).toBe(true);
  });

  test("shallow Claude version-string with positively observed Claude is allowed", () => {
    const { fx, received } = baseFx({
      observePane: () => ({
        paneId: "%7", session: "s", serverEpoch: "srv:1:2",
        panePid: "4242", currentCommand: "2.1.198",
      }),
      harnessEvidence: () => "alive" as const,
      inputHasId: (_t: string, _cmd: string, _id: string) => {
        const n = (received.lands ??= []);
        n.push("1");
        return n.length === 1;
      },
    });
    const r = submitVerifyLocked("sess:0.0", "id-ver", deliveryWire("id-ver"), bound, fx as never);
    expect(r.status).toBe("injected");
    expect(received["%7"]?.some((x) => x.startsWith("inject:"))).toBe(true);
  });

  test("unobservable evidence refuses and never guesses", () => {
    const { fx, received } = baseFx({
      harnessEvidence: () => "unobservable" as const,
    });
    const r = submitVerifyLocked("sess:0.0", "id-unobs", deliveryWire("id-unobs"), bound, fx as never);
    expect(r.status).toBe("identity_mismatch");
    expect(received["%7"]).toBeUndefined();
  });

  test("classifier uses the authorized currentCommand; independent paneCurrentCommand is never called", () => {
    let lands = 0;
    const { fx, received, paneCmdCalls } = baseFx({
      inputHasId: (_t: string, cmd: string) => {
        received.landCmd = [cmd];
        lands++;
        return lands === 1;
      },
    });
    const r = submitVerifyLocked("sess:0.0", "id-custody", deliveryWire("id-custody"), bound, fx as never);
    expect(paneCmdCalls()).toBe(0);
    expect(received.bandCmd).toEqual(["claude", "claude"]);
    expect(r.status).toBe("injected");
  });

  test("empty expected family is unattested refuse, not a wildcard", () => {
    expect(evaluateHarnessEvidence("", "claude", "4242", AGENT_FAMILIES, null)).toBe("unattested");
    const { fx, received } = baseFx();
    delete (fx as { harnessEvidence?: unknown }).harnessEvidence;
    const r = submitVerifyLocked(
      "sess:0.0", "id-unattested", deliveryWire("id-unattested"),
      { ...bound, harness: "" }, fx as never,
      { registryPath: "", scriptsDir: "/unused", agentFamilies: AGENT_FAMILIES },
    );
    expect(r.status).toBe("identity_mismatch");
    expect(received["%7"]).toBeUndefined();
  });
});

describe("Unit I — production observer bridge", () => {
  const root = resolve(import.meta.dir, "../../..");
  const scriptsDir = join(root, "skills/tap/scripts");

  // The property is no longer "a child was spawned with these argv" — there is
  // no child. It is that the CONFIGURED family set reaches the observation.
  // That set used to arrive as TAP_OBS_HARNESS_FAMILIES across a process
  // boundary, and an environment variable is visible in an argv log; in-process
  // it is an argument, which is exactly the thing a port drops silently. Slice 1
  // shipped that defect once already (a native caller lost a configured
  // TAP_REGISTRY_EVENT_LIMIT that had only ever arrived by child-process
  // inheritance), so this arm hands in a family the DEFAULTS DO NOT CONTAIN: a
  // bridge that ignores its argument and reaches for AGENT_FAMILIES cannot
  // classify `zzz`, and reds here rather than passing on the default.
  test("the configured family set reaches the observation, not the default set", () => {
    const bin = mkdtempSync(join(tmpdir(), "tap-obs-pid."));
    const psLog = join(bin, "ps.log");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(psLog)}
printf '4242 4242 4242 zzz /usr/bin/zzz\\n'
exit 0
`, { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      expect(AGENT_FAMILIES.has("zzz")).toBe(false);
      const configured = new Set(["zzz"]);
      const r = observeHarnessPid(scriptsDir, configured, "4242");
      expect(r).toEqual({ state: "observed", family: "zzz", pid: "4242" });
      expect(evaluateHarnessEvidence("zzz", "node", "4242", configured, r)).toBe("alive");
      // The table was read here, in this process, through PATH.
      expect(existsSync(psLog)).toBe(true);
      expect(readFileSync(psLog, "utf8")).toContain("-Ao pid=,pgid=,tpgid=,comm=,command=");
    } finally {
      process.env.PATH = prev;
      removeScratchTree(bin);
    }
  });

  test("submitVerifyLocked without inject seam hits observeHarnessPid for shallow node", () => {
    const bin = mkdtempSync(join(tmpdir(), "tap-obs-auth."));
    const psLog = join(bin, "ps.log");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(psLog)}
exit 0
`, { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const received: Record<string, string[]> = {};
      const fx = {
        observePane: () => ({
          paneId: "%7", session: "s", serverEpoch: "srv:1:2",
          panePid: "4242", currentCommand: "node",
        }),
        paneState: () => { received.band = ["hit"]; return { state: "ready" as const }; },
        injectText: () => { received.inject = ["hit"]; return true; },
        inputHasId: () => false,
        pressEnter: () => { received.enter = ["hit"]; return true; },
        settle: () => {},
      };
      const r = submitVerifyLocked(
        "sess:0.0", "id-bridge", deliveryWire("id-bridge"),
        { paneId: "%7", serverEpoch: "srv:1:2", harness: "cursor" },
        fx as never,
        { registryPath: "", scriptsDir, agentFamilies: AGENT_FAMILIES },
      );
      expect(r.status).toBe("identity_mismatch");
      expect(received.band).toBeUndefined();
      expect(received.inject).toBeUndefined();
      // The bridge still consults the process table for the pane's pid on the
      // shallow-command path. `existsSync` first: a missing log throws ENOENT
      // out of readFileSync, which reds honestly, but naming the file's
      // existence says what the arm is actually asserting.
      expect(existsSync(psLog)).toBe(true);
      expect(readFileSync(psLog, "utf8")).toContain("-Ao pid=,pgid=,tpgid=,comm=,command=");
    } finally {
      process.env.PATH = prev;
      removeScratchTree(bin);
    }
  });

  // CHARACTERIZATION, and labelled so no one cites it as more. A `ps` that
  // exits nonzero and a `ps` that answers without the pid both read
  // `unobservable`, so a mutant that ignores `psOk` SURVIVES this arm: the
  // fixture cannot distinguish the two by value. It is kept because the
  // polarity it pins is the one that deletes live seats — neither shape may
  // ever read `alive` — not because it discriminates the guard.
  test("an unreadable process table and an absent pid both read unobservable, never alive", () => {
    const bin = mkdtempSync(join(tmpdir(), "tap-obs-bad."));
    const prev = process.env.PATH;
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf 'garbage\\n'
exit 2
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${prev}`;
    try {
      const failed = observeHarnessPid(scriptsDir, AGENT_FAMILIES, "9");
      expect(failed).toEqual({ state: "unobservable", family: "" });
      expect(evaluateHarnessEvidence("claude", "node", "9", AGENT_FAMILIES, failed)).toBe("unobservable");
    } finally {
      process.env.PATH = prev;
    }
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf 'garbage\\n'
exit 0
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${prev}`;
    try {
      const absent = observeHarnessPid(scriptsDir, AGENT_FAMILIES, "9");
      expect(absent).toEqual({ state: "unobservable", family: "" });
      expect(evaluateHarnessEvidence("claude", "node", "9", AGENT_FAMILIES, absent)).toBe("unobservable");
    } finally {
      process.env.PATH = prev;
      removeScratchTree(bin);
    }
  });

  // DELETED with the wire it described: "a valid first record plus extra line
  // or extra field is unobservable, never alive". That arm pinned
  // `parseHarnessPidStdout` — the framing of a US-separated record read back
  // from a python3 child. The child is gone, the parser is deleted, and a
  // malformed record is no longer a reachable state: the engine returns a typed
  // answer. This is a deletion, not a re-aim, and no reintroduced defect could
  // red it, because its subject does not exist. The adjacent property that DOES
  // survive — a malformed process TABLE never reads alive — is pinned at the
  // engine in `observe.test.ts`.

  // Six families end-to-end through the production bridge and the real engine;
  // only `ps` is faked, because the command spelling is the input under test.
  // The four spellings below are the gap a reviewer named — a command that
  // matches a family in one spelling and not another. They live here rather
  // than in a probe because a probe walking live pids cannot control what this
  // machine happens to be running.
  test("six families attest alive, and a family matches by basename or prefix — never as a substring", () => {
    const bin = mkdtempSync(join(tmpdir(), "tap-obs-six."));
    const familyFile = join(bin, "family");
    const psLog = join(bin, "ps.log");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(psLog)}
read -r comm command < ${JSON.stringify(familyFile)}
printf '4242 4242 4242 %s %s\\n' "$comm" "$command"
exit 0
`, { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      for (const family of AGENT_FAMILIES) {
        writeFileSync(familyFile, `${family} /usr/bin/${family}`);
        const r = observeHarnessPid(scriptsDir, AGENT_FAMILIES, "4242");
        expect(r).toEqual({ state: "observed", family, pid: "4242" });
        expect(evaluateHarnessEvidence(family, "node", "4242", AGENT_FAMILIES, r)).toBe("alive");
      }

      // `comm` is deliberately a non-family here, so each case turns ONLY on
      // the command spelling.
      const spellings: Array<[string, string, string]> = [
        ["absolute path", "node /usr/bin/codex", "codex"],
        ["bare name", "node codex", "codex"],
        ["family prefix", "node codex-exec", "codex"],
        // The one that must NOT match. A prefix test relaxed to `includes`
        // classifies this alive, which is the mutant that reds this arm.
        ["family as a substring of a longer command", "node foocodex", ""],
      ];
      for (const [label, row, expected] of spellings) {
        writeFileSync(familyFile, row);
        const r = observeHarnessPid(scriptsDir, AGENT_FAMILIES, "4242");
        expect({ label, family: r.family }).toEqual({ label, family: expected });
        expect({ label, evidence: evaluateHarnessEvidence("codex", "node", "4242", AGENT_FAMILIES, r) })
          .toEqual({ label, evidence: expected === "codex" ? "alive" : "exited" });
      }

      expect(existsSync(psLog)).toBe(true);
      expect(readFileSync(psLog, "utf8")).toContain("-Ao pid=,pgid=,tpgid=,comm=,command=");
    } finally {
      process.env.PATH = prev;
      removeScratchTree(bin);
    }
  });

  test("native reply outbound reaches the process-table observation inside the shipped binary", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tap-reply-obs."));
    const wt = join(scratch, "team");
    const bus = join(wt, ".tap", "bus");
    const registry = join(wt, ".tap", "team-registry.json");
    const index = join(scratch, "index");
    const bin = join(scratch, "bin");
    const argvLog = join(bin, "argv.log");
    const keysLog = join(scratch, "send-keys.log");
    const inboundId = "ub-20260830T000000Z-aabbccddeeff";
    for (const path of [join(bus, "payloads"), join(bus, "receipts"), index, bin]) {
      mkdirSync(path, { recursive: true });
    }
    spawnSync("git", ["init", "-q", wt]);
    writeFileSync(registry, JSON.stringify({
      schema: "0.20",
      team: { name: "replyobs", worktree_root: wt },
      seats: {
        ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
        ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "cursor" },
      },
    }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: { replyobs: { root: wt, registry_location: registry, state: "registered" } },
    }));
    const inbound = join(bus, "payloads", `${inboundId}.md`);
    writeFileSync(inbound,
      `---\nid: ${inboundId}\nfrom: ub\nto: ua\nkind: discuss\npath: ${inbound}\nreply: expected\n---\nquestion\n`);
    writeFileSync(join(bus, "receipts", `${inboundId}.placed`), "{}\n");
    const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
    writeFileSync(socketPath, "socket\n");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"#{pane_id}"*"#{session_name}"*) printf '%%7\\tub\\t4242\\tnode\\t0\\n' ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"send-keys"*) printf '%s\\n' "$*" >> ${JSON.stringify(keysLog)} ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(bin, "ps"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
exit 0
`, { mode: 0o755 });
    const reply = spawnSync(process.execPath, [NATIVE_REPLY, inboundId, "-m", "answer", "--by", "ua"], {
      cwd: wt,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TAP_HOME: bus,
        TAP_INDEX_HOME: index,
        TAP_SESSION_MANIFEST: join(scratch, "sessions.json"),
        OPENCODE_DB_PATH: join(scratch, "opencode.db"),
        TAP_VERSION_SEEN_PATH: join(scratch, "version-seen.json"),
        TAP_LOCK_DIR: join(scratch, "locks"),
        TAP_SELF: "ua",
        TAP_DRIVER_FORCE_TMUX: "1",
        TAP_TMUX_SOCKET_PATH: socketPath,
        TMUX: undefined,
        TMUX_PANE: undefined,
      } as NodeJS.ProcessEnv,
    });
    expect(reply.status).not.toBe(0);
    expect(existsSync(join(bus, "receipts", `${inboundId}.done`))).toBe(false);
    expect(existsSync(keysLog)).toBe(false);
    // The outbound path still reaches the observation inside the shipped
    // binary. The `obsenv=` assertion this arm used to carry is GONE and cannot
    // come back: the family set was observable here only as an environment
    // variable crossing a process boundary, and in-process there is no such
    // moment. That property moved to the first arm in this block, where a
    // non-default family set makes it load-bearing instead of a spelling.
    expect(existsSync(argvLog)).toBe(true);
    expect(readFileSync(argvLog, "utf8")).toContain("-Ao pid=,pgid=,tpgid=,comm=,command=");
    removeScratchTree(scratch);
  });
});

describe("a lock-system failure is a refusal, not contention", () => {
  test("only EWOULDBLOCK/EAGAIN and EINTR retry; an unreadable errno keeps the contention reading", () => {
    const wouldBlock = process.platform === "darwin" ? 35 : 11;
    expect(flockFailureRetryable(wouldBlock)).toBe(true);
    expect(flockFailureRetryable(4)).toBe(true); // EINTR
    expect(flockFailureRetryable(null)).toBe(true);
    for (const permanent of [9, 22, process.platform === "darwin" ? 77 : 37, process.platform === "darwin" ? 45 : 95]) {
      expect(flockFailureRetryable(permanent)).toBe(false); // EBADF, EINVAL, ENOLCK, EOPNOTSUPP
    }
  });

  test("an unbounded acquire on a descriptor flock(2) cannot lock refuses at once instead of spinning", () => {
    const dir = mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "flock-fifo-"));
    try {
      const fifo = join(dir, "not-a-lockfile");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const started = Date.now();
      let refused: unknown = null;
      try { acquireFlock(fifo, Infinity, false)?.release(); } catch (error) { refused = error; }
      expect(String(refused)).toContain("flock(2) failed with errno");
      expect(Date.now() - started).toBeLessThan(1000);
    } finally { removeScratchTree(dir); }
  }, 5000);
});

test("shared path admission coexists in sync and async callers but excludes default EX", async () => {
  const path = join(dir, "shared.lock");
  const one = acquirePathLock(path, 0, env, "shared")!;
  const two = await acquirePathLockAsync(path, 0, undefined, env, "shared");
  try {
    expect(two).not.toBeNull();
    expect(acquirePathLock(path, 0, env)).toBeNull();
  } finally { one.release(); await two?.release(); }
  const exclusive = acquirePathLock(path, 0, env)!;
  try { expect(await acquirePathLockAsync(path, 0, undefined, env, "shared")).toBeNull(); }
  finally { exclusive.release(); }
});
