// C1 focused controls: per-seat grammar, name-first destructive targeting,
// and the durable matrix. Canonical acting-team selection is tap-1t0h.1.
import { describe, expect, test } from "bun:test";

import {
  canonicalSessionName,
  destructiveSessionTarget,
  DURABLE_MATRIX,
  isPaneId,
  parseBareHandleList,
  parseSeatTarget,
  seatSpared,
  lifecycleDisposition,
  type LifecycleTmux,
  tmuxFateStopsNamedSession,
  crewDismissWouldStopOperatorSession,
  lifecycleFateCatalog,
  matrixHasCrewNamedSessionStop,
  REGISTERED_DURABLE_KEYS,
  snapshotTmux,
} from "../src/lifecycle-target";

function tmuxWorld(opts: {
  sessions: string[];
  panes: Record<string, string>;
}): LifecycleTmux {
  return {
    hasSession: (name) => opts.sessions.includes(name),
    paneSession: (id) => opts.panes[id] ?? null,
    sessionPaneIds: (name) => Object.entries(opts.panes).filter(([, s]) => s === name).map(([id]) => id),
  };
}

describe("per-seat grammar", () => {
  test("bare handle takes the acting team; slash is canonical; colon is input-only", () => {
    expect(parseSeatTarget("grok", "demo")).toEqual({
      ok: true, team: "demo", handle: "grok", qualified: false, delimiter: null,
    });
    expect(parseSeatTarget("alpha/grok", "demo")).toEqual({
      ok: true, team: "alpha", handle: "grok", qualified: true, delimiter: "/",
    });
    expect(parseSeatTarget("alpha:grok", "demo")).toEqual({
      ok: true, team: "alpha", handle: "grok", qualified: true, delimiter: ":",
    });
    expect(canonicalSessionName("alpha", "grok")).toBe("alpha/grok");
    expect(canonicalSessionName("alpha", "grok")).not.toContain(":");
  });

  test("mixed or nested delimiters refuse", () => {
    expect(parseSeatTarget("a:b/c", "demo").ok).toBe(false);
    expect(parseSeatTarget("a/b:c", "demo").ok).toBe(false);
    expect(parseSeatTarget("a/b/c", "demo").ok).toBe(false);
  });

  test("--except/--only take bare team-local handles and dedupe", () => {
    expect(parseBareHandleList("a,b,a", "--except")).toEqual({ ok: true, handles: ["a", "b"] });
    expect(parseBareHandleList("alpha/grok", "--only").ok).toBe(false);
    expect(parseBareHandleList("a,", "--except").ok).toBe(false);
    expect(parseBareHandleList("", "--except").ok).toBe(false);
  });

  test("seatSpared polarities never precompute a complement", () => {
    const named = new Set(["a"]);
    expect(seatSpared("a", "except", named)).toBe(true);
    expect(seatSpared("b", "except", named)).toBe(false);
    expect(seatSpared("a", "only", named)).toBe(false);
    expect(seatSpared("b", "only", named)).toBe(true);
    expect(seatSpared("a", "all", named)).toBe(false);
  });
});

describe("destructiveSessionTarget (name-first, bash reason vocabulary)", () => {
  test("isPaneId is percent plus digits", () => {
    expect(isPaneId("%12")).toBe(true);
    expect(isPaneId("%bogus")).toBe(false);
    expect(isPaneId("12")).toBe(false);
  });

  test("authorizes the caller-derived canonical name", () => {
    const tmux = tmuxWorld({ sessions: ["demo/grok"], panes: { "%11": "demo/grok" } });
    expect(destructiveSessionTarget(
      { pane_id: "%11", session: "demo/grok" },
      "demo/grok",
      tmux,
    )).toEqual({ ok: true, session: "demo/grok" });
  });

  test("E2: stored id live on a foreign session while expected name is live", () => {
    const tmux = tmuxWorld({
      sessions: ["team-X/fable", "team-Y/fable"],
      panes: { "%10": "team-Y/fable" },
    });
    expect(destructiveSessionTarget(
      { pane_id: "%10", session: "team-X/fable" },
      "team-X/fable",
      tmux,
    )).toEqual({ ok: false, reason: "pane_live_elsewhere" });
  });

  test("a gone tip does not block name-keyed stop", () => {
    const tmux = tmuxWorld({ sessions: ["demo/grok"], panes: {} });
    expect(destructiveSessionTarget(
      { pane_id: "%11", session: "demo/grok" },
      "demo/grok",
      tmux,
    )).toEqual({ ok: true, session: "demo/grok" });
  });

  test("session_name_gone / pane_identity_missing / unproven mismatch", () => {
    const tmux = tmuxWorld({ sessions: ["demo/grok"], panes: { "%11": "demo/grok" } });
    expect(destructiveSessionTarget(
      { pane_id: "%11", session: "demo/grok" },
      "demo/missing",
      tmux,
    ).ok).toBe(false);
    expect(destructiveSessionTarget(
      { pane_id: "bad", session: "demo/grok" },
      "demo/grok",
      tmux,
    )).toEqual({ ok: false, reason: "pane_identity_missing" });
    expect(destructiveSessionTarget(
      { pane_id: "%11", session: "other/x" },
      "demo/grok",
      tmux,
    )).toEqual({ ok: false, reason: "server_epoch_unproven" });
    const gone = tmuxWorld({ sessions: [], panes: { "%11": "demo/grok" } });
    expect(destructiveSessionTarget(
      { pane_id: "%11", session: "demo/grok" },
      "demo/grok",
      gone,
    )).toEqual({ ok: false, reason: "session_name_gone" });
  });
});

