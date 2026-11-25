// Checkpoint C groundwork: the CURRENT-authority machine-index writers register
// needs, ported from lib.sh's born-live bootstrap and live enroll arm with the
// checkpoint-C omission contract applied — the pre-flip teams.json route is
// omitted, an old store refuses BEFORE any write, and every document is held in
// the lossless JsonMap representation end to end (never cast to a plain object).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "./fsatomic";
import { validToken } from "./ids";
import { flipMarkerState, globalRegistryPath, legacyTeamsPath, SCHEMA } from "./index-home";
import { acquirePathLock, acquireRegistryLock } from "./panelock";
import { pyDumpIndent } from "./lossless-json";
import { pyReadUtf8 } from "./spool-publication";
import { isMap, loads, type JsonMap, type JsonValue } from "./watch-detect";

type Env = NodeJS.ProcessEnv;

function envHome(env: Env): string {
  return env.TAP_INDEX_HOME || join(env.HOME || realpathSync("."), ".tap");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
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

function canonicalRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

export type { GitRootProbe } from "./git-root";
export { probeGitRoot } from "./git-root";
import { probeGitRoot as probeGitRootMemoized } from "./git-root";

/** An operator's explicit consent, through `tap init` or a first launch, to
 *  index one named directory that is outside every git repository. */
export interface InitAuthorization {
  authorizedInitRoot?: string;
  /** `tap init --team <name>`: the team name a new enrollment uses in place of
   *  the one derived from the directory name. */
  team?: string;
}

const TEAM_NAME_RULE = "letters, digits, '_' or '-', starting with a letter or digit";

export type TeamNameChoice =
  | { ok: true; team: string; derivedFrom?: string }
  | { ok: false; refusal: EnrollmentRefusal };

/** An explicit --team must be launchable: a valid token without '.'. */
export function teamOverrideRefusal(override: string): EnrollmentRefusal | null {
  if (override === "" || (validToken(override) && !override.includes("."))) return null;
  return { errorClass: "invalid_team_name", action: `pass --team <name> using ${TEAM_NAME_RULE}`,
    detail: `--team '${override}' is not a launchable TAP team name` };
}

/** The team name a current-format registry at `root` already declares. */
function declaredTeamName(root: string): string {
  const path = teamRegistryPath(root);
  if (!currentShapedStore(path)) return "";
  try {
    const team = (loads(readFileSync(path, "utf8")) as JsonMap).get("team") as JsonMap;
    const name = team.get("name");
    return typeof name === "string" && validToken(name) ? name : "";
  } catch { return ""; }
}

/** The team name a new enrollment of `root` uses, so the registry's team.name
 *  and the index key always agree. A current team registry already at the root
 *  (for example after `tap admin retire`) keeps its declared name; a different
 *  --team refuses. A directory name that is already a valid token is the name byte for
 *  byte, so existing enrollments keep their key. Any other directory name
 *  derives a launchable slug: lowercased, each run of characters outside
 *  [a-z0-9_-] becomes one '-', and leading non-alphanumerics and trailing '-'
 *  are trimmed. A slug that comes out empty refuses and names --team. */
export function teamNameForRoot(root: string, override = ""): TeamNameChoice {
  const invalid = teamOverrideRefusal(override);
  if (invalid) return { ok: false, refusal: invalid };
  const canon = realOrSelf(root);
  const declared = declaredTeamName(canon);
  if (declared !== "" && override !== "" && override !== declared) {
    return { ok: false, refusal: { errorClass: "team_name_conflict",
      action: `pass --team ${declared}, or move ${teamRegistryPath(canon)} aside to start a fresh team, then retry`,
      detail: `${teamRegistryPath(canon)} already declares team '${declared}', not '${override}'` } };
  }
  if (declared !== "") return { ok: true, team: declared };
  if (override !== "") return { ok: true, team: override };
  const folder = basename(canon);
  if (validToken(folder)) return { ok: true, team: folder };
  const slug = folder.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  if (validToken(slug)) return { ok: true, team: slug, derivedFrom: folder };
  return { ok: false, refusal: { errorClass: "invalid_team_name", action: `pass --team <name> using ${TEAM_NAME_RULE}, then retry`,
    detail: `directory name '${folder}' yields no valid TAP team name` } };
}

/** The one-line notice init prints when the team name came from the folder. */
export function derivedTeamNotice(team: string, folder: string): string {
  return `team name: ${team} (derived from folder '${folder}'; override with --team <name>)`;
}

/** RULE 19 twin of `tap_index_root_indexable`: a root that cannot be resolved
 *  is not-indexable, never indexable. Positive git proof AND top-level, or an
 *  init-authorized root that git positively places outside every repository. */
export function rootIndexable(root: string, env: Env = process.env, opts: InitAuthorization = {}): boolean {
  // THE GIT HALF, positively proven: only a canonical top-level git worktree
  // enrolls; a nested path or an unobservable git state is not-indexable.
  const canon = canonicalRoot(root);
  if (!canon) return false;
  const git = probeGitRootMemoized(canon);
  if (git.kind === "unobservable") return false;
  const nonGit = git.kind === "none";
  if (nonGit) {
    // The single non-git door: the caller named THIS root as the one the
    // operator agreed to initialise, and git positively answers "not a
    // repository". A folder nested in a repository never reaches here.
    const authorized = opts.authorizedInitRoot !== undefined && canonicalRoot(opts.authorizedInitRoot) === canon;
    if (!authorized) return false;
  } else if (realOrSelf(git.top) !== canon) return false;
  // THE TAP_HOME OWNERSHIP HALF: the caller's bus must be the
  // canonical suffix of THIS root, resolved (compare resolved roots, not
  // spellings — symlinked homes and macOS /tmp -> /private/tmp are entitled).
  // Unknown suffixes, missing homes, failed resolves, and mismatches are
  // not-indexable: a custom bus root never becomes machine-index authority.
  const home = env.TAP_HOME ?? "";
  let homeRoot = "";
  if (home.endsWith("/.tap/bus")) homeRoot = home.slice(0, -"/.tap/bus".length);
  else return false;
  if (!homeRoot) return false;
  const canonHome = canonicalRoot(homeRoot);
  if (!canonHome) return false;
  return canonHome === canon;
}

/** `tap_index_enroll_preflight` twin: refuse only an UNSET index home whose
 *  canonical root lives under a system temporary directory. */
export function enrollPreflight(root: string, env: Env = process.env): { ok: true } | { ok: false; detail: string } {
  if (env.TAP_INDEX_HOME) return { ok: true };
  const canon = canonicalRoot(root);
  if (!canon) return { ok: true };
  const tempRoots = [tmpdir(), env.TMPDIR, env.TMP, env.TEMP, "/tmp"].filter(
    (t): t is string => typeof t === "string" && t !== "",
  ).map((t) => realOrSelf(t));
  const prefix = tempRoots.find((t) => canon === t || canon.startsWith(t.endsWith("/") ? t : `${t}/`));
  if (prefix) {
    return {
      ok: false,
      detail: "refusing system temporary root; next: set TAP_INDEX_HOME to a sandbox index and retry",
    };
  }
  return { ok: true };
}

export interface OldStoreEvidence {
  kind: "legacy_teams_json" | "bus_registry" | "agents_axis" | "launcher_manifest";
  path: string;
}

/** These detectors classify an absent-marker machine before bootstrap.
 * Current machines may retain historical stores; TAP never converts them. */
export function legacyAgentsAxisStore(path: string): boolean {
  try {
    const doc = loads(readFileSync(path, "utf8"));
    // Any "agents" key is the legacy axis: a current-looking "seats" map
    // beside it must not conceal it.
    return isMap(doc) && doc.has("agents");
  } catch {
    // An unreadable candidate is not old-store evidence; later stages refuse
    // on their own grounds.
    return false;
  }
}

/** A registry that passes teamRegistryDefect (a supported schema, a seats object, no
 * agents key, team an object when present) is current, not old store evidence — distinct from `legacyAgentsAxisStore`,
 * which only rules out the agents-only axis; this also rules out
 * unclassified/garbage content and a mixed legacy `agents` axis riding
 * alongside `seats` (still refusal-worthy, just not a MIGRATION concern —
 * tap-55gjp: a markerless `{schema, seats, agents}` document must not pass
 * as a kept pre-flip world and hide legacy occupants from registration). */
export function currentShapedStore(path: string): boolean {
  try {
    // The one current-format predicate; unreadable content is not current either.
    return teamRegistryDefect(loads(readFileSync(path, "utf8"))) === null;
  } catch {
    return false;
  }
}

/** A current bus registry.json that holds seats. No machine index enrolls it, so a
 * markerless first entry would orphan those seats beside a new team-registry.json:
 * every born-live door refuses instead of adopting it (F2d). Parsed with the same
 * lossless reader as currentShapedStore; only a regular file is opened. */
export function seatedBusRegistry(busHome: string): string | null {
  if (!busHome) return null;
  const path = join(busHome, "registry.json");
  if (!isRegularFile(path)) return null;
  try {
    const doc = loads(readFileSync(path, "utf8"));
    if (teamRegistryDefect(doc) !== null || !isMap(doc)) return null;
    const seats = doc.get("seats");
    return isMap(seats) && seats.size > 0 ? path : null;
  } catch {
    return null;
  }
}

export function unenrolledSeatsRefusal(path: string, root: string, retry: string): { errorClass: "unenrolled_seats"; action: string; detail: string } {
  return {
    errorClass: "unenrolled_seats",
    action: `enroll ${root} in global-registry.json by hand, or move it aside (mv ${path} ${path}.unenrolled), then rerun ${retry}`,
    detail: `${path} holds seats that no machine index enrolls`,
  };
}

export function oldStoreEvidence(
  indexHome: string,
  busHome: string,
  actingRegistryPath: string,
  env: Env = process.env,
): OldStoreEvidence[] {
  const found: OldStoreEvidence[] = [];
  const teamsJson = legacyTeamsPath(indexHome);
  if (isRegularFile(teamsJson)) found.push({ kind: "legacy_teams_json", path: teamsJson });
  // An empty bus/acting input must not probe a CWD-relative path.
  if (busHome) {
    const busRegistry = join(busHome, "registry.json");
    if (isRegularFile(busRegistry) && !currentShapedStore(busRegistry)) {
      found.push({ kind: "bus_registry", path: busRegistry });
    }
  }
  if (actingRegistryPath && legacyAgentsAxisStore(actingRegistryPath)) {
    found.push({ kind: "agents_axis", path: actingRegistryPath });
  }
  const home = env.HOME || realpathSync(".");
  const rawManifest = env.TAP_SESSION_MANIFEST || join(home, ".tap", "launcher", "sessions.json");
  const manifest = rawManifest.startsWith("~/") ? join(home, rawManifest.slice(2)) : rawManifest;
  if (isRegularFile(manifest)) found.push({ kind: "launcher_manifest", path: manifest });
  return found;
}

const OLD_STORE_REASONS: Record<OldStoreEvidence["kind"], string> = {
  legacy_teams_json: "pre-v0.20 teams.json machine index",
  bus_registry: "bus registry.json without the current schema",
  agents_axis: '"agents" map',
  launcher_manifest: "legacy launcher sessions.json manifest",
};

// New registries and the machine index retain schema 0.20. Accept the next team
// format before any writer starts recording a team-qualified forwarding edge.
const FORWARDING_TEAM_SCHEMA = "0.21";
const READABLE_TEAM_STORES = `team registries with a seats object and schema 0.20 or ${FORWARDING_TEAM_SCHEMA}`;
const TEAM_REGISTRY_SHAPE = '{"schema":"0.20","team":{...},"seats":{...}}';

/** Team/bus registries can be hand-edited into the current shape; machine and
 * launcher files have no current counterpart to edit into, so they move aside. */
const OLD_STORE_TEXT: Record<OldStoreEvidence["kind"], { reads: string; action: string }> = {
  agents_axis: {
    reads: `this TAP reads ${READABLE_TEAM_STORES}`,
    action: 'ask an agent to upgrade this file to the current format by hand (rename "agents" to "seats", add "schema": "0.20"), or move it aside and run tap init',
  },
  bus_registry: {
    reads: `this TAP reads ${READABLE_TEAM_STORES}`,
    action: `ask an agent to upgrade this file to the current format by hand (${TEAM_REGISTRY_SHAPE}: rename "agents" to "seats", add "schema": "0.20" and a "team" block), or move it aside and run tap init`,
  },
  legacy_teams_json: {
    reads: 'this TAP reads only the {"schema":"0.20","teams":{...}} machine index in global-registry.json',
    action: "move this file aside, then run tap init in each team root to enroll it",
  },
  launcher_manifest: {
    reads: "this TAP reads launch configuration only from team-registry seat rows",
    action: "move this file aside (or unset TAP_SESSION_MANIFEST), then relaunch the seats you still need",
  },
};

export function oldStoreAction(kind: OldStoreEvidence["kind"]): string {
  return OLD_STORE_TEXT[kind].action;
}

export function oldStoreRefusalText(path: string, kind: OldStoreEvidence["kind"]): string {
  return `${path} is an old TAP registry format (${OLD_STORE_REASONS[kind]}); ${OLD_STORE_TEXT[kind].reads} and never converts old files`;
}

const isDocObject = (v: unknown): boolean =>
  v instanceof Map || (typeof v === "object" && v !== null && !Array.isArray(v));

/** Why a parsed team registry is not in the current format, or null when it is.
 * Current means an object with a supported schema, a `seats` object, no
 * `agents` key, and `team` an object when present (a missing team is not an
 * old-format signal). Accepts the lossless Map codec and plain objects alike,
 * so every reader keeps its own parse and only asks this question. */
export function teamRegistryDefect(doc: unknown): string | null {
  if (!isDocObject(doc)) return "not a JSON object";
  const has = (key: string): boolean => doc instanceof Map ? doc.has(key) : Object.hasOwn(doc as object, key);
  const get = (key: string): unknown => doc instanceof Map ? doc.get(key) : (doc as Record<string, unknown>)[key];
  if (has("agents")) return OLD_STORE_REASONS.agents_axis;
  if (!has("schema")) return "no schema";
  const schema = get("schema");
  if (schema !== SCHEMA && schema !== FORWARDING_TEAM_SCHEMA) return `schema ${typeof schema === "string" ? JSON.stringify(schema) : String(schema)}`;
  if (!isDocObject(get("seats"))) return "seats not an object";
  if (has("team") && !isDocObject(get("team"))) return "team not an object";
  return null;
}

/** The old_store refusal for a parsed team registry, or null when it is current
 * or is not an object at all (malformed, not old).
 * Readers call this after their own successful parse; a missing file and an
 * unparseable one keep their existing handling. */
export function teamRegistryRefusal(path: string, doc: unknown): { errorClass: "old_store"; action: string; detail: string } | null {
  const reason = teamRegistryDefect(doc);
  // A non-object document is malformed, not an old format: its reader's own malformed class applies.
  if (reason === null || reason === "not a JSON object") return null;
  return {
    errorClass: "old_store",
    action: oldStoreAction("agents_axis"),
    detail: `${path} is an old TAP registry format (${reason}); ${OLD_STORE_TEXT.agents_axis.reads} and never converts old files`,
  };
}

/** The old_store refusal for the team registry file at `path`, or null. Only a
 * regular file that parses is judged: a missing, special or unparseable file
 * keeps whatever handling its reader already gives it. */
export function teamRegistryFileRefusal(path: string): { errorClass: "old_store"; action: string; detail: string } | null {
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(pyReadUtf8(path));
  } catch {
    return null;
  }
  return teamRegistryRefusal(path, doc);
}

