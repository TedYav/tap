// tap-14aa9: `tap launch --resume` opens the harness's native conversation picker in a fresh seat.
import { expect, test } from "bun:test";
import { buildHarnessInvocation } from "../src/launcher/adapters";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertUniqueResumeIdForLaunch, intendedTarget, refuseMissingExactConversation, refuseResumeWithoutPicker, refuseTuningOnResumeDelegation, RESUME_PICKER_HARNESSES, type NewArgs } from "../src/launcher/new";
import { removeScratchTree } from "./support/scratch";
import type { SessionRecord } from "../src/launcher/types";

const record = (harness: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({ name: "seat", harness, cwd: "/tmp/wt", base: "team", model: null, harness_session_id: null, ...extra });
const argvOf = (r: SessionRecord) => buildHarnessInvocation("new", r, null, undefined, { PATH: "/usr/bin", HOME: "/tmp/home" }, "bypass").argv;

test("a picker launch passes the bare picker flag and mints no session id", () => {
  const claude = argvOf(record("claude", { launch_resume: "picker" }));
  expect(claude).toContain("--resume");
  expect(claude).not.toContain("--session-id");
  expect(claude[claude.indexOf("--resume") + 1] ?? "").not.toMatch(/^[0-9a-f-]{36}$/);
  const codex = argvOf(record("codex", { launch_resume: "picker" }));
  expect(codex).toContain("resume");
  expect(codex.filter(token => /^[0-9a-f-]{36}$/.test(token))).toEqual([]);
});

test("an exact launch resumes the given id and still mints nothing", () => {
  const claude = argvOf(record("claude", { launch_resume: "exact", harness_session_id: "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
  expect(claude.slice(claude.indexOf("--resume"), claude.indexOf("--resume") + 2)).toEqual(["--resume", "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);
  expect(claude).not.toContain("--session-id");
  const codex = argvOf(record("codex", { launch_resume: "exact", harness_session_id: "thread-1" }));
  expect(codex).toContain("resume");
  expect(codex.at(-1)).toBe("thread-1");
});

test("a fresh launch without the marker is unchanged: claude mints --session-id, codex passes nothing", () => {
  const claude = argvOf(record("claude", { harness_session_id: "minted-id" }));
  expect(claude).toContain("--session-id");
  expect(claude).not.toContain("--resume");
  const codex = argvOf(record("codex"));
  expect(codex).not.toContain("resume");
});

test("harnesses without a picker refuse before any effect; claude and codex pass", () => {
  expect(RESUME_PICKER_HARNESSES).toEqual(["claude", "codex"]);
  for (const harness of ["cursor", "opencode", "agy", "hermes"]) {
    expect(() => refuseResumeWithoutPicker({ resume: true, resume_id: null }, harness)).toThrow(/launch_resume_unsupported|no picker|has none/);
    expect(() => refuseResumeWithoutPicker({ resume: false, resume_id: "x" }, harness)).toThrow();
    expect(() => refuseResumeWithoutPicker({ resume: false, resume_id: null }, harness)).not.toThrow();
  }
  for (const harness of ["claude", "codex"]) expect(() => refuseResumeWithoutPicker({ resume: true, resume_id: null }, harness)).not.toThrow();
});

// The numeric-label launch and the collision chooser's [r] both hand off to session resume through this
// refusal; a picker or exact --resume must refuse there like --model, never vanish into the replayed record.
test("the resume-delegation doors refuse --resume instead of dropping it", () => {
  const base: NewArgs = { harness: "claude", label: "3", preset: null, tag: null, workdir: null, unique: null, model: null, effort: null,
    env: null, unset_env: null, fresh: false, new: false, attach: false, dry_run: false, json: false, resume: false, resume_id: null, harness_passthrough: [] };
  for (const door of ["a numeric-label resume", "the collision chooser's resume arm"]) {
    expect(() => refuseTuningOnResumeDelegation(base, door)).not.toThrow();
    expect(() => refuseTuningOnResumeDelegation({ ...base, resume: true }, door)).toThrow(/launch_tuning_not_resumable: --resume cannot apply/);
    expect(() => refuseTuningOnResumeDelegation({ ...base, resume_id: "0199-abc" }, door)).toThrow(/--resume=0199-abc cannot apply/);
  }
});

const repo = resolve(import.meta.dir, "../../..");

// An exact id another seat already holds is refused before any effect, in this cohort first; the
// register-time duplicate-owner quarantine is the backstop for a conversation picked in the picker. The
// target is the seat the launch will register (canonical name, tag, index), so the seat's own incumbent is
// not "another owner", and a target the collision ladder moved to the next free name is.
test("--resume=<id> refuses an id another seat holds and passes the target's own incumbent and unowned ids", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-owner-"));
  try {
    const owned = "0199aaaa-bbbb-cccc-dddd-000000000001", manualOwned = "0199aaaa-bbbb-cccc-dddd-000000000003";
    const bob = { name: "fixture/bob", harness: "claude", cwd: root, base: "fixture", tag: "bob", index: 1, harness_session_id: owned };
    // A `--unique manual` seat: no tag, a name outside the team base, so it registers under the harness name.
    const manual = { name: "manual", harness: "claude", cwd: root, base: "fixture", tag: null, index: 1, harness_session_id: manualOwned };
    const state = { sessions: [bob as any, manual as any], entries: new Map(), team: { name: "fixture" } } as any;
    const args = (label: string | null, extra: Record<string, unknown> = {}) => ({ harness: "claude", unique: null, tag: null, label, preset_resolution: null, ...extra }) as any;
    const target = (label: string | null, extra: Record<string, unknown> = {}) => intendedTarget(args(label, extra), state, root);
    expect(target("alice")).toMatchObject({ harness: "claude", name: "fixture/alice", tag: "alice", index: 1, base: "fixture" });
    expect(target(null)).toMatchObject({ harness: "claude", name: null, tag: null });
    expect(target(null, { unique: "manual" })).toMatchObject({ harness: "claude", name: "manual", tag: null, index: null });
    const check = (id: string | null, t: Parameters<typeof assertUniqueResumeIdForLaunch>[1]) => () => assertUniqueResumeIdForLaunch(id, t, state, root);
    expect(check(owned, target("alice"))).toThrow(/refusing resume for seat alice: .*already belongs to expected seat fixture\/bob/);
    expect(check(owned, target(null))).toThrow(/refusing resume for a new seat: .*already belongs to expected seat fixture\/bob/);
    // bob's own incarnation (`tap launch claude bob --fresh --resume=<its id>`), spelled as the operand, --tag or --unique.
    expect(check(owned, target("bob"))).not.toThrow();
    expect(check(owned, target(null, { tag: "bob" }))).not.toThrow();
    expect(check(owned, target(null, { unique: "fixture/bob" }))).not.toThrow();
    // The manual seat's own id through `--unique manual`; bob's id through it is still another seat's.
    expect(check(manualOwned, target(null, { unique: "manual" }))).not.toThrow();
    expect(check(owned, target(null, { unique: "manual" }))).toThrow(/refusing resume for seat claude: .*belongs to expected seat fixture\/bob/);
    expect(check(manualOwned, target("alice"))).toThrow(/belongs to expected seat fixture\/claude/);
    // The ladder's "n" moved the target to bob-2: a seat of its own, so bob's id is another seat's.
    expect(check(owned, { harness: "claude", name: "fixture/bob-2", base: "fixture", tag: "bob", index: 2 })).toThrow(/refusing resume for seat bob-2: .*belongs to expected seat fixture\/bob/);
    expect(check(owned, { ...target("alice"), harness: "codex" })).not.toThrow();
    expect(check("0199aaaa-bbbb-cccc-dddd-000000000002", target("alice"))).not.toThrow();
    expect(check(null, target("alice"))).not.toThrow();
  } finally { removeScratchTree(root); }
});

// Through the public door with `--fresh`: the owner check passes the seat's own incumbent (so the launch goes
// on to its next refusal, the missing tmux, instead of launch_resume_identity_owned) and still refuses a
// distinct owner before anything is touched. The three spellings of the same seat all resolve to it.
test.each([
  ["operand", ["claude", "writer", "--fresh"], "writer"],
  ["--tag", ["claude", "--tag", "writer", "--fresh"], "writer"],
  ["--unique", ["claude", "--unique", "fixture/writer"], "writer"],
  ["--unique outside the base", ["claude", "--unique", "manual"], "manual"],
])("--fresh --resume=<own id> via %s is not an ownership refusal; another seat's id still is", (_, head, seat) => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-self-"));
  try {
    const index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
    for (const dir of [index, join(root, ".tap/bus"), join(root, "config/tap"), join(root, "bin"), join(root, ".claude/projects/p"), join(root, "claude/projects")]) mkdirSync(dir, { recursive: true });
    const owns = { writer: "0199aaaa-bbbb-cccc-dddd-000000000030", manual: "0199aaaa-bbbb-cccc-dddd-000000000032" }, bobs = "0199aaaa-bbbb-cccc-dddd-000000000031";
    const own = owns[seat as keyof typeof owns];
    for (const id of [...Object.values(owns), bobs]) writeFileSync(join(root, ".claude/projects/p", `${id}.jsonl`), "");
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {
      writer: { status: "active", session: "fixture/writer", harness: "claude", base: "fixture", tag: "writer", index: 1, pane_id: "%7", harness_session_id: owns.writer, registered_from_worktree: root },
      // `--unique manual`: no tag and a name outside the base, so the row is keyed by the harness name.
      claude: { status: "active", session: "manual", harness: "claude", base: "fixture", index: 1, pane_id: "%9", harness_session_id: owns.manual, registered_from_worktree: root },
      bob: { status: "active", session: "fixture/bob", harness: "claude", base: "fixture", tag: "bob", index: 1, pane_id: "%8", harness_session_id: bobs, registered_from_worktree: root } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
    for (const tool of ["bash", "bun", "dirname", "git", "readlink", "jq"]) { const found = Bun.which(tool); if (found) require("node:fs").symlinkSync(found, join(root, "bin", tool)); }
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: index, TAP_HOME: join(root, ".tap/bus"), TAP_CLAUDE_HOME: join(root, "claude"), PATH: join(root, "bin"), TAP_JSON: "1" };
    for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF"]) delete (env as Record<string, string | undefined>)[key];
    const before = require("node:fs").readFileSync(registry, "utf8");
    const run = (id: string) => spawnSync("bash", [join(repo, "bin/tap"), "session", "launch", ...head, `--resume=${id}`, "--json"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    const self = run(own);
    expect(self.stdout + self.stderr).not.toContain("launch_resume_identity_owned");
    expect(self.stdout).toContain('"error_class":"missing_prerequisite"');
    const other = run(bobs);
    expect(other.status, other.stdout + other.stderr).toBe(2);
    expect(other.stdout).toContain('"error_class":"launch_resume_identity_owned"');
    expect(other.stdout).toContain("already belongs to expected seat fixture/bob");
    expect(require("node:fs").readFileSync(registry, "utf8")).toBe(before);
  } finally { removeScratchTree(root); }
});

// The preflight reads the store the CHILD will read: its own spelling when declared or inherited, else the
// default under its HOME; TAP's alias root is never passed to the child and so never chooses the probe store.
test("the exact-id preflight probes the child's store across conflicting alias, declared and default roots", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-roots-"));
  try {
    mkdirSync(join(root, "config/tap"), { recursive: true });
    const ids = { alias: "0199aaaa-bbbb-cccc-dddd-00000000a1a5", declared: "0199aaaa-bbbb-cccc-dddd-00000000dec1", dflt: "0199aaaa-bbbb-cccc-dddd-00000000def0" };
    const claudeRoots = { alias: join(root, "alias-claude"), declared: join(root, "declared-claude"), dflt: join(root, ".claude") };
    const codexRoots = { alias: join(root, "alias-codex"), declared: join(root, "declared-codex"), dflt: join(root, ".codex") };
    for (const which of ["alias", "declared", "dflt"] as const) {
      mkdirSync(join(claudeRoots[which], "projects/p"), { recursive: true }); writeFileSync(join(claudeRoots[which], "projects/p", `${ids[which]}.jsonl`), "");
      const day = join(codexRoots[which], "sessions/2026/10/13"); mkdirSync(day, { recursive: true });
      writeFileSync(join(day, `rollout-2026-10-13T00-00-00-${ids[which]}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: ids[which], cwd: root } }) + "\n");
    }
    const ambient = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_CLAUDE_HOME: claudeRoots.alias, TAP_CODEX_HOME: codexRoots.alias };
    const args = (harness: string, id: string, env: string[] | null = null, unset_env: string[] | null = null) => ({ harness, resume_id: id, env, unset_env, preset_resolution: null });
    const passes = (a: ReturnType<typeof args>) => expect(() => refuseMissingExactConversation(a, root, ambient), JSON.stringify(a)).not.toThrow();
    const refuses = (a: ReturnType<typeof args>) => expect(() => refuseMissingExactConversation(a, root, ambient), JSON.stringify(a)).toThrow(/no_exact_resume_identity|no .* conversation with that id/);
    for (const [harness, spelling, roots] of [["claude", "CLAUDE_CONFIG_DIR", claudeRoots], ["codex", "CODEX_HOME", codexRoots]] as const) {
      // Nothing declared and no native spelling in the ambient env: the child reads its default store under HOME;
      // TAP's alias is never passed to the child, so an alias-only id refuses and a default-only id passes.
      refuses(args(harness, ids.alias)); refuses(args(harness, ids.declared)); passes(args(harness, ids.dflt));
      // The ambient env already carries the child's own spelling beside the alias: the child inherits it, so it decides.
      const inherited = { ...ambient, [spelling]: roots.declared };
      const withInherited = (a: ReturnType<typeof args>, ok: boolean) => (ok ? expect(() => refuseMissingExactConversation(a, root, inherited), JSON.stringify(a)).not.toThrow()
        : expect(() => refuseMissingExactConversation(a, root, inherited), JSON.stringify(a)).toThrow(/no_exact_resume_identity|no .* conversation with that id/));
      withInherited(args(harness, ids.declared), true); withInherited(args(harness, ids.alias), false); withInherited(args(harness, ids.dflt), false);
      // ...and a seat that unsets the inherited spelling falls to the default store, never back to the alias.
      withInherited(args(harness, ids.dflt, null, [spelling]), true); withInherited(args(harness, ids.alias, null, [spelling]), false); withInherited(args(harness, ids.declared, null, [spelling]), false);
      // The seat declares the child's own spelling: that root alone decides.
      passes(args(harness, ids.declared, [`${spelling}=${roots.declared}`])); refuses(args(harness, ids.alias, [`${spelling}=${roots.declared}`])); refuses(args(harness, ids.dflt, [`${spelling}=${roots.declared}`]));
      // The seat unsets it: the alias is dropped too, so the default store under HOME decides.
      passes(args(harness, ids.dflt, null, [spelling])); refuses(args(harness, ids.alias, null, [spelling]));
    }
  } finally { removeScratchTree(root); }
});

// The same refusal through the public door: a dry run validates the id against the enrolled registry
// and refuses with its own class, writing nothing; an unowned id previews the picker-free exact resume.
test("tap launch --resume=<id> --dry-run refuses an owned id through the public door and previews an unowned one", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-door-"));
  try {
    const index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
    for (const dir of [index, join(root, ".tap/bus"), join(root, "config/tap")]) mkdirSync(dir, { recursive: true });
    const owned = "0199aaaa-bbbb-cccc-dddd-000000000001";
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {
      bob: { status: "active", session: "fixture/bob", harness: "claude", base: "fixture", tag: "bob", index: 1, harness_session_id: owned } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
    const unowned = "0199aaaa-bbbb-cccc-dddd-000000000002";
    // The child's default store under HOME holds the id; TAP's alias points at an empty folder and is not consulted.
    mkdirSync(join(root, ".claude/projects/p"), { recursive: true }); writeFileSync(join(root, ".claude/projects/p", `${unowned}.jsonl`), "");
    mkdirSync(join(root, "claude/projects"), { recursive: true });
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: index, TAP_HOME: join(root, ".tap/bus"), TAP_CLAUDE_HOME: join(root, "claude"), TAP_JSON: "1" };
    for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF"]) delete (env as Record<string, string | undefined>)[key];
    const before = JSON.stringify(JSON.parse(require("node:fs").readFileSync(registry, "utf8")));
    const run = (id: string) => spawnSync("bash", [join(repo, "bin/tap"), "session", "launch", "claude", "alice", `--resume=${id}`, "--dry-run", "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    const refused = run(owned);
    expect(refused.status, refused.stdout + refused.stderr).toBe(2);
    expect(refused.stdout).toContain('"error_class":"launch_resume_identity_owned"');
    expect(refused.stdout).toContain("already belongs to expected seat fixture/bob");
    expect(JSON.stringify(JSON.parse(require("node:fs").readFileSync(registry, "utf8")))).toBe(before);
    const previewed = run(unowned);
    expect(previewed.status, previewed.stdout + previewed.stderr).toBe(0);
    expect(previewed.stdout).toContain("--resume");
    expect(previewed.stdout).not.toContain("--session-id");
  } finally { removeScratchTree(root); }
});

// From a root TAP has never enrolled, a real (non-dry-run) launch with an id another team's seat holds
// refuses before the lifecycle journal, before bootstrap enrolls the root, and before the harness is even
// looked up: tmux is absent from PATH here, so a check that ran later would have reported a missing
// prerequisite instead of the owned id, and .tap/ stays absent.
test("an owned --resume=<id> from an unenrolled root refuses before bootstrap, the journal and the harness lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-unenrolled-"));
  try {
    const index = join(root, "index"), other = join(root, "other"), otherRegistry = join(other, ".tap/team-registry.json");
    for (const dir of [index, join(other, ".tap/bus"), join(root, "project"), join(root, "config/tap"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
    const owned = "0199aaaa-bbbb-cccc-dddd-000000000003";
    writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: other }, seats: {
      bob: { status: "active", session: "other/bob", harness: "claude", base: "other", tag: "bob", index: 1, harness_session_id: owned } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { other: { root: other, registry_location: otherRegistry } } }));
    for (const tool of ["bash", "bun", "dirname", "git", "readlink", "jq"]) { const found = Bun.which(tool); if (found) require("node:fs").symlinkSync(found, join(root, "bin", tool)); }
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: index, PATH: join(root, "bin"), TAP_JSON: "1" };
    for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_HOME"]) delete (env as Record<string, string | undefined>)[key];
    const indexBefore = require("node:fs").readdirSync(index).sort();
    const result = spawnSync("bash", [join(repo, "bin/tap"), "session", "launch", "claude", "alice", `--resume=${owned}`, "--json"],
      { cwd: join(root, "project"), env, encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain('"error_class":"launch_resume_identity_owned"');
    expect(result.stdout).toContain("already belongs to expected seat other/bob");
    expect(require("node:fs").existsSync(join(root, "project/.tap"))).toBe(false);
    expect(require("node:fs").readdirSync(index).sort()).toEqual(indexBefore);
  } finally { removeScratchTree(root); }
});

// An exact id must name a conversation the harness's own store holds, judged with the environment the seat
// child would use, so a mistyped id refuses before anything is reserved or an incumbent is replaced.
test("--resume=<id> refuses a conversation absent from the harness store and passes one it holds", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-exists-"));
  try {
    mkdirSync(join(root, "config/tap"), { recursive: true });
    // The child's default stores under HOME; TAP's aliases name empty folders and are not consulted.
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_CLAUDE_HOME: join(root, "claude"), TAP_CODEX_HOME: join(root, "codex") };
    const args = (harness: string, id: string) => ({ harness, resume_id: id, env: null, unset_env: null, preset_resolution: null });
    const present = "0199aaaa-bbbb-cccc-dddd-000000000010", absent = "0199aaaa-bbbb-cccc-dddd-000000000011";
    mkdirSync(join(root, ".claude/projects/p"), { recursive: true }); writeFileSync(join(root, ".claude/projects/p", `${present}.jsonl`), "");
    mkdirSync(join(root, ".codex/sessions/2026/10/13"), { recursive: true });
    writeFileSync(join(root, ".codex/sessions/2026/10/13", `rollout-2026-10-13T00-00-00-${present}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: present, cwd: root } }) + "\n");
    mkdirSync(join(root, "claude/projects"), { recursive: true }); mkdirSync(join(root, "codex/sessions"), { recursive: true });
    for (const harness of ["claude", "codex"]) {
      expect(() => refuseMissingExactConversation(args(harness, present), root, env), harness).not.toThrow();
      expect(() => refuseMissingExactConversation(args(harness, absent), root, env), harness).toThrow(/no_exact_resume_identity|no .* conversation with that id/);
    }
    expect(() => refuseMissingExactConversation(args("claude", null as unknown as string), root, env)).not.toThrow();
  } finally { removeScratchTree(root); }
});

// Through the public door with `--fresh`: the refusal lands before the lifecycle journal, before the harness
// lookup (tmux is absent here, so a later check would have reported a missing prerequisite) and before the
// replacement transaction, so the incumbent row is untouched.
test.each([
  ["claude", "TAP_CLAUDE_HOME", "CLAUDE_CONFIG_DIR"],
  ["codex", "TAP_CODEX_HOME", "CODEX_HOME"],
])("%s --fresh --resume=<id> refuses an id the child's store lacks before the incumbent is touched", (harness, alias, native) => {
  const root = mkdtempSync(join(tmpdir(), "tap-resume-fresh-"));
  try {
    const index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
    for (const dir of [index, join(root, ".tap/bus"), join(root, "config/tap"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
    const store = (dir: string, id: string) => {
      if (harness === "claude") { mkdirSync(join(dir, "projects/p"), { recursive: true }); writeFileSync(join(dir, "projects/p", `${id}.jsonl`), ""); }
      else { const day = join(dir, "sessions/2026/10/13"); mkdirSync(day, { recursive: true });
        writeFileSync(join(day, `rollout-2026-10-13T00-00-00-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n"); }
    };
    const aliasRoot = join(root, "alias"), nativeRoot = join(root, "native");
    mkdirSync(aliasRoot, { recursive: true }); mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {
      alice: { status: "active", session: "fixture/alice", harness, base: "fixture", tag: "alice", index: 1, pane_id: "%7", harness_session_id: "0199aaaa-bbbb-cccc-dddd-000000000020",
        identity_capture_result: { result: "accepted", mode: "launcher_new" } } } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
    for (const tool of ["bash", "bun", "dirname", "git", "readlink", "jq"]) { const found = Bun.which(tool); if (found) require("node:fs").symlinkSync(found, join(root, "bin", tool)); }
    const base = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: index, TAP_HOME: join(root, ".tap/bus"), [alias]: aliasRoot, PATH: join(root, "bin"), TAP_JSON: "1" };
    for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TAP_CLAUDE_HOME", "TAP_CODEX_HOME"]) delete (base as Record<string, string | undefined>)[key];
    (base as Record<string, string>)[alias] = aliasRoot;
    const before = require("node:fs").readFileSync(registry, "utf8");
    const launch = (env: NodeJS.ProcessEnv, ...extra: string[]) => spawnSync("bash", [join(repo, "bin/tap"), "session", "launch", harness, "alice", "--fresh", ...extra, "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    const expectRefusal = (r: ReturnType<typeof launch>) => {
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain('"error_class":"no_exact_resume_identity"');
      expect(r.stdout).toContain("nothing was launched or replaced");
    };
    // The next refusal after a passing preflight is the missing harness/tmux, never the preflight's.
    const expectProceeds = (r: ReturnType<typeof launch>) => {
      expect(r.stdout + r.stderr).not.toContain("no_exact_resume_identity");
      expect(r.stdout).toContain('"error_class":"missing_prerequisite"');
    };
    expectRefusal(launch(base, "--resume=0199aaaa-bbbb-cccc-dddd-000000000021"));
    // Only the alias store holds this id; the seat declares the child's own spelling, so the child would not find it.
    const aliasOnly = "0199aaaa-bbbb-cccc-dddd-000000000022", nativeOnly = "0199aaaa-bbbb-cccc-dddd-000000000023";
    store(aliasRoot, aliasOnly); store(nativeRoot, nativeOnly);
    expectRefusal(launch(base, `--resume=${aliasOnly}`, "--env", `${native}=${nativeRoot}`));
    expectProceeds(launch(base, `--resume=${nativeOnly}`, "--env", `${native}=${nativeRoot}`));
    // Nothing declared and no native spelling inherited: the child reads its default store under HOME, never the
    // alias, so an alias-only id refuses before replacement and a default-only id proceeds.
    const defaultOnly = "0199aaaa-bbbb-cccc-dddd-000000000024";
    store(join(root, harness === "claude" ? ".claude" : ".codex"), defaultOnly);
    expectRefusal(launch(base, `--resume=${aliasOnly}`));
    expectProceeds(launch(base, `--resume=${defaultOnly}`));
    // Both inherited from the launcher's env: the child keeps its own spelling, so the native store decides.
    const inherited = { ...base, [native]: nativeRoot };
    expectRefusal(launch(inherited, `--resume=${aliasOnly}`));
    expectProceeds(launch(inherited, `--resume=${nativeOnly}`));
    expect(require("node:fs").readFileSync(registry, "utf8")).toBe(before);
  } finally { removeScratchTree(root); }
});
