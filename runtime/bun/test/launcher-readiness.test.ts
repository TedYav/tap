import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitStableHarness, awaitReplacedHarness, codexComposerIdle, opencodeComposerIdle, opencodeReadySignal, memoizedStartupObservation, paneTailLines, PaneObservationTimeout, parsePaneFacts, startStallWatch, START_STALLED, type PaneFacts } from "../src/launcher/readiness";
import { bindFingerprintOf, bindBaselineAfterPlaceholderBind, foreignPaneProgram, launchChainCommand, launchStartCeilingMs, sessionBindSignal, startFailureText } from "../src/launcher/transaction";
import type { PsRow } from "../src/observe";

const first:PaneFacts={pane:"fixture/seat:0.0",pane_id:"%1",server_epoch:"srv:1:1",pane_pid:2002,command:"codex",dead:false,path:"/fixture"};
const makeFacts = (): PaneFacts => ({ ...first });

test("a launch observation skips the real Codex update menu once and verifies painted empty input", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "update-skip-"));
  const before = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt"), "utf8");
  const after = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/idle.ansi"), "utf8");
  writeFileSync(join(root, "before"), before); writeFileSync(join(root, "after"), after);
  writeFileSync(join(root, "tmux"), `#!/bin/sh
case "$*" in
  *capture-pane*) if [ -e "$UPDATE_ROOT/skipped" ]; then cat "$UPDATE_ROOT/after"; else cat "$UPDATE_ROOT/before"; fi ;;
  *) printf 'tap\\n' ;;
esac
`, { mode: 0o755 });
  let keys = 0;
  const events: unknown[] = [];
  const observe = memoizedStartupObservation({ ...process.env, PATH: `${root}:${process.env.PATH}`, UPDATE_ROOT: root }, undefined, true, 5000, {
    authorize: async () => true,
    escape: async () => { keys++; writeFileSync(join(root, "skipped"), ""); return true; },
    record: (event: unknown) => { events.push(event); },
  });
  const observed = await observe(makeFacts());
  expect(codexComposerIdle(observed.screen, observed.title)).toBe(true);
  expect(keys).toBe(1);
  expect(events).toContainEqual(expect.objectContaining({ outcome: "skipped", current: "0.164.0", available: "0.165.0" }));
  // The same operation cannot send another Escape when the dialog remains/reappears.
  writeFileSync(join(root, "after"), before);
  const repeated = await observe(makeFacts());
  expect(repeated.updateSkipFailure).toContain("already attempted");
  expect(keys).toBe(1);
});

for (const afterText of ["still-menu", "› Ask Codex to do anything\n", "› a human draft\n"]) {
  test(`update dismissal stops after one key without a painted empty composer: ${afterText.trim()}`, async () => {
    const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "skip-held-"));
    const menu = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt"), "utf8");
    writeFileSync(join(root, "frame"), menu);
    writeFileSync(join(root, "tmux"), '#!/bin/sh\ncase "$*" in *capture-pane*) cat "$UPDATE_FRAME" ;; *) echo tap ;; esac\n', { mode: 0o755 });
    let keys = 0;
    const observe = memoizedStartupObservation({ ...process.env, PATH: `${root}:${process.env.PATH}`, UPDATE_FRAME: join(root, "frame") }, undefined, true, 5000, {
      authorize: async () => true,
      escape: async () => { keys++; writeFileSync(join(root, "frame"), afterText === "still-menu" ? menu : afterText); return true; },
      record: () => {},
    });
    expect((await observe(makeFacts())).updateSkipFailure).toContain("empty composer");
    await observe(makeFacts());
    expect(keys).toBe(1);
  });
}

test("a lost startup owner cannot send Escape into the update menu", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "skip-owner-"));
  writeFileSync(join(root, "frame"), readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt")));
  writeFileSync(join(root, "tmux"), '#!/bin/sh\ncase "$*" in *capture-pane*) cat "$UPDATE_FRAME" ;; *) echo tap ;; esac\n', { mode: 0o755 });
  let keys = 0;
  const observe = memoizedStartupObservation({ ...process.env, PATH: `${root}:${process.env.PATH}`, UPDATE_FRAME: join(root, "frame") }, undefined, true, 5000, {
    authorize: async () => false, escape: async () => { keys++; return true; }, record: () => {},
  });
  expect((await observe(makeFacts())).updateSkipFailure).toContain("ownership");
  expect(keys).toBe(0);
});

