// digest-window.ts: the delivery-window override writer and the window
// readers, pinned with explicit bytes. Each fidelity arm names the Python
// behavior it reproduces; the rule-13 differential under tmp/ is the oracle
// that decided these bytes, this file is what keeps them.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePathLock } from "../src/panelock";
import {
  DigestWindowError, configuredWindow, deliveryWindowSeconds, driverConfigPath, editConfig, effectiveWindows,
  parseToml, pySplitLinesKeepEnds, pyStr, updateConfig, windowSeconds,
} from "../src/digest-window";
import { jsonDumpBytes } from "../src/spool-publication";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function scratch(): string { const r = fs.mkdtempSync(join(tmpdir(), "dw-")); roots.push(r); return r; }
function env(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "cfg"), ...extra };
}
function cfgOf(root: string): string { return join(root, "cfg", "tap", "config.toml"); }
function seed(root: string, text: string, mode = 0o600): string {
  const p = cfgOf(root);
  fs.mkdirSync(join(root, "cfg", "tap"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, text); fs.chmodSync(p, mode);
  return p;
}
const SEAT = "tap/peer";

// --- validate ---------------------------------------------------------------
test("windowSeconds: off is null; ASCII digits within int32 are the integer; everything else is the incumbent's one message", () => {
  expect(windowSeconds("off")).toBeNull();
  expect(windowSeconds("0")).toBe(0);
  expect(windowSeconds("007")).toBe(7);
  expect(windowSeconds("2147483647")).toBe(2147483647);
  const message = "window must be off or integer seconds from 0 to 2147483647";
  for (const bad of ["2147483648", "99999999999999999999", "-1", "1.5", "", " 10", "10 ", "1e3", "１０", "٣", "OFF", "off "]) {
    expect(() => windowSeconds(bad)).toThrow(message);
  }
});

// --- Python boundaries ------------------------------------------------------
test("pySplitLinesKeepEnds is str.splitlines(keepends=True): every boundary Python recognizes, none JavaScript adds", () => {
  expect(pySplitLinesKeepEnds("a\nb\r\nc\rd\x1ce f\x85g")).toEqual(["a\n", "b\r\n", "c\r", "d\x1c", "e ", "f\x85", "g"]);
  expect(pySplitLinesKeepEnds("")).toEqual([]);
  expect(pySplitLinesKeepEnds("x\n")).toEqual(["x\n"]);
  // A BOM and an NBSP are not line boundaries to either language.
  expect(pySplitLinesKeepEnds("﻿a b")).toEqual(["﻿a b"]);
});

test("parseToml refuses a leading BOM as tomllib did, where Bun's parser would have accepted it", () => {
  expect(() => parseToml("﻿a = 1\n")).toThrow("Invalid statement (at line 1, column 1)");
  expect(parseToml("a = 1\n")).toEqual({ a: 1 });
  expect(() => parseToml("= = =\n")).toThrow(DigestWindowError);
});

test("pyStr prints what Python's str() printed for every TOML type the window keys can hold", () => {
  expect(pyStr(600)).toBe("600");
  expect(pyStr(600.5)).toBe("600.5");
  // Python's float repr, not JavaScript's: the exponent forms differ.
  expect(pyStr(1e20)).toBe("1e+20");
  expect(pyStr(1e-7)).toBe("1e-07");
  expect(pyStr(true)).toBe("True");
  expect(pyStr("x")).toBe("x");
  expect(pyStr(null)).toBe("None");
  expect(pyStr([1, "a"])).toBe("[1, 'a']");
  expect(pyStr({ a: 1 })).toBe("{'a': 1}");
  const doc = parseToml("i = 1979-05-27T07:32:00Z\nf = 1979-05-27T07:32:00.25Z\nl = 1979-05-27T07:32:00\nd = 1979-05-27\nt = 07:32:00.5\n");
  expect(pyStr(doc.i)).toBe("1979-05-27 07:32:00+00:00");
  expect(pyStr(doc.f)).toBe("1979-05-27 07:32:00.250000+00:00");
  expect(pyStr(doc.l)).toBe("1979-05-27 07:32:00");
  expect(pyStr(doc.d)).toBe("1979-05-27");
  expect(pyStr(doc.t)).toBe("07:32:00.500000");
});

// --- configured_window ------------------------------------------------------
const DOC = parseToml([
  "[delivery]", "now_window_seconds = 30", "polite_window_seconds = 90", "",
  '[delivery.overrides."tap/peer"]', "now_window_seconds = 600", "digest_include_asks = true", "",
  '[delivery.overrides."peer"]', "now_window_seconds = 45", "",
  '[delivery.overrides."tap/quiet"]', "now_window_seconds = 700", "digest_include_asks = false", "",
  '[delivery.overrides."tap/zero"]', "now_window_seconds = 0", "",
  '[delivery.overrides."quiet"]', "now_window_seconds = 46", "",
].join("\n") + "\n");

test("configuredWindow: qualified seat, then bare handle only for the acting team, then the [delivery] table; presence, not truthiness", () => {
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "peer", "tap", "expected")).toBe(600);
  expect(configuredWindow(DOC, "now_window_seconds", "", "peer", "", "expected")).toBe(45);
  expect(configuredWindow(DOC, "now_window_seconds", "other", "peer", "other", "expected")).toBe(45);
  expect(configuredWindow(DOC, "now_window_seconds", "other", "peer", "x", "expected")).toBe(30);
  expect(configuredWindow(DOC, "polite_window_seconds", "tap", "peer", "tap", "expected")).toBe(90);
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "nobody", "tap", "expected")).toBe(30);
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "", "tap", "expected")).toBe(30);
  // `key in seat`: a present 0 is the answer, not a fall-through.
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "zero", "tap", "expected")).toBe(0);
  // include-asks false gates `now_window_seconds` for an expected reply only, and BREAKS: the bare
  // handle "quiet" (46) is NOT consulted, the [delivery] table is the answer.
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "quiet", "tap", "expected")).toBe(30);
  expect(configuredWindow(DOC, "now_window_seconds", "tap", "quiet", "tap", "settle-only")).toBe(700);
  expect(configuredWindow({}, "now_window_seconds", "tap", "peer", "tap", "expected")).toBeNull();
  expect(configuredWindow({ delivery: "x" }, "now_window_seconds", "tap", "peer", "tap", "expected")).toBeNull();
  expect(configuredWindow(parseToml("delivery = 1979-05-27\n"), "now_window_seconds", "tap", "peer", "tap", "expected")).toBeNull();
});

