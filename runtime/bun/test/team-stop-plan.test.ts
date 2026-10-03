import { expect, test } from "bun:test";
import { TapError } from "../src/context";
import { snapshotTmux } from "../src/lifecycle-target";
import { noSelection } from "../src/team/selection";
import {
  classifyNokill,
  classifyTeamRows,
  buildSpareSets,
  noSeatsMatchedText,
  parseRowDump,
  parseStopArgs,
  partiallyDownLine,
  passZeroAllSpared,
  passZeroSpareSets,
  renderPlanText,
  renderReceiptLines,
  renderSpareReceiptLines,
  renderStopReceiptJson,
  selfNote,
  stopExitCode,
  zeroRowText,
  dryRunText,
  type NokillEntry,
  type StopRow,
} from "../src/team/stop-plan";

let seq = 0;
function row(over: Partial<StopRow> = {}): StopRow {
  seq += 1;
  return {
    handle: over.handle ?? `h${seq}`,
    delivery: over.delivery ?? "pane",
    pane: over.pane ?? "",
    paneId: over.paneId ?? `%${seq}`,
    serverEpoch: over.serverEpoch ?? "7",
    session: over.session ?? "",
    status: over.status ?? "",
    statusReason: over.statusReason ?? "",
    crew: over.crew ?? false,
  };
}

function expectTapError(fn: () => unknown, klass: string, action: string, detail: string) {
  try {
    fn();
    throw new Error(`expected TapError ${klass}`);
  } catch (e) {
    expect(e).toBeInstanceOf(TapError);
    const err = e as TapError;
    expect(err.errorClass).toBe(klass);
    expect(err.action).toBe(action);
    expect(err.detail).toBe(detail);
  }
}

test("flag parse accepts the incumbent surface; --yes/--force are swallowed no-ops (tap-team-stop.sh L1538-1543)", () => {
  const parsed = parseStopArgs("down", ["--json", "--dry-run", "--yes", "--force", "--keep-self"]);
  expect(parsed.wantJson).toBe(true);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.keepSelf).toBe(true);
  expect(parsed.killSelf).toBe(false);
  expect(parsed.selection).toEqual(noSelection());
  const kill = parseStopArgs("shutdown", ["--kill-self"]);
  expect(kill.keepSelf).toBe(false);
  expect(kill.killSelf).toBe(true);
});

test("reset-stop defaults keep_self and --kill-self is the inverse; down keeps prior semantics (tap-team-stop.sh L1558-1562)", () => {
  expect(parseStopArgs("reset-stop", []).keepSelf).toBe(true);
  expect(parseStopArgs("reset-stop", ["--kill-self"]).keepSelf).toBe(false);
  expect(parseStopArgs("down", []).keepSelf).toBe(false);
  expect(parseStopArgs("shutdown", []).keepSelf).toBe(false);
});

test("selection parse refuses repeated handles before a stop action", () => {
  expectTapError(
    () => parseStopArgs("down", ["--only", "bob,carol,bob"]),
    "usage_error",
    "tap team down --only <handle>[,<handle>...]",
    "--only repeats handle 'bob'",
  );
});

test("selection parse refuses an empty value through parseSelection (selection.ts L61-62)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--except", ""]),
    "usage_error",
    "tap team down --except <handle>[,<handle>...]",
    "--except was given an empty value; name at least one handle to spare",
  );
  expectTapError(
    () => parseStopArgs("shutdown", ["--only", ""]),
    "usage_error",
    "tap team shutdown --only <handle>[,<handle>...]",
    "--only was given an empty value; name at least one handle to act on",
  );
});

test("selection parse refuses interior and trailing empty tokens (selection.ts L64-71)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--only", "bob,,carol"]),
    "usage_error",
    "tap team down --only <handle>[,<handle>...]",
    "--only 'bob,,carol' has an empty handle between commas",
  );
  expectTapError(
    () => parseStopArgs("down", ["--except", "bob,"]),
    "usage_error",
    "tap team down --except <handle>[,<handle>...]",
    "--except 'bob,' has an empty handle between commas",
  );
});

