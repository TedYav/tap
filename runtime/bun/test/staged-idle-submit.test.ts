// tap-9lqa7: the idle-time staged-sentinel submit. The staged-idle hold,
// its evidence predicate, the .idle-submit license, the courier arm's gates
// (Enter-only by construction), and the drain seams that can pick the parked
// row up. Frames are synthetic with neutral filler; no real capture.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";
import { classifySubmitFrame, sentinelSubmitDecision, visibleSentinelId } from "../src/submit-frame";
import { beginDeliveryAttempt } from "../src/delivery-attempt";
import { stagedIdleEvidence, stagedIdleSubmitEligible, recordPhase } from "../src/submit-phase";
import { beginIdleSubmit } from "../src/delivery-attempt";
import { stagedIdleHoldOutcome, recoverStrandedReparks } from "../src/spool-repark";
import { publishPair, reasonClass, stagedIdleWindowSeconds, type PublishInput } from "../src/spool-publication";
import { heldSpoolClass } from "../src/spool-grace";
import { redeliver, realDrainEffects } from "../src/spool-drain-effects";
import { drainOnce, type DrainContext, type DrainEffects, type SpoolBinding } from "../src/spool-drain";
import { DEFAULT_AGENT_FAMILIES } from "../src/observe";
import { acquirePathLock } from "../src/panelock";
import { installSpoolPane } from "./support/spool-pane";
import { attemptCount, retryMarkerPath } from "../src/retry";
import { noEffectProof } from "../src/spool-effect-proof";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scripts = join(import.meta.dir, "../../../skills/tap/scripts");

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "staged-idle-"));
  roots.push(root);
  const home = join(root, ".tap", "bus");
  for (const path of [home, join(home, "spool"), join(home, "payloads"), join(home, "receipts")]) mkdirSync(path, { recursive: true });
  return home;
}

const ID = "peer-seat-20260928T120000Z-aabbccddeeff";
const RETRY = "00000000-0000-4000-8000-000000000001";
const ADMITTED = "2026-10-13T10:00:00.500Z";
const wire = (id: string) => `[[TAP v0.23 note ${id}]]`;

/** Land an attempt that ended unverified: the staged-idle evidence core. */
function landUnverifiedAttempt(home: string, id: string, withEnterRow = false): void {
  recordPhase(home, { id, attempt: "attempt-1", phase: "injected-text-confirmed", recipient: "peer", enter_count: 0 });
  if (withEnterRow) recordPhase(home, { id, attempt: "attempt-1", phase: "Enter-sent", recipient: "peer", enter_count: 1 });
  recordPhase(home, { id, attempt: "attempt-1", phase: "verify-result", recipient: "peer", enter_count: withEnterRow ? 1 : 0, result: "unverified" });
}

