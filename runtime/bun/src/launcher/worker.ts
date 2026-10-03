// Literal Python transport door. Mutation is always one complete transaction.
import { writeSync } from "node:fs";
import { isDict, jsonDumpBytes, parseJsonPreserving, PyFloat } from "../spool-publication";
import { Notices } from "./catalog-notices";
import { LauncherError, UNBOUND_RESUME_IDENTITY, type SessionRecord, type Invocation } from "./types";
import { buildInvocation, applyInvocationEnv, composeInvocation, launchInvocation, invocationShellCommand, resolveLoginShell, pinOpenCodeSession, InvocationError } from "./invocation";
import { resolvedResumeIdentity, resolveResumeTarget, emitResumeTargetReceipts } from "./resume-identity";
import { enforcePermissions, permissionArgv } from "./permissions";
import { resolveHarnessPolicy } from "./catalog";
import { facadeSecureRead } from "../slices/preset-api";
import { spliceTokensIfAbsent } from "./argv-splice";
import { awaitReplacedHarness, startupBlocker, type PaneFacts } from "./readiness";
import { classifySession, entrySession, verifiedSession, entryObservedDead, destructiveTarget } from "./observation";
import { launchTransaction, launchFailure, LaunchInterrupted, recordFromRow, storeRecipe, seatUpTransaction, cursorMintSession, refusePreexistingIdOnNewMint, type TransactionRequest, type FailureEvidence } from "./transaction";
import { LaunchCommandError } from "./process";
import { SelectorError } from "../selector";
import { withStartupTrace } from "../startup-trace";
import { ResumeNamingValueError } from "./naming";
import { recordKeySelection } from "./records";
import { assertUniqueHarnessSessionIdentity, cohortIdentityOwned } from "./identity-owner";

type Packet = { op: string; state?: { suppressed: boolean; said: string[] }; trace_context?: string | null; payload: Record<string, any> };

async function dispatch(packet: Packet, notices: Notices, signal: AbortSignal): Promise<unknown> {
  const p = packet.payload, env = process.env;
  const record = p.record as SessionRecord;
  const resume = Object.hasOwn(p, "resume_identity") ? p.resume_identity : UNBOUND_RESUME_IDENTITY;
  let value: unknown;
  switch (packet.op) {
    case "record-key-selection": return recordKeySelection(p.records, p.key);
    case "assert-unique-identity": assertUniqueHarnessSessionIdentity(p.records, p.target, p.action); return null;
    case "cohort-identity-owned": return cohortIdentityOwned(p.records, p.assignments);
    case "transaction": {
      const request = p as TransactionRequest;
      return launchTransaction(request, env, signal, notices);
    }
    case "build": value = buildInvocation(p.action, record, notices, env, p.initial_prompt, resume); break;
    case "native-resume": value = buildInvocation("resume", record, notices, env, null, resume, p.native_query ?? null); break;
    case "compose": value = composeInvocation(p.invocation, record, notices, env, p.notify !== false); break;
    case "invocation": value = launchInvocation(p.action, record, notices, { env, prompt: p.initial_prompt, resume, notify: p.notify !== false }); break;
    case "env": value = applyInvocationEnv(p.invocation, record, notices, env, p.notify !== false); break;
    case "splice": value = { ...p.invocation, argv: spliceTokensIfAbsent(p.invocation.argv, record.harness_passthrough ?? [], {
      floor: record.passthrough_from_config ?? false, configKeys: record.harness === "codex" }) }; break;
    case "permissions": {
      const policy = resolveHarnessPolicy(p.harness, env, notices, facadeSecureRead);
      record.permissions = policy.permissions;
      value = permissionArgv(p.harness, policy.permissions, env); break;
    }
    case "enforce":
      try { enforcePermissions(p.harness, p.mode, p.argv, env); return null; }
      catch (error) { if (error instanceof LauncherError) throw new InvocationError(error.message); throw error; }
    case "opencode-pin": return pinOpenCodeSession(p.argv, p.session_id);
    case "shell-command": return invocationShellCommand(p.invocation as Invocation, env);
    case "login-shell": return resolveLoginShell(env);
    case "resume-identity": return resolvedResumeIdentity(record, env, p.emit_receipts ? line => process.stderr.write(`${line}\n`) : undefined);
    case "resume-target": return resolveResumeTarget(record, env);
    case "resume-receipts": emitResumeTargetReceipts(record, p.target, line => process.stderr.write(`${line}\n`)); return null;
    case "startup-blocker": return startupBlocker(p.facts as PaneFacts, p.harness, env, signal);
    case "await-harness": {
      const timeout = p.timeout instanceof PyFloat ? p.timeout.value : p.timeout;
      if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) throw new InvocationError("invalid harness readiness timeout");
      return (await awaitReplacedHarness({ ...p, timeout } as Parameters<typeof awaitReplacedHarness>[0], env, signal)).ready;
    }
    case "classify-session": return classifySession(p.name, env, signal);
    case "entry-session": return entrySession(p.entry, env, signal);
    case "verified-session": return verifiedSession(p.entry, env, signal, p.strict === true);
    case "entry-absent": return entryObservedDead(p.entry, env, signal);
    case "confirmed-target": return destructiveTarget(p.entry, p.expected, env, signal);
    case "record-from-row": return recordFromRow(p.handle, p.entry, p.team, p.root);
    case "store-recipe": storeRecipe(p.entry, record); value = p.entry; break;
    case "cursor-mint": return cursorMintSession(p.cwd, env, signal);
    case "refuse-preexisting-id": refusePreexistingIdOnNewMint(record); return null;
    case "seat-up": {
      const result = await seatUpTransaction(p.argv, env, signal);
      process.stdout.write(JSON.stringify({ ok: true, handle: p.argv[2], session: result.record.name, outcome: "resumed" }) + "\n");
      return result.code;
    }
    case "legacy-failure": {
      const argv = p.argv;
      if (!Array.isArray(argv) || argv.length !== (p.owned ? 4 : 3)) return 2;
      try {
        const record = parseJsonPreserving(argv[p.owned ? 2 : 1]);
        if (!isDict(record) || typeof record.name !== "string" || typeof record.harness !== "string" || typeof record.cwd !== "string") return 2;
      } catch { return 2; }
      process.stderr.write("tap session: legacy launch failure callback has no token/instance/created-vessel proof; residue retained; next: tap doctor\n");
      return 0;
    }
    default: throw new Error(`unknown launcher worker operation ${packet.op}`);
  }
  return { value, permissions: record.permissions ?? null };
}

