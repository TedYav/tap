// Review findings, adopted as regression tests: peer
// compact carries the row instance, a tmux failure after the typed prefix is
// unverified, and take-back keys pass the same owner and fence checks as Enter.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorizePaneEffect, submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";
import { nativePeerSubmit, type PeerSubmit } from "../src/verbs/compact";
import { submitPeer } from "../src/verbs/compact-peer-submit";
import { peerSubmitArgv } from "../src/courier-argv";
import { permittedTakeBack, type PaneEffects as DeliverEffects } from "../src/deliver";
import { ServerUnresponsive } from "../src/tmux";
import { removeScratchTree } from "./support/scratch";

const id = "self-20260923T000000Z-abcd1234", payload = `keep the work [[sv:${id}]]`;
function pane(mode: "normal" | "throw" | "drift" | "fence" = "normal") {
  const root = mkdtempSync(join(process.env.TAP_HOME!, "review-1561-"));
  const registry = join(root, "registry.json");
  const bound = { paneId: "%7", harness: "claude", serverEpoch: "srv:1:1", handle: "peer", instance: "i1" };
  const row = { status: "active", pane: "fixture:0.0", pane_id: "%7", session: "fixture", server_epoch: "srv:1:1",
    harness: "claude", instance: "i1", permissions: "bypass", harness_session_id: "session", transcript_path: join(root, "claude.jsonl") };
  const save = () => writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { peer: row } }));
  save();
  writeFileSync(row.transcript_path, JSON.stringify({ type: "user", sessionId: "session" }) + "\n");
  writeFileSync(join(root, "resume.txt"), "preserve this test");
  let buffer = "";
  const effects: string[] = [], injects: string[] = [];
  const fx: DeliverEffects = {
    observePane: () => ({ paneId: "%7", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => buffer ? { state: "busy", text: buffer } : { state: "ready" },
    injectText: (_target, text) => { injects.push(text); buffer += text; return true; },
    inputHasId: () => false,
    pressEnter: () => { effects.push("Enter"); buffer = ""; return true; },
    settle: () => {},
    promptInput: () => {
      if (mode === "throw") throw new ServerUnresponsive("/fixture", "1");
      return { status: "text", text: buffer.replace(/ $/, "") };
    },
    regionInput: () => ({ status: "text", text: buffer }),
    submitFrame: (_target, _command, expected) => {
      if (mode === "drift") { row.instance = "i2"; save(); }
      if (mode === "fence") writeFileSync(join(root, "reset.fence.json"), "{}\n");
      return { state: buffer === expected ? "staged" : buffer ? "changed" : "empty", mode: "idle", width: "120" };
    },
    clearInput: () => { effects.push("C-u"); buffer = ""; return true; },
  };
  // The production wiring (self.ts): each take-back key passes the courier's permit.
  fx.takeBack = permittedTakeBack(fx);
  const authority: SubmitAuthority = { scriptsDir: "", agentFamilies: new Set(["claude"]),
    typedPrefix: "/goal ", busHome: root, registryPath: registry, recipient: "peer" };
  return { root, registry, bound, fx: fx as PaneEffects, authority, effects, injects };
}

const peerRequest = (p: ReturnType<typeof pane>): PeerSubmit => ({ pane: "fixture:0.0", paneId: "%7", id, text: "/compact keep work",
  target: "peer", session: "fixture", rowHarness: "claude", family: "claude", serverEpoch: "srv:1:1",
  nativeSession: "session", transcript: join(p.root, "claude.jsonl"), proofReceipt: join(p.root, "proof.json"), handoff: join(p.root, "resume.txt"), initiator: "lead", initiatorInstance: "lead-i", team: "fixture",
  bootId: "", instance: "", registry: p.registry, busHome: p.root, scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts") });

test("control: a stamped instance and normal typed control are valid", () => {
  const p = pane();
  try {
    expect(authorizePaneEffect("%7", p.bound, p.fx, p.authority).status).toBe("ok");
    expect(submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority).status).toBe("injected");
    expect(p.effects).toEqual(["Enter"]);
  } finally { removeScratchTree(p.root); }
});

test("native peer submit carries the row instance into authorization", async () => {
  const p = pane();
  const original = process.stderr.write;
  let diagnostic = "";
  process.stderr.write = ((chunk: any) => { diagnostic += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await submitPeer({ ...peerRequest(p), instance: "i1" });
    // The fixture pane is not a live tmux pane, so the submit itself fails; what
    // matters is that it does not fail on an instance the caller dropped.
    expect(code).toBe(1);
    expect(diagnostic).not.toContain("not the captured '(none)'");
  } finally { process.stderr.write = original; removeScratchTree(p.root); }
});

test("production peer submit runs as a child under compact's cancellable runner", async () => {
  const p = pane();
  try {
    const calls: { command: string[]; input?: string }[] = [];
    const request = { ...peerRequest(p), instance: "i1" };
    const code = await nativePeerSubmit(request, async (command, input) => {
      calls.push({ command, input });
      // The real child: the same argv and stdin the runner would spawn.
      const child = Bun.spawnSync(command, { stdin: Buffer.from(input ?? ""), env: process.env, stderr: "pipe" });
      return { code: child.exitCode ?? 1, out: child.stderr.toString() };
    });
    expect(calls).toHaveLength(1);
    // bun from PATH and the shipped module under the scripts dir: a compiled tap's
    // process.execPath is TAP itself, and its own module dir is virtual.
    expect(calls[0]!.command).toEqual(peerSubmitArgv(request.scriptsDir));
    expect(calls[0]!.command[0]).toBe("bun");
    expect(existsSync(calls[0]!.command.at(-1)!)).toBe(true);
    expect(JSON.parse(calls[0]!.input!)).toEqual(request);
    expect(code).toBe(1); // no live pane here; nothing ran in this process
  } finally { removeScratchTree(p.root); }
});

test("a read failure after the prefix stays unverified", () => {
  const p = pane("throw");
  try {
    let result: unknown;
    try { result = submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority); }
    catch (error) { result = { threw: String(error) }; }
    expect(p.injects).toEqual(["/goal "]);
    expect(result).toMatchObject({ status: "unverified" });
    expect((result as { detail: string }).detail).toContain("nothing replayed");
  } finally { removeScratchTree(p.root); }
});

for (const mode of ["drift", "fence"] as const) test(`take-back sends no key after ${mode} refuses Enter`, () => {
  const p = pane(mode);
  try {
    const result = submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority);
    expect(result.status).toBe("unverified");
    expect(p.effects).toEqual([]);
    expect((result as { detail: string }).detail).toContain("take-back: refused");
  } finally { removeScratchTree(p.root); }
});

// Round 2 (astra-ponytail): copy mode gates each take-back key too, and a
// positively unsent Enter (rate-limited) leaves the zero-Enter take-back on.
test("take-back sends no key after copy mode refuses Enter", () => {
  const p = pane();
  let copy = false;
  const frame = p.fx.submitFrame!;
  p.fx.copyMode = () => ({ status: copy ? "copy-mode" : "normal" }) as any;
  p.fx.submitFrame = (...args) => { copy = true; return frame(...args); };
  try {
    const result = submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority);
    expect(result.status).toBe("unverified");
    expect(p.effects).toEqual([]);
  } finally { removeScratchTree(p.root); }
});

test("a positively unsent Enter retains zero-Enter take-back", () => {
  const p = pane();
  p.fx.pressEnter = () => "rate_limited";
  try {
    const result = submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority);
    expect(result.status).toBe("unverified");
    expect(p.effects).toEqual(["C-u"]);
  } finally { removeScratchTree(p.root); }
});

test("a vanished Enter may have landed, so no take-back follows it", () => {
  const p = pane();
  p.fx.pressEnter = () => false;
  try {
    const result = submitVerifyLocked("%7", id, payload, p.bound, p.fx, p.authority);
    expect(result.status).toBe("unverified");
    expect(p.effects).toEqual([]);
  } finally { removeScratchTree(p.root); }
});
