import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cmdKeybinding } from "../src/verbs/keybinding";
import { cmdPick, currentTeam, lookupModel, typeIntoPane } from "../src/verbs/pick";
import type { PickerTeam } from "../src/attach-picker";
import { fixtureFzf } from "./support/fzf-fixture";

// A real tmux server on a private socket, a real pty client, the real generated binding:
// prefix C-g -> display-popup -> picker -> send-keys into the pane that was active at the keypress.
const root = realpathSync(mkdtempSync(join(tmpdir(), "popup-")));
const socket = `popup-${process.pid}`;
const saved = { ...process.env };
const src = join(import.meta.dir, "../src");
afterEach(() => { delete process.env.TAP_JSON; });  // cmdPick --json sets it for its own error rendering
const T = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });

const teams = [
  { name: "alpha", state: "ok", detail: "", seats: [{ handle: "fable", harness: "claude", session: "alpha/fable", crew: false }] },
  { name: "beta", state: "ok", detail: "", seats: [{ handle: "sol", harness: "codex", session: "beta/sol", crew: true }] },
  { name: "old", state: "historical", detail: "no live seats", seats: [] },
  { name: "bad", state: "corrupt", detail: "acting registry is not valid JSON", seats: [] },
];

test("the machine-readable list: full team/handle, live state, skipped teams explained, historical omitted", () => {
  expect(lookupModel(teams)).toEqual({
    seats: [
      { target: "alpha/fable", team: "alpha", handle: "fable", harness: "claude", state: "live", crew: false },
      { target: "beta/sol", team: "beta", handle: "sol", harness: "codex", state: "live", crew: true },
    ],
    skipped: [{ team: "bad", state: "corrupt", detail: "acting registry is not valid JSON" }],
  });
});

async function stdoutOf(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  delete process.env.TAP_JSON;
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  try { return { code: await fn(), out }; } finally { (process.stdout as any).write = write; }
}
const model = () => teams as PickerTeam[];

test("--list prints the seats, as JSON on request, without a terminal or tmux", async () => {
  const chooser = async () => { throw new Error("must not open a picker"); };
  const text = await stdoutOf(() => cmdPick(["--list"], chooser as any, model));
  expect(text).toEqual({ code: 0, out: "alpha/fable\tclaude\tlive\nbeta/sol\tcodex\tlive\n" });
  const json = await stdoutOf(() => cmdPick(["--list", "--json"], chooser as any, model));
  expect(JSON.parse(json.out).seats.map((s: any) => s.target)).toEqual(["alpha/fable", "beta/sol"]);
});

test("usage refusals: bad pane id, --list with --pane, --json without --list, unknown option, no seat", async () => {
  const chooser = async () => ({ kind: "cancelled" as const });
  delete process.env.TAP_JSON;
  for (const argv of [["--pane", "main:0.0"], ["--pane"], ["--list", "--pane", "%1"], ["--json"], ["--bogus"], ["extra"]]) {
    await expect(cmdPick(argv, chooser, model), argv.join(" ")).rejects.toMatchObject({ code: 1 });
  }
  await expect(cmdPick([], chooser, () => [])).rejects.toMatchObject({ errorClass: "no_candidates" });
  // An unreadable roster is not an empty one: it must not send the operator off to launch a duplicate.
  await expect(cmdPick([], chooser, () => [{ name: "bad", state: "unobservable", detail: "seat classifier could not observe this team", seats: [] }]))
    .rejects.toMatchObject({ errorClass: "teams_unobservable", action: "tap doctor" });
});

