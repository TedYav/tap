/**
 * `tap team down|shutdown` (and reset's stop phase), natively, against the
 * Bash engine they delete — RUN, not read. The harness is
 * test/helpers/incumbent-oracle.ts; this file is the corpus.
 *
 * Every case builds a fresh team fixture (registry rows written through the
 * launcher's own writer, real tmux sessions on the runner's private server,
 * PATH shims), drives the stop through both head doors from the restored
 * initial state, and compares stdout, stderr, exit code and the `.tap/` +
 * machine-index effects with the incumbent engine captured live from
 * `TAP_T1_ORACLE_BASE` (else replayed from fixtures/team-stop-oracle.json).
 *
 * Self-last arms run INSIDE the self row's own pane (respawned, same pane id
 * the registry stamped), because caller identity is a tty-walk fact. A
 * successful `--kill-self` or a committing clear takes that pane down with
 * the engine — the incumbent contract is receipt-before-kill, so those arms
 * declare `allowPaneDeath` and the recorded rc is null on every door.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { bootId } from "../src/tmux";

import {
  BASE, Oracle, applyDeviations, assertBaseCheckout, assertCaptureProvenance, canonicalStreams, type Deviation, type FixtureSpec, type Streams,
  TEAMSTOP_ORACLE_PINNED_BASE, tmux,
} from "./helpers/incumbent-oracle";

type DeviationName = "receipt-names-spared-seats";

/**
 * Declared departures from the frozen incumbent. Each must fire on the case
 * that declares it, so a stale ratification fails the test.
 */
const DEVIATIONS: Record<DeviationName, Deviation> = {
  "receipt-names-spared-seats": {
    why: "The incumbent's spare receipt counted every spared seat but named only the typed selector (tap-25uy). "
      + "The native receipt ends with `(spared: ...)`, the effective spared handles, so a counted seat is always named.",
    apply: s => ({ ...s, stdout: s.stdout.replace(
      "tap team shutdown: spared 1 seat(s) by --only alice — every other seat\n",
      "tap team shutdown: spared 1 seat(s) by --only alice — every other seat (spared: bob)\n",
    ) }),
  },
};

/**
 * The frozen incumbent capture predates the approval-timeout reset component: reset-components lists it as
 * `checkpoint`, so every reset's inventory.json carries one more empty entry right after goalie. Insert exactly
 * that entry; a capture that already has it, or lacks the goalie anchor, fails loudly instead of passing quietly.
 */
function withApprovalTimeoutComponent(effects: Streams["effects"]): Streams["effects"] {
  const out = { ...effects };
  for (const [path, body] of Object.entries(out)) {
    if (!path.endsWith("/inventory.json") || body === null) continue;
    const inventory = JSON.parse(body) as { components: { files: number; name: string }[] };
    const after = inventory.components.findIndex(c => c.name === "goalie");
    if (after < 0 || inventory.components.some(c => c.name === "approval-timeout")) {
      throw new Error(`frozen ${path} no longer needs the approval-timeout entry; drop this adjustment`);
    }
    inventory.components.splice(after + 1, 0, { files: 0, name: "approval-timeout" });
    out[path] = `${JSON.stringify(inventory, null, 2)}\n`;
  }
  return out;
}

interface CaseSpec extends FixtureSpec {
  name: string;
  /** Named departures from the frozen incumbent bytes. */
  deviations?: DeviationName[];
  /** Arguments after `team` (`["down", "--keep-self"]`, `["shutdown", "--yes"]`). */
  argv: string[];
  env?: NodeJS.ProcessEnv;
  /** Run the verb inside the self row's existing pane (identity + self-last). */
  inSelfPane?: boolean;
  /** The self-last kill is expected to take the caller pane down (rc null). */
  allowPaneDeath?: boolean;
}

/**
 * The fence stamp a foreign-fence fixture needs: THIS test process as a live
 * owner (real pid, real boot id, real process-start epoch), so the guard's
 * owner-liveness probe answers "live" on both doors and both refuse. Computed
 * per case, never frozen — it is fixture INPUT, not expectation.
 */
function liveFenceStamp(): string {
  const pid = process.pid;
  const boot = bootId();
  if (!boot) throw new Error("boot id unavailable for live fence owner");
  const started = spawnSync("bash", ["-c",
    `raw="$(TZ=UTC ps -p ${pid} -o lstart= | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; `
    + `TZ=UTC date -j -f '%a %b %e %H:%M:%S %Y' "$raw" +%s 2>/dev/null || TZ=UTC date -d "$raw UTC" +%s`],
    { encoding: "utf8" });
  if (started.status !== 0 || !/^[0-9]+$/.test(started.stdout.trim())) throw new Error(`owner_start epoch failed: ${started.stderr}`);
  return `${JSON.stringify({
    op: "team-reset",
    pid,
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    token: "oracle-foreign-fence",
    boot_id: boot,
    owner_start: Number(started.stdout.trim()),
    phase: "checkpointing",
  }, null, 2)}\n`;
}

