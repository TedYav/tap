// `tap session launch` phase lines: stderr only, a TTY only (redirected and
// machine output are unchanged), and a failure names the phase it stopped in.
import { afterEach, expect, test } from "bun:test";
import { handOffLaunchProgress, launchPhase, suspendLaunchProgress, launchPhasesDone, launchProgressActive, progressMode, withLaunchProgress } from "../src/launcher/progress";

const realErr = process.stderr.write, realOut = process.stdout.write;
let err = "", out = "";
function capture(): void {
  err = ""; out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
}
afterEach(() => { process.stderr.write = realErr; process.stdout.write = realOut; });
const strip = (text: string) => text.replace(/\r\x1b\[2K/g, "\n").split("\n").filter(Boolean);

test("mode: animates only on a stderr TTY; redirected, TERM=dumb, --json and TAP_JSON stay off", () => {
  expect(progressMode(true, false, { TERM: "xterm-256color", NO_COLOR: "1" })).toBe("animate");
  expect(progressMode(false, false, {})).toBe("off");
  expect(progressMode(true, false, { TERM: "dumb" })).toBe("off");
  expect(progressMode(true, true, {})).toBe("off");
  expect(progressMode(true, false, { TAP_JSON: "1" })).toBe("off");
});

test("animate: each slow phase settles to ✓; other output erases the frame first; writes are restored", async () => {
  capture();
  const before = process.stderr.write;
  await withLaunchProgress("animate", async () => {
    launchPhase("Too quick to draw");
    launchPhase("Reserving claude on team t");
    await Bun.sleep(120);
    process.stdout.write("a receipt\n");
    launchPhase("Starting claude");
    await Bun.sleep(200); // the frame timer redraws while a wait is in flight
    launchPhasesDone();
    return 0;
  });
  const lines = strip(err);
  expect(lines).toContain("✓ Reserving claude on team t");
  expect(lines).toContain("✓ Starting claude");
  expect(lines.filter(line => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Starting claude$/.test(line)).length).toBeGreaterThan(1);
  // A non-effect phase that finishes before its first frame still leaves no line.
  expect(lines.some(line => line.includes("Too quick to draw"))).toBe(false);
  expect(out).toBe("a receipt\n");
  // The frame was erased before the receipt landed on the shared terminal.
  expect(err).toMatch(/Reserving claude on team t\r\x1b\[2K[^]*✓ Reserving/);
  expect(process.stderr.write).toBe(before);
  expect(launchProgressActive()).toBe(false);
});

test("animate: an effect-phase throw settles ✗ and tags the error; a config-phase exit just erases", async () => {
  capture();
  const failure = new Error("boom");
  await expect(withLaunchProgress("animate", async () => { launchPhase("Starting claude", true); throw failure; })).rejects.toThrow("boom");
  expect(strip(err).at(-1)).toBe("✗ Starting claude");
  expect((failure as Error & { launchPhase?: string }).launchPhase).toBe("Starting claude");
  capture();
  const refusal = new Error("refused");
  await expect(withLaunchProgress("animate", async () => { launchPhase("Loading TAP config"); await Bun.sleep(120); throw refusal; })).rejects.toThrow("refused");
  expect(strip(err).some(line => /[✓✗]/.test(line))).toBe(false);
  expect((refusal as Error & { launchPhase?: string }).launchPhase).toBeUndefined();
});

test("off mode still tags an effect-phase failure, with no output", async () => {
  capture();
  const failure = new Error("boom");
  await expect(withLaunchProgress("off", async () => { launchPhase("Marking claude ready on team t", true); throw failure; })).rejects.toThrow("boom");
  expect((failure as Error & { launchPhase?: string }).launchPhase).toBe("Marking claude ready on team t");
  expect(err + out).toBe("");
});

test("off and outside a launch: no output at all", async () => {
  capture();
  launchPhase("Loading TAP config");
  await withLaunchProgress("off", async () => { launchPhase("Loading TAP config"); return 0; });
  expect(err + out).toBe("");
});

test("a frame fits one terminal row, so clearing it leaves no wrapped fragment", async () => {
  capture();
  const columns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
  Object.defineProperty(process.stderr, "columns", { value: 20, configurable: true });
  try {
    await withLaunchProgress("animate", async () => { launchPhase("Waiting for claude to register on team a-very-long-team-name"); await Bun.sleep(120); return 1; });
  } finally {
    if (columns) Object.defineProperty(process.stderr, "columns", columns); else delete (process.stderr as { columns?: number }).columns;
  }
  const frames = err.split("\r\x1b[2K").filter(part => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(part));
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect([...frame].length).toBeLessThan(20);
});

test("a resume hand-off erases the line, restores writes, and stops tracking", async () => {
  capture();
  const before = process.stderr.write;
  const failure = new Error("resume refused");
  await expect(withLaunchProgress("animate", async () => {
    launchPhase("Loading TAP config");
    await Bun.sleep(120);
    handOffLaunchProgress();
    expect(process.stderr.write).toBe(before);
    expect(launchProgressActive()).toBe(false);
    launchPhase("Reserving claude on team t", true); // resume's own transaction: untracked
    await Bun.sleep(120);
    throw failure;
  })).rejects.toThrow("resume refused");
  expect(strip(err).some(line => /[✓✗]|Reserving/.test(line))).toBe(false);
  expect((failure as Error & { launchPhase?: string }).launchPhase).toBeUndefined();
});

test("render names the phase of an interrupted launch, silent when untagged", async () => {
  const { render } = await import("../src/launcher/resume-prelude");
  const { LaunchInterrupted } = await import("../src/launcher/transaction");
  capture();
  const tagged = Object.assign(new LaunchInterrupted(143), { launchPhase: "Starting claude" });
  expect(render(tagged, false)).toBe(143);
  expect(err).toBe("tap session: while starting claude: interrupted\n");
  capture();
  expect(render(Object.assign(new LaunchInterrupted(130), { launchPhase: "Starting claude" }), true)).toBe(130);
  expect(err).toBe("");
  expect(JSON.parse(out)).toEqual({ ok: false, error_class: "launcher_interrupted", action: "tap help session",
    detail: "while starting claude: launch cancelled" });
  capture();
  expect(render(new LaunchInterrupted(130), true)).toBe(130);
  expect(err + out).toBe("");
});

test("render prefixes a tagged failure's phase in text and in the JSON detail", async () => {
  const { render } = await import("../src/launcher/resume-prelude");
  const classed = () => Object.assign(new Error("pane went away"),
    { tapErrorClass: "launch_failed", tapAction: "tap doctor", launchPhase: "Marking claude ready on team t" });
  capture();
  render(classed(), false);
  expect(err).toBe("tap session: while marking claude ready on team t: pane went away; next: tap doctor\n");
  capture();
  render(classed(), true);
  expect(JSON.parse(out).detail).toBe("while marking claude ready on team t: pane went away");
});

test("an effect-bearing phase keeps its ✓ when it ends before the first frame, ahead of the next phase", async () => {
  capture();
  await withLaunchProgress("animate", async () => {
    launchPhase("Reserving claude on team t", true);
    launchPhase("Starting claude", true);
    await Bun.sleep(130);
    launchPhase("Marking claude ready on team t", true);
    launchPhasesDone();
    return 0;
  });
  const lines = strip(err);
  expect(lines.filter(line => /^[✓✗] /.test(line))).toEqual([
    "✓ Reserving claude on team t", "✓ Starting claude", "✓ Marking claude ready on team t"]);
  expect(lines.some(line => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (Reserving|Marking)/.test(line))).toBe(false);
});

test("an immediate final effect-bearing success leaves its ✓ whether settled by done or by the door's exit", async () => {
  for (const settleEarly of [true, false]) {
    capture();
    await withLaunchProgress("animate", async () => {
      launchPhase("Marking claude ready on team t", true);
      if (settleEarly) launchPhasesDone();
      return 0;
    });
    expect(strip(err)).toEqual(["✓ Marking claude ready on team t"]);
  }
});

test("the same launch lists the same ✓ steps whether its waits are instant or slow", async () => {
  const run = async (wait: number) => {
    capture();
    await withLaunchProgress("animate", async () => {
      launchPhase("Reserving claude on team t", true);
      launchPhase("Setting up tmux session s", true);
      if (wait) await Bun.sleep(wait);
      launchPhase("Waiting for codex to be ready", true);
      if (wait) await Bun.sleep(wait);
      launchPhase("Marking claude ready on team t", true);
      if (wait) await Bun.sleep(wait);
      launchPhasesDone();
      return 0;
    });
    return strip(err).filter(line => /^[✓✗] /.test(line));
  };
  const fast = await run(0), slow = await run(130);
  expect(fast).toEqual(["✓ Reserving claude on team t", "✓ Setting up tmux session s", "✓ Waiting for codex to be ready", "✓ Marking claude ready on team t"]);
  expect(slow).toEqual(fast);
});

test("a kept phase that is handed off, refused or interrupted unmarked still just erases", async () => {
  capture();
  await expect(withLaunchProgress("animate", async () => {
    launchPhase("Loading TAP config");
    launchPhase("Marking claude ready on team t", true);
    handOffLaunchProgress();
    throw new Error("resume refused");
  })).rejects.toThrow("resume refused");
  expect(strip(err).some(line => /[✓✗]/.test(line))).toBe(false);
});

test("each phase gets its own draw delay, so a quick phase after a drawn one leaves nothing", async () => {
  capture();
  await withLaunchProgress("animate", async () => {
    launchPhase("Slow phase");
    await Bun.sleep(130);
    launchPhase("Quick phase");
    await Bun.sleep(20);
    launchPhasesDone();
    return 0;
  });
  const lines = strip(err);
  expect(lines).toContain("✓ Slow phase");
  expect(lines.some(line => line.includes("Quick phase"))).toBe(false);
});

test("a signal before the transaction's handlers erases the frame and still terminates", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join, resolve } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "launch-progress-signal-"));
  const script = join(dir, "child.ts");
  writeFileSync(script, `import { launchPhase, withLaunchProgress } from ${JSON.stringify(resolve(import.meta.dir, "../src/launcher/progress.ts"))};
await withLaunchProgress("animate", async () => {
  launchPhase("Loading TAP config");
  await Bun.sleep(150);
  process.kill(process.pid, "SIGINT");
  await Bun.sleep(2000);
  process.stderr.write("NOT TERMINATED");
  return 0;
});
`);
  const r = Bun.spawnSync([process.execPath, script], { stderr: "pipe", stdout: "pipe" });
  const stderr = r.stderr.toString();
  expect(r.signalCode ?? r.exitCode).toBe("SIGINT");
  expect(stderr).toContain("Loading TAP config");
  expect(stderr.endsWith("\r\x1b[2K")).toBe(true);
  expect(stderr).not.toContain("NOT TERMINATED");
});

test("suspend: a prompt erases the spinner and holds it off until answered, then it animates again", async () => {
  capture();
  const frame = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Loading TAP config/g;
  await withLaunchProgress("animate", async () => {
    launchPhase("Loading TAP config");
    await Bun.sleep(200);
    expect(err.match(frame)?.length).toBeGreaterThan(0);
    const resume = suspendLaunchProgress();
    expect(err.endsWith("\r\x1b[2K")).toBe(true);
    const held = err.length;
    await Bun.sleep(300); // several frame ticks pass while the prompt waits
    expect(err.length).toBe(held);
    // A phase change while a prompt waits starts no timer either.
    launchPhase("Reserving claude on team t");
    await Bun.sleep(200);
    expect(err.slice(held)).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    const settled = err.length;
    resume();
    await Bun.sleep(200);
    expect(err.slice(settled)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reserving claude on team t/);
    launchPhasesDone();
    return 0;
  });
});

test("suspend: outside an animated launch it is a no-op", () => {
  capture();
  suspendLaunchProgress()();
  expect(err).toBe("");
});
