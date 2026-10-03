import { buildInvocation, composeInvocation, launchInvocation } from "../src/launcher/invocation";
import { recordFromRow } from "../src/launcher/transaction";
import { Notices } from "../src/launcher/catalog-notices";
import { spliceTokensIfAbsent } from "../src/launcher/argv-splice";
import { tmux } from "../src/tmux";
import { route } from "../main";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readCatalog, environment, addParams } from "../src/launcher/catalog";
import { composeConfig, configDefaults, configOnly } from "../src/launcher/config-args";
import { reservationExpired } from "../src/reservation";
import { writeLiveFence } from "./support/live-fence";
import { loadModelReference } from "../src/launcher/model-reference";

const original = { ...process.env };
const realTmux = Bun.which("tmux")!;
const roots: string[] = [];
const sockets: string[] = [];
const cli = resolve(import.meta.dir, "../src/launcher/new.ts");
const publicBin = resolve(import.meta.dir, "../../../bin/tap");

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    spawnSync(realTmux, ["-L", socket, "kill-server"], { env: process.env, stdio: "ignore" });
  }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmuxEffect(args: string[], env: NodeJS.ProcessEnv): string {
  const result = tmux(args, env);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function fixture(harness = "claude") {
  const root = realpathSync(mkdtempSync("/tmp/tap-launch-test-"));
  roots.push(root);
  const index = join(root, "index");
  const registry = join(root, "relocated.json");
  for (const dir of [index, join(root, ".tap/bus"), join(root, ".config/tap"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {}, extension: { retain: true } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const socket = `l1-${process.pid}-${Math.random().toString(16).slice(2,8)}`;
  sockets.push(socket);
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: join(root, ".tap/bus"), TAP_TMUX_SOCKET: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash",
    PATH: `${root}/bin:${original.PATH}` });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR"]) delete process.env[key];
  writeFileSync(join(root, ".bash_profile"), `export PATH='${process.env.PATH}'\n`);
  const config = join(root, ".config/tap/config.toml");
  writeFileSync(config, `version = 3\n[unknown]\nfuture = true\n[presets.testseat]\nharness = "claude"\n[presets.testseat.params]\nmodel = "model-test"\nappend-system-prompt = "literal $(touch SHOULD_NOT_EXIST)"\n[presets.testseat.env]\nFEATURE_ENABLED = "yes"\n[harness.claude.params]\nverbose = true\n[harness.claude.env]\nPOLICY_LEVEL = "machine"\n`.replaceAll("claude", harness));
  return { root, config, registry, socket };
}

function run(root: string, args: string[], publicEntry = false) {
  const result = spawnSync(publicEntry ? "bash" : process.execPath,
    publicEntry ? [publicBin, "session", "launch", ...args] : [cli, ...args], {
    cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL",
  });
  let detail = "";
  try { detail = JSON.parse(result.stdout).detail ?? ""; } catch { /* plain receipt */ }
  return { ...result, diagnostic: result.stderr + detail };
}

function rewriteRow(path: string, update: (row: Record<string, unknown>) => void) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  update(doc.seats.reviewer);
  writeFileSync(path, JSON.stringify(doc));
}

const MASKS: [RegExp, string][] = [[/l1-\d+-[0-9a-f]+/g, "<socket>"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"], [/%\d+/g, "%N"], [/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "<time>"],
  [/\d{8}T\d{6}Z-[A-Za-z0-9._-]+?-[0-9a-f]{12}\b/g, "<backup>"], [/\|[0-9a-f]{16}\b/g, "|<instance>"], [/srv:\d+:\d+/g, "srv:<epoch>"]];
// The runner's tmux directory and the uid in its socket path vary per run and per machine.
const tmuxDirs = [...new Set([original.TMUX_TMPDIR, original.TMUX_TMPDIR && realpathSync(original.TMUX_TMPDIR)].filter(Boolean) as string[])]
  .sort((a, b) => b.length - a.length);
const masked = (text: string, root: string) => MASKS.reduce((acc, [re, to]) => acc.replace(re, to),
  tmuxDirs.reduce((acc, dir) => acc.replaceAll(dir, "<tmux>"), text.replaceAll(root, "<root>")).replace(/\/tmux-\d+\//g, "/tmux-<uid>/"));

// The incumbent's outcomes, recorded from launcher.py new before it was
// deleted when the Python launcher was retired; fixtures/launch-l1-oracle.json's header names the base.
const GOLDEN = resolve(import.meta.dir, "fixtures/launch-l1-oracle.json");
const golden = JSON.parse(readFileSync(GOLDEN, "utf8").replaceAll("running detached (no controlling terminal); next: tmux attach -t ", "running detached (no controlling terminal); next: from a foreground terminal, run tap attach ")).cases as Record<string, unknown>;
function asIncumbent(key: string, value: unknown) {
  if (!(key in golden)) throw new Error(`launch-l1-oracle.json has no case '${key}'`);
  expect(value).toEqual(golden[key]);
}
/** A scenario-derived value (a seat row, a file) that must equal the incumbent's, masked. */
function sameAsIncumbent(key: string, f: ReturnType<typeof fixture>, of: (f: ReturnType<typeof fixture>) => unknown) {
  asIncumbent(key, of(f));
}

/**
 * Run one launch scenario through the public session wrapper on a fresh
 * fixture and require the incumbent's exit status, stdout and stderr once
 * volatile values are masked.
 */
function differential(key: string, args: string[], setup: (f: ReturnType<typeof fixture>) => void = () => {}, harness = "claude", at = (root: string) => root) {
  const f = fixture(harness);
  setup(f);
  const result = run(at(f.root), args, true);
  const seen = { status: result.status, stdout: masked(result.stdout, f.root), stderr: masked(result.stderr, f.root) };
  // A failure inside an effect-bearing launch phase now names that phase
  // before its cause (the spinner is TTY-only); keep the historical oracle
  // intact and assert the new prefix explicitly, as the tap-zi01z arms do.
  // A harness-start failure lands in whichever phase the last readiness poll
  // reached, so those cases list every phase the failure can honestly name.
  const phases = PHASED_FAILURES[key];
  if (phases === undefined) asIncumbent(key, seen);
  else {
    if (!(key in golden)) throw new Error(`launch-l1-oracle.json has no case '${key}'`);
    const base = golden[key] as typeof seen;
    expect(base.stderr.startsWith("tap session: ")).toBe(true);
    const named = phases.find(phase => seen.stderr.startsWith(`tap session: while ${phase}: `)) ?? phases[0]!;
    expect(seen).toEqual({ ...base, stderr: base.stderr.replace("tap session: ", `tap session: while ${named}: `) });
  }
  return { f, result, seen };
}

/** Differential cases whose failure lands in an effect-bearing launch phase. */
const PHASED_FAILURES: Record<string, string[]> = {
  "reserved help handle": ["reserving help on team fixture"],
  "session appearing after claim": ["setting up tmux session fixture/reviewer"],
  "shell mentioning claude": ["starting claude", "waiting for claude to register on team fixture"],
  "failed claude start": ["starting claude", "waiting for claude to register on team fixture"],
  "failed codex start": ["starting codex", "waiting for codex to be ready"],
};

function fakeHarness(f: { root: string; registry: string }, beforeExec = "") {
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/claude"));
  else symlinkSync("/bin/sleep", join(f.root, "real/claude"));
  const fake = join(f.root, "bin/claude");
  writeFileSync(fake, `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\ncp '${f.registry}' '${f.root}/before-harness.json'\nprintf '%s\\n' "$FEATURE_ENABLED" "$POLICY_LEVEL" "$TAP_HOME" > '${f.root}/env'\n${beforeExec}\nexport PATH='${f.root}/real':\"$PATH\"\nexec '${f.root}/real/claude' 600\n`);
  chmodSync(fake, 0o755);
}

test("bare tuned launch records winning tail identity through roster despite current config drift", () => {
  const f = fixture();
  writeFileSync(f.config, 'version=3\n[harness.claude]\npermissions="bypass"\nparams.effort="medium"\n');
  fakeHarness(f);
  const plain = run(f.root,["claude","baseline","--model","fable","--effort","medium"],true);
  expect(plain.status,plain.diagnostic).toBe(0);
  expect(JSON.parse(readFileSync(f.registry,"utf8")).seats.baseline.launch_tuning).toMatchObject({model:"fable",effort:"medium"});
  const result = run(f.root, ["claude", "reviewer", "--model", "starter", "--", "--model", "fable", "--effort", "high"], true);
  expect(result.status, result.diagnostic).toBe(0);
  const entry = JSON.parse(readFileSync(f.registry,"utf8")).seats.reviewer;
  expect(entry.launch_tuning).toEqual({model:"fable",effort:"high",qualifiers:{},environment:{}});
  expect(readFileSync(join(f.root,"argv"),"utf8").trimEnd().split("\n").slice(-4)).toEqual(["--model","fable","--effort","high"]);
  writeFileSync(f.config, 'version=3\n[presets.reviewer]\nharness="claude"\nparams.model="different-model"\nparams.effort="low"\nmetadata.intelligence="dumb"\n');
  const cli = (args: string[]) => spawnSync("bash",[publicBin,...args],{cwd:f.root,env:{...process.env,TAP_MODELS_LEDGER:join(f.root,"absent-ledger")},encoding:"utf8",timeout:20_000});
  const roster = cli(["team","--json"]);
  expect(roster.status,roster.stderr).toBe(0);
  const shown = JSON.parse(roster.stdout).agents.find((row: any) => row.handle === "reviewer");
  expect(shown).toMatchObject({model:"fable",effort:"high",metadata:{intelligence:"s-tier"},metadata_source:"launch-reference"});
  expect(shown.launch_tuning).toEqual(entry.launch_tuning);
  expect(cli(["team"]).stdout).toContain("fable@high");
  expect(cli(["team","calibration","--strongest"]).stdout).toBe("reviewer\n");
}, 60_000);

test("reference Codex service-tier examples pass the bare launch parser without saved presets", () => {
  const f = fixture("codex");
  writeFileSync(f.config,'version=3\n[harness.codex]\npermissions="bypass"\n');
  writeFileSync(join(f.root,"bin/codex"),'#!/bin/sh\nexit 0\n',{mode:0o755});
  for (const name of ["astra-med","astra-fast","astra-ponytail"]) {
    const variant = loadModelReference().find(v => v.recipes.includes(name))!;
    const args = [...variant.launchArgs], at = args.indexOf("--");
    args.splice(at < 0 ? args.length : at,0,"--dry-run","--json");
    const result = run(f.root,args,true);
    expect(result.status,result.diagnostic).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.argv).toContain(`service_tier=${variant.tuning.qualifiers.service_tier}`);
    expect(preview.env.PONYTAIL_DEFAULT_MODE).toBe(variant.tuning.environment.PONYTAIL_DEFAULT_MODE);
  }
});


test("reservation expiry retains live, young, malformed and unobservable rows", async () => {
  const row = { status: "pending", session: "fixture/x", registered_at: "2026-09-05T00:00:00Z", boot_id: "boot:1" };
  const now = Date.parse(row.registered_at) / 1000;
  expect(reservationExpired(row, new Set(), now + 59, "boot:1", "boot:1")).toBe(false);
  expect(reservationExpired(row, new Set(), now + 60, "boot:1", "boot:1")).toBe(true);
  expect(reservationExpired(row, new Set([row.session]), now + 120, "boot:2", "boot:2")).toBe(false);
  expect(reservationExpired(row, null, now + 120, "boot:1", "boot:1")).toBe(false);
  expect(reservationExpired(row, null, now, "boot:20", "boot:20")).toBe(true);
  expect(reservationExpired({ ...row, pane_id: "broken" }, new Set(), now + 120, "boot:20", "boot:20")).toBe(false);
  expect(reservationExpired({ ...row, registered_at: "2026-02-31T00:00:00Z" }, new Set(), now, "boot:1", "boot:1")).toBe(false);
});

test("secure TOML read rejects writable files and preserves provenance", async () => {
  const f = fixture();
  expect(readCatalog(f.config).digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  chmodSync(f.config, 0o666);
  expect(() => readCatalog(f.config)).toThrow("preset_config_insecure");
});

test("environment fence rejects identity, process, policy and credential keys without echoing values", async () => {
  for (const key of ["TAP_HOME", "HOME", "NODE_OPTIONS", "MODEL_APPROVALS_MODE", "AUTH_TOKEN", "API_KEY"]) {
    expect(() => environment({ [key]: "private-value" }, "forbidden")).toThrow(key);
  }
  expect(environment({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", HF_TOKENS: "value" }, "forbidden")).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", HF_TOKENS: "value" });
});

test("params retain builder values and treat prompt bytes literally", async () => {
  expect(addParams(["claude", "--model", "floor"], { model: "ignored", verbose: true, disabled: false, "append-system-prompt": "$(x)" }))
    .toEqual(["claude", "--verbose", "--append-system-prompt", "$(x)", "--model", "floor"]);
});

test("dry-run leaves registry and tmux untouched", async () => {
  const f = fixture();
  const before = readFileSync(f.registry, "utf8");
  const preview = run(f.root, ["testseat", "reviewer", "--dry-run", "--json"]);
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout).name).toBe("fixture/reviewer");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("reserved help handle is refused before launch effects", async () => {
  const { f, result } = differential("reserved help handle", ["testseat", "help", "--json"], f => fakeHarness(f));
  expect(result.status).toBe(2);
  expect(result.diagnostic).toContain("reserved as the CLI help keyword");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
  expect(existsSync(join(f.root, "argv"))).toBe(false);
});

test("a reset fence refuses before reservation", async () => {
  const f = fixture();
  writeLiveFence(join(f.root, ".tap/bus/reset.fence.json"));
  const before = readFileSync(f.registry, "utf8");
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(result.status).toBe(2);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("public wrapper launches native: row bound before harness, exact identity persisted, no shell interpolation", async () => {
  const f = fixture();
  fakeHarness(f);
  const result = run(f.root, ["testseat", "reviewer", "--json"], true);
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  const bound = JSON.parse(readFileSync(join(f.root, "before-harness.json"), "utf8")).seats.reviewer;
  expect(bound.status_reason).toBe("launching");
  expect(bound.launch_id).toBeTruthy();
  expect(bound.pane_id).toBe(row.pane_id);
  expect(row.status_reason).toBe("");
  expect(row.launch_id).toBeUndefined();
  expect(row.instance).toMatch(/^reviewer\|/);
  expect(row.server_epoch).toMatch(/^srv:\d+:\d+$/);
  expect(row.server_socket).toContain(f.socket);
  expect(row.identity_capture.expected_harness_session_id).toBe(row.harness_session_id);
  expect(tmuxEffect(["display-message", "-p", "-t", row.pane_id, "#{pane_width}x#{pane_height}"], process.env).trim())
    .toBe("200x60");
  const clients = spawnSync(realTmux, ["-L", f.socket, "list-clients", "-t", `=${row.session}`], {
    env: process.env, encoding: "utf8",
  });
  expect(clients.stdout.trim()).toBe("");
  expect(readFileSync(join(f.root, "argv"), "utf8")).toContain(row.harness_session_id);
  expect(readFileSync(join(f.root, "env"), "utf8")).toBe("yes\nmachine\n\n");
  expect(existsSync(join(f.root, "SHOULD_NOT_EXIST"))).toBe(false);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).extension).toEqual({ retain: true });
}, 25_000);

test("subdirectory launch binds the enrolled root, as the incumbent does", async () => {
  // A git root: a folder under an enrolled non-git root refuses on both doors.
  const { f, result } = differential("subdirectory launch", ["testseat", "reviewer", "--json"], f => {
    spawnSync("git", ["init", "-q", f.root]);
    mkdirSync(join(f.root, "sub"));
    fakeHarness(f, `pwd > '${f.root}/cwd'`);
  }, "claude", root => join(root, "sub"));
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.registered_from_worktree).toBe(f.root);
  sameAsIncumbent("subdirectory launch cwd", f, f => masked(readFileSync(join(f.root, "cwd"), "utf8"), f.root));
}, 40_000);

test("public launch recognizes a versioned native target selected by login PATH", async () => {
  const f = fixture();
  const selected = join(f.root, "selected");
  const versions = join(f.root, "versions");
  mkdirSync(selected);
  mkdirSync(versions);
  const source = join(f.root, "fixture.ts");
  const binary = join(versions, "2.1.257");
  writeFileSync(source, "setInterval(() => {}, 1000);\n");
  const built = spawnSync(process.execPath, ["build", "--compile", source, "--outfile", binary], {
    cwd: f.root, env: process.env, encoding: "utf8", timeout: 30_000,
  });
  expect({ status: built.status, error: built.error?.message }).toEqual({ status: 0, error: undefined });
  symlinkSync(binary, join(selected, "claude"));
  writeFileSync(join(f.root, "bin/claude"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(f.root, "bin/claude"), 0o755);
  writeFileSync(join(f.root, ".bash_profile"), `export PATH='${selected}':"$PATH"\n`);
  // Use a controlled login-shell fixture: runner /etc/profile must not choose its HOME/PATH.
  const loginDir = join(f.root, "login-shell");
  mkdirSync(loginDir);
  const loginShell = join(loginDir, "bash");
  writeFileSync(loginShell, `#!/bin/bash\n. '${f.root}/.bash_profile'\nexec /bin/bash --noprofile --norc "$@"\n`);
  chmodSync(loginShell, 0o755);
  process.env.TAP_LAUNCH_SHELL = loginShell;
  const result = run(f.root, ["testseat", "reviewer", "--json"], true);
  expect({ status: result.status, diagnostic: result.diagnostic }).toEqual({ status: 0, diagnostic: "" });
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.status_reason).toBe("");
}, 45_000);

test("preset refusals under --json are one structured object without stderr", async () => {
  const f = fixture();
  const result = run(f.root, ["--preset", "missing", "--dry-run", "--json"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: "preset_not_found" });
});

test("operator --name and flag-shaped prompt values remain literal", async () => {
  const f = fixture();
  const result = run(f.root, ["claude", "reviewer", "--dry-run", "--json", "--", "--name", "operator", "--append-system-prompt", "--name"]);
  expect(result.status).toBe(0);
  const argv: string[] = JSON.parse(result.stdout).argv;
  expect(argv.slice(-4)).toEqual(["--name", "operator", "--append-system-prompt", "--name"]);
  expect(argv[argv.slice(0, -4).lastIndexOf("--name") + 1]).toBe("fixture/reviewer");
});

test("child ignores server's old index and foreign bus and resolves its bound seat", async () => {
  const { f, result } = differential("child ignores old index and foreign bus", ["testseat", "reviewer", "--json"], f => {
    const decoy = join(f.root, "old-index");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    tmuxEffect(["new-session", "-d", "-s", "keeper", "exec /bin/sleep 600"], {
      ...process.env, TAP_INDEX_HOME: decoy, TAP_HOME: join(f.root, "foreign/bus"), TAP_HARNESS_SESSION_ID: "foreign-id", CLAUDE_CODE_SESSION_ID: "foreign-claude",
    });
    fakeHarness(f, `printf '%s\\n' "$TAP_INDEX_HOME" > '${f.root}/authority'\nprintf '%s\\n' "${'$'}{TAP_HARNESS_SESSION_ID-absent}" "${'$'}{CLAUDE_CODE_SESSION_ID-absent}" > '${f.root}/identity-env'\n'${publicBin}' whoami --json > '${f.root}/whoami'`);
  });
  expect(result.status).toBe(0);
  // tap-y4jkj: the server's harness identity must not reach the launched child.
  expect(readFileSync(join(f.root, "identity-env"), "utf8")).toBe("absent\nabsent\n");
  expect(readFileSync(join(f.root, "authority"), "utf8")).toBe(`${f.root}/index\n`);
  expect(readFileSync(join(f.root, "whoami"), "utf8")).toContain("reviewer");
  expect(existsSync(join(f.root, "foreign"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.root, "old-index/global-registry.json"), "utf8")).teams).toEqual({});
}, 40_000);

test("enrolled cwd B wins over ambient bus A for the reservation", async () => {
  const f = fixture();
  const foreignRoot = join(f.root, "foreign");
  mkdirSync(join(foreignRoot, ".tap/bus"), { recursive: true });
  const foreignRegistry = join(foreignRoot, ".tap/team-registry.json");
  writeFileSync(foreignRegistry, JSON.stringify({ schema: "0.20", team: { name: "foreign", worktree_root: foreignRoot }, seats: {} }));
  const index = join(f.root, "index/global-registry.json");
  const doc = JSON.parse(readFileSync(index, "utf8"));
  doc.teams.foreign = { root: foreignRoot, registry_location: foreignRegistry };
  writeFileSync(index, JSON.stringify(doc));
  process.env.TAP_HOME = join(foreignRoot, ".tap/bus");
  fakeHarness(f);
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(foreignRegistry, "utf8")).seats).toEqual({});
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.session).toBe("fixture/reviewer");
}, 25_000);

