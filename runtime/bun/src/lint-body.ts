// Dark C9 shell-body lexer (tap-oymdg): the shared tokenizer that
// runtime/bun/src/shell-body-guard.ts (the S1 Bun port of the Python
// PreToolUse hook) builds its classifier on. Tokenization matches the
// Python guard exactly, including Python str.isspace() — not Bash IFS and
// not ASCII-only whitespace — ANSI-C $'...' words, comment-aware segments,
// backslash-newline continuations, and Python getopt option semantics for
// the wrapper grammars. The classifier, adapter and emitter live beside the
// hook; this file stays the lexer.

export type ShellToken = {
  value: string;
  unsafe: boolean;
  raw: string;
};

/** `$(` is command substitution; `$((` is arithmetic and must not trip unsafe. */
export function commandSubstitutionAt(text: string, index: number): boolean {
  return text.startsWith("$(", index) && !text.startsWith("$((", index);
}

/** Odd-length backslash run immediately before `index` escapes that character. */
export function shellEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === "\\") {
    backslashes += 1;
    i -= 1;
  }
  return backslashes % 2 === 1;
}

/**
 * One literal `$'...'` span (ANSI-C quoting): returns the index past the
 * closing quote and the decoded value, or null. Port of the Python guard's
 * ansi_c_word: unknown escapes keep the backslash, octal wraps mod 256,
 * `\u`/`\U` above 0x10FFFF stay raw, `\c?` is DEL, and the value truncates
 * at the first NUL. Never evaluates shell input.
 */
const ANSI_C_ESCAPES = /\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|c[^\n]|[^])/y;
const ANSI_C_SIMPLE = new Map<string, string>([
  ["a", "\x07"], ["b", "\x08"], ["e", "\x1b"], ["E", "\x1b"], ["f", "\x0c"],
  ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\x0b"], ["\\", "\\"],
  ["'", "'"], ['"', '"'], ["?", "?"],
]);

export function ansiCWord(source: string, position: number): [number, string] | null {
  if (!source.startsWith("$'", position)) return null;
  const start = position + 2;
  let p = start;
  while (p < source.length) {
    if (source[p] === "\\" && p + 1 < source.length) {
      p += 2;
    } else if (source[p] === "'") {
      return [p + 1, decodeAnsiC(source.slice(start, p)).split("\0", 1)[0]!];
    } else {
      p += 1;
    }
  }
  return null;
}

function decodeAnsiC(span: string): string {
  ANSI_C_ESCAPES.lastIndex = 0;
  let out = "";
  let index = 0;
  while (index < span.length) {
    ANSI_C_ESCAPES.lastIndex = index;
    const match = ANSI_C_ESCAPES.exec(span);
    if (!match || match.index !== index) {
      out += span[index]!;
      index += 1;
      continue;
    }
    out += decodeAnsiCEscape(match[0]!.slice(1));
    index += match[0].length;
  }
  return out;
}

function decodeAnsiCEscape(escape: string): string {
  const first = escape[0]!;
  if (first >= "0" && first <= "7") {
    return String.fromCharCode(parseInt(escape, 8) % 256);
  }
  if ((first === "x" || first === "u" || first === "U") && escape.length > 1) {
    const value = parseInt(escape.slice(1), 16);
    return value <= 0x10ffff ? String.fromCodePoint(value) : `\\${escape}`;
  }
  if (first === "c" && escape.length === 2) {
    return String.fromCharCode(escape[1] === "?" ? 127 : escape[1]!.charCodeAt(0) & 31);
  }
  return ANSI_C_SIMPLE.get(escape) ?? `\\${escape}`;
}

/**
 * A comment starts at an unquoted word boundary, after line joining. Port of
 * shell_comment_at, including the escaped-newline back-scan.
 */
export const SHELL_WORD_BREAK = " \t\n|&;()<>";
export function shellCommentAt(source: string, position: number): boolean {
  let previous = position - 1;
  while (previous > 0 && source[previous] === "\n" && shellEscaped(source, previous)) {
    previous -= 2;
  }
  return previous < 0 || (SHELL_WORD_BREAK.includes(source[previous]!) && !shellEscaped(source, previous));
}

/**
 * Python 3 `str.isspace()` as a closed code-point set (29 BMP scalars;
 * CPython 3.14 measured 2026-09-01). Not Bash IFS (space/tab/newline) and
 * not Unicode general-category Zs alone: U+001C..U+001F and U+0085 are Cc.
 */
export const PYTHON_ISSPACE: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isSpace(char: string): boolean {
  return char.length === 1 && PYTHON_ISSPACE.has(char.charCodeAt(0));
}

