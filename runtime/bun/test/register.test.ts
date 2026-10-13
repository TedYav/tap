import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { acquirePathLock } from "../src/panelock";
import { loadRegistry } from "../src/registry";
import { registerOffline, registerPoll, ensureTeamBlock, warnEnrollFailure, parseRegisterForm } from "../src/verbs/register";
import type { EnrollOutcome } from "../src/register-authority";

const ROOT = join(import.meta.dir, "../../..");

// Public-door fixture: every test drives `bin/tap in ...` (the main.ts
// register|in route) against a sandboxed live-marker world with a fixture
// tmux on PATH. The mock answers the caller-pane identity record, the
// chooser's list-panes/list-sessions gather, and the per-pane extras.
function fixture(opts: { sessions?: boolean; panes?: boolean } = {}) {
  const root = join(tmpdir(), `tap-register-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const index = join(root, "index");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(join(index), { recursive: true });
  mkdirSync(join(home, ".tap"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo), { recursive: true });
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  git(["init", "-q"]);
  git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20", migrated: { at: "2026-01-01T00:00:00Z", backups: {} }, teams: {},
  }));
  const addr = "repo/seat:0.0";
  const epoch = "srv:900:100";
  const tmux = `#!/bin/bash
while [ "\${1:-}" = "-L" ] || [ "\${1:-}" = "-S" ]; do shift 2; done
cmd="\${1:-}"; shift || true
case "\$cmd" in
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in -p) shift ;; -t) target="\$2"; shift 2 ;; *) fmt="\$1"; shift ;; esac
    done
    sock=""
    if [ -n "\${TAP_TMUX_SOCKET_PATH:-}" ]; then sock="\$TAP_TMUX_SOCKET_PATH"
    elif [ -n "\${TAP_TMUX_SOCKET:-}" ]; then sock="\${TMUX_TMPDIR:-/tmp}/tmux-\$(id -u)/\$TAP_TMUX_SOCKET"
    else sock="\${TMUX:-/fake/socket}"; fi
    case "\$fmt" in
      *pane_tty*pane_pid*socket_path*) printf '%%2\\t/dev/t\\trepo/seat\\t900:100\\trepo/seat:0.0\\t4242\\tzsh\\t%s\\t${repo}\\n' "\$sock" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%2\\trepo/seat\\t4242\\tzsh\\t0\\n' ;;
      *pid*start_time*) printf '900:100\\n' ;;
      *pane_id*session_name*pid*start_time*socket_path*) printf '%%2\\trepo/seat\\t900:100\\t%s\\n' "\$sock" ;;
      *pane_id*session_name*pid*start_time*) printf '%%2\\trepo/seat\\t900:100\\n' ;;
      *pane_id*session_name*) printf '%%2\\trepo/seat\\n' ;;
      *pane_id*) printf '%%2\\n' ;;
      *pane_pid*) printf '4242\\n' ;;
      *pane_current_command*) printf 'zsh\\n' ;;
      *pane_current_path*) printf '${repo}\\n' ;;
      *socket_path*)
        if [ -n "\${TAP_TMUX_SOCKET_PATH:-}" ]; then printf '%s\\n' "\$TAP_TMUX_SOCKET_PATH"
        elif [ -n "\${TAP_TMUX_SOCKET:-}" ]; then printf '%s\\n' "\${TMUX_TMPDIR:-/tmp}/tmux-\$(id -u)/\$TAP_TMUX_SOCKET"
        else printf '%s\\n' "\${TMUX:-/fake/socket}"
        fi ;;
      *session_name*window_index*pane_index*) printf 'repo/seat:0.0\\n' ;;
      *) printf '\\n' ;;
    esac ;;
  list-sessions)
${opts.sessions === false ? "    exit 1 ;;" : `    printf 'repo/seat\\t900:100\\t1\\n' ;;`}
  list-panes)
${opts.panes === false ? "    exit 1 ;;" : `    printf 'repo/seat\\trepo/seat:0.0\\t%%2\\tzsh\\t4242\\t900:100\\t0\\n' ;;`}
  *) exit 0 ;;
