import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInputBackup } from "../src/pane/draft";
import { recoverDraft } from "../src/verbs/draft";

const dir = mkdtempSync(join(tmpdir(), "draft-verb-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const [id, handle, created, body] of [["old", "alice", "20260101", "  old\ntext\n"], ["new", "alice", "20260918", "new body"], ["other", "bob", "20260919", "other seat draft"]]) {
  writeFileSync(join(dir, `${id}.md`), `---\nschema_version: 1\nhandle: ${handle}\ncreated_at: ${created}\npayload_id: ${id}\n---\n\n## Backed-up input\n\n${body}\n`);
}
function io(tty = false, answer = "") {
  const result = { stdout: "", stderr: "", copied: "", prompts: 0 };
  return { result, tty, out: (s: string) => { result.stdout += s; }, err: (s: string) => { result.stderr += s; },
    ask: async () => { result.prompts++; return answer; }, copy: (s: string) => { result.copied = s; return true; } };
}
test("TTY lists team drafts with previews and copies selected bytes", async () => {
  const a = io(true, "3"); await recoverDraft(["list"], dir, a);
  expect(a.result.stderr).toContain("1. 20260919  bob  other\n   other seat draft");
  expect(a.result.stderr).toContain("2. 20260918  alice  new");
  expect(a.result.copied).toBe("  old\ntext\n");
  expect(a.result.stdout).toBe("  old\ntext\n");
});
test("noninteractive list and --list show team index without clipboard effects", async () => {
  for (const args of [["list"], ["--list"]]) {
    const a = io(); await recoverDraft(args, dir, a);
    expect(a.result.stdout).toContain("bob"); expect(a.result.stdout).toContain("alice");
    expect(a.result.copied).toBe(""); expect(a.result.prompts).toBe(0);
  }
});
test("explicit backup from another seat copies without prompting", async () => {
  const a = io(true); await recoverDraft(["other"], dir, a);
  expect(a.result.stdout).toBe("other seat draft"); expect(a.result.copied).toBe("other seat draft"); expect(a.result.prompts).toBe(0);
});
test("cancel, invalid selections and invalid arguments never copy", async () => {
  for (const answer of ["", "q", "999", "1junk"]) {
    const a = io(true, answer); await recoverDraft(["list"], dir, a); expect(a.result.copied).toBe("");
  }
  for (const args of [["missing"], ["--list", "old"], ["../old"], ["--bad"]]) {
    const a = io(); await expect(recoverDraft(args, dir, a)).rejects.toThrow(); expect(a.result.copied).toBe("");
  }
});

test("incomplete paste and image snapshots never overwrite the clipboard", async () => {
  const incompleteDir = mkdtempSync(join(dir, "incomplete-"));
  for (const [id, text] of [["paste", "before [Pasted text #1 +5 lines] after"], ["image", "look at [Image #1]"]]) {
    writeInputBackup({ directory: incompleteDir, handle: "bob", payloadId: id!, pane: "%1", paneId: "%1", paneCommand: "claude", inputHash: "hash", recoveryPolicy: "clobber", text: text! });
    const a = io(); expect(await recoverDraft([id!], incompleteDir, a)).toBe(2);
    expect(a.result.copied).toBe(""); expect(a.result.stderr).toContain("clipboard unchanged");
  }
});

test("one truncated backup cannot block listing or recovery of another draft", async () => {
  const mixed = mkdtempSync(join(dir, "mixed-"));
  writeFileSync(join(mixed, "bad.md"), "---\nschema_version: 1\nhandle: alice\ncreated_at: 99999999\npayload_id: bad\n---\ntruncated body");
  writeFileSync(join(mixed, "good.md"), "---\nschema_version: 1\nhandle: bob\ncreated_at: 20260925\npayload_id: good\n---\n\n## Backed-up input\n\nexact draft\n");
  for (const args of [["--list"], ["good"]]) {
    const a = io(); expect(await recoverDraft(args, mixed, a)).toBe(0);
    expect(a.result.stderr).toContain("skipping unreadable or invalid backup bad.md");
    expect(a.result.stdout).toContain("exact draft");
    expect(a.result.copied).toBe(args[0] === "good" ? "exact draft" : "");
  }
});

test("bare draft copies and prints the newest team backup without prompting", async () => {
  for (const tty of [false, true]) {
    const a = io(tty);
    expect(await recoverDraft([], dir, a)).toBe(0);
    expect(a.result.stdout).toBe("other seat draft");
    expect(a.result.copied).toBe("other seat draft");
    expect(a.result.prompts).toBe(0);
  }
});

test("list defaults to five, accepts -n, and indents every text line", async () => {
  const many = mkdtempSync(join(dir, "many-"));
  for (let n = 1; n <= 7; n++) {
    writeFileSync(join(many, `d${n}.md`), `---\nschema_version: 1\nhandle: alice\ncreated_at: 2026010${n}\npayload_id: d${n}\n---\n\n## Backed-up input\n\nfirst ${n}\nsecond ${n}\n`);
  }
  for (const [args, count] of [[["list"], 5], [["list", "-n", "2"], 2], [["--list", "-n", "7"], 7]] as const) {
    const a = io();
    await recoverDraft([...args], many, a);
    expect(a.result.stdout.match(/^\d+\. /gm)?.length).toBe(count);
    expect(a.result.stdout).toContain("   first 7\n   second 7\n");
    expect(a.result.copied).toBe("");
  }
  const a = io(true, "3");
  expect(await recoverDraft(["list", "-n", "2"], many, a)).toBe(1);
  expect(a.result.copied).toBe("");
});

test("invalid counts and counts outside list refuse before copying", async () => {
  for (const args of [["list", "-n"], ["list", "-n", "0"], ["list", "-n", "-1"], ["list", "-n", "1.5"], ["list", "-n", "2x"], ["list", "-n", "9007199254740992"], ["-n", "2"], ["other", "-n", "2"], ["list", "other"]]) {
    const a = io();
    await expect(recoverDraft(args, dir, a)).rejects.toThrow();
    expect(a.result.copied).toBe("");
  }
});

test("bare draft preserves incomplete snapshot guard and clipboard fallback", async () => {
  const incomplete = mkdtempSync(join(dir, "default-incomplete-"));
  writeInputBackup({ directory: incomplete, handle: "bob", payloadId: "paste", pane: "%1", paneId: "%1", paneCommand: "claude", inputHash: "hash", recoveryPolicy: "clobber", text: "[Image #1]" });
  const a = io();
  expect(await recoverDraft([], incomplete, a)).toBe(2);
  expect(a.result.copied).toBe("");
  expect(a.result.stdout).toContain("[Image #1]");
  const b = io();
  b.copy = () => false;
  expect(await recoverDraft([], dir, b)).toBe(0);
  expect(b.result.stdout).toBe("other seat draft");
  expect(b.result.stderr).toContain("clipboard unavailable");
});
