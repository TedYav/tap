// The spool pair writer: explicit expected outcomes, not a comparison against
// the retired Bash body. The differential that established parity ran against
// the pinned pre-cutover program at b7c49558c and is evidence in the port's PR,
// not a durable second implementation.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { METADATA_LOCK_TIMEOUT_MS, PublishError, PyFloat, isDict, metaBytes, mintMeta, parseJsonPreserving, parseMetaPreservingFloats, publishPair, pyIntString, pyStrip, reasonClass, type PublishInput } from "../src/spool-publication";
import { acquirePathLock } from "../src/panelock";

const NOW = new Date(1789458203000);

function scratch(): string {
  return mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "spool-pub-"));
}

function input(work: string, over: Partial<PublishInput> = {}): PublishInput {
  const canonical = join(work, "canon.md");
  if (!existsSync(canonical)) writeFileSync(canonical, "---\nid: x\nfrom: a\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  return {
    spoolDir: join(work, "spool"), id: "x", canonical, target: "peer", team: "t", reason: "busy", reasonClass: "",
    timeoutSeconds: "", pane: "sess:0.0", paneId: "%401", toTeam: "", policy: "standard", graceSeconds: "",
    targetRegistry: "", windowSeconds: "", lastDelivered: "", cueStyle: "", cueRedAt: "",
    env: { ...process.env }, now: NOW, lockTimeoutMs: 1000, ...over,
  };
}

function meta(work: string, id = "x"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(work, "spool", `${id}.meta.json`), "utf8"));
}

test("reason class is mechanical: copy-mode is the safety gate, window is its own class", () => {
  expect(reasonClass("copy-mode")).toBe("safety_gate");
  expect(reasonClass("window")).toBe("window");
  expect(reasonClass("no-input-prompt")).toBe("busy");
  expect(reasonClass("")).toBe("busy");
});

