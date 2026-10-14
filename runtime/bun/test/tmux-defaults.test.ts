import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DefaultsSpec, MARKER, STATUS_LINES, UPDATE_ENVIRONMENT, cmdTmuxDefaults, defaultsInstalled, defaultsOptions, defaultsPath, detectClipboardMode, detectSpec, firstCommandIndex, humanHasTmuxConfig, recordedMode, renderDefaults, sourceLine } from "../src/verbs/tmux-defaults";

// Every effect stays under a scratch HOME and a private tmux socket inside the runner's TMUX_TMPDIR.
const root = realpathSync(mkdtempSync(join(tmpdir(), "td-")));
const socket = `td-${process.pid}`;
const saved = { ...process.env };
const T = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
let n = 0, home = "";

beforeAll(() => {
  expect(process.env.TMUX_TMPDIR, "run through runtime/bun/test/run.sh").toBeTruthy();
});
beforeEach(() => {
  home = join(root, `home${n++}`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home; delete process.env.XDG_CONFIG_HOME; delete process.env.TMUX; delete process.env.TMUX_PANE;
  process.env.TAP_TMUX_SOCKET = socket; delete process.env.TAP_TMUX_SOCKET_PATH; delete process.env.TAP_JSON;
  delete process.env.SSH_CONNECTION; delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
  T("kill-server");
});
afterAll(() => {
  T("kill-server");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; out: string; error?: any } {
  delete process.env.TAP_JSON;
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  try { return { code: cmdTmuxDefaults(argv), out }; }
  catch (error) { return { code: (error as any).code ?? 99, out, error }; }
  finally { (process.stdout as any).write = write; }
}
const userConf = () => join(home, ".tmux.conf");
const SRC = () => sourceLine(defaultsPath());
// The clipboard mode the installing environment chooses here (pbcopy on a local mac, osc52 over SSH);
// every byte assertion is written against it, and the mode-specific bytes get their own pure tests.
const MODE = () => detectClipboardMode();
// What install renders for on this host (mode plus the terminfo-dependent terminal pin).
const SPEC = (): DefaultsSpec => detectSpec();

test("install inserts one marked source line BEFORE the user's own lines and is idempotent", () => {
  writeFileSync(userConf(), "# mine\nset -g history-limit 99999\n");
  const first = run("install");
  expect(first.code, first.out).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`# mine\n${SRC()}\nset -g history-limit 99999\n`);
  expect(readFileSync(defaultsPath(), "utf8")).toBe(renderDefaults(SPEC()));
  expect(run("status").out.split("\n")[0]).toBe("tmux-defaults: installed");
  const again = run("install");
  expect(again.code).toBe(0);
  expect(again.out).toContain("already installed");
  expect(readFileSync(userConf(), "utf8").split("\n").filter(l => l === SRC())).toHaveLength(1);
});

test("user settings win: pre-existing bytes are untouched and the marked line sits before them", () => {
  const original = "\n\n# header\nset -g mouse off\nbind a send-prefix";   // blank lines, a comment, no trailing newline
  writeFileSync(userConf(), original);
  expect(run("install").code).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`\n\n# header\n${SRC()}\nset -g mouse off\nbind a send-prefix`);
  expect(JSON.parse(run("status", "--json").out).source_line_before_settings).toBe(true);
});

test("with no tmux.conf at all, install creates ~/.tmux.conf holding only the source line", () => {
  expect(run("install").code).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\n`);
});

test("an XDG tmux.conf is used when ~/.tmux.conf is absent", () => {
  const xdg = join(home, ".config", "tmux", "tmux.conf");
  mkdirSync(join(home, ".config", "tmux"), { recursive: true });
  writeFileSync(xdg, "# mine\n");
  expect(run("install").code).toBe(0);
  expect(readFileSync(xdg, "utf8")).toBe(`# mine\n${SRC()}\n`);
  expect(existsSync(userConf())).toBe(false);
});

test("remove deletes exactly TAP's line and the defaults file; every other byte survives, including a symlinked dotfile", () => {
  const dotfiles = join(root, `dot${n}`); mkdirSync(dotfiles);
  const target = join(dotfiles, "tmux.conf");
  const original = "# mine\nset -g mouse off";   // no final newline; TAP's line goes BEFORE the user's command
  writeFileSync(target, original);
  symlinkSync(target, userConf());
  expect(run("install").code).toBe(0);
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(`# mine\n${SRC()}\nset -g mouse off`);
  expect(run("remove").code).toBe(0);
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(original);   // byte-identical restore, no residue
  expect(existsSync(defaultsPath())).toBe(false);
  expect(defaultsInstalled()).toBe(false);
});

