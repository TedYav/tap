/**
 * The preset engine's door for Python callers.
 *
 * `presets.py` forwards through here; it holds no catalog reader, no selection
 * rule and no notice policy of its own. One request object on stdin, one
 * response object on stdout.
 *
 * **The packet is the signal, not the exit code.** A DESIGNED refusal is a
 * successful conversation about an unusable catalog: it exits 0 and carries
 * `{ok:false, refusal:{error_class, action, detail}}`, which Python turns back
 * into the `PresetError` its callers already catch. Anything that prevents the
 * conversation -- bun missing, module load failure, a signal, a truncated write
 * -- must NOT be expressible in that shape, because `tap-ask.py:171` maps
 * `preset_config_missing` to "not a known harness, and no preset config was
 * loaded". A transport failure wearing that class tells an operator their config
 * is absent when the truth is that Bun never ran (rule 19: infrastructure
 * failure never maps to predicate-false). So this door emits a refusal packet
 * ONLY for a LauncherError carrying a declared class, and exits non-zero with
 * nothing parseable on stdout for everything else.
 *
 * **Notice state travels in the request.** `{suppressed, said}` is a bool and a
 * list of strings, so the notice LIFETIME does not need a surviving process --
 * it round-trips through Python, which holds it opaquely and prints only what a
 * response tells it to print. That is how one command's suppression reaches an
 * emit site several calls later without Python knowing what suppression is.
 */
import { applyOverrides, type Overrides, type OverrideRecipe } from "../launcher/overrides";
import { Notices } from "../launcher/catalog-notices";
import {
  configDirectory, isRegularFile, readSecureBytes, resolveHarnessPolicy,
  type SecureFaultPhase, type Table,
} from "../launcher/catalog";
import { composeConfig } from "../launcher/config-args";
import { modelArgv } from "../launcher/tuning";
import { paramsToArgv, spliceTokensIfAbsent, spliceVerbatimParams, type ParamValue } from "../launcher/argv-splice";
import {
  loadPresetCatalog, requirePreset,
  tryLoadCatalogForDisplay, type Catalog, type ResolvedPreset,
} from "../launcher/catalog-listing";
import type { Metadata } from "../launcher/catalog-metadata";
import { LauncherError } from "../launcher/types";
import { jsonDumpBytes } from "../spool-publication";

export type NoticeState = { suppressed: boolean; said: string[] };

const asState = (raw: unknown): NoticeState => {
  const value = (raw ?? {}) as { suppressed?: unknown; said?: unknown };
  return {
    suppressed: value.suppressed === true,
    said: Array.isArray(value.said) ? value.said.filter((s): s is string => typeof s === "string") : [],
  };
};

/** Rehydrate a `Notices` from serialized state, and read the state back out. */
/**
 * The state as of the last operation, captured even when that operation THREW.
 *
 * A refusal still emitted notices on its way to refusing, and the next call in
 * the same command must not repeat them.
 */
let lastState: NoticeState = { suppressed: false, said: [] };

function withNotices<T>(state: NoticeState, body: (notices: Notices) => T):
    { value: T; state: NoticeState } {
  // Notices go to THIS process's stderr. Handing them back in the packet for the
  // caller to print would put notice routing in the facade, and the facade is
  // meant to hold no policy at all -- including "which strings are notices".
  const notices = new Notices(message => process.stderr.write(`${message}\n`));
  notices.restore(state);
  lastState = state;
  try {
    const value = body(notices);
    return { value, state: notices.capture() };
  } finally {
    // `finally`, so a refusal keeps whatever the attempt said out loud.
    lastState = notices.capture();
  }
}

const preset = (p: ResolvedPreset | null) => p === null ? null : {
  harness: p.harness, model: p.model, harness_passthrough: p.harness_passthrough,
  env: p.env, family: p.family, note: p.note, description: p.description,
  // The INTERNAL shape, not `metadataToJson`'s flattened display projection.
  // The flat form folds `extra` into the top level and loses the boundary
  // between known and unknown keys, so a snapshot serialized that way cannot be
  // rehydrated: `extra` comes back missing and the next `metadataToJson`
  // iterates undefined. `extra` is an array of pairs and every value is already
  // JSON-safe, so the internal shape round-trips as-is. Flattening belongs at the
  // display consumer, which gets its own op when that forwarder lands.
  metadata: p.metadata,
  param_keys: p.param_keys, params: p.params,
  provenance: p.provenance,
};

export const catalogOut = (c: Catalog) => ({
  source_path: c.source_path,
  names: [...c.presets.keys()].sort(),
  presets: Object.fromEntries([...c.presets].map(([k, v]) => [k, preset(v)])),
  dropped: Object.fromEntries(c.dropped),
  roles: c.roles,
  version: c.version ?? null,
});

/**
 * Rehydrate the catalog a caller CAPTURED, with the shape checked rather than
 * asserted.
 *
 * A cast would let a malformed snapshot reach `requirePreset` and produce a
 * confident wrong answer -- "preset not found" about a catalog that was never
 * really a catalog. The caller is a cooperating process, but a caller that sends
 * a broken snapshot has a bug, and answering its question anyway hides it.
 */
