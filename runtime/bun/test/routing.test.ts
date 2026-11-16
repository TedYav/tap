import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { calibrationView, compactAge, latestObservation, teamsView, teamStatus } from "../src/routing";
import { NO_MACHINE_INDEX } from "../src/selector";
import { ownBunFlags } from "../src/own-bun";
import golden from "./fixtures/routing/ledger.json";
import teamsCli from "./fixtures/routing/teams-cli.json";
import { removeScratchTree } from "./support/scratch";
import { addMessage, addSession, createOpenCodeStore } from "./support/opencode-store";
import { loadModelReference } from "../src/launcher/model-reference";

const root = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
const originalEnv = {...process.env};
afterEach(() => { process.env = {...originalEnv}; });
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "tap-routing-"));
  scratch.push(path);
  return path;
}

test("retired models returns a native read-free tombstone for every former entry shape", () => {
  const dir = directory(), home = join(dir, "home"), index = join(dir, "index");
  mkdirSync(home); mkdirSync(index);
  const ledger = join(dir, "ledger");
  writeFileSync(ledger, "malformed ledger must not be read");
  writeFileSync(join(index, "global-registry.json"), "{broken registry");
  const before = readdirSync(dir, {recursive:true, encoding:"utf8"}).sort();
  const expected = "tap models: tap models is deprecated; its personal ledger and the preset catalog contradict each other, and a model reference returns after the models/presets split (tap-qxq5l); next: tap presets   # saved recipes; tap launch <harness> [name] --model <id> [--effort <level>] launches directly (OpenCode 2: model and variant; Cursor: model only); tap team shows who is seated\n";
  const env = {...process.env, HOME:home, TAP_INDEX_HOME:index, TAP_HOME:join(dir, "absent-bus"),
    TAP_MODELS_LEDGER:ledger, TAP_VERBOSE:"0", BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"};
  for (const args of [["models"], ["models", "--all"], ["models", "--full"], ["models", "fable"],
    ["models", "--help"], ["help", "models"]]) {
    const trace = join(dir, "trace");
    writeFileSync(trace, "");
    const result = spawnSync("bash", [join(root, "bin/tap"), ...args], {
      cwd:dir, env:{...env, TAP_BUN_ROUTE_TRACE:trace}, encoding:"utf8",
    });
    expect({exit:result.status, stdout:result.stdout, stderr:result.stderr}, args.join(" "))
      .toEqual({exit:1, stdout:"", stderr:expected});
    expect(readFileSync(trace, "utf8")).toBe(`native ${args.includes("--help") ? "help" : args[0]}\n`);
  }
  for (const args of [["models", "--json"], ["models", "--all", "--json"]]) {
    const result = spawnSync("bash", [join(root, "bin/tap"), ...args], {cwd:dir, env, encoding:"utf8"});
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok:false, error_class:"models_retired", effect:"none",
      action:"tap presets   # saved recipes; tap launch <harness> [name] --model <id> [--effort <level>] launches directly (OpenCode 2: model and variant; Cursor: model only); tap team shows who is seated",
      detail:"tap models is deprecated; its personal ledger and the preset catalog contradict each other, and a model reference returns after the models/presets split (tap-qxq5l)",
    });
  }
  expect(readdirSync(dir, {recursive:true, encoding:"utf8"}).sort()).toEqual([...before, "trace"].sort());
  expect(readFileSync(ledger, "utf8")).toBe("malformed ledger must not be read");
  expect(readFileSync(join(index, "global-registry.json"), "utf8")).toBe("{broken registry");
});

test("calibration preserves captured Python stdout, stderr and exits", () => {
  const dir = directory();
  for (const [i, sample] of golden.cases.entries()) {
    if (!("roster" in sample) || !sample.roster) continue;
    const path = join(dir, `${i}.md`), ledger = golden.ledgers[sample.ledger];
    if (ledger !== null) writeFileSync(path, ledger!);
    const result = calibrationView(sample.roster, sample.activity!, sample.strongest!, path, sample.now!);
    const seen = { ...result, stdout: result.stdout.split(path).join("<LEDGER>"), stderr: result.stderr.split(path).join("<LEDGER>") };
    if (sample.name === "calibration false") {
      // Only harness-family guesses and resulting column widths were retired.
      const normalize = (s: string) => s.replace(/(?:openai|anthropic|google) \(INFERRED\)/g, "-").replace(/ {2,}/g," ")
        .replace("the name matches but the harness contradicts it, so the calibration is NOT inherited", "this calibration is NOT inherited");
      expect({...seen,stdout:normalize(seen.stdout)}).toEqual({...sample.expected,stdout:normalize(sample.expected.stdout)});
      expect(seen.stdout).not.toContain("INFERRED");
    } else expect(seen, sample.name).toEqual(sample.expected);
  }
});

test("calibration ledger absence supplies read-only reference; malformed and dangling paths refuse", () => {
  const dir = directory(), absent = join(dir,"missing");
  const before = readdirSync(dir, {recursive:true, encoding:"utf8"});
  const result = calibrationView({agents:[]}, "", false, absent);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("Reference; access unverified");
  expect(result.stdout).toContain("Saved recipes: tap presets");
  expect(readdirSync(dir,{recursive:true})).toEqual(before);
  writeFileSync(join(dir,"malformed"), "not a routing table");
  symlinkSync(absent,join(dir,"dangling"));
  writeFileSync(join(dir,"unreadable"),"private"); chmodSync(join(dir,"unreadable"),0);
  for (const path of [join(dir,"malformed"),join(dir,"dangling"),join(dir,"unreadable"),dir]) {
    const view = calibrationView({agents:[]},"",false,path);
    expect(view.exit).toBe(1); expect(view.stdout).toBe("");
  }
});

test("no-ledger strongest selects only active exact variants, never synthetic or unknown seats", () => {
  const path = join(directory(),"missing");
  const variants = loadModelReference();
  const medium = variants.find(v => v.recipes.includes("fable"))!, high = variants.find(v => v.recipes.includes("fable-high"))!;
  const agents = [
    {handle:"medium",harness:"claude",status:"active",launch_tuning:medium.tuning},
    {handle:"high",harness:"claude",status:"active",launch_tuning:high.tuning},
    {handle:"offline",harness:"claude",status:"offline",launch_tuning:high.tuning},
    {handle:"unknown",harness:"codex",status:"active",model:"unlisted"},
  ];
  expect(calibrationView({agents},"",true,path).stdout).toBe("high\n");
  const refused = calibrationView({agents:agents.slice(2)},"",true,path);
  expect(refused.exit).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("next:");
  const ordinary = calibrationView({agents},"",false,path);
  expect(ordinary.stdout).toContain("unlisted@?"); expect(ordinary.stdout).not.toContain("sole-eligible");
  expect(ordinary.stdout).not.toContain("INFERRED");
});

