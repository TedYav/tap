import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, symlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { resolveContext } from "../src/context";
import { localCommand } from "../src/onboarding";

const root = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); });
function fixture(git = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tap-onboarding."))); scratch.push(base);
  const cwd = join(base, "repo"); mkdirSync(cwd);
  const env = { ...process.env, TAP_HOME: "", TAP_ONBOARDING_CHECKED: "", TAP_INDEX_HOME: join(base, "index"), HOME: join(base, "home"), PWD: cwd, XDG_CONFIG_HOME: join(base, "home", ".config"), CODEX_HOME: join(base, "home", ".codex"), CLAUDE_CONFIG_DIR: join(base, "home", ".claude"), CURSOR_DATA_DIR: join(base, "home", ".cursor") };
  mkdirSync(env.HOME); mkdirSync(env.TAP_INDEX_HOME);
  if (git) expect(spawnSync("git", ["init", "-q", cwd], { env }).status).toBe(0);
  const tap = join(base, "tap"); symlinkSync(join(root, "bin/tap"), tap);
  const run = (args: string[], where = cwd) => spawnSync(tap, args, { cwd: where, env, encoding: "utf8", timeout: 20000 });
  return { base, cwd, env, tap, run };
}

test("init appends at Git root, is idempotent, preserves contents and newline style", () => {
  for (const original of [undefined, "# keep\ncache/\n", "# missing newline", "# windows\r\ncache/\r\n", ".tap/\n", ".*\n"]) {
    const f = fixture(); const ignore = join(f.cwd, ".gitignore");
    if (original !== undefined) writeFileSync(ignore, original);
    const nested = join(f.cwd, "sub"); mkdirSync(nested);
    const first = f.run(["init", "--json"], nested);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).team.root).toBe(f.cwd);
    const wanted = original === ".tap/\n" || original === ".*\n" ? original
      : (original ?? "") + (original && !original.endsWith("\n") ? "\n" : "") + ".tap/" + (original?.includes("\r\n") ? "\r\n" : "\n");
    expect(readFileSync(ignore, "utf8")).toBe(wanted);
    expect(f.run(["init"]).status).toBe(0);
    expect(readFileSync(ignore, "utf8")).toBe(wanted);
    expect(existsSync(join(nested, ".gitignore"))).toBe(false);
  }
}, 120000);

test("init refuses symlink and directory ignore paths without replacing them", () => {
  for (const symlink of [true, false]) {
    const f = fixture(); const outside = join(f.base, "outside"); writeFileSync(outside, "keep");
    if (symlink) symlinkSync(outside, join(f.cwd, ".gitignore")); else mkdirSync(join(f.cwd, ".gitignore"));
    const r = f.run(["init"]); expect(r.status).not.toBe(0); expect(r.stderr).toContain("could not ignore");
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(false);
  }
});

test("non-Git init never writes an ancestor ignore file", () => {
  const f = fixture(false); expect(f.run(["init", "--yes"]).status).toBe(0);
  expect(existsSync(join(f.cwd, ".gitignore"))).toBe(false);
  expect(existsSync(join(f.base, ".gitignore"))).toBe(false);
});

test("linked worktree init uses that worktree root", () => {
  const f = fixture();
  expect(spawnSync("git", ["-C", f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "seed"], { env: f.env }).status).toBe(0);
  const linked = join(f.base, "linked");
  expect(spawnSync("git", ["-C", f.cwd, "worktree", "add", "-qb", "linked", linked], { env: f.env }).status).toBe(0);
  const r = f.run(["init", "--json"], linked); expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).team.root).toBe(linked);
  expect(readFileSync(join(linked, ".gitignore"), "utf8")).toBe(".tap/\n");
  expect(existsSync(join(f.cwd, ".gitignore"))).toBe(false);
  // A separately initialized linked team keeps its authority when primary joins later.
  expect(f.run(["init"]).status).toBe(0);
  expect(JSON.parse(f.run(["init","--json"],linked).stdout).team.root).toBe(linked);
  const roster=f.run(["team","--json"],linked);
  expect(roster.status,roster.stdout+roster.stderr).toBe(0);
  expect(resolveContext(linked,f.env).root).toBe(linked);
});

test("noninteractive/JSON refuse without consuming body input or creating a team", () => {
  const f = fixture();
  for (const args of [["team"], ["launch", "claude"], ["poll", "someone", "--json"], ["send", "someone", "-f", "-"]]) {
    const r = f.run(args); expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(`No TAP team in ${f.cwd}. Start one: tap session launch`);
    expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
    if (args.includes("--json")) expect(JSON.parse(r.stdout).action).toBe("tap init");
  }
  const body = join(f.base, "body"); writeFileSync(body, "body must stay unread\n"); const fd = openSync(body, "r");
  try {
    const r = spawnSync(f.tap, ["send", "someone", "-f", "-"], { cwd: f.cwd, env: f.env, stdio: [fd, "pipe", "pipe"], timeout: 20000 });
    expect(r.status).not.toBe(0); const bytes = Buffer.alloc(5); readSync(fd, bytes, 0, 5, null); expect(bytes.toString()).toBe("body ");
  } finally { closeSync(fd); }
});

// A real terminal exercises the public entry point without borrowing the operator's tmux.
function interactive(f: ReturnType<typeof fixture>, answer: string, args = ["team", "--names"], pane = true, charterAnswer = "\n") {
  // Controlled pane observation; the PTY owns real stdin and the public command.
  const bin = join(f.base, "observation-bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nprintf "1 test-tty\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
  *"pane_tty"*"session_name"*) printf '%%42\\t/dev/test-tty\\tfixture\\t123:456\\n' ;;
  *"pane_tty"*) printf '%%42\\t/dev/test-tty\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { ...f.env, PATH: pane ? `${bin}:${process.env.PATH}` : process.env.PATH };

  const python = `import os,pty,select,subprocess,sys,time,json\nmaster,slave=pty.openpty()\np=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave)\nos.close(slave)\nout=b''; sent=False; charter=False; clean_before_prompt=None; deadline=time.monotonic()+20\nwhile time.monotonic()<deadline:\n if select.select([master],[],[],0.1)[0]:\n  try: chunk=os.read(master,65536)\n  except OSError: break\n  if not chunk: break\n  out+=chunk\n  if b'Would you like to run tap init? [Y/n]' in out and not sent:\n   clean_before_prompt=not os.path.exists('.tap') and not os.path.exists('.gitignore'); os.write(master,sys.argv[2].encode()); sent=True\n if b'create one with the TAP signpost? [Y/n]' in out and not charter:\n  os.write(master,sys.argv[3].encode()); charter=True\n if p.poll() is not None: break\nif p.poll() is None: p.kill()\np.wait(); os.close(master)\nprint(json.dumps({'code':p.returncode,'output':out.decode(),'prompted':sent,'cleanBeforePrompt':clean_before_prompt}))\n`;
  const r = spawnSync("python3", ["-c", python, JSON.stringify([f.tap, ...args]), answer, charterAnswer], { cwd: f.cwd, env, encoding: "utf8", timeout: 25000 });
  expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout) as { code: number; output: string; prompted: boolean; cleanBeforePrompt: boolean | null };
}

