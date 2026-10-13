// Differential tests use the installed Bash owner where it remains live.
// Retired owners retain fixed byte expectations or an independent Python oracle.
//
// This file exists because of a review finding I could not have written a test
// for. My hand-written unit tests passed 35/35 while four real byte divergences
// sat underneath them — a test I author can only encode a case I already
// imagined, and the ones that bite are the ones I did not. So the oracle for
// these behaviors is the incumbent itself, not my opinion of it.
//
// IT FAILS CLOSED when the reference is unreachable. It used to skip, which meant
// losing the oracle turned every case into a silently passing run. See
// test/support/ref-lib.ts and its own tests.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRealExit, findRefBin } from "./support/ref-lib";
import { removeScratchTree } from "./support/scratch";

import { envelopeField, stampEnvelope, validateEnvelope } from "../src/envelope";
import { idAgeSeconds } from "../src/ids";
import { jsonObj } from "../src/fsatomic";
import { loadRegistry, pyJson } from "../src/registry";
import { renderSentinel } from "../src/sentinel";

/** Independent serializer oracle retained after retiring the Bash adapter. */
function pythonObject(args: string[]): string {
  const r = spawnSync("python3", ["-I", "-c", 'import json,sys; a=sys.argv[1:]; print(json.dumps(dict(zip(a[::2],a[1::2])),separators=(",",":")))', ...args], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
}

/** All differential blocks. Retired shell owners use fixed bytes or independent serialization. */
const d = describe;

const scratch = mkdtempSync(join(tmpdir(), "tap-bun-diff."));
// Repeated comparison runs must not leak scratch dirs (partner review, round 2 minor).
afterAll(() => removeScratchTree(scratch));

function isolatedEnv(indexHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    TAP_INDEX_HOME: indexHome,
    TAP_ONBOARDING_CHECKED: undefined,
    TAP_SESSION_MANIFEST: join(indexHome, "sessions.json"),
    OPENCODE_DB_PATH: join(indexHome, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(indexHome, "version-seen.json"),
    TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
    TMUX: undefined,
    TMUX_PANE: undefined,
  };
}

const FAKE_PANE = "sandbox:0.0";
function fakePaneEnv(indexHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = join(indexHome, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case " $* " in
  *"#{pane_id}"*"#{session_name}"*"#{pid}:#{start_time}"*) printf '%%700\\tsandbox\\t123:456\\n' ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_id}"*) printf '%%700\\tsandbox\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  return isolatedEnv(indexHome, { ...extra, PATH: `${bin}:${process.env.PATH}` });
}

function payload(name: string, contents: string): string {
  const p = join(scratch, name);
  writeFileSync(p, contents);
  return p;
}

