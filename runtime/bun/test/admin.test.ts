import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { loads, type JsonMap } from "../src/watch-detect";
import { cmdAdmin, fingerprintOf, readMachineIndex } from "../src/verbs/admin";
import { NO_MACHINE_INDEX } from "../src/selector";

const root = resolve(import.meta.dir, "../../..");
const scriptsDir = join(root, "skills/tap/scripts");
const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); }, 30000);

const NOW = 2000000000; // fixed clock: ages, staleness and breadcrumbs are pinned

function fixture(): ReturnType<typeof build> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tap-admin.")));
  scratch.push(base);
  return build(base);
}

function build(base: string) {
  const cwd = join(base, "outside"); const cwd2 = join(base, "elsewhere");
  const index = join(base, "index"); const bin = join(base, "bin");
  for (const p of [cwd, cwd2, index, bin, join(base, "home")]) mkdirSync(p);
  const tap = join(bin, "tap"); symlinkSync(join(root, "bin/tap"), tap);
  const log = join(base, "spawns"); writeFileSync(log, "");
  const teams: Record<string, unknown> = {}; const sessions: string[] = []; const panes: string[] = [];
  // The census must not touch team roots, the index or the caller's cwd. The
  // sandbox root itself is NOT walked: it holds this harness's own spawn log,
  // route trace and snapshots, which the runs legitimately append to.
  const roots: string[] = [cwd, index];
  function active(name: string, pane: number, overrides: { harness?: string } = {}) {
    sessions.push(`${name}\t1:1\t1`); panes.push(`${name}\t${name}:0.0\t%${pane}\t${overrides.harness === "cursor" ? "cursor-agent" : "codex"}\t123\t1:1\t0`);
    return { status: "active", session: name, pane: `${name}:0.0`, pane_id: `%${pane}`, harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1", registered_at: "2020-01-01T00:00:00Z", ...overrides };
  }
  function team(name: string, seats: Record<string, unknown>, opts: { corrupt?: boolean; registry?: string; dropRegistry?: boolean; raw?: string | Uint8Array } = {}) {
    const teamRoot = join(base, name); mkdirSync(join(teamRoot, ".tap", "bus", "payloads"), { recursive: true });
    roots.push(teamRoot);
    const reg = join(teamRoot, ".tap", "team-registry.json");
    if (!opts.dropRegistry) writeFileSync(reg, opts.raw ?? (opts.corrupt ? "{broken" : JSON.stringify({ schema: "0.20", team: { name, worktree_root: teamRoot }, seats })));
    teams[name] = { root: teamRoot, registry_location: opts.registry ?? reg, state: "registered" };
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
    return { teamRoot, reg };
  }
  function payload(bus: string, name: string, fields: Record<string, string>, ageSeconds = 0) {
    const body = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
    const path = join(bus, "payloads", name);
    writeFileSync(path, `---\n${body}\n---\n\nbody\n`);
    utimesSync(path, new Date((NOW - ageSeconds) * 1000), new Date((NOW - ageSeconds) * 1000));
  }
  const saveSnapshot = () => { writeFileSync(join(base, "sessions"), sessions.join("\n") + "\n"); writeFileSync(join(base, "panes"), panes.join("\n") + "\n"); };
  saveSnapshot();
  const frames = join(base, "frames"); mkdirSync(frames);
  writeFileSync(join(bin, "python3"), `#!/bin/sh
printf 'python3 %s\\n' "$*" >> "$PROBE_LOG"
exec '${realPython}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) cat "$SNAPSHOT_DIR/sessions" ;;
 list-panes) cat "$SNAPSHOT_DIR/panes" ;;
 display-message) printf '1:1\\n' ;;
 capture-pane)
   target=""; prev=""
   for a in "$@"; do [ "$prev" = "-t" ] && target="$a"; prev="$a"; done
   if [ -n "$target" ] && [ -f "$SEATSTATE_FRAMES/$target" ]; then cat "$SEATSTATE_FRAMES/$target"; else exit 1; fi ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), TAP_INDEX_HOME: index, TAP_HOME: "", TAP_BOOT_ID: "boot:1", TAP_BOOT_ID_LEGACY: "boot:1", TAP_SERVER_EPOCH: "srv:1:1", PROBE_LOG: log, SNAPSHOT_DIR: base, SEATSTATE_FRAMES: frames, TAP_WATCH_NOW: String(NOW), TAP_BUN_ROUTE_TRACE: join(base, "route"), CLICOLOR_FORCE: "" };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF; delete env.NO_COLOR;
  const run = (args: string[], extras: NodeJS.ProcessEnv = {}) => {
    writeFileSync(log, "");
    const result = spawnSync(tap, ["admin", ...args], { cwd, env: { ...env, ...extras }, encoding: "utf8", timeout: 30000 });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, spawns: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  };
  const trace = () => readFileSync(join(base, "route"), "utf8").trim().split("\n").filter(Boolean);
  const snapshotTree = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        const s = statSync(p);
        // Regular files carry BYTES (digest), size and mtime; directories stay
        // metadata-only evidence. The sandbox HOME walks too: the census may
        // not write caches under it any more than under a team root.
        out[p] = s.isDirectory() ? "d" : `${s.size}:${s.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
        if (s.isDirectory()) walk(p);
      }
    };
    for (const r of [...roots, join(base, "home")]) {
      // A purge test deletes a team root after enrolling it: gone is gone.
      if (!existsSync(r)) continue;
      walk(r);
    }
    return out;
  };
  // Serves controlled capture-pane content for one pane target, so the real
  // tap_seat_state classifies real bytes; missing frames keep the old refusal.
  // Pane targets contain "/", so the lookup path gets real subdirectories.
  const frame = (pane: string, text: string) => {
    const path = join(frames, pane);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  // Seeds the seat-state wedge cache with the hash lib.sh would compute for a
  // frame: $(...) strips trailing newlines, python rejoins whitespace, sha256.
  const seedWedgeHash = (bus: string, handle: string, frameText: string) => {
    mkdirSync(join(bus, "seat-state"), { recursive: true });
    const full = frameText.replace(/\n+$/, "");
    const normalized = spawnSync(realPython, ["-c", "import sys; print(' '.join(sys.stdin.read().split()))"], { input: full, encoding: "utf8" }).stdout;
    const hash = spawnSync("shasum", ["-a", "256"], { input: normalized, encoding: "utf8" }).stdout.split(" ")[0]!;
    writeFileSync(join(bus, "seat-state", `${handle}.hash`), hash);
  };
  return { base, cwd, cwd2, index, env, team, active, payload, saveSnapshot, run, trace, snapshotTree, frame, seedWedgeHash, bus: (teamRoot: string) => join(teamRoot, ".tap", "bus") };
}

test("public admin grammar routes natively: default, explicit and leading-flag dashboard", () => {
  const f = fixture(); f.team("solo", { alive: f.active("solo/alive", 1) }); f.saveSnapshot();
  const bare = f.run([]);
  expect(bare.status, bare.stderr).toBe(0);
  expect(bare.stdout).toContain("tap admin dashboard: 1 team(s) indexed");
  expect(bare.stdout).toContain("solo  active");
  expect(f.trace()).toEqual(["native admin"]);
  const explicit = f.run(["dashboard"]);
  expect(explicit.status).toBe(0); expect(explicit.stdout).toBe(bare.stdout);
  const json = f.run(["--json"]);
  expect(json.status).toBe(0);
  const doc = JSON.parse(json.stdout);
  expect(Object.keys(doc)).toEqual(["teams", "attention", "cannot_check", "old_store", "missing"]);
  const stale = f.run(["--stale-after", "5", "--json"]);
  expect(stale.status).toBe(0); expect(JSON.parse(stale.stdout).teams).toHaveLength(1);
}, 30000);

test("dashboard flag refusals refuse with the expected diagnostics", () => {
  const f = fixture();
  const humanCases: Array<[string[], number, string]> = [
    [["dashboard", "--bogus"], 1, "tap admin dashboard: unknown option '--bogus'; next: tap help admin dashboard\n"],
    [["dashboard", "extra"], 1, "tap admin dashboard: unexpected arg 'extra'; next: tap help admin dashboard\n"],
    [["dashboard", "--stale-after", "abc"], 1, "tap admin dashboard: --stale-after needs a non-negative integer, got 'abc'; next: tap help admin dashboard\n"],
    [["bogus"], 1, "tap: unknown subcommand 'bogus' (usage: tap admin [dashboard]|refresh|retire|rebuild-registry); next: tap help admin\n"],
  ];
  const actual = humanCases.map(([args]) => { const r = f.run(args); return [args.join(" "), r.status, r.stdout, r.stderr]; });
  expect(actual).toEqual(humanCases.map(([args, status, stderr]) => [args.join(" "), status, "", stderr]));
  // Ambient TAP_JSON must not reach a dashboard refusal: the native path
  // clobbers TAP_JSON=0 after sub dispatch.
  const r = f.run(["dashboard", "--bogus"], { TAP_JSON: "1" });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("unknown option '--bogus'");
}, 30000);

test("prune tombstone refuses with the renamed-verb receipt, human and JSON", () => {
  const f = fixture();
  const native = f.run(["prune"]);
  expect(native.status).toBe(1);
  expect(native.stderr).toBe("tap admin prune: tap admin prune is now: tap admin refresh plus tap admin retire <team>; next: tap admin refresh   # or: tap admin retire <team>\n");
  const nativeJson = f.run(["prune", "--json"]);
  expect(nativeJson.status).toBe(1);
  expect(JSON.parse(nativeJson.stdout)).toEqual({ ok: false, error_class: "renamed_verb", action: "tap admin refresh   # or: tap admin retire <team>", detail: "tap admin prune is now: tap admin refresh plus tap admin retire <team>" });
  // The prune pre-scan ORs --json starting from the ambient value: no --json
  // flag, but an ambient TAP_JSON=1 still renders the same JSON envelope.
  const ambientNative = f.run(["prune"], { TAP_JSON: "1" });
  expect(ambientNative.stdout).toBe(nativeJson.stdout);
  expect(ambientNative.stderr).toBe("");
}, 30000);

test("stale-after missing or empty value refuses with exit 1", () => {
  const f = fixture();
  for (const args of [["dashboard", "--stale-after"], ["dashboard", "--stale-after", ""]]) {
    const r = f.run(args);
    expect(r.status, args.join(" ")).toBe(1);
  }
}, 30000);

test("unknown subcommand refuses with the bare tap label and incumbent usage", () => {
  const f = fixture();
  const r = f.run(["bogus"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toBe("tap: unknown subcommand 'bogus' (usage: tap admin [dashboard]|refresh|retire|rebuild-registry); next: tap help admin\n");
}, 30000);

test("migrate-registry is a removed-verb stub: old_store, exit 1, no child", () => {
  const f = fixture();
  const detail = 'tap admin migrate-registry was removed; this TAP reads only {"schema":"0.20","team":{...},"seats":{...}} team registries and never converts old files';
  const action = 'ask an agent to upgrade an old team registry by hand (rename "agents" to "seats", add "schema": "0.20"); move an old teams.json or launcher sessions.json aside; then run tap init';
  for (const args of [["migrate-registry"], ["migrate-registry", "--yes"], ["migrate-registry", "--nope", "extra"]]) {
    const r = f.run(args);
    expect(r.status, args.join(" ")).toBe(1);
    expect(r.stderr).toBe(`tap admin migrate-registry: ${detail}; next: ${action}\n`);
    expect(r.spawns).toEqual([]);
  }
  const json = f.run(["migrate-registry", "--yes", "--json"]);
  expect(json.status).toBe(1);
  expect(JSON.parse(json.stdout)).toEqual({ ok: false, error_class: "old_store", action, detail });
  expect(json.spawns).toEqual([]);
}, 30000);

test("rebuild-registry refuses natively with a flag error", () => {
  const f = fixture();
  for (const args of [["rebuild-registry", "--bogus"]]) {
    writeFileSync(join(f.base, "route"), "");
    const r = f.run(args, { TAP_JSON: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown option '--bogus'");
    expect(r.stdout).toBe("");
    expect(f.trace()).toEqual(["native admin"]);
  }
}, 30000);

test("dashboard oracle: native output classifies a mixed roster", () => {
  const f = fixture();
  const healthy = f.team("healthy", {
    alive: f.active("healthy/alive", 1),
    parked: { status: "suspended", harness: "codex", registered_at: "2020-01-01T00:00:00Z" },
  });
  // Outstanding send with no receipt: stale after 900s; plus one inbound payload.
  // Keys are the REGISTRY handles: the unsettled scan buckets by raw handle.
  f.payload(f.bus(healthy.teamRoot), "s1.md", { from: "alive", to: "other" }, 2000);
  f.payload(f.bus(healthy.teamRoot), "i1.md", { to: "alive" }, 10);
  f.team("pollonly", { watcher: { status: "active", delivery: "poll", harness: "codex" } });
  f.team("corrupt", {}, { corrupt: true });
  const goneRoot = join(f.base, "doomed"); mkdirSync(goneRoot, { recursive: true });
  f.team("doomed", {}, { registry: join(goneRoot, ".tap", "team-registry.json") });
  rmSync(goneRoot, { recursive: true, force: true });
  f.team("nothere", {}, { dropRegistry: true, registry: join(f.base, "nothere", ".tap", "team-registry.json") });
  const indexed = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  indexed.teams.past = { root: join(f.base, "x"), registry_location: "", state: "historical" };
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: indexed.teams }));
  f.saveSnapshot();
  const native = f.run(["--json"]);
  // The corrupt-team stderr diagnostic, wrapper and python detail included.
  expect(native.stderr).toContain("registry.json is invalid JSON");
  const doc = JSON.parse(native.stdout);
  expect(doc.cannot_check).toEqual(["corrupt"]);
  expect(doc.missing).toEqual([{ team: "doomed", reason: "root_gone" }, { team: "nothere", reason: "registry_missing" }]);
  expect(doc.teams.map((t: any) => [t.name, t.classification]).sort()).toEqual([["corrupt", "unreadable"], ["doomed", "dangling"], ["healthy", "active"], ["nothere", "unreadable"], ["pollonly", "active"]]);
  const healthyRow = doc.attention.find((a: any) => a.team === "healthy");
  expect(healthyRow.handle).toBe("alive");
  expect(healthyRow.why).toContain("1 stale outstanding send(s) with no .done after 900s");
  expect(healthyRow.obligations).toEqual({ inbound_unsettled: 1, outstanding_unsettled: 1, sample_ids: ["i1", "s1"] });
  expect(native.status).toBe(1); // cannot_check outranks attention
}, 30000);

test("dashboard counts spool-parked sends as unsettled outstanding (tap-ktqz)", () => {
  const f = fixture();
  const parked = f.team("parked", { alive: f.active("parked/alive", 1) });
  const bus = f.bus(parked.teamRoot);
  // A spool-parked send never reaches payloads/: the payload scan cannot see
  // it, so the unsettled scan must. Ages: only the spool-only send is stale.
  f.payload(bus, "both.md", { from: "alive", to: "other" }, 30);
  const spoolSend = (name: string, fields: Record<string, string>, ageSeconds = 0) => {
    const body = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
    const path = join(bus, "spool", name);
    mkdirSync(join(bus, "spool"), { recursive: true });
    writeFileSync(path, `---\n${body}\n---\n\nbody\n`);
    utimesSync(path, new Date((NOW - ageSeconds) * 1000), new Date((NOW - ageSeconds) * 1000));
  };
  spoolSend("only-spool.md", { from: "alive", to: "other" }, 2000);
  // Present in both payloads/ and spool/: the dedupe must count it once.
  spoolSend("both.md", { from: "alive", to: "other" }, 30);
  spoolSend("done-spool.md", { from: "alive", to: "other" }, 2000);
  mkdirSync(join(bus, "receipts"), { recursive: true });
  writeFileSync(join(bus, "receipts", "done-spool.done"), "");
  spoolSend("cancelled-spool.md", { from: "alive", to: "other" }, 2000);
  writeFileSync(join(bus, "receipts", "cancelled-spool.cancelled"), "");
  // A directory at the receipt path is not a cancellation (review finding).
  spoolSend("dir-receipt.md", { from: "alive", to: "other" }, 30);
  mkdirSync(join(bus, "receipts", "dir-receipt.cancelled"), { recursive: true });
  f.saveSnapshot();
  const doc = JSON.parse(f.run(["--json"]).stdout);
  const row = doc.attention.find((a: any) => a.team === "parked");
  expect(row.why).toContain("1 stale outstanding send(s) with no .done after 900s");
  expect(row.obligations.outstanding_unsettled).toBe(3);
  const ids: string[] = row.obligations.sample_ids;
  expect(ids).toContain("only-spool");
  expect(ids).toContain("both");
  expect(ids).not.toContain("done-spool");
  expect(ids).not.toContain("cancelled-spool");
  expect(ids).toContain("dir-receipt");
}, 30000);

test("seat-state attention branches fire from real tap_seat_state classifications", () => {
  const f = fixture();
  const limit = f.team("alertlimit", { lim: f.active("alertlimit/lim", 1) });
  f.frame("alertlimit/lim:0.0", "rate limit reached\n");
  const idle = f.team("idlein", { idler: f.active("idlein/idler", 2) });
  f.frame("idlein/idler:0.0", "❯\n");
  f.payload(f.bus(idle.teamRoot), "i1.md", { to: "idler" }, 5);
  const stuck = f.team("stuck", { wedged: f.active("stuck/wedged", 3) });
  f.frame("stuck/wedged:0.0", "plodding along\n");
  f.seedWedgeHash(f.bus(stuck.teamRoot), "wedged", "plodding along\n");
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0); // attention rows are reported state (CLI-EXIT-0)
  const rows = JSON.parse(r.stdout).attention;
  const byTeam = Object.fromEntries(rows.map((a: any) => [a.team, a]));
  expect(byTeam.alertlimit.state).toBe("rate-limited-error");
  expect(byTeam.alertlimit.why).toBe("seat rate-limited-error");
  expect(byTeam.idlein.state).toBe("idle-at-prompt");
  expect(byTeam.idlein.why).toBe("idle-at-prompt with 1 unsettled inbound payload(s)");
  expect(byTeam.stuck.state).toBe("wedged");
  expect(byTeam.stuck.why).toBe("seat wedged");
}, 30000);

// tap-3oox6: a seat parked on its harness's real approval prompt needs the
// operator alone, so the attention list names it and puts it first.
test("a seat on a real approval prompt is attention, listed before other attention", () => {
  const f = fixture();
  const stuck = f.team("aaa-stuck", { wedged: f.active("aaa-stuck/wedged", 1) });
  f.frame("aaa-stuck/wedged:0.0", "plodding along\n");
  f.seedWedgeHash(f.bus(stuck.teamRoot), "wedged", "plodding along\n");
  f.team("zzz-asks", { probe: f.active("zzz-asks/probe", 2, { harness: "cursor" }) });
  f.frame("zzz-asks/probe:0.0", readFileSync(join(import.meta.dir, "fixtures/agent-state/cursor/blocked-real.txt"), "utf8"));
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0); // attention rows are reported state (CLI-EXIT-0)
  const rows = JSON.parse(r.stdout).attention;
  expect(rows.map((a: any) => [a.team, a.state])).toEqual([["zzz-asks", "blocked-on-approval"], ["aaa-stuck", "wedged"]]);
  expect(rows[0].why).toBe("blocked on an approval prompt; needs you: tap attach zzz-asks/probe");
}, 30000);

