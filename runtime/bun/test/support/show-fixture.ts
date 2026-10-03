import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./scratch";


export const showTree = realpathSync(join(import.meta.dir, "../../../.."));

const holder: { path?: string } = {};
export function showScratch(): string {
  return (holder.path ??= realpathSync(mkdtempSync(join(tmpdir(), "tap-show-native."))));
}
export function releaseShowScratch(): void {
  if (holder.path) { removeScratchTree(holder.path); holder.path = undefined; }
}

export interface DoorResult { status: number; stdout: Buffer; stderr: Buffer }
export interface DoorOpts { verbose?: boolean; env?: NodeJS.ProcessEnv }

export interface ShowBase {
  root: string; bus: string; index: string; home: string; registry: string;
  rootB: string; busB: string; registryB: string;
  env: NodeJS.ProcessEnv;
  put(path: string, value: string | Buffer): void;
  putB(path: string, value: string | Buffer): void;
  payload(id: string): string;
  manifest(): unknown;
  nativeDoor(args: string[], opts?: DoorOpts): DoorResult;
  keyFor(args: string[], opts?: DoorOpts & { tag?: string }): string;
}

export interface ShowFixture extends ShowBase {
  parity(args: string[], verbose?: boolean): { code: number; out: string; err: string; key: string };
  parityDoor(args: string[], opts?: DoorOpts & { tag?: string }): { code: number; out: string; err: string; key: string };
}

let goldenCache: Record<string, [number, string, string]> | undefined;

/** Parent goldens via the Bash oracle at base; the scratch dir is masked `<S>`. */
export function goldens(): Record<string, [number, string, string]> {
  return (goldenCache ??= JSON.parse(
    readFileSync(join(showTree, "runtime/bun/test/goldens/show/parity-goldens.json"), "utf8"),
  ));
}

let serial = 0;

/** One show sandbox; `two` adds a second enrolled team with NO TAP_HOME. */
export function buildFixture(opts?: { two?: boolean }): ShowBase {
  const two = opts?.two === true;
  const root = join(showScratch(), String(serial++));
  const rootB = two ? join(showScratch(), String(serial++)) : "";
  const bus = join(root, ".tap/bus"), busB = two ? join(rootB, ".tap/bus") : "";
  const index = join(root, "index"), home = join(root, "home");
  for (const dir of ["payloads", "payloads/.quarantine", "archive", "receipts", "spool/digests"]) mkdirSync(join(bus, dir), { recursive: true });
  if (two) for (const dir of ["payloads", "receipts"]) mkdirSync(join(busB, dir), { recursive: true });
  mkdirSync(index); mkdirSync(home);
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "spec" }, seats: {} }));  const registryB = two ? join(rootB, ".tap/team-registry.json") : "";
  if (two) { mkdirSync(join(rootB, ".tap"), { recursive: true }); writeFileSync(registryB, JSON.stringify({ schema: "0.20", team: { name: "teamb" }, seats: {} })); }
  const teams: Record<string, unknown> = { spec: { root, registry_location: registry, state: "registered" } };
  if (two) teams.teamb = { root: rootB, registry_location: registryB, state: "registered" };
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: home, PWD: root, TAP_INDEX_HOME: index, TAP_REGISTRY: registry,
    TAP_SPOOL_NOW: "1788615000", TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"), TAP_SESSION_MANIFEST: join(root, "sessions.json"), OPENCODE_DB_PATH: join(root, "opencode.db") };
  if (!two) env.TAP_HOME = bus;
  else delete env.TAP_HOME; // two-team: no pin — each door call picks pin/walk
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF; delete env.TAP_VERBOSE; delete env.TAP_BUN_ROUTE_TRACE;
  const put = (path: string, value: string | Buffer) => writeFileSync(join(bus, path), value);
  const putB = (path: string, value: string | Buffer) => writeFileSync(join(busB, path), value);
  const payload = (id: string) => `---\nid: ${id}\nfrom: sender\nto: another-seat\nkind: discuss\npath: body.md\nreply: settle-only\nrecipient_instance: untouched-stamp\nextra: retained\n---\n\nhello\n\n`;
  function manifestOne(path: string): unknown {
    return readdirSync(path).sort().map(name => {
      const child = join(path, name), st = statSync(child);
      return st.isDirectory() ? [name, manifestOne(child)] : [name, readFileSync(child).toString("base64"), st.mode, st.mtimeMs];
    });
  }
  const manifest = (path?: string): unknown =>
    path ? manifestOne(path) : two ? [manifestOne(root), manifestOne(rootB)] : manifestOne(root);
  const doorOpts = (o?: DoorOpts): { cwd: string; env: NodeJS.ProcessEnv; encoding: "buffer" } =>
    ({ cwd: root, env: { ...env, ...(o?.env ?? {}), ...(o?.verbose ? { TAP_VERBOSE: "1" } : {}) }, encoding: "buffer" });
  const run = (spawn: () => ReturnType<typeof spawnSync>): DoorResult => {
    const r = spawn();
    if (r.error) throw r.error;
    if (r.status === null) throw new Error("door exited by signal");
    return { status: r.status, stdout: r.stdout as Buffer, stderr: r.stderr as Buffer };
  };
  const nativeDoor = (args: string[], o?: DoorOpts): DoorResult =>
    run(() => spawnSync(process.execPath, [join(import.meta.dir, "native-show-entry.ts"), ...args], doorOpts(o)));
  let calls = 0;
  const keyFor = (args: string[], o?: DoorOpts & { tag?: string }) =>
    `${serial - 1}:${calls++}:${o?.verbose ? "v" : "q"}:${o?.tag ?? ""}:${JSON.stringify(args.map((a) => a.split(showScratch()).join("<S>")))}`;
  return { root, bus, index, home, registry, rootB, busB, registryB, env, put, putB, payload, manifest, nativeDoor, keyFor };
}

export function fixture(): ShowFixture {
  return withParity(buildFixture());
}

export function fixtureTwo(): ShowFixture {
  return withParity(buildFixture({ two: true }));
}

function withParity(b: ShowBase): ShowFixture {
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const canon = (x: Buffer) => x.toString("utf8").replaceAll(showScratch(), "<S>");
  const filterErr = (x: Buffer, verbose: boolean) =>
    verbose ? Buffer.from(x.toString().split("\n").filter((l) => !l.startsWith("tap verbose: ")).join("\n")) : x;
  function parityDoor(args: string[], opts: DoorOpts & { tag?: string } = {}) {
    const key = b.keyFor(args, opts);
    const want = goldens()[key];
    if (!want) throw new Error(`no golden captured for ${key}`);
    const before = b.manifest();
    const r = b.nativeDoor(args, opts);
    expect(b.manifest()).toEqual(before);
    if (opts.verbose) {
      const records = r.stderr.toString().split("\n").filter((l) => l.startsWith("tap verbose: ")).map((l) => JSON.parse(l.slice(13)));
      expect(records.some((rec) => rec.event === "state_paths" && rec.registry === b.registry)).toBe(true);
      expect(records.some((rec) => rec.event === "state_read")).toBe(false);
    }
    expect([r.status, sha(canon(r.stdout)), sha(canon(filterErr(r.stderr, opts.verbose === true)))])
      .toEqual(want);
    return { code: r.status, out: canon(r.stdout), err: canon(r.stderr), key };
  }
  function parity(args: string[], verbose = false) {
    return parityDoor(args, { verbose });
  }
  return { ...b, parity, parityDoor };
}
