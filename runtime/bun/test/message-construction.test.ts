// Unit rows for slices/message-construction.ts — the one implementation of
// `tap send` construction both doors call (D1). These pin the module's own
// contract: option grammar and refusal bytes, byte staging, the effective
// kind, the wrap rule, the obligation with its downgrade and assign refusal,
// and the NUL-pair carrier the Bash door reads. The two-door and pinned-base
// differential lives in the send-construction-*.test.ts components ("D1
// construction differential").
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { TapError } from "../src/context";
import { InvalidHeaderEncoding, envelopeBodyBytes, stampEnvelope, stampEnvelopeBytes } from "../src/envelope";
import {
  bodySourceRefusal, checkSource, effectiveKind, guardApplies, inlineMaxBytes, parseSendArgs, resolveId, resolveObligation,
  shellQuote, stageBody, stageSource, tokenRefusal, usageRefusal, writeStaged,
} from "../src/slices/message-construction";
import { removeScratchTree } from "./support/scratch";

// One scratch root per file: the reaper's lsof walk is a whole-machine scan per
// call, so one call at the end stays inside the hook budget.
const SCRATCH = mkdtempSync(join(tmpdir(), "tap-mc."));
let scratchN = 0;
afterAll(() => removeScratchTree(SCRATCH));
function tmp(): string { const p = join(SCRATCH, String(++scratchN)); mkdirSync(p); return p; }

function refusal(fn: () => unknown): { code: number; errorClass: string; action: string; detail: string } {
  try { fn(); } catch (error) {
    if (error instanceof TapError) return { code: error.code, errorClass: error.errorClass, action: error.action, detail: error.detail };
    throw error;
  }
  throw new Error("expected a TapError");
}

