// Locked stop transaction for the TeamStop engine (U2 of the libsh-bun
// TeamStop ladder). Port of `_tap_team_stop_tx_suspend_kill`
// (skills/tap/scripts/tap-team-stop.sh L23-907 at head abc18451) as one
// function with the six modes full | prepare | cotenant_only | cotenant_kill |
// authorize_only | kill_only. The registry lock, registry reads/writes, event
// appends and the destructive-target verifier are the shared native owners
// (panelock, the spool-publication preserving codec over fsatomic, events,
// lifecycle-target); tmux effects
// arrive through the injected facade so the focused suite runs offline. The
// incumbent's temp-file/env IPC (TAP_TEAM_STOP_ADOPTED*_OUT, strands of the
// plan roster) becomes returned values. No production importer until U4.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { appendRegistryEventOrWarn } from "../events";
import { TapError } from "../context";
import { acquireRegistryLock } from "../panelock";
import { oldStoreRefusalText } from "../register-authority";
import type { Seat } from "../registry";
import { assertSharedStopCleared, quiesceSharedSession } from "../opencode-shared-stop";
import { atomicWrite } from "../fsatomic";
import { codePointCompare, spared } from "./selection";
import { destructiveSessionTarget, type LifecycleTmux } from "../lifecycle-target";
import { crewProcessMatchesRow, parentLifetimeMatchesRow, validateCrewProcess, validateParentHarnessLifetime, type CrewProcess } from "../crew-lifetime";
import { crewFamilyHandles } from "../crew-ownership";
import {
  isDict as pyIsDict,
  jsonDumpBytes,
  metaBytes,
  parseJsonPreserving,
  pyReadUtf8,
  PyFloat,
  PyInt,
} from "../spool-publication";

export type StopTxMode = "full" | "prepare" | "cotenant_only" | "cotenant_kill" | "authorize_only" | "kill_only";

export interface CrewCollected {
  handle: string;
  pane: string;
  parent: string;
}

export type StopTxOutcome =
  | { kind: "refused"; detail: string }
  | { kind: "spared"; detail: string }
  | { kind: "authorized" }
  | { kind: "prepared"; crew: CrewCollected[] }
  | { kind: "killed"; crew: CrewCollected[] }
  /** The kill ran and the session survived (a teammate's kill_only/full; cotenant_kill also rolls its rows back). */
  | { kind: "kill-failed" }
  | { kind: "kill-failed-stranded"; inflightPath: string };

export interface StopTxResult {
  outcome: StopTxOutcome;
  adopted: string[];
  retained: string[];
  unrecorded: string[];
  warnings: string[];
  approvedCrew?: string[];
  approvedCrewInstances?: Array<[string, string]>;
}

export interface StopTxSeatTuple {
  handle: string;
  paneId: string;
  rowSession: string;
  rowEpoch: string;
  expected: string;
}

export interface StopTxEffects {
  tmux: LifecycleTmux;
  killSession(session: string): void;
  hasSession(session: string): boolean;
}

export interface StopTxInput {
  session: string;
  mode: StopTxMode;
  policy: "suspend" | "clear" | "none";
  seats: StopTxSeatTuple[];
  selection: { mode: "" | "--only" | "--except"; set: string[] };
  /** Interactive approval, keyed by selected parent handle and immutable row instance. */
  approvedInstances?: ReadonlyMap<string, string>;
  approvedParentLifetimes?: ReadonlyMap<string, import("../crew-lifetime").ParentHarnessLifetime>;
  approvedCrewAtConsent?: ReadonlyMap<string, { instance: string; session: string }>;
  approvedCrewProcesses?: ReadonlyMap<string, CrewProcess | null>;
  selfHandle: string;
  runId: string;
  selfRowsPath: string;
  /** Durable adopted-seat terminal bridge (allocated live by the caller before
   * any kill). On a proven kill, every adopted (handle, session) fact is
   * appended and fsynced here BEFORE the transaction returns; the caller
   * drains it into killed events and removes the file. ABSENT means no
   * durable record is kept — production callers always pass the live bridge. */
  adoptedBridge?: string;
  registryPath: string;
  eventLog: string;
  team: string;
  verbShort: string;
  effects: StopTxEffects;
}