test("selection parse refuses team-qualified and invalid-charset handles (selection.ts L72-77)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--only", "team/bob"]),
    "usage_error",
    "tap team down --only <handle>[,<handle>...]",
    "--only takes bare handles from THIS team; 'team/bob' is team-qualified",
  );
  expectTapError(
    () => parseStopArgs("down", ["--only", "team:bob"]),
    "usage_error",
    "tap team down --only <handle>[,<handle>...]",
    "--only takes bare handles from THIS team; 'team:bob' is team-qualified",
  );
  expectTapError(
    () => parseStopArgs("down", ["--except", "bo b"]),
    "usage_error",
    "tap team down --except <handle>[,<handle>...]",
    "--except handle 'bo b' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$",
  );
});

test("--except without a value refuses with the incumbent usage shape (tap-team-stop.sh L1545-1547)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--except"]),
    "usage_error",
    "tap team down --except <handle>[,<handle>...]",
    "--except was given no value; name at least one handle to spare",
  );
});

test("--only without a value refuses with the incumbent usage shape (tap-team-stop.sh L1550-1552)", () => {
  expectTapError(
    () => parseStopArgs("shutdown", ["--only"]),
    "usage_error",
    "tap team shutdown --only <handle>[,<handle>...]",
    "--only was given no value; name at least one handle to act on",
  );
});

test("unknown option matches tap_unknown_option's shape (tap-team-stop.sh L1554; lib.sh L557)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--frobnicate"]),
    "unknown_option",
    "tap help team down",
    "unknown option '--frobnicate'",
  );
});

test("a bare positional refuses as unexpected arg (tap-team-stop.sh L1555)", () => {
  expectTapError(
    () => parseStopArgs("down", ["extra"]),
    "usage_error",
    "tap help team down",
    "unexpected arg 'extra'",
  );
});

test("--only and --except together refuse as complements (tap-team-stop.sh L1575-1577)", () => {
  expectTapError(
    () => parseStopArgs("down", ["--except", "bob", "--only", "carol"]),
    "usage_error",
    "tap team down [--only <handles> | --except <handles>]",
    "tap team down takes --only or --except, never both: they are complements, so naming both states the selection twice and the two statements can disagree",
  );
});

test("row dump parse keeps the incumbent 9-field order and defaults (tap-team-stop.sh L1643-1658)", () => {
  const dump = [
    "alpha",
    ["carol", "poll", "", "", "", "", "", "", "0"].join("\x1f"),
    ["bob", "", "p1", "%5", "3", "alpha/bob", "", "", "1"].join("\x1f"),
  ].join("\n");
  const { team, rows } = parseRowDump(dump);
  expect(team).toBe("alpha");
  expect(rows).toEqual([
    { handle: "carol", delivery: "poll", pane: "", paneId: "", serverEpoch: "", session: "", status: "", statusReason: "", crew: false },
    { handle: "bob", delivery: "pane", pane: "p1", paneId: "%5", serverEpoch: "3", session: "alpha/bob", status: "", statusReason: "", crew: true },
  ]);
});

test("classifyNokill retains poll and unseated, refuses the rest, and counts both (tap-team-stop.sh L1114-1124)", () => {
  const entries: NokillEntry[] = [
    { handle: "carol", reason: "poll" },
    { handle: "dave", reason: "unseated" },
    { handle: "erin", reason: "unverified_unbound" },
    { handle: "frank", reason: "server_epoch_unproven" },
  ];
  expect(classifyNokill(entries)).toEqual({
    retainedPoll: ["carol", "dave"],
    refusedHandles: ["erin", "frank"],
    pollN: 2,
    unverifiedN: 2,
  });
  expect(classifyNokill([]).retainedPoll).toEqual([]);
});