// Fixed verdicts: the Bash incumbent (tap_validate_envelope) was deleted once it
// had no caller; these are the answers it gave, which native matched while both lived.
d("envelope validation keeps the incumbent verdicts", () => {
  const cases: Array<[string, string, boolean]> = [
    ["well-formed", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\n", true],
    // A trailing space survives the incumbent's leading-only strip and then
    // fails the charset. A trimming parser would call this valid.
    ["trailing space in a value", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss \npath: /b/a.md\n---\n", false],
    // The key is anchored at column zero; an indented key is simply not a field.
    ["leading space before a key", "---\n id: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\n", false],
    // The separator must be followed by space or tab.
    ["no space after the colon", "---\nid:a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\n", false],
    ["tab after the colon", "---\nid:\ta-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\n", true],
    ["empty value", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind:\npath: /b/a.md\n---\n", false],
    ["whitespace in path", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a b.md\n---\n", false],
    ["bracket in path", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a]b.md\n---\n", false],
    ["missing opening fence", "id: a-20260823T100000Z-ff\nfrom: s\n---\n", false],
    ["no closing fence", "---\nid: a-20260823T100000Z-ff\nfrom: s\n", false],
    ["body line that looks like a fence", "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\nbody\n---\nmore\n", true],
    ["CR line endings in the frontmatter", "---\nid: a-20260823T100000Z-ff\r\nfrom: s\r\nto: r\r\nkind: discuss\r\npath: /b/a.md\r\n---\n", true],
  ];

  for (const [label, raw, want] of cases) {
    test(label, () => {
      expect({ label, ok: validateEnvelope(raw).ok }).toEqual({ label, ok: want });
    });
  }
});

d("envelope field reads retain the retired Bash values", () => {
  const cases: Array<[string, string, string, string | undefined]> = [
    ["first match wins on a duplicate key", "id", "---\nid: good\nid: bad space\n---\n", "good"],
    ["value keeps its internal colons", "pane", "---\npane: sess:0.0\n---\n", "sess:0.0"],
    ["leading separator whitespace is stripped", "kind", "---\nkind:   discuss\n---\n", "discuss"],
    ["trailing whitespace is NOT stripped", "kind", "---\nkind: discuss  \n---\n", "discuss  "],
    ["a CR is removed from the end", "kind", "---\nkind: discuss\r\n---\n", "discuss"],
    ["an indented key is not a field", "id", "---\n  id: x\n---\n", undefined],
    ["a colon with no space is not a field", "id", "---\nid:x\n---\n", undefined],
    ["a key after the closing fence is not read", "late", "---\nid: x\n---\nlate: nope\n", undefined],
  ];

  for (const [label, key, raw, ref] of cases) {
    test(label, () => {
      expect({ label, v: envelopeField(raw, key) }).toEqual({ label, v: ref });
    });
  }
});

// The Bash stamp (tap_stamp_envelope) is gone; these are the bytes it produced,
// pinned as fixed expectations so the port keeps them without an oracle.
d("stamped bytes keep the retired incumbent's pinned shape", () => {
  const S = "id: ID\nfrom: F\nto: T\nkind: K\npath: /p\nreply: expected\n---\n";
  const cases: Array<[string, string, string]> = [
    ["minimal empty frontmatter", "---\n---\nhello\n", `---\n${S}hello\n`],
    ["writer extras survive in place", "---\nre: keepme\nverdict: ok\n---\nbody\n", `---\nre: keepme\nverdict: ok\n${S}body\n`],
    // `id:forged` has no space after the colon, so the incumbent's drop pattern
    // does NOT match it and it survives as ordinary text. Dropping it would
    // delete writer content.
    ["blank lines and an unrecognized id:forged survive", "---\nre: keep\n\nid:forged\nweird\n---\nbody\n", `---\nre: keep\n\nid:forged\nweird\n${S}body\n`],
    ["writer copies of owned fields are dropped", "---\nid: forged\nfrom: forged\npath: /forged\nre: keep\n---\nbody\n", `---\nre: keep\n${S}body\n`],
    ["a body containing a fence is untouched", "---\nre: k\n---\nintro\n---\nmore\n", `---\nre: k\n${S}intro\n---\nmore\n`],
    ["no trailing newline on the body", "---\n---\nno newline", `---\n${S}no newline`],
    ["empty body", "---\n---\n", `---\n${S}`],
  ];

  for (const [label, src, expected] of cases) {
    test(label, () => {
      const mine = stampEnvelope(src, { id: "ID", from: "F", to: "T", kind: "K", path: "/p", reply: "expected" });
      expect({ label, mine }).toEqual({ label, mine: expected });
    });
  }
});

d("receipt bytes retain Python JSON serialization", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["plain ascii", { id: "x", status: "done" }],
    // python's json.dumps defaults to ensure_ascii=True; JS does not.
    ["non-ascii is escaped", { preview: "café ☕" }],
    ["an emoji outside the BMP", { preview: "ok 🎯" }],
    ["an empty value is encoded, not dropped", { id: "x", epoch: "", status: "done" }],
    ["a quote in a value", { pane: 'a:"0.0' }],
    ["a backslash in a value", { path: "a\\b" }],
    ["a newline in a value", { line: "one\ntwo" }],
    ["a tab in a value", { line: "one\ttwo" }],
  ];

  for (const [label, fields] of cases) {
    test(label, () => {
      const ref = pythonObject(Object.entries(fields).flat());
      expect({ label, mine: `${jsonObj(fields)}\n` }).toEqual({ label, mine: ref });
    });
  }
});

d("reply evidence: the fields that carry arbitrary user prose", () => {
  // reply_preview is the one receipt field no charset fence can protect, because
  // it IS a message body. Lane D bounded the ensure_ascii case as unreachable in
  // their lane and asked me to check mine rather than credit it — this is the
  // check, kept as a test so the reachability claim cannot rot.
  const cases: Array<[string, string]> = [
    ["plain prose", "an ordinary reply"],
    ["accented latin", "café"],
    ["a BMP symbol", "coffee ☕"],
    ["an astral emoji (surrogate pair)", "target 🎯"],
    ["angle brackets and ampersand — ordinary prose, not exotic", "a < b && c > d"],
    ["a quote inside prose", 'she said "no"'],
  ];
  for (const [label, preview] of cases) {
    test(label, () => {
      const ref = pythonObject(["id", "x", "via", "reply", "reply_preview", preview]);
      expect({ label, mine: `${jsonObj({ id: "x", via: "reply", reply_preview: preview })}\n` })
        .toEqual({ label, mine: ref });
    });
  }

  // A CRLF body is byte-PRESERVED in the sha and whitespace-COLLAPSED in the
  // preview — the same bytes treated differently by two fields of one receipt.
  // Verified live against the incumbent: sha c673c379..., preview
  // "crlf line one crlf line two". An implementation that normalized line
  // endings on read would diverge in the sha ONLY, which no preview test sees.
  test("a CRLF body: preserved in the digest, collapsed in the preview", () => {
    const body = "crlf line one\r\ncrlf line two\r\n";
    expect(createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"))
      .toBe("c673c3794b25bd89cce9afd07e56ec1b7c295e09632f4b378ae591870ee51b91");
    const ref = pythonObject(["reply_preview", "crlf line one crlf line two"]);
    expect(`${jsonObj({ reply_preview: "crlf line one crlf line two" })}\n`).toBe(ref);
  });
});

d("registry serialization is byte-identical to python's json.dump", () => {
  // The registry is the widest interop surface there is: the incumbent READS
  // rows this code writes. Two shapes that never occur in an ordinary ASCII seat
  // row defeated my first serializer, so they are pinned here against python
  // itself rather than against my belief about python.
  const cases: Array<[string, unknown]> = [
    ["an ordinary seat row", { schema: "0.20", seats: { snd: { pane: "snd:0.0", status: "active" } } }],
    ["integer-like keys", { "10": 1, "2": 1, b: 3 }],
    ["non-ascii values", { b: "café ☕" }],
    ["non-ascii KEYS", { "café": 1, a: 2 }],
    ["an emoji outside the BMP", { b: "ok 🎯" }],
    ["empty object and array", { a: {}, b: [] }],
    ["nested arrays and objects", { c: { d: [1, 2, { e: "f" }] } }],
    ["null and booleans and numbers", { a: null, b: true, c: false, d: 0, e: -1 }],
    ["a quote and a backslash", { a: 'q"uote', b: "back\\slash" }],
  ];

  for (const [label, value] of cases) {
    test(label, () => {
      const ref = pythonDump(JSON.stringify(value));
      expect({ label, mine: `${pyJson(value, 0)}\n` }).toEqual({ label, mine: ref });
    });
  }

  // Astral KEYS, not just astral values. python's sorted() compares CODE POINTS
  // while JS sort compares UTF-16 code UNITS, so a surrogate pair (starting
  // 0xD800) sorts below the private-use area in JS and above it in python.
  test("an astral key sorts after the private-use area, as python does", () => {
    const raw = JSON.stringify({ [String.fromCodePoint(0x10000)]: 1, [String.fromCodePoint(0xe000)]: 2 });
    expect(`${pyJson(JSON.parse(raw), 0)}\n`).toBe(pythonDump(raw));
  });

  // THE FIXTURE MUST START FROM RAW BYTES when the property under test is a
  // host-language parse difference. Routing the input through JSON.stringify
  // erases exactly the distinction being measured before python ever sees it —
  // a fixture more generous than the world (partner review, unit 2 round 2).
  // `-0.0` is a FLOAT and is refused at load (see loadRegistry) rather than
  // guessed at, because JavaScript cannot tell it from the integer `-0`, which
  // python loads and dumps as `0`. The integer form is what the supported domain
  // covers, and it must agree with python.
  test("integer negative zero normalizes to 0, exactly as python does", () => {
    const raw = '{"a": -0, "b": 1}';
    expect(`${pyJson(JSON.parse(raw, (_k, v) => (Object.is(v, -0) ? 0 : v)), 0)}\n`).toBe(pythonDump(raw));
  });

  test("a registry read from raw bytes re-serializes identically", () => {
    const raw = '{"schema": "0.20", "seats": {"s": {"pane": "s:0.0", "status": "active"}}}';
    expect(`${pyJson(JSON.parse(raw), 0)}\n`).toBe(pythonDump(raw));
  });
});

d("sentinel bytes retain the retired Bash constructor's wire", () => {
  // Fixed wire expectations keep the parity cases meaningful after Bash retirement.
  const cases: Array<[string, string[], string]> = [
    ["v0.23 ask", ["snd", "rcv", "snd-20260904T100000Z-aabbccddeeff", "discuss", "expected", "", "/bus/payloads/x.md"], "[[TAP v0.23 ask snd-20260904T100000Z-aabbccddeeff]]"],
    ["v0.23 note", ["snd", "rcv", "id1", "notice", "settle-only", "", "/p.md"], "[[TAP v0.23 note id1]]"],
    ["v0.23 urgent is a bare tag", ["snd", "rcv", "id1", "discuss", "expected", "urgent", "/p.md"], "[[TAP v0.23 ask id1 urgent]]"],
    ["escalation without interrupt permission", ["snd", "rcv", "id1", "escalate", "expected", "", "/p.md"], "[[TAP v0.23 ask id1 escalate]]"],
    ["escalation with explicit interrupt permission", ["snd", "rcv", "id1", "escalate", "expected", "urgent", "/p.md"], "[[TAP v0.23 ask id1 escalate urgent]]"],
    ["v0.23 digest is a bare tag", ["t/courier", "t/seat", "courier-20260904T100000Z-0123456789ab", "digest", "settle-only", "", "/i.json"], "[[TAP v0.23 note courier-20260904T100000Z-0123456789ab digest]]"],
    ["v0.23 an ordinary kind leaves the wire", ["snd", "rcv", "id1", "handoff", "expected", "", "/p.md"], "[[TAP v0.23 ask id1]]"],
    // The sandbox has no enrolled sender team. A cross-team id alone cannot
    // locate its bus, so both constructors must retain the path pointer.
    // Compare the whole wire; matching only the id prefix would miss this gap.
    ["v0.23 an unindexed cross-team sender retains the path pointer", ["blue/gate", "tap/x", "id1", "discuss", "expected", "", "/p.md"], "[[TAP v0.23 ask blue/id1 path=/p.md]]"],
    ["v0.23 same-team qualified takes no prefix", ["tap/a", "tap/b", "id1", "discuss", "expected", "", "/p.md"], "[[TAP v0.23 ask id1]]"],
    ["v0.23 a BARE recipient is same-team, not cross-team", ["tap/a", "b", "id1", "discuss", "expected", "", "/p.md"], "[[TAP v0.23 ask id1 path=/p.md]]"],
    ["v0.23 a path with dots and dashes", ["a", "b", "id1", "k", "expected", "", "/x/y-z/.tap/bus/payloads/id1.md"], "[[TAP v0.23 ask id1]]"],
    // Section 1's inline note body. The last four rows are the eligibility rule's
    // edges, and the astral one is not decoration: bash counts `${#body}` in code
    // points under a UTF-8 LC_CTYPE while JavaScript's `.length` counts UTF-16
    // units, so an emoji is 1 there and 2 here. A rule written with `.length`
    // agrees with bash on every ASCII case and disagrees at the boundary — which
    // is the shape of difference a parity suite exists to find.
    ["v0.23 an eligible note body inlines", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "gate green at 7f1c2d, squashing"], "[[TAP v0.23 note id1: gate green at 7f1c2d, squashing]]"],
    ["v0.23 an ask never inlines", ["snd", "rcv", "id1", "discuss", "expected", "", "/p.md", "gate green at 7f1c2d"], "[[TAP v0.23 ask id1]]"],
    ["v0.23 a body holding ]] takes the read path", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "see x]] then y"], "[[TAP v0.23 note id1]]"],
    ["v0.23 a body holding a newline takes the read path", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "line one\nline two"], "[[TAP v0.23 note id1]]"],
    ["v0.23 a 200-code-point body inlines", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "x".repeat(200)], `[[TAP v0.23 note id1: ${"x".repeat(200)}]]`],
    ["v0.23 a 201-code-point body does not", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "x".repeat(201)], "[[TAP v0.23 note id1]]"],
    ["v0.23 an astral body well past 200 bytes does not inline", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "\u{1F600}".repeat(150)], "[[TAP v0.23 note id1]]"],
    ["v0.23 a body never rides alongside path=", ["tap/a", "b", "id1", "discuss", "settle-only", "", "/p.md", "suppressed"], "[[TAP v0.23 note id1 path=/p.md]]"],
    ["v0.23 the length limit is 200 BYTES, not characters", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "\u{1F600}".repeat(50)], `[[TAP v0.23 note id1: ${"\u{1F600}".repeat(50)}]]`],
    // tap-7r3fn.208: a token-initial @ or / opens the recipient composer's picker, which eats the submit Enter.
    ["v0.23 a body with a token-initial @ takes the read path", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "@codex review tap#2312"], "[[TAP v0.23 note id1]]"],
    ["v0.23 a body with a token-initial / takes the read path", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "see /tmp/x"], "[[TAP v0.23 note id1]]"],
    ["v0.23 a mid-token @ or / still inlines", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "mail user@host about a/b"], "[[TAP v0.23 note id1: mail user@host about a/b]]"],
    ["v0.23 201 bytes does not inline", ["snd", "rcv", "id1", "discuss", "settle-only", "", "/p.md", "\u{1F600}".repeat(51)], "[[TAP v0.23 note id1]]"],
  ];
  for (const [label, argv, ref] of cases) {
    test(label, () => {
      const [from, to, id, kind, reply, urgency, path, body] = argv as [string, string, string, string, string, string, string, string | undefined];
      expect({ label, mine: renderSentinel({ from, to, id, kind, reply, urgency: urgency || undefined, path, body }) })
        .toEqual({ label, mine: ref });
    });
  }
});

