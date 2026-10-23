import { expect, test } from "bun:test";
import {
  US, agentFamilies, bootIdsMatch, buildSnapshot, classifyCommCommand, classifyRow,
  harnessEvidence, isPaneId, observeHarnessPidFromTable, observeProcessHarness,
  observeRows, parsePanes, parsePsTable, parseSessions, pendingReservationExpired,
  sessionPanesFor, serverEpochFromRaw, harnessFamily,
} from "../src/observe";
import { serverEpochFromRaw as serverEpochFromTmux } from "../src/tmux";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const EPOCH = "1234:5678";
const SRV = `srv:${EPOCH}`;

// ---------------------------------------------------------------------------
// The property the whole slice exists for. refresh.ts:656 records the live
// specimen: a per-seat loop re-gathers the snapshot, so the pane-set
// reconciliation runs against a different world each call and can answer
// differently for the same seat — bash kept `unknown:pane_set_unobservable`
// where a per-row version removed the seat as `session_absent`, deleting a live
// registration on a snapshot artifact.
// ---------------------------------------------------------------------------
test("one snapshot answers identically whether rows arrive together or one at a time", () => {
  const payload = {
    sessions_text: `t\t${EPOCH}\t1\nother\t${EPOCH}\t\n`,
    panes_text: [
      `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0`,
      `t\tt:0.1\t%2\tcodex\t4002\t${EPOCH}\t0`,
      `other\tother:0.0\t%5\tclaude\t4005\t${EPOCH}\t0`,
    ].join("\n") + "\n",
    ps_text: "4001 4001 4001 claude claude\n4002 4002 4002 codex codex\n4005 4005 4005 claude claude\n",
    sessions_rc: 0, panes_rc: 0, ps_rc: 0,
    rows: [
      { key: "a", status: "active", pane: "t:0.0", pane_id: "%1", session: "t", harness: "claude" },
      { key: "b", status: "active", pane: "t:0.1", pane_id: "%2", session: "t", harness: "codex" },
      { key: "c", status: "active", pane: "other:0.0", pane_id: "%5", session: "other", harness: "claude" },
      { key: "d", status: "active", pane: "gone:0.0", pane_id: "%9", session: "gone", harness: "claude" },
    ],
  };
  const batch = observeRows(payload);
  const oneAtATime = payload.rows.map(row => observeRows({ ...payload, rows: [row] })[0]);
  expect(oneAtATime).toEqual(batch);
  expect(batch[0]).toBe(["a", "active", "", "t:0.0", "%1", "claude", "1"].join(US));
});

