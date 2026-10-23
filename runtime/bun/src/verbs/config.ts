/** Machine-config verb: `tap config get|set|path` over the same TOML the
 * launcher catalog and the sentinel renderer already read. The verb writes one
 * config file and touches no bus, registry, or repo state.
 *
 * set is a round-trip-safe TEXT edit of only the target table: comments, key
 * order, and unrelated tables survive byte-for-byte. A serializing rewrite
 * cannot do that, so the edit is line-based and every edit must re-parse to
 * the new value before anything is written. */
import { closeSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { atomicWrite } from "../fsatomic";
import { acquireNoFollowLock, DELIVERY_NOW_WINDOW_DEFAULT, DELIVERY_POLITE_WINDOW_DEFAULT } from "../digest-window";

const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Root segments whose readers are known, with when a new value reaches them.
 * Every table in the launcher catalog's TOP_LEVEL_KEYS needs an entry; the
 * census test in config.test.ts fails when the two lists drift. */
export const EFFECTS: Record<string, string> = {
  experimental: "takes effect on the next fresh launch; existing seats keep their recorded mode",
  calibration: "takes effect on the next tap calibrate",
  sentinel: "takes effect on the next delivery",
  notifications: "takes effect on the next escalation",
  injection: "takes effect on the next delivery",
  tmux: "takes effect on the next session launch or resume",

  diagnostics: "takes effect on the next lifecycle command",
  presets: "takes effect on the next launch",
  harness: "takes effect on the next launch",
  roles: "takes effect on the next launch",
  intelligences: "takes effect on the next launch",
  version: "takes effect on the next launch",
  // [notes] feeds preset `family` metadata in the catalog parse, like [presets].
  notes: "takes effect on the next launch",
  // delivery window defaults and per-seat overrides: read by send and spool-park per delivery, and shown by the roster (tap team).
  delivery: "takes effect on the next delivery or roster read",
  // aggressiveness: read per nudge, detective, recovery run, and by the Antigravity survey handling on each delivery.
  recovery: "takes effect on the next nudge, detective, recovery run, or Antigravity delivery",
  // onboarding.init: read when a command meets a project that has not run tap init.
  onboarding: "takes effect on the next command in a project not yet initialized",
  // skills.full_kit: read by the skill-link installer and by setup (as its prompt default), not by a running seat.
  skills: "takes effect on the next install, sync, or interactive setup",
};

/** Keys whose reader applies one fixed value when the key is absent, so `get`
 * can answer for a fresh config. A key with no single default stays out and
 * get refuses it when unset: recovery.aggressiveness is chosen per verb, and
 * skills.full_kit unset means "keep what is installed", which differs from false. */
export const DEFAULTS: Record<string, string | number | boolean> = {
  "experimental.opencode_shared_server": false,
  "calibration.enabled": false,
  "sentinel.preview": false,
  "sentinel.preview_chars": 120,
  "injection.behavior": "clobber",
  "delivery.now_window_seconds": DELIVERY_NOW_WINDOW_DEFAULT,
  "delivery.polite_window_seconds": DELIVERY_POLITE_WINDOW_DEFAULT,
  "onboarding.init": "ask",
};

const USAGE = [
  "tap config get <dotted.key> [--json]",
  "  Print one machine-config value as a TOML scalar (true, 3, \"text\"). A known key",
  "  unset in the file prints its default marked '(default)'; --json adds source.",
  "tap config set <dotted.key> <value>",
  "  Round-trip-safe edit of the target table only; comments and unrelated tables survive.",
  "  Values parse as TOML scalars: true/false, integer, or string.",
  "  notifications.command takes a TOML string array of literal argv tokens.",
  "tap config path",
  "  Print the resolved config file.",
].join("\n");

const usage = () => process.stderr.write(`${USAGE}\n`);

function parseDoc(text: string): Record<string, unknown> | undefined {
  try { return Bun.TOML.parse(text) as Record<string, unknown>; }
  catch { return undefined; }
}

/** Read the config strictly as UTF-8: a silent U+FFFD replacement would let a
 * set rewrite mangled bytes into comments Bun happens to accept, so invalid
 * encoding is a hard refusal instead (null). The round-trip byte comparison
 * backstops decoders that accept more than they should. */
function readConfigText(file: string): string | null {
  try {
    const bytes = readFileSync(file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.compare(Buffer.from(text, "utf8"), bytes) === 0 ? text : null;
  } catch { return null; }
}

/** The value of a one-line `v = <literal>` document — one scalar semantics source. */
function scalarValue(literal: string): unknown {
  return (Bun.TOML.parse(`v = ${literal}\n`) as Record<string, unknown>).v;
}

/** TOML literal for a CLI value: booleans and canonical integers pass
 * through, anything else is written as a quoted string (JSON string escaping
 * is TOML-compatible). Leading zeros are NOT integers here: Bun accepts `03`
 * as an integer while Python 3.11 tomllib — the launcher's parser — rejects
 * it, so the pass-through is restricted to forms both parsers accept. */
function scalarLiteral(text: string): string {
  if (text === "true" || text === "false") return text;
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(text)) return text;
  return JSON.stringify(text);
}

function renderValue(value: unknown): string | null {
  if (Array.isArray(value) && value.every(arg => typeof arg === "string")) return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return null;
}

function walk(doc: unknown, segments: string[]): unknown {
  let node: unknown = doc;
  for (const segment of segments) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Split ` = <value>` text into its literal and trailing comment, honoring quotes.
 * A bare value cannot contain an unquoted `#` (a hash starts a comment there
 * with or without preceding whitespace), while a `#` inside quotes belongs to
 * the value; the tail starts at the first whitespace of the run that precedes
 * the comment, so replacing the value keeps the original spacing and an
 * adjacent comment byte-for-byte. */
function splitValueTail(rest: string): { value: string; tail: string } {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < rest.length; i++) {
      if (quote === '"' && rest[i] === "\\") { i++; continue; }
      if (rest[i] === quote) return { value: rest.slice(0, i + 1), tail: rest.slice(i + 1) };
    }
    return { value: rest, tail: "" };
  }
  let hash = -1;
  let inner: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]!;
    if (inner) {
      if (char === "\\") { i++; continue; }
      if (char === inner) inner = null;
      continue;
    }
    if (char === '"' || char === "'") { inner = char; continue; }
    if (char === "#") { hash = i; break; }
  }
  if (hash >= 0) {
    while (hash > 0 && /\s/.test(rest[hash - 1]!)) hash--;
    return { value: rest.slice(0, hash), tail: rest.slice(hash) };
  }
  return { value: rest, tail: "" };
}

