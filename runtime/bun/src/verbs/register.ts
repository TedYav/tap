import { launchPlacedInWorktree } from "../launch-evidence";
import { paneEnrollmentRefusal } from "../pane-enrollment";
import { duplicateIdentityOwner } from "../session-identity-owner";
import { Bus, isCanonicalPayloadName } from "../bus";
import { busHomeForRoot, requireResolvedBus, resolveBus } from "../bushome";
import { recapMessages } from "../recap-payloads";
import { spoolAuthorized } from "../payload-view";
// Checkpoint C — the ordinary `tap register|in` owner, native end to end.
// Ported from skills/tap/scripts/tap-register.sh (+ its embedded Python, the
// register-offline slice and the register-forms dispatcher) in the incumbent
// stage order under the checkpoint-C omission contract: the legacy authority
// route is omitted, an old store refuses BEFORE any write, and the agy
// delivery-adapter capture is omitted while the generic identity ladder stays.
// Chooser facts ride the incumbent contract: one tap_pane_observe record per
// probed target (never a server-wide gather), seat-verdict pure predicates and
// the spool-park-report server epoch for the decision functions.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { versionBriefing } from "../version-briefing";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { historyDirForBus } from "../addressee-grant";
import { TapError, observeCallerPaneChain, observeCallingPane, resolveContext, spoolTeamName } from "../context";
import { nativeOpenCodeCaller } from "../opencode-service";
import type { PaneLock } from "../panelock";
import { chooserView, gather, paneHarnessCommand } from "../observe-gather";
import { memoizedToplevel } from "../git-root";
import { addressedToLocalFields, senderInstanceMatchesFields } from "./seat-refresh";
import { reservationExpired } from "../reservation";
import { appendRegistryEventOrWarn } from "../events";
import { acquireResetMutationLock, assertResetUnfenced, fenceTestBarrier, markResetGenerationReused } from "../reset";
import { atomicWrite } from "../fsatomic";
import { pyDumpIndent } from "../lossless-json";
import { actingRegistryForTeamOverride, enrolledNameForRootFromDoc, flipMarkerState, globalRegistryPath, isRegularFile, loadGlobalRegistry, resolveTeamFromGlobal } from "../index-home";
import { shellQuote } from "../shell-quote";
import { rootIndexable, enrollPreflight, teamNameForRoot, bornLiveBootstrap, bootstrapPostflipEnroll, enrollTeam, oldStoreEvidence, oldStoreRefusalText, legacyAgentsAxisStore, oldStoreAction, teamRegistryPath, teamRegistryFileRefusal, teamRegistryRefusal, isOldStoreRefusal, unenrolledSeatsRefusal, type EnrollOutcome, type EnrollRefusalKind } from "../register-authority";
import { humanLine } from "../native-error";
import { ensureSeatInstance, currentInstance, resolveHandleByPane, supersedeForwardingAliases, type RegistryDoc } from "../registry";
import { acquireRegistryLock, lockRoot } from "../panelock";
import { agentFamilies, harnessFallbackHandle } from "../observe";
import { pidHasAncestor } from "../process-ancestry";
import { isPaneId } from "../lifecycle-target";
import { SEAT_ALIVE, SEAT_PANE_GONE, SEAT_PANE_RECYCLED, SEAT_UNOBSERVABLE, isLaunchReservation, samePaneIdentity, seatVerdict, type ChooserObservation } from "../seat-verdict";
import { MAX_ADOPTED_HANDLES, frontmatter } from "../seat-adopt";
import { bootId, bootIdsMatch, legacyBootId, physicalSocketPath, serverEpochFromRaw, tmux, paneCurrentPath, observePaneResult, type PaneObservation as TmuxPaneObservation } from "../tmux";
import { serverEpochNow } from "../spool-park-report";
import { isMap, loads, pyStr, pyTruthy, dumps, type JsonMap, type JsonValue } from "../watch-detect";
import { windowSeconds, driverConfigPath, updateConfig } from "../digest-window";
import { verbose } from "../verbose";
import { derive as sessionDerive , type Attribution } from "../session-store";
import { forwardingRoute } from "../forwarding";
import { validateLockedRegistryAuthority as sharedValidateAuthority } from "../slices/registry-authority";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { USER_IDENTITY } from "../ids";
import { artifactBun, runtimeModule, tapScriptsDir } from "../scripts-dir";

const TAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COURIER_IDENTITY = "courier";
const REGISTER_SCRIPTS_DIR = `${tapScriptsDir()}/`;

// SessionStart-phase timing (launchfast item 3a): phases of the hook's `tap in`
// land in startup.jsonl only when the hook drove this process, so an ordinary
// `tap in` stays quiet and byte-identical in behavior. Events ride the shared
// trace writer when one is open (see cmdRegister) and are silently dropped
// otherwise; they never take a lock the bind contends on.
let registerTraceBeginMs = 0;
function hookTrace(event: string, fields: Record<string, unknown> = {}): void {
  if (!process.env.TAP_SESSION_SOURCE) return;
  startupTrace(event, fields);
}

const HARNESS_FAMILY_WORDS = ["claude", "codex", "opencode", "cursor", "hermes", "agy"];
function tapIsHarness(w: string): boolean {
  return HARNESS_FAMILY_WORDS.includes(w);
}

/** tap_derive_handle: a short, TEAM-LOCAL handle from a globally-unique tmux
 *  session name. <team>/<handle> launcher names strip the prefix; legacy
 *  <team>-<harness>[-<tag>][-<index>] names still derive (trailing 0/1 are
 *  legacy noise, >=2 is dedup identity; a harness tag names the role and
 *  wins). Echoes "" for an unusable result. */
function deriveHandle(session: string, teamName: string): string {
  if (session === "") return "";
  let s = session;
  if (teamName !== "" && s.startsWith(`${teamName}/`)) {
    const rest = s.slice(teamName.length + 1);
    if (rest.includes("/") || /^[0-9]+$/.test(rest) || !TAP_ID_RE.test(rest)) return "";
    return rest;
  }
  if (teamName !== "" && (s.startsWith(`${teamName}-`) || s.startsWith(`${teamName}_`))) {
    s = s.slice(teamName.length + 1);
  }
  let idx = "";
  const m = s.match(/^(.+)[-_]([0-9]+)$/);
  if (m) {
    idx = m[2]!;
    s = m[1]!;
    if (parseInt(idx, 10) < 2) idx = "";
  }
  if (s === "") return "";
  if (s.includes("-")) {
    const head = s.slice(0, s.indexOf("-"));
    const rest = s.slice(s.indexOf("-") + 1);
    if (rest !== "" && tapIsHarness(head)) s = rest;
  }
  if (/^[0-9]+$/.test(s)) return "";
  if (idx !== "") s = `${s}-${idx}`;
  return TAP_ID_RE.test(s) ? s : "";
}
const WATCH_IDENTITY_DEFAULT = "watcher";
const RESERVED_DEFAULT = "help";
const VALUE_OPTIONS = new Set(["--digest-window", "--pane", "--mode", "--include", "--delivery", "--team", "--wake-url", "--reply-to", "--restore", "--harness-session-id"]);
const FLAG_OPTIONS = new Set(["--json", "--verbose", "--include-asks", "--offline", "--remove", "--override-worktree", "--force", "--namespace-crossing", "--unattended", "--crew", "--list-history", "--fresh", "--accept-observed-identity"]);

type Env = NodeJS.ProcessEnv;

function fail(code: number, errorClass: string, action: string, detail: string): never {
  throw new TapError(code, errorClass, action, detail, "tap register");
}

function run(argv: string[], opts: { cwd?: string; env?: Env } = {}): number | null {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", timeout: 15_000 });
  if (r.error) return null;
  return r.status ?? 1;
}

function gitOut(args: string[], cwd: string, env?: Env): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

/** Worktree roots are memoized per invocation (`git-root.ts`): the enrollment
 *  walk, worktree derivation, authority validation and bus-home discovery ask
 *  the same question of the same directory, and one `git rev-parse` answers.
 *  git sees the process environment; a caller's mutated env copy changes no
 *  git-visible fact this probe reads. */
function gitToplevelFor(_cwd: string, _env?: Env): string | null {
  return memoizedToplevel(_cwd) || null;
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function str(v: JsonValue | undefined): string { return v === undefined ? "" : pyStr(v); }

function fieldStr(entry: JsonMap | null | undefined, key: string): string {
  const v = entry?.get(key);
  return typeof v === "string" ? v : v === undefined || v === null ? "" : str(v);
}

function rowActive(entry: JsonMap | null): boolean {
  return entry !== null && (!entry.has("status") || entry.get("status") === "active");
}

/**
 * The seats map a register write mutates. Only a seats map beside no `agents`
 * key is writable; `create` (a missing file) is the only case that adds one.
 */
function currentSeats(doc: JsonMap, path: string, create = false): JsonMap {
  if (doc.has("agents")) fail(1, "old_store", oldStoreAction("agents_axis"), oldStoreRefusalText(path, "agents_axis"));
  const seats = doc.get("seats");
  if (isMap(seats)) {
    const refusal = teamRegistryRefusal(path, doc);
    if (refusal) fail(1, refusal.errorClass, refusal.action, refusal.detail);
    return seats;
  }
  if (seats !== undefined || !create) fail(1, "registry_invalid", "repair_registry", `registry '${path}' has no seats object; refusing to add one`);
  const empty = new Map<string, JsonValue>();
  doc.set("seats", empty);
  return empty;
}

// --- form (verbatim port of the M2 U1 dispatcher walk) ---------------------------

export interface RegisterForm {
  name: string; pane: string; mode: string; modeSet: boolean; include: string; includeSet: boolean; offline: boolean;
  overrideWorktree: boolean; force: boolean; json: boolean; unattended: boolean;
  verbose: boolean; crew: boolean; delivery: string; team: string; wakeUrl: string;
  replyTo: string; digestWindow: string; digestIncludeAsks: boolean; listHistory: boolean;
  restoreId: string; fresh: boolean; acceptObserved: boolean; namespaceCrossing: boolean; harnessSessionId: string;
}

export function parseRegisterForm(argv: string[]): RegisterForm {
  const f: RegisterForm = {
    name: "", pane: "", mode: "", modeSet: false, include: "", includeSet: false, offline: false, overrideWorktree: false,
    force: false, json: false, unattended: false, verbose: false, crew: false, delivery: "",
    team: "", wakeUrl: "", replyTo: "", digestWindow: "", digestIncludeAsks: false,
    listHistory: false, restoreId: "", fresh: false, acceptObserved: false,
    namespaceCrossing: false, harnessSessionId: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      if (VALUE_OPTIONS.has(token)) {
        const value = argv[i + 1];
        if (value === undefined || value === "") throw new TapError(1, "usage_error", "tap help register", `${token} needs a value`, "tap register"); // bash ${2:?} shape
        i++;
        if (token === "--pane") f.pane = value;
        else if (token === "--mode") { f.mode = value; f.modeSet = true; }
        else if (token === "--include") { f.include = value; f.includeSet = true; }
        else if (token === "--delivery") f.delivery = value;
        else if (token === "--team") f.team = value;
        else if (token === "--wake-url") f.wakeUrl = value;
        else if (token === "--reply-to") f.replyTo = value;
        else if (token === "--digest-window") f.digestWindow = value;
        else if (token === "--restore") f.restoreId = value;
        else if (token === "--harness-session-id") f.harnessSessionId = value;
        continue;
      }
      if (!FLAG_OPTIONS.has(token)) throw new TapError(1, "unknown_option", "tap help register", `unknown option '${token}'`, "tap register");
      if (token === "--json") f.json = true;
      if (token === "--verbose") f.verbose = true;
      if (token === "--include-asks") f.digestIncludeAsks = true;
      if (token === "--offline" || token === "--remove") f.offline = true;
      if (token === "--override-worktree") f.overrideWorktree = true;
      if (token === "--force") f.force = true;
      if (token === "--namespace-crossing") f.namespaceCrossing = true;
      if (token === "--unattended") f.unattended = true;
      if (token === "--crew") f.crew = true;
      if (token === "--list-history") f.listHistory = true;
      if (token === "--fresh") f.fresh = true;
      if (token === "--accept-observed-identity") f.acceptObserved = true;
      continue;
    }
    if (f.name) throw new TapError(1, "usage_error", "tap help register", `unexpected arg '${token}'`, "tap register");
    f.name = token;
  }
  return f;
}

// --- authority: consume the shared owner (slices/registry-authority.ts); the
// call-site adapter keeps the incumbent retry/code pair and bare detail (the
// error renderer adds its own label) ---------------------------------------------

export interface AuthorityOutcome {
  ok: boolean; retry: boolean; code: number; detail: string;
}

function validateLockedRegistryAuthority(
  lockedPath: string, root: string, indexHome: string,
  opts: { allowUnenrolledCanonical?: boolean; requireLive?: boolean } = {},
): AuthorityOutcome {
  const { requireLive = true, ...rest } = opts;
  const v = sharedValidateAuthority(lockedPath, root, indexHome, { ...rest, requireLive });
  if (v.ok) return { ok: true, retry: false, code: 0, detail: "" };
  return { ok: false, retry: v.retry, code: v.retry ? 17 : 4, detail: v.message.replace(/^tap: /, "") };
}


/** Bound registry waits while registration owns the team's reset sidecar.
 *  An explicit positive timeout remains supported; invalid values refuse. */
export function registerLockTimeoutMs(env: Env): { ms: number } | { invalid: true } {
  const raw = env.TAP_REGISTER_LOCK_TIMEOUT ?? "";
  if (raw.trim() === "") return { ms: 10_000 };
  const v = Number(raw);
  if (!Number.isFinite(v) || !(v > 0)) return { invalid: true };
  return { ms: v * 1000 };
}

function acquireRegistrationRegistryLock(path: string, timeoutMs: number) {
  // The former infinite-wait helper opened the sidecar before spawning lockf.
  // Keep that refusal boundary: lockf can otherwise successfully lock a directory.
  closeSync(openSync(`${path}.lock`, "a"));
  return acquireRegistryLock(path, timeoutMs);
}

// --- ensure team (verbatim port of lib.sh tap_registry_ensure_team) --------------

/** The team block's required fields, applied in memory. tap-mhuok: each arm
 *  calls this on the document it is about to write, so a registration the arm
 *  refuses never publishes them; ensureTeamBlock applies it only to birth a
 *  registry file. */
function ensureTeamFields(reg: JsonMap, worktree: string, branch: string): void {
  const team = reg.get("team");
  if (!isMap(team)) {
    reg.set("team", new Map<string, JsonValue>([
      ["branch_at_bootstrap", branch], ["created_at", nowIso()],
      ["name", basename(worktree.replace(/\/+$/, ""))], ["schema_version", "1"], ["worktree_root", worktree],
    ]));
  } else if (!team.has("name")) team.set("name", basename(worktree.replace(/\/+$/, "")));
}

export function ensureTeamBlock(
  registryPathIn: string, worktree: string, branch: string, indexHome: string,
  lockTimeoutMs: number, rebind: () => string, requireLive = true,
): { ok: true; path: string } | { ok: false; code: number; detail: string } {
  let path = realOrSelf(registryPathIn);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const teamBlockLockMs = performance.now();
    const lock = acquireRegistrationRegistryLock(path, lockTimeoutMs);
    hookTrace("register_lock_acquired", { lock: "registry", stage: "team_block", acquired: lock !== null, wait_ms: Math.round(performance.now() - teamBlockLockMs) });
    if (lock === null) return { ok: false, code: 75, detail: `registry lock busy` };
    let rc = 0, detail = "";
    try {
      const auth = validateLockedRegistryAuthority(path, worktree, indexHome, { allowUnenrolledCanonical: true, requireLive });
      if (!auth.ok) { rc = auth.retry ? 17 : 4; detail = auth.detail; }
      else {
        let reg: JsonMap | null = null;
        if (existsSync(path)) {
          try {
            const parsed = loads(readFileSync(path, "utf8"));
            if (!isMap(parsed)) throw new Error("not an object");
            reg = parsed;
          } catch (e) {
            rc = 1;
            detail = `registry '${path}' is invalid JSON; refusing to overwrite it (${(e as Error).message})`;
          }
        }
        if (rc === 0) {
          // A created registry is born in the current format, like bootstrapPostflipEnroll's.
          const creating = reg === null;
          if (reg === null) reg = new Map<string, JsonValue>([["schema", "0.20"]]);
          ensureTeamFields(reg, worktree, branch);
          currentSeats(reg, path, creating);
          // An existing registry is only validated here; the arm that admits the
          // registration writes the fields with its own change (tap-mhuok).
          if (creating) atomicWrite(path, `${pyDumpIndent(reg, 0).replace(/\u007f/g, "\\u007f")}\n`);
        }
      }
    } finally {
      lock.release();
    }
    if (rc === 0) return { ok: true, path };
    if (rc === 17 && attempt < 2) {
      // The rebind re-resolves the acting registry; the retry must LOCK THE
      // NEW PATH, not the one that just failed the authority proof (the
      // incumbent re-exported TAP_REGISTRY and looped).
      const next = rebind();
      if (next !== "") {
        path = next;
        mkdirSync(dirname(path), { recursive: true });
        continue;
      }
    }
    return { ok: false, code: rc, detail };
  }
  return { ok: false, code: 1, detail: "registry team bootstrap failed" };
}

// --- history (verbatim port of registry_v20.list_handle_history) ------------------

export interface HistoryRow extends JsonMap {}

export function listHandleHistory(busHome: string, handle: string, historyDir = historyDirForBus(busHome)): JsonMap[] {
  try {
    if (!statSync(historyDir).isDirectory()) return [];
  } catch { return []; }
  const names = readdirSync(historyDir); // exists but unreadable is a failure, not "no history"
  const prefix = `${handle}.`;
  const rows: JsonMap[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json") || name.includes(".lineage.")) continue;
    const full = join(historyDir, name);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    let data: JsonMap;
    try {
      const parsed = loads(readFileSync(full, "utf8"));
      if (!isMap(parsed)) continue;
      data = parsed;
    } catch { continue; }
    if (data.get("handle") !== handle) continue;
    rows.push(new Map<string, JsonValue>([
      ["instance", data.get("instance") ?? null],
      ["retired_by", data.get("retired_by") ?? null],
      ["retired_at", data.get("retired_at") ?? null],
    ]));
  }
  const key = (row: JsonMap) => (pyTruthy(row.get("retired_at")) ? pyStr(row.get("retired_at")) : "");
  rows.sort((a, b) => (key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : 0));
  return rows;
}

/** Pane-session lineage append (`<handle>.lineage.jsonl`, registry_v20
 *  contract): one alphabetically-keyed JSON line per rebind/restore/fresh.
 *  Warning-only at the call site; a failed append never refuses a seat. */
