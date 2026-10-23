import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const shippedEntry = join(root, "bin/tap");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

function treeHash(rootDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) walk(path);
      else {
        const st = statSync(path);
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        parts.push(`${path}:${st.mtimeMs}:${st.size}:${digest}`);
      }
    }
  };
  walk(rootDir);
  return parts.join("\n");
}

// tap-0y4u zero-write coverage: the whole bus-bearing worktree, the index
// home, and the sandbox home. Only the route trace (fx.trace, outside all
// three) is allowed to move.
function stateDigest(fx: ReturnType<typeof fixture>): string {
  return [treeHash(fx.worktree), treeHash(fx.index), treeHash(fx.home)].join("\n");
}

const DEAD_TMUX = "#!/bin/sh\nexit 1\n";
const DEAD_LSOF = "#!/bin/sh\nexit 1\n";

// Session alive, panes listed, ps skipped (rc 1) — the shape that makes a
// suspended/server_restarted row with cleared pane fields classify unbound
// (the team-unbound-state.test.sh corpus shape).
const UNBOUND_TMUX = `#!/bin/sh
case "$1" in
  list-sessions) printf 'demo/scout\\t900:100\\t0\\n' ;;
  list-panes) printf 'demo/scout\\tdemo/scout:0.0\\t%%11\\tcodex\\t111\\t900:100\\t0\\n' ;;
  display-message) case "$*" in *pane_tty*) echo /dev/faketty ;; *) echo 900:100 ;; esac ;;
  *) exit 1 ;;
esac
`;

// A codex seat's pane: display-message answers pane_pid 999, ps eww reports a
// PATH with no usable node dir.
const CODEX_TMUX = `#!/bin/sh
case "$1" in
  list-sessions) printf 'cx\\t900:100\\t0\\n' ;;
  list-panes) printf 'cx\\tcx:0.0\\t%%1\\tcodex\\t200\\t900:100\\t0\\n' ;;
  display-message)
    for a in "$@"; do [ "$a" = "%1" ] && { printf '999\\n'; exit 0; }; done
    printf '900:100\\n' ;;
  *) exit 1 ;;
esac
`;

interface FixtureOpts {
  tmuxSh?: string;
  psSh?: string;
  lsofSh?: string;
  bus?: boolean;
  index?: unknown;
  registry?: unknown;
}

