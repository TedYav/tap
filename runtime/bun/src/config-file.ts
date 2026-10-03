// Shared config location and secure TOML reads. Launcher policy stays in launcher/catalog.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { LauncherError } from "./config-error";
export type Table = Record<string, unknown>;
export type CatalogSource = { path: string; digest: string; data: Table };

/**
 * Is this parsed TOML value a TABLE?
 *
 * A Date is not, and saying otherwise is not pedantry: TOML has first-class
 * date scalars, `typeof aDate === "object"` is true, and `Object.keys(aDate)`
 * is empty -- so `presets = 1979-05-27` read as an EMPTY TABLE. The precedence
 * path then classified it as a vacant `[presets]` and fell back to the legacy
 * catalog, which is the one thing that branch must never do for a wrong-shape
 * value: it answers a botched migration by telling the operator to perform the
 * migration they just attempted.
 *
 * Every consumer of this predicate wants table semantics over parsed TOML --
 * preset entries, roles, intelligences, notes, precedence, params, env, harness
 * policy, discovery display, recovery shape. None of them wants a date.
 *
 * This does NOT mean dates are dropped: `jsonSafe` still serializes one carried
 * as an inert metadata annotation value. Being unable to act as a table and
 * being unable to travel as data are different questions.
 */
export const table = (value: unknown): value is Table => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // A TOML table parses to a PLAIN object. Anything carrying a class prototype
  // is a scalar wearing an object's typeof -- and enumerating those classes is
  // the trap: the first attempt at this excluded `Date`, and `Bun.TOML` returns
  // a Temporal `PlainDate`, so the guard looked right and caught nothing. Asking
  // what the value IS beats listing what it must not be, and it covers
  // PlainDateTime, PlainTime and Instant without naming any of them.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function refuse(kind: string, detail: string, action?: string, code?: string): never {
  throw new LauncherError(`${kind}: ${detail}`, kind, action ?? null, detail, code);
}

/**
 * Locate the config directory. `XDG_CONFIG_HOME` wins when SET, not when valid.
 *
 * A relative `XDG_CONFIG_HOME` REFUSES rather than falling through to `$HOME`.
 * This reader used to fall through, and that is a silent wrong answer: the
 * operator set a variable, the launcher read a different file, and nothing said
 * so -- the same shape as "I changed it and nothing happened". A differential
 * against the incumbent measured the disagreement; the incumbent refuses, and it
 * is right. Ratified as a deliberate behavior change rather than folded in.
 *
 * An EMPTY `XDG_CONFIG_HOME` is falsy and still falls through to `$HOME`, which
 * matches the incumbent's truthiness test.
 */
export function configDirectory(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) {
    if (!isAbsolute(xdg)) {
      refuse("preset_config_invalid",
             `invalid preset config ${join(xdg, "tap", "config.toml")}: XDG_CONFIG_HOME must be absolute`,
             `fix ${join(xdg, "tap", "config.toml")}`);
    }
    return join(xdg, "tap");
  }
  if (env.HOME) {
    if (!isAbsolute(env.HOME)) {
      refuse("preset_config_invalid",
             `invalid preset config ${join(env.HOME, ".config", "tap", "config.toml")}: HOME must be absolute when XDG_CONFIG_HOME is unset`,
             `fix ${join(env.HOME, ".config", "tap", "config.toml")}`);
    }
    return join(env.HOME, ".config", "tap");
  }
  return refuse("preset_config_invalid",
                "invalid preset config ${HOME}/.config/tap/config.toml: HOME is unset and XDG_CONFIG_HOME was not provided",
                "fix ${HOME}/.config/tap/config.toml");
}

/**
 * Validate the opened object and its path, then return its bytes VERBATIM.
 *
 * This is the security boundary, not a convenience: the descriptor is opened
 * once and every check below interrogates THAT descriptor, so a path swapped
 * between resolve and read refuses instead of being read. `realpath` +
 * dev/ino comparison is the TOCTOU re-check; deleting it is what a control
 * has to be able to catch.
 *
 * Bytes come back RAW — undecoded, BOM intact, unparsed. A caller that keeps
 * its own decoding (the digest-window writer reads the same file and must see
 * a leading BOM that `TextDecoder` would consume) consumes this directly
 * rather than re-reading the name, which would be a second, unchecked read.
 */
/**
 * The phases a secure read can fault in AFTER the open has succeeded. Native
 * callers get the native refusal for each; the Python facade's door supplies a
 * mapper that re-classes the same faults with the incumbent's texts (its
 * `read_secure_preset_bytes` wrapped them in `_invalid`). Mapping lives with the
 * caller that requires it -- the shared reader stays native.
 */
export type SecureFaultPhase = "race" | "resolve" | "read";

