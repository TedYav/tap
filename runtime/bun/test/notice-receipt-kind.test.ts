// Rule 38 controls for notice.ts's two settlement questions: the repo asks whether a
// RECEIPT exists with `[ -f ]` (`tap_is_done`, lib.sh:1779), so a DIRECTORY at
// `receipts/<id>.done` is not a settlement. Reading it as one suppressed a
// delivery-failure notice for a message nobody settled .
//
// Both sites live behind `import.meta.main`, so both controls drive the real CLI.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/notice.ts");
const roots: string[] = [];
const scratch = (): string => {
  const r = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "notice-kind-"));
  roots.push(r);
  return r;
};
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function run(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

test("a DIRECTORY at <member>.done does not settle the member: the digest still groups it", () => {
  const root = scratch();
  const payloads = join(root, "payloads"), receipts = join(root, "receipts");
  mkdirSync(payloads, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  const id = "alice-20260916T000000Z-aabbccddeeff";
  writeFileSync(join(payloads, `${id}.md`), `---\nid: ${id}\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\npath: ${join(payloads, `${id}.md`)}\n---\nbody\n`);
  // The control: an entry that is not a regular file at the settlement path.
  mkdirSync(join(receipts, `${id}.done`));
  const grouped = run(["digest-groups", payloads, receipts, id]);
  expect(grouped.code).toBe(0);
  expect(grouped.out).toContain("alice");
  // The positive control: a real receipt DOES settle it, so the arm is not vacuous.
  rmSync(join(receipts, `${id}.done`), { recursive: true });
  writeFileSync(join(receipts, `${id}.done`), "{}\n");
  expect(run(["digest-groups", payloads, receipts, id]).out).toBe("");
});

test("a DIRECTORY at <id>.done does not make an outcome terminal: the notice is not skipped", () => {
  const root = scratch();
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { recursive: true });
  const done = join(receipts, "m1.done"), sent = join(receipts, "m1.sent");
  mkdirSync(done);
  // `unconfirmed` with nothing settled is a notice; with a settlement it is `skip`.
  expect(run(["possible", done, sent]).out).toBe("unconfirmed");
  rmSync(done, { recursive: true });
  writeFileSync(done, "{}\n");
  expect(run(["possible", done, sent]).out).toBe("skip");
  // The same for the delivered half of the pair.
  rmSync(done);
  mkdirSync(sent);
  expect(run(["possible", done, sent]).out).toBe("unconfirmed");
  rmSync(sent, { recursive: true });
  writeFileSync(sent, "{}\n");
  expect(run(["possible", done, sent]).out).toBe("skip");
});

// The third rule-38 row in this file (census F2, `payloads/<id>.md`): the recursion guard
// asked `[ -f "$(tap_payload_path)" ]` in the incumbent (lib.sh:2603, 2646, 3062, 4134).
//
// THIS ARM DOES NOT DISCRIMINATE THE OPERATORS, and saying so is the point. A directory at
// the canonical path already fell through under `existsSync`, because `readFileSync` raises
// EISDIR into the guard's own catch — so it passes identically before and after the swap,
// and a mutant back to `existsSync` SURVIVES it. It is here because the census asked the
// question and the answer is worth pinning either way: a directory never suppresses a
// sender's notice. The entry the two operators genuinely answer differently is one whose
// read does not return, which is not a fixture this suite should build.
import { sendNotice } from "../src/notice";
import type { CourierIntent } from "../src/courier-contract";

const intent = (id: string): CourierIntent => ({
  v: 1, id, from: "alice", to: "peer", to_team: "t", target_registry: "/bus/registry.json",
  pane: "s:0.0", pane_id: "%1", server_epoch: "srv:1:1", harness: "codex", policy: "standard",
  reason: "busy", first_parked_epoch: 0, deadline_epoch: null, hold_until_epoch: null,
  disposition_at_deadline: "notify-and-hold", busy_pending_probes: 0, escalated_at: null, excluded: false,
});

test("a DIRECTORY at the canonical payload is not a delivery-failed recursion guard", () => {
  const root = scratch();
  const payloads = join(root, "payloads");
  mkdirSync(payloads, { recursive: true });
  const id = "n1-20260916T000000Z-aabbccddeeff";
  mkdirSync(join(payloads, `${id}.md`));
  const minted = sendNotice({
    payloadsDir: payloads, intent: intent(id), mode: "failed", detail: "d", team: "t",
    senderPresent: () => true,
  });
  expect(minted.notice_id).not.toBeNull();
  // The positive control: a REAL delivery-failed canonical DOES suppress the second notice,
  // so the assertion above is about the entry kind rather than about a guard that never fires.
  rmSync(join(payloads, `${id}.md`), { recursive: true });
  writeFileSync(join(payloads, `${id}.md`), `---\nid: ${id}\nfrom: alice\nto: peer\nkind: delivery-failed\n---\nbody\n`);
  expect(sendNotice({
    payloadsDir: payloads, intent: intent(id), mode: "failed", detail: "d", team: "t",
    senderPresent: () => true,
  }).notice_id).toBeNull();
});