// --- effective_windows / window-seconds ---------------------------------------
test("effectiveWindows and deliveryWindowSeconds: the config, the env seam, the built-ins, and Python's digit test on str(value)", () => {
  const root = scratch();
  seed(root, [
    "[delivery]", "now_window_seconds = 30", "polite_window_seconds = 90",
    '[delivery.overrides."tap/peer"]', "now_window_seconds = 600", "digest_include_asks = false",
    '[delivery.overrides."tap/str"]', 'now_window_seconds = "0070"',
    '[delivery.overrides."tap/flt"]', "now_window_seconds = 600.5",
    '[delivery.overrides."tap/bool"]', "now_window_seconds = true",
  ].join("\n") + "\n");
  expect(effectiveWindows("tap", "peer", env(root))).toEqual({ digest_window_seconds: 600, ask_window_seconds: 30 });
  expect(effectiveWindows("tap", "str", env(root))).toEqual({ digest_window_seconds: 70, ask_window_seconds: 70 });
  expect(effectiveWindows("tap", "flt", env(root))).toEqual({ digest_window_seconds: 10, ask_window_seconds: 10 });
  // CONTRACT § window: a WHOLE-valued float is its integer (declared delta 1), zero included — `0.0` is a
  // legal zero window, not the built-in; a fractional float (above) is the built-in.
  fs.writeFileSync(cfgOf(root), "[delivery]\nnow_window_seconds = 0.0\npolite_window_seconds = 600.0\n");
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", env(root))).toBe("0");
  expect(deliveryWindowSeconds("polite", "tap", "peer", "expected", "tap", env(root))).toBe("600");
  expect(effectiveWindows("tap", "peer", env(root))).toEqual({ digest_window_seconds: 0, ask_window_seconds: 0 });
  seed(root, [
    "[delivery]", "now_window_seconds = 30", "polite_window_seconds = 90",
    '[delivery.overrides."tap/peer"]', "now_window_seconds = 600", "digest_include_asks = false",
    '[delivery.overrides."tap/str"]', 'now_window_seconds = "0070"',
    '[delivery.overrides."tap/flt"]', "now_window_seconds = 600.5",
    '[delivery.overrides."tap/bool"]', "now_window_seconds = true",
  ].join("\n") + "\n");
  expect(effectiveWindows("tap", "bool", env(root))).toEqual({ digest_window_seconds: 10, ask_window_seconds: 10 });
  expect(effectiveWindows("tap", "peer", env(root, { TAP_AUTOSETTLE_HOLD_SECONDS: "7" }))).toEqual({ digest_window_seconds: 7, ask_window_seconds: 7 });
  expect(effectiveWindows("tap", "peer", env(root, { TAP_AUTOSETTLE_HOLD_SECONDS: "7x" }))).toEqual({ digest_window_seconds: 600, ask_window_seconds: 30 });
  expect(effectiveWindows("tap", "peer", env(root, { XDG_CONFIG_HOME: "relative" }))).toEqual({ digest_window_seconds: 10, ask_window_seconds: 10 });
  // A SET but relative XDG_CONFIG_HOME is no config at all — never a fallback
  // to a populated $HOME/.config; an unset/empty XDG is the ordinary HOME fallback.
  fs.mkdirSync(join(root, ".config", "tap"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(root, ".config", "tap", "config.toml"), "[delivery]\nnow_window_seconds = 777\n"); fs.chmodSync(join(root, ".config", "tap", "config.toml"), 0o600);
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: "relative" })).toBe("10");
  expect(effectiveWindows("tap", "peer", { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: "relative" })).toEqual({ digest_window_seconds: 10, ask_window_seconds: 10 });
  expect(driverConfigPath({ HOME: root, XDG_CONFIG_HOME: "relative" })).toBeNull();
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root })).toBe("777");
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: "" })).toBe("777");
  expect(driverConfigPath({ XDG_CONFIG_HOME: "relative" })).toBeNull();
  expect(driverConfigPath({})).toBeNull();
  // F4 (astra): a quoted digit string or an env seam past 2^53 stays EXACT — the incumbent
  // printed digits, never a rounded number or exponent form.
  fs.writeFileSync(join(root, ".config", "tap", "config.toml"), '[delivery]\nnow_window_seconds = "9007199254740993"\n[delivery.overrides."tap/huge"]\nnow_window_seconds = "1000000000000000000000"\n');
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root })).toBe("9007199254740993");
  expect(deliveryWindowSeconds("standard", "tap", "huge", "expected", "tap", { PATH: process.env.PATH, HOME: root })).toBe("1000000000000000000000");
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root, TAP_AUTOSETTLE_HOLD_SECONDS: "9007199254740993" })).toBe("9007199254740993");
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", { PATH: process.env.PATH, HOME: root, TAP_AUTOSETTLE_HOLD_SECONDS: "0009007199254740993" })).toBe("9007199254740993");
  const huge = effectiveWindows("tap", "huge", { PATH: process.env.PATH, HOME: root });
  expect(jsonDumpBytes(huge)).toBe('{"digest_window_seconds": 1000000000000000000000, "ask_window_seconds": 1000000000000000000000}');
  expect(jsonDumpBytes(effectiveWindows("tap", "peer", { PATH: process.env.PATH, HOME: root, TAP_AUTOSETTLE_HOLD_SECONDS: "9007199254740993" }))).toBe('{"digest_window_seconds": 9007199254740993, "ask_window_seconds": 9007199254740993}');

  expect(deliveryWindowSeconds("standard", "tap", "peer", "settle-only", "tap", env(root))).toBe("600");
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", env(root))).toBe("30");
  expect(deliveryWindowSeconds("polite", "tap", "peer", "expected", "tap", env(root))).toBe("90");
  expect(deliveryWindowSeconds("standard", "tap", "str", "expected", "tap", env(root))).toBe("70");
  expect(deliveryWindowSeconds("urgent", "tap", "peer", "expected", "tap", env(root, { TAP_AUTOSETTLE_HOLD_SECONDS: "0" }))).toBe("0");
  expect(deliveryWindowSeconds("polite", "tap", "peer", "expected", "tap", env(root, { TAP_AUTOSETTLE_HOLD_SECONDS: "7" }))).toBe("90");
  fs.chmodSync(cfgOf(root), 0o664);
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", env(root))).toBe("10");
  expect(deliveryWindowSeconds("polite", "tap", "peer", "expected", "tap", env(root))).toBe("60");
  fs.rmSync(cfgOf(root));
  expect(deliveryWindowSeconds("standard", "tap", "peer", "expected", "tap", env(root))).toBe("10");
  expect(effectiveWindows("tap", "peer", env(root))).toEqual({ digest_window_seconds: 10, ask_window_seconds: 10 });
});