/** Code-only view of one line: comments and multiline-string bodies removed,
 * so header and key detection cannot fire on text that merely looks like
 * syntax inside a value (a triple-quoted description containing `[sentinel]`
 * and `preview = false` is the recorded specimen). `state.quote` carries the
 * open multiline quote character across lines. Single-line string bodies stay
 * in the ranges — they can never start a line, so they cannot look like a
 * header or key. The lexer only LOCATES the target line; the write is gated
 * by a document-level diff, so a lexer miss refuses rather than corrupts. */
function appendCodeRanges(line: string, state: { quote: string | null }, out: string): string {
  let start = 0;
  let i = 0;
  while (i < line.length) {
    if (state.quote) {
      const close = nextMultilineClose(line, i, state.quote);
      if (close < 0) return out;
      i = close + 3;
      state.quote = null;
      start = i;
      continue;
    }
    const char = line[i]!;
    if (char === "#") return out + line.slice(start, i);
    if (char === '"' || char === "'") {
      if (line.startsWith(char.repeat(3), i)) {
        out += line.slice(start, i);
        state.quote = char;
        i += 3;
        continue;
      }
      let j = i + 1;
      while (j < line.length) {
        if (char === '"' && line[j] === "\\") { j += 2; continue; }
        if (line[j] === char) break;
        j++;
      }
      i = Math.min(j + 1, line.length);
      continue;
    }
    i++;
  }
  return out + line.slice(start, line.length);
}

