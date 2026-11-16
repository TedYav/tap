// `resolve-target` — the pure "what would this request resolve to?" probe the
// crew preflight calls before doing any work. The live launch selector below
// also owns launcher.py's resolve_new_preset_args policy, via value transport. It
// answers as ONE compact JSON line on stdout and must be argv/catalog-decidable:
// it writes nothing, runs no harness, and its only side channel is preset
// notices on stderr (suppressed under TAP_JSON=1).
//
// Errors split like the incumbent's _main: preset-shaped refusals
// (LauncherError with an errorClass) honor TAP_JSON=1 and render
// {error_class,action,detail} on stdout, else prose
// `{verb}: {detail}; next: {action}` on stderr; a bare usage LauncherError is
// a session_error envelope under TAP_JSON=1 only. Three intentional deviations,
// all driver-ruled in the Unit 2 plan: argparse prefix abbreviations are gone
// (same precedent as `session complete`); an explicitly requested preset
// against a version-1 catalog refuses preset_config_retired instead of reading
// the retired document; and the hidden subparser's nonstandard argv `--json`
// is dropped — it was never the crew door's contract (TAP_JSON is), so a
// literal `--json` is an unknown argument.
import { join } from "node:path";
import { HARNESS_ALIASES } from "../harness-families";
import { reservedSeatName } from "../ids";
import { ensureAscii } from "../fsatomic";
import { errorJson } from "../native-error";
import { catalogOut, facadeSecureRead } from "../slices/preset-api";
import {
  configDirectory,
  HARNESSES,
  isRegularFile,
  readSecureBytes,
  table,
} from "./catalog";
import { isDocumentedRetiredCatalog, loadPresetCatalog, requirePreset, type ResolvedPreset } from "./catalog-listing";
import { Notices } from "./catalog-notices";
import { pyStrip } from "./catalog-metadata";
import { LauncherError } from "./types";

type Row = Record<string, unknown>;
type Env = NodeJS.ProcessEnv;


function presetError(errorClass: string, action: string, detail: string): LauncherError {
  return new LauncherError(`${errorClass}: ${detail}`, errorClass, action, detail);
}

/**
 * Harness and preset names are single words, so whitespace inside one means
 * the caller's shell joined separate arguments: zsh keeps an unquoted `$s` as
 * one word where bash would split it. Argv-decidable, so it answers before any
 * catalog read. Seat names keep their own sanitizing; bodies never come here.
 */
export function refuseJoinedArguments(usage: string, ...values: Array<string | null | undefined>): void {
  for (const value of values) {
    if (value == null || !/\s/.test(value)) continue;
    const count = value.trim().split(/\s+/).length;
    const joined = count === 2 ? "two arguments" : count > 2 ? `${count} arguments` : "separate arguments";
    throw presetError(
      "arguments_joined",
      usage,
      `'${value}' looks like ${joined} joined into one; zsh does not word-split unquoted variables, so pass them as separate arguments`,
    );
  }
}

/**
 * A word that is neither harness nor preset but names a harness another way:
 * its product or binary spelling, its capitalized form, or Google's Gemini CLI,
 * which people reach for when they mean the supported Antigravity CLI. The
 * refusal names the canonical word; these spellings never launch.
 */
function knownSpelling(requested: string): { harness: string; cause: string } | null {
  const word = requested.toLowerCase();
  if (HARNESSES.includes(word)) {
    return { harness: word, cause: `harness names are lowercase: '${word}'` };
  }
  if (Object.hasOwn(HARNESS_ALIASES, word)) {
    const harness = HARNESS_ALIASES[word]!;
    return { harness, cause: `TAP's name for that harness is '${harness}'` };
  }
  if (word === "gemini" || word === "gemini-cli") {
    return { harness: "agy", cause: "Google's Gemini CLI is not a supported harness; Google's Antigravity CLI is, as 'agy'" };
  }
  return null;
}