d("the number domain boundary, pinned against python from RAW BYTES", () => {
  // Every case states what PYTHON does with the same bytes, so the boundary is
  // justified by the reference rather than by my convenience. Accepted forms
  // must agree with python; refused forms are the ones where agreement is
  // IMPOSSIBLE in JavaScript, and refusing beats silently differing.
  const accepted: Array<[string, string]> = [
    ["zero", '{"a": 0}'],
    ["a positive integer", '{"a": 42}'],
    ["a negative integer", '{"a": -7}'],
    ["the largest safe integer", '{"a": 9007199254740991}'],
    ["the smallest safe integer", '{"a": -9007199254740991}'],
    ["integer -0, which python itself dumps as 0", '{"a": -0}'],
    ["integers nested in a realistic registry", '{"schema": "0.20", "seats": {"s": {"n": 1}}}'],
  ];
  for (const [label, raw] of accepted) {
    test(`accepted: ${label}`, () => {
      const f = join(scratch, `num-${label.replace(/\W+/g, "-")}.json`);
      writeFileSync(f, raw);
      // Loaded from the real bytes through the real loader, then serialized —
      // the full path an interop peer would exercise.
      expect(`${pyJson(loadRegistry(f), 0)}\n`).toBe(pythonDump(raw));
    });
  }

  const refused: Array<[string, string, RegExp]> = [
    // python: 9007199254740993. JS: 9007199254740992, silently. That is
    // CORRUPTION, and python can author the input.
    ["an unsafe integer", '{"a": 9007199254740993}', /exceeds the safe-integer range/],
    ["a float", '{"a": 1.0}', /outside the supported value domain/],
    ["an exponent", '{"a": 1e3}', /outside the supported value domain/],
    ["float negative zero", '{"a": -0.0}', /outside the supported value domain/],
  ];
  for (const [label, raw, why] of refused) {
    test(`refused: ${label}`, () => {
      const f = join(scratch, `bad-${label.replace(/\W+/g, "-")}.json`);
      writeFileSync(f, raw);
      expect(() => loadRegistry(f)).toThrow(why);
      // The refusal is only defensible if python really does something JS
      // cannot match. Assert that directly: python's own output for these bytes
      // differs from what this implementation would produce after JSON.parse has
      // collapsed the value. (Not a literal round-trip check — python normalizes
      // `1e3` to `1000.0`, so the input lexeme need not survive; what matters is
      // that python's ANSWER is one we could not have reproduced.)
      const py = pythonDump(raw).trim();
      const collapsed = `{\n  "a": ${String(JSON.parse(raw).a)}\n}`;
      expect(py).not.toBe(collapsed);
    });
  }
});

