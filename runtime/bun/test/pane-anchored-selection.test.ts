// Pane-anchored selection from an unenrolled linked worktree (B4 tap-7s1r U1).
//
// A pane registered on team `tap` running TAP bus verbs from an UNENROLLED
// LINKED WORKTREE of the same Git repo must resolve native context through
// that pane's existing team. The observed tmux session name is only a HINT
// (the handle is never trusted; the authoritative enrolled-pane registry row
// decides after exact pane/session/current-epoch checks), the caller cwd and
// the resolved team root must share one canonical git common directory, and a
// foreign-repo cwd never selects the pane team. Every arm that cannot anchor
// rethrows the ORIGINAL unanchored_bus refusal unchanged; a cross-team
// contest escalates as pane_contested; explicit --team and TAP_HOME keep
// their precedence; the launcher keeps refusing pane-anchored contexts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { globalRegistryPath } from "../src/index-home";
import * as selector from "../src/selector";
import { enrolledSeatForObservedPane } from "../src/registry";
import { walkUpSessionRoot } from "../src/session-start";
import { missingLocalTeam } from "../src/onboarding";
import { resolveContext, TapError } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const MAIN = resolve(import.meta.dir, "..", "main.ts");
const scratch: string[] = [];
let lane = 0;

afterEach(() => {
  for (const path of scratch.splice(0)) {
    removeScratchTree(path);
  }
});

interface SeatOverrides {
  pane_id?: string;
  session?: string;
  server_epoch?: string;
  delivery?: string;
}

const glmSeat = (over: SeatOverrides = {}) => ({
  status: "active",
  delivery: "pane",
  harness: "claude",
  pane: "tap-glm:0.0",
  pane_id: "%7",
  session: "tap/glm",
  registered_at: "2026-09-19T00:00:00Z",
  server_epoch: "srv:123:456",
  instance: "glm|A",
  ...over,
});

function repoWithWorktree(repo: string, wt?: string) {
  mkdirSync(repo, { recursive: true });
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const commit = spawnSync("git", [
    "-C", repo, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-q", "--allow-empty", "-m", "init",
  ], { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  if (wt) {
    const add = spawnSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", `lane-${++lane}`], { encoding: "utf8" });
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
  }
}

interface TeamOpts {
  seats?: Record<string, unknown>;
  registryMissing?: boolean;
  registryDir?: boolean;
  registryBytes?: string;
}

function enroll(index: string, root: string, team: string, opts: TeamOpts = {}) {
  const registry = join(root, ".tap", "team-registry.json");
  const bus = join(root, ".tap", "bus");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  if (!opts.registryMissing) {
    mkdirSync(dirnameOf(registry), { recursive: true });
    if (opts.registryDir) {
      mkdirSync(registry, { recursive: true });
    } else {
      writeFileSync(registry, opts.registryBytes ??
        JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: root }, seats: opts.seats ?? {} }));
    }
  }
  let teams: Record<string, unknown> = {};
  try {
    teams = (JSON.parse(readFileSync(globalRegistryPath(index), "utf8")) as { teams?: Record<string, unknown> }).teams ?? {};
  } catch { /* first enroll */ }
  teams[team] = { enrolled_at: "2026-09-01T00:00:00Z", registry_location: registry, root, state: "registered" };
  writeFileSync(globalRegistryPath(index), JSON.stringify({ schema: "0.20", migrated: {}, teams }));
  return { registry, bus };
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

interface FixtureOpts {
  session?: string;   // session name the fake tmux reports for the calling pane
  noTty?: boolean;    // fake ps reports no controlling tty (pane unobservable)
  ghostTeams?: boolean; // enroll two data-gone unrelated teams (missing registries)
  glm?: SeatOverrides;
  extraSeats?: Record<string, unknown>;
}

