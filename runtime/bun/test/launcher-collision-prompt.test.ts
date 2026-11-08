// The collision menu's terminal prompts (tap-ibmoe): the [n]/[f] name editor and
// the chooser's unavailable [f] row, driven on a private pseudo-terminal. Every
// case reads `stty -g` before and after the prompt: the editor never holds a
// terminal mode itself, so each exit path (accept, Esc, Ctrl-C, a throwing
// check) must leave the caller's terminal exactly as it found it.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { NameEditor } from "../src/launcher/prompt";

const entry = join(import.meta.dir, "support/prompt-name-entry.ts");
const QUESTION = "Enter a name for the new session: ";
// Darwin's line discipline sets PENDIN (lflag 0x20000000, "retype pending
// input") itself when a mode switch finds queued input; it is kernel status,
// not a mode any prompt chose, so the comparison masks it (as attach-resume-native does).
const settled = (stty: string | null) => stty?.replace(/lflag=([0-9a-f]+)/, (_m, hex: string) => `lflag=${(BigInt(`0x${hex}`) & ~0x20000000n).toString(16)}`);
type Shown = { before: string | null; after: string | null; exit: number | null; signal: number | null; output: string };

function onPty(keys: string[], args: string[], extra: NodeJS.ProcessEnv): Shown {
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", ...extra })
    .filter(([, value]) => value !== undefined));
  const r = spawnSync("python3", [join(import.meta.dir, "support/pty-prompt.py"), JSON.stringify(keys), process.execPath, entry, ...args],
    { env, encoding: "utf8", timeout: 90_000 });
  const shown = JSON.parse(r.stdout) as Shown;
  expect(shown.before).toBeTruthy();
  // The caller's terminal mode survives every exit path.
  expect(settled(shown.after)).toBe(settled(shown.before));
  return shown;
}
const GREY = { TERM: "xterm-256color", PTY_PROMPT_MARKER: QUESTION };
const editName = (keys: string[], extra: NodeJS.ProcessEnv = GREY) => onPty(keys, ["name", QUESTION, "opus-", "2"], extra);
// Each PTY session takes about a second; Linux runs give a test 5 s by default.
const PTY_TIMEOUT = 30_000;
const named = (shown: Shown) => /NAME (".*")/.exec(shown.output)?.[1];

test("NameEditor: typing replaces the placeholder; backspace edits into the prefix", () => {
  const typed = new NameEditor("opus-", "2");
  expect(typed.value()).toBe("opus-2");
  typed.type("7");
  expect(typed.value()).toBe("opus-7");
  const edited = new NameEditor("opus-", "fork");
  edited.backspace();
  expect([edited.value(), edited.placeholder]).toEqual(["opus", ""]);
  edited.backspace();
  edited.type("x");
  expect(edited.value()).toBe("opux");
  const cleared = new NameEditor("ab", "c");
  for (let i = 0; i < 4; i++) cleared.backspace();
  expect(cleared.value()).toBe("");
});

test("NameEditor: a character a handle cannot hold never enters the line", () => {
  const editor = new NameEditor("opus-", "2");
  expect(editor.type(" ")).toBe(" ");
  expect([editor.value(), editor.placeholder]).toEqual(["opus-2", "2"]);
  expect(editor.type("my seat/x")).toBe(" /");
  expect(editor.value()).toBe("opus-myseatx");
  // A handle begins with a letter or digit; "." "_" "-" are allowed after that.
  const bare = new NameEditor("", "x");
  expect(bare.type("-.a_b.c-")).toBe("-.");
  expect(bare.value()).toBe("a_b.c-");
  expect(new NameEditor("", "").type("é\x07")).toBe("é\x07");
});

test("name prompt: Enter accepts the grey default", () => {
  const shown = editName(["\r"]);
  expect(shown.exit).toBe(0);
  expect(named(shown)).toBe('"opus-2"');
  expect(shown.output).toContain(`${QUESTION}opus-\x1b[90m2\x1b[39m\x1b[1D`);
}, PTY_TIMEOUT);

test("name prompt: typing replaces the suffix; backspace reaches into the prefix", () => {
  expect(named(editName(["7", "\r"]))).toBe('"opus-7"');
  expect(named(editName(["\x7f", "\x7f", "x", "\r"]))).toBe('"opux"');
}, PTY_TIMEOUT);

test("name prompt: an arrow key's escape sequence is ignored, not a quit", () => {
  expect(named(editName(["\x1b[A", "\r"]))).toBe('"opus-2"');
}, PTY_TIMEOUT);

