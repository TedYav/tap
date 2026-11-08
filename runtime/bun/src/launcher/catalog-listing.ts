/**
 * The catalog LISTING: every preset in a config document, the ones that were
 * dropped and why, and the per-handle facts the roster surfaces read.
 *
 * This is the half `presets.py` owned and no TypeScript answered -- the oracle
 * measured 63 unsupported operations and 90 unexpressible fields against the
 * pinned incumbent, almost all of them here. Three readers collapse into it:
 * `verbs/presets.ts`'s private display rows, `verbs/team.ts`'s Python
 * `PRESET_READER` subprocess, and `presets.py` itself.
 *
 * DEGRADE AT THE SMALLEST SCOPE THAT STILL MAKES SENSE. A config is its owner's
 * to extend, and a reader that refuses what it does not recognize turns every
 * extension into an outage -- that happened, for four minutes, across a whole
 * machine. So: understand what you can, ignore what you cannot, and always SAY
 * which. Silence is the other failure; a dropped section nobody mentions is
 * indistinguishable from one that was never written.
 */
import { addParams, HARNESSES, environment, hasUtf8Bom, presetEnvRefusals, pyParams, table, type Params, type Table } from "./catalog";
import { parseAdvancedSettings, type AdvancedSettings } from "../config-file";
import { LauncherError } from "./types";
import type { Notices } from "./catalog-notices";
import { join as joinPath } from "node:path";
import { realpathSync } from "node:fs";

/** Both paths RESOLVED: mixing forms puts /var/... beside /private/var/... in one sentence. */
const realpathOr = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
import { INTELLIGENCE_NAME, metadataToJson, parseMetadata, presetModelFamily, pyBlank, pyStrip, RETIRED_ROLES, ROLE_NAME, type Metadata } from "./catalog-metadata";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const PRESET_KEYS = new Set(["harness", "params", "env", "description", "family", "metadata"]);

export type ResolvedPreset = {
  harness: string; model: string | null; harness_passthrough: string[];
  /**
   * The VALIDATED params, unrendered. `harness_passthrough` is the rendering and
   * it is lossy the way the incumbent's docstring says param_keys exists to undo;
   * the launch path composes these with argv (addParams) rather than re-parsing
   * a rendered token list, which is what the second reader used to do.
   */
  params: Params;
  env: Record<string, string>; family: string | null; note: string | null;
  description: string | null; metadata: Metadata | null; param_keys: string[];
  provenance: { name: string; source_path: string; config_digest: string };
};
export type Catalog = {
  advanced?: AdvancedSettings;
  source_path: string;
  presets: Map<string, ResolvedPreset>;
  /** Presets that ARE in the file but could not be made sense of, with the reason. */
  dropped: Map<string, string>;
  /** null means the file has no [roles] table -- distinct from an empty one. */
  roles: Record<string, string> | null;
  /**
   * The document's own `version`, exactly as parsed -- retained so a CONSUMER can
   * apply a version policy without re-opening the file. `tap session launch`
   * with a requested preset refuses a retired catalog (CONTRACT.md:1794); that
   * is the launch path's rule, not the reader's, and the reader stays tolerant.
   */
  version: unknown;
  /**
   * The `[harness.*]` policy table as read from THIS document. It rides the
   * catalog because it is the same file, read once: the launch path used to
   * re-open and re-parse config.toml to reach it, which is precisely how a
   * second reader (with its own version arms and its own legacy check) grew.
   */
  harnessPolicy: Table;
  /**
   * Where the POLICY came from, which is not always where the presets came from.
   *
   * In the legacy fallback the presets are read from `presets.toml` while
   * `[harness.*]` still comes from `config.toml` — the comment at the fallback
   * return has said so all along. Reusing `source_path` for a policy refusal
   * therefore told the operator to edit `presets.toml` for a key they wrote in
   * `config.toml`: the wrong-file defect an earlier change had just removed, reintroduced
   * one member later by the fix that made refusals name their file.
   */
  harnessPolicySource: string;
};

class PresetUnusable extends Error {
  readonly errorClass = "preset_config_invalid";
  constructor(readonly detail: string) { super(detail); }
}

/**
 * The incumbent's `dropped[name] = exc.detail` (presets.py:1259): a classed
 * refusal contributes ITS detail, never a re-wrap. A bare error keeps its
 * message, which is the pre-existing behavior for non-refusal throws.
 */
const refusedDetail = (error: unknown): string => {
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : String((error as Error).message);
};

function resolveOne(name: string, raw: unknown, sourcePath: string, digest: string): ResolvedPreset {
  // The incumbent routes every schema refusal through `_invalid(path, detail)`
  // (presets.py:430), so the DROPPED REASON this tier publishes is the wrapped
  // text, prefix and all. A dropped preset's reason reaches `catalog.dropped`,
  // the degrade notice, and `requirePreset`'s refusal verbatim — the Python
  // facade's observable behavior is CONTRACT, so the composition is repeated
  // here rather than re-derived with a native-shaped shortcut.
  const invalid = (detail: string): PresetUnusable =>
    new PresetUnusable(`invalid preset config ${sourcePath}: ${detail}`);
  if (!table(raw)) throw invalid(`preset '${name}' must be a table`);
  const unknown = Object.keys(raw).filter(key => !PRESET_KEYS.has(key)).sort();
  if (unknown.length) throw invalid(`preset '${name}' has unknown key '${unknown[0]}'`);

  const harness = raw.harness;
  if (typeof harness !== "string" || !HARNESSES.includes(harness)) {
    throw invalid(
      `preset '${name}' harness must be one of: ${[...HARNESSES].sort().join(", ")}; got '${harness}'`);
  }
  let params: Params;
  // `pyParams`, not `parameters()`: the preset tier publishes the incumbent's
  // `_parse_params` diagnostics (`preset 'x' params.k must be a boolean, ...`),
  // which are the CONTRACT surfaces here; `parameters()`'s own drop texts are a
  // different, pre-existing native surface with other callers.
  try { params = pyParams(raw.params, `preset '${name}'`, sourcePath); }
  catch (error) { throw new PresetUnusable(refusedDetail(error)); }

  const model = params.model;
  if (typeof model === "boolean") {
    throw invalid(`preset '${name}' params.model must be a string, not a boolean`);
  }
  // description is checked BEFORE the env fence, so a doubly-invalid preset
  // reports the description refusal ahead of a fenced key rather than pointing
  // the operator at the security-relevant one first.
  if ("description" in raw && typeof raw.description !== "string") {
    throw invalid(`preset '${name}' field 'description' must be a string`);
  }
  let env: Record<string, string>;
  try { env = environment(raw.env, "preset_env_forbidden", presetEnvRefusals(name, sourcePath)); }
  catch (error) { throw new PresetUnusable(refusedDetail(error)); }

  const family = raw.family;
  if (family !== undefined && family !== null &&
      (typeof family !== "string" || pyBlank(family) || CONTROL.test(family))) {
    throw invalid(`preset '${name}' field 'family' must be a non-empty string`);
  }
  // `model` leaves the passthrough only when it is a scalar; a LIST-valued model
  // still renders, so it stays.
  const extra: Params = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    if (key !== "model" || Array.isArray(value)) extra[key] = value;
  }
  return {
    harness, model: typeof model === "string" ? model : null,
    params, harness_passthrough: addParams([], extra),
    // Only keys that actually RENDER. A false value emits nothing and collides
    // with nothing -- carrying it here made `tap ask` refuse a preset that
    // explicitly DISABLES a builder flag, the opposite of the conflict the
    // guard exists to catch.
    param_keys: Object.entries(extra)
      .filter(([, value]) => value !== false && !(Array.isArray(value) && !value.length))
      .map(([key]) => key),
    env, family: typeof family === "string" ? family : null, note: null,
    description: typeof raw.description === "string" ? raw.description : null,
    metadata: parseMetadata(name, raw.metadata, detail => degradeSink(sourcePath, detail)),
    provenance: { name, source_path: sourcePath, config_digest: digest },
  };
}