esac
`;
  writeFileSync(join(bin, "tmux"), tmux);
  chmodSync(join(bin, "tmux"), 0o755);
  const registry = join(repo, ".tap", "team-registry.json");
  const bus = join(repo, ".tap", "bus");
  mkdirSync(bus, { recursive: true });
  const writeRegistry = (doc: Record<string, unknown>) => {
    mkdirSync(join(repo, ".tap"), { recursive: true });
    writeFileSync(registry, `${JSON.stringify({ schema: "0.20", ...doc }, null, 2)}\n`);
  };
  writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: repo }, seats: {} });
  const env = (extra: NodeJS.ProcessEnv = {}) => {
    const { TAP_HOME: _runnerTapHome, ...ambient } = process.env;
    return ({
      ...ambient, HOME: home, TAP_INDEX_HOME: index, TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    PATH: `${bin}:${process.env.PATH}`, TMUX: "/fake/socket", TMUX_PANE: "%2",
    TAP_SKIP_VERSION_BRIEFING: "1", ...extra,
    });
  };
  const door = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = Bun.spawnSync([join(ROOT, "bin/tap"), "in", ...args], {
      cwd: repo, env: env(extra), stdout: "pipe", stderr: "pipe", timeout: 60000,
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const seats = (): Record<string, Record<string, unknown>> => {
    const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats?: Record<string, Record<string, unknown>> };
    return doc.seats ?? {};
  };
  return { root, index, home, repo, bin, addr, epoch, registry, bus, writeRegistry, env, door, seats };
}

test("outside tmux refusal leads with a bare launch and preserves JSON and state", () => {
  const f = fixture({ sessions: false, panes: false });
  try {
    // Refuse all pane observations, regardless of the runner's ancestry.
    writeFileSync(join(f.bin, "tmux"), "#!/bin/sh\nexit 1\n");
    const before = readFileSync(f.registry, "utf8");
    const indexBefore = readFileSync(join(f.index, "global-registry.json"), "utf8");
    const env = { TMUX: "", TMUX_PANE: "" };
    const human = f.door(["newcomer"], env);
    expect(human.code).toBe(1);
    expect(human.out).toBe("");
    expect(human.err.split("\n")[0]).toBe("tap in: this command needs a tmux pane; next: tap launch claude newcomer");
    expect(human.err).toContain("caller pane is not observable:");
    expect(human.err).toContain("pass --pane");
    for (const args of [["newcomer", "--json"], ["newcomer"]]) {
      const json = f.door(args, { ...env, TAP_JSON: "1" });
      expect(json.code).toBe(1);
      expect(json.err).toBe("");
      expect(JSON.parse(json.out)).toMatchObject({ ok: false, error_class: "not_in_tmux",
        action: "tap session launch <preset|harness> [name]", detail: expect.stringContaining("caller pane is not observable:") });
    }
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(indexBefore);
  } finally { removeScratchTree(f.root); }
});

function seedPayload(bus: string, id: string, to: string, toTeam = ""): void {
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const toTeamLine = toTeam ? `\nto_team: ${toTeam}` : "";
  writeFileSync(join(bus, "payloads", `${id}.md`), `---\nfrom: sender\nto: ${to}${toTeamLine}\nid: ${id}\nkind: discuss\n---\n\nbody\n`);
}

test("pane registration: defaults, seats-only store, primer bytes, env identity, attribution", () => {
  const f = fixture();
  try {
    const d = f.door(["scout", "--pane", f.addr], { TAP_HARNESS_SESSION_ID: "sess-env-1", TAP_SESSION_SOURCE: "resume" });
    expect(d.code, d.out + d.err).toBe(0);
    const scout = f.seats().scout!;
    expect(scout["status"]).toBe("active");
    expect(scout["cost_mode"]).toBe("subscription");
    expect(scout["include_policy"]).toBe("always");
    expect(scout["harness_session_id"]).toBe("sess-env-1");
    expect(scout["session_attribution_trust"]).toBe("env");
    expect(scout["pane_id"]).toBe("%2");
    // seats-only: no agents axis is ever created
    const doc = JSON.parse(readFileSync(f.registry, "utf8")) as Record<string, unknown>;
    expect("agents" in doc).toBe(false);
    expect(doc["seats"]).toBeTruthy();
    // three-line primer on the first text-mode registration; never tap done
    expect(d.err).toContain("tap register primer: inbox: tap poll scout");
    expect(d.err).toContain("tap register primer: answer: tap reply <id> -f <file>");
    expect(d.err).toContain("tap register primer: settle-only/FYI: tap read <id>");
    expect(d.err).not.toContain("tap done");
    // lineage: the fresh instance appends the pane-session lineage line
    const lineage = join(f.repo, ".tap", "team-history", "scout.lineage.jsonl");
    expect(existsSync(lineage)).toBe(true);
    const line = JSON.parse(readFileSync(lineage, "utf8").trim()) as Record<string, string>;
    expect(line["note"]).toBe("fresh");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("poll registration: first-time primer bytes; a repeat registration stays quiet (tap-l0lho)", () => {
  const f = fixture();
  try {
    const first = f.door(["scout", "--delivery", "poll"]);
    expect(first.code, first.out + first.err).toBe(0);
    expect(first.err).toContain("tap register primer: inbox: tap poll scout");
    expect(first.err).toContain("tap register primer: answer: tap reply <id> -f <file>");
    expect(first.err).toContain("tap register primer: settle-only/FYI: tap read <id>");
    // tap-hpp4h: this fixture's TAP_HOME is not the root's own bus, so the root
    // never qualified for enrollment: the skip stays silent.
    expect(first.err).not.toContain("tap register: warning");
    const repeat = f.door(["scout", "--delivery", "poll"]);
    expect(repeat.code, repeat.out + repeat.err).toBe(0);
    expect(repeat.err).not.toContain("tap register primer");
  } finally { removeScratchTree(f.root); }
}, 60000);

// tap-km9ej: registration commits before enrollTeam runs, so a failed machine
// enrollment must surface as a warning on an exit-0 receipt — never a silent
// success, never a rollback-retry invitation. The post-commit barrier freezes
// each door after the seat transaction, and the test invalidates the flip
// marker in that window (an invalid or colliding index refuses register itself
// before any commit, so the corruption has to race the barrier). TAP_HOME is
// pinned to the repo's canonical bus so the root is indexable and enrollment
// is attempted rather than skipped.
test("poll registration reports a machine-index enroll failure as a warning and stands (tap-km9ej)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--delivery", "poll", "--fresh"], {
      cwd: f.repo, env: f.env({ TAP_SCRATCH_ONLY: "1", TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, TAP_HOME: join(f.repo, ".tap", "bus") }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("after-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("after-mutation", "reached")), "poll door never reached the post-commit barrier").toBe(true);
    writeFileSync(join(f.index, "global-registry.json"), "not json");
    writeFileSync(stage("after-mutation", "release"), "");
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    expect(code, err).toBe(0);
    expect(f.seats().scout!["status"], "registration did not commit").toBe("active");
    expect(err).toContain(`is registered on team repo, but enrolling ${realpathSync(f.repo)} in the machine index failed (invalid_flip)`);
    expect(err).toContain("the registration stands. next: tap doctor");
    // The same seat is the safe retry: with the index restored, repeating the
    // registration WITHOUT the first run's --fresh re-runs enrollTeam, the
    // team lands in the machine index, and the receipt stays silent
    // (tap-km9ej P2; a committed --fresh seat refuses --fresh on repeat).
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
      schema: "0.20", migrated: { at: "2026-01-01T00:00:00Z", backups: {} }, teams: {},
    }));
    const retry = f.door(["scout", "--delivery", "poll"], { TAP_HOME: join(f.repo, ".tap", "bus") });
    expect(retry.code, retry.out + retry.err).toBe(0);
    expect(retry.err).not.toContain("tap register: warning");
    const enrolled = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams?: Record<string, { root?: string }> };
    expect(Object.values(enrolled.teams ?? {}).some((e) => e.root === realpathSync(f.repo)), "retry did not enroll the team").toBe(true);
  } finally {
    writeFileSync(stage("after-mutation", "release"), "");
    if (child && child.exitCode === null) child.kill();
    await child?.exited;
    removeScratchTree(f.root);
  }
}, 30000);

test("pane registration reports a machine-index enroll failure as a warning and stands (tap-km9ej)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--pane", f.addr], {
      cwd: f.repo, env: f.env({ TAP_SCRATCH_ONLY: "1", TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, TAP_HOME: join(f.repo, ".tap", "bus") }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("after-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("after-mutation", "reached")), "pane door never reached the post-commit barrier").toBe(true);
    writeFileSync(join(f.index, "global-registry.json"), "not json");
    writeFileSync(stage("after-mutation", "release"), "");
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    expect(code, err).toBe(0);
    expect(f.seats().scout!["status"], "registration did not commit").toBe("active");
    expect(err).toContain(`is registered on team repo, but enrolling ${realpathSync(f.repo)} in the machine index failed (invalid_flip)`);
    expect(err).toContain("the registration stands. next: tap doctor");
  } finally {
    writeFileSync(stage("after-mutation", "release"), "");
    if (child && child.exitCode === null) child.kill();
    await child?.exited;
    removeScratchTree(f.root);
  }
}, 30000);

// tap-hpp4h: a root that qualified at entry and stops qualifying after the
// commit lost its enrollment to a race; the exit-0 receipt must say so, with
// the committed seat's same-seat retry. The race is staged at the frozen
// after-mutation barrier by retargeting the repo path to a nested directory
// under another git top level (its .tap tree copied along): the git-root probe
// memo is keyed by realpath, so the post-commit probe sees a non-top-level
// root and enrollTeam skips (independent reviewer's reproduction).
test("a post-commit skip after the root stopped qualifying warns at the door and exits 0 (tap-hpp4h)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--delivery", "poll"], {
      cwd: f.repo, env: f.env({ TAP_SCRATCH_ONLY: "1", TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, TAP_HOME: join(f.repo, ".tap", "bus") }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("after-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("after-mutation", "reached")), "poll door never reached the post-commit barrier").toBe(true);
    const moved = join(f.root, "old-repo");
    const outer = join(f.root, "outer-repo");
    const nested = join(outer, "nested");
    renameSync(f.repo, moved);
    mkdirSync(nested, { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", outer], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    cpSync(join(moved, ".tap"), join(nested, ".tap"), { recursive: true });
    symlinkSync(nested, f.repo);
    writeFileSync(stage("after-mutation", "release"), "");
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    expect(code, err).toBe(0);
    expect(f.seats().scout!["status"], "registration did not commit").toBe("active");
    expect(err).toContain("scout is registered on team repo, but enrolling ");
    expect(err).toContain(" in the machine index was skipped");
    expect(err).toContain("the registration stands. next: check that the worktree is still a top-level git checkout");
    expect(err).toContain("then re-run tap register scout --delivery poll (same seat, without --fresh or --restore;");
    expect(err.split("\n").filter((l) => l.includes("tap register: warning")).length, err).toBe(1);
  } finally {
    writeFileSync(stage("after-mutation", "release"), "");
    if (child && child.exitCode === null) child.kill();
    await child?.exited;
    removeScratchTree(f.root);
  }
}, 30000);

// A THROWING enrollTeam is the sharper post-commit shape (tap-km9ej): its
// mkdirSync/index-lock prologue runs outside its refusal mapping, so a throw
// would escape the door and exit nonzero AGAINST a committed seat. Fixture:
// at the frozen after-mutation barrier, plant a DIRECTORY where enrollTeam's
// unbounded index-lock sidecar must be a file — the kernel lock throws
// EISDIR on an Infinity wait (a bounded one would only refuse). Both doors
// must convert the throw to the one-line enroll_failed warning on exit 0.
function plantEnrollThrow(f: ReturnType<typeof fixture>): void {
  const sidecar = join(f.index, "teams.json.lock");
  rmSync(sidecar, { recursive: true, force: true });
  mkdirSync(sidecar);
}

async function runEnrollThrowDoor(f: ReturnType<typeof fixture>, barrier: string, args: string[], envPins: Record<string, string>, inspect?: () => void): Promise<{ code: number; err: string }> {
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([join(ROOT, "bin/tap"), "in", ...args], {
      cwd: f.repo, env: f.env({ TAP_SCRATCH_ONLY: "1", TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, ...envPins }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("after-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("after-mutation", "reached")), "door never reached the post-commit barrier").toBe(true);
    plantEnrollThrow(f);
    writeFileSync(stage("after-mutation", "release"), "");
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    inspect?.();
    return { code, err };
  } finally {
    writeFileSync(stage("after-mutation", "release"), "");
    if (child && child.exitCode === null) child.kill();
    await child?.exited;
    rmSync(join(f.index, "teams.json.lock"), { recursive: true, force: true });
    removeScratchTree(f.root);
  }
}

// tap-hpp4h: the printed retry is pasted in the same environment, so it must
// carry the caller's explicit invocation identity. Without it the retry falls
// back to the inherited generic id and re-attributes the committed seat.
test("pasting the printed retry keeps the explicit harness session id over a stale inherited one (tap-hpp4h)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  const envPins = { TAP_HOME: join(f.repo, ".tap", "bus"), TAP_HARNESS_SESSION_ID: "stale-inherited" };
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--pane", f.addr, "--harness-session-id", "current-invocation"], {
      cwd: f.repo, env: f.env({ TAP_SCRATCH_ONLY: "1", TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, ...envPins }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("after-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("after-mutation", "reached")), "pane door never reached the post-commit barrier").toBe(true);
    plantEnrollThrow(f);
    writeFileSync(stage("after-mutation", "release"), "");
    const code = await child.exited;
    const err = await new Response(child.stderr).text();
    expect(code, err).toBe(0);
    expect(f.seats().scout!.harness_session_id, "original did not commit the explicit identity").toBe("current-invocation");
    const printed = /re-run tap register (.+?) \(same seat/.exec(err);
    expect(printed, err).not.toBeNull();
    const retryArgs = printed![1]!.split(" ");
    expect(retryArgs).toContain("--harness-session-id");
    rmSync(join(f.index, "teams.json.lock"), { recursive: true, force: true });
    const retry = f.door(retryArgs, envPins);
    expect(retry.code, retry.out + retry.err).toBe(0);
    expect(retry.err).not.toContain("tap register: warning");
    expect(f.seats().scout!.harness_session_id, "the pasted retry re-attributed the seat").toBe("current-invocation");
  } finally {
    writeFileSync(stage("after-mutation", "release"), "");
    if (child && child.exitCode === null) child.kill();
    await child?.exited;
    rmSync(join(f.index, "teams.json.lock"), { recursive: true, force: true });
    removeScratchTree(f.root);
  }
}, 30000);

test("poll registration survives a throwing enrollTeam as one enroll_failed warning (tap-km9ej)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const expectedRoot = realpathSync(f.repo); // the tree is gone once the runner cleans up
  const { code, err } = await runEnrollThrowDoor(f, barrier, ["scout", "--delivery", "poll", "--fresh"], { TAP_HOME: join(f.repo, ".tap", "bus") });
  expect(code, err).toBe(0);
  expect(err.split("\n").filter((l) => l.includes("tap register: warning")).length, err).toBe(1);
  expect(err).toContain(`is registered on team repo, but enrolling ${expectedRoot} in the machine index failed (enroll_failed)`);
  expect(err).toContain("the registration stands. next: fix the condition named above, then re-run tap register scout --delivery poll (same seat, without --fresh or --restore; the committed seat is kept)");
  expect(err).not.toContain("--fresh --");
}, 30000);

test("pane registration survives a throwing enrollTeam as one enroll_failed warning (tap-km9ej)", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const expectedRoot = realpathSync(f.repo); // the tree is gone once the runner cleans up
  const { code, err } = await runEnrollThrowDoor(f, barrier, ["scout", "--pane", f.addr], { TAP_HOME: join(f.repo, ".tap", "bus") }, () => {
    expect(f.seats().scout!["status"], "registration did not commit").toBe("active");
  });
  expect(code, err).toBe(0);
  expect(err.split("\n").filter((l) => l.includes("tap register: warning")).length, err).toBe(1);
  expect(err).toContain(`is registered on team repo, but enrolling ${expectedRoot} in the machine index failed (enroll_failed)`);
  expect(err).toContain("the registration stands. next: fix the condition named above, then re-run tap register scout --pane repo/seat:0.0 (same seat, without --fresh or --restore; the committed seat is kept)");
}, 30000);

// The help page carries the partial-success contract so scripts know exit 0
// does not imply the machine enrollment landed (tap-km9ej).
test("tap help register documents the enroll-failure warning contract", () => {
  const { lookupHelp } = require("../src/help");
  const help = lookupHelp(["register"]);
  expect(help.exit).toBe(0);
  // Help prose is hard-wrapped; compare the sentences, not where a line happens to break.
  const flat = help.stdout.replace(/\s+/g, " ");
  expect(flat).toContain("If machine enrollment fails after the seat is registered, register still exits 0 (JSON ok:true)");
  expect(flat).toContain("prints a single `tap register: warning:` line on stderr naming the failure and the next step");
  expect(flat).toContain("scripts that need enrollment should check stderr or `tap teams`");
});

// tap-km9ej P3: a detail or worktree carrying CR/LF must still compose exactly
// one stderr warning line — humanLine flattens before the write.
test("the enroll-failure warning stays one line under CR/LF in the detail", () => {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: Uint8Array | string) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    warnEnrollFailure({ ok: false, kind: "enroll_failed", detail: "boom\nsecond line\rthird\r\nline" }, "scout", "repo", "/tmp/w\nuntrusted", ctxFor([]));
  } finally {
    process.stderr.write = original;
  }
  const text = writes.join("");
  expect(text).not.toContain("\r");
  expect(text.split("\n").length - 1).toBe(1);
  expect(text.endsWith("\n")).toBe(true);
  expect(text).toContain("boom second line third  line");
});

// The warning's context: the caller's parsed form plus whether the root was
// indexable before the seat committed (tap-hpp4h).
function ctxFor(argv: string[], enrollExpected = true) {
  return { form: parseRegisterForm(argv), enrollExpected };
}

function captureWarning(outcome: EnrollOutcome, argv: string[], enrollExpected = true): string {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: Uint8Array | string) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    warnEnrollFailure(outcome, "scout", "repo", "/tmp/w", ctxFor(argv, enrollExpected));
  } finally {
    process.stderr.write = original;
  }
  return writes.join("");
}

// The remedies split by kind (tap-km9ej): a TRANSIENT refusal is remedied by
// the flag-free repeat (a committed --fresh or --restore seat refuses those
// flags, so the retry has to omit them), while enroll_failed covers durable
// I/O damage the operator must fix before the same repeat is safe.
test("enroll remedies split by kind: the transient repeat vs the fix-then-repeat", () => {
  const transient = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, ["scout", "--delivery", "poll"]);
  expect(transient).toContain("next: re-run tap register scout --delivery poll (same seat, without --fresh or --restore; the committed seat is kept; this retries enrollment)");
  const durable = captureWarning({ ok: false, kind: "enroll_failed", detail: "lock held" }, ["scout", "--delivery", "poll"]);
  expect(durable).toContain("next: fix the condition named above, then re-run tap register scout --delivery poll (same seat, without --fresh or --restore; the committed seat is kept)");
  expect(durable).not.toContain("; this retries enrollment");
  expect(durable).not.toContain("do not re-register");
});

// tap-hpp4h: a name collision is not a doctor matter. The detail already names
// the retire-or-rename recovery; the remedy points at it instead of a generic
// doctor run, and the same-seat repeat follows once the stale entry is gone.
test("a name collision points at retire-or-rename, not tap doctor (tap-hpp4h)", () => {
  const detail = "team 'repo' is already indexed at a different path (/old, not /new) — run 'tap admin retire repo' to de-enroll the stale entry, or rename one team";
  const out = captureWarning({ ok: false, kind: "name_collision", detail }, ["scout", "--delivery", "poll"]);
  expect(out).toContain("run 'tap admin retire repo' to de-enroll the stale entry, or rename one team");
  expect(out).toContain("next: retire or rename as described above, then re-run tap register scout --delivery poll (same seat, without --fresh or --restore; the committed seat is kept)");
  expect(out).not.toContain("tap doctor");
});

// tap-hpp4h: the retry hint keeps the caller's SAFE original options, shell
// quoted, for the committed seat. --fresh/--restore are dropped (a committed
// seat refuses them), as are flags that replay effects or grant one-time
// consent (--force, --accept-observed-identity). Scope consent the same-seat
// registration needs again (--namespace-crossing, --override-worktree) and the
// caller's invocation identity (--harness-session-id) travel.
test("the retry hint keeps safe original options, shell-quoted, and drops replaying flags (tap-hpp4h)", () => {
  const argv = ["scout", "--delivery", "poll", "--team", "repo", "--wake-url", "http://h/x y", "--reply-to", "repo/lead", "--harness-session-id", "sess-9",
    "--unattended", "--override-worktree", "--namespace-crossing", "--fresh", "--restore", "inst-1", "--force", "--accept-observed-identity", "--json"];
  const out = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, argv);
  expect(out).toContain("re-run tap register scout --delivery poll --team repo --wake-url 'http://h/x y' --reply-to repo/lead --harness-session-id sess-9 --unattended --override-worktree --namespace-crossing --json (same seat");
  for (const dropped of ["--fresh", "--restore", "--force", "--accept-observed-identity"]) {
    expect(out.replace("without --fresh or --restore", ""), dropped).not.toContain(dropped);
  }
  // Value-taking options consume the next token even when it spells a control
  // option: that token is DATA and travels, while the real --fresh is dropped.
  const data = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, ["scout", "--delivery", "poll", "--team", "repo", "--reply-to", "--fresh", "--fresh"]);
  expect(data).toContain("re-run tap register scout --delivery poll --team repo --reply-to --fresh (same seat");
  // CR/LF and apostrophes in a value round-trip as one shell word on ONE line.
  const odd = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, ["scout", "--delivery", "poll", "--team", "repo", "--wake-url", "a'b\nc\rd"]);
  expect(odd).toContain("--wake-url $'a\\'b\\x0ac\\x0dd' (same seat");
  expect(odd.split("\n").length - 1).toBe(1);
  const quote = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, ["scout", "--delivery", "poll", "--team", "repo", "--wake-url", "it's"]);
  expect(quote).toContain(`--wake-url 'it'"'"'s' (same seat`);
  const pane = captureWarning({ ok: false, kind: "enroll_retry", detail: "lock held" }, ["scout", "--pane", "my repo/seat:0.0", "--mode", "api", "--include", "on_request", "--crew"]);
  expect(pane).toContain("re-run tap register scout --pane 'my repo/seat:0.0' --mode api --include on_request --crew (same seat");
});

// tap-hpp4h: enrollTeam returns ok:true skipped:true when the root stops
// qualifying (not top-level git, bus no longer the root's own, no valid team
// name). That is silent policy for a root that never qualified, but a root
// that WAS indexable before the commit and skipped after it lost its
// enrollment to a race, and the exit-0 receipt must say so.
test("a post-commit skip of a root that qualified before the commit warns; a never-indexable root stays silent (tap-hpp4h)", () => {
  const raced = captureWarning({ ok: true, skipped: true }, ["scout", "--delivery", "poll"], true);
  expect(raced).toContain("tap register: warning: scout is registered on team repo, but enrolling /tmp/w in the machine index was skipped");
  expect(raced).toContain("the registration stands. next: check that the worktree is still a top-level git checkout whose bus is its own .tap/bus, then re-run tap register scout --delivery poll (same seat, without --fresh or --restore; the committed seat is kept; this retries enrollment)");
  expect(raced.split("\n").length - 1).toBe(1);
  expect(captureWarning({ ok: true, skipped: true }, ["scout", "--delivery", "poll"], false)).toBe("");
  expect(captureWarning({ ok: true }, ["scout", "--delivery", "poll"], true)).toBe("");
});

test("session_attribution_candidates writes a canonical integer loadRegistry accepts (tap-2y65i)", () => {
  const f = fixture();
  try {
    // Force the pane's harness to "claude" so ambient derivation (not the
    // --pane env's TAP_HARNESS_SESSION_ID shortcut) runs sessionDerive, the
    // only path that ever populates session_attribution_candidates.
    const claudeTmux = readFileSync(join(f.bin, "tmux"), "utf8")
      .replaceAll("zsh", "claude");
    writeFileSync(join(f.bin, "tmux"), claudeTmux);
    chmodSync(join(f.bin, "tmux"), 0o755);
    // Two ambiguous transcript candidates under the mangled worktree path —
    // the exact shape that produced `session_attribution_candidates: 2` (a
    // Python float lexeme `2.0` before this fix; loadRegistry refused it).
    // git normalizes symlinks (macOS /var -> /private/var), so sessionDerive's
    // internally-resolved worktree is the REAL path, not f.repo's raw one.
    const realRepo = realpathSync(f.repo);
    const projectDir = join(f.home, ".claude", "projects", realRepo.replaceAll("/", "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "aaaa.jsonl"), "{}\n");
    writeFileSync(join(projectDir, "bbbb.jsonl"), "{}\n");
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const scout = f.seats().scout!;
    expect(scout["session_attribution_trust"]).toBe("derived_ambiguous");
    expect(scout["session_attribution_candidates"]).toBe(2);
    // The regression: loadRegistry's canonical-integers-only reviver threw on
    // a `2.0` lexeme, so every subsequent self-lookup answered "not
    // registered" team-wide (tap-2y65i). This must not throw.
    const doc = loadRegistry(f.registry) as { seats: Record<string, Record<string, unknown>> };
    expect(doc.seats.scout!["session_attribution_candidates"]).toBe(2);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-yemkc: a derived_unique session-store guess never becomes authoritative transcript_path", () => {
  const f = fixture();
  try {
    const claudeTmux = readFileSync(join(f.bin, "tmux"), "utf8").replaceAll("zsh", "claude");
    writeFileSync(join(f.bin, "tmux"), claudeTmux);
    chmodSync(join(f.bin, "tmux"), 0o755);
    // Exactly ONE transcript jsonl -> deriveClaude's derived_unique arm
    // (store_kind "file", trust below process/env) rather than derived_ambiguous.
    const realRepo = realpathSync(f.repo);
    const projectDir = join(f.home, ".claude", "projects", realRepo.replaceAll("/", "-"));
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, "cccc.jsonl");
    writeFileSync(transcript, "{}\n");
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const scout = f.seats().scout!;
    expect(scout["session_attribution_trust"]).toBe("derived_unique");
    // The regression: a heuristic file guess (not env/process trust) was
    // promoted into the authoritative transcript_path anyway.
    expect(scout["transcript_path"]).toBeUndefined();
    expect(scout["session_store_path"]).toBe(transcript);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-yemkc: an inherited TAP_CLEAR_ID is blanked under suppressed identity capture", () => {
  const f = fixture();
  try {
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      scout: { instance: "scout|one", status: "suspended", status_reason: "user_removed", delivery: "poll", pane: "", expected_clear_nonce: "n1" },
    } });
    // suppressCapture must not let a driver/daemon's own TAP_CLEAR_ID satisfy
    // a pending clear nonce that belongs to the target pane, not the caller.
    const d = f.door(["scout", "--pane", f.addr],
      { TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE: "1", TAP_CLEAR_ID: "n1" });
    expect(d.code, d.out + d.err).toBe(0);
    expect(f.seats().scout!["clear_nonce"]).toBeUndefined();
  } finally { removeScratchTree(f.root); }
}, 60000);

// A valid registry whose keys are deliberately unsorted and whose indent is
// not the canonical two spaces: any rewrite through the registry serializer
// changes its bytes, so byte identity proves no write happened (tap-mhuok).
// `team` defaults to a complete block; pass {worktree_root} alone for the seed
// whose missing team.name an admitted registration fills in.
function noncanonicalSeed(f: ReturnType<typeof fixture>, row: Record<string, unknown>, team: Record<string, unknown> = { worktree_root: f.repo, name: "repo" }): string {
  const raw = JSON.stringify({ seats: { scout: row }, team, schema: "0.20" }, null, 4) + "\n";
  writeFileSync(f.registry, raw);
  return raw;
}

test("tap-36gl8/tap-mhuok: poll and offline registration refuse an incapable mark with the registry bytes untouched; other suspended rows still reactivate", () => {
  const f = fixture();
  try {
    const marked = { status_reason: "incapable", status: "suspended", pane_id: "%2", pane: f.addr, instance: "scout|one", delivery: "pane" };
    const seed = noncanonicalSeed(f, marked);
    const bytes = () => readFileSync(f.registry, "utf8");
    const refused = f.door(["scout", "--delivery", "poll", "--json"]);
    expect(refused.code, refused.out + refused.err).toBe(1);
    expect(JSON.parse(refused.out).error_class).toBe("usage_error");
    expect(refused.err).toContain("re-register from that seat's own pane");
    expect(bytes()).toBe(seed);
    // the offline door must not rewrite the mark into user_removed, which a
    // following poll registration would then clear
    const offline = f.door(["scout", "--offline"]);
    expect(offline.code, offline.out + offline.err).toBe(1);
    expect(offline.err).toContain("re-register from that seat's own pane");
    expect(bytes()).toBe(seed);
    expect(f.door(["scout", "--delivery", "poll"]).code).toBe(1);
    expect(bytes()).toBe(seed);
    // control: a different suspended reason is still an ordinary poll
    // registration, and a registration that changes something writes the
    // canonical (sorted, two-space) form
    noncanonicalSeed(f, { ...marked, status_reason: "user_removed" });
    const ok = f.door(["scout", "--delivery", "poll"]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(f.seats().scout!["status"]).toBe("active");
    expect(f.seats().scout!["delivery"]).toBe("poll");
    expect(Object.keys(JSON.parse(bytes()))).toEqual(["schema", "seats", "team"]);
    expect(bytes().startsWith('{\n  "schema"')).toBe(true);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-mhuok: the pane gate's incapable refusal from another pane leaves the registry bytes untouched", () => {
  const f = fixture();
  try {
    for (const team of [undefined, { worktree_root: f.repo }]) {
      const seed = noncanonicalSeed(f, { status_reason: "incapable", status: "suspended", pane_id: "%9", pane: "elsewhere:0.0", instance: "scout|one", delivery: "pane" }, team);
      const refused = f.door(["scout", "--pane", f.addr]);
      expect(refused.code, refused.out + refused.err).toBe(1);
      expect(refused.err).toContain("cannot be cleared from pane");
      expect(readFileSync(f.registry, "utf8")).toBe(seed);
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-mhuok: refusals leave a registry whose team block lacks a name untouched; an admitted registration fills the name in", () => {
  const f = fixture();
  try {
    const marked = { status_reason: "incapable", status: "suspended", pane_id: "%9", pane: "elsewhere:0.0", instance: "scout|one", delivery: "pane" };
    const seed = noncanonicalSeed(f, marked, { worktree_root: f.repo });
    const bytes = () => readFileSync(f.registry, "utf8");
    for (const args of [["--delivery", "poll", "--json"], ["--offline", "--json"], ["--pane", f.addr]]) {
      const refused = f.door(["scout", ...args]);
      expect(refused.code, refused.out + refused.err).toBe(1);
      expect(bytes()).toBe(seed);
    }
    // an unrelated usage refusal that follows the team block in the dispatcher
    const selfReply = f.door(["scout", "--delivery", "poll", "--reply-to", "scout", "--json"]);
    expect(selfReply.code, selfReply.out + selfReply.err).toBe(1);
    expect(bytes()).toBe(seed);
    // control: admitted registrations write the missing name with their own change
    for (const args of [["--delivery", "poll"], ["--offline"], ["--pane", f.addr]]) {
      noncanonicalSeed(f, { ...marked, status_reason: "user_removed", pane: f.addr, pane_id: "%2" }, { worktree_root: f.repo });
      const ok = f.door(["scout", ...args]);
      expect(ok.code, ok.out + ok.err).toBe(0);
      expect((JSON.parse(bytes()) as { team: { name?: string } }).team.name).toBe("repo");
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-mhuok: a registry missing its team block still gets it written", () => {
  const f = fixture();
  try {
    writeFileSync(f.registry, `${JSON.stringify({ schema: "0.20", seats: {} }, null, 2)}\n`);
    const ok = f.door(["scout", "--delivery", "poll"]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect((JSON.parse(readFileSync(f.registry, "utf8")) as { team?: { name?: string } }).team?.name).toBe("repo");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-zvwgr: --reply-to naming this seat's own handle is refused", () => {
  const f = fixture();
  try {
    const d = f.door(["scout", "--delivery", "poll", "--reply-to", "scout", "--json"]);
    expect(d.code, d.out + d.err).toBe(1);
    expect(JSON.parse(d.out).error_class).toBe("usage_error");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-zvwgr: --reply-to a launching row is refused, matching send-time deliverability", () => {
  const f = fixture();
  try {
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      launcher: { instance: "launcher|one", status: "active", status_reason: "launching", delivery: "poll" },
    } });
    const d = f.door(["scout", "--delivery", "poll", "--reply-to", "launcher", "--json"]);
    expect(d.code, d.out + d.err).toBe(1);
    expect(JSON.parse(d.out).error_class).toBe("seat_suspended");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-zvwgr: --reply-to a retired handle with an active forwarding resolves to its destination", () => {
  const f = fixture();
  try {
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: { dest: { instance: "dest|one", status: "active", delivery: "poll" } },
      seat_forwardings: [{ source: "retired", source_instance: "retired|one", destination: "dest",
        destination_instance: "dest|one", at: "2026-09-21T00:00:00Z", address_active: true }],
    });
    // Before the fix: the early not_found return on a missing `retired` row
    // fired before forwarding was ever consulted, AND forwardingRoute's
    // JsonMap->RegistryDoc cast made it see neither seats nor seat_forwardings.
    const d = f.door(["scout", "--delivery", "poll", "--reply-to", "retired", "--json"]);
    expect(d.code, d.out + d.err).toBe(0);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("mode/include validation and defaults; --restore and --fresh are mutually exclusive", () => {
  const f = fixture();
  try {
    const api = f.door(["scout", "--mode", "api", "--pane", f.addr]);
    expect(api.code, api.out + api.err).toBe(0);
    expect(f.seats().scout!["cost_mode"]).toBe("api");
    expect(f.seats().scout!["include_policy"]).toBe("on_request");
    const badMode = f.door(["s2", "--mode", "bogus"]);
    expect(badMode.code).toBe(1);
    expect(badMode.err).toContain("--mode must be 'subscription' or 'api'");
    const badInclude = f.door(["s3", "--include", "sometimes"]);
    expect(badInclude.code).toBe(1);
    expect(badInclude.err).toContain("--include must be 'always' or 'on_request'");
    const both = f.door(["s4", "--restore", "inst-1", "--fresh"]);
    expect(both.code).toBe(1);
    expect(both.err).toContain("mutually exclusive");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("an explicit team on a pristine machine is not_found, without bootstrap", () => {
  const f = fixture();
  try {
    unlinkSync(join(f.index, "global-registry.json"));
    const d = f.door(["gw", "--delivery", "poll", "--team", "unknown", "--json"]);
    expect(d.code).toBe(1);
    expect(JSON.parse(d.out).error_class).toBe("not_found");
    expect(JSON.parse(d.out).detail).toContain("--team 'unknown' is not enrolled");
    expect(existsSync(join(f.index, "global-registry.json"))).toBe(false);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("custom TAP_HOME with a pre-existing store refuses old_store before any write", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "custom-home");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "registry.json"), JSON.stringify({ team: { name: "legacy" }, agents: {} }));
    // The old-store door needs a genuinely pre-flip index: pin an empty
    // TAP_INDEX_HOME so the sandbox's shared marker cannot close the gate.
    const emptyIndex = join(f.root, "empty-index");
    mkdirSync(emptyIndex, { recursive: true });
    const d = f.door(["scout", "--pane", f.addr], { TAP_HOME: custom, TAP_INDEX_HOME: emptyIndex });
    expect(d.code, d.out + d.err).toBe(1);
    expect(d.err).toContain("is an old TAP registry format");
    expect(d.err).toContain("next: ask an agent to upgrade this file to the current format by hand");
    expect(d.err).not.toContain("migrate-registry");
    expect(existsSync(join(custom, "registry.json"))).toBe(true);
    expect(f.seats().scout).toBeUndefined();
  } finally { removeScratchTree(f.root); }
}, 60000);

// C4 ruling 1 (leader ruling, 2026-09-23) supersedes tap-55gjp's team requirement:
// `team` is optional and must be an object only when present, so a schema-0.20
// seats registry without `team` is current and register writes seats into it.
test("C4 ruling 1: a markerless custom bus missing team is current; register writes seats only", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "custom-no-team");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "registry.json"), JSON.stringify({ schema: "0.20", seats: {} }));
    const emptyIndex = join(f.root, "empty-index-no-team");
    mkdirSync(emptyIndex, { recursive: true });
    const d = f.door(["scout", "--pane", f.addr], { TAP_HOME: custom, TAP_INDEX_HOME: emptyIndex });
    expect(d.code, d.out + d.err).toBe(0);
    const after = JSON.parse(readFileSync(join(custom, "registry.json"), "utf8")) as Record<string, unknown>;
    expect(after.schema).toBe("0.20");
    expect(Object.hasOwn(after, "agents")).toBe(false);
    expect(Object.keys(after.seats as object)).toContain("scout");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-55gjp: a markerless custom bus with a mixed agents axis is old-store evidence", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "custom-mixed");
    mkdirSync(custom, { recursive: true });
    const raw = JSON.stringify({ schema: "0.20", team: { name: "legacyteam" }, seats: {}, agents: { ghost: {} } });
    writeFileSync(join(custom, "registry.json"), raw);
    const emptyIndex = join(f.root, "empty-index-mixed");
    mkdirSync(emptyIndex, { recursive: true });
    const d = f.door(["scout", "--pane", f.addr], { TAP_HOME: custom, TAP_INDEX_HOME: emptyIndex });
    expect(d.code, d.out + d.err).toBe(1);
    expect(d.err).toContain("is an old TAP registry format");
    expect(readFileSync(join(custom, "registry.json"), "utf8")).toBe(raw);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-55gjp control: a complete markerless custom bus is still kept as the authoritative pre-flip world", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "custom-complete");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "legacyteam" }, seats: {} }));
    const emptyIndex = join(f.root, "empty-index-complete");
    mkdirSync(emptyIndex, { recursive: true });
    const d = f.door(["scout", "--pane", f.addr], { TAP_HOME: custom, TAP_INDEX_HOME: emptyIndex });
    expect(d.code, d.out + d.err).toBe(0);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("C5 refuses each old-store shape before bootstrap and preserves every supplied store", () => {
  for (const shape of ["bus", "teams", "agents", "manifest"] as const) {
    const f = fixture();
    try {
      unlinkSync(join(f.index, "global-registry.json"));
      const oldPath = shape === "bus" ? join(f.bus, "registry.json")
        : shape === "teams" ? join(f.index, "teams.json")
        : shape === "manifest" ? join(f.root, "sessions.json") : f.registry;
      const raw = shape === "agents" ? '{"agents":{"prior":{"instance":"prior|1"}}}\n' : '{"preserve":"old-store"}\n';
      writeFileSync(oldPath, raw);
      const before = readFileSync(f.registry, "utf8");
      const d = f.door(["scout", "--delivery", "poll", "--json"]);
      expect(d.code, shape + d.out + d.err).toBe(1);
      expect(JSON.parse(d.out).error_class).toBe("old_store");
      expect(readFileSync(oldPath, "utf8")).toBe(raw);
      expect(readFileSync(f.registry, "utf8")).toBe(before);
      expect(existsSync(join(f.index, "global-registry.json"))).toBe(false);
      expect(existsSync(`${f.registry}.lock`)).toBe(false);
    } finally { removeScratchTree(f.root); }
  }
}, 60000);

test("current-index registration refuses an agents-axis acting store intact on every write door", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ team: { name: "repo", worktree_root: f.repo }, agents: { scout: { status: "active" } } });
    writeFileSync(f.registry, raw);
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      repo: { root: f.repo, registry_location: f.registry, state: "registered" },
    } }));
    for (const args of [["--offline"], ["--delivery", "poll"], ["--pane", f.addr]]) {
      const d = f.door(["scout", ...args, "--json"]);
      expect(d.code, d.out + d.err).toBe(1);
      expect(JSON.parse(d.out).error_class).toBe("old_store");
      expect(readFileSync(f.registry, "utf8")).toBe(raw);
      expect(existsSync(`${f.registry}.lock`)).toBe(false);
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

test("pristine bootstrap creates seats; an unclassified custom bus refuses without writes", () => {
  const f = fixture();
  try {
    unlinkSync(join(f.index, "global-registry.json"));
    unlinkSync(f.registry);
    const custom = join(f.root, "custom-empty");
    mkdirSync(custom);
    const refused = f.door(["scout", "--delivery", "poll", "--json"], { TAP_HOME: custom });
    expect(refused.code, refused.out + refused.err).toBe(1);
    expect(existsSync(join(custom, "registry.json"))).toBe(false);
    expect(existsSync(join(f.index, "global-registry.json"))).toBe(false);
    const ok = f.door(["scout", "--delivery", "poll", "--json"]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(f.seats().scout?.delivery).toBe("poll");
    expect(JSON.parse(readFileSync(f.registry, "utf8")).agents).toBeUndefined();
  } finally { removeScratchTree(f.root); }
}, 60000);

test("a current enrollment retains its alias and custom registry despite historical stores", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "current-registry.json");
    writeFileSync(custom, '{"schema":"0.20","team":{"name":"alias"},"seats":{}}');
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      alias: { root: f.repo, registry_location: custom, state: "registered" },
    } }));
    writeFileSync(join(f.root, "sessions.json"), '{"historical":"keep"}');
    const before = readFileSync(f.registry, "utf8");
    const ok = f.door(["scout", "--delivery", "poll", "--json"]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(JSON.parse(ok.out).receipt.team).toBe("alias");
    expect(JSON.parse(readFileSync(custom, "utf8")).seats.scout.delivery).toBe("poll");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(readFileSync(join(f.root, "sessions.json"), "utf8")).toBe('{"historical":"keep"}');
  } finally { removeScratchTree(f.root); }
}, 60000);

test("launcher-owned start keeps launching/cost/include and launch_id on a same-pane rebind", () => {
  const f = fixture();
  try {
    f.writeRegistry({
      schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: {
        scout: {
          status: "active", status_reason: "launching", launch_id: "launch-token",
          cost_mode: "api", include_policy: "on_request",
          pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch,
          instance: "scout|i1",
        },
      },
    });
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const scout = f.seats().scout!;
    expect(scout["status_reason"]).toBe("launching");
    expect(scout["cost_mode"]).toBe("api");
    expect(scout["include_policy"]).toBe("on_request");
    expect(scout["launch_id"]).toBe("launch-token");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("team-wide foreign-namespace refusal fires before suffixing; --namespace-crossing bypasses", () => {
  const f = fixture();
  try {
    f.writeRegistry({
      schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: { bound: { status: "active", pane: "other/a:0.0", pane_id: "%9", server_socket: "/other" } },
    });
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out).toBe(1);
    expect(d.err).toContain("another tmux socket");
    expect(d.err).toContain("--namespace-crossing");
    expect(f.seats().scout).toBeUndefined();
    const ok = f.door(["scout", "--namespace-crossing", "--pane", f.addr]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(f.seats().scout).toBeTruthy();
  } finally { removeScratchTree(f.root); }
}, 60000);

test("dedup + adoption under the lock: released row deleted, mail moves, grants and epoch recorded", () => {
  const f = fixture();
  try {
    f.writeRegistry({
      schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: {
        old: { status: "active", pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch, instance: "old|i1", harness: "zsh" },
      },
    });
    seedPayload(f.bus, "pm-1", "old");
    const d = f.door(["fresh", "--force", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const seats = f.seats();
    expect(seats["old"]).toBeUndefined(); // deleted, not suspended
    const fresh = seats["fresh"]!;
    expect(fresh).toBeTruthy();
    expect(Array.isArray(fresh["adopted_handles"]) && (fresh["adopted_handles"] as string[]).includes("old")).toBe(true);
    expect(fresh["session_epoch"]).toBeTruthy();
    expect(d.out).toContain("adopted");
    expect(d.out).toContain("this pane gave up old to become fresh");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("session_epoch writes a canonical integer loadRegistry accepts on adoption (tap-2y65i)", () => {
  const f = fixture();
  try {
    f.writeRegistry({
      schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: {
        old: { status: "active", pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch, instance: "old|i1", harness: "zsh" },
      },
    });
    seedPayload(f.bus, "pm-1", "old");
    const d = f.door(["fresh", "--force", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const fresh = f.seats()["fresh"]!;
    expect(fresh["session_epoch"]).toBe(1);
    // The regression: a `1.0` lexeme there threw the same canonical-integers
    // refusal loadRegistry raises for session_attribution_candidates, so any
    // post-compaction re-register that adopts pending mail would re-poison
    // the document (tap-2y65i).
    const doc = loadRegistry(f.registry) as { seats: Record<string, Record<string, unknown>> };
    expect(doc.seats.fresh!["session_epoch"]).toBe(1);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("same-pane residue does not turn an idempotent rebind into a new identity", () => {
  const f = fixture();
  try {
    const row = { status: "active", delivery: "pane", pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch };
    f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: { scout: { ...row, instance: "scout|kept" }, residue: row } });
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    expect(f.seats().scout?.instance).toBe("scout|kept");
    expect(f.seats().residue).toBeUndefined();
    for (const status of ["suspended", null, ""]) {
      const stopped = { ...row, status, instance: "scout|stopped" };
      const owner = { ...row, instance: "owner|active" };
      f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: { scout: stopped, owner } });
      const refused = f.door(["scout", "--pane", f.addr, "--json"]);
      expect(refused.code, refused.out + refused.err).toBe(1);
      expect(JSON.parse(refused.out).error_class).toBe("pane_occupied");
      expect(f.seats()).toEqual({ scout: stopped, owner });
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

test("dedup preserves stopped, poll, foreign-namespace and unobservable incumbents", () => {
  for (const sessions of [true, false]) {
    const f = fixture({ sessions });
    try {
      const row = { status: "active", delivery: "pane", pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch };
      const protectedRows = {
        stopped: { ...row, status: "suspended" }, poll: { ...row, delivery: "poll" },
        nullStatus: { ...row, status: null }, emptyStatus: { ...row, status: "" },
        foreign: { ...row, server_socket: "/other" },
        ...(sessions ? {} : { unseen: row }),
      };
      f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: protectedRows });
      const d = f.door(["scout", "--force", "--namespace-crossing", "--pane", f.addr]);
      expect(d.code, d.out + d.err).toBe(0);
      for (const [handle, prior] of Object.entries(protectedRows)) expect(f.seats()[handle]).toEqual(prior);
    } finally { removeScratchTree(f.root); }
  }
}, 60000);

test("same-session dedup uses the recorded pane address rather than a stale session field", () => {
  const f = fixture();
  try {
    const other = { status: "active", delivery: "pane", pane: "other:0.0", pane_id: "%99", session: "repo/seat", server_epoch: f.epoch };
    f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: { other } });
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    expect(f.seats().other).toEqual(other);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("briefing filters canonical mail and counts authorized parked mail without mutating it", () => {
  const f = fixture();
  try {
    seedPayload(f.bus, "loc-1", "scout"); // legacy bare to, no to_team: local
    seedPayload(f.bus, "loc-2", "scout", "repo"); // stamped local team: local
    seedPayload(f.bus, "for-1", "scout", "other-team"); // foreign relay: never local
    const spool = join(f.bus, "spool"); mkdirSync(spool);
    for (const [id, to, team, instance] of [
      ["park-ok", "scout", "repo", ""], ["park-foreign", "scout", "other-team", ""],
      ["park-old", "scout", "repo", "scout|old"], ["park-done", "scout", "repo", ""],
      ["park-other", "peer", "repo", ""], ["loc-1", "scout", "repo", ""],
    ]) {
      writeFileSync(join(spool, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: ${to}\nto_team: ${team}\nkind: discuss\npath: ${join(f.bus, "payloads", `${id}.md`)}\nreply: expected\nrecipient_instance: ${instance}\n---\nbody\n`);
      writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ target: to }));
    }
    writeFileSync(join(f.bus, "receipts/park-done.done"), "{}");
    const snapshot = () => readdirSync(spool).sort().map(n => [n, readFileSync(join(spool, n), "utf8")]);
    const before = snapshot();
    const d = f.door(["scout", "--pane", f.addr, "--json"]);
    expect(d.code, d.out + d.err).toBe(0);
    const briefing = JSON.parse(d.out.trim().split("\n").pop()!) as { inbox: Array<{ id: string }>; parked_count: number };
    const ids = briefing.inbox.map((m) => m.id);
    expect(ids).toContain("loc-1");
    expect(ids).toContain("loc-2");
    expect(ids).not.toContain("for-1");
    expect(briefing.parked_count).toBe(1);
    const text = f.door(["scout", "--pane", f.addr]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain("1 parked message(s) for you; next: tap poll scout");
    expect(snapshot()).toEqual(before);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("briefing and recap skip 5000 settled bodies and sidecars and bound history reads", () => {
  const f = fixture(), now = 1800000000;
  try {
    const args = ["scout", "--pane", f.addr, "--json"];
    const registered = f.door(args);
    expect(registered.code, registered.err).toBe(0);
    const put = (id: string, from: string, to: string, mtime: number) => {
      seedPayload(f.bus, id, to);
      const path = join(f.bus, "payloads", `${id}.md`);
      writeFileSync(path, `---\nid: ${id}\nfrom: ${from}\nto: ${to}\nkind: discuss\n---\nbody\n`);
      utimesSync(path, mtime, mtime);
      return path;
    };
    for (let i = 0; i < 5000; i++) {
      put(`settled-${i}`, "peer", "scout", now - 10000 - i);
      writeFileSync(join(f.bus, "receipts", `settled-${i}.done`), "");
      // Transport sidecars have no matching .done and can be newer than mail.
      const attempts = join(f.bus, "payloads", `settled-${i}.attempts`);
      writeFileSync(attempts, "1\n");
      utimesSync(attempts, now, now);
    }
    // The newest 20 are unsettled; history must not reach any older body.
    for (let i = 0; i < 20; i++) put(`open-${i}`, i === 1 ? "scout" : "peer", i === 0 ? "scout" : "other", now - 10 - i);
    for (const id of ["_draft", ".hidden", ""]) put(id, "peer", "scout", now);
    put("cancelled", "peer", "scout", now - 20000);
    writeFileSync(join(f.bus, "receipts/cancelled.cancelled"), "");
    put("archived", "scout", "peer", now - 20000);
    mkdirSync(join(f.bus, "archive"));
    writeFileSync(join(f.bus, "archive/index.ndjson"), JSON.stringify({ id: "archived", month: "2026-09",
      settled_at: "2026-09-20T00:00:00Z", payload_sha256: "a".repeat(64), receipts: ["archived.done"] }) + "\n");
    const readsPath = join(f.root, "payload-reads.json");
    const script = `import { mock } from "bun:test";
      const fs = { ...await import("node:fs") }, reads = { register: [], recap: [] };
      let phase = "register";
      mock.module("node:fs", () => ({ ...fs, readFileSync(path, ...args) {
        if (${JSON.stringify([join(f.bus, "payloads") + "/", realpathSync(join(f.bus, "payloads")) + "/"])}.some(prefix => String(path).startsWith(prefix))) reads[phase].push(fs.realpathSync(path));
        return fs.readFileSync(path, ...args);
      }}));
      Date.now = () => ${now * 1000};
      const { cmdRegister } = await import(${JSON.stringify(join(ROOT, "runtime/bun/src/verbs/register.ts"))});
      const { cmdRecap } = await import(${JSON.stringify(join(ROOT, "runtime/bun/src/verbs/recap.ts"))});
      if (cmdRegister(${JSON.stringify(args)}) !== 0) throw new Error("registration failed");
      phase = "recap";
      if (cmdRecap(["scout", "--json"]) !== 0) throw new Error("recap failed");
      fs.writeFileSync(${JSON.stringify(readsPath)}, JSON.stringify(reads));`;
    for (const recentSettled of [false, true]) {
      if (recentSettled) utimesSync(join(f.bus, "payloads/settled-0.md"), now - 1, now - 1);
      const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: f.repo, env: f.env({ TAP_HOME: f.bus }),
        stdout: "pipe", stderr: "pipe", timeout: 20000 });
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      const reads = JSON.parse(readFileSync(readsPath, "utf8")) as Record<string, string[]>;
      for (const paths of Object.values(reads)) {
        expect(new Set(paths.filter(path => path.includes("/open-"))).size).toBe(20);
        expect(paths.length).toBeLessThanOrEqual(40);
        expect(paths.filter(path => !path.includes("/open-"))).toEqual(recentSettled ? [realpathSync(join(f.bus, "payloads/settled-0.md"))] : []);
        for (const path of new Set(paths)) expect(paths.filter(p => p === path).length).toBeLessThanOrEqual(2);
      }
      const [briefing, recap] = r.stdout.toString().trim().split("\n").map(line => JSON.parse(line));
      const project = ({ path: _path, ...row }: { path: string }) => row;
      expect(briefing.inbox).toEqual(recap.inbox.map(project));
      expect(briefing.outstanding).toEqual(recap.outstanding.map(project));
      expect(briefing.inbox.map((row: { id: string }) => row.id)).toEqual(["open-0"]);
      expect(briefing.outstanding.map((row: { id: string }) => row.id)).toEqual(["open-1"]);
      expect(briefing.seat_history.recent_count).toBe(recentSettled ? 2 : 1);
      const last = recap.history.find((row: { id: string }) => row.id === briefing.seat_history.last.id);
      expect(briefing.seat_history.last).toEqual({ id: last.id, kind: last.kind, peer: last.peer, age_seconds: last.age_seconds });
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

test("unobservable chooser fails closed: the incumbent is suffixed, never clobbered", () => {
  const f = fixture({ sessions: false });
  try {
    f.writeRegistry({
      schema: "0.20", team: { name: "repo", worktree_root: f.repo },
      seats: { scout: { status: "active", pane: "other/a:0.0", pane_id: "%7", session: "repo/other" } },
    });
    const d = f.door(["scout", "--pane", f.addr]);
    expect(d.code, d.out + d.err).toBe(0);
    const seats = f.seats();
    expect(seats["scout"]!["pane_id"]).toBe("%7"); // untouched incumbent
    // deriveHandle drops '-1' suffixes, so the mint starts at 2 (register-collision pin).
    expect(seats["scout-2"]!["pane_id"]).toBe("%2"); // the newcomer took the suffix
  } finally { removeScratchTree(f.root); }
}, 60000);

test("poll registration is JSON-pure on stdout and never prints human text first", () => {
  const f = fixture();
  try {
    const g = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as Record<string, unknown>;
    (g["teams"] as Record<string, unknown>)["repo"] = {
      root: f.repo, registry_location: f.registry, state: "registered",
    };
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(g));
    const d = f.door(["gw", "--delivery", "poll", "--team", "repo", "--json"]);
    expect(d.code, d.out + d.err).toBe(0);
    const parsed = JSON.parse(d.out) as { ok: boolean; receipt: Record<string, unknown> };
    expect(parsed.ok).toBe(true);
    expect(parsed.receipt["handle"]).toBe("gw");
    expect(d.err).not.toContain("tap register primer");
    const instance = f.seats().gw?.instance;
    expect(instance).toMatch(/^gw\|[a-f0-9]+$/);
    const rebound = f.door(["gw", "--delivery", "poll", "--team", "repo", "--json"]);
    expect(rebound.code, rebound.out + rebound.err).toBe(0);
    expect(f.seats().gw?.instance).toBe(instance);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("version briefing preserves quoted paths and JSON output without draining mail inline", () => {
  const f = fixture();
  try {
    const installRoot = join(f.root, "installed ' TAP");
    const scripts = join(installRoot, "skills/tap/scripts");
    mkdirSync(join(scripts, "smoke"), { recursive: true });
    writeFileSync(join(scripts, "lib.sh"), 'TAP_SENTINEL_VERSION="fixture"\ntap_spool_opportunistic_drain() { printf "%s\\n" "$1" "$TAP_REGISTRY" "$TAP_HOME" > "$TAP_TEST_DRAIN_RECORD"; }\n');
    writeFileSync(join(installRoot, "CHANGELOG.md"), '## TAP v0.23\nversion-banner\n');
    const drain = join(f.root, "drain-record"), version = join(f.root, "version-record");
    const seed = () => writeFileSync(version, JSON.stringify({ schema_version: 1, seats: { "repo/scout": { last_seen_version: "old" } } }));
    seed();
    const env = { TAP_SCRIPTS_DIR: scripts, TAP_SKIP_VERSION_BRIEFING: "0", TAP_TEST_DRAIN_RECORD: drain, TAP_VERSION_SEEN_PATH: version };
    const text = f.door(["scout", "--pane", f.addr], env);
    expect(text.code, text.out + text.err).toBe(0);
    expect(text.out).toContain("version-banner");
    expect(existsSync(drain), "registration invoked the retired inline drain").toBe(false);
    expect(JSON.parse(readFileSync(version, "utf8")).seats["repo/scout"].last_seen_version).toBe("0.23");
    seed();
    const json = f.door(["scout", "--pane", f.addr, "--json"], env);
    expect(json.code, json.out + json.err).toBe(0);
    expect(JSON.parse(json.out).ok).toBe(true);
    expect(json.out).not.toContain("version-banner");
    expect(JSON.parse(readFileSync(version, "utf8")).seats["repo/scout"].last_seen_version).toBe("0.23");
    for (const [args, extra] of [
      [["scout", "--pane", f.addr], { TAP_SKIP_VERSION_BRIEFING: "1" }],
      [["scout", "--offline"], {}],
    ] as const) {
      seed();
      const skipped = f.door([...args], { ...env, ...extra });
      expect(skipped.code, skipped.out + skipped.err).toBe(0);
      expect(skipped.out).not.toContain("version-banner");
      expect(JSON.parse(readFileSync(version, "utf8")).seats["repo/scout"].last_seen_version).toBe("old");
    }
    // A malformed briefing seat cannot fail an already-committed registration.
    writeFileSync(version, '{"schema_version":1,"seats":{"repo/scout":null}}');
    const malformed = f.door(["scout", "--pane", f.addr, "--json"], env);
    expect(malformed.code).toBe(0);
    expect(JSON.parse(malformed.out).ok).toBe(true);
    expect(malformed.err).toContain("invalid seat");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("a paused post-commit registration does not hold reset custody or refuse team sends", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const reached = `${barrier}.after-mutation.reached`;
  const release = `${barrier}.after-mutation.release`;
  f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: {
    sink: { status: "active", delivery: "poll", instance: "sink|test", harness: "daemon" },
  } });
  const child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--pane", f.addr], {
    cwd: f.repo, env: f.env({ TAP_REGISTER_POST_COMMIT_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 20000;
    while (!existsSync(reached) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(reached), "registration never reached its post-commit briefing").toBe(true);
    expect(f.seats().scout?.status).toBe("active");
    const send = Bun.spawnSync([join(ROOT, "bin/tap"), "send", "sink", "--from", "scout", "-m", "concurrent send"], {
      cwd: f.repo, env: f.env(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    expect(send.exitCode, send.stdout.toString() + send.stderr.toString()).toBe(0);
    expect(child.exitCode).toBeNull(); // Send completed while registration was paused.
  } finally {
    writeFileSync(release, "");
    await child.exited;
    removeScratchTree(f.root);
  }
}, 60000);

test("offline and poll registry contention is retryable, not registry corruption", () => {
  const f = fixture();
  const held = acquirePathLock(`${f.registry}.lock`, 1000, f.env());
  const fence = acquirePathLock(join(f.bus, "reset.fence.json.lock"), 1000, f.env());
  try {
    expect(held).not.toBeNull();
    expect(fence).not.toBeNull();
    const env = f.env({ TAP_REGISTER_LOCK_TIMEOUT: "0.01" });
    const rebind = () => f.registry;
    for (const run of [
      () => registerOffline(f.registry, "scout", f.repo, f.index, rebind, env, fence!),
      () => registerPoll(f.registry, "scout", f.repo, "", false, "", "repo", false, f.index, f.bus, "", false, rebind, env, fence!),
    ]) {
      let failure: unknown;
      try { run(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 1, errorClass: "registry_lock_busy" });
      expect(String(failure)).toContain("retry once the write completes");
    }
    expect(f.seats().scout).toBeUndefined();
  } finally {
    fence?.release();
    held?.release();
    removeScratchTree(f.root);
  }
});

test("a timed-out registry lock records acquired: false in the bind trace", () => {
  const f = fixture();
  const held = acquirePathLock(`${f.registry}.lock`, 1000, f.env());
  try {
    expect(held).not.toBeNull();
    const saved = { ...process.env };
    const traceEnv = f.env({ TAP_SESSION_SOURCE: "startup" });
    for (const key of Object.keys(process.env)) if (!(key in traceEnv)) delete process.env[key];
    Object.assign(process.env, traceEnv);
    try {
      const failure = ensureTeamBlock(f.registry, f.repo, "main", f.index, 50, () => f.registry, false);
      expect(failure).toMatchObject({ ok: false, code: 75 });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    const rows = readFileSync(join(f.index, "logs/startup.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const refused = rows.find(row => row.event === "register_lock_acquired");
    expect(refused).toMatchObject({ lock: "registry", stage: "team_block", acquired: false });
    expect(typeof refused!.wait_ms).toBe("number");
  } finally {
    held?.release();
    removeScratchTree(f.root);
  }
});

test("the default registry wait refuses and releases reset custody instead of waiting forever", async () => {
  const f = fixture();
  const barrier = join(f.root, "barrier");
  const stage = (name: string, kind: string) => `${barrier}.${name}.${kind}`;
  // Let pre-custody bootstrap finish before contending on the mutation's lock.
  writeFileSync(stage("after-entry-guard", "release"), "");
  writeFileSync(stage("holding-mutation-lock", "release"), "");
  const child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--pane", f.addr], {
    cwd: f.repo, env: f.env({ TAP_REGISTER_LOCK_TIMEOUT: "", TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let held: ReturnType<typeof acquirePathLock> = null;
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(stage("pre-mutation", "reached")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(stage("pre-mutation", "reached"))).toBe(true);
    held = acquirePathLock(`${f.registry}.lock`, 1000, f.env());
    expect(held).not.toBeNull();
    writeFileSync(stage("pre-mutation", "release"), "");
    const code = await child.exited;
    const error = await new Response(child.stderr).text();
    expect(code, error).toBe(1);
    expect(error).toContain("retry once the write completes");
    expect(f.seats().scout).toBeUndefined();
    const reset = acquirePathLock(join(f.bus, "reset.fence.json.lock"), 1000, f.env());
    try { expect(reset, "failed registration retained reset custody").not.toBeNull(); }
    finally { reset?.release(); }
  } finally {
    writeFileSync(stage("pre-mutation", "release"), "");
    held?.release();
    if (child.exitCode === null) child.kill();
    await child.exited;
    removeScratchTree(f.root);
  }
}, 30000);

test("default installation records and emits the version once using the explicit state path", () => {
  const f = fixture();
  try {
    const state = join(f.root, "version-state.json");
    writeFileSync(state, JSON.stringify({ schema_version: 1, seats: { "repo/scout": { last_seen_version: "0.0" } } }));
    const env = { TAP_SKIP_VERSION_BRIEFING: "0", TAP_SCRIPTS_DIR: "", TAP_VERSION_SEEN_PATH: state };
    const first = f.door(["scout", "--delivery", "poll"], env);
    expect(first.code, first.out + first.err).toBe(0);
    expect(first.out).toContain("TAP v");
    const stored = JSON.parse(readFileSync(state, "utf8"));
    expect(stored.seats["repo/scout"].last_seen_version).not.toBe("0.0");
    const second = f.door(["scout", "--delivery", "poll"], env);
    expect(second.code, second.out + second.err).toBe(0);
    expect(second.out).not.toContain("TAP v");
    expect(existsSync(join(f.home, ".tap", "version-seen.json"))).toBe(false);
  } finally { removeScratchTree(f.root); }
}, 60000);

test("first-entry bootstrap waits for both lock owners and preserves the winner's document", async () => {
  for (const scope of ["index", "team"] as const) {
    const f = fixture();
    const published = scope === "index" ? join(f.index, "global-registry.json") : f.registry;
    unlinkSync(published);
    const lockPath = scope === "index" ? join(f.index, "teams.json.lock") : `${f.registry}.lock`;
    const lock = acquirePathLock(lockPath, Infinity, f.env())!;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      // Locks are held in-process on an open descriptor, so a process waiting
      // for this one has the sidecar open: lsof names it beside this test.
      const openers = () => new Set(Bun.spawnSync(["lsof", "-t", "--", lockPath], { stdout: "pipe", stderr: "ignore" }).stdout.toString()
        .split("\n").filter(Boolean));
      const before = openers();
      child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--delivery", "poll", "--json"], {
        cwd: f.repo, env: f.env(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const deadline = Date.now() + 20000;
      let waiting = false;
      while (!waiting && child.exitCode === null && Date.now() < deadline) {
        waiting = [...openers()].some(pid => !before.has(pid));
        if (!waiting) await Bun.sleep(30);
      }
      // The parent owns the kernel lock; a second opener proves the child
      // reached acquisition, not that it acquired custody or published.
      const publishedBeforeLock = existsSync(published);
      const winner = scope === "index"
        ? { schema: "0.20", teams: { winner: { root: "/winner", registry_location: "/winner/registry.json" } } }
        : { schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: { winner: { status: "active", delivery: "poll", instance: "winner|kept" } } };
      writeFileSync(published, JSON.stringify(winner));
      lock.release();
      const code = await child.exited;
      const error = await new Response(child.stderr).text();
      expect(waiting, `${scope}: child never attempted the held lock: ${error}`).toBe(true);
      expect(publishedBeforeLock, `${scope}: bootstrap published before acquiring custody`).toBe(false);
      expect(code, error).toBe(0);
      const saved = JSON.parse(readFileSync(published, "utf8"));
      expect(scope === "index" ? saved.teams.winner : saved.seats.winner).toEqual(scope === "index" ? winner.teams!.winner : winner.seats!.winner);
      expect(f.seats().scout?.instance).toMatch(/^scout\|/);
    } finally {
      lock.release();
      if (child?.exitCode === null) { child.kill(); await child.exited; }
      removeScratchTree(f.root);
    }
  }
}, 60000);

test("reset-fence barrier: the transaction waits, reloads, and never loses a concurrent write", async () => {
  const f = fixture();
  try {
    const barrier = join(f.root, "barrier");
    const stage = (s: string, ext: string) => join(f.root, `barrier.${s}.${ext}`);
    const child = Bun.spawn([join(ROOT, "bin/tap"), "in", "scout", "--pane", f.addr], {
      cwd: f.repo, env: f.env({ TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" }) as NodeJS.ProcessEnv,
      stdout: "ignore", stderr: "ignore",
    });
    const deadline = Date.now() + 30000;
    for (const st of ["after-entry-guard", "pre-mutation", "holding-mutation-lock"]) {
      while (!existsSync(stage(st, "reached"))) {
        if (Date.now() > deadline) throw new Error(`barrier never reached ${st}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (st === "holding-mutation-lock") {
        // Concurrent writer commits WHILE the register transaction holds the fence+lock.
        const doc = JSON.parse(readFileSync(f.registry, "utf8")) as { seats: Record<string, unknown> };
        doc.seats["concurrent"] = { status: "active", delivery: "poll", harness: "daemon" };
        writeFileSync(f.registry, `${JSON.stringify(doc, null, 2)}\n`);
      }
      writeFileSync(stage(st, "release"), "1\n");
    }
    const code = await child.exited;
    expect(code).toBe(0);
    const seats = f.seats();
    expect(seats["concurrent"]).toBeTruthy(); // the concurrent write survived (no lost update)
    expect(seats["scout"]).toBeTruthy(); // and the registration landed on the reloaded doc
  } finally { removeScratchTree(f.root); }
}, 60000);

test("death after adoption starts still publishes the matching successor row", () => {
  const f = fixture();
  try {
    const marker = join(f.root, "pane-exited");
    const tmuxPath = join(f.bin, "tmux");
    const liveReply = "printf '%%2\\trepo/seat\\t4242\\tzsh\\t0\\n'";
    const tmux = readFileSync(tmuxPath, "utf8");
    expect(tmux).toContain(liveReply);
    writeFileSync(tmuxPath, tmux.replace(liveReply,
      "dead=0; [ ! -f \"$TEST_PANE_EXITED\" ] || dead=1; printf '%%2\\trepo/seat\\t4242\\tzsh\\t%s\\n' \"$dead\""));
    writeFileSync(join(f.bin, "bun"), `#!/bin/bash
"$TEST_REAL_BUN" "$@"
code=$?
case "$1:$2" in */seat-adopt.ts:adopt-batch) printf 1 > "$TEST_PANE_EXITED" ;; esac
exit "$code"
`, { mode: 0o755 });
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      old: { status: "active", pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch, instance: "old|i1", harness: "zsh" },
    } });
    seedPayload(f.bus, "adoption-race", "old");
    const result = f.door(["fresh", "--force", "--pane", f.addr], { TEST_PANE_EXITED: marker, TEST_REAL_BUN: process.execPath });
    expect(existsSync(marker), "adopt-batch did not run").toBe(true);
    expect(result.code, result.out + result.err).toBe(0);
    const seats = f.seats();
    expect(seats.old).toBeUndefined();
    expect(seats.fresh?.adopted_handles).toContain("old");
    expect(readFileSync(join(f.bus, "payloads/adoption-race.md"), "utf8")).toContain("to: fresh");
  } finally { removeScratchTree(f.root); }
}, 60_000);

test.each([
  ["claude", "CLAUDE_CODE_SESSION_ID"], ["codex", "CODEX_THREAD_ID"],
  ["cursor", "CURSOR_CONVERSATION_ID"], ["opencode", "OPENCODE_SESSION_ID"],
  ["agy", "ANTIGRAVITY_CONVERSATION_ID"],
])("native identity precedence: %s beats inherited generic identity", async (harness, nativeKey) => {
  const f = fixture();
  try {
    const path = join(f.bin, "tmux");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("zsh", harness));
    const run = f.door(["scout", "--pane", f.addr], { TAP_HARNESS_SESSION_ID: "stale-generic", [nativeKey]: "live-native" });
    expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 });
    const row = f.seats().scout!;
    expect(row.harness_session_id).toBe("live-native");
    if (harness === "agy") {
      const { buildInvocation } = await import("../src/launcher/invocation");
      const { Notices } = await import("../src/launcher/catalog-notices");
      const record = { ...row, name: "repo/scout", base: "repo", cwd: f.repo, harness, harness_session_id: String(row.harness_session_id) };
      expect(buildInvocation("resume", record, new Notices(() => {}), f.env(), null, null, null).argv)
        .toEqual(["agy", "--dangerously-skip-permissions", "--conversation", "live-native"]);
    }
  } finally { removeScratchTree(f.root); }
});

test("native identity precedence: explicit current invocation beats native and generic env", () => {
  const f = fixture();
  try {
    const path = join(f.bin, "tmux");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("zsh", "codex"));
    const run = f.door(["scout", "--pane", f.addr, "--harness-session-id", "current-hook"],
      { TAP_HARNESS_SESSION_ID: "stale-generic", CODEX_THREAD_ID: "native-env" });
    expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 });
    expect(f.seats().scout!.harness_session_id).toBe("current-hook");
  } finally { removeScratchTree(f.root); }
});

test("native identity precedence: unrelated native env cannot replace generic fallback", () => {
  const f = fixture();
  try {
    const path = join(f.bin, "tmux");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("zsh", "codex"));
    const run = f.door(["scout", "--pane", f.addr],
      { TAP_HARNESS_SESSION_ID: "generic-fallback", CODEX_THREAD_ID: "", ANTIGRAVITY_CONVERSATION_ID: "other-harness" });
    expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 });
    expect(f.seats().scout!.harness_session_id).toBe("generic-fallback");
  } finally { removeScratchTree(f.root); }
});


test.each([{ args: [] }, { args: [""] }])("native identity precedence: explicit operand requires a nonempty value %j", ({ args }) => {
  const f = fixture();
  try {
    const before = readFileSync(f.registry, "utf8");
    const run = f.door(["scout", "--harness-session-id", ...args]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("--harness-session-id needs a value");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
  } finally { removeScratchTree(f.root); }
});

test("native identity precedence: suppression also blanks an explicit identity", () => {
  const f = fixture();
  try {
    const run = f.door(["scout", "--pane", f.addr, "--harness-session-id", "explicit"],
      { TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE: "1", TAP_HARNESS_SESSION_ID: "generic", CODEX_THREAD_ID: "native" });
    expect({ code: run.code, err: run.err }).toMatchObject({ code: 0 });
    expect(f.seats().scout!.harness_session_id ?? "").toBe("");
  } finally { removeScratchTree(f.root); }
});

test("native identity precedence: help exposes the operand on both aliases", () => {
  const { lookupHelp } = require("../src/help");
  for (const verb of ["in", "register"]) {
    const help = lookupHelp([verb]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("--harness-session-id <id>");
    expect(help.stdout).toContain("outranks inherited TAP_HARNESS_SESSION_ID");
  }
});

test("tap-0alcw: the briefing reports the computed action, not a hardcoded registered", () => {
  const f = fixture();
  try {
    // Suspended-seat reactivation: the JSON receipt must say reactivated.
    // (A suspended row resuming under its own recorded session is the
    // reactivation shape: matchCandidate's session inequality is false, so
    // the computed action falls through to the wasSuspended arm.)
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      re1: { instance: "re1|one", status: "suspended", status_reason: "user_removed", delivery: "poll", pane: "", harness_session_id: "sess-react" },
    } });
    const react = f.door(["re1", "--pane", f.addr, "--json"], { TAP_HARNESS_SESSION_ID: "sess-react", TAP_SESSION_SOURCE: "resume" });
    expect(react.code, react.out + react.err).toBe(0);
    expect(JSON.parse(react.out).receipt.action).toBe("reactivated");
    // Same-pane identity update: the JSON receipt must say updated.
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      up1: { instance: "up1|one", status: "active", delivery: "pane", pane_id: "%2", pane: f.addr, harness_session_id: "sess-up-old", server_epoch: "srv:900:100" },
    } });
    const upd = f.door(["up1", "--pane", f.addr, "--json"], { TAP_HARNESS_SESSION_ID: "sess-up-new", TAP_SESSION_SOURCE: "resume" });
    expect(upd.code, upd.out + upd.err).toBe(0);
    expect(JSON.parse(upd.out).receipt.action).toBe("updated");
    // The text path distinguishes both from a genuinely new registration.
    const updText = f.door(["up1", "--pane", f.addr], { TAP_HARNESS_SESSION_ID: "sess-up-new2", TAP_SESSION_SOURCE: "resume" });
    expect(updText.code, updText.out + updText.err).toBe(0);
    expect(updText.out).toContain("UPDATED seat repo/up1");
    f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
      re2: { instance: "re2|one", status: "suspended", status_reason: "user_removed", delivery: "poll", pane: "", harness_session_id: "sess-react2" },
    } });
    const reactText = f.door(["re2", "--pane", f.addr], { TAP_HARNESS_SESSION_ID: "sess-react2", TAP_SESSION_SOURCE: "resume" });
    expect(reactText.code, reactText.out + reactText.err).toBe(0);
    expect(reactText.out).toContain("REACTIVATED seat repo/re2");
    expect(reactText.out).not.toContain("registered re2");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-f92fe: briefing scans count only canonical payloads, never drafts or side files", () => {
  const f = fixture();
  try {
    seedPayload(f.bus, "msg1", "scout");
    writeFileSync(join(f.bus, "payloads", "_draft.md"), `---\nfrom: sender\nto: scout\nid: _draft\nkind: ask\n---\n\nbody\n`);
    writeFileSync(join(f.bus, "payloads", ".side.md"), `---\nfrom: sender\nto: scout\nid: .side\nkind: ask\n---\n\nbody\n`);
    writeFileSync(join(f.bus, "payloads", "notes.txt"), `---\nfrom: sender\nto: scout\nid: notes\nkind: ask\n---\n\nbody\n`);
    // Outbound drafts from this seat need no done marker to count as history,
    // so they are what separates a filename-filtering history scan from a raw
    // directory walk (partner mutant H1). sent1 is the canonical positive
    // control: the count below is zero only if the filter works.
    for (const [name, id] of [["sent1.md", "sent1"], ["_out-draft.md", "_out-draft"], [".out-side.md", ".out-side"]] as Array<[string, string]>) {
      writeFileSync(join(f.bus, "payloads", name), `---\nfrom: scout\nto: peer\nid: ${id}\nkind: note\n---\n\nbody\n`);
    }
    const d = f.door(["scout", "--pane", f.addr, "--json"], { TAP_HARNESS_SESSION_ID: "sess-f92fe", TAP_SESSION_SOURCE: "resume" });
    expect(d.code, d.out + d.err).toBe(0);
    const j = JSON.parse(d.out);
    // The inbound draft, dotfile, and non-markdown side file with valid
    // frontmatter addressed to this handle are none of them inbox mail...
    expect(j.inbox.map((m: { id: string }) => m.id)).toEqual(["msg1"]);
    // ...and the outbound drafts are none of them history: only the canonical
    // send is (msg1 is unsettled, so it is not history).
    expect(j.seat_history.recent_count).toBe(1);
    expect(j.seat_history.last.id).toBe("sent1");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-zk1w: a pane registration with an unobservable generation refuses without writing an unstamped row", () => {
  const f = fixture();
  try {
    const d = f.door(["scout", "--pane", f.addr], { TAP_SERVER_EPOCH: "" });
    expect(d.code, d.out + d.err).toBe(1);
    expect(d.err).toContain("generation");
    expect(f.seats().scout).toBeUndefined();
    // The same registration stamps the row once the generation is observable.
    const ok = f.door(["scout", "--pane", f.addr]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(f.seats().scout!["server_epoch"]).toBe(f.epoch);
  } finally { removeScratchTree(f.root); }
}, 60000);

// Both sweep arms: the same pane id ("same pane") and a recycled/gone id whose
// address or session now belongs to the newcomer ("same session").
for (const [arm, paneId] of [["same pane", "%2"], ["same session", "%999"]] as const) {
  test(`tap-zk1w: a nameless registration never releases an unstamped row (${arm}) or adopts its mail`, () => {
    const f = fixture();
    try {
      f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: {
        old: { status: "active", delivery: "pane", pane: f.addr, pane_id: paneId, session: "repo/seat", harness: "claude", instance: "old|A" },
      } });
      seedPayload(f.bus, "sender-20260930T230500Z-aabbccddeeff", "old");
      const d = f.door(["--pane", f.addr]);
      expect(d.code, d.out + d.err).toBe(0);
      expect(d.err).not.toContain("released 'old'");
      expect(f.seats().old, d.out + d.err).toBeDefined();
      expect(readFileSync(join(f.bus, "payloads", "sender-20260930T230500Z-aabbccddeeff.md"), "utf8")).toContain("to: old");
    } finally { removeScratchTree(f.root); }
  }, 60000);
}

test("tap-zk1w: on a pristine machine an unobservable generation refuses before any index or registry is created", () => {
  const f = fixture();
  try {
    unlinkSync(join(f.index, "global-registry.json"));
    unlinkSync(f.registry);
    for (const args of [["scout", "--pane", f.addr], ["--pane", f.addr]]) {
      const d = f.door(args, { TAP_SERVER_EPOCH: "" });
      expect(d.code, d.out + d.err).toBe(1);
      expect(d.err).toContain("generation");
      expect(existsSync(join(f.index, "global-registry.json"))).toBe(false);
      expect(existsSync(f.registry)).toBe(false);
    }
  } finally { removeScratchTree(f.root); }
}, 60000);

// tap-rti5i: OpenCode exact resume reserves mode=exact_resume. The plugin's
// confirming `tap in` is a same-observation bind and must consume that
// expectation. A later in-app root session is then an ordinary identity
// update. Mismatch quarantine and every other capture mode stay as they are.
const EXACT_A = "ses_exact_a";
const EXACT_B = "ses_exact_b";

function opencodeDoor(f: ReturnType<typeof fixture>) {
  const path = join(f.bin, "tmux");
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("zsh", "opencode"));
  return (sessionId: string) => f.door(["scout", "--pane", f.addr], {
    OPENCODE_SESSION_ID: sessionId,
    TAP_HARNESS_SESSION_ID: "",
    TAP_SESSION_SOURCE: "",
    TAP_TRANSCRIPT_PATH: "",
    TAP_ACCEPT_OBSERVED_IDENTITY: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    CURSOR_CONVERSATION_ID: "",
    ANTIGRAVITY_CONVERSATION_ID: "",
  });
}

function seedCapturedSeat(f: ReturnType<typeof fixture>, mode: string, expected: string, observed: string, decision: "accepted" | "quarantined") {
  const capture: Record<string, string> = { mode };
  if (expected !== "") capture.expected_harness_session_id = expected;
  const result: Record<string, string> = {
    decision, mode, observed_harness_session_id: observed,
  };
  if (expected !== "") result.expected_harness_session_id = expected;
  if (decision === "quarantined") result.reason = "standing quarantine";
  f.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: f.repo }, seats: {
    scout: {
      instance: "scout|one", status: "active", delivery: "pane", harness: "opencode",
      harness_session_id: decision === "accepted" ? observed : "ses_older",
      pane: f.addr, pane_id: "%2", session: "repo/seat", server_epoch: f.epoch,
      transcript_path: "/prior/transcript.jsonl", note: "keep-me",
      identity_capture: capture, identity_capture_result: result,
      ...(decision === "quarantined" ? {
        quarantined_harness_session_id: observed,
        identity_quarantine_reason: "standing quarantine",
      } : {}),
    },
  } });
}

test("tap-rti5i: confirming an accepted exact_resume consumes the expectation so the next root session is accepted", () => {
  const f = fixture();
  try {
    const bind = opencodeDoor(f);
    seedCapturedSeat(f, "exact_resume", EXACT_A, EXACT_A, "accepted");
    const confirmed = bind(EXACT_A);
    expect(confirmed.code, confirmed.out + confirmed.err).toBe(0);
    const afterConfirm = f.seats().scout!;
    expect(afterConfirm.identity_capture, "the confirming same-observation bind must consume the expectation").toBeUndefined();
    expect(afterConfirm.harness_session_id).toBe(EXACT_A);
    expect(afterConfirm.identity_capture_result).toEqual({
      decision: "accepted", mode: "exact_resume",
      observed_harness_session_id: EXACT_A, expected_harness_session_id: EXACT_A,
    });
    expect(afterConfirm.transcript_path).toBe("/prior/transcript.jsonl");
    expect(afterConfirm.note).toBe("keep-me");
    expect(afterConfirm.identity_quarantine_reason).toBeUndefined();
    expect(afterConfirm.quarantined_harness_session_id).toBeUndefined();

    const switched = bind(EXACT_B);
    expect(switched.code, switched.out + switched.err).toBe(0);
    const afterSwitch = f.seats().scout!;
    expect(afterSwitch.harness_session_id, switched.err).toBe(EXACT_B);
    expect(afterSwitch.identity_capture).toBeUndefined();
    expect(afterSwitch.identity_quarantine_reason).toBeUndefined();
    expect(afterSwitch.quarantined_harness_session_id).toBeUndefined();
    expect(afterSwitch.identity_capture_result).toMatchObject({
      decision: "accepted", observed_harness_session_id: EXACT_B,
    });
    expect(afterSwitch.note).toBe("keep-me");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-rti5i: a mismatched exact_resume id stays quarantined and keeps the expectation", () => {
  const f = fixture();
  try {
    const bind = opencodeDoor(f);
    seedCapturedSeat(f, "exact_resume", EXACT_A, EXACT_A, "accepted");
    const mismatched = bind(EXACT_B);
    expect(mismatched.code, mismatched.out + mismatched.err).toBe(0);
    const row = f.seats().scout!;
    expect(row.harness_session_id).toBe(EXACT_A);
    expect(row.identity_capture).toEqual({ mode: "exact_resume", expected_harness_session_id: EXACT_A });
    expect(row.quarantined_harness_session_id).toBe(EXACT_B);
    expect(String(row.identity_quarantine_reason)).toContain("did not match");
    expect(row.identity_capture_result).toMatchObject({
      decision: "quarantined", observed_harness_session_id: EXACT_B, expected_harness_session_id: EXACT_A,
    });
  } finally { removeScratchTree(f.root); }
}, 60000);

test.each(["launcher_new", "untrusted_resume"] as const)("tap-rti5i: %s confirmation keeps the expectation and a later mismatch stays quarantined", (mode) => {
  const f = fixture();
  try {
    const bind = opencodeDoor(f);
    seedCapturedSeat(f, mode, EXACT_A, EXACT_A, "accepted");
    const confirmed = bind(EXACT_A);
    expect(confirmed.code, confirmed.out + confirmed.err).toBe(0);
    expect(f.seats().scout!.identity_capture).toEqual({ mode, expected_harness_session_id: EXACT_A });
    expect(f.seats().scout!.harness_session_id).toBe(EXACT_A);
    const mismatched = bind(EXACT_B);
    expect(mismatched.code, mismatched.out + mismatched.err).toBe(0);
    const row = f.seats().scout!;
    expect(row.harness_session_id).toBe(EXACT_A);
    expect(row.identity_capture).toEqual({ mode, expected_harness_session_id: EXACT_A });
    expect(row.quarantined_harness_session_id).toBe(EXACT_B);
    expect(String(row.identity_quarantine_reason)).toContain("did not match");
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-rti5i: an unattested same-observation bind keeps its capture, and a later id is still accepted", () => {
  const f = fixture();
  try {
    const bind = opencodeDoor(f);
    seedCapturedSeat(f, "unattested", "", EXACT_A, "accepted");
    const confirmed = bind(EXACT_A);
    expect(confirmed.code, confirmed.out + confirmed.err).toBe(0);
    expect(f.seats().scout!.identity_capture).toEqual({ mode: "unattested" });
    expect(f.seats().scout!.harness_session_id).toBe(EXACT_A);
    expect(f.seats().scout!.identity_capture_result).toEqual({
      decision: "accepted", mode: "unattested", observed_harness_session_id: EXACT_A,
    });
    const drifted = bind(EXACT_B);
    expect(drifted.code, drifted.out + drifted.err).toBe(0);
    const row = f.seats().scout!;
    expect(row.harness_session_id, drifted.err).toBe(EXACT_B);
    expect(row.identity_quarantine_reason).toBeUndefined();
    expect(row.quarantined_harness_session_id).toBeUndefined();
    expect(row.identity_capture_result).toMatchObject({
      decision: "accepted", observed_harness_session_id: EXACT_B,
    });
  } finally { removeScratchTree(f.root); }
}, 60000);

test("tap-rti5i: a quarantined exact_resume same-observation bind does not consume the expectation", () => {
  const f = fixture();
  try {
    const bind = opencodeDoor(f);
    seedCapturedSeat(f, "exact_resume", EXACT_A, EXACT_A, "quarantined");
    const again = bind(EXACT_A);
    expect(again.code, again.out + again.err).toBe(0);
    const row = f.seats().scout!;
    expect(row.identity_capture).toEqual({ mode: "exact_resume", expected_harness_session_id: EXACT_A });
    expect(row.harness_session_id).toBe("ses_older");
    expect(row.quarantined_harness_session_id).toBe(EXACT_A);
    expect(row.identity_quarantine_reason).toBe("standing quarantine");
    expect(row.identity_capture_result).toMatchObject({ decision: "quarantined", observed_harness_session_id: EXACT_A });
  } finally { removeScratchTree(f.root); }
}, 60000);