test("remove leaves a user-edited marker line and a user-edited defaults file alone", () => {
  expect(run("install").code).toBe(0);
  const edited = `${SRC()} # mine now`;
  writeFileSync(userConf(), `${edited}\n`);
  writeFileSync(defaultsPath(), `${readFileSync(defaultsPath(), "utf8")}set -g mouse off\n`);
  const r = run("remove");
  expect(r.code).toBe(0);
  expect(r.out).toContain("kept");
  expect(readFileSync(userConf(), "utf8")).toBe(`${edited}\n`);
  expect(existsSync(defaultsPath())).toBe(true);
});

test("reinstall never overwrites a defaults file the user edited", () => {
  expect(run("install").code).toBe(0);
  const edited = `${readFileSync(defaultsPath(), "utf8")}# mine\n`;
  writeFileSync(defaultsPath(), edited);
  const r = run("install");
  expect(r.error?.errorClass).toBe("defaults_modified");
  expect(r.error.action).toContain("tmux-defaults remove");
  expect(readFileSync(defaultsPath(), "utf8")).toBe(edited);
  expect(readFileSync(userConf(), "utf8")).toContain(SRC());
});

test("--dry-run changes nothing and prints the exact lines; status exits 0 reporting installed:false until installed and JSON-clean", () => {
  writeFileSync(userConf(), "set -g mouse off\n");
  const dry = run("install", "--dry-run");
  expect(dry.code).toBe(0); expect(dry.out).toContain("would install");
  expect(dry.out).toContain(`would write ${defaultsPath()}`);
  expect(dry.out).toContain("set -g mouse on");
  expect(dry.out).toContain(`would insert into ${userConf()}`);
  expect(dry.out).toContain(SRC());
  expect(existsSync(defaultsPath())).toBe(false);
  expect(readFileSync(userConf(), "utf8")).toBe("set -g mouse off\n");
  const before = run("status", "--json");
  expect(before.code).toBe(0);
  const parsed = JSON.parse(before.out);
  expect(parsed).toMatchObject({ ok: true, schema: 1, installed: false, defaults_present: false, source_line_present: false });
  expect(run("install").code).toBe(0);
  expect(JSON.parse(run("status", "--json").out)).toMatchObject({ installed: true, defaults_owned: true, source_line_present: true, clipboard: MODE(), terminal: SPEC().terminal });
  const dryRemove = run("remove", "--dry-run");
  expect(dryRemove.out).toContain("would remove");
  expect(existsSync(defaultsPath())).toBe(true);
});

test("--dry-run --json is one parseable JSON value carrying the exact preview bytes", () => {
  writeFileSync(userConf(), "set -g mouse off\n");
  const dry = run("install", "--dry-run", "--json");
  expect(dry.code).toBe(0);
  const parsed = JSON.parse(dry.out);   // throws unless stdout is exactly one JSON value
  expect(parsed).toMatchObject({ ok: true, dry_run: true, changed: true, defaults_file: defaultsPath(), user_conf: userConf() });
  expect(parsed.preview.source_line).toBe(SRC());
  expect(parsed.preview.defaults_file_content).toBe(renderDefaults({ mode: parsed.clipboard, terminal: parsed.terminal, status: parsed.status_bar }));
  expect(existsSync(defaultsPath())).toBe(false);
});

test("a misplaced or duplicated marked line is normalized back before the user's settings", () => {
  expect(run("install").code).toBe(0);
  const afterSettings = `set -g mouse off\n${SRC()}\n`;   // a dotfile manager merged TAP's line below the user's
  writeFileSync(userConf(), afterSettings);
  const moved = run("install", "--json");
  expect(JSON.parse(moved.out)).toMatchObject({ changed: true });
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\nset -g mouse off\n`);
  expect(JSON.parse(run("status", "--json").out)).toMatchObject({ installed: true, source_line_before_settings: true });
  writeFileSync(userConf(), `${SRC()}\n${SRC()}\n`);       // duplicated: collapse to one
  expect(run("install").code).toBe(0);
  expect(readFileSync(userConf(), "utf8").split("\n").filter(l => l === SRC())).toHaveLength(1);
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\n`);
});

