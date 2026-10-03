// Port of crew-relaunch.test.sh's ordering arm (tap-odt1d.1 lineage): a real
// crew replacement must yield its readiness wait to finished durable siblings.
// The crew hook drives the REAL relaunchCrew against a live fixture pane on a
// private tmux server; only the census/classifier/output seams are mocked. The
// ordering claim is the property under test: the durable sibling's receipt line
// is written while the crew verification (~1.1s of replacement polling) is
// still pending, and the crew line follows it.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relaunch, parseOptions, type Member } from "../src/launcher/relaunch";
import { relaunchCrew, seats, teamContext } from "../src/crew-lifecycle";
import { withLaunchSignals } from "../src/launcher/transaction";
import { loadGlobalRegistry } from "../src/index-home";

const savedEnv: Array<[string, string | undefined]> = [];
type LaunchRejection = { code?: number; detail?: string };
const savedCwd = process.cwd();
let fixtureRoot: string | null = null;
let socket: string | null = null;
let realTmux: string | null = null;

afterAll(() => {
  if (socket && realTmux) Bun.spawnSync([realTmux, "-S", socket, "kill-server"]);
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(savedCwd);
});

let fixtureState: { ctx: ReturnType<typeof teamContext>; all: Record<string, Record<string, unknown>> } | null = null;

/** One private server, one enrolled team, two crew panes: crew-a idles through
 * its replacement; crew-die's replacement dies instantly. */
function fixture() {
  if (fixtureState) return fixtureState;
  const base = process.env.TMUX_TMPDIR;
  if (!base) throw new Error("run through runtime/bun/test/run.sh (TMUX_TMPDIR pins a short tmux socket path)");
  for (const key of ["TMUX_TMPDIR", "PATH", "TAP_TMUX_SOCKET_PATH", "TAP_INDEX_HOME", "TAP_LAUNCH_SHELL", "TAP_HOME", "TAP_JSON"]) {
    savedEnv.push([key, process.env[key]]);
  }
  fixtureRoot = realpathSync(mkdtempSync(join(base, "crew-relaunch-")));
  const demo = join(fixtureRoot, "Demo");
  mkdirSync(join(demo, ".tap", "bus"), { recursive: true });
  const bin = join(fixtureRoot, "bin");
  mkdirSync(bin, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", demo]);
  realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("tmux not on PATH");
  socket = join(fixtureRoot, "tmux.sock");
  // Same login-shell and harness contracts the shell suite pinned: the fixture
  // shell keeps the isolated PATH through -lic; codex idles so the replacement
  // is a stable new process — unless its row hands it CODEX_DIE, in which case
  // the replacement dies and the relaunch must refuse as unverifiable.
  const sh = join(bin, "sh");
  writeFileSync(sh, '#!/bin/sh\nPATH="' + bin + ':$PATH"; export PATH\nif [ "${1:-}" = -lic ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n');
  const codex = join(bin, "codex");
  writeFileSync(codex, '#!/bin/sh\n[ "${CODEX_DIE:-}" = 1 ] && exit 3\nexec sleep 600\n');
  chmodSync(sh, 0o755);
  chmodSync(codex, 0o755);
  // The module spawns bare `tmux`, so the PATH shim intercepts it. Env-gated
  // port of the shell fixture's shim: while CREW_LATE_SIGNAL_PID is set, the
  // second `#{session_name}` read SIGINTs the test process — the late
  // synchronous observation the late-signal arm needs. Otherwise pass-through.
  const tmuxShim = join(bin, "tmux");
  writeFileSync(tmuxShim, "#!/usr/bin/env bash\n"
    + 'if [ "${1:-}" = -S ]; then [ "$2" = "' + socket + '" ] || exit 99; shift 2; fi\n'
    + 'if [ -n "${CREW_LATE_SIGNAL_PID:-}" ] && [ "${*: -1}" = \'#{session_name}\' ]; then\n'
    + '  printf \'read\\n\' >> "$CREW_LATE_SIGNAL_COUNT"\n'
    + '  if [ "$(wc -l < "$CREW_LATE_SIGNAL_COUNT" | tr -d \' \')" = 2 ]; then\n'
    + "    kill -INT \"$CREW_LATE_SIGNAL_PID\"\n"
    + "    sleep .1\n"
    + "  fi\n"
    + "fi\n"
    + 'exec "' + realTmux + '" -S "' + socket + '" "$@"\n');
  chmodSync(tmuxShim, 0o755);

  // The pane inherits the SERVER's environment, so the fixture PATH must be in
  // place before the session exists; TAP_TMUX_SOCKET_PATH routes the module's
  // own tmux calls to the same private server.
  process.env.PATH = bin + ":" + process.env.PATH;
  process.env.TAP_TMUX_SOCKET_PATH = socket;
  process.env.TAP_LAUNCH_SHELL = sh;
  process.env.TAP_INDEX_HOME = join(fixtureRoot, "index");
  delete process.env.TAP_JSON;
  delete process.env.TAP_HOME;
  const index = process.env.TAP_INDEX_HOME!;
  mkdirSync(index, { recursive: true });
  const spawn = (args: string[]) => Bun.spawnSync([realTmux!, "-S", socket!, ...args]);
  spawn(["new-session", "-d", "-s", "Demo/lead", "-c", demo]);
  spawn(["new-window", "-d", "-t", "Demo/lead", "-n", "crew-a", "-c", demo, "exec sleep 600"]);
  spawn(["new-window", "-d", "-t", "Demo/lead", "-n", "crew-die", "-c", demo, "exec sleep 600"]);
  const paneId = spawn(["display-message", "-p", "-t", "Demo/lead:crew-a", "#{pane_id}"]).stdout.toString().trim();
  const diePaneId = spawn(["display-message", "-p", "-t", "Demo/lead:crew-die", "#{pane_id}"]).stdout.toString().trim();
  expect(paneId).toMatch(/^%/);
  expect(diePaneId).toMatch(/^%/);

  const crewRow = (pane: string, env: Record<string, string>) => ({
    status: "active", delivery: "pane", harness: "codex", pane_id: pane,
    session: "Demo/lead", registered_at: "t", crew: true, model: "gpt-test", permissions: "bypass",
    harness_env: env, passthrough: [], passthrough_from_config: false, preset: null, cwd: demo,
  });
  const registry = join(demo, ".tap", "team-registry.json");
  writeFileSync(registry, JSON.stringify({
    schema: "0.20",
    team: { name: "Demo" },
    seats: {
      "crew-a": crewRow(paneId, {}),
      "crew-die": crewRow(diePaneId, { CODEX_DIE: "1" }),
    },
  }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { Demo: { root: demo, registry_location: registry, state: "registered" } },
  }));

  process.chdir(demo);
  const ctx = teamContext("Demo", false);
  const all = seats(ctx) as Record<string, Record<string, unknown>>;
  fixtureState = { ctx, all };
  return fixtureState;
}

