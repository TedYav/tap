// tap-p6el — reclaim adoption: the bus-rewrite core (port of
// session/tests/test_seat_adopt.py).
//
// seat-adopt owns ONLY the local-bus payload rewrite half of adoption (the
// registry grant + epoch bump live in tap-register.sh's flocked write, which
// calls this). Every case stages a fake bus dir so the suite never touches a
// live bus. The ratified design (tmp/design/p6el-reclaim-adoption.md §2, §11)
// is the spec.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ADOPTED_HANDLES, MAX_PAYLOADS, adoptReleasedHandle, frontmatter, strandedIds } from "../src/seat-adopt";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); }, 30000);

function bus(): string {
  const b = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-sadopt.")));
  scratch.push(b);
  mkdirSync(join(b, "payloads"), { recursive: true });
  mkdirSync(join(b, "receipts"), { recursive: true });
  return b;
}

function payload(b: string, ident: string, o: { to: string; frm?: string; toTeam?: string | null; reply?: string; body?: string }): string {
  const payloads = join(b, "payloads");
  const lines = ["---", `id: ${ident}`, `from: ${o.frm ?? "sender"}`, `to: ${o.to}`, "kind: discuss", `reply: ${o.reply ?? "expected"}`];
  if (o.toTeam !== undefined && o.toTeam !== null) lines.push(`to_team: ${o.toTeam}`);
  const path = join(payloads, `${ident}.md`);
  lines.push("---", "", o.body ?? "hi");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function settle(b: string, ident: string): void {
  writeFileSync(join(b, "receipts", `${ident}.done`), "{}\n");
}

function field(path: string, key: string): string | null {
  for (const ln of readFileSync(path, "utf8").split("\n")) {
    if (ln.trim() === "---") continue;
    if (ln.startsWith(`${key}:`)) return ln.slice(key.length + 1).trim();
  }
  return null;
}

function adopt(b: string, released: string, successor: string, localTeam: string, kw: { maxPayloads?: number; nowIso?: string } = {}) {
  return adoptReleasedHandle(join(b, "payloads"), join(b, "receipts"), released, successor, localTeam, kw);
}

function stranded(b: string, handle: string, localTeam: string): string[] {
  return strandedIds(join(b, "payloads"), join(b, "receipts"), handle, localTeam);
}

test("caps stay at the contract values", () => {
  expect(MAX_PAYLOADS).toBe(64);
  expect(MAX_ADOPTED_HANDLES).toBe(8);
});

// --- adoption ------------------------------------------------------------------

test("basic adopt rewrites to and stamps forensics", () => {
  const b = bus();
  const p = payload(b, "m1", { to: "fable-2", toTeam: "alpha" });
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual(["m1"]);
  expect(res.count).toBe(1);
  expect(res.remainder).toEqual([]);
  expect(field(p, "to")).toBe("fable"); // routing rewritten
  expect(field(p, "to_adopted_from")).toBe("fable-2"); // forensic (spine #2)
  expect(field(p, "adopted_at")).toBeTruthy(); // timestamp present
  expect(field(p, "id")).toBe("m1"); // id/from untouched
  expect(field(p, "from")).toBe("sender");
  expect(field(p, "reply")).toBe("expected");
});

test("settled payload is not adopted", () => {
  const b = bus();
  const p = payload(b, "done1", { to: "fable-2", toTeam: "alpha" });
  settle(b, "done1");
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual([]);
  expect(res.count).toBe(0);
  expect(field(p, "to")).toBe("fable-2"); // never rewrites settled history
});

test("outbound from-fork is never reassigned", () => {
  const b = bus();
  const p = payload(b, "out1", { to: "someone", frm: "fable-2", toTeam: "alpha" });
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual([]); // only to==fork adopts, never from==fork
  expect(field(p, "to")).toBe("someone");
});

test("foreign to_team is never adopted", () => {
  const b = bus();
  const p = payload(b, "f1", { to: "fable-2", toTeam: "gamma" }); // not local team
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual([]); // 18so: never adopt another team's mail
  expect(field(p, "to")).toBe("fable-2");
});

test("empty to_team is treated as local", () => {
  const b = bus();
  const p = payload(b, "e1", { to: "fable-2", toTeam: null }); // legacy/manual: no to_team
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual(["e1"]);
  expect(field(p, "to")).toBe("fable");
});

test("already-successor is an idempotent skip", () => {
  const b = bus();
  const p = payload(b, "s1", { to: "fable", toTeam: "alpha" }); // already the successor
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual([]); // nothing to do; no double-stamp
  expect(field(p, "to_adopted_from")).toBeNull();
});

test("non-matching handle untouched", () => {
  const b = bus();
  const p = payload(b, "n1", { to: "grok-2", toTeam: "alpha" });
  const res = adopt(b, "fable-2", "fable", "alpha");
  expect(res.adopted_ids).toEqual([]);
  expect(field(p, "to")).toBe("grok-2");
});

test("caps fail closed with a loud remainder, never truncate", () => {
  const b = bus();
  const ids = Array.from({ length: 5 }, (_, i) => `c${i}`);
  for (const i of ids) payload(b, i, { to: "fable-2", toTeam: "alpha" });
  const res = adopt(b, "fable-2", "fable", "alpha", { maxPayloads: 3 });
  // Adopt up to the cap; the overflow is surfaced as remainder, NEVER silently dropped.
  expect(res.count).toBe(3);
  expect(res.adopted_ids.length).toBe(3);
  expect(res.remainder.length).toBe(2);
  expect(new Set([...res.adopted_ids, ...res.remainder])).toEqual(new Set(ids)); // nothing lost
  // Over-cap payloads are NOT rewritten (fail-closed for the overflow).
  for (const rid of res.remainder) {
    expect(field(join(b, "payloads", `${rid}.md`), "to")).toBe("fable-2");
  }
});

test("deterministic claim order", () => {
  const b = bus();
  // Adoption order is stable (id sort) so caps split deterministically.
  for (const i of ["b", "a", "c"]) payload(b, i, { to: "fable-2", toTeam: "alpha" });
  const res = adopt(b, "fable-2", "fable", "alpha", { maxPayloads: 2 });
  expect(res.adopted_ids).toEqual(["a", "b"]);
  expect(res.remainder).toEqual(["c"]);
});

test("multi-payload adoption journals the batch then removes the journal", () => {
  const b = bus();
  for (const i of ["j1", "j2", "j3"]) payload(b, i, { to: "fable-2", toTeam: "alpha" });
  const journal = join(b, "payloads", ".adopt-journal-fable-2");
  const res = adopt(b, "fable-2", "fable", "alpha", { nowIso: "2026-09-20T03:20:00Z" });
  expect(res.count).toBe(3);
  expect(existsSync(journal)).toBe(false); // removed after the rewrites
  expect(field(join(b, "payloads", "j2.md"), "adopted_at")).toBe("2026-09-20T03:20:00Z");
  // A single-payload batch never writes a journal at all.
  const b2 = bus();
  payload(b2, "solo", { to: "k-2", toTeam: "alpha" });
  adopt(b2, "k-2", "k", "alpha");
  expect(existsSync(join(b2, "payloads", ".adopt-journal-k-2"))).toBe(false);
});

// --- tap-q2v4: stranded_ids — the READ-ONLY strand report for team-refresh trim

test("stranded names unsettled team-local inbound", () => {
  const b = bus();
  payload(b, "m1", { to: "fable-2", toTeam: "alpha" });
  expect(stranded(b, "fable-2", "alpha")).toEqual(["m1"]);
});

test("stranded is read-only, never rewrites", () => {
  const b = bus();
  const p = payload(b, "m1", { to: "fable-2", toTeam: "alpha" });
  stranded(b, "fable-2", "alpha");
  expect(field(p, "to")).toBe("fable-2"); // untouched — report never adopts
  expect(field(p, "to_adopted_from")).toBeNull(); // no forensic stamp on a report
});

test("stranded excludes settled", () => {
  const b = bus();
  payload(b, "done1", { to: "fable-2", toTeam: "alpha" });
  settle(b, "done1");
  expect(stranded(b, "fable-2", "alpha")).toEqual([]); // settled mail is not stranded
});

test("stranded excludes outbound from handle", () => {
  const b = bus();
  payload(b, "out1", { to: "someone", frm: "fable-2", toTeam: "alpha" });
  expect(stranded(b, "fable-2", "alpha")).toEqual([]); // from==handle is the sender's, not orphaned inbound
});

test("stranded excludes foreign team", () => {
  const b = bus();
  payload(b, "f1", { to: "fable-2", toTeam: "gamma" });
  expect(stranded(b, "fable-2", "alpha")).toEqual([]); // 18so: another team's mail is not ours to report
});

test("stranded empty to_team is local", () => {
  const b = bus();
  payload(b, "e1", { to: "fable-2", toTeam: null });
  expect(stranded(b, "fable-2", "alpha")).toEqual(["e1"]);
});

test("stranded empty when no inbound", () => {
  const b = bus();
  payload(b, "n1", { to: "grok-2", toTeam: "alpha" });
  expect(stranded(b, "fable-2", "alpha")).toEqual([]);
});

test("stranded is deterministically sorted", () => {
  const b = bus();
  for (const i of ["b", "a", "c"]) payload(b, i, { to: "fable-2", toTeam: "alpha" });
  expect(stranded(b, "fable-2", "alpha")).toEqual(["a", "b", "c"]);
});

// --- CLI door (the transport Bash consumers call) -------------------------------

test("CLI door: caps, stranded, adopt answer JSON", async () => {
  const b = bus();
  payload(b, "m1", { to: "fable-2", toTeam: "alpha" });
  payload(b, "m2", { to: "fable-2", toTeam: "alpha" });
  const entry = join(import.meta.dir, "../src/seat-adopt.ts");
  const args = (a: string[]) => [process.execPath, entry, ...a];
  const caps = Bun.spawnSync(args(["caps"]), { stdout: "pipe" });
  expect(JSON.parse(caps.stdout.toString())).toEqual({ max_adopted_handles: 8, max_payloads: 64 });
  const str = Bun.spawnSync(args(["stranded", join(b, "payloads"), join(b, "receipts"), "fable-2", "alpha"]), { stdout: "pipe" });
  expect(JSON.parse(str.stdout.toString())).toEqual(["m1", "m2"]);
  const ad = Bun.spawnSync(args(["adopt", join(b, "payloads"), join(b, "receipts"), "fable-2", "fable", "alpha"]), { stdout: "pipe" });
  const res = JSON.parse(ad.stdout.toString()) as { count: number };
  expect(res.count).toBe(2);
  const empty = Bun.spawnSync(args(["stranded", join(b, "payloads"), join(b, "receipts"), "fable-2", "alpha"]), { stdout: "pipe" });
  expect(JSON.parse(empty.stdout.toString())).toEqual([]);
  expect(Bun.spawnSync(args(["wat"]), { stdout: "pipe" }).exitCode).toBe(64);
});

test("adoption rewrites only frontmatter bytes: non-UTF-8, NUL, and final-newline state survive", () => {
  const b = bus();
  const payloads = join(b, "payloads"), receipts = join(b, "receipts");
  const path = join(payloads, "m1.md");
  const header = Buffer.from("---\nid: m1\nfrom: sender\nto: fable-2\nto_team: alpha\nkind: discuss\nreply: expected\n---\n", "utf8");
  // NUL + invalid UTF-8 + raw trailing bytes, and NO final newline.
  const body = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x62, 0x79, 0x74, 0x65]);
  writeFileSync(path, Buffer.concat([header, body]));

  const res = adoptReleasedHandle(payloads, receipts, "fable-2", "fable", "alpha", { nowIso: "2026-09-20T00:00:00Z" });
  expect(res.count).toBe(1);

  const after = readFileSync(path);
  const fence = Buffer.from("---\n", "utf8");
  const first = after.indexOf(fence);
  const second = after.indexOf(fence, first + fence.length);
  expect(second).toBeGreaterThan(first);
  // Body bytes are EXACTLY as written — no U+FFFD repair, no added newline.
  expect(after.subarray(second + fence.length).equals(body)).toBe(true);
  // The frontmatter gained only the to-rewrite and the two forensic lines.
  const head = after.subarray(0, second + fence.length).toString("utf8");
  expect(head).toContain("\nto: fable\n");
  expect(head).toContain("\nto_adopted_from: fable-2\n");
  expect(head).toContain("\nadopted_at: 2026-09-20T00:00:00Z\n");
  expect(head).toContain("id: m1\n");
  expect(head).toContain("from: sender\n");
});