function fixture(opts: FixtureOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tap-bun-doctor."));
  scratch.push(dir);
  const home = join(dir, "home");
  const index = join(dir, "index");
  const worktree = join(dir, "worktree");
  const bin = join(dir, "bin");
  const trace = join(dir, "route.trace");
  mkdirSync(home, { recursive: true });
  mkdirSync(index, { recursive: true });
  mkdirSync(bin, { recursive: true });
  spawnSync("git", ["init", "-q", worktree]);
  const real = realpathSync(worktree);
  if (opts.bus !== false) {
    for (const sub of ["payloads", "receipts", "spool", "input-backups", "watch/evaluator-prompts"]) {
      mkdirSync(join(worktree, ".tap", "bus", sub), { recursive: true });
    }
  }
  writeFileSync(join(bin, "tmux"), opts.tmuxSh ?? DEAD_TMUX, { mode: 0o755 });
  // Default lsof fake keeps the tmux-server census out of unrelated arms; the
  // census arm overrides with a fixture that answers.
  writeFileSync(join(bin, "lsof"), opts.lsofSh ?? DEAD_LSOF, { mode: 0o755 });
  if (opts.psSh) writeFileSync(join(bin, "ps"), opts.psSh, { mode: 0o755 });
  if (opts.bus !== false) {
    // "REALROOT" in the registry doc stands in for the fixture's real root,
    // which only exists after mkdtemp.
    const doc = JSON.parse(JSON.stringify(opts.registry ?? {
      schema: "0.20",
      team: { name: "u1", worktree_root: "REALROOT" },
      seats: {},
    })) as { team?: { worktree_root?: string }; seats?: Record<string, unknown>; agents?: Record<string, unknown> };
    if (doc.team?.worktree_root === "REALROOT") doc.team.worktree_root = real;
    writeFileSync(
      join(worktree, ".tap", "team-registry.json"),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
    // The ambient bus mirror the bash incumbent reads by default.
    writeFileSync(
      join(worktree, ".tap", "bus", "registry.json"),
      `${JSON.stringify({
        schema: "0.20",
        team: { name: "u1", worktree_root: real },
        seats: doc.seats ?? doc.agents ?? {},
      }, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(index, "global-registry.json"),
    `${JSON.stringify(opts.index ?? {
      schema: "0.20",
      teams: { u1: { root: real, registry_location: join(real, ".tap", "team-registry.json") } },
    })}\n`,
  );
  return { dir, home, index, worktree, bin, trace, real, bus: join(worktree, ".tap", "bus") };
}

function doctorEnv(fx: ReturnType<typeof fixture>, extra: NodeJS.ProcessEnv = {}, cwd?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: fx.home,
    XDG_CONFIG_HOME: join(fx.home, ".config"),
    TAP_INDEX_HOME: fx.index,
    TAP_SESSION_MANIFEST: join(fx.index, "sessions.json"),
    OPENCODE_DB_PATH: join(fx.index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(fx.index, "version-seen.json"),
    TAP_ONBOARDING_CHECKED: "1",
    TAP_BUN_ROUTE_TRACE: fx.trace,
    TAP_SERVER_EPOCH: "srv:900:100",
    TAP_BOOT_ID: "boot:2",
    TAP_WATCH_NOW: "1787790000",
    NO_COLOR: "1",
  };
  delete env.TAP_HOME;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  // The runner pins these for its own sandbox server; left in, the census
  // derives a socket path the fixture fake never answers for, and every seat
  // reads unobservable. TMUX_TMPDIR gets a deliberately MISSING fixture path
  // (not the machine default): the default-socket derivation stays
  // deterministic and no real server can collide with a fixture assertion.
  delete env.TAP_TMUX_SOCKET;
  delete env.TAP_TMUX_SOCKET_PATH;
  env.TMUX_TMPDIR = join(fx.dir, "tmux-missing");
  if (cwd) env.TAP_CHECKOUT_ROOT = cwd;
  // Caller overrides (e.g. TAP_HOME) win over the stripped ambient env.
  return { ...env, ...extra };
}

function runDoctor(
  fx: ReturnType<typeof fixture>,
  args: string[] = [],
  extra: NodeJS.ProcessEnv = {},
  cwd?: string,
) {
  const run = spawnSync(shippedEntry, ["doctor", ...args], {
    cwd: cwd ?? fx.worktree,
    env: doctorEnv(fx, extra, cwd),
    encoding: "utf8",
    // A blocked shared input (FIFO) must surface as rc -1, not hang the run.
    timeout: 30000,
  });
  return { rc: run.status ?? -1, out: run.stdout ?? "", err: run.stderr ?? "" };
}

test("doctor diagnoses missing or disabled agy identity wiring and recognizes the installed hook", () => {
  const fx = fixture({ registry: { schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: {
    scout: { harness: "agy", status: "active", delivery: "pane" },
  } } });
  const gemini = join(fx.home, ".gemini"), hooks = join(gemini, "config/hooks.json");
  const finding = () => JSON.parse(runDoctor(fx, ["--json"], { TAP_GEMINI_HOME: gemini }).out).findings
    .find((row: { name: string }) => row.name === "agy_identity_hook");
  expect(finding()?.detail.status).toBe("missing");
  mkdirSync(join(gemini, "config"), { recursive: true });
  const spec = {
    PreInvocation: [{ type: "command", command: `bash '${join(root, "hooks/tap-agy-identity.sh")}'`, timeout: 3 }],
    PostInvocation: [{ type: "command", command: `bash '${join(root, "hooks/tap-agy-identity.sh")}'`, timeout: 3 }],
  };
  writeFileSync(hooks, JSON.stringify({ "tap-session-identity": { ...spec, enabled: false } }));
  expect(finding()?.detail.status).toBe("disabled");
  writeFileSync(hooks, JSON.stringify({ "tap-session-identity": spec }));
  expect(finding()).toBeUndefined();
  mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
  const db = new Database(join(gemini, "antigravity-cli/conversation_summaries.db"));
  db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY)");
  db.close();
  const store = JSON.parse(runDoctor(fx, ["--json"], { TAP_GEMINI_HOME: gemini }).out).findings
    .find((row: { name: string }) => row.name === "agy_identity_store");
  expect(store?.detail.status).toBe("unavailable");
  expect(store?.detail.reason).toContain("parent_conversation_id");
});

test("doctor inspects the configured command without invoking it and names missing transports", () => {
  const fx = fixture(), config = join(fx.home, ".config/tap"), marker = join(fx.dir, "notified");
  mkdirSync(config, { recursive: true });
  const command = join(fx.bin, "notifier");
  writeFileSync(command, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');\n`, { mode: 0o700 });
  writeFileSync(join(config, "config.toml"), '[notifications]\nnotifier="command"\ncommand=' + JSON.stringify([command, "{body}"]) + '\n');
  let run = runDoctor(fx, ["--json"], { TAP_NOTIFY_USER_BIN: "" });
  expect(JSON.parse(run.out).findings.find((f: {name: string}) => f.name === "notifier").detail).toMatchObject({ notifier: "command", source: "config", available: true });
  expect(existsSync(marker)).toBe(false);
  run = runDoctor(fx, ["--json"], { TAP_NOTIFY_USER_BIN: join(fx.dir, "missing") });
  expect(JSON.parse(run.out).findings.find((f: {name: string}) => f.name === "notifier").detail).toMatchObject({ source: "override", available: false });
  expect(existsSync(marker)).toBe(false);
});

test("doctor surfaces an invalid injection.behavior naming the key and valid values; a valid one adds no finding", () => {
  const fx = fixture(), config = join(fx.home, ".config/tap");
  mkdirSync(config, { recursive: true });
  const findingOf = () => (JSON.parse(runDoctor(fx, ["--json"]).out).findings as { name: string; severity: string; detail: Record<string, string> }[])
    .find((f) => f.name === "injection_behavior");
  writeFileSync(join(config, "config.toml"), '[injection]\nbehavior = "wait"\n');
  expect(findingOf()).toBeUndefined();
  const bytes = '[injection]\nbehavior = "typo"\n';
  writeFileSync(join(config, "config.toml"), bytes);
  const finding = findingOf();
  expect(finding).toMatchObject({ severity: "warning", detail: { error_class: "injection_behavior_invalid", detail: "injection.behavior must be clobber or wait" } });
  expect(readFileSync(join(config, "config.toml"), "utf8")).toBe(bytes);
});

const CONFIG_FAULTS: [string, (file: string) => void][] = [
  ["malformed TOML", (file) => writeFileSync(file, '[injection]\nbehavior = "wait"\n[unrelated\n')],
  ["a FIFO", (file) => expect(spawnSync("mkfifo", [file]).status).toBe(0)],
  ["a directory", (file) => mkdirSync(file)],
  ["an unreadable file", (file) => { writeFileSync(file, '[injection]\nbehavior = "wait"\n'); chmodSync(file, 0o000); }],
];
for (const [label, plant] of CONFIG_FAULTS) {
  for (const mode of [[], ["--json"]]) {
    test(`doctor refuses structurally for config.toml as ${label}, never blaming injection or hanging (${mode.length ? "json" : "human"})`, () => {
      if (label === "an unreadable file" && process.getuid?.() === 0) return;
      const fx = fixture(), config = join(fx.home, ".config/tap");
      mkdirSync(config, { recursive: true });
      const file = join(config, "config.toml");
      plant(file);
      const run = runDoctor(fx, mode);
      expect(run.rc, "doctor blocked or died unrefused").toBe(1);
      expect(run.out).not.toContain("injection_behavior");
      const out = run.err + run.out;
      expect(out).toContain("invalid preset config");
      expect(out).toContain("config.toml");
      if (mode.length) {
        const objects = out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(objects.some((object) => object.error_class === "preset_config_invalid")).toBe(true);
      }
      if (label === "malformed TOML") expect(readFileSync(file, "utf8")).toBe('[injection]\nbehavior = "wait"\n[unrelated\n');
    });
  }
}

function jsonRun(fx: ReturnType<typeof fixture>, args: string[] = [], extra: NodeJS.ProcessEnv = {}, cwd?: string) {
  const run = runDoctor(fx, [...args, "--json"], extra, cwd);
  const report = JSON.parse(run.out.trim()) as {
    ok: boolean;
    bus: { home: string; rule: string };
    findings: { severity: string; name: string; detail: Record<string, unknown>; next?: string }[];
    summary: { torn: number; unattributed: number; clean: boolean; seat_attention: number };
    installation: unknown;
  };
  return { ...run, report, find: (name: string) => report.findings.filter((f) => f.name === name) };
}

function payload(bus: string, name: string, body: string) {
  writeFileSync(join(bus, "payloads", name), body);
}

const ENVELOPE = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\nbody\n`;

describe("tap doctor (native cutover, tap-hgf07)", () => {
  test("tap-0y4u: unenrolled cwd is refused before any bus materializes", () => {
    // Genuinely unenrolled: the index does not name this root, so the default
    // rule refuses (the zero-write refusal must survive the enrolled-missing-
    // bus case).
    const fx = fixture({ bus: false, index: { schema: "0.20", teams: {} } });
    const before = stateDigest(fx);
    const run = runDoctor(fx);
    expect(run.rc, run.err + run.out).toBe(4);
    expect(run.err).toContain("TAP_HOME");
    expect(run.err).toContain("next: run tap init in your project");
    expect(existsSync(join(fx.worktree, ".tap"))).toBe(false);
    const again = runDoctor(fx);
    expect(again.rc).toBe(4);
    expect(existsSync(join(fx.worktree, ".tap"))).toBe(false);
    expect(stateDigest(fx)).toBe(before);
  });

  test("tap-0y4u: the JSON refusal is one stdout object with zero stderr", () => {
    const fx = fixture({ bus: false, index: { schema: "0.20", teams: {} } });
    const run = runDoctor(fx, ["--json"]);
    expect(run.rc).toBe(4);
    expect(run.err).toBe("");
    const report = JSON.parse(run.out.trim()) as { ok: boolean; error_class: string; action: string };
    expect(report.ok).toBe(false);
    expect(report.error_class).toBe("unanchored_bus");
  });

  test("an enrolled checkout with a missing bus still gets diagnostics; nothing materializes", () => {
    const fx = fixture();
    rmSync(fx.bus, { recursive: true, force: true });
    const before = stateDigest(fx);
    const run = runDoctor(fx);
    // Live enrollment checks first: the default rule only refuses when the
    // cwd is genuinely unenrolled.
    expect(run.rc, run.err + run.out).toBe(0);
    expect(run.out).toContain("tap doctor: bus=");
    expect(run.out).not.toContain("unanchored");
    // Zero-write: the missing bus stays missing.
    expect(existsSync(fx.bus)).toBe(false);
    expect(stateDigest(fx)).toBe(before);
  });

  test("tap-0y4u: an explicit TAP_HOME scratch bus still gets full diagnostics", () => {
    const fx = fixture();
    // Deliberately place the custom home under an enrolled worktree: explicit
    // TAP_HOME still names this bus, not the enclosing team's acting registry.
    const scratchBus = join(fx.worktree, "scratch-bus");
    for (const sub of ["payloads", "receipts", "spool"]) {
      mkdirSync(join(scratchBus, sub), { recursive: true });
    }
    const run = jsonRun(fx, [], { TAP_HOME: scratchBus });
    expect(run.rc, run.err).toBe(0);
    // The shell canonicalizes TAP_HOME through `pwd -P` (macOS /var → /private/var),
    // so the rendered header names the resolved path, not the literal we passed.
    expect(run.report.bus.home).toBe(realpathSync(scratchBus));
    expect(run.report.bus.rule).toBe("env");
    // The cwd is enrolled, but an explicit custom bus must not borrow that
    // team's acting registry and present the scratch bus as registry-backed.
    expect(run.find("no_registry").length).toBe(1);
  });

  test("F2: a canonical explicit bus with an unenrolled root fails closed", () => {
    const fx = fixture({ index: { schema: "0.20", teams: {} } });
    // Explicit TAP_HOME at the canonical .tap/bus: a live index that omits the
    // fixture root makes this an unreachable acting registry, not a scratch bus.
    const run = runDoctor(fx, [], { TAP_HOME: fx.bus });
    expect(run.rc).toBe(1);
    expect(run.err).toContain("acting_registry_unreachable");
    expect(run.out).not.toContain("clean — no torn payloads");
  });

  test("a trailing-separator canonical TAP_HOME fails closed like its no-slash form", () => {
    // resolved() can only normalize separators for homes that already exist;
    // a MISSING canonical spelling with a trailing slash must still classify
    // canonical (fail closed), not scratch.
    const fx = fixture({ bus: false, index: { schema: "0.20", teams: {} } });
    const canonicalMissing = `${join(fx.worktree, ".tap", "bus")}/`;
    const run = runDoctor(fx, [], { TAP_HOME: canonicalMissing });
    expect(run.rc).toBe(1);
    expect(run.err).toContain("acting_registry_unreachable");
  });

  test("an unenrolled dotdir bus with a stale mirror reports unreachable, not a mirror scan", () => {
    // Under a live marker, an implicit canonical dotdir bus is that root's
    // team bus: an unenrolled root must fail closed exactly like an explicit
    // canonical home — the stale bus mirror is never scanned.
    const fx = fixture({ index: { schema: "0.20", teams: {} } });
    const run = runDoctor(fx);
    expect(run.rc).toBe(1);
    expect(run.err).toContain("acting_registry_unreachable");
    expect(run.out).not.toContain("clean — no torn payloads");
  });

  test("an invalid marker with a missing bus reaches its authority finding, not unanchored", () => {
    // Only GENUINE enrollment absence is unanchored_bus; invalid/ambiguous/
    // unreachable authority states proceed to their existing findings.
    const fx = fixture({
      bus: false,
      index: { schema: "0.19", teams: { gone: { root: join(tmpdir(), "tap-doctor-nope"), registry_location: "x" } } },
    });
    const run = runDoctor(fx);
    expect(run.rc).toBe(1);
    expect(run.out).toContain("invalid_flip");
    expect(run.out + run.err).not.toContain("unanchored_bus");
    expect(run.err).toContain("authority error");
    // Zero-write holds on the authority path too.
    expect(existsSync(join(fx.worktree, ".tap"))).toBe(false);
  });

  test("lexical TAP_HOME aliases cannot bypass canonical classification", () => {
    // resolve() normalizes `/.`, `/..`, and repeated separators lexically, so
    // alias spellings of a MISSING canonical home still fail closed.
    const fx = fixture({ bus: false, index: { schema: "0.20", teams: {} } });
    const canonical = join(fx.worktree, ".tap", "bus");
    for (const spelling of [`${canonical}/.`, `${canonical}//`]) {
      const run = runDoctor(fx, [], { TAP_HOME: spelling });
      expect(run.rc, spelling).toBe(1);
      expect(run.err, spelling).toContain("acting_registry_unreachable");
    }
  });

  test("the shipped entry routes doctor natively", () => {
    const fx = fixture();
    const run = runDoctor(fx);
    expect(run.rc, run.err).toBe(0);
    expect(readFileSync(fx.trace, "utf8")).toContain("native doctor");
    const installation = jsonRun(fx).report.installation as Record<string, unknown>;
    expect(installation.tap).toBeDefined();
    expect(installation.installed_tap).toBeUndefined();
  });

  test("the public entry exempts doctor from the machine command journal", () => {
    const fx = fixture();
    // Machine debug recording is enabled; the whole public doctor command is
    // zero-write, so the entry must not journal it.
    const journalDir = join(fx.dir, "journal");
    mkdirSync(journalDir, { recursive: true });
    mkdirSync(join(fx.index, "debug"), { recursive: true });
    writeFileSync(join(fx.index, "debug", "enabled.json"), `${JSON.stringify({ id: "test-run", directory: journalDir })}\n`);
    const spawnTap = (args: string[]) => spawnSync(shippedEntry, args, {
      cwd: fx.worktree,
      env: doctorEnv(fx),
      encoding: "utf8",
      timeout: 60000,
    });
    const journalBytes = () =>
      readdirSync(journalDir).sort().map((f) => readFileSync(join(journalDir, f), "utf8")).join("\n---\n");
    // Sanity: the journal machinery is live — an ordinary verb journals.
    const probe = spawnTap(["help"]);
    expect(probe.status, String(probe.stderr)).toBe(0);
    let snapshot = journalBytes();
    expect(snapshot.length).toBeGreaterThan(0);
    // Global -v/--verbose flags precede the verb: a leading-verbose doctor is
    // still doctor and must not journal either, while a leading-verbose
    // ordinary verb still does.
    const verboseProbe = spawnTap(["--verbose", "help"]);
    expect(verboseProbe.status, String(verboseProbe.stderr)).toBe(0);
    snapshot = journalBytes();
    expect(snapshot.length).toBeGreaterThan(0);
    const before = snapshot;
    // doctor must not journal, in either spelling.
    const run = spawnTap(["doctor"]);
    expect(run.status, String(run.stderr) + String(run.stdout)).toBe(0);
    expect(journalBytes()).toBe(before);
    const verboseRun = spawnTap(["--verbose", "doctor"]);
    expect(verboseRun.status, String(verboseRun.stderr) + String(verboseRun.stdout)).toBe(0);
    expect(journalBytes()).toBe(before);
  });

  test("treeHash digests file bytes: an equal-length rewrite with restored mtimes changes the digest", () => {
    const fx = fixture({ bus: false });
    const probe = join(fx.worktree, "probe.txt");
    // A whole-second mtime is exactly representable on every platform, so
    // utimesSync restores it losslessly: only the content bytes can move the
    // digest. No exact floating-point mtime equality is required.
    const epoch = 1789000000;
    writeFileSync(probe, "aaaa");
    utimesSync(probe, epoch, epoch);
    const before = treeHash(fx.worktree);
    writeFileSync(probe, "bbbb");
    utimesSync(probe, epoch, epoch);
    expect(statSync(probe).mtimeMs).toBe(epoch * 1000);
    expect(treeHash(fx.worktree)).not.toBe(before);
  });

  test("a torn payload exits 1 in both modes and never writes", () => {
    const fx = fixture();
    payload(fx.bus, "torn-001.md", ENVELOPE({ id: "torn-001", from: "a", kind: "note", path: "x" }));
    const before = stateDigest(fx);
    const human = runDoctor(fx);
    expect(human.rc).toBe(1);
    expect(human.err).toContain("torn-payload");
    const json = jsonRun(fx);
    expect(json.rc).toBe(1);
    expect(json.report.summary.torn).toBe(1);
    expect(json.report.summary.unattributed).toBe(0);
    expect(json.find("torn_payload")[0]?.severity).toBe("error");
    expect(json.err).toBe("");
    expect(stateDigest(fx)).toBe(before);
  });

  test("torn taxonomy: zero-byte, bad token, filename mismatch", () => {
    const fx = fixture();
    writeFileSync(join(fx.bus, "payloads", "zero-001.md"), "");
    payload(fx.bus, "tokn-001.md", ENVELOPE({ id: "tokn-001", from: "a b", to: "c", kind: "note", path: "p" }));
    payload(fx.bus, "mis-001.md", ENVELOPE({ id: "other-id", from: "a", to: "c", kind: "note", path: "p" }));
    const json = jsonRun(fx);
    expect(json.rc).toBe(1);
    expect(json.report.summary.torn).toBe(3);
  });

  test("frontmatter accepts CRLF but keeps unsafe trailing token and path whitespace", () => {
    const fx = fixture();
    const crlf = join(fx.bus, "payloads", "crlf-001.md");
    writeFileSync(crlf, `---\r\nid: crlf-001\r\nfrom: a\r\nto: b\r\nkind: note\r\npath: ${crlf}\r\n---\r\n\r\nbody\r\n`);
    payload(fx.bus, "trail-001.md", ENVELOPE({ id: "trail-001", from: "a ", to: "b", kind: "note", path: "p" }));
    payload(fx.bus, "space-001.md", ENVELOPE({ id: "space-001", from: "a", to: "b", kind: "note", path: "/tmp/has space" }));
    const json = jsonRun(fx);
    expect(json.report.summary.torn).toBe(2);
    expect(json.find("torn_payload").map((f) => f.detail.path)).not.toContain("crlf-001.md");
  });

  test("unattributed payloads warn without flipping the exit", () => {
    const fx = fixture();
    payload(fx.bus, "unat-001.md", ENVELOPE({ id: "unat-001", from: "a", to: "b", kind: "note", path: "p" }));
    const human = runDoctor(fx);
    expect(human.rc).toBe(0);
    expect(human.out).toContain("unattributed");
    expect(human.out).toContain("labeled, not hidden");
    const json = jsonRun(fx);
    expect(json.rc).toBe(0);
    expect(json.find("unattributed_payload").length).toBe(1);
  });

  test("F5: a directory at receipts/<id>.placed does not attribute the payload", () => {
    const fx = fixture();
    payload(fx.bus, "dirc-001.md", ENVELOPE({ id: "dirc-001", from: "a", to: "b", kind: "note", path: "p" }));
    // The incumbent tested os.path.isfile(): a directory named like a receipt
    // is not attribution.
    mkdirSync(join(fx.bus, "receipts", "dirc-001.placed"), { recursive: true });
    expect(jsonRun(fx).find("unattributed_payload").length).toBe(1);
  });

  test("external path and unsanctioned reply warn", () => {
    const fx = fixture();
    payload(fx.bus, "extp-001.md", ENVELOPE({
      id: "extp-001", from: "a", to: "b", kind: "note", path: "/elsewhere/extp-001.md",
    }));
    payload(fx.bus, "repl-001.md", ENVELOPE({
      id: "repl-001", from: "a", to: "b", kind: "note", reply: "sure-thing",
      path: join(fx.bus, "payloads", "repl-001.md"),
    }));
    const json = jsonRun(fx);
    expect(json.find("external_path").length).toBe(1);
    expect(json.find("unsanctioned_reply").length).toBe(1);
    expect(json.rc).toBe(0);
    // F4: the incumbent rendered every warning through tap_warning, which
    // inserts `warning:` — unlabeled warning families get the label exactly
    // once on the human stream.
    const human = runDoctor(fx);
    expect(human.err).toContain("tap doctor: warning: external-path");
    expect(human.err).not.toContain("warning: warning:");
  });

  test("registry findings: old format is old_store, missing team block, suspended seat", () => {
    // An old-format registry is one old_store error, never read for seats or team warnings.
    const legacy = fixture({ registry: { version: 3, agents: { ghost: { pane: "x:0.0" } } } });
    const legacyRun = jsonRun(legacy);
    expect(legacyRun.find("old_store").length).toBe(1);
    expect(legacyRun.find("registry_legacy_entry").length).toBe(0);
    expect(legacyRun.find("registry_no_team").length).toBe(0);
    expect(legacyRun.find("old_store")[0]!.severity).toBe("error");
    // Doctor's exit reflects torn bus state only; findings, old_store included, are its report.
    expect(legacyRun.rc).toBe(0);
    const hybrid = jsonRun(fixture({ registry: { schema: "0.20", seats: {}, agents: {} } }));
    expect(hybrid.find("old_store").length).toBe(1);

    const noTeam = fixture({ registry: { schema: "0.20", seats: {} } });
    expect(jsonRun(noTeam).find("registry_no_team").length).toBe(1);

    const suspended = fixture({
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: join("REPLACED") },
        seats: { parked: { status: "suspended", status_reason: "pane_gone", harness: "claude" } },
      },
    });
    writeFileSync(
      join(suspended.worktree, ".tap", "team-registry.json"),
      `${JSON.stringify({
        schema: "0.20",
        team: { name: "u1", worktree_root: suspended.real },
        seats: { parked: { status: "suspended", status_reason: "pane_gone", harness: "claude" } },
      }, null, 2)}\n`,
    );
    const susHuman = runDoctor(suspended);
    expect(susHuman.err).toContain("attention");
    expect(susHuman.err).toContain("parked");
    expect(susHuman.err).toContain("tap register parked");
    const susJson = jsonRun(suspended);
    expect(susJson.find("suspended_agent").length).toBe(1);
  });

  const absentSeatTmux = `#!/bin/sh
case "$1" in
  list-sessions) printf 'other\\t900:100\\t0\\n' ;;
  list-panes) printf 'other\\tother:0.0\\t%%2\\tclaude\\t200\\t900:100\\t0\\n' ;;
  display-message) echo '900:100' ;;
  *) exit 1 ;;
esac
`;
  const activeSeat = {
    status: "active", delivery: "pane", harness: "claude", session: "u1/scout",
    pane: "u1/scout:0.0", pane_id: "%9", server_epoch: "srv:900:100", boot_id: "boot:2",
  };

  for (const [epoch, reason] of [["srv:900:100", "session_absent"], ["srv:901:100", "server_epoch_stale"]]) {
    test(`stored-active seat with ${reason} is named separately from clean bus integrity, without writes`, () => {
      const fx = fixture({ tmuxSh: absentSeatTmux, registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
        seats: { scout: { ...activeSeat, server_epoch: epoch } },
      } });
      const before = stateDigest(fx);
      const json = jsonRun(fx);
      expect(json.rc).toBe(0);
      expect(json.find("seat_unavailable")[0]?.detail).toMatchObject({ handle: "scout", reason, next: "tap session resume scout" });
      expect(json.report.summary).toMatchObject({ clean: true, seat_attention: 1 });
      const human = runDoctor(fx);
      expect(human.rc).toBe(0);
      expect(human.err).toContain("active seat 'scout'");
      expect(human.err).toContain(reason!);
      expect(human.err).toContain("tap session resume scout");
      expect(human.out).toContain("seat health: 1 seat(s) need attention");
      expect(human.out).toContain("bus integrity: clean");
      expect(stateDigest(fx)).toBe(before);
    });
  }

  for (const [metadata, command] of [
    [{}, "tap crew add claude scout --model <model>"],
    [{ model: "claude-sonnet-4-5" }, "tap crew add claude scout --model claude-sonnet-4-5"],
    [{ preset: { name: "reviewer" }, model: "claude-sonnet-4-5", harness_env: { PRESET_VALUE: "private-preset-value" }, passthrough: ["--effort", "high"], passthrough_from_config: true, permissions: "auto" }, "tap crew add reviewer scout"],
  ] as const) {
    test(`gone crew recovery preserves the crew lifecycle: ${command}`, () => {
      const tmuxSh = absentSeatTmux.replace('case "$1" in', 'case "$*" in *"#{socket_path}"*) exit 1 ;; esac\ncase "$1" in');
      const fx = fixture({ tmuxSh, registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
        seats: { scout: { ...activeSeat, crew: true, ...metadata } },
      } });
      const before = stateDigest(fx);
      const next = jsonRun(fx).find("seat_unavailable")[0]?.detail.next;
      expect(next).toBe(`tap team refresh, then ${command} --cwd ${fx.real}`);
      expect(runDoctor(fx).err).toContain(String(next));
      expect(stateDigest(fx)).toBe(before);
    });
  }

  test("gone crew with stored bypass preserves its recipe when the current default is auto", () => {
    const fx = fixture({ tmuxSh: absentSeatTmux, registry: {
      schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
      seats: { scout: { ...activeSeat, crew: true, preset: { name: "reviewer" }, permissions: "bypass" } },
    } });
    const next = String(jsonRun(fx).find("seat_unavailable")[0]?.detail.next);
    expect(next).toContain("preserve the stored launch recipe");
    expect(next).not.toContain("tap team refresh");
  });

  for (const typed of [{ harness_env_set: ["CREW_SETTING"] }, { harness_unset_env: ["CREW_SETTING"] }, { harness_tail: ["--verbose"] }]) {
    test(`gone preset crew with typed overrides preserves its recipe: ${Object.keys(typed)[0]}`, () => {
      const fx = fixture({ tmuxSh: absentSeatTmux, registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
        seats: { scout: { ...activeSeat, crew: true, preset: { name: "reviewer" }, model: "claude-sonnet-4-5", ...typed } },
      } });
      const next = String(jsonRun(fx).find("seat_unavailable")[0]?.detail.next);
      expect(next).toContain("preserve the stored launch recipe");
      expect(next).not.toContain("tap crew add reviewer");
    });
  }

  test("crew launch context is preserved before any cleanup advice", () => {
    const tmuxSh = absentSeatTmux.replace('case "$1" in', 'case "$*" in *"#{socket_path}"*) exit 1 ;; esac\ncase "$1" in');
    const fx = fixture({ tmuxSh });
    const workdir = join(fx.real, "crew workdir");
    mkdirSync(workdir);
    const registry = join(fx.worktree, ".tap", "team-registry.json");
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    doc.seats = { scout: { ...activeSeat, crew: true, model: "claude-sonnet-4-5", cwd: workdir } };
    writeFileSync(registry, JSON.stringify(doc));
    const command = String(jsonRun(fx).find("seat_unavailable")[0]?.detail.next).split(", then ")[1]!;
    // Test the argument the shell receives, accepting any correct quoting style.
    const parsed = spawnSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { encoding: "utf8" });
    expect(parsed.status).toBe(0);
    const args = parsed.stdout.trim().split("\n");
    expect(args.slice(0, 4)).toEqual(["tap", "crew", "add", "claude"]);
    expect(args[args.indexOf("--cwd") + 1]).toBe(workdir);
    const secret = "fixture-private-crew-value";
    doc.seats.scout.harness_env = { CREW_SETTING: secret };
    doc.seats.scout.permissions = "auto";
    writeFileSync(registry, JSON.stringify(doc));
    const before = stateDigest(fx);
    const json = jsonRun(fx);
    const next = String(json.find("seat_unavailable")[0]?.detail.next);
    expect(next).toContain("tap help crew");
    expect(next).toContain("preserve");
    expect(next).toContain(`less ${realpathSync(registry)}`);
    expect(next).not.toContain("tap team refresh");
    expect(next).not.toContain("tap crew add");
    expect(JSON.stringify(json.report)).not.toContain(secret);
    const human = runDoctor(fx);
    expect(human.out + human.err).not.toContain(secret);
    expect(stateDigest(fx)).toBe(before);
  });

  test("Cursor recovery uses the selected team root outside that checkout", () => {
    const fx = fixture({ tmuxSh: absentSeatTmux, registry: {
      schema: "0.20", team: { name: "u1" },
      seats: { scout: { ...activeSeat, harness: "cursor", harness_session_id: "cursor-chat" } },
    } });
    const outside = join(fx.dir, "outside");
    mkdirSync(outside);
    const cursorHome = join(fx.home, "cursor");
    const store = join(cursorHome, "chats", createHash("md5").update(fx.real).digest("hex"), "cursor-chat");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "store.db"), "");
    const before = stateDigest(fx);
    const json = jsonRun(fx, [], { TAP_HOME: fx.bus, TAP_CURSOR_HOME: cursorHome }, outside);
    expect(json.find("seat_unavailable")[0]?.detail.next).toBe("tap session resume scout");
    expect(stateDigest(fx)).toBe(before);
  });

  for (const suspended of [false, true]) {
    test(`Cursor recovery checks the recorded workdir and environment (${suspended ? "suspended" : "active"})`, () => {
      const fx = fixture({ tmuxSh: absentSeatTmux });
      const chatId = "019a1111-2222-7333-8444-555555555555";
      const workdir = join(fx.real, "nested");
      const cursorHome = join(fx.home, "seat-cursor");
      mkdirSync(workdir);
      const row = { ...activeSeat, harness: "cursor", harness_session_id: chatId,
        launch_workdir: workdir, harness_env: { CURSOR_HOME: cursorHome },
        ...(suspended ? { status: "suspended", status_reason: "pane_gone" } : {}) };
      for (const file of [join(fx.worktree, ".tap", "team-registry.json"), join(fx.bus, "registry.json")]) {
        const doc = JSON.parse(readFileSync(file, "utf8"));
        doc.seats = { scout: row };
        writeFileSync(file, JSON.stringify(doc));
      }
      const env = { TAP_CURSOR_HOME: join(fx.home, "ambient-cursor") };
      const name = suspended ? "suspended_agent" : "seat_unavailable";
      const before = stateDigest(fx);
      const missing = jsonRun(fx, [], env);
      expect(missing.find(name)[0]?.detail.next).toBe("tap session launch cursor scout --fresh");
      expect(runDoctor(fx, [], env).err).not.toContain("tap session resume scout");
      if (suspended) expect(missing.find("retained_resume_failure")[0]?.detail.next).toBe("tap session launch cursor scout --fresh");
      expect(stateDigest(fx)).toBe(before);
      // A store under the seat's launch directory and env restores resume advice.
      const storeDir = join(cursorHome, "chats", createHash("md5").update(workdir).digest("hex"), chatId);
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, "store.db"), "");
      const present = stateDigest(fx);
      expect(jsonRun(fx, [], env).find(name)[0]?.detail.next).toBe("tap session resume scout");
      expect(stateDigest(fx)).toBe(present);
    });
  }

  test("unknown observations and seats recorded on another socket are not declared unavailable", () => {
    for (const [tmuxSh, seat] of [
      [DEAD_TMUX, activeSeat],
      [absentSeatTmux, { ...activeSeat, server_socket: "/other-tmux-server" }],
      [absentSeatTmux, { ...activeSeat, delivery: "poll" }],
      [absentSeatTmux, { ...activeSeat, status_reason: "launching" }],
    ] as const) {
      const fx = fixture({ tmuxSh, registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { scout: seat },
      } });
      expect(jsonRun(fx).find("seat_unavailable")).toEqual([]);
    }
  });

  test("a positively absent pane in a live shared session recommends recovery without writes", () => {
    const tmuxSh = absentSeatTmux.replaceAll("other", "u1/scout").replace("scout:0.0", "scout:1.0");
    const fx = fixture({ tmuxSh, registry: {
      schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { scout: activeSeat },
    } });
    const before = stateDigest(fx);
    const json = jsonRun(fx);
    expect(json.find("seat_unavailable")[0]?.detail).toMatchObject({
      handle: "scout", status: "gone", reason: "pane_absent", next: "tap session resume scout",
    });
    expect(json.find("seat_binding_missing")).toEqual([]);
    expect(stateDigest(fx)).toBe(before);
  });

  test("a missing binding without a pane ID or epoch asks for reconciliation rather than another launch", () => {
    const tmuxSh = absentSeatTmux.replaceAll("other", "u1/scout").replace("scout:0.0", "scout:1.0");
    for (const patch of [{ pane_id: "" }, { server_epoch: "" }]) {
      const fx = fixture({ tmuxSh, registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { scout: { ...activeSeat, ...patch } },
      } });
      const before = stateDigest(fx);
      const json = jsonRun(fx);
      expect(json.find("seat_unavailable")).toEqual([]);
      expect(json.find("seat_binding_missing")[0]?.detail).toMatchObject({
        handle: "scout", status: "unknown", reason: "designated_pane_missing", next: "tap team refresh",
      });
      expect(stateDigest(fx)).toBe(before);
    }
  });

  test("a suspended durable seat recommends resume instead of a new pane, without writes", () => {
    const fx = fixture({ registry: {
      schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
      // tap down strips delivery and pane coordinates but retains this record.
      seats: { stopped: { status: "suspended", status_reason: "session_stopped", session: "u1/stopped", harness: "claude" } },
    } });
    const before = stateDigest(fx);
    const human = runDoctor(fx);
    expect(human.err).toContain("tap session resume stopped");
    expect(human.err).not.toContain("register stopped --pane");
    const json = jsonRun(fx);
    expect(json.find("suspended_agent")[0]?.detail.next).toBe("tap session resume stopped");
    expect(json.report.summary).toMatchObject({ clean: true, seat_attention: 1 });
    expect(stateDigest(fx)).toBe(before);
  });

  test("tap-386g: a withdrawable quarantine with no observed id must not recommend the refusing verb", () => {
    const seat = {
      status: "active",
      harness: "claude",
      identity_capture_result: {
        decision: "quarantined",
        expected_harness_session_id: "exp-1",
        reason: "observed native claude session id aaa did not match launcher expectation exp-1",
      },
    };
    const fx = fixture({
      registry: { schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { q: seat } },
    });
    const human = runDoctor(fx);
    expect(human.err).toContain("identity quarantine");
    expect(human.err).not.toContain("--accept-observed-identity");
    expect(human.err).toContain("waiting on the seat to report an id");
    const json = jsonRun(fx);
    const f = json.find("identity_quarantine_standing")[0];
    expect(f?.detail.observed).toBe("(none reported)");
  });

  test("tap-386g keeps the withdrawal remedy when a real observed id exists", () => {
    const seat = {
      status: "active",
      harness: "claude",
      identity_capture_result: {
        decision: "quarantined",
        expected_harness_session_id: "exp-1",
        observed_harness_session_id: "obs-9",
        reason: "observed native claude session id obs-9 did not match launcher expectation exp-1",
      },
    };
    const fx = fixture({
      registry: { schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { q: seat } },
    });
    const human = runDoctor(fx);
    expect(human.err).toContain("--accept-observed-identity");
  });

  test("unbound seats are attention naming the fix", () => {
    const fx = fixture({
      tmuxSh: UNBOUND_TMUX,
      // The classifier only declares the recovery state when the process
      // table is unobservable — the team-unbound-state corpus shape.
      psSh: "#!/bin/sh\nexit 1\n",
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          scout: {
            status: "suspended", status_reason: "server_restarted", delivery: "pane",
            pane: "", pane_id: "", session: "demo/scout", harness: "codex",
            server_epoch: "srv:900:100", boot_id: "boot:2",
          },
        },
      },
    });
    const human = runDoctor(fx);
    expect(human.err).toContain("seats unbound");
    expect(human.err).toContain("scout");
    const json = jsonRun(fx);
    const f = json.find("seats_unbound")[0];
    expect(f?.severity).toBe("warning");
    expect((f?.detail.handles as string[])).toContain("scout");
  });

  test("--fix pruning preserves unknown numeric lexemes in the global index", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const fx = fixture({
      // Author the marker bytes literally: JSON.stringify would lose the very
      // lexemes under control before doctor even runs.
      index: JSON.parse(`{"schema":"0.20","weight":1.0,"neg":-0.0,"sci":1e2,"big":12345678901234567890,"teams":{"u1":{"root":"REALROOT","registry_location":"REALROOT/.tap/team-registry.json"}}}`),
    });
    writeFileSync(join(fx.index, "global-registry.json"), `{"schema":"0.20","weight":1.0,"neg":-0.0,"sci":1e2,"big":12345678901234567890,"teams":{"u1":{"root":${JSON.stringify(fx.real)},"registry_location":${JSON.stringify(join(fx.real, ".tap", "team-registry.json"))}},"gone":{"root":${JSON.stringify(missing)},"registry_location":${JSON.stringify(join(missing, ".tap", "team-registry.json"))}}}}\n`);
    const fixed = runDoctor(fx, ["--fix"]);
    expect(fixed.rc, fixed.err + fixed.out).toBe(0);
    const after = readFileSync(join(fx.index, "global-registry.json"), "utf8");
    // Python json round-trip parity: floats keep their repr, wide integers
    // keep their digits, and only the dangling row disappears.
    expect(after).toContain("1.0");
    expect(after).toContain("-0.0");
    expect(after).toContain("100.0");
    expect(after).toContain("12345678901234567890");
    expect(after).not.toContain("gone");
    const parsed = JSON.parse(after) as { teams: Record<string, unknown> };
    expect(parsed.teams.u1).toBeDefined();
  });

  test("dangling index rows warn, and --fix prunes them", () => {
    const missing = join(fx0dir(), "gone-team");
    const dangling = {
      schema: "0.20",
      teams: {
        u1: { root: "REALROOT", registry_location: join("REALROOT", ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
      },
    };
    const fx = fixture({ index: dangling });
    // Rewrite with the now-known real root: the fixture root must exist for
    // u1, while `gone` stays dangling.
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: {
        u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") },
        gone: dangling.teams.gone,
      },
    })}\n`);
    const human = runDoctor(fx);
    expect(human.err).toContain("dangling team index rows");
    expect(jsonRun(fx).find("dangling_index_teams")[0]?.severity).toBe("warning");
    // --fix prunes the dangling row; the composed team refresh exits 0.
    const fixed = runDoctor(fx, ["--fix"]);
    expect(fixed.rc, fixed.err).toBe(0);
    const after = JSON.parse(readFileSync(join(fx.index, "global-registry.json"), "utf8")) as {
      teams: Record<string, unknown>;
    };
    expect(after.teams.gone).toBeUndefined();
    expect(after.teams.u1).toBeDefined();
  });

  test("--fix pruning leaves an index snapshot with its sha and prints the restore line (tap-k140)", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const fx = fixture({ index: {
      schema: "0.20",
      teams: {
        u1: { root: "REALROOT", registry_location: join("REALROOT", ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
        gone2: { root: join(missing, "two"), registry_location: join(missing, "two", ".tap", "team-registry.json") },
      },
    } });
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: {
        u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
        gone2: { root: join(missing, "two"), registry_location: join(missing, "two", ".tap", "team-registry.json") },
      },
    })}\n`);
    const before = readFileSync(join(fx.index, "global-registry.json"));
    const fixed = runDoctor(fx, ["--fix"]);
    expect(fixed.rc, fixed.err).toBe(0);
    // The snapshot sits beside the index, holds the exact pre-prune bytes,
    // and its sidecar names its sha256. Two dangling rows, one snapshot:
    // the once-per-run guard must keep the restore point at the pre-prune
    // state, never a half-pruned intermediate.
    const recovery = join(fx.index, "recovery");
    const snaps = readdirSync(recovery).filter((name) => /^index-doctor-fix\.[0-9a-f]{12}\.json$/.test(name));
    expect(snaps).toHaveLength(1);
    const snapPath = join(recovery, snaps[0]!);
    expect(readFileSync(snapPath).equals(before)).toBe(true);
    const sidecar = readFileSync(`${snapPath}.sha256`, "utf8");
    expect(sidecar).toBe(`${createHash("sha256").update(readFileSync(snapPath)).digest("hex")}\n`);
    // The restore line names the snapshot, the digest and the restore
    // command (shellQuote leaves these fixture paths unquoted).
    expect(fixed.err).toContain(`index snapshot '${snapPath}'`);
    expect(fixed.err).toContain(`restore: cp ${snapPath} ${join(fx.index, "global-registry.json")}`);
    // The prune still happened, for every dangling row.
    const after = JSON.parse(readFileSync(join(fx.index, "global-registry.json"), "utf8")) as {
      teams: Record<string, unknown>;
    };
    expect(after.teams.gone).toBeUndefined();
    expect(after.teams.gone2).toBeUndefined();
    expect(after.teams.u1).toBeDefined();
  });

  test("a snapshot-write failure prunes nothing and says so", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const fx = fixture({ index: {
      schema: "0.20",
      teams: {
        u1: { root: "REALROOT", registry_location: join("REALROOT", ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
      },
    } });
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: {
        u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
      },
    })}\n`);
    // recovery/ as a regular file makes the snapshot's mkdirSync throw.
    writeFileSync(join(fx.index, "recovery"), "not a directory");
    const before = readFileSync(join(fx.index, "global-registry.json"));
    const fixed = runDoctor(fx, ["--fix"]);
    // The refusal only covers pruning: refresh still runs (its stdout names
    // it) and exits 0.
    expect(fixed.rc, fixed.err + fixed.out).toBe(0);
    expect(fixed.out).toContain("tap team refresh: ");
    expect(fixed.err).toContain("could not write an index snapshot");
    expect(fixed.err).toContain("no rows were pruned");
    expect(fixed.out).not.toContain("pruned dangling team index row");
    // Nothing was pruned, judged on the index bytes, not on stdout.
    expect(readFileSync(join(fx.index, "global-registry.json")).equals(before)).toBe(true);
    expect(readFileSync(join(fx.index, "recovery"), "utf8")).toBe("not a directory");
  });

  test("no prune, no snapshot: bare doctor and a --fix with nothing dangling write no recovery/", () => {
    const fx = fixture();
    let run = runDoctor(fx);
    expect(run.err).not.toContain("index snapshot");
    expect(existsSync(join(fx.index, "recovery"))).toBe(false);
    run = runDoctor(fx, ["--fix"]);
    expect(run.rc, run.err).toBe(0);
    expect(run.err).not.toContain("index snapshot");
    expect(run.out).not.toContain("pruned dangling team index row");
    expect(existsSync(join(fx.index, "recovery"))).toBe(false);
  });

  test("--fix pruning never removes malformed or empty root rows", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const fx = fixture();
    // Author the index after the fixture exists so u1's root is the real
    // fixture root; the malformed roots stay exactly the JSON types under
    // test: boolean, number, object, null, and the empty string.
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: {
        u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") },
        gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") },
        mfalse: { root: false, registry_location: "x" },
        mzero: { root: 0, registry_location: "x" },
        mobj: { root: {}, registry_location: "x" },
        mnull: { root: null, registry_location: "x" },
        mempty: { root: "", registry_location: "x" },
      },
    })}\n`);
    const fixed = runDoctor(fx, ["--fix"]);
    expect(fixed.rc, fixed.err + fixed.out).toBe(0);
    const after = JSON.parse(readFileSync(join(fx.index, "global-registry.json"), "utf8")) as {
      teams: Record<string, { root: unknown } | undefined>;
    };
    // The valid missing string root is pruned; the live row remains.
    expect(after.teams.gone).toBeUndefined();
    expect(after.teams.u1).toBeDefined();
    // Malformed/empty roots never enter the prune set: every row survives
    // with its original JSON type and value.
    expect(after.teams.mfalse?.root).toBe(false);
    expect(after.teams.mzero?.root).toBe(0);
    expect(after.teams.mobj?.root).toEqual({});
    expect(after.teams.mnull?.root).toBe(null);
    expect(after.teams.mempty?.root).toBe("");
  });

  test("sanitizer grammar covers suffix-bearing assignment names", () => {
    const fx = fixture({
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          scout: {
            status: "suspended", status_reason: "session_replaced", delivery: "pane",
            session: "demo/scout", harness: "codex",
            transcript_path: "/x api_token_value=supersecret9 password_hash=hunter3",
            server_epoch: "srv:900:100", boot_id: "boot:2",
          },
        },
      },
    });
    // The retired grammar redacts the VALUE after any name containing a
    // secret keyword — suffixes like `_value`/`_hash` do not hide it.
    const f = jsonRun(fx).find("retained_resume_failure")[0];
    const state = JSON.stringify(f?.detail.state);
    expect(state).not.toContain("supersecret9");
    expect(state).not.toContain("hunter3");
  });

  test("F1: a parseable invalid marker is never pruned, even with a dangling team", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const invalidDoc = {
      schema: "0.19",
      teams: { gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") } },
    };
    const fx = fixture({ index: invalidDoc });
    const markerPath = join(fx.index, "global-registry.json");
    const before = readFileSync(markerPath, "utf8");
    const fixed = runDoctor(fx, ["--fix"]);
    // The marker bytes stay exactly as written: pruning must never repair an
    // invalid marker in place.
    expect(readFileSync(markerPath, "utf8")).toBe(before);
    // The composed refresh fails closed on the invalid marker.
    expect(fixed.rc, fixed.err + fixed.out).not.toBe(0);
  });

  test("an invalid marker suppresses the dangling census and its --fix advice", () => {
    const missing = join(tmpdir(), "tap-doctor-no-such-team-dir");
    const fx = fixture({
      index: { schema: "0.19", teams: { gone: { root: missing, registry_location: join(missing, ".tap", "team-registry.json") } } },
    });
    const human = runDoctor(fx);
    // Only the authority failure reports; no team rows are read and no
    // `tap doctor --fix` remedy is recommended against an invalid marker.
    expect(human.err).not.toContain("dangling team index rows");
    expect(jsonRun(fx).find("dangling_index_teams").length).toBe(0);
    expect(human.out).toContain("invalid_flip");
  });

  test("input backups are inventoried read-only; --prune-input-backups removes them", () => {
    const fx = fixture();
    const backup = join(fx.bus, "input-backups", "b1.md");
    writeFileSync(backup, ENVELOPE({ created_at: "2026-09-18T10:00:00Z", handle: "a", payload_id: "p1", input_hash: "h1" }));
    const before = stateDigest(fx);
    const json = jsonRun(fx);
    expect(json.find("input_backup").length).toBe(1);
    expect(existsSync(backup)).toBe(true);
    expect(stateDigest(fx)).toBe(before);
    const pruned = jsonRun(fx, ["--prune-input-backups"]);
    expect(pruned.find("input_backup_pruned").length).toBe(1);
    expect(existsSync(backup)).toBe(false);
  });

  test("leading-dot/underscore exclusions apply only to payloads; backups and logs include them", () => {
    const fx = fixture();
    // The retired globs inventoried _draft.md/_prompt.md in the sidecar scans
    // but Python glob("*.md") still excludes dotfiles everywhere.
    writeFileSync(join(fx.bus, "input-backups", "_draft.md"), ENVELOPE({ created_at: "c", handle: "h", payload_id: "p", input_hash: "i" }));
    writeFileSync(join(fx.bus, "input-backups", ".hidden.md"), ENVELOPE({ created_at: "c2", handle: "h2", payload_id: "p2", input_hash: "i2" }));
    writeFileSync(join(fx.bus, "watch", "evaluator-prompts", "_prompt.md"), "prompt body\n");
    // Payload enumeration keeps the exclusions.
    payload(fx.bus, "_skip.md", ENVELOPE({ id: "other", from: "a", to: "b", kind: "note", path: "p" }));
    const json = jsonRun(fx);
    // The rendered bus home is realpath-normalized (macOS /var → /private/var).
    const realBus = realpathSync(fx.bus);
    const backupPaths = json.find("input_backup").map((f) => f.detail.path);
    expect(backupPaths).toContain(join(realBus, "input-backups", "_draft.md"));
    expect(backupPaths).not.toContain(join(realBus, "input-backups", ".hidden.md"));
    expect(json.find("watch_log").map((f) => f.detail.path)).toContain(join(realBus, "watch", "evaluator-prompts", "_prompt.md"));
    expect(json.find("torn_payload").length).toBe(0);
    // Prune follows the same boundary: the underscore sidecar goes, the
    // dotfile stays untouched on disk.
    const pruned = jsonRun(fx, ["--prune-input-backups"]);
    expect(pruned.find("input_backup_pruned").map((f) => String(f.detail.path).endsWith("/_draft.md"))).toContain(true);
    expect(pruned.find("input_backup_pruned").map((f) => String(f.detail.path).endsWith("/.hidden.md"))).not.toContain(true);
    expect(existsSync(join(fx.bus, "input-backups", "_draft.md"))).toBe(false);
    expect(existsSync(join(fx.bus, "input-backups", ".hidden.md"))).toBe(true);
  });

  test("watch logs are inventoried read-only; --prune-watch-logs removes them", () => {
    const fx = fixture();
    const log = join(fx.bus, "watch", "evaluator-prompts", "w1.md");
    writeFileSync(log, "prompt body\n");
    const before = stateDigest(fx);
    const json = jsonRun(fx);
    expect(json.find("watch_log").length).toBe(1);
    expect(typeof json.find("watch_log")[0]?.detail.mtime).toBe("number");
    expect(existsSync(log)).toBe(true);
    expect(stateDigest(fx)).toBe(before);
    const pruned = jsonRun(fx, ["--prune-watch-logs"]);
    expect(pruned.find("watch_log_pruned").length).toBe(1);
    expect(existsSync(log)).toBe(false);
  });

  test("spool: orphan meta warns, a stuck entry is attention, a backlog is named", () => {
    const fx = fixture();
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(fx.bus, "spool", "orph-001.meta.json"), "{not json");
    // A parseable meta whose payload never landed: the true orphan shape.
    writeFileSync(join(fx.bus, "spool", "orph-002.meta.json"), `${JSON.stringify({
      id: "orph-002", target: "peggy", reason: "blocked", reason_class: "busy", attempts: 1,
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "stuck-001.meta.json"), `${JSON.stringify({
      id: "stuck-001", target: "peggy", reason: "blocked", reason_class: "busy",
      attempts: 4, first_spooled_epoch: now - 4000, escalated_at: now - 3000,
      busy_pending_probes: 5,
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "stuck-002.meta.json"), `${JSON.stringify({
      id: "stuck-002", target: "peggy", reason: "blocked", reason_class: "busy",
      attempts: 4, first_spooled_epoch: now - 3900, busy_pending_probes: 5,
    })}\n`);
    // A spool entry is live only while its payload sits beside the meta;
    // payload-less metas classify orphan instead of stuck.
    writeFileSync(join(fx.bus, "spool", "stuck-001.md"), "payload\n");
    writeFileSync(join(fx.bus, "spool", "stuck-002.md"), "payload\n");
    writeFileSync(join(fx.bus, "spool", "fresh-001.meta.json"), `${JSON.stringify({
      id: "fresh-001", target: "peggy", attempts: 1, first_spooled_epoch: now - 10,
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "fresh-001.md"), "payload\n");
    const human = runDoctor(fx);
    expect(human.err).toContain("malformed spool meta");
    expect(human.err).toContain("orphan spool meta (no payload)");
    expect(human.err).toContain("stuck spool");
    expect(human.err).toContain("persistent spool backlog");
    expect(human.out).toContain("reason: unknown");
    expect(human.out).not.toMatch(/age: \d+ss/);
    const json = jsonRun(fx);
    expect(json.find("spool_orphan_meta").length).toBe(2);
    expect(json.find("stuck_spool").length).toBe(2);
    expect(json.find("stuck_spool")[0]?.detail.blocker).toContain("needs a human");
    expect(json.find("persistent_spool_backlog").length).toBe(1);
    expect(json.find("persistent_spool_backlog")[0]?.detail.blocker).toBeDefined();
  });

  test("TAP_SPOOL_BACKLOG_COUNT lowers the bar: one old probe-heavy entry becomes a backlog", () => {
    const fx = fixture();
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(fx.bus, "spool", "back-001.meta.json"), `${JSON.stringify({
      id: "back-001", target: "peggy", reason: "blocked", reason_class: "busy",
      attempts: 1, first_spooled_epoch: now - 4000, busy_pending_probes: 5,
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "back-001.md"), "payload\n");
    // Defaults (count 2, probes 3) suppress a single-row backlog.
    const baseline = jsonRun(fx);
    expect(baseline.find("persistent_spool_backlog").length).toBe(0);
    // The shared environment-backed thresholds must reach the doctor scan.
    const overridden = jsonRun(fx, [], { TAP_SPOOL_BACKLOG_COUNT: "1" });
    expect(overridden.find("persistent_spool_backlog").length).toBe(1);
  });

  test("an invalid configured backlog threshold exits 1 naming the error", () => {
    const fx = fixture();
    const run = runDoctor(fx, [], { TAP_SPOOL_BACKLOG_COUNT: "0" });
    expect(run.rc).toBe(1);
    expect(run.err).toContain("invalid backlog thresholds");
  });

  test("an unreadable spool directory is a nonzero refusal, not a silent skip", () => {
    // Only ENOENT is an empty spool: a non-directory at the spool path must
    // fail the run naming the path.
    const fx = fixture({ bus: false });
    const scratchBus = join(fx.worktree, "scratch-bus");
    mkdirSync(scratchBus, { recursive: true });
    writeFileSync(join(scratchBus, "spool"), "not a directory\n");
    const run = runDoctor(fx, [], { TAP_HOME: scratchBus });
    expect(run.rc).toBe(1);
    expect(run.err).toContain("spool directory unreadable");
  });

  test("an invalid backlog threshold fails even when the spool directory is absent", () => {
    // Validation must precede the best-effort readdir early return: bad
    // configuration cannot hide behind a missing spool/.
    const fx = fixture({ bus: false });
    const scratchBus = join(fx.worktree, "scratch-bus");
    mkdirSync(scratchBus, { recursive: true });
    const run = runDoctor(fx, [], { TAP_HOME: scratchBus, TAP_SPOOL_BACKLOG_COUNT: "0" });
    expect(run.rc).toBe(1);
    expect(run.err).toContain("invalid backlog thresholds");
  });

  test("historical lane manifests do not create custody warnings or change records", () => {
    const fx = fixture();
    const unrelatedTree = join(fx.worktree, ".tap", ".trees", "unrecorded");
    mkdirSync(unrelatedTree, { recursive: true });
    const manifest = join(fx.bus, "lanes.json");
    const bytes = JSON.stringify({ drivers: { retired: { worktree: "missing-old-tree" } } }) + "\n";
    writeFileSync(manifest, bytes);
    const result = jsonRun(fx);
    expect(result.rc, result.err).toBe(0);
    expect(result.report.findings.filter((f) => f.name.startsWith("lane"))).toEqual([]);
    expect(readFileSync(manifest, "utf8")).toBe(bytes);
    expect(existsSync(unrelatedTree)).toBe(true);
  });

  test("a release artifact root reports its release, not a CANNOT-CHECK checkout (tap-7r3fn.192)", () => {
    const fx = fixture();
    const scratchBus = join(fx.dir, "scratch-bus");
    mkdirSync(scratchBus, { recursive: true });
    const artifact = mkdtempSync(join(tmpdir(), "tap-doctor-release."));
    scratch.push(artifact);
    // Control: the same non-git root without a marker is the CANNOT-CHECK it was.
    const plain = runDoctor(fx, [], { TAP_HOME: scratchBus }, artifact);
    expect(plain.err).toContain("is not a git checkout");
    writeFileSync(join(artifact, "tap-release.json"), JSON.stringify({ schema: 1, version: "0.23-20261002-abcdefabcdef", commit: "abcdefabcdef0123456789abcdefabcdef012345", platform: "darwin-arm64", bun: "1.4.0" }));
    const run = runDoctor(fx, ["--json"], { TAP_HOME: scratchBus }, artifact);
    expect(run.rc, run.err).toBe(0);
    const findings = JSON.parse(run.out).findings as { name: string; severity: string; detail: Record<string, unknown> }[];
    expect(findings.find(f => f.name === "checkout_freshness")).toBeUndefined();
    const release = findings.find(f => f.name === "release");
    expect(release?.severity).toBe("info");
    expect(release?.detail).toEqual({ version: "0.23-20261002-abcdefabcdef", commit: "abcdefabcdef0123456789abcdefabcdef012345", platform: "darwin-arm64", bun: "1.4.0" });
    const human = runDoctor(fx, [], { TAP_HOME: scratchBus }, artifact);
    expect(human.out).toContain(`tap doctor: release 0.23-20261002-abcdefabcdef (source abcdefabcdef, darwin-arm64, bun 1.4.0) at ${artifact}`);
    expect(human.err).not.toContain("is not a git checkout");
  });

  test("checkout freshness uses the TAP_CHECKOUT_ROOT hook: stale is a warning", () => {
    const staleRepo = mkdtempSync(join(tmpdir(), "tap-doctor-stale."));
    scratch.push(staleRepo);
    spawnSync("git", ["init", "-q", staleRepo]);
    // Self-contained fixture: a local identity, and every setup step verified —
    // the freshness assertion must rest on a repo that provably built.
    const git = (args: string[]) => {
      const setup = spawnSync("git", ["-C", staleRepo, ...args], { encoding: "utf8" });
      expect(setup.status, args.join(" ") + ": " + setup.stderr).toBe(0);
    };
    git(["config", "user.name", "tap-doctor-fixture"]);
    git(["config", "user.email", "tap-doctor-fixture@example.invalid"]);
    git(["checkout", "-q", "-b", "main"]);
    writeFileSync(join(staleRepo, "f.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    git(["commit", "-q", "--allow-empty", "-m", "origin moves ahead"]);
    git(["branch", "origin/main"]);
    git(["reset", "-q", "--hard", "HEAD~1"]);
    const fx = fixture();
    // Ground the bus explicitly with a NONCANONICAL scratch home: an explicit
    // canonical .tap/bus fails closed when the index omits the cwd root
    // (F2), and this stale repo is deliberately not enrolled anywhere.
    const scratchBus = join(fx.dir, "scratch-bus");
    mkdirSync(scratchBus, { recursive: true });
    const run = runDoctor(fx, [], { TAP_HOME: scratchBus }, staleRepo);
    expect(run.err).toContain("checkout STALE");
    expect(run.err).toContain("--sync");
    expect(run.rc).toBe(0);
  });

  test("invalid flip marker is an authority error exiting 1", () => {
    const fx = fixture();
    writeFileSync(join(fx.index, "global-registry.json"), "{not an index");
    const human = runDoctor(fx);
    expect(human.rc).toBe(1);
    expect(human.err).toContain("invalid_flip");
    // Incumbent human order: the authority prelude renders on stdout, after
    // the bus header and before the installation line — not before the header
    // on stderr.
    const out = human.out;
    const preludeAt = out.indexOf("global-registry.json is present but unreadable or wrong schema (invalid_flip)");
    expect(preludeAt).toBeGreaterThanOrEqual(0);
    expect(preludeAt).toBeGreaterThan(out.indexOf("tap doctor: bus="));
    expect(preludeAt).toBeLessThan(out.indexOf("installed TAP:"));
    const json = jsonRun(fx);
    expect(json.rc).toBe(1);
    expect(json.find("invalid_flip")[0]?.severity).toBe("error");
    expect(json.err).toBe("");
  });

  test("pre-v0.20 old-store prelude renders on stdout after the bus header", () => {
    const fx = fixture();
    rmSync(join(fx.index, "global-registry.json"));
    writeFileSync(join(fx.index, "teams.json"), `${JSON.stringify({ u1: { root: fx.real } })}\n`);
    const human = runDoctor(fx);
    expect(human.rc).toBe(0);
    const out = human.out;
    const preludeAt = out.indexOf(`tap doctor: ${join(fx.index, "teams.json")} is an old TAP registry format (pre-v0.20 teams.json machine index)`);
    expect(out).toContain("; next: move this file aside, then run tap init in each team root to enroll it");
    expect(out).not.toContain("migrate-registry");
    expect(preludeAt).toBeGreaterThanOrEqual(0);
    expect(preludeAt).toBeGreaterThan(out.indexOf("tap doctor: bus="));
    expect(preludeAt).toBeLessThan(out.indexOf("installed TAP:"));
  });

  test("acting registry unreachable under a live marker is a finding naming tap init", () => {
    const fx = fixture({
      index: {
        schema: "0.20",
        teams: { u1: { root: fx0dir(), registry_location: join(fx0dir(), ".tap", "team-registry.json") } },
      },
    });
    // The unreachable door needs an ENROLLED-looking root whose registry file
    // is gone: rewrite the index to the real root, then remove the registry.
    writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
      schema: "0.20",
      teams: { u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") } },
    })}\n`);
    rmSync(join(fx.worktree, ".tap", "team-registry.json"));
    const human = runDoctor(fx);
    expect(human.err).toContain("acting_registry_unreachable");
    const json = jsonRun(fx);
    const f = json.find("acting_registry_unreachable")[0];
    expect(f?.detail?.action).toBe("tap init");
    // acting_registry_unreachable is an authority error: the incumbent JSON
    // contract exits 1 for it (exit 1 iff torn or authority_error).
    expect(json.rc).toBe(1);
    expect(json.report.ok).toBe(false);
  });

  test("usage errors: unknown option and positional refuse with exit 1", () => {
    const fx = fixture();
    const bad = runDoctor(fx, ["--bogus"]);
    expect(bad.rc).toBe(1);
    expect(bad.err).toContain("unknown option");
    expect(bad.err).toContain("tap help doctor");
    const extra = runDoctor(fx, ["extra"]);
    expect(extra.rc).toBe(1);
    expect(extra.err).toContain("unexpected arg");
    const conflict = runDoctor(fx, ["--fix", "--prune-input-backups"]);
    expect(conflict.rc).toBe(1);
    expect(conflict.err).toContain("separately");
    // --bogus throws AFTER --json was parsed, so the json-intended run emits
    // the structured error object on stdout with zero stderr.
    const badJson = runDoctor(fx, ["--json", "--bogus"]);
    expect(badJson.rc).toBe(1);
    expect(badJson.err).toBe("");
    expect(badJson.out).toContain('"error_class":"unknown_option"');
  });

  test("codex seat with no node on its recorded PATH warns", () => {
    const fx = fixture({
      tmuxSh: CODEX_TMUX,
      // ps eww answers for the pane pid with a PATH that has no node.
      psSh: `#!/bin/sh
[ "$1" = eww ] && { printf '  999 PATH=/no-node-seat-path\\n'; exit 0; }
exit 1
`,
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          cx: { status: "active", harness: "codex", pane: "cx:0.0", pane_id: "%1", session: "cx" },
        },
      },
    });
    const json = jsonRun(fx);
    const f = json.find("codex_seat_node_unresolvable")[0];
    expect(f?.severity).toBe("warning");
    expect(String(f?.detail?.handle ?? "")).toBe("cx");
    expect(json.find("codex_seat_pane_name_drift").length).toBe(0);
  });

  test("codex pane drift: a name-derived pane id mismatch warns (three-column parse)", () => {
    const fx = fixture({
      tmuxSh: CODEX_TMUX,
      psSh: "#!/bin/sh\nexit 1\n",
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          cx: { status: "active", harness: "codex", pane: "cx:0.0", pane_id: "%9", session: "cx" },
        },
      },
    });
    const json = jsonRun(fx);
    const f = json.find("codex_seat_pane_name_drift")[0];
    expect(f?.severity).toBe("warning");
    expect(f?.detail.handle).toBe("cx");
    expect(f?.detail.stored_pane_id).toBe("%9");
    // The fake answers list-panes with pane id %1 in the third column; a
    // two-column parser would have compared the wrong pair and missed this.
    expect(f?.detail.name_pane_id).toBe("%1");
  });

  test("a failing list-sessions census does not suppress the stored-pane-id PATH probe", () => {
    // list-sessions refuses (drift census unavailable), but display-message
    // still answers for the stored pane id and ps eww reports a PATH with no
    // node — the incumbent still emitted the PATH finding here.
    const tmuxSh = `#!/bin/sh
case "$1" in
  list-sessions) exit 1 ;;
  display-message) for a in "$@"; do [ "$a" = "%1" ] && { printf '999\\n'; exit 0; }; done; exit 1 ;;
  *) exit 1 ;;
esac
`;
    const fx = fixture({
      tmuxSh,
      psSh: `#!/bin/sh
[ "$1" = eww ] && { printf '  999 PATH=/no-node-seat-path\\n'; exit 0; }
exit 1
`,
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          cx: { status: "active", harness: "codex", pane: "cx:0.0", pane_id: "%1", session: "cx" },
        },
      },
    });
    const json = jsonRun(fx);
    const f = json.find("codex_seat_node_unresolvable")[0];
    expect(f?.severity).toBe("warning");
    expect(String(f?.detail?.handle ?? "")).toBe("cx");
    expect(json.find("codex_seat_pane_name_drift").length).toBe(0);
  });

  test("retained resume failure: positive finding and poll-mode negative", () => {
    const seat = {
      status: "suspended", status_reason: "session_replaced", delivery: "pane",
      session: "demo/scout", harness: "codex",
      server_epoch: "srv:900:100", boot_id: "boot:2",
    };
    const fx = fixture({
      registry: { schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" }, seats: { scout: seat } },
    });
    const json = jsonRun(fx);
    const f = json.find("retained_resume_failure")[0];
    expect(f?.severity).toBe("info");
    // The JSON contract serializes {severity, name, detail} only; the
    // finding-level `next` renders in the human line.
    const human = runDoctor(fx);
    expect(human.out).toContain(
      "retains its conversation after suspended/session_replaced; next: tap session resume scout",
    );
    // next is finding-level for human output AND now inside detail for JSON,
    // matching the retired renderer.
    expect(f?.detail.next).toBe("tap session resume scout");
    expect((f?.detail.trace as string)).toContain(join("logs", "startup.jsonl"));
    expect((f?.detail.state as Record<string, unknown>).session).toBe("demo/scout");

    const polled = fixture({
      registry: {
        schema: "0.20", team: { name: "u1", worktree_root: "REALROOT" },
        seats: { scout: { ...seat, delivery: "poll" } },
      },
    });
    expect(jsonRun(polled).find("retained_resume_failure").length).toBe(0);
  });

  test("F3: retained state is sanitized before JSON — secrets redacted, strings bounded", () => {
    // A secret-named environment entry whose VALUE appears bare inside a
    // retained string (not as name=value) — the incumbent redacted these.
    const credential = "bare-credential-value-9";
    const fx = fixture({
      registry: {
        schema: "0.20",
        team: { name: "u1", worktree_root: "REALROOT" },
        seats: {
          scout: {
            status: "suspended", status_reason: "session_replaced", delivery: "pane",
            session: "demo/scout", harness: "codex",
            transcript_path: `/tmp/${credential}/trace.jsonl api_token=supersecretvalue password=hunter2`,
            registered_from_worktree: "w".repeat(700),
            instance: { nested_api_key: "nested-secret-77", note: "keep me" },
            server_epoch: "srv:900:100", boot_id: "boot:2",
          },
        },
      },
    });
    const f = jsonRun(fx, [], { TAP_FIXTURE_CREDENTIAL: credential }).find("retained_resume_failure")[0];
    expect(f).toBeDefined();
    const state = JSON.stringify(f?.detail.state);
    // startup_trace.py clean() parity: env secret values (bare or inline),
    // nested secret-named keys, inline assignments — none may serialize.
    expect(state).not.toContain(credential);
    expect(state).not.toContain("supersecretvalue");
    expect(state).not.toContain("hunter2");
    expect(state).not.toContain("nested-secret-77");
    expect(state).toContain("keep me");
    const stateObj = (f?.detail.state ?? {}) as Record<string, unknown>;
    expect((stateObj.instance as Record<string, unknown>).nested_api_key).toBe("<redacted>");
    expect(String(stateObj.registered_from_worktree ?? "").length).toBeLessThanOrEqual(600);
  });

  test("a legacy row with a standing quarantine is one old_store finding, never read row by row", () => {
    const fx = fixture({
      registry: {
        version: 3,
        agents: {
          ghost: {
            harness: "claude",
            identity_capture_result: {
              decision: "quarantined",
              expected_harness_session_id: "exp-1",
              reason: "observed native claude session id aaa did not match launcher expectation exp-1",
            },
          },
        },
      },
    });
    const json = jsonRun(fx);
    expect(json.find("old_store").length).toBe(1);
    expect(json.find("registry_legacy_entry").length).toBe(0);
    expect(json.find("identity_quarantine_standing").length).toBe(0);
  });

  test("stuck spool: numeric-string epoch/timeout at exact threshold, false escalation", () => {
    const fx = fixture();
    const now = Math.floor(Date.now() / 1000);
    // Numeric strings must survive the Python-int boundary. The interval is
    // the deterministic pin: age ~600 with a STRING timeout of 500s proves
    // the string parsed (rejected -> default 1800 -> not stuck), and a string
    // epoch proves the same for first_spooled_epoch (rejected -> age null ->
    // never stuck). escalated_at false stays unescalated.
    writeFileSync(join(fx.bus, "spool", "stuck-101.meta.json"), `${JSON.stringify({
      id: "stuck-101", target: "peggy", reason: "blocked", reason_class: "busy",
      attempts: "2", first_spooled_epoch: String(now - 600), timeout_seconds: "500",
      escalated_at: false,
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "stuck-101.md"), "payload\n");
    // Same threshold, far under it: only the info-shape spool finding.
    writeFileSync(join(fx.bus, "spool", "fresh-101.meta.json"), `${JSON.stringify({
      id: "fresh-101", target: "peggy", attempts: 1,
      first_spooled_epoch: now - 10, timeout_seconds: "3600",
    })}\n`);
    writeFileSync(join(fx.bus, "spool", "fresh-101.md"), "payload\n");
    const human = runDoctor(fx);
    // stuck_spool is attention:true — attention renders on stderr; the human
    // line renders age with exactly one trailing `s`.
    expect(human.err).toContain("stuck spool");
    expect(human.err).toMatch(/age: 60\ds/);
    expect(human.err).toContain("escalated: no");
    expect(human.out).not.toMatch(/age: \d+ss/);
    const json = jsonRun(fx);
    const stuck = json.find("stuck_spool")[0];
    expect(Number(stuck?.detail.age)).toBeGreaterThanOrEqual(590);
    expect(Number(stuck?.detail.age)).toBeLessThan(620);
    expect(stuck?.detail.escalated).toBe(false);
    expect(stuck?.detail.attempts).toBe(2);
    expect(json.find("spool").length).toBe(1);
  });

  test("spool int fields accept exactly the spellings Python int() accepts (tap-rcnza)", () => {
    const fx = fixture();
    const now = Math.floor(Date.now() / 1000);
    // Ground truth is CPython `int()`: surrounding whitespace, one sign,
    // Unicode decimal digits, single underscores between digits, bool as 0/1.
    // The BOM and the C0 separators 1C-1F are NOT whitespace to int().
    // Threshold probe: age is ~600s. An accepted spelling of 500 makes the
    // spool stuck; a rejected one falls back to the 1800s default and does not.
    const accepted: unknown[] = [
      "500", "+500", " 500\n", "\u00a0500\u3000", "5_00", "+5_0_0", "٥٠٠", "５００", "٥_٠٠", 500.9, true,
    ];
    const rejected: unknown[] = [
      "500.5", "0x1f4", "5__00", "_500", "500_", "5 00", "\u001c500", "500\u001f", "\ufeff500", "", "+-500", "1e3",
    ];
    const cases = [...accepted.map((v) => [v, true] as const), ...rejected.map((v) => [v, false] as const)];
    cases.forEach(([timeout, stuck], i) => {
      const id = `t-${String(i).padStart(3, "0")}`;
      writeFileSync(join(fx.bus, "spool", `${id}.meta.json`), `${JSON.stringify({
        id, target: "peggy", first_spooled_epoch: now - 600, timeout_seconds: timeout,
      })}\n`);
      writeFileSync(join(fx.bus, "spool", `${id}.md`), "payload\n");
    });
    // Epoch probe: an accepted spelling yields a numeric age; a rejected one
    // yields age null (never stuck), mirroring the timeout rule above.
    const epochCase = (spelled: string, parsed: boolean, id: string) => {
      writeFileSync(join(fx.bus, "spool", `${id}.meta.json`), `${JSON.stringify({
        id, target: "peggy", first_spooled_epoch: spelled, timeout_seconds: 500,
      })}\n`);
      writeFileSync(join(fx.bus, "spool", `${id}.md`), "payload\n");
      return [id, parsed] as const;
    };
    const epochs = [
      epochCase(`+${now - 600}`, true, "e-plus"),
      epochCase(`${now - 600}`.replace(/(\d)(\d{3})$/, "$1_$2"), true, "e-sep"),
      epochCase(`\t${now - 600}\r`, true, "e-space"),
      epochCase(`${now - 600}`.replace(/\d/g, (d) => String.fromCodePoint(0x0660 + Number(d))), true, "e-arabic"),
      epochCase(`${now - 600}.0`, false, "e-float"),
      epochCase(`\ufeff${now - 600}`, false, "e-bom"),
      epochCase(`${now - 600}_`, false, "e-trail"),
    ];
    const json = jsonRun(fx);
    const stuckIds = new Set(json.find("stuck_spool").map((f) => f.detail.id));
    const infoAge = new Map(json.find("spool").map((f) => [f.detail.id, f.detail.age]));
    cases.forEach(([timeout, stuck], i) => {
      const id = `t-${String(i).padStart(3, "0")}`;
      expect(stuckIds.has(id), `timeout_seconds ${JSON.stringify(timeout)}`).toBe(stuck);
    });
    for (const [id, parsed] of epochs) {
      if (parsed) {
        expect(stuckIds.has(id), id).toBe(true);
      } else {
        expect(stuckIds.has(id), id).toBe(false);
        expect(infoAge.get(id), id).toBeNull();
      }
    }
  });

  test("invalid UTF-8 registry and spool meta stay unreadable/malformed", () => {
    const fx = fixture();
    const junk = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    writeFileSync(join(fx.worktree, ".tap", "team-registry.json"), junk);
    writeFileSync(join(fx.bus, "registry.json"), junk);
    writeFileSync(join(fx.bus, "spool", "bad-101.meta.json"), junk);
    const human = runDoctor(fx);
    expect(human.rc, human.err).toBe(0);
    // Warnings render on stderr in human mode.
    expect(human.err).toContain("could not read registry.json");
    expect(human.err).toContain("malformed spool meta");
    const json = jsonRun(fx);
    expect(json.find("registry_unreadable").length).toBe(1);
    expect(json.find("spool_orphan_meta").length).toBe(1);
  });

  test("a leading UTF-8 BOM is preserved for JSON.parse rejection", () => {
    const fx = fixture();
    // Python json.load rejects a BOM; TextDecoder must not strip it before
    // parse. Cover the acting registry and a spool meta.
    const registryRaw = readFileSync(join(fx.worktree, ".tap", "team-registry.json"), "utf8");
    writeFileSync(join(fx.worktree, ".tap", "team-registry.json"), `\uFEFF${registryRaw}`);
    writeFileSync(join(fx.bus, "registry.json"), "\uFEFF{}\n");
    writeFileSync(join(fx.bus, "spool", "bom-101.meta.json"), "\uFEFF{}\n");
    const human = runDoctor(fx);
    expect(human.err).toContain("could not read registry.json");
    expect(human.err).toContain("malformed spool meta");
  });

  test("a FIFO at a shared diagnostic JSON path cannot block the run", () => {
    const fx = fixture();
    spawnSync("mkfifo", [join(fx.bus, "lanes.json")]);
    spawnSync("mkfifo", [join(fx.bus, "reset-generation.json")]);
    // readJsonFile requires a regular file first; a runDoctor hang would be
    // killed by the spawn timeout and surface as rc -1.
    const human = runDoctor(fx);
    expect(human.rc, human.err + human.out).toBe(0);
    expect(human.err).not.toContain("lanes.json");
  });

  test("a FIFO at a payload path is one torn payload, not a blocked run", () => {
    const fx = fixture();
    const fifoPath = join(fx.bus, "payloads", "fifo-001.md");
    const mk = spawnSync("mkfifo", [fifoPath]);
    expect(mk.status, mk.stderr?.toString()).toBe(0);
    expect(statSync(fifoPath).isFIFO()).toBe(true);
    // One ordinary valid payload with a regular .done receipt: it must be
    // neither torn nor unattributed alongside the FIFO's single torn finding.
    payload(fx.bus, "okay-001.md", ENVELOPE({
      id: "okay-001", from: "a", to: "b", kind: "note", path: join(fx.bus, "payloads", "okay-001.md"),
    }));
    writeFileSync(join(fx.bus, "receipts", "okay-001.done"), "");
    // No stateDigest/treeHash here: those helpers read entries and would hang
    // on the FIFO outside the command under test. The runner's 30s spawn
    // budget bounds the RED (a blocked read dies as rc -1); the 45s test
    // budget proves the process returned normally with diagnostic rc 1.
    const run = jsonRun(fx);
    expect(run.rc, run.err + run.out).toBe(1);
    expect(run.find("torn_payload").length).toBe(1);
    expect(run.find("torn_payload")[0]?.detail.path).toBe("fifo-001.md");
    expect(String(run.find("torn_payload")[0]?.detail.reason)).toContain("not a regular file");
    expect(run.report.summary.torn).toBe(1);
    expect(run.find("unattributed_payload").map((f) => f.detail.path)).not.toContain("okay-001.md");
    expect(run.find("torn_payload").map((f) => f.detail.path)).not.toContain("okay-001.md");
  }, 45000);

  test("unreachable door: pristine reset-generation yields reset, otherwise lost", () => {
    const mkUnreachable = () => {
      const fx = fixture({
        index: {
          schema: "0.20",
          teams: { u1: { root: fx0dir(), registry_location: join(fx0dir(), ".tap", "team-registry.json") } },
        },
      });
      writeFileSync(join(fx.index, "global-registry.json"), `${JSON.stringify({
        schema: "0.20",
        teams: { u1: { root: fx.real, registry_location: join(fx.real, ".tap", "team-registry.json") } },
      })}\n`);
      rmSync(join(fx.worktree, ".tap", "team-registry.json"));
      return fx;
    };
    const resetFx = mkUnreachable();
    writeFileSync(join(resetFx.bus, "reset-generation.json"), `${JSON.stringify({ state: "pristine" })}\n`);
    const resetHuman = runDoctor(resetFx);
    expect(resetHuman.err).toContain("acting_registry_unreachable");
    // The reset-door prelude renders on stdout with the other authority
    // preludes; stderr keeps only the generic authority tail.
    expect(resetHuman.out).toContain("deliberate reset");
    expect(resetHuman.err).not.toContain("--accept-observed-identity");
    expect(jsonRun(resetFx).find("acting_registry_unreachable")[0]?.detail.door).toBe("reset");

    const lostFx = mkUnreachable();
    writeFileSync(join(lostFx.bus, "reset-generation.json"), `${JSON.stringify({ state: "migrated" })}\n`);
    const lostHuman = runDoctor(lostFx);
    expect(lostHuman.err).toContain("acting_registry_unreachable");
    expect(lostHuman.out).not.toContain("deliberate reset");
    expect(jsonRun(lostFx).find("acting_registry_unreachable")[0]?.detail.door).toBe("lost");
  }, 30000);

  test("a BOM-prefixed opening fence is torn", () => {
    const fx = fixture();
    writeFileSync(
      join(fx.bus, "payloads", "bom-001.md"),
      `﻿---\nid: bom-001\nfrom: a\nto: b\nkind: note\npath: p\n---\n\nbody\n`,
    );
    const human = runDoctor(fx);
    expect(human.rc).toBe(1);
    expect(human.err).toContain("torn-payload");
    const json = jsonRun(fx);
    expect(json.report.summary.torn).toBe(1);
    expect(json.find("torn_payload")[0]?.detail.path).toBe("bom-001.md");
  });

  test("envelope path sentinel-safety follows Python whitespace: U+001C torn, U+FEFF kept", () => {
    const fx = fixture();
    payload(fx.bus, "sep-001.md", ENVELOPE({ id: "sep-001", from: "a", to: "b", kind: "note", path: "/tmp/a\u001cb" }));
    // U+FEFF is NOT Python whitespace: a path carrying it must not be torn
    // merely for the BOM (JavaScript's \s would wrongly reject it).
    payload(fx.bus, "feff-001.md", ENVELOPE({
      id: "feff-001", from: "a", to: "b", kind: "note", path: `${fx.bus}/payloads/feff-001.md\ufeff`,
    }));
    const json = jsonRun(fx);
    expect(json.report.summary.torn).toBe(1);
    expect(json.find("torn_payload")[0]?.detail.path).toBe("sep-001.md");
    expect(json.find("torn_payload").map((f) => f.detail.path)).not.toContain("feff-001.md");
  });

  test("installation reports the live TAP install", () => {
    const fx = fixture();
    // The doctor process resolves `tap` off its PATH; the runner's own PATH
    // is sanitized and may not carry the real install, so pin a symlink to
    // the shipped entry into the fixture's own bin ahead of ambient PATH
    // (doctorEnv prepends fx.bin) instead of depending on the environment.
    symlinkSync(shippedEntry, join(fx.bin, "tap"));
    const human = runDoctor(fx);
    expect(human.rc, human.err).toBe(0);
    expect(human.out).toMatch(/installed TAP: \S+ -> \S+; HEAD \S+/);
    const installation = jsonRun(fx).report.installation as {
      tap: { entry: string | null; resolved: string | null; head: string | null };
    };
    expect(installation.tap.resolved).toContain("/bin/tap");
    expect(installation.tap.head).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("tmux server census: other servers are summarized without an age-based health claim", () => {
    // Ported from the retired shell smoke doctor-tmux-servers.test.sh
    // (tap-7r3fn.19): a recorded server whose socket refuses is
    // server_unresponsive; other servers are inventory, regardless of socket
    // age. A healthy selected socket suppresses only the refusal; diagnostics
    // never change the exit.
    const lsofSh = `#!/bin/sh
case "$*" in
  *"-c tmux"*)
    printf 'p4242\\nctmux\\nf5\\nn->0xdeadbeef\\n'
    printf 'p5151\\nctmux\\nf5\\nn%s\\n' "$TAP_FIXTURE_STALE"
    printf 'p6161\\nctmux\\nf5\\nn%s\\n' "$TAP_FIXTURE_FRESH"
    printf 'p7171\\nctmux\\nf5\\nn%s\\n' "$TAP_FIXTURE_DEFAULT" ;;
  *) exit 0 ;;
esac
`;
    const psSh = `#!/bin/sh
[ "$1" = "-axo" ] && printf '4242\\n4242\\n4242\\n5151\\n'
exit 0
`;
    const tmuxSh = `#!/bin/sh
if [ "$TAP_FIXTURE_SOCKET_RESPONDS" = 1 ]; then printf '4242\\n'; exit 0; fi
echo "no server running on $TAP_FIXTURE_DEFAULT" >&2
exit 1
`;
    const mkFx = () => {
      const fx = fixture({
        tmuxSh,
        psSh,
        lsofSh,
        registry: {
          schema: "0.20",
          team: { name: "u1", worktree_root: "REALROOT" },
          seats: {
            orphan: {
              status: "suspended", status_reason: "server_restarted", harness: "claude",
              server_epoch: "srv:4242:100",
            },
          },
        },
      });
      const tmuxDir = join(fx.dir, "tmux-502");
      mkdirSync(tmuxDir, { recursive: true });
      const def = join(tmuxDir, "default");
      const stale = join(tmuxDir, "stale-private");
      const fresh = join(tmuxDir, "fresh-private");
      const old = new Date(Date.now() - 7200 * 1000);
      for (const p of [def, stale, fresh]) writeFileSync(p, "");
      utimesSync(def, old, old);
      utimesSync(stale, old, old);
      return { fx, def, stale, fresh };
    };
    const extraEnv = (s: { def: string; stale: string; fresh: string }): NodeJS.ProcessEnv => ({
      TMUX: `${s.def},900,0`,
      TAP_FIXTURE_DEFAULT: s.def,
      TAP_FIXTURE_STALE: s.stale,
      TAP_FIXTURE_FRESH: s.fresh,
    });

    const { fx, def, stale, fresh } = mkFx();
    const before = stateDigest(fx);
    const human = runDoctor(fx, [], extraEnv({ def, stale, fresh }));
    expect(human.rc, human.err).toBe(0);
    expect(human.out).toContain("server_unresponsive pid 4242 socket");
    expect(human.out).toContain("other tmux servers: 2");
    expect(human.out).not.toContain("stale tmux server");
    expect(human.out).not.toContain("5151");
    const verbose = spawnSync(shippedEntry, ["--verbose", "doctor"], {
      cwd: fx.worktree, env: doctorEnv(fx, extraEnv({ def, stale, fresh })), encoding: "utf8", timeout: 30000,
    });
    expect(verbose.status, verbose.stderr).toBe(0);
    expect(verbose.stdout).toContain("other tmux server pid 5151");
    expect(verbose.stdout).toContain("age: 2h");
    expect(verbose.stdout).toContain("other tmux server pid 6161");
    expect(human.out).not.toContain("6161");
    expect(human.out).not.toContain("7171");
    const json = jsonRun(fx, [], extraEnv({ def, stale, fresh }));
    const orphan = json.find("server_unresponsive")[0];
    expect(orphan?.detail.pid).toBe(4242);
    expect(orphan?.detail.panes).toBe(3);
    expect(orphan?.detail.socket).toBe(realpathSync(def));
    expect(json.find("tmux_server_stale")).toEqual([]);
    const inventory = json.find("tmux_other_servers")[0];
    expect(inventory?.detail.count).toBe(2);
    expect(inventory?.detail.sockets).toMatchObject([{ pid: 5151, socket: stale }, { pid: 6161, socket: fresh }]);
    // Startup recovery advice is preserved inside JSON detail.
    expect(json.find("tmux_offline")[0]?.detail.next).toBe("tap session resume <seat>");
    const socketDetails = (inventory?.detail.sockets as { socket: string }[]).map(row => row.socket);
    expect(socketDetails).not.toContain(def);
    expect(socketDetails).not.toContain("->0xdeadbeef");

    // An explicit selected socket outranks TMUX in the census as in startup diagnostics.
    const pinned = jsonRun(fx, [], { ...extraEnv({ def, stale, fresh }), TAP_TMUX_SOCKET_PATH: stale });
    const pinnedSockets = (pinned.find("tmux_other_servers")[0]?.detail.sockets as { socket: string }[]).map(row => row.socket);
    expect(pinnedSockets).not.toContain(stale);
    expect(pinnedSockets).toContain(def);

    // Negative direction: an answering default socket is not "unresponsive";
    // the independent other-server census is untouched.
    const healthy = mkFx();
    const healthyJson = jsonRun(healthy.fx, [], {
      ...extraEnv({ def: healthy.def, stale: healthy.stale, fresh: healthy.fresh }),
      TAP_FIXTURE_SOCKET_RESPONDS: "1",
    });
    expect(healthyJson.find("server_unresponsive").length).toBe(0);
    expect(healthyJson.find("tmux_other_servers")[0]?.detail.count).toBe(2);
    expect(stateDigest(fx)).toBe(before);
  });

  // tap-7r3fn.153: findings-only startup diagnostics on the resolved socket.
  // The fake tmux answers by socket path (the resolved TAP socket is pinned by
  // TAP_TMUX_SOCKET_PATH) and logs every call, so each arm can also prove
  // doctor only reads.
  describe("tmux startup diagnostics: exit-unattached and socket mismatch (tap-7r3fn.153)", () => {
    const uid = process.getuid?.() ?? 0;
    const FAKE_TMUX = `#!/bin/sh
echo "$*" >> "$TAP_FIXTURE_LOG"
case "$*" in
  *"-S $TAP_FIXTURE_OWN display-message"*)
    if [ "$TAP_FIXTURE_OWN_MODE" = offline ]; then echo "no server running on $TAP_FIXTURE_OWN" >&2; exit 1; fi
    if [ "$TAP_FIXTURE_OWN_MODE" = failed-display ]; then printf '4242\\toff\\ton\\n'; exit 1; fi
    if [ "$TAP_FIXTURE_OWN_MODE" = timeout-display ]; then printf '4242\\toff\\ton\\n'; echo "no server running on $TAP_FIXTURE_OWN" >&2; exec sleep 5; fi
    printf '4242\\t%s\\t%s\\n' off "\${TAP_FIXTURE_EXIT_UNATTACHED-off}"; exit 0 ;;
  *"-S $TAP_FIXTURE_OWN list-panes"*)
    case "$TAP_FIXTURE_OWN_MODE" in
      empty) echo "no current target" >&2; exit 1 ;;
      empty-success|failed-display|timeout-display) exit 0 ;;
      populated) printf '%%1\\n'; exit 0 ;;
      *) echo "protocol error" >&2; exit 1 ;;
    esac ;;
  *alt-tap*list-sessions*) printf 'team/scout\\nunrelated\\n'; exit 0 ;;
  *alt-other*list-sessions*) printf 'unrelated\\nscratch\\n'; exit 0 ;;
  *alt-dead*list-sessions*|*recorded-dead*list-sessions*) echo "error connecting" >&2; exit 1 ;;
  *recorded-elsewhere*list-sessions*) printf 'team/scout\\n'; exit 0 ;;
esac
exit 1
`;
    const servers: Server[] = [];
    afterEach(async () => {
      for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
    });

    // seatSocket: a path (relative to the fixture base) the seat's row records.
    async function setup(alts: string[], opts: { seatSocket?: string; elsewhere?: string[] } = {}) {
      const fx = fixture({
        tmuxSh: FAKE_TMUX,
        registry: {
          schema: "0.20",
          team: { name: "u1", worktree_root: "REALROOT" },
          seats: { scout: { status: "active", harness: "claude", session: "team/scout" } },
        },
      });
      // doctor compares realpaths; macOS tmpdir is a symlink.
      const base = realpathSync(fx.dir);
      const dir = join(base, `tmux-${uid}`);
      mkdirSync(dir, { recursive: true });
      for (const name of alts) {
        await new Promise<void>((ready) => {
          const server = createServer();
          servers.push(server);
          server.listen(join(dir, name), () => ready());
        });
      }
      // Sockets outside TMUX_TMPDIR, as when seats launched under another one.
      const elsewhereDir = join(base, "elsewhere");
      mkdirSync(elsewhereDir, { recursive: true });
      for (const name of opts.elsewhere ?? []) {
        await new Promise<void>((ready) => {
          const server = createServer();
          servers.push(server);
          server.listen(join(elsewhereDir, name), () => ready());
        });
      }
      if (opts.seatSocket) {
        for (const file of [join(fx.worktree, ".tap", "team-registry.json"), join(fx.bus, "registry.json")]) {
          const doc = JSON.parse(readFileSync(file, "utf8")) as { seats: Record<string, Record<string, unknown>> };
          doc.seats.scout!.server_socket = join(base, opts.seatSocket);
          writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
        }
      }
      const own = join(dir, "tap");
      const log = join(base, "tmux.log");
      const env = (mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        TMUX_TMPDIR: base,
        TAP_TMUX_SOCKET_PATH: own,
        TAP_FIXTURE_OWN: own,
        TAP_FIXTURE_OWN_MODE: mode,
        TAP_FIXTURE_LOG: log,
        ...extra,
      });
      return { fx, dir, base, elsewhereDir, own, log, env };
    }

    const mismatch = (r: ReturnType<typeof jsonRun>) => r.find("tmux_socket_mismatch");

    test("an offline TAP socket with TAP seats on another socket names that socket and the env key; unrelated alternates stay quiet", async () => {
      const t = await setup(["alt-tap", "alt-other", "alt-dead"]);
      const json = jsonRun(t.fx, [], t.env("offline"));
      expect(json.rc, json.err).toBe(0);
      const found = mismatch(json);
      expect(found.length).toBe(1);
      expect(found[0]).toMatchObject({
        severity: "warning",
        detail: { socket: t.own, state: "offline", alternate_socket: join(t.dir, "alt-tap"), sessions: ["team/scout"], count: 1 },
      });
      expect(found[0]?.detail.next).toBe(`export TAP_TMUX_SOCKET_PATH=${join(t.dir, "alt-tap")}`);
      // The mismatch replaces the offline finding: resume advice would launch a duplicate.
      expect(json.find("tmux_offline").length).toBe(0);
      expect(json.report.findings.some((f) => f.detail.next === "tap session resume <seat>")).toBe(false);
      // The human surface carries the same facts, on stderr as a warning.
      const human = runDoctor(t.fx, [], t.env("offline"));
      expect(human.rc, human.err).toBe(0);
      expect(human.err).toContain(`warning: TAP's tmux socket ${t.own} is offline, but 1 TAP seat session(s) are on ${join(t.dir, "alt-tap")}`);
      expect(human.err).toContain(`next: export TAP_TMUX_SOCKET_PATH=${join(t.dir, "alt-tap")}`);
      expect(human.out).not.toContain("tmux is offline");
      expect(human.err).not.toContain("alt-other");
      expect(human.err).not.toContain("alt-dead");
    });

    for (const suspended of [false, true]) {
      test(`legacy seats live on another socket never get resume advice (${suspended ? "suspended" : "active"})`, async () => {
        const t = await setup(["alt-tap"]);
        const live = ["scout", "second", "third", "fourth", "fifth", "sixth", "seventh"];
        // The census positively sees an empty server. The alternate holds more
        // sessions than doctor displays, plus an unrelated session.
        const shim = readFileSync(join(t.fx.bin, "tmux"), "utf8")
          .replace("team/scout", live.map(handle => `team/${handle}`).join("\\n"))
          .replace('case "$*" in', `case "$*" in
    *"-S $TAP_FIXTURE_OWN list-sessions"*) exit 0 ;;
    *"-S $TAP_FIXTURE_OWN list-panes"*) exit 0 ;;`);
        writeFileSync(join(t.fx.bin, "tmux"), shim);
        for (const file of [join(t.fx.worktree, ".tap", "team-registry.json"), join(t.fx.bus, "registry.json")]) {
          const doc = JSON.parse(readFileSync(file, "utf8"));
          doc.seats = Object.fromEntries([...live, "missing"].map(handle => [handle, {
            ...activeSeat, server_epoch: "", session: `team/${handle}`, pane: `team/${handle}:0.0`,
            ...(suspended && handle !== "missing" ? { status: "suspended", status_reason: "pane_gone" } : {}),
          }]));
          writeFileSync(file, JSON.stringify(doc));
        }
        const before = stateDigest(t.fx);
        const json = jsonRun(t.fx, [], t.env("empty"));
        expect(mismatch(json)[0]?.detail).toMatchObject({ count: 7, sessions: live.slice(0, 5).map(handle => `team/${handle}`) });
        expect(json.find("seat_unavailable").map(f => f.detail.handle)).toEqual(["missing"]);
        for (const finding of json.report.findings) {
          if (live.includes(String(finding.detail.handle))) {
            expect(String(finding.detail.next)).not.toContain("tap session resume");
            expect(String(finding.detail.next)).not.toContain("tap session launch");
          }
        }
        const human = runDoctor(t.fx, [], t.env("empty"));
        for (const handle of live) expect(human.out + human.err).not.toContain(`tap session resume ${handle}`);
        expect(human.err).toContain("tap session resume missing");
        expect(stateDigest(t.fx)).toBe(before);
      });

    }

    test("a positively empty TAP socket reports the same mismatch as empty", async () => {
      const t = await setup(["alt-tap"]);
      const found = mismatch(jsonRun(t.fx, [], t.env("empty")));
      expect(found.length).toBe(1);
      expect(found[0]?.detail).toMatchObject({ state: "empty", alternate_socket: join(t.dir, "alt-tap") });
    });

    test("healthy and unknown TAP sockets give no mismatch: populated, unreadable, or only unrelated alternates", async () => {
      // The TAP socket holds its sessions: nothing to report even with TAP seats elsewhere.
      let t = await setup(["alt-tap"]);
      expect(mismatch(jsonRun(t.fx, [], t.env("populated"))).length).toBe(0);
      // list-sessions on the TAP socket fails: unknown, never an empty server.
      t = await setup(["alt-tap"]);
      expect(mismatch(jsonRun(t.fx, [], t.env("unreadable"))).length).toBe(0);
      // Alternates exist but hold only non-TAP sessions, or fail to answer.
      t = await setup(["alt-other", "alt-dead"]);
      const quiet = jsonRun(t.fx, [], t.env("offline"));
      expect(mismatch(quiet).length).toBe(0);
      expect(quiet.find("tmux_offline")[0]?.detail.next).toBe("tap session resume <seat>");
      expect(mismatch(jsonRun(t.fx, [], t.env("empty"))).length).toBe(0);
    });

    test("an older tmux that answers an empty namespace with a successful empty read is also positively empty", async () => {
      const t = await setup(["alt-tap"]);
      expect(mismatch(jsonRun(t.fx, [], t.env("empty-success"))).length).toBe(1);
    });

    test("a seat's recorded socket is probed even outside TMUX_TMPDIR, and constrains where its session name counts", async () => {
      // Seats launched under another TMUX_TMPDIR: only the recorded path finds them.
      let t = await setup([], { elsewhere: ["recorded-elsewhere"], seatSocket: "elsewhere/recorded-elsewhere" });
      const found = mismatch(jsonRun(t.fx, [], t.env("offline")));
      expect(found.length).toBe(1);
      expect(found[0]?.detail.alternate_socket).toBe(join(t.elsewhereDir, "recorded-elsewhere"));
      // Provenance: a same-named session on a different server is not the seat's.
      t = await setup(["alt-tap"], { elsewhere: ["recorded-dead"], seatSocket: "elsewhere/recorded-dead" });
      expect(mismatch(jsonRun(t.fx, [], t.env("offline"))).length).toBe(0);
    });

    test("a failed or timed-out display-message with partial output is unknown: no exit-unattached, offline, or mismatch finding", async () => {
      for (const mode of ["failed-display", "timeout-display"]) {
        const t = await setup(["alt-tap"]);
        const json = jsonRun(t.fx, [], t.env(mode));
        expect(json.rc, json.err).toBe(0);
        for (const name of ["tmux_exit_unattached", "tmux_socket_mismatch", "tmux_offline", "tmux_exit_empty"]) {
          expect(json.find(name).length, `${mode}: ${name}`).toBe(0);
        }
      }
    });

    test("no alternate directory and no registry seat sessions give no mismatch", async () => {
      const t = await setup([]);
      expect(mismatch(jsonRun(t.fx, [], t.env("offline"))).length).toBe(0);
      const bare = fixture({ tmuxSh: FAKE_TMUX });
      const base = realpathSync(bare.dir);
      const dir = join(base, `tmux-${uid}`);
      mkdirSync(dir, { recursive: true });
      const own = join(dir, "tap");
      const env = { TMUX_TMPDIR: base, TAP_TMUX_SOCKET_PATH: own, TAP_FIXTURE_OWN: own, TAP_FIXTURE_OWN_MODE: "offline", TAP_FIXTURE_LOG: join(base, "tmux.log") };
      expect(mismatch(jsonRun(bare, [], env)).length).toBe(0);
    });

    test("exit-unattached on is named with its effect and the remedy command; off or unreadable adds nothing", async () => {
      const t = await setup([]);
      const on = jsonRun(t.fx, [], t.env("populated", { TAP_FIXTURE_EXIT_UNATTACHED: "on" }));
      expect(on.rc, on.err).toBe(0);
      const found = on.find("tmux_exit_unattached");
      expect(found.length).toBe(1);
      expect(found[0]).toMatchObject({ severity: "warning", detail: { pid: "4242", socket: t.own, next: `tmux -S ${t.own} set-option -s exit-unattached off` } });
      const human = runDoctor(t.fx, [], t.env("populated", { TAP_FIXTURE_EXIT_UNATTACHED: "on" }));
      expect(human.rc, human.err).toBe(0);
      expect(human.err).toContain("warning: tmux exit-unattached is on: every detached launch (new-session -d) is killed as soon as it starts");
      expect(human.err).toContain(`next: tmux -S ${t.own} set-option -s exit-unattached off`);
      expect(jsonRun(t.fx, [], t.env("populated", { TAP_FIXTURE_EXIT_UNATTACHED: "off" })).find("tmux_exit_unattached").length).toBe(0);
      expect(jsonRun(t.fx, [], t.env("populated", { TAP_FIXTURE_EXIT_UNATTACHED: "" })).find("tmux_exit_unattached").length).toBe(0);
      expect(jsonRun(t.fx, [], t.env("offline")).find("tmux_exit_unattached").length).toBe(0);
    });

    test("the diagnostics only read: no tmux call can start, configure, attach to or stop a server", async () => {
      const t = await setup(["alt-tap"]);
      jsonRun(t.fx, [], t.env("offline", { TAP_FIXTURE_EXIT_UNATTACHED: "on" }));
      const calls = readFileSync(t.log, "utf8").split("\n").filter(Boolean);
      expect(calls.some((c) => c.includes("list-sessions") && c.includes("alt-tap"))).toBe(true);
      // The subcommand follows `-S <socket>`; format strings may mention options.
      for (const call of calls) expect(call.split(" ")[2], call).toMatch(/^(display-message|list-sessions|list-panes)$/);
    });
  });
});

