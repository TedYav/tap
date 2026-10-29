import { expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "../../src/tmux";
import { stopCrewLifetimeHelper, type CrewLifetimeBinding } from "../../src/crew-lifetime";
import { removeScratchTree } from "./scratch";

const repo = resolve(import.meta.dir, "../../../.."), main = join(repo, "runtime/bun/main.ts");
export function crewFixture() {
  if (!process.env.TMUX_TMPDIR) throw new Error("run through the isolated Bun runner");
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR, "adopt-"))), socket = join(root, "s");
  const cwd = join(root, "Repo"), bin = join(root, "bin"), index = join(root, "index"), home = join(root, "home");
  for (const path of [cwd, bin, index, home, join(root, "config/tap"), join(cwd, ".tap/bus")]) mkdirSync(path, { recursive: true });
  const registry = join(cwd, ".tap/team-registry.json");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config"),
    CLAUDE_CONFIG_DIR: join(root, "claude"), TAP_HOME: join(cwd, ".tap/bus"), TAP_INDEX_HOME: index,
    TAP_LAUNCH_SHELL: join(bin, "sh"), TAP_TMUX_SOCKET_PATH: socket, TAP_TMUX_SOCKET: undefined,
    TMUX: undefined, TMUX_PANE: undefined, PATH: `${bin}:${process.env.PATH}`, TAP_SKIP_VERSION_BRIEFING: "1",
    TAP_JSON: undefined, TAP_VERBOSE: undefined, ADOPT_FIXTURE: root };
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { env, cwd, encoding: "utf8", timeout: 10000 });
  const read = (...args: string[]) => { const r = tmux(...args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  symlinkSync("/bin/sleep", join(bin, "codex-parent"));
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(join(bin, "sh"), '#!/bin/sh\nif [ "$1" = -lic ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/bash\ncase "$*" in *ppid=*tty=*) if [ -n "${ADOPT_TTY:-}" ]; then printf "1 %s\\n" "${ADOPT_TTY#/dev/}"; exit; fi ;; esac\nexec /bin/ps "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
if(args.includes('--print')) {
  const id=value('--session-id'), path=join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',id+'.jsonl');
  mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd()})+'\\n');
  process.stdout.write('fixture answer\\n');
} else {
  const name=value('--name').split('/').at(-1), id=args.includes('--resume')?value('--resume'):randomUUID();
  const before=JSON.parse(readFileSync(${JSON.stringify(registry)},'utf8')).seats[name];
  const observed=args.includes('--resume')?(process.env.ADOPT_WRONG_ID||id):id;
  const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(repo, "runtime/bun/src/session-start.ts"))},'claude',process.cwd()],{
    cwd:process.cwd(),encoding:'utf8',input:JSON.stringify({session_id:observed,cwd:process.cwd(),source:'startup',transcript_path:join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',id+'.jsonl')}),
    env:{...process.env,CLAUDE_PROJECT_DIR:process.cwd(),CLAUDE_CODE_SESSION_ID:observed}
  });
  writeFileSync(join(process.env.ADOPT_FIXTURE,'hook-'+name),JSON.stringify({before,result:{status:result.status,out:result.stdout,err:result.stderr}}));
  await Bun.sleep(600000);
}
`, { mode: 0o755 });
  writeFileSync(join(root, "config/tap/config.toml"), 'version=3\n[harness.claude]\npermissions="bypass"\n');
  expect(spawnSync("git", ["init", "-q", cwd], { env }).status).toBe(0);
  expect(tmux("new-session", "-d", "-s", "Adopt/parent", "-n", "parent", "-c", cwd, `${join(bin, "codex-parent")} 600`).status).toBe(0);
  const parent = read("display-message", "-p", "-t", "Adopt/parent", "#{pane_id}");
  env.TMUX = `${socket},0,0`; env.TMUX_PANE = parent; env.ADOPT_TTY = read("display-message", "-p", "-t", parent, "#{pane_tty}");
  const epoch = `srv:${read("display-message", "-p", "-t", parent, "#{pid}:#{start_time}")}`;
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "Adopt", worktree_root: cwd }, seats: {
    parent: { status: "active", delivery: "pane", instance: "parent-one", harness: "codex", session: "Adopt/parent",
      pane: "Adopt/parent:0.0", pane_id: parent, server_epoch: epoch, server_socket: socket, boot_id: bootId(env), registered_from_worktree: cwd },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    Adopt: { root: cwd, registry_location: registry, state: "registered" },
  } }));
  const run = (args: string[]) => spawnSync(process.execPath, [main, ...args], { env, cwd, encoding: "utf8", timeout: 30000 });
  const seats = () => JSON.parse(readFileSync(registry, "utf8")).seats;
  const stopHelpers = () => {
    for (const pane of tmux("list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n")) {
      const raw = tmux("show-option", "-p", "-v", "-t", pane, "@tap_crew_lifetime").stdout.trim();
      if (!raw) continue;
      const binding = JSON.parse(raw) as CrewLifetimeBinding;
      if (binding.serverSocket === socket && binding.crewPane === pane) stopCrewLifetimeHelper(binding);
    }
  };
  return { root, cwd, registry, env, tmux, read, run, seats, stopHelpers, close: async () => {
    stopHelpers();
    tmux("kill-server");
    // The old lifetime helper observes parent death asynchronously after the private server exits.
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (spawnSync(Bun.which("lsof") ?? "/usr/sbin/lsof", ["+D", root]).status === 1) break;
      await Bun.sleep(50);
    }
    removeScratchTree(root);
  } };
}
