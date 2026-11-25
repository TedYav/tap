// spool-readiness.ts: the drain's readiness verdict, the display mapping over it, and
// the band composition readiness owns (A3a). Every arm names the incumbent branch it
// pins; the order of the early returns IS the contract, so each refusal is reached with
// the later inputs set to values that would answer differently if the order slipped.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BandFacts, type ReadinessDeps, type ReadinessFacts,
  type ReadinessObservations, type ReadinessPrefix, type ReadinessStep,
  agyInTurnFromFrame, displayRow, displayState, observedBand,
  paneFieldReady, paneHarnessAt, paneReady, readinessWalk,
} from "../src/spool-readiness";
import type { Run } from "../src/tmux";
import { composerInput } from "../src/submit-frame";
import { dimPromptInput, promptGlyph, textHasPasteCollapse } from "../src/pane/geometry";
import { escapedPromptFromFrame, frameIo, pendingInputText } from "../src/pane/reader";
import { deliveryDisposition } from "../src/slices/delivery-disposition";
import collapsed from "./fixtures/claude-compact-collapsed.json";

const deps = (over: Partial<ReadinessDeps> = {}): ReadinessDeps => ({
  registryMatchesTeam: () => true,
  recoveryAllowed: () => true,
  clearFenceState: () => "absent",
  blockedOrExempt: () => false,
  env: { TAP_AGENT_FAMILIES: undefined } as NodeJS.ProcessEnv,
  ...over,
});

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  pane: "sess:0.0", paneId: "%401", handle: "peer", toTeam: "fixture",
  targetRegistry: "/bus/registry.json", policy: "", identity: "match",
  harnessCmd: "claude", paneInMode: "0", blockedMap: "{}", blockedExempt: "[]",
  frame: "", pending: { kind: "empty" }, band: null, ...over,
});

test("a collapsed human draft stays unreadable and never enters pending-input grace", () => {
  const frame = collapsed.frames[2]!;
  const band = observedBand({ frame, harness: "claude", paneWidth: "58" });
  expect(band).toBe("unobservable");
  expect(deliveryDisposition({ band, harness: "claude", urgent: false, noSpool: false, recipientBound: true }))
    .toMatchObject({ action: "park", parkReason: "no-input-prompt", graceSeconds: null });
  const pending = pendingInputText(frameIo(frame, "58"), "%401", "claude");
  expect(pending).toEqual({ status: "no-band" });
  const kind = pending.status === "text" ? { kind: "text" as const, text: pending.text } : { kind: "no-band" as const };
  expect(paneReady(facts({ frame, pending: kind }), deps())).toBe("busy:noprompt");
});

test("the gone family: a blank binding, a foreign team, and a drifted identity all answer gone", () => {
  expect(paneReady(facts({ pane: "" }), deps())).toBe("gone");
  expect(paneReady(facts({ paneId: "" }), deps())).toBe("gone");
  expect(paneReady(facts({ targetRegistry: "" }), deps())).toBe("gone");
  expect(paneReady(facts(), deps({ registryMatchesTeam: () => false }))).toBe("gone");
  // Every identity refusal reason the incumbent could print is a gone, not a hold.
  for (const reason of ["pane_drift", "pane_id_drift", "handle_missing_or_inactive", "registry_missing", "not_pane_delivery", "seat_exited"]) {
    expect(paneReady(facts({ identity: reason }), deps())).toBe("gone");
  }
});

test("an old-format target registry holds (busy:decision-unavailable), never gone: the drain skips it and the deadline keeps it present", () => {
  expect(paneReady(facts({ identity: "old_store" }), deps())).toBe("busy:decision-unavailable");
  // It wins over the later arms that would answer differently.
  expect(paneReady(facts({ identity: "old_store", harnessCmd: "bash" }),
    deps({ recoveryAllowed: () => false, clearFenceState: () => "live" }))).toBe("busy:decision-unavailable");
});

test("an unobservable identity holds (busy:decision-unavailable), never gone: the instrument failing to look is not the seat being gone", () => {
  // guard_deadline and server_unresponsive by name; the bound arm's <thing>_unobservable
  // family (session_unobservable, harness_unobservable, boot_id_unobservable) by suffix.
  for (const reason of ["guard_deadline", "server_unresponsive", "session_unobservable", "harness_unobservable", "boot_id_unobservable"]) {
    expect(paneReady(facts({ identity: reason }), deps())).toBe("busy:decision-unavailable");
  }
  // It wins over the later arms that would answer differently, like old_store.
  expect(paneReady(facts({ identity: "session_unobservable", harnessCmd: "bash" }),
    deps({ recoveryAllowed: () => false, clearFenceState: () => "live" }))).toBe("busy:decision-unavailable");
});

