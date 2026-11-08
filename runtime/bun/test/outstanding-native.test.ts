import { recordPhase } from "../src/submit-phase";
import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";
import { reapStaleSidecars } from "../src/spool-sidecar";
import { registryEventLine } from "../src/events";

const root = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "tap-outstanding-native-"));
afterAll(() => removeScratchTree(scratch));
let serial = 0;
function snapshot(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  function visit(dir: string) { for (const name of readdirSync(dir).sort()) { const p = join(dir, name); if (statSync(p).isDirectory()) visit(p); else out[p.slice(path.length)] = readFileSync(p).toString("base64"); } }
  visit(path); return out;
}
function fixture() {
  const base = join(scratch, String(serial++)), bus = join(base, ".tap", "bus"), index = join(base, "index");
  for (const p of [bus, index, join(base, "home"), join(bus, "payloads"), join(bus, "receipts"), join(bus, "spool"), join(bus, "tmp")]) mkdirSync(p, { recursive: true });
  writeFileSync(join(bus, ".tap-bus-authority"), "fixture\n");
  writeFileSync(join(base, ".tap", ".gitignore"), "*\n");
  const registry = join(bus, "registry.json");
  writeFileSync(registry, JSON.stringify({schema:"0.20", seats:{sender:{instance:"sender|current"},peer:{}}, team:{name:"tap",worktree_root:base}}));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({schema:"0.20",teams:{tap:{root:base,registry_location:registry,state:"registered"}}}));
  const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME:join(base,"home"), TAP_HOME:bus, TAP_INDEX_HOME:index, TAP_SELF:"sender", TAP_SPOOL_NOW:"1788603000", TAP_ROOT:root, TAP_REGISTRY:registry, TMUX:"", TMUX_PANE:"", TAP_VERBOSE:"0", TAP_GLOBAL_HOME:join(base,"global"), TAP_LOCKS:join(base,"locks") };
  const payload = (suffix: string, fields = "", parked = false) => {
    const id = `sender-20260905T100000Z-${suffix}`, p = join(bus, parked ? "spool" : "payloads", `${id}.md`);
    writeFileSync(p, `---\nid: ${id}\nfrom: sender\nto: peer\nkind: question\npath: ${p}\n${fields}---\nbody\n`); return id;
  };
  // The Bash door was deleted when the verb closed; every expectation here is
  // the recorded incumbent byte output, captured before the body was removed.
  const run = (args: string[], verbose = false, overrides: Record<string, string | undefined> = {}) => {
    const r = spawnSync(process.execPath, [join(root,"runtime/bun/test/support/native-outstanding-entry.ts"),...args], {env:{...env,...overrides,TAP_VERBOSE:verbose ? "1":"0"},encoding:"utf8",cwd:root});
    return {code:r.status,out:r.stdout,err:r.stderr};
  };
  const recorded = (args: string[], verbose = false) => {
    const before = snapshot(base), native = run(args,verbose);
    if(verbose) {
      const records=native.err.split("\n").filter(l=>l.startsWith("tap verbose: ")).map(l=>JSON.parse(l.slice(13)));
      expect(records.some(r=>r.event === "state_paths" && typeof r.registry === "string")).toBe(true);
      expect(records.some(r=>r.event === "state_read")).toBe(false);
    }
    expect(snapshot(base)).toEqual(before); return native;
  };
  return { base,bus,payload,run,recorded,env };
}

test("canonical receipts, obligations, instance filtering and stale preserve bytes", () => {
  const f = fixture();
  const ask = f.payload("aaaaaaaaaaaa","reply: expected\n");
  const note = f.payload("bbbbbbbbbbbb","reply: settle-only\n");
  const cancelled = f.payload("cccccccccccc");
  f.payload("dddddddddddd","sender_instance: sender|old\n");
  writeFileSync(join(f.bus,"receipts",`${cancelled}.cancelled`),"{}\n");
  writeFileSync(join(f.bus,"receipts",`${ask}.placed`),"{}\n");
  writeFileSync(join(f.bus,"receipts",`${note}.sent`),'{"delivery":"pane"}\n');
  writeFileSync(join(f.bus,"receipts",`${ask}.read`),'{"by":"other","forced":true}\n');
  writeFileSync(join(f.bus,"receipts",`${ask}.resent`),'{"by":"sender"}\n');
  for (const verbose of [false,true]) {
    const r = f.recorded([],verbose); expect(r.code).toBe(0); expect(r.out).toContain("rings it again under the same id"); expect(r.out).toContain("(forced), unanswered");
  }
  const r = f.recorded(["--json"]); expect(JSON.parse(r.out).outstanding).toHaveLength(2);
  f.recorded(["--stale","999999999"]);
});

