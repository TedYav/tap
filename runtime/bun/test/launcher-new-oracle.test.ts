// Oracle for `tap session launch` (launcher/new.ts): every case runs new.ts
// and requires exit status, stdout and stderr byte for byte equal to the
// incumbent `launcher.py new`'s, recorded in fixtures/launch-oracle.json while
// it still existed (retiring the Python launcher deleted it). Only volatile values are
// masked. Dry runs end in transaction.ts's renderer, so agreement proves the
// planned name, record, argv, env and every pre-effect refusal, plus the
// collision ladder's non-interactive arms and the chooser prompts' first frame.
// What each chooser answer does is the scripted tests at the end.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promptNewCollision } from "../src/launcher/collision";
import { writeLiveFence } from "./support/live-fence";

const repo = resolve(import.meta.dir, "../../..");
const GOLDEN = join(import.meta.dir, "fixtures/launch-oracle.json");
const native = join(repo, "runtime/bun/src/launcher/new.ts");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

let root = "", cwd = "", registry = "", index = "";
let env: NodeJS.ProcessEnv = {};

beforeAll(() => {
  root = realpathSync(mkdtempSync("/tmp/tap-new-oracle-"));
  index = join(root, "index");
  cwd = join(root, "repo");
  registry = join(cwd, ".tap/team-registry.json");
  for (const dir of [index, join(cwd, ".tap/bus"), join(root, "user/.config/tap")]) mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", cwd]);
  writeFileSync(join(root, "user/.config/tap/config.toml"), [
    "version = 3",
    "[presets.rev]", 'harness = "codex"', "[presets.rev.params]", 'model = "gpt-x"',
    "[presets.deep]", 'harness = "claude"', "[presets.deep.params]", 'model = "opus"', 'effort = "high"',
    "[presets.deep.env]", 'DEEP_MODE = "1"',
    "[presets.help]", 'harness = "claude"',
    // The golden was recorded when an unsaved choice fell back to bypass; the
    // fixture saves bypass so the oracle stays its subject (the auto default is
    // pinned in launcher-permissions.test.ts).
    '[harness.claude]', 'permissions = "bypass"', '[harness.codex]', 'permissions = "bypass"',
    '[harness.cursor]', 'permissions = "bypass"', '[harness.agy]', 'permissions = "bypass"',
    "",
  ].join("\n"));
  env = { PATH: process.env.PATH, HOME: join(root, "user"), XDG_CONFIG_HOME: join(root, "user/.config"), TAP_INDEX_HOME: index,
    TAP_TMUX_SOCKET: `new-oracle-${process.pid}`, TAP_HOME: join(cwd, ".tap/bus"), TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TAP_SESSION_MANIFEST: join(root, "no-manifest.json"), LANG: "C.UTF-8" };
  enroll();
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function enroll(seats: Record<string, unknown> = {}) {
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: cwd }, seats }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root: cwd, registry_location: registry } } }));
}

type Outcome = { status: number | null; stdout: string; stderr: string };

// Volatile values in an outcome: the scratch root, the pid-named socket, the
// runner's tmux directory, a minted conversation uuid and a tmux creation clock.
function mask(text: string): string {
  let masked = text.replaceAll(root, "<root>").replace(UUID, "<uuid>").replace(/new-oracle-\d+/g, "new-oracle-<pid>")
    .replace(/created \d\d:\d\d/g, "created <hh:mm>");
  if (env.TMUX_TMPDIR) masked = masked.replaceAll(env.TMUX_TMPDIR, "<tmux>");
  return masked;
}

// The incumbent's outcomes, recorded from launcher.py new before it was
// deleted when the Python launcher was retired; fixtures/launch-oracle.json's header names the base.
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")).cases as Record<string, unknown>;
function incumbentOutcome<T>(key: string): T {
  if (!(key in golden)) throw new Error(`launch-oracle.json has no case '${key}'`);
  return golden[key] as T;
}

function both(key: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, at = cwd) {
  const merged = Object.fromEntries(Object.entries({ ...env, ...extraEnv }).filter(([, value]) => value !== undefined));
  const r = spawnSync("bun", [native, ...args], { cwd: at, env: merged, encoding: "utf8", timeout: 30_000 });
  const actual: Outcome = { status: r.status, stdout: mask(r.stdout), stderr: mask(r.stderr) };
  // tap-zi01z deliberately changes these diagnostics; keep the historical
  // Python oracle intact and assert each new byte string explicitly.
  const expected = { ...incumbentOutcome<Outcome>(key) };
  const baseKey = key.replace(/ --json$/, "");
  // Preserve the frozen oracle; only the retired checkpoint remedy changes.
  if (baseKey === "live reset fence") expected.stderr = expected.stderr.replace(
    "next: tap team reset", "next: wait for the reset owner (or until identity is readable)",
  );
  // OpenCode 2 adds private-server TUI launches; TAP also defaults session tabs
  // off. Preserve the historical fixture and pin each intended output change.
  if (baseKey === "opencode") {
    if (key.endsWith(" --json")) {
      expected.stdout = expected.stdout.replace('"argv":["opencode"', '"argv":["opencode","--standalone"');
      const preview = JSON.parse(expected.stdout);
      preview.env.OPENCODE_CLI_CONFIG_CONTENT = '{"tabs":{"mode":"off"}}';
      expected.stdout = JSON.stringify(preview) + "\n";
    } else expected.stderr = "tap session: OpenCode tabs.mode=off\n";
  }
  if (baseKey === "--effort unsupported") {
    expected.stdout = expected.stdout.replaceAll("agy, claude, codex, hermes)", "agy, claude, codex, hermes, opencode)");
    expected.stderr = expected.stderr.replaceAll("agy, claude, codex, hermes)", "agy, claude, codex, hermes, opencode)");
  }
  const warningFlag = ({ "passthrough flag": "-c", "preset with passthrough": "-c", "--effort with passthrough": "--verbose" } as Record<string, string>)[baseKey];
  if (warningFlag && !(key.endsWith(" --json") && expected.status !== 0)) expected.stderr = `tap session launch: warning: ${warningFlag} is not a TAP launch option; it and following arguments are forwarded to the harness. Use -- before intentional harness arguments.\n` + expected.stderr;
  // Every local Codex launch now carries --no-daemon (tap-21bdj); the recorded incumbent predates it.
  // It sits right before the permission flag, after any tuning flags. Splice that one token into
  // the recorded --json argv so every other byte stays pinned and a candidate without it, or with
  // it elsewhere, still fails. The plain-text rows never print argv.
  if (key.endsWith(" --json") && expected.status === 0 && expected.stdout.includes('"argv":["codex",') && !expected.stdout.includes("--remote")) {
    // Beside it rides the startup update-check override, spliced the same way.
    expected.stdout = expected.stdout.replace('"--dangerously-bypass-approvals-and-sandbox"', '"--no-daemon","-c","check_for_update_on_startup=false","--dangerously-bypass-approvals-and-sandbox"');
  }
  if (baseKey === "collision: a seated gone row refuses without a terminal") {
    expected.stderr = "tap session: fixture/scout has a retained seat record but no live tmux session; --fresh reclaims the record and launches the seat; next: tap session launch claude scout --fresh\n";
    if (key.endsWith(" --json")) {
      expected.stderr = "";
      expected.stdout = JSON.stringify({ ok: false, error_class: "session_record_exists", action: "tap session launch claude scout --fresh",
        detail: "fixture/scout has a retained seat record but no live tmux session; --fresh reclaims the record and launches the seat" }) + "\n";
    }
  }
  if (baseKey === "unknown first word") {
    // The first-hour wording change keeps both name lists and adds the no-preset
    // door: tap presets, or a bare harness launch.
    const launch = "tap launch claude newcomer", presets = "tap presets, or launch a harness directly: " + launch;
    const detail = "'nope' is not a known harness or a saved preset; canonical harnesses: agy, claude, codex, cursor, hermes, opencode; available presets: deep, help, rev; config: <root>/user/.config/tap/config.toml";
    if (key.endsWith(" --json")) expected.stdout = JSON.stringify({ ok: false, error_class: "harness_or_preset_not_found", action: presets, detail }) + "\n";
    else expected.stderr = `tap session: ${detail}; next: ${presets}\n`;
  }
  return { incumbent: expected, native: actual };
}

