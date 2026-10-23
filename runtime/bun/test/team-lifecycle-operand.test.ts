// `tap team down|up|shutdown [<team>]` (tap-lg1a5): the lifecycle verbs take
// the same optional enrolled-team operand as `tap team roster [<team>]`,
// resolved through the machine index and never through cwd. Every case runs
// the shipped entry from the LOCAL team's checkout and names the FOREIGN team,
// then compares against the same verb run bare from the foreign checkout.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";
import { physicalSocketPath } from "../src/tmux";

const repo = resolve(import.meta.dir, "../../..");
const shippedEntry = join(repo, "bin/tap");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
});

type Row = Record<string, unknown>;

function checkout(dir: string, name: string, team: string, seats: Record<string, Row>): { root: string; registry: string } {
  const root = join(dir, name);
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "AGENTS.md"), "<!-- tap:begin -->\nTAP\n<!-- tap:end -->");
  const registry = join(root, ".tap", "team-registry.json");
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: root }, seats }, null, 2)}\n`);
  return { root, registry };
}

// A suspended, relaunchable pane seat: `up` would resume it, `down` has no live
// session to stop (the stub tmux answers no session), so both verbs preview.
const seat = (root: string, team: string, tag: string): Row => ({
  status: "suspended", status_reason: "session_stopped", delivery: "pane", harness: "claude",
  session: `${team}/${tag}`, registered_from_worktree: root, base: team, tag, index: 1,
});

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tap-team-operand.")));
  scratch.push(dir);
  const home = join(dir, "home");
  const index = join(dir, "index");
  const bin = join(dir, "bin");
  const tmuxTmp = join(dir, "tmux-tmp");
  for (const path of [home, index, bin, tmuxTmp]) mkdirSync(path, { recursive: true });
  const local = checkout(dir, "local-tree", "local-team", {});
  const localRoot = local.root;
  writeFileSync(local.registry, `${JSON.stringify({ schema: "0.20", team: { name: "local-team", worktree_root: localRoot },
    seats: { "local-seat": seat(localRoot, "local-team", "local-seat") } }, null, 2)}\n`);
  const foreign = checkout(dir, "foreign-tree", "foreign-team", {});
  writeFileSync(foreign.registry, `${JSON.stringify({ schema: "0.20", team: { name: "foreign-team", worktree_root: foreign.root },
    seats: {
      "lead-seat": seat(foreign.root, "foreign-team", "lead-seat"),
      "other-seat": seat(foreign.root, "foreign-team", "other-seat"),
    } }, null, 2)}\n`);
  const retired = checkout(dir, "retired-tree", "retired-team", {});
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: {
      "local-team": { root: localRoot, registry_location: local.registry, state: "registered" },
      "foreign-team": { root: foreign.root, registry_location: foreign.registry, state: "registered" },
      "retired-team": { root: retired.root, registry_location: retired.registry, state: "historical" },
    },
  }));
  // No live session anywhere: has-session and display-message fail, the
  // namespace listing is empty.
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-sessions) exit 0 ;;
  list-panes) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  // No arm of these verb tests may open a window: a refusing osascript probe
  // keeps any stray live-attach path on the printed-commands branch.
  writeFileSync(join(bin, "osascript"), `#!/bin/sh
echo "osascript must not run in these tests" >&2
exit 1
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"),
    OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"),
    TAP_LOCK_DIR: join(dir, "locks"),
    TAP_TMUX_SOCKET: basename(dir),
    TMUX_TMPDIR: tmuxTmp,
    TAP_SERVER_EPOCH: "srv:1:1",
    TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001",
    TAP_BOOT_ID_LEGACY: "boot:1",
    COLUMNS: "200",
    NO_COLOR: "1",
  };
  for (const key of ["TAP_HOME", "TAP_REGISTRY", "TAP_TEAM_SELECT", "TAP_BUS_RULE", "TMUX", "TMUX_PANE", "TAP_SELF", "TAP_JSON"]) delete env[key];
  return { dir, env, localRoot, foreignRoot: foreign.root, foreignRegistry: foreign.registry };
}

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(shippedEntry, argv, { cwd, env, encoding: "utf8" });
}

