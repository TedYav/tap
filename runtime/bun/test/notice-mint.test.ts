import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendNotice } from "../src/notice";

function bus(): { home: string; spoolDir: string; payloadsDir: string; receiptsDir: string } {
  const home = mkdtempSync(join(tmpdir(), "tap-notice-mint."));
  const spoolDir = join(home, "spool");
  const payloadsDir = join(home, "payloads");
  const receiptsDir = join(home, "receipts");
  mkdirSync(spoolDir);
  mkdirSync(payloadsDir);
  mkdirSync(receiptsDir);
  return { home, spoolDir, payloadsDir, receiptsDir };
}

describe("notice minter (KTD7)", () => {
  test("mode is required and places a settle-only courier payload", () => {
    const dirs = bus();
    const intent = {
      v: 1 as const, id: "alice-20260831T000000Z-aaaaaa", from: "alice", to: "peer", to_team: "beta",
      target_registry: "/r", pane: "p", pane_id: "%1", server_epoch: "s", harness: "codex",
      policy: "standard" as const, reason: "busy", first_parked_epoch: 1, deadline_epoch: null,
      hold_until_epoch: null, disposition_at_deadline: "notify-and-cancel" as const,
      busy_pending_probes: 0, escalated_at: null, excluded: false,
    };
    writeFileSync(join(dirs.payloadsDir, `${intent.id}.md`), "---\nid: x\n---\n");
    const injected: string[] = [];
    const result = sendNotice({
      payloadsDir: dirs.payloadsDir, intent, mode: "failed", detail: "deadline",
      team: "beta", inject: (args) => { injected.push(args.mode); return true; },
    });
    expect(result.verified).toBe(true);
    expect(result.sender_gone).toBe(false);
    expect(result.notice_id).toBeTruthy();
    const raw = readFileSync(result.path!, "utf8");
    expect(raw).toContain("kind: delivery-failed");
    expect(raw).toContain("reply: settle-only");
    expect(raw).toContain("from: courier");
    expect(injected).toEqual(["failed"]);
  });

  test("sender_gone writes an event and injects nothing", () => {
    const dirs = bus();
    const intent = {
      v: 1 as const, id: "alice-20260831T000000Z-bbbbbb", from: "alice", to: "peer", to_team: "beta",
      target_registry: "/r", pane: "p", pane_id: "%1", server_epoch: "s", harness: "codex",
      policy: "standard" as const, reason: "busy", first_parked_epoch: 1, deadline_epoch: null,
      hold_until_epoch: null, disposition_at_deadline: "notify-and-cancel" as const,
      busy_pending_probes: 0, escalated_at: null, excluded: false,
    };
    const events: string[] = [];
    const result = sendNotice({
      payloadsDir: dirs.payloadsDir, intent, mode: "sender_gone", detail: "absent",
      team: "beta", inject: () => true, event: (line) => events.push(line),
    });
    expect(result.sender_gone).toBe(true);
    expect(result.notice_id).toBeNull();
    expect(events.some((e) => e.includes("sender_gone"))).toBe(true);
    expect(readdirSync(dirs.payloadsDir).filter((n) => n.includes("courier"))).toHaveLength(0);
  });

  test("body-decoy: kind=discuss whose body quotes kind: delivery-failed still emits a notice", () => {
    const dirs = bus();
    const intent = {
      v: 1 as const, id: "alice-20260831T000000Z-decoy1", from: "alice", to: "peer", to_team: "beta",
      target_registry: "/r", pane: "p", pane_id: "%1", server_epoch: "s", harness: "codex",
      policy: "standard" as const, reason: "busy", first_parked_epoch: 1, deadline_epoch: null,
      hold_until_epoch: null, disposition_at_deadline: "notify-and-cancel" as const,
      busy_pending_probes: 0, escalated_at: null, excluded: false,
    };
    writeFileSync(
      join(dirs.payloadsDir, `${intent.id}.md`),
      `---\nid: ${intent.id}\nfrom: alice\nto: peer\nkind: discuss\npath: ${join(dirs.payloadsDir, `${intent.id}.md`)}\n---\n` +
      `the courier said kind: delivery-failed in the body; that is prose, not envelope kind.\n`,
    );
    const injected: string[] = [];
    const result = sendNotice({
      payloadsDir: dirs.payloadsDir, intent, mode: "failed", detail: "deadline",
      team: "beta", inject: (args) => { injected.push(args.id); return true; },
    });
    expect(result.notice_id).toBeTruthy();
    expect(result.verified).toBe(true);
    expect(injected).toHaveLength(1);
    expect(existsSync(result.path!)).toBe(true);
  });

  test("envelope kind=delivery-failed still suppresses a second notice", () => {
    const dirs = bus();
    const intent = {
      v: 1 as const, id: "courier-20260831T000000Z-cccccc", from: "alice", to: "peer", to_team: "beta",
      target_registry: "/r", pane: "p", pane_id: "%1", server_epoch: "s", harness: "codex",
      policy: "standard" as const, reason: "busy", first_parked_epoch: 1, deadline_epoch: null,
      hold_until_epoch: null, disposition_at_deadline: "notify-and-cancel" as const,
      busy_pending_probes: 0, escalated_at: null, excluded: false,
    };
    writeFileSync(
      join(dirs.payloadsDir, `${intent.id}.md`),
      `---\nid: ${intent.id}\nfrom: courier\nto: alice\nkind: delivery-failed\nreply: settle-only\npath: ${join(dirs.payloadsDir, `${intent.id}.md`)}\n---\nfailed\n`,
    );
    const result = sendNotice({
      payloadsDir: dirs.payloadsDir, intent, mode: "failed", detail: "deadline",
      team: "beta", inject: () => true,
    });
    expect(result.notice_id).toBeNull();
    expect(readdirSync(dirs.payloadsDir).filter((n) => n.startsWith("courier-") && n !== `${intent.id}.md`)).toHaveLength(0);
  });
});