test("a host without the tmux-256color terminfo entry keeps its own default-terminal", () => {
  const bin = join(root, `noinfo${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "infocmp"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "infocmp"), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try {
    expect(run("install").code).toBe(0);
    const text = readFileSync(defaultsPath(), "utf8");
    expect(text).not.toContain("default-terminal");        // pin skipped: pane programs keep the host's terminal
    expect(JSON.parse(run("status", "--json").out).options["default-terminal"]).toBeUndefined();
    expect(run("install").out).toContain("already installed");   // ownership still exact at the inherit spec
  } finally { process.env.PATH = path; }
});

test("stale SSH_CONNECTION in the server's global environment is reported with its own repair", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(T("set-environment", "-g", "SSH_CONNECTION", "1.2.3.4 5 6.7.8.9 22").status).toBe(0);
  const st = JSON.parse(run("status", "--json").out);
  expect(st.live.global_ssh_connection).toBe(true);
  expect(run("status").out).toContain("set-environment -g -r SSH_CONNECTION");
  expect(T("set-environment", "-g", "-r", "SSH_CONNECTION").status).toBe(0);
  expect(JSON.parse(run("status", "--json").out).live.global_ssh_connection).toBe(false);
});

test("a HOME that tmux quoting cannot carry refuses install instead of writing an inert line", () => {
  process.env.XDG_CONFIG_HOME = join(root, "weird$xdg");
  const r = run("install");
  expect(r.error?.errorClass).toBe("usage_error");
  expect(existsSync(defaultsPath())).toBe(false);
  expect(existsSync(userConf())).toBe(false);
});

test("remove preflights every defaults target before rewriting any source line", () => {
  process.env.XDG_CONFIG_HOME = join(home, "xdg-old");
  expect(run("install").code).toBe(0);
  const oldConf = defaultsPath();
  chmodSync(oldConf, 0o000);                               // the stale target cannot be read
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");
  try {
    if (process.getuid?.() !== 0) {
      expect(run("remove").error?.errorClass).toBe("config_unreadable");
      expect(readFileSync(userConf(), "utf8")).toContain(MARKER);   // the marker that locates the stale path survives for a retry
    }
  } finally { chmodSync(oldConf, 0o644); }
});

test("a running server is given the file directly; live values show TAP's settings; remove cannot un-apply them", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  const r = run("install", "--json");
  expect(r.code, r.out).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ changed: true, reloaded: true });
  expect(T("show", "-gv", "mouse").stdout.trim()).toBe("on");
  expect(T("show", "-gv", "history-limit").stdout.trim()).toBe("10000");
  const st = JSON.parse(run("status", "--json").out);
  expect(st.live.server).toBe("up");
  expect(st.live.values.mouse).toBe("on");
  expect(st.live.values["history-limit"]).toBe("10000");
  const removed = run("remove");
  expect(removed.code).toBe(0);
  expect(T("show", "-gv", "mouse").stdout.trim()).toBe("on");   // loaded options stay until tmux restarts, and remove says so
  expect(removed.out).toContain("until tmux restarts");
  expect(run("remove").out).toContain("no source line");   // removing again has nothing left to name
});

test("status never starts a server and reports its absence", () => {
  const st = JSON.parse(run("status", "--json").out);
  expect(st.live.server).toBe("none");
  expect(st.live.values).toEqual({});
  expect(T("list-sessions").stderr).toContain("no server running");
});

test("stale SSH_CONNECTION is reported per session with its repair, and cleared sessions vanish", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "work").status).toBe(0);
  expect(T("set-environment", "-t", "work", "SSH_CONNECTION", "1.2.3.4 5 6.7.8.9 22").status).toBe(0);
  const st = JSON.parse(run("status", "--json").out);
  expect(st.live.ssh_sessions).toEqual(["work"]);
  expect(run("status").out).toContain("set-environment -t <session> -r SSH_CONNECTION");
  expect(T("set-environment", "-t", "work", "-r", "SSH_CONNECTION").status).toBe(0);
  expect(JSON.parse(run("status", "--json").out).live.ssh_sessions).toEqual([]);
});

test("every clipboard mode renders owned bytes, and the recorded mode survives a platform change", () => {
  for (const mode of ["pbcopy", "wl-copy", "xclip", "osc52"] as const) {
    const text = renderDefaults({ mode, terminal: "pin", status: false });
    expect(text.split("\n")[0]).toBe(MARKER);
    expect(recordedMode(text)).toBe(mode);
    const options = defaultsOptions({ mode, terminal: "pin", status: false });
    if (mode === "osc52") {
      expect(options["set-clipboard"]).toBe("on");
      expect(options["copy-command"]).toBeUndefined();
      expect(text).not.toContain("copy-command");
    } else {
      expect(options["set-clipboard"]).toBe("off");
      expect(typeof options["copy-command"]).toBe("string");
      expect(text).toContain(`set -g copy-command "${options["copy-command"]}"`);
    }
    expect(options.mouse).toBe("on");
    expect(options["focus-events"]).toBe("on");
    expect(options["history-limit"]).toBe("10000");
    expect(options["update-environment"]).toBe(UPDATE_ENVIRONMENT);
    expect(recordedMode(`${text}junk`)).toBe(mode);          // the mode stays recorded even once edited; ownership is install's refusal
    expect(recordedMode("# tap-tmux-defaults\n# clipboard=ftp\n")).toBeNull();
  }
});

test("the installing environment chooses the clipboard: SSH wins, then the platform tool", () => {
  process.env.SSH_CONNECTION = "1.2.3.4 5 6.7.8.9 22";
  expect(detectClipboardMode()).toBe("osc52");
  delete process.env.SSH_CONNECTION;
  if (process.platform === "darwin") expect(detectClipboardMode()).toBe("pbcopy");
  const linux = (platform: string, vars: Record<string, string>, tools: string[]): string => {
    const bin = join(root, `bin${n++}`); mkdirSync(bin, { recursive: true });
    for (const tool of tools) { writeFileSync(join(bin, tool), "#!/bin/sh\n"); chmodSync(join(bin, tool), 0o755); }
    const path = process.env.PATH, platformSaved = (process as any).platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.assign(process.env, vars);
    process.env.PATH = `${bin}:${path}`;
    try { return detectClipboardMode(); }
    finally {
      process.env.PATH = path;
      for (const v of Object.keys(vars)) delete process.env[v];
      Object.defineProperty(process, "platform", { value: platformSaved, configurable: true });
    }
  };
  expect(linux("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, ["wl-copy", "xclip"])).toBe("wl-copy");
  expect(linux("linux", { DISPLAY: ":0" }, ["wl-copy", "xclip"])).toBe("xclip");
  expect(linux("linux", { WAYLAND_DISPLAY: "wayland-0" }, ["xclip"])).toBe("osc52");   // a tool without its display system is not a choice
  expect(linux("linux", {}, ["xclip", "wl-copy"])).toBe("osc52");                       // headless: OSC 52 is the only path that can work
  expect(linux("linux", {}, [])).toBe("osc52");
  expect(linux("linux", { WAYLAND_DISPLAY: "wayland-0" }, ["wl-copy"])).toBe("wl-copy");   // no display vars needed when a tool exists
});

test("copy_tool_present follows the recorded mode across platforms", async () => {
  const { copyToolPresent } = await import("../src/verbs/tmux-defaults");
  expect(copyToolPresent("osc52")).toBeNull();
  if (process.platform === "darwin") {
    writeFileSync(userConf(), "");
    process.env.XDG_CONFIG_HOME = home;   // irrelevant; tool checks are about PATH
    expect(copyToolPresent("pbcopy")).toBe(true);
    expect(copyToolPresent("wl-copy")).toBe(false);
  }
});

test("update-environment covers the running vanilla list minus SSH_CONNECTION; the file's 12 names are pinned (real tmux)", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "vanilla").status).toBe(0);
  const vanilla = T("show", "-gv", "update-environment").stdout.split(/\s+/).map(t => t.trim()).filter(Boolean);
  expect(vanilla).toContain("SSH_CONNECTION");
  // Vanilla differs by tmux version (3.5a: 7 names without SSH_CONNECTION; 3.7c: 12) and the managed file is
  // static, so the contract is a stable superset: SSH_CONNECTION is the only removal, nothing vanilla refreshes
  // is lost, and on tmux older than 3.7 the surplus is exactly the names later versions added.
  const ours = UPDATE_ENVIRONMENT.split(" ");
  expect([...ours].sort()).toEqual(["DISPLAY", "KRB5CCNAME", "MSYSTEM", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_AUTH_SOCK", "WAYLAND_DISPLAY", "WINDOWID", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "XDG_SESSION_TYPE"]);
  expect(ours).not.toContain("SSH_CONNECTION");
  expect(vanilla.filter(t => t !== "SSH_CONNECTION" && !ours.includes(t))).toEqual([]);
});

test("a reload the server refuses is reload_failed; the disk state stays for a retry", () => {
  const bin = join(root, `fake${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in -L|-S) shift 2;; esac
case "$1" in
  -V) echo 'tmux 3.7c'; exit 0;;
  list-sessions) echo main; exit 0;;
  source-file) echo "source-file refused" >&2; exit 1;;
  *) exit 0;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const failed = run("install");
  process.env.PATH = path;
  expect(failed.error?.errorClass).toBe("reload_failed");
  expect(failed.error.detail).toContain("source-file refused");
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\n`);
  expect(readFileSync(defaultsPath(), "utf8")).toBe(renderDefaults(SPEC()));
  const repaired = run("install");
  expect(repaired.code).toBe(0);
  expect(repaired.out).toContain("already installed");
});

test("an unreadable or dangling config is refused, never replaced", () => {
  writeFileSync(userConf(), "set -g mouse off\n"); chmodSync(userConf(), 0o000);
  try {
    if (process.getuid?.() !== 0) {
      expect(run("install").error?.errorClass).toBe("config_unreadable");
      expect(run("remove").error?.errorClass).toBe("config_unreadable");
    }
  } finally { chmodSync(userConf(), 0o644); }
  expect(readFileSync(userConf(), "utf8")).toBe("set -g mouse off\n");
  rmSync(userConf()); symlinkSync(join(home, "missing-target"), userConf());
  expect(run("install").error?.errorClass).toBe("config_unreadable");
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(existsSync(defaultsPath())).toBe(false);
});

test("a missing or relative HOME is refused, and a relative XDG_CONFIG_HOME is ignored", () => {
  const savedHome = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(run("status").error?.errorClass).toBe("home_invalid");
    process.env.HOME = "relative/home";
    expect(run("install").error?.errorClass).toBe("home_invalid");
  } finally { process.env.HOME = savedHome; }
  process.env.XDG_CONFIG_HOME = "relative/xdg";
  try { expect(defaultsPath()).toBe(join(home, ".config", "tap", "tmux-defaults.conf")); } finally { delete process.env.XDG_CONFIG_HOME; }
});

test("an earlier install under a different XDG root is reported as stale and still removed", () => {
  process.env.XDG_CONFIG_HOME = join(home, "xdg-old");
  expect(run("install").code).toBe(0);
  const oldConf = defaultsPath();
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");
  expect(defaultsInstalled()).toBe(true);
  const st = JSON.parse(run("status", "--json").out);
  expect(st.stale_installs).toEqual([oldConf]);
  expect(st.installed).toBe(false);                    // the current location has nothing yet
  expect(run("install").code).toBe(0);
  expect(JSON.parse(run("status", "--json").out).stale_installs).toEqual([oldConf]);
  expect(run("remove").code).toBe(0);
  expect(existsSync(oldConf)).toBe(false);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
});

test("an older tmux or a missing one is a clear refusal (fake tmux first on PATH)", () => {
  const bin = join(root, "fakebin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho 'tmux 3.1c'\n"); chmodSync(join(bin, "tmux"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try { expect(run("install").error?.errorClass).toBe("tmux_too_old"); }
  finally { process.env.PATH = path; }
});

test("--json is honored whatever its position, even when parsing fails", () => {
  for (const argv of [["bogus", "--json"], ["install", "--bogus", "--json"], ["--json", "install", "--bogus"]]) {
    const r = run(...argv);
    expect(r.code, argv.join(" ")).toBe(1);
    expect(process.env.TAP_JSON, argv.join(" ")).toBe("1");
  }
  delete process.env.TAP_JSON;
});

test("completion offers the subcommands and then its flags", async () => {
  const { completionCandidates } = await import("../src/completion");
  expect(completionCandidates(["tap", "tmux-defaults", ""], 3).map(c => c.value)).toEqual(["install", "remove", "status"]);
  expect(completionCandidates(["tap", "tmux-defaults", "i"], 3).map(c => c.value)).toEqual(["install"]);
  expect(completionCandidates(["tap", "tmux-defaults", "install", "--"], 4).map(c => c.value)).toEqual(expect.arrayContaining(["--dry-run", "--status-bar", "--no-status-bar", "--json"]));
  expect(completionCandidates(["tap", "tmux-defaults", "status", "--"], 4).map(c => c.value)).toEqual(["--json"]);
});

// ---- tap uninstall removes the defaults with the rest of TAP --------------------------------------------------------
const fakeTmux = (list: "none" | "empty"): string => {
  const bin = join(root, `fake${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in -L|-S) shift 2;; esac