test("an unobservable probe is unknown, never gone — the polarity that keeps live seats", () => {
  const row = { status: "active", pane: "t:0.0", pane_id: "%1", session: "t", harness: "claude" };
  const base = { sessions_text: `t\t${EPOCH}\t\n`, sessions_rc: 0, ps_rc: 0, ps_text: "" };

  // panes unreadable => unknown:pane_set_unobservable, NOT gone.
  const unreadable = buildSnapshot({ ...base, panes_text: "", panes_rc: 1 });
  expect(classifyRow(row, unreadable)).toBe(["unknown", "pane_set_unobservable", "", "", "", ""].join(US));

  // One malformed row poisons the whole session's pane set rather than being
  // skipped: judging a seat against a surviving subset is the same defect.
  const poisoned = buildSnapshot({ ...base, panes_rc: 0, panes_text: `t\tt:0.0\t%1\n` });
  expect(classifyRow(row, poisoned)).toBe(["unknown", "pane_set_unobservable", "", "", "", ""].join(US));

  // A genuinely absent session IS gone — the polarity is not blanket caution.
  const absent = buildSnapshot({ ...base, panes_rc: 0, panes_text: `t\tt:0.0\t%1\tclaude\t1\t${EPOCH}\t0\n` });
  expect(classifyRow({ ...row, session: "nope", pane: "nope:0.0", pane_id: "%9" }, absent))
    .toBe(["gone", "session_absent", "", "", "", ""].join(US));
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
test("sessions parse: rc, shape, epoch agreement and the empty/unobservable split", () => {
  expect(parseSessions("", 1, null).mode).toBe("unobservable");
  expect(parseSessions("", 0, null).mode).toBe("empty");
  const ok = parseSessions(`t\t${EPOCH}\t1\nother\t${EPOCH}\t\n`, 0, null);
  expect(ok.mode).toBe("ok");
  expect(ok.sharedEpoch).toBe(SRV);
  expect(ok.sessions.get("t")).toEqual({ epoch: SRV, attached: "1" });
  expect(ok.sessions.get("other")).toEqual({ epoch: SRV, attached: "" });
  // A snapshot spanning two servers has no single truth to classify against.
  expect(parseSessions(`t\t1:1\t\nother\t2:2\t\n`, 0, null).mode).toBe("unobservable");
  for (const bad of [`t\n`, `\t${EPOCH}\t\n`, `t\t\t\n`, `t\t:bad:\t\n`, `t\t${EPOCH}\t1\textra\n`]) {
    expect(parseSessions(bad, 0, null).mode).toBe("unobservable");
  }
});

test("pane rows: every malformed shape marks its session, and a blank name lands on the sentinel", () => {
  const good = `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0`;
  const ok = parsePanes(`${good}\n`, 0, null);
  expect(sessionPanesFor(ok.bySession, ok.mode, "t", SRV)).toHaveLength(1);
  for (const bad of [
    `t\tt:0.0\t%1`,                                   // truncated
    `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\tEXTRA`,    // extra field
    `t\t\t%1\tclaude\t4001\t${EPOCH}\t0`,                // no address
    `t\tt:0.0\tNOTPANE\tclaude\t4001\t${EPOCH}\t0`,      // not a pane id
    `t\tt:0.0\t%1\t\t4001\t${EPOCH}\t0`,                 // no command
    `t\tt:0.0\t%1\tclaude\tPID\t${EPOCH}\t0`,            // non-numeric pid
    `t\tt:0.0\t%1\tclaude\t4001\tnope\t0`,               // unparseable epoch
  ]) {
    const parsed = parsePanes(`${bad}\n${good}\n`, 0, null);
    expect(sessionPanesFor(parsed.bySession, parsed.mode, "t", SRV)).toBeNull();
  }
  // A blank session name records under "": invisible to by-name lookups,
  // poison to a scoped snapshot.
  const blank = parsePanes(`\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n${good}\n`, 0, null);
  expect(blank.bySession.has("")).toBe(true);
  expect(sessionPanesFor(blank.bySession, blank.mode, "t", SRV)).toHaveLength(1);
  // Unscoped it is harmless; scoped it must fail the whole snapshot closed.
  const scoped = buildSnapshot({ panes_rc: 0, sessions_rc: 0, ps_rc: 1, session_scope: "t", panes_text: `\tt:0.9\t%9\tclaude\t9\t${EPOCH}\t0\n${good}\n`, sessions_text: `t\t${EPOCH}\t\n` });
  expect(scoped.panesMode).toBe("unobservable");
  const clean = buildSnapshot({ panes_rc: 0, sessions_rc: 0, ps_rc: 1, session_scope: "t", panes_text: `${good}\n`, sessions_text: `t\t${EPOCH}\t\n` });
  expect(clean.panesMode).toBe("ok");
});

test("an empty pane list is unobservable, not an empty success", () => {
  // REACHABLE BY API, NOT BY THE PARSER. parsePanes never creates a key with an
  // empty array — every bySession.set follows a push — so today's production
  // path cannot produce this. But sessionPanesFor is EXPORTED, so a future
  // caller can hand it one, and the Python it twins collapses absent and empty
  // into a single `if not rows:`.
  //
  // WHAT THIS ARM DOES AND DOES NOT DO, measured rather than assumed: it pins
  // the behavior, and it discriminates NOTHING today. Both guards were mutated
  // — `rows.length === 0` dropped from the head, and the tail's
  // `out.length ? out : null` weakened to `out` — and this arm stayed green
  // under each, because the two are redundant with one another and an empty
  // input reaches `null` either way. It is a characterization arm, not a
  // detector, and it earns its place only by pinning the contract for a future
  // caller and a future edit that removes BOTH.
  //
  // A reviewer made the general correction on clear_fence: "unreachable from
  // today's writer" is a survey of today's callers, not a bound on the inputs.
  expect(sessionPanesFor(new Map([["t", []]]), "ok", "t", SRV)).toBeNull();
  expect(sessionPanesFor(new Map(), "ok", "t", SRV)).toBeNull();
  // The same emptiness after epoch filtering is also null, never [].
  const stale = parsePanes(`t\tt:0.0\t%1\tclaude\t1\t9:9\t0\n`, 0, null);
  expect(sessionPanesFor(stale.bySession, stale.mode, "t", SRV)).toBeNull();
});

test("pane epoch disagreement inside a session makes the set unobservable", () => {
  const parsed = parsePanes(`t\tt:0.0\t%1\tclaude\t1\t${EPOCH}\t0\nt\tt:0.1\t%2\tclaude\t2\t9:9\t0\n`, 0, null);
  expect(sessionPanesFor(parsed.bySession, parsed.mode, "t", SRV)).toBeNull();
  expect(sessionPanesFor(parsed.bySession, parsed.mode, "absent", SRV)).toBeNull();
});

test("ps table keeps the command's internal spacing and rejects non-numeric leading columns", () => {
  const table = parsePsTable([
    "4001 4001 4001 claude /usr/local/bin/claude  --flag  x",
    "  4002   4002   4002   codex   codex serve  ",
    "bad row here ignored",
    "4003 4003 -1 bash -bash",
  ].join("\n"));
  expect(table.get("4001")).toEqual(["4001", "4001", "claude", "/usr/local/bin/claude  --flag  x"]);
  expect(table.get("4002")).toEqual(["4002", "4002", "codex", "codex serve"]);
  expect(table.has("bad")).toBe(false);
  expect(table.get("4003")).toEqual(["4003", "-1", "bash", "-bash"]);
});

test("epoch and boot predicates twin their lib.sh counterparts", () => {
  expect(serverEpochFromRaw(EPOCH, null)).toBe(SRV);
  // Zero generations are digits like any other — a live server can be 0:0.
  expect(serverEpochFromRaw("0:0", null)).toBe("srv:0:0");
  for (const bad of ["", "a:b", ":12", "12:", "1:2:3", "12", "abc", "900:10a", " 900:100"]) expect(serverEpochFromRaw(bad, null)).toBeNull();
  // A present-but-empty pin wins over parsing — it is an override, not a default.
  expect(serverEpochFromRaw(EPOCH, "")).toBeNull();
  expect(serverEpochFromRaw("garbage", "srv:pinned")).toBe("srv:pinned");

  // LOCKSTEP: observe.ts and tmux.ts each carry a serverEpochFromRaw (char-scan
  // vs regex) with no shared source. The raw grammar must stay identical in both,
  // so one corpus runs over the twin (whose ungrammatical answer is "" rather
  // than null, and whose override is read from env rather than passed — those
  // contracts are each site's own and are pinned at their call sites).
  for (const [raw, expected] of [["0:0", "srv:0:0"], [EPOCH, SRV], ["garbage", null]] as const) {
    expect(serverEpochFromTmux(raw, {}), `tmux twin of ${JSON.stringify(raw)}`).toBe(expected ?? "");
  }
  for (const bad of ["", "a:b", ":12", "12:", "1:2:3", "12", "abc", "900:10a", " 900:100"]) {
    expect(serverEpochFromTmux(bad, {}), `tmux twin rejects ${JSON.stringify(bad)}`).toBe("");
  }

  expect(bootIdsMatch("boot:1", "boot:1", "", false, false)).toBe(true);
  expect(bootIdsMatch("", "boot:1", "", false, false)).toBe(false);
  expect(bootIdsMatch("boot:1", "", "", false, false)).toBe(false);
  // Legacy tolerance is 5s, and only when the legacy id is in play.
  expect(bootIdsMatch("boot:995", "boot:1000", "boot:998", false, false)).toBe(true);
  expect(bootIdsMatch("boot:900", "boot:1000", "boot:998", false, false)).toBe(false);
  expect(bootIdsMatch("boot:995", "boot:1000", "boot:998", true, false)).toBe(false);
  expect(bootIdsMatch("boot:995", "boot:1000", "boot:998", true, true)).toBe(true);
  expect(bootIdsMatch("boot:x", "boot:1000", "boot:998", false, false)).toBe(false);

  const names = new Set(["live"]);
  expect(pendingReservationExpired("gone", "2026-09-15T07:00:00Z", true, names, 1789459200)).toBe(true);
  expect(pendingReservationExpired("gone", "2026-09-15T07:59:30Z", true, names, 1789459200)).toBe(false);
  expect(pendingReservationExpired("live", "2026-09-15T07:00:00Z", true, names, 1789459200)).toBe(false);
  // tmux failed: absence is not evidence of absence.
  expect(pendingReservationExpired("gone", "2026-09-15T07:00:00Z", false, names, 1789459200)).toBe(false);
  for (const bad of ["", "not-a-stamp", "2026-09-15 07:00:00", "2026-13-01T00:00:00Z", "2026-09-15T07:00:00"]) {
    expect(pendingReservationExpired("gone", bad, true, names, 1789459200)).toBe(false);
  }
});

test("pane ids are % plus digits, nothing else", () => {
  for (const good of ["%0", "%12", "%999"]) expect(isPaneId(good)).toBe(true);
  for (const bad of ["", "%", "1", "%a", "%1a", "pane", "%-1", "% 1"]) expect(isPaneId(bad)).toBe(false);
});

// ---------------------------------------------------------------------------
// Harness evidence — the process-GROUP rule, not a descendant walk
// ---------------------------------------------------------------------------
test("a background descendant cannot attest a live harness; the foreground group leader can", () => {
  const families = ["claude", "codex"];
  // 4060's pgid (4059) is not its own pid, so it is a background descendant
  // wearing an agent name. 4070 leads its own group and legitimately attests.
  const table = parsePsTable([
    "4005 4005 4060 bash -bash",
    "4060 4059 4060 claude /x/claude --background",
    "4007 4007 4070 bash -bash",
    "4070 4070 4070 claude /x/claude --foreground",
  ].join("\n"));
  expect(observeProcessHarness("4005", table, true, families)).toEqual({ state: "observed", family: "" });
  expect(observeProcessHarness("4007", table, true, families)).toEqual({ state: "observed", family: "claude", pid: "4070" });
  // A failed or absent probe is unobservable, never "no harness".
  expect(observeProcessHarness("4005", table, false, families)).toEqual({ state: "unobservable", family: "" });
  expect(observeProcessHarness("9999", table, true, families)).toEqual({ state: "unobservable", family: "" });
  expect(observeProcessHarness("4005", null, true, families)).toEqual({ state: "unobservable", family: "" });
  expect(observeHarnessPidFromTable("4007", table, true, families)).toBe(`observed${US}claude`);
  expect(observeHarnessPidFromTable("9999", table, true, families)).toBe(`unobservable${US}`);
});

test("observation confirms an attested expectation but never mints one", () => {
  const families = ["claude", "codex"];
  const table = parsePsTable("4001 4001 4001 claude claude\n");
  // Empty expected: a repairable write-boundary omission, not a wildcard and
  // not a positive mismatch.
  expect(harnessEvidence("", "claude", "4001", table, true, families)).toEqual({ state: "unattested", family: "" });
  expect(harnessEvidence("claude", "claude", "4001", table, true, families)).toEqual({ state: "alive", family: "claude" });
  expect(harnessEvidence("claude", "codex", "4001", table, true, families)).toEqual({ state: "mismatch", family: "codex" });
  expect(harnessEvidence("claude", "less", "4001", table, true, families)).toEqual({ state: "exited", family: "less" });
  // Unsupported pane command falls through to the pid path.
  expect(harnessEvidence("claude", "node", "4001", table, true, families)).toEqual({ state: "alive", family: "claude" });
  expect(harnessEvidence("claude", "node", "", table, true, families)).toEqual({ state: "unobservable", family: "" });
  expect(harnessEvidence("claude", "node", "4001", table, false, families)).toEqual({ state: "unobservable", family: "" });
});

test("a native Claude version command confirms the bound family without process inspection", () => {
  const root = mkdtempSync(join(tmpdir(), "native-claude-"));
  const versions = join(root, ".local/share/claude/versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, "2.1.296"), "fixture", { mode: 0o755 });
  const env = { HOME: root };
  const families = ["claude", "codex"];
  try {
    expect(harnessEvidence("claude", "2.1.296", "4001", null, false, families, env))
      .toEqual({ state: "alive", family: "claude" });
    expect(harnessEvidence("", "2.1.296", "4001", null, false, families, env).state).toBe("unattested");
    expect(harnessEvidence("codex", "2.1.296", "4001", null, false, families, env).state).toBe("mismatch");
    for (const command of ["2.1.297", ["..", "2.1.296"].join("/"), "2.1.296-extra", "node"]) {
      expect(harnessEvidence("claude", command, "4001", null, false, families, env).state).toBe("unobservable");
    }
    expect(harnessEvidence("claude", "bash", "4001", null, false, families, env).state).toBe("exited");
    chmodSync(join(versions, "2.1.296"), 0o644);
    expect(harnessEvidence("claude", "2.1.296", "4001", null, false, families, env).state).toBe("unobservable");
  } finally { removeScratchTree(root); }
});

test("the roster keeps an attested native Claude seat active when ps cannot run", () => {
  const root = mkdtempSync(join(tmpdir(), "native-claude-roster-"));
  const versions = join(root, ".local/share/claude/versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, "2.1.296"), "fixture", { mode: 0o755 });
  try {
    const payload = { sessions_text: `t\t${EPOCH}\t1\n`, sessions_rc: 0,
      panes_text: `t\tt:0.0\t%1\t2.1.296\t4001\t${EPOCH}\t0\n`, panes_rc: 0, ps_rc: 127,
      rows: [{ status: "active", pane: "t:0.0", pane_id: "%1", session: "t", harness: "claude" }] };
    expect(observeRows(payload, { HOME: root })).toEqual([["active", "", "t:0.0", "%1", "claude", "1"].join(US)]);
  } finally { removeScratchTree(root); }
});

test("command classification reads argv words and path segments, and survives an unbalanced quote", () => {
  const families = ["claude", "codex"];
  // Both quote cases answer "", for DIFFERENT reasons, and I asserted "claude"
  // for both before checking. Balanced: shlex yields the single word
  // `claude --x`, whose basename matches no family. Unbalanced: shlex raises,
  // the caller falls back to a whitespace split, and the word keeps its quote
  // (`"claude`). Two paths, one answer — which is why neither case can stand
  // in for the other.
  expect(classifyCommCommand("bash", 'sh -c "claude --x"', families)).toBe("");
  expect(classifyCommCommand("bash", 'sh -c "claude --x', families)).toBe("");
  // An unquoted argv word still resolves, so the "" above is about quoting
  // rather than about argv scanning being broken.
  expect(classifyCommCommand("bash", "sh -c claude", families)).toBe("claude");
  expect(classifyCommCommand("bash", "/opt/claude-wrapper/bin/run", families)).toBe("claude");
  expect(classifyCommCommand("bash", "-bash", families)).toBe("");

});

test("the family list comes from the environment so roster and N=1 cannot drift", () => {
  expect(agentFamilies({} as NodeJS.ProcessEnv)).toContain("claude");
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "  alpha   beta " } as NodeJS.ProcessEnv)).toEqual(["alpha", "beta"]);
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "" } as NodeJS.ProcessEnv)).toContain("codex");
});

