// Ported from the retired smoke/team-scale-bounds.test.sh: the `tap team` output
// bounds, with causal controls. A bound whose removal reds nothing is a comment,
// not a check — so the heavy arm runs the real verb against a roster sized PAST
// bun's ~1 MiB default and under the 64 MiB bound, the spawnOutcome matrix runs
// the predicate directly and then mutates a COPY of it, and the symlink arm runs
// the real `team refresh` against an enrolled registry_location that only
// statSync (never lstatSync) accepts. The two causal mutants are IN-FILE: each
// self-mutation must apply (byte-checked) and must be caught on the specific row
// or refusal that justifies it.
//
// ON WHAT THE HEAVY ARM NO LONGER CLAIMS. The retired file's arms 1-3 existed to
// catch the removal of three spawn bounds (readRegistry, observe, presetFacts
// children reading a roster past bun's ~1 MiB default). Those children have since
// been migrated in-process. Of the two maxBuffer sites left on this path, the
// host ps table is not roster-sized — dropping its bound reds nothing here or in
// the retired file (measured, partner review) — while list-sessions' bound IS
// load-bearing: a live fleet's answer can exceed bun's ~1 MiB default, and
// truncation turns a real answer unobservable (tmux.ts tmuxSessionNamespace).
// Per the retired file's own rule — a bound whose removal reds nothing is a
// comment, not a check — this arm therefore claims the 24k-seat OUTCOME only.
import { afterEach, expect, test } from "bun:test";
import { closeSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sandbox(): string {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "team-scale-"));
  roots.push(root);
  return root;
}

