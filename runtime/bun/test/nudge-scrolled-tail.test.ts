import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { compiledRouter, compiledRouterCleanup, compiledRouterSrc } from "./compiled-router";
import { recordTypedWire, typedWires } from "../src/typed-wire";

// tap-1ncs6: `tap nudge` against a Claude seat whose 38-column composer shows
// only the scrolled tail of a delivered wire. The public verb, the recorded
// recovery effects and the proof all run; the fake tmux serves the synthetic
// specimen frame (a scrubbed reconstruction of the capture) and an empty
// Claude box once Enter lands.
const ID = "sample-review-coach-seat-20260101T010101Z-0123456789ab";
const FIX = join(import.meta.dir, "fixtures/claude-narrow-pane");
const FRAME = readFileSync(join(FIX, "specimen-a-alice-38x21.ansi"), "utf8");
const WIRE = JSON.parse(readFileSync(join(FIX, "specimen-a-alice-38x21.json"), "utf8")).expected as string;
const OPENCODE = join(import.meta.dir, "fixtures/opencode-capture");
const OVERPRINT = readFileSync(join(OPENCODE, "overprint-live-124.ansi"), "utf8");
const WELCOME = readFileSync(join(OPENCODE, "welcome-124.ansi"), "utf8");
const EMPTY = "✻ Worked for 20s · done 6:38 PM\n\n───────────────────── tap/alice-seat ─\n❯ \n──────────────────────────────────────\n  Sonnet 5 low | 12%↯ 90k/200k ●42…\n";

// The same 38-column screen with other text in the composer instead of the tail.
function composerFrame(text: string): string {
  const lines = FRAME.split("\n");
  const prompt = lines.findIndex(line => line.startsWith("❯"));
  const border = lines.findIndex((line, i) => i > prompt && line.startsWith("──"));
  if (prompt < 0 || border < 0) throw new Error("fixture has no composer");
  return [...lines.slice(0, prompt), `❯ ${text}`, ...lines.slice(border)].join("\n");
}

// A human draft that ends like a wire: a shell test.
const LOOKALIKE = 'why does this fail: if [[ -z "$FOO" ]]';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// `typed`: the server generation the pane's typed-wire record says the courier typed WIRE in
  // (the proof a scrolled tail needs), or false for no record. The seat's own generation is srv:900:100.