case "$1" in
  -V) echo 'tmux 3.7c'; exit 0;;
  list-sessions) ${list === "none" ? `echo "no server running on private-test-socket" >&2; exit 1` : "echo main; exit 0"};;
  *) exit 0;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  return bin;
};
function withPath<T>(bin: string, fn: () => T): T {
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try { return fn(); } finally { process.env.PATH = path; }
}
async function uninstallWith(bin: string | null, args: string[] = ["--yes"]): Promise<{ code: number; out: string }> {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  writeFileSync(process.env.TAP_INSTALL_MANIFEST, JSON.stringify({ version: 1, repo: home, entries: [] }));
  const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); };
  try { const code = bin ? await withPath(bin, () => cmdUninstall(args)) : await cmdUninstall(args); return { code, out: out.join("\n") }; }
  finally { console.log = log; }
}

test("tap uninstall removes the defaults too: dry-run previews, --yes removes", async () => {
  expect(withPath(fakeTmux("none"), () => run("install").code)).toBe(0);
  const dry = await uninstallWith(fakeTmux("none"), ["--dry-run"]);
  expect(dry.out).toContain("would remove: source line");
  expect(existsSync(defaultsPath())).toBe(true);
  const done = await uninstallWith(fakeTmux("none"), ["--yes"]);
  expect(done.code).toBe(0);
  expect(existsSync(defaultsPath())).toBe(false);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
});

