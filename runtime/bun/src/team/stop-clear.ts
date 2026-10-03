// Clear / restore / rollback for the TeamStop engine (U3 of the libsh-bun
// TeamStop ladder). Port of `_tap_team_stop_clear_registry`,
// `_tap_team_stop_restore_self_rows`, `_tap_team_stop_rollback_self_snap`,
// `_tap_team_stop_clear_self_snap`, `_tap_team_stop_emit_crew_restored` and
// the proof-based `_tap_team_stop_reap_artifact` behavior
// (skills/tap/scripts/tap-team-stop.sh at the landed H1 base). The registry
// lock, preserving JSON codec, atomic writer and event writer are the shared
// native owners (panelock, spool-publication over fsatomic, events); the
// incumbent's file/env IPC (keep file, caller-handle list, late-seat buffer,
// crew_collected stderr lines) becomes values. Restoration NEVER strips stale
// bindings — stripping belongs to U2's suspension path alone (astra
// amendment). No production importer until U4.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { appendRegistryEventOrWarn } from "../events";
import { atomicWrite } from "../fsatomic";
import { acquireRegistryLock } from "../panelock";
import { oldStoreRefusalText } from "../register-authority";
import {
  isDict as pyIsDict,
  jsonDumpBytes,
  metaBytes,
  parseJsonPreserving,
  pyReadUtf8,
  PyFloat,
  PyInt,
} from "../spool-publication";
import { codePointCompare } from "./selection";
import type { CrewCollected } from "./stop-tx";

export type { CrewCollected };

export interface LateSparedRow {
  handle: string;
  session: string;
}

const pyStr = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type PyDoc = Record<string, unknown>;

const loadDoc = (path: string): unknown => parseJsonPreserving(pyReadUtf8(path));
const saveDoc = (path: string, doc: PyDoc): void => atomicWrite(path, metaBytes(doc as Parameters<typeof metaBytes>[0]));

/** mktemp-and-replace: the incumbent's capture/journal publication — write a
 * unique temp beside the destination, fsync, rename over it. */
