// `tap keybinding install|remove|status [--key <k>] [--tap <path>] [--dry-run] [--json]`
//
// Owns one tmux binding (default prefix + @) that opens `tap pick` in a popup.
// TAP writes ~/.config/tap/tmux.conf; the user's tmux.conf gets exactly one
// marked `source-file` line, so remove deletes that line and nothing else. An
// existing binding on the key is shown and never replaced.
//
// Exit: 0 done | installed | already so; 1 refusal; 2 status: not installed.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, accessSync, constants, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TapError } from "../context";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { displayText } from "../fzf";
import { NO_SERVER_ON, tmux, tmuxSessionNamespace } from "../tmux";

export const MARKER = "# tap-keybinding";
const HEADER = "# Managed by `tap keybinding`; `tap keybinding remove` deletes this file.";
const KEY = /^(?:[CM]-)?[A-Za-z0-9@!%&*+,./=?^_-]$|^F(?:[1-9]|1[0-2])$/;
const UNSAFE_PATH = /['"\\$`#%\n\r]/;

/** XDG says a relative XDG_CONFIG_HOME is invalid and ignored; a missing or relative HOME leaves nothing safe to write to. */
function configRoots(env: NodeJS.ProcessEnv): { home: string; config: string } {
  const home = env.HOME ?? "";
  if (!isAbsolute(home)) throw new TapError(1, "home_invalid", "set HOME to an absolute path and retry", "HOME is missing or not absolute, so no tmux config location can be chosen");
  return { home, config: env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config") };
}
export const tapConfPath = (env = process.env): string => join(configRoots(env).config, "tap", "tmux.conf");
/** tmux reads ~/.tmux.conf first, then $XDG_CONFIG_HOME/tmux/tmux.conf; with neither, TAP creates ~/.tmux.conf. */
export function userConfPath(env = process.env): string {
  const { home: h, config } = configRoots(env);
  const home = join(h, ".tmux.conf");
  const xdg = join(config, "tmux", "tmux.conf");
  return existsSync(home) || !existsSync(xdg) ? home : xdg;
}
export const sourceLine = (conf: string): string => `source-file -q "${conf}" ${MARKER}`;

export function renderConf(key: string, tap: string): string {
  // display-popup expands no format in its command or -e, but run-shell expands its whole command at
  // keypress: #{pane_id} is the pane being written in, #{client_name} the client that gets the popup.
  return `${HEADER}\nbind-key ${key} run-shell -b "tmux display-popup -c '#{client_name}' -E -w 70% -h 60% '\\"${tap}\\" pick --pane #{pane_id}'"\n`;
}

/**
 * Decode tmux config text into commands of words, per tmux's own grammar: single and double quotes,
 * backslash escapes (`\;` is a literal), unquoted `;` and newlines end a command, `#` starts a comment
 * at the start of a word, and a trailing backslash continues the line.
 */
export function parseConf(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", inWord = false;
  const endWord = () => { if (inWord) { words.push(word); word = ""; inWord = false; } };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; }
      if (i + 1 < text.length) { word += text[++i]; inWord = true; }
    }
    else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? text.length : end); inWord = true; i = end < 0 ? text.length : end;
    }
    else if (c === '"') {
      inWord = true;
      for (i++; i < text.length && text[i] !== '"'; i++) word += text[i] === "\\" && i + 1 < text.length ? text[++i] : text[i];
    }
    else if (c === "#" && !inWord) { while (i + 1 < text.length && text[i + 1] !== "\n") i++; }
    else if (c === "\n" || c === ";") endCommand();
    else if (c === " " || c === "\t" || c === "\r") endWord();
    else { word += c; inWord = true; }
  }
  endCommand();
  return commands;
}

/**
 * tmux accepts any unambiguous prefix of a command name, and `bind` is an alias: bi, bin, bind-, bind-k and
 * bind-key all bind, so do so, sou and source-file for source-file (a single letter is ambiguous). Read every such prefix.
 */
