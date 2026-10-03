// Dead letters (tap-s1dqn, tap-sr6da, tap-bm4om): unsettled canonical mail
// whose addressee positive evidence shows is gone, so nobody can ever settle it.
//
// One classifier serves three callers — `tap health` (which counts dead letters
// apart from actionable mail), retirement (`tap out`, which disposes the
// retiring seat's inbound), and the operator sweep (`tap cancel --dead-letters`).
// The sweep's --dry-run therefore resolves exactly the targets a real run
// disposes. `tap admin retire` disposes the retired team's inbound through the
// same disposal core with a narrower, identity-fenced selection.
//
// "Gone" needs positive evidence, in three classes:
// - seat_gone: the addressed team's registry parses completely and has no row
//   for the handle, and no forwarding edge or adoption grant carries it.
// - team_gone: the addressed team is another team, and the live machine index
//   shows it de-enrolled (no key), historical, or its registry absent (ENOENT)
//   at the resolved registry_location — tap cancel's tap-fcd3 rule.
// - instance_retired: the row is present, but the payload is a `reply: expected`
//   message stamped for a different instance of that handle. No successor can
//   answer it. A settle-only note to a predecessor is live: the successor settles
//   it by `tap read`. Spool-resident ids belong to the courier's own
//   instance-retirement tier and are never classified here.
// Everything uncertain stays live, so health keeps raising attention for it:
// an absent, invalid or unreadable index or registry; a bare or malformed
// enrollment entry; anything but a regular file at the registry location; a
// payload that fails its envelope; and a manual relay (cross_worktree with no
// to_team), whose addressee's team is unknowable.
//
// Disposal is withdrawal, never re-delivery: it writes the existing `.cancelled`
// receipt and leaves the payload resident in payloads/, so the body and its
// outcome both stay inspectable. It publishes no notice and has no pane effect.
import { existsSync, lstatSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Bus } from "./bus";
import { writeCancelledReceipt } from "./cancelled-receipt";
import { envelopeField, readEnvelopeHeader, validateEnvelope } from "./envelope";
import { forwardings } from "./forwarding";
import { validId } from "./ids";
import { loadGlobalRegistry, readUnderIndexWriterLocks } from "./index-home";
import { acquireObligationLock, acquireRegistryLock, type RegistryLock } from "./panelock";
import { loadCurrentRegistry, type RegistryDoc } from "./registry";
import { acquireResetMutationLock } from "./reset";
import { isFile } from "./watch-lease";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The cleanup command health names. Preview first; the real run drops --dry-run. */
export const DEAD_LETTER_SWEEP = "tap cancel --dead-letters --dry-run";

/** A registry view complete enough to call a handle absent; null means unknown.
 * `team` is the SELECTED team — the enrollment key, never the file's own
 * claim — and a registry whose embedded name disagrees proves nothing. */
export interface DeadLetterAuthority { team: string; doc: RegistryDoc; seats: Record<string, unknown> }

export function deadLetterAuthority(registryPath: string, team: string): DeadLetterAuthority | null {
  // loadRegistry answers {} for a missing file; absence is unknown, never "everyone left".
  if (!team || !registryPath || !isFile(registryPath)) return null;
  let doc: RegistryDoc;
  try { doc = loadCurrentRegistry(registryPath); } catch { return null; }
  if (!object(doc.team) || doc.team.name !== team || !object(doc.seats)) return null;
  // A scalar or array row is a damaged document, not a roster that can prove absence.
  if (!Object.values(doc.seats).every(object)) return null;
  try { forwardings(doc); } catch { return null; }
  return { team, doc, seats: doc.seats };
}

/** What the machine index says about an addressed team. */
type TeamView =
  | { kind: "gone"; evidence: string; location: string }
  | { kind: "present"; auth: DeadLetterAuthority; location: string }
  | { kind: "unknown" };
const UNKNOWN: TeamView = { kind: "unknown" };

