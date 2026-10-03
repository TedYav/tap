import { configDirectory, readSecureBytes, hasUtf8Bom, readCatalog, table, refuse, isRegularFile, type Table, type CatalogSource, type SecureFaultPhase } from "../config-file";
export { configDirectory, readSecureBytes, hasUtf8Bom, readCatalog, table, refuse, isRegularFile, type Table, type CatalogSource, type SecureFaultPhase } from "../config-file";
import { join } from "node:path";
import { permissionMode, type PermissionMode } from "./permissions";
import { LauncherError } from "./types";
import { pyBlank } from "./catalog-metadata";
import type { Notices } from "./catalog-notices";
import { configDefaults, configOnly } from "./config-args";
import {
  isDocumentedRetiredCatalog, loadHarnessPolicy, loadPresetCatalog,
  policyDegradedNotice, readHarnessPolicyFromDisk, requirePreset,
} from "./catalog-listing";

export type Params = Record<string, string | boolean | string[]>;
export type Preset = {
  harness: string;
  params: Params;
  env: Record<string, string>;
  provenance: { name: string; source_path: string; config_digest: string };
};
export const HARNESSES = ["claude", "codex", "opencode", "cursor", "agy", "hermes"];
const FORBIDDEN = new Set(("TAP HOME USER LOGNAME SHELL PATH PWD OLDPWD CDPATH TMUX TMUX_PANE " +
  "TERM_SESSION_ID SESSION SESSION_ID AGENT_ID AGENT_NAME TEAM TEAM_NAME CWD BUS BUS_PATH " +
  "BASH_ENV ENV NODE_OPTIONS PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH " +
  "DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH RUBYOPT PERL5OPT").split(" "));
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * `where` and `source` turn a refusal into a repair (tap-dv0b6).
 *
 * The incumbent tells the operator four things -- which table, which key, which
 * file, and what to do:
 *
 *   detail  [harness.claude.env] key 'HF_TOKEN' in <path> crosses the identity,
 *           transport, process, credential, or policy fence
 *   action  remove key 'HF_TOKEN' from [harness.claude.env] in <path>
 *
 * The port said `forbidden environment key HF_TOKEN` with `action: null`, which
 * is the exact shape `LauncherError.action`'s own docstring warns about: a
 * refusal that says what is wrong but not what to do is a worse product, and it
 * is invisible in any test that only asserts the class. Both engines refused, so
 * only a differential comparing the CONTENT could see it.
 *
 * OPTIONAL, and deliberately supplied at ONE call site so far. The harness-policy
 * fence is the one this lane measured against the incumbent; the preset-env and
 * launch-env fences have their own incumbent texts that I have not measured, and
 * guessing them would trade a known-narrow message for an invented one.
 */
/**
 * ONE CONSTRUCTOR PER FAILURE, spelling the incumbent's text exactly.
 *
 * `TuningContext` (presets.py:523) is a set of constructors, and every
 * invalid-config one routes through `_invalid(path, detail)` (presets.py:430):
 *
 *     class   preset_config_invalid
 *     action  fix <resolved path>              <- the PATH, nothing else
 *     detail  invalid preset config <path>: <detail>
 *
 * An earlier attempt passed one `invalidKind` plus hand-built prose and drifted
 * immediately: it invented `fix [harness.claude.env] in <path>`,
 * `fix the key name in ...` and `fix env.GOOD in ...`, none of which the
 * incumbent says, and collapsed two distinct value diagnostics into one. Hence
 * constructors — prose assembled at three call sites drifts from prose assembled
 * in one (partner review, S2 exact-head read).
 */
/**
 * `-f`: a REGULAR file, symlinks followed. The incumbent's operator, exactly.
 *
 * Rule 38: file-kind predicates port by OPERATOR, and this one guards whether a
 * surviving `presets.toml` SHADOWS the authority catalog. The incumbent asks
 * `legacy.is_file()` inside `except (OSError, PresetError)` (presets.py:1657-1661),
 * so a stat that throws is the operator's FALSE rather than an error -- which is
 * what the `catch` here reproduces, and why it must not be narrowed to a
 * particular errno.
 *
 * `existsSync` was the port's predicate and it is WIDER: "any entry". A
 * directory, socket or fifo named `presets.toml` beside a populated config.toml
 * took the shadow branch in the port and not in the incumbent, so the operator
 * read a legacy-shadowed notice about a file that is not a file. A broken
 * symlink agreed by accident, both being false, which is how the row survived a
 * reading. Disclosed in review; fixed here as rule 38's P2 class, riding the
 * owning lane's next PR for this file.
 */
