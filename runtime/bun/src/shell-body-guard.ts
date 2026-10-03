// S1 Bun port of hooks/tap-shell-body-guard.py: best-effort block for unsafe
// inline tap/bd bodies and unscoped tmux teardown, on every harness's Bash
// PreToolUse. Behavior contract: runtime/bun/test/goldens/shell-body-guard/
// corpus.jsonl (270 arms frozen from the Python hook's stdout bytes and exit
// status, Python 3.14.6, LC_ALL=C).
//
// Launch invariant (S1 termios gate, 2026-09-25): a Bun process restores the
// startup termios snapshot of any tty std fd at exit. That is a no-op when
// the terminal is already raw (every realistic PreToolUse window) and Bun
// 1.4.0 skips the restore whenever stdout is a pipe — which every wired
// harness guarantees, because the decision JSON must be read from stdout.
// Hook stdout must therefore remain a pipe; a stdout-tty shape resets cooked
// mode after a mid-life raw transition and is unsupported (it could not read
// the decision JSON anyway). stderr stays live for crash diagnostics.
//
// This is not a shell fence: pipeline producers, the `!` and `time` pipeline
// prefixes, `coproc`, other wrappers, shell functions, and nested shell
// constructs may evade it. A quoted heredoc is the reliable protection.
import {
  ansiCWord as ansiCWordAt,
  commandSubstitutionAt,
  commandWords,
  resolveCommand,
  shellCommentAt,
  shellEscaped,
  shellSegments,
  shellTokens,
  type ShellToken,
  wordBeforeRedirection,
} from "./lint-body";

// The hook's flag sets are the PYTHON hook's contract (frozen corpus): the
// lint verb's BD superset (--design/--acceptance, tap-rij69) is deliberately
// NOT ported here; widening hook denials is a follow-up, not a port.
export const HOOK_TAP_BODY_FLAGS: ReadonlySet<string> = new Set(["-m", "--message", "--preview"]);
export const HOOK_BD_BODY_FLAGS: ReadonlySet<string> = new Set([
  "-d",
  "--description",
  "--notes",
  "--append-notes",
  "--body",
]);

function isTapPath(value: string): boolean {
  return value === "tap" || value.endsWith("/tap") || value.endsWith("/tap.sh");
}

function isBdPath(value: string): boolean {
  return value === "bd" || value.endsWith("/bd");
}

export type ToolHit = { tokenIndex: number; tapFlags: boolean };

/** Python tool_and_flags: the tool's token index and which flag set applies. */
export function toolAndFlags(tokens: ShellToken[]): ToolHit | null {
  const command = resolveCommand(tokens);
  if (!command) return null;
  const value = command.value;
  if (isTapPath(value)) {
    const words = commandWords(tokens);
    const start = words.findIndex((w) => w.tokenIndex === command.tokenIndex);
    const verb = words[start + 1]?.value;
    if (verb === "send" || verb === "reply" || verb === "escalate" || verb === "assign") {
      return { tokenIndex: command.tokenIndex, tapFlags: true };
    }
    return null;
  }
  if (isBdPath(value)) {
    return { tokenIndex: command.tokenIndex, tapFlags: false };
  }
  return null;
}

type HeredocSpan = { start: number; end: number; quoted: boolean; isTapBd: boolean; body: string };

/** Python heredoc_word: one delimiter word with Bash quote removal, on raw source. */
function heredocWord(source: string, position: number): [number, string, boolean] | null {
  while (position < source.length) {
    if (source.startsWith("\\\n", position)) position += 2;
    else if (source[position] === " " || source[position] === "\t") position += 1;
    else break;
  }
  const start = position;
  const value: string[] = [];
  let quote: "'" | '"' | null = null;
  let quoted = false;
  while (position < source.length) {
    const char = source[position]!;
    if (quote === null && " \t\n|&;()<>".includes(char)) break;
    const literal = quote === null ? ansiCWordAt(source, position) : null;
    if (literal !== null) {
      position = literal[0];
      value.push(literal[1]);
      quoted = true;
      continue;
    }
    if (quote === null && source.startsWith('$"', position)) return null;
    if (char === "\\" && quote !== "'" && position + 1 < source.length) {
      const following = source[position + 1]!;
      if (following === "\n") {
        position += 2;
        continue;
      }
      if (quote === null || "$`\"\\".includes(following)) {
        value.push(following);
        quoted = true;
        position += 2;
        continue;
      }
    }
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      quoted = true;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else {
      value.push(char);
    }
    position += 1;
  }
  if (position === start || quote !== null) return null;
  return [position, value.join(""), quoted];
}

