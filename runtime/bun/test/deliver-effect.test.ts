import { inputBackupBody } from "../src/input-backup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bus } from "../src/bus";
import {
  decodeAttemptRows,
  encodeAttemptRows,
  joinAttemptRows,
  type AttemptBeginRow,
  type AttemptOutcomeRow,
} from "../src/courier-contract";
import { clearOwnInjection, clobberBand, deliver, type DeliveryInput, type PaneEffects } from "../src/deliver";
import { removeScratchTree } from "./support/scratch";

let root: string;
let bus: Bus;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tap-deliver."));
  bus = new Bus(join(root, "bus"));
  bus.ensureDirs();
});

afterEach(() => removeScratchTree(root));

const attemptsPath = (id: string): string => bus.payloadPath(id).replace(/\.md$/, ".attempts");

function input(id: string, via: "send" | "owner" = "owner"): DeliveryInput {
  const sentinel = `[[TAP v=0.22 from=alice to=bob id=${id} kind=discuss reply=expected]]`;
  writeFileSync(bus.payloadPath(id), "canonical\n");
  return {
    bus,
    id,
    pane: "team/bob:0.0",
    sentinel,
    bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" },
    from: "alice",
    to: "bob",
    kind: "discuss",
    via,
  };
}

function livePane(command = "claude") {
  return { paneId: "%7", session: "team/bob", serverEpoch: "srv:1:2", panePid: "1", currentCommand: command };
}

function readyEffects() {
  const effects: string[] = [];
  let entered = false;
  const fx: PaneEffects = {
    observePane: () => livePane(),
    paneCurrentCommand: () => "claude",
    paneState: () => ({ state: "ready" }),
    injectText: (target) => { effects.push(`inject:${target}`); return true; },
    inputHasId: () => !entered,
    pressEnter: (target) => { effects.push(`enter:${target}`); entered = true; return true; },
    settle: () => {},
  };
  return { effects, fx };
}

function draftEffects(initialBand: string, paneCommand = "claude") {
  let band = initialBand;
  const effects: string[] = [];
  const record = (effect: string, target: string) => effects.push(`${effect}:${target}`);
  const fx: PaneEffects = {
    observePane: () => livePane(paneCommand),
    paneCurrentCommand: () => paneCommand,
    // Claude's composer (tap-ipex2): rows as typed, C-u empties the cursor row, BSpace joins an empty row.
    paneState: () => band ? { state: "busy", text: band, ...(paneCommand === "claude" ? { rows: band.split("\n"), columns: 100 } : {}) } : { state: "ready" },
    clearInput: (target) => {
      record("clear", target);
      const rows = band.split("\n");
      band = paneCommand === "claude" && rows.length > 1 ? [...rows.slice(0, -1), ""].join("\n") : "";
      return true;
    },
    backspace: (target) => {
      record("backspace", target);
      if (paneCommand === "claude" && band.endsWith("\n")) band = band.slice(0, -1);
      return true;
    },
    injectText: (target, text) => { record("inject", target); band = text; return true; },
    inputHasId: (_target, _command, needle) => band.includes(needle),
    pressEnter: (target) => { record("enter", target); band = ""; return true; },
    restoreInput: (target, text) => { record("restore", target); band += text; return true; },
    settle: () => {},
  };
  return {
    fx,
    effects,
    count: (effect: string) => effects.filter((entry) => entry.startsWith(`${effect}:`)).length,
    get band() { return band; },
    set band(value: string) { band = value; },
  };
}

