import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitStableHarness, awaitReplacedHarness, codexComposerIdle, opencodeComposerIdle, opencodeReadySignal, memoizedStartupObservation, paneTailLines, PaneObservationTimeout, parsePaneFacts, type PaneFacts } from "../src/launcher/readiness";
import { bindFingerprintOf, bindBaselineAfterPlaceholderBind, sessionBindSignal } from "../src/launcher/transaction";

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