test("hidden payload files are not obligations: .ghost.md cannot page", () => {
  const f = fixture();
  const t = f.team("quiet", { alive: f.active("quiet/alive", 1) });
  f.payload(f.bus(t.teamRoot), ".ghost.md", { from: "alive" }, 5000);
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
  expect(JSON.parse(r.stdout).attention).toEqual([]);
}, 30000);

test("a failed shared observation is a refused census, not a clean report", () => {
  const f = fixture();
  f.team("solo", { alive: f.active("solo/alive", 1) });
  f.saveSnapshot();
  // The engine parameter IS the admin observation seam: one throw must refuse
  // the whole census (rc 1, nothing rendered) instead of printing a roster of
  // seats it never observed. The sandbox env is pinned so the in-process call
  // reads this fixture's index, never the operator's machine.
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalIndex = process.env.TAP_INDEX_HOME;
  const originalHome = process.env.HOME;
  const originalJson = process.env.TAP_JSON;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.env.TAP_INDEX_HOME = f.index;
  process.env.HOME = join(f.base, "home");
  let status: number;
  try {
    status = cmdAdmin(["dashboard", "--json"], scriptsDir, () => { throw new Error("classifier exploded"); });
  } finally {
    process.stdout.write = originalWrite;
    if (originalIndex === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = originalIndex;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalJson === undefined) delete process.env.TAP_JSON; else process.env.TAP_JSON = originalJson;
  }
  expect(status).toBe(1);
  expect(written.join("")).toBe("");
}, 30000);

test("seat fingerprints sort keys by code point, python's sort_keys order", () => {
  const text = '{"\uE000":1,"\u{10000}":2}';
  const golden = spawnSync(realPython, ["-c", "import json,sys,base64; ent=json.load(sys.stdin); sys.stdout.write(base64.urlsafe_b64encode(json.dumps(ent, sort_keys=True, separators=(',', ':')).encode()).decode())"], { input: text, encoding: "utf8" }).stdout;
  expect(golden.length).toBeGreaterThan(0);
  // U+E000 must sort BEFORE U+10000: a UTF-16 code-unit comparator puts the
  // astral surrogate pair first and flips the bytes checkpoint B would consume.
  expect(fingerprintOf(loads(text) as JsonMap)).toBe(golden);
}, 30000);

test("corrupt-data stderr detail names the failure; the refusal id plus path are the contract", () => {
  const f = fixture();
  // An ESCAPE error and a VALID MULTIBYTE SEQUENCE followed by an invalid byte:
  // two shapes a permissive reader would silently accept. Strict decoding is
  // unchanged, and the stderr detail is the reader's own JavaScript message —
  // the pinned contract is the refusal id, the path and the structured
  // cannot-check result, never a foreign runtime's wording.
  const escapeRaw = Buffer.from('{"schema":"0.20","seats":{"w":"\\q"}}');
  f.team("esc", {}, { raw: escapeRaw });
  const mbRaw = Buffer.concat([Buffer.from('{"note":"caf\u00e9r",'), Buffer.from([0xe9]), Buffer.from(',"seats":{}}')]);
  f.team("mbyte", {}, { raw: mbRaw });
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status).toBe(1);
  // The reader's own line lands once per corrupt team — a regression that
  // reports only one team's bytes turns the count red.
  expect(r.stderr.match(/registry\.json is invalid JSON \(.+\)\n/g)?.length).toBe(2);
  expect(r.stderr).not.toContain("untranslated");
  // The structured result is unchanged: both teams cannot-check with the
  // registry_corrupt refusal, and each team's detail names its own registry
  // path.
  const doc = JSON.parse(r.stdout);
  expect(doc.cannot_check).toEqual(["esc", "mbyte"]);
  for (const team of doc.teams.filter((t: any) => ["esc", "mbyte"].includes(t.name))) {
    expect(team.classification).toBe("unreadable");
  }
  const verbose = f.run(["--verbose"]);
  for (const name of ["esc", "mbyte"]) {
    expect(verbose.stdout).toContain(`${name}: registry.json at ${join(f.base, name, ".tap", "team-registry.json")} could not be parsed as JSON`);
  }
}, 30000);

test("a BOM-prefixed registry still refuses: strict decoding is unchanged", () => {
  const f = fixture();
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schema":"0.20","team":{},"seats":{}}')]);
  f.team("bom", {}, { raw });
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status).toBe(1);
  // pyReadUtf8 deliberately keeps the BOM, and the lossless parser refuses a
  // document that does not start with a JSON value — the BOM never becomes a
  // silent accept: registry_invalid, the path in the detail.
  expect(JSON.parse(r.stdout).cannot_check).toEqual(["bom"]);
  const verbose = f.run(["--verbose"]);
  expect(verbose.status).toBe(1);
  expect(verbose.stdout).toContain(`bom: registry.json at ${join(f.base, "bom", ".tap", "team-registry.json")} could not be parsed as JSON`);
  expect(r.stderr).toMatch(/registry\.json is invalid JSON \(.+\)\n/);
}, 30000);

test("non-string index roots refuse registry_invalid with the replayed row-join line", () => {
  const f = fixture();
  const writeIndex = (teams: Record<string, unknown>) => writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  const refusal = { ok: false, error_class: "registry_invalid", action: "tap admin dashboard", detail: `machine index '${join(f.index, "global-registry.json")}' could not be read — cannot check` };
  // The replayed split, now native: a FALSY root short-circuits the incumbent's
  // isdir arm and dies at the str-join; a truthy INT OR BOOL root rides isdir's
  // file-descriptor admission and also dies at the join. A truthy value of any
  // other type dies INSIDE isdir. The line is deterministic JavaScript now —
  // the pinned contract is the refusal id plus the path, never a foreign
  // runtime's wording.
  const joinLine = (type: string) => `TypeError: sequence item 1: expected str instance, ${type} found`;
  const isdirLine = (type: string) => `TypeError: stat: path should be string, bytes, os.PathLike or integer, not ${type}`;
  const shapes: Array<[string, unknown, string]> = [
    ["nullroot", null, joinLine("NoneType")],
    ["dictroot", {}, joinLine("dict")],
    ["dictfullroot", { a: 1 }, isdirLine("dict")],
    ["zeroroot", 0, joinLine("int")],
    ["falseroot", false, joinLine("bool")],
    ["numroot", 5, joinLine("int")],
    ["trueroot", true, joinLine("bool")],
    ["floatroot", 5.5, isdirLine("float")],
  ];
  for (const [name, root, line] of shapes) {
    const entry = { root, registry_location: "" };
    writeIndex({ [name]: entry });
    const r = f.run(["--json"]);
    expect(r.status, name).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual(refusal);
    expect(r.stderr, name).toBe(`${line}\n`);
  }
  // The empty string keeps the existing dangling shape.
  writeIndex({ emptyroot: { root: "", registry_location: "" } });
  const empty = f.run(["--json"]);
  expect(empty.status).toBe(0);
  expect(JSON.parse(empty.stdout).missing).toEqual([{ team: "emptyroot", reason: "root_gone" }]);
}, 30000);

