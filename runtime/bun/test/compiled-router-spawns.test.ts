// tap-gpk7b: the compiled TAP router's own spawns. Under `bun build --compile`
// process.execPath is the router and a module's directory is virtual, so a child that
// ran `process.execPath <module>.ts` re-entered main.ts with a .ts path in verb position.
// Each test drives the COMPILED router to one spawn and has a stand-in `bun` on PATH
// record the argv it was handed: real Bun, on the shipped module's real path. (The
// nudge-door spawns, spool-waiter and recovery escalation, are in nudge-scrolled-tail.)
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compiledArtifact, compiledRouter, compiledRouterCleanup, compiledRouterSrc } from "./compiled-router";

const roots: string[] = [];
afterAll(compiledRouterCleanup);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A scratch team whose seat `owner` is the calling pane (ps/tmux shims), with a recording `bun` first on PATH. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-compiled-spawns-")));
  roots.push(root);
  const bus = join(root, ".tap", "bus"), index = join(root, "index"), bin = join(root, "bin");
  for (const dir of [join(bus, "watch"), index, bin, join(root, "state")]) mkdirSync(dir, { recursive: true });
  const registry = join(bus, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: root }, seats: {
    owner: { status: "active", session: "sess", pane: "sess:0.0", pane_id: "%5", server_epoch: "srv:4242:100", boot_id: "boot:1", harness: "codex", registered_from_worktree: root },
    peer: { status: "active", delivery: "poll" }, fallback: { status: "active", delivery: "poll" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { team: { root, registry_location: registry, state: "registered" } } }));
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}`); chmodSync(join(bin, name), 0o755); };
  script("ps", "case \"$*\" in *ppid=*tty=*) echo '1 ttys001' ;; *) exit 1 ;; esac\n");
  script("tmux", "case \"$1\" in\n  list-panes) printf '%%5\\t/dev/ttys001\\n' ;;\n  display-message) case \"$*\" in\n    *pane_tty*session_name*) printf '%%5\\t/dev/ttys001\\tsess\\t4242:100\\n' ;;\n    *session_name*) printf '%%5\\tsess\\t4242:100\\n' ;;\n    *) printf '%%5\\n' ;; esac ;;\n  new-window) printf '%s\\n' \"$*\" >> \"$ROOT/state/tmux-new-window\"; printf '%%7 4243\\n' ;;\nesac\nexit 0\n");
  script("bun", "printf '%s\\n' \"$@\" >> \"$ROOT/state/bun-argv\"\n");
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin`, HOME: root, ROOT: root, XDG_CONFIG_HOME: join(root, "config"),
    TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(root, "locks"), TMUX: "/fake,1,0", TMUX_PANE: "%5", TAP_WATCH_NO_SPAWN: "1",
    TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1" };
  return { root, bus, env,
    run: (args: string[], router: string = compiledRouter()) => spawnSync(router, args, { cwd: root, env, encoding: "utf8", timeout: 60000 }),
    recorded: (file: string) => existsSync(join(root, "state", file)) ? readFileSync(join(root, "state", file), "utf8") : "",
    /** A detached child records after the router returns: wait, bounded, for its first line. */
    recordedSoon: (file: string) => { for (let i = 0; i < 100; i++) { if (existsSync(join(root, "state", file))) break; Bun.sleepSync(50); } return existsSync(join(root, "state", file)) ? readFileSync(join(root, "state", file), "utf8") : ""; } };
}

/** The flags every start of real Bun carries (src/own-bun.ts): the shipped config beside the router's own sources, no env file. */
const ownFlags = () => [`--config=${join(compiledRouterSrc(), "../tap-bunfig.toml")}`, "--no-env-file"];

test("the compiled router re-execs `tap goalie run` into real bun on the shipped goalie-run.ts", () => {
  const w = world();
  const result = w.run(["goalie", "run"]);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(w.recorded("bun-argv").trim().split("\n")).toEqual([...ownFlags(), join(compiledRouterSrc(), "goalie-run.ts"), "run"]);
}, 120000);

test("in a release artifact the compiled router re-execs `tap goalie run` through libexec/tap/bun, not bun from PATH", () => {
  const w = world();
  const artifact = compiledArtifact("recording");
  const result = w.run(["goalie", "run"], artifact.router);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(w.recorded("shim-argv").trim().split("\n")).toEqual([join(artifact.src, "goalie-run.ts"), "run"]);
  expect(w.recorded("shim-be-bun").trim()).toBe("unset");
  expect(w.recorded("bun-argv")).toBe("");
}, 120000);

test("the compiled router starts the goalie sidecar window on real bun and the shipped goalie-run.ts", () => {
  const w = world();
  mkdirSync(join(w.bus, "goalie"), { recursive: true });
  const registry = join(w.bus, "registry.json"), doc = JSON.parse(readFileSync(registry, "utf8"));
  doc.seats.goalie = { status: "active", delivery: "pane", pane: "%9" };
  writeFileSync(registry, JSON.stringify(doc));
  const result = w.run(["goalie", "on", "--by", "owner", "--goalie", "goalie", "--threshold", "60", "--interval", "60"]);
  const line = w.recorded("tmux-new-window");
  expect(line, `rc=${result.status} out=[${result.stdout}] err=[${result.stderr}]`).not.toBe("");
  expect(line).toContain(` exec '${join(w.root, "bin/bun")}' ${ownFlags().map(flag => `'${flag}'`).join(" ")} '${join(compiledRouterSrc(), "goalie-run.ts")}' run`);
  expect(line).not.toContain("$bunfs");
}, 120000);

test("the compiled router launches the `tap remind --when-done` custodian on real bun and the shipped remind-job.ts", () => {
  const w = world();
  const body = join(w.root, "body.md");
  writeFileSync(body, "build finished\n");
  const result = w.run(["remind", "peer", "--when-done", "true", "--circle-back", "5m", "--fallback", "fallback", "-f", body]);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  const argv = w.recordedSoon("bun-argv").trim().split("\n");
  expect(argv).toEqual([...ownFlags(), join(compiledRouterSrc(), "remind-job.ts"), join(w.bus, "watch", "reminders.json"), expect.stringMatching(/^remind-[0-9a-f]{16}$/)]);
}, 120000);
