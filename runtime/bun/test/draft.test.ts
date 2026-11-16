import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInputBackup } from "../src/pane/draft";
import { copyDraft, recoverDraft, type DraftCopy } from "../src/verbs/draft";

const dir = mkdtempSync(join(tmpdir(), "draft-verb-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const [id, handle, created, body] of [["old", "alice", "20260101", "  old\ntext\n"], ["new", "alice", "20260918", "new body"], ["other", "bob", "20260919", "other seat draft"]]) {
  writeFileSync(join(dir, `${id}.md`), `---\nschema_version: 1\nhandle: ${handle}\ncreated_at: ${created}\npayload_id: ${id}\n---\n\n## Backed-up input\n\n${body}\n`);
}
function io(tty = false, answer = "") {
  const result = { stdout: "", stderr: "", copied: "", prompts: 0 };
  return { result, tty, out: (s: string) => { result.stdout += s; }, err: (s: string) => { result.stderr += s; },
    ask: async () => { result.prompts++; return answer; }, copy: (s: string): DraftCopy => { result.copied = s; return { tool: "pbcopy", ok: true }; } };
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
  b.copy = () => ({ tool: "osc52", ok: false });
  expect(await recoverDraft([], dir, b)).toBe(0);
  expect(b.result.stdout).toBe("other seat draft");
  expect(b.result.stderr).toBe("tap draft: clipboard unavailable (no pbcopy, wl-copy or xclip for this session and no terminal for OSC 52); printed draft only\n");
});

test("the receipt names the tool that took the copy, a tool that failed, and an unconfirmable OSC 52 send", async () => {
  const named = io(true);
  named.copy = () => ({ tool: "xclip", ok: true });
  expect(await recoverDraft(["other"], dir, named)).toBe(0);
  expect(named.result.stderr).toBe("tap draft: copied to clipboard with xclip\n");
  const failed = io(true);
  failed.copy = () => ({ tool: "wl-copy", ok: false });
  expect(await recoverDraft(["other"], dir, failed)).toBe(0);
  expect(failed.result.stderr).toBe("tap draft: clipboard unavailable (wl-copy failed); printed draft only\n");
  expect(failed.result.stdout).toBe("other seat draft");
  const sent = io(true);
  sent.copy = () => ({ tool: "osc52", ok: true });
  expect(await recoverDraft(["other"], dir, sent)).toBe(0);
  expect(sent.result.stderr).toBe("tap draft: sent to the terminal clipboard with OSC 52 (no pbcopy, wl-copy or xclip for this session)\n");
});

/** A PATH directory holding empty executables under the given names. */
function toolDir(...names: string[]): string {
  const bin = mkdtempSync(join(dir, "tools-"));
  mkdirSync(bin, { recursive: true });
  for (const name of names) { writeFileSync(join(bin, name), "#!/bin/sh\n"); chmodSync(join(bin, name), 0o755); }
  return bin;
}
function recorder() {
  const calls: { argv: string[]; text: string }[] = [], sequences: string[] = [];
  return { calls, sequences, run: (argv: string[], text: string) => { calls.push({ argv, text }); return true; }, terminal: (sequence: string) => { sequences.push(sequence); } };
}
const OSC52_HELLO = `\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`;

test("off macOS the copy goes to the session's display tool, else to the terminal as OSC 52", () => {
  if (process.platform === "darwin") {
    console.log("SMOKE-SKIP: the display-tool and OSC 52 copy paths are chosen off macOS only; the pbcopy test below covers this platform");
    return;
  }
  const both = toolDir("wl-copy", "xclip");
  const wayland = recorder();
  expect(copyDraft("héllo", { PATH: both, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, wayland.run, wayland.terminal)).toEqual({ tool: "wl-copy", ok: true });
  expect(wayland.calls).toEqual([{ argv: ["wl-copy"], text: "héllo" }]);
  // A forwarded X display in an SSH session is still this command's clipboard.
  const x11 = recorder();
  expect(copyDraft("héllo", { PATH: both, DISPLAY: "localhost:10.0", SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" }, x11.run, x11.terminal)).toEqual({ tool: "xclip", ok: true });
  expect(x11.calls).toEqual([{ argv: ["xclip", "-in", "-selection", "clipboard"], text: "héllo" }]);
  expect(x11.sequences).toEqual([]);
  // A tool without its display is not a clipboard: the terminal takes the copy.
  const headless = recorder();
  expect(copyDraft("héllo", { PATH: both }, headless.run, headless.terminal)).toEqual({ tool: "osc52", ok: true });
  expect(headless.calls).toEqual([]);
  expect(headless.sequences).toEqual([OSC52_HELLO]);
  const piped = recorder();
  expect(copyDraft("héllo", { PATH: toolDir() }, piped.run, null)).toEqual({ tool: "osc52", ok: false });
  expect(piped.calls).toEqual([]);
});

test("on macOS the copy stays with pbcopy, in an SSH session too", () => {
  if (process.platform !== "darwin") {
    console.log("SMOKE-SKIP: pbcopy is the copy tool on macOS only; the display-tool and OSC 52 test above covers this platform");
    return;
  }
  for (const env of [{ PATH: "/usr/bin" }, { PATH: "/usr/bin", SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" }]) {
    const mac = recorder();
    expect(copyDraft("héllo", env, mac.run, mac.terminal)).toEqual({ tool: "pbcopy", ok: true });
    expect(mac.calls).toEqual([{ argv: ["pbcopy"], text: "héllo" }]);
    expect(mac.sequences).toEqual([]);
  }
});