/** Resolve `name` from a parsed live index document. */
function teamView(doc: Record<string, unknown> | null, name: string): TeamView {
  if (!doc || !object(doc.teams)) return UNKNOWN;
  // OWN key: an inherited member is not an enrollment, and its absence is de-enrollment.
  if (!Object.hasOwn(doc.teams, name)) return { kind: "gone", evidence: `machine_index (${name}): not enrolled`, location: "" };
  const entry = doc.teams[name];
  // A damaged entry is not authority: every field a verdict reads must have its shape.
  if (!object(entry) || typeof entry.root !== "string" || !isAbsolute(entry.root)) return UNKNOWN;
  if (entry.registry_location !== undefined && typeof entry.registry_location !== "string") return UNKNOWN;
  if (entry.state !== undefined && typeof entry.state !== "string") return UNKNOWN;
  const location = entry.registry_location ?? "";
  if ((entry.state ?? "registered") === "historical") return { kind: "gone", evidence: `machine_index (${name}): historical`, location };
  // A bare entry, or a relative path, names nowhere this reader can judge.
  if (!location || !isAbsolute(location)) return UNKNOWN;
  try { lstatSync(location); }
  catch (error) {
    // ENOENT is the only absence (tap-fcd3); EACCES, ELOOP, ENOTDIR are unknown.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "gone", evidence: `foreign_team_registry (${name}): absent at ${location}`, location }
      : UNKNOWN;
  }
  // A directory, FIFO or dangling link at the authority path is uncertainty, not absence.
  try { if (!statSync(location).isFile()) return UNKNOWN; } catch { return UNKNOWN; }
  const auth = deadLetterAuthority(location, name);
  return auth ? { kind: "present", auth, location } : UNKNOWN;
}

/** One classification run: the bus, its bound team and registry, and one index read. */
export interface DeadLetterScope {
  bus: Bus;
  team: string;
  registryPath: string;
  local: DeadLetterAuthority;
  index: Record<string, unknown> | null;
  views: Map<string, TeamView>;
}

/** The scope for `bus`, or null when its own registry cannot prove anything. */
export function deadLetterScope(bus: Bus, registryPath: string, team: string,
  indexHome = process.env.TAP_INDEX_HOME, index?: Record<string, unknown> | null): DeadLetterScope | null {
  const local = deadLetterAuthority(registryPath, team);
  if (!local) return null;
  if (index === undefined) {
    try {
      const snap = loadGlobalRegistry(indexHome);
      index = snap.marker === "live" ? snap.doc : null;
    } catch { index = null; }
  }
  return { bus, team, registryPath, local, index, views: new Map() };
}

function addressedTeam(scope: DeadLetterScope, name: string): TeamView {
  let view = scope.views.get(name);
  if (!view) { view = teamView(scope.index, name); scope.views.set(name, view); }
  return view;
}

export type DeadLetterClass = "seat_gone" | "team_gone" | "instance_retired";
export interface DeadLetter {
  id: string; to: string; from: string; kind: string;
  /** The addressed team; "" means the bus's own team. */
  toTeam: string;
  class: DeadLetterClass;
  /** The receipt's registry_checked: which evidence decided. */
  evidence: string;
  /** The addressed registry this verdict read, or "" for the bound one or none. */
  location: string;
}

/** Whether an explicit forwarding edge or adoption grant still carries `to`. */
function custodyCarried(auth: DeadLetterAuthority, to: string): boolean {
  if (forwardings(auth.doc).some((edge) => edge.source === to && !edge.custody_revoked)) return true;
  return Object.values(auth.seats).some((seat) => object(seat) && Array.isArray(seat.adopted_handles) && seat.adopted_handles.includes(to));
}

