import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parseStuckSentinel, stuckSentinelFieldsFromRegion, type StuckSentinelVerdict } from "../src/stuck-sentinel";
import { pendingSentinel } from "../src/deliver";
import { classifyPane } from "../src/pane-state";
import { stagedSentinel } from "../src/courier";

const root = new URL("../../../", import.meta.url).pathname;
const ID = "maple-9-4-leader-20260904T081502Z-4b1a987aa918";
const ok = (id: string, to = "", wire: "v023" | "pre023" = "v023"): StuckSentinelVerdict => ({ ok: true, fields: { id, to, wire } });
const region = (text: string, cmd = "claude") => stuckSentinelFieldsFromRegion(text, cmd);
const refused = (verdict: StuckSentinelVerdict) => expect(verdict.ok).toBe(false);
const nl = (a: string, b: string) => `${a}\n${b}`;

// --- the retired wire-v023-parse smoke corpus, arm for arm, on the module ---
// The smoke keeps running through the Bash adapter; this is the same corpus on
// the exported function, so a grammar regression reds here without a shell.
test("three positional slots, tags, path and inline body parse; decoy keys in the body do not", () => {
  expect(region(`[[TAP v0.23 ask ${ID}]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID}]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} urgent]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} escalate]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} escalate urgent]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID} urgent agent-interrupt]]`)).toEqual(ok(ID));
  // A same-id retry (tap resend) is a closed-set tag too.
  expect(region(`[[TAP v0.23 note ${ID} retry]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} escalate retry]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} escalate urgent agent-interrupt path=/x/p.md]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID} digest path=/x/i.json]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID}: a short inline body]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID}: id=decoy to=peer]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v\n0.23 note ${ID}: id=decoy to=peer]]`)).toEqual(ok(ID));
});

test("the team prefix is a bus locator and survives to the caller, capitalized teams included", () => {
  expect(region("[[TAP v0.23 ask webapp/watcher-20260904T083300Z-9c0ffee12345 urgent]]"))
    .toEqual(ok("webapp/watcher-20260904T083300Z-9c0ffee12345"));
  expect(region("[[TAP v0.23 ask webapp/a1 urgent]]")).toEqual(ok("webapp/a1"));
  expect(region("[[TAP v0.23 ask teamA/x-live]]")).toEqual(ok("teamA/x-live"));
  expect(region(`[[TAP v0.23 ask Webapp/${ID}]]`)).toEqual(ok(`Webapp/${ID}`));
});

test("unknown tokens are reported, never skipped", () => {
  expect(region(`[[TAP v0.23 ask ${ID} bogus=1]]`)).toEqual({ ok: false, reason: "malformed token 'bogus=1'" });
  expect(region(`[[TAP v0.23 ask ${ID} id=decoy to=peer]]`)).toEqual({ ok: false, reason: "malformed token 'id=decoy'" });
});

test("the pre-0.23 wire gets its own verdict with the recipient read off it", () => {
  expect(region("[[TAP v=0.22 from=a to=b id=alice-20260901T210000Z-aaaaaaaaaaaa kind=discuss reply=expected]]"))
    .toEqual(ok("alice-20260901T210000Z-aaaaaaaaaaaa", "b", "pre023"));
});

test("visual wrapping rejoins at every slot", () => {
  expect(region(nl("[[TAP v0.23 ask maple-9-4-leader-2026090", "4T081502Z-4b1a987aa918]]"))).toEqual(ok(ID));
  expect(region(nl("[[TAP v0.", `23 ask ${ID}]]`))).toEqual(ok(ID));
  expect(region(nl("[[TAP v0.23 no", `te ${ID}]]`))).toEqual(ok(ID));
  expect(region(nl(`[[TAP v0.23 ask ${ID} urg`, "ent]]"))).toEqual(ok(ID));
  expect(region(nl(`[[TAP v0.23 note ${ID} dig`, "est path=/x/i.json]]"))).toEqual(ok(ID));
  expect(region(nl(`[[TAP v0.23 note ${ID} digest pat`, "h=/x/i.json]]"))).toEqual(ok(ID));
});