export type EnvRefusals = {
  notTable(): never;
  keyInvalid(key: string): never;
  forbidden(key: string): never;
  fieldError(field: string, problem: string): never;
};

/** The `[harness.<name>.env]` spelling of every refusal (presets.py:1725). */
export function harnessEnvRefusals(harness: string, path: string): EnvRefusals {
  const table = `[harness.${harness}.env]`;
  const invalid = (detail: string): never =>
    refuse("preset_config_invalid", `invalid preset config ${path}: ${detail}`, `fix ${path}`);
  return {
    notTable: () => invalid(`${table} must be a table`),
    keyInvalid: (key) => invalid(`${table} has invalid environment key '${key}'`),
    fieldError: (field, problem) => invalid(`${table} field '${field}' ${problem}`),
    forbidden: (key) => refuse("harness_env_forbidden",
      `${table} key '${key}' in ${path} crosses the identity, transport, process, credential, or policy fence`,
      `remove key '${key}' from ${table} in ${path}`),
  };
}

/**
 * The `preset '<name>'` spelling of every env refusal (presets.py:523-583).
 * The fence arm is NOT `_invalid`-wrapped — the incumbent raises it as a direct
 * `PresetError("preset_env_forbidden", ...)`, so its detail carries no
 * `invalid preset config` prefix and its action names the key, not the file.
 */
export function presetEnvRefusals(name: string, path: string): EnvRefusals {
  const invalid = (detail: string): never =>
    refuse("preset_config_invalid", `invalid preset config ${path}: ${detail}`, `fix ${path}`);
  return {
    notTable: () => invalid(`preset '${name}' field 'env' must be a table`),
    keyInvalid: (key) => invalid(`preset '${name}' has invalid environment key '${key}'`),
    fieldError: (field, problem) => invalid(`preset '${name}' field '${field}' ${problem}`),
    forbidden: (key) => refuse("preset_env_forbidden",
      `preset '${name}' environment key '${key}' crosses the identity, transport, process, credential, or policy fence`,
      `remove environment key '${key}' from preset '${name}' in ${path}`),
  };
}

export function environment(value: unknown, kind: string, refusals?: EnvRefusals): Record<string, string> {
  if (value === undefined) return {};
  if (!table(value)) {
    if (refusals) refusals.notTable();
    return refuse(kind, "env must be a table");
  }
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const upper = key.toUpperCase();
    // Spelling before fence, as presets.py:610-613 orders it: a key that is not a
    // legal environment name is MALFORMED, not an attempt to cross the fence.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      if (refusals) refusals.keyInvalid(key);
      refuse(kind, `forbidden environment key ${key}`);
    }
    if (FORBIDDEN.has(upper) || upper.startsWith("TAP_") ||
        /(^|_)(IDENTITY|HANDLE|TEAM|CWD|BUS|SANDBOX|APPROVALS?|PERMISSIONS?|BYPASS|PASSWORD|PASSWD|SECRET)(_|$)/.test(upper) ||
        /(^|_)TOKEN$|(^|_)(API_KEY|ACCESS_KEY|PRIVATE_KEY)(_|$)/.test(upper)) {
      if (refusals) refusals.forbidden(key);
      refuse(kind, `forbidden environment key ${key}`);
    }
    // `pyBlank`, not `trim()`. `_behavioral_string` (presets.py:569) tests
    // `not value.strip()`, and the two whitespace sets disagree on U+FEFF and
    // U+001C-U+001F — so a policy value of U+FEFF is a usable string to the
    // incumbent and blank to JS. That exact disagreement has already produced two
    // catalog defects in this lane; this is the third site and the same fix.
    if (typeof item !== "string" || pyBlank(item)) {
      if (refusals) refusals.fieldError(`env.${key}`, "must be a non-empty string");
      refuse(kind, `invalid value for environment key ${key}`);
    }
    if (CONTROL.test(item)) {
      if (refusals) refusals.fieldError(`env.${key}`, "contains a control character");
      refuse(kind, `invalid value for environment key ${key}`);
    }
    result[key] = item;
  }
  return result;
}

