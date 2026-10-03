import { recordPhase } from "../src/submit-phase";
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, fixtureTwo, releaseShowScratch, showScratch, showTree, type ShowBase } from "./support/show-fixture";

afterAll(releaseShowScratch);

test("show displays full envelope and receipt chain without settling another seat's note", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  f.put(`payloads/${id}.md`, f.payload(id));
  for (const kind of ["placed", "read", "done", "cancelled"]) f.put(`receipts/${id}.${kind}`, JSON.stringify({ at: "2026-09-05T13:00:00Z", by: "someone", via: "read", forced: false }));
  f.put(`receipts/${id}.sent`, JSON.stringify({ by: "must-not-display" }));
  for (const verbose of [false, true]) {
    const r = f.parity([id], verbose);
    expect(r.code).toBe(0); expect(r.out).toContain("recipient_instance: untouched-stamp");
    expect(r.out).not.toContain("must-not-display"); expect(r.out).toContain("forced=False");
  }
});

test("show exact custom id, absent receipts, malformed receipt, and archive", () => {
  const f = fixture(), id = "legacy-custom-final";
  f.put(`archive/${id}.cancelled.md`, f.payload(id));
  expect(f.parity([id]).out).toContain("residency: archive");
  f.put(`receipts/${id}.cancelled`, "broken json");
  expect(f.parity([id]).code).toBe(0);
});

test("show quarantine preserves binary bytes and chooses newest collision sibling", () => {
  const f = fixture(), id = "bad id";
  f.put(`payloads/.quarantine/${id}.md`, "old");
  f.put(`payloads/.quarantine/${id}.md.2`, Buffer.from([0xff, 0, 0x41]));
  f.put(`payloads/.quarantine/${id}.md.10`, Buffer.from([0xff, 0, 0x42]));
  expect(f.parity([id]).out).toContain(`${id}.md.10`);
});

test("show suffix ambiguity refuses and names both logical ids even across residencies", () => {
  const f = fixture(), suffix = "012345abcdef";
  const a = `Sender.A-20260905T130000Z-${suffix}`, b = `second-20260905T130001Z-${suffix}`;
  f.put(`payloads/${a}.md`, f.payload(a));
  expect(f.parity([suffix]).code).toBe(0);
  f.put(`payloads/.quarantine/${b}.md`, "malformed");
  const r = f.parity([suffix]);
  expect(r.code).toBe(1); expect(r.err).toContain(a); expect(r.err).toContain(b);
  // Mutation anchor: deleting resolveView's ambiguity refusal must fail above.
});

test("show exact live residency wins older evidence, literal hex cannot shadow suffix", () => {
  const f = fixture(), suffix = "012345abcdef", id = `sender-20260905T130000Z-${suffix}`;
  f.put(`payloads/${id}.md`, f.payload(id)); f.put(`archive/${id}.cancelled.md`, "old");
  const live = f.parity([id]).out;
  expect(live).not.toContain("residency: archive");
  expect(live).toContain(`also: archive ×1 (archive/${id}.cancelled.md)`);
  f.put(`payloads/${suffix}.md`, f.payload(suffix));
  const r = f.parity([suffix]); expect(r.code).toBe(1); expect(r.err).toContain(`${suffix}.md`); expect(r.err).toContain(id);
});

test("show usage and missing resolution retain stderr and exit", () => {
  const f = fixture();
  for (const args of [[], ["missing-id"], ["--bogus"], ["a", "b"], ["bad\\id"]]) expect(f.parity(args).code).toBe(1);
  f.put("payloads/custom.md", f.payload("custom"));
  expect(f.parity(["custom", "--all"]).code).toBe(1);
});

test("show digest index, all, and selected item never stamp digest or member receipts", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef", digest = "courier-20260905T130001Z-abcdef012345";
  f.put(`payloads/${id}.md`, f.payload(id));
  f.put(`spool/digests/${digest}.json`, JSON.stringify({ kind: "digest", digest_id: digest, items: [{ id, path: join(f.bus, `payloads/${id}.md`), from: "sender", reply: "settle-only", settled: false }] }));
  for (const args of [[digest], [digest, "--all"], [digest, "--item", id], [digest, "--all", "--item", id], [digest, "--item", "unknown"]]) f.parity(args);
});