test("an attention-only roster reports its rows and exits 0, like a clean one (CLI-EXIT-0)", () => {
  const f = fixture();
  const t = f.team("staleonly", { alive: f.active("staleonly/alive", 1) });
  f.payload(f.bus(t.teamRoot), "s9.md", { from: "alive" }, 5000);
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
  expect(JSON.parse(r.stdout).attention.length).toBeGreaterThan(0);
  expect(JSON.parse(r.stdout).cannot_check).toEqual([]);
  const clean = fixture();
  clean.team("calm", { alive: clean.active("calm/alive", 1) });
  clean.saveSnapshot();
  expect(clean.run([]).status).toBe(0);
}, 30000);

test("H1 repair: absent indexed acting registry reports registry_missing despite a bus decoy", () => {
  const f = fixture();
  const { teamRoot } = f.team("hijacked", { ghost: { status: "active", harness: "codex" } });
  // The legacy bus still carries a fully populated acting registry: the decoy.
  writeFileSync(join(teamRoot, ".tap", "bus", "registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "hijacked", worktree_root: teamRoot },
    seats: { ghost: { status: "active", harness: "codex" } },
  }));
  // The live marker's indexed acting location is gone: the authority is ABSENT.
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { hijacked: { root: teamRoot, registry_location: join(teamRoot, ".tap", "vanished-acting.json"), state: "registered" } },
  }));
  const r = f.run(["--json"]);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.missing).toEqual([{ team: "hijacked", reason: "registry_missing" }]);
  expect(doc.cannot_check).toEqual([]);
  expect(doc.attention).toEqual([]);
  expect(doc.teams).toEqual([{ name: "hijacked", classification: "unreadable", root: teamRoot }]);
  expect(r.stdout).not.toContain("ghost  active");
  const text = f.run([]);
  expect(text.stdout).toContain("tap admin dashboard: 1 missing team(s) detected - run tap admin refresh to purge them");
  const verbose = f.run(["--verbose"]);
  expect(verbose.stdout).toContain("hijacked");
  expect(verbose.stdout).toContain("no acting registry found under an enrolled root");
}, 30000);

test("malformed seat rows follow the incumbent: skipped non-objects, falsy delivery defaults to pane", () => {
  const f = fixture();
  const { teamRoot } = f.team("messy", {});
  // delivery: 0 is falsy, so the incumbent default applies: delivery "pane".
  // Non-object rows are skipped; suspended seats keep the roster probe-free.
  writeFileSync(join(teamRoot, ".tap", "team-registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "messy", worktree_root: teamRoot },
    seats: { junk: "a plain string row", alsoJunk: 5, real: { status: "suspended", harness: "codex" }, polld: { status: "suspended", delivery: 0, harness: "codex" } },
  }));
  f.saveSnapshot();
  const r = f.run(["--full", "--json"]);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.cannot_check).toEqual([]);
  expect(doc.attention).toEqual([]);
  expect(doc.teams).toHaveLength(1);
  expect(doc.teams[0].classification).toBe("dormant");
  expect(doc.teams[0].seats).toEqual([
    { handle: "polld", status: "suspended", pane: "", harness: "codex", delivery: "pane", state: "unknown" },
    { handle: "real", status: "suspended", pane: "", harness: "codex", delivery: "pane", state: "unknown" },
  ]);
}, 30000);

test("P2: a non-string join field corrupts the whole team instead of normalizing to healthy", () => {
  const f = fixture();
  for (const [handle, seat] of [
    ["num", { status: "active", harness: "codex", pane: 7 }],
    ["nullpane", { status: "active", harness: "codex", pane: null }],
    ["nullstatus", { status: null, harness: "codex" }],
  ] as const) {
    f.team(`p2${handle}`, { [handle]: seat } as Record<string, unknown>);
  }
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status).toBe(1);
  const doc = JSON.parse(r.stdout);
  expect(doc.cannot_check).toEqual(["p2nullpane", "p2nullstatus", "p2num"]);
  for (const name of ["p2num", "p2nullpane", "p2nullstatus"]) {
    expect(doc.teams.find((t: any) => t.name === name).classification).toBe("unreadable");
    expect(doc.teams.find((t: any) => t.name === name).seats).toBeUndefined();
  }
  expect(doc.attention).toEqual([]);
  const text = f.run([]);
  expect(text.status).toBe(1);
  expect(text.stdout).toContain("cannot-check");
  expect(text.stdout).toContain("could not be parsed as JSON");
  // The incumbent's reader dies on python's str-join TypeError; the meaningful
  // final line is preserved (the multi-line <stdin> traceback is not).
  expect(text.stderr).toContain("TypeError: sequence item 1: expected str instance, int found");
  expect(text.stderr).toContain("TypeError: sequence item 0: expected str instance, NoneType found");
}, 30000);

test("dashboard is cwd-independent", () => {
  const f = fixture();
  f.team("solo", { alive: f.active("solo/alive", 1) });
  f.saveSnapshot();
  const a = spawnSync(join(f.base, "bin", "tap"), ["admin", "--json"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
  const b = spawnSync(join(f.base, "bin", "tap"), ["admin", "--json"], { cwd: f.cwd2, env: f.env, encoding: "utf8" });
  expect(a.status, a.stderr).toBe(0); expect(b.status, b.stderr).toBe(0);
  expect(b.stdout).toBe(a.stdout);
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  expect(existsSync(join(f.cwd2, ".tap"))).toBe(false);
}, 30000);

test("dashboard writes nothing: every byte and mtime in the sandbox survives", () => {
  const f = fixture();
  const t = f.team("solo", { alive: f.active("solo/alive", 1) });
  f.payload(f.bus(t.teamRoot), "p.md", { to: "alive" }, 3);
  f.saveSnapshot();
  // NO warm-up: the brief promises the public dashboard is zero-write from a
  // fresh HOME, first invocation included — bin/tap pins the Bun transpiler
  // cache for admin, so startup writes nothing either.
  const before = f.snapshotTree();
  const r = f.run(["--json"]);
  expect(r.status, r.stderr).toBe(0);
  expect(f.snapshotTree()).toEqual(before);
  // --full and --verbose are the same census, still zero-write.
  f.run(["--full", "--verbose"]);
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("wide integers in seat rows survive the read with their adjacency intact", () => {
  const f = fixture();
  // Hand-built bytes: JSON.stringify here would round the odd value at write time.
  // Suspended seats keep the census probe-free and the exit code clean.
  f.team("widea", {}, { raw: `{"schema":"0.20","team":{"name":"widea"},"seats":{"w":{"status":"suspended","harness":"codex","note_epoch":9007199254740992}}}` });
  f.team("wideb", {}, { raw: `{"schema":"0.20","team":{"name":"wideb"},"seats":{"w":{"status":"suspended","harness":"codex","note_epoch":9007199254740993}}}` });
  f.saveSnapshot();
  const r = f.run(["--json"]);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  // The lossless read parsed both registries; a refusing primitive (or a
  // normalizing one) would have marked these teams unreadable instead.
  expect(doc.teams.map((t: any) => [t.name, t.classification])).toEqual([["widea", "dormant"], ["wideb", "dormant"]]);
  expect(doc.cannot_check).toEqual([]);
  // And the parser behind the read really does keep the adjacent values apart,
  // where the plain JSON path collapses them:
  expect(loads("9007199254740993")).toBe(9007199254740993n);
  expect(loads("9007199254740992")).toBe(9007199254740992n);
  expect(JSON.parse("9007199254740993")).toBe(9007199254740992);
}, 30000);

test("missing-team fold stays folded by default and unfolds under --verbose", () => {
  const f = fixture();
  f.team("here", { alive: f.active("here/alive", 1) });
  const goneRoot = join(f.base, "vanish"); mkdirSync(goneRoot, { recursive: true });
  f.team("vanish", {}, { registry: join(goneRoot, "r.json") });
  rmSync(goneRoot, { recursive: true, force: true });
  f.saveSnapshot();
  const folded = f.run([]);
  expect(folded.stdout).toContain("here  active");
  expect(folded.stdout).not.toContain("vanish  ");
  expect(folded.stdout).toContain("tap admin dashboard: 1 missing team(s) detected - run tap admin refresh to purge them");
  const unfolded = f.run(["--verbose"]);
  expect(unfolded.stdout).toContain("vanish  dangling");
  expect(unfolded.stdout).toContain("here  active");
}, 30000);

test("an unreadable machine index refuses with invalid_flip; a bad entry and an absent one refuse structured", () => {
  const f = fixture();
  // The flip classifier owns the first read: broken bytes never reach the
  // dashboard's index reader.
  writeFileSync(join(f.index, "global-registry.json"), "{broken");
  const broken = f.run(["--json"]);
  expect(broken.status).toBe(1);
  // tap_authority_index_file discards the flip-state loader's stderr, so the
  // reader's decode line can only fire on a classifier-passed index — stderr
  // stays silent on this path.
  expect(JSON.parse(broken.stdout)).toEqual({ ok: false, error_class: "invalid_flip", action: "tap doctor", detail: "global-registry.json is present but unreadable or wrong schema — refusing admin index ops" });
  expect(broken.stderr).toBe("");
  // A classifier-valid index with a truthy non-dict entry is the dashboard
  // reader's refusal: registry_invalid.
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { bad: "just a string", ok2: { root: join(f.base, "x") } } }));
  const badEntry = f.run(["--json"]);
  expect(badEntry.status).toBe(1);
  expect(badEntry.stderr).toBe(`tap admin: machine index '${join(f.index, "global-registry.json")}' entry 'bad' is invalid (expected object)\n`);
  expect(JSON.parse(badEntry.stdout)).toEqual({ ok: false, error_class: "registry_invalid", action: "tap admin dashboard", detail: `machine index '${join(f.index, "global-registry.json")}' could not be read — cannot check` });
  // Absent marker: no machine index means no enrolled team, the selector's own
  // refusal — never an empty roster that reads as "all clear".
  rmSync(join(f.index, "global-registry.json"));
  const absent = f.run(["--json"]);
  expect(absent.status).toBe(1);
  expect(JSON.parse(absent.stdout)).toEqual({ ok: false, error_class: "unanchored_bus", action: "tap init  OR  tap session launch", detail: NO_MACHINE_INDEX });
}, 30000);

test("--fast stays byte-compatible through the same admin handler", () => {
  const f = fixture();
  f.team("solo", { alive: f.active("solo/alive", 1) });
  f.saveSnapshot();
  const r = f.run(["dashboard", "--fast", "--json"], { FORBID_DEEP: "1" });
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.fast).toBe(true);
  expect(doc.teams).toHaveLength(1);
  expect(f.trace()).toEqual(["native admin"]);
}, 30000);

test("retire flag refusals refuse with the expected diagnostics", () => {
  const f = fixture(); f.team("solo", {}); f.saveSnapshot();
  const cases: Array<[string[], number, string]> = [
    [["retire", "--bogus"], 1, "tap admin retire: unknown option '--bogus'; next: tap help admin retire\n"],
    [["retire"], 1, "tap admin retire: usage: tap admin retire <team> [--force]; next: tap help admin retire\n"],
    [["retire", "solo", "extra"], 1, "tap admin retire: unexpected arg 'extra'; next: tap help admin retire\n"],
    [["retire", "--force"], 1, "tap admin retire: usage: tap admin retire <team> [--force]; next: tap help admin retire\n"],
  ];
  const actual = cases.map(([args]) => { const r = f.run(args); return [args.join(" "), r.status, r.stdout, r.stderr]; });
  expect(actual).toEqual(cases.map(([args, status, stderr]) => [args.join(" "), status, "", stderr]));
  // Ambient TAP_JSON stays human: the clobber happens before the flag table.
  const ambientNative = f.run(["retire", "--bogus"], { TAP_JSON: "1" });
  const bogus = f.run(["retire", "--bogus"]);
  expect(ambientNative.stderr).toBe(bogus.stderr);
  expect(ambientNative.stdout).toBe("");
}, 30000);

test("retire refuses an unenrolled team", () => {
  const f = fixture(); f.team("solo", {}); f.saveSnapshot();
  const native = f.run(["retire", "nosuch"]);
  expect(native.status).toBe(1);
  expect(native.stderr).toBe(`tap admin retire: team 'nosuch' is not enrolled in machine index '${join(f.index, "global-registry.json")}'; next: tap admin dashboard\n`);
  // --force changes nothing about an unknown team.
  const forced = f.run(["retire", "nosuch", "--force"]);
  expect(forced.stderr).toBe(native.stderr);
}, 30000);