// tap-vctb8, bounded by tap-cl1es: the detector's overprint verdict holds as
// busy:overprint at the walk; the bounded-healing disposition (drain side)
// maps a due episode to an attempt and consults the pane's record.
test("a detected overprint holds busy:overprint at the walk (tap-vctb8, tap-cl1es)", () => {
  expect(paneReady(facts({ pending: { kind: "overprint-hold" } }), deps())).toBe("busy:overprint");
});

test("a rate-limited field read is an unavailable observation, never an answer; a genuine tmux refusal stays a positive absence", () => {
  const limited = (): Run => ({ code: 1, stdout: "", stderr: "tmux client rate limited", rateLimited: true });
  expect(() => paneFieldReady("sess:0.0", "pane_in_mode", process.env, limited)).toThrow(/rate limited/);
  // The harness read inherits the rule by composing its field reader with the same runner.
  const strict = (pane: string, field: string, env: NodeJS.ProcessEnv): string => paneFieldReady(pane, field, env, limited);
  expect(() => paneHarnessAt("sess:0.0", process.env, strict)).toThrow(/rate limited/);
  // The door's empty-string ambiguity is not resolved here: a REAL rc != 0
  // ("can't find pane") keeps the incumbent's reading, which the walk may call gone.
  expect(paneFieldReady("sess:0.0", "pane_in_mode", process.env,
    () => ({ code: 1, stdout: "", stderr: "can't find pane $sess:0.0" }))).toBe("");
});

test("order: identity is asked before recovery, recovery before the fence, the fence before the harness", () => {
  // A drifted identity wins over a held pane, a live fence and an unsafe harness.
  expect(paneReady(facts({ identity: "pane_drift", harnessCmd: "bash" }),
    deps({ recoveryAllowed: () => false, clearFenceState: () => "live" }))).toBe("gone");
  // A recovery hold wins over the fence and the harness.
  expect(paneReady(facts({ harnessCmd: "bash" }),
    deps({ recoveryAllowed: () => false, clearFenceState: () => "live" }))).toBe("busy:recovery");
  // The fence wins over the harness classification.
  expect(paneReady(facts({ harnessCmd: "bash" }), deps({ clearFenceState: () => "live" }))).toBe("busy:clearing");
  // Only `live` parks; expired and absent fall through (fail-open) to the harness.
  for (const state of ["absent", "expired", ""]) {
    expect(paneReady(facts({ harnessCmd: "bash" }), deps({ clearFenceState: () => state }))).toBe("unsafe");
  }
});

// THE LAZINESS CONTRACT, which is what the `need` protocol exists for. The incumbent read
// the world one fact at a time and returned before most of them: an empty binding answered
// `gone` with no identity probe, a held pane with no `#{pane_current_command}`, an unsafe
// harness with no `#{pane_in_mode}`, and a team-qualified entry never opened the watch arm.
// A walk that asked for a fact it does not need would put tmux traffic and two watch-lease
// reads on panes the incumbent never touched, so each refusal below is driven with NOTHING
// observed and asserted to answer rather than ask.
const prefix = (over: Partial<ReadinessPrefix> = {}): ReadinessPrefix => ({
  pane: "sess:0.0", paneId: "%401", handle: "peer", toTeam: "fixture",
  targetRegistry: "/bus/registry.json", policy: "", ...over,
});
const asks = (step: ReadinessStep): string => (step.done ? `verdict:${step.verdict}` : `need:${step.need}`);
const walk = (p: Partial<ReadinessPrefix>, seen: ReadinessObservations, over: Partial<ReadinessDeps> = {}): string =>
  asks(readinessWalk(prefix(p), seen, deps(over)));

