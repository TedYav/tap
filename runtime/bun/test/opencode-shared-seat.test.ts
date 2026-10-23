import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matchingSharedSeat, verifySharedSeat } from "../src/opencode-shared-seat";
import type { OpenCodeCaller } from "../src/opencode-shared";
import { removeScratchTree } from "./support/scratch";
import { resolveSharedContext } from "../src/opencode-shared-context";
import { attestOpenCodeCaller, type SharedObservationIO } from "../src/opencode-shared";

const work = mkdtempSync(join(tmpdir(), "shared-seat-"));
afterAll(() => removeScratchTree(work));
let count = 0;
function fixture() {
  const root = join(work, String(count++)), index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
  for (const dir of [index, join(root, ".tap")]) mkdirSync(dir, { recursive: true });
  const service = { id: "service", pid: 10, start: 100000, url: "http://127.0.0.1:12345", version: "2.1.2", file: join(root, "state/opencode/service.json") };
  const proof: Extract<OpenCodeCaller, { kind: "verified" }> = { kind: "verified", sessionId: "ses_alpha", rootSessionId: "ses_alpha", shellPid: 20, shellStart: 101000, directory: root, service };
  const row:any = { harness: "opencode", harness_session_id: "ses_alpha", status: "active", delivery: "pane", instance: "alpha|one",
    pane: "t/alpha:0.0", pane_id: "%1", session: "t/alpha", server_epoch: "srv:100:200", server_socket: "/private/socket",
    opencode_server_mode: "shared", opencode_service: service };
  const doc = { schema: "0.20", team: { name: "t", worktree_root: root }, seats: { alpha: row } as Record<string,any> };
  const machine = { schema: "0.20", teams: { t: { root, registry_location: registry, state: "registered" } } as Record<string,any> };
  const save = () => { writeFileSync(registry, JSON.stringify(doc)); writeFileSync(join(index, "global-registry.json"), JSON.stringify(machine)); };
  save();
  return {root,index,registry,proof,row,doc,machine,save,run:()=>matchingSharedSeat(proof,{...process.env,TAP_INDEX_HOME:index})};
}

test("native root session matches one launcher-owned shared seat and its instance", () => {
  const f = fixture(); expect(f.run()).toMatchObject({ kind: "matched", handle: "alpha", team: "t", row: { instance: "alpha|one" } });
});

for(const [field,value] of [["status","suspended"],["status_reason","launching"],["delivery","poll"],["opencode_server_mode","private"],["instance",""]] as const) {
  test(`no shared authority from ${field}=${value}`,()=>{const f=fixture(); f.row[field]=value;f.save();expect(f.run().kind).toBe("refused");});
}

test("a service successor cannot inherit an old row",()=>{
  const f=fixture();f.proof.service={...f.proof.service,id:"successor"};expect(f.run()).toMatchObject({kind:"refused",reason:"service_generation"});
});

test("duplicate root session claims across teams refuse",()=>{
  const f=fixture(), other=join(f.root,"other.json");
  writeFileSync(other,JSON.stringify({...f.doc,team:{name:"other"}}));
  f.machine.teams.other={root:f.root,registry_location:other,state:"registered"};f.save();
  expect(f.run()).toMatchObject({kind:"refused",reason:"session_ambiguous"});
});

test("unreadable enrolled registry leaves machine uniqueness unproven",()=>{
  const f=fixture();f.machine.teams.other={root:f.root,registry_location:join(f.root,"missing"),state:"registered"};f.save();
  expect(f.run()).toMatchObject({kind:"refused",reason:"index_unverified"});
});

test("a different index cannot fall back to cwd or service bus",()=>{
  const f=fixture();expect(matchingSharedSeat(f.proof,{...process.env,TAP_INDEX_HOME:join(f.root,"absent")})).toMatchObject({kind:"refused",reason:"index_unverified"});
});

test("child proof selects only the native root row",()=>{
  const f=fixture();f.proof.sessionId="ses_child";expect(f.run()).toMatchObject({kind:"matched",handle:"alpha"});
});

