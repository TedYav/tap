import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { MARKER, boundKey, cmdKeybinding, keybindingInstalled, renderConf, sourceLine, tapConfPath } from "../src/verbs/keybinding";
const keybindingInstalledNow = (): boolean => keybindingInstalled();

// Every effect stays under a scratch HOME and a private tmux socket inside the runner's TMUX_TMPDIR.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kb-")));
const socket = `kb-${process.pid}`;
const saved = { ...process.env };
const T = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
let n = 0, home = "";
const tap = join(root, "tap dir", "tap");

beforeAll(() => {
  expect(process.env.TMUX_TMPDIR, "run through runtime/bun/test/run.sh").toBeTruthy();
  mkdirSync(join(root, "tap dir"), { recursive: true });
  writeFileSync(tap, "#!/bin/sh\n"); chmodSync(tap, 0o755);
});
beforeEach(() => {
  home = join(root, `home${n++}`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home; delete process.env.XDG_CONFIG_HOME; delete process.env.TMUX; delete process.env.TMUX_PANE;
  process.env.TAP_TMUX_SOCKET = socket; delete process.env.TAP_TMUX_SOCKET_PATH; delete process.env.TAP_JSON;
  T("kill-server");
});
afterAll(() => {
  T("kill-server");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

const bound = (key: string): string => T("list-keys", "-T", "prefix").stdout.split("\n").find(l => boundKey(l.replace(/^bind-key\s+/, "bind-key ")) === key) ?? "";

function run(...argv: string[]): { code: number; out: string; error?: any } {
  delete process.env.TAP_JSON;
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  try { return { code: cmdKeybinding(argv), out }; }
  catch (error) { return { code: (error as any).code ?? 99, out, error }; }
  finally { (process.stdout as any).write = write; }
}
const userConf = () => join(home, ".tmux.conf");
const SRC = () => sourceLine(tapConfPath());

test("install writes TAP's conf and exactly one marked source line; a rerun is a no-op", () => {
  writeFileSync(userConf(), "set -g mouse on");  // no trailing newline
  const first = run("install", "--tap", tap);
  expect(first.code, first.out).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`set -g mouse on\n${SRC()}\n`);
  expect(readFileSync(tapConfPath(), "utf8")).toBe(renderConf("@", tap));
  const again = run("install", "--tap", tap);
  expect(again.code).toBe(0);
  expect(again.out).toContain("already installed");
  expect(readFileSync(userConf(), "utf8").split("\n").filter(l => l === SRC())).toHaveLength(1);
});

test("with no tmux.conf at all, install creates ~/.tmux.conf holding only the source line", () => {
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\n`);
});

test("an XDG tmux.conf is used when ~/.tmux.conf is absent", () => {
  const xdg = join(home, ".config", "tmux", "tmux.conf");
  mkdirSync(join(home, ".config", "tmux"), { recursive: true });
  writeFileSync(xdg, "# mine\n");
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(readFileSync(xdg, "utf8")).toBe(`# mine\n${SRC()}\n`);
  expect(existsSync(userConf())).toBe(false);
});

test("remove deletes exactly TAP's line and file; every other byte survives, including a symlinked dotfile", () => {
  const dotfiles = join(root, `dot${n}`); mkdirSync(dotfiles);
  const target = join(dotfiles, "tmux.conf");
  const original = "set -g mouse on\n\n# keep   me\nbind r source-file ~/.tmux.conf";  // no final newline
  writeFileSync(target, original);
  symlinkSync(target, userConf());
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(`${original}\n${SRC()}\n`);
  expect(run("remove").code).toBe(0);
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(`${original}\n`);   // the one newline TAP's append supplied is the only residue
  expect(existsSync(tapConfPath())).toBe(false);
});

test("remove leaves a user-edited marker line and a user-edited TAP conf alone", () => {
  expect(run("install", "--tap", tap).code).toBe(0);
  const edited = `${SRC()} # mine now`;
  writeFileSync(userConf(), `${edited}\n`);
  writeFileSync(tapConfPath(), `${readFileSync(tapConfPath(), "utf8")}bind-key g new-window\n`);
  const r = run("remove");
  expect(r.code).toBe(0);
  expect(readFileSync(userConf(), "utf8")).toBe(`${edited}\n`);
  expect(existsSync(tapConfPath())).toBe(true);
});

test("an existing prefix @ binding in the user's conf is shown and never replaced", () => {
  writeFileSync(userConf(), "bind-key -N 'mine' @ display-message hi\n");
  const r = run("install", "--tap", tap);
  expect(r.code).toBe(1);
  expect(r.error.errorClass).toBe("key_bound");
  expect(r.error.detail).toContain("display-message hi");
  expect(r.error.action).toContain("--key");
  expect(existsSync(tapConfPath())).toBe(false);
  expect(readFileSync(userConf(), "utf8")).toBe("bind-key -N 'mine' @ display-message hi\n");
});

test("a binding in a sourced file (literal, glob, relative) blocks install; root-table and other keys do not", () => {
  mkdirSync(join(home, "binds"), { recursive: true });
  writeFileSync(join(home, "binds", "keys.conf"), "bind @ split-window\n");
  writeFileSync(userConf(), "source-file ~/binds/*.conf\n");
  expect(run("install", "--tap", tap).error?.errorClass).toBe("key_bound");
  writeFileSync(userConf(), "source -q binds/keys.conf\n");
  rmSync(join(home, ".tmux.conf"));
  writeFileSync(userConf(), `source-file -q "${join(home, "binds", "keys.conf")}"\n`);
  expect(run("install", "--tap", tap).error?.errorClass).toBe("key_bound");
  writeFileSync(join(home, "binds", "keys.conf"), "bind -n @ split-window\nbind -T copy-mode @ send -X cancel\nbind g new-window\n");
  expect(run("install", "--tap", tap).code).toBe(0);
});

test("a sourced path TAP cannot resolve refuses instead of guessing", () => {
  writeFileSync(userConf(), "source-file ~/$WHERE/keys.conf\n");
  expect(run("install", "--tap", tap).error?.errorClass).toBe("config_unresolved");
});

test("a binding already live in a running server blocks install; --key picks another", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(T("bind-key", "@", "display-message", "live").status).toBe(0);
  const r = run("install", "--tap", tap);
  expect(r.error?.errorClass).toBe("key_bound");
  expect(r.error.detail).toContain("running tmux");
  expect(run("install", "--tap", tap, "--key", "g").code).toBe(0);
  expect(bound("g")).toContain("pick --pane");
  expect(bound("@")).toContain("display-message live");
});

test("install loads the binding into a running server through tmux's own parser, with a space in the tap path", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  const r = run("install", "--tap", tap);
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain("takes effect when tmux starts");
  const listed = bound("@");
  expect(listed).toContain("run-shell -b");
  expect(listed).toContain("display-popup -c '#{client_name}' -E");
  expect(listed).toContain(tap);
  expect(listed).toContain("pick --pane #{pane_id}");
  expect(run("status").code).toBe(0);
});