// The active degrade sink. Set per parse so metadata notices reach the caller's
// notice channel rather than a module-global one.
let degradeSink: (sourcePath: string, message: string) => void = () => {};

/**
 * Does this parsed table have this key AS ITS OWN?
 *
 * `key in table` also answers yes for everything on `Object.prototype`, so a
 * preset declaring `family = "toString"` bound the inherited FUNCTION as its
 * note and suppressed the missing-entry warning at the same time -- the launch
 * would have printed `function toString() { [native code] }` where an operator
 * annotation belongs. The same reasoning covers `[roles]` and `[intelligences]`:
 * an operator must not be able to name a JavaScript internal and have this
 * reader treat it as vocabulary they defined.
 *
 * Every lookup into an operator-authored table goes through here. A value read
 * out of one is only real if the table owns the key.
 */
const owns = (table: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

export function catalogFromDocument(
  document: Record<string, unknown>, rawPresets: Record<string, unknown>,
  sourcePath: string, digest: string, notice: (message: string) => void,
): Catalog {
  const degrade = (path: string, message: string) =>
    notice(`tap config: ${message} in ${path} — ignoring it and continuing`);
  degradeSink = degrade;

  // The retired layout puts model/effort at preset top level, so parsing it under
  // current rules yields "unknown key 'effort'" -- which tells a stranded operator
  // to DELETE the key when the remedy is to migrate the file. The version notice
  // already said the useful thing.
  if (isRetiredVersion(document.version)) rawPresets = {};

  let notes: Record<string, string> | null = null;
  if (document.notes !== undefined && document.notes !== null) {
    if (!table(document.notes)) {
      degrade(sourcePath, "[notes] is not a table");
    } else {
      // Null-prototype: keyed by operator-authored [notes] names.
      const usable: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(document.notes)) {
        if (typeof value === "string") usable[key] = value;
      }
      for (const key of Object.keys(document.notes).sort()) {
        if (!(key in usable)) degrade(sourcePath, `notes.${key} is not a usable string`);
      }
      notes = usable;
    }
  }

  const presets = new Map<string, ResolvedPreset>();
  const dropped = new Map<string, string>();
  for (const [name, raw] of Object.entries(rawPresets)) {
    if (typeof name !== "string" || !NAME.test(name) || CONTROL.test(name)) {
      degrade(sourcePath, `unusable preset name '${name}'`);
      continue;
    }
    if (HARNESSES.includes(name)) {
      // Dropped rather than refused, so preset-first lookup MISSES it and falls
      // through to the harness -- the behavior the old hard refusal guaranteed,
      // with no refusal anywhere.
      const reason = `it is named after the canonical harness '${name}', so it could ` +
        "never be addressed distinctly; rename it to use it";
      dropped.set(name, reason);
      degrade(sourcePath, `preset '${name}' was dropped: ${reason}`);
      continue;
    }
    try {
      presets.set(name, resolveOne(name, raw, sourcePath, digest));
    } catch (error) {
      const detail = error instanceof PresetUnusable ? error.detail : String((error as Error).message);
      dropped.set(name, detail);
      degrade(sourcePath, `preset '${name}' is not usable (${detail})`);
    }
  }

  // `family` binds a preset to its [notes] entry, checked HERE where the notes
  // table is in hand. An unbound family costs the NOTE, not the preset: the seat
  // launches identically, so refusing would withhold working presets over a
  // missing sentence. No notes table AT ALL only warns -- an operator who has
  // not written notes yet can never be blocked.
  const families = [...new Set([...presets.values()].map(p => p.family).filter(Boolean))].sort();
  if (families.length && notes === null) {
    notice(`tap session: preset 'family' is set in ${sourcePath} (${families.join(", ")}) ` +
      "but the file has no [notes] table, so no notes are loaded; add [notes] with those keys or remove 'family'");
  } else if (families.length && notes) {
    for (const name of [...presets.keys()].sort()) {
      const preset = presets.get(name)!;
      if (!preset.family) continue;
      if (!owns(notes, preset.family)) {
        degrade(sourcePath, `preset '${name}' family '${preset.family}' has no [notes] entry ` +
          `(known: ${Object.keys(notes).sort().join(", ") || "none"}), so it carries no note`);
        continue;
      }
      presets.set(name, { ...preset, note: notes[preset.family]! });
    }
  }
  // `[roles]` is the VOCABULARY for metadata role lists, and `[intelligences]`
  // for `metadata.intelligence`. Both bind on the same three arms.
  //
  // ROLES ARE HINTS, NOT FENCES. An undefined role says something about the
  // briefing text, never about whether the seat can launch -- so it is said out
  // loud and the catalog still loads. A vocabulary typo must not take down
  // preset resolution for the whole machine.
  const roles = parseRoles(document, sourcePath, degrade);
  const referenced = [...new Set([...presets.values()].flatMap(p =>
    p.metadata ? [...p.metadata.primary_roles, ...p.metadata.secondary_roles,
                  ...p.metadata.avoid_roles, ...p.metadata.banned_roles] : []))].sort();
  if (referenced.length && roles === null) {
    degrade(sourcePath, `metadata names roles (${referenced.join(", ")}) but there is no [roles] table`);
  } else if (roles !== null) {
    const known = Object.keys(roles).sort().join(", ") || "(none)";
    for (const name of [...presets.keys()].sort()) {
      const meta = presets.get(name)!.metadata;
      if (!meta) continue;
      const own = [...new Set([...meta.primary_roles, ...meta.secondary_roles,
                               ...meta.avoid_roles, ...meta.banned_roles])].sort();
      for (const role of own) {
        if (!owns(roles, role)) {
          degrade(sourcePath, `preset '${name}' names role '${role}', which has no [roles] entry (known: ${known})`);
        }
      }
    }
  }

  // NO VERSION GATE on [intelligences]. An earlier draft made it v3-only, which
  // was right under a contract where an unknown table refused the file -- the
  // live machine config is v2 today, carrying every metadata.intelligence value
  // with no table. Once nothing refuses, the gate stops protecting anything and
  // only adds a rule someone has to know.
  const levels = parseIntelligences(document, sourcePath, degrade);
  const named = [...new Set([...presets.values()]
    .map(p => p.metadata?.intelligence).filter((v): v is string => !!v))].sort();
  if (named.length && levels === null) {
    degrade(sourcePath, `metadata names intelligence levels (${named.join(", ")}) but there is no [intelligences] table`);
  } else if (levels !== null) {
    const known = Object.keys(levels).sort().join(", ") || "(none)";
    for (const name of [...presets.keys()].sort()) {
      const meta = presets.get(name)!.metadata;
      if (!meta?.intelligence) continue;
      if (!(meta.intelligence in levels)) {
        degrade(sourcePath, `preset '${name}' names intelligence '${meta.intelligence}', ` +
                `which has no [intelligences] entry (known: ${known})`);
      }
    }
  }

  return { source_path: sourcePath, presets, dropped, roles, version: document.version,
    ...(document.advanced === undefined ? {} : { advanced: parseAdvancedSettings(document, sourcePath) }),
    harnessPolicy: table(document.harness) ? document.harness : {},
    harnessPolicySource: sourcePath };
}

