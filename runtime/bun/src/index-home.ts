// The machine index — `<TAP_INDEX_HOME>/global-registry.json`, which locates each
// team's ACTING registry.
//
// TAP_INDEX_HOME is the isolation primitive. TAP_HOME moves only the bus: with the
// index unset, the acting registry still resolves through the operator's live
// machine index and a test writes PRODUCTION seat rows. Every function here takes
// the index home explicitly for that reason.

import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isFile } from "./watch-lease";
import { resolveBus } from "./bushome";

export const SCHEMA = "0.20";

/**
 * The machine index's bytes are decoded with the incumbent's polarity, not
 * Node's. Python's `open(path)` (registry_v20.py:70, the incumbent flip
 * classifier's reader) decodes UTF-8 strictly: one invalid byte anywhere raises
 * `UnicodeDecodeError` and `json.load` never runs, so the index is unreadable,
 * whole. `readFileSync(path, "utf8")` instead REPLACES the byte with U+FFFD,
 * after which the JSON parses — a repair that turns an authority refusal back
 * into a live marker (watch-lease.ts:226-241 is the same fix for the watch
 * record, measured on a 0xFF the machine never consults). The bad byte living
 * in an unrelated team's name is not the point: the incumbent's reader rejected
 * the document.
 *
 * `ignoreBOM: true` is intentional and is NOT about ignoring anything: without
 * it TextDecoder STRIPS a leading BOM, which would let a BOM-prefixed index
 * parse where Python text-mode `open` — plain utf-8, not utf-8-sig — leaves the
 * BOM for `json.load`, which refuses it. Keeping the BOM keeps that agreement.
 */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One throwing decode/parse of a machine-index file: any byte fault, BOM, or
 *  JSON syntax error throws, and each caller's existing catch renders the
 *  verdict its own verb already owns (invalid marker, empty enrollment, ...).
 *  Machine-index reads only — acting team registries have their own readers. */
export function readIndexJson(path: string): Record<string, unknown> {
  return JSON.parse(UTF8_STRICT.decode(readFileSync(path))) as Record<string, unknown>;
}

export function globalRegistryPath(indexHome?: string): string {
  return join(indexHome || process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "global-registry.json");
}

export type FlipState = "absent" | "live" | "invalid";

export interface GlobalRegistrySnapshot {
  marker: FlipState;
  path: string;
  doc: Record<string, unknown> | null;
}

/**
 * One parse of global-registry.json. Marker, schema, and the teams map come
 * from the same document so a rewrite cannot split "live" from "this team".
 */
export function loadGlobalRegistry(indexHome?: string): GlobalRegistrySnapshot {
  const path = globalRegistryPath(indexHome);
  // CLASSIFY THE PATH KIND BEFORE OPENING IT. `existsSync` + `readFileSync` is
  // not merely imprecise here, it can HANG: a FIFO at the marker path exists,
  // and opening it for read blocks until a writer appears — indefinitely, with
  // no timeout and no error. Python's flip_marker_state already refuses on kind
  // (isfile/lexists) without opening; this is the native twin of that ordering
  // (the Bash-only FIFO row proved one classifier
  // while its native counterpart kept the exact hang the row claims to prevent).
  //
  // RULE 38, by OPERATOR: `lstat` first so a symlink is classified as a symlink;
  // a symlink to a regular file resolves and parses, a BROKEN symlink is an
  // invalid marker rather than an absent one (it is an entry, and `absent`
  // LICENSES legacy routing), and directory / FIFO / socket / device are invalid
  // without ever being opened.
  let kind;
  try {
    kind = lstatSync(path);
  } catch (err) {
    // ENOENT IS THE ONLY ABSENCE. `absent` LICENSES legacy routing -- it is the
    // state that says "this machine predates the flip, writing teams.json is
    // correct" -- so it may only be returned when the path was successfully
    // observed to hold nothing. EACCES, ELOOP, ENOTDIR and I/O errors mean the
    // marker could not be READ, which is an unusable marker, not a missing one.
    // Mapping them to absent lets a permission or filesystem fault silently
    // license the retired store (rule 19; partner review P1, demonstrated with a
    // valid marker under a directory with traverse permission removed: expected
    // invalid, received absent).
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { marker: "absent", path, doc: null };
    return { marker: "invalid", path, doc: null };
  }
  if (kind.isSymbolicLink()) {
    try {
      kind = statSync(path);
    } catch {
      return { marker: "invalid", path, doc: null };
    }
  }
  if (!kind.isFile()) return { marker: "invalid", path, doc: null };
  let data: unknown;
  try {
    data = readIndexJson(path);
  } catch {
    return { marker: "invalid", path, doc: null };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { marker: "invalid", path, doc: null };
  }
  const doc = data as Record<string, unknown>;
  if (String(doc.schema ?? "") !== SCHEMA) return { marker: "invalid", path, doc };
  if ("teams" in doc && (typeof doc.teams !== "object" || doc.teams === null || Array.isArray(doc.teams))) {
    return { marker: "invalid", path, doc };
  }
  return { marker: "live", path, doc };
}