// --- one batched adoption call, no kill-after-mutation ---

import { adoptReleasedHandles } from "../src/seat-adopt";

function batch(b: string, handles: string[], successor: string, localTeam: string, kw: { deadlineAtMs?: number; now?: () => number } = {}) {
  return adoptReleasedHandles(join(b, "payloads"), join(b, "receipts"), handles, successor, localTeam, kw);
}

test("batch adopts multiple released handles in one call, results per handle in order", () => {
  const b = bus();
  payload(b, "m1", { to: "fork-a" });
  payload(b, "m2", { to: "fork-a" });
  payload(b, "m3", { to: "fork-b" });
  const res = batch(b, ["fork-a", "fork-b"], "heir", "t");
  expect(Object.keys(res.handles)).toEqual(["fork-a", "fork-b"]);
  expect(res.handles["fork-a"]).toEqual({ adopted_ids: ["m1", "m2"], count: 2, remainder: [] });
  expect(res.handles["fork-b"]).toEqual({ adopted_ids: ["m3"], count: 1, remainder: [] });
  expect(res.skipped).toEqual([]);
  expect(field(join(b, "payloads", "m1.md"), "to")).toBe("heir");
  expect(field(join(b, "payloads", "m3.md"), "to_adopted_from")).toBe("fork-b");
});