test("the walk asks for an observation only on the branch that reads it", () => {
  // Nothing observed: the three refusals above identity answer without asking.
  expect(walk({ pane: "" }, {})).toBe("verdict:gone");
  expect(walk({}, {}, { registryMatchesTeam: () => false })).toBe("verdict:gone");
  expect(walk({}, {})).toBe("need:identity");
  // Recovery and the fence are decided from the registry alone — still no harness probe.
  expect(walk({}, { identity: "match" }, { recoveryAllowed: () => false })).toBe("verdict:busy:recovery");
  expect(walk({}, { identity: "match" }, { clearFenceState: () => "live" })).toBe("verdict:busy:clearing");
  expect(walk({}, { identity: "match" })).toBe("need:harness");
  // An unsafe harness is decided without ever reading the pane mode.
  expect(walk({}, { identity: "match", harnessCmd: "bash" })).toBe("verdict:unsafe");
  expect(walk({}, { identity: "match", harnessCmd: "claude" })).toBe("need:pane-mode");
  // A mode that is absent or non-zero is decided without the watch arm or the reader.
  expect(walk({}, { identity: "match", harnessCmd: "claude", paneInMode: "" })).toBe("verdict:gone");
  expect(walk({}, { identity: "match", harnessCmd: "claude", paneInMode: "1" })).toBe("verdict:busy");
  // The watch arm belongs to the unqualified target alone: a team-qualified entry skips
  // straight to the reader, and a blank handle does too.
  const live = { identity: "match", harnessCmd: "claude", paneInMode: "0" };
  expect(walk({ toTeam: "fixture" }, live)).toBe("need:pending");
  expect(walk({ toTeam: "", handle: "" }, live)).toBe("need:pending");
  expect(walk({ toTeam: "" }, live)).toBe("need:blocked-fields");
  expect(walk({ toTeam: "" }, { ...live, blocked: { map: "{}", exempt: "[]" } })).toBe("need:pending");
  expect(walk({ toTeam: "" }, { ...live, blocked: { map: "{}", exempt: "[]" } },
    { blockedOrExempt: () => true })).toBe("verdict:busy");
  // The three capture-taking branches each name their own observation, and only one.
  expect(walk({ policy: "polite" }, { ...live, harnessCmd: "agy" })).toBe("need:in-turn-frame");
  expect(walk({ policy: "polite" }, { ...live, harnessCmd: "agy", inTurnFrame: "? for shortcuts\n" }))
    .toBe("need:survey-frame");
  expect(walk({}, { ...live, harnessCmd: "codex" })).toBe("need:band");
  // A disposition that refused to decide is `null`, and never falls into the default
  // `busy:noprompt` arm beside the band words it does not recognize.
  expect(walk({}, { ...live, harnessCmd: "codex", band: null })).toBe("verdict:busy:decision-unavailable");
});

// THE PREFIX PREDICATES ARE TAKEN ONCE PER CONVERSATION, not once per round. The laziness arm
// above drives ISOLATED walks, so it cannot see a repeat that only exists across a complete
// conversation — which is exactly how the defect got in (sol-ponytail-1, review P2). These arms
// drive the whole protocol the way the adapter does, carrying `seen` between rounds.
function converse(over: Partial<ReadinessPrefix>, deps: ReadinessDeps, mutate?: (seen: ReadinessObservations) => void): { verdict: string; rounds: number } {
  const seen: ReadinessObservations = {};
  const supply: Record<string, () => void> = {
    identity: () => { seen.identity = "match"; },
    harness: () => { seen.harnessCmd = "claude"; },
    "pane-mode": () => { seen.paneInMode = "0"; },
    "blocked-fields": () => { seen.blocked = { map: "{}", exempt: "[]" }; },
    "in-turn-frame": () => { seen.inTurnFrame = ""; },
    "survey-frame": () => { seen.surveyFrame = ""; },
    band: () => { seen.band = "bare"; },
    pending: () => { seen.pending = { kind: "empty" }; },
  };
  for (let round = 1; round <= 12; round++) {
    const step = readinessWalk(prefix(over), seen, deps);
    if (step.done) return { verdict: step.verdict, rounds: round };
    mutate?.(seen);
    supply[step.need]?.();
  }
  return { verdict: "did-not-converge", rounds: 12 };
}

test("a complete conversation evaluates each prefix predicate exactly once", () => {
  const calls = { registry: 0, recovery: 0, fence: 0 };
  const counting = deps({
    registryMatchesTeam: () => { calls.registry += 1; return true; },
    recoveryAllowed: () => { calls.recovery += 1; return true; },
    clearFenceState: () => { calls.fence += 1; return "absent"; },
  });
  // An unqualified target takes the longest path: identity, harness, pane-mode, the watch
  // arm, then the reader — five round trips, and the incumbent read each of these three once.
  const run = converse({ toTeam: "" }, counting);
  expect(run.verdict).toBe("ready");
  expect(run.rounds).toBeGreaterThan(3);
  expect(calls).toEqual({ registry: 1, recovery: 1, fence: 1 });
});

test("a hold appearing mid-conversation does not overturn a prefix check that already passed", () => {
  // THE REASON THE COUNT MATTERS. The incumbent asked the fence once, so a marker written
  // after that moment could not change its answer. A walk that re-asked every round would
  // turn an already-cleared pane into `busy:clearing` partway through — a decision the
  // incumbent could not reach, from a snapshot it never saw.
  // The marker is written the INSTANT the fence check has passed, not on a round number —
  // an earlier draft flipped it at round 1, before the fence had been evaluated at all, and
  // reddened on a walk that was behaving correctly.
  let fence = "absent";
  const run = converse({ toTeam: "" }, deps({ clearFenceState: () => fence }),
    (seen) => { if (seen.cleared?.fence) fence = "live"; });
  expect(run.verdict).toBe("ready");
  // The same marker present from the START is a hold, so the arm is not vacuous.
  expect(converse({ toTeam: "" }, deps({ clearFenceState: () => "live" })).verdict).toBe("busy:clearing");
});