describe("parseSendArgs — Bash's parse loop and its usage checks, in order", () => {
  test("every option lands in its field; positionals are <to> then <payload-file>", () => {
    const a = parseSendArgs([
      "ub", "file.md", "--preview", "p", "--from", "ua", "--kind", "k", "--id", "ua-1", "--pane", "%3",
      "--cross-worktree", "--team", "t", "--json", "--polite-timeout", "30", "--wake",
      "--reply-to", "x", "--no-auto-reply-to", "--in-reply-to", "ua-2", "--recipient-instance", "ub|A",
      "--sender-instance", "ua|A", "--historical-recipient", "--adopted-from", "old", "--remote-registry", "/r.json",
    ], false);
    expect(a).toMatchObject({
      to: "ub", payloadFile: "file.md", message: null, bodyFile: "", preview: "p", from: "ua", fromSet: true,
      kind: "k", kindSet: true, id: "ua-1", pane: "%3", crossWorktree: true, team: "t", json: true,
      politeTimeout: "30", politeTimeoutSet: true, wake: true, replyTo: "x", replyToSet: true, noAutoReplyTo: true,
      inReplyTo: "ua-2", recipientInstance: "ub|A", expectedSenderInstance: "ua|A", historicalRecipient: true,
      adoptedFrom: "old", remoteRegistry: "/r.json", bodySources: 1, expectReply: false, fyi: false, note: false,
    });
  });

  test("--ask, --reply and --expect-reply are one bit; last-write-wins on repeated values", () => {
    for (const flag of ["--ask", "--reply", "--expect-reply"]) {
      expect(parseSendArgs(["ub", "-m", "x", flag], false).expectReply).toBe(true);
    }
    const a = parseSendArgs(["ub", "-m", "first", "-m", "second", "--kind", "a", "--kind", "order"], false);
    expect({ message: a.message, kind: a.kind, bodySources: a.bodySources }).toEqual({ message: "second", kind: "order", bodySources: 1 });
  });

  test("a -m operand may be empty (Bash `${2?}`); a -f/--kind operand may not (`${2:?}`)", () => {
    expect(parseSendArgs(["ub", "-m", ""], false).message).toBe("");
    expect(parseSendArgs(["ub", "--preview", "", "-m", "x"], false).preview).toBe("");
    expect(refusal(() => parseSendArgs(["ub", "-f", ""], false))).toEqual({ code: 1, errorClass: "usage_error", action: "tap help send", detail: "--body-file needs a value" });
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--kind", ""], false)).detail).toBe("--kind needs a value");
    expect(refusal(() => parseSendArgs(["ub", "-m"], false)).detail).toBe("-m needs a value");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--id"], false)).detail).toBe("--id needs a value");
  });

  test("unknown option and a third positional refuse with Bash's classes", () => {
    expect(refusal(() => parseSendArgs(["ub", "--bogus"], false))).toEqual({ code: 1, errorClass: "unknown_option", action: "tap help send", detail: "unknown option '--bogus'" });
    expect(refusal(() => parseSendArgs(["ub", "a", "b"], false))).toEqual({ code: 1, errorClass: "usage_error", action: "tap help send", detail: "unexpected arg 'b'" });
  });

  test("the conflict matrix, in Bash's order: assign first, then note/ask, note/fyi, fyi/ask", () => {
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--fyi", "--ask"], true)).detail).toBe("tap assign is a work order and always expects a reply; --fyi names a note — use tap send");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--note", "--ask"], true))).toMatchObject({ action: "tap help assign", detail: "tap assign is a work order and always expects a reply; --note names a note — use tap send" });
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--note", "--ask"], false)).detail).toBe("pass either --note or --ask, not both");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--note", "--fyi"], false)).detail).toBe("--fyi and --note are the same claim; pass one");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--fyi", "--ask"], false)).detail).toBe("pass either --fyi or --ask, not both");
    // --note --ask --fyi: note/ask wins over note/fyi, as Bash checks note/ask first.
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--note", "--ask", "--fyi"], false)).detail).toBe("pass either --note or --ask, not both");
  });

  test("--adopted-from requires --in-reply-to and a valid token, and is checked before the conflicts", () => {
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--adopted-from", "old", "--note", "--ask"], false)))
      .toEqual({ code: 1, errorClass: "usage_error", action: "tap reply <id> -f <file>", detail: "--adopted-from requires a reply and a valid predecessor handle" });
    expect(parseSendArgs(["ub", "-m", "x", "--adopted-from", "old", "--in-reply-to", "ua-1"], false).adoptedFrom).toBe("old");
  });

  test("delivery class: enum, alias contradictions, the interrupt/polite folds, no-spool, polite+urgent", () => {
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--delivery", "soon"], false)).detail).toBe("--delivery takes interrupt, now, or polite (got 'soon')");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--delivery", "interrupt", "--polite", "--wake"], false)).detail).toBe("--delivery interrupt contradicts --polite and --wake; pass one delivery class");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--delivery", "polite", "--urgent"], false)).detail).toBe("--delivery polite contradicts --urgent; pass one delivery class");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--delivery", "now", "--urgent", "--polite"], false)).detail).toBe("--delivery now contradicts --urgent and --polite; pass one delivery class");
    const interrupt = parseSendArgs(["ub", "-m", "x", "--delivery", "interrupt"], false);
    expect({ urgent: interrupt.urgent, urgentSet: interrupt.urgentSet, polite: interrupt.polite }).toEqual({ urgent: true, urgentSet: true, polite: false });
    expect(parseSendArgs(["ub", "-m", "x", "--delivery", "polite"], false).polite).toBe(true);
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--no-spool", "--urgent"], false)).detail).toBe("--no-spool contradicts interrupt/--urgent and polite/--polite; use the now class");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--polite", "--urgent"], false)).detail).toBe("pass either --polite or --urgent, not both");
    // --delivery now with --wake alone is not a contradiction.
    expect(parseSendArgs(["ub", "-m", "x", "--delivery", "now", "--wake"], false).wake).toBe(true);
  });

  test("--in-reply-to id charset and --polite-timeout grammar, with the 600 s default", () => {
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--in-reply-to", "bad id"], false))).toMatchObject({ action: "tap help reply", detail: "invalid in-reply-to id 'bad id'" });
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--polite-timeout", "12s"], false)).detail).toBe("--polite-timeout must be a positive integer (seconds)");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--polite-timeout", "0"], false)).detail).toBe("--polite-timeout must be > 0");
    expect(parseSendArgs(["ub", "-m", "x"], false).politeTimeout).toBe("600");
    expect(parseSendArgs(["ub", "-m", "x", "--polite-timeout", "007"], false).politeTimeout).toBe("007");
    // Bash's [ -gt ] operand range: 2^63-1 is a number, 2^63 is "integer expression expected" → refused as not > 0.
    expect(parseSendArgs(["ub", "-m", "x", "--polite-timeout", "9223372036854775807"], false).politeTimeout).toBe("9223372036854775807");
    expect(refusal(() => parseSendArgs(["ub", "-m", "x", "--polite-timeout", "9223372036854775808"], false)).detail).toBe("--polite-timeout must be > 0");
  });

  test("body-source count and the usage line are deferred refusals with Bash's bytes", () => {
    const two = parseSendArgs(["ub", "-m", "x", "-f", "f"], false);
    expect(two.bodySources).toBe(2);
    expect(bodySourceRefusal(two)).toEqual({ code: 1, errorClass: "usage_error", action: "tap help send", detail: 'pass exactly one message source: -m "text", -f <body-file>, or a positional <payload-file>' });
    expect(bodySourceRefusal(parseSendArgs(["ub", "-m", "x"], false))).toBeNull();
    expect(usageRefusal({ to: "", bodySources: 1 })!.detail).toStartWith("usage: tap send <to> (-m");
    expect(usageRefusal({ to: "ub", bodySources: 0 })).not.toBeNull();
    expect(usageRefusal({ to: "ub", bodySources: 1 })).toBeNull();
    // stageSource keeps the incumbent's order: with a source but no destination
    // the source's own refusal (cap, missing file) wins over the usage line.
    expect(refusal(() => stageSource({ to: "", message: "hello", bodyFile: "", payloadFile: "", bodySources: 1 }, { inlineMaxBytes: "0" })).errorClass).toBe("payload_too_large");
    expect(refusal(() => stageSource({ to: "", message: null, bodyFile: "/nonexistent/none", payloadFile: "", bodySources: 1 }, {})).errorClass).toBe("not_found");
    expect(refusal(() => stageSource({ to: "", message: "hello", bodyFile: "", payloadFile: "", bodySources: 1 }, {})).detail).toStartWith("usage: tap send <to>");
    expect(refusal(() => stageSource({ to: "ub", message: null, bodyFile: "", payloadFile: "", bodySources: 0 }, {})).detail).toStartWith("usage: tap send <to>");
  });
});