/** python's own answer for a given JSON document, taken from RAW BYTES. */
function pythonDump(rawJson: string): string {
  return spawnSync("python3", ["-c",
    "import json,sys; print(json.dumps(json.loads(sys.argv[1]), indent=2, sort_keys=True))",
    rawJson], { encoding: "utf8" }).stdout ?? "";
}

d("id age matches the retired incumbent's pinned answers, including its refusals", () => {
  // The Bash incumbent (lib.sh tap_id_age_seconds, python datetime) is deleted;
  // these are its recorded answers at NOW, so the native reader keeps the
  // incumbent's calendar refusals and the future-stamp clamp + warning.
  const NOW = 1787481600;
  const cases: Array<[string, string, number | null, boolean]> = [
    ["an ordinary past stamp", "s-20260823T100000Z-abc", 2400, false],
    // Date.parse normalizes Feb 31 into March 3 and answers confidently; the
    // incumbent's datetime() raised and exited 1.
    ["an impossible calendar date", "s-20260231T100000Z-abc", null, false],
    ["month 13", "s-20261301T100000Z-abc", null, false],
    ["hour 25", "s-20260823T250000Z-abc", null, false],
    ["a future stamp clamps to 0", "s-20270101T100000Z-abc", 0, true],
    ["no stamp at all", "not-an-id", null, false],
    ["a leap day that exists", "s-20280229T100000Z-abc", 0, true],
    ["a leap day that does not", "s-20260229T100000Z-abc", null, false],
    // Date.UTC(y, ...) reads a year in 0..99 as an OFFSET FROM 1900, so year 1
    // silently becomes 1901 while the incumbent accepted it as year 1.
    ["year 1", "s-00010101T000000Z-abc", 63923078400, false],
    ["year 99", "s-00991231T235959Z-abc", 60798940801, false],
  ];

  for (const [label, id, ref, refWarned] of cases) {
    test(label, () => {
      // Capture the warning EFFECT as well as the number. Asserting only the
      // return value would leave every test green if the required future-stamp
      // warning were deleted (partner review, round 2) — and a silent clamp turns
      // a broken clock into a permanently young obligation nothing surfaces.
      const warnings: string[] = [];
      const mine = idAgeSeconds(id, NOW, (m) => warnings.push(m));
      expect({ label, mine }).toEqual({ label, mine: ref });
      expect({ label, warned: warnings.length > 0 }).toEqual({ label, warned: refWarned });
      if (refWarned) {
        expect(warnings.join("")).toContain(`payload id '${id}' is future-stamped`);
        expect(warnings.join("")).toContain("treating age as 0");
      }
    });
  }
});