function appendPaneSessionLog(busHome: string, handle: string, instance: string,
  pane: string, paneId: string, harnessSessionId: string, note: string): void {
  const hist = historyDirForBus(busHome);
  if (hist === "") return;
  mkdirSync(hist, { recursive: true });
  const line: Record<string, string> = {
    harness_session_id: harnessSessionId,
    instance,
    note,
    pane,
    pane_id: paneId,
    ts: new Date().toISOString().replace("Z", "000Z"),
  };
  appendFileSync(join(hist, `${handle}.lineage.jsonl`), `${JSON.stringify(line)}\n`);
}


// tap-9aj1k: every commit write that mints or reuses an instance for a handle
// must retire that handle's stale forwarding aliases (supersedeForwardingAliases
// in registry.ts, which the plain-object saveRegistry() path applies on every
// save) — but registry.ts's RegistryDoc is a plain object while this file's
// doc/agents are the Map-based JsonMap, so the shared function cannot be called
// directly. Bridge through the same in-repo bun subprocess the incumbent
// offline arm already used for this exact purpose, factored so every write
// site shares it instead of only the offline arm getting it.
function supersedeStaleForwardingAliases(doc: JsonMap, agents: JsonMap): void {
  const forwardings = doc.get("seat_forwardings");
  if (!pyTruthy(forwardings) || !Array.isArray(forwardings)) return;
  const seatsOut: Record<string, unknown> = {};
  for (const [handle, row] of agents.entries()) seatsOut[handle] = isMap(row) ? { instance: row.get("instance") ?? null } : {};
  // tap-kwjba: embed the already-lossless dumps() text directly rather than
  // parsing it back into plain JS numbers first — that round trip is exactly
  // what silently rounds an unrelated unknown-extension integer riding
  // inside a forwarding record (e.g. 9007199254740993 -> ...992).
  const input = `{"seats":${JSON.stringify(seatsOut)},"seat_forwardings":${dumps(forwardings, true)}}`;
  const r = spawnSync(artifactBun() ?? "bun", [runtimeModule("src/forwarding.ts"), "supersede"], {
    input,
    encoding: "utf8",
  });
  if (r.status !== 0) fail(1, "registry_invalid", "repair_registry", `tap register: forwarding supersede failed (${(r.stderr || "").trim()})`);
  doc.set("seat_forwardings", (loads(r.stdout || "") as JsonMap).get("seat_forwardings")!);
}

// --- offline arm (verbatim port of the register-offline slice body) ---------------

export interface OfflineOutcome { priorExisting: boolean }

export function registerOffline(
  registryPathIn: string, name: string, worktree: string, indexHome: string, rebind: () => string,
  env: Env = process.env, fence?: PaneLock, requireLive = true, branch?: string,
): OfflineOutcome {
  const timeout = registerLockTimeoutMs(env);
  if ("invalid" in timeout) fail(2, "error", "set TAP_REGISTER_LOCK_TIMEOUT to a finite positive number", "invalid TAP_REGISTER_LOCK_TIMEOUT");
  let registryPath = realOrSelf(registryPathIn);
  for (let attempt = 1; attempt <= 2; attempt++) {
  const lock = acquireRegistrationRegistryLock(registryPath, timeout.ms);
  if (lock === null) fail(1, "registry_lock_busy", "tap register", `registry lock for '${registryPath}' is busy or timed out — retry once the write completes`);
  try {
    const auth = validateLockedRegistryAuthority(registryPath, worktree, indexHome, { requireLive });
    if (!auth.ok) {
      if (auth.retry) {
        const next = attempt < 2 ? rebind() : "";
        if (next !== "") { registryPath = next; continue; }
        fail(1, "flip_in_progress", `tap in ${name} --offline`, auth.detail);
      }
      fail(1, "invalid_flip", "tap doctor", auth.detail);
    }
    let isFile = false;
    try { isFile = statSync(registryPath).isFile(); } catch { isFile = false; }
    let doc: JsonMap = new Map<string, JsonValue>();
    if (isFile) {
      let parsed: JsonValue;
      try {
        parsed = loads(readFileSync(registryPath, "utf8"));
      } catch (e) {
        fail(1, "registry_invalid", "repair_registry", `registry '${registryPath}' is invalid JSON; refusing to overwrite it (${(e as Error).message})`);
      }
      if (!isMap(parsed)) fail(1, "registry_invalid", "repair_registry", `registry state doc is not an object: ${registryPath}`);
      doc = parsed;
    }
    if (branch !== undefined) ensureTeamFields(doc, worktree, branch);
    const agents = currentSeats(doc, registryPath, !isFile);
    let ent = (agents as JsonMap).get(name);
    const priorExisting = ent !== undefined && ent !== null;
    if (!priorExisting) {
      process.stderr.write(`tap register: warning: no existing entry for '${name}' — creating offline placeholder\n`);
      ent = new Map<string, JsonValue>();
    }
    if (!isMap(ent)) fail(1, "registry_invalid", "repair_registry", `tap register: existing entry for '${name}' is not an object — refusing offline mutation`);
    // Offline would overwrite the reason with user_removed, after which a plain
    // poll registration could clear the seat; the mark survives until its own
    // pane re-registers.
    if (fieldStr(ent as JsonMap, "status") === "suspended" && fieldStr(ent as JsonMap, "status_reason") === "incapable") {
      process.stderr.write(`tap register: '${name}' is suspended (incapable); an offline registration would overwrite the mark — re-register from that seat's own pane\n`);
      fail(1, "usage_error", `tap in ${name} --list-history --json`, `'${name}' is suspended (incapable); re-register from that seat's own pane`);
    }
    (ent as JsonMap).set("status", "suspended");
    (ent as JsonMap).set("status_reason", "user_removed");
    (agents as JsonMap).set(name, ent as JsonMap);
    supersedeStaleForwardingAliases(doc, agents as JsonMap);
    mkdirSync(dirname(registryPath), { recursive: true });
    verbose("state_write", { path: registryPath }); // the incumbent's opt-in diagnostic, immediately before publication
    atomicWrite(registryPath, `${pyDumpIndent(doc, 0).replace(/\u007f/g, "\\u007f")}\n`);
    return { priorExisting };
  } finally {
    lock.release();
  }
  } // attempt loop
  return { priorExisting: false }; // unreachable
}

// --- poll arm (verbatim port of the poll write heredoc) ---------------------------

export interface PollOutcome { priorExisting: boolean; action: string }

export function registerPoll(
  registryPathIn: string, name: string, worktree: string, wakeUrl: string, unattended: boolean,
  replyTo: string, teamName: string, overrideWt: boolean, indexHome: string, busHome: string,
  restoreId: string, fresh: boolean, rebind: () => string, env: Env = process.env, fence?: PaneLock,
  requireLive = true, branch?: string,
): PollOutcome {
  const timeout = registerLockTimeoutMs(env);
  if ("invalid" in timeout) fail(2, "error", "set TAP_REGISTER_LOCK_TIMEOUT to a finite positive number", "invalid TAP_REGISTER_LOCK_TIMEOUT");
  let registryPath = registryPathIn;
  for (let attempt = 1; attempt <= 2; attempt++) {
  const sidecar = fence ?? acquireResetMutationLock(dirname(registryPath), "tap register", timeout.ms, "shared");
  if (!fence) fenceTestBarrier("holding-mutation-lock", env);
  try {
    const lock = acquireRegistrationRegistryLock(registryPath, timeout.ms);
    if (lock === null) fail(1, "registry_lock_busy", "tap register", "registry lock busy — retry once the write completes");
    try {
      const auth = validateLockedRegistryAuthority(registryPath, worktree, indexHome, { requireLive });
      if (!auth.ok) {
        if (auth.retry) {
          const next = attempt < 2 ? rebind() : "";
          if (next !== "") { registryPath = next; continue; }
          fail(1, "flip_in_progress", `tap in ${name} --delivery poll`, auth.detail);
        }
        fail(1, "invalid_flip", "tap doctor", auth.detail);
      }
      let isFile = false;
      try { isFile = statSync(registryPath).isFile(); } catch { isFile = false; }
      let reg: JsonMap = new Map<string, JsonValue>();
      if (isFile) {
        let parsed: JsonValue;
        try {
          parsed = loads(readFileSync(registryPath, "utf8"));
        } catch (e) {
          fail(1, "registry_invalid", "repair_registry", `registry '${registryPath}' is invalid JSON; refusing to overwrite it (${(e as Error).message})`);
        }
        if (!isMap(parsed)) fail(1, "registry_invalid", "repair_registry", `registry state doc is not an object: ${registryPath}`);
        reg = parsed;
      }
      if (branch !== undefined) ensureTeamFields(reg, worktree, branch);
      const agents = currentSeats(reg, registryPath, !isFile);
      let existing = (agents as JsonMap).get(name);
      if (!isMap(existing)) existing = new Map<string, JsonValue>();
      const priorExisting = (existing as JsonMap).size > 0;
      const wasSuspended = fieldStr(existing as JsonMap, "status") === "suspended";
      // The incapable mark is cleared only by re-registering from the marked
      // seat's own pane (the pane arm's gate); converting the row to poll
      // would write active/"" past it, so refuse before any write.
      if (wasSuspended && fieldStr(existing as JsonMap, "status_reason") === "incapable") {
        process.stderr.write(`tap register: '${name}' is suspended (incapable); the mark was made on pane ${fieldStr(existing as JsonMap, "pane") || "(none)"} (${fieldStr(existing as JsonMap, "pane_id") || "(none)"}) and cannot be cleared by a poll registration — re-register from that seat's own pane\n`);
        fail(1, "usage_error", `tap in ${name} --list-history --json`, `'${name}' is suspended (incapable); re-register from that seat's own pane`);
      }
      const live = flipMarkerState(indexHome) === "live";
      if (live) {
        if (priorExisting && (fresh || restoreId)) {
          fail(1, "usage_error", `tap in ${name} --list-history --json`, `tap register: refusing --${fresh ? "fresh" : "restore"} for current seat '${name}' (tap out first, or rebind without those flags)`);
        }
        if (restoreId) {
          const rows = listHandleHistory(busHome, name);
          if (!rows.some(r => r.get("instance") === restoreId)) {
            fail(1, "usage_error", `tap in ${name} --list-history --json`, `tap register: --restore '${restoreId}' is not a tombstone for '${name}'`);
          }
        }
      }
      const entry = new Map<string, JsonValue>(existing as JsonMap);
      entry.set("delivery", "poll");
      if (fieldStr(entry, "harness") === "") entry.set("harness", name);
      entry.set("registered_at", nowIso());
      entry.set("status", "active");
      entry.set("status_reason", "");
      if (overrideWt || fieldStr(entry, "registered_from_worktree") === "") entry.set("registered_from_worktree", worktree);
      for (const stale of ["pane", "pane_id", "pane_current_command", "cost_mode", "include_policy", "crew", "crew_owner", "crew_owner_instance", "crew_identity_capture", "exited_at"]) entry.delete(stale);
      if (wakeUrl !== "") entry.set("wake_url", wakeUrl); else entry.delete("wake_url");
      if (unattended) entry.set("unattended", true); else entry.delete("unattended");
      if (replyTo !== "") entry.set("reply_to", replyTo); else entry.delete("reply_to");
      if (live) {
        if (restoreId) entry.set("instance", restoreId);
        else {
          if (fresh || !priorExisting) entry.delete("instance");
          entry.set("instance", ensureSeatInstance(seatRecord(entry), name));
        }
      }
      (agents as JsonMap).set(name, entry);
      supersedeStaleForwardingAliases(reg, agents as JsonMap);
      atomicWrite(registryPath, `${pyDumpIndent(reg, 0).replace(/\u007f/g, "\\u007f")}\n`);
      return { priorExisting, action: wasSuspended ? "reactivated" : "registered" };
    } finally {
      lock.release();
    }
  } finally {
    if (!fence) sidecar.release();
  }
  } // attempt loop
  return { priorExisting: false, action: "registered" }; // unreachable
}

/** Fail-closed self-attestation: is this process inside the pane being registered?
 *  `knownPanePid`, when an already-observed record carries the pane pid, spares
 *  the targeted read; the ancestry walk still runs — attestation is the point. */
export function callerUnderPane(pane: string, env: Env, knownPanePid = ""): boolean {
  if (pane === "") return false;
  let pid = knownPanePid;
  if (pid === "") {
    const r = tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"], env);
    pid = (r.stdout ?? "").trim();
    if (r.code !== 0 || pid === "") return false;
  }
  return pidHasAncestor(process.pid, pid, env);
}

// --- main flow -------------------------------------------------------------------

interface BusRefs {
  busHome: string; registryPath: string; payloads: string; receipts: string;
  eventsLog: string; backups: string;
}

function deriveBus(worktree: string, env: Env): { home: string; rule: string } {
  const bus = resolveBus(worktree, {});
  return { home: realOrSelf(requireResolvedBus(bus)), rule: bus.rule };
}

/** The reply-to deliverability probe (seat_deliverable twin). */
type Deliverable = { ok: true } | { ok: false; code: number; errorClass: string; action: string; detail: string };

function seatDeliverable(target: string, ourTeam: string, ourHandle: string, ourRegistry: string, indexHome: string): Deliverable {
  let team = "", handle = target, registry = ourRegistry;
  const slash = target.indexOf("/");
  if (slash > 0) { team = target.slice(0, slash); handle = target.slice(slash + 1); }
  // tap-zvwgr: a seat cannot be its own reply target — that would store a
  // self-address as the durable redirect an unattended seat's replies are
  // meant to escape to, while replies still return to the same seat.
  if (handle === ourHandle && (team === "" || team === ourTeam)) {
    return { ok: false, code: 1, errorClass: "usage_error", action: "tap help register", detail: `reply target '${target}' cannot be this seat's own handle` };
  }
  if (team && team !== ourTeam) {
    const res = resolveTeamFromGlobal(globalRegistryPath(indexHome), team);
    if (res.status === "unreachable") return { ok: false, code: 1, errorClass: "registry_unreachable", action: "tap doctor", detail: `team '${team}' is enrolled but its registry is unreachable` };
    if (res.status !== "ok") return { ok: false, code: 1, errorClass: "unknown_team", action: "tap team", detail: `team '${team}' is not enrolled in the machine index` };
    registry = res.registryLocation;
  }
  if (!TAP_ID_RE.test(handle)) return { ok: false, code: 1, errorClass: "not_found", action: "tap help send", detail: `reply target '${target}' is not a deliverable seat` };
  let doc: JsonMap | null = null;
  try { doc = loads(readFileSync(registry, "utf8")) as JsonMap; } catch { doc = null; }
  if (doc !== null) {
    const refusal = teamRegistryRefusal(registry, doc);
    if (refusal) return { ok: false, code: 1, ...refusal };
  }
  const seats = isMap(doc) && isMap(doc.get("seats")) ? doc.get("seats") as JsonMap : null;
  const entry = seats && isMap(seats.get(handle)) ? seats.get(handle) as JsonMap : null;
  // tap-zvwgr: check forwarding BEFORE requiring a current row — a retired
  // handle with an active instance-pinned forwarding intentionally has no
  // row of its own. Bridge through a plain-object doc: forwardingRoute reads
  // `.seat_forwardings`/`.seats` by dot access, which a JsonMap never has.
  if (flipLive(indexHome) && doc) {
    try {
      const plainDoc = JSON.parse(dumps(doc, true)) as RegistryDoc;
      const route = forwardingRoute(plainDoc, handle, "");
      const routed = route.target;
      if (routed && routed !== handle) {
        const r2 = seats && isMap(seats.get(routed)) ? seats.get(routed) as JsonMap : null;
        if (!r2) return { ok: false, code: 1, errorClass: "not_found", action: "tap help send", detail: `reply target '${target}' forwards to '${routed}', which has no registration to deliver to` };
        return checkEntry(r2, `${team ? `${team}/` : ""}${routed}`);
      }
    } catch { /* an unusable route answers not-found below via the direct entry */ }
  }
  if (!entry) return { ok: false, code: 1, errorClass: "not_found", action: "tap help send", detail: `reply target '${target}' has no registration to deliver to` };
  return checkEntry(entry, target);

  function checkEntry(e: JsonMap, label: string): Deliverable {
    const status = fieldStr(e, "status");
    if (status === "suspended" || status === "user_removed") {
      return { ok: false, code: 1, errorClass: "seat_suspended", action: "tap register", detail: `reply target '${label}' is suspended (${fieldStr(e, "status_reason") || "user_removed"}) — it must re-register before it can receive replies` };
    }
    // tap-zvwgr: a launching (or otherwise non-active) row still carrying a
    // pane/poll delivery passes the check below but reply delivery refuses
    // it later — matching the existing send-time deliverability rule here
    // avoids a route-then-fail obligation with no usable reply destination.
    if (status !== undefined && status !== "" && status !== "active") {
      return { ok: false, code: 1, errorClass: "seat_suspended", action: "tap register", detail: `reply target '${label}' is not active (status '${status}', reason '${fieldStr(e, "status_reason") || "-"}')  — it cannot receive replies yet` };
    }
    if (fieldStr(e, "status_reason") === "launching") {
      return { ok: false, code: 1, errorClass: "seat_suspended", action: "tap register", detail: `reply target '${label}' is still launching — it cannot receive replies yet` };
    }
    const delivery = fieldStr(e, "delivery");
    const pane = fieldStr(e, "pane");
    if (delivery !== "poll" && pane === "") {
      return { ok: false, code: 1, errorClass: "not_found", action: "tap help send", detail: `reply target '${label}' has no delivery target` };
    }
    return { ok: true };
  }
}

/** Bridge a JsonMap entry into the `Seat` record shape ensureSeatInstance mutates. */
function seatRecord(entry: JsonMap): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  entry.forEach((v, k) => { rec[k] = v instanceof Map ? Object.fromEntries(v) : v; });
  return rec;
}

function seatRecordInstance(rec: Record<string, unknown>): string {
  const v = rec.instance;
  return typeof v === "string" ? v : "";
}

function flipLive(indexHome: string | undefined): boolean {
  return flipMarkerState(indexHome) === "live";
}

export function cmdRegister(argv: string[]): number {
  // The SessionStart hook sets TAP_SESSION_SOURCE on its `tap in`; only that
  // invocation is traced. The wrap opens one shared trace writer, so each phase
  // event is a stdin write, never a subprocess or a contended lock.
  if (!process.env.TAP_SESSION_SOURCE) return cmdRegisterRun(argv);
  return withStartupTrace((): number => {
    registerTraceBeginMs = performance.now();
    hookTrace("register_begin", {
      source: process.env.TAP_SESSION_SOURCE,
      harness_session_id: process.env.TAP_HARNESS_SESSION_ID ?? "",
      pane_id: process.env.TMUX_PANE ?? "",
    });
    try {
      const code = cmdRegisterRun(argv);
      hookTrace("register_end", { exit_code: code, duration_ms: Math.round(performance.now() - registerTraceBeginMs) });
      return code;
    } catch (error) {
      hookTrace("register_end", {
        exit_code: error instanceof TapError ? error.code : 1,
        duration_ms: Math.round(performance.now() - registerTraceBeginMs),
      });
      throw error;
    }
  }, { operation_id: randomUUID(), phase: "register" });
}

