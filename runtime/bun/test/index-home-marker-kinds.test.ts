// The machine index marker, classified by PATH KIND and by ERROR KIND.
//
// `absent` is not merely "no document" — it says "this machine has no enrolled
// team" and routes callers to the `tap init` refusal (F2b; legacy teams.json is
// never read). So it may only be returned when the path was successfully
// observed to hold nothing. Every other outcome — a non-regular entry, a broken
// link, or an error that means the path could not be READ — is an unusable
// marker, which is `invalid`.
//
// Two defects this file exists to keep fixed, both found in review:
//   1. `existsSync` + `readFileSync` BLOCKS on a FIFO. A FIFO exists, and
//      opening it for read waits for a writer that never comes — so the reader
//      hung instead of refusing (partner review).
//   2. A broad `catch` on the stat mapped EVERY error to `absent`, so a
//      permission or filesystem fault silently licensed the retired store
//      (rule 19; partner review, demonstrated with a valid marker under a
//      directory with traverse permission removed).
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGlobalRegistry, resolveTeamMarkerAware, resolveTeamMarkerAwareWithEvidence } from "../src/index-home";

function index(): string {
  return mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "marker-kinds-"));
}
function marker(home: string): string {
  return join(home, "global-registry.json");
}
function valid(home: string): void {
  writeFileSync(marker(home), JSON.stringify({ schema: "0.20", teams: {} }));
}

test("nothing at the path is absent — the one state that means no enrolled team", () => {
  expect(loadGlobalRegistry(index()).marker).toBe("absent");
});

test("a valid document is live", () => {
  const home = index(); valid(home);
  expect(loadGlobalRegistry(home).marker).toBe("live");
});

test("a FIFO is invalid, and classification RETURNS — bounded in a CHILD", () => {
  const home = index();
  execFileSync("/usr/bin/mkfifo", [marker(home)]);

  // THE DEADLINE MUST BE OUTSIDE THE CALL. The first version of this control
  // timed the synchronous call and asserted the elapsed time afterwards, which
  // is a bound that can only run when there is nothing to bound: a regression
  // to readFileSync(FIFO) blocks forever and the assertion is never reached, so
  // the test HANGS instead of failing. Neither runtime/bun/test/run.sh nor
  // bun-router.test.sh wraps the Bun suite in an outer timeout, so that shape
  // stalls the merge gate rather than reporting (partner review, FIX-AND-SHIP).
  //
  // So the classification runs in a child with a real deadline, and a child that
  // has to be killed FAILS. A timeout is never a pass: a blocking read is not a
  // refusal. The child imports this checkout's module by absolute path, so the
  // arm cannot silently test some other copy.
  const src = join(import.meta.dir, "..", "src", "index-home.ts");
  const childFile = join(home, "classify-child.ts");
  writeFileSync(
    childFile,
    `import { loadGlobalRegistry } from ${JSON.stringify(src)};\n` +
      `process.stdout.write(loadGlobalRegistry(${JSON.stringify(home)}).marker);\n`,
  );

  const child = spawnSync(process.execPath, [childFile], { timeout: 5000, encoding: "utf8" });

  if (child.error) {
    throw new Error(`FIFO classification did not return within the deadline: ${child.error.message}`);
  }
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect((child.stdout ?? "").trim()).toBe("invalid");
});

test("a directory at the marker path is invalid, not absent", () => {
  const home = index();
  mkdirSync(marker(home));
  expect(loadGlobalRegistry(home).marker).toBe("invalid");
});

test("a broken symlink is invalid — it is an entry, not an absence", () => {
  const home = index();
  symlinkSync(join(home, "nonexistent-target"), marker(home));
  expect(loadGlobalRegistry(home).marker).toBe("invalid");
});

test("a symlink to a regular file resolves and parses", () => {
  const home = index();
  const real = join(home, "real.json");
  writeFileSync(real, JSON.stringify({ schema: "0.20", teams: {} }));
  symlinkSync(real, marker(home));
  expect(loadGlobalRegistry(home).marker).toBe("live");
});

