// Caller-terminal facts and the single-key consent prompt for native launcher
// commands that own their terminal (the public CLI, never the piped worker).
// A prompt may appear only when BOTH stdin and stdout are terminals: a
// stdin-PTY/stdout-piped agent runner would be asked a question it cannot read.
import { CString, dlopen, type FFIFunction } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { isatty } from "node:tty";
import { tokenCharAllowed } from "../ids";
import { InvocationError } from "./invocation";
import { releaseLaunchProgressForSignal, suspendLaunchProgress } from "./progress";

/** libc under its Darwin, glibc and musl names, as remind-lock.ts opens it; throws if none loads. */
export const LIBC_NAMES = ["/usr/lib/libSystem.B.dylib", "libc.so.6", "libc.so"];
export function openLibc<const T extends Record<string, FFIFunction>>(symbols: T, names = LIBC_NAMES) {
  let failure: unknown;
  for (const name of names) {
    try { return dlopen(name, symbols); } catch (error) { failure = error; }
  }
  throw failure;
}

export function callerHasTty(): boolean {
  try { return isatty(0) && isatty(1); } catch { return false; }
}

/** ttyname of stderr, else stdout; "" when neither is a terminal. */
export function callerTty(): string {
  try {
    const libc = openLibc({ ttyname: { args: ["i32"], returns: "ptr" } });
    try {
      for (const fd of [2, 1]) {
        if (!isatty(fd)) continue;
        const name = libc.symbols.ttyname(fd);
        if (name) return new CString(name).toString();
      }
    } finally { libc.close(); }
  } catch { /* An unobservable terminal is no terminal. */ }
  return "";
}

// One key in cbreak mode, owned by a shell child on the inherited terminal: it
// saves nothing of its own, restores the caller's exact `stty -g` state on
// every exit (including SIGINT and SIGQUIT, which cbreak leaves enabled), and
// Bun itself never changes termios. QUIT exits 131 (128 + 3) so the caller can
// re-raise the signal it swallowed, as it does for INT.
const RESTORE_TRAPS = 'trap \'stty "$1"; exit 130\' INT TERM; trap \'stty "$1"; exit 131\' QUIT; ';
const READ_KEY = RESTORE_TRAPS + 'stty -icanon -echo min 1 time 0 || exit 3; '
  + 'dd bs=1 count=1 2>/dev/null; status=$?; stty "$1"; exit $status';

// Ctrl-C and Ctrl-\ reach every foreground-group member, this process included
// (tap-bnwo5, tap-q4pls): dying inside the spawnSync below would orphan the
// key-reading child before its trap restores the terminal, leaving the caller's
// terminal in cbreak. system(3) shields SIGINT and SIGQUIT while it waits for
// its child; so does this, and the caller re-raises below once the restore has
// landed.
const shieldedKeyRead = (script: string, state: string) => {
  const shield = () => {};
  process.on("SIGINT", shield);
  process.on("SIGQUIT", shield);
  try {
    return spawnSync("/bin/sh", ["-c", script, "tap-prompt", state], { stdio: ["inherit", "pipe", "ignore"] });
  } finally {
    process.off("SIGINT", shield);
    process.off("SIGQUIT", shield);
  }
};

// Re-raise a swallowed signal, now that the terminal is restored. The launch spinner's
// own handler is released first (tap-okayq): left in place it defers the signal to the
// event loop, and the caller's read error would exit 1 ahead of it.
const raiseSwallowed = (signal: NodeJS.Signals) => {
  releaseLaunchProgressForSignal();
  process.kill(process.pid, signal);
};

const reraiseInterrupt = (read: { signal: NodeJS.Signals | null; status: number | null }) => {
  if (read.signal === "SIGINT" || read.status === 130) raiseSwallowed("SIGINT");
  if (read.signal === "SIGQUIT" || read.status === 131) raiseSwallowed("SIGQUIT");
};

/** prompt_yes_no: one key answers, Enter takes the default. */
export function promptYesNo(verb: string, question: string, defaultYes: boolean): boolean {
  const resume = suspendLaunchProgress();
  try { return askYesNo(verb, question, defaultYes); } finally { resume(); }
}