test("a non-minted id parses; a WRAPPED short id refuses rather than truncating", () => {
  expect(region("[[TAP v0.23 note seat-20260831T095500Z-ae9aaa]]")).toEqual(ok("seat-20260831T095500Z-ae9aaa"));
  expect(region("[[TAP v0.23 ask a1]]")).toEqual(ok("a1"));
  expect(region("[[TAP v0.23 note courier-smoke digest path=/x/i.json]]")).toEqual(ok("courier-smoke"));
  // The strict tail is what refuses these: the second fragment matches no tag.
  expect(region(nl("[[TAP v0.23 note seat-20260831T0955", "00Z-ae9aaa]]"))).toEqual({ ok: false, reason: "malformed token '00Z-ae9aaa'" });
  expect(region(nl("[[TAP v0.23 note a", "1 urgent]]"))).toEqual({ ok: false, reason: "malformed token '1'" });
});

test("the anchor bounds the whole region", () => {
  refused(region(`notes before [[TAP v0.23 ask ${ID}]] notes after`));
  refused(region("just some human text"));
  expect(region("just some human text")).toEqual({ ok: false, reason: "" });
});

test("explicit previews, wrapped markers and per-item previews cannot impersonate header fields", () => {
  expect(region(`[[TAP v0.23 ask ${ID} preview="Status: id=decoy to=other"]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 ask ${ID} pre\nview="Status: report"]]`)).toEqual(ok(ID));
  expect(region(`[[TAP v0.23 note ${ID} digest preview(first)="First item" preview(second)="Second item"]]`)).toEqual(ok(ID));
});

test("slot refusals carry the previous parser's reasons, repr-quoted", () => {
  expect(region("[[TAP ask x]]")).toEqual({ ok: false, reason: "slot 1 is not a version token" });
  expect(region("[[TAP v0.23 tell x]]")).toEqual({ ok: false, reason: "slot 2 is not ask|note" });
  expect(region("[[TAP v0.23 ask not/an/id]]")).toEqual({ ok: false, reason: "slot 3 is not an id (saw 'not/an/id')" });
  expect(region("[[TAP v0.23 ask]]")).toEqual({ ok: false, reason: "slot 3 is not an id (saw '<missing>')" });
  expect(region("[[TAP v0.23 ask seat⠠digest]]")).toEqual({ ok: false, reason: "slot 3 is not an id (saw 'seat⠠digest')" });
  expect(region(`[[TAP v0.23 ask ${ID} it's]]`)).toEqual({ ok: false, reason: `malformed token "it's"` });
});

// --- the region pipeline the Bash function used to run before its parser -----
test("a captured region loses its prompt row, padding and escapes before parsing", () => {
  const wire = `[[TAP v0.23 ask ${ID}]]`;
  for (const [cmd, glyph] of [["claude", "❯"], ["codex", "›"], ["codex-cli", "»"], ["cursor", "→"], ["agy", ">"]] as const) {
    expect(region(`${glyph} ${wire}`, cmd)).toEqual(ok(ID));
    expect(region(`  ${glyph} ${wire}\n`, cmd)).toEqual(ok(ID));
    expect(region(`\x1b[1m${glyph}\x1b[0m \x1b[2m${wire}\x1b[0m`, cmd)).toEqual(ok(ID));
  }
  // A named Hermes profile prefixes the glyph; the queue prefix follows it.
  expect(region(`ops-hermes ❯ /queue ${wire}`, "hermes")).toEqual(ok(ID));
  expect(region(`❯ /queue ${wire}`, "hermes-ops")).toEqual(ok(ID));
  // Only Hermes owns `/queue `; under any other harness it is human text.
  refused(region(`❯ /queue ${wire}`, "claude"));
  // The glyph is stripped from the FIRST row only: a wrapped continuation row
  // that happens to start with one is wire text, not a second prompt.
  expect(region(nl(`❯ [[TAP v0.23 ask ${ID}`, "urgent]]"), "claude")).toEqual(ok(ID));
  expect(region(nl(`❯ [[TAP v0.23 ask ${ID} urgent agent-`, "interrupt]]"), "claude")).toEqual(ok(ID));
  // OpenCode's region is the composer's own rows: no glyph is removed, and a
  // leading one is the pane owner's text.
  expect(region(wire, "opencode")).toEqual(ok(ID));
  expect(region(`\x1b[2m${wire}\x1b[0m`, "opencode")).toEqual(ok(ID));
  refused(region(`❯ ${wire}`, "opencode"));
  // NFC is asserted with a character that actually MOVES under it. `.normalize`
  // on the minted id is a no-op — the id is ASCII — so an arm built that way
  // stays green with the normalize call deleted, which is what it was before
  // review (sol-ponytail-2 N2). U+212A KELVIN SIGN canonically becomes ASCII K,
  // so this arm fails if the normalize is removed.
  expect(region("[[TAP v0.23 ask \u212a1]]")).toEqual(ok("K1"));
});