// A tmux that logs its argv and fails: every seat's lifecycle is unobservable,
// which is the shape the bounds and the typed unknown state are about.
function stubTmux(work: string): string {
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf '%s\\n' "$*" >> "\${TMUX_TRACE:?}"
exit 1
`, { mode: 0o755 });
  return bin;
}

// `preset` must be a DICT: the registry reader takes the name only via
// `(preset or {}).get("name")` and yields "" for a bare string. Rows are
// PANE-BACKED, NOT POLL: `tap team` does not probe poll rows, so an all-poll
// roster never reaches the batch classifier at any size — the retired file's
// first version used poll rows and its observe arm survived the bound deletion.
function seedRegistry(bus: string, seats: number): void {
  const seatObjs: Record<string, unknown> = {};
  for (let i = 0; i < seats; i++) {
    const id = String(i).padStart(6, "0");
    seatObjs[`seat-${id}`] = {
      status: "active", delivery: "pane", harness: "claude",
      pane: `demo-${id}:0.0`, pane_id: `%${i}`,
      session: `demo/seat-${id}`, preset: { name: "fable" },
    };
  }
  writeFileSync(join(bus, "registry.json"),
    JSON.stringify({ schema: "0.20", team: { name: "demo" }, seats: seatObjs }));
}

// The spawnOutcome matrix: the measured behaviour of BOTH runtimes, not invented
// shapes (see spawn.ts's own table). `status: null` with NO error — the killed
// child — is the row that makes the guard's two conjuncts non-redundant.
const OUTCOME_CASES: [string, { status: number | null | undefined; error?: Error }, "ran" | "failed" | "unusable"][] = [
  ["ran (exit 0)", { status: 0 }, "ran"],
  ["failed (exit 3)", { status: 3 }, "failed"],
  ["killed: null, NO error", { status: null }, "unusable"],
  ["ENOENT under bun", { status: undefined, error: new Error("ENOENT") }, "unusable"],
  ["ENOBUFS: null + error", { status: null, error: new Error("ENOBUFS") }, "unusable"],
  ["nonzero WITH an error", { status: 3, error: new Error("boom") }, "unusable"],
];

test("spawnOutcome classifies all six spawn shapes, and dropping the status conjunct is caught on the killed row", async () => {
  const { spawnOutcome } = await import("../src/spawn");
  for (const [name, r, want] of OUTCOME_CASES) expect(spawnOutcome(r), name).toBe(want);

  // MUTATION-PROVEN, in the arm itself — on a COPY, never the repo tree. With
  // the status conjunct dropped, the killed row must be misread (not "unusable");
  // a mutant that passes would mean nothing here covers that row.
  const work = sandbox();
  const src = readFileSync(join(repo, "runtime/bun/src/spawn.ts"), "utf8");
  const guard = 'if (r.error || typeof r.status !== "number") return "unusable";';
  expect(src.includes(guard), "mutation anchor: the guard's text changed, so this arm's mutant would say nothing").toBe(true);
  const mutantPath = join(work, "spawn-mutant.ts");
  writeFileSync(mutantPath, src.replace(guard, 'if (r.error) return "unusable";'));
  expect(readFileSync(mutantPath, "utf8"), "the mutation did not APPLY (byte-identical copy)").not.toBe(src);
  const mutant = await import(mutantPath);
  expect(mutant.spawnOutcome({ status: null }),
    "MUTANT SURVIVED: dropping the status conjunct still answers the killed row sanely — nothing covers status null with no error")
    .not.toBe("unusable");
});

// Arm 5: the acting-registry guard must ACCEPT a symlink to a real registry —
// the one input that falsifies lstatSync. The decoy in the bus makes "accepted"
// provable: the receipt must name the enrolled seat, never the bus one.
function seedSymlinkFixture(work: string): { symRoot: string; symHome: string; symIdx: string; bin: string } {
  const symRoot = join(work, "symroot");
  const symHome = join(symRoot, ".tap", "bus");
  mkdirSync(join(symHome, "payloads"), { recursive: true });
  mkdirSync(join(symHome, "receipts"), { recursive: true });
  const symIdx = join(work, "symidx");
  mkdirSync(symIdx);
  writeFileSync(join(work, "real-registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "demo" },
    seats: { linked: { status: "active", delivery: "poll", harness: "daemon", session: "demo/linked" } },
  }));
  symlinkSync(join(work, "real-registry.json"), join(work, "linked-registry"));
  writeFileSync(join(symIdx, "global-registry.json"), JSON.stringify({
    schema: "0.20", teams: { demo: { root: symRoot, registry_location: join(work, "linked-registry"), state: "registered" } },
  }));
  writeFileSync(join(symHome, "registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "demo" },
    seats: { decoy: { status: "active", delivery: "poll", harness: "daemon", session: "demo/decoy" } },
  }));
  return { symRoot, symHome, symIdx, bin: stubTmux(work) };
}

function runRefresh(runtimeRoot: string, symRoot: string, env: NodeJS.ProcessEnv, outBase: string): { exitCode: number | null } {
  const out = openSync(`${outBase}.out`, "w");
  const err = openSync(`${outBase}.err`, "w");
  try {
    return Bun.spawnSync([process.execPath, join(runtimeRoot, "main.ts"), "team", "refresh"],
      { cwd: symRoot, env, stdout: out, stderr: err, stdin: "ignore" });
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

test("an enrolled registry_location that is a symlink to a real registry is accepted and followed", () => {
  const work = sandbox();
  const { symRoot, symHome, symIdx, bin } = seedSymlinkFixture(work);
  mkdirSync(join(work, "symhome"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(work, "symhome"), TAP_HOME: symHome,
    TAP_INDEX_HOME: symIdx, TAP_TMUX_SOCKET: `team-scale-${process.pid}`,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const proc = runRefresh(join(repo, "runtime/bun"), symRoot, env, join(work, "sym"));
  const stdout = readFileSync(join(work, "sym.out"), "utf8");
  expect(proc.exitCode, `a symlinked acting registry was REFUSED (exit ${proc.exitCode}); stderr:\n${readFileSync(join(work, "sym.err"), "utf8").slice(0, 600)}`).toBe(0);
  expect(stdout.includes("decoy"), "the receipt names the BUS registry's seat — the symlink was not followed, so exit 0 says nothing").toBe(false);
  expect(stdout.includes("linked"), `the receipt names neither seat; stdout:\n${stdout.slice(0, 400)}`).toBe(true);
}, 60_000);

// Arm 5b: the causal control, on a COPY of main.ts+src (mirroring the repo
// layout so src's ../../../vendor/fzf/manifest.json import resolves). The mutant
// must fail the way the DEFECT fails: the exact unreachable refusal, not any red.
test("statSync replaced by lstatSync in a copy refuses the symlinked acting registry as unreachable", () => {
  const work = sandbox();
  const { symRoot, symHome, symIdx, bin } = seedSymlinkFixture(work);
  mkdirSync(join(work, "symhome"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(work, "symhome"), TAP_HOME: symHome,
    TAP_INDEX_HOME: symIdx, TAP_TMUX_SOCKET: `team-scale-${process.pid}`,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const mutRoot = join(work, "mut");
  mkdirSync(join(mutRoot, "runtime", "bun"), { recursive: true });
  mkdirSync(join(mutRoot, "vendor", "fzf"), { recursive: true });
  cpSync(join(repo, "runtime/bun/main.ts"), join(mutRoot, "runtime/bun/main.ts"));
  cpSync(join(repo, "runtime/bun/src"), join(mutRoot, "runtime/bun/src"), { recursive: true });
  cpSync(join(repo, "vendor/fzf/manifest.json"), join(mutRoot, "vendor/fzf/manifest.json"));
  const mutSrc = join(mutRoot, "runtime/bun/src/verbs/refresh.ts");
  const predicate = "return statSync(path).isFile();";
  const importLine = 'import { existsSync, readFileSync, statSync } from "node:fs";';
  let text = readFileSync(mutSrc, "utf8");
  expect(text.includes(predicate), "mutation anchor: isRegularFile's text changed").toBe(true);
  expect(text.includes(importLine), "mutation anchor: the node:fs import line changed").toBe(true);
  text = text.replace(predicate, "return lstatSync(path).isFile();")
    .replace(importLine, 'import { existsSync, lstatSync, readFileSync } from "node:fs";');
  writeFileSync(mutSrc, text);
  expect(text.includes("lstatSync(path).isFile()"), "the mutant does not contain the substituted predicate").toBe(true);
  const mutProc = runRefresh(join(mutRoot, "runtime/bun"), symRoot, env, join(work, "sym-mut"));
  rmSync(mutRoot, { recursive: true, force: true });
  const mutErr = readFileSync(join(work, "sym-mut.err"), "utf8");
  expect(mutProc.exitCode, "MUTANT SURVIVED: lstatSync still accepted the symlinked registry").not.toBe(0);
  expect(mutErr, `the mutant exited ${mutProc.exitCode} but NOT with the unreachable refusal:\n${mutErr.slice(0, 500)}`)
    .toContain("acting registry unreachable");
}, 120_000);

// Arms 1-3 in one run: 24,000 seats, the retired roster size. This arm pins the
// OUTCOME at scale (parse, count, provenance, typed unobservable state, no
// per-row capture) — it is not a buffer-bound test; see the header note.
test("a 24,000-seat roster yields one parseable receipt at exit 0 with provenance and typed unobservable state", () => {
  const SEATS = Number(process.env.TAP_SCALE_SEATS ?? 24000);
  const work = sandbox();
  const bin = stubTmux(work);
  const tracePath = join(work, "tmux.trace");
  const catalogDir = join(work, "config", "tap");
  mkdirSync(catalogDir, { recursive: true });
  // A REAL CATALOG, copied from the checked-in v3 reference: without one the
  // roster drops roles and metadata, shrinks ~600 B/seat to ~77, and moves the
  // presetFacts cliff out past 13,000 seats so the silent arm measures nothing.
  cpSync(join(repo, "skills/tap/config/config.v3.toml"), join(catalogDir, "config.toml"));
  const bus = join(work, "bus");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  seedRegistry(bus, SEATS);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_TRACE: tracePath,
    XDG_CONFIG_HOME: join(work, "config"), TAP_HOME: bus,
    TAP_TMUX_SOCKET: `team-scale-${process.pid}`,
  };
  const proc = Bun.spawnSync([process.execPath, join(repo, "runtime/bun/main.ts"), "team", "--json"],
    { cwd: work, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const errText = proc.stderr.toString();
  expect(proc.exitCode, `tap team --json exited ${proc.exitCode} at ${SEATS} seats; stderr:\n${errText.slice(0, 800)}`).toBe(0);
  const stdout = proc.stdout.toString();
  // (1) Both bounds that corrupt do it while still exiting 0, so the parse is
  //     the assertion, not the exit code.
  let doc: { agents?: unknown[]; rows?: unknown[] } | undefined;
  expect(() => { doc = JSON.parse(stdout); },
    `UNPARSEABLE stdout at ${SEATS} seats (${stdout.length} bytes) while exiting 0 — the signature of an unbounded registry reader (truncated mid-token) or an unbounded classifier (raw records ahead of the receipt). Tail:\n${stdout.slice(-200)}`).not.toThrow();
  // (2) A GUARD, stated precisely: deleting observe()'s bound is caught by (1)
  //     via a nonzero exit, so this signature has no falsifier here (tap-30knu
  //     holds the routing half). It pins that a failed child's raw output never
  //     reaches a machine-readable receipt.
  expect(stdout.includes("\x1f"), "the batch classifier's raw US-delimited records reached stdout ahead of the receipt").toBe(false);
  // (3) THE SILENT ONE: presetFacts losing its bound leaves a well-formed
  //     receipt, an exact count, and no provenance on any row.
  const rows = (doc?.agents ?? doc?.rows) as Array<Record<string, unknown>> | undefined;
  expect(rows?.length, "the roster itself did not survive the read").toBe(SEATS);
  expect(rows!.filter(r => !r.preset),
    "rows carry NO preset: presetFacts returned {} — its bound is missing and provenance was dropped for every seat SILENTLY (ok=true, JSON parses, count exact, no consumer can detect it)")
    .toEqual([]);
  expect(rows!.filter(r => r.agent_state !== "unknown" || r.agent_state_reason !== "lifecycle_unreadable"),
    "unobservable rows lack the typed unknown/lifecycle_unreadable agent state — the roster must not capture 24,000 panes after its batch lifecycle snapshot already failed closed")
    .toEqual([]);
  expect(readFileSync(tracePath, "utf8").split("\n").filter(line => line.startsWith("capture-pane ")),
    "unobservable lifecycle rows triggered per-row capture-pane calls").toEqual([]);
}, 300_000);
