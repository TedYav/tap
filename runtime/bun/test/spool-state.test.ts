// spool-state.ts: the parked entry's metadata writers and the listing, pinned
// with explicit bytes. Each writer keeps the incumbent's OWN lock discipline
// and byte shape (the table at the top of the module); the rule-13
// differential under tmp/ is what decided these bytes, this file keeps them.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePathLock } from "../src/panelock";
import { blockedOrExempt, listEntries, liveProbes, main, markLegacyNoBinding, noteBusyProbe, noteLiveProbe, scheduleProbe, updateHeldVisits } from "../src/spool-state";

const NOW = 1789458203;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function spool(): string { const r = fs.mkdtempSync(join(tmpdir(), "ss-")); roots.push(r); return r; }
const META = (extra = "") => `{\n  "attempts": 0,\n  "first_spooled_epoch": ${NOW - 100},\n  "id": "m1",\n  "reason": "busy",\n  "reason_class": "busy",\n  "target": "peer",\n  "target_registry": "REG"${extra}\n}\n`;
function seed(dir: string, name: string, text: string): string { const p = join(dir, name); fs.writeFileSync(p, text); return p; }
const read = (p: string) => fs.readFileSync(p, "utf8");
const env = () => ({ PATH: process.env.PATH, HOME: tmpdir() });

test("scheduleProbe: json.dump DEFAULT bytes (no trailing newline), a float epoch even when whole, the fixed <meta>.tmp gone", () => {
  const dir = spool();
  const p = seed(dir, "m1.meta.json", META(',\n  "s": "caf\\u00e9"'));
  expect(scheduleProbe(dir, "m1", "30", NOW, env())).toBe(true);
  expect(read(p)).toBe(`{"attempts": 0, "first_spooled_epoch": ${NOW - 100}, "id": "m1", "reason": "busy", "reason_class": "busy", "target": "peer", "target_registry": "REG", "s": "caf\\u00e9", "next_probe_epoch": ${NOW + 30}.0}`);
  expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  expect(scheduleProbe(dir, "m1", "0.25", NOW, env())).toBe(true);
  expect(read(p)).toContain(`"next_probe_epoch": ${NOW}.25}`);
  // exit-1 shapes: junk delay, missing meta, invalid JSON, a non-dict document (Python's TypeError), a BOM
  expect(scheduleProbe(dir, "m1", "soon", NOW, env())).toBe(false);
  expect(scheduleProbe(dir, "none", "1", NOW, env())).toBe(false);
  seed(dir, "bad.meta.json", "nope"); expect(scheduleProbe(dir, "bad", "1", NOW, env())).toBe(false);
  seed(dir, "list.meta.json", "[1]\n"); expect(scheduleProbe(dir, "list", "1", NOW, env())).toBe(false);
  seed(dir, "bom.meta.json", "﻿" + META()); expect(scheduleProbe(dir, "bom", "1", NOW, env())).toBe(false);
  expect(read(join(dir, "list.meta.json"))).toBe("[1]\n");
});

test("scheduleProbe waits on the meta lock and refuses (false, bytes untouched) when a holder outlives the bound", () => {
  const dir = spool();
  const p = seed(dir, "m1.meta.json", META());
  const held = acquirePathLock(`${p}.lock`, 5000, env());
  expect(held).not.toBeNull();
  try {
    // METADATA_LOCK_TIMEOUT_MS (5 s) is the bound; the refusal, not its duration, is the contract here.
    expect(scheduleProbe(dir, "m1", "30", NOW, env())).toBe(false);
    expect(read(p)).toBe(META());
  } finally { held!.release(); }
}, 15000);

