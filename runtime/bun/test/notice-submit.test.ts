import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { paneState } from "../src/pane-state";
import { submitNotice, type NoticeSubmitInput } from "../src/notice-submit";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { decodeAttemptRows, joinAttemptRows } from "../src/courier-contract";
import { removeScratchTree } from "./support/scratch";
let root: string, input: NoticeSubmitInput, writes: string[], entered: boolean;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tap-notice."));
  const bus = new Bus(join(root, "bus")); bus.ensureDirs();
  writeFileSync(bus.payloadPath("notice"), "---\nid: notice\nfrom: courier\nto: alice\nkind: delivery-failed\nreply: settle-only\n---\nFailure notice\n");
  const registryPath = join(root, "sender-registry.json");
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", seats: { alice: { status: "active", pane_id: "%7", server_epoch: "srv:1:2", instance: "instance-1" } } }));
  input = { bus, id: "notice", pane: "sender:0.0",
    bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude", handle: "alice", instance: "instance-1" },
    authority: { registryPath, scriptsDir: "/unused", agentFamilies: new Set(["claude"]) } };
  writes = []; entered = false;
});
afterEach(() => removeScratchTree(root));
function run(overrides: Partial<PaneEffects> = {}) {
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%7", session: "sender", serverEpoch: "srv:1:2", panePid: "1", currentCommand: "claude" }),
    paneState: () => ({ state: "ready" }), harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    injectText: () => { writes.push("inject"); return true; },
    inputHasId: () => !entered,
    pressEnter: () => { writes.push("enter"); entered = true; return true; }, settle: () => {}, ...overrides,
  };
  return submitNotice(input, (pane, id, sentinel, bound, authority) => submitVerifyLocked(pane, id, sentinel, bound, fx, authority));
}
const attempts = () => input.bus.payloadPath("notice").replace(/\.md$/, ".attempts");
function joined() { return joinAttemptRows(decodeAttemptRows(readFileSync(attempts(), "utf8"))); }
test("verified wake writes a valid attempt pair and turn-unconfirmed sent receipt", () => {
  expect(run().status).toBe("injected"); expect(writes).toEqual(["inject", "enter", "enter"]);
  expect(joined().paired[0]!.outcome.disposition).toBe("delivered");
  expect(joined().unverified).toBeNull();
  expect(JSON.parse(readFileSync(input.bus.sentPath("notice"), "utf8")).turn).toBe("unconfirmed");
});
for (const status of ["unobservable", "rate_limited"] as const) test(`lost final observation ${status} never writes sent`, () => {
  expect(run({ observeInput: () => entered ? { state: status, reason: "lost" } : { state: "present", text: "notice" } }).status).toBe("unverified");
  expect(writes).toEqual(["inject", "enter", "enter"]);
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
  expect(joined().paired[0]!.outcome.disposition).toBe("unconfirmed");
  const before = [...writes]; expect(run().status).toBe("unverified"); expect(writes).toEqual(before);
});
test("staged notice stays unconfirmed with debug disabled and cannot repeat", () => {
  expect(run({ inputHasId: () => true }).status).toBe("unverified");
  expect(joined().paired[0]!.outcome.effect).toBe("possible");
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
  const count = writes.length; run(); expect(writes.length).toBe(count);
});
for (const drift of ["instance", "registry"] as const) test(`sender ${drift} drift refuses effects with valid conservative evidence`, () => {
  if (drift === "instance") input.bound.instance = "old-instance";
  else writeFileSync(input.authority.registryPath!, JSON.stringify({ schema: "0.20", seats: {} }));
  expect(run().status).toBe("identity_mismatch"); expect(writes).toEqual([]);
  expect(joined().paired[0]!.outcome.disposition).toBe("unconfirmed");
  expect(readFileSync(attempts(), "utf8")).toContain("identity_mismatch");
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
});
for (const residue of ["", "torn", "directory"]) test(`existing ${residue || "empty"} evidence refuses any submit`, () => {
  if (residue === "directory") mkdirSync(attempts()); else writeFileSync(attempts(), residue);
  expect(run().status).toBe("unverified"); expect(writes).toEqual([]);
});
test("begin survives interrupted submit and excludes a concurrent/restarted wake", () => {
  const result = submitNotice(input, () => {
    expect(joined().unverified?.rows.length).toBe(1);
    expect(run().status).toBe("unverified"); expect(writes).toEqual([]);
    throw new Error("interrupted");
  });
  expect(result.status).toBe("unverified");
  expect(joined().paired[0]!.outcome.detail).toContain("interrupted");
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
});