describe("stageBody — bytes behind a synthetic fence, the cap, the wrap rule", () => {
  test("-m stages ---/---/body/LF and is judged as staged; the cap counts UTF-8 bytes", () => {
    const s = stageBody({ to: "ub", message: "héllo", bodyFile: "", payloadFile: "" }, {});
    expect(s.bytes.toString("utf8")).toBe("---\n---\nhéllo\n");
    expect(s.judged.equals(s.bytes)).toBe(true);
    expect({ wrap: s.needsWrap, kind: s.envelopeKind, id: s.envelopeId }).toEqual({ wrap: false, kind: "", id: "" });
    // 6 bytes > cap 5: the refusal spells the operator's cap and Bash's sentence.
    expect(refusal(() => stageBody({ to: "ub", message: "héllo", bodyFile: "", payloadFile: "" }, { inlineMaxBytes: "0005" })))
      .toEqual({ code: 1, errorClass: "payload_too_large", action: "tap send ub <payload-file>",
        detail: "-m body is 6 bytes (limit 0005). Too big for inline — write it to a file and use: tap send ub <payload-file> (the file form has no size limit)." });
    expect(stageBody({ to: "ub", message: "héllo", bodyFile: "", payloadFile: "" }, { inlineMaxBytes: "6" }).bytes.length).toBe(15);
  });

  test("the cap grammar: signed digits are caps, surrounding whitespace is trimmed, anything else is the default", () => {
    expect(inlineMaxBytes(undefined)).toEqual({ spelled: "102400", value: 102400 });
    expect(inlineMaxBytes("")).toEqual({ spelled: "102400", value: 102400 });
    expect(inlineMaxBytes("+5")).toEqual({ spelled: "+5", value: 5 });
    expect(inlineMaxBytes("-1")).toEqual({ spelled: "-1", value: -1 });
    expect(inlineMaxBytes("5\n")).toEqual({ spelled: "5\n", value: 5 });
    expect(inlineMaxBytes("lots")).toEqual({ spelled: "102400", value: 102400 });
    expect(inlineMaxBytes("9007199254740993")).toEqual({ spelled: "9007199254740993", value: 9007199254740992 });
  });

  test("-f stages the file's exact bytes with no trailing LF added; invalid UTF-8 and NUL survive", () => {
    const dir = tmp();
    const raw = Buffer.from([0x61, 0xff, 0xfe, 0x00, 0x62, 0x0d, 0x0a, 0x63]);
    writeFileSync(join(dir, "b"), raw);
    const s = stageBody({ to: "ub", message: null, bodyFile: join(dir, "b"), payloadFile: "" }, {});
    expect(s.bytes.equals(Buffer.concat([Buffer.from("---\n---\n"), raw]))).toBe(true);
    expect(s.wrapped.equals(s.bytes)).toBe(true);
    // A -f body that itself starts with a fence is still a BODY: the synthetic
    // fence precedes it, so the body's own fence is body and its `id:` counts
    // for nothing at the envelope level.
    writeFileSync(join(dir, "fenced"), "---\nid: not-an-envelope\n---\nx\n");
    const f = stageBody({ to: "ub", message: null, bodyFile: join(dir, "fenced"), payloadFile: "" }, {});
    expect({ kind: f.envelopeKind, id: f.envelopeId, wrap: f.needsWrap }).toEqual({ kind: "", id: "", wrap: false });
  });

  test("-f refusals: not found, not a regular file, unreadable — Bash's classes and actions", () => {
    const dir = tmp();
    expect(refusal(() => stageBody({ to: "ub", message: null, bodyFile: join(dir, "nope"), payloadFile: "" }, {})))
      .toEqual({ code: 1, errorClass: "not_found", action: "tap send ub --body-file <path>", detail: `body file not found: ${join(dir, "nope")}` });
    mkdirSync(join(dir, "d"));
    expect(refusal(() => stageBody({ to: "ub", message: null, bodyFile: join(dir, "d"), payloadFile: "" }, {})))
      .toEqual({ code: 1, errorClass: "usage_error", action: "tap help send", detail: `body file is not a regular file: ${join(dir, "d")}` });
    writeFileSync(join(dir, "locked"), "x", { mode: 0o000 });
    if (process.getuid && process.getuid() !== 0) {
      expect(refusal(() => stageBody({ to: "ub", message: null, bodyFile: join(dir, "locked"), payloadFile: "" }, {})).detail).toBe(`body file is not readable: ${join(dir, "locked")}`);
    }
    chmodSync(join(dir, "locked"), 0o600); // the scratch reaper's lsof walk must be able to stat it
  });

  test("a positional file is judged unwrapped and wrapped only when its first line is not exactly `---`", () => {
    const dir = tmp();
    const rows: Array<{ label: string; body: Buffer; wrap: boolean; kind: string; id: string }> = [
      { label: "own envelope", body: Buffer.from("---\nkind: order\nid: ua-9\n---\nbody\n"), wrap: false, kind: "order", id: "ua-9" },
      { label: "fenceless prose", body: Buffer.from("hello\n"), wrap: true, kind: "", id: "" },
      { label: "empty file", body: Buffer.alloc(0), wrap: true, kind: "", id: "" },
      { label: "CRLF fence is not a fence", body: Buffer.from("---\r\nkind: x\r\n---\r\n"), wrap: true, kind: "", id: "" },
      { label: "BOM before the fence is body", body: Buffer.from("﻿---\nkind: x\n---\n"), wrap: true, kind: "", id: "" },
      { label: "`---` alone with no newline counts as fenced (read -r sets the var)", body: Buffer.from("---"), wrap: false, kind: "", id: "" },
      { label: "fence with no closing fence: fenced, fields unreadable", body: Buffer.from("---\nkind: x\nbody"), wrap: false, kind: "", id: "" },
      { label: "indented key is not a field; kind:x without a space is not a field", body: Buffer.from("---\n kind: a\nkind:b\nkind:\tc\n---\n"), wrap: false, kind: "c", id: "" },
    ];
    for (const row of rows) {
      const p = join(dir, row.label.replace(/[^a-z]/gi, "_"));
      writeFileSync(p, row.body);
      const s = stageBody({ to: "ub", message: null, bodyFile: "", payloadFile: p }, {});
      expect({ label: row.label, wrap: s.needsWrap, kind: s.envelopeKind, id: s.envelopeId, judged: s.judged.equals(row.body), wrapped: s.wrapped.equals(row.wrap ? Buffer.concat([Buffer.from("---\n---\n"), row.body]) : row.body) })
        .toEqual({ label: row.label, wrap: row.wrap, kind: row.kind, id: row.id, judged: true, wrapped: true });
    }
  });

  test("a missing positional refuses with the shell-quoted `-m` correction in the detail and a fixed copyable action", () => {
    expect(refusal(() => stageBody({ to: "ub", message: null, bodyFile: "", payloadFile: "hello there" }, {})))
      .toEqual({ code: 1, errorClass: "not_found", action: "check the payload path, then retry", detail: "payload not found: hello there. Did you mean: tap send ub -m hello\\ there" });
    // A command-shaped path stays out of `next:` on both doors (the native
    // door's rule, native-router.test.ts): the correction is quoted in the
    // detail, the action is constant.
    const shaped = refusal(() => stageBody({ to: "ub", message: null, bodyFile: "", payloadFile: "missing-`tick`-$(echo injected).md" }, {}));
    expect(shaped.action).toBe("check the payload path, then retry");
    expect(shaped.detail).toBe("payload not found: missing-`tick`-$(echo injected).md. Did you mean: tap send ub -m missing-\\`tick\\`-\\$\\(echo\\ injected\\).md");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a/b.md")).toBe("a/b.md");
    expect(shellQuote("it's")).toBe("it\\'s");
    expect(shellQuote("a\nb")).toBe("$'a\\nb'");
  });

  test("effectiveKind and guardApplies key on the explicit ask bit, never the downgraded obligation", () => {
    expect(effectiveKind({ kind: "", kindSet: false }, { envelopeKind: "order" })).toBe("order");
    expect(effectiveKind({ kind: "", kindSet: false }, { envelopeKind: "" })).toBe("discuss");
    expect(effectiveKind({ kind: "probe", kindSet: true }, { envelopeKind: "order" })).toBe("probe");
    expect(guardApplies({ expectReply: false, note: false, inReplyTo: "" }, "discuss")).toBe(true);
    expect(guardApplies({ expectReply: true, note: false, inReplyTo: "" }, "discuss")).toBe(false);
    expect(guardApplies({ expectReply: false, note: true, inReplyTo: "" }, "discuss")).toBe(false);
    expect(guardApplies({ expectReply: false, note: false, inReplyTo: "ua-1" }, "discuss")).toBe(false);
    for (const k of ["lane-request", "probe", "notice", "progress"]) expect(guardApplies({ expectReply: false, note: false, inReplyTo: "" }, k)).toBe(false);
    expect(guardApplies({ expectReply: false, note: false, inReplyTo: "" }, "digest")).toBe(true);
  });
});