function fixture(composer: "tail" | "draft" | "lookalike" | "cut-opener" | "empty" | "overprint" = "tail", harness = "claude",
  typed: false | { epoch: string; bus?: string } = composer === "tail" ? { epoch: "srv:900:100" } : false) {
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-tail-"));
  roots.push(root);
  for (const p of ["bin", "bus/payloads", "bus/receipts", "config/tap", "index", "state"]) mkdirSync(join(root, p), { recursive: true });
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: {
    peer: { session: "testteam/peer", pane: "testteam/peer:0.0", pane_id: "%301", harness, server_epoch: "srv:900:100", boot_id: "boot:1", status: "active" },
  } }));
  writeFileSync(join(root, "state/frame"), composer === "overprint" ? OVERPRINT : composer === "empty" ? EMPTY : composer === "tail" ? FRAME : composerFrame(composer === "draft" ? "see the wiki page [[Release notes]]" : composer === "lookalike" ? LOOKALIKE : "[[TAP v0.23 note truncated"));
  writeFileSync(join(root, "state/harness"), harness);
  writeFileSync(join(root, "state/effects"), "");
  writeFileSync(join(root, "bin/tmux"), `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
const args=process.argv.slice(2); while (["-L", "-S"].includes(args[0])) args.splice(0,2); const cmd=args[0], root=process.env.FAKE_ROOT;
const harness=readFileSync(root+"/state/harness", "utf8").trim();
if (cmd === "display-message" && args.at(-1).includes("window_width")) {
 const w=existsSync(root+"/state/width") ? readFileSync(root+"/state/width", "utf8").trim() : "124";
 console.log("%301\\x1f@7\\x1f" + w + "\\x1f24"); process.exit(0);
}
if (cmd === "show-options" || cmd === "set-option") process.exit(0);
if (cmd === "resize-window") { writeFileSync(root+"/state/width", args[args.indexOf("-x")+1]); writeFileSync(root+"/state/frame", ${JSON.stringify(WELCOME)}); process.exit(0); }
if (cmd === "display-message") {
 const fmt=args.at(-1);
 const mode=existsSync(root+"/state/mode") ? readFileSync(root+"/state/mode", "utf8").trim() : "0";
 if (fmt === "#{pid}:#{start_time}") { console.log("900:100"); process.exit(0); }
 if (fmt === "#{pane_id}\\t#{pane_in_mode}\\t#{pane_mode}\\t#{session_attached}") {
  const clients=existsSync(root+"/state/clients") ? readFileSync(root+"/state/clients", "utf8").split("\\n").filter(Boolean).length : 0;
  console.log("%301\\t" + mode + "\\t" + (mode === "1" ? "copy-mode" : "") + "\\t" + clients); process.exit(0);
 }
 if (fmt === "#{pane_id}\\t#{session_name}\\t#{pane_pid}\\t#{pane_current_command}\\t#{pane_dead}") { console.log("%301\\ttestteam/peer\\t301\\t" + harness + "\\t0"); process.exit(0); }
 console.log(fmt.includes("pane_pid") ? "301" : fmt.includes("pane_id") ? "%301" : fmt.includes("pane_in_mode") ? mode : fmt.includes("pane_dead") ? "0" : fmt.includes("session_windows") ? "1" : fmt.includes("pane_current_command") ? harness : fmt.includes("pane_width") ? "38" : "");
} else if(cmd === "list-sessions") { console.log("testteam/peer\\t900:100"); }
else if(cmd === "list-panes" && args.at(-1) === "#{pane_id}") { console.log("%301"); }
else if(cmd === "list-panes" && args.at(-1) === "#{session_name}\\t#{pane_id}") { console.log("testteam/peer\\t%301"); }
else if(cmd === "list-clients") { if (existsSync(root+"/state/clients")) process.stdout.write(readFileSync(root+"/state/clients", "utf8")); }
else if(cmd === "list-panes") console.log("testteam/peer\\ttestteam/peer:0.0\\t%301\\t" + harness + "\\t301\\t900:100\\t0");
else if(cmd === "capture-pane") { process.stdout.write(readFileSync(root+"/state/frame")); }
else { appendFileSync(root+"/state/effects", args.join(" ")+"\\n"); if(args.includes("cancel")) writeFileSync(root+"/state/mode", "0"); if(args.includes("Enter")) { writeFileSync(root+"/state/frame", ${JSON.stringify(EMPTY)}); if(existsSync(root+"/state/exit-on-enter")) writeFileSync(root+"/state/harness", "zsh"); } }
`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_HOME: join(root, "bus"),
    TAP_INDEX_HOME: join(root, "index"), TAP_SERVER_EPOCH: "srv:900:100", TAP_BOOT_ID: "boot:1",
    PATH: join(root, "bin") + ":" + process.env.PATH, FAKE_ROOT: root, TAP_TUI_SETTLE_SCALE: "0.01" };
  if (typed) recordTypedWire("%301", { epoch: typed.epoch, bus: typed.bus ?? join(root, "bus") }, ID, WIRE, env);
  return { root, run: (router?: string, ...extra: string[]) => spawnSync(router ?? "bash", [...(router ? [] : [resolve(import.meta.dir, "../../../bin/tap")]), "nudge", "peer", ...extra], { cwd: root, env, encoding: "utf8", timeout: 25000 }),
    effects: () => readFileSync(join(root, "state/effects"), "utf8"),
    // What the seat's own courier could still prove in this pane.
    typed: () => typedWires("%301", { epoch: "srv:900:100", bus: join(root, "bus") }, env) };
}

test("nudge recognizes the scrolled tail of a wire the courier typed, presses Enter once through the recorded run, and never injects", () => {
  const f = fixture();
  expect(WIRE.startsWith("[[TAP")).toBe(true);
  expect(FRAME.includes("[[TAP")).toBe(false);
  expect(f.typed()).toMatchObject([{ id: ID, wire: WIRE }]);
  const result = f.run();
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  // The submitted wire is no longer evidence: its tail showing up later is someone's draft.
  expect(f.typed()).toEqual([]);
  expect(result.stderr).toContain("scrolled tail of a TAP wire");
  expect(result.stdout).toContain("re-submitted");
  const effects = f.effects();
  expect(effects.match(/Enter/g)).toHaveLength(1);
  expect(effects).not.toContain(" -l ");
  expect(readFileSync(join(f.root, "state/frame"), "utf8")).toBe(EMPTY);
  const debug = join(f.root, "index/debug/recovery");
  const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
  expect(existsSync(join(debug, recovery, "events.jsonl"))).toBe(true);
  expect(readFileSync(join(debug, recovery, "events.jsonl"), "utf8")).toContain("nudge Enter");
}, 20000);