/** The old_store refusal for modules below context.ts, which cannot import TapError. */
export class OldStoreError extends Error {
  readonly errorClass = "old_store";
  constructor(readonly action: string, readonly detail: string) { super(`old_store: ${detail}; next: ${action}`); }
}

/** True for any refusal carrying the old_store class, whatever its error type;
 * broad catch arms rethrow these instead of turning them into an empty result. */
export function isOldStoreRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // The launcher's TransactionError carries its class as tapErrorClass.
  const carrier = error as { errorClass?: unknown; tapErrorClass?: unknown };
  return carrier.errorClass === "old_store" || carrier.tapErrorClass === "old_store";
}

/** Why a registry writer must leave `doc` untouched, or null when it is writable.
 * A writable document is current (teamRegistryDefect); anything else — an
 * `agents` key, a missing or wrong schema, no seats object, a non-object team —
 * refuses as old_store. Callers check this under their lock, before any other
 * effect. */
export function registryWriteRefusal(path: string, doc: Record<string, unknown>): { errorClass: string; action: string; detail: string } | null {
  if ("agents" in doc) return { errorClass: "old_store", action: oldStoreAction("agents_axis"), detail: oldStoreRefusalText(path, "agents_axis") };
  // Writers and readers share one predicate: a seats-less document is old_store at every door.
  return teamRegistryRefusal(path, doc);
}