describe("delivery effect boundary", () => {
  test("retained dead identity reparks canonical mail without effects or cancellation", () => {
    const request = input("retained-dead");
    const { fx, effects } = readyEffects();
    fx.observePane = () => "pane_dead";
    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "pane_dead" });
    expect(result.detail).toContain("has exited");
    expect(effects).toEqual([]);
    expect(readFileSync(bus.payloadPath(request.id), "utf8")).toBe("canonical\n");
    expect(existsSync(bus.cancelPath(request.id))).toBe(false);
    expect(existsSync(bus.sentPath(request.id))).toBe(false);
  });

  test("death after injection remains unconfirmed and never presses Enter", () => {
    const request = input("died-after-injection");
    const { fx, effects } = readyEffects();
    let dead = false;
    fx.observePane = () => dead ? "pane_dead" : livePane();
    fx.injectText = () => { effects.push("inject"); dead = true; return true; };
    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "pane_dead" });
    expect(effects).toEqual(["inject"]);
    expect(readFileSync(bus.payloadPath(request.id), "utf8")).toBe("canonical\n");
    expect(existsSync(bus.cancelPath(request.id))).toBe(false);
    expect(existsSync(bus.sentPath(request.id))).toBe(false);
  });

  test("a dead input observation preserves its reason before delivery begins", () => {
    const request = input("dead-input-band");
    const { fx, effects } = readyEffects();
    fx.paneState = () => ({ state: "unobservable", cause: "pane_dead", reason: "pane has exited" });
    expect(deliver(request, { pane: fx })).toMatchObject({ action: "repark", effect: "none", cause: "pane_dead" });
    expect(effects).toEqual([]);
    expect(existsSync(bus.cancelPath(request.id))).toBe(false);
  });

  test("unobservable identity reparks without cancelling or touching the pane", () => {
    const request = input("unobservable-identity");
    const { fx, effects } = readyEffects();
    fx.observePane = () => "unobservable";
    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "identity_unobservable" });
    expect(effects).toEqual([]);
    expect(readFileSync(bus.payloadPath(request.id), "utf8")).toBe("canonical\n");
    expect(existsSync(bus.sentPath(request.id))).toBe(false);
  });
  test("AE6: swallowed Enter records one possible-effect attempt and never writes .sent", () => {
    const id = "alice-20260830T120000Z-aabbccddeeff";
    const request = input(id);

    let injects = 0;
    let enters = 0;
    const notices: string[] = [];
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => ({ state: "ready" }),
      injectText: () => {
        injects++;
        const beforeEffect = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
        expect(beforeEffect.unverified?.rows).toHaveLength(1);
        expect(beforeEffect.unverified?.rows[0]?.phase).toBe("begin");
        return true;
      },
      inputHasId: () => true,
      pressEnter: () => { enters++; return true; },
      settle: () => {},
    };

    const result = deliver(request, { pane: fx, notice: (notice) => notices.push(notice) });

    expect(result).toMatchObject({
      action: "unconfirmed",
      effect: "possible",
      cause: "submit_unverified",
      notice: "unconfirmed",
    });
    expect(injects).toBe(1);
    expect(enters).toBe(1);
    expect(notices).toEqual(["unconfirmed"]);
    expect(existsSync(bus.sentPath(id))).toBe(false);

    const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
    expect(readout.paired).toHaveLength(1);
    expect(readout.paired[0]?.begin.attempt_id).toBe(readout.paired[0]?.outcome.attempt_id);
    expect(readout.paired[0]?.outcome).toMatchObject({
      driver: "tmux",
      disposition: "unconfirmed",
      effect: "possible",
      tier: "none",
    });
    expect(readout.unverified).toBeNull();
  });

  test("OpenCode courier repaints once before final unverified and never sends a second Enter", () => {
    const id = "alice-20260830T120050Z-aabbccddeeff";
    const request = input(id); request.bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "opencode" };
    let entered = 0, repaints = 0, repainted = false;
    const fx: PaneEffects = {
      observePane: () => livePane("opencode"),
      paneCurrentCommand: () => "opencode",
      paneState: () => ({ state: "ready" }),
      injectText: () => true,
      inputHasId: () => true,
      pressEnter: () => { entered++; return true; },
      submitFrame: () => ({ state: repainted ? "queued" : "staged", mode: "working", width: "113" }),
      repaint: () => { repaints++; repainted = true; return { ok: true, attempted: true, before: "stale", after: "repainted", reason: "observed" }; },
      settle: () => {},
    };

    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "harness-queued", effect: "possible" });
    expect(entered).toBe(1);
    expect(repaints).toBe(1);
  });

  test("failed OpenCode repaint remains submit-unverified without another Enter", () => {
    const id = "alice-20260830T120055Z-aabbccddeeff";
    const request = input(id); request.bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "opencode" };
    let entered = 0, repaints = 0;
    const fx: PaneEffects = {
      observePane: () => livePane("opencode"),
      paneCurrentCommand: () => "opencode",
      paneState: () => ({ state: "ready" }),
      injectText: () => true,
      inputHasId: () => true,
      pressEnter: () => { entered++; return true; },
      submitFrame: () => ({ state: "staged", mode: "working", width: "113" }),
      repaint: () => { repaints++; return { ok: false, attempted: true, before: "stale", after: null, reason: "restore failed" }; },
      settle: () => {},
    };

    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "unconfirmed", cause: "submit_unverified" });
    expect(result.detail).toContain("restore failed");
    expect(entered).toBe(1);
    expect(repaints).toBe(1);
  });

  test("post-repaint input must be typed absent before delivery is recorded", () => {
    const id = "alice-20260830T120057Z-aabbccddeeff";
    const request = input(id); request.bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "opencode" };
    let entered = 0, repainted = false;
    const fx: PaneEffects = {
      observePane: () => livePane("opencode"),
      paneCurrentCommand: () => "opencode",
      paneState: () => ({ state: "ready" }),
      injectText: () => true,
      inputHasId: () => true,
      observeInput: () => repainted ? { state: "rate_limited", reason: "budget exhausted" } : { state: "present", text: id },
      pressEnter: () => { entered++; return true; },
      submitFrame: () => ({ state: repainted ? "empty" : "staged", mode: "working", width: "113" }),
      repaint: () => { repainted = true; return { ok: true, attempted: true, before: "stale", after: "repainted", reason: "observed" }; },
      settle: () => {},
    };

    const result = deliver(request, { pane: fx });
    expect(result).toMatchObject({ action: "unconfirmed", cause: "submit_unverified" });
    expect(entered).toBe(1);
    expect(existsSync(bus.sentPath(id))).toBe(false);
  });

  test("a draft is a pre-begin repark with no pane effect", () => {
    const id = "alice-20260830T120100Z-aabbccddeeff";
    const effects: string[] = [];
    const fx: PaneEffects = {
      ...readyEffects().fx,
      paneState: () => ({ state: "busy", text: "human draft" }),
      injectText: () => { effects.push("inject"); return true; },
      pressEnter: () => { effects.push("enter"); return true; },
    };

    const result = deliver(input(id), { pane: fx });

    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "draft" });
    expect(effects).toEqual([]);
    expect(existsSync(bus.sentPath(id))).toBe(false);
    const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
    expect(readout.paired).toEqual([]);
    expect(readout.pre_begin).toHaveLength(1);
    expect(readout.pre_begin[0]?.disposition).toBe("repark");
    expect(readout.unverified).toBeNull();
  });

  test("a pre-begin replacement is a forensic identity cancellation with no pane effect", () => {
    const id = "alice-20260830T120200Z-aabbccddeeff";
    const effects: string[] = [];
    const notices: string[] = [];
    const fx: PaneEffects = {
      ...readyEffects().fx,
      observePane: () => ({ ...livePane(), paneId: "%99" }),
      injectText: () => { effects.push("inject"); return true; },
      pressEnter: () => { effects.push("enter"); return true; },
    };

    const result = deliver(input(id), { pane: fx, notice: (notice) => notices.push(notice) });

    expect(result).toMatchObject({
      action: "cancel",
      effect: "none",
      cause: "identity_mismatch",
      receipt_reason: "pane_gone",
      notice: "failed",
    });
    expect(effects).toEqual([]);
    expect(notices).toEqual(["failed"]);
    expect(JSON.parse(readFileSync(bus.cancelPath(id), "utf8"))).toMatchObject({ reason: "pane_gone" });
    const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
    expect(readout.pre_begin).toHaveLength(1);
    expect(readout.unverified).toBeNull();
  });

  test("a pane gone before begin stays distinct from identity mismatch", () => {
    const id = "alice-20260830T120250Z-aabbccddeeff";
    const ready = readyEffects();
    const result = deliver(input(id), { pane: { ...ready.fx, observePane: () => null } });

    expect(result).toMatchObject({
      action: "cancel", effect: "none", cause: "pane_gone",
      receipt_reason: "pane_gone", notice: "failed",
    });
    expect(ready.effects).toEqual([]);
    expect(JSON.parse(readFileSync(bus.cancelPath(id), "utf8"))).toMatchObject({ reason: "pane_gone" });
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8"))).pre_begin).toHaveLength(1);
  });

  test("a replacement after begin is unconfirmed/possible and receives nothing", () => {
    const id = "alice-20260830T120300Z-aabbccddeeff";
    let observations = 0;
    const replacementReceived: string[] = [];
    const fx: PaneEffects = {
      ...readyEffects().fx,
      observePane: () => {
        observations++;
        return observations <= 2
          ? livePane()
          : { ...livePane(), paneId: "%99" };
      },
      injectText: () => false,
      pressEnter: (target) => { replacementReceived.push(target); return true; },
    };

    const result = deliver(input(id), { pane: fx });

    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "identity_mismatch" });
    expect(replacementReceived).toEqual([]);
    expect(existsSync(bus.sentPath(id))).toBe(false);
    expect(existsSync(bus.cancelPath(id))).toBe(false);
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8"))).paired).toHaveLength(1);
  });

  test("a pane gone after begin is cancel/possible, never generic unconfirmed", () => {
    const id = "alice-20260830T120400Z-aabbccddeeff";
    let observations = 0;
    const fx: PaneEffects = {
      ...readyEffects().fx,
      observePane: () => {
        observations++;
        return observations <= 2 ? livePane() : null;
      },
      injectText: () => false,
    };

    const result = deliver(input(id), { pane: fx });

    expect(result).toMatchObject({
      action: "cancel", effect: "possible", cause: "pane_gone",
      receipt_reason: "pane_gone", notice: "failed",
    });
    expect(JSON.parse(readFileSync(bus.cancelPath(id), "utf8"))).toMatchObject({ reason: "pane_gone" });
    expect(existsSync(bus.sentPath(id))).toBe(false);
  });

  test("rate limiting changes action only after attempt-begin", () => {
    const beforeId = "alice-20260830T120500Z-aabbccddeeff";
    const before = readyEffects();
    const preResult = deliver(input(beforeId), {
      pane: {
        ...before.fx,
        paneState: () => ({ state: "rate_limited", reason: "budget" }),
      },
    });
    expect(preResult).toMatchObject({ action: "repark", effect: "none", cause: "rate_limited" });
    expect(before.effects).toEqual([]);
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(beforeId), "utf8"))).pre_begin).toHaveLength(1);

    const afterId = "alice-20260830T120600Z-aabbccddeeff";
    const after = readyEffects();
    const postResult = deliver(input(afterId), {
      pane: { ...after.fx, injectText: () => "rate_limited" },
    });
    expect(postResult).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "rate_limited" });
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(afterId), "utf8"))).paired).toHaveLength(1);
    expect(existsSync(bus.sentPath(afterId))).toBe(false);
  });

  test("AE10: verified clear writes paired evidence before an honest .sent receipt", () => {
    for (const via of ["send", "owner"] as const) {
      const id = `alice-20260830T12070${via === "send" ? "0" : "1"}Z-aabbccddeeff`;
      const ready = readyEffects();
      const result = deliver(input(id, via), { pane: ready.fx });

      expect(result).toEqual({
        action: "delivered",
        effect: "possible",
        detail: `id '${id}' left the input band of 'team/bob:0.0'`,
      });
      expect(ready.effects).toEqual(["inject:%7", "enter:%7"]);
      const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
      expect(readout.paired).toHaveLength(1);
      expect(readout.paired[0]?.outcome).toMatchObject({
        driver: "tmux",
        disposition: "delivered",
        effect: "possible",
        tier: "left-input-band",
      });
      expect([readout.paired[0]?.begin.seq, readout.paired[0]?.outcome.seq]).toEqual([1, 2]);
      expect(JSON.parse(readFileSync(bus.sentPath(id), "utf8"))).toMatchObject({
        id, via, turn: "unconfirmed", delivery: "pane",
      });
    }
  });

  test("a failed outcome append after clear cannot publish .sent", () => {
    const id = "alice-20260830T120750Z-aabbccddeeff";
    const ready = readyEffects();
    const request = input(id);
    const fx: PaneEffects = {
      ...ready.fx,
      pressEnter: (target) => {
        const pressed = ready.fx.pressEnter(target);
        chmodSync(attemptsPath(id), 0o400);
        return pressed;
      },
    };

    expect(() => deliver(request, { pane: fx })).toThrow();
    expect(existsSync(bus.sentPath(id))).toBe(false);
    const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
    expect(readout.unverified?.rows).toHaveLength(1);
    expect(readout.unverified?.rows[0]?.phase).toBe("begin");
  });

  test("a paired delivered outcome with missing .sent recovers the receipt and never touches the pane", () => {
    const id = "alice-20260830T120760Z-aabbccddeeff";
    const digestId = "digest-20260830T120760Z-aabbccddeeff";
    const request = { ...input(id, "owner"), digestId };
    const detail = `id '${id}' left the input band of 'team/bob:0.0'`;
    writeFileSync(attemptsPath(id), encodeAttemptRows([
      {
        v: 1,
        payload_id: id,
        attempt_id: "verified-then-crashed",
        phase: "begin",
        seq: 1,
        rung: 1,
        op: "deliver",
        driver: "tmux",
        class: "plain",
        disposition: "attempt-begin",
        effect: "possible",
        tier: "none",
        detail: "pane delivery may begin",
        native_ref: "",
        ts_start: "2026-08-30T12:07:60Z",
        ts_end: null,
      } satisfies AttemptBeginRow,
      {
        v: 1,
        payload_id: id,
        attempt_id: "verified-then-crashed",
        phase: "outcome",
        seq: 2,
        rung: 1,
        op: "deliver",
        driver: "tmux",
        class: "plain",
        disposition: "delivered",
        effect: "possible",
        tier: "left-input-band",
        detail,
        native_ref: "",
        ts_start: "2026-08-30T12:07:60Z",
        ts_end: "2026-08-30T12:07:61Z",
      } satisfies AttemptOutcomeRow,
    ]));
    expect(existsSync(bus.sentPath(id))).toBe(false);
    const before = readFileSync(attemptsPath(id), "utf8");
    const ready = readyEffects();
    const notices: string[] = [];

    const result = deliver(request, { pane: ready.fx, notice: (notice) => notices.push(notice) });

    expect(result).toEqual({ action: "delivered", effect: "possible", detail });
    expect(ready.effects).toEqual([]);
    expect(notices).toEqual([]);
    expect(readFileSync(attemptsPath(id), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(bus.sentPath(id), "utf8"))).toEqual({
      id,
      from: "alice",
      to: "bob",
      pane: "team/bob:0.0",
      kind: "discuss",
      via: "owner",
      turn: "unconfirmed",
      delivery: "pane",
      digest_id: digestId,
    });

    const successor = readyEffects();
    const second = deliver(request, { pane: successor.fx });
    expect(second).toEqual(result);
    expect(successor.effects).toEqual([]);
    expect(JSON.parse(readFileSync(bus.sentPath(id), "utf8")).digest_id).toBe(digestId);
  });

  test("begin-only and opaque evidence prevent a successor from injecting", () => {
    const cases = [
      {
        id: "alice-20260830T120800Z-aabbccddeeff",
        rows: encodeAttemptRows([{
          v: 1,
          payload_id: "alice-20260830T120800Z-aabbccddeeff",
          attempt_id: "interrupted-attempt",
          phase: "begin",
          seq: 1,
          rung: 1,
          op: "deliver",
          driver: "tmux",
          class: "plain",
          disposition: "attempt-begin",
          effect: "possible",
          tier: "none",
          detail: "pane delivery may begin",
          native_ref: "",
          ts_start: "2026-08-30T12:08:00Z",
          ts_end: null,
        } satisfies AttemptBeginRow]),
      },
      { id: "alice-20260830T120801Z-aabbccddeeff", rows: "future-format-row\n" },
    ];

    for (const item of cases) {
      const request = input(item.id);
      writeFileSync(attemptsPath(item.id), item.rows);
      const ready = readyEffects();
      const notices: string[] = [];
      const before = readFileSync(attemptsPath(item.id), "utf8");

      const result = deliver(request, { pane: ready.fx, notice: (notice) => notices.push(notice) });

      expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure" });
      expect(ready.effects).toEqual([]);
      expect(notices).toEqual(["unconfirmed"]);
      expect(readFileSync(attemptsPath(item.id), "utf8")).toBe(before);
      expect(existsSync(bus.sentPath(item.id))).toBe(false);
    }
  });

  test("a paired unconfirmed possible effect also prevents successor injection", () => {
    const id = "alice-20260830T120850Z-aabbccddeeff";
    const request = input(id);
    let enters = 0;
    const swallowed: PaneEffects = {
      ...readyEffects().fx,
      inputHasId: () => true,
      injectText: () => true,
      pressEnter: () => { enters++; return true; },
    };
    const first = deliver(request, { pane: swallowed });
    expect(first).toMatchObject({ action: "unconfirmed", effect: "possible" });
    expect(enters).toBe(1);
    const before = readFileSync(attemptsPath(id), "utf8");

    const successor = readyEffects();
    const second = deliver(request, { pane: successor.fx });

    expect(second).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure" });
    expect(successor.effects).toEqual([]);
    expect(readFileSync(attemptsPath(id), "utf8")).toBe(before);
  });

  test("kill after begin leaves evidence that blocks a successor retry", async () => {
    const id = "alice-20260830T120900Z-aabbccddeeff";
    const request = input(id);
    const marker = join(root, "injected");
    const lockDir = join(root, "locks");
    const modulePath = join(import.meta.dir, "..", "src", "deliver.ts");
    const previousLockDir = process.env.TAP_LOCK_DIR;
    process.env.TAP_LOCK_DIR = lockDir;

    const childSource = `
      import { writeFileSync } from "node:fs";
      import { Bus } from ${JSON.stringify(join(import.meta.dir, "..", "src", "bus.ts"))};
      import { deliver } from ${JSON.stringify(modulePath)};
      const bus = new Bus(${JSON.stringify(bus.home)});
      deliver({
        bus,
        id: ${JSON.stringify(id)},
        pane: "team/bob:0.0",
        sentinel: ${JSON.stringify(request.sentinel)},
        bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" },
        from: "alice", to: "bob", kind: "discuss", via: "owner",
      }, { pane: {
        observePane: () => ({ paneId: "%7", session: "team/bob", serverEpoch: "srv:1:2", panePid: "1", currentCommand: "claude" }),
        paneCurrentCommand: () => "claude",
        paneState: () => ({ state: "ready" }),
        injectText: () => { writeFileSync(${JSON.stringify(marker)}, "injected\\n"); Bun.sleepSync(30000); return true; },
        inputHasId: () => true,
        pressEnter: () => true,
        settle: () => {},
      }});
    `;

    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      child = Bun.spawn([process.execPath, "-e", childSource], {
        env: { ...process.env, TAP_LOCK_DIR: lockDir },
        stdout: "ignore",
        stderr: "ignore",
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) Bun.sleepSync(10);
      expect(existsSync(marker)).toBe(true);
      const interrupted = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
      expect(interrupted.unverified?.rows).toHaveLength(1);
      expect(interrupted.unverified?.rows[0]?.phase).toBe("begin");

      child.kill(9);
      await child.exited;
      child = undefined;

      const successor = readyEffects();
      const notices: string[] = [];
      const before = readFileSync(attemptsPath(id), "utf8");
      const result = deliver(request, { pane: successor.fx, notice: (notice) => notices.push(notice) });

      expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure" });
      expect(successor.effects).toEqual([]);
      expect(notices).toEqual(["unconfirmed"]);
      expect(readFileSync(attemptsPath(id), "utf8")).toBe(before);
      expect(existsSync(bus.sentPath(id))).toBe(false);
    } finally {
      if (child) {
        child.kill(9);
        await child.exited;
      }
      if (previousLockDir === undefined) delete process.env.TAP_LOCK_DIR;
      else process.env.TAP_LOCK_DIR = previousLockDir;
    }
  }, 20_000);

  test("U5: a two-line draft is backed up, cleared after begin, and restored after delivery", () => {
    const id = "alice-20260830T121000Z-aabbccddeeff";
    const draft = "first line\nsecond line";
    const state = draftEffects(draft);
    const clearInput = state.fx.clearInput!;
    state.fx.clearInput = (target) => {
      const beforeEffect = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
      expect(beforeEffect.unverified?.rows).toHaveLength(1);
      expect(beforeEffect.unverified?.rows[0]?.phase).toBe("begin");
      return clearInput(target);
    };
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };

    const result = deliver(request, { pane: state.fx });

    expect(result).toMatchObject({ action: "delivered", effect: "possible" });
    // Claude clears one row per C-u; BSpace crosses the newline (tap-ipex2).
    expect(state.effects).toEqual(["clear:%7", "backspace:%7", "clear:%7", "inject:%7", "enter:%7", "restore:%7", "restore:%7"]);
    expect(state.band).toBe(draft);
    const backupDir = join(bus.home, "input-backups");
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    const backupPath = join(backupDir, backups[0]!);
    const backup = readFileSync(backupPath, "utf8");
    expect(backup).toContain("---\nschema_version: 1\n");
    expect(backup).toContain(`handle: bob\npayload_id: ${id}\n`);
    expect(backup).toContain("recovery_policy: clobber\n---\n\n## Backed-up input\n\n");
    expect(backup.split("\n## Backed-up input\n\n", 2)[1]).toBe(`${draft}\n`);
    expect(backup).toMatch(/created_at: \d{8}T\d{6}Z\n/);
    expect(backup).toMatch(/input_hash: [0-9a-f]{64}\n/);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    // The container LF belongs to the backup format, not to the original draft.
    expect(inputBackupBody(backup)).toBe(draft);
    expect(JSON.parse(readFileSync(bus.sentPath(id), "utf8"))).toMatchObject({
      id, delivery: "pane", turn: "unconfirmed",
    });
  });

  test("U5: an already-pending sentinel is submitted once before any clobber", () => {
    const id = "alice-20260830T121100Z-aabbccddeeff";
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };
    const state = draftEffects(request.sentinel);
    const pressEnter = state.fx.pressEnter;
    state.fx.pressEnter = (target) => {
      const beforeEffect = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
      expect(beforeEffect.unverified?.rows[0]?.phase).toBe("begin");
      return pressEnter(target);
    };

    const result = deliver(request, { pane: state.fx });

    expect(result).toMatchObject({ action: "delivered", effect: "possible" });
    expect(state.effects).toEqual(["enter:%7"]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
    expect(JSON.parse(readFileSync(bus.sentPath(id), "utf8"))).toMatchObject({ id, delivery: "pane" });
  });

  test("U5: a different pending sentinel submits before the current one", () => {
    const id = "alice-20260830T121150Z-aabbccddeeff";
    const priorId = "carol-20260830T121149Z-ffeeddccbbaa";
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };
    const state = draftEffects(`[[TAP v=0.22 from=carol to=bob id=${priorId} kind=discuss reply=expected]]`);
    const submitted: string[] = [];
    const pressEnter = state.fx.pressEnter;
    state.fx.pressEnter = (target) => {
      submitted.push(state.band.includes(priorId) ? priorId : id);
      return pressEnter(target);
    };

    const result = deliver(request, { pane: state.fx });

    expect(result.action).toBe("delivered");
    expect(state.effects).toEqual(["enter:%7", "inject:%7", "enter:%7"]);
    expect(submitted).toEqual([priorId, id]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
  });

  test("U5: an ANCHORED sentinel that does not parse is refused, never cleared", () => {
    // The gap the anchor gate closes, and the reason it is gated on the anchored
    // form rather than on a successful parse: this band announces itself as a
    // sentinel and nothing can be read out of it (a truncated marker, pre-0.23
    // bytes the parser rejects, a wrap it could not rejoin). Keying the
    // sentinel-first branch on a parsed id sends exactly these to the draft path,
    // and under `deliver-anyway` that CLOBBERS a real message. A backup makes the
    // loss recoverable; it does not make it acceptable.
    //
    // Contrast the arm below, which is the reason this one is narrow: prose with a
    // sentinel inside it is a human draft and keeps its clobber path.
    const id = "alice-20260830T121185Z-aabbccddeeff";
    const state = draftEffects("[[TAP v0.23 ask truncated");

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "draft" });
    expect(result.detail).toContain("refusing to clear it");
    expect(state.effects).toEqual([]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
  });

  test("tap-zo67f: a scrolled Claude draft above blank rows is refused under deliver-anyway, never cleared", () => {
    // Its hidden rows cannot be backed up: clearing reveals blank rows the clear
    // chain cannot tell apart, and the keys erase lines nobody keeps.
    const id = "alice-20260830T121186Z-aabbccddeeff";
    const state = draftEffects("\n\n\n");
    const blank = state.fx.paneState;
    state.fx.paneState = (...args) => {
      const band = blank(...args);
      return band.state === "busy" ? { ...band, scrolled: true } : band;
    };

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "draft" });
    expect(result.detail).toContain("never cleared");
    expect(state.effects).toEqual([]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
  });

  for (const body of ["", ": id=decoy to=mallory"]) test(`U5: a well-formed v0.23 sentinel is submitted, not treated as a draft${body}`, () => {
    // Without a v0.23 branch in `pendingSentinel` this reparks forever — there is no
    // `id=` key to find — so every Bun-delivered sentinel would stall on the new
    // wire, permanently, and clobber under deliver-anyway.
    const id = "alice-20260830T121190Z-aabbccddeeff";
    const priorId = "carol-20260830T121189Z-ffeeddccbbaa";
    const state = draftEffects(`[[TAP v0.23 ${body ? "note" : "ask"} ${priorId}${body}]]`);
    const submitted: string[] = [];
    const pressEnter = state.fx.pressEnter;
    state.fx.pressEnter = (target) => {
      submitted.push(state.band.includes(priorId) ? priorId : id);
      return pressEnter(target);
    };

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result.action).toBe("delivered");
    expect(submitted).toEqual([priorId, id]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
  });

  for (const tail of ["bogus=1", "id=decoy"]) test(`U5: an unknown token makes a v0.23 sentinel malformed, not tolerable: ${tail}`, () => {
    // The v0.22 wire skipped unknown trailing tokens (CONTRACT:1019) and that
    // tolerance is what this unit retires -- it let a wrong-shaped sentinel look
    // well-formed. The bash parser refuses these; without a tail loop here the
    // tolerance survived at the second site while the docstring claimed twinhood.
    // Refusing lands on the anchor gate, which preserves the band.
    const id = "alice-20260830T121195Z-aabbccddeeff";
    const priorId = "carol-20260830T121194Z-ffeeddccbbaa";
    const state = draftEffects(`[[TAP v0.23 ask ${priorId} ${tail}]]`);

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "draft" });
    expect(result.detail).toContain("refusing to clear it");
    expect(state.effects).toEqual([]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
  });

  test("U5: sentinel-shaped prose is still a draft, not courier mail", () => {
    const id = "alice-20260830T121175Z-aabbccddeeff";
    const prose = `notes before [[TAP v=0.22 from=alice to=bob id=${id} kind=discuss reply=expected]] notes after`;
    const state = draftEffects(prose);

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result.action).toBe("delivered");
    expect(state.effects).toEqual(["clear:%7", "inject:%7", "enter:%7", "restore:%7"]);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(1);
    expect(state.band).toBe(prose);
  });

  test("U5: a pending sentinel for another recipient is neither submitted nor clobbered", () => {
    const id = "alice-20260830T121180Z-aabbccddeeff";
    const priorId = "carol-20260830T121179Z-ffeeddccbbaa";
    const band = `[[TAP v=0.22 from=carol to=mallory id=${priorId} kind=discuss reply=expected]]`;
    const state = draftEffects(band);

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "draft" });
    expect(state.effects).toEqual([]);
    expect(existsSync(join(bus.home, "input-backups"))).toBe(false);
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8"))).pre_begin).toHaveLength(1);
  });

  test("U5: a persistent paste-collapse draft stops unverified instead of injecting", () => {
    const id = "alice-20260830T121200Z-aabbccddeeff";
    const chip = "[Pasted Content 123 chars]";
    const warnings: string[] = [];
    const state = draftEffects(chip, "codex");
    state.fx.clearInput = (target) => { state.effects.push(`clear:${target}`); return true; };
    state.fx.backspace = (target) => { state.effects.push(`backspace:${target}`); return true; };
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };

    const result = deliver(request, { pane: state.fx, warn: (message) => warnings.push(message) });

    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "submit_unverified" });
    expect(state.count("clear")).toBe(8);
    expect(state.count("backspace")).toBe(8);
    expect(state.count("inject")).toBe(0);
    expect(state.count("enter")).toBe(0);
    expect(warnings.some((message) => message.includes("tap draft"))).toBe(true);
    expect(existsSync(bus.sentPath(id))).toBe(false);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(1);
  });

  test("U5: backup failure after begin is possible-effect and takes no pane key", () => {
    const id = "alice-20260830T121300Z-aabbccddeeff";
    writeFileSync(join(bus.home, "input-backups"), "blocks directory creation\n");
    const state = draftEffects("draft");

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure" });
    expect(state.effects).toEqual([]);
    const readout = joinAttemptRows(decodeAttemptRows(readFileSync(attemptsPath(id), "utf8")));
    expect(readout.paired).toHaveLength(1);
    expect(readout.paired[0]?.outcome.disposition).toBe("unconfirmed");
    expect(existsSync(bus.sentPath(id))).toBe(false);
  });

  test("U5: pane loss during C-u is cancel/possible with the backup retained", () => {
    const id = "alice-20260830T121400Z-aabbccddeeff";
    let observations = 0;
    const state = draftEffects("draft");
    state.fx.observePane = () => {
      observations++;
      return observations <= 2 ? livePane() : null;
    };
    state.fx.clearInput = (target) => { state.effects.push(`clear:${target}`); return false; };

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({
      action: "cancel", effect: "possible", cause: "pane_gone",
      receipt_reason: "pane_gone", notice: "failed",
    });
    expect(state.count("inject")).toBe(0);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(bus.cancelPath(id), "utf8"))).toMatchObject({ reason: "pane_gone" });
    expect(existsSync(bus.sentPath(id))).toBe(false);
  });

  test("U5: pane loss after clear but before inject stays possible and blocks a successor", () => {
    const id = "alice-20260830T121425Z-aabbccddeeff";
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };
    let observations = 0;
    const state = draftEffects("draft");
    state.fx.observePane = () => {
      observations++;
      return observations <= 2 ? livePane() : null;
    };

    const result = deliver(request, { pane: state.fx });

    expect(result).toMatchObject({ action: "cancel", effect: "possible", cause: "pane_gone" });
    expect(state.count("inject")).toBe(0);
    const before = readFileSync(attemptsPath(id), "utf8");
    const readout = joinAttemptRows(decodeAttemptRows(before));
    expect(readout.paired).toHaveLength(1);
    expect(readout.paired[0]?.outcome).toMatchObject({ disposition: "cancel", effect: "possible" });

    const successor = readyEffects();
    const second = deliver(request, { pane: successor.fx });
    expect(second).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "mid_pipeline_failure" });
    expect(successor.effects).toEqual([]);
    expect(readFileSync(attemptsPath(id), "utf8")).toBe(before);
  });

  test("U5: identity is re-authorized between C-u and BSpace", () => {
    const id = "alice-20260830T121450Z-aabbccddeeff";
    let observations = 0;
    const state = draftEffects("residue");
    state.fx.observePane = () => {
      observations++;
      return {
        ...livePane(),
        paneId: observations <= 2 ? "%7" : "%99",
      };
    };
    state.fx.clearInput = (target) => { state.effects.push(`clear:${target}`); return true; };

    const result = deliver({ ...input(id), draftDisposition: "deliver-anyway" }, { pane: state.fx });

    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible", cause: "identity_mismatch" });
    expect([state.count("clear"), state.count("backspace"), state.count("inject")]).toEqual([1, 0, 0]);
    expect(existsSync(bus.sentPath(id))).toBe(false);
  });

  test("U5: ordinary persistent residue withholds the sentinel", () => {
    const id = "alice-20260830T121500Z-aabbccddeeff";
    const draft = "ordinary residue";
    const warnings: string[] = [];
    const state = draftEffects(draft);
    state.fx.clearInput = (target) => { state.effects.push(`clear:${target}`); return true; };
    state.fx.backspace = (target) => { state.effects.push(`backspace:${target}`); return true; };

    const result = deliver(
      { ...input(id), draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result).toMatchObject({ action: "unconfirmed", effect: "possible" });
    expect([state.count("clear"), state.count("backspace"), state.count("inject"), state.count("enter")]).toEqual([8, 8, 0, 0]);
    expect(state.band).toBe(draft);
  });

  test("U5: opencode and paste chips remain manual-only", () => {
    const cases = [
      ["alice-20260830T121600Z-aabbccddeeff", "opencode", "short draft"],
      ["alice-20260830T121601Z-aabbccddeeff", "codex", "[Pasted Content 42 chars]"],
    ] as const;
    const warnings: string[] = [];

    for (const [id, paneCommand, draft] of cases) {
      const state = draftEffects(draft, paneCommand);
      const result = deliver(
        { ...input(id), draftDisposition: "deliver-anyway" },
        { pane: state.fx, warn: (message) => warnings.push(message) },
      );
      expect(result.action).toBe("delivered");
      expect(state.count("restore")).toBe(0);
    }

    expect(warnings).toHaveLength(2);
    expect(warnings.every((message) => message.includes("tap draft"))).toBe(true);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(2);
  });

  test("U5: new human input wins the post-submit restore race", () => {
    const id = "alice-20260830T121700Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("saved draft");
    state.fx.pressEnter = (target) => {
      state.effects.push(`enter:${target}`);
      state.band = "new human input";
      return true;
    };

    const result = deliver(
      { ...input(id), draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result.action).toBe("delivered");
    expect(state.count("restore")).toBe(0);
    expect(state.band).toBe("new human input");
    expect(warnings).toEqual(["tap: draft backed up — view + copy with: tap draft"]);
  });

  // tap-x62ob: an accepted harness queue is a submitted wire, so the cleared
  // draft is owed the same guarded restore a verified delivery gets.
  test("U5: a harness-queued outcome restores the cleared draft with one Enter and the queued disposition", () => {
    const id = "alice-20260830T121800Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("short draft");
    state.fx.submitFrame = () => ({ state: "queued", mode: "working", width: "100" });

    const result = deliver(
      { ...input(id), draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result).toMatchObject({ action: "harness-queued", effect: "possible" });
    expect(state.effects).toEqual(["clear:%7", "inject:%7", "enter:%7", "restore:%7"]);
    expect(state.band).toBe("short draft");
    expect(warnings).toEqual([]);
    expect(existsSync(join(bus.home, "receipts", `${id}.harness-queued`))).toBe(true);
    expect(existsSync(bus.sentPath(id))).toBe(false);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(1);
  });

  test("tap-lx4z0: a blank band earns no backup file and is never typed back", () => {
    const id = "alice-20260830T121805Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("  \n \t\n  ", "codex");
    const result = deliver(
      { ...input(id), bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "codex" }, draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result.action).toBe("delivered");
    expect(state.count("restore")).toBe(0);
    expect(state.band).toBe("");
    expect(warnings).toEqual(["tap: input backup holds only whitespace; nothing to restore"]);
    expect(existsSync(join(bus.home, "input-backups")) ? readdirSync(join(bus.home, "input-backups")) : []).toEqual([]);
  });

  test("tap-lx4z0: a real draft with surrounding blanks is typed back byte for byte", () => {
    const id = "alice-20260830T121806Z-aabbccddeeff";
    const warnings: string[] = [];
    const draft = "  real draft  \n  second row ";
    const state = draftEffects(draft, "codex");
    const result = deliver(
      { ...input(id), bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "codex" }, draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result.action).toBe("delivered");
    expect(state.band).toBe(draft);
    expect(warnings).toEqual([]);
  });

  test("U5: new human input wins the restore race after a harness-queued outcome", () => {
    const id = "alice-20260830T121801Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("saved draft");
    state.fx.submitFrame = () => ({ state: "queued", mode: "working", width: "100" });
    state.fx.pressEnter = (target) => {
      state.effects.push(`enter:${target}`);
      state.band = "new human input";
      return true;
    };

    const result = deliver(
      { ...input(id), draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result.action).toBe("harness-queued");
    expect([state.count("restore"), state.count("enter")]).toEqual([0, 1]);
    expect(state.band).toBe("new human input");
    expect(warnings).toEqual(["tap: draft backed up — view + copy with: tap draft"]);
  });

  test("U5: a pane that throws during the queued restore keeps the harness-queued record", () => {
    const id = "alice-20260830T121803Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("short draft");
    state.fx.submitFrame = () => ({ state: "queued", mode: "working", width: "100" });
    state.fx.restoreInput = () => { throw new Error("server unresponsive"); };

    const result = deliver(
      { ...input(id), draftDisposition: "deliver-anyway" },
      { pane: state.fx, warn: (message) => warnings.push(message) },
    );

    expect(result).toMatchObject({ action: "harness-queued", effect: "possible" });
    expect(state.count("enter")).toBe(1);
    expect(warnings).toEqual(["tap: draft backed up — view + copy with: tap draft"]);
    expect(existsSync(join(bus.home, "receipts", `${id}.harness-queued`))).toBe(true);
    expect(readdirSync(join(bus.home, "input-backups"))).toHaveLength(1);
  });

  test("U5: an OpenCode repaint-queued outcome tells the owner where the draft went, without restore or a second Enter", () => {
    const id = "alice-20260830T121802Z-aabbccddeeff";
    const warnings: string[] = [];
    const state = draftEffects("short draft", "opencode");
    const request = { ...input(id), draftDisposition: "deliver-anyway" as const };
    request.bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "opencode" };
    let repainted = false;
    // The wire stays painted until the one repaint shows the queue.
    state.fx.pressEnter = (target) => { state.effects.push(`enter:${target}`); return true; };
    state.fx.submitFrame = () => ({ state: repainted ? "queued" : "staged", mode: "working", width: "113" });
    state.fx.repaint = () => { repainted = true; return { ok: true, attempted: true, before: "stale", after: "repainted", reason: "observed" }; };

    const result = deliver(request, { pane: state.fx, warn: (message) => warnings.push(message) });

    expect(result).toMatchObject({ action: "harness-queued", effect: "possible" });
    expect([state.count("restore"), state.count("enter")]).toEqual([0, 1]);
    expect(warnings).toEqual(["tap: draft backed up — view + copy with: tap draft"]);
    expect(existsSync(join(bus.home, "receipts", `${id}.harness-queued`))).toBe(true);
  });
});

test('accepted harness queue keeps canonical, retires retry, and emits no notice or sent',()=>{
 const item=input('queued-owned');
 writeFileSync(bus.payloadPath(item.id),'---\nid: queued-owned\nfrom: alice\nto: bob\nreply: expected\n---\nbody\n');
 const {fx,effects}=readyEffects(); const notices:string[]=[];
 fx.submitFrame=()=>({state:'queued',mode:'working',width:'80'});
 const result=deliver(item,{pane:fx,notice:kind=>notices.push(kind)});
 expect(result.action).toBe('harness-queued');
 expect(existsSync(bus.sentPath(item.id))).toBe(false);
 expect(existsSync(join(bus.home,'receipts',`${item.id}.harness-queued`))).toBe(true);
 expect(notices).toEqual([]);
 const queuedPath=join(bus.home,'receipts',`${item.id}.harness-queued`); const queuedBefore=readFileSync(queuedPath,'utf8');
 const before=[...effects]; expect(deliver(item,{pane:fx,notice:kind=>notices.push(kind)}).action).toBe('harness-queued');
 expect(effects).toEqual(before); expect(notices).toEqual([]); expect(readFileSync(queuedPath,'utf8')).toBe(queuedBefore);
 expect(readFileSync(join(bus.home,'receipts',`${item.id}.submit-phases.jsonl`),'utf8')).toContain('"result":"queued"');
});

test('queued phase telemetry failure cannot change accepted delivery result',()=>{
 const item=input('queued-phase-failure'); const {fx,effects}=readyEffects();
 fx.submitFrame=()=>({state:'queued',mode:'working',width:'80'});
 mkdirSync(join(bus.home,'receipts',`${item.id}.submit-phases.jsonl`));
 expect(deliver(item,{pane:fx}).action).toBe('harness-queued');
 expect(effects.filter(effect=>effect.startsWith('enter:'))).toHaveLength(1);
 expect(existsSync(bus.sentPath(item.id))).toBe(false);
});

test("invalid injection behavior refuses before attempt evidence or pane effects", () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  mkdirSync(join(root, "config/tap"), { recursive: true });
  writeFileSync(join(root, "config/tap/config.toml"), '[injection]\nbehavior="typo"\n');
  try {
    const state = readyEffects(); const request = input("bad-config");
    const result = deliver({ ...request, draftDisposition: "deliver-anyway" }, { pane: state.fx });
    expect(result).toMatchObject({ action: "repark", effect: "none", cause: "config" });
    expect(result.detail).toContain("clobber or wait");
    expect(state.effects).toEqual([]); expect(existsSync(attemptsPath(request.id))).toBe(false);
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

describe("clobberBand: the shared backup-then-clear door", () => {
  const SENTINEL = "[[TAP v0.23 note peer-20260918T120000Z-aabbccddeeff]]";

  function doorFx(initialBand: string) {
    let band = initialBand;
    const effects: string[] = [];
    const record = (effect: string) => effects.push(effect);
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => band ? { state: "busy", text: band } : { state: "ready" },
      clearInput: () => { record("clear"); band = ""; return true; },
      backspace: () => { record("backspace"); return true; },
      injectText: () => { record("inject"); return true; },
      inputHasId: () => true,
      pressEnter: () => { record("enter"); return true; },
      settle: () => {},
    };
    return { fx, effects, get band() { return band; }, set band(value: string) { band = value; } };
  }

  const backupReq = (dir: string) => ({ directory: dir, handle: "bob", payloadId: "payload-1", pane: "team/bob:0.0", paneId: "%7" });

  for (const spelling of ["wait", "warn"]) test(`${spelling} preserves foreign input at the final shared clobber door`, () => {
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    mkdirSync(join(root, "config/tap"), { recursive: true });
    writeFileSync(join(root, "config/tap/config.toml"), `[injection]\nbehavior="${spelling}"\n`);
    try {
      const door = doorFx(`HUMAN${SENTINEL}`);
      const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
      expect(verdict.kind).toBe("preserved"); expect(door.effects).toEqual([]);
      expect(door.band).toBe(`HUMAN${SENTINEL}`);
    } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
  });

  test("backs up only the foreign bytes and then clears", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    const dir = join(root, "input-backups");
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(dir), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    expect(verdict.backupPath).toBeTruthy();
    expect(verdict.lines).toBe(1);
    expect(verdict.chip).toBe(false);
    const body = readFileSync(verdict.backupPath!, "utf8");
    expect(body).toContain("recovery_policy: clobber");
    expect(body.endsWith("## Backed-up input\n\nBUG\n")).toBe(true);
    expect(body).not.toContain("TAP v0.23");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("");
  });

  test("visual wrapping inside our wire is not retained as foreign input", () => {
    const wrapped = SENTINEL.replace(" note ", "\n  note ");
    const door = doorFx(`BUG${wrapped}TAIL`);
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    const body = readFileSync(verdict.backupPath!, "utf8");
    expect(body.endsWith("## Backed-up input\n\nBUGTAIL\n")).toBe(true);
    expect(body).not.toContain("TAP v0.23");
  });

  test("a backup failure stops the door before any pane key", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(blocker), SENTINEL);
    expect(verdict.kind).toBe("backup-failed");
    expect(door.effects).toEqual([]);
  });

  test("identity drift during the clear is the identity verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => ({ ...livePane(), paneId: "%9" });
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("identity");
  });

  test("a reused pane id from another server generation is the identity verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => ({ ...livePane(), serverEpoch: "srv:9:9" });
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("identity");
    expect(door.effects).toEqual([]);
  });

  test("pane loss during the clear is the gone verdict", () => {
    const door = doorFx(`BUG${SENTINEL}`);
    door.fx.observePane = () => null;
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("gone");
  });

  test("paste-chip residue is distinct from plain residue and never clears", () => {
    const chip = doorFx("reasoning [Pasted text #1]");
    chip.fx.clearInput = () => { chip.effects.push("clear"); return true; };
    const chipVerdict = clobberBand("%7", "claude", input("payload-1").bound, chip.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(chipVerdict.kind).toBe("chip-residue");
    if (chipVerdict.kind === "chip-residue" || chipVerdict.kind === "residue") expect(chipVerdict.chip).toBe(true);

    const plain = doorFx("half a thought");
    plain.fx.clearInput = () => { plain.effects.push("clear"); return true; };
    const plainVerdict = clobberBand("%7", "claude", input("payload-1").bound, plain.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(plainVerdict.kind).toBe("possible-failure");
    if (plainVerdict.kind === "chip-residue" || plainVerdict.kind === "residue") expect(plainVerdict.chip).toBe(false);
  });

  test("a band that is exactly our wire has nothing foreign to back up", () => {
    const door = doorFx(SENTINEL);
    const verdict = clobberBand("%7", "claude", input("payload-1").bound, door.fx, backupReq(join(root, "input-backups")), SENTINEL);
    expect(verdict.kind).toBe("cleared");
    if (verdict.kind !== "cleared") return;
    expect(verdict.backupPath).toBeUndefined();
    expect(existsSync(join(root, "input-backups"))).toBe(false);
  });
});