test("an anchored opener that never closes is shaped but not a tail: refused, nothing pressed", () => {
  const f = fixture("cut-opener");
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("no single complete TAP sentinel");
  expect(f.effects()).toBe("");
  expect(readFileSync(join(f.root, "state/frame"), "utf8")).toContain("note truncated");
}, 20000);

for (const [label, make, kept] of [
  ["a draft that only ends like a wire", () => fixture("lookalike"), "$FOO"],
  ["a wire tail with no record that the courier typed it", () => fixture("tail", "claude", false), "landed the whole wire"],
  ["a wire tail recorded in a previous server generation", () => fixture("tail", "claude", { epoch: "srv:800:100" }), "landed the whole wire"],
  ["a wire tail recorded by another bus's courier", () => fixture("tail", "claude", { epoch: "srv:900:100", bus: join(tmpdir(), "tap-foreign-bus-never-created") }), "landed the whole wire"],
] as const) {
  test(`${label} is a human draft to nudge: nothing is pressed, typed or cleared`, () => {
    const f = make();
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the composer holds a draft");
    expect(result.stderr).not.toContain("scrolled tail of a TAP wire");
    expect(f.effects()).toBe("");
    expect(readFileSync(join(f.root, "state/frame"), "utf8")).toContain(kept);
  }, 20000);
}

test("a nudge that presses nothing leaves the typed-wire evidence in place", () => {
  // Same proven tail, but the seat's pane binding is gone: the nudge refuses before any key.
  const f = fixture();
  const registry = join(f.root, "bus/registry.json");
  const doc = JSON.parse(readFileSync(registry, "utf8"));
  doc.seats.peer.pane_id = "%999";
  writeFileSync(registry, JSON.stringify(doc));
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(f.effects()).not.toContain("Enter");
  expect(f.typed()).toMatchObject([{ id: ID, wire: WIRE }]);
}, 20000);

test("a human draft in the composer holds the nudge; nothing is pressed, typed or cleared", () => {
  const f = fixture("draft");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("the composer holds a draft");
  expect(f.effects()).toBe("");
  expect(readFileSync(join(f.root, "state/frame"), "utf8")).toContain("[[Release notes]]");
}, 20000);

// tap-w85su: a copy-mode park that escalated while the person was in copy mode is
// stranded once they leave it. A nudge with a clean composer hands it back to the
// ordinary deliverer, and presses nothing itself.
test("a clean composer requeues the seat's stranded copy-mode park and presses nothing", () => {
  withoutDeliverer(() => {
    const { f, bus, id } = copyModePark();
    const result = f.run();
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain(`tap nudge: peer: requeued copy-mode park ${id} (the pane has left copy mode); delivery is not confirmed yet: tap show ${id}`);
    expect(result.stdout).not.toContain("no-op");
    expect(JSON.parse(readFileSync(join(bus, "spool", `${id}.meta.json`), "utf8")).escalated_at).toBeUndefined();
    expect(f.effects()).toBe("");
  });
}, 20000);

function withoutDeliverer(body: () => void): void {
  const prior = process.env.TAP_SPOOL_DISABLE_DELIVERER;
  process.env.TAP_SPOOL_DISABLE_DELIVERER = "1";
  try { body(); }
  finally { if (prior === undefined) delete process.env.TAP_SPOOL_DISABLE_DELIVERER; else process.env.TAP_SPOOL_DISABLE_DELIVERER = prior; }
}

