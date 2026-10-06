import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";

import { acquirePaneLock } from "../src/panelock";

const roots: string[] = [];
const readRunFile = (debug: string, id: string) => JSON.parse(readFileSync(join(debug, id, readdirSync(join(debug, id)).find(n => /^(run|state)\.json$/.test(n))!), "utf8"));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(config?: string, stockBash = false) {
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-policy-"));
  roots.push(root);
  for (const p of ["bin", "bus/payloads", "bus/receipts", "config/tap", "index", "state"]) mkdirSync(join(root, p), { recursive: true });
  if (stockBash) symlinkSync("/bin/bash", join(root, "bin/bash"));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // born live (F1)
  if (config !== undefined) writeFileSync(join(root, "config/tap/config.toml"), config, { mode: 0o600 });
  writeFileSync(join(root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: {
    peer: { session: "testteam/peer", pane: "testteam/peer:0.0", pane_id: "%301", harness: "codex", server_epoch: "srv:900:100", boot_id: "boot:1", status: "active" },
  } }));
  writeFileSync(join(root, "state/frame"), "› [[TAP v0.23 note sender-20260907T000000Z-abcd]]\n");
  writeFileSync(join(root, "bus/payloads/sender-20260907T000000Z-abcd.md"), "---\nid: sender-20260907T000000Z-abcd\nfrom: sender\nto: peer\nkind: note\nreply: settle-only\n---\nFixture.\n");
  writeFileSync(join(root, "state/effects"), "");
  writeFileSync(join(root, "state/copy"), "1");
  writeFileSync(join(root, "bin/tmux"), `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
const args=process.argv.slice(2); while (["-L", "-S"].includes(args[0])) args.splice(0,2); const cmd=args[0], root=process.env.FAKE_ROOT;
if (existsSync(root+"/state/hang-reads") && process.env.TAP_RECOVERY_RUN && ["display-message","list-panes","list-sessions","capture-pane"].includes(cmd)) { appendFileSync(root+"/state/tmux.log", "run=yes "+cmd+"\\n"); const w=Date.now()+5000; while (Date.now()<w); }
if (cmd === "display-message") {
 const fmt=args.at(-1);
 const harness=(existsSync(root+"/state/harness") ? readFileSync(root+"/state/harness", "utf8") : "codex").trim();
 // The native submit loop's pane identity: server identity, then one combined read.
 if (fmt === "#{pid}:#{start_time}") { console.log("900:100"); process.exit(0); }
 if (fmt === "#{pane_id}\\t#{session_name}\\t#{pane_pid}\\t#{pane_current_command}\\t#{pane_dead}") { const phases=root+"/bus/receipts/sender-20260907T000000Z-abcd.submit-phases.jsonl"; console.log((existsSync(root+"/state/observe-drift") && existsSync(phases) && readFileSync(phases, "utf8").includes("Enter-intent") ? "%302" : "%301") + "\\ttestteam/peer\\t" + (existsSync(root+"/state/pane-pid") ? readFileSync(root+"/state/pane-pid", "utf8").trim() : "301") + "\\t" + harness + "\\t0"); process.exit(0); }
 console.log(fmt.includes("pane_pid") ? (existsSync(root+"/state/pane-pid") ? readFileSync(root+"/state/pane-pid", "utf8") : "301") : fmt.includes("pane_id") ? "%301" : fmt.includes("pane_in_mode") ? (existsSync(root+"/state/copy") ? "1" : "0") : fmt.includes("pane_dead") ? "0" : fmt.includes("session_windows") ? "1" : fmt.includes("pane_current_command") ? (existsSync(root+"/state/harness") ? readFileSync(root+"/state/harness", "utf8") : "codex") : "");
} else if(cmd === "list-sessions") { if(existsSync(root+"/state/armed") && existsSync(root+"/state/tmux-blind")) process.exit(1); console.log("testteam/peer\\t900:100"); }
else if(cmd === "list-panes" && args.at(-1) === "#{pane_id}") { if(existsSync(root+"/state/arm-on-inspect")) writeFileSync(root+"/state/armed", "1"); console.log("%301"); }
else if(cmd === "list-panes") console.log("testteam/peer\\ttestteam/peer:0.0\\t" + ((existsSync(root+"/state/armed") && existsSync(root+"/state/pane-recycled")) ? "%302" : "%301") + "\\t" + (existsSync(root+"/state/list-harness") ? readFileSync(root+"/state/list-harness", "utf8").trim() : "codex") + "\\t301\\t900:100\\t0");
else if(cmd === "capture-pane") { if(existsSync(root+"/state/replace-on-capture")) { rmSync(root+"/state/replace-on-capture"); const r=JSON.parse(readFileSync(root+"/bus/registry.json","utf8")); r.seats.peer.instance="peer-i2"; writeFileSync(root+"/bus/registry.json", JSON.stringify(r)); } if(args.includes("-S") && existsSync(root+"/state/history")) process.stdout.write(readFileSync(root+"/state/history")); process.stdout.write(readFileSync(root+"/state/frame")); }
else { if(args.includes("cancel")) rmSync(root+"/state/copy", {force:true}); appendFileSync(root+"/state/effects", args.join(" ")+"\\n"); if(args.includes("Enter") && existsSync(root+"/state/fail-enter")) { process.stderr.write("synthetic tmux outcome unknown"); process.exit(125); } if(args.includes("Enter") && !existsSync(root+"/state/sticky")) writeFileSync(root+"/state/frame", existsSync(root+"/state/after-enter") ? readFileSync(root+"/state/after-enter", "utf8") : "› \\n"); }
`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_HOME: join(root, "bus"),
    TAP_INDEX_HOME: join(root, "index"), TAP_SERVER_EPOCH: "srv:900:100", TAP_BOOT_ID: "boot:1",
    PATH: join(root, "bin") + ":" + process.env.PATH, FAKE_ROOT: root, TAP_TUI_SETTLE_SCALE: "0.01" };
  const detective = (...args: string[]) => {
    mkdirSync(join(root, ".tap"), { recursive: true });
    if (!readdirSync(join(root, ".tap")).includes("bus")) symlinkSync(join(root, "bus"), join(root, ".tap/bus"));
    writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { testteam: { root, registry_location: join(root, "bus/registry.json") } } }));
    return spawnSync("bash", [resolve(import.meta.dir, "../../../scripts/tap.sh"), "detective", ...args], { cwd: root, env, encoding: "utf8", timeout: 40000 });
  };
  return { root, env, detective, run: (...args: string[]) => spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "peer", ...args], { cwd: root, env, encoding: "utf8", timeout: 25000 }), effects: () => readFileSync(join(root, "state/effects"), "utf8") };
}