// ---------------------------------------------------------------------------
// classify_row branches that do not depend on the pane set
// ---------------------------------------------------------------------------
test("stored status, poll delivery and reservation expiry short-circuit before observation", () => {
  const snap = buildSnapshot({ sessions_rc: 1, panes_rc: 1, ps_rc: 1, now_ts: 1789459200 });
  expect(classifyRow({ status: "active", delivery: "poll", pane: "t:0.0" }, snap))
    .toBe(["active", "stored_status", "", "", "", ""].join(US));
  expect(classifyRow({ status: "retired", pane: "t:0.0" }, snap))
    .toBe(["retired", "stored_status", "", "", "", ""].join(US));
  expect(classifyRow({ status: "suspended", status_reason: "server_restarted", pane: "t:0.0" }, snap))
    .toBe(["offline", "server_restarted", "", "", "", ""].join(US));
  expect(classifyRow({ status: "active" }, snap))
    .toBe(["unknown", "designated_pane_missing", "", "", "", ""].join(US));
  const withSessions = buildSnapshot({ sessions_rc: 0, sessions_text: "", panes_rc: 1, ps_rc: 1, now_ts: 1789459200 });
  expect(classifyRow({ status: "pending", session: "gone", registered_at: "2026-09-15T07:00:00Z" }, withSessions))
    .toBe(["expired", "reservation_expired", "", "", "", ""].join(US));
});