function askYesNo(verb: string, question: string, defaultYes: boolean): boolean {
  if (!callerHasTty()) throw new InvocationError("interactive prompt requires a TTY");
  const saved = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" });
  const state = saved.status === 0 ? saved.stdout.trim() : "";
  if (!state) throw new InvocationError("interactive prompt requires a terminal");
  const choices = defaultYes ? "Y/n" : "y/N";
  for (;;) {
    process.stderr.write(`tap ${verb}: ${question} [${choices}] `);
    const read = shieldedKeyRead(READ_KEY, state);
    reraiseInterrupt(read);
    if (read.status !== 0) throw new InvocationError("interactive prompt requires a terminal");
    const bytes = read.stdout as Buffer;
    if (bytes.length === 0) throw new InvocationError("interactive prompt ended before a choice");
    const answer = bytes[0]! < 0x80 ? String.fromCharCode(bytes[0]!) : "�";
    if (answer === "\r" || answer === "\n") return defaultYes;
    if (answer === "y" || answer === "Y") return true;
    if (answer === "n" || answer === "N") return false;
    process.stderr.write(`tap ${verb}: choose y or n\n`);
  }
}

/** caller_owns_foreground_tty: this process group owns BOTH stdin and stdout. */
export function callerOwnsForegroundTty(): boolean {
  try {
    const libc = openLibc({ tcgetpgrp: { args: ["i32"], returns: "i32" }, getpgrp: { args: [], returns: "i32" } });
    try {
      const group = libc.symbols.getpgrp();
      // tcgetpgrp answers -1 for a stream that is not a terminal: never ours.
      return [0, 1].every(fd => libc.symbols.tcgetpgrp(fd) === group);
    } finally { libc.close(); }
  } catch { return false; }
}

/** shutil.get_terminal_size's column answer: $COLUMNS, then stdout, then 80. */
function terminalColumns(): number {
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10);
  if (/^\s*[+-]?\d+\s*$/.test(process.env.COLUMNS ?? "") && env > 0) return env;
  try { return process.stdout.columns || 80; } catch { return 80; }
}

// One byte if it arrives within 0.1 s, else none: the Esc-sequence drain. It
// carries READ_KEY's restore trap: an interrupt mid-drain still restores.
export const DRAIN_KEY = RESTORE_TRAPS + 'stty -icanon -echo min 0 time 1 || exit 3; '
  + 'dd bs=1 count=1 2>/dev/null; status=$?; stty "$1"; exit $status';

const keysText = (keys: string[]): string => keys.length === 1 ? keys[0]!
  : keys.length === 2 ? `${keys[0]} or ${keys[1]}` : `${keys.slice(0, -1).join(", ")}, or ${keys.at(-1)}`;

/** A terminal that can be edited key by key: stderr a TTY, TERM set and not dumb. NO_COLOR is not part of it. */
export function promptEditable(environ: NodeJS.ProcessEnv = process.env): boolean {
  if (!environ.TERM || environ.TERM === "dumb") return false;
  try { return process.stderr.isTTY === true; } catch { return false; }
}

/** Grey only for an editable terminal that takes colour, where every prompt draws. */
export function promptGreyCapable(environ: NodeJS.ProcessEnv = process.env): boolean {
  return environ.NO_COLOR === undefined && promptEditable(environ);
}
const GREY = "\x1b[90m", UNGREY = "\x1b[39m";

/** A chooser row: key, label, gloss; a fourth `true` lists it greyed out, its gloss the reason. */
export type ChoiceOption = [key: string, label: string, gloss: string, unavailable?: boolean];

/** prompt_choice: a single-key chooser; Enter takes the default, a bare Esc quits.
 *  An unavailable row stays listed (greyed, or "(unavailable: reason)" without colour)
 *  and its key only says why before the menu returns. */
export function promptChoice(verb: string, question: string, options: ChoiceOption[], fallback: string): string {
  const resume = suspendLaunchProgress();
  try { return askChoice(verb, question, options, fallback); } finally { resume(); }
}