test("public nudge report-only config preserves a staged sentinel and copy mode", () => {
  const f = fixture('[recovery]\naggressiveness = "report-only"\n');
  const before = readFileSync(join(f.root, "state/frame"), "utf8");
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("aggressiveness=report-only source=config");
  expect(result.stdout).toContain("[[TAP v0.23");
  expect(f.effects()).toBe("");
  expect(readFileSync(join(f.root, "state/frame"), "utf8")).toBe(before);
}, 20000);

test("--dry-run wins over aggressive config, even with obstructed composer", () => {
  const f = fixture('[recovery]\naggressiveness = "aggressive"\n');
  writeFileSync(join(f.root, "state/frame"), "Settings dialog\n");
  const result = f.run("--dry-run");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("dry run plan");
  expect(result.stdout).toContain("Settings dialog");
  expect(f.effects()).toBe("");
}, 20000);

// tap-xe42x: Hermes' staged `/queue` wire gets the one Enter only, never retyping,
// and its unverifiable no-prompt submit is not reported as a possible-effect failure.
test("rung 2 on a Hermes /queue-staged wire presses one Enter and types nothing", () => {
  const f = fixture();
  const id = "aspen-ponytail-20261001T061307Z-823e7d31b544";
  writeFileSync(join(f.root, "state/harness"), "hermes");
  writeFileSync(join(f.root, "state/list-harness"), "hermes");
  const registry = JSON.parse(readFileSync(join(f.root, "bus/registry.json"), "utf8"));
  registry.seats.peer.harness = "hermes";
  writeFileSync(join(f.root, "bus/registry.json"), JSON.stringify(registry));
  writeFileSync(join(f.root, "state/frame"), readFileSync(join(import.meta.dir, "fixtures/hermes-queue-row/idle-staged.ansi")));
  writeFileSync(join(f.root, `bus/payloads/${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: note\nreply: settle-only\n---\nFixture.\n`);
  rmSync(join(f.root, "state/copy"));
  const result = f.run();
  const effects = f.effects();
  expect({ status: result.status, out: result.stdout, err: result.stderr }).toMatchObject({ status: 0 });
  expect(effects.match(/Enter/g)).toHaveLength(1);
  expect(effects).not.toContain(" -l ");
}, 30000);

// A staged doorbell binds the wire itself as the expected text, so a Codex
// footer below it neither blocks the Enter nor rides along as composer text.
test("rung 2 submits a staged nudge doorbell above a Codex footer with one Enter", () => {
  const f = fixture(); rmSync(join(f.root, "state/copy"));
  writeFileSync(join(f.root, "state/frame"), "› [[TAP v0.23 nudge]]\n\n  gpt-6-astra high · Context 90% left · /tmp\n");
  const result = f.run();
  expect({ status: result.status, err: result.stderr }).toMatchObject({ status: 0 });
  expect(f.effects().match(/Enter/g)).toHaveLength(1);
  expect(f.effects()).not.toContain(" -l ");
}, 30000);

// The actor is evidence, never a license (charter amendment 2026-10-05): with no seat
// pane and no terminal the run records `unknown` and the ladder still presses its keys.
// (The fake frame is unclassifiable, so the typed-text license then refuses: exit 5.)
test("an unobservable caller is recorded as unknown and the ladder still acts", () => {
  const f = fixture(); rmSync(join(f.root, "state/copy"));
  writeFileSync(join(f.root, "state/frame"), "› \n");
  const result = f.run();
  expect(result.stdout + result.stderr).not.toContain("unobservable_caller");
  expect(f.effects()).toContain("Escape");
  const debug = join(f.root, "index/debug/recovery");
  const id = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
  expect(readRunFile(debug, id).caller).toMatchObject({ actor: "unknown", team: "" });
}, 30000);

// tap-xe42x F5: the fan-out's selected instance binds the run's own RecoveryTarget. A seat
// replaced after selection (here, on the first pane capture) refuses before any key, on the
// ladder path and on the staged-only path through nudge-start.
for (const [name, frame] of [["ladder", "› \n"], ["staged", "› [[TAP v0.23 note sender-20260907T000000Z-abcd]]\n"]] as const) {
  test(`a seat replaced after fan-out selection refuses before any key: ${name}`, () => {
    const f = fixture(); rmSync(join(f.root, "state/copy"));
    const registry = JSON.parse(readFileSync(join(f.root, "bus/registry.json"), "utf8"));
    registry.seats.peer.instance = "peer-i1";
    writeFileSync(join(f.root, "bus/registry.json"), JSON.stringify(registry));
    writeFileSync(join(f.root, "state/frame"), frame);
    writeFileSync(join(f.root, "state/replace-on-capture"), "1");
    mkdirSync(join(f.root, ".tap"), { recursive: true });
    if (!readdirSync(join(f.root, ".tap")).includes("bus")) symlinkSync(join(f.root, "bus"), join(f.root, ".tap/bus"));
    const src = resolve(import.meta.dir, "../src");
    const code = `import { nudgePinnedSeat } from "${src}/verbs/nudge.ts"; import { AGENT_FAMILIES } from "${src}/verbs/team.ts"; import { tapScriptsDir } from "${src}/scripts-dir.ts";
try { process.exitCode = nudgePinnedSeat(["peer"], tapScriptsDir(), AGENT_FAMILIES, "peer-i1"); } catch (e) { console.error(String((e as { detail?: string }).detail ?? e)); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ["-e", code], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 25000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("replaced after selection");
    expect(f.effects()).toBe("");
  }, 30000);
}

test("invalid policy refuses without pane effects", () => {
  const f = fixture('[recovery]\naggressiveness = "invalid"\n');
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("recovery.aggressiveness");
  expect(f.effects()).toBe("");
}, 20000);

for (const selected of [undefined, "cautious", "aggressive"]) {
  test(`acting nudge preserves complete visible sentinel recovery: ${selected ?? "default"}`, () => {
    const f = fixture(selected ? `[recovery]\naggressiveness = "${selected}"\n` : undefined);
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("re-submitted");
    expect(result.stderr).toContain(`aggressiveness=${selected ?? "aggressive"}`);
    expect(f.effects()).toContain("cancel");
    expect(f.effects()).toContain("Enter");
    expect(readFileSync(join(f.root, "state/frame"), "utf8")).toBe("› \n");
    const debug = join(f.root, "index/debug/recovery");
    const recovery = readdirSync(debug).find(name => name.startsWith("recovery-"))!;
    const events = readFileSync(join(debug, recovery, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.action).some(action => action.includes("copy-mode"))).toBe(true);
    expect(events.map(e => e.action).some(action => action.includes("Enter"))).toBe(true);
    for (const event of events) {
      expect(readFileSync(event.before, "utf8").length).toBeGreaterThan(0);
      expect(readFileSync(event.after, "utf8").length).toBeGreaterThan(0);
      expect(event.state.windowCount).toBe("1");
    }
    const phases = readFileSync(join(f.root, "bus/receipts/sender-20260907T000000Z-abcd.submit-phases.jsonl"), "utf8");
    expect(phases).toContain(recovery);
    // tap-xe42x: the rung-2 run records its actor too; no seat pane and no terminal here is an explicit unknown.
    expect(readRunFile(debug, recovery).caller).toMatchObject({ actor: "unknown", team: "" });

  }, 20000);
}

test("aggressive nudge still refuses a different canonical recipient before copy-mode effects", () => {
  const f = fixture('[recovery]\naggressiveness = "aggressive"\n');
  const path = join(f.root, "bus/payloads/sender-20260907T000000Z-abcd.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("to: peer", "to: stranger"));
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("disagrees");
  expect(f.effects()).toBe("");
}, 20000);

// tap-8nmot: a digest sentinel names no payload — its canonical record is the
// courier's digest index, whose `to`/`to_team` corroborate the recipient the
// same way a payload envelope does.
const DIGEST_ID = "courier-20260930T000000Z-abcd123456ef";
function digestFixture(record: Record<string, unknown> | null): ReturnType<typeof fixture> {
  const f = fixture();
  writeFileSync(join(f.root, "state/frame"), `› [[TAP v0.23 note ${DIGEST_ID} digest]]\n`);
  if (record !== null) {
    mkdirSync(join(f.root, "bus/spool/digests"), { recursive: true });
    writeFileSync(join(f.root, "bus/spool/digests", `${DIGEST_ID}.json`), JSON.stringify(record));
  }
  return f;
}
const DIGEST_RECORD = {
  v: 1, digest_id: DIGEST_ID, kind: "digest", from: "testteam/sender", to: "peer", to_team: "",
  count: 1, instructions: "TAP digest: 1 spooled payload(s).", items: [],
};

test("a staged digest sentinel completes through its digest index record with exactly one Enter", () => {
  const f = digestFixture(DIGEST_RECORD);
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("re-submitted");
  const enters = f.effects().split("\n").filter(line => line.endsWith(" Enter")).length;
  expect(enters).toBe(1);
  expect(readFileSync(join(f.root, "state/frame"), "utf8")).toBe("› \n");
  expect(readFileSync(join(f.root, "bus/receipts", `${DIGEST_ID}.submit-phases.jsonl`), "utf8")).toContain("Enter-sent");
  // A verified injection refreshes the index's retention window (a review
  // catch): the drain must not reap the pointer the recipient was just handed.
  const index = JSON.parse(readFileSync(join(f.root, "bus/spool/digests", `${DIGEST_ID}.json`), "utf8"));
  expect(typeof index.injected_at_epoch).toBe("number");
  // ...and advances the recipient's delivery clock, as the courier's digest path does.
  expect(existsSync(join(f.root, "bus/delivery/peer.json"))).toBe(true);
}, 30000);

// tap-gwccj: a queued (rc 7) nudge of a digest records the queue receipt for each
// member of the selected index record and for the digest itself, as the courier
// does. The fake pane turns Enter into Codex's accepted-queue frame: the wire
// above a working marker, with an empty composer.
const MEMBER_IDS = ["sender-20260930T000000Z-aaaa00000001", "sender-20260930T000000Z-aaaa00000002"];
function queuedFrame(sentinel: string): string { return `${sentinel}\n• Working (3s • esc to interrupt)\n› \n`; }
function queuedDigestFixture(): ReturnType<typeof fixture> {
  const f = digestFixture({ ...DIGEST_RECORD, from: "testteam/courier", count: 2,
    items: MEMBER_IDS.map(id => ({ id, path: `payloads/${id}.md` })) });
  for (const id of MEMBER_IDS) {
    writeFileSync(join(f.root, "bus/payloads", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: note\nreply: settle-only\n---\nMember.\n`);
  }
  writeFileSync(join(f.root, "state/after-enter"), queuedFrame(`[[TAP v0.23 note ${DIGEST_ID} digest]]`));
  return f;
}
const receiptJson = (f: ReturnType<typeof fixture>, id: string, suffix: string) =>
  JSON.parse(readFileSync(join(f.root, "bus/receipts", `${id}.${suffix}`), "utf8"));

test("a queued digest nudge records .harness-queued for every member and the digest, and no .sent", () => {
  const f = queuedDigestFixture();
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("queued in harness");
  for (const id of MEMBER_IDS) {
    expect(receiptJson(f, id, "harness-queued")).toMatchObject({ id, status: "queued", delivery: "harness-queue", from: "sender", to: "peer", kind: "note" });
    expect(existsSync(join(f.root, "bus/receipts", `${id}.sent`))).toBe(false);
  }
  // The digest has no payload, so its receipt carries the index's route.
  expect(receiptJson(f, DIGEST_ID, "harness-queued")).toMatchObject({ id: DIGEST_ID, status: "queued", delivery: "harness-queue",
    from: "testteam/courier", to: "testteam/peer", kind: "digest" });
  expect(existsSync(join(f.root, "bus/receipts", `${DIGEST_ID}.sent`))).toBe(false);
}, 30000);

test("a queued digest nudge skips a member withdrawn before the submit and keeps the helper's cancellation handling", () => {
  const f = queuedDigestFixture();
  writeFileSync(join(f.root, "bus/receipts", `${MEMBER_IDS[0]}.cancelled`), JSON.stringify({ id: MEMBER_IDS[0], via: "withdrawn" }) + "\n");
  expect(f.run().status).toBe(0);
  expect(existsSync(join(f.root, "bus/receipts", `${MEMBER_IDS[0]}.harness-queued`))).toBe(false);
  expect(existsSync(join(f.root, "bus/receipts", `${MEMBER_IDS[1]}.harness-queued`))).toBe(true);
  expect(existsSync(join(f.root, "bus/receipts", `${DIGEST_ID}.harness-queued`))).toBe(true);
}, 30000);

test("a queued ordinary-payload nudge still records only its own .harness-queued receipt", () => {
  const f = fixture();
  const id = "sender-20260907T000000Z-abcd";
  writeFileSync(join(f.root, "state/after-enter"), queuedFrame(`[[TAP v0.23 note ${id}]]`));
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("queued in harness");
  expect(receiptJson(f, id, "harness-queued")).toMatchObject({ id, status: "queued", delivery: "harness-queue", from: "sender", to: "peer", kind: "note" });
  expect(existsSync(join(f.root, "bus/receipts", `${id}.sent`))).toBe(false);
  expect(readdirSync(join(f.root, "bus/receipts")).filter(name => name.endsWith(".harness-queued"))).toEqual([`${id}.harness-queued`]);
}, 30000);

test("a digest sentinel with neither payload nor index record still refuses not_found", () => {
  const f = digestFixture(null);
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`stuck sentinel id '${DIGEST_ID}' has no payload on`);
  expect(f.effects()).toBe("");
}, 20000);

