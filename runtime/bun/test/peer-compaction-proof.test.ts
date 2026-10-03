import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REAL_EFFECTS, type SubmitResult } from "../src/courier";
import { submitPeer, type PeerProofEffects } from "../src/verbs/compact-peer-submit";
import type { PeerSubmit } from "../src/verbs/compact";
import { proofFixture } from "./fixtures/compaction-proof";
import { removeScratchTree } from "./support/scratch";

const root = mkdtempSync(join(process.env.TAP_HOME!, "peer-proof-"));
afterAll(() => removeScratchTree(root));
function fixture(mode: "claude" | "opencode", missing = false, result: SubmitResult = { status: "injected" }) {
  const f = proofFixture(root, mode, Date.now()), id = crypto.randomUUID();
  const registry = join(root, `${id}.registry.json`), handoff = join(root, `${id}.resume.txt`), receipt = join(root, `${id}.receipt.json`);
  const seat = { ...f.seat, instance: "peer-instance", pane_id: "%4", server_epoch: "epoch", status: "active" };
  const save = () => writeFileSync(registry, JSON.stringify({ schema: "0.20", seats: { peer: seat } }));
  save(); writeFileSync(handoff, "preserve the active review");
  const request: PeerSubmit = { pane: "%4", paneId: "%4", id, text: "/compact [[sv:fixture]]", target: "peer",
    session: "tmux-session", rowHarness: mode, family: mode, serverEpoch: "epoch", bootId: "", instance: "peer-instance",
    registry, busHome: root, scriptsDir: "", nativeSession: f.boundary.session, transcript: f.path, proofReceipt: receipt,
    handoff, initiator: "lead", initiatorInstance: "lead-instance", team: "fixture" };
  let time = Date.now();
  const log: string[] = [];
  const fx: PeerProofEffects = {
    pane: { ...REAL_EFFECTS, pressEnter: () => { log.push("Enter"); return true; } },
    submit: (_pane, _id, _text, _bound, authority, effects) => {
      expect(authority?.singleEnter).toBe(true);
      expect(authority?.expectedNativeSession).toBe(request.nativeSession);
      effects!.pressEnter("%4");
      return result;
    },
    send: (args, _scripts, _families, options) => {
      log.push("send");
      expect(JSON.parse(readFileSync(receipt, "utf8")).state).toBe("compacted");
      expect(args).toContain(handoff);
      options?.reauthorize?.(JSON.parse(readFileSync(registry, "utf8")));
      return { rc: 0, disposition: "queued-spool" };
    },
    now: () => time,
    wait: async () => { time += 100; if (!missing) f.summary(time); },
  };
  return { f, request, fx, seat, save, log, receipt: () => JSON.parse(readFileSync(receipt, "utf8")) };
}

for (const mode of ["claude", "opencode"] as const) {
  test(`${mode} peer sends only after fresh durable proof, including unverified submits`, async () => {
    const f = fixture(mode, false, { status: "unverified", detail: "possible effect" });
    expect(await submitPeer(f.request, f.fx, 300, 0)).toBe(0);
    expect(f.log).toEqual(["Enter", "send"]);
    expect(f.receipt()).toMatchObject({ state: "resume-sent", evidence: mode === "claude" ? "transcript-proven" : "store-proven" });
  });
  test(`${mode} peer timeout sends nothing and preserves its handoff`, async () => {
    const f = fixture(mode, true);
    expect(await submitPeer(f.request, f.fx, 300, 0)).toBe(1);
    expect(f.log).toEqual(["Enter"]);
    expect(f.receipt()).toMatchObject({ state: "not-compacted", handoff: f.request.handoff });
    expect(readFileSync(f.request.handoff, "utf8")).toBe("preserve the active review");
  });
  test(`${mode} peer cannot skip the Enter boundary`, async () => {
    const f = fixture(mode);
    f.fx.submit = () => ({ status: "injected" });
    expect(await submitPeer(f.request, f.fx, 300, 0)).toBe(1);
    expect(f.log).toEqual([]);
    expect(f.receipt().state).toBe("not-compacted");
  });
}

test("native-session replacement during proof or at delivery prevents a peer wake", async () => {
  for (const at of ["proof", "placement"]) {
    const f = fixture("claude"), wait = f.fx.wait;
    if (at === "proof") f.fx.wait = async () => { await wait(); f.seat.harness_session_id = "new"; f.save(); };
    else f.fx.send = (_args, _scripts, _families, options) => {
      f.seat.harness_session_id = "new"; f.save();
      options!.reauthorize!(JSON.parse(readFileSync(f.request.registry, "utf8")));
      throw new Error("must refuse before delivery");
    };
    expect(await submitPeer(f.request, f.fx, 300, 0)).toBe(at === "proof" ? 1 : 6);
    expect(f.log).toEqual(["Enter"]);
    expect(f.receipt().state).toBe(at === "proof" ? "incomplete" : "resume-miss");
  }
});