/**
 * absent  — no global-registry.json (genuine pre-flip; legacy routing allowed)
 * live    — present, schema 0.20, `teams` a dict or absent
 * invalid — present but unreadable / wrong schema / non-dict `teams`
 *
 * `invalid` FAILS CLOSED and never falls back to legacy. A present-but-non-dict
 * `teams` (null, a list) must not classify live, or enrollment would normalize it
 * to `{}` and erase every prior enrollment.
 */
export function flipMarkerState(indexHome?: string): FlipState {
  return loadGlobalRegistry(indexHome).marker;
}

export function isFlipLive(indexHome?: string): boolean {
  return flipMarkerState(indexHome) === "live";
}

/**
 * Which machine-index file `--team` / by-id may read. Only a live marker names
 * one: absent (no enrolled team, F2b) and invalid never fall back to teams.json.
 */
export function markerSelectedIndex(indexHome?: string):
  | { marker: "invalid" }
  | { marker: "absent" }
  | { marker: "live"; path: string } {
  const marker = flipMarkerState(indexHome);
  if (marker === "live") return { marker, path: globalRegistryPath(indexHome) };
  return marker === "absent" ? { marker: "absent" } : { marker: "invalid" };
}

export type EnrolledTeamRoot =
  | { kind: "invalid" }
  | { kind: "ok"; root: string }
  | { kind: "missing" }
  /** No machine index: no enrolled team to resolve (F2b); callers refuse unanchored_bus. */
  | { kind: "absent" }
  | { kind: "not_authoritative"; status: "historical" | "unreachable" | "invalid" };

/** Marker-selected team root for `tap_apply_team_override`. */
export function resolveEnrolledTeamRoot(team: string, indexHome?: string): EnrolledTeamRoot {
  const sel = markerSelectedIndex(indexHome);
  if (sel.marker === "invalid") return { kind: "invalid" };
  if (sel.marker === "live") {
    const r = resolveTeamFromGlobal(sel.path, team);
    if (r.status === "ok" && r.root) return { kind: "ok", root: r.root };
    if (r.status === "historical" || r.status === "unreachable" || r.status === "invalid") {
      return { kind: "not_authoritative", status: r.status };
    }
    return { kind: "missing" };
  }
  return { kind: "absent" };
}

/** Empty when the acting path is off-layout. */
export function busHomeForRegistry(reg: string): string {
  if (!reg) return "";
  try { reg = realpathSync(reg); } catch { /* Preserve lexical derivation for absent paths. */ }
  const parent = dirname(reg);
  const base = basename(reg);
  if (base === "team-registry.json") return join(parent, "bus");
  if (base === "registry.json") return parent;
  if (basename(parent) === "bus") return parent;
  if (basename(parent) === ".tap") return join(parent, "bus");
  return "";
}

/** Acting registry `tap_rebind_acting_registry` would bind after a `--team` bus derive. */
export function actingRegistryForTeamOverride(team: string, busHome: string, indexHome?: string): string {
  const sel = markerSelectedIndex(indexHome);
  if (sel.marker === "live") return resolveTeamFromGlobal(sel.path, team).registryLocation;
  return join(busHome, "registry.json");
}

export interface TeamResolution {
  status: "ok" | "historical" | "missing" | "unreachable" | "invalid";
  root: string;
  registryLocation: string;
  /** Diagnostic detail for `invalid`. NEVER carried in `root` — a path field
   *  that changes type-by-convention into error prose is a trap for every
   *  caller that treats it as a path. */
  detail?: string;
}

/** Resolve a team name from an already-parsed live global-registry document. */
export function resolveTeamFromDoc(doc: Record<string, unknown>, team: string): TeamResolution {
  const teams = doc.teams;
  if (typeof teams !== "object" || teams === null) return { status: "missing", root: "", registryLocation: "" };
  const ent = (teams as Record<string, unknown>)[team];
  if (typeof ent !== "object" || ent === null) return { status: "missing", root: "", registryLocation: "" };
  const e = ent as Record<string, unknown>;
  const root = String(e.root ?? "");
  const loc = String(e.registry_location ?? "");
  if (String(e.state ?? "registered") === "historical") {
    return { status: "historical", root, registryLocation: loc };
  }
  // INCUMBENT PARITY (registry_v20.py:651): an empty/omitted registry_location
  // answers `missing`, not `unreachable`. Reclassifying it would turn a
  // bare-entry team into unreachable_team and — worse — make its root
  // resolvable through the root projection, which the incumbent never did
  // (send-remote.test.ts `bare` control pins exactly this row).
  if (!loc) return { status: "missing", root, registryLocation: "" };
  if (!isFile(loc)) return { status: "unreachable", root, registryLocation: loc };
  return { status: "ok", root, registryLocation: loc };
}

/**
 * The enrollment verdict for one root, from an ALREADY-PARSED global registry
 * document — the snapshot twin of `resolveTeamFromDoc`'s root projection.
 * Callers must classify the marker and resolve enrollment from the SAME
 * document (`loadGlobalRegistry` snapshot): reopening the file after the
 * classification is the TOCTOU/FIFO-hang window this module documents.
 *
 * A row that claims the root but carries no readable `registry_location` is an
 * UNVERIFIABLE claim, not a genuinely unenrolled root: `unreachable`, so the
 * detector mapping fails closed instead of answering the basename arm.
 */