test("a digest record naming another recipient refuses exactly like a payload mismatch", () => {
  const f = digestFixture({ ...DIGEST_RECORD, to: "stranger" });
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("disagrees");
  expect(f.effects()).toBe("");
}, 20000);

// The record authorizes an Enter, so anything that is not
// exactly this id's digest record is malformed and keeps not_found with no key.
const MALFORMED_DIGEST_RECORDS: Array<[string, string]> = [
  ["JSON null", "null"],
  ["a JSON array", JSON.stringify([DIGEST_RECORD])],
  ["the wrong kind", JSON.stringify({ ...DIGEST_RECORD, kind: "payload" })],
  ["another digest's id", JSON.stringify({ ...DIGEST_RECORD, digest_id: "courier-20260930T000000Z-000000000000" })],
  ["a non-string to_team", JSON.stringify({ ...DIGEST_RECORD, to_team: 7 })],
  ["a missing to_team", JSON.stringify({ ...DIGEST_RECORD, to_team: undefined })],
  // The recipient's digestView needs member rows with string id/path.
  ["no items array", JSON.stringify({ ...DIGEST_RECORD, items: undefined })],
  ["an item without a path", JSON.stringify({ ...DIGEST_RECORD, items: [{ id: "m1" }] })],
  // ...and unique member ids with unique positive ordinals (digestPlan).
  ["duplicate member ids", JSON.stringify({ ...DIGEST_RECORD, items: [{ id: "m1", path: "a" }, { id: "m1", path: "b" }] })],
  ["a nonpositive ordinal", JSON.stringify({ ...DIGEST_RECORD, items: [{ id: "m1", path: "a", ordinal: 0 }] })],
  // tap-gwccj: a member id becomes a receipt path and `from` becomes the digest receipt's route.
  ["a path-shaped member id", JSON.stringify({ ...DIGEST_RECORD, items: [{ id: "../../../README", path: "a" }] })],
  ["a missing from", JSON.stringify({ ...DIGEST_RECORD, from: undefined })],
  ["an empty from", JSON.stringify({ ...DIGEST_RECORD, from: "" })],
];
test("a digest record with invalid UTF-8 inside a JSON string refuses not_found and sends no key", () => {
  const f = digestFixture(null);
  mkdirSync(join(f.root, "bus/spool/digests"), { recursive: true });
  const [head, tail] = JSON.stringify({ ...DIGEST_RECORD, instructions: "SPLIT" }).split("SPLIT");
  // A lone 0xff byte: lenient utf8 decoding would turn it into U+FFFD and parse.
  writeFileSync(join(f.root, "bus/spool/digests", `${DIGEST_ID}.json`), Buffer.concat([Buffer.from(head!), Buffer.from([0xff]), Buffer.from(tail!)]));
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`stuck sentinel id '${DIGEST_ID}' has no payload on`);
  expect(f.effects()).toBe("");
}, 20000);