test("noteBusyProbe: busy:pending only, unlocked, sorted indent-2 + newline; the counter follows Python's int()", () => {
  const dir = spool();
  const p = seed(dir, "m1.meta.json", META());
  noteBusyProbe(dir, "m1", "busy", NOW);
  expect(read(p)).toBe(META());
  noteBusyProbe(dir, "m1", "busy:pending", NOW);
  expect(read(p)).toBe(`{\n  "attempts": 0,\n  "busy_pending_probes": 1,\n  "first_spooled_epoch": ${NOW - 100},\n  "id": "m1",\n  "last_busy_probe_at": ${NOW},\n  "last_busy_probe_detail": "busy:pending",\n  "reason": "busy",\n  "reason_class": "busy",\n  "target": "peer",\n  "target_registry": "REG"\n}\n`);
  // int("3") → 4; int(3.0) → 4; int(True) → 2; int("3.0") raises → no write; a list document → no write
  for (const [v, want] of [['"3"', 4], ["3.0", 4], ["true", 2]] as const) {
    seed(dir, "c.meta.json", META(`,\n  "busy_pending_probes": ${v}`)); noteBusyProbe(dir, "c", "busy:pending", NOW);
    expect(read(join(dir, "c.meta.json"))).toContain(`"busy_pending_probes": ${want},`);
  }
  const bad = seed(dir, "d.meta.json", META(',\n  "busy_pending_probes": "3.0"')); noteBusyProbe(dir, "d", "busy:pending", NOW);
  expect(read(bad)).toBe(META(',\n  "busy_pending_probes": "3.0"'));
  const list = seed(dir, "e.meta.json", "[1]\n"); noteBusyProbe(dir, "e", "busy:pending", NOW);
  expect(read(list)).toBe("[1]\n");
  expect(fs.readdirSync(dir).filter(n => n.startsWith(".tap-meta."))).toEqual([]);
});

test("wide integers: counters past 2^53 increment exactly, the listing orders and prints their digits", () => {
  const dir = spool();
  const wide = "9007199254740993"; // 2^53 + 1: a double cannot hold it
  const p = seed(dir, "m1.meta.json", META(`,\n  "busy_pending_probes": ${wide},\n  "busy_live_probes": "${wide}",\n  "held_drain_visits": ${wide}`));
  noteBusyProbe(dir, "m1", "busy:pending", NOW);
  expect(read(p)).toContain('"busy_pending_probes": 9007199254740994,');
  noteLiveProbe(dir, "m1", "busy", "0.5", NOW, env());
  expect(read(p)).toContain('"busy_live_probes": 9007199254740994,');
  expect(liveProbes(dir, "m1")).toBe("9007199254740994");
  expect(updateHeldVisits(dir, "m1", "increment", env())).toBe(0);
  expect(read(p)).toContain('"held_drain_visits": 9007199254740994,');
  // ordering: z=2^53, a=2^53+1 — Python orders z before a; a double would call them equal and fall back to the id
  fs.writeFileSync(join(dir, "a.md"), "x"); seed(dir, "a.meta.json", META(`,\n  "attempts": "${wide}"`).replace(`"attempts": 0,\n  `, "").replace(String(NOW - 100), "9007199254740993").replace('"id": "m1"', '"id": "a"'));
  fs.writeFileSync(join(dir, "z.md"), "x"); seed(dir, "z.meta.json", META().replace(String(NOW - 100), "9007199254740992").replace('"id": "m1"', '"id": "z"'));
  const ids = listEntries(dir).map(r => r.id);
  expect(ids.indexOf("z")).toBeLessThan(ids.indexOf("a"));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-state.ts"), "list", dir], { stdout: "pipe", stderr: "pipe", env: env() });
  const rowA = r.stdout.toString().split("\n").find(l => l.includes('"id":"a"'))!;
  expect(rowA).toContain('"attempts":9007199254740993,');
  expect(rowA).toContain('"first_spooled_epoch":9007199254740993,');
});