function askChoice(verb: string, question: string, options: ChoiceOption[], fallback: string): string {
  if (!callerHasTty()) throw new InvocationError("interactive prompt requires a TTY");
  const keys = options.map(([key]) => key);
  const enabled = options.filter(option => !option[3]).map(([key]) => key);
  if (!options.length || keys.some(key => key.length !== 1 || key === "\n" || key === "|")
      || !enabled.includes(fallback) || !enabled.includes("q")
      || options.some(([, label, gloss]) => !label || !gloss || /\n/.test(label + gloss))) {
    // Unlike prompt_choice, a pipe is allowed: nothing here parses a delimited
    // row, and instance ids (handle|hex) sit in the departed-restore gloss.
    throw new Error("choice options must be one-character key, label, gloss triples including q and the default");
  }
  const width = terminalColumns();
  const labelWidth = Math.max(...options.map(([, label]) => label.length));
  const grey = promptGreyCapable();
  const saved = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" });
  const state = saved.status === 0 ? saved.stdout.trim() : "";
  if (!state) throw new InvocationError("interactive prompt requires a terminal");
  const readByte = (script: string): Buffer => {
    const read = shieldedKeyRead(script, state);
    reraiseInterrupt(read);
    if (read.status !== 0) throw new InvocationError("interactive prompt requires a terminal");
    return read.stdout as Buffer;
  };
  const decode = (bytes: Buffer): string => bytes[0]! < 0x80 ? String.fromCharCode(bytes[0]!) : "�";
  const row = ([key, label, gloss, unavailable]: ChoiceOption): string => {
    const shown = unavailable && !grey ? `(unavailable: ${gloss})` : gloss;
    // A narrow menu drops glosses, never an unavailable row's reason.
    const text = width <= 40 ? `  [${key}] ${label}${unavailable ? ` (unavailable: ${gloss})` : ""}` : `  [${key}] ${label.padEnd(labelWidth)}  ${shown}`;
    return unavailable && grey ? `${GREY}${text}${UNGREY}\n` : `${text}\n`;
  };
  for (;;) {
    process.stderr.write(`tap ${verb}: ${question}\n\n`);
    for (const option of options) process.stderr.write(row(option));
    process.stderr.write(`\nChoice [${fallback}] (Esc quits): `);
    const bytes = readByte(READ_KEY);
    if (bytes.length === 0) throw new InvocationError("interactive prompt ended before a choice");
    let answer = decode(bytes);
    if (answer === "\r" || answer === "\n") answer = fallback;
    else if (answer === "\x1b") {
      let sequence = "";
      for (let more = readByte(DRAIN_KEY); more.length; more = readByte(DRAIN_KEY)) sequence += decode(more);
      answer = sequence ? "" : "q";
    }
    const unavailable = options.find(option => option[0] === answer && option[3]);
    if (unavailable) { process.stderr.write(`tap ${verb}: ${unavailable[1]} is unavailable: ${unavailable[2]}\n`); continue; }
    if (keys.includes(answer)) return answer;
    process.stderr.write(`tap ${verb}: choose ${keysText(enabled)}\n`);
  }
}

// The name prompt's reads run as children the parent AWAITS, so a SIGTERM or
// SIGHUP sent to this process alone is forwarded to the child, whose trap
// restores the terminal before the parent re-raises the signal. The child waits
// on a background reader rather than a foreground one because a trapped signal
// interrupts `wait` immediately but would otherwise wait for the next key. A
// background job ignores keyboard INT and QUIT in a non-interactive shell, so
// every trap also stops the reader. Until `r` names the reader, the traps only
// record the signal; arming then honours one that landed in that window.
// Ctrl-Z (SIGTSTP) is a cancel: stopping would freeze the prompt with cbreak still
// set and hand the user's shell a terminal with echo off. The trap restores it and
// exits 4, the end-of-input status, so the prompt quits with nothing changed. The
// reader is continued before it is killed because the keyboard stopped it too.
const READER_PENDING = 'got=; trap "got=130" INT; trap "got=131" QUIT; trap "got=143" TERM HUP; trap "got=4" TSTP; exec 3<&0; ';
const READER_ARMED = 'trap \'kill $r 2>/dev/null; stty "$1"; exit 130\' INT; trap \'kill $r 2>/dev/null; stty "$1"; exit 131\' QUIT; '
  + 'trap \'kill $r 2>/dev/null; stty "$1"; exit 143\' TERM HUP; '
  + 'trap \'kill -CONT $r 2>/dev/null; kill $r 2>/dev/null; stty "$1"; exit 4\' TSTP; '
  + '[ -z "$got" ] || { kill -CONT $r 2>/dev/null; kill $r 2>/dev/null; stty "$1"; exit $got; }; ';
const awaitedReader = (mode: string, bytes: number) => READER_PENDING + `stty -icanon -echo ${mode} || { stty "$1"; exit 3; }; `
  + `dd bs=${bytes} count=1 <&3 2>/dev/null & r=$!; ` + READER_ARMED + 'wait $r; status=$?; stty "$1"; exit $status';
// Up to 64 bytes per read, so a paste or an arrow key's escape sequence arrives whole.
const READ_CHUNK = awaitedReader("min 1 time 0", 64);
// One byte if it arrives within 0.1 s, else none (the Esc-sequence drain).
const DRAIN_CHUNK = awaitedReader("min 0 time 1", 1);
// The plain prompt reads one cooked line and never changes the terminal mode.
const READ_LINE = 'trap "exit 130" INT; trap "exit 131" QUIT; trap "exit 143" TERM HUP; trap "exit 4" TSTP; IFS= read -r line || exit 4; printf "%s" "$line"';