for (const [label, raw] of MALFORMED_DIGEST_RECORDS) {
  test(`a digest record with ${label} refuses not_found and sends no key`, () => {
    const f = digestFixture(null);
    mkdirSync(join(f.root, "bus/spool/digests"), { recursive: true });
    writeFileSync(join(f.root, "bus/spool/digests", `${DIGEST_ID}.json`), raw);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`stuck sentinel id '${DIGEST_ID}' has no payload on`);
    expect(f.effects()).toBe("");
  }, 20000);
}

test("an already-observed digest (.read, never .done) refuses by terminality", () => {
  const f = digestFixture({ ...DIGEST_RECORD, items: [{ id: "m1", path: "payloads/m1.md" }] });
  writeFileSync(join(f.root, "bus/receipts", `${DIGEST_ID}.read`), "{}\n");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(".read exists");
  expect(f.effects()).toBe("");
}, 20000);

test("an already-settled digest refuses by terminality", () => {
  const f = digestFixture(DIGEST_RECORD);
  writeFileSync(join(f.root, "bus/receipts", `${DIGEST_ID}.done`), "{}\n");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("already settled");
  expect(f.effects()).toBe("");
}, 20000);

for (const harness of ["zsh", "unknown-harness"]) {
  test(`report-only captures ${harness} without applying acting-mode harness gates`, () => {
    const f = fixture('[recovery]\naggressiveness = "report-only"\n');
    writeFileSync(join(f.root, "state/harness"), harness);
    writeFileSync(join(f.root, "state/frame"), "Unexpected process on the seat\n");
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unexpected process on the seat");
    expect(f.effects()).toBe("");
  }, 20000);
}

