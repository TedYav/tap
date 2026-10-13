// tap-a5j6t: the lock root must not split across a TAP_HOME-injecting spawn.
// The behavioral demo pins the mechanism (a bare injection resolves a second
// lock root; childBusEnv pins the parent's); the guard census pins every
// injection site in runtime/bun/src so a new bare `TAP_HOME: <bus>` spawn
// cannot reappear (red until each site converts, green with the allowlist
// naming only deliberate shapes).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquirePaneLock, childBusEnv, lockRoot, paneLockPath } from "../src/panelock";
import { publishDerivedBus } from "../src/verbs/register";
import { sidecarCommand } from "../src/watch-sidecar";
import { goalieSidecarCommand } from "../src/verbs/goalie";

const parentEnv = { ...process.env, TAP_LOCK_DIR: undefined, TAP_INDEX_HOME: undefined, TAP_HOME: undefined, TAP_TEAM_OVERRIDE_BUS: undefined };
const bus = "/tmp/a5j6t-bus-home";

describe("childBusEnv keeps one lock root across the spawn boundary", () => {
  test("a bare TAP_HOME injection resolves a SECOND lock root (the bug, as a negative control)", () => {
    const bare = { ...parentEnv, TAP_HOME: bus };
    expect(lockRoot(bare)).toBe(join(bus, "locks"));
    expect(lockRoot(bare)).not.toBe(lockRoot(parentEnv));
  });

  test("childBusEnv pins the parent's lock root above the injected bus", () => {
    const child = childBusEnv(bus, parentEnv);
    expect(child.TAP_HOME).toBe(bus);
    expect(child.TAP_LOCK_DIR).toBe(lockRoot(parentEnv));
    expect(lockRoot(child)).toBe(lockRoot(parentEnv));
  });

  test("parent and child exclude each other on the same pane lock through childBusEnv", () => {
    const parent = acquirePaneLock("tap/a5j6t/pane", 1000, parentEnv);
    expect(parent).toBeTruthy();
    const child = acquirePaneLock("tap/a5j6t/pane", 1000, childBusEnv(bus, parentEnv));
    expect(child).toBe(null);
    parent!.release();
    // The bare injection the helper replaces lets the child straight through:
    // same key, different root, no exclusion. That split is the bug.
    const parentAgain = acquirePaneLock("tap/a5j6t/pane", 1000, parentEnv);
    const split = acquirePaneLock("tap/a5j6t/pane", 1000, { ...parentEnv, TAP_HOME: bus });
    expect(split).toBeTruthy();
    split!.release();
    parentAgain!.release();
  });

  test("paneLockPath agrees between parent env and childBusEnv", () => {
    expect(paneLockPath("tap/x", childBusEnv(bus, parentEnv))).toBe(paneLockPath("tap/x", parentEnv));
  });
});

// tap-b5qrj: register publishes the derived bus IN-PROCESS (env ===
// process.env), so the same split childBusEnv fixes across spawn boundaries
// would open inside the register process itself the moment TAP_HOME names the
// bus. publishDerivedBus must pin the lock root BEFORE the publication, and
// the pin must never override an explicit TAP_LOCK_DIR.
describe("register's bus publication keeps the prior lock root (tap-b5qrj)", () => {
  test("implicit bus: the pin captures the default root before TAP_HOME names the bus", () => {
    const env: NodeJS.ProcessEnv = { ...parentEnv };
    const before = lockRoot(env);
    expect(before).toBe(join(homedir(), ".tap", "locks"));
    publishDerivedBus(bus, env);
    expect(env.TAP_HOME).toBe(bus);
    expect(env.TAP_LOCK_DIR).toBe(before);
    expect(lockRoot(env)).toBe(before);
    expect(lockRoot(env)).not.toBe(join(bus, "locks"));
  });

  test("caller-pinned bus: the root stays with the bus (unchanged behavior)", () => {
    const env: NodeJS.ProcessEnv = { ...parentEnv, TAP_HOME: bus };
    const before = lockRoot(env);
    expect(before).toBe(join(bus, "locks"));
    publishDerivedBus(bus, env);
    expect(env.TAP_HOME).toBe(bus);
    expect(lockRoot(env)).toBe(before);
  });

  test("an explicit TAP_LOCK_DIR is carried verbatim, never overwritten", () => {
    const env: NodeJS.ProcessEnv = { ...parentEnv, TAP_LOCK_DIR: "/tmp/b5qrj-pinned-locks" };
    publishDerivedBus(bus, env);
    expect(env.TAP_HOME).toBe(bus);
    expect(env.TAP_LOCK_DIR).toBe("/tmp/b5qrj-pinned-locks");
    expect(lockRoot(env)).toBe("/tmp/b5qrj-pinned-locks");
  });
});