test.each(["before-key", "after-key"])("cancellation %s halts update recovery and records possible effects", async stage => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "skip-cancel-"));
  writeFileSync(join(root, "frame"), readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt")));
  writeFileSync(join(root, "tmux"), '#!/bin/sh\ncase "$*" in *capture-pane*) cat "$UPDATE_FRAME" ;; *) echo tap ;; esac\n', { mode: 0o755 });
  const controller = new AbortController(), events: string[] = [];
  let keys = 0;
  const observe = memoizedStartupObservation({ ...process.env, PATH: `${root}:${process.env.PATH}`, UPDATE_FRAME: join(root, "frame") }, controller.signal, true, 5000, {
    authorize: async () => { if (stage === "before-key") controller.abort(new Error("cancelled")); return true; },
    escape: async () => { keys++; controller.abort(new Error("cancelled")); return true; },
    record: event => { events.push(event.outcome); },
  });
  await expect(observe(makeFacts())).rejects.toThrow("cancelled");
  expect(keys).toBe(stage === "before-key" ? 0 : 1);
  expect(events).toEqual(stage === "before-key" ? [] : ["intent", "unverified"]);
});
test("only retained dead panes may omit their process id", () => {
  expect(parsePaneFacts("fixture/seat:0.0\t%1\t\t1:1\t1\t\t/fixture")).toMatchObject({ pane_id: "%1", dead: true, pane_pid: 0 });
  expect(parsePaneFacts("fixture/seat:0.0\t%1\tclaude\t1:1\t0\t\t/fixture")).toBeNull();
  expect(parsePaneFacts("fixture/seat:0.0\t%1\t\t1:1\t1\tbad\t/fixture")).toBeNull();
});
test("readiness needs consecutive observations of one live process in one frame", async()=>{
  for(const moved of [{...first,dead:true},{...first,pane_pid:3003},{...first,pane_id:"%2"},{...first,server_epoch:"srv:2:2"}]){
    let time=0, reads=0;
    const result=await awaitStableHarness(async()=>++reads===1?first:moved,facts=>!facts.dead,50,{now:()=>time,sleep:async ms=>{time+=ms;}});
    expect(result.facts).toBeNull(); expect(reads).toBe(2);
  }
  let time=0;
  expect((await awaitStableHarness(async()=>first,()=>true,50,{now:()=>time,sleep:async ms=>{time+=ms;}})).facts).toEqual(first);
});
test.each(["pane","server","pid","dead","harness","valid"])("retained replacement readiness checks the %s evidence through the real command boundary",async field=>{
  const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"ready-"));
  const facts={...first};
  if(field==="pane")facts.pane_id="%2";
  if(field==="server")facts.server_epoch="srv:2:2";
  if(field==="pid")facts.pane_pid=1001;
  if(field==="dead")facts.dead=true;
  if(field==="harness")facts.command="vim";
  const frame=[facts.pane,facts.pane_id,facts.command,facts.server_epoch.slice(4),facts.dead?1:0,facts.pane_pid,facts.path].join("\t");
  writeFileSync(join(root,"tmux"),`#!/bin/sh\nprintf '%s\\n' '${frame}'\n`,{mode:0o755});
  writeFileSync(join(root,"ps"),"#!/bin/sh\nexit 1\n",{mode:0o755});
  expect((await awaitReplacedHarness({pane_id:"%1",harness:"codex",timeout:1,expected_server_epoch:"srv:1:1",previous_pane_pid:1001,detect_resume_picker:false},
    {...process.env,PATH:`${root}:${process.env.PATH}`,TAP_SERVER_EPOCH:undefined})).ready).toBe(field==="valid");
});

test("a process that exits just after two observations never earns readiness", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => time < 200 ? first : null, facts => !facts.dead, 500,
    { observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; } });
  expect(result.facts).toBeNull();
  expect(time).toBe(200);
});

test.each([false, true])("startup identity is latched throughout observation (full window: %s)", async observeUntilDeadline => {
  for (const replacement of [{ ...first, pane_pid: 3003 }, { ...first, command: "node" }, null, { ...first, dead: true }]) {
    let time = 0;
    const result = await awaitStableHarness(async () => time < 100 ? first : time < 200 ? replacement : { ...first, pane_pid: 4004 },
      facts => !facts.dead, 500, { observeUntilDeadline, blocker: async () => null, blockerObservationMs: 200,
        now: () => time, sleep: async ms => { time += ms; } });
    expect(result.facts).toBeNull();
    expect(result.reason).toMatch(/identity changed|exited/);
  }
});