const cases: [string, string[], number?][] = [
  ["bare claude", ["claude"]],
  ["bare codex", ["codex"]],
  ["opencode", ["opencode"]],
  ["cursor", ["cursor"]],
  ["hermes", ["hermes"]],
  ["agy", ["agy"]],
  ["labelled seat", ["codex", "scout"]],
  ["label equal to harness", ["claude", "claude"]],
  ["dotted label", ["claude", "review.er"]],
  ["label needing sanitizing", ["claude", "Big Seat!"]],
  ["--tag", ["claude", "--tag", "planner"]],
  ["--tag=value", ["claude", "--tag=planner"]],
  ["--unique", ["codex", "--unique", "fixture/exact-one"]],
  ["--unique invalid", ["codex", "--unique", "bad name"]],
  ["--unique with --fresh", ["codex", "--unique", "fixture/x", "--fresh"]],
  ["--model", ["claude", "--model", "opus"]],
  ["--model empty", ["claude", "--model", ""]],
  ["--effort claude", ["claude", "--effort", "high"]],
  ["--effort codex", ["codex", "--effort", "xhigh"]],
  ["--effort out of domain", ["claude", "--effort", "bogus"]],
  ["--effort unsupported", ["cursor", "--effort", "high"]],
  ["cursor --model", ["cursor", "--model", "gpt-5"]],
  ["--env", ["claude", "--env", "FOO=bar"]],
  ["--env forbidden", ["claude", "--env", "TAP_SELF=x"]],
  ["--env credential", ["claude", "--env", "GITHUB_TOKEN=x"]],
  ["--env missing =", ["claude", "--env", "FOO"]],
  ["--unset-env", ["claude", "--unset-env", "FOO"]],
  ["--env and --unset-env same key", ["claude", "--env", "FOO=1", "--unset-env", "FOO"]],
  ["passthrough flag", ["codex", "worker", "-c", "reasoning_effort=high"], 2],
  ["-- passthrough", ["claude", "scribe", "--", "--model", "gpt-foo"]],
  ["--effort with passthrough", ["claude", "--effort", "high", "--verbose"]],
  ["preset", ["rev"]],
  ["preset with label", ["rev", "second"]],
  ["--preset", ["--preset", "rev"]],
  ["preset with env and effort", ["deep"]],
  ["preset plus --model", ["rev", "--model", "other"]],
  ["preset named help", ["help"]],
  ["preset with passthrough", ["rev", "-c", "x=y"], 1],
  ["unknown preset", ["--preset", "nope"]],
  ["unknown first word", ["nope"]],
  ["no arguments", []],
  ["numeric label resumes", ["claude", "3"]],
  ["numeric label with tuning", ["claude", "3", "--model", "opus"]],
  ["numeric label --fresh", ["claude", "3", "--fresh"]],
  ["--new", ["claude", "sib", "--new"]],
  ["--attach", ["claude", "att", "--attach"]],
];

// .190 deliberately replaces these four historical argparse/splitter receipts.
// Keep the recorded oracle intact; assert the new public contract explicitly.
for (const [args, errorClass, detail] of [
  [["claude", "scout", "extrabare"], "launch_arg_invalid", "unexpected positional argument; use -- before bare harness arguments"],
  [["claude", "--", "--preset=rev"], "preset_passthrough", "--preset is never forwarded; move it before harness passthrough begins"],
  [["claude", "--teams", "x"], "launch_arg_invalid", "unrecognized launch option"],
  [["claude", "--tag"], "launch_arg_invalid", "--tag requires a value"],
] as const) for (const json of [false, true]) {
  test(`native syntax refusal: ${args.join(" ")} (json=${json})`, () => {
    const result = spawnSync("bun", [native, ...(json ? ["--json"] : []), ...args], { cwd, env, encoding: "utf8" });
    expect(result.status).toBe(2);
    const action = "tap launch --help";
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, error_class: errorClass, action, detail });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`tap launch: ${detail}; next: ${action}\n`);
    }
  });
}

for (const [name, args, passthroughAt] of cases) {
  for (const json of [false, true]) {
    test(`${name}${json ? " --json" : ""}`, () => {
      // The flags go before the harness passthrough (`--`, or a case's first
      // unknown flag): after it they are the harness's, and the case would really launch.
      const split = args.includes("--") ? args.indexOf("--") : passthroughAt ?? args.length;
      const flags = ["--dry-run", ...(json ? ["--json"] : [])];
      const { incumbent: expected, native: actual } = both(`${name}${json ? " --json" : ""}`,
        [...args.slice(0, split), ...flags, ...args.slice(split)]);
      expect(actual).toEqual(expected);
    });
  }
}

test("a live reset fence refuses before any effect", () => {
  const fence = join(cwd, ".tap/bus/reset.fence.json");
  writeLiveFence(fence);
  try {
    const { incumbent: expected, native: actual } = both("live reset fence", ["claude", "--dry-run"]);
    expect(actual).toEqual(expected);
    expect(expected.status).toBe(2);
  } finally { rmSync(fence); }
});

test("an ownerless reset fence refuses as unreclaimable, identically in both launchers", () => {
  const fence = join(cwd, ".tap/bus/reset.fence.json");
  writeFileSync(fence, "{}\n");
  try {
    const { incumbent: expected, native: actual } = both("ownerless reset fence", ["claude", "--dry-run"]);
    expect(actual).toEqual(expected);
    expect(expected.status).toBe(2);
    expect(expected.stderr).toContain("names no owner (pid, boot_id or owner_start missing), so nothing will clear it automatically");
    expect(expected.stderr).not.toContain("mid-reset");
  } finally { rmSync(fence); }
});

test("an invalid flip marker refuses", () => {
  writeFileSync(join(index, "global-registry.json"), "not json\n");
  try {
    const { incumbent: expected, native: actual } = both("invalid flip marker", ["claude", "--dry-run"]);
    expect(actual).toEqual(expected);
  } finally { enroll(); }
});

