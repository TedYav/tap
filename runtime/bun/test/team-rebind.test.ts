import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createOpenCodeStore, addSession } from "./support/opencode-store";
import { createHash } from "node:crypto";
import { cmdTeamDoctor, observeBinding, boundStoreMatches, type Binding } from "../src/team/doctor";
import { harnessWorkdir } from "../src/launcher/workdir";
import { removeScratchTree } from "./support/scratch";
const roots: string[] = [];
const cwd = process.cwd(), env = {...process.env};
// cmdTeamDoctor's default (non-json) report writes human-readable outcome lines
// ("skipped", "repaired", ...) straight to process.stdout for the in-process
// calls below; none of these tests assert on that text (registry bytes and
// return codes carry the assertions), but the suite runner's undeclared-skip
// scanner flags any bare "skip(ped)" text in a file's own retained log. Muting
// keeps that real CLI output from being mistaken for an undeclared test skip;
// the spawnSync-based door tests capture their own subprocess stdout and are
// unaffected by this process's write patch.
let originalWrite: typeof process.stdout.write;
beforeEach(() => { originalWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (() => true) as typeof process.stdout.write; });
afterEach(() => { process.stdout.write = originalWrite; process.chdir(cwd); process.env = {...env}; for(const root of roots.splice(0)) removeScratchTree(root); });
const binding: Binding = {
  pane:{paneId:"%1",session:"team/seat",serverEpoch:"srv:1:2",panePid:"101",currentCommand:"claude"},
  identity:{harness:"claude",harness_session_id:"new",store_path:"/new.jsonl",store_kind:"file",trust:"process",candidates:1,detail:"verified process",derived_at:"now"},
};
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"team-rebind."))); roots.push(root);
  const index=join(root,"index"), bus=join(root,".tap/bus"), registry=join(root,".tap/team-registry.json");
  mkdirSync(index); mkdirSync(bus,{recursive:true});
  writeFileSync(join(index,"global-registry.json"), JSON.stringify({schema:"0.20",migrated:{},teams:{team:{root,registry_location:registry,state:"registered",enrolled_at:"2026-09-01T00:00:00Z"}}}));
  const row = {status:"active",harness:"claude",harness_session_id:"old",transcript_path:"/old.jsonl",instance:"seat|stable",pane_id:"%1",note:"preserved",identity_capture:{expected_harness_session_id:"old"}};
  const put=(seats:Record<string,unknown>)=>writeFileSync(registry,JSON.stringify({schema:"0.20",team:{name:"team",worktree_root:root},seats}));
  put({seat:row});
  process.chdir(root); process.env.TAP_INDEX_HOME=index; process.env.TAP_HOME=bus;
  delete process.env.TAP_TEAM_SELECT; delete process.env.TAP_TEAM_OVERRIDE_BUS;
  return {registry,row,put,raw:()=>readFileSync(registry,"utf8"),get:()=>JSON.parse(readFileSync(registry,"utf8"))};
}
test("default report does not write; fix updates identity pair and preserves seat custody",()=>{
 const f=fixture(), before=f.raw();
 expect(cmdTeamDoctor([],()=>({binding}))).toBe(0); expect(f.raw()).toBe(before);
 expect(cmdTeamDoctor(["--only","session-binding"],()=>({binding}))).toBe(0); expect(f.raw()).toBe(before);
 expect(cmdTeamDoctor(["--fix","--only","session-binding"],()=>({binding}))).toBe(0);
 const row=f.get().seats.seat;
 expect(row).toMatchObject({instance:"seat|stable",pane_id:"%1",note:"preserved",harness_session_id:"new",transcript_path:"/new.jsonl",identity_capture_result:{mode:"operator_rebind",previous:{harness_session_id:"old"}}});
 expect(row.identity_capture).toBeUndefined();
 const repaired=f.raw();cmdTeamDoctor(["--fix"],()=>({binding}));expect(f.raw()).toBe(repaired);
});
test("uncertainty, concurrent registration and a changed session leave bytes untouched",()=>{
 for(const mode of ["unknown","session_changed","row_changed"]){
  const f=fixture();let calls=0;const before=f.raw();
  cmdTeamDoctor(["--fix"],()=>{ calls++; if(mode==="unknown")return {reason:"unobservable"};
   if(mode==="row_changed") {f.put({seat:{...f.row,note:"concurrent"}});return {binding};}
   return {binding:calls===1?binding:{...binding,identity:{...binding.identity,harness_session_id:"third"}}};
  });
  if(mode==="row_changed")expect(f.get().seats.seat).toEqual({...f.row,note:"concurrent"});else expect(f.raw()).toBe(before);
 }
});
test("duplicate owner and invalid selection refuse repair",()=>{
 const f=fixture();f.put({seat:f.row,other:{...f.row,harness_session_id:"new",transcript_path:"/new.jsonl"}});const before=f.raw();
 cmdTeamDoctor(["--fix","--only","session-binding"],()=>({binding}));expect(f.raw()).toBe(before);
 expect(()=>cmdTeamDoctor(["--only","missing"],()=>({binding}))).toThrow("unknown check");
 for(const argv of [["--only"],["--only","seat,"],["--wat"]])expect(()=>cmdTeamDoctor(argv)).toThrow();
});
test("unobservable rows never authorize repair",()=>{
 expect(observeBinding({status:"offline"}).binding).toBeUndefined();
 expect(observeBinding({status:"active",harness:"opencode"}).binding).toBeUndefined();
 expect(observeBinding({harness:"opencode"}).reason).toContain("namespace");
});