function parseIntelligences(
  document: Record<string, unknown>, sourcePath: string,
  degrade: (path: string, message: string) => void,
): Record<string, string> | null {
  const raw = document.intelligences;
  if (raw === undefined || raw === null) return null;
  if (!table(raw)) { degrade(sourcePath, "[intelligences] is not a table"); return null; }
  // Null-prototype: keyed by operator-authored [intelligences] names.
  const levels: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    // The sibling of `parseRoles`, and it was left behind when that one was
    // fixed -- a blank definition stayed BOUND, so metadata naming it read as
    // known and neither the invalid-description notice nor the unbound one
    // fired. Same defect, adjacent function.
    //
    // The name pattern is deliberately NOT `ROLE_NAME`: see INTELLIGENCE_NAME.
    if (!INTELLIGENCE_NAME.test(key)) {
      degrade(sourcePath, `unusable intelligence name '${key}'`);
      continue;
    }
    if (typeof value !== "string" || pyBlank(value) || CONTROL.test(value)) {
      degrade(sourcePath, `intelligences.${key} is not a usable description`);
      continue;
    }
    levels[key] = value;
  }
  return levels;
}

/**
 * Is this the retired v1 layout, whose presets are not read at all?
 *
 * The incumbent spells this `version == 1` and Python's `==` is what makes it
 * uniform: `1`, `1.0` and `True` all satisfy it, while `"2"`, `4`,
 * `9007199254740993` and an ABSENT version do not and read their presets
 * normally. Running the pinned program across those nine shapes is what settled
 * it -- `version = true` had been recorded on this lane as an incumbent DEFECT
 * to ratify, and it is not one: it is the same predicate answering consistently.
 *
 * JS agrees on `1.0` for free (there is one number type) and disagrees on
 * `true`, which is the only case that needs spelling out. A string is NOT equal
 * to 1 in either language, so it stays out.
 */
export function isRetiredVersion(version: unknown): boolean {
  return version === 1 || version === true;
}

/**
 * Is this the DOCUMENTED version-1 catalog whose requested preset refuses?
 *
 * Narrower than `isRetiredVersion` on purpose, and the gap is the whole point.
 * CONTRACT.md:1794 grants the Bun launcher one exception -- `preset_config_retired`
 * "when a requested preset belongs to a version-1 catalog" -- and a TOML boolean
 * is not a version-1 catalog however Python's `==` happens to rank it.
 *
 * Running the pinned incumbent on `version = true` settles it: it ACCEPTS the
 * file, reads zero presets, and answers a requested preset with
 * `preset_not_found` naming the file. Extending the documented v1 exception to
 * cover `true` would be a behavior change wearing parity's clothes -- the
 * predicate agreeing with Python about which files are EMPTY is not evidence
 * that Python meant them to refuse.
 */
export function isDocumentedRetiredCatalog(version: unknown): boolean {
  return version === 1;
}

function parseRoles(
  document: Record<string, unknown>, sourcePath: string,
  degrade: (path: string, message: string) => void,
): Record<string, string> | null {
  const raw = document.roles;
  if (raw === undefined || raw === null) return null;
  if (!table(raw)) { degrade(sourcePath, "[roles] is not a table"); return null; }
  // Null-prototype: keyed by operator-authored [roles] names.
  const roles: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    // One bad entry costs that ENTRY, never the vocabulary -- a table that
    // refused wholesale would take every role definition down with one typo.
    //
    // All three checks are the incumbent's, and the description one is why this
    // matters beyond tidiness: a blank or control-only description used to be
    // accepted as a known role, so metadata naming it counted as BOUND and the
    // "no [roles] entry" notice an operator needs never fired. The vocabulary
    // silently contained a role that says nothing.
    if (!ROLE_NAME.test(key)) {
      degrade(sourcePath, `unusable role name '${key}' in [roles]`);
      continue;
    }
    if (key in RETIRED_ROLES) {
      degrade(sourcePath, `role '${key}' in [roles] is retired; use '${RETIRED_ROLES[key]}' instead`);
      continue;
    }
    // `pyBlank`, not `trim()`: this is Python's `str.strip()` emptiness test and
    // the two disagree on U+FEFF and U+001C-U+001F, which are exactly the
    // characters a description can be padded with.
    if (typeof value !== "string" || pyBlank(value) || CONTROL.test(value)) {
      degrade(sourcePath, `roles.${key} is not a usable description`);
      continue;
    }
    roles[key] = value;
  }
  return roles;
}

/**
 * Map a roster handle onto a catalog preset without inventing one.
 *
 * Exact name wins. Otherwise the LONGEST catalog name such that the handle is
 * `<name>-…`, so `opus-med` is not swallowed by `opus`.
 */
export function forHandle(catalog: Catalog, handle: string): ResolvedPreset | null {
  if (!handle) return null;
  const exact = catalog.presets.get(handle);
  if (exact) return exact;
  let best: string | null = null;
  for (const name of catalog.presets.keys()) {
    if (handle.startsWith(`${name}-`) && (best === null || name.length > best.length)) best = name;
  }
  return best === null ? null : catalog.presets.get(best) ?? null;
}

export type Facts = Record<string, Record<string, unknown>>;

/**
 * Per-handle catalog facts for the roster. Unjoined handles are ABSENT.
 *
 * RECORD FIRST, NAME-GUESS SECOND, and the guess is marked as such. `recorded`
 * maps handle -> the preset name persisted on the seat's record at launch, which
 * is durable truth about what it was launched with. Handle-text inference was
 * once the only source, so a seat launched with `cursor-grok` but handled `grok`
 * reported `grok` -- live on a real roster, not a hypothetical.
 *
 * `catalog === null` means the file could not be read, which is a DIFFERENT fact
 * from a readable catalog missing the entry, with a different repair: fix the
 * file, not the preset. Those must stay separately signalled,
 * so a recorded preset survives a broken catalog and says only what it knows.
 */