test("tap uninstall keeps an edited defaults file and still removes the source line", async () => {
  expect(withPath(fakeTmux("none"), () => run("install").code)).toBe(0);
  const edited = `${readFileSync(defaultsPath(), "utf8")}# mine\n`;
  writeFileSync(defaultsPath(), edited);
  const done = await uninstallWith(fakeTmux("none"), ["--yes"]);
  expect(done.out).toContain("kept");
  expect(readFileSync(defaultsPath(), "utf8")).toBe(edited);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
});

test("a recorded mode whose tool has vanished re-detects on install, so the reinstall advice is true", () => {
  process.env.SSH_CONNECTION = "1.2.3.4 5 6.7.8.9 22";       // install "over SSH": osc52 recorded, no tool
  expect(run("install").code).toBe(0);
  expect(readFileSync(defaultsPath(), "utf8")).toBe(renderDefaults({ mode: "osc52", terminal: "pin", status: true }));
  delete process.env.SSH_CONNECTION;
  const bin = join(root, `pbdir${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pbcopy"), "#!/bin/sh\n"); chmodSync(join(bin, "pbcopy"), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try {
    const r = run("install", "--json");                        // the SSH reason is gone and a tool exists now
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ clipboard: "pbcopy", changed: true });
    expect(readFileSync(defaultsPath(), "utf8")).toBe(renderDefaults({ mode: "pbcopy", terminal: "pin", status: true }));
    expect(run("install").out).toContain("already installed"); // and it is idempotent at the new mode
  } finally { process.env.PATH = path; }
});

test("uninstall continues when the defaults files cannot be read: they strand nothing pointing at TAP", async () => {
  expect(withPath(fakeTmux("none"), () => run("install").code)).toBe(0);
  chmodSync(defaultsPath(), 0o000);
  try {
    if (process.getuid?.() !== 0) {
      const done = await uninstallWith(fakeTmux("none"), ["--yes"]);
      expect(done.code, done.out).toBe(0);
      expect(done.out).toContain("inert");
      expect(existsSync(defaultsPath())).toBe(true);        // still unreadable to us: left for manual cleanup
      expect(readFileSync(userConf(), "utf8")).toContain(SRC());
    }
  } finally { chmodSync(defaultsPath(), 0o644); }
});

// ---- config grammar: the inserted line is parsed by tmux itself, and firstCommandIndex is honest ---------------------
test("firstCommandIndex skips blanks and comments and stops at the first command", () => {
  expect(firstCommandIndex(["# a", "", "  # b", "set -g mouse on"])).toBe(3);
  expect(firstCommandIndex(["set -g mouse on", "# c"])).toBe(0);
  expect(firstCommandIndex(["# only comments", ""])).toBe(2);
});

test("the rendered file loads through real tmux's own parser and applies its settings", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(T("source-file", renderDefaultsToFile()).status).toBe(0);
  expect(T("show", "-gv", "mouse").stdout.trim()).toBe("on");
  expect(T("show", "-gv", "focus-events").stdout.trim()).toBe("on");
  expect(T("show", "-gv", "history-limit").stdout.trim()).toBe("10000");
  expect(T("show", "-gv", "set-clipboard").stdout.trim()).toBe(MODE() === "osc52" ? "on" : "off");
  // The wheel bindings carry TAP's 10-line scroll and the middle click cancels copy mode.
  const copyMode = T("list-keys", "-T", "copy-mode").stdout;
  expect(copyMode).toContain("WheelUpPane");
  expect(copyMode).toMatch(/WheelUpPane.*-N 10 scroll-up/);
  expect(copyMode).toMatch(/WheelDownPane.*-N 10 scroll-down/);
  const copyModeVi = T("list-keys", "-T", "copy-mode-vi").stdout;
  expect(copyModeVi).toMatch(/WheelUpPane.*-N 10 scroll-up/);
  expect(T("list-keys", "-T", "root").stdout).toMatch(/MouseDown2Pane.*cancel/);
  expect(T("show", "-gv", "update-environment").stdout).not.toContain("SSH_CONNECTION");
});
function renderDefaultsToFile(): string {
  const file = join(root, `rendered${n++}.conf`);
  writeFileSync(file, renderDefaults(SPEC()));
  return file;
}

// ---- the status-bar section ---------------------------------------------------------------------------------------
const statusJson = () => JSON.parse(run("status", "--json").out);
const installed = () => readFileSync(defaultsPath(), "utf8");

test("a file written before the status section existed is still TAP's: status off renders the legacy bytes", () => {
  const spec: DefaultsSpec = { mode: "osc52", terminal: "pin", status: false };
  const legacy = renderDefaults(spec);
  expect(legacy).not.toContain("status");   // no header line, no option: byte-identical to the pre-section render
  expect(legacy.split("\n").slice(0, 4)).toEqual([MARKER, "# clipboard=osc52", "# terminal=pin", "# Managed by `tap tmux-defaults`; `tap tmux-defaults remove` deletes this file."]);
  mkdirSync(join(home, ".config", "tap"), { recursive: true });
  writeFileSync(defaultsPath(), legacy);
  writeFileSync(userConf(), `${SRC()}\nset -g mouse off\n`);
  const st = statusJson();
  expect(st.defaults_owned).toBe(true);
  expect(st.status_bar).toBe(false);
  expect(st.installed).toBe(true);
  expect(run("remove").code).toBe(0);
  expect(existsSync(defaultsPath())).toBe(false);
});

test("a first-timer with no tmux config gets the status bar by default and status --json reports it", () => {
  const r = run("install");
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("status bar");
  expect(installed()).toBe(renderDefaults({ ...SPEC(), status: true }));
  expect(installed().split("\n")[3]).toBe("# status=on");
  const st = statusJson();
  expect(st.status_bar).toBe(true);
  expect(st.options["status-left"]).toContain("#S");
});

test("an existing tmux config, at either path, gets no status bar unless --status-bar; --no-status-bar opts out either way", () => {
  writeFileSync(userConf(), "set -g history-limit 99999\n");
  expect(run("install").code).toBe(0);
  expect(installed()).not.toContain("status-style");
  expect(statusJson().status_bar).toBe(false);
  expect(run("remove").code).toBe(0);
  mkdirSync(join(home, ".config", "tmux"), { recursive: true });
  rmSync(userConf());
  writeFileSync(join(home, ".config", "tmux", "tmux.conf"), "set -g mouse off\n");
  expect(run("install").code).toBe(0);
  expect(statusJson().status_bar).toBe(false);
  expect(run("remove").code).toBe(0);
  expect(run("install", "--status-bar").code).toBe(0);
  expect(statusJson().status_bar).toBe(true);
  expect(run("remove").code).toBe(0);
  rmSync(join(home, ".config", "tmux", "tmux.conf"));
  expect(run("install", "--no-status-bar").code).toBe(0);
  expect(statusJson().status_bar).toBe(false);
});

test("TAP's own lines, a blank conf or a comment-only conf do not make a human tmux config", () => {
  writeFileSync(userConf(), `# just a note\n\nsource-file -q "/x/tmux.conf" # tap-keybinding\n`);
  expect(humanHasTmuxConfig()).toBe(false);
  expect(run("install").code).toBe(0);
  expect(statusJson().status_bar).toBe(true);
  writeFileSync(userConf(), `${readFileSync(userConf(), "utf8")}set -g mouse off\n`);
  expect(humanHasTmuxConfig()).toBe(true);
});

test("a rerun keeps the recorded status choice even though the first install created ~/.tmux.conf; a flag flips only the file", () => {
  expect(run("install").code).toBe(0);
  const confAfterFirst = readFileSync(userConf(), "utf8");
  const again = run("install");
  expect(again.out).toContain("already installed");
  expect(statusJson().status_bar).toBe(true);
  const off = run("install", "--no-status-bar");
  expect(off.code, off.out).toBe(0);
  expect(statusJson().status_bar).toBe(false);
  expect(readFileSync(userConf(), "utf8")).toBe(confAfterFirst);
  expect(run("install").out).toContain("already installed");   // the off choice is recorded too
  expect(statusJson().status_bar).toBe(false);
  expect(run("install", "--status-bar").code).toBe(0);
  expect(statusJson().status_bar).toBe(true);
});

test("contradictory or misplaced status flags are usage errors", () => {
  expect(run("install", "--status-bar", "--no-status-bar").error.code).toBe(1);
  expect(run("remove", "--status-bar").error.code).toBe(1);
  expect(run("status", "--no-status-bar").error.code).toBe(1);
});

test("--dry-run prints the exact status lines and writes nothing; --json carries them in the preview", () => {
  const text = run("install", "--status-bar", "--dry-run");
  expect(text.code).toBe(0);
  for (const line of STATUS_LINES) expect(text.out).toContain(line);
  expect(existsSync(defaultsPath())).toBe(false);
  expect(existsSync(userConf())).toBe(false);
  const json = JSON.parse(run("install", "--status-bar", "--dry-run", "--json").out);
  expect(json.status_bar).toBe(true);
  expect(json.preview.defaults_file_content).toContain("# status=on");
});

test("remove deletes a status-bar file; an edited one is kept", () => {
  expect(run("install").code).toBe(0);
  expect(run("remove").code).toBe(0);
  expect(existsSync(defaultsPath())).toBe(false);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
  expect(run("install").code).toBe(0);
  writeFileSync(defaultsPath(), `${installed()}# mine\n`);
  expect(run("remove").code).toBe(0);
  expect(existsSync(defaultsPath())).toBe(true);
});

test("the status section shows names, not indexes or hostname, and real tmux loads it with the user's own lines winning", () => {
  const section = STATUS_LINES.join("\n");
  expect(section).not.toMatch(/#I|#H|#h|#\{host/);
  expect(section).toContain("#S");
  expect(section).toContain("#W");
  const file = join(root, `status${n++}.conf`);
  writeFileSync(file, renderDefaults({ ...SPEC(), status: true }));
  const user = join(root, `userstatus${n++}.conf`);
  writeFileSync(user, `source-file -q "${file}"\nset -g status-right "mine"\n`);
  expect(T("-f", user, "new-session", "-d", "-s", "team-seat").status).toBe(0);
  expect(T("show", "-gv", "status-right").stdout.trim()).toBe("mine");
  expect(T("show", "-gv", "status-left").stdout).toContain("#S");
  expect(T("show", "-gv", "window-status-format").stdout).toBe(" #W \n");
  expect(T("display-message", "-p", "-t", "team-seat", "#{T:status-left}").stdout).toContain("team-seat");
});

test("the running server's status values match the options byte for byte, edge spaces included", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install").code).toBe(0);
  const st = statusJson();
  expect(st.live.server).toBe("up");
  for (const key of ["status-left", "status-right", "window-status-format", "window-status-current-format"]) {
    expect(st.live.values[key], key).toBe(st.options[key]);
  }
  for (const key of ["status-left", "status-right", "window-status-format"]) expect(st.options[key], key).toMatch(/^ | $/);   // the spaces the old trim() dropped
});

test("the status colours name the terminal's own colours, not tmux's surrounding-style default", () => {
  const section = STATUS_LINES.join("\n");
  expect(section).toContain("bg=terminal");
  expect(section).not.toMatch(/[bf]g=default/);
});

test("opting out of the status bar on a loaded server says its styling stays until tmux restarts", () => {
  expect(run("install").code).toBe(0);
  const off = run("install", "--no-status-bar");
  expect(off.out).toContain("status bar already loaded stays until tmux restarts");
  expect(run("install", "--status-bar").out).not.toContain("stays until tmux restarts");
});