export function parameters(value: unknown): Params {
  if (value === undefined) return {};
  if (!table(value)) return refuse("preset_config_invalid", "params must be a table");
  const result: Params = Object.create(null);
  const validString = (item: unknown): item is string =>
    typeof item === "string" && item.trim().length > 0 && !CONTROL.test(item);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key) ||
        !(typeof item === "boolean" || validString(item) || (Array.isArray(item) && item.every(validString)))) {
      refuse("preset_config_invalid", `invalid param ${key}`);
    }
    result[key] = item as string | boolean | string[];
  }
  return result;
}

export function addParams(argv: string[], params: Params, configKeys = false): string[] {
  const extra: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const flag = `--${key}`;
    if (configKeys && key === "config" && typeof value !== "boolean") {
      const tokens: string[] = [];
      for (const item of Array.isArray(value) ? value : [value]) {
        const pair = item.startsWith("-") ? [`${flag}=${item}`] : [flag, item];
        // Other operand shapes keep the existing option floor.
        if (configOnly(pair).length || !argv.some(token => token === flag || token.startsWith(`${flag}=`))) tokens.push(...pair);
      }
      extra.push(...configDefaults(tokens, argv));
      continue;
    }
    if (value === false || argv.some(token => token === flag || token.startsWith(`${flag}=`))) continue;
    if (value === true) extra.push(flag);
    else for (const item of Array.isArray(value) ? value : [value]) {
      if (item.startsWith("-")) extra.push(`${flag}=${item}`);
      else extra.push(flag, item);
    }
  }
  return argv.length ? [argv[0]!, ...extra, ...argv.slice(1)] : extra;
}

/**
 * The LAUNCH-path projection of the one catalog reader.
 *
 * Everything this used to do for itself -- open config.toml, run the version
 * arms, check for a legacy presets.toml, select a preset and word its two
 * refusals -- is `loadPresetCatalog` and `requirePreset`. Keeping a private copy
 * here made the launcher a second reader of the same file with its own notice
 * policy, which is the thing the migration is removing, not a shortcut around it.
 *
 * Collapsing it also CORRECTED a divergence rather than merely deduplicating:
 * the private copy refused the whole file when a requested preset sat in a
 * catalog it disliked, where the incumbent degrades the unusable preset and then
 * reports `preset_not_usable` naming that preset. Asking for a good preset in a
 * file with one bad neighbour now launches, as it always did in Python.
 */
