// `tap team attach`'s planner, natively (S2 of the launcher tail).
//
// The oracle here is a FROZEN CAPTURE, not a live twin, and that is the whole
// difference from S1. `registry_v20.seat_is_relaunchable` survived S1's port
// with 17 Python callers, so its parity arm could run the incumbent. Nothing
// survives this one: `test_team_only.py` imported the planner directly, so
// those arms stopped testing anything the moment the body moved. The capture
// in fixtures/attach-partition-oracle.json was taken while the Python still
// existed, carries the blob ids it was taken from, and cannot be rebuilt.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalHandle, partition, PartitionRefusal, spared } from "../src/launcher/attach-partition";
import { sanitizeComponent, sessionNameForHandle } from "../src/launcher/naming";

const repo = resolve(import.meta.dir, "../../..");
const module = join(repo, "runtime/bun/src/launcher/attach-partition.ts");
const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/attach-partition-oracle.json"), "utf8")) as Oracle;

interface OracleCase {
  case: string;
  team: string;
  snapshot: string;
  snapshot_is_latin1: boolean;
  seeded_outputs: Record<string, string> | null;
  refusal_kind: "deliberate" | "uncaught" | null;
  except_blob: string;
  only_blob: string;
  exit: number;
  stderr: string;
  live: string;
  unavailable: string;
  excluded: string;
  floor_agrees: boolean | null;
}
interface Oracle {
  captured_from: { head: string; blobs: Record<string, string>; python: string; floor_python: string | null };
  parity_caveat: { cases: string[]; decision: string };
  cases: OracleCase[];
}

// Allocate INSIDE the runner's own scratch, which it already reaps under its
// lsof guard after Bun exits. An `afterAll` doing that reap here ran the guard
// inside Bun's five-second hook budget and timed out on a loaded box, turning
// a clean 13/13 into 13 pass / 1 fail (partner review) — a cleanup that
// becomes its own flake. `TMUX_TMPDIR` is set by `test/run.sh`; the fallback
// exists only for a direct invocation, which is not a supported path.
const scratchRoot = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-attach-partition."));
let allocated = 0;