// THE DOOR'S OWN REFUSALS, driven through the CLI rather than the exported function, because
// that is the surface the adapter actually talks to and a guard with no test at its own door
// is a guard nobody has run (gate review).
test("the door refuses a --pending word it does not know, and the refusal is a hold", () => {
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/spool-readiness.ts"), ...args],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, TAP_AGENT_FAMILIES: "" } });
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
  };
  const base = ["readiness", "s:0.0", "%1", "peer", "t", "/no/such/registry.json", ""];
  const bad = run([...base, "--pending", "typo"]);
  // rc 2 is what makes this a hold: `tap_bun_call` fails and the adapter prints
  // busy:decision-unavailable. Reading it as an empty band would have answered `ready`,
  // which admits a submit attempt into a pane nobody could read.
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("unknown --pending word");
  // The four words it DOES know are accepted, so the refusal is about the vocabulary and not
  // about the flag being present at all.
  for (const word of ["text", "empty", "no-band", "modal"]) {
    expect(`${word}: ${run([...base, "--pending", word]).code}`).toBe(`${word}: 0`);
  }
});

test("the cleared record survives the round trip THROUGH THE CLI, not just in memory", () => {
  // A review finding named a mechanism the adapter does not use (it claimed
  // `--cleared` accumulates in the argv array so `indexOf` always matches round 1's value;
  // lib.sh:2280 expands `${cleared:+--cleared "$cleared"}` fresh each round instead). The
  // mechanism was wrong, but the GAP it pointed at was real: `converse()` above hands the
  // walk one shared JS object, so it proves the walk honours `cleared` and proves nothing
  // about the flag surviving serialisation to argv and back. This arm covers that.
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "cleared-door-"));
  try {
    mkdirSync(join(root, "index"));
    writeFileSync(join(root, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    const registry = join(root, "registry.json");
    // The discriminator: a registry naming ANOTHER team. The registry-team check is the first
    // prefix predicate, so whether it was skipped is visible in one call.
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "elsewhere" }, seats: {} }));
    const call = (extra: string[]) => {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/spool-readiness.ts"),
        "readiness", "s:0.0", "%1", "peer", "t", registry, "", ...extra],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, TAP_HOME: join(root, "bus"), TAP_INDEX_HOME: join(root, "index") } });
      return r.stdout.toString().trim().split("\n");
    };
    // Unskipped, the mismatched team is `gone` — so the check demonstrably CAN fire.
    expect(call([])).toEqual(["verdict", "gone"]);
    // Told it already passed, the walk does not re-ask and moves to the first observation.
    expect(call(["--cleared", "registry"])).toEqual(["need", "identity", "registry"]);
    // And the record the door emits is the one the adapter feeds back: evaluating the rest
    // adds them, so a later round carries all three rather than round 1's single entry.
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
    expect(call(["--identity", "match", "--cleared", "registry"])[2]).toBe("registry,recovery,fence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the longest need path is seven, which the native driver's nine-round ceiling still clears", () => {
  // The ceiling lives in spool-readiness.ts (`round < 9`), and a path that exceeds
  // it does not fail loudly — it falls out as `busy:decision-unavailable`, a hold that looks
  // like a decision. So the longest path is COUNTED here rather than asserted in a comment:
  // agy + polite + an unqualified target takes all seven pane-side observations, needing
  // eight rounds against a ceiling of nine. Adding an observation kind without raising the
  // ceiling is what this arm exists to catch. (a reviewer corrected my "no more than
  // six" at the gate; the count is theirs, the arm is the fix.)
  const seen: ReadinessObservations = {};
  const supply: Record<string, () => void> = {
    identity: () => { seen.identity = "match"; },
    harness: () => { seen.harnessCmd = "agy"; },
    "pane-mode": () => { seen.paneInMode = "0"; },
    "blocked-fields": () => { seen.blocked = { map: "{}", exempt: "[]" }; },
    "in-turn-frame": () => { seen.inTurnFrame = "? for shortcuts\n"; },
    "survey-frame": () => { seen.surveyFrame = "nothing surveyish\n"; },
    band: () => { seen.band = "bare"; },
    pending: () => { seen.pending = { kind: "empty" }; },
  };
  const needs: string[] = [];
  let rounds = 0, verdict = "";
  for (let round = 1; round <= 20; round++) {
    rounds = round;
    const step = readinessWalk(prefix({ toTeam: "", policy: "polite" }), seen, deps());
    if (step.done) { verdict = step.verdict; break; }
    needs.push(step.need); supply[step.need]?.();
  }
  expect(verdict).toBe("ready");
  expect(needs).toEqual(["identity", "harness", "pane-mode", "blocked-fields", "in-turn-frame", "survey-frame", "pending"]);
  expect(`${rounds} rounds within the native ceiling of 9: ${rounds <= 9}`).toBe(`${rounds} rounds within the native ceiling of 9: true`);
});

