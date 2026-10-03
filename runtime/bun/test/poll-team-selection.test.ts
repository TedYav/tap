// `--team <name>` must select that team's bus even when the caller stands INSIDE
// another enrolled team's root (tap-7rkcc).
//
// The defect: `applyTeamOverride` sets TAP_HOME, but under a live marker the
// selector's cwd enrollment walk wins over TAP_HOME (selector.ts
// `selectFromWalk`), so the walk silently returned the CWD's team and `--team`
// did nothing. A pane-less caller standing in another team's worktree is
// precisely the case `--team` exists for, and the incumbent is TAP_HOME-first
// there. Native reply's copy of this was fixed by resolving through the
// selector's explicit-team path; these are the two remaining live sites.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME and never starts a server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-poll-team."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

const ID = "leader-20260907T000000Z-123456789abc";

/** Two enrolled teams: `ancestor` (empty) and `primary` (holding driver's mail). */
function fixture() {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  mkdirSync(index);
  const teams: Record<string, unknown> = {};
  const roots: Record<string, string> = {};
  for (const [name, seats] of [
    ["ancestor", {}],
    ["primary", {
      driver: { status: "active", delivery: "poll", instance: "driver|launcher" },
      leader: { status: "active", delivery: "poll", instance: "leader|original" },
    }],
  ] as const) {
    const teamRoot = join(root, name);
    const bus = join(teamRoot, ".tap", "bus");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    const reg = join(teamRoot, ".tap", "team-registry.json");
    writeFileSync(reg, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: teamRoot }, seats })}\n`);
    teams[name] = { root: teamRoot, registry_location: reg, state: "registered" };
    roots[name] = teamRoot;
  }
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({ schema: "0.20", teams })}\n`);

  // One unsettled note for `driver`, on PRIMARY's bus only.
  const payload = join(roots.primary!, ".tap", "bus", "payloads", `${ID}.md`);
  writeFileSync(payload, `---\nid: ${ID}\nfrom: leader\nto: driver\nreply: settle-only\nkind: note\n`
    + `recipient_instance: driver|launcher\nsender_instance: leader|original\npath: ${payload}\n---\nwork\n`);

  // A cwd INSIDE the OTHER enrolled team's root — the whole point of the defect.
  const insideAncestor = join(roots.ancestor!, "trees", "lane");
  mkdirSync(insideAncestor, { recursive: true });
  // A cwd enrolled in NO team, the control that always worked.
  const unenrolled = join(root, "elsewhere");
  mkdirSync(unenrolled);

  const env = {
    ...process.env,
    HOME: root,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    TAP_SELF: undefined,
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  return { root, index, env, insideAncestor, unenrolled, roots };
}

type Fx = ReturnType<typeof fixture>;