test("show resolves a queued pair and its metadata without changing any file", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  f.put(`spool/${id}.md`, f.payload(id));
  f.put(`spool/${id}.meta.json`, JSON.stringify({ reason: "pending-input", policy: "autosettle", waiter_lifetime: "grace-window", deadline_epoch: 1788615000, attempts: 0 }));
  for (const args of [[id], ["012345abcdef"], [`path=${join(f.bus, "spool", `${id}.md`)}`], [`path=${join(f.bus, "payloads", `${id}.md`)}`]]) {
    const r = f.parity(args);
    expect(r.code).toBe(0);
    expect(r.out).toContain("residency: spool");
    expect(r.out).toContain('reason: "pending-input"');
    expect(r.out).toContain('policy: "autosettle"');
    expect(r.out).toContain('waiter_lifetime: "grace-window"');
    expect(r.out).toContain("deadline_epoch: 1788615000");
    expect(r.out).toContain("attempts: 0");
    expect(r.out).toContain("hello");
  }
  // The inspector's new residency must not silently widen recipient reads.
  const resolved = spawnSync(process.execPath, [join(showTree,"runtime/bun/src/payload-view.ts"),"resolve",id,f.bus,join(f.index,"global-registry.json"),"payloads"],{encoding:"utf8"});
  expect(resolved.status).toBe(0); expect(resolved.stdout).toStartWith("missing\x1f");
});

test("show queued evidence preserves live precedence and refuses suffix collisions", () => {
  const f = fixture(), suffix = "012345abcdef", id = `sender-20260905T130000Z-${suffix}`;
  f.put(`spool/${id}.md`, f.payload(id));
  f.put(`payloads/${id}.md`, f.payload(id));
  const live = f.parity([id]).out;
  expect(live).not.toContain("residency: spool");
  expect(live).toContain(`also: spool ×1 (spool/${id}.md)`);
  const other = `other-20260905T130001Z-${suffix}`;
  f.put(`spool/${other}.md`, f.payload(other));
  const r = f.parity([suffix]); expect(r.code).toBe(1); expect(r.err).toContain(id); expect(r.err).toContain(other);
});

test("show queued metadata may be missing malformed or partial without losing body", () => {
  const f = fixture(), id = "custom-queued-id";
  f.put(`spool/${id}.md`, f.payload(id));
  expect(f.parity([id]).out).toContain("spool metadata: unavailable");
  for (const meta of ["bad json", "[]", "null"]) {
    f.put(`spool/${id}.meta.json`, meta);
    const r = f.parity([id]); expect(r.code).toBe(0); expect(r.out).toContain("spool metadata: unavailable"); expect(r.out).toContain("hello");
  }
  f.put(`spool/${id}.meta.json`, '{"attempts":2}');
  const r = f.parity([id]); expect(r.code).toBe(0); expect(r.out).toContain("attempts: 2"); expect(r.out).toContain("deadline_epoch: unknown");
});

test("show distinguishes phase status from orphan custody and retains recorded metadata", () => {
  const f = fixture(), id = "sender-phase-proof";
  f.put(`payloads/${id}.md`, f.payload(id));
  recordPhase(f.bus, { id, attempt: "one", recipient: "another-seat", enter_count: 0, phase: "injected-text-confirmed" });
  expect(f.parity([id]).out).toContain("injected; Enter unconfirmed (possible effect)");
  f.put(`spool/${id}.meta.json`, JSON.stringify({ reason: "window", reason_class: "window", next_probe_epoch: 1 }));
  const r = f.parity([id]);
  // Orphan custody supersedes the phase hint without claiming delivery.
  expect(r.out).toContain(`Delivery unverified; canonical body retained, prior recipient effect unknown. Automatic retry stopped. The sender may withdraw with tap cancel ${id} --spooled.`);
  expect(r.out).toContain("recorded spool metadata (not current delivery status):");
  expect(r.out).toContain('reason: "window"');
  expect(r.out).not.toMatch(/recipient cooldown|next probe:/);
});