test("changed final composer refuses confirmed delivery", () => {
  expect(run({ submitFrame: () => ({ state: entered ? "changed" : "staged", mode: "idle", width: "100" }) }).status).toBe("unverified");
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
  expect(joined().paired[0]!.outcome.disposition).toBe("unconfirmed");
});
test("begin-only crash residue is joined as uncertain and never repeated", () => {
  let begin = "";
  submitNotice(input, () => { begin = readFileSync(attempts(), "utf8"); throw new Error("crash"); });
  writeFileSync(attempts(), begin);
  expect(joined().unverified?.rows.length).toBe(1);
  expect(run().status).toBe("unverified"); expect(writes).toEqual([]);
});

test('queued notice records accepted outcome without a sent receipt',()=>{
 expect(run({submitFrame:()=>({state:entered?'queued':'staged',mode:'working',width:'80'})}).status).toBe('harness_queued');
 expect(writes).toEqual(['inject','enter','enter']);
 expect(existsSync(input.bus.sentPath('notice'))).toBe(false);
 expect(joined().paired[0]!.outcome.disposition).toBe('harness-queued');
 expect(existsSync(join(input.bus.home,'receipts','notice.harness-queued'))).toBe(true);
});

// U3 (plan 2026-09-18-b8qp5): the sender-notice route through the real typed
// paneState seam. A minimal fake tmux serves the supplied frame for
// capture-pane and plausible presence/epoch answers for everything else.
const CURSOR_IDLE_ESCAPED =
  " \x1b[48;2;32;32;32m \x1b[2m→ \x1b[0;7m\x1b[48;2;32;32;32mA\x1b[0;2m\x1b[48;2;32;32;32mdd a follow-up\x1b[0m";
const HERMES_IDLE_ESCAPED = "\x1b[38;5;230m❯ \x1b[3;38;5;136mWhat would you like to do?\x1b[0m";
const CURSOR_TYPED = " → ship the release notes";

// One honest attempt per test: submitNotice writes <id>.attempts before
// preflight, so a second call for the same input would refuse on existing
// evidence rather than re-prove the route.
function withRealBand<T>(frame: string, fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "tap-notice-band."));
  const framePath = join(bin, "frame");
  writeFileSync(framePath, frame);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"capture-pane"*) cat "${framePath}" ;;
  *) printf '%%7\\tsender\\t4242\\tclaude\\t0\\n' ;;
esac
`, { mode: 0o755 });
  const socket = join(bin, "socket");
  writeFileSync(socket, "socket\n");
  // Private runtime-cache root: the tmux client budget's kernel-lock
  // sidecars stay off the suite-shared TAP_INDEX_HOME cache, so this test's
  // burst of in-process claims cannot churn shared lock paths.
  const index = mkdtempSync(join(bin, "index."));
  const savedPath = process.env.PATH;
  const savedSocket = process.env.TAP_TMUX_SOCKET_PATH;
  const savedIndexHome = process.env.TAP_INDEX_HOME;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.TAP_TMUX_SOCKET_PATH = socket;
  process.env.TAP_INDEX_HOME = index;
  try {
    return fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedSocket === undefined) delete process.env.TAP_TMUX_SOCKET_PATH;
    else process.env.TAP_TMUX_SOCKET_PATH = savedSocket;
    if (savedIndexHome === undefined) delete process.env.TAP_INDEX_HOME;
    else process.env.TAP_INDEX_HOME = savedIndexHome;
    rmSync(bin, { recursive: true, force: true });
  }
}

function bandRun(harness: string) {
  input.bound.harness = harness;
  input.authority.agentFamilies = new Set(["claude", "cursor", "hermes"]);
  return run({ paneState: (t, h, c) => paneState(t, h, c) });
}

test("idle Cursor band is ready: the sender-notice route injects", () => {
  const r = withRealBand(CURSOR_IDLE_ESCAPED, () => bandRun("cursor-agent"));
  expect(r.status).toBe("injected");
  // Cursor owns two submit keys, followed by the guarded completion key.
  expect(writes).toEqual(["inject", "enter", "enter", "enter"]);
  expect(existsSync(input.bus.sentPath("notice"))).toBe(true);
});

test("idle Hermes band is ready: the sender-notice route injects", () => {
  const r = withRealBand(HERMES_IDLE_ESCAPED, () => bandRun("hermes"));
  expect(r.status).toBe("injected");
  expect(writes).toEqual(["inject", "enter", "enter"]);
  expect(existsSync(input.bus.sentPath("notice"))).toBe(true);
});

test("typed Cursor band refuses the sender-notice route with zero pane effects", () => {
  const r = withRealBand(CURSOR_TYPED, () => bandRun("cursor-agent"));
  expect(r.status).toBe("band_busy");
  expect(r).toMatchObject({ bandState: "busy", bandText: "ship the release notes" });
  expect(writes).toEqual([]);
  expect(existsSync(input.bus.sentPath("notice"))).toBe(false);
});