test("a blocked replacement capture has a bounded command budget", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "ready-hung-"));
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then exec sleep 60; fi
printf 'fixture/seat:0.0\t%%1\tcodex\t1:1\t0\t2002\t/fixture\n'
`, { mode: 0o755 });
  const controller = new AbortController();
  let settled = false;
  const waiting = awaitReplacedHarness({ pane_id: "%1", harness: "codex", timeout: .05, expected_server_epoch: "srv:1:1", previous_pane_pid: 1001, detect_resume_picker: true },
    { ...process.env, PATH: `${root}:${process.env.PATH}`, TAP_SERVER_EPOCH: undefined }, controller.signal)
    .then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  try {
    await Bun.sleep(5800);
    expect(settled).toBe(true);
    expect((await waiting).ready).toBe(false);
  } finally { controller.abort(); await waiting.catch(() => {}); }
}, 8000);

test("Codex picker observation catches a late blocker but stable readiness returns before the ceiling", async () => {
  let time = 0;
  const delayed = await awaitStableHarness(async () => first, () => true, 45000, {
    now: () => time, sleep: async ms => { time += ms; },
    blocker: async () => time >= 5000 ? "late picker" : null,
  });
  expect(delayed).toEqual({ facts: null, reason: "late picker" });
  time = 0;
  expect((await awaitStableHarness(async () => first, () => true, 45000, {
    now: () => time, sleep: async ms => { time += ms; }, blocker: async () => null,
  })).facts).toEqual(first);
  expect(time).toBe(5050); // Two confirmations, then the default five-second window.
});

test("an explicit full observation window wins over the short blocker window", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => first, () => true, 500, {
    observeUntilDeadline: true, blockerObservationMs: 100,
    now: () => time, sleep: async ms => { time += ms; }, blocker: async () => time >= 450 ? "late dialog" : null,
  });
  expect(result).toEqual({ facts: null, reason: "late dialog" });
  expect(time).toBe(450);
});

test("the blocker window starts after stable confirmations and stays inside the readiness ceiling", async () => {
  for (const ceiling of [1000, 350]) {
    let time = 0;
    const result = await awaitStableHarness(async () => time < 200 ? null : first, () => true, ceiling, {
      blockerObservationMs: 200, blocker: async () => null, now: () => time, sleep: async ms => { time += ms; },
    });
    expect(result.facts).toEqual(first);
    expect(time).toBe(Math.min(ceiling, 450));
  }
});

test("a healthy final observation may finish beyond the polling deadline", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "ready-final-"));
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
sleep .08
if [ "$1" = capture-pane ]; then exit 0; fi
printf 'fixture/seat:0.0\t%%1\tcodex\t1:1\t0\t2002\t/fixture\n'
`, { mode: 0o755 });
  expect((await awaitReplacedHarness({ pane_id: "%1", harness: "codex", timeout: 1, expected_server_epoch: "srv:1:1", previous_pane_pid: 1001, detect_resume_picker: true },
    { ...process.env, PATH: `${root}:${process.env.PATH}`, TAP_SERVER_EPOCH: undefined })).ready).toBe(true);
});

for (const outcome of ["same", "changed", "missing", "blocker"]) test(`late first sample gets one bounded confirmation: ${outcome}`, async () => {
  let time = 0, reads = 0;
  const result = await awaitStableHarness(async () => {
    time += 100; reads++;
    return reads === 1 || outcome === "same" || outcome === "blocker" ? first
      : outcome === "missing" ? null : { ...first, pane_pid: 999 };
  }, () => true, 50, { now: () => time, sleep: async () => {},
    blocker: async () => outcome === "blocker" && reads === 2 ? "late blocker" : null });
  expect(reads).toBe(2);
  expect(result.facts).toEqual(outcome === "same" ? first : null);
  if (outcome === "blocker") expect(result.reason).toBe("late blocker");
});

test("a positive readiness signal ends the full window after the settle", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => first, () => true, 5000, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: async () => time >= 1000,
  });
  expect(result.facts).toEqual(first);
  expect(time).toBe(1600);
});

test("a harness that exits inside the settle after a positive signal never earns readiness", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => time < 1400 ? first : null, () => true, 5000, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: async () => time >= 1000,
  });
  expect(result.facts).toBeNull();
  expect(result.reason).toBe("harness exited or became unobservable during readiness");
  expect(time).toBe(1400);
});

test("an identity change inside the settle after a positive signal never earns readiness", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => time < 1400 ? first : { ...first, pane_pid: 3003 }, () => true, 5000, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: async () => time >= 1000,
  });
  expect(result.facts).toBeNull();
  expect(result.reason).toBe("harness process identity changed during readiness");
  expect(time).toBe(1400);
});

test("a late positive signal near the ceiling settles no later than the deadline", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => first, () => true, 5000, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: async () => time >= 4900,
  });
  expect(result.facts).toEqual(first);
  expect(time).toBe(5000);
});

test("without a signal the full observation window stands", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => first, () => true, 5000, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: async () => false,
  });
  expect(result.facts).toEqual(first);
  expect(time).toBe(5000);
});

