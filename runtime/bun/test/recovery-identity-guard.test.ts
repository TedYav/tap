import { expect, test } from "bun:test";
import { checkIdentityGuard, type IdentityGuardEvidence } from "../src/recovery/identity-guard";
import type { IdentityGuardResult } from "../src/pane-identity";

// The registry path is deliberately unreadable AND distinctive: every arm below
// asserts it never reaches the recorded evidence. A recovery artifact is a
// durable file, and the guard's inputs are not its business.
const target = {
  team: "fixture", handle: "peer", registry: "/not-read", pane: "%1", paneId: "%1",
  session: "fixture/peer", instance: "fixture", harness: "codex",
};

const verdict = (over: Partial<IdentityGuardResult>): IdentityGuardResult => ({
  outcome: "authorized", state: "match", message: null,
  harnessAlive: true, permissions: "bypass", ...over,
});

const run = (guard: () => IdentityGuardResult): { evidence: IdentityGuardEvidence; denial: string | null } => {
  let evidence: IdentityGuardEvidence | undefined;
  const denial = checkIdentityGuard(target, e => { evidence = e; }, guard);
  return { evidence: evidence!, denial };
};

test("an authorized guard records the outcome and denies nothing", () => {
  const { evidence, denial } = run(() => verdict({}));
  expect(denial).toBeNull();
  expect(evidence.outcome).toBe("authorized");
  expect(evidence.state).toBe("match");
  expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
});

// Drift and instrument failure are DIFFERENT facts and must stay
// distinguishable in the artifact: only the first is a claim about the pane.
for (const [state, outcome] of [
  ["pane_drift", "refused"], ["pane_recycled", "refused"], ["harness_exited", "refused"],
  ["permissions_unknown", "refused"],
  ["session_unobservable", "unobservable"], ["pane_set_unobservable", "unobservable"],
  ["harness_unobservable", "unobservable"], ["registry_missing", "unobservable"],
] as const) {
  test(`a ${state} guard is recorded as ${outcome}, with its own token`, () => {
    const { evidence, denial } = run(() => verdict({
      outcome, state, message: `tap: bound recipient identity drifted before pane effect (${state})`,
      harnessAlive: false,
    }));
    expect(evidence.outcome).toBe(outcome);
    expect(evidence.state).toBe(state);
    expect(denial).toContain("identity guard");
    expect(denial).toContain(state);
  });
}

test("the ONE silent refusal still denies, and names itself in the record", () => {
  // `TAP_SUBMIT_PERMISSIONS = unknown` is the incumbent's rc 6 with nothing on
  // stderr. The adapter keeps that silence; this record does not have to.
  const { evidence, denial } = run(() => verdict({
    outcome: "refused", state: "permissions_unknown", message: null, harnessAlive: false,
  }));
  expect(evidence.stderr).toBe("");
  expect(evidence.state).toBe("permissions_unknown");
  expect(denial).toContain("state=permissions_unknown");
});

test("a spent budget arrives as a RESULT, not a throw", () => {
  // `submitIdentityGuard` owns the deadline refusal, so it reaches this recorder
  // through the ordinary success path. The arm exists because the obvious place
  // to handle it — the catch below — is unreachable, and a dead branch there
  // would read as coverage of a case that cannot occur.
  const { evidence, denial } = run(() => verdict({
    outcome: "unobservable", state: "guard_deadline",
    message: "tap: pane identity guard exceeded its deadline before pane effect",
    harnessAlive: false,
  }));
  expect(evidence.outcome).toBe("unobservable");
  expect(evidence.state).toBe("guard_deadline");
  expect(denial).toContain("state=guard_deadline");
});

test("any other throw is a FAULT — broken code, not unavailable evidence", () => {
  // The test NAME said "fault" while the assertion said "unobservable", which is
  // how the mismatch survived: recovery recorded every throw as unobservable, so
  // `fault` was unreachable there while the CLI door emitted it. An operator
  // reads the two differently — unobservable means look at the server, fault
  // means this code is broken — and dead vocabulary in the record that explains
  // the outcome is the same defect as a dead branch.
  const { evidence, denial } = run(() => { throw new Error("reader exploded"); });
  expect(evidence.outcome).toBe("fault");
  expect(evidence.state).toBe("guard_fault");
  expect(evidence.stderr).toContain("reader exploded");
  expect(denial).toContain("identity guard");
});

test("no guard input reaches the recorded evidence", () => {
  for (const guard of [
    () => verdict({}),
    () => verdict({ outcome: "refused", state: "pane_drift", message: "drifted" }),
    (): IdentityGuardResult => { throw new Error("boom"); },
  ]) {
    const { evidence } = run(guard);
    expect(JSON.stringify(evidence)).not.toContain("/not-read");
    expect(JSON.stringify(evidence)).not.toContain("fixture/peer");
  }
});

test("message text is bounded and sanitized", () => {
  const { evidence } = run(() => verdict({
    outcome: "refused", state: "pane_drift",
    message: "\x1b[31m" + "x".repeat(3000) + "\x00",
  }));
  expect(evidence.stderr.length).toBe(1024);
  expect(evidence.stderrTruncated).toBe(true);
  expect(evidence.stderr).not.toContain("\x1b");
  expect(evidence.stderr).not.toContain("\x00");
});