export function enrolledNameForRootFromDoc(
  doc: Record<string, unknown>,
  root: string,
): { status: "ok" | "missing" | "ambiguous" | "unreachable"; name: string } {
  const teams = doc.teams;
  if (typeof teams !== "object" || teams === null || Array.isArray(teams)) return { status: "missing", name: "" };
  const target = realpathOrAbs(root);
  const hits: Array<[string, Record<string, unknown>]> = [];
  for (const [name, ent] of Object.entries(teams as Record<string, unknown>)) {
    if (typeof ent !== "object" || ent === null) continue;
    const e = ent as Record<string, unknown>;
    if (String(e.state ?? "registered") === "historical") continue;
    const rowRoot = String(e.root ?? "");
    if (rowRoot && realpathOrAbs(rowRoot) === target) hits.push([name, e]);
  }
  if (hits.length === 0) return { status: "missing", name: "" };
  if (hits.length > 1) return { status: "ambiguous", name: "" };
  const loc = String(hits[0]![1].registry_location ?? "");
  if (!loc || !isReadableRegularFile(loc)) return { status: "unreachable", name: "" };
  return { status: "ok", name: hits[0]![0] };
}

/** Resolve a team name to its root + acting registry location through the index. */
export function resolveTeamFromGlobal(globalPath: string, team: string): TeamResolution {
  let doc: Record<string, unknown>;
  try {
    doc = readIndexJson(globalPath);
  } catch (e) {
    return { status: "invalid", root: "", registryLocation: "", detail: String(e) };
  }
  return resolveTeamFromDoc(doc, team);
}

export type MarkerAwareResolution = TeamResolution & { marker: FlipState };

/**
 * Marker-aware team resolution — the Bun twin of `tap_index_resolve_team` /
 * `tap_index_resolve_root`. READ-ONLY on every arm.
 *
 * - `live` delegates to the global registry.
 * - `absent` answers `missing` with failure evidence: no machine index means
 *   no enrolled team, and legacy teams.json is never read (F2b).
 * - `invalid` fails closed.
 */
export function resolveTeamMarkerAware(team: string, indexHome?: string): MarkerAwareResolution {
  return resolveTeamMarkerAwareWithEvidence(team, indexHome).resolution;
}

export interface TeamResolutionEvidence {
  resolution: MarkerAwareResolution;
  /** Existing readers keep their old result; effect-authorizing readers must refuse this failure. */
  failure?: string;
}

export function resolveTeamMarkerAwareWithEvidence(team: string, indexHome?: string): TeamResolutionEvidence {
  // ONE GUARDED SNAPSHOT (u1 round-1, r4045876907): the marker classification
  // and the team lookup read the SAME parsed document. The previous shape —
  // `markerSelectedIndex` for the kind, then `resolveTeamFromGlobal(path)` —
  // reopened the file after the lstat guard, a TOCTOU window where a swap to a
  // FIFO would block the reopen indefinitely (the exact hang loadGlobalRegistry
  // documents) and a swap to different bytes would split "live" from "this
  // team". `loadGlobalRegistry` already refuses non-regular kinds before
  // opening; resolving from its snapshot keeps that guard load-bearing.
  const snap = loadGlobalRegistry(indexHome);
  if (snap.marker === "invalid") {
    return {
      resolution: { status: "invalid", root: "", registryLocation: "", marker: "invalid",
        detail: "global-registry.json marker is present but unusable" },
      failure: "global-registry.json marker is present but unusable",
    };
  }
  if (snap.marker === "live") {
    const resolution: MarkerAwareResolution = { ...resolveTeamFromDoc(snap.doc ?? {}, team), marker: "live" };
    const teams = snap.doc?.teams as Record<string, unknown> | undefined;
    if (teams && Object.hasOwn(teams, team)) {
      const entry = teams[team] as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.root !== "string" || !entry.root) {
        return { resolution, failure: "malformed team entry or root" };
      }
    }
    // A live bare entry still has status=missing even with a populated root.
    // Its root must not become usable through this evidence channel.
    return { resolution };
  }
  // ABSENT: born live (F1), so no machine index means no enrolled team. The
  // legacy teams.json is never read; effect-authorizing readers refuse.
  return { resolution: { status: "missing", root: "", registryLocation: "", marker: "absent" },
    failure: "no machine index (global-registry.json)" };
}

