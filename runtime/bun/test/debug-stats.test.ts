import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "../src/debug";
import { deliveryStats, renderStats } from "../src/debug-stats";

const NOW = new Date("2026-10-12T12:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function newBus(root: string, name: string): string {
  const bus = join(root, name);
  mkdirSync(join(bus, "receipts"), { recursive: true });
  return bus;
}
function put(bus: string, id: string, suffix: string, fields: Record<string, unknown> = {}, mtime?: string): void {
  const path = join(bus, "receipts", `${id}.${suffix}`);
  writeFileSync(path, JSON.stringify({ id, ...fields }) + "\n");
  if (mtime) utimesSync(path, new Date(mtime), new Date(mtime));
}
const placed = (bus: string, id: string, at: string) => put(bus, id, "placed", { via: "courier", at });
const marker = (bus: string, id: string, n: number, mtime: string) => put(bus, id, `retry-${uuid(n)}.attempted`, { retry: uuid(n), effect: "possible" }, mtime);
function history(bus: string, id: string, rows: Record<string, unknown>[]): void {
  writeFileSync(join(bus, "receipts", `${id}.retries.jsonl`),
    rows.map(row => JSON.stringify({ v: 1, id, ordinal: 1, at: "2026-10-10T00:00:00.000Z", ...row })).join("\n") + "\n");
}
/** Every path with its size and mtime: equal snapshots are the read-only proof. */
function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map(name => {
    const stat = statSync(join(root, name));
    return `${name} ${stat.size} ${stat.mtimeMs}`;
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-"));
  const alpha = newBus(root, "alpha"), beta = newBus(root, "beta");
  placed(alpha, "old1", "2026-10-01T00:00:00Z"); // outside a 7-night window; still in the rolling window
  placed(alpha, "m7", "2026-10-09T00:00:00Z"); // unobserved > 24h
  // 2026-10-10: plain observed; initial unverified + retry observed after the ring; same-second order; forced read.
  placed(alpha, "m1", "2026-10-10T08:00:00Z"); put(alpha, "m1", "attempted"); put(alpha, "m1", "read", { by: "bob", at: "2026-10-10T08:05:00Z" });
  placed(alpha, "m2", "2026-10-10T09:00:00Z"); put(alpha, "m2", "attempted");
  history(alpha, "m2", [{ retry: uuid(1), event: "request", trigger: "explicit" }, { retry: uuid(1), event: "outcome", outcome: "submission-confirmed" }]);
  marker(alpha, "m2", 1, "2026-10-10T09:10:00Z");
  put(alpha, "m2", "read", { by: "bob", at: "2026-10-10T09:20:00Z" });
  placed(alpha, "same", "2026-10-10T12:00:00Z"); put(alpha, "same", "attempted");
  history(alpha, "same", [{ retry: uuid(2), event: "request" }, { retry: uuid(2), event: "outcome", outcome: "unverified" }]);
  marker(alpha, "same", 2, "2026-10-10T12:30:00.500Z");
  put(alpha, "same", "read", { by: "bob", at: "2026-10-10T12:30:00Z" }); // floored to the second: order unknown
  placed(alpha, "m8", "2026-10-10T13:00:00Z"); put(alpha, "m8", "read", { by: "bob", at: "2026-10-10T13:01:00Z", forced: true });
  // 2026-10-11: observed before the ring (known redundant); suppressed request; cancelled.
  placed(alpha, "m3", "2026-10-11T10:00:00Z"); put(alpha, "m3", "attempted"); put(alpha, "m3", "read", { by: "bob", at: "2026-10-11T10:01:00Z" });
  history(alpha, "m3", [{ retry: uuid(3), event: "request" }, { retry: uuid(3), event: "outcome", outcome: "harness-queued" }]);
  marker(alpha, "m3", 3, "2026-10-11T10:30:00Z");
  placed(alpha, "m4", "2026-10-11T11:00:00Z"); put(alpha, "m4", "attempted");
  put(alpha, "m4", "done", { status: "done", by: "bob", via: "reply", at: "2026-10-11T11:05:00Z" });
  history(alpha, "m4", [{ retry: uuid(4), event: "suppressed", prior: { state: "settled", attempts: 1 } }]);
  placed(alpha, "m6", "2026-10-11T00:00:00Z"); put(alpha, "m6", "cancelled", { status: "cancelled" });
  // 2026-10-12 (in progress): a retry that rang first; a loop of three extra rings.
  placed(alpha, "m5", "2026-10-12T11:30:00Z");
  history(alpha, "m5", [{ retry: uuid(5), event: "request" }, { retry: uuid(5), event: "outcome", outcome: "unverified" }]);
  marker(alpha, "m5", 5, "2026-10-12T11:40:00Z");
  placed(alpha, "loop", "2026-10-12T01:00:00Z"); put(alpha, "loop", "attempted");
  for (const n of [6, 7, 8]) marker(alpha, "loop", n, `2026-10-12T0${n - 4}:00:00Z`);
  history(alpha, "loop", [6, 7, 8].flatMap(n => [{ retry: uuid(n), event: "request" }, { retry: uuid(n), event: "outcome", outcome: "unverified" }]));
  // A direct send's and a spool drain's initial exit 5 count; a retry's and a longer id's events do not.
  writeFileSync(join(alpha, "registry-events.log"), [
    "ts=2026-10-10T09:00:01Z actor=ann action=send_submit_unverified handle=bob pane=%1 detail=id=m2 team=t",
    "ts=2026-10-12T11:35:01Z actor=courier action=redelivery_submit_unverified handle=bob pane=%1 detail=id=m5_notice_id=n9 team=t",
    "ts=2026-10-11T10:30:01Z actor=courier action=retry_submit_unverified handle=bob pane=%1 detail=id=m3 team=t",
    "ts=2026-10-10T08:00:01Z actor=ann action=send_submit_unverified handle=bob pane=%1 detail=id=m1x team=t",
  ].join("\n") + "\n");
  // beta has mail but no retry history and no registry-events.log at all; p1 is explicit poll delivery.
  placed(beta, "b1", "2026-10-12T06:00:00Z"); put(beta, "b1", "attempted"); put(beta, "b1", "read", { by: "cat", at: "2026-10-12T06:01:00Z" });
  placed(beta, "p1", "2026-10-12T07:00:00Z"); put(beta, "p1", "sent", { delivery: "poll" });
  put(beta, "bad", "placed", { id: "other", at: "2026-10-12T07:00:00Z" }); // names a different id
  return { root, buses: { [alpha]: "alpha", [beta]: "beta", [join(root, "gone")]: "gone" }, alpha, beta };
}

test("nightly cohorts count placement, observation, unverified sends, retries and extra rings without writing", () => {
  const f = fixture();
  try {
    const before = snapshot(f.root);
    const s = deliveryStats(f.buses, { days: 7, now: NOW, env: { TAP_INDEX_HOME: f.root } });
    expect(snapshot(f.root)).toEqual(before);
    expect(s.as_of).toBe("2026-10-12T12:00:00Z");
    expect(s.buses).toBe(3);
    expect(s.nights.map(n => [n.date, n.placed, n.partial])).toEqual([
      ["2026-10-09", 1, false], ["2026-10-10", 4, false], ["2026-10-11", 3, false], ["2026-10-12", 4, true]]);
    const t = s.total;
    expect(t).toMatchObject({
      placed: 12, cancelled: 1, recipient_observed: 6, initial_unverified: 2,
      retry_requests: 7, retries_suppressed: 1,
      retry_outcomes: { "submission-confirmed": 1, "harness-queued": 1, unverified: 5 },
      retry_unresolved: { pending: 0, queued: 0, unknown: 0, interrupted: 0, consumed: 0 },
      extra_rings: 6, retry_first_rings: 1, known_redundant: 1, redundancy_unknown: 1, first_observed_after_retry: 1,
      unobserved: { under_1h: 1, from_1h_to_24h: 2, over_24h: 2 },
    });
    expect(t.observed_rate).toEqual({ num: 6, den: 11, rate: 6 / 11 });
    expect(t.extra_ring_rate).toEqual({ num: 6, den: 12, rate: 0.5 });
    expect(t.redundant_rate).toMatchObject({ num: 1, den: 6 });
    const tenth = s.nights.find(n => n.date === "2026-10-10")!;
    // m2: rang after an evidenced attempt, observed after the ring — not redundant.
    expect(tenth).toMatchObject({ initial_unverified: 1, extra_rings: 2, known_redundant: 0, redundancy_unknown: 1, first_observed_after_retry: 1 });
    // m3's retry went unverified under its own action: never an initial unverified.
    expect(s.nights.find(n => n.date === "2026-10-11")).toMatchObject({ known_redundant: 1, retries_suppressed: 1, cancelled: 1, initial_unverified: 0 });
    // m5's first ring came from the spool drain and went unverified.
    expect(s.nights.find(n => n.date === "2026-10-12")).toMatchObject({ retry_first_rings: 1, extra_rings: 3, initial_unverified: 1 });
    expect(s.initial_unverified_unavailable).toEqual([{ team: "beta", bus: f.beta }]);
    expect(s.retry_history_malformed).toEqual([]);
    expect(s.loops).toEqual([{ team: "alpha", bus: f.alpha, id: "loop", admitted_retries: 3, date: "2026-10-12" }]);
    expect(s.invalid_placed).toBe(1);
    expect(s.retry_records_unavailable).toEqual([{ team: "beta", bus: f.beta }]);
    expect(s.buses_unreachable).toEqual([{ team: "gone", bus: join(f.root, "gone"), reason: "ENOENT" }]);
    // Rolling: 13 valid placements at any date less one poll delivery; 6 extra rings.
    expect(s.rolling).toMatchObject({ window: 1000, messages: 12, extra_rings: 6, tune: true, since: "2026-10-01T00:00:00Z" });
    const text = renderStats(s);
    for (const line of ["as of 2026-10-12T12:00:00Z", "2026-10-12*", "TUNE (above 1%, provisional heuristic)", "LOOP alpha/loop: 3 admitted retries",
      `beta ${f.beta}: retry records: none on this bus (unavailable before same-id retry)`, "not proof of rescue", "6/11 54.545%", "extra rings / placed: 6/12 = 50.00%",
      `beta ${f.beta}: initial unverified: unavailable (no readable registry-events.log)`,
      "retry outcomes: harness-queued 1, submission-confirmed 1, unverified 5; without an outcome: pending 0, queued 0, unknown 0, interrupted 0, consumed 0"]) expect(text).toContain(line);
    expect(deliveryStats(f.buses, { days: 1, now: NOW, env: { TAP_INDEX_HOME: f.root } }).nights.map(n => n.date)).toEqual(["2026-10-12"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a malformed cancellation stays in the observed denominator", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-"));
  try {
    const bus = newBus(root, "gamma");
    placed(bus, "c1", "2026-10-12T06:00:00Z"); put(bus, "c1", "attempted"); put(bus, "c1", "cancelled", { id: "other", status: "cancelled" });
    placed(bus, "c2", "2026-10-12T06:00:00Z"); put(bus, "c2", "cancelled", { status: "cancelled" });
    const s = deliveryStats({ [bus]: "gamma" }, { days: 1, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(s.total).toMatchObject({ placed: 2, cancelled: 1 });
    expect(s.total.observed_rate).toMatchObject({ num: 0, den: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retry idle-submit licenses are neither extra rings nor invalid attempt markers", () => {
  const f = fixture();
  try {
    const before = deliveryStats(f.buses, { days: 7, now: NOW, env: { TAP_INDEX_HOME: f.root } });
    put(f.alpha, "m2", `retry-${uuid(1)}.idle-submit`, { retry: uuid(1), effect: "possible" });
    put(f.alpha, "m1", `retry-${uuid(2)}.idle-submit`, { id: "other" });
    expect(deliveryStats(f.buses, { days: 7, now: NOW, env: { TAP_INDEX_HOME: f.root } })).toEqual(before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("archived receipts still count in their nights and the rolling cohort", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-archive-"));
  try {
    const bus = newBus(root, "zeta");
    // `tap bus archive` moved a1 (settled in September) to archive/2026-09/receipts/; the helpers write <dir>/receipts.
    const month = newBus(join(bus, "archive"), "2026-09");
    placed(month, "a1", "2026-09-20T10:00:00Z"); put(month, "a1", "attempted");
    put(month, "a1", "read", { by: "bob", at: "2026-09-20T10:05:00Z" });
    put(month, "a1", "done", { status: "done", by: "bob", via: "read", at: "2026-09-20T10:05:00Z" });
    history(month, "a1", [{ retry: uuid(1), event: "request" }, { retry: uuid(1), event: "outcome", outcome: "harness-queued" }]);
    // The license's admitted_at (after the read) wins over its older mtime: a known-redundant ring.
    put(month, "a1", `retry-${uuid(1)}.attempted`, { retry: uuid(1), effect: "possible", admitted_at: "2026-09-20T10:10:00.000Z" }, "2026-09-20T10:01:00Z");
    // An archive interrupted between copy and unlink: a2's .placed is archived, its .read still active.
    placed(month, "a2", "2026-09-21T10:00:00Z"); put(month, "a2", "attempted");
    put(bus, "a2", "read", { by: "bob", at: "2026-09-21T10:01:00Z" });
    placed(bus, "live", "2026-10-12T06:00:00Z"); put(bus, "live", "attempted");
    const before = snapshot(root);
    const s = deliveryStats({ [bus]: "zeta" }, { days: 30, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(snapshot(root)).toEqual(before);
    expect(s.nights.map(n => [n.date, n.placed, n.recipient_observed])).toEqual([["2026-09-20", 1, 1], ["2026-09-21", 1, 1], ["2026-10-12", 1, 0]]);
    expect(s.nights[0]).toMatchObject({ retry_requests: 1, retry_outcomes: { "harness-queued": 1 }, extra_rings: 1, known_redundant: 1 });
    expect(s.retry_records_unavailable).toEqual([]);
    expect(s.rolling).toMatchObject({ messages: 3, extra_rings: 1, since: "2026-09-20T10:00:00Z" });
    expect(s).not.toHaveProperty("receipts_archived");
    expect(renderStats(s)).not.toContain("archived receipts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retry without an outcome is pending, queued, unknown or interrupted; a torn or unreadable history is listed", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-unresolved-"));
  try {
    const bus = newBus(root, "eta");
    mkdirSync(join(bus, "spool"));
    const spoolRow = (id: string, n: number) => writeFileSync(join(bus, "spool", `${id}.meta.json`), JSON.stringify({ retry: uuid(n), retry_ordinal: 1 }));
    const at = "2026-10-12T06:00:00Z", rang = "2026-10-12T06:10:00Z";
    for (const id of ["u1", "u2", "u3", "u4", "u5", "t1", "t2"]) { placed(bus, id, at); put(bus, id, "attempted"); }
    history(bus, "u1", [{ retry: uuid(1), event: "request" }]); marker(bus, "u1", 1, rang); // licensed, no row: unknown
    history(bus, "u2", [{ retry: uuid(2), event: "request" }]); marker(bus, "u2", 2, rang); spoolRow("u2", 2); // pending
    history(bus, "u3", [{ retry: uuid(3), event: "request" }]); spoolRow("u3", 3); // queued
    history(bus, "u4", [{ retry: uuid(4), event: "request" }]); // interrupted
    history(bus, "u5", [{ retry: uuid(5), event: "request" }, { retry: uuid(5), event: "outcome", outcome: "unknown" }]); marker(bus, "u5", 5, rang);
    history(bus, "t1", [{ retry: uuid(6), event: "request" }, { retry: uuid(6), event: "outcome", outcome: "unverified" }]);
    writeFileSync(join(bus, "receipts", "t1.retries.jsonl"), '{"v":1,"id":"t1","retry":"' + uuid(7) + '","ordi', { flag: "a" });
    mkdirSync(join(bus, "receipts", "t2.retries.jsonl")); // exists, cannot be read as a file
    const s = deliveryStats({ [bus]: "eta" }, { days: 1, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(s.total).toMatchObject({
      retry_requests: 6, retry_outcomes: { unknown: 1, unverified: 1 },
      retry_unresolved: { pending: 1, queued: 1, unknown: 1, interrupted: 1 },
    });
    expect([...s.retry_history_malformed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { team: "eta", bus, id: "t1", malformed_lines: 1, unreadable: false },
      { team: "eta", bus, id: "t2", malformed_lines: 0, unreadable: true },
    ]);
    const text = renderStats(s);
    for (const line of ["retry outcomes: unknown 1, unverified 1; without an outcome: pending 1, queued 1, unknown 1, interrupted 1",
      `eta ${bus}: t1 retry history: 1 malformed line(s) skipped; its retry counts are incomplete`,
      `eta ${bus}: t2 retry history unreadable; its retry counts are unavailable`]) expect(text).toContain(line);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only a marker naming its own id counts as a ring; retry evidence without history is listed per message", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-"));
  try {
    const bus = newBus(root, "delta");
    // `h1` has a history file, so the bus-wide check alone would call history available.
    placed(bus, "h1", "2026-10-12T05:00:00Z"); history(bus, "h1", [{ retry: uuid(11), event: "suppressed" }]);
    placed(bus, "v1", "2026-10-12T06:00:00Z"); put(bus, "v1", "attempted");
    marker(bus, "v1", 12, "2026-10-12T06:30:00Z");
    writeFileSync(join(bus, "receipts", `v1.retry-${uuid(13)}.attempted`), "not json\n");
    put(bus, "v1", `retry-${uuid(14)}.attempted`, { id: "other", retry: uuid(14) }, "2026-10-12T06:40:00Z");
    const s = deliveryStats({ [bus]: "delta" }, { days: 1, now: NOW });
    expect(s.total).toMatchObject({ placed: 2, extra_rings: 1 });
    // The rolling tune window applies the same validity rule: only the one valid marker rings.
    expect(s.rolling).toMatchObject({ messages: 2, extra_rings: 1 });
    expect(s.retry_history_malformed).toEqual([{ team: "delta", bus, id: "v1", malformed_lines: 0, unreadable: false, missing: true, invalid_markers: 2 }]);
    expect(renderStats(s)).toContain(`delta ${bus}: v1 retry history missing beside its retry evidence; 2 invalid retry marker(s) not counted; its retry counts are incomplete`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid markers never raise TUNE: 1,000 attempted messages with 11 malformed markers stay at 0 extra rings", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-"));
  try {
    const bus = newBus(root, "eps");
    for (let i = 0; i < 1000; i++) { const id = `r${i}`; placed(bus, id, "2026-10-12T06:00:00Z"); put(bus, id, "attempted"); }
    for (let i = 0; i < 11; i++) writeFileSync(join(bus, "receipts", `r${i}.retry-${uuid(100 + i)}.attempted`), "not json\n");
    const s = deliveryStats({ [bus]: "eps" }, { days: 1, now: NOW });
    expect(s.total.extra_rings).toBe(0);
    expect(s.rolling).toMatchObject({ messages: 1000, extra_rings: 0, tune: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a request whose row a read took is consumed, not interrupted; future-dated placements are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-"));
  try {
    const bus = newBus(root, "zeta");
    placed(bus, "c1", "2026-10-12T06:00:00Z"); put(bus, "c1", "attempted");
    history(bus, "c1", [{ retry: uuid(21), event: "request" }]);
    put(bus, "c1", "read", { by: "bob", at: "2026-10-12T06:10:00Z" });
    placed(bus, "i1", "2026-10-12T06:00:00Z"); put(bus, "i1", "attempted");
    history(bus, "i1", [{ retry: uuid(22), event: "request" }]);
    placed(bus, "f1", "2026-10-13T06:00:00Z"); // after as_of: a sender clock ahead
    const s = deliveryStats({ [bus]: "zeta" }, { days: 2, now: NOW });
    expect(s.total.retry_unresolved).toMatchObject({ consumed: 1, interrupted: 1 });
    expect(s.future_placed).toBe(1);
    expect(s.nights.map(n => n.date)).toEqual(["2026-10-12"]);
    expect(s.rolling.messages).toBe(2);
    expect(renderStats(s)).toContain("skipped 1 .placed receipt(s) dated after 2026-10-12T12:00:00Z");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("send refusals count per night beside the denominator, never inside placed", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-refusals-"));
  try {
    const bus = newBus(root, "theta");
    placed(bus, "x1", "2026-10-12T06:00:00Z"); put(bus, "x1", "attempted"); put(bus, "x1", "read", { by: "bob", at: "2026-10-12T06:01:00Z" });
    const line = (at: string, phase: string) => `${at}\tann\tbob\tt\tno_such_agent\t${phase}\n`;
    const index = join(root, "index"); mkdirSync(index);
    const oldest = join(index, "send-refusals.log.20261010T060000Z-1-a");
    writeFileSync(oldest, line("2026-10-10T05:00:00Z", "pre"));
    writeFileSync(join(index, "send-refusals.log.20261011T060000Z-2-b"), line("2026-10-11T01:00:00Z", "pre") + line("2026-10-11T02:00:00Z", "withdrawn"));
    writeFileSync(join(index, "send-refusals.log"), line("2026-10-12T03:00:00Z", "pre") + "torn\tline\n");
    const env = { TAP_INDEX_HOME: index };
    let s = deliveryStats({ [bus]: "theta" }, { days: 3, now: NOW, env });
    // Nights with only refusals get a row with placed 0; refusals never enter placed or a rate.
    expect(s.nights.map(n => [n.date, n.placed, n.refused_pre, n.refused_withdrawn, n.refusals_incomplete])).toEqual([
      ["2026-10-10", 0, 1, 0, true], ["2026-10-11", 0, 1, 1, false], ["2026-10-12", 1, 1, 0, false]]);
    expect(s.total).toMatchObject({ placed: 1, refused_pre: 3, refused_withdrawn: 1 });
    expect(s.total.observed_rate).toEqual({ num: 1, den: 1, rate: 1 });
    expect(s.total.extra_ring_rate.den).toBe(1);
    expect(s.refusals).toEqual({ available: true, log: join(index, "send-refusals.log"), files: 3, unreadable_files: 0, malformed_lines: 1,
      oldest: "2026-10-10T05:00:00Z", incomplete_before: "2026-10-10T05:00:00Z" });
    let text = renderStats(s);
    expect(text).toContain("send refusals: 3 before placement, 1 withdrawn after placement; never in placed or any rate (3 file(s), 1 malformed line(s) skipped)");
    expect(text).toMatch(/^2026-10-10 .* 1\/0\? /m);
    // Fewer generations than rotation keeps: nothing was pruned, so no night is incomplete.
    rmSync(oldest);
    s = deliveryStats({ [bus]: "theta" }, { days: 3, now: NOW, env });
    expect(s.refusals.incomplete_before).toBeNull();
    expect(s.nights.some(n => n.refusals_incomplete)).toBe(false);
    // No log and no generation: unavailable, not zero.
    s = deliveryStats({ [bus]: "theta" }, { days: 3, now: NOW, env: { TAP_INDEX_HOME: join(root, "empty") } });
    expect(s.refusals.available).toBe(false);
    expect(s.total).toMatchObject({ placed: 1, refused_pre: null, refused_withdrawn: null });
    expect(s.nights.map(n => n.refused_pre)).toEqual([null]);
    text = renderStats(s);
    expect(text).toContain(`send refusals: unavailable (no readable ${join(root, "empty", "send-refusals.log")} or rotated generation`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the rolling window keeps the newest 1,000 pane messages and flags TUNE only above 1%", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-rolling-"));
  try {
    const bus = newBus(root, "bus");
    const at = (i: number) => new Date(NOW.getTime() - (1010 - i) * 60_000).toISOString().replace(/\.000Z$/, "Z");
    for (let i = 0; i < 1010; i++) placed(bus, `r${i}`, at(i));
    // The ten oldest each rang twice; the window excludes them.
    for (let i = 0; i < 10; i++) { put(bus, `r${i}`, "attempted"); marker(bus, `r${i}`, i + 1, at(i)); }
    let s = deliveryStats({ [bus]: "t" }, { days: 1, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(s.rolling).toMatchObject({ messages: 1000, extra_rings: 0, tune: false });
    for (let i = 1000; i < 1010; i++) { put(bus, `r${i}`, "attempted"); marker(bus, `r${i}`, i + 1, at(i)); }
    s = deliveryStats({ [bus]: "t" }, { days: 1, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(s.rolling).toMatchObject({ messages: 1000, extra_rings: 10, tune: false }); // exactly 1%
    put(bus, "r999", "attempted"); marker(bus, "r999", 2000, at(999));
    s = deliveryStats({ [bus]: "t" }, { days: 1, now: NOW, env: { TAP_INDEX_HOME: root } });
    expect(s.rolling).toMatchObject({ messages: 1000, extra_rings: 11, tune: true });
    expect(renderStats(s)).toContain("extra rings 11/1000 = 1.10% TUNE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stats parses --days for stats only", () => {
  expect(parse(["stats"])).toMatchObject({ action: "stats", days: undefined });
  expect(parse(["stats", "--days", "3", "--json"])).toMatchObject({ action: "stats", days: 3, jsonOutput: true });
  expect(parse(["stats", "--da=30"])?.days).toBe(30);
  for (const days of ["0", "366", "1.5", "x"]) expect(() => parse(["stats", "--days", days])).toThrow();
  expect(() => parse(["status", "--days", "3"])).toThrow("--days belongs to tap debug stats");
  expect(() => parse(["stats", "--socket", "/tmp/s"])).toThrow("--socket belongs to tap debug on or trace");
  expect(() => parse(["nope"])).toThrow("'trace', 'stats'");
});

test("tap debug stats --json reads every enrolled bus through the public door and changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-stats-cli-"));
  try {
    const bus = newBus(root, "team-bus"), now = Date.now();
    placed(bus, "c1", new Date(now - 2 * 3_600_000).toISOString()); put(bus, "c1", "attempted");
    put(bus, "c1", "read", { by: "bob", at: new Date(now - 3_600_000).toISOString() });
    placed(bus, "c2", new Date(now - 30 * 60_000).toISOString()); put(bus, "c2", "attempted");
    history(bus, "c2", [{ retry: uuid(1), event: "request" }]);
    marker(bus, "c2", 1, new Date(now - 20 * 60_000).toISOString());
    writeFileSync(join(root, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { registry_location: join(bus, "registry.json") } } }));
    writeFileSync(join(root, "send-refusals.log"), `${new Date(now - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")}\tann\tbob\tt\tno_such_agent\tpre\n`);
    const unrelated = join(root, "unrelated"); mkdirSync(unrelated);
    const before = snapshot(root);
    const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
    const tap = resolve(import.meta.dir, "../../../bin/tap");
    const run = (args: string[]) => spawnSync(tap, ["debug", "stats", ...args], { cwd: unrelated, env, encoding: "utf8" });
    const json = run(["--json"]);
    expect(json.status, json.stderr).toBe(0); expect(json.stderr).toBe("");
    const s = JSON.parse(json.stdout);
    expect(Object.keys(s)).toEqual(expect.arrayContaining(["as_of", "days", "nights", "total", "rolling", "loops", "buses"]));
    // c2: requested and licensed, no outcome and no spool row — unknown, never silently completed.
    expect(s).toMatchObject({ days: 7, buses: 1, total: { placed: 2, recipient_observed: 1, retry_requests: 1, extra_rings: 1,
      retry_unresolved: { pending: 0, queued: 0, unknown: 1, interrupted: 0 }, refused_pre: 1, refused_withdrawn: 0 },
      refusals: { available: true, files: 1 }, initial_unverified_unavailable: [{ team: "t", bus }] });
    const text = run(["--days", "2"]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("last 2 night(s)"); expect(text.stdout).toContain("extra rings / placed: 1/2");
    const usage = run(["--days", "0"]);
    expect(usage.status).toBe(2); expect(usage.stderr).toContain("--days must be between 1 and 365");
    expect(snapshot(root)).toEqual(before);
    writeFileSync(join(root, "global-registry.json"), "invalid");
    const unreadable = run([]);
    expect(unreadable.status).toBe(1); expect(unreadable.stderr).toContain("machine team index is unreadable");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
