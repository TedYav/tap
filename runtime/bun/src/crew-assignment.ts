import { TapError, type ResolvedContext } from "./context";
import { AGENT_FAMILIES } from "./harness-families";
import { loadRegistry, seatMap, type RegistryDoc } from "./registry";
import { cmdSend } from "./verbs/send";
import { shellQuote } from "./slices/message-construction";

export interface CreatedCrew {
  handle: string; instance: string; pane: string; owner: string; ownerInstance: string;
  harness: string; model: string; preset: string; configDigest: string;
}

/** Recheck the created row at send's authorization and publication boundaries. */
function verifyCreatedCrew(doc: RegistryDoc, expected: CreatedCrew, team: string, recovery: string): void {
  const row = seatMap(doc)[expected.handle];
  const fail = (detail: string): never => {
    throw new TapError(1, "crew_assignment_unverified", recovery,
      `started ${team}/${expected.handle}, not assigned: ${detail}; do not rerun crew add`);
  };
  if (!row) return fail("the created crew row disappeared");
  if ((row.crew !== true && row.crew !== 1) || row.instance !== expected.instance
    || row.pane_id !== expected.pane || row.status !== "active"
    || row.crew_owner !== expected.owner || row.crew_owner_instance !== expected.ownerInstance)
    fail("the created crew row or parent binding changed");
  if (row.harness !== expected.harness || row.model !== expected.model) fail("the recorded harness or model differs from the launch");
  const preset = row.preset as Record<string, unknown> | null | undefined;
  if (expected.preset ? !preset || preset.name !== expected.preset || preset.config_digest !== expected.configDigest : preset != null)
    fail("the recorded preset differs from the launch");
  const capture = row.crew_identity_capture as Record<string, unknown> | undefined;
  if (capture?.decision !== "accepted" || !capture.observed_harness_session_id
    || capture.observed_harness_session_id !== row.harness_session_id)
    fail(`native identity capture is ${String(capture?.decision ?? "not_started")}, not a matching accepted identity`);
}

export function assignCreatedCrew(ctx: ResolvedContext, expected: CreatedCrew, brief: string,
  replyTo: string, scriptsDir: string): number {
  const retry = `tap assign ${expected.handle} -f ${shellQuote(brief)}${replyTo ? ` --reply-to ${shellQuote(replyTo)}` : ""}`;
  const verify = (doc: RegistryDoc) => verifyCreatedCrew(doc, expected, ctx.team,
    `inspect the existing crew with tap team; after its identity is verified and capture accepted, run ${retry}`);
  verify(loadRegistry(ctx.registryPath));
  const previous = process.env.TAP_ASSIGN_VERB;
  process.env.TAP_ASSIGN_VERB = "1";
  try {
    const code = cmdSend([expected.handle, "--from", expected.owner, "-f", brief,
      ...(replyTo ? ["--reply-to", replyTo] : []), "--expect-reply", "--kind", "order"], scriptsDir, AGENT_FAMILIES,
    { senderContext: ctx, expectedSenderInstance: expected.ownerInstance, recipientInstance: expected.instance, reauthorize: verify });
    if (code !== 0) process.stderr.write(`tap crew add: ${ctx.team}/${expected.handle} is started; assignment not confirmed; inspect tap outstanding ${expected.owner} before retrying the assignment; do not rerun crew add\n`);
    return code;
  } catch (error) {
    if (error instanceof TapError && error.errorClass === "crew_assignment_unverified") throw error;
    const known = error instanceof TapError ? error : undefined;
    throw new TapError(known?.code ?? 1, "crew_assignment_failed", known?.action || `tap outstanding ${expected.owner}`,
      `started ${ctx.team}/${expected.handle}; assignment not confirmed: ${known?.detail || String(error)}; do not rerun crew add`);
  } finally {
    if (previous === undefined) delete process.env.TAP_ASSIGN_VERB;
    else process.env.TAP_ASSIGN_VERB = previous;
  }
}