// ---------------------------------------------------------------------------

describe("EXIT CODES on an unanchored cwd — the arms the oracle's 30 could not have", () => {
  // Found by hand, not by the suite, and that is the finding. Every one of the
  // oracle's 30 contract arms runs somewhere a registry EXISTS, so the entire
  // "no acting registry here" branch was a constant across the whole evidence
  // set — the fixture was more generous than the world. `whoami` was returning
  // 4 where the incumbent returns 2, and nothing was positioned to notice.
  //
  // CONTRACT.md scopes `unanchored_bus`/4 to poll, outstanding and peek; send
  // RETIRES 4 and uses 1; whoami is not in the class at all (the deleted tap-whoami.sh
  // passes no code, so it takes the default 2). One shared helper hardcoding 4
  // for every caller cannot express that, which is why the code is now a
  // required parameter with no default.
  // RESOLVED, not constructed from this file's position in the filesystem. The
  // first version walked four parents and appended tap/scripts/tap.sh, which
  // exists only in the author's scratch layout; in a reviewer's detached clone
  // it resolved to nothing, bash exited 127, and these arms cheerfully compared
  // candidate exit codes against "command not found" (partner review).
  const REF = findRefBin();
  const MINE = join(import.meta.dir, "..", "main.ts");

  /** Run one argv through both implementations from a cwd with no bus. */
  function both(argv: string[]): { ref: number; mine: number } {
    const sandbox = mkdtempSync(join(tmpdir(), "tap-unanchored."));
    const env = isolatedEnv(sandbox);
    const opts = { cwd: sandbox, env, encoding: "utf8" as const };
    const ref = spawnSync("bash", [REF, ...argv], opts);
    const mine = spawnSync("bun", [MINE, ...argv], opts);
    removeScratchTree(sandbox);
    return { ref: ref.status ?? -1, mine: mine.status ?? -1 };
  }

  for (const argv of [["whoami"], ["send", "x", "-m", "hi"], ["done", "abc"], ["poll"], ["outstanding"]]) {
    test(`\`tap ${argv.join(" ")}\` agrees with the incumbent`, () => {
      const { ref, mine } = both(argv);
      // `ref >= 0` was the ORIGINAL guard here, and it was the bug: 127 is >= 0.
      // A shell's could-not-run codes are the shell answering, not the program,
      // so they are rejected by name rather than by sign.
      assertRealExit(ref, `reference \`tap ${argv.join(" ")}\``);
      assertRealExit(mine, `candidate \`tap ${argv.join(" ")}\``);
      expect(mine).toBe(ref);
    }, 30_000);
  }
});

