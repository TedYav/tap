// `tap resend <id>`: the sender's explicit same-id retry (delivery decision-v1,
// L1-L7). It re-rings the SAME canonical message: no successor id, no withdrawal,
// no age reset, one obligation. The canonical is re-parked into the spool as a
// retry row and the existing drain delivers it under the retry's own one-shot
// license (`<id>.retry-<uuid>.attempted`) with a `retry` wire tag. An urgent or
// escalation original re-rings as ordinary delivery: never a second interrupt.
// A message the recipient already observed, settled or that was cancelled is a
// recorded, suppressed request: exit 0, no pane effect.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TapError, observeCallingPane, resolveSelf, type ResolvedContext } from "../context";
import { ensureAscii } from "../fsatomic";
import { validId, validToken } from "../ids";
import { lockRoot, acquireObligationLock, type PaneLock } from "../panelock";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { enrolledSeatForObservedPane, loadRegistry, seatMap } from "../registry";
import { isFile } from "../watch-lease";
import { acquireResetMutationLock } from "../reset";
import { isDict, parseJsonPreserving } from "../spool-publication";
import { recipientState } from "../harness-queue";
import { appendRetryRecord, attemptCount, nextRetryOrdinal, pendingRetry, retryClosed, retryIdleSubmitPath, retryMarkerPath, returnBodyHome, rowRetry, spentOriginalPark, spentRetryRow } from "../retry";
import { metaField, removeEntry } from "../spool-sidecar";
import { archivedPayload } from "../bus-archive-index";
import { pendingReprobe } from "../submit-phase";
import { bindRemoteTeam } from "../remote-target";
import { ParkRefusal, parkPlaced, type Parked } from "../spool-park";
import { finishPark, type ParkReportInput } from "../spool-park-report";

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

type Verdict =
  | { status: "queued"; to: string; retry: string; ordinal: number; input: ParkReportInput; parked: Parked }
  | { status: "suppressed"; to: string; state: string; via?: string; ask: boolean }
  | { status: "pending"; to: string; detail: string };