test("stock /bin/bash handles configured report-only, --dry-run and the default", () => {
  // macOS /bin/bash is 3.2: nounset rejects a bare empty-array expansion at runtime.
  // Pin every public wrapper, not just the outer process, to the system shell.
  const configured = fixture('[recovery]\naggressiveness = "report-only"\n', true);
  const implicit = configured.run();
  expect(implicit.status).toBe(0);
  expect(implicit.stderr).toContain("aggressiveness=report-only source=config");
  const explicit = configured.run("--dry-run");
  expect(explicit.status).toBe(0);
  expect(explicit.stdout).toContain("dry run plan");
  expect(configured.effects()).toBe("");
  const fallback = fixture(undefined, true).run();
  expect(fallback.status).toBe(0);
  expect(fallback.stderr).toContain("aggressiveness=aggressive source=default");
}, 30000);

test("public detective report-only records evidence without a worker, hold or pane effects", () => {
  const f = fixture();
  const result = f.detective("peer", "--aggressiveness", "report-only", "--json");
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  expect(output.kind).toBe("observed"); expect(output.cleanup).toEqual([]);
  const directory = join(f.root, "index/debug/recovery", output.recovery_id);
  const run = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
  expect(run.mode).toBe("report-only"); expect(run.state).toBe("released"); expect(run.worker).toBeUndefined();
  expect(readFileSync(join(directory, "evidence.json"), "utf8")).not.toContain("Fixture.");
  expect(readFileSync(join(directory, "worker-current.ansi"), "utf8")).toContain("[[TAP");
  expect(f.effects()).toBe("");
  const invalid = f.detective("peer", "--key", "Enter");
  expect(invalid.status).toBe(1); expect(f.effects()).toBe("");
}, 45000);

