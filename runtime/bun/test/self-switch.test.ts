import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TapError } from "../src/context";
import type { SubmitResult } from "../src/courier";
import { parseOptions } from "../src/self-rebrief";
import { applySwitches, checkSwitches, switchFailure, requireSwitchHarness, switchProven, switchSteps, switchWarning, transcriptSize, type SwitchEffects, type SwitchKind } from "../src/self-switch";
import { parseSelf } from "../src/verbs/self";
import { removeScratchTree } from "./support/scratch";

const root = mkdtempSync(join(tmpdir(), "self-switch-"));
afterAll(() => removeScratchTree(root));

const code = (fn: () => unknown): number | null => {
  try { fn(); return null; } catch (error) { return error instanceof TapError ? error.code : -1; }
};

test("compact and rebrief accept --model and --effort; other verbs and bad values refuse before any effect", () => {
  expect(parseSelf(["compact", "--handoff", "h.md", "--model", "fable", "--effort", "medium", "--", "keep", "it"]))
    .toEqual({ verb: "compact", text: "keep it", handoff: "h.md", model: "fable", effort: "medium" });
  expect(parseSelf(["compact", "--handoff", "h.md", "--model", "claude-opus-5-5[1m]", "--", "x"])).toMatchObject({ model: "claude-opus-5-5[1m]" });
  expect(() => parseSelf(["goal", "--model", "fable", "--", "x"])).toThrow("only apply to compact, clear and rebrief");
  expect(code(() => parseSelf(["compact", "--handoff", "h.md", "--effort", "turbo", "--", "x"]))).toBe(1);
  expect(code(() => parseSelf(["compact", "--handoff", "h.md", "--model", "fable sonnet", "--", "x"]))).toBe(1);
  expect(code(() => parseSelf(["compact", "--handoff", "h.md", "--model", "-x", "--", "x"]))).toBe(1);
  expect(() => parseSelf(["compact", "--handoff", "h.md", "--model", "a", "--model", "b", "--", "x"])).toThrow("may be passed once");

  expect(parseOptions(["rebrief", "--handoff", "h.md", "--model", "opus", "--effort", "xhigh"]))
    .toEqual({ verb: "rebrief", handoff: "h.md", switches: { model: "opus", effort: "xhigh" } });
  expect(parseOptions(["clear", "--handoff", "h.md"])).not.toHaveProperty("switches");
  expect(() => parseOptions(["rebrief", "--handoff", "h.md", "--effort", "low", "--effort", "high"])).toThrow("duplicate");
  expect(code(() => parseOptions(["rebrief", "--handoff", "h.md", "--effort", "LOW"]))).toBe(1);
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) expect(() => checkSwitches({ effort })).not.toThrow();
});

test("only Claude Code may carry switches: other harnesses refuse with exit 6, and no switches pass everywhere", () => {
  expect(code(() => requireSwitchHarness({ model: "fable" }, "codex"))).toBe(6);
  expect(code(() => requireSwitchHarness({ effort: "low" }, "opencode"))).toBe(6);
  expect(code(() => requireSwitchHarness({ model: "fable" }, "claude"))).toBeNull();
  expect(code(() => requireSwitchHarness({}, "codex"))).toBeNull();
  expect(code(() => requireSwitchHarness(undefined, "codex"))).toBeNull();
});

test("model runs before effort, whatever order the flags came in", () => {
  expect(switchSteps({ effort: "medium", model: "fable" }).map(step => step.command)).toEqual(["/model fable", "/effort medium"]);
  expect(switchSteps({ effort: "low" }).map(step => step.command)).toEqual(["/effort low"]);
});

