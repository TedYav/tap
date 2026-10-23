import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { callingPane, resolveContext, resolveSelf, TapError } from "../context";
import { acquireRegistryLock } from "../panelock";
import { loadRegistry, saveRegistry, seatMap } from "../registry";
import { prepareForwarding } from "../forwarding";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { assertSelectionCurrent } from "../selector";
import { mintId, utcStamp, validToken } from "../ids";
import { atomicWrite } from "../fsatomic";
import { stampEnvelope } from "../envelope";
import { submitNotice } from "../notice-submit";
import { AGENT_FAMILIES } from "./team";
import { cmdOutRetire } from "../out-retire";
import { assertSharedStopCleared } from "../opencode-shared-stop";

// Test-only process interruption at either side of the atomic registry rename.
function publicationBarrier(stage: string): void {
  const path = process.env.TAP_FORWARDING_TEST_BARRIER;
  if (!path || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_FORWARDING_TEST_STAGE !== stage) return;
  writeFileSync(path + ".ready", stage);
  const deadline = Date.now() + 10000;
  while (!existsSync(path + ".continue") && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(path + ".continue")) throw new Error("forwarding scratch barrier timed out");
}

// Forwarding keeps its owner here; every other form (plain, dash, kill) is
// the ordinary retirement owner. One dispatch choice at the entry, no
// transaction policy copied into this file.
export function cmdOut(argv: string[], scriptsDir: string): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--forward-to") return cmdOutForwarding(argv, scriptsDir);
  }
  return cmdOutRetire(argv);
}

function cmdOutForwarding(argv: string[], scriptsDir: string): number {
  let source = "", destination = "", pane = "", json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--forward-to") destination = argv[++i] ?? "";
    else if (arg === "--pane") pane = argv[++i] ?? "";
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("-") && !source) source = arg;
    else throw new TapError(1, "usage_error", "tap out [source] --forward-to <seat>", `unsupported forwarding argument '${arg}'`);
  }
  const ctx = resolveContext();
  if (!source) {
    const caller = pane || callingPane();
    if (!caller) throw new TapError(1, "identity_unverified", "tap out <source> --forward-to <seat>", "cannot resolve caller; name the source seat");
    source = resolveSelf(ctx, caller, 1).handle;
  }
  if (!validToken(source) || !validToken(destination)) throw new TapError(1, "usage_error", "tap out [source] --forward-to <seat>", "source and destination must be same-team bare handles");
  ctx.bus.ensureDirs();
  const reset = acquireResetMutationLock(ctx.bus.home, "tap out --forward-to", undefined, "shared");
  let record;
  try {
    const lock = acquireRegistryLock(ctx.registryPath);
    if (!lock) throw new TapError(1, "registry_lock_busy", "retry the handoff", "acting registry is busy; no retirement published");
    try {
      if (ctx.selection) assertSelectionCurrent(ctx.selection, lock);
      const original = loadRegistry(ctx.registryPath);
      if (seatMap(original)[source]) assertSharedStopCleared(ctx.root, seatMap(original)[source]!);
      const transition = prepareForwarding(original, source, destination, utcStamp());
      const event = mintId("forward");
      const history = join(ctx.root, ".tap", "team-history", `${source}.${event}.json`);
      // Normal out history stays addressable by --list-history / --restore.
      // Prepare it before retirement; a crash here leaves the current row intact.
      saveRegistry(history, { handle: source, instance: transition.record.source_instance,
        retired_by: event, retired_at: transition.record.at, row: seatMap(original)[source],
        forwarded_to: { handle: destination, instance: transition.record.destination_instance } });
      // Mark first: a failed mark must never leave a reported failed transition
      // whose source has already retired. The registry rename publishes both halves.
      markResetGenerationReused(ctx.bus.home, "seat-forwarding");
      publicationBarrier("before");
      try { saveRegistry(ctx.registryPath, transition.doc); }
      catch (error) {
        try { unlinkSync(history); }
        catch (cleanup) { process.stderr.write(`tap out: retirement failed; prepared history remains at ${history}: ${cleanup}\n`); }
        throw error;
      }
      publicationBarrier("after");
      record = transition.record;
    } finally { lock.release(); }
  } finally { reset.release(); }

  // Notification is a separate, one-shot effect. Its failure cannot roll back
  // custody or authorize repeating the retirement or any original delivery.
  let notice = "", notification = "failed";
  try {
    notice = mintId("courier");
    const raw = stampEnvelope("---\n---\n" +
      `Mail handoff: ${source} (${record.source_instance}) retired to ${destination} (${record.destination_instance}).\n\n` +
      `Discover delegated inbound with tap poll ${destination}; discover predecessor outbound with tap outstanding ${destination}.\n` +
      `Original payloads and receipts are unchanged. Read and reply as ${destination}; handoff does not settle or replay work.\n` +
      "Lane ownership and watch leadership require their own explicit handoff commands.\n", {
      id: notice, from: "courier", to: destination, recipient_instance: record.destination_instance,
      kind: "notice", reply: "settle-only", path: ctx.bus.payloadPath(notice),
    });
    const noticeReset = acquireResetMutationLock(ctx.bus.home, "seat-forwarding notification", undefined, "shared");
    try { atomicWrite(ctx.bus.payloadPath(notice), raw); markResetGenerationReused(ctx.bus.home, "seat-forwarding-notice"); }
    finally { noticeReset.release(); }
    const row = seatMap(loadRegistry(ctx.registryPath))[destination];
    notification = "canonical; discover with tap poll";
    if (row?.instance === record.destination_instance && row.delivery !== "poll" && typeof row.pane === "string" && typeof row.pane_id === "string") {
      const result = submitNotice({ bus: ctx.bus, id: notice, pane: row.pane, kind: "notice",
        bound: { handle: destination, instance: record.destination_instance, paneId: row.pane_id,
          harness: String(row.harness ?? ""), bootId: String(row.boot_id ?? ""), serverEpoch: String(row.server_epoch ?? "") },
        authority: { registryPath: ctx.registryPath, recipient: destination, busHome: ctx.bus.home, scriptsDir, agentFamilies: AGENT_FAMILIES } });
      notification = result.status;
    }
  } catch (error) { process.stderr.write(`tap out: handoff committed; notification failed: ${error}. Do not repeat retirement.\n`); }
  if (json) console.log(JSON.stringify({ ok: true, forwarding: record, notification, notice_id: notice || null }));
  else console.log(`tap out: ${source} retired; mail custody delegated to ${destination}. Notification: ${notification}.\nNext: tap poll ${destination}; tap outstanding ${destination}. Lane/watch ownership requires explicit handoff.`);
  return 0;
}