test("public report-only nudge and detective inspect while the target effect mutex is held", () => {
  const f = fixture(); const lock = acquirePaneLock("%301", 1000, f.env)!;
  expect(lock).not.toBeNull();
  try {
    const nudge = f.run("--dry-run");
    if (nudge.status !== 0) throw new Error(nudge.stderr);
    expect(nudge.stdout).toContain("[[TAP");
    const detective = f.detective("peer", "--aggressiveness", "report-only", "--json");
    if (detective.status !== 0) throw new Error(detective.stderr);
    expect(JSON.parse(detective.stdout).kind).toBe("observed"); expect(f.effects()).toBe("");
  } finally { lock.release(); }
}, 45000);

test("a recorded read that hangs trips the shared tmux deadline through the public door", () => {
  const f = fixture(); rmSync(join(f.root, "state/copy")); writeFileSync(join(f.root, "state/hang-reads"), "1");
  const result = spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "peer"], { cwd: f.root, env: { ...f.env, TAP_TMUX_TIMEOUT_SECONDS: "2" }, encoding: "utf8", timeout: 30000 });
  expect(result.status).toBe(1); expect(result.stderr).toContain("deadline expired");
  expect(readFileSync(join(f.root, "state/tmux.log"), "utf8")).toContain("run=yes"); expect(f.effects()).not.toContain("Enter"); expect(readFileSync(join(f.root, "state/frame"), "utf8")).toContain("[[TAP"); expect(readdirSync(join(f.root, "index/debug/recovery")).some(p => p.startsWith("recovery-"))).toBe(true);
}, 30000);

test("non-regular payload and receipt kinds follow the regular-file predicate; an empty --pane refuses first", () => {
  const f = fixture(); mkdirSync(join(f.root, "bus/receipts/sender-20260907T000000Z-abcd.done"));
  const ok = f.run(); expect(ok.status).toBe(0); expect(ok.stdout).toContain("re-submitted");  const g = fixture(); rmSync(join(g.root, "bus/payloads/sender-20260907T000000Z-abcd.md")); mkdirSync(join(g.root, "bus/payloads/sender-20260907T000000Z-abcd.md"));
  const no = g.run(); expect(no.status).toBe(1); expect(no.stderr).toContain("no payload on"); expect(g.effects()).toBe("");
  const empty = fixture().run("--pane", ""); expect(empty.status).toBe(1); expect(empty.stderr).toContain("--pane needs a value");
}, 30000);