function snapshot(raw: unknown): Catalog {
  if (typeof raw !== "object" || raw === null) throw new Error("catalog snapshot must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.source_path !== "string") throw new Error("catalog snapshot needs a source_path");
  const presets = new Map<string, ResolvedPreset>();
  const rawPresets = value.presets;
  // An ARRAY is an object in JS and `Object.entries` happily yields its indices,
  // so `presets: []` read as an empty table and a snapshot that was never a
  // catalog answered questions about presets.
  if (typeof rawPresets !== "object" || rawPresets === null || Array.isArray(rawPresets)) {
    throw new Error("catalog snapshot needs a presets table");
  }
  for (const [name, entry] of Object.entries(rawPresets as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`catalog snapshot preset '${name}' is not an object`);
    }
    const preset = entry as Record<string, unknown>;
    // Every field a consumer reads is checked. `{}` previously passed and came
    // back out as `{}` -- a preset with no harness, which is not a preset, and
    // which `requirePreset` would then hand to a caller as a resolved one.
    if (typeof preset.harness !== "string" || !preset.harness) {
      throw new Error(`catalog snapshot preset '${name}' has no harness`);
    }
    if (!Array.isArray(preset.harness_passthrough) || !Array.isArray(preset.param_keys)) {
      throw new Error(`catalog snapshot preset '${name}' has malformed argv fields`);
    }
    for (const field of ["params", "env", "provenance"]) {
      const held = preset[field];
      if (typeof held !== "object" || held === null || Array.isArray(held)) {
        throw new Error(`catalog snapshot preset '${name}' has malformed ${field}`);
      }
    }
    const meta = preset.metadata;
    if (meta !== null && meta !== undefined) {
      if (typeof meta !== "object" || !Array.isArray((meta as Metadata).extra)) {
        throw new Error(`catalog snapshot preset '${name}' has malformed metadata`);
      }
    }
    presets.set(name, entry as ResolvedPreset);
  }
  const dropped = new Map<string, string>();
  for (const [name, reason] of Object.entries((value.dropped ?? {}) as Record<string, unknown>)) {
    if (typeof reason !== "string") throw new Error(`catalog snapshot dropped['${name}'] is not a string`);
    dropped.set(name, reason);
  }
  return {
    source_path: value.source_path, presets, dropped,
    roles: (value.roles ?? null) as Record<string, string> | null,
    version: value.version ?? null,
    harnessPolicy: (value.harnessPolicy ?? {}) as Table,
    // The Python bridge does not carry a policy source yet, and nothing on the
    // SNAPSHOT path runs the env fence — `require`/`get`/`for_handle` are lookups
    // over an already-resolved catalog, and the fence runs in `resolveCatalog`.
    // So this defaults to the preset source rather than refusing a packet that is
    // valid for every operation the bridge actually performs. When a snapshot op
    // starts producing policy refusals, this default becomes a lie and the field
    // has to cross the bridge for real.
    harnessPolicySource: (value.harnessPolicySource ?? value.source_path) as string,
  };
}

/** Re-read the catalog for an op that names one. Reading once per call is the
 *  point: a serialized catalog round-tripping through Python would make Python
 *  the authority on what a catalog IS. */
const read = (env: Record<string, string>, notices: Notices): Catalog =>
  loadPresetCatalog(env, notices.sink, facadeSecureRead, configDirectory(env), isRegularFile);

/**
 * The incumbent Python secure-read vocabulary, selected by its consumers.
 *
 * `readSecureBytes` defaults to the native contract: the launch path
 * classes the open/read race `preset_config_insecure` ("changed while
 * opening") and lets post-open `stat`/`read` OSErrors surface raw, and
 * `launcher-secure-read-swap.test.ts` pins exactly that. But the incumbent's
 * `read_secure_preset_bytes` (deleted in launch-ts row 6b) wrapped the same faults in
 * `_invalid`: the race is `preset_config_invalid` with "source changed while
 * it was being opened; retry", and the post-open OSErrors carry
 * "could not resolve opened file" / "could not read file" details. Those
 * texts ride the facade's observable refusals and degraded notices, so the
 * bridge operations and native crew preparation retain THIS reader when they
 * preserve that observable contract. Other native readers keep their defaults.
 */
const facadeFaults = (path: string) => (phase: SecureFaultPhase, error: unknown): never => {
  if (phase === "race") {
    throw new LauncherError(
      `preset_config_invalid: invalid preset config ${path}: ` +
      "source changed while it was being opened; retry",
      "preset_config_invalid", `fix ${path}`,
      `invalid preset config ${path}: source changed while it was being opened; retry`);
  }
  // Post-open OSError: `_invalid(path, ...)` -- resolve-phase and read-phase
  // have distinct details, as the incumbent's two catch arms spell them.
  const label = phase === "resolve" ? "could not resolve opened file" : "could not read file";
  const detail = `invalid preset config ${path}: ${label}: ${(error as Error).message}`;
  throw new LauncherError(`preset_config_invalid: ${detail}`, "preset_config_invalid",
                          `fix ${path}`, detail);
};
export const facadeSecureRead = (path: string) => readSecureBytes(path, facadeFaults(path));