test("noteLiveProbe + liveProbes: the four live details count under a BOUNDED lock; a held lock skips the increment", () => {
  const dir = spool();
  const p = seed(dir, "m1.meta.json", META(',\n  "busy_live_probes": 1'));
  noteLiveProbe(dir, "m1", "busy:modal", "0.5", NOW, env());
  expect(liveProbes(dir, "m1")).toBe("1");
  noteLiveProbe(dir, "m1", "busy:noprompt", "0.5", NOW, env());
  expect(liveProbes(dir, "m1")).toBe("2");
  expect(read(p)).toContain(`"last_live_probe_at": ${NOW},\n  "last_live_probe_detail": "busy:noprompt",`);
  const held = acquirePathLock(`${p}.lock`, 5000, env());
  try {
    const t0 = Date.now();
    noteLiveProbe(dir, "m1", "busy:in-turn", "soon", NOW, env()); // junk timeout → the 0.5 s default
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(liveProbes(dir, "m1")).toBe("2"); // skipped, never double-counted
  } finally { held!.release(); }
  seed(dir, "x.meta.json", META(',\n  "busy_live_probes": "x"'));
  expect(liveProbes(dir, "x")).toBe("0");
  expect(liveProbes(dir, "absent")).toBe("0");
  // A non-finite bound (`inf`, `1e309`) is the default, not a hang: the probe counts promptly on a free lock
  for (const bound of ["inf", "1e309", "-inf"]) {
    const t0 = Date.now();
    noteLiveProbe(dir, "m1", "busy", bound, NOW, env());
    expect(Date.now() - t0).toBeLessThan(3000);
  }
  expect(liveProbes(dir, "m1")).toBe("5");
});

test("a lock name the filesystem cannot hold refuses at once, never after the bound", () => {
  const dir = spool();
  const id = "x".repeat(245); // `<id>.meta.json` fits 255 bytes; `<id>.meta.json.lock` does not
  seed(dir, `${id}.meta.json`, META());
  const t0 = Date.now();
  expect(scheduleProbe(dir, id, "30", NOW, env())).toBe(false);
  noteLiveProbe(dir, id, "busy", "0.5", NOW, env());
  expect(updateHeldVisits(dir, id, "increment", env())).toBe(0);
  markLegacyNoBinding(dir, id, join(dir, "events.log"), "tap", "tap", new Date(NOW * 1000), env());
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(read(join(dir, `${id}.meta.json`))).toBe(META());
  expect(fs.existsSync(join(dir, "events.log"))).toBe(false);
});

test("updateHeldVisits: increment/clear with ONE non-blocking try, rc 2 for a bad action, `.tap-held-visit-` temp gone", () => {
  const dir = spool();
  const p = seed(dir, "m1.meta.json", META());
  expect(updateHeldVisits(dir, "m1", "bogus", env())).toBe(2);
  expect(updateHeldVisits(dir, "m1", "increment", env())).toBe(0);
  expect(read(p)).toContain('"held_drain_visits": 1,');
  expect(updateHeldVisits(dir, "m1", "clear", env())).toBe(0);
  expect(read(p)).toBe(META());
  expect(updateHeldVisits(dir, "m1", "clear", env())).toBe(0); // absent key: no write
  const held = acquirePathLock(`${p}.lock`, 5000, env());
  try {
    const t0 = Date.now();
    expect(updateHeldVisits(dir, "m1", "increment", env())).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(read(p)).toBe(META()); // contention: skipped, not waited for
  } finally { held!.release(); }
  expect(updateHeldVisits(dir, "absent", "increment", env())).toBe(0);
  expect(fs.readdirSync(dir).filter(n => n.startsWith(".tap-held-visit-"))).toEqual([]);
});