function stageHold(home: string, id = ID, envelopeTo = "peer"): void {
  // deadline_epoch is far-future (year 2100): the window is open under the
  // real clock; deadline-specific tests stamp their own.
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, reason: "staged-idle", deadline_epoch: 4102444800 }));
  writeFileSync(join(home, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: ${envelopeTo}\nkind: note\n---\nneutral body\n`);
  landUnverifiedAttempt(home, id);
}

function stageRetryHold(home: string): void {
  stageHold(home);
  writeFileSync(join(home, "spool", `${ID}.meta.json`), JSON.stringify({ id: ID, reason: "staged-idle", deadline_epoch: 4102444800, retry: RETRY }));
  writeFileSync(retryMarkerPath(home, ID, RETRY), JSON.stringify({ id: ID, retry: RETRY, effect: "possible", admitted_at: ADMITTED }));
  for (const phase of ["injected-text-confirmed", "verify-result"] as const)
    recordPhase(home, { id: ID, attempt: RETRY, phase, recipient: "peer", enter_count: 1, result: "unverified" });
}

test("retry idle evidence ignores only transport receipts proven older than admission", () => {
  const cases: [string, Record<string, unknown>, string, boolean][] = [
    ["sent", {}, "2026-10-13T09:59:59Z", true],
    ["sent", {}, ADMITTED, false],
    ["idle-submit", {}, "2026-10-13T09:59:59Z", true],
    ["idle-submit", {}, ADMITTED, false],
    ["harness-queued", { at: "2026-10-13T09:59:59Z" }, ADMITTED, true],
    ["harness-queued", { at: "2026-10-13T10:00:00Z" }, ADMITTED, false],
    ["harness-queued", { at: "invalid" }, "2026-10-13T09:59:59Z", false],
    ["harness-queued", { at: "1" }, "2026-10-13T09:59:59Z", false],
    ["harness-queued", { at: "2026-10-13T09:59:59Z", status: "unknown" }, ADMITTED, false],
    ["read", { by: "operator", forced: "true" }, ADMITTED, true],
    ["read", { by: "peer", reason: "instance_retired" }, ADMITTED, true],
    ["read", { by: "peer" }, ADMITTED, false],
    ["authorized-read", { by: "peer" }, ADMITTED, false],
    ["done", {}, "2026-10-13T09:59:59Z", false],
    ["cancelled", {}, "2026-10-13T09:59:59Z", false],
    [`retry-${RETRY}.idle-submit`, {}, "2026-10-13T09:59:59Z", false],
  ];
  for (const [suffix, fields, mtime, eligible] of cases) {
    const home = scratch(); stageRetryHold(home);
    const path = join(home, "receipts", `${ID}.${suffix}`);
    writeFileSync(path, JSON.stringify({ id: ID, status: "queued", delivery: "harness-queue", ...fields }));
    utimesSync(path, new Date(mtime), new Date(mtime));
    expect(stagedIdleSubmitEligible(home, ID), suffix + JSON.stringify(fields)).toBe(eligible);
  }
});

test("retry idle evidence needs a valid admission and this retry's unverified injection", () => {
  for (const marker of [null, {}, { id: "other", retry: RETRY, effect: "possible", admitted_at: ADMITTED },
    { id: ID, retry: RETRY, effect: "possible", admitted_at: "invalid" },
    { id: ID, retry: RETRY, effect: "possible", admitted_at: "1" }]) {
    const home = scratch(); stageRetryHold(home);
    if (marker === null) rmSync(retryMarkerPath(home, ID, RETRY));
    else writeFileSync(retryMarkerPath(home, ID, RETRY), JSON.stringify(marker));
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
  }
  const home = scratch(); stageRetryHold(home);
  landUnverifiedAttempt(home, ID); // a different attempt cannot lend this retry authority
  expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
});

test("uncertain observation receipts cannot authorize a retry's automatic Enter", () => {
  for (const suffix of ["read", "authorized-read"]) for (const bytes of ["broken", "{}", JSON.stringify({ id: ID }),
    JSON.stringify({ id: "other", by: "peer", forced: "true" }), JSON.stringify({ id: ID, forced: "true" })]) {
    const home = scratch(); stageRetryHold(home);
    writeFileSync(join(home, "receipts", `${ID}.${suffix}`), bytes);
    expect(stagedIdleSubmitEligible(home, ID), suffix + bytes).toBe(false);
    expect(arm(home, { authority: { attemptUuid: RETRY } }).enters).toBe(0);
  }
  for (const suffix of ["read", "authorized-read"]) {
    const home = scratch(); stageRetryHold(home);
    symlinkSync(join(home, "missing"), join(home, "receipts", `${ID}.${suffix}`));
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
  }
});

test("retry idle license is possible-effect evidence but never an extra ring", () => {
  const home = scratch();
  writeFileSync(join(home, "receipts", `${ID}.retry-${RETRY}.idle-submit`), "{}");
  expect(noEffectProof(home, join(home, "spool"), ID, { attempts: 0, attempt_fence: 1 })).not.toBe("");
  expect(attemptCount(home, ID)).toBe(0);
});

/** Pin TAP_INDEX_HOME to a scratch index resolving each team to its root. */
function pinTeamIndex(root: string, teams: Record<string, string>): () => void {
  const index = join(root, "index");
  mkdirSync(index, { recursive: true });
  const registryLocation = join(root, "registry-location.json");
  writeFileSync(registryLocation, "{}");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: Object.fromEntries(Object.entries(teams).map(([name, teamRoot]) =>
      [name, { root: teamRoot, registry_location: registryLocation }])) }));
  const previous = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = index;
  return () => { if (previous === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = previous; };
}

test("stagedIdleEvidence: an attempt that ended unverified, stop-ambiguous included", () => {
  const home = scratch();
  expect(stagedIdleEvidence(home, ID)).toBe(false); // no rows yet
  landUnverifiedAttempt(home, ID);
  expect(stagedIdleEvidence(home, ID)).toBe(true);
  landUnverifiedAttempt(home, ID, true); // enter_count > 0: stop-ambiguous
  expect(stagedIdleEvidence(home, ID)).toBe(true);
});

test("stagedIdleEvidence: settlement, queue receipts and a spent license all end it", () => {
  for (const [label, mutate] of [
    ["verified result", (home: string) => {
      recordPhase(home, { id: ID, attempt: "attempt-2", phase: "injected-text-confirmed", recipient: "peer", enter_count: 0 });
      recordPhase(home, { id: ID, attempt: "attempt-2", phase: "verify-result", recipient: "peer", enter_count: 0, result: "verified" });
    }],
    ["sent receipt", (home: string) => writeFileSync(join(home, "receipts", `${ID}.sent`), "{}")],
    ["done receipt", (home: string) => writeFileSync(join(home, "receipts", `${ID}.done`), "{}")],
    ["cancelled receipt", (home: string) => writeFileSync(join(home, "receipts", `${ID}.cancelled`), "{}")],
    ["read receipt", (home: string) => writeFileSync(join(home, "receipts", `${ID}.read`), "{}")],
    ["harness queue", (home: string) => writeFileSync(join(home, "receipts", `${ID}.harness-queued`), JSON.stringify({ id: ID, status: "queued", delivery: "harness-queue" }))],
    ["spent idle-submit license", (home: string) => { beginIdleSubmit(home, ID, { stagedId: ID, pane: "tap/peer:0.0", agentState: "idle" }); }],
  ] as const) {
    const home = scratch();
    landUnverifiedAttempt(home, ID);
    mutate(home);
    expect(stagedIdleEvidence(home, ID)).toBe(false);
  }
});

test("stagedIdleSubmitEligible: the spool metadata must name the staged-idle hold", () => {
  const home = scratch();
  stageHold(home);
  expect(stagedIdleSubmitEligible(home, ID)).toBe(true);
  writeFileSync(join(home, "spool", `${ID}.meta.json`), JSON.stringify({ id: ID, reason: "pending-input" }));
  expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
  rmSync(join(home, "spool", `${ID}.meta.json`));
  expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
});

test("stagedIdleSubmitEligible: an elapsed window is the manual path, never a fresh Enter authority", () => {
  // The deadline bounds the Enter itself, not only the post-hoc disposition
  // (review: "Enforce the staged-idle deadline before pressing Enter").
  const previous = process.env.TAP_SPOOL_NOW;
  process.env.TAP_SPOOL_NOW = "1000";
  try {
    const home = scratch();
    landUnverifiedAttempt(home, ID);
    const write = (meta: Record<string, unknown>) =>
      writeFileSync(join(home, "spool", `${ID}.meta.json`), JSON.stringify({ id: ID, reason: "staged-idle", ...meta }));
    write({ deadline_epoch: "2800" }); // mintMeta's numeric-string form
    expect(stagedIdleSubmitEligible(home, ID)).toBe(true);
    write({ deadline_epoch: 2800 }); // mintMeta's numeric form
    expect(stagedIdleSubmitEligible(home, ID)).toBe(true);
    write({ deadline_epoch: 1000 }); // the boundary is expired
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
    write({ deadline_epoch: 999 });
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
    write({}); // absent or malformed deadline is expired by default
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
    write({ deadline_epoch: "soon" });
    expect(stagedIdleSubmitEligible(home, ID)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TAP_SPOOL_NOW; else process.env.TAP_SPOOL_NOW = previous;
  }
});

test("stagedIdleEvidence: unreadable or malformed terminal receipts are spent authority, never absence", () => {
  // A receipt that exists but cannot be parsed is uncertainty; uncertainty
  // ends the authority (review: "Treat unreadable terminal receipts as spent
  // authority").
  for (const suffix of ["sent", "harness-queued"]) {
    const home = scratch();
    landUnverifiedAttempt(home, ID);
    writeFileSync(join(home, "receipts", `${ID}.${suffix}`), "{not json");
    expect(stagedIdleEvidence(home, ID)).toBe(false);
  }
});

test("the window defaults to 1800s and honors only safe integers", () => {
  expect(stagedIdleWindowSeconds({})).toBe(1800);
  expect(stagedIdleWindowSeconds({ TAP_STAGED_IDLE_SUBMIT_WINDOW: "90" })).toBe(90);
  expect(stagedIdleWindowSeconds({ TAP_STAGED_IDLE_SUBMIT_WINDOW: "0" })).toBe(0);
  expect(stagedIdleWindowSeconds({ TAP_STAGED_IDLE_SUBMIT_WINDOW: "soon" })).toBe(1800);
  expect(stagedIdleWindowSeconds({ TAP_STAGED_IDLE_SUBMIT_WINDOW: "-5" })).toBe(1800);
});

test("beginIdleSubmit: one link-atomic license, named for the idle-time Enter", () => {
  const home = scratch();
  expect(beginIdleSubmit(home, ID, { stagedId: ID, pane: "tap/peer:0.0", agentState: "idle" })).toBe("created");
  expect(beginIdleSubmit(home, ID, { stagedId: ID, pane: "tap/peer:0.0", agentState: "idle" })).toBe("existing");
  const receipt = JSON.parse(readFileSync(join(home, "receipts", `${ID}.idle-submit`), "utf8"));
  expect(receipt.label).toBe("idle-time submit of a staged sentinel (Enter only, no bytes)");
  expect(receipt.expected_id).toBe(ID);
  expect(receipt.staged_id).toBe(ID);
  expect(receipt.pane).toBe("tap/peer:0.0");
  expect(receipt.agent_state).toBe("idle");
  // A second observation is a different id: its own license, not this one's.
  expect(beginIdleSubmit(home, "other-seat-20260928T120000Z-112233445566", { stagedId: ID, pane: "tap/peer:0.0", agentState: "idle" })).toBe("created");
});

test("mintMeta's staged-idle branch: window deadline, waiter lifetime, ordinary disposition", () => {
  const root = mkdtempSync(join(tmpdir(), "staged-idle-pub-")); roots.push(root);
  const canonical = join(root, "canon.md");
  writeFileSync(canonical, "---\nid: x\nfrom: a\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  const input: PublishInput = {
    spoolDir: join(root, "spool"), id: "x", canonical, target: "peer", team: "t", reason: "staged-idle", reasonClass: "",
    timeoutSeconds: "1800", pane: "sess:0.0", paneId: "%401", toTeam: "", policy: "standard", graceSeconds: "",
    targetRegistry: "", windowSeconds: "", lastDelivered: "", cueStyle: "", cueRedAt: "",
    env: { ...process.env }, now: new Date(1789458203000), lockTimeoutMs: 1000,
  };
  publishPair(input);
  const row = JSON.parse(readFileSync(join(root, "spool", "x.meta.json"), "utf8"));
  expect(row.reason).toBe("staged-idle");
  expect(row.reason_class).toBe("busy");
  expect(row.waiter_lifetime).toBe("readiness-gate");
  expect(row.deadline_epoch).toBe(1789458203 + 1800);
  expect(row.deadline_source).toBe("");
  // The staged-idle hold keeps its waiter: the readiness-gate lifetime holds.
  expect(heldSpoolClass({ reason_class: "busy", waiter_lifetime: "readiness-gate" }, false, false)).toBe(true);
  expect(reasonClass("staged-idle")).toBe("busy");
});

test("stagedIdleHoldOutcome: fresh hold stamps the window once; held then expired, never re-armed", () => {
  const home = scratch();
  const id = "hold-seat-20260928T120000Z-abcdef012345";
  writeFileSync(join(home, "spool", `${id}.md`), "body");
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, reason: "busy", deadline_epoch: "1" }));
  const env = { ...process.env, TAP_SPOOL_NOW: "1000" };
  expect(stagedIdleHoldOutcome(join(home, "spool"), id, 1800, env)).toBe("held");
  const meta = JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));
  expect(meta.reason).toBe("staged-idle");
  expect(meta.timeout_seconds).toBe("1800");
  expect(meta.deadline_epoch).toBe("2800");
  expect(meta.waiter_lifetime).toBe("readiness-gate");
  expect(meta.deadline_source).toBe("");
  const later = { ...process.env, TAP_SPOOL_NOW: "2799" };
  expect(stagedIdleHoldOutcome(join(home, "spool"), id, 1800, later)).toBe("held"); // window not re-armed
  const expired = { ...process.env, TAP_SPOOL_NOW: "2800" };
  expect(stagedIdleHoldOutcome(join(home, "spool"), id, 1800, expired)).toBe("expired");
});

// ── The courier arm ─────────────────────────────────────────────────────────

const rule = "─".repeat(118);
const frame = (text: string) => [
  "❯ old transcript", "previous output", `${rule} tap/peer ─`,
  `❯ ${text}`, rule,
  "  Opus 5.5 med | 45%↯ 229k/500k | 📁 tap | 🌿 main",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents",
  "  ⏺ main",
  "❯ ◯ general-purpose  Reading docs section   23m 49s · ↓ 200.6k tokens",
  "",
].join("\n");
const workingFrame = (text: string) => frame(text).replace("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents",
  "  esc to interrupt · ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents");
// Current Claude Code paints no `esc to interrupt`: the live spinner row above
// the band, here under a right-aligned notice, is the running turn (tap-7txco).
const spinnerFrame = (text: string) => frame(text).replace("previous output",
  `✽ Elucidating… (running PreToolUse hook · 1m 19s · ↓ 5.5k tokens)\n${" ".repeat(78)}✔ Update installed · Restart to update`);
const modalFrame = (text: string) => frame(text).replace("previous output", ["╭" + "─".repeat(40) + "╮", "│ ✻ Bug report drafted: neutral │", "│ 1 to review · 2 to send · 0 to dismiss │", "╰" + "─".repeat(40) + "╯"].join("\n"));

interface ArmWorld {
  band?: string;               // the busy-band text the paneState reader returns
  frames?: () => string[];     // successive escaped captures (default: the band frame, twice)
  registry?: boolean;          // pass a real registry for corroboration
  envelopeTo?: string;         // payload envelope recipient
  noReaders?: boolean;         // omit captureEscaped/submitFrame from the fake
  authority?: Partial<SubmitAuthority>;
}

function arm(home: string, world: ArmWorld = {}) {
  const band = world.band !== undefined ? world.band : wire(ID);
  const queue = world.frames ? world.frames() : [frame(band)];
  let capture = queue.length > 1 ? queue.shift()! : queue[0]!;
  let enters = 0, injections = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => band === "" ? { state: "ready" } : { state: "busy", text: band },
    injectText: () => { injections++; return true; },
    inputHasId: () => true,
    pressEnter: () => { enters++; capture = frame(""); return true; },
    settle: () => {},
    ...(world.noReaders ? {} : {
      captureEscaped: () => ({ ok: true, frame: queue.length > 1 ? queue.shift()! : queue[0]! }),
      submitFrame: (_t: string, command: string, expected: string, alive?: boolean) => classifySubmitFrame(capture, command, expected, "118", alive),
    }),
  } as PaneEffects;
  const registry = join(home, "registry.json");
  if (world.registry !== false) writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { status: "active", delivery: "pane", pane: "tap/peer:0.0", pane_id: "%1", session: "fixture",
      server_epoch: "srv:1:1", boot_id: "", harness: "claude" } } }));
  const bound = { paneId: "%1", handle: "peer", instance: "", serverEpoch: "srv:1:1", bootId: "", harness: "claude" };
  const authority: SubmitAuthority = {
    scriptsDir: scripts, agentFamilies: new Set(DEFAULT_AGENT_FAMILIES), busHome: home,
    recipient: "peer", registryPath: world.registry === false ? "" : registry, attemptIds: [ID],
    preserveDraft: false, draftGraceSatisfied: true, forceNoPrompt: false,
    idleStaged: true, singleEnter: true,
    eventContext: { actor: "courier", log: join(home, "registry-events.log"), team: "fixture", verb: "tap" },
    ...world.authority,
  };
  const result = submitVerifyLocked("tap/peer:0.0", ID, wire(ID), bound, fx, authority);
  return { result, enters, injections, home };
}

test("the idle arm presses exactly one Enter on a clean idle tray and mints the license", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home);
  expect(run.result.status).toBe("injected");
  expect(run.enters).toBe(1);
  expect(run.injections).toBe(0); // Enter only, no bytes
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(true);
  const rows = readFileSync(join(home, "receipts", `${ID}.submit-phases.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const phases = rows.filter(row => row.attempt === rows[rows.length - 1].attempt).map(row => row.phase);
  expect(phases).toContain("Enter-intent");
  expect(phases).toContain("Enter-sent");
});