const isCommand = (name: string, full: string): boolean => name.length >= 2 && full.startsWith(name);
const isBind = (name: string): boolean => isCommand(name, "bind-key");
const isSource = (name: string): boolean => isCommand(name, "source-file");
/** Whether a nested command string (an if-shell or run-shell body) may bind or source: a whole word that is such a prefix. */
const mayBindOrSource = (body: string): boolean => body.split(/[;\s'"{}]+/).some(t => isBind(t) || isSource(t));

/** The (table, key) a bind command sets, or null for any other command. A key that needs expansion is unknowable. */
function bindOf(words: string[]): { table: string; key: string } | null {
  if (!isBind(words[0] ?? "")) return null;
  let table = "prefix";
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^-[a-zA-Z]/.test(w)) {   // getopt-style: -rT prefix is -r, then -T with its operand; -Tprefix and -N"a note" attach theirs
      for (let c = 1; c < w.length; c++) {
        const flag = w[c]!;
        if (flag === "n") table = "root";
        else if (flag === "T" || flag === "N") {
          const operand = w.slice(c + 1) || (words[++i] ?? "");
          if (flag === "T") table = operand;
          break;
        }
      }
    } else return { table, key: w };
  }
  return null;
}
/** The key a bind-key line binds in the prefix table, or null (root/copy-mode tables, other commands). */
export function boundKey(line: string): string | null {
  const bind = bindOf(parseConf(line)[0] ?? []);
  return bind && bind.table === "prefix" ? bind.key : null;
}

const unresolved = (path: string, why: string, key: string): TapError =>
  new TapError(1, "config_unresolved", "tap keybinding install --key <other key>", `cannot tell whether ${displayText(path)} binds prefix ${key} (${why}); not changing tmux config`);