test("the picker lists the current team first, says so, and lets that order break fzf ties; --list keeps index order", async () => {
  let seen = { targets: [] as string[], options: {} as Record<string, unknown> }, asked = "";
  const chooser = async (choices: { value: string }[], options: Record<string, unknown>) => {
    seen = { targets: choices.map(c => c.value), options }; return { kind: "cancelled" as const };
  };
  expect(await cmdPick(["--pane", "%9"], chooser as any, model, (_, pane) => { asked = pane; return "beta"; })).toBe(0);
  expect(asked).toBe("%9");
  expect(seen.targets).toEqual(["beta/sol", "alpha/fable"]);
  expect(seen.options).toMatchObject({ tiebreak: "index", header: "beta first · Type to search · Enter types the name · Esc cancels" });
  // Without --pane there is no origin pane: an ambient TMUX_PANE may belong to another tmux server than the one observed.
  const ambient = process.env.TMUX_PANE; process.env.TMUX_PANE = "%3";
  try { expect(await cmdPick([], chooser as any, model, (_, pane) => { asked = pane; return ""; })).toBe(0); }
  finally { if (ambient === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = ambient; }
  expect(asked).toBe("");
  expect(seen.targets).toEqual(["alpha/fable", "beta/sol"]);
  expect(seen.options).toMatchObject({ tiebreak: "index", header: "Type to search · Enter select · Esc cancel" });
  const list = await stdoutOf(() => cmdPick(["--list"], chooser as any, model, () => { throw new Error("--list must not resolve a current team"); }));
  expect(list.out).toBe("alpha/fable\tclaude\tlive\nbeta/sol\tcodex\tlive\n");
});

test("current team: the team whose live seat occupies the origin pane; none or two claimants is no preference", () => {
  const at = (pane: string) => ({ observedPaneId: pane });
  const seated = [{ ...teams[0]!, seats: [{ ...teams[0]!.seats[0]!, identity: at("%4") }] },
    { ...teams[1]!, seats: [{ ...teams[1]!.seats[0]!, identity: at("%5") }] }] as any as PickerTeam[];
  expect(currentTeam(seated, "%4")).toBe("alpha");
  expect(currentTeam(seated, "%5")).toBe("beta");
  expect(currentTeam(seated, "%6")).toBe("");
  expect(currentTeam(seated, "")).toBe("");
  const contested = [seated[0]!, { ...teams[1]!, seats: [{ ...teams[1]!.seats[0]!, identity: at("%4") }] }] as any as PickerTeam[];
  expect(currentTeam(contested, "%4")).toBe("");
});

test("an unvetted target is never typed: only team/handle tokens pass", () => {
  for (const bad of ["a", "a/b/c", "a/b\r", "a/b;rm", "$(x)/y", "a /b", "../b"]) {
    expect(() => typeIntoPane("%1", bad), bad).toThrow();
  }
});

// ---- real tmux: origin pane, never Enter, Esc, a pane that is not a registered seat -------------------------------
const fakeTap = join(root, "tap dir", "tap");
let home = "";
const prompt = "READY> ";

beforeAll(async () => {
  expect(process.env.TMUX_TMPDIR, "run through runtime/bun/test/run.sh").toBeTruthy();
  await fixtureFzf(process.env);
  home = join(root, "home"); mkdirSync(join(root, "tap dir"), { recursive: true }); mkdirSync(home);
  const entry = join(root, "entry.ts");
  // The chooser is the pinned fzf by default; LOOKUP_CHOOSER=list exercises the built-in fallback.
  // LOOKUP_PICK_SRC lets a mutant copy of pick.ts stand in for the real one.
  writeFileSync(entry, `const mod = await import(process.env.LOOKUP_PICK_SRC || ${JSON.stringify(join(src, "verbs/pick.ts"))});
import {pick} from ${JSON.stringify(join(src, "fzf.ts"))};
const teams = process.env.LOOKUP_TEAMS ? JSON.parse(process.env.LOOKUP_TEAMS) : ${JSON.stringify(teams)};
const current = process.env.LOOKUP_CURRENT ? () => process.env.LOOKUP_CURRENT : undefined;
import {appendFileSync} from 'node:fs';
const log = (m) => appendFileSync(${JSON.stringify(join(root, "popup.log"))}, m + '\\n');
log('start ' + process.argv.slice(2).join(' ') + ' tty=' + process.stdin.isTTY + process.stdout.isTTY);
try { process.exitCode = await mod.cmdPick(process.argv.slice(3), process.env.LOOKUP_CHOOSER==='list' ? mod.listChoose : pick, () => teams, current); }
catch (e) { log('ERR ' + e.errorClass + ':' + e.detail + ' ' + e.stack); console.error('ERR:' + e.errorClass + ':' + e.detail); process.exitCode = e.code || 1; }
log('exit ' + process.exitCode);
`);
  writeFileSync(fakeTap, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`); chmodSync(fakeTap, 0o755);
}, 60_000);
afterAll(() => {
  T("kill-server");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

const driver = String.raw`
import os,pty,subprocess,sys,select,time,fcntl,termios,struct,json,re
sock,session=sys.argv[1],sys.argv[2]; steps=json.loads(sys.argv[3])
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
def ctty(): os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
env={k:v for k,v in os.environ.items() if k not in('TMUX','TMUX_PANE')}; env['TERM']='xterm-256color'
p=subprocess.Popen(['tmux','-L',sock,'attach','-t',session],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=ctty)
data=b''
def pump(t=.05):
    global data
    if select.select([master],[],[],t)[0]:
        try: data+=os.read(master,65536)
        except OSError: pass
def until(needle):
    global data
    deadline=time.monotonic()+15
    while needle.encode() not in data:
        if time.monotonic()>deadline or p.poll() is not None: raise AssertionError('timeout waiting for '+repr(needle)+' in '+repr(re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\(B',b'',data)[-600:]))
        pump()
    data=b''
try:
    for wait,send in steps:
        until(wait); time.sleep(.25)
        os.write(master,send.encode('latin1'))
    end=time.monotonic()+2.0
    while time.monotonic()<end: pump()
finally:
    if p.poll() is None: p.terminate()
    try: p.wait(timeout=5)
    except Exception: p.kill()
`;

interface Outcome { origin: string[]; other: string[]; hist: number; log: string }
const lines = (pane: string) => T("capture-pane", "-p", "-J", "-t", pane).stdout.split("\n").map(l => l.trimEnd()).filter(Boolean);

/** Start a fresh server, bind prefix C-g through `tap keybinding install`, drive the popup from a pty client. */
function scenario(steps: [string, string][], env: Record<string, string> = {}): Outcome {
  T("kill-server"); rmSync(join(root, "popup.log"), { force: true });
  const shell = `env PS1='${prompt}' bash --norc --noprofile`;
  const serverEnv = { ...process.env, TMUX: "", TAP_TMUX_SOCKET: socket, ...env };
  expect(spawnSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "work", "-x", "120", "-y", "40", shell], { env: serverEnv }).status).toBe(0);
  expect(T("new-session", "-d", "-s", "other", "-x", "120", "-y", "40", shell).status).toBe(0);
  process.env.HOME = home; delete process.env.XDG_CONFIG_HOME; process.env.TAP_TMUX_SOCKET = socket;
  rmSync(join(home, ".tmux.conf"), { force: true });
  const code = cmdKeybinding(["install", "--tap", fakeTap]);
  expect(code).toBe(0);
  const originId = T("display-message", "-p", "-t", "work", "#{pane_id}").stdout.trim();
  const otherId = T("display-message", "-p", "-t", "other", "#{pane_id}").stdout.trim();
  expect(originId).not.toBe(otherId);
  const r = spawnSync("python3", ["-c", driver, socket, "work", JSON.stringify(steps)], { encoding: "utf8", env: { ...process.env, TMUX: "" }, timeout: 60_000 });
  expect(r.status, r.stderr.slice(-300) + (existsSync(join(root, 'popup.log')) ? readFileSync(join(root, 'popup.log'), 'utf8') : 'no popup.log')).toBe(0);
  return { origin: lines(originId), other: lines(otherId), hist: Number(T("display-message", "-p", "-t", originId, "#{history_size}").stdout),
    log: existsSync(join(root, "popup.log")) ? readFileSync(join(root, "popup.log"), "utf8") : "no popup.log" };
}
const select: [string, string][] = [["READY>", "\x02\x07"], ["Teammate >", "sol"], ["1/2", "\r"]];
const selectAndContinue: [string, string][] = [...select, ["READY> beta/sol", "x"]];
/** The invariants the feature promises, as one predicate so mutants can be shown to trip it. */
const typedOnly = (o: Outcome, typed: string) => o.origin.length === 1 && o.origin[0] === `${prompt}${typed}` && o.other.length === 1 && o.other[0] === prompt.trimEnd();

test("prefix C-g opens the popup; selection types a trailing space for continued typing, without Enter", () => {
  const o = scenario(selectAndContinue);
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}beta/sol x`]);
  expect(typedOnly(o, "beta/sol x")).toBe(true);
}, 60_000);

// fzf's default smart-case would read "Sol" as case-sensitive and match nothing ("0/2").
test("a capital in the query still finds a lowercase handle", () => {
  const o = scenario([["READY>", "\x02\x07"], ["Teammate >", "Sol"], ["1/2", "\r"]]);
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}beta/sol`]);
}, 60_000);

test("Esc closes the popup and types nothing", () => {
  const o = scenario([["READY>", "\x02\x07"], ["Teammate >", "\x1b"]]);
  expect(o.origin).toEqual([prompt.trimEnd()]);
  expect(o.other).toEqual([prompt.trimEnd()]);
}, 60_000);

test("the built-in list works without fzf: type to narrow, Enter picks, and Esc cancels at once", () => {
  const o = scenario(select.map(s => s[0] === "1/2" ? ["sol", "\r"] as [string, string] : s), { LOOKUP_CHOOSER: "list" });
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}beta/sol`]);
  const e = scenario([["READY>", "\x02\x07"], ["Teammate >", "\x1b"]], { LOOKUP_CHOOSER: "list" });
  expect(e.origin).toEqual([prompt.trimEnd()]);
}, 90_000);