test("remove also unbinds the live binding, but only while it is still TAP's", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(run("remove").code).toBe(0);
  expect(bound("@")).toBe("");
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(T("bind-key", "@", "display-message", "replaced").status).toBe(0);
  expect(run("remove").code).toBe(0);
  expect(bound("@")).toContain("replaced");
});

test("unsafe or relative tap paths and bad keys are refused before any write", () => {
  for (const bad of ["rel/tap", `${root}/it's/tap`, `${root}/a#b/tap`, `${root}/a$HOME/tap`, `${root}/a"b/tap`]) {
    const r = run("install", "--tap", bad);
    expect(r.error?.errorClass, bad).toBe("usage_error");
  }
  for (const key of ["", "ab", "#", ";", "C-", "F13"]) expect(run("install", "--tap", tap, "--key", key).error?.errorClass, key).toBe("usage_error");
  expect(existsSync(tapConfPath())).toBe(false);
  expect(existsSync(userConf())).toBe(false);
});

test("--dry-run changes nothing; status reports 2 until installed and is JSON-clean", () => {
  const dry = run("install", "--tap", tap, "--dry-run");
  expect(dry.code).toBe(0); expect(dry.out).toContain("would install");
  expect(existsSync(tapConfPath())).toBe(false);
  const before = run("status", "--json");
  expect(before.code).toBe(2);
  const parsed = JSON.parse(before.out);
  expect(parsed).toMatchObject({ ok: true, installed: false, key: null });
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(JSON.parse(run("status", "--json").out)).toMatchObject({ installed: true, key: "@", tap, source_line_present: true });
  const dryRemove = run("remove", "--dry-run");
  expect(dryRemove.out).toContain("would remove");
  expect(existsSync(tapConfPath())).toBe(true);
});

