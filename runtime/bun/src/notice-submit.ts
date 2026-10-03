import {recordHarnessQueued} from "./harness-queue";
// One-shot notice wake: publication is owned by the existing notice publisher.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { Bus } from "./bus";
import { submitVerify, type BoundRecipient, type SubmitAuthority, type SubmitResult } from "./courier";
import { encodeAttemptRows, type AttemptBeginRow, type AttemptOutcomeRow } from "./courier-contract";
import { envelopeField } from "./envelope";
import { atomicWrite, receiptBytes } from "./fsatomic";
import { validId, utcStamp } from "./ids";
import { loadRegistry, seatMap } from "./registry";
import { renderSentinel } from "./sentinel";
import { AGENT_FAMILIES } from "./harness-families";
import { tapScriptsDir } from "./scripts-dir";

export interface NoticeSubmitInput {
  bus: Bus;
  kind?: "notice";
  id: string;
  pane: string;
  bound: BoundRecipient;
  authority: SubmitAuthority;
}

/** Begin before preflight is conservative: it permits no automatic second wake. */
export function submitNotice(input: NoticeSubmitInput, submit: typeof submitVerify = submitVerify): SubmitResult {
  const { bus, id, pane, bound, authority } = input;
  const kind = input.kind ?? "delivery-failed";
  if (!validId(id) || !bound.handle || !bound.paneId || !authority.registryPath) {
    return { status: "unverified", detail: "notice submit requires a valid id and bound sender registry identity" };
  }
  const raw = readFileSync(bus.payloadPath(id), "utf8");
  if (envelopeField(raw, "id") !== id || envelopeField(raw, "from") !== "courier" ||
      envelopeField(raw, "kind") !== kind || envelopeField(raw, "to") !== bound.handle) {
    return { status: "unverified", detail: "canonical is not the bound sender's courier notice" };
  }
  const sentinel = renderSentinel({ id, from: envelopeField(raw, "from")!, to: bound.handle,
    kind, reply: "settle-only", path: bus.payloadPath(id) });
  const base = { v: 1 as const, payload_id: id, attempt_id: randomUUID(), seq: 1, rung: 1,
    op: "deliver" as const, driver: "tmux" as const, class: "sender-notice", native_ref: "",
    ts_start: utcStamp(), detail: "one-shot notice wake; conservative begin before submit preflight" };
  const begin: AttemptBeginRow = { ...base, phase: "begin", disposition: "attempt-begin",
    effect: "possible", tier: "none", ts_end: null };
  let fd: number | undefined;
  try {
    // Exclusive create also refuses empty, torn, unreadable and symlink evidence.
    fd = openSync(bus.payloadPath(id).replace(/\.md$/, ".attempts"), "wx", 0o600);
    writeFileSync(fd, encodeAttemptRows([begin]));
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return { status: "unverified", detail: `notice attempt cannot start; existing evidence or persistence failure: ${error}` };
  }
  try {
    let result: SubmitResult;
    try { result = submit(pane, id, sentinel, bound, authority); }
    catch (error) { result = { status: "unverified", detail: `notice submit interrupted: ${error}` }; }
    const outcome: AttemptOutcomeRow = { ...base, seq: 2, phase: "outcome",
      disposition: result.status === "injected" ? "delivered" : result.status === "harness_queued" ? "harness-queued" : "unconfirmed", effect: "possible",
      tier: result.status === "injected" ? "left-input-band" : "none", ts_end: utcStamp(),
      detail: `submit status=${result.status}; ${"detail" in result ? result.detail : "sentinel left input band"}. Attempt envelope is conservative; it does not assert preflight took pane effects.` };
    writeFileSync(fd, encodeAttemptRows([outcome]));
    fsyncSync(fd);
    if (result.status === "injected") {
      atomicWrite(bus.sentPath(id), receiptBytes({ id, from: "courier", to: bound.handle, pane,
        kind, via: "notice", delivery: "pane", turn: "unconfirmed" }));
    }
    if(result.status === "harness_queued") recordHarnessQueued(bus.home,id);
    return result;
  } catch (error) {
    return { status: "unverified", detail: `notice result persistence failed; attempt retained: ${error}` };
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  try {
    const [home, id, pane, paneId, registryPath, sender] = Bun.argv.slice(2);
    if (!home || !id || !pane || !paneId || !registryPath || !sender) throw new Error("notice submit arguments required");
    const row = seatMap(loadRegistry(registryPath))[sender];
    if (!row) throw new Error("sender is absent from bound registry");
    const result = submitNotice({ bus: new Bus(home), id, pane,
      bound: { paneId, handle: sender, instance: String(row.instance ?? ""), bootId: String(row.boot_id ?? ""),
        serverEpoch: String(row.server_epoch ?? ""), harness: String(row.harness ?? "") },
      authority: { registryPath, recipient: sender, busHome: home, agentFamilies: AGENT_FAMILIES,
        scriptsDir: tapScriptsDir() } });
    // A valid refusal is data; tap_bun_call's nonzero status means slice failure.
    console.log(JSON.stringify(result));
  } catch (error) { console.error(String(error)); process.exit(2); }
}