/** A bind of `key` in the prefix table in `path` or any config it sources; never executes the config. Uncertain syntax refuses. */
function scanForBinding(path: string, key: string, skip: string, env: NodeJS.ProcessEnv, depth = 0, seen = new Set<string>()): string | undefined {
  const text = readIf(path, true);
  if (text === null || seen.has(path)) return undefined;
  if (depth > 5) throw unresolved(path, "sources nest too deeply", key);
  seen.add(path);
  for (const words of parseConf(text)) {
    const bind = bindOf(words);
    if (bind) {
      if (/\$|#\{/.test(bind.key)) throw unresolved(path, "a key that tmux expands", key);
      if (bind.table === "prefix" && bind.key === key) return `${path}: ${words.join(" ")}`;
      continue;
    }
    const name = words[0]!;
    if (isSource(name)) {
      const operands = words.slice(1).filter(w => !/^-[a-zA-Z]+$/.test(w));
      if (words.some(w => /^-[a-zA-Z]*F/.test(w))) throw unresolved(path, "source-file -F expands formats", key);
      for (const operand of operands) {
        if (/\$|#\{/.test(operand)) throw unresolved(path, `source-file ${operand}`, key);
        const expanded = operand.replace(/^~(?=\/|$)/, env.HOME || "~");
        const bases = isAbsolute(expanded) ? ["/"] : [...new Set([dirname(path), process.cwd()])];
        const files = [...new Set(bases.flatMap(base => /[*?[]/.test(expanded)
          ? [...new Bun.Glob(expanded).scanSync({ cwd: base, absolute: true, onlyFiles: true })]
          : [resolve(base, expanded)]))];
        for (const file of files) {
          if (file === skip) continue;
          const hit = scanForBinding(file, key, skip, env, depth + 1, seen);
          if (hit) return hit;
        }
      }
    } else if ((isCommand(name, "if-shell") || isCommand(name, "run-shell")) && words.some(mayBindOrSource)) {
      throw unresolved(path, `a ${name} command that may bind or source keys`, key);
    }
  }
  return undefined;
}

export function tmuxVersion(): { text: string; ok: boolean } | null {
  const r = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const text = r.stdout.trim().replace(/^tmux\s+/, "");
  const m = /(\d+)\.(\d+)/.exec(text);
  return { text, ok: !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2)) };
}

/** The command a TAP binding runs, exactly as renderConf writes it. */
const popupCommand = (tap: string): string => `tmux display-popup -c '#{client_name}' -E -w 70% -h 60% '"${tap}" pick --pane #{pane_id}'`;

/** Three answers, never two: a tmux failure that is not a recognized "no server" is UNKNOWN, not "nothing bound". */
type Live = { server: "up" | "none" | "unobservable"; lines: string[] };
function liveBindings(env = process.env): Live {
  // list-keys answers with the default table even when no server runs, so liveness is asked of list-sessions.
  const ns = tmuxSessionNamespace(env);
  if (!ns.observable) return { server: "unobservable", lines: [] };
  if (ns.names.size === 0) return { server: "none", lines: [] };
  let r: ReturnType<typeof tmux>;
  try { r = tmux(["list-keys", "-T", "prefix"], env); } catch { return { server: "unobservable", lines: [] }; }
  if (r.code === 0) return { server: "up", lines: r.stdout.split("\n").filter(l => /^bind-key\s/.test(l)) };
  return { server: NO_SERVER_ON.test(r.stderr.trim()) ? "none" : "unobservable", lines: [] };
}
const lineFor = (live: Live, key: string): string | undefined => live.lines.find(l => boundKey(l) === key);
/** Ours means the binding runs exactly the command TAP generates for this tap path, not merely one that mentions it. */
function liveIsOurs(line: string, tap: string | undefined): boolean {
  if (!tap) return false;
  const words = parseConf(line)[0] ?? [];
  return words.includes("run-shell") && words[words.length - 1] === popupCommand(tap);
}
/** The tap path inside a live binding that runs TAP's exact generated command, else undefined: how an install whose config is lost is still recognized. */
function exactTapOf(line: string): string | undefined {
  const last = (parseConf(line)[0] ?? []).at(-1) ?? "";
  const m = /^tmux display-popup -c '#\{client_name\}' -E -w 70% -h 60% '"(.+)" pick --pane #\{pane_id\}'$/.exec(last);
  return m && liveIsOurs(line, m[1]) ? m[1] : undefined;
}

/** Dotfiles are often symlinks into a repo: write through the link and keep the file's mode. */
function writeFileAtomic(path: string, text: string): void {
  let target = path, mode = 0o644;
  try { target = realpathSync(path); mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  atomicWrite(target, text, mode);
}

/**
 * null means the file is absent. A file that exists but cannot be read (mode 000, a directory, a dangling
 * symlink) is neither empty nor absent: a writer must refuse, because replacing it would destroy it.
 */
function readIf(path: string, strict = false): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    let present = code !== "ENOENT";
    if (!present) { try { lstatSync(path); present = true; } catch { /* truly absent */ } }   // ENOENT through a dangling symlink
    if (present && strict) throw new TapError(1, "config_unreadable", "fix the file's permissions or target, then retry",
      `${displayText(path)} exists but cannot be read (${code ?? "unreadable"}); not touching it`);
    return null;
  }
}
const hasSourceLine = (text: string, conf: string): boolean => text.split("\n").includes(sourceLine(conf));
const current = (conf: string): { key: string; tap: string } | null => {
  const m = /^bind-key (\S+) run-shell .*'\\"(.*)\\" pick --pane/m.exec(conf);
  return m ? { key: m[1]!, tap: m[2]! } : null;
};

function resolveTap(explicit: string, env = process.env): string {
  const runnable = (candidate: string): boolean => { try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; } };
  let path = explicit;
  if (!path) for (const dir of (env.PATH || "").split(":")) {
    const candidate = join(dir || ".", "tap");
    if (isAbsolute(candidate) && runnable(candidate)) { path = candidate; break; }
  }
  if (!path) throw new TapError(1, "tap_not_found", "tap keybinding install --tap <abs-path-to-tap>", "no absolute `tap` on PATH to run from the popup");
  if (!isAbsolute(path) || UNSAFE_PATH.test(path)) throw new TapError(1, "usage_error", "tap help keybinding", `--tap needs an absolute path without quotes, #, % or $: ${displayText(path)}`);
  if (!runnable(path)) throw new TapError(1, "tap_not_executable", "tap keybinding install --tap <abs-path-to-tap>", `${displayText(path)} is not an executable file, so the popup could not run it`);
  return path;
}