test("real TTY in a pane defaults Yes; explicit yes initializes once and preserves retry argv", () => {
  for (const answer of ["\n", "n\n", "y\n"]) {
    const f = fixture(); const r = interactive(f, answer);
    expect(r.prompted).toBe(true);
    expect(r.cleanBeforePrompt).toBe(true);
    expect(r.output).not.toContain("Trust current directory");
    expect(existsSync(join(f.env.CODEX_HOME, "config.toml"))).toBe(false);
    expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(answer !== "n\n");
    if (answer !== "n\n") { expect(r.code, r.output).toBe(0); expect(r.output.split("initialized team")).toHaveLength(2); }
    else expect(r.code).not.toBe(0);
  }
  const f = fixture(); const r = interactive(f, "yes\n", ["team", "--names", "--online"]);
  expect(r.code, r.output).toBe(0);
  expect(r.output.split("Would you like to run tap init?")).toHaveLength(2);
  expect(r.output.split("initialized team")).toHaveLength(2);
}, 120000);

function writeConfig(f: ReturnType<typeof fixture>, text: string) {
  const dir = join(f.base, "home", ".config", "tap"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), text);
}

test("onboarding.init=auto enrolls a noninteractive first command and keeps stdout one JSON object", () => {
  const f = fixture(); writeConfig(f, '[onboarding]\ninit = "auto"\n');
  const r = f.run(["team", "--json"]);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stderr).toContain(`TAP: set up a team for ${f.cwd} automatically (onboarding.init = auto)`);
  JSON.parse(r.stdout);
  expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(true);
});

test("auto answers nothing at a real terminal and initializes once", () => {
  const f = fixture(); writeConfig(f, '[onboarding]\ninit = "auto"\n');
  const r = interactive(f, "", ["team", "--names"]);
  expect(r.prompted, r.output).toBe(false);
  expect(r.code, r.output).toBe(0);
  expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(true);
  expect(r.output).toContain("automatically (onboarding.init = auto)");
  expect(r.output).not.toContain("Trust current directory");
  expect(existsSync(join(f.env.CODEX_HOME, "config.toml"))).toBe(false);
}, 120000);

test("auto keeps the piped body intact for stdin sends", () => {
  const f = fixture(); writeConfig(f, '[onboarding]\ninit = "auto"\n');
  const body = join(f.base, "body"); writeFileSync(body, "body must stay unread\n"); const fd = openSync(body, "r");
  try {
    const r = spawnSync(f.tap, ["send", "someone", "-f", "-"], { cwd: f.cwd, env: f.env, stdio: [fd, "pipe", "pipe"], timeout: 20000 });
    const bytes = Buffer.alloc(5); readSync(fd, bytes, 0, 5, null);
    expect(bytes.toString()).toBe("body ");
    expect(r.stderr.toString()).toContain("automatically (onboarding.init = auto)");
  } finally { closeSync(fd); }
});