test("a second observation after the one idle Enter never fires again", () => {
  const home = scratch();
  stageHold(home);
  const first = arm(home);
  expect(first.result.status).toBe("injected");
  const second = arm(home);
  expect(second.result.status).toBe("unverified");
  expect(second.enters).toBe(0);
  expect(second.injections).toBe(0);
});

test("a retry's idle arm mints its own license and never fires a second Enter", () => {
  const home = scratch(); stageRetryHold(home);
  const plain = join(home, "receipts", `${ID}.idle-submit`);
  writeFileSync(plain, "original idle license");
  const old = new Date("2026-10-13T09:59:59Z"); utimesSync(plain, old, old);
  const first = arm(home, { authority: { attemptUuid: RETRY } });
  expect(first.result.status).toBe("injected");
  expect(first.enters).toBe(1);
  expect(first.injections).toBe(0);
  expect(JSON.parse(readFileSync(join(home, "receipts", `${ID}.retry-${RETRY}.idle-submit`), "utf8"))).toMatchObject({ id: ID, retry: RETRY, effect: "possible" });
  expect(readFileSync(plain, "utf8")).toBe("original idle license");
  const second = arm(home, { authority: { attemptUuid: RETRY } });
  expect(second.enters).toBe(0);
  expect(second.injections).toBe(0);
});