test("classification: spared rows are excepted before any probe (tap-team-stop.sh L1872-1878)", () => {
  const tmux = snapshotTmux({ panes: [] });
  const result = classifyTeamRows([row({ handle: "bob", session: "alpha/bob" })], {
    team: "alpha",
    selection: { mode: "--except", except: ["bob"], only: [] },
    sparedSessions: new Set(),
    selfSession: "",
    tmux,
  });
  expect(result.sparemap).toEqual([{ handle: "bob", why: "excepted", session: "alpha/bob" }]);
  expect(result.sparedRows).toBe(1);
  expect(result.seatmap).toEqual([]);
});

test("classification: poll rows and proven-inactive stripped rows are retained; live unbound refuses (tap-team-stop.sh L1879-1894)", () => {
  const tmux = snapshotTmux({ panes: [] });
  const result = classifyTeamRows(
    [
      row({ handle: "carol", delivery: "poll" }),
      row({ handle: "dave", paneId: "", pane: "", status: "suspended" }),
      row({ handle: "erin", paneId: "", pane: "", status: "active" }),
    ],
    { team: "alpha", selection: noSelection(), sparedSessions: new Set(), selfSession: "", tmux },
  );
  expect(result.nokill).toEqual([
    { handle: "carol", reason: "poll" },
    { handle: "dave", reason: "unseated" },
    { handle: "erin", reason: "unverified_unbound" },
  ]);
});

test("classification: session-stamped row sharing a spared session is spared without a probe (tap-team-stop.sh L1895-1914)", () => {
  const tmux = snapshotTmux({ panes: [] });
  const result = classifyTeamRows(
    [row({ handle: "gwen", session: "alpha/bob", paneId: "%9" })],
    { team: "alpha", selection: noSelection(), sparedSessions: new Set(["alpha/bob"]), selfSession: "", tmux },
  );
  expect(result.sparemap).toEqual([{ handle: "gwen", why: "shared_session", session: "alpha/bob" }]);
  expect(result.sparedRows).toBe(1);
});

test("classification: a refused destructive target joins nokill with its reason (tap-team-stop.sh L1915-1918)", () => {
  const tmux = snapshotTmux({ panes: [] });
  const result = classifyTeamRows(
    [row({ handle: "bob", session: "alpha/bob" })],
    { team: "alpha", selection: noSelection(), sparedSessions: new Set(), selfSession: "", tmux },
  );
  expect(result.nokill).toEqual([{ handle: "bob", reason: "session_name_gone" }]);
});

test("classification: authorized rows split into selfmap and seatmap with the incumbent field order (tap-team-stop.sh L1919-1925)", () => {
  const tmux = snapshotTmux({ panes: [{ id: "%5", session: "alpha/bob" }, { id: "%6", session: "alpha/carol" }] });
  const result = classifyTeamRows(
    [
      row({ handle: "bob", paneId: "%5", session: "alpha/bob" }),
      row({ handle: "carol", paneId: "%6", session: "alpha/carol" }),
    ],
    { team: "alpha", selection: noSelection(), sparedSessions: new Set(), selfSession: "alpha/carol", tmux },
  );
  expect(result.seatmap).toEqual([
    { session: "alpha/bob", handle: "bob", paneId: "%5", rowSession: "alpha/bob", serverEpoch: "7", expected: "alpha/bob" },
  ]);
  expect(result.selfmap).toEqual([
    { session: "alpha/carol", handle: "carol", paneId: "%6", rowSession: "alpha/carol", serverEpoch: "7", expected: "alpha/carol" },
  ]);
});

test("pass-0: a selection naming every row short-circuits without observation (tap-team-stop.sh L1746-1751)", () => {
  const rows = [row({ handle: "bob" }), row({ handle: "carol" })];
  expect(passZeroAllSpared(rows, { mode: "--except", except: ["bob", "carol"], only: [] })).toBe(true);
  expect(passZeroAllSpared(rows, { mode: "--except", except: ["bob"], only: [] })).toBe(false);
  expect(passZeroAllSpared(rows, noSelection())).toBe(false);
});