describe("checkSource — validation before the bus is bootstrapped", () => {
  test("a named -f and the inline cap refuse before any write; the bootstrap bit is the incumbent's", () => {
    const dir = tmp();
    expect(refusal(() => checkSource({ to: "ub", message: null, bodyFile: join(dir, "nope"), payloadFile: "" }, {})).errorClass).toBe("not_found");
    expect(refusal(() => checkSource({ to: "ub", message: "0123456789", bodyFile: "", payloadFile: "" }, { inlineMaxBytes: "5" })).errorClass).toBe("payload_too_large");
    writeFileSync(join(dir, "b"), "x");
    expect(checkSource({ to: "ub", message: null, bodyFile: join(dir, "b"), payloadFile: "" }, {})).toEqual({ ensureDirs: true });
    expect(checkSource({ to: "ub", message: "hi", bodyFile: "", payloadFile: "" }, {})).toEqual({ ensureDirs: true });
    expect(checkSource({ to: "ub", message: null, bodyFile: "-", payloadFile: "" }, {})).toEqual({ ensureDirs: true });
    // A positional file: the incumbent checked it after staging and bootstrapped after the guard.
    expect(checkSource({ to: "ub", message: null, bodyFile: "", payloadFile: join(dir, "nope") }, {})).toEqual({ ensureDirs: false });
  });
});

