import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { calibrationView, compactAge, latestObservation, modelsView, teamsView, teamStatus } from "../src/routing";
import { NO_MACHINE_INDEX } from "../src/selector";
import golden from "./fixtures/routing/ledger.json";
import teamsCli from "./fixtures/routing/teams-cli.json";
import { removeScratchTree } from "./support/scratch";
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

test("ledger views preserve captured Python stdout, stderr and exits", () => {
  const dir = directory();
  for (const [i, sample] of golden.cases.entries()) {
    // Deliberate new absent-ledger contract has its own reference/no-write proof below.
    if (sample.name === "missing") continue;
    const path = join(dir, `${i}.md`), ledger = golden.ledgers[sample.ledger];
    if (ledger !== null) writeFileSync(path, ledger!);
    const result = "roster" in sample && sample.roster
      ? calibrationView(sample.roster, sample.activity!, sample.strongest!, path, sample.now!)
      : modelsView(sample.args.slice(1), path);
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

test("genuine ledger absence supplies read-only reference; full, malformed and dangling paths refuse", () => {
  const dir = directory(), absent = join(dir,"missing");
  const before = readdirSync(dir, {recursive:true});
  const result = modelsView(["fable"], absent);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("reference; access unverified");
  expect(result.stdout).toContain("effort=high");
  expect(result.stdout).toContain("effort=medium");
  expect(modelsView(["--full"],absent).exit).toBe(1);
  expect(readdirSync(dir,{recursive:true})).toEqual(before);
  writeFileSync(join(dir,"malformed"), "not a routing table");
  symlinkSync(absent,join(dir,"dangling"));
  writeFileSync(join(dir,"unreadable"),"private"); chmodSync(join(dir,"unreadable"),0);
  for (const path of [join(dir,"malformed"),join(dir,"dangling"),join(dir,"unreadable"),dir]) {
    for (const view of [modelsView([],path),calibrationView({agents:[]},"",false,path)]) {
      expect(view.exit).toBe(1); expect(view.stdout).toBe("");
    }
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

test("a BOM is not Python whitespace in a disposition heading", () => {
  const path = join(directory(), "ledger");
  writeFileSync(path, "## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n|x|m @ codex|openai|basic|\n###\ufeffx\nnot a disposition\n");
  expect(modelsView(["x"], path).stdout).not.toContain("not a disposition");
});

test("unjoined active seats remain tier-zero targets, and an empty candidate set is empty", () => {
  const path = join(directory(), "ledger");
  writeFileSync(path, "## Routing table\n|handle|model @ harness|family|tier|\n|-|-|-|-|\n");
  expect(calibrationView({agents:[{handle:"unjoined",status:"active"},{handle:"offline",status:"suspended"}]}, "", true, path).stdout).toBe("unjoined\n");
  expect(calibrationView({agents:[]}, "", true, path).stdout).toBe("");
});

test("models is registry-independent through native and shell doors", () => {
  const dir = directory(), home = join(dir,"home"), index = join(dir,"index"), cwd = join(dir,"unenrolled");
  for (const path of [home,index,cwd]) mkdirSync(path);
  const path = join(dir,"ledger.md");
  writeFileSync(path, golden.ledgers[0]!);
  writeFileSync(join(index,"global-registry.json"), "{broken registry");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME:home, TAP_INDEX_HOME:index, TAP_MODELS_LEDGER:path,
    TAP_HOME:join(dir,"absent-bus"), TAP_VERBOSE:"0" };
  delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const doors = [["bun",join(root,"runtime/bun/main.ts")], ["bash",join(root,"scripts/tap.sh")], ["bash",join(root,"bin/tap")]];
  const before = readdirSync(dir,{recursive:true}).sort();
  for (const door of doors) for (const args of [[],["--verbose"],["--v"],["-v"],["opus","--all"],["--full=x"]]) {
    // Raw Bun starts before the owner can configure its cache. Shipped shell
    // entrances must set the pin themselves, including a fresh HOME.
    const runEnv: NodeJS.ProcessEnv = {...env};
    if (door[0] === "bun") runEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    const result = spawnSync(door[0]!,[...door.slice(1),"models",...args],{cwd,env:runEnv,encoding:"utf8"});
    expect({exit:result.status,stdout:result.stdout,stderr:result.stderr},`${door.join(" ")} models ${args.join(" ")}`).toEqual(modelsView(args,path));
  }
  expect(readdirSync(dir,{recursive:true}).sort()).toEqual(before);
  expect(readFileSync(join(index,"global-registry.json"),"utf8")).toBe("{broken registry");
}, 30000);

test("exact public help keeps its dispatcher; abbreviated or trailing help keeps argparse text", () => {
  const cwd = directory();
  const env = {...process.env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0",TAP_VERBOSE:"0"};
  const publicHelp = spawnSync("bash",[join(root,"scripts/tap.sh"),"help","models"],{cwd,env,encoding:"utf8"});
  expect(publicHelp.status).toBe(0);
  for (const door of [["bun",join(root,"runtime/bun/main.ts")],["bash",join(root,"scripts/tap.sh")]]) {
    const exact = spawnSync(door[0]!,[...door.slice(1),"models","--help"],{cwd,env,encoding:"utf8"});
    expect(exact.status).toBe(0);
    expect(exact.stdout).toBe(publicHelp.stdout);
    for (const args of [["--h"],["opus","--help"]]) {
      const result = spawnSync(door[0]!,[...door.slice(1),"models",...args],{cwd,env,encoding:"utf8"});
      expect({exit:result.status,stdout:result.stdout,stderr:result.stderr}).toEqual(modelsView(args));
    }
  }
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
const dir = process.env.TEST_ROSTER_RESPONSES, team = process.argv[4];
const log = event => fs.appendFileSync(path.join(dir,"calls"), JSON.stringify({event,team,pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),pin:process.env.TAP_HOME})+"\\n");
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
    const named = run(["teams","beta","--json"]);
    expect(named.status,named.stderr).toBe(0);
    expect(JSON.parse(named.stdout).agents.map((a:{handle:string})=>a.handle)).toEqual(["beta"]);
    const missing = run(["teams","missing"]);
    expect({exit:missing.status,stdout:missing.stdout,stderr:missing.stderr}).toEqual({exit:1,stdout:"",stderr:"tap teams: no enrolled team 'missing' in the machine index\n"});
    const bad = run(["team","list","--unknown"]);
    expect(bad.status).toBe(2); expect(bad.stdout).toBe("");
  }
  expect(readFileSync(beta.registry,"utf8")).toContain('"beta"');
  const ttyEnv = {...process.env}; delete ttyEnv.NO_COLOR;
  const tty = (args: string[]) => spawnSync("python3",["-B","-c",
    "import os,pty,sys; raise SystemExit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
    process.execPath,join(root,"runtime/bun/main.ts"),...args],{encoding:"utf8",cwd:fx.dir,env:ttyEnv,timeout:20000});
  const color = tty(["teams"]), captured = tty(["team","list"]);
  expect(color.status,color.stderr).toBe(0); expect(color.stdout).toContain("\x1b[34m●\x1b[0m idle");
  expect(captured.status,captured.stderr).toBe(0);
  expect(captured.stdout.replaceAll("\r","")).toBe(expected.stdout+"to see seats on this team: tap team (or tap team roster)\n");
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