test("auto never fires outside a deliberate git root, or with a missing or unreadable choice", () => {
  const nonGit = fixture(false); writeConfig(nonGit, '[onboarding]\ninit = "auto"\n');
  const r0 = nonGit.run(["team"]);
  expect(r0.status).not.toBe(0);
  expect(r0.stdout + r0.stderr).toContain(`No TAP team in ${nonGit.cwd}`);
  expect(existsSync(join(nonGit.cwd, ".tap"))).toBe(false);
  const home = fixture(); writeConfig(home, '[onboarding]\ninit = "auto"\n');
  expect(spawnSync("git", ["init", "-q", home.env.HOME!], { env: home.env }).status).toBe(0);
  const r1 = home.run(["team"], home.env.HOME!);
  expect(r1.status).not.toBe(0);
  expect(existsSync(join(home.env.HOME!, ".tap"))).toBe(false);
  for (const text of ["[onboarding]\ninit = \n", "{broken"]) {
    const f = fixture(); writeConfig(f, text);
    const r = f.run(["team"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  }
});

test("init failure under auto returns its code and the original command never runs", () => {
  const f = fixture(); writeConfig(f, '[onboarding]\ninit = "auto"\n');
  mkdirSync(join(f.cwd, ".gitignore"));
  const r = f.run(["team", "--json"]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("could not ignore");
  expect(r.stdout).toBe("");
  expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(false);
}, 30000);

test("global/help and corrupt teams never offer initialization", () => {
  const f = fixture();
  for (const args of [["help"], ["presets"], ["teams"], ["provenance", "not-an-id"], ["team", "--help"], ["session", "--machine"], ["team", "reset", "--dry-run"], ["team", "nonsense"]]) {
    const r = interactive(f, "y\n", args); expect(r.prompted, r.output).toBe(false);
    expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  }
  mkdirSync(join(f.cwd, ".tap", "bus"), { recursive: true }); writeFileSync(join(f.cwd, ".tap", "bus", "registry.json"), "{broken");
  const r = interactive(f, "y\n"); expect(r.prompted).toBe(false);
  expect(readFileSync(join(f.cwd, ".tap", "bus", "registry.json"), "utf8")).toBe("{broken");
}, 120000);

test("authority and option values are distinct", () => {
  expect(localCommand(["send", "someone", "-m", "--team", "--json"])).toEqual({ json: true, bodyStdin: false });
  // tap team --stalled is a local roster form: it onboards like bare `tap team` (tap-vl8cp).
  expect(localCommand(["team", "--stalled"])).toEqual({ json: false, bodyStdin: false });
  expect(localCommand(["team", "--stalled", "--stale-after", "600", "--json"])).toEqual({ json: true, bodyStdin: false });
  for (const args of [["attach", "-i"], ["attach", "--interactive"], ["send", "elsewhere/someone", "-m", "hi"], ["poll", "me", "--team", "other"], ["read", "id"], ["reply", "id", "-f", "-"], ["session", "fork"], ["session", "fork", "seat"]]) expect(localCommand(args)).toBeNull();
});

test("a named lifecycle target is never an onboarding offer (tap-lg1a5)", () => {
  for (const verb of ["shutdown", "down", "up"]) {
    // Unnamed `tap team <verb>` stays a local-command offer...
    expect(localCommand(["team", verb])).not.toBeNull();
    // ...but an explicit named target (`tap team <verb> <team>`) must not be
    // classified local, or an unpinned operator outside any team is refused
    // with unanchored_bus/tap-init before the named override can rebind.
    expect(localCommand(["team", verb, "alias-x"])).toBeNull();
    expect(localCommand(["team", verb, "alias-x", "--yes"])).toBeNull();
  }
});


test.skipIf(process.getuid?.() === 0)("init reports an unwritable ignore file without creating the bus", () => {
  const f = fixture(); const ignore = join(f.cwd, ".gitignore");
  writeFileSync(ignore, "# keep\n"); chmodSync(ignore, 0o444);
  try {
    const r = f.run(["init", "--json"]);
    expect(r.status).not.toBe(0); expect(JSON.parse(r.stdout).error_class).toBe("gitignore_failed");
    expect(readFileSync(ignore, "utf8")).toBe("# keep\n");
    expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(false);
  } finally { chmodSync(ignore, 0o644); }
});

test("live missing team prompts, but a corrupt machine registry cannot initialize", () => {
  const f = fixture(); const marker = join(f.env.TAP_INDEX_HOME, "global-registry.json");
  writeFileSync(marker, JSON.stringify({ schema: "0.20", teams: {} }));
  const no = interactive(f, "n\n"); expect(no.prompted).toBe(true);
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  const yes = interactive(f, "y\n"); expect(readFileSync(join(f.cwd,"AGENTS.md"),"utf8")).toContain("<!-- TAP:BEGIN -->"); expect(yes.prompted).toBe(true); expect(yes.code, yes.output).toBe(0);
  const child = join(f.cwd, "child"); mkdirSync(child);
  expect(f.run(["team", "--names"], child).status).toBe(0);
  expect(existsSync(join(child, ".tap"))).toBe(false);
  const g = fixture(); const invalid = join(g.env.TAP_INDEX_HOME, "global-registry.json");
  writeFileSync(invalid, "{broken"); const bad = interactive(g, "y\n");
  expect(bad.prompted).toBe(false); expect(bad.code).not.toBe(0);
  expect(existsSync(join(g.cwd, ".tap"))).toBe(false);
});


test("fresh-repo whoami and presets name the first-run next steps without creating a team", () => {
  const f = fixture();
  for (const args of [["whoami"], ["whoami", "--json"]]) {
    const r = f.run(args);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("Start one: tap session launch <harness|preset> <name> (for example: tap launch claude newcomer)");
    expect(r.stdout + r.stderr).toContain("tap init for an empty team");
    if (args.includes("--json")) expect(JSON.parse(r.stdout).action).toBe("tap init");
    expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  }
  // An inherited TAP_JSON caller gets the same JSON action as --json.
  const inherited = spawnSync(f.tap, ["whoami"], { cwd: f.cwd, env: { ...f.env, TAP_JSON: "1" }, encoding: "utf8", timeout: 20000 });
  expect(inherited.status).toBe(1);
  expect(JSON.parse(inherited.stdout).action).toBe("tap init");
  f.env.XDG_CONFIG_HOME = join(f.env.HOME, ".config");
  expect(f.run(["presets"]).stderr).toContain("tap setup --machine");
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
});

test("init heads-up uses the root TAP block and leaves JSON clean", () => {
  const f = fixture(); const nested = join(f.cwd, "child"); mkdirSync(nested);
  expect(f.run(["init"], nested).stderr).toContain("added project TAP signpost");
  writeFileSync(join(f.cwd, "AGENTS.md"), "# Instructions\n<!-- tap:begin -->\nTAP\n<!-- tap:end -->\n");
  expect(f.run(["init"], nested).stderr).not.toContain("tap setup --repo");
  writeFileSync(join(f.cwd, "AGENTS.md"), "<!-- tap:begin -->\nunfinished");
  expect(f.run(["init"], nested).stdout).toContain("already initialized");
  const json = f.run(["init", "--json"]);
  expect(JSON.parse(json.stdout).ok).toBe(true);
  expect(json.stderr).not.toContain("tap setup --repo");
});


test("JSON bootstrap action initializes the team, then the original command succeeds", () => {
  const f = fixture();
  const refused = f.run(["team", "--json"]);
  const action = JSON.parse(refused.stdout).action;
  expect(action).toBe("tap init");
  expect(f.run(action.split(" ").slice(1)).status).toBe(0);
  expect(f.run(["team", "--json"]).status).toBe(0);
});

test("setup installs its real charter without telling the user to repeat setup", () => {
  const f = fixture();
  const setup = f.run(["setup", "--yes"]);
  expect(setup.status, setup.stderr).toBe(0);
  expect(setup.stdout + setup.stderr).not.toContain("run tap setup --repo");
  expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
  for (const args of [["init"], ["team"]]) {
    const r = f.run(args);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("run tap setup --repo");
  }
});


test("first-team init appends project instructions once and preserves existing bytes", () => {
  const f = fixture(); const path = join(f.cwd,"AGENTS.md");
  const prefix = "# Personal instructions\nKeep this exactly.\n"; writeFileSync(path,prefix);
  const first=f.run(["init"]); expect(first.status,first.stderr).toBe(0);
  const text=readFileSync(path,"utf8"); expect(text.startsWith(prefix)).toBe(true);
  expect(text).toContain("<!-- TAP:BEGIN -->"); expect(first.stderr).toContain("added project TAP signpost");
  const second=f.run(["init"]); expect(second.status).toBe(0);
  expect(readFileSync(path,"utf8")).toBe(text); expect(second.stderr).not.toContain("added project TAP signpost");
});
test("missing instructions warn once per project and install", () => {
  const f=fixture();const script=join(root,"runtime/bun/src/first-run.ts");
  const run=()=>spawnSync("bun",[script,f.cwd],{env:f.env,encoding:"utf8"});
  expect(run().stderr).toContain("no readable TAP signpost");expect(run().stderr).toBe("");
  writeFileSync(join(f.env.TAP_INDEX_HOME,"install-manifest.json"),"{}");
  expect(run().stderr).toContain("no readable TAP signpost");expect(run().stderr).toBe("");
});

test("non-Git first team explains the local charter and existing blocks remain untouched", () => {
 const f=fixture(false);const first=f.run(["init","--yes"]);expect(first.status).toBe(0);
 expect(first.stderr).toContain("in this directory (not a git repository)");
 const path=join(f.cwd,"AGENTS.md"),text=readFileSync(path,"utf8");
 expect(f.run(["init"]).stderr).not.toContain("added project TAP signpost");expect(readFileSync(path,"utf8")).toBe(text);
});


test("concurrent first-team charter writers append one complete block", async () => {
 const f=fixture();const path=join(f.cwd,"AGENTS.md");writeFileSync(path,"# Preserve me\n");
 const children=Array.from({length:8},()=>Bun.spawn(["bun",join(root,"runtime/bun/src/first-run.ts"),f.cwd,"--ensure","1"],{env:f.env,stdout:"pipe",stderr:"pipe"}));
 expect(await Promise.all(children.map(child=>child.exited))).toEqual(Array(8).fill(0));
 const text=readFileSync(path,"utf8");expect(text.startsWith("# Preserve me\n")).toBe(true);
 expect(text.match(/<!-- TAP:BEGIN -->/g)).toHaveLength(1);
 expect(text.match(/<!-- TAP:END -->/g)).toHaveLength(1);
});

test("a plain terminal without tmux prompts and continues after Yes", () => {
  const f = fixture(); const r = interactive(f, "y\n", ["team"], false);
  expect(r.prompted).toBe(true); expect(r.code, r.output).toBe(0);
  expect(r.cleanBeforePrompt).toBe(true);
  expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(true);
});
test("register and in participate in local-team consent", () => {
  expect(localCommand(["register"])).not.toBeNull();
  expect(localCommand(["in", "new-seat"])).not.toBeNull();
});

test("named team verbs prompt once before refusal and do not initialize on No", () => {
  for (const args of [["team"], ["session", "launch", "claude"], ["send", "someone", "-m", "hello"], ["register"]]) {
    const f = fixture(); const r = interactive(f, "n\n", args);
    expect(r.prompted, r.output).toBe(true);
    expect(r.cleanBeforePrompt).toBe(true);
    expect(r.output.split("Would you like to run tap init?")).toHaveLength(2);
    expect(r.output).toContain("tap init");
    expect(r.code).not.toBe(0); expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  }
}, 60000);
test("JSON in a terminal never prompts, including inherited TAP_JSON", () => {
  for (const inherited of [false, true]) {
    const f = fixture();
    if(inherited) (f.env as NodeJS.ProcessEnv).TAP_JSON="1";
    const r=interactive(f,"y\n",inherited?["team"]:["team","--json"]);
    expect(r.prompted).toBe(false);expect(r.output).toContain('"action":"tap init"');
    expect(existsSync(join(f.cwd,".tap"))).toBe(false);
  }
});

test("registration options participate without consuming their values as authority", () => {
  for(const args of [["register","bob","--mode","api"],["in","bob","--crew"],["register","bob","--digest-window","30","--include-asks"]]) {
    expect(localCommand(args)).not.toBeNull();
    const f=fixture();const r=interactive(f,"n\n",args,false);
    expect(r.prompted,r.output).toBe(true);expect(r.cleanBeforePrompt).toBe(true);
    expect(existsSync(join(f.cwd,".tap"))).toBe(false);
  }
});
test("whitespace followed by terminal EOF never accepts init", () => {
  const f=fixture();const r=interactive(f," \x04\x04",["team"],false);
  expect(r.prompted).toBe(true);expect(r.code).not.toBe(0);
  expect(existsSync(join(f.cwd,".tap"))).toBe(false);
});
test("an enrolled explicit actor short-circuits pane observation", () => {
  const f=fixture();const other=join(f.base,"other");mkdirSync(other);
  const registry=join(other,"registry.json");writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"other",worktree_root:other},seats:{alice:{status:"active",delivery:"poll"}}}));
  writeFileSync(join(f.env.TAP_INDEX_HOME,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{other:{root:other,registry_location:registry}}}));
  const bin=join(f.base,"actor-bin");mkdirSync(bin);
  const called=join(f.base,"ps-called");
  writeFileSync(join(bin,"ps"),`#!/bin/sh\ntouch '${called}'\nexit 1\n`,{mode:0o755});
  const r=spawnSync("bun",[join(root,"runtime/bun/src/onboarding.ts"),"poll","alice"],{cwd:f.cwd,env:{...f.env,PATH:`${bin}:${process.env.PATH}`},encoding:"utf8"});
  expect(r.status).toBe(0);expect(existsSync(called)).toBe(false);
});