test("pass-0 spare sets: every handle excluded, unique nonempty session stamps in row order (tap-team-stop.sh L1753-1763)", () => {
  const sets = passZeroSpareSets([
    row({ handle: "bob", session: "alpha/bob" }),
    row({ handle: "carol", session: "alpha/bob" }),
    row({ handle: "dave", session: "" }),
  ]);
  expect(sets.excludedHandles).toEqual(["bob", "carol", "dave"]);
  expect(sets.sparedSessions).toEqual(["alpha/bob"]);
});

test("pass-1: crew spared rows join handles but never the session set (tap-team-stop.sh L1806-1815)", () => {
  const sets = buildSpareSets(
    [row({ handle: "w1", crew: true, session: "alpha/bob" })],
    { mode: "--except", except: ["w1"], only: [] },
    () => null,
    "down",
  );
  expect(sets.sparedHandles).toEqual(["w1"]);
  expect(sets.sparedSessions).toEqual([]);
});

test("pass-1: poll rows contribute no session key; stored stamps win without probing (tap-team-stop.sh L1816-1856)", () => {
  let probes = 0;
  const observe = () => {
    probes += 1;
    return null;
  };
  const sets = buildSpareSets(
    [
      row({ handle: "carol", delivery: "poll", session: "stale/old" }),
      row({ handle: "bob", session: "alpha/bob" }),
    ],
    { mode: "--except", except: ["carol", "bob"], only: [] },
    observe,
    "down",
  );
  expect(sets.sparedSessions).toEqual(["alpha/bob"]);
  expect(sets.sparedHandles).toEqual(["carol", "bob"]);
  expect(probes).toBe(0);
});

test("pass-1: a spared pane row with no stored session resolves through positive observation (tap-team-stop.sh L1847-1851)", () => {
  const sets = buildSpareSets(
    [row({ handle: "gwen", pane: "gwenPane", paneId: "", session: "" })],
    { mode: "--except", except: ["gwen"], only: [] },
    (target) => (target === "gwenPane" ? "observed\talpha/gwen\textra" : null),
    "down",
  );
  expect(sets.sparedSessions).toEqual(["alpha/gwen"]);
});

test("pass-1: a failed observation refuses the whole selection as unobservable_spare (tap-team-stop.sh L1853-1854)", () => {
  expectTapError(
    () =>
      buildSpareSets(
        [row({ handle: "gwen", pane: "gwenPane", paneId: "", session: "" })],
        { mode: "--except", except: ["gwen"], only: [] },
        () => null,
        "down",
      ),
    "unobservable_spare",
    "tap doctor",
    "seat 'gwen' is a spared pane row with no stored session, and its current session could not be positively observed — refusing the destructive selection rather than risk stopping a session this operator asked to spare",
  );
});

test("plan text renders the incumbent byte order for a suspend run (tap-team-stop.sh L2057-2120)", () => {
  const text = renderPlanText({
    verb: "down",
    team: "alpha",
    registryPolicy: "suspend",
    selection: { mode: "--except", except: ["frank"], only: [] },
    teammateSessions: ["alpha/bob"],
    selfSession: "alpha/carol",
    selfPresent: true,
    keepSelf: true,
    seatmap: [{ session: "alpha/bob", handle: "bob", paneId: "%5", rowSession: "alpha/bob", serverEpoch: "7", expected: "alpha/bob" }],
    selfmap: [{ session: "alpha/carol", handle: "carol", paneId: "%6", rowSession: "alpha/carol", serverEpoch: "7", expected: "alpha/carol" }],
    nokill: [
      { handle: "carol2", reason: "poll" },
      { handle: "dave", reason: "unseated" },
      { handle: "erin", reason: "unverified_unbound" },
    ],
    sparemap: [
      { handle: "frank", why: "excepted", session: "" },
      { handle: "gwen", why: "shared_session", session: "alpha/bob" },
    ],
    unsettled: 2,
    paneCount: (s) => (s === "alpha/bob" ? 2 : 1),
  });
  expect(text).toBe(
    [
      "tap team down: plan for team 'alpha'",
      "  kill session alpha/bob                (2 panes)  seats: bob",
      "  keep  session alpha/carol              (1 pane)  seats: carol  [SELF — kept]",
      "  retained poll (rows unchanged): carol2 (poll), dave (unseated)",
      "  refused unverified pane (rows retained; possible live target): erin (unverified_unbound)",
      "  spared by --except (rows unchanged): frank (excepted), gwen (shared_session: alpha/bob)",
      "  2 unsettled payload(s) on the bus — down leaves them un-answered (warn, not blocking)",
    ].join("\n") + "\n",
  );
});

