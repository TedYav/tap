// tap-9rrat: a seat whose harness exited while crew windows hold its tmux session.
// The chooser used to call that session "live" and offer [r]; resume then refused
// "not live". Now the session classifies seat-gone and [r] revives the seat into
// it, in a new window, leaving every crew window running.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifySession, crewPanesIn } from "../src/launcher/observation";
import { describeReviveTier } from "../src/launcher/collision";
import { cmdSessionLaunch } from "../src/launcher/new";
import { exactRevivalIdentity } from "../src/launcher/transaction";
import { createOpenCodeStore, addSession } from "./support/opencode-store";
import { crewLifetimeBinding, processGeneration, reclaimRevivedCrew, reconcileCrewLifetime, survivingCrews, validateCrewLifetimeBinding } from "../src/crew-lifetime";

const original = { ...process.env };
const originalCwd = process.cwd();
const realTmux = Bun.which("tmux")!;
const publicBin = resolve(import.meta.dir, "../../../bin/tap");
const roots: string[] = [];
const sockets: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const socket of sockets.splice(0)) spawnSync(realTmux, ["-L", socket, "kill-server"], { env: process.env, stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "fixture/reviewer";

function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/tap-seat-gone-"));
  roots.push(root);
  const index = join(root, "index"), registry = join(root, "registry.json");
  for (const dir of [index, join(root, ".tap/bus"), join(root, ".config/tap"), join(root, "bin"), join(root, "real")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const socket = `seat-gone-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  sockets.push(socket);
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: join(root, ".tap/bus"), TAP_TMUX_SOCKET: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash",
    PATH: `${root}/bin:${original.PATH}` });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_LOCK_DIR"]) delete process.env[key];
  writeFileSync(join(root, ".bash_profile"), `export PATH='${process.env.PATH}'\n`);
  writeFileSync(join(root, ".config/tap/config.toml"), "version = 3\n");
  // Harness stand-ins: sleep under each harness's name, so tmux reports that command.
  for (const name of ["claude", "opencode"]) {
    if (process.platform === "linux") copyFileSync("/bin/sleep", join(root, "real", name));
    else symlinkSync("/bin/sleep", join(root, "real", name));
  }
  // The seat's claude: records its argv, and fails on demand to exercise rollback.
  writeFileSync(join(root, "bin/claude"), `#!/bin/bash\nprintf '%s\\n' "$@" > '${root}/argv'\n[ -e '${root}/fail' ] && exit 1\nexec '${root}/real/claude' 600\n`);
  chmodSync(join(root, "bin/claude"), 0o755);
  const T = (...args: string[]) => {
    const r = spawnSync(realTmux, ["-L", socket, ...args], { env: process.env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const tap = (args: string[]) => spawnSync("bash", [publicBin, ...args], { cwd: root, env: process.env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
  const doc = () => JSON.parse(readFileSync(registry, "utf8"));
  return { root, registry, T, tap, doc };
}

/** Launch the seat and give it two registered crews: an opencode one and a same-harness claude one.
 * With `arm`, the opencode crew is bound to the seat's harness lifetime and that helper is then
 * lost, as a stray kill leaves it; finally the seat's own pane dies. */
async function seatGoneWithCrews(f: ReturnType<typeof fixture>, arm: false | "lost" | "frozen" = false) {
  const launched = f.tap(["session", "launch", "claude", "reviewer"]);
  expect(launched.status, launched.stdout + launched.stderr).toBe(0);
  const seat = f.doc().seats.reviewer;
  const seatPane = seat.pane_id as string;
  // The recorded conversation exists, so resume can target it by its native id.
  mkdirSync(join(f.root, ".claude/projects/fixture"), { recursive: true });
  writeFileSync(join(f.root, ".claude/projects/fixture", `${seat.harness_session_id}.jsonl`), "{}\n");
  const opencodeCrew = f.T("new-window", "-d", "-t", `=${SESSION}:`, "-P", "-F", "#{pane_id}", `${f.root}/real/opencode 600`);
  const claudeCrew = f.T("new-window", "-d", "-t", `=${SESSION}:`, "-P", "-F", "#{pane_id}", `${f.root}/real/claude 600`);
  const doc = f.doc();
  const crewRow = (harness: string, pane: string, instance: string) => ({ crew: true, crew_owner: "reviewer", crew_owner_instance: seat.instance, harness, session: SESSION, pane_id: pane, instance,
    server_epoch: seat.server_epoch, server_socket: seat.server_socket, status: "active", delivery: "pane" });
  doc.seats["kimi-review"] = crewRow("opencode", opencodeCrew, "kimi-review|0000000000000001");
  doc.seats["claude-review"] = crewRow("claude", claudeCrew, "claude-review|0000000000000002");
  writeFileSync(f.registry, JSON.stringify(doc));
  let old = null;
  if (arm) {
    old = await reconcileCrewLifetime({ team: "fixture", registryPath: f.registry } as never, "reviewer", "kimi-review");
    if (arm === "lost") {
      process.kill(Number(old.helper.pid), "SIGTERM");
      // Async waits let this process reap its exited helper child.
      for (let i = 0; i < 100 && processGeneration(old.helper) === "same"; i++) await Bun.sleep(20);
      expect(processGeneration(old.helper)).toBe("gone");
    } else {
      // Frozen, the live old helper cannot act on the parent's loss until a revival fences it.
      process.kill(Number(old.helper.pid), "SIGSTOP");
    }
  }
  f.T("kill-pane", "-t", seatPane);
  expect(f.T("has-session", "-t", `=${SESSION}`)).toBe("");
  return { seatPane, crews: [opencodeCrew, claudeCrew], old };
}

const panes = (f: ReturnType<typeof fixture>) => f.T("list-panes", "-s", "-t", `=${SESSION}`, "-F", "#{pane_id} #{pane_current_command}").split("\n");

test("a crew-held session with no seat pane classifies seat-gone, never live", async () => {
  const f = fixture();
  const { crews } = await seatGoneWithCrews(f);
  const crewPanes = crewPanesIn(Object.entries(f.doc().seats), SESSION);
  expect([...crewPanes].sort()).toEqual([...crews].sort());
  expect(await classifySession(SESSION, process.env, undefined, { harness: "claude", crewPanes })).toBe("seat-gone");
  // The registered same-harness crew is what would otherwise pass for the seat.
  expect(await classifySession(SESSION, process.env, undefined, { harness: "claude" })).toBe("live");
  // Seatless callers keep the session-level verdict.
  expect(await classifySession(SESSION, process.env)).toBe("live");
}, 60_000);

test("without a terminal, launch names the revive instead of offering an [r] that cannot work", async () => {
  const f = fixture();
  await seatGoneWithCrews(f);
  const result = f.tap(["session", "launch", "claude", "reviewer"]);
  expect(result.status).toBe(2);
  const said = result.stdout + result.stderr;
  expect(said).toContain("claude exited; other windows still hold the session");
  expect(said).toContain("tap session resume reviewer");
  expect(said).not.toContain("not live");
  const preview = f.tap(["session", "resume", "reviewer", "--dry-run"]);
  expect(preview.status, preview.stdout + preview.stderr).toBe(0);
  expect(preview.stderr).toContain(`would revive claude into surviving session ${SESSION} in a new window`);
  expect(preview.stdout + preview.stderr).not.toContain("not live");
}, 90_000);

test("the chooser's [r] revives the seat into its session and keeps every crew window", async () => {
  const f = fixture();
  const { seatPane, crews } = await seatGoneWithCrews(f);
  const asked: string[] = [];
  const written: string[] = [];
  const [out, err] = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
  process.chdir(f.root);
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await cmdSessionLaunch(["claude", "reviewer"], undefined, {
      hasTty: () => true,
      choose: (_verb, question, options) => { asked.push(question, ...options.map(([key, , gloss]) => `${key}: ${gloss}`)); return "r"; },
    });
  } finally { process.stdout.write = out; process.stderr.write = err; }
  const said = written.join("");
  expect(code, said).toBe(0);
  expect(asked[0]).toContain("session name is live");
  expect(asked).toContain(`r: ${describeReviveTier("attach-or-resume")}`);
  expect(said).not.toContain("not live");
  expect(said).toContain(`revived ${SESSION} in a new window`);
  const after = panes(f);
  for (const crew of crews) expect(after.some(line => line.startsWith(`${crew} `))).toBe(true);
  const row = f.doc().seats.reviewer;
  expect(row.status).toBe("active");
  expect(row.session).toBe(SESSION);
  expect(row.pane_id).not.toBe(seatPane);
  expect(crews).not.toContain(row.pane_id);
  expect(after.some(line => line.startsWith(`${row.pane_id} `))).toBe(true);
  // The revival resumes exactly the recorded conversation.
  expect(readFileSync(join(f.root, "argv"), "utf8").split("\n")).toEqual(expect.arrayContaining(["--resume", row.harness_session_id]));
  expect(f.T("display-message", "-p", "-t", `=${SESSION}:`, "#{pane_id}")).toBe(row.pane_id);
}, 90_000);

test("a failed revival removes only its own window; the crews and their session stay", async () => {
  const f = fixture();
  const { crews } = await seatGoneWithCrews(f);
  const before = panes(f);
  writeFileSync(join(f.root, "fail"), "");
  const result = f.tap(["session", "resume", "reviewer"]);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain("not live");
  expect(existsSync(join(f.root, "argv"))).toBe(true);
  // Rollback may finish in the pane-died callback; wait for the revived window to go.
  let after = panes(f);
  for (let i = 0; i < 100 && after.length !== before.length; i++) { Bun.sleepSync(50); after = panes(f); }
  expect(after).toEqual(before);
  for (const crew of crews) expect(after.some(line => line.startsWith(`${crew} `))).toBe(true);
}, 90_000);

test("[r] moves a surviving crew's lifetime to the revived seat, which then ends it on a normal exit", async () => {
  const f = fixture();
  const { crews, old } = await seatGoneWithCrews(f, "lost");
  const crewPane = crews[0]!;
  // Ordinary rearm cannot recover it: the parent it names is gone.
  await expect(reconcileCrewLifetime({ team: "fixture", registryPath: f.registry } as never, "reviewer", "kimi-review"))
    .rejects.toThrow("family pane or server generation changed");
  const result = f.tap(["session", "resume", "reviewer"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("crew kimi-review reclaimed by reviewer");
  const row = f.doc().seats.reviewer;
  const moved = crewLifetimeBinding(crewPane)!;
  expect(moved.token).not.toBe(old!.token);
  expect(moved.ownerPane).toBe(row.pane_id);
  expect(moved.parent.pid).not.toBe(old!.parent.pid);
  expect(moved.child).toEqual(old!.child);
  expect(validateCrewLifetimeBinding(moved)).toBe(true);
  // A sweep of the family now finds the reclaimed binding current, not a foreign generation.
  expect((await reconcileCrewLifetime({ team: "fixture", registryPath: f.registry } as never, "reviewer", "kimi-review")).token).toBe(moved.token);
  // The revived seat's normal exit ends every crew it reclaimed (claude-review too), so the
  // session can empty in the same instant; the server outlives it (exit-empty off), where
  // tmux answers a session-scoped read with "no current target" (seen on tmux 3.5a CI).
  expect(result.stdout).toContain("crew claude-review reclaimed by reviewer");
  process.kill(Number(moved.parent.pid), "SIGTERM");
  const serverPanes = () => {
    const listed = spawnSync(realTmux, ["-L", process.env.TAP_TMUX_SOCKET!, "list-panes", "-a", "-F", "#{pane_id}"], { env: process.env, encoding: "utf8" });
    if (listed.status === 0) return listed.stdout.split("\n");
    // Only a server with no sessions left may read as no panes; any other failure fails the test.
    expect(f.T("list-sessions", "-F", "#{session_name}"), listed.stderr).toBe("");
    return [];
  };
  let alive = true;
  for (let i = 0; i < 150 && alive; i++) { await Bun.sleep(50); alive = serverPanes().some(pane => crews.includes(pane)); }
  expect(alive).toBe(false);
  expect(f.T("list-sessions", "-F", "#{session_name}")).toBe("");
}, 90_000);

/** The public resume, spawned without blocking this process, which must keep reaping helper children. */
async function resumeAsync(f: ReturnType<typeof fixture>) {
  const child = Bun.spawn(["bash", publicBin, "session", "resume", "reviewer"], { cwd: f.root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, status };
}

test("a still-running old supervisor is fenced before the crew moves, and never reaps it afterwards", async () => {
  const f = fixture();
  const { crews, old } = await seatGoneWithCrews(f, "frozen");
  const crewPane = crews[0]!;
  expect(processGeneration(old!.helper)).toBe("same");
  const result = await resumeAsync(f);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("crew kimi-review reclaimed by reviewer");
  for (let i = 0; i < 40 && processGeneration(old!.helper) === "same"; i++) await Bun.sleep(50);
  expect(processGeneration(old!.helper)).toBe("gone");
  // Past the old helper's poll cadence the crew is still running under the revived seat.
  await Bun.sleep(3000);
  expect(panes(f).some(line => line.startsWith(`${crewPane} `))).toBe(true);
  const moved = crewLifetimeBinding(crewPane)!;
  expect(moved.token).not.toBe(old!.token);
  expect(validateCrewLifetimeBinding(moved)).toBe(true);
}, 90_000);

test("reclaim refuses a different seat instance, a changed crew, and an unreadable registry", async () => {
  const f = fixture();
  const { crews } = await seatGoneWithCrews(f, "lost");
  const ctx = { team: "fixture", registryPath: f.registry };
  const [snapshot] = survivingCrews(ctx, "reviewer").filter(crew => crew.crew === "kimi-review");
  expect(snapshot?.crewPane).toBe(crews[0]);
  const result = await resumeAsync(f);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const before = crewLifetimeBinding(crews[0]!)!;
  // A replacement under the same name is another instance: never the crew's parent.
  await expect(reclaimRevivedCrew(ctx, "reviewer", { ...snapshot!, ownerInstance: "reviewer|ffffffffffffffff" })).rejects.toThrow("not the retained instance");
  // A crew changed since the snapshot (or a snapshot of another binding) is not reclaimed.
  await expect(reclaimRevivedCrew(ctx, "reviewer", { ...snapshot!, crewInstance: "kimi-review|ffffffffffffffff" })).rejects.toThrow("changed during the revival");
  await expect(reclaimRevivedCrew(ctx, "reviewer", { ...snapshot!, child: { ...snapshot!.child, start: "0" } })).rejects.toThrow("process changed during the revival");
  await expect(reclaimRevivedCrew(ctx, "reviewer", snapshot!)).rejects.toThrow("supervision changed during the revival");
  // An unbound crew whose pane got a new process after the snapshot is not inherited.
  const [unbound] = survivingCrews(ctx, "reviewer").filter(crew => crew.crew === "claude-review");
  f.T("respawn-pane", "-k", "-t", crews[1]!, `${f.root}/real/claude 600`);
  await expect(reclaimRevivedCrew(ctx, "reviewer", { ...unbound!, binding: null })).rejects.toThrow("process changed during the revival");
  // An unreadable registry authorizes nothing.
  const broken = join(f.root, "broken.json");
  writeFileSync(broken, "{not json");
  expect(() => survivingCrews({ team: "fixture", registryPath: broken }, "reviewer")).toThrow("unreadable");
  await expect(reclaimRevivedCrew({ team: "fixture", registryPath: broken }, "reviewer", snapshot!)).rejects.toThrow("unreadable");
  expect(crewLifetimeBinding(crews[0]!)!.token).toBe(before.token);
}, 90_000);

test("the exact revival gate pins each harness's contract", () => {
  const f = fixture();
  const record = (harness: string, id: string | null) => ({ name: SESSION, harness, cwd: f.root, base: "fixture", tag: "reviewer", index: 1, harness_session_id: id });
  // agy resumes a stored id with --conversation; hermes ignores ids; no stored id is never exact.
  expect(exactRevivalIdentity(record("agy", "agy-conv-1") as never, process.env)).toBe("agy-conv-1");
  expect(() => exactRevivalIdentity(record("hermes", "h-1") as never, process.env)).toThrow("no resumable recorded hermes conversation");
  expect(() => exactRevivalIdentity(record("claude", null) as never, process.env)).toThrow("no resumable recorded claude conversation");
  // A readable OpenCode store that lacks the id refuses; one that has it binds it.
  const data = join(f.root, "xdg");
  mkdirSync(join(data, "opencode"), { recursive: true });
  const db = createOpenCodeStore(join(data, "opencode", "opencode.db"));
  addSession(db, "ses_present", "/tmp/wt");
  db.close();
  const env = { ...process.env, XDG_DATA_HOME: data };
  expect(() => exactRevivalIdentity(record("opencode", "ses_absent") as never, env)).toThrow("has no such session");
  expect(exactRevivalIdentity(record("opencode", "ses_present") as never, env)).toBe("ses_present");
}, 30_000);

test("a refused exact gate changes nothing, not even a live old supervisor", async () => {
  const f = fixture();
  const { crews, old } = await seatGoneWithCrews(f, "frozen");
  rmSync(join(f.root, ".claude/projects"), { recursive: true, force: true });
  const result = await resumeAsync(f);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("no resumable recorded claude conversation");
  expect(processGeneration(old!.helper)).toBe("same");
  expect(crewLifetimeBinding(crews[0]!)!.token).toBe(old!.token);
  expect(panes(f).some(line => line.startsWith(`${crews[0]} `))).toBe(true);
  process.kill(Number(old!.helper.pid), "SIGKILL");
}, 90_000);

test("a session replaced after the resume's check is never revived into", async () => {
  const f = fixture();
  await seatGoneWithCrews(f);
  const barrier = join(f.root, "barrier");
  writeFileSync(`${barrier}.after-entry-guard.release`, "");
  writeFileSync(`${barrier}.holding-mutation-lock.release`, "");
  const child = Bun.spawn(["bash", publicBin, "session", "resume", "reviewer"], { cwd: f.root,
    env: { ...process.env, TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 300 && !existsSync(`${barrier}.pre-mutation.reached`); i++) await Bun.sleep(50);
  expect(existsSync(`${barrier}.pre-mutation.reached`)).toBe(true);
  // A foreign session takes the name: its crew-like window holds it, no seat pane.
  f.T("kill-session", "-t", `=${SESSION}`);
  const foreign = f.T("new-session", "-d", "-s", SESSION, "-P", "-F", "#{pane_id}", `${f.root}/real/opencode 600`);
  writeFileSync(`${barrier}.pre-mutation.release`, "");
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status, stdout + stderr).not.toBe(0);
  expect(stdout + stderr).toContain("changed after the resume checked it");
  expect(panes(f).map(line => line.split(" ")[0])).toEqual([foreign]);
  expect(f.doc().seats.reviewer.pane_id).not.toBe(foreign);
}, 90_000);