// Paths differ by checkout only in the cwd-derived prefix; everything else in a
// dry-run preview must be byte-identical between the two spellings.
for (const verb of ["down", "shutdown", "up"]) {
  test(`team ${verb} <team> --dry-run previews exactly what a bare ${verb} previews from that team's checkout`, () => {
    const f = fixture();
    const before = readFileSync(f.foreignRegistry, "utf8");
    const named = run(["team", verb, "foreign-team", "--dry-run"], f.localRoot, f.env);
    const bare = run(["team", verb, "--dry-run"], f.foreignRoot, f.env);
    expect(named.stderr).toBe(bare.stderr);
    expect(named.stdout).toBe(bare.stdout);
    expect(named.status).toBe(bare.status);
    expect(named.status).toBe(0);
    expect(`${named.stdout}${named.stderr}`).not.toContain("local-seat");
    // The dry run mutates nothing on the named team.
    expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
    // The bare form in the local checkout still means the local team.
    const local = run(["team", verb, "--dry-run"], f.localRoot, f.env);
    expect(local.status).toBe(0);
    expect(`${local.stdout}${local.stderr}`).not.toContain("lead-seat");
  }, 30_000);

  test(`team ${verb} <team> --json --dry-run matches the bare JSON preview`, () => {
    const f = fixture();
    const named = run(["team", verb, "foreign-team", "--dry-run", "--json"], f.localRoot, f.env);
    const bare = run(["team", verb, "--dry-run", "--json"], f.foreignRoot, f.env);
    expect(named.status).toBe(0);
    expect(named.stdout).toBe(bare.stdout);
  }, 30_000);

  test(`team ${verb} with an unknown team refuses before any effect`, () => {
    const f = fixture();
    const human = run(["team", verb, "no-such-team", "--dry-run"], f.localRoot, f.env);
    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(`tap team ${verb}: --team 'no-such-team' is not enrolled in the machine index; next: tap register\n`);
    const json = run(["team", verb, "no-such-team", "--json"], f.localRoot, f.env);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error_class: "unknown_team", action: "tap register" });
    expect(json.stderr).toBe("");
  }, 30_000);

  test(`team ${verb} --json with a bare selector or missing target emits one machine refusal`, () => {
    const f = fixture();
    const result = run(["team", verb, "--only", "--json"], f.localRoot, f.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: "target_required" });
  }, 30_000);

  test(`team ${verb} with a retired team refuses`, () => {
    const f = fixture();
    const result = run(["team", verb, "retired-team", "--dry-run"], f.localRoot, f.env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`tap team ${verb}: team 'retired-team' is historical (not delivery-addressable); next: tap doctor\n`);
  }, 30_000);

  test(`team ${verb} refuses a second positional`, () => {
    const f = fixture();
    const result = run(["team", verb, "foreign-team", "extra", "--dry-run"], f.localRoot, f.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unexpected extra argument after team 'foreign-team'`);
  }, 30_000);
}

test("nonterminal exact misses keep their typed error while omitted selectors require a target", () => {
  const f = fixture();
  const jsonEnv = { ...f.env, TAP_JSON: "1" };
  for (const argv of [["team", "roster", "no-such-team", "--json"],
    ["team", "attach", "no-such-team"], ["team", "detach", "no-such-team"],
    ["attach", "no-such-team/seat"]]) {
    const result = run(argv, f.localRoot, jsonEnv);
    expect(result.status, `${argv.join(" ")}: ${result.stdout} ${result.stderr}`).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: "unknown_team" });
  }
  const seatMiss = run(["attach", "foreign-team/missing-seat"], f.localRoot, jsonEnv);
  expect(seatMiss.status).toBe(1);
  expect(seatMiss.stderr).toBe("");
  expect(JSON.parse(seatMiss.stdout)).toMatchObject({ ok: false, error_class: "not_found" });
}, 30_000);

// A documented TAP_HOME pin (no lib.sh companion TAP_BUS_RULE) is the caller's
// bus: naming a different team refuses rather than stopping it.
for (const verb of ["down", "shutdown", "up"]) {
  test(`team ${verb} <team> refuses a TAP_HOME pin on another team's bus`, () => {
    const f = fixture();
    const before = readFileSync(f.foreignRegistry, "utf8");
    const pinned = { ...f.env, TAP_HOME: join(f.localRoot, ".tap", "bus") };
    const result = run(["team", verb, "foreign-team", "--yes"], f.localRoot, pinned);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to override a caller pin");
    expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
    // The same pin on the named team's own bus is no conflict.
    const same = run(["team", verb, "foreign-team", "--dry-run"], f.localRoot, { ...f.env, TAP_HOME: join(f.foreignRoot, ".tap", "bus") });
    expect(same.stderr).not.toContain("refusing to override a caller pin");
  }, 30_000);
}