test("an incapable seat reads present-but-incapable before any recovery resolution", () => {
  const snap = buildSnapshot({ sessions_rc: 1, panes_rc: 1, ps_rc: 1 });
  expect(classifyRow({ status: "suspended", status_reason: "incapable", pane: "t:0.0" }, snap))
    .toBe(["suspended", "incapable", "", "", "", ""].join(US));
  // Even with its session and one matching pane alive, the mark stands on its
  // own: the arm outranks the recovery ladder and returns no live evidence.
  const solo = buildSnapshot({ sessions_rc: 0, sessions_text: `s\t${EPOCH}\t\n`, panes_rc: 0, ps_rc: 0,
    ps_text: "4001 4001 4001 claude claude\n",
    panes_text: `s\ts:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n` });
  expect(classifyRow({ status: "suspended", status_reason: "incapable", harness: "claude", session: "s" }, solo))
    .toBe(["suspended", "incapable", "", "", "", ""].join(US));
  // A poll-delivered incapable row keeps its stored-state answer, and every
  // other suspended reason still reports its stored pair (pre-existing arms).
  expect(classifyRow({ status: "suspended", status_reason: "incapable", delivery: "poll", pane: "t:0.0" }, snap))
    .toBe(["suspended", "stored_status", "", "", "", ""].join(US));
  expect(classifyRow({ status: "suspended", status_reason: "session_stopped", pane: "t:0.0" }, snap))
    .toBe(["suspended", "stored_status", "", "", "", ""].join(US));
});

test("a recovering seat reports its recovery, and resolves only an unambiguous pane", () => {
  const rec = { status: "suspended", status_reason: "server_restarted", harness: "claude", session: "s" };
  const ps = "4001 4001 4001 claude claude\n4002 4002 4002 claude claude\n";
  const solo = buildSnapshot({ sessions_rc: 0, sessions_text: `s\t${EPOCH}\t\n`, panes_rc: 0, ps_rc: 0, ps_text: ps,
    panes_text: `s\ts:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n` });
  expect(classifyRow(rec, solo)).toBe(["unbound", "server_restarted", "s:0.0", "%1", "claude", ""].join(US));
  // Two panes: which one is the seat? Refuse rather than guess.
  const duo = buildSnapshot({ sessions_rc: 0, sessions_text: `s\t${EPOCH}\t\n`, panes_rc: 0, ps_rc: 0, ps_text: ps,
    panes_text: `s\ts:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\ns\ts:0.1\t%2\tclaude\t4002\t${EPOCH}\t0\n` });
  expect(classifyRow(rec, duo)).toBe(["offline", "server_restarted", "", "", "", ""].join(US));
  // Every probe failure a recovering seat hits reports server_restarted, not
  // the probe's own reason.
  const blind = buildSnapshot({ sessions_rc: 1, panes_rc: 1, ps_rc: 1 });
  expect(classifyRow(rec, blind)).toBe(["offline", "server_restarted", "", "", "", ""].join(US));
});