function stage(row: OracleCase) {
  const dir = join(scratchRoot, `c${allocated++}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, "snap.json");
  // A latin1-marked document carries bytes JSON cannot hold; write them back
  // exactly, or the invalid-byte cases silently become valid UTF-8.
  writeFileSync(snapshot, Buffer.from(row.snapshot, row.snapshot_is_latin1 ? "latin1" : "utf8"));
  const paths = { live: join(dir, "live"), unavailable: join(dir, "unavailable"), excluded: join(dir, "excluded") };
  for (const [key, path] of Object.entries(paths)) writeFileSync(path, row.seeded_outputs?.[key] ?? "");
  return { snapshot, paths };
}

function outputs(paths: Record<string, string>) {
  return {
    live: readFileSync(paths.live!, "utf8"),
    unavailable: readFileSync(paths.unavailable!, "utf8"),
    excluded: readFileSync(paths.excluded!, "utf8"),
  };
}

/**
 * Replay IN-PROCESS. Seventy-seven sequential `bun` spawns cost more than one
 * test's 5 s budget on a loaded gate worker, which fails the merge gate for a
 * reason unrelated to planner correctness (Codex P1, reproduced there twice).
 * The subprocess only ever observed the CLI's exit mapping, and that mapping is
 * three lines pinned by its own arm below; everything else this replay checks
 * is the exported function's behaviour.
 */
function runCase(row: OracleCase): { exit: number; stderr: string; live: string; unavailable: string; excluded: string } {
  const { snapshot, paths } = stage(row);
  try {
    partition({ snapshotPath: snapshot, team: row.team, livePath: paths.live, unavailablePath: paths.unavailable,
      excludedPath: paths.excluded, exceptBlob: row.except_blob, onlyBlob: row.only_blob });
    return { exit: 0, stderr: "", ...outputs(paths) };
  } catch (error) {
    // The CLI prints a deliberate refusal's own sentence and exits 1; anything
    // else is an uncaught shape whose exit class is all that ports.
    const message = error instanceof PartitionRefusal ? error.message : String(error);
    return { exit: 1, stderr: message, ...outputs(paths) };
  }
}

describe("the frozen oracle", () => {
  test("provenance names the bytes it was taken from, and the capture is not empty", () => {
    expect(oracle.captured_from.head).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(oracle.captured_from.blobs)).toContain("skills/tap/scripts/session/attach_partition.py");
    // The floor was exercised: a capture that silently skipped 3.11 would carry
    // null here, and its exits would be one interpreter's opinion.
    expect(oracle.captured_from.floor_python).toMatch(/^3\.11\./);
    expect(oracle.cases.every(row => row.floor_agrees === true)).toBe(true);
    // Guards against a fixture that degenerates to all-pass or all-refuse.
    expect(oracle.cases.filter(row => row.exit === 0).length).toBeGreaterThan(20);
    expect(oracle.cases.filter(row => row.refusal_kind === "deliberate").length).toBe(29);
    expect(oracle.cases.filter(row => row.refusal_kind === "uncaught").length).toBe(8);
  });

  test("every captured case replays on the native planner", () => {
    const caveat = new Set(oracle.parity_caveat.cases);
    const mismatches: string[] = [];
    for (const row of oracle.cases) {
      const actual = runCase(row);
      const expected = {
        exit: row.exit,
        live: row.live,
        unavailable: row.unavailable,
        excluded: row.excluded,
      };
      const observed = { exit: actual.exit, live: actual.live, unavailable: actual.unavailable, excluded: actual.excluded };
      if (caveat.has(row.case)) {
        // The one deliberate divergence: Python's repr of a non-string `revive`
        // is not reproduced; `JSON.stringify` is emitted instead. The
        // expectation is COMPUTED from the case's own snapshot and the whole
        // output is compared, so this branch is as strict as every other row
        // and differs only in which third column it expects.
        //
        // An earlier version asserted merely "not '-' and not the frozen
        // bytes", which admitted any other value and any trailing extra output
        // (partner review) — a weak assertion in the name of a narrow
        // exemption, which is how an exemption quietly widens.
        const reviveValue = (JSON.parse(row.snapshot) as { sessions: Array<{ revive: unknown }> }).sessions[0]!.revive;
        const frozenLine = row.live.trimEnd().split("\x1f");
        const expectedLive = `${[frozenLine[0], frozenLine[1], JSON.stringify(reviveValue)].join("\x1f")}\n`;
        const caveatExpected = { exit: 0, live: expectedLive, unavailable: row.unavailable, excluded: row.excluded };
        if (JSON.stringify(observed) !== JSON.stringify(caveatExpected)) {
          mismatches.push(`${row.case} (caveat row)\n  expected ${JSON.stringify(caveatExpected)}\n  actual   ${JSON.stringify(observed)}`);
        }
        continue;
      }
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        mismatches.push(`${row.case}\n  frozen ${JSON.stringify(expected)}\n  actual ${JSON.stringify(observed)}`);
      }
      // A refusal the planner AUTHORS is operator-facing text and is exact; one
      // it merely lets happen carried a Python traceback that no port should
      // reproduce, so only its exit class is portable.
      if (row.refusal_kind === "deliberate" && actual.stderr !== row.stderr.split("\n").pop()!.trim()) {
        mismatches.push(`${row.case}\n  frozen stderr ${JSON.stringify(row.stderr)}\n  actual stderr ${JSON.stringify(actual.stderr)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("the CLI's exit mapping — the three lines the in-process replay does not cover", () => {
  // The replay above runs `partition()` directly, so this is where the wrapper
  // is pinned: the caller maps ANY nonzero to `session_list_invalid`, which
  // makes the STATUS the contract and the message the diagnostic. Four spawns,
  // not seventy-seven.
  function cli(row: OracleCase): { exit: number; stderr: string } {
    const { snapshot, paths } = stage(row);
    const r = spawnSync("bun", [module, snapshot, row.team, paths.live, paths.unavailable, paths.excluded, row.except_blob, row.only_blob],
      { encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    return { exit: r.status ?? -1, stderr: r.stderr.trim() };
  }
  const pick = (name: string) => oracle.cases.find(row => row.case === name)!;

  test("a planned snapshot exits 0 silently", () => {
    expect(cli(pick("handle_valid"))).toEqual({ exit: 0, stderr: "" });
  });

  test("a deliberate refusal exits 1 and prints its own sentence, with no stack", () => {
    const row = pick("handle_numeric");
    const actual = cli(row);
    expect(actual.exit).toBe(1);
    expect(actual.stderr).toBe(row.stderr.split("\n").pop()!.trim());
    expect(actual.stderr).not.toContain("at ");
  });

  test("a malformed snapshot exits 1 without reproducing a Python traceback", () => {
    const actual = cli(pick("toplevel_array"));
    expect(actual.exit).toBe(1);
    expect(actual.stderr).not.toContain("Traceback");
    expect(actual.stderr.length).toBeGreaterThan(0);
  });

  test("a missing argument is a usage error, distinct from a refusal", () => {
    const r = spawnSync("bun", [module, "only-one-arg"], { encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: attach-partition.ts");
  });
});

describe("canonical identity — the row's handle, never the session name", () => {
  // The partner reviewer's control, carried with attribution rather than re-derived.
  // A mutant returning `name.split("/", 1)[1]` keeps the malformed-handle guard
  // intact and survived all 52 cases of the first capture; these three rows
  // make its selection wrong in both directions, so it cannot survive by
  // coincidence in either.
  const row = { name: "demo/legacy-scout", handle: "grok", live: true, revive: "picker" };

  test("the planned row carries the registry handle", () => {
    expect(canonicalHandle(row, row.name)).toBe("grok");
  });

  test("--only keyed on the registry handle plans it; a derived handle would spare it", () => {
    expect(spared("grok", new Set(), new Set(["grok"]))).toBe(false);
    expect(spared("legacy-scout", new Set(), new Set(["grok"]))).toBe(true);
  });

  test("--except keyed on the registry handle spares it; a derived handle would plan it", () => {
    expect(spared("grok", new Set(["grok"]), new Set())).toBe(true);
    expect(spared("legacy-scout", new Set(["grok"]), new Set())).toBe(false);
  });

  test("a malformed handle refuses rather than falling back to the session name", () => {
    for (const bad of [undefined, "", 7, 0, [], ["x"], {}, true, null]) {
      expect(() => canonicalHandle({ name: "demo/a", handle: bad }, "demo/a")).toThrow(PartitionRefusal);
    }
  });
});

describe("the prefix is computed by the function that named the session", () => {
  const TEAM = "demo.alpha.107-Renewal";
  const BASE = "demo-alpha-107-Renewal";

  test("the premise, asserted rather than assumed", () => {
    // If the launcher ever stops rewriting the dot, every arm below is testing
    // a mapping production no longer performs.
    expect(sessionNameForHandle(TEAM, "fable")).toBe(`${BASE}/fable`);
    expect(sanitizeComponent(TEAM)).toBe(BASE);
  });

  test("a dotted team's rows are planned, and a sibling base is not", () => {
    const dir = join(scratchRoot, "prefix");
    mkdirSync(dir, { recursive: true });
    const snapshot = join(dir, "snap.json");
    const rows = [
      { name: `${BASE}/fable`, handle: "fable", live: true, revive: "picker" },
      { name: `${BASE}-two/fable`, handle: "fable", live: true, revive: "picker" },
      { name: "other/fable", handle: "fable", live: true, revive: "picker" },
    ];
    writeFileSync(snapshot, JSON.stringify({ sessions: rows }));
    const out = { live: join(dir, "l"), unavailable: join(dir, "u"), excluded: join(dir, "e") };
    for (const path of Object.values(out)) writeFileSync(path, "");
    partition({ snapshotPath: snapshot, team: TEAM, livePath: out.live, unavailablePath: out.unavailable, excludedPath: out.excluded, exceptBlob: "", onlyBlob: "" });
    const live = readFileSync(out.live, "utf8");
    expect(live).toContain(`${BASE}/fable`);
    expect(live).not.toContain(`${BASE}-two/fable`);
    expect(live).not.toContain("other/fable");
  });

  test("case, digits and underscores are NOT rewritten — the over-sanitizing direction", () => {
    expect(sanitizeComponent("Demo_Team9")).toBe("Demo_Team9");
  });
});