test("NameEditor: deleteWord takes one word and its trailing separators; clear empties the line", () => {
  const worded = new NameEditor("opus-fork-", "2");
  worded.deleteWord();
  expect([worded.text, worded.placeholder]).toEqual(["opus-", ""]);
  worded.deleteWord();
  expect(worded.text).toBe("");
  worded.deleteWord();
  expect(worded.text).toBe("");
  const cleared = new NameEditor("opus-", "2");
  cleared.clear();
  expect(cleared.value()).toBe("");
});

test("name prompt: Option-Delete and Command-Delete edit the name instead of quitting", () => {
  for (const optionDelete of ["\x1b\x7f", "\x1b\b", "\x17"]) expect(named(editName(["my-seat", optionDelete, "x\r"]))).toBe('"opus-my-x"');
  // On the untouched default, the chord removes the grey suffix and the prefix word.
  expect(named(editName(["\x1b\x7fother\r"]))).toBe('"other"');
  expect(named(editName(["my-seat\x15other\r"]))).toBe('"other"');
}, PTY_TIMEOUT);

test("name prompt: NO_COLOR erases everything a delete chord removed", () => {
  const edited = editName(["my-seat\x1b\x7fx\r"], NO_COLOR);
  expect(named(edited)).toBe('"my-x"');
  expect(edited.output.split("\b \b").length - 1).toBe(4);
  const cleared = editName(["ab\x15c\r"], NO_COLOR);
  expect(named(cleared)).toBe('"c"');
  expect(cleared.output.split("\b \b").length - 1).toBe(2);
}, PTY_TIMEOUT);

test("name prompt: Esc inside a typed burst quits; whole CSI and SS3 sequences are bypassed", () => {
  const quit = editName(["7\x1b\r"]);
  expect([quit.exit, named(quit)]).toEqual([2, undefined]);
  expect(named(editName(["\x1b[1;5Ax\x1bOB\r"]))).toBe('"opus-x"');
}, PTY_TIMEOUT);

test("name prompt: a refused name asks again with its reason", () => {
  const shown = editName(["\x7f\x7f\x7f\x7f\x7ftaken\r", "\x7f\x7f\x7f\x7f\x7fok\r"]);
  expect(shown.exit).toBe(0);
  expect(shown.output).toContain("  'taken' is taken");
  expect(named(shown)).toBe('"ok"');
}, PTY_TIMEOUT);

test("name prompt: Esc quits with nothing chosen", () => {
  const shown = editName(["\x1b"]);
  expect(shown.exit).toBe(2);
  expect(named(shown)).toBeUndefined();
}, PTY_TIMEOUT);

test("name prompt: Ctrl-C interrupts after the terminal is restored", () => {
  const shown = editName(["x", "\x03"]);
  expect(shown.signal === 2 || shown.exit === 130).toBe(true);
  expect(named(shown)).toBeUndefined();
}, PTY_TIMEOUT);

for (const [name, number, code] of [["TERM", 15, 143], ["INT", 2, 130]] as const) {
  test(`name prompt: SIG${name} to the process alone restores the terminal, then ends it`, () => {
    // No key is sent after the first frame: the read is blocked when the signal lands.
    const shown = onPty([], ["name", QUESTION, "opus-", "2"], { ...GREY, SIGNAL_AFTER_MS: "1500", SIGNAL_NAME: name });
    expect(shown.signal === number || shown.exit === code).toBe(true);
    expect(named(shown)).toBeUndefined();
  }, PTY_TIMEOUT);
}

// Ctrl-Z during the name reader (tap-wj35h): stopping would leave -icanon -echo set for the
// user's shell, so suspend cancels like Esc: the terminal is restored and the prompt quits.
// Both the keyboard key and a SIGTSTP sent to the process alone, with the colour editor and the plain line.
for (const [title, extra] of [["colour", GREY], ["plain", { TERM: "dumb", PTY_PROMPT_MARKER: "]: " }]] as const) {
  test(`name prompt: Ctrl-Z cancels and restores the terminal (${title})`, () => {
    const shown = editName(["\x1a"], extra);
    expect([shown.exit, named(shown)]).toEqual([2, undefined]);
  }, PTY_TIMEOUT);
  test(`name prompt: SIGTSTP to the process alone cancels and restores the terminal (${title})`, () => {
    const shown = onPty([], ["name", QUESTION, "opus-", "2"], { ...extra, SIGNAL_AFTER_MS: "1500", SIGNAL_NAME: "TSTP" });
    expect([shown.exit, named(shown)]).toEqual([2, undefined]);
  }, PTY_TIMEOUT);
}