// --- edit: explicit bytes -----------------------------------------------------
test("editConfig appends a new seat table after rstrip + blank line, with json.dumps' escaping of the seat name", () => {
  expect(editConfig("", SEAT, 600, true)).toBe('\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 600\ndigest_include_asks = true\n');
  expect(editConfig("[delivery]\nnow_window_seconds = 30   \n\n\n   ", SEAT, 600, false))
    .toBe('[delivery]\nnow_window_seconds = 30\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 600\ndigest_include_asks = false\n');
  expect(editConfig("x = 1\n", "tëam/hændle", 5, true)).toBe('x = 1\n\n[delivery.overrides."t\\u00ebam/h\\u00e6ndle"]\nnow_window_seconds = 5\ndigest_include_asks = true\n');
  expect(editConfig("x = 1\n", 't/"q\\b', 5, true)).toBe('x = 1\n\n[delivery.overrides."t/\\"q\\\\b"]\nnow_window_seconds = 5\ndigest_include_asks = true\n');
  // off with no table: an empty header is still appended (the incumbent's shape).
  expect(editConfig("x = 1\n", SEAT, null, false)).toBe('x = 1\n\n[delivery.overrides."tap/peer"]\n');
});

test("editConfig splices an existing seat table in place: the two keys replaced at the top, other lines and every other byte kept", () => {
  const raw = '# c\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 5 # old\nnote = "keep"\n"digest_include_asks" = true\n\n[other]\nx = 1\r\n';
  expect(editConfig(raw, SEAT, 600, false))
    .toBe('# c\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 600\ndigest_include_asks = false\nnote = "keep"\n\n[other]\nx = 1\r\n');
  expect(editConfig(raw, SEAT, null, false)).toBe('# c\n[delivery.overrides."tap/peer"]\nnote = "keep"\n\n[other]\nx = 1\r\n');
  // Last table in the file: the splice runs to the end.
  expect(editConfig('[delivery.overrides."tap/peer"]\nnow_window_seconds = 5', SEAT, 7, true))
    .toBe('[delivery.overrides."tap/peer"]\nnow_window_seconds = 7\ndigest_include_asks = true\n');
});

