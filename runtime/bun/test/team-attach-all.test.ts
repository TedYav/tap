import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "team-attach-all."))); roots.push(root);
  const bin = join(root, "bin"), index = join(root, "index");
  mkdirSync(bin); mkdirSync(index);
  const teams: Record<string, unknown> = {};
  for (const [team, handles] of [["alpha", ["one", "two"]], ["beta", ["remote"]]] as const) {
    const dir = join(root, team); mkdirSync(join(dir, ".tap", "bus"), { recursive: true });
    const registry = join(dir, ".tap", "team-registry.json");
    const seats = Object.fromEntries(handles.map(handle => [handle, { status: "active", harness: "claude", delivery: "pane", session: `${team}/${handle}`, registered_from_worktree: dir, base: team, tag: handle, index: 1 }]));
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: dir }, seats }));
    teams[team] = { root: dir, registry_location: registry, state: "registered" };
  }
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams, migrated: {} }));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-panes) printf 'alpha/one\\t0\\nalpha/two\\t0\\nbeta/remote\\t0\\n';;
 list-clients) case "$3" in =alpha/one|=beta/remote) printf '/dev/existing\\n';; esac;;
 display-message) printf '/tmp/test-socket\\n';;
 *) exit 1;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAP_INDEX_HOME: index, TAP_HOME: join(root, "alpha/.tap/bus") };
  const run = (args: string[], bash = false) => spawnSync(bash ? "bash" : process.execPath,
    bash ? [resolve(import.meta.dir, "../../../bin/tap"), "team", "attach", ...args] : [resolve(import.meta.dir, "../main.ts"), "team", "attach", ...args],
    { cwd: join(root, "alpha"), env, encoding: "utf8" });
  return { root, bin, run };
}

test("--all includes existing viewers while default and seat filters stay selective", () => {
  const f = fixture();
  for (const bash of [false, true]) {
    const normal = f.run(["--dry-run"], bash);
    expect(normal.status).toBe(0); expect(normal.stdout).toContain("1 new viewer(s)");
    expect(normal.stdout).toContain("skipped because already attached: one (/dev/existing)");
    const all = f.run(["--all", "--dry-run"], bash);
    expect(all.status).toBe(0); expect(all.stdout).toContain("2 new viewer(s)");
    expect(all.stdout).toContain("skipped because already attached: none");
    const selected = f.run(["--all", "--only", "one", "--dry-run"], bash);
    expect(selected.status).toBe(0); expect(selected.stdout).toContain("1 new viewer(s)");
    expect(selected.stdout).toContain("=alpha/one");
    const excepted = f.run(["--all", "--except", "one", "--dry-run"], bash);
    expect(excepted.status).toBe(0); expect(excepted.stdout).toContain("1 new viewer(s)");
  }
});

test("named team overrides caller team and uses its directory and handle selection", () => {
  const f = fixture();
  for (const bash of [false, true]) {
    const normal = f.run(["beta", "--dry-run"], bash);
    expect(normal.status).toBe(0); expect(normal.stdout).toContain("all 1 live seat(s) were already attached");
    const all = f.run(["beta", "--all", "--only", "remote", "--dry-run"], bash);
    expect(all.status).toBe(0); expect(all.stdout).toContain("plan for team 'beta' (1 new viewer(s))");
    expect(all.stdout).toContain("=beta/remote"); expect(all.stdout).toContain(join(f.root, "beta"));
    expect(all.stdout).not.toContain("=alpha/");
    expect(f.run(["beta", "--only", "one", "--dry-run"], bash).status).not.toBe(0);
    expect(f.run(["missing", "--dry-run"], bash).status).not.toBe(0);
    expect(f.run(["alpha", "beta", "--dry-run"], bash).status).not.toBe(0);
  }
});