test("the sidecar coercions are Python's, including the values a hand-rolled pair narrowed", () => {
  // `int(True or 0)` is 1 in Python, so a sidecar carrying a boolean clock is READABLE — the
  // first version called it unreadable and turned a row the incumbent could read into
  // `unknown` (two reviewers).
  expect(displayRow({ pane: "p", pane_id: "%1", target: "t", target_registry: "r", hold_until_epoch: true }, 0)?.waiting).toBe(true);
  // Python's int() takes Unicode decimal digits and underscore groups between digits.
  expect(displayRow({ pane: "p", pane_id: "%1", target: "t", target_registry: "r", hold_until_epoch: "١٢٣٤٥٦٧٨٩٠" }, 0)).not.toBeNull();
  expect(displayRow({ pane: "p", pane_id: "%1", target: "t", target_registry: "r", hold_until_epoch: "1_000" }, 0)?.waiting).toBe(true);
  // And `str()` spells a boolean Python's way, not JavaScript's.
  expect(displayRow({ pane: true, pane_id: "%1", target: "t", target_registry: "r" }, 0)?.pane).toBe("True");
  // The control: a genuinely non-integer clock still raises, which is an unreadable row.
  expect(displayRow({ pane: "p", pane_id: "%1", target: "t", target_registry: "r", hold_until_epoch: "soon" }, 0)).toBeNull();
});

test("the harness gate: a denylist or unsupported command is unsafe, and an agent family proceeds", () => {
  for (const cmd of ["bash", "zsh", "vim", "less", "ssh", "git"]) {
    expect(paneReady(facts({ harnessCmd: cmd }), deps())).toBe("unsafe");
  }
  expect(paneReady(facts({ harnessCmd: "node" }), deps())).toBe("unsafe");
  for (const cmd of ["claude", "codex", "opencode", "cursor", "hermes", "agy"]) {
    expect(paneReady(facts({ harnessCmd: cmd, band: "bare", pending: { kind: "empty" } }), deps())).not.toBe("unsafe");
  }
});

test("the pane mode: tmux answering nothing is gone, any non-zero mode is busy", () => {
  expect(paneReady(facts({ paneInMode: "" }), deps())).toBe("gone");
  expect(paneReady(facts({ paneInMode: "1" }), deps())).toBe("busy");
  expect(paneReady(facts({ paneInMode: "0" }), deps())).toBe("ready");
});

test("the watch arm's block applies only to an unqualified target with a handle", () => {
  const blocked = deps({ blockedOrExempt: () => true });
  expect(paneReady(facts({ toTeam: "", handle: "peer" }), blocked)).toBe("busy");
  // A team-qualified entry is not subject to the local arm; a handleless one has nothing to look up.
  expect(paneReady(facts({ toTeam: "fixture", handle: "peer" }), blocked)).toBe("ready");
  expect(paneReady(facts({ toTeam: "", handle: "" }), blocked)).toBe("ready");
});

test("polite focus gating is agy's alone, and only under the polite policy", () => {
  // The walk reads the in-turn fact off the frame itself (`tap_agy_seat_in_turn`'s awk).
  const TURN = "thinking…\nesc to cancel\n";
  expect(paneReady(facts({ policy: "polite", harnessCmd: "agy", frame: TURN }), deps())).toBe("busy:in-turn");
  // Not polite: the same seat mid-turn is not held (an ordinary send is meant to land mid-turn).
  for (const policy of ["", "standard", "urgent"]) {
    expect(paneReady(facts({ policy, harnessCmd: "agy", frame: TURN }), deps())).not.toBe("busy:in-turn");
  }
  // Another harness mid-turn is never in-turn, polite or not (OpenCode's composer is ready during a turn).
  for (const cmd of ["opencode", "claude", "cursor", "hermes"]) {
    expect(paneReady(facts({ policy: "polite", harnessCmd: cmd, frame: TURN }), deps())).not.toBe("busy:in-turn");
  }
  // Polite gating needs both the registry and the handle the incumbent required.
  expect(paneReady(facts({ policy: "polite", harnessCmd: "agy", handle: "", frame: TURN }), deps())).not.toBe("busy:in-turn");
});

test("codex reads its band, and a band the disposition could not decide is never read as a state", () => {
  const codex = (band: ReadinessFacts["band"]) => paneReady(facts({ harnessCmd: "codex", band }), deps());
  expect(codex("queued")).toBe("busy:queued");
  expect(codex("draft")).toBe("busy:pending");
  expect(codex("staged")).toBe("busy:pending");
  expect(codex("bare")).toBe("ready");
  expect(codex("unobservable")).toBe("busy:noprompt");
  expect(codex("busy")).toBe("busy:noprompt");
  expect(codex(null)).toBe("busy:decision-unavailable");
  // The codex branch returns before the reader is consulted: a draft in `pending` cannot
  // override a bare band, which is what made the queue distinction worth its own arm.
  expect(paneReady(facts({ harnessCmd: "codex", band: "bare", pending: { kind: "text", text: "typed" } }), deps())).toBe("ready");
  // A codex-suffixed command takes the same branch (the incumbent matched `codex*`).
  expect(paneReady(facts({ harnessCmd: "codex-cli", band: "queued" }), deps())).toBe("busy:queued");
});