test("the codex readiness signal is the roster's idle judgment, not a loose composer glyph", () => {
  // Selection menus reuse › as their cursor; a dialog is never ready.
  expect(codexComposerIdle("› 1. Yes, allow hooks this session\n› 2. Yes, allow always\n  3. No\n")).toBe(false);
  expect(codexComposerIdle("Hooks need review\n› 1. Yes, allow hooks this session\n")).toBe(false);
  expect(codexComposerIdle(null)).toBe(false);
  // The idle composer: the dim placeholder the classifier corroborates.
  expect(codexComposerIdle("\x1b[2m› Ask Codex to do anything\x1b[0m\n", "")).toBe(true);

  // beside a painted composer (C2: the title is a classifier input).
  expect(codexComposerIdle("\x1b[2m› Ask Codex to do anything\x1b[0m\n", "⠋ working…")).toBe(false);
  // C4: a title the observation could not take must suppress the signal —
  // a spinner-titled Codex must never pass as idle on an unverified title.
  expect(codexComposerIdle("\x1b[2m› Ask Codex to do anything\x1b[0m\n", null)).toBe(false);
});

test("the opencode readiness signal is the roster's gate order over a plain screen", () => {
  const state = (name: string) => readFileSync(join(import.meta.dir, "fixtures/agent-state/opencode", `${name}.txt`), "utf8");
  // Real captures: the idle composer signals; working, blocked and booting never do.
  expect(opencodeComposerIdle(state("idle-real"))).toBe(true);
  expect(opencodeComposerIdle(state("working"))).toBe(false);
  expect(opencodeComposerIdle(state("blocked-real"))).toBe(false);
  expect(opencodeComposerIdle(readFileSync(join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/opencode-splash/constructed-splash.txt"), "utf8"))).toBe(false);
  expect(opencodeComposerIdle(null)).toBe(false);
  // The live band paints SGR: the predicate strips, so the bytes do not blind it.
  expect(opencodeComposerIdle("\x1b[90m  ┃  Ask anything… \"Fix broken tests\"\x1b[0m\n\x1b[90m  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[0m\n                                               tab agents  ctrl+p commands\n")).toBe(true);
  // The roster's readiness is the box itself, not the narrower classifier
  // judgment: an idle box without the `ctrl+p commands` footer still signals.
  expect(opencodeComposerIdle("  ┃  Ask anything… \"Fix broken tests\"\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n")).toBe(true);
  // Gate order, roster-first: a permission approval in the alert tail never signals.
  expect(opencodeComposerIdle("  ┃  Ask anything…\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\napproval required before the next command\n")).toBe(false);
  // An `esc interrupt` marker below the box is a working composer.
  expect(opencodeComposerIdle("  ┃  Ask anything…\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  esc interrupt to stop\n")).toBe(false);
  // No box at all — bare chrome or a blank pane — is never ready.
  expect(opencodeComposerIdle("OpenCode v1.0\n")).toBe(false);
  expect(opencodeComposerIdle("")).toBe(false);
});

test("a failing or hung opencode capture is no signal, never a rollback", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "opencode-signal-"));
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then exit 3; fi
exit 1
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  expect(await opencodeReadySignal(first, env)).toBe(false);
  // A capture that hangs past its short budget times out to no signal (code 124).
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then exec sleep 60; fi
exit 1
`, { mode: 0o755 });
  expect(await opencodeReadySignal(first, env, undefined, 100)).toBe(false);
  // A launch whose signal never fires keeps the full window: no thrown
  // rollback, the loop observes to the deadline and succeeds.
  let time = 0;
  const result = await awaitStableHarness(async () => first, () => true, 500, {
    observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; },
    ready: () => opencodeReadySignal(first, env, undefined, 50),
  });
  expect(result.facts).toEqual(first);
  expect(result.reason).toBeNull();
  expect(time).toBe(500);
}, 8000);

test("a title read that times out ends the observation with the pane timeout", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "title-hung-"));
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then printf 'screen bytes\\n'; exit 0; fi
if [ "$1" = display-message ]; then exec sleep 60; fi
`, { mode: 0o755 });
  const observed = memoizedStartupObservation({ ...process.env, PATH: `${root}:${process.env.PATH}`, TAP_SERVER_EPOCH: undefined },
    undefined, true, 100);
  await expect(observed(first)).rejects.toBeInstanceOf(PaneObservationTimeout);
}, 8000);

test("a slow blocker capture cannot satisfy the settle with stale facts", async () => {
  // C1: after the ready signal arms the settle, the blocker's capture can
  // consume seconds past it. Facts sampled BEFORE the settle must not be
  // returned as running; the loop re-reads, misses, and fails readiness.
  const clock = { now: 1000 };
  let reads = 0;
  const facts = makeFacts();
  const result = await awaitStableHarness(async () => (++reads <= 2 ? facts : null), () => true, 5000, {
    now: () => clock.now,
    sleep: async () => { clock.now += 50; },
    confirmations: 2,
    ready: async () => true,
    readySettleMs: 600,
    blocker: async () => { if (reads >= 2) clock.now += 5000; return null; },
  });
  expect(result.facts).toBeNull();
});