test("launch restores inherited remain-on-exit and preserves unrelated hooks", async () => {
  const f = fixture();
  tmuxEffect(["new-session", "-d", "-s", "keeper", "exec /bin/sleep 600"], process.env);
  tmuxEffect(["set-option", "-g", "remain-on-exit", "on"], process.env);
  tmuxEffect(["set-hook", "-g", "pane-died[42]", "display-message unrelated-hook"], process.env);
  fakeHarness(f);
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
  const id = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.pane_id;
  expect(tmuxEffect(["show-options", "-p", "-q", "-v", "-t", id, "remain-on-exit"], process.env).trim()).toBe("");
  expect(tmuxEffect(["show-options", "-p", "-A", "-v", "-t", id, "remain-on-exit"], process.env).trim()).toBe("on");
  expect(tmuxEffect(["show-hooks", "-g", "pane-died"], process.env)).toContain("pane-died[42]");
}, 25_000);

test("respawn failure cleans both its row and created pane", async () => {
  const f = fixture();
  fakeHarness(f);
  const actualTmux = Bun.which("tmux")!;
  const shim = join(f.root, "bin/tmux");
  writeFileSync(shim, `#!/bin/sh\ncase "$*" in *respawn-pane*) echo injected-respawn-failure >&2; exit 23;; esac\nexec '${actualTmux}' "$@"\n`);
  chmodSync(shim, 0o755);
  const initial = JSON.parse(readFileSync(f.registry, "utf8"));
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(result.status).toBe(2);
  expect(result.diagnostic).toContain("injected-respawn-failure");
  expect(JSON.parse(readFileSync(f.registry, "utf8"))).toEqual(initial);
  const sessions = spawnSync(actualTmux, ["-L", f.socket, "list-sessions"], { env: process.env, encoding: "utf8" });
  expect(sessions.status, sessions.stderr).toBe(0);
  expect(sessions.stdout.trim()).toBe("");
});