test("the agy survey branch decides without the reader, and only for `agy` exactly", () => {
  // The frame the SHIPPED predicate recognizes (submit-frame.ts agySurveyOverlay: three
  // exact rows). My first version of this arm invented a survey the predicate does not
  // match, so it fell through to the reader and asserted nothing — B1's own composer arm
  // records the same trap, and a bot review round caught its twin.
  const SURVEY = [
    "some transcript",
    "How's the CLI experience so far? Help us improve:",
    "[1] Good   [2] Fine   [3] Bad   [0] Skip",
    "esc to cancel   Gemini 3.8-pro \u00b7 42% context left",
  ].join("\n");
  const { agySurveyOverlay } = require("../src/submit-frame") as typeof import("../src/submit-frame");
  expect(agySurveyOverlay(SURVEY)).toBe(true);
  // A recognized survey is decided by the admission — ready when it can be cleared,
  // busy:recovery when it cannot — and NEVER by the reader below, which would have
  // answered busy:noprompt for this frame.
  const verdict = paneReady(facts({ harnessCmd: "agy", frame: SURVEY, pending: { kind: "no-band" } }), deps());
  expect(["ready", "busy:recovery"]).toContain(verdict);
  // A frame with no survey falls through to the reader, which is what makes the above a branch.
  expect(paneReady(facts({ harnessCmd: "agy", frame: "", pending: { kind: "no-band" } }), deps())).toBe("busy:noprompt");
  // Equality, not prefix: `agy-x` never takes the survey branch (the incumbent used `[ "$cmd" = agy ]`).
  expect(paneReady(facts({ harnessCmd: "agy-x", frame: SURVEY, pending: { kind: "text", text: "d" } }), deps())).toBe("busy:pending");
});

test("the reader's four answers map to the incumbent's four classes, and booting is OpenCode's alone", () => {
  expect(paneReady(facts({ pending: { kind: "modal" } }), deps())).toBe("busy:modal");
  expect(paneReady(facts({ pending: { kind: "text", text: "half-typed" } }), deps())).toBe("busy:pending");
  // rc 0 with no bytes is a bare band, not a hold.
  expect(paneReady(facts({ pending: { kind: "text", text: "" } }), deps())).toBe("ready");
  expect(paneReady(facts({ pending: { kind: "empty" } }), deps())).toBe("ready");
  expect(paneReady(facts({ pending: { kind: "no-band" } }), deps())).toBe("busy:noprompt");
  expect(paneReady(facts({ harnessCmd: "opencode", pending: { kind: "no-band" } }), deps())).toBe("busy:booting");
  // A modal is a modal on every harness: it is the one hold ruling 15 leaves standing.
  for (const cmd of ["claude", "opencode", "cursor", "hermes", "agy"]) {
    expect(paneReady(facts({ harnessCmd: cmd, pending: { kind: "modal" } }), deps())).toBe("busy:modal");
  }
});

// --- the band composition ----------------------------------------------------------

const band = (over: Partial<BandFacts> = {}): BandFacts => ({ frame: "", harness: "claude", paneWidth: "80", ...over });

test("a capture the caller could not take is never an idle band", () => {
  // Trap 2: `frame: null` is the incumbent's `present=0`, which is `unobservable` —
  // NOT `bare`, which would make an unreadable pane inject-eligible.
  expect(observedBand(band({ frame: null }))).toBe("unobservable");
  expect(observedBand(band({ frame: null, harness: "codex" }))).toBe("unobservable");
});