test("an existing idle-submit license refuses before any key", () => {
  const home = scratch();
  stageHold(home);
  beginIdleSubmit(home, ID, { stagedId: ID, pane: "tap/peer:0.0", agentState: "idle" });
  const run = arm(home);
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("a cleared or submitted composer disposes quietly as staged_absent", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { band: "" });
  expect(run.result.status).toBe("unverified");
  expect((run.result as { cause?: string }).cause).toBe("staged_absent");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(false);
});

test("a concatenated sentinel pair is refused without keys", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { band: `${wire(ID)} ${wire(ID)}` });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("sentinel text followed by human bytes is refused without keys", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { band: `${wire(ID)} and a human draft tail` });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("a working pane is not idle: refused without keys", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [workingFrame(wire(ID)), workingFrame(wire(ID))] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(false);
});

test("a live Claude spinner is not idle: refused without keys or a license (tap-7txco)", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [spinnerFrame(wire(ID)), spinnerFrame(wire(ID))] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(false);
});

test("a modal above the composer is refused without keys", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [modalFrame(wire(ID)), modalFrame(wire(ID))] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("differing samples across the settle refuse without keys or a license", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [frame(wire(ID)), workingFrame(wire(ID))] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(false);
});

// ── R5: whole-composer equality, not containment ────────────────────────────
// Review of af007e96d: human bytes that land after the wire
// BETWEEN the samples still pass a containment check on Codex (its visibility
// test is `includes`), so the Enter would submit the wire plus the keystroke
// as one turn. Each sample now requires the composer to hold exactly the
// staged wire and nothing else.