/**
 * The one in-process publication of the derived bus (indexability parity with
 * the incumbent's bootstrap read). childBusEnv's rule, in-process: the lock
 * root the process resolved BEFORE this publication names the bus stays the
 * root for every later lockRoot-derived lock, so a register whose caller had
 * no pin keeps excluding the unpinned world instead of splitting into
 * `<bus>/locks` (tap-b5qrj, the tap-a5j6t class without a spawn boundary).
 */
export function publishDerivedBus(busHome: string, env: NodeJS.ProcessEnv): void {
  if (!env.TAP_LOCK_DIR) env.TAP_LOCK_DIR = lockRoot(env);
  env.TAP_HOME = busHome;
}

function cmdRegisterRun(argv: string[]): number {
  const env = process.env;
  const sharedCaller = nativeOpenCodeCaller(env);
  if (sharedCaller.kind === "refused" && sharedCaller.reason === "process_unobservable") {
    fail(1, "caller_unobservable", "retry after process observation is available", "the calling process ancestry could not be observed");
  }
  if (sharedCaller.kind !== "none") {
    fail(1, "shared_registration", "tap session relaunch <handle>", "OpenCode shared service tools cannot register a pane; the launcher owns their session binding");
  }
  // The incumbent's _TAP_HOME_WAS_SET: whether TAP_HOME was inherited from the
  // caller's environment, sampled at entry — never an env contract.
  const tapHomeWasSet = "TAP_HOME" in env;
  // --json is known before parsing so refusals render on the JSON stream.
  const jsonMode = argv.includes("--json") || env.TAP_JSON === "1";
  if (jsonMode) process.env.TAP_JSON = "1";
  const form = parseRegisterForm(argv);
  form.json = jsonMode;

  if (form.digestIncludeAsks && form.digestWindow === "") {
    fail(1, "usage_error", "tap help register", "--include-asks requires --digest-window");
  }
  // The digest-window door-contract gate sits ABOVE the --list-history door:
  // a digest window belongs to a live pane registration, never a history read.
  if (form.digestWindow !== "" && form.listHistory) {
    fail(1, "usage_error", "tap help register", "--digest-window requires an active pane registration of the CALLER'S OWN pane (no --offline, --delivery poll, --list-history or explicit --pane)");
  }

  // Native --list-history door (register-forms main, moved).
  if (form.listHistory && form.name) {
    if (env.TAP_BUN_ROUTE_TRACE) {
      try { appendFileSync(env.TAP_BUN_ROUTE_TRACE, "native register --list-history\n"); } catch { /* tracing is advisory */ }
    }
    if (flipMarkerState(env.TAP_INDEX_HOME) === "invalid") {
      throw new TapError(1, "invalid_flip", "tap doctor", "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation", "tap register");
    }
    if (!flipLive(env.TAP_INDEX_HOME)) {
      process.stdout.write(jsonMode ? "[]\n" : "tap in: no history (pre-flip)\n");
      return 0;
    }
    let busHome = env.TAP_HOME ?? "";
    if (busHome === "") {
      try { busHome = resolveContext(process.cwd(), env).bus.home; } catch (error) { if (isOldStoreRefusal(error)) throw error; busHome = ""; }
      if (busHome === "") {
        const wt = gitToplevelFor(process.cwd(), env) ?? "";
        if (wt) { const cand = busHomeForRoot(wt); if (existsSync(cand)) busHome = cand; }
      }
    }
    const rows = listHandleHistory(busHome, form.name);
    if (jsonMode) {
      process.stdout.write(`${dumps(rows as unknown as JsonValue, false).replace(/\u007f/g, "\\u007f")}\n`);
    } else if (rows.length === 0) {
      process.stdout.write(`tap in: no history for '${form.name}'\n`);
    } else {
      process.stdout.write(`tap in: ${rows.length} historical instance(s) for '${form.name}':\n`);
      for (const row of rows) {
        process.stdout.write(`  instance=${str(row.get("instance"))}  retired_by=${str(row.get("retired_by"))}  last_active=${str(row.get("retired_at"))}\n`);
      }
      process.stdout.write(`next: tap in ${form.name} --restore <instance-id>   OR   tap in ${form.name} --fresh\n`);
    }
    return 0;
  }

  // An unusable marker fails closed before any derivation.
  if (flipMarkerState(env.TAP_INDEX_HOME) === "invalid") {
    fail(1, "invalid_flip", "tap doctor", "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
  }

  // Validation ladder (incumbent order: digest-window first).
  if (form.digestWindow !== "") {
    if (windowSeconds(form.digestWindow) === null) {
      fail(2, "usage_error", "tap help register", `--digest-window '${form.digestWindow}' is not a duration like 90s, 5m or 1h`);
    }
    if (form.offline || form.listHistory) {
      fail(1, "usage_error", "tap help register", "--digest-window requires an active pane registration of the CALLER'S OWN pane (no --offline, --delivery poll, --list-history or explicit --pane)");
    }
  }
  if (form.team !== "" && !TAP_ID_RE.test(form.team)) {
    fail(2, "usage_error", "tap help register", `--team '${form.team}' fails charset ${TAP_ID_RE}`);
  }
  if (form.delivery !== "" && form.delivery !== "poll" && form.delivery !== "pane") {
    fail(2, "usage_error", "tap help register", `--delivery '${form.delivery}' must be 'poll' or 'pane'`);
  }
  if (form.modeSet) {
    if (form.mode !== "subscription" && form.mode !== "api") {
      fail(1, "usage_error", "tap help register", "--mode must be 'subscription' or 'api'");
    }
  } else {
    form.mode = "subscription";
  }
  if (form.includeSet) {
    if (form.include !== "always" && form.include !== "on_request") {
      fail(1, "usage_error", "tap help register", "--include must be 'always' or 'on_request'");
    }
  } else {
    form.include = form.mode === "subscription" ? "always" : "on_request";
  }
  const delivery = form.delivery === "poll" ? "poll" : "pane";
  if (delivery === "poll" && !form.name) {
    fail(2, "usage_error", "tap help register", "usage: tap register <name> --delivery poll [--team <name>] [--wake-url <url>]  (a poll member has no tmux session to derive a handle from — pass one explicitly)");
  }
  if (form.offline && !form.name) {
    fail(2, "usage_error", "tap help register", "--offline names the seat to suspend — pass <name>");
  }
  if (form.listHistory && !form.name) {
    fail(1, "usage_error", "tap help register", "--list-history requires a handle");
  }
  if (form.name === "" && argv.some(a => !a.startsWith("--"))) {
    // unreachable: the parser consumed every positional; kept for parity
  }
  if (form.restoreId !== "" && !form.name) {
    fail(1, "usage_error", "tap help register", "--restore names the handle being restored — pass <name>");
  }
  if (form.digestWindow !== "" && delivery === "poll") {
    fail(1, "usage_error", "tap help register", "--digest-window requires an active pane registration (no --delivery poll)");
  }
  if (form.restoreId !== "" && form.fresh) {
    fail(1, "usage_error", `tap in ${form.name || "<name>"} --list-history --json`, "--restore and --fresh are mutually exclusive — one registration is either a tombstone restore or a fresh instance, never both");
  }
  if (form.crew && delivery !== "pane") {
    fail(1, "usage_error", "tap help register", "--crew requires a pane member and is incompatible with --delivery poll");
  }
  if (form.crew && form.offline) {
    fail(1, "usage_error", "tap help register", "--crew requires an active pane member and is incompatible with --offline");
  }
  if (delivery === "poll") {
    if (form.offline) fail(1, "usage_error", "tap help register", "--delivery poll is incompatible with --offline");
    if (form.pane !== "") fail(1, "usage_error", "tap help register", "--delivery poll is incompatible with --pane (a poll member has no pane)");
    if (form.modeSet) fail(1, "usage_error", "tap help register", "--mode requires a pane member (poll entries omit cost_mode)");
    if (form.includeSet) fail(1, "usage_error", "tap help register", "--include requires a pane member (poll entries omit include_policy)");
  } else {
    if (form.team !== "") fail(1, "usage_error", "tap help register", "--team requires --delivery poll");
    if (form.wakeUrl !== "") fail(1, "usage_error", "tap help register", "--wake-url requires --delivery poll");
  }
  // Caller-pane selection + THE ONE pane observation (verbatim incumbent
  // order): --pane omitted → the process-owning pane via pid/tty ancestry,
  // never tmux's untargeted "current pane" — an absent TMUX_PANE can mean an
  // attached client's active pane instead of this caller. Poll members have
  // no pane and no provenance to probe. The record is observed once here and
  // reused by the worktree ladder, the nameless resolve, and the pane
  // transaction.
  let paneFacts: PaneFacts | null = null;
  if (!form.offline && delivery !== "poll") {
    let callerIdentity: { paneId: string; session: string; serverEpoch: string } | null = null;
    if (form.pane === "") {
      // Extended mode: register's caller arm is the one consumer that opts
      // into the combined nine-field record — every other verb keeps the
      // incumbent's four-field probe shape.
      const chain = observeCallerPaneChain(env, process.cwd(), true);
      if (!chain.ok) {
        if (!form.json) {
          const name = TAP_ID_RE.test(form.name) ? form.name : "newcomer";
          process.stderr.write(`tap in: this command needs a tmux pane; next: tap launch claude ${name}\n`);
        }
        fail(1, "not_in_tmux", "tap session launch <preset|harness> [name]", `--pane required (caller pane is not observable: ${chain.reason}; pass --pane)`);
      }
      const callerPaneId = chain.paneId;
      callerIdentity = { paneId: chain.paneId, session: chain.session, serverEpoch: chain.serverEpoch };
      if (chain.selectedSocket) env.TAP_TMUX_SOCKET_PATH = chain.selectedSocket;
      if (chain.selectedHandle) env.TAP_CALLER_SELECTED_HANDLE = chain.selectedHandle;
      if (chain.selectedInstance) env.TAP_CALLER_SELECTED_INSTANCE = chain.selectedInstance;
      if (chain.viaJob) env.TAP_CALLER_SELECTED_JOB = "1";
      if (env.TAP_CALLER_SELECTED_JOB === "1") {
        // A background daemon selected its interactive owner pane through the
        // job record. Its own session/transcript describe the daemon, not that
        // pane, so an idempotent bare `tap in` must not rewrite the owner's
        // native identity (incumbent :174-181).
        env.TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE = "1";
      }
      // The chain's atomic caller record already carries the descriptive facts
      // (address, pane pid, current command/path, socket) from the SAME
      // observation as the identity; separate display-messages here could
      // straddle a pane death and describe a successor. The selected/job arm
      // has no such record (its identity came from a registry row), so it
      // keeps the separate probes.
      const identity = callerIdentity!;
      if (chain.address) {
        form.pane = chain.address;
        paneFacts = {
          paneId: identity.paneId,
          session: identity.session,
          epoch: identity.serverEpoch,
          panePid: chain.panePid ?? "",
          currentCommand: chain.currentCommand ?? "",
          currentPath: chain.currentPath ?? "",
          socket: chain.socketPath ?? "",
          address: chain.address ?? "",
        };
      } else {
        const addr = tmux(["display-message", "-p", "-t", callerPaneId, "#{session_name}:#{window_index}.#{pane_index}"], env);
        const address = addr.code === 0 ? addr.stdout.trim() : "";
        if (address === "") {
          fail(1, "pane_gone", "tap register --pane <tmux-target>", `caller pane '${callerPaneId}' does not exist`);
        }
        form.pane = address;
        const q = (format: string): string => {
          const rr = tmux(["display-message", "-p", "-t", identity.paneId, format], env);
          return (rr.stdout ?? "").split("\n")[0] ?? "";
        };
        paneFacts = {
          paneId: identity.paneId,
          session: identity.session,
          epoch: identity.serverEpoch,
          panePid: q("#{pane_pid}"),
          currentCommand: q("#{pane_current_command}"),
          currentPath: q("#{pane_current_path}"),
          socket: q("#{socket_path}"),
          address: address,
        };
      }
    } else {
      const obs = observePaneFacts(form.pane, env);
      if (obs.kind === "dead") {
        fail(1, "pane_dead", "tap register --pane <running-tmux-target>", `pane '${form.pane}' has exited; choose a running pane`);
      }
      if (obs.kind === "gone") {
        fail(1, "pane_gone", "tap register --pane <new-tmux-target>", `pane '${form.pane}' does not exist`);
      }
      if (obs.kind === "malformed") {
        fail(1, "identity_unverified", "verify tmux and retry the registry write", `tmux returned invalid pane_id '${obs.paneId}'; refusing registry write`);
      }
      paneFacts = obs.facts;
      // tap-fgx9: registry `pane` is always an address. A bare pane_id (%N) —
      // historically `tap crew add` — must not persist into the address field.
      if (/^%/.test(form.pane)) {
        const addr = tmux(["display-message", "-p", "-t", obs.facts.paneId, "#{session_name}:#{window_index}.#{pane_index}"], env);
        const address = addr.code === 0 ? addr.stdout.trim() : "";
        if (address === "") {
          fail(1, "pane_gone", "tap register --pane <new-tmux-target>", `could not resolve address for pane id '${obs.facts.paneId}'`);
        }
        form.pane = address;
      }
    }
  }
  // tap-zk1w: refuse an unstampable pane registration as soon as the pane is
  // observed, before the enrollment refusal (which may purge) and the born-live
  // or post-flip bootstraps (which write the index) can change any state.
  if (delivery === "pane" && paneFacts !== null && paneFacts.epoch === "") refuseUnobservableGeneration(form.pane);

  // --digest-window binds to the CALLER'S OWN live pane: an explicit --pane is
  // honored only when it resolves to the same pane this process owns.
  if (form.digestWindow !== "" && form.pane !== "" && paneFacts) {
    const selfObs = observeCallingPane(env);
    if (!(selfObs.state === "inside" && selfObs.paneId === paneFacts.paneId)) {
      fail(1, "usage_error", "tap help register", "--digest-window requires an active pane registration of the CALLER'S OWN pane — an explicit --pane naming another pane is refused");
    }
  }

  // Worktree derivation (verbatim incumbent ladder; cwd participates only where
  // the incumbent let it — the team's own bound root wins, tap-68lp).
  let worktree = "", worktreeIsGit = false;
  const indexHome = env.TAP_INDEX_HOME ?? join(env.HOME ?? "", ".tap");
  if (delivery === "poll" && form.team !== "") {
    // Explicit teams resolve only from the current machine index.
    const res = flipMarkerState(indexHome) === "absent"
      ? { status: "missing" as const, root: "" }
      : resolveTeamFromGlobal(globalRegistryPath(indexHome), form.team);
    if (res.status === "invalid") {
      fail(1, "invalid_flip", "tap doctor", res.detail || "machine index is present but unusable");
    }
    const root = res.status === "ok" || res.status === "unreachable" ? res.root : "";
    if (root === "") {
      fail(1, "not_found", "tap register", `--team '${form.team}' is not enrolled in the machine index (~/.tap/teams.json) — register a member in that worktree first, or omit --team and run this from inside it`);
    }
    worktree = root; worktreeIsGit = true;
  } else {
    let teamRoot = "";
    {
      // tap_team_bound_root twin: rebind-select the acting registry, then read
      // doc.team.worktree_root off it. The incumbent's resolver rebinds through
      // an authority sample that PARSES the acting store, so an unreadable
      // registry answers rc 1 (fresh/unreadable shape) and falls through to the
      // pane/cwd fallbacks below — the mutation gates then refuse with their
      // own doors (invalid JSON, authority moved). Only a registry that parses
      // but names no bound worktree yields the empty rc-0 answer.
      let actingNow = "";
      try {
        actingNow = resolveContext(process.cwd(), env).registryPath;
      } catch {
        actingNow = "";
      }
      if (actingNow !== "" && existsSync(actingNow)) {
        let doc: JsonValue | null = null;
        try {
          const parsed = loads(readFileSync(actingNow, "utf8"));
          if (isMap(parsed)) doc = parsed;
        } catch {
          doc = null;
        }
        if (doc !== null) {
          const t = doc.get("team");
          if (isMap(t)) {
            const root = t.get("worktree_root");
            if (typeof root === "string") teamRoot = root;
          }
        }
      }
    }
    if (teamRoot !== "") {
      if (!existsSync(teamRoot) || !statSync(teamRoot).isDirectory()) {
        fail(1, "team_root_missing", "restore '" + teamRoot + "', or run 'tap init' in the new location to instantiate a team there and pass context over TAP", `this bus's team is bound to '${teamRoot}', which no longer exists. A team is bound to the worktree it was instantiated in; TAP has no relocate verb yet (tap-68lp), so a moved worktree is restored or re-instantiated, never silently re-derived from your cwd`);
      }
      worktree = teamRoot; worktreeIsGit = true;
    } else {
      const panePath = paneFacts?.currentPath ?? "";
      const callerGit = gitToplevelFor(process.cwd(), env);
      const paneGit = panePath !== "" ? gitToplevelFor(panePath, env) : null;
      if (!form.offline && panePath !== "" && paneGit) { worktree = paneGit; worktreeIsGit = true; }
      else if (callerGit) { worktree = callerGit; worktreeIsGit = true; }
      else if (delivery === "poll") {
        fail(1, "not_found", "tap register --team <name>", "--delivery poll needs a bus anchor — pass --team <name> (a daemon's cwd is never a bus anchor), or run this from inside the team's git worktree");
      } else if (!form.offline && panePath !== "") { worktree = panePath; }
      else { worktree = process.cwd(); }
    }
  }
  worktree = realOrSelf(worktree);
  // A fresh root takes the same name init would give it (enrolled names win below).
  const derived = teamNameForRoot(worktree);
  let team = derived.ok ? derived.team : basename(worktree);
  const branch = gitOut(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree) ?? "unknown";

  // --team / explicit-env-TAP_HOME conflict guard (codex P1, reviewer ruling).
  if (form.team !== "" && tapHomeWasSet) {
    const dotdir = join(worktree, ".tap", "bus");
    const homePhysical = realOrSelf(env.TAP_HOME ?? "");
    if (homePhysical !== realOrSelf(dotdir)) {
      fail(1, "team_home_conflict", "unset TAP_HOME or drop --team (they disagree)", `TAP_HOME='${env.TAP_HOME}' does not match the bus --team '${form.team}' resolves to (${dotdir})`);
    }
  }

  // Bus derivation: an explicit TAP_HOME wins; otherwise the worktree's own bus.
  let bus: BusRefs;
  if (tapHomeWasSet && env.TAP_HOME) {
    const home = realOrSelf(env.TAP_HOME);
    bus = { busHome: home, registryPath: env.TAP_REGISTRY ?? join(home, "registry.json"), payloads: join(home, "payloads"), receipts: join(home, "receipts"), eventsLog: join(home, "registry-events.log"), backups: join(home, "input-backups") };
  } else {
    const d = deriveBus(worktree, env);
    bus = { busHome: d.home, registryPath: join(d.home, "registry.json"), payloads: join(d.home, "payloads"), receipts: join(d.home, "receipts"), eventsLog: join(d.home, "registry-events.log"), backups: join(d.home, "input-backups") };
  }

  // Enrollment eligibility is a precondition, not a post-write check.
  if (worktreeIsGit) {
    const pre = enrollPreflight(worktree, env);
    if (!pre.ok) fail(1, "enroll_preflight_failed", "tap help register", pre.detail);
  }
  // The incumbent's bootstrap read the derived TAP_HOME shell variable
  // in-process; the Bun rootIndexable reads the env. Publish the derived bus
  // so indexability is judged on the same bus the register binds. The
  // CALLER's spelling decides custom-home status, so capture it first.
  publishDerivedBus(bus.busHome, env);
  // Judged on the published bus, before any seat write: a skipped enrollment
  // after the commit is a race only if the root qualified here (tap-hpp4h).
  const enrollExpected = worktreeIsGit && rootIndexable(worktree, env);

  // Refuse foreign ownership before bootstrap, team-block or adoption writes.
  // SessionStart's native tap in uses this same door. The socket rides the
  // atomic caller/pane record when it carried one; the unrecorded paths keep
  // the targeted read.
  if (!form.offline && delivery !== "poll" && paneFacts) {
    let socketPath = paneFacts.socket;
    if (socketPath === "") {
      const socket = tmux(["display-message", "-p", "#{socket_path}"], env);
      socketPath = socket.code === 0 ? socket.stdout.split("\n", 1)[0] ?? "" : "";
    }
    const refusal = paneEnrollmentRefusal({ paneId: paneFacts.paneId, epoch: paneFacts.epoch,
      socket: socketPath }, worktree, indexHome);
    if (refusal) fail(1, refusal.errorClass, refusal.action, refusal.errorClass + ": " + refusal.detail);
  }

  // Only a pristine absent-marker machine may bootstrap. Existing stores
  // are refusal evidence, never input to a registration-time migration.
  if (flipMarkerState(indexHome) === "absent") {
    const evidence = oldStoreEvidence(indexHome, bus.busHome, teamRegistryPath(worktree), env);
    if (evidence.length > 0) fail(1, "old_store", oldStoreAction(evidence[0]!.kind), oldStoreRefusalText(evidence[0]!.path, evidence[0]!.kind));
  }
  const bl = bornLiveBootstrap(worktree, env);
  if (bl.status === "refusal") {
    if (bl.refusal.kind === "old_store" && bl.refusal.path && bl.refusal.store) {
      fail(1, "old_store", oldStoreAction(bl.refusal.store), oldStoreRefusalText(bl.refusal.path, bl.refusal.store));
    }
    if (bl.refusal.kind === "unenrolled_seats" && bl.refusal.path) {
      const u = unenrolledSeatsRefusal(bl.refusal.path, worktree, "tap register");
      fail(1, u.errorClass, u.action, u.detail);
    }
    const path = "path" in bl.refusal && bl.refusal.path ? ` (${bl.refusal.path})` : "";
    fail(1, "born_live_unavailable", "tap doctor", `the machine index could not be classified or initialised${path}, so this seat cannot be registered without guessing its registry polarity — fix the reported path, then retry`);
  }
  // not_indexable mirrors Bash's exit-3 fallthrough (tap_index_born_live_bootstrap)
  // ONLY when there is an established pre-flip world to keep — an existing bus
  // registry at this TAP_HOME. A not-indexable root with NO prior registry is
  // an unclassified custom bus with nothing to preserve, and bootstrapping
  // fresh state into it is exactly the decoy-bus write this refusal guards
  // against; it stays a hard refusal, unwritten.
  if (bl.status === "not_indexable") {
    if (!existsSync(bus.registryPath)) {
      fail(1, "born_live_unavailable", "tap doctor", "registration requires a current enrolled registry or a pristine canonical git worktree; refusing a pre-flip custom bus");
    }
    // Kept pre-flip world: this bus registry is authoritative for the acting
    // team name, not the worktree basename — the machine index is not the one
    // naming this seat's team.
    try {
      const doc = loads(readFileSync(bus.registryPath, "utf8"));
      const teamBlock = isMap(doc) ? doc.get("team") : null;
      const declared = isMap(teamBlock) ? teamBlock.get("name") : null;
      if (typeof declared === "string" && declared !== "") team = declared;
    } catch {
      // Malformed registry surfaces through the normal read path below; keep
      // the basename(worktree) default here rather than failing early on it.
    }
  }
  if (bl.status === "live") {
    const indexSnapshot = loadGlobalRegistry(indexHome);
    if (indexSnapshot.marker !== "live") fail(1, "invalid_flip", "tap doctor", "machine index changed before registry selection");
    const enrolled = enrolledNameForRootFromDoc(indexSnapshot.doc ?? {}, worktree);
    if (enrolled.status === "ambiguous" || enrolled.status === "unreachable") {
      fail(1, "registry_unreachable", "tap doctor", `acting registry for '${worktree}' is ${enrolled.status}; refusing empty bootstrap wipe`);
    }
    if (enrolled.status === "ok") team = enrolled.name;
  }

  // Acting-registry rebind BEFORE the nameless resolve (tap-vpwp). Post-flip only.
  const rebindTeam = form.team !== "" ? form.team : (flipLive(indexHome) ? team : "");
  let acting = actingRegistryForTeamOverride(rebindTeam, bus.busHome, indexHome);
  // Bound-root fail-closed half (tap-moa6x): an unreadable registry at the
  // bound root refuses BEFORE any acting store is created or the team is
  // enrolled — a poll write never reads the root's own store, so this is the
  // one door that can still fail closed on it.
  {
    const rootBusRegistry = join(bus.busHome, "registry.json");
    if (delivery === "poll" && existsSync(rootBusRegistry) && realOrSelf(acting) !== realOrSelf(rootBusRegistry)) {
      try {
        loads(readFileSync(rootBusRegistry, "utf8"));
      } catch (e) {
        fail(1, "slice_failed", "tap register", `bound-root resolver failed: registry '${rootBusRegistry}' is invalid JSON (${(e as Error).message})`);
      }
    }
  }
  // Re-resolve the acting registry; returns the new path ("" on failure) and
  // leaves `acting` pointing at it. Every rc17 retry ladder consumes this.
  const rebind = (): string => {
    acting = actingRegistryForTeamOverride(rebindTeam, bus.busHome, indexHome);
    return acting !== "" && existsSync(dirname(acting)) ? acting : "";
  };
  if (rebind() === "") {
    if (flipLive(indexHome) && worktreeIsGit && rootIndexable(worktree, env)) {
      const bsTeam = rebindTeam !== "" ? rebindTeam : team;
      const st = resolveTeamFromGlobal(globalRegistryPath(indexHome), bsTeam).status;
      if (st === "unreachable") fail(1, "registry_unreachable", "tap doctor", "post-flip acting registry enrolled but location missing — refusing empty bootstrap wipe");
      if (st === "ok" || st === "historical") fail(1, "registry_unreachable", "tap doctor", `post-flip team already enrolled (status=${st}) but acting rebind failed — refusing empty bootstrap wipe`);
      const boot = bootstrapPostflipEnroll(worktree, env);
      if (!boot.ok) fail(1, "registry_unreachable", "tap doctor", `post-flip enroll failed — cannot bootstrap team-registry for '${worktree}' (${boot.detail})`);
      if (rebind() === "") fail(1, "registry_unreachable", "tap doctor", "acting registry unreachable after post-flip enroll — refusing bus decoy");
    } else {
      fail(1, "registry_unreachable", "tap doctor", "acting registry unreachable — refusing to register against a bus decoy");
    }
  }

  const actingRefusal = teamRegistryFileRefusal(acting);
  if (actingRefusal) fail(1, actingRefusal.errorClass, actingRefusal.action, actingRefusal.detail);

  // Nameless resolve → derive → reserved (verbatim incumbent stage order).
  // Name derivation uses the captured discovery record.
  let name = form.name;
  let derivedNote = "";
  if (name === "" && env.TAP_CALLER_SELECTED_HANDLE) {
    name = env.TAP_CALLER_SELECTED_HANDLE;
  }
  if (name === "" && delivery === "pane" && form.pane !== "") {
    const facts = paneFacts;
    if (!facts) fail(1, "identity_unverified", "verify tmux and retry the registry write", `pane '${form.pane}' could not be observed; refusing to guess a handle for it`);
    const epoch = facts.epoch;
    if (epoch === "") {
      refuseUnobservableGeneration(form.pane);
    }
    const self = resolveHandleByPane(acting, facts.paneId, form.pane, epoch);
    if (self && self.handle) {
      name = self.handle;
    } else {
      const session = facts.session;
      if (session === "") {
        fail(1, "pane_gone", "tap register --pane <tmux-target>", `pane '${form.pane}' does not exist`);
      }
      // tap-2al3d: a session name that yields no handle (a bare numeric `tmux`
      // session, an unusable remainder) falls back to the pane's positively
      // observed harness family. Observed-only: the crew expected-harness
      // override never feeds derivation; a shell or unsupported pane command
      // keeps the fail-closed refusal.
      const families = agentFamilies(env);
      let derived = deriveHandle(session, team);
      let derivedFromHarness = false;
      if (derived === "") {
        const fallback = harnessFallbackHandle(paneHarnessCommand(form.pane, facts.currentCommand, families, env, facts.panePid), families);
        if (fallback !== "") {
          derived = fallback;
          derivedFromHarness = true;
        }
      }
      if (derived === "") {
        fail(2, "usage_error", "tap help register", "usage: tap register [<name>] [--pane <tmux-target>] [--mode subscription|api] [--include always|on_request] [--offline] [--force]  (could not derive a handle from the tmux session name; pass one explicitly)");
      }
      name = derived;
      derivedNote = derivedFromHarness
        ? `tap register: derived handle '${name}' from the observed pane harness (team '${team}', session '${session}')`
        : `tap register: derived handle '${name}' (team '${team}', session '${session}')`;
    }
  }
  if (name !== "" && !TAP_ID_RE.test(name)) {
    fail(2, "usage_error", "tap help register", `handle '${name}' fails charset ${TAP_ID_RE}`);
  }
  const reservedWhy = (): string | null => {
    if (name === (env.TAP_WATCH_IDENTITY ?? WATCH_IDENTITY_DEFAULT)) return "the reserved watcher identity";
    for (const reserved of (env.TAP_RESERVED_HANDLES ?? RESERVED_DEFAULT).split(/\s+/)) {
      if (name === reserved) return "the CLI help keyword (so 'tap <verb> help' is unambiguous for every verb)";
    }
    return null;
  };
  const why = name === "" ? null : reservedWhy();
  if (why !== null) {
    if (derivedNote !== "") {
      fail(1, "reserved_handle", `tap register <another-handle> --pane ${form.pane}`, `derived handle '${name}' is ${why} and cannot be a seat handle — the tmux session name produced it, so pass an explicit handle`);
    }
    fail(1, "reserved_handle", "tap register <another-handle>", `'${name}' is ${why} and cannot be a seat handle`);
  }
  if (name === COURIER_IDENTITY) {
    fail(1, "reserved_handle", "tap register <another-handle>", "'courier' is the reserved courier digest-envelope identity and cannot be a seat handle");
  }
  if (name === USER_IDENTITY) {
    fail(1, "reserved_handle", "tap register <another-handle>", `'${USER_IDENTITY}' is the reserved operator identity (a person nudging from a terminal that is not a seat) and cannot be a seat handle`);
  }

  // Reset fence, then the team block (fresh-bus team-block creation comes
  // BEFORE reply-to validation, with the 2-attempt rc17 rebind).
  const lockTimeout = registerLockTimeoutMs(env);
  if ("invalid" in lockTimeout) {
    fail(2, "error", "set TAP_REGISTER_LOCK_TIMEOUT to a finite positive number", "invalid TAP_REGISTER_LOCK_TIMEOUT");
  }
  // Incumbent fence protocol (sol 063932): guard, pause for the scratch-only
  // after-entry barrier, re-guard (a fence may have arrived during the pause),
  // pause again before any durable write, then take the sidecar lock whose
  // holder emits the holding-mutation-lock barrier.
  assertResetUnfenced(bus.busHome, "tap register");
  // Independent discovery must not hold reset custody. Registry-dependent
  // collision decisions still observe the registry after its lock wait.
  const prepared = !form.offline && delivery !== "poll"
    ? preparePaneRegistration({ form, worktree, env, paneFacts }) : null;
  fenceTestBarrier("after-entry-guard", env);
  assertResetUnfenced(bus.busHome, "tap register");
  fenceTestBarrier("pre-mutation", env);
  hookTrace("register_prelock_done", {
    ms_since_begin: Math.round(performance.now() - registerTraceBeginMs),
    pane_id: paneFacts?.paneId ?? "",
    handle: name || "",
  });
  // Shared admission excludes structural cuts; the registry ledger serializes
  // bind writers. Neither admission nor ledger is held across launch.
  const fenceWaitMs = performance.now();
  let fence: ReturnType<typeof acquireResetMutationLock>;
  try {
    fence = acquireResetMutationLock(bus.busHome, "tap register", lockTimeout.ms, "shared");
  } catch (error) {
    // The refused wait is the row contention analysis wants first.
    hookTrace("register_lock_acquired", {
      lock: "reset_fence", acquired: false, wait_ms: Math.round(performance.now() - fenceWaitMs),
      pane_id: paneFacts?.paneId ?? "", handle: name || "",
    });
    throw error;
  }
  hookTrace("register_lock_acquired", {
    lock: "reset_fence", acquired: true, wait_ms: Math.round(performance.now() - fenceWaitMs),
    pane_id: paneFacts?.paneId ?? "", handle: name || "",
  });
  fenceTestBarrier("holding-mutation-lock", env);
  try {
    // CONTINUOUS custody from here through the write: a release before the
    // dispatch arms would open a window where a reset blocked on the sidecar
    // wins it and fences the write mid-registration (fence-barrier (2)).
    const ensured = ensureTeamBlock(acting, worktree, branch, indexHome, lockTimeout.ms, rebind, bl.status === "live");
    if (!ensured.ok) {
      if (ensured.code === 75) fail(1, "registry_lock_busy", "tap register", `${ensured.detail || "registry lock busy"} — retry once the write completes`);
      if (ensured.code === 17) fail(1, "flip_in_progress", "tap register", ensured.detail || "registry authority moved during flip — retry");
      if (ensured.code === 4) fail(1, "invalid_flip", "tap doctor", ensured.detail || "registry flip marker invalid — refusing membership mutation");
      if (ensured.code === 2) fail(2, "error", "set TAP_REGISTER_LOCK_TIMEOUT to a finite positive number", ensured.detail || "invalid TAP_REGISTER_LOCK_TIMEOUT");
      fail(1, "registry_invalid", "repair_registry", ensured.detail || "registry team bootstrap failed");
    }
    if (ensured.ok && ensured.path !== bus.registryPath) bus.registryPath = ensured.path;
    acting = bus.registryPath;

  // Reply-to: resolve and prove deliverability AFTER the team block.
  if (form.replyTo !== "") {
    const d = seatDeliverable(form.replyTo, team, name, acting, indexHome);
    if (!d.ok) fail(d.code, d.errorClass, d.action, d.detail);
  }

  // Digest-window knob (parsed above, applied in the briefing).
  let digestWindow: number | null = null;
  if (form.digestWindow !== "") digestWindow = windowSeconds(form.digestWindow);

  // Offline arm: mark suspended without tmux. registerOffline owns the whole
  // lock + authority + 2-attempt rebind loop (the incumbent's slice contract).
  if (form.offline) {
    const out = registerOffline(acting, name, worktree, indexHome, rebind, env, fence, bl.status === "live", branch);
    const priorExisting = out.priorExisting;
    if (!jsonMode) process.stdout.write(`tap register: marked ${name} offline (suspended/user_removed)\n`);
    appendRegistryEventOrWarn("tap register", { actor: name, action: "offline", handle: name, pane: "", team, detail: "", log: env.TAP_REGISTRY_EVENTS ?? join(bus.busHome, "registry-events.log"), env });
    markResetGenerationReused(bus.busHome, "register");
    fence.release();
    emitBriefing({ name, delivery: "offline", target: "offline", action: "offline", priorExisting, note: "", team, worktree, bus, form, indexHome, acting });
    return 0;
  }

  // Worktree-path guard: refuse cross-worktree registration unless overridden.
  const panePath = paneFacts?.currentPath ?? "";
  if (panePath !== "") {
    const paneCheck = realOrSelf(panePath);
    if (paneCheck !== worktree && !paneCheck.startsWith(worktree + "/")
      && !launchPlacedInWorktree(acting, worktree, paneFacts?.paneId ?? "", paneFacts?.epoch ?? "", panePath, env)) {
      if (form.overrideWorktree) {
        process.stderr.write(`tap register: warning: pane '${form.pane}' is in '${panePath}' (outside worktree '${worktree}') — override active\n`);
      } else {
        fail(1, "usage_error", "tap register --override-worktree", `pane '${form.pane}' current path '${panePath}' is outside worktree '${worktree}'. Pass --override-worktree to register cross-worktree.`);
      }
    }
  }

  // Poll-mode write: explicit handle, no pane, no collision ladder.
  if (delivery === "poll") {
    const out = registerPoll(acting, name, worktree, form.wakeUrl, form.unattended, form.replyTo, team, form.overrideWorktree, indexHome, bus.busHome, form.restoreId, form.fresh, rebind, env, fence, bl.status === "live", branch);
    appendRegistryEventOrWarn("tap register", { actor: name, action: out.action, handle: name, pane: "poll", team, detail: "", log: env.TAP_REGISTRY_EVENTS ?? join(bus.busHome, "registry-events.log"), env });
    markResetGenerationReused(bus.busHome, "register");
    fence.release();
    fenceTestBarrier("after-mutation", { ...env, TAP_RESET_FENCE_TEST_BARRIER: env.TAP_REGISTER_POST_COMMIT_TEST_BARRIER });
    if (worktreeIsGit) enrollAfterCommit(worktree, acting, name, team, { form, enrollExpected });
    if (!jsonMode) process.stdout.write(`tap register: ${out.action} ${name} on team ${team}\n`);
    emitBriefing({ name, delivery: "poll", target: "poll-mode", action: out.action, priorExisting: out.priorExisting, note: "", team, worktree, bus, form, indexHome, acting });
    emitPrimer(name, out.priorExisting, form);
    emitVersionBriefing(name, team, worktree, form, env);
    return 0;
  }

  // Pane transaction (checkpoint-C native chooser).
  const paneRc = paneTransaction({ form, name, derivedNote, team, worktree, branch, acting, bus, indexHome, env, worktreeIsGit, enrollExpected, paneFacts, prepared: prepared!, clearMismatch: "", jsonMode, fence, requireLive: bl.status === "live" });
  return paneRc;
  } finally {
    fence.release();
  }
}

/** tap-5jc6 companion: find another machine row/record already carrying this
 *  harness id. Scans the acting registry, legacy teams.json bus stores, and
 *  post-flip registry_location entries; returns "<team>/<name>" or "". */
// --- pane observation --------------------------------------------------------------

interface PaneFacts { paneId: string; session: string; epoch: string; panePid: string; currentCommand: string; currentPath: string; socket: string; address?: string }

type PaneObservation =
  | { kind: "gone" }
  | { kind: "dead" }
  | { kind: "malformed"; paneId: string }
  | { kind: "ok"; facts: PaneFacts };

/** tap_pane_observe (the ONE identity record: ids + session + server epoch in
 *  a single guarded display-message) plus the separate descriptive probes the
 *  incumbent runs beside it (pane_current_command, pane_current_path). Death
 *  is an EMPTY pane_id expansion, never a swallowed rc (tmux 3.6a exits 0 for
 *  gone targets); a non-empty answer that is not one complete live record is a
 *  broken observation channel, never an identity. */
function observePaneFacts(target: string, env: Env): PaneObservation {
  const r = observePaneResult(target, env);
  if (r.status === "rate_limited" || r.status === "unobservable") {
    return { kind: "malformed", paneId: "" };
  }
  if (r.status === "pane_dead") return { kind: "dead" };
  if (r.status !== "ok" || !r.observation || r.observation.paneId === "") return { kind: "gone" };
  return {
    kind: "ok",
    facts: {
      paneId: r.observation.paneId,
      session: r.observation.session,
      epoch: r.observation.serverEpoch,
      panePid: r.observation.panePid,
      currentCommand: r.observation.currentCommand,
      currentPath: paneCurrentPath(target),
      // The shared pane record stays the incumbent's five-field shape; the
      // socket arrives register-locally (prepare's own read) for this arm.
      socket: "",
    },
  };
}

// --- pane transaction (the incumbent heredoc's semantic map, native chooser) -------

interface TxnCtx {
  form: RegisterForm; name: string; derivedNote: string; team: string; worktree: string;
  branch: string; acting: string; bus: BusRefs; indexHome: string; env: Env; worktreeIsGit: boolean; enrollExpected: boolean;
  paneFacts: PaneFacts | null; clearMismatch: string; jsonMode: boolean; fence: PaneLock;
  prepared: ReturnType<typeof preparePaneRegistration>;
  requireLive?: boolean;
}

// Current invocation identity outranks pane-native env, then inherited generic
// env. Key on the observed pane harness, never the crew bootstrap override.
function directSessionIdentity(form: RegisterForm, paneHarness: string, env: Env): string {
  const key: Record<string, string> = { claude: "CLAUDE_CODE_SESSION_ID", codex: "CODEX_THREAD_ID",
    cursor: "CURSOR_CONVERSATION_ID", opencode: "OPENCODE_SESSION_ID", agy: "ANTIGRAVITY_CONVERSATION_ID" };
  return form.harnessSessionId || env[key[paneHarness] ?? ""] || env.TAP_HARNESS_SESSION_ID || "";
}

/** tap-zk1w: a pane row must carry the generation observed with its ids. */
function refuseUnobservableGeneration(pane: string): never {
  return fail(1, "generation_unverifiable", "wait for tmux to answer, then retry",
    `the tmux server generation for pane '${pane}' is not observable, so its registration could not be stamped; nothing was written`);
}

function preparePaneRegistration(ctx: { form: RegisterForm; worktree: string; env: Env; paneFacts: PaneFacts | null }) {
  const { form, worktree, env } = ctx;
  const suppressCapture = env.TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE === "1" || env.TAP_CALLER_SELECTED_JOB === "1";
  // The namespace is the LIVE socket the server itself names (the incumbent's
  // tap_server_socket_now → TAP_REGISTER_SERVER_SOCKET), not the $TMUX client
  // hint: `-L` private servers and socket swaps must be caught as crossings.
  // The atomic pane record carries the server's own socket_path; only a record
  // without one takes the targeted read.
  let observedSocket = "";
  if (ctx.paneFacts?.socket) {
    observedSocket = ctx.paneFacts.socket;
  } else {
    const liveSocket = tmux(["display-message", "-p", "#{socket_path}"], env);
    // First line only, never trimmed: the record keeps the socket exactly as
    // tmux printed it, and the post-lock recheck compares the same form.
    observedSocket = liveSocket.code === 0 ? liveSocket.stdout.split("\n", 1)[0] ?? "" : "";
  }
  // Discovery keeps its captured identity; the transaction revalidates it.
  const observed = ctx.paneFacts;
  if (observed === null) {
    fail(1, "pane_gone", "tap register", `pane '${form.pane}' is gone or unobservable — list panes with 'tap team' and register a live one`);
  }
  // tap-zk1w: a pane-backed row must carry the generation observed in the same
  // record as its ids. An unstamped row binds its pane id to no server
  // lifetime, and the resolver no longer lets one confer identity, so writing
  // it would register a seat that cannot name itself. Refuse before any lock
  // or write; the generation is usually back on the next tmux answer.
  if (observed!.epoch === "") refuseUnobservableGeneration(form.pane);
  // The record's epoch drives the verdict + identity comparisons.
  const epochNow = observed!.epoch;
  const panePid = observed!.panePid;

  // Harness family: shallow classify first, process-table fallback, fail-closed
  // (tap_pane_harness_command twin). An unsupported shallow command always gets
  // the process observation; the family falls back only when it finds nothing.
  // The pane pid rides the atomic pane record; only a record without one takes
  // the targeted read inside the fallback.
  const families = agentFamilies(env);
  const paneHarness = paneHarnessCommand(form.pane, observed!.currentCommand, families, env, observed!.panePid);
  // The crew-only bootstrap override REPLACES the harness the launcher named,
  // after validating itself — the pane command never overrides it.
  let harness = paneHarness;
  if (env.TAP_REGISTER_EXPECTED_HARNESS) {
    if (!form.crew) {
      fail(1, "usage_error", "retry without the internal override", "expected-harness bootstrap override is crew-only");
    }
    if (!families.includes(env.TAP_REGISTER_EXPECTED_HARNESS)) {
      fail(1, "usage_error", "retry the owning launcher", `internal expected harness '${env.TAP_REGISTER_EXPECTED_HARNESS}' is not supported`);
    }
    harness = env.TAP_REGISTER_EXPECTED_HARNESS;
  }

  const directSessionId = suppressCapture ? "" : directSessionIdentity(form, paneHarness, env);
  let attribution: Attribution | null = null;
  if (suppressCapture) {
    attribution = { harness: paneHarness, store_path: "", store_kind: "", harness_session_id: "", trust: "none", candidates: 0, detail: "", derived_at: "" };
  } else if (paneHarness !== "") {
    const captureCwd = env.TAP_REGISTER_CREW_CAPTURE_ONLY === "1" ? observed!.currentPath : worktree;
    try { attribution = sessionDerive(paneHarness, captureCwd, { env: { ...env, TAP_HARNESS_SESSION_ID: directSessionId }, panePid }); } catch { attribution = null; }
  }
  return { suppressCapture, observedSocket, observed, epochNow, paneHarness, harness, attribution, directSessionId, observedBootId: bootId(env) };
}

function paneTransaction(ctx: TxnCtx): number {
  const { form, name, team, worktree, branch, acting, bus, indexHome, env } = ctx;
  const nameDerived = ctx.derivedNote !== "";
  const { suppressCapture, observedSocket, observed, epochNow, paneHarness, harness, attribution, directSessionId, observedBootId } = ctx.prepared;
  const base = name;
  let chosen = base, suffixReason = "";
  let entry: JsonMap | null = null;
  const priorExisting = false;
  let wasSuspended = false;
  let harnessSessionId = "";
  let oldHarnessSessionId = "";
  let priorExistingChosen = false;
  let matchUpdate = false;
  let quarantineWarning = "";
  let matchDetail = "";

  // Authoritative locked transaction: reset fence first, then the registry
  // lock. Every read/choose/mutate decision happens INSIDE — a concurrent
  // writer's commit is reloaded before the ladder sees any row — and the
  // publish is the last act before the fence exits.
  const lockTimeout = registerLockTimeoutMs(env);
  if ("invalid" in lockTimeout) {
    fail(2, "error", "set TAP_REGISTER_LOCK_TIMEOUT to a finite positive number", "invalid TAP_REGISTER_LOCK_TIMEOUT");
  }
  // Fence custody is held continuously by cmdRegister and passed in; the pane
  // transaction's publish is the last act before that custody exits.
  const fence = ctx.fence;
  const paneLockMs = performance.now();
  const lock = acquireRegistrationRegistryLock(acting, lockTimeout.ms);
  hookTrace("register_lock_acquired", {
    lock: "registry", stage: "pane_transaction", acquired: lock !== null, wait_ms: Math.round(performance.now() - paneLockMs),
    pane_id: observed?.paneId ?? "", handle: name,
  });
  if (lock === null) {
    fail(1, "registry_lock_busy", "tap register", `another TAP mutation holds '${acting}.lock' — retry once the write completes`);
  }
  // One observation covers epoch and pane identity. The lock-entry call keeps
  // the combined identity_unverified refusal; the pre-write call reports an
  // epoch move on its own (server_epoch_moved), matching the dedicated read
  // this folded away — including on a server rebirth at the same socket path,
  // whose reused target may be a retained dead pane or gone entirely, so the
  // epoch is checked before the pane-state refusals. A carried observation
  // (ok or pane_dead) states the server epoch itself; without one, the
  // dedicated uncached read does. The happy path adds no spawn.
  const revalidatePane = (opts: { epochMovedRefusal?: boolean } = {}): TmuxPaneObservation | undefined => {
    const current = observePaneResult(form.pane, env);
    const epochRefusal = (movedTo: string) => fail(1, "server_epoch_moved", `tap register ${chosen} --pane ${form.pane}`,
      `tmux server generation moved while registering '${chosen}' (${epochNow} -> ${movedTo}); nothing was written`);
    if (opts.epochMovedRefusal) {
      const observedEpoch = "observation" in current ? current.observation.serverEpoch : null;
      if (observedEpoch !== null) {
        if (observedEpoch !== epochNow) epochRefusal(observedEpoch);
      } else {
        const e = serverEpochNow(env);
        if (e !== "" && e !== epochNow) epochRefusal(e);
      }
    }
    if (current.status === "pane_dead") {
      fail(1, "pane_dead", "tap register --pane <running-tmux-target>", `pane '${form.pane}' has exited; registration was not written`);
    }
    if (current.status !== "ok") {
      fail(1, "identity_unverified", "verify tmux and retry the registry write", `pane '${form.pane}' is no longer observable as running; registration was not written`);
    }
    const now = current.observation;
    if (now.serverEpoch !== epochNow) {
      if (opts.epochMovedRefusal) {
        epochRefusal(now.serverEpoch);
      }
      fail(1, "identity_unverified", "retry registration against the current pane", `pane '${form.pane}' changed during registration; registration was not written`);
    }
    if (now.paneId !== observed!.paneId || now.session !== observed!.session || now.panePid !== observed!.panePid) {
      fail(1, "identity_unverified", "retry registration against the current pane", `pane '${form.pane}' changed during registration; registration was not written`);
    }
    return now;
  };
  let updateDetail = "";
  const releaseLines: { handle: string; reason: string; rebind: boolean }[] = [];
  // Set where register_write_committed is emitted; the tail timing below
  // reads it after the lock release, which only committed runs reach.
  let committedAt = 0;
  try {
    const auth = validateLockedRegistryAuthority(acting, worktree, indexHome, { requireLive: ctx.requireLive });
    if (!auth.ok) {
      if (auth.retry) fail(1, "flip_in_progress", `tap register`, auth.detail);
      fail(1, "invalid_flip", "tap doctor", auth.detail);
    }

    // Discovery preceded the lock wait. Refuse a stopped or replaced target
    // before any adoption or lineage effects, then check again at their boundary.
    // The returned record is IN-LOCK evidence: the self-attestation below may
    // reuse its pane pid, never the pre-lock discovery facts.
    const revalidated = revalidatePane();
    const enrollment = paneEnrollmentRefusal({ paneId: observed!.paneId, epoch: epochNow,
      socket: observedSocket }, worktree, indexHome);
    if (enrollment) fail(1, enrollment.errorClass, enrollment.action, enrollment.errorClass + ": " + enrollment.detail);

    // Registry read (lossless), SEATS-ONLY (the C5 store contract: current
    // writers never create or consult an agents axis).
    let doc: JsonMap;
    try {
      doc = loads(readFileSync(acting, "utf8")) as JsonMap;
      if (!isMap(doc)) throw new Error("not an object");
    } catch {
      fail(1, "registry_invalid", "repair_registry", `registry '${acting}' is invalid JSON; refusing to overwrite it`);
    }
    ensureTeamFields(doc!, worktree, branch);
    const agents = currentSeats(doc!, acting);
    const existingEntry = (): JsonMap | null => {
      const e = agents.get(chosen);
      return isMap(e) ? e : null;
    };
    entry = existingEntry();

    // Background-job ownership FIRST: a launcher's retry must not adopt a NEW
    // instance of the seat it selected at dispatch time.
    const selectedInstance = env.TAP_CALLER_SELECTED_INSTANCE ?? "";
    const baseRow = agents.get(base);
    if (selectedInstance !== "" && (!isMap(baseRow) || fieldStr(baseRow, "instance") !== selectedInstance)) {
      fail(2, "seat_instance_changed", "start a new background job from the current seat", "background job owner instance changed before the locked registration write; nothing was written");
    }

    if (env.TAP_REGISTER_CREW_CAPTURE_ONLY === "1" && (!isMap(baseRow)
      || !(baseRow.get("crew") === true || baseRow.get("crew") === 1n)
      || !samePaneIdentity(baseRow, observed!.paneId, epochNow)
      || fieldStr(baseRow, "server_socket") !== observedSocket)) {
      fail(1, "crew_row_changed", "tap crew list", "crew changed before native identity observation; nothing was written");
    }

    // Team-wide foreign-namespace refusal BEFORE any suffixing: one row bound
    // to another tmux socket means the whole team is probed through the wrong
    // namespace. --namespace-crossing is the only bypass.
    if (form.delivery !== "poll" && observedSocket !== "" && !form.namespaceCrossing) {
      for (const [, row] of agents.entries()) {
        if (isMap(row) && fieldStr(row, "server_socket") !== "" && fieldStr(row, "server_socket") !== observedSocket
          && bootIdsMatch(fieldStr(row, "boot_id"), observedBootId, env) !== "mismatch") {
          fail(1, "namespace_crossing", `pin TAP_INDEX_HOME and TAP_HOME for probes, or tap register ${base} --namespace-crossing`, "team has pane rows bound under another tmux socket; pin probe TAP state or explicitly pass --namespace-crossing");
        }
      }
    }

    // The chooser snapshot is the team's ONE observation (incumbent
    // chooser_sessions). sessions === null is UNOBSERVABLE and fails closed —
    // never empty; the snapshot is taken after any lock wait.
    const view = chooserView(gather({ env }), env);
    const chooserSessions: ReadonlySet<string> | null = view ? view.sessions : null;
    const seatView: ChooserObservation = view ?? { paneIdOf: () => null, sessionOf: () => "" };
    const sessionLive = (sessionName: string): boolean =>
      sessionName !== "" && chooserSessions !== null && chooserSessions.has(sessionName);

  // Collision ladder: unique team-local handles, never a clobber. Arm order is
  // the incumbent's (tap-register.sh locked-transaction ladder) and each
  // position is load-bearing: the pending bind arm precedes launch-token
  // protection (a pending row claimed by its recorded session IS the
  // SessionStart bind), which precedes the incumbent observation arms.
  const newcomerSession = observed!.session;
  const suffix = (reason: string): void => {
    // deriveHandle drops '-1' suffixes (idx >= 2 is dedup identity), so a
    // '-1' candidate would alias the bare handle on the next derivation —
    // the mint starts at 2 for the same reason the incumbent did.
    for (let n = 2; n <= 64; n++) {
      const candidate = `${base}-${n}`;
      if (!(agents as JsonMap).has(candidate)) { chosen = candidate; suffixReason = reason; return; }
    }
    fail(1, "namespace_exhausted", "tap team", `every '${base}-N' suffix is taken; resolve the incumbents first`);
  };
  // The chooser snapshot is the team's one observation. An entry bound to a
  // foreign socket, or ANY active pane row while the snapshot is unobservable,
  // has no classifiable collision state — never suffix against unknowns.
  const foreignSocket = (e: JsonMap | null): boolean =>
    e !== null && form.delivery !== "poll" && fieldStr(e, "server_socket") !== ""
    && observedSocket !== "" && fieldStr(e, "server_socket") !== observedSocket;
  const collisionIdentityUnknown = (e: JsonMap | null): boolean =>
    foreignSocket(e)
    || (chooserSessions === null && rowActive(e)
      && form.delivery !== "poll" && (fieldStr(e, "pane") !== "" || fieldStr(e, "pane_id") !== ""));

  // Pane-rebind guard: the pane being registered already belongs to other
  // active handle(s). Rebinding silently would retire someone else's identity.
  const panePriorHandles = [...agents.entries()]
    .filter(([, r]) => isMap(r) && rowActive(r)
      && fieldStr(r, "delivery") !== "poll" && samePaneIdentity(r, observed!.paneId, epochNow))
    .map(([h]) => h).sort();
  const paneRebindFrom = panePriorHandles.includes(base) ? [] : panePriorHandles.filter(h => h !== base);
  if (paneRebindFrom.length > 0 && !form.force && !nameDerived) {
    // Ordering pin (session-id-capture): duplicate ownership wins over the
    // rebind classification. A direct captured id that already belongs to a
    // different seat is warned about even when the pane itself is occupied.
    if (!suppressCapture) {
      const directId = directSessionId;
      if (directId !== "") {
        const earlyOwner = duplicateIdentityOwner(directId, chosen, harness, acting, doc!, indexHome);
        if (earlyOwner !== "") {
          process.stderr.write(`tap register: WARNING: quarantined captured harness identity for ${chosen}: native ${harness} session id ${directId} already belongs to expected seat ${earlyOwner}\n`);
        }
      }
    }
    const held = paneRebindFrom[0]!;
    fail(1, "pane_occupied", `tap out, then tap in ${base}`,
      `this pane is registered as '${held}'; refusing to rebind it to '${base}' — nothing was written, you are still '${held}'. A seat whose pane is gone is recovered in a pane of its own, not by wearing its handle here: 'tap session restart ${base}' does that when ${base} is launcher-managed ('tap session list' shows which seats are). If you do mean to stop being '${held}' and become '${base}' in THIS pane, run 'tap out' first, then 'tap in ${base}' — 'tap in ${base} --force' is the same thing in one step, and is only correct when '${held}' is you.`);
  }

  if (form.force && entry !== null && collisionIdentityUnknown(entry)) {
    fail(1, "seat_identity_unknown", `retry tap register ${chosen} --pane ${form.pane} when tmux is observable`, `tmux session-name snapshot was unobservable while force-claiming '${chosen}'; nothing was written`);
  }
  if (!form.force) {
    for (let guard = 0; guard < 65; guard++) {
      entry = existingEntry();
      if (entry !== null && fieldStr(entry, "status") === "pending") {
        const reservedSession = fieldStr(entry, "session");
        if (reservedSession && newcomerSession === reservedSession) break;
        fail(1, "seat_pending", `wait for the launch to finish or tap unregister ${chosen}`,
          `'${chosen}' is pending for session '${reservedSession || "?"}'` +
          (newcomerSession ? `; registering pane is in session '${newcomerSession}'` : ""));
      }
      if (entry !== null && isLaunchReservation(entry)) {
        if (samePaneIdentity(entry, observed!.paneId, epochNow)) break;
        const watchNow = parseInt(env.TAP_WATCH_NOW ?? "", 10);
        const nowEpoch = Number.isFinite(watchNow) ? watchNow : Math.floor(Date.now() / 1000);
        if (!reservationExpired(Object.fromEntries(entry) as Record<string, unknown>, chooserSessions === null ? null : new Set(chooserSessions), nowEpoch, null, null)) {
          const reservedSession = fieldStr(entry, "session");
          fail(1, "seat_launching", `wait for the launch to finish or tap unregister ${chosen}`,
            `'${chosen}' is mid-launch for session '${reservedSession || "?"}'` +
            (newcomerSession ? `; registering pane is in session '${newcomerSession}'` : ""));
        }
        break;
      }
      if (nameDerived && entry !== null && rowActive(entry)
        && fieldStr(entry, "delivery") === "poll") { suffix("poll_incumbent"); continue; }
      if (collisionIdentityUnknown(entry)) { suffix("incumbent_unobservable"); continue; }
      if (entry !== null) {
        const [verdict, livePid, liveSession] = seatVerdict(entry, seatView, epochNow);
        if (verdict === SEAT_UNOBSERVABLE) { suffix("incumbent_unobservable"); continue; }
        if (rowActive(entry)) {
          if (verdict === SEAT_PANE_GONE) {
            const incumbentSession = fieldStr(entry, "session");
            if (incumbentSession && newcomerSession && incumbentSession !== newcomerSession && sessionLive(incumbentSession)) {
              suffix("incumbent_live_session"); continue;
            }
            break;
          }
          if (livePid && livePid !== observed!.paneId) {
            if (newcomerSession && liveSession === newcomerSession && verdict === SEAT_PANE_RECYCLED) break;
            suffix(verdict === SEAT_PANE_RECYCLED ? "address_recycled" : "live_pane"); continue;
          }
        }
      }
      break;
    }
  }
  entry = existingEntry();
  priorExistingChosen = entry !== null;

  // Crew rows retain their conversation after process loss. Creation cannot consume one.
  if (form.crew && (env.TAP_REGISTER_CREW_OWNER_PANE ?? "") !== "" && entry !== null
    && !samePaneIdentity(entry, observed!.paneId, epochNow, form.pane)) {
    fail(1, "handle_collision", `tap crew resume ${chosen} or tap crew remove ${chosen}`,
      `crew name '${chosen}' is retained; nothing was replaced`);
  }

  // Instance lineage: restore/fresh validation, mint otherwise.
  let instanceId = fieldStr(entry, "instance");
  if (flipLive(indexHome)) {
    if (priorExistingChosen && (form.fresh || form.restoreId)) {
      fail(1, "usage_error", `tap in ${chosen} --list-history --json`, `refusing --${form.fresh ? "fresh" : "restore"} for current seat '${chosen}' (tap out first, or rebind without those flags)`);
    }
    if (form.restoreId) {
      const rows = listHandleHistory(bus.busHome, chosen);
      if (!rows.some(r => r.get("instance") === form.restoreId)) {
        fail(1, "usage_error", `tap in ${chosen} --list-history --json`, `--restore '${form.restoreId}' is not a tombstone for '${chosen}'`);
      }
      instanceId = form.restoreId;
    } else if (form.fresh || !priorExistingChosen) {
      instanceId = "";
    }
  }

  // Copy of the existing row preserving unknown per-agent keys; the identity
  // ladder below mutates only the known fields.
  const next = new Map<string, JsonValue>(entry ?? new Map<string, JsonValue>());

  // Identity capture: the verified session id + transcript ride the entry;
  // suppression (crew pre-registration, daemon jobs) blanks them.
  const directIdentityFire = form.harnessSessionId !== "" || (env.TAP_HARNESS_SESSION_ID ?? "") !== "";
  harnessSessionId = directSessionId;
  // Session attribution rides the shared session-store owner: ONE derive call
  // with the pane pid. Only env/process trust promotes an id into the
  // authoritative harness_session_id; weaker trusts are stamped as data.
  if (!suppressCapture && attribution && (attribution.trust === "env" || attribution.trust === "process") && harnessSessionId === "" && attribution.harness_session_id !== "") {
    harnessSessionId = attribution.harness_session_id;
  }
  let transcriptPath: string = env.TAP_TRANSCRIPT_PATH ?? "";
  // tap-yemkc: derived_unique/derived_ambiguous is a heuristic guess, not an
  // authoritative session id (session-store.ts's TRUST_LEVELS scale); only
  // process/env trust may promote into the authoritative transcript_path.
  // A weaker result stays available as session_store_path metadata only.
  if (transcriptPath === "" && attribution && attribution.store_kind === "file" && attribution.store_path !== ""
    && (attribution.trust === "process" || attribution.trust === "env")) {
    transcriptPath = attribution.store_path;
  }
  if (suppressCapture) { harnessSessionId = ""; transcriptPath = ""; }
  const sessionSource = (env.TAP_SESSION_SOURCE ?? "").trim().toLowerCase();
  // tap-yemkc: under suppressCapture the inherited TAP_CLEAR_ID belongs to
  // the driver/daemon, not the target pane; blank it like the harness
  // session and transcript above, or it can falsely witness a pending clear.
  const clearId = suppressCapture ? "" : (env.TAP_CLEAR_ID ?? "");
  const acceptObservedIdentity = form.acceptObserved || env.TAP_ACCEPT_OBSERVED_IDENTITY === "1";
  const callerUnder = callerUnderPane(form.pane, env, revalidated?.panePid ?? "");

  // Identity ladder (the incumbent's locked-transaction heredoc, verbatim):
  // capture-mode normalization, same-observation preservation (tap-wolp), the
  // quarantine reason ladder, the operator's withdrawal (tap-zqcd), the
  // self-attested rebind (tap-o07f2), and the accept/quarantine write-out.
  const priorHarness = fieldStr(entry, "harness");
  const authoritativeHarnessSessionId = !priorHarness || priorHarness === harness ? fieldStr(entry, "harness_session_id") : "";
  oldHarnessSessionId = fieldStr(entry, "harness_session_id");
  const samePaneOwner = entry !== null && samePaneIdentity(entry, observed!.paneId, epochNow, form.pane);
  const crewOwner = fieldStr(entry, "crew_owner");
  const parentRow = agents.get(crewOwner);
  const parentIdentityDuplicate = (form.crew || entry?.get("crew") === true || entry?.get("crew") === 1n)
    && harnessSessionId !== "" && isMap(parentRow) && fieldStr(parentRow, "harness_session_id") === harnessSessionId;
  const duplicateOwner = parentIdentityDuplicate ? `${team}/${crewOwner}`
    : duplicateIdentityOwner(harnessSessionId, chosen, harness, acting, doc!, indexHome);
  const rowPaneDead = entry !== null && seatVerdict(entry, seatView, epochNow)[0] === SEAT_PANE_GONE;
  const matchCandidate = entry !== null && harnessSessionId !== "" && (samePaneOwner || rowPaneDead) && harnessSessionId !== oldHarnessSessionId;
  let captureAcceptedNow = false;
  wasSuspended = entry !== null && fieldStr(entry, "status") === "suspended";
  const launcherOwnedStart = entry !== null
    && fieldStr(entry, "status") !== "pending"
    && isLaunchReservation(entry)
    && samePaneIdentity(entry, observed!.paneId, epochNow);
  if (entry !== null && entry.get("status") === undefined) {
    process.stderr.write(`tap register: warning: '${chosen}' was a legacy entry (no status) — upgrading provenance\n`);
  }
  const identityCapture = isMap(entry?.get("identity_capture")) ? entry!.get("identity_capture") as JsonMap : new Map<string, JsonValue>();
  let captureMode = str(identityCapture.get("mode")) || "unattested";
  let expectedHarnessSessionId = str(identityCapture.get("expected_harness_session_id"));
  if (captureMode !== "launcher_new" && captureMode !== "exact_resume" && captureMode !== "untrusted_resume" && captureMode !== "unattested") captureMode = "unattested";
  if (captureMode === "exact_resume" && expectedHarnessSessionId === "") captureMode = "untrusted_resume";
  const priorCaptureResult = isMap(entry?.get("identity_capture_result")) ? entry!.get("identity_capture_result") as JsonMap : new Map<string, JsonValue>();
  const priorObservedHarnessSessionId = str(priorCaptureResult.get("observed_harness_session_id"));
  const sameObservation = harnessSessionId !== "" && priorObservedHarnessSessionId !== ""
    && harnessSessionId === priorObservedHarnessSessionId
    && duplicateOwner === ""
    && !(expectedHarnessSessionId !== "" && harnessSessionId !== expectedHarnessSessionId);
  let identityQuarantineReason = "";
  if (duplicateOwner !== "") {
    identityQuarantineReason = `native ${harness} session id ${harnessSessionId} already belongs to expected seat ${duplicateOwner}`;
  } else if (expectedHarnessSessionId !== "" && harnessSessionId !== expectedHarnessSessionId) {
    identityQuarantineReason = `observed native ${harness} session id ${harnessSessionId} did not match launcher expectation ${expectedHarnessSessionId} for expected seat ${chosen}`;
  } else if (captureMode === "untrusted_resume" && harnessSessionId !== authoritativeHarnessSessionId) {
    identityQuarantineReason = `picker/latest/adopted resume was not bound to expected seat ${chosen}`;
  } else if (captureMode === "unattested" && authoritativeHarnessSessionId !== "" && harnessSessionId !== authoritativeHarnessSessionId) {
    identityQuarantineReason = `unattested SessionStart identity differed from expected seat ${chosen}`;
  }
  let retiredExpectation = "";
  if (acceptObservedIdentity) {
    if (harnessSessionId !== "" && expectedHarnessSessionId !== "" && harnessSessionId !== expectedHarnessSessionId && duplicateOwner === "") {
      retiredExpectation = expectedHarnessSessionId;
      expectedHarnessSessionId = "";
      identityQuarantineReason = "";
      captureMode = "operator_accepted";
      process.stderr.write(`tap register: retired the launcher identity expectation for ${chosen}: expected ${retiredExpectation}, accepting observed ${harnessSessionId}\n`);
    } else {
      const why = harnessSessionId === ""
        ? "this registration reported no native session id, so there is no observed identity to accept"
        : expectedHarnessSessionId === ""
          ? "there is no standing launcher expectation to withdraw"
          : harnessSessionId === expectedHarnessSessionId
            ? "the observed id already matches the expectation"
            : "this refusal is not the launcher's question — see identity_quarantine_reason on the row";
      process.stderr.write(`tap register: --accept-observed-identity changed nothing for ${chosen}: ${why}\n`);
    }
  }
  if (!retiredExpectation
    && (sessionSource === "clear" || sessionSource === "compact" || sessionSource === "fork")
    && harnessSessionId !== oldHarnessSessionId
    && directIdentityFire
    && callerUnder
    && harnessSessionId !== ""
    && expectedHarnessSessionId !== ""
    && harnessSessionId !== expectedHarnessSessionId
    && duplicateOwner === "") {
    retiredExpectation = expectedHarnessSessionId;
    expectedHarnessSessionId = "";
    identityQuarantineReason = "";
    captureMode = "self_attested_rebind";
    process.stderr.write(`tap register: retired the launcher identity expectation for ${chosen} on a self-attested ${sessionSource}: expected ${retiredExpectation}, adopting reported ${harnessSessionId}\n`);
  }
  // Pane ownership permits a matched update only for registry-actual identity
  // drift; ownership and expected-mint quarantine remain refusals.
  matchUpdate = matchCandidate
    && !sameObservation
    && (identityQuarantineReason === ""
      || identityQuarantineReason.startsWith("untrusted resume")
      || identityQuarantineReason.startsWith("picker/latest/adopted resume")
      || identityQuarantineReason.startsWith("unattested SessionStart identity differed"));
  if (priorHarness !== "" && priorHarness !== harness) {
    // the incumbent pops these from the COPIED row before the ladder writes
    next.delete("harness_session_id");
    next.delete("transcript_path");
    // A different harness in the pane is not the launched incarnation.
    next.delete("launch_witness");
  }
  // The incapable mark is the operator's statement about THIS pane; only the
  // marked seat's own recorded coordinates clear the pair.
  if (entry !== null && fieldStr(entry, "status") === "suspended" && fieldStr(entry, "status_reason") === "incapable"
    && (fieldStr(entry, "pane") !== form.pane || fieldStr(entry, "pane_id") !== observed!.paneId)) {
    process.stderr.write(`tap register: '${chosen}' is suspended (incapable); the mark was made on pane ${fieldStr(entry, "pane") || "(none)"} (${fieldStr(entry, "pane_id") || "(none)"}) and cannot be cleared from pane ${form.pane} (${observed!.paneId}) — re-register from that seat's own pane\n`);
    fail(1, "usage_error", `tap in ${chosen} --list-history --json`, `'${chosen}' is suspended (incapable); re-register from that seat's own pane`);
  }

  // THE BINDING IS DECIDED ONCE (tap-68lp): an existing value survives; only
  // --override-worktree, the deliberate moment, may replace it.
  const now = nowIso();
  next.set("cost_mode", form.mode);
  next.set("delivery", "pane");
  next.set("harness", harness !== "" ? harness : (fieldStr(entry, "harness") || chosen));
  next.set("include_policy", form.include);
  next.set("pane", form.pane);
  if (observed!.currentCommand !== "") next.set("pane_current_command", observed!.currentCommand); else next.delete("pane_current_command");
  next.set("pane_id", observed!.paneId);
  next.set("registered_at", now);
  next.set("status", "active");
  next.set("status_reason", "");
  next.set("registered_from_worktree", form.overrideWorktree || fieldStr(entry, "registered_from_worktree") === "" ? worktree : fieldStr(entry, "registered_from_worktree"));
  // tap-24f/tap-ua9l finding 7: the stamp is the generation observed IN THE
  // SAME RECORD as the ids, never a fresh probe. Prepare refused an unknown one.
  next.set("server_epoch", epochNow);
  if (observedSocket !== "") next.set("server_socket", observedSocket); else next.delete("server_socket");
  if (observedBootId !== "") next.set("boot_id", observedBootId); else next.delete("boot_id");
  // tap-36kb: record the nonce ONLY when it answers a pending question. Pop
  // the WITNESS when TAP_CLEAR_ID is absent; never pop the PENDING QUESTION.
  const expectedClear = fieldStr(entry, "expected_clear_nonce");
  if (clearId === "") next.delete("clear_nonce");
  else if (expectedClear !== "" && clearId === expectedClear) next.set("clear_nonce", clearId);
  else if (expectedClear !== "" && clearId !== expectedClear) {
    process.stderr.write(`tap register: WARNING: a non-matching TAP_CLEAR_ID is not an answer to this clear's pending question (expected ${expectedClear}, observed ${clearId})\n`);
    ctx.clearMismatch = `${expectedClear},${clearId}`;
  }
  // tap-24f: persist the session NAME captured beside the ids.
  if (observed!.session !== "") next.set("session", observed!.session);
  if (form.crew) next.set("crew", true);
  else if (!samePaneOwner) next.delete("crew");
  if (form.crew && !(entry?.get("crew") === true || entry?.get("crew") === 1n)) {
    // Only creation may establish parentage. A later SessionStart preserves
    // even a missing/wrong legacy link until the operator recreates the crew.
    const callerPane = env.TAP_REGISTER_CREW_OWNER_PANE ?? "";
    const owners = [...agents.entries()].filter(([, value]) => isMap(value)
      && value.get("crew") !== true && value.get("crew") !== 1n
      && fieldStr(value, "pane_id") === callerPane && callerPane !== ""
      && fieldStr(value, "instance") !== "" && rowActive(value)
      && fieldStr(value, "delivery") !== "poll"
      && fieldStr(value, "session") === observed!.session
      && fieldStr(value, "server_epoch") === epochNow
      && fieldStr(value, "server_socket") === observedSocket);
    if (owners.length !== 1 || callerPane === observed!.paneId) {
      fail(1, "crew_owner_unidentified", "create the crew from its registered parent with tap crew add",
        "crew creation requires one current non-crew caller pane and retained parent instance; nothing was written");
    }
    next.set("crew_owner", owners[0]![0]);
    next.set("crew_owner_instance", fieldStr(owners[0]![1] as JsonMap, "instance"));
  }
  if (next.get("crew") !== true && next.get("crew") !== 1n) {
    next.delete("crew_owner");
    next.delete("crew_owner_instance");
    next.delete("crew_identity_capture");
  }
  // SessionStart is an ensure-bound fallback, not the owner of launcher
  // readiness; the launcher clears both reason and launch_id after verification.
  if (launcherOwnedStart) {
    next.set("status_reason", "launching");
    if (!form.modeSet && (fieldStr(entry, "cost_mode") === "subscription" || fieldStr(entry, "cost_mode") === "api")) next.set("cost_mode", fieldStr(entry, "cost_mode"));
    if (!form.includeSet && (fieldStr(entry, "include_policy") === "always" || fieldStr(entry, "include_policy") === "on_request")) next.set("include_policy", fieldStr(entry, "include_policy"));
  } else {
    next.delete("launch_id");
  }
  next.delete("wake_url");
  next.delete("exited_at");
  if (form.unattended) next.set("unattended", true);
  else if (!launcherOwnedStart) next.delete("unattended");
  if (form.replyTo !== "") next.set("reply_to", form.replyTo);
  else if (!launcherOwnedStart) next.delete("reply_to");
  if (harnessSessionId !== "" && sameObservation) {
    // tap-wolp: re-registration of an identity this seat has ALREADY judged.
    // The verdict and the quarantine keys stand; only an accepted identity's
    // transcript may be refreshed. tap-rti5i: once that accepted observation
    // is exact_resume and the observed id is the expected id, the expectation
    // is answered. Consuming it here lets a later in-app root session bind.
    // A quarantined exact_resume, and every other capture mode, keeps it.
    if (transcriptPath !== "" && str(priorCaptureResult.get("decision")) === "accepted") next.set("transcript_path", transcriptPath);
    if (str(priorCaptureResult.get("decision")) !== "accepted") next.delete("agy_ls");
    if (str(priorCaptureResult.get("decision")) === "accepted"
      && captureMode === "exact_resume"
      && expectedHarnessSessionId !== ""
      && harnessSessionId === expectedHarnessSessionId) {
      next.delete("identity_capture");
    }
  } else if (harnessSessionId !== "") {
    const quarantineNow = identityQuarantineReason !== "" && !matchUpdate;
    const captureResult: JsonMap = new Map<string, JsonValue>();
    captureResult.set("decision", quarantineNow ? "quarantined" : "accepted");
    captureResult.set("mode", captureMode);
    captureResult.set("observed_harness_session_id", harnessSessionId);
    if (expectedHarnessSessionId !== "") captureResult.set("expected_harness_session_id", expectedHarnessSessionId);
    if (retiredExpectation !== "") captureResult.set("retired_expectation", retiredExpectation);
    if (quarantineNow) {
      next.delete("agy_ls");
      next.set("quarantined_harness_session_id", harnessSessionId);
      if (transcriptPath !== "") next.set("quarantined_transcript_path", transcriptPath);
      next.set("identity_quarantine_reason", identityQuarantineReason);
      captureResult.set("reason", identityQuarantineReason);
      quarantineWarning = identityQuarantineReason;
    } else {
      if (identityQuarantineReason !== "") {
        process.stderr.write(`tap register: accepted drifted harness identity for ${chosen}: ${identityQuarantineReason}\n`);
      }
      next.set("harness_session_id", harnessSessionId);
      if (transcriptPath !== "") next.set("transcript_path", transcriptPath);
      captureAcceptedNow = true;
    }
    next.set("identity_capture_result", captureResult);
    // The expectation is popped ONLY when it has been ANSWERED — a refusal
    // that consumes its own evidence cannot be made safe downstream.
    if (!quarantineNow) next.delete("identity_capture");
  } else if (transcriptPath !== "") {
    if (identityQuarantineReason !== "" || captureMode === "untrusted_resume") {
      identityQuarantineReason = identityQuarantineReason !== ""
        ? identityQuarantineReason
        : `picker/latest/adopted resume supplied no verifiable identity for expected seat ${chosen}`;
      next.set("quarantined_transcript_path", transcriptPath);
      next.set("identity_quarantine_reason", identityQuarantineReason);
      const captureResult: JsonMap = new Map<string, JsonValue>();
      captureResult.set("decision", "quarantined");
      captureResult.set("mode", captureMode);
      captureResult.set("observed_harness_session_id", "");
      captureResult.set("reason", identityQuarantineReason);
      if (expectedHarnessSessionId !== "") captureResult.set("expected_harness_session_id", expectedHarnessSessionId);
      next.set("identity_capture_result", captureResult);
      next.delete("identity_capture");
      quarantineWarning = identityQuarantineReason;
    } else {
      next.set("transcript_path", transcriptPath);
    }
  }
  // Attribution stamps: provenance for where the session id came from. A
  // derived (non env/process) id is recorded as derived_*, never authority.
  if (attribution && (attribution.trust !== "none" || attribution.store_path !== "")) {
    next.set("session_attribution_trust", attribution.trust);
    next.set("derived_at", attribution.derived_at !== "" ? attribution.derived_at : now);
    if (attribution.store_path !== "") {
      next.set("session_store_path", attribution.store_path);
      next.set("session_store_kind", attribution.store_kind);
    }
    if (attribution.trust !== "env" && attribution.trust !== "process" && attribution.harness_session_id !== "") {
      next.set("derived_harness_session_id", attribution.harness_session_id);
    } else next.delete("derived_harness_session_id");
    if (attribution.candidates > 0) next.set("session_attribution_candidates", BigInt(attribution.candidates));
    if (attribution.detail !== "") next.set("session_attribution_detail", attribution.detail);
  }
  if (matchUpdate) {
    // THIS WRITE OVERWRITES the capture_result built above, so a retirement
    // recorded there is re-stated here (tap-o07f2 rider).
    next.set("harness_session_id", harnessSessionId);
    if (transcriptPath !== "") next.set("transcript_path", transcriptPath);
    const captureResult: JsonMap = new Map<string, JsonValue>();
    captureResult.set("decision", "accepted");
    captureResult.set("mode", captureMode);
    captureResult.set("observed_harness_session_id", harnessSessionId);
    if (retiredExpectation !== "") captureResult.set("retired_expectation", retiredExpectation);
    next.set("identity_capture_result", captureResult);
    captureAcceptedNow = true;
    matchDetail = `old_session=${oldHarnessSessionId || "-"},new_session=${harnessSessionId},old_pane=${fieldStr(entry, "pane_id") || "-"},new_pane=${observed!.paneId || "-"}`;
  }
  if (captureAcceptedNow) {
    next.delete("quarantined_harness_session_id");
    next.delete("quarantined_transcript_path");
    next.delete("identity_quarantine_reason");
  }
  if (next.get("crew") === true || next.get("crew") === 1n) {
    // Keep the general identity verdict vocabulary unchanged. This crew-only
    // observation also represents an attempt that obtained no authoritative id.
    const outcome: JsonMap = new Map<string, JsonValue>();
    outcome.set("at", now);
    if (suppressCapture) {
      if (!isMap(next.get("crew_identity_capture"))) {
        outcome.set("decision", "not_started");
        outcome.set("reason", "crew harness has not started");
        next.set("crew_identity_capture", outcome);
      }
    } else if (harnessSessionId !== "") {
      const verdict = next.get("identity_capture_result");
      if (isMap(verdict)) for (const [key, value] of verdict) outcome.set(key, value);
      next.set("crew_identity_capture", outcome);
    } else if (env.TAP_REGISTER_CREW_CAPTURE_ONLY === "1" && samePaneOwner && priorHarness === harness
      && isMap(next.get("crew_identity_capture"))
      && ["accepted", "quarantined"].includes(str((next.get("crew_identity_capture") as JsonMap).get("decision")))) {
      // A hook can bind while the post-add probe starts. No observation from
      // that weaker probe cannot erase the hook's result on this exact crew.
    } else {
      outcome.set("decision", "unavailable");
      outcome.set("reason", paneHarness !== harness
        ? `requested ${harness} harness not observed (observed ${paneHarness || "unknown"})`
        : `no authoritative native identity: ${attribution?.trust ?? "none"}; ${attribution?.detail || "no process or hook identity"}`);
      next.set("crew_identity_capture", outcome);
    }
  }
    // Revalidate before the first durable lineage/adoption effect. Once mail
    // moves, finish publishing its matching successor row even if the process
    // exits during the sweep; a late refusal would strand adopted mail.
    const socketAfter = tmux(["display-message", "-p", "-t", form.pane, "#{socket_path}"], env);
    const socketNow = socketAfter.code === 0 ? socketAfter.stdout.split("\n", 1)[0] ?? "" : "";
    if (socketNow !== observedSocket) {
      fail(1, "server_epoch_moved", `tap register ${chosen} --pane ${form.pane}`, "tmux socket changed or became unobservable during registration; nothing was written");
    }

    revalidatePane({ epochMovedRefusal: true });

  if (flipLive(indexHome)) {
    if (instanceId !== "") next.set("instance", instanceId);
    else {
      next.delete("instance");
      const rec = seatRecord(next);
      ensureSeatInstance(rec as never, chosen);
      const minted = seatRecordInstance(rec);
      if (minted !== "") { next.set("instance", minted); instanceId = minted; }
    }
    // Pane-session lineage: the rebind/restore/fresh fact rides the shared
    // team-history contract. Failures are warning-only, never a refusal.
    if (instanceId !== "") {
      const note = form.restoreId !== "" ? "restore" : form.fresh || !priorExistingChosen ? "fresh" : "rebind";
      try {
        appendPaneSessionLog(bus.busHome, chosen, instanceId, form.pane, observed!.paneId, harnessSessionId, note);
      } catch (e) {
        process.stderr.write(`tap register: warning: lineage log failed (${(e as Error).message})\n`);
      }
    }
  }

    // Dedup + adoption sweep UNDER the lock (incumbent order): release the
    // proven-superseded rows, adopt their unsettled mail onto this seat with
    // one shared 15-second deadline and the 8-handle cap, grant the successor,
    // and only then publish the row and the released handles together.
    const deadline = Date.now() + 15_000;
    const releasedList: { handle: string; instance: string }[] = [];
    for (const handle of [...agents.keys()].sort()) {
      if (handle === chosen) continue;
      const row = agents.get(handle);
      if (!isMap(row)) continue;
      if (!rowActive(row) || fieldStr(row, "delivery") === "poll" || collisionIdentityUnknown(row)) continue;
      // tap-zk1w: an unstamped row makes no generation claim, so neither pane
      // agreement nor session agreement proves it superseded; releasing it
      // would adopt another seat's mail.
      if (fieldStr(row, "server_epoch") === "") continue;
      let reason = "";
      if (samePaneIdentity(row, observed!.paneId, epochNow)) {
        reason = "same pane";
      } else {
        const [v, liveId] = seatVerdict(row, seatView, epochNow);
        const address = fieldStr(row, "pane");
        const incumbentSession = address.includes(":") ? address.split(":")[0]! : "";
        if (v === SEAT_PANE_GONE && incumbentSession !== "" && incumbentSession === newcomerSession) reason = "same session";
        else if (v === SEAT_PANE_RECYCLED && liveId === observed!.paneId) reason = "same session";
      }
      if (reason === "") continue;
      const wasRebind = paneRebindFrom.includes(handle);
      agents.delete(handle);
      releaseLines.push({ handle, reason, rebind: wasRebind });
      releasedList.push({ handle, instance: fieldStr(row, "instance") });
      updateDetail = updateDetail === "" ? `${handle}:${fieldStr(row, "pane")}` : updateDetail;
    }
    // ONE bounded adopt-batch subprocess drives the whole sweep: the transport
    // is the deadline envelope, real per-handle outcomes move the epoch, and
    // every transport failure is loud and fail-closed.
    type AdoptOutcome = { adopted_ids?: JsonValue[]; count?: number; remainder?: JsonValue[] };
    type AdoptBatch = { handles: Record<string, AdoptOutcome>; skipped: string[]; failed: string[] } | null;
    let batch: AdoptBatch = null;
    let cap = 0;
    if (releasedList.length > 0) {
      mkdirSync(bus.payloads, { recursive: true });
      mkdirSync(bus.receipts, { recursive: true });
      const capsR = spawnSync(artifactBun() ?? "bun", [runtimeModule("src/seat-adopt.ts"), "caps"], { encoding: "utf8", timeout: 15_000 });
      if (capsR.status === 0 && capsR.stdout) {
        try {
          const caps = JSON.parse(capsR.stdout) as { max_adopted_handles?: number };
          if (Number.isInteger(caps.max_adopted_handles) && caps.max_adopted_handles! > 0) cap = Math.min(caps.max_adopted_handles!, MAX_ADOPTED_HANDLES);
        } catch { /* unavailable owner: release rows, retain mail, report remainder */ }
      }
      const capped = releasedList.slice(0, cap);
      // The owner checks its deadline before starting each handle. A started
      // rewrite must finish; killing this child can lose its actual outcome.
      const r = capped.length === 0 ? null : spawnSync(artifactBun() ?? "bun", [
        runtimeModule("src/seat-adopt.ts"), "adopt-batch",
        bus.payloads, bus.receipts, chosen, team, String(deadline),
        ...capped.map((e) => e.handle),
      ], { encoding: "utf8" });
      if (r?.status === 0 && r.stdout) {
        try {
          const parsed = JSON.parse(r.stdout);
          if (parsed && parsed.handles && typeof parsed.handles === "object" && !Array.isArray(parsed.handles)
            && Array.isArray(parsed.skipped) && Array.isArray(parsed.failed)) batch = parsed;
        } catch { batch = null; }
      }
    }
    for (const { handle, instance: releasedInstance } of releasedList.slice(0, cap)) {
      // Grants record every adopted predecessor regardless of the transport
      // outcome; only an actual mail-moving count moves the seat epoch.
      const prevList = Array.isArray(next.get("adopted_handles")) ? next.get("adopted_handles") as JsonValue[] : [];
      if (!prevList.includes(handle)) next.set("adopted_handles", [...prevList, handle]);
      if (releasedInstance !== "") {
        const prevMap = isMap(next.get("adopted_instances")) ? next.get("adopted_instances") as JsonMap : new Map<string, JsonValue>();
        prevMap.set(handle, releasedInstance);
        next.set("adopted_instances", prevMap);
      }
      const r = batch === null ? undefined : batch.handles[handle];
      if (batch === null || !r || typeof r.count !== "number" || !Array.isArray(r.adopted_ids) || !Array.isArray(r.remainder)) {
        if (batch !== null && batch.skipped.includes(handle)) {
          process.stderr.write(`tap register: WARNING: adoption sweep deadline exhausted; payload(s) addressed to ${handle} were NOT adopted — settle manually\n`);
        } else if (batch !== null && batch.failed.includes(handle)) {
          process.stderr.write(`tap register: WARNING: adoption of ${handle} ended in an unknown state; payload(s) addressed to ${handle} may be PARTIALLY adopted; settle manually and re-check before re-running\n`);
        } else {
          process.stderr.write(`tap register: WARNING: adoption owner unavailable; payload(s) addressed to ${handle} were NOT adopted — settle manually\n`);
        }
        continue;
      }
      if (r.count! >= 1) {
        const prevEpoch = parseInt(str(next.get("session_epoch")) || "0", 10);
        const newEpoch = (Number.isFinite(prevEpoch) ? prevEpoch : 0) + 1;
        next.set("session_epoch", BigInt(newEpoch));
        if (!ctx.jsonMode) process.stdout.write(`tap register: adopted ${r.count} payload(s) from ${handle}; seat epoch -> ${newEpoch}\n`);
      }
      if (r.remainder!.length > 0) {
        process.stderr.write(`tap register: WARNING: ${r.remainder!.length} payload(s) addressed to ${handle} exceed the adoption cap and were NOT adopted — settle manually: ${r.remainder!.map(String).join(", ")}\n`);
      }
    }
    const handleRemainder = releasedList.slice(cap).map((e) => e.handle);
    if (handleRemainder.length > 0) {
      process.stderr.write(`tap register: WARNING: ${handleRemainder.length} released handle(s) exceed the ${cap}-handle adoption cap and were NOT adopted — their unsettled mail is stranded, settle manually: ${handleRemainder.join(", ")}\n`);
    }
    agents.set(chosen, next);
    supersedeStaleForwardingAliases(doc!, agents);
    atomicWrite(acting, `${pyDumpIndent(doc!, 0).replace(/\u007f/g, "\\u007f")}\n`);
    const committedLaunchId = fieldStr(next, "launch_id");
    committedAt = performance.now();
    hookTrace("register_write_committed", {
      handle: chosen,
      pane_id: observed?.paneId ?? "",
      harness_session_id: fieldStr(next, "harness_session_id"),
      ...(committedLaunchId !== "" ? { launch_id: committedLaunchId } : {}),
      ms_since_begin: Math.round(performance.now() - registerTraceBeginMs),
    });
  } finally {
    lock.release();
  }

  // Control lines + events (wrapper contract preserved verbatim). Report the
  // two outcomes only after the registry replace and fence exit succeed.
  if (quarantineWarning !== "") {
    process.stderr.write(`tap register: seat registration saved for ${team}/${chosen}; TAP messaging uses this address. Captured harness identity was not accepted.\n`);
    process.stderr.write(`tap register: WARNING: quarantined captured harness identity for ${chosen}: ${quarantineWarning}\n`);
  }
  const action = matchUpdate ? "updated" : wasSuspended ? "reactivated" : "registered";
  if (ctx.derivedNote !== "") process.stderr.write(`${ctx.derivedNote}\n`);
  if (!ctx.jsonMode && matchUpdate) {
    process.stdout.write(`tap register: UPDATED seat ${team}/${chosen} — session ${harnessSessionId} (was ${oldHarnessSessionId || "-"}), pane ${observed!.paneId || "-"}${observed!.paneId === fieldStr(entry, "pane_id") ? " (unchanged)" : ` (was ${fieldStr(entry, "pane_id") || "-"})`}\n`);
  } else if (!ctx.jsonMode && wasSuspended) {
    process.stdout.write(`tap register: REACTIVATED seat ${team}/${chosen} — session ${harnessSessionId} (was suspended), pane ${observed!.paneId || "-"}\n`);
  } else if (!ctx.jsonMode) {
    process.stdout.write(`tap register: registered ${chosen} on team ${team}\n`);
  }
  // Post-commit tail timing (launchfast): one trace row splits the
  // write→register_end tail across its steps. control_lines_ms holds the
  // lock release plus the control-line writes, suffix_primer_ms the two
  // emissions outside the briefing step; tail_total_ms spans committedAt to
  // this emit, so any residual untimed gap shows as total minus the field
  // sum. Timing only — the clock reads are free when the trace is closed,
  // and the trace itself is a no-op without TAP_SESSION_SOURCE.
  const tailMs: Record<string, number> = {};
  tailMs.control_lines_ms = Math.round(performance.now() - committedAt);
  let tailStep = performance.now();
  const eventLog = env.TAP_REGISTRY_EVENTS ?? join(bus.busHome, "registry-events.log");
  appendRegistryEventOrWarn("tap register", { actor: chosen, action, handle: chosen, pane: form.pane, team, detail: matchDetail, log: eventLog, env });
  for (const rel of releaseLines) {
    if (!ctx.jsonMode) {
      if (rel.rebind) {
        process.stdout.write(`tap register: identity rebind: this pane gave up ${rel.handle} to become ${chosen}; ${rel.handle} is no longer registered and its unsettled mail moves here\n`);
      } else {
        process.stdout.write(`tap register: released stale ${rel.handle}; reason: ${rel.reason}\n`);
      }
    }
    appendRegistryEventOrWarn("tap register", { actor: chosen, action: "released", handle: rel.handle, pane: form.pane, team, detail: "", log: eventLog, env });
  }
  if (ctx.clearMismatch !== "") {
    const eq = ctx.clearMismatch.indexOf(",");
    appendRegistryEventOrWarn("tap register", { actor: chosen, action: "clear_nonce_mismatch", handle: chosen, pane: form.pane, team, detail: `expected=${ctx.clearMismatch.slice(0, eq)} observed=${ctx.clearMismatch.slice(eq + 1)}`, log: eventLog, env });
  }
  tailMs.registry_events_ms = Math.round(performance.now() - tailStep);

  tailStep = performance.now();
  markResetGenerationReused(bus.busHome, "register");
  // Registration's durable mutation is complete. Enrollment and output
  // may wait on external work; they must not retain the team-wide reset lock.
  // cmdRegister's finally remains the idempotent release on refusal paths.
  fence.release();
  fenceTestBarrier("after-mutation", { ...env, TAP_RESET_FENCE_TEST_BARRIER: env.TAP_REGISTER_POST_COMMIT_TEST_BARRIER });
  tailMs.reset_fence_ms = Math.round(performance.now() - tailStep);
  // Existing spool waiters/watch ticks own delivery. Register does not start
  // another mail mutation after giving up its reset protection; poll/read
  // retain access to parked mail if an automatic delivery owner is absent.

  tailStep = performance.now();
  if (ctx.worktreeIsGit) enrollAfterCommit(worktree, acting, chosen, team, { form, enrollExpected: ctx.enrollExpected });
  tailMs.enroll_team_ms = Math.round(performance.now() - tailStep);

  tailStep = performance.now();
  emitSuffixWarning(base, chosen, suffixReason);
  const suffixMs = performance.now() - tailStep;

  tailStep = performance.now();
  emitBriefing({ name: chosen, delivery: "pane", target: form.pane, action, priorExisting: priorExistingChosen, note: "", team, worktree, bus, form, indexHome, acting });
  tailMs.emit_briefing_ms = Math.round(performance.now() - tailStep);

  tailStep = performance.now();
  emitPrimer(chosen, priorExistingChosen, form);
  tailMs.suffix_primer_ms = Math.round(suffixMs + (performance.now() - tailStep));

  tailStep = performance.now();
  emitVersionBriefing(chosen, team, worktree, form, env);
  tailMs.emit_version_briefing_ms = Math.round(performance.now() - tailStep);

  tailMs.tail_total_ms = Math.round(performance.now() - committedAt);
  hookTrace("register_tail", { handle: chosen, ...tailMs });
  return 0;
}

function emitSuffixWarning(base: string, chosen: string, reason: string): void {
  if (base === chosen) return;
  const w = (line: string) => process.stderr.write(`tap register: warning: ${line}\n`);
  switch (reason) {
    case "poll_incumbent":
      w(`${base} is held by a POLL seat (no pane); registered ${chosen}. That row still holds the address other seats send to, and a poll seat nobody reads receives nothing while its senders get success receipts; next: tap in ${base} (naming the handle is what authorizes the poll->pane conversion), or tap register ${base} --force`); break;
    case "incumbent_unobservable":
      w(`${base} is held by a row whose pane could NOT be observed, so it was left alone; registered ${chosen}. Absence of observation is not observation of absence: run 'tap team', and if it still lists ${base}, do NOT force — a quiet incumbent is not an absent one; next: tap register ${base} --force only once ${base} is gone from the roster`); break;
    case "incumbent_live_session":
      w(`${base} has stale pane coordinates but its recorded session is still live, so it was left alone; registered ${chosen}; next: tap register ${base} --force only if that session is not a teammate`); break;
    case "address_recycled":
      w(`${base}'s recorded pane is gone, but a DIFFERENT live pane now answers at its recorded address, so it was left alone; registered ${chosen}. ${base} is still where other seats send; next: tap team. Only after confirming that pane is not a teammate, claim it with 'tap register ${base} --force'`); break;
    case "live_pane":
      w(`${base} is held by a live pane; registered ${chosen}; next: tap register ${base} --force`); break;
    default:
      w(`${base} is already taken, so it was left alone; registered ${chosen}. ${base} is still where other seats send — run 'tap team' to see what holds it; next: tap register ${base} --force`);
  }
}

// --- events / briefing / primer / version -------------------------------------------

interface BriefingArgs {
  name: string; delivery: string; target: string; action: string; priorExisting: boolean;
  note: string; team: string; worktree: string; bus: BusRefs; form: RegisterForm;
  indexHome: string; acting: string;
}

function emitBriefing(a: BriefingArgs): void {
  if (a.form.digestWindow !== "") {
    const cfg = driverConfigPath(process.env);
    const win = windowSeconds(a.form.digestWindow);
    try {
      if (cfg == null || win === null) throw new Error("no driver config");
      updateConfig(cfg, `${a.team}/${a.name}`, win, a.form.digestIncludeAsks);
    } catch {
      fail(1, "config_update_failed", "tap digest-window", "registration succeeded but digest window was not saved");
    }
  }
  const myInstance = flipLive(a.indexHome) ? currentInstance(a.acting, a.name) : "";
  const now = Math.floor(Date.now() / 1000);
  // Shared owner, not a briefing-only classifier: to_team gating lives in
  // seat-refresh's addressedToLocalFields (empty to_team is the legacy
  // handle-only contract; a stamped foreign team never reads as local inbox).
  const addressedToLocal = (fields: Record<string, string>): boolean =>
    addressedToLocalFields(fields, a.name, a.team);
  const mine = (fields: Record<string, string>, key: string): boolean => {
    const bound = fields[key] ?? "";
    if (bound === "" || myInstance === "") return true;
    return bound === myInstance;
  };
  const bus = new Bus(a.bus.busHome);
  let messages: ReturnType<typeof recapMessages> | null = null;
  try { messages = recapMessages(bus); } catch { /* unavailable bus has no briefing */ }
  const done = (ident: string): boolean => bus.isDone(ident);
  const age = (mtime: number): number | null => (mtime > 0 ? Math.max(0, now - mtime) : null);
  let parkedCount = 0;
  try {
    const spool = join(bus.home, "spool"), marker = flipMarkerState(a.indexHome);
    if (a.action !== "offline" && marker !== "invalid") for (const n of readdirSync(spool)) {
      const id = n.slice(0, -3), path = join(spool, n);
      if (!isCanonicalPayloadName(n) || !isRegularFile(path) || bus.isDone(id) || existsSync(bus.payloadPath(id))) continue;
      if (spoolAuthorized(path, a.name, { registryPath: a.acting, marker, team: a.team, historyDir: historyDirForBus(bus.home) })) parkedCount++;
    }
  } catch { /* advisory snapshot only: no queue mutation or registration failure */ }

  const inbox: Array<{ id: string; from: string; kind: string; age_seconds: number | null }> = [];
  const outstanding: Array<{ id: string; to: string; kind: string; age_seconds: number | null }> = [];
  for (const { id, path } of messages?.outstanding ?? []) {
    let st; try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    const { fields } = frontmatter(path);
    if (fields === null) continue;
    const row = { id: fields.id || id, kind: fields.kind ?? "", age_seconds: age(Math.floor(st.mtimeMs / 1000)) };
    if (addressedToLocal(fields) && mine(fields, "recipient_instance")) {
      inbox.push({ ...row, from: fields.from ?? "" });
    }
    if (a.priorExisting && senderInstanceMatchesFields(fields, a.name, myInstance, myInstance !== "")) {
      outstanding.push({ ...row, to: fields.to ?? "" });
    }
  }
  const history: Array<{ id: string; kind: string; peer: string; age_seconds: number | null }> = [];
  {
    const cands: Array<{ n: string; m: number }> = [];
    for (const id of messages?.ids ?? []) {
      const n = `${id}.md`, p = bus.payloadPath(id);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isFile()) cands.push({ n, m: st.mtimeMs });
    }
    cands.sort((x, y) => y.m - x.m);
    for (const { n } of cands.slice(0, 20)) {
      const p = join(a.bus.payloads, n);
      const fm = frontmatter(p);
      if (fm.fields === null) continue;
      const sender = fm.fields.from ?? "", recipient = fm.fields.to ?? "";
      const received = addressedToLocal(fm.fields);
      if (sender !== a.name && !received) continue;
      const ident = n.replace(/\.md$/, "");
      if (received && !done(ident)) continue;
      let st; try { st = statSync(p); } catch { continue; }
      history.push({ id: fm.fields.id || ident, kind: fm.fields.kind ?? "", peer: sender === a.name ? recipient : sender, age_seconds: age(Math.floor(st.mtimeMs / 1000)) });
    }
  }
  const seatHistory = a.priorExisting || history.length > 0 ? {
    handle: a.name, team: a.team, prior_existing: a.priorExisting,
    recent_count: history.length, last: history[0] ?? null,
  } : null;
  const receipt: Record<string, unknown> = {
    handle: a.name, team: a.team, worktree: a.worktree,
    delivery: a.delivery, target: a.target, action: a.action,
  };
  if (a.note !== "") receipt.note = a.note;

  if (a.form.json) {
    process.stdout.write(JSON.stringify({ ok: true, receipt, inbox, outstanding, parked_count: parkedCount, seat_history: seatHistory }) + "\n");
  } else if (a.action !== "offline") {
    if (a.note !== "") process.stdout.write(`tap register note: ${a.note}\n`);
    if (parkedCount > 0) process.stdout.write(`tap register: ${parkedCount} parked message(s) for you; next: tap poll ${a.name}\n`);
    const ambiguous = Boolean(seatHistory && !a.priorExisting && history.length > 0);
    if (a.priorExisting) {
      process.stdout.write(`tap recap: you have re-joined as ${a.team}/${a.name} — a fresh instance of an existing seat.\n`);
      process.stdout.write(`tap recap: ${inbox.length} unsettled inbound, ${outstanding.length} of your sends awaiting a reply, ${history.length} recent ${history.length === 1 ? "exchange" : "exchanges"} on record.\n`);
      if (inbox.length > 0) {
        const ids = inbox.slice(0, 5).map(m => m.id).join(", ");
        const more = inbox.length > 5 ? ` (+${inbox.length - 5} more)` : "";
        process.stdout.write(`tap recap: unsettled inbound — ${ids}${more}\n`);
      }
      if (outstanding.length > 0) {
        const ids = outstanding.slice(0, 5).map(m => m.id).join(", ");
        const more = outstanding.length > 5 ? ` (+${outstanding.length - 5} more)` : "";
        process.stdout.write(`tap recap: awaiting a reply — ${ids}${more}\n`);
      }
      if (history.length > 0) {
        process.stdout.write("tap recap: recent exchanges —\n");
        for (const h of history.slice(0, 5)) {
          const ageS = h.age_seconds === null ? "unknown age" : `${h.age_seconds}s ago`;
          process.stdout.write(`  ${h.id}  ${h.peer || "-"}  ${h.kind || "message"}  (${ageS})\n`);
        }
      }
      process.stdout.write(`tap recap: depth on demand — tap recap ${a.name}; work-state rationale lives in beads and PRs, not here.\n`);
    } else if (inbox.length > 0) {
      const noun = inbox.length === 1 ? "message" : "messages";
      process.stdout.write(`tap register: ${inbox.length} ${noun} waiting; next: tap poll ${a.name}\n`);
    }
    if (ambiguous) {
      const last = seatHistory!.last as { id: string; peer: string; age_seconds: number | null } | null;
      if (inbox.length > 0) {
        const tail = last ? ` (last ${last.id} with ${last.peer || "-"})` : "";
        process.stdout.write(`tap register: prior traffic for ${a.name}${tail}; next: review with tap poll ${a.name} before taking over\n`);
      } else {
        let ctx = "";
        if (last) {
          const ageS = last.age_seconds === null ? "unknown" : `${last.age_seconds}s`;
          ctx = `, latest ${last.id} from ${last.peer || "-"} (${ageS})`;
        }
        const count = seatHistory!.recent_count;
        const noun = count === 1 ? "message" : "messages";
        process.stdout.write(`tap register: ${count} prior ${noun} on record for ${a.name}${ctx}; next: review before taking over ${a.name}\n`);
      }
    }
  }
}