test("unusable creation identity retains the pending reservation instead of losing ownership", async () => {
  const f = fixture();
  fakeHarness(f);
  const actualTmux = Bun.which("tmux")!;
  const shim = join(f.root, "bin/tmux");
  writeFileSync(shim, `#!/bin/bash\nset -o pipefail\ncase "$*" in *new-session*) '${actualTmux}' "$@" | sed 's/%[0-9][0-9]*/not-a-pane/g';; *) exec '${actualTmux}' "$@";; esac\n`);
  chmodSync(shim, 0o755);
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("pending reservation retained");
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.status).toBe("pending");
  expect(row.pane_id).toBeUndefined();
  expect(tmuxEffect(["has-session", "-t", "=fixture/reviewer"], process.env)).toBe("");
});

test("a session appearing after claim is preserved while our reservation rolls back", async () => {
  const actualTmux = Bun.which("tmux")!;
  const { f, result } = differential("session appearing after claim", ["testseat", "reviewer", "--json"], f => {
    fakeHarness(f);
    const shim = join(f.root, "bin/tmux");
    writeFileSync(shim, `#!/bin/sh\ncase "$*" in *new-session*) '${actualTmux}' -L '${f.socket}' new-session -d -s fixture/reviewer 'exec /bin/sleep 600';; esac\nexec '${actualTmux}' "$@"\n`);
    chmodSync(shim, 0o755);
  });
  expect(result.status).not.toBe(0);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
  expect(spawnSync(realTmux, ["-L", f.socket, "has-session", "-t", "=fixture/reviewer"]).status).toBe(0);
}, 40_000);