test("boundKey reads only prefix-table binds", () => {
  expect(boundKey("bind-key @ foo")).toBe("@");
  expect(boundKey("bind -r -N 'a note' @ foo")).toBe("@");
  expect(boundKey("bind -T prefix @ foo")).toBe("@");
  expect(boundKey("bind -n @ foo")).toBeNull();
  expect(boundKey("bind -T copy-mode-vi @ foo")).toBeNull();
  expect(boundKey("set -g prefix C-a")).toBeNull();
  expect(boundKey("bind @ foo # comment")).toBe("@");
});

test("an older tmux or a missing one is a clear refusal (fake tmux first on PATH)", () => {
  const bin = join(root, "fakebin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho 'tmux 3.1c'\n"); chmodSync(join(bin, "tmux"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try { expect(run("install", "--tap", tap).error?.errorClass).toBe("tmux_too_old"); }
  finally { process.env.PATH = path; }
});

test("a tmux failure that is not a recognized 'no server' is unknown: install refuses, remove says it skipped the unbind", () => {
  const bin = join(root, "flakybin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in *-V*) echo 'tmux 3.4' ;; *) echo 'protocol version mismatch' >&2; exit 1 ;; esac\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    const refused = run("install", "--tap", tap);
    expect(refused.error?.errorClass).toBe("tmux_unobservable");
    expect(existsSync(tapConfPath())).toBe(false);
    expect(existsSync(userConf())).toBe(false);
    process.env.PATH = path;
    expect(run("install", "--tap", tap).code).toBe(0);              // no server: a recognized empty answer
    process.env.PATH = `${bin}:${path}`;
    const removed = run("remove", "--json");
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.out)).toMatchObject({ removed_source_line: true, live_unbind_skipped: true });
  } finally { process.env.PATH = path; }
});