test("the claude bind fingerprint moves on the pane command the SessionStart bind rewrites", async () => {
  // C3: an exact resume can carry the expected session id, capture result and
  // transcript into the placeholder row, and registered_at is whole-second —
  // but the placeholder pane ran the launch shell and the bind records the
  // harness command, so the fingerprint has a byte that must move.
  const dir = mkdtempSync(join(process.env.TMPDIR!, "bindfp-"));
  try {
    const registry = join(dir, "registry.json");
    const row = { registered_at: "2026-09-28T14:00:00Z", harness_session_id: "expected-sid",
      identity_capture_result: '{"trust":"process"}', transcript_path: "/t/transcript.jsonl",
      pane_current_command: "bash", launch_id: "token-1" };
    writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { reviewer: row } }));
    const evidence = { selection: { registryLocation: registry }, handle: "reviewer", token: "token-1", record: { harness: "claude" } };
    const snapshot = bindFingerprintOf(row);
    // Before the bind's write lands (same second, same ids, command still the
    // placeholder's), a resumed row must NOT signal. Fresh closures: the
    // signal rate-limits successive polls on one closure.
    const unMoved = await sessionBindSignal(evidence as never, snapshot)(makeFacts());
    expect(unMoved).toBe(false);
    // The bind rewrites pane_current_command from its own observation.
    row.pane_current_command = "node";
    writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { reviewer: row } }));
    const moved = await sessionBindSignal(evidence as never, snapshot)(makeFacts());
    expect(moved).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the claude baseline is the placeholder row's own fingerprint; a row that moved past it still signals", async () => {
  // C5: the baseline is read right after the placeholder bind, before the
  // respawn — a hook that lands during the respawn moves the row PAST that
  // baseline, so the signal fires; a baseline taken after the respawn could
  // already include the bind and then never signal.
  const dir = mkdtempSync(join(process.env.TMPDIR!, "baseline-"));
  try {
    const registry = join(dir, "registry.json");
    const row = { registered_at: "2026-09-28T14:00:00Z", harness_session_id: "", identity_capture_result: "",
      transcript_path: "", pane_current_command: "bash", launch_id: "token-1" };
    writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { reviewer: row } }));
    const evidence = { selection: { registryLocation: registry }, handle: "reviewer", token: "token-1", record: { harness: "claude" } };
    const baseline = bindBaselineAfterPlaceholderBind(evidence as never);
    expect(baseline).toBe(bindFingerprintOf(row));
    // The row moves after the baseline was taken (the respawn raced a fast
    // hook): the bind landing still reads as a change from the baseline.
    row.pane_current_command = "node"; row.harness_session_id = "sid-after-respawn";
    writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { reviewer: row } }));
    expect(await sessionBindSignal(evidence as never, baseline!)(makeFacts())).toBe(true);
    // A row the baseline could not read (missing seat, unreadable registry)
    // yields null — no signal, full window.
    writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: {} }));
    expect(bindBaselineAfterPlaceholderBind(evidence as never)).toBeNull();
    rmSync(registry);
    expect(bindBaselineAfterPlaceholderBind(evidence as never)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private OpenCode bind readiness requires this launch's exact prepared session and a moved fingerprint", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR!, "oc-bind-ready-"));
  try {
    const registry = join(dir, "registry.json");
    const row = { launch_id: "token", harness_session_id: "ses_expected", pane_current_command: "bash" };
    const save = () => writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { seat: row } }));
    const evidence = { selection: { registryLocation: registry }, handle: "seat", token: "token",
      record: { harness: "opencode", harness_session_id: "ses_expected" } };
    const snapshot = bindFingerprintOf(row);
    save();
    expect(await sessionBindSignal(evidence as never, snapshot)(makeFacts())).toBe(false);
    row.pane_current_command = "opencode";
    row.harness_session_id = "ses_other"; save();
    expect(await sessionBindSignal(evidence as never, snapshot)(makeFacts())).toBe(false);
    row.harness_session_id = "ses_expected"; row.launch_id = "other-token"; save();
    expect(await sessionBindSignal(evidence as never, snapshot)(makeFacts())).toBe(false);
    row.launch_id = "token"; save();
    expect(await sessionBindSignal(evidence as never, snapshot)(makeFacts())).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("paneTailLines returns the last non-empty lines, blank panes, and null on capture failure", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "tail-"));
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then printf '%s' '\x1b[33mboot v1\x1b[0m
[oh-my-zsh] Would you like to update? [Y/n]\x20
'; exit 0; fi
exit 1
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  expect(await paneTailLines(first, env)).toEqual(["boot v1", "[oh-my-zsh] Would you like to update? [Y/n]"]);
  expect(await paneTailLines(first, env, undefined, 1)).toEqual(["[oh-my-zsh] Would you like to update? [Y/n]"]);
  writeFileSync(join(root, "tmux"), `#!/bin/sh
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
if [ "$1" = capture-pane ]; then exit 0; fi
exit 1
`, { mode: 0o755 });
  expect(await paneTailLines(first, env)).toEqual([]);
  writeFileSync(join(root, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await paneTailLines(first, env)).toBeNull();
});