test("an unenrolled root under a foreign TAP_HOME pin refuses", () => {
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  spawnSync("git", ["init", "-q", fresh]);
  const { incumbent: expected, native: actual } = both("unenrolled root, foreign TAP_HOME", ["claude", "--dry-run"], {}, fresh);
  expect(actual).toEqual(expected);
});

test("a pristine unenrolled root plans its first launch without writing", () => {
  const pristine = join(root, "pristine");
  mkdirSync(pristine);
  spawnSync("git", ["init", "-q", pristine]);
  for (const dry of [["--dry-run"], ["--dry-run", "--json"]]) {
    const { incumbent: expected, native: actual } = both(`pristine root ${dry.join(" ")}`, ["claude", ...dry], { TAP_HOME: undefined }, pristine);
    expect(actual).toEqual(expected);
  }
  expect(spawnSync("ls", ["-A", pristine], { encoding: "utf8" }).stdout.trim()).toBe(".git");
});

test("a pristine project with spaces previews the derived team name identically in both engines", () => {
  const spaced = join(root, "My Project");
  mkdirSync(spaced);
  spawnSync("git", ["init", "-q", spaced]);
  for (const dry of [["--dry-run"], ["--dry-run", "--json"]]) {
    const { incumbent: expected, native: actual } = both(`spaced root ${dry.join(" ")}`, ["claude", ...dry], { TAP_HOME: undefined }, spaced);
    expect(actual).toEqual(expected);
    expect(actual.stdout + actual.stderr).not.toContain("My-Project");
    expect(actual.stderr).toContain("tap session: team name: my-project (derived from folder 'My Project'; override with --team <name>)");
  }
  expect(spawnSync("ls", ["-A", spaced], { encoding: "utf8" }).stdout.trim()).toBe(".git");
});

test("a linked worktree refuses rather than becoming a team", () => {
  spawnSync("git", ["-C", cwd, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-qm", "f"]);
  const linked = join(root, "linked");
  spawnSync("git", ["-C", cwd, "worktree", "add", "-qb", "item", linked]);
  for (const dry of [["--dry-run"], ["--dry-run", "--json"]]) {
    const { incumbent: expected, native: actual } = both(`linked worktree ${dry.join(" ")}`, ["claude", ...dry], {}, linked);
    expect(actual).toEqual(expected);
    expect(expected.status).not.toBe(0);
  }
});

// ---- the collision ladder ----
// A dry run never prompts, so every case here takes a non-interactive arm:
// the exit-2 refusals, the shell reseat, --new and --fresh. The chooser's
// interactive arms are launcher-new-collision.test.ts's scripted tests.
const tmux = (...args: string[]) => spawnSync("tmux", ["-L", env.TAP_TMUX_SOCKET!, "-f", "/dev/null", ...args],
  { env: { PATH: env.PATH, TMUX_TMPDIR: env.TMUX_TMPDIR }, encoding: "utf8" });

function collide(title: string, setup: () => void, args: string[], expectStatus?: number, expectText?: RegExp) {
  for (const json of [false, true]) {
    test(`collision: ${title}${json ? " --json" : ""}`, () => {
      setup();
      try {
        const { incumbent: expected, native: actual } = both(`collision: ${title}${json ? " --json" : ""}`,
          [...args, "--dry-run", ...(json ? ["--json"] : [])]);
        if (json && expected.status === 2) {
          // tap-wj35h, a deliberate departure from the incumbent: the parsed --json alone (no
          // TAP_JSON in the environment) renders a refusal (exit 2) as its structured
          // error, one object on stdout; a JSON success keeps byte-for-byte parity below.
          expect([actual.status, actual.stderr]).toEqual([expected.status, ""]);
          const lines = actual.stdout.trim().split("\n");
          expect(lines).toHaveLength(1);
          expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error_class: expect.stringMatching(/^session_/) });
        } else expect(actual).toEqual(expected);
        if (expectStatus !== undefined) expect(expected.status).toBe(expectStatus);
        if (expectText !== undefined && !json) expect(expected.stdout + expected.stderr).toMatch(expectText);
      } finally { enroll(); }
    });
  }
}

beforeAll(() => {
  // A process named like a harness, so the pane classifies as a live seat.
  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/sleep", join(root, "bin/claude"));
  expect(tmux("new-session", "-d", "-s", "fixture/shelly", "sh").status).toBe(0);
  expect(tmux("new-session", "-d", "-s", "fixture/busy", "sleep", "600").status).toBe(0);
  expect(tmux("new-session", "-d", "-s", "fixture/harn", join(root, "bin/claude"), "600").status).toBe(0);
  expect(tmux("new-session", "-d", "-s", "fixture/other", "sleep", "600").status).toBe(0);
});
afterAll(() => { tmux("kill-server"); });

// A relaunchable row (the launch record's source) carries a session and pane coordinates.
const gone = (tag: string, harness = "claude") =>
  ({ harness, session: `fixture/${tag}`, pane_id: "%9999", pane: `fixture/${tag}:0.0`, status: "active" });
const seatedLive = (tag: string, harness = "claude", extra: Record<string, unknown> = {}) => ({ harness, session: `fixture/${tag}`,
  pane_id: tmux("display-message", "-p", "-t", `=fixture/${tag}:`, "#{pane_id}").stdout.trim(), pane: `fixture/${tag}:0.0`,
  status: "active", ...extra });

collide("a seated gone row refuses without a terminal", () => enroll({ scout: gone("scout") }), ["claude", "scout"], 2);
collide("a seated gone row with --fresh reseats", () => enroll({ scout: gone("scout") }), ["claude", "scout", "--fresh"]);
collide("a seated gone row with --new suffixes", () => enroll({ scout: gone("scout") }), ["claude", "scout", "--new"]);
collide("a seated gone row with a conversation id and --fresh", () =>
  enroll({ scout: { ...gone("scout"), harness_session_id: "11111111-2222-3333-4444-555555555555" } }), ["claude", "scout", "--fresh"]);
collide("a gone preset row suffixes automatically", () => enroll({ rev: gone("rev", "codex") }), ["rev"], 0, /fixture\/rev-2/);
collide("a gone preset row with --fresh reseats", () => enroll({ rev: gone("rev", "codex") }), ["rev", "--fresh"]);
collide("an unattended shell is reseated fresh", () => undefined, ["claude", "shelly"], 0, /fixture\/shelly/);
collide("an unattended shell seated as another harness refuses", () =>
  enroll({ shelly: seatedLive("shelly", "codex") }), ["claude", "shelly"], 2, /fixture\/shelly already exists/);
collide("a busy off-roster session refuses", () => undefined, ["claude", "busy"], 2, /fixture\/busy already exists/);
collide("a live off-roster harness refuses with the tmux fact", () => undefined, ["claude", "harn"], 2, /already exists \(created <hh:mm>\); it is not on the team roster/);
collide("a live off-roster harness with --new suffixes", () => undefined, ["claude", "harn", "--new"]);
collide("a live seated harness refuses", () => enroll({ harn: { harness: "claude", session: "fixture/harn", status: "active" } }),
  ["claude", "harn"], 2);