const repoRoot = new URL("../../../", import.meta.url).pathname;
const codexStaged = readFileSync(repoRoot + "skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-staged-80.ansi", "utf8");
const codexEmpty = readFileSync(repoRoot + "skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-empty.ansi", "utf8");
const codexId = "sender-20260906T220111Z-21f26672936f";
const codexWire = `[[TAP v0.23 note ${codexId}]]`;

function codexArm(home: string, frames: string[], over: Partial<PaneEffects> = {}) {
  const queue = [...frames];
  let capture = queue[0]!;
  let enters = 0, injections = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => ({ state: "busy", text: codexWire }),
    injectText: () => { injections++; return true; },
    inputHasId: () => true,
    pressEnter: () => { enters++; capture = codexEmpty; return true; },
    settle: () => {},
    captureEscaped: () => { capture = queue.length > 1 ? queue.shift()! : queue[0]!; return { ok: true, frame: capture }; },
    submitFrame: (_t: string, command: string, expected: string, alive?: boolean) => classifySubmitFrame(capture, command, expected, "80", alive),
    // tap-8nmot: the idle arm refuses unless the title reads; the stub answers
    // the way a healthy codex title does (no braille spinner).
    paneTitle: () => ({ ok: true, title: "codex" }),
    ...over,
  } as PaneEffects;
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { status: "active", delivery: "pane", pane: "tap/peer:0.0", pane_id: "%1", session: "fixture",
      server_epoch: "srv:1:1", boot_id: "", harness: "codex" } } }));
  const bound = { paneId: "%1", handle: "peer", instance: "", serverEpoch: "srv:1:1", bootId: "", harness: "codex" };
  const authority: SubmitAuthority = {
    scriptsDir: scripts, agentFamilies: new Set(DEFAULT_AGENT_FAMILIES), busHome: home,
    recipient: "peer", registryPath: registry, attemptIds: [codexId],
    preserveDraft: false, draftGraceSatisfied: true, forceNoPrompt: false,
    idleStaged: true, singleEnter: true,
    eventContext: { actor: "courier", log: join(home, "registry-events.log"), team: "fixture", verb: "tap" },
  };
  const result = submitVerifyLocked("tap/peer:0.0", codexId, codexWire, bound, fx, authority);
  return { result, enters, injections };
}

test("R5 fix keeps a clean idle Codex composer submittable: one Enter, license minted", () => {
  // The canonical synthetic staged Codex frame must still pass whole-composer
  // equality, or the R5 fix would have emptied the arm on the M12 harness.
  const home = scratch();
  stageHold(home, codexId);
  const run = codexArm(home, [codexStaged, codexStaged]);
  expect(run.result.status).toBe("injected");
  expect(run.enters).toBe(1);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(true);
});

test("R5: human bytes landing after the wire between samples never ride the Codex Enter", () => {
  const home = scratch();
  stageHold(home, codexId);
  const dirty = codexStaged + "\n  human continuation";
  // Containment alone — what visibleSentinelId and sentinelSubmitDecision
  // check — still passes on the dirty frame; document the hole this test
  // proves composerHoldsExactly closes.
  expect(visibleSentinelId(dirty, "codex")).toBe(codexId);
  expect(sentinelSubmitDecision(dirty, "codex", codexWire).action).toBe("submit");
  const run = codexArm(home, [codexStaged, dirty]);
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(false);
});

// tap-8nmot ruling refusals: title, running-turn mode.

test("a pane title that cannot be read refuses the idle staged Enter", () => {
  const home = scratch();
  stageHold(home, codexId);
  const run = codexArm(home, [codexStaged, codexStaged], { paneTitle: () => ({ ok: false }) });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(false);
});

test("a spinner pane title over a clean composer reads working; no Enter", () => {
  const home = scratch();
  stageHold(home, codexId);
  const run = codexArm(home, [codexStaged, codexStaged], { paneTitle: () => ({ ok: true, title: "⠋ Working" }) });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(false);
});

test("a 'tab to queue message' footer reads a running turn; no Enter", () => {
  // The queue cue below the prompt is the mid-turn composer: Enter there
  // steers the running turn, it does not send the staged wire.
  const home = scratch();
  stageHold(home, codexId);
  const queued = codexStaged + "\n  tab to queue message\n";
  const run = codexArm(home, [queued, queued]);
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(false);
});