test("initialized primary does not prevent a linked worktree from owning its team", () => {
 const f=fixture();expect(f.run(["init"]).status).toBe(0);
 expect(spawnSync("git",["-C",f.cwd,"-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","seed"],{env:f.env}).status).toBe(0);
 const linked=join(f.base,"linked");expect(spawnSync("git",["-C",f.cwd,"worktree","add","-qb","linked",linked],{env:f.env}).status).toBe(0);
 const before=f.run(["team","--json"],linked);
 expect(before.status).not.toBe(0);
 const result=f.run(["init","--json"],linked);expect(result.status).toBe(0);
 const receipt=JSON.parse(result.stdout);
 expect(receipt.already_initialized).toBe(false);
 expect(receipt.team.root).toBe(linked);
 expect(receipt.team.name).not.toBe(JSON.parse(f.run(["init","--json"]).stdout).team.name);
 const nested=join(linked,"nested");mkdirSync(nested);
 for(const where of [linked,nested]) {
  const roster=f.run(["team","--json"],where);
  expect(roster.status,roster.stdout+roster.stderr).toBe(0);
  expect(resolveContext(where,f.env).root).toBe(linked);
  const repeated=JSON.parse(f.run(["init","--json"],where).stdout);
  expect(repeated.already_initialized).toBe(true);
  expect(repeated.team.root).toBe(linked);
 }
 expect(existsSync(join(linked,".tap","bus"))).toBe(true);
 const files=[join(f.cwd,".gitignore"),join(f.cwd,"AGENTS.md"),join(f.env.TAP_INDEX_HOME,"global-registry.json")].filter(existsSync);
 const mtimes=files.map(path=>statSync(path).mtimeMs);
 const second=f.run(["init"]);expect(files.map(path=>statSync(path).mtimeMs)).toEqual(mtimes);expect(second.stdout.trim()).toBe(`already initialized: team ${JSON.parse(f.run(["init","--json"]).stdout).team.name}`);
});

test("live-index nested linked worktree cannot inherit an enrolled primary", () => {
 const f=fixture();
 writeFileSync(join(f.env.TAP_INDEX_HOME,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{}}));
 expect(f.run(["init"]).status).toBe(0);
 const primary=JSON.parse(f.run(["init","--json"]).stdout).team;
 expect(spawnSync("git",["-C",f.cwd,"-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","seed"],{env:f.env}).status).toBe(0);
 const linked=join(f.cwd,".worktrees","lane");
 expect(spawnSync("git",["-C",f.cwd,"worktree","add","-qb","lane",linked],{env:f.env}).status).toBe(0);
 const nested=join(linked,"nested");mkdirSync(nested);
 for(const where of [linked,nested]) {
  expect(()=>resolveContext(where,f.env)).toThrow("cwd-derived bus has no acting registry");
  const missing=f.run(["team","--json"],where);
  expect(missing.status).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({error_class:"unanchored_bus",action:"tap init"});
  expect(resolveContext(where,f.env,{explicitTeam:primary.name}).root).toBe(f.cwd);
 }
 const initialized=f.run(["init","--json"],linked);
 expect(initialized.status,initialized.stdout+initialized.stderr).toBe(0);
 expect(JSON.parse(initialized.stdout)).toMatchObject({already_initialized:false,team:{root:linked}});
 for(const where of [linked,nested]) {
  expect(resolveContext(where,f.env).root).toBe(linked);
  expect(f.run(["team","--json"],where).status).toBe(0);
 }
 expect(resolveContext(f.cwd,f.env).root).toBe(f.cwd);
},30000);

