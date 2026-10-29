import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { crewFixture } from "./support/crew-fixture";

const main = resolve(import.meta.dir, "../main.ts");
type Fixture = ReturnType<typeof crewFixture>;
function edit(f: Fixture, fn: (doc: any) => void) {
  const doc = JSON.parse(readFileSync(f.registry, "utf8")); fn(doc); writeFileSync(f.registry, JSON.stringify(doc));
}
function saved(f: Fixture, name: string, owner = "parent", cwd = f.cwd) {
  const id = randomUUID(), dir = join(f.env.CLAUDE_CONFIG_DIR!, "projects/fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd }) + "\n");
  const row = { crew: true, crew_owner: owner, crew_owner_instance: f.seats()[owner].instance,
    instance: `${name}-one`, delivery: "pane", status: "suspended", status_reason: "server_restarted",
    harness: "claude", harness_session_id: id, model: "fixture", permissions: "bypass", cwd,
    harness_env: { ADOPT_FIXTURE: f.root, CLAUDE_CONFIG_DIR: f.env.CLAUDE_CONFIG_DIR!, PATH: f.env.PATH! },
    passthrough: [], harness_tail: [], harness_unset_env: [], session: "Adopt/old", pane: "Adopt/old:1.0", pane_id: "%9999",
    server_epoch: "srv:1:1", server_socket: f.env.TAP_TMUX_SOCKET_PATH! };
  edit(f, doc => { doc.seats[name] = row; }); return row;
}
function panes(f: Fixture) { return f.tmux("list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n").filter(Boolean); }
function asyncRun(f: Fixture, args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe" });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([status, stdout, stderr]) => ({ status, stdout, stderr }));
  return { child, result };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

test("single resume uses the live owner's session, repeats without effects, and explicit relaunch resumes the same id", async () => {
  const f = crewFixture();
  try {
    const old = saved(f, "one"), parent = f.seats().parent;
    const first = f.run(["crew", "resume", "one", "--json"]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const row = f.seats().one;
    expect(row).toMatchObject({ instance: old.instance, harness_session_id: old.harness_session_id,
      crew_owner_instance: parent.instance, session: parent.session, status: "active", status_reason: "",
      crew_identity_capture: { decision: "accepted" } });
    const pid = f.read("display-message", "-p", "-t", row.pane_id, "#{pane_pid}"), count = panes(f).length;
    const repeat = f.run(["crew", "resume", "Adopt/one", "--json"]);
    expect(repeat.status, repeat.stdout + repeat.stderr).toBe(0);
    expect(JSON.parse(repeat.stdout).results[0]).toMatchObject({ outcome: "already_live" });
    expect(panes(f)).toHaveLength(count);
    expect(f.read("display-message", "-p", "-t", row.pane_id, "#{pane_pid}")).toBe(pid);
    const replacement = f.run(["crew", "relaunch", "one", "--resume", "--json"]);
    expect(replacement.status, replacement.stdout + replacement.stderr).toBe(0);
    expect(f.seats().one.harness_session_id).toBe(old.harness_session_id);
    expect(f.seats().one.pane_id).toBe(row.pane_id);
    expect(f.read("display-message", "-p", "-t", row.pane_id, "#{pane_pid}")).not.toBe(pid);
  } finally { await f.close(); }
}, 45000);

test("bulk resume after private server loss preserves each conversation in one offline-owner vessel and explicit owner retirement stops them", async () => {
  const f = crewFixture();
  try {
    const a = saved(f, "a"), b = saved(f, "b");
    expect(f.tmux("kill-server").status).toBe(0);
    delete f.env.TMUX; delete f.env.TMUX_PANE; delete f.env.ADOPT_TTY;
    const result = f.run(["crew", "resume", "--owner", "Adopt/parent", "--json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const rows = f.seats();
    expect(rows.a.harness_session_id).toBe(a.harness_session_id); expect(rows.b.harness_session_id).toBe(b.harness_session_id);
    expect(rows.a.session).toBe(rows.b.session); expect(rows.a.session).not.toBe(rows.parent.session);
    expect(rows.a.crew_owner_instance).toBe(rows.parent.instance);
    expect(rows.a.crew_identity_capture.decision).toBe("accepted"); expect(rows.b.crew_identity_capture.decision).toBe("accepted");
    const stopped = f.run(["out", "Adopt/parent", "--kill", "--json"]);
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(f.seats()).toEqual({}); expect(panes(f)).toEqual([]);
  } finally { await f.close(); }
}, 45000);

test("bulk partial failure preserves the failed row and continues its siblings", async () => {
  const f = crewFixture();
  try {
    saved(f, "a-missing"); const good = saved(f, "b-good");
    edit(f, doc => { delete doc.seats["a-missing"].harness_session_id; });
    const before = f.seats()["a-missing"], count = panes(f).length;
    const result = f.run(["crew", "resume", "--owner", "parent", "--json"]);
    expect(result.status).toBe(1);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; results: Array<{ handle: string; outcome: string; error_class?: string }> };
    expect(receipt.ok).toBe(false);
    expect(receipt.results).toMatchObject([{ handle: "a-missing", error_class: "no_exact_resume_identity" }, { handle: "b-good", outcome: "resumed" }]);
    expect(f.seats()["a-missing"]).toEqual(before); expect(f.seats()["b-good"].harness_session_id).toBe(good.harness_session_id);
    expect(panes(f)).toHaveLength(count + 1);
  } finally { await f.close(); }
}, 30000);

test.each(["owner_replaced", "owner_absent", "recipe_missing", "native_missing", "duplicate"])("resume refusal %s preserves the row and creates no pane", async reason => {
  const f = crewFixture();
  try {
    saved(f, "one");
    edit(f, doc => {
      if (reason === "owner_replaced") doc.seats.parent.instance = "reused-owner";
      if (reason === "owner_absent") delete doc.seats.parent;
      if (reason === "recipe_missing") delete doc.seats.one.model;
      if (reason === "native_missing") doc.seats.one.harness_session_id = randomUUID();
      if (reason === "duplicate") doc.seats.other = { ...doc.seats.one, instance: "other-one" };
    });
    const before = readFileSync(f.registry, "utf8"), count = panes(f).length;
    const result = f.run(["crew", "resume", "one", "--json"]);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    const expectedClass = reason.startsWith("owner_") ? "crew_owner_unidentified" : reason === "recipe_missing" ? "crew_recipe_missing"
      : reason === "duplicate" ? "duplicate_identity_owner" : "no_exact_resume_identity";
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ outcome: "refused", error_class: expectedClass });
    expect(readFileSync(f.registry, "utf8")).toBe(before); expect(panes(f)).toHaveLength(count);
  } finally { await f.close(); }
}, 30000);

test("concurrent resumes create only one new crew process", async () => {
  const f = crewFixture();
  try {
    const old = saved(f, "one"), count = panes(f).length;
    const a = asyncRun(f, ["crew", "resume", "one", "--json"]), b = asyncRun(f, ["crew", "resume", "one", "--json"]);
    const results = await Promise.all([a.result, b.result]);
    expect(results.some(result => result.status === 0), JSON.stringify(results)).toBe(true);
    expect(panes(f)).toHaveLength(count + 1);
    expect(f.seats().one).toMatchObject({ instance: old.instance, harness_session_id: old.harness_session_id, crew_identity_capture: { decision: "accepted" } });
  } finally { await f.close(); }
}, 30000);

test("wrong native capture reports the live partial effect and retains quarantine without a retry", async () => {
  const f = crewFixture();
  try {
    saved(f, "one"); edit(f, doc => { doc.seats.one.harness_env.ADOPT_WRONG_ID = randomUUID(); });
    const count = panes(f).length;
    const result = f.run(["crew", "resume", "one", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ outcome: "started_unverified" });
    expect(f.seats().one.crew_identity_capture.decision).toBe("quarantined");
    expect(panes(f)).toHaveLength(count + 1);
  } finally { await f.close(); }
}, 30000);

test("owner replacement at the final pre-create boundary refuses without a new pane", async () => {
  const f = crewFixture();
  try {
    saved(f, "one"); const old = f.seats().one, count = panes(f).length;
    const barrier = join(f.root, "boundary");
    f.env.TAP_RESET_FENCE_TEST_BARRIER = barrier; f.env.TAP_SCRATCH_ONLY = f.cwd;
    const pending = asyncRun(f, ["crew", "resume", "one", "--json"]);
    const reached = `${barrier}.crew-resume-before-create.reached`, release = `${barrier}.crew-resume-before-create.release`;
    await waitFor(() => existsSync(reached));
    edit(f, doc => { doc.seats.parent.instance = "changed-before-create"; }); writeFileSync(release, "1");
    const result = await pending.result;
    expect(result.status).toBe(1); expect(f.seats().one).toEqual(old); expect(panes(f)).toHaveLength(count);
  } finally { await f.close(); }
}, 30000);

test("repeated owner selection stays in one team and uses separate vessels for offline owners", async () => {
  const f = crewFixture();
  try {
    edit(f, doc => { doc.seats.second = { ...doc.seats.parent, instance: "second-one", pane_id: "", pane: "", status: "suspended", session: "Adopt/second" }; });
    saved(f, "first-child"); saved(f, "second-child", "second");
    const result = f.run(["crew", "resume", "--owner", "parent", "--owner", "Adopt/second", "--json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.seats()["first-child"].session).not.toBe(f.seats()["second-child"].session);
    expect(JSON.parse(result.stdout).results).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

test("dry run validates retained identity without changing rows, locks or panes", async () => {
  const f = crewFixture();
  try {
    saved(f, "one"); const before = readFileSync(f.registry, "utf8"), count = panes(f).length;
    const result = f.run(["crew", "resume", "one", "--dry-run", "--json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ outcome: "would_resume" });
    expect(readFileSync(f.registry, "utf8")).toBe(before); expect(panes(f)).toHaveLength(count);
    expect(existsSync(`${f.registry}.crew-one.lock`)).toBe(false);
  } finally { await f.close(); }
}, 30000);

test("SIGINT after a start retains its evidence and reports later crews untouched", async () => {
  const f = crewFixture();
  try {
    saved(f, "a"); const b = saved(f, "b"), barrier = join(f.root, "interrupt");
    f.env.TAP_RESET_FENCE_TEST_BARRIER = barrier; f.env.TAP_SCRATCH_ONLY = f.cwd;
    const pending = asyncRun(f, ["crew", "resume", "--owner", "parent", "--json"]);
    await waitFor(() => existsSync(`${barrier}.crew-resume-before-create.reached`));
    writeFileSync(`${barrier}.crew-resume-before-create.release`, "1");
    await waitFor(() => existsSync(`${barrier}.crew-resume-after-start.reached`));
    pending.child.kill("SIGINT"); writeFileSync(`${barrier}.crew-resume-after-start.release`, "1");
    const result = await pending.result;
    expect(result.status, result.stdout + result.stderr).toBe(130);
    expect(JSON.parse(result.stdout).results).toMatchObject([{ handle: "a", outcome: "started_unverified" }, { handle: "b", outcome: "untouched" }]);
    expect(f.seats().b).toEqual(b); expect(f.seats().a.launch_id).toBeTruthy();
    edit(f, doc => { doc.seats.a.registered_at = "2020-01-01T00:00:00Z"; });
    const retained = f.seats().a;
    expect(f.tmux("new-session", "-d", "-s", "observer", "sleep 600").status).toBe(0);
    expect(f.tmux("kill-session", "-t", retained.session).status).toBe(0);
    delete f.env.TMUX; delete f.env.TMUX_PANE; delete f.env.ADOPT_TTY;
    for (const flags of [[], ["--hard"]]) {
      const refreshed = f.run(["team", "refresh", "--json", ...flags]);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      expect(f.seats().a).toEqual(retained);
    }
  } finally { await f.close(); }
}, 30000);

test("registry authority relocation before creation leaves the old crew untouched", async () => {
  const f = crewFixture();
  try {
    saved(f, "one"); const old = readFileSync(f.registry, "utf8"), count = panes(f).length, barrier = join(f.root, "authority");
    f.env.TAP_RESET_FENCE_TEST_BARRIER = barrier; f.env.TAP_SCRATCH_ONLY = f.cwd;
    const pending = asyncRun(f, ["crew", "resume", "one", "--json"]);
    await waitFor(() => existsSync(`${barrier}.crew-resume-before-create.reached`));
    const path = join(f.env.TAP_INDEX_HOME!, "global-registry.json"), index = JSON.parse(readFileSync(path, "utf8"));
    const replacement = join(f.cwd, ".tap/relocated.json"); writeFileSync(replacement, old);
    index.teams.Adopt.registry_location = replacement; writeFileSync(path, JSON.stringify(index));
    writeFileSync(`${barrier}.crew-resume-before-create.release`, "1");
    const result = await pending.result;
    expect(result.status).toBe(1); expect(readFileSync(f.registry, "utf8")).toBe(old); expect(panes(f)).toHaveLength(count);
  } finally { await f.close(); }
}, 30000);

test("a retained sibling-worktree cwd resumes after server loss without inventing a team", async () => {
  const f = crewFixture();
  try {
    expect(Bun.spawnSync(["git", "-C", f.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { env: f.env }).exitCode).toBe(0);
    const lane = join(f.root, "lane");
    expect(Bun.spawnSync(["git", "-C", f.cwd, "worktree", "add", "-qb", "lane", lane], { env: f.env }).exitCode).toBe(0);
    const row = saved(f, "one", "parent", lane);
    expect(f.tmux("kill-server").status).toBe(0);
    delete f.env.TMUX; delete f.env.TMUX_PANE; delete f.env.ADOPT_TTY;
    const result = f.run(["crew", "resume", "one", "--json"]);
    expect(result.status, result.stdout + result.stderr + JSON.stringify(f.seats().one) + (existsSync(join(f.root, "hook-one")) ? readFileSync(join(f.root, "hook-one"), "utf8") : "no native hook receipt")).toBe(0);
    expect(f.seats().one).toMatchObject({ cwd: lane, harness_session_id: row.harness_session_id, crew_identity_capture: { decision: "accepted" } });
    expect(existsSync(join(lane, ".tap"))).toBe(false);
  } finally { await f.close(); }
}, 30000);

test("positive machine boot loss permits recovery on a new socket without adopting recycled panes", async () => {
  const f = crewFixture();
  try {
    saved(f, "one"); const originalParent = f.seats().parent.pane_id;
    edit(f, doc => { for (const row of [doc.seats.parent, doc.seats.one]) { row.boot_id = "boot:1"; row.server_socket = "/old-boot/socket"; } });
    const result = f.run(["crew", "resume", "one", "--json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.seats().one.session).not.toBe(f.seats().parent.session);
    expect(f.read("display-message", "-p", "-t", originalParent, "#{pane_id}")).toBe(originalParent);
  } finally { await f.close(); }
}, 30000);