test("an explicit TAP_HOME pin outranks an enrolled foreign cwd with a same-name seat", () => {
  const f = fixture(); const b = join(f.root, "b"); mkdirSync(join(b, "bus/payloads"), { recursive: true }); mkdirSync(join(f.root, ".tap"), { recursive: true }); symlinkSync(join(f.root, "bus"), join(f.root, ".tap/bus"));
  writeFileSync(join(b, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "bteam" }, seats: { peer: { session: "bteam/peer", pane: "bteam/peer:0.0", pane_id: "%302", harness: "codex", server_epoch: "srv:900:100", boot_id: "boot:1", status: "active" } } }));
  writeFileSync(join(f.root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { testteam: { root: f.root, registry_location: join(f.root, "bus/registry.json") }, bteam: { root: b, registry_location: join(b, "bus/registry.json") } } }));
  const pinned = spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "peer"], { cwd: b, env: { ...f.env, TAP_HOME: realpathSync(join(f.root, ".tap", "bus")) }, encoding: "utf8", timeout: 30000 });
  expect(pinned.status).toBe(0); expect(pinned.stdout).toContain("re-submitted"); expect(f.effects()).toContain("Enter"); expect(f.effects()).not.toContain("bteam");
}, 30000);

test("an unsupported shallow harness defers to the observed process table", () => {
  const f = fixture(); writeFileSync(join(f.root, "state/harness"), "node"); symlinkSync("/bin/sleep", join(f.root, "bin/codex"));
  const child = spawn(join(f.root, "bin/codex"), ["30"], { stdio: "ignore" }); writeFileSync(join(f.root, "state/pane-pid"), String(child.pid));
  const live = f.run(); expect(live.status).toBe(0); expect(live.stdout).toContain("re-submitted"); child.kill();
  const dead = f.run(); expect(dead.status).toBe(1); expect(dead.stderr).toContain("unsupported harness");
}, 30000);

test("a present legacy row defaults status/delivery; a missing row stays distinct", () => {
  const f = fixture(); writeFileSync(join(f.root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: { peer: { session: "testteam/peer", pane: "testteam/peer:0.0", pane_id: "%301", harness: "codex", server_epoch: "srv:900:100", boot_id: "boot:1" } } }));
  const ok = f.run(); expect(ok.status).toBe(0); expect(ok.stdout).toContain("re-submitted");
  const g = fixture(); writeFileSync(join(g.root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: {} }));
  const no = g.run("--pane", "testteam/peer:0.0"); expect(no.status).toBe(1); expect(no.stderr).toContain("missing, inactive"); expect(g.effects()).toBe("");
}, 30000);

test("a failed recovery start relays the child's diagnostics before returning", () => {
  const f = fixture(); expect(f.run("--dry-run").status).toBe(0);
  const id = readdirSync(join(f.root, "index/debug/recovery")).find(p => p.startsWith("recovery-"))!; const relayed = spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "peer"], { cwd: f.root, env: { ...f.env, TAP_RECOVERY_RUN: id }, encoding: "utf8", timeout: 30000 });
  expect(relayed.status).toBe(1); expect(relayed.stderr).toContain("parent recovery does not authorize nudge"); expect(f.effects()).toBe("");
}, 30000);

test("report-only prints the current viewport while retaining full history in its artifact", () => {
  const f = fixture(); writeFileSync(join(f.root, "state/history"), "Unrelated historical conversation\n");
  const result = f.run("--dry-run");
  expect(result.status).toBe(0); expect(result.stdout).not.toContain("Unrelated historical conversation");
  expect(result.stdout).toContain("[[TAP");
  const root = join(f.root, "index/debug/recovery"), id = readdirSync(root).find(p => p.startsWith("recovery-"))!;
  expect(readFileSync(join(root, id, "inspection.ansi"), "utf8")).toContain("Unrelated historical conversation");
});