export function resolveCatalog(
  requested: string | undefined,
  harness: string | undefined,
  env: NodeJS.ProcessEnv,
  notice: (message: string) => void,
): { preset?: Preset; policyEnv: Record<string, string>; policyParams: Params; permissions: PermissionMode } {
  const dir = configDirectory(env);
  // Policy is read as its own authority and never blocks: CONTRACT says an
  // absent config resolves the harness tier empty and silently, and an
  // unreadable one allows the launch to proceed with one notice. The catalog is
  // only read when a preset was actually REQUESTED, so a direct harness launch
  // on a machine with no catalog starts instead of refusing.
  let policies: Table = {};
  let policySource = join(dir, "config.toml");
  let preset: Preset | undefined;
  if (!requested) {
    // No preset was asked for, so the catalog is not consulted at all -- only
    // the policy, tolerantly. This is the arm that must survive a machine with
    // no config file.
    ({ policy: policies, source: policySource } = loadHarnessPolicy(notice, readSecureBytes, dir));
  } else {
    // A preset WAS asked for, so the catalog is read -- once. Its policy comes
    // from config.toml even when its presets came from the legacy file, so
    // reading it again here would only duplicate every notice the parse emits.
    const catalog = loadPresetCatalog(env, notice, readSecureBytes, dir, isRegularFile);
    policies = catalog.harnessPolicy;
    // The POLICY's source, not the presets'. In the legacy fallback these differ,
    // and using the preset path here named the wrong file in a policy refusal.
    policySource = catalog.harnessPolicySource;
    // CONTRACT.md:1794 and the :2323 error table: the Bun launcher reports
    // `preset_config_retired` with migration guidance when a REQUESTED preset
    // belongs to a version-1 catalog, while direct-harness launches keep
    // notice-only behavior. That is a documented, deliberate divergence from
    // presets.py, which notices the retirement and then answers
    // `preset_not_found` -- and CONTRACT outranks the deleted program in the
    // oracle order, so it is retained rather than ported away.
    //
    // It sits HERE, in the launch projection, because it is the launch path's
    // policy: the reader stays tolerant and is still read exactly once. Putting
    // it back in a private reader is what this file just stopped doing.
    if (isDocumentedRetiredCatalog(catalog.version)) {
      refuse("preset_config_retired",
        `${catalog.source_path}: version 1 is retired; migrate the catalog to version 2 or 3`,
        `migrate ${catalog.source_path} to version 2 or 3`);
    }
    const resolved = requirePreset(catalog, requested);
    if (harness && harness !== resolved.harness) {
      refuse("preset_harness_mismatch", `${requested} uses ${resolved.harness}, not ${harness}`);
    }
    harness = resolved.harness;
    preset = { harness, params: resolved.params, env: resolved.env, provenance: resolved.provenance };
    if (resolved.note) notice(resolved.note);
  }
  // PRESENT but not a table is an authoring error the operator must hear about;
  // ABSENT is the ordinary case and says nothing (presets.py:1822-1829). The
  // previous line collapsed both into `{}`, so `[harness]\nclaude = "x"` launched
  // claude with no policy and no explanation. A comment here claimed "the
  // requested harness's own arm reports it" -- it did not; nothing did.
  // Confirmed by the differential:
  // the claude row diverged while the codex sibling control matched.
  const requestedTable = harness ? policies[harness] : undefined;
  if (harness && requestedTable !== undefined && !table(requestedTable)) {
    notice(`tap session: [harness.${harness}] in ${policySource} must be a table — ` +
      `no harness environment policy is being applied for ${harness}`);
  }
  const policy = table(requestedTable) ? requestedTable as Table : {};
  return { preset, permissions: permissionMode(policy.permissions),
           policyEnv: environment(policy.env, "harness_env_forbidden",
             // Only a NAMED harness has a `[harness.<name>.env]` table to quote in a
             // refusal. With no harness the policy is `{}`, so `environment` returns
             // on the undefined value before any refusal could be constructed.
             harness ? harnessEnvRefusals(harness, policySource) : undefined),
           policyParams: parameters(policy.params) };
}

/**
 * Params validation carrying the PYTHON diagnostics, for the policy tier.
 *
 * The Python facade's harness-policy refusals are quoted to operators verbatim
 * (`[harness.X] params.k must be a boolean, a string, or an array of strings`,
 * classed `preset_config_invalid`, actioned `fix <path>`), and a policy read
 * that reaches the Python facade must refuse with exactly those words. The
 * shared `parameters` validator above spells a shorter native text for the
 * catalog reader's drop reasons, which are a different surface with a
 * different history — so this is the facade's spelling, not a second opinion
 * about what is invalid. Order and predicate match `_parse_params` exactly:
 * key spelling, then per element string/blank/control, storing the ORIGINAL
 * value (a scalar string is not listified on the way out).
 */
export function pyParams(value: unknown, where: string, path: string): Params {
  if (value === undefined) return {};
  if (!table(value)) {
    refuse("preset_config_invalid",
           `invalid preset config ${path}: ${where} field 'params' must be a table`,
           `fix ${path}`);
  }
  const result: Params = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
      refuse("preset_config_invalid",
             `invalid preset config ${path}: ${where} has invalid params key '${key}'`,
             `fix ${path}`);
    }
    if (typeof item === "boolean") { result[key] = item; continue; }
    for (const element of Array.isArray(item) ? item : [item]) {
      if (typeof element !== "string") {
        refuse("preset_config_invalid",
               `invalid preset config ${path}: ${where} params.${key} must be a boolean, ` +
               "a string, or an array of strings",
               `fix ${path}`);
      }
      // `pyBlank`, not `trim()` — the incumbent tests `not value.strip()`, and
      // the two whitespace sets disagree on U+FEFF.
      if (pyBlank(element)) {
        refuse("preset_config_invalid",
               `invalid preset config ${path}: ${where} params.${key} must be a non-empty string`,
               `fix ${path}`);
      }
      if (CONTROL.test(element)) {
        refuse("preset_config_invalid",
               `invalid preset config ${path}: ${where} params.${key} contains a control character`,
               `fix ${path}`);
      }
    }
    result[key] = item as string | string[];
  }
  return result;
}