export async function bridgeWorker(fd: number): Promise<number> {
  const controller = new AbortController();
  let terminal = false, armed = false, buffer = "";
  const cancel = (code: number) => { if (!terminal && !controller.signal.aborted) controller.abort(new LaunchInterrupted(code)); };
  const onInt = () => cancel(130), onTerm = () => cancel(143);
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const notices = new Notices();
  try {
    const packet = await new Promise<Packet>((resolve, reject) => {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        if (armed) return;
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = parseJsonPreserving(buffer.slice(0, newline));
          if (!isDict(value) || typeof value.op !== "string" || !isDict(value.payload)) throw new Error("invalid launcher worker packet");
          armed = true; buffer = "";
          resolve(value as Packet);
        } catch (error) { reject(error); }
      });
      process.stdin.once("end", () => {
        if (armed) cancel(143); else reject(new Error("truncated launcher worker request"));
      });
      process.stdin.once("error", reject);
    });
    if (packet.state) notices.restore(packet.state);
    let trace: { active: boolean; fields: Record<string, unknown> } | null = null;
    try {
      const parsed = packet.trace_context ? JSON.parse(packet.trace_context) : null;
      if (isDict(parsed) && typeof parsed.active === "boolean" && isDict(parsed.fields)) trace = { active: parsed.active, fields: parsed.fields };
    } catch { /* Malformed diagnostic context cannot change the operation. */ }
    let response: unknown;
    try {
      controller.signal.throwIfAborted();
      const work = () => dispatch(packet, notices, controller.signal);
      const value = trace?.active ? await withStartupTrace(work, trace.fields) : await work();
      response = { ok: true, value, state: notices.capture() };
    } catch (error) {
      if (error instanceof LaunchInterrupted) response = { ok: false, state: notices.capture(), error: { kind: "interrupted", code: error.exitCode, message: error.message } };
      else if (error instanceof LauncherError && error.errorClass) response = { ok: false, state: notices.capture(), error: {
        kind: "preset", error_class: error.errorClass, action: error.action ?? "", detail: error.detail ?? error.message } };
      else if (error instanceof ResumeNamingValueError) response = { ok: false, state: notices.capture(), error: { kind: "value", message: error.message } };
      else if (error instanceof InvocationError) response = { ok: false, state: notices.capture(), error: { kind: "launcher", message: error.message } };
      else if (error instanceof SelectorError) response = { ok: false, state: notices.capture(), error: {
        kind: "launcher", message: `${error.errorClass}: ${error.detail}; next: ${error.action}` } };
      else if (error instanceof LaunchCommandError) response = { ok: false, state: notices.capture(), error: {
        kind: "command", code: error.result.code, argv: error.argv, stdout: error.result.stdout, stderr: error.result.stderr } };
      else if ((error as NodeJS.ErrnoException).code === "ENOENT") response = { ok: false, state: notices.capture(), error: { kind: "missing", message: (error as Error).message } };
      else throw error;
    }
    // All transaction custody has ended before the completion handshake. EOF
    // caused by the parent's orderly finalizer cannot reverse this verdict.
    terminal = true;
    Object.assign(response as object, { trace_context: trace ? JSON.stringify(trace) : null });
    writeSync(fd, jsonDumpBytes(response) + "\n");
    return 0;
  } finally {
    terminal = true;
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    process.stdin.pause();
    process.stdin.destroy();
  }
}

if (import.meta.main) {
  try {
    const [mode, arg] = process.argv.slice(2);
    if (mode === "bridge" && /^\d+$/.test(arg ?? "") && Number(arg) >= 3) process.exitCode = await bridgeWorker(Number(arg));
    else if (mode === "failure" && arg) {
      const evidence = parseJsonPreserving(arg);
      if (!isDict(evidence)) throw new Error("invalid launch failure evidence");
      await launchFailure(evidence as FailureEvidence);
    } else if (mode === "legacy-failure") {
      process.stderr.write("tap session: legacy launch failure callback has no token/instance/created-vessel proof; residue retained; next: tap doctor\n");
    } else throw new Error("invalid launcher worker invocation");
  } catch (error) {
    process.stderr.write(`tap session: launcher worker failed: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