test("markLegacyNoBinding: keeps original_reason once, bounds reason_history to 16, appends the event only on a real transition", () => {
  const dir = spool();
  const log = join(dir, "events.log");
  const p = seed(dir, "m1.meta.json", META());
  markLegacyNoBinding(dir, "m1", log, "tap", "tap", new Date(NOW * 1000), env());
  expect(read(p)).toBe(`{\n  "attempts": 0,\n  "first_spooled_epoch": ${NOW - 100},\n  "id": "m1",\n  "original_reason": "busy",\n  "original_reason_class": "busy",\n  "reason": "legacy_meta_no_binding",\n  "reason_class": "safety_gate",\n  "reason_history": [\n    {\n      "at": "2026-09-15T07:43:23Z",\n      "reason": "busy",\n      "reason_class": "busy",\n      "replaced_by": "legacy_meta_no_binding"\n    }\n  ],\n  "target": "peer",\n  "target_registry": "REG"\n}\n`);
  expect(read(log)).toContain("spool_marked_unroutable");
  expect(read(log)).toContain("detail=id=m1_from_reason=busy_to_reason=legacy_meta_no_binding team=tap"); // the event writer spaces-to-underscores the detail
  const once = read(log);
  markLegacyNoBinding(dir, "m1", log, "tap", "tap", new Date(NOW * 1000), env()); // already marked: no-op, no event
  expect(read(log)).toBe(once);
  const long = seed(dir, "h.meta.json", META(',\n  "original_reason": "first",\n  "reason_history": ' + JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ reason: `r${i}` })))));
  markLegacyNoBinding(dir, "h", log, "tap", "tap", new Date(NOW * 1000), env());
  const doc = JSON.parse(read(long));
  expect([doc.original_reason, doc.reason_history.length, doc.reason_history[15].reason]).toEqual(["first", 16, "busy"]);
  const noPrior = seed(dir, "n.meta.json", "{\n  \"id\": \"n\"\n}\n");
  const before = read(log);
  markLegacyNoBinding(dir, "n", log, "tap", "tap", new Date(NOW * 1000), env());
  expect(read(noPrior)).toBe("{\n  \"id\": \"n\",\n  \"reason\": \"legacy_meta_no_binding\",\n  \"reason_class\": \"safety_gate\"\n}\n");
  expect(read(log)).toBe(before); // no prior reason → no history, no event
  // (a) a predecessor that is not a string stays a VALUE in the fields and is spelled as
  // Python printed it in the event (`True`, `2`, not `true`/`"2"`).
  const typed = seed(dir, "t.meta.json", "{\n  \"id\": \"t\",\n  \"reason\": true,\n  \"reason_class\": 2\n}\n");
  const beforeTyped = read(log);
  markLegacyNoBinding(dir, "t", log, "tap", "tap", new Date(NOW * 1000), env());
  expect(read(typed)).toBe(`{\n  "id": "t",\n  "original_reason": true,\n  "original_reason_class": 2,\n  "reason": "legacy_meta_no_binding",\n  "reason_class": "safety_gate",\n  "reason_history": [\n    {\n      "at": "2026-09-15T07:43:23Z",\n      "reason": true,\n      "reason_class": 2,\n      "replaced_by": "legacy_meta_no_binding"\n    }\n  ]\n}\n`);
  expect(read(log).slice(beforeTyped.length)).toContain("detail=id=t_from_reason=True_to_reason=legacy_meta_no_binding");
});

test("markLegacyNoBinding under a held lock: no transition, no event, bytes untouched", () => {
  const dir = spool();
  const log = join(dir, "events.log");
  const p = seed(dir, "m1.meta.json", META());
  const held = acquirePathLock(`${p}.lock`, 5000, env());
  try {
    markLegacyNoBinding(dir, "m1", log, "tap", "tap", new Date(NOW * 1000), env());
  } finally { held!.release(); }
  expect(read(p)).toBe(META());
  expect(fs.existsSync(log)).toBe(false);
}, 15000);

test("blockedOrExempt is Python's `in`: dict keys, list members, a substring of a string; unparseable facts are empty", () => {
  expect(blockedOrExempt("peer", '{"peer": 1}', "[]")).toBe(true);
  expect(blockedOrExempt("peer", "{}", '["x", "peer"]')).toBe(true);
  expect(blockedOrExempt("ee", '"peer"', "[]")).toBe(true);
  expect(blockedOrExempt("peer", "7", "null")).toBe(false);
  // `handle in 7` raised BEFORE the exemption was consulted: not blocked even though exempt names it
  expect(blockedOrExempt("peer", "7", '["peer"]')).toBe(false);
  expect(blockedOrExempt("peer", "null", '["peer"]')).toBe(false);
  expect(blockedOrExempt("peer", "{}", "7")).toBe(false);
  expect(blockedOrExempt("peer", "{not json", "[also not")).toBe(false);
  expect(blockedOrExempt("peer", "", "")).toBe(false);
});