function copyModePark() {
  const f = fixture("empty");
  const bus = join(f.root, "bus"), registry = join(bus, "registry.json");
  const doc = JSON.parse(readFileSync(registry, "utf8"));
  doc.seats.peer.instance = "i-peer";
  writeFileSync(registry, JSON.stringify(doc));
  mkdirSync(join(bus, "spool"), { recursive: true });
  const id = "alice-20260101T000000Z-copymode0001";
  writeFileSync(join(bus, "spool", `${id}.md`), `---\nid: ${id}\nfrom: alice\nto: peer\nto_team: testteam\nrecipient_instance: i-peer\nkind: discuss\n---\nparked\n`);
  writeFileSync(join(bus, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "peer", reason: "copy-mode", reason_class: "safety_gate",
    first_spooled_epoch: 1, hold_until_epoch: 1, deadline_epoch: 301, waiter_lifetime: "window", pane: "testteam/peer:0.0", pane_id: "%301",
    to_team: "testteam", target_registry: registry, attempts: 0, attempt_fence: 1, escalated_at: "2026-10-01T09:00:00Z" }));
  return { f, bus, id };
}

// tap-zvuc9: the pane is genuinely still in copy mode and no tmux client views it,
// so nudge leaves copy mode once through a recorded recovery run, then requeues.
test("a copy mode nobody views is cancelled once, recorded apart from the park, then the park requeues", () => {
  withoutDeliverer(() => {
    const { f, bus, id } = copyModePark();
    writeFileSync(join(f.root, "state/mode"), "1");
    const result = f.run();
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toMatch(/tap nudge: peer: left copy mode on %301 \(no tmux client attached; recovery=recovery-[0-9a-f-]{36}\)/);
    expect(result.stdout).toContain(`requeued copy-mode park ${id} (the pane has left copy mode)`);
    expect(f.effects()).toBe("send-keys -t %301 -X cancel\n");
    // The cancel spends no payload license: the requeued park has no attempt evidence.
    for (const dir of ["spool", "receipts", "payloads"]) expect(existsSync(join(bus, dir, `${id}.attempted`))).toBe(false);
    const debug = join(f.root, "index/debug/recovery");
    const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
    const events = readFileSync(join(debug, recovery, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => [e.action, e.outcome])).toEqual([["copy-mode cancel", "verified"]]);
    expect(JSON.parse(readFileSync(join(debug, recovery, "run.json"), "utf8")).payloads).toEqual([{ home: realpathSync(bus), id }]);
  });
}, 20000);

test("a copy mode a tmux client is viewing is left alone and the park holds, naming the client", () => {
  withoutDeliverer(() => {
    const { f, bus, id } = copyModePark();
    writeFileSync(join(f.root, "state/mode"), "1");
    writeFileSync(join(f.root, "state/clients"), "testteam/peer\t/dev/ttys004\n");
    const result = f.run();
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain(`copy-mode park ${id} held: pane is still in copy mode (a tmux client (/dev/ttys004) is viewing it; leave copy mode there, then nudge again)`);
    expect(f.effects()).toBe("");
    expect(JSON.parse(readFileSync(join(bus, "spool", `${id}.meta.json`), "utf8")).escalated_at).toBe("2026-10-01T09:00:00Z");
    expect(existsSync(join(f.root, "index/debug/recovery"))).toBe(false);
  });
}, 20000);

// tap-555z9: under `bun build --compile` process.execPath is the TAP router itself, so a
// recovery child launched through it re-entered main.ts with a .ts path in verb position and
// the acting nudge died before recording its run. The compiled entry must reach both recovery
// children: nudge-start (the recorded run) and repaint-probe (the OpenCode heal).
afterAll(compiledRouterCleanup);

test("the compiled router reaches nudge-start and presses Enter once through the recorded run", () => {
  const f = fixture();
  const result = f.run(compiledRouter());
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stderr).toMatch(/tap nudge: recovery=recovery-/);
  expect(result.stdout).toContain("re-submitted");
  expect(f.effects().match(/Enter/g)).toHaveLength(1);
  const debug = join(f.root, "index/debug/recovery");
  const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
  expect(readFileSync(join(debug, recovery, "events.jsonl"), "utf8")).toContain("nudge Enter");
}, 120000);

test("the compiled router reaches repaint-probe and heals an OpenCode overprint without a keystroke", () => {
  const f = fixture("overprint", "opencode");
  // --pane keeps the ladder to rungs 1-2, so the heal is the only pane change.
  const result = f.run(compiledRouter(), "--pane", "testteam/peer:0.0");
  expect(result.stderr).toContain("tap nudge: repainted OpenCode terminal overprint before composer classification");
  expect(result.stdout).toContain("band=overprint -> repaint -> band=readable");
  expect(result.status).toBe(0);
  expect(f.effects()).toBe("");
  expect(readFileSync(join(f.root, "state/width"), "utf8").trim()).toBe("124");
}, 120000);