/** Python arithmetic_end: skip balanced parentheses; caller establishes context. */
function arithmeticEnd(source: string, position: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  while (position < source.length) {
    const char = source[position]!;
    if (char === "\\" && quote !== "'") {
      position += 2;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return position + 1;
    }
    position += 1;
  }
  return position;
}

/**
 * Python heredoc_bodies: every recognized heredoc body in shell order, with
 * the opener's segment tap/bd classification. Only LF ends a shell line.
 */
export function heredocBodies(source: string): HeredocSpan[] {
  const spans: HeredocSpan[] = [];
  let position = 0;
  let segmentStart = 0;
  let quote: "'" | '"' | null = null;
  let pending: Array<{ stripTabs: boolean; delimiter: string; quoted: boolean; isTapBd: boolean }> = [];
  let segmentOpeners: Array<{ stripTabs: boolean; delimiter: string; quoted: boolean }> = [];

  const flushBodies = (): void => {
    for (const opener of pending) {
      const start = position;
      const body: string[] = [];
      while (position < source.length) {
        let logical = "";
        for (;;) {
          const end = source.indexOf("\n", position);
          const stop = end === -1 ? source.length : end;
          const line = source.slice(position, stop);
          position = Math.min(stop + 1, source.length);
          const backslashRun = line.match(/\\+$/);
          const trailing = backslashRun ? backslashRun[0].length : 0;
          if (!opener.quoted && trailing % 2 === 1 && stop < source.length) {
            logical += line.slice(0, -1);
            continue;
          }
          logical += line;
          break;
        }
        const closing = opener.stripTabs ? logical.replace(/^\t+/, "") : logical;
        if (closing === opener.delimiter) break;
        body.push(logical);
      }
      spans.push({
        start,
        end: position,
        quoted: opener.quoted,
        isTapBd: opener.isTapBd,
        body: body.join("\n"),
      });
    }
    pending = [];
  };

  while (position < source.length) {
    const char = source[position]!;
    if (char === "\\" && quote !== "'") {
      position += 2;
      continue;
    }
    if (quote !== null) {
      if (quote === char) quote = null;
      position += 1;
      continue;
    }
    const literal = ansiCWordAt(source, position);
    if (literal !== null) {
      position = literal[0];
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      position += 1;
      continue;
    }
    if (char === "#" && shellCommentAt(source, position)) {
      const newline = source.indexOf("\n", position);
      position = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("$((", position)) {
      position = arithmeticEnd(source, position + 1);
      continue;
    }
    if (source.startsWith("((", position)) {
      position = arithmeticEnd(source, position);
      continue;
    }
    if (source.startsWith("<<", position) && !source.startsWith("<<<", position) &&
        (position === 0 || source[position - 1] !== "<")) {
      const wordStart = position + 2;
      const stripTabs = source.startsWith("-", wordStart);
      const parsed = heredocWord(source, wordStart + (stripTabs ? 1 : 0));
      if (parsed !== null) {
        position = parsed[0];
        segmentOpeners.push({ stripTabs, delimiter: parsed[1], quoted: parsed[2] });
        continue;
      }
    }
    const prev = position > 0 ? source[position - 1] : "";
    const next = position + 1 < source.length ? source[position + 1] : "";
    const redirectionPart =
      (char === "&" && ((prev === "<" || prev === ">") || next === ">")) ||
      (char === "|" && prev === ">");
    if (";|&\n".includes(char) && !redirectionPart) {
      const tool = toolAndFlags(shellTokens(source.slice(segmentStart, position)));
      pending.push(
        ...segmentOpeners.map((opener) => ({
          ...opener,
          isTapBd: tool !== null,
        })),
      );
      segmentOpeners = [];
      position += 1;
      segmentStart = position;
      if (char === "\n") {
        flushBodies();
        segmentStart = position;
      }
      continue;
    }
    position += 1;
  }
  return spans;
}

/** Python without_heredoc_bodies: strip bodies (all, or quoted only); drop one trailing LF. */
export function withoutHeredocBodies(command: string, quotedOnly: boolean): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of heredocBodies(command)) {
    if (span.quoted || !quotedOnly) {
      pieces.push(command.slice(cursor, span.start));
      cursor = span.end;
    }
  }
  pieces.push(command.slice(cursor));
  const joined = pieces.join("");
  return joined.endsWith("\n") ? joined.slice(0, -1) : joined;
}

/** Values of command words (redirections removed). */
function valuesAfter(tokens: ShellToken[], tokenIndex: number): string[] {
  return commandWords(tokens)
    .filter((w) => w.tokenIndex > tokenIndex)
    .map((w) => w.value);
}