describe("a REGISTERED pane queried from the wrong cwd — the arm the oracle has no shape for", () => {
  // The partner reviewer's required arm. The oracle covers registered-success and a
  // live UNREGISTERED pane exiting 2; it has no wrong-cwd REGISTERED-pane case,
  // so a future 30/30 would have been a false closure for this divergence.
  //
  // Deterministic and production-safe: a sandboxed TAP_INDEX_HOME whose global
  // + acting registries claim a fake pane on an explicitly pinned fake socket.
  // No operator pane or registry is read or written.
  const MAIN = join(import.meta.dir, "..", "main.ts");

  function sandboxClaimingPane() {
    const root = mkdtempSync(join(tmpdir(), "tap-wrong-cwd."));
    const indexHome = join(root, "index");
    const teamRoot = join(root, "team");
    const cwd = join(root, "elsewhere");
    const bin = join(root, "bin");
    for (const path of [indexHome, teamRoot, cwd, bin]) mkdirSync(path, { recursive: true });
    const pane = "sandbox:0.0";
    const paneId = "%700";
    writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import sys
fmt = sys.argv[-1]
values = {"pane_id": "%700", "pane_tty": "/dev/ttyfixture", "session_name": "sandbox",
          "window_index": "0", "pane_index": "0", "pane_current_command": "claude",
          "pane_dead": "0", "pane_pid": "4242", "pid": "123", "start_time": "456"}
if "#{" not in fmt:
    sys.exit(1)
for key, value in values.items():
    fmt = fmt.replace("#{" + key + "}", value)
if "#{" in fmt:
    sys.exit(1)
print(fmt)
`, { mode: 0o755 });
    const acting = join(teamRoot, "team-registry.json");
    writeFileSync(acting, JSON.stringify({
      schema: "0.20",
      team: { name: "sandboxteam" },
      seats: { "sandbox-seat": { pane, pane_id: paneId, session: "sandbox", server_epoch: "srv:123:456", status: "active" } },
    }));
    writeFileSync(join(indexHome, "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: { sandboxteam: { root: teamRoot, registry_location: acting, state: "registered" } },
    }));
    const env = isolatedEnv(indexHome, {
      PATH: `${bin}:${process.env.PATH}`,
      TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
      TAP_HOME: undefined,
    });
    return { root, teamRoot, cwd, pane, env };
  }

  test("exits 2, names unanchored_bus, and its remedy is a command this binary accepts", () => {
    const s = sandboxClaimingPane();

    const r = spawnSync("bun", [MAIN, "whoami", "--pane", s.pane], {
      cwd: s.cwd, encoding: "utf8",
      env: s.env,
    });

    // 2, not 4: CONTRACT scopes unanchored_bus/4 to poll/outstanding/peek, and
    // tap-whoami.sh passed no code, so it took the default 2. The generic
    // context layer used to leak 4 through whoami.
    const ref = spawnSync("bash", [findRefBin(), "whoami", "--pane", s.pane], {
      cwd: s.cwd, encoding: "utf8", env: s.env,
    });
    assertRealExit(ref.status ?? -1, "reference whoami");
    expect(ref.status, ref.stderr).toBe(2);
    expect(ref.stderr).toContain("registered as 'sandbox-seat'");
    expect(ref.stderr).toContain("next: cd ");
    expect(r.status, JSON.stringify({ mine: r.stderr, reference: ref.stderr, referenceCode: ref.status })).toBe(2);
    expect(r.stderr).toContain("unanchored cwd");
    // The pane is found ACROSS enrolled teams, so the message can name it.
    expect(r.stderr).toContain("sandbox-seat");

    // THE HALF THAT MATTERS MOST: the remedy must be executable. `--team` is
    // not an option whoami takes, so suggesting it sends the operator into a
    // second error produced by the first error's advice.
    const remedy = r.stderr.split("next:")[1]?.trim() ?? "";
    expect(remedy.startsWith("cd ")).toBe(true);
    expect(remedy).not.toContain("--team");

    // And the remedy actually works — asserted, not assumed.
    const cured = spawnSync("bun", [MAIN, "whoami", "--pane", s.pane], {
      cwd: remedy.slice(3).trim(), encoding: "utf8",
      env: s.env,
    });
    expect(cured.status).toBe(0);
    expect(cured.stdout.trim()).toBe("sandbox-seat");

    removeScratchTree(s.root);
  }, 30_000);

  test("a directory registry keeps pane-specific recovery instead of the generic --team action", () => {
    const s = sandboxClaimingPane();
    const registry = join(s.cwd, ".tap", "bus", "registry.json"), target = join(s.root, "registry-directory");
    mkdirSync(registry, { recursive: true }); mkdirSync(target);
    for (const shape of ["directory", "symlink-directory"] as const) {
      if (shape === "symlink-directory") {
        rmSync(registry, { recursive: true });
        symlinkSync(target, registry);
      }
      const r = spawnSync("bun", [MAIN, "whoami", "--pane", s.pane], { cwd: s.cwd, encoding: "utf8", env: s.env });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("registered as 'sandbox-seat'");
      expect(r.stderr).toContain("next: cd ");
      expect(r.stderr).not.toContain("--team");
    }
    removeScratchTree(s.root);
  }, 30_000);
});

describe("Unanchored whoami guidance preserves logical cwd and exit codes", () => {
  const REF = findRefBin();
  const MINE = join(import.meta.dir, "..", "main.ts");

  /** Same argv, same cwd, same index home, through both implementations. */
  function bothStderr(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const opts = { cwd, env, encoding: "utf8" as const };
    const ref = spawnSync("bash", [REF, ...argv], opts);
    const mine = spawnSync("bun", [MINE, ...argv], opts);
    assertRealExit(ref.status ?? -1, "reference");
    assertRealExit(mine.status ?? -1, "candidate");
    return { ref, mine };
  }

  test("under a LOGICAL path alias, the printed cwd matches the incumbent's", () => {
    // Build the alias explicitly: this control must reach logical/physical
    // divergence on Linux as well as on macOS's usual /tmp alias.
    const root = mkdtempSync(join(tmpdir(), "tap-logical."));
    const target = join(root, "physical");
    mkdirSync(target);
    const logical = join(root, "logical");
    symlinkSync(target, logical, "dir");
    const physical = realpathSync(logical);
    expect(physical).not.toBe(logical);

    const idx = mkdtempSync(join(tmpdir(), "tap-idx."));
    // PWD is what a shell exports after `cd -L`; passing it is what makes the
    // logical name observable to the child at all.
    const env = fakePaneEnv(idx, { PWD: logical, TAP_HOME: undefined });
    const { ref, mine } = bothStderr(["whoami", "--pane", FAKE_PANE], logical, env);

    expect(mine.stderr).toContain(logical);
    expect(mine.stderr).not.toContain(physical);
    expect(mine.stderr).toContain("Start one: tap session launch");
    expect(mine.status).toBe(ref.status);

    removeScratchTree(root);
    removeScratchTree(idx);
  }, 30_000);

  test("when NO enrolled team claims the pane, name the launch door and retain the exit code", () => {
    // The fallthrough the partner reviewer caught: fixing only the cross-enrolled
    // branch left the commoner case — a fresh index, nothing enrolled — still
    // recommending `--team`, an option this binary rejects. Advice that
    // produces a second error is worse than a terse refusal.
    const idx = mkdtempSync(join(tmpdir(), "tap-idx-empty."));
    const cwd = mkdtempSync(join(tmpdir(), "tap-nowhere."));
    const env = fakePaneEnv(idx, { PWD: cwd, TAP_HOME: undefined });
    const { ref, mine } = bothStderr(["whoami", "--pane", FAKE_PANE], cwd, env);

    expect(mine.stderr).toContain("Start one: tap session launch");
    expect(mine.status).toBe(ref.status);
    // Named explicitly, so a future refactor that restores the generic message
    // reds here rather than only in the byte comparison.
    expect(mine.stderr).not.toContain("--team");
    expect(mine.stderr).toContain("next: tap session launch <harness|preset> <name>");

    removeScratchTree(idx);
    removeScratchTree(cwd);
  }, 30_000);
});

describe("poll BYTE fidelity — found by pre-reading the oracle's newest arm, not by the suite", () => {
  // The shared oracle grew `poll.byte-fidelity-with-reference` because thirty
  // arms asserted BEHAVIOUR and none asserted BYTES. Rather than spend a
  // scheduled window discovering whether I pass it, I ran its shape by hand
  // first — and found two divergences my 265 green tests were silent about.
  //
  //   1. The poll header printed the team as the bus root's BASENAME. The
  //      incumbent (lib.sh tap_spool_team_name) reads `team.name` from the
  //      acting registry pre-flip, so a temp-directory name appeared where the
  //      team belonged. I had generalised a correct rule — "team.name is
  //      pre-authority, never trust it" — from the flip-live path, where there
  //      IS an enrollment key, into the pre-flip path, where there is not and
  //      the incumbent deliberately does the opposite.
  //   2. Payload paths printed unresolved. The incumbent realpaths the bus, and
  //      the direction is OPPOSITE to displayCwd's: `$PWD` for where the caller
  //      is, realpath for where a file actually lives.
  const REF = join(import.meta.dir, "../../../bin/tap");
  const MINE = join(import.meta.dir, "..", "main.ts");

  /** A bus with a seeded acting registry, and optionally one inbound payload. */
  function seedBus(withPayload: boolean, teamName: unknown = "fidelityteam") {
    const root = mkdtempSync(join(tmpdir(), "tap-fidelity."));
    spawnSync("git", ["init", "-q", root]);
    const bus = join(root, ".tap", "bus");
    mkdirSync(join(bus, "payloads"), { recursive: true });
    mkdirSync(join(bus, "receipts"), { recursive: true });
    const idx = join(root, "idx");
    mkdirSync(idx, { recursive: true });
    writeFileSync(join(bus, "registry.json"), JSON.stringify({
      schema: "0.20",
      team: { name: teamName },
      seats: {
        me: { pane: "x:0.0", pane_id: "%1", status: "active" },
        you: { pane: "y:0.0", pane_id: "%2", status: "active" },
      },
    }));
    // Born live (F1): the header's team is the enrollment key, never team.name.
    writeFileSync(join(idx, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      fidelityteam: { root, registry_location: join(bus, "registry.json"), state: "registered" },
    } }));
    if (withPayload) {
      const id = "you-20260824T000000Z-abcdef123456";
      const p = join(bus, "payloads", `${id}.md`);
      writeFileSync(p, [
        "---", `id: ${id}`, "from: you", "to: me", "kind: discuss",
        `path: ${p}`, "reply: expected", "---", "hello", "",
      ].join("\n"));
    }
    return { root, bus, idx };
  }

  for (const populated of [false, true]) {
    test(`poll's output matches the reference byte for byte on a ${populated ? "populated" : "empty"} inbox`, () => {
      const s = seedBus(populated);
      const env = isolatedEnv(s.idx, { TAP_HOME: s.bus, PWD: s.root, TAP_SPOOL_NOW: "1788615000" });
      const opts = { cwd: s.root, env, encoding: "utf8" as const };
      const ref = spawnSync("bash", [REF, "poll", "me"], opts);
      const mine = spawnSync("bun", [MINE, "poll", "me"], opts);
      assertRealExit(ref.status ?? -1, "reference poll");
      assertRealExit(mine.status ?? -1, "candidate poll");

      // The fixture's own premise: both an empty and a populated inbox exit 0
      // (pending mail is state, not an error), so the output proves which one
      // this is. Without this the arm passes when the payload was never seen.
      expect(ref.status).toBe(0);
      expect(ref.stdout.includes("tap poll: empty")).toBe(!populated);

      expect(mine.stdout).toBe(ref.stdout);
      expect(mine.stderr).toBe(ref.stderr);
      expect(mine.status).toBe(ref.status);
      // Named, so a regression reds on the REASON and not only on a diff.
      if (populated) {
        expect(mine.stdout).toContain("fidelityteam/me");
        // Compact poll no longer prints payload paths. The age must
        // still come from the injected clock on both doors.
        expect(mine.stdout).toContain("1085400s");
        expect(mine.stdout).not.toContain("path:");
        expect(mine.stdout).toContain("next step: tap reply you-20260824T000000Z-abcdef123456 -f <file>");
      }

      removeScratchTree(s.root);
    }, 30_000);
  }

  test("a NON-STRING team.name is missing data, never `[object Object]`", () => {
    // The partner reviewer's probe, made permanent. `String({decoy:true})` yields the
    // literal "[object Object]" — a plausible-looking string that then becomes
    // Context.team, renders in the poll header, AND drives to_team receive and
    // settlement filtering. A coerced label deciding message routing.
    //
    // The incumbent gets this free: python `.strip()` on a dict raises inside
    // its caught block, so a malformed value yields nothing and the documented
    // fallback runs. JS coerces instead of raising, so the check must be
    // written — and the VALID-string arm above cannot catch it, which is why
    // this is its own case rather than another expect() over there.
    const s2 = seedBus(true, { decoy: true });
    const env = isolatedEnv(s2.idx, { TAP_HOME: s2.bus, PWD: s2.root, TAP_SPOOL_NOW: "1788615000" });
    const opts = { cwd: s2.root, env, encoding: "utf8" as const };
    const ref = spawnSync("bash", [REF, "poll", "me"], opts);
    const mine = spawnSync("bun", [MINE, "poll", "me"], opts);
    assertRealExit(ref.status ?? -1, "reference poll");
    assertRealExit(mine.status ?? -1, "candidate poll");

    expect(mine.stdout).not.toContain("[object Object]");
    expect(mine.stdout).toContain("  ask  1085400s");
    // And it agrees with the incumbent's own fallback rather than merely
    // avoiding the bad string: "not [object Object]" would be satisfied by any
    // other wrong answer.
    expect(mine.stdout).toBe(ref.stdout);
    expect(mine.status).toBe(ref.status);

    removeScratchTree(s2.root);
  }, 30_000);
});