test("public native door exposes doctor and validates only before effects",()=>{
 const f=fixture(), before=f.raw();
 const run=spawnSync(process.execPath,[resolve(import.meta.dir,"../main.ts"),"team","doctor","--only","missing","--json"],{encoding:"utf8",env:process.env,cwd:process.cwd()});
 expect(run.status).toBe(1);expect(JSON.parse(run.stdout).detail).toContain("unknown check");expect(run.stderr).toBe("");expect(f.raw()).toBe(before);
});

test("team doctor report uses the doctor envelope without registry writes",()=>{
 const f=fixture(), before=f.raw();
 const run=spawnSync(process.execPath,[resolve(import.meta.dir,"../main.ts"),"team","doctor","--only","session-binding","--json"],{encoding:"utf8",env:process.env,cwd:process.cwd()});
 expect(run.status).toBe(0);
 const report=JSON.parse(run.stdout);
 expect(report).toMatchObject({ok:true,bus:{home:process.env.TAP_HOME},summary:{torn:0,unattributed:0,clean:true}});
 expect(report.findings[0]).toMatchObject({name:"session-binding",severity:"warning",detail:{handle:"seat",outcome:"skipped"}});
 expect(f.raw()).toBe(before);
});

test("bin/tap entry reaches native doctor without touching the legacy team owner",()=>{
 const f=fixture(), before=f.raw();
 const run=spawnSync("bash",[resolve(import.meta.dir,"../../../bin/tap"),"team","doctor","--only","missing","--json"],{encoding:"utf8",env:process.env,cwd:process.cwd()});
 expect(run.status).toBe(1);expect(JSON.parse(run.stdout).detail).toContain("unknown check");expect(f.raw()).toBe(before);
});
test("team doctor names an agents-axis, hybrid or non-object-seats registry old_store",()=>{
 const f=fixture();
 const refusal=()=>{ try { cmdTeamDoctor([],()=>({binding})); } catch (error) { return error as {errorClass:string;action:string;detail:string}; } throw new Error("expected a refusal"); };
 writeFileSync(f.registry,JSON.stringify({schema:"0.20",team:{name:"team"},agents:{seat:f.row}}));
 const old=refusal();
 expect(old.errorClass).toBe("old_store");
 expect(old.detail).toBe(`${f.registry} is an old TAP registry format ("agents" map); this TAP reads only {"schema":"0.20","team":{...},"seats":{...}} team registries and never converts old files`);
 expect(old.action).toContain('rename "agents" to "seats"');
 const hybrid=JSON.stringify({schema:"0.20",team:{name:"team"},seats:{seat:f.row},agents:{old:f.row}});
 writeFileSync(f.registry,hybrid);
 expect(refusal().errorClass).toBe("old_store");
 expect(f.raw()).toBe(hybrid);
 writeFileSync(f.registry,JSON.stringify({schema:"0.20",team:{name:"team"},seats:[f.row]}));
 const invalid=refusal();
 expect(invalid.errorClass).toBe("old_store");
 expect(invalid.detail).toBe(`${f.registry} is an old TAP registry format (seats not an object); this TAP reads only {"schema":"0.20","team":{...},"seats":{...}} team registries and never converts old files`);
});