collide("a live seated harness with a record refuses", () => enroll({ harn: seatedLive("harn") }), ["claude", "harn"], 2,
  /fixture\/harn already exists/);
// An expired reservation (another boot) is a record but not a seat: launch ignores it aloud.
collide("a leftover record off the roster is ignored with a notice", () =>
  enroll({ scout: { ...gone("scout"), pane_id: "", status: "pending", boot_id: "boot:1" } }), ["claude", "scout"], 0,
  /ignoring leftover record fixture\/scout — not on roster; launch creates a new seat \(tap session resume scout to restore history\)/);
collide("a handle live in another session refuses", () => {
  const pane = tmux("display-message", "-p", "-t", "=fixture/other:", "#{pane_id}").stdout.trim();
  enroll({ roam: { harness: "claude", pane_id: pane, session: "fixture/other", status: "active" } });
}, ["claude", "roam"], 2, /roam is live in fixture\/other/);

// The interactive arms, on a private pseudo-terminal: [q] at every chooser
// leaves everything unchanged (exit 2), so the question, options, glosses and
// default render byte for byte in both engines without launching anything.
// tap-ibmoe deliberately changes the menu, so the historical Python frame is
// adjusted explicitly: [k] reads "kill", and an [f] fork row sits under [n],
// here always unavailable (no fixture stores a conversation id) in the plain
// form a terminal without TERM gets. The glosses were later shortened to fit a
// 50-column row; GLOSS maps each recorded one to its current text.
const SEAT = "No saved chat to fork", OFF = "Not a TAP seat";
const GLOSS: Record<string, string> = {
  "no conversation to resume — start a fresh session under this name": "Nothing to resume; start fresh",
  "no live id — resume opens the harness native picker": "No usable ID; open the native picker",
  "Reattach to the existing session": "Reattach to the running session",
  "Start another session with a suffix": "Start a sibling with a suffixed name",
  "Start a sibling seat under a suffixed name": "Start a sibling with a suffixed name",
  "Stop the session and start over": "Stop it and start fresh",
  "Replace it — start a fresh session under this name": "Start fresh under this name",
  "Stop the session and start over under this name": "Stop it; start fresh under this name",
  "Leave everything unchanged": "Leave everything unchanged",
};
// The label column re-pads to the longest label left (the off-roster menu has no "resume").
const menuOf = (frame: string, forkReason: string) => frame.replace(/(?:  \[\w\] \S+ +[^\r]*\r\n)+/, block => {
  const rows = [...block.matchAll(/  \[(\w)\] (\S+) +([^\r]*)\r\n/g)].flatMap(([, key, label, gloss]) => {
    if (!(gloss! in GLOSS)) throw new Error(`no current gloss for recorded '${gloss}'`);
    const row: [string, string, string] = [key!, label === "fresh" ? "kill" : label!, GLOSS[gloss!]!];
    return key === "n" ? [row, ["f", "fork", `(unavailable: ${forkReason})`] as [string, string, string]] : [row];
  });
  const width = Math.max(...rows.map(([, label]) => label.length));
  return rows.map(([key, label, gloss]) => `  [${key}] ${label.padEnd(width)}  ${gloss}\r\n`).join("");
});
function choose(title: string, setup: () => void, args: string[], expectText: RegExp, forkReason: string) {
  test(`chooser: ${title}`, () => {
    setup();
    try {
      const merged = Object.fromEntries(Object.entries({ ...env, PATH: `${join(root, "bin")}:${env.PATH}`,
        PTY_PROMPT_MARKER: "(Esc quits): " }).filter(([, value]) => value !== undefined));
      const pty = (command: string[]) => {
        const r = spawnSync("python3", [join(import.meta.dir, "support/pty-prompt.py"), JSON.stringify(["q"]), ...command],
          { cwd, env: merged, encoding: "utf8", timeout: 90_000 });
        const shown = JSON.parse(r.stdout) as { exit: number | null; output: string; before: string; after: string };
        // The native launch door may draw its transient "Loading TAP config"
        // spinner frame before the chooser erases it; the incumbent had none.
        const settled = (text: string) => text.replace(/\r\x1b\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] [^\r]*(?=\r\x1b\[2K)/g, "").replaceAll("\r\x1b[2K", "");
        return { exit: shown.exit, output: mask(settled(shown.output)), before: mask(settled(shown.before)), after: mask(settled(shown.after)) };
      };
      const recorded = incumbentOutcome<ReturnType<typeof pty>>(`chooser: ${title}`);
      const expected = { ...recorded, output: menuOf(recorded.output, forkReason) };
      expect(expected.output).not.toBe(recorded.output);
      // Live-name menus defer harness classification until a key is selected.
      if (title.startsWith("a live seated harness")) {
        expected.output = expected.output.replace("live, running detached", "session name is live")
          .replace(/(\[r\] resume +)[^\r]+/, "$1Attach if running; otherwise resume");
      }
      const actual = pty(["bun", native, ...args]);
      expect(actual).toEqual(expected);
      expect(expected.exit).toBe(2);
      expect(expected.output).toMatch(expectText);
    } finally { enroll(); }
  }, 120_000);
}

choose("a live seated harness offers reattach", () => enroll({ harn: { harness: "claude", session: "fixture/harn", status: "active" } }),
  ["claude", "harn"], /'fixture\/harn' \(claude\): session name is live · registered as harn/, SEAT);
choose("a live seated harness with a record discloses its resume tier", () => enroll({ harn: seatedLive("harn") }),
  ["claude", "harn"], /Attach if running; otherwise resume/, SEAT);
choose("a handle live in another session", () => {
  const pane = tmux("display-message", "-p", "-t", "=fixture/other:", "#{pane_id}").stdout.trim();
  enroll({ roam: { harness: "claude", pane_id: pane, session: "fixture/other", status: "active" } });
}, ["claude", "roam"], /'fixture\/roam' \(claude\): live in fixture\/other · registered as roam/, SEAT);
choose("an unattended shell offers a fresh reseat", () => undefined, ["claude", "shelly"],
  /'fixture\/shelly' \(claude\): an unattended shell session is holding the name · not on roster/, OFF);
choose("a live off-roster harness offers no resume", () => undefined, ["claude", "harn"],
  /a tmux session named fixture\/harn already exists \(created <hh:mm>\); it is not on the team roster/, OFF);
choose("a seated gone row offers the reseat chooser", () => enroll({ scout: gone("scout") }), ["claude", "scout"],
  /'fixture\/scout' \(claude\): a gone seat row \(fixture\/scout:0\.0\) · registered as scout/, SEAT);
choose("a busy off-roster session", () => undefined, ["claude", "busy"], /'fixture\/busy' already exists \(claude\)/, OFF);

