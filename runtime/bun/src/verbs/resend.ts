import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TapError, observeCallingPane, resolveSelf, type ResolvedContext } from "../context";
import { ensureAscii, writeAllSync } from "../fsatomic";
import { mintId, utcStamp, validId, validToken } from "../ids";
import { describeResendFailure, formatResendResult, ResendReceiptError } from "../resend-format";
import { lockRoot, acquireObligationLock, acquirePathLock, type PaneLock } from "../panelock";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { enrolledSeatForObservedPane, seatMap } from "../registry";
import { isFile } from "../watch-lease";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { isDict, jsonDumpBytes, parseJsonPreserving, PyFloat, PyInt, pyTruthy } from "../spool-publication";
import { rawPreview } from "../sentinel-preview";
import { claimAcquire, claimRelease, pyPrint } from "../spool-sidecar";
import { bunBinary } from "../courier-argv";
import { runtimeModule } from "../scripts-dir";

/** A failed successor: the router renders the one text line; --json prints `body`, the standard envelope plus recovery. */
class ResendFailure extends TapError {
  constructor(code: number, errorClass: string, action: string, detail: string, readonly body: Record<string, unknown>) { super(code, errorClass, action, detail); }
}
class GuardRefusal extends Error {
  constructor(readonly errorClass: string, detail: string) { super(detail); }
}
function refuse(code: string, detail: string): never { throw new GuardRefusal(code, detail); }