// ---- review round 1: ownership, quoting grammar, uninstall, checked effects -------------------------------------
const fakeTmux = (list: "none" | "empty", reloadFails = false): string => {   // "empty": a running server with no custom bindings
  const bin = join(root, `fake${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in -L|-S) shift 2;; esac
case "$1" in
  -V) echo 'tmux 3.7c'; exit 0;;
  list-sessions) ${list === "none" ? `echo "no server running on private-test-socket" >&2; exit 1` : "echo main; exit 0"};;
  list-keys) exit 0;;
  source-file) ${reloadFails ? `echo "source-file refused" >&2; exit 1` : "exit 0"};;
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

test("reinstall never overwrites a TAP conf the user edited, and remove never deletes it", () => {
  expect(run("install", "--tap", tap).code).toBe(0);
  const edited = readFileSync(tapConfPath(), "utf8") + "bind-key g new-window\n";
  writeFileSync(tapConfPath(), edited);
  expect(run("install", "--tap", tap).error?.errorClass).toBe("tap_conf_modified");
  expect(readFileSync(tapConfPath(), "utf8")).toBe(edited);
  const r = run("remove", "--json");
  expect(JSON.parse(r.out)).toMatchObject({ removed_tap_conf: false, kept_edited_conf: true, removed_source_line: true });
  expect(readFileSync(tapConfPath(), "utf8")).toBe(edited);
});

test("a live binding that merely mentions pick --pane is not TAP's: install refuses it and remove leaves it bound", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(T("bind-key", "@", "display-message", "pick --pane lookalike").status).toBe(0);
  expect(run("install", "--tap", tap).error?.errorClass).toBe("key_bound");
  expect(run("install", "--tap", tap, "--key", "g").code).toBe(0);
  expect(T("bind-key", "g", "display-message", "pick --pane lookalike").status).toBe(0);   // user replaces TAP's g
  expect(run("remove").code).toBe(0);
  expect(bound("g")).toContain("lookalike");
});

test("quoted, escaped, chained and conditional bindings are decoded or refused, never assumed unbound", () => {
  const block = (conf: string) => { writeFileSync(userConf(), conf); const r = run("install", "--tap", tap); rmSync(userConf(), { force: true }); rmSync(tapConfPath(), { force: true }); return r; };
  for (const conf of ["bind-key '@' display-message mine\n", 'bind-key "@" display-message mine\n', "bind-key -T 'prefix' @ display-message mine\n",
    "set -g mouse on ; bind @ display-message mine\n", "bind-key \\\n  @ display-message mine\n", "bind \\@ display-message mine\n", "bind @ { display-message mine }\n"]) {
    expect(block(conf).error?.errorClass, conf).toBe("key_bound");
  }
  for (const conf of ["if-shell 'true' 'bind @ display-message mine'\n", "run-shell \"tmux bind @ display-message x\"\n", "bind $KEY display-message x\n"]) {
    expect(block(conf).error?.errorClass, conf).toBe("config_unresolved");
  }
  for (const conf of ["bind -n @ x\n", "bind -T copy-mode-vi '@' x\n", "# bind @ commented out\n", "set -g status-left '#(echo bind @)'\n"]) {
    expect(block(conf).code, conf).toBe(0);
  }
});

test("a refused reload is reported and the disk state stays for a retry; an unchanged disk repairs a missing live binding", () => {
  const bin = fakeTmux("empty", true);
  const failed = withPath(bin, () => run("install", "--tap", tap));
  expect(failed.error?.errorClass).toBe("reload_failed");
  expect(failed.error.detail).toContain("source-file refused");
  expect(readFileSync(userConf(), "utf8")).toBe(`${SRC()}\n`);
  expect(readFileSync(tapConfPath(), "utf8")).toBe(renderConf("@", tap));
  const repaired = withPath(fakeTmux("empty"), () => run("install", "--tap", tap, "--json"));     // disk unchanged; server lacks the binding
  expect(JSON.parse(repaired.out)).toMatchObject({ changed: false, reloaded: true });
});

test("a refused unbind fails remove before anything is deleted", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  const bin = join(root, `unbind${n++}`); mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" unbind-key "*) echo 'unbind refused' >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const refused = withPath(bin, () => run("remove"));
  expect(refused.error?.errorClass).toBe("unbind_failed");
  expect(existsSync(tapConfPath())).toBe(true);
  expect(readFileSync(userConf(), "utf8")).toContain(SRC());
  expect(run("remove").code).toBe(0);
});

test("tap uninstall removes the keybinding too: dry-run previews, --yes removes, an edited conf survives", async () => {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  const owned = join(home, "recorded-file"); writeFileSync(owned, "");
  const manifest = () => writeFileSync(process.env.TAP_INSTALL_MANIFEST!, JSON.stringify({ version: 1, repo: home,
    entries: [{ kind: "file", path: owned, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }] }));
  const quiet = async (argv: string[]) => { const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); }; try { return { code: await cmdUninstall(argv), out: out.join("\n") }; } finally { console.log = log; } };
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  manifest();
  const dry = await withPathAsync(fakeTmux("none"), () => quiet(["--dry-run"]));
  expect(dry.out).toContain("would remove: source line");
  expect(existsSync(tapConfPath())).toBe(true);
  const edited = readFileSync(tapConfPath(), "utf8") + "# mine\n";
  writeFileSync(tapConfPath(), edited);
  const kept = await withPathAsync(fakeTmux("none"), () => quiet(["--yes"]));
  expect(kept.out).toContain("kept");
  expect(readFileSync(tapConfPath(), "utf8")).toBe(edited);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
  writeFileSync(tapConfPath(), renderConf("@", tap)); writeFileSync(userConf(), `${SRC()}\n`); manifest();
  const gone = await withPathAsync(fakeTmux("none"), () => quiet(["--yes"]));
  expect(gone.code).toBe(0);
  expect(existsSync(tapConfPath())).toBe(false);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
});
async function withPathAsync<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try { return await fn(); } finally { process.env.PATH = path; }
}

test("a conditional or run-time source is uncertain and refuses, even when the sourced file binds the key", () => {
  const keys = join(home, "keys.conf"); writeFileSync(keys, "bind-key @ display-message mine\n");
  for (const conf of [`if-shell -F 1 'source-file ${keys}'\n`, `run-shell "tmux source ${keys}"\n`, "if '[ -f ~/x ]' 'source ~/x'\n"]) {
    writeFileSync(userConf(), conf);
    expect(run("install", "--tap", tap).error?.errorClass, conf).toBe("config_unresolved");
    expect(existsSync(tapConfPath())).toBe(false);
  }
  writeFileSync(userConf(), "run-shell '~/.tmux/plugins/tpm/tpm'\n");   // a plugin manager names no bind or source word
  expect(run("install", "--tap", tap).code).toBe(0);
});

test("changing the key unbinds the old live key first; a refused unbind rewrites nothing and keeps the record", () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  const before = readFileSync(tapConfPath(), "utf8");
  const bin = join(root, `keyunbind${n++}`); mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" unbind-key "*) echo 'unbind refused' >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const refused = withPath(bin, () => run("install", "--tap", tap, "--key", "F5"));
  expect(refused.error?.errorClass).toBe("unbind_failed");
  expect(readFileSync(tapConfPath(), "utf8")).toBe(before);       // still names @, so remove can finish the job
  expect(bound("F5")).toBe("");
  expect(run("install", "--tap", tap, "--key", "F5").code).toBe(0);
  expect(bound("@")).toBe("");
  expect(bound("F5")).toContain("run-shell");
});

test("tap uninstall removes the keybinding even when the manifest has nothing else left", async () => {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  const quiet = async (argv: string[]) => { const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); }; try { return { code: await cmdUninstall(argv), out: out.join("\n") }; } finally { console.log = log; } };
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  for (const manifest of [undefined, JSON.stringify({ version: 1, repo: home, entries: [] })]) {
    if (manifest === undefined) rmSync(process.env.TAP_INSTALL_MANIFEST, { force: true }); else writeFileSync(process.env.TAP_INSTALL_MANIFEST, manifest);
    const dry = await withPathAsync(fakeTmux("none"), () => quiet(["--dry-run"]));
    expect(dry.out, JSON.stringify(manifest)).toContain("would remove: source line");
    expect(existsSync(tapConfPath())).toBe(true);
    const done = await withPathAsync(fakeTmux("none"), () => quiet(["--yes"]));
    expect(done.code).toBe(0);
    expect(existsSync(tapConfPath())).toBe(false);
    expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
    expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);   // reinstall for the next manifest shape
  }
});

// ---- Codex review: uninstall stops, relative globs, config roots, empty TAP conf, completion, unobservable teams ------
test("uninstall stops before removing TAP when the keybinding cannot be unbound", async () => {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  const owned = join(home, "recorded-file"); writeFileSync(owned, "");
  writeFileSync(process.env.TAP_INSTALL_MANIFEST, JSON.stringify({ version: 1, repo: home,
    entries: [{ kind: "file", path: owned, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }] }));
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  const bin = join(root, `uninstall-refuse${n++}`); mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" unbind-key "*) echo 'unbind refused' >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); };
  let code: number; try { code = await withPathAsync(bin, () => cmdUninstall(["--yes"])); } finally { console.log = log; }
  expect(code, out.join("\n")).toBe(2);
  expect(existsSync(owned)).toBe(true);                 // TAP's own recorded artifact is still there
  expect(existsSync(tapConfPath())).toBe(true);
  expect(out.join("\n")).toContain("preserved tmux lookup key");
});

test("a relative glob in a sourced config is expanded from the config's directory and the working directory", () => {
  mkdirSync(join(home, "conf.d"), { recursive: true });
  writeFileSync(join(home, "conf.d", "keys.conf"), "bind @ display-message mine\n");
  writeFileSync(userConf(), "source-file conf.d/*.conf\n");
  expect(run("install", "--tap", tap).error?.errorClass).toBe("key_bound");
});

test("a missing or relative HOME is refused, and a relative XDG_CONFIG_HOME is ignored", () => {
  const saved = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(run("status").error?.errorClass).toBe("home_invalid");
    process.env.HOME = "relative/home";
    expect(run("install", "--tap", tap).error?.errorClass).toBe("home_invalid");
  } finally { process.env.HOME = saved; }
  process.env.XDG_CONFIG_HOME = "relative/xdg";
  try { expect(tapConfPath()).toBe(join(home, ".config", "tap", "tmux.conf")); } finally { delete process.env.XDG_CONFIG_HOME; }
});

test("an existing empty file at TAP's conf path is the user's: install refuses and remove keeps it", () => {
  mkdirSync(join(home, ".config", "tap"), { recursive: true });
  writeFileSync(tapConfPath(), "");
  expect(run("install", "--tap", tap).error?.errorClass).toBe("tap_conf_modified");
  expect(readFileSync(tapConfPath(), "utf8")).toBe("");
  expect(run("remove").code).toBe(0);
  expect(existsSync(tapConfPath())).toBe(true);
});

test("completion offers the keybinding subcommands and then its flags", async () => {
  const { completionCandidates } = await import("../src/completion");
  expect(completionCandidates(["tap", "keybinding", ""], 3).map(c => c.value)).toEqual(["install", "remove", "status"]);
  expect(completionCandidates(["tap", "keybinding", "i"], 3).map(c => c.value)).toEqual(["install"]);
  expect(completionCandidates(["tap", "keybinding", "install", "--"], 4).map(c => c.value)).toEqual(expect.arrayContaining(["--key", "--tap", "--dry-run"]));
});

test("global uninstall stops while the live binding is unobservable, keeping TAP and its conf for a retry", async () => {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  const owned = join(home, "recorded-file"); writeFileSync(owned, "");
  writeFileSync(process.env.TAP_INSTALL_MANIFEST, JSON.stringify({ version: 1, repo: home,
    entries: [{ kind: "file", path: owned, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }] }));
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  const bin = join(root, `mismatch${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in *-V*) echo 'tmux 3.7c' ;; *) echo 'protocol version mismatch' >&2; exit 1 ;; esac\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); };
  let code: number; try { code = await withPathAsync(bin, () => cmdUninstall(["--yes"])); } finally { console.log = log; }
  expect(code, out.join("\n")).toBe(2);
  expect(existsSync(owned)).toBe(true);
  expect(existsSync(tapConfPath())).toBe(true);
  expect(readFileSync(userConf(), "utf8")).toContain(SRC());
  const retry = await withPathAsync(fakeTmux("none"), async () => { const l = console.log; console.log = () => {}; try { return await cmdUninstall(["--yes"]); } finally { console.log = l; } });
  expect(retry).toBe(0);
  expect(existsSync(tapConfPath())).toBe(false);
});