for (const recovered of [false, true]) test(`orphan canonical custody agrees across show, outstanding and sender withdrawal; recovered=${recovered}`, () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "reply: expected\n");
  const body = readFileSync(join(f.bus, "payloads", `${id}.md`));
  writeFileSync(join(f.bus, "spool", `${id}.meta.json`), JSON.stringify({ id, attempts: 62, attempt_fence: 1, reason: "booting", next_probe_epoch: 1 }));
  writeFileSync(join(f.bus, "receipts", `${id}.placed`), "{}\n");
  recordPhase(f.bus, { id, attempt: "last", phase: "verify-result", recipient: "peer", enter_count: 0, result: "unverified" });
  if (recovered) reapStaleSidecars(join(f.bus, "spool"), join(f.bus, "payloads"), f.env);
  const cli = (...args: string[]) => spawnSync(join(root, "bin/tap"), args, { cwd: root, env: f.env, encoding: "utf8" });
  const before = snapshot(f.base);
  const outstanding = f.recorded(["--json"]), row = JSON.parse(outstanding.out).outstanding[0];
  expect(row.status).toBe("unverified");
  expect(row.queue_explanation).toContain("prior recipient effect unknown");
  expect(row.queue_explanation).not.toContain("stale-park");
  const shown = cli("show", id);
  expect(shown.status).toBe(0);
  expect(shown.stdout).toContain(row.queue_explanation);
  expect(snapshot(f.base)).toEqual(before);
  const noFlag = cli("cancel", id, "--by", "sender");
  expect(noFlag.status).toBe(1);
  expect(noFlag.stderr).toContain(row.queue_explanation);
  const cancelled = cli("cancel", id, "--by", "sender", "--spooled", "--json");
  expect(cancelled.status).toBe(0);
  expect(JSON.parse(cancelled.stdout).reason).toBe("unconfirmed_withdrawn");
  expect(readFileSync(join(f.bus, "archive", `${id}.cancelled.md`))).toEqual(body);
  expect(existsSync(join(f.bus, "spool", `${id}.meta.json`))).toBe(false);
  expect(existsSync(join(f.bus, "spool", `${id}.md`))).toBe(false);
  expect(existsSync(join(f.bus, "receipts", `${id}.submit-phases.jsonl`))).toBe(true);
});

test("positive delivery evidence overrides stale queue metadata and still refuses sender spool withdrawal", () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "reply: expected\n");
  writeFileSync(join(f.bus, "spool", `${id}.meta.json`), JSON.stringify({ id, attempts: 62, reason: "booting", next_probe_epoch: 1 }));
  writeFileSync(join(f.bus, "receipts", `${id}.sent`), "{}\n");
  const view = f.recorded([]);
  expect(view.out).not.toContain("stale-park");
  expect(view.out).not.toContain("Delivery unverified");
  const cancelled = spawnSync(join(root, "bin/tap"), ["cancel", id, "--by", "sender", "--spooled", "--json"], { cwd: root, env: f.env, encoding: "utf8" });
  expect(cancelled.status).toBe(1);
  expect(JSON.parse(cancelled.stdout).error_class).toBe("not_spooled");
  expect(existsSync(join(f.bus, "payloads", `${id}.md`))).toBe(true);
});

test("spool delivery uncertainty, digest state and display snapshot", () => {
  const f = fixture();
  const one = f.payload("aaaaaaaaaaaa","reply: expected\n",true);
  const two = f.payload("bbbbbbbbbbbb","reply: settle-only\nto_team: remote\n",true);
  writeFileSync(join(f.bus,"spool",`${one}.meta.json`),JSON.stringify({reason:"busy",attempts:0,attempt_fence:1}));
  writeFileSync(join(f.bus,"spool",`${two}.meta.json`),JSON.stringify({reason:"auto-settle",policy:"autosettle"}));
  for (const verbose of [false,true]) {
    const r = f.recorded([],verbose);
    // Mutation anchor: dropping the same-id resend hint from native rendering changes
    // the actual result and fails this predicate plus the Bash byte comparison.
    expect(r.out).toContain(`if it is still unread, tap resend ${one} rings it again under the same id. [unknown]`);
    expect(r.out).toContain("spooled for digest");
  }
  f.recorded(["--json"]);
});