/** _ambiguous_harness_or_preset: an IMPLICIT request may name either space. */
function ambiguous(requested: string, env: Env, usage: string, presets: Iterable<string> = []): LauncherError {
  const crew = usage.startsWith("tap crew add ");
  const example = (harness: string) => crew
    ? `tap crew add ${harness} newcomer --model <model>`
    : `tap launch ${harness} newcomer`;
  const known = knownSpelling(requested);
  if (known) {
    return presetError(
      "harness_or_preset_not_found",
      example(known.harness),
      `'${requested}' is not a known harness or a saved preset; ${known.cause}`,
    );
  }
  const harnesses = [...HARNESSES].sort().join(", ");
  const choices = [...presets].sort().join(", ") || "none";
  return presetError(
    "harness_or_preset_not_found",
    `tap presets, or launch a harness directly: ${example("claude")}`,
    `'${requested}' is not a known harness or a saved preset; canonical harnesses: ${harnesses}; available presets: ${choices}; config: ${join(configDirectory(env), "config.toml")}`,
  );
}

/** presets.metadata_notice: `verb: name — roles — summary`, halves as present. */
function metadataNotice(name: string, metadata: ResolvedPreset["metadata"], verb: string,
  strip: (s: string) => string = s => s.trim()): string | null {
  if (!metadata) return null;
  const roles = metadata.primary_roles.join(", ");
  const summary = strip(metadata.summary ?? "");
  if (!roles && !summary) return null;
  const extra = roles && summary ? `${roles} — ${summary}` : roles || summary;
  return `${verb}: ${name} — ${extra}`;
}

export interface ResolveTargetArgs {
  preset?: string; // the explicitly requested preset (--preset)
  first?: string; // first positional: harness (fast path) or implicit request
  second?: string; // second positional: the seat label
  usage: string;
  verb: string;
}

function presetBinding({ preset, first, second }: Pick<ResolveTargetArgs, "preset" | "first" | "second">) {
  if (preset === undefined) return { name: first!, compat: null, label: second ?? null };
  if (second !== undefined) return { name: preset, compat: first ?? null, label: second };
  if (first !== undefined && HARNESSES.includes(first)) return { name: preset, compat: first, label: null };
  return { name: preset, compat: null, label: first ?? null };
}

/** Live launch selection keeps the full recipe; the crew probe below has a different projection. */
export function resolveLaunchPresetArgs(env: Env, notices: Notices, input: unknown) {
  if (!table(input)) throw new Error("invalid launch preset arguments");
  for (const key of ["preset", "harness", "label", "model", "effort", "usage", "verb"]) {
    if (input[key] != null && typeof input[key] !== "string") throw new Error(`invalid launch preset argument '${key}'`);
  }
  const args = input as Record<string, string | null | undefined>;
  const usage = args.usage || "tap session launch <preset|harness> [name]";
  const verb = args.verb || "tap session";
  const preset = args.preset ?? undefined, first = args.harness ?? undefined, second = args.label ?? undefined;
  if (preset === undefined && first !== undefined && HARNESSES.includes(first)) {
    return { harness: first, label: second ?? null, preset_name: null, catalog: null };
  }
  if (preset === undefined && !first) throw new LauncherError(`usage: ${usage}`);
  const { name, compat, label } = presetBinding({ preset, first, second });
  refuseJoinedArguments(usage, name, compat);
  let catalog;
  try { catalog = loadPresetCatalog(env, notices.sink, facadeSecureRead, configDirectory(env), isRegularFile); }
  catch (error) {
    if (preset === undefined && error instanceof LauncherError && error.errorClass === "preset_config_missing") {
      throw ambiguous(name, env, usage);
    }
    throw error;
  }
  const resolved = catalog.presets.get(name);
  if (!resolved) {
    if (preset !== undefined) requirePreset(catalog, name);
    throw ambiguous(name, env, usage, catalog.presets.keys());
  }
  const combined = [args.model != null ? "--model" : "", args.effort != null ? "--effort" : ""].filter(Boolean);
  if (combined.length) throw presetError("preset_not_composable",
    `drop ${combined.join(" and ")}, or launch without --preset and pass tuning by flag`,
    `preset '${name}' is complete; ${combined.join(" and ")} cannot override it`);
  if (compat !== null && compat !== resolved.harness) throw presetError("preset_harness_mismatch",
    `omit '${compat}' or use harness '${resolved.harness}'`,
    `preset '${name}' uses harness '${resolved.harness}', not compatibility harness '${compat}'`);
  if (resolved.note) notices.emit(`${verb}: ${resolved.provenance.name} — ${resolved.note}`);
  // Preserve Python str.strip here; changing the probe's JS trim is a separate behavior change.
  const metadataLine = metadataNotice(resolved.provenance.name, resolved.metadata, verb, pyStrip);
  if (metadataLine) notices.emit(metadataLine);
  return { harness: resolved.harness, label, preset_name: name,
    catalog: catalogOut({ ...catalog, presets: new Map([[name, resolved]]) }) };
}

