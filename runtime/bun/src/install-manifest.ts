import { fzfOwnedFiles } from "./fzf-tool";
// Ported from scripts/install_manifest.py (deleted in the same commit): record
// the installer's actual TAP-owned artifacts, including partial installs. The
// manifest is uninstall's authority, so this module reproduces the Python
// recorder's decisions branch for branch — what counts as owned, what is only
// warned about and skipped, and what refuses loudly.
//
// Two deliberate departures, both from docs/solutions/best-practices/
// a-zero-at-the-boundary-describes-the-instrument.md: Python's
// exists()/is_file() family reported EACCES and ELOOP as "absent"; the helpers
// below treat only ENOENT/ENOTDIR as absent and surface every other stat
// error. An unprovable path is never silently absent — a silent absence here
// would drop an owned artifact from the manifest and license its deletion.
//
// SEAM (lane B's S1 flip consumes this): MANIFEST_HOOK_EXPECTATIONS below is
// the one table naming every expected hook command, shim shape and plugin copy
// the scanner admits. Rewiring registrations from the Python guard to the Bun
// hook edits that table, not the scan logic.

import {
  accessSync, constants, existsSync, lstatSync, mkdirSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { atomicWrite, ensureAscii } from "./fsatomic";
import { pyJsonString, pyReadUtf8, pyStrCompare } from "./spool-publication";

export type ManifestEntry = { kind: string; path: string; [key: string]: unknown };

/** Python's `print(..., file=sys.stderr)` WARNING for one unprobeable path. */
function surfaceWarning(path: string, error: unknown): void {
  // The errno code (EACCES, ELOOP...) is the diagnostic Python's exception
  // name carried; a bare "Error" names nothing.
  const detail = (error as NodeJS.ErrnoException)?.code ?? (error as { name?: string })?.name ?? "Error";
  process.stderr.write(`install: WARNING: manifest skipped ${path}: ${detail}; other surfaces still recorded\n`);
}

/** Absent only when the kernel says the path cannot name anything (ENOENT/ENOTDIR). */
export function errnoAwareAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * os.path.realpath (non-strict): resolves every symlink component, including
 * ones whose targets are missing, and keeps missing components literally. The
 * recorder used this to judge ownership of a legacy link before unlinking it,
 * so anything other than absent/not-a-link fails closed.
 */
export function pyRealpath(path: string): string {
  const pending = path.split("/").filter(Boolean).reverse();
  let resolved = "/", links = 0;
  while (pending.length) {
    const name = pending.pop()!;
    if (name === ".") continue;
    if (name === "..") { resolved = dirname(resolved); continue; }
    const next = join(resolved, name);
    let target: string;
    try { target = readlinkSync(next); } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR") { resolved = next; continue; }
      throw error;
    }
    if (++links > 40) throw new Error(`symlink loop resolving ${path}`);
    if (isAbsolute(target)) resolved = "/";
    pending.push(...target.split("/").filter(Boolean).reverse());
  }
  return resolved;
}

function regular(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (errnoAwareAbsent(error)) return false;
    throw error;
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0, at = text.indexOf(needle);
  while (at >= 0) { count++; at = text.indexOf(needle, at + needle.length); }
  return count;
}

/** Python `targets[key]`: a missing target is a KeyError, not undefined. */
function target(targets: Record<string, string>, key: string): string {
  const value = targets[key];
  if (value === undefined) throw new Error(`KeyError: '${key}'`);
  return value;
}

/** Python dict `==`: deep, key-order-blind. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export const CODEX_BEGIN = "# tap-managed:begin Codex SessionStart";
/** The managed shell block is named by its job; blocks written under the earlier name stay recognized and are never renamed in place. */
export const SHELL_BLOCK_BEGIN = "# >>> tap shell integration >>>", SHELL_BLOCK_END = "# <<< tap shell integration <<<";
export const LEGACY_SHELL_BLOCK_BEGIN = "# >>> tap aliases >>>", LEGACY_SHELL_BLOCK_END = "# <<< tap aliases <<<";
export const SHELL_BLOCK_MARKERS: readonly (readonly [string, string])[] = [[SHELL_BLOCK_BEGIN, SHELL_BLOCK_END], [LEGACY_SHELL_BLOCK_BEGIN, LEGACY_SHELL_BLOCK_END]];
export const SHELL_BLOCK_BEGINS: readonly string[] = SHELL_BLOCK_MARKERS.map(([begin]) => begin);
export const CODEX_END = "# tap-managed:end Codex SessionStart";