describe("durable matrix", () => {
  test("the four per-seat operations match the ratified strategy table", () => {
    expect(DURABLE_MATRIX.out).toMatchObject({
      scope: "seat", registry: "delete-row", tmux: "none", crews: "none",
    });
    expect(DURABLE_MATRIX.down).toMatchObject({
      scope: "seat", registry: "suspend-rows", tmux: "stop-named-sessions", recovery: "tap-up",
      crews: "consume-d-contract",
    });
    expect(DURABLE_MATRIX.up).toMatchObject({
      scope: "seat", registry: "resume-rows", tmux: "relaunch", crews: "none",
    });
    expect(DURABLE_MATRIX.shutdown).toMatchObject({
      scope: "seat", registry: "delete-row", tmux: "stop-named-sessions",
      crews: "consume-d-contract",
    });
  });

  test("shutdown and out --hard share hard-removal; requested actions stay distinct", () => {
    expect(DURABLE_MATRIX.shutdown).toBe(DURABLE_MATRIX["out-hard"]);
    const stop = lifecycleDisposition("seat", "shutdown");
    const hard = lifecycleDisposition("seat", "out-hard");
    expect(stop.ok).toBe(true);
    expect(hard.ok).toBe(true);
    if (!stop.ok || !hard.ok) return;
    expect(stop.row).toBe(hard.row);
    expect(stop.row.mechanism).toBe("hard-removal");
    expect(stop.action).toBe("shutdown");
    expect(hard.action).toBe("out-hard");
    expect(stop.action).not.toBe(hard.action);
  });

  test("crew out and crew shutdown share dismiss; requested actions stay distinct", () => {
    const out = lifecycleDisposition("crew", "out");
    const stop = lifecycleDisposition("crew", "shutdown");
    expect(out.ok).toBe(true);
    expect(stop.ok).toBe(true);
    if (!out.ok || !stop.ok) return;
    expect(out.row).toBe(stop.row);
    expect(out.row.mechanism).toBe("crew-dismiss");
    expect(out.action).toBe("out");
    expect(stop.action).toBe("shutdown");
    expect(out.action).not.toBe(stop.action);
  });

  test("seat out keeps the process; crew out must not leave an unrostered live crew", () => {
    expect(lifecycleDisposition("seat", "out")).toMatchObject({
      ok: true, action: "out", row: { scope: "seat", tmux: "none" },
    });
    expect(lifecycleDisposition("crew", "out")).toMatchObject({
      ok: true, action: "out", row: { scope: "crew", tmux: "none", registry: "delete-row", crews: "consume-d-contract" },
    });
  });

  test("a mutant that restores stop-named-sessions on crew dismiss would stop the operator session", () => {
    const out = lifecycleDisposition("crew", "out");
    const hard = lifecycleDisposition("crew", "out-hard");
    expect(out.ok).toBe(true);
    expect(hard.ok).toBe(true);
    if (!out.ok || !hard.ok) return;
    expect(out.row.tmux).toBe("none");
    expect(out.row.crews).toBe("consume-d-contract");
    expect(tmuxFateStopsNamedSession(out.row)).toBe(false);
    expect(crewDismissWouldStopOperatorSession(out.row)).toBe(false);
    const mutant = { ...out.row, tmux: "stop-named-sessions" as const };
    expect(tmuxFateStopsNamedSession(mutant)).toBe(true);
    expect(crewDismissWouldStopOperatorSession(mutant)).toBe(true);
    expect(crewDismissWouldStopOperatorSession(DURABLE_MATRIX.shutdown)).toBe(false);
  });

  test("crew up and crew down refuse; owner up never recreates crews", () => {
    const up = lifecycleDisposition("crew", "up");
    const down = lifecycleDisposition("crew", "down");
    expect(up.ok).toBe(false);
    expect(down.ok).toBe(false);
    if (!up.ok) {
      expect(up.errorClass).toBe("usage_error");
      expect(up.detail).toContain("ephemeral");
    }
    if (!down.ok) {
      expect(down.errorClass).toBe("usage_error");
      expect(down.detail).toContain("ephemeral");
    }
    expect(DURABLE_MATRIX.up.crews).toBe("none");
    expect(DURABLE_MATRIX["team-up"].crews).toBe("none");
  });

  test("team-wide verbs keep team scope and do not share seat shutdown's tombstone", () => {
    expect(lifecycleDisposition("team", "down")).toMatchObject({
      ok: true, action: "down", row: { scope: "team", registry: "suspend-rows", recovery: "tap-team-up" },
    });
    expect(lifecycleDisposition("team", "up")).toMatchObject({
      ok: true, action: "up", row: { scope: "team", registry: "resume-rows", tmux: "relaunch", crews: "none" },
    });
    const teamStop = lifecycleDisposition("team", "shutdown");
    const seatStop = lifecycleDisposition("seat", "shutdown");
    expect(teamStop).toMatchObject({
      ok: true, action: "shutdown", row: { scope: "team", registry: "delete-acting-file", recovery: "tap-init" },
    });
    expect(seatStop).toMatchObject({
      ok: true, action: "shutdown", row: { scope: "seat", registry: "delete-row" },
    });
    expect(DURABLE_MATRIX.down.scope).not.toBe(DURABLE_MATRIX["team-down"].scope);
  });

  test("team out has separate plain and hard family fates", () => {
    expect(lifecycleDisposition("team", "out")).toMatchObject({
      ok: true, action: "out", row: { mechanism: "team-out", scope: "team",
        registry: "delete-row", tmux: "none", recovery: "none", crews: "consume-d-contract" },
    });
    expect(lifecycleDisposition("team", "out-hard")).toMatchObject({
      ok: true, action: "out-hard", row: { mechanism: "team-out-hard", scope: "team",
        registry: "delete-row", tmux: "stop-named-sessions", recovery: "none", crews: "consume-d-contract" },
    });
    expect(DURABLE_MATRIX["team-out"]).not.toBe(DURABLE_MATRIX["team-out-hard"]);
    expect(DURABLE_MATRIX["team-out"].registry).not.toBe(DURABLE_MATRIX["team-shutdown"].registry);
  });

  test("matrixHasCrewNamedSessionStop reds a present crew session-stop mutant; the per-row pin does not", () => {
    const catalog = lifecycleFateCatalog();
    expect(matrixHasCrewNamedSessionStop(catalog)).toBe(false);
    const crewRow = catalog.find((row) => row.scope === "crew");
    expect(crewRow).toBeDefined();
    if (!crewRow) return;
    expect(crewDismissWouldStopOperatorSession(crewRow)).toBe(false);

    const mutant = catalog.map((row) => (
      row.scope === "crew" ? { ...row, tmux: "stop-named-sessions" as const } : row
    ));
    expect(matrixHasCrewNamedSessionStop(mutant)).toBe(true);
    const live = lifecycleDisposition("crew", "out");
    expect(live.ok).toBe(true);
    if (live.ok) expect(crewDismissWouldStopOperatorSession(live.row)).toBe(false);
  });

  test("reviewed matrix keys are closed and unique fates have distinct MechanismId values", () => {
    expect([...Object.keys(DURABLE_MATRIX)].sort()).toEqual([...REGISTERED_DURABLE_KEYS].sort());
    expect(Object.keys(DURABLE_MATRIX)).toHaveLength(REGISTERED_DURABLE_KEYS.length);
    const unique = [...new Set(lifecycleFateCatalog())];
    const ids = unique.map((row) => row.mechanism);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// snapshotTmux is the ONE adapter from a pane snapshot to the predicate's tmux
// view. Two callers had written the same three closures by hand and lane T was
// about to write a third, which is how two copies quietly become three that
// disagree. These arms pin the three answers, and the fourth pins the property
// the copies were most likely to lose.
describe("snapshotTmux", () => {
  const snap = {
    panes: [
      { id: "%1", session: "demo/a" },
      { id: "%2", session: "demo/a" },
      { id: "%3", session: "demo/b" },
    ],
  };

  test("answers the predicate's three questions from the snapshot", () => {
    const t = snapshotTmux(snap);
    expect(t.hasSession("demo/a")).toBe(true);
    expect(t.hasSession("demo/gone")).toBe(false);
    expect(t.paneSession("%3")).toBe("demo/b");
    expect(t.sessionPaneIds("demo/a")).toEqual(["%1", "%2"]);
  });

  test("a pane that is not in the snapshot is null, never a guess", () => {
    // `paneSession` feeds the pane-live-elsewhere arm of
    // destructiveSessionTarget. An absent tip must read as gone rather than as
    // "no evidence, carry on" -- returning undefined would make the caller's
    // `?? null` the only thing standing between a missing pane and a kill.
    expect(snapshotTmux(snap).paneSession("%99")).toBeNull();
    expect(snapshotTmux({ panes: [] }).paneSession("%1")).toBeNull();
  });

  test("an empty session name is not a wildcard", () => {
    // Every lookup is an exact string compare. A row whose session string is
    // empty must not match a query for "", and must not make hasSession("")
    // true for a world that has sessions -- that is the shape that turns a
    // missing `expected` into "authorize everything".
    const t = snapshotTmux({ panes: [{ id: "%1", session: "" }] });
    expect(t.hasSession("demo/a")).toBe(false);
    expect(snapshotTmux(snap).hasSession("")).toBe(false);
  });

});
