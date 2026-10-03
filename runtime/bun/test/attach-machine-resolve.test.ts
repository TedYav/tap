import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { cmdAttach } from "../src/verbs/attach";
import { TapError } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const scripts = join(resolve(import.meta.dir, "../../.."), "skills/tap/scripts");
const scratch: string[] = [];
const savedEnv: Array<[string, string | undefined]> = [];
afterEach(() => {
  for (const [key, value] of savedEnv.splice(0).reverse()) {
    if (key === "@CWD") process.chdir(value!);
    else if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const dir of scratch.splice(0)) removeScratchTree(dir);
});

const paneRow = (handle: string): Record<string, unknown> => ({ status: "active", delivery: "pane", pane: `fixture/${handle}:0.0`,
  pane_id: "%1", session: `fixture/${handle}`, registered_at: "2026-09-01T00:00:00Z", harness: "claude" });

type Other = { seats: Record<string, unknown> } | { raw: string } | { gone: true } | { historical: true } | { bare: true };

// A machine with one current team (the cwd) and any number of other enrolled
// teams. The tmux shim answers every handle with a live pane and records the
// attach effect, so only a resolved target ever reaches it.
function machine(opts: { local?: Record<string, unknown>; others: Record<string, Other>; anchored?: boolean }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tap-attach-machine.")));
  scratch.push(dir);
  const local = join(dir, "primary");
  const bus = join(local, ".tap", "bus"), bin = join(dir, "bin"), index = join(dir, "index");
  for (const path of [bus, bin, index]) mkdirSync(path, { recursive: true });
  const teams: Record<string, unknown> = {};
  const write = (name: string, root: string, registry: string, bytes: string) => {
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(registry, bytes);
    teams[name] = { root, registry_location: registry, state: "registered" };
  };
  const doc = (name: string, root: string, seats: unknown) => JSON.stringify({ schema: "0.20", team: { name, worktree_root: root }, seats });
  const localRegistry = join(local, ".tap", "team-registry.json");
  write("primary", local, localRegistry, doc("primary", local, opts.local ?? {}));
  for (const [name, other] of Object.entries(opts.others)) {
    const root = join(dir, name), registry = join(root, ".tap", "team-registry.json");
    if ("seats" in other) write(name, root, registry, doc(name, root, other.seats));
    else if ("raw" in other) write(name, root, registry, other.raw);
    else if ("gone" in other) teams[name] = { root, registry_location: registry, state: "registered" };
    else if ("historical" in other) teams[name] = { root, registry_location: registry, state: "historical" };
    else teams[name] = { root, state: "registered" };
  }
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  const effect = join(dir, "attached");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "$1" in -L|-S) shift 2 ;; esac
case "$1" in
  list-sessions)
    if [[ "$*" == *session_attached* ]]; then printf 'fixture/sol\\t4242:100\\t0\\nfixture/a\\t4242:100\\t0\\n';
    else printf 'fixture/sol\\t4242:100\\nfixture/a\\t4242:100\\n'; fi ;;
  list-panes) printf 'fixture/sol\\tfixture/sol:0.0\\t%%1\\tclaude\\t999\\t4242:100\\t0\\nfixture/a\\tfixture/a:0.0\\t%%1\\tclaude\\t999\\t4242:100\\t0\\n' ;;
  display-message) printf '%%1\\n' ;;
  attach-session) printf '%s\\n' "$*" > '${effect}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  for (const [key, value] of Object.entries({
    PATH: `${bin}:${process.env.PATH}`, HOME: dir, TAP_INDEX_HOME: index,
    TAP_BOOT_ID: "boot:1", TAP_SERVER_EPOCH: "srv:4242:100",
    TAP_ONBOARDING_CHECKED: "1", TAP_INTERNAL_OVERDUE_CHECKED: "1",
  })) { savedEnv.push([key, process.env[key]]); process.env[key] = value; }
  const unanchored = opts.anchored === false;
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TEAM_SELECT", "TAP_HOME"]) {
    savedEnv.push([key, process.env[key]]); delete process.env[key];
  }
  if (!unanchored) process.env.TAP_HOME = bus;
  savedEnv.push(["@CWD", process.cwd()]);
  const cwd = unanchored ? join(dir, "elsewhere") : local;
  mkdirSync(cwd, { recursive: true });
  process.chdir(cwd);
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code: number | undefined, error: TapError | undefined;
    try { code = await cmdAttach(args, scripts); }
    catch (thrown) { if (thrown instanceof TapError) error = thrown; else throw thrown; }
    finally { process.stdout.write = so; process.stderr.write = se; }
    return { code, error, stdout: out.join(""), stderr: err.join(""), attached: existsSync(effect) };
  };
  return { dir, run, root: (name: string) => join(dir, name), index };
}

test("a handle unique on another team attaches directly and prints the team it resolved to", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, quiet: { seats: { other: paneRow("other") } } } });
  const r = await m.run(["sol"]);
  expect(r.error).toBeUndefined();
  expect(r.code).toBe(0);
  expect(r.attached).toBe(true);
  expect(r.stdout).toContain("lane/sol");
});