test("the chip rule is the incumbent's rc 1: a definite NO CHIP blanks a dim placeholder", () => {
  // THE POLARITY, PINNED BY BEHAVIOUR OVER REAL CAPTURES. Two fixtures actually reach this
  // branch and change answer with it, so the rule is asserted by what `observedBand` returns
  // rather than by restating the condition. A reviewer found these at the gate
  // after I had claimed no fixture in the repo discriminated the two — it does, and a
  // source-string pin was the weaker control I had settled for.
  //
  // The incumbent (lib.sh:235-239 at the base) keys on rc 1:
  //   rc 0 = a chip IS present -> a real pasted draft, KEEP it
  //   rc 1 = no chip           -> the painted idle hint, BLANK it
  //   rc 2 = could not read    -> keep (Bash `!` would have blanked; that was the pre-B1 bug)
  // In process the predicate is total, so `!textHasPasteCollapse(...)` IS rc 1.
  for (const name of ["claude-code-idle", "claude-code-session-limit"]) {
    const frame = readFileSync(join(import.meta.dir, `../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/${name}.ansi`), "utf8");
    // Premise: this capture really does enter the branch — a non-empty composer over
    // dim-prompt geometry with no chip. Without this the arm could pass on a frame that
    // never reaches the rule, which is exactly how the inversion survived review.
    const read = composerInput(frame, "claude");
    expect(`${name}: composer read`).toBe(read.state === "text" && read.text ? `${name}: composer read` : `${name}: NOT READ`);
    const text = read.state === "text" ? read.text : "";
    expect(`${name}: dim=${dimPromptInput(text, escapedPromptFromFrame(frame, "claude"), promptGlyph("claude"), "claude")} chip=${textHasPasteCollapse("claude", text)}`)
      .toBe(`${name}: dim=true chip=false`);
    // The rule: dim geometry with a definite "no chip" is a placeholder, so the band is bare.
    // Inverted, this same capture answers `draft` and parks ordinary delivery as busy:pending.
    expect(`${name}: ${observedBand({ frame, harness: "claude", paneWidth: "" })}`).toBe(`${name}: bare`);
  }
  // A real pasted chip is a draft, not a placeholder — the other half of the rule.
  const chip = "[Pasted Content 120 chars]";
  expect(textHasPasteCollapse("codex", chip)).toBe(true);
  expect(textHasPasteCollapse("codex", "an ordinary draft")).toBe(false);
  expect(textHasPasteCollapse("claude", chip)).toBe(false);
});

test("no codex capture reaches the chip branch, so the differential's agreement was not coverage", () => {
  // Why four doors agreed on `codex idle -> ready` while the predicate was inverted: readiness
  // asks `observedBand` only for codex, and `composerInput` strips codex's painted hint before
  // this branch, so the composer is empty and the branch is skipped. Recorded so the agreement
  // is not read as coverage of the chip rule a second time.
  for (const path of [
    "../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/codex-idle.ansi",
    "../../../skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-empty.ansi",
    "../../../skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-empty-40.ansi",
  ]) {
    const frame = readFileSync(join(import.meta.dir, path), "utf8");
    const read = composerInput(frame, "codex");
    expect(`${path}: ${read.state === "text" ? JSON.stringify(read.text) : read.state}`).toBe(`${path}: ""`);
    expect(observedBand({ frame, harness: "codex", paneWidth: "" })).toBe("bare");
  }
});

test("the observed band is the shipped policy's, over REAL captured frames", () => {
  // Hand-made frames are the trap B1's own composer arm records: a predicate that does
  // not recognize an invented geometry answers `unknown`, and the arm then asserts
  // nothing. These are the suite's captured panes.
  const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters", name), "utf8");
  // An idle codex pane: the composer reads empty, so the band is bare and readiness is ready.
  expect(observedBand(band({ frame: fixture("codex-idle.ansi"), harness: "codex" }))).toBe("bare");
  expect(paneReady(facts({ harnessCmd: "codex", band: observedBand(band({ frame: fixture("codex-idle.ansi"), harness: "codex" })) }), deps())).toBe("ready");
  // A working codex pane has no typeable band: `unobservable` holds as busy:noprompt.
  const working = observedBand(band({ frame: fixture("codex-working.ansi"), harness: "codex" }));
  expect(paneReady(facts({ harnessCmd: "codex", band: working }), deps())).toBe(working === "bare" ? "ready" : "busy:noprompt");
  // tap-89a57: a composer the feedback card hides is a named hold; a complete one below it is read as usual.
  expect(observedBand(band({ frame: fixture("claude-feedback-card-empty-hidden.ansi"), harness: "claude" }))).toBe("feedback-draft");
  expect(observedBand(band({ frame: fixture("claude-feedback-card-visible.ansi"), harness: "claude" }))).toBe("bare");
  expect(observedBand(band({ frame: fixture("claude-feedback-card-text-hidden.ansi"), harness: "claude" }))).toBe("feedback-draft");
});

// --- display state -----------------------------------------------------------------

// Rule 40 (census tap-uddlm, as corrected 2026-09-16: `json.loads` raises on a BOM for
// STR and parses it for BYTES). This PR opens ONE new file-decoding door, the sidecar read
// behind `display-row`, and it is on the str side: the incumbent heredoc was
// `json.load(open(path))` — text mode, no `'rb'` — so it RAISES on a BOM'd packet.
// Measured, not inherited from the census: `Unexpected UTF-8 BOM (decode using utf-8-sig)`.
// Its `except (OSError, ValueError, TypeError)` then printed nothing, which lib.sh's
// `[ -n "$row" ]` reported as `unknown`. `readFileSync(path, "utf8")` does not strip a BOM either, so `JSON.parse`
// throws into the door's catch and the door answers `unknown` too. Same answer, same
// reason. The positive control is the identical packet without the BOM.
test("a BOM'd sidecar is unreadable at the new door, exactly as the incumbent's heredoc raised", () => {
  const withBom = "\uFEFF" + JSON.stringify({ pane: "s:0.0", pane_id: "%1", target: "peer", to_team: "t", target_registry: "/r.json" });
  expect(() => JSON.parse(withBom)).toThrow();
  expect(displayRow(null, 0)).toBeNull();
  // The door's own answer for an unreadable packet, and the mapping over it.
  expect(displayState(null, "ready")).toBe("unknown");
  // The control: the same fields, parsed, are a readable row.
  const row = displayRow(JSON.parse(withBom.slice(1)), 0);
  expect(row?.pane).toBe("s:0.0");
});

