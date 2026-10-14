// `tap tmux-defaults install|remove|status [--dry-run] [--json]`
//
// Owns one TAP-managed tmux defaults file (~/.config/tap/tmux-defaults.conf):
// truecolor, mouse, wheel scrolling, clipboard, focus events, history, an
// update-environment without SSH_CONNECTION and, optionally, a calm status bar
// (team/session, windows by seat name, time). The user's tmux.conf gets exactly
// one marked `source-file` line, INSERTED BEFORE their own lines, because tmux
// is last-write-wins and their settings must beat TAP's defaults; remove
// deletes that line and nothing else. A defaults file that is not byte-for-byte
// what TAP renders is the user's now: never overwritten, never deleted.
//
// Exit: 0 done | installed | already so | status reported (installed or not); 1 refusal.

import { accessSync, constants, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TapError } from "../context";
import { ensureAscii } from "../fsatomic";
import { displayText } from "../fzf";
import { NO_SERVER_ON, tmux, tmuxSessionNamespace } from "../tmux";
import { configRoots, readIf as readFileIfPresent, tmuxVersion, userConfPath, writeFileAtomic as writeFileThroughSymlink } from "./keybinding";

export const MARKER = "# tap-tmux-defaults";

/**
 * Clipboard strategy, chosen at install time from the installing environment and
 * recorded in the file's second line, so ownership stays a byte comparison
 * against a re-render for the recorded mode even when the machine changes.
 */
export type ClipboardMode = "pbcopy" | "wl-copy" | "xclip" | "osc52";
const CLIPBOARD_MODES: readonly ClipboardMode[] = ["pbcopy", "wl-copy", "xclip", "osc52"];

/**
 * A superset of vanilla tmux's update-environment minus SSH_CONNECTION: the
 * 3.7c default list without it. On tmux older than 3.7 the file also refreshes
 * five names later versions added (MSYSTEM, WAYLAND_DISPLAY, XDG_CURRENT_DESKTOP,
 * XDG_SESSION_DESKTOP, XDG_SESSION_TYPE); the file's bytes stay static across
 * versions. A stale SSH_CONNECTION copied into the session environment is why
 * Claude Code's own pbcopy path refuses to run and mouse copies land only in
 * the tmux buffer (tap-2njq3 KT). Names a tmux build does not know are ignored
 * harmlessly; the focused test checks the running server's vanilla list is
 * covered.
 */
export const UPDATE_ENVIRONMENT = "DISPLAY KRB5CCNAME MSYSTEM SSH_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID WAYLAND_DISPLAY WINDOWID XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE";

export const defaultsPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(configRoots(env).config, "tap", "tmux-defaults.conf");
export const sourceLine = (conf: string): string => `source-file -q "${conf}" ${MARKER}`;

const COPY_COMMAND: Record<Exclude<ClipboardMode, "osc52">, string> = {
  pbcopy: "/usr/bin/pbcopy",
  "wl-copy": "wl-copy",
  xclip: "xclip -in -selection clipboard",
};

/**
 * What the file renders for: the clipboard mode and whether to pin
 * default-terminal. Pinning assumes the host can resolve tmux-256color; a
 * host without the terminfo entry keeps its own terminal and gets everything
 * else, so pane programs never break on TAP's account.
 */
export interface DefaultsSpec { mode: ClipboardMode; terminal: "pin" | "inherit"; status: boolean }

/**
 * The optional status-bar section. Muted: bg=terminal is the terminal's own
 * background and the labels take its foreground (tmux's "default" would mean
 * the surrounding style, which is grey here), so the bar reads in light and dark. Session name on the left, windows by name (no
 * index, no hostname), time on the right.
 */
