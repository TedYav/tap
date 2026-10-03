// tap-zvuc9: nudge leaves a copy mode nobody is viewing, once, only when a park
// would requeue but for it, and records the cancel in the recovery run ledger.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cancelUnattendedCopyMode, observeUnattendedCopyMode, type CopyModeClients } from "../src/recovery/copy-park-cancel";
import type { EffectIO, PaneSnapshot } from "../src/recovery/effect";
import { recoveryRoot, runDirectory, type RecoveryTarget } from "../src/recovery/state";
import type { Run } from "../src/tmux";

const ok = (stdout: string): Run => ({ code: 0, stdout, stderr: "" });
const PANE = "%7\t1\tcopy-mode\t0\n";
function reads(over: { pane?: Run; panes?: Run; clients?: Run } = {}) {
  return (args: string[]): Run => {
    if (args[0] === "display-message") return over.pane ?? ok(PANE);
    if (args[0] === "list-panes") return over.panes ?? ok("work\t%7\nother\t%8\n");
    if (args[0] === "list-clients") return over.clients ?? ok("other\t/dev/ttys001\n");
    throw new Error(`unexpected ${args.join(" ")}`);
  };
}

test("a copy-mode pane no client views, through any session that shows it, is unattended", () => {
  expect(observeUnattendedCopyMode("%7", reads())).toEqual({ status: "unattended" });
  expect(observeUnattendedCopyMode("%7", reads({ clients: ok("") }))).toEqual({ status: "unattended" });
});

test("every unreadable, malformed, attended or drifted read refuses; a pane out of copy mode is normal", () => {
  const refused = (over: Parameters<typeof reads>[0]) => observeUnattendedCopyMode("%7", reads(over));
  expect(refused({ pane: ok("%7\t0\t\t0\n") })).toEqual({ status: "normal" });
  // A client on a grouped or linked session that also shows the pane is viewing it.
  expect(refused({ panes: ok("work\t%7\nlinked\t%7\n"), clients: ok("linked\t/dev/ttys009\n") }))
    .toEqual({ status: "refused", why: "a tmux client (/dev/ttys009) is viewing it; leave copy mode there, then nudge again" });
  expect(refused({ pane: ok("%7\t1\tview-mode\t0\n") })).toEqual({ status: "refused", why: "the pane is in view-mode, not copy mode" });
  expect(refused({ pane: ok("%9\t1\tcopy-mode\t0\n") })).toEqual({ status: "refused", why: "the pane changed identity" });
  expect(refused({ panes: ok("other\t%8\n") })).toEqual({ status: "refused", why: "the pane changed identity" });
  expect(refused({ pane: { code: 1, stdout: "", stderr: "no server" } })).toEqual({ status: "refused", why: "the pane's mode is unreadable" });
  expect(refused({ clients: { code: 0, stdout: "", stderr: "", rateLimited: true } })).toEqual({ status: "refused", why: "the tmux client list is unreadable" });
  expect(refused({ clients: { code: 1, stdout: "", stderr: "" } })).toEqual({ status: "refused", why: "the tmux client list is unreadable" });
  expect(refused({ clients: ok("garbled\n") })).toEqual({ status: "refused", why: "the tmux client list is malformed" });
  expect(refused({ panes: ok("work\tnot-a-pane\n") })).toEqual({ status: "refused", why: "the tmux client list is malformed" });
  expect(refused({ pane: ok("%7\t1\tcopy-mode\t1\n") }))
    .toEqual({ status: "refused", why: "the session reports an attached client the client list does not show" });
  expect(refused({ pane: ok("%7\t1\tcopy-mode\t\n") })).toEqual({ status: "refused", why: "the session's attached count is unreadable" });
  // Surplus or missing fields, or a second row, are malformed evidence, not a clean pane.
  for (const raw of ["%7\t1\tcopy-mode\t0\textra\n", "%7\t1\tcopy-mode\n", "%7\t1\tcopy-mode\t0\n%7\t1\tcopy-mode\t0\n", "%7\t0\t\t0\textra\n"]) {
    expect(refused({ pane: ok(raw) })).toEqual({ status: "refused", why: "the pane's mode is malformed" });
  }
});