test("batch with an expired deadline skips every handle untouched", () => {
  const b = bus();
  const p1 = payload(b, "m1", { to: "fork-a" });
  const before = readFileSync(p1);
  const res = batch(b, ["fork-a", "fork-b"], "heir", "t", { deadlineAtMs: Date.now() - 1000 });
  expect(res.handles).toEqual({});
  expect(res.skipped).toEqual(["fork-a", "fork-b"]);
  expect(readFileSync(p1).equals(before)).toBe(true);
});

test("a started handle completes with its real count even when the budget runs out mid-batch", () => {
  const b = bus();
  payload(b, "m1", { to: "fork-a" });
  payload(b, "m2", { to: "fork-b" });
  // Deterministic clock: the FIRST deadline check is before the boundary
  // (fork-a starts), every later check is past it (fork-b must be skipped,
  // never half-mutated). fork-a's REAL count comes back — not a fabricated 0.
  let calls = 0;
  const deadline = 10_000;
  const res = batch(b, ["fork-a", "fork-b"], "heir", "t", {
    deadlineAtMs: deadline,
    now: () => (calls++ === 0 ? deadline - 1 : deadline + 1),
  });
  expect(Object.keys(res.handles)).toEqual(["fork-a"]);
  expect(res.handles["fork-a"]!.count).toBe(1);
  expect(res.skipped).toEqual(["fork-b"]);
  expect(field(join(b, "payloads", "m1.md"), "to")).toBe("heir");
  expect(field(join(b, "payloads", "m2.md"), "to")).toBe("fork-b");
});