export const STATUS_LINES: readonly string[] = [
  "# Status bar: team/session, windows by seat name, time. Muted; reads in light and dark terminals.",
  `set -g status-style "bg=terminal,fg=colour243"`,
  `set -g status-left-length 40`,
  `set -g status-left "#[fg=terminal,bold] #S #[default] "`,
  `set -g status-right-length 20`,
  `set -g status-right "#[fg=colour243]%H:%M "`,
  `set -g window-status-separator ""`,
  `set -g window-status-format " #W "`,
  `set -g window-status-current-format "#[fg=terminal,bold] #W #[default]"`,
  `set -g status-interval 30`,
];
/** The status options the section sets, as `set -g` reports them. */
const STATUS_OPTIONS: Record<string, string> = {
  "status-style": "bg=terminal,fg=colour243",
  "status-left-length": "40",
  "status-left": "#[fg=terminal,bold] #S #[default] ",
  "status-right-length": "20",
  "status-right": "#[fg=colour243]%H:%M ",
  "window-status-separator": "",
  "window-status-format": " #W ",
  "window-status-current-format": "#[fg=terminal,bold] #W #[default]",
  "status-interval": "30",
};

/** The option settings the managed file sets, exactly as tmux reports them. */
export function defaultsOptions(spec: DefaultsSpec): Record<string, string> {
  const options: Record<string, string> = {
    // -as appends to tmux's built-in feature lists; a plain set would replace them.
    "terminal-features": ",*:RGB",
    "terminal-overrides": ",*:Tc",
    "mouse": "on",
    "focus-events": "on",
    "history-limit": "10000",
    "set-clipboard": spec.mode === "osc52" ? "on" : "off",
    "update-environment": UPDATE_ENVIRONMENT,
  };
  if (spec.terminal === "pin") options["default-terminal"] = "tmux-256color";
  if (spec.mode !== "osc52") options["copy-command"] = COPY_COMMAND[spec.mode];
  if (spec.status) Object.assign(options, STATUS_OPTIONS);
  return options;
}

/** The exact bytes TAP writes for a spec; ownership is a comparison against this. */
export function renderDefaults(spec: DefaultsSpec): string {
  return [
    MARKER,
    `# clipboard=${spec.mode}`,
    `# terminal=${spec.terminal}`,
    // Absent when off, so a file written before the status section existed stays byte-for-byte owned.
    ...(spec.status ? ["# status=on"] : []),
    "# Managed by `tap tmux-defaults`; `tap tmux-defaults remove` deletes this file.",
    "# TAP's source line sits before your own tmux.conf lines, so your settings win.",
    ...(spec.terminal === "pin" ? [`set -g default-terminal "tmux-256color"`] : []),
    `set -as terminal-features ",*:RGB"`,
    `set -as terminal-overrides ",*:Tc"`,
    `set -g mouse on`,
    `set -g focus-events on`,
    `set -g history-limit 10000`,
    `set -g update-environment "${UPDATE_ENVIRONMENT}"`,
    `set -g set-clipboard ${spec.mode === "osc52" ? "on" : "off"}`,
    ...(spec.mode === "osc52" ? [] : [`set -g copy-command "${COPY_COMMAND[spec.mode]}"`]),
    ...(spec.status ? STATUS_LINES : []),
    "# Wheel: 10 lines per notch in both copy modes (vanilla scrolls 5).",
    `bind-key -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 10 scroll-up`,
    `bind-key -T copy-mode WheelDownPane select-pane \\; send-keys -X -N 10 scroll-down`,
    `bind-key -T copy-mode-vi WheelUpPane select-pane \\; send-keys -X -N 10 scroll-up`,
    `bind-key -T copy-mode-vi WheelDownPane select-pane \\; send-keys -X -N 10 scroll-down`,
    "# Middle click leaves copy mode; outside it, vanilla paste behavior is kept.",
    `bind-key -T root MouseDown2Pane select-pane -t = \\; if-shell -F "#{pane_in_mode}" { send-keys -X cancel } { if-shell -F "#{mouse_any_flag}" { send-keys -M } { paste-buffer -p } }`,
    "",
  ].join("\n");
}