// A login shell the machine is slow to run: facts name the shell until it execs
// the harness. The window and ceiling mirror runCreated's defaults.
const shellPane: PaneFacts = { ...first, command: "zsh", pane_pid: 1001 };
const isHarness = (facts: PaneFacts) => !facts.dead && facts.command === "codex";
// The pane root (pid 1001) as ps sees it; by default the login shell, running an rc child in the foreground.
const psRoot = (comm: string, command = comm) => () => ({ ok: true, table: new Map<string, PsRow>([
  ["1001", ["1001", "1100", comm, command]], ["1100", ["1100", "1100", "/usr/bin/python3", "python3 -c pass"]]]) });
function startWait(read: (time: number) => PaneFacts | null, tail: (time: number) => string[] | null, ready?: (time: number) => boolean,
  root = psRoot("/bin/zsh", "-zsh")) {
  let time = 0, samples = 0;
  const watch = startStallWatch("codex", async () => { samples++; return tail(time); },
    async facts => foreignPaneProgram(facts, "codex", "/bin/zsh", {}, root));
  return awaitStableHarness(async () => read(time), isHarness, 5000, {
    observeUntilDeadline: true, startCeilingMs: 60_000, awaitingStart: watch,
    ready: ready && (async () => ready(time)), now: () => time, sleep: async ms => { time += ms; },
  }).then(result => ({ ...result, time, samples }));
}
const startsAt = (at: number) => (time: number) => time < at ? shellPane : first;

test("a blank login shell that starts its harness after five seconds still launches", async () => {
  const result = await startWait(startsAt(8000), () => []);
  expect(result).toMatchObject({ facts: first, reason: null });
  expect(result.samples).toBe(7); // Once a second until the harness appears, not at the 50 ms poll rate.
});

test("the survival window counts from the first match, not from entry", async () => {
  expect((await startWait(startsAt(8000), () => [])).time).toBe(13_000);
  expect((await startWait(startsAt(3000), () => [])).time).toBe(8000);
  expect((await startWait(() => first, () => [])).time).toBe(5000);
});

test("a late start keeps its full window past the ceiling", async () => {
  const result = await startWait(startsAt(59_950), () => []);
  expect(result.facts).toEqual(first);
  expect(result.time).toBe(64_950);
});

test("a ready signal after a late start ends the window at the settle", async () => {
  const result = await startWait(startsAt(8000), () => [], () => true);
  expect(result.facts).toEqual(first);
  expect(result.time).toBe(8650); // Confirmed at 8050, then READY_SETTLE_MS.
});

test.each([["exits", null], ["dies", { ...first, dead: true }]] as const)("a harness that %s inside the window after a late start fails", async (_how, after) => {
  const result = await startWait(time => time < 8000 ? shellPane : time < 10_000 ? first : after, () => []);
  expect(result).toMatchObject({ facts: null, reason: "harness exited or became unobservable during readiness" });
  expect(result.time).toBe(10_000);
});

test("a non-blank tail that stops changing fails at once past the first five seconds", async () => {
  const result = await startWait(() => shellPane, () => ["Update oh-my-zsh? [Y/n]"]);
  expect(result).toMatchObject({ facts: null, reason: START_STALLED });
  expect(result.time).toBe(6000); // First sampled at one second, unchanged for five.
});

test("a prompt that appears late is blocked five seconds after it appears", async () => {
  const result = await startWait(() => shellPane, time => time < 20_000 ? [] : ["Update oh-my-zsh? [Y/n]"]);
  expect(result).toMatchObject({ facts: null, reason: START_STALLED });
  expect(result.time).toBe(25_000);
});

test("a tail that keeps changing keeps waiting, then ends at the ceiling", async () => {
  const moving = (time: number) => [`step ${Math.floor(time / 2000)}`];
  const started = await startWait(startsAt(30_000), moving);
  expect(started.facts).toEqual(first);
  const stuck = await startWait(() => shellPane, moving);
  expect(stuck).toMatchObject({ facts: null, reason: null });
  expect(stuck.time).toBe(60_000);
});

test("a failed capture is no evidence: it waits to the ceiling and never resets a stall", async () => {
  const unseen = await startWait(() => shellPane, () => null);
  expect(unseen).toMatchObject({ facts: null, reason: null });
  expect(unseen.time).toBe(60_000);
  const flaky = await startWait(() => shellPane, time => time % 2000 ? ["Continue? [y/N]"] : null);
  expect(flaky).toMatchObject({ facts: null, reason: START_STALLED });
  expect(flaky.time).toBe(7000); // The 6000 sample failed; the next good one still counts from 1000.
});