/** Runs under the shared reset lock and the id's obligation lock. */
function retryUnderLocks(ctx: ResolvedContext, id: string, actor: string, scriptsDir: string): Verdict {
  const bus = ctx.bus.home, spool = join(bus, "spool"), canonical = ctx.bus.payloadPath(id), parked = join(spool, `${id}.md`);
  let source = [canonical, parked, join(bus, "archive", `${id}.cancelled.md`)].find(isFile), archived = false;
  if (!source) {
    // `tap bus archive` moves only terminal mail, with its receipts, into a month bucket.
    try { source = archivedPayload(bus, id) || undefined; archived = Boolean(source); } catch { /* an unsafe or corrupt archive is not found */ }
  }
  if (!source) refuse("not_found", "no local payload with this id; tap resend runs on the sender's bus");
  const fields = envelope(readFileSync(source)).fields;
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
  const handle = fields.get("to") ?? "", toTeam = fields.get("to_team") && fields.get("to_team") !== ctx.team ? fields.get("to_team")! : "";
  if (!handle || (fields.get("cross_worktree") && !fields.get("to_team"))) refuse("invalid_payload", "original lacks a resolvable recipient team/handle");
  const to = toTeam ? `${toTeam}/${handle}` : handle, ask = (fields.get("reply") ?? "expected") === "expected";
  const attempts = attemptCount(bus, id);

  // Archived mail is terminal: a suppressed no-op. Nothing is recorded, because an active
  // receipt for an archived id would contradict the archive's moved evidence.
  if (archived) return { status: "suppressed", to, state: "archived", ask: false };
  // Observed, settled or cancelled: a recorded, suppressed request. No pane effect.
  const seen = recipientState(bus, id);
  if (seen.state !== "unobserved") {
    appendRetryRecord(bus, { id, retry: randomUUID(), ordinal: nextRetryOrdinal(bus, id), event: "suppressed", actor, trigger: "explicit",
      prior: { state: seen.state, ...(seen.via ? { via: seen.via } : {}), ...(seen.at ? { at: seen.at } : {}), attempts },
      detail: `recipient state ${seen.state}; no pane effect` });
    return { status: "suppressed", to, state: seen.state, ...(seen.via ? { via: seen.via } : {}), ask };
  }
  // A parked row whose own attempt is spent can never ring again: a retry row after a kill
  // or refusal post-admission, or an original park after its possible effect. Coalescing
  // into it would block the blessed retry forever, so it retires — the body back to
  // payloads, every attempt and interrupt receipt kept — and this invocation mints fresh
  // below. A spent retry closes as `unknown`: its attempt may have rung. Staged-idle holds
  // and pending reprobes are runnable completions and still coalesce.
  const reprobe = pendingReprobe(bus, id);
  const spentRetry = reprobe ? null : spentRetryRow(bus, spool, id);
  if (spentRetry || (!reprobe && spentOriginalPark(bus, spool, id))) {
    // removeEntry deletes the spool body: the row goes only once a regular canonical holds it.
    if (!returnBodyHome(parked, canonical)) refuse("retire_held", "its spent parked row could not move back to payloads/; the row and body are kept");
    removeEntry(spool, id, process.env, 5000);
    if (spentRetry && !retryClosed(bus, id, spentRetry.retry)) appendRetryRecord(bus, { id, retry: spentRetry.retry, ordinal: spentRetry.ordinal,
      event: "outcome", outcome: "unknown", detail: "license spent with no recorded outcome; the attempt may have rung" });
  }
  // Delivery work already queued for this id coalesces: one runnable row per id.
  const queued = rowRetry(spool, id);
  if (queued) return { status: "pending", to, detail: `retry ${queued.ordinal} is already queued` };
  if (existsSync(parked)) return { status: "pending", to, detail: "it is still queued for delivery" };

  // The recipient must have a pane to ring; a poll-only seat reads with tap poll.
  let registryPath = ctx.registryPath, bound = "";
  if (toTeam) {
    const remote = bindRemoteTeam(toTeam, handle, process.env.TAP_INDEX_HOME);
    registryPath = remote.registryPath; bound = remote.team;
  }
  let row: Record<string, unknown> | undefined;
  try { row = seatMap(loadRegistry(registryPath))[handle] as Record<string, unknown> | undefined; } catch { row = undefined; }
  const pane = typeof row?.pane === "string" ? row.pane : "", paneId = typeof row?.pane_id === "string" ? row.pane_id : "";
  if (!row || row.delivery === "poll" || !pane || !paneId) refuse("recipient_unbound", `'${to}' has no registered pane to ring; it reads its mail with tap poll`);
  // A different instance under the same handle is a different seat (spool-rebind's rule): the
  // retry never exposes this message to it. A follow-up send reaches whoever holds the handle now.
  const sentTo = fields.get("recipient_instance") ?? "", nowAt = typeof row.instance === "string" ? row.instance : "";
  if (sentTo && nowAt && sentTo !== nowAt) refuse("recipient_changed", `'${to}' is now a different seat instance than the one this message was sent to; follow up with tap send ${to} -f <file>`);

  // Persist the request and its uuid BEFORE any runnable work exists. A request whose park was
  // interrupted (recorded, no row, no outcome, never attempted) resumes under its own uuid.
  const pending = pendingRetry(bus, id);
  const resumed = pending && !existsSync(retryMarkerPath(bus, id, pending.retry)) ? pending : null;
  const retry = resumed?.retry ?? randomUUID(), ordinal = resumed?.ordinal ?? nextRetryOrdinal(bus, id);
  // The license `<id>.retry-<uuid>.idle-submit` is the longest name a retry writes: refuse before
  // recording anything when it cannot fit, rather than queue a row no drain can ever admit.
  if (Buffer.byteLength(basename(retryIdleSubmitPath(bus, id, retry))) > 255) refuse("id_too_long", "this id is too long for a retry license filename; follow up with tap send");
  if (!resumed) appendRetryRecord(bus, { id, retry, ordinal, event: "request", actor, trigger: "explicit", prior: { state: "unobserved", attempts } });
  const input: ParkReportInput = {
    spoolDir: spool, home: bus, id, canonical, target: handle, acting: ctx.team, reason: "retry", timeoutSeconds: "",
    pane, paneId, toTeam: bound, targetRegistry: registryPath, policy: "standard", graceSeconds: "", cueStyle: "", cueRedAt: "",
    env: { ...process.env, TAP_LOCK_DIR: lockRoot(), TAP_HOME: bus },
    from: actor, kind: fields.get("kind") ?? "discuss", replyExpect: ask ? "expected" : "none", scriptsDir,
    retry: { uuid: retry, ordinal },
  };
  resendBarrier("parking", id);
  try { return { status: "queued", to, retry, ordinal, input, parked: parkPlaced(input) }; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A failure AFTER the row was published (canonical cleanup) leaves runnable work: it is
    // queued, never refused, and still gets its waiter. The park released its claim.
    if (rowRetry(spool, id)?.retry === retry) {
      process.stderr.write(`tap resend: ${id} retry ${ordinal} is queued; its park reported: ${detail}\n`);
      return { status: "queued", to, retry, ordinal, input,
        parked: { payload: join(spool, `${id}.md`), meta: join(spool, `${id}.meta.json`), deadlineEpoch: metaField(spool, id, "deadline_epoch") } };
    }
    try { appendRetryRecord(bus, { id, retry, ordinal, event: "outcome", outcome: "refused", detail }); } catch { /* the request stays unknown */ }
    throw new TapError(1, error instanceof ParkRefusal ? error.klass : "spool_publish_failed", `tap show ${id}`, `retry was not queued: ${detail}`);
  }
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
    let verdict: Verdict;
    const reset = acquireResetMutationLock(ctx.bus.home, "tap resend", undefined, "shared");
    let lock: PaneLock | null = null;
    try {
      lock = acquireObligationLock(id);
      if (!lock) throw new TapError(1, "obligation_busy", "tap outstanding", "another process is acting on this message; retry shortly");
      ctx.bus.ensureDirs();
      verdict = retryUnderLocks(ctx, id, actor, scriptsDir);
    } finally { lock?.release(); reset.release(); }
    // The waiter starts after the locks are released, so its first drain can take the obligation lock.
    let spawned = true;
    if (verdict.status === "queued") spawned = finishPark(verdict.input, verdict.parked).spawned;
    if (json) {
      const base = { status: verdict.status, id, to: verdict.to };
      const body = verdict.status === "queued" ? { ...base, retry: verdict.retry, ordinal: verdict.ordinal, delivery_semantics: "at-least-once", waiter: spawned }
        : verdict.status === "suppressed" ? { ...base, state: verdict.state, ...(verdict.via ? { via: verdict.via } : {}) }
        : { ...base, detail: verdict.detail };
      process.stdout.write(`${ensureAscii(JSON.stringify(body))}\n`);
    } else if (verdict.status === "queued") {
      process.stdout.write(`tap resend: ok ${id} retry ${verdict.ordinal}\n`);
      if (!spawned) process.stderr.write(`tap resend: warning: the retry for ${id} is queued but no waiter started; the next drain delivers it (inspect with tap show ${id})\n`);
    } else if (verdict.status === "suppressed") {
      const what = verdict.state === "observed" ? "read" : verdict.state;
      process.stdout.write(`tap resend: ${id} already ${what}${verdict.state === "observed" && verdict.ask ? `; follow up: tap send ${verdict.to} -f <file>` : ""}\n`);
    } else process.stdout.write(`tap resend: ${id} already queued\n`);
    return 0;
  } catch (error) {
    if (error instanceof GuardRefusal) {
      if (json) process.stdout.write(`${ensureAscii(JSON.stringify({ ok: false, error_class: error.errorClass, action: `tap show ${id}`, detail: error.message }))}\n`);
      else process.stderr.write(`tap resend: ${error.message} (${error.errorClass})\n`);
      return 1;
    }
    if (!json || !(error instanceof TapError)) throw error;
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: false, error_class: error.errorClass, action: error.action, detail: error.detail }))}\n`);
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