test("a recorded address naming a different pane refuses instead of resolving", () => {
  const snap = buildSnapshot({
    sessions_rc: 0, sessions_text: `t\t${EPOCH}\t\n`, panes_rc: 0, ps_rc: 0,
    ps_text: "4001 4001 4001 claude claude\n",
    panes_text: `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n`,
  });
  // The window moved under the seat: the address is live but is a different
  // pane. Not death, and not this pane.
  expect(classifyRow({ status: "active", pane: "t:0.0", pane_id: "%7", session: "t", harness: "claude" }, snap))
    .toBe(["unknown", "address_rebound", "", "", "", ""].join(US));
  // Pane id recorded, address absent from the set entirely.
  expect(classifyRow({ status: "active", pane: "t:9.9", pane_id: "%7", session: "t", harness: "claude" }, snap))
    .toBe(["unknown", "designated_pane_missing", "", "", "", ""].join(US));
  // Address only, and it resolves.
  expect(classifyRow({ status: "active", pane: "t:0.0", session: "t", harness: "claude" }, snap))
    .toBe(["active", "", "t:0.0", "%1", "claude", ""].join(US));
});

test("a recorded pane absent from a readable current shared session is gone", () => {
  const base = { sessions_rc: 0, sessions_text: `t\t${EPOCH}\t1\n`, panes_rc: 0, ps_rc: 1,
    panes_text: `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n` };
  const row = { status: "active", session: "t", pane: "t:9.9", pane_id: "%7", row_epoch: SRV };
  expect(classifyRow(row, buildSnapshot(base)).split(US).slice(0, 2)).toEqual(["gone", "pane_absent"]);
  // A session-only scan cannot exclude this ID having moved to another session.
  expect(classifyRow(row, buildSnapshot({ ...base, session_scope: "t" })).split(US).slice(0, 2))
    .toEqual(["unknown", "designated_pane_missing"]);
  for (const patch of [{ row_epoch: "" }, { pane_id: "" }, { pane_id: "bad" }])
    expect(classifyRow({ ...row, ...patch }, buildSnapshot(base)).split(US)[0]).toBe("unknown");
  expect(classifyRow({ ...row, row_epoch: "srv:old:epoch" }, buildSnapshot(base)).split(US)[0]).toBe("offline");
  expect(classifyRow(row, buildSnapshot({ ...base, panes_rc: 1 })).split(US)[0]).toBe("unknown");
  expect(classifyRow({ ...row, pane: "t:0.0" }, buildSnapshot(base)).split(US).slice(0, 2)).toEqual(["unknown", "address_rebound"]);
});

test("a recorded pane visible in another session is a conflict, never gone", () => {
  const base = { sessions_rc: 0, sessions_text: `t\t${EPOCH}\t1\nother\t${EPOCH}\t0\n`, panes_rc: 0, ps_rc: 1,
    panes_text: `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\nother\tother:0.0\t%7\tclaude\t4007\t${EPOCH}\t0\n` };
  for (const session of ["t", "absent"])
    expect(classifyRow({ status: "active", session, pane: `${session}:9.9`, pane_id: "%7", row_epoch: SRV }, buildSnapshot(base)).split(US).slice(0, 2))
      .toEqual(["unknown", "pane_session_conflict"]);
});

test("a missing pane never turns an active launching marker into gone", () => {
  const snap = buildSnapshot({ sessions_rc: 0, sessions_text: `t\t${EPOCH}\t1\n`, panes_rc: 0, ps_rc: 1,
    panes_text: `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n` });
  expect(classifyRow({ status: "active", status_reason: "launching", session: "t", pane: "t:9.9", pane_id: "%7", row_epoch: SRV }, snap).split(US).slice(0, 2))
    .toEqual(["unknown", "designated_pane_missing"]);
});

test("epoch and boot staleness are offline; an unreadable one is unknown", () => {
  const base = {
    sessions_rc: 0, sessions_text: `t\t${EPOCH}\t\n`, panes_rc: 0, ps_rc: 0,
    ps_text: "4001 4001 4001 claude claude\n",
    panes_text: `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\n`,
  };
  const row = { status: "active", pane: "t:0.0", pane_id: "%1", session: "t", harness: "claude" };
  const snap = buildSnapshot(base);
  expect(classifyRow({ ...row, row_epoch: "srv:9:9" }, snap))
    .toBe(["offline", "server_epoch_stale", "", "", "", ""].join(US));
  expect(classifyRow({ ...row, row_epoch: SRV }, snap))
    .toBe(["active", "", "t:0.0", "%1", "claude", ""].join(US));
  const booted = buildSnapshot({ ...base, now_boot: "boot:1000", legacy_boot: "boot:998" });
  expect(classifyRow({ ...row, row_boot: "boot:900" }, booted))
    .toBe(["offline", "boot_id_stale", "", "", "", ""].join(US));
  const unbooted = buildSnapshot({ ...base, now_boot: "" });
  expect(classifyRow({ ...row, row_boot: "boot:900" }, unbooted))
    .toBe(["unknown", "boot_id_unobservable", "", "", "", ""].join(US));
});