// The stopped-seat chooser's [r] gloss tells the truth by resume tier:
// exact rows resume the recorded id, id-less rows start fresh (OpenCode).
test("chooser: the reseat [r] gloss discloses the resume tier", () => {
  const asked: { question: string; options: [string, string, string][]; fallback: string }[] = [];
  const choose = ((_verb: string, question: string, options: [string, string, string][], fallback: string) => {
    asked.push({ question, options, fallback });
    return fallback;
  }) as Parameters<typeof promptNewCollision>[0];
  promptNewCollision(choose, "demo/glm", "opencode", "a stopped session record", "exact", null);
  promptNewCollision(choose, "demo/kimi", "opencode", "an id-less stopped record", "fresh", "no saved chat to fork");
  const resume = (n: number) => asked[n]!.options.find(([key]) => key === "r")?.[2];
  expect(asked.map(a => a.fallback)).toEqual(["r", "r"]);
  expect(resume(0)).toBe("Resume the chat by its native ID");
  expect(resume(1)).toBe("Nothing to resume; start fresh");
  expect(asked[0]!.question).not.toContain("temporarily disabled");
  expect(asked[1]!.question).not.toContain("/resume");
});

// What each answer DOES, which the [q] differentials above cannot reach
// without launching: new.ts under a scripted chooser, its transaction stubbed
// to print the record it would launch.
function scripted(choices: string[], args: string[], extra: NodeJS.ProcessEnv = {}) {
  const merged = Object.fromEntries(Object.entries({ ...env, PATH: `${join(root, "bin")}:${env.PATH}`, ...extra })
    .filter(([, value]) => value !== undefined));
  const r = spawnSync("bun", [join(import.meta.dir, "support/launch-scripted.ts"), choices.join(","), ...args],
    { cwd, env: merged, encoding: "utf8", timeout: 30_000 });
  const run = r.stdout.split("\n").find(line => line.startsWith("RUN "));
  const fork = r.stdout.split("\n").find(line => line.startsWith("FORK "));
  const lines = (prefix: string) => r.stderr.split("\n").filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr,
    asked: lines("CHOOSE ").map(line => JSON.parse(line)),
    names: lines("ASK ").map(line => JSON.parse(line)),
    rejected: lines("REJECT "),
    record: run ? JSON.parse(run.slice(4)) : null,
    fork: fork ? JSON.parse(fork.slice(5)) as string[] : null,
  };
}
const seatedHarn = () => enroll({ harn: seatedLive("harn") });

// Count work at the choice boundary rather than asserting a host-dependent deadline.
function observedMenu(keys: string[], args = ["claude", "harn"], extra: NodeJS.ProcessEnv = {}) {
  const run = spawnSync("bun", [join(import.meta.dir, "support/launch-menu-observed.ts"), keys.join(","), ...args], {
    cwd, env: { ...env, PATH: `${join(root, "bin")}:${env.PATH}`, ...extra }, encoding: "utf8", timeout: 30_000,
  });
  const menus = run.stdout.split("\n").filter(line => line.startsWith("MENU ")).map(line => JSON.parse(line.slice(5)));
  return { ...run, menus };
}

test("live collision: menu defers process, native-store, sibling and lifecycle work", () => {
  enroll({ harn: seatedLive("harn", "claude", { harness_session_id: "missing-chat" }) });
  try {
    const out = observedMenu(["q"]);
    expect(out.status).toBe(2);
    expect(out.menus).toHaveLength(1);
    const events: string[] = out.menus[0].events;
    expect(events.some(event => event === "native-store" || event.startsWith("ps "))).toBe(false);
    expect(events.filter(event => event.startsWith("tmux "))).toHaveLength(1);
    expect(events.filter(event => event.startsWith("tmux "))[0]).toContain("list-sessions");
    expect(events.some(event => /startup-trace|lifecycle/.test(event))).toBe(false);
    expect(out.menus[0].options.find((option: string[]) => option[0] === "f")[3]).toBeUndefined();
    expect(out.stdout).not.toContain("RUN ");
  } finally { enroll(); }
});

test("live collision: r uses qualified attach-only without starting or registering a seat", () => {
  enroll({ harn: seatedLive("harn") });
  try {
    const out = observedMenu(["r"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("ATTACH fixture/harn");
    expect(out.stdout).not.toContain("RUN ");
  } finally { enroll(); }
});

test("live collision: a real attach refusal renders cleanly at the module boundary", () => {
  enroll({ harn: seatedLive("harn", "claude", { status: "suspended", status_reason: "incapable" }) });
  try {
    const out = observedMenu(["r"], ["claude", "harn"], { SCRIPTED_REAL_ATTACH: "1" });
    expect(out.status).toBe(1);
    expect(out.stderr.trim().split("\n")).toHaveLength(1);
    expect(out.stderr).toContain("suspended (incapable)");
    expect(out.stderr).not.toContain(" at ");
    expect(out.stdout).not.toContain("RUN ");
  } finally { enroll(); }
});

test("live-name collision: r finding a shell asks again before any replacement", () => {
  enroll({ shelly: seatedLive("shelly") });
  try {
    const out = observedMenu(["r", "q"], ["claude", "shelly"]);
    expect(out.status).toBe(2);
    expect(out.menus).toHaveLength(2);
    expect(out.menus[1].question).toContain("unattended shell");
    expect(out.stdout).not.toContain("RUN ");
    expect(out.stdout).not.toContain("ATTACH ");
    expect(tmux("has-session", "-t", "=fixture/shelly").status).toBe(0);
  } finally { enroll(); }
});

test("scripted: [q] launches nothing and exits 2", () => {
  seatedHarn();
  try {
    const out = scripted(["q"], ["claude", "harn"]);
    expect(out.status).toBe(2);
    expect(out.record).toBeNull();
    expect(out.asked).toHaveLength(1);
  } finally { enroll(); }
});

// tap-wj35h: --json never opens the chooser, even on a terminal; the collision refuses
// with its structured error, so stdout is exactly one JSON object and nothing launches.
test("scripted: --json on a terminal refuses a collision without asking", () => {
  seatedHarn();
  try {
    for (const extra of [{}, { TAP_JSON: "1" }]) {
      const out = scripted(["f", "n", "k"], ["claude", "harn", ...("TAP_JSON" in extra ? [] : ["--json"])], extra);
      expect(out.status).toBe(2);
      expect(out.stderr).toBe("");
      expect(out.asked).toEqual([]);
      expect(out.names).toEqual([]);
      expect([out.record, out.fork]).toEqual([null, null]);
      const lines = out.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error_class: "session_exists", action: "tap session resume harn" });
    }
  } finally { enroll(); }
});

// A flag that only chooses the representation must not authorize replacing a session: on a terminal
// --json refuses the shell collision, where a no-terminal launch reseats it.
test("scripted: --json on a terminal refuses an unattended-shell collision instead of reseating it", () => {
  const out = scripted(["k"], ["claude", "shelly", "--json"]);
  expect([out.status, out.stderr, out.asked, out.record]).toEqual([2, "", [], null]);
  const lines = out.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error_class: "session_exists" });
});

test("scripted: [n] on a live seat launches the next free sibling", () => {
  seatedHarn();
  try {
    const out = scripted(["n", "="], ["claude", "harn"]);
    expect(out.status).toBe(0);
    expect(out.names).toEqual([{ question: "Enter a name for the new session: ", prefix: "harn-", suffix: "2" }]);
    expect(out.record).toMatchObject({ name: "fixture/harn-2", tag: "harn", index: 2, kill_backup_required: false, replaces_session: null });
  } finally { enroll(); }
});

