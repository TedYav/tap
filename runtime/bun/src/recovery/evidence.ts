import { closeSync, existsSync, fstatSync, openSync, readFileSync, opendirSync, readSync, constants } from "node:fs";
import { join } from "node:path";
import { envelopeField } from "../envelope";
import { loadGlobalRegistry } from "../index-home";
import { oldBusRefusal, resolveBus } from "../bushome";
import { pendingSentinel } from "../deliver";
import { visibleSentinel } from "../submit-frame";
import { phaseRows } from "../submit-phase";
import { validId } from "../ids";
import { harnessQueued } from "../harness-queue";
import type { ResolvedContext } from "../context";
import type { PayloadRef, RecoveryTarget } from "./state";
import { isFile } from "../watch-lease";

/** Read routing only. Product task bodies are not bundled into a repair worker's context. */
export function routingHeader(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("payload is not a regular file");
    const bytes = Buffer.alloc(65536), size = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, size).toString("utf8");
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error("routing header unavailable within bound");
    return match[0];
  } finally { closeSync(fd); }
}
export function alreadyProcessed(ref: PayloadRef): boolean {
  return ["read", "done", "cancelled"].some(suffix => isFile(join(ref.home, "receipts", `${ref.id}.${suffix}`)));
}
export function pendingEvidence(ctx: ResolvedContext, target: RecoveryTarget, frame: string): { payloads: PayloadRef[]; gaps: string[]; records: unknown[] } {
  const buses = new Map<string, string>([[ctx.bus.home, ctx.team]]);
  const global = loadGlobalRegistry();
  const gaps: string[] = [];
  if (global.marker === "invalid") gaps.push("machine index unreadable; foreign pending evidence incomplete");
  const teams = global.doc?.teams as Record<string, { root?: string; state?: string }> | undefined;
  for (const [team, item] of Object.entries(teams ?? {})) {
    if (typeof item.root !== "string" || item.state === "historical") continue;
    const bus = resolveBus(item.root, {});
    if (bus.rule === "old_store") { gaps.push(`old_store: ${oldBusRefusal(bus.home).detail}`); continue; }
    buses.set(bus.home, team);
  }
  const wire = visibleSentinel(frame, target.harness);
  const staged = wire ? pendingSentinel(wire, target.harness) : null;
  const stagedId = staged?.id.split("/").at(-1);
  const payloads: PayloadRef[] = [];
  const inspect = (home: string, team: string, bucket: string, name: string) => {
    const id = name.slice(0, -3), ref = { home, id, team };
    if (!name.endsWith(".md") || !validId(id) || alreadyProcessed(ref) || payloads.some(p => p.id === id && p.home === home)) return;
    const path = join(home, bucket, name);
    try {
      const header = routingHeader(path);
      if (envelopeField(header, "id") !== id || envelopeField(header, "to") !== target.handle ||
          (envelopeField(header, "to_team") || team) !== target.team) return;
      const instance = envelopeField(header, "recipient_instance");
      if (instance && instance !== target.instance) return;
      if (payloads.length >= 32) { gaps.push("pending bundle bounded at 32 candidates; not a complete count"); return; }
      payloads.push(ref);
    } catch { gaps.push(`unreadable routing header: ${path}`); }
  };
  // The staged id has direct priority, independent of historical directory size.
  if (stagedId && validId(stagedId)) for (const [home, team] of buses) {
    for (const bucket of ["payloads", "spool"]) if (existsSync(join(home, bucket, `${stagedId}.md`))) inspect(home, team, bucket, `${stagedId}.md`);
  }
  const scanDeadline = Date.now() + 1000;
  let visited = 0;
  scan: for (const [home, team] of buses) {
    for (const bucket of ["payloads", "spool"]) {
      const path = join(home, bucket);
      if (!existsSync(path)) continue;
      let dir;
      try { dir = opendirSync(path); }
      catch { gaps.push(`unreadable pending directory: ${path}`); continue; }
      try {
        for (;;) {
          if (visited >= 4096 || Date.now() >= scanDeadline) {
            gaps.push("pending evidence scan bounded; historical enumeration incomplete"); break scan;
          }
          const entry = dir.readSync();
          if (!entry) break;
          visited++;
          inspect(home, team, bucket, entry.name);
          if (payloads.length >= 32) { gaps.push("pending bundle bounded at 32 candidates; not a complete count"); break scan; }
        }
      } finally { dir.closeSync(); }
    }
  }
  const records = payloads.map(ref => {
    const receipts: Record<string, unknown> = {};
    for (const suffix of ["sent", "harness-queued", "unconfirmed"]) {
      try { receipts[suffix] = JSON.parse(readFileSync(join(ref.home, "receipts", `${ref.id}.${suffix}`), "utf8")); } catch { /* no receipt */ }
    }
    return { ...ref, receipts, phases: phaseRows(ref.home, ref.id).slice(-16), phaseScope: "last up to 16 complete phase rows" };
  });
  return { payloads, gaps: [...new Set(gaps)], records };
}
export function allPendingQueued(evidence: Pick<ReturnType<typeof pendingEvidence>, "payloads" | "gaps">): boolean {
  return evidence.gaps.length === 0 && evidence.payloads.length > 0 && evidence.payloads.every(ref => harnessQueued(ref.home, ref.id));
}

export function relevantDoctor(raw: string, target: RecoveryTarget, refs: PayloadRef[]): unknown {
  try {
    const doc = JSON.parse(raw);
    return { ok: doc.ok, bus: doc.bus, summary: doc.summary, findings: (doc.findings ?? []).filter((f: { name?: string; detail?: Record<string, unknown> }) =>
      ["invalid_flip", "acting_registry_unreachable", "checkout_stale"].includes(f.name || "") ||
      f.detail?.to === target.handle || f.detail?.handle === target.handle || refs.some(ref => f.detail?.id === ref.id)) };
  } catch { return { error: "doctor JSON unavailable" }; }
}