test("a shell whose arguments mention claude never becomes ready", async () => {
  const { f, result } = differential("shell mentioning claude", ["testseat", "reviewer", "--json"], f => {
    const fake = join(f.root, "bin/claude");
    writeFileSync(fake, "#!/bin/bash\nexec /bin/bash -c 'echo claude; while :; do sleep 1; done'\n");
    chmodSync(fake, 0o755);
  });
  expect(result.status).toBe(2);
  expect(result.diagnostic).toContain("harness did not start");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
}, 40_000);

// The phase spinner is TTY-only; a caller without it (an agent's Bash tool,
// --json) still learns which effect-bearing launch phase a failure stopped in.
test("a failed launch names its phase without a TTY, in text and --json", async () => {
  for (const json of [false, true]) {
    const f = fixture();
    fakeHarness(f);
    const loginDir = join(f.root, "login-shell");
    mkdirSync(loginDir);
    const loginShell = join(loginDir, "zsh");
    writeFileSync(loginShell, `#!/bin/bash\nread -r answer\nexec /bin/bash --noprofile --norc "$@"\n`);
    chmodSync(loginShell, 0o755);
    process.env.TAP_LAUNCH_SHELL = loginShell;
    const result = run(f.root, ["testseat", "reviewer", ...(json ? ["--json"] : [])]);
    expect(result.status).toBe(2);
    // Transaction failures render on stderr under --json too (the renderer's
    // existing contract); either way the phase is named before the cause.
    expect(result.diagnostic).toMatch(/tap session: while (starting claude|waiting for claude to register on team fixture): harness did not start for fixture\/reviewer/);
    expect(result.stderr).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗]|\x1b/);
  }
}, 40_000);

test("a login shell blocked on a prompt is named and shown in the launch failure", async () => {
  const f = fixture();
  fakeHarness(f);
  const loginDir = join(f.root, "login-shell");
  mkdirSync(loginDir);
  const loginShell = join(loginDir, "zsh");
  writeFileSync(loginShell, `#!/bin/bash\n. '${f.root}/.bash_profile'\nprintf '[oh-my-zsh] Would you like to update? [Y/n] '\nread -r answer\nexec /bin/bash --noprofile --norc "$@"\n`);
  chmodSync(loginShell, 0o755);
  process.env.TAP_LAUNCH_SHELL = loginShell;
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(result.status).toBe(2);
  expect(result.diagnostic).toContain("harness did not start for fixture/reviewer: the login shell (bash) had not started claude after 5000 ms; it may be waiting for input");
  expect(result.diagnostic).toContain("[oh-my-zsh] Would you like to update? [Y/n]");
  expect(result.diagnostic).toContain("login-shell/zsh -lic exit");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
  const sessions = spawnSync(realTmux, ["-L", f.socket, "list-sessions"], { env: process.env, encoding: "utf8" });
  expect(sessions.status, sessions.stderr).toBe(0);
  expect(sessions.stdout.trim()).toBe("");
}, 40_000);

test("a live interpreter script named claude is not executable readiness", async () => {
  const f = fixture();
  const fake = join(f.root, "bin/claude");
  writeFileSync(fake, `#!/bin/bash\nprintf entered > '${f.root}/entered'\nsleep 1\nexit 1\n`);
  chmodSync(fake, 0o755);
  const result = run(f.root, ["testseat", "reviewer", "--json"]);
  expect(readFileSync(join(f.root, "entered"), "utf8")).toBe("entered");
  expect(result.status).toBe(2);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
}, 25_000);

test.each(["claude", "codex"])("%s SIGTERM after binding rolls back before exiting 143, as the incumbent does", async (harness) => {
  const f = fixture(harness);
  const fake = join(f.root, `bin/${harness}`);
  writeFileSync(fake, `#!/bin/bash\ncp '${f.registry}' '${f.root}/bound'\nexec /bin/sleep 600\n`);
  chmodSync(fake, 0o755);
  const child = Bun.spawn([process.execPath, cli, "testseat", "reviewer", "--json"], {
    cwd: f.root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(f.root, "bound")) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(join(f.root, "bound"))).toBe(true);
    child.kill("SIGTERM");
    const code = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(code, stderr + stdout).toBe(143);
    expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
    // The incumbent exited silently; an interrupted effect phase now names
    // itself in every mode (here --json: the envelope on stdout, stderr
    // empty), so the oracle is kept and the new envelope asserted.
    const phases = [`starting ${harness}`, harness === "claude" ? "waiting for claude to register on team fixture" : `waiting for ${harness} to be ready`];
    expect(phases.map(phase => JSON.stringify({ ok: false, error_class: "launcher_interrupted", action: "tap help session",
      detail: `while ${phase}: launch cancelled` }) + "\n")).toContain(masked(stdout, f.root));
    asIncumbent(`${harness} SIGTERM after binding`, { code, stdout: "", stderr: masked(stderr, f.root) });
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
}, 30_000);

test.each(["claude", "codex"])("%s failed harness start rolls back the reservation", async (harness) => {
  const { f, result } = differential(`failed ${harness} start`, ["testseat", "failed", "--json"], f => {
    const fake = join(f.root, `bin/${harness}`);
    writeFileSync(fake, "#!/bin/sh\nexit 19\n"); chmodSync(fake, 0o755);
  }, harness);
  expect(result.status).toBe(2);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({});
}, 40_000);


test("Codex ad-hoc effort preserves one config value and never mints native identity", async () => {
  const f = fixture("codex");
  const preview = run(f.root, ["codex", "reviewer", "--effort", "ultra", "--dry-run", "--json"]);
  expect(preview.status).toBe(0);
  const argv: string[] = JSON.parse(preview.stdout).argv;
  expect(argv[argv.indexOf("-c") + 1]).toBe('model_reasoning_effort="ultra"');
  expect(argv.filter(token => token.startsWith("model_reasoning_effort="))).toEqual(['model_reasoning_effort="ultra"']);
  expect(argv).not.toContain("--effort");
  expect(argv).not.toContain("--session-id");
});

