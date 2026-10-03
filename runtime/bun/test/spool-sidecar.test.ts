// The entry sidecar, with explicit expected outcomes. The differential against
// the pinned incumbent is the port's evidence and lives in the PR; this file is
// what the behavior is, stated once, for the next reader.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ClaimResult, bumpAttempts, claimAcquire, claimObserve, claimRelease, claimReleaseUnconditionally, metaField, removeEntry, reapStaleSidecars } from "../src/spool-sidecar";
import { KERNEL_LOCK, acquireObligationLock, acquirePathLock, kernelLockArgs } from "../src/panelock";
import { unverifiedCanonical } from "../src/delivery-custody";

/**
 * A REAL holder: the kernel lock helper owning `lockPath` in its own process,
 * running `script` under it. `held` is touched the moment the lock is owned so
 * a test can wait for "held" instead of guessing; under load, a sleep is a
 * race. The returned process is the child this test started and stops.
 */
function realHolder(lockPath: string, script: string): { proc: ReturnType<typeof Bun.spawn>; held: string } {
  const held = `${lockPath}.held`;
  const proc = Bun.spawn([KERNEL_LOCK, ...kernelLockArgs(lockPath, 30_000, ["sh", "-c", `touch "$0"; ${script}`, held])], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 5000;
  while (!existsSync(held)) {
    if (Date.now() > deadline) { proc.kill(); throw new Error(`holder never took ${lockPath}`); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return { proc, held };
}

function scratch(): { root: string; spool: string; payloads: string } {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "sidecar-"));
  const spool = join(root, "spool");
  const payloads = join(root, "payloads");
  mkdirSync(spool, { recursive: true });
  mkdirSync(payloads, { recursive: true });
  return { root, spool, payloads };
}

function seedMeta(spool: string, id: string, row: Record<string, unknown>): void {
  writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify(row, null, 2) + "\n");
}

/**
 * Seed from RAW TEXT when float-ness is the subject. `JSON.stringify` emits `2`
 * for `2.0`, so an object literal cannot express the input these cases are
 * about — an earlier version of this file seeded that way and tested integer
 * round-tripping under a float's name.
 */
function seedRaw(spool: string, id: string, text: string): void {
  writeFileSync(join(spool, `${id}.meta.json`), text);
}

function age(path: string, seconds: number): void {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(path, when, when);
}