/** Next closing delimiter of an open multiline string. In a BASIC string an
 * odd run of backslashes before `"""` escapes the first quote, so `\"""` does
 * not close (reviewer specimen); literal `'''` strings have no escapes. */
function nextMultilineClose(line: string, from: number, quote: string): number {
  const delimiter = quote.repeat(3);
  let close = line.indexOf(delimiter, from);
  if (quote !== '"') return close;
  while (close > 0) {
    let backslashes = 0;
    for (let k = close - 1; line[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 0) break;
    close = line.indexOf(delimiter, close + 1);
  }
  return close;
}

/** Per-line code view of a whole document, sharing one multiline-string state. */
function codeLines(lines: string[]): string[] {
  const state = { quote: null as string | null };
  return lines.map(line => appendCodeRanges(line, state, ""));
}

/** Unquote one path segment for comparison: bare passes through, quoted strips
 * the quotes. `tap setup --machine` serializes every segment quoted
 * (`["sentinel"]`, `"preview" = false`), so both spellings must match. */
function normalizeSegment(raw: string): string | null {
  const text = raw.trim();
  if (KEY_SEGMENT.test(text)) return text;
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === `"`) {
    if (/[\x00-\x1f]/.test(text)) return null;
    return text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") return text.slice(1, -1);
  return null;
}

/** Split a dotted path on dots OUTSIDE quotes; null when any segment is unusable. */
function parsePath(text: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      current += char;
      if (char === "\\" && i + 1 < text.length) { current += text[++i]!; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ".") { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  const normalized = parts.map(normalizeSegment);
  return normalized.every(part => part !== null && part !== "") ? normalized as string[] : null;
}

/** Header path of a code line, or null (headers only; array-of-tables excluded). */
function headerPath(codeLine: string): string[] | null {
  const text = codeLine.trim();
  if (!text.startsWith("[") || !text.endsWith("]") || text.startsWith("[[")) return null;
  return parsePath(text.slice(1, -1));
}

/** Key path of a code line plus nothing else; null when the line is not a
 * plain `key = value` line. The first `=` outside quoted key segments divides. */
function keyPath(codeLine: string): string[] | null {
  let quote: string | null = null;
  for (let i = 0; i < codeLine.length; i++) {
    const char = codeLine[i]!;
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "=") return parsePath(codeLine.slice(0, i));
  }
  return null;
}

const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/** Line index range of one table's body: after its header, until the next
 * header of any kind. */
function tableBody(code: string[], headerStart: number): [number, number] {
  let end = code.length;
  for (let i = headerStart + 1; i < code.length; i++) {
    if (headerPath(code[i]!) !== null) { end = i; break; }
  }
  return [headerStart + 1, end];
}

function firstHeader(code: string[]): number {
  for (let i = 0; i < code.length; i++) {
    if (headerPath(code[i]!) !== null) return i;
  }
  return -1;
}

function lastHeader(code: string[]): number {
  for (let i = code.length - 1; i >= 0; i--) {
    if (headerPath(code[i]!) !== null) return i;
  }
  return -1;
}

/** Replace the value of one key line in place: the key keeps its exact
 * spelling (quoted or bare), and indent, `=` spacing, and trailing comment
 * survive byte-for-byte. */
function replaceLineValue(line: string, literal: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "=") {
      const after = line.slice(i + 1);
      const leading = after.match(/^\s*/)!;
      const { tail } = splitValueTail(after.slice(leading[0].length));
      return `${line.slice(0, i + 1)}${leading[0]}${literal}${tail}`;
    }
  }
  return null;
}

/** Insertion spelling that mirrors the quoting the file already uses. */
function keyLineFor(segments: readonly string[], literal: string, quoted: boolean): string {
  const spelling = segments.map(part => quoted || !/^[A-Za-z0-9_-]+$/.test(part) ? JSON.stringify(part) : part).join(".");
  return `${spelling} = ${literal}`;
}