test("Codex fresh launch clears inherited identity and reaches its native executable", async () => {
  const f = fixture("codex");
  process.env.CODEX_THREAD_ID = "stale-parent-thread";
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  const fake = join(f.root, "bin/codex");
  writeFileSync(fake, `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\nprintf '%s\\n' "\${CODEX_THREAD_ID-}" "$POLICY_LEVEL" > '${f.root}/env'\ncp '${f.registry}' '${f.root}/before-harness.json'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`);
  chmodSync(fake, 0o755);
  const result = run(f.root, ["codex", "reviewer", "--effort", "high", "--json"], true);
  expect({ status: result.status, detail: result.diagnostic }).toEqual({ status: 0, detail: "" });
  expect(readFileSync(join(f.root, "env"), "utf8")).toBe("\nmachine\n");
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  expect(argv[argv.indexOf("-c") + 1]).toBe('model_reasoning_effort="high"');
  expect(argv).not.toContain("--effort");
  for (const path of [join(f.root, "before-harness.json"), f.registry]) {
    const row = JSON.parse(readFileSync(path, "utf8")).seats.reviewer;
    expect(row.identity_capture).toEqual({ mode: "launcher_new" });
    expect(Object.hasOwn(row, "harness_session_id")).toBe(false);
  }
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.status).toBe("active");
  expect(row.status_reason).toBe("");
});


test("public Codex launch Fast workaround preserves explicit effort and preset model", async () => {
  const f = fixture("codex");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  const fake = join(f.root, "bin/codex");
  writeFileSync(fake, `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`);
  chmodSync(fake, 0o755);
  const flags = ["--config", 'model_reasoning_effort="high"', "--config", "service_tier=fast"];
  const result = run(f.root, ["testseat", "reviewer", "--json", "--", ...flags], true);
  expect({ status: result.status, detail: result.diagnostic }).toEqual({ status: 0, detail: "" });
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  expect(argv.slice(argv.indexOf("--config"), argv.indexOf("--config") + 4)).toEqual(flags);
  expect(argv[argv.indexOf("--model") + 1]).toBe("model-test");
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.harness_tail).toEqual(flags);
  expect(row.model).toBe("model-test");
});


test("public Codex launch bare delimiter preserves the full preset recipe", () => {
  const f = fixture("codex");
  writeFileSync(f.config, `version = 3
[presets.testseat]
harness = "codex"
params.model = "gpt-6-astra"
params.config = ["model_reasoning_effort=high", "service_tier=default", "features.keep=true"]
params.verbose = true
[harness.codex.params]
config = ["service_tier=default", "model_reasoning_effort=low", "features.policy=true"]
`);
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  const fake = join(f.root, "bin/codex");
  writeFileSync(fake, `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`);
  chmodSync(fake, 0o755);
  const result = run(f.root, ["testseat", "delimiter-reviewer", "--json", "--"], true);
  expect({ status: result.status, error: result.status ? result.diagnostic : "" }).toEqual({ status: 0, error: "" });
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  const recipe = ["--config", "model_reasoning_effort=high", "--config", "service_tier=default", "--config", "features.keep=true", "--verbose"];
  expect(argv).toEqual(["--config", "features.policy=true", ...recipe, "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-6-astra"]);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats["delimiter-reviewer"];
  expect(row.passthrough).toEqual(recipe);
  expect(row.model).toBe("gpt-6-astra");
  expect(row.passthrough_from_config).toBe(true);
});

test("public Codex launch composes config keys and persists the seat recipe", () => {
  const f = fixture("codex");
  writeFileSync(f.config, `version = 3
[presets.testseat]
harness = "codex"
params.model = "gpt-6-astra"
params.config = ["model_reasoning_effort=high", "service_tier=default", "features.keep=true"]
params.verbose = true
[harness.codex.params]
config = ["service_tier=default", "model_reasoning_effort=low", "features.policy=true"]
`);
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  const fake = join(f.root, "bin/codex");
  writeFileSync(fake, `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`);
  chmodSync(fake, 0o755);
  const explicit = ["--config=service_tier=default", "--config", "service_tier=fast", "-c", "features.extra=true", "--enable", "one", "--enable", "two"];
  const result = run(f.root, ["testseat", "reviewer", "--json", ...explicit], true);
  expect({ status: result.status, error: result.status ? result.diagnostic : "" }).toEqual({ status: 0, error: "" });
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  const recipe = ["--config", "model_reasoning_effort=high", "--config", "service_tier=default", "--config", "features.keep=true", "--verbose"];
  expect(argv).toEqual(["--config", "features.policy=true", ...recipe, "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-6-astra", ...explicit]);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.passthrough).toEqual(recipe);
  expect(row.harness_tail).toEqual(explicit);
  expect(row.model).toBe("gpt-6-astra");
  // Both revival paths consume the persisted native/Python launch row after the preset disappears.
  writeFileSync(f.config, 'version = 3\n[harness.codex.params]\nconfig = ["service_tier=default", "features.policy=false"]\n');
  const record = recordFromRow("reviewer", row, { name: "fixture", worktree_root: f.root }, f.root)!;
  const notices = new Notices(() => {});
  const replay = [launchInvocation("resume", record, notices),
    composeInvocation(buildInvocation("resume", record, notices, process.env, null, undefined, null), record, notices)];
  for (const { argv: replayArgv } of replay) {
    expect(replayArgv.slice(1, 3 + recipe.length)).toEqual(["--config", "features.policy=false", ...recipe]);
    expect(replayArgv.slice(-explicit.length)).toEqual(explicit);
    expect(replayArgv).toContain("gpt-6-astra");
  }
});

test.each(['"service_tier=default"', '["service_tier=default", "features.policy=true"]'])("harness scalar/list config composes with preset effort: %s", (policy) => {
  const f = fixture("codex");
  writeFileSync(f.config, `version = 3
[presets.testseat]
harness = "codex"
params.model = "gpt-6-astra"
params.config = ["model_reasoning_effort=low", "model_reasoning_effort=high"]
[harness.codex.params]
config = ${policy}
`);
  const preview = run(f.root, ["testseat", "reviewer", "--dry-run", "--json"]);
  expect(preview.status).toBe(0);
  const argv: string[] = JSON.parse(preview.stdout).argv;
  expect(argv).toContain("service_tier=default");
  expect(argv).toContain("model_reasoning_effort=high");
  expect(argv).not.toContain("model_reasoning_effort=low");
});


test("Codex config aliases compose by key while other repeats and positional bytes survive", async () => {
  const defaults = ["--config", "service_tier=default", "--config=model_reasoning_effort=high", "--config", "features.keep=true"];
  const explicit = ["-c=service_tier=slow", "--enable", "a", "--config", "service_tier=fast", "--enable", "b", "--", "--config", "features.keep=false"];
  const expected = ["--config=model_reasoning_effort=high", "--config", "features.keep=true", "--enable", "a", "--config", "service_tier=fast", "--enable", "b", "--", "--config", "features.keep=false"];
  expect(composeConfig(defaults, explicit)).toEqual(expected);
  expect(configOnly(explicit)).toEqual(["-c=service_tier=slow", "--config", "service_tier=fast"]);
  const builder = ["-c", "model_reasoning_effort=ultra", "--model", "fixed"];
  expect(configDefaults(defaults, builder)).toEqual(["--config", "service_tier=default", "--config", "features.keep=true"]);
  expect(addParams(["codex", ...builder], {config:["model_reasoning_effort=high", "service_tier=fast"]}, true))
    .toEqual(["codex", "--config", "service_tier=fast", ...builder]);
  expect(addParams(["claude", "--config", "existing"], {config:["one", "two"]}))
    .toEqual(["claude", "--config", "existing"]);
  expect(spliceTokensIfAbsent(["codex", ...builder], defaults, { configKeys: true }))
    .toEqual(["codex", "--config", "service_tier=default", "--config", "features.keep=true", ...builder]);
  expect(spliceTokensIfAbsent(["codex", ...builder], ["--config", "model_reasoning_effort=high"], { floor: false, configKeys: true }))
    .toEqual(["codex", "--config", "model_reasoning_effort=high", "--model", "fixed"]);
  expect(spliceTokensIfAbsent(["opencode", "-c"], ["-c", "anything=else"], { floor: false }))
    .toEqual(["opencode", "-c", "anything=else", "-c"]);
});