test("a field reads as the incumbent's `print(.get(key) or \"\")` did", () => {
  const { root, spool } = scratch();
  try {
    seedRaw(spool, "x", '{\n  "id": "x",\n  "reason": "busy",\n  "attempts": 0,\n  "empty": "",\n  "off": false,\n  "nil": null,\n  "yes": true,\n  "whole": 2.0,\n  "frac": 1.5\n}\n');
    expect(metaField(spool, "x", "reason")).toBe("busy");
    // Every falsy shape collapses to "", exactly as `or ""` does — a caller
    // cannot distinguish absent from zero, and never could.
    for (const key of ["attempts", "empty", "off", "nil", "absent"]) expect(metaField(spool, "x", key)).toBe("");
    // Python renders these, and JSON does not: `True`, and a float's `.0`.
    expect(metaField(spool, "x", "yes")).toBe("True");
    expect(metaField(spool, "x", "whole")).toBe("2.0");
    expect(metaField(spool, "x", "frac")).toBe("1.5");
    expect(metaField(spool, "x", "gone")).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Python-falsy floats and empty containers read as empty, and a big integer keeps its digits", () => {
  // `escalated_at: 0.0` read as "0.0" would skip an escalation the incumbent
  // performs (lib.sh's `[ -n "$escalated" ]`); the incumbent's `or ""` sees a
  // falsy float. Empty containers are falsy for the same reason.
  const { root, spool } = scratch();
  try {
    seedRaw(spool, "x", '{"zero": 0.0, "negative": -0.0, "array": [], "object": {}, "big": 12345678901234567890, "one": 1.0, "some": [1]}\n');
    for (const key of ["zero", "negative", "array", "object"]) expect(metaField(spool, "x", key)).toBe("");
    expect(metaField(spool, "x", "big")).toBe("12345678901234567890");
    expect(metaField(spool, "x", "one")).toBe("1.0");
    expect(metaField(spool, "x", "some")).toBe("[1]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bump preserves a `__proto__` key and a carried string equal to a float marker — byte for byte", () => {
  // Both were lost by the text-substitution serializer: the first vanished when
  // sorted keys were assigned into a fresh object, the second collided with the
  // nested float token and was refused (partner review S2/S3). The renderer has
  // no markers and builds no objects, so there is nothing to collide or vanish.
  const { root, spool } = scratch();
  try {
    seedRaw(spool, "p", '{"attempts":0,"first_spooled":{"__proto__":{"kept":"yes"},"normal":2}}');
    bumpAttempts(spool, "p");
    expect(readFileSync(join(spool, "p.meta.json"), "utf8"))
      .toBe('{\n  "attempts": 1,\n  "first_spooled": {\n    "__proto__": {\n      "kept": "yes"\n    },\n    "normal": 2\n  }\n}');
    seedRaw(spool, "q", '{"attempts":0,"first_spooled":[2.0,"\\u0000float#0\\u0000"],"big":12345678901234567890,"del":"a\\u007fb"}');
    bumpAttempts(spool, "q");
    expect(readFileSync(join(spool, "q.meta.json"), "utf8"))
      .toBe('{\n  "attempts": 1,\n  "big": 12345678901234567890,\n  "del": "a\\u007fb",\n  "first_spooled": [\n    2.0,\n    "\\u0000float#0\\u0000"\n  ]\n}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable or absent sidecar reads as empty, never as an error", () => {
  const { root, spool } = scratch();
  try {
    expect(metaField(spool, "missing", "reason")).toBe("");
    writeFileSync(join(spool, "x.meta.json"), "not json");
    expect(metaField(spool, "x", "reason")).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bumping preserves float-ness and writes no trailing newline", () => {
  const { root, spool } = scratch();
  try {
    seedRaw(spool, "x", '{\n  "attempts": 2,\n  "id": "x",\n  "next_probe_epoch": 1789458205.0\n}');
    bumpAttempts(spool, "x");
    const bytes = readFileSync(join(spool, "x.meta.json"), "utf8");
    expect(JSON.parse(bytes).attempts).toBe(3);
    // A whole-number float keeps its `.0`: a JSON round-trip through
    // JSON.parse/stringify would silently retype the field on every attempt.
    expect(bytes).toContain('"next_probe_epoch": 1789458205.0');
    // This writer omits the trailing newline the publication writer emits.
    expect(bytes.endsWith("}")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a float inside a container survives a bump byte-identically", () => {
  const { root, spool } = scratch();
  try {
    // RAW TEXT: a fractional float in a nested object, a whole float in a
    // nested array. The first version of the writer marked floats at every
    // depth on the way in and substituted them only at the root on the way
    // out, so this came back as `"at": {"value": 1789458205.5}` and `[2]`.
    const seed = '{\n  "attempts": 0,\n  "history": [\n    {\n      "at": 1789458205.5\n    }\n  ],\n  "whole": [\n    2.0\n  ]\n}';
    seedRaw(spool, "x", seed);
    bumpAttempts(spool, "x");
    expect(readFileSync(join(spool, "x.meta.json"), "utf8")).toBe(seed.replace('"attempts": 0', '"attempts": 1'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Q6: a sidecar that is one scalar is not bumped and not replaced — Python's `.get` raised before any write", () => {
  const { root, spool } = scratch();
  try {
    for (const scalar of ["1.0", "NaN", "12345678901234567890"]) {
      seedRaw(spool, "x", scalar);
      const before = statSync(join(spool, "x.meta.json")).ino;
      bumpAttempts(spool, "x");
      // The same inode: no tmp+rename happened. Bytes alone cannot tell, since
      // the wrapper would serialize back to its own token.
      expect(statSync(join(spool, "x.meta.json")).ino).toBe(before);
      expect(readFileSync(join(spool, "x.meta.json"), "utf8")).toBe(scalar);
      expect(existsSync(join(spool, "x.meta.json.tmp"))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nested object keys are sorted on the way through, as Python's sort_keys is recursive", () => {
  const { root, spool } = scratch();
  try {
    seedRaw(spool, "x", '{\n  "attempts": 0,\n  "nest": {\n    "z": 1,\n    "a": 2.0\n  }\n}');
    bumpAttempts(spool, "x");
    expect(readFileSync(join(spool, "x.meta.json"), "utf8")).toBe('{\n  "attempts": 1,\n  "nest": {\n    "a": 2.0,\n    "z": 1\n  }\n}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a junk or string counter still advances", () => {
  const { root, spool } = scratch();
  try {
    seedMeta(spool, "x", { id: "x", attempts: "3" });
    bumpAttempts(spool, "x");
    expect(JSON.parse(readFileSync(join(spool, "x.meta.json"), "utf8")).attempts).toBe(4);
    seedMeta(spool, "x", { id: "x", attempts: "many" });
    bumpAttempts(spool, "x");
    expect(JSON.parse(readFileSync(join(spool, "x.meta.json"), "utf8")).attempts).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bumping a missing or unparseable sidecar changes nothing and does not throw", () => {
  const { root, spool } = scratch();
  try {
    bumpAttempts(spool, "gone");
    expect(existsSync(join(spool, "gone.meta.json"))).toBe(false);
    writeFileSync(join(spool, "x.meta.json"), "not json");
    bumpAttempts(spool, "x");
    expect(readFileSync(join(spool, "x.meta.json"), "utf8")).toBe("not json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a claim is exclusive, and a reader never steals a live one", () => {
  const { root, spool } = scratch();
  try {
    const first = claimAcquire(spool, "x");
    expect(first.status).toBe("acquired");
    expect(claimAcquire(spool, "x").status).toBe("held");
    // The stored record is the incumbent's, spaced separators included.
    const body = readFileSync(join(spool, "x.claim"), "utf8");
    expect(body).toContain('{"v": 1, "id": "x", "owner_pid": ');
    expect(body.endsWith("}\n")).toBe(true);
    expect(claimRelease(spool, "x", tokenOf(first))).toBe(true);
    expect(existsSync(join(spool, "x.claim"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale claim is stolen once; no-steal refuses it", () => {
  const { root, spool } = scratch();
  try {
    writeFileSync(join(spool, "x.claim"), "{}\n");
    age(join(spool, "x.claim"), 4000);
    // A reader wants to look, not to take: the holder may be mid-transfer.
    expect(claimAcquire(spool, "x", true).status).toBe("held");
    expect(claimAcquire(spool, "x", false).status).toBe("acquired");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a malformed staleness knob refuses rather than inventing a default", () => {
  const { root, spool } = scratch();
  try {
    // The incumbent's `int()` raises and takes the program down; a silent
    // fallback here would be a horizon the operator did not ask for.
    expect(() => claimAcquire(spool, "x", false, { ...process.env, TAP_SPOOL_CLAIM_STALE_SECONDS: "soon" })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an observation recognizes only the minted claim shape", () => {
  const { root, spool } = scratch();
  try {
    expect(claimObserve(spool, "x")).toBe("free");
    const minted = (pid: unknown, epoch: unknown, id = "x") => JSON.stringify({ v: 1, id, owner_pid: pid, claimed_at_epoch: epoch }) + "\n";
    // Anything short of the minted shape is broken evidence, not a live
    // holder: a reader that waits on it would be waiting on nothing.
    const broken: Array<[string, string]> = [
      ["incomplete v+id only", '{"v": 1, "id": "x"}'],
      ["owner_pid missing", '{"v": 1, "id": "x", "claimed_at_epoch": 1}'],
      ["owner_pid non-numeric", '{"v": 1, "id": "x", "owner_pid": "4242", "claimed_at_epoch": 1}'],
      ["owner_pid non-positive", '{"v": 1, "id": "x", "owner_pid": 0, "claimed_at_epoch": 1}'],
      ["claimed_at_epoch missing", '{"v": 1, "id": "x", "owner_pid": 4242}'],
      ["claimed_at_epoch non-numeric", '{"v": 1, "id": "x", "owner_pid": 4242, "claimed_at_epoch": "soon"}'],
      ["wrong id", minted(4242, 1, "y")],
    ];
    for (const [why, body] of broken) {
      writeFileSync(join(spool, "x.claim"), body);
      expect(claimObserve(spool, "x"), why).toBe("invalid");
    }
    rmSync(join(spool, "x.claim"));
    mkdirSync(join(spool, "x.claim"));
    expect(claimObserve(spool, "x")).toBe("invalid");
    rmSync(join(spool, "x.claim"), { recursive: true });
    // A symlink alias pointing at a real claim is still not a regular claim
    // file — observation classifies the name, not the target.
    writeFileSync(join(spool, "real.claim"), minted(4242, Date.now()));
    symlinkSync(join(spool, "real.claim"), join(spool, "x.claim"));
    expect(claimObserve(spool, "x")).toBe("invalid");
    rmSync(join(spool, "x.claim"));
    // The minted shape itself: held while fresh, stale past the horizon.
    writeFileSync(join(spool, "x.claim"), minted(4242, Date.now()));
    expect(claimObserve(spool, "x")).toBe("held");
    age(join(spool, "x.claim"), 4000);
    expect(claimObserve(spool, "x")).toBe("stale");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removal takes payload, metadata and lease together, and archives the metadata", () => {
  const { root, spool } = scratch();
  try {
    seedMeta(spool, "x", { id: "x", reason: "busy" });
    writeFileSync(join(spool, "x.md"), "body\n");
    writeFileSync(join(spool, "x.meta.json.reown"), "token");
    removeEntry(spool, "x");
    for (const name of ["x.md", "x.meta.json", "x.meta.json.reown"]) expect(existsSync(join(spool, name))).toBe(false);
    // The archived copy is what a later forensic read has left.
    expect(JSON.parse(readFileSync(join(root, "archive", "x.meta.json"), "utf8")).reason).toBe("busy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removal WAITS for a live holder, and the lease that holder writes is unlinked too", async () => {
  // The re-own race, with a real holder: it owns the meta lock, has already
  // checked the payload, and writes its `.reown` lease just before releasing.
  // Removal must block behind it and then take the fresh lease with the rest
  // — never run unlocked beside it (partner review S1, Codex thread 1).
  const { root, spool } = scratch();
  const lockPath = join(spool, "x.meta.json.lock");
  let holder: ReturnType<typeof realHolder> | null = null;
  try {
    seedMeta(spool, "x", { id: "x" });
    writeFileSync(join(spool, "x.md"), "body\n");
    holder = realHolder(lockPath, `sleep 0.4; touch "${join(spool, "x.meta.json.reown")}"`);
    const started = Date.now();
    removeEntry(spool, "x");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(existsSync(join(spool, "x.md"))).toBe(false);
    expect(existsSync(join(spool, "x.meta.json"))).toBe(false);
    expect(existsSync(join(spool, "x.meta.json.reown"))).toBe(false);
    // The archive is written under the lock, as the incumbent wrote it.
    expect(JSON.parse(readFileSync(join(root, "archive", "x.meta.json"), "utf8")).id).toBe("x");
    await holder.proc.exited;
  } finally { holder?.proc.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("a removal whose wait elapses REFUSES and retains all three files — there is no unlocked branch", () => {
  // The production wait is a day; this arm shortens it to prove which branch a
  // still-held lock reaches. Re-adding `catch { lock = null }` around the
  // acquire, or unlinking on a null lock, reds this arm.
  const { root, spool } = scratch();
  const lockPath = join(spool, "x.meta.json.lock");
  let holder: ReturnType<typeof realHolder> | null = null;
  try {
    seedMeta(spool, "x", { id: "x" });
    writeFileSync(join(spool, "x.md"), "body\n");
    writeFileSync(join(spool, "x.meta.json.reown"), "{}\n");
    holder = realHolder(lockPath, "sleep 30");
    expect(() => removeEntry(spool, "x", { ...process.env }, 50)).toThrow(/still held/);
    for (const name of ["x.md", "x.meta.json", "x.meta.json.reown"]) expect(existsSync(join(spool, name))).toBe(true);
    expect(existsSync(join(root, "archive", "x.meta.json"))).toBe(false);
  } finally { holder?.proc.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("a lock path that fails to open for any reason but ENAMETOOLONG is a refusal, not an unlocked removal", () => {
  // EACCES on the lock path can be an existing HELD lock whose mode changed;
  // treating a generic open failure as "no lock can exist" would be the
  // unlocked fallback wearing a probe's clothes.
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores directory modes; no EACCES to construct
  const { root, spool } = scratch();
  try {
    seedMeta(spool, "x", { id: "x" });
    writeFileSync(join(spool, "x.md"), "body\n");
    chmodSync(spool, 0o500);
    try {
      expect(() => removeEntry(spool, "x")).toThrow(/EACCES/);
    } finally { chmodSync(spool, 0o700); }
    expect(existsSync(join(spool, "x.md"))).toBe(true);
    expect(existsSync(join(spool, "x.meta.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a 245-byte id — whose lock name cannot exist — is removed in milliseconds, not a timeout", () => {
  const { root, spool } = scratch();
  try {
    // `x`*245 + `.meta.json` is 255 bytes and fits; + `.lock` is 260 and does not.
    // The incumbent's open() raised ENAMETOOLONG and fell through to the
    // unconditional unlink at once. A bounded acquire on that path would burn
    // its whole timeout waiting for a marker the kernel helper can never write.
    const id = "x".repeat(245);
    seedMeta(spool, id, { id });
    writeFileSync(join(spool, `${id}.md`), "body\n");
    const started = Date.now();
    removeEntry(spool, id, { ...process.env }, 5000);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(join(spool, `${id}.md`))).toBe(false);
    expect(existsSync(join(spool, `${id}.meta.json`))).toBe(false);
    expect(existsSync(join(root, "archive", `${id}.meta.json`))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the reaper takes inert sidecars and leaves fresh ones", () => {
  const { root, spool, payloads } = scratch();
  try {
    seedMeta(spool, "x", { id: "x" });
    writeFileSync(join(spool, "x.md"), "body\n");
    for (const [name, seconds] of [["x.claim", 4000], ["x.meta.json.lock", 4000], ["y.claim", 5]] as const) {
      writeFileSync(join(spool, name), "{}");
      age(join(spool, name), seconds);
    }
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, "x.claim"))).toBe(false);
    expect(existsSync(join(spool, "x.meta.json.lock"))).toBe(false);
    expect(existsSync(join(spool, "y.claim"))).toBe(true);
    // The entry itself is untouched: the sweep is for sidecars, not mail.
    expect(existsSync(join(spool, "x.md"))).toBe(true);
    expect(existsSync(join(spool, "x.meta.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orphan recovery preserves unknown delivery evidence; live sidecars stay owned", () => {
  const { root, spool, payloads } = scratch();
  try {
    // Canonical present, nothing queued, no claim: a crashed post-submit
    // cleanup, not a second delivery obligation.
    seedMeta(spool, "x", { id: "x" });
    const before = readFileSync(join(spool, "x.meta.json"));
    writeFileSync(join(payloads, "x.md"), "body\n");
    expect(unverifiedCanonical(root, "x")).toBe(true);
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, "x.meta.json"))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(root, "receipts", "x.unconfirmed"), "utf8"));
    expect(receipt.status).toBe("unconfirmed");
    expect(receipt.effect).toBe("possible");
    expect(Buffer.from(receipt.spool_metadata_base64, "base64")).toEqual(before);
    expect(readFileSync(join(root, "archive", "x.meta.json"))).toEqual(before);
    expect(readFileSync(join(payloads, "x.md"), "utf8")).toBe("body\n");
    expect(existsSync(join(spool, "x.md"))).toBe(false);
    expect(unverifiedCanonical(root, "x")).toBe(true);

    // Still queued: the entry is live and the sweep must not touch it.
    seedMeta(spool, "y", { id: "y" });
    writeFileSync(join(spool, "y.md"), "body\n");
    writeFileSync(join(payloads, "y.md"), "body\n");
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, "y.meta.json"))).toBe(true);

    // Claimed: a redelivery owns the brief spool -> canonical move.
    seedMeta(spool, "z", { id: "z" });
    writeFileSync(join(payloads, "z.md"), "body\n");
    writeFileSync(join(spool, "z.claim"), "{}");
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, "z.meta.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orphan recovery keeps metadata on publication failure or held obligation/reset custody", () => {
  const { root, spool, payloads } = scratch();
  const env = { ...process.env, TAP_LOCK_DIR: join(root, "locks") };
  try {
    seedMeta(spool, "x", { id: "x", attempts: 62 });
    writeFileSync(join(payloads, "x.md"), "body\n");
    for (const acquire of [() => acquireObligationLock("x", 0, env), () => acquirePathLock(join(root, "reset.fence.json.lock"), 0, env)]) {
      const lock = acquire();
      expect(lock).not.toBeNull();
      try { reapStaleSidecars(spool, payloads, env); }
      finally { lock!.release(); }
      expect(existsSync(join(spool, "x.meta.json"))).toBe(true);
      expect(existsSync(join(root, "receipts", "x.unconfirmed"))).toBe(false);
    }
    mkdirSync(join(root, "receipts", "x.unconfirmed"), { recursive: true });
    reapStaleSidecars(spool, payloads, env);
    expect(existsSync(join(spool, "x.meta.json"))).toBe(true);
    expect(readFileSync(join(payloads, "x.md"), "utf8")).toBe("body\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("positive delivery receipts retire stale metadata without inventing unconfirmed delivery", () => {
  const { root, spool, payloads } = scratch();
  try {
    mkdirSync(join(root, "receipts"));
    for (const suffix of ["sent", "read", "done", "cancelled", "harness-queued"]) {
      seedMeta(spool, suffix, { id: suffix });
      writeFileSync(join(payloads, `${suffix}.md`), "body\n");
      writeFileSync(join(root, "receipts", `${suffix}.${suffix}`), "{}\n");
      expect(unverifiedCanonical(root, suffix)).toBe(false);
      reapStaleSidecars(spool, payloads);
      expect(existsSync(join(spool, `${suffix}.meta.json`))).toBe(false);
      expect(existsSync(join(root, "receipts", `${suffix}.unconfirmed`))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("attempt evidence lifts the repark shield: the sweep surfaces a possibly-attempted body", () => {
  const { root, spool, payloads } = scratch();
  try {
    mkdirSync(join(root, "receipts"), { recursive: true });
    seedMeta(spool, "r", { id: "r", repark_pending: "2026-09-24T00:00:00Z" });
    writeFileSync(join(payloads, "r.md"), "body\n");
    writeFileSync(join(root, "receipts", "r.attempted"), "{}");
    expect(unverifiedCanonical(root, "r")).toBe(true);
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(root, "receipts", "r.unconfirmed"))).toBe(true);
    expect(existsSync(join(spool, "r.meta.json"))).toBe(false);
    expect(existsSync(join(payloads, "r.md"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repark the drain could not perform is not an orphan: its metadata survives the sweep (tap-conft)", () => {
  const { root, spool, payloads } = scratch();
  try {
    // The same files as a crashed post-submit cleanup, but marked: its waiter is moving the body back.
    seedMeta(spool, "r", { id: "r", repark_pending: "2026-09-23T21:54:59Z" });
    writeFileSync(join(payloads, "r.md"), "body\n");
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, "r.meta.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the stale-lock sweep skips live holders without paying a handshake per lock", () => {
  // Twenty stale locks, ten owned by real holders. The incumbent's in-process
  // LOCK_NB probe made this a ~200 ms sweep; probing each with the holding
  // primitive cost ~100 ms per HELD lock (partner review S5, Codex thread 2).
  // Held locks survive, unheld ones go, and the whole sweep stays far under
  // ten of those allowances. A `-t 1` in the helper loop reds this arm.
  const { root, spool, payloads } = scratch();
  const holders: Array<ReturnType<typeof realHolder>> = [];
  try {
    for (let i = 0; i < 20; i++) {
      const path = join(spool, `id${i}.meta.json.lock`);
      writeFileSync(path, "");
      age(path, 3600);
    }
    for (let i = 0; i < 10; i++) holders.push(realHolder(join(spool, `id${i}.meta.json.lock`), "sleep 30"));
    const started = Date.now();
    reapStaleSidecars(spool, payloads, { ...process.env, TAP_SPOOL_CLAIM_STALE_SECONDS: "300" });
    const wall = Date.now() - started;
    const left = readdirSync(spool).filter(name => name.endsWith(".meta.json.lock")).sort();
    expect(left).toEqual(Array.from({ length: 10 }, (_, i) => `id${i}.meta.json.lock`).sort());
    expect(wall).toBeLessThan(2000);
  } finally { for (const h of holders) h.proc.kill(); rmSync(root, { recursive: true, force: true }); }
});

// tap-e5a3q: every destroyer of `<id>.claim` runs under one spool-wide mutex and re-derives identity under
// it. The hooks fire in the two windows the mutex has to close.
/** The token of a claim the test expects to have acquired. */
function tokenOf(result: ClaimResult): string {
  if (result.status !== "acquired") throw new Error("expected an acquired claim");
  return result.token;
}

const YBODY = '{"v": 1, "id": "x", "owner_pid": 1, "claimed_at_epoch": 1, "who": "Y"}\n';

/** Replace the claim at `path` with a different file (new inode, fresh mtime), as a release plus a fresh `wx` would. */
function swapClaim(path: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, YBODY, { flag: "wx" });
}

test("a steal skips a claim that was swapped between the staleness decision and the mutex", () => {
  const { root, spool } = scratch();
  try {
    const path = join(spool, "x.claim");
    writeFileSync(path, "{}\n");
    age(path, 4000);
    expect(claimAcquire(spool, "x", false, process.env, { afterObserve: () => swapClaim(path) }).status).toBe("held");
    expect(readFileSync(path, "utf8")).toBe(YBODY);
    // Y is a live holder: nobody else may take it.
    expect(claimAcquire(spool, "x").status).toBe("held");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reap skips a claim that was swapped between the staleness decision and the mutex", () => {
  const { root, spool, payloads } = scratch();
  try {
    const path = join(spool, "x.claim");
    writeFileSync(path, "{}\n");
    age(path, 4000);
    reapStaleSidecars(spool, payloads, process.env, undefined, { afterObserve: () => swapClaim(path) });
    expect(readFileSync(path, "utf8")).toBe(YBODY);
    expect(claimAcquire(spool, "x").status).toBe("held");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reaper's unlink window admits no release-then-create: release runs inside the mutex", () => {
  const { root, spool, payloads } = scratch();
  try {
    const path = join(spool, "x.claim");
    const x = claimAcquire(spool, "x");
    age(path, 4000);
    let yCreated: boolean | undefined;
    reapStaleSidecars(spool, payloads, process.env, undefined, {
      underMutex: () => {
        // The holder's release, then a claimant's create, both inside the reaper's lstat-to-unlink window.
        claimRelease(spool, "x", tokenOf(x));
        try { writeFileSync(path, YBODY, { flag: "wx" }); yCreated = true; } catch { yCreated = false; }
      },
    });
    // Outside the mutex the release removes X and Y is created, then the reaper unlinks Y: two holders.
    expect(yCreated).toBe(false);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a release that cannot take the mutex leaves the claim and does not throw", () => {
  const { root, spool } = scratch();
  try {
    const x = claimAcquire(spool, "x");
    const lock = acquirePathLock(join(spool, ".claim.lock"), 1000, process.env);
    if (!lock) throw new Error("test could not take the claim mutex");
    try {
      expect(() => claimRelease(spool, "x", tokenOf(x))).not.toThrow();
      expect(existsSync(join(spool, "x.claim"))).toBe(true);
    } finally { lock.release(); }
    claimRelease(spool, "x", tokenOf(x));
    expect(existsSync(join(spool, "x.claim"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a release with nothing to remove neither locks nor creates the spool directory", () => {
  const { root } = scratch();
  try {
    const nowhere = join(root, "no-such-spool");
    expect(() => claimRelease(nowhere, "x", "any-token")).not.toThrow();
    expect(existsSync(nowhere)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reap held off by the mutex skips the stale claim at zero wait", () => {
  const { root, spool, payloads } = scratch();
  try {
    const path = join(spool, "x.claim");
    writeFileSync(path, "{}\n");
    age(path, 4000);
    const lock = acquirePathLock(join(spool, ".claim.lock"), 1000, process.env);
    if (!lock) throw new Error("test could not take the claim mutex");
    try {
      const start = Date.now();
      reapStaleSidecars(spool, payloads);
      expect(Date.now() - start).toBeLessThan(200);
      expect(existsSync(path)).toBe(true);
    } finally { lock.release(); }
    reapStaleSidecars(spool, payloads);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the claim mutex file survives a reap sweep and is not mistaken for a sidecar", () => {
  const { root, spool, payloads } = scratch();
  try {
    claimRelease(spool, "x", tokenOf(claimAcquire(spool, "x")));
    age(join(spool, ".claim.lock"), 4000);
    reapStaleSidecars(spool, payloads);
    expect(existsSync(join(spool, ".claim.lock"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// tap-scfhv: a claim carries a nonce and release unlinks only a claim carrying the caller's token, so a slow
// holder whose claim was stolen cannot remove the stealer's.
test("a late release by a holder whose claim was stolen leaves the stealer's claim", () => {
  const { root, spool } = scratch();
  try {
    const path = join(spool, "x.claim");
    const a = tokenOf(claimAcquire(spool, "x"));
    age(path, 4000);
    const b = tokenOf(claimAcquire(spool, "x"));
    expect(b).not.toBe(a);
    // A is slow: it reaches its `finally` after B stole. Its release must not touch B's claim.
    expect(claimRelease(spool, "x", a)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(b);
    // B still holds: a third actor gets nothing, and B's own release works.
    expect(claimAcquire(spool, "x").status).toBe("held");
    expect(claimRelease(spool, "x", b)).toBe(true);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a claim body carries the nonce beside the incumbent's fields, and an observation still reads it as held", () => {
  const { root, spool } = scratch();
  try {
    const token = tokenOf(claimAcquire(spool, "x"));
    const body = readFileSync(join(spool, "x.claim"), "utf8");
    expect(body).toContain('{"v": 1, "id": "x", "owner_pid": ');
    expect(body.endsWith(`, "nonce": "${token}"}\n`)).toBe(true);
    expect(claimObserve(spool, "x")).toBe("held");
    expect(tokenOf(claimAcquire(spool, "y"))).not.toBe(token);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a release whose claim has no matching nonce is a no-op: legacy body, junk, another id's token", () => {
  const { root, spool } = scratch();
  try {
    const path = join(spool, "x.claim");
    for (const body of ['{"v": 1, "id": "x", "owner_pid": 7, "claimed_at_epoch": 1}\n', "not json", '{"nonce": 7}\n', '{"nonce": ""}\n', ""]) {
      writeFileSync(path, body);
      expect([body, claimRelease(spool, "x", "anything")]).toEqual([body, false]);
      expect(readFileSync(path, "utf8")).toBe(body);
    }
    // A claim on disk that is not a regular file is never read for a nonce.
    rmSync(path);
    mkdirSync(path);
    expect(() => claimRelease(spool, "x", "anything")).not.toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the CLI release mode's tokenless release still clears a claim, under the mutex", () => {
  const { root, spool } = scratch();
  try {
    const path = join(spool, "x.claim");
    tokenOf(claimAcquire(spool, "x"));
    expect(claimReleaseUnconditionally(spool, "x")).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(claimReleaseUnconditionally(spool, "x")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