// --- tmux ---

const TMUX_CLIENT_SHORT_OPTIONS = "2CDhlNuVvc:f:L:S:T:";
const TMUX_KILL_SERVER_PREFIX = "kill-ser";

function shortTakesArg(shortOptions: string, opt: string): boolean | null {
  for (let i = 0; i < shortOptions.length; ) {
    const name = shortOptions[i]!;
    const takes = shortOptions[i + 1] === ":";
    if (name === opt) return takes;
    i += takes ? 2 : 1;
  }
  return null;
}

/** Python getopt.getopt short+cluster parse for the tmux client options. */
function tmuxGetopt(argv: string[]): { options: string[]; remaining: string[] } | null {
  const options: string[] = [];
  const remaining = [...argv];
  while (remaining.length > 0) {
    const arg = remaining[0]!;
    if (arg === "--") {
      remaining.shift();
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    if (arg.startsWith("--")) return null; // tmux has no long options
    let cluster = arg.slice(1);
    remaining.shift();
    while (cluster.length > 0) {
      const opt = cluster[0]!;
      const takes = shortTakesArg(TMUX_CLIENT_SHORT_OPTIONS, opt);
      if (takes === null) return null;
      cluster = cluster.slice(1);
      if (takes) {
        options.push(`-${opt}`);
        if (cluster.length > 0) {
          cluster = "";
        } else {
          if (remaining.length === 0) return null;
          remaining.shift();
        }
      } else {
        options.push(`-${opt}`);
      }
    }
  }
  return { options, remaining };
}

function isTmux(value: string): boolean {
  return value === "tmux" || value.endsWith("/tmux");
}

/** Whether a direct tmux kill-server lacks a preceding -L/-S socket pin. */
export function tmuxKillServerIsUnsafe(command: string): boolean {
  const stripped = withoutHeredocBodies(command, false);
  for (const segment of shellSegments(stripped)) {
    const tokens = shellTokens(segment);
    const command0 = resolveCommand(tokens);
    if (!command0) continue;
    const executable = command0.value;
    if (!isTmux(executable)) continue;
    const argv = valuesAfter(tokens, command0.tokenIndex);
    const parsed = tmuxGetopt(argv);
    if (parsed === null) {
      // The exact direct form stays protected when a new client option is
      // added, but ambiguous free text remains outside this best-effort parser.
      if (argv.includes("kill-server")) return true;
      continue;
    }
    if (parsed.remaining.length === 0) continue;
    const verb = parsed.remaining[0]!;
    if (!verb.startsWith(TMUX_KILL_SERVER_PREFIX) || !"kill-server".startsWith(verb)) continue;
    if (parsed.options.includes("-L") || parsed.options.includes("-S")) continue;
    return true;
  }
  return false;
}

// --- inline bodies ---

const HERE_STRING_PREFIX = /^0?<<</;

/** Whether an inline tap/bd body flag value carries a live expansion. */
export function inlineBodyIsUnsafe(command: string): boolean {
  for (const segment of shellSegments(withoutHeredocBodies(command, true))) {
    const tokens = shellTokens(segment);
    const hit = toolAndFlags(tokens);
    if (hit === null) continue;
    const flags = hit.tapFlags ? HOOK_TAP_BODY_FLAGS : HOOK_BD_BODY_FLAGS;
    const argv = valuesAfter(tokens, hit.tokenIndex);
    if (hit.tapFlags) {
      const stdinBody = argv.some(
        (flag, index) =>
          index + 1 < argv.length &&
          (flag === "-f" || flag === "--body-file") &&
          argv[index + 1] === "-",
      );
      if (stdinBody) {
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index]!;
          const hereString = HERE_STRING_PREFIX.exec(token.raw);
          if (hereString === null) continue;
          if (token.raw.slice(hereString[0].length)) {
            if (token.unsafe) return true;
          } else if (index + 1 < tokens.length && tokens[index + 1]!.unsafe) {
            return true;
          }
        }
      }
    }
    const wordIndexes = new Set(commandWords(tokens).map((w) => w.tokenIndex));
    for (let index = hit.tokenIndex + 1; index < tokens.length; index++) {
      const token = tokens[index]!;
      const value = token.value;
      if (
        token.unsafe &&
        [...flags].some((flag) =>
          flag.length === 2 ? value.startsWith(flag) : value === flag || value.startsWith(`${flag}=`),
        )
      ) {
        return true;
      }
      // A redirection glued to the flag (`-m>a`) ends the word, so the flag is
      // what precedes it and the body is still the argument that follows.
      // A token that is only a redirection target keeps its raw value.
      if (!flags.has(wordIndexes.has(index) ? wordBeforeRedirection(token) : value)) continue;
      for (let j = index + 1; j < tokens.length; j++) {
        const bodyToken = tokens[j]!;
        if (bodyToken.unsafe) return true;
        // A redirection target such as `-out` in `-m> -out "$(date)"` is not
        // the next option; only a command word starting with `-` ends the body.
        if (wordIndexes.has(j) && bodyToken.value.startsWith("-")) break;
      }
    }
  }
  return false;
}