test("launcher reservation records the effective auto policy", async () => {
  const f = fixture();
  writeFileSync(f.config, 'version = 3\n[harness.claude]\npermissions = "auto"\n');
  fakeHarness(f);
  const result = run(f.root, ["claude", "reviewer", "--json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.permissions).toBe("auto");
  const argv = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  expect(argv).toContain("--permission-mode");
  expect(argv).not.toContain("--dangerously-skip-permissions");
});

test("public launch alias preserves dry-run output and help", async () => {
 // Codex has no random fresh-session UUID, so compare literal receipt bytes.
 const f = fixture("codex");
 const invoke = (args: string[]) => spawnSync("bash", [publicBin, ...args], {cwd: f.root, env: process.env, encoding: "utf8", timeout: 20_000});
 for (const flags of [["--dry-run"], ["--dry-run", "--json"]]) {
  const canonical = invoke(["session", "launch", "testseat", ...flags]);
  const alias = invoke(["launch", "testseat", ...flags]);
  expect(canonical.status, canonical.stderr).toBe(0);
  expect(alias.status).toBe(canonical.status);
  expect(alias.stdout).toBe(canonical.stdout);
  expect(alias.stderr).toBe(canonical.stderr);
 }
 const help = invoke(["help", "launch"]);
 expect(help.status).toBe(0);
 const canonicalHelp = invoke(["help", "session", "launch"]);
 expect(canonicalHelp.status).toBe(0);
 expect(help.stdout).toBe(canonicalHelp.stdout);
 for (const section of ["NAME", "USAGE", "DESCRIPTION", "OPTIONS", "EXAMPLES", "EXIT CODES", "SEE ALSO"]) {
  expect(help.stdout).toContain(section + "\n");
 }
 expect(help.stdout).toContain("tap launch <harness|preset> [name]");
 expect(help.stdout).toContain("tap session launch <harness|preset> [name]");
});


test("every session form routes native, whatever the launcher pin", async () => {
  const calls: string[] = [];
  const handlers = { session: (args: string[]) => { calls.push(`native:${args.join(" ")}`); return 11; } };
  const fallback = (args: string[]) => { calls.push(`bash:${args.join(" ")}`); return 22; };
  delete process.env.TAP_LAUNCHER;
  expect(route(["session", "list"], handlers, fallback, undefined)).toBe(11);
  expect(route(["session", "launch", "seat"], handlers, fallback, undefined)).toBe(11);
  expect(route(["session", "resume", "seat"], handlers, fallback, undefined)).toBe(11);
  expect(route(["session", "restart", "seat"], handlers, fallback, undefined)).toBe(11);
  expect(route(["session", "relaunch", "seat"], handlers, fallback, undefined)).toBe(11);
  expect(route(["session", "bogus"], handlers, fallback, undefined)).toBe(11);
  // A retired launcher pin left in an operator's environment selects nothing.
  process.env.TAP_LAUNCHER = "python";
  expect(route(["session", "launch", "seat"], handlers, fallback, undefined)).toBe(11);
  expect(calls).toEqual(["native:list", "native:launch seat", "native:resume seat", "native:restart seat", "native:relaunch seat", "native:bogus", "native:launch seat"]);
});

test("cold launch preserves explicit socket and selected index", async () => {
  const f = fixture();
  const socket = join(process.env.TMUX_TMPDIR!, "python-explicit", "server");
  process.env.TAP_TMUX_SOCKET_PATH = socket;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  fakeHarness(f, `printf '%s\\n' "$TAP_INDEX_HOME" "$TAP_TMUX_SOCKET_PATH" > '${f.root}/selected-authority'`);
  const result = run(f.root, ["testseat", "reviewer", "--json"], true);
  try {
    expect({status:result.status, error:result.diagnostic}).toEqual({status:0,error:""});
    expect(readFileSync(join(f.root,"selected-authority"),"utf8").trim().split("\n")).toEqual([join(f.root,"index"),socket]);
    expect(spawnSync(realTmux,["-S",socket,"has-session","-t","=fixture/reviewer"],{env:process.env}).status).toBe(0);
    expect(spawnSync(realTmux,["-L","default","has-session","-t","=fixture/reviewer"],{env:process.env,stdio:"ignore"}).status).not.toBe(0);
  } finally {spawnSync(realTmux,["-S",socket,"kill-server"],{env:process.env,stdio:"ignore"});}
},30000);


test("public launch env overrides and unsets survive login startup and persist", () => {
  const f = fixture();
  process.env.POLICY_LEVEL = "ambient";
  writeFileSync(join(f.root, ".bash_profile"), `export PATH='${process.env.PATH}'\nexport POLICY_LEVEL=dotfile\n`);
  fakeHarness(f, `test -z "\${POLICY_LEVEL+x}"`);
  const result = run(f.root, ["testseat", "reviewer", "--json", "--env", "FEATURE_ENABLED=override", "--unset-env", "POLICY_LEVEL"], true);
  expect({ status: result.status, detail: result.status ? result.diagnostic : "" }).toEqual({ status: 0, detail: "" });
  expect(readFileSync(join(f.root, "env"), "utf8").split("\n").slice(0, 2)).toEqual(["override", ""]);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.harness_env.FEATURE_ENABLED).toBe("override");
  expect(row.harness_unset_env).toEqual(["POLICY_LEVEL"]);
});

// The collision ladder's [k] arm is the only one whose record fields reach an
// effect: kill-backup authority, the stop target, the replaced record and the
// history carry-over. Both engines seed through the incumbent, then collide.
const seatRow = (f: { registry: string }) => JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
const backups = (root: string) => {
  try { return readdirSync(join(root, ".tap/backup/session-kill")); } catch { return []; }
};

test("--fresh over a live seated seat replaces it with backup and history, as the incumbent does", async () => {
  const seeded = new Map<string, string>();
  const { f, result, seen } = differential("--fresh over a live seated seat", ["testseat", "reviewer", "--fresh", "--json"], f => {
    fakeHarness(f);
    expect(run(f.root, ["testseat", "reviewer", "--json"], true).status).toBe(0);
    const id = seatRow(f).harness_session_id;
    seeded.set(f.root, id);
    // A transcript on disk makes the old conversation resumable, so [k] narrates keeping it.
    mkdirSync(join(f.root, ".claude/projects/p"), { recursive: true });
    writeFileSync(join(f.root, `.claude/projects/p/${id}.jsonl`), "{}\n");
  });
  expect(result.status).toBe(0);
  expect(seen.stdout).toContain("reseated fixture/reviewer fresh (previous claude conversation <uuid> kept in history)");
  const row = seatRow(f);
  const old = seeded.get(f.root)!;
  expect(row.harness_session_id).not.toBe(old);
  expect(row.history ?? []).toContain(old);
  expect(backups(f.root)).toHaveLength(1);
  expect(row.launch_tuning).toEqual({model:"model-test",effort:null,qualifiers:{},environment:{}});
  sameAsIncumbent("--fresh over a live seated seat row", f, f => {
    const {launch_tuning, launch_witness, ...legacy} = seatRow(f);
    // launch_witness is launcher-minted bind evidence the incumbent's row never carried.
    expect(masked(JSON.stringify(launch_witness), f.root)).toBe('"<uuid>"');
    return JSON.parse(masked(JSON.stringify(legacy), f.root));
  });
}, 60_000);

// Text mode: the receipts, notices and the detached tail a live launch prints
// outside --json, which the --json differentials above do not reach.
test("a live text-mode launch prints the incumbent's receipts and notices", async () => {
  const { result, seen } = differential("live text-mode launch", ["testseat", "reviewer"], f => fakeHarness(f));
  expect(result.status).toBe(0);
  expect(seen.stdout).toContain("tap session: fixture/reviewer is running detached (no controlling terminal); next: from a foreground terminal, run tap attach fixture/reviewer");
}, 60_000);

test("a live text-mode --fresh reseat prints the incumbent's reseat receipt", async () => {
  const { result, seen } = differential("live text-mode --fresh reseat", ["testseat", "reviewer", "--fresh"], f => {
    fakeHarness(f);
    expect(run(f.root, ["testseat", "reviewer", "--json"], true).status).toBe(0);
  });
  expect(result.status).toBe(0);
  expect(seen.stdout).toContain("reseated fixture/reviewer fresh");
}, 60_000);

test("a live launch over a leftover record prints the incumbent's notice", async () => {
  const { result, seen } = differential("live launch over a leftover record", ["testseat", "reviewer"], f => {
    fakeHarness(f);
    const doc = JSON.parse(readFileSync(f.registry, "utf8"));
    doc.seats.reviewer = { harness: "claude", session: "fixture/reviewer", pane: "fixture/reviewer:0.0", status: "pending", boot_id: "boot:1" };
    writeFileSync(f.registry, JSON.stringify(doc));
  });
  expect(result.status).toBe(0);
  expect(seen.stderr).toContain("tap session: ignoring leftover record fixture/reviewer — not on roster");
}, 60_000);

test("an unattended shell holding the name is reseated fresh, as the incumbent does", async () => {
  const { f, result } = differential("unattended shell reseat", ["testseat", "reviewer", "--json"], f => {
    fakeHarness(f);
    tmuxEffect(["new-session", "-d", "-s", "fixture/reviewer", "/bin/sh"], process.env);
  });
  expect(result.status).toBe(0);
  const row = seatRow(f);
  expect(row.status_reason).toBe("");
  expect(tmuxEffect(["display-message", "-p", "-t", row.pane_id, "#{pane_current_command}"], process.env).trim()).not.toBe("sh");
  expect(row.launch_tuning).toEqual({model:"model-test",effort:null,qualifiers:{},environment:{}});
  sameAsIncumbent("unattended shell reseat row", f, f => {
    const {launch_tuning, launch_witness, ...legacy} = seatRow(f);
    // launch_witness is launcher-minted bind evidence the incumbent's row never carried.
    expect(masked(JSON.stringify(launch_witness), f.root)).toBe('"<uuid>"');
    return JSON.parse(masked(JSON.stringify(legacy), f.root));
  });
}, 60_000);


test("fresh Codex hook dialog reports its frame and retains the seat for manual recovery", () => {
  const f = fixture("codex");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  copyFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt"), join(f.root, "frame"));
  writeFileSync(join(f.root, "bin/codex"), `#!/bin/bash\ncat '${f.root}/frame'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`, { mode: 0o755 });
  const result = run(f.root, ["testseat", "reviewer", "--json"], true);
  expect(result.status).toBe(2);
  expect(result.diagnostic).toContain("codex-hook-trust");
  expect(result.diagnostic).toContain("Hooks need review");
  expect(result.diagnostic).toContain("retained");
  expect(JSON.parse(result.stdout).action).toBe("tmux attach -t fixture/reviewer");
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  expect(row.status).toBe("active");
  expect(spawnSync(realTmux, ["-L", f.socket, "has-session", "-t", "=fixture/reviewer"]).status).toBe(0);
  expect(tmuxEffect(["capture-pane", "-p", "-t", row.pane_id], process.env)).toContain("Hooks need review");
  expect(tmuxEffect(["show-options", "-p", "-v", "-t", row.pane_id, "remain-on-exit"], process.env).trim()).not.toBe("on");
}, 25_000);


test("restart retains a hook dialog with its named attach action", () => {
  const f = fixture("codex");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  const frame = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt"), "utf8");
  writeFileSync(join(f.root, "frame"), frame);
  writeFileSync(join(f.root, "bin/codex"), `#!/bin/bash\ncat '${f.root}/frame'\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/codex' 600\n`, { mode: 0o755 });
  expect(run(f.root, ["testseat", "reviewer", "--json"], true).status).toBe(2);
  const restarted = spawnSync("bash", [publicBin, "session", "restart", "reviewer", "--force", "--json"], { cwd: f.root, env: process.env, encoding: "utf8", timeout: 20_000 });
  const receipt = JSON.parse(restarted.stdout);
  expect(receipt.error_class).toBe("harness_start_dialog");
  expect(receipt.action).toBe("tmux attach -t fixture/reviewer");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.status).toBe("active");
}, 25_000);