function poll(fx: Fx, cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const r = Bun.spawnSync([TAP, "poll", "driver", ...args], {
    cwd, env: { ...fx.env, ...extraEnv }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("poll --team selects the named team's bus", () => {
  test("from a cwd INSIDE another enrolled team's root — the defect", () => {
    const fx = fixture();
    const r = poll(fx, fx.insideAncestor, ["--team", "primary"]);
    // Before the fix this printed `empty` at exit 0: the enrollment walk
    // returned `ancestor`, whose bus genuinely has no mail, so the verb
    // reported a truthful answer about the WRONG team.
    expect(r.stdout).toContain(ID);
    expect(r.stdout).not.toContain("empty");
  });

  test("from an UNENROLLED cwd — the control that always worked", () => {
    const fx = fixture();
    const r = poll(fx, fx.unenrolled, ["--team", "primary"]);
    expect(r.stdout).toContain(ID);
  });

  test("a CALLER-pinned TAP_HOME keeps precedence over --team", () => {
    // The `!process.env.TAP_HOME` conjunct: an explicit caller pin outranks
    // `--team` on both doors. Pinned at ancestor's empty bus, the answer must
    // be ancestor's (empty), not primary's.
    const fx = fixture();
    const r = poll(fx, fx.unenrolled, ["--team", "primary"],
      { TAP_HOME: join(fx.roots.ancestor!, ".tap", "bus") });
    expect(r.stdout).not.toContain(ID);
  });

  test("THREE-WAY: a caller pin beats BOTH --team and an enrolled cwd", () => {
    // The case the original caller-pin arm structurally could not see, because
    // it stood in an UNENROLLED cwd — so it tested pin-vs-`--team` and never
    // pin-vs-walk (partner review, G2-F1). With all three claimants present the
    // old code suppressed `--team`, passed no pinned selection, and let
    // `selectFromWalk` hand the answer to the enrolled cwd: the conjunct stopped
    // `--team` beating the pin but never made the pin beat the walk.
    const fx = fixture();
    const r = poll(fx, fx.insideAncestor, ["--team", "ancestor"],
      { TAP_HOME: join(fx.roots.primary!, ".tap", "bus") });
    // The PIN wins: primary's mail, not ancestor's empty bus.
    expect(r.stdout).toContain(ID);
  });

  test("a pin at a NON-ENROLLED bus keeps its historical handling", () => {
    // The narrowing that keeps this fix from being a silent design change:
    // routing every pin through the selector's pinnedRoot branch would newly
    // refuse an unenrolled pin with `unanchored_bus`. Only `unanchored_bus`
    // falls back, so this caller still reaches the walk's own TAP_HOME path.
    const fx = fixture();
    const loose = join(fx.root, "loosebus", ".tap", "bus");
    mkdirSync(join(loose, "payloads"), { recursive: true });
    mkdirSync(join(loose, "receipts"), { recursive: true });
    const r = poll(fx, fx.unenrolled, [], { TAP_HOME: loose });
    // Whatever it answers, it must not be primary's mail and must not crash
    // with the pinned-root refusal this fix could have introduced.
    expect(r.stdout).not.toContain(ID);
    expect(`${r.stdout}${r.stderr}`).not.toContain("pinned root");
  });

  test("an UNENROLLED caller pin still outranks --team", () => {
    // Review catch. The first fix fell back to the
    // explicit-team path whenever the pin was not an enrolled root, letting
    // `--team` win over a caller's pin — the opposite of the documented
    // precedence. A pin decides; `--team` is never consulted beside it.
    const fx = fixture();
    const loose = join(fx.root, "loosebus", ".tap", "bus");
    mkdirSync(join(loose, "payloads"), { recursive: true });
    mkdirSync(join(loose, "receipts"), { recursive: true });
    const r = poll(fx, fx.unenrolled, ["--team", "primary"], { TAP_HOME: loose });
    expect(r.stdout).not.toContain(ID);
  });

  test("a NON-ACTING pin under an enrolled root is refused, not redirected", () => {
    // The same helper seen from the second door (the shared seam): a root match
    // is not a bus match, so resolving the pin's ROOT to its ACTING bus would
    // silently answer about a bus the caller never named.
    const fx = fixture();
    const legacy = join(fx.roots.primary!, ".tap", "legacy-bus");
    mkdirSync(join(legacy, "payloads"), { recursive: true });
    mkdirSync(join(legacy, "receipts"), { recursive: true });
    const r = poll(fx, fx.insideAncestor, [], { TAP_HOME: legacy });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(ID);
  });

  // SHIPPED (was owed on tap-0e8gq): the standalone-pin arm for this door. The
  // earlier attempt failed for a fixture reason, not a code reason — its
  // standalone bus held no mail, so `tap poll: empty` was the CORRECT answer
  // about the pinned bus and the arm could not tell selection from emptiness.
  // Both arms below put driver's mail ON the standalone bus so the assertion
  // is positive: the pin is answered, not some empty sibling.

  /** A standalone bus (not any team's acting bus) holding driver's mail. */
  function standaloneBus(fx: Fx) {
    const bus = join(fx.root, "loose", "pollbus");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    // A standalone bus's registry lives INSIDE the bus (selector resolves it
    // as join(bus.home, "registry.json")), not at <root>/.tap/team-registry.json.
    // driver's instance must stamp the payload's recipient_instance, or poll's
    // instance gate drops the mail and the arms see `tap poll: empty`.
    writeFileSync(join(bus, "registry.json"),
      `{"schema":"0.20","team":{"name":"loose"},"seats":{"driver":{"status":"active",`
      + `"delivery":"poll","instance":"driver|launcher"}}}\n`);
    const payload = join(bus, "payloads", `${ID}.md`);
    writeFileSync(payload, `---\nid: ${ID}\nfrom: leader\nto: driver\nreply: settle-only\nkind: note\n`
      + `recipient_instance: driver|launcher\nsender_instance: leader|original\npath: ${payload}\n---\nwork\n`);
    return bus;
  }

  test("a STANDALONE pin from an ENROLLED FOREIGN cwd still answers the pin", () => {
    // Live marker this time: the pin's root is unenrolled, so the selector
    // throws `unanchored_bus` and the catch reaches the historical path —
    // resolve from the PIN's own root, never from the enrolled cwd (which
    // would answer ancestor's empty bus and drop the pin entirely).
    const fx = fixture();
    const bus = standaloneBus(fx);
    const r = poll(fx, fx.insideAncestor, [], { TAP_HOME: bus });
    expect(r.stdout).toContain(ID);
    expect(r.stdout).not.toContain("is not the acting bus");
  });

  test("without --team, the enrollment walk still owns the selection", () => {
    // The fix must not make every poll explicit-team: standing inside
    // ancestor with no flag still selects ancestor.
    const fx = fixture();
    const r = poll(fx, fx.insideAncestor, []);
    expect(r.stdout).not.toContain(ID);
  });
});