test("a later handle's mid-flight failure isolates: earlier actual results and bytes survive", () => {
  const b = bus();
  const aPath = payload(b, "m1", { to: "fork-a" });
  const bPath = payload(b, "m2", { to: "fork-b" });
  const bBefore = readFileSync(bPath);
  // Deterministic mid-flight throw: fork-a goes through the REAL owner (its
  // rewrite happens and reports its actual count); fork-b's mutation throws
  // after the batch started it. fork-b lands in `failed` — never in handles,
  // never fabricated as count 0.
  const res = adoptReleasedHandles(join(b, "payloads"), join(b, "receipts"), ["fork-a", "fork-b"], "heir", "t", {
    adoptOne: (handle: string) => {
      if (handle === "fork-a") return adoptReleasedHandle(join(b, "payloads"), join(b, "receipts"), handle, "heir", "t");
      throw new Error("rename failed mid-flight");
    },
  });
  expect(Object.keys(res.handles)).toEqual(["fork-a"]);
  expect(res.handles["fork-a"]).toEqual({ adopted_ids: ["m1"], count: 1, remainder: [] });
  expect(res.failed).toEqual(["fork-b"]);
  expect(res.skipped).toEqual([]);
  // fork-a's mutation SURVIVED on disk and reports its actual count.
  expect(field(aPath, "to")).toBe("heir");
  expect(field(aPath, "to_adopted_from")).toBe("fork-a");
  // fork-b's bytes are untouched (its rewrite never happened here).
  expect(readFileSync(bPath).equals(bBefore)).toBe(true);
});

test("CLI adopt-batch prints per-handle results plus skips", async () => {
  const b = bus();
  payload(b, "m1", { to: "fork-a" });
  payload(b, "m2", { to: "fork-b" });
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/seat-adopt.ts"),
    "adopt-batch", join(b, "payloads"), join(b, "receipts"), "heir", "t",
    String(Date.now() + 60_000), "fork-a", "fork-b"], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout.toString()) as { handles: Record<string, { count: number }>; skipped: string[] };
  expect(parsed.handles["fork-a"]!.count).toBe(1);
  expect(parsed.handles["fork-b"]!.count).toBe(1);
  expect(parsed.skipped).toEqual([]);
  const r2 = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/seat-adopt.ts"),
    "adopt-batch", join(b, "payloads"), join(b, "receipts"), "heir", "t", "-", "ghost"],
    { stdout: "pipe", stderr: "pipe" });
  expect(r2.exitCode).toBe(0);
  const p2 = JSON.parse(r2.stdout.toString()) as { handles: Record<string, unknown>; skipped: string[] };
  expect(p2.handles.ghost).toEqual({ adopted_ids: [], count: 0, remainder: [] });
  expect(p2.skipped).toEqual([]);
});