export function rosterDisplayFacts(
  handles: string[], options: { recorded?: Record<string, string>; catalog: Catalog | null },
): Facts {
  const recorded = options.recorded ?? {};
  if (options.catalog === null) {
    const facts: Facts = {};
    for (const [handle, name] of Object.entries(recorded)) {
      if (name) facts[handle] = { preset: name, roles: "", preset_catalog_unavailable: true };
    }
    return facts;
  }
  const catalog = options.catalog;
  // Null-prototype: handles are operator-chosen text and are written as KEYS
  // here, so a seat named `__proto__` must land as a fact rather than as a
  // mutation of this object.
  const facts: Facts = Object.create(null);
  for (const handle of handles) {
    let inferred = false;
    let preset: ResolvedPreset | null = null;
    // OWN key only. `recorded[handle]` answered with an inherited function for
    // handles named `toString` or `constructor`, which then outranked inference:
    // a seat whose preset genuinely IS in the catalog was reported
    // `preset_absent_from_catalog`, and a genuinely unjoined `valueOf` acquired
    // the same false fact instead of being omitted. A recorded NAME is a string
    // the operator's registry wrote, never something JavaScript supplies.
    const recordedName = owns(recorded, handle) ? recorded[handle] : undefined;
    if (recordedName) {
      preset = catalog.presets.get(recordedName) ?? null;
      if (preset === null) {
        // The RECORD still outranks a guess: report what the seat was launched
        // with rather than silently substituting an entry that merely matches
        // the handle.
        facts[handle] = { preset: recordedName, roles: "", preset_absent_from_catalog: true };
        continue;
      }
    }
    if (preset === null) {
      preset = forHandle(catalog, handle);
      inferred = preset !== null;
    }
    if (preset === null) continue;
    const item: Record<string, unknown> = { preset: preset.provenance.name };
    // Explicit evidence only: the harness fallback is applied by the roster view,
    // which labels its source, so calibration never reads a harness inference.
    if (preset.metadata?.model_family) item.family = preset.metadata.model_family;
    if (inferred) item.preset_inferred = true;
    if (preset.metadata !== null) {
      item.metadata = metadataToJson(preset.metadata);
      item.roles = preset.metadata.primary_roles.join(", ");
    } else {
      item.roles = "";
    }
    facts[handle] = item;
  }
  return facts;
}

export const TOP_LEVEL_KEYS = ["version", "presets", "notes", "harness", "roles", "intelligences",
  "recovery", "delivery", "sentinel", "tmux", "diagnostics", "notifications",
  // Written by `tap setup --machine` and read by their own modules (injection-behavior,
  // onboarding, skill-policy); the catalog parse never reads them but must not call them typos.
  "injection", "onboarding", "skills", "calibration", "experimental", "debug", "advanced"];
export const SCHEMA_VERSIONS = [2, 3];
export const RETIRED_SCHEMA_VERSIONS = [1];

/**
 * Python `difflib.SequenceMatcher.ratio()`, which is what `get_close_matches`
 * ranks by -- not edit distance. It is 2*M/T where M is the number of matched
 * characters found by the longest-matching-block recursion and T is the total
 * length of both strings. Reimplemented rather than approximated because the
 * suggestion text is compared byte-for-byte against the incumbent.
 */
function ratio(a: string, b: string): number {
  const matches = (lo1: number, hi1: number, lo2: number, hi2: number): number => {
    let best = { i: lo1, j: lo2, size: 0 };
    for (let i = lo1; i < hi1; i++) {
      for (let j = lo2; j < hi2; j++) {
        let size = 0;
        while (i + size < hi1 && j + size < hi2 && a[i + size] === b[j + size]) size++;
        if (size > best.size) best = { i, j, size };
      }
    }
    if (!best.size) return 0;
    return best.size + matches(lo1, best.i, lo2, best.j) +
           matches(best.i + best.size, hi1, best.j + best.size, hi2);
  };
  const total = a.length + b.length;
  return total === 0 ? 1 : (2 * matches(0, a.length, 0, b.length)) / total;
}

/** `difflib.get_close_matches(word, possibilities, n=1)` -- cutoff 0.6, best first. */
function closeMatch(word: string, possibilities: string[]): string | null {
  let best: { name: string; score: number } | null = null;
  for (const name of possibilities) {
    const score = ratio(word, name);
    if (score >= 0.6 && (best === null || score > best.score)) best = { name, score };
  }
  return best?.name ?? null;
}

/**
 * Decode and parse a config document.
 *
 * Raises ONLY when there is no document to speak of -- bad encoding or broken
 * TOML syntax. Every question of CONTENT degrades with a notice.
 */
/**
 * Did the parser refuse because it cannot REPRESENT an integer?
 *
 * `Bun.TOML.parse` refuses any integer outside +/-(2^53 - 1) -- `tomllib` reads
 * those exactly -- and the difference matters far more than a wording gap. The
 * generic malformed-config path resolves harness policy EMPTY and lets the
 * launch proceed, so for this input a seat would start on default permissions
 * because our number type is narrower than the operator's file, reported as
 * "catalog unavailable". A reader that cannot represent a value must say so; it
 * must never report that as having read the file and found no policy (rule 19,
 * leader ruling 2026-09-15).
 *
 * The PARSER is asked, not the source text. An earlier version of this scanned
 * the source for oversized decimal literals and declared hex, octal and binary
 * out of scope -- which meant `version = 0x20000000000001` fell through to the
 * generic class and took the policy-off path after all. The comment justifying
 * that narrowness claimed "both branches refuse"; that was FALSE at
 * `loadHarnessPolicy`, which swallows the generic class. Every spelling produces
 * this one diagnostic, so asking the parser is complete where a literal scan
 * cannot be.
 *
 * The coupling to Bun's wording is real and is pinned by a control: if the
 * message changes, the hex case falls back to the generic class and
 * `launcher-integer-ceiling.test.ts` reds rather than a seat quietly losing its
 * permissions.
 */
function isPrecisionRefusal(error: unknown): boolean {
  return /losslessly represented/i.test(String((error as Error)?.message ?? ""));
}

/**
 * Best-effort field name for the refusal message. Naming the line the operator
 * must change is worth a scan that can miss; deciding whether to refuse is not.
 */
function oversizedLiteral(text: string): { key: string; literal: string } | null {
  const pattern = /^[ \t]*(?:"([^"]+)"|'([^']+)'|([^=\s]+))[ \t]*=[ \t]*([+-]?(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*))[ \t]*(?:#.*)?$/gm;
  for (const match of text.matchAll(pattern)) {
    const raw = match[4]!;
    const digits = raw.replace(/_/g, "");
    let value: bigint;
    try {
      value = /^[+-]?0[xXoObB]/.test(digits)
        ? BigInt(digits.replace(/^\+/, ""))
        : BigInt(digits);
    } catch { continue; }
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (value <= limit && value >= -limit) continue;
    return { key: match[1] ?? match[2] ?? match[3] ?? "an integer field", literal: raw };
  }
  return null;
}