const CASES: CaseSpec[] = [
  // 1. default down, self last: the engine takes the caller pane down with
  //    the team — receipt precedes the kill (rc null on every door).
  {
    name: "down_default_self_last", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }, { handle: "boss", live: true }],
    argv: ["down"], inSelfPane: true, allowPaneDeath: true,
  },
  // 1b. --keep-self: the caller's row and session survive; rc observable.
  {
    name: "down_keep_self_caller_survives", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }, { handle: "boss", live: true }],
    argv: ["down", "--keep-self"], inSelfPane: true,
  },
  // 2. --kill-self self-last: same pane-death contract, --kill-self spelled.
  {
    name: "down_kill_self_self_last", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "boss", live: true }],
    argv: ["down", "--kill-self"], inSelfPane: true, allowPaneDeath: true,
  },
  // 3a. clear with a selection-retained keep set; caller spared by --except.
  {
    name: "shutdown_clear_except_self", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }, { handle: "boss", live: true }],
    argv: ["shutdown", "--yes", "--except", "boss"], inSelfPane: true,
  },
  // 3b. clear self-last, keep-self off: pane dies after the receipt.
  {
    name: "shutdown_clear_self_last", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "boss", live: true }],
    argv: ["shutdown", "--yes"], inSelfPane: true, allowPaneDeath: true,
  },
  // 4. zero rows: the clear deletes the empty registry, and once it is
  //    observably gone under live v0.20 authority the H1 index de-enroll
  //    captures + removes the enrollment.
  {
    name: "shutdown_zero_rows_empty_registry_index_deenroll", team: "demo",
    rows: [], globalEnroll: true,
    argv: ["shutdown", "demo", "--yes"],
  },
  // 5. named positional composes with --only (selector values are never
  //    operands); the named team's bus resolves through the machine index.
  {
    name: "shutdown_named_positional_composes_only", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }],
    globalEnroll: true, argv: ["shutdown", "demo", "--only", "alice", "--yes"],
    deviations: ["receipt-names-spared-seats"],
  },
  {
    name: "shutdown_named_positional_extra_refuses", team: "demo",
    rows: [{ handle: "alice", live: true }], globalEnroll: true,
    argv: ["shutdown", "demo", "extra"],
  },
  // 6. --only with an unverified pane refuses (exit 1); with a poll row it
  //    retains and exits 0.
  {
    name: "down_only_unverified_pane_refuses", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "ghost", live: false }],
    argv: ["down", "--only", "alice,ghost"],
  },
  {
    name: "down_only_poll_row_retained", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "polldata", live: false, delivery: "poll" }],
    argv: ["down", "--only", "alice,polldata"],
  },
  // 7. kill survives: tmux refuses kill-session for the verb only.
  {
    name: "kill_survives_suspend_rollback", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "boss", live: true }],
    tmuxRefuse: ["kill-session"], argv: ["down"], inSelfPane: true,
  },
  {
    name: "kill_survives_clear_recovery_pending", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "boss", live: true }],
    tmuxRefuse: ["kill-session"], argv: ["shutdown", "--yes"], inSelfPane: true,
  },
  // 8/9. plan/dry-run and the JSON receipt surface.
  {
    name: "down_dry_run", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }],
    argv: ["down", "--dry-run"],
  },
  {
    name: "down_json_receipt", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }],
    argv: ["down"], env: { TAP_JSON: "1" },
  },
  {
    name: "down_except_dry_run", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }],
    argv: ["down", "--except", "bob", "--dry-run"],
  },
  // 10. reset's stop phase through the public reset door.
  {
    name: "reset_clean_stops_teammates", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "bob", live: true }],
    argv: ["reset", "--yes"], env: { TAP_RESET_ARCHIVE_SUFFIX: "resetclean" },
  },
  {
    name: "reset_aborts_on_unverified_pane", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "ghost", live: false }],
    argv: ["reset", "--yes"], env: { TAP_RESET_ARCHIVE_SUFFIX: "resetghost" },
  },
  {
    name: "reset_spared_poll_row_proceeds", team: "demo",
    rows: [{ handle: "alice", live: true }, { handle: "polldata", live: false, delivery: "poll" }],
    argv: ["reset", "--yes"], env: { TAP_RESET_ARCHIVE_SUFFIX: "resetpoll" },
  },
  // Foreign live fence on the bus: public down refuses before anything else.
  {
    name: "down_foreign_live_fence_refuses", team: "demo",
    rows: [{ handle: "alice", live: true }],
    preFiles: { ".tap/bus/reset.fence.json": "FENCE_STAMP" },
    argv: ["down"],
  },
];

const oracle = new Oracle("team-stop", join(import.meta.dir, "fixtures", "team-stop-oracle.json"), { indexState: true });
const capture = oracle.capture();
const written: NonNullable<typeof capture>["cases"] = [];
if (!BASE && capture) assertCaptureProvenance(capture, oracle.fixturePath, TEAMSTOP_ORACLE_PINNED_BASE);

beforeAll(() => {
  if (!BASE && !capture) throw new Error(`no frozen capture at ${oracle.fixturePath} and TAP_T1_ORACLE_BASE is unset`);
  assertBaseCheckout("skills/tap/scripts/tap-team-stop.sh", TEAMSTOP_ORACLE_PINNED_BASE);
});