/**
 * A release artifact root holds an executable libexec/tap/bun. scripts-dir.ts
 * artifactBun() is the runtime's twin of this check; install-time modules keep
 * their import closure small because install fixtures copy it file by file.
 */
function isArtifactRoot(root: string): boolean {
  try {
    accessSync(join(root, "libexec/tap/bun"), constants.X_OK);
    return statSync(join(root, "libexec/tap/bun")).isFile();
  } catch {
    return false;
  }
}

/**
 * The one place naming what the scanner admits as TAP's hook registrations —
 * the flip-time contract with lane B. Command values are exact strings after
 * `{hookroot}` substitution; the OpenCode plugin list names the generated
 * plugin files whose exact bytes are pinned. A release artifact (its root holds
 * libexec/tap/bun, tap-7r3fn.192) has no Bun on PATH, so it registers the guard's
 * .sh door and its shims exec that Bun; a checkout keeps the bare-Bun forms.
 */
export function MANIFEST_HOOK_EXPECTATIONS(hookroot: string) {
  const artifact = isArtifactRoot(resolve(hookroot, ".."));
  const guard = `${hookroot}/tap-shell-body-guard.${artifact ? "sh" : "ts"}`;
  const bun = (repo: string) => (artifact ? `"${repo}/libexec/tap/bun"` : "bun");
  return {
    /** Claude settings.json → hooks: bare absolute paths, one per event. */
    claudeSettings: {
      SessionStart: [`${hookroot}/tap-advisory.sh`],
      PreToolUse: [guard],
    },
    /** Cursor hooks.json: flat rows (nested=false), commands carry their own prefix. */
    cursorHooks: {
      sessionStart: [`bash ${hookroot}/tap-cursor-session-start.sh`],
      beforeShellExecution: [guard],
    },
    /** Codex config.toml fenced block, rendered by hookBlock from these two. */
    codexConfig: { sessionStart: `${hookroot}/tap-codex-session-start.sh`, guard },
    /** Gemini config/hooks.json pinned json-key value. */
    geminiHooks: {
      key: "tap-tmux-kill-server",
      value: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: guard, timeout: 5 }] }] },
    },
    geminiIdentity: { key: "tap-session-identity", value: agyIdentityHookSpec(`${hookroot}/tap-agy-identity.sh`) },
    /**
     * OpenCode plugins: exact-byte-pinned generated files. `shim` entries are
     * generated bash shims (the template builds their bytes); `copy` entries
     * are byte-identical copies of repo/hooks/<name>.
     */
    opencodePlugins: [
      { name: "tap-opencode-session-start.ts", type: "copy" },
      { name: "tap-opencode-tmux-guard.ts", type: "copy" },
      {
        name: "tap-shell-body-guard", type: "shim",
        bytes: (repo: string) => `#!/usr/bin/env bash\nexec ${bun(repo)} "${repo}/hooks/tap-shell-body-guard.ts" "$@"\n`,
      },
      { name: "tap-opencode-session-id", type: "copy" },
      {
        name: "tap-resolve-session-root", type: "shim",
        bytes: (repo: string) => `#!/usr/bin/env bash\nexec ${bun(repo)} "${repo}/runtime/bun/src/session-start.ts" resolve "$@"\n`,
      },
      {
        name: "tap-session-context", type: "shim",
        bytes: (repo: string) => `#!/usr/bin/env bash\nexec ${bun(repo)} "${repo}/runtime/bun/src/session-start.ts" "$@"\n`,
      },
      {
        name: "tap", type: "shim",
        bytes: (repo: string) => `#!/usr/bin/env bash\nexec "${repo}/bin/tap" "$@"\n`,
      },
    ] as Array<{ name: string; type: "copy" | "shim"; bytes?: (repo: string) => string }>,
  };
}

