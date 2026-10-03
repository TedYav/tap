import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spoolBacklog, spoolBacklogs } from "../src/spool-backlog";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "backlog-")); homes.push(home);
  const spool = join(home, "spool"); mkdirSync(spool); mkdirSync(join(home, "receipts"));
  function put(id: string, meta: object, from = "sender") {
    writeFileSync(join(spool, `${id}.md`), `---\nid: ${id}\nfrom: ${from}\nto: peer\n---\nbody\n`);
    writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ target: "peer", ...meta }));
  }
  return { home, spool, put };
}
test("62-second witness stays separate from 16-hour queue age and an older row", () => {
  const { spool, put } = fixture();
  put("older", { first_spooled_epoch: 900, busy_pending_probes: 1, last_busy_probe_at: 901 });
  put("witness", { first_spooled_epoch: 1000, busy_pending_probes: 20, last_busy_probe_at: 1062 });
  const r = spoolBacklog(spool, "peer", "sender", 58500);
  expect(r.condition).toBe(true); expect(r.age_seconds).toBe(57600);
  expect(r.witness_id).toBe("witness"); expect(r.parking_to_last_busy_seconds).toBe(62);
  expect(r.line).toContain("queue age 16h00m"); expect(r.line).toContain("span 1m02s");
  expect(r.line + r.remedy).not.toMatch(/wedged|nudge|send-keys|Enter/);
});
test("30-hour age supplies no missing or inconsistent probe interval", () => {
  const { spool, put } = fixture(); put("old", { first_spooled_epoch: 1000, busy_pending_probes: 39 });
  put("other", { first_spooled_epoch: 1010, busy_pending_probes: 2, last_busy_probe_at: 1050 });
  expect(spoolBacklog(spool, "peer", "", 109000).parking_to_last_busy_seconds).toBeNull();
  for (const last_busy_probe_at of [999, 109001, "nonsense"]) {
    put("old", { first_spooled_epoch: 1000, busy_pending_probes: 39, last_busy_probe_at });
    expect(spoolBacklog(spool, "peer", "", 109000).parking_to_last_busy_seconds).toBeNull();
  }
});
test("regular settlement, sender and autosettle filters apply to count and witness", () => {
  const { home, spool, put } = fixture();
  put("done", { busy_pending_probes: 99 }); writeFileSync(join(home, "receipts/done.done"), "");
  put("cancel", { busy_pending_probes: 99 }); writeFileSync(join(home, "receipts/cancel.cancelled"), "");
  put("held", { policy: "autosettle", busy_pending_probes: 99 });
  put("foreign", { busy_pending_probes: 99 }, "another");
  put("open", { busy_pending_probes: 1 }); mkdirSync(join(home, "receipts/open.done"));
  const r = spoolBacklog(spool, "peer", "sender", 1000);
  expect(r.ids).toEqual(["open"]); expect(r.busy_pending_probes).toBe(1); expect(r.condition).toBe(false);
  expect(spoolBacklogs(spool, 1000)[0]?.ids.sort()).toEqual(["foreign", "open"]);
});
