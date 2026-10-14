import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The shipped door (bin/tap) reaches the native verbs, with every state root pinned to scratch.
const root = resolve(import.meta.dir, "../../..");
const entry = join(root, "bin/tap");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "pick-route-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string) {
  const base = join(dir, name), index = join(base, "index"), home = join(base, "home"), trace = join(base, "trace");
  mkdirSync(index, { recursive: true }); mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_INDEX_HOME: index, TAP_BUN_ROUTE_TRACE: trace,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"), OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"), TAP_ONBOARDING_CHECKED: "1" };
  for (const k of ["TAP_HOME", "TMUX", "TMUX_PANE", "TAP_SELF", "XDG_CONFIG_HOME", "TAP_JSON"]) delete env[k];
  return { base, index, home, trace, env };
}
const tap = (env: NodeJS.ProcessEnv, ...argv: string[]) => spawnSync("bash", [entry, ...argv], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });

test("tap pick --list --json is native, read-only and machine-readable; a broken team is reported, not hidden", () => {
  const f = fixture("list");
  const good = join(f.base, "good"), bad = join(f.base, "bad");
  for (const d of [good, bad]) mkdirSync(join(d, ".tap"), { recursive: true });
  const goodRegistry = join(good, ".tap/team-registry.json"), badRegistry = join(bad, ".tap/team-registry.json");
  writeFileSync(goodRegistry, JSON.stringify({ schema: "0.20", team: { name: "good" }, seats: { poller: { delivery: "poll", status: "active" } } }));
  writeFileSync(badRegistry, "{not json");
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    good: { root: good, registry_location: goodRegistry, state: "registered" },
    bad: { root: bad, registry_location: badRegistry, state: "registered" } } }));
  const r = tap(f.env, "pick", "--list", "--json");
  expect(r.status, r.stderr).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.seats).toEqual([]);                         // a poll-mode row is infrastructure, never offered
  expect(parsed.skipped).toEqual([{ team: "bad", state: "corrupt", detail: "acting registry is not valid JSON" }]);
  expect(readFileSync(f.trace, "utf8")).toBe("native pick\n");
});

test("tap pick without a machine index refuses with the standard error, JSON and human", () => {
  const f = fixture("noindex");
  const r = tap(f.env, "pick", "--list", "--json");
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  const human = tap(f.env, "pick", "--list");
  expect(human.status).toBe(1);
  expect(human.stderr).toMatch(/^tap pick: .*; next: /);
});

test("tap pick with seats listed but no terminal never opens a picker", () => {
  const f = fixture("noterminal");
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const r = tap(f.env, "pick");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("tap pick:");
  expect(r.stdout).toBe("");
});

test("tap keybinding status/install/remove ride the shipped door and touch only the scratch HOME", () => {
  const f = fixture("kb");
  const tmuxTmp = process.env.TMUX_TMPDIR;
  expect(tmuxTmp, "run through runtime/bun/test/run.sh").toBeTruthy();
  const env = { ...f.env, TAP_TMUX_SOCKET: `route-${process.pid}` };
  const before = tap(env, "keybinding", "status", "--json");
  expect(before.status, before.stderr).toBe(0);
  expect(JSON.parse(before.stdout)).toMatchObject({ ok: true, installed: false });
  const fakeTap = join(f.base, "tap");
  writeFileSync(fakeTap, "#!/bin/sh\n", { mode: 0o755 });
  const install = tap(env, "keybinding", "install", "--tap", fakeTap);
  expect(install.status, install.stderr).toBe(0);
  expect(readFileSync(join(f.home, ".tmux.conf"), "utf8")).toContain("# tap-keybinding");
  expect(JSON.parse(tap(env, "keybinding", "status", "--json").stdout)).toMatchObject({ installed: true, key: "C-g" });
  expect(tap(env, "keybinding", "remove").status).toBe(0);
  expect(readFileSync(join(f.home, ".tmux.conf"), "utf8")).toBe("");
  expect(readFileSync(f.trace, "utf8").split("\n").filter(Boolean).every(l => l === "native keybinding")).toBe(true);
  const bad = tap(env, "keybinding", "bogus");
  expect(bad.status).toBe(1);
  expect(bad.stderr).toMatch(/^tap keybinding: .*; next: tap help keybinding/);
});

test("help pages are served for both verbs, with the documented sections", () => {
  const f = fixture("help");
  for (const verb of ["pick", "keybinding"]) {
    const page = tap(f.env, "help", verb);
    expect(page.status).toBe(0);
    for (const section of ["NAME\n", "USAGE\n", "EXAMPLES\n", "EXIT CODES\n"]) expect(page.stdout).toContain(section);
    expect(tap(f.env, verb, "--help").stdout).toBe(page.stdout);
  }
});
