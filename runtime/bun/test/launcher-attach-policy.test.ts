// The production attach policy's edges that the Python transport tests
// (test_launcher.py AttachModeTests, through the real worker) cannot isolate:
// liveness polarity, malformed pane answers, the narration table, and the
// resume tail detaching a TTY-less caller before any tmux probe.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LaunchInterrupted } from "../src/launcher/transaction";
import { ATTACH_REFUSED_AMBIGUOUS, ATTACH_REFUSED_IN_TMUX, ATTACH_REFUSED_TTY_OWNERSHIP, attachNarration, detachedReceipt, attachTail, tmuxPaneTty, tmuxServerIsGone, type CallerFacts } from "../src/launcher/attach-policy";

const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

function fakeTmux(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "attach-policy-"));
  const log = join(dir, "calls");
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n${script}\n`);
  chmodSync(join(dir, "tmux"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return log;
}
const facts = (over: Partial<CallerFacts> = {}): CallerFacts =>
  ({ tmux: "", tmux_pane: "", caller_tty: "/dev/ttys009", owns_foreground: true, has_tty: true, ...over });

test("only a positively absent server counts as gone; ambiguity never unlocks attach", () => {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(tmuxServerIsGone(`/s,${child.pid},0`)).toBe(true);
  expect(tmuxServerIsGone(`/s,${process.pid},0`)).toBe(false);
  expect(tmuxServerIsGone("/s,1,0")).toBe(false); // alive, not ours to signal
  for (const raw of ["/s", "/s,,0", "/s,abc,0", "/s,-1,0", "/s,99999999999999999999,0"]) expect(tmuxServerIsGone(raw)).toBe(false);
});

test("pane tty and dead state must form one complete, valid record", async () => {
  for (const [script, expected] of [
    ["printf '/dev/ttys001\\t0\\n'", { tty: "/dev/ttys001", dead: false }],
    ["printf '  /dev/ttys001  \\t0\\n'", { tty: "/dev/ttys001", dead: false }],
    ["printf '/dev/ttys001\\t1\\n'", { tty: "/dev/ttys001", dead: true }],
    ["printf '\\t1\\n'", { tty: "", dead: true }],
    ["printf '/dev/a\\t0\\n/dev/b\\t0\\n'", null], ["echo ''", null], ["exit 1", null],
    ["echo /dev/ttys001", null], ["printf '/dev/a\\t\\n'", null],
    ["printf '/dev/a\\t2\\n'", null], ["printf '/dev/a\\tfalse\\n'", null],
    ["printf '/dev/a\\t0\\textra\\n'", null], ["printf '\\t0\\n'", null],
  ] as const) {
    fakeTmux(script);
    expect(await tmuxPaneTty("%7")).toEqual(expected);
  }
  process.env.PATH = mkdtempSync(join(tmpdir(), "attach-policy-empty-"));
  expect(await tmuxPaneTty("%7")).toBeNull();
});

test("the narration is one receipt per refusal and the warning pair only for a real failure", () => {
  expect(attachNarration("repo/scout", 0)).toEqual({ receipt: null, warning: null });
  expect(attachNarration("repo/scout", ATTACH_REFUSED_IN_TMUX)).toEqual({ receipt: "in-tmux caller", warning: null });
  expect(attachNarration("repo/scout", ATTACH_REFUSED_AMBIGUOUS)).toEqual({ receipt: "tmux caller state unverified", warning: null });
  expect(attachNarration("repo/scout", ATTACH_REFUSED_TTY_OWNERSHIP)).toEqual({ receipt: "caller does not own foreground tty", warning: null });
  expect(attachNarration("repo/scout", 1)).toEqual({ receipt: "attach failed",
    warning: { problem: "could not attach to repo/scout (tmux exit 1); the session is running and registered", next: "tap attach repo/scout" } });
});

test("the resume tail detaches a TTY-less caller before any tmux probe; the launch tail always plans", async () => {
  const log = fakeTmux("printf '/dev/ttys009\\t0\\n'");
  const live = facts({ tmux: `/s,${process.pid},0`, tmux_pane: "%7", has_tty: false });
  expect(await attachTail("resume", "repo/scout", live)).toEqual({ detached: "no controlling terminal" });
  expect(Bun.file(log).size).toBe(0);
  expect(await attachTail("launch", "repo/scout", live)).toEqual({ refused: ATTACH_REFUSED_IN_TMUX });
  expect(await Bun.file(log).text()).toBe("display-message -p -t %7 #{pane_tty}\t#{pane_dead}\n");
});

test("an inherited $TMUX with no socket path is ambiguous, never a bare attach", async () => {
  fakeTmux("printf '/dev/ttys001\\t0\\n'");
  expect(await attachTail("launch", "repo/scout", facts({ tmux: `,${process.pid},0`, tmux_pane: "%7" }))).toEqual({ refused: ATTACH_REFUSED_AMBIGUOUS });
});

test("an interrupt stops a hung pane probe and surfaces as the interrupt, never a refusal", async () => {
  const log = fakeTmux("exec sleep 30");
  const controller = new AbortController();
  const interrupted = new LaunchInterrupted(130);
  const live = facts({ tmux: `/s,${process.pid},0`, tmux_pane: "%7" });
  const tail = attachTail("launch", "repo/scout", live, controller.signal);
  // Interrupt only once the probe is provably running. Wait for the logged line, not the file:
  // `>>` creates the file before echo writes it, and under suite load a read lands between.
  const logged = async () => (await Bun.file(log).exists()) ? await Bun.file(log).text() : "";
  for (const deadline = Date.now() + 5000; (await logged()) === "" && Date.now() < deadline;) await Bun.sleep(20);
  expect(await Bun.file(log).text()).toBe("display-message -p -t %7 #{pane_tty}\t#{pane_dead}\n");
  const started = Date.now();
  controller.abort(interrupted);
  await expect(tail).rejects.toBe(interrupted);
  expect(Date.now() - started).toBeLessThan(5000);
});

// The same catch decides a launchCommand custody failure (a probe group that
// outlived termination): only a missing tmux may yield to the interrupt.
test("a probe failure other than a missing tmux outranks the interrupt that coincides with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-policy-noexec-"));
  writeFileSync(join(dir, "tmux"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0, 0, 0])); // a truncated ELF: ENOEXEC
  chmodSync(join(dir, "tmux"), 0o755);
  process.env.PATH = dir;
  const controller = new AbortController();
  const interrupted = new LaunchInterrupted(130);
  const probe = tmuxPaneTty("%7", controller.signal);
  controller.abort(interrupted);
  const error = await probe.then(() => null, (caught: unknown) => caught);
  expect(error).not.toBe(interrupted);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOEXEC");
});


test("detached receipts give a human terminal handoff without claiming attachment", () => {
  for (const reason of ["no controlling terminal", "caller does not own foreground tty", "tmux caller state unverified", "attach failed"]) {
    const receipt = detachedReceipt("repo/actual-name", reason);
    expect(receipt).toContain(`is running detached (${reason})`);
    expect(receipt).toContain("from a foreground terminal, run tap attach repo/actual-name");
    expect(receipt).not.toContain("tmux attach");
  }
  expect(detachedReceipt("repo/actual-name", "in-tmux caller")).toContain("from your terminal, run tap attach repo/actual-name (or detach with Ctrl-b d first)");
});


test("custom session names retain the registered seat as the attach target", () => {
  expect(detachedReceipt("custom-session", "no controlling terminal", "repo/claude"))
    .toContain("custom-session is running detached (no controlling terminal); next: from a foreground terminal, run tap attach repo/claude");
  expect(attachNarration("custom-session", 1, "repo/claude").warning?.next).toBe("tap attach repo/claude");
});
