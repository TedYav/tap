import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "../main.ts");
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) removeScratchTree(path); });
function fixture() {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "reset-contract."));
  owned.push(root);
  const bus = join(root, ".tap/bus"), index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
  for (const p of [bus, index, join(bus, "archive/team-reset/historical"), join(bus, "watch"), join(bus, "payloads")]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "r", worktree_root: root }, extension: "keep", seats: {
    a: { delivery: "poll", status: "active", instance: "a|1" }, b: { delivery: "poll", status: "active", instance: "b|1" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { r: { root, registry_location: registry, state: "registered" } } }));
  const kept = [join(bus, "payloads/mail.md"), join(bus, "watch/arm.json"), join(bus, "archive/team-reset/historical/COMPLETE")];
  for (const p of kept) writeFileSync(p, "preserve verbatim\n");
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(root, "locks"), TAP_SCRATCH_ONLY: root, TAP_SPOOL_DISABLE_DELIVERER: "1" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF"]) delete env[key];
  const run = (verb: string, ...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, MAIN, "team", verb, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { root, bus, registry, index, env, run, kept, doc: () => JSON.parse(readFileSync(registry, "utf8")) };
}

test("reset retires all selected rows while preserving team, bus, watch and historical archives", () => {
  const f = fixture();
  const result = f.run("reset", "r", "--yes", "--json");
  expect(result.code, result.out + result.err).toBe(0);
  expect(f.doc()).toMatchObject({ extension: "keep", seats: {} });
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams.r.root).toBe(f.root);
  expect(existsSync(join(f.root, ".tap/team-history"))).toBe(true);
  for (const p of f.kept) expect(readFileSync(p, "utf8")).toBe("preserve verbatim\n");
});

test("reset dry-run selects the same hard retirement and --except spares its row", () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  const preview = f.run("reset", "--except", "b", "--dry-run", "--json");
  expect(preview.code, preview.out + preview.err).toBe(0);
  expect(JSON.parse(preview.out)).toMatchObject({ dry_run: true, preview: { hard: true, parents: ["a"] } });
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(existsSync(join(f.root, ".tap/team-history"))).toBe(false);
  expect(f.run("reset", "--except", "b", "--yes").code).toBe(0);
  expect(Object.keys(f.doc().seats)).toEqual(["b"]);
});

test("reset without noninteractive consent refuses and preserves the roster", () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  const result = f.run("reset", "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).error_class).toBe("confirmation_required");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

for (const [verb, args] of [
  ["restore", ["--archive", "historical", "--again"]], ["purge", ["historical", "--yes"]],
  ["reset", ["--kill-self"]], ["reset", ["--allow-nonstandard-bus-path"]],
] as const) test(`${verb} ${args[0]} refuses before any state resolution or mutation`, () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  const result = f.run(verb, ...args, "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ ok: false, error_class: "renamed_verb" });
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  for (const p of f.kept) expect(readFileSync(p, "utf8")).toBe("preserve verbatim\n");
  expect(existsSync(join(f.bus, "reset.fence.json"))).toBe(false);
  expect(existsSync(join(f.bus, "reset.fence.json.lock"))).toBe(false);
  // Same tombstone must answer even when no team can resolve.
  f.env.TAP_INDEX_HOME = join(f.root, "missing-index");
  const missing = f.run(verb, ...args, "--json");
  expect(JSON.parse(missing.out).error_class).toBe("renamed_verb");
  expect(existsSync(f.env.TAP_INDEX_HOME!)).toBe(false);
});

// A missing scratch guard would license hard retirement outside the declared root.
test("reset hard retirement refuses a bus outside the scratch declaration", () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  f.env.TAP_SCRATCH_ONLY = join(f.root, "elsewhere");
  const result = f.run("reset", "--yes", "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).families[0].error_class).toBe("scratch_only_refused");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

for (const noServer of [false, true]) test(`hard reset ${noServer ? "retires with a proved empty namespace" : "refuses an unreadable caller before any retirement"}`, () => {
  const f = fixture(), bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "${noServer ? "no server running on private fixture" : "permission denied"}" >&2\nexit 1\n`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const doc = f.doc();
  doc.seats.b = { ...doc.seats.b, delivery: "pane", pane_id: "%99", session: "r/b" };
  writeFileSync(f.registry, JSON.stringify(doc));
  const before = readFileSync(f.registry, "utf8");
  const result = f.run("reset", "--yes", "--json");
  expect(result.code, result.out + result.err).toBe(noServer ? 0 : 1);
  if (noServer) {
    expect(f.doc().seats).toEqual({});
    expect(existsSync(join(f.root, ".tap/team-history"))).toBe(true);
  } else {
    expect(JSON.parse(result.out).error_class).toBe("caller_identity_unobservable");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(existsSync(join(f.root, ".tap/team-history"))).toBe(false);
  }
});