function fixture(opts: FixtureOpts = {}) {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-pane-anchor."));
  scratch.push(dir);
  const index = join(dir, "index");
  mkdirSync(index, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const trace = join(dir, "observe.trace");
  const session = opts.session ?? "tap/glm";
  // The fake ps/tmux pair models the calling pane without trusting the
  // runner's real ancestry; the tmux stub leaves a trace so tests can prove
  // the observation actually ran (or, in the unobservable arm, never ran).
  writeFileSync(join(bin, "ps"), `#!/bin/sh\n${opts.noTty ? "" : "printf '123 faketty\\n'\n"}exit 0\n`);
  writeFileSync(join(bin, "tmux"), [
    "#!/bin/sh",
    `echo "tmux $1" >> '${trace}'`,
    'case "$1" in',
    "  list-panes) printf '%%7\\t/dev/faketty\\n' ;;",
    '  display-message)',
    '    for a in "$@"; do',
    '      case "$a" in',
    "        *'#{pane_tty}'*) printf '%%7\\t/dev/faketty\\t" + session + "\\t123:456\\n'; exit 0 ;;",
    "        *'#{pane_id}\t#{session_name}\t#{pid}:#{start_time}'*) printf '%%7\t" + session + "\t123:456\n'; exit 0 ;;",
    "        *'#{session_name}'*) printf '" + session + "\\t123:456\\n'; exit 0 ;;",
    "        *'#{pid}:#{start_time}'*) printf '123:456\\n'; exit 0 ;;",
    "      esac",
    "    done",
    "    printf '%%7\\t/dev/faketty\\n' ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "ps"), 0o755);
  chmodSync(join(bin, "tmux"), 0o755);
  const repo = join(dir, "repo");
  const wt = join(dir, "wt");
  repoWithWorktree(repo, wt);
  const team = enroll(index, repo, "tap", {
    seats: { glm: glmSeat(opts.glm), ...(opts.extraSeats ?? {}) },
  });
  if (opts.ghostTeams) {
    // Data-gone unrelated enrollments: their registries are missing and hold
    // no rows, so neither the scoped nor the unscoped verdict is vetoed.
    enroll(index, join(dir, "ghost-a"), "ghost-a", { registryMissing: true });
    enroll(index, join(dir, "ghost-b"), "ghost-b", { registryMissing: true });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAP_INDEX_HOME: index,
    TMUX: "/fake,1,0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  delete env.TAP_HOME;
  delete env.TAP_REGISTRY;
  delete env.TAP_SELF;
  delete env.TAP_SERVER_EPOCH;
  delete env.TAP_TMUX_SOCKET;
  delete env.TAP_TMUX_SOCKET_PATH;
  return { dir, index, bin, trace, env, repo, wt, ...team };
}

function seedPayload(bus: string, fields: Record<string, string>, body: string): string {
  const id = fields.id!;
  const path = join(bus, "payloads", `${id}.md`);
  writeFileSync(path, [
    "---",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "---",
    body,
    "",
  ].join("\n"));
  writeFileSync(join(bus, "receipts", `${id}.placed`), "{}\n");
  return path;
}

function refusal(fn: () => unknown): TapError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TapError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function spawn(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
}


/** Build an alternate acting registry and the git shim that atomically swaps
 * the live index to `mutate(originalTeams, alternateRegistry)` right after the
 * second repository-discovery probe has emitted its result. */
function indexSwapShim(
  f: ReturnType<typeof fixture>,
  mutate: (teams: Record<string, unknown>, alternateRegistry: string) => Record<string, unknown>,
) {
  const originalIndex = readFileSync(globalRegistryPath(f.index), "utf8");
  const alternateRegistry = join(f.dir, "alternate-registry.json");
  writeFileSync(alternateRegistry, JSON.stringify({
    schema: "0.20", team: { name: "tap", worktree_root: f.repo },
    seats: { glm: glmSeat() },
  }));
  const snapshot = JSON.parse(originalIndex) as { teams: Record<string, unknown> };
  const newIndex = join(f.dir, "new-index.json");
  writeFileSync(newIndex, JSON.stringify({
    schema: "0.20", migrated: {}, teams: mutate(snapshot.teams, alternateRegistry),
  }));
  writeFileSync(globalRegistryPath(f.index), originalIndex);
  const realGit = "/usr/bin/git";
  const counter = join(f.dir, "git-probes.count");
  writeFileSync(join(f.bin, "git"), [
    "#!/bin/sh",
    'is_probe=false; case "$@" in *--path-format=absolute*--git-common-dir*|*--git-common-dir*--path-format=absolute*) is_probe=true ;; esac',
    `out=$('${realGit}' "$@")`,
    `if $is_probe; then n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; [ "$n" -eq 2 ] && cp '${newIndex}' '${globalRegistryPath(f.index)}'; fi`,
    'printf \'%s\' "$out"',
    "",
  ].join("\n"));
  chmodSync(join(f.bin, "git"), 0o755);
  return { alternateRegistry, counter };
}

describe("pane-anchored selection from an unenrolled linked worktree (tap-7s1r)", () => {
  test("resolveContext anchors through the pane's enrolled team", () => {
    const f = fixture();
    const ctx = resolveContext(f.wt, f.env);
    expect(ctx.team).toBe("tap");
    expect(ctx.selection?.source).toBe("pane");
    expect(ctx.selection?.authority).toBe("enrolled");
    expect(ctx.selection?.marker).toBe("live");
    expect(ctx.registryPath).toBe(f.registry);
    expect(ctx.root).toBe(realpathSync(f.repo));
    // the observation actually ran through the fake pane
    const observed = existsSync(f.trace) ? readFileSync(f.trace, "utf8") : "";
    expect(observed).toContain("list-panes");
    expect(observed).toContain("display-message");
  });

  test("whoami resolves the registered handle from the linked worktree", () => {
    const f = fixture();
    const r = spawn(f.wt, f.env, "whoami", "--json");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { handle?: string; team?: string };
    expect(out.handle).toBe("glm");
    expect(out.team).toBe("tap");
  });

  test("team --context names the pane's existing team and bus", () => {
    const f = fixture();
    const r = spawn(f.wt, f.env, "team", "--context", "--json");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { team?: string };
    expect(out.team).toBe("tap");
  });

  test("outstanding is not unanchored from the linked worktree", () => {
    const f = fixture();
    const id = "glm-20260919T000001Z-abcdef123456";
    seedPayload(f.bus, {
      id,
      from: "glm",
      to: "snd",
      kind: "discuss",
      path: join(f.bus, "payloads", `${id}.md`),
      reply: "expected",
    }, "pending outbound");
    const r = spawn(f.wt, f.env, "outstanding", "glm", "--json");
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(id);
    expect(`${r.stdout}${r.stderr}`).not.toContain("unanchored");
  });

  test("tap reply settles on the pane team's bus without repair flags", () => {
    const f = fixture({
      extraSeats: { snd: { status: "active", delivery: "poll", harness: "codex", instance: "snd|A" } },
    });
    // a second enrolled team with its own bus: a wrong-team settlement would
    // drop its receipt there instead of on the pane team's bus
    const elsewhere = enroll(f.index, join(f.dir, "elsewhere"), "elsewhere", { seats: {} });
    const id = "fable-20260919T000000Z-abcdef123456";
    seedPayload(f.bus, {
      id,
      from: "snd",
      to: "glm",
      kind: "discuss",
      path: join(f.bus, "payloads", `${id}.md`),
      reply: "expected",
    }, "pending inbound");
    const r = spawn(f.wt, f.env, "reply", id, "-m", "ack");
    expect(r.status).toBe(0);
    const done = join(f.bus, "receipts", `${id}.done`);
    expect(existsSync(done)).toBe(true);
    const receipt = JSON.parse(readFileSync(done, "utf8")) as { by?: string; via?: string };
    expect(receipt.by).toBe("glm");
    expect(receipt.via).toBe("reply");
    expect(existsSync(join(elsewhere.bus, "receipts", `${id}.done`))).toBe(false);
  });

  test("session launch --dry-run keeps refusing pane-anchored contexts", () => {
    const f = fixture();
    const launch = spawn(f.wt, f.env, "session", "launch", "claude", "--dry-run");
    expect(launch.status).not.toBe(0);
    expect(`${launch.stdout}${launch.stderr}`).toContain("refusing implicit enrollment");
  });

  test("explicit --team keeps precedence over the pane hint", () => {
    const f = fixture();
    const ctx = resolveContext(f.wt, f.env, { explicitTeam: "tap" });
    expect(ctx.team).toBe("tap");
    expect(ctx.selection?.source).toBe("explicit-team");
  });

  test("TAP_HOME keeps precedence over the pane hint", () => {
    const f = fixture();
    const ctx = resolveContext(f.wt, { ...f.env, TAP_HOME: f.bus });
    expect(ctx.selection?.source).toBe("env");
  });

  test("an enrolled linked worktree keeps cwd ownership (never pane source)", () => {
    const f = fixture();
    enroll(f.index, f.wt, "wt-team", { seats: {} });
    const ctx = resolveContext(f.wt, f.env);
    expect(ctx.team).toBe("wt-team");
    expect(ctx.selection?.source).toBe("cwd");
    expect(ctx.selection?.authority).toBe("enrolled");
  });

  test("a foreign-repo cwd never selects the pane team", () => {
    const f = fixture();
    const foreign = join(f.dir, "foreign");
    repoWithWorktree(foreign);
    const err = refusal(() => resolveContext(foreign, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("contaminated Git routing vars cannot fake a same-repo match", () => {
    const f = fixture();
    const foreign = join(f.dir, "foreign");
    repoWithWorktree(foreign);
    // GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR point at the pane team's repo: an
    // inherited-env git probe would report one common directory for both cwds
    // and anchor a foreign repo through the pane.
    const contaminated: NodeJS.ProcessEnv = {
      ...f.env,
      GIT_DIR: join(f.repo, ".git"),
      GIT_COMMON_DIR: join(f.repo, ".git"),
      GIT_WORK_TREE: f.repo,
    };
    const err = refusal(() => resolveContext(foreign, contaminated));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("an index swap to the current alternate registry is honored", () => {
    const f = fixture();
    // Same team, same root, same handle — but the swap moves the acting
    // registry to an ALTERNATE path. The final row validation reads the
    // swapped index, and the returned selection must bind to that current
    // registry, never the retired one.
    const swap = indexSwapShim(f, (teams, alternateRegistry) => ({
      ...teams,
      tap: { ...(teams.tap as Record<string, unknown>), registry_location: alternateRegistry },
    }));
    const ctx = resolveContext(f.wt, f.env);
    expect(ctx.selection?.source).toBe("pane");
    expect(ctx.team).toBe("tap");
    expect(realpathSync(ctx.registryPath)).toBe(realpathSync(swap.alternateRegistry));
    expect(Number(readFileSync(swap.counter, "utf8"))).toBe(2);
  });

  // tap-a9lcr: `Selection.registryLocation` is the lock-sidecar identity, so two literal paths to
  // one registry file would mean two locks on one registry. The re-entry must bind to the LITERAL
  // path the final enrolled row named, not just its realpath.
  function pointIndexAt(f: ReturnType<typeof fixture>, location: string) {
    const doc = JSON.parse(readFileSync(globalRegistryPath(f.index), "utf8")) as { teams: Record<string, Record<string, unknown>> };
    doc.teams.tap!.registry_location = location;
    writeFileSync(globalRegistryPath(f.index), JSON.stringify(doc));
  }

  test("a symlink alias written into the index between the final read and the re-entry is refused (tap-a9lcr)", () => {
    const f = fixture();
    const alias = join(f.dir, "registry-alias.json");
    symlinkSync(f.registry, alias);
    const original = selector.selectCaller;
    let flipped = 0;
    // Test-only spy on the module boundary: flip the index to the alias right before the pinned-root
    // re-entry, i.e. after the final enrolled-row read and before selectCaller.
    const spy = spyOn(selector, "selectCaller").mockImplementation((input) => {
      if (input.pinnedRoot !== undefined) { pointIndexAt(f, alias); flipped += 1; }
      return original(input);
    });
    try {
      const err = refusal(() => resolveContext(f.wt, f.env));
      // The ORIGINAL saved refusal, not a new message: same class, exit and action as an
      // unenrolled worktree whose pane cannot be observed at all.
      const baseline = refusal(() => { const g = fixture({ noTty: true }); return resolveContext(g.wt, g.env); });
      expect(err.errorClass).toBe("unanchored_bus");
      expect([err.code, err.errorClass, err.action]).toEqual([baseline.code, baseline.errorClass, baseline.action]);
      expect(flipped).toBe(1);
      expect(realpathSync(alias)).toBe(realpathSync(f.registry));
    } finally {
      spy.mockRestore();
    }
  });

  test("an index whose literal registry path is already a stable symlink still anchors (tap-a9lcr control)", () => {
    const f = fixture();
    const alias = join(f.dir, "registry-alias.json");
    symlinkSync(f.registry, alias);
    pointIndexAt(f, alias);
    const ctx = resolveContext(f.wt, f.env);
    expect(ctx.selection?.source).toBe("pane");
    expect(ctx.registryPath).toBe(alias);
  });

  test("a replacement team at the swapped root is refused", () => {
    const f = fixture();
    const swap = indexSwapShim(f, (teams, alternateRegistry) => {
      const withoutTap = { ...teams };
      delete withoutTap.tap;
      return {
        ...withoutTap,
        impostor: {
          enrolled_at: "2026-09-01T00:00:00Z",
          registry_location: alternateRegistry,
          root: f.repo,
          state: "registered",
        },
      };
    });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(Number(readFileSync(swap.counter, "utf8"))).toBe(2);
  });

  // tap-sbvgt: a second team that enrolls a current claim on the same pane
  // INSIDE the repository-probe window. The pre-probe uniqueness check has
  // already passed, so only a post-probe global recheck can see the contest.
  function rivalClaimDuringProbes(f: ReturnType<typeof fixture>) {
    const rivalRoot = join(f.dir, "rival");
    const rivalRegistry = join(rivalRoot, ".tap", "team-registry.json");
    mkdirSync(join(rivalRoot, ".tap", "bus", "payloads"), { recursive: true });
    mkdirSync(join(rivalRoot, ".tap", "bus", "receipts"), { recursive: true });
    writeFileSync(rivalRegistry, JSON.stringify({
      schema: "0.20", team: { name: "rival", worktree_root: rivalRoot }, seats: { twin: glmSeat() },
    }));
    return indexSwapShim(f, (teams) => ({
      ...teams,
      rival: { enrolled_at: "2026-09-01T00:00:00Z", registry_location: rivalRegistry, root: rivalRoot, state: "registered" },
    }));
  }

  test("a rival claim enrolled during the repository probes is refused (tap-sbvgt)", () => {
    const f = fixture();
    const swap = rivalClaimDuringProbes(f);
    const err = refusal(() => resolveContext(f.wt, f.env));
    // The ORIGINAL saved refusal: same class, exit and action as an
    // unenrolled worktree whose pane cannot be observed at all.
    const baseline = refusal(() => { const g = fixture({ noTty: true }); return resolveContext(g.wt, g.env); });
    expect([err.code, err.errorClass, err.action]).toEqual([baseline.code, baseline.errorClass, baseline.action]);
    expect(Number(readFileSync(swap.counter, "utf8"))).toBe(2);
  });

  // Caller contract, not the causal proof (the resolveContext test above is):
  // once a rival claim lands mid-probe, the verb still reports its own typed
  // contest exit rather than acting on the pane team.
  test("outstanding reports a mid-probe rival claim at its own contest exit (tap-sbvgt)", () => {
    const f = fixture();
    const swap = rivalClaimDuringProbes(f);
    const r = spawn(f.wt, f.env, "outstanding", "glm", "--json");
    expect(Number(readFileSync(swap.counter, "utf8"))).toBeGreaterThanOrEqual(2);
    expect(r.status).toBe(4);
    expect(`${r.stdout}${r.stderr}`).toContain("pane_contested");
  });

  test("missingLocalTeam classifies absent cwd registries without pane observation", () => {
    // Cross-repo specimen: the pane anchors through `tap`, but the cwd is a
    // foreign repo with no local team — the classifier must answer from
    // filesystem absence alone, never by observing the pane.
    const f = fixture();
    const foreign = join(f.dir, "foreign");
    repoWithWorktree(foreign);
    expect(missingLocalTeam(foreign, f.env)).toBe(true);
    const observed = existsSync(f.trace) ? readFileSync(f.trace, "utf8") : "";
    expect(observed).not.toContain("tmux");
  });

  test("an unrelated data-gone enrollment does not veto the anchor (tap-xbpuc)", () => {
    const f = fixture();
    // One unrelated enrolled root whose acting registry is positively absent
    // holds zero rows: it cannot hide a second claimant, so the anchor stands.
    enroll(f.index, join(f.dir, "flaky"), "flaky", { registryMissing: true });
    const ctx = resolveContext(f.wt, f.env);
    expect(ctx.team).toBe("tap");
  });

  test("an operator-style session without team/handle never anchors", () => {
    const f = fixture({ session: "bare" });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("a legacy team:handle session never confers team scope", () => {
    const f = fixture({ session: "tap:glm" });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("an absent machine index never answers from a legacy index, scoped or not", () => {
    const f = fixture();
    rmSync(globalRegistryPath(f.index));
    writeFileSync(join(f.index, "teams.json"), JSON.stringify({ teams: { tap: { root: f.repo } } }));
    const noIndex = { kind: "no_authority", evidence: "no machine index is present" } as const;
    expect(enrolledSeatForObservedPane("%7", "tap/glm", "srv:123:456", f.index, { team: "tap" })).toEqual(noIndex);
    expect(enrolledSeatForObservedPane("%7", "tap/glm", "srv:123:456", f.index)).toEqual(noIndex);
  });

  test("an unobservable pane refuses without spawning tmux", () => {
    const f = fixture({ noTty: true });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
    const observed = existsSync(f.trace) ? readFileSync(f.trace, "utf8") : "";
    expect(observed).not.toContain("tmux");
  });

  test("a cross-team contest returns the saved original refusal to verbs", () => {
    const f = fixture();
    // a second LIVE team's registry claims the same pane with the same
    // session and current generation: an ordinary failed anchor, so the
    // verb's own handler recomputes the typed verdict
    enroll(f.index, join(f.dir, "rival"), "rival", {
      seats: { twin: glmSeat() },
    });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("whoami recomputes a cross-team contest at its own exit code", () => {
    const f = fixture();
    enroll(f.index, join(f.dir, "rival"), "rival", { seats: { twin: glmSeat() } });
    const r = spawn(f.wt, f.env, "whoami", "--json");
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("pane_contested");
  });

  test("outstanding recomputes a cross-team contest at its own exit code", () => {
    const f = fixture();
    enroll(f.index, join(f.dir, "rival"), "rival", { seats: { twin: glmSeat() } });
    const r = spawn(f.wt, f.env, "outstanding", "glm", "--json");
    expect(r.status).toBe(4);
    expect(`${r.stdout}${r.stderr}`).toContain("pane_contested");
  });

  test("a within-team contest keeps the original unanchored refusal", () => {
    const f = fixture({
      extraSeats: { glm2: glmSeat() },
    });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.errorClass).not.toBe("pane_contested");
  });

  test("a missing scoped registry keeps the original unanchored refusal", () => {
    const f = fixture();
    rmSync(f.registry);
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("an unreadable scoped registry keeps the original unanchored refusal", () => {
    const f = fixture();
    rmSync(f.registry);
    mkdirSync(f.registry, { recursive: true });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("a malformed scoped registry keeps the original unanchored refusal", () => {
    const f = fixture();
    writeFileSync(f.registry, "not json at all");
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("a stale prior-generation row keeps the original unanchored refusal", () => {
    const f = fixture({ glm: { server_epoch: "srv:999:1" } });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("an unstamped row keeps the original unanchored refusal", () => {
    const f = fixture({ glm: { server_epoch: undefined } });
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
  });

  test("an absent machine marker refuses unanchored_bus and never re-anchors through the pane", () => {
    const f = fixture();
    rmSync(globalRegistryPath(f.index));
    const err = refusal(() => resolveContext(f.wt, f.env));
    expect(err.errorClass).toBe("unanchored_bus");
    expect(err.action).toBe("tap init  OR  tap session launch");
  });
});

describe("nested parent enrollment cannot capture a child checkout", () => {
  test("native verb and SessionStart selection matrix", () => {
    const f = fixture({ extraSeats: {
      snd: { status: "active", delivery: "poll", harness: "codex", instance: "snd|A" },
    } });
    const parent = enroll(f.index, f.dir, "parent");
    const sub = join(f.repo, "sub"), wtSub = join(f.wt, "sub");
    mkdirSync(sub); mkdirSync(wtSub);
    const rows: unknown[] = [];
    for (const [i, cwd] of [f.repo, sub, f.wt, wtSub].entries()) {
      const ctx = resolveContext(cwd, f.env);
      expect(ctx.team).toBe("tap");
      const who = spawn(cwd, f.env, "whoami", "--json");
      expect(who.status).toBe(0);
      expect(JSON.parse(who.stdout).team).toBe("tap");
      const id = `snd-20260924T00000${i}Z-abcdef123456`;
      seedPayload(f.bus, { id, from: "snd", to: "glm", reply: "expected", kind: "discuss",
        path: join(f.bus, "payloads", `${id}.md`) }, "nested routing request");
      const read = spawn(cwd, f.env, "read", id);
      expect(read.status).toBe(0);
      const reply = spawn(cwd, f.env, "reply", id, "-m", "nested routing reply");
      expect(reply.status).toBe(0);
      expect(existsSync(join(f.bus, "receipts", `${id}.done`))).toBe(true);
      expect(existsSync(join(parent.bus, "receipts", `${id}.done`))).toBe(false);
      const outbound = `glm-20260924T01000${i}Z-abcdef123456`;
      const send = spawn(cwd, f.env, "send", "snd", "-m", "nested routing send", "--id", outbound);
      expect(send.status).toBe(0);
      expect(existsSync(join(f.bus, "payloads", `${outbound}.md`))).toBe(true);
      expect(existsSync(join(parent.bus, "payloads", `${outbound}.md`))).toBe(false);
      const launch = spawn(cwd, f.env, "session", "launch", "claude", "--dry-run");
      const hookRoot = walkUpSessionRoot(cwd, f.index);
      if (i < 2) {
        expect(launch.status).toBe(0);
        expect(launch.stdout).toContain("tap/claude");
      } else {
        expect(launch.status).not.toBe(0);
        expect(`${launch.stdout}${launch.stderr}`).toContain("refusing implicit enrollment");
      }
      for (const mode of ["codex", "cursor", "claude"]) {
        const hook = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/session-start.ts"), mode], {
          cwd, env: { ...f.env, TAP_HOME: parent.bus, CLAUDE_PROJECT_DIR: undefined, PWD: cwd },
          input: JSON.stringify({ cwd, workspace_roots: [cwd] }) + "\n", encoding: "utf8", timeout: 30_000,
        });
        expect(hook.status).toBe(0);
        if (i < 2) expect(hook.stdout).toContain("on team tap");
        else expect(hook.stdout).toBe("");
      }
      rows.push({ cwd: cwd.replace(f.dir, "<parent>"), team: ctx.team, source: ctx.selection?.source,
        whoami: JSON.parse(who.stdout).team, send: "tap", read: "tap", reply: "tap",
        launch: { status: launch.status, output: `${launch.stdout}${launch.stderr}`.replaceAll(f.dir, "<parent>") },
        hookRoot: hookRoot.replace(f.dir, "<parent>") });
    }
    console.log("nested routing matrix", JSON.stringify(rows, null, 2));
    // A linked checkout has no local enrollment. Hooks must remain silent,
    // never infer enrollment from the unrelated containing folder.
    expect(walkUpSessionRoot(f.repo, f.index)).toBe(realpathSync(f.repo));
    expect(walkUpSessionRoot(sub, f.index)).toBe(realpathSync(f.repo));
    expect(walkUpSessionRoot(f.wt, f.index)).toBe("");
    expect(walkUpSessionRoot(wtSub, f.index)).toBe("");
  }, 120_000);

  test("hooks retain local enrollment, Gitless ancestry, and fail-closed child authority", () => {
    const f = fixture();
    enroll(f.index, f.dir, "parent");
    const loose = join(f.dir, "loose"); mkdirSync(loose);
    expect(walkUpSessionRoot(loose, f.index)).toBe(realpathSync(f.dir));
    // A bus file is not enrollment; hooks cannot gain authority from it.
    const localBus = join(f.wt, ".tap", "bus"); mkdirSync(localBus, { recursive: true });
    writeFileSync(join(localBus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "local" }, seats: {} }));
    expect(walkUpSessionRoot(f.wt, f.index)).toBe("");
    enroll(f.index, f.wt, "linked");
    const sub = join(f.wt, "sub"); mkdirSync(sub);
    expect(walkUpSessionRoot(f.wt, f.index)).toBe(realpathSync(f.wt));
    expect(walkUpSessionRoot(sub, f.index)).toBe(realpathSync(f.wt));
    // An unreachable inner enrollment cannot make the parent authoritative.
    const inner = join(f.repo, "inner"); mkdirSync(inner);
    const unavailable = enroll(f.index, inner, "inner");
    renameSync(unavailable.registry, `${unavailable.registry}.unavailable`);
    expect(walkUpSessionRoot(inner, f.index)).toBe("");
    expect(walkUpSessionRoot(join(f.dir, "missing"), f.index)).toBe("");
  });

  test("enrolled old-format roots still warn through each hook adapter", () => {
    const f = fixture();
    enroll(f.index, f.dir, "parent");
    writeFileSync(f.registry, JSON.stringify({ team: { name: "tap" }, agents: { glm: glmSeat() } }));
    for (const mode of ["codex", "cursor", "claude"]) {
      const hook = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/session-start.ts"), mode], {
        cwd: f.repo, env: { ...f.env, CLAUDE_PROJECT_DIR: undefined, PWD: f.repo },
        input: JSON.stringify({ cwd: f.repo, workspace_roots: [f.repo] }) + "\n", encoding: "utf8", timeout: 30_000,
      });
      expect(hook.status).toBe(0);
      expect(hook.stdout).toContain("but its team registry is in an old format (old_store):");
      expect(hook.stdout).not.toContain("TAP: registered as");
      expect(hook.stdout).not.toContain("this seat is not registered");
    }
  });
});