const headerIsQuoted = (codeLine: string) => /^\s*\[\s*["']/.test(codeLine);

/** Key spelling for an insertion into [start, end): mirror the table's own key
 * lines, else its header's quoting. */
function insertionQuoted(code: string[], start: number, end: number, headerStart: number): boolean {
  for (let i = start; i < end; i++) {
    if (keyPath(code[i]!) !== null) return /^[\"']/.test(code[i]!.trimStart());
  }
  return headerStart >= 0 && headerIsQuoted(code[headerStart]!);
}

function appendLine(text: string, line: string): string {
  return text ? `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n` : `${line}\n`;
}

/** Text edit that changes one dotted key and nothing else. Longest-prefix
 * first: an exact `[a.b]` header with key `c`, then `[a]` with dotted `b.c`,
 * then the top-level region (bare and dotted keys before the first header).
 * Quoted segments match their bare equivalents and keep their spelling; an
 * absent key is inserted after the longest existing header prefix in the
 * table's own quoting; a bare top-level key goes before the first header; a
 * table no prefix shares is appended at the end. Every result must re-parse
 * to the new value before the caller writes it. */
export function editTomlKey(text: string, segments: string[], literal: string): string {
  const lines = text.split("\n");
  const code = codeLines(lines);
  for (let k = segments.length - 1; k >= 1; k--) {
    const prefix = segments.slice(0, k);
    let headerStart = -1;
    for (let i = 0; i < code.length; i++) {
      if (samePath(headerPath(code[i]!) ?? [], prefix)) { headerStart = i; break; }
    }
    if (headerStart < 0) continue;
    const rest = segments.slice(k);
    const [bodyStart, bodyEnd] = tableBody(code, headerStart);
    for (let i = bodyStart; i < bodyEnd; i++) {
      if (samePath(keyPath(code[i]!) ?? [], rest)) {
        const replaced = replaceLineValue(lines[i]!, literal);
        if (replaced !== null) { lines[i] = replaced; return lines.join("\n"); }
      }
    }
    lines.splice(headerStart + 1, 0, keyLineFor(rest, literal, insertionQuoted(code, bodyStart, bodyEnd, headerStart)));
    return lines.join("\n");
  }
  const header = firstHeader(code);
  const limit = header < 0 ? code.length : header;
  for (let i = 0; i < limit; i++) {
    if (samePath(keyPath(code[i]!) ?? [], segments)) {
      const replaced = replaceLineValue(lines[i]!, literal);
      if (replaced !== null) { lines[i] = replaced; return lines.join("\n"); }
    }
  }
  // Insertions mirror the quoting the file already emits, so a setup-written
  // config stays setup-shaped after an edit.
  const topQuoted = insertionQuoted(code, 0, limit, header);
  if (segments.length === 1) {
    const line = keyLineFor(segments, literal, topQuoted);
    if (header < 0) return appendLine(text, line);
    lines.splice(header, 0, line);
    return lines.join("\n");
  }
  const last = lastHeader(code);
  const quoted = last >= 0 ? headerIsQuoted(code[last]!) : topQuoted;
  const table = `[${segments.slice(0, -1).map(part => quoted || !/^[A-Za-z0-9_-]+$/.test(part) ? JSON.stringify(part) : part).join(".")}]`;
  let out = text ? (text.endsWith("\n") ? text : `${text}\n`) : "";
  if (out && !out.endsWith("\n\n")) out += "\n";
  return `${out}${table}\n${keyLineFor([segments[segments.length - 1]!], literal, quoted)}\n`;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : "");
  if (!base || !isAbsolute(base)) {
    throw new Error("an absolute XDG_CONFIG_HOME or HOME is required to resolve the machine config");
  }
  return join(base, "tap", "config.toml");
}

function effectLine(key: string): string {
  const effect = EFFECTS[key.split(".")[0]!];
  return effect ?? `no recorded reader for '${key}'; effect unknown`;
}

/** Leaf key paths whose parsed value differs between two documents (key order
 * is not a difference). The write gate: a legit edit touches only the target
 * path, or the single ancestor branch that was created for it. */
export function collectDifferences(a: unknown, b: unknown, path: string[], out: string[]): void {
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date && b instanceof Date && a.getTime() === b.getTime())) out.push(path.join("."));
    return;
  }
  if (a === b) return;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    out.push(path.join("."));
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(path.join("."));
      return;
    }
    for (let i = 0; i < a.length; i++) collectDifferences(a[i], b[i], [...path, String(i)], out);
    return;
  }
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
  for (const key of keys) {
    collectDifferences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], [...path, key], out);
  }
}