/** The clipboard mode recorded in the file's second line, else null. */
export function recordedMode(text: string | null): ClipboardMode | null {
  if (!text) return null;
  const m = /^# clipboard=(\S+)$/.exec(text.split("\n")[1] ?? "");
  return m && (CLIPBOARD_MODES as readonly string[]).includes(m[1]!) ? m[1] as ClipboardMode : null;
}

/** The terminal choice recorded in the file's third line, else null. */
function recordedTerminal(text: string | null): "pin" | "inherit" | null {
  if (!text) return null;
  const m = /^# terminal=(\S+)$/.exec(text.split("\n")[2] ?? "");
  return m && (m[1] === "pin" || m[1] === "inherit") ? m[1] : null;
}

/** Whether the file records the status section (line 4); files from before it existed record nothing, meaning off. */
const recordedStatus = (text: string | null): boolean => !!text && text.split("\n")[3] === "# status=on";

/** Ours means byte-for-byte what renderDefaults writes for the spec the file itself records. */
function ownedDefaults(text: string | null): DefaultsSpec | null {
  const mode = recordedMode(text), terminal = recordedTerminal(text);
  const spec = mode && terminal ? { mode, terminal, status: recordedStatus(text) } : null;
  return spec && text === renderDefaults(spec) ? spec : null;
}

/** Whether the host resolves tmux-256color; no infocmp answer means do not pin. */
function hostPinsTerminal(env: NodeJS.ProcessEnv): boolean {
  try {
    return spawnSync("infocmp", ["-x", "tmux-256color"], { encoding: "utf8", timeout: 5000, env: { ...env, TMUX: "" } }).status === 0;
  } catch { return false; }
}

/**
 * Whether the human has tmux configuration of their own: either tmux.conf
 * holds a command line that is not a TAP marked source line. TAP's own lines
 * (the keybinding step runs first and creates ~/.tmux.conf) and a blank or
 * comment-only file do not count, so a first-timer is still a first-timer
 * after TAP's other steps ran.
 */
export function humanHasTmuxConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const roots = configRoots(env);
  const tapLine = /^source-file -q "[^"\n]+" # tap-(tmux-defaults|keybinding)$/;
  return [join(roots.home, ".tmux.conf"), join(roots.config, "tmux", "tmux.conf")].some(path => {
    const text = readFileIfPresent(path, true);
    return text !== null && text.split("\n").some(l => l.trim() !== "" && !l.trim().startsWith("#") && !tapLine.test(l));
  });
}

/** What this environment would render for: clipboard mode, the terminal-pin choice and, by default, the status bar only for a human with no tmux config. */
export function detectSpec(env: NodeJS.ProcessEnv = process.env, status: boolean = !humanHasTmuxConfig(env)): DefaultsSpec {
  return { mode: detectClipboardMode(env), terminal: hostPinsTerminal(env) ? "pin" : "inherit", status };
}

const executable = (path: string, env: NodeJS.ProcessEnv): boolean => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};
const onPath = (name: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH || "").split(":").some(dir => dir && executable(join(dir, name), env));

/**
 * Chosen from the installing environment, because the tmux server's panes run
 * where the installer runs: installing over SSH means local clipboard tools are
 * unreachable and OSC 52 (set-clipboard on) is the path back to the terminal.
 * A tool is only chosen when its display system is the session's: a usable
 * binary without its display records a mode that can never work, where OSC 52
 * would have.
 */
export function detectClipboardMode(env: NodeJS.ProcessEnv = process.env): ClipboardMode {
  if (env.SSH_CONNECTION) return "osc52";
  if (process.platform === "darwin") return executable("/usr/bin/pbcopy", env) || onPath("pbcopy", env) ? "pbcopy" : "osc52";
  if (env.WAYLAND_DISPLAY && onPath("wl-copy", env)) return "wl-copy";
  if (env.DISPLAY && onPath("xclip", env)) return "xclip";
  return "osc52";
}