test("a native harness that exits during startup never reports running detached", () => {
  const f = fixture();
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/claude"));
  else symlinkSync("/bin/sleep", join(f.root, "real/claude"));
  writeFileSync(join(f.root, "bin/claude"), `#!/bin/bash\nexport PATH='${f.root}/real':"$PATH"\nexec '${f.root}/real/claude' 0.4\n`, { mode: 0o755 });
  const result = run(f.root, ["testseat", "reviewer"], true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("running detached");
  expect(result.diagnostic).toMatch(/readiness|harness did not start/);
}, 25_000);


test("the cwd warning's team-root guidance leads to a successful launch", () => {
  const f = fixture();
  fakeHarness(f);
  const warning = run(f.root, ["testseat", "reviewer", "--dry-run", "--cwd", "/some/linked/worktree"], true);
  expect(warning.stderr).toContain("Use --workdir <path> to start in a linked worktree of the enrolled team.");
  const launched = run(f.root, ["testseat", "reviewer"], true);
  expect(launched.status).toBe(0);
  expect(launched.stdout).toContain("running detached");
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer.registered_from_worktree).toBe(f.root);
}, 25_000);

// The wrapper mirrors the real SessionStart flow: the minted --session-id is
// reported back by `tap in` running as a child while the claude-named process
// owns the pane, so the bind is accepted and the row keeps launcher ownership.
function simulatedHookWrapper(f: { root: string; registry: string }, deathAfterBind: boolean) {
  return `#!/bin/bash\nset -e\nprintf '%s\\n' "$@" > '${f.root}/argv'\nsid=$(awk 'p=="--session-id"{print;exit}{p=$0}' '${f.root}/argv')\nTAP_REGISTER_LOCK_TIMEOUT=10 TAP_SKIP_VERSION_BRIEFING=1 TAP_HARNESS_SESSION_ID="$sid" TAP_SESSION_SOURCE=startup '${publicBin}' in --harness-session-id "$sid" > '${f.root}/bindout' 2> '${f.root}/binderr' &\n` +
    (deathAfterBind
      ? `for i in $(seq 1 100); do grep -q "$sid" '${f.registry}' && break; sleep 0.05; done\nexec '${f.root}/real/claude' 0.4\n`
      : `exec '${f.root}/real/claude' 600\n`);
}