test("unverified delivery conditions and empty/error exits agree", () => {
  const f = fixture(); f.recorded([]); f.recorded(["--json"]);
  const id = f.payload("aaaaaaaaaaaa");
  writeFileSync(join(f.bus,"registry-events.log"),`action=send_submit_unverified detail=id=${id}\naction=redelivery_submit_unverified detail=id=${id}\n`);
  f.recorded([]); f.recorded(["--json"]); f.recorded(["--stale","0"]); f.recorded(["--wat"]);
});

test("unverified conditions match the event id as a whole field, not a substring (tap-z63i)", () => {
  const f = fixture();
  const id = f.payload("aaaaaaaaaaaa");
  const log = join(f.bus, "registry-events.log");
  // Lines come from the real writer, so the folded shapes are the ones production logs.
  const line = (action: string, detail: string) => registryEventLine({ actor: "sender", action, handle: "peer", pane: "p", team: "tap", detail }) + "\n";
  const both = (detail: string) => line("send_submit_unverified", detail) + line("redelivery_submit_unverified", detail);
  const conditions = () => JSON.parse(f.recorded(["--json"]).out).spool_conditions as { kind: string }[] | undefined;
  // Ids that merely START with the open id must not report it: a longer id, and a stray `_` suffix.
  for (const detail of [`id=${id}zz`, `id=${id}_other`, `id=${id}_notice_idx=n`]) {
    writeFileSync(log, both(detail));
    expect(f.recorded([]).out).not.toContain("CONDITION:");
    expect(conditions()).toBeUndefined();
  }
  // The exact id still reports both conditions.
  writeFileSync(log, both(`id=${id}`));
  const exact = f.recorded([]);
  expect(exact.out).toContain(`direct send ${id} could not confirm submission`);
  expect(exact.out).toContain(`automatic redelivery stopped for ${id}`);
  // disposeGrace's composite detail (`id=<id> notice_id=<n>`, folded to `_notice_id=`) is the redelivery event.
  writeFileSync(log, line("redelivery_submit_unverified", `id=${id} notice_id=courier-20260930T000000Z-bbbbbbbbbbbb`));
  expect(f.recorded([]).out).toContain(`automatic redelivery stopped for ${id}`);
  expect(conditions()!.map(c => c.kind)).toEqual(["redelivery_stopped"]);
  // A same-id retry that went unverified stops the same ladder under its own action.
  writeFileSync(log, line("retry_submit_unverified", `id=${id}`));
  expect(conditions()!.map(c => c.kind)).toEqual(["redelivery_stopped"]);
  writeFileSync(log, line("retry_submit_unverified", `id=${id}zz`));
  expect(conditions()).toBeUndefined();
  // A later retry whose recorded outcome confirmed submission supersedes the earlier unverified retry.
  writeFileSync(log, line("retry_submit_unverified", `id=${id}`));
  const row = (n: number, event: string, outcome?: string) => JSON.stringify({ v: 1, id, retry: `00000000-0000-4000-8000-00000000000${n}`, ordinal: n, event,
    ...(outcome ? { outcome } : {}), at: "2026-10-12T10:00:00.000Z" });
  const history = (...rows: string[]) => writeFileSync(join(f.bus, "receipts", `${id}.retries.jsonl`), rows.join("\n") + "\n");
  history(row(1, "request"), row(1, "outcome", "unverified"), row(2, "request"), row(2, "outcome", "submission-confirmed"));
  expect(conditions()).toBeUndefined();
  history(row(1, "request"), row(1, "outcome", "submission-confirmed"), row(2, "request"), row(2, "outcome", "unverified"));
  expect(conditions()!.map(c => c.kind)).toEqual(["redelivery_stopped"]);
  // A later retry whose outcome was never written does not inherit an earlier retry's success.
  history(row(1, "request"), row(1, "outcome", "submission-confirmed"), row(2, "request"));
  expect(conditions()!.map(c => c.kind)).toEqual(["redelivery_stopped"]);
});

test("unverified-submission remedies name the payload's real target, not a <peer> placeholder (tap-jc7j)", () => {
  const f = fixture();
  const same = f.payload("aaaaaaaaaaaa");
  const cross = f.payload("bbbbbbbbbbbb", "to_team: remote\n");
  const events = [same, cross].flatMap(id => ["send_submit_unverified", "redelivery_submit_unverified"]
    .map(action => registryEventLine({ actor: "sender", action, handle: "peer", pane: "p", team: "tap", detail: `id=${id}` }) + "\n")).join("");
  writeFileSync(join(f.bus, "registry-events.log"), events);
  const view = f.recorded([]);
  expect(view.out).not.toContain("<peer>");
  const remedies = view.out.split("\n").filter(l => l.startsWith("CONDITION:")).map(l => l.slice(l.indexOf("; next: ") + 8));
  expect(remedies.sort()).toEqual([
    "tap nudge peer", "tap nudge remote/peer",
    "tap poll on their side, or tap nudge peer", "tap poll on their side, or tap nudge remote/peer",
  ].sort());
  const json = JSON.parse(f.recorded(["--json"]).out);
  expect(json.spool_conditions.map((c: { remedy: string }) => c.remedy).sort()).toEqual(remedies);
});