// ---- Codex round 2 -------------------------------------------------------------------------------------------------
test("an unreadable or dangling tmux config is refused, never replaced", () => {
  writeFileSync(userConf(), "set -g mouse on\n"); chmodSync(userConf(), 0o000);
  try {
    if (process.getuid?.() !== 0) {
      expect(run("install", "--tap", tap).error?.errorClass).toBe("config_unreadable");
      expect(run("remove").error?.errorClass).toBe("config_unreadable");
    }
  } finally { chmodSync(userConf(), 0o644); }
  expect(readFileSync(userConf(), "utf8")).toBe("set -g mouse on\n");
  rmSync(userConf()); symlinkSync(join(home, "missing-target"), userConf());
  expect(run("install", "--tap", tap).error?.errorClass).toBe("config_unreadable");
  expect(lstatSync(userConf()).isSymbolicLink()).toBe(true);
  expect(existsSync(tapConfPath())).toBe(false);
});

test("--tap must name an executable file, even for a dry run", () => {
  for (const dry of [[], ["--dry-run"]]) {
    expect(run("install", "--tap", join(root, "no-such-tap"), ...dry).error?.errorClass).toBe("tap_not_executable");
    expect(run("install", "--tap", root, ...dry).error?.errorClass).toBe("tap_not_executable");
  }
  expect(existsSync(tapConfPath())).toBe(false);
  expect(existsSync(userConf())).toBe(false);
});