test("retire de-enrolls natively: parity output, index rewrite, retired event", () => {
  const nativeFix = fixture();
  nativeFix.team("solo", { alive: { status: "active", harness: "codex" } });
  nativeFix.saveSnapshot();
  const jsonNative = nativeFix.run(["retire", "solo", "--json"]);
  expect(jsonNative.status, jsonNative.stderr).toBe(0);
  expect(nativeFix.trace()).toEqual(["native admin"]);
  const doc = JSON.parse(jsonNative.stdout);
  expect(doc).toEqual({ ok: true, team: "solo", root: join(nativeFix.base, "solo"), forced: false });
  // The index no longer carries the team; the event log carries the retirement.
  expect(JSON.parse(readFileSync(join(nativeFix.index, "global-registry.json"), "utf8")).teams).toEqual({});
  const eventLog = readFileSync(join(nativeFix.base, "solo", ".tap", "bus", "registry-events.log"), "utf8");
  expect(eventLog).toContain("retired");
  expect(eventLog).toContain("solo");
  // Human text on a fresh fixture (the first run consumed the enrollment).
  const textFix = fixture();
  textFix.team("solo", {});
  textFix.saveSnapshot();
  const text = textFix.run(["retire", "solo"]);
  expect(text.status).toBe(0);
  expect(text.stdout).toBe("tap admin retire: de-enrolled team 'solo'\n");
  expect(text.stderr).toBe("");
}, 30000);

test("retire refuses poll-mode members without --force and retires with it", () => {
  const f = fixture();
  f.team("pollteam", { watcher: { status: "active", delivery: "poll", harness: "codex" } });
  f.saveSnapshot();
  const refused = f.run(["retire", "pollteam"]);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toBe("tap admin retire: refusing to retire team 'pollteam': poll-mode members: watcher; next: tap admin retire pollteam --force\n");
  // The refusal left the enrollment intact.
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams).toHaveProperty("pollteam");
  writeFileSync(join(f.base, "route"), "");
  const forced = f.run(["retire", "pollteam", "--force"]);
  expect(forced.status, forced.stderr).toBe(0);
  expect(forced.stdout).toBe("tap admin retire: de-enrolled team 'pollteam'\n");
  expect(f.trace()).toEqual(["native admin"]);
}, 30000);

test("an old-format team is its own old_store row: never a roster, never purged, exit 1", () => {
  const f = fixture();
  f.team("healthy", { a: f.active("healthy", 1) });
  const { reg } = f.team("aged", {}, { raw: JSON.stringify({ team: { name: "aged" }, agents: { ghost: { status: "active", harness: "codex" } } }) });
  f.saveSnapshot();
  const dash = f.run(["--json"]);
  expect(dash.status, dash.stderr).toBe(1);
  const doc = JSON.parse(dash.stdout);
  expect(doc.old_store.map((row: any) => row.team)).toEqual(["aged"]);
  expect(doc.old_store[0].detail).toContain(reg);
  expect(doc.cannot_check).toEqual([]);
  expect(doc.teams.find((t: any) => t.name === "aged").classification).toBe("unreadable");
  expect(dash.stdout).not.toContain("ghost");
  const text = f.run([]);
  expect(text.status).toBe(1);
  expect(text.stdout).toContain("old-store");
  const before = f.snapshotTree();
  const refresh = f.run(["refresh", "--json"]);
  expect(refresh.status, refresh.stderr).toBe(1);
  const out = JSON.parse(refresh.stdout);
  expect(out.old_store.map((row: any) => row.team)).toEqual(["aged"]);
  expect(out.purged).toEqual([]);
  expect(f.snapshotTree()[reg]).toBe(before[reg]);
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams.aged).toBeDefined();
}, 30000);

test("retire reports a corrupt acting registry as registry_invalid with repair action", () => {
  const f = fixture();
  f.team("broken", {}, { corrupt: true });
  f.saveSnapshot();
  const native = f.run(["retire", "broken"]);
  expect(native.status).toBe(1);
  expect(native.stderr).toContain("could not be parsed as JSON (");
  expect(native.stderr).toContain("; next: repair registry\n");
}, 30000);

test("retire of a root-gone team still de-enrolls but writes no event", () => {
  const f = fixture();
  const { teamRoot } = f.team("doomed", {});
  f.saveSnapshot();
  rmSync(teamRoot, { recursive: true, force: true });
  const r = f.run(["retire", "doomed"]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe("tap admin retire: de-enrolled team 'doomed'\n");
  expect(existsSync(join(f.base, "doomed", ".tap", "bus", "registry-events.log"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams).toEqual({});
}, 30000);


test("refresh refuses on flags, positionals, and ambient TAP_JSON clobber", () => {
  const f = fixture();
  const cases: Array<[string[], number, string]> = [
    [["refresh", "--bogus"], 1, "tap admin refresh: unknown option '--bogus'; next: tap help admin refresh\n"],
    [["refresh", "extra"], 1, "tap admin refresh: unexpected arg 'extra'; next: tap help admin refresh\n"],
    [["refresh", "--dry-run", "--stale-after", "5"], 1, "tap admin refresh: unknown option '--stale-after'; next: tap help admin refresh\n"],
  ];
  const actual = cases.map(([args]) => { const r = f.run(args); return [args.join(" "), r.status, r.stdout, r.stderr]; });
  expect(actual).toEqual(cases.map(([args, status, stderr]) => [args.join(" "), status, "", stderr]));
  // An ambient TAP_JSON=1 cannot make a refresh flag refusal JSON.
  const r = f.run(["refresh", "--bogus"], { TAP_JSON: "1" });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("unknown option '--bogus'");
}, 30000);

test("refresh --dry-run reports trims and purges byte-consistently and writes nothing", () => {
  const f = fixture();
  f.team("mixed", {
    alive: f.active("mixed/alive", 1),
    gone: { status: "active", session: "mixed/gone", pane: "mixed/gone:0.0", pane_id: "%98", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
  });
  f.saveSnapshot();
  const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
  f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
  rmSync(doomedRoot, { recursive: true, force: true });
  const before = f.snapshotTree();
  const dry = f.run(["refresh", "--dry-run", "--json"]);
  expect(dry.status, dry.stderr).toBe(0);
  const doc = JSON.parse(dry.stdout);
  expect(doc.ok).toBe(true); expect(doc.dry_run).toBe(true);
  expect(doc.trimmed).toHaveLength(1);
  expect(doc.trimmed[0].team).toBe("mixed"); expect(doc.trimmed[0].handle).toBe("gone");
  expect(doc.trimmed[0].reason.length).toBeGreaterThan(0);
  expect(doc.purged).toEqual([{ team: "doomed", reason: "root_gone" }]);
  expect(doc.cannot_check).toEqual([]);
  expect(dry.stderr).not.toContain("index snapshot");
  expect(f.snapshotTree()).toEqual(before);
  // Text shape matches the JSON.
  writeFileSync(join(f.base, "route"), "");
  const dryText = f.run(["refresh", "--dry-run"]);
  expect(dryText.status).toBe(0);
  expect(dryText.stdout).toContain("tap admin refresh: trimmed 'mixed/gone' (");
  expect(dryText.stdout).toContain("tap admin refresh: PURGED 'doomed' from index (worktree root gone)");
  // The plan prints exactly once (review finding).
  expect(dryText.stdout.split("PURGED 'doomed'").length - 1).toBe(1);
  expect(dryText.stdout).not.toContain("nothing to do");
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("refresh trims observed-gone panes with unchanged rows, records events, rewrites the registry", () => {
  const f = fixture();
  const t = f.team("mixed", {
    alive: f.active("mixed/alive", 1),
    gone: { status: "active", session: "mixed/gone", pane: "mixed/gone:0.0", pane_id: "%98", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
  });
  f.saveSnapshot();
  // A permissive umask must not widen the rewritten registry: the replacement
  // file is created 0600 before the rename.
  const prevUmask = process.umask(0o000);
  let r: ReturnType<typeof f.run>;
  try {
    r = f.run(["refresh", "--json"]);
  } finally {
    process.umask(prevUmask);
  }
  expect(r.status, r.stderr).toBe(0);
  expect(statSync(t.reg).mode & 0o777).toBe(0o600);
  expect(f.trace()).toEqual(["native admin"]);
  const doc = JSON.parse(r.stdout);
  expect(doc.ok).toBe(true); expect(doc.dry_run).toBe(false);
  expect(doc.trimmed.map((x: any) => [x.team, x.handle])).toEqual([["mixed", "gone"]]);
  const rewritten = JSON.parse(readFileSync(t.reg, "utf8")) as { seats: Record<string, unknown> };
  expect(Object.keys(rewritten.seats).sort()).toEqual(["alive"]);
  expect(readFileSync(t.reg, "utf8").endsWith("\n")).toBe(true);
  // The kept row keeps its unknown metadata: native_session_id survives.
  expect(rewritten.seats.alive).toMatchObject({ harness: "codex" });
  const log = readFileSync(join(t.teamRoot, ".tap", "bus", "registry-events.log"), "utf8");
  expect(log).toContain("trimmed");
  expect(log).toContain("gone");
  expect(log).toContain("mixed");
  // A second refresh is quiet: the row is already gone.
  const again = f.run(["refresh"]);
  expect(again.status).toBe(0);
  expect(again.stdout).toContain("nothing to do");
}, 30000);

test("refresh purges data-gone teams through the index writer; a dry run keeps the index", () => {
  const f = fixture();
  const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
  f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
  rmSync(doomedRoot, { recursive: true, force: true });
  f.team("nothere", {}, { dropRegistry: true, registry: join(f.base, "nothere", ".tap", "team-registry.json") });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  const dry = f.run(["refresh", "--dry-run", "--json"]);
  expect(dry.status, dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout).purged.map((p: any) => p.team).sort()).toEqual(["doomed", "nothere"]);
  const kept = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(kept.teams).sort()).toEqual(["doomed", "nothere", "stay"]);
  writeFileSync(join(f.base, "route"), "");
  // A real run consumes the purge: text lines and the de-enrolled index on a
  // fresh fixture.
  writeFileSync(join(f.base, "route"), "");
  const real = f.run(["refresh"]);
  expect(real.status, real.stderr).toBe(0);
  expect(f.trace()).toEqual(["native admin"]);
  expect(real.stdout).toContain("tap admin refresh: PURGED 'doomed' from index (worktree root gone)");
  expect(real.stdout).toContain("tap admin refresh: PURGED 'nothere' from index (registry file missing)");
  const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(index.teams)).toEqual(["stay"]);
}, 30000);

test("a real purge snapshots the index with a sha sidecar and prints a restore command", () => {
  const f = fixture();
  const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
  f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
  rmSync(doomedRoot, { recursive: true, force: true });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  writeFileSync(join(f.base, "route"), "");
  const before = readFileSync(join(f.index, "global-registry.json"));
  const real = f.run(["refresh"]);
  expect(real.status, real.stderr).toBe(0);
  expect(real.stdout).toContain("tap admin refresh: PURGED 'doomed' from index (worktree root gone)");
  const m = real.stderr.match(/restore: cp (\S+) (\S+)/);
  expect(m, real.stderr).toBeTruthy();
  const snapPath = m![1]!;
  const indexPath = m![2]!;
  expect(indexPath).toBe(join(f.index, "global-registry.json"));
  expect(readFileSync(snapPath)).toEqual(before);
  const shaLine = readFileSync(`${snapPath}.sha256`, "utf8").trim();
  expect(shaLine).toBe(createHash("sha256").update(readFileSync(snapPath)).digest("hex"));
  expect(statSync(snapPath).mode & 0o777).toBe(0o600);
  // The printed command is the restore: replaying it brings the row back.
  copyFileSync(snapPath, join(f.index, "global-registry.json"));
  const restored = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(restored.teams).sort()).toEqual(["doomed", "stay"]);
}, 30000);

test("a purge with no writable index snapshot leaves the index intact and reports no purge", () => {
  const setup = (f: ReturnType<typeof fixture>) => {
    const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
    f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
    rmSync(doomedRoot, { recursive: true, force: true });
    f.saveSnapshot();
    writeFileSync(join(f.index, "recovery"), "not a directory");
  };
  const real = fixture(); setup(real);
  const text = real.run(["refresh"]);
  expect(text.status, text.stderr).toBe(0);
  // The receipt must not claim a purge that the refused snapshot suppressed.
  expect(text.stdout).not.toContain("PURGED");
  expect(text.stderr).toContain("could not write an index snapshot; no teams were purged");
  const index = JSON.parse(readFileSync(join(real.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(index.teams)).toEqual(["doomed"]);
  const jf = fixture(); setup(jf);
  const jsonRun = jf.run(["refresh", "--json"]);
  expect(jsonRun.status, jsonRun.stderr).toBe(0);
  expect(JSON.parse(jsonRun.stdout).purged).toEqual([]);
}, 30000);

test("an unprobeable root is cannot-check, never root_gone, never purged (tap-n72)", () => {
  const f = fixture();
  f.team("stay", { alive: f.active("stay/alive", 1) });
  const sealed = join(f.base, "sealed"); mkdirSync(join(sealed, "locked", ".tap"), { recursive: true });
  const sealedRoot = join(sealed, "locked");
  const reg = join(sealedRoot, ".tap", "team-registry.json");
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "locked", worktree_root: sealedRoot }, seats: {} }));
  // Enroll the sealed root by hand (f.team always roots at base/<name>).
  const indexed = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  indexed.teams.locked = { root: sealedRoot, registry_location: reg, state: "registered" };
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: indexed.teams }));
  f.saveSnapshot();
  chmodSync(sealed, 0o000);
  try {
    writeFileSync(join(f.base, "route"), "");
    const real = f.run(["refresh"]);
    expect(real.status, real.stderr).toBe(1); // genuine cannot-check
    expect(real.stdout).not.toContain("PURGED");
    expect(real.stdout).toContain(`could not read team 'locked' (worktree root '${sealedRoot}' could not be probed`);
    const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
    expect(index.teams.locked).toBeDefined();
  const jf = fixture();
  jf.team("stay", { alive: jf.active("stay/alive", 1) });
  const sealed2 = join(jf.base, "sealed"); mkdirSync(join(sealed2, "locked", ".tap"), { recursive: true });
    const sealedRoot2 = join(sealed2, "locked");
    const reg2 = join(sealedRoot2, ".tap", "team-registry.json");
    writeFileSync(reg2, JSON.stringify({ schema: "0.20", team: { name: "locked", worktree_root: sealedRoot2 }, seats: {} }));
    const indexed2 = JSON.parse(readFileSync(join(jf.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
    indexed2.teams.locked = { root: sealedRoot2, registry_location: reg2, state: "registered" };
    writeFileSync(join(jf.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: indexed2.teams }));
    jf.saveSnapshot();
    chmodSync(sealed2, 0o000);
    try {
      const j = jf.run(["refresh", "--json"]);
      expect(j.status, j.stderr).toBe(1);
      const doc = JSON.parse(j.stdout);
      expect(doc.cannot_check).toEqual(["locked"]);
      expect(doc.purged).toEqual([]);
    } finally { chmodSync(sealed2, 0o755); }
  } finally { chmodSync(sealed, 0o755); }
}, 30000);

