/**
 * Preset briefing metadata and the role vocabulary -- the display half of the
 * ONE catalog engine (strategy seam 6). `verbs/presets.ts` held a private twin
 * of this; it imports from here now, so there is one implementation.
 *
 * METADATA CANNOT COST A LAUNCH. Nothing here reaches argv or the child
 * environment; it is text a reading model uses to brief itself. So a malformed
 * field costs that FIELD and a bad role costs that ROLE, while the preset still
 * resolves and still launches. That is deliberately a finer scope than the
 * per-preset drop around preset resolution, where harness/params/env decide what
 * EXECUTES and an entry nobody can make sense of is genuinely unusable.
 */

import { table } from "./catalog";

export const METADATA_STRING_KEYS = [
  "budget_capacity", "cost_basis", "cost_level", "intelligence", "model_family", "pronouns", "speed", "summary",
] as const;
export const ROLE_BUCKETS = ["primary_roles", "secondary_roles", "avoid_roles", "banned_roles"] as const;
/**
 * NULL-PROTOTYPE on purpose. This table is indexed by OPERATOR-SUPPLIED role
 * names, and a plain object literal answers `"toString" in RETIRED_ROLES` with
 * yes and hands back the inherited function. That produced, verbatim:
 * `metadata names retired role 'toString'; use 'function toString() {
 * [native code] }' instead`. A lookup table keyed by text a stranger wrote
 * should carry nothing it did not declare.
 */
export const RETIRED_ROLES: Record<string, string> =
  Object.assign(Object.create(null), { executor: "implementer", watcher: "monitor" });
export const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/**
 * Intelligence names allow HYPHENS and role names do not. This is not an
 * oversight to tidy up: the incumbent says so in its own docstring, because the
 * live vocabulary opens with `s-tier` and reusing the role pattern "would have
 * made the reader refuse the file it was written to accept". Sharing one regex
 * is the obvious-looking change that breaks a real catalog.
 */
export const INTELLIGENCE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * Python's `str.strip()` emptiness test, not JavaScript's `trim()`.
 *
 * They disagree, and the disagreement is reachable from a config file. Python
 * strips by `str.isspace()`, which does NOT include U+FEFF; JS `trim()` strips
 * per WhiteSpace + LineTerminator, which DOES. So a value of exactly "﻿"
 * is non-empty to the incumbent and empty to a naive port -- accepted there,
 * silently dropped here. U+200B ZERO WIDTH SPACE is the mirror case: neither
 * treats it as space, so it stays a legal one-character value in both.
 */
const PY_SPACE = new Set([
  "\t", "\n", "\v", "\f", "\r", " ", "\x1c", "\x1d", "\x1e", "\x1f", "\x85", " ",
  " ", " ", " ", " ", " ", " ", " ", " ", " ",
  " ", " ", " ", " ", " ", " ", " ", "　",
]);
export function pyBlank(value: string): boolean {
  for (const ch of value) if (!PY_SPACE.has(ch)) return false;
  return true;
}

/**
 * `str.strip()` with no argument, which is NOT `String.prototype.trim()`.
 *
 * The two sets differ at three scalar classes and every one of them can appear in
 * a config key. JS strips U+FEFF and Python does not; Python strips the file and
 * unit separators U+001C-U+001F and JS does not. A key trimmed with `trim()`
 * therefore compares equal to a different set of keys than the incumbent's, which
 * decides which `-c` assignment WINS -- so the divergence is not cosmetic, it
 * silently changes which value reaches the harness.
 */