// --- unquoted heredoc bodies ---

export type HeredocUnsafe = false | "backtick" | "dollar_paren";

/** Expansion sites only in the shared scanner's unquoted bodies. */
export function unquotedHeredocCheck(command: string): HeredocUnsafe {
  for (const span of heredocBodies(command)) {
    if (span.quoted) continue;
    for (let position = 0; position < span.body.length; position++) {
      const char = span.body[position]!;
      if (shellEscaped(span.body, position)) continue;
      if (char === "`") return "backtick";
      if (span.isTapBd && commandSubstitutionAt(span.body, position)) return "dollar_paren";
    }
  }
  return false;
}

export function unquotedHeredocIsUnsafe(command: string): boolean {
  return unquotedHeredocCheck(command) !== false;
}

// --- harness adapter ---

export type Harness = "pretool" | "cursor" | "antigravity";

type Payload = Record<string, unknown>;

/** Normalize Claude/Codex, Cursor, and Antigravity shell hook payloads. */
export function commandAndHarness(payload: Payload): [string, Harness] | [null, null] {
  if (payload.tool_name === "Bash") {
    const toolInput = payload.tool_input;
    if (
      typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput) &&
      typeof (toolInput as Payload).command === "string"
    ) {
      return [(toolInput as Payload).command as string, "pretool"];
    }
  }
  if (typeof payload.command === "string") return [payload.command, "cursor"];
  const toolCall = payload.toolCall;
  if (typeof toolCall === "object" && toolCall !== null && !Array.isArray(toolCall)) {
    const call = toolCall as Payload;
    if (call.name === "run_command") {
      const args = call.args;
      if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        const commandLine = (args as Payload).CommandLine;
        if (typeof commandLine === "string") return [commandLine, "antigravity"];
      }
    }
  }
  return [null, null];
}

// --- denial emitter (Python json.dump byte parity) ---

// Local twin of spool-publication.ts's pyJsonString: importing that module
// pulls panelock/remind-lock machinery into the hook's load graph and nearly
// doubles per-call latency on every harness's Bash path. Byte-identical
// output (corpus replay pins this copy; the twin is oracle-pinned there).
const JSON_SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '\\"'], ["\\", "\\\\"], ["\b", "\\b"], ["\f", "\\f"],
  ["\n", "\\n"], ["\r", "\\r"], ["\t", "\\t"],
]);

