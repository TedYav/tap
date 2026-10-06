// tap-xe42x: the nudge ladder against a scripted pane. Every key the ladder would
// press goes through LadderIO.effect, so the effect log IS the keystroke record.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TapError } from "../src/context";
import {
  CURSOR_INTERRUPT_GAP_MS, CURSOR_INTERRUPT_SETTLE_MS, KNOWN_BLOCKERS, NUDGE_INTERRUPT,
  matchBlocker, previewLadder, runLadder, type ComposerRead, type EffectResult, type LadderIO, type LadderOptions,
} from "../src/verbs/nudge-ladder";

const MODAL = readFileSync(join(import.meta.dir, "fixtures/usage-limit-modal/pane-plain.txt"), "utf8");
const IDLE = "❯ \n";
const WIRE = "[[TAP v0.23 nudge]]";

interface Scripted {
  frames?: string[];
  composer?: ComposerRead[];
  staged?: number | null;
  refuse?: string[];
  fail?: string[];
  unverified?: string[];
}

function pane(script: Scripted = {}) {
  const frames = [...(script.frames ?? [IDLE])];
  const composers = [...(script.composer ?? [{ kind: "ready" as const }])];
  const effects: { action: string; keys: string[]; gated: string }[] = [];
  const sleeps: number[] = [];
  const out: string[] = [];
  let expected = "", stagedReobserve: boolean | null = null;
  const next = <T>(list: T[]): T => list.length > 1 ? list.shift()! : list[0]!;
  const io: LadderIO = {
    frame: () => next(frames),
    composer: () => next(composers),
    effect(action, keys, gate, verify): EffectResult {
      const gated = gate ? gate() : "";
      if (gated || script.refuse?.includes(action)) return { sent: false, ok: false, verified: false, summary: gated || "refused" };
      effects.push({ action, keys, gated });
      if (script.fail?.includes(action)) return { sent: true, ok: false, verified: false, summary: "tmux outcome unknown" };
      const verified = script.unverified?.includes(action) ? false : verify ? verify() : true;
      return { sent: true, ok: true, verified, summary: "ok" };
    },
    expect: wire => { expected = wire; },
    submitStaged: reobserve => { stagedReobserve = reobserve; return script.staged ?? null; },
    sleep: ms => { sleeps.push(ms); },
    out: line => { out.push(line); },
  };
  return { io, effects, sleeps, out, expected: () => expected, stagedReobserve: () => stagedReobserve };
}

const opts = (harness: string, extra: Partial<LadderOptions> = {}): LadderOptions =>
  ({ harness, interrupt: true, wire: WIRE, label: "peer", deliver: true, ...extra });
const keysOf = (effects: { keys: string[] }[]) => effects.flatMap(e => e.keys);
const thrown = (fn: () => unknown): TapError => {
  try { fn(); } catch (error) { if (error instanceof TapError) return error; throw error; }
  throw new Error("expected a TapError");
};

test("no rung of any harness can send C-c: the interrupt table and every recorded effect", () => {
  for (const [family, row] of Object.entries(NUDGE_INTERRUPT)) {
    expect(row.keys.some(k => /^C-|^\^/.test(k))).toBe(false);
    for (const interrupt of [true, false]) {
      const p = pane();
      expect(runLadder(opts(family, { interrupt }), p.io)).toBe(0);
      expect(keysOf(p.effects).some(k => /^C-c$/i.test(k))).toBe(false);
    }
  }
  for (const row of KNOWN_BLOCKERS) expect(row.keys).toEqual(["Escape"]);
});

test("the captured weekly-usage modal is recognized only on Claude, from its bounded bottom region", () => {
  expect(matchBlocker("claude", MODAL)?.id).toBe("claude-weekly-usage-limit");
  expect(matchBlocker("codex", MODAL)).toBeNull();
  // The same words in transcript history above an ordinary composer are not the modal.
  expect(matchBlocker("claude", MODAL + "\n" + "─".repeat(20) + "\n❯ \n")).toBeNull();
  expect(matchBlocker("claude", MODAL.replace("Esc to cancel", "Esc to go back"))).toBeNull();
  // The license is the complete captured option set: missing or extra options are another dialog.
  const rows = MODAL.split("\n");
  const without = (re: RegExp) => rows.filter(row => !re.test(row)).join("\n");
  expect(matchBlocker("claude", without(/^\s*[23]\./))).toBeNull();
  expect(matchBlocker("claude", without(/^\s*3\./))).toBeNull();
  expect(matchBlocker("claude", MODAL.replace(/(\n\s*3\. Switch to usage credits[^\n]*)/, "$1\n     4. Buy more"))).toBeNull();
});

test("rung 1 dismisses the modal with Esc only, on two identical samples, then delivers exactly once", () => {
  const p = pane({ frames: [MODAL, MODAL, MODAL, IDLE] });
  expect(runLadder(opts("claude"), p.io)).toBe(0);
  expect(p.effects.map(e => e.action)).toEqual(["nudge dismiss claude-weekly-usage-limit", "nudge interrupt", "nudge type", "nudge Enter"]);
  expect(p.effects[0]!.keys).toEqual(["Escape"]);
  expect(keysOf(p.effects).filter(k => k === "Enter")).toHaveLength(1);
  expect(p.effects.find(e => e.action === "nudge type")!.keys).toEqual(["-l", WIRE]);
  expect(p.stagedReobserve()).toBe(true);
  expect(p.out.join("\n")).toContain("dismissed claude-weekly-usage-limit (Escape)");
});