test("an UNOBSERVABLE marker is invalid, never absent (rule 19)", () => {
  const home = index();
  valid(home);
  // The marker is valid and present; only the path cannot be traversed. Mapping
  // this to `absent` would license writing the retired store on a machine that
  // is demonstrably post-flip.
  chmodSync(home, 0o000);
  try {
    const seen = loadGlobalRegistry(home).marker;
    // Running as root defeats the permission check; skip rather than assert a
    // conclusion the environment cannot support.
    if (seen !== "absent" || process.getuid?.() !== 0) {
      expect(seen).toBe("invalid");
    }
  } finally {
    chmodSync(home, 0o700);
  }
});

// BYTE POLARITY (tap-fyttg). The incumbent reads the index in Python text mode,
// so one invalid byte anywhere refuses the whole document; a lossy decode
// repairs that byte into U+FFFD and re-licenses the marker. The bad byte below
// sits in an UNRELATED team's name: replacement decoding still leaves valid
// JSON, which is exactly how a lenient reader turns an authority refusal back
// into a live marker.
test("a raw 0xe9 in an unrelated team name is invalid with doc null, not a repaired live marker", () => {
  const home = index();
  writeFileSync(marker(home), Buffer.concat([
    Buffer.from(`{"schema":"0.20","teams":{"oth`),
    Buffer.from([0xe9]),
    Buffer.from(`er":{"root":"/nowhere","registry_location":"/nowhere/r.json"}}}`),
  ]));
  const snap = loadGlobalRegistry(home);
  expect(snap.marker).toBe("invalid");
  expect(snap.doc).toBeNull();
});

test("the same logical document in valid UTF-8 is live — the arm is about the bytes", () => {
  const home = index();
  writeFileSync(marker(home), JSON.stringify({
    schema: "0.20",
    teams: { other: { root: "/nowhere", registry_location: "/nowhere/r.json" } },
  }));
  const snap = loadGlobalRegistry(home);
  expect(snap.marker).toBe("live");
  expect(snap.doc).not.toBeNull();
});

test("a BOM-prefixed otherwise-valid index is invalid — Python text mode hands the BOM to json.load, which refuses it", () => {
  const home = index();
  writeFileSync(marker(home), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ schema: "0.20", teams: {} })),
  ]));
  const snap = loadGlobalRegistry(home);
  expect(snap.marker).toBe("invalid");
  expect(snap.doc).toBeNull();
});

// resolveTeamMarkerAware — marker-aware, READ-ONLY team resolution (tap-1t0h.1).
test("marker-aware live resolution answers ok through the global registry", () => {
  const home = index();
  const root = join(home, "team-root");
  mkdirSync(root);
  const reg = join(home, "acting-registry.json");
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
  writeFileSync(marker(home), JSON.stringify({
    schema: "0.20",
    teams: {
      t: { root, registry_location: reg, state: "registered" },
      // tap-1t0h.1's regression shape: a DEAD entry whose registered root was
      // never created is exactly what a pruning read would remove.
      dead: { root: join(home, "dead-root"), registry_location: join(home, "dead-root", ".tap", "bus", "registry.json"), state: "registered" },
    },
  }));
  // Snapshot BEFORE any read: a prune-on-read fires on the first resolution,
  // so a snapshot taken after warm-up reads would compare against pruned bytes.
  const globalBytes = readFileSync(marker(home));
  const r = resolveTeamMarkerAware("t", home);
  expect(r.marker).toBe("live");
  expect(r.status).toBe("ok");
  expect(r.root).toBe(root);
  expect(r.registryLocation).toBe(reg);
  // The read demonstrably visits the dead entry and answers it from the index
  // without creating anything it names.
  const dead = resolveTeamMarkerAware("dead", home);
  expect(dead.marker).toBe("live");
  expect(dead.status).toBe("unreachable");
  expect(dead.root).toBe(join(home, "dead-root"));
  expect(dead.registryLocation).toBe(join(home, "dead-root", ".tap", "bus", "registry.json"));
  // READ-ONLY means byte-for-byte: a read must not prune (not even the dead
  // entry), rewrite or re-stamp the index it just answered from.
  resolveTeamMarkerAware("t", home);
  resolveTeamMarkerAware("dead", home);
  resolveTeamMarkerAware("missing-team", home);
  expect(readFileSync(marker(home)), "global-registry.json was REWRITTEN during a read").toEqual(globalBytes);
});