/** One awaited prompt read. Every stopping signal this process receives (keyboard INT
 *  and QUIT reach the child too; a signal sent to this process alone does not) is
 *  forwarded to the child, whose trap restores the terminal; then this process
 *  re-raises it, once. */
async function awaitedRead(script: string, state: string): Promise<{ status: number | null; stdout: Buffer }> {
  // Handlers go in before the spawn: a signal that lands first is held and forwarded once the child exists.
  let received: NodeJS.Signals | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let status: number | null = null;
  // Bun.spawn's kill takes SIGTSTP only as a number: the name is silently dropped.
  const forward = (signal: NodeJS.Signals) => () => { received ??= signal; child?.kill(constants.signals[signal]); };
  const handlers = (["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const).map(signal => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    child = Bun.spawn(["/bin/sh", "-c", script, "tap-prompt", state], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    if (received) child.kill(constants.signals[received]);
    const stdout = Buffer.from(await new Response(child.stdout as ReadableStream).arrayBuffer());
    status = await child.exited;
    return { status, stdout };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    // Suspend is answered by the child's own cancel, never re-raised: re-raising would stop this process.
    const raise = (received === "SIGTSTP" ? null : received) ?? (status === 130 ? "SIGINT" : status === 131 ? "SIGQUIT" : null);
    if (raise) raiseSwallowed(raise);
  }
}

/** What the name editor shows after a refused key: the handle charset, from the one gate (ids.ts). */
const NAME_HINT = "letters, digits, . _ - (first: letter or digit)";

/** The name editor's state: typed text, then a grey default suffix that the first key replaces. */
export class NameEditor {
  constructor(public text: string, public placeholder: string) {}
  value(): string { return this.text + this.placeholder; }
  /** Typing replaces the placeholder. A character a handle cannot hold never enters
   *  the line (the placeholder survives a refused key); the refused ones come back. */
  type(chars: string): string {
    let refused = "";
    for (const char of chars) {
      if (!tokenCharAllowed(char, this.text === "")) { refused += char; continue; }
      this.placeholder = "";
      this.text += char;
    }
    return refused;
  }
  /** Backspace drops the placeholder and the character before the cursor, reaching into the prefix. */
  backspace(): void { this.placeholder = ""; this.text = Array.from(this.text).slice(0, -1).join(""); }
}

/** A name check: null accepts, a string is the reason to ask again. */
export type NameCheck = (name: string) => string | null;
export type AskName = (question: string, prefix: string, suffix: string, check: NameCheck) => string | null | Promise<string | null>;

/**
 * prompt_name: ask for a name whose default is prefix + suffix, the suffix grey.
 * Enter accepts, typing replaces the suffix, Backspace edits into the prefix.
 * A key a handle cannot contain (space, "/", a leading "-") never enters the line,
 * a pasted one included: it rings the bell and the line names what is allowed.
 * An invalid name asks again with its reason; Esc (or end of input) returns
 * null for quit, and Ctrl-C re-raises SIGINT once the terminal is restored.
 * NO_COLOR changes the look, never the keys: the editor still reads key by key and
 * filters, but plainly, the default in brackets and no escape sequences, echoing each
 * accepted character (Backspace is "\b \b"). What is typed is the whole name; Ctrl-D quits.
 * TERM=dumb (or no TERM) cannot take raw redraws: it asks on a cooked line, which the
 * kernel echoes whole, so check() is the filter there and a refusal asks again,
 * naming the allowed characters (Esc only once Enter ends the line).
 * The editor never holds a terminal mode itself: each read is a shell child that
 * sets cbreak, reads one chunk and restores the caller's state before exiting,
 * and any signal that ends this process first lets that child restore (awaitedRead).
 */
export async function promptName(question: string, prefix: string, suffix: string, check: NameCheck): Promise<string | null> {
  const resume = suspendLaunchProgress();
  try { return await askName(question, prefix, suffix, check); } finally { resume(); }
}

async function askName(question: string, prefix: string, suffix: string, check: NameCheck): Promise<string | null> {
  if (!callerHasTty()) throw new InvocationError("interactive prompt requires a TTY");
  const saved = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" });
  const state = saved.status === 0 ? saved.stdout.trim() : "";
  if (!state) throw new InvocationError("interactive prompt requires a terminal");
  const read = async (script: string): Promise<Buffer | null> => {
    const result = await awaitedRead(script, state);
    if (result.status === 4) return null;
    if (result.status !== 0) throw new InvocationError("interactive prompt requires a terminal");
    return result.stdout as Buffer;
  };
  const fallback = prefix + suffix;
  const settle = (name: string): string | null => {
    const reason = check(name);
    if (reason !== null) process.stderr.write(`  ${reason}\n`);
    return reason === null ? name : null;
  };
  if (!promptEditable()) {
    for (;;) {
      process.stderr.write(`${question.replace(/: $/, "")} [${fallback}]: `);
      const line = await read(READ_LINE);
      if (line === null) { process.stderr.write("\n"); return null; }
      const text = line.toString("utf8");
      if (text.includes("\x1b")) return null;
      const name = settle(text === "" ? fallback : text);
      if (name !== null) return name;
    }
  }
  const grey = promptGreyCapable();
  const editor = grey ? new NameEditor(prefix, suffix) : new NameEditor("", "");
  const plainHeader = `${question.replace(/: $/, "")} [${fallback}]: `;
  // Set when the last chunk held a key the handle charset refuses: the bell rang as it
  // was refused, and the redraw names the allowed set on a line of its own.
  let refused = false;
  // Plain: the prompt line is written once, again after a refusal, never redrawn in place.
  let header = true;
  for (;;) {
    if (grey) {
      const ghost = editor.placeholder;
      // The hint is its own line above the editor, so it never fights the editor row for width.
      process.stderr.write(`${refused ? `\r\x1b[2K  ${NAME_HINT}\n` : ""}\r\x1b[2K${question}${editor.text}${ghost ? `${GREY}${ghost}${UNGREY}\x1b[${ghost.length}D` : ""}`);
    } else if (header || refused) {
      process.stderr.write(`${refused && !header ? `\n  ${NAME_HINT}\n` : ""}${plainHeader}${editor.text}`);
    }
    refused = false;
    header = false;
    const chunk = await read(READ_CHUNK);
    if (chunk === null || chunk.length === 0) { process.stderr.write("\n"); return null; }
    let text = chunk.toString("utf8");
    // A sequence split across reads takes the bytes that follow within DRAIN_KEY's 0.1 s.
    const drain = async (): Promise<boolean> => {
      const more = await read(DRAIN_CHUNK);
      if (!more?.length) return false;
      text += more.toString("latin1");
      return true;
    };
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char === "\x1b") {
        // A CSI or SS3 sequence (arrows, function keys) is skipped whole; any other Esc quits.
        if (i + 1 === text.length && !await drain()) { process.stderr.write("\n"); return null; }
        if (text[i + 1] !== "[" && text[i + 1] !== "O") { process.stderr.write("\n"); return null; }
        // The sequence ends at its final byte, 0x40-0x7E.
        let end = i + 2;
        const final = () => text[end]! >= "@" && text[end]! <= "~";
        while ((end < text.length || await drain()) && !final()) end++;
        i = end;
        continue;
      }
      if (char === "\r" || char === "\n") {
        // A burst that lost keys to the filter is shown the filtered line and the hint before it is accepted.
        if (refused) break;
        process.stderr.write("\n");
        const name = settle(grey ? editor.value() : editor.text || fallback);
        if (name !== null) return name;
        // Plain asks afresh (what is typed is the whole name); the colour editor keeps its line to fix.
        if (!grey) editor.text = "";
        header = true;
        break;
      }
      if (char === "\x04" && !grey) { process.stderr.write("\n"); return null; }
      if (char === "\x7f" || char === "\b") {
        if (grey) editor.backspace();
        else if (editor.text) { editor.backspace(); process.stderr.write("\b \b"); }
      } else if (char >= " ") {
        if (editor.type(char)) { refused = true; process.stderr.write("\x07"); }
        else if (!grey) process.stderr.write(char);
      }
    }
  }
}

// Ending the stream is what waits out Bun's buffered pipe writes; an empty
// write's callback does not (a 2 MiB pipe write lost all but 64 KiB).
const drained = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise(resolve => { try { stream.end(() => resolve()); } catch { resolve(); } });

/**
 * End the process the way the Python launcher did: leave the terminal mode as
 * it is. Bun writes back every std-fd tty's startup termios at exit, which
 * would clobber a mode the foreground owner set while this process lived (a
 * background resume, or one whose stdin is piped under a TUI). Both streams
 * are ended and flushed first; `_exit` then skips only runtime exit work, and
 * these entries register no exit handlers.
 */
export async function exitKeepingTerminal(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  let libc;
  // Without a loadable libc the code still wins; only the mode guarantee is lost.
  try { libc = openLibc({ _exit: { args: ["i32"], returns: "void" } }); } catch { process.exit(code); }
  libc.symbols._exit(code);
  throw new Error("_exit returned");
}