test("plan text: an unnamed team, kill-self wording and the clear-policy poll label (tap-team-stop.sh L2058, L2072, L2086)", () => {
  const text = renderPlanText({
    verb: "shutdown",
    team: "",
    registryPolicy: "clear",
    selection: noSelection(),
    teammateSessions: [],
    selfSession: "solo",
    selfPresent: true,
    keepSelf: false,
    seatmap: [],
    selfmap: [{ session: "solo", handle: "solo", paneId: "%1", rowSession: "solo", serverEpoch: "7", expected: "solo" }],
    nokill: [{ handle: "carol", reason: "poll" }],
    sparemap: [],
    unsettled: 0,
    paneCount: () => 1,
  });
  expect(text).toBe(
    [
      "tap team shutdown: plan for team '(unnamed)'",
      "  kill session solo                     (1 pane)  seats: solo  [SELF — killed last]",
      "  retained poll (unregister only): carol (poll)",
    ].join("\n") + "\n",
  );
});

test("plan text: --only spare lines carry the complement qualifier (tap-team-stop.sh L2113-2114)", () => {
  const text = renderPlanText({
    verb: "down",
    team: "alpha",
    registryPolicy: "suspend",
    selection: { mode: "--only", except: [], only: ["carol"] },
    teammateSessions: [],
    selfSession: "",
    selfPresent: false,
    keepSelf: false,
    seatmap: [],
    selfmap: [],
    nokill: [],
    sparemap: [{ handle: "frank", why: "excepted", session: "" }],
    unsettled: 0,
    paneCount: () => 0,
  });
  expect(text).toBe(
    [
      "tap team down: plan for team 'alpha'",
      "  spared by --only carol (rows unchanged, the complement — not a typed set): frank (excepted)",
    ].join("\n") + "\n",
  );
});

test("dry-run and zero-row lines are the incumbent's exact words (tap-team-stop.sh L1680, L1708, L1715, L1725-1727, L2132)", () => {
  expect(dryRunText("down")).toBe("tap team down: dry-run — nothing killed, registry unchanged");
  expect(zeroRowText("down", "suspend", { dryRun: false })).toBe("tap team down: no agents registered — nothing to stop");
  expect(zeroRowText("shutdown", "suspend", { dryRun: false })).toBe("tap team shutdown: no agents registered — nothing to shut down");
  expect(zeroRowText("shutdown", "clear", { dryRun: true })).toBe("tap team shutdown: dry-run — would delete blank acting registry (no seats)");
  expect(zeroRowText("shutdown", "clear", { dryRun: false, registryPresent: true })).toBe(
    "tap team shutdown: deleted blank acting registry (no seats); next: tap init",
  );
  expect(zeroRowText("shutdown", "clear", { dryRun: false })).toBe("tap team shutdown: no agents registered — nothing to shut down");
});

test("no-seats-matched line names the selection cause per flag (tap-team-stop.sh L1771, L2047; lib.sh L1095-1101)", () => {
  expect(noSeatsMatchedText("down", { mode: "--except", except: ["bob", "carol"], only: [] })).toBe(
    "tap team down: no seats matched after exclusions (excluded: bob, carol)",
  );
  expect(noSeatsMatchedText("down", { mode: "--only", except: [], only: ["bob"] })).toBe(
    "tap team down: no seats matched after selection (--only: bob)",
  );
});