test("a blank pane runs to the ceiling and reads as slow, never as a prompt", async () => {
  const result = await startWait(() => shellPane, () => []);
  expect(result).toMatchObject({ facts: null, reason: null });
  expect(result.time).toBe(60_000);
  const text = startFailureText("claude", { command: "zsh", loginShell: "/bin/zsh", shell: true, tail: [] }, false,
    { elapsedMs: result.time, ceilingMs: 60_000 }, "load 126.31 on 16 cores");
  expect(text).toEqual({
    cause: "the login shell (zsh) produced no output and had not started claude after 60000 ms (ceiling 60 s; load 126.31 on 16 cores)",
    hint: "next: raise TAP_LAUNCH_START_TIMEOUT_SECONDS and retry the launch",
  });
});

test("a stalled tail keeps the prompt diagnosis, with the measured time", () => {
  expect(startFailureText("claude", { command: "zsh", loginShell: "/bin/zsh", shell: true, tail: ["Continue? [y/N]"] }, true,
    { elapsedMs: 6123, ceilingMs: 60_000 }, "load 1.00 on 8 cores")).toEqual({
    cause: "the login shell (zsh) had not started claude after 6123 ms; it may be waiting for input",
    hint: "next: answer the login-shell prompt in a terminal with /bin/zsh -lic exit, then retry the launch",
  });
});

test.each([["moving", ["step 9"]], ["unobserved", null]] as const)("a %s pane at the ceiling offers both recoveries without asserting a prompt", (_kind, tail) => {
  const text = startFailureText("claude", { command: "zsh", loginShell: "/bin/zsh", shell: true, tail: tail as string[] | null }, false,
    { elapsedMs: 60_040, ceilingMs: 60_000 }, "load 1.00 on 8 cores");
  expect(text.cause).toBe("the login shell (zsh) had not started claude after 60040 ms (ceiling 60 s; load 1.00 on 8 cores)");
  expect(text.hint).toBe("next: if the pane shows a prompt, answer it in a terminal with /bin/zsh -lic exit; otherwise raise TAP_LAUNCH_START_TIMEOUT_SECONDS and retry the launch");
});

test("a non-shell command keeps its name, with a ceiling recovery only when it timed out", () => {
  const pane = { command: "vim", loginShell: "/bin/zsh", shell: false, tail: [] };
  const measure = { elapsedMs: 60_040, ceilingMs: 60_000 };
  expect(startFailureText("claude", pane, true, measure, "load 1.00 on 8 cores")).toEqual({ cause: "the pane is running vim, not claude", hint: "" });
  expect(startFailureText("claude", pane, false, measure, "load 1.00 on 8 cores")).toEqual({
    cause: "the pane is running vim, not claude, after 60040 ms (ceiling 60 s; load 1.00 on 8 cores)",
    hint: "next: raise TAP_LAUNCH_START_TIMEOUT_SECONDS and retry the launch",
  });
});

test("a silent dead pane ends the wait at five seconds, not at the ceiling", async () => {
  const result = await startWait(() => ({ ...shellPane, dead: true }), () => []);
  expect(result).toMatchObject({ facts: null, reason: "codex exited during startup" });
  expect(result.time).toBe(5000);
});

test("a match lost before confirmation returns to the start ceiling", async () => {
  const blip = await startWait(time => time === 1000 ? first : shellPane, () => []);
  expect(blip).toMatchObject({ facts: null, reason: null });
  expect(blip.time).toBe(60_000);
  let reads = 0;
  const flapping = await startWait(() => ++reads % 2 ? first : shellPane, () => []);
  expect(flapping).toMatchObject({ facts: null, reason: null });
  expect(flapping.time).toBeLessThanOrEqual(60_050);
});

test("without a start ceiling one deadline still bounds appearance and survival", async () => {
  let time = 0;
  const result = await awaitStableHarness(async () => time < 4000 ? shellPane : first, isHarness, 5000,
    { observeUntilDeadline: true, now: () => time, sleep: async ms => { time += ms; } });
  expect(result.facts).toEqual(first);
  expect(time).toBe(5000);
});

test("a wrong program with a changing screen fails at the five-second mark, not the ceiling", async () => {
  const moving = (time: number) => [`frame ${time}`];
  const exec = await startWait(() => ({ ...shellPane, command: "vim" }), moving, undefined, psRoot("/usr/bin/vim", "vim notes.txt"));
  expect(exec).toMatchObject({ facts: null, reason: "the pane is running vim, not codex" });
  expect(exec.time).toBe(5000);
  // A wrapper that runs another harness as a child leaves the shell as root; the foreground names it.
  const child = await startWait(() => ({ ...shellPane, command: "claude" }), moving);
  expect(child).toMatchObject({ facts: null, reason: "the pane is running claude, not codex" });
  expect(child.time).toBe(5000);
});