export interface Status {
  installed: boolean; key: string | null; tap: string | null; tap_conf: string; user_conf: string;
  tap_conf_present: boolean; tap_conf_owned: boolean; source_line_present: boolean; stale_installs: string[]; tmux_version: string | null; tmux_ok: boolean;
  live: "bound" | "unbound" | "no_server" | "other" | "unobservable" | "unchecked";
}
/** TAP's conf is ours only when it is byte-for-byte what renderConf writes for the key and path it names. */
function ownedConf(text: string | null): { key: string; tap: string } | null {
  const have = text ? current(text) : null;
  return have && text === renderConf(have.key, have.tap) ? have : null;
}
/** The tmux configs a TAP source line can live in: the one tmux reads now, plus both standard locations. */
function userConfPaths(env: NodeJS.ProcessEnv): string[] {
  const roots = configRoots(env);
  return [...new Set([userConfPath(env), join(roots.home, ".tmux.conf"), join(roots.config, "tmux", "tmux.conf")])];
}
/** The TAP conf paths named by TAP's own marked source lines; an XDG change leaves the old path behind in the user's config. */
const markedConfs = (text: string): string[] => text.split("\n").flatMap(l => { const m = /^source-file -q "([^"\n]+)" # tap-keybinding$/.exec(l); return m ? [m[1]!] : []; });
export function status(env = process.env): Status {
  const tapConf = tapConfPath(env), userConf = userConfPath(env);
  const tapText = readIf(tapConf), userText = readIf(userConf);
  const have = ownedConf(tapText);
  const sourced = !!userText && hasSourceLine(userText, tapConf);
  const stale = [...new Set(userConfPaths(env).flatMap(p => markedConfs(readIf(p) ?? "")))].filter(p => p !== tapConf);
  const v = tmuxVersion();
  let live: Status["live"] = "unchecked";
  // An edited conf may still describe a binding that is loaded: judge the live key from what it names, owned or not.
  const named = tapText ? current(tapText) : null;
  if (named) {
    const l = liveBindings(env), line = lineFor(l, named.key);
    live = l.server === "none" ? "no_server" : l.server === "unobservable" ? "unobservable" : !line ? "unbound" : liveIsOurs(line, named.tap) ? "bound" : "other";
  }
  return { installed: !!have && sourced, key: have?.key ?? null, tap: have?.tap ?? null, tap_conf: tapConf, user_conf: userConf,
    tap_conf_present: tapText !== null, tap_conf_owned: !!have, source_line_present: sourced, stale_installs: stale, tmux_version: v?.text ?? null, tmux_ok: !!v?.ok, live };
}

function emit(json: boolean, fields: Record<string, unknown>, human: string): void {
  process.stdout.write(json ? `${ensureAscii(JSON.stringify({ ok: true, ...fields }))}\n` : `${human}\n`);
}

export interface Removal { unlocated: string[]; dry_run: boolean; removed_source_line: boolean; removed_tap_conf: boolean; live_unbound: boolean; live_unbind_skipped: boolean; kept_edited_conf: boolean; old_confs: string[]; user_conf: string; tap_conf: string }
/**
 * Removes exactly what TAP installed: every marked source line, each unedited conf they name (the current
 * one and any left by an earlier XDG root), and each live binding while it still runs TAP's exact command.
 * An edited conf stays, but its live binding is still dealt with. A live binding that runs TAP's exact command
 * yet belongs to no conf found here (its XDG root moved and the user config that sourced it is out of reach) is
 * unbound too. `requireLive` refuses, before changing anything, when tmux cannot be read or such a binding exists:
 * deleting TAP would leave the key broken with nothing left to retry from.
 */