function tempWriteReplace(dir: string, prefix: string, contents: string, dest: string): void {
  const tmp = join(dir || ".", `${prefix}${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(contents, "utf8"));
    fsyncSync(fd);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // the throw below is the disclosure
    }
    throw e;
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
}

/**
 * The recovery artifact slot: `$TAP_HOME/recovery/self-row-XXXXXX`, created
 * exclusive at mode 0600 like the incumbent's mktemp. Null means the caller
 * refuses the clear (`recovery_unavailable`): already-stopped sessions are
 * named and the registry is retained. (tap-team-stop.sh L2563-2573.)
 */
export function allocateRecoveryArtifact(tapHome: string): string | null {
  const dir = join(tapHome, "recovery");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 16; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const path = join(dir, `self-row-${suffix}`);
    try {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
  }
  return null;
}

export interface ClearRegistryInput {
  registryPath: string;
  tapHome: string;
  keepSet: readonly string[];
  /**
   * ABSENT vs SUPPLIED-EMPTY are different inputs, exactly like the
   * incumbent's missing vs empty caller-handles file: absent means this clear
   * has no caller-recovery phase at all (the zero-row caller), a supplied
   * empty list fails closed. (tap-team-stop.sh L1246-1258.)
   */
  selfHandles?: readonly string[];
  recoveryOut: string;
  selection: { mode: "" | "--only" | "--except"; set: readonly string[] };
  approvedInstances?: ReadonlyMap<string, string>;
  approvedCrewInstances?: ReadonlyMap<string, string>;
  selfSession: string;
}

export type ClearRegistryResult =
  | { ok: true; deletedCrew: CrewCollected[]; lateSpared: LateSparedRow[]; generationConsumed: boolean }
  | { ok: false; cls: 1 | 4 | 5; detail: string };

function consumeResetGeneration(tapHome: string): { consumed: boolean; error: string } {
  try {
    unlinkSync(join(tapHome, "reset-generation.json"));
    return { consumed: true, error: "" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { consumed: false, error: "" };
    // A reset generation that exists but cannot be removed is a clear
    // FAILURE, never a raw throw: by the delete path the teammate sessions
    // are already stopped and the recovery rows captured, so the caller owes
    // the structured partial/refusal receipt, not an unstructured exception.
    return { consumed: false, error: msg(e) };
  }
}

/** Record the caller rows this clear is about to DELETE, and fail closed.
 * Runs inside the lock that deletes them, BEFORE the reset generation is
 * consumed or the registry is removed: a capture that failed while the delete
 * proceeded is the one outcome this subsystem exists to prevent.
 * (tap-team-stop.sh L1264-1312.) */
function captureRecovery(
  recoveryOut: string,
  selfHandles: readonly string[],
  envelope: PyDoc,
  agents: Record<string, unknown>,
  retained: ReadonlySet<string>,
): void {
  if (!recoveryOut || selfHandles.length === 0) return;
  const saved: Record<string, unknown> = {};
  for (const h of selfHandles) {
    if (retained.has(h)) continue;
    const row = agents[h];
    if (pyIsDict(row)) saved[h] = row;
  }
  const payload = {
    team: envelope.team ?? null,
    schema: envelope.schema ?? null,
    rows: saved,
  };
  tempWriteReplace(dirname(recoveryOut), ".tap-recover.", jsonDumpBytes(payload), recoveryOut);
}

function collectDeletedCrew(agents: Record<string, unknown>, retained: ReadonlySet<string>): CrewCollected[] {
  const out: CrewCollected[] = [];
  const sorted = Object.keys(agents).sort(codePointCompare);
  for (const h of sorted) {
    const ent = agents[h];
    if (!pyIsDict(ent) || (ent as PyDoc).crew !== true) continue;
    if (retained.has(h)) continue;
    const row = ent as PyDoc;
    const session = pyStr(row.session);
    let parent = "";
    for (const ph of sorted) {
      const pe = agents[ph];
      if (pyIsDict(pe) && (pe as PyDoc).crew !== true && pyStr((pe as PyDoc).session) === session) {
        parent = ph;
        break;
      }
    }
    out.push({ handle: h, pane: pyStr(row.pane), parent });
  }
  return out;
}

/**
 * Port of `_tap_team_stop_clear_registry` (tap-team-stop.sh L1233-1566).
 * Empty caller handles fail closed (class 4) before anything moves; an
 * unreadable or non-object registry — including a present seat axis of the
 * wrong type — is RETAINED and classified 5. Capture precedes both the
 * reset-generation consumption and the deletion. The `.lock` sidecar is never
 * removed (unlink-after-release splits queued writers across inodes).
 */
export function clearRegistry(input: ClearRegistryInput): ClearRegistryResult {
  if (!input.registryPath) return { ok: true, deletedCrew: [], lateSpared: [], generationConsumed: false };
  if (input.selfHandles !== undefined && input.selfHandles.length === 0) {
    return { ok: false, cls: 4, detail: "caller handle list is empty; refusing to clear without recovery state" };
  }
  // THE CLEAR OWNS ITS HANDLE LIST: the caller-session widening below must not
  // leak into the caller's array (U2 round 1, Critical 1). Absent handles
  // start from nothing — only session widening can add rows, and capture
  // stays a no-op while the set is empty.
  const selfHandles = input.selfHandles === undefined ? [] : [...new Set(input.selfHandles)];
  const keep = new Set(input.keepSet);
  const lock = acquireRegistryLock(input.registryPath, Infinity);
  if (!lock) return { ok: false, cls: 1, detail: "acting registry is busy; nothing was cleared" };
  try {
    if (!existsSync(input.registryPath)) {
      if (input.approvedInstances?.size || input.approvedCrewInstances?.size) return { ok: false, cls: 1, detail: "selected registry disappeared before clear" };
      let generationConsumed = false;
      if (keep.size === 0 && input.tapHome) {
        const gen = consumeResetGeneration(input.tapHome);
        if (gen.error) return { ok: false, cls: 1, detail: `could not consume reset-generation.json (${gen.error}); nothing was cleared` };
        generationConsumed = gen.consumed;
      }
      return { ok: true, deletedCrew: [], lateSpared: [], generationConsumed };
    }
    // PARSE ONCE, for every run, before anything branches on the selection:
    // being a mapping is part of parsing, and a present axis of the wrong
    // type is corruption, not emptiness. (tap-team-stop.sh L1358-1412.)
    let unreadable = false;
    let parsed: unknown = null;
    try {
      parsed = loadDoc(input.registryPath);
      if (!pyIsDict(parsed)) unreadable = true;
      else {
        const doc = parsed as PyDoc;
        for (const axis of ["seats", "agents"]) {
          if (axis in doc && !pyIsDict(doc[axis])) {
            unreadable = true;
            break;
          }
        }
      }
    } catch {
      unreadable = true;
    }
    if (unreadable) return { ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" };
    const doc = parsed as PyDoc;
    // Only a seats map beside no `agents` key is writable. Both the DELETE and
    // FILTER paths start here, so an old, hybrid or axis-less registry is
    // retained untouched before any capture, generation consume or unlink.
    if ("agents" in doc) {
      return { ok: false, cls: 5, detail: `${oldStoreRefusalText(input.registryPath, "agents_axis")}; retained without clearing` };
    }
    if (!pyIsDict(doc.seats)) return { ok: false, cls: 5, detail: "registry has no seats map; retained without clearing" };
    const current = doc.seats as Record<string, unknown>;
    const selectedChanged = (seats: Record<string, unknown>): string => {
      for (const [handle, instance] of [...(input.approvedInstances ?? []), ...(input.approvedCrewInstances ?? [])]) {
        const row = seats[handle];
        if (!pyIsDict(row) || pyStr((row as PyDoc).instance) !== instance) return handle;
      }
      return "";
    };
    const changed = selectedChanged(current);
    if (changed) return { ok: false, cls: 1, detail: `selected seat '${changed}' was replaced before clear; registry retained` };

    // Classify the CURRENT rows against the selection: "the plan spared
    // nobody" and "nobody should be spared now" are statements about different
    // moments. (tap-team-stop.sh L1414-1441.)
    const lateSpared: LateSparedRow[] = [];
    if (input.selection.mode) {
      const set = new Set(input.selection.set);
      for (const h of Object.keys(current)) {
        const isSpared = input.selection.mode === "--only" ? !set.has(h) : set.has(h);
        if (!isSpared) continue;
        const row = current[h];
        const delivery = pyIsDict(row) ? pyStr((row as PyDoc).delivery) || "pane" : "pane";
        // Delivery before the stamp: a poll row can carry a stale session from
        // an earlier life as a pane seat.
        const session = delivery === "poll" ? "" : pyStr(pyIsDict(row) ? (row as PyDoc).session : "");
        lateSpared.push({ handle: h, session });
      }
      lateSpared.sort((a, b) => codePointCompare(a.handle, b.handle));
    }

    // WIDEN the captured set once, before either capture site: a row that
    // becomes a co-tenant of the caller's session after planning dies with the
    // clear, so a failed self kill has to restore it too. Poll rows are their
    // own delivery and are never widened in. (tap-team-stop.sh L1443-1467.)
    if (input.selfSession) {
      for (const [h, row] of Object.entries(current)) {
        if (!pyIsDict(row)) continue;
        if ((pyStr((row as PyDoc).delivery) || "pane") === "poll") continue;
        if (pyStr((row as PyDoc).session) === input.selfSession && !selfHandles.includes(h)) selfHandles.push(h);
      }
    }

    const effectiveKeep = new Set(keep);
    if (effectiveKeep.size === 0) for (const l of lateSpared) effectiveKeep.add(l.handle);

    if (effectiveKeep.size === 0) {
      // DELETE path. Capture FIRST — a raise here aborts the clear with the
      // registry still intact; no recovery state means no safe deletion. The
      // fresh read mirrors the parse-once guard: ONLY an already-absent
      // registry is empty. A parse failure, a non-object root, or a
      // present-but-wrong-type axis means recovery could not capture the
      // current bytes — the clear refuses and the registry is retained.
      let envelope: PyDoc = {};
      let deleteAgents: Record<string, unknown> = {};
      try {
        const fresh = loadDoc(input.registryPath);
        if (!pyIsDict(fresh)) {
          return { ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" };
        }
        envelope = fresh as PyDoc;
        for (const a of ["seats", "agents"] as const) {
          if (a in envelope && !pyIsDict(envelope[a])) {
            return { ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" };
          }
        }
        // Recovery captures only `seats` rows, so an old agents-axis registry is
        // retained rather than deleted with its rows uncaptured.
        if ("agents" in envelope) {
          return { ok: false, cls: 5, detail: `${oldStoreRefusalText(input.registryPath, "agents_axis")}; retained without clearing` };
        }
        if (!pyIsDict(envelope.seats)) return { ok: false, cls: 5, detail: "registry has no seats map; retained without clearing" };
        deleteAgents = envelope.seats as Record<string, unknown>;
        const freshChanged = selectedChanged(deleteAgents);
        if (freshChanged) return { ok: false, cls: 1, detail: `selected seat '${freshChanged}' was replaced before clear; registry retained` };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" };
        }
        envelope = {};
      }
      try {
        captureRecovery(input.recoveryOut, selfHandles, envelope, deleteAgents, new Set());
      } catch (e) {
        return { ok: false, cls: 1, detail: msg(e) };
      }
      const deletedCrew = collectDeletedCrew(deleteAgents, new Set());
      let generationConsumed = false;
      if (input.tapHome) {
        const gen = consumeResetGeneration(input.tapHome);
        if (gen.error) return { ok: false, cls: 1, detail: `could not consume reset-generation.json (${gen.error}); the registry was retained` };
        generationConsumed = gen.consumed;
      }
      try {
        unlinkSync(input.registryPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, cls: 1, detail: msg(e) };
      }
      return { ok: true, deletedCrew, lateSpared, generationConsumed };
    }

    // FILTER path.
    let reg: PyDoc;
    try {
      const fresh = loadDoc(input.registryPath);
      if (!pyIsDict(fresh)) return { ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" };
      reg = fresh as PyDoc;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, deletedCrew: [], lateSpared, generationConsumed: false };
      }
      return { ok: false, cls: 1, detail: msg(e) };
    }
    // Only a seats map beside no `agents` key is writable: anything else is retained untouched.
    if ("agents" in reg) {
      return { ok: false, cls: 5, detail: `${oldStoreRefusalText(input.registryPath, "agents_axis")}; retained without clearing` };
    }
    if (!pyIsDict(reg.seats)) return { ok: false, cls: 5, detail: "registry has no seats map; retained without clearing" };
    const seatKey = "seats";
    const agents = (pyIsDict(reg[seatKey]) ? reg[seatKey] : {}) as Record<string, unknown>;
    const freshChanged = selectedChanged(agents);
    if (freshChanged) return { ok: false, cls: 1, detail: `selected seat '${freshChanged}' was replaced before clear; registry retained` };
    const retain = new Set([...effectiveKeep].filter(h => h in agents));
    if (input.selection.mode) {
      const set = new Set(input.selection.set);
      for (const h of Object.keys(agents)) {
        if (retain.has(h)) continue;
        if (input.selection.mode === "--only" ? !set.has(h) : set.has(h)) retain.add(h);
      }
    }
    try {
      captureRecovery(input.recoveryOut, selfHandles, reg, agents, retain);
    } catch (e) {
      return { ok: false, cls: 1, detail: msg(e) };
    }
    const deletedCrew = collectDeletedCrew(agents, retain);
    const survivors: Record<string, unknown> = {};
    for (const h of [...retain].sort(codePointCompare)) survivors[h] = agents[h];
    reg[seatKey] = survivors;
    try {
      saveDoc(input.registryPath, reg);
    } catch (e) {
      return { ok: false, cls: 1, detail: msg(e) };
    }
    return { ok: true, deletedCrew, lateSpared, generationConsumed: false };
  } finally {
    lock.release();
  }
}

export interface RestoreSelfRowsInput {
  registryPath: string;
  rowsFile: string;
}

export type RestoreSelfRowsResult =
  | { ran: false }
  | { ran: true; ok: true }
  | { ran: true; ok: false; rc: 2 | 3 | 4; detail: string };

/**
 * Port of `_tap_team_stop_restore_self_rows` (tap-team-stop.sh L1137-1230).
 * Rebuilds ONLY an absent registry, carrying the captured schema/team/seat-axis
 * envelope; a present corrupt or non-object registry is never overwritten
 * (rc 3). Fills absent rows only (setdefault). The recovery artifact is
 * unlinked by the CALLER contract only after the atomic replacement succeeds —
 * this function removes it on success and leaves it on every failure.
 * Restoration copies captured rows verbatim: stale bindings come back
 * (stripping belongs to U2's suspension alone).
 */
export function restoreSelfRows(input: RestoreSelfRowsInput): RestoreSelfRowsResult {
  if (!input.registryPath || !input.rowsFile || !existsSync(input.rowsFile)) return { ran: false };
  let payload: unknown;
  try {
    payload = loadDoc(input.rowsFile);
  } catch (e) {
    return { ran: true, ok: false, rc: 2, detail: `recovery state unreadable (${msg(e)})` };
  }
  if (!pyIsDict(payload)) return { ran: true, ok: false, rc: 2, detail: "recovery state malformed" };
  const p = payload as PyDoc;
  if (!("rows" in p)) return { ran: true, ok: false, rc: 2, detail: "recovery state malformed: no rows key" };
  if (!pyIsDict(p.rows)) return { ran: true, ok: false, rc: 2, detail: "recovery state malformed: rows is not an object" };
  const rows = p.rows as Record<string, unknown>;
  if (Object.keys(rows).length === 0) {
    // Explicitly nothing was deleted. The incumbent's wrapper removes the
    // artifact on every rc-0 return, empty rows included.
    try {
      unlinkSync(input.rowsFile);
    } catch {
      // success stands
    }
    return { ran: true, ok: true };
  }
  mkdirSync(dirname(input.registryPath) || ".", { recursive: true });
  const lock = acquireRegistryLock(input.registryPath, Infinity);
  if (!lock) return { ran: true, ok: false, rc: 4, detail: "acting registry is busy" };
  try {
    let reg: PyDoc;
    try {
      const fresh = loadDoc(input.registryPath);
      if (!pyIsDict(fresh)) {
        return { ran: true, ok: false, rc: 3, detail: "registry present but not an object; refusing to overwrite" };
      }
      reg = fresh as PyDoc;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ran: true, ok: false, rc: 3, detail: `registry present but unreadable (${msg(e)}); refusing to overwrite` };
      }
      // ONLY the absent case rebuilds, from the captured envelope rather than a
      // bare skeleton — a provenance-empty envelope is itself data loss. The
      // rebuilt document is always the current format.
      reg = { schema: "0.20" };
      if (pyIsDict(p.team)) reg.team = p.team;
      reg.seats = {};
    }
    if ("agents" in reg) {
      return { ran: true, ok: false, rc: 3, detail: `${oldStoreRefusalText(input.registryPath, "agents_axis")}; refusing to overwrite` };
    }
    if (!pyIsDict(reg.seats)) return { ran: true, ok: false, rc: 3, detail: "registry has no seats map; refusing to overwrite" };
    const key = "seats";
    const agents = (pyIsDict(reg[key]) ? reg[key] : {}) as Record<string, unknown>;
    for (const [h, row] of Object.entries(rows)) {
      // Own-property semantics: a valid handle such as "constructor" must not
      // read as present through Object.prototype, or the captured caller row
      // is silently skipped and the only copy of it deleted.
      if (!Object.hasOwn(agents, h)) agents[h] = row;
    }
    reg[key] = agents;
    try {
      saveDoc(input.registryPath, reg);
    } catch (e) {
      return { ran: true, ok: false, rc: 4, detail: `could not write restored registry (${msg(e)})` };
    }
    try {
      unlinkSync(input.rowsFile);
    } catch {
      // The row is restored; a failed unlink of the spent artifact must not
      // turn success into failure.
    }
    return { ran: true, ok: true };
  } finally {
    lock.release();
  }
}

/** Python `==` over the preserving codec's value domain: wrappers unwrap,
 * bool is a number (True == 1), int == float compares by value, NaN is
 * unequal to everything including itself, containers compare pairwise. This
 * is the rollback OWNERSHIP test — the exact semantic the incumbent's
 * `cur == post[handle]` gives a live python dict. */
function pyEquals(a: unknown, b: unknown): boolean {
  // python `int == float` compares exact mathematical values: the FLOAT is
  // never rounded into the int's precision, and the INT is never rounded into
  // the float's. BigInt carries the int side; a float meets an int only when
  // it is integral-valued AND its exact double value equals that BigInt.
  // (Adjacent wide ints 9007199254740992 / 9007199254740993 differ; the
  // Number() conversion used to erase exactly this boundary — review round 1,
  // Critical 2.)
  const side = (v: unknown): { int: bigint } | { float: number } | null => {
    if (v instanceof PyInt) return { int: BigInt(v.source) };
    if (v instanceof PyFloat) return { float: v.value };
    if (typeof v === "number") return Number.isInteger(v) ? { int: BigInt(v) } : { float: v };
    if (typeof v === "boolean") return { int: v ? 1n : 0n };
    return null;
  };
  const na = side(a);
  const nb = side(b);
  if (na !== null && nb !== null) {
    const ia = "int" in na ? na.int : null;
    const ib = "int" in nb ? nb.int : null;
    if (ia !== null && ib !== null) return ia === ib;
    if (ia === null && ib === null) {
      return (na as { float: number }).float === (nb as { float: number }).float;
    }
    const i = ia !== null ? ia : (ib as bigint);
    const f = ia !== null ? (nb as { float: number }).float : (na as { float: number }).float;
    return Number.isInteger(f) && BigInt(f) === i;
  }
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => pyEquals(v, b[i]));
  if (pyIsDict(a) && pyIsDict(b)) {
    const ka = Object.keys(a as PyDoc);
    const kb = Object.keys(b as PyDoc);
    if (ka.length !== kb.length) return false;
    return ka.every(k => k in (b as PyDoc) && pyEquals((a as PyDoc)[k], (b as PyDoc)[k]));
  }
  return false;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (v instanceof PyFloat) return "float";
  if (v instanceof PyInt) return "int";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (pyIsDict(v)) return "dict";
  return "object";
}

export interface RollbackSelfSnapInput {
  registryPath: string;
  runId: string;
}

export type RollbackSelfSnapResult =
  | { ran: false }
  | { ran: true; ok: true; crewRestored: CrewCollected[] }
  | { ran: true; ok: false; rc: 1 | 3 | 4; detail: string; journalPath: string };

/**
 * Port of `_tap_team_stop_rollback_self_snap` (tap-team-stop.sh L908-1013).
 * ONE rollback invariant: restore exactly the mutations THIS RUN made, and
 * nothing else — a row is restored from the journal's pre-image only while the
 * current row still equals this run's post-image, so a concurrent
 * re-registration wins; a crew row deleted by prepare comes back only while
 * still absent. A journal that exists but cannot be used is class 3 and is
 * RETAINED; an unusable registry or seat axis is class 4 and the journal is
 * RETAINED. The journal is unlinked only after a completed rollback.
 */
export function rollbackSelfSnap(input: RollbackSelfSnapInput): RollbackSelfSnapResult {
  const jrn = `${input.registryPath}.self-last-journal.${input.runId}.json`;
  if (!existsSync(jrn)) return { ran: false };
  const retained = (rc: 3 | 4, detail: string): RollbackSelfSnapResult => ({ ran: true, ok: false, rc, detail, journalPath: jrn });
  let journal: unknown;
  try {
    journal = loadDoc(jrn);
  } catch (e) {
    return retained(3, `rollback journal unreadable (${msg(e)}); the suspend was NOT rolled back and the journal is retained at ${jrn}`);
  }
  if (!pyIsDict(journal) || !pyIsDict((journal as PyDoc).pre) || !pyIsDict((journal as PyDoc).post)) {
    return retained(3, `rollback journal is malformed; the suspend was NOT rolled back and the journal is retained at ${jrn}`);
  }
  const pre = (journal as PyDoc).pre as Record<string, unknown>;
  const post = (journal as PyDoc).post as Record<string, unknown>;
  const lock = acquireRegistryLock(input.registryPath, Infinity);
  if (!lock) return retained(4, "acting registry is busy");
  try {
    let reg: PyDoc | null = null;
    let readDetail = "";
    try {
      const parsed = loadDoc(input.registryPath);
      if (pyIsDict(parsed)) reg = parsed as PyDoc;
      else readDetail = "registry is not a JSON object";
    } catch (e) {
      readDetail = msg(e);
    }
    if (reg === null) {
      return retained(4, `the registry could not be read at rollback (${readDetail}); the suspend was NOT rolled back and the journal is retained at ${jrn}`);
    }
    // THE AXIS PROBE HAS TO BE THE GUARD: a registry whose seat map is a list,
    // or absent entirely, cannot receive a restore. (tap-team-stop.sh
    // L933-950.)
    const seatKey = pyIsDict(reg.seats) && !("agents" in reg) ? "seats" : null;
    if (seatKey === null) {
      const present = (["seats", "agents"] as const).filter(a => a in reg!);
      const found =
        present.length === 0
          ? "neither key"
          : `{${present.map(a => `'${a}': '${pyTypeName((reg as PyDoc)[a])}'`).join(", ")}}`;
      return retained(
        4,
        `the registry has no usable seat map at rollback (found ${found}); the suspend was NOT rolled back and the journal is retained at ${jrn}`,
      );
    }
    const agents = reg[seatKey] as Record<string, unknown>;
    const crewRestored: CrewCollected[] = [];
    for (const [h, ent] of Object.entries(pre)) {
      const postEnt = post[h];
      if (pyIsDict(postEnt) && (postEnt as PyDoc)._crew_deleted) {
        if (!(h in agents)) {
          agents[h] = ent;
          crewRestored.push({
            handle: h,
            pane: pyStr(pyIsDict(ent) ? (ent as PyDoc).pane : ""),
            parent: pyStr((postEnt as PyDoc).parent),
          });
        }
        continue;
      }
      const cur = agents[h];
      if (!pyIsDict(cur)) continue;
      if (h in post && pyEquals(cur, postEnt)) agents[h] = ent;
    }
    reg[seatKey] = agents;
    try {
      saveDoc(input.registryPath, reg);
    } catch (e) {
      return { ran: true, ok: false, rc: 1, detail: msg(e), journalPath: jrn };
    }
    // Removed only after the rollback COMPLETED. Unlinking earlier destroys
    // the only record of a mutation still in effect.
    try {
      unlinkSync(jrn);
    } catch {
      // The rollback is complete; a failed unlink of the spent journal must
      // not turn success into failure.
    }
    return { ran: true, ok: true, crewRestored };
  } finally {
    lock.release();
  }
}

/** This run's journal only. A concurrent prepare owns its own run-id-named
 * file and must not have its rollback state deleted by ours.
 * (tap-team-stop.sh L1024-1028.) */
export function clearSelfSnap(registryPath: string, runId: string): void {
  try {
    unlinkSync(`${registryPath}.self-last-journal.${runId}.json`);
  } catch {
    // Absent is fine; this is cleanup.
  }
}

/** Compensating crew_restored events after a rollback returns.
 * (tap-team-stop.sh L1015-1022.) */
export function emitCrewRestored(input: { verb: string; eventLog: string; team: string; rows: readonly CrewCollected[] }): void {
  for (const row of input.rows) {
    if (!row.handle) continue;
    appendRegistryEventOrWarn(`tap team ${input.verb}`, {
      log: input.eventLog,
      actor: `team-${input.verb}`,
      action: "crew_restored",
      handle: row.handle,
      pane: row.pane,
      team: input.team,
      detail: `reason=self_kill_failed parent=${row.parent}`,
    });
  }
}

export interface ReapArtifactInput {
  path: string;
  restoreRan: boolean;
  restoreRc: number;
}

/**
 * Proof-based artifact disposal. An artifact is RESOLVED when the restore
 * succeeded, or when it never held anything to recover (an empty stub).
 * RESTORE-NOT-RUN IS NOT RESTORE-SUCCESS: unresolved nonempty evidence
 * survives; empty stubs may go; a successful restore removes the base and the
 * `.inflight` copy. (tap-team-stop.sh L3197-3226.)
 */
export function reapArtifact(input: ReapArtifactInput): void {
  if (!input.path) return;
  const inflight = `${input.path}.inflight`;
  const isStub = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).size === 0;
    } catch {
      return false;
    }
  };
  if (!input.restoreRan || input.restoreRc !== 0) {
    if (isStub(input.path)) {
      try {
        unlinkSync(input.path);
      } catch {
        // best-effort stub cleanup
      }
    }
    if (isStub(inflight)) {
      try {
        unlinkSync(inflight);
      } catch {
        // best-effort stub cleanup
      }
    }
    return;
  }
  try {
    unlinkSync(input.path);
  } catch {
    // absent is fine
  }
  try {
    unlinkSync(inflight);
  } catch {
    // absent is fine
  }
}