test("the built-in list takes a whole chunk at once: 'sol' and Enter arriving together still select", () => {
  const o = scenario([["READY>", "\x02\x07"], ["Teammate >", "sol\r"]], { LOOKUP_CHOOSER: "list" });
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}beta/sol`]);
}, 60_000);

// RED mutants: the same scenario against a copy of pick.ts with one fault injected must trip typedOnly.
function mutant(name: string, edit: (text: string) => string): string {
  const original = readFileSync(join(src, "verbs/pick.ts"), "utf8");
  const text = edit(original.replaceAll(/from "\.\.\//g, `from "${src}/`));
  expect(text, `${name}: the mutation did not apply`).not.toBe(original.replaceAll(/from "\.\.\//g, `from "${src}/`));
  const path = join(root, `pick.${name}.ts`);
  writeFileSync(path, text);
  return path;
}
test("RED mutant: an Enter sent after the name is caught", () => {
  const path = mutant("enter", t => t.replace('const result = tmux(["send-keys", "-t", pane, "-l", "--", `${target} `], env);',
    'const result = tmux(["send-keys", "-t", pane, "-l", "--", `${target} `], env); tmux(["send-keys", "-t", pane, "Enter"], env);'));
  const o = scenario(select, { LOOKUP_PICK_SRC: path });
  expect(typedOnly(o, "beta/sol"), JSON.stringify(o)).toBe(false);
}, 60_000);

test("RED mutant: typing into the other pane instead of the captured origin is caught", () => {
  const path = mutant("pane", t => t.replace(`["send-keys", "-t", pane, "-l"`, `["send-keys", "-t", process.env.MUT_PANE || "%1", "-l"`));
  T("kill-server");
  const o = scenario(select, { LOOKUP_PICK_SRC: path, MUT_PANE: "%1" });
  expect(typedOnly(o, "beta/sol"), JSON.stringify(o)).toBe(false);
}, 60_000);

// beta/sol and zeta-team/sol score the same for "sol"; fzf's default tiebreak takes the shorter row
// ("beta/sol  codex (crew)" beats "zeta-team/sol  codex (crew)"), so only the index tiebreak picks zeta-team.
const tie = [...teams.slice(0, 2), { name: "zeta-team", state: "ok", detail: "", seats: [{ handle: "sol", harness: "codex", session: "zeta-team/sol", crew: true }] }];
const tieEnv = { LOOKUP_TEAMS: JSON.stringify(tie), LOOKUP_CURRENT: "zeta-team" };
const tieSelect: [string, string][] = [["READY>", "\x02\x07"], ["Teammate >", "sol"], ["2/3", "\r"]];
test("the same handle on two teams: Enter types the current team's seat", () => {
  const o = scenario(tieSelect, tieEnv);
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}zeta-team/sol`]);
}, 60_000);

test("RED mutant: without the index tiebreak the shorter row from another team wins", () => {
  const path = mutant("tiebreak", t => t.replace('tiebreak: "index", ', ""));
  const o = scenario(tieSelect, { ...tieEnv, LOOKUP_PICK_SRC: path });
  expect(o.origin, JSON.stringify(o)).toEqual([`${prompt}beta/sol`]);
}, 60_000);