test("name prompt: a check that throws leaves the terminal restored", () => {
  const shown = editName(["\x7f\x7f\x7f\x7f\x7fboom\r"]);
  expect(shown.exit).not.toBe(0);
  expect(shown.output).toContain("check exploded");
}, PTY_TIMEOUT);

for (const [title, extra] of [["NO_COLOR", { NO_COLOR: "1", TERM: "xterm-256color" }], ["TERM=dumb", { TERM: "dumb" }],
  ["no TERM", {}]] as const) {
  const plain = { ...extra, PTY_PROMPT_MARKER: "]: " };
  test(`name prompt: ${title} asks plainly with the default in brackets`, () => {
    const accepted = editName(["\r"], plain);
    expect(named(accepted)).toBe('"opus-2"');
    expect(accepted.output).toContain("Enter a name for the new session [opus-2]: ");
    expect(accepted.output).not.toContain("\x1b[");
  }, PTY_TIMEOUT);
  test(`name prompt: ${title} takes a typed line as the whole name and re-asks a refused one`, () => {
    const retried = editName(["taken\r", "ok\r"], plain);
    expect(retried.output).toContain("  'taken' is taken");
    expect(named(retried)).toBe('"ok"');
  }, PTY_TIMEOUT);
  test(`name prompt: ${title} quits on Ctrl-C or Ctrl-D`, () => {
    const interrupted = editName(["\x03"], plain);
    expect(interrupted.signal === 2 || interrupted.exit === 130).toBe(true);
    const ended = editName(["\x04"], plain);
    expect([ended.exit, named(ended)]).toEqual([2, undefined]);
  }, PTY_TIMEOUT);
}

// NO_COLOR is about colour, not input (tap-tl6rh): the editor still reads key by key and filters,
// with no escape sequence at all. TERM=dumb keeps the cooked line, where check() is the filter.
const NO_COLOR = { NO_COLOR: "1", TERM: "xterm-256color", PTY_PROMPT_MARKER: "]: " };
test("name prompt: NO_COLOR refuses a space and slash like the colour editor, with no escapes", () => {
  const shown = editName(["my seat/x", "\r"], NO_COLOR);
  expect(shown.exit).toBe(0);
  expect(named(shown)).toBe('"myseatx"');
  expect(shown.output).not.toContain("\x1b");
  expect(shown.output).not.toMatch(/my |t\/x/);
  expect(shown.output).toContain("\x07");
  expect(shown.output).toContain("letters, digits, . _ -");
  // A pasted burst that ends in Enter is filtered the same way.
  // The burst's Enter does not accept a line that lost keys: it shows the line and hint, and waits for another.
  const burst = editName(["my seat/x\r", "\r"], NO_COLOR);
  expect(named(burst)).toBe('"myseatx"');
  expect(burst.output).toContain("(first: letter or digit)");
}, PTY_TIMEOUT);

test("name prompt: NO_COLOR edits plainly: Backspace undoes an echoed key; a refused key keeps the default", () => {
  const edited = editName(["ab\x7fc\r"], NO_COLOR);
  expect(named(edited)).toBe('"ac"');
  expect(edited.output).toContain("\b \b");
  expect(edited.output).not.toContain("\x1b");
  expect(named(editName([" ", "\r"], NO_COLOR))).toBe('"opus-2"');
}, PTY_TIMEOUT);

test("name prompt: TERM=dumb asks again with the allowed characters when the cooked line is refused", () => {
  const shown = editName(["my seat\r", "ok\r"], { TERM: "dumb", PTY_PROMPT_MARKER: "]: " });
  expect(shown.output).toContain("  'my seat' must use letters, digits, '.', '_' or '-'");
  expect(named(shown)).toBe('"ok"');
  expect(shown.output).not.toContain("\x1b[");
}, PTY_TIMEOUT);