export function readSecureBytes(
  path: string,
  mapFaults?: (phase: SecureFaultPhase, error: unknown) => never,
): { bytes: Buffer; resolvedPath: string; digest: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // An absent config is its own answer, and the incumbent names it:
    // `preset_config_missing`, remedied by creating the file. `code` is kept so
    // callers already branching on ENOENT keep working -- this adds a class, it
    // does not take one away.
    if (err.code === "ENOENT") {
      throw new LauncherError(
        `preset_config_missing: requested preset config does not exist: ${path}`,
        "preset_config_missing", `create ${path}`,
        `requested preset config does not exist: ${path}`, "ENOENT");
    }
    throw new LauncherError(
      `preset_config_invalid: invalid preset config ${path}: could not open file: ${err.message}`,
      "preset_config_invalid", `fix ${path}`,
      `invalid preset config ${path}: could not open file: ${err.message}`, err.code);
  }
  try {
    let info: ReturnType<typeof fstatSync>;
    try {
      info = fstatSync(fd);
    } catch (error) {
      // The incumbent's post-open catch-all: an fstat OSError degrades through
      // `could not read file` (facade) or surfaces raw (native default).
      if (mapFaults) mapFaults("read", error);
      throw error;
    }
    // TWO refusals, not one. The incumbent raises them separately
    // (presets.py:487-497) and the degradation notice interpolates `exc.detail`
    // verbatim, so a merged message reaches the operator as a merged message:
    // "must be a regular file without group/world write permission" tells
    // someone whose config is a DIRECTORY to check its permissions, and someone
    // whose config is mode 666 to check that it is a file. The incumbent names
    // the one fault that is actually true.
    if (!info.isFile()) {
      refuse("preset_config_insecure", `preset config is not a regular file: ${path}`,
             `replace ${path} with an operator-owned regular file`);
    }
    if (info.mode & 0o022) {
      refuse("preset_config_insecure", `preset config is group/world writable: ${path}`,
             `chmod 600 ${path}`);
    }
    let resolved: string;
    try {
      resolved = realpathSync(path);
    } catch (error) {
      // A name removed inside the window: the incumbent's resolve-phase arm
      // (`could not resolve opened file`), native-raw without the mapper.
      if (mapFaults) mapFaults("resolve", error);
      throw error;
    }
    let named: { dev: number; ino: number };
    try {
      named = statSync(resolved) as { dev: number; ino: number };
    } catch (error) {
      if (mapFaults) mapFaults("resolve", error);
      throw error;
    }
    if (named.dev !== info.dev || named.ino !== info.ino) {
      if (mapFaults) mapFaults("race", null);
      refuse("preset_config_insecure", `${path} changed while opening`, `fix ${path}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(fd);
    } catch (error) {
      if (mapFaults) mapFaults("read", error);
      throw error;
    }
    return { bytes, resolvedPath: resolved, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Does this file open with a UTF-8 BOM? Rule 40 / tap-uddlm, family T3.
 *
 * `tomllib` REFUSES a leading U+FEFF -- `Invalid statement (at line 1, column 1)`
 * -- so the incumbent degrades a BOM-prefixed config to no policy and says so.
 * The port reached the opposite answer twice over: `new TextDecoder("utf-8")`
 * defaults to `ignoreBOM: false`, which CONSUMES the BOM before the parser sees
 * anything, and `Bun.TOML.parse` accepts a leading U+FEFF even when handed one
 * directly. Both measured.
 *
 * The consequence ran the wrong way for a fence: a config an editor saved with a
 * BOM had its `[harness.*.env]` policy APPLIED by the port and REFUSED by the
 * incumbent. The more permissive side was ours, on the tier that decides which
 * environment variables reach a child process.
 *
 * So the question is asked of the BYTES, before any decoder gets a chance to be
 * helpful -- which is why `readSecureBytes` hands back raw bytes with the BOM
 * intact, and why an `ignoreBOM: true` flip would be the wrong fix: that makes
 * the BOM survive into the string, where `Bun.TOML.parse` would accept it anyway.
 */
export function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** The parsed projection of a secure read. Decoding is strict, and a leading BOM is refused rather than consumed (tomllib parity). */
export function readCatalog(path: string): CatalogSource {
  const { bytes, resolvedPath, digest } = readSecureBytes(path);
  if (hasUtf8Bom(bytes)) {
    refuse("preset_config_invalid",
      `invalid preset config ${path}: TOML parse failed: a leading UTF-8 BOM is not valid TOML`,
      // The incumbent's action for every parse failure is the bare `fix <path>`
      // (presets.py), and this is one. The BOM-specific guidance lives in the
      // DETAIL, where the incumbent also puts its parser's explanation -- so the
      // operator still learns what is wrong, and the two actions agree byte for
      // byte instead of diverging on a string that was mine to choose.
      `fix ${path}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const data = Bun.TOML.parse(text);
  if (!table(data)) refuse("preset_config_invalid", `${path} is not a TOML table`);
  return { path: resolvedPath, digest, data };
}

export function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