test("readMachineIndex derives exists from the one tri-state root probe (tap-n72)", () => {
  // Review finding: exists and rootPresence come from a single stat, so they
  // can never disagree; only an explicit ENOENT is gone.
  const f = fixture();
  const present = join(f.base, "present"); mkdirSync(present, { recursive: true });
  const fileRoot = join(f.base, "file-root"); writeFileSync(fileRoot, "not a directory");
  const gone = join(f.base, "gone");
  const indexPath = join(f.base, "probe-index.json");
  writeFileSync(indexPath, JSON.stringify({ schema: "0.20", teams: {
    present: { root: present, registry_location: "", state: "registered" },
    file: { root: fileRoot, registry_location: "", state: "registered" },
    gone: { root: gone, registry_location: "", state: "registered" },
  } }));
  const rows = new Map(readMachineIndex(indexPath).map(row => [row.name, row]));
  expect(rows.get("present")).toMatchObject({ rootPresence: "present", exists: true });
  expect(rows.get("file")).toMatchObject({ rootPresence: "unprobeable", exists: false });
  expect(rows.get("gone")).toMatchObject({ rootPresence: "enoent", exists: false });
  for (const row of rows.values()) expect(row.exists).toBe(row.rootPresence === "present");
});

test("a refused de-enrollment prints its warning and no PURGED receipt (tap-n72)", () => {
  const f = fixture();
  const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
  f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
  rmSync(doomedRoot, { recursive: true, force: true });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  // A directory where the index writer's lock file goes: the de-enrollment
  // cannot acquire it, while reads and the snapshot stay untouched.
  const lockDir = join(f.index, "global-registry.json.lock");
  mkdirSync(lockDir);
  try {
    writeFileSync(join(f.base, "route"), "");
    const real = f.run(["refresh"]);
    expect(real.status, real.stderr).toBe(0); // de-enroll failure never changes the exit code
    expect(real.stdout).not.toContain("PURGED");
    // A planned purge that failed is not "nothing to do".
    expect(real.stdout).not.toContain("nothing to do");
    expect(real.stderr).toContain("could not purge team 'doomed' from index");
    const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
    expect(index.teams.doomed).toBeDefined();
  } finally { rmdirSync(lockDir); }
}, 30000);

