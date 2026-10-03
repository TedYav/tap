import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "../src/launcher/catalog-listing";

/**
 * Every top-level table TAP itself writes or reads is known to the launcher's
 * catalog parse, so a first `tap launch` after `tap setup --machine` is silent;
 * a genuine typo still gets the notice and the did-you-mean.
 *
 * The census (writers: `tap setup --machine` via verbs/machine-choices.ts and
 * `tap config set`; readers: the per-feature modules named below):
 *   catalog      version presets notes harness roles intelligences
 *   recovery     recovery-policy.ts
 *   delivery     digest-window.ts      ([delivery.overrides."team/handle"])
 *   sentinel     sentinel-preview.ts
 *   tmux         launcher/tmux-bootstrap.ts
 *   diagnostics  lifecycle-diagnostics.ts
 *   notifications notifications.ts + the wizard
 *   injection    injection-behavior.ts + the wizard   (was warned about)
 *   onboarding   onboarding.ts + the wizard           (was warned about)
 *   skills       skill-policy.ts + the wizard         (was warned about)
 */
const TAP_TABLES = ["recovery", "delivery", "sentinel", "tmux", "diagnostics", "notifications",
  "injection", "onboarding", "skills"];
const WIZARD_TABLES = ["presets", "harness", "notifications", "injection", "onboarding", "skills"];

const bin = resolve(import.meta.dir, "../../../bin/tap");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/tap-config-tables-"));
  roots.push(root);
  const index = join(root, "index"), registry = join(root, "relocated.json");
  for (const dir of [index, join(root, ".tap/bus"), join(root, ".config/tap"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: join(root, ".tap/bus"), TAP_INSTALL_BIN: join(root, "bin"), TAP_SETUP_OPEN_GUIDE: "0",
    TAP_TMUX_SOCKET: `cfgtables-${process.pid}`, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR"]) delete env[key];
  const config = join(root, ".config/tap/config.toml");
  const run = (args: string[]) => spawnSync("bash", [bin, ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
  const wizard = () => {
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ harnesses: { claude: { presets: "simple", permissions: "bypass" } }, starterEffort: "high",
      fullKit: true, onboarding: { init: "auto" }, injection: { behavior: "wait" },
      notifications: { notifier: "command", command: ["echo", "{body}"] }, write: "apply" }));
    return run(["setup", "--machine", "--answers", answers, "--json"]);
  };
  const launch = () => run(["session", "launch", "claude", "reviewer", "--dry-run"]);
  return { root, config, wizard, launch };
}

const DEGRADE = /tap config: .* in .*config\.toml — ignoring it and continuing/;

test("the wizard's full config writes every census table and launches without a degrade notice", () => {
  const f = fixture();
  const setup = f.wizard();
  expect(setup.status, setup.stderr + setup.stdout).toBe(0);
  const written = Bun.TOML.parse(readFileSync(f.config, "utf8")) as Record<string, unknown>;
  // The fixture must be the COMPLETE writer output, or a table the wizard later adds slips through unchecked.
  for (const table of WIZARD_TABLES) expect(Object.keys(written), `wizard no longer writes [${table}]`).toContain(table);
  const launch = f.launch();
  expect(launch.status, launch.stderr).toBe(0);
  expect(launch.stderr).not.toMatch(DEGRADE);
  expect(launch.stderr).not.toContain("unknown top-level table");
});

test("a typo of a TAP table still gets the notice and the did-you-mean", () => {
  const f = fixture();
  expect(f.wizard().status).toBe(0);
  appendFileSync(f.config, "\n[injectoin]\nbehavior = \"wait\"\n");
  const launch = f.launch();
  expect(launch.status, launch.stderr).toBe(0);
  expect(launch.stderr).toContain("unknown top-level table 'injectoin' (did you mean 'injection'?)");
  expect(launch.stderr.match(/unknown top-level table/g)).toHaveLength(1);
});

test("every table TAP reads is silent in the catalog parse, and an unrelated table is not", () => {
  const notices: string[] = [];
  const body = `version = 3\n${TAP_TABLES.map(t => `[${t}]\nx = 1\n`).join("")}[delivery.overrides."team/handle"]\nwindow = 5\n`;
  parseDocument(Buffer.from(body), "config.toml", message => notices.push(message));
  expect(notices).toEqual([]);
  parseDocument(Buffer.from("version = 3\n[futuretable]\nx = 1\n"), "config.toml", message => notices.push(message));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("unknown top-level table 'futuretable'");
});