// Two-team forms replay the parent goldens; the call order IS the key derivation.
test("show two-team forms match the parent oracle: --team, path=, digest members", () => {
  const b = fixtureTwo();
  const D = "decoy-20260905T130009Z-aaaabbbbcccc", PC = "plain-20260905T130012Z-ccccddddeeee";
  const SB = "beta-20260905T130011Z-bbbbccccdddd";
  b.put(`payloads/${D}.md`, b.payload(D)); b.put(`payloads/${PC}.md`, b.payload(PC));
  b.putB(`payloads/${D}.md`, b.payload(D).replace("hello", "team-b hello"));
  b.putB(`payloads/${SB}.md`, b.payload(SB).replace("hello", "team-b beta hello"));
  const digest3 = "courier-20260905T130013Z-ddddeeeeffff", digestBad = "courier-20260905T130014Z-eeeeffff0000";
  const item = (id: string, path: string) => ({ id, path, from: "sender", reply: "settle-only", settled: false });
  b.put(`spool/digests/${digest3}.json`, JSON.stringify({ kind: "digest", digest_id: digest3, items: [
    item(D, join(b.bus, `payloads/${D}.md`)),
    item("ghost-20260905T130010Z-9999aaaabbbb", join(b.bus, "payloads/ghost-20260905T130010Z-9999aaaabbbb.md")),
    item(PC, join(b.bus, `payloads/${PC}.md`)) ] }));
  b.put(`spool/digests/${digestBad}.json`, JSON.stringify({ kind: "digest", digest_id: digestBad, items: [
    item("mismatch-20260905T130015Z-111122223333", join(b.bus, `payloads/${D}.md`)),
    item(PC, join(b.bus, `payloads/${PC}.md`)) ] }));
  const pin = { env: { TAP_HOME: b.bus }, tag: "pin" }, tt = { tag: "tt" };
  expect(b.parityDoor([D, "--team", "teamb"], tt).out).toContain("team-b hello");
  expect(b.parityDoor([D, "--team", "teamb"], pin).out).not.toContain("team-b");
  expect(b.parityDoor(["teamb/" + D], pin).out).toContain("team-b hello");
  expect(b.parityDoor([SB.slice(-12), "--team", "teamb"], tt).out).toContain("team-b beta hello");
  expect(b.parityDoor(["path=" + join(b.bus, `payloads/${D}.md`), "path=" + join(b.bus, `payloads/${PC}.md`)], pin).out).toContain(PC.slice(0, PC.indexOf("-")));
  expect(b.parityDoor([D, "path=" + join(b.bus, `payloads/${PC}.md`)], pin).out).not.toContain("team-b");
  expect(b.parityDoor(["gone-20260905T130016Z-222233334444", "path=" + join(b.bus, `payloads/${PC}.md`)], pin).code).toBe(0);
  expect(b.parityDoor(["--", "path=" + join(b.bus, `payloads/${PC}.md`)], pin).code).toBe(0);
  expect(b.parityDoor([D, "--", "path=" + join(b.bus, `payloads/${PC}.md`)], pin).code).toBe(1);
  expect(b.parityDoor([digest3], pin).code).toBe(0);
  const all = b.parityDoor([digest3, "--all"], pin);
  expect(all.code).toBe(1);
  expect(all.out).toContain("Read: tap read " + digest3 + " --all");
  expect(all.out).toContain("id: " + D); expect(all.out).toContain("id: " + PC);
  expect(all.err).toContain("ghost-20260905T130010Z-9999aaaabbbb");
  const bad = b.parityDoor([digestBad, "--all"], pin);
  expect(bad.code).toBe(1); expect(bad.err).toContain("path does not match its payload id");
  expect(bad.out).toContain("id: " + PC);
  expect(b.parityDoor([digest3, "--item", D], pin).out).toContain("id: " + D);
  expect(b.parityDoor(["nosuchteam/" + D], pin).code).toBe(1);  const unenrolled = b.parityDoor([D, "--team", "nosuchteam"], tt);
  expect(unenrolled.code).toBe(1); expect(unenrolled.err).toContain("is not enrolled");
  const charset = b.parityDoor([D, "--team", "bad_team!"], tt);
  expect(charset.code).toBe(1); expect(charset.err).toContain("charset");
  expect(b.parityDoor([D, "--team", "bad_team!"], pin).out).not.toContain("team-b");
});