/** The removed migrator's stub has no file to classify, so it names every door. */
export const MIGRATE_REGISTRY_REMOVED = {
  detail: `tap admin migrate-registry was removed; this TAP reads ${READABLE_TEAM_STORES} and never converts old files`,
  action: 'ask an agent to upgrade an old team registry by hand (rename "agents" to "seats", add "schema": "0.20"); move an old teams.json or launcher sessions.json aside; then run tap init',
};

export type BornLiveOutcome =
  | { status: "live" }
  | { status: "not_indexable" }
  | { status: "refusal"; refusal: { kind: "invalid_marker" | "old_store" | "unenrolled_seats" | "operational"; path?: string; store?: OldStoreEvidence["kind"]; detail?: string } };

function emptyGlobalRegistry(): JsonMap {
  const doc: JsonMap = new Map<string, JsonValue>();
  doc.set("schema", SCHEMA);
  doc.set("teams", new Map<string, JsonValue>());
  return doc;
}

function readLossless(path: string): JsonMap | null {
  try {
    const doc = loads(readFileSync(path, "utf8"));
    return isMap(doc) ? doc : null;
  } catch {
    return null;
  }
}

function writeGlobalRegistry(doc: JsonMap, indexHome: string): { ok: true } | { ok: false; detail: string } {
  const gpath = globalRegistryPath(indexHome);
  try {
    mkdirSync(indexHome, { recursive: true });
    atomicWrite(gpath, `${pyDumpIndent(doc, 0)}\n`);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `born-live bootstrap could not write ${gpath}: ${(e as Error).message}` };
  }
}