// tap-gpk7b: the requeue's waiter is spawned from inside the compiled router. A stand-in `bun`
// on the fixture's PATH records what the spawn was handed: real Bun on the shipped spool-waiter.ts.
test("the compiled router's park requeue starts the spool waiter on real bun and the shipped spool-waiter.ts", () => {
  const { f, id } = copyModePark();
  writeFileSync(join(f.root, "bin/bun"), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$FAKE_ROOT/state/bun-argv"\n', { mode: 0o700 });
  const result = f.run(compiledRouter());
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`requeued copy-mode park ${id}`);
  const log = join(f.root, "state/bun-argv");
  for (let i = 0; i < 100 && !existsSync(log); i++) Bun.sleepSync(50);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`--config=${join(compiledRouterSrc(), "../tap-bunfig.toml")}`, "--no-env-file", join(compiledRouterSrc(), "spool-waiter.ts"), id]);
}, 120000);

// tap-gpk7b: an incident's operator escalation resolved the escalate entry from the compiled
// module's virtual directory, so the spawn named /skills/tap/scripts/... and never ran.
test("the compiled router's incident escalation reaches the shipped escalate.ts", () => {
  const f = fixture();
  writeFileSync(join(f.root, "state/exit-on-enter"), "");
  const result = f.run(compiledRouter());
  expect(result.stderr).toMatch(/tap recovery: INCIDENT: harness exited or registered instance changed after recovery/);
  const debug = join(f.root, "index/debug/recovery");
  const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
  const outcome = JSON.parse(readFileSync(join(debug, recovery, "escalation-result.json"), "utf8"));
  // The runner pins a notifier that does not exist, so escalate.ts itself runs and refuses
  // before notifying anyone: its own diagnostic is the proof that the entry was reached.
  expect(outcome.error).toBeUndefined();
  expect(outcome.stderr).toMatch(/^tap escalate: notifier '.*' not found — no notification attempted/);
}, 120000);

// The escalation child is the router's own executable run as the Bun command line
// (BUN_BE_BUN=1), which loads "$PWD/bunfig.toml" whatever the router was compiled with.
// The seat's directory here ships a preload that leaves a marker when Bun starts escalate.ts.
test("the compiled router's incident escalation does not run the working directory's bunfig.toml preload", () => {
  const f = fixture();
  const mark = join(f.root, "state/preload-ran"), entry = join(compiledRouterSrc(), "verbs/escalate.ts");
  writeFileSync(join(f.root, "preload.ts"), `import { writeFileSync } from "node:fs";
if (process.argv.some(arg => arg.endsWith("/verbs/escalate.ts"))) writeFileSync(${JSON.stringify(mark)}, "x");
`);
  // The relative path is assembled: the publish closure scan reads a literal one as a file this test needs.
  writeFileSync(join(f.root, "bunfig.toml"), `preload = ["./${"preload.ts"}"]\n`);
  // Control: the same binary as Bun, on the same entry, in that directory, without TAP's
  // flags does run the preload. Without it the absence below could never fail.
  spawnSync(compiledRouter(), [entry, "--help"], { cwd: f.root, encoding: "utf8", timeout: 25000,
    env: { ...process.env, HOME: f.root, TAP_HOME: join(f.root, "bus"), TAP_INDEX_HOME: join(f.root, "index"), BUN_BE_BUN: "1" } });
  expect(existsSync(mark)).toBe(true);
  rmSync(mark);

  writeFileSync(join(f.root, "state/exit-on-enter"), "");
  const result = f.run(compiledRouter());
  expect(result.stderr).toMatch(/tap recovery: INCIDENT: harness exited or registered instance changed after recovery/);
  const debug = join(f.root, "index/debug/recovery");
  const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
  const outcome = JSON.parse(readFileSync(join(debug, recovery, "escalation-result.json"), "utf8"));
  // escalate.ts itself ran (its own refusal is the proof), and the preload did not.
  expect(outcome.stderr).toMatch(/^tap escalate: notifier '.*' not found — no notification attempted/);
  expect(existsSync(mark)).toBe(false);
}, 120000);