export function pyStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PY_SPACE.has(value[start]!)) start += 1;
  while (end > start && PY_SPACE.has(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

export type Metadata = {
  pronouns: string | null; intelligence: string | null; cost_basis: string | null;
  cost_level: string | null; budget_capacity: string | null; speed: string | null;
  summary: string | null;
  /** Vendor lineage (anthropic, openai, ...). Display only; distinct from the preset `family` notes key. */
  model_family?: string;
  primary_roles: string[]; secondary_roles: string[]; avoid_roles: string[]; banned_roles: string[];
  extra: [string, unknown][];
};

// The SHARED shape predicate, not a second copy: a duplicated one drifts, and
// this module's copy already disagreed with it about Date.
const isTable = (v: unknown): v is Record<string, unknown> => table(v);

/**
 * Render a parsed TOML value in types JSON can serialize.
 *
 * Passthrough carries whatever the operator wrote, and TOML legally yields
 * dates -- which are not JSON. The consumer that breaks is `tap team --json`,
 * whose writer is guarded, so the failure does not surface as an error: it
 * silently drops EVERY preset and metadata fact from the roster. Silent
 * partial output is worse than a crash, because nothing distinguishes it from a
 * seat that simply has no preset. Anything unnameable becomes a string rather
 * than being dropped -- passthrough promises the operator their bytes reach the
 * reader, and a value nobody can serialize is still information.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (value === undefined) return null;
  // Dates still TRAVEL as inert annotation values -- being unable to act as a
  // table and being unable to travel as data are different questions. Temporal
  // types and Date both answer toJSON()/toString() with ISO-8601.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isTable(value)) {
    // Null-prototype, and the reason is not caution -- it is CORRECTNESS.
    // `out["__proto__"] = v` on a plain object literal invokes the inherited
    // setter and changes the object's prototype instead of creating a key, so a
    // valid TOML `"__proto__" = "value"` vanished from the projection entirely.
    // Unknown metadata keys are carried VERBATIM by contract; a key that
    // silently disappears because of how JavaScript spells inheritance is the
    // contract being broken by the transport. With no prototype there is no
    // setter to invoke and the assignment creates an own data property.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) out[String(key)] = jsonSafe(value[key]);
    return out;
  }
  return String(value);
}

/** Never throws. `degrade` says what was not understood and where; silence would be the other failure. */
export function parseMetadata(
  name: string, raw: unknown, degrade: (message: string) => void,
): Metadata | null {
  if (raw === null || raw === undefined) return null;
  if (!isTable(raw)) { degrade(`preset '${name}' metadata is not a table`); return null; }

  const strings: Record<string, string> = {};
  for (const key of [...METADATA_STRING_KEYS].sort()) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "string" || pyBlank(value) || CONTROL.test(value)) {
      degrade(`preset '${name}' metadata.${key} is not usable text`);
      continue;
    }
    strings[key] = value;
  }

  const lists: Record<string, string[]> = {};
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const key of ROLE_BUCKETS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
      degrade(`preset '${name}' metadata.${key} is not a list of role names`);
      continue;
    }
    const parsed: string[] = [];
    for (const item of value as string[]) {
      if (typeof item !== "string" || pyBlank(item) || CONTROL.test(item) || !ROLE_NAME.test(item)) {
        degrade(`preset '${name}' metadata.${key} has an unusable role '${item}'`);
        continue;
      }
      if (item in RETIRED_ROLES) {
        degrade(`preset '${name}' metadata names retired role '${item}'; use '${RETIRED_ROLES[item]}' instead`);
        continue;
      }
      const where = seen.get(item);
      if (where !== undefined) {
        degrade(`preset '${name}' role '${item}' appears ${where === key ? `twice in ${key}` : `in both ${where} and ${key}`}, ` +
                "so its ranking is ambiguous and it is dropped from every bucket");
        ambiguous.add(item);
        continue;
      }
      seen.set(item, key);
      parsed.push(item);
    }
    lists[key] = parsed;
  }

  // DROP AN AMBIGUOUS ROLE FROM EVERY BUCKET, not just the later one. Keeping the
  // first occurrence would make the surviving ranking depend on bucket iteration
  // order -- an arbitrary answer to a question the operator did not answer.
  // `banned` is a hard exclusion and `avoid` a soft preference; a name claiming
  // both has no meaning, and silently picking one would let a banned role read as
  // merely discouraged.
  if (ambiguous.size) {
    for (const key of Object.keys(lists)) lists[key] = lists[key]!.filter(role => !ambiguous.has(role));
  }

  // Everything this release does not name is briefing text for a reading model,
  // collected AFTER the known keys are parsed so a known-but-malformed field
  // cannot reappear here unvalidated.
  const known = new Set<string>([...METADATA_STRING_KEYS, ...ROLE_BUCKETS]);
  const extra = Object.keys(raw).sort().filter(key => !known.has(key))
    .map(key => [key, jsonSafe(raw[key])] as [string, unknown]);

  return {
    pronouns: strings.pronouns ?? null, intelligence: strings.intelligence ?? null,
    cost_basis: strings.cost_basis ?? null, cost_level: strings.cost_level ?? null,
    budget_capacity: strings.budget_capacity ?? null, speed: strings.speed ?? null,
    summary: strings.summary ?? null,
    ...(strings.model_family === undefined ? {} : { model_family: strings.model_family }),
    primary_roles: lists.primary_roles ?? [], secondary_roles: lists.secondary_roles ?? [],
    avoid_roles: lists.avoid_roles ?? [], banned_roles: lists.banned_roles ?? [],
    extra,
  };
}

/** The `to_json()` projection: unknown keys ride at the TOP level beside the known ones. */
export function metadataToJson(meta: Metadata): Record<string, unknown> {
  // Null-prototype for the same reason as `jsonSafe`: `extra` is copied in below
  // by key, and an operator's `"__proto__"` entry must survive as data.
  const out: Record<string, unknown> = Object.assign(Object.create(null), {
    pronouns: meta.pronouns, intelligence: meta.intelligence, cost_basis: meta.cost_basis,
    cost_level: meta.cost_level, budget_capacity: meta.budget_capacity, speed: meta.speed,
    summary: meta.summary, primary_roles: [...meta.primary_roles],
    secondary_roles: [...meta.secondary_roles], avoid_roles: [...meta.avoid_roles],
    banned_roles: [...meta.banned_roles],
  });
  // Published only when set, so a preset that does not name a lineage keeps the
  // exact metadata shape it always had.
  if (meta.model_family !== undefined) out.model_family = meta.model_family;
  // A known key can never be shadowed: a malformed KNOWN key is dropped with a
  // notice above rather than demoted into `extra` wearing a different hat.
  for (const [key, value] of meta.extra) out[key] = value;
  return out;
}

/**
 * Harnesses that run exactly one vendor's models. Multi-vendor harnesses
 * (opencode, cursor, hermes) are absent on purpose: guessing for them could make
 * two same-lineage seats look different, so they need the explicit key.
 */
const SINGLE_VENDOR_HARNESS: Record<string, string> =
  Object.assign(Object.create(null), { claude: "anthropic", codex: "openai", agy: "google" });

/** The lineage a harness implies by itself, or null when it runs several vendors. */
export function harnessModelFamily(harness: string): string | null {
  return SINGLE_VENDOR_HARNESS[harness] ?? null;
}

/** The family shown for a preset: its explicit `metadata.model_family`, else the harness's own vendor. */
export function presetModelFamily(harness: string, metadata: Metadata | null): string | null {
  return metadata?.model_family ?? harnessModelFamily(harness);
}