test("scripted: [k] on a live seat carries stop-by-name authority and the replaced record", () => {
  enroll({ harn: seatedLive("harn", "claude", { harness_session_id: "prior-id" }) });
  try {
    const out = scripted(["k"], ["claude", "harn"]);
    expect(out.status).toBe(0);
    expect(out.record).toMatchObject({ name: "fixture/harn", kill_backup_required: true, replaces_session: "fixture/harn",
      replaces_manifest_session: "fixture/harn", replacement_record: { name: "fixture/harn", harness_session_id: "prior-id" } });
    expect(out.record.history).toContain("prior-id");
    expect(out.record.harness_session_id).not.toBe("prior-id");
  } finally { enroll(); }
});

test("scripted: [r] on an unattended shell reseats fresh under the name", () => {
  const out = scripted(["r"], ["claude", "shelly"]);
  expect(out.status).toBe(0);
  expect(out.asked[0].options[0][2]).toBe("Nothing to resume; start fresh");
  expect(out.record).toMatchObject({ name: "fixture/shelly", kill_backup_required: true, replaces_session: "fixture/shelly" });
});

test("scripted: [k] on a gone row narrates the reclaimed row", () => {
  enroll({ scout: gone("scout") });
  try {
    const out = scripted(["k"], ["claude", "scout"]);
    expect(out.status).toBe(0);
    expect(out.record.ensure_receipts).toEqual(["reclaimed dead seat row 'scout' (fixture/scout:0.0)"]);
    expect(out.stdout + out.stderr).toContain("reclaimed dead seat row 'scout' (fixture/scout:0.0)");
  } finally { enroll(); }
});

test("scripted: [r] on a gone row with a record hands off to resume, which refuses new tuning", () => {
  enroll({ scout: gone("scout") });
  try {
    const out = scripted(["r"], ["claude", "scout", "--model", "opus"]);
    expect(out.status).toBe(2);
    expect(out.record).toBeNull();
    expect(out.stderr).toContain("cannot apply to the collision chooser's resume arm");
  } finally { enroll(); }
});

test("scripted: [n] on a live off-roster harness takes the suffix", () => {
  const out = scripted(["n", "="], ["claude", "harn"]);
  expect(out.status).toBe(0);
  expect(out.asked[0].fallback).toBe("n");
  expect(out.record).toMatchObject({ name: "fixture/harn-2", index: 2 });
});

// tap-ibmoe: [n] asks for the name (the allocated suffix is the default) and
// [f] forks through `tap session fork`, enabled only when a fork can succeed.
const forkRow = (out: ReturnType<typeof scripted>) => out.asked[0].options.find((option: string[]) => option[0] === "f");

test("scripted: [n] takes a typed sibling number or a custom name as its own seat", () => {
  seatedHarn();
  try {
    expect(scripted(["n", "harn-5"], ["claude", "harn"]).record).toMatchObject({ name: "fixture/harn-5", tag: "harn", index: 5 });
    expect(scripted(["n", "scout"], ["claude", "harn"]).record).toMatchObject({ name: "fixture/scout", tag: "scout", index: 1 });
    // Not exactly the numbered sibling: its own seat, never the incumbent's handle.
    expect(scripted(["n", "harn-0"], ["claude", "harn"]).record).toMatchObject({ name: "fixture/harn-0", tag: "harn-0", index: 1 });
  } finally { enroll(); }
});

// The allocator sanitizes a dotted handle (review.er → review-er) without a
// numbered suffix; that name is a seat of its own, never the incumbent's handle.
test("scripted: a sanitized allocation launches under its own handle, asked or not", () => {
  enroll({ "review.er": gone("review.er") });
  try {
    const asked = scripted(["n", "="], ["claude", "review.er"]);
    expect(asked.names).toEqual([{ question: "Enter a name for the new session: ", prefix: "", suffix: "review-er" }]);
    expect(asked.record).toMatchObject({ name: "fixture/review-er", tag: "review-er", index: 1 });
    expect(scripted([], ["claude", "review.er", "--new"]).record).toMatchObject({ name: "fixture/review-er", tag: "review-er", index: 1 });
  } finally { enroll(); }
});

test("scripted: [n] re-asks with the reason for an invalid or taken name", () => {
  seatedHarn();
  try {
    const out = scripted(["n", "bad name", "harn", "codex", "7", "help", "user", "ok-name"], ["claude", "harn"]);
    expect(out.status).toBe(0);
    expect(out.rejected).toEqual(["'bad name' must use letters, digits, '.', '_' or '-'", "'harn' is taken",
      "'codex' names a harness; choose a seat name", "'7' is a resume index; a new name needs a letter",
      "'help' is reserved as the CLI help keyword", "'user' is the reserved operator identity"]);
    expect(out.record).toMatchObject({ name: "fixture/ok-name", tag: "ok-name" });
  } finally { enroll(); }
});

// A leftover record off the roster does not hold its name; a direct launch ignores it too.
test("scripted: a typed name may reuse a leftover off-roster record's name", () => {
  enroll({ harn: seatedLive("harn"), scout: { ...gone("scout"), pane_id: "", status: "pending", boot_id: "boot:1" } });
  try {
    const out = scripted(["n", "scout"], ["claude", "harn"]);
    expect(out.rejected).toEqual([]);
    expect(out.record).toMatchObject({ name: "fixture/scout", tag: "scout", index: 1 });
  } finally { enroll(); }
});

test("scripted: Esc at the name prompt quits with nothing launched", () => {
  seatedHarn();
  try {
    const out = scripted(["n", "ESC"], ["claude", "harn"]);
    expect(out.status).toBe(2);
    expect(out.record).toBeNull();
  } finally { enroll(); }
});

test("scripted: --new keeps the allocated suffix without asking", () => {
  seatedHarn();
  try {
    const out = scripted([], ["claude", "harn", "--new"]);
    expect(out.names).toEqual([]);
    expect(out.record).toMatchObject({ name: "fixture/harn-2", index: 2 });
  } finally { enroll(); }
});