test("a queued-edit footer reads a running turn; no Enter", () => {
  // "shift + ← edit last queued message" exists only while a turn runs;
  // readFrame trims it as footer chrome, so the idle arm refuses it itself.
  const home = scratch();
  stageHold(home, codexId);
  // The cue sits between the prompt and the status footer, as Codex draws it.
  const rows = codexStaged.split("\n");
  const footer = rows.findIndex(row => row.includes("gpt-6-astra"));
  const queued = [...rows.slice(0, footer), "  shift + ← edit last queued message", ...rows.slice(footer)].join("\n");
  const run = codexArm(home, [queued, queued]);
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${codexId}.idle-submit`))).toBe(false);
});

test("R5 claude twin: a keystroke after the wire between samples refuses the Enter", () => {
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [frame(wire(ID)), frame(`${wire(ID)} ok`)] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(false);
});

test("a different well-formed wire gets the one Enter; ours is never injected (class, not identity)", () => {
  const home = scratch();
  stageHold(home);
  const other = "other-seat-20260928T130000Z-998877665544";
  writeFileSync(join(home, "payloads", `${other}.md`), `---\nid: ${other}\nfrom: sender\nto: peer\nkind: note\n---\nneutral body\n`);
  const run = arm(home, { band: wire(other), frames: () => [frame(wire(other)), frame(wire(other)), frame(wire(other))] });
  expect(run.result.status).toBe("unverified"); // honest: our wire never landed
  expect(run.enters).toBe(1); // the class gets its Enter
  expect(run.injections).toBe(0);
  const license = JSON.parse(readFileSync(join(home, "receipts", `${ID}.idle-submit`), "utf8"));
  expect(license.expected_id).toBe(ID);
  expect(license.staged_id).toBe(other);
  // The wire that received the Enter is licensed on its own name too: its own
  // staged-idle row can never fire a second Enter on the same observation.
  expect(existsSync(join(home, "receipts", `${other}.idle-submit`))).toBe(true);
  const otherRows = readFileSync(join(home, "receipts", `${other}.submit-phases.jsonl`), "utf8");
  expect(otherRows).toContain("Enter-sent");
});

test("our own cross-team qualified wire is our wire: injected with one Enter", () => {
  // Substitute review, thread 3: renderSentinel qualifies the id
  // (senderTeam/X) on cross-team sends, and cross-team spool redelivery
  // renders that form even when the team is OURS (sentinel.ts:76). The wire
  // re-keys through this bus's payload, so corroboration resolves it here:
  // the qualified form must take the credited path. The naive stuckFull !==
  // id reading routes it to the different-wire branch, whose double mint
  // burns the license with zero Enters — cross-team staged-idle would be dead.
  const home = scratch();
  stageHold(home);
  const root = dirname(dirname(home));
  const restore = pinTeamIndex(root, { fixtureteam: root });
  try {
    const qualified = `fixtureteam/${ID}`;
    const run = arm(home, { band: wire(qualified), frames: () => [frame(wire(qualified)), frame(wire(qualified)), frame(wire(qualified))] });
    expect(run.result.status).toBe("injected");
    expect(run.enters).toBe(1);
    expect(run.injections).toBe(0);
    const license = JSON.parse(readFileSync(join(home, "receipts", `${ID}.idle-submit`), "utf8"));
    expect(license.staged_id).toBe(qualified);
  } finally { restore(); }
});

test("a foreign team's wire sharing our basename gets its Enter on its own bus, never our credit", () => {
  // Thread: cross-team credit. The staged wire is otherteam/<our basename>
  // resolved through a GENUINELY different bus: the bus-qualified identity
  // differs, so the arm takes the different-wire path — the class gets its
  // one Enter under its own phases on its own bus, and this payload is never
  // injected or .sent. Both one-shot licenses are spent on the observation.
  const home = scratch();
  stageHold(home);
  const root = dirname(dirname(home));
  const foreignBus = join(root, "foreign-root", ".tap", "bus");
  mkdirSync(join(foreignBus, "payloads"), { recursive: true });
  writeFileSync(join(foreignBus, "payloads", `${ID}.md`), `---\nid: ${ID}\nfrom: sender\nto: peer\nkind: note\n---\nneutral body\n`);
  const restore = pinTeamIndex(root, { otherteam: join(root, "foreign-root") });
  try {
    const qualified = `otherteam/${ID}`;
    const run = arm(home, { band: wire(qualified), frames: () => [frame(wire(qualified)), frame(wire(qualified)), frame(wire(qualified))] });
    expect(run.result.status).toBe("unverified"); // honest: our wire never landed
    expect(run.enters).toBe(1); // the class gets its Enter
    expect(run.injections).toBe(0);
    expect(existsSync(join(home, "receipts", `${ID}.sent`))).toBe(false);
    expect(existsSync(join(foreignBus, "receipts", `${ID}.idle-submit`))).toBe(true);
    expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(true);
    const foreignRows = readFileSync(join(foreignBus, "receipts", `${ID}.submit-phases.jsonl`), "utf8");
    expect(foreignRows).toContain("Enter-sent");
  } finally { restore(); }
});

test("an already-licensed staged observation on its own bus refuses before any key", () => {
  const home = scratch();
  stageHold(home);
  const other = "other-seat-20260928T130000Z-998877665544";
  writeFileSync(join(home, "payloads", `${other}.md`), `---\nid: ${other}\nfrom: sender\nto: peer\nkind: note\n---\nneutral body\n`);
  beginIdleSubmit(home, other, { stagedId: other, pane: "tap/peer:0.0", agentState: "idle" });
  const run = arm(home, { band: wire(other), frames: () => [frame(wire(other)), frame(wire(other))] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("a composer that changes while the license is minted never receives the key", () => {
  // The mint takes reset custody and can block; the frame is re-read after it,
  // immediately before the key. Fourth capture differs (init consumes one,
  // two samples consume two): human input wins, the spent license refuses
  // forever.
  const home = scratch();
  stageHold(home);
  const run = arm(home, { frames: () => [frame(wire(ID)), frame(wire(ID)), frame(wire(ID)), frame(`${wire(ID)} ok`)] });
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${ID}.idle-submit`))).toBe(true); // spent, conservatively
});

test("a wire that provably addresses another recipient is an identity mismatch, no keys", () => {
  const home = scratch();
  stageHold(home, ID, "someone-else");
  const run = arm(home);
  expect(run.result.status).toBe("identity_mismatch");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
});