// The seat transaction has already committed when enrollTeam runs, so a failed
// machine enrollment cannot undo the registration (a nonzero exit would invite
// a retry against a committed effect). It surfaces as ONE stderr line in every
// mode instead; stdout, JSON receipts included, stays untouched (tap-km9ej).
// The remedy follows the kind: registration is idempotent and re-runs
// enrollTeam, so re-running the same command IS the safe retry for transient
// kinds, a name collision needs the retire-or-rename recovery the detail names,
// and durable index damage goes to tap doctor. The printed retry keeps the
// caller's safe original options for the committed seat (tap-hpp4h).
export interface EnrollWarnContext {
  /** The caller's parsed options; the retry hint is built from the safe subset. */
  form: RegisterForm;
  /** Whether the root was indexable BEFORE the seat committed. enrollTeam also
   *  skips roots that never qualified, silently by policy; only a skip of a
   *  root that qualified at entry means a race took the enrollment. */
  enrollExpected: boolean;
}

/** enrollTeam can THROW after the seat commit (its mkdirSync/index-lock prologue
 *  runs outside its refusal mapping), and an escaping throw would exit nonzero
 *  against a committed mutation. Convert a throw to the same refused outcome
 *  the warning already carries, then warn (tap-km9ej). */
function enrollAfterCommit(worktree: string, acting: string, handle: string, team: string, ctx: EnrollWarnContext): void {
  let enroll: EnrollOutcome;
  try {
    enroll = enrollTeam(worktree, acting);
  } catch (error) {
    enroll = { ok: false, kind: "enroll_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  warnEnrollFailure(enroll, handle, team, worktree, ctx);
}

export function warnEnrollFailure(out: EnrollOutcome, handle: string, team: string, worktree: string, ctx: EnrollWarnContext): void {
  const root = humanLine(worktree);
  const retry = humanLine(retryCommand(handle, ctx.form));
  if (out.ok) {
    if (!out.skipped || !ctx.enrollExpected) return;
    process.stderr.write(`tap register: warning: ${handle} is registered on team ${team}, but enrolling ${root} in the machine index was skipped (the root stopped qualifying after the seat committed); the registration stands. next: ${enrollSkipAction(retry)}\n`);
    return;
  }
  const detail = humanLine(out.detail);
  process.stderr.write(`tap register: warning: ${handle} is registered on team ${team}, but enrolling ${root} in the machine index failed (${out.kind}): ${detail}; the registration stands. next: ${enrollFailureAction(out.kind, retry)}\n`);
}

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** One shell word that round-trips the value on a single line: bare when safe,
 *  single-quoted otherwise, and ANSI-C quoted when it carries control
 *  characters (CR/LF would split the one-line warning and a flattened value
 *  would no longer be the caller's). */
function shellWord(value: string): string {
  if (SAFE_SHELL_WORD.test(value)) return value;
  if (!CONTROL_CHARS.test(value)) return shellQuote(value);
  const escaped = value.replace(/[\\']/g, (c) => `\\${c}`)
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `$'${escaped}'`;
}

/** The same-seat retry for a committed registration: the handle that
 *  committed plus the caller's original options that are safe to repeat.
 *  Scope consent the same-seat registration needs again (--namespace-crossing,
 *  --override-worktree) and the caller's invocation identity
 *  (--harness-session-id) travel: without them the retry is refused where the
 *  original was not, or re-attributes the seat to an inherited session.
 *  --fresh/--restore are dropped (a committed seat refuses them), as are the
 *  flags that replay an effect or grant one-time consent (--force,
 *  --accept-observed-identity) and the read-only/offline forms that never
 *  reach enrollment. */
function retryCommand(handle: string, form: RegisterForm): string {
  const args: string[] = [handle];
  const value = (flag: string, v: string): void => { if (v !== "") args.push(flag, v); };
  const flag = (name: string, on: boolean): void => { if (on) args.push(name); };
  value("--delivery", form.delivery);
  value("--pane", form.pane);
  value("--team", form.team);
  value("--wake-url", form.wakeUrl);
  value("--reply-to", form.replyTo);
  value("--harness-session-id", form.harnessSessionId);
  if (form.modeSet) value("--mode", form.mode);
  if (form.includeSet) value("--include", form.include);
  value("--digest-window", form.digestWindow);
  flag("--include-asks", form.digestIncludeAsks);
  flag("--unattended", form.unattended);
  flag("--override-worktree", form.overrideWorktree);
  flag("--namespace-crossing", form.namespaceCrossing);
  flag("--crew", form.crew);
  flag("--json", form.json);
  return `tap register ${args.map(shellWord).join(" ")}`;
}

function sameSeatRetry(retry: string): string {
  return `${retry} (same seat, without --fresh or --restore; the committed seat is kept`;
}

function enrollSkipAction(retry: string): string {
  return `check that the worktree is still a top-level git checkout whose bus is its own .tap/bus, then re-run ${sameSeatRetry(retry)}; this retries enrollment)`;
}

function enrollFailureAction(kind: EnrollRefusalKind, retry: string): string {
  switch (kind) {
    case "enroll_retry":
      return `re-run ${sameSeatRetry(retry)}; this retries enrollment)`;
    case "enroll_failed":
      return `fix the condition named above, then re-run ${sameSeatRetry(retry)})`;
    case "temporary_root":
      return "set TAP_INDEX_HOME to a sandbox index and retry";
    case "name_collision":
      return `retire or rename as described above, then re-run ${sameSeatRetry(retry)})`;
    case "invalid_flip":
    case "ambiguous_root":
      return "tap doctor";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function emitPrimer(handle: string, priorExisting: boolean, form: RegisterForm): void {
  if (form.json || form.offline) return;
  if (priorExisting && !form.verbose) return;
  process.stderr.write(`tap register primer: inbox: tap poll ${handle}\n`);
  process.stderr.write(`tap register primer: answer: tap reply <id> -f <file>\n`);
  process.stderr.write(`tap register primer: settle-only/FYI: tap read <id>\n`);
}

function emitVersionBriefing(handle: string, team: string, worktree: string, form: RegisterForm, env: Env): void {
  if (env.TAP_SKIP_VERSION_BRIEFING === "1") return;
  const scriptsDir = env.TAP_SCRIPTS_DIR || REGISTER_SCRIPTS_DIR;
  const installRoot = realOrSelf(join(scriptsDir, "../../.."));
  versionBriefing(installRoot, team, handle, form.json ? { ...env, TAP_VERSION_RECORD_ONLY: "1" } : env);
}