// The census: every executing line in runtime/bun/src that injects a bus home,
// in any of the spellings an env can carry it:
//   object-literal  `TAP_HOME:<value>` in ANY spacing, minified included (not
//                   `TAP_HOME:undefined` unpins); quoted-key `{"TAP_HOME":…}`
//                   and bracket assignment `x["TAP_HOME"]=…` count too
//   shell-string    `TAP_HOME=${...}` (tmux window launch prefixes)
//   assignment      `<obj>.TAP_HOME = ...` (compound `??=`/`||=`/`&&=` too)
// Every spelling requires an exact property-name boundary (a suffix such as
// DEFAULT_TAP_HOME is a different variable) and exempts undefined unpins.
// Files are DISCOVERED by glob, so a bare injection in a new file cannot hide
// (partner N1). A site passes when the same statement pins TAP_LOCK_DIR
// (directly or through childBusEnv/sidecarCommand) or the site is deliberately
// allowlisted below with its reason.
// Each entry may KEY itself to one file; an anchor without `file` matches in
// any file (used only for shapes that are pinned by construction).
const ALLOWLIST: Array<{ anchor: RegExp; reason: string; file?: string }> = [
  { anchor: /TAP_LOCK_DIR: lockRoot\(\)/, reason: "hand-pinned in the same env object" },
  { anchor: /TAP_HOME: undefined/, reason: "explicit unpin, not an injection" },
  { anchor: /const \{ TAP_HOME: _pin, \.\.\.unpinned \} = env/, reason: "strips the caller pin so the fresh seat binds by cwd", file: "launcher/crew-invocation.ts" },
  { anchor: /selectedEnv = pin \? \{ \.\.\.env, TAP_HOME: pin \} : env/, reason: "caller-pin preservation: the pin came from the caller's own env", file: "verbs/escalate.ts" },
  { anchor: /childEnv = \{ \.\.\.childEnv, TAP_HOME: bus\.home \}/, reason: "pins TAP_LOCK_DIR at childEnv construction (line above)", file: "verbs/compact.ts" },
  { anchor: /observeCallerPaneChain\(\{ \.\.\.env, TAP_HOME: authority\.bus/, reason: "in-process resolver env, no spawn boundary", file: "session-start.ts" },
  { anchor: /resolveBus\(repoRoot\(process\.cwd\(\)\), \{ \.\.\.process\.env, TAP_HOME: undefined \}\)/, reason: "in-process unpin", file: "verbs/health.ts" },
  { anchor: /resolveBus\(repoRoot\(\), \{ \.\.\.process\.env, TAP_HOME: resolve\(process\.env\.TAP_HOME\) \}\)/, reason: "in-process resolution, no child env", file: "verbs/provenance.ts" },
  { anchor: /resolveBus\(root, pin && !isAbsolute\(pin\)/, reason: "in-process bus derivation", file: "spool-engine-worker.ts" },
  { anchor: /cleanEnv: NodeJS\.ProcessEnv = \{ \.\.\.env, TAP_HOME: home \}/, reason: "pins TAP_LOCK_DIR two lines below unless the parent already carries a root", file: "spool-engine-worker.ts" },
  { anchor: /watchRemedy = team \? `TAP_HOME=/, reason: "remedy text printed to the operator, not a child env", file: "verbs/remind.ts" },
  { anchor: /process\.env\.TAP_HOME = home/, reason: "sets the TAP_TEAM_OVERRIDE_BUS marker alongside, which lockRoot excludes by contract", file: "team-override.ts" },
  { anchor: /env\.TAP_HOME = home/, reason: "the spool engine worker already normalized TAP_LOCK_DIR in the waiter's inherited env", file: "spool-waiter-loop.ts" },
  { anchor: /env\.TAP_HOME = busHome/, reason: "publishDerivedBus pins the process's lock root ABOVE this line; behavior pinned in child-bus-env.test.ts (tap-b5qrj)", file: "verbs/register.ts" },
  { anchor: /merged\.TAP_HOME = resolved\.busHome/, reason: "spread of an env whose TAP_LOCK_DIR the sidecar launch already pins; TAP_HOME alone cannot move the root", file: "goalie-tick.ts" },
  { anchor: /env: NodeJS\.ProcessEnv=\{\.\.\.process\.env,TAP_HOME:bus\}/, reason: "in-process only, never crosses a spawn boundary: feeds oldStoreEvidence/enrollTeam/newEnrollmentRefusal/bornLiveBootstrap/bootstrapPostflipEnroll, whose only spawns are git probes on process.env (init.ts git(), register-authority.ts:70/:683); the env does reach acquirePathLock (register-authority.ts:468/:577/:608), but those locks take explicit paths and acquireKernelLockAt ignores its env parameter; index-home.ts spawns nothing", file: "verbs/init.ts" },
];

const INJECTIONS: RegExp[] = [
  /(?<![$_\p{L}\p{N}])TAP_HOME:(?!\s*undefined\b)/u,
  /["']TAP_HOME["']\s*:(?!\s*undefined\b)/,
  /\[["']TAP_HOME["']\]\s*(?:\|\||\?\?|&&)?=(?!=)/,
  /(?<![$_\p{L}\p{N}])TAP_HOME=\$\{/u,
  /\.TAP_HOME\s*(?:\|\||\?\?|&&)?=(?!=)/,
];

test("the object-literal matcher is whitespace-tolerant", () => {
  const flagged = (line: string) => INJECTIONS.some((re) => re.test(line));
  // init.ts writes the minified spelling: no space after the colon. A census
  // that only matches the spaced form classifies nothing there (Codex P2,
  // PRRT_kwDOTMYQYs6l6COG) and a child spawn in the same style would split
  // the lock root undetected.
  expect(flagged(`const env:NodeJS.ProcessEnv={...process.env,TAP_HOME:bus};`)).toBe(true);
  expect(flagged(`spawn(cmd,{env:{TAP_HOME:"/repo/.tap/bus"}})`)).toBe(true);
  expect(flagged(`const env = { TAP_HOME: bus };`)).toBe(true);
  // JSON-shaped and bracket spellings a generator might emit.
  expect(flagged(`const env={"TAP_HOME":"/repo/.tap/bus"}`)).toBe(true);
  expect(flagged(`merged["TAP_HOME"] = bus`)).toBe(true);
  // But a bracket COMPARISON is a read, not an injection.
  expect(flagged(`if(env["TAP_HOME"] === process.env.TAP_HOME)return;`)).toBe(false);
  // The explicit unpin stays exempt in BOTH spellings: the lookahead must not
  // let its optional whitespace backtrack past a space to re-flag it.
  expect(flagged(`const env = { TAP_HOME: undefined };`)).toBe(false);
  expect(flagged(`const env={TAP_HOME:undefined};`)).toBe(false);
});

test("the matchers respect unpins, compound writes, and name boundaries", () => {
  const flagged = (line: string) => INJECTIONS.some((re) => re.test(line));
  // A quoted-key unpin is not an injection either: the undefined exemption
  // must cover the quoted spelling in both spacings .
  expect(flagged(`const env={"TAP_HOME":undefined};`)).toBe(false);
  expect(flagged(`const env = { "TAP_HOME": undefined };`)).toBe(false);
  // Compound writes assign too, in bracket and dot spellings alike, and a
  // minified dot assignment has no spaces at all.
  expect(flagged(`env["TAP_HOME"] ??= bus;`)).toBe(true);
  expect(flagged(`env["TAP_HOME"] ||= bus;`)).toBe(true);
  expect(flagged(`env["TAP_HOME"] &&= bus;`)).toBe(true);
  expect(flagged(`env.TAP_HOME ??= bus;`)).toBe(true);
  expect(flagged(`env.TAP_HOME ||= bus;`)).toBe(true);
  expect(flagged(`env.TAP_HOME=bus;`)).toBe(true);
  // Nullish reads and comparisons stay unflagged.
  expect(flagged(`const x = env["TAP_HOME"] ?? fallback;`)).toBe(false);
  expect(flagged(`if (env.TAP_HOME === process.env.TAP_HOME) return;`)).toBe(false);
  // A suffix of a longer name is a different variable, in object-literal,
  // quoted, and shell-string spellings alike...
  expect(flagged(`const env = { DEFAULT_TAP_HOME: bus };`)).toBe(false);
  expect(flagged(`const env = { "DEFAULT_TAP_HOME": bus };`)).toBe(false);
  expect(flagged('DEFAULT_TAP_HOME=${bus} exec tap send peer -m x')).toBe(false);
  // ...while the real name still matches.
  expect(flagged('TAP_HOME=${bus} exec tap send peer -m x')).toBe(true);
});

test("every TAP_HOME injection site pins the lock root or is allowlisted", () => {
  const src = join(import.meta.dir, "../src");
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: src })].sort();
  expect(files.length).toBeGreaterThan(150);
  const bare: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(src, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // executing lines only
      if (!INJECTIONS.some((re) => re.test(line))) return;
      const statement = lines.slice(i, i + 4).join("\n");
      const pinned = /TAP_LOCK_DIR/.test(statement) || /childBusEnv\(/.test(statement) || /sidecarCommand\(/.test(statement) || /TAP_HOME: undefined/.test(statement);
      const allowed = ALLOWLIST.some((entry) =>
        (entry.file === undefined || entry.file === file) && (entry.anchor.test(statement) || entry.anchor.test(line)));
      if (!pinned && !allowed) bare.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(bare.join("\n")).toBe("");
});

test("sidecar launch commands carry the armer's lock root above the bus pin", () => {
  // homedir() is process-level: the default-root arm asserts THIS process's
  // root, exactly what an arming client without pins passes down.
  const defaultRoot = `'${join(homedir(), ".tap", "locks")}'`;
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  const watch = sidecarCommand(bus, "/opt/bun/bin/bun", env);
  expect(watch).toContain(`TAP_LOCK_DIR=${defaultRoot}`);
  expect(watch).toContain(`TAP_HOME='${bus}'`);
  expect(watch.indexOf("TAP_LOCK_DIR=")).toBeLessThan(watch.indexOf("TAP_HOME="));
  const goalie = goalieSidecarCommand(bus, "/repo/runtime/bun/goalie-run.ts", env);
  expect(goalie).toContain(`TAP_LOCK_DIR=${defaultRoot}`);
  expect(goalie).toContain(`TAP_HOME='${bus}'`);
  // A parent that already pins a root is carried verbatim, not re-derived.
  const pinnedEnv = { ...env, TAP_LOCK_DIR: "/tmp/a5j6t-pinned-locks" };
  expect(sidecarCommand(bus, undefined, pinnedEnv)).toContain("TAP_LOCK_DIR='/tmp/a5j6t-pinned-locks'");
  expect(goalieSidecarCommand(bus, "/repo/goalie-run.ts", pinnedEnv)).toContain("TAP_LOCK_DIR='/tmp/a5j6t-pinned-locks'");
});
