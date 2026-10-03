/**
 * `tap clear`'s public boundary (cmdClearNative) over the replacement
 * transaction, with pane effects faked at the module seams: argv refusals
 * before any effect, the post-effect exit 7 when the registry turns old-format
 * after the respawn, tmux's own respawn status, the locked stamp refusing an
 * old/hybrid registry, and notice suppression for structured callers.
 * The mocks live in a child process (fixtures/clear-cmd-probe.ts): mock.module
 * is process-wide and would leak into every later test file.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const probe = join(import.meta.dir, "fixtures", "clear-cmd-probe.ts");

function run(mode: string, argv: string[] = [], env: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, probe, mode, ...argv], {
    env: { ...process.env, TAP_JSON: "", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = child.stdout.toString().trimEnd();
  const stderr = child.stderr.toString();
  expect(child.exitCode, stderr).toBe(0);
  const result = JSON.parse(out.slice(out.lastIndexOf("\n") + 1)) as Record<string, unknown>;
  expect(result.threw, stderr).toBeUndefined();
  return { ...result, stderr } as Record<string, unknown> & { stderr: string };
}

test("control: a valid clear replaces exactly once and verifies", () => {
  const r = run("ok", ["sol"]);
  expect([r.rc, r.respawns]).toEqual([0, 1]);
  expect(r.latency).toMatchObject({ operation: "clear", handle: "sol", harness: "claude", pane_id: "%7", verified: true,
    seconds: expect.any(Number), timeout: 45, loadavg1: expect.any(Number), at: expect.any(String) });
});

for (const tail of [["-m"], ["-m", "--dry-run"], ["--message", "--bogus"]]) {
  test(`a missing or option-shaped -m operand refuses before any effect: ${tail.join(" ")}`, () => {
    const r = run("ok", ["sol", ...tail]);
    expect([r.rc, r.calls, r.expected]).toEqual([2, 0, null]);
  });
}

for (const message of ["", "- a literal dash note", "-"]) {
  test(`a literal -m operand still clears: ${JSON.stringify(message)}`, () => {
    const r = run("ok", ["sol", "-m", message]);
    expect([r.rc, r.prompt, r.respawns]).toEqual([0, message, 1]);
  });
}

test("an old-format registry after the respawn is post-effect exit 7, with the fence released", () => {
  const r = run("old-store", ["sol"]);
  expect([r.rc, r.respawns, r.fenceSize]).toEqual([7, 1, 0]);
});

test("a failed respawn exits with tmux's own status, attempted once, expectation retired", () => {
  const r = run("status", ["sol"]);
  expect([r.rc, r.respawns, r.expected]).toEqual([23, 1, null]);
});

test("the locked stamp refuses an old/hybrid registry without writing", () => {
  const r = run("old-stamp");
  expect([r.errorClass, r.unchanged]).toEqual(["old_store", true]);
});

test("launch notices print for a human caller and are suppressed under TAP_JSON", () => {
  expect(run("ok", ["sol", "--dry-run"]).stderr).toContain("fixture launch notice");
  const structured = run("ok", ["sol", "--dry-run"], { TAP_JSON: "1" });
  expect(structured.rc).toBe(0);
  expect(structured.stderr).not.toContain("fixture launch notice");
});

// tap-boiq: hermes argv carries no prompt and nothing delivers -m afterwards.
test("hermes with -m refuses before any effect, with a stable class and the send workaround", () => {
  const r = run("ok", ["sol", "-m", "do the thing"], { PROBE_HARNESS: "hermes", TAP_SELF: "lead" });
  // The one tmux call is the read-only pane observation; no respawn, kill or option write.
  expect([r.rc, r.verbs, r.respawns, r.expected, r.fenceSize]).toEqual([2, ["display-message"], 0, null, null]);
  expect(r.stderr).toContain("hermes has no channel for a -m instruction");
  expect(r.stderr).toContain("nothing was replaced");
  expect(r.stderr).toContain("tap send sol -f <file> --fyi --wake --from lead");
  const structured = run("ok", ["sol", "-m", "do the thing"], { PROBE_HARNESS: "hermes", TAP_JSON: "1" });
  expect(structured.rc).toBe(2);
  expect(structured.stderr).toBe("");
});

test("hermes with --dry-run -m refuses too, so the preview never promises a dropped instruction", () => {
  const r = run("ok", ["sol", "-m", "x", "--dry-run"], { PROBE_HARNESS: "hermes" });
  expect([r.rc, r.verbs]).toEqual([2, ["display-message"]]);
});

test("hermes without -m, and other harnesses with -m, are unchanged", () => {
  const bare = run("ok", ["sol"], { PROBE_HARNESS: "hermes" });
  expect([bare.rc, bare.respawns]).toEqual([0, 1]);
  const emptyMessage = run("ok", ["sol", "-m", ""], { PROBE_HARNESS: "hermes" });
  expect([emptyMessage.rc, emptyMessage.respawns]).toEqual([0, 1]);
  for (const harness of ["claude", "codex"]) {
    const r = run("ok", ["sol", "-m", "go"], { PROBE_HARNESS: harness });
    expect([r.rc, r.prompt, r.respawns]).toEqual([0, "go", 1]);
  }
});