test("a CR-only payload is stranded mail: universal newlines in the shared parser", () => {
  const b = bus();
  writeFileSync(
    join(b, "payloads", "cr1.md"),
    "---\rid: cr1\rfrom: sender\rto: fable-2\rkind: discuss\rreply: expected\rto_team: alpha\r---\rbody\r",
  );
  expect(stranded(b, "fable-2", "alpha")).toEqual(["cr1"]);
});

test("adoption preserves CR-only bytes: only the to: line is rewritten, terminators verbatim", () => {
  const b = bus();
  const p = join(b, "payloads", "cr2.md");
  writeFileSync(
    p,
    "---\rid: cr2\rfrom: sender\rto: fable-2\rkind: discuss\rreply: expected\r---\rbody\r",
  );
  const res = adopt(b, "fable-2", "fable", "alpha", { nowIso: "2026-01-01T00:00:00Z" });
  expect(res.adopted_ids).toEqual(["cr2"]);
  // The to: line keeps its own CR; the injected forensics carry LF exactly as
  // rewriteTo writes them; every other line flows through byte-identical.
  const expected =
    "---\rid: cr2\rfrom: sender\rto: fable\rto_adopted_from: fable-2\nadopted_at: 2026-01-01T00:00:00Z\nkind: discuss\rreply: expected\r---\rbody\r";
  expect(readFileSync(p)).toEqual(Buffer.from(expected, "utf8"));
});

test("a python-only-whitespace fence is eligible AND actually rewritten and stamped (fable r1 N1)", () => {
  const b = bus();
  // \x85 (NEL) ends the fences: python str.strip removes it, JS trim does
  // not — so the payload was counted eligible while rewriteTo never entered
  // the fence region and the to: line survived untouched. The fence must be
  // recognized the same way the parser recognized it.
  const p = join(b, "payloads", "nel1.md");
  writeFileSync(p, "---\x85\nid: nel1\nfrom: sender\nto: fable-2\n---\x85\nbody\n");
  writeFileSync(join(b, "receipts", "nel1.sent"), "{}");
  const res = adopt(b, "fable-2", "fable", "alpha", { nowIso: "2026-01-01T00:00:00Z" });
  expect(res.adopted_ids).toEqual(["nel1"]);
  const expected =
    "---\x85\nid: nel1\nfrom: sender\nto: fable\nto_adopted_from: fable-2\nadopted_at: 2026-01-01T00:00:00Z\n---\x85\nbody\n";
  expect(readFileSync(p)).toEqual(Buffer.from(expected, "utf8"));
});

test("fatal decode inside the fence region escapes; body bytes stay lenient", () => {
  const b = bus();
  // Unterminated frontmatter whose second line carries an invalid byte: the
  // incumbent's whole-file strict read saw every line, so this throws.
  writeFileSync(join(b, "payloads", "badfm.md"), Buffer.of(0x2d, 0x2d, 0x2d, 0x0d, 0xff, 0x0d));
  expect(() => stranded(b, "fable-2", "alpha")).toThrow();
  // A closed fence makes the region end: invalid BODY bytes parse leniently
  // (the byte-preservation contract) and the payload still counts. A fresh
  // bus keeps the unterminated badfm.md out of this scan.
  const b2 = bus();
  writeFileSync(
    join(b2, "payloads", "badbody.md"),
    Buffer.concat([
      Buffer.from("---\nid: badbody\nfrom: sender\nto: fable-2\nto_team: alpha\n---\n", "utf8"),
      Buffer.of(0xff),
      Buffer.from("\n", "utf8"),
    ]),
  );
  expect(stranded(b2, "fable-2", "alpha")).toEqual(["badbody"]);
});

test("a UTF-8 BOM before the opening fence keeps the payload rejected: python preserves U+FEFF", () => {
  const b = bus();
  writeFileSync(
    join(b, "payloads", "bom.md"),
    Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from("---\nid: bom\nfrom: sender\nto: fable-2\nto_team: alpha\n---\nbody\n", "utf8")]),
  );
  // The strict decoder must NOT swallow the BOM: the opening line is
  // "\ufeff---", which is not the fence, exactly like python's utf-8 codec.
  expect(stranded(b, "fable-2", "alpha")).toEqual([]);
  expect(frontmatter(join(b, "payloads", "bom.md")).fields).toBeNull();
});