describe("envelope bytes — the stamp refuses an undecodable header, the body read never does (lane B)", () => {
  test("stampEnvelope and stampEnvelopeBytes agree byte for byte on every UTF-8-valid shape", () => {
    const routing = { id: "ua-1", from: "ua", to: "ub", kind: "discuss", path: "/bus/payloads/ua-1.md", reply: "settle-only" };
    const corpus = [
      "---\n---\nbody\n", "---\n---\nbody", "---\n---\n", "---\nextra: kept\nid: dropped\n---", "---\n---\n---\nfence in body\n",
      "---\nkind: order\n---\n\n\ntwo blank lines\n", "---\n---\nhéllo ☃ \u3000\r\n", "---\nreply_to: spoofed\n---\nx",
    ];
    for (const src of corpus) {
      const asString = stampEnvelope(src, routing);
      const asBytes = stampEnvelopeBytes(Buffer.from(src, "utf8"), routing);
      expect({ src, same: Buffer.from(asString, "utf8").equals(asBytes.bytes) }).toEqual({ src, same: true });
      expect(asBytes.bytes.subarray(0, Buffer.byteLength(asBytes.header)).toString("utf8")).toBe(asBytes.header);
    }
  });
  test("an undecodable header line: the stamp refuses, the body read returns the exact body", () => {
    const bad = Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x78, 0x3a, 0x20, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0x62, 0xfe, 0x0a]);
    expect(() => stampEnvelopeBytes(bad, { id: "ua-1", from: "ua", to: "ub", kind: "k", path: "/p" })).toThrow(InvalidHeaderEncoding);
    expect(envelopeBodyBytes(bad)!.equals(Buffer.from([0x62, 0xfe, 0x0a]))).toBe(true);
    expect(envelopeBodyBytes(Buffer.from("no fence\n"))).toBeNull();
    expect(envelopeBodyBytes(Buffer.from("---\n---"))!.length).toBe(0);
  });
});

