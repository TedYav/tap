// out-retire.ts — the ordinary `tap out|unregister` retirement owner (R3,
// tap-68lp.2.1): plain, dash (`-`), and `--kill` forms in one place. The
// router's out|unregister dispatches here for every non-forwarding form, so
// no second registry writer exists on either door.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Bus } from "./bus";
import { TapError, observeCallingPane, resolveContext } from "./context";
import { envelopeField, validateEnvelope } from "./envelope";
import { appendRegistryEventOrWarn, registryEventsPath } from "./events";
import { atomicWrite } from "./fsatomic";
import { pyDumpIndent } from "./lossless-json";
import { validToken } from "./ids";
import { acquireRegistryLock, type RegistryLock } from "./panelock";
import { canonicalSessionName, isPaneId, lifecycleDisposition, tmuxFateStopsNamedSession, type LifecycleDisposition } from "./lifecycle-target";
import { dismissCrew } from "./crew-lifecycle";
import { liveSeat, ownedCrewRows, seatSnapshot, stopExactPane } from "./seat-stop";
import { mintInstanceId, resolveHandleByPane, type Seat } from "./registry";
import { acquireResetMutationLock, assertResetUnfenced, markResetGenerationReused, resetFenceRefusal } from "./reset";
import { assertSelectionCurrent, parseTarget, SelectorError, type Selection } from "./selector";
import { pyReadUtf8 } from "./spool-publication";
import { isOldStoreRefusal, teamRegistryRefusal } from "./register-authority";
import { AGENT_FAMILIES } from "./harness-families";
import { isMap, loads, type JsonMap, type JsonValue } from "./watch-detect";
import { physicalSocketPath, serverEpochFromRaw, tmux, tmuxReadOnly, bootId, legacyBootId } from "./tmux";
import { reservationExpired } from "./reservation";
import { deadLetterScope, deadLetterTargets, disposeDeadLetters } from "./dead-letters";

type Ctx = ReturnType<typeof resolveContext>;
export type RetirementDisposition = Extract<LifecycleDisposition, { ok: true }>;
export interface PlainForm { name: string | null; pane: string; kill: boolean; dash: boolean; team?: string; selfReported?: boolean }

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const str = (v: JsonValue | undefined): string => (typeof v === "string" ? v : "");

// Test-only pause between acting-registry selection and the transaction window,
// so a test can move the enrollment out from under the in-flight selection.
function publicationBarrier(stage: string, env: NodeJS.ProcessEnv): void {
  const path = env.TAP_OUT_RETIRE_TEST_BARRIER;
  if (!path || !env.TAP_SCRATCH_ONLY || env.TAP_OUT_RETIRE_TEST_STAGE !== stage) return;
  writeFileSync(path + ".ready", stage);
  const deadline = Date.now() + 10000;
  while (!existsSync(path + ".continue") && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(path + ".continue")) throw new Error("out-retire scratch barrier timed out");
}

export function parseOutForm(argv: string[]): PlainForm {
  const f: PlainForm = { name: null, pane: "", kill: false, dash: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pane") { const v = argv[++i]; if (v === undefined) throw new TapError(1, "usage_error", "tap help unregister", "--pane needs a value", "tap"); f.pane = v; }
    else if (a === "--json") process.env.TAP_JSON = "1";
    else if (a === "--kill" || a === "--hard") f.kill = true;
    else if (a === "--team") {
      const team = argv[++i];
      if (f.team !== undefined || !team || team.startsWith("-")) throw new TapError(1, "usage_error", "tap help unregister", "--team needs one team name", "tap");
      f.team = team;
    }
    else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help unregister", `unknown option '${a}'`, "tap");
    else if (f.name === null) f.name = a;
    else throw new TapError(1, "usage_error", "tap help unregister", `unexpected arg '${a}'`, "tap");
  }
  f.dash = f.name === "-";
  if (f.name !== null && !f.dash) {
    const target = parseTarget(f.name);
    if (target.qualified && f.team !== undefined) throw new TapError(1, "selector_conflict", "pass --team OR a qualified seat, not both", "out selectors name the same team axis", "tap");
    if (target.qualified) f.team = target.team;
    f.name = target.handle;
  }
  return f;
}

// resolveContext uses selectCaller; keep the explicit team on every resolution,
// including a transaction rebind, before reading any retirement facts.
function retireContext(form: PlainForm, env: NodeJS.ProcessEnv): Ctx {
  return resolveContext(process.cwd(), env, { explicitTeam: form.team });
}