// --- the two whitespace classes, which JavaScript's own are not -------------
// Found by review, not by the 1314-case survey: that corpus used ASCII
// whitespace and NBSP only, so it could not see the set difference. Each case
// below flips a verdict when the module uses `\s`/`trim()` instead.
test("the grammar uses Python's whitespace set, not JavaScript's", () => {
  // Python has these; JS does not — the incumbent PARSED all four.
  for (const ws of ["\u0085", "\u001c", "\u001d", "\u001e", "\u001f"]) {
    expect(region(`[[TAP v0.23${ws}ask a1]]`)).toEqual(ok("a1"));
    expect(region(`[[TAP v0.23 ask a1${ws}]]`)).toEqual(ok("a1"));
    expect(region(`[[TAP v=0.22 to=b${ws}id=a1]]`)).toEqual(ok("a1", "b", "pre023"));
  }
  // JS calls U+FEFF whitespace; Python does not — the incumbent REFUSED it, and
  // the anchor is what refuses, so the refusal is silent.
  // Leading and trailing: the ANCHOR refuses, so the refusal is silent, exactly
  // as the incumbent's was. Inside the header the BOM survives tokenisation and
  // breaks slot 1 instead — a different verdict with a diagnostic, and the
  // incumbent's own wording.
  expect(region("\ufeff[[TAP v0.23 ask a1]]")).toEqual({ ok: false, reason: "" });
  expect(region("[[TAP v0.23 ask a1]]\ufeff")).toEqual({ ok: false, reason: "" });
  expect(region("[[TAP \ufeffv0.23 ask a1]]")).toEqual({ ok: false, reason: "slot 1 is not a version token" });
  // U+200B is in neither set: it is not a separator on either side.
  expect(region("[[TAP v0.23\u200bask a1]]")).toEqual({ ok: false, reason: "slot 1 is not a version token" });
});

test("the region strip uses the locale's [[:space:]], which excludes NEL and the C0 separators", () => {
  const wire = "[[TAP v0.23 ask a1]]";
  // In the class: stripped around the glyph, so the wire still anchors.
  for (const ws of ["\u00a0", "\u2028", "\u3000", "\u1680", "\u2000", "\u202f", "\u205f", "\u000b", "\u000c"]) {
    expect(region(`${ws}❯${ws}${wire}`, "claude")).toEqual(ok("a1"));
  }
  // NOT in the class: U+0085 and U+001C-1F stay in the text. After the glyph
  // they land inside the grammar, where Python's class DOES separate — so the
  // sentinel still parses, and it is the leading position that shows the
  // difference, because there the leftover byte breaks the anchor.
  for (const ws of ["\u0085", "\u001f"]) {
    expect(region(`❯${ws}${wire}`, "claude")).toEqual(ok("a1"));
    expect(region(`${ws}❯ ${wire}`, "claude")).toEqual({ ok: false, reason: "" });
  }
});

test("a BOM-prefixed band stays unparseable", () => {
  expect(region(`\ufeff[[TAP v0.23 ask ${ID}]]`, "claude")).toEqual({ ok: false, reason: "" });
});