test("a dry run previews PURGED in the real run's position among the other rows (tap-n72)", () => {
  const roster = (f: ReturnType<typeof fixture>) => {
    const doomedRoot = join(f.base, "doomed"); mkdirSync(doomedRoot, { recursive: true });
    f.team("doomed", {}, { registry: join(doomedRoot, "r.json") });
    rmSync(doomedRoot, { recursive: true, force: true });
    f.team("anchor", { alive: f.active("anchor/alive", 1) });
    f.team("quiet", { gone: { status: "active", session: "quiet/gone", pane: "quiet/gone:0.0", pane_id: "%97", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" } });
    f.saveSnapshot();
  };
  const rows = (stdout: string) => stdout.split("\n").filter(line => /PURGED|retire candidate/.test(line));
  const df = fixture(); roster(df);
  const dry = df.run(["refresh", "--dry-run"]);
  expect(dry.status, dry.stderr).toBe(0);
  // A real run consumes what it reports, so it runs on its own fixture.
  const rf = fixture(); roster(rf);
  const real = rf.run(["refresh"]);
  expect(real.status, real.stderr).toBe(0);
  expect(rows(dry.stdout)).toEqual([
    "tap admin refresh: PURGED 'doomed' from index (worktree root gone)",
    "tap admin refresh: retire candidate 'quiet' (dormant)",
  ]);
  expect(rows(real.stdout)).toEqual(rows(dry.stdout));
}, 30000);

test("refresh surfaces dormant retire candidates; poll members block them", () => {
  const roster = (f: ReturnType<typeof fixture>) => {
    f.team("anchor", { alive: f.active("anchor/alive", 1) });
    f.team("quiet", { gone: { status: "active", session: "quiet/gone", pane: "quiet/gone:0.0", pane_id: "%97", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" } });
    f.team("parked", {
      gone: { status: "active", session: "parked/gone", pane: "parked/gone:0.0", pane_id: "%96", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
      watcher: { status: "active", delivery: "poll", harness: "codex" },
    });
    f.saveSnapshot();
  };
  const jf = fixture(); roster(jf);
  const r = jf.run(["refresh", "--json"]);
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).retire_candidates).toEqual([
    { team: "parked", classification: "dormant", blocked_by: ["poll-mode members: watcher"], recommended: false },
    { team: "quiet", classification: "dormant", blocked_by: [], recommended: true },
  ]);
  // A real run consumes the candidates it reports, so the text assertions run
  // on their own fixture.
  const tf = fixture(); roster(tf);
  const text = tf.run(["refresh"]);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain("tap admin refresh: retire blocked 'parked' (dormant: poll-mode members: watcher)");
  expect(text.stdout).toContain("tap admin refresh: retire candidate 'quiet' (dormant)");
}, 30000);

test("an already-corrupt registry is cannot-check: skipped from trims and purges, exit 1", () => {
  const f = fixture();
  f.team("corrupt", {}, { corrupt: true });
  f.team("doomed", {});
  rmSync(join(f.base, "doomed"), { recursive: true, force: true });
  f.saveSnapshot();
  const r = f.run(["refresh", "--json"]);
  expect(r.status).toBe(1);
  const doc = JSON.parse(r.stdout);
  expect(doc.cannot_check).toEqual(["corrupt"]);
  expect(doc.trimmed).toEqual([]);
  expect(doc.purged).toEqual([{ team: "doomed", reason: "root_gone" }]);
  const text = f.run(["refresh"]);
  expect(text.stdout).toContain("tap admin refresh: warning: could not read team 'corrupt' (registry.json at ");
  expect(text.stdout).toContain("could not be parsed as JSON) - skipped, no mutation attempted");
}, 30000);

test("H1 refinement: refresh purges only ENOENT acting locations; unprobeable ones are cannot-check", () => {
  const f = fixture();
  f.team("enogone", {}, { dropRegistry: true, registry: join(f.base, "enogone", ".tap", "team-registry.json") });
  const { teamRoot } = f.team("filelocked", {});
  f.team("stay", { alive: f.active("stay/alive", 1) });
  // Overwrite the two entries AFTER every team() call (a later team() would
  // rewrite the index from its own map and drop the custom locations).
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: {
      enogone: { root: join(f.base, "enogone"), registry_location: join(f.base, "enogone", ".tap", "team-registry.json"), state: "registered" },
      filelocked: { root: teamRoot, registry_location: join(teamRoot, ".tap", "team-registry.json", "nested.json"), state: "registered" },
      stay: { root: join(f.base, "stay"), registry_location: join(f.base, "stay", ".tap", "team-registry.json"), state: "registered" },
    },
  }));
  f.saveSnapshot();
  // Dashboard: the ENOENT team is missing; the ENOTDIR team is cannot-check.
  const dash = f.run(["--json"]);
  expect(dash.status, dash.stderr).toBe(1);
  const dashDoc = JSON.parse(dash.stdout);
  expect(dashDoc.cannot_check).toEqual(["filelocked"]);
  expect(dashDoc.missing).toEqual([{ team: "enogone", reason: "registry_missing" }]);
  // Refresh: the ENOENT team purges; the unprobeable team never does.
  const r = f.run(["refresh", "--json"]);
  expect(r.status).toBe(1);
  const doc = JSON.parse(r.stdout);
  expect(doc.cannot_check).toEqual(["filelocked"]);
  expect(doc.purged).toEqual([{ team: "enogone", reason: "registry_missing" }]);
  const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(index.teams).sort()).toEqual(["filelocked", "stay"]);
}, 30000);

test("a quiet roster reports nothing to do and exits 0", () => {
  const f = fixture();
  f.team("calm", { alive: f.active("calm/alive", 1) });
  f.saveSnapshot();
  const r = f.run(["refresh"]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe("tap admin refresh: nothing to do\n");
  const json = f.run(["refresh", "--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, dry_run: false, trimmed: [], purged: [], retire_candidates: [], cannot_check: [], old_store: [] });
}, 30000);

// --- U5 rebuild-registry -------------------------------------------------------------------

function installRebuildShim(f: ReturnType<typeof fixture>, rows: string[], epoch = "900:100"): void {
  const panesFile = join(f.base, "rebuild-panes");
  writeFileSync(panesFile, rows.length ? rows.join("\n") + "\n" : "");
  writeFileSync(join(f.base, "bin", "tmux"), [
    "#!/bin/bash",
    'while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done',
    'case "$1" in',
    ' list-sessions) cat "$SNAPSHOT_DIR/sessions" ;;',
    " list-panes)",
    "   if [ \"$2\" = \"-a\" ]; then",
    "     # The sweep format is fixed, so the shim emits the five fields directly",
    "     # (substituting into the caller's fmt is not parseable in bash patterns).",
    "     while IFS=$'\\t' read -r addr pid cmd path; do",
    '       [ -n "$addr" ] || continue',
    "       printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$addr\" \"%$pid\" \"$cmd\" \"${REBUILD_EPOCH_RAW:-" + epoch + "}\" \"$path\"",
    '     done < "' + panesFile + '"',
    "   else",
    '     cat "$SNAPSHOT_DIR/panes" 2>/dev/null || :',
    "   fi ;;",
    " display-message)",
    '   case "$*" in',
    '     *pane_pid*) want="$3"',
    "       while IFS=$'\\t' read -r addr pid cmd path; do",
    '         [ "$addr" = "$want" ] && { printf \'%s\\n\' "$pid"; exit 0; }',
    '       done < "' + panesFile + '"',
    "       exit 1 ;;",
    '     *"pid:start_time"*) printf \'%s\\n\' "${REBUILD_EPOCH_RAW:-' + epoch + '}" ;;',
    "     *) printf '1:1\\n' ;;",
    "   esac ;;",
    " *) exit 1 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  void epoch;
}

function rebuildRun(f: ReturnType<typeof fixture>, args: string[], extras: NodeJS.ProcessEnv = {}) {
  return f.run(["rebuild-registry", ...args], extras);
}

test("rebuild-registry preview plans without writing a byte", () => {
  const f = fixture();
  const t = f.team("alpha", { terra: { status: "suspended", harness: "codex" } });
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const before = f.snapshotTree();
  const json = rebuildRun(f, ["--json"]);
  expect(json.status, json.stderr).toBe(0);
  expect(f.trace()).toEqual(["native admin"]);
  const doc = JSON.parse(json.stdout);
  expect(doc).toEqual({ ok: true, dry_run: true, planned: [{ team: "alpha", handle: "w", pane: "alpha/w:0.0", pane_id: "%4242", harness: "codex" }], applied: [] });
  expect(f.snapshotTree()).toEqual(before);
  const human = rebuildRun(f, []);
  expect(human.status).toBe(0);
  expect(human.stdout).toBe("tap admin rebuild-registry: would rebuild alpha/w from alpha/w:0.0\n");
}, 30000);

test("rebuild-registry applies: rewrite, merge, incapable preservation, worktree field kept", () => {
  const f = fixture();
  const t = f.team("alpha", {
    terra: { status: "active", harness: "codex", extra_note: "keepme", registered_from_worktree: join(f.base, "elsewhere") },
    parked: { status: "suspended", status_reason: "incapable", harness: "codex" },
  });
  installRebuildShim(f, [
    `alpha/terra:0.0\t4242\tcodex\t${t.teamRoot}/w`,
    `alpha/parked:0.1\t4243\tcodex\t${t.teamRoot}/w`,
  ]);
  f.saveSnapshot();
  const applied = rebuildRun(f, ["--yes", "--json"]);
  expect(applied.status, applied.stderr).toBe(0);
  const doc = JSON.parse(applied.stdout);
  expect(doc.ok).toBe(true); expect(doc.dry_run).toBe(false);
  expect(doc.applied.map((s: any) => s.handle).sort()).toEqual(["parked", "terra"]);
  const reg = JSON.parse(readFileSync(t.reg, "utf8"));
  // The fixture registry carries a seats axis; the store twin keeps it.
  const seats = reg.seats ?? reg.agents;
  expect(seats.terra.extra_note).toBe("keepme");
  expect(seats.terra.registered_from_worktree).toBe(join(f.base, "elsewhere"));
  expect(seats.terra).toMatchObject({ pane: "alpha/terra:0.0", pane_id: "%4242", harness: "codex", status: "active" });
  expect(Object.hasOwn(seats.terra, "delivery")).toBe(false);
  expect(Object.hasOwn(seats.terra, "registered_at")).toBe(false);
  expect(seats.parked.status).toBe("suspended");
  expect(seats.parked.status_reason).toBe("incapable");
  expect(seats.parked.pane_id).toBe("%4243");
  // Human receipt on a fresh fixture: an apply consumes the plan.
  const textFix = fixture();
  const tt = textFix.team("alpha", {});
  installRebuildShim(textFix, [`alpha/w:0.0\t4242\tcodex\t${tt.teamRoot}/w`]);
  textFix.saveSnapshot();
  const human = textFix.run(["rebuild-registry", "--yes"]);
  expect(human.status, human.stderr).toBe(0);
  expect(human.stdout).toBe("tap admin rebuild-registry: rebuilt alpha/w from alpha/w:0.0\n");
}, 30000);

// Each decision has its own assertion/run so one overwrite cannot mask another.
for (const [field, value] of Object.entries({ delivery: "poll", status: "suspended", status_reason: "user_removed", registered_at: "2001-02-03T04:05:06Z" })) {
  test(`rebuild-registry preserves decided field ${field}`, () => {
    const f = fixture();
    const row = { delivery: "poll", status: "suspended", status_reason: "user_removed", registered_at: "2001-02-03T04:05:06Z" };
    const t = f.team("alpha", { keeper: row });
    installRebuildShim(f, [`alpha/keeper:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
    f.saveSnapshot();
    const r = rebuildRun(f, ["--yes", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(t.reg, "utf8")).seats.keeper[field]).toBe(value);
  }, 30000);
}

test("rebuild-registry changes only observed fields on a fully recorded row", () => {
  const f = fixture();
  const before = {
    delivery: "poll", status: "suspended", status_reason: "user_removed", registered_at: "2001-02-03T04:05:06Z",
    registered_from_worktree: join(f.base, "original"), instance: "keeper|original",
    pane: "old:0.0", pane_id: "%8", pane_current_command: "claude", harness: "claude", server_epoch: "srv:old:1",
    unattended: true, wake_url: "https://example.invalid/wake", cost_mode: "low", include_policy: "never",
    session: "alpha/keeper", launch_id: "launch-original", harness_session_id: "conversation-original",
    identity_capture: { source: "hook", trusted: false }, quarantine: { reason: "conflict", candidates: ["one", "two"] },
    future_decision: { nested: [true, null, "keep"] },
  };
  const t = f.team("alpha", { keeper: before });
  installRebuildShim(f, [`alpha/keeper:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const r = rebuildRun(f, ["--yes", "--json"], { TAP_SERVER_EPOCH: "srv:900:100" });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(readFileSync(t.reg, "utf8")).seats.keeper).toEqual({
    ...before, pane: "alpha/keeper:0.0", pane_id: "%4242", pane_current_command: "codex", harness: "codex", server_epoch: "srv:900:100",
  });
}, 30000);

test("rebuild-registry preserves absent decisions and defaults only fresh rows", () => {
  const f = fixture();
  const t = f.team("alpha", { sparse: {} });
  installRebuildShim(f, [
    `alpha/sparse:0.0\t4242\tcodex\t${t.teamRoot}/w`,
    `alpha/fresh:0.0\t4243\tcodex\t${t.teamRoot}/w`,
  ]);
  f.saveSnapshot();
  const r = rebuildRun(f, ["--yes", "--json"]);
  expect(r.status, r.stderr).toBe(0);
  const { sparse, fresh } = JSON.parse(readFileSync(t.reg, "utf8")).seats;
  for (const field of ["delivery", "status", "status_reason", "registered_at"]) expect(Object.hasOwn(sparse, field), field).toBe(false);
  expect(fresh).toMatchObject({ delivery: "pane", status: "active", status_reason: "", pane_id: "%4243" });
  expect(fresh.registered_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
}, 30000);

test("rebuild-registry reports preserved decisions in preview and apply", () => {
  const f = fixture();
  const t = f.team("alpha", {
    poller: { delivery: "poll", status: "active" },
    parked: { delivery: "pane", status: "suspended", status_reason: "user_removed" },
  });
  installRebuildShim(f, [
    `alpha/poller:0.0\t4242\tcodex\t${t.teamRoot}/w`,
    `alpha/parked:0.0\t4243\tcodex\t${t.teamRoot}/w`,
  ]);
  f.saveSnapshot();
  const before = readFileSync(t.reg, "utf8");
  const expected = [
    { team: "alpha", handle: "poller", pane: "alpha/poller:0.0", delivery: "poll", status: "active" },
    { team: "alpha", handle: "parked", pane: "alpha/parked:0.0", delivery: "pane", status: "suspended", status_reason: "user_removed" },
  ];
  const preview = rebuildRun(f, ["--json"]);
  expect(preview.status, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout).preserved).toEqual(expected);
  expect(readFileSync(t.reg, "utf8")).toBe(before);
  const human = rebuildRun(f, []);
  expect(human.stdout).toContain("kept alpha/poller delivery=poll status=active; observed pane alpha/poller:0.0");
  expect(human.stdout).toContain("kept alpha/parked delivery=pane status=suspended status_reason=user_removed; observed pane alpha/parked:0.0");
  const applied = rebuildRun(f, ["--yes", "--json"]);
  expect(applied.status, applied.stderr).toBe(0);
  expect(JSON.parse(applied.stdout).preserved).toEqual(expected);
}, 30000);

test("rebuild-registry skips panes outside the team root and non-harness commands", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [
    `alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`,
    `alpha/out:0.1\t4243\tcodex\t/elsewhere/proj`,
    `alpha/ghost:0.2\t999999\tvimtop\t${t.teamRoot}/w`,
  ]);
  f.saveSnapshot();
  const json = rebuildRun(f, ["--json"]);
  expect(json.status, json.stderr).toBe(0);
  const doc = JSON.parse(json.stdout);
  expect(doc.planned.map((x: any) => x.handle)).toEqual(["w"]);
  expect(doc.planned.map((x: any) => x.team)).toEqual(["alpha"]);
}, 30000);

test("rebuild-registry refuses a malformed pane_id for the whole plan", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [`alpha/w:0.0\t7x\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const native = rebuildRun(f, []);
  expect(native.status).toBe(1);
  expect(native.stderr).toContain("tmux returned invalid pane_id '%7x'; refusing registry write");
}, 30000);

test("rebuild-registry honors TAP_SCRATCH_ONLY for applies, never previews", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const before = f.snapshotTree();
  const preview = rebuildRun(f, ["--json"], { TAP_SCRATCH_ONLY: "/nonexistent-scratch" });
  expect(preview.status, preview.stderr).toBe(0);
  const refused = rebuildRun(f, ["--yes"], { TAP_SCRATCH_ONLY: "/nonexistent-scratch" });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("TAP_SCRATCH_ONLY declares '/nonexistent-scratch' but a registry tap admin rebuild-registry would rewrite");
  expect(refused.stderr).toContain("refusing to clear state outside the declared scratch prefix");
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("rebuild-registry skips unreachable acting registries instead of trusting the decoy", () => {
  const f = fixture();
  const t = f.team("hijacked", { ghost: { status: "active", harness: "codex" } });
  // The legacy bus decoy stays populated; the indexed location is ENOENT.
  writeFileSync(join(t.teamRoot, ".tap", "bus", "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "hijacked" }, seats: { ghost: { status: "active", harness: "codex" } } }));
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { hijacked: { root: t.teamRoot, registry_location: join(t.teamRoot, ".tap", "vanished-acting.json"), state: "registered" } } }));
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const json = rebuildRun(f, ["--json"]);
  expect(json.status).toBe(1);
  const doc = JSON.parse(json.stdout);
  expect(doc.ok).toBe(false);
  expect(doc.skipped).toEqual(["hijacked"]);
  expect(doc.skipped_reason).toBe("acting_registry_unreachable_or_invalid");
  expect(doc.planned).toEqual([]);
  expect(json.stderr).toContain("skipping team 'hijacked' — acting registry unreachable/invalid (refuse bus decoy)");
  const text = rebuildRun(f, []);
  expect(text.status).toBe(1);
  expect(text.stderr).toContain("skipping team 'hijacked' — acting registry unreachable/invalid (refuse bus decoy)");
  expect(text.stderr).toContain("skipped 1 enrolled team(s) with unreachable/invalid acting registry: hijacked");
  // The decoy was never trusted: the ghost seat stayed out of every receipt.
  expect(text.stdout).not.toContain("ghost");
}, 30000);

test("rebuild-registry skips reserved handles and suffixes collisions", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [
    `watcher:0.0\t4242\tcodex\t${t.teamRoot}/w`,
    `alpha/dupe:0.0\t4243\tcodex\t${t.teamRoot}/w`,
    `alpha/dupe:0.1\t4244\tcodex\t${t.teamRoot}/w`,
  ]);
  f.saveSnapshot();
  const json = rebuildRun(f, ["--json"]);
  expect(json.status, json.stderr).toBe(0);
  const doc = JSON.parse(json.stdout);
  expect(json.stderr).toContain("derived handle 'watcher' is the reserved watcher identity and cannot be a seat handle");
  expect(doc.planned.map((s: any) => s.handle).sort()).toEqual(["dupe", "dupe-2"]);
}, 30000);

// --- review round 1 controls ----------------------------------------------------------------

test("rebuild publish is complete, 0600, and leaves no temp on a failed rename", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const applied = rebuildRun(f, ["--yes", "--json"]);
  expect(applied.status, applied.stderr).toBe(0);
  const written = readdirSync(join(t.teamRoot, ".tap"));
  expect(written.filter(n => n.startsWith(".registry."))).toEqual([]);
  expect(statSync(t.reg).mode & 0o777).toBe(0o600);
  // Inject a pre-rename failure at the filesystem level: an immutable target
  // lets the temp reach its complete+fsynced state, then the rename fails and
  // the unpublished temp must be cleaned up.
  const applied2 = fixture();
  const t2 = applied2.team("alpha", {});
  installRebuildShim(applied2, [`alpha/w:0.0\t4242\tcodex\t${t2.teamRoot}/w`]);
  applied2.saveSnapshot();
  spawnSync("chflags", ["uchg", t2.reg]);
  try {
    const failed = rebuildRun(applied2, ["--yes", "--json"]);
    expect(failed.status).not.toBe(0);
    const tapDir = readdirSync(join(t2.teamRoot, ".tap"));
    expect(tapDir.filter(n => n.startsWith(".registry."))).toEqual([]);
  } finally {
    spawnSync("chflags", ["nouchg", t2.reg]);
  }
}, 30000);

test("rebuild refuses a registry without a seats map, never creating or converting one", () => {
  // A malformed seats value, a legacy agents axis and a missing file are all
  // evidence: rebuild writes into an existing current-format registry only.
  for (const doc of [{ seats: "corrupt" }, { seats: null }, { agents: {} }, null]) {
    const f = fixture();
    const t = f.team("alpha", {});
    if (doc === null) rmSync(t.reg);
    else writeFileSync(t.reg, JSON.stringify({ schema: "0.20", team: { name: "alpha" }, ...doc }));
    installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
    f.saveSnapshot();
    const before = f.snapshotTree();
    const preview = rebuildRun(f, ["--json"]);
    expect(preview.status).toBe(1);
    const err = JSON.parse(preview.stdout);
    if (doc === null) {
      // A missing acting registry is skipped before any write, never recreated.
      expect(err).toMatchObject({ ok: false, skipped: ["alpha"], skipped_reason: "acting_registry_unreachable_or_invalid" });
    } else {
      expect(err.error_class).toBe("registry_invalid");
      expect(err.detail).toContain("has no seats object");
    }
    const apply = rebuildRun(f, ["--yes"]);
    expect(apply.status).toBe(1);
    expect(f.snapshotTree()).toEqual(before);
  }
}, 30000);

test("retire refuses an unprobeable authority but retires an ENOENT one", () => {
  const f = fixture();
  const { teamRoot, reg } = f.team("locked", { watcher: { status: "active", delivery: "poll", harness: "codex" } });
  // The indexed acting location is a DIRECTORY: no poll roster can be proven.
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { locked: { root: teamRoot, registry_location: join(teamRoot, ".tap", "acting-dir"), state: "registered" } } }));
  mkdirSync(join(teamRoot, ".tap", "acting-dir"));
  writeFileSync(join(teamRoot, ".tap", "acting-dir", "decoy"), JSON.stringify({ seats: {} }));
  f.saveSnapshot();
  const before = f.snapshotTree();
  const refused = f.run(["retire", "locked"]);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("could not be read");
  expect(refused.stderr).toContain("; next: repair registry\n");
  const forced = f.run(["retire", "locked", "--force"]);
  expect(forced.status).toBe(1);
  expect(f.snapshotTree()).toEqual(before);
  // ENOENT is the ruled data-gone case: retirement proceeds.
  const gone = fixture();
  const goneTeam = gone.team("vanish", {});
  writeFileSync(join(gone.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { vanish: { root: goneTeam.teamRoot, registry_location: join(goneTeam.teamRoot, ".tap", "vanished.json"), state: "registered" } } }));
  gone.saveSnapshot();
  const retired = gone.run(["retire", "vanish", "--json"]);
  expect(retired.status, retired.stderr).toBe(0);
  expect(JSON.parse(retired.stdout).ok).toBe(true);
}, 30000);

test("an unreadable registry refuses registry_invalid and names the path", () => {
  const f = fixture();
  const t = f.team("dark", { watcher: { status: "active", harness: "codex" } });
  chmodSync(t.reg, 0o000);
  try {
    const r = f.run(["--json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/at (async )?/);
    // The reader's own EACCES message carries the exact path it refused; the
    // pinned contract is the refusal id plus that path, not a foreign
    // runtime's errno wording.
    expect(r.stderr).toContain(`registry.json is invalid JSON (EACCES`);
    expect(r.stderr).toContain(t.reg);
    expect(JSON.parse(r.stdout).cannot_check).toEqual(["dark"]);
  } finally {
    chmodSync(t.reg, 0o644);
  }
}, 30000);

test("the moved-sweep refusal is one JSON error carrying the full detail", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`], "900:100");
  f.saveSnapshot();
  const before = f.snapshotTree();
  const moved = rebuildRun(f, ["--yes", "--json"], { TAP_REBUILD_SERVER_EPOCH: "srv:9:9" });
  expect(moved.status).toBe(1);
  expect(moved.stderr).toBe("");
  expect(JSON.parse(moved.stdout)).toEqual({ ok: false, error_class: "server_epoch_moved", action: "tap admin rebuild-registry", detail: "tmux server generation moved during the sweep (srv:1:1 -> srv:9:9); nothing was written" });
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("tap-zk1w: an unobservable sweep generation refuses before writing unstamped rows", () => {
  const f = fixture();
  const t = f.team("alpha", {});
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`], "900:100");
  f.saveSnapshot();
  const before = f.snapshotTree();
  const r = rebuildRun(f, ["--yes", "--json"], { TAP_SERVER_EPOCH: "", TAP_REBUILD_SERVER_EPOCH: "" });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("generation_unverifiable");
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("seat ordering is code-point across the dashboard and the retire blockers", () => {
  const f = fixture();
  const t = f.team("astral", {});
  // \uE000 (BMP) sorts AFTER the astral 😀 under UTF-16 code-unit order, and
  // BEFORE it under python's code-point order — the incumbent sorts by code point.
  const seats = { "\uE000": { status: "active", delivery: "poll", harness: "codex" }, "😀": { status: "active", delivery: "poll", harness: "codex" } };
  writeFileSync(t.reg, JSON.stringify({ schema: "0.20", team: { name: "astral", worktree_root: t.teamRoot }, seats }));
  f.saveSnapshot();
  const dash = f.run(["dashboard", "--full", "--json"]);
  expect(dash.status, dash.stderr).toBe(0);
  const doc = JSON.parse(dash.stdout);
  expect(doc.teams[0].seats.map((s: any) => s.handle)).toEqual(["\uE000", "😀"]);
  const retire = f.run(["retire", "astral"]);
  expect(retire.status).toBe(1);
  expect(retire.stderr).toContain("poll-mode members: \uE000,😀");
}, 30000);

// --- checkpoint C controls ------------------------------------------------------------------

test("refresh purges a registry-missing team through H1's guarded capture; allocation failure leaves it enrolled", () => {
  const f = fixture();
  const missingRoot = join(f.base, "ghosted");
  mkdirSync(join(missingRoot, ".tap"), { recursive: true });
  f.team("ghosted", {}, { dropRegistry: true, registry: join(missingRoot, ".tap", "team-registry.json") });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  const real = f.run(["refresh", "--json"]);
  expect(real.status, real.stderr).toBe(0);
  expect(JSON.parse(real.stdout).purged).toEqual([{ team: "ghosted", reason: "registry_missing" }]);
  // The guarded removal allocated its capture artifact under the index's
  // recovery dir, and a successful removal consumed it. The index snapshot
  // from the purge's reversibility discipline is the deliberate leftover.
  const recovery = join(f.index, "recovery");
  expect(existsSync(recovery), "guarded purge never allocated a recovery artifact").toBe(true);
  expect(readdirSync(recovery).filter(name => name.startsWith("team-admin-refresh."))).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams).toEqual({ stay: expect.anything() });
  // Allocation failure (the recovery path is taken by a file) now refuses at
  // the earlier index-snapshot stage: the exact snapshot warning, no exit-code
  // change, and every team left enrolled.
  const f2 = fixture();
  const root2 = join(f2.base, "ghosted2");
  mkdirSync(join(root2, ".tap"), { recursive: true });
  f2.team("ghosted2", {}, { dropRegistry: true, registry: join(root2, ".tap", "team-registry.json") });
  f2.team("stay2", { alive: f2.active("stay2/alive", 1) });
  writeFileSync(join(f2.index, "recovery"), "not a directory\n");
  f2.saveSnapshot();
  const failed = f2.run(["refresh", "--json"]);
  expect(failed.status, failed.stderr).toBe(0);
  expect(failed.stderr).toContain("could not write an index snapshot; no teams were purged - retry 'tap admin refresh'");
  expect(JSON.parse(failed.stdout).purged).toEqual([]);
  const index2 = JSON.parse(readFileSync(join(f2.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(index2.teams.ghosted2).toBeDefined();
  expect(index2.teams.stay2).toBeDefined();
  // Guarded refusal (the helper's sidecar-lock fence fails: the registry's
  // parent dir is unwritable) keeps the retained witness and names it, with
  // the rc, in the H1 contract's exact text.
  const f3 = fixture();
  const root3 = join(f3.base, "ghosted3");
  const tap3 = join(root3, ".tap");
  mkdirSync(tap3, { recursive: true });
  f3.team("ghosted3", {}, { dropRegistry: true, registry: join(tap3, "team-registry.json") });
  f3.team("stay3", { alive: f3.active("stay3/alive", 1) });
  f3.saveSnapshot();
  chmodSync(tap3, 0o500);
  try {
    const refused = f3.run(["refresh", "--json"]);
    expect(refused.status, refused.stderr).toBe(0);
    expect(refused.stderr).toContain("purge of team 'ghosted3' was refused (rc=");
    expect(refused.stderr).toContain(") and the index was left intact; the capture artifact is retained at '");
    expect(refused.stderr).toContain("for inspection");
    const index3 = JSON.parse(readFileSync(join(f3.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
    expect(index3.teams.ghosted3).toBeDefined();
    const kept = readdirSync(join(f3.index, "recovery")).filter(name => name.startsWith("team-admin-refresh."));
    expect(kept.length).toBe(1);
    expect(kept[0]!.startsWith("team-admin-refresh.")).toBe(true);
  } finally {
    chmodSync(tap3, 0o755);
  }
}, 30000);

// The refresh race window (formerly smoke admin-refresh-ghost-purge cases 8/8b,
// which injected it through a python3 PATH shim that died with the Bash writer).
// A second process holds teams.json.lock. Refresh gathers, commits to a purge
// row, takes the acting registry's sidecar lock (creating `<registry>.lock`) and
// blocks on teams.json.lock. The holder waits for that sidecar file, so the
// world moves strictly between the gather decision and the in-lock recheck,
// then it releases. There is no production hook.
function raceRefresh(f: ReturnType<typeof fixture>, registry: string, mutation: string) {
  const held = join(f.base, "race.held");
  const script = `
    const { acquirePathLock } = require(${JSON.stringify(join(root, "runtime/bun/src/panelock.ts"))});
    const { existsSync, writeFileSync, readFileSync, mkdirSync } = require("node:fs");
    const lock = acquirePathLock(${JSON.stringify(join(f.index, "teams.json.lock"))}, 5000);
    if (!lock) process.exit(3);
    writeFileSync(${JSON.stringify(held)}, "1");
    const deadline = Date.now() + 20000;
    while (!existsSync(${JSON.stringify(`${registry}.lock`)})) {
      if (Date.now() > deadline) { lock.release(); process.exit(4); }
      Bun.sleepSync(10);
    }
    ${mutation}
    lock.release();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 10000;
  while (!existsSync(held) && Date.now() < deadline) Bun.sleepSync(10);
  expect(existsSync(held)).toBe(true);
  const result = f.run(["refresh", "--json"]);
  return { result, exited: child.exited };
}

test("refresh race: an acting registry recreated between gather and apply refuses the guarded purge", async () => {
  const f = fixture();
  const reg = join(f.base, "ghost", ".tap", "team-registry.json");
  f.team("ghost", {}, { dropRegistry: true });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  const doc = JSON.stringify({ schema: "0.20", team: { name: "ghost", worktree_root: join(f.base, "ghost") }, seats: {} });
  const { result, exited } = raceRefresh(f, reg, `writeFileSync(${JSON.stringify(reg)}, ${JSON.stringify(doc)});`);
  expect(await exited).toBe(0);
  expect(result.status, result.stderr).toBe(0);
  // The report still names the purge decision the gather reached...
  expect(JSON.parse(result.stdout).purged).toEqual([{ team: "ghost", reason: "registry_missing" }]);
  // ...but the in-lock recheck saw the recreated registry and refused.
  expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams.ghost).toBeDefined();
  const kept = readdirSync(join(f.index, "recovery")).filter(name => name.startsWith("team-admin-refresh."));
  expect(kept.length).toBe(1);
  expect(result.stderr).toContain("purge of team 'ghost' was refused (rc=6)");
  expect(result.stderr).toContain(join(f.index, "recovery", kept[0]!));
}, 60000);

test("refresh race: an enrollment replaced between gather and apply survives with its own named artifact", async () => {
  const f = fixture();
  const reg = join(f.base, "ghost", ".tap", "team-registry.json");
  f.team("ghost", {}, { dropRegistry: true });
  f.team("stay", { alive: f.active("stay/alive", 1) });
  f.saveSnapshot();
  const gpath = join(f.index, "global-registry.json");
  const hijack = join(f.base, "hijack");
  const mutation = `
    const d = JSON.parse(readFileSync(${JSON.stringify(gpath)}, "utf8"));
    d.teams.ghost.root = ${JSON.stringify(hijack)};
    d.teams.ghost.registry_location = ${JSON.stringify(join(hijack, ".tap", "team-registry.json"))};
    mkdirSync(${JSON.stringify(join(hijack, ".tap"))}, { recursive: true });
    writeFileSync(${JSON.stringify(gpath)}, JSON.stringify(d));
  `;
  const { result, exited } = raceRefresh(f, reg, mutation);
  expect(await exited).toBe(0);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).purged).toEqual([{ team: "ghost", reason: "registry_missing" }]);
  const ent = JSON.parse(readFileSync(gpath, "utf8")).teams.ghost;
  expect(ent.root).toBe(hijack);
  expect(ent.registry_location).toBe(join(hijack, ".tap", "team-registry.json"));
  const kept = readdirSync(join(f.index, "recovery")).filter(name => name.startsWith("team-admin-refresh."));
  expect(kept.length).toBe(1);
  expect(result.stderr).toContain("purge of team 'ghost' was refused (rc=6)");
  expect(result.stderr).toContain(join(f.index, "recovery", kept[0]!));
}, 60000);

test("an absent machine index refuses every index-reading admin verb unanchored_bus, even beside a stray teams.json", () => {
  const f = fixture();
  // A legacy teams.json enrolls a real team whose registry, bus and seats are
  // all present: were any verb to fall back to it, refresh would trim the dead
  // seat and rebuild would rewrite the roster. No machine index means no
  // enrolled team, so every verb refuses before reading anything.
  const stay = f.team("stay", {
    alive: f.active("stay/alive", 1),
    gone: { status: "active", session: "stay/gone", pane: "stay/gone:0.0", pane_id: "%24", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
  });
  writeFileSync(join(stay.teamRoot, ".tap", "bus", "registry.json"), readFileSync(stay.reg));
  const indexed = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  rmSync(join(f.index, "global-registry.json"));
  writeFileSync(join(f.index, "teams.json"), JSON.stringify({ teams: indexed.teams }));
  f.saveSnapshot();
  const before = f.snapshotTree();
  const action = "tap init  OR  tap session launch";
  for (const [args, label] of [
    [["refresh"], "tap admin refresh"],
    [["retire", "stay"], "tap admin retire"],
    [["retire", "stay", "--force"], "tap admin retire"],
    [["dashboard"], "tap admin dashboard"],
    [[], "tap admin dashboard"],
    [["rebuild-registry", "--yes"], "tap admin rebuild-registry"],
  ] as Array<[string[], string]>) {
    const r = f.run(args);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }, args.join(" ")).toEqual({ status: 1, stdout: "", stderr: `${label}: ${NO_MACHINE_INDEX}; next: ${action}\n` });
  }
  for (const args of [["refresh", "--json"], ["retire", "stay", "--json"], ["dashboard", "--json"]]) {
    const r = f.run(args);
    expect(r.status, args.join(" ")).toBe(1);
    expect(JSON.parse(r.stdout), args.join(" ")).toEqual({ ok: false, error_class: "unanchored_bus", action, detail: NO_MACHINE_INDEX });
  }
  // A refusal is a read: no index, registry, bus or recovery artifact moved.
  expect(f.snapshotTree()).toEqual(before);
  expect(existsSync(join(f.index, "global-registry.json"))).toBe(false);
  expect(existsSync(join(f.index, "recovery"))).toBe(false);
}, 30000);

test("a present indexed acting registry parses with no bus: retained, unprobed, eventless", () => {
  const f = fixture();
  // The indexed location exists and is valid; the root has NEITHER .tap/bus
  // NOR tmp/tap — the H1 P1 repair reads the indexed path anyway. The entry is
  // hand-rolled: the fixture helper always creates a bus.
  const lonely = join(f.base, "lonely");
  mkdirSync(join(lonely, ".tap"), { recursive: true });
  writeFileSync(join(lonely, ".tap", "team-registry.json"), JSON.stringify({ schema: "0.20", team: { name: "lonely" }, seats: { watcher: { status: "active", delivery: "poll", harness: "codex" } } }));
  f.team("stay", { alive: f.active("stay/alive", 1) });
  const indexDoc = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  indexDoc.teams.lonely = { enrolled_at: "t", registry_location: join(lonely, ".tap", "team-registry.json"), root: lonely, state: "registered" };
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(indexDoc));
  f.saveSnapshot();
  const before = f.snapshotTree();
  // The children run in the fixture's private cwd, so a relative probe would land
  // there. The test process's own cwd is the shared checkout, where parallel
  // siblings (a `bun build --compile` temp, for one) come and go.
  const cwdBefore = readdirSync(f.cwd);
  const refresh = f.run(["refresh", "--json"]);
  expect(refresh.status, refresh.stderr).toBe(0);
  expect(JSON.parse(refresh.stdout).purged).toEqual([]);
  const dash = f.run(["dashboard", "--full", "--json"]);
  expect(dash.status, dash.stderr).toBe(0);
  const doc = JSON.parse(dash.stdout);
  const row = doc.teams.find((t: any) => t.name === "lonely");
  expect(row).toBeDefined();
  expect(row.seats[0].state).toContain("poll-mode");
  // Seat state stays unknown without a bus: no relative payloads/ probe may
  // appear in the working directory.
  expect(readdirSync(f.cwd)).toEqual(cwdBefore);
  // No registry event was attempted (there is no bus to hold one).
  expect(f.snapshotTree()).toEqual(before);
}, 30000);

test("rebuild treats a null seat row as empty and still refuses scalar rows", () => {
  const f = fixture();
  const t = f.team("alpha", { parked: { status: "suspended", status_reason: "incapable" }, w: null });
  installRebuildShim(f, [`alpha/w:0.0\t4242\tcodex\t${t.teamRoot}/w`]);
  f.saveSnapshot();
  const applied = rebuildRun(f, ["--yes", "--json"]);
  expect(applied.status, applied.stderr).toBe(0);
  const doc = JSON.parse(readFileSync(t.reg, "utf8"));
  // The null row became a real enrolled entry from the sweep plan; the
  // incapable row kept its preservation pair.
  expect(doc.seats.w.pane_id).toBe("%4242");
  expect(doc.seats.w.delivery).toBe("pane");
  expect(doc.seats.parked.status).toBe("suspended");
  expect(doc.seats.parked.status_reason).toBe("incapable");
  // A non-null scalar row is still corrupt evidence, never replaced.
  const f2 = fixture();
  const t2 = f2.team("alpha", { w: 5 });
  installRebuildShim(f2, [`alpha/w:0.0\t4243\tcodex\t${t2.teamRoot}/w`]);
  f2.saveSnapshot();
  const before = readFileSync(t2.reg, "utf8");
  const refused = rebuildRun(f2, ["--yes", "--json"]);
  expect(refused.status).toBe(1);
  const err = JSON.parse(refused.stdout);
  expect(err.error_class).toBe("registry_invalid");
  expect(err.detail).toContain("entry 'w' is not an object");
  expect(readFileSync(t2.reg, "utf8")).toBe(before);
}, 30000);

/** Pids with LOCKPATH open: a process waiting for its flock holds it open in-process. */
function sidecarOpeners(lockPath: string): Set<string> {
  return new Set(Bun.spawnSync(["lsof", "-t", "--", lockPath], { stdout: "pipe", stderr: "ignore" }).stdout.toString()
    .split("\n").filter(Boolean));
}

test("an unknown-field edit between scan and locked reload defeats that row's trim only", async () => {
  const f = fixture();
  const t = f.team("race", {
    alive: f.active("race/alive", 1),
    still: { status: "active", session: "race/still", pane: "race/still:0.0", pane_id: "%21", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
    drift: { status: "active", session: "race/drift", pane: "race/drift:0.0", pane_id: "%22", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1", unknown_field: 9007199254740992 },
  });
  f.saveSnapshot();
  // A concurrent writer that edits ONLY an unknown field between the scan's
  // first read and the locked reload — 9007199254740992 -> 9007199254740993,
  // adjacent wide ints JSON.parse cannot tell apart — must defeat the CAS for
  // that row while the untouched row still trims. The test holds the
  // registry's sidecar flock (the same kernel lock acquirePathLock takes), so
  // the public refresh parks at acquirePathLock after its scan; the edit
  // lands while it waits, and releasing lets the reload read the new bytes.
  const lockPath = `${t.reg}.lock`;
  // lockf runs its command only once the flock is granted, so the marker's
  // existence PROVES the blocker holds the sidecar before refresh spawns.
  const readyMarker = join(f.base, "lockf-ready");
  const blocker = Bun.spawn(["/usr/bin/lockf", "-k", lockPath, "sh", "-c", ': > "$1"; exec sleep 30', "sh", readyMarker]);
  try {
    const tapPath = join(f.base, "bin", "tap");
    const logPath = join(f.base, "spawns");
    writeFileSync(logPath, "");
    const grantDeadline = Date.now() + 2000;
    while (Date.now() < grantDeadline && !existsSync(readyMarker)) await Bun.sleep(10);
    expect(existsSync(readyMarker), "lockf never granted the sidecar to the blocker").toBe(true);
    const holders = sidecarOpeners(lockPath); // the blocker (lockf and its command)
    const child = Bun.spawn([tapPath, "admin", "refresh", "--json"], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe" });
    // Parked-proof: refresh opens the sidecar at acquirePathLock — after the
    // scan and observe are done and BEFORE the reload read — and holds it open
    // while it waits in-process, so a new lsof opener beside the blocker is the
    // exact signal that the child is waiting for the flock. A time-based settle
    // raced the scan under load and let the mutation land too early.
    const parked = () => [...sidecarOpeners(lockPath)].some(pid => !holders.has(pid));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !parked()) await Bun.sleep(20);
    expect(parked(), "refresh never reached the sidecar lock wait").toBe(true);
    writeFileSync(t.reg, readFileSync(t.reg, "utf8").replace("9007199254740992", "9007199254740993"));
    blocker.kill();
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.trimmed.map((x: any) => x.handle)).toEqual(["still"]);
    const rewrittenRaw = readFileSync(t.reg, "utf8");
    const rewritten = JSON.parse(rewrittenRaw) as { seats: Record<string, unknown> };
    expect(Object.keys(rewritten.seats).sort()).toEqual(["alive", "drift"]);
    expect(rewrittenRaw).toContain("9007199254740993");
  } finally {
    blocker.kill();
  }
}, 30000);

test("an authority move during the locked window joins cannot-check, never a stale rewrite", async () => {
  const f = fixture();
  const t = f.team("moved", {
    alive: f.active("moved/alive", 1),
    gone: { status: "active", session: "moved/gone", pane: "moved/gone:0.0", pane_id: "%23", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1", unknown_field: 7 },
  });
  f.saveSnapshot();
  const lockPath = `${t.reg}.lock`;
  const readyMarker = join(f.base, "lockf-ready");
  const blocker = Bun.spawn(["/usr/bin/lockf", "-k", lockPath, "sh", "-c", ': > "$1"; exec sleep 30', "sh", readyMarker]);
  try {
    const grantDeadline = Date.now() + 2000;
    while (Date.now() < grantDeadline && !existsSync(readyMarker)) await Bun.sleep(10);
    expect(existsSync(readyMarker), "lockf never granted the sidecar to the blocker").toBe(true);
    const holders = sidecarOpeners(lockPath); // the blocker (lockf and its command)
    const child = Bun.spawn([join(f.base, "bin", "tap"), "admin", "refresh", "--json"], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe" });
    const parked = () => [...sidecarOpeners(lockPath)].some(pid => !holders.has(pid));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !parked()) await Bun.sleep(20);
    expect(parked(), "refresh never reached the sidecar lock wait").toBe(true);
    // The authority moves WHILE refresh is parked inside its observation
    // window: the index now names a different acting registry for this team.
    const indexPath = join(f.index, "global-registry.json");
    const moved = JSON.parse(readFileSync(indexPath, "utf8")) as { teams: Record<string, { registry_location: string }> };
    const movedRow = moved.teams.moved!;
    movedRow.registry_location = join(t.teamRoot, ".tap", "moved-acting.json");
    writeFileSync(indexPath, JSON.stringify(moved));
    writeFileSync(movedRow.registry_location, JSON.stringify({ schema: "0.20", team: { name: "moved" }, seats: {} }));
    blocker.kill();
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(1);
    const doc = JSON.parse(stdout);
    expect(doc.cannot_check).toEqual(["moved"]);
    expect(doc.trimmed).toEqual([]);
    // The scanned store was never rewritten from a stale authority.
    expect(readFileSync(t.reg, "utf8")).toContain("unknown_field");
  } finally {
    blocker.kill();
  }
}, 30000);

test("refresh completes its registry work without opening an unreadable payload directory", () => {
  const f = fixture();
  const t = f.team("busy", {
    alive: f.active("busy/alive", 1),
    gone: { status: "active", session: "busy/gone", pane: "busy/gone:0.0", pane_id: "%24", harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1" },
  });
  const bus = f.bus(t.teamRoot);
  mkdirSync(join(bus, "payloads"), { recursive: true });
  writeFileSync(join(bus, "payloads", "p.md"), "---\nto: alive\n---\nbody");
  chmodSync(join(bus, "payloads"), 0o000);
  f.saveSnapshot();
  try {
    const r = f.run(["refresh", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.trimmed.map((x: any) => x.handle)).toEqual(["gone"]);
    // Left exactly as unreadable as the control made it.
    expect(statSync(join(bus, "payloads")).mode & 0o777).toBe(0o000);
  } finally {
    chmodSync(join(bus, "payloads"), 0o755);
  }
}, 30000);

test("the direct tap.sh admin door pins the transpiler cache off (fresh HOME zero-write)", () => {
  const f = fixture();
  f.team("solo", { alive: f.active("solo/alive", 1) });
  f.saveSnapshot();
  // The direct door is the production chain: scripts/tap.sh (root shim) execs
  // the sandbox's bin/tap. Both directories are symlinked so sibling
  // sourcing resolves, exactly like the bin/tap symlink does.
  mkdirSync(join(f.base, "skills", "tap"), { recursive: true });
  symlinkSync(join(root, "scripts"), join(f.base, "scripts"), "dir");
  symlinkSync(join(root, "skills/tap/scripts"), join(f.base, "skills", "tap", "scripts"), "dir");
  writeFileSync(join(f.base, "home", "Library"), "canary: whoever creates the cache dir fails here");
  const before = f.snapshotTree();
  const r = spawnSync("bash", [join(f.base, "scripts", "tap.sh"), "admin", "--json"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(f.snapshotTree()).toEqual(before);
}, 30000);