function captureDoctor(argv: string[], observe: Parameters<typeof cmdTeamDoctor>[1], tty = false) {
  let stdout = "", stderr = "";
  const outTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const errTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const outWrite = process.stdout.write, errWrite = process.stderr.write;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty });
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof outWrite;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof errWrite;
  try { cmdTeamDoctor([...argv, "--only", "session-binding"], observe); return { stdout, stderr }; }
  finally {
    process.stdout.write = outWrite; process.stderr.write = errWrite;
    if (outTTY) Object.defineProperty(process.stdout, "isTTY", outTTY); else Reflect.deleteProperty(process.stdout, "isTTY");
    if (errTTY) Object.defineProperty(process.stderr, "isTTY", errTTY); else Reflect.deleteProperty(process.stderr, "isTTY");
  }
}

test("human doctor hides healthy rows but retains warnings and repair receipts", () => {
  const f = fixture();
  f.put({healthy: {...f.row, harness_session_id: "new", transcript_path: "/new.jsonl"}});
  expect(captureDoctor([], () => ({binding}))).toEqual({stdout: "✓ no issues detected\n", stderr: ""});
  f.put({healthy: {...f.row, harness_session_id: "new", transcript_path: "/new.jsonl"}, uncertain: f.row});
  const mixed = captureDoctor([], row => row.harness_session_id === "new" ? {binding} : {reason: "unobservable"});
  expect(mixed.stdout).toBe("tap team doctor: not checked\n  uncertain: unobservable\n");
  expect(mixed.stderr).toBe("");
  f.put({seat: f.row});
  expect(captureDoctor([], () => ({binding})).stdout).toContain("would_repair (old -> new)");
  expect(captureDoctor(["--fix"], () => ({binding})).stdout).toContain("repaired (old -> new)");
  f.put({});
  expect(captureDoctor([], () => ({binding})).stdout).toBe("✓ no issues detected\n");
});

test("doctor terminal progress and colors respect output mode and environment", () => {
  const f = fixture();
  f.put({seat: {...f.row, harness_session_id: "new", transcript_path: "/new.jsonl"}});
  process.env.TERM = "xterm-256color"; delete process.env.NO_COLOR;
  const tty = captureDoctor([], () => ({binding}), true);
  expect(tty.stdout).toBe("\x1b[32m✓ no issues detected\x1b[0m\n");
  expect(tty.stderr).toBe("\r\x1b[2KScanning 1/1: seat\r\x1b[2K");
  expect(captureDoctor([], () => ({reason: "unobservable"}), true).stdout).toBe("\x1b[33mtap team doctor: not checked\n  seat: unobservable\n\x1b[0m");
  process.env.NO_COLOR = "";
  expect(captureDoctor([], () => ({reason:"unobservable"}), true).stdout).toBe("tap team doctor: not checked\n  seat: unobservable\n");
  expect(captureDoctor([], () => ({binding}), true).stdout).toBe("✓ no issues detected\n");
  delete process.env.NO_COLOR; process.env.TERM = "dumb";
  expect(captureDoctor([], () => ({binding}), true)).toEqual({stdout: "✓ no issues detected\n", stderr: ""});
  process.env.TERM = "xterm-256color";
  expect(captureDoctor([], () => ({binding}))).toEqual({stdout: "✓ no issues detected\n", stderr: ""});
  const json = captureDoctor(["--json"], () => ({binding}), true);
  expect(json.stderr).toBe(""); expect(json.stdout).not.toContain("\x1b");
  expect(JSON.parse(json.stdout).findings[0].detail.outcome).toBe("unchanged");
});

