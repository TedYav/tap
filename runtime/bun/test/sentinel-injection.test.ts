import { expect, test } from "bun:test";
import { assertSentinelWire, injectSentinel, InvalidSentinelWire } from "../src/sentinel";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";

for (const wire of [
  "plain text", "[[TAP v0.22 ask x]]", "[[TAP v0.23 ask x]] trailing",
  "[[TAP v0.23 ask x]] [[TAP v0.23 note y]]", "[[TAP v0.23 ask x unknown]]",
  "[[TAP v0.23 ask x\rsubmit]]", "[[TAP v0.23 ask x\nsubmit]]",
  '[[TAP v0.23 ask x preview="bad\\nline"]]',
  '[[TAP v0.23 ask x preview="bad\\u009bcontrol"]]',
  '[[TAP v0.23 ask x preview="bad" arbitrary text]]',
  "[[TAP v0.23 ask x path=/ok\x1bescape]]",
]) test(`invalid delivery wire types nothing: ${JSON.stringify(wire)}`, () => {
  let calls = 0;
  const type = () => { calls++; return true; };
  expect(() => injectSentinel(type, "%1", wire)).toThrow(InvalidSentinelWire);
  expect(calls).toBe(0);
});

test("malformed payload refuses before any courier effect", () => {
  const fx = new Proxy({} as PaneEffects, { get: () => () => { throw new Error("unexpected pane effect"); } });
  expect(submitVerifyLocked("%1", "x", "[[TAP v0.23 ask x]] extra", undefined, fx)).toMatchObject({
    status: "invalid_wire", errorClass: "invalid_sentinel_wire",
  });
});

for (const wire of [
  "[[TAP v0.23 ask x urgent critical escalate agent-interrupt retry]]",
  '[[TAP v0.23 note Team/x preview="a \\"quote\\" and : text" path=/bus/x.md]]',
  '[[TAP v0.23 note digest digest preview(x)="one" preview(y)="two"]]',
  "[[TAP v0.23 note x: a literal [[ fragment]]",
  "[[TAP v0.23 nudge]]", '[[TAP v0.23 nudge message="resume work"]]',
]) test(`valid delivery wire reaches the effect unchanged: ${wire}`, () => {
  assertSentinelWire(wire);
  let typed = "";
  expect(injectSentinel((_target, text) => { typed = text; return true; }, "%1", wire)).toBe(true);
  expect(typed).toBe(wire);
});

test("the Hermes queue adapter contains exactly one validated wire", () => {
  let typed = "";
  const wire = "/queue [[TAP v0.23 ask x]]";
  injectSentinel((_target, text) => { typed = text; }, "%1", wire);
  expect(typed).toBe(wire);
});

for (const path of ["/srv/My Projects/bus/x.md", "/srv/repo[1]/bus/x.md"])
for (const route of ["relay", "unreachable"])
test(`constructor pointer agrees with gate: ${route} ${path}`, async () => {
  const { renderSentinel } = await import("../src/sentinel");
  const wire = renderSentinel({ id: "x", from: "one/sender", to: route === "relay" ? "peer" : "two/peer",
    kind: "discuss", reply: "expected", senderIndex: "unreachable", path });
  expect(() => assertSentinelWire(wire)).not.toThrow();
  expect(wire).toContain(`path=${path}`);
});

for (const body of ["line\u2028separator", "next\u0085line", "line\u2029separator"])
test(`inline control takes payload read path: ${JSON.stringify(body)}`, async () => {
  const { renderSentinel, sentinelBodyInlineable } = await import("../src/sentinel");
  expect(sentinelBodyInlineable(body)).toBe(false);
  const wire = renderSentinel({ id: "x", from: "sender", to: "peer", kind: "discuss", reply: "settle-only", path: "/missing", body });
  expect(wire).toBe("[[TAP v0.23 note x]]");
  expect(() => assertSentinelWire(wire)).not.toThrow();
});

test("constructor refuses an unsafe pointer before returning wire bytes", async () => {
  const { renderSentinel } = await import("../src/sentinel");
  for (const path of ["/srv/line\nbreak/x.md", "/srv/close]]tail/x.md"])
    expect(() => renderSentinel({ id: "x", from: "one/sender", to: "peer", kind: "discuss", reply: "expected", path })).toThrow(InvalidSentinelWire);
});