export function resolveTarget(env: Env, notices: Notices, args: ResolveTargetArgs): {
  harness: string; preset: string | null; handle: string; configDigest: string | null; model: string | null;
} {
  const requested = args.preset;
  const first = args.first;
  const second = args.second;
  // Harness fast path: a bare known harness never consults the config, so a
  // malformed catalog cannot break the plainest crew add (the incumbent's
  // resolve_new_preset_args returns before load_preset_catalog). The reserved
  // handle still refuses here: the incumbent checks RESERVED_HANDLES in
  // cmd_resolve_target, AFTER resolution, so `claude help` refuses without
  // ever opening the catalog.
  if (requested === undefined && first !== undefined && HARNESSES.includes(first)) {
    const handle = second || first;
    if (reservedSeatName(handle)) {
      throw presetError(
        "reserved_handle",
        "pass an explicit seat name, or rename the preset",
        `handle '${handle}' ${reservedSeatName(handle)} and cannot name a seat`,
      );
    }
    return { harness: first, preset: null, handle, configDigest: null, model: null };
  }
  if (requested === undefined && !first) throw new LauncherError(`usage: ${args.usage}`);

  // Arm mapping: a leading positional is a request unless --preset made the
  // request explicit; then it is a compatibility harness, and the trailing
  // positional (if any) is the label.
  const { name, compat, label } = presetBinding({ preset: requested, first, second });
  refuseJoinedArguments(args.usage, name, compat);

  let catalog;
  try {
    catalog = loadPresetCatalog(env, notices.sink, readSecureBytes, configDirectory(env), isRegularFile);
  } catch (error) {
    // An implicit request against a MISSING config is an ambiguity answer
    // ("neither harness nor preset"), not a config error; an explicit --preset
    // wants the real refusal.
    if (requested === undefined && (error as LauncherError).errorClass === "preset_config_missing") {
      throw ambiguous(name, env, args.usage);
    }
    throw error;
  }
  if (requested !== undefined && isDocumentedRetiredCatalog(catalog.version)) {
    // Ruled deviation: the launch projection already refuses version-1
    // catalogs; resolve-target now agrees instead of reading a retired one.
    throw new LauncherError(
      `preset_config_retired: ${catalog.source_path}: version 1 is retired; migrate the catalog to version 2 or 3`,
      "preset_config_retired",
      `migrate ${catalog.source_path} to version 2 or 3`,
      `${catalog.source_path}: version 1 is retired; migrate the catalog to version 2 or 3`,
    );
  }
  const resolved = catalog.presets.get(name);
  if (!resolved) {
    if (requested !== undefined) requirePreset(catalog, name); // throws
    throw ambiguous(name, env, args.usage, catalog.presets.keys());
  }
  if (compat !== null && compat !== resolved.harness) {
    throw presetError(
      "preset_harness_mismatch",
      `omit '${compat}' or use harness '${resolved.harness}'`,
      `preset '${name}' uses harness '${resolved.harness}', not compatibility harness '${compat}'`,
    );
  }

  // Success notices render exactly once each, in incumbent order: the family
  // note first, then the metadata line.
  if (resolved.note) notices.emit(`${args.verb || "tap session"}: ${resolved.provenance.name} — ${resolved.note}`);
  const metadataLine = metadataNotice(resolved.provenance.name, resolved.metadata, args.verb || "tap session");
  if (metadataLine) notices.emit(metadataLine);

  const handle = label || resolved.provenance.name;
  if (reservedSeatName(handle)) {
    throw presetError(
      "reserved_handle",
      "pass an explicit seat name, or rename the preset",
      `handle '${handle}' ${reservedSeatName(handle)} and cannot name a seat`,
    );
  }
  return {
    harness: resolved.harness,
    preset: resolved.provenance.name,
    handle,
    configDigest: resolved.provenance.config_digest,
    model: resolved.model,
  };
}

