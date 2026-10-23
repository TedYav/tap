import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendObservation, collectCalibrationRoutes, gcHint, makeObservation, noteHints, readObservations, renderCalibration, resolveCalibrationRoute, type Observation } from "../src/calibration";
import { acquireNoFollowLock } from "../src/digest-window";

const work = mkdtempSync(join(tmpdir(), "tap-calibration-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const route = "codex/example-model";
const row = (note = "Completed the CLI task with a bounded brief.", at = "2026-10-20"): Observation => makeObservation({ at, route, by: "example/writer", ref: "example-ref", note });

test("content IDs are stable across object order, omit nonspecific effort, and bind every field", () => {
  const actual = row();
  const expected = createHash("sha256").update(JSON.stringify(["2026-10-20", route, null, "example/writer", "example-ref", "Completed the CLI task with a bounded brief."])).digest("hex").slice(0, 8);
  expect(actual.id).toBe(expected);
  expect(Object.keys(actual).sort()).toEqual(["at", "by", "id", "note", "ref", "route"]);
  expect(makeObservation({ note: actual.note, ref: actual.ref, by: actual.by, route, at: actual.at })).toEqual(actual);
  for (const change of [{ note: "Different episode" }, { effort: "high" }, { ref: "tap-example" }, { by: "else/writer" }, { at: "2026-10-19" }, { route: "codex/other-example" }]) {
    expect(makeObservation({ ...actual, ...change }).id).not.toBe(actual.id);
  }
  expect(() => row(" \n ")).toThrow("empty");
});

test("append serializes behind the shared no-follow sidecar and never overwrites or repairs bad bytes", () => {
  const path = join(work, "store/observations.jsonl");
  expect(readObservations(path)).toEqual({ rows: [], bytes: 0 });
  expect(existsSync(join(work, "store"))).toBe(false);
  appendObservation(path, row("first"));
  const first = readFileSync(path, "utf8");
  appendObservation(path, row("second"));
  expect(readFileSync(path, "utf8")).toBe(first + JSON.stringify(row("second")) + "\n");
  const lock = acquireNoFollowLock(`${path}.lock`, 100);
  try { expect(() => appendObservation(path, row("blocked"), 20)).toThrow(); }
  finally { closeSync(lock); }
  expect(readObservations(path).rows.map(r => r.note)).toEqual(["first", "second"]);
  for (const bytes of [first.trimEnd(), first + "{broken}\n", first + '{"note":"untyped"}\n']) {
    writeFileSync(path, bytes);
    expect(() => appendObservation(path, row("third"))).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }
});

test("route resolution uses observed roster tuning before launch tuning and never accepts a preset as evidence", () => {
  const home = join(work, "routes");
  const registry = join(home, "team.json");
  const transcript = join(home, "example.jsonl");
  mkdirSync(home, { recursive: true });
  writeFileSync(transcript, [
    { type: "session_meta", payload: { id: "example-session" } },
    { type: "turn_context", timestamp: "2026-10-20T00:00:00Z", payload: { model: "example-observed", effort: "high" } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "example" }, seats: {
    reader: { harness: "codex", model: "example-launch", harness_session_id: "example-session", transcript_path: transcript, session: "example/reader", index: 1 },
    saved: { harness: "codex", model: "example-saved", session: "example/saved", status: "offline", index: 1 },
  } }));
  writeFileSync(join(home, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { example: { root: home, registry_location: registry } } }));
  const routes = collectCalibrationRoutes({ ...process.env, TAP_INDEX_HOME: home });
  expect(resolveCalibrationRoute("reader", routes)).toBe("codex/example-observed");
  expect(resolveCalibrationRoute("example/reader", routes)).toBe("codex/example-observed");
  expect(resolveCalibrationRoute("codex/example-saved", routes)).toBe("codex/example-saved");
  expect(resolveCalibrationRoute("codex/example-launch", routes)).toBe("codex/example-launch");
  expect(() => resolveCalibrationRoute("codex/example-unseen", routes)).toThrow("unknown_route");
});

test("write hints advise on avoid causes and long notes without refusing valid observations", () => {
  expect(noteHints("Avoid browser tasks")).toHaveLength(1);
  expect(noteHints("Never use for this task because waits looped")).toEqual([]);
  expect(noteHints("Avoid browser tasks: waits looped")).toEqual([]);
  expect(noteHints("Avoid this — loops on stale snapshots")).toEqual([]);
  expect(noteHints("x".repeat(401))).toHaveLength(1);
  expect(noteHints("Never " + "x".repeat(401))).toHaveLength(2);
  expect(row("Never " + "x".repeat(401)).note.length).toBeGreaterThan(400);
});

test("an exact observed route cannot be redirected by a colliding team/handle spelling", () => {
  const routes = { handles: new Map([[route, ["codex/example-other"]]]), observed: new Set([route, "codex/example-other"]), roster: new Set([route]) };
  expect(resolveCalibrationRoute(route, routes)).toBe(route);
});

test("default route render bounds lines and text, shows newest first and labels omitted rows", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`episode ${i}: ` + "observed result ".repeat(20), `2026-10-${String(i + 1).padStart(2, "0")}`));
  const text = renderCalibration(rows, [route], { target: route, now: "2026-10-20" });
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
  expect(text.length).toBeLessThanOrEqual(900);
  expect(text).toContain("observations, not rankings");
  expect(text).toContain("episode 11");
  expect(text).not.toContain("episode 10");
  expect(text.replace(/\s+/g, " ")).toContain(rows[11]!.note);
  expect(text).toContain("older notes:");
  expect(text).toContain("--all");
  expect(text).toContain("example/writer, example-ref");
  const all = renderCalibration(rows, [route], { target: route, all: true, now: "2026-10-20" });
  expect(all).toContain("episode 0");
  expect(all).toContain(rows[0]!.note);
});