export function parseDocument(
  bytes: Buffer, sourcePath: string, notice: (message: string) => void,
): Record<string, unknown> {
  const degrade = (message: string) =>
    notice(`tap config: ${message} in ${sourcePath} — ignoring it and continuing`);
  // Rule 40 / tap-uddlm T3: asked of the BYTES, because the decoder below would
  // consume the BOM and `Bun.TOML.parse` would accept it even if it did not.
  // `tomllib` refuses, so the incumbent degrades this file to no policy; before
  // this the port read it happily and APPLIED the fenced env tier the incumbent
  // had refused.
  if (hasUtf8Bom(bytes)) {
    throw new LauncherError(
      `preset_config_invalid: invalid preset config ${sourcePath}: TOML parse failed: a leading UTF-8 BOM is not valid TOML`,
      // `fix <path>`, matching the incumbent's action for every parse failure;
      // the BOM-specific sentence is in the detail, beside the parser text.
      "preset_config_invalid", `fix ${sourcePath}`,
      `invalid preset config ${sourcePath}: TOML parse failed: a leading UTF-8 BOM is not valid TOML`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LauncherError(
      `preset_config_invalid: invalid preset config ${sourcePath}: file is not valid UTF-8`,
      "preset_config_invalid", `fix ${sourcePath}`,
      `invalid preset config ${sourcePath}: file is not valid UTF-8`);
  }
  let document: unknown;
  try {
    document = Bun.TOML.parse(text);
  } catch (error) {
    if (isPrecisionRefusal(error)) {
      const oversized = oversizedLiteral(text);
      // Its OWN class, distinct from a malformed file, because the two get
      // handled oppositely downstream: a malformed config resolves policy empty
      // and launches, and doing that here would silently drop the operator's
      // permissions because of OUR precision ceiling.
      const where = oversized ? `${oversized.key} = ${oversized.literal}` : "an integer field";
      const detail = `${sourcePath}: ${where} is outside the range this ` +
        `reader represents exactly (${Number.MAX_SAFE_INTEGER} max); the catalog was not read`;
      throw new LauncherError(`preset_config_unrepresentable: ${detail}`, "preset_config_unrepresentable",
        `change ${oversized ? oversized.key : "that field"} in ${sourcePath} to an integer ` +
        `within +/-${Number.MAX_SAFE_INTEGER}`, detail);
    }
    throw new LauncherError(
      // The parser text differs from tomllib's by construction -- a different
      // parser produces different diagnostics. RATIFIED as a measured deviation
      // rather than faked, because inventing tomllib's wording would make the
      // message lie about which parser rejected the file.
      `preset_config_invalid: invalid preset config ${sourcePath}: TOML parse failed: ${(error as Error).message}`,
      "preset_config_invalid", `fix ${sourcePath}`,
      `invalid preset config ${sourcePath}: TOML parse failed: ${(error as Error).message}`);
  }
  if (!table(document)) {
    // The `detail` argument is not optional in practice, whatever the signature
    // says: `verbs/presets.ts` renders `detail` and falls back to `message` when
    // it is null -- and `message` already carries the class token and the whole
    // sentence, so a detail-less refusal prints
    // `invalid preset config <path>: preset_config_invalid: invalid preset config <path>: ...`,
    // the exact doubling this PR's second commit exists to remove. Found by
    // A reviewer answering the falsification question I asked about
    // precisely this shape.
    //
    // I could not construct an input that reaches this branch -- TOML's top level
    // is always a table, and `""`, whitespace, `[[x]]` and a bare scalar all
    // either parse to an object or throw earlier. So this is a latent correction
    // to a defensive branch, not a fix for an operator-visible bug, and I am not
    // claiming otherwise. It costs one argument and removes a trap for whoever
    // makes it reachable.
    throw new LauncherError(
      `preset_config_invalid: invalid preset config ${sourcePath}: TOML parse failed`,
      "preset_config_invalid", `fix ${sourcePath}`,
      `invalid preset config ${sourcePath}: TOML parse failed`);
  }
  // Unknown top-level tables are DROPPED, not merely tolerated, so nothing
  // downstream can half-read one. The suggestion exists for typo catchability:
  // `[preset]` should not silently vanish because it is not `[presets]`.
  for (const key of Object.keys(document).filter(k => !TOP_LEVEL_KEYS.includes(k)).sort()) {
    const hint = closeMatch(key, [...TOP_LEVEL_KEYS].sort());
    degrade(`unknown top-level table '${key}'${hint ? ` (did you mean '${hint}'?)` : ""}`);
    delete document[key];
  }
  parseAdvancedSettings(document, sourcePath);
  const version = document.version;
  // RATIFIED DEVIATION, narrow and diagnostic-only. TOML separates `1` from
  // `1.0` and JS has one number type, so a float version reports the RETIRED
  // notice where the incumbent reports "version is not an integer (1.0)".
  // Whether presets are read is unaffected -- `1.0 == 1` in both languages, so
  // both drop them -- and only the wording of one notice differs.
  //
  // Recovering the type from the raw token was tried and REMOVED. Doing it
  // correctly means lexing TOML, and the regex that looked sufficient missed
  // `"version" = 2.0` (a quoted key is a legal spelling of the same key) and
  // read a `[not_a_table]` line inside a root multiline string as a table
  // header. Shipping a second, worse TOML parser to imitate a Python repr is a
  // bad trade in a migration whose whole point is having one of each thing.
  if (typeof version !== "number" || !Number.isInteger(version)) {
    degrade(`version is not an integer (${pyRepr(version)})`);
  } else if (RETIRED_SCHEMA_VERSIONS.includes(version)) {
    // Retired is not "future": the shapes genuinely differ, so reading a v1 file
    // as if it were current would mis-resolve rather than under-resolve. It still
    // does not refuse -- it reads what it can and says the rest is gone.
    degrade(`version ${version} is retired and its layout is not readable by this release ` +
            `(current: ${SCHEMA_VERSIONS.join(", ")})`);
  } else if (!SCHEMA_VERSIONS.includes(version)) {
    degrade(`version ${version} is newer than this reader understands (${SCHEMA_VERSIONS.join(", ")}); ` +
            "reading what it recognizes and ignoring sections it does not");
  }
  return document;
}

/** Python `repr()` for the scalars a `version` key can hold, since the notice quotes it. */
function pyRepr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "number") return String(value);
  return String(value);
}

/** A file with no usable `[presets]` is a file with no presets -- say so, hand back an empty catalog. */
export function parsePresetCatalog(
  bytes: Buffer, sourcePath: string, digest: string, notice: (message: string) => void,
): Catalog {
  const document = parseDocument(bytes, sourcePath, notice);
  const raw = document.presets;
  let presets: Record<string, unknown>;
  if (!table(raw)) {
    if ("presets" in document) {
      notice(`tap config: [presets] is not a table in ${sourcePath} — ignoring it and continuing`);
    }
    presets = {};
  } else {
    presets = raw;
  }
  return catalogFromDocument(document, presets, sourcePath, digest, notice);
}