test("init enrolls a copied legacy registry when the machine index is live", () => {
 const f=fixture();expect(f.run(["init"]).status).toBe(0);
 writeFileSync(join(f.env.TAP_INDEX_HOME,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{}}));
 const r=f.run(["init","--json"]);expect(r.status,r.stdout+r.stderr).toBe(0);
 expect(JSON.parse(r.stdout).already_initialized).toBe(false);
 const roster=f.run(["team","--json"]);expect(roster.status,roster.stdout+roster.stderr).toBe(0);
});

test("init refuses corrupt acting registries instead of reporting already initialized", () => {
 for(const content of ["{broken",JSON.stringify({schema:"0.20",team:{name:"repo"},seats:[]})]) {
  const f=fixture();writeFileSync(join(f.env.TAP_INDEX_HOME,"global-registry.json"),JSON.stringify({schema:"0.20",teams:{}}));
  expect(f.run(["init"]).status).toBe(0);
  const path=resolveContext(f.cwd,f.env).registryPath;writeFileSync(path,content);
  const r=f.run(["init","--json"]);expect(r.status,r.stdout+r.stderr).not.toBe(0);
  expect(readFileSync(path,"utf8")).toBe(content);
 }
});

test("init preserves error modes and repeated JSON receipt fields", () => {
 const f=fixture();
 const usage=f.run(["init","--json","--bogus"]);expect(usage.status).toBe(1);
 expect(JSON.parse(usage.stdout).ok).toBe(false);
 const first=f.run(["init","--json"]);expect(first.status).toBe(0);
 const second=JSON.parse(f.run(["init","--json"]).stdout);
 for(const key of ["migrated","primary_counts","late","late_counts"])expect(second[key]).toEqual(JSON.parse(first.stdout)[key]);
 writeFileSync(join(f.env.TAP_INDEX_HOME,"global-registry.json"),"{broken");
 const human=f.run(["init"]);expect(human.status).not.toBe(0);expect(human.stdout).toBe("");expect(human.stderr).toContain("tap doctor");
});

// --- F1: native init is born live at schema 0.20 -------------------------------
function currentTeam(dir: string): string {
  const doc = JSON.parse(readFileSync(join(dir, ".tap", "team-registry.json"), "utf8"));
  expect(doc.schema).toBe("0.20"); expect(doc.seats).toEqual({}); expect(doc.agents).toBeUndefined();
  expect(existsSync(join(dir, ".tap", "bus", "registry.json"))).toBe(false);
  return doc.team.name;
}
function index(f: ReturnType<typeof fixture>) { return JSON.parse(readFileSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"), "utf8")); }

test("fresh machine: git init is born live, current, and enrolled", () => {
  const f = fixture(); const r = f.run(["init", "--json"]); expect(r.status, r.stderr).toBe(0);
  expect(index(f).schema).toBe("0.20"); expect(index(f).teams.repo.root).toBe(f.cwd);
  expect(currentTeam(f.cwd)).toBe("repo");
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "teams.json"))).toBe(false);
}, 60000);

test("fresh machine: non-git init needs consent, then enrolls that folder and registers", () => {
  const f = fixture(false);
  const refused = f.run(["init", "--json"]); expect(refused.status).toBe(1);
  const error = JSON.parse(refused.stdout);
  expect(error.error_class).toBe("confirmation_required");
  expect(error.action).toBe(`run tap init --yes in ${f.cwd}, or cd into a git repository`);
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"))).toBe(false); expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  const human = f.run(["init"]); expect(human.status).toBe(1); expect(human.stderr).toContain("next: run tap init --yes in");
  const r = f.run(["init", "--json", "--yes"]); expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, in_git: false, team: { name: "repo", root: f.cwd } });
  expect(r.stderr).toContain("is not a git repository; initializing TAP here (--yes)");
  expect(index(f).teams.repo.root).toBe(f.cwd); expect(currentTeam(f.cwd)).toBe("repo");
  // The stranger is not stranded: registration binds the enrolled folder.
  const reg = f.run(["register", "alice", "--delivery", "poll"]); expect(reg.status, reg.stdout + reg.stderr).toBe(0);
  const team = f.run(["team", "--json"]); expect(team.status, team.stderr).toBe(0); expect(team.stdout).toContain("alice");
  // A folder under an enrolled non-git root belongs to it; init never nests a team.
  const nested = join(f.cwd, "sub"); mkdirSync(nested);
  const again = JSON.parse(f.run(["init", "--json", "--yes"], nested).stdout);
  expect(again).toMatchObject({ already_initialized: true, team: { name: "repo", root: f.cwd } });
  expect(existsSync(join(nested, ".tap"))).toBe(false);
}, 60000);

test("fresh-machine init refuses an old store with the single old_store error and writes nothing", () => {
  const seeds: Array<[string, (f: ReturnType<typeof fixture>) => string]> = [
    ["teams.json", f => { const p = join(f.env.TAP_INDEX_HOME, "teams.json"); writeFileSync(p, '{"teams":{}}'); return p; }],
    ["bus registry", f => { const p = join(f.cwd, ".tap", "bus", "registry.json"); mkdirSync(join(f.cwd, ".tap", "bus"), { recursive: true }); writeFileSync(p, '{"agents":{}}'); return p; }],
    ["manifest", f => { const p = join(f.base, "sessions.json"); (f.env as Record<string, string>).TAP_SESSION_MANIFEST = p; writeFileSync(p, "{}"); return p; }],
    ["hybrid team registry", f => { const p = join(f.cwd, ".tap", "team-registry.json"); mkdirSync(join(f.cwd, ".tap"), { recursive: true }); writeFileSync(p, '{"schema":"0.20","team":{"name":"repo"},"seats":{},"agents":{"old":{}}}'); return p; }],
  ];
  for (const [label, seed] of seeds) {
    const f = fixture(); const path = seed(f); const before = readFileSync(path, "utf8");
    for (const args of [["init", "--json"], ["init"]]) {
      const r = f.run(args); expect(r.status, label).toBe(1);
      const text = args.includes("--json") ? JSON.parse(r.stdout).detail : r.stderr;
      expect(text, label).toContain(`${path} is an old TAP registry format`);
      if (args.includes("--json")) expect(JSON.parse(r.stdout).error_class).toBe("old_store");
    }
    expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json")), label).toBe(false);
    if (label !== "hybrid team registry") expect(existsSync(join(f.cwd, ".tap", "team-registry.json")), label).toBe(false);
    expect(readFileSync(path, "utf8"), label).toBe(before);
  }
}, 60000);