test("proof is a fresh main-thread local-command result in the bound session after the offset", () => {
  const path = join(root, "proof.jsonl");
  const line = (event: object) => JSON.stringify(event) + "\n";
  const stdout = (text: string, extra: object = {}) => line({ type: "user", sessionId: "s1", timestamp: "2026-10-23T10:00:05.000Z",
    message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` }, ...extra });
  writeFileSync(path, line({ type: "system", sessionId: "s1" }) + stdout("Set model to `Haiku 5.5` and saved as your default for new sessions"));
  const offset = transcriptSize(path), since = Date.parse("2026-10-23T10:00:00.000Z");
  // The earlier switch before the offset never counts.
  expect(switchProven(path, "s1", offset, since, "model", "fable")).toBe(false);
  appendFileSync(path, stdout("Set model to `Fable 5.1` and saved", { sessionId: "other" }));
  appendFileSync(path, stdout("Set model to `Fable 5.1` and saved", { isSidechain: true }));
  appendFileSync(path, stdout("Set model to `Fable 5.1` and saved", { timestamp: "2026-10-23T09:59:59.000Z" }));
  appendFileSync(path, stdout("Set effort level to high (saved as your default for new sessions)"));
  expect(switchProven(path, "s1", offset, since, "model", "fable")).toBe(false);
  expect(switchProven(path, "s1", offset, since, "effort", "medium")).toBe(false);
  // The display name differs from the typed alias and may carry ANSI emphasis.
  appendFileSync(path, stdout("Set model to \u001b[1mFable 5.1\u001b[22m and saved as your default for new sessions"));
  appendFileSync(path, stdout("Set effort level to medium (saved as your default for new sessions): Balanced"));
  expect(switchProven(path, "s1", offset, since, "model", "fable")).toBe(true);
  expect(switchProven(path, "s1", offset, since, "effort", "medium")).toBe(true);
  expect(switchProven(join(root, "missing.jsonl"), "s1", 0, since, "model", "fable")).toBe(false);
  expect(transcriptSize(join(root, "missing.jsonl"))).toBe(-1);
});

function fakeSwitch(opts: { results?: Partial<Record<SwitchKind, SubmitResult[]>>; proveAfter?: Partial<Record<SwitchKind, number>>; size?: number; valid?: () => boolean; lockFreeAt?: number } = {}) {
  let time = 0, held = false;
  const log: string[] = [];
  const submitted: Partial<Record<SwitchKind, number>> = {};
  const fx: SwitchEffects = {
    reserve: () => {
      if (time < (opts.lockFreeAt ?? 0)) return null;
      log.push("lock"); held = true;
      return { release: () => { log.push("unlock"); held = false; } };
    },
    valid: opts.valid ?? (() => true),
    size: () => opts.size ?? 100,
    submit: (command, kind) => {
      expect(held).toBe(true);
      log.push(command);
      const queue = opts.results?.[kind];
      const result = queue?.length ? queue.shift()! : { status: "injected" as const };
      if (result.status === "injected") submitted[kind] = time;
      return result;
    },
    proven: (kind, _value, offset) => {
      expect(offset).toBe(opts.size ?? 100);
      const after = opts.proveAfter?.[kind] ?? 0;
      return submitted[kind] !== undefined && time - submitted[kind]! >= after;
    },
    settle: seconds => { log.push(`settle:${seconds}`); time += seconds * 1000; },
    wait: async () => { time += 250; },
    now: () => time,
  };
  return { fx, log };
}

test("both switches are submitted once, proven, and spaced before the resume", async () => {
  const f = fakeSwitch({ proveAfter: { model: 500 } });
  const report = await applySwitches({ model: "fable", effort: "medium" }, f.fx, 5000);
  expect(f.log).toEqual(["lock", "/model fable", "settle:2", "/effort medium", "settle:2", "unlock"]);
  expect(report).toEqual({
    model: { state: "confirmed", command: "/model fable", detail: "transcript recorded the switch" },
    effort: { state: "confirmed", command: "/effort medium", detail: "transcript recorded the switch" },
  });
  expect(switchWarning(report)).toBe("");
});

test("a no-effect refusal is retried within the deadline; a possible effect is never retyped", async () => {
  const retried = fakeSwitch({ results: { model: [{ status: "band_busy", detail: "draft" }, { status: "injected" }] } });
  expect((await applySwitches({ model: "fable" }, retried.fx, 5000)).model?.state).toBe("confirmed");
  expect(retried.log.filter(entry => entry.startsWith("/"))).toEqual(["/model fable", "/model fable"]);

  const unsure = fakeSwitch({ results: { model: [{ status: "unverified", detail: "composer still shows text" }] } });
  const report = await applySwitches({ model: "fable", effort: "medium" }, unsure.fx, 5000);
  expect(unsure.log).toEqual(["lock", "/model fable", "unlock"]);
  expect(report.model).toMatchObject({ state: "unconfirmed", detail: "submit unverified: composer still shows text" });
  expect(report.effort).toMatchObject({ state: "skipped" });
  expect(switchWarning(report)).toContain("'/model fable' (submit unverified: composer still shows text) or '/effort medium'");
});

test("a submitted switch without proof is unconfirmed but leaves the composer clear for the next one", async () => {
  const f = fakeSwitch({ proveAfter: { model: 60000 } });
  const report = await applySwitches({ model: "fable", effort: "low" }, f.fx, 1000);
  expect(report.model).toMatchObject({ state: "unconfirmed", detail: "submitted; no transcript confirmation before the deadline" });
  expect(report.effort?.state).toBe("confirmed");
  expect(switchWarning(report)).toStartWith("TAP could not confirm '/model fable'");

  const unreadable = fakeSwitch({ size: -1 });
  expect((await applySwitches({ effort: "low" }, unreadable.fx, 1000)).effort?.detail).toContain("unreadable");
});

test("a seat or session change stops typing before the first switch", async () => {
  const f = fakeSwitch({ valid: () => false });
  const report = await applySwitches({ model: "fable", effort: "low" }, f.fx, 1000);
  expect(f.log).toEqual(["lock", "unlock"]);
  expect(report.model?.state).toBe("skipped");
  expect(report.effort?.state).toBe("skipped");
});

test("a throwing effect after a confirmed model keeps that outcome, marks effort unconfirmed and still returns", async () => {
  const f = fakeSwitch();
  const submit = f.fx.submit;
  f.fx.submit = (command, kind) => { if (kind === "effort") throw new Error("tmux server unresponsive"); return submit(command, kind); };
  const report = await applySwitches({ model: "fable", effort: "medium" }, f.fx, 1000);
  expect(report.model?.state).toBe("confirmed");
  expect(report.effort).toEqual({ state: "unconfirmed", command: "/effort medium", detail: "switch failed: tmux server unresponsive" });
  expect(switchWarning(report)).toContain("'/effort medium' (switch failed: tmux server unresponsive)");

  const first = fakeSwitch({ valid: () => { throw new Error("old_store"); } });
  const halted = await applySwitches({ model: "fable", effort: "medium" }, first.fx, 1000);
  expect(halted.model).toMatchObject({ state: "unconfirmed", detail: "switch failed: old_store" });
  expect(halted.effort?.state).toBe("skipped");
  expect(switchFailure({ effort: "low" }, new Error("boom"))).toEqual({ effort: { state: "unconfirmed", command: "/effort low", detail: "switch failed: boom" } });
});

test("the pane lock is reserved before any typing; a lock that never frees types nothing", async () => {
  const late = fakeSwitch({ lockFreeAt: 750 });
  expect((await applySwitches({ model: "fable" }, late.fx, 5000)).model?.state).toBe("confirmed");
  expect(late.log).toEqual(["lock", "/model fable", "settle:2", "unlock"]);

  const never = fakeSwitch({ lockFreeAt: Number.POSITIVE_INFINITY });
  const report = await applySwitches({ model: "fable", effort: "low" }, never.fx, 1000);
  expect(never.log).toEqual([]);
  expect(report.model).toMatchObject({ state: "unconfirmed", detail: "switch failed: another submit held the pane-submit lock until the deadline; nothing typed" });
  expect(report.effort?.state).toBe("unconfirmed");
});

test("a /model that never left a no-effect refusal skips /effort, which belongs to the model", async () => {
  const f = fakeSwitch({ results: { model: Array.from({ length: 50 }, () => ({ status: "band_busy" as const, detail: "draft" })) } });
  const report = await applySwitches({ model: "fable", effort: "medium" }, f.fx, 1000);
  expect(report.model).toMatchObject({ state: "unconfirmed", detail: "submit band_busy: draft" });
  expect(report.effort?.state).toBe("skipped");
  expect(f.log.filter(entry => entry.startsWith("/effort"))).toEqual([]);
});