/** Whether the recorded mode is usable now: its tool and, for Linux tools, its display system; null for osc52, which needs neither. */
export function copyToolPresent(mode: ClipboardMode, env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (mode === "osc52") return null;
  if (mode === "pbcopy") return executable("/usr/bin/pbcopy", env) || onPath("pbcopy", env);
  if (mode === "wl-copy") return !!env.WAYLAND_DISPLAY && onPath("wl-copy", env);
  return !!env.DISPLAY && onPath("xclip", env);
}

/** Index of the first command line, past leading blanks and comments: TAP's line is inserted there. */
export function firstCommandIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) { i++; continue; }
    break;
  }
  return i;
}

/** The TAP defaults paths named by marked source lines; an XDG change leaves the old line behind. */
const markedConfs = (text: string): string[] =>
  text.split("\n").flatMap(l => { const m = /^source-file -q "([^"\n]+)" # tap-tmux-defaults$/.exec(l); return m ? [m[1]!] : []; });

/**
 * The file text with TAP's line inserted before the user's first command line
 * (blank and comment lines are skipped; the artifact of a trailing newline is
 * not a blank line). An empty file becomes exactly the line.
 */
export function insertMarkedLine(text: string, line: string): string {
  if (text === "") return `${line}\n`;
  const trailing = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailing) lines.pop();
  lines.splice(firstCommandIndex(lines), 0, line);
  return `${lines.join("\n")}${trailing ? "\n" : ""}`;
}

export type LiveState = { server: "up" | "none" | "unobservable"; values: Record<string, string>; ssh_sessions: string[]; global_ssh_connection: boolean };

/**
 * The running server's answer for each managed option, plus where the
 * environment still carries SSH_CONNECTION: per session, and in the global
 * environment a server inherits when it was itself started over SSH — new
 * panes merge global and session environments, so a global stale value
 * reaches panes no session-level clear can fix (repair:
 * `tmux set-environment -g -r SSH_CONNECTION`). Read-only: it never starts a
 * server.
 */
function liveState(options: Record<string, string>, env: NodeJS.ProcessEnv): LiveState {
  const ns = tmuxSessionNamespace(env);
  if (!ns.observable) return { server: "unobservable", values: {}, ssh_sessions: [], global_ssh_connection: false };
  if (ns.names.size === 0) return { server: "none", values: {}, ssh_sessions: [], global_ssh_connection: false };
  const values: Record<string, string> = {};
  try {
    for (const option of Object.keys(options)) {
      const r = tmux(["show", "-gv", option], env);
      if (r.code !== 0) return { server: NO_SERVER_ON.test(r.stderr.trim()) ? "none" : "unobservable", values: {}, ssh_sessions: [], global_ssh_connection: false };
      values[option] = r.stdout.replace(/\n$/, "").replace(/\n/g, " ");   // only the terminator goes: formats carry meaningful edge spaces
    }
  } catch { return { server: "unobservable", values: {}, ssh_sessions: [], global_ssh_connection: false }; }
  const setSomewhere = (args: string[]): boolean => {
    const r = tmux(args, env);
    return r.code === 0 && r.stdout.trim().startsWith("SSH_CONNECTION=");
  };
  const ssh_sessions: string[] = [];
  // A set variable answers "SSH_CONNECTION=..."; tmux answers "-SSH_CONNECTION" (exit 0) for one that is not set.
  for (const name of ns.names) if (setSomewhere(["show-environment", "-t", name, "SSH_CONNECTION"])) ssh_sessions.push(name);
  return { server: "up", values, ssh_sessions, global_ssh_connection: setSomewhere(["show-environment", "-g", "SSH_CONNECTION"]) };
}