for (const harness of ["opencode", "cursor"]) test(`${harness} doctor checks the registered native store without choosing another conversation`, () => {
  const f = fixture(), root = process.cwd(), home = join(root,"home"), bin = join(root,"bin");
  mkdirSync(bin); mkdirSync(home);
  const id = harness === "cursor" ? "11111111-1111-4111-8111-111111111111" : "ses_fixture";
  let path: string;
  if (harness === "opencode") {
    path = join(root,"opencode.db");
    const db = createOpenCodeStore(path);
    addSession(db,id,root);
    addSession(db,"ses_other",root);
    db.close();
  } else {
    const dir = join(home,".cursor/chats",createHash("md5").update(root).digest("hex"),id);
    mkdirSync(dir,{recursive:true}); path = join(dir,"store.db"); writeFileSync(path,"opaque native store");
  }
  writeFileSync(join(bin,"tmux"), `#!/bin/sh
case "$*" in
  *pane_id*) printf '%%1\tteam/seat\t101\t${harness}\t0\n' ;;
  *) printf '1:2\n' ;;
esac
`,{mode:0o755});
  Object.assign(process.env,{HOME:home,PATH:`${bin}:${process.env.PATH}`,TAP_BOOT_ID:"boot:fixture",TAP_SERVER_EPOCH:"srv:1:2",TAP_TMUX_SOCKET_PATH:join(root,"fixture.sock")});
  const row = {...f.row,harness,harness_session_id:id,transcript_path:undefined,session_store_path:harness === "opencode" ? path : undefined,
    registered_from_worktree:root,session:"team/seat",server_socket:join(root,"fixture.sock"),server_epoch:"srv:1:2",boot_id:"boot:fixture"};
  expect(boundStoreMatches(row,home)).toBe(true);
  f.put({seat:row}); const before=f.raw();
  const child = spawnSync(process.execPath,[resolve(import.meta.dir,"../main.ts"),"team","doctor","--fix","--json"],{encoding:"utf8",env:process.env,cwd:root});
  expect(child.status,child.stderr).toBe(0);
  const report=JSON.parse(child.stdout);
  expect(report.findings[0].detail.outcome).toBe("unchanged");
  expect(f.raw()).toBe(before);
  if (harness === "opencode") {
    const db = new Database(path); db.exec("DROP TABLE session_message"); db.close();
    const invalid = spawnSync(process.execPath,[resolve(import.meta.dir,"../main.ts"),"team","doctor","--only","session-binding","--json"],{encoding:"utf8",env:process.env,cwd:root});
    const bad = JSON.parse(invalid.stdout);
    expect(bad.findings[0].detail.outcome).toBe("invalid");
    expect(bad.summary.clean).toBe(false);
    expect(f.raw()).toBe(before);
  }
  expect(boundStoreMatches({...row,harness_session_id:"missing"},home)).toBe(false);
  expect(boundStoreMatches({...row,registered_from_worktree:home},home)).toBe(false);
  writeFileSync(join(bin,"tmux"),readFileSync(join(bin,"tmux"),"utf8").replace(`\t${harness}\t`,"\tvim\t"));
  const unknown = spawnSync(process.execPath,[resolve(import.meta.dir,"../main.ts"),"team","doctor","--only","session-binding","--json"],{encoding:"utf8",env:process.env,cwd:root});
  expect(JSON.parse(unknown.stdout).findings[0].detail).toMatchObject({outcome:"skipped",detail:"pane is not running the registered harness"});
});