test("the current team wins when the handle exists there", async () => {
  const m = machine({ local: { sol: paneRow("sol") }, others: { lane: { seats: { sol: paneRow("sol") } } } });
  const r = await m.run(["sol"]);
  expect(r.error).toBeUndefined();
  expect(r.attached).toBe(true);
  expect(r.stdout).not.toContain("lane/sol");
});

test("an ambiguous handle refuses and lists every candidate as team/handle", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { laneb: { seats: { sol: paneRow("sol") } }, lanea: { seats: { sol: paneRow("sol") } } } });
  const r = await m.run(["sol"]);
  expect(r.error?.errorClass).toBe("ambiguous_handle");
  expect(r.error?.detail).toContain("lanea/sol");
  expect(r.error?.detail).toContain("laneb/sol");
  expect(r.error?.action).toContain("tap attach <team>/<handle>");
  expect(r.attached).toBe(false);
});

test("an unknown handle keeps today's not_found refusal", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } } } });
  const r = await m.run(["nobody"]);
  expect(r.error?.errorClass).toBe("not_found");
  expect(r.error?.detail).toBe("no seat 'nobody' on team 'primary'");
  expect(r.attached).toBe(false);
});

test("a dead enrollment (root gone) is skipped with a note and cannot hide a candidate", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, ghost: { gone: true }, old: { historical: true } } });
  const r = await m.run(["sol"]);
  expect(r.error).toBeUndefined();
  expect(r.attached).toBe(true);
  expect(r.stderr).toContain("ghost");
  expect(r.stderr).toContain("skipped");
});

test("an unreadable registry under a live root could hide a duplicate: one match refuses unverifiable_handle", async () => {
  for (const raw of ['{"team":', "[]", JSON.stringify({ schema: "0.20", seats: [] }), JSON.stringify({ schema: "0.20", seats: { sol: "not-a-row" } })]) {
    const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, broken: { raw } } });
    const r = await m.run(["sol"]);
    expect(r.error?.errorClass, raw).toBe("unverifiable_handle");
    expect(r.error?.detail).toContain("lane/sol");
    expect(r.error?.detail).toContain("broken");
    expect(r.attached).toBe(false);
  }
});

test("a registry document with no seat map, or a FIFO at the registry path, hides a candidate without blocking", async () => {
  const noSeats = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, bare: { raw: JSON.stringify({ schema: "0.20", team: { name: "bare" } }) } } });
  const missingMap = await noSeats.run(["sol"]);
  expect(missingMap.error?.errorClass).toBe("unverifiable_handle");
  const fifo = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, pipe: { gone: true } } });
  const path = join(fifo.root("pipe"), ".tap", "team-registry.json");
  mkdirSync(join(fifo.root("pipe"), ".tap"), { recursive: true });
  expect(spawnSync("mkfifo", [path]).status).toBe(0);
  const started = Date.now();
  const r = await fifo.run(["sol"]);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(r.error?.errorClass).toBe("unverifiable_handle");
  expect(r.error?.detail).toContain("pipe");
});

test("a registry that is missing under a live root also hides a candidate", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } }, wiped: { seats: {} } } });
  rmSync(join(m.root("wiped"), ".tap", "team-registry.json"));
  const r = await m.run(["sol"]);
  expect(r.error?.errorClass).toBe("unverifiable_handle");
  expect(r.attached).toBe(false);
});

test("an unreadable registry with no match still answers not_found, naming the skip", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { broken: { raw: "{" } } });
  const r = await m.run(["nobody"]);
  expect(r.error?.errorClass).toBe("not_found");
  expect(r.stderr).toContain("broken");
});

test("an ambiguous handle stays ambiguous when another registry is skipped", async () => {
  const m = machine({ local: {}, others: { lanea: { seats: { sol: paneRow("sol") } }, laneb: { seats: { sol: paneRow("sol") } }, broken: { raw: "{" } } });
  const r = await m.run(["sol"]);
  expect(r.error?.errorClass).toBe("ambiguous_handle");
  expect(r.stderr).toContain("broken");
});

test("from a directory on no team, a machine-unique handle attaches", async () => {
  const m = machine({ anchored: false, others: { lane: { seats: { sol: paneRow("sol") } } } });
  const r = await m.run(["sol"]);
  expect(r.error).toBeUndefined();
  expect(r.attached).toBe(true);
  expect(r.stdout).toContain("lane/sol");
});

test("an explicit team selection is never widened", async () => {
  const m = machine({ local: { a: paneRow("a") }, others: { lane: { seats: { sol: paneRow("sol") } } } });
  process.env.TAP_TEAM_SELECT = "primary";
  savedEnv.push(["TAP_TEAM_SELECT", undefined]);
  const r = await m.run(["sol"]);
  expect(r.error?.errorClass).toBe("not_found");
  expect(r.attached).toBe(false);
});

test("a qualified target is untouched: it names its team and never scans", async () => {
  const m = machine({ local: { sol: paneRow("sol") }, others: { lane: { seats: { sol: paneRow("sol") } } } });
  const r = await m.run(["lane/sol"]);
  expect(r.error).toBeUndefined();
  expect(r.attached).toBe(true);
  const miss = await m.run(["lane/a"]);
  expect(miss.error?.errorClass).toBe("not_found");
  expect(basename(m.dir)).toContain("tap-attach-machine");
});