export function agyIdentityHookSpec(hook: string) {
  // Keep this install-time module's copied-fixture import closure unchanged.
  const handler = { type: "command", command: `bash '${hook.replace(/'/g, "'\\''")}'`, timeout: 4 };
  return { PreInvocation: [handler], PostInvocation: [handler] };
}

/**
 * Byte-faithful twin of `codex_hook_config.hook_block`: each line (markers
 * included) terminated with `newline`, so `Buffer.from(hookBlock(...))` is the
 * fence bytes and a consumer that wants the in-file shape strips the trailing
 * newline (`block()` here does exactly the Python's `.decode().rstrip("\n")`).
 * `json.dumps` of a path is ensure_ascii with short escapes — `pyJsonString`
 * is the oracle-verified implementation of exactly that.
 */
export function hookBlock(hook: string, guard: string, newline = "\n"): string {
  return [
    CODEX_BEGIN,
    `[[hooks.SessionStart]]`, `matcher = "startup|resume|clear|compact"`, ``,
    `[[hooks.SessionStart.hooks]]`, `type = "command"`,
    `command = ${pyJsonString(hook)}`, ``,
    `[[hooks.PreToolUse]]`, `matcher = "^Bash$"`, ``,
    `[[hooks.PreToolUse.hooks]]`, `type = "command"`,
    `command = ${pyJsonString(guard)}`, `timeout = 5`,
    `statusMessage = "Checking tmux server target"`, CODEX_END,
  ].map(line => line + newline).join("");
}

/** True when config.toml is missing or has no TAP begin-marker line; unreadable counts as present. */
function codexFenceAbsent(path: string): boolean {
  let text: string;
  try { text = readFileSync(path, "latin1"); } catch (error) { return errnoAwareAbsent(error); }
  return !text.split(/\r?\n|\r/).includes(CODEX_BEGIN);
}

/**
 * The one consumer of the TOML baseline scan: `container_baselines` records
 * WHICH top-level keys a user's config lacked before the installer touched it,
 * so uninstall can restore a container it created. The booleans are tomllib's
 * verdict, computed exactly as the deleted Python did — `'hooks' not in d`,
 * `'features' not in d`, `'hooks' not in d.get('features', {})` — so dotted
 * keys, arrays of tables and inline tables count the same way they did there.
 * Parsing uses Bun.TOML.parse, the same facility machine.ts uses to remove
 * these containers; a parse error propagates and records NO baseline, matching
 * the recorder's except-pass.
 */
export function tomlBaselines(text: string): { hooks: boolean; features: boolean; features_hooks: boolean } {
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  return {
    hooks: !("hooks" in parsed),
    features: !("features" in parsed),
    features_hooks: !pyMembership(parsed["features"] ?? {}, "hooks"),
  };
}

/** Python's `key in container`: dict membership, list/str membership, TypeError otherwise. */
function pyMembership(container: unknown, key: string): boolean {
  if (typeof container === "string") return container.includes(key);
  if (Array.isArray(container)) return container.includes(key);
  if (typeof container === "object" && container !== null) return key in container;
  throw new TypeError(`argument of type '${typeof container}' is not iterable`);
}

/**
 * The uninstall reconciliation scan, ported from install_manifest.py's
 * `scan()`. `argvIncludesScan` reproduces the Python module's
 * `"--scan" in sys.argv` arm for the AGENTS.md block (the CLI passes true; the
 * in-process caller from machine.ts passes false, exactly as the spawned
 * Python never saw a --scan flag in the TAP_RECORD_AGENTS_DONE arm).
 */