test("OpenCode worktree identity does not collapse a symlink alias", () => {
  fixture();
  const root = process.cwd(), alias = join(root,"alias"), path = join(root,"opencode.db");
  symlinkSync(root,alias);
  const db = createOpenCodeStore(path);
  addSession(db,"ses_fixture",alias);
  const row = {harness:"opencode",harness_session_id:"ses_fixture",registered_from_worktree:root,session_store_path:path};
  try {
    expect(boundStoreMatches(row)).toBe(false);
    db.query("UPDATE session_v2 SET directory = ?").run(root + "/./");
    expect(boundStoreMatches(row)).toBe(true);
  } finally { db.close(); }
});

// --- discuss-2026-09-25-doctor-ambiguous: harness workdir, lazy transcript, skip next ---

function home2(): string {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "team-rebind2.")));
  roots.push(h);
  return h;
}

test("harnessWorkdir prefers launch_workdir and falls back to the registration anchor", () => {
  expect(harnessWorkdir({launch_workdir: "/launch", registered_from_worktree: "/anchor"})).toBe("/launch");
  expect(harnessWorkdir({registered_from_worktree: "/anchor"})).toBe("/anchor");
  expect(harnessWorkdir({launch_workdir: "", registered_from_worktree: "/anchor"})).toBe("/anchor");
  expect(harnessWorkdir({})).toBe("");
});

test("cursor store check keys on the harness workdir, not the registration anchor", () => {
  const hm = home2(), launch = home2(), anchor = home2();
  const launchHash = createHash("md5").update(launch).digest("hex");
  const id = "11111111-1111-4111-8111-111111111111";
  mkdirSync(join(hm, ".cursor", "chats", launchHash, id), {recursive:true});
  writeFileSync(join(hm, ".cursor", "chats", launchHash, id, "store.db"), "opaque");
  const row = {harness:"cursor", harness_session_id:id, registered_from_worktree:anchor, launch_workdir:launch};
  expect(boundStoreMatches(row, hm)).toBe(true);
  expect(boundStoreMatches({...row, launch_workdir:undefined}, hm)).toBe(false);
});

/** Fake ps/lsof/tmux bin + pinned env; the door runs as a SUBPROCESS because
 * Bun's os.homedir() does not reflect a runtime-mutated process.env.HOME, so
 * in-process observeBinding calls would read the runner's home, not ours. */
function processTierFixture(harness: "claude" | "codex", ps: string, lsof: string) {
  const f = fixture();
  const root = process.cwd(), home = join(root, "home"), bin = join(root, "bin");
  mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat <<'EOF'\n${ps}\nEOF\n`, {mode: 0o755});
  writeFileSync(join(bin, "lsof"), `#!/bin/sh\ncat <<'EOF'\n${lsof}\nEOF\n`, {mode: 0o755});
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\n" +
    "case \"$*\" in\n" +
    "  *pane_id*) printf '%%1\tteam/seat\t100\t" + harness + "\t0\n' ;;\n" +
    "  *) printf '1:2\n' ;;\n" +
    "esac\n", {mode: 0o755});
  Object.assign(process.env, {HOME: home, PATH: `${bin}:${process.env.PATH}`, TAP_BOOT_ID: "boot:fixture",
    TAP_SERVER_EPOCH: "srv:1:2", TAP_TMUX_SOCKET_PATH: join(root, "fixture.sock")});
  const row = {...f.row, harness, harness_session_id: undefined as unknown as string, transcript_path: undefined as unknown as string,
    launch_workdir: home2(), registered_from_worktree: root, session: "team/seat",
    server_socket: join(root, "fixture.sock"), server_epoch: "srv:1:2", boot_id: "boot:fixture", pane_id: "%1"};
  const door = (extra: Record<string, unknown> = {}) => {
    f.put({seat: {...row, ...extra}});
    const run = spawnSync(process.execPath, [resolve(import.meta.dir, "../main.ts"), "team", "doctor", "--json"],
      {encoding: "utf8", env: process.env, cwd: root});
    expect(run.status, run.stderr + run.stdout).toBe(0);
    return JSON.parse(run.stdout).findings.filter((finding: {name: string}) => finding.name === "session-binding");
  };
  return {f, row, home, door};
}