test("diagnostics serialize like Python repr, escapes included", () => {
  // Quote choice alone is not repr: it escapes backslashes, escapes the chosen
  // quote, and never emits a raw control byte into text a caller prints. `BS`
  // is one backslash CHARACTER, spelled this way so the expectations read as
  // the bytes Python produced rather than as a stack of source escapes.
  const BS = "\\";
  const reason = (verdict: StuckSentinelVerdict): string => verdict.ok ? "<parsed>" : verdict.reason;
  expect(reason(region(`[[TAP v0.23 ask a1 bogus${BS}tail]]`))).toBe(`malformed token 'bogus${BS}${BS}tail'`);
  expect(reason(region("[[TAP v0.23 ask a1 it's]]"))).toBe(`malformed token "it's"`);
  expect(reason(region(`[[TAP v0.23 ask a1 a'"b]]`))).toBe(`malformed token 'a${BS}'"b'`);
  expect(reason(region("[[TAP v0.23 ask a1 to\x7fken]]"))).toBe(`malformed token 'to${BS}x7fken'`);
  expect(reason(region("[[TAP v0.23 ask a1 zw​sp]]"))).toBe(`malformed token 'zw${BS}u200bsp'`);
  // An OSC-8 hyperlink token: CSI stripping does not touch OSC, so its ESC
  // bytes reach the diagnostic — as escapes, never raw.
  const osc = reason(region("[[TAP v0.23 ask a1 \x1b]8;;http://x\x1b" + BS + "tok]]"));
  expect(osc).not.toMatch(/\x1b/);
  expect(osc).toBe(`malformed token '${BS}x1b]8;;http://x${BS}x1b${BS}${BS}tok'`);
});

// --- the native API is an adapter over the same grammar ---------------------
test("pendingSentinel keeps its exact {id,to} shape and both wires", () => {
  expect(pendingSentinel(`[[TAP v0.23 ask ${ID}]]`, "claude")).toEqual({ id: ID, to: "" });
  expect(pendingSentinel("[[TAP v=0.22 from=a to=b id=alice-20260901T210000Z-aaaaaaaaaaaa kind=discuss reply=expected]]", "claude"))
    .toEqual({ id: "alice-20260901T210000Z-aaaaaaaaaaaa", to: "b" });
  expect(pendingSentinel(`/queue [[TAP v0.23 ask ${ID}]]`, "hermes")).toEqual({ id: ID, to: "" });
  expect(pendingSentinel(`[[TAP v0.23 ask ${ID} bogus=1]]`, "claude")).toBeNull();
  expect(pendingSentinel("human draft", "claude")).toBeNull();
  expect(Object.keys(pendingSentinel(`[[TAP v0.23 ask ${ID}]]`, "claude")!)).toEqual(["id", "to"]);
});

// The core now strips CSI sequences and NFC-normalizes before the anchors. On
// the native path that is a no-op ONLY if composer text never carries either,
// so prove it on every captured frame the classifier can read rather than
// assert it: a draft with a CSI sequence or a non-NFC id would be the input
// that flips a verdict on the dark delivery path. (OSC hyperlinks from a Claude
// status row DO reach the draft text — claude-statusline-2shells — and neither
// the previous parser nor this one strips OSC, so that verdict is unchanged.)
test("classifier composer text is already CSI-free and NFC, so the native verdict is unchanged", () => {
  const dir = `${root}skills/tap/scripts/smoke/fixtures/submit-verify/`;
  let drafts = 0;
  for (const name of readdirSync(dir).filter(f => f.endsWith(".ansi"))) {
    const capture = readFileSync(dir + name, "utf8");
    for (const harness of ["claude", "codex", "opencode", "agy"]) {
      const classified = classifyPane(capture, harness, false);
      if (classified.kind !== "draft" && classified.kind !== "queued") continue;
      drafts++;
      expect(classified.text).not.toMatch(/\x1b\[/);
      expect(classified.text.normalize("NFC")).toBe(classified.text);
      const verdict = parseStuckSentinel(classified.text, harness);
      expect(verdict).toEqual(parseStuckSentinel(classified.text.trim(), harness));
    }
  }
  expect(drafts).toBeGreaterThan(5);
});

// tap-rdy9n: urgent never clears a staged sentinel, including hermes's queued one.
test("stagedSentinel sees a sentinel behind the harness queue prefix", () => {
  expect(stagedSentinel("[[TAP v0.23 ask A/old]]", "claude")).toBe(true);
  expect(stagedSentinel("  [[TAP v0.23 ask truncated", "codex")).toBe(true);
  expect(stagedSentinel("/queue [[TAP v0.23 ask A/old]]", "hermes")).toBe(true);
  expect(stagedSentinel("/queue [[TAP v0.23 ask A/old]]", "claude")).toBe(false);
  expect(stagedSentinel("/queue human draft", "hermes")).toBe(false);
  expect(stagedSentinel("human draft", "claude")).toBe(false);
  // tap-1ncs6: a scrolled tail has no opener; the shared shape rule still sees the wire.
  expect(stagedSentinel("010101Z-0123456789ab preview=\"the scrolled tail\"]]", "claude")).toBe(true);
});