export function removeKeybinding(dry: boolean, env = process.env, requireLive = false): Removal {
  const st = status(env);
  const users = userConfPaths(env).map(path => ({ path, text: readIf(path, true) })).filter((u): u is { path: string; text: string } => u.text !== null);
  const confs = [...new Set([st.tap_conf, ...users.flatMap(u => markedConfs(u.text))])];
  const found = confs.map(path => { const text = readIf(path, true); return { path, text, named: text ? current(text) : null, owned: ownedConf(text) }; });
  const named = found.filter(f => f.named);
  const live = liveBindings(env);
  const unlocated = live.server === "up" ? live.lines.flatMap(l => { const k = boundKey(l); return k && exactTapOf(l) && !named.some(f => f.named!.key === k && liveIsOurs(l, f.named!.tap)) ? [k] : []; }) : [];
  if (requireLive && unlocated.length) throw new TapError(1, "install_unlocated", "restore the XDG_CONFIG_HOME it was installed under and rerun, or tap keybinding remove",
    `a live TAP lookup key (prefix ${unlocated.join(", ")}) came from a config this run cannot locate, perhaps because XDG_CONFIG_HOME changed; nothing was removed`);
  // An unobservable tmux cannot rule out a live key, even when no conf names one (its marker may be out of reach).
  if (requireLive && live.server === "unobservable") throw new TapError(1, "tmux_unobservable", "start or fix tmux, then rerun",
    "tmux could not be observed, so a live lookup key cannot be ruled out; nothing was removed");
  // The live bindings go first: if tmux refuses, the files stay so that a retry still finds them.
  const unbound = new Set<string>();
  const unbind = (key: string): void => {
    if (dry) return;
    const r = tmux(["unbind-key", "-T", "prefix", key], env);
    if (r.code !== 0) throw new TapError(1, "unbind_failed", "tap keybinding remove", `tmux refused to unbind prefix ${key} (${displayText(r.stderr.trim())}); ` +
      (unbound.size ? `prefix ${[...unbound].join(", ")} was already unbound and no file was touched` : "nothing was removed"));
  };
  for (const f of named) {
    const line = live.server === "up" ? lineFor(live, f.named!.key) : undefined;
    if (!line || !liveIsOurs(line, f.named!.tap) || unbound.has(f.named!.key)) continue;
    unbind(f.named!.key);
    unbound.add(f.named!.key);
  }
  for (const key of unlocated) if (!unbound.has(key)) { unbind(key); unbound.add(key); }
  const mine = new Set(confs.map(sourceLine));
  let removedLine = false;
  for (const u of users) {
    const lines = u.text.split("\n"), kept = lines.filter(l => !mine.has(l));
    if (kept.length === lines.length) continue;
    removedLine = true;
    if (!dry) writeFileAtomic(u.path, kept.join("\n"));
  }
  const owned = found.filter(f => f.owned);
  // A file edited since it was read is the user's now: re-check immediately before deleting.
  if (!dry) for (const f of owned) if (ownedConf(readIf(f.path)) !== null) rmSync(f.path);
  return { unlocated, dry_run: dry, removed_source_line: removedLine, removed_tap_conf: owned.some(f => f.path === st.tap_conf), live_unbound: unbound.size > 0,
    live_unbind_skipped: live.server === "unobservable" && named.length > 0, kept_edited_conf: found.some(f => f.text !== null && !f.owned),
    old_confs: owned.map(f => f.path).filter(p => p !== st.tap_conf), user_conf: st.user_conf, tap_conf: st.tap_conf };
}
const describeRemoval = (r: Removal): string => `${r.dry_run ? "would remove" : "removed"}: ${r.removed_source_line ? "source line from " + r.user_conf : "no source line"}; ` +
  `${r.removed_tap_conf ? r.tap_conf : r.kept_edited_conf ? `kept ${r.tap_conf} (edited, so not TAP's to delete)` : "no TAP-owned conf"}` +
  (r.old_confs.length ? `; earlier install ${r.old_confs.join(", ")}` : "") +
  (r.live_unbound ? "; live binding" : "") +
  (r.unlocated.length ? `; the live key on prefix ${r.unlocated.join(", ")} came from a config that could not be located (XDG_CONFIG_HOME changed?): delete its marked "source-file ... # tap-keybinding" line from your tmux config yourself` : "") +
  (r.live_unbind_skipped ? "; could not read the running tmux server, so a live binding stays until restart (tmux unbind-key -T prefix <key>)" : "");

/** For `tap uninstall`: the same ownership-aware removal, reported as plan lines; empty when nothing of TAP's is installed. */
export function uninstallKeybinding(apply: boolean, env = process.env): { lines: string[]; preserved: boolean } {
  const st = status(env);
  // Removing the files while a live binding cannot be ruled out would strand it with no record to retry from.
  try {
    const r = removeKeybinding(!apply, env, true);   // a preview refuses exactly where the real run would
    const nothing = !st.tap_conf_present && !st.source_line_present && !st.stale_installs.length && !r.unlocated.length;
    return { lines: nothing ? [] : [describeRemoval(r)], preserved: false };
  }
  catch (error) { return { lines: [`preserved tmux lookup key: ${(error as Error).message}; next: ${error instanceof TapError ? error.action : "tap keybinding remove"}`], preserved: true }; }
}
export const keybindingInstalled = (env = process.env): boolean => {
  const st = status(env);
  if (st.tap_conf_present || st.source_line_present || st.stale_installs.length > 0) return true;
  try { return removeKeybinding(true, env).unlocated.length > 0; } catch { return true; }   // unreadable config: let uninstall surface it
};

export function cmdKeybinding(argv: string[]): number {
  const sub = argv[0];
  if (argv.includes("--json")) process.env.TAP_JSON = "1";   // a requested JSON error must not depend on flag order
  if (!sub || !["install", "remove", "status"].includes(sub)) {
    throw new TapError(1, "usage_error", "tap help keybinding", sub ? `unknown subcommand '${displayText(sub)}'` : "needs install, remove or status");
  }
  let key = "@", tap = "", dry = false, json = process.env.TAP_JSON === "1", keyGiven = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--key" && sub === "install") { key = argv[++i] ?? ""; keyGiven = true; if (!KEY.test(key)) throw new TapError(1, "usage_error", "tap help keybinding", "--key needs one key such as @, g, C-g or F5"); }
    else if (a === "--tap" && sub === "install") { tap = argv[++i] ?? ""; if (!tap) throw new TapError(1, "usage_error", "tap help keybinding", "--tap needs a path"); }
    else if (a === "--dry-run" && sub !== "status") dry = true;
    else if (a === "--json") { json = true; process.env.TAP_JSON = "1"; }
    else throw new TapError(1, "usage_error", "tap help keybinding", `unexpected '${displayText(a)}' for ${sub}`);
  }
  const env = process.env;

  if (sub === "status") {
    const st = status(env);
    const human = [`keybinding: ${st.installed ? `installed (prefix ${st.key})` : "not installed"}`,
      `tmux: ${st.tmux_version ?? "not found"}${st.tmux_ok ? "" : " (display-popup needs 3.2+)"}`,
      `tap conf: ${st.tap_conf} (${st.tap_conf_present ? (st.tap_conf_owned ? "present" : "present, edited or not TAP's") : "absent"})`,
      `user conf: ${st.user_conf} (${st.source_line_present ? "source line present" : "no source line"})`,
      `live: ${st.live}`].join("\n");
    emit(json, { ...st }, human);
    return st.installed ? 0 : 2;
  }
  if (sub === "remove") {
    const r = removeKeybinding(dry, env);
    emit(json, { ...r }, describeRemoval(r));
    return 0;
  }

  // install
  const st = status(env);
  const tapText = readIf(st.tap_conf, true), userText = readIf(st.user_conf, true) ?? "";
  const v = tmuxVersion();
  if (!v) throw new TapError(1, "tmux_not_found", "install tmux 3.2 or newer", "tmux is not on PATH");
  if (!v.ok) throw new TapError(1, "tmux_too_old", "upgrade tmux to 3.2 or newer", `tmux ${v.text} lacks display-popup`);
  const known = ownedConf(tapText);
  // A conf at TAP's path that is not exactly what TAP wrote is the user's now: never overwritten, never deleted.
  if (tapText !== null && !known) throw new TapError(1, "tap_conf_modified", "tap keybinding remove   (after moving your edits elsewhere)",
    `${st.tap_conf} was edited or is not TAP's; not overwriting it`);
  const ourKey = known?.key;
  if (!keyGiven && ourKey) key = ourKey;
  const roots = configRoots(env);
  const userConfs = [st.user_conf, join(roots.home, ".tmux.conf"), join(roots.config, "tmux", "tmux.conf")];
  let existing: string | undefined;
  for (const path of new Set(userConfs)) existing ??= scanForBinding(path, key, st.tap_conf, env);
  const live = liveBindings(env);
  if (live.server === "unobservable") throw new TapError(1, "tmux_unobservable", "tap keybinding status", "could not read the running tmux server's key bindings; not changing tmux config");
  const liveLine = lineFor(live, key);
  if (liveLine && !(known && ourKey === key && liveIsOurs(liveLine, known.tap))) existing ??= `running tmux: ${liveLine.trim()}`;
  if (existing) throw new TapError(1, "key_bound", `tap keybinding install --key <other key>`, `prefix ${key} is already bound (${displayText(existing)}); not replacing it`);

  const tapPath = resolveTap(tap, env);
  const conf = renderConf(key, tapPath), line = sourceLine(st.tap_conf);
  const hasLine = hasSourceLine(userText, st.tap_conf);
  const unchanged = tapText === conf && hasLine;
  // An unchanged disk can still owe the running server its binding (it was unbound or tmux restarted since).
  const loaded = !!liveLine && liveIsOurs(liveLine, tapPath);
  let reloaded = false;
  if (!dry) {
    // The old key is unbound first and its outcome checked: on failure nothing is rewritten, so the
    // recorded conf still names the key and a retry (or remove) can finish the job.
    if (live.server === "up" && ourKey && ourKey !== key) {
      const old = lineFor(live, ourKey);
      if (old && liveIsOurs(old, known!.tap)) {
        const r = tmux(["unbind-key", "-T", "prefix", ourKey], env);
        if (r.code !== 0) throw new TapError(1, "unbind_failed", "tap keybinding install   (retry)",
          `tmux refused to unbind the old prefix ${ourKey} (${displayText(r.stderr.trim()) || "no reason given"}); nothing was rewritten`);
      }
    }
    if (!unchanged) {
      let wroteConf = false;
      try {
        writeFileAtomic(st.tap_conf, conf); wroteConf = true;
        if (!hasLine) writeFileAtomic(st.user_conf, `${userText}${userText && !userText.endsWith("\n") ? "\n" : ""}${line}\n`);
      } catch (error) {
        throw new TapError(1, "config_write_failed", "fix the permissions or free space, then rerun tap keybinding install",
          `${displayText((error as Error).message)}; ${wroteConf ? `${st.tap_conf} was written but ${st.user_conf} was not, so tmux will not load it` : "nothing was written"}`);
      }
    }
    if (live.server === "up" && (!unchanged || !loaded)) {
      const r = tmux(["source-file", st.tap_conf], env);
      if (r.code !== 0) throw new TapError(1, "reload_failed", "tap keybinding install   (retry), or restart tmux",
        `wrote ${st.tap_conf} and the source line in ${st.user_conf}, but the running tmux refused to load it (${displayText(r.stderr.trim()) || "no reason given"}); the binding will load when tmux restarts`);
      reloaded = true;
    }
  }
  emit(json, { dry_run: dry, key, tap: tapPath, tap_conf: st.tap_conf, user_conf: st.user_conf, changed: !unchanged, reloaded },
    `${dry ? "would install" : unchanged && !reloaded ? "already installed" : "installed"}: prefix ${key} opens the teammate picker${!dry && !reloaded ? " (loads when tmux starts)" : ""}`);
  return 0;
}