/**
 * Resolve presets from `config.toml` when it defines them, else `presets.toml`.
 *
 * FALLBACK IS PER SECTION, NEVER PER FILE. The sanctioned rollout has an
 * operator create a `config.toml` carrying only `[harness.*]` while their
 * presets still live in `presets.toml`; whole-file precedence would load an
 * empty catalog at exactly that moment and break every preset-spelled launch
 * until they migrated.
 *
 * An EMPTY `[presets]` reads as ABSENT for fallback purposes. An operator who
 * seeds a vacant header "to fill in later" is describing an intention, not
 * revoking their catalog -- taking authority there would silently empty it. One
 * entry is enough to mean "these are my presets now".
 */
/**
 * The `[harness.*]` machine policy, read as its OWN authority.
 *
 * This is deliberately separate from preset resolution and deliberately
 * tolerant, because the two answer different questions and fail differently.
 * A machine with no catalog is a legitimate state: `tap session launch claude`
 * must start with empty policy rather than refuse, and CONTRACT is explicit that
 * an absent config "resolves the harness tier empty and silently". Making the
 * policy ride on the preset read meant a missing catalog refused a direct
 * harness launch outright, and a machine mid-migration -- policy in config.toml,
 * presets still in presets.toml -- silently lost its permissions and its
 * declared env, because the returned catalog was built from the LEGACY document.
 *
 * It always reads config.toml. Presets may come from config.toml or the legacy
 * file; policy never does, so the two can disagree about which file they came
 * from without either losing its authority. Same engine, same reader, two
 * questions.
 */
/**
 * ONE open/parse/degrade implementation for the `[harness.*]` policy tier.
 *
 * Every consumer of the machine policy -- the launch path, the display read,
 * and the Python facade's standalone `resolve_harness_env` -- locates
 * `config.toml`, secure-reads it, parses it with the shared document parser,
 * and degrades by failure class through THIS body. What differs per consumer is
 * only where each channel lands, which is the sink:
 *
 *   - `parser`   parse-level findings (`tap config:` degrades from
 *                `parseDocument` -- unknown top-level tables, version notes).
 *   - `tables`   `[harness]`-tier findings: an unrecognized table or key, and
 *                `[harness]` itself not being a table.
 *   - `degraded` the tier could not be read at all (unreadable, malformed,
 *                insecure): the tier resolves empty and one sentence says why.
 *
 * The launcher emits all three on its notice channel. The Python facade emits
 * parser findings through the command's notice lifetime and RETURNS the other
 * two as data, because `resolve_harness_env` promised its notices to the
 * caller's gate rather than to stderr. Same reader, two sinks -- the second
 * full policy body this file refuses to grow.
 */
export type PolicyReadSink = {
  parser: (message: string) => void;
  tables: (message: string) => void;
  degraded: (source: string, detail: string, action: string) => void;
};

/** The degraded-policy sentence, one implementation for both sinks. */
export const policyDegradedNotice = (source: string, detail: string, action: string): string =>
  `tap session: could not read harness environment policy from ${source} ` +
  `(${detail}) — launching WITHOUT it; harness policy is not being applied. ` +
  `Fix: ${action}`;

/** True for a notice `policyDegradedNotice` produced: the policy read failed. */
export const isPolicyDegradedNotice = (message: string): boolean =>
  message.startsWith("tap session: could not read harness environment policy from ");

export function readHarnessPolicyFromDisk(
  sink: PolicyReadSink,
  read: (path: string) => { bytes: Buffer; resolvedPath: string; digest: string },
  dir: string,
  // The RESOLVED path rides along because a fence refusal has to name the file
  // the operator must edit, not the path we happened to look up. Returning the
  // table alone meant the one caller had to reconstruct it, and a reconstructed
  // path is the defect this lane already fixed once in `tap presets`.
): { policy: Table; source: string } {
  const attempted = joinPath(dir, "config.toml");
  // Hoisted so the CATCH can name it. The degraded notice takes
  // `source_path` -- the path the secure read RESOLVED -- on every branch after
  // the read succeeds (presets.py:1787-1790), and a parse failure is one of
  // those branches. Scoped inside the `try`, the catch could only reach
  // `attempted`, so a config reached through a symlink reported the LINK while
  // the same notice's inner detail (built by `parseDocument`, which has the
  // resolved path) reported the target: one sentence naming two different files
  // and telling the operator to fix the one it did not name first.
  // Both symlink rows diverged from the incumbent.
  let source = attempted;
  try {
    const { bytes, resolvedPath } = read(attempted);
    source = resolvedPath;
    const document = parseDocument(bytes, resolvedPath, sink.parser);
    return { policy: harnessPolicyTables(document.harness, resolvedPath, sink.tables), source: resolvedPath };
  } catch (error) {
    const errorClass = (error as LauncherError).errorClass;
    // A value we cannot REPRESENT is not a file we could not read, and it must
    // not take the policy-off path. Resolving the tier empty here would start
    // the seat on default permissions while telling the operator their catalog
    // was unavailable -- a policy downgrade caused by our number type, reported
    // as a fact about their file. It refuses, loudly and typed.
    if (errorClass === "preset_config_unrepresentable") throw error;
    // An absent config is silence, not a fault. Anything else already emitted its
    // own notice through `parseDocument`; policy still resolves empty so the
    // launch proceeds and the harness sees its own upstream default.
    if (errorClass !== "preset_config_missing") {
      // The incumbent's `_degraded_notice` (presets.py:1849-1854), rebuilt from
      // the same two fields it interpolates. The generic line this replaces said
      // only that something was unavailable: an operator whose config is mode
      // 666 read "catalog unavailable" and had to go find out why, when the
      // incumbent had already told them the file is group/world writable and
      // handed them `chmod 600`. tap-03b71 §3 / tap-dv0b6; three oracle rows.
      //
      // `tap session:`, not `tap config:`. The incumbent uses BOTH prefixes and
      // they are not interchangeable -- parse-level findings ("unknown top-level
      // table 'huge' in ...") are `tap config:`, and this one, which reports a
      // consequence for the launch rather than a fact about the file, is
      // `tap session:`. Canonicalizing every notice to one prefix was the error.
      // NOT a bare `as LauncherError`. `readSecureBytes` wraps its own refusals,
      // but `realpathSync`, `statSync` and `readFileSync` run unwrapped after
      // `openSync` has already succeeded -- so a config unlinked or made
      // unreadable inside that window arrives here as a plain Node error with no
      // `detail` and no `action`, and the cast rendered it as
      // "(undefined) ... Fix: undefined". That is the notice this PR exists to
      // improve, failing in a new way at exactly the moment an operator needs
      // the filesystem fault to recover.
      //
      // The incumbent cannot reach this shape: its `except PresetError` does not
      // catch an OSError, so Python raises instead of degrading. Degrading with
      // the real message is better than both a crash and the word "undefined",
      // and no oracle row covers the window, so it is a strict improvement
      // rather than a parity change.
      const failure = error as Partial<LauncherError> & Error;
      sink.degraded(source, failure.detail ?? failure.message ?? String(error),
                    failure.action ?? `fix ${source}`);
    }
    // Empty policy means no env to fence, so `source` is never read on this
    // path. It carries whatever the read actually reached -- the resolved path
    // when the open succeeded and parsing then failed, the attempted path when
    // the open itself failed -- which is the same value the notice above names,
    // so the two can no longer disagree about which file this was.
    return { policy: {}, source };
  }
}