test("displayRow reads the sidecar as the incumbent's heredoc did, and refuses what it refused", () => {
  const meta = { pane: "sess:0.0", pane_id: "%401", target: "peer", to_team: "fixture", target_registry: "/r.json", policy: "polite" };
  expect(displayRow({ ...meta, hold_until_epoch: 500, first_spooled_epoch: 100 }, 400))
    .toMatchObject({ pane: "sess:0.0", paneId: "%401", target: "peer", toTeam: "fixture", targetRegistry: "/r.json", policy: "polite", waiting: true });
  // Past the hold: not waiting. Before the first spool: not waiting either (the clock is behind the entry).
  expect(displayRow({ ...meta, hold_until_epoch: 500, first_spooled_epoch: 100 }, 500)!.waiting).toBe(false);
  expect(displayRow({ ...meta, hold_until_epoch: 500, first_spooled_epoch: 600 }, 400)!.waiting).toBe(false);
  // A missing clock is zero, as `int(x or 0)` read it.
  expect(displayRow({ ...meta }, 400)!.waiting).toBe(false);
  // What the heredoc's `except` swallowed, printing nothing: a non-object, a non-integer clock.
  expect(displayRow(null, 400)).toBeNull();
  expect(displayRow([1, 2], 400)).toBeNull();
  expect(displayRow("{}", 400)).toBeNull();
  expect(displayRow({ ...meta, hold_until_epoch: "soon" }, 400)).toBeNull();
  // Python `str(x or "")` over the six fields: a falsy value is the empty string.
  expect(displayRow({ ...meta, pane_id: 0, policy: false }, 400)).toMatchObject({ paneId: "", policy: "" });
});

test("displayState maps every readiness verdict, and an incomplete row is unknown", () => {
  const row = displayRow({ pane: "sess:0.0", pane_id: "%401", target: "peer", to_team: "t", target_registry: "/r.json", hold_until_epoch: 500, first_spooled_epoch: 100 }, 400)!;
  const now = displayRow({ pane: "sess:0.0", pane_id: "%401", target: "peer", to_team: "t", target_registry: "/r.json" }, 400)!;
  expect(displayState(row, "busy:in-turn")).toBe("focus");
  for (const verdict of ["busy", "busy:pending", "busy:noprompt", "busy:booting", "busy:overprint", "busy:modal", "busy:clearing", "busy:recovery", "busy:queued", "busy:decision-unavailable"] as const) {
    expect(displayState(row, verdict)).toBe("hold");
  }
  expect(displayState(row, "ready")).toBe("batch");   // waiting: inside its hold window
  expect(displayState(now, "ready")).toBe("ready");   // not waiting: due now
  expect(displayState(row, "gone")).toBe("gone");
  expect(displayState(row, "unsafe")).toBe("unsafe");
  // The incumbent's `*)` arm: an empty verdict (the readiness call failed) is unknown.
  expect(displayState(row, "")).toBe("unknown");
  expect(displayState(null, "ready")).toBe("unknown");
  // Any blank binding field is unknown before readiness is consulted at all.
  for (const field of ["pane", "paneId", "target", "targetRegistry"] as const) {
    expect(displayState({ ...row, [field]: "" }, "ready")).toBe("unknown");
  }
});

test("agyInTurnFromFrame reads the LAST non-empty row, as the incumbent's awk did", () => {
  expect(agyInTurnFromFrame("working\nesc to cancel\n")).toBe(true);
  // Trailing blank rows do not hide the marker.
  expect(agyInTurnFromFrame("esc to cancel\n\n\n")).toBe(true);
  // The marker on an EARLIER row is not the last one: the seat finished its turn.
  expect(agyInTurnFromFrame("esc to cancel\n> \n")).toBe(false);
  expect(agyInTurnFromFrame("")).toBe(false);
  expect(agyInTurnFromFrame("> \n")).toBe(false);
});

test("OpenCode shell mode is a distinct hold rather than booting or a human draft", () => {
  expect(paneReady(facts({harnessCmd:"opencode",pending:{kind:"shell-mode"}}),deps())).toBe("busy:shell-mode");
});