/**
 * One shell segment → tokens of (value, has_unsafe_expansion, raw).
 *
 * Quotes are stripped from `value` and kept in `raw`. A backslash outside
 * single quotes consumes the next character into `value` without the slash,
 * so `\$()` is not unsafe: the `$` never occupies a scan index. `#` ends
 * the segment only when it would start a new unquoted token.
 */
export function shellTokens(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value: string[] = [];
  let unsafe = false;
  let rawStart: number | null = null;
  let quote: "'" | '"' | null = null;
  let i = 0;

  const finish = (end: number): void => {
    if (rawStart === null) return;
    tokens.push({ value: value.join(""), unsafe, raw: segment.slice(rawStart, end) });
    value = [];
    unsafe = false;
    rawStart = null;
  };

  while (i < segment.length) {
    const char = segment[i]!;
    const next = segment[i + 1];
    const literal = quote === null ? ansiCWord(segment, i) : null;
    if (literal !== null) {
      if (rawStart === null) rawStart = i;
      i = literal[0];
      value.push(literal[1]);
      continue;
    }
    if (char === "\\" && quote !== "'" && next !== undefined) {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (rawStart === null) rawStart = i;
      value.push(next);
      i += 2;
      continue;
    }
    if (char === "#" && quote === null && rawStart === null) break;
    if (char === "'" || char === '"') {
      if (rawStart === null) rawStart = i;
      if (quote === null) {
        quote = char;
        i += 1;
        continue;
      }
      if (quote === char) {
        quote = null;
        i += 1;
        continue;
      }
    }
    if (quote === null && isSpace(char)) {
      finish(i);
      i += 1;
      continue;
    }
    if (rawStart === null) rawStart = i;
    if (quote !== "'" && (char === "`" || commandSubstitutionAt(segment, i))) {
      unsafe = true;
    }
    value.push(char);
    i += 1;
  }
  finish(segment.length);
  return tokens;
}

/**
 * Split on top-level `;`, `|`, `&`, and newline. `2>&1`, `>|`, and `&>` stay
 * inside the segment: those ampersands and pipes are redirection, not
 * separators. Quote and backslash state match the Python guard, including
 * the empty middle segment `&&` produces.
 */