test("malformed outbound quarantine preserves bytes and names its only bus mutations", () => {
  const f = fixture();
  const id = f.payload("aaaaaaaaaaaa");
  const path = join(f.bus,"payloads",`${id}.md`);
  const malformed = readFileSync(path,"utf8").replace("kind: question\n", "");
  writeFileSync(path,malformed);
  const before = snapshot(f.bus), result = f.run([]), after = snapshot(f.bus);
  expect(result.code).toBe(0);
  expect(result.out).toContain("quarantined 1 malformed outbound payload(s)");
  expect(result.out).toContain("no outstanding sends for sender");
  expect(after[`/payloads/.quarantine/${id}.md`]).toBe(Buffer.from(malformed).toString("base64"));
  expect(after[`/payloads/${id}.md`]).toBeUndefined();
  const changes = [...new Set([...Object.keys(before),...Object.keys(after)])].filter(p => before[p] !== after[p]).sort();
  expect(changes).toEqual(["/payloads/.quarantine/.log",`/payloads/.quarantine/${id}.md`,`/payloads/${id}.md`].sort());
  expect(Buffer.from(after["/payloads/.quarantine/.log"]!,"base64").toString()).toContain(`\tinvalid_envelope\t${id}.md`);
});

test("cross-worktree heuristic distinguishes an empty seat row from populated membership", () => {
  const f = fixture();
  f.payload("aaaaaaaaaaaa");
  const empty = f.recorded([]);
  expect(empty.out).toContain("600s cross-worktree");
  const registry = join(f.bus,"registry.json");
  const doc = JSON.parse(readFileSync(registry,"utf8"));
  doc.seats.peer = { instance:"peer|current" };
  writeFileSync(registry,JSON.stringify(doc));
  const populated = f.recorded([]);
  expect(populated.out).not.toContain("cross-worktree");
  f.recorded(["--json"]);
});

test("ordinary read receipt age uses the same pinned clock",()=>{
  const f=fixture(),id=f.payload("aaaaaaaaaaaa");
  writeFileSync(join(f.bus,"receipts",`${id}.read`),'{"by":"peer","at":"2026-09-05T10:09:30Z"}\n');
  const r=f.recorded([]); expect(r.out).toContain("read 30s, unanswered");
});

// These fixed expectations survive the removal of the independent Bash body.
test("shared scan keeps exact row bytes and regular-file receipt semantics", () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "reply: expected\n");
  f.payload("bbbbbbbbbbbb", "reply: optional\n");
  const done = f.payload("cccccccccccc"), cancelled = f.payload("dddddddddddd");
  const link = f.payload("eeeeeeeeeeee");
  mkdirSync(join(f.bus,"receipts",`${id}.done`)); // A directory is not settlement.
  writeFileSync(join(f.bus,"receipts",`${done}.done`), "{}");
  writeFileSync(join(f.bus,"receipts",`${cancelled}.cancelled`), "{}");
  symlinkSync(join(f.bus,"receipts",`${done}.done`), join(f.bus,"receipts",`${link}.done`));
  writeFileSync(join(f.bus,"receipts",`${id}.read`), '{"by":"peer","at":"2026-09-05T10:09:30Z"}');
  writeFileSync(join(f.bus,"receipts",`${id}.sent`), '{"delivery":"poll"}');
  // Canonical wins, even when a sibling has a different recipient.
  writeFileSync(join(f.bus,"spool",`${id}.md`), readFileSync(join(f.bus,"payloads",`${id}.md`),"utf8").replace("to: peer", "to: wrong"));
  writeFileSync(join(f.bus,"payloads","_draft.md"),"from: sender\n");
  const result = f.recorded([]);
  expect(result.out).toBe(`tap outstanding: 2 outstanding send(s) for sender\n${id}  peer  ask  600s cross-worktree  read 30s, unanswered\nsender-20260905T100000Z-bbbbbbbbbbbb  peer  unsanctioned reply:optional  600s cross-worktree\n`);
  const machine = f.recorded(["--json"]);
  expect(machine.out).toBe(JSON.stringify({ok:true,agent:"sender",outstanding:[
    {id,to:"peer",kind:"question",path:join(realpathSync(f.bus),"payloads",`${id}.md`),turn:"unconfirmed",cross_worktree:true,age_seconds:600},
    {id:"sender-20260905T100000Z-bbbbbbbbbbbb",to:"peer",kind:"question",path:join(realpathSync(f.bus),"payloads","sender-20260905T100000Z-bbbbbbbbbbbb.md"),cross_worktree:true,age_seconds:600},
  ]})+"\n");
});

