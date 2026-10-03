import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRegistry } from "../src/verbs/team";

function fixture(body: unknown, check: (path: string) => void) {
  const work = mkdtempSync(join(tmpdir(), "tap-registry-reader-"));
  try {
    const path = join(work, "registry.json");
    writeFileSync(path, JSON.stringify(body));
    check(path);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
function row(handle: string, extra: Record<string, unknown> = {}) {
  return {
    team: "", handle, harness: "", pane: "", status: "active", status_reason: "",
    delivery: "pane", pane_id: "", unattended: false, session: "", registered_at: "",
    crew: false, server_epoch: "", boot_id: "", preset: "", ...extra,
  };
}

// C4a-2: `seats` is the only roster axis. Every caller holds an acting pin that refused an
// old store (old_store) first, so an `agents` map beside or instead of seats is never read.
test("seats is the only roster axis: an agents map is never read, falsy seats is an empty roster", () => {
  for (const seats of [{}, { current: {} }]) fixture({ seats, agents: { old: {} } }, path => {
    expect(readRegistry(path, false, false)).toEqual({ok: true, team: "", rows: Object.keys(seats).map(h => row(h))});
  });
  for (const seats of [null, false, 0, "", []]) fixture({ seats, agents: { old: {} } }, path => {
    expect(readRegistry(path, false, false)).toEqual({ok: true, team: "", rows: []});
  });
  for (const agents of [null, false, 0, "", [], {}, { old: {} }]) fixture({ agents }, path => {
    expect(readRegistry(path, true, false)).toEqual({ok: true, team: "", rows: []});
  });
});

test("truthy scalar/array roster and team axes reject; top-level scalar/array always rejects", () => {
  const invalid = [null, false, 0, "", [], [1], "bad", 1,
    ...[true, 1, "bad", [1]].map(seats => ({ seats })),
    ...[true, 1, "bad", [1]].map(team => ({ team, seats: {} })),
  ];
  for (const body of invalid) fixture(body, path => {
    for (const json of [true, false]) expect(readRegistry(path, json, false).ok).toBe(false);
  });
  for (const team of [null, false, 0, "", [], {}]) fixture({ team, seats: {} }, path => {
    expect(readRegistry(path, false, false)).toEqual({ok: true, team: "", rows: []});
  });
});

test("nonobject rows are ignored, crew/unattended require literal true, Unicode handles sort by code point", () => {
  fixture({ seats: {
    "\u{10000}": { crew: true, unattended: true }, "\ue000": {}, "\ud800": {}, a: { crew: 1, unattended: 1 },
    b: { crew: "true", unattended: "true" }, c: { crew: false },
    nil: null, array: [], scalar: 1, text: "value", bool: true,
  } }, path => {
    expect(readRegistry(path, true, false).rows).toEqual([
      row("a"), row("b"), row("c"), row("\ud800"), row("\ue000"), row("\u{10000}", { crew: true, unattended: true }),
    ]);
    expect(readRegistry(path, true, true).rows).toEqual([row("\u{10000}", {crew: true, unattended: true})]);
  });
});

test("missing-key defaults differ from Python-or defaults and preserve truthy values", () => {
  for (const value of [null, false, 0, "", [], {}]) fixture({ seats: { seat: {
    harness: value, pane: value, status: value, status_reason: value, delivery: value,
    pane_id: value, session: value, registered_at: value, server_epoch: value, boot_id: value,
    preset: { name: value },
  } } }, path => {
    expect(readRegistry(path, false, false).rows).toEqual([row("seat", { harness: value, pane: value, status: value })]);
  });
  fixture({ team: { name: null }, seats: { seat: { delivery: [1], status_reason: { why: 1 }, preset: { name: [1] } } } }, path => {
    expect(readRegistry(path, false, false)).toEqual({ok: true, team: null,
      rows: [row("seat", {team: null, delivery: [1], status_reason: {why: 1}, preset: [1]})]});
  });
  for (const preset of [null, true, 1, "name", [], [1]]) fixture({ seats: { seat: { preset } } }, path => {
    expect(readRegistry(path, false, false).rows).toEqual([row("seat")]);
  });
});

test("missing and malformed registries reject in both modes without traceback matching", () => {
  const work = mkdtempSync(join(tmpdir(), "tap-registry-errors-"));
  try {
    const path = join(work, "registry.json");
    const missing = readRegistry(path, true, false);
    expect(missing.ok).toBe(false);
    expect(JSON.parse(missing.rawOutput!)).toMatchObject({ team: null, agents: [], error: expect.any(String) });
    expect(readRegistry(path, false, false).error).toContain("run: tap doctor");
    for (const bytes of ["{broken", Buffer.from([0xff]), "\ufeff{}",
      Buffer.from('{"schema":"0.20","team":{"name":"ro\xffster"},"seats":{"se\xffat":{}}}', "latin1"),
    ] ) {
      writeFileSync(path, bytes);
      const result = readRegistry(path, true, false);
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.rawOutput!)).toMatchObject({ team: null, agents: [], error: expect.any(String) });
      expect(readRegistry(path, false, false).error).toContain("tap team: registry unreadable");
      expect(readRegistry(path, false, false).error).toContain("run: tap doctor");
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