test("every abbreviation tmux accepts for bind-key is still a bind", () => {
  // Checked against real tmux: bi, bin, bind-, bind-k, bind-ke and bind-key all bind (b alone is ambiguous).
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  for (const name of ["bi", "bin", "bind-", "bind-k", "bind-ke", "bind-key", "bind"]) {
    expect(T(name, "F9", "display-message", "mine").status, `real tmux: ${name}`).toBe(0);
    T("unbind-key", "F9");
    writeFileSync(userConf(), `${name} @ split-window\n`);
    expect(run("install", "--tap", tap).error?.errorClass, name).toBe("key_bound");
  }
});

// ---- Sol round 3: an edited conf's live binding, and a moved XDG root -----------------------------------------------
async function uninstallWith(bin: string | null): Promise<{ code: number; out: string; artifact: string }> {
  const { cmdUninstall } = await import("../src/verbs/machine");
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  const artifact = join(home, "recorded-file"); writeFileSync(artifact, "");
  writeFileSync(process.env.TAP_INSTALL_MANIFEST, JSON.stringify({ version: 1, repo: home,
    entries: [{ kind: "file", path: artifact, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }] }));
  const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); };
  try { const code = bin ? await withPathAsync(bin, () => cmdUninstall(["--yes"])) : await cmdUninstall(["--yes"]); return { code, out: out.join("\n"), artifact }; }
  finally { console.log = log; }
}
function unreadableTmux(): string {
  const bin = join(root, `mismatch${n++}`); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in *-V*) echo 'tmux 3.7c' ;; *) echo 'protocol version mismatch' >&2; exit 1 ;; esac\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  return bin;
}