// A nonexistent absolute path under the machine scratch root: used as the
// dangling team's root and as the unreachable team's root.
function fx0dir(): string {
  return join(tmpdir(), "tap-doctor-no-such-team-dir");
}

test("crew supervision deadline does not prevent the independent doctor census", () => {
  const fx = fixture({ tmuxSh: '#!/bin/sh\ncase "$*" in *"#{socket_path}"*) exec sleep 2 ;; esac\nexit 1\n' });
  const marker = join(fx.dir, "census-ran");
  writeFileSync(join(fx.bin, "lsof"), '#!/bin/sh\n: > "$TAP_DOCTOR_CENSUS_MARKER"\nexit 0\n', { mode: 0o755 });
  const result = jsonRun(fx, [], { TAP_TMUX_TIMEOUT_SECONDS: "0.05", TAP_DOCTOR_CENSUS_MARKER: marker });
  expect(result.report.findings).toBeArray();
  expect(existsSync(marker)).toBe(true);
  expect(result.err).not.toContain("ServerUnresponsive");
});

// tap-7r3fn.17.1: the tmux client hazard scan integrated through the shipped
// entry. Valid imports only — on the parent these assertions fail because
// cmdDoctor never emits the findings (the behavioral red), not because the
// test cannot load. All process evidence is fixture shims; no host tmux.
const HAZARD_PS_SHIM = [
  "#!/bin/sh",
  `[ "$1" = "-axo" ] || exit 1`,
  "cat <<'ROWS'",
  "  20642 17179 10569 ttys049 tmux attach-session -t =tap/terra-researcher",
  "  74221 74221 74221 ttys042 tmux attach -t tap/fable-7-3-leader",
  "ROWS",
].join("\n");
const HAZARD_LSOF_SHIM = [
  "#!/bin/sh",
  `case "$*" in`,
  `*"+fg -nP -p 900"*) cat <<'ROWS'`,
  "COMMAND  PID USER   FD   TYPE         FILE-FLAG         DEVICE SIZE/OFF NODE NAME",
  "tmux    900   u   43u   CHR R,W,NB,0x11000;SH         16,42  0t1234 1234 /dev/ttys042",
  "tmux    900   u   52u   CHR    R,W,0x10000;SH         16,49  0t5678 1479 /dev/ttys049",
  "ROWS",
  "  ;;",
  "*) exit 1 ;;",
  "esac",
].join("\n");
const HAZARD_TMUX_SHIM = [
  "#!/bin/sh",
  `case "$*" in`,
  `*exit-empty*) printf '900\\ton\\toff\\n' ;;`,
  `*socket_path*) printf '/private/tmp/tmux-502/default\\n' ;;`,
  `*"#{pid}"*) printf '900\\n' ;;`,
  `*pane_tty*) printf '/dev/ttys900\\n' ;;`,
  "*) exit 1 ;;",
  "esac",
].join("\n");
const BENIGN_PS_SHIM = [
  "#!/bin/sh",
  `[ "$1" = "-axo" ] || exit 1`,
  "printf '  74221 74221 74221 ttys042 tmux attach -t tap/fable-7-3-leader\\n'",
].join("\n");
const BENIGN_LSOF_SHIM = [
  "#!/bin/sh",
  `case "$*" in`,
  `*"+fg -nP -p 900"*) printf 'COMMAND  PID USER   FD   TYPE         FILE-FLAG         DEVICE SIZE/OFF NODE NAME\\ntmux    900   u   43u   CHR R,W,NB,0x11000;SH         16,42  0t1234 1234 /dev/ttys042\\n' ;;`,
  "*) exit 1 ;;",
  "esac",
].join("\n");

