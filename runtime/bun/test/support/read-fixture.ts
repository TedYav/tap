// Shared read-parity fixture: one enrolled team "spec" sandbox plus the public
// native door. U1's show fixture pattern: the capture script drove the Bash
// door at the base commit, the committed tests replay those bytes at head. The
// Bash arm died with tap-read.sh — the goldens it captured are the incumbent's
// record; only the native door runs here.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "bun:test";

let scratchBase = "";
export function readScratch(): string {
  if (!scratchBase) scratchBase = realpathSync(mkdtempSync(join(tmpdir(), "tap-read-parity.")));
  return scratchBase;
}
export function releaseReadScratch(): void {
  if (scratchBase) rmSync(scratchBase, { recursive: true, force: true });
  scratchBase = "";
}

export interface ReadFixture {
  id: number;
  root: string; bus: string; registry: string;
  put(rel: string, body: string): void;
  payload(id: string, reply?: string, extra?: string): void;
  snapshot(dir?: string): Record<string, string>;
  run(which: "native", args: string[], verbose?: boolean): { code: number; out: string; err: string };
  /** The native door piped into a reader that has already exited (`true`): every write meets a closed pipe. `code` is the door's own exit. */
  runClosedStdout(args: string[]): { code: number | null; out: string; err: string };
  /** The native door piped into `head -c1` (a real early-closing reader) over a real pipe. `code` is the door's own exit. */
  runEarlyReader(args: string[]): { code: number | null; out: string; err: string };
  /** The native door whose stderr write throws EPIPE (staged: Bun never throws that on a real pipe). */
  runFailingStderr(args: string[]): { code: number; out: string; err: string };
  parity(args: string[], verbose?: boolean, tag?: string): { code: number; out: string; err: string; before: Record<string, string>; after: Record<string, string> };
}