function reclassifiedLive(indexHome: string): boolean {
  return globalRegistryState(indexHome) === "live";
}

function globalRegistryState(indexHome: string): "absent" | "live" | "invalid" {
  return flipMarkerState(indexHome);
}

/** Born-live bootstrap: create the current registry ONLY on a pristine machine.
 *  An old store refuses before any write (checkpoint-C omission contract). */
export function bornLiveBootstrap(root: string, env: Env = process.env, opts: InitAuthorization = {}): BornLiveOutcome {
  const indexHome = envHome(env);
  const state = globalRegistryState(indexHome);
  if (state === "live") return { status: "live" };
  if (state === "invalid") {
    return { status: "refusal", refusal: { kind: "invalid_marker" } };
  }
  if (!rootIndexable(root, env, opts)) return { status: "not_indexable" };
  // Absent marker: an old store (teams.json, a bus registry) means the machine
  // predates the flip — refuse, name the store, change nothing.
  const evidence = oldStoreEvidence(indexHome, "", "", env);
  if (evidence.length > 0) {
    return { status: "refusal", refusal: { kind: "old_store", path: evidence[0]!.path, store: evidence[0]!.kind } };
  }
  // rootIndexable pinned TAP_HOME to this root's canonical bus.
  const seated = seatedBusRegistry(env.TAP_HOME ?? "");
  if (seated) return { status: "refusal", refusal: { kind: "unenrolled_seats", path: seated } };
  try {
    mkdirSync(indexHome, { recursive: true });
    const lock = acquirePathLock(join(indexHome, "teams.json.lock"), Infinity, env);
    if (!lock) return { status: "refusal", refusal: { kind: "operational", detail: "could not lock the machine index" } };
    try {
      // Another first entrant may have published and enrolled while we waited.
      const lockedState = globalRegistryState(indexHome);
      if (lockedState === "live") return { status: "live" };
      if (lockedState !== "absent") return { status: "refusal", refusal: { kind: "invalid_marker" } };
      const lockedEvidence = oldStoreEvidence(indexHome, "", "", env);
      if (lockedEvidence.length > 0) return { status: "refusal", refusal: { kind: "old_store", path: lockedEvidence[0]!.path, store: lockedEvidence[0]!.kind } };
      const lockedSeated = seatedBusRegistry(env.TAP_HOME ?? "");
      if (lockedSeated) return { status: "refusal", refusal: { kind: "unenrolled_seats", path: lockedSeated } };
      const write = writeGlobalRegistry(emptyGlobalRegistry(), indexHome);
      if (!write.ok) return { status: "refusal", refusal: { kind: "operational", detail: write.detail } };
      if (!reclassifiedLive(indexHome)) {
        return {
          status: "refusal",
          refusal: {
            kind: "operational",
            detail: `born-live bootstrap wrote ${globalRegistryPath(indexHome)} but it does not classify live`,
          },
        };
      }
      return { status: "live" };
    } finally { lock.release(); }
  } catch (error) {
    return { status: "refusal", refusal: { kind: "operational", detail: String(error) } };
  }
}