test("scripted: [f] discloses row-only refusals before native conversation validation", () => {
  const cases: [string, () => void, string[], (string | boolean)[]][] = [
    ["codex seat with a stored id", () => enroll({ harn: seatedLive("harn", "codex", { harness_session_id: "sid-1" }) }), ["claude", "harn"],
      ["f", "fork", "Fork a new session with this history"]],
    ["claude seat with no stored id", seatedHarn, ["claude", "harn"], ["f", "fork", "No saved chat to fork", true]],
    // planFork refuses a stored conversation-selecting flag, so [f] says so up front.
    ["claude seat storing --resume", () => enroll({ harn: seatedLive("harn", "claude", { passthrough: ["--resume", "old-id"] }) }),
      ["claude", "harn"], ["f", "fork", "Uses --resume", true]],
    ["claude seat storing --resume=<controls>", () => enroll({ harn: seatedLive("harn", "claude", { passthrough: ["--resume=\u001b[2Jold"] }) }),
      ["claude", "harn"], ["f", "fork", "Uses --resume", true]],
    ["cursor seat", () => enroll({ harn: seatedLive("harn", "cursor", { harness_session_id: "sid-1" }) }), ["claude", "harn"],
      ["f", "fork", "Harness cannot fork", true]],
    ["agy seat", () => enroll({ harn: seatedLive("harn", "agy", { harness_session_id: "sid-1" }) }), ["claude", "harn"],
      ["f", "fork", "Harness cannot fork", true]],
    ["off-roster tmux session", () => enroll(), ["claude", "harn"], ["f", "fork", "Not a TAP seat", true]],
    ["unattended shell", () => enroll(), ["claude", "shelly"], ["f", "fork", "Not a TAP seat", true]],
    ["gone row", () => enroll({ scout: gone("scout") }), ["claude", "scout"], ["f", "fork", "No saved chat to fork", true]],
  ];
  for (const [title, setup, args, row] of cases) {
    setup();
    try {
      const out = scripted(["q"], args);
      expect([title, forkRow(out)]).toEqual([title, row]);
      const keys = out.asked[0].options.map((option: string[]) => option[0]);
      expect([title, keys.indexOf("f")]).toEqual([title, keys.indexOf("n") + 1]);
      expect(out.asked[0].options.find((option: string[]) => option[0] === "k")[1]).toBe("kill");
    } finally { enroll(); }
  }
});

test("scripted: [f] asks for the fork's name and runs tap session fork", () => {
  enroll({ harn: seatedLive("harn", "codex", { harness_session_id: "sid-1" }) });
  try {
    const out = scripted(["f", "="], ["claude", "harn"]);
    expect(out.status).toBe(0);
    expect(out.names).toEqual([{ question: "Enter a name for the fork: ", prefix: "harn-", suffix: "fork" }]);
    expect(out.fork).toEqual(["--", "harn", "harn-fork"]);
    // The checked source travels with the fork, which refuses any other.
    const source = JSON.parse(out.stdout.split("\n").find(line => line.startsWith("FORK_SOURCE "))!.slice(12));
    expect(source).toEqual(["codex", "sid-1", "fixture/harn", null, "sid-1"]);
    expect(out.record).toBeNull();
    const custom = scripted(["f", "harn", "side-quest"], ["claude", "harn"]);
    expect(custom.rejected).toEqual(["'harn' is taken"]);
    expect(custom.fork).toEqual(["--", "harn", "side-quest"]);
  } finally { enroll(); }
});

test("scripted: [f] refuses a source that changed while its name was being typed", () => {
  enroll({ harn: seatedLive("harn", "codex", { harness_session_id: "sid-1" }) });
  try {
    const replaced = JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: cwd },
      seats: { harn: seatedLive("harn", "codex", { harness_session_id: "sid-2" }) } });
    const out = scripted(["f", "="], ["claude", "harn"], { SCRIPTED_ON_ASK_PATH: registry, SCRIPTED_ON_ASK_BYTES: replaced });
    expect([out.fork, out.record]).toEqual([null, null]);
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toContain("was cleared, restarted or replaced while the fork was being chosen");
  } finally { enroll(); }
});

// An unchanged row can resolve to a different claude conversation when a transcript
// appears mid-prompt (hsid wins over the transcript_path fallback once it exists).
test("scripted: [f] refuses when the offered conversation's fallback changes mid-prompt", () => {
  const claudeHome = join(root, "claude-home");
  mkdirSync(join(claudeHome, "projects/p"), { recursive: true });
  writeFileSync(join(claudeHome, "projects/p/tp-1.jsonl"), "{}\n");
  enroll({ harn: seatedLive("harn", "claude", { harness_session_id: "hs-1", transcript_path: join(claudeHome, "projects/p/tp-1.jsonl") }) });
  try {
    const out = scripted(["f", "="], ["claude", "harn"], { TAP_CLAUDE_HOME: claudeHome,
      SCRIPTED_ON_ASK_PATH: join(claudeHome, "projects/p/hs-1.jsonl"), SCRIPTED_ON_ASK_BYTES: "{}\n" });
    expect(forkRow(out)).toEqual(["f", "fork", "Fork a new session with this history"]);
    expect([out.fork, out.record]).toEqual([null, null]);
    expect(out.stdout + out.stderr).toContain("was cleared, restarted or replaced while the fork was being chosen");
  } finally { enroll(); rmSync(claudeHome, { recursive: true, force: true }); }
});

test("scripted: [f] never starts anything when the fork is unavailable, quit, or tuned", () => {
  seatedHarn();
  try {
    const unavailable = scripted(["f"], ["claude", "harn"]);
    expect(unavailable.status).not.toBe(0);
    expect([unavailable.fork, unavailable.record]).toEqual([null, null]);
    expect(unavailable.stderr).toContain("no saved chat to fork");
  } finally { enroll(); }
  enroll({ harn: seatedLive("harn", "codex", { harness_session_id: "sid-1" }) });
  try {
    const quit = scripted(["f", "ESC"], ["claude", "harn"]);
    expect([quit.status, quit.fork, quit.record]).toEqual([2, null, null]);
    const tuned = scripted(["f", "="], ["claude", "harn", "--model", "opus"]);
    expect([tuned.fork, tuned.record, tuned.names]).toEqual([null, null, []]);
    expect(tuned.stderr).toContain("cannot apply to the collision chooser's fork arm: a fork replays its source's recipe");
  } finally { enroll(); }
});

// A failed resume's rollback leaves the row suspended with its chat id intact. Only a named resume
// may relaunch such a row, so it is off state.sessions; the ladder must still see its record.
const RETRY_REASONS = ["pane_gone", "session_replaced", "repair_failed", "restart_failed"];
const retained = (reason: string, row: Record<string, unknown>) =>
  ({ ...row, delivery: "pane", status: "suspended", status_reason: reason, harness_session_id: "retained-id", history: ["older-id"] });
// A stopped row has no pane to observe; a gone row's recorded pane is observed dead.
const stoppedRow = { harness: "claude", session: "fixture/scout" };
const menuGloss = (out: ReturnType<typeof scripted>, key: string) => out.asked[0].options.find((option: string[]) => option[0] === key)?.[2];
// A Claude store that really holds the retained chat, so the exact tier is earned from its transcript.
function claudeStoreWithChat(): NodeJS.ProcessEnv {
  const home = join(root, "claude-store");
  mkdirSync(join(home, "projects/fixture"), { recursive: true });
  writeFileSync(join(home, "projects/fixture/retained-id.jsonl"), "{}\n");
  return { TAP_CLAUDE_HOME: home };
}