test("receipt JSON keeps the incumbent key order and value semantics (tap-team-stop.sh L1070-1086, L1100)", () => {
  const json = renderStopReceiptJson({
    team: "alpha",
    teammateSessions: ["alpha/bob"],
    selfSession: "alpha/carol",
    selfPresent: true,
    keepSelf: true,
    dryRun: false,
    unsettled: 2,
    registryPolicy: "suspend",
    stoppedSessions: ["alpha/bob"],
    refusedSessions: [],
    refusedHandles: ["erin"],
    retainedPoll: ["carol"],
    pendingSelfKill: "",
    excludedHandles: ["frank"],
    sparedSessions: ["alpha/bob"],
  });
  expect(json).toBe(
    '{"team":"alpha","killed_sessions":["alpha/bob"],"stopped_sessions":["alpha/bob"],"refused_sessions":[],"refused_handles":["erin"],"retained_poll":["carol"],"excluded_handles":["frank"],"spared_sessions":["alpha/bob"],"self_session":"alpha/carol","pending_self_kill":null,"kept_self":true,"dry_run":false,"unsettled_payloads":2,"registry_policy":"suspend","partial":true}',
  );
  const out = JSON.parse(json) as Record<string, unknown>;
  expect(Object.keys(out)).toEqual([
    "team",
    "killed_sessions",
    "stopped_sessions",
    "refused_sessions",
    "refused_handles",
    "retained_poll",
    "excluded_handles",
    "spared_sessions",
    "self_session",
    "pending_self_kill",
    "kept_self",
    "dry_run",
    "unsettled_payloads",
    "registry_policy",
    "partial",
  ]);
});

test("receipt JSON: dry-run mirrors the kill plan into both session lists, self appended when not kept (tap-team-stop.sh L1058-1073)", () => {
  const out = JSON.parse(
    renderStopReceiptJson({
      team: "alpha",
      teammateSessions: ["alpha/bob"],
      selfSession: "alpha/carol",
      selfPresent: true,
      keepSelf: false,
      dryRun: true,
      unsettled: 0,
      registryPolicy: "clear",
    }),
  ) as Record<string, unknown>;
  expect(out.killed_sessions).toEqual(["alpha/bob", "alpha/carol"]);
  expect(out.stopped_sessions).toEqual(["alpha/bob", "alpha/carol"]);
  const kept = JSON.parse(
    renderStopReceiptJson({
      team: "alpha",
      teammateSessions: ["alpha/bob"],
      selfSession: "alpha/carol",
      selfPresent: true,
      keepSelf: true,
      dryRun: true,
      unsettled: 0,
      registryPolicy: "clear",
    }),
  ) as Record<string, unknown>;
  expect(kept.killed_sessions).toEqual(["alpha/bob"]);
});

test("receipt JSON: empty team/self/pending render as null; partial tracks refusals only (tap-team-stop.sh L1071, L1079-1080, L1085)", () => {
  const out = JSON.parse(
    renderStopReceiptJson({
      team: "",
      teammateSessions: [],
      selfSession: "",
      selfPresent: false,
      keepSelf: false,
      dryRun: false,
      unsettled: 0,
      registryPolicy: "none",
      refusedSessions: ["alpha/bob"],
    }),
  ) as Record<string, unknown>;
  expect(out.team).toBeNull();
  expect(out.self_session).toBeNull();
  expect(out.pending_self_kill).toBeNull();
  expect(out.partial).toBe(true);
});

test("receipt JSON: recovery keys are appended last only when recovery is pending (tap-team-stop.sh L1088-1099)", () => {
  const json = renderStopReceiptJson({
    team: "alpha",
    teammateSessions: [],
    selfSession: "",
    selfPresent: false,
    keepSelf: false,
    dryRun: false,
    unsettled: 0,
    registryPolicy: "clear",
    recoveryPath: "/tmp/recovery/self-row-abc",
  });
  expect(json.endsWith(
    ',"recovery_pending":true,"recovery_path":"/tmp/recovery/self-row-abc","recovery_hint":"registry row not restored; the captured row is retained at recovery_path"}',
  )).toBe(true);
  expect(renderStopReceiptJson({
    team: "",
    teammateSessions: [],
    selfSession: "",
    selfPresent: false,
    keepSelf: false,
    dryRun: false,
    unsettled: 0,
    registryPolicy: "clear",
  }),
  ).not.toContain("recovery");
});