test("claude seat with launch_workdir binds via its live record without a transcript file", () => {
  const sid = "11111111-1111-4111-8111-111111111111";
  const ps = "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 claude\n";
  const {row, home, door} = processTierFixture("claude", ps, "");
  const sessions = join(home, ".claude", "sessions"); mkdirSync(sessions, {recursive:true});
  writeFileSync(join(sessions, "101.json"), JSON.stringify({pid:101, sessionId:sid, cwd:row.launch_workdir, procStart:"Fri Sep  5 01:00:01 2026", kind:"interactive"}));
  // Row already carries the live-record identity (env-captured at launch); the
  // transcript file does not exist (lazy creation). F1: the doctor must key on
  // launch_workdir to validate the manifest at all; F3: identity without file.
  const transcript = join(home, ".claude", "projects", row.launch_workdir.replaceAll("/", "-"), `${sid}.jsonl`);
  const findings = door({harness_session_id: sid, transcript_path: transcript});
  expect(findings[0]?.detail).toMatchObject({handle: "seat", outcome: "unchanged"});
});

test("codex seat whose lsof reports no fcwd skips with a re-run remediation", () => {
  const sid = "11111111-1111-4111-8111-111111111111";
  const ps = "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 codex\n";
  const {row, home, door} = processTierFixture("codex", ps, "");
  const day = join(home, ".codex", "sessions", "2026", "09", "05"); mkdirSync(day, {recursive:true});
  const rollout = join(day, `rollout-2026-09-05T01-00-00-${sid}.jsonl`);
  writeFileSync(rollout, `${JSON.stringify({type:"session_meta", payload:{id:sid, cwd:row.launch_workdir}})}\n`);
  const findings = door({harness_session_id: sid, transcript_path: rollout});
  expect(findings[0]?.detail).toMatchObject({outcome: "skipped", detail: "lsof did not report the harness process's working directory"});
  expect(findings[0]?.next).toBe("re-run tap team doctor");
});

test("codex seat whose process cwd differs from the workdir skips with the relaunch remediation", () => {
  const ps = "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 codex\n";
  const {door} = processTierFixture("codex", ps, "p101\nfcwd\nn/somewhere/else\n");
  const findings = door();
  expect(findings[0]?.detail).toMatchObject({outcome: "skipped", detail: "harness process working directory does not match the seat's workdir"});
  expect(findings[0]?.next).toBe("relaunch the seat from its workdir (tap clear starts a fresh conversation), then re-run tap team doctor");
});

test("codex seat with sibling harness processes skips with the re-register remediation", () => {
  const ps = "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 codex\n102 100 Fri Sep  5 01:00:01 2026 codex\n";
  const {door} = processTierFixture("codex", ps, "");
  const findings = door();
  expect(findings[0]?.detail).toMatchObject({outcome: "skipped", detail: "harness process under the pane is absent or ambiguous"});
  expect(findings[0]?.next).toBe("re-register from inside the seat's pane (run tap in there)");
});

test("skipped rows render and serialize their remediation next", () => {
  const f = fixture();
  const human = captureDoctor([], () => ({reason: "no observable session identity", next: "retry tap team doctor after the seat's next turn"}));
  expect(human.stdout).toBe("tap team doctor: not checked\n  seat: no observable session identity; next: retry tap team doctor after the seat's next turn\n");
  const json = captureDoctor(["--json"], () => ({reason: "no observable session identity", next: "retry tap team doctor after the seat's next turn"}));
  const finding = JSON.parse(json.stdout).findings[0];
  expect(finding.next).toBe("retry tap team doctor after the seat's next turn");
  expect(finding.detail.next).toBe("retry tap team doctor after the seat's next turn");
});
