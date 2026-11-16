/**
 * Installer hook/config surface writers — the Bun port of install.sh's five
 * python heredocs plus scripts/codex_hook_config.py (S2 of the libsh→Bun
 * migration). Each subcommand mirrors its Python original's decisions: the
 * same refusals, the same WARNING-then-skip semantics, the same atomic-write
 * and idempotence behavior. JSON documents parse through the lossless
 * `loads` (insertion-ordered Maps, bigint ints, carried float literals) and
 * serialize through `pyDumpIndent(…, sortKeys=false)` — byte-identical to
 * python's `json.dump(indent=2)` (ensure_ascii escaping, `1.0`/`Infinity`
 * float spellings, bigints verbatim). Files decode strictly: invalid UTF-8
 * refuses where Python's text-mode read raised.
 *
 * Subcommands (argv): claude <settings.json> <hook_cmd> <guard_cmd> ·
 * agents <AGENTS.md> · codex-config <config.toml> <hook_cmd> <guard_cmd> ·
 * codex-legacy <hooks.json> · cursor <hooks.json> <hook_cmd> <guard_cmd> ·
 * gemini <hooks.json> <guard_cmd> · agy-identity <hooks.json> <hook_cmd>.
 */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { pyDumpIndent } from "./lossless-json";
import { CODEX_BEGIN, CODEX_END, hookBlock, agyIdentityHookSpec } from "./install-manifest";
import { asciiTrim, chompEol, CodexFenceError, relocateCodexEndMarker, splitKeepEnds } from "./codex-fence";
import { isMap, loads, type JsonFloat, type JsonMap, type JsonValue } from "./watch-detect";