for (const [title, extra, handle] of [["colour", GREY, '"opus-myseatx"'], ["NO_COLOR", NO_COLOR, '"myseatx"']] as const) {
  test(`name prompt under the launch spinner (${title}): it spins before the prompt, then no frame is written after it draws, whatever ends it`, () => {
    const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    for (const [keys, outcome] of [[["my seat/x", "\r"], "named"], [["\x1b"], "quit"], [["\x03"], "interrupt"]] as const) {
      const shown = onPty([...keys], ["name-under-progress", QUESTION, "opus-", "2"], extra);
      if (outcome === "named") expect([shown.exit, named(shown)]).toEqual([0, handle]);
      else if (outcome === "quit") expect(shown.exit).toBe(2);
      else {
        // Ctrl-C dies by SIGINT (the leader reports it as 130), never as the read's own error (tap-okayq).
        expect(shown.signal === 2 || shown.exit === 130).toBe(true);
        expect(shown.output).not.toContain("requires a terminal");
      }
      const drawn = shown.output.indexOf("Enter a name for the new session");
      expect(drawn).toBeGreaterThanOrEqual(0);
      // The measuring stick: the spinner did animate before the prompt took the row.
      expect(shown.output.slice(0, drawn)).toMatch(spinner);
      expect(shown.output.slice(drawn)).not.toMatch(spinner);
    }
  }, PTY_TIMEOUT);
}

test("chooser under the launch spinner: Ctrl-C dies by SIGINT with the terminal restored (tap-okayq)", () => {
  const shown = onPty(["\x03"], ["choice-under-progress"], { TERM: "xterm-256color", PTY_PROMPT_MARKER: "(Esc quits): " });
  expect(shown.signal === 2 || shown.exit === 130).toBe(true);
  expect(shown.output).not.toContain("CHOICE");
  expect(shown.output).not.toContain("requires a terminal");
}, PTY_TIMEOUT);

test("chooser: an unavailable row is greyed, and its key says why before the menu returns", () => {
  const shown = onPty(["f", "q"], ["choice"], { TERM: "xterm-256color", PTY_PROMPT_MARKER: "(Esc quits): " });
  expect(shown.output).toContain("\x1b[90m  [f] fork    Harness cannot fork\x1b[39m");
  expect(shown.output).toContain("tap session: fork is unavailable: Harness cannot fork");
  expect(shown.output.split("Choice [r] (Esc quits): ").length).toBe(3);
  expect(shown.output).toContain("CHOICE q");
}, PTY_TIMEOUT);

test("chooser: a narrow plain menu still marks the unavailable row", () => {
  const shown = onPty(["q"], ["choice"], { TERM: "dumb", COLUMNS: "30", PTY_PROMPT_MARKER: "(Esc quits): " });
  expect(shown.output).toContain("  [f] fork (unavailable: Harness cannot fork)\r\n");
  expect(shown.output).toContain("  [n] new\r\n");
}, PTY_TIMEOUT);

test("chooser: a narrow colour menu greys the unavailable row and keeps its reason", () => {
  const shown = onPty(["q"], ["choice"], { TERM: "xterm-256color", COLUMNS: "30", PTY_PROMPT_MARKER: "(Esc quits): " });
  expect(shown.output).toContain("\x1b[90m  [f] fork (unavailable: Harness cannot fork)\x1b[39m\r\n");
}, PTY_TIMEOUT);

test("chooser: without colour the unavailable row states its reason as text", () => {
  const shown = onPty(["f", "x", "q"], ["choice"], { TERM: "dumb", PTY_PROMPT_MARKER: "(Esc quits): " });
  expect(shown.output).toContain("  [f] fork    (unavailable: Harness cannot fork)");
  expect(shown.output).not.toContain("\x1b[");
  // The key list names only the keys that act.
  expect(shown.output).toContain("tap session: choose r, n, k, or q");
  expect(shown.output).toContain("CHOICE q");
}, PTY_TIMEOUT);

test("name prompt: a pasted space and slash never enter the line; the bell and hint answer them", () => {
  const shown = editName(["my seat/x", "\r"]);
  expect(shown.exit).toBe(0);
  expect(named(shown)).toBe('"opus-myseatx"');
  expect(shown.output).not.toMatch(/my |t\/x/);
  expect(shown.output).toContain("\x07");
  expect(shown.output).toContain("letters, digits, . _ - (first: letter or digit)");
  // A paste that ends in Enter is not accepted until the filtered line and hint have been shown.
  const burst = editName(["my seat/x\r", "\r"]);
  expect(named(burst)).toBe('"opus-myseatx"');
  expect(burst.output.indexOf("letters, digits")).toBeGreaterThan(-1);
  expect(burst.output.indexOf("letters, digits")).toBeLessThan(burst.output.indexOf("NAME "));
}, PTY_TIMEOUT);

test("name prompt: a refused key leaves the grey default; an accepted line has no bell or hint", () => {
  const refused = editName([" ", "/", "\r"]);
  expect(named(refused)).toBe('"opus-2"');
  const clean = editName(["7", "\r"]);
  expect(clean.output).not.toContain("\x07");
  expect(clean.output).not.toContain("letters, digits");
}, PTY_TIMEOUT);