export function cmdConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [sub = "", ...restArgs] = argv;
  let rest = restArgs;
  if (sub === "-h" || sub === "--help" || sub === "help") { usage(); return 0; }
  if (["path", "get", "set"].includes(sub) && rest.length === 1 && ["-h", "--help"].includes(rest[0]!)) {
    usage();
    return 0;
  }

  let path: string;
  try { path = resolveConfigPath(env); }
  catch (error) {
    process.stderr.write(`tap config: ${(error as Error).message}\n`);
    return 1;
  }

  if (sub === "path") {
    if (rest.length) { process.stderr.write(`tap config path: unexpected argument '${rest[0]}'\n`); usage(); return 1; }
    process.stdout.write(`${path}\n`);
    return 0;
  }

  if (sub === "get" || sub === "set") {
    const json = sub === "get" && rest.includes("--json");
    if (json) rest = rest.filter(arg => arg !== "--json");
    const key = rest[0] ?? "";
    const segments = key.split(".").filter(segment => segment !== "");
    if (!key || rest.length !== (sub === "get" ? 1 : 2) || segments.length !== key.split(".").length ||
        segments.some(segment => !KEY_SEGMENT.test(segment))) {
      process.stderr.write(`tap config ${sub}: expected ${sub === "get" ? "<dotted.key>" : "<dotted.key> <value>"}\n`);
      usage();
      return 1;
    }

    if (sub === "get") {
      const known = Object.hasOwn(DEFAULTS, key) ? DEFAULTS[key] : undefined;
      // A known key unset in the file answers with the default its reader applies.
      const answer = (value: unknown, source: "default" | "file"): number => {
        const rendered = renderValue(value)!;
        process.stdout.write(json ? `${JSON.stringify({ key, value, source })}\n`
          : `${rendered}${source === "default" ? " (default)" : ""}\n`);
        return 0;
      };
      // Only a genuinely absent entry means "fresh config". Permission errors,
      // link loops, and dangling links hide a config that may set the key, so
      // they refuse rather than answer a default.
      let absent = false;
      try { lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(`tap config: cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}; next: fix the path, then get ${key}\n`);
          return 1;
        }
        absent = true;
      }
      if (!absent) {
        try { statSync(path); }
        catch (error) {
          process.stderr.write(`tap config: cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}; next: fix the path or link, then get ${key}\n`);
          return 1;
        }
      }
      if (absent) {
        if (known !== undefined) return answer(known, "default");
        process.stderr.write(`tap config: no machine config at ${path}; next: tap config set <key> <value>\n`);
        return 1;
      }
      // Fence before opening: a FIFO or other non-regular config must refuse
      // actionably rather than block the read.
      if (!statSync(path).isFile()) {
        process.stderr.write(`tap config: ${path} is not a regular file\n`);
        return 1;
      }
      const text = readConfigText(path);
      if (text === null) {
        process.stderr.write(`tap config: ${path} is not valid UTF-8; next: fix the encoding, then get ${key}\n`);
        return 1;
      }
      const doc = parseDoc(text);
      if (!doc) {
        process.stderr.write(`tap config: ${path} fails to parse; next: fix or replace the file, then get ${key}\n`);
        return 1;
      }
      const value = walk(doc, segments);
      if (value === undefined) {
        if (known !== undefined) return answer(known, "default");
        process.stderr.write(`tap config: '${key}' is not set in ${path}\n`);
        return 1;
      }
      if (renderValue(value) === null) {
        process.stderr.write(`tap config: '${key}' is not a scalar this verb reads (true/false/int/string)\n`);
        return 1;
      }
      return answer(value, "file");
    }

    let literal = scalarLiteral(rest[1]!);
    if (key === "notifications.command") {
      try {
        const value = scalarValue(rest[1]!);
        if (!Array.isArray(value) || !value.length || value.some(arg => typeof arg !== "string") || !value[0]) throw new Error();
        literal = JSON.stringify(value);
      } catch {
        process.stderr.write("tap config: notifications.command requires a nonempty TOML string array with a nonempty executable; nothing written\n");
        return 1;
      }
    }
    const expected = scalarValue(literal);
    // Resolve the config path BEFORE reading it: a symlink to a FIFO or other
    // non-regular file must refuse actionably rather than block on open, and
    // the resolved regular path is what the write reuses (round-3 FAS).
    let readPath = path;
    let linked = false;
    try { linked = lstatSync(path).isSymbolicLink(); } catch { /* absent: plain create below */ }
    if (linked) {
      try { readPath = realpathSync(path); }
      catch {
        process.stderr.write(`tap config: ${path} is a broken symlink; next: point it at a real file or remove it\n`);
        return 1;
      }
    }
    if (existsSync(readPath) && !statSync(readPath).isFile()) {
      process.stderr.write(`tap config: ${readPath} is not a regular file; refusing to write through ${path}\n`);
      return 1;
    }
    // The whole read-modify-write runs under the config lock: overlapping
    // sets and digest-window updates serialize on the same descriptor lock.
    let lockFd: number;
    try {
      mkdirSync(dirname(readPath), { recursive: true });
      lockFd = acquireNoFollowLock(`${readPath}.lock`, 2500);
    } catch (error) {
      process.stderr.write(`tap config: ${(error as Error).message}\n`);
      return 1;
    }
    try {
      let text: string | null = null;
      if (existsSync(readPath)) {
        text = readConfigText(readPath);
        if (text === null) {
          process.stderr.write(`tap config: ${readPath} is not valid UTF-8; refusing to edit it\n`);
          return 1;
        }
      }
      const source = text ?? "";
      const original = source ? parseDoc(source) : {};
      if (source && !original) {
        process.stderr.write(`tap config: ${path} fails to parse; refusing to edit it\n`);
        return 1;
      }
      const edited = editTomlKey(source, segments, literal);

      // The write is self-checking (ruling of 2026-09-10): the lexer
      // only LOCATES the target line. The candidate must parse, must set the
      // target to the requested value, and must differ from the original
      // document at the target path alone (or the one ancestor branch created
      // for it). Anything else — including a lexer that mislocated the edit —
      // refuses with the first differing path and writes nothing.
      const candidate = parseDoc(edited);
      const target = key;
      const allowed = (diff: string) => diff === target || target.startsWith(`${diff}.`) || diff.startsWith(`${target}.`);
      const differences: string[] = [];
      if (candidate && original) collectDifferences(original, candidate, [], differences);
      const offender = differences.find(diff => !allowed(diff));
      if (!candidate) {
        process.stderr.write(`tap config: the edit for '${key}' would not re-parse to ${literal}; nothing written\n`);
        return 1;
      }
      if (offender !== undefined) {
        process.stderr.write(`tap config: the edit for '${key}' would also change '${offender}'; nothing written\n`);
        return 1;
      }
      if (JSON.stringify(walk(candidate, segments)) !== JSON.stringify(expected)) {
        process.stderr.write(`tap config: the edit for '${key}' would not re-parse to ${literal}; nothing written\n`);
        return 1;
      }
      if (edited !== source) {
        const mode = existsSync(readPath) ? statSync(readPath).mode & 0o777 : undefined;
        atomicWrite(readPath, edited, mode);
      }
      const old = source ? walk(original!, segments) : undefined;
      const oldRendered = old === undefined ? "(unset)" : renderValue(old) ?? "(table)";
      process.stdout.write(`tap config: ${key}: ${oldRendered} -> ${literal}\n`);
      process.stdout.write(`tap config: ${effectLine(key)}\n`);
      return 0;
    } finally {
      closeSync(lockFd);
    }
  }

  process.stderr.write(`tap config: unknown subcommand '${sub}'\n`);
  usage();
  return 1;
}

if (import.meta.main) process.exitCode = cmdConfig(process.argv.slice(2));