// Mirror of session/launcher.py STALE_BINDING_KEYS (tap-9tqt A / amendment B):
// one tuple, every strip site. `delivery` is a seat property (poll-ness), NOT
// a pane coordinate, and is never stripped. U2 strips ONLY immediately before
// suspension/stamping; every restoration path reinstates the complete
// captured pre-image instead (astra amendment).
const STALE_BINDING_KEYS = [
  "pane",
  "pane_id",
  "pane_current_command",
  "wake_url",
  "status_reason",
  "exited_at",
] as const;

export function stripStaleBindings(entry: Record<string, unknown>): void {
  for (const key of STALE_BINDING_KEYS) delete entry[key];
}

const pyStr = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type PyDoc = Record<string, unknown>;

/**
 * Deep clone over the stop codec's value domain: PyFloat/PyInt wrappers are
 * immutable and shared; containers rebuild so `structuredClone`'s prototype
 * loss can never strip the wrappers that metaBytes renders from. Keys are
 * defined, not assigned, so a "__proto__" row survives the copy.
 */
function pyClone<T>(value: T): T {
  if (value instanceof PyFloat || value instanceof PyInt) return value;
  if (Array.isArray(value)) return value.map((v) => pyClone(v)) as T;
  if (pyIsDict(value)) {
    const out: PyDoc = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: pyClone(value[key]), writable: true, enumerable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}

/**
 * The incumbent stop writer's codec, narrowed to what this transaction owns:
 * reads are python-faithful (strict UTF-8, NaN/Infinity, `.0` floats, integers
 * past 2^53) and writes re-render the loaded document with
 * `json.dump(indent=2, sort_keys=True)` bytes WITHOUT the registry module's
 * forwarding-alias supersede — team stop rewrites the document it loaded and
 * mutates nothing else. (Review round 1, Critical 2.)
 */
const loadDoc = (path: string): unknown => parseJsonPreserving(pyReadUtf8(path));
const saveDoc = (path: string, doc: PyDoc): void => atomicWrite(path, metaBytes(doc as Parameters<typeof metaBytes>[0]));

function writeJournalSync(jrnPath: string, contents: string): void {
  const tmp = join(dirname(jrnPath), `.tap-journal.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(contents, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, jrnPath);
}

export function outcomeWord(result: StopTxResult): string {
  const crewSuffix = (crew: CrewCollected[]) =>
    crew.length > 0 ? ` crew_collected=${crew.map((c) => `${c.handle}\x1f${c.pane}\x1f${c.parent}`).join(",")}` : "";
  switch (result.outcome.kind) {
    case "refused":
      return `refused:${result.outcome.detail}`;
    case "spared":
      return `spared:${result.outcome.detail}`;
    case "authorized":
      return "authorized";
    case "prepared":
      return `prepared${crewSuffix(result.outcome.crew)}`;
    case "killed":
      return `killed${crewSuffix(result.outcome.crew)}`;
    case "kill-failed":
      return "kill-failed";
    case "kill-failed-stranded":
      return `kill-failed-stranded:${result.outcome.inflightPath}`;
  }
}

export function runStopTx(input: StopTxInput): StopTxResult {
  const { session, mode, policy, effects: fx } = input;
  const path = input.registryPath;
  const adopted: string[] = [];
  let retained: string[] = [];
  const warnings: string[] = [];
  const approvedCrew: string[] = [];
  const approvedCrewInstances: Array<[string, string]> = [];
  const done = (outcome: StopTxOutcome, unrecorded: string[] = []): StopTxResult => ({ outcome, adopted, retained, unrecorded, warnings, approvedCrew, approvedCrewInstances });
  // Durable adopted-seat terminal bridge: on a proven kill, the adopted facts
  // land in the caller's live bridge file (append + fsync) BEFORE the
  // transaction returns, so an interruption after the kill still names the
  // stopped seats. Retention-only or refused adoptions never reach this — a
  // durable killed fact must stay true history. A durable append that fails
  // AFTER the kill cannot invent success: the seats surface through the
  // unrecorded contract instead.
  const recordTerminalAdoptions = (): string[] => {
    if (adopted.length === 0 || !input.adoptedBridge) return [];
    try {
      const fd = openSync(input.adoptedBridge, "a", 0o600);
      try {
        for (const h of adopted) writeSync(fd, Buffer.from(`${h}\x1f${session}\n`, "utf8"));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [...adopted];
    }
    return [];
  };

  if (input.seats.length === 0) return done({ kind: "refused", detail: "no seat authorizes it" });

  // THE TRANSACTION OWNS ITS TUPLE LIST. The incumbent mutates a python-local
  // list; a caller that reuses one array across modes (U4's self path will)
  // must never see a later transaction treat an earlier adoption as plan-time
  // warrant. (Review round 1, Critical 1.)
  const seats: StopTxSeatTuple[] = input.seats.map((t) => ({ ...t }));

  const lock = acquireRegistryLock(path, Infinity);
  if (!lock) {
    throw new TapError(1, "registry_lock_busy", `tap team ${input.verbShort}`, "acting registry is busy; no stop transaction ran", `tap team ${input.verbShort}`);
  }
  try {
    const crewEvent = (action: string, handle: string, pane: string, detail: string): boolean =>
      appendRegistryEventOrWarn(`tap team ${input.verbShort}`, {
        log: input.eventLog,
        actor: `team-${input.verbShort}`,
        action,
        handle,
        pane,
        team: input.team,
        detail,
      });

    let reg: PyDoc | null = null;
    let unreadable = "";
    try {
      const parsed: unknown = loadDoc(path);
      if (pyIsDict(parsed)) reg = parsed;
      // A JSON list/scalar crashes the incumbent child, and the Bash caller
      // normalizes any unrecognized stdout to this parent-visible word.
      else return done({ kind: "refused", detail: "transaction refused" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = msg(e);
    }
    const existed = reg !== null;
    if (reg === null && !unreadable) {
      if (policy === "clear" && (mode === "cotenant_only" || mode === "cotenant_kill")) reg = {};
      else unreadable = "missing";
    }
    if (reg === null) return done({ kind: "refused", detail: `registry unreadable (${unreadable})` });
    const doc = reg;

    // Only a seats map beside no `agents` key is writable: an old, hybrid or
    // axis-less document is refused untouched rather than rewritten.
    if ("agents" in doc) return done({ kind: "refused", detail: oldStoreRefusalText(path, "agents_axis") });
    if (existed && !pyIsDict(doc.seats)) return done({ kind: "refused", detail: "registry has no seats map; it was left untouched" });
    const seatKey = "seats";
    const agentsRaw = doc[seatKey];
    const agents: Record<string, Seat> = pyIsDict(agentsRaw) ? (agentsRaw as Record<string, Seat>) : {};

    if (input.approvedInstances) {
      for (const [handle, instance] of input.approvedInstances) {
        const row = agents[handle];
        if (!pyIsDict(row) || pyStr(row.instance) !== instance) {
          return done({ kind: "refused", detail: `${handle} was replaced after interactive selection` });
        }
      }
    }
    for (const [handle, approved] of input.approvedCrewAtConsent ?? []) {
      if (approved.session !== session) continue;
      const row = agents[handle];
      if (!pyIsDict(row) || row.crew !== true || pyStr(row.instance) !== approved.instance || pyStr(row.session) !== session) {
        return done({ kind: "refused", detail: `${handle} was replaced after interactive crew approval` });
      }
    }

    const approvedFamilyCrew = (handle: string, row: Seat): boolean => {
      if (row.crew !== true || !input.approvedCrewProcesses?.has(handle)) return false;
      const owners = Object.keys(agents).filter(owner => agents[owner]?.crew !== true && crewFamilyHandles(agents, owner).includes(handle));
      if (owners.length !== 1) return false;
      const owner = owners[0]!, parent = agents[owner]!, lifetime = input.approvedParentLifetimes?.get(owner);
      if (lifetime && (!parentLifetimeMatchesRow(lifetime, owner, parent) || !validateParentHarnessLifetime(lifetime))) return false;
      const proof = input.approvedCrewProcesses.get(handle);
      return !!proof && crewProcessMatchesRow(proof, handle, row) && validateCrewProcess(proof);
    };
    if (input.approvedParentLifetimes) {
      for (const tuple of seats) {
        const row = agents[tuple.handle];
        if (pyIsDict(row) && row.crew === true) {
          if (!approvedFamilyCrew(tuple.handle, row)) return done({ kind: "refused", detail: `${tuple.handle} has no approved crew lifetime binding` });
          approvedCrew.push(tuple.handle);
          approvedCrewInstances.push([tuple.handle, pyStr(row.instance)]);
        }
      }
    }

    const authorize = (paneId: string, rowSession: string, rowEpoch: string, expected: string): string | null => {
      const decision = destructiveSessionTarget({ pane_id: paneId, session: rowSession }, expected, fx.tmux);
      return decision.ok ? decision.session : null;
    };

    // Re-authorization under the lock, before any mutation. Skipped for
    // cotenant_only/cotenant_kill: prepare already stripped and stamped these
    // rows, and re-checking pane identity there would fail on the mutation
    // prepare itself made. What can genuinely change afterwards is the
    // CO-TENANT set, which the late recheck below examines under this same
    // lock. (tap-team-stop.sh L152-215.)
    const warrantSeats = mode === "cotenant_only" || mode === "cotenant_kill" ? [] : seats;
    let liveAuthorizers = 0;
    for (const t of warrantSeats) {
      const ent = agents[t.handle];
      if (!pyIsDict(ent)) return done({ kind: "refused", detail: `${t.handle} missing before kill` });
      if (pyStr(ent.delivery) === "poll") continue;
      if (t.paneId && pyStr(ent.pane_id) !== t.paneId) {
        return done({ kind: "refused", detail: `${t.handle} pane identity changed before kill` });
      }
      const got = authorize(
        pyStr(ent.pane_id) || t.paneId,
        pyStr(ent.session) || t.rowSession,
        pyStr(ent.server_epoch) || t.rowEpoch,
        t.expected,
      );
      if (got !== session) return done({ kind: "refused", detail: `${t.handle} no longer authorizes it` });
      liveAuthorizers += 1;
    }
    if (warrantSeats.length > 0 && liveAuthorizers === 0) {
      return done({
        kind: "refused",
        detail: `no live seat authorizes '${session}' any more (every plan-time authorizer is now pane-less)`,
      });
    }

    // The late co-tenant gate and adoption, asked under the lock for EVERY
    // transaction, planned or not, selected or not. The authorizer is the only
    // adoption key. (tap-team-stop.sh L217-368.)
    const planned = new Set(seats.map((t) => t.handle));
    const selection = {
      mode: input.selection.mode,
      except: input.selection.mode === "--except" ? input.selection.set : [],
      only: input.selection.mode === "--only" ? input.selection.set : [],
    };
    for (const h of Object.keys(agents).sort(codePointCompare)) {
      const ent = agents[h]!;
      if (!pyIsDict(ent) || planned.has(h)) continue;
      if ((pyStr(ent.delivery) || "pane") === "poll") continue;
      if ((pyStr(ent.session) || "") !== session) continue;
      if (selection.mode && spared(h, selection)) {
        if (approvedFamilyCrew(h, ent)) {
          approvedCrew.push(h);
          approvedCrewInstances.push([h, pyStr(ent.instance)]);
        } else {
        return done({
          kind: "spared",
          detail: `${h} joined session '${session}' after planning and is spared by ${selection.mode}; killing it would stop a seat the selection excluded`,
        });
        }
      }
      if (authorize(pyStr(ent.pane_id) || "", pyStr(ent.session) || "", pyStr(ent.server_epoch) || "", session) !== session) continue;
      adopted.push(h);
      seats.push({
        handle: h,
        paneId: pyStr(ent.pane_id) || "",
        rowSession: pyStr(ent.session) || session,
        rowEpoch: pyStr(ent.server_epoch) || "",
        expected: "",
      });
      planned.add(h);
    }
    // WRITTEN AT ADOPTION, not at an outcome: the consumer needs the retention
    // record exactly when the transaction does NOT reach a terminal outcome.
    // (tap-team-stop.sh L370-399.)
    retained = [...adopted];

    if (mode !== "authorize_only" && mode !== "cotenant_only") {
      try {
        for (const [handle, row] of Object.entries(agents)) if (row.session === session) {
          const root = pyIsDict(doc.team) && typeof doc.team.worktree_root === "string" ? doc.team.worktree_root : dirname(dirname(path));
          if (input.policy === "clear") assertSharedStopCleared(root, row);
          quiesceSharedSession(row, root, handle);
        }
      } catch (error) { return done({ kind: "refused", detail: error instanceof TapError ? `${error.detail}; next: ${error.action}` : String(error) }); }
    }

    if (mode === "cotenant_only") return done({ kind: "authorized" });

    if (mode === "cotenant_kill") {
      // Stamp the adopted rows — and any plan-time row that re-registered as
      // active in THIS session — before the kill; under clear the truthful
      // record of a stopped row is its deletion. (tap-team-stop.sh L457-569.)
      const parentBySession = new Map<string, string>();
      for (const h of Object.keys(agents).sort(codePointCompare)) {
        const ent = agents[h]!;
        if (pyIsDict(ent) && ent.crew !== true) {
          const s = pyStr(ent.session);
          if (s && !parentBySession.has(s)) parentBySession.set(s, h);
        }
      }
      if (input.selfHandle && !parentBySession.has(session)) parentBySession.set(session, input.selfHandle);
      const stampTargets: string[] = [...adopted];
      for (const t of seats) {
        if (stampTargets.includes(t.handle)) continue;
        const row = agents[t.handle];
        if (pyIsDict(row) && row.status === "active" && (pyStr(row.session) || "") === session) stampTargets.push(t.handle);
      }
      const crewTargets = stampTargets.filter((h) => pyIsDict(agents[h]) && agents[h]!.crew === true).sort(codePointCompare);
      if (crewTargets.length > 0 && !crewEvent("kill-requested", input.selfHandle || "?", session, `crew=${crewTargets.join(",")}`)) {
        return done({ kind: "refused", detail: "kill-requested append failed before crew mutation" });
      }
      const adoptedSnap = new Map<string, Seat>();
      const adoptedGone = new Set<string>();
      const collectedCrew: CrewCollected[] = [];
      for (const ah of stampTargets) {
        const row = agents[ah];
        if (!pyIsDict(row)) continue;
        adoptedSnap.set(ah, pyClone(row));
        if (row.crew === true) {
          collectedCrew.push({ handle: ah, pane: pyStr(row.pane), parent: parentBySession.get(pyStr(row.session)) ?? "" });
          delete agents[ah];
          adoptedGone.add(ah);
          const ai = adopted.indexOf(ah);
          if (ai !== -1) adopted.splice(ai, 1);
        } else if (policy === "clear") {
          delete agents[ah];
          adoptedGone.add(ah);
        } else {
          stripStaleBindings(row);
          row.status = "suspended";
          row.status_reason = "session_stopped";
        }
      }
      try {
        if (policy === "clear" && Object.keys(agents).length === 0) {
          try {
            unlinkSync(path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              doc[seatKey] = agents;
              saveDoc(path, doc);
            }
          }
        } else {
          doc[seatKey] = agents;
          saveDoc(path, doc);
        }
      } catch (exc) {
        if (crewTargets.length > 0) crewEvent("kill-refused", input.selfHandle || "?", session, "reason=registry_save_failed");
        return done({ kind: "refused", detail: `cannot save adopted registry (${msg(exc)})` });
      }

      // Consume the recovery artifact HERE, before the kill: RENAME, not
      // unlink-then-maybe-rewrite, so the evidence survives every failure of
      // the thing it documents. (tap-team-stop.sh L585-621.)
      const inflight = input.selfRowsPath ? `${input.selfRowsPath}.inflight` : "";
      let moved = false;
      if (input.selfRowsPath && existsSync(input.selfRowsPath)) {
        try {
          renameSync(input.selfRowsPath, inflight);
          moved = true;
        } catch (exc) {
          try {
            for (const [h, orig] of adoptedSnap) agents[h] = orig;
            doc[seatKey] = agents;
            saveDoc(path, doc);
            for (const c of collectedCrew) crewEvent("crew_restored", c.handle, c.pane, `reason=self_kill_refused parent=${c.parent}`);
          } catch (restoreError) {
            warnings.push(`adopted row restoration failed (${msg(restoreError)})`);
          }
          return done({ kind: "refused", detail: `cannot stage recovery state (${msg(exc)})` });
        }
      }

      fx.killSession(session);
      if (fx.hasSession(session)) {
        // Undo this branch's stamping under the same lock, before any outcome:
        // a gone row is restored only while still absent, a stamped row only
        // while still stamped, so a concurrent re-registration wins.
        // (tap-team-stop.sh L628-715.)
        if (adoptedSnap.size > 0) {
          let rb: PyDoc | null = null;
          let rbCorrupt = "";
          try {
            const parsed: unknown = loadDoc(path);
            if (pyIsDict(parsed)) rb = parsed;
            else {
              rb = null;
              rbCorrupt = "registry is not a JSON object";
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              rb = null;
              rbCorrupt = msg(e);
            }
          }
          if (rbCorrupt) {
            warnings.push(
              `rollback of the adopted rows was NOT applied: the registry is present but unreadable (${rbCorrupt}); it was left untouched and these rows may still be missing: ${[...adoptedSnap.keys()].sort(codePointCompare).join(", ")}`,
            );
          } else {
            try {
              const rbk = seatKey;
              if (rb === null) rb = pyClone(doc);
              const rbDoc = rb as Record<string, unknown>;
              if ("agents" in rbDoc) throw new Error(oldStoreRefusalText(path, "agents_axis"));
              const rbaRaw = rbDoc[rbk];
              const rba: Record<string, Seat> = pyIsDict(rbaRaw) ? (rbaRaw as Record<string, Seat>) : {};
              const restoredCrew: CrewCollected[] = [];
              for (const [ah, orig] of adoptedSnap) {
                const cur = rba[ah];
                if (adoptedGone.has(ah)) {
                  if (cur === undefined) {
                    rba[ah] = orig;
                    if (pyIsDict(orig) && orig.crew === true) {
                      restoredCrew.push({ handle: ah, pane: pyStr(orig.pane), parent: parentBySession.get(pyStr(orig.session)) ?? "" });
                    }
                  }
                  continue;
                }
                if (pyIsDict(cur) && cur.status === "suspended" && cur.status_reason === "session_stopped") rba[ah] = orig;
              }
              rbDoc[rbk] = rba;
              saveDoc(path, rbDoc);
              for (const rc of restoredCrew) crewEvent("crew_restored", rc.handle, rc.pane, `reason=self_kill_failed parent=${rc.parent}`);
            } catch (rbexc) {
              warnings.push(
                `rollback of the adopted rows FAILED (${msg(rbexc)}); these rows may still be missing or wrongly stamped: ${[...adoptedSnap.keys()].sort(codePointCompare).join(", ")}`,
              );
            }
          }
        }
        if (moved) {
          try {
            renameSync(inflight, input.selfRowsPath);
          } catch {
            return done({ kind: "kill-failed-stranded", inflightPath: inflight });
          }
        }
        return done({ kind: "kill-failed" });
      }
      return done({ kind: "killed", crew: [] }, recordTerminalAdoptions());
    }

    if (mode === "authorize_only") return done({ kind: "authorized" });

    if (mode === "kill_only") {
      fx.killSession(session);
      if (fx.hasSession(session)) {
        return done({ kind: "kill-failed" });
      }
      return done({ kind: "killed", crew: [] }, recordTerminalAdoptions());
    }

    // full | prepare: strip-then-stamp is load-bearing order (tap-9tqt A).
    // Crew rows are deleted (up/resume-all excludes them); the capture carries
    // (handle, old_pane, parent) for events emitted after the save.
    const snap = new Map<string, Seat>();
    for (const t of seats) {
      const ent = agents[t.handle];
      if (pyIsDict(ent)) snap.set(t.handle, pyClone(ent));
    }
    const collectedCrew: CrewCollected[] = [];
    let parentForSession = "";
    for (const t of seats) {
      const ent = agents[t.handle];
      if (!pyIsDict(ent) || ent.delivery === "poll") continue;
      if (ent.crew !== true && !parentForSession) parentForSession = t.handle;
    }
    for (const t of seats) {
      const ent = agents[t.handle];
      if (!pyIsDict(ent) || ent.delivery === "poll") continue;
      if (ent.crew === true) {
        collectedCrew.push({ handle: t.handle, pane: pyStr(ent.pane), parent: parentForSession });
        delete agents[t.handle];
        continue;
      }
      stripStaleBindings(ent);
      ent.status = "suspended";
      ent.status_reason = "session_stopped";
    }
    doc[seatKey] = agents;

    if (mode === "prepare") {
      // One journal file, both images, written and fsynced BEFORE the registry
      // changes; if it cannot be published the mutation must not happen at
      // all. (tap-team-stop.sh L803-876.)
      const crewParents = new Map(collectedCrew.map((c) => [c.handle, c.parent]));
      const post: Record<string, unknown> = {};
      for (const h of snap.keys()) {
        const cur = agents[h];
        if (pyIsDict(cur)) post[h] = cur;
        else if (crewParents.has(h)) post[h] = { _crew_deleted: true, parent: crewParents.get(h) };
      }
      if (!input.runId) return done({ kind: "refused", detail: "no run id for the rollback journal" });
      const jrnPath = `${path}.self-last-journal.${input.runId}.json`;
      try {
        writeJournalSync(jrnPath, jsonDumpBytes({ pre: Object.fromEntries(snap), post }));
      } catch (exc) {
        return done({ kind: "refused", detail: `cannot publish rollback journal (${msg(exc)})` });
      }
      if (
        collectedCrew.length > 0 &&
        !crewEvent(
          "kill-requested",
          input.selfHandle || parentForSession || "?",
          session,
          `crew=${collectedCrew.map((c) => c.handle).sort(codePointCompare).join(",")}`,
        )
      ) {
        try {
          unlinkSync(jrnPath);
        } catch {
          // The journal refusal below is the disclosure; a failed unlink of
          // the artifact we just published cannot add to it.
        }
        return done({ kind: "refused", detail: "kill-requested append failed before prepared crew mutation" });
      }
      try {
        saveDoc(path, doc);
      } catch (exc) {
        if (collectedCrew.length > 0) {
          crewEvent("kill-refused", input.selfHandle || parentForSession || "?", session, "reason=registry_save_failed");
        }
        return done({ kind: "refused", detail: `cannot save prepared registry (${msg(exc)})` });
      }
      return done({ kind: "prepared", crew: collectedCrew });
    }

    saveDoc(path, doc);
    fx.killSession(session);
    if (fx.hasSession(session)) {
      // Exact prior objects — safe because the lock was held for the whole
      // kill window, so no concurrent writer could have edited these rows.
      // The complete pre-image comes back, stale bindings included (astra
      // amendment: never strip during restoration). (tap-team-stop.sh L885-893.)
      for (const [h, ent] of snap) agents[h] = ent;
      doc[seatKey] = agents;
      saveDoc(path, doc);
      return done({ kind: "kill-failed" });
    }
    return done({ kind: "killed", crew: collectedCrew }, recordTerminalAdoptions());
  } finally {
    lock.release();
  }
}