test("receipt JSON escapes non-ASCII like python ensure_ascii, surrogate pairs included (fsatomic.ts L54-68; _tap_team_stop_emit_json L1100)", () => {
  const json = renderStopReceiptJson({
    team: "",
    teammateSessions: [],
    selfSession: "",
    selfPresent: false,
    keepSelf: false,
    dryRun: false,
    unsettled: 0,
    registryPolicy: "clear",
    recoveryPath: "/tmp/self-row-café-🔒",
  });
  expect(json).toBe(
    '{"team":null,"killed_sessions":[],"stopped_sessions":[],"refused_sessions":[],"refused_handles":[],"retained_poll":[],"excluded_handles":[],"spared_sessions":[],"self_session":null,"pending_self_kill":null,"kept_self":false,"dry_run":false,"unsettled_payloads":0,"registry_policy":"clear","partial":false,"recovery_pending":true,"recovery_path":"/tmp/self-row-caf\\u00e9-\\ud83d\\udd12","recovery_hint":"registry row not restored; the captured row is retained at recovery_path"}',
  );
  const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
  expect(keys[keys.length - 1]).toBe("recovery_hint");
  expect(keys.slice(-3)).toEqual(["recovery_pending", "recovery_path", "recovery_hint"]);
});

test("self note carries kept, refused and next wordings (tap-team-stop.sh L2698-2711)", () => {
  expect(selfNote({ selfSession: "alpha/carol", selfPresent: true, keepSelf: true })).toBe(" (kept self 'alpha/carol')");
  expect(selfNote({ selfSession: "alpha/carol", selfPresent: true, selfAuthRefused: true })).toBe(
    " (self 'alpha/carol' REFUSED — an unselected seat shares it)",
  );
  expect(selfNote({ selfSession: "alpha/carol", selfPresent: true })).toBe(" (self 'alpha/carol' next)");
  expect(selfNote({ selfSession: "alpha/carol", selfPresent: false })).toBe("");
});

test("receipt text lines match each policy arm (tap-team-stop.sh L2781-2799)", () => {
  expect(renderReceiptLines({
    verb: "shutdown",
    registryPolicy: "clear",
    registryPresent: true,
    killedCount: 2,
    selfNote: " (kept self 'alpha/carol')",
    pollN: 0,
    refusedCount: 0,
  })).toEqual(["tap team shutdown: killed 2 teammate session(s), cleared registry (kept self 'alpha/carol')"]);
  expect(renderReceiptLines({
    verb: "shutdown",
    registryPolicy: "clear",
    registryPresent: false,
    killedCount: 0,
    selfNote: " (self 'alpha/carol' next)",
    pollN: 0,
    refusedCount: 0,
  })).toEqual(["tap team shutdown: killed 0 teammate session(s), deleted registry (self 'alpha/carol' next)"]);
  expect(renderReceiptLines({
    verb: "down",
    registryPolicy: "suspend",
    registryPresent: true,
    killedCount: 1,
    selfNote: "",
    pollN: 2,
    refusedCount: 2,
  })).toEqual([
    "tap team down: stopped 1 teammate session(s), suspended their seats",
    "tap team down: retained 2 poll seat(s) unchanged",
    "tap team down: 1 stopped, 2 refused — the team is now partially down",
  ]);
  expect(renderReceiptLines({
    verb: "reset-stop",
    registryPolicy: "none",
    registryPresent: true,
    killedCount: 1,
    selfNote: "",
    pollN: 0,
    refusedCount: 0,
  })).toEqual(["tap team reset-stop: stopped 1 teammate session(s)"]);
});