test("completed durable sibling reports while real crew verification is pending", async () => {
  const { ctx, all } = fixture();
  // crew-a FIRST: a serialized batch must fail this test (the slow crew seat
  // runs ahead of the durable sibling and its receipt line), not sail through
  // on accidental ordering.
  const members: Member[] = [
    { team: "Demo", handle: "crew-a", root: ctx.root, row: all["crew-a"]!, team_doc: {} },
    { team: "Demo", handle: "durable", root: ctx.root, row: { harness: "codex" }, team_doc: {} },
  ];
  let crewFinished = false;
  let siblingWhileCrewPending = false;
  const output: string[] = [];
  const code = await relaunch(parseOptions(["--harness", "codex", "--team", "Demo"]), {
    context: () => ({ team: "Demo", caller_pane: "", caller: { state: "outside", detail: "fixture" } }),
    load: loadGlobalRegistry,
    classify: () => members.map(member => ({ member, status: "active", reason: "", pane: member.row.pane_id ?? "" })),
    prepare: value => value,
    run: async () => ({ code: 0 }),
    color: false,
    crew: async member => {
      await relaunchCrew(ctx, all, member.handle, "");
      crewFinished = true;
      return { code: 0 };
    },
    write: text => {
      output.push(text);
      if (text === "● Demo/durable\n") siblingWhileCrewPending = !crewFinished;
    },
  });
  expect(code).toBe(0);
  expect(crewFinished).toBe(true);
  expect(siblingWhileCrewPending).toBe(true);
  expect(output).toEqual([
    "Relaunching 2 active codex seats on team Demo\n",
    "● Demo/durable\n",
    "● Demo/crew-a\n",
  ]);
}, 20000);

