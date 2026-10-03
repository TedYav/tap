// Authority-bearing reads in the native SessionStart entry refuse malformed
// input the way the Python hook they replaced did.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryDoc, seatForPane } from "../src/session-start";

const row = (pane_id: unknown) => ({ seats: { ada: { status: "active", pane_id, server_epoch: "srv:1:2" } } });

test("a registry with malformed UTF-8 is no authority, not a U+FFFD match", () => {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR || "/tmp", "session-start-"));
  try {
    const path = join(dir, "team-registry.json");
    const good = Buffer.from(JSON.stringify(row("%1")));
    writeFileSync(path, good);
    expect(seatForPane(registryDoc(path), "%1", "srv:1:2", "", "")).toBe("ada");
    // Invalid UTF-8 inside an otherwise parseable JSON string.
    writeFileSync(path, Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('",'), good.subarray(1)]));
    expect(registryDoc(path)).toBeNull();
    expect(seatForPane(registryDoc(path), "%1", "srv:1:2", "", "")).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// tap-a75kk: under `tap session launch` the launcher clears `launching` only
// after the SessionStart bind lands, so the hook always reads a launching row.
// The hook passes the session id only when this fire's bind succeeded; "" otherwise.
test("a launching row is registered only for the start whose bound session it carries", () => {
  const seat = (extra: object) => ({ seats: { ada: { status: "active", pane_id: "%1", server_epoch: "srv:1:2", harness_session_id: "s-1", ...extra } } });
  const launching = seat({ status_reason: "launching", launch_id: "t" });
  expect(seatForPane(launching, "%1", "srv:1:2", "", "", "s-1")).toBe("ada");
  // A leftover placeholder (another start's session) or a failed bind ("").
  expect(seatForPane(launching, "%1", "srv:1:2", "", "", "s-other")).toBe("");
  expect(seatForPane(launching, "%1", "srv:1:2", "", "", "")).toBe("");
  expect(seatForPane(seat({ status_reason: "launching", harness_session_id: undefined }), "%1", "srv:1:2", "", "", "s-1")).toBe("");
  expect(seatForPane(launching, "%2", "srv:1:2", "", "", "s-1")).toBe("");
  expect(seatForPane(launching, "%1", "srv:9:9", "", "", "s-1")).toBe("");
  expect(seatForPane(seat({ status: "pending" }), "%1", "srv:1:2", "", "", "s-1")).toBe("");
});

test("an unstamped row never names the pane's seat (tap-zk1w)", () => {
  const unstamped = { seats: { ada: { status: "active", pane_id: "%1" } } };
  expect(seatForPane(unstamped, "%1", "srv:1:2", "", "")).toBe("");
  expect(seatForPane({ seats: { ada: { status: "active", pane_id: "%1", server_epoch: "" } } }, "%1", "srv:1:2", "", "")).toBe("");
});

test("only a string pane_id can match the observed pane", () => {
  expect(seatForPane(row("%1"), "%1", "srv:1:2", "", "")).toBe("ada");
  for (const malformed of [["%1"], { id: "%1" }, 1, true, ""]) {
    expect(seatForPane(row(malformed), "%1", "srv:1:2", "", "")).toBe("");
  }
});