afterAll(() => {
  // These blob names belong to the pinned BASE checkout, not the candidate.
  // Keep reset's retired shell path as provenance for the existing capture.
  // Freeze mode writes the capture; replay leaves the fixture untouched.
  oracle.writeCapture(written, [
    "skills/tap/scripts/tap-team-stop.sh", "skills/tap/scripts/tap-team.sh",
    "skills/tap/scripts/tap-team-reset.sh", "skills/tap/scripts/lib.sh",
  ], CASES.length);
});

/** The self row's session: `boss` when present, else the first row. */
function selfSessionOf(spec: CaseSpec, base: string): string {
  const handle = spec.rows.find(r => r.handle === "boss")?.handle ?? spec.rows[0]!.handle;
  return `${base}/${handle}`;
}

for (const spec of CASES) {
  test(spec.name, () => {
    const fixture = oracle.newFixture(spec);
    try {
      const frozen = capture?.cases.find(c => c.name === spec.name);
      const built: CaseSpec = spec.preFiles?.[".tap/bus/reset.fence.json"] === "FENCE_STAMP"
        ? { ...spec, preFiles: { ...spec.preFiles, [".tap/bus/reset.fence.json"]: liveFenceStamp() } }
        : spec;
      const inputs = oracle.buildFixture(built, fixture, !BASE ? frozen?.inputs : undefined);
      const argv = ["team", ...built.argv];
      const doorOptions = (f: typeof fixture) => ({
        env: built.env,
        ...(built.inSelfPane
          ? {
            insidePane: { session: selfSessionOf(built, f.base), existing: true },
            allowPaneDeath: built.allowPaneDeath,
          }
          : {}),
      });
      let expected: Streams;
      if (BASE) {
        const { trace: _baseTrace, ...incumbent } = oracle.run("base", fixture, argv, doorOptions(fixture));
        expected = incumbent;
        written.push({ name: spec.name, expected, inputs });
        // FREEZE captures the incumbent only: at the pinned base the head
        // doors still route these verbs to Bash (the cutover IS this range),
        // so comparing against them here would assert nothing.
        return;
      }
      if (!frozen) throw new Error(`case ${spec.name} has no frozen expectation; regenerate with TAP_T1_ORACLE_BASE + TAP_T1_ORACLE_WRITE=1`);
      expected = applyDeviations(DEVIATIONS, canonicalStreams(frozen.expected), spec.deviations, spec.name);
      const check = (actual: Streams) => {
        if (!spec.name.startsWith("reset_")) { expect(actual).toEqual(expected); return; }
        // Reset's retired Bash prefix is not a BIN B contract. Keep the
        // durable effects and stop result; assert the native receipt's meaning.
        expect(actual.rc).toBe(expected.rc);
        // The frozen incumbent capture predates tap-vne2e: reset now takes the archive lock
        // (takeArchiveLock) and reset-components lists archive.lock as `preserve`, so one empty lock
        // file survives every reset by design. Add exactly that entry; every other effect must match.
        expect(actual.effects).toEqual({ ...withApprovalTimeoutComponent(expected.effects), ".tap/bus/archive.lock": "" });
        if (actual.rc === 0) {
          expect(actual.stderr).toBe("");
          expect(actual.stdout).toContain("checkpointed and reinitialized team bus");
          expect(actual.stdout).toContain("next: tap in");
        } else {
          expect(actual.stdout).toBe("");
          expect(actual.stderr).toContain("tap team reset: reset aborted: 1 stopped, 1 refused");
        }
      };
      const { trace, ...native } = oracle.run("head-native", fixture, argv, doorOptions(fixture));
      check(native);
      // main.ts writes the route trace only after the handler RETURNS; a
      // self-last caller pane is killed before that, so its trace stays empty.
      // Reset now calls this same stop engine in-process from its native door.
      if (native.rc !== -1) expect(trace).toBe("native team\n");
    } finally {
      // The engine legitimately kills fixture sessions (they are the corpus):
      // kill each survivor, never failing the case for an already-gone one.
      for (const session of fixture.sessions) tmux(["kill-session", "-t", `=${session}`]);
    }
  }, 180_000);
}

describe("fixture sanity", () => {
  test("scratch path aliases share a placeholder without changing unrelated paths", () => {
    for (const scratch of [oracle.scratch, realpathSync(oracle.scratch)]) {
      expect(oracle.normalize(`${scratch}/c42/demo/reset.fence.json`)).toBe("{CASE}/demo/reset.fence.json");
    }
    expect(oracle.normalize("/private/unrelated/reset.fence.json")).toBe("/private/unrelated/reset.fence.json");
  });

  test("self-pane arms name an existing row session", () => {
    for (const spec of CASES.filter(c => c.inSelfPane)) {
      const handle = spec.rows.find(r => r.handle === "boss")?.handle ?? spec.rows[0]!.handle;
      expect(spec.rows.find(r => r.handle === handle)).toBeDefined();
    }
  });
});
