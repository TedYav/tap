import { isAbsolute, join } from "node:path";
import { LauncherError } from "../launcher/types";
import { configDirectory, isRegularFile, readSecureBytes } from "../launcher/catalog";
import { catalogDisplayRows, loadPresetCatalog, type DisplayRow } from "../launcher/catalog-listing";
import { Notices } from "../launcher/catalog-notices";

type Row = DisplayRow;
/** Display-only sanitisation: a control character in a cell would corrupt the table. */
const CONTROL = /[\x00-\x1f\x7f]/g;
const usage = () => process.stderr.write("tap presets [--json]\n  List launchable presets: name, harness, family, model, description, primary roles.\n  FAMILY is vendor lineage: metadata.model_family, else what a claude/codex/agy harness implies; - means unknown.\n  Read-only. Launch one with: tap session launch <preset|harness> [name]\n");

/**
 * Discovery reads the SAME catalog the launcher resolves.
 *
 * It used to walk the raw document itself -- its own version check, its own
 * preset validation, its own role vocabulary, its own `family.trim()` -- and the
 * two answers drifted in both directions. Measured before this collapse:
 * `version = true` made discovery advertise a preset `launch` then refused
 * (`preset_not_found`), and a `family` of U+FEFF made discovery HIDE a preset
 * that launches, because JS `trim()` strips U+FEFF and Python's `str.isspace`
 * does not. Both are gone by construction now: there is one reader.
 *
 * Notices stay silent here. `tap presets` answers "what can I launch", and an
 * operator asking that has not asked about their config file's diagnostics --
 * the same reasoning `tryLoadCatalogForDisplay` already encodes for the roster.
 */
function discoverRows(env: NodeJS.ProcessEnv, dir: string): { rows: Row[]; source: string } {
  const notices = new Notices(() => {});
  const catalog = notices.quietly(() =>
    loadPresetCatalog(env, notices.sink, readSecureBytes, dir, isRegularFile));
  return { rows: catalogDisplayRows(catalog), source: catalog.source_path };
}

export function cmdPresets(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") { usage(); return 0; }
    else { process.stderr.write(`tap presets: unknown option '${arg}'\n`); usage(); return 1; }
  }
  let found: { rows: Row[]; source: string } | undefined;
  let diagnostic = "";
  let absent = false;
  let dir: string | undefined;
  try {
    // Unlike the launcher, discovery refuses an explicitly relative XDG path.
    if (env.XDG_CONFIG_HOME && !isAbsolute(env.XDG_CONFIG_HOME)) {
      throw new Error(`invalid preset config ${join(env.XDG_CONFIG_HOME, "tap", "config.toml")}: XDG_CONFIG_HOME must be absolute`);
    }
    dir = configDirectory(env);
    found = discoverRows(env, dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // `detail` is the engine's operator sentence: what is wrong, already naming
    // the file that actually failed, WITHOUT the machine class token that
    // `message` leads with. Rebuilding the sentence here is what produced the
    // two defects this replaces, and they were not symmetric:
    //
    //   * the path was re-derived as `config.toml` whenever the error carried no
    //     `path`, so a broken LEGACY `presets.toml` sent the operator to repair a
    //     file that was fine -- the exact regression `presets-verb.test.sh:106`
    //     exists to prevent, and its grep still passed because the right path was
    //     also present, further along the same line;
    //   * `message` was appended to an `invalid preset config <path>:` lead-in
    //     that `message` ALSO carries, so the operator read the class token and
    //     the whole sentence twice. That half predates this collapse: it was
    //     already live on main for `preset_config_insecure` and for a failed
    //     open, because those throws never passed through the old wrapper that
    //     shaped the parse and UTF-8 cases. Reading `detail` fixes the class, not
    //     just the instance.
    //
    // ENOENT is an optional catalog's empty state, not a permission failure.
    //
    // THE MARKER IS THE CONTRACT'S, NOT THE DETAIL'S. CONTRACT.md:1896 says this
    // sentence carries `invalid preset config` exactly once, and reading `detail`
    // verbatim satisfied that only for the classes whose detail happens to open
    // with the phrase -- parse, UTF-8, and a failed open. `preset_config_insecure`
    // and `preset_config_unrepresentable` open with the PATH instead, so they
    // silently shipped a sentence the contract I wrote in this same PR forbids.
    // The smoke arm that counts the phrase runs on the malformed-TOML fixture
    // only, so both survivors stayed green: a rule stated more broadly than its
    // controls reach is a rule nothing enforces.
    //
    // Prefixing rather than rebuilding keeps the detail's own words -- and its
    // path, which is the half that must never be re-derived.
    const detail = error instanceof LauncherError ? error.detail : null;
    const marked = (text: string) =>
      text.startsWith("invalid preset config ") ? text : `invalid preset config ${text}`;
    if (code === "ENOENT") absent = true;
    else if (!dir) diagnostic = (error as Error).message;
    else if (detail) diagnostic = marked(detail);
    else {
      const path = (error as NodeJS.ErrnoException).path;
      diagnostic = `invalid preset config ${path ?? join(dir, "config.toml")}: ${(error as Error).message}`;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, source: found?.source ?? null, presets: found?.rows ?? [] })}\n`);
    return 0;
  }
  if (absent || (found && !found.rows.length)) {
    const source = found?.source ?? join(dir!, "config.toml");
    process.stderr.write(`tap presets: no saved presets in ${source}. Launch a harness directly: tap launch claude newcomer\n`);
    process.stderr.write("tap presets: optional: tap setup --machine to save presets.\n");
    return 0;
  }
  if (!found) {
    process.stderr.write(`tap presets: ${diagnostic}\n`);
    process.stderr.write("tap presets: next: run tap setup --machine to configure presets; for an existing catalog, check that it is a regular file and is not group/world writable.\n");
    return 0;
  }
  const { rows, source } = found;
  const headers = ["PRESET", "HARNESS", "FAMILY", "MODEL", "ROLES", "DESCRIPTION"];
  const cells = rows.map(row => [row.name, row.harness, row.family ?? "-", row.model, row.roles, row.description].map(value => value.replace(CONTROL, " ")));
  const length = (value: string) => Array.from(value).length;
  const widths = headers.map((header, i) => Math.max(length(header), ...cells.map(row => length(row[i]!))));
  const line = (values: string[]) => values.map((value, i) => i === values.length - 1 ? value : value + " ".repeat(widths[i]! - length(value))).join("  ").trimEnd();
  process.stdout.write([line(headers), ...cells.map(line), `\nlaunch: tap session launch <preset|harness> [name]   catalog: ${source}\n`].join("\n"));
  return 0;
}

if (import.meta.main) process.exitCode = cmdPresets(process.argv.slice(2));