export type EnrollRefusalKind =
  | "temporary_root"
  | "invalid_flip"
  | "enroll_retry"
  | "name_collision"
  | "ambiguous_root"
  | "enroll_failed";

export type EnrollOutcome =
  | { ok: true; skipped?: boolean }
  | { ok: false; kind: EnrollRefusalKind; detail: string };

function teamsEntry(doc: JsonMap): JsonMap | null {
  const teams = doc.get("teams");
  return isMap(teams) ? teams : null;
}

function entryRoot(ent: JsonValue): string {
  return isMap(ent) ? String(ent.get("root") ?? "") : "";
}

function entryState(ent: JsonValue): string {
  return isMap(ent) ? String(ent.get("state") ?? "registered") : "registered";
}

function entryStoredLoc(ent: JsonValue): string {
  return isMap(ent) ? String(ent.get("registry_location") ?? "") : "";
}

function entryEnrolledAt(ent: JsonValue): string {
  return isMap(ent) ? String(ent.get("enrolled_at") ?? "") : "";
}

function asEntry(ent: JsonValue): JsonMap {
  return isMap(ent) ? ent : new Map<string, JsonValue>();
}

/** Match the canonical root against the doc's teams map the way the incumbent
 *  enroll writer does: skip historical entries, match by real path, report
 *  ambiguity rather than picking a winner. */
function enrolledEntryForRoot(
  doc: JsonMap,
  rootReal: string,
): { status: "ok"; name: string; entry: JsonMap; storedLoc: string } | { status: "ambiguous" } | { status: "missing" } {
  const teams = teamsEntry(doc);
  if (!teams) return { status: "missing" };
  const hits: Array<{ name: string; entry: JsonMap; storedLoc: string }> = [];
  for (const [name, ent] of teams.entries()) {
    if (!isMap(ent)) continue;
    if (entryState(ent) === "historical") continue;
    const entRoot = entryRoot(ent);
    if (!entRoot) continue;
    if (realOrSelf(entRoot) !== rootReal) continue;
    hits.push({ name, entry: ent, storedLoc: entryStoredLoc(ent) });
  }
  if (hits.length === 0) return { status: "missing" };
  if (hits.length > 1) return { status: "ambiguous" };
  const hit = hits[0]!;
  return { status: "ok", name: hit.name, entry: hit.entry, storedLoc: hit.storedLoc };
}