test("a keyed row is prefixed with its key and an unkeyed row is not", () => {
  const payload = {
    sessions_rc: 1, panes_rc: 1, ps_rc: 1,
    rows: [{ key: "seat-a", status: "retired" }, { status: "retired" }],
  };
  const [keyed, unkeyed] = observeRows(payload);
  expect(keyed).toBe(["seat-a", "retired", "stored_status", "", "", "", ""].join(US));
  expect(unkeyed).toBe(["retired", "stored_status", "", "", "", ""].join(US));
});

// ---------------------------------------------------------------------------
// FOUR PARITY DEFECTS the reviewer found by running the deleted
// Python against this port, row for row. Every one is the same mistake: a
// Python primitive re-implemented by hand instead of matched. Slice 1 shipped
// this exact class once already (a hand-rolled Unicode decimal decoder), and
// the remedy is the same — the incumbent's semantics, with a control that
// names the specimen.
// ---------------------------------------------------------------------------

test("F2: a backslash inside double quotes cannot manufacture a harness family", () => {
  const families = ["claude", "codex"];
  // Python's shlex keeps a backslash before an ordinary letter inside double
  // quotes; dropping it spelled `co\dex` as `codex`. The family match is an
  // AUTHORIZATION input — `evaluateHarnessEvidence` turns it into `alive` — so
  // a tokenizer that invents letters hands out attestation.
  expect(classifyCommCommand("node", 'node "co\\dex"', families)).toBe("");
  expect(classifyCommCommand("node", 'node "cla\\ude"', families)).toBe("");
  // The escapes Python DOES honor inside double quotes — before the escape
  // character and before the quote character — stay honored. Both of these
  // produce a token that is not a bare family name, so both classify as no
  // family; the point is that the TOKEN matches the incumbent's, verified
  // against `shlex.split` directly:
  //   node "codex\\"        -> ['node', 'codex\\']      (escaped backslash)
  //   node "say \"codex\""   -> ['node', 'say "codex"']  (escaped quote)
  expect(classifyCommCommand("node", 'node "codex\\\\"', families)).toBe("");
  expect(classifyCommCommand("node", 'node "say \\"codex\\""', families)).toBe("");
  // Quote stripping itself still works, which is what makes the two above a
  // statement about escapes rather than about quotes.
  expect(classifyCommCommand("node", 'node "codex"', families)).toBe("codex");
  // And the ordinary positives/negatives are unmoved.
  expect(classifyCommCommand("node", "/usr/bin/codex", families)).toBe("codex");
  expect(classifyCommCommand("node", "codex-exec", families)).toBe("codex");
  expect(classifyCommCommand("node", "foocodex", families)).toBe("");
});

test("F3: a fractional pane id is malformed, exactly as Python str.isdigit() says", () => {
  // `'½'.isdigit()` is False in Python. The old test asked whether the NFKD
  // expansion CONTAINED an ASCII digit, and `½` expands to `1⁄2`. A digit-valued
  // character expands to exactly one ASCII digit; a fraction expands to three.
  expect(isPaneId("%½")).toBe(false);
  expect(isPaneId("%⅓")).toBe(false);
  expect(isPaneId("%1½")).toBe(false);
  // Still digits, because Python says so.
  expect(isPaneId("%1")).toBe(true);
  expect(isPaneId("%²")).toBe(true);
  expect(isPaneId("%①")).toBe(true);
  expect(isPaneId("%")).toBe(false);
  expect(isPaneId("7")).toBe(false);
});

test("F4: year zero is not a reservation that expired in 1900", () => {
  // Date.UTC REMAPS years 0-99 into 1900-1999 rather than rolling them over,
  // and the round-trip validation checked every component except the year. So
  // an invalid stamp became a 126-year-old reservation and expired.
  const names = new Set<string>();
  const now = 1788492467;
  expect(pendingReservationExpired("s", "0000-09-15T07:00:00Z", true, names, now)).toBe(false);
  expect(pendingReservationExpired("s", "0099-09-15T07:00:00Z", true, names, now)).toBe(false);
  // A real old stamp still expires, and a rolled-over component is still refused.
  expect(pendingReservationExpired("s", "2020-01-01T00:00:00Z", true, names, now)).toBe(true);
  expect(pendingReservationExpired("s", "2026-13-15T07:00:00Z", true, names, now)).toBe(false);
  expect(pendingReservationExpired("s", "2020-01-01T00:00:00Z", true, new Set(["s"]), now)).toBe(false);
});

// THIRD INSTANCE of the class F2 and F3 belong to (tap-lrm64), found by the
// census two reviewers defined on tap-amfle AFTER the review
// that fixed the other two: "which selectors were ported from an awk/sed/Python
// class to a JS regex?". It survived F2 and F3 because fixing the instances a
// reviewer found makes the class feel handled.
//
// JS `\s` includes U+FEFF; Python's whitespace does not. Ground truth, measured
// with python3 rather than reasoned about:
//   "﻿".isspace()                          -> False
//   "1 2 3 no﻿de /usr/bin/x".split(None, 4) -> ['1','2','3','no﻿de','/usr/bin/x']
//   "claude﻿codex".split()                  -> ['claude﻿codex']
//   shlex.split("node co﻿dex")              -> ['node', 'co﻿dex']
test("U+FEFF is not whitespace to Python, so it must not split a ps field or a family list", () => {
  // parsePsTable: the fields must not SHIFT. Before the fix this read
  // comm="no" / command="de /usr/bin/x" — columns the incumbent never produced,
  // and comm/command are what the family classifier authorizes from.
  const row = parsePsTable("1 2 3 no﻿de /usr/bin/x").get("1");
  expect(row?.[2]).toBe("no﻿de");
  expect(row?.[3]).toBe("/usr/bin/x");

  // agentFamilies: a BOM-glued value is ONE malformed family in Python, not two
  // valid ones. The configured family set is an authorization input.
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "claude﻿codex" } as NodeJS.ProcessEnv))
    .toEqual(["claude﻿codex"]);
  // The ordinary list still splits on real whitespace.
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "claude codex" } as NodeJS.ProcessEnv))
    .toEqual(["claude", "codex"]);

  // shlexSplit, reached through the classifier: `co﻿dex` is one token and
  // matches no family — the same ANSWER as before the fix but now for the same
  // REASON as Python, which is the property that was actually broken.
  expect(classifyCommCommand("node", "node co﻿dex", ["claude", "codex"])).toBe("");
  // And a BOM glued to a real family name must not be readable as that family.
  expect(classifyCommCommand("co﻿dex", "co﻿dex", ["claude", "codex"])).toBe("");
  // Unmoved: the plain positives.
  expect(classifyCommCommand("node", "/usr/bin/codex", ["claude", "codex"])).toBe("codex");
  expect(classifyCommCommand("node", "codex-exec", ["claude", "codex"])).toBe("codex");
});