test("eligibility or missing frame readers refuse before any observation", () => {
  const missingEligibility = arm(scratch(), {}); // no meta, no phase rows
  expect(missingEligibility.result.status).toBe("unverified");
  expect(missingEligibility.enters).toBe(0);
  const home = scratch();
  stageHold(home);
  const missingReaders = arm(home, { noReaders: true });
  expect(missingReaders.result.status).toBe("unverified");
  expect(missingReaders.enters).toBe(0);
});

// ── The drain seams ─────────────────────────────────────────────────────────

function drainFixture(mode: "idle" | "absent" | "busy" = "idle") {
  const root = mkdtempSync(join(tmpdir(), "staged-idle-drain-")); roots.push(root);
  const home = join(root, ".tap", "bus");
  for (const path of [home, join(home, "spool"), join(home, "payloads"), join(home, "receipts"), join(home, "index")]) mkdirSync(path, { recursive: true });
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {} }));
  writeFileSync(join(home, ".tap-bus-authority"), "");
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_NOW: "1000" };
  installSpoolPane(home, registry, env, "claude").writeSeat({ boot_id: "" });
  const ctx: DrainContext = { home, scriptsDir: scripts, spoolDir: join(home, "spool"), payloadsDir: join(home, "payloads"),
    receiptsDir: join(home, "receipts"), eventLog: join(home, "registry-events.log"), actingRegistry: registry, team: "fixture", verbLabel: "tap",
    courierIdentity: "courier", alert: { mode: "none" }, now: 1000, unroutedGrace: 1800, env };
  const binding: SpoolBinding = { target: "peer", targetRegistry: registry, toTeam: "fixture", pane: "fixture:0.0", paneId: "%401" };
  const park = (id: string, over: Record<string, unknown> = {}) => {
    writeFileSync(join(home, "spool", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: note\n---\nneutral body\n`);
    writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "peer", pane: binding.pane, pane_id: binding.paneId,
      target_registry: registry, to_team: "fixture", policy: "standard", first_spooled_epoch: 1,
      deadline_epoch: 2800, reason: "staged-idle", reason_class: "busy", waiter_lifetime: "readiness-gate",
      deadline_source: "", harness: "claude", attempts: 0, ...over }));
    writeFileSync(join(home, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: note\n---\nneutral body\n`);
    landUnverifiedAttempt(home, id);
    beginDeliveryAttempt(home, id); // the real backstop: .attempted exists
  };
  const bandText = mode === "absent" ? "" : wire(ID);
  let capture = mode === "busy" ? workingFrame(bandText) : frame(bandText);
  let enters = 0, injections = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%401", session: "fixture", serverEpoch: "srv:123:456", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => bandText === "" ? { state: "ready" } : { state: "busy", text: bandText },
    injectText: () => { injections++; return true; },
    inputHasId: () => true,
    pressEnter: () => { enters++; capture = frame(""); return true; },
    settle: () => {},
    captureEscaped: () => ({ ok: true, frame: capture }),
    submitFrame: (_t, command, expected, alive) => classifySubmitFrame(capture, command, expected, "118", alive),
  } as PaneEffects;
  return { root, home, ctx, binding, park, fx, counts: () => ({ enters, injections }) };
}

test("drain rc 5 holds as staged-idle: body parked, window stamped, waiter keeps the lease", async () => {
  const f = drainFixture("busy");
  f.park(ID);
  const rc = await redeliver(f.ctx, ID, f.binding, {}, f.fx);
  expect(rc).toBe(0); // held is not unverified: no sender ping, no escalation
  expect(existsSync(join(f.home, "spool", `${ID}.md`))).toBe(true);
  const meta = JSON.parse(readFileSync(join(f.home, "spool", `${ID}.meta.json`), "utf8"));
  expect(meta.reason).toBe("staged-idle");
  expect(meta.deadline_epoch).toBe(2800); // the parked window, not re-armed
  expect(meta.waiter_lifetime).toBe("readiness-gate");
  expect(f.counts()).toEqual({ enters: 0, injections: 0 }); // pane working: no keys
  expect(existsSync(join(f.home, "receipts", `${ID}.idle-submit`))).toBe(false);
  // A running hold is not terminal: no unconfirmed notice or receipt (tap-67y3s).
  expect(existsSync(join(f.home, "payloads", `${ID}-delivery-unconfirmed.md`))).toBe(false);
  expect(existsSync(join(f.home, "receipts", `${ID}.unconfirmed`))).toBe(false);
});

test("a staged-idle decision refused by a busy metadata lock stays unstamped for recovery", async () => {
  const f = drainFixture("busy");
  f.park(ID);
  // Take the metadata lock after the pre-submit move, so only the post-submit hold decision sees it busy.
  const observe = f.fx.observePane;
  const held: { lock: ReturnType<typeof acquirePathLock> } = { lock: null };
  f.fx.observePane = target => {
    held.lock ??= acquirePathLock(join(f.home, "spool", `${ID}.meta.json.lock`), 1000, f.ctx.env);
    return observe(target);
  };
  try {
    expect(await redeliver(f.ctx, ID, f.binding, {}, f.fx)).toBe(5);
  } finally { held.lock?.release(); }
  expect(held.lock).not.toBeNull();
  // Unfinished hold custody: canonical body under the repark mark, metadata kept, no terminal stamp.
  expect(existsSync(join(f.home, "payloads", `${ID}.md`))).toBe(true);
  expect(existsSync(join(f.home, "spool", `${ID}.meta.json`))).toBe(true);
  expect(existsSync(join(f.home, "payloads", `${ID}-delivery-unconfirmed.md`))).toBe(false);
  expect(existsSync(join(f.home, "receipts", `${ID}.unconfirmed`))).toBe(false);
  expect(f.counts()).toEqual({ enters: 0, injections: 0 });
});