export function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (quote === char) quote = null;
      continue;
    }
    const literal = ansiCWord(command, i);
    if (literal !== null) {
      i = literal[0] - 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && shellCommentAt(command, i)) {
      const newline = command.indexOf("\n", i);
      i = newline === -1 ? command.length - 1 : newline - 1;
      continue;
    }
    const prev = i > 0 ? command[i - 1] : "";
    const next = command[i + 1];
    const redirectionPart =
      (char === "&" && (prev === "<" || prev === ">" || next === ">")) ||
      (char === "|" && prev === ">");
    if (";|&\n".includes(char) && !redirectionPart) {
      segments.push(command.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

// [^\n] not `.`: Python's regex dot excludes only LF, JS `.` also excludes
// CR/U+2028/U+2029 — a CR inside an assignment value must still match
// (partner finding F: `FOO="a\rb"` is an assignment in Python, not a command).
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/;

type WrapperGrammar = {
  shortOptions: string;
  longOptions: string[];
  optionalLong: ReadonlySet<string>;
  bareDashIsI: boolean;
};

const WRAPPERS: Record<string, WrapperGrammar> = {
  command: {
    shortOptions: "pVv",
    longOptions: [],
    optionalLong: new Set(),
    bareDashIsI: false,
  },
  env: {
    shortOptions: "0a:ivC:P:S:u:",
    longOptions: [
      "argv0=",
      "ignore-environment",
      "null",
      "unset=",
      "chdir=",
      "split-string=",
      "block-signal",
      "default-signal",
      "ignore-signal",
      "list-signal-handling",
      "debug",
      "help",
      "version",
    ],
    optionalLong: new Set(["block-signal", "default-signal", "ignore-signal"]),
    bareDashIsI: true,
  },
  bash: {
    shortOptions: "abefhkmnptuvxBCEHPTilrsDc:O:o:",
    longOptions: [
      "debug",
      "debugger",
      "dump-po-strings",
      "dump-strings",
      "help",
      "init-file=",
      "login",
      "noediting",
      "noprofile",
      "norc",
      "posix",
      "pretty-print",
      "rcfile=",
      "restricted",
      "verbose",
      "version",
    ],
    optionalLong: new Set(),
    bareDashIsI: false,
  },
  sh: {
    shortOptions: "abefhkmnptuvxBCHPirsDc:O:o:",
    longOptions: [
      "debug",
      "debugger",
      "dump-po-strings",
      "dump-strings",
      "help",
      "init-file=",
      "login",
      "noediting",
      "noprofile",
      "norc",
      "posix",
      "protected",
      "rcfile=",
      "restricted",
      "verbose",
      "version",
      "wordexp",
    ],
    optionalLong: new Set(),
    bareDashIsI: false,
  },
};

function shortTakesArg(shortOptions: string, opt: string): boolean | null {
  for (let i = 0; i < shortOptions.length; ) {
    const name = shortOptions[i]!;
    const takes = shortOptions[i + 1] === ":";
    if (name === opt) return takes;
    i += takes ? 2 : 1;
  }
  return null;
}

function longSpec(longOptions: string[], name: string): "flag" | "arg" | null {
  for (const spec of longOptions) {
    if (spec === name) return "flag";
    if (spec === `${name}=`) return "arg";
  }
  return null;
}

/**
 * Python getopt long-option resolution: exact match first, then unique-prefix
 * abbreviation. An ambiguous prefix, `=value` on a no-argument option, or a
 * missing argument is a GetoptError (null here). Options stop at the first
 * non-option; `--` terminates and is consumed.
 */
function longMatch(
  longOptions: string[],
  name: string,
): { kind: "flag" | "arg"; exact: boolean; alias?: string } | { kind: "error" } | { kind: "unknown" } {
  const spec = longSpec(longOptions, name);
  if (spec) return { kind: spec, exact: true };
  const hits: string[] = [];
  let argForm = false;
  for (const option of longOptions) {
    const base = option.endsWith("=") ? option.slice(0, -1) : option;
    if (base.startsWith(name)) {
      hits.push(base);
      if (option.endsWith("=")) argForm = true;
    }
  }
  const unique = [...new Set(hits)];
  if (unique.length === 0) return { kind: "unknown" };
  if (unique.length > 1) return { kind: "error" };
  return { kind: argForm ? "arg" : "flag", exact: false, alias: unique[0] };
}

/** Python getopt.getopt for these wrapper grammars: options stop at the first non-option. */
function getoptRemaining(args: string[], grammar: WrapperGrammar): string[] | null {
  const remaining = [...args];
  while (remaining.length > 0) {
    const arg = remaining[0]!;
    if (arg === "--") {
      remaining.shift();
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const match = longMatch(grammar.longOptions, name);
      if (match.kind === "unknown" || match.kind === "error") return null;
      remaining.shift();
      if (match.kind === "flag" && eq !== -1) return null;
      if (match.kind === "arg") {
        if (eq !== -1) continue;
        if (remaining.length === 0) return null;
        remaining.shift();
      }
      continue;
    }
    let cluster = arg.slice(1);
    remaining.shift();
    while (cluster.length > 0) {
      const opt = cluster[0]!;
      const takes = shortTakesArg(grammar.shortOptions, opt);
      if (takes === null) return null;
      cluster = cluster.slice(1);
      if (takes) {
        if (cluster.length > 0) {
          cluster = "";
        } else {
          if (remaining.length === 0) return null;
          remaining.shift();
        }
      }
    }
  }
  return remaining;
}

function wrapperAndGrammar(value: string): { name: string; grammar: WrapperGrammar } | null {
  for (const name of Object.keys(WRAPPERS)) {
    if (value === name || value.endsWith(`/${name}`)) {
      return { name, grammar: WRAPPERS[name]! };
    }
  }
  return null;
}

function consumeWrapperOptions(values: string[], grammar: WrapperGrammar): number | null {
  const normalized = [...values];
  if (grammar.bareDashIsI && normalized[0] === "-") normalized[0] = "-i";
  for (let index = 0; index < normalized.length; index++) {
    const value = normalized[index]!;
    if (!value.startsWith("--") || !value.includes("=")) continue;
    const name = value.slice(2).split("=", 1)[0]!;
    if (grammar.optionalLong.has(name)) normalized[index] = `--${name}`;
  }
  const remaining = getoptRemaining(normalized, grammar);
  if (remaining === null) return null;
  return values.length - remaining.length;
}

export type CommandWord = { tokenIndex: number; value: string };

const REDIRECTION_OPERATORS = ["<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "&>>", "&>", "<", ">"];
const FD_PREFIX = /^(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/** Index past the `)` balancing the `(` at `open`, or null when unbalanced. */
function processSubstitutionEnd(raw: string, open: number): number | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = open; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === "\\" && quote !== "'") {
      i += 1;
    } else if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Index of the first unquoted redirection operator in a raw token, or null.
 * Bash ends a word at an unquoted `<`, `>`, or `&>` and starts a redirection
 * there, so `tap>/dev/null` is the word `tap` plus a redirection. Quotes,
 * backslash escapes, and `$'...'` hide an operator; `<(` and `>(` (process
 * substitution) stay part of the word, and their balanced span is skipped.
 */
function redirectionStart(raw: string): number | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === null) {
      const literal = ansiCWord(raw, i);
      if (literal !== null) {
        i = literal[0] - 1;
        continue;
      }
    }
    if (char === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "<" || char === ">") {
      if (raw[i + 1] !== "(") return i;
      // Process substitution is part of the word: skip its balanced span so an
      // operator after it (`>(cat)> next`) is still seen.
      const end = processSubstitutionEnd(raw, i + 1);
      if (end === null) return null;
      i = end - 1;
      continue;
    }
    if (char === "&" && raw[i + 1] === ">") return i;
  }
  return null;
}