export type HarnessPolicyResolution = {
  env: Record<string, string>;
  /** RETURNED data. The caller's notify gate decides whether these print. */
  notices: string[];
  params: Params;
  permissions: PermissionMode;
};

/**
 * The standalone harness-policy read, as the Python facade's
 * `resolve_harness_env` spelled it.
 *
 * The open/parse/degrade body is `readHarnessPolicyFromDisk` -- the SAME
 * implementation the launch path uses through `loadHarnessPolicy`; this seam
 * only chooses the sinks (parser findings emit through the command's notice
 * lifetime, `[harness]`-tier findings and the degrade are RETURNED as data)
 * and does the facade-specific selection below. This is the POLICY tier alone
 * — always config.toml, read fresh, never the catalog — because that is the
 * contract the facade promises: machine policy located by `environ`, degraded
 * by failure class, and handed back with its notices as DATA:
 *
 *   - Degrade vs refuse. Absent is silent; unreadable/malformed/insecure
 *     resolves empty with one recoverable notice; but a fence-crossing env
 *     key, a bad params value, or a bad `permissions` in the REQUESTED
 *     harness's own table refuses, and only that table is fence-checked.
 *
 * Relative XDG / bad HOME follows the facade too: configDirectory refuses, and
 * this seam converts that refusal into the degraded notice naming
 * `config.toml`, instead of stranding a caller that asked a question.
 *
 * `read` is injectable because the facade's door supplies a secure reader that
 * maps race/OSError faults onto the incumbent's classes; the launch path keeps
 * the native default.
 */
export function resolveHarnessPolicy(
  harness: string, env: NodeJS.ProcessEnv, notices: Notices,
  read: (path: string) => { bytes: Buffer; resolvedPath: string; digest: string } = readSecureBytes,
): HarnessPolicyResolution {
  const empty: HarnessPolicyResolution =
    { env: {}, notices: [], params: Object.create(null), permissions: "bypass" };
  let dir: string;
  try {
    dir = configDirectory(env);
  } catch (error) {
    const failure = error as Partial<LauncherError>;
    return { ...empty, notices: [policyDegradedNotice(
      "config.toml",
      failure.detail ?? failure.message ?? String(error),
      failure.action ?? "fix config.toml")] };
  }
  const returned: string[] = [];
  const { policy: tables, source } = readHarnessPolicyFromDisk(
    {
      parser: notices.sink,
      tables: (message) => { returned.push(message); },
      degraded: (degSource, detail, action) => {
        returned.push(policyDegradedNotice(degSource, detail, action));
      },
    },
    read, dir);
  // Only THIS harness's table is fence-checked, and the refusal order is the
  // incumbent's: env, then params, then permissions.
  const rawTable = Object.prototype.hasOwnProperty.call(tables, harness)
    ? (tables as Table)[harness]
    : undefined;
  if (rawTable === undefined) return { ...empty, notices: returned };
  if (!table(rawTable)) {
    return { ...empty, notices: [...returned,
      `tap session: [harness.${harness}] in ${source} must be a table — ` +
      `no harness environment policy is being applied for ${harness}`] };
  }
  const envOut = environment(rawTable.env, "harness_env_forbidden",
                             harnessEnvRefusals(harness, source));
  const params = pyParams(rawTable.params, `[harness.${harness}]`, source);
  const permissions = rawTable.permissions === undefined ? "bypass" : rawTable.permissions;
  if (typeof permissions !== "string" || (permissions !== "bypass" && permissions !== "auto")) {
    refuse("preset_config_invalid",
           `invalid preset config ${source}: [harness.${harness}] permissions must be ` +
           '"bypass" or "auto"',
           `fix ${source}`);
  }
  return { env: envOut, notices: returned, params, permissions };
}