// THE FOURTH DIVERGENCE, and the one that matters most — found by the ORACLE
// RUN against the recovered `tap_observe_seats.py`, not by reading the code.
// A reviewer's condition was "the oracle run, not a hand-reasoned
// translation", and the hand-reasoned fix had already missed this:
//
//   ps row "﻿123 123 123 node /usr/bin/codex"
//     incumbent -> unknown / harness_unobservable   ("﻿123".strip() keeps the
//                                                    BOM, so isdigit fails and
//                                                    the row is skipped)
//     port      -> active / codex                   (String.trim() strips the
//                                                    BOM, so a clean pid parses)
//
// The port read LOOSER than the incumbent and MINTED AN ATTESTATION on the
// authorization path. `String.trim()` is the same trap as `\s`, one level up:
// JS trims ECMAScript WhiteSpace, which includes U+FEFF.
test("a ps row led by U+FEFF is refused, not trimmed into a clean pid", () => {
  // The row must not parse at all — skipped, exactly as Python skips it.
  expect(parsePsTable("﻿123 123 123 node /usr/bin/codex").get("123")).toBeUndefined();
  expect(parsePsTable("﻿123 123 123 node /usr/bin/codex").size).toBe(0);
  // Real leading whitespace IS stripped, both sides, so this is not a blanket refusal.
  expect(parsePsTable("  123 123 123 node /usr/bin/codex").get("123")?.[3]).toBe("/usr/bin/codex");
  // And the family env var gets the same treatment: Python's strip leaves it.
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "﻿codex" } as NodeJS.ProcessEnv)).toEqual(["﻿codex"]);
  expect(agentFamilies({ TAP_OBS_HARNESS_FAMILIES: "  codex  " } as NodeJS.ProcessEnv)).toEqual(["codex"]);
});

// The reviewer's W1/W2 -- a correction to MY OWN FIX. I had replaced
// three different Python primitives with one whitespace class and called that
// "one spelling in the tree", as if unification were the goal. It is not:
//
//   shlex.whitespace  = ' \t\r\n'   NARROW. NBSP/thin space stay INSIDE a word.
//   str.split()       = the wide class, which is ALSO what shlex's own
//                       malformed-quote fallback uses.
//   str.splitlines()  = LF CR VT FF FS GS RS NEL LS PS, CRLF once -- not US,
//                       not NBSP, not BOM.
//
// All three measured with python3, not assumed. Both controls below must go the
// OTHER way, because a blanket narrow replacement would pass the first two
// assertions and break them.
test("W1: shlex whitespace is narrow, so NBSP cannot split one word into a family", () => {
  const fam = ["claude", "codex"];
  // ONE word to shlex -- must not attest `codex`.
  expect(classifyCommCommand("node", "node node\u00a0codex", fam)).toBe("");
  expect(classifyCommCommand("node", "node node\u2009codex", fam)).toBe("");
  // CONTROL, and the reason the fix is two rules rather than one: an unbalanced
  // quote makes shlex fall back to the WIDE str.split(), which DOES split on
  // NBSP. Narrowing both sites would red this.
  expect(classifyCommCommand("node", "node 'node\u00a0codex", fam)).toBe("codex");
  // Ordinary ASCII splitting is unmoved.
  expect(classifyCommCommand("node", "node codex", fam)).toBe("codex");
});

test("W2: a ps table splits on splitlines boundaries, so NEL is a row break", () => {
  // NEL separates two rows for the incumbent, so root 123's command must NOT
  // absorb the second row's `codex` tokens. Merging them read active/codex
  // where the incumbent read offline/harness_exited.
  const merged = parsePsTable("123 123 123 node node\u0085124 124 124 codex codex");
  expect(merged.get("123")?.[3]).toBe("node");
  expect(merged.get("124")?.[3]).toBe("codex");
  // The other splitlines boundaries are boundaries too.
  expect(parsePsTable("1 1 1 a a\u000b2 2 2 b b").size).toBe(2);
  expect(parsePsTable("1 1 1 a a\u001c2 2 2 b b").size).toBe(2);
  expect(parsePsTable("1 1 1 a a\r\n2 2 2 b b").size).toBe(2);
  // CONTROL: US is NOT a splitlines boundary in Python, so it must not split.
  expect(parsePsTable("1 1 1 a a\u001f2 2 2 b b").size).toBe(1);
});