test("the pair is published body first, and both files land", () => {
  const work = scratch();
  try {
    const path = publishPair(input(work));
    expect(path).toBe(join(work, "spool", "x.md"));
    expect(readFileSync(path, "utf8")).toBe(readFileSync(join(work, "canon.md"), "utf8"));
    expect(meta(work).id).toBe("x");
    // The canonical copy is the caller's to retire, never this writer's.
    expect(existsSync(join(work, "canon.md"))).toBe(true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a readiness-gate park owns both the disposition and the waiter's lifetime", () => {
  const work = scratch();
  try {
    publishPair(input(work, { reason: "no-input-prompt" }));
    const row = meta(work);
    expect(row.reason_class).toBe("busy");
    expect(row.deadline_source).toBe("readiness-gate");
    expect(row.waiter_lifetime).toBe("readiness-gate");
    expect(row.deadline_epoch).toBe(1789458203 + 300);
    expect(row.attempt_fence).toBe(1);
    expect(row.attempts).toBe(0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a window park keeps a lifetime and mints NO deadline source", () => {
  const work = scratch();
  try {
    publishPair(input(work, { reason: "window", windowSeconds: "30", lastDelivered: "1789458200" }));
    const row = meta(work);
    expect(row.reason_class).toBe("window");
    // Nothing failed: the courier rate-limited a READY pane, so the deadline
    // must not carry the sender-wake/terminalize disposition.
    expect(row.deadline_source).toBe("");
    expect(row.waiter_lifetime).toBe("window");
    expect(row.hold_until_epoch).toBe(1789458230);
    expect(row.deadline_epoch).toBe(1789458230 + 300);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the hold runs from the last verified delivery and is stamped once", () => {
  const work = scratch();
  try {
    const first = mintMeta(input(work, { windowSeconds: "60", lastDelivered: "1789458190" }), {}, false, NOW);
    expect(first.hold_until_epoch).toBe(1789458250);
    // A later park of the same id carries the armed epoch forward untouched:
    // re-deriving it from the newest delivery is how polite mail starves.
    const second = mintMeta(input(work, { windowSeconds: "60", lastDelivered: "1789458203" }), { hold_until_epoch: 1789458250 }, true, new Date(1789458260000));
    expect(second.hold_until_epoch).toBe(1789458250);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("no verified reading, or a clock ahead of now, is due now", () => {
  const work = scratch();
  try {
    expect(mintMeta(input(work, { windowSeconds: "60", lastDelivered: "" }), {}, false, NOW).hold_until_epoch).toBe(1789458203);
    expect(mintMeta(input(work, { windowSeconds: "60", lastDelivered: "1789460000" }), {}, false, NOW).hold_until_epoch).toBe(1789458203);
    // An elapsed window is a number, never absent: "due now" and "never
    // computed" are different facts to every reader.
    expect(mintMeta(input(work, { windowSeconds: "10", lastDelivered: "1789450000" }), {}, false, NOW).hold_until_epoch).toBe(1789458203);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("autosettle carries two clocks and its own deadline source", () => {
  const work = scratch();
  try {
    const row = mintMeta(input(work, { reason: "auto-settle", policy: "autosettle", windowSeconds: "120", lastDelivered: "1789458200" }), {}, false, NOW);
    expect(row.hold_until_epoch).toBe(1789458320);
    expect(row.deadline_epoch).toBe(1789458320 + 300);
    expect(row.deadline_source).toBe("autosettle-hold");
    expect(row.waiter_lifetime).toBe("autosettle-hold");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a grace window gets a lifetime and deliberately no deadline source", () => {
  const work = scratch();
  try {
    const row = mintMeta(input(work, { reason: "pending-input", graceSeconds: "60" }), {}, false, NOW);
    expect(row.deadline_epoch).toBe(1789458203 + 60);
    expect(row.waiter_lifetime).toBe("grace-window");
    // At its deadline a draft park force-delivers; it must not inherit the
    // sender-wake + terminalize pair that deadline_source gates.
    expect(row.deadline_source).toBe("");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a polite timeout is a policy deadline with no lifetime marker", () => {
  const work = scratch();
  try {
    const row = mintMeta(input(work, { policy: "polite", timeoutSeconds: "600" }), {}, false, NOW);
    expect(row.deadline_epoch).toBe(1789458203 + 660);
    expect(row.waiter_lifetime).toBe("window");
    expect(row.deadline_source).toBe("");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an existing deadline carries its source, and an absent lifetime key is inferred", () => {
  const work = scratch();
  try {
    const carried = mintMeta(input(work, { reason: "other", reasonClass: "other" }), { deadline_epoch: 1789458999, deadline_source: "readiness-gate" }, true, NOW);
    expect(carried.deadline_epoch).toBe(1789458999);
    expect(carried.deadline_source).toBe("readiness-gate");
    // Absent means "infer"; writing "" would switch the deliverer's fallback off.
    expect(carried.waiter_lifetime).toBe("readiness-gate");
    // A PRESENT empty key is not inferred from the source — and then the
    // window fallback claims the still-unowned entry, because its carried
    // deadline outlives the hold. Ownership ends up stated either way; only
    // the disposition differs, and the fallback never touches that.
    const explicit = mintMeta(input(work, { reason: "other", reasonClass: "other" }), { deadline_epoch: 1789458999, deadline_source: "readiness-gate", waiter_lifetime: "" }, true, NOW);
    expect(explicit.waiter_lifetime).toBe("window");
    expect(explicit.deadline_source).toBe("readiness-gate");
    // With the carried deadline at or before the hold, nothing claims it.
    const unowned = mintMeta(input(work, { reason: "other", reasonClass: "other" }), { deadline_epoch: 1789458100, deadline_source: "", waiter_lifetime: "" }, true, NOW);
    expect(unowned.waiter_lifetime).toBe("");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an unowned entry with a deadline past its hold gets the window lifetime, never a source", () => {
  const work = scratch();
  try {
    const row = mintMeta(input(work, { reason: "copy-mode", reasonClass: "safety_gate", windowSeconds: "30", lastDelivered: "1789458200" }), {}, false, NOW);
    expect(row.hold_until_epoch).toBe(1789458230);
    // A safety-gate park mints neither a lifetime nor a deadline of its own;
    // the fallback supplies both, because the two fields travel together or
    // neither does anything.
    expect(row.deadline_epoch).toBe(1789458230 + 300);
    expect(row.waiter_lifetime).toBe("window");
    expect(row.deadline_source).toBe("");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("attempt_fence is 1 only for a genuinely new slot", () => {
  const work = scratch();
  try {
    expect(mintMeta(input(work), {}, false, NOW).attempt_fence).toBe(1);
    expect(mintMeta(input(work), {}, true, NOW).attempt_fence).toBe(0);
    expect(mintMeta(input(work), { attempt_fence: 4 }, true, NOW).attempt_fence).toBe(4);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the busy deadline knob refuses a non-positive bound and says so", () => {
  const work = scratch();
  try {
    expect(mintMeta(input(work, { env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "42" } }), {}, false, NOW).deadline_epoch).toBe(1789458203 + 42);
    // A zero or negative bound would make every park instantly overdue.
    expect(mintMeta(input(work, { env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "0" } }), {}, false, NOW).deadline_epoch).toBe(1789458203 + 300);
    expect(mintMeta(input(work, { env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "-5" } }), {}, false, NOW).deadline_epoch).toBe(1789458203 + 300);
    expect(mintMeta(input(work, { env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "junk" } }), {}, false, NOW).deadline_epoch).toBe(1789458203 + 300);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a to_team whose registry disagrees is marked, and a BOM is not whitespace", () => {
  const work = scratch();
  try {
    const registry = join(work, "registry.json");
    writeFileSync(registry, JSON.stringify({ team: { name: " t " } }));
    const ok = mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW);
    expect(ok.reason).toBe("busy");
    expect(ok.reason_class).toBe("busy");

    // Python's str.strip() removes whitespace; U+FEFF is NOT whitespace to it,
    // so a BOM-wrapped registry team does NOT bind. JS trim() would erase it
    // and accept the binding — a different answer to an identity question.
    writeFileSync(registry, JSON.stringify({ team: { name: "﻿t﻿" } }));
    const bom = mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW);
    expect(bom.reason).toBe("legacy_meta_no_binding");
    expect(bom.reason_class).toBe("safety_gate");
    expect(pyStrip("﻿t﻿")).toBe("﻿t﻿");
    expect(pyStrip("t")).toBe("t");

    writeFileSync(registry, JSON.stringify({ team: { name: "u" } }));
    expect(mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW).reason).toBe("legacy_meta_no_binding");
    // A missing or malformed registry cannot prove a binding either.
    expect(mintMeta(input(work, { toTeam: "t", targetRegistry: join(work, "gone.json") }), {}, false, NOW).reason).toBe("legacy_meta_no_binding");
    writeFileSync(registry, JSON.stringify({ team: { name: ["t"] } }));
    expect(mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW).reason).toBe("legacy_meta_no_binding");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an invalid byte in the target registry cannot prove a binding", () => {
  const work = scratch();
  try {
    const registry = join(work, "registry.json");
    // Raw invalid byte in an UNRELATED field: a lax decode still reads
    // team.name === "t" and calls the binding proven.
    writeFileSync(registry, Buffer.concat([
      Buffer.from('{"team":{"name":"t"},"note":"caf'),
      Buffer.from([0xe9]),
      Buffer.from('r"}'),
    ]));
    const marked = mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW);
    expect(marked.reason).toBe("legacy_meta_no_binding");
    expect(marked.reason_class).toBe("safety_gate");

    // The same note as valid UTF-8 binds exactly as before: strictness is
    // about decodability, not ASCII purity.
    writeFileSync(registry, Buffer.concat([
      Buffer.from('{"team":{"name":"t"},"note":"caf'),
      Buffer.from([0xc3, 0xa9]),
      Buffer.from('r"}'),
    ]));
    const ok = mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW);
    expect(ok.reason).toBe("busy");
    expect(ok.reason_class).toBe("busy");

    // A file-leading BOM is handed through by either era's reader and refused
    // by the caller's JSON.parse, so the file cannot prove the binding — same
    // safety-gate answer as the wrapped-name case above, different mechanism.
    writeFileSync(registry, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ team: { name: "t" } })),
    ]));
    const prefixed = mintMeta(input(work, { toTeam: "t", targetRegistry: registry }), {}, false, NOW);
    expect(prefixed.reason).toBe("legacy_meta_no_binding");
    expect(prefixed.reason_class).toBe("safety_gate");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("numeric parsing uses int()'s whitespace, which is NOT str.strip()'s", () => {
  // CPython: `int("\x1c7\x1f")` raises ValueError, while the same string's
  // `.strip()` returns "7". One rule for both let a refused
  // TAP_SPOOL_BUSY_DEADLINE_SECONDS through and minted a 7-second readiness
  // tail where the incumbent takes its 300-second default.
  expect(pyIntString("\u001c7\u001f")).toBe(null);
  expect(pyIntString("\u001e42")).toBe(null);
  expect(pyStrip("\u001c7\u001f")).toBe("7");
  // The separator characters are not silently dropped from the value either.
  expect(pyIntString("1\u001c2")).toBe(null);
  // Real whitespace still parses on both sides, including NBSP, which int() takes.
  expect(pyIntString(" 7 ")).toBe(7);
  expect(pyIntString("\u00a07")).toBe(7);
});

test("a refused deadline knob keeps the incumbent default, C0 separators included", () => {
  const work = scratch();
  try {
    const row = mintMeta(input(work, { env: { ...process.env, TAP_SPOOL_BUSY_DEADLINE_SECONDS: "\u001c7\u001f" } }), {}, false, NOW);
    expect(row.deadline_epoch).toBe(1789458203 + 300);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a float is rendered where it sits, and a carried string can never be mistaken for it", () => {
  // Three text-substitution designs each corrupted or refused a carried field
  // that happened to equal their marker (A2 twice, S3). The renderer emits the
  // float at its structural position, so a former marker is just a string.
  const token = "\u0000float:next_probe_epoch\u0000";
  const parsed = JSON.parse(metaBytes({ first_spooled: token, next_probe_epoch: new PyFloat(1000) }));
  expect(parsed.first_spooled).toBe(token);
  expect(parsed.next_probe_epoch).toBe(1000);
  expect(metaBytes({ next_probe_epoch: new PyFloat(1000) })).toContain('"next_probe_epoch": 1000.0');
  // A carried NESTED object may hold the same key, a nested float, and the
  // nested marker string; none of it is special to the renderer.
  const nested = JSON.parse(metaBytes({ first_spooled: { next_probe_epoch: token, at: new PyFloat(2), s: "\u0000float#0\u0000" }, next_probe_epoch: new PyFloat(1000) }));
  expect(nested.first_spooled).toEqual({ next_probe_epoch: token, at: 2, s: "\u0000float#0\u0000" });
  expect(nested.next_probe_epoch).toBe(1000);
  expect(metaBytes({ first_spooled: { at: new PyFloat(2) } })).toBe('{\n  "first_spooled": {\n    "at": 2.0\n  }\n}\n');
});

test("keys sort by code point and every non-printable code unit is escaped, as json.dump does", () => {
  // JavaScript's default sort compares UTF-16 units, which puts U+1F600 (a
  // surrogate pair starting D83D) before U+FFFF; Python compares code points.
  // `JSON.stringify` leaves DEL (0x7F) raw; Python's ensure_ascii escapes it.
  expect(metaBytes({ "\uffff": 1, "\ud83d\ude00": 2, "B": 3, "a": 4 })).toBe('{\n  "B": 3,\n  "a": 4,\n  "\\uffff": 1,\n  "\\ud83d\\ude00": 2\n}\n');
  expect(metaBytes({ d: "a\u007fb\u0001\n", e: [], o: {} })).toBe('{\n  "d": "a\\u007fb\\u0001\\n",\n  "e": [],\n  "o": {}\n}\n');
  expect(metaBytes({ f: new PyFloat(1e16), g: new PyFloat(1e-7), z: new PyFloat(-0) })).toBe('{\n  "f": 1e+16,\n  "g": 1e-07,\n  "z": -0.0\n}\n');
});

test("deadline arithmetic on a carried float epoch yields a float, and on a big integer stays exact", () => {
  // The preserving parser hands `first_spooled_epoch: 1789458100.0` to the
  // deadline addition as a PyFloat; Python's float + int is a float and the
  // sidecar keeps its `.0`. Past 2^53 the addition is exact in Python and
  // must not round here. Refusing either turned a park the incumbent
  // completes into a refusal after the body write (S6).
  const work = scratch();
  try {
    const path = join(work, "spool", "x.meta.json");
    mkdirSync(join(work, "spool"), { recursive: true });
    writeFileSync(path, '{"first_spooled_epoch": 1789458100.0, "hold_until_epoch": 1789458203.0}\n');
    publishPair(input(work));                       // busy: first + 300 → float
    expect(readFileSync(path, "utf8")).toContain('"deadline_epoch": 1789458400.0');
    writeFileSync(path, '{"first_spooled_epoch": 9007199254740993, "hold_until_epoch": 1789458203.0}\n');
    publishPair(input(work, { reason: "pending-input", graceSeconds: "60" })); // grace: first + 60, exact
    expect(readFileSync(path, "utf8")).toContain('"deadline_epoch": 9007199254741053');
    expect(readFileSync(path, "utf8")).toContain('"first_spooled_epoch": 9007199254740993');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a re-park carries a whole float and a big integer forward unchanged", () => {
  // Publication's own read-modify-write: the existing sidecar is read with the
  // preserving parser, so a carried `1789458100.0` does not come back as
  // `1789458100` and a 20-digit `timeout_seconds` does not come back rounded.
  // (`mintMeta` rebuilds the sidecar from its known keys, as the incumbent's
  // fresh dict did; only carried keys can show the defect.)
  const work = scratch();
  try {
    publishPair(input(work, { reason: "other", reasonClass: "other" }));
    const path = join(work, "spool", "x.meta.json");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(/"first_spooled_epoch": \d+/, '"first_spooled_epoch": 1789458100.0')
      .replace(/"deadline_epoch": \d+/, '"deadline_epoch": 1789458999.0')
      .replace(/"timeout_seconds": null/, '"timeout_seconds": 12345678901234567890'));
    publishPair(input(work, { reason: "other", reasonClass: "other" }));
    const bytes = readFileSync(path, "utf8");
    expect(bytes).toContain('"first_spooled_epoch": 1789458100.0');
    expect(bytes).toContain('"deadline_epoch": 1789458999.0');
    expect(bytes).toContain('"timeout_seconds": 12345678901234567890');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("int parsing follows Python, including underscores and Unicode digits", () => {
  expect(pyIntString(" 42 ")).toBe(42);
  expect(pyIntString("1_0")).toBe(10);
  expect(pyIntString("٣٠")).toBe(30);
  expect(pyIntString("+7")).toBe(7);
  expect(pyIntString("")).toBe(null);
  expect(pyIntString("4.0")).toBe(null);
  expect(pyIntString("0x10")).toBe(null);
  expect(pyIntString("1__0")).toBe(null);
  expect(pyIntString("﻿7")).toBe(null);
});

test("next_probe_epoch stays a float, whatever the delay knob says", () => {
  const work = scratch();
  try {
    publishPair(input(work, { env: { ...process.env, TAP_SPOOL_DELIVERER_DELAYS: "2 4" } }));
    // Written as `1789458205.0`: a Python reader must not see this field's type
    // change with an operator's env value.
    expect(readFileSync(join(work, "spool", "x.meta.json"), "utf8")).toContain('"next_probe_epoch": 1789458205.0');
    rmSync(join(work, "spool"), { recursive: true, force: true });
    publishPair(input(work, { env: { ...process.env, TAP_SPOOL_DELIVERER_DELAYS: "  1.5 3" } }));
    expect(meta(work).next_probe_epoch).toBe(1789458204.5);
    rmSync(join(work, "spool"), { recursive: true, force: true });
    // An unusable override costs receipt timing, never the durable park.
    publishPair(input(work, { env: { ...process.env, TAP_SPOOL_DELIVERER_DELAYS: "soon 3" } }));
    expect(meta(work).next_probe_epoch).toBe(1789458203.25);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the metadata is sorted, indented, ASCII-escaped and newline-terminated", () => {
  const work = scratch();
  try {
    publishPair(input(work, { team: "équipe ☕" }));
    const bytes = readFileSync(join(work, "spool", "x.meta.json"), "utf8");
    expect(bytes.endsWith("}\n")).toBe(true);
    expect(bytes).toContain('  "attempt_fence": 1,\n');
    expect(bytes).toContain('"team": "\\u00e9quipe \\u2615"');
    const keys = Object.keys(JSON.parse(bytes));
    expect(keys).toEqual([...keys].sort());
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a refused input publishes nothing at all", () => {
  const work = scratch();
  try {
    expect(() => publishPair(input(work, { id: "../escape" }))).toThrow(PublishError);
    expect(() => publishPair(input(work, { id: ".hidden" }))).toThrow(PublishError);
    expect(() => publishPair(input(work, { canonical: join(work, "missing.md") }))).toThrow(PublishError);
    // `[ -f ]` is exists AND regular. A directory stands in for the whole
    // non-regular class here; the ones that matter in production are a FIFO
    // (the read blocks forever) and a character device (the read never ends).
    mkdirSync(join(work, "notafile.md"), { recursive: true });
    expect(() => publishPair(input(work, { canonical: join(work, "notafile.md") }))).toThrow(PublishError);
    expect(() => publishPair(input(work, { target: "" }))).toThrow(PublishError);
    expect(() => publishPair(input(work, { reason: "" }))).toThrow(PublishError);
    expect(existsSync(join(work, "spool"))).toBe(false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// `readFileSync` and `open(..., O_WRONLY)` on a FIFO block forever, so a control
// that points publication at one runs it in a child with a hard kill: an
// in-process hang would take the test runner with it.
function publishInChild(args: PublishInput) {
  const names = ["spoolDir", "id", "canonical", "target", "team", "reason", "reasonClass", "timeoutSeconds", "pane", "paneId", "toTeam", "policy", "graceSeconds", "targetRegistry", "windowSeconds", "lastDelivered", "cueStyle", "cueRedAt"] as const;
  return spawnSync(process.execPath, [join(import.meta.dir, "../src/spool-publication.ts"), "add", ...names.map(name => args[name]!)],
    { env: process.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
}

// The sidecar is read under the metadata lock, and `readFileSync` on a FIFO
// blocks forever, so the control must run in a child with a hard timeout: an
// in-process hang would take the test runner with it (tap-ahpdi).
test("a FIFO at the metadata path is treated as absent: fresh mint, and the rename replaces it", () => {
  const work = scratch();
  try {
    const args = input(work);
    mkdirSync(join(work, "spool"), { recursive: true });
    const metaFile = join(work, "spool", "x.meta.json");
    expect(spawnSync("mkfifo", [metaFile]).status).toBe(0);
    const child = publishInChild(args);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    // The asymmetry: a non-regular CANONICAL refuses, a non-regular META is
    // absent. Nothing readable was ever there to preserve, so the first
    // attempt_fence is minted and the atomic rename replaces the FIFO.
    expect(statSync(metaFile).isFile()).toBe(true);
    expect(meta(work).attempt_fence).toBe(1);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a FIFO at the metadata lock path completes within the bound, never hangs", () => {
  const work = scratch();
  try {
    mkdirSync(join(work, "spool"), { recursive: true });
    expect(spawnSync("mkfifo", [join(work, "spool", "x.meta.json.lock")]).status).toBe(0);
    const child = publishInChild(input(work));
    // A write-only open of a FIFO blocks until a reader appears; the name probe and the
    // real acquire both open O_RDWR, so neither waits on it. What the acquire then does
    // with a FIFO is platform-dependent (flock may or may not take an uncontended one),
    // so accept either outcome: bounded completion is the invariant. Red on the
    // write-only probe: the child was killed at the timeout.
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    if (child.status === 0) expect(meta(work).id).toBe("x");
    else {
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("metadata lock held past");
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a lock name past the filename limit refuses by name, and parks no orphan body", () => {
  const work = scratch();
  try {
    // 245 bytes: `.md` (248) and `.meta.json` (255) fit, `.meta.json.lock` (260) does not.
    const id = "a".repeat(245);
    const started = Date.now();
    let message = "";
    try { publishPair(input(work, { id })); } catch (error) { message = error instanceof PublishError ? error.message : `not a PublishError: ${error}`; }
    expect(message).toContain("exceeds the filename limit");
    expect(message).toContain(`${id}.meta.json.lock`);
    expect(message).not.toContain("held past");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(readdirSync(join(work, "spool"))).toEqual([]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an undecodable existing sidecar is evidence, not an overwrite target", () => {
  const work = scratch();
  try {
    mkdirSync(join(work, "spool"), { recursive: true });
    writeFileSync(join(work, "spool", "x.meta.json"), "[1, 2]");
    expect(() => publishPair(input(work))).toThrow(PublishError);
    expect(readFileSync(join(work, "spool", "x.meta.json"), "utf8")).toBe("[1, 2]");
    // Q6: a whole-document scalar is a PyFloat/PyInt wrapper — an object to
    // `typeof` — and Python's `old.get` on it raised: refused, not overwritten.
    for (const scalar of ["1.0", "NaN", "12345678901234567890"]) {
      writeFileSync(join(work, "spool", "x.meta.json"), scalar);
      expect(() => publishPair(input(work))).toThrow(PublishError);
      expect(readFileSync(join(work, "spool", "x.meta.json"), "utf8")).toBe(scalar);
    }
    // Unparseable bytes carry no accounting to preserve, so they are replaced —
    // the same answer the incumbent's caught json.load gave.
    writeFileSync(join(work, "spool", "x.meta.json"), "not json");
    publishPair(input(work));
    expect(meta(work).attempt_fence).toBe(0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// --- real failures at the write boundary ------------------------------------
// These obstruct the filesystem rather than faulting the process, so they
// exercise the writer's own error propagation: a caller that sees a throw knows
// nothing was published that it may treat as complete.

test("an obstructed body destination fails the publication", () => {
  const work = scratch();
  try {
    mkdirSync(join(work, "spool", "x.md"), { recursive: true });
    expect(() => publishPair(input(work))).toThrow();
    expect(existsSync(join(work, "spool", "x.meta.json"))).toBe(false);
    expect(existsSync(join(work, "canon.md"))).toBe(true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an obstructed metadata destination fails after the body, leaving no complete pair", () => {
  const work = scratch();
  try {
    mkdirSync(join(work, "spool", "x.meta.json"), { recursive: true });
    expect(() => publishPair(input(work))).toThrow();
    // The body may exist — publication is ordered, and the incomplete pair is
    // exactly what the caller's claim and the drain's snapshot rule cover.
    expect(existsSync(join(work, "spool", "x.meta.json", "..", "x.md"))).toBe(true);
    expect(existsSync(join(work, "canon.md"))).toBe(true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the metadata lock wait is bounded, and the bound is far above any legitimate hold", () => {
  // The incumbent waited forever here. The bound is what makes a wedged holder
  // a reported refusal instead of a silent stall, and it is chosen from the
  // measured critical section (0.27 ms median / 2.03 ms p99 / 41 ms worst over
  // 2000 rounds on a loaded host), not from the pane lock's default.
  expect(METADATA_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  // 41 ms worst observed hold; anything near it would refuse legitimate work.
  expect(METADATA_LOCK_TIMEOUT_MS / 41).toBeGreaterThan(50);
});

test("a held metadata lock refuses rather than writing beside its holder", () => {
  const work = scratch();
  try {
    mkdirSync(join(work, "spool"), { recursive: true });
    const holder = acquirePathLock(join(work, "spool", "x.meta.json.lock"), 2000);
    expect(holder).not.toBeNull();
    try {
      let refusal: unknown;
      try { publishPair(input(work, { lockTimeoutMs: 0 })); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(PublishError);
      // The message names the bound it hit, so an operator reading a
      // spool_publish_failed receipt can tell a held lock from a bad input.
      expect((refusal as Error).message).toContain("metadata lock held past");
      expect(existsSync(join(work, "spool", "x.meta.json"))).toBe(false);
    } finally { holder!.release(); }
    // Once the holder is gone the same input publishes normally: the refusal
    // is pre-effect, so the same id is still safe to publish. Nothing was
    // placed, sent, or injected while the lock was held.
    expect(publishPair(input(work))).toBe(join(work, "spool", "x.md"));
    expect(meta(work).id).toBe("x");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("parseJsonPreserving reads Python's NaN/Infinity/-Infinity tokens as floats, leaves them alone inside strings, and rejects the shapes json.loads rejects", () => {
  const r = parseJsonPreserving('{"a": NaN, "b": [Infinity, -Infinity, "NaN", "x -Infinity y"], "c": 1e999}') as Record<string, unknown>;
  expect(r.a instanceof PyFloat && Number.isNaN((r.a as PyFloat).value)).toBe(true);
  expect((r.b as unknown[]).map(v => (v instanceof PyFloat ? v.value : v))).toEqual([Infinity, -Infinity, "NaN", "x -Infinity y"]);
  expect((r.c as PyFloat).value).toBe(Infinity);
  expect(metaBytes(r as Record<string, never>)).toBe('{\n  "a": NaN,\n  "b": [\n    Infinity,\n    -Infinity,\n    "NaN",\n    "x -Infinity y"\n  ],\n  "c": Infinity\n}\n');
  for (const bad of ["{NaN: 1}", "-NaN", "NaNx", "--Infinity", '{"a": Infinityx}', "[Infinity"]) expect(() => parseJsonPreserving(bad)).toThrow();
  expect(metaBytes(parseJsonPreserving('{"NaN": Infinity}') as Record<string, never>)).toBe('{\n  "NaN": Infinity\n}\n');
});

test("Q6: isDict is Python's isinstance(x, dict) over the preserving parser — a scalar wrapper is not a sidecar", () => {
  expect(isDict(parseJsonPreserving("{}"))).toBe(true);
  for (const scalar of ["1.0", "NaN", "Infinity", "-Infinity", "12345678901234567890", "1", "\"s\"", "null", "[1]"]) {
    expect(isDict(parseJsonPreserving(scalar))).toBe(false);
    expect(() => parseMetaPreservingFloats(scalar)).toThrow(/not an object/);
  }
});

test("autosettle draft keeps a 30-second clobber clock separate from sender escalation", () => {
  const work = scratch();
  try {
    const m = mintMeta(input(work, { policy: "autosettle", graceSeconds: "30", reason: "pending-input" }), {}, false, NOW);
    expect(m.draft_deadline_epoch).toBe(Math.floor(NOW.getTime() / 1000) + 30);
    expect(m.deadline_source).toBe("autosettle-hold");
    const again = mintMeta(input(work, { policy: "autosettle", graceSeconds: "30" }), m, true, new Date(NOW.getTime() + 60000));
    expect(again.draft_deadline_epoch).toBe(m.draft_deadline_epoch);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