function collisionDetail(key: string, oldRoot: string, root: string): string {
  return `team '${key}' is already indexed at a different path (${oldRoot}, not ${root}) — run ` +
    `'tap admin retire ${key}' to de-enroll the stale entry, or rename one team`;
}

/** The live enroll arm of `tap_index_enroll_team`: alias keys and stored
 *  registry_locations are preserved; every refusal is mapped, and an
 *  infrastructure failure never reads as success. */
export function enrollTeam(root: string, registryLocation: string, env: Env = process.env, opts: InitAuthorization = {}): EnrollOutcome {
  if (!rootIndexable(root, env, opts)) return { ok: true, skipped: true };
  const preflight = enrollPreflight(root, env);
  if (!preflight.ok) return { ok: false, kind: "temporary_root", detail: preflight.detail };
  const chosen = teamNameForRoot(root, opts.team);
  // The team-name gate: a root with no valid team name is left unenrolled
  // (skip WITHOUT any index write), never an invalid key.
  if (!chosen.ok) return { ok: true, skipped: true };
  const name = chosen.team;
  const indexHome = envHome(env);
  mkdirSync(indexHome, { recursive: true });
  const indexLock = acquirePathLock(join(indexHome, "teams.json.lock"), Infinity, env);
  if (!indexLock) {
    return { ok: false, kind: "enroll_failed", detail: "could not acquire the machine-index lock" };
  }
  try {
    let state = globalRegistryState(indexHome);
    if (state === "invalid") {
      return { ok: false, kind: "invalid_flip", detail: "global-registry.json is present but unreadable or wrong schema" };
    }
    const teamsJson = legacyTeamsPath(indexHome);
    if (state === "absent") {
      // BORN LIVE inside enroll: a machine holding NEITHER store is new, not
      // pre-flip. An old store here is the pre-write refusal, again.
      if (isRegularFile(teamsJson)) {
        return { ok: false, kind: "invalid_flip", detail: oldStoreRefusalText(teamsJson, "legacy_teams_json") };
      }
      const write = writeGlobalRegistry(emptyGlobalRegistry(), indexHome);
      if (!write.ok) return { ok: false, kind: "enroll_failed", detail: write.detail };
      state = globalRegistryState(indexHome);
      if (state !== "live") {
        return {
          ok: false,
          kind: "invalid_flip",
          detail: `bootstrapped global-registry.json but the flip marker did not classify live (got ${state}) — refusing enroll`,
        };
      }
    }
    if (state !== "live") {
      return { ok: false, kind: "invalid_flip", detail: "global-registry.json is present but unreadable or wrong schema" };
    }
    const gpath = globalRegistryPath(indexHome);
    const globalLock = acquirePathLock(`${gpath}.lock`, Infinity, env);
    if (!globalLock) {
      return { ok: false, kind: "enroll_failed", detail: "could not acquire the global-registry lock" };
    }
    try {
      // Marker can still move between the two locks; recheck again.
      if (globalRegistryState(indexHome) !== "live") {
        return { ok: false, kind: "enroll_retry", detail: "flip marker moved during enroll — retry" };
      }
      const doc = readLossless(gpath) ?? emptyGlobalRegistry();
      if (doc.get("schema") !== SCHEMA) {
        return { ok: false, kind: "invalid_flip", detail: `global-registry schema is not ${SCHEMA}; refusing enroll` };
      }
      if (!doc.has("teams")) doc.set("teams", new Map<string, JsonValue>());
      const teams = doc.get("teams");
      if (!isMap(teams)) {
        return {
          ok: false,
          kind: "invalid_flip",
          detail: "global-registry.json 'teams' is not an object — refusing enroll (would erase prior enrollments)",
        };
      }
      const rootReal = realOrSelf(root);
      // The index stores the CANONICAL root (the incumbent canonicalizes
      // before its writer); symlink/relative spellings never persist.
      const canonical = rootReal;
      const match = enrolledEntryForRoot(doc, rootReal);
      if (match.status === "ambiguous") {
        return { ok: false, kind: "ambiguous_root", detail: `multiple global enrollments for root ${root} — refusing enroll` };
      }
      let enrollKey = name;
      let storedLoc = "";
      if (match.status === "ok") {
        enrollKey = match.name;
        storedLoc = match.storedLoc;
      }
      // The collision arm reads the entry under the CHOSEN key (the incumbent
      // reads teams.get(enroll_key)): a root-match supplies the alias, a
      // missing match still checks the plain-name entry for a different home.
      const ent = teams.has(enrollKey) && isMap(teams.get(enrollKey)) ? teams.get(enrollKey) as JsonMap : new Map<string, JsonValue>();
      const oldRoot = entryRoot(ent);
      if (oldRoot && realOrSelf(oldRoot) !== rootReal && isDir(oldRoot)) {
        return {
          ok: false,
          kind: "name_collision",
          detail: collisionDetail(enrollKey, oldRoot, canonical),
        };
      }
      const useLoc = match.status === "ok" && storedLoc ? storedLoc : registryLocation;
      try {
        atomicWrite(gpath, enrollmentBytes(doc, teams, enrollKey, canonical, useLoc));
      } catch (e) {
        return { ok: false, kind: "enroll_failed", detail: `could not write ${gpath}: ${(e as Error).message}` };
      }
      return { ok: true };
    } finally {
      globalLock.release();
    }
  } finally {
    indexLock.release();
  }
}

