// Peer submission and proof run in compact's cancellable child. A peer can
// finish its own turn while this child waits; no detached observer is needed.
import { readFileSync } from "node:fs";
import { submitVerify, type BoundRecipient, type PaneEffects } from "../courier";
import { DARK_EFFECTS } from "../deliver";
import { agentFamilies } from "../observe";
import { draftEffects } from "../spool-drain-effects";
import { loadCurrentRegistry, seatMap } from "../registry";
import { sameSeat } from "../self-rebrief";
import { atomicWrite } from "../fsatomic";
import { compactionWitnessPath, captureCompactionBoundary, compactionEnterEffects, waitForCompactionProof, type CompactionBoundary } from "../compaction-proof";
import { cmdSendOutcome } from "./send";
import { AGENT_FAMILIES } from "./team";
import type { PeerSubmit } from "./compact";

export interface PeerProofEffects {
  submit: typeof submitVerify;
  pane: PaneEffects;
  send: typeof cmdSendOutcome;
  now(): number;
  wait(): Promise<void>;
}

/** 0 requires durable proof; submission acceptance by itself never authorizes a follow-up. */
export async function submitPeer(request: PeerSubmit, fx: PeerProofEffects = {
  submit: submitVerify, pane: draftEffects(DARK_EFFECTS), send: cmdSendOutcome, now: Date.now, wait: () => Bun.sleep(250),
}, timeout?: number, spacingMs = 2000): Promise<number> {
  const bound: BoundRecipient = { paneId: request.paneId, serverEpoch: request.serverEpoch, harness: request.rowHarness || request.family,
    handle: request.target, bootId: request.bootId, instance: request.instance || undefined };
  const row = () => seatMap(loadCurrentRegistry(request.registry))[request.target];
  const valid = () => {
    const current = row();
    return sameSeat({ bound }, current) && current?.harness_session_id === request.nativeSession && compactionWitnessPath(request.family, current) === request.transcript;
  };
  const record = (state: string, detail: string, extra: object = {}) => atomicWrite(request.proofReceipt,
    JSON.stringify({ id: request.id, target: request.target, state, detail, at: new Date().toISOString(), handoff: request.handoff, ...extra }) + "\n");
  try {
    record("armed", "peer compact submission and proof pending");
    if (request.family !== "claude" && request.family !== "opencode") throw new Error("unsupported peer compaction witness");
    if (!valid()) throw new Error("peer seat or native-session binding changed before submission");
    if (!readFileSync(request.handoff, "utf8").trim()) throw new Error("peer resume handoff is empty");
    const seat = row()!;
    captureCompactionBoundary(request.family, seat); // Refuse unreadable proof before staging.
    let boundary: CompactionBoundary | undefined;
    const effects = compactionEnterEffects(request.family, seat, fx.pane, captured => { boundary = captured; });
    const result = fx.submit(request.pane, request.id, request.text, bound,
      { preserveDraft: false, registryPath: request.registry, recipient: request.target, busHome: request.busHome,
        agentFamilies: new Set(agentFamilies()), scriptsDir: request.scriptsDir, singleEnter: true,
        expectedNativeSession: request.nativeSession }, effects);
    const accepted = result.status === "injected" || result.status === "harness_queued";
    if (!accepted && "detail" in result) process.stderr.write(`tap: ${result.detail}\n`);
    if (!boundary || (!accepted && result.status !== "unverified")) {
      record("not-compacted", `submission ${result.status}; no Enter proof boundary; handoff preserved; nothing further sent`);
      return 1;
    }
    record(accepted ? "submitted" : "submission-unverified", "awaiting fresh compaction proof; no automatic retry");
    const seconds = Number(process.env.TAP_SELF_COMPACT_TIMEOUT_SECONDS);
    const limit = timeout ?? (Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 600000);
    const proof = await waitForCompactionProof(boundary, { valid, wait: fx.wait, now: fx.now }, limit);
    if (!proof) {
      record("not-compacted", "no fresh compaction proof; handoff preserved; nothing further sent; no automatic retry");
      return 1;
    }
    record("compacted", "fresh native completion record observed; follow-up not yet sent", proof);
    // Keep recipient/native-session authority through actual envelope placement,
    // not merely the caller's check before a child or spacing delay.
    await Bun.sleep(spacingMs);
    try {
      if (!valid()) throw new Error("native binding changed before follow-up");
      const outcome = fx.send([request.target, "-f", request.handoff, "--from", request.initiator, "--fyi", "--wake"],
        request.scriptsDir, AGENT_FAMILIES, { explicitTeam: request.team,
          expectedSenderInstance: request.initiatorInstance, quiet: true,
          reauthorize: registry => {
            const current = seatMap(registry)[request.target];
            if (!sameSeat({ bound }, current) || current?.harness_session_id !== request.nativeSession || compactionWitnessPath(request.family, current) !== request.transcript) {
              throw new Error("peer compact native binding changed before follow-up placement");
            }
          } });
      record(outcome.rc ? "resume-miss" : "resume-sent", `follow-up ${outcome.disposition}; recipient read is unverified`, proof);
      return outcome.rc ? 6 : 0;
    } catch (error) {
      record("resume-miss", `${error}; handoff preserved; no automatic retry`, proof);
      return 6;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try { record("incomplete", `${detail}; handoff preserved; nothing further sent`); } catch { /* stderr is the remaining receipt */ }
    process.stderr.write(`tap compact: ${detail}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await submitPeer(JSON.parse(await Bun.stdin.text()) as PeerSubmit));