export interface DefaultsStatus {
  schema: 1;
  installed: boolean;
  defaults_file: string;
  user_conf: string;
  defaults_present: boolean;
  defaults_owned: boolean;
  source_line_present: boolean;
  /** null when no source line exists; otherwise whether it sits before the user's own command lines. */
  source_line_before_settings: boolean | null;
  /** The owned file's recorded mode, else what this platform would choose. */
  clipboard: ClipboardMode;
  /** The owned file's recorded terminal choice, else what this host would choose. */
  terminal: "pin" | "inherit";
  /** Whether the owned file carries the status-bar section; false when TAP's file is absent or edited. */
  status_bar: boolean;
  copy_tool_present: boolean | null;
  stale_installs: string[];
  tmux_version: string | null;
  tmux_ok: boolean;
  options: Record<string, string>;
  live: LiveState;
}

export function status(env: NodeJS.ProcessEnv = process.env, withLive = true): DefaultsStatus {
  const roots = configRoots(env);
  const defaultsFile = defaultsPath(env), userConf = userConfPath(env);
  const defaultsText = readFileIfPresent(defaultsFile, true);
  const userText = readFileIfPresent(userConf, true);
  const owned = ownedDefaults(defaultsText);
  const lines = userText ? userText.split("\n") : [];
  const marked = lines.map((l, i) => l === sourceLine(defaultsFile) ? i : -1).filter(i => i >= 0);
  // Insertion puts the marked line exactly at the first command position, so "before" admits equality.
  const beforeSettings = marked.length ? marked.every(i => i <= firstCommandIndex(lines)) : null;
  const spec = owned ?? detectSpec(env, false);
  const version = tmuxVersion();
  return {
    schema: 1,
    installed: !!owned && marked.length > 0 && beforeSettings === true,
    defaults_file: defaultsFile,
    user_conf: userConf,
    defaults_present: defaultsText !== null,
    defaults_owned: !!owned,
    source_line_present: marked.length > 0,
    source_line_before_settings: beforeSettings,
    clipboard: spec.mode,
    terminal: spec.terminal,
    status_bar: !!owned?.status,
    copy_tool_present: copyToolPresent(spec.mode, env),
    stale_installs: [...new Set([userConf, join(roots.home, ".tmux.conf"), join(roots.config, "tmux", "tmux.conf")].flatMap(p => markedConfs(readFileIfPresent(p) ?? "")))].filter(p => p !== defaultsFile),
    tmux_version: version?.text ?? null,
    tmux_ok: !!version?.ok,
    options: defaultsOptions(spec),
    live: withLive ? liveState(defaultsOptions(spec), env) : { server: "none", values: {}, ssh_sessions: [], global_ssh_connection: false },
  };
}

export interface Removal { dry_run: boolean; removed_source_line: boolean; removed_defaults: string[]; kept_edited_defaults: boolean; user_conf: string; defaults_file: string }

/**
 * Removes exactly what TAP installed: every marked source line, and each
 * defaults file the lines name (the current one and any left by an earlier XDG
 * root) while it is still byte-for-byte TAP's. An edited file stays. Options
 * already loaded into a running server cannot be un-sourced; they stay until
 * tmux restarts, which the report says.
 */