// Adjudication #3: the parent printed script-path `${2:?}` diagnostics; never golden.
test("show refuses missing and empty --item and --team values natively", () => {
  const b = fixtureTwo();
  for (const args of [["x", "--item"], ["x", "--item", ""], ["--team"], ["--team", ""], ["x", "--all", "--team"]]) {
    const r = b.nativeDoor(args);
    const need = args.includes("--item") ? "--item needs an id" : "--team needs a value";
    expect(r.status).toBe(1);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe(`tap show: ${need}; next: tap help show\n`);
  }
});

test("show through both public doors: zero writes and native parity", () => {
  const b = fixtureTwo();
  const D = "decoy-20260905T130009Z-aaaabbbbcccc", PC = "plain-20260905T130012Z-ccccddddeeee";
  b.put(`payloads/${D}.md`, b.payload(D)); b.put(`payloads/${PC}.md`, b.payload(PC));
  const digest3 = "courier-20260905T130013Z-ddddeeeeffff";
  const item = (id: string, path: string) => ({ id, path, from: "sender", reply: "settle-only", settled: false });
  b.put(`spool/digests/${digest3}.json`, JSON.stringify({ kind: "digest", digest_id: digest3, items: [
    item(D, join(b.bus, `payloads/${D}.md`)),
    item("ghost-20260905T130010Z-9999aaaabbbb", join(b.bus, "payloads/ghost-20260905T130010Z-9999aaaabbbb.md")),
    item(PC, join(b.bus, `payloads/${PC}.md`)),
  ] }));
  const door = (script: string, args: string[]) => {
    const before = b.manifest();
    const r = spawnSync("bash", [join(showTree, script), "show", ...args],
      { cwd: b.root, encoding: "buffer", env: b.env });
    expect(b.manifest()).toEqual(before);
    if (r.status === null) throw new Error("door exited by signal");
    return { status: r.status, out: r.stdout!.toString(), err: r.stderr!.toString() };
  };
  for (const args of [[D, "--team", "teamb"], ["teamb/" + D], [digest3], [digest3, "--all"]]) {
    const bare = b.nativeDoor(args);
    const bareView = { status: bare.status, out: bare.stdout.toString(), err: bare.stderr.toString() };
    const binTap = door("bin/tap", args), rootShim = door("scripts/tap.sh", args);
    expect({ status: binTap.status, out: binTap.out, err: binTap.err }).toEqual(bareView);
    expect({ status: rootShim.status, out: rootShim.out, err: rootShim.err }).toEqual(bareView);
  }
  expect(door("bin/tap", [digest3, "--all"]).err).toContain("ghost-20260905T130010Z-9999aaaabbbb");
});

