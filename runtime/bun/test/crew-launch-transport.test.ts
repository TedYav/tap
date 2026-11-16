import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crewFixture } from "./support/crew-fixture";

function observeSubmission(fixture: ReturnType<typeof crewFixture>, blockSend = false) {
  const realTmux = Bun.which("tmux")!, trace = join(fixture.root, "typed"), payload = join(fixture.root, "payload.json");
    writeFileSync(join(fixture.root, "bin/tmux"), `#!${process.execPath}
import {appendFileSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('send-keys')) {
  appendFileSync(${JSON.stringify(trace)},args.join('\\n')+'\\n');
  const command=args[args.indexOf('--')+1];
  if(command?.startsWith("exec /bin/sh '")) {
    const file=command.slice(14,-1);
    writeFileSync(${JSON.stringify(payload)},JSON.stringify({file,mode:statSync(file).mode&511,dirMode:statSync(dirname(file)).mode&511,script:readFileSync(file,'utf8')}));
    if(${blockSend}) await Bun.sleep(2000);
  }
}
const result=spawnSync(${JSON.stringify(realTmux)},args,{stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o755 });
  return { trace, payload };
}

test("a first crew launch keeps a long unique PATH and environment values off the typed line", async () => {
  const fixture = crewFixture();
  try {
    const { trace, payload } = observeSubmission(fixture);
    const harness = join(fixture.root, "bin/claude"), observed = join(fixture.root, "observed.json");
    writeFileSync(harness, readFileSync(harness, "utf8").replace("const args=", `writeFileSync(${JSON.stringify(observed)},JSON.stringify({path:process.env.PATH,value:process.env.ANTHROPIC_CUSTOM_HEADERS}));\nconst args=`), { mode: 0o755 });
    fixture.env.PATH = [fixture.env.PATH!, ...Array.from({ length: 80 }, (_, i) => `/opt/version-manager/unique-${i}/bin`)].join(":");
    expect(Buffer.byteLength(fixture.env.PATH)).toBeGreaterThan(1024);
    const secret = "literal ' $(touch injected) " + "x".repeat(1600);
    const result = fixture.run(["crew", "add", "claude", "long-path", "--model", "fixture", "--env", `ANTHROPIC_CUSTOM_HEADERS=${secret}`]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const lines = readFileSync(trace, "utf8").split("\n").filter(line => line.startsWith("exec "));
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!)).toBeLessThan(1024);
    expect(lines[0]).not.toContain("unique-79");
    expect(lines[0]).not.toContain("ANTHROPIC_CUSTOM_HEADERS");
    const stored = JSON.parse(readFileSync(payload, "utf8"));
    expect(stored.mode).toBe(0o600);
    expect(stored.dirMode).toBe(0o700);
    expect(existsSync(stored.file)).toBe(false);
    const received = JSON.parse(readFileSync(observed, "utf8"));
    expect(received.value).toBe(secret);
    expect(received.path).toContain("/opt/version-manager/unique-79/bin");
    expect(received.path.split(":").length).toBe(new Set(received.path.split(":")).size);
    expect(existsSync(join(fixture.root, "hook-long-path"))).toBe(true);
  } finally { await fixture.close(); }
}, 45000);

test("an unobservable send keeps its queued payload through a later crew command until the startup grace expires", async () => {
  const fixture = crewFixture();
  try {
    const { trace, payload } = observeSubmission(fixture, true);
    fixture.env.TAP_TMUX_TIMEOUT_SECONDS = "0.5";
    const result = fixture.run(["crew", "add", "claude", "uncertain", "--model", "fixture"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("server_unresponsive");
    const stored = JSON.parse(readFileSync(payload, "utf8"));
    expect(existsSync(stored.file)).toBe(true);
    expect(readFileSync(trace, "utf8").split("\n")).not.toContain("Enter");
    delete fixture.env.TAP_TMUX_TIMEOUT_SECONDS;
    const next = fixture.run(["crew", "list"]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(existsSync(stored.file)).toBe(true);
    const directory = stored.file.slice(0, stored.file.lastIndexOf("/"));
    utimesSync(directory, new Date(Date.now() - 360000), new Date(Date.now() - 360000));
    const expired = fixture.run(["crew", "list"]);
    expect(expired.status, expired.stdout + expired.stderr).toBe(0);
    expect(existsSync(stored.file)).toBe(false);
  } finally { await fixture.close(); }
}, 45000);

test.each(["group-writable state", "unsafe launch root", "symlinked state"])("crew list still works with %s", async condition => {
  const fixture = crewFixture();
  try {
    const home = fixture.env.HOME!, state = join(home, ".tap");
    if (condition === "symlinked state") {
      const target = join(home, "other-state"); mkdirSync(target); symlinkSync(target, state);
    } else {
      mkdirSync(state);
      if (condition === "group-writable state") chmodSync(state, 0o775);
      else { mkdirSync(join(state, "crew-launch")); chmodSync(join(state, "crew-launch"), 0o755); }
    }
    const result = fixture.run(["crew", "list"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { await fixture.close(); }
}, 45000);