function verifiedFixture() {
  const f = fixture();
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: f.index, TMUX_PANE: "%1", TAP_TMUX_SOCKET_PATH: "/private/socket", TAP_HOME: join(f.root, ".tap/bus") };
  const pane = { paneId: "%1", session: "t/alpha", serverEpoch: "srv:100:200" };
  return { ...f, env, pane, runVerified: () => verifySharedSeat(f.proof, env, () => pane) };
}
test("root shell verifies its pane and socket before returning the seat", () => {
  const f = verifiedFixture(); expect(f.runVerified()).toMatchObject({ kind: "verified", pane: f.pane });
});
for (const explicit of [false, true]) {
  test(`verified seat preserves the ${explicit ? "explicit" : "index-derived"} lock root when pinning its bus`, () => {
    const f = verifiedFixture();
    const locks = explicit ? join(f.root, "custom-locks") : join(f.index, "locks");
    f.env.TAP_LOCK_DIR = explicit ? locks : undefined;
    const result = f.runVerified();
    expect(result.kind).toBe("verified");
    if (result.kind === "verified") expect(result.env.TAP_LOCK_DIR).toBe(locks);
  });
}
test("second TUI pane environment cannot move the recorded seat", () => {
  const f = verifiedFixture(); f.env.TMUX_PANE = "%2";
  expect(f.runVerified()).toMatchObject({ kind: "refused", reason: "pane_environment" });
});
test("a root shell with missing or changed socket pins refuses", () => {
  const f = verifiedFixture(); f.env.TAP_TMUX_SOCKET_PATH = "/other/socket";
  expect(f.runVerified()).toMatchObject({ kind: "refused", reason: "pane_environment" });
});
test("native child shell derives root pins without inheriting service pane or bus", () => {
  const f = verifiedFixture(); f.proof.sessionId = "ses_child";
  f.env.TMUX_PANE = "%999"; f.env.TAP_TMUX_SOCKET_PATH = "/wrong"; f.env.TAP_HOME = "/other/bus";
  const result = f.runVerified(); expect(result.kind).toBe("verified");
  if (result.kind === "verified") expect([result.env.TMUX_PANE, result.env.TAP_TMUX_SOCKET_PATH, result.env.TAP_HOME])
    .toEqual(["%1", "/private/socket", join(realpathSync(f.root), ".tap/bus")]);
});
test("changed tmux generation refuses even with a valid shell witness", () => {
  const f = verifiedFixture(); f.pane.serverEpoch = "successor";
  expect(f.runVerified()).toMatchObject({ kind: "refused", reason: "pane_generation" });
});
test("a second pane claimant vetoes native session identity", () => {
  const f = verifiedFixture(); f.doc.seats.beta = { ...f.row, harness: "codex", harness_session_id: "other" }; f.save();
  expect(f.runVerified()).toMatchObject({ kind: "refused", reason: "pane_ambiguous" });
});
test("retired seat instance during pane observation refuses", () => {
  const f = verifiedFixture();
  expect(verifySharedSeat(f.proof, f.env, () => { f.row.instance = "alpha|two"; f.save(); return f.pane; }))
    .toMatchObject({ kind: "refused", reason: "seat_generation" });
});

function contextFixture() {
  const f = fixture();
  const processes = new Map([
    [process.pid, { pid: process.pid, ppid: 10, start: 101000, command: "bun", args: "bun context-shared" }],
    [10, { pid: 10, ppid: 1, start: 100000, command: "opencode", args: "opencode serve --service" }],
  ]);
  const env = { TAP_INDEX_HOME: f.index, TMUX_PANE: "%99", TAP_HOME: "/service-bus", TAP_TMUX_SOCKET_PATH: "/service-socket" };
  const io: SharedObservationIO = { processes: () => processes, service: () => f.proof.service,
    api: (_s, path) => path.startsWith("/api/session/") ? { data: { id: "ses_alpha", location: { directory: f.root } } }
      : { location: { directory: f.root }, data: [] } };
  const observe = (_target: string, pins: NodeJS.ProcessEnv) => {
    expect(pins.TMUX_PANE).toBe("%1"); expect(pins.TAP_TMUX_SOCKET_PATH).toBe("/private/socket");
    return { paneId: "%1", session: "t/alpha", serverEpoch: "srv:100:200" };
  };
  return { ...f, processes, io, env, observe, context: () => resolveSharedContext("ses_alpha", f.root, env, io, observe) };
}
test("explicit shared context uses the requested root's pins and grants no shell identity", () => {
  const f = contextFixture(); expect(f.context()).toMatchObject({ kind: "verified", match: { handle: "alpha" } });
  expect(attestOpenCodeCaller({ ...f.env, OPENCODE_SESSION_ID: "ses_alpha" }, process.pid, f.io))
    .toMatchObject({ kind: "refused", reason: "not_shell" });
});
test("shared context waits for launcher activation and cannot promote its row", () => {
  const f = contextFixture(); f.row.status_reason = "launching"; f.save();
  expect(f.context()).toMatchObject({ kind: "refused", reason: "seat_inactive" });
  expect(f.run()).toMatchObject({ kind: "refused", reason: "seat_inactive" });
});
test("an unrelated process cannot request shared context by environment alone", () => {
  const f = contextFixture(); f.processes.get(process.pid)!.ppid = 1;
  expect(f.context()).toMatchObject({ kind: "refused", reason: "not_shared_service" });
});
test("context helper process rebirth during API observation refuses", () => {
  const f = contextFixture(), api = f.io.api;
  f.io.api = (...args) => { f.processes.get(process.pid)!.start++; return api(...args); };
  expect(f.context()).toMatchObject({ kind: "refused", reason: "process_generation" });
});