/** The writer and preview share field defaults and lossless index serialization. */
function enrollmentBytes(doc: JsonMap, teams: JsonMap, key: string, root: string, registryLocation: string): string {
  const ent = asEntry(teams.get(key) ?? null);
  const next = new Map<string, JsonValue>(ent);
  next.set("root", root);
  next.set("registry_location", registryLocation);
  next.set("state", ent.get("state") ?? "registered");
  next.set("enrolled_at", ent.get("enrolled_at") ?? nowIso());
  teams.set(key, next);
  return `${pyDumpIndent(doc, 0)}\n`;
}

/** Read-only forecast for the re-enrollment that follows registry recovery. */
export function enrollmentWouldChange(root: string, name: string, registryLocation: string, env: Env = process.env): boolean {
  const path = globalRegistryPath(envHome(env));
  const doc = readLossless(path);
  const teams = doc?.get("teams");
  if (!doc || !isMap(teams)) throw new Error("cannot preview an unreadable machine index");
  const canonical = realOrSelf(root), match = enrolledEntryForRoot(doc, canonical);
  if (match.status === "ambiguous") throw new Error("cannot preview an ambiguous enrollment");
  const key = match.status === "ok" ? match.name : name;
  const location = match.status === "ok" && match.storedLoc ? match.storedLoc : registryLocation;
  return readFileSync(path, "utf8") !== enrollmentBytes(doc, teams, key, canonical, location);
}

export function teamRegistryPath(teamDir: string): string {
  return join(teamDir, ".tap", "team-registry.json");
}