// json.loads(bytes) detects UTF-8/16/32, including BOM-less zero-byte prefixes.
function jsonText(bytes: Buffer): string {
  let width = 1, little = false, skip = 0;
  if (bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))) { width = 4; little = true; skip = 4; }
  else if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) { width = 4; skip = 4; }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { width = 2; little = true; skip = 2; }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { width = 2; skip = 2; }
  else if (bytes.length >= 4 && bytes[0] === 0) width = bytes[1] === 0 ? 4 : 2;
  else if (bytes.length >= 4 && bytes[1] === 0) { width = bytes[2] === 0 && bytes[3] === 0 ? 4 : 2; little = true; }
  else if (bytes.length === 2 && (bytes[0] === 0 || bytes[1] === 0)) { width = 2; little = bytes[1] === 0; }
  if (width === 1) {
    // Python's binary JSON decoder uses surrogatepass; TextDecoder otherwise
    // refuses encoded lone surrogates even in an unrelated carried field.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let start = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0, text = "";
    for (let i = start; i + 2 < bytes.length; i++) {
      if (bytes[i] !== 0xed || bytes[i + 1]! < 0xa0 || bytes[i + 1]! > 0xbf || (bytes[i + 2]! & 0xc0) !== 0x80) continue;
      text += decoder.decode(bytes.subarray(start, i)) + String.fromCharCode(0xd000 | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f));
      start = i + 3; i += 2;
    }
    return text + decoder.decode(bytes.subarray(start));
  }
  if ((bytes.length - skip) % width) throw new Error("truncated JSON encoding");
  let text = "";
  for (let i = skip; i < bytes.length; i += width) {
    const cp = width === 2 ? (little ? bytes.readUInt16LE(i) : bytes.readUInt16BE(i))
      : (little ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i));
    text += String.fromCodePoint(cp); // Python's surrogatepass keeps lone surrogates.
  }
  return text;
}
function readJson(path: string): Record<string, unknown> {
  try {
    const value = parseJsonPreserving(jsonText(readFileSync(path)));
    if (!isDict(value)) throw new Error("expected an object");
    return value;
  } catch (error) { return refuse("effect_unknown", `cannot read evidence ${basename(path)}: ${(error as Error).message}`); }
}
function envelope(data: Buffer): { fields: Map<string, string>; body: Buffer } {
  const fence = data.indexOf("\n---\n", 3);
  if (!data.subarray(0, 4).equals(Buffer.from("---\n")) || fence < 0) refuse("invalid_payload", "missing frontmatter fences");
  const fields = new Map<string, string>();
  const decode = (s: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(s);
  // bytes.splitlines(), unlike str.splitlines(), splits only CR/LF/CRLF.
  for (const line of data.subarray(4, fence).toString("latin1").split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = decode(Buffer.from(line.slice(0, colon), "latin1"));
    if (fields.has(name)) refuse("invalid_payload", `duplicate field ${name}`);
    fields.set(name, decode(Buffer.from(line.slice(colon + 1).replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ""), "latin1")));
  }
  return { fields, body: data.subarray(fence + 5) };
}
// Exclusive final names are forensic artifacts even when a write/fsync fails.
// Private like every other bus payload writer (fsatomic.atomicWrite's 0o600).
function publish(path: string, data: Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeAllSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function publishJson(path: string, value: Record<string, unknown>): void { publish(path, Buffer.from(jsonDumpBytes(value))); }
function unlinkIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function retractionAdvice(bus: string, id: string, source?: string): string {
  if (existsSync(join(bus, "receipts", `${id}.done`))) return `it is already settled; inspect it with: tap show ${id}`;
  const cancelled = join(bus, "receipts", `${id}.cancelled`);
  if (existsSync(cancelled)) {
    let via = "cancelled", successor = "";
    try {
      const rec = readJson(cancelled);
      via = pyPrint(pyTruthy(rec.via) ? rec.via : "cancelled");
      successor = pyPrint(pyTruthy(rec.superseded_by) ? rec.superseded_by : "");
    } catch { /* unreadable is still terminal */ }
    if (via === "withdrawn") return successor
      ? `its sender already withdrew it; answer '${successor}' instead, or inspect with: tap show ${id}`
      : `its sender already withdrew it; inspect it with: tap show ${id}`;
    return `it is already terminal (via: ${via}); inspect it with: tap show ${id}`;
  }
  if (source && basename(dirname(source)) === "spool") return `it was never delivered; withdraw the spooled copy with: tap cancel ${id} --spooled`;
  return `if you SUPERSEDED this send rather than needing it re-delivered, withdraw it instead: tap withdraw ${id} -m '<why>' (no second delivery, and the recipient gets a tombstone)`;
}
function prepare(ctx: ResolvedContext, id: string, actor: string, newId: string, scriptsDir: string): string[] {
  const bus = ctx.bus.home, receipts = join(bus, "receipts"), spool = join(bus, "spool"), archive = join(bus, "archive");
  mkdirSync(spool, { recursive: true });
  // The spool's own claim, not a private `wx`: every destroyer of a `.claim` runs under the claim mutex and
  // rechecks identity there, so this one must too. No steal: a stale claim is not proof of no effect.
  const claim = claimAcquire(spool, id, true);
  if (claim.status === "held") refuse("delivery_busy", "courier claim exists; a stale claim is not proof of no effect");
  let fields: Map<string, string>, target: string, prepared: string;
  try {
    const metaLock = acquirePathLock(join(spool, `${id}.meta.json.lock`), Infinity);
    if (!metaLock) throw new Error("could not acquire resend metadata custody");
    try {
      const source = [join(spool, `${id}.md`), ctx.bus.payloadPath(id), join(archive, `${id}.cancelled.md`)].find(isFile);
      if (!source) refuse("not_found", "original payload is unavailable");
      const data = readFileSync(source), parsed = envelope(data);
      fields = parsed.fields;
      if (fields.get("id") !== id) refuse("invalid_payload", "payload id disagrees with its filename");
      if (fields.get("from") !== actor) refuse("not_sender", "only the original sender may resend");
      const registry = readJson(ctx.registryPath);
      if (registry.team !== undefined && !isDict(registry.team)) throw new TypeError("registry team is not an object");
      const team = (registry.team as Record<string, unknown> | undefined)?.name;
      if (fields.get("from_team") && fields.get("from_team") !== team) refuse("not_sender", "original belongs to a different sender team");
      const seats = seatMap(registry), current = Object.hasOwn(seats, actor) ? seats[actor] : undefined;
      if (fields.get("sender_instance")) {
        if (Object.hasOwn(seats, actor) && !isDict(current)) throw new TypeError("sender row is not an object");
        if (current?.instance !== fields.get("sender_instance")) refuse("not_sender", "original sender instance is not current");
      }
      if (existsSync(join(receipts, `${id}.resent`))) refuse("already_resent", "original already consumed; inspect its .resent receipt");
      for (const dir of [receipts, ctx.bus.payloadsDir, spool, archive]) {
        for (const suffix of ["attempted", "attempts", "sent", "read", "done"]) {
          if (existsSync(join(dir, `${id}.${suffix}`))) refuse("delivery_attempted", `delivery evidence exists: ${id}.${suffix}; possible effect prohibits resend. ${retractionAdvice(bus, id, source)}`);
        }
      }
      const metaPath = join(spool, `${id}.meta.json`);
      const meta = readJson(existsSync(metaPath) ? metaPath : join(archive, `${id}.meta.json`));
      const count = meta.attempts;
      if (!(typeof count === "number" && Number.isInteger(count)) && !(count instanceof PyInt)) refuse("effect_unknown", "missing or malformed attempt count");
      if (count !== 0) refuse("delivery_attempted", `original records ${count instanceof PyInt ? count.source : count} delivery attempts; resend refused. ${retractionAdvice(bus, id, source)}`);
      const fence = meta.attempt_fence;
      if (!(fence === 1 || fence === true || (fence instanceof PyFloat && fence.value === 1)) || meta.id !== id) refuse("effect_unknown", "legacy zero count has no pre-attempt fence; no-effect cannot be proved");
      if (existsSync(join(spool, `${id}.json`))) refuse("effect_unknown", "native intent requires its own delivery evidence");
      if (fields.get("kind") === "escalate" || fields.get("urgency") === "urgent" || meta.policy === "urgent") refuse("interrupt_resend", "interrupt-class resends are excluded; original retained");
      target = fields.get("to") ?? "";
      if (fields.get("to_team")) target = `${fields.get("to_team")}/${target}`;
      if (!target || (fields.get("cross_worktree") && !fields.get("to_team"))) refuse("invalid_payload", "original lacks a resolvable recipient team/handle");
      mkdirSync(archive, { recursive: true });
      prepared = join(archive, `${newId}.resend.md`);
      const header = [...fields].filter(([key]) => key !== "resend_of").map(([key, value]) => `${key}: ${value}\n`).join("");
      publish(prepared, Buffer.concat([Buffer.from(`---\n${header}resend_of: ${id}\n---\n`), parsed.body]));
      resendBarrier("prepared", id);
      publishJson(join(receipts, `${id}.resent`), { id, resend_id: newId, by: actor, delivery: "at-least-once", prepared, at: Math.floor(Date.now() / 1000) });
      markResetGenerationReused(bus, "resend");
      resendBarrier("consumed", id);
      const archived = join(archive, `${id}.cancelled.md`);
      if (source !== archived) { publish(archived, data); unlinkSync(source); }
      const cancel = ctx.bus.cancelPath(id);
      if (!existsSync(cancel)) publishJson(cancel, { id, status: "cancelled", via: "cancelled", by: actor, reason: "spooled_withdrawn", at: utcStamp(), resend_id: newId });
      for (const path of [join(spool, `${id}.md`), metaPath, `${metaPath}.reown`]) unlinkIfPresent(path);
    } finally { metaLock.release(); }
  } finally { claimRelease(spool, id, claim.token); }
  // resend-successor.ts reads this tuple as [_, <path in the scripts dir>, ...send
  // args] and runs cmdSend natively; it never executes the path. The shape is
  // frozen so an old successor and a new resend (or the reverse) still agree
  // across an install mid-resend: the named file need not exist.
  const args = ["bash", join(scriptsDir, "tap-send.sh"), target, prepared, "--from", actor, "--id", newId, "--kind", fields.get("kind") ?? "discuss", "--json"];
  args.push((fields.get("reply") ?? "expected") === "expected" ? "--ask" : "--note");
  if (fields.get("reply_to")) args.push("--reply-to", fields.get("reply_to")!);
  if (fields.get("in_reply_to")) args.push("--in-reply-to", fields.get("in_reply_to")!);
  // An explicit stored hint travels as an explicit --preview, because canonical stamping drops
  // the copied field. Raw-decoded so the toggle cannot erase it; `--preview ""` re-stamps a
  // rejected hint's suppression marker (stampPreview), and no field means derive as before.
  const preview = fields.get("sentinel_preview");
  if (preview !== undefined) args.push("--preview", rawPreview(preview));
  return args;
}
function implicitActor(ctx: ResolvedContext): string {
  const seen = observeCallingPane();
  if (seen.state === "inside") {
    try { return resolveSelf(ctx, { status: "ok", ...seen }, 1).handle; } catch { /* incumbent resolves softly, then emits no_actor */ }
    const other = enrolledSeatForObservedPane(seen.paneId, seen.session, seen.serverEpoch, process.env.TAP_INDEX_HOME);
    if (other.kind === "resolved") throw new TapError(1, "no_actor", `cd ${other.root}  OR  pass --by ${other.handle}`,
      `resend requires the original sender (pane ${seen.paneId} is registered on team '${other.team}' at '${other.root}')`);
  }
  throw new TapError(1, "no_actor", "pass --by <handle> (or run 'tap register' to join this team)",
    `resend requires the original sender${seen.state === "unobservable" ? ` (caller pane observation: ${seen.refusal})` : ""}`);
}
export function cmdResend(argv: string[], scriptsDir: string): number {
  let id = "", team = "", actor = process.env.TAP_SELF || "", json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--team" || arg === "--by") {
        const value = argv[++i];
        if (!value) { process.stderr.write(`tap resend: ${arg} needs a value\n`); return 1; }
        if (arg === "--team") team = value; else actor = value;
      } else if (arg === "--json") json = true;
      else if (arg.startsWith("--")) throw new TapError(1, "usage_error", "tap help resend", `unknown option '${arg}'`);
      else if (id) throw new TapError(1, "usage_error", "tap help resend", "expected one id");
      else id = arg;
    }
    if (!validId(id)) throw new TapError(1, "usage_error", "tap help resend", "expected a local payload id");
    const pin = process.env.TAP_HOME ?? "";
    applyTeamOverride(team);
    const ctx = resolveSelection(pin, team);
    if (!actor) actor = implicitActor(ctx);
    if (!validToken(actor)) throw new TapError(1, "usage_error", "tap help resend", "invalid sender");
    const reset = acquireResetMutationLock(ctx.bus.home, "tap resend", undefined, "shared");
    let lock: PaneLock | null = null;
    try {
      let args: string[], newId: string;
      try {
        lock = acquireObligationLock(id);
        if (!lock) throw new TapError(1, "obligation_busy", "tap outstanding", "original obligation is busy");
        ctx.bus.ensureDirs();
        newId = mintId(actor);
        args = prepare(ctx, id, actor, newId, scriptsDir);
      } finally { reset.release(); }
      resendBarrier("handoff", id);
      // Only the prepared successor runs here; it cannot restart this consumed
      // original, even after a reset intervenes.
      const successor = spawnSync(bunBinary(), [runtimeModule("src/resend-successor.ts"), JSON.stringify(args)], {
        env: { ...process.env, TAP_LOCK_DIR: lockRoot(), TAP_HOME: ctx.bus.home },
      });
      const code = successor.status ?? 1;
      // One error path for every failed successor. The original is already consumed, so the failure
      // is loud about what is left, and the next step only DESCRIBES an inspection; nothing retries
      // or re-sends. The child's stderr is folded into the cause (never forwarded raw: text mode is
      // one diagnostic line, --json one object on stdout and nothing on stderr). A caller's pinned
      // TAP_HOME wins over --team, and neither outlives this command, so the inspection names the
      // bus actually selected (the pin's bus, else the team), never the raw --team text.
      const anchor = pin ? { pin: ctx.bus.home } : { team: team ? ctx.team : "" };
      const stdout = successor.stdout ?? Buffer.alloc(0), stderr = successor.stderr ?? Buffer.alloc(0);
      // A killed child or a failed spawn leaves no status or stderr of its own; keep how it died.
      const crash = successor.signal ? `the successor was killed by ${successor.signal}` : successor.error ? `the successor could not run: ${successor.error.message}` : "";
      let invalid: ResendReceiptError | undefined, out: Uint8Array | undefined;
      if (code === 0) {
        try { out = formatResendResult(stdout, code, id, newId, json); } catch (error) {
          if (!(error instanceof ResendReceiptError)) throw error;
          invalid = error;
        }
      }
      if (out === undefined) {
        const failure = describeResendFailure(stdout, stderr, code, id, newId, anchor, invalid, crash);
        throw new ResendFailure(code || 1, failure.errorClass, failure.action, failure.detail, failure.body);
      }
      // A successful send keeps its warnings (an ask downgraded, evidence not recorded); --json stays stderr-free.
      if (stderr.length && !json) process.stderr.write(stderr);
      process.stdout.write(out);
      return code;
    } finally { lock?.release(); }
  } catch (error) {
    if (error instanceof GuardRefusal) {
      process.stdout.write(jsonDumpBytes({ status: "refused", error_class: error.errorClass, detail: error.message }) + "\n");
      return 1;
    }
    if (!json || !(error instanceof TapError)) throw error;
    // A failed successor's envelope carries its receipt fields and the recovery facts beside the standard four.
    const body = error instanceof ResendFailure ? error.body : { ok: false, error_class: error.errorClass, action: error.action, detail: error.detail };
    process.stdout.write(`${ensureAscii(JSON.stringify(body)).replace(/\x7f/g, "\\u007f")}\n`);
    return error.code;
  }
}
/** Scratch-only scheduling seam for the real publication/reset/child boundaries. */
function resendBarrier(stage: string, id: string): void {
  const base = process.env.TAP_OBLIGATION_TEST_BARRIER;
  if (!base || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_OBLIGATION_TEST_ID !== id || process.env.TAP_OBLIGATION_TEST_STAGE !== stage) return;
  writeFileSync(`${base}.${stage}.reached`, "1\n");
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${base}.${stage}.release`)) {
    if (Date.now() >= deadline) throw new Error(`resend ${stage} test barrier timed out`);
    Bun.sleepSync(5);
  }
}