// The two guard arms used to shim `bin/bash`, because the guard SPAWNED one.
// tap-fqd3e deleted that backcall, so the shim would now be inert and both arms
// would have gone green while exercising nothing (rule 48). They drive the real
// seam instead: `refusal` drifts the registry's recorded pane id, and
// `unobservable` blinds tmux. `unobservable` is the successor to the arm that
// was called `timeout` — the outcome it protected was "the instrument could not
// answer", which a 10 s spawn deadline used to be the only way to produce here.
for (const mode of ["refusal", "unobservable", "success", "possible-failure"]) {
  test(`public recorded nudge separates Enter intent from ${mode}`, () => {
    const f = fixture(); rmSync(join(f.root, "state/copy"));
    // The perturbation has to land in the AUTHORIZE-THEN-ACT WINDOW, which is
    // the only window this guard exists to close. Breaking tmux or the registry
    // up front is caught by preflight instead — `tap nudge: stuck sentinel
    // recipient identity drifted` — and the recovery run never starts, so both
    // arms would be measuring the preflight and not the guard. `arm-on-inspect`
    // flips the fixture on the recovery inspection's own capture, which is the
    // first call INSIDE the run.
    if (mode === "refusal" || mode === "unobservable") {
      writeFileSync(join(f.root, "state/arm-on-inspect"), "1");
      writeFileSync(join(f.root, mode === "refusal" ? "state/pane-recycled" : "state/tmux-blind"), "1");
    }
    if (mode === "possible-failure") writeFileSync(join(f.root, "state/fail-enter"), "1");
    const result = f.run();
    expect(result.status === 0).toBe(mode === "success");
    const debug = join(f.root, "index/debug/recovery"), id = readdirSync(debug).find(p => p.startsWith("recovery-"))!;
    const events = readFileSync(join(debug, id, "events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const event = events.find(e => e.action === "nudge Enter"); expect(event).toBeDefined();
    const phases = readFileSync(join(f.root, "bus/receipts/sender-20260907T000000Z-abcd.submit-phases.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const intent = phases.find(p => p.phase === "Enter-intent"), final = phases.find(p => p.phase === "verify-result");
    expect(intent.enter_count).toBe(0); expect(intent.ordinal).toBe(1);
    if (mode === "refusal" || mode === "unobservable") {
      // A refused recovery effect pressed nothing, and says so: submit-unverified.
      expect(result.status).toBe(5);
      expect(event.effect).toBe("none");
      expect(JSON.parse(readFileSync(join(debug, id, "run.json"), "utf8")).effects).toBe(0);
      // The LAST check, not the first: `effect.ts` reauthorizes several times,
      // and the perturbation lands inside the run, so the earlier checks
      // legitimately authorized against a pane that had not moved yet. What
      // matters is that the one immediately before the keystroke refused —
      // which `effect: none` and `effects: 0` above are the consequence of.
      const check = event.identityChecks.at(-1);
      expect(check.outcome).toBe(mode === "unobservable" ? "unobservable" : "refused");
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
      // The STATE is the half the subprocess version could never carry: it could
      // report that bash exited 7, not which identity fact moved.
      // `address_rebound` rather than `pane_recycled`: the seat classifier sees
      // the recorded address now hosting a DIFFERENT id and says so in its own
      // vocabulary, which `boundPaneIdentityState` forwards. The incumbent does
      // the same (`printf '%s' "${reason:-seat_$observed}"`), and the token is
      // the more precise of the two — it names what moved.
      expect(check.state).toBe(mode === "unobservable" ? "session_unobservable" : "address_rebound");
      expect(f.effects()).toBe(""); expect(final.enter_count).toBe(0);
      expect(phases.some(p => p.phase === "Enter-sent")).toBe(false);
      expect(result.stderr).toContain(mode === "unobservable" ? "identity guard unobservable" : "state=address_rebound");
    } else {
      expect(event.effect).toBe("possible"); expect(f.effects()).toContain("Enter"); expect(final.enter_count).toBe(1);
      expect(phases.some(p => p.phase === "Enter-sent")).toBe(mode === "success");
      expect(final.result).toBe(mode === "success" ? "verified" : "unverified");
    }
  }, 30000);
}

// The submit loop's own reauthorization, not the recovery effect's guard: the
// pane moves just before the first Enter. Before any Enter the
// refusal keeps its identity class, so nudge names drift and nothing was sent.
test("identity drift before nudge's first Enter is a drift refusal with no key", () => {
  const f = fixture(); rmSync(join(f.root, "state/copy"));
  // The pane moves once the loop has recorded its Enter intent, so the final
  // pre-Enter authorize is the read that sees it.
  writeFileSync(join(f.root, "state/observe-drift"), "1");
  const result = f.run();
  // Submit rc 6 surfaces as nudge's public drift refusal, not submit-unverified.
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("identity drifted before submit");
  expect(f.effects()).not.toContain("Enter");
}, 30000);

// A wire that stays staged after Enter gets the bounded Enter ladder and ends
// submit-unverified, never verified. OpenCode's one-Enter ceiling is pinned in
// regress/nudge-submit-verify.test.sh, which carries the OpenCode composer.
// tap-xe42x: rung 2 presses exactly one Enter for every family, never the courier's ladder of four.
test("a still-staged wire after nudge's one Enter is unverified (exit 5) on a non-OpenCode family", () => {
  const f = fixture(); rmSync(join(f.root, "state/copy"));
  writeFileSync(join(f.root, "state/sticky"), "1");
  const result = f.run();
  expect(result.status).toBe(5);
  const enters = f.effects().split("\n").filter(line => line.endsWith(" Enter")).length;
  expect(enters).toBe(1);
}, 30000);