test("a replacement that never stabilizes refuses instead of reporting success", async () => {
  const { ctx, all } = fixture();
  let failure: { code: number; reason: string } | null = null;
  const code = await relaunch(parseOptions(["Demo/crew-die"]), {
    context: () => ({ team: "Demo", caller_pane: "", caller: { state: "outside", detail: "fixture" } }),
    load: loadGlobalRegistry,
    classify: () => {
      const member: Member = { team: "Demo", handle: "crew-die", root: ctx.root, row: all["crew-die"]!, team_doc: {} };
      return [{ member, status: "active", reason: "", pane: member.row.pane_id ?? "" }];
    },
    prepare: value => value,
    run: async () => ({ code: 0 }),
    color: false,
    crew: async member => {
      try {
        await relaunchCrew(ctx, all, member.handle, "");
        return { code: 0 };
      } catch (error) {
        failure = { code: (error as { code?: number }).code ?? 1, reason: (error as Error).message };
        return failure;
      }
    },
    write: () => {},
  });
  // The respawned process dies instantly, so no stable replacement can be
  // observed: the relaunch must refuse (replacement_unverified, code 7), not
  // report the seat replaced while the pane sits dead.
  expect(failure).not.toBeNull();
  expect(failure!.code).toBe(7);
  expect(failure!.reason).toContain("no stable new process was observed");
  expect(code).toBe(1);
}, 20000);

test("cancellation reports before and after effect accurately", async () => {
  const { ctx, all } = fixture();
  const pane = all["crew-a"]!.pane_id as string;
  const pid = () => Bun.spawnSync([realTmux!, "-S", socket!, "display-message", "-p", "-t", pane, "#{pane_pid}"]).stdout.toString().trim();
  const before = pid();
  // Aborted before the effect: code 130, the pane untouched, and the report
  // must say nothing was replaced — not a post-effect claim.
  const pre = new AbortController();
  pre.abort();
  let preError: LaunchRejection | null = null;
  try { await relaunchCrew(ctx, all, "crew-a", "", { signal: pre.signal }); } catch (error) { preError = error as LaunchRejection; }
  expect(preError?.code).toBe(130);
  expect(preError?.detail).toContain("nothing was replaced");
  expect(pid()).toBe(before);
  // Aborted once the effect landed (the respawned pid appears): still 130,
  // but the report must own that the replacement state is unverified.
  const post = new AbortController();
  const pending = relaunchCrew(ctx, all, "crew-a", "", { signal: post.signal });
  const timer = setInterval(() => { if (pid() !== before) post.abort(); }, 20);
  let postError: LaunchRejection | null = null;
  try { await pending; } catch (error) { postError = error as LaunchRejection; } finally { clearInterval(timer); }
  expect(postError?.code).toBe(130);
  expect(postError?.detail).toContain("replacement state unverified");
  expect(pid()).not.toBe(before);
}, 20000);

test("a signal queued by late synchronous observation prevents respawn", async () => {
  const { ctx, all } = fixture();
  const pane = all["crew-a"]!.pane_id as string;
  const pid = () => Bun.spawnSync([realTmux!, "-S", socket!, "display-message", "-p", "-t", pane, "#{pane_pid}"]).stdout.toString().trim();
  const before = pid();
  // The PATH tmux shim SIGINTs this process during the second `#{session_name}`
  // read; withLaunchSignals turns the queued signal into an abort that the
  // relaunch must honor BEFORE any effect — the pane keeps its process.
  process.env.CREW_LATE_SIGNAL_PID = String(process.pid);
  process.env.CREW_LATE_SIGNAL_COUNT = join(fixtureRoot!, "late-signal-count");
  try {
    await withLaunchSignals(async signal => {
      let lateError: LaunchRejection | null = null;
      try { await relaunchCrew(ctx, all, "crew-a", "", { signal }); } catch (error) { lateError = error as LaunchRejection; }
      expect(lateError?.code).toBe(130);
      expect(lateError?.detail).toContain("nothing was replaced");
    });
  } finally {
    delete process.env.CREW_LATE_SIGNAL_PID;
    delete process.env.CREW_LATE_SIGNAL_COUNT;
  }
  expect(pid()).toBe(before);
}, 20000);