for (const reason of RETRY_REASONS) {
  test(`scripted: a ${reason} row's chooser offers its stored chat, stopped or gone`, () => {
    for (const [row, question] of [[stoppedRow, "'fixture/scout' already exists (claude)"],
      [gone("scout"), "a gone seat row (fixture/scout:0.0)"]] as const) {
      enroll({ scout: retained(reason, row) });
      try {
        const out = scripted(["q"], ["claude", "scout"], claudeStoreWithChat());
        expect([out.status, out.record]).toEqual([2, null]);
        expect(out.asked).toHaveLength(1);
        expect(out.asked[0].question).toContain(question);
        expect(menuGloss(out, "r")).toBe("Resume the chat by its native ID");
        expect(forkRow(out)).toEqual(["f", "fork", "Fork a new session with this history"]);
      } finally { enroll(); }
    }
  });

  // The resume arm refuses new tuning before any effect, which [k] never does: the refusal proves the arm.
  test(`scripted: [r] on a gone ${reason} row stays resume, never a fresh reseat`, () => {
    enroll({ scout: retained(reason, gone("scout")) });
    try {
      const out = scripted(["r"], ["claude", "scout", "--model", "opus"]);
      expect([out.status, out.record]).toEqual([2, null]);
      expect(out.stderr).toContain("cannot apply to the collision chooser's resume arm");
    } finally { enroll(); }
  });

  test(`scripted: [k] and --fresh on a ${reason} row keep its chat in history and the replaced record`, () => {
    enroll({ scout: retained(reason, gone("scout")) });
    try {
      const store = claudeStoreWithChat();
      for (const out of [scripted(["k"], ["claude", "scout"], store), scripted([], ["claude", "scout", "--fresh"], store)]) {
        expect(out.status).toBe(0);
        expect(out.record.history).toEqual(["older-id", "retained-id"]);
        expect(out.record).toMatchObject({ name: "fixture/scout", replaces_session: "fixture/scout", replaces_manifest_session: "fixture/scout",
          replacement_record: { name: "fixture/scout", harness_session_id: "retained-id" } });
        expect(out.record.harness_session_id).not.toBe("retained-id");
        expect(out.record.ensure_receipts).toContain("reseated fixture/scout fresh (previous claude conversation retained-id kept in history)");
      }
    } finally { enroll(); }
  });
}

test("scripted: a retained row's tier still reads its stored chat's truth", () => {
  enroll({ scout: { ...retained("repair_failed", stoppedRow), transcript_path: join(root, "lost.jsonl") } });
  try { expect(menuGloss(scripted(["q"], ["claude", "scout"]), "r")).toBe("No usable ID; open the native picker"); }
  finally { enroll(); }
  // No projects directory at all: [r] finds no transcript to target, so it opens the picker and must say so.
  // [k] still keeps the id in history, but does not claim a resumable conversation.
  enroll({ scout: retained("repair_failed", stoppedRow) });
  try {
    const noStore = { TAP_CLAUDE_HOME: join(root, "no-claude-store") };
    expect(menuGloss(scripted(["q"], ["claude", "scout"], noStore), "r")).toBe("No usable ID; open the native picker");
    const replaced = scripted(["k"], ["claude", "scout"], noStore);
    expect(replaced.record.history).toEqual(["older-id", "retained-id"]);
    expect(replaced.record.ensure_receipts.join("\n")).not.toContain("kept in history");
  } finally { enroll(); }
  enroll({ scout: retained("repair_failed", { ...stoppedRow, harness: "cursor" }) });
  try { expect(menuGloss(scripted(["q"], ["cursor", "scout"]), "r")).toBe("Chat never persisted; resume refuses"); }
  finally { enroll(); }
});

test("scripted: a retained row is a seat, so its launch never takes the leftover-record notice", () => {
  enroll({ scout: retained("repair_failed", stoppedRow) });
  try { expect(scripted(["q"], ["claude", "scout"]).stderr).not.toContain("ignoring leftover record"); }
  finally { enroll(); }
});

test("a retained row held by another harness's shell refuses, as a recorded seat does", () => {
  enroll({ shelly: seatedLive("shelly", "codex", retained("repair_failed", {})) });
  try {
    const out = scripted([], ["claude", "shelly", "--dry-run"]);
    expect([out.status, out.record]).toEqual([2, null]);
    expect(out.stderr).toContain("fixture/shelly already exists");
  } finally { enroll(); }
});

test("a retained row's record costs the live menu no tmux probe per sibling", () => {
  enroll({ harn: seatedLive("harn", "claude", retained("repair_failed", {})), sibling: gone("sibling"), other: gone("other") });
  try {
    const out = observedMenu(["q"]);
    expect(out.status).toBe(2);
    const tmuxEvents = out.menus[0].events.filter((event: string) => event.startsWith("tmux "));
    expect(tmuxEvents).toHaveLength(1);
    expect(tmuxEvents[0]).toContain("list-sessions");
  } finally { enroll(); }
});

// [r] here can only start fresh, and says so: each row below has nothing a resume could recover.
for (const [title, row] of [
  ["a row with no session to record", { ...retained("pane_gone", gone("scout")), session: "" }],
  ["a user_removed row", retained("user_removed", gone("scout"))],
] as const) {
  test(`scripted: ${title} keeps the fresh gloss, and [r] reseats without history`, () => {
    enroll({ scout: row });
    try {
      const out = scripted(["r"], ["claude", "scout"]);
      expect(out.status).toBe(0);
      expect(menuGloss(out, "r")).toBe("Nothing to resume; start fresh");
      expect(out.record).toMatchObject({ name: "fixture/scout", kill_backup_required: true, replacement_record: null, replaces_manifest_session: null, history: [] });
    } finally { enroll(); }
  });
}

test("a stopped row reports absent tmux and directs a fresh launch without losing the row", () => {
  enroll({ scout: gone("scout") });
  // The launch prerequisite check runs before the collision refusal, so claude must resolve on PATH (the CI runner has none).
  const result = spawnSync(process.execPath, [native, "claude", "scout", "--json"], { cwd, env: { ...env, PATH: `${join(root, "bin")}:${env.PATH}` }, encoding: "utf8" });
  expect(result.status).toBe(2);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.detail).toContain("no live tmux session");
  expect(receipt.detail).not.toContain("already exists");
  expect(receipt.action).toBe("tap session launch claude scout --fresh");
  expect(JSON.parse(readFileSync(registry, "utf8")).seats.scout).toEqual(gone("scout"));
});


for (const tail of [["--typo", "--preset", "rev"], ["--effort", "high", "--verbose"]]) test(`JSON passthrough refusal has no warning prose: ${tail.join(" ")}`, () => {
  enroll();
  const result = spawnSync(process.execPath, [native, "claude", "scout", "--json", ...tail], { cwd, env, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(result.stderr).toBe("");
});

test("a session gone after the initial snapshot gets the stopped-record diagnosis", () => {
  enroll({ scout: gone("scout") });
  const shim = join(root, "vanishing-bin");
  mkdirSync(shim);
  const marker = join(shim, "observed");
  const realTmux = Bun.which("tmux")!;
  writeFileSync(join(shim, "tmux"), `#!/bin/sh\ncase "$*" in *list-sessions*) if [ ! -e '${marker}' ]; then touch '${marker}'; printf 'fixture/scout\\n'; fi;; esac\nexec '${realTmux}' "$@"\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [native, "claude", "scout", "--json"], { cwd, env: { ...env, PATH: `${shim}:${join(root, "bin")}:${env.PATH}`, TAP_JSON: "1" }, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error_class).toBe("session_record_exists");
  expect(JSON.parse(readFileSync(registry, "utf8")).seats.scout).toEqual(gone("scout"));
});