function errText(error: unknown): string {
  return (error as Error).message ?? String(error);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** mkstemp parity: exclusive-create 0600 temp in the target dir, write, rename. */
function atomicReplace(dir: string, prefix: string, data: string | Buffer, target: string, newline = false): void {
  const tmp = `${dir}/${prefix}${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      // Buffers write byte-raw (the codex path carries non-UTF-8 bytes).
      // writeSync may short-write under pressure; python's buffered f.write
      // loops until complete, so the port loops too.
      const payload = typeof data === "string" ? Buffer.from(newline ? `${data}\n` : data, "utf8") : data;
      let written = 0;
      while (written < payload.length) written += writeSync(fd, payload, written);
    } catch (error) {
      // Python unlinked its mkstemp temp on every failure path.
      try { rmSync(tmp); } catch { /* best-effort */ }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (error) {
    try { rmSync(tmp); } catch { /* python's cleanup is best-effort too */ }
    throw error;
  }
}

/** python json.dump(indent=2): insertion order, ensure_ascii, lossless numbers. */
function jsonDump(data: JsonValue): string {
  return `${pyDumpIndent(data, 0, false)}\n`;
}

/** Text-mode read parity: invalid UTF-8 raises (python UnicodeDecodeError). */
// ignoreBOM keeps a leading U+FEFF like python's text-mode open(): the parser
// then refuses it instead of us silently swallowing the bytes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A code-less error so decode failures never masquerade as OSError (the
// WARNING-skip arms key off errno codes).
class DecodeError extends Error {}

function decodeStrict(raw: Buffer): string {
  try {
    return strictUtf8.decode(raw);
  } catch (error) {
    throw new DecodeError((error as Error).message ?? String(error));
  }
}

function readStrict(path: string): string {
  return decodeStrict(readFileSync(path));
}

// Lossless numeric equality: python's `==` across int/float (1 == 1.0).
function deepEq(a: JsonValue, b: JsonValue): boolean {
  const numOf = (v: JsonValue): number | null => {
    if (typeof v === "bigint" || typeof v === "number") return Number(v);
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !isMap(v) && typeof (v as JsonFloat).float === "string") return Number((v as JsonFloat).float);
    return null;
  };
  const na = numOf(a), nb = numOf(b);
  if (na !== null && nb !== null) return na === nb;
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean" || typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]!));
  if (isMap(a) && isMap(b)) return a.size === b.size && [...a.keys()].every(k => b.has(k) && deepEq(a.get(k)!, b.get(k)!));
  return false;
}

// ---------------------------------------------------------------------------
// claude — settings.json SessionStart advisory + PreToolUse shell-body guard
// (install.sh heredoc 1, python: json+os+sys)
// ---------------------------------------------------------------------------

export function claudeHooks(path: string, hookCmd: string, guardCmd: string): number {
  const skip = (verb: string, error: unknown): 0 => {
    const where = verb === "read" ? path : dirname(path);
    const state = verb === "read" ? "readable" : "writable";
    warn(`install: WARNING: skipped Claude hooks — could not ${verb} ${path}: ${errText(error)}; next: make ${where} ${state} and rerun ./install.sh`);
    return 0;
  };
  let data: JsonMap = new Map();
  if (existsSync(path)) {
    let text: string;
    try {
      text = readStrict(path);
    } catch (error) {
      // Python's OSError hit the WARNING-skip; UnicodeDecodeError crashed.
      if ((error as { code?: string }).code !== undefined) return skip("read", error);
      throw error;
    }
    // Python's json.load crash (JSONDecodeError) took the installer down rc 1.
    data = loads(text) as JsonMap;
    if (!isMap(data)) throw new SyntaxError(`${path}: claude settings must be a JSON object`);
  }
  // data.setdefault("hooks", {}) — a present non-object crashes Python rc 1.
  let hooks: JsonMap;
  const hooksRaw = data.get("hooks");
  if (hooksRaw === undefined) {
    hooks = new Map();
    data.set("hooks", hooks);
  } else if (isMap(hooksRaw)) {
    hooks = hooksRaw;
  } else {
    throw new SyntaxError(`${path}: claude settings hooks must be a JSON object`);
  }
  let changed = false;
  let addedSession = false;
  const hooksOf = (event: string): JsonValue[] => {
    const raw = hooks.get(event);
    if (raw === undefined) {
      const fresh: JsonValue[] = [];
      hooks.set(event, fresh);
      return fresh;
    }
    if (Array.isArray(raw)) return raw;
    throw new SyntaxError(`${path}: claude settings ${event} must be a JSON array`);
  };
  const session = hooksOf("SessionStart");
  // python's scan crashes only on what it reaches, and both the for-break and
  // the any() short-circuit: a wired entry stops the scan before later broken
  // rows are touched. Iteration failures mirror entry.get/h.get semantics:
  // a missing "hooks" key iterates nothing; null/number/bool are not
  // iterable; a non-empty string yields characters and a non-empty object
  // yields keys — neither has .get; only arrays carry hook objects.
  let sessionWired = false;
  sessionScan: for (const entry of session) {
    if (!isMap(entry)) throw new SyntaxError(`${path}: claude settings SessionStart rows must be JSON objects`);
    const rawHooks = entry.has("hooks") ? entry.get("hooks") : [];
    const iterable = (): JsonValue[] => {
      if (Array.isArray(rawHooks)) return rawHooks;
      const empty = rawHooks === undefined || rawHooks === "" || (isMap(rawHooks) && rawHooks.size === 0);
      if (!empty) throw new SyntaxError(`${path}: claude settings SessionStart hooks are not a hook list`);
      return [];
    };
    for (const hook of iterable()) {
      if (!isMap(hook)) throw new SyntaxError(`${path}: claude settings SessionStart hook entries must be JSON objects`);
      if (hook.get("command") === hookCmd) {
        sessionWired = true;
        break sessionScan;
      }
    }
  }
  if (sessionWired) {
    process.stdout.write("install: advisory hook already wired in Claude settings\n");
  } else {
    session.push(new Map<string, JsonValue>([["hooks", [new Map<string, JsonValue>([["type", "command"], ["command", hookCmd]])]]]));
    changed = true;
    addedSession = true;
  }

  const preTool = hooksOf("PreToolUse");
  // python filters the entry list with isinstance before touching rows, so a
  // non-object entry is skipped silently, never refused.
  let guardSeen = false;
  let guardChanged = false;
  const bashEntries = preTool.filter(entry => isMap(entry) && entry.get("matcher") === "Bash") as JsonMap[];
  for (const entry of bashEntries) {
    const commands = entry.get("hooks");
    if (!Array.isArray(commands)) continue;
    const keptHooks: JsonValue[] = [];
    for (const hook of commands) {
      if (isMap(hook) && hook.get("type") === "command") {
        // python's hook.get("command", "") defaults only on a MISSING key; a
        // present non-string reaches command.endswith and crashes rc1.
        if (hook.has("command") && typeof hook.get("command") !== "string") throw new SyntaxError(`${path}: claude settings PreToolUse hook command must be a string`);
        const command = typeof hook.get("command") === "string" ? hook.get("command") as string : "";
        if (command === guardCmd) {
          if (guardSeen) { guardChanged = true; continue; }
          guardSeen = true;
          keptHooks.push(hook);
          continue;
        }
        if (command.endsWith("/hooks/tap-shell-body-guard.py")) {
          if (guardSeen) { guardChanged = true; continue; }
          hook.set("command", guardCmd);
          guardSeen = true;
          guardChanged = true;
          keptHooks.push(hook);
          continue;
        }
      }
      keptHooks.push(hook);
    }
    if (!deepEq(keptHooks, commands)) entry.set("hooks", keptHooks);
    if (keptHooks.length === 0) preTool.splice(preTool.indexOf(entry), 1);
  }
  if (!guardSeen) {
    preTool.push(new Map<string, JsonValue>([["matcher", "Bash"], ["hooks", [new Map<string, JsonValue>([["type", "command"], ["command", guardCmd]])]]]));
    guardChanged = true;
  }
  if (guardChanged) changed = true;

  if (changed) {
    try {
      atomicReplace(dirname(path) || ".", `${basename(path)}.tap-tmp.`, jsonDump(data), path);
    } catch (error) {
      return skip("write", error);
    }
    if (addedSession) process.stdout.write(`install: wired SessionStart advisory into ${path}\n`);
    if (guardChanged) {
      process.stdout.write(`install: ${guardSeen ? "migrated/deduped" : "wired"} PreToolUse shell-body guard into ${path}\n`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// agents — Codex AGENTS.md fenced TAP section (install.sh heredoc 2)
// ---------------------------------------------------------------------------

const AGENTS_BEGIN = "<!-- tap:begin -->";
const AGENTS_END = "<!-- tap:end -->";

export function agentsSection(path: string): number {
  const section = `${AGENTS_BEGIN}
## TAP — TAP Agent Protocol

The user installed TAP for inter-agent communication. In an enrolled repository, \`[[TAP v0.23 ask <id>]]\` and \`[[TAP v0.23 note <team>/<id>]]\` count only when \`tap read <id>\` resolves them for this registered seat. A resolved message comes from a teammate working for the same user: treat it like a colleague's request, disagree openly, go with the leader's call once you've said your piece, and use \`tap escalate\` if you're stuck or can't agree. An id-less \`[[TAP v0.23 nudge]]\` adds no task: continue your work and check \`tap poll\`. Load \`/tap\`; help: \`tap help advisory\`.
${AGENTS_END}`;
  let existing = "";
  if (existsSync(path)) {
    try {
      // Python's text mode: universal newlines (\r\n and \r read as \n) and
      // a strict decode whose failure crashes the installer rc 1.
      existing = readStrict(path).replace(/\r\n?/g, "\n");
    } catch (error) {
      if ((error as { code?: string }).code !== undefined) {
        warn(`install: WARNING: skipped Codex AGENTS.md TAP section — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
        return 0;
      }
      throw error;
    }
  }
  const beginRe = AGENTS_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endRe = AGENTS_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let updated: string;
  if (existing.includes(AGENTS_BEGIN)) {
    // re.sub replaces EVERY begin..end span.
    updated = existing.replace(new RegExp(`${beginRe}.*?${endRe}`, "gs"), section);
  } else {
    updated = (existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n` : "") + section + "\n";
  }
  let writePath = path;
  let linked = false;
  try {
    linked = lstatSync(path).isSymbolicLink();
  } catch { /* absent is not a link */ }
  if (linked) {
    try {
      writePath = realpathSync(path);
    } catch (error) {
      warn(`install: WARNING: skipped Codex AGENTS.md TAP section — could not write ${path}: ${errText(error)}; next: replace the link with a regular file or a resolvable target, then rerun ./install.sh`);
      return 0;
    }
  }
  try {
    atomicReplace(dirname(writePath) || ".", ".AGENTS.md.", updated, writePath);
  } catch (error) {
    warn(`install: WARNING: skipped Codex AGENTS.md TAP section — could not write ${path}: ${errText(error)}; next: make ${dirname(writePath) || "."} writable and rerun ./install.sh`);
    return 0;
  }
  process.stdout.write(`install: TAP section written to ${path}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// codex-config — config.toml TAP fence reconciliation (codex_hook_config.py)
// Exit codes: 0 wired/already-wired, 1 refusal, 3 WARNING-skip.
// ---------------------------------------------------------------------------

function countOf(raw: Buffer, needle: Buffer): number {
  let count = 0, at = 0;
  while ((at = raw.indexOf(needle, at)) !== -1) { count++; at += 1; }
  return count;
}

const NONCANONICAL = "a TAP hook command is not one absolute path in a JSON string";

/** codex_hook_config.owned_lines: one generated field, normalized; null for a blank line. */
function ownedLine(line: Buffer, lineNo: number): Buffer | null {
  let stripped = asciiTrim(line);
  if (stripped.length === 0) return null;
  if (asciiStartsWith(stripped, Buffer.from("command = "))) {
    const command = hookCommand(stripped);
    if (command === null) throw new CodexFenceError(NONCANONICAL, [lineNo]);
    let name = basename(command);
    if (name === "tap-shell-body-guard.py") name = "tap-shell-body-guard.ts";
    stripped = Buffer.from(`command = ${name}`);
  }
  if (stripped.toString("utf8") === 'matcher = "startup|resume"') {
    stripped = Buffer.from('matcher = "startup|resume|clear|compact"');
  }
  return stripped;
}

function hookCommand(stripped: Buffer): string | null {
  try {
    const command: unknown = JSON.parse(decodeStrict(stripped.subarray(Buffer.byteLength("command = "))));
    return typeof command === "string" && isAbsolute(command) ? command : null;
  } catch {
    return null;
  }
}

/** Normalized owned fields of `lines` (which start at 1-based `firstLineNo`), with their line numbers. */
function ownedLines(lines: Buffer[], firstLineNo = 1): Array<{ line: Buffer; lineNo: number }> {
  const result: Array<{ line: Buffer; lineNo: number }> = [];
  lines.forEach((raw, i) => {
    const line = ownedLine(raw, firstLineNo + i);
    if (line) result.push({ line, lineNo: firstLineNo + i });
  });
  return result;
}

/** Each hook's trimmed fence lines, keyed by event, so a rewrite can name what changed. */
function hookSections(lines: Buffer[]): Map<string, string> {
  const sections = new Map<string, string>();
  let event: string | null = null;
  for (const line of lines) {
    const text = asciiTrim(line).toString("utf8");
    const header = /^\[\[hooks\.(SessionStart|PreToolUse)\]\]$/.exec(text);
    if (header) event = header[1]!;
    if (event && text) sections.set(event, `${sections.get(event) ?? ""}${text}\n`);
  }
  return sections;
}

function asciiStartsWith(buf: Buffer, prefix: Buffer): boolean {
  if (buf.length < prefix.length) return false;
  return buf.subarray(0, prefix.length).equals(prefix);
}

/** codex_hook_config.enable_first_install_features. */
function enableFirstInstallFeatures(lines: Buffer[], newline: string): void {
  const nl = Buffer.from(newline);
  const lineFeed = Buffer.from("\n");
  let inFeatures = false;
  let featuresIdx: number | null = null;
  let hooksIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const stripped = asciiTrim(lines[i]!).toString("utf8");
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inFeatures = stripped === "[features]";
      if (inFeatures) featuresIdx = i;
    } else if (inFeatures && /^hooks[ \t]*=[ \t]*(true|false)\b/.test(stripped)) {
      hooksIdx = i;
    }
  }
  if (hooksIdx !== null) {
    // Python re.sub ran on the raw bytes: the leading \s* group keeps the
    // line's own indentation, and latin1 round-trips every byte 1:1.
    const raw = lines[hooksIdx]!;
    lines[hooksIdx] = Buffer.from(raw.toString("latin1").replace(/^([ \t\n\r\f\v]*hooks[ \t\n\r\f\v]*=[ \t\n\r\f\v]*)(?:true|false)\b/, "$1true"), "latin1");
  } else if (featuresIdx !== null) {
    const line = lines[featuresIdx]!;
    // Python tested endswith(b"\n") but appended the DETECTED newline — a
    // no-EOL tail line in a CRLF file gains \r\n, and an LF-terminated line
    // is left alone.
    if (!bufEndsWith(line, lineFeed)) lines[featuresIdx] = Buffer.concat([line, nl]);
    lines.splice(featuresIdx + 1, 0, Buffer.from(`hooks = true${newline}`));
  } else {
    if (lines.length && !bufEndsWith(lines[lines.length - 1]!, lineFeed)) lines.push(nl);
    lines.push(nl, Buffer.from(`[features]${newline}`), Buffer.from(`hooks = true${newline}`));
  }
}

function bufEndsWith(buf: Buffer, suffix: Buffer): boolean {
  if (buf.length < suffix.length) return false;
  return buf.subarray(buf.length - suffix.length).equals(suffix);
}

export type Reconciled = {
  bytes: Buffer;
  /** Hooks whose fence lines changed, which Codex asks the user to trust again. */
  changedHooks: string[];
  /** The hooks directory an existing fence pointed at, when it differs from the new one. */
  previousHookDir: string | null;
  /** The 1-based lines of Codex tables the end marker moved above. */
  movedTables: [number, number] | null;
};

/** codex_hook_config.reconcile: pure byte-level fence reconciliation. */
export function reconcile(raw: Buffer, hook: string, guard: string): Reconciled {
  const newline = raw.includes(0x0d, 0) && raw.toString("latin1").includes("\r\n") ? "\r\n" : "\n";
  const block = splitKeepEnds(Buffer.from(hookBlock(hook, guard, newline)));
  const wanted = ownedLines(block.slice(1, -1)).map(owned => owned.line);
  let lines = splitKeepEnds(raw);
  const beginB = Buffer.from(CODEX_BEGIN);
  const endB = Buffer.from(CODEX_END);
  const starts: number[] = [], ends: number[] = [], mentions: number[] = [];
  lines.forEach((line, i) => {
    const bare = chompEol(line);
    if (bare.equals(beginB)) starts.push(i);
    if (bare.equals(endB)) ends.push(i);
    if (line.includes(beginB) || line.includes(endB)) mentions.push(i + 1);
  });
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length
    || countOf(raw, beginB) !== starts.length || countOf(raw, endB) !== ends.length) {
    throw new CodexFenceError("malformed TAP markers", mentions);
  }
  if (!starts.length) {
    enableFirstInstallFeatures(lines, newline);
    if (lines.length && !bufEndsWith(lines[lines.length - 1]!, Buffer.from("\n"))) lines.push(Buffer.from(newline));
    if (!lines.some(line => asciiTrim(line).toString("utf8") === "[hooks]")) {
      lines.push(Buffer.from(newline), Buffer.from(`[hooks]${newline}`));
    }
    lines.push(Buffer.from(newline), ...block);
    return { bytes: Buffer.concat(lines), changedHooks: ["SessionStart", "PreToolUse"], previousHookDir: null, movedTables: null };
  }
  const start = starts[0]!;
  let stop = ends[0]!;
  if (stop < start) throw new CodexFenceError("reversed TAP markers", [stop + 1, start + 1]);
  const fence: [number, number] = [start + 1, stop + 1];
  const eq = (a: Buffer[], b: Buffer[]) => a.length === b.length && a.every((line, i) => line.equals(b[i]!));
  // Codex's own tables trail TAP's complete block: move the end marker above them.
  let movedTables: [number, number] | null = null;
  const prefix: Buffer[] = [];
  for (const line of lines.slice(start + 1, stop)) {
    if (prefix.length === wanted.length) break;
    if (!asciiTrim(line).length) continue;
    try { prefix.push(ownedLine(line, 0)!); } catch { break; }
  }
  if (eq(prefix, wanted)) {
    let relocated;
    try {
      relocated = relocateCodexEndMarker(raw, wanted.length);
    } catch (error) {
      if (error instanceof CodexFenceError) throw new CodexFenceError(error.message, error.lines, fence);
      throw error;
    }
    if (relocated.moved) {
      movedTables = relocated.moved;
      lines = splitKeepEnds(relocated.raw);
      stop = start + 1 + lines.slice(start + 1).findIndex(line => chompEol(line).equals(endB));
    }
  }
  const body = lines.slice(start + 1, stop);
  let owned;
  try {
    owned = ownedLines(body, start + 2);
  } catch (error) {
    if (error instanceof CodexFenceError) throw new CodexFenceError(error.message, error.lines, fence);
    throw error;
  }
  const actual = owned.map(entry => entry.line);
  if (!eq(actual, wanted) && !eq(actual, wanted.slice(0, 5)) && actual.length !== 0) {
    const foreign = owned.find((entry, i) => !wanted[i] || !entry.line.equals(wanted[i]!)) ?? owned[owned.length - 1]!;
    throw new CodexFenceError("lines TAP does not own sit between TAP's markers", [foreign.lineNo], fence);
  }
  const before = hookSections(body), after = hookSections(block.slice(1, -1));
  const changedHooks = ["SessionStart", "PreToolUse"].filter(event => before.get(event) !== after.get(event));
  const previous = body.map(line => asciiTrim(line)).find(line => asciiStartsWith(line, Buffer.from("command = ")));
  const previousCommand = previous ? hookCommand(previous) : null;
  const previousHookDir = previousCommand && dirname(previousCommand) !== dirname(hook) ? dirname(previousCommand) : null;
  block[0] = lines[start]!;
  block[block.length - 1] = lines[stop]!;
  lines.splice(start, stop - start + 1, ...block);
  return { bytes: Buffer.concat(lines), changedHooks, previousHookDir, movedTables };
}

/** The multi-line refusal: what is wrong, where, and one way out. */
function refusalText(path: string, error: unknown): string {
  if (!(error instanceof CodexFenceError)) return `install: refusing to edit Codex hooks in ${path}: ${errText(error)}`;
  const at = error.lines.length ? ` (line${error.lines.length > 1 ? "s" : ""} ${error.lines.join(", ")})` : "";
  const out = [`install: refusing to edit Codex hooks in ${path}`, `  cause: ${error.message}${at}`];
  if (error.fence) {
    out.push(`  TAP's markers are lines ${error.fence[0]} and ${error.fence[1]}; between them TAP keeps only its SessionStart and Bash PreToolUse hook arrays.`);
    out.push(error.message === NONCANONICAL
      ? `  next: back up ${path}, delete lines ${error.fence[0]}-${error.fence[1]} if they hold only TAP's hooks (the installer writes them again), and rerun ./install.sh`
      : `  next: back up ${path}, move the lines TAP does not own to just after the end marker without changing them, and rerun ./install.sh`);
  } else {
    out.push(`  next: back up ${path}, keep one "${CODEX_BEGIN}" line followed by one "${CODEX_END}" line, and rerun ./install.sh`);
  }
  return out.join("\n");
}

export function codexConfig(path: string, hook: string, guard: string): number {
  let raw = Buffer.alloc(0);
  if (existsSync(path)) {
    try {
      raw = readFileSync(path);
    } catch (error) {
      warn(`install: WARNING: skipped Codex config.toml hooks — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
      return 3;
    }
  }
  let result: Reconciled;
  try {
    result = reconcile(raw, hook, guard);
  } catch (error) {
    warn(refusalText(path, error));
    return 1;
  }
  const updated = result.bytes;
  if (updated.equals(raw)) {
    process.stdout.write("install: Codex hooks already wired in config.toml\n");
    return 0;
  }
  let current = Buffer.alloc(0);
  if (existsSync(path)) {
    try {
      current = readFileSync(path);
    } catch (error) {
      warn(`install: WARNING: skipped Codex config.toml hooks — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
      return 3;
    }
  }
  if (!current.equals(raw)) {
    warn("install: config.toml changed during reconciliation; refusing without writing");
    return 1;
  }
  try {
    atomicReplace(dirname(path) || ".", ".tap-codex-config.", updated, path);
  } catch (error) {
    warn(`install: WARNING: skipped Codex config.toml hooks — could not write ${path}: ${errText(error)}; next: make ${dirname(path) || "."} writable and rerun ./install.sh`);
    return 3;
  }
  if (result.movedTables) {
    process.stdout.write(`install: moved the TAP end marker in ${path} above the tables Codex added at lines ${result.movedTables[0]}-${result.movedTables[1]}; their bytes are unchanged\n`);
  }
  if (result.previousHookDir) {
    process.stdout.write(`install: replaced TAP's Codex hooks that pointed at ${result.previousHookDir}\n`);
  }
  const changed = result.changedHooks;
  if (changed.length) {
    const names = changed.join(" and "), noun = changed.length > 1 ? "hooks" : "hook";
    process.stdout.write(`install: wired Codex ${names} ${noun} into ${path}\n`);
    process.stdout.write(`install: NOTE — open /hooks in Codex to review and trust the new ${names} ${noun}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// codex-legacy — hooks.json SessionStart migration cleanup (heredoc 3)
// ---------------------------------------------------------------------------

export function codexLegacy(path: string): number {
  if (!existsSync(path)) return 0;
  let data: JsonMap;
  try {
    // UnicodeDecodeError is a ValueError: Python's except caught it and
    // warned, exactly like invalid JSON.
    data = loads(readStrict(path)) as JsonMap;
  } catch (error) {
    if ((error as { code?: string }).code !== undefined) {
      warn(`install: WARNING: skipped Codex legacy hooks.json cleanup — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
      return 0;
    }
    warn(`install: WARNING: cannot migrate TAP from invalid ${path}: ${errText(error)}`);
    return 0;
  }
  // Python's dict ops on a non-object root crashed the installer rc 1; a
  // non-object hooks VALUE hit `if not isinstance(hooks, dict): sys.exit(0)`
  // and left the file untouched.
  if (!isMap(data)) throw new SyntaxError(`${path}: codex legacy hooks.json must be a JSON object`);
  const hooksRaw = data.get("hooks");
  if (hooksRaw === undefined) return 0;
  if (!isMap(hooksRaw)) return 0;
  const hooks = hooksRaw;
  const entries = hooks.get("SessionStart");
  if (!Array.isArray(entries)) return 0;

  let changed = false;
  const keptEntries: JsonValue[] = [];
  for (const entry of entries) {
    if (!isMap(entry)) { keptEntries.push(entry); continue; }
    const commands = entry.get("hooks");
    if (!Array.isArray(commands)) { keptEntries.push(entry); continue; }
    const keptCommands = commands.filter(command =>
      !(isMap(command) && String(typeof command.get("command") === "string" ? command.get("command") : "").includes("tap-codex-session-start")));
    if (keptCommands.length !== commands.length) changed = true;
    if (keptCommands.length) {
      const keptEntry = new Map(entry);
      keptEntry.set("hooks", keptCommands);
      keptEntries.push(keptEntry);
    }
  }
  if (!changed) return 0;
  if (keptEntries.length) hooks.set("SessionStart", keptEntries);
  else {
    hooks.delete("SessionStart");
    if (hooks.size === 0) data.delete("hooks");
  }
  if (data.size === 0) {
    try {
      rmSync(path);
    } catch (error) {
      warn(`install: WARNING: skipped Codex legacy hooks.json cleanup — could not write ${path}: ${errText(error)}; next: make ${dirname(path) || "."} writable and rerun ./install.sh`);
      return 0;
    }
    process.stdout.write(`install: removed TAP-only legacy ${path}\n`);
    return 0;
  }
  try {
    atomicReplace(dirname(path) || ".", ".tap-codex-hooks.", jsonDump(data), path);
  } catch (error) {
    warn(`install: WARNING: skipped Codex legacy hooks.json cleanup — could not write ${path}: ${errText(error)}; next: make ${dirname(path) || "."} writable and rerun ./install.sh`);
    return 0;
  }
  process.stdout.write(`install: removed legacy TAP hook from ${path}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// cursor — hooks.json sessionStart + beforeShellExecution guard (heredoc 4)
// ---------------------------------------------------------------------------

export function cursorHooks(path: string, hookCmd: string, guardCmd: string): number {
  // Invalid JSON or invalid UTF-8 (a ValueError family) started Python from
  // the fresh document, and so did a parsed non-object root (isinstance gate).
  // The only crash is the setdefault chain on a non-object hooks VALUE.
  let data: JsonMap = new Map<string, JsonValue>([["version", 1n], ["hooks", new Map<string, JsonValue>()]]);
  if (existsSync(path)) {
    let loaded: JsonValue;
    try {
      loaded = loads(readStrict(path));
    } catch (error) {
      if ((error as { code?: string }).code !== undefined) {
        warn(`install: WARNING: skipped Cursor hooks — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
        return 0;
      }
      loaded = null;
    }
    if (loaded !== null) {
      // Python: `if isinstance(loaded, dict): data = loaded` — a parsed
      // non-object root silently starts from the fresh document (the rc-1
      // crash is only the setdefault chain on a non-object hooks VALUE).
      if (isMap(loaded)) data = loaded;
    }
  }
  if (!data.has("version")) data.set("version", 1n);
  let hooks: JsonMap;
  const hooksRaw = data.get("hooks");
  if (hooksRaw === undefined) {
    hooks = new Map();
    data.set("hooks", hooks);
  } else if (isMap(hooksRaw)) {
    hooks = hooksRaw;
  } else {
    throw new SyntaxError(`${path}: cursor hooks must be a JSON object`);
  }
  let ss: JsonValue[];
  const ssRaw = hooks.get("sessionStart");
  if (ssRaw === undefined || !Array.isArray(ssRaw)) {
    ss = [];
    hooks.set("sessionStart", ss);
  } else {
    ss = ssRaw;
  }
  const cmd = `bash ${hookCmd}`;
  let found = false;
  for (const entry of ss) {
    if (!isMap(entry)) continue;
    if (String(typeof entry.get("command") === "string" ? entry.get("command") : "").includes("tap-cursor-session-start")) {
      entry.set("command", cmd);
      found = true;
      break;
    }
  }
  if (!found) ss.push(new Map<string, JsonValue>([["command", cmd]]));

  let beforeShell: JsonValue[];
  const bsRaw = hooks.get("beforeShellExecution");
  if (bsRaw === undefined || !Array.isArray(bsRaw)) {
    beforeShell = [];
    hooks.set("beforeShellExecution", beforeShell);
  } else {
    beforeShell = bsRaw;
  }
  const guardEntry: JsonMap = new Map<string, JsonValue>([["command", guardCmd]]);
  let guardSeen = false;
  const keptRows: JsonValue[] = [];
  for (const entry of beforeShell) {
    const command = isMap(entry) ? String(typeof entry.get("command") === "string" ? entry.get("command") : "") : "";
    if (command.includes("tap-shell-body-guard.py") || command.includes("tap-shell-body-guard.ts")) {
      if (guardSeen) continue;
      keptRows.push(guardEntry);
      guardSeen = true;
      continue;
    }
    keptRows.push(entry);
  }
  if (!guardSeen) keptRows.push(guardEntry);
  hooks.set("beforeShellExecution", keptRows);
  try {
    atomicReplace(dirname(path) || ".", `${basename(path)}.tap-tmp.`, jsonDump(data), path);
  } catch (error) {
    warn(`install: WARNING: skipped Cursor hooks — could not write ${path}: ${errText(error)}; next: make ${dirname(path)} writable and rerun ./install.sh`);
    return 0;
  }
  process.stdout.write(`install: wired Cursor sessionStart and tmux guard hooks into ${path}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// gemini — Antigravity config/hooks.json tmux guard (heredoc 5)
// ---------------------------------------------------------------------------

export function geminiGuard(path: string, guardCmd: string): number {
  let data: JsonMap;
  if (existsSync(path)) {
    try {
      const parsed = loads(readStrict(path));
      if (!isMap(parsed)) {
        warn(`install: WARNING: cannot wire Antigravity tmux guard into non-object ${path}`);
        return 0;
      }
      data = parsed;
    } catch (error) {
      if ((error as { code?: string }).code !== undefined) {
        warn(`install: WARNING: skipped Antigravity tmux guard — could not read ${path}: ${errText(error)}; next: make ${path} readable and rerun ./install.sh`);
        return 0;
      }
      warn(`install: WARNING: cannot wire Antigravity tmux guard into invalid ${path}: ${errText(error)}`);
      return 0;
    }
  } else {
    data = new Map();
  }
  // Python compared dict == managed: order-insensitive, numeric ==.
  const managed: JsonMap = new Map<string, JsonValue>([["PreToolUse", [
    new Map<string, JsonValue>([["matcher", "run_command"], ["hooks", [
      new Map<string, JsonValue>([["type", "command"], ["command", guardCmd], ["timeout", 5n]]),
    ]]]),
  ]]]);
  const existing = data.get("tap-tmux-kill-server");
  if (existing !== undefined && deepEq(existing, managed)) {
    process.stdout.write(`install: Antigravity tmux guard already wired in ${path}\n`);
    return 0;
  }
  data.set("tap-tmux-kill-server", managed);
  try {
    const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
    atomicReplace(dirname(target) || ".", `${basename(target)}.tap-tmp.`, jsonDump(data), target);
  } catch (error) {
    warn(`install: WARNING: skipped Antigravity tmux guard — could not write ${path}: ${errText(error)}; next: make ${dirname(path)} writable and rerun ./install.sh`);
    return 0;
  }
  process.stdout.write(`install: wired Antigravity tmux guard into ${path}\n`);
  return 0;
}

/** A separate owned namespace lets uninstall preserve the unrelated guard. */
export function agyIdentityHook(path: string, hookCmd: string): number {
  try {
    const parsed = existsSync(path) ? loads(readStrict(path)) : new Map<string, JsonValue>();
    if (!isMap(parsed)) throw new SyntaxError("hooks must be a JSON object");
    const managed = loads(JSON.stringify(agyIdentityHookSpec(hookCmd)));
    const existing = parsed.get("tap-session-identity");
    if (existing !== undefined && deepEq(existing, managed)) return 0;
    parsed.set("tap-session-identity", managed);
    // A user's shared hooks file may be symlinked into their configuration repo.
    const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
    atomicReplace(dirname(target), `${basename(target)}.tap-tmp.`, jsonDump(parsed), target);
    process.stdout.write(`install: wired Antigravity native identity hook into ${path}\n`);
  } catch (error) {
    warn(`install: WARNING: skipped Antigravity identity hook — ${path}: ${errText(error)}; next: repair the hooks file and rerun ./install.sh`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// claude-permission — settings.json PermissionRequest observer
// ---------------------------------------------------------------------------

const PERMISSION_ADAPTER = "/hooks/tap-claude-permission.sh";
/**
 * Seconds Claude Code waits for the observer before it cancels it and carries
 * on with the prompt. Per-command `timeout` predates the event itself (Claude
 * Code 1.0.41), so every Claude that knows the event knows the key.
 */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 10n;

/**
 * `wire` leaves exactly one PermissionRequest entry running hookCmd under the
 * time bound above; `unwire` removes TAP's entry and nothing else. install.sh chooses by Claude Code's
 * version on every run: a Claude older than the event stops each start on a
 * settings warning for a hook event it does not know, so the entry must not
 * outlive a downgrade. An entry left by a checkout at another path is TAP's too.
 */
export function claudePermissionHook(path: string, hookCmd: string, mode: string): number {
  if (mode !== "wire" && mode !== "unwire") {
    process.stderr.write("usage: install-hooks.ts claude-permission <settings.json> <hook> wire|unwire\n");
    return 2;
  }
  try {
    if (!existsSync(path) && mode === "unwire") return 0;
    const parsed = existsSync(path) ? loads(readStrict(path)) : new Map<string, JsonValue>();
    if (!isMap(parsed)) throw new SyntaxError("claude settings must be a JSON object");
    let hooks = parsed.get("hooks");
    if (hooks === undefined) {
      if (mode === "unwire") return 0;
      hooks = new Map<string, JsonValue>();
      parsed.set("hooks", hooks);
    }
    if (!isMap(hooks)) throw new SyntaxError("claude settings hooks must be a JSON object");
    const rows = hooks.get("PermissionRequest") ?? [];
    if (!Array.isArray(rows)) throw new SyntaxError("claude settings PermissionRequest must be a JSON array");
    const commandOf = (leaf: JsonValue): string => isMap(leaf) && typeof leaf.get("command") === "string" ? leaf.get("command") as string : "";
    const managed: JsonMap = new Map<string, JsonValue>([["type", "command"], ["command", hookCmd], ["timeout", PERMISSION_HOOK_TIMEOUT_SECONDS]]);
    let wired = false, changed = false;
    const kept: JsonValue[] = [];
    for (const row of rows) {
      const leaves = isMap(row) ? row.get("hooks") : undefined;
      if (!isMap(row) || !Array.isArray(leaves)) { kept.push(row); continue; }
      const keptLeaves = leaves.filter((leaf) => {
        const command = commandOf(leaf);
        if (command !== hookCmd && !command.endsWith(PERMISSION_ADAPTER)) return true;
        // An entry at this path in any other shape (an earlier TAP's, without the bound) is replaced.
        if (mode === "wire" && !wired && deepEq(leaf, managed)) { wired = true; return true; }
        changed = true;
        return false;
      });
      if (keptLeaves.length !== leaves.length) row.set("hooks", keptLeaves);
      // A row TAP emptied goes with its entry; a row that was already empty is the user's.
      if (keptLeaves.length > 0 || leaves.length === 0) kept.push(row);
    }
    if (mode === "wire" && !wired) {
      kept.push(new Map<string, JsonValue>([["hooks", [managed]]]));
      changed = true;
    }
    if (!changed) return 0;
    if (kept.length > 0) hooks.set("PermissionRequest", kept); else hooks.delete("PermissionRequest");
    // A user's settings file may be symlinked into their configuration repo.
    const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
    atomicReplace(dirname(target) || ".", `${basename(target)}.tap-tmp.`, jsonDump(parsed), target);
    process.stdout.write(mode === "wire"
      ? `install: wired PermissionRequest observer into ${path}\n`
      : `install: removed PermissionRequest observer from ${path}\n`);
  } catch (error) {
    warn(`install: WARNING: skipped Claude PermissionRequest observer — ${path}: ${errText(error)}; next: repair the settings file and rerun ./install.sh`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function cli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const need = (n: number): void => {
    if (rest.length < n) { process.stderr.write("usage: install-hooks.ts claude|claude-permission|agents|codex-config|codex-legacy|cursor|gemini|agy-identity <paths…>\n"); process.exit(2); }
  };
  switch (sub) {
    case "claude": need(3); return claudeHooks(rest[0]!, rest[1]!, rest[2]!);
    case "claude-permission": need(3); return claudePermissionHook(rest[0]!, rest[1]!, rest[2]!);
    case "agents": need(1); return agentsSection(rest[0]!);
    case "codex-config": need(3); return codexConfig(rest[0]!, rest[1]!, rest[2]!);
    case "codex-legacy": need(1); return codexLegacy(rest[0]!);
    case "cursor": need(3); return cursorHooks(rest[0]!, rest[1]!, rest[2]!);
    case "gemini": need(2); return geminiGuard(rest[0]!, rest[1]!);
    case "agy-identity": need(2); return agyIdentityHook(rest[0]!, rest[1]!);
    default:
      process.stderr.write(`usage: install-hooks.ts claude|claude-permission|agents|codex-config|codex-legacy|cursor|gemini|agy-identity <paths…>\n`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(cli(process.argv.slice(2)));
  } catch (error) {
    warn(`install-hooks: ${errText(error)}`);
    process.exit(1);
  }
}