// Forensic `path=` anchors through the file: the incumbent rendered it with
// no TAP_HOME and an unenrolled cwd, never reading the path prefix as a team.
test("show path= renders with no acting context and never reads the prefix as a team", () => {
  const base = showScratch();
  const cwd = join(base, "outside"), home = join(base, "forensic-home");
  const store = join(base, "forensic-store");
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(store, "index"), { recursive: true });
  // Live machine index, zero enrollments: the walk refuses the unenrolled cwd.
  writeFileSync(join(store, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const id = "decoy-20260905T130009Z-aaaabbbbcccc", file = join(store, `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\nfrom: sender\nto: another-seat\nkind: discuss\npath: body.md\nreply: settle-only\n---\n\nhello\n\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: home, TAP_INDEX_HOME: join(store, "index"), TAP_SPOOL_NOW: "1788615000" };
  delete env.TAP_HOME; delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF; delete env.TAP_VERBOSE;
  const r = spawnSync(process.execPath, [join(import.meta.dir, "support/native-show-entry.ts"), `path=${file}`], { cwd, env, encoding: "buffer" });
  expect(r.status).toBe(0);
  expect(r.stdout.toString()).toContain("id: " + id); expect(r.stdout.toString()).toContain("hello");
  expect(r.stderr.toString()).toBe("");
  expect(readFileSync(file, "utf8").endsWith("hello\n\n")).toBe(true);
  expect(() => readdirSync(home)).toThrow();
});

test("show discloses a lower-ranked copy of the winning logical id; no sibling means no line", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  f.put(`payloads/${id}.md`, f.payload(id));
  const quiet = f.nativeDoor([id]);
  expect(quiet.status).toBe(0); expect(quiet.stdout.toString()).not.toContain("also:");
  f.put(`payloads/.quarantine/${id}.md`, "malformed first try");
  f.put(`payloads/.quarantine/${id}.md.1`, "malformed second try");
  const r = f.nativeDoor([id]), out = r.stdout.toString();
  expect(r.status).toBe(0);
  expect(out).toContain(`path: ${join(f.bus, "payloads", `${id}.md`)}`);
  expect(out.split("\n").filter(line => line.startsWith("also:"))).toEqual([`also: quarantine ×2 (payloads/.quarantine/${id}.md.1)`]);
  // A numbered name that is a directory is not a copy and never counts.
  mkdirSync(join(f.bus, "payloads/.quarantine", `${id}.md.2`));
  expect(f.nativeDoor([id]).stdout.toString()).toContain(`also: quarantine ×2 (payloads/.quarantine/${id}.md.1)`);
  // A different logical id's quarantine never discloses itself under this one.
  f.put(`payloads/.quarantine/other-20260905T130000Z-abcdef012345.md`, "unrelated");
  expect(f.nativeDoor([id]).stdout.toString().match(/^also:/gm)?.length).toBe(1);
});

test("show names each lower-ranked residency once, in rank order, and never the winner's own", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  f.put(`payloads/${id}.md`, f.payload(id));
  f.put(`archive/${id}.cancelled.md`, "old"); f.put(`payloads/.quarantine/${id}.md`, "bad");
  const out = f.nativeDoor([id]).stdout.toString();
  expect(out.split("\n").filter(line => line.startsWith("also:"))).toEqual([
    `also: archive ×1 (archive/${id}.cancelled.md)`, `also: quarantine ×1 (payloads/.quarantine/${id}.md)`,
  ]);
  // Resolving the archived copy directly discloses only what ranks below it.
  const arch = f.nativeDoor([`path=${join(f.bus, "archive", `${id}.cancelled.md`)}`]).stdout.toString();
  expect(arch).toContain(`also: quarantine ×1 (payloads/.quarantine/${id}.md)`); expect(arch).not.toContain("also: archive");
});

test("show disclosure is read-only on the bus", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  f.put(`payloads/${id}.md`, f.payload(id)); f.put(`payloads/.quarantine/${id}.md`, "bad");
  const before = f.manifest(); f.nativeDoor([id]); expect(f.manifest()).toEqual(before);
});

test("show discloses lower-ranked copies of a digest winner after its listing", () => {
  const f = fixture(), digest = "courier-20260905T130001Z-abcdef012345";
  f.put(`spool/digests/${digest}.json`, JSON.stringify({ kind: "digest", digest_id: digest, items: [] }));
  const quiet = f.nativeDoor([digest]);
  expect(quiet.status).toBe(0); expect(quiet.stdout.toString()).not.toContain("also:");
  f.put(`archive/${digest}.cancelled.md`, "old"); f.put(`payloads/.quarantine/${digest}.md`, "bad");
  const r = f.nativeDoor([digest]);
  expect(r.status).toBe(0);
  expect(r.stdout.toString().split("\n").filter(line => line.startsWith("also:"))).toEqual([
    `also: archive ×1 (archive/${digest}.cancelled.md)`, `also: quarantine ×1 (payloads/.quarantine/${digest}.md)`,
  ]);
});