test("editConfig refuses every layout the splice cannot see, with the incumbent's messages", () => {
  const layout = 'cannot safely edit this TOML layout; use a dedicated [delivery.overrides."team/handle"] table';
  expect(() => editConfig('[delivery]\noverrides = { "tap/peer" = { now_window_seconds = 5 } }\n', SEAT, 6, false)).toThrow(DigestWindowError);
  expect(() => editConfig('[a]\ns = """\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 5\n"""\n', SEAT, 6, false)).toThrow(layout);
  expect(() => editConfig('[delivery.overrides]\n"tap/peer" = 5\n', SEAT, 6, false)).toThrow("recipient override must be a TOML table");
  // A datetime is an OBJECT to JavaScript and not a dict to Python: the same refusal, not a splice.
  expect(() => editConfig('[delivery.overrides]\n"tap/peer" = 1979-05-27\n', SEAT, 6, false)).toThrow("recipient override must be a TOML table");
  expect(() => editConfig('delivery = "x"\n', SEAT, 6, false)).toThrow("has no attribute 'setdefault'");
  expect(() => editConfig("﻿[delivery]\n", SEAT, 6, false)).toThrow("Invalid statement (at line 1, column 1)");
  expect(() => editConfig("= = =\n", SEAT, 6, false)).toThrow(DigestWindowError);
});

// --- update: the file, the lock, the change witness -----------------------------
test("updateConfig creates the directory 0700 and the file 0600, leaves no temp, and edits in place on a second call", () => {
  const root = scratch();
  const cfg = cfgOf(root);
  updateConfig(cfg, SEAT, 600, true, env(root));
  expect(fs.readFileSync(cfg, "utf8")).toBe('\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 600\ndigest_include_asks = true\n');
  expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
  expect(fs.statSync(join(root, "cfg", "tap")).mode & 0o777).toBe(0o700);
  updateConfig(cfg, SEAT, 7, false, env(root));
  expect(fs.readFileSync(cfg, "utf8")).toBe('\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 7\ndigest_include_asks = false\n');
  expect(fs.readdirSync(join(root, "cfg", "tap")).filter(n => n.startsWith(".digest-window-"))).toEqual([]);
});