/** Router-door entry: every `out|unregister` form except `--forward-to`. */
export function cmdOutRetire(argv: string[], requested: "out" | "shutdown" = "out"): number {
  let form: PlainForm | undefined;
  try {
    form = parseOutForm(argv);
    if (requested === "shutdown" && (!form.name || form.dash)) throw new TapError(1, "usage_error", "tap shutdown <handle|team/handle>", "shutdown needs one named seat");
    const action = requested === "shutdown" ? "shutdown" : form.kill ? "out-hard" : "out";
    if (form.dash && form.kill) {
      throw new TapError(1, "usage_error", "tap help unregister", "'-' is incompatible with --kill (a dead seat has no session to kill)", "tap");
    }
    if (form.dash && !dashSelect(form, process.env)) return 0;
    if (form.dash) publicationBarrier("after-dash-select", process.env);
    const ctx = retireContext(form, process.env);
    const { name } = resolveRetireName(ctx, form, process.env);
    const facts = rowFacts(ctx, name);
    if (requested === "shutdown" && !facts.present) {
      // Empty narration facts can mean an unreadable or malformed registry.
      // Preserve its authoritative refusal before calling the seat absent.
      if (isFile(ctx.registryPath)) retirementDoc(ctx);
      throw new TapError(1, "not_found", `tap team --team ${ctx.team}`, `unknown seat '${ctx.team}/${name}'; nothing removed`);
    }
    const disposition = lifecycleDisposition(facts.crew ? "crew" : "seat", action);
    if (!disposition.ok) throw new TapError(1, disposition.errorClass, "tap help out", disposition.detail);
    if (disposition.row.scope === "crew" && disposition.row.crews === "consume-d-contract") return dismissCrew(ctx, name, facts.row!, disposition,
      { verb: `tap ${action === "out-hard" ? "out --hard" : action}`, deadOnly: form.dash });
    if (tmuxFateStopsNamedSession(disposition.row)) return killEntry(ctx, form, name, facts, disposition);
    return retireSelected(ctx, form, name, facts.row, disposition);
  } catch (e) {
    if (form?.selfReported) {
      writeSync(2, `tap ${requested}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    return retirementFailure(e);
  }
}

function retirementFailure(e: unknown): never {
  if (e instanceof SelectorError) throw new TapError(e.code, e.errorClass, e.action, e.detail, "tap");
  if (e instanceof TapError || isOldStoreRefusal(e)) throw e;
  // A tagged ordinary Error (e.g. a Bus structural refusal) declares its own
  // class/action; nativeError renders it. Only genuinely unclassified
  // unexpected errors fall back to registry_invalid.
  if (e instanceof Error) {
    const tagged = e as Error & { tapErrorClass?: unknown; tapAction?: unknown };
    if (typeof tagged.tapErrorClass === "string" && tagged.tapErrorClass !== "") {
      throw new TapError(1, tagged.tapErrorClass,
        typeof tagged.tapAction === "string" ? tagged.tapAction : "", e.message, "tap");
    }
  }
  throw new TapError(1, "registry_invalid", "repair_registry", String(e), "tap");
}

function fenceOrThrow(ctx: Ctx): void {
  const fence = resetFenceRefusal(ctx.bus.home, "tap unregister");
  if (fence) throw new TapError(1, "team_reset_fenced", fence.action, fence.detail, "tap");
}

function noRegistry(form: PlainForm): boolean {
  if (form.team !== undefined) throw new TapError(1, "not_found", "tap team --team " + form.team, "selected team has no registry; no retirement performed", "tap unregister");
  process.stdout.write("tap unregister: no registry — nothing to remove\n");
  return false;
}

// --- dash selection (`tap out -`): the most recently exited teammate ---------
// Scans the caller's acting registry for dead-pane candidates (pane-backed,
// active, identity-then-address probe dead; plus suspended/pane_gone), stamps
// missing exited_at facts, and publishes the stamps even when refusing, exactly
// as the incumbent inline scan did under the same lock.

function paneAlive(target: string, env: NodeJS.ProcessEnv): boolean {
  if (!target) return false;
  // Read-only incumbent probe on the unthrottled door: a drained courier
  // token bucket must never masquerade as pane absence here.
  const r = tmuxReadOnly(["display-message", "-p", "-t", target, "#{pane_id}"], env);
  return r.code === 0 && r.stdout.trim() !== "";
}

function dashSelect(form: PlainForm, env: NodeJS.ProcessEnv): boolean {
  let ctx = retireContext(form, env);
  fenceOrThrow(ctx);
  ctx.bus.ensureDirs();
  if (!isFile(ctx.registryPath)) return noRegistry(form);
  const resetLock = acquireResetMutationLock(ctx.bus.home, "tap unregister", undefined, "shared");
  try {
    const lock = acquireRegistryLock(ctx.registryPath, Infinity);
    if (!lock) throw new TapError(1, "registry_lock_busy", "tap out -", "acting registry is busy; no retirement published", "tap unregister");
    try {
      lockedAuthorityOrInvalid(ctx, env, lock);
      let doc: JsonValue;
      try { doc = loads(pyReadUtf8(ctx.registryPath)); }
      catch (e) { throw new TapError(1, "registry_invalid", "repair_registry", `tap unregister: registry '${ctx.registryPath}' is invalid JSON (${(e as Error).message})`, "tap"); }
      if (!isMap(doc)) {
        // A valid non-object document is refused with its bytes preserved —
        // publishing an empty seat map over it would be data loss.
        throw new TapError(1, "registry_invalid", "repair_registry", `tap unregister: registry '${ctx.registryPath}' is invalid JSON; refusing to touch it (not an object)`, "tap");
      }
      refuseOldRegistryDoc(ctx.registryPath, doc, "tap unregister");
      const seats = writerSeats(doc);
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const candidates: Array<[string, string]> = [];
      let liveCount = 0;
      for (const handle of [...seats.keys()].sort()) {
        const ent = seats.get(handle);
        if (!isMap(ent)) continue;
        const delivery = str(ent.get("delivery")) || "pane";
        if (delivery === "poll") continue;
        // Missing-vs-present: the default "active" applies only when the key
        // is absent; an explicit null/false/number/object must not become a
        // candidacy status.
        const status: JsonValue = ent.has("status") ? ent.get("status")! : "active";
        const reason = str(ent.get("status_reason"));
        if (status === "active") {
          let paneId = ent.get("pane_id");
          if (paneId !== undefined && paneId !== null && paneId !== "" && !(typeof paneId === "string" && isPaneId(paneId))) continue;
          paneId = typeof paneId === "string" ? paneId : "";
          const paneAddr = str(ent.get("pane"));
          if ((paneId && paneAlive(paneId, env)) || (paneAddr && paneAlive(paneAddr, env))) { liveCount++; continue; }
          if (!str(ent.get("exited_at"))) ent.set("exited_at", now);
          candidates.push([handle, str(ent.get("exited_at"))]);
        } else if (status === "suspended" && reason === "pane_gone") {
          if (!str(ent.get("exited_at"))) ent.set("exited_at", now);
          candidates.push([handle, str(ent.get("exited_at"))]);
        }
      }
      const docMap: JsonMap = isMap(doc) ? doc : new Map<string, JsonValue>();
      // Publish the stamps over the document AS FOUND: when it has no usable
      // seats map there are no stamps, and an old-format file is never rewritten.
      const publish = () => {
        if (writerSeats(docMap) !== seats) return;
        atomicWrite(ctx.registryPath, `${pyDumpIndent(docMap, 0)}\n`);
      };
      if (candidates.length === 0) {
        publish();
        throw new TapError(1, "not_found", "tap unregister <name>", `no dead seats (${liveCount} active pane(s)) — name one explicitly`, "tap");
      }
      if (candidates.length === 1) {
        publish();
        form.name = candidates[0]![0]!;
        return true;
      }
      const stamped = candidates.filter(([, ea]) => ea);
      if (stamped.length === candidates.length) {
        const latest = stamped.reduce((a, b) => (b[1]! > a[1]! ? b : a));
        if (stamped.filter(([, ea]) => ea === latest[1]).length === 1) {
          publish();
          form.name = latest[0]!;
          return true;
        }
      }
      publish();
      throw new TapError(1, "not_found", "tap unregister <name>",
        `${candidates.length} dead seats — name one explicitly (candidates: ${candidates.map(([h]) => h).join(" ")})`, "tap");
    } finally { lock.release(); }
  } finally { resetLock.release(); }
}

// --- shared row facts and narration -----------------------------------------

interface RowFacts {
  present: boolean; eventPane: string; storedSession: string;
  delivery: string; paneId: string; crew: boolean; serverEpoch: string; team: string;
  row?: Record<string, unknown>;
}

const EMPTY_FACTS: RowFacts = { present: false, eventPane: "", storedSession: "", delivery: "pane", paneId: "", crew: false, serverEpoch: "", team: "" };

function docSeats(doc: JsonValue): JsonMap {
  return isMap(doc) && isMap(doc.get("seats")) ? doc.get("seats") as JsonMap : new Map<string, JsonValue>();
}

/** An old-format registry refuses as old_store before any row is read or
 * stamped; it is never treated as an empty roster. */
function refuseOldRegistryDoc(path: string, doc: JsonMap, verb: string): void {
  const refusal = teamRegistryRefusal(path, doc);
  if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail, verb);
}

/** Only a seats map beside no `agents` key is writable; anything else is an empty, detached roster. */
function writerSeats(doc: JsonMap): JsonMap {
  const seats = doc.get("seats");
  return isMap(seats) && !doc.has("agents") ? seats : new Map<string, JsonValue>();
}

function rowFacts(ctx: Ctx, name: string): RowFacts {
  try {
    const doc = loads(pyReadUtf8(ctx.registryPath));
    const seats = docSeats(doc);
    const row = seats.get(name);
    if (!isMap(row)) return { ...EMPTY_FACTS };
    return {
      present: true,
      row: Object.fromEntries(row),
      eventPane: str(row.get("pane")),
      storedSession: str(row.get("session")),
      delivery: str(row.get("delivery")) || "pane",
      paneId: str(row.get("pane_id")),
      crew: row.get("crew") === true || row.get("crew") === 1n,
      serverEpoch: str(row.get("server_epoch")),
      team: teamNameOf(doc),
    };
  } catch { /* unreadable registry: every fact empty; the transaction re-reads and refuses. */ }
  return { ...EMPTY_FACTS };
}

function teamNameOf(doc: JsonValue): string {
  if (!isMap(doc)) return "";
  const team = doc.get("team");
  return isMap(team) ? str(team.get("name")) : "";
}

function serverEpochNow(env: NodeJS.ProcessEnv): string {
  const pin = env.TAP_SERVER_EPOCH;
  if (pin !== undefined) return pin;
  const r = tmux(["display-message", "-p", "#{pid}:#{start_time}"], env);
  if (r.code !== 0) return "";
  return serverEpochFromRaw(r.stdout.trim(), env);
}

// The narration ladder: which session receipt/warning facts may name. Poll
// seats have no tmux lifecycle; stale-epoch ids may not label anything; a
// stable stored pane id must still answer to itself before its session or
// window may be quoted; stored provenance outranks a mutable pane address.
function narrationLadder(facts: RowFacts, kill: boolean, env: NodeJS.ProcessEnv): { sessionName: string; windowId: string } {
  let sessionName = "", windowId = "";
  const epochNow = serverEpochNow(env);
  const stale = facts.serverEpoch !== "" && epochNow !== "" && epochNow !== facts.serverEpoch;
  if (facts.delivery !== "poll") {
    if (stale) sessionName = facts.storedSession;
    else if (facts.paneId) {
      if (tmux(["display-message", "-p", "-t", facts.paneId, "#{pane_id}"], env).stdout.trim() === facts.paneId) {
        sessionName = tmux(["display-message", "-p", "-t", facts.paneId, "#{session_name}"], env).stdout.split("\n")[0]?.trim() ?? "";
        windowId = tmux(["display-message", "-p", "-t", facts.paneId, "#{window_id}"], env).stdout.split("\n")[0]?.trim() ?? "";
      }
    } else if (facts.storedSession) sessionName = facts.storedSession;
    else if (facts.eventPane) sessionName = tmux(["display-message", "-p", "-t", facts.eventPane, "#{session_name}"], env).stdout.split("\n")[0]?.trim() ?? "";
    if (!facts.paneId || !kill) sessionName = sessionName || facts.storedSession;
  }
  return { sessionName, windowId };
}

// Tri-state pane observation (pane id, session, generation) from ONE record.
// Absence requires the server to have answered: rc 0 with an empty expansion,
// or a nonzero exit whose stderr says "can't find" — the error IS the answer.
// Every other failure is unverifiable and proves nothing.
function observePaneIdentity(target: string, env: NodeJS.ProcessEnv): { gone: true } | { unverifiable: true } | { paneId: string; session: string; epoch: string } {
  const r = tmux(["display-message", "-p", "-t", target, "#{pane_id}\t#{session_name}\t#{pid}:#{start_time}"], env);
  if (r.rateLimited) return { unverifiable: true };
  if (r.code !== 0) {
    if ((r.stderr ?? "").includes("can't find")) return { gone: true };
    return { unverifiable: true };
  }
  const record = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
  if (record.includes("\n")) return { unverifiable: true };
  const [id, session, raw] = record.split("\t");
  if (!id) return { gone: true };
  if (!isPaneId(id)) return { unverifiable: true };
  const epoch = serverEpochFromRaw(raw ?? "", env);
  if (!epoch) return { unverifiable: true };
  return { paneId: id, session: session ?? "", epoch };
}

// The registered-handle resolution for a nameless call, symmetric with
// register: pane identity first, session-name derivation as fallback.
function resolveRetireName(ctx: Ctx, form: PlainForm, env: NodeJS.ProcessEnv): { name: string; callerRefusal: string } {
  const name = form.name;
  if (name !== null && name !== "-") return { name, callerRefusal: "" };
  let pane = form.pane;
  let callerRefusal = "";
  if (!pane) {
    const obs = observeCallingPane(env);
    if (obs.state === "inside") pane = obs.paneId;
    else callerRefusal = obs.state === "unobservable" ? obs.refusal : obs.detail;
  }
  let resolved: string | null = null;
  let sess = "";
  if (pane) {
    const rec = observePaneIdentity(pane, env);
    if ("unverifiable" in rec) {
      throw new TapError(1, "generation_unverifiable", "wait for tmux to answer and retry, or name the exact handle: tap out <handle>",
        "refusing session-name fallback because the tmux server generation is unavailable and the caller pane's registered identity cannot be verified", "tap");
    }
    if ("paneId" in rec) {
      sess = rec.session;
      resolved = resolveHandleByPane(ctx.registryPath, rec.paneId, pane, rec.epoch,
        env.TAP_CALLER_SELECTED_HANDLE || undefined, env.TAP_CALLER_SELECTED_INSTANCE || undefined)?.handle ?? null;
    }
    if (resolved === null && !sess) sess = tmux(["display-message", "-p", "-t", pane, "#{session_name}"], env).stdout.split("\n")[0]?.trim() ?? "";
  }
  let handle = resolved;
  if (handle === null) {
    if (form.team !== undefined) {
      throw new TapError(1, "identity_unverified", `tap out <handle> --team ${ctx.team}`,
        `caller pane is not registered on selected team '${ctx.team}'; name the target explicitly`, "tap out");
    }
    // tap-2al3d: no harness fallback here. This path runs for an
    // UNREGISTERED caller pane; a derived "claude" would select some other
    // pane's row for removal. Registered panes resolve through pane identity.
    handle = deriveHandle(sess, basename(gitRoot(env)));
    if (!handle) {
      let detail = "usage: tap unregister [<name>] [--pane <tmux-target>] [--kill]  (could not derive a handle from the tmux session name; pass one explicitly)";
      if (callerRefusal) detail += ` (caller pane observation: ${callerRefusal})`;
      throw new TapError(1, "usage_error", "tap help unregister", detail, "tap");
    }
  }
  return { name: handle, callerRefusal };
}

function deriveHandle(session: string, team: string): string {
  if (!session) return "";
  let s = session, idx = "";
  if (team && s.startsWith(`${team}/`)) {
    // The qualified form returns the validated remainder VERBATIM — no
    // suffix or harness stripping (the incumbent's early return).
    const rest = s.slice(team.length + 1);
    if (!rest.includes("/") && !/^\d+$/.test(rest) && validToken(rest)) return rest;
    return "";
  }
  // Unqualified team prefixes strip the actual team argument, not a literal.
  if (team) {
    if (s.startsWith(`${team}-`)) s = s.slice(team.length + 1);
    else if (s.startsWith(`${team}_`)) s = s.slice(team.length + 1);
  }
  const m = s.match(/^(.+)[-_]([0-9]+)$/);
  if (m) { s = m[1]!; if (Number(m[2]) >= 2) idx = m[2]!; }
  const dash = s.indexOf("-");
  if (dash > 0 && AGENT_FAMILIES.has(s.slice(0, dash)) && s.slice(dash + 1)) s = s.slice(dash + 1);
  if (/^\d+$/.test(s)) return "";
  if (idx) s = `${s}-${idx}`;
  return validToken(s) ? s : "";
}

function gitRoot(env: NodeJS.ProcessEnv): string {
  try { const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe", env }); if (r.exitCode === 0) return r.stdout.toString().trim(); } catch { /* fall through */ }
  return process.cwd();
}

function crewScan(bus: Bus, name: string, team: string): { blockers: string[]; queued: Array<[string, string]> } {
  const blockers: string[] = [], queued: Array<[string, string]> = [];
  for (const dir of [bus.payloadsDir, join(bus.home, "spool")]) {
    let names: string[] = [];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const fn of names) {
      if (fn.startsWith("_") || !fn.endsWith(".md")) continue;
      const id = fn.slice(0, -3);
      if (bus.isDone(id)) continue;
      let text: string;
      try { text = readFileSync(join(dir, fn), "utf8"); } catch { continue; }
      if (!validateEnvelope(text).ok) continue;
      const idF = envelopeField(text, "id") ?? "";
      if (idF !== id) continue;
      const from = envelopeField(text, "from") ?? "", to = envelopeField(text, "to") ?? "";
      const reply = envelopeField(text, "reply") || "expected";
      const toTeam = envelopeField(text, "to_team") ?? "";
      if (from === name) blockers.push(`  outbound ${from} id=${id}; next: tap outstanding ${name}`);
      else if (to === name && (toTeam === "" || toTeam === team)) {
        if (dir === bus.payloadsDir) blockers.push(`  inbound ${from} id=${id}; next: ${reply === "settle-only" ? `tap read ${id}` : `tap reply ${id} -f <file>`}`);
        else queued.push([id, from]);
      }
    }
  }
  return { blockers, queued };
}

function cloneJson(v: JsonValue): JsonValue {
  if (isMap(v)) return new Map([...v].map(([k, x]) => [k, cloneJson(x)]));
  if (Array.isArray(v)) return v.map(cloneJson);
  return v;
}

// In-lock acting-authority validation for the paths whose incumbent mapped a
// validation failure to registry_invalid (dash scan, kill transaction).
function lockedAuthorityOrInvalid(ctx: Ctx, env: NodeJS.ProcessEnv, lock: RegistryLock): void {
  if (!ctx.selection) return;
  try { assertSelectionCurrent(ctx.selection, lock, env.TAP_INDEX_HOME); }
  catch (e) {
    if (e instanceof SelectorError) {
      throw new TapError(1, "registry_invalid", "repair_registry",
        e.errorClass === "invalid_flip" ? e.detail : "unregister registry update failed", "tap unregister");
    }
    throw e;
  }
}

// --- plain retirement (explicit name, nameless, dash-selected) ---------------

// Call with NO held lock. D and ordinary out share this transaction, while
// the hard transaction shares its inner row codec under its own custody.
export function retireSelected(ctx: Ctx, form: PlainForm, name: string, expected: Record<string, unknown> | undefined,
  disposition?: RetirementDisposition): number {
  try { return retireSelectedBody(ctx, form, name, expected, disposition); }
  catch (error) { return retirementFailure(error); }
}

function retireSelectedBody(ctx: Ctx, form: PlainForm, name: string, expected: Record<string, unknown> | undefined,
  disposition?: RetirementDisposition): number {
  const env = process.env;
  publicationBarrier("after-select", env);
  fenceOrThrow(ctx);
  ctx.bus.ensureDirs();
  if (!isFile(ctx.registryPath)) { noRegistry(form); return 0; }

  // Row facts (pre-transaction narration + crew scan) from one preserving read.
  const facts = rowFacts(ctx, name);
  const narr = narrationLadder(facts, form.kill, env);
  let queuedInbound: Array<[string, string]> = [];

  if (!form.kill && facts.present && facts.crew) {
    const { blockers, queued } = crewScan(ctx.bus, name, ctx.team);
    if (blockers.length > 0) {
      process.stderr.write(`tap unregister: crew '${name}' has unresolved local obligations:\n${blockers.join("\n")}\n`);
      throw new TapError(1, "lifecycle_refused", `settle the listed obligations, then tap out ${name}`, `crew member '${name}' still has unresolved local transport obligations`, "tap");
    }
    queuedInbound = queued;
  }

  // Transaction: reset custody outside the registry lock; re-prove the selected
  // authority under it; ≤2 attempts with one rebind.
  let removed = false;
  // The live-session census for the pending-reservation gate below; null keeps
  // the gate conservative when tmux cannot answer.
  const liveSessions = tmuxSessionNames(env);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let rebind = false;
    const resetLock = acquireResetMutationLock(ctx.bus.home, "tap unregister", undefined, "shared");
    try {
      const lock = acquireRegistryLock(ctx.registryPath, Infinity);
      if (!lock) throw new TapError(1, "registry_lock_busy", `tap out ${name}`, "acting registry is busy; no retirement published", "tap unregister");
      try {
        if (ctx.selection) {
          try { assertSelectionCurrent(ctx.selection, lock, env.TAP_INDEX_HOME); }
          catch (e) {
            if (e instanceof SelectorError && e.errorClass === "invalid_flip") throw new TapError(1, "invalid_flip", "tap doctor", e.detail, "tap");
            // An old format is not a flip in progress: refuse now, never rebind and retry.
            if (e instanceof SelectorError && e.errorClass === "old_store") throw new TapError(1, e.errorClass, e.action, e.detail, "tap");
            if (e instanceof SelectorError && attempt < 2) rebind = true;
            else if (e instanceof SelectorError) throw new TapError(1, "flip_in_progress", `tap out ${name}`, e.detail, "tap");
            else throw e;
          }
        }
        if (!rebind) {
          removed = retireRow(ctx, env, name, form.team !== undefined, expected, disposition, liveSessions);
          if (removed) postCommit(ctx, form, name, facts.eventPane, facts.crew, narr.windowId, narr.sessionName, queuedInbound, disposition);
        }
      } finally { lock.release(); }
    } finally { resetLock.release(); }
    if (!rebind) {
      if (removed && !facts.crew) withdrawRetiredInbound(ctx, name);
      return 0;
    }
    ctx = retireContext(form, env);
  }
  return 0;
}

/** Retirement disposes the departed seat's inbound dead letters (tap-s1dqn).
 * Runs after the registry publication with no lock held; disposal re-decides
 * each id under its own locks, so a seat restored or re-registered meanwhile
 * keeps its mail. A failure here never undoes the retirement: it is reported,
 * and the operator sweep (`tap cancel --dead-letters`) picks up what is left. */
function withdrawRetiredInbound(ctx: Ctx, name: string): void {
  const notices = process.env.TAP_JSON === "1" ? process.stderr : process.stdout;
  const next = "next: tap cancel --dead-letters --dry-run";
  try {
    const scope = deadLetterScope(ctx.bus, ctx.registryPath, ctx.team);
    const targets = deadLetterTargets(scope, name);
    if (!scope || !targets.length) return;
    const selection = ctx.selection;
    const { disposed, skipped, failed } = disposeDeadLetters(scope, targets, "tap out",
      selection ? (lock) => assertSelectionCurrent(selection, lock, process.env.TAP_INDEX_HOME) : undefined);
    if (disposed.length) notices.write(`tap unregister: withdrew ${disposed.length} unsettled inbound to '${name}' (${disposed.join(", ")}; payloads kept; receipts/<id>.cancelled reason=seat_unresolvable)\n`);
    if (skipped.length) notices.write(`tap unregister: ${skipped.length} inbound to '${name}' not withdrawn (${skipped.map((s) => `${s.id}: ${s.reason}`).join(", ")}); ${next}\n`);
    for (const f of failed) notices.write(`tap unregister: retirement committed; inbound withdrawal stopped at ${f.id}: ${f.reason}; ${next}\n`);
  } catch (error) {
    notices.write(`tap unregister: retirement committed; inbound withdrawal failed before any receipt: ${error instanceof Error ? error.message : String(error)}; ${next}\n`);
  }
}

// Final tombstone row under team-history/. Mutates `row` to carry an instance
// id (the same mint-on-first-retirement the incumbent performed in-lock).
function writeTombstoneRow(ctx: Ctx, name: string, row: JsonMap): string {
  let instance = str(row.get("instance"));
  if (!instance) { instance = mintInstanceId(name); row.set("instance", instance); }
  const retiredBy = `out-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`;
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const tombPath = join(ctx.root, ".tap", "team-history", `${name}.${retiredBy.replace(/\//g, "_").replace(/ /g, "_")}.${ts}.json`);
  const payload: JsonMap = new Map<string, JsonValue>([["handle", name], ["instance", instance], ["retired_by", retiredBy],
    ["retired_at", now.toISOString().replace(/\.\d{3}Z$/, "Z")], ["row", row]]);
  mkdirSync(dirname(tombPath), { recursive: true });
  atomicWrite(tombPath, `${pyDumpIndent(payload, 0)}\n`);
  return tombPath;
}

const IDENTITY_FIELDS = ["instance", "pane_id", "session", "server_socket", "server_epoch", "boot_id", "crew", "delivery", "launch_token"] as const;
function assertRetirementIdentity(row: JsonValue | undefined, expected: Record<string, unknown> | undefined): void {
  const crew = (v: unknown) => v === true || v === 1 || v === 1n;
  // Identity pointers are strings. Malformed metadata is not an incarnation;
  // plain retirement must still be able to clean it up without comparing
  // separately parsed object references (notably object-valued status).
  const pointer = (v: unknown) => typeof v === "string" ? v : undefined;
  if ((!expected && isMap(row)) || (expected && (!isMap(row) || IDENTITY_FIELDS.some(key => key === "crew" ? crew(row.get(key)) !== crew(expected[key]) : pointer(row.get(key)) !== pointer(expected[key]))))) {
    throw new TapError(1, "seat_changed", "inspect the current row before retrying", "selected seat identity changed before retirement; nothing removed", "tap out");
  }
}

function retirementDoc(ctx: Ctx): JsonMap {
  let text: string;
  try { text = pyReadUtf8(ctx.registryPath); } catch (e) { throw new TapError(1, "registry_invalid", "repair_registry", String(e), "tap"); }
  let doc: JsonValue;
  try { doc = loads(text); } catch (e) { throw new TapError(1, "registry_invalid", "repair_registry", `tap unregister: registry '${ctx.registryPath}' is invalid JSON; refusing to touch it (${(e as Error).message})`, "tap"); }
  if (!isMap(doc)) throw new TapError(1, "registry_invalid", "repair_registry", `tap unregister: registry '${ctx.registryPath}' is invalid JSON; refusing to touch it (not an object)`, "tap");
  refuseOldRegistryDoc(ctx.registryPath, doc, "tap");
  return doc;
}

function saveRetirement(ctx: Ctx, doc: JsonValue, env: NodeJS.ProcessEnv): void {
  if (env.TAP_TEST_UNREGISTER_SAVE_FAIL === "1") throw new Error("TAP_TEST_UNREGISTER_SAVE_FAIL");
  atomicWrite(ctx.registryPath, `${pyDumpIndent(doc, 0)}\n`);
}

function tmuxSessionNames(env: NodeJS.ProcessEnv): Set<string> | null {
  const r = tmuxReadOnly(["list-sessions", "-F", "#S"], env);
  return r.code === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

function retireRow(ctx: Ctx, env: NodeJS.ProcessEnv, name: string, required: boolean, expected?: Record<string, unknown>, disposition?: RetirementDisposition,
  liveSessions: Set<string> | null = null): boolean {
  const doc = retirementDoc(ctx);
  const agents = writerSeats(doc);
  const existing = agents.get(name);
  assertRetirementIdentity(existing, expected);
  if (existing === undefined) {
    if (required) throw new TapError(1, "not_found", `tap team --team ${ctx.team}`, `seat '${ctx.team}/${name}' is not registered; no retirement performed`, "tap unregister");
    process.stdout.write(`tap unregister: '${name}' is not registered — nothing to remove\n`); return false;
  }
  let tombPath = "";
  // A pending row is an in-flight launch's reservation; another writer may
  // hold it under shared reset custody since tap-7t3ag, so plain retirement
  // refuses a LIVE reservation by name instead of deleting the launcher's
  // claim. An expired one (the launcher died or the boot changed, per the
  // launcher's own predicate) retires like any stale row, so a crashed launch
  // never strands the handle (tap-7t3ag review round).
  if (isMap(existing) && str(existing.get("status")) === "pending") {
    const reservation = {
      status: "pending",
      status_reason: str(existing.get("status_reason")) || undefined,
      launch_id: str(existing.get("launch_id")) || undefined,
      pane_id: existing.get("pane_id") === undefined || existing.get("pane_id") === null ? undefined : str(existing.get("pane_id")),
      session: str(existing.get("session")) || "",
      boot_id: existing.get("boot_id") === undefined || existing.get("boot_id") === null ? undefined : str(existing.get("boot_id")),
      registered_at: str(existing.get("registered_at")) || "",
    } as unknown as Seat;
    if (!reservationExpired(reservation, liveSessions, Date.now() / 1000, bootId(env) || null, legacyBootId(env) || null)) {
      throw new TapError(1, "seat_launching", `tap out ${name}`,
        `seat '${name}' is a pending launch reservation; retry once the launch settles`, "tap team");
    }
  }
  // An existing NON-object row is deleted without history: the tombstone
  // requires the row's fields, and the incumbent discarded such rows bare.
  if (isMap(existing)) tombPath = writeTombstoneRow(ctx, name, existing);
  try {
    agents.delete(name);
    saveRetirement(ctx, doc, env);
  } catch (e) {
    if (tombPath) {
      try { if (env.TAP_TEST_UNREGISTER_UNLINK_FAIL === "1") throw new Error("TAP_TEST_UNREGISTER_UNLINK_FAIL"); unlinkSync(tombPath); }
      catch (ce) { process.stderr.write(`tap unregister: retirement failed; prepared history remains at ${tombPath}: ${(ce as Error).message}\n`); }
    }
    throw e;
  }
  const verb = disposition?.action === "shutdown" ? "shutdown" : disposition?.action === "out-hard" ? "out --hard" : "unregister";
  if (process.env.TAP_JSON !== "1") process.stdout.write(`tap ${verb}: '${name}' removed from the registry\n`);
  return true;
}

/** Retire one approved parent family in one registry publication. The caller
 * proves the complete current family while this function holds both custody
 * locks. History is prepared before the registry rename and removed if the
 * rename fails. The acting registry document itself is always retained. */
export interface FamilyRetirement { retired: string[]; history: string[]; removedRows: Map<string, JsonMap> }

export interface FamilyRetirementOptions {
  disposition?: RetirementDisposition;
  outcome?: string;
  /** Runs after publication while reset and registry custody remain held. */
  afterPublish?: (retirement: FamilyRetirement) => void;
}

export function retireFamilyRows(
  ctx: Ctx,
  expected: ReadonlyMap<string, Record<string, unknown>>,
  validate: (current: ReadonlyMap<string, Record<string, unknown>>) => readonly string[],
  options: FamilyRetirementOptions = {},
): FamilyRetirement {
  assertResetUnfenced(ctx.bus.home, "tap team out");
  const reset = acquireResetMutationLock(ctx.bus.home, "tap team out", undefined, "shared");
  try {
    const lock = acquireRegistryLock(ctx.registryPath, Infinity);
    if (!lock) throw new TapError(1, "registry_lock_busy", "retry tap team out", "acting registry is busy");
    try {
      if (ctx.selection) assertSelectionCurrent(ctx.selection, lock, process.env.TAP_INDEX_HOME);
      const doc = retirementDoc(ctx);
      const seats = writerSeats(doc);
      const current = new Map<string, Record<string, unknown>>();
      for (const [handle, row] of seats) {
        if (!isMap(row)) throw new TapError(1, "registry_invalid", "repair the acting registry", `seat '${handle}' is not a row`);
        current.set(handle, Object.fromEntries(row) as Record<string, unknown>);
      }
      for (const [handle, old] of expected) {
        const row = seats.get(handle);
        assertRetirementIdentity(row, old);
        if (!isMap(row)) throw new TapError(1, "seat_changed", "inspect the current roster", `seat '${handle}' disappeared before team out`);
      }
      const selected = [...new Set(validate(current))];
      for (const handle of selected) {
        if (!current.has(handle)) throw new TapError(1, "seat_changed", "inspect the current roster", `seat '${handle}' disappeared before team out`);
      }
      const tombs: string[] = [];
      const removedRows = new Map<string, JsonMap>();
      try {
        for (const handle of selected) {
          const row = seats.get(handle) as JsonMap;
          removedRows.set(handle, row);
          tombs.push(writeTombstoneRow(ctx, handle, row));
        }
        for (const handle of selected) seats.delete(handle);
        saveRetirement(ctx, doc, process.env);
      } catch (error) {
        for (const tomb of tombs) {
          try { unlinkSync(tomb); }
          catch (cleanup) { process.stderr.write(`tap team out: prepared history remains at ${tomb}: ${cleanup}\n`); }
        }
        throw error;
      }
      markResetGenerationReused(ctx.bus.home, "team-out");
      for (const handle of selected) {
        const row = current.get(handle);
        const pane = typeof row?.pane_id === "string" ? row.pane_id : typeof row?.pane === "string" ? row.pane : "";
        retirementEvent(ctx, handle, pane, options.disposition, options.outcome ?? "retired");
      }
      const retirement = { retired: selected, history: tombs, removedRows };
      options.afterPublish?.(retirement);
      return retirement;
    } finally { lock.release(); }
  } finally { reset.release(); }
}

/** Restore only positively surviving members of this retirement. A new row
 * with the same handle wins and makes rollback refuse rather than erasing
 * another registration. Stopped/unknown members retain their history. */
export function restoreFamilyRows(ctx: Ctx, retirement: FamilyRetirement,
  surviving: ReadonlySet<string> = new Set(retirement.retired)): string[] {
  if (surviving.size === 0) return [];
  for (const handle of surviving) if (!retirement.removedRows.has(handle)) {
    throw new TapError(1, "registry_restore_refused", "inspect retained team-out history",
      `seat '${handle}' is not part of this retirement; rollback was refused`);
  }
  const reset = acquireResetMutationLock(ctx.bus.home, "tap team out self restore", undefined, "shared");
  try {
    const lock = acquireRegistryLock(ctx.registryPath, Infinity);
    if (!lock) throw new TapError(1, "registry_lock_busy", "inspect retained team-out history", "acting registry is busy; self-stop rollback was not published");
    try {
      if (ctx.selection) assertSelectionCurrent(ctx.selection, lock, process.env.TAP_INDEX_HOME);
      const doc = retirementDoc(ctx);
      const seats = writerSeats(doc);
      for (const handle of surviving) if (seats.has(handle)) {
        throw new TapError(1, "registry_restore_refused", "inspect retained team-out history",
          `seat '${handle}' was re-registered after retirement; rollback would overwrite its replacement`);
      }
      for (const [handle, row] of retirement.removedRows) if (surviving.has(handle)) seats.set(handle, row);
      if (process.env.TAP_TEST_UNREGISTER_RESTORE_FAIL === "1") throw new Error("TAP_TEST_UNREGISTER_RESTORE_FAIL");
      saveRetirement(ctx, doc, process.env);
      markResetGenerationReused(ctx.bus.home, "team-out-restore");
      const retained: string[] = [];
      for (const [index, path] of retirement.history.entries()) {
        if (!surviving.has(retirement.retired[index]!)) continue;
        try { unlinkSync(path); }
        catch { retained.push(path); }
      }
      return retained;
    } finally { lock.release(); }
  } finally { reset.release(); }
}

export function retirementEvent(ctx: Ctx, name: string, eventPane: string, disposition?: RetirementDisposition, outcome?: string): void {
  appendRegistryEventOrWarn("tap", { log: registryEventsPath(ctx.bus.home), actor: name,
    action: disposition?.row.scope === "team" ? disposition.row.mechanism
      : !disposition || disposition.action === "out" ? "unregistered" : disposition.action,
    handle: name, pane: eventPane, team: ctx.team,
    detail: disposition ? `lifecycle_action=${disposition.action};mechanism=${disposition.row.mechanism}${outcome ? `;outcome=${outcome}` : ""}` : "" });
}

export function retirementReceipt(ctx: Ctx, name: string, disposition: RetirementDisposition, fields: Record<string, unknown>, collect?: (receipt: Record<string, unknown>) => void): void {
  const receipt = { ok: true, team: ctx.team, handle: name, lifecycle_action: disposition.action,
    mechanism: disposition.row.mechanism, registry_fate: disposition.row.registry, ...fields };
  if (collect) collect(receipt);
  else if (process.env.TAP_JSON === "1") writeSync(1, JSON.stringify(receipt) + "\n");
}

function postCommit(ctx: Ctx, form: PlainForm, name: string, eventPane: string, crew: boolean, windowId: string, sessionName: string, queued: Array<[string, string]>, disposition?: RetirementDisposition): void {
  markResetGenerationReused(ctx.bus.home, "unregister");
  retirementEvent(ctx, name, eventPane, disposition);
  if (!crew && disposition) retirementReceipt(ctx, name, disposition, { outcome: "retired" });
  const json = process.env.TAP_JSON === "1";
  if (form.dash && !json) process.stdout.write(`tap unregister: '-' removed '${name}' (most recently exited)\n`);
  const notices = json ? process.stderr : process.stdout;
  for (const [id, from] of queued) {
    notices.write(`tap unregister: queued inbound spool '${id}' from '${from}' remains sender-owned\n`);
    notices.write(`tap unregister: sender next: tap cancel ${id} --by ${from}\n`);
  }
  if (json) return;
  if (form.kill) return;
  if (!crew && sessionName && tmux(["has-session", "-t", `=${sessionName}`], process.env).code === 0) {
    process.stdout.write(`tap unregister: tmux session '${sessionName}' is still running; conversation stays resumable\n`);
    process.stdout.write(`tap unregister: next: tmux kill-session -t '=${sessionName}'\n`);
  }
}

// --- Shared hard-removal transaction ------------------------------------------

// TAP_SCRATCH_ONLY (tap-kf9) declares the prefix every state root cleared this
// session lives under; a clearing verb refuses a RESOLVED root outside it. Opt-in
// and additive (unset changes nothing; set, it only refuses more), and it reads
// the final resolved root just before mutation — resolution landing somewhere
// the caller did not believe it was is exactly what it catches (2026-07-13).
// tap-2o38: TAP_SCRATCH_ONLY must cover --kill — a destructive session-
// terminating verb whose conversation is lost, NOT re-derivable state.
// `label` names the verb in the refusal's verbLabel slot; callers whose Bash
// twin set TAP_VERB (crew remove) pass their own.
export function scratchOnlyGuard(env: NodeJS.ProcessEnv, what: string, root: string, label = "tap unregister"): void {
  const declared = env.TAP_SCRATCH_ONLY;
  if (!declared) return;
  const canon = (p: string): string => {
    let r = p;
    try { r = realpathSync(p); } catch { /* keep the literal */ }
    return r.replace(/\/+$/, "") || "/";
  };
  const d = canon(declared);
  const r = canon(root);
  if (r === d || d === "/" || r.startsWith(`${d}/`)) return;
  throw new TapError(1, "scratch_only_refused", "unset TAP_SCRATCH_ONLY, or point it at the state root you actually meant to clear",
    `TAP_SCRATCH_ONLY declares '${d}' but ${what} resolved to '${r}' — refusing to clear state outside the declared scratch prefix`, label);
}

function killEntry(ctx: Ctx, form: PlainForm, name: string, facts: RowFacts, disposition: RetirementDisposition): number {
  const env = process.env;
  fenceOrThrow(ctx);
  ctx.bus.ensureDirs();
  if (!isFile(ctx.registryPath)) { noRegistry(form); return 0; }
  scratchOnlyGuard(env, "a registry hard removal would stop a session on", ctx.bus.home);
  // Poll/missing/scalar rows have no terminal effect; the same registry-only
  // transaction handles them, preserving bare out's idempotent missing arm.
  if (!facts.present || facts.delivery === "poll") return retireSelected(ctx, form, name, facts.row, disposition);
  const outcome = { retired: false };
  const code = killTransaction(ctx, form, name, facts, disposition, outcome);
  // Only a retirement that stood — the session is gone, so no rollback restored
  // the row — disposes inbound, and only after every lock is released.
  if (outcome.retired) withdrawRetiredInbound(ctx, name);
  return code;
}

function killTransaction(ctx: Ctx, form: PlainForm, name: string, facts: RowFacts, disposition: RetirementDisposition, outcome: { retired: boolean }): number {
  const env = process.env;
  const resetLock = acquireResetMutationLock(ctx.bus.home, "tap hard removal", undefined, "shared");
  try {
    const lock = acquireRegistryLock(ctx.registryPath, Infinity);
    if (!lock) throw new TapError(1, "registry_lock_busy", "retry after the registry unlocks", "no retirement published");
    try {
      lockedAuthorityOrInvalid(ctx, env, lock);
      const doc = retirementDoc(ctx), rows = writerSeats(doc), entry = rows.get(name);
      assertRetirementIdentity(entry, facts.row);
      if (!isMap(entry)) throw new TapError(1, "seat_changed", "inspect the registry", "selected seat disappeared");
      const expectedSession = canonicalSessionName(ctx.team, name);
      const seat = Object.fromEntries(entry) as Seat;
      if (seat.session !== expectedSession || seat.status === "pending" || seat.launch_token) {
        throw new TapError(1, "session_identity_mismatch", "inspect the registration", "hard removal requires this seat's exact durable session and no launch in progress");
      }
      if (seat.server_socket && seat.server_socket !== physicalSocketPath()) throw new TapError(1, "session_identity_mismatch", "select the recorded tmux server", "seat belongs to another tmux socket; nothing removed");
      const snapshot = seatSnapshot();
      const pane = liveSeat(seat, expectedSession, snapshot);
      const all: Record<string, Seat> = {};
      for (const [handle, raw] of rows) if (isMap(raw)) {
        all[handle] = { ...Object.fromEntries(raw), crew: raw.get("crew") === true || raw.get("crew") === 1n } as Seat;
      }
      for (const [handle, other] of Object.entries(all)) {
        if (handle === name || other.delivery === "poll") continue;
        const shares = other.session === expectedSession || snapshot.panes.some(p => p.id === other.pane_id && p.session === expectedSession);
        if (shares && !(other.crew === true && other.session === expectedSession)) {
          throw new TapError(1, "shared_durable_session", "use the team lifecycle command", `seat '${handle}' shares this session; nothing removed`);
        }
      }
      const crews = disposition.row.crews === "consume-d-contract" ? ownedCrewRows(all, expectedSession, snapshot) : [];
      const original = cloneJson(doc), tombs: string[] = [];
      const cleanup = (): string[] => {
        const retained: string[] = [];
        for (const path of tombs) {
          try {
            if (env.TAP_TEST_UNREGISTER_UNLINK_FAIL === "1") throw new Error("injected unlink failure");
            unlinkSync(path);
          } catch { retained.push(path); }
        }
        return retained;
      };
      try {
        for (const handle of [name, ...crews]) {
          tombs.push(writeTombstoneRow(ctx, handle, rows.get(handle) as JsonMap));
          rows.delete(handle);
        }
        saveRetirement(ctx, doc, env);
      } catch (error) {
        const retained = cleanup();
        throw new TapError(1, retained.length ? "history_cleanup_failed" : "registry_save_failed",
          retained.length ? `inspect retained history before cleanup: ${retained.join(", ")}` : `tap out ${ctx.team}/${name} --hard`,
          `registry save failed; ${retained.length ? `history remains at ${retained.join(", ")}` : "prepared history rolled back"}: ${error}`);
      }
      markResetGenerationReused(ctx.bus.home, "unregister");
      const record = (outcome: string) => retirementEvent(ctx, name, facts.eventPane, disposition, outcome);
      record(pane ? "stop_requested" : "already_stopped");
      const fields = { session: expectedSession, crews };
      const callerSocket = env.TMUX ? physicalSocketPath({ ...env, TAP_TMUX_SOCKET: undefined, TAP_TMUX_SOCKET_PATH: undefined }) : "";
      const self = !!pane && callerSocket === physicalSocketPath() && snapshot.panes.some(p => p.id === env.TMUX_PANE && p.sessionId === pane.sessionId);
      const render = (outcome: string) => {
        retirementReceipt(ctx, name, disposition, { ...fields, outcome });
        if (env.TAP_JSON !== "1") writeSync(1, `tap ${disposition.action}: '${name}' removed from the registry; ${outcome === "stopped" ? `stopped tmux session '${expectedSession}'` : outcome}\n`);
      };
      if (self) { render("stop_requested"); form.selfReported = true; }
      if (!pane) { render("already_stopped"); outcome.retired = true; return 0; }
      // Publication always precedes the one guarded effect. An exception or
      // nonzero exit can have acted; only a fresh observation decides rollback.
      let effectDetail = "";
      try { const result = stopExactPane(pane); effectDetail = result.stderr.trim() || result.stdout.trim(); }
      catch (error) { effectDetail = String(error); }
      let survived: boolean;
      try { survived = seatSnapshot().panes.some(p => p.sessionId === pane.sessionId && p.rawEpoch === pane.rawEpoch); }
      catch (error) {
        record("stop_unverified");
        const detail = `stop outcome unobservable; published retirement and history retained at ${tombs.join(", ")}: ${error}`;
        if (!self) retirementReceipt(ctx, name, disposition, { ...fields, ok: false, outcome: "stop_unverified", error_class: "stop_unverified", action: `inspect tmux session '${expectedSession}'; do not retry the stop`, detail });
        if (self || env.TAP_JSON !== "1") writeSync(2, `tap ${disposition.action}: ${detail}; inspect tmux; do not retry the stop\n`);
        return 1;
      }
      if (survived) {
        try {
          if (env.TAP_TEST_UNREGISTER_RESTORE_FAIL === "1") throw new Error("injected restore failure");
          saveRetirement(ctx, original, env);
        } catch (error) {
          record("restore_failed");
          throw new TapError(1, "registry_restore_failed", "repair from the retained history before retrying",
            `session survived; registry restore failed; history remains at ${tombs.join(", ")}: ${error}`);
        }
        record("registry_restored");
        const retained = cleanup();
        throw new TapError(1, "session_kill_failed", `tap out ${ctx.team}/${name} --kill`,
          `session survived; registry restored${retained.length ? `; history remains at ${retained.join(", ")}` : ""}: ${effectDetail}`);
      }
      if (!self) render("stopped");
      outcome.retired = true;
      return 0;
    } finally { lock.release(); }
  } finally { resetLock.release(); }
}
