import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOperatorMail } from "../src/recovery/operator-mail";
import type { OperatorBinding } from "../src/recovery/operator-admission";

const root = mkdtempSync(join(tmpdir(), "tap-operator-mail-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const binding: OperatorBinding = { team: "target-team", handle: "target", registry: join(root, "registry.json"),
  pane: "seat:0.0", paneId: "%2", session: "seat", instance: "instance", harness: "codex",
  processPid: "123", serverSocket: "/tmp/socket", serverEpoch: "epoch" };
writeFileSync(binding.registry, '{}');
let n = 0;
function fixture(metaPatch: Record<string, unknown> = {}, headerPatch = "") {
  const home = join(root, String(n++)), id = 'sender-20261028T010000Z-123456789abc';
  for (const dir of ["spool", "receipts", "payloads", "archive"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, "spool", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: target\nteam: sender-team\nto_team: target-team\nrecipient_instance: ${headerPatch || "instance"}\n---\nTask body must not enter the operator evidence.\n`);
  const meta = { id, target: "target", team: "sender-team", reason: "busy:modal", reason_class: "busy",
    timeout_seconds: 1200, attempts: 0, attempt_fence: 1, first_spooled: "2026-10-28T00:00:00Z",
    first_spooled_epoch: 1000, pane: "seat:0.0", pane_id: "%2", to_team: "target-team",
    target_registry: binding.registry, policy: "standard", deadline_epoch: 2200, hold_until_epoch: 1000,
    waiter_lifetime: "readiness-gate", ...metaPatch };
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify(meta));
  return { home, id, team: "sender-team" };
}
test("a cross-team spool item qualifies only with exact routing, current instance and no-effect proof", () => {
  const ref = fixture();
  expect(readOperatorMail([ref], binding)).toEqual([{ id: ref.id, home: ref.home, instance: "instance",
    firstSpooled: 1_000_000, disposition: "undelivered", valid: true }]);
});
test("old, missing or foreign routing and metadata never qualify", () => {
  for (const patch of [{ target_registry: "/not-this-registry" }, { pane_id: "%3" }, { to_team: "foreign" },
    { first_spooled_epoch: null }, { first_spooled_epoch: "yesterday" }, { attempt_fence: 0 }, { attempts: 1 }]) {
    const item = readOperatorMail([fixture(patch)], binding)[0]!;
    expect(item.valid && item.disposition === "undelivered", JSON.stringify(patch)).toBe(false);
  }
  expect(readOperatorMail([fixture({}, "old-instance")], binding)[0]!.valid).toBe(false);
});
test("all existing possible-effect and terminal markers prevent claiming undelivered mail", () => {
  for (const suffix of ["attempted", "unconfirmed", "sent", "read", "done", "cancelled", "harness-queued", "attempts"]) {
    const ref = fixture();
    writeFileSync(join(ref.home, "receipts", `${ref.id}.${suffix}`), 'unreadable evidence still holds');
    expect(readOperatorMail([ref], binding)[0]!.disposition, suffix).not.toBe("undelivered");
  }
});