test("a sub-400-character observation keeps its advice when the route budget has room", () => {
  const note = "Seen: the example seat kept refining an open-ended quality brief. " + "A bounded deliverable was missing. ".repeat(7) + "Advice: name the deliverable and a concrete stop condition.";
  expect(note.length).toBeLessThan(400);
  const text = renderCalibration([makeObservation({ ...row(note), effort: "xhigh", ref: "example/source, secondary source" })], [route], { target: route, now: "2026-10-20" });
  expect(text.replace(/\s+/g, " ")).toContain(note.trim());
  expect(text).toContain("(1 note, newest");
  expect(text).not.toContain("Clipped notes");
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
  expect(text.length).toBeLessThanOrEqual(900);
});

test("when full observations exceed the route budget, omit older notes before clipping newest text", () => {
  const newest = "Seen: " + "the fake seat completed a bounded task. ".repeat(6) + "Advice: keep the explicit stop condition.";
  const older = "OLDER: " + "older episode conditions and outcome. ".repeat(12);
  const text = renderCalibration([row(older, "2026-10-19"), row(newest)], [route], { target: route, now: "2026-10-20" });
  expect(text.replace(/\s+/g, " ")).toContain(newest.trim());
  expect(text).not.toContain("OLDER:");
  expect(text).toContain("1 older note:");
  expect(text).toContain("--all");
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
});

test("human output keeps attribution and effort but suppresses session IDs and terminal controls", () => {
  const observation = makeObservation({ ...row("Works\nwhen waits are explicit.\x1b[31m"), effort: "high", ref: "019c6e27-e55b-73d1-87d8-4e01f1f75043" });
  const text = renderCalibration([observation], [route], { target: route, now: "2026-10-20" });
  expect(text).toContain("[0d, high]");
  expect(text).toContain("example/writer, session");
  expect(text).not.toContain(observation.ref);
  expect(text).not.toContain("\x1b");
  expect(text).not.toContain('"note"');
});

test("bare digest selects only candidate routes, shows two newest and stays within 25 lines", () => {
  const rows = Array.from({ length: 20 }, (_, i) => makeObservation({ ...row(`note ${i}`), route: `codex/example-${i}` }));
  const candidates = rows.map(r => r.route).concat("codex/example-empty");
  const text = renderCalibration([...rows, row("not a candidate")], candidates, { now: "2026-10-20" });
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
  expect(text).not.toContain("not a candidate");
  expect(text).toContain("routes omitted");
  const small = renderCalibration([row("old", "2026-10-01"), row("middle", "2026-10-02"), row("new", "2026-10-03")], [route, "codex/example-empty"], { now: "2026-10-20" });
  expect(small).toContain("middle");
  expect(small).toContain("new");
  expect(small).not.toContain("] old");
  expect(small).toContain("1 older note: rerun this route with --all");
  expect(small).toContain("no notes");
});

test("gc hint uses strict 90-day and 16-KiB thresholds without removing rows", () => {
  const rows = [row("at boundary", "2026-07-22")];
  expect(gcHint(rows, 16384, "2026-10-20")).toBe("");
  expect(gcHint(rows, 16385, "2026-10-20")).toContain("16 KB");
  expect(gcHint([row("older", "2026-07-21")], 0, "2026-10-20")).toContain("1 note older than 90 days");
  expect(gcHint(rows, 0, "2026-10-21")).toContain("Consider tap help skill calibrate-gc (frontier seat)");
});

test("long metadata, clipped notes and GC footer share the ten-line route budget", () => {
  const route = `codex/example-${"a".repeat(80)}`;
  const rows = Array.from({ length: 10 }, (_, i) => makeObservation({
    at: "2026-10-20", route, by: "example/" + "writer".repeat(15), ref: "example-ref " + "evidence".repeat(15), note: `episode ${i} ` + "result ".repeat(50),
  }));
  const text = renderCalibration(rows, [route], { target: route, now: "2026-10-20", hint: "Consider tap help skill calibrate-gc (frontier seat): store exceeds 16 KB." });
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
  expect(text.length).toBeLessThanOrEqual(900);
  expect(text.trimEnd().split("\n").every(line => line.length <= 88)).toBe(true);
  expect(text).toContain("--all");
});

test("a narrow terminal reserves room for the oversized-note pointer and GC hint", () => {
  const route = `codex/example-${"a".repeat(100)}`;
  const hint = "Consider tap help skill calibrate-gc (frontier seat): store exceeds 16 KB.";
  const text = renderCalibration([makeObservation({ ...row("result ".repeat(100)), route })], [route], { target: route, width: 20, hint });
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
  expect(text).toContain("--all");
  expect(text).toContain(hint);
  expect(text.replace(/\s+/g, " ")).toContain("observations, not rankings");
});

test("multi-megabyte notes yield an expansion pointer within the route budget", () => {
  const observation = row("large ".repeat(3_000_000));
  const text = renderCalibration([observation], [route], { target: route });
  expect(text).toContain("--all");
  expect(text).not.toContain("large");
  expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
});

test("bounded note normalization preserves whitespace and control cleanup", () => {
  const note = "Seen:\x1b\n\t" + " ".repeat(2000) + "a bounded episode.\r Advice: name the stop condition.";
  const text = renderCalibration([row(note)], [route], { target: route });
  expect(text.replace(/\s+/g, " ")).toContain("Seen: a bounded episode. Advice: name the stop condition.");
  expect(text).not.toContain("--all");
});