test("uninstall unbinds the loaded TAP key even when its conf was hand-edited, and keeps the edited file", async () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(bound("@")).toContain("run-shell");
  writeFileSync(tapConfPath(), `${readFileSync(tapConfPath(), "utf8")}# my harmless comment\n`);
  const done = await uninstallWith(null);
  expect(done.code, done.out).toBe(0);
  expect(bound("@")).toBe("");                                   // the loaded binding is gone, not stranded
  expect(existsSync(done.artifact)).toBe(false);                 // and TAP itself went
  expect(readFileSync(tapConfPath(), "utf8")).toContain("# my harmless comment");
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
});

test("an edited conf whose live binding cannot be read stops uninstall before TAP is removed", async () => {
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  writeFileSync(tapConfPath(), `${readFileSync(tapConfPath(), "utf8")}# my harmless comment\n`);
  const stopped = await uninstallWith(unreadableTmux());
  expect(stopped.code, stopped.out).toBe(2);
  expect(existsSync(stopped.artifact)).toBe(true);
  expect(readFileSync(userConf(), "utf8")).toContain(SRC());
});

test("an edited conf's binding that is no longer TAP's exact command is left alone", async () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(T("bind-key", "@", "display-message", "mine").status).toBe(0);   // the user rebound it by hand
  writeFileSync(tapConfPath(), `${readFileSync(tapConfPath(), "utf8")}# edited\n`);
  const done = await uninstallWith(null);
  expect(done.code, done.out).toBe(0);
  expect(bound("@")).toContain("display-message");
});

test("uninstall finds and removes an earlier install made under a different XDG_CONFIG_HOME", async () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  process.env.XDG_CONFIG_HOME = join(home, "xdg-old");
  expect(run("install", "--tap", tap).code).toBe(0);
  const oldConf = tapConfPath();
  expect(bound("@")).toContain("run-shell");
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");
  expect(keybindingInstalledNow()).toBe(true);                   // the marked line alone is enough to be found
  const done = await uninstallWith(null);
  expect(done.code, done.out).toBe(0);
  expect(bound("@")).toBe("");
  expect(existsSync(oldConf)).toBe(false);
  expect(readFileSync(userConf(), "utf8")).not.toContain(MARKER);
  expect(existsSync(done.artifact)).toBe(false);
});

test("a live TAP key whose config is out of reach (marker in the old XDG tmux.conf) stops uninstall; remove unbinds it", async () => {
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  const oldRoot = join(home, "xdg-old"); mkdirSync(join(oldRoot, "tmux"), { recursive: true });
  writeFileSync(join(oldRoot, "tmux", "tmux.conf"), "set -g mouse on\n");        // the user config tmux reads: ~/.tmux.conf is absent
  process.env.XDG_CONFIG_HOME = oldRoot;
  expect(run("install", "--tap", tap).code).toBe(0);
  expect(existsSync(userConf())).toBe(false);
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");
  expect(keybindingInstalledNow()).toBe(true);                    // the running key alone is enough to be found
  const stopped = await uninstallWith(null);
  expect(stopped.code, stopped.out).toBe(2);
  expect(stopped.out).toContain("came from a config this run cannot locate");
  expect(existsSync(stopped.artifact)).toBe(true);                // TAP is kept, so the key is not left broken
  expect(bound("@")).toContain("run-shell");
  const removed = run("remove");
  expect(removed.code, removed.out).toBe(0);
  expect(removed.out).toContain("delete its marked");
  expect(bound("@")).toBe("");
  const done = await uninstallWith(null);
  expect(done.code, done.out).toBe(0);
  expect(existsSync(done.artifact)).toBe(false);
});

test("an unreadable tmux stops uninstall even when no conf can be found for the live key", async () => {
  const oldRoot = join(home, "xdg-old"); mkdirSync(join(oldRoot, "tmux"), { recursive: true });
  writeFileSync(join(oldRoot, "tmux", "tmux.conf"), "set -g mouse on\n");
  process.env.XDG_CONFIG_HOME = oldRoot;
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");           // the marker is now out of reach
  const stopped = await uninstallWith(unreadableTmux());
  expect(stopped.code, stopped.out).toBe(2);
  expect(existsSync(stopped.artifact)).toBe(true);
});

test("an earlier XDG install that cannot be accounted for stops uninstall", async () => {
  process.env.XDG_CONFIG_HOME = join(home, "xdg-old");
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  process.env.XDG_CONFIG_HOME = join(home, "xdg-new");
  const stopped = await uninstallWith(unreadableTmux());
  expect(stopped.code, stopped.out).toBe(2);
  expect(existsSync(stopped.artifact)).toBe(true);
  expect(readFileSync(userConf(), "utf8")).toContain(MARKER);
});