test("rung 1 refuses when the two key-boundary samples differ; no key falls", () => {
  const p = pane({ frames: [MODAL, MODAL, MODAL.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")] });
  const error = thrown(() => runLadder(opts("claude"), p.io));
  expect(error.errorClass).toBe("blocker_held");
  expect(p.effects).toEqual([]);
});

test("rung 1 stops at exit 5 when the modal is still showing or the pane is unreadable after Esc", () => {
  const still = pane({ frames: [MODAL] });
  expect(runLadder(opts("claude"), still.io)).toBe(5);
  expect(still.effects.map(e => e.action)).toEqual(["nudge dismiss claude-weekly-usage-limit"]);
  expect(still.out.join("\n")).toContain("do not re-nudge");
  let reads = 0;
  const blind = pane({ frames: [MODAL] });
  blind.io.frame = () => { if (++reads > 3) throw new Error("frame unavailable"); return MODAL; };
  expect(runLadder(opts("claude"), blind.io)).toBe(5);
  expect(blind.effects).toHaveLength(1);
});

test("an unknown dialog, an approval prompt and Codex hook trust get no key at all", () => {
  const state = (path: string) => readFileSync(join(import.meta.dir, "fixtures/agent-state", path), "utf8");
  const dialogs: [string, string][] = [
    ["claude", state("claude/blocked-real.txt")],
    ["codex", state("codex/blocked-real.txt")],
    ["codex", state("codex/hook-trust.txt")],
  ];
  for (const [harness, frame] of dialogs) {
    const p = pane({ frames: [frame] });
    const error = thrown(() => runLadder(opts(harness), p.io));
    expect(error.errorClass).toBe("blocker_held");
    expect(p.effects).toEqual([]);
  }
});

test("a staged sentinel beats the interrupt: rung 2 ends the run before any rung-3 key", () => {
  const p = pane({ staged: 0 });
  expect(runLadder(opts("codex"), p.io)).toBe(0);
  expect(p.effects).toEqual([]);
  expect(p.stagedReobserve()).toBe(false);
});

test("rung 3 interrupts with the harness's verified key, then types and submits the nudge once", () => {
  for (const [harness, keys] of [["claude", ["Escape"]], ["codex", ["Escape"]], ["agy", ["Escape"]], ["opencode", ["Escape", "Escape"]]] as const) {
    const p = pane();
    expect(runLadder(opts(harness), p.io)).toBe(0);
    expect(p.effects.map(e => [e.action, e.keys])).toEqual([["nudge interrupt", [...keys]], ["nudge type", ["-l", WIRE]], ["nudge Enter", ["Enter"]]]);
    expect(p.expected()).toBe(WIRE);
  }
});

test("--no-interrupt skips only the interrupt key", () => {
  const p = pane();
  expect(runLadder(opts("opencode", { interrupt: false }), p.io)).toBe(0);
  expect(p.effects.map(e => e.action)).toEqual(["nudge type", "nudge Enter"]);
});

test("Cursor: no interrupt key; submit, then Enter at +5000 ms and +200 ms; --no-interrupt skips the recipe", () => {
  expect([CURSOR_INTERRUPT_SETTLE_MS, CURSOR_INTERRUPT_GAP_MS]).toEqual([5000, 200]);
  const p = pane();
  expect(runLadder(opts("cursor"), p.io)).toBe(0);
  expect(p.effects.map(e => e.action)).toEqual(["nudge type", "nudge Enter", "cursor message-interrupt Enter", "cursor message-interrupt Enter"]);
  const after = p.sleeps.slice(p.sleeps.indexOf(CURSOR_INTERRUPT_SETTLE_MS));
  expect(after).toEqual([CURSOR_INTERRUPT_SETTLE_MS, CURSOR_INTERRUPT_GAP_MS]);
  const quiet = pane();
  expect(runLadder(opts("cursor", { interrupt: false }), quiet.io)).toBe(0);
  expect(quiet.effects.map(e => e.action)).toEqual(["nudge type", "nudge Enter"]);
});

test("Hermes: the bare submission interrupts by default; --no-interrupt types it behind /queue", () => {
  const bare = pane();
  expect(runLadder(opts("hermes"), bare.io)).toBe(0);
  expect(bare.effects.map(e => [e.action, e.keys])).toEqual([["nudge type", ["-l", WIRE]], ["nudge Enter", ["Enter"]]]);
  const queued = pane();
  expect(runLadder(opts("hermes", { interrupt: false }), queued.io)).toBe(0);
  expect(queued.effects.find(e => e.action === "nudge type")!.keys).toEqual(["-l", `/queue ${WIRE}`]);
  expect(queued.expected()).toBe(`/queue ${WIRE}`);
});

test("a draft, queued follow-ups or unreadable composer hold rung 3 with no key", () => {
  for (const kind of ["draft", "queued", "sentinel", "unreadable"] as const) {
    const p = pane({ composer: [{ kind }] });
    expect(thrown(() => runLadder(opts("codex"), p.io)).errorClass).toBe("nudge_held");
    expect(p.effects).toEqual([]);
  }
});

test("after a possible effect the ladder stops at exit 5 and presses nothing more", () => {
  // Interrupt fell, then the composer filled (a flushed queue): nothing typed.
  const flushed = pane({ composer: [{ kind: "ready" }, { kind: "ready" }, { kind: "draft" }] });
  expect(runLadder(opts("codex"), flushed.io)).toBe(5);
  expect(flushed.effects.map(e => e.action)).toEqual(["nudge interrupt"]);
  // tmux could not confirm the Enter: no second Enter.
  const blind = pane({ fail: ["nudge Enter"] });
  expect(runLadder(opts("codex"), blind.io)).toBe(5);
  expect(keysOf(blind.effects).filter(k => k === "Enter")).toHaveLength(1);
  expect(blind.out.join("\n")).toContain("do not re-nudge");
  const unverified = pane({ unverified: ["nudge Enter"] });
  expect(runLadder(opts("codex"), unverified.io)).toBe(5);
});

test("--pane (deliver=false) runs rungs 1-2 only and says why delivery was skipped", () => {
  const p = pane();
  expect(runLadder(opts("codex", { deliver: false }), p.io)).toBe(0);
  expect(p.effects).toEqual([]);
  expect(p.out.join("\n")).toContain("delivery skipped because --pane overrides the registered seat");
});

test("the dry-run preview names each rung's would-be action and presses nothing", () => {
  expect(previewLadder(opts("claude"), MODAL, { kind: "unreadable" }, false)).toEqual([
    "rung 1: would dismiss claude-weekly-usage-limit (Escape), then re-read the pane",
    "rung 2: no staged sentinel",
    `rung 3: would interrupt with Escape, then type and submit ${WIRE}`,
  ]);
  expect(previewLadder(opts("codex"), IDLE, { kind: "ready" }, true).at(-1)).toBe("rung 2: would press Enter once on the staged sentinel");
  expect(previewLadder(opts("cursor"), IDLE, { kind: "ready" }, false).at(-1)).toContain("+5000 ms and +200 ms");
});

test("an unexpected failure after a key fell is a possible effect (exit 5), never a plain refusal", () => {
  const p = pane();
  let reads = 0;
  p.io.composer = () => { if (++reads > 2) throw new Error("capture failed"); return { kind: "ready" }; };
  expect(runLadder(opts("codex"), p.io)).toBe(5);
  expect(p.effects.map(e => e.action)).toEqual(["nudge interrupt"]);
  expect(p.out.join("\n")).toContain("stopped after a key had been sent: capture failed (possible effect; do not re-nudge)");
  // Before any key, the same failure is an ordinary error with nothing sent.
  const early = pane();
  early.io.composer = () => { throw new Error("capture failed"); };
  expect(() => runLadder(opts("codex"), early.io)).toThrow("capture failed");
  expect(early.effects).toEqual([]);
});

test("a hold after a dismissal is a possible effect: exit 5, never \"nothing sent\"", () => {
  const p = pane({ frames: [MODAL, MODAL, MODAL, IDLE], composer: [{ kind: "draft" }] });
  expect(runLadder(opts("claude"), p.io)).toBe(5);
  const text = p.out.join("\n");
  expect(text).toContain("dismissed claude-weekly-usage-limit, then the composer holds a draft");
  expect(text).toContain("do not re-nudge");
  expect(text).not.toContain("nothing sent");
});

test("returned failures after a key are exit 5 too: a staged submit failing after a dismissal, Cursor's refused recipe Enter", () => {
  const staged = pane({ frames: [MODAL, MODAL, MODAL, IDLE], staged: 1 });
  expect(runLadder(opts("claude"), staged.io)).toBe(5);
  expect(staged.out.join("\n")).toContain("stopped after a key had been sent (exit 1)");
  const cursor = pane({ refuse: ["cursor message-interrupt Enter"] });
  expect(runLadder(opts("cursor"), cursor.io)).toBe(5);
  expect(cursor.effects.map(e => e.action)).toEqual(["nudge type", "nudge Enter"]);
  expect(cursor.out.join("\n")).toContain("do not re-nudge");
});

test("an effect that throws after its keys (a failed receipt write) is a possible effect", () => {
  const p = pane();
  const effect = p.io.effect;
  p.io.effect = (action, keys, gate, verify) => {
    const result = effect(action, keys, gate, verify);
    if (action === "nudge type") throw new Error("EISDIR: events.jsonl");
    return result;
  };
  expect(runLadder(opts("hermes", { interrupt: false }), p.io)).toBe(5);
  expect(p.effects.map(e => e.keys)).toEqual([["-l", "/queue [[TAP v0.23 nudge]]"]]);
  expect(p.out.join("\n")).toContain("EISDIR");
});