test("markerless first entry refuses a seated current bus registry through every door and writes nothing (F2d)", () => {
  // A current bus registry.json that holds seats belongs to no enrolled team: a fresh
  // enrollment would write .tap/team-registry.json beside it and orphan those seats.
  const seated = '{"schema":"0.20","team":{"name":"repo"},"seats":{"alice":{"status":"active","delivery":"poll"}}}';
  // A Python-compatible non-finite value is still current (lossless parser): it must not hide the seats.
  const nonFinite = '{"schema":"0.20","team":{"name":"repo"},"seats":{"alice":{"status":"active","delivery":"poll","score":NaN}}}';
  const doors: Array<[string[], string]> = [
    [["init", "--json"], seated], [["init"], seated], [["session", "launch", "claude", "alice", "--dry-run"], seated],
    [["register", "alice", "--delivery", "poll", "--json"], seated], [["init", "--json"], nonFinite],
  ];
  for (const [door, body] of doors) {
    const f = fixture(); const label = `${door.join(" ")}${body === nonFinite ? " (NaN)" : ""}`;
    const bus = join(f.cwd, ".tap", "bus"); mkdirSync(bus, { recursive: true });
    const path = join(bus, "registry.json"); writeFileSync(path, body);
    const r = f.run(door); expect(r.status, `${label}: ${r.stdout}${r.stderr}`).not.toBe(0);
    expect(r.stdout + r.stderr, label).toContain(`${path} holds seats that no machine index enrolls`);
    if (door.includes("--json")) expect(JSON.parse(r.stdout).error_class).toBe("unenrolled_seats");
    expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json")), label).toBe(false);
    expect(existsSync(join(f.cwd, ".tap", "team-registry.json")), label).toBe(false);
    expect(readFileSync(path, "utf8"), label).toBe(body);
  }
  // No seats, nothing to orphan: the first entry still enrolls.
  const f = fixture(); const bus = join(f.cwd, ".tap", "bus"); mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, "registry.json"), '{"schema":"0.20","team":{"name":"repo"},"seats":{}}');
  const r = f.run(["init", "--json"]); expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).ok).toBe(true);
}, 60000);

test("register on a markerless machine refuses a hybrid team registry before flipping the machine", () => {
  const f = fixture(); const path = join(f.cwd, ".tap", "team-registry.json"); mkdirSync(join(f.cwd, ".tap"), { recursive: true });
  const hybrid = '{"schema":"0.20","team":{"name":"repo"},"seats":{},"agents":{"old":{}}}'; writeFileSync(path, hybrid);
  const r = f.run(["register", "alice", "--delivery", "poll", "--json"]); expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stdout + r.stderr).toContain(`${path} is an old TAP registry format`);
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"))).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(hybrid);
}, 60000);

function gitFolder(f: ReturnType<typeof fixture>, name: string): string {
  const dir = join(f.base, name); mkdirSync(dir);
  expect(spawnSync("git", ["init", "-q", dir], { env: f.env }).status).toBe(0);
  return realpathSync(dir);
}

test("init derives a team name for a project with spaces, and --team overrides it", () => {
  const f = fixture(); const spaced = gitFolder(f, "My Project");
  const r = f.run(["init"], spaced); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(`team name: my-project (derived from folder 'My Project'; override with --team <name>)\nsuccessfully initialized team: my-project\nbus: ${join(spaced, ".tap", "bus")}\n`);
  expect(currentTeam(spaced)).toBe("my-project");
  expect(index(f).teams["my-project"].root).toBe(spaced);
  const again = f.run(["init"], spaced); expect(again.stdout).toBe("already initialized: team my-project\n");
  // Dots count as separators when deriving, so the slug stays launchable.
  const dotted = gitFolder(f, "Other Project.v2");
  const json = f.run(["init", "--json"], dotted); expect(json.status, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).team.name).toBe("other-project-v2");
  expect(json.stderr).toContain("team name: other-project-v2 (derived from folder 'Other Project.v2'; override with --team <name>)");
  const named = gitFolder(f, "Third Project");
  const override = f.run(["init", "--team", "mine"], named); expect(override.status, override.stderr).toBe(0);
  expect(override.stdout).toBe(`successfully initialized team: mine\nbus: ${join(named, ".tap", "bus")}\n`);
  expect(currentTeam(named)).toBe("mine"); expect(index(f).teams.mine.root).toBe(named);
}, 60000);

test("init keeps a valid folder name byte for byte", () => {
  const f = fixture(); const valid = gitFolder(f, "Tap_Site.v1");
  const r = f.run(["init"], valid); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe(`successfully initialized team: Tap_Site.v1\nbus: ${join(valid, ".tap", "bus")}\n`);
  expect(currentTeam(valid)).toBe("Tap_Site.v1");
}, 60000);

test("init refuses an invalid --team and an empty slug before any write, naming --team", () => {
  for (const [label, name, args, detail] of [
    ["invalid --team", "Good Project", ["--team", "bad name"], "--team 'bad name' is not a launchable TAP team name"],
    ["dotted --team", "Good Project", ["--team", "my.team"], "--team 'my.team' is not a launchable TAP team name"],
    ["empty slug", "@@ __", [], "directory name '@@ __' yields no valid TAP team name"],
  ] as const) {
    const f = fixture(); const dir = gitFolder(f, name);
    const r = f.run(["init", "--json", ...args], dir); expect(r.status, label).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.error_class, label).toBe("invalid_team_name"); expect(out.detail, label).toBe(detail);
    expect(out.action, label).toContain("--team <name>");
    expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json")), label).toBe(false);
    expect(existsSync(join(dir, ".tap")), label).toBe(false);
  }
}, 60000);