export function scanEntries(repo: string, targets: Record<string, string>, argvIncludesScan: boolean): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  try {
    for (const item of fzfOwnedFiles(repo, targets.INDEX_HOME || join(homedir(), ".tap"))) entries.push({ kind: "file", ...item });
  } catch { /* Missing source metadata or unsupported platforms offer no owned tool. */ }
  const add = (kind: string, path: string, fields: Record<string, unknown> = {}) => { entries.push({ kind, path, ...fields }); };
  const surface = (path: string, body: () => void): void => {
    try { body(); } catch (error) { surfaceWarning(path, error); }
  };
  const block = (path: string, begin: string, end: string, expected?: string) => surface(path, () => {
    if (!regular(path)) return;
    const text = pyReadUtf8(path);
    // A CRLF file holds the fence with \r\n line endings while `expected` is
    // LF: detection and comparison run on normalized text, but the recorded
    // content is the on-disk slice so uninstall's raw rewrite removes the
    // exact bytes. Markers contain no \r, so counts and marker order are
    // identical in both texts.
    const flat = text.replace(/\r\n/g, "\n");
    if (countOccurrences(flat, begin) === 1 && countOccurrences(flat, end) === 1) {
      const flatStart = flat.indexOf(begin), flatStop = flat.indexOf(end) + end.length;
      if (flatStop > flatStart && (expected === undefined || flat.slice(flatStart, flatStop) === expected)) {
        add("block", path, { begin, end, content: text.slice(text.indexOf(begin), text.indexOf(end) + end.length) });
      }
    }
  });
  const hooks = (path: string, events: Record<string, string[]>, nested: boolean) => surface(path, () => {
    if (!regular(path)) return;
    const data: unknown = JSON.parse(pyReadUtf8(path));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    const hooksMap = (data as Record<string, unknown>)["hooks"];
    if (typeof hooksMap !== "object" || hooksMap === null || Array.isArray(hooksMap)) return;
    for (const [event, commands] of Object.entries(events)) {
      const rows = (hooksMap as Record<string, unknown>)[event];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
        const leaves = nested ? (row as Record<string, unknown>)["hooks"] : [row];
        if (!Array.isArray(leaves)) continue;
        for (const leaf of leaves) {
          if (typeof leaf === "object" && leaf !== null && !Array.isArray(leaf)
            && commands.includes((leaf as Record<string, unknown>)["command"] as string)) {
            add("hook", path, { event, nested, value: leaf });
          }
        }
      }
    }
  });
  const homeKeys = ["CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME", "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME"];
  for (const key of homeKeys) {
    const directory = join(target(targets, key), "skills");
    surface(directory, () => {
      let names: string[];
      try {
        // Python's Path.is_dir() FOLLOWS a symlinked skills directory and
        // scans what it points at; statSync (not lstatSync) keeps that parity.
        // Absence stays quiet; ELOOP/EACCES still warn.
        if (!statSync(directory).isDirectory()) return;
        names = readdirSync(directory).sort(pyStrCompare);
      } catch (error) {
        if (errnoAwareAbsent(error)) return;
        throw error;
      }
      for (const name of names) {
        const path = join(directory, name);
        try {
          if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === join(repo, "skills", name)) {
            add("symlink", path, { target: readlinkSync(path) });
          }
        } catch (error) {
          if (errnoAwareAbsent(error)) continue;
          throw error;
        }
      }
    });
  }
  for (const [path, linkTarget] of [
    [join(target(targets, "BIN_DIR"), "tap"), join(repo, "bin/tap")],
    [join(target(targets, "BIN_DIR"), "../share/zsh/site-functions/_tap"), join(repo, "completions/_tap")],
    [join(target(targets, "INDEX_HOME"), "ingest/README.md"), join(repo, "skills/lead/references/ingest/README.md")],
  ] as Array<[string, string]>) {
    surface(path, () => {
      // Python's path.is_symlink() is False for a missing path: absence here
      // is the quiet first-install shape, not a warning.
      let isLink: boolean;
      try {
        isLink = lstatSync(path).isSymbolicLink();
      } catch (error) {
        if (errnoAwareAbsent(error)) return;
        throw error;
      }
      if (isLink && readlinkSync(path) === linkTarget) add("symlink", path, { target: linkTarget });
    });
  }
  const hookroot = join(repo, "hooks");
  const expected = MANIFEST_HOOK_EXPECTATIONS(hookroot);
  hooks(join(target(targets, "CLAUDE_HOME"), "settings.json"), expected.claudeSettings, true);
  hooks(join(target(targets, "CURSOR_HOME"), "hooks.json"), expected.cursorHooks, false);
  if (process.env["TAP_RECORD_AGENTS_DONE"] === "1" || argvIncludesScan) {
    block(join(target(targets, "CODEX_HOME"), "AGENTS.md"), "<!-- tap:begin -->", "<!-- tap:end -->");
  }
  block(join(target(targets, "CODEX_HOME"), "config.toml"), CODEX_BEGIN, CODEX_END,
    hookBlock(expected.codexConfig.sessionStart, expected.codexConfig.guard).replace(/\n$/, ""));
  const agy = join(target(targets, "GEMINI_HOME"), "config/hooks.json");
  surface(agy, () => {
    if (!regular(agy)) return;
    const data = JSON.parse(pyReadUtf8(agy));
    for (const hook of [expected.geminiHooks, expected.geminiIdentity]) {
      if (deepEqual((data as Record<string, unknown>)[hook.key], hook.value)) {
        add("json-key", agy, { key: hook.key, value: hook.value });
      }
    }
  });
  const plugins = join(target(targets, "OPENCODE_HOME"), "plugins");
  for (const plugin of expected.opencodePlugins) {
    const path = join(plugins, plugin.name);
    surface(path, () => {
      if (!regular(path)) return;
      const expectedBytes = plugin.type === "copy"
        ? readFileSync(join(repo, "hooks", plugin.name))
        : Buffer.from(plugin.bytes!(repo));
      if (readFileSync(path).equals(expectedBytes)) {
        add("file", path, { sha256: createHash("sha256").update(expectedBytes).digest("hex") });
      }
    });
  }
  return entries;
}

