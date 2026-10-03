// The retained Bash submit owner passes opaque binding and pre-type/effect facts.
// All completion-key decisions and effects stay in courier.completionEnter.
import { resolve } from "node:path";
import { completionEnter, REAL_EFFECTS, type BoundRecipient, type SubmitAuthority, type SubmitResult } from "./courier";
import { loadRegistry, seatMap } from "./registry";
import { bindExplicitRemoteRegistry } from "./remote-target";
import { parseStuckSentinel } from "./stuck-sentinel";
import { isOrdinarySentinel } from "./submit-frame";
import { recordPhase, type SubmitPhase } from "./submit-phase";
import { AGENT_FAMILIES } from "./harness-families";

type Context = { pane: string; id: string; home: string; recipient: string; registry: string;
  recipientBus: string; bound: BoundRecipient; pretypeDraft: boolean };
export function prepareCompletion(args: string[], home: string): Context | null {
  const [pane = "", command = "", wire = "", id = "", recipient = "", , , registry = "", handle = "", paneId = "", , rowlessHarness = ""] = args;
  if (!isOrdinarySentinel(wire)) return null;
  const obs = REAL_EFFECTS.observePane(pane);
  if (!obs || typeof obs === "string") throw new Error("completion binding is unobservable");
  const row = registry && handle ? seatMap(loadRegistry(registry))[handle] : undefined;
  if (registry && handle && !row) throw new Error("completion recipient disappeared");
  if (paneId && obs.paneId !== paneId) throw new Error("completion pane binding changed");
  const harness = typeof row?.harness === "string" ? row.harness : rowlessHarness || command;
  const bound: BoundRecipient = { paneId: paneId || obs.paneId, serverEpoch: obs.serverEpoch,
    harness, handle, instance: String(row?.instance ?? ""), bootId: String(row?.boot_id ?? "") };
  if (row && (row.pane_id !== bound.paneId || row.server_epoch !== bound.serverEpoch)) throw new Error("completion registry binding changed");
  const band = REAL_EFFECTS.paneState(bound.paneId!, harness, command);
  return { pane, id, home, recipient, registry, bound,
    recipientBus: registry ? bindExplicitRemoteRegistry("", handle, registry).busHome : home,
    pretypeDraft: band.state === "busy" && !("queued" in band && band.queued) && !parseStuckSentinel(band.text, command).ok };
}

export function finishCompletion(args: string[]): number {
  const [raw = "null", attempted, pretype = "", wire = "", rcRaw = "5", attempt = "", countRaw = "0", ordinalRaw = "0"] = args;
  const rc = Number(rcRaw);
  let count = Number(countRaw), ordinal = Number(ordinalRaw);
  if (![rc, count, ordinal].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid completion counters");
  const ctx: Context | null = JSON.parse(raw);
  if (!ctx || attempted !== "1") return rc;
  if (!attempt || !ctx.bound?.paneId || !ctx.home || !ctx.id) throw new Error("invalid completion binding");
  const authority: SubmitAuthority = { registryPath: ctx.registry, recipient: ctx.recipient, busHome: ctx.home,
    recipientBusHome: ctx.recipientBus, scriptsDir: resolve(import.meta.dir, "../../../skills/tap/scripts"), agentFamilies: AGENT_FAMILIES };
  const phase = (name: SubmitPhase, result?: string) => {
    try { recordPhase(ctx.home, { id: ctx.id, attempt, phase: name, recipient: ctx.recipient, enter_count: count, ordinal, result }); }
    catch (error) { console.error(`tap: completion evidence unavailable: ${error}`); }
  };
  const prior: SubmitResult = rc === 0 ? { status: "injected" } : rc === 7 ? { status: "harness_queued" }
    : { status: "unverified", detail: `Bash submit returned ${rc}` };
  const priorCount = count;
  const result = completionEnter(ctx.pane, wire, prior,
    { textAttempted: true, pretypeDraft: ctx.pretypeDraft || !!pretype.trim() },
    ctx.bound, REAL_EFFECTS, authority, phase, () => { ordinal++; }, () => { count++; });
  phase("verify-result", result.status === "injected" ? "verified" : result.status === "harness_queued" ? "queued" : "unverified");
  // A withheld completion adds no effect and cannot replace a typed Bash failure.
  if (rc !== 0 && rc !== 7 && count === priorCount) return rc;
  if (result.status === "injected") return 0;
  if (result.status === "harness_queued") return 7;
  if (result !== prior) { console.error(`tap: ${result.detail}`); return 5; }
  return rc;
}
if (import.meta.main) {
  const [mode, ...args] = Bun.argv.slice(2);
  try {
    if (mode === "prepare") console.log(JSON.stringify(prepareCompletion(args, process.env.TAP_HOME ?? "")));
    else if (mode === "finish") console.log(finishCompletion(args));
    else throw new Error("expected prepare or finish");
  } catch (error) { console.error(`tap: completion Enter refused: ${error}`); console.log(mode === "prepare" ? "null" : "5"); }
}