function realpathOrAbs(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The team name for a working root, taken from the GLOBAL enrollment key.
 *
 * Deliberately not from the acting file's own `team.name`: that content is
 * pre-authority, so a relocated or decoy registry would be resolved by its own
 * claim about itself.
 */
export function enrolledTeamNameForRoot(
  root: string,
  indexHome?: string,
): { status: "ok" | "missing" | "ambiguous" | "invalid"; name: string } {
  const path = globalRegistryPath(indexHome);
  if (!existsSync(path)) return { status: "missing", name: "" };
  let doc: Record<string, unknown>;
  try {
    doc = readIndexJson(path);
  } catch {
    return { status: "invalid", name: "" };
  }
  const teams = doc.teams;
  if (typeof teams !== "object" || teams === null) return { status: "missing", name: "" };
  const target = realpathOrAbs(root);
  const hits: string[] = [];
  for (const [name, ent] of Object.entries(teams as Record<string, unknown>)) {
    if (typeof ent !== "object" || ent === null) continue;
    const e = ent as Record<string, unknown>;
    if (String(e.state ?? "registered") === "historical") continue;
    const root = String(e.root ?? "");
    if (root && realpathOrAbs(root) === target) hits.push(name);
  }
  if (hits.length === 1) return { status: "ok", name: hits[0]! };
  if (hits.length > 1) return { status: "ambiguous", name: "" };
  return { status: "missing", name: "" };
}

/**
 * Tri-state enrollment at one canonical root.
 *
 * This is the walk's per-step probe. A boolean "is this a session root?" is
 * the mutant that walks PAST an enrolled-but-unreadable directory and binds
 * the outer team — the exact false fallback Stage 0 exists to refuse.
 */
export type EnrollmentAt =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ambiguous" }
  | { status: "ok"; name: string; rootReal: string; registryLocation: string }
  | { status: "unreachable"; name: string; rootReal: string; registryLocation: string };

export function enrollmentAt(root: string, indexHome?: string): EnrollmentAt {
  const snap = loadGlobalRegistry(indexHome);
  if (snap.marker === "absent") return { status: "missing" };
  if (snap.marker === "invalid" || !snap.doc) return { status: "invalid" };
  return enrollmentAtFromDoc(snap.doc, root);
}

/** Probe one canonical root against an already-parsed index document. */
export function enrollmentAtFromDoc(doc: Record<string, unknown>, root: string): EnrollmentAt {
  const teams = doc.teams;
  if (!("teams" in doc)) return { status: "missing" };
  if (typeof teams !== "object" || teams === null || Array.isArray(teams)) return { status: "invalid" };
  const target = realpathOrAbs(root);
  const hits: Array<{ name: string; loc: string; rootReal: string }> = [];
  for (const [name, ent] of Object.entries(teams as Record<string, unknown>)) {
    if (typeof ent !== "object" || ent === null || Array.isArray(ent)) continue;
    const e = ent as Record<string, unknown>;
    if (String(e.state ?? "registered") === "historical") continue;
    const entRoot = String(e.root ?? "");
    if (!entRoot) continue;
    if (realpathOrAbs(entRoot) !== target) continue;
    hits.push({
      name,
      loc: String(e.registry_location ?? ""),
      rootReal: realpathOrAbs(entRoot),
    });
  }
  if (hits.length === 0) return { status: "missing" };
  if (hits.length > 1) return { status: "ambiguous" };
  const hit = hits[0]!;
  if (!hit.loc || !isReadableRegularFile(hit.loc)) {
    return { status: "unreachable", name: hit.name, rootReal: hit.rootReal, registryLocation: hit.loc };
  }
  return { status: "ok", name: hit.name, rootReal: hit.rootReal, registryLocation: hit.loc };
}

function isReadableRegularFile(p: string): boolean {
  if (!isRegularFile(p)) return false;
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every enrolled (non-historical) team with a readable acting registry. */
export function enrolledTeams(indexHome?: string): Array<{ team: string; root: string; registryLocation: string }> {
  const path = globalRegistryPath(indexHome);
  if (!existsSync(path)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = readIndexJson(path);
  } catch {
    return [];
  }
  const teams = doc.teams;
  if (typeof teams !== "object" || teams === null) return [];
  const out: Array<{ team: string; root: string; registryLocation: string }> = [];
  for (const [team, ent] of Object.entries(teams as Record<string, unknown>)) {
    if (typeof ent !== "object" || ent === null) continue;
    const e = ent as Record<string, unknown>;
    if (String(e.state ?? "registered") === "historical") continue;
    const loc = String(e.registry_location ?? "");
    if (!loc || !isFile(loc)) continue;
    out.push({ team, root: String(e.root ?? ""), registryLocation: loc });
  }
  return out;
}

export function legacyTeamsPath(indexHome?: string): string {
  return join(indexHome || process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "teams.json");
}

export type PayloadById =
  | { kind: "none" }
  | { kind: "one"; path: string }
  | { kind: "many"; paths: string[] };

/**
 * tap-akt4: on a local miss, resolve `payloads/<id>.md` across enrolled team
 * buses. Filenames are globally unique, so more than one hit is an anomaly —
 * the caller must refuse rather than pick. Twins `tap_resolve_payload_by_id`.
 */
export function resolvePayloadById(id: string, indexHome?: string): PayloadById {
  const sel = markerSelectedIndex(indexHome);
  if (sel.marker !== "live") return { kind: "none" };
  const idx = sel.path;
  if (!existsSync(idx)) return { kind: "none" };
  let teams: unknown;
  try {
    const doc = readIndexJson(idx) as { teams?: unknown };
    teams = doc.teams;
  } catch {
    return { kind: "none" };
  }
  if (typeof teams !== "object" || teams === null || Array.isArray(teams)) return { kind: "none" };
  const hits: string[] = [];
  for (const ent of Object.values(teams as Record<string, unknown>)) {
    if (typeof ent !== "object" || ent === null || Array.isArray(ent)) continue;
    const root = (ent as Record<string, unknown>).root;
    if (typeof root !== "string" || !root) continue;
    const bus = resolveBus(root, {});
    if (bus.rule === "old_store") continue;
    const payload = join(bus.home, "payloads", `${id}.md`);
    if (existsSync(payload) && isRegularFile(payload)) hits.push(realOrSelf(payload));
  }
  const unique = [...new Set(hits)].sort();
  if (unique.length === 1) return { kind: "one", path: unique[0]! };
  if (unique.length > 1) return { kind: "many", paths: unique };
  return { kind: "none" };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

import { acquirePathLock, type PaneLock } from "./panelock";
import { metaBytes, parseJsonPreserving, pyReadUtf8, PyFloat, PyInt } from "./spool-publication";
import { atomicWrite } from "./fsatomic";
import { writeIndexSnapshot } from "./index-snapshot";
import type { Stats } from "node:fs";

/**
 * H1 `tap_index_deenroll_team --capture` port (tap-gmj0i U5). The removal is
 * guarded by an exact expectation set — the entry's root and
 * registry_location must match the witnesses exactly, and the acting registry
 * file must be positively absent. The full entry is written to <artifact>
 * BEFORE publication so a failed rollback can restore byte-exact enrollment.
 * Lock order mirrors enrollment: acting-registry sidecar lock FIRST, then the
 * index writer lock.
 */
export interface IndexDeenrollInput {
  team: string;
  artifact: string;
  expectRoot: string;
  expectRegistry: string;
  indexHome?: string;
}

/** 1 the index write failed (plain de-enroll) | 2 unknown | 3 unreadable/busy | 4 no live authority | 6 capture mismatch */
type IndexDoorFailure = { ok: false; code: 1 | 2 | 3 | 4 | 6; detail: string };

export type IndexDoorResult = { ok: true } | IndexDoorFailure;

/**
 * The index writer's lock ladder: teams.json.lock → marker recheck →
 * global-registry.json.lock → marker recheck → fresh parse. The legacy index
 * lock serializes marker polarity with surviving Bash writers, which classify
 * the marker while holding exactly this lock. `body` runs with both locks held
 * and receives the preserved document and its dict `teams` map.
 */
function underIndexWriterLocks<T extends IndexDoorFailure | { ok: true }>(
  indexHome: string | undefined,
  body: (gpath: string, fresh: Record<string, unknown>, teams: Record<string, unknown>) => T,
  waitMs = Infinity,
): T | IndexDoorFailure {
  const gpath = globalRegistryPath(indexHome);
  const legacyLock = lockOrFailure(`${legacyTeamsPath(indexHome)}.lock`, 1, "legacy index lock busy", waitMs);
  if ("ok" in legacyLock) return legacyLock;
  try {
    if (flipMarkerState(indexHome) !== "live") {
      return { ok: false, code: 3, detail: "flip marker moved during retire; retry" };
    }
    const idxLock = lockOrFailure(`${gpath}.lock`, 1, "index lock busy", waitMs);
    if ("ok" in idxLock) return idxLock;
    try {
      if (flipMarkerState(indexHome) !== "live") {
        return { ok: false, code: 3, detail: "flip marker moved during retire; retry" };
      }
      let fresh: unknown;
      try {
        fresh = parseJsonPreserving(pyReadUtf8(gpath));
      } catch {
        return { ok: false, code: 3, detail: `global-registry '${gpath}' could not be read` };
      }
      if (!isDictFresh(fresh)) {
        return { ok: false, code: 3, detail: `global-registry '${gpath}' could not be read` };
      }
      const teams = (isDictFresh(fresh.teams) ? fresh.teams : {}) as Record<string, unknown>;
      return body(gpath, fresh, teams);
    } finally {
      idxLock.release();
    }
  } finally {
    legacyLock.release();
  }
}

/**
 * Hold the index writer ladder around a READ: `body` receives the freshly
 * parsed document while no enrollment can change it. Dead-letter disposal
 * (tap-sr6da) re-decides team absence here, after its registry sidecar locks —
 * enrollment's own order. `waitMs` bounds every wait: a busy ladder is a
 * failure the caller skips, never a stall.
 */
export function readUnderIndexWriterLocks<T>(
  indexHome: string | undefined,
  waitMs: number,
  body: (fresh: Record<string, unknown>) => T,
): { ok: true; value: T } | IndexDoorFailure {
  return underIndexWriterLocks(indexHome, (_gpath, fresh) => ({ ok: true as const, value: body(fresh) }), waitMs);
}

/**
 * Remove one team from the live machine index and return its former root
 * (`""` for a non-object entry). The retired `tap_index_deenroll_team` without
 * capture: 2 unknown team, 3 unreadable or lock/marker motion, 4 no live
 * authority, 1 the index write failed. Only a live marker is ever mutated;
 * the pre-flip teams.json arm is gone (F2a/F2b).
 */
export function deenrollTeam(team: string, indexHome?: string,
  expect?: { root: string; registryLocation: string }): { ok: true; root: string } | IndexDoorFailure {
  const marker = flipMarkerState(indexHome);
  if (marker === "invalid") {
    return { ok: false, code: 4, detail: "global-registry.json is present but unreadable or wrong schema" };
  }
  if (marker !== "live") return { ok: false, code: 4, detail: "de-enroll requires live v0.20 authority" };
  return underIndexWriterLocks(indexHome, (gpath, fresh, teams) => {
    const ent = ownEntry(teams, team);
    if (ent === undefined || ent === null) return { ok: false as const, code: 2 as const, detail: "" };
    const root = isDictFresh(ent) && !(ent instanceof PyFloat) && !(ent instanceof PyInt) && typeof ent.root === "string" ? ent.root : "";
    // An expectation binds the removal to the entry the caller inspected: an
    // entry re-pointed since then is a different enrollment and stays (tap-bm4om).
    if (expect) {
      const location = isDictFresh(ent) && typeof ent.registry_location === "string" ? ent.registry_location : "";
      if (root !== expect.root || location !== expect.registryLocation) {
        return { ok: false as const, code: 6 as const,
          detail: `team '${team}' enrollment changed since it was inspected (root '${root}', registry '${location}'); nothing removed` };
      }
    }
    try {
      delete teams[team];
      fresh.teams = teams;
      atomicWrite(gpath, metaBytes(fresh as unknown as Parameters<typeof metaBytes>[0]));
    } catch (error) {
      return { ok: false as const, code: 1 as const, detail: `global-registry '${gpath}' could not be written (${(error as Error).message})` };
    }
    return { ok: true as const, root };
  });
}

const isDirPath = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * A team whose absolute worktree root is positively absent (ENOENT) is gone:
 * deleting a worktree is an ordinary shutdown without the ceremony. Nothing
 * else reads as gone. A missing registry under a live root can be a reset or
 * restore mid-cut; EACCES, a directory at the registry path, or bad JSON is
 * present-but-unproven data; an empty or relative path cannot be judged
 * independent of cwd.
 */
export function teamRootGone(root: string, registryLocation: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(registryLocation)) return false;
  try { statSync(root); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/**
 * Best-effort self-heal for one gone team. Housekeeping never stalls its
 * caller: every lock is a single non-blocking attempt. Lock order is the
 * capture door's (H1): the gone team's registry sidecar first when its
 * directory still exists (a registry kept outside the deleted root), then the
 * index writer ladder. Under all of them, re-verify the entry still names the
 * same root and registry and the root is still gone, snapshot the index, then
 * remove the entry. A writer that recreates the root before the recheck makes
 * the team not gone; registration and init re-enroll through enrollTeam under
 * this same ladder after publishing, so one that recreates it after the delete
 * re-adds the entry itself. Busy locks, marker motion, or a changed entry
 * leave the index untouched.
 */
export function purgeGoneEnrollment(
  team: string, expect: { root: string; registryLocation: string }, indexHome?: string,
): (IndexDoorResult & { snapshot?: string }) {
  if (flipMarkerState(indexHome) !== "live") return { ok: false, code: 4, detail: "purge requires live v0.20 authority" };
  if (!teamRootGone(expect.root, expect.registryLocation)) return { ok: false, code: 6, detail: "team is not gone" };
  let sidecar: PaneLock | null = null;
  if (isDirPath(dirname(expect.registryLocation))) {
    const held = lockOrFailure(`${expect.registryLocation}.lock`, 3, "gone team's registry lock busy", 0);
    if ("ok" in held) return held;
    sidecar = held;
  }
  try {
    return purgeUnderIndexLocks(team, expect, indexHome);
  } finally {
    sidecar?.release();
  }
}

function purgeUnderIndexLocks(
  team: string, expect: { root: string; registryLocation: string }, indexHome?: string,
): (IndexDoorResult & { snapshot?: string }) {
  return underIndexWriterLocks(indexHome, (gpath, fresh, teams) => {
    const ent = ownEntry(teams, team);
    if (!isDictFresh(ent) || ent instanceof PyFloat || ent instanceof PyInt) return { ok: false as const, code: 2 as const, detail: "" };
    const entry = ent as Record<string, unknown>;
    if (entry.root !== expect.root || entry.registry_location !== expect.registryLocation) {
      return { ok: false as const, code: 6 as const, detail: "enrollment changed since the scan" };
    }
    if (!teamRootGone(expect.root, expect.registryLocation)) return { ok: false as const, code: 6 as const, detail: "team is no longer gone" };
    let snapshot: string;
    try {
      snapshot = writeIndexSnapshot(gpath, "gone-team").path;
      delete teams[team];
      fresh.teams = teams;
      atomicWrite(gpath, metaBytes(fresh as unknown as Parameters<typeof metaBytes>[0]));
    } catch (error) {
      return { ok: false as const, code: 1 as const, detail: `global-registry '${gpath}' could not be written (${(error as Error).message})` };
    }
    return { ok: true as const, snapshot };
  }, 0);
}

export function deenrollTeamWithCapture(input: IndexDeenrollInput): IndexDoorResult & { artifact?: string } {
  const gpath = globalRegistryPath(input.indexHome);
  const snapshot = loadGlobalRegistry(input.indexHome);
  if (snapshot.marker === "invalid") {
    return { ok: false, code: 4, detail: "global-registry.json is present but unreadable or wrong schema" };
  }
  if (snapshot.marker !== "live") {
    return { ok: false, code: 4, detail: "capture requires live v0.20 authority" };
  }
  const sidecar = lockOrFailure(`${input.expectRegistry}.lock`, 3, "acting-registry sidecar lock for capture failed (lock is held elsewhere)");
  if ("ok" in sidecar) return sidecar;
  try {
    // H1 lock order: acting-registry sidecar FIRST, then the index writer ladder.
    return underIndexWriterLocks(input.indexHome, (_gpath, fresh, teams): IndexDoorResult & { artifact?: string } => {
      const ent = ownEntry(teams, input.team);
      if (ent === undefined || ent === null) return { ok: false, code: 2, detail: "" };
      if (typeof ent !== "object" || Array.isArray(ent) || ent instanceof PyFloat || ent instanceof PyInt) {
        return { ok: false, code: 3, detail: "captured entry is not an object" };
      }
      const entry = ent as Record<string, unknown>;
      const entRoot = String(entry.root ?? "");
      if (realOrSelf(entRoot) !== realOrSelf(input.expectRoot)) {
        return {
          ok: false,
          code: 6,
          detail: `capture refused: enrolled root '${entRoot}' does not match expected '${input.expectRoot}'`,
        };
      }
      const entLoc = String(entry.registry_location ?? "");
      if (entLoc !== input.expectRegistry) {
        return {
          ok: false,
          code: 6,
          detail: `capture refused: registry_location '${entLoc}' does not match expected '${input.expectRegistry}'`,
        };
      }
      let stat: Stats | undefined;
      try {
        stat = statSync(input.expectRegistry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          stat = undefined;
        } else {
          return {
            ok: false,
            code: 6,
            detail: `capture refused: acting registry '${input.expectRegistry}' could not be inspected (${(error as Error).message})`,
          };
        }
      }
      if (stat) {
        return {
          ok: false,
          code: 6,
          detail: `capture refused: acting registry '${input.expectRegistry}' still exists (team not fully stopped)`,
        };
      }
      const envelope = {
        authority: "live",
        team: input.team,
        entry,
        expected_root: input.expectRoot,
        registry_location: input.expectRegistry,
        index_root: input.indexHome ?? dirname(gpath),
        index_path: gpath,
      };
      try {
        atomicWrite(input.artifact, metaBytes(envelope as unknown as Parameters<typeof metaBytes>[0]));
      } catch (error) {
        return { ok: false, code: 3, detail: `capture artifact '${input.artifact}' could not be written (${(error as Error).message}); the machine-index entry was left enrolled` };
      }
      try {
        delete teams[input.team];
        fresh.teams = teams;
        atomicWrite(gpath, metaBytes(fresh as unknown as Parameters<typeof metaBytes>[0]));
      } catch (error) {
        // The capture artifact is the only copy of the removed key: an index
        // write that fails after the artifact landed PRESERVES it for manual
        // repair instead of throwing past the best-effort caller.
        return { ok: false, code: 3, detail: `global-registry '${gpath}' could not be written (${(error as Error).message}); the machine-index entry was left enrolled and the capture artifact is retained at '${input.artifact}'`, artifact: input.artifact };
      }
      return { ok: true, artifact: input.artifact };
    });
  } finally {
    sidecar.release();
  }
}

/**
 * Take a writer lock, turning an unopenable lock path into a typed failure
 * rather than a throw past best-effort callers (refresh warns and continues).
 * The retired Bash writer answered a sidecar open error with 3 and an index
 * lock open error with an uncaught traceback (1); `openCode` keeps each.
 */
function lockOrFailure(path: string, openCode: 1 | 3, busy: string, waitMs = Infinity): PaneLock | IndexDoorFailure {
  let lock: PaneLock | null;
  try {
    lock = acquirePathLock(path, waitMs);
  } catch (error) {
    return { ok: false, code: openCode, detail: `lock '${path}' could not be opened (${(error as Error).message})` };
  }
  return lock ?? { ok: false, code: 3, detail: busy };
}

/** A team key is an own property: `constructor` or `__proto__` never resolves through the prototype. */
function ownEntry(teams: Record<string, unknown>, team: string): unknown {
  return Object.prototype.hasOwnProperty.call(teams, team) ? teams[team] : undefined;
}

function isDictFresh(doc: unknown): doc is Record<string, unknown> {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc);
}

export interface IndexRestoreInput {
  team: string;
  artifact: string;
  indexHome?: string;
}

/**
 * H1 `tap_index_restore_team` port. Refuses (never overwrites) when the key
 * exists again, when authority moved, or when the restored acting-registry
 * file is not back on disk — the artifact is always retained so the operator
 * can inspect or retry. Caller owns artifact deletion on success.
 */
export function restoreTeamEnrollment(input: IndexRestoreInput): IndexDoorResult {
  const gpath = globalRegistryPath(input.indexHome);
  const indexHome = input.indexHome ?? dirname(gpath);
  let env: unknown;
  try {
    env = parseJsonPreserving(pyReadUtf8(input.artifact));
  } catch (error) {
    return { ok: false, code: 3, detail: `restore artifact '${input.artifact}' could not be read (${(error as Error).message})` };
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { ok: false, code: 4, detail: `restore artifact '${input.artifact}' does not carry live authority` };
  }
  const doc = env as Record<string, unknown>;
  if (doc.authority !== "live") {
    return { ok: false, code: 4, detail: `restore artifact '${input.artifact}' does not carry live authority` };
  }
  if (doc.team !== input.team) {
    return { ok: false, code: 4, detail: `restore artifact names team '${String(doc.team)}', not '${input.team}'` };
  }
  const ent = doc.entry;
  const loc = String(doc.registry_location ?? "");
  if (typeof ent !== "object" || ent === null || Array.isArray(ent) || !loc) {
    return { ok: false, code: 3, detail: `restore artifact '${input.artifact}' is missing its entry or registry path` };
  }
  const entry = ent as Record<string, unknown>;
  const expRoot = String(doc.expected_root ?? "");
  const entRoot = String(entry.root ?? "");
  if (!expRoot) {
    return { ok: false, code: 3, detail: `restore artifact '${input.artifact}' is missing its expected root; artifact kept at '${input.artifact}'` };
  }
  if (!entRoot || realOrSelf(entRoot) !== realOrSelf(expRoot)) {
    return {
      ok: false,
      code: 3,
      detail: `restore artifact '${input.artifact}' entry root '${entRoot}' disagrees with expected root '${expRoot}'; artifact kept at '${input.artifact}'`,
    };
  }
  if (String(entry.registry_location ?? "") !== loc) {
    return {
      ok: false,
      code: 3,
      detail: `restore artifact '${input.artifact}' entry registry location disagrees with its witness; artifact kept at '${input.artifact}'`,
    };
  }
  const capIndexRoot = String(doc.index_root ?? "");
  const capIndexPath = String(doc.index_path ?? "");
  if (!capIndexRoot || !capIndexPath) {
    return { ok: false, code: 3, detail: `restore artifact '${input.artifact}' is missing its index binding; artifact kept at '${input.artifact}'` };
  }
  if (realOrSelf(capIndexPath) !== realOrSelf(gpath) || realOrSelf(capIndexRoot) !== realOrSelf(indexHome)) {
    return {
      ok: false,
      code: 4,
      detail: `restore refused: artifact was captured against index '${capIndexPath}', not '${gpath}'; artifact kept at '${input.artifact}'`,
    };
  }
  const sidecar = acquirePathLock(`${loc}.lock`, Infinity);
  if (!sidecar) {
    return { ok: false, code: 3, detail: "acting-registry sidecar lock for restore failed (lock is held elsewhere)" };
  }
  try {
    if (!isRegularFile(loc)) {
      return { ok: false, code: 3, detail: `restore refused: acting registry '${loc}' is not back on disk; artifact kept at '${input.artifact}'` };
    }
    // H1 lock order for restore: acting-registry sidecar → teams.json.lock →
    // global-registry.json.lock (marker polarity serialized with Bash).
    const legacyLock = acquirePathLock(`${legacyTeamsPath(input.indexHome)}.lock`, Infinity);
    if (!legacyLock) {
      return { ok: false, code: 3, detail: "legacy index lock busy" };
    }
    try {
      const marker = flipMarkerState(input.indexHome);
      if (marker !== "live") {
        return {
          ok: false,
          code: 3,
          detail: marker === "invalid"
            ? `restore refused: machine index is no longer live v0.20; artifact kept at '${input.artifact}'`
            : `flip marker moved during restore; retry; artifact kept at '${input.artifact}'`,
        };
      }
      const idxLock = acquirePathLock(`${gpath}.lock`, Infinity);
      if (!idxLock) {
        return { ok: false, code: 3, detail: "index lock busy" };
      }
      try {
        const markerRecheck = flipMarkerState(input.indexHome);
        if (markerRecheck !== "live") {
          return {
            ok: false,
            code: 3,
            detail: markerRecheck === "invalid"
              ? `restore refused: machine index is no longer live v0.20; artifact kept at '${input.artifact}'`
              : `flip marker moved during restore; retry; artifact kept at '${input.artifact}'`,
          };
        }
        let fresh: unknown;
        try {
          fresh = parseJsonPreserving(pyReadUtf8(gpath));
        } catch (error) {
          return { ok: false, code: 3, detail: `global-registry '${gpath}' could not be read (${(error as Error).message}); artifact kept at '${input.artifact}'` };
        }
        if (!fresh || !isDictFresh(fresh)) {
          return { ok: false, code: 3, detail: `global-registry '${gpath}' could not be read; artifact kept at '${input.artifact}'` };
        }
        const teams = (isDictFresh(fresh.teams) ? fresh.teams : {}) as Record<string, unknown>;
        // Own-property semantics: a valid team name inherited from
        // Object.prototype ("constructor", "toString") must not read as
        // enrolled while its own key is absent, or the restore refuses and
        // the live team stays out of the machine index.
        if (Object.hasOwn(teams, input.team)) {
          return { ok: false, code: 2, detail: `restore refused: '${input.team}' is enrolled again; captured entry kept in '${input.artifact}'` };
        }
        teams[input.team] = entry;
        fresh.teams = teams;
        atomicWrite(gpath, metaBytes(fresh as unknown as Parameters<typeof metaBytes>[0]));
        return { ok: true };
      } finally {
        idxLock.release();
      }
    } finally {
      legacyLock.release();
    }
  } finally {
    sidecar.release();
  }
}