/**
 * Walk the redirection chain starting at `from` (an operator, fd prefix
 * already stripped by the caller when it precedes it). True when the last
 * operator still owes its target to the next token.
 */
function redirectionChainOwesTarget(raw: string, from: number): boolean {
  let position = from;
  for (;;) {
    const operator = REDIRECTION_OPERATORS.find((op) => raw.startsWith(op, position));
    if (operator === undefined) return false;
    const targetStart = position + operator.length;
    const next = redirectionStart(raw.slice(targetStart));
    if (next === null) return targetStart >= raw.length;
    position = targetStart + next;
  }
}

/**
 * Remove line continuations (backslash-newline) the way Bash does before it
 * reads operators: not inside single quotes, and not after an escaped backslash.
 */
function withoutLineContinuations(raw: string): string {
  if (!raw.includes("\\\n")) return raw;
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === null) {
      const literal = ansiCWord(raw, i);
      if (literal !== null) {
        out += raw.slice(i, literal[0]);
        i = literal[0] - 1;
        continue;
      }
    }
    if (char === "\\" && quote !== "'" && i + 1 < raw.length) {
      if (raw[i + 1] !== "\n") out += char + raw[i + 1];
      i += 1;
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) quote = char;
    else if (quote === char) quote = null;
    out += char;
  }
  return out;
}

/**
 * The word Bash sees once a glued redirection is cut off a token: `-m>a` is
 * the word `-m` plus a redirection (tap-io56b). A token with no unquoted
 * operator returns its own value.
 */
export function wordBeforeRedirection(token: ShellToken): string {
  const raw = withoutLineContinuations(token.raw);
  const cut = redirectionStart(raw);
  if (cut === null) return token.value;
  const prefix = raw.slice(0, cut);
  return shellTokens(prefix)[0]?.value ?? prefix;
}

/** Original-index words after Bash removes redirections. */
export function commandWords(tokens: ShellToken[]): CommandWord[] {
  const words: CommandWord[] = [];
  let skipTarget = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const raw = withoutLineContinuations(token.raw);
    if (skipTarget) {
      // The pending target may itself end in another operator (`> out> next`).
      const nested = redirectionStart(raw);
      skipTarget = nested !== null && redirectionChainOwesTarget(raw, nested);
      continue;
    }
    const cut = redirectionStart(raw);
    if (cut === null) {
      words.push({ tokenIndex: index, value: token.value });
      continue;
    }
    const prefix = raw.slice(0, cut);
    // Only `<` and `>` take an fd prefix; `2&>x` leaves the word `2`.
    if (prefix === "" || (raw[cut] !== "&" && FD_PREFIX.test(prefix))) {
      skipTarget = redirectionChainOwesTarget(raw, cut);
      continue;
    }
    words.push({ tokenIndex: index, value: shellTokens(prefix)[0]?.value ?? prefix });
    skipTarget = redirectionChainOwesTarget(raw, cut);
  }
  return words;
}

/**
 * First simple-command word after assignments and the named wrappers.
 * This is the command-position test tap-oymdg proved a character class cannot do.
 */
export function resolveCommand(tokens: ShellToken[]): CommandWord | null {
  const words = commandWords(tokens);
  const values = words.map((w) => w.value);
  let index = 0;
  while (index < values.length && ASSIGNMENT.test(values[index]!)) index += 1;
  while (index < values.length) {
    const wrapper = wrapperAndGrammar(values[index]!);
    if (!wrapper) break;
    index += 1;
    const consumed = consumeWrapperOptions(values.slice(index), wrapper.grammar);
    if (consumed === null) return null;
    index += consumed;
    if (wrapper.name === "env") {
      while (index < values.length && ASSIGNMENT.test(values[index]!)) index += 1;
    }
  }
  return words[index] ?? null;
}