export function removeDefaults(dry: boolean, env: NodeJS.ProcessEnv = process.env): Removal {
  const defaultsFile = defaultsPath(env);
  const roots = configRoots(env);
  const users = [...new Set([userConfPath(env), join(roots.home, ".tmux.conf"), join(roots.config, "tmux", "tmux.conf")])]
    .map(path => ({ path, text: readFileIfPresent(path, true) })).filter((u): u is { path: string; text: string } => u.text !== null);
  const targets = [...new Set([defaultsFile, ...users.flatMap(u => markedConfs(u.text))])];
  // Preflight: every target must be readable before any source line is rewritten —
  // the marked line is how a retry finds a stale path, so it never goes first.
  const targetTexts = new Map(targets.map(path => [path, readFileIfPresent(path, true)]));
  const mine = new Set(targets.map(sourceLine));
  let removedLine = false;
  for (const u of users) {
    const lines = u.text.split("\n"), kept = lines.filter(l => !mine.has(l));
    if (kept.length === lines.length) continue;
    removedLine = true;
    if (!dry) writeFileThroughSymlink(u.path, kept.join("\n"));
  }
  const removed: string[] = [];
  let keptEdited = false;
  for (const [path, preflight] of targetTexts) {
    if (preflight === null) continue;
    if (!ownedDefaults(preflight)) { keptEdited = true; continue; }
    // A file edited since it was read is the user's now: re-check immediately before deleting.
    if (!dry && !ownedDefaults(readFileIfPresent(path, true))) { keptEdited = true; continue; }
    removed.push(path);
    if (!dry) rmSync(path);
  }
  return { dry_run: dry, removed_source_line: removedLine, removed_defaults: removed,
    kept_edited_defaults: keptEdited, user_conf: userConfPath(env), defaults_file: defaultsFile };
}

const describeRemoval = (r: Removal): string =>
  `${r.dry_run ? "would remove" : "removed"}: ${r.removed_source_line ? "source line from " + r.user_conf : "no source line"}; ` +
  `${r.removed_defaults.length ? r.removed_defaults.join(", ") : r.kept_edited_defaults ? `kept ${r.defaults_file} (edited, so not TAP's to delete)` : "no TAP-owned defaults file"}` +
  (!r.dry_run && (r.removed_source_line || r.removed_defaults.length) ? "; options already loaded stay until tmux restarts" : "");

/** For `tap uninstall`: the same ownership-aware removal, reported as plan lines; empty when nothing of TAP's is installed. */
export function uninstallDefaults(apply: boolean, env: NodeJS.ProcessEnv = process.env): { lines: string[]; preserved: boolean } {
  try {
    const st = status(env, false);
    const r = removeDefaults(!apply, env);
    const nothing = !st.defaults_present && !st.source_line_present && !st.stale_installs.length;
    return { lines: nothing ? [] : [describeRemoval(r)], preserved: false };
  }
  catch (error) { return { lines: [`preserved tmux defaults: ${(error as Error).message}; next: ${error instanceof TapError ? error.action : "tap tmux-defaults remove"}`], preserved: true }; }
}

export const defaultsInstalled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  try {
    const st = status(env, false);
    return st.defaults_present || st.source_line_present || st.stale_installs.length > 0;
  } catch { return true; }   // unreadable config: let uninstall surface it
};

function emit(json: boolean, fields: Record<string, unknown>, human: string): void {
  process.stdout.write(json ? `${ensureAscii(JSON.stringify({ ok: true, ...fields }))}\n` : `${human}\n`);
}