test("team up <team> --only selects within the named team", () => {
  const f = fixture();
  const named = run(["team", "up", "foreign-team", "--only", "lead-seat", "--dry-run"], f.localRoot, f.env);
  const bare = run(["team", "up", "--only", "lead-seat", "--dry-run"], f.foreignRoot, f.env);
  expect(named.status).toBe(0);
  expect(named.stdout).toBe(bare.stdout);
  expect(named.stdout).not.toContain("other-seat");
  // A handle from the caller's own team is not on the named roster.
  const wrong = run(["team", "up", "foreign-team", "--only", "local-seat", "--dry-run"], f.localRoot, f.env);
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain("local-seat");
}, 30_000);

function restartRows(f: ReturnType<typeof fixture>, stoppedNewest = false) {
  writeFileSync(join(f.dir, "bin/tmux"), "#!/bin/sh\necho 'no server running on fixture socket' >&2\nexit 1\n", { mode: 0o755 });
  const doc = JSON.parse(readFileSync(f.foreignRegistry, "utf8"));
  doc.seats = Object.fromEntries([
    ["older", "srv:10:10", "active", ""],
    ["latest-a", "srv:20:20", stoppedNewest ? "suspended" : "active", stoppedNewest ? "session_stopped" : ""],
    ["latest-b", "srv:20:20", "suspended", stoppedNewest ? "session_stopped" : "pane_gone"],
    ["stopped", "srv:20:20", "suspended", "session_stopped"],
  ].map(([handle, epoch, status, reason]) => [handle, { ...seat(f.foreignRoot, "foreign-team", handle!),
    instance: `instance-${handle}`, status, status_reason: reason, server_epoch: epoch,
    boot_id: "bootuuid:00000000-0000-0000-0000-000000000002", server_socket: physicalSocketPath(f.env),
  }]));
  writeFileSync(f.foreignRegistry, JSON.stringify(doc));
}

test.each(["--last", "-"])("team up %s previews only the latest restart generation without writing", flag => {
  const f = fixture(); restartRows(f);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", flag, "--dry-run"], f.localRoot, f.env);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("would resume foreign-team/latest-a");
  expect(result.stdout).toContain("would resume foreign-team/latest-b");
  expect(result.stdout).not.toContain("would resume foreign-team/older");
  expect(result.stdout).not.toContain("would resume foreign-team/stopped");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --last never falls back through a deliberately stopped latest generation", () => {
  const f = fixture(); restartRows(f, true);
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("no restart cohort");
  expect(result.stdout).not.toContain("would resume");
}, 30_000);

test.each(["home", "select", "registry"])("team up --last validates the %s pin even for an empty cohort", pin => {
  const f = fixture(); restartRows(f, true);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const env = { ...f.env, ...(pin === "home" ? { TAP_HOME: join(f.localRoot, ".tap/bus") }
    : pin === "select" ? { TAP_TEAM_SELECT: "local-team" }
    : { TAP_HOME: join(f.foreignRoot, ".tap/bus"), TAP_REGISTRY: join(f.localRoot, ".tap/team-registry.json") }) };
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run", "--json"], f.localRoot, env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error_class).toBe("usage_error");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --last accepts matching pins for an empty cohort", () => {
  const f = fixture(); restartRows(f, true);
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run", "--json"], f.localRoot,
    { ...f.env, TAP_HOME: join(f.foreignRoot, ".tap/bus"), TAP_TEAM_SELECT: "foreign-team" });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("no_restart_cohort");
}, 30_000);