/** install_manifest.py's `key(entry)` dedupe identity. */
function entryKey(entry: ManifestEntry): string {
  return JSON.stringify([
    entry.kind, entry.path, entry.event ?? null, entry.key ?? null, entry.begin ?? null,
    entry.kind === "hook" ? (entry.value as { command?: string } | undefined)?.command ?? null : null,
  ]);
}

/** The manifest's own record, read with the recorder's refusal rules. */
export function readManifestRecord(manifestPath: string): Record<string, unknown> & { version: number; entries: ManifestEntry[] } {
  try {
    if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("symlink manifest");
  } catch (error) {
    // A first install has no manifest yet: absent, not invalid. is_symlink()
    // reported the same; every other stat failure is real and propagates.
    if (!errnoAwareAbsent(error)) throw error;
  }
  const manifest: unknown = existsSync(manifestPath) ? JSON.parse(pyReadUtf8(manifestPath)) : { version: 1, entries: [] };
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || (manifest as Record<string, unknown>)["version"] !== 1 || !Array.isArray((manifest as Record<string, unknown>)["entries"])) {
    throw new Error("invalid manifest structure");
  }
  return manifest as Record<string, unknown> & { version: number; entries: ManifestEntry[] };
}

/**
 * machine.ts's uninstall reconciliation, in-process: the spawn of
 * `install_manifest.py --scan` retired with the module it ran. Refusals throw;
 * the caller owns the user-facing message.
 */
export function scanManifestEntries(manifestPath: string): ManifestEntry[] {
  const manifest = readManifestRecord(manifestPath);
  if (typeof manifest["repo"] !== "string") throw new Error("KeyError: 'repo'");
  if (typeof manifest["targets"] !== "object" || manifest["targets"] === null) throw new Error("KeyError: 'targets'");
  return scanEntries(manifest["repo"] as string, manifest["targets"] as Record<string, string>, true);
}

function shlexQuote(value: string): string {
  return `'` + value.replaceAll(`'`, `'\\''`) + `'`;
}