test("listEntries: oldest first then by id, Python's `or` defaults, scope by target + realpath(registry), a non-dict sidecar is a row (declared delta)", () => {
  const dir = spool();
  fs.writeFileSync(join(dir, "b.md"), "x"); seed(dir, "b.meta.json", META(',\n  "first_spooled_epoch": 5').replace(`"first_spooled_epoch": ${NOW - 100},\n  `, "").replace('"id": "m1"', '"id": "b"'));
  fs.writeFileSync(join(dir, "a.md"), "x"); seed(dir, "a.meta.json", META().replace('"id": "m1"', '"id": "a"'));
  fs.writeFileSync(join(dir, "z.md"), "x"); // no sidecar at all
  seed(dir, "y.meta.json", "[1]\n");        // parses, not a dict
  fs.writeFileSync(join(dir, ".hidden.md"), "x");
  seed(dir, "n.meta.json", META(',\n  "policy": "",\n  "attempts": "2",\n  "held_drain_visits": null,\n  "reason": 0').replace('"attempts": 0,\n  ', ""));
  const rows = listEntries(dir);
  // b (epoch 5) first; a and n tie at NOW-100 and order by IDENT (n's meta names itself "m1"); y and z (no epoch) last, by ident
  expect(rows.map(r => r.id)).toEqual(["b", "a", "m1", "y", "z"]);
  expect(rows.map(r => r.meta.split("/").pop())).toEqual(["b.meta.json", "a.meta.json", "n.meta.json", "y.meta.json", "z.meta.json"]);
  const n = rows.find(r => r.meta.endsWith("n.meta.json"))!;
  expect([n.id, n.policy, n.attempts, n.held_drain_visits, n.reason, n.incomplete]).toEqual(["m1", "standard", 2, 0, "unknown", true]);
  const y = rows.find(r => r.id === "y")!;
  expect([y.target, y.reason, y.reason_class, y.incomplete]).toEqual(["", "unknown", "busy", true]);
  // A non-dict sidecar BESIDE AN EXISTING PAYLOAD is still incomplete — the drain
  // projection (`if r.get("incomplete"): continue`) must never admit a row with an empty binding.
  fs.writeFileSync(join(dir, "w.md"), "x"); seed(dir, "w.meta.json", "[1]\n");
  const w = listEntries(dir).find(r => r.id === "w")!;
  expect([w.incomplete, w.target, w.pane_id]).toEqual([true, "", ""]);
  const z = rows.find(r => r.id === "z")!;
  expect([z.first_spooled_epoch, z.incomplete]).toEqual([null, true]);
  // scope: target without a registry is nothing; a registry compared by realpath
  fs.writeFileSync(join(dir, "REG"), "");
  fs.symlinkSync(join(dir, "REG"), join(dir, "REG-link"));
  seed(dir, "s.meta.json", META().replace('"target_registry": "REG"', `"target_registry": ${JSON.stringify(join(dir, "REG"))}`));
  expect(listEntries(dir, "peer", "")).toEqual([]);
  expect(listEntries(dir, "peer", join(dir, "REG-link")).map(r => r.meta)).toEqual([join(dir, "s.meta.json")]);
  // `os.path.realpath(strict=False)` FOLLOWS a dangling link — a sidecar naming an
  // absent registry still matches a scope that is a symlink to that absent path.
  fs.symlinkSync(join(dir, "gone.json"), join(dir, "gone-link"));
  seed(dir, "g.meta.json", META().replace('"target_registry": "REG"', `"target_registry": ${JSON.stringify(join(dir, "gone.json"))}`).replace('"id": "m1"', '"id": "g"'));
  expect(listEntries(dir, "peer", join(dir, "gone-link")).map(r => r.id)).toEqual(["g"]);
  expect(listEntries(join(dir, "absent"))).toEqual([]);
});