test.each([false, true])("team up --last rejects literal --yes after the separator (option consent: %s)", confirmed => {
  const f = fixture(); restartRows(f);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", "--json", ...(confirmed ? ["--yes"] : []), "--", "--yes"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error_class).toBe("usage_error");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --last requires nonterminal consent before any launch or JSON receipt", () => {
  const f = fixture(); restartRows(f);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", "--json"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error_class).toBe("confirmation_required");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test.each(["--json", "--j"])("team up --last emits a structured refusal for an unreadable namespace (%s)", jsonFlag => {
  const f = fixture(); restartRows(f);
  writeFileSync(join(f.dir, "bin/tmux"), "#!/bin/sh\necho 'permission denied opening socket' >&2\nexit 1\n", { mode: 0o755 });
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run", jsonFlag], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error_class).toBe("observation_unobservable");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --last refuses a live empty server when generation probes fail", () => {
  const f = fixture(); restartRows(f);
  writeFileSync(join(f.dir, "bin/tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in list-sessions) exit 0 ;; *) exit 1 ;; esac
`, { mode: 0o755 });
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run", "--json"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error_class).toBe("observation_unobservable");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --last --attach previews viewers for exactly the pinned restart cohort", () => {
  const f = fixture(); restartRows(f);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", "--dry-run", "--attach"], f.localRoot, f.env);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("--attach would open 2 viewer(s): latest-a, latest-b");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test.each(["--only", "--except"])("team up --last refuses %s before effects", selector => {
  const f = fixture(); restartRows(f);
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--last", selector, "latest-a", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--last cannot be combined");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up <team> --except spares the named seat through the env handoff", () => {
  const f = fixture();
  const result = run(["team", "up", "foreign-team", "--except", "lead-seat", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would resume foreign-team/other-seat");
  // Spared seats get a spared receipt, never a resume line.
  expect(result.stdout).not.toContain("would resume foreign-team/lead-seat");
}, 30_000);

test("team up --except names no seat: the roster gate refuses before any effect", () => {
  const f = fixture();
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--except", "ghost", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("ghost");
  expect(result.stdout).toBe("");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --tabs without --attach is a usage error", () => {
  const f = fixture();
  const result = run(["team", "up", "foreign-team", "--tabs", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--tabs without --attach");
}, 30_000);

test("team up --tabs without --attach under an abbreviated --j is refused as one JSON object", () => {
  const f = fixture();
  const result = run(["team", "up", "foreign-team", "--j", "--tabs", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: "usage_error" });
  expect(result.stdout).toContain("--tabs without --attach");
}, 30_000);

test("team up --attach keeps an omitted selector's boundary: a bare token after it is still refused", () => {
  const f = fixture();
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "--only", "--attach", "lead-seat", "--dry-run"], f.foreignRoot, f.env);
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain("appears after the selector");
  expect(`${result.stdout}${result.stderr}`).not.toContain("would open");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up treats --attach after -- as a literal operand: refused, never attached", () => {
  const f = fixture();
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--dry-run", "--", "--attach"], f.localRoot, f.env);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toContain("--attach would open");
  expect(`${result.stdout}${result.stderr}`).not.toContain("resume foreign-team/");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --json --attach is refused: the attach speaks human receipts", () => {
  const f = fixture();
  const result = run(["team", "up", "foreign-team", "--attach", "--json", "--dry-run"], f.localRoot, f.env);
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain("drop --json");
}, 30_000);

test("team up --attach refuses JSON by its effective mode: TAP_JSON=1 and an abbreviated --j", () => {
  const f = fixture();
  for (const [argv, env] of [
    [["team", "up", "foreign-team", "--attach", "--dry-run"], { ...f.env, TAP_JSON: "1" }],
    [["team", "up", "foreign-team", "--attach", "--j", "--dry-run"], f.env],
  ] as const) {
    const result = run([...argv], f.localRoot, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: "usage_error" });
    expect(result.stdout).toContain("drop --json");
  }
}, 30_000);

test("team up --dry --attach (an accepted abbreviation) previews and never attaches live", () => {
  const f = fixture();
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--only", "lead-seat", "--dry", "--attach"], f.localRoot, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("tap team up: --attach would open 1 viewer(s): lead-seat");
  expect(result.stdout).not.toContain("attach commands");
  expect(result.stdout).not.toContain("verified");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);

test("team up --dry-run --attach with nothing would come up says so and exits 0", () => {
  const f = fixture();
  const result = run(["team", "up", "foreign-team", "--except", "lead-seat,other-seat", "--dry-run", "--attach"], f.localRoot, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("tap team up: --attach: no seats would come up; nothing to attach");
  expect(result.stdout).not.toContain("would open");
}, 30_000);

test("team up --dry-run --attach previews the viewer plan and opens nothing", () => {
  const f = fixture();
  const before = readFileSync(f.foreignRegistry, "utf8");
  const result = run(["team", "up", "foreign-team", "--only", "lead-seat", "--dry-run", "--attach"], f.localRoot, f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("tap team up: --attach would open 1 viewer(s): lead-seat");
  // The preview carries the AppleScript that a real run would hand osascript.
  expect(result.stdout).toContain("generated AppleScript:");
  expect(result.stdout).toContain("attach-session");
  // The fixture's osascript shim refuses: had the run gone live, the receipt
  // would be printed commands, never a verified window.
  expect(result.stdout).not.toContain("verified");
  expect(readFileSync(f.foreignRegistry, "utf8")).toBe(before);
}, 30_000);