test("a free-form ledger label preserves legacy selection while recorded launch identity stays visible", () => {
  const path = join(directory(),"ledger");
  writeFileSync(path,"## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n|fable|My preferred model @ claude|anthropic|frontier|\n|other|other-model @ codex|openai|advanced|\n");
  const roster = {agents:[{handle:"fable-worker",harness:"claude",model:"new-model",status:"active"},{handle:"other",harness:"codex",model:"other-model",status:"active"}]};
  const result = calibrationView(roster,"",false,path);
  expect(result.stdout).toContain("new-model @ claude");
  expect(result.stdout).toContain("ledger label differs from recorded launch identifier; model match unverified");
  expect(result.stdout).not.toContain("the harness contradicts it");
  expect(calibrationView(roster,"",true,path).stdout).toBe("fable-worker\n");
  roster.agents[0]!.harness = "opencode";
  expect(calibrationView(roster,"",true,path).stdout).toBe("other\n");
});

test("idle thresholds use Python ties-to-even rounding", () => {
  for (const [seconds, expected] of [[89,"just now"],[90,"2m"],[150,"2m"],[210,"4m"],[5399,"90m"],[5400,"2h"],[9000,"2h"],[12600,"4h"],[129600,"2d"],[216000,"2d"]] as const) {
    expect(compactAge(seconds)).toBe(expected);
  }
});

test("latest evidence ranks endpoints but displays the ledger's literal token", () => {
  expect(latestObservation("- Plain 2026-08-01 and range 2026-07-30–07-31.\n- Old 2026-07-31."))
    .toEqual(["2026-08-01", "Plain 2026-08-01 and range 2026-07-30–07-31."]);
  expect(latestObservation("- Full range 2026-12-30—2027-01-02.\n- Older 2027-01-01."))
    .toEqual(["2027-01-02", "Full range 2026-12-30—2027-01-02."]);
  expect(latestObservation("- Unicode 2026-٠٧-٢٨–٠٧-٣٠."))
    .toEqual(["2026-٠٧-٢٨–٠٧-٣٠", "Unicode 2026-٠٧-٢٨–٠٧-٣٠."]);
  expect(latestObservation("- 2026-07-28\ufeff–07-30"))
    .toEqual(["2026-07-28", "2026-07-28\ufeff–07-30"]);
});

test("unjoined active seats remain tier-zero targets, and an empty candidate set is empty", () => {
  const path = join(directory(), "ledger");
  writeFileSync(path, "## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n");
  expect(calibrationView({agents:[{handle:"unjoined",status:"active"},{handle:"offline",status:"suspended"}]}, "", true, path).stdout).toBe("unjoined\n");
  expect(calibrationView({agents:[]}, "", true, path).stdout).toBe("");
});