export function cmdTmuxDefaults(argv: string[]): number {
  const sub = argv[0];
  if (argv.includes("--json")) process.env.TAP_JSON = "1";   // a requested JSON error must not depend on flag order
  if (!sub || !["install", "remove", "status"].includes(sub)) {
    throw new TapError(1, "usage_error", "tap help tmux-defaults", sub ? `unknown subcommand '${displayText(sub)}'` : "needs install, remove or status");
  }
  let dry = false, json = process.env.TAP_JSON === "1", statusFlag: boolean | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run" && sub !== "status") dry = true;
    else if ((a === "--status-bar" || a === "--no-status-bar") && sub === "install") {
      if (statusFlag !== null && statusFlag !== (a === "--status-bar")) throw new TapError(1, "usage_error", "tap help tmux-defaults", "--status-bar and --no-status-bar contradict each other");
      statusFlag = a === "--status-bar";
    }
    else if (a === "--json") { json = true; process.env.TAP_JSON = "1"; }
    else throw new TapError(1, "usage_error", "tap help tmux-defaults", `unexpected '${displayText(a)}' for ${sub}`);
  }
  const env = process.env;

  if (sub === "status") {
    const st = status(env);
    const notes: string[] = [];
    if (st.live.server === "up" && st.live.ssh_sessions.length)
      notes.push(`stale SSH_CONNECTION in sessions ${st.live.ssh_sessions.join(", ")}: clear with tmux set-environment -t <session> -r SSH_CONNECTION, then restart the seats`);
    if (st.live.server === "up" && st.live.global_ssh_connection)
      notes.push("stale SSH_CONNECTION in the server's global environment (the server was started over SSH): clear with tmux set-environment -g -r SSH_CONNECTION, or new panes keep inheriting it");
    const liveValues = Object.keys(st.live.values).length
      ? " " + Object.entries(st.live.values).map(([k, v]) => `${k}=${v}`).join(" ")
      : "";
    const human = [`tmux-defaults: ${st.installed ? "installed" : "not installed"}`,
      `tmux: ${st.tmux_version ?? "not found"}${st.tmux_ok ? "" : " (TAP needs 3.2+)"}`,
      `defaults file: ${st.defaults_file} (${st.defaults_present ? (st.defaults_owned ? "present" : "present, edited or not TAP's") : "absent"})`,
      `user conf: ${st.user_conf} (${st.source_line_present ? `source line present${st.source_line_before_settings ? ", before your settings" : ", NOT before your settings"}` : "no source line"})`,
      `status bar: ${st.status_bar ? "on" : "off"}`,
      `clipboard: ${st.clipboard}${st.copy_tool_present === null ? "" : st.copy_tool_present ? " (tool present)" : " (tool MISSING; reinstall to choose another mode)"}`,
      `live: ${st.live.server}${st.live.server === "up" ? liveValues : ""}${notes.length ? "\n" + notes.join("\n") : ""}`].join("\n");
    emit(json, { ...st }, human);
    return 0;
  }
  if (sub === "remove") {
    const r = removeDefaults(dry, env);
    emit(json, { ...r }, describeRemoval(r));
    return 0;
  }

  // install
  const st = status(env, false);
  // tmux expands $ and backslashes inside double quotes, and a quote ends the
  // operand: a path with such a byte would write a line that never sources
  // TAP's file. Refuse the write instead of leaving an inert line behind.
  if (/['"\\$]/.test(st.defaults_file)) throw new TapError(1, "usage_error", "set HOME or XDG_CONFIG_HOME to a path without quotes, backslashes or $ and retry",
    `${st.defaults_file} cannot be named in a tmux source-file line`);
  const defaultsText = readFileIfPresent(st.defaults_file, true), userText = readFileIfPresent(st.user_conf, true) ?? "";
  const v = tmuxVersion();
  if (!v) throw new TapError(1, "tmux_not_found", "install tmux 3.2 or newer", "tmux is not on PATH");
  if (!v.ok) throw new TapError(1, "tmux_too_old", "upgrade tmux to 3.2 or newer", `tmux ${v.text} is older than TAP supports`);
  const owned = ownedDefaults(defaultsText);
  // A file at TAP's path that is not exactly what TAP renders is the user's now: never overwritten, never deleted.
  if (defaultsText !== null && !owned) throw new TapError(1, "defaults_modified", "tap tmux-defaults remove   (after moving your edits elsewhere)",
    `${st.defaults_file} was edited or is not TAP's; not overwriting it`);
  // The recorded spec stands while its clipboard mode is still usable; a
  // vanished tool or a changed display makes install re-choose for this
  // environment — that is what "reinstall to choose another mode" promises.
  // The status section: an explicit flag wins, then what an owned file already records (so a rerun never
  // flips it just because an earlier step created ~/.tmux.conf), then the first-timer default.
  const wantStatus = statusFlag ?? owned?.status ?? !humanHasTmuxConfig(env);
  const spec = owned && copyToolPresent(owned.mode, env) ? { ...owned, status: wantStatus } : detectSpec(env, wantStatus);
  const conf = renderDefaults(spec), line = sourceLine(st.defaults_file);
  const lines = userText ? userText.split("\n") : [];
  const marked = lines.map((l, i) => l === line ? i : -1).filter(i => i >= 0);
  // Insertion puts the marked line exactly at the first command position, so "before" admits equality.
  const placementOk = marked.length > 0 && marked.every(i => i <= firstCommandIndex(lines)) && marked.length === 1;
  const unchanged = defaultsText === conf && placementOk;
  const normalizeLine = !dry && !unchanged && marked.length > 0;   // present but misplaced or duplicated: relocate TAP's own line, touch nothing else
  if (dry && !unchanged && !json) {
    // The exact bytes a real run would write, so the receipt needs no trust.
    process.stdout.write(`would write ${st.defaults_file}:\n${conf}`);
    process.stdout.write(`would insert into ${st.user_conf} (before your own lines, creating the file if absent):\n  ${line}\n`);
  }
  if (!dry && !unchanged) {
    let wroteDefaults = false;
    try {
      writeFileThroughSymlink(st.defaults_file, conf); wroteDefaults = true;
      if (marked.length === 0) writeFileThroughSymlink(st.user_conf, insertMarkedLine(userText, line));
      else {
        const trailing = userText.endsWith("\n");
        const real = trailing ? lines.slice(0, -1) : lines;   // the trailing split artifact is not a blank line
        const kept = real.filter(l => l !== line);
        kept.splice(firstCommandIndex(kept), 0, line);
        writeFileThroughSymlink(st.user_conf, `${kept.join("\n")}${trailing ? "\n" : ""}`);
      }
    } catch (error) {
      throw new TapError(1, "config_write_failed", "fix the permissions or free space, then rerun tap tmux-defaults install",
        `${displayText((error as Error).message)}; ${wroteDefaults ? `${st.defaults_file} was written but ${st.user_conf} was not, so tmux will not load it` : "nothing was written"}`);
    }
  }
  // The live server gets the file directly: it sets options and binds, and re-sourcing the user's own
  // config to restore their overrides could re-run plugins, so TAP never does. Their settings
  // re-assert on the next tmux start, exactly as the loaded order guarantees.
  let reloaded = false;
  if (!dry && !unchanged) {
    const ns = tmuxSessionNamespace(env);
    if (ns.observable && ns.names.size > 0) {
      const r = tmux(["source-file", st.defaults_file], env);
      if (r.code !== 0) throw new TapError(1, "reload_failed", "tap tmux-defaults install   (retry), or restart tmux",
        `wrote ${st.defaults_file} and the source line in ${st.user_conf}, but the running tmux refused to load it (${displayText(r.stderr.trim()) || "no reason given"}); the settings load when tmux restarts`);
      reloaded = true;
    }
  }
  emit(json, { dry_run: dry, clipboard: spec.mode, terminal: spec.terminal, status_bar: spec.status, defaults_file: st.defaults_file, user_conf: st.user_conf, changed: !unchanged, reloaded,
    ...(dry ? { preview: { defaults_file_content: conf, source_line: line } } : {}) },
    `${dry ? "would install" : unchanged && !reloaded ? "already installed" : "installed"}: tmux defaults (clipboard=${spec.mode}${spec.terminal === "inherit" ? ", your default-terminal kept" : ""}${spec.status ? ", status bar" : ""}) in ${st.defaults_file}, source line in ${st.user_conf}` +
    `${normalizeLine ? " (source line moved back before your settings)" : ""}` +
    `${!dry && !unchanged && !reloaded ? "; a running tmux picks them up when it restarts, or now: tmux source-file " + st.defaults_file : ""}` +
    `${!dry && !unchanged && owned?.status && !spec.status ? "; the status bar already loaded stays until tmux restarts" : ""}`);
  return 0;
}