let serial = 0, calls = 0;
export function buildFixture(): ReadFixture {
  const root = join(readScratch(), String(serial++));
  const bus = join(root, ".tap/bus"), index = join(root, "index"), home = join(root, "home");
  for (const dir of ["payloads", "receipts", "archive", "spool/digests"]) mkdirSync(join(bus, dir), { recursive: true });
  mkdirSync(index); mkdirSync(home);
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "spec" }, seats: { reader: { instance: "reader|new", status: "active" }, peer: { instance: "peer|new" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { spec: { root, registry_location: registry, state: "registered" } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: home, PWD: root, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "reader", TAP_VERBOSE: "0", TAP_SPOOL_NOW: "1788615000", TAP_SESSION_MANIFEST: join(root, "sessions.json"), TAP_VERSION_SEEN_PATH: join(root, "seen.json"), OPENCODE_DB_PATH: join(root, "opencode.db") };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_BUN_ROUTE_TRACE;
  const canon = (text: string): string => text.split(root).join("<R>");
  function put(rel: string, body: string): void { writeFileSync(join(bus, rel), body); }
  function payload(id: string, reply = "settle-only", extra = ""): void {
    put(`payloads/${id}.md`, `---\nid: ${id}\nfrom: sender\nto: reader\nkind: discuss\npath: ${join(bus, "payloads", id + ".md")}\n${reply ? `reply: ${reply}\n` : ""}${extra}---\n\nbody café\n\n`);
  }
  function snapshot(dir = root): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (p: string): void => { for (const entry of readdirSync(p, { withFileTypes: true })) { const child = join(p, entry.name); if (entry.isDirectory()) visit(child); else {
      let value = readFileSync(child, "utf8");
      // Receipt/event wall stamps are intentionally real. Preserve every other
      // byte and field; age output is separately pinned with TAP_SPOOL_NOW.
      if (/\.(done|read)$/.test(child)) value = value.replace(/"at":"[^"]+"/g, '"at":"<at>"');
      if (child.endsWith('registry-events.log')) value = value.replace(/ts=[^ ]+/g, 'ts=<ts>');
      out[child.slice(root.length)] = canon(value);
    } } };
    visit(dir); return out;
  }
  function run(which: "native", args: string[], verbose = false): { code: number; out: string; err: string } {
    const result = spawnSync(process.execPath,
      [join(import.meta.dir, "native-read-entry.ts"), ...args],
      { cwd: root, encoding: "utf8", env: { ...env, TAP_VERBOSE: verbose ? "1" : "0" } });
    return { code: result.status ?? 1, out: canon(result.stdout ?? ""), err: canon(result.stderr ?? "") };
  }
  function runClosedStdout(args: string[]): { code: number | null; out: string; err: string } {
    const result = spawnSync("bash", ["-c", '"$0" "$@" | true; echo "rc=${PIPESTATUS[0]}" >&2', process.execPath, join(import.meta.dir, "../../main.ts"), "read", ...args],
      { cwd: root, encoding: "utf8", env });
    const rc = /rc=(\d+)\n$/.exec(result.stderr ?? "");
    return { code: rc ? Number(rc[1]) : null, out: canon(result.stdout ?? ""), err: canon((result.stderr ?? "").replace(/rc=\d+\n$/, "")) };
  }
  function throughShell(script: string, args: string[]): { code: number | null; out: string; err: string } {
    const result = spawnSync("bash", ["-c", script, process.execPath, join(import.meta.dir, "../../main.ts"), "read", ...args], { cwd: root, encoding: "utf8", env });
    const rc = /rc=(\d+)\n$/.exec(result.stderr ?? "");
    return { code: rc ? Number(rc[1]) : null, out: canon(result.stdout ?? ""), err: canon((result.stderr ?? "").replace(/rc=\d+\n$/, "")) };
  }
  const runEarlyReader = (args: string[]) => throughShell('"$0" "$@" | head -c1 >/dev/null; echo "rc=${PIPESTATUS[0]}" >&2', args);
  function runFailingStderr(args: string[]): { code: number; out: string; err: string } {
    const result = spawnSync(process.execPath, [join(import.meta.dir, "read-stderr-epipe-entry.ts"), ...args], { cwd: root, encoding: "utf8", env });
    return { code: result.status ?? 1, out: canon(result.stdout ?? ""), err: canon(result.stderr ?? "") };
  }
  function parity(args: string[], verbose = false, tag = ""): { code: number; out: string; err: string; before: Record<string, string>; after: Record<string, string> } {
    const key = parityKey(serial - 1, verbose, tag, args);
    const before = snapshot();
    const native = run("native", args, verbose);
    if (verbose) {
      const records = native.err.split("\n").filter(l => l.startsWith("tap verbose: ")).map(l => JSON.parse(l.slice(13)));
      if (records.some(r => r.event === "state_paths")) expectStatePath(records, canon(registry));
      expect(records.some(r => r.event === "state_read")).toBe(false);
    }
    const want = goldens()[key];
    if (!want) throw new Error(`no read parity golden for ${key}`);
    expect({ code: native.code, out: shaDoor(native.out, verbose), err: shaDoor(native.err, verbose) }).toEqual(want);
    const after = snapshot();
    return { ...native, before, after };
  }
  return { id: serial - 1, root, bus, registry, put, payload, snapshot, run, runClosedStdout, runEarlyReader, runFailingStderr, parity };
}
function parityKey(fixtureId: number, verbose: boolean, tag: string, args: string[]): string {
  const mask = readScratch();
  return `${fixtureId}:${calls++}:${verbose ? "v" : "q"}:${tag}:${JSON.stringify(args.map(a => a.split(mask).join("<S>")))}`;
}
export { parityKey };
/** Door-byte hash: verbose stderr keeps its `tap verbose: ` ledger out of the digest. */
export function shaDoor(text: string, verbose: boolean): string {
  return createHash("sha256").update(verbose ? text.split("\n").filter(l => !l.startsWith("tap verbose: ")).join("\n") : text).digest("hex");
}
function expectStatePath(records: Array<Record<string, unknown>>, registry: string): void {
  const hit = records.find(r => r.event === "state_paths") as { registry?: string } | undefined;
  expect(hit?.registry ?? "").toBe(registry);
}
let goldenCache: Record<string, { code: number; out: string; err: string }> | null = null;
export function goldens(): Record<string, { code: number; out: string; err: string }> {
  if (!goldenCache) {
    const parsed: Record<string, { code: number; out: string; err: string }> = JSON.parse(readFileSync(join(import.meta.dir, "../goldens/read/parity-goldens.json"), "utf8"));
    goldenCache = parsed;
  }
  return goldenCache;
}
export function releaseGoldens(): void { goldenCache = null; }