test("a denylisted root whose argv names the harness fails at five seconds, as on main", async () => {
  const result = await startWait(() => ({ ...shellPane, command: "cat" }), () => [], undefined, psRoot("/bin/cat", "/bin/cat /tmp/codex"));
  expect(result).toMatchObject({ facts: null, reason: "the pane is running cat, not codex" });
  expect(result.time).toBe(5000);
});

test("a denylisted executable renamed by exec -a fails at five seconds; a truncated Homebrew zsh still waits", async () => {
  const renamed = await startWait(() => ({ ...shellPane, command: "cat" }), () => [], undefined, psRoot("/bin/cat", "codex"));
  expect(renamed).toMatchObject({ facts: null, reason: "the pane is running cat, not codex" });
  expect(renamed.time).toBe(5000);
  const homebrew = await startWait(time => time < 8000 ? shellPane : first, () => [], undefined,
    psRoot("/opt/homebrew/bi", "/opt/homebrew/bin/zsh -lic exec \"$0\" \"$@\" /usr/bin/env codex"));
  expect(homebrew).toMatchObject({ facts: first, reason: null });
  expect(homebrew.time).toBe(13_000);
});

test("env and the shell's rc commands on the exec chain keep the extended wait", async () => {
  const viaEnv = await startWait(time => time < 8000 ? { ...shellPane, command: "env" } : first, () => [], undefined,
    psRoot("/usr/bin/env", "/usr/bin/env -u TAP_STATELESS FOO=1 codex"));
  expect(viaEnv).toMatchObject({ facts: first, reason: null });
  expect(viaEnv.time).toBe(13_000);
  // Measured: a slow zsh rc shows its own children (sleep, python3) as the pane command.
  const rcChild = await startWait(time => time < 8000 ? { ...shellPane, command: "python3" } : first, () => []);
  expect(rcChild).toMatchObject({ facts: first, reason: null });
  expect(rcChild.time).toBe(13_000);
});

test("a pane root is foreign only when ps positively shows a program past the chain that is not the harness", () => {
  const facts = { ...shellPane, command: "zsh" };
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/opt/homebrew/bin/claude", "claude"))).toBe("claude");
  // The root may exec the harness between the tmux read and this one; a version-named Claude is found through argv.
  expect(foreignPaneProgram(facts, "claude", "/bin/zsh", {}, psRoot("/opt/x/.local/share/claude/versions/2.1.30", "claude --session-id x"))).toBeNull();
  // macOS ps cuts comm to 16 bytes when it is not the last column; argv[0] names the root.
  expect(foreignPaneProgram(facts, "codex", "/opt/homebrew/bin/zsh", {}, psRoot("/opt/homebrew/bi", "/opt/homebrew/bin/zsh -lic exec \"$0\" \"$@\" /usr/bin/env codex"))).toBeNull();
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/private/tmp/tap", "/private/tmp/tap-launch-test-x/real/notharness 600"))).toBe("notharness");
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/usr/bin/login", "-zsh"))).toBeNull();
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/usr/bin/vim", ""))).toBe("vim");
  // argv[0] is the exec's choice; a denylisted executable outranks it.
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/bin/cat", "codex"))).toBe("cat");
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/usr/bin/ssh", "zsh"))).toBe("ssh");
  // A denylisted root decides before argv, as paneHarness does: cat reading a file named codex is not codex.
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, psRoot("/bin/cat", "/bin/cat /tmp/codex"))).toBe("cat");
  expect(foreignPaneProgram(facts, "codex", "/bin/zsh", {}, () => ({ ok: false, table: null }))).toBeNull();
  expect(foreignPaneProgram({ ...facts, pane_pid: 4242 }, "codex", "/bin/zsh", {}, psRoot("/usr/bin/vim"))).toBeNull();
  for (const name of ["zsh", "-zsh", "bash", "sh", "env"]) expect(launchChainCommand(name, "/bin/zsh")).toBe(true);
  for (const name of ["codex", "python3", "sleep", "vim"]) expect(launchChainCommand(name, "/bin/zsh")).toBe(false);
});

test("the start ceiling defaults to a minute and refuses what is not a positive duration", () => {
  expect(launchStartCeilingMs({})).toBe(60_000);
  expect(launchStartCeilingMs({ TAP_LAUNCH_START_TIMEOUT_SECONDS: "90" })).toBe(90_000);
  expect(launchStartCeilingMs({ TAP_LAUNCH_START_TIMEOUT_SECONDS: "0.5" })).toBe(500);
  for (const raw of ["", "0", "-1", "soon", "inf", "nan", "1e400"]) {
    expect(() => launchStartCeilingMs({ TAP_LAUNCH_START_TIMEOUT_SECONDS: raw })).toThrow(`TAP_LAUNCH_START_TIMEOUT_SECONDS must be positive, got '${raw}'`);
  }
});