describe("clearOwnInjection: a withheld control takes back only its own bytes (tap-arm4w)", () => {
  const WIRE = "/compact keep the gate loop; next report is report-25 [[sv:self-20260923T172121Z-cbe03497]]";
  function ownFx(initialBand: string) {
    let band = initialBand;
    const effects: string[] = [];
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => band ? { state: "busy", text: band } : { state: "ready" },
      clearInput: () => { effects.push("clear"); band = ""; return true; },
      backspace: () => { effects.push("backspace"); return true; },
      injectText: () => { effects.push("inject"); return true; },
      inputHasId: () => true,
      pressEnter: () => { effects.push("enter"); return true; },
      settle: () => {},
    };
    return { fx, effects, get band() { return band; }, setBand: (value: string) => { band = value; } };
  }
  const bound = { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude" };

  test("our bytes exactly, across Claude's visual wrap, are cleared with no Enter", () => {
    const door = ownFx(WIRE.replace(" next ", "\n  next "));
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("cleared");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("");
  });

  test("our bytes plus foreign bytes are left untouched", () => {
    for (const band of [`${WIRE} and my draft`, `draft ${WIRE}`, WIRE.replace("report-25", "report-26")]) {
      const door = ownFx(band);
      expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("foreign");
      expect(door.effects).toEqual([]);
      expect(door.band).toBe(band);
    }
  });

  test("an empty or unreadable band takes no key", () => {
    const empty = ownFx("");
    expect(clearOwnInjection("%7", "claude", bound, empty.fx, "self-1", WIRE)).toBe("absent");
    const blind = ownFx(WIRE);
    blind.fx.paneState = () => ({ state: "unobservable", reason: "feedback panel" });
    expect(clearOwnInjection("%7", "claude", bound, blind.fx, "self-1", WIRE)).toBe("unread");
    expect([...empty.effects, ...blind.effects]).toEqual([]);
  });

  test("a draft typed between keys stops the next C-u (ownership re-read per key)", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => {
      door.effects.push("clear");
      rounds++;
      // The first C-u clears only the last row; the human then types a draft.
      door.setBand(rounds === 1 ? "/compact keep the gate loop; my draft" : "");
      return true;
    };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("residue");
    expect(door.effects).toEqual(["clear"]);
    expect(door.band).toBe("/compact keep the gate loop; my draft");
  });

  test("a band that grows between keys stops even when the typed words occur in our command", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => {
      door.effects.push("clear");
      rounds++;
      door.setBand(rounds === 1 ? "/compact keep" : rounds === 2 ? "/compact keep the" : "");
      return true;
    };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("residue");
    expect(door.effects).toEqual(["clear", "clear"]);
    expect(door.band).toBe("/compact keep the");
    // A band that does not shrink after a C-u is not ours to press again either.
    const stuck = ownFx(WIRE);
    stuck.fx.clearInput = () => { stuck.effects.push("clear"); stuck.setBand("/compact keep"); return true; };
    expect(clearOwnInjection("%7", "claude", bound, stuck.fx, "self-1", WIRE)).toBe("residue");
    expect(stuck.effects).toEqual(["clear", "clear"]);
  });

  test("an own remainder after a partial C-u is cleared on the next round", () => {
    const door = ownFx(WIRE);
    let rounds = 0;
    door.fx.clearInput = () => { door.effects.push("clear"); rounds++; door.setBand(rounds === 1 ? "/compact keep the gate loop;" : ""); return true; };
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("cleared");
    expect(door.effects).toEqual(["clear", "clear"]);
  });

  test("a drifted pane generation refuses the clear", () => {
    const door = ownFx(WIRE);
    door.fx.observePane = () => ({ ...livePane(), serverEpoch: "srv:9:9" });
    expect(clearOwnInjection("%7", "claude", bound, door.fx, "self-1", WIRE)).toBe("identity");
    expect(door.effects).toEqual([]);
  });
});