export function cmdResolveTarget(argv: string[]): number {
  // The verb label colors prose and notices; it must be readable even when the
  // argv is too malformed to parse, so the scan mirrors the parser's operand
  // rule: a missing or flag-shaped operand leaves the default verb standing
  // and the parse refusal below carries it.
  let verb = "tap session";
  const verbIndex = argv.indexOf("--verb");
  const scanned = verbIndex !== -1 ? argv[verbIndex + 1] : undefined;
  if (scanned !== undefined && !scanned.startsWith("-")) verb = scanned;
  const helpAction = verb === "tap clear" ? "tap help clear" : "tap help session";

  let usage = "tap session launch <preset|harness> [name]";
  let preset: string | undefined;
  let positionals: string[] = [];
  const notices = new Notices();
  notices.suppress(process.env.TAP_JSON === "1");
  try {
    // The hidden subparser took no --json, so an argv --json is an unknown
    // argument here (ruled; the live door speaks TAP_JSON). Split-form flags
    // refuse a missing operand instead of eating the next option, the way
    // argparse did; the inline `--flag=value` spelling stays literal.
    const operand = (index: number): string => {
      const value = argv[index];
      if (value === undefined || value.startsWith("-")) throw new LauncherError(`usage: ${usage}`);
      return value;
    };
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      const valued = arg.match(/^--(preset|usage)(?:=(.*))?$/);
      if (valued) {
        let value = valued[2];
        if (value === undefined) {
          value = operand(i + 1);
          i++;
        }
        if (valued[1] === "preset") preset = value; // argparse last-wins
        else usage = value;
        continue;
      }
      if (arg === "--verb") {
        operand(i + 1);
        i++;
        continue;
      }
      if (arg.startsWith("-")) throw new LauncherError(`usage: ${usage}`);
      if (positionals.length >= 2) throw new LauncherError(`usage: ${usage}`);
      positionals.push(arg);
    }
    const resolved = resolveTarget(process.env, notices, {
      preset,
      first: positionals[0],
      second: positionals[1],
      usage,
      verb,
    });
    const row: Row = {
      ok: true,
      harness: resolved.harness,
      preset: resolved.preset,
      handle: resolved.handle,
      config_digest: resolved.configDigest,
      model: resolved.model,
    };
    process.stdout.write(`${ensureAscii(JSON.stringify(row))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof LauncherError)) throw error;
    if (error.errorClass !== null) {
      if (process.env.TAP_JSON === "1") {
        process.stdout.write(errorJson(error.errorClass, error.action ?? "", error.detail ?? error.message));
      } else {
        process.stderr.write(`${verb}: ${error.detail ?? error.message}; next: ${error.action}\n`);
      }
      return 2;
    }
    if (process.env.TAP_JSON === "1") {
      process.stdout.write(errorJson("session_error", helpAction, error.message));
    } else {
      process.stderr.write(`${verb}: ${error.message}\n`);
    }
    return 2;
  }
}

if (import.meta.main) process.exitCode = cmdResolveTarget(process.argv.slice(2));