// The reviewer's W3/W4. Two more primitive mismatches, both turning
// the incumbent's offline/harness_exited into active/codex — i.e. both
// BROADENING ATTESTATION, which is the direction this whole class runs in.
// Ground truth measured with python3, not reasoned:
//
//   shlex.split('node "codex" \\')  -> ValueError("No escaped character")
//                                     so the incumbent falls back to
//                                     command.split() and '"codex"' stays
//                                     quoted, matching no family
//   shlex.split('node \\\\')        -> ['node', '\\']  (an ESCAPED backslash is
//                                     fine and must stay fine)
//   os.path.basename('/tmp/codex/') -> ''       (Node's path.basename -> 'codex')
//   os.path.basename('/tmp/codex')  -> 'codex'
test("W3: an unfinished escape takes the whole-command fallback, not a partial tokenization", () => {
  const fam = ["claude", "codex"];
  // A trailing backslash raises in Python, so the quoted token survives quoted.
  expect(classifyCommCommand("node", 'node "codex" \\', fam)).toBe("");
  expect(classifyCommCommand("node", "node 'codex' \\", fam)).toBe("");
  // CONTROL: an ESCAPED backslash is not an unfinished escape. Treating every
  // trailing backslash as a failure would red this.
  expect(classifyCommCommand("node", "node codex \\\\", fam)).toBe("codex");
  // CONTROL: the ordinary quoted positive is unmoved.
  expect(classifyCommCommand("node", 'node "codex"', fam)).toBe("codex");
});

test("W4: a trailing slash has no basename in Python, so it is not a family", () => {
  const fam = ["claude", "codex"];
  expect(classifyCommCommand("node", "node /tmp/codex/", fam)).toBe("");
  expect(classifyCommCommand("node", "node /tmp/codex//", fam)).toBe("");
  expect(classifyCommCommand("node", "node codex/", fam)).toBe("");
  // CONTROL: without the trailing slash it still attests, on every caller.
  expect(classifyCommCommand("node", "node /tmp/codex", fam)).toBe("codex");
  expect(harnessFamily("/tmp/codex/", fam)).toBe("");
  expect(harnessFamily("/tmp/codex", fam)).toBe("codex");
});

// A SOURCE-LEVEL TRIPWIRE, in the spirit of team-refresh-parity's (3b-static).
// The defect this guards cannot be reached from a unit test without producing a
// megabyte of real `ps` output, but it is one deleted option away and it
// disables delivery when it fires: a default-sized buffer turns a busy host's
// process table into ENOBUFS, which reads as an unobservable table, which
// refuses a live seat. So assert the invocation carries an explicit bound and
// that there is only ONE invocation to carry it.
test("the ps invocation is single and carries an explicit registry-sized buffer", async () => {
  const src = await Bun.file(new URL("../src/observe.ts", import.meta.url)).text();
  expect(src).toContain("maxBuffer: REGISTRY_MAX_BUFFER");
  // Exactly one spawn of ps in the module: the shared one.
  const spawns = src.match(/spawnSync\("ps"/g) ?? [];
  expect(spawns).toHaveLength(1);
  // And no ROSTER caller re-spells the argv instead of using the shared
  // invocation. The check follows the caller rather than the filename: the
  // roster gather moved out of `verbs/team.ts` into `observe-gather.ts`
  // (tap-fqd3e), and a tripwire naming only the old home would have gone quiet
  // at exactly the moment it moved.
  //
  // Deliberately NOT a whole-tree scan. Four other modules spell `spawnSync("ps"`
  // on main today — `context.ts`, `reset.ts`, `watch-sidecar.ts`,
  // `lock-attribution.ts` — and they are single-pid or
  // attribution lookups, not this table. A guard widened past what it can be
  // true of is a guard someone deletes.
  for (const caller of ["verbs/team.ts", "observe-gather.ts"]) {
    const text = await Bun.file(new URL(`../src/${caller}`, import.meta.url)).text();
    expect([caller, text.includes('spawnSync("ps"')]).toEqual([caller, false]);
  }
  const gatherSrc = await Bun.file(new URL("../src/observe-gather.ts", import.meta.url)).text();
  expect(gatherSrc).toContain("spawnProcessTable");
});

test("dead flag is mandatory and strict; a dead pane needs no cached command or PID", () => {
  const row = "t\tt:0.0\t%1\tclaude\t4001\t" + EPOCH;
  for (const suffix of ["", "\t", "\t2", "\ttrue", "\t0\textra"]) {
    const p = parsePanes(row + suffix + "\n", 0, null);
    expect(sessionPanesFor(p.bySession, p.mode, "t", SRV)).toBeNull();
  }
  for (const pid of ["4001", ""]) {
    const p = parsePanes(`t\tt:0.0\t%1\t\t${pid}\t${EPOCH}\t1\n`, 0, null);
    expect(sessionPanesFor(p.bySession, p.mode, "t", SRV)?.[0]).toMatchObject({ dead: true, command: "", pane_id: "%1", pane_pid: pid });
  }
  for (const row of [`t\tt:0.0\t%1\tclaude\t\t${EPOCH}\t0\n`, `t\tt:0.0\t%1\t\tbad\t${EPOCH}\t1\n`]) {
    const p = parsePanes(row, 0, null);
    expect(sessionPanesFor(p.bySession, p.mode, "t", SRV)).toBeNull();
  }
});

test("poisoned foreign pane records forbid both absence verdicts", () => {
  const base = { sessions_rc: 0, sessions_text: `t\t${EPOCH}\t1\nother\t${EPOCH}\t0\n`, panes_rc: 0, ps_rc: 1 };
  const clean = `t\tt:0.0\t%1\tclaude\t4001\t${EPOCH}\t0\nother\tother:0.0\t%2\tclaude\t4002\t${EPOCH}\t0\n`;
  for (const session of ["t", "absent"]) {
    const row = { status: "active", session, pane: `${session}:9.9`, pane_id: "%7", row_epoch: SRV };
    expect(classifyRow(row, buildSnapshot({ ...base, panes_text: clean })).split(US)[0]).toBe("gone");
    expect(classifyRow(row, buildSnapshot({ ...base, panes_text: clean + "other\ttruncated\n" })).split(US).slice(0, 2))
      .toEqual(["unknown", "pane_set_poisoned"]);
  }
  expect(classifyRow({ status: "active", session: "t", pane: "t:9.9", pane_id: "%7", row_epoch: SRV },
    buildSnapshot({ ...base, panes_text: clean + "t\ttruncated\n" })).split(US).slice(0, 2))
      .toEqual(["unknown", "pane_set_unobservable"]);
});