test("init on an unenrolled root keeps the team name its current registry declares", () => {
  const f = fixture(); const dir = gitFolder(f, "Retired Project");
  expect(f.run(["init"], dir).status).toBe(0);
  // tap admin retire removes only the index entry; the registry keeps its bytes.
  const path = join(dir, ".tap", "team-registry.json"); const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.team.name = "kept-name"; writeFileSync(path, JSON.stringify(doc));
  const retire = () => { const idx = index(f); idx.teams = {}; writeFileSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"), JSON.stringify(idx)); };
  retire();
  const conflict = f.run(["init", "--json", "--team", "other"], dir); expect(conflict.status).toBe(1);
  const refusal = JSON.parse(conflict.stdout);
  expect(refusal.error_class).toBe("team_name_conflict");
  expect(refusal.detail).toBe(`${path} already declares team 'kept-name', not 'other'`);
  expect(refusal.action).toContain("pass --team kept-name");
  expect(index(f).teams).toEqual({});
  const plain = f.run(["init"], dir); expect(plain.status, plain.stderr).toBe(0);
  expect(plain.stdout).toBe(`successfully initialized team: kept-name\nbus: ${join(dir, ".tap", "bus")}\n`);
  expect(Object.keys(index(f).teams)).toEqual(["kept-name"]); expect(currentTeam(dir)).toBe("kept-name");
  retire();
  expect(f.run(["init", "--team", "kept-name"], dir).status).toBe(0);
  expect(Object.keys(index(f).teams)).toEqual(["kept-name"]);
}, 60000);

test("setup forwards --team to init", () => {
  const f = fixture(); const dir = gitFolder(f, "Setup Project");
  const r = f.run(["setup", "--yes", "--team", "chosen"], dir); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("successfully initialized team: chosen\n");
  expect(currentTeam(dir)).toBe("chosen");
}, 60000);

test("register on a fresh project with spaces enrolls the derived team", () => {
  const f = fixture(); const dir = gitFolder(f, "Fresh Project");
  const r = f.run(["register", "alice", "--delivery", "poll", "--json"], dir); expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(index(f).teams["fresh-project"].root).toBe(dir);
  const doc = JSON.parse(readFileSync(join(dir, ".tap", "team-registry.json"), "utf8"));
  expect(doc.team.name).toBe("fresh-project"); expect(Object.keys(doc.seats)).toEqual(["alice"]);
}, 60000);

test("init recreates a lost enrolled registry", () => {
  const f = fixture();
  expect(f.run(["init"]).status).toBe(0);
  const registry = join(f.cwd, ".tap", "team-registry.json"); unlinkSync(registry);
  unlinkSync(join(f.cwd, "AGENTS.md"));
  const again = JSON.parse(f.run(["init", "--json"]).stdout);
  expect(again.already_initialized).toBe(false); expect(currentTeam(f.cwd)).toBe("repo");
  expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
  // Recreation re-enrolls under the index ladder, so a racing gone-team purge cannot strand it.
  expect(realpathSync(index(f).teams.repo.registry_location)).toBe(realpathSync(registry));
  // An enrolled registry that exists but cannot be read is never overwritten.
  const bytes = readFileSync(registry, "utf8"); chmodSync(registry, 0o000);
  try {
    const refused = f.run(["init", "--json"]); expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(JSON.parse(refused.stdout).error_class).toBe("registry_unreachable");
  } finally { chmodSync(registry, 0o644); }
  expect(readFileSync(registry, "utf8")).toBe(bytes);
}, 60000);

test("scratch-only tmp/tap does not block init or move its contents", () => {
  const f = fixture(), scratch = join(f.cwd, "tmp", "tap");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "notes.md"), "keep");
  const result = f.run(["init", "--json"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(existsSync(join(f.cwd, ".tap", "bus"))).toBe(true);
  expect(readFileSync(join(scratch, "notes.md"), "utf8")).toBe("keep");
});

test("new enrollment refuses legacy tmp/tap state before any write and leaves its bytes intact", () => {
  const cases: Array<[string, boolean, (f: ReturnType<typeof fixture>) => void, string]> = [
    ["tmp/tap alone", true, () => {}, "old_store"],
    ["non-git without consent", false, () => {}, "old_store"],
    ["tmp/tap plus an old bus registry", true, f => { mkdirSync(join(f.cwd, ".tap", "bus"), { recursive: true }); writeFileSync(join(f.cwd, ".tap", "bus", "registry.json"), '{"agents":{}}'); }, "old_store"],
  ];
  for (const [label, git, extra, errorClass] of cases) {
    const f = fixture(git); const legacy = join(f.cwd, "tmp", "tap", "payloads"); mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "x.md"), "keep\n");
    writeFileSync(join(legacy, "..", "registry.json"), '{"schema":"0.20","seats":{}}\n'); extra(f);
    const r = f.run(["init", "--json"]); expect(r.status, label).toBe(1);
    expect(JSON.parse(r.stdout).error_class, label).toBe(errorClass);
    expect(readFileSync(join(legacy, "x.md"), "utf8"), label).toBe("keep\n");
    expect(existsSync(join(f.env.TAP_INDEX_HOME, "global-registry.json")), label).toBe(false);
    expect(existsSync(join(f.cwd, ".tap", "team-registry.json")), label).toBe(false);
    expect(existsSync(join(f.cwd, ".tap", "bus", "payloads")), label).toBe(false);
  }
}, 60000);

test("an unobservable git refuses a new enrollment on a live machine and writes nothing", () => {
  const f = fixture(false); const shim = join(f.base, "shim"); mkdirSync(shim);
  writeFileSync(join(shim, "git"), "#!/bin/sh\necho 'fatal: simulated git failure' >&2\nexit 1\n"); chmodSync(join(shim, "git"), 0o755);
  const gpath = join(f.env.TAP_INDEX_HOME, "global-registry.json"); writeFileSync(gpath, '{"schema":"0.20","teams":{}}\n');
  const r = spawnSync(f.tap, ["init", "--json", "--yes"], { cwd: f.cwd, env: { ...f.env, PATH: `${shim}:${process.env.PATH}` }, encoding: "utf8", timeout: 20000 });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("git_unobservable");
  expect(readFileSync(gpath, "utf8")).toBe('{"schema":"0.20","teams":{}}\n');
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
}, 60000);

test("predictable new-enrollment refusals land before any write", () => {
  // A system-temporary root with no index pin: refused before .gitignore, bus or marker.
  const tmp = fixture(); const unpinned = { ...tmp.env, TAP_INDEX_HOME: "" };
  const t = spawnSync(tmp.tap, ["init", "--json"], { cwd: tmp.cwd, env: unpinned, encoding: "utf8", timeout: 20000 });
  expect(t.status, t.stdout + t.stderr).toBe(1); expect(JSON.parse(t.stdout).error_class).toBe("temporary_root");
  expect(existsSync(join(tmp.cwd, ".tap"))).toBe(false); expect(existsSync(join(tmp.cwd, ".gitignore"))).toBe(false);
  expect(existsSync(join(tmp.env.HOME, ".tap", "global-registry.json"))).toBe(false);
  // A corrupt canonical registry at an unenrolled root: refused before the marker is published.
  const bad = fixture(); mkdirSync(join(bad.cwd, ".tap")); writeFileSync(join(bad.cwd, ".tap", "team-registry.json"), "{broken");
  const b = bad.run(["init", "--json"]); expect(b.status).toBe(1); expect(JSON.parse(b.stdout).error_class).toBe("registry_invalid");
  expect(existsSync(join(bad.env.TAP_INDEX_HOME, "global-registry.json"))).toBe(false); expect(existsSync(join(bad.cwd, ".tap", "bus"))).toBe(false);
  expect(readFileSync(join(bad.cwd, ".tap", "team-registry.json"), "utf8")).toBe("{broken");
  // The same team name at a second live root: refused before its bus, ignore rule or team file.
  const f = fixture(); expect(f.run(["init"]).status).toBe(0);
  const other = join(f.base, "elsewhere", "repo"); mkdirSync(other, { recursive: true });
  expect(spawnSync("git", ["init", "-q", other], { env: f.env }).status).toBe(0);
  const before = readFileSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"), "utf8");
  const c = f.run(["init", "--json"], other); expect(c.status).toBe(1);
  expect(JSON.parse(c.stdout)).toMatchObject({ error_class: "name_collision" });
  expect(JSON.parse(c.stdout).detail).toContain(`(${f.cwd}, not ${realpathSync(other)})`);
  expect(existsSync(join(other, ".tap"))).toBe(false); expect(existsSync(join(other, ".gitignore"))).toBe(false);
  expect(readFileSync(join(f.env.TAP_INDEX_HOME, "global-registry.json"), "utf8")).toBe(before);
}, 90000);