test("drain staged_absent disposes quietly: canonical kept, no license, rc 5", async () => {
  const f = drainFixture("absent");
  f.park(ID);
  const rc = await redeliver(f.ctx, ID, f.binding, {}, f.fx);
  expect(rc).toBe(5);
  expect(existsSync(join(f.home, "spool", `${ID}.md`))).toBe(false);
  expect(existsSync(join(f.home, "payloads", `${ID}.md`))).toBe(true);
  expect(existsSync(join(f.home, "receipts", `${ID}.idle-submit`))).toBe(false);
  expect(f.counts()).toEqual({ enters: 0, injections: 0 });
});

test("drain happy path: the idle Enter verifies, .sent lands, the entry retires", async () => {
  const f = drainFixture("idle");
  f.park(ID);
  const rc = await redeliver(f.ctx, ID, f.binding, {}, f.fx);
  expect(rc).toBe(0);
  expect(f.counts()).toEqual({ enters: 1, injections: 0 });
  expect(existsSync(join(f.home, "receipts", `${ID}.idle-submit`))).toBe(true);
  expect(existsSync(join(f.home, "receipts", `${ID}.sent`))).toBe(true);
  expect(existsSync(join(f.home, "spool", `${ID}.md`))).toBe(false);
  expect(existsSync(join(f.home, "payloads", `${ID}.md`))).toBe(true);
});

test("an expired staged-idle window disposes to the manual path, never re-arms", async () => {
  const f = drainFixture("busy");
  f.park(ID, { deadline_epoch: 999 }); // window elapsed at TAP_SPOOL_NOW 1000
  const rc = await redeliver(f.ctx, ID, f.binding, {}, f.fx);
  expect(rc).toBe(5); // the ordinary unverified notice path
  expect(existsSync(join(f.home, "spool", `${ID}.md`))).toBe(false);
  expect(existsSync(join(f.home, "payloads", `${ID}.md`))).toBe(true);
  expect(f.counts()).toEqual({ enters: 0, injections: 0 });
  // A disposed (expired) hold is terminal: the deterministic notice and its receipt (tap-67y3s).
  expect(existsSync(join(f.home, "payloads", `${ID}-delivery-unconfirmed.md`))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.home, "receipts", `${ID}.unconfirmed`), "utf8")).reason).toBe("redelivery_submit_unverified");
});

test("R1: every drain entry that can pick the row up types no bytes on an empty composer", async () => {
  // solo, forced
  for (const force of [false, true]) {
    const f = drainFixture("absent");
    f.park(ID);
    const rc = await redeliver(f.ctx, ID, f.binding, { force }, f.fx);
    expect(rc).toBe(5);
    expect(f.counts()).toEqual({ enters: 0, injections: 0 });
    expect(existsSync(join(f.home, "receipts", `${ID}.attempted`))).toBe(true); // the backstop holds
  }
  // digest: a staged-idle row never joins the digest, its peers do
  const f = drainFixture("absent");
  f.park(ID);
  f.park("mate-seat-20260928T120000Z-1a2b3c4d5e6f", { reason: "pending-input" });
  f.park("twin-seat-20260928T120000Z-2b3c4d5e6f7a", { reason: "pending-input" });
  const digestIds: string[][] = [];
  const soloIds: string[] = [];
  const effects: DrainEffects = {
    readiness: async () => "ready",
    harness: async () => "claude", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async (id, b, force) => { soloIds.push(id); return redeliver(f.ctx, id, b, { locked: true, force }, f.fx); },
    digest: async (_b, ids) => {
      digestIds.push(ids);
      // The stub owns its disposition: a delivered digest retires its members.
      for (const id of ids) {
        renameSync(join(f.home, "spool", `${id}.md`), join(f.home, "payloads", `${id}.md`));
        rmSync(join(f.home, "spool", `${id}.meta.json`));
      }
      return 0;
    },
  };
  const rc = await drainOnce(f.ctx, effects, { cap: "8", target: "" });
  expect(rc).toBe(5); // the staged-idle solo ended unverified (staged_absent)
  expect(soloIds).toContain(ID);
  expect(digestIds.flat()).not.toContain(ID);
  expect(digestIds.flat()).toContain("mate-seat-20260928T120000Z-1a2b3c4d5e6f");
  expect(f.counts()).toEqual({ enters: 0, injections: 0 });
  // stranded repark recovery, three shapes (TAP_SPOOL_NOW pins 1000):
  // 1. a crashed staged-idle hold within its window re-adopts the body — the
  //    Enter-only license makes .attempted re-adoption safe (a held entry can
  //    never re-enter injection);
  // 2. the same hold PAST its window never moves back — the manual path and
  //    the unconfirmed sweep own it;
  // 3. an ordinary (non-staged-idle) entry with attempt evidence never moves
  //    back: the no-retry custody, unchanged.
  const { markReparkPending } = await import("../src/spool-repark");
  for (const [label, over, parked] of [
    ["within window", {}, true],
    ["past window", { deadline_epoch: 999 }, false],
    ["ordinary reason", { reason: "pending-input" }, false],
  ] as const) {
    const g = drainFixture("absent");
    g.park(ID, over);
    rmSync(join(g.home, "spool", `${ID}.md`)); // body stranded canonical under the write-ahead mark
    markReparkPending(join(g.home, "spool"), ID, g.ctx.env);
    recoverStrandedReparks(join(g.home, "spool"), join(g.home, "payloads"), g.ctx.env);
    expect(existsSync(join(g.home, "spool", `${ID}.md`))).toBe(parked); // re-adopted only within the window
    expect(existsSync(join(g.home, "payloads", `${ID}.md`))).toBe(!parked); // the move is the re-adoption; a refused one keeps the body canonical for the sweep
    // Nothing downstream can type bytes on this seam either.
    const rc2 = await redeliver(g.ctx, ID, g.binding, {}, g.fx);
    expect(rc2 === 5 || rc2 === 1).toBe(true);
    expect(g.counts()).toEqual({ enters: 0, injections: 0 });
    void label;
  }
});
