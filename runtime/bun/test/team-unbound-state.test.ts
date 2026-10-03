import { afterAll, expect, test } from "bun:test";
import { observeRows, US } from "../src/observe";
import { payloadFromEnv } from "./support/observe-env-fixture";
import type { RowInput } from "../src/observe";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/team-unbound-state.test.sh (its
// classifier arms; the roster-renderer agreement stays in that shell file,
// driven through the public `tap team` doors).
//
// The shell file reached the classifier by exec'ing the module with rows as
// JSON on stdin and the snapshot as TAP_OBS_* env knobs with three temp-file
// PATHS. In-process the same contract is payloadFromEnv + observeRows: the
// arms below build a TAP_OBS_* fixture payload and classify it directly,
// without spawning a process.
//
// The scenario: a suspended/server_restarted row whose exact session and a
// single harness-matching pane survived is observed as unbound. The scoped
// snapshot (TAP_OBS_SESSION_SCOPE) promises every pane row belongs to
// demo/scout.

const DIR = mkdtempSync(join(tmpdir(), "tap-unbound."));
const SESSIONS = join(DIR, "sessions");
const PANES = join(DIR, "panes");
const PS_ROWS = join(DIR, "ps");

const LIVE_SESSIONS = `demo/scout\t900:100\t0\n`;
const LIVE_PANES = `demo/scout\tdemo/scout:0.0\t%11\tcodex\t111\t900:100\t0\n`;

function env(): NodeJS.ProcessEnv {
  return {
    TAP_SERVER_EPOCH: "srv:900:100",
    TAP_OBS_SESSIONS_FILE: SESSIONS,
    TAP_OBS_PANES_FILE: PANES,
    TAP_OBS_PS_FILE: PS_ROWS,
    TAP_OBS_SESSIONS_RC: "0",
    TAP_OBS_PANES_RC: "0",
    TAP_OBS_PS_RC: "1",
    TAP_OBS_NOW_BOOT: "boot:2",
    TAP_OBS_BOOT_SET: "1",
    TAP_OBS_NOW_TS: "1788492467",
    TAP_OBS_SESSION_SCOPE: "demo/scout",
  };
}

function recoveringRow(overrides: Partial<RowInput> = {}): RowInput[] {
  return [{
    key: "scout", status: "suspended", delivery: "pane", pane: "", pane_id: "",
    session: "demo/scout", registered_at: "", row_epoch: "srv:900:100",
    row_boot: "boot:2", harness: "codex", status_reason: "server_restarted",
    ...overrides,
  }];
}

/** The classifier driven from a TAP_OBS_* fixture payload: payload from env, then classify. */
function classifyFromEnv(rows: RowInput[], e: NodeJS.ProcessEnv): string[] {
  return observeRows(payloadFromEnv(rows, e), e);
}

const UNBOUND = ["scout", "unbound", "server_restarted", "demo/scout:0.0", "%11", "codex", "0"].join(US);
const OFFLINE = ["scout", "offline", "server_restarted", "", "", "", ""].join(US);

function writeSnapshot(sessions: string, panes: string, ps: string): void {
  writeFileSync(SESSIONS, sessions);
  writeFileSync(PANES, panes);
  writeFileSync(PS_ROWS, ps);
}

test("one live matching pane with ps skipped observes the seat unbound, with full recovery evidence", () => {
  // ps rc=1: the scoped Bash observation deliberately skips ps, and every
  // shallow command here is already agent-class, so the pane attests codex.
  writeSnapshot(LIVE_SESSIONS, LIVE_PANES, "");
  expect(classifyFromEnv(recoveringRow(), env())).toEqual([UNBOUND]);
});

test("a restart-suspended row that still carries either binding coordinate keeps the pre-recovery offline answer", () => {
  // The invalidation writer clears both binding fields. A damaged or restored
  // row retaining EITHER coordinate must not enter the recovery path or leak
  // its stored suspended state — so the arm runs all three shapes: pane only,
  // pane_id only, and both.
  writeSnapshot(LIVE_SESSIONS, LIVE_PANES, "");
  const e = env();
  expect(classifyFromEnv(recoveringRow({ pane: "demo/scout:0.0" }), e)).toEqual([OFFLINE]);
  expect(classifyFromEnv(recoveringRow({ pane_id: "%11" }), e)).toEqual([OFFLINE]);
  expect(classifyFromEnv(recoveringRow({ pane: "demo/scout:0.0", pane_id: "%11" }), e)).toEqual([OFFLINE]);
});

test("a pane pid absent from a successful ps snapshot is offline, not unbound", () => {
  // The pane's shallow command (python3) cannot attest the harness and the ps
  // snapshot contains no pane PID: harness_evidence's unobservable arm. One
  // live pane alone is insufficient.
  const e = env();
  e.TAP_OBS_PS_RC = "0";
  writeSnapshot(LIVE_SESSIONS, `demo/scout\tdemo/scout:0.0\t%11\tpython3\t111\t900:100\t0\n`, "");
  expect(classifyFromEnv(recoveringRow(), e)).toEqual([OFFLINE]);
});

test("a pane attesting a different family than the stored harness is offline, not unbound", () => {
  // Attestation must AGREE with the registration to reach unbound; a pane
  // attesting another family is a mismatch, and a recovering seat reports its
  // recovery rather than the mismatch (observe.ts's failed() rule). The
  // unbound tuple's harness field in the positive arm is therefore the stored
  // family, attested — never a third value the snapshot guessed.
  writeSnapshot(LIVE_SESSIONS, LIVE_PANES, "");
  const misstored = recoveringRow({ harness: "claude" });
  expect(classifyFromEnv(misstored, env())).toEqual([OFFLINE]);
});

test("two live matching panes stay offline: rebinding may never guess", () => {
  const two = `${LIVE_PANES}demo/scout\tdemo/scout:0.1\t%12\tcodex\t112\t900:100\t0\n`;
  writeSnapshot(LIVE_SESSIONS, two, "");
  expect(classifyFromEnv(recoveringRow(), env())).toEqual([OFFLINE]);
});

test("a stored session that is positively absent remains offline", () => {
  writeSnapshot("", "", "");
  expect(classifyFromEnv(recoveringRow(), env())).toEqual([OFFLINE]);
});

afterAll(() => removeScratchTree(DIR));