describe("pre-Enter fusion gate: foreign bytes never ride our Enter", () => {
  function fusionFx(firstInjectForeign: string, laterInjectForeign: string) {
    let band = "";
    let injects = 0;
    const effects: string[] = [];
    const fx: PaneEffects = {
      observePane: () => livePane(),
      paneCurrentCommand: () => "claude",
      paneState: () => band ? { state: "busy", text: band } : { state: "ready" },
      injectText: (_target, text) => {
        effects.push("inject");
        injects++;
        band = text + (injects === 1 ? firstInjectForeign : laterInjectForeign);
        return true;
      },
      observeInput: (_target, _command, id) => band.includes(id) ? { state: "present", text: band } : { state: "absent" },
      inputHasId: () => true,
      clearInput: () => { effects.push("clear"); band = ""; return true; },
      backspace: () => { effects.push("backspace"); return true; },
      pressEnter: () => { effects.push("enter"); band = ""; return true; },
      settle: () => {},
    };
    return { fx, effects };
  }

  const backupDir = () => join(bus.home, "input-backups");

  test("first fusion backs up the foreign bytes, clears, re-injects, then Enters", () => {
    const id = "alice-20260918T120000Z-fuse11ddeeff";
    const request = input(id);
    const door = fusionFx("BUG", "");
    const result = deliver(request, { pane: door.fx });
    expect(result.action).toBe("delivered");
    expect(door.effects).toEqual(["inject", "clear", "inject", "enter"]);
    expect(door.effects.indexOf("enter")).toBeGreaterThan(door.effects.indexOf("clear"));
    const backups = readdirSync(backupDir());
    expect(backups).toHaveLength(1);
    const body = readFileSync(join(backupDir(), backups[0]!), "utf8");
    expect(body.endsWith("## Backed-up input\n\nBUG\n")).toBe(true);
    expect(body).not.toContain("TAP v0.22");
  });

  test("a second fusion stops unverified with the backup retained", () => {
    const id = "alice-20260918T120000Z-fuse22ddeeff";
    const request = input(id);
    const door = fusionFx("BUG", "MORE");
    const result = deliver(request, { pane: door.fx });
    expect(result.action).toBe("unconfirmed");
    if (result.action === "unconfirmed") {
      expect(result.cause).toBe("submit_unverified");
      expect(result.detail).toContain("fused");
    }
    expect(door.effects).toEqual(["inject", "clear", "inject"]);
    expect(door.effects).not.toContain("enter");
    expect(readdirSync(backupDir())).toHaveLength(1);
  });
});