test("--all still requires a new client and does not count an existing viewer as success", () => {
  const f = fixture();
  writeFileSync(join(f.bin, "osascript"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
  const before = readFileSync(join(f.root, "alpha/.tap/team-registry.json"), "utf8");
  const run = f.run(["--all", "--only", "one"]);
  expect(run.status).toBe(1); expect(run.stderr).toContain("a new tmux client was not observed");
  expect(readFileSync(join(f.root, "alpha/.tap/team-registry.json"), "utf8")).toBe(before);
});

test("named team pins its socket for catalog, probes, script and fallback; mixed selection refuses", () => {
  const f = fixture();
  const registry = join(f.root, "beta/.tap/team-registry.json");
  const doc = JSON.parse(readFileSync(registry, "utf8"));
  const socket = join(f.root, "beta-socket");
  doc.seats.remote.server_socket = socket;
  writeFileSync(registry, JSON.stringify(doc));
  writeFileSync(join(f.bin, "tmux"), `#!/bin/sh
[ "$1" = -S ] && [ "$2" = '${socket}' ] || exit 1
shift 2
case "$1" in
 list-panes) printf 'beta/remote\\t0\\n';;
 list-clients) printf '/dev/existing\\n';;
 *) exit 1;;
esac
`, { mode: 0o755 });
  for (const bash of [false, true]) {
    const dry = f.run(["beta", "--all", "--dry-run"], bash);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(socket);
    expect(dry.stdout).toContain("1 new viewer(s)");
    const fallback = f.run(["beta", "--all"], bash);
    expect(fallback.status).toBe(0);
    expect(fallback.stdout).toContain(`tmux -S '${socket}' attach -t '=beta/remote'`);
  }
  // Legacy unpinned rows must not silently inherit another row's foreign socket.
  doc.seats.second = { ...doc.seats.remote, tag: "second", session: "beta/second" };
  delete doc.seats.second.server_socket;
  writeFileSync(registry, JSON.stringify(doc));
  const mixed = f.run(["beta", "--all", "--dry-run"]);
  expect(mixed.status).toBe(1);
  expect(mixed.stderr).toContain("selected seats span multiple tmux sockets");
  expect(f.run(["beta", "--all", "--only", "remote", "--dry-run"]).status).toBe(0);
});

test("shared session requires two distinct new viewers and uses the selected socket after opening", () => {
  const f = fixture();
  const registry = join(f.root, "alpha/.tap/team-registry.json");
  const doc = JSON.parse(readFileSync(registry, "utf8"));
  const socket = join(f.root, "shared-socket");
  doc.seats.two.session = "alpha/one";
  for (const row of Object.values(doc.seats) as Record<string, unknown>[]) row.server_socket = socket;
  writeFileSync(registry, JSON.stringify(doc));
  const opened = join(f.root, "opened"), count = join(f.root, "count");
  writeFileSync(count, "1");
  writeFileSync(join(f.bin, "osascript"), `#!/bin/sh
[ "$1" = -e ] && exit 0
cat >/dev/null
touch '${opened}'
`, { mode: 0o755 });
  writeFileSync(join(f.bin, "tmux"), `#!/bin/sh
[ "$1" = -S ] && [ "$2" = '${socket}' ] || exit 1
shift 2
case "$1" in
 list-panes) printf 'alpha/one\\t0\\n';;
 list-clients)
  printf '/dev/existing\\n'
  if [ -f '${opened}' ]; then
    printf '/dev/new-one\\n'
    [ "$(cat '${count}')" -ge 2 ] && printf '/dev/new-two\\n'
    [ "$(cat '${count}')" -ge 3 ] && printf '/dev/new-three\\n'
  fi
  exit 0;;
 *) exit 1;;
esac
`, { mode: 0o755 });
  const partial = f.run(["--all"]);
  expect(partial.status).toBe(1);
  expect(partial.stderr).toContain("attachment proof incomplete");
  // Existing and new-one are the next invocation's pre-image. Opening two
  // further clients must succeed without counting either pre-existing client.
  writeFileSync(join(f.bin, "osascript"), `#!/bin/sh
[ "$1" = -e ] && exit 0
cat >/dev/null
printf 3 > '${count}'
`, { mode: 0o755 });
  const rerun = f.run(["--all"]);
  expect(rerun.status).toBe(0);
  expect(rerun.stdout).toContain("verified 2 new iTerm viewer(s)");
});