/** install_manifest.py's main(): one recording pass. Returns the process exit code. */
export function recordManifest(argv: string[]): number {
  const manifestPath = process.env["TAP_INSTALL_MANIFEST"] || join(homedir(), ".tap/install-manifest.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = readManifestRecord(manifestPath);
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "Error";
    process.stderr.write(`install: WARNING: invalid install manifest ${manifestPath}; preserve it and inspect before rerunning ./install.sh (${name})\n`);
    return 1;
  }
  if (argv[0] === "--owned-completion") {
    const path = argv[1];
    const previousRepo = manifest["repo"];
    if (argv.length !== 2 || !path || typeof previousRepo !== "string" || !isAbsolute(previousRepo)) return 1;
    const target = join(previousRepo, "completions/_tap");
    const recorded = (manifest["entries"] as ManifestEntry[]).some(entry =>
      entry.kind === "symlink" && entry.path === path && entry.target === target);
    if (!recorded) return 1;
    try {
      if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) return 1;
    } catch { return 1; }
    process.stdout.write(target);
    return 0;
  }
  if (argv.includes("--scan")) {
    if (typeof manifest["repo"] !== "string") throw new Error("KeyError: 'repo'");
    if (typeof manifest["targets"] !== "object" || manifest["targets"] === null) throw new Error("KeyError: 'targets'");
    process.stdout.write(`${ensureAscii(JSON.stringify(scanEntries(manifest["repo"] as string, manifest["targets"] as Record<string, string>, true)))}\n`);
    return 0;
  }
  const repo = process.env["TAP_INSTALL_REPO"];
  if (repo === undefined) throw new Error("KeyError: 'TAP_INSTALL_REPO'");
  const targets: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("TAP_RECORD_") && value !== undefined) targets[key.slice("TAP_RECORD_".length)] = value;
  }
  // Capture absence before installer writes; old manifests without evidence preserve containers.
  const baselines = (manifest["container_baselines"] ??= {}) as Record<string, unknown>;
  if (argv.includes("--init")) {
    const activePaths = new Set((manifest["entries"] as ManifestEntry[]).map(entry => entry.path));
    for (const path of Object.keys(baselines)) if (!activePaths.has(path)) delete baselines[path];
    for (const [path, toml] of [
      [join(target(targets, "CLAUDE_HOME"), "settings.json"), false],
      [join(target(targets, "CODEX_HOME"), "config.toml"), true],
    ] as Array<[string, boolean]>) {
      // A baseline describes the file before TAP's edit, so it holds only
      // while that edit is present. A config.toml without TAP's fence (an
      // uninstall that kept the entry, or a hand-removed block) is measured
      // again: a [features] hooks = true found now is the user's.
      if (path in baselines && !(toml && codexFenceAbsent(path))) continue;
      let isSymlink = false;
      try { isSymlink = lstatSync(path).isSymbolicLink(); } catch (error) { if (!errnoAwareAbsent(error)) throw error; }
      if (isSymlink) continue;
      try {
        if (toml) {
          if (!existsSync(path)) {
            baselines[path] = { hooks: true, features: true, features_hooks: true, created_file: true };
            continue;
          }
          // A parse error propagates to the catch and records NO baseline —
          // the recorder's except-pass.
          baselines[path] = tomlBaselines(pyReadUtf8(path));
          continue;
        }
        if (!existsSync(path)) {
          baselines[path] = { hooks: true, events: ["SessionStart", "PreToolUse"], created_file: true };
          continue;
        }
        const data: unknown = JSON.parse(pyReadUtf8(path));
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
        // Python looked INSIDE data.get('hooks', {}): an event the user's own
        // hooks container already carries is theirs, not one TAP created.
        baselines[path] = {
          hooks: !("hooks" in data),
          events: (["SessionStart", "PreToolUse"] as const).filter(e => !pyMembership((data as Record<string, unknown>)["hooks"] ?? {}, e)),
        };
      } catch { /* The Python arm swallows OSError/ValueError/TypeError here too. */ }
    }
    // Files TAP writes whole when absent: uninstall deletes them once only
    // TAP's empty skeleton remains, instead of leaving a husk.
    for (const [key, file] of [["CODEX_HOME", "AGENTS.md"], ["CURSOR_HOME", "hooks.json"], ["GEMINI_HOME", "config/hooks.json"]] as const) {
      if (targets[key] === undefined) continue;
      const path = join(targets[key], file);
      if (path in baselines) continue;
      try { lstatSync(path); } catch (error) {
        if (errnoAwareAbsent(error)) baselines[path] = { created_file: true };
      }
    }
  }
  const shellUpdates: Array<{ path: string; previous: string; updated: string }> = [];
  let migration: ManifestEntry | null = null;
  if (argv.includes("--migrate-bin")) {
    const old = join(homedir(), "Scripts/tap");
    const destination = join(target(targets, "BIN_DIR"), "tap");
    if (destination !== join(homedir(), ".local/bin/tap")) return 0;
    let oldStat;
    try { oldStat = lstatSync(old); } catch (error) { if (errnoAwareAbsent(error)) return 0; throw error; }
    const oldReal = pyRealpath(old);
    let repoReal = repo;
    try { repoReal = realpathSync(repo); } catch { /* A non-probeable repo still anchors ownership by its literal path. */ }
    const owned = oldStat.isSymbolicLink() && (oldReal === repoReal || oldReal.startsWith(`${repoReal}/`));
    if (!owned) {
      process.stderr.write(`install: skipped legacy ${old} — refusing to remove a user-owned file or foreign symlink\n`);
      return 0;
    }
    let destinationLink = false, destinationTarget = "";
    try { destinationLink = lstatSync(destination).isSymbolicLink(); destinationTarget = readlinkSync(destination); } catch (error) {
      if (!errnoAwareAbsent(error)) throw error;
    }
    if (!destinationLink || destinationTarget !== join(repo, "bin/tap")) {
      throw new Error("new tap link must exist before migration");
    }
    migration = { kind: "migration", path: old, target: readlinkSync(old), destination };
    for (const entry of manifest["entries"] as ManifestEntry[]) {
      if (entry.kind !== "block" || typeof entry.begin !== "string" || !SHELL_BLOCK_BEGINS.includes(entry.begin)) continue;
      let raw: string;
      try {
        raw = pyReadUtf8(entry.path);
      } catch (error) { if (errnoAwareAbsent(error)) continue; throw error; }
      const previous = entry.content as string;
      if (lstatSync(entry.path).isSymbolicLink() || countOccurrences(raw, previous) !== 1) {
        throw new Error(`preserving edited shell block and legacy tap link: ${entry.path}`);
      }
      // Preserve aliases and outside bytes; move only this recorded PATH entry.
      const destinationParent = destination.slice(0, destination.lastIndexOf("/"));
      const updated = previous.split("\n")
        .map(line => line.startsWith("export PATH=")
          ? line.replaceAll("$HOME/Scripts", "$HOME/.local/bin").replaceAll(join(homedir(), "Scripts"), destinationParent)
          : line)
        .join("\n");
      const exportLine = `export PATH=${shlexQuote(destinationParent)}:"$PATH"`;
      const pathLines = updated.split("\n").filter(line => line.startsWith("export PATH=")).join("\n");
      let final = updated;
      if (!pathLines.includes(destinationParent) && !pathLines.includes("$HOME/.local/bin")) {
        final = updated.replaceAll(entry.end as string, `${exportLine}\n${entry.end}`);
      }
      if (final !== previous) {
        shellUpdates.push({ path: entry.path, previous: raw, updated: raw.replaceAll(previous, final) });
        entry.content = final;
      }
    }
  }
  const found = argv.includes("--init") ? [] : scanEntries(repo, targets, false);
  const entries = new Map<string, ManifestEntry>();
  for (const entry of manifest["entries"] as ManifestEntry[]) entries.set(entryKey(entry), entry);
  // E4 retirement: older installs recorded a python3 interpreter pin and a
  // .py shell-body-guard twin as plain file entries. They leave existing
  // machines only through a hash-matched cleanup — the recorder unlinks the
  // artifact and drops the entry when the recorded sha256 still matches the
  // bytes on disk, and preserves both with a warning when the bytes moved
  // (uninstall must not chase an artifact someone edited on purpose).
  const indexDir = dirname(manifestPath);
  for (const [key, entry] of entries) {
    if (entry.kind !== "file") continue;
    const retired = (entry.path === join(indexDir, "python3"))
      || entry.path.endsWith("/tap-shell-body-guard.py")
      || (targets.OPENCODE_HOME !== undefined
        && entry.path === join(targets.OPENCODE_HOME, "plugins", "tap-opencode-session-env.ts"));
    if (!retired) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(entry.path);
    } catch (error) {
      if (!errnoAwareAbsent(error)) {
        // Unreadable is not absent: keep the entry so later installs retry
        // and uninstall keeps its ownership record.
        process.stderr.write(`install: WARNING: stale recorded artifact ${entry.path} kept: unreadable (${(error as NodeJS.ErrnoException)?.code ?? "error"}); inspect it, then remove it by hand\n`);
        continue;
      }
      entries.delete(key); // already gone; the stale entry would only block a future reinstall
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry.sha256 === digest) {
      unlinkSync(entry.path);
      entries.delete(key);
      process.stderr.write(`install: retired stale recorded artifact ${entry.path} (hash matched)\n`);
    } else {
      process.stderr.write(`install: WARNING: stale recorded artifact ${entry.path} kept: recorded sha256 does not match the bytes on disk; inspect it, then remove it by hand\n`);
    }
  }
  for (const entry of found) {
    if (entry.path in baselines) entry["created_containers"] = baselines[entry.path];
    entries.set(entryKey(entry), entry);
  }
  if (migration) {
    // Journal both locations before unlinking; the old path stops being an uninstall target.
    for (const [key, entry] of entries) {
      if (entry.kind === "symlink" && entry.path === migration.path) entries.delete(key);
    }
    entries.set(entryKey(migration), migration);
  }
  // install.sh exports the hooks directory it armed (tap-hooks attribute); record
  // the config only while it still holds that value, so uninstall unsets only ours.
  const hookdir = process.env["TAP_INSTALL_HOOKS_PATH"];
  if (hookdir) {
    const result = spawnSync("git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim() === hookdir) {
      const entry: ManifestEntry = { kind: "git-config", path: repo, value: hookdir };
      entries.set(entryKey(entry), entry);
    }
  }
  manifest["repo"] = repo;
  manifest["targets"] = targets;
  manifest["entries"] = [...entries.values()];
  writeManifestAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const update of shellUpdates) {
    if (pyReadUtf8(update.path) !== update.previous) {
      throw new Error(`shell file changed during migration; legacy tap link preserved: ${update.path}`);
    }
    writeManifestAtomically(update.path, update.updated);
    process.stdout.write(`install: migrated recorded TAP shell PATH in ${update.path}\n`);
  }
  if (migration) {
    let changed = true;
    try { changed = !lstatSync(migration.path).isSymbolicLink() || readlinkSync(migration.path) !== migration.target; } catch (error) {
      if (!errnoAwareAbsent(error)) throw error;
    }
    if (changed) throw new Error("legacy tap link changed during migration; preserved");
    unlinkSync(migration.path);
    process.stdout.write("install: moved tap from ~/Scripts to ~/.local/bin\n");
  }
  return 0;
}

/**
 * mkstemp-in-destination + os.replace, via the shared staging shape so the
 * operator-state tripwire recognizes the staging name. Mode 0600 matches
 * mkstemp.
 */
export function writeManifestAtomically(dest: string, contents: string): void {
  atomicWrite(dest, contents, 0o600);
}

const USAGE = `usage: install-manifest.ts [--scan] [--init] [--migrate-bin] (env: TAP_INSTALL_MANIFEST, TAP_INSTALL_REPO, TAP_RECORD_*)`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
  } else {
    try {
      process.exitCode = recordManifest(argv);
    } catch (error) {
      process.stderr.write(`install: WARNING: manifest recording failed: ${(error as { name?: string })?.name ?? "Error"}; preserve the manifest and inspect before rerunning ./install.sh\n`);
      process.exitCode = 1;
    }
  }
}