/** The launch path's policy read: every channel lands on the launcher's notice sink. */
export function loadHarnessPolicy(
  notice: (message: string) => void,
  read: (path: string) => { bytes: Buffer; resolvedPath: string; digest: string },
  dir: string,
): { policy: Table; source: string } {
  return readHarnessPolicyFromDisk(
    {
      parser: notice,
      tables: notice,
      degraded: (source, detail, action) => notice(policyDegradedNotice(source, detail, action)),
    },
    read, dir);
}

/**
 * Python's sort order for the notice loops: by CODE POINT.
 *
 * JS `.sort()` compares UTF-16 code UNITS, so an astral character (a surrogate
 * pair, lead unit 0xD800-0xDBFF) sorts below anything in 0xE000-0xFFFF, while
 * Python compares code points and sorts it above. Measured:
 *
 *     python sorted(['\u{1F600}x', 'zz', 'FULLWIDTH A'])  ->  ['zz', 'A', 'emoji-x']
 *     js     [...].sort()                                  ->  ['zz', 'emoji-x', 'A']
 *
 * Harness NAMES are an allowlist, so the unrecognized-table loop cannot actually
 * reach this. The unrecognized-KEY loop can: those keys are whatever the
 * operator typed, and two odd keys in one table would emit their notices in a
 * different order than the incumbent -- a spurious differential row that would
 * be read as a content bug. Ordering
 * is cheap to get right and expensive to diagnose later.
 */