describe("doctor tmux client hazards, shipped-entry integration (tap-7r3fn.17.1)", () => {
  test("both incident hazards surface end-to-end with exact evidence", () => {
    const fx = fixture({ tmuxSh: HAZARD_TMUX_SHIM, psSh: HAZARD_PS_SHIM, lsofSh: HAZARD_LSOF_SHIM });
    const result = jsonRun(fx);
    expect(result.rc).toBe(0);
    const clients = result.find("background_attach_client");
    expect(clients.length).toBe(1);
    expect(clients[0]!.severity).toBe("warning");
    expect(clients[0]!.detail).toEqual({
      pid: 20642, pgid: 17179, tty: "ttys049", foreground_pgid: 10569,
      command: "tmux attach-session -t =tap/terra-researcher",
    });
    const fds = result.find("blocking_client_tty_fd");
    expect(fds.length).toBe(1);
    expect(fds[0]!.severity).toBe("warning");
    expect(fds[0]!.detail).toEqual({
      server_pid: 900, fd: "52u", tty: "/dev/ttys049", flags: "R,W,0x10000;SH", client_pids: [20642],
    });
    // Readable evidence never reports itself as missing.
    expect(result.find("tmux_client_hazards_unverified")).toEqual([]);
  });

  test("benign controls stay clean end-to-end: foreground attach and its NB fd", () => {
    const fx = fixture({ tmuxSh: HAZARD_TMUX_SHIM, psSh: BENIGN_PS_SHIM, lsofSh: BENIGN_LSOF_SHIM });
    const result = jsonRun(fx);
    expect(result.rc).toBe(0);
    expect(result.find("background_attach_client")).toEqual([]);
    expect(result.find("blocking_client_tty_fd")).toEqual([]);
    expect(result.find("tmux_client_hazards_unverified")).toEqual([]);
  });

  test("a failing ps is a named not-checked, not an all-clear", () => {
    const fx = fixture({ tmuxSh: HAZARD_TMUX_SHIM, psSh: "#!/bin/sh\nexit 1\n", lsofSh: BENIGN_LSOF_SHIM });
    const result = jsonRun(fx);
    expect(result.rc).toBe(0);
    expect(result.find("background_attach_client")).toEqual([]);
    const unverified = result.find("tmux_client_hazards_unverified");
    // The ps failure itself is named; on Linux the uncorroborated server tty
    // fd joins a second not-checked finding — both are honest unknowns.
    expect(unverified.length).toBeGreaterThanOrEqual(1);
    expect(unverified.some((f) => f.detail.tool === "ps" && String(f.detail.reason).includes("failed"))).toBe(true);
  });
});