function fleet(stub = true) {
  const dir = directory(), index = join(dir,"index"), bin = join(dir,"bin"), responses = join(dir,"responses");
  for (const path of [index,bin,responses]) mkdirSync(path);
  process.env.TAP_INDEX_HOME = index;
  process.env.TEST_ROSTER_RESPONSES = responses;
  if (stub) {
    process.env.PATH = `${bin}:${process.env.PATH}`;
    writeFileSync(join(bin,"bun"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
// argv: Bun's own flags, then the entry file, "roster", the team, "--json".
const verb = process.argv.indexOf("roster"), dir = process.env.TEST_ROSTER_RESPONSES, team = process.argv[verb + 1];
const log = event => fs.appendFileSync(path.join(dir,"calls"), JSON.stringify({event,team,pid:process.pid,cwd:process.cwd(),flags:process.argv.slice(2,verb-1),argv:process.argv.slice(verb-1),pin:process.env.TAP_HOME})+"\\n");
log("start");
const spec = JSON.parse(fs.readFileSync(path.join(dir,team),"utf8"));
process.on("SIGTERM",()=>{});
setTimeout(()=>{ process.stdout.write(spec.stdout); log("end"); process.exit(spec.exit || 0); },spec.delay || 0);
`,{mode:0o755});
  }
  const teams: Record<string,unknown> = {};
  const enroll = (name: string, seats: Record<string,unknown> = {}, response: unknown = {agents:[]}) => {
    const teamRoot = join(dir,name), registry = join(teamRoot,"acting.json");
    mkdirSync(join(teamRoot,".tap/bus"),{recursive:true});
    writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name},seats}));
    writeFileSync(join(teamRoot,".tap/bus/registry.json"),JSON.stringify({schema:"0.20",team:{name},seats:{decoy:{status:"active"}}}));
    teams[name] = {root:teamRoot,registry_location:registry};
    writeFileSync(join(responses,name),JSON.stringify({stdout:JSON.stringify(response)}));
    return {teamRoot,registry};
  };
  const save = () => writeFileSync(join(index,"global-registry.json"),JSON.stringify({schema:"0.20",teams}));
  return {dir,index,bin,responses,teams,enroll,save};
}

test("teams summary keeps captured CLI parsing and shares its internal/public parser", async () => {
  const fx = fleet(false);
  fx.save(); // a live, empty machine index: the captured samples list no teams
  process.env.TAP_VERBOSE = "0";
  for (const sample of teamsCli) {
    expect(await teamsView(sample.args),sample.args.join(" ")).toEqual(sample.expected);
    const result = spawnSync(process.execPath,[join(root,"runtime/bun/src/routing.ts"),"teams",...sample.args],{encoding:"utf8",env:process.env});
    expect({exit:result.status,stdout:result.stdout,stderr:result.stderr}).toEqual(sample.expected);
  }
});

test("fleet honors acting authority, roster fallback, lifecycle counts and warning order", async () => {
  const fx = fleet();
  const alpha = fx.enroll("alpha",{}, {agents:[
    {status:"active",agent_state:"blocked",attached:"1"},
    {status:"active",agent_state:"working",attached:true},
    {status:"active",agent_state:"unknown",attached:"0"},
    {status:"active",agent_state:"idle-at-prompt",attached:"false"},
    {status:"suspended",agent_state:"working",attached:"1"}, null, 1,
  ]});
  fx.enroll("asleep",{}, {agents:[{status:"suspended"}]});
  const broken = fx.enroll("broken",{one:{status:"active"},two:{status:"suspended"},junk:1}, {error:"cannot read",agents:[]});
  const corrupt = fx.enroll("corrupt"); writeFileSync(corrupt.registry,"{bad");
  writeFileSync(join(fx.responses,"corrupt"),JSON.stringify({stdout:"not json"}));
  fx.teams.ghost = {root:join(fx.dir,"ghost"),registry_location:join(fx.dir,"absent")};
  fx.teams.bare = {root:join(fx.dir,"bare")};
  fx.teams.historical = {root:alpha.teamRoot,state:"historical"};
  fx.teams.junk = [];
  fx.save();
  for (const teamRoot of [alpha.teamRoot,broken.teamRoot]) {
    const spool = join(teamRoot,".tap/bus/spool"); mkdirSync(spool);
    writeFileSync(join(spool,"old.md"),""); utimesSync(join(spool,"old.md"),new Date(Date.now()-240_000),new Date(Date.now()-240_000));
    writeFileSync(join(spool,"ignored.lock"),""); mkdirSync(join(spool,"directory.md"));
  }
  expect((await teamsView([])).stdout).toBe("TEAM     SEATS  STATUS\nalpha    4/5    ● blocked ● working\nbare     0/0    ● unknown\nbroken   0/2    ● unknown\ncorrupt  0/0    ● unknown\nghost    0/0    ● unknown\n");
  const details = (await teamsView(["--all","--details"])).stdout;
  expect(details).toContain("spool 1/4m · 1 dormant");
  expect(details).toContain("roster_unreadable · spool 1/4m");
  expect(details).toMatch(/alpha +4\/5 +2 /);
  expect(details).toMatch(/asleep +0\/1 +0 +1 dormant/);
  expect(details).toMatch(/bare +0\/0 +0 +acting_unreachable/);
  expect(details).not.toContain("2 dormant");
  expect(details).not.toContain("historical");
  const calls = readFileSync(join(fx.responses,"calls"),"utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.every(c => c.cwd === root && c.argv[0] === join(root,"runtime/bun/src/team-roster-json.ts") && c.argv[1] === "roster" && c.argv[3] === "--json")).toBe(true);
  // Each child names TAP's own Bun config and no env file: the team's root is its cwd, not its project.
  expect(calls.every(c => JSON.stringify(c.flags) === JSON.stringify(ownBunFlags("bun")))).toBe(true);
  expect(calls.every(c => c.pin === process.env.TAP_HOME)).toBe(true);
  expect(calls.some(c => ["bare","ghost","historical"].includes(c.team))).toBe(false);
});

test("an old-format acting registry is its own old_store row, never a roster", async () => {
  const fx = fleet();
  const legacy = fx.enroll("legacy",{}, {agents:[]});
  writeFileSync(legacy.registry,JSON.stringify({agents:{one:{status:"active"},bad:null}}));
  writeFileSync(join(fx.responses,"legacy"),JSON.stringify({stdout:"[]"}));
  fx.save();
  expect((await teamsView([])).stdout).toBe("TEAM    SEATS  STATUS\nlegacy  0/0    ● old_store\n");
  expect((await teamsView(["--details"])).stdout).toContain("old_store");
  // An old store is refused before its roster is observed: no roster child ran.
  expect(existsSync(join(fx.responses,"calls"))).toBe(false);
});

test("an absent machine index refuses; neither absent nor invalid ever reads a stray teams.json", async () => {
  const fx = fleet();
  fx.enroll("stray",{one:{status:"active"}});
  writeFileSync(join(fx.index,"teams.json"),JSON.stringify({teams:fx.teams}));
  for (const args of [[],["--all"],["--details"]]) {
    expect(await teamsView(args),args.join(" ")).toEqual({exit:1,stdout:"",stderr:`tap teams: ${NO_MACHINE_INDEX}; next: tap init  OR  tap session launch\n`});
  }
  // The named door refuses the same way instead of resolving the stray entry.
  const named = spawnSync(process.execPath,[join(root,"runtime/bun/main.ts"),"teams","stray"],{encoding:"utf8",cwd:fx.dir,env:{...process.env,TAP_VERB:"",BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"},timeout:20000});
  expect({exit:named.status,stdout:named.stdout,stderr:named.stderr}).toEqual({exit:1,stdout:"",stderr:`tap: ${NO_MACHINE_INDEX}; next: tap init  OR  tap session launch\n`});
  writeFileSync(join(fx.index,"global-registry.json"),"invalid");
  expect((await teamsView(["--all"])).stdout).toBe("tap teams (machine-wide): no enrolled teams\n");
  // No roster child ever ran for the stray enrollment.
  expect(existsSync(join(fx.responses,"calls"))).toBe(false);
});

test("roster failures are isolated, at most eight children run, and timeout kills the wedge", async () => {
  const fx = fleet();
  const specs = [
    {stdout:"",delay:30_000}, {stdout:'{"agents":[]}',exit:3}, {stdout:"null"},
    {stdout:"{}"}, {stdout:'{"agents":{}}'}, {stdout:'{"agents":[],"error":"bad"}'},
    ...Array.from({length:6},()=>({stdout:'{"agents":[{"status":"active"}]}',delay:300})),
  ];
  for (const [i,spec] of specs.entries()) {
    const name = `team${String(i).padStart(2,"0")}`;
    fx.enroll(name,{one:{}}); writeFileSync(join(fx.responses,name),JSON.stringify(spec));
  }
  fx.save();
  const out = (await teamsView([])).stdout;
  expect(out.match(/0\/1 +● unknown/g)).toHaveLength(6);
  expect(out.match(/1\/1 +● idle/g)).toHaveLength(6);
  const calls = readFileSync(join(fx.responses,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  let live = 0, peak = 0;
  for (const call of calls) { live += call.event === "start" ? 1 : -1; peak = Math.max(peak,live); }
  expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
  const wedged = calls.find(c=>c.team === "team00");
  expect(()=>process.kill(wedged.pid,0)).toThrow();
  // A failed executable lookup must use stored counts as well.
  process.env.PATH = "/nonexistent-routing-bun";
  expect((await teamsView([])).stdout.match(/0\/1 +● unknown/g)).toHaveLength(12);
}, 30000);

test("status dots preserve order, unknown distinction and TTY/NO_COLOR rules", () => {
  expect(teamStatus(["blocked","idle"],false,false)).toBe("● blocked");
  expect(teamStatus(["working","blocked"],false,false)).toBe("● blocked ● working");
  expect(teamStatus(["idle","unknown","offline"],false,false)).toBe("● idle");
  // A team whose seats all wait on their own background work is not idle (tap-i5fzq).
  expect(teamStatus(["waiting","waiting"],false,false)).toBe("● waiting");
  expect(teamStatus(["idle","waiting"],false,false)).toBe("● waiting");
  expect(teamStatus(["working","waiting","idle"],false,false)).toBe("● working ● waiting");
  expect(teamStatus([],true,false)).toBe("● unknown");
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout,"isTTY");
  try {
    Object.defineProperty(process.stdout,"isTTY",{value:true,configurable:true});
    delete process.env.NO_COLOR;
    expect(teamStatus(["working","blocked"])).toBe("\x1b[31m●\x1b[0m blocked \x1b[32m●\x1b[0m working");
    process.env.NO_COLOR = "";
    expect(teamStatus([],true)).toBe("\x1b[33m●\x1b[0m unknown");
    process.env.NO_COLOR = "1";
    expect(teamStatus([],true)).toBe("● unknown");
  } finally {
    if (descriptor) Object.defineProperty(process.stdout,"isTTY",descriptor);
    else Reflect.deleteProperty(process.stdout,"isTTY");
  }
});

test("teams native, shell, installed-style and named doors preserve scope and capture", async () => {
  const fx = fleet(false);
  fx.enroll("alpha",{alpha:{status:"active",delivery:"poll",harness:"claude"}});
  const beta = fx.enroll("beta",{beta:{status:"active",delivery:"poll",harness:"codex"}});
  fx.save();
  const home = join(fx.dir,"home"); mkdirSync(join(home,".tap"),{recursive:true});
  process.env.HOME = home; process.env.TAP_VERBOSE = "0";
  process.env.TAP_HOME = join(fx.dir,"alpha/.tap/bus");
  process.env.TAP_REGISTRY = join(fx.dir,"alpha/acting.json");
  const expected = await teamsView([]);
  expect(expected.stdout).toContain("alpha  1/1"); expect(expected.stdout).toContain("beta   1/1");
  const doors = [[process.execPath,join(root,"runtime/bun/main.ts")],["bash",join(root,"scripts/tap.sh")],["bash",join(root,"bin/tap")]];
  for (const door of doors) {
    const run = (args: string[]) => spawnSync(door[0]!,[...door.slice(1),...args],{encoding:"utf8",cwd:fx.dir,env:{...process.env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"},timeout:20000});
    const summary = run(["teams"]);
    expect({exit:summary.status,stdout:summary.stdout,stderr:summary.stderr},door.join(" ")).toEqual(expected);
    const list = run(["team","list"]);
    expect(list.status).toBe(0); expect(list.stdout).toBe(expected.stdout+"to see seats on this team: tap team (or tap team roster)\n");
    for (const shape of [["--json"], ["--all","--json"], ["--wide"], ["--details","--json"], ["--context","--json"]]) {
      const seats = run(["teams","--seats",...shape]);
      const alias = run(["team","list","--seats",...shape]);
      expect({exit:alias.status,stdout:alias.stdout,stderr:alias.stderr}).toEqual({exit:seats.status,stdout:seats.stdout,stderr:seats.stderr});
    }
    for (const shape of [[], ["--json"], ["--all","--json"], ["--wide"], ["--details"], ["--state","sleeping","--json"]]) {
      const seats = run(["teams","--seats",...shape]);
      for (const roster of [run(["teams","roster",...shape]),run(["team","list","roster",...shape])]) {
        expect({exit:roster.status,stdout:roster.stdout,stderr:roster.stderr}).toEqual({exit:seats.status,stdout:seats.stdout,stderr:seats.stderr});
      }
    }
    const namedSeats = run(["teams","beta","--seats","--json"]);
    expect(namedSeats.status).toBe(1);
    expect(JSON.parse(namedSeats.stdout).error_class).toBe("unknown_option");
    const named = run(["teams","beta","--json"]);
    expect(named.status,named.stderr).toBe(0);
    expect(JSON.parse(named.stdout).agents.map((a:{handle:string})=>a.handle)).toEqual(["beta"]);
    const missing = run(["teams","missing"]);
    expect({exit:missing.status,stdout:missing.stdout,stderr:missing.stderr}).toEqual({exit:1,stdout:"",stderr:"tap teams: no enrolled team 'missing' in the machine index\n"});
    const bad = run(["team","list","--unknown"]);
    expect(bad.status).toBe(2); expect(bad.stdout).toBe("");
    // --recent reaches the same view through every door; the alias keeps its pointer line.
    const recent = run(["teams","--recent","-n","1"]);
    expect({exit:recent.status,stderr:recent.stderr},door.join(" ")).toEqual({exit:0,stderr:""});
    expect(recent.stdout).toBe("TEAM   SEATS  LAST ACTIVE  STATUS\nalpha  1/1    -            ● idle\n");
    const recentAlias = run(["team","list","--recent","-n","1"]);
    expect(recentAlias.stdout).toBe(recent.stdout+"to see seats on this team: tap team (or tap team roster)\n");
    const rosterRecent = run(["teams","roster","--recent"]);
    expect({exit:rosterRecent.status,stdout:rosterRecent.stdout,stderr:rosterRecent.stderr}).toEqual({exit:1,stdout:"",
      stderr:"tap teams: --recent orders teams, not seats; seats of one team: tap team --recent; next: tap team --recent\n"});
  }
  expect(readFileSync(beta.registry,"utf8")).toContain('"beta"');
  const ttyEnv: NodeJS.ProcessEnv = {...process.env,TERM:"xterm-256color"}; delete ttyEnv.NO_COLOR;
  const tty = (args: string[]) => spawnSync("python3",["-B","-c",
    "import os,pty,sys; raise SystemExit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
    process.execPath,join(root,"runtime/bun/main.ts"),...args],{encoding:"utf8",cwd:fx.dir,env:ttyEnv,timeout:20000});
  const color = tty(["teams"]), captured = tty(["team","list"]);
  expect(color.status,color.stderr).toBe(0); expect(color.stdout).toContain("\x1b[34m●\x1b[0m idle");
  expect(captured.status,captured.stderr).toBe(0);
  expect(captured.stdout.replaceAll("\r","")).toBe(expected.stdout+"to see seats on this team: tap team (or tap team roster)\n");
  const seatTty = tty(["teams","--seats"]), seatAliasTty = tty(["team","list","--seats"]);
  expect({exit:seatAliasTty.status,stdout:seatAliasTty.stdout,stderr:seatAliasTty.stderr}).toEqual({exit:seatTty.status,stdout:seatTty.stdout,stderr:seatTty.stderr});
  expect(seatTty.stdout).toContain("\x1b[1;36mbeta\x1b[0m");
  fx.teams.ghost = {root:fx.dir,registry_location:join(fx.dir,"missing")};
  fx.teams.historical = {root:fx.dir,state:"historical",registry_location:beta.registry};
  fx.teams.bare = {root:fx.dir};
  fx.save();
  for (const name of ["ghost","historical","bare"]) {
    const refusal = spawnSync(process.execPath,[join(root,"runtime/bun/main.ts"),"teams",name],{encoding:"utf8",cwd:fx.dir,env:{...process.env,HOME:originalEnv.HOME},timeout:20000});
    expect({exit:refusal.status,stdout:refusal.stdout,stderr:refusal.stderr}).toEqual({exit:1,stdout:"",stderr:name === "bare"
      ? "tap teams: no enrolled team 'bare' in the machine index\n"
      : `tap: acting registry for team '${name}' is unreachable (flip marker live/invalid?); next: tap doctor\n`});
  }
}, 60000);

test("machine seats flatten teams, sort warm expiry first, and preserve offline selection in JSON", async () => {
  const fx = fleet();
  const cache = (expires_at: string) => ({state:"warm",ttl_seconds:3600,expires_at,last_activity_at:"2026-10-22T08:00:00Z",source:"claude_transcript"});
  fx.enroll("alpha",{}, {agents:[
    {handle:"later",harness:"claude",status:"active",agent_state:"idle",prompt_cache:cache("2099-10-22T09:00:00Z")},
    {handle:"sleeping",harness:"claude",status:"suspended"},
  ]});
  fx.enroll("beta",{}, {agents:[
    {handle:"soon",harness:"claude",status:"active",agent_state:"working",prompt_cache:cache("2099-10-22T08:30:00Z")},
    {handle:"unknown",harness:"codex",status:"active",agent_state:"idle",prompt_cache:null},
  ]});
  fx.save();
  const result = await teamsView(["--seats","--json"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  const doc = JSON.parse(result.stdout);
  expect(doc.scope).toBe("machine");
  expect(doc.agents.map((row: any) => `${row.team}/${row.handle}`)).toEqual(["beta/soon","alpha/later","beta/unknown"]);
  expect(doc.agents[0].prompt_cache.ttl_seconds).toBe(3600);
  const all = JSON.parse((await teamsView(["--seats","--all","--json"])).stdout);
  expect(all.agents).toHaveLength(4);
  const human = (await teamsView(["--seats","--wide"])).stdout;
  expect(human).toMatch(/^  handle +harness +state +context +family +model +preset\n/);
  expect(human).toContain(`beta  2/2 seats active  ${join(fx.dir,"beta")}\n  soon`);
  expect(human).toContain(`alpha  1/2 seats active  ${join(fx.dir,"alpha")}\n  later`);
  expect(human.indexOf("\nalpha ")).toBeLessThan(human.indexOf("\nbeta "));
  expect(human).not.toContain("sleeping");
  expect((await teamsView(["--seats","--details","--json"])).exit).toBe(1);
  expect(JSON.parse((await teamsView(["--json"])).stdout)).toMatchObject({ok:false,error_class:"usage_error",detail:"--json requires --seats"});
  expect((await teamsView(["--","--seats"])).exit).toBe(2);
  expect((await teamsView(["--seats","--det","--json"])).exit).toBe(1);
  expect((await teamsView(["--seats","--help"])).stdout).toContain("tap teams --seats");
});

test("machine seats keep healthy seats and disclose unobserved teams in both formats", async () => {
  const fx = fleet();
  fx.enroll("broken",{}, {error:"cannot read",agents:[]});
  fx.enroll("healthy",{}, {agents:[{handle:"warm",harness:"claude",status:"active",agent_state:"idle"}]});
  fx.save();
  const result = await teamsView(["--seats","--json"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ok:true,unobserved_teams:["broken"],agents:[{team:"healthy",handle:"warm"}]});
  const human = await teamsView(["--seats"]);
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain("healthy  1/1 seats active");
  expect(human.stdout).toContain("broken  ?/? seats active");
  expect(human.stdout).toMatch(/\n  warm +claude/);
  expect(human.stderr).toContain("broken");
  expect(human.stderr).toContain("tap teams --details");
});

test("teams sort case-insensitively with blank lines between teams in both views", async () => {
  const fx = fleet();
  const names = ["tap","UI-BugBash","gamma","Beta","alpha"];
  for (const name of names) fx.enroll(name,{}, {agents:[
    {handle:`${name}-a`,harness:"claude",status:"active",agent_state:"idle"},
    {handle:`${name}-b`,harness:"claude",status:"active",agent_state:"idle"},
  ]});
  fx.save();
  const order = ["alpha","Beta","gamma","tap","UI-BugBash"];
  const seats = (await teamsView(["--seats","--wide"])).stdout;
  const headings = seats.split("\n").filter(line => /seats active/.test(line));
  expect(headings.map(line => line.split("  ")[0])).toEqual(order);
  expect(headings[0]).toBe(`alpha  2/2 seats active  ${join(fx.dir,"alpha")}`);
  expect(seats.endsWith("\n")).toBe(true);
  expect(seats.endsWith("\n\n")).toBe(false);
  // exactly one blank line before every heading except the first, none elsewhere
  expect(seats.split("\n").slice(0,-1).filter(line => line === "")).toHaveLength(order.length - 1);
  for (const heading of headings.slice(1)) expect(seats).toContain(`\n\n${heading}\n`);
  expect(seats).not.toContain("\n\n\n");
  expect(seats.split("\n")[1]).toBe(headings[0]);
  const plain = (await teamsView([])).stdout.split("\n").slice(1).filter(Boolean).map(line => line.split(/\s+/)[0]);
  expect(plain).toEqual(order);
  const json = JSON.parse((await teamsView(["--seats","--json"])).stdout);
  expect(json.agents.map((row: any) => row.team)).toHaveLength(10);
});

test("teams --recent lists dormant teams too, most recently active first, from one roster pass", async () => {
  const fx = fleet();
  const now = Date.parse("2026-08-27T00:20:00Z");
  process.env.TAP_WATCH_NOW = String(now / 1000);
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  // Working now, by the roster's own state reading: sorts first whatever its stored dates say.
  fx.enroll("busy", {lead:{harness:"claude",registered_at:ago(30 * 86400)}}, {agents:[{handle:"lead",status:"active",agent_state:"working"}]});
  // A dated turn end from the observed roster beats an old registration.
  fx.enroll("Turns", {lead:{harness:"codex",registered_at:ago(30 * 86400)}}, {agents:[{handle:"lead",status:"active",agent_state:"idle",turn_ended_at:ago(30 * 60)}]});
  // A dormant team dated by its crew's launch: crews count toward their team.
  fx.enroll("crewed", {lead:{harness:"claude",registered_at:ago(20 * 86400)},helper:{harness:"claude",crew:true,last_launched:ago(2 * 3600)}},
    {agents:[{handle:"lead",status:"suspended"},{handle:"helper",status:"suspended",crew:true}]});
  // The transcript's newest dated record counts; its fresh mtime does not.
  const transcript = join(fx.dir, "talked.jsonl");
  writeFileSync(transcript, `${JSON.stringify({type:"user",timestamp:ago(5 * 3600)})}\n`);
  utimesSync(transcript, new Date(now), new Date(now));
  fx.enroll("talked", {lead:{harness:"codex",transcript_path:transcript,last_launched:ago(3 * 86400)}}, {agents:[{handle:"lead",status:"offline"}]});
  // Equal dates break by name, ignoring case.
  fx.enroll("tie-b", {x:{harness:"agy",last_launched:ago(2 * 86400)}}, {agents:[{handle:"x",status:"offline"}]});
  fx.enroll("Tie-a", {x:{harness:"agy",last_launched:ago(2 * 86400)}}, {agents:[{handle:"x",status:"offline"}]});
  // Daemons (poll delivery or the daemon harness) are infrastructure: their fresh dates never lift a team.
  fx.enroll("watched", {lead:{harness:"codex",last_launched:ago(3 * 86400)},
    bot:{harness:"pre-merge-watch",delivery:"poll",last_launched:ago(60)}, relay:{harness:"daemon",registered_at:ago(30)}},
  {agents:[{handle:"lead",status:"offline"},{handle:"bot",status:"active",delivery:"poll",harness:"pre-merge-watch"},{handle:"relay",status:"active",harness:"daemon"}]});
  // Nothing dated, and an unreachable team: both last, by name, never an error.
  fx.enroll("undated", {x:{harness:"cursor"}}, {agents:[{handle:"x",status:"offline"}]});
  fx.teams.bare = {root:join(fx.dir,"bare")};
  fx.save();
  const recent = await teamsView(["--recent"]);
  expect(recent).toEqual({exit:0, stderr:"", stdout:
    "TEAM     SEATS  LAST ACTIVE  STATUS\n"
    + "busy     1/1    working      ● working\n"
    + "Turns    1/1    30m          ● idle\n"
    + "crewed   0/2    2h           ● idle\n"
    + "talked   0/1    5h           ● idle\n"
    + "Tie-a    0/1    2d           ● idle\n"
    + "tie-b    0/1    2d           ● idle\n"
    + "watched  2/3    3d           ● idle\n"
    + "bare     0/0    -            ● unknown\n"
    + "undated  0/1    -            ● idle\n"});
  // One roster child per team, the same pass plain `tap teams` makes.
  const calls = readFileSync(join(fx.responses,"calls"),"utf8").trim().split("\n").map(line => JSON.parse(line)).filter(c => c.event === "start");
  expect(calls.map(c => c.team).sort()).toEqual(["Tie-a","Turns","busy","crewed","talked","tie-b","undated","watched"]);
  // Without --recent: active (and unobserved) teams only, by name, and no new column.
  expect((await teamsView([])).stdout).toBe("TEAM     SEATS  STATUS\nbare     0/0    ● unknown\nbusy     1/1    ● working\nTurns    1/1    ● idle\nwatched  2/3    ● idle\n");
  const lines = (args: string[]) => teamsView(args).then(r => r.stdout.split("\n").filter(Boolean).slice(1).map(line => line.split(/\s+/)[0]));
  expect(await lines(["--recent","-n","3"])).toEqual(["busy","Turns","crewed"]);
  expect(await lines(["--recent","-n","1"])).toEqual(["busy"]);
  expect(await lines(["--rec","-n","100"])).toEqual(["busy","Turns","crewed","talked","Tie-a","tie-b","watched","bare","undated"]);
  expect(await lines(["-n","2","--recent","--all"])).toEqual(["busy","Turns"]);
  const details = (await teamsView(["--recent","--details","-n","2"])).stdout;
  expect(details).toMatch(/^TEAM +SEATS +LAST ACTIVE +ATTACHED +WARN +WORKDIR\nbusy +1\/1 +working +0 +- +\S+\nTurns +1\/1 +30m +0 +- +\S+\n$/);
});

test("teams --recent: a working team outranks in-collection and future dates; an out-of-range date is undated", async () => {
  const fx = fleet();
  const now = Date.parse("2026-08-27T00:20:00Z");
  process.env.TAP_WATCH_NOW = String(now / 1000);
  const iso = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  fx.enroll("busy", {lead:{harness:"claude"}}, {agents:[{handle:"lead",status:"active",agent_state:"working"}]});
  // A turn that ended after the view's clock was captured, during roster collection.
  fx.enroll("ahead", {lead:{harness:"codex"}}, {agents:[{handle:"lead",status:"active",agent_state:"idle",turn_ended_at:iso(120)}]});
  // OpenCode's newest message has a creation time no Date can hold: the team falls back to its launch.
  const store = join(fx.dir, "opencode.db");
  process.env.OPENCODE_DB_PATH = store;
  const db = createOpenCodeStore(store);
  addSession(db, "ses_far", fx.dir);
  addMessage(db, { type: "assistant", time: { created: 9000000000000000 } }, { session: "ses_far" });
  db.close();
  fx.enroll("farclock", {oc:{harness:"opencode",harness_session_id:"ses_far",last_launched:iso(-4 * 86400)}}, {agents:[{handle:"oc",status:"offline"}]});
  fx.enroll("older", {x:{harness:"agy",last_launched:iso(-86400)}}, {agents:[{handle:"x",status:"offline"}]});
  fx.save();
  expect(await teamsView(["--recent"])).toEqual({exit:0, stderr:"", stdout:
    "TEAM      SEATS  LAST ACTIVE  STATUS\n"
    + "busy      1/1    working      ● working\n"
    + "ahead     1/1    just now     ● idle\n"
    + "older     0/1    24h          ● idle\n"
    + "farclock  0/1    4d           ● idle\n"});
  expect((await teamsView(["--recent","-n","1"])).stdout).toBe("TEAM  SEATS  LAST ACTIVE  STATUS\nbusy  1/1    working      ● working\n");
});

test("teams --recent refusals: the -n value, -n without --recent, and the seat view", async () => {
  const fx = fleet();
  fx.enroll("alpha",{}, {agents:[]});
  fx.save();
  const refused = (detail: string, action = "tap help teams") => ({exit:1, stdout:"", stderr:`tap teams: ${detail}; next: ${action}\n`});
  expect(await teamsView(["--recent","-n"])).toEqual(refused("-n needs a positive integer: the number of rows to keep, e.g. -n 15"));
  expect(await teamsView(["-n","--recent"])).toEqual(refused("-n needs a positive integer: the number of rows to keep, e.g. -n 15"));
  for (const value of ["0","x","-3","1.5"]) expect(await teamsView(["--recent","-n",value]), value).toEqual(refused(`-n must be a positive integer, got '${value}'`));
  expect(await teamsView(["-n","5"])).toEqual(refused("-n limits a --recent listing; add --recent"));
  expect(await teamsView(["--all","-n","5"])).toEqual(refused("-n limits a --recent listing; add --recent"));
  for (const glued of ["-n5","-n=5"]) expect(await teamsView(["--recent",glued]), glued).toEqual(refused("-n takes its value as a separate word: -n <n>"));
  // -n takes the word typed after it, here --state, so the filter lift never hands it the 5. A malformed
  // -n refuses as it is lifted, before help or the view checks, as a malformed filter does.
  expect(await teamsView(["--recent","-n","--state","idle","5"])).toEqual(refused("-n needs a positive integer: the number of rows to keep, e.g. -n 15"));
  expect(await teamsView(["--recent","-n","0","--help"])).toEqual(refused("-n must be a positive integer, got '0'"));
  expect(JSON.parse((await teamsView(["--seats","--recent","-n","--json"])).stdout)).toMatchObject({error_class:"usage_error",detail:"-n needs a positive integer: the number of rows to keep, e.g. -n 15"});
  expect(await teamsView(["--recent","-n","--details"])).toEqual(refused("-n needs a positive integer: the number of rows to keep, e.g. -n 15"));
  const seats = "--recent orders teams, not seats; seats of one team: tap team --recent";
  expect(await teamsView(["--seats","--recent"])).toEqual(refused(seats, "tap team --recent"));
  expect(await teamsView(["--state","idle","--recent","-n","2"])).toEqual(refused(seats, "tap team --recent"));
  expect(JSON.parse((await teamsView(["--seats","--recent","--json"])).stdout)).toEqual({ok:false,error_class:"usage_error",action:"tap team --recent",detail:seats});
  expect(JSON.parse((await teamsView(["--seats","--recent","-n","0","--json"])).stdout)).toMatchObject({error_class:"usage_error",detail:"-n must be a positive integer, got '0'"});
  // No team-level JSON: the existing refusal stands.
  expect(JSON.parse((await teamsView(["--recent","--json"])).stdout)).toMatchObject({error_class:"usage_error",detail:"--json requires --seats"});
  // The argparse-compatible surface keeps its own grammar for the new long option.
  expect((await teamsView(["--recent=yes"])).stderr).toContain("argument --recent: ignored explicit argument 'yes'");
  expect((await teamsView(["--recent","--help"])).stdout).toContain("[--recent] [-n N]");
  expect(existsSync(join(fx.responses,"calls"))).toBe(false);
});

test("machine seats refresh clock-derived cache fields at final collection time", async () => {
  const fx = fleet();
  fx.enroll("alpha",{}, {agents:[{handle:"expired",harness:"claude",status:"active",agent_state:"idle",prompt_cache:{
    state:"warm",ttl_seconds:3600,last_activity_at:"2026-01-01T00:00:00Z",expires_at:"2026-01-01T01:00:00Z",
    remaining_seconds:60,source:"claude_transcript",basis:"assistant_timestamp",unknown_reason:null}}]});
  fx.save();
  const result = await teamsView(["--seats","--json"]);
  expect(JSON.parse(result.stdout).agents[0].prompt_cache).toMatchObject({state:"cold",remaining_seconds:0});
  const human = await teamsView(["--seats"]);
  expect(human.stdout).toMatch(/— ●/);
  expect(human.stdout).not.toContain("expired/");
});

test("machine seat index refusals retain actionable recovery fields", async () => {
  const fx = fleet();
  const absent = await teamsView(["--seats","--json"]);
  expect(JSON.parse(absent.stdout).action).toBe("tap init  OR  tap session launch");
  writeFileSync(join(fx.index,"global-registry.json"),"{bad");
  const invalid = await teamsView(["--seats","--json"]);
  expect(JSON.parse(invalid.stdout).action).toBe("tap doctor");
});


test("nested seats keep urgency within teams, cold before unknown, and align all columns", async () => {
  const fx = fleet();
  const expiry = (seconds: number) => ({state:"warm",ttl_seconds:3600,expires_at:new Date(Date.now()+seconds*1000).toISOString()});
  fx.enroll("alpha",{}, {agents:[
    {handle:"a-unknown",harness:"codex",status:"active",agent_state:"working",family:"openai",model:"gpt",effort:"high",preset:"sol"},
    {handle:"z-cold",harness:"claude",status:"active",agent_state:"idle",prompt_cache:expiry(-10)},
    {handle:"soon",harness:"claude",status:"active",agent_state:"idle",prompt_cache:expiry(120),
      context_tokens:{input_tokens:329000,window_tokens:600000},observed_model:"opus",observed_effort:"high",family:"anthropic",preset:"opus"},
  ]});
  fx.enroll("zeta",{}, {agents:[{handle:"later",harness:"claude",status:"active",agent_state:"idle",prompt_cache:expiry(180)}]});
  fx.save();
  const human = (await teamsView(["--seats","--wide"])).stdout;
  const lines = human.trimEnd().split("\n");
  expect(lines.filter(line=>line.includes("handle"))).toHaveLength(1);
  expect(lines[1]).toMatch(/^alpha  3\/3 seats active/);
  expect(lines.slice(2,5).map(line=>line.trim().split(/\s+/)[0])).toEqual(["soon","z-cold","a-unknown"]);
  expect(lines[2]).toMatch(/329k\/600k ●2m +anthropic +opus@high +opus$/);
  expect(lines[4]).toMatch(/openai +gpt@high \(launch\) +sol$/);
  const contextAt = lines[0]!.indexOf("context");
  expect(lines[2]!.indexOf("329k/600k")).toBe(contextAt);
  expect(human).not.toContain("\x1b");
  // JSON remains the original flat urgency list: cold/unknown ties use team and handle.
  const doc = JSON.parse((await teamsView(["--seats","--json"])).stdout);
  expect(doc.agents.map((r:any)=>r.handle)).toEqual(["soon","later","a-unknown","z-cold"]);
});


test("nested machine styling respects color opt-outs and subtracts the seat indent from width", () => {
  const fx = fleet();
  fx.enroll("alpha",{}, {agents:[{handle:"seat",harness:"claude",status:"active",agent_state:"idle",family:"anthropic",
    observed_model:"opus",preset:"long-preset-name",context_tokens:{input_tokens:329000,window_tokens:600000},
    prompt_cache:{state:"warm",ttl_seconds:3600,expires_at:new Date(Date.now()+600000).toISOString()}}]});
  fx.save();
  const env: NodeJS.ProcessEnv = {...process.env,TERM:"xterm-256color",COLUMNS:"50"}; delete env.NO_COLOR;
  const tty = (extra: NodeJS.ProcessEnv) => spawnSync("python3",["-B","-c",
    "import os,pty,sys; raise SystemExit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
    process.execPath,join(root,"runtime/bun/src/routing.ts"),"teams","--seats"],{encoding:"utf8",env:{...env,...extra},timeout:20000});
  const colored = tty({});
  expect(colored.status,colored.stderr).toBe(0);
  expect(colored.stdout).toContain("\x1b[1;36malpha\x1b[0m");
  expect(colored.stdout).toContain("\x1b[33m●10m\x1b[0m");
  const plain = colored.stdout.replace(/\x1b\[[0-9;]*m/g,"").replaceAll("\r","");
  expect(plain).toMatch(/^  handle +harness +state +context\n/);
  for (const line of plain.split("\n").filter(line=>line.startsWith("  "))) expect(line.length).toBeLessThanOrEqual(50);
  for (const extra of [{NO_COLOR:""},{TERM:"dumb"}]) {
    const mono = tty(extra);
    expect(mono.status,mono.stderr).toBe(0);
    expect(mono.stdout).not.toContain("\x1b");
    expect(mono.stdout).toContain("329k/600k ●10m");
  }
});

test("seat filters imply the roster view and select the same seats in JSON and the table", async () => {
  const fx = fleet();
  fx.enroll("alpha",{},{agents:[
    {handle:"opus",harness:"claude",delivery:"pane",status:"active",agent_state:"working",observed_model:"claude-opus-5-5",observed_effort:"xhigh"},
    {handle:"astra",harness:"codex",delivery:"pane",status:"active",agent_state:"idle",turn_ended_at:"2026-08-27T00:05:00Z",model:"gpt-6-astra",effort:"high"},
    {handle:"rest",harness:"codex",delivery:"pane",status:"offline",agent_state:"unknown",model:"gpt-6-astra"},
    {handle:"mark",harness:"claude",delivery:"pane",status:"suspended",status_reason:"incapable",agent_state:"unknown"},
    {handle:"bot",harness:"claude",delivery:"poll",status:"active",agent_state:"unknown"},
  ]});
  fx.enroll("dormant",{},{agents:[{handle:"away",harness:"codex",delivery:"pane",status:"offline",agent_state:"unknown"}]});
  fx.save();
  process.env.TAP_WATCH_NOW = String(Date.parse("2026-08-27T00:15:00Z") / 1000);
  const handles = async (...flags: string[]): Promise<string[]> => {
    const json = await teamsView([...flags,"--json"]);
    expect(json.exit,json.stdout).toBe(0);
    const seen = JSON.parse(json.stdout).agents.map((row: {handle:string}) => row.handle).sort();
    const human = await teamsView([...flags,"--wide"]);
    expect(human.exit).toBe(0);
    for (const handle of ["opus","astra","rest","mark","bot","away"]) {
      expect([handle,new RegExp(`^  ${handle} `,"m").test(human.stdout)]).toEqual([handle,seen.includes(handle)]);
    }
    return seen;
  };
  expect(await handles("--harness","codex")).toEqual(["astra"]);
  expect(await handles("--seats","--harness","codex")).toEqual(["astra"]);
  expect(await handles("--model","opus5.5")).toEqual(["opus"]);
  expect(await handles("--model","5.5,astra6")).toEqual(["astra","opus"]);
  expect(await handles("--state","working")).toEqual(["opus"]);
  // 600s idle by a dated turn end is not active; a live daemon is, and offline never.
  expect(await handles("--state","active")).toEqual(["bot","opus"]);
  // An explicit --state replaces the default active-only scope.
  expect(await handles("--state","offline")).toEqual(["away","rest"]);
  expect(await handles("--state","incapable")).toEqual(["mark"]);
  expect(await handles("--all","--harness","codex")).toEqual(["astra","away","rest"]);
  expect(await handles("--harness","codex","--state","offline")).toEqual(["away","rest"]);

  const human = await teamsView(["--harness","claude","--wide"]);
  expect(human.stdout).toContain("opus5.5@xhigh");
  expect(human.stdout).toContain("● ready");
  expect(human.stdout).not.toContain("dormant");
  expect((await teamsView(["--state","offline"])).stdout).toContain("dormant");
  expect((await teamsView(["--harness","codex","--json"])).stdout).toContain('"model":"gpt-6-astra"');

  expect((await teamsView(["--model","nothing"])).stdout).toBe("tap teams --seats: no seats match these filters\n");
  expect(JSON.parse((await teamsView(["--state","sleeping","--json"])).stdout)).toMatchObject({ok:false,error_class:"usage_error",action:"tap help teams"});
  const details = await teamsView(["--harness","codex","--details"]);
  expect(details.exit).toBe(1);
  expect(details.stderr).toContain("--details");
  expect((await teamsView(["--seats","--details"])).stderr).toContain("--seats and --details are alternative views");
  expect((await teamsView(["--state","idle"])).exit).toBe(0);
});