const target: RecoveryTarget = { team: "fixture", handle: "peer", registry: "/nonexistent/registry.json", pane: "work:0.0", paneId: "%7",
  session: "work", instance: "i-peer", harness: "codex", processPid: "4242" };
function fakeIo(onEffect: () => void = () => {}, authorize: () => string | null = () => null) {
  const sent: string[][] = [];
  const snapshot = (): PaneSnapshot => ({ dead: "0", command: "codex", windowCount: "1", paneId: "%7", instance: "i-peer", present: true, pid: "4242", registered: true });
  const io: EffectIO = { capture: () => "frame", snapshot, authorize, effect: args => { sent.push(args); onEffect(); return ok(""); }, settle: () => {} };
  return { io, sent };
}
const events = (id: string) => readFileSync(join(runDirectory(id), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

test("a licensed, unattended copy mode gets exactly one recorded -X cancel, verified by a fresh read", () => {
  let mode: CopyModeClients = { status: "unattended" };
  const { io, sent } = fakeIo(() => { mode = { status: "normal" }; });
  const result = cancelUnattendedCopyMode({ mode: "aggressive", registry: target.registry, handle: "peer", pane: target.pane, paneId: "%7",
    home: "/bus", license: () => ["p1"], observe: () => mode, target: () => target, io });
  expect(result.status).toBe("verified");
  expect(sent).toEqual([["send-keys", "-t", "%7", "-X", "cancel"]]);
  if (result.status === "skipped") throw new Error("unreachable");
  const run = JSON.parse(readFileSync(join(runDirectory(result.recovery), "run.json"), "utf8"));
  expect(run).toMatchObject({ hold: false, effects: 1, state: "released", payloads: [{ home: "/bus", id: "p1" }] });
  const recorded = events(result.recovery);
  expect(recorded.map(e => [e.action, e.effect, e.outcome])).toEqual([["copy-mode cancel", "possible", "verified"]]);
  expect(recorded[0].reason).toBe("aggressive: copy-mode park recovery; no attached tmux client");
});

test("no license, a normal pane, or an attended pane sends nothing and opens no run", () => {
  const before = existsSync(recoveryRoot()) ? readdirSync(recoveryRoot()).length : 0;
  for (const [license, observed, why] of [
    [[], { status: "unattended" }, undefined],
    [["p1"], { status: "normal" }, undefined],
    [["p1"], { status: "refused", why: "a tmux client (/dev/ttys001) is viewing it; leave copy mode there, then nudge again" }, "a tmux client (/dev/ttys001) is viewing it; leave copy mode there, then nudge again"],
  ] as const) {
    const { io, sent } = fakeIo();
    const result = cancelUnattendedCopyMode({ mode: "aggressive", registry: target.registry, handle: "peer", pane: target.pane, paneId: "%7",
      home: "/bus", license: () => [...license], observe: () => observed as CopyModeClients, target: () => target, io });
    expect(result).toEqual(why ? { status: "skipped", why } : { status: "skipped" });
    expect(sent).toEqual([]);
  }
  expect(existsSync(recoveryRoot()) ? readdirSync(recoveryRoot()).length : 0).toBe(before);
});

for (const [name, drift] of [
  ["a client attaches", { observe: { status: "refused", why: "a tmux client (/dev/ttys002) is viewing it; leave copy mode there, then nudge again" } }],
  ["copy mode ends", { observe: { status: "normal" } }],
  ["the park stops licensing (a settlement or .attempted)", { license: [] as string[] }],
] as const) test(`${name} during the run's state writes: refused at the key boundary, no key, effect none`, () => {
  let calls = 0;
  const { io, sent } = fakeIo();
  const result = cancelUnattendedCopyMode({ mode: "aggressive", registry: target.registry, handle: "peer", pane: target.pane, paneId: "%7",
    home: "/bus", target: () => target, io,
    // The first read licenses; every read at the key boundary sees the drift.
    license: () => (calls++ === 0 || !("license" in drift) ? ["p1"] : [...drift.license]),
    observe: () => (calls <= 1 || !("observe" in drift) ? { status: "unattended" } : drift.observe as CopyModeClients) });
  expect(sent).toEqual([]);
  expect(result.status).toBe("refused");
  if (result.status === "skipped") throw new Error("unreachable");
  const [event] = events(result.recovery);
  expect(event.effect).toBe("none");
  expect(event.summary).toStartWith("refused before keys");
});

const socket = `zvuc9-${process.pid}`;
const T = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const read = (args: string[]): Run => { const r = T(...args); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; };
let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "zvuc9-")); });
afterAll(() => { T("kill-server"); rmSync(scratch, { recursive: true, force: true }); });