// ---- Codex round 3 ---------------------------------------------------------------------------------------------------
test("abbreviated source-file, conditional bi, and combined bind flags cannot hide a prefix @ binding", () => {
  const keys = join(home, "keys.conf"); writeFileSync(keys, "bind-key @ display-message mine\n");
  writeFileSync(userConf(), `source-f ${keys}\n`);
  expect(run("install", "--tap", tap).error?.errorClass, "source-f").toBe("key_bound");
  writeFileSync(userConf(), "if-shell 'true' 'bi @ split-window'\n");
  expect(run("install", "--tap", tap).error?.errorClass, "if-shell bi").toBe("config_unresolved");
  writeFileSync(userConf(), "ru 'tmux source-file x'\n");
  expect(run("install", "--tap", tap).error?.errorClass, "ru").toBe("config_unresolved");
  writeFileSync(userConf(), "run-shell '/usr/local/bin/helper'\n");   // a path containing bin is not a command word
  expect(run("install", "--tap", tap).code).toBe(0);
  for (const line of ["bind-key -rT prefix @ split-window", "bind -nrT root x split-window\nbind -rTprefix @ split-window", "bind-key -N note -T prefix @ split-window"]) {
    expect(boundKey(line.split("\n").at(-1)!), line).toBe("@");
  }
  expect(boundKey("bind-key -rT copy-mode @ split-window")).toBeNull();
  // An attached operand is arbitrary text: -N"my note" and -Nmine-now are real tmux, and neither is the key.
  expect(T("-f", "/dev/null", "new-session", "-d", "-s", "x").status).toBe(0);
  for (const attached of ["-Nmine-now", '-N"my note"', "-N'a; b'"]) {
    expect(T("bind-key", ...(attached.startsWith("-N\"") ? ["-Nmy note"] : attached.startsWith("-N'") ? ["-Na; b"] : [attached]), "-T", "prefix", "F9", "display-message", "mine").status, attached).toBe(0);
    T("unbind-key", "F9");
    expect(boundKey(`bind-key ${attached} -T prefix @ display-message mine`), attached).toBe("@");
    writeFileSync(userConf(), `bind-key ${attached} -T prefix @ display-message mine\n`);
    expect(run("install", "--tap", tap).error?.errorClass, attached).toBe("key_bound");
  }
});

test("a dry-run uninstall refuses exactly where the real run does", async () => {
  const { cmdUninstall } = await import("../src/verbs/machine");
  expect(withPath(fakeTmux("none"), () => run("install", "--tap", tap).code)).toBe(0);
  process.env.TAP_INSTALL_MANIFEST = join(home, "install-manifest.json");
  writeFileSync(process.env.TAP_INSTALL_MANIFEST, JSON.stringify({ version: 1, repo: home, entries: [] }));
  const log = console.log; const out: string[] = []; console.log = (...a: any[]) => { out.push(a.join(" ")); };
  try { await withPathAsync(unreadableTmux(), () => cmdUninstall(["--dry-run"])); } finally { console.log = log; }
  expect(out.join("\n")).toContain("preserved tmux lookup key");
});

test("--json is honored whatever its position, even when parsing fails", () => {
  for (const argv of [["bogus", "--json"], ["install", "--bogus", "--json"], ["--json", "install", "--bogus"]]) {
    const r = run(...argv);
    expect(r.code, argv.join(" ")).toBe(1);
    expect(process.env.TAP_JSON, argv.join(" ")).toBe("1");
  }
  delete process.env.TAP_JSON;
});

test("completion offers a file position after --tap", async () => {
  const { completionCandidates } = await import("../src/completion");
  expect(completionCandidates(["tap", "keybinding", "install", "--tap", ""], 5).map(c => c.value)).toEqual(["\x1fFILES"]);
});

test("completion scopes flags to each keybinding subcommand", async () => {
  const { completionCandidates } = await import("../src/completion");
  const flags = (sub: string) => completionCandidates(["tap", "keybinding", sub, "--"], 4).map(c => c.value);
  expect(flags("install")).toEqual(expect.arrayContaining(["--key", "--tap", "--dry-run", "--json"]));
  expect(flags("remove").sort()).toEqual(["--dry-run", "--json"]);
  expect(flags("status")).toEqual(["--json"]);
});