test("marker-aware live resolution reports unreachable when the acting registry is gone", () => {
  const home = index();
  const root = join(home, "team-root");
  mkdirSync(root);
  writeFileSync(marker(home), JSON.stringify({
    schema: "0.20",
    teams: { t: { root, registry_location: join(home, "missing-registry.json") } },
  }));
  const r = resolveTeamMarkerAware("t", home);
  expect(r.marker).toBe("live");
  expect(r.status).toBe("unreachable");
});

// F2b: the absent arm never reads legacy teams.json. A teams.json naming a
// live root (which the retired legacy arm resolved `ok`) still answers
// `missing` with failure evidence, and the file is left byte-for-byte alone.
test("absent never reads teams.json: a present teams.json still answers missing with failure evidence", () => {
  const home = index();
  const live = join(home, "live-team");
  mkdirSync(live);
  const teamsJson = join(home, "teams.json");
  writeFileSync(teamsJson, JSON.stringify({ teams: { live: { root: live } } }));
  const before = readFileSync(teamsJson);
  expect(existsSync(marker(home))).toBe(false);

  const { resolution, failure } = resolveTeamMarkerAwareWithEvidence("live", home);
  expect(resolution).toEqual({ status: "missing", root: "", registryLocation: "", marker: "absent" });
  expect(failure).toBe("no machine index (global-registry.json)");
  expect(readFileSync(teamsJson).equals(before)).toBe(true);
});

test("marker-aware resolution fails closed on an unusable marker", () => {
  const home = index();
  mkdirSync(marker(home)); // a directory at the marker path is invalid
  const r = resolveTeamMarkerAware("t", home);
  expect(r.marker).toBe("invalid");
  expect(r.status).toBe("invalid");
  expect(r.root).toBe("");
  expect(r.registryLocation).toBe("");
});

// CAUSAL FIFO CONTROL (r4045876907): team resolution must classify the marker
// from ONE guarded snapshot and never reopen the path afterwards. A regression
// to classify-then-reopen reintroduces the TOCTOU where the second open lands
// on a swapped-in FIFO and blocks forever. Same rule as the loadGlobalRegistry
// control above: the deadline lives OUTSIDE the synchronous call, in a child,
// and a killed child FAILS — a hang is never a pass.
test("marker-aware resolution on a FIFO marker returns invalid inside the deadline", () => {
  const home = index();
  execFileSync("/usr/bin/mkfifo", [marker(home)]);

  const src = join(import.meta.dir, "..", "src", "index-home.ts");
  const childFile = join(home, "resolve-child.ts");
  writeFileSync(
    childFile,
    `import { resolveTeamMarkerAware } from ${JSON.stringify(src)};\n` +
      `process.stdout.write(JSON.stringify(resolveTeamMarkerAware("t", ${JSON.stringify(home)})));\n`,
  );

  const child = spawnSync(process.execPath, [childFile], { timeout: 5000, encoding: "utf8" });

  if (child.error) {
    throw new Error(`marker-aware FIFO resolution did not return within the deadline: ${child.error.message}`);
  }
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  const seen = JSON.parse((child.stdout ?? "").trim()) as { marker: string; status: string; root: string };
  expect(seen.marker).toBe("invalid");
  expect(seen.status).toBe("invalid");
  expect(seen.root).toBe("");
});
