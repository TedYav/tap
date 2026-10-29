import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeUnwedge, unwedgeBoundaryRefusal, type UnwedgeReadIO } from "../src/recovery/unwedge-observe";
import type { SeatSnapshot } from "../src/verbs/doctor-seat";
import type { BoundTranscript } from "../src/readiness-stall";
import { composerHoldsExactly, visibleSentinel, readComposerFrame } from "../src/submit-frame";
import { parseStuckSentinel } from "../src/stuck-sentinel";
import { transcriptPosition } from "../src/recovery/unwedge-progress";
import type { UnwedgeAttempt } from "../src/recovery/unwedge-policy";
const capacity = readFileSync(join(import.meta.dir, "fixtures/agent-state/errors/codex-capacity.ansi"), "utf8");
const wire = "[[TAP v0.23 note actor-20261028T000000Z-abcdef123456]]";
const snapshot: SeatSnapshot = { binding: { team: "t", handle: "peer", registry: "/r", pane: "s:0.0", paneId: "%1", session: "s", instance: "i", harness: "codex", processPid: "123", serverSocket: "/socket", serverEpoch: "epoch", nativeSessionId: "n" }, seat: {}, root: "/", busHome: "/bus" };
const bytes = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }) + "\n");
const sample: BoundTranscript = { path: "/transcript", fileId: "1:2", size: bytes.length, start: 0, bytes, lines: bytes.toString().trim().split("\n"), mtime: Date.now() / 1000 };
function fixture() {
  let frame = capacity;
  const io: UnwedgeReadIO = { identity: () => snapshot.binding, frame: () => ({ text: frame, title: "", height: 40, copyMode: false }), protection: () => false, transcript: () => sample };
  return { io, setFrame: (text: string) => { frame = text; } };
}
function prior(): UnwedgeAttempt { return { v: 1, rung: "message", binding: snapshot.binding, cause: "model_capacity", outcome: "completed", effect: "possible", completedAt: 1, nextEligibleAt: 120001, position: transcriptPosition(sample), stimulus: { id: "actor-20261028T000000Z-abcdef123456", hash: "0".repeat(64) } }; }

test("the captured capacity specimen plus ended transcript permits a stopped observation", () => {
  const f = fixture(), seen = observeUnwedge(snapshot, undefined, {}, f.io);
  expect(seen.observation.verdict).toBe("severed");
  expect(seen.observation.cause).toBe("model_capacity");
  expect(seen.observation.composer).toBe("empty");
  expect(seen.observation.turnEnded).toBe(true);
  expect(unwedgeBoundaryRefusal(seen, "model_capacity")).toBe("");
});

test("all binding fields are rechecked after sampling; native and process drift refuse", () => {
  for (const key of Object.keys(snapshot.binding) as (keyof typeof snapshot.binding)[]) {
    const f = fixture(); let reads = 0;
    f.io.identity = () => ++reads === 1 ? snapshot.binding : { ...snapshot.binding, [key]: "changed" };
    expect(unwedgeBoundaryRefusal(observeUnwedge(snapshot, undefined, {}, f.io), "model_capacity")).not.toBe("");
  }
});

test("holds, unknown protection, running transcript, copy mode and unreadable samples refuse", () => {
  for (const change of [
    (io: UnwedgeReadIO) => { io.protection = () => true; },
    (io: UnwedgeReadIO) => { io.protection = () => { throw new Error("unreadable"); }; },
    (io: UnwedgeReadIO) => { io.transcript = () => null; },
    (io: UnwedgeReadIO) => { io.transcript = () => ({ ...sample, lines: [JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })] }); },
    (io: UnwedgeReadIO) => { io.frame = () => ({ text: capacity, title: "", height: 40, copyMode: true }); },
  ]) { const f = fixture(); change(f.io); expect(unwedgeBoundaryRefusal(observeUnwedge(snapshot, undefined, {}, f.io), "model_capacity")).not.toBe(""); }
});

test("only the whole exact predecessor sentinel is staged; extra input stays protected", () => {
  const f = fixture();
  // The fixture's final empty composer is replaced, retaining its captured error and footer.
  const stagedFrame = capacity.replace(/^.*›[^\n]*$/m, `› ${wire}`);
  expect(visibleSentinel(stagedFrame, "codex")).toBe(wire);
  expect(parseStuckSentinel(wire, "codex").ok).toBe(true);
  expect(readComposerFrame(stagedFrame, "codex")).toBe(wire);
  expect(composerHoldsExactly(stagedFrame, "codex", wire)).toBe(true);
  f.setFrame(stagedFrame);
  const seen = observeUnwedge(snapshot, prior(), { stagedId: prior().stimulus!.id }, f.io);
  expect(seen.observation.composer).toBe("staged");
  expect(seen.observation.stagedPayloadId).toBe(prior().stimulus!.id);
  expect(unwedgeBoundaryRefusal(seen, "model_capacity", { stagedId: prior().stimulus!.id })).toBe("");
  f.setFrame(capacity.replace(/^.*›[^\n]*$/m, `› ${wire} and a human draft`));
  expect(unwedgeBoundaryRefusal(observeUnwedge(snapshot, prior(), {}, f.io), "model_capacity")).not.toBe("");
});

test("shortcut-like user text without a known footer is preserved", () => {
  const human = `› ${wire}\n\n  ? for shortcuts\n`;
  expect(composerHoldsExactly(human, "codex", wire)).toBe(false);
  expect(readComposerFrame(human, "codex")).toContain("? for shortcuts");
});