describe("resolveObligation / resolveId / tokenRefusal", () => {
  test("attended sender: the ask bit is the obligation; --fyi changes nothing", () => {
    expect(resolveObligation({ expectReply: true, from: "ua" }, "discuss", { unattended: false, replyToStamped: false }, false)).toEqual({ replyExpect: "expected", warnings: [], refusal: null });
    expect(resolveObligation({ expectReply: false, from: "ua" }, "discuss", { unattended: false, replyToStamped: false }, false).replyExpect).toBe("settle-only");
  });
  test("unattended sender: downgraded with the warning unless a deliverable reply_to grants it; assign refuses instead", () => {
    const down = resolveObligation({ expectReply: true, from: "bot" }, "discuss", { unattended: true, replyToStamped: false }, false);
    expect(down).toEqual({ replyExpect: "settle-only", warnings: ["--ask downgraded to reply=settle-only because --from 'bot' is unattended and has no deliverable reply_to"], refusal: null });
    expect(resolveObligation({ expectReply: true, from: "bot" }, "discuss", { unattended: true, replyToStamped: true }, false).replyExpect).toBe("expected");
    const assign = resolveObligation({ expectReply: true, from: "bot" }, "order", { unattended: true, replyToStamped: false }, true);
    expect(assign.warnings).toEqual([]);
    expect(assign.refusal).toEqual({ code: 1, errorClass: "usage_error", action: "tap help assign",
      detail: "tap assign needs a sender that can receive the reply, and --from 'bot' is unattended with no deliverable reply_to — register the seat with --reply-to <handle>, send from a reply-capable seat, or say it is a note with tap send" });
  });
  test("lane-request lint rides a settle-only obligation, after the downgrade warning", () => {
    const o = resolveObligation({ expectReply: true, from: "bot" }, "lane-request", { unattended: true, replyToStamped: false }, false);
    expect(o.warnings).toEqual([
      "--ask downgraded to reply=settle-only because --from 'bot' is unattended and has no deliverable reply_to",
      "kind=lane-request sent reply=settle-only — a work-order-shaped kind needs a tracked reply obligation (CONTRACT §using-tap); did you mean --ask?",
    ]);
    expect(resolveObligation({ expectReply: false, from: "ua" }, "lane-request", { unattended: false, replyToStamped: false }, false).warnings).toHaveLength(1);
  });
  test("id: --id beats the source's id: beats a mint; charset refusals in Bash's order", () => {
    expect(resolveId({ id: "given" }, { envelopeId: "env" }, "ua")).toBe("given");
    expect(resolveId({ id: "" }, { envelopeId: "env" }, "ua")).toBe("env");
    expect(resolveId({ id: "" }, { envelopeId: "" }, "ua")).toMatch(/^ua-\d{8}T\d{6}Z-[0-9a-f]{12}$/);
    const re = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
    expect(tokenRefusal("bad id", "ua", "ub", "k")!.detail).toBe(`id 'bad id' fails charset ${re}`);
    expect(tokenRefusal("ok", "u a", "u b", "k")!.detail).toBe(`from 'u a' is not a sentinel-safe token (${re})`);
    expect(tokenRefusal("ok", "ua", "u b", "k")!.detail).toBe(`to 'u b' is not a sentinel-safe token (${re})`);
    expect(tokenRefusal("ok", "ua", "ub", "k k")!.detail).toBe(`kind 'k k' is not a sentinel-safe token (${re})`);
    expect(tokenRefusal("ok", "ua", "ub", "k")).toBeNull();
  });
});

describe("writeStaged", () => {
  test("a staged temp is O_EXCL: a pre-planted name (a symlink to another file) is skipped, never followed", () => {
    const home = tmp();
    mkdirSync(join(home, "tmp"), { recursive: true });
    const victim = join(home, "victim.md"); writeFileSync(victim, "untouched\n");
    symlinkSync(victim, join(home, "tmp", "inline-AAAAAA.md"));
    const names = ["AAAAAA", "BBBBBB"];
    const path = writeStaged(home, "inline-", ".md", Buffer.from("staged\n"), () => names.shift()!);
    expect(basename(path)).toBe("inline-BBBBBB.md");
    expect(readFileSync(path).toString("utf8")).toBe("staged\n");
    expect(readFileSync(victim).toString("utf8")).toBe("untouched\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The bound is real: a generator that never finds a free name is an error, not a spin.
    expect(() => writeStaged(home, "inline-", ".md", Buffer.alloc(0), () => "AAAAAA")).toThrow(/EEXIST/);
  });
});