export function dispatch(request: { op: string; env?: Record<string, string>; state?: unknown;
                                    [key: string]: unknown }): unknown {
  const env = request.env ?? {};
  const state = asState(request.state);
  const str = (key: string): string => {
    const value = request[key];
    if (typeof value !== "string") throw new Error(`${request.op}: '${key}' must be a string`);
    return value;
  };
  const list = (key: string): string[] => {
    const value = request[key];
    if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
      throw new Error(`${request.op}: '${key}' must be a list of strings`);
    }
    return value as string[];
  };

  switch (request.op) {
    case "launch.overrides": return withNotices(state, () => applyOverrides(
      request.recipe as OverrideRecipe, request.overrides as Overrides));
    // ---- notice lifetime. Python carries `state` and prints `printed`. ----
    case "notice.reset":
      return withNotices(state, notices => { notices.reset(); return null; });
    case "notice.suppress":
      return withNotices(state, notices => { notices.suppress(request.on === true); return null; });
    case "notice.emit":
      return withNotices(state, notices => { notices.emit(str("message")); return null; });

    // ---- catalog ----
    case "catalog.load":
      return withNotices(state, notices => catalogOut(read(env, notices)));
    case "catalog.display":
      return withNotices(state, notices => {
        const catalog = tryLoadCatalogForDisplay(notices, env, facadeSecureRead, configDirectory(env), isRegularFile);
        return catalog === null ? null : catalogOut(catalog);
      });
    // The standalone POLICY tier, as the Python facade's resolve_harness_env
    // spelled it: always config.toml, read fresh, degraded by failure class,
    // with the policy-tier notices RETURNED as data rather than emitted.
    // Parse-level degrades still emit through the command's notice lifetime.
    case "policy.resolve":
      return withNotices(state, notices =>
        resolveHarnessPolicy(str("harness"), env, notices, facadeSecureRead));
    // Operate on the catalog snapshot the caller already loaded. Re-reading it would make a
    // Python `catalog.require(name)` resolve against whatever is on disk NOW
    // rather than against the catalog the operator's command actually loaded --
    // a second selection between phases, and a different answer if the file
    // changed in between. The incumbent's catalog object holds its values.
    case "catalog.require":
      return withNotices(state, () => preset(requirePreset(snapshot(request.catalog), str("name"))));
    // ---- pure argv/config helpers ----
    case "argv.render":
      return withNotices(state, () => paramsToArgv((request.params ?? {}) as Record<string, ParamValue>));
    case "argv.splice":
      return withNotices(state, () => spliceTokensIfAbsent(list("argv"), list("tokens"),
        { floor: request.floor !== false, configKeys: request.config_keys === true }));
    case "argv.splice_params":
      return withNotices(state, () => spliceVerbatimParams(list("argv"),
        (request.params ?? {}) as Record<string, ParamValue>, { configKeys: request.config_keys === true }));
    case "config.compose":  return withNotices(state, () => composeConfig(list("defaults"), list("explicit")));
    case "model_argv":      return withNotices(state, () => modelArgv(str("harness"),
                              request.model === null || request.model === undefined ? null : str("model")));
    default:
      throw new Error(`unknown preset-api op '${request.op}'`);
  }
}

if (import.meta.main) {
  let request: { op: string };
  try {
    request = JSON.parse(await Bun.stdin.text());
    if (!request || typeof request.op !== "string") throw new Error("request needs a string 'op'");
  } catch (error) {
    // Malformed REQUEST is the caller's protocol failure, not a refusal about a
    // catalog. It must not become a PresetError.
    console.error(`preset-api: ${String(error)}`);
    process.exit(2);
  }
  try {
    const { value, state } = dispatch(request) as { value: unknown; state: NoticeState };
    // Python-compatible JSON, NOT `JSON.stringify`: the packet reader is
    // `json.loads`, which accepts `NaN` / `Infinity` / `-Infinity` literals --
    // so legal TOML `inf`/`-inf`/`nan` in operator metadata reaches the facade
    // as floats instead of collapsing into JSON's `null`. The writer is the
    // repository's existing one (`jsonDumpBytes`); this door adds no codec.
    console.log(jsonDumpBytes({ ok: true, value, state }));
  } catch (error) {
    // ONLY a declared refusal becomes a refusal packet. A LauncherError with no
    // class, and every other throw, is a program failure and exits non-zero --
    // Python must be able to tell "your catalog is bad" from "I could not ask".
    if (error instanceof LauncherError && typeof error.errorClass === "string" && error.errorClass) {
      // The state rides the REFUSAL too. One logical command context has to
      // survive a failed operation: two `require` calls against a version-4
      // catalog both refuse, and without this the forward-version warning prints
      // twice because the second call starts from an empty history.
      console.log(jsonDumpBytes({ ok: false, state: lastState, refusal: {
        error_class: error.errorClass,
        action: error.action ?? "",
        detail: error.detail ?? error.message,
      } }));
      process.exit(0);
    }
    console.error(`preset-api: ${String((error as Error)?.stack ?? error)}`);
    process.exit(3);
  }
}
