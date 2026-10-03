import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePathLock } from "../src/panelock";
import { beginDeliveryAttempt, beginDeliveryAttempts } from "../src/delivery-attempt";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const home = () => { const root = mkdtempSync(join(tmpdir(), "tap-attempt-")); roots.push(root); return root; };

describe("delivery attempt evidence", () => {
  test("publishes complete no-clobber evidence and preserves the first writer", () => {
    const root = home();
    expect(beginDeliveryAttempt(root, "msg-1")).toBe("created");
    const path = join(root, "receipts/msg-1.attempted");
    expect(readFileSync(path, "utf8")).toBe('{"id":"msg-1","effect":"possible"}\n');
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(beginDeliveryAttempt(root, "msg-1")).toBe("existing");
    expect(readFileSync(path, "utf8")).toBe('{"id":"msg-1","effect":"possible"}\n');
  });

  test("a dangling destination is prior conservative evidence", () => {
    const root = home();
    const receipts = join(root, "receipts");
    beginDeliveryAttempt(root, "seed");
    symlinkSync(join(root, "absent"), join(receipts, "msg-2.attempted"));
    expect(beginDeliveryAttempt(root, "msg-2")).toBe("existing");
  });

  test("invalid ids are refused before publication", () => {
    expect(() => beginDeliveryAttempt(home(), "bad/id")).toThrow("valid id");
  });
});

test("batch admission validates every id and treats dangling later evidence as prior custody", () => {
  const root = home();
  for (const ids of [[], ["first", "bad/id"], ["first", "first"]]) {
    expect(() => beginDeliveryAttempts(root, ids)).toThrow();
    expect(existsSync(join(root, "receipts/first.attempted"))).toBe(false);
  }
  beginDeliveryAttempt(root, "seed");
  symlinkSync(join(root, "absent"), join(root, "receipts/last.attempted"));
  expect(beginDeliveryAttempts(root, ["first", "last"])).toBe("existing");
  expect(existsSync(join(root, "receipts/first.attempted"))).toBe(false);
  expect(beginDeliveryAttempts(root, ["first", "second"])).toBe("created");
  for (const id of ["first", "second"]) expect(JSON.parse(readFileSync(join(root, "receipts", `${id}.attempted`), "utf8")))
    .toEqual({ id, effect: "possible" });
});

test("native attempt mint refuses a reset fence and releases custody after a failed write", () => {
  const root = home(), fence = join(root, "reset.fence.json"), sidecar = fence + ".lock";
  writeFileSync(fence, "{}");
  expect(() => beginDeliveryAttempt(root, "fenced")).toThrow();
  expect(existsSync(join(root, "receipts/fenced.attempted"))).toBe(false);
  rmSync(fence);
  writeFileSync(join(root, "receipts"), "not a directory");
  expect(() => beginDeliveryAttempt(root, "io-error")).toThrow();
  const held = acquirePathLock(sidecar, 0);
  try { expect(held).not.toBeNull(); } finally { held?.release(); }
});

test("native attempt mint cannot write while reset custody is held", () => {
  const root = home(), held = acquirePathLock(join(root, "reset.fence.json.lock"), 0)!;
  try {
    expect(held).not.toBeNull();
    expect(() => beginDeliveryAttempt(root, "busy")).toThrow("reset mutation custody");
    expect(existsSync(join(root, "receipts/busy.attempted"))).toBe(false);
  } finally { held.release(); }
  expect(beginDeliveryAttempt(root, "busy")).toBe("created");
});