test("list at roster scale: the rows through a file and through a pipe whose reader waits are identical and complete; a reader that went away is a refusal", () => {
  const dir = spool();
  for (let i = 0; i < 250; i++) { fs.writeFileSync(join(dir, `e${i}.md`), "x"); seed(dir, `e${i}.meta.json`, META(',\n  "pane": "sess:0.0",\n  "pane_id": "%401",\n  "to_team": "t"').replace('"id": "m1"', `"id": "e${i}"`).replace(String(NOW - 100), String(NOW - 1000 + i))); }
  const cli = join(import.meta.dir, "../src/spool-state.ts");
  const file = join(dir, "..", `rows-${process.pid}.file`), pipe = join(dir, "..", `rows-${process.pid}.pipe`);
  const r = Bun.spawnSync(["bash", "-c", `bun "$1" list "$2" > "$3"; s=$?; bun "$1" list "$2" | { sleep 0.3; cat; } > "$4"; echo "$s ${"$"}{PIPESTATUS[0]}"`, "_", cli, dir, file, pipe], { env: env(), stdout: "pipe", stderr: "pipe" });
  try {
    expect([r.exitCode, r.stdout.toString().trim(), r.stderr.toString()]).toEqual([0, "0 0", ""]);
    const fileBytes = fs.readFileSync(file), pipeBytes = fs.readFileSync(pipe);
    expect(fileBytes.length).toBeGreaterThan(65536);
    expect(pipeBytes.equals(fileBytes)).toBe(true);
    const lines = fileBytes.toString("utf8").trim().split("\n");
    expect(lines.pop()).toBe("#spool-state list complete"); // the completion marker the adapter strips
    const rows = lines.map(l => JSON.parse(l) as { id: string });
    expect(rows.length).toBe(250);
    expect(rows.map(x => x.id)).toEqual(Array.from({ length: 250 }, (_, i) => `e${i}`)); // oldest first
    const closed = Bun.spawnSync(["bash", "-c", `bun "$1" list "$2" 2>"$3" | true; echo ${"$"}{PIPESTATUS[0]}`, "_", cli, dir, join(dir, "..", `err-${process.pid}`)], { env: env(), stdout: "pipe", stderr: "pipe" });
    expect([closed.stdout.toString().trim(), fs.readFileSync(join(dir, "..", `err-${process.pid}`), "utf8")]).toEqual(["1", "tap spool-state: stdout EPIPE\n"]);
  } finally { for (const f of [file, pipe, join(dir, "..", `err-${process.pid}`)]) fs.rmSync(f, { force: true }); }
}, 30000);

test("CLI: list prints compact json.dumps rows; blocked-or-exempt and schedule-probe are verdicts at exit 0; unknown verb rc 1", () => {
  const dir = spool();
  fs.writeFileSync(join(dir, "m1.md"), "x"); seed(dir, "m1.meta.json", META(',\n  "deadline_epoch": 1.5,\n  "timeout_seconds": "caf\\u00e9"'));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-state.ts"), "list", dir], { stdout: "pipe", stderr: "pipe", env: env() });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(`{"id":"m1","target":"peer","team":"","reason":"busy","reason_class":"busy","timeout_seconds":"caf\\u00e9","attempts":0,"held_drain_visits":0,"first_spooled":"","first_spooled_epoch":${NOW - 100},"pane":"","pane_id":"","to_team":"","target_registry":"REG","policy":"standard","deadline_epoch":1.5,"deadline_source":"","hold_until_epoch":null,"escalated_at":"","path":${JSON.stringify(join(dir, "m1.md"))},"meta":${JSON.stringify(join(dir, "m1.meta.json"))},"incomplete":false}\n#spool-state list complete\n`);
  const verdict = (args: string[]) => { const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-state.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: env() }); return { rc: r.exitCode, out: r.stdout.toString() }; };
  // Decided outcomes are verdicts at exit 0 (the adapter maps them to rc 0/1); exit 1 is the runtime boundary alone.
  expect(verdict(["blocked-or-exempt", "peer", '{"peer":1}', "[]"])).toEqual({ rc: 0, out: "blocked" });
  expect(verdict(["blocked-or-exempt", "peer", "{}", "[]"])).toEqual({ rc: 0, out: "clear" });
  expect(verdict(["schedule-probe", dir, "m1", "30"])).toEqual({ rc: 0, out: "scheduled" });
  expect(verdict(["schedule-probe", dir, "m1", "soon"])).toEqual({ rc: 0, out: "refused" });
  expect(main(["nope"], env())).toBe(1);
});