/** Spool residency in either sidecar (or any doubt about it) is the courier's tier. */
function spoolResident(bus: Bus, id: string): boolean {
  for (const name of [`${id}.md`, `${id}.meta.json`]) {
    try { lstatSync(join(bus.home, "spool", name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  }
  return false;
}

/** The dead letter when `raw` (canonical payload `id`) is one, else null. */
export function deadLetter(id: string, raw: string, scope: DeadLetterScope | null): DeadLetter | null {
  if (!scope || !validateEnvelope(raw).ok || envelopeField(raw, "id") !== id) return null;
  const to = envelopeField(raw, "to") ?? "";
  const toTeam = envelopeField(raw, "to_team") ?? "";
  if (!to) return null;
  // A manual relay never learns its recipient's team: absence here proves nothing.
  if (!toTeam && envelopeField(raw, "cross_worktree") === "true") return null;
  const local = !toTeam || toTeam === scope.team;
  const view: TeamView = local ? { kind: "present", auth: scope.local, location: "" } : addressedTeam(scope, toTeam);
  if (view.kind === "unknown") return null;
  const base = { id, to, from: envelopeField(raw, "from") ?? "", kind: envelopeField(raw, "kind") ?? "", toTeam: local ? "" : toTeam, location: view.location };
  if (view.kind === "gone") return { ...base, class: "team_gone", evidence: view.evidence };
  const evidence = local ? "bound_team_registry" : `foreign_team_registry (${toTeam})`;
  const { auth } = view;
  if (custodyCarried(auth, to)) return null;
  // OWN-property check, as cancel's classifySeat: an inherited member is not a row.
  if (!Object.hasOwn(auth.seats, to)) return { ...base, class: "seat_gone", evidence };
  // Instance tier: only mail no successor can settle, with both stamps present.
  // Only the settled expected-reply contract: settle-only is the successor's to
  // read, and any other value is unvalidated semantics, never proof.
  if (envelopeField(raw, "reply") !== "expected") return null;
  const row = auth.seats[to] as Record<string, unknown>;
  const bound = envelopeField(raw, "recipient_instance") ?? "";
  const current = typeof row.instance === "string" ? row.instance : "";
  if (!bound || !current || bound === current || envelopeField(raw, "to_adopted_from")) return null;
  if (spoolResident(scope.bus, id)) return null;
  return { ...base, class: "instance_retired", evidence };
}

/** The payload's envelope header, or null unless it is a regular file — not a
 * symlink (health's census excludes those too) and not a FIFO, which the
 * nonblocking open plus fstat inside readEnvelopeHeader refuse without blocking. */
function payloadHeader(bus: Bus, id: string): string | null {
  const path = bus.payloadPath(id);
  try { return lstatSync(path).isFile() ? readEnvelopeHeader(path) : null; } catch { return null; }
}

/** Unsettled canonical ids on `bus` with their headers, lexical by id. */
function unsettledPayloads(bus: Bus): { id: string; raw: string }[] {
  let names: string[];
  // No payloads/ yet is an empty census; any other read failure is not one.
  try { names = readdirSync(bus.payloadsDir).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${bus.payloadsDir}: ${(error as Error).message}; no dead-letter census is possible`);
  }
  const out: { id: string; raw: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name.startsWith("_") || !name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (!validId(id) || bus.isDone(id)) continue;
    const raw = payloadHeader(bus, id);
    if (raw !== null) out.push({ id, raw });
  }
  return out;
}

/** Unsettled canonical dead letters in `scope`, lexical by id; `target` narrows
 * to one LOCAL addressee (the bus's own team), as retirement needs. */
export function deadLetterTargets(scope: DeadLetterScope | null, target = ""): DeadLetter[] {
  if (!scope) return [];
  const out: DeadLetter[] = [];
  for (const { id, raw } of unsettledPayloads(scope.bus)) {
    const dead = deadLetter(id, raw, scope);
    if (dead && (!target || (dead.to === target && !dead.toTeam))) out.push(dead);
  }
  return out;
}

export interface Disposal {
  disposed: string[];
  /** Left unchanged, nothing written: benign (`already_terminal`, `recipient_not_gone`,
   * `registry_moved`) or busy. */
  skipped: { id: string; reason: string }[];
  /** Stopped the batch with its effect unknown or refused; later candidates were not attempted. */
  failed: { id: string; reason: string }[];
}

/** Reasons that mean "try again later", which make the sweep exit nonzero. */
export const BUSY_SKIPS = new Set(["obligation_busy", "registry_lock_busy", "index_lock_busy", "index_unavailable"]);

/** How one disposal re-decides a candidate under its locks. */
interface DisposalRule {
  bus: Bus;
  by: string;
  indexHome: string | undefined;
  /** Registry files to lock for `candidate`; the first is the bound one, which is revalidated. */
  locks: (candidate: DeadLetter) => string[];
  revalidate?: (lock: RegistryLock) => void;
  /** The fresh verdict from the locked index parse; null means not dead. */
  decide: (id: string, raw: string, index: Record<string, unknown>) => DeadLetter | null;
}

/** Withdraw each candidate under its obligation lock, then shared reset custody,
 * then the registry lock(s), then the index writer ladder (obligation may
 * enclose reset; reset precedes the registry; enrollment's own order puts the
 * registry sidecar before the index). Selection, terminality and the verdict
 * are re-decided under them from a fresh index parse, so a seat that registers
 * or a team that re-enrolls between the scan and the receipt keeps its mail.
 * The index ladder is never waited on: busy is a skip. A thrown step stops the
 * batch; every receipt that landed is reported, the failing id included when
 * its receipt exists. Call with no lock held. */
function dispose(rule: DisposalRule, candidates: DeadLetter[]): Disposal {
  const result: Disposal = { disposed: [], skipped: [], failed: [] };
  for (const candidate of candidates) {
    const { id } = candidate;
    scratchBarrier("dead-letter-before-lock", id);
    try {
      const reason = disposeOne(rule, candidate);
      if (reason) result.skipped.push({ id, reason }); else result.disposed.push(id);
    } catch (error) {
      if (isFile(rule.bus.cancelPath(id))) result.disposed.push(id);
      result.failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return result;
}

/** "" when withdrawn, else the skip reason. */
function disposeOne(rule: DisposalRule, candidate: DeadLetter): string {
  const { bus, by, id } = { ...rule, id: candidate.id };
  const obligation = acquireObligationLock(id, 1000);
  if (!obligation) return "obligation_busy";
  try {
    const reset = acquireResetMutationLock(bus.home, by, undefined, "shared");
    try {
      const held: RegistryLock[] = [];
      try {
        // One global (lexical) order, as cross-team send publishes: two sweeps
        // holding mail for each other's teams never wait on each other.
        const paths = rule.locks(candidate);
        let bound: RegistryLock | undefined;
        for (const path of [...paths].sort()) {
          const lock = acquireRegistryLock(path, 5000);
          if (!lock) return "registry_lock_busy";
          held.push(lock);
          if (path === paths[0]) bound = lock;
        }
        if (bound) rule.revalidate?.(bound);
        const locked = held.map((lock) => lock.registryLocation);
        const read = readUnderIndexWriterLocks(rule.indexHome, 0, (index) => {
          if (bus.isDone(id)) return "already_terminal";
          const raw = payloadHeader(bus, id);
          if (raw === null) return "payload_unreadable";
          const dead = rule.decide(id, raw, index);
          if (!dead) return "recipient_not_gone";
          // A verdict read from a registry this disposal never locked is unfenced:
          // the team moved since the scan. Skip; never lock under the index.
          if (dead.location && existsSync(dirname(dead.location)) && !locked.some((path) => sameFile(path, dead.location))) return "registry_moved";
          writeCancelledReceipt(bus, receiptFor(dead, by));
          return "";
        });
        if (!read.ok) return /busy/.test(read.detail) ? "index_lock_busy" : "index_unavailable";
        return read.value;
      } finally { for (const lock of held.reverse()) lock.release(); }
    } finally { reset.release(); }
  } finally { obligation.release(); }
}

function receiptFor(dead: DeadLetter, by: string) {
  const retired = dead.class === "instance_retired";
  return {
    id: dead.id, by, reason: retired ? "instance_retired" : "seat_unresolvable", target: dead.to,
    target_status: retired ? "replaced" : "gone", registry_checked: dead.evidence, source: "payloads",
  };
}

/** The registry files a scope-classified candidate's verdict reads: the bound
 * registry, plus the addressed team's when it is another file whose directory
 * exists (a registry under a deleted directory cannot be recreated unlocked). */
function scopeLocks(registryPath: string) {
  return (candidate: DeadLetter): string[] => {
    const out = [registryPath];
    const other = candidate.location;
    if (other && existsSync(dirname(other)) && !sameFile(other, registryPath)) out.push(other);
    return out;
  };
}

function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

/** Dispose `candidates` from `scope`'s classifier (health's, the sweep's, tap out's).
 * `revalidate` re-proves the caller's team selection under the bound registry lock. */
export function disposeDeadLetters(scope: DeadLetterScope, candidates: DeadLetter[], by: string,
  revalidate?: (lock: RegistryLock) => void, indexHome = process.env.TAP_INDEX_HOME): Disposal {
  return dispose({
    bus: scope.bus, by, indexHome, revalidate, locks: scopeLocks(scope.registryPath),
    decide: (id, raw, index) => deadLetter(id, raw, deadLetterScope(scope.bus, scope.registryPath, scope.team, indexHome, index)),
  }, candidates);
}

/** The retired team's inbound (tap-bm4om): mail on its bus addressed to the team
 * itself and stamped for exactly the instance its row held when retire captured
 * it under the registry lock. Unstamped or mismatched mail, a manual relay, and
 * mail for any other team stay. */
function retiredInbound(team: string, captured: Record<string, string>, id: string, raw: string): DeadLetter | null {
  if (!validateEnvelope(raw).ok || envelopeField(raw, "id") !== id) return null;
  const to = envelopeField(raw, "to") ?? "";
  const toTeam = envelopeField(raw, "to_team") ?? "";
  if (!to || (toTeam && toTeam !== team)) return null;
  if (!toTeam && envelopeField(raw, "cross_worktree") === "true") return null;
  const bound = envelopeField(raw, "recipient_instance") ?? "";
  if (!bound || !Object.hasOwn(captured, to) || captured[to] !== bound) return null;
  return { id, to, from: envelopeField(raw, "from") ?? "", kind: envelopeField(raw, "kind") ?? "", toTeam: "",
    class: "team_gone", evidence: `machine_index (${team}): retired by tap admin retire`, location: "" };
}

/** `tap admin retire`'s disposal: runs after the de-enrollment publication with
 * no lock held. Under its locks, the fresh index parse must still show `team`
 * not enrolled — a re-enrolled team keeps its mail. */
export function disposeRetiredTeamInbound(bus: Bus, team: string, registryLocation: string,
  captured: Record<string, string>, indexHome = process.env.TAP_INDEX_HOME): Disposal {
  const candidates = unsettledPayloads(bus)
    .map(({ id, raw }) => retiredInbound(team, captured, id, raw))
    .filter((dead): dead is DeadLetter => dead !== null);
  return dispose({
    bus, by: "tap admin retire", indexHome,
    locks: () => (registryLocation && existsSync(dirname(registryLocation)) ? [registryLocation] : []),
    decide: (id, raw, index) => {
      if (!object(index.teams) || Object.hasOwn(index.teams, team)) return null;
      return retiredInbound(team, captured, id, raw);
    },
  }, candidates);
}

/** Scratch-only interleaving barrier; production callers never enter it. */
function scratchBarrier(stage: string, id: string): void {
  const base = process.env.TAP_DEAD_LETTER_TEST_BARRIER;
  if (!base || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_DEAD_LETTER_TEST_ID !== id) return;
  writeFileSync(`${base}.${stage}.reached`, "1\n");
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${base}.${stage}.release`)) {
    if (Date.now() >= deadline) throw new Error(`dead-letter ${stage} test barrier timed out`);
    Bun.sleepSync(5);
  }
}