test("F1: a DANGLING config symlink is followed, not replaced — the link stays and its target is created", () => {
  const root = scratch();
  fs.mkdirSync(join(root, "cfg", "tap"), { recursive: true, mode: 0o700 });
  const cfg = cfgOf(root);
  const target = join(root, "elsewhere", "real.toml");
  fs.symlinkSync(target, cfg);
  updateConfig(cfg, SEAT, 600, true, env(root));
  expect(fs.lstatSync(cfg).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(cfg)).toBe(target);
  expect(fs.readFileSync(target, "utf8")).toBe('\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 600\ndigest_include_asks = true\n');
  // A relative dangling link resolves against the link's directory, as os.path.realpath does.
  const rel = join(root, "cfg", "tap", "rel.toml");
  fs.symlinkSync("sub/target.toml", rel);
  updateConfig(rel, SEAT, 5, false, env(root));
  expect(fs.lstatSync(rel).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(join(root, "cfg", "tap", "sub", "target.toml"), "utf8")).toContain("now_window_seconds = 5");
  // And an existing-target symlink still edits the target in place.
  fs.writeFileSync(target, "[delivery]\nnow_window_seconds = 1\n");
  updateConfig(cfg, SEAT, 7, false, env(root));
  expect(fs.lstatSync(cfg).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe('[delivery]\nnow_window_seconds = 1\n\n[delivery.overrides."tap/peer"]\nnow_window_seconds = 7\ndigest_include_asks = false\n');
});

test("F2: a config LOCK path that is a symlink refuses (O_NOFOLLOW), config untouched; a real lock file still serializes", () => {
  const root = scratch();
  const cfg = seed(root, "[delivery]\nnow_window_seconds = 10\n");
  const victim = join(root, "victim");
  fs.writeFileSync(victim, "");
  fs.symlinkSync(victim, `${cfg}.lock`);
  expect(() => updateConfig(cfg, SEAT, 600, true, env(root))).toThrow("could not open config lock: ELOOP");
  expect(fs.readFileSync(cfg, "utf8")).toBe("[delivery]\nnow_window_seconds = 10\n");
  expect(fs.lstatSync(`${cfg}.lock`).isSymbolicLink()).toBe(true);
  fs.unlinkSync(`${cfg}.lock`);
  updateConfig(cfg, SEAT, 600, true, env(root));
  expect(fs.readFileSync(cfg, "utf8")).toContain("now_window_seconds = 600");
  expect(fs.lstatSync(`${cfg}.lock`).isFile()).toBe(true);
});

// An independent opener of the SAME inode, through its own path, reports whether flock(2) is held there.
function flockProbe(path: string): "HELD" | "GRANTED" {
  const prog = "import fcntl, sys\nf = open(sys.argv[1], 'w')\ntry:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    print('GRANTED')\nexcept BlockingIOError:\n    print('HELD')";
  return Bun.spawnSync(["python3", "-c", prog, path], { stdout: "pipe" }).stdout.toString().trim() as "HELD" | "GRANTED";
}

test("F2 seam: the held lock is on the descriptor the no-follow open produced — a path replaced AFTER the open cannot move it", () => {
  const root = scratch();
  const cfg = seed(root, "[delivery]\nnow_window_seconds = 10\n");
  const lockPath = `${cfg}.lock`;
  const alias = join(root, "alias-to-A");   // a hard link: the original inode A, reachable after the path is replaced
  const other = join(root, "B");            // a different inode
  fs.writeFileSync(other, "");
  // Observations are recorded on an object the hooks mutate: control-flow narrowing cannot
  // see that `updateConfig` invoked the callbacks (the frozen-lockfile typecheck reddened on
  // `let x: string | null = null` narrowed to `null` at the assertion).
  const seen: { replaced: boolean; held: string; other: string } = { replaced: false, held: "", other: "" };
  updateConfig(cfg, SEAT, 600, true, env(root), 5000, {
    // BETWEEN the no-follow open and the lock (a real window on Linux; none on Darwin, where
    // the open is the lock): replace the pathname with a symlink to B. A lock taken by
    // re-opening the PATH would now land on B; a lock on the DESCRIPTOR stays on A.
    afterOpen(path) {
      fs.linkSync(path, alias);
      fs.unlinkSync(path); fs.symlinkSync(other, path);
      seen.replaced = true;
    },
    afterLock() {
      seen.held = flockProbe(alias);    // A, through its hard link
      seen.other = flockProbe(other);   // B
    },
  });
  expect(seen.replaced).toBe(true);
  expect(seen.held).toBe("HELD");      // the update held A, the inode it opened …
  expect(seen.other).toBe("GRANTED");  // … and never B, the inode the pathname was swapped to
  expect(flockProbe(alias)).toBe("GRANTED"); // released with the descriptor
  expect(fs.readFileSync(cfg, "utf8")).toContain("now_window_seconds = 600");
  // A competitor holding A for real refuses the next update within the bound; B being free changes nothing.
  fs.unlinkSync(lockPath); fs.linkSync(alias, lockPath);
  const holder = Bun.spawn(["python3", "-c", "import fcntl, sys, time\nf = open(sys.argv[1], 'w')\nfcntl.flock(f, fcntl.LOCK_EX)\nprint('locked', flush=True)\ntime.sleep(30)", lockPath], { stdout: "pipe" });
  const reader = holder.stdout.getReader();
  try {
    // Wait for the holder's lock before racing it.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && flockProbe(alias) !== "HELD") Bun.sleepSync(20);
    expect(flockProbe(alias)).toBe("HELD");
    expect(() => updateConfig(cfg, SEAT, 7, true, env(root), 300)).toThrow("config lock busy; retry");
    expect(fs.readFileSync(cfg, "utf8")).toContain("now_window_seconds = 600");
  } finally { holder.kill(); void reader; }
});

test("updateConfig refuses a group-writable config through the secure read and leaves it untouched", () => {
  const root = scratch();
  const cfg = seed(root, "[delivery]\nnow_window_seconds = 10\n", 0o664);
  expect(() => updateConfig(cfg, SEAT, 600, true, env(root))).toThrow("group/world");
  expect(fs.readFileSync(cfg, "utf8")).toBe("[delivery]\nnow_window_seconds = 10\n");
});

test("updateConfig waits on the config lock and refuses when a holder outlives the bound, never writing", () => {
  const root = scratch();
  const cfg = seed(root, "[delivery]\nnow_window_seconds = 10\n");
  const held = acquirePathLock(`${cfg}.lock`, 5000, env(root));
  expect(held).not.toBeNull();
  try {
    expect(() => updateConfig(cfg, SEAT, 600, true, env(root), 300)).toThrow("config lock busy; retry");
    expect(fs.readFileSync(cfg, "utf8")).toBe("[delivery]\nnow_window_seconds = 10\n");
  } finally { held!.release(); }
  updateConfig(cfg, SEAT, 600, true, env(root), 300);
  expect(fs.readFileSync(cfg, "utf8")).toContain("now_window_seconds = 600");
});

test("concurrent setters serialize on the config lock: both wait out a held lock, both rows land, no temp", async () => {
  const root = scratch();
  const cfg = seed(root, "[delivery]\nnow_window_seconds = 30\n");
  const held = acquirePathLock(`${cfg}.lock`, 5000, env(root));
  expect(held).not.toBeNull();
  const spawnSetter = (seat: string) =>
    Bun.spawn(["bun", join(import.meta.dir, "fixtures/digest-window-update-probe.ts"), cfg, seat, "25", "0"], { env: env(root), stdout: "ignore", stderr: "pipe" });
  const a = spawnSetter("t/a");
  const b = spawnSetter("t/b");
  // Either child that gives up while the holder still owns the lock has
  // refused instead of waiting — the serialization claim this arm pins.
  const deadline = Date.now() + 750;
  while (Date.now() < deadline && a.exitCode === null && b.exitCode === null) await Bun.sleep(20);
  const busy: string[] = [];
  for (const [seat, child] of [["t/a", a], ["t/b", b]] as const) {
    if (child.exitCode !== null) busy.push(`${seat}: ${(await new Response(child.stderr).text()).trim()}`);
  }
  expect(busy, "a concurrent setter refused while the holder still owned the lock").toEqual([]);
  held!.release();
  expect([await a.exited, await b.exited]).toEqual([0, 0]);
  expect(parseToml(fs.readFileSync(cfg, "utf8"))).toEqual({
    delivery: {
      now_window_seconds: 30,
      overrides: {
        "t/a": { now_window_seconds: 25, digest_include_asks: false },
        "t/b": { now_window_seconds: 25, digest_include_asks: false },
      },
    },
  });
  expect(fs.readdirSync(join(root, "cfg", "tap")).filter((n) => n.startsWith(".digest-window-"))).toEqual([]);
});