test("sender-instance exclusion happens before outbound quarantine", () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "sender_instance: sender|old\n");
  const path = join(f.bus,"payloads",`${id}.md`);
  writeFileSync(path, readFileSync(path,"utf8").replace("kind: question\n", ""));
  const before = snapshot(f.bus), result = f.run([]);
  expect(result.code).toBe(0);
  expect(result.out).toBe("tap outstanding: no outstanding sends for sender\n");
  expect(snapshot(f.bus)).toEqual(before);
});


test("legacy custom timestamp ids and an unterminated header stay visible", () => {
  const f = fixture(), id = f.payload("legacy-extra");
  const path = join(f.bus,"payloads",`${id}.md`);
  writeFileSync(path, readFileSync(path,"utf8").replace("---\nbody\n", ""));
  const result = f.recorded(["--stale", "500"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`${id}  peer  ask  600s`);
});

test("confirmed injection remains visible after spool removal", () => {
  const f = fixture(), id = f.payload("eeeeeeeeeeee", "reply: expected\n");
  recordPhase(f.bus, { id, attempt: "one", recipient: "peer", enter_count: 0, phase: "injected-text-confirmed" });
  const r = f.recorded([]);
  expect(r.out).toContain("injected; Enter unconfirmed (possible effect)");
  expect(r.out).toContain("tap nudge peer");
  expect(r.out).not.toMatch(/recipient cooldown|next probe:/);
  const machine = JSON.parse(f.recorded(["--json"]).out);
  expect(machine.outstanding[0].phase).toBe("injected-enter-unconfirmed");
});


test("native backlog uses validated shared thresholds without a Bash diagnostic hop", () => {
  const f = fixture();
  for (const suffix of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    const id = f.payload(suffix, "reply: expected\n", true);
    writeFileSync(join(f.bus, "spool", `${id}.meta.json`), JSON.stringify({ target: "peer", busy_pending_probes: 3 }));
  }
  const bin = join(f.base, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "bash"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  Object.assign(f.env, { PATH: `${bin}:${process.env.PATH}` });
  for (const [count, probes, condition] of [["2", "3", true], ["3", "3", false], ["2", "4", false], ["0", "3", false], ["junk", "3", false], ["2", "1.5", false], ["", "3", false]] as const) {
    Object.assign(f.env, { TAP_SPOOL_BACKLOG_COUNT: count, TAP_SPOOL_BACKLOG_PENDING_PROBES: probes });
    const result = f.run(["--json"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(!!body.spool_conditions?.length).toBe(condition);
    expect(body.outstanding.length).toBe(condition ? 0 : 2);
  }
});

test("read fallback reply notes make an unsettled ask visible without settling it", () => {
  const f = fixture();
  const ask = f.payload("111111111111", "reply: expected\nsender_instance: sender|current\nrecipient_instance: peer|current\n");
  const answer = "peer-20260905T100001Z-222222222222";
  const path = join(f.bus, "payloads", `${answer}.md`);
  const raw = `---\nid: ${answer}\nfrom: peer\nto: sender\nkind: discuss\nreply: settle-only\nin_reply_to: ${ask}\nsender_instance: peer|current\nrecipient_instance: sender|current\npath: ${path}\n---\nThe requested result is ready.\n`;
  writeFileSync(path, raw);
  const receipt = join(f.bus, "receipts", `${answer}.done`);
  writeFileSync(join(f.bus,"receipts",`${ask}.read`), JSON.stringify({id:ask,by:"peer"}));
  expect(f.recorded([]).out).toContain("unanswered");
  const done = {id:answer,status:"done",via:"read",by:"sender"};
  writeFileSync(receipt, JSON.stringify(done));
  const result = f.recorded([]);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`answered by ${answer} (unsettled)`);
  expect(result.out).not.toContain("unanswered");
  expect(JSON.parse(f.recorded(["--json"]).out).outstanding[0].answered_by).toEqual([answer]);
  expect(readdirSync(join(f.bus,"receipts"))).not.toContain(`${ask}.done`);
  for (const invalid of [{...done,forced:true},{...done,via:"courier"},{...done,by:"other"},{...done,id:"other"}]) {
    writeFileSync(receipt,JSON.stringify(invalid));
    expect(f.recorded([]).out).not.toContain("answered by");
  }
  writeFileSync(receipt,JSON.stringify(done));
  for (const invalid of [raw.replace("from: peer", "from: stranger"), raw.replace("peer|current", "peer|old"), raw.replace("sender|current", "sender|old"), raw.replace("reply: settle-only", "reply: expected"), raw.replace(`in_reply_to: ${ask}`, "in_reply_to: unrelated"), raw.replace("kind: discuss", "kind: discuss\nfrom_team: unrelated")]) {
    writeFileSync(path, invalid);
    expect(f.recorded([]).out).not.toContain("answered by");
  }
}, 30000);

test("answer notes stamped before the oldest open ask are never read; unstamped ids never narrow the scan", () => {
  const f = fixture();
  const ask = f.payload("555555555555", "reply: expected\nsender_instance: sender|current\nrecipient_instance: peer|current\n");
  const note = (id: string) => {
    const path = join(f.bus, "payloads", `${id}.md`);
    writeFileSync(path, `---\nid: ${id}\nfrom: peer\nto: sender\nkind: discuss\nreply: settle-only\nin_reply_to: ${ask}\nsender_instance: peer|current\nrecipient_instance: sender|current\npath: ${path}\n---\nanswer\n`);
    writeFileSync(join(f.bus, "receipts", `${id}.done`), JSON.stringify({ id, status: "done", via: "read", by: "sender" }));
  };
  // A caller-supplied id whose stamp-like segment is not the minted shape
  // (stamp not followed by a final suffix) never narrows the scan.
  const before = "peer-20260905T095959Z-666666666666", after = "peer-20260905T100000Z-777777777777", custom = "peer-custom-answer";
  const forged = "peer-20200101T000000Z-old-shape";
  for (const id of [before, after, custom, forged]) note(id);
  expect(JSON.parse(f.recorded(["--json"]).out).outstanding[0].answered_by).toEqual([after, custom, forged].sort());
  // An unstamped open ask lifts the floor for every ask.
  const unstamped = "sender-custom-ask", path = join(f.bus, "payloads", `${unstamped}.md`);
  writeFileSync(path, `---\nid: ${unstamped}\nfrom: sender\nto: peer\nkind: question\nreply: expected\nsender_instance: sender|current\nrecipient_instance: peer|current\npath: ${path}\n---\nbody\n`);
  const rows = JSON.parse(f.recorded(["--json"]).out).outstanding as { id: string; answered_by?: string[] }[];
  expect(rows.find(r => r.id === ask)!.answered_by).toEqual([before, custom, after, forged].sort());
  expect(rows.find(r => r.id === unstamped)!.answered_by).toBeUndefined();
  expect(Object.keys(rows.find(r => r.id === unstamped)!)).not.toContain("answered_by");
}, 30000);

test("forwarded fallback answers follow the ask sender's pinned custody", () => {
  const f = fixture();
  const ask = f.payload("333333333333", "reply: expected\nsender_instance: sender|current\nrecipient_instance: peer|current\n");
  const answer = "peer-20260905T100001Z-444444444444";
  const path = join(f.bus, "payloads", `${answer}.md`);
  writeFileSync(path, `---\nid: ${answer}\nfrom: peer\nto: successor\nkind: discuss\nreply: settle-only\nin_reply_to: ${ask}\nsender_instance: peer|current\nrecipient_instance: successor|current\nto_adopted_from: sender\noriginal_recipient_instance: sender|current\npath: ${path}\n---\nResult delivered to your successor.\n`);
  writeFileSync(join(f.bus,"receipts",`${answer}.done`),JSON.stringify({id:answer,status:"done",via:"read",by:"successor"}));
  const registry = join(f.bus,"registry.json");
  const doc = JSON.parse(readFileSync(registry,"utf8"));
  delete doc.seats.sender; doc.seats.successor = {instance:"successor|current"};
  doc.seat_forwardings = [{source:"sender",source_instance:"sender|current",destination:"successor",destination_instance:"successor|current",at:"2026-09-05T10:00:00Z",address_active:true}];
  writeFileSync(registry,JSON.stringify(doc));
  expect(f.recorded(["successor"]).out).toContain(`answered by ${answer} (unsettled)`);
  expect(JSON.parse(f.recorded(["successor","--json"]).out).outstanding[0].answered_by).toEqual([answer]);
  writeFileSync(path,readFileSync(path,"utf8").replace("original_recipient_instance: sender|current","original_recipient_instance: sender|old"));
  expect(f.recorded(["successor"]).out).not.toContain("answered by");
}, 15000);

test("empty outstanding does not open settled historical payloads", () => {
  const f = fixture();
  const id = "peer-20260905T100001Z-555555555555";
  const path = join(f.bus,"payloads",`${id}.md`);
  expect(spawnSync("mkfifo",[path]).status).toBe(0);
  writeFileSync(join(f.bus,"receipts",`${id}.done`),"{}");
  // Any attempt to read this FIFO blocks. The deadline is a guard, not a benchmark.
  const result = spawnSync(process.execPath,[join(root,"runtime/bun/test/support/native-outstanding-entry.ts"),"--json"],{env:f.env,encoding:"utf8",timeout:3000});
  expect(result.status, String(result.error)).toBe(0);
  expect(JSON.parse(result.stdout).outstanding).toEqual([]);
  // snapshot() reads every file, so remove the deliberately unreadable fixture first.
  unlinkSync(path);
});

const entry = join(root, "runtime/bun/test/support/native-outstanding-entry.ts");

test("--team anchors the scan from an unrelated cwd with TAP_HOME unset", () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "reply: expected\n");
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const { TAP_HOME: _drop, ...env } = f.env;
  const r = spawnSync(process.execPath, [entry, "--team", "tap"], { env, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`${id}  peer  ask  600s`);
});

test("explicit TAP_HOME wins over --team", () => {
  const f1 = fixture(), f2 = fixture();
  const id1 = f1.payload("aaaaaaaaaaaa", "reply: expected\n");
  f2.payload("bbbbbbbbbbbb", "reply: expected\n");
  f2.payload("cccccccccccc", "reply: expected\n");
  const index = join(f1.env.TAP_INDEX_HOME!, "global-registry.json");
  const doc = JSON.parse(readFileSync(index, "utf8"));
  doc.teams.alt = { root: f2.base, registry_location: join(f2.bus, "registry.json"), state: "registered" };
  writeFileSync(index, JSON.stringify(doc));
  const r = f1.run(["--team", "alt", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).outstanding).toHaveLength(1);
  expect(r.out).toContain(id1);
});

test("the live marker filters other-instance payloads; an absent index refuses instead of listing them", () => {
  const f = fixture(), id = f.payload("aaaaaaaaaaaa", "sender_instance: sender|old\n");
  const live = f.run(["--json"]);
  expect(live.code).toBe(0);
  expect(JSON.parse(live.out).outstanding).toHaveLength(0);
  const bare = join(f.base, "bare-index");
  mkdirSync(bare);
  const r = f.run(["--json"], false, { TAP_INDEX_HOME: bare });
  expect(r.code).not.toBe(0);
  expect(JSON.parse(r.out).error_class).toBe("unanchored_bus");
  expect(r.out).not.toContain(id);
});

test("--json refusals emit a single JSON error object on stdout", () => {
  const f = fixture();
  const r = f.run(["--json", "--wat"]);
  expect(r.code).toBe(1);
  const body = JSON.parse(r.out);
  expect(body.ok).toBe(false);
  expect(body.error_class).toBe("unknown_option");
  expect(r.err).toBe("");
});

test("value options without a value refuse with the incumbent wording", () => {
  const f = fixture();
  const team = f.run(["--team"]);
  expect(team.code).toBe(1);
  expect(team.err).toContain("--team needs a value");
  const stale = f.run(["--stale"]);
  expect(stale.code).toBe(1);
  expect(stale.err).toContain("--stale needs a value (seconds)");
});

test("an unanchored cwd refuses with exit 4 and names the unobservable pane", () => {
  const f = fixture();
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const bin = join(f.base, "fakebin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { TAP_HOME: _drop, ...env } = f.env;
  const r = spawnSync(process.execPath, [entry], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("cwd-derived bus has no acting registry and the caller pane is not observable");
  expect(r.stderr).toContain("process observation unavailable");
});

test("an unobservable pane with no session name refuses through the pane_gone rebind remedy", () => {
  const f = fixture();
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const bin = join(f.base, "fakebin");
  mkdirSync(bin);
  // The walk stops at the first controlling tty and never climbs past it, so
  // a single ps row answering ppid=1 with that tty is enough; the fake tmux
  // then reports a pane whose identity record carries NO session name.
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho \"1 pts/3\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nfor a in \"$@\"; do\ncase $a in\n  list-panes) printf '%%7\\t/dev/pts/3\\n'; exit 0 ;;\n  display-message) printf '%%7\\t/dev/pts/3\\t\\t999:123\\n'; exit 0 ;;\nesac\ndone\nexit 1\n", { mode: 0o755 });
  const { TAP_HOME: _drop, ...env } = f.env;
  const r = spawnSync(process.execPath, [entry], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("tap register   (the recorded pane is from a previous tmux server; re-register to rebind)");
  expect(r.stderr).not.toContain("pass --team");
});

test("an unobservable pane with no server generation refuses through the pane_unknown unreadable remedy", () => {
  const f = fixture();
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const bin = join(f.base, "fakebin");
  mkdirSync(bin);
  // Same walk, but the identity record names a session and an UNPARSEABLE
  // generation: the seam must refuse per the incumbent's unknown verdict.
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho \"1 pts/3\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nfor a in \"$@\"; do\ncase $a in\n  list-panes) printf '%%7\\t/dev/pts/3\\n'; exit 0 ;;\n  display-message) printf '%%7\\t/dev/pts/3\\ts1\\t:bad:\\n'; exit 0 ;;\nesac\ndone\nexit 1\n", { mode: 0o755 });
  const { TAP_HOME: _drop, ...env } = f.env;
  const r = spawnSync(process.execPath, [entry], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("tap escalate --team <team> --from <your handle> -f <question-file>   (do not retry; tmux state is unreadable)");
  expect(r.stderr).not.toContain("pass --team");
});

test("--stale accepts the Bash signed integer maximum", () => {
  const f = fixture();
  const r = f.run(["--stale", "9223372036854775807"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("no outstanding sends for sender");
});

test("--stale refuses values beyond the Bash signed integer maximum", () => {
  const f = fixture();
  const r = f.run(["--stale", "9223372036854775808"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("9223372036854775807");
  const huge = f.run(["--stale", "99999999999999999999999999"]);
  expect(huge.code).toBe(1);
  expect(huge.err).toContain("9223372036854775807");
});

test("a pane-id/tty drift observation stays in the generic refusal on a live marker", () => {
  const f = fixture();
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const bin = join(f.base, "fakebin");
  mkdirSync(bin);
  // The identity record names a DIFFERENT pane id and tty than the inventory
  // found: unverifiable, but no `missing` stamp. Only explicit missing-field
  // observations enter typed recovery — this one keeps the generic refusal.
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho \"1 pts/3\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nfor a in \"$@\"; do\ncase $a in\n  list-panes) printf '%%7\\t/dev/pts/3\\n'; exit 0 ;;\n  display-message) printf '%%8\\t/dev/pts/9\\ts1\\t999:123\\n'; exit 0 ;;\nesac\ndone\nexit 1\n", { mode: 0o755 });
  const { TAP_HOME: _drop, ...env } = f.env;
  const r = spawnSync(process.execPath, [entry], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("cwd-derived bus has no acting registry and the caller pane is not observable");
  expect(r.stderr).not.toContain("re-register to rebind");
  expect(r.stderr).not.toContain("registered as");
});

test("a drift observation on a pre-flip index never resolves a legacy team from the raw pane id", () => {
  const f = fixture();
  const unrelated = join(scratch, `unrelated-${serial++}`);
  mkdirSync(unrelated);
  const bin = join(f.base, "fakebin");
  mkdirSync(bin);
  // Pre-flip machine: no global-registry.json, only teams.json — and its
  // legacy bus registry CLAIMS the drifted pane id %8. The raw pane id must
  // never consult that enrollment for a non-missing unverifiable observation.
  const { TAP_HOME: _drop, ...env } = f.env;
  rmSync(join(env.TAP_INDEX_HOME!, "global-registry.json"));
  const teamRoot = join(f.base, "alpha");
  mkdirSync(join(teamRoot, ".tap", "bus"), { recursive: true });
  writeFileSync(join(teamRoot, ".tap", "bus", "registry.json"),
    JSON.stringify({ seats: { h1: { pane_id: "%8" } } }));
  writeFileSync(join(env.TAP_INDEX_HOME!, "teams.json"),
    JSON.stringify({ teams: { alpha: { root: teamRoot } } }));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho \"1 pts/3\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nfor a in \"$@\"; do\ncase $a in\n  list-panes) printf '%%7\\t/dev/pts/3\\n'; exit 0 ;;\n  display-message) printf '%%8\\t/dev/pts/9\\ts1\\t999:123\\n'; exit 0 ;;\nesac\ndone\nexit 1\n", { mode: 0o755 });
  const r = spawnSync(process.execPath, [entry], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", cwd: unrelated });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("cwd-derived bus has no acting registry and the caller pane is not observable");
  // The generic action names no bus and no seat: the legacy claim on %8 must
  // never become a `cd <root>  OR  pass --team alpha` remedy.
  expect(r.stderr).not.toContain("cd ");
  expect(r.stderr).not.toContain("registered as");
});