test("a claude whose simulated SessionStart bind lands and then exits inside the settle fails readiness", () => {
  const f = fixture();
  fakeHarness(f);
  writeFileSync(join(f.root, "bin/claude"), simulatedHookWrapper(f, true), { mode: 0o755 });
  const result = run(f.root, ["claude", "reviewer"], true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("running detached");
  expect(result.diagnostic).toMatch(/readiness|harness did not start/);
}, 25_000);

// The readiness window ended BEFORE the fixed five-second deadline could
// expire — structurally impossible on main, whose window is a timer, and
// achievable whenever the positive-signal path works. Load only moves the
// bind's arrival time, never main's floor, so this pin stays red-on-main
// under any battery while tolerating scheduler delay in the signal chain.
function readinessWindowMs(f: { root: string }): number | null {
  try {
    const events: Array<Record<string, string>> = readFileSync(join(f.root, "index/logs/startup.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    const respawn = events.find(e => e.event === "respawn_pane" && e.session === "fixture/reviewer");
    const complete = events.find(e => e.event === "launch_complete" && e.operation_id === respawn?.operation_id);
    return respawn?.timestamp && complete?.timestamp
      ? Date.parse(complete.timestamp) - Date.parse(respawn.timestamp) : null;
  } catch { return null; }
}

// The launch ended on the harness's own positive signal, not the window timer: the
// trace names the signal, and launch_complete follows it within a short tail. A timer
// wait leaves the rest of the five-second window between them. Both events carry the
// launcher's own emission clock (`emitted_at`, stamped by the caller; `timestamp` is
// the asynchronous writer's drain time and is never mixed in), so the interval is the
// launcher's own signal-to-completion time and no absolute host clock enters it.
function expectEndedOnSignal(f: { root: string }, signal: string) {
  const events: Array<Record<string, string>> = readFileSync(join(f.root, "index/logs/startup.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const respawn = events.find(e => e.event === "respawn_pane" && e.session === "fixture/reviewer");
  const seen = events.find(e => e.event === "readiness_signal" && e.signal === signal && e.launch_id === respawn?.launch_id);
  const complete = events.find(e => e.event === "launch_complete" && e.operation_id === respawn?.operation_id);
  expect(seen?.emitted_at, `trace names ${signal} for the launch`).toBeDefined();
  expect(complete?.emitted_at, "launch_complete in the trace").toBeDefined();
  expect(Date.parse(complete!.emitted_at!) - Date.parse(seen!.emitted_at!), "launch_complete follows the signal, not the window timer").toBeLessThan(3000);
}

test("a claude whose simulated SessionStart bind lands returns well before the full window", () => {
  const f = fixture();
  fakeHarness(f);
  writeFileSync(join(f.root, "bin/claude"), simulatedHookWrapper(f, false), { mode: 0o755 });
  const result = run(f.root, ["claude", "reviewer"], true);
  expect(result.status, result.diagnostic).toBe(0);
  expect(result.stdout).toContain("running detached");
  expectEndedOnSignal(f, "claude_bind");
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.reviewer;
  const argvLines = readFileSync(join(f.root, "argv"), "utf8").trim().split("\n");
  expect(row.harness_session_id).toBe(argvLines[argvLines.indexOf("--session-id") + 1]);
  expect(row.status).toBe("active");
  expect(row.status_reason).toBe("");
  expect(Object.hasOwn(row, "launch_id")).toBe(false);
}, 25_000);

test("a codex that paints its composer and stays alive returns well before the full window", () => {
  const f = fixture("codex");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  writeFileSync(join(f.root, "bin/codex"), `#!/bin/bash\nprintf '\\r\\n\\033[2m› Ask Codex to do anything\\033[0m\\n'\nexec '${f.root}/real/codex' 600\n`, { mode: 0o755 });
  const result = run(f.root, ["codex", "reviewer"], true);
  expect(result.status, result.diagnostic).toBe(0);
  expect(result.stdout).toContain("running detached");
  expectEndedOnSignal(f, "codex_idle");
}, 25_000);

test("a codex that paints its composer and exits inside the settle fails readiness", () => {
  const f = fixture("codex");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/codex"));
  else symlinkSync("/bin/sleep", join(f.root, "real/codex"));
  writeFileSync(join(f.root, "bin/codex"), `#!/bin/bash\nprintf '\\r\\n\\033[2m› Ask Codex to do anything\\033[0m\\n'\nexec '${f.root}/real/codex' 0.4\n`, { mode: 0o755 });
  const result = run(f.root, ["codex", "reviewer"], true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("running detached");
  expect(result.diagnostic).toMatch(/readiness|harness did not start/);
}, 25_000);

// The idle composer band, painted with SGR the way the live pane does it: the
// signal's predicate strips those bytes, so the signal survives them.
const OPENCODE_IDLE_PAINT = `printf '\\n  \\033[90m┃  Ask anything… Fix broken tests\\033[0m\\n  \\033[90m╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\\033[0m\\n                                               tab agents  ctrl+p commands\\n'\n`;

function opencodeFixture(f: ReturnType<typeof fixture>, life: string, prePaint = "", paint = OPENCODE_IDLE_PAINT) {
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/opencode"));
  else symlinkSync("/bin/sleep", join(f.root, "real/opencode"));
  writeFileSync(join(f.root, "bin/opencode"), `#!/bin/bash\n${prePaint}${paint}exec '${f.root}/real/opencode' ${life}\n`, { mode: 0o755 });
}

test("an opencode that paints its idle composer and stays alive returns well before the full window", () => {
  const f = fixture("opencode");
  opencodeFixture(f, "600");
  const result = run(f.root, ["opencode", "reviewer"], true);
  expect(result.status, result.diagnostic).toBe(0);
  expect(result.stdout).toContain("running detached");
  expectEndedOnSignal(f, "opencode_idle");
}, 25_000);

test("an opencode that paints its idle composer and exits inside the settle fails readiness", () => {
  const f = fixture("opencode");
  opencodeFixture(f, "0.4");
  const result = run(f.root, ["opencode", "reviewer"], true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("running detached");
  expect(result.diagnostic).toMatch(/readiness|harness did not start/);
}, 25_000);

test("an opencode that never paints its idle composer takes the full window and succeeds", () => {
  const f = fixture("opencode");
  mkdirSync(join(f.root, "real"));
  if (process.platform === "linux") copyFileSync("/bin/sleep", join(f.root, "real/opencode"));
  else symlinkSync("/bin/sleep", join(f.root, "real/opencode"));
  writeFileSync(join(f.root, "bin/opencode"), `#!/bin/bash\nexec '${f.root}/real/opencode' 600\n`, { mode: 0o755 });
  const result = run(f.root, ["opencode", "reviewer"], true);
  expect(result.status, result.diagnostic).toBe(0);
  expect(result.stdout).toContain("running detached");
  expect(readinessWindowMs(f), "respawn→launch_complete from startup trace").toBeGreaterThanOrEqual(4900);
}, 25_000);

// A renderer that wraps rows must still signal: the readiness capture carries
// no -J. The fake paints the band as the soft-wrapped continuation of ONE
// logical line longer than the 200-column pane: unjoined, the wrap puts the
// box row and the border row on their own physical rows (┃ above ╹▀) and the
// signal fires; a joined (-J) capture merges them into a single logical line
// where no row starts with the border glyph — red under any -J wiring.
test("an opencode that paints its idle composer as a wrapped band still signals", () => {
  const f = fixture("opencode");
  // `  ┃  Ask anything… "Fix broken tests"` is 37 columns; padding to 200 puts
  // the border glyph at column 0 of the continuation row.
  const wrappedBand = "printf '  ┃  Ask anything… \"Fix broken tests\"%*s' 163 ''\nprintf '╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\\n'\n";
  opencodeFixture(f, "600", wrappedBand, "");
  const result = run(f.root, ["opencode", "reviewer"], true);
  expect(result.status, result.diagnostic).toBe(0);
  expect(result.stdout).toContain("running detached");
  expectEndedOnSignal(f, "opencode_idle");
}, 25_000);
