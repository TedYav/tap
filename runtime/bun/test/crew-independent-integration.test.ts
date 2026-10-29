import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { crewFixture } from "./support/crew-fixture";

function adopted(f: ReturnType<typeof crewFixture>) {
  const ask = f.run(["ask", "claude", "--model", "fixture", "-m", "question"]);
  expect(ask.status, ask.stderr).toBe(0);
  const id = /claude session ([^;]+);/.exec(ask.stderr)?.[1]; expect(id).toBeTruthy();
  const add = f.run(["crew", "add", "claude", "continued", "--model", "fixture", "--resume", id!]);
  expect(add.status, add.stdout + add.stderr).toBe(0);
  expect(f.seats().continued.crew_identity_capture.decision).toBe("accepted");
  return { ...f.seats().continued };
}

// A parent-death helper would kill the crew within its two-second cadence.
test.each(["exit", "relaunch"])("a parent's %s leaves its crew conversation running", async action => {
  const f = crewFixture();
  try {
    const row = adopted(f), parent = f.seats().parent;
    const changed = action === "exit" ? f.tmux("kill-pane", "-t", parent.pane_id)
      : f.tmux("respawn-pane", "-k", "-t", parent.pane_id, "sleep 600");
    expect(changed.status, changed.stderr).toBe(0);
    await Bun.sleep(3200);
    expect(f.read("list-panes", "-a", "-F", "#{pane_id}").split("\n")).toContain(row.pane_id);
    expect(f.seats().continued).toMatchObject({ instance: row.instance, harness_session_id: row.harness_session_id,
      crew_owner: "parent", crew_owner_instance: "parent-one" });
  } finally { await f.close(); }
}, 45000);

test.each([false, true])("refresh retains the crew after private server restart (hard=%s)", async hard => {
  const f = crewFixture();
  try {
    const row = adopted(f);
    f.stopHelpers();
    expect(f.tmux("kill-server").status).toBe(0);
    expect(f.tmux("new-session", "-d", "-s", "other", "sleep 600").status).toBe(0);
    delete f.env.TMUX; delete f.env.TMUX_PANE;
    const refreshed = f.run(["team", "refresh", "--json", ...(hard ? ["--hard"] : [])]);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(f.seats().continued).toEqual(row);
    expect(JSON.parse(refreshed.stdout).trimmed.map((r: { handle: string }) => r.handle)).not.toContain("continued");
  } finally { await f.close(); }
}, 45000);

test("add refuses a retained crew name without replacing its conversation or creating a pane", async () => {
  const f = crewFixture();
  try {
    const row = adopted(f);
    expect(f.tmux("kill-pane", "-t", row.pane_id).status).toBe(0);
    const panes = f.read("list-panes", "-a", "-F", "#{pane_id}");
    const add = f.run(["crew", "add", "claude", "continued", "--model", "fixture"]);
    expect(add.status).not.toBe(0);
    expect(add.stdout + add.stderr).toContain("resume");
    expect(f.seats().continued).toEqual(row);
    expect(f.read("list-panes", "-a", "-F", "#{pane_id}")).toBe(panes);
  } finally { await f.close(); }
}, 45000);

function moveToOwnSession(f: ReturnType<typeof crewFixture>, row: { pane_id: string }) {
  expect(f.tmux("new-session", "-d", "-s", "Adopt/crew-parent", "-n", "placeholder", "sleep 600").status).toBe(0);
  const placeholder = f.read("display-message", "-p", "-t", "Adopt/crew-parent:placeholder", "#{pane_id}");
  expect(f.tmux("move-window", "-s", row.pane_id, "-t", "Adopt/crew-parent:").status).toBe(0);
  expect(f.tmux("kill-pane", "-t", placeholder).status).toBe(0);
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  doc.seats.continued.session = "Adopt/crew-parent";
  doc.seats.continued.pane = f.read("display-message", "-p", "-t", row.pane_id, "#{session_name}:#{window_index}.#{pane_index}");
  writeFileSync(f.registry, JSON.stringify(doc));
}

test.each([
  { args: ["crew", "shutdown", "--owner", "parent"] },
  { args: ["out", "--kill", "parent"] },
  { args: ["team", "down", "--only", "parent", "--yes"] },
])("explicit family shutdown stops a linked crew in its own session: %j", async ({ args }) => {
  const f = crewFixture();
  try {
    const row = adopted(f);
    moveToOwnSession(f, row);
    const stopped = f.run([...args]);
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(f.seats().continued).toBeUndefined();
    expect(f.tmux("list-panes", "-a", "-F", "#{pane_id}").stdout.split("\n")).not.toContain(row.pane_id);
  } finally { await f.close(); }
}, 45000);

test("roster recognizes a crew's retained owner across separate sessions", async () => {
  const f = crewFixture();
  try {
    const row = adopted(f);
    moveToOwnSession(f, row);
    const roster = f.run(["team", "--all"]);
    expect(roster.status, roster.stdout + roster.stderr).toBe(0);
    expect(roster.stdout).toContain("continued");
    expect(roster.stderr).not.toContain("no parent seat");
  } finally { await f.close(); }
}, 45000);

test("one refused legacy helper transition does not block refresh of its siblings", async () => {
  const f = crewFixture();
  try {
    const row = adopted(f);
    expect(f.tmux("set-option", "-p", "-t", row.pane_id, "@tap_crew_lifetime", "unverifiable legacy evidence").status).toBe(0);
    const doc = JSON.parse(readFileSync(f.registry, "utf8"));
    doc.seats.later = { ...row, instance: "later-one", pane_id: "%9999", status: "suspended", harness_session_id: "retained-other-conversation" };
    writeFileSync(f.registry, JSON.stringify(doc));
    const result = f.run(["team", "refresh", "--json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ handle: "continued", reason: "crew_retained:legacy_fence_refused" }),
      expect.objectContaining({ handle: "later" }),
    ]));
    expect(result.stderr).toContain("legacy helper transition refused");
    expect(f.seats().continued).toEqual(row);
    expect(f.read("display-message", "-p", "-t", row.pane_id, "#{pane_id}")).toBe(row.pane_id);
    // This deliberately malformed test binding cannot be parsed by cleanup.
    expect(f.tmux("set-option", "-pu", "-t", row.pane_id, "@tap_crew_lifetime").status).toBe(0);
  } finally {
    const pane = f.seats().continued?.pane_id;
    if (pane) f.tmux("set-option", "-pu", "-t", pane, "@tap_crew_lifetime");
    await f.close();
  }
}, 30000);
