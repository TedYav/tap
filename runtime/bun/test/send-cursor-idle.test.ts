// tap_serial_triggers "runtime/bun/test/support/send-reply-flip-fixture.ts" "runtime/bun/test/support/native-send-entry.ts" "runtime/bun/main.ts"
// send-cursor-idle — the native Cursor band-gate controls from plan
// 2026-09-18-b8qp5 (unit 3). The idle band opens the gate and the landing
// stays unverified against a fake whose post-submit frame lacks Cursor box
// geometry; the typed band parks through the ordinary spool without
// injecting. Exit codes here are the courier verb's contract.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_SEND, teamFixture, assertParked, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

function cursorSeat() {
  return {
    ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "cursor-agent" },
  };
}

function send(fx: ReturnType<typeof teamFixture>, args: string[]) {
  return Bun.spawnSync([process.execPath, NATIVE_SEND, ...args], {
    cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe",
  });
}

describe("native Cursor band gate (live route)", () => {
  test("idle Cursor: the band gate opens, the sentinel is injected literally, and the landing stays unverified (exit 5)", () => {
    const fx = teamFixture({ command: "cursor-agent", cursorIdle: "escaped", seats: cursorSeat() });
    const id = "ua-20260918T010000Z-aabbccddeeff";
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--ask", "--id", id]);
    expect(r.exitCode).toBe(5);
    const keys = readFileSync(fx.env.FAKE_ALL_KEYS as string, "utf8");
    expect(keys).toContain(id);
    expect(keys).toContain(" -l -- ");
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
  });

  test("idle Cursor served plain chrome behaves identically (exit 5)", () => {
    const fx = teamFixture({ command: "cursor-agent", cursorIdle: "plain", seats: cursorSeat() });
    const id = "ua-20260918T010200Z-aabbccddeeff";
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--ask", "--id", id]);
    expect(r.exitCode).toBe(5);
    const keys = readFileSync(fx.env.FAKE_ALL_KEYS as string, "utf8");
    expect(keys).toContain(id);
    expect(keys).toContain(" -l -- ");
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
  });

  test("typed Cursor: ordinary send parks for redelivery without injecting (exit 0)", () => {
    const fx = teamFixture({ command: "cursor-agent", seats: cursorSeat() });
    const typed = join(fx.root, "cursor-typed.frame");
    writeFileSync(typed, " → ship the release notes");
    fx.env.FAKE_RAW_CAPTURE = typed;
    const id = "ua-20260918T010100Z-aabbccddeeff";
    const r = send(fx, ["ub", "-m", "hello", "--from", "ua", "--ask", "--id", id]);
    expect(r.exitCode).toBe(0);
    assertParked(fx, id, "pending-input");
    const keysPath = fx.env.FAKE_ALL_KEYS as string;
    const keys = existsSync(keysPath) ? readFileSync(keysPath, "utf8") : "";
    expect(keys).not.toContain(" -l -- ");
  });
});