/** Write the current-format empty team registry for `root` under `name`. */
export function writeEmptyTeamRegistry(path: string, name: string, root: string): void {
  const head = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  const branch = head.status === 0 && head.stdout.trim() ? head.stdout.trim() : "unknown";
  const doc = new Map<string, JsonValue>([
    ["schema", SCHEMA],
    ["team", new Map<string, JsonValue>([
      ["branch_at_bootstrap", branch], ["created_at", nowIso()],
      ["name", name], ["schema_version", "1"], ["worktree_root", root],
    ])],
    ["seats", new Map<string, JsonValue>()],
  ]);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${pyDumpIndent(doc, 0).replace(/\u007f/g, "\\u007f")}\n`);
}

export interface EnrollmentRefusal { errorClass: string; action: string; detail: string }

/** Only for a root with no machine enrollment; existing teams retain their state. */
export function unownedInitStateRefusal(root: string): EnrollmentRefusal | null {
  const paths: string[] = [], directory = join(root, ".tap"), bus = join(directory, "bus");
  const add = (path: string) => { if (paths.length < 8) paths.push(path); };
  const tap = lstatSync(directory, { throwIfNoEntry: false });
  if (tap && !tap.isDirectory()) add(directory);
  else {
    const ignore = join(directory, ".gitignore"), ignoreStat = lstatSync(ignore, { throwIfNoEntry: false });
    if (ignoreStat && (!ignoreStat.isFile() || ignoreStat.nlink !== 1)) add(ignore);
    const registry = teamRegistryPath(root), stat = lstatSync(registry, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1) add(registry);
      else {
        const seats = readLossless(registry)?.get("seats");
        if (isMap(seats) && seats.size > 0) add(registry);
      }
    }
    const inspect = (path: string, depth: number): void => {
      if (paths.length >= 8) return;
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return;
      // A failed first init can leave this empty bootstrap skeleton behind.
      if (path === join(bus, ".tap-bus-authority") && stat.isFile() && stat.nlink === 1) return;
      if (!stat.isDirectory() || depth >= 4) { add(path); return; }
      const entries = readdirSync(path).sort();
      const skeletonDirectory = path === bus || path === join(bus, "payloads") || path === join(bus, "receipts");
      if (!entries.length && !skeletonDirectory) add(path);
      for (const entry of entries) {
        if (paths.length >= 8) break;
        inspect(join(path, entry), depth + 1);
      }
    };
    inspect(bus, 0);
  }
  return paths.length ? {
    errorClass: "preexisting_tap_state",
    action: "inspect the listed paths, then move the pre-existing TAP state aside before rerunning tap init",
    detail: `this root is not enrolled on this machine; refusing existing TAP state: ${paths.map(path => JSON.stringify(path).replace(/[\u007f-\u009f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)).join(", ")}`,
  } : null;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Every refusal a NEW enrollment of `root` can predict, decided before its
 *  first write: the team name (teamNameForRoot), index eligibility, the temporary-root
 *  preflight, a canonical team registry that exists but is not current, and a
 *  team name already indexed at another live root. enrollTeam re-checks the
 *  collision under the lock; this read only moves the predictable refusal
 *  ahead of every effect. */
export function newEnrollmentRefusal(root: string, env: Env = process.env, opts: InitAuthorization = {}): EnrollmentRefusal | null {
  const canon = realOrSelf(root);
  const chosen = teamNameForRoot(canon, opts.team);
  if (!chosen.ok) return chosen.refusal;
  const team = chosen.team;
  if (!rootIndexable(canon, env, opts)) {
    return { errorClass: "not_indexable", action: "run tap init from the repository top level", detail: `${canon} cannot be enrolled in the machine index` };
  }
  const pre = enrollPreflight(canon, env);
  if (!pre.ok) {
    return { errorClass: "temporary_root", action: "set TAP_INDEX_HOME to a sandbox index and retry", detail: `refusing system temporary root ${canon}` };
  }
  const path = teamRegistryPath(canon);
  if (legacyAgentsAxisStore(path)) return { errorClass: "old_store", action: oldStoreAction("agents_axis"), detail: oldStoreRefusalText(path, "agents_axis") };
  if ((existsSync(path) || isSymlink(path)) && !currentShapedStore(path)) {
    return teamRegistryFileRefusal(path)
      ?? { errorClass: "registry_invalid", action: "tap doctor", detail: `${path} is not a current ${TEAM_REGISTRY_SHAPE} team registry` };
  }
  const indexHome = envHome(env);
  if (globalRegistryState(indexHome) === "live") {
    const doc = readLossless(globalRegistryPath(indexHome));
    const teams = doc ? teamsEntry(doc) : null;
    if (doc && teams && enrolledEntryForRoot(doc, canon).status === "missing") {
      const oldRoot = entryRoot(teams.get(team) ?? null);
      if (oldRoot && realOrSelf(oldRoot) !== canon && isDir(oldRoot)) {
        return { errorClass: "name_collision", action: "tap doctor", detail: collisionDetail(team, oldRoot, canon) };
      }
    }
  }
  return null;
}

export type BootstrapEnrollOutcome =
  | { ok: true; path: string; team: string; derivedFrom?: string }
  | ({ ok: false } & EnrollmentRefusal);

/** tap_bootstrap_postflip_enroll twin: the canonical current-format team
 *  registry plus its machine-index enrollment. Every predictable refusal lands
 *  before the first write, so a refused root is left exactly as it was found. */
export function bootstrapPostflipEnroll(root: string, env: Env = process.env, opts: InitAuthorization = {}): BootstrapEnrollOutcome {
  const canon = realOrSelf(root);
  const refusal = newEnrollmentRefusal(canon, env, opts);
  if (refusal) return { ok: false, ...refusal };
  const chosen = teamNameForRoot(canon, opts.team);
  if (!chosen.ok) return { ok: false, ...chosen.refusal };
  const team = chosen.team;
  const path = teamRegistryPath(canon);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const lock = acquireRegistryLock(path, Infinity);
    if (!lock) return { ok: false, errorClass: "registry_busy", action: "retry", detail: `could not lock ${path}` };
    try {
      if (!existsSync(path)) writeEmptyTeamRegistry(path, team, canon);
      else if (!currentShapedStore(path)) {
        return { ok: false, ...(teamRegistryFileRefusal(path)
          ?? { errorClass: "registry_invalid", action: "tap doctor", detail: `${path} is not a current ${TEAM_REGISTRY_SHAPE} team registry` }) };
      }
    } finally { lock.release(); }
  } catch (error) {
    return { ok: false, errorClass: "registry_unreachable", action: "tap doctor", detail: `could not create ${path}: ${(error as Error).message}` };
  }
  const out = enrollTeam(canon, path, env, opts);
  if (!out.ok) return { ok: false, errorClass: out.kind, action: "tap doctor", detail: out.detail };
  if (out.skipped) return { ok: false, errorClass: "not_indexable", action: "tap doctor", detail: `${canon} was not enrolled in the machine index` };
  return { ok: true, path, team, ...(chosen.derivedFrom ? { derivedFrom: chosen.derivedFrom } : {}) };
}