/** Python json.dumps string escaping: ensure_ascii, lowercase \u, surrogate pairs for astral. */
export function pyJsonString(value: string): string {
  let out = '"';
  for (const char of value) {
    const simple = JSON_SIMPLE_ESCAPES.get(char);
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) {
      out += char;
    } else if (code > 0xffff) {
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return `${out}"`;
}

/** Python json.dump separators: ", " between items, ": " after keys. */
function pyJsonDict(pairs: Array<[string, string]>): string {
  return `{${pairs.map(([k, v]) => `${pyJsonString(k)}: ${v}`).join(", ")}}`;
}

/** One emitted line: the dict plus the trailing newline Python's write adds. */
function pyJsonLine(pairs: Array<[string, string]>): string {
  return `${pyJsonDict(pairs)}\n`;
}

const TMUX_REPAIR =
  "BLOCKED: an unscoped tmux kill-server can stop the machine's shared " +
  "tmux server and immediately suspend every TAP team. Name the private " +
  'socket on the kill itself: tmux -L "$name" kill-server or ' +
  'tmux -S "$path" kill-server. If you intend to stop the shared server, ' +
  "run the command yourself outside the agent.";
const REPAIR =
  "BLOCKED: the composing shell would evaluate backticks or $() in the body " +
  "before the recipient sees it. Write the body to a file first, then pass it: " +
  "tap send <to> -f <path>. For stdin: tap send <to> -f - <<'EOF' ... EOF " +
  "(the quotes on EOF are load-bearing). For bd: --body-file <path>.";
const HEREDOC_BACKTICK_REPAIR =
  "BLOCKED: backticks in an unquoted heredoc body are evaluated by the " +
  "composing shell before the command sees the text. Fix: quote the " +
  "delimiter — <<'EOF' instead of <<EOF. If you intended the substitution, " +
  "rewrite backticks as $(): `cmd` -> $(cmd).";

export function writeDenial(harness: Harness, reason: string): string {
  if (harness === "cursor") {
    return pyJsonLine([
      ["permission", '"deny"'],
      ["user_message", pyJsonString(reason)],
      ["agent_message", pyJsonString(reason)],
    ]);
  }
  if (harness === "antigravity") {
    return pyJsonLine([
      ["decision", '"deny"'],
      ["reason", pyJsonString(reason)],
    ]);
  }
  return pyJsonLine([
    [
      "hookSpecificOutput",
      pyJsonDict([
        ["hookEventName", '"PreToolUse"'],
        ["permissionDecision", '"deny"'],
        ["permissionDecisionReason", pyJsonString(reason)],
      ]),
    ],
  ]);
}

// --- process contract ---

export type HookResult = { stdout: string; exit: number };

const ALLOW: HookResult = { stdout: "", exit: 0 };

/**
 * Python's UTF-8-mode stdin decode: strict UTF-8, except each invalid byte
 * maps to U+DC80..U+DCFF (PEP 540 surrogateescape) instead of failing. The
 * TextDecoder must also keep a leading BOM (\uFEFF) instead of stripping it:
 * Python's json.load then fails on it and the hook fails open.
 */
function pythonStdinDecode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    let seqLen = 0;
    let codePoint = 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    if (b >= 0xc2 && b <= 0xdf) {
      seqLen = 2;
      codePoint = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      seqLen = 3;
      codePoint = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      seqLen = 4;
      codePoint = b & 0x07;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i += 1;
      continue;
    }
    let valid = true;
    for (let j = 1; j < seqLen; j++) {
      const c = bytes[i + j];
      if (c === undefined || (c & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (c & 0x3f);
    }
    const min = seqLen === 2 ? 0x80 : seqLen === 3 ? 0x800 : 0x10000;
    if (valid && codePoint >= min && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      out += String.fromCodePoint(codePoint);
      i += seqLen;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i += 1;
    }
  }
  return out;
}

/**
 * Python json's NaN/Infinity/-Infinity literal acceptance, reproduced only
 * outside strings: a rescue pass runs when strict JSON.parse fails, and a
 * scanner walks the text tracking string spans and backslash escapes so a
 * bare NaN inside a JSON string is never rewritten (F1: a string-blind
 * replace turned a heredoc closer `NaN` into `null` and allowed what Python
 * denies). Replacement keeps surrounding words invalid, matching Python's
 * whole-literal grammar.
 */
function rescuePythonJsonLiterals(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (text.startsWith("NaN", i)) {
      out += "null";
      i += 2;
      continue;
    }
    if (text.startsWith("-Infinity", i)) {
      out += "null";
      i += 8;
      continue;
    }
    if (text.startsWith("Infinity", i)) {
      out += "null";
      i += 7;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * The hook as a pure function: exact stdin bytes -> stdout bytes + exit
 * status, byte-identical to the frozen corpus captured from the Python hook.
 * Fail-open everywhere the payload cannot be parsed. Python's stdin decode
 * (UTF-8 mode: strict + surrogateescape per invalid byte, BOM kept) and its
 * json NaN/Infinity acceptance (rescue pass after strict JSON.parse fails)
 * are reproduced exactly; every arm exits 0 with empty stdout on allow.
 */
export function hookResponse(stdin: Uint8Array): HookResult {
  const text = pythonStdinDecode(stdin);
  // Defensive: JSON.parse already rejects a leading \uFEFF (M9 equivalent
  // mutant); this check keeps the fail-open explicit if the decoder changes.
  if (text.startsWith("\uFEFF")) return ALLOW;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    try {
      payload = JSON.parse(rescuePythonJsonLiterals(text));
    } catch {
      return ALLOW;
    }
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ALLOW;
  const [command, harness] = commandAndHarness(payload as Payload);
  if (command === null) return ALLOW;
  if (tmuxKillServerIsUnsafe(command)) return { stdout: writeDenial(harness!, TMUX_REPAIR), exit: 0 };
  if (inlineBodyIsUnsafe(command)) return { stdout: writeDenial(harness!, REPAIR), exit: 0 };
  const heredocKind = unquotedHeredocCheck(command);
  if (heredocKind === "backtick") {
    return { stdout: writeDenial(harness!, HEREDOC_BACKTICK_REPAIR), exit: 0 };
  }
  if (heredocKind === "dollar_paren") {
    return { stdout: writeDenial(harness!, REPAIR), exit: 0 };
  }
  return ALLOW;
}