test("the partially-down correction lines carry the self-kill suffixes (tap-team-stop.sh L2985, L3027)", () => {
  expect(partiallyDownLine("down", 1, 2, "self-refused")).toBe(
    "tap team down: 1 stopped, 2 refused — the team is now partially down (self kill refused: an unselected seat shares that session)",
  );
  expect(partiallyDownLine("down", 1, 2, "self-failed")).toBe(
    "tap team down: 1 stopped, 2 refused — the team is now partially down (self kill failed)",
  );
});

test("spare receipt lines attribute the union with per-cause notes (tap-team-stop.sh L2829-2864)", () => {
  const except = { mode: "--except" as const, except: ["bob"], only: [] };
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: except,
    excludedHandles: ["bob", "carol"],
    sparedRows: 2,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: spared 2 seat(s) by --except: bob (spared: bob, carol)"]);
  // Nothing beyond the typed list: no redundant tail.
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: { mode: "--except" as const, except: ["bob", "carol"], only: [] },
    excludedHandles: ["carol", "bob"],
    sparedRows: 2,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: spared 2 seat(s) by --except: bob, carol"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: except,
    excludedHandles: ["bob", "carol"],
    sparedRows: 1,
    keepSelf: true,
    keepSelfRows: 1,
  })).toEqual(["tap team down: spared 2 seat(s) by --except: bob (includes --keep-self) (spared: bob, carol)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: except,
    excludedHandles: ["bob", "carol", "late1"],
    sparedRows: 1,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: spared 3 seat(s) by --except: bob (includes 2 registered late) (spared: bob, carol, late1)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: except,
    excludedHandles: ["bob", "carol", "late1"],
    sparedRows: 1,
    keepSelf: true,
    keepSelfRows: 1,
  })).toEqual(["tap team down: spared 3 seat(s) by --except: bob (includes --keep-self) (includes 1 registered late) (spared: bob, carol, late1)"]);
  const only = { mode: "--only" as const, except: [], only: ["bob"] };
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: only,
    excludedHandles: ["carol", "dave"],
    sparedRows: 2,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: spared 2 seat(s) by --only bob — every other seat (spared: carol, dave)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: only,
    excludedHandles: ["solo"],
    sparedRows: 0,
    keepSelf: true,
    keepSelfRows: 1,
  })).toEqual(["tap team down: --only bob matched every seat; 1 spared by --keep-self (spared: solo)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: only,
    excludedHandles: ["solo", "late1"],
    sparedRows: 0,
    keepSelf: true,
    keepSelfRows: 1,
  })).toEqual(["tap team down: --only bob matched every seat at plan time; 2 spared (1 by --keep-self, 1 registered late) (spared: solo, late1)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: only,
    excludedHandles: ["solo", "late1"],
    sparedRows: 0,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: --only bob matched every seat at plan time; 2 spared (2 registered late) (spared: solo, late1)"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: only,
    excludedHandles: [],
    sparedRows: 0,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual(["tap team down: --only bob matched every seat — none spared"]);
  expect(renderSpareReceiptLines({
    verb: "down",
    selection: { mode: "--except", except: [], only: [] },
    excludedHandles: [],
    sparedRows: 0,
    keepSelf: false,
    keepSelfRows: 0,
  })).toEqual([]);
});

test("exit code is truthful: restore failure, refusals or unrecorded events each force 1 (tap-team-stop.sh L3121-3123)", () => {
  expect(stopExitCode({ restoreFailed: false, refusedCount: 0, unrecordedCount: 0 })).toBe(0);
  expect(stopExitCode({ restoreFailed: true, refusedCount: 0, unrecordedCount: 0 })).toBe(1);
  expect(stopExitCode({ restoreFailed: false, refusedCount: 1, unrecordedCount: 0 })).toBe(1);
  expect(stopExitCode({ restoreFailed: false, refusedCount: 0, unrecordedCount: 2 })).toBe(1);
});