function byCodePoint(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The keys a `[harness.X]` table may carry. presets.py:55 `_HARNESS_TABLE_KEYS`. */
const HARNESS_TABLE_KEYS = new Set(["env", "params", "driver", "permissions"]);

/**
 * The `[harness]` tier, and the three notices that say it is being IGNORED.
 *
 * tap-fb2ff, raised as a gate finding. The port read
 * this tier correctly and said nothing about any of it, which is the launcher's
 * recurring failure shape rather than a new one: policy resolves right, and the
 * operator's only signal that their seeded table had no effect is missing. The
 * incumbent states the reason at presets.py:1803 -- "The 'I seeded it and
 * nothing happened' typo has to announce itself; a silently ignored table looks
 * identical to a table that had no effect."
 *
 * Every table is inspected, not just the requested harness's, because the
 * operator who typed `[harness.clade]` is by definition not launching `clade` --
 * checking only the requested name would stay silent for exactly the typo the
 * notice exists to catch.
 *
 * Sorted, both loops, matching the incumbent's `sorted()`. Object key order is
 * insertion order in JS and document order from the TOML parser, so an unsorted
 * walk would emit the same set of notices in a file-dependent sequence and a
 * two-fault config would compare unequal against the incumbent at random.
 *
 * These go through the caller's sink, so per-command dedup applies --
 * unlike the resume-target receipts, which are bare prints by design (tap-2qrt).
 * A `resume --all` over N seats sharing one typo'd config says it once; the
 * facade's policy read passes a collecting sink and returns them as data.
 */
function harnessPolicyTables(
  tables: unknown, source: string, notice: (message: string) => void,
): Table {
  if (tables === undefined) return {};
  if (!table(tables)) {
    notice(`tap session: [harness] in ${source} must be a table — ` +
      `no harness environment policy is being applied`);
    return {};
  }
  for (const name of Object.keys(tables).sort(byCodePoint)) {
    if (!HARNESSES.includes(name)) {
      notice(`tap session: unrecognized harness table [harness.${name}] in ${source} — ` +
        `expected one of: ${[...HARNESSES].sort().join(", ")}`);
      continue;
    }
    const entry = tables[name];
    // A non-table entry for a RECOGNIZED harness is passed over here in silence,
    // exactly as the incumbent does (presets.py:1811-1812). It is not ignored:
    // the requested harness's own arm reports it, and reporting it here too
    // would say it twice for the one harness that is actually launching.
    if (!table(entry)) continue;
    for (const key of Object.keys(entry).sort(byCodePoint)) {
      if (!HARNESS_TABLE_KEYS.has(key)) {
        notice(`tap session: unrecognized key '${key}' in [harness.${name}] in ${source} — ` +
          `supported keys are 'env', 'params', 'driver' and 'permissions'`);
      }
    }
  }
  return tables;
}

export function loadPresetCatalog(
  env: NodeJS.ProcessEnv, notice: (message: string) => void,
  read: (path: string) => { bytes: Buffer; resolvedPath: string; digest: string },
  dir: string, legacyIsFile: (path: string) => boolean,
): Catalog {
  const configPath = joinPath(dir, "config.toml");
  const legacyPath = joinPath(dir, "presets.toml");
  let vacant: { document: Record<string, unknown>; source: string; digest: string } | null = null;
  // config.toml's `[harness.*]` is captured the moment the file parses, BEFORE
  // any question about where presets come from. Policy and presets are separate
  // authorities that happen to share a file: a machine mid-migration keeps its
  // permissions and declared env while its presets still live in presets.toml.
  // Deriving policy from whichever document supplied PRESETS silently dropped
  // both, and it did so on the most common migration state there is.
  let configPolicy: Table = {};
  let configAdvanced: AdvancedSettings | undefined;
  // The RESOLVED path of the config read, not the path we asked for. A refusal
  // has to name the file the operator must edit, and with `config.toml` a symlink
  // those differ — the unified reader and the incumbent both name the real file.
  // Defaults to the attempted path: when the read fails there is no policy, so no
  // refusal can quote it.
  let configPolicySource = configPath;

  try {
    const { bytes, resolvedPath, digest } = read(configPath);
    const document = parseDocument(bytes, resolvedPath, notice);
    if (document.advanced !== undefined) configAdvanced = parseAdvancedSettings(document, resolvedPath);
    if (table(document.harness)) configPolicy = document.harness;
    configPolicySource = resolvedPath;
    const rawPresets = document.presets;
    if (rawPresets !== undefined && !table(rawPresets)) {
      // Present but the WRONG SHAPE is an authoring error, not an absence -- and
      // not a reason to refuse. It still must not fall back to the legacy file:
      // answering a botched migration by reading presets.toml would tell the
      // operator to perform the migration they just attempted. config.toml keeps
      // authority and contributes nothing.
      notice(`tap config: [presets] is not a table in ${resolvedPath} — ignoring it and continuing`);
      return catalogFromDocument(document, {}, resolvedPath, digest, notice);
    }
    if (table(rawPresets) && Object.keys(rawPresets).length) {
      // Say so when this authority SHADOWS a surviving legacy file. Until this
      // notice existed, an operator mid-migration editing presets.toml got no
      // error, no effect, and nothing to read.
      if (legacyIsFile(legacyPath)) {
        notice(`tap session: presets come from [presets] in ${resolvedPath}; ` +
               `${realpathOr(legacyPath)} is no longer read and can be deleted`);
      }
      return catalogFromDocument(document, rawPresets, resolvedPath, digest, notice);
    }
    if (table(rawPresets) || document.advanced !== undefined) vacant = { document, source: resolvedPath, digest };
  } catch (error) {
    if ((error as LauncherError).errorClass !== "preset_config_missing") throw error;
  }

  let legacy: { bytes: Buffer; resolvedPath: string; digest: string };
  try {
    legacy = read(legacyPath);
  } catch (error) {
    // A VACANT [presets] WITH NO LEGACY FILE IS A READABLE, EMPTY CATALOG -- not
    // an unreadable one. Propagating the missing-legacy error made the display
    // path report `source: null`, saying "no catalog could be read" about a file
    // that read perfectly and simply holds nothing yet.
    if ((error as LauncherError).errorClass === "preset_config_missing" && vacant) {
      return catalogFromDocument(vacant.document, {}, vacant.source, vacant.digest, notice);
    }
    throw error;
  }
  if (vacant) {
    // The dual of the rule above, and the surprise it creates: an operator who
    // meant the vacant header as "clear my catalog" gets the legacy one anyway.
    notice(`tap session: [presets] in ${configPath} is empty, so presets are still read from ` +
           `${legacy.resolvedPath}. Add an entry there to take authority, or delete presets.toml ` +
           "if you meant to have none.");
  } else {
    notice(`tap session: presets read from ${legacy.resolvedPath} — move them under [presets] in ` +
           `${configPath}; presets.toml support ends after one release`);
  }
  // Presets come from the legacy file; POLICY does not. Carrying the legacy
  // document's (absent) `[harness]` here is what silently dropped a
  // mid-migration machine's permissions and declared env.
  const fromLegacy = parsePresetCatalog(legacy.bytes, legacy.resolvedPath, legacy.digest, notice);
  // The policy's source travels WITH the policy: presets are the legacy file's,
  // `[harness.*]` and its refusals belong to config.toml.
  const { advanced: _legacyAdvanced, ...legacyCatalog } = fromLegacy;
  return { ...legacyCatalog, ...(configAdvanced ? { advanced: configAdvanced } : {}), harnessPolicy: configPolicy, harnessPolicySource: configPolicySource };
}

/**
 * Load the catalog for a DISPLAY surface: silent, and null when unreadable.
 *
 * A roster or discovery read consults the catalog to decorate rows. An operator
 * asking "who is on this team" has not asked about their config file, so the
 * read is suppressed and restored -- on failure as well, which is what keeps a
 * later ordinary notice working after a read that threw.
 *
 * `null` means UNREADABLE, which is a different fact from a readable catalog
 * holding nothing, and callers must keep them apart.
 */
export function tryLoadCatalogForDisplay(
  notices: Notices, env: NodeJS.ProcessEnv,
  read: (path: string) => { bytes: Buffer; resolvedPath: string; digest: string },
  dir: string, legacyIsFile: (path: string) => boolean,
): Catalog | null {
  return notices.quietly(() => {
    try { return loadPresetCatalog(env, notices.sink, read, dir, legacyIsFile); }
    catch (error) {
      if ((error as LauncherError).errorClass === "advanced_config_invalid") throw error;
      return null;
    }
  });
}

/**
 * Resolve a preset BY NAME, or refuse with the distinction the caller needs.
 *
 * Tolerant reading drops an unusable preset rather than refusing the whole
 * file, so an explicit request for a dropped preset must say it was dropped and
 * why: "not found" is true of the catalog and false about the file. The two
 * refusals therefore carry different classes AND different repair actions — one
 * says fix the preset you asked for, the other says pick one that exists.
 *
 * This lives here, beside the catalog it reads, because it is the selection
 * rule itself and not a rendering of it. It previously lived in the oracle
 * driver, which meant every differential row certified the probe's copy of the
 * rule rather than the engine's.
 */
export function requirePreset(catalog: Catalog, name: string): ResolvedPreset {
  const resolved = catalog.presets.get(name);
  if (resolved) return resolved;
  const dropped = catalog.dropped.get(name);
  if (dropped !== undefined) {
    const detail = `preset '${name}' is defined in ${catalog.source_path} but was not usable: ${dropped}`;
    throw new LauncherError(`preset_not_usable: ${detail}`, "preset_not_usable",
      `fix preset '${name}' in ${catalog.source_path}`, detail);
  }
  const available = [...catalog.presets.keys()].sort().join(", ");
  const detail = `preset '${name}' was not found in ${catalog.source_path}`;
  throw new LauncherError(`preset_not_found: ${detail}`, "preset_not_found",
    available ? `choose an available preset (${available}) or edit ${catalog.source_path}`
      : "tap setup --machine to choose presets, or tap session launch <harness> <name> without a preset", detail);
}

export type DisplayRow = { name: string; harness: string; model: string; family: string | null; description: string; roles: string };

/**
 * The rows `tap presets` shows, derived from the ONE catalog the launcher reads.
 *
 * Discovery used to walk the raw document itself, and the two answers drifted in
 * both directions. Measured on this branch before the collapse:
 *
 *   `version = true`  -> the launcher reads NO presets (Python's `== 1` covers
 *     `1`, `1.0` and `True`), while discovery's private `version === 1` check
 *     let them through and ADVERTISED a preset that `launch` then refuses with
 *     `preset_not_found`. CONTRACT's §Schema tolerance calls that exact shape
 *     out: tolerant reading must not "advertise what cannot launch".
 *
 *   `family = "﻿"` -> the launcher KEEPS the preset, because `pyBlank`
 *     follows Python's `str.isspace` and U+FEFF is not in it; discovery used JS
 *     `.trim()`, which strips U+FEFF, judged the family empty and HID a preset
 *     that launches perfectly well.
 *
 * A row is what the launcher would actually resolve. `dropped` presets are not
 * rows -- they are in the file and unusable, which is what the notices are for.
 */
export function catalogDisplayRows(catalog: Catalog): DisplayRow[] {
  return [...catalog.presets.keys()].sort().map(name => {
    const preset = catalog.presets.get(name)!;
    const meta = preset.metadata;
    // Primary roles only, and only unambiguous ones: a role appearing in more
    // than one bucket is dropped from EVERY bucket by the metadata parser, so by
    // the time it reaches here the ambiguity is already resolved.
    const roles = meta ? meta.primary_roles.join(", ") : "";
    return {
      name,
      harness: preset.harness,
      model: preset.model ?? "",
      // Vendor lineage: the explicit `metadata.model_family`, else only what a
      // single-vendor harness implies. Never derived from the model id, and never
      // the preset `family` key, which is the [notes] bridge.
      family: presetModelFamily(preset.harness, meta),
      // The incumbent strips the description HERE and nowhere else -- the stored
      // preset keeps its padding, and only the table cell is trimmed, which is
      // why this lives in the row builder rather than in `resolvePreset`. And it
      // is `pyStrip`, not `trim()`: a description padded with U+FEFF keeps that
      // character in the incumbent's table and loses it under JS trimming, which
      // is the same U+FEFF disagreement that made discovery and launch differ
      // about `family` before this collapse.
      description: pyStrip(preset.description ?? ""),
      roles,
    };
  });
}