test("offline roster filter retains fresh-repo onboarding", () => {
  for (const args of [["team", "--offline"], ["team", "roster", "--offline", "--names"]]) {
    const f = fixture(); const r = interactive(f, "yes\n", args);
    expect(r.prompted, r.output).toBe(true);
    expect(r.code, r.output).toBe(0);
    expect(r.output.split("initialized team")).toHaveLength(2);
  }
  expect(localCommand(["team", "roster", "foreign", "--offline"])).toBeNull();
}, 60_000);

test("a seat filter is a local roster form, and an invalid one never reaches onboarding", () => {
  expect(localCommand(["team", "--harness", "codex"])).toEqual({ json: false, bodyStdin: false });
  expect(localCommand(["team", "--json", "--state=idle,active"])).toEqual({ json: true, bodyStdin: false });
  expect(localCommand(["team", "roster", "--model", "opus"])).toEqual({ json: false, bodyStdin: false });
  expect(localCommand(["team", "--online"])).toEqual({ json: false, bodyStdin: false });
  expect(localCommand(["team", "--state", "sleeping"])).toBeNull();
  expect(localCommand(["team", "--harness"])).toBeNull();
  expect(localCommand(["team", "roster", "foreign", "--model", "opus"])).toBeNull();
});

test("offline onboarding is limited to roster and registration verbs", () => {
  for (const args of [["send", "bob", "-m", "hi", "--offline"], ["poll", "bob", "--offline"], ["team", "down", "--offline"], ["team", "--offline", "roster"], ["team", "--offline", "--online"], ["team", "--offline", "--names", "--json"], ["team", "roster", "--offline", "--force"]]) {
    const f = fixture(); const r = interactive(f, "yes\n", args);
    expect(r.prompted, r.output).toBe(false);
    expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
    expect(existsSync(join(f.cwd, ".gitignore"))).toBe(false);
    expect(localCommand(args)).toBeNull();
  }
  for (const verb of ["register", "in"]) {
    expect(localCommand([verb, "bob", "--offline"])).toEqual({json: false, bodyStdin: false});
  }
}, 60_000);


test("first-launch init prompts once, respects No, and leaves existing teams inert", () => {
  const f = fixture();
  const declined = interactive(f, "", ["init", "--for-launch"], false, "n\n");
  expect(declined.code, declined.output).toBe(0);
  expect(declined.output.split("create one with the TAP signpost?")).toHaveLength(2);
  expect(declined.output).toContain("run tap setup --repo");
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(f.cwd, ".tap/team-registry.json"))).toBe(true);
  const repeated = interactive(f, "", ["init", "--no-trust-folders"], false);
  expect(repeated.code, repeated.output).toBe(0);
  expect(repeated.output).not.toContain("create one with the TAP signpost?");
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
});

test("public launch offers normal init and installs instructions before launcher refusal", () => {
  const f = fixture();
  // Invalid target prevents a real harness startup after the public init offer.
  const result = interactive(f, "y\n", ["launch", "not-a-harness"], false);
  expect(result.prompted, result.output).toBe(true);
  expect(result.cleanBeforePrompt).toBe(true);
  expect(result.code).not.toBe(0);
  expect(result.output.split("create one with the TAP signpost?")).toHaveLength(2);
  expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
});

test("setup-owned initialization skips the shared instruction prompt and write", () => {
  const f = fixture();
  (f.env as NodeJS.ProcessEnv).TAP_SETUP_REPO_PENDING = "1";
  const result = interactive(f, "", ["init", "--no-trust-folders"], false);
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain("create one with the TAP signpost?");
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "repo-setup-locks"))).toBe(false);
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "repo-setup-notices"))).toBe(false);
});

test("JSON first-launch init creates instructions even in a terminal", () => {
  const f = fixture();
  const result = interactive(f, "", ["init", "--for-launch", "--json"], false);
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain("create one with the TAP signpost?");
  expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
});

test("first-launch init preserves complete and partial instructions and treats symlinks as advisory", () => {
  for (const kind of ["ordinary", "complete", "partial", "symlink"] as const) {
    const f = fixture(), path = join(f.cwd, "AGENTS.md");
    const bytes = kind === "complete" ? "# keep\n<!-- TAP:BEGIN -->\ncustom\n<!-- TAP:END -->\n"
      : kind === "partial" ? "# keep\n<!-- TAP:BEGIN -->\nunfinished" : "# keep exactly\r\n";
    const target = kind === "symlink" ? join(f.base, "external") : path;
    writeFileSync(target, bytes);
    if (kind === "symlink") symlinkSync(target, path);
    const result = f.run(["init", "--for-launch"]);
    expect(result.status, result.stderr).toBe(0);
    const after = readFileSync(target, "utf8");
    if (kind === "ordinary") {
      expect(after.startsWith(bytes)).toBe(true);
      expect(after).toContain("<!-- TAP:BEGIN -->");
    } else expect(after).toBe(bytes);
    if (kind === "partial" || kind === "symlink") expect(result.stderr).toContain("run tap setup --repo");
  }
});

test("first-launch dry-run and enrollment refusal leave instruction footprints absent", () => {
  for (const args of [["init", "--for-launch", "--dry-run"], ["init", "--team", "bad.name"]]) {
    const f = fixture();
    const result = interactive(f, "", args, false);
    expect(result.output).not.toContain("create one with the TAP signpost?");
    for (const path of [join(f.cwd, "AGENTS.md"), join(f.cwd, ".tap"), join(f.cwd, ".gitignore"),
      join(f.env.TAP_INDEX_HOME, "repo-setup-locks"), join(f.env.TAP_INDEX_HOME, "repo-setup-notices")]) {
      expect(existsSync(path), path).toBe(false);
    }
  }
});


test.skipIf(process.getuid?.() === 0)("unreadable instructions stay advisory during first-launch init", () => {
  const f = fixture(), path = join(f.cwd, "AGENTS.md");
  writeFileSync(path, "private instructions\n"); chmodSync(path, 0o000);
  try {
    const result = f.run(["init", "--for-launch"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("run tap setup --repo");
    expect(existsSync(join(f.cwd, ".tap/team-registry.json"))).toBe(true);
  } finally { chmodSync(path, 0o600); }
  expect(readFileSync(path, "utf8")).toBe("private instructions\n");
});