test("a real detached pane in copy mode reads unattended, and -X cancel leaves it", () => {
  const pane = T("new-session", "-d", "-s", "work", "-c", scratch, "-P", "-F", "#{pane_id}", "sleep 60").stdout.trim();
  expect(pane).toMatch(/^%\d+$/);
  expect(observeUnattendedCopyMode(pane, read)).toEqual({ status: "normal" });
  expect(T("copy-mode", "-t", pane).status).toBe(0);
  expect(observeUnattendedCopyMode(pane, read)).toEqual({ status: "unattended" });
  // A grouped session shows the same pane; with no client on it, still unattended.
  expect(T("new-session", "-d", "-t", "work", "-s", "grouped").status).toBe(0);
  // Instrument B sees a viewer on a sibling session only because the pane is listed once per session.
  const listed = read(["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}"]).stdout;
  expect(listed).toContain(`work\t${pane}\n`);
  expect(listed).toContain(`grouped\t${pane}\n`);
  expect(observeUnattendedCopyMode(pane, read)).toEqual({ status: "unattended" });
  expect(T("send-keys", "-t", pane, "-X", "cancel").status).toBe(0);
  expect(observeUnattendedCopyMode(pane, read)).toEqual({ status: "normal" });
});

// sol F1: the gate's own reads take time, so the captured target is re-proved after them.
test("a binding that changes while the gate reads gets no key", () => {
  let denied = false, observeCalls = 0;
  const { io, sent } = fakeIo(() => {}, () => (denied ? "captured target binding changed" : null));
  const result = cancelUnattendedCopyMode({ mode: "aggressive", registry: target.registry, handle: "peer", pane: target.pane, paneId: "%7",
    home: "/bus", target: () => target, io, license: () => ["p1"],
    observe: () => { const seen = observeCalls++; if (seen === 1) denied = true; return { status: "unattended" }; } });
  expect(sent).toEqual([]);
  expect(result.status).toBe("refused");
  if (result.status === "skipped") throw new Error("unreachable");
  const [event] = events(result.recovery);
  expect(event.effect).toBe("none");
  expect(event.summary).toContain("captured target binding changed");
});

// sol F2: the verdict is the captured target's. A same-pane replacement that reads normal is not verified.
test("a pane replaced around the post-cancel read is unverified, not verified", () => {
  let denied = false, cancelled = false;
  const { io, sent } = fakeIo(() => { cancelled = true; }, () => (denied ? "captured target binding changed" : null));
  const result = cancelUnattendedCopyMode({ mode: "aggressive", registry: target.registry, handle: "peer", pane: target.pane, paneId: "%7",
    home: "/bus", target: () => target, io, license: () => ["p1"],
    observe: () => { if (cancelled) { denied = true; return { status: "normal" }; } return { status: "unattended" }; } });
  expect(sent).toEqual([["send-keys", "-t", "%7", "-X", "cancel"]]);
  expect(result.status).toBe("unverified");
  if (result.status === "skipped") throw new Error("unreachable");
  expect(events(result.recovery).map(e => e.outcome)).not.toContain("verified");
});
